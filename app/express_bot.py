"""Бот eXpress: подключение, ключ и клиент BotX API (2026-10-23, Docs/express-bot.md).

Что здесь. Настройка подключения (адрес сервера eXpress — CTS, UUID бота, имя, включение), ключ бота, клиент исходящих вызовов
BotX API и проверка подписи входящих запросов от CTS. Расписание — `app/express_scheduler.py`, диалог с контактом —
`app/express_dialog.py`, HTTP-маршруты — `app/express_api.py`.

Ключ бота НЕ в БД. Он лежит в файле рядом с базой (`<база>.express-secrets.json`, права 0600), по образцу ключа роутера ИИ
(`app/rmr_router.py`): файл не попадает в резервные копии и в копию базы на тестовый стенд. Следствие, важное для эксплуатации:
база, перенесённая с боевого сервера на тестовый вместе с включённым `enabled`, писать от имени бота НЕ сможет — ключа у неё нет.

Протокол (сверено с исходниками pybotx, ExpressApp/pybotx, 2026-10-23):
- авторизация вызовов BotX API — две схемы, клиент подбирает сам (`_authorized_call`): v2 (как в pybotx по умолчанию) — бот строит JWT на каждый вызов:
  HS256 ключом бота, iss = bot_id, aud = имя хоста CTS без схемы и порта, срок 60 с; v1 (устаревшая) — токен `GET /api/v2/botx/bots/{bot_id}/token?signature=…`,
  подпись — HMAC-SHA256 от `bot_id` ключом бота, hex в верхнем регистре. На первом подключении CTS выдавал токен v1, но отвергал его (401 на любой вызов) —
  новый CTS принимает v2;
- сообщение: `POST /api/v4/botx/notifications/direct` {group_chat_id, notification: {status, body, bubble}} → {result: {sync_id}};
- поиск пользователя: `POST /api/v3/botx/users/by_email` {emails: […]};
- входящее: CTS сам шлёт `POST /command`, `GET /status`, `POST /notification/callback` на адрес бота; заголовок
  `Authorization: Bearer <JWT>` подписан тем же ключом (HS256).
Проверить на живом CTS: формат ответов поиска пользователя и ошибка «чат не найден» для контакта, который боту ещё не писал.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from app import db as _db
from app.db import get_connection

TIMEOUT = 15
LOG_TEXT_LIMIT = 600
LOG_KEEP_DAYS = 90
COMMAND = "/hc"            # команда, которую шлют кнопки диалога численности
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_SECRET_PATTERN = re.compile(r"[\x21-\x7e]{8,300}")

REASONS = {
    "chat_not_found": "чат не найден: контакт ещё не писал боту (пусть откроет бота в eXpress и отправит /start)",
    "bot_is_not_a_chat_member": "бот не состоит в этом чате",
    "event_recipients_list_is_empty": "список получателей пуст",
    "user_not_found": "пользователь не найден в eXpress",
}


class BotxError(Exception):
    """Ошибка обращения к eXpress. `retryable` — имеет ли смысл повторить позже (сеть, 5xx), а не править данные."""

    def __init__(self, message: str, *, status: Optional[int] = None, reason: Optional[str] = None, retryable: bool = True):
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.retryable = retryable


# ------------------------------------------------------------------ ключ бота (файл рядом с базой)

_secret_lock = threading.Lock()


def secret_path():
    return _db.DB_PATH.with_name(_db.DB_PATH.name + ".express-secrets.json")


def _read_secrets() -> dict:
    try:
        data = json.loads(secret_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_secrets(data: dict) -> None:
    path = secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # права заданы при создании: окна «читаем всеми» нет
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp, path)


def secret_key() -> str:
    return str(_read_secrets().get("secret_key") or "").strip()


def secret_configured() -> bool:
    return bool(secret_key())


def set_secret(key: str) -> None:
    key = (key or "").strip()
    if not _SECRET_PATTERN.fullmatch(key):
        raise ValueError("Ключ бота: от 8 до 300 печатных символов без пробелов и переводов строки")
    with _secret_lock:
        data = _read_secrets()
        data["secret_key"] = key
        _write_secrets(data)
    _drop_token()


def clear_secret() -> None:
    with _secret_lock:
        data = _read_secrets()
        data.pop("secret_key", None)
        _write_secrets(data)
    _drop_token()


def redact(text) -> str:
    """Убрать ключ и токен из любого текста, который может уйти пользователю или в журнал."""
    text = str(text)
    for secret in (secret_key(), _token_cache.get("value") or ""):
        if secret:
            text = text.replace(secret, "***")
    return text


# ------------------------------------------------------------------ настройка подключения

def validate_cts_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Адрес сервера eXpress: ожидается http://… или https://… с именем сервера")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Адрес сервера eXpress: только схема, сервер и порт, без логина, пути и параметров")
    return f"{parsed.scheme}://{parsed.netloc}"


def get_config(conn=None) -> dict:
    close = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT * FROM express_config WHERE id = 1").fetchone()
    finally:
        if close:
            conn.close()
    if row is None:
        return {"enabled": False, "cts_url": "", "bot_id": "", "bot_name": "", "verify_tls": True, "updated_at": None}
    return {"enabled": bool(row["enabled"]), "cts_url": row["cts_url"], "bot_id": row["bot_id"], "bot_name": row["bot_name"],
            "verify_tls": bool(row["verify_tls"]), "updated_at": row["updated_at"]}


def save_config(conn, data: dict, user_id: Optional[int]) -> dict:
    """Сохранить подключение. Включить бота можно только при заполненных адресе и UUID и заданном ключе."""
    cts_url = validate_cts_url(data.get("cts_url", ""))
    bot_id = (data.get("bot_id") or "").strip()
    if bot_id and not _UUID.fullmatch(bot_id):
        raise ValueError("Идентификатор бота: ожидается UUID вида 6a05574d-f544-54ee-a8c8-5c7240f143ae")
    bot_name = " ".join((data.get("bot_name") or "").split())[:80]
    enabled = bool(data.get("enabled"))
    if enabled:
        missing = missing_parts({"cts_url": cts_url, "bot_id": bot_id})
        if missing:
            raise ValueError("Включить бота нельзя: не заданы " + ", ".join(missing))
    conn.execute(
        "UPDATE express_config SET enabled = ?, cts_url = ?, bot_id = ?, bot_name = ?, verify_tls = ?, "
        "updated_at = datetime('now'), updated_by = ? WHERE id = 1",
        (1 if enabled else 0, cts_url, bot_id, bot_name, 1 if data.get("verify_tls", True) else 0, user_id))
    _drop_token()
    return get_config(conn)


def missing_parts(cfg: dict) -> list:
    """Чего не хватает для работы подключения: адрес сервера, идентификатор бота, ключ (по именам, как в форме)."""
    parts = []
    if not cfg.get("cts_url"):
        parts.append("адрес сервера eXpress")
    if not cfg.get("bot_id"):
        parts.append("идентификатор бота (UUID)")
    if not secret_configured():
        parts.append("ключ бота")
    return parts


def not_configured_message(cfg: dict) -> str:
    return "Подключение к eXpress не настроено: не заданы " + ", ".join(missing_parts(cfg))


def config_public(conn=None) -> dict:
    cfg = get_config(conn)
    cfg["secret_configured"] = secret_configured()
    cfg["ready"] = bool(cfg["cts_url"] and cfg["bot_id"] and cfg["secret_configured"])
    return cfg


def is_active(conn=None) -> bool:
    cfg = get_config(conn)
    return bool(cfg["enabled"] and cfg["cts_url"] and cfg["bot_id"] and secret_configured())


# ------------------------------------------------------------------ исходящие вызовы

_token_cache = {"key": None, "value": None}
_token_lock = threading.Lock()
# Схема авторизации BotX API, которую принял CTS: "v2" — JWT, который бот строит сам на каждый вызов; "v1" — токен из /api/v2/botx/bots/{id}/token
# (устаревшая схема). Пока неизвестна — пробуем v2, затем v1, и запоминаем сработавшую. Сброс — при смене подключения или ключа.
_auth_mode = {"v": None}
JWT_LIFETIME = 60


def _drop_token() -> None:
    with _token_lock:
        _token_cache["key"] = None
        _token_cache["value"] = None
        _auth_mode["v"] = None


def signature(bot_id: str, key: str) -> str:
    return hmac.new(key.encode("utf-8"), bot_id.encode("utf-8"), hashlib.sha256).hexdigest().upper()


def _http(method: str, url: str, body, headers: dict, verify_tls: bool):
    """Один HTTP-вызов без прокси (CTS — внутренний сервер): (код, разобранный JSON или None). Сетевой сбой → BotxError."""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    handlers = [urllib.request.ProxyHandler({})]
    if url.startswith("https") and not verify_tls:
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except (urllib.error.URLError, OSError, ssl.SSLError) as exc:
        reason = getattr(exc, "reason", exc)
        raise BotxError(f"Нет связи с сервером eXpress: {redact(reason)}", retryable=True)
    try:
        return status, json.loads(raw.decode("utf-8")) if raw else None
    except ValueError:
        return status, None


def _fail(status: int, payload, what: str) -> BotxError:
    reason = payload.get("reason") if isinstance(payload, dict) else None
    human = REASONS.get(reason) or (str(reason) if reason else f"код {status}")
    if status >= 500:
        human = f"сервер eXpress недоступен или сломался (код {status})"
    # Код ответа и подробности CTS (errors / error_data) — в самом тексте: по одному слову «unauthorized» причину не определить
    extra = ""
    if isinstance(payload, dict):
        details = {k: payload[k] for k in ("errors", "error_data") if payload.get(k)}
        if details:
            extra = "; " + json.dumps(details, ensure_ascii=False)[:200]
    return BotxError(f"{what}: {redact(human)} (HTTP {status}{redact(extra)})", status=status, reason=reason, retryable=status >= 500 or status in (408, 429))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def build_jwt_v2(cfg: dict, key: str, now: Optional[float] = None) -> str:
    """Схема v2 (как в pybotx, `build_botx_jwt_v2`): HS256 ключом бота, iss — идентификатор бота, aud — ИМЯ ХОСТА CTS (без схемы и порта),
    живёт 60 секунд, строится заново на каждый вызов, в CTS за токеном ходить не нужно."""
    iat = int(now if now is not None else time.time())
    host = urllib.parse.urlsplit(cfg["cts_url"]).hostname or ""
    claims = {"iss": str(cfg["bot_id"]), "aud": host, "exp": iat + JWT_LIFETIME, "nbf": iat, "jti": os.urandom(12).hex(), "iat": iat, "version": 2}
    head = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64url_encode(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(key.encode("utf-8"), f"{head}.{body}".encode("ascii"), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64url_encode(sig)}"


def _token(cfg: dict, key: str, force: bool = False) -> str:
    """Схема v1: токен бота из CTS (кэшируется)."""
    cache_key = (cfg["cts_url"], cfg["bot_id"], hashlib.sha256(key.encode()).hexdigest())
    with _token_lock:
        if not force and _token_cache["key"] == cache_key and _token_cache["value"]:
            return _token_cache["value"]
    url = f"{cfg['cts_url']}/api/v2/botx/bots/{cfg['bot_id']}/token?signature={signature(cfg['bot_id'], key)}"
    status, payload = _http("GET", url, None, {"Accept": "application/json"}, cfg["verify_tls"])
    value = payload.get("result") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(value, str) or not value:
        raise _fail(status, payload, "Сервер eXpress не выдал токен бота (проверьте идентификатор и ключ)")
    with _token_lock:
        _token_cache["key"], _token_cache["value"] = cache_key, value
    return value


def _authorized_call(cfg: dict, key: str, method: str, path: str, body):
    """Один вызов BotX API с подбором схемы авторизации. Возвращает (код, ответ, схема). 401 по обеим схемам — код 401 последней попытки."""
    order = ["v2", "v1"]
    if _auth_mode["v"] == "v1":
        order = ["v1", "v2"]
    status, payload, used, token_error = 0, None, None, None
    for mode in order:
        for attempt in (0, 1):
            try:
                token = build_jwt_v2(cfg, key) if mode == "v2" else _token(cfg, key, force=attempt == 1)
            except BotxError as exc:
                token_error = exc                  # токен v1 не выдали — пробуем остальные схемы; если не удалось ни одной, причина — в выдаче токена
                break
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"}
            status, payload = _http(method, cfg["cts_url"] + path, body, headers, cfg["verify_tls"])
            used = mode
            if status != 401:
                _auth_mode["v"] = mode
                return status, payload, mode
            if mode == "v2":
                break                              # JWT строится заново каждый раз, повторять нет смысла
    if used is None and token_error is not None:
        raise token_error
    return status, payload, used


def _api(method: str, path: str, body=None, *, require_enabled: bool = True):
    cfg = get_config()
    key = secret_key()
    if not (cfg["cts_url"] and cfg["bot_id"] and key):
        raise BotxError(not_configured_message(cfg), retryable=False)
    if require_enabled and not cfg["enabled"]:
        raise BotxError("Бот eXpress выключен", retryable=False)
    status, payload, _ = _authorized_call(cfg, key, method, path, body)
    return status, payload


def ping() -> dict:
    """Проверка связи: настоящий (но безвредный) вызов BotX API под авторизацией бота — список чатов. Одной выдачи токена мало: CTS может выдать токен,
    а потом отклонить его (так и случилось на первом подключении). Ничего никому не отправляется."""
    cfg = get_config()
    key = secret_key()
    if not (cfg["cts_url"] and cfg["bot_id"] and key):
        raise BotxError(not_configured_message(cfg), retryable=False)
    status, payload, mode = _authorized_call(cfg, key, "GET", "/api/v3/botx/chats/list", None)
    if status == 401:
        raise _fail(401, payload, "Сервер eXpress отклонил бота по обеим схемам авторизации (v2 JWT и токен v1): проверьте, что бот включён и ключ верный")
    if status >= 500:
        raise _fail(status, payload, "Сервер eXpress не смог обработать проверочный вызов")
    return {"ok": True, "cts_url": cfg["cts_url"], "bot_id": cfg["bot_id"], "auth": mode, "http": status}


def send_message(chat_id: str, text: str, bubble: Optional[list] = None) -> Optional[str]:
    """Отправить сообщение в чат контакта; `bubble` — строки кнопок под сообщением. Возвращает sync_id."""
    notification = {"status": "ok", "body": text}
    if bubble:
        notification["bubble"] = bubble
    status, payload = _api("POST", "/api/v4/botx/notifications/direct", {"group_chat_id": chat_id, "notification": notification})
    if status not in (200, 202) or (isinstance(payload, dict) and payload.get("status") == "error"):
        raise _fail(status, payload, "Сообщение не отправлено")
    result = payload.get("result") if isinstance(payload, dict) else None
    return result.get("sync_id") if isinstance(result, dict) else None


def find_user_by_email(email: str) -> Optional[dict]:
    """Пользователь eXpress по e-mail: {user_huid, ad_login, ad_domain, name} или None. Нужен, чтобы опознать контакт до его первого сообщения."""
    status, payload = _api("POST", "/api/v3/botx/users/by_email", {"emails": [email]})
    if status == 404:
        return None
    if status != 200 or not isinstance(payload, dict):
        raise _fail(status, payload, "Поиск пользователя в eXpress не удался")
    result = payload.get("result")
    if isinstance(result, dict):
        result = [result]
    if not result:
        return None
    user = result[0]
    return {"user_huid": user.get("user_huid") or user.get("huid"), "ad_login": user.get("ad_login"),
            "ad_domain": user.get("ad_domain"), "name": user.get("name")}


# ------------------------------------------------------------------ кнопки

def button(label: str, data: dict) -> dict:
    """Кнопка под сообщением: нажатие приходит боту командой COMMAND с `data`, в чате ничего не печатает (silent)."""
    return {"command": COMMAND, "label": label[:60], "data": data, "opts": {"silent": True}}


# ------------------------------------------------------------------ входящие: проверка подписи

def _b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_incoming(authorization: Optional[str]) -> dict:
    """Проверить JWT входящего запроса от CTS: HS256 ключом бота, срок и принадлежность боту. Возвращает claims или бросает BotxError."""
    key, bot_id = secret_key(), get_config()["bot_id"]
    if not key or not bot_id:
        raise BotxError("Бот eXpress не настроен", retryable=False)
    parts = (authorization or "").split()[-1:]
    token = parts[0] if parts else ""
    pieces = token.split(".")
    if len(pieces) != 3:
        raise BotxError("Нет токена авторизации", status=401, retryable=False)
    try:
        header = json.loads(_b64url(pieces[0]))
        claims = json.loads(_b64url(pieces[1]))
        given = _b64url(pieces[2])
    except (ValueError, TypeError):
        raise BotxError("Токен не разобран", status=401, retryable=False)
    expected = hmac.new(key.encode("utf-8"), f"{pieces[0]}.{pieces[1]}".encode("ascii"), hashlib.sha256).digest()
    if header.get("alg") != "HS256" or not hmac.compare_digest(expected, given):
        raise BotxError("Подпись токена неверна", status=401, retryable=False)
    exp = claims.get("exp")
    if isinstance(exp, (int, float)) and exp < time.time():
        raise BotxError("Срок токена истёк", status=401, retryable=False)
    audience = claims.get("aud")
    audience = audience if isinstance(audience, list) else [audience]
    mine = bot_id.strip().lower()            # UUID сравниваем без учёта регистра: CTS может писать его заглавными
    if str(claims.get("iss")).strip().lower() != mine and mine not in [str(a).strip().lower() for a in audience]:
        raise BotxError("Токен выписан не для этого бота", status=401, retryable=False)
    return claims


def describe_token(authorization: Optional[str]) -> str:
    """Что написано в токене входящего запроса (alg, iss, aud) — для журнала обмена, чтобы по записи «отклонён» было видно, ПОЧЕМУ. Подпись и содержимое
    не проверяются; ключей и самого токена в результате нет."""
    parts = (authorization or "").split()[-1:]
    pieces = (parts[0] if parts else "").split(".")
    if len(pieces) != 3:
        return "токена нет" if not parts else "токен не разобран"
    try:
        header, claims = json.loads(_b64url(pieces[0])), json.loads(_b64url(pieces[1]))
    except (ValueError, TypeError):
        return "токен не разобран"
    return f"alg={header.get('alg')} iss={str(claims.get('iss'))[:60]} aud={str(claims.get('aud'))[:90]}"


# ------------------------------------------------------------------ журнал обмена

def log_event(direction: str, kind: str, text: str = "", *, contact_id: Optional[int] = None, request_id: Optional[int] = None,
              ok: bool = True, error: Optional[str] = None) -> None:
    """Запись в журнал обмена. Никогда не бросает: сбой журнала не должен ломать отправку или приём."""
    try:
        conn = get_connection()
        try:
            conn.execute(
                "INSERT INTO express_log (direction, contact_id, request_id, kind, text, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (direction, contact_id, request_id, kind, redact(text)[:LOG_TEXT_LIMIT], 1 if ok else 0, redact(error)[:LOG_TEXT_LIMIT] if error else None))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def prune_log(days: int = LOG_KEEP_DAYS) -> None:
    conn = get_connection()
    try:
        conn.execute("DELETE FROM express_log WHERE at < datetime('now', ?)", (f"-{int(days)} days",))
        conn.commit()
    finally:
        conn.close()
