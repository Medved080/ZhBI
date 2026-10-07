"""Облачный роутер red_mad_robot как второй источник модели для ИИ-помощника.

Механизм перенесён из проекта «Радар тендеров» (radar/llm_client.py, llm_store.py): поставщик
`red_mad_router`, адрес по умолчанию, привязка к хосту роутера, ключ из формы, список моделей С
ключом, подбор параметров запроса по ответам сервера, понятная диагностика. Потоковое чтение
ответа (тайм-аут простоя, отмена, обрыв по лимиту, зацикливание, расход токенов) общее с
локальным клиентом — `qwen_client._read_stream`; здесь только то, чего у локального клиента нет и
быть не должно.

Что это НЕ меняет:
* Чтение чертежей Калькулятора остаётся на локальной модели. Подключение роутера — отдельное,
  общую запись `service_local_ai` и разрешённые адреса локального клиента оно не трогает.
* Локальный клиент по-прежнему отвергает любой адрес вне внутренней сети. Роутер — единственное
  исключение, и адрес жёстко привязан к его хосту: чужой адрес в этом поле иначе молча уводил бы
  вопросы и выдержки данных не туда.
* Ключ роутера никогда не уходит на локальный сервер и наоборот: у локального клиента свой ключ
  (`CALCZHB_QWEN_API_KEY`), у роутера свой.

Данные покидают контур сервера ЖБИ. Поэтому роутер выключен по умолчанию, включается только
администратором и только после явного подтверждения (`dataConsent`); решение — за службой ИБ.

Хранение: настройки — `app_settings`, ключ `service_ai_router` (схема БД не меняется, а откат на
прежнюю версию просто не видит эту запись — помощник вернётся к локальной модели). Секрет — отдельный
файл рядом с базой (`<база>.ai-secrets.json`, права 0600): не в БД, поэтому не попадает в резервные
копии, перенос базы и обезличенную копию, которую читает ассистент разработчика.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import logging
import os
import re
import socket
import ssl
import threading
import time
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, getproxies, proxy_bypass

from pydantic import Field, ValidationError

import app.db as _db
from app.calc import qwen_client
from app.calc.database import dumps
from app.calc.recovery_schema import StrictModel

log = logging.getLogger(__name__)

PROVIDER = "red_mad_router"
HOST = "rmrrouter.redmadrobot.com"
DEFAULT_URL = "https://rmrrouter.redmadrobot.com/v1"
BILLING_URL = "https://rmrrouter.redmadrobot.com/billing"
SETTINGS_KEY = "service_ai_router"
ENV_KEY = "ZHBI_RMR_API_KEY"        # ключ из окружения сервера (на случай, когда форма недоступна)
ENV_PROXY = "ZHBI_RMR_PROXY"        # явный корпоративный прокси; пустое значение — идти напрямую
# Параметры, без которых запрос обязан работать: сервер, не знающий их, отвечает 400 — и параметр снимается.
OPTIONAL_KEYS = ("stream_options", "reasoning_effort", "chat_template_kwargs", "think", "temperature")
TRANSIENT = (429, 502, 503, 504)    # временные отказы роутера и вышестоящего поставщика
MAX_ATTEMPTS = 6                    # подборов параметров на один вопрос
MAX_TRANSIENT_RETRIES = 2
DATA_NOTICE = ("Роутер облачный: вопрос пользователя, выдержки из данных сервиса (названия проектов, объектов, "
               "контрагентов, договоров, количества, даты) и видимый текст открытой страницы уходят на внешний "
               "сервер rmrrouter.redmadrobot.com. Включайте, только если это согласовано со службой ИБ.")


class ContextOverflow(qwen_client.InferenceError):
    """Запрос не помещается в контекст модели; предел сервера, если он назван в ответе."""

    def __init__(self, message, n_ctx=None, n_prompt=None):
        super().__init__(message)
        self.n_ctx, self.n_prompt = n_ctx, n_prompt


# ---------------------------------------------------------------- настройки

class RouterConfig(StrictModel):
    enabled: bool = False                       # помощник отвечает через роутер, а не через локальную модель
    dataConsent: bool = False                   # администратор подтвердил выход данных во внешнюю сеть
    baseUrl: str = Field(default=DEFAULT_URL, max_length=500)
    model: str = Field(default="", max_length=200)
    timeoutSeconds: int = Field(default=120, ge=10, le=600)
    jsonMode: Literal["json_schema", "json_object", "none"] = "json_schema"
    tokenParameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    thinking: Literal["auto", "off"] = "auto"   # off — просить модель не рассуждать (поддерживают не все)


class RouterSave(RouterConfig):
    expectedRevision: str = Field(pattern=r"^[0-9a-f]{64}$")


class RouterConnection(StrictModel):
    """То, что нужно `chat`: адрес, модель и пределы одного обращения (тот же состав полей, что у ConnectionConfig)."""
    provider: Literal["red_mad_router"] = PROVIDER
    baseUrl: str = Field(max_length=500)
    model: str = Field(max_length=200)
    timeoutSeconds: int = Field(ge=10, le=600)
    maxTokens: int = Field(ge=64, le=32768)
    jsonMode: Literal["json_schema", "json_object", "none"] = "json_schema"
    tokenParameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    thinking: Literal["auto", "off"] = "auto"


def fingerprint(config: RouterConfig) -> str:
    return hashlib.sha256(config.model_dump_json().encode()).hexdigest()


def read_config(conn=None) -> RouterConfig:
    """Сохранённые настройки; отсутствующие или повреждённые — это выключенный роутер, а не отказ помощника."""
    own = conn is None
    if own:
        from app.db import get_connection
        conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key=? AND object_id IS NULL", (SETTINGS_KEY,)).fetchone()
        if not row:
            return RouterConfig()
        try:
            return RouterConfig.model_validate_json(row[0])
        except ValidationError:
            log.exception("ai-router: сохранённые настройки не читаются, роутер считается выключенным")
            return RouterConfig()
    finally:
        if own:
            conn.close()


def write_config(conn, config: RouterConfig) -> None:
    conn.execute("INSERT INTO app_settings(key,object_id,value) VALUES(?,NULL,?) "
                 "ON CONFLICT(key, COALESCE(object_id, -1)) DO UPDATE SET value=excluded.value",
                 (SETTINGS_KEY, config.model_dump_json()))
    _learned.clear()        # подобранные под прежнюю модель параметры к новой не относятся


def connection(config: RouterConfig, max_tokens: int = 4096) -> RouterConnection:
    return RouterConnection(baseUrl=config.baseUrl, model=config.model, timeoutSeconds=config.timeoutSeconds,
                            maxTokens=max_tokens, jsonMode=config.jsonMode, tokenParameter=config.tokenParameter,
                            thinking=config.thinking)


# ---------------------------------------------------------------- адрес

def validate_url(url: str) -> None:
    """Адрес роутера: только HTTPS и только его хост. Остальное — ValueError с объяснением по-русски."""
    url = (url or "").strip()
    if not url:
        raise ValueError("Не задан адрес роутера")
    parsed = urlsplit(url)
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Некорректный порт в адресе роутера") from None
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or any(ord(c) < 33 for c in url)):
        raise ValueError("Адрес роутера: нужен HTTPS-адрес без пароля, параметров и фрагмента")
    host = parsed.hostname.lower()
    if host != HOST and not host.endswith("." + HOST):
        # Чужой адрес в этом поле (например, прежний LM Studio) молча уводил бы запросы не туда.
        raise ValueError(f"Для роутера red_mad_robot оставьте адрес по умолчанию ({DEFAULT_URL}) — "
                         f"сейчас в поле адрес другого сервера: {host}")
    if port not in (None, 443) or ".." in parsed.path.split("/"):
        raise ValueError("Недопустимый порт или путь в адресе роутера")


def api_base(url: str) -> str:
    """Корень API из того, что ввёл человек: допустима ссылка на любой маршрут (…/models, …/chat/completions)."""
    parsed = urlsplit(url.strip())
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = "/" + parsed.path.strip("/") if parsed.path.strip("/") else ""
    for suffix in ("/chat/completions", "/completions", "/models"):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
    if path in ("", "/api"):
        path = "/v1"
    elif path.endswith("/api/v1"):
        path = path[:-len("/api/v1")] + "/v1"
    return origin + path


# ---------------------------------------------------------------- ключ

_secret_lock = threading.Lock()
_KEY_PATTERN = re.compile(r"[\x21-\x7e]{8,300}")


def secret_path():
    # Имя от файла базы: боевая и обезличенная копия в одном каталоге не делят ключ.
    return _db.DB_PATH.with_name(_db.DB_PATH.name + ".ai-secrets.json")


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
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)      # права заданы при создании: окна «читаем всеми» нет
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp, path)


def api_key() -> str:
    """Ключ роутера: из формы (файл секретов), иначе из переменной окружения сервера."""
    return str(_read_secrets().get("router_key") or "").strip() or os.environ.get(ENV_KEY, "").strip()


def key_state() -> dict:
    """Только факт наличия и источник: сам ключ наружу не отдаётся никогда."""
    if str(_read_secrets().get("router_key") or "").strip():
        return {"configured": True, "source": "form"}
    if os.environ.get(ENV_KEY, "").strip():
        return {"configured": True, "source": "env"}
    return {"configured": False, "source": None}


def set_key(key: str) -> None:
    key = (key or "").strip()
    if not _KEY_PATTERN.fullmatch(key):
        raise ValueError("Ключ: от 8 до 300 печатных символов без пробелов и переводов строки")
    with _secret_lock:
        data = _read_secrets()
        data["router_key"] = key
        _write_secrets(data)


def clear_key() -> None:
    with _secret_lock:
        data = _read_secrets()
        data.pop("router_key", None)
        _write_secrets(data)


def redact(text) -> str:
    """Убрать ключ из любого текста, который может уйти пользователю или в журнал (сервер иногда повторяет ключ в ответе)."""
    text = str(text)
    key = api_key()
    return text.replace(key, "***") if key else text


def check_ready(config: RouterConfig, *, require_model: bool = True) -> None:
    """Можно ли обращаться к роутеру сейчас; ValueError с причиной по-русски."""
    validate_url(config.baseUrl)
    if not config.dataConsent:
        raise ValueError("Передача данных в облачный роутер не подтверждена администратором")
    if not api_key():
        raise ValueError("Ключ роутера не задан: внесите его в «Администрирование → Интеграция с ИИ»")
    if require_model and not config.model.strip():
        raise ValueError("Не выбрана модель роутера")


# ---------------------------------------------------------------- соединение

def _proxy_url(host: str):
    if ENV_PROXY in os.environ:
        return os.environ[ENV_PROXY].strip() or None
    proxies = getproxies()
    proxy = proxies.get("https") or proxies.get("all")
    if not proxy:
        return None
    try:
        if proxy_bypass(host):
            return None
    except Exception:       # noqa: BLE001 — системная настройка прокси нечитаема: идём как велит окружение
        pass
    return proxy


def open_connection(parsed, timeout: int):
    """HTTPS-соединение с роутером; при корпоративном прокси — через туннель CONNECT. Только стандартная библиотека."""
    port = parsed.port or 443
    context = ssl.create_default_context()      # SSL_CERT_FILE/SSL_CERT_DIR учитываются: так подключают корпоративный CA
    proxy = _proxy_url(parsed.hostname)
    if not proxy:
        return http.client.HTTPSConnection(parsed.hostname, port, timeout=timeout, context=context)
    via = urlsplit(proxy if "//" in proxy else "http://" + proxy)
    conn = http.client.HTTPSConnection(via.hostname, via.port or 3128, timeout=timeout, context=context)
    headers = {}
    if via.username:
        pair = f"{unquote(via.username)}:{unquote(via.password or '')}".encode()
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(pair).decode()
    conn.set_tunnel(parsed.hostname, port, headers)
    return conn


def _get_json(url: str, key: str, timeout: int = 15):
    """GET JSON с ключом: (данные, пометка). Пометка — чем кончилось: HTTP-код, TLS, обрыв, не JSON."""
    parsed = urlsplit(url)
    try:
        conn = open_connection(parsed, timeout)
        try:
            conn.request("GET", (parsed.path or "/"), headers={"Accept": "application/json", "Authorization": f"Bearer {key}"})
            response = conn.getresponse()
            body = response.read(4 * 1048576)
        finally:
            conn.close()
    except ssl.SSLError as error:
        return None, f"ошибка TLS: {redact(error)[:100]}"
    except (TimeoutError, socket.timeout):
        return None, f"тайм-аут {timeout} с"
    except (OSError, http.client.HTTPException) as error:
        return None, f"нет соединения: {redact(error)[:100]}"
    if response.status != 200:
        return None, f"HTTP {response.status}"
    try:
        return json.loads(body), "ok"
    except ValueError:
        return None, "ответ не JSON"


def _names(payload):
    rows = (payload.get("data") or payload.get("models")) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return None
    found = []
    for row in rows:
        name = row if isinstance(row, str) else (row.get("id") or row.get("key") or row.get("name") or row.get("model")
                                                  if isinstance(row, dict) else None)
        if name:
            found.append({"id": str(name), "vision": None})
    return found or None


def list_models(base_url: str) -> dict:
    """Модели роутера. Запрос идёт с ключом: без него роутер отвечает отказом, и это выглядело как «сервер не ответил»."""
    validate_url(base_url)
    key = api_key()
    if not key:
        raise qwen_client.InferenceError("Ключ роутера не задан: внесите его в «Администрирование → Интеграция с ИИ» и повторите")
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(base_url))
    notes = []
    for url in dict.fromkeys([api_base(base_url) + "/models", origin + "/v1/models", origin + "/api/v1/models"]):
        payload, note = _get_json(url, key)
        names = _names(payload)
        if names:
            return {"url": url, "models": names}
        notes.append(f"{url} — {note if payload is None else 'в ответе нет списка моделей'}")
    joined = " ".join(notes)
    hint = ""
    if "HTTP 401" in joined or "HTTP 403" in joined:
        hint = " Роутер не принял ключ: проверьте его на странице " + BILLING_URL + " и внесите заново."
    elif "нет соединения" in joined or "тайм-аут" in joined or "TLS" in joined:
        hint = " " + _network_hint()
    raise qwen_client.InferenceError("Список моделей не получен: " + "; ".join(notes) + "." + hint)


def _network_hint() -> str:
    return (f"Серверу ЖБИ нужен исходящий доступ к {HOST}:443 (заявка DevOps). Если выход в интернет идёт через "
            f"прокси, задайте HTTPS_PROXY или {ENV_PROXY} в окружении сервера; если прокси подменяет сертификат — "
            "SSL_CERT_FILE с корпоративным корневым сертификатом.")


# ---------------------------------------------------------------- разбор ответа

_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def parse_json(text: str) -> dict:
    """JSON-объект из ответа: без ограды ```json и рассуждения <think>, с запасом на мусор вокруг объекта."""
    text = _FENCE.sub("", _THINK.sub("", text or "").strip())
    for candidate in (text, text[text.find("{"):text.rfind("}") + 1] if "{" in text else ""):
        try:
            value = json.loads(candidate, parse_constant=lambda v: (_ for _ in ()).throw(ValueError("не число")))
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    raise qwen_client.InferenceError("Модель не вернула JSON-объект. Если так отвечает любая модель, переключите «Формат ответа» "
                                     "на «JSON-объект» или «Без формата» в параметрах роутера")


_N_CTX = re.compile(r"(?:n_ctx[\s\"'\\:]+|available context size\s*\(|context (?:size|length|window)\s*(?:is|[:=])\s*|"
                    r"maximum context length is\s*|supports at most\s*)(\d+)", re.I)
_N_PROMPT = re.compile(r"(?:n_prompt_tokens[\s\"'\\:]+|request\s*\(|you requested\s*|resulted in\s*|your messages resulted in\s*)(\d+)", re.I)


def overflow(detail: str):
    """ContextOverflow с пределом сервера, если ответ говорит о переполнении контекста; иначе None."""
    low = detail.lower()
    if "context" not in low or not any(w in low for w in ("exceed", "overflow", "greater than the context", "too long",
                                                          "maximum context", "too large", "available context", "context_length")):
        return None
    limit, tokens = _N_CTX.search(detail), _N_PROMPT.search(detail)
    return ContextOverflow("Запрос не помещается в контекст модели роутера", int(limit[1]) if limit else None,
                           int(tokens[1]) if tokens else None)


def diagnose(url: str, code: int, detail: str) -> str:
    """Понятное объяснение HTTP-ошибки роутера. Ключ из текста убран."""
    text = f"Роутер вернул HTTP {code} по адресу {url}."
    snippet = re.sub(r"<[^>]+>", " ", redact(detail))[:300].strip()
    if snippet:
        text += f" Ответ сервера: {snippet}."
    if code in (401, 403):
        text += " Ключ не принят или отозван: проверьте его на " + BILLING_URL + " и внесите заново в «Администрирование → Интеграция с ИИ»."
    elif code == 402:
        text += f" Похоже, на балансе нет средств: пополните его на {BILLING_URL}."
    elif code in (404, 405):
        text += " Модель с таким именем роутеру неизвестна: выберите точное имя из кнопки «Получить список моделей»."
    elif code in (400, 422):
        text += " Роутер отклонил запрос: проверьте имя модели и в параметрах роутера «Формат ответа» и «Параметр лимита»."
    elif code == 429:
        text += " Превышен лимит запросов роутера или поставщика модели: повторите через минуту."
    elif code >= 500:
        text += " Сбой на стороне роутера или поставщика модели: повторите позже или выберите другую модель."
    return text


# ---------------------------------------------------------------- учёт токенов

class UsageMeter:
    """Расход токенов за один вопрос помощника (вызовов модели бывает несколько; повтор после обрыва тоже стоит денег)."""

    def __init__(self):
        self.prompt = self.completion = self.requests = 0
        self.estimated = False

    def add(self, usage, sizes=(0, 0)) -> None:
        """Не все серверы присылают usage в потоке: тогда расход оценивается по длине текста (русский ≈ 2,2 знака на токен)."""
        self.requests += 1
        if not isinstance(usage, dict) or not (usage.get("prompt_tokens") or usage.get("input_tokens")
                                                or usage.get("completion_tokens") or usage.get("output_tokens")):
            self.prompt += round(sizes[0] / 2.2)
            self.completion += round(sizes[1] / 2.2)
            self.estimated = True
            return
        self.prompt += int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        self.completion += int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)

    def as_dict(self) -> dict:
        return {"prompt": self.prompt, "completion": self.completion, "requests": self.requests, "estimated": self.estimated}


# ---------------------------------------------------------------- обращение

# Подобранное по ответам сервера (какой формат и какой параметр лимита принимает модель) помнится в процессе:
# иначе каждый вопрос заново проходил бы отказы 400. Ключ — адрес и модель.
_learned: dict = {}


def _body(cfg, messages, schema, name, mode, token_parameter, think_off):
    body = {"model": cfg.model, "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
            "temperature": 0, token_parameter: cfg.maxTokens, "stream": True, "stream_options": {"include_usage": True}}
    if mode == "json_schema":
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": re.sub(r"[^A-Za-z0-9_-]", "_", name)[:60] or "answer", "schema": schema}}
    elif mode == "json_object":
        body["response_format"] = {"type": "json_object"}
    if think_off:
        body["reasoning_effort"] = "none"
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return body


def _http_snippet(error: HTTPError) -> str:
    try:
        return error.read(800).decode("utf-8", "replace").strip()
    except OSError:
        return ""


def chat(cfg: RouterConnection, messages, schema, name="assistant", *, progress=None, cancel=None, meter=None,
         reasoning_guard=False, sleep=time.sleep):
    """JSON-ответ модели роутера. Исключения — те же, что у локального клиента: Dialogue обрабатывает их одинаково."""
    config_url = cfg.baseUrl
    validate_url(config_url)
    key = api_key()
    if not key:
        raise qwen_client.InferenceError("Ключ роутера не задан: внесите его в «Администрирование → Интеграция с ИИ»")
    url = api_base(config_url) + "/chat/completions"
    memo = _learned.setdefault((config_url, cfg.model), {})
    mode = memo.get("mode") or cfg.jsonMode
    token_parameter = memo.get("token_parameter") or cfg.tokenParameter
    dropped = set(memo.get("dropped") or ())
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    sizes = sum(len(m["content"]) for m in messages)
    transient = 0
    for _ in range(MAX_ATTEMPTS):
        body = _body(cfg, messages, schema, name, mode, token_parameter, cfg.thinking == "off")
        for dropped_key in dropped:
            body.pop(dropped_key, None)
        try:
            response = qwen_client._read_stream(Request(url, data=dumps(body).encode(), headers=headers, method="POST"),
                                                cfg, progress, cancel, reasoning_guard)
        except HTTPError as error:
            code, detail = error.code, _http_snippet(error)
            low = detail.lower()
            if code in (400, 413, 422, 500) and (found := overflow(detail)):
                raise found from None
            if 300 <= code < 400:
                raise qwen_client.InferenceError("Роутер перенаправляет запрос; перенаправления запрещены. Проверьте адрес роутера") from None
            if code in TRANSIENT and transient < MAX_TRANSIENT_RETRIES:
                transient += 1
                for _wait in range((2 if transient == 1 else 6) * 2):      # пауза 2, затем 6 с шагами по полсекунды: отмена не ждёт
                    if cancel and cancel():
                        raise qwen_client.InferenceCancelled("Запрос прерван: задание остановлено")
                    sleep(0.5)
                continue
            if code in (400, 422):
                keys = [k for k in OPTIONAL_KEYS if k in body and k in low and k not in dropped]
                if keys:
                    dropped.update(keys)
                    memo["dropped"] = sorted(dropped)
                    continue
                if mode != "none" and any(w in low for w in ("response_format", "json_schema", "schema", "format")):
                    mode = "json_object" if mode == "json_schema" else "none"
                    memo["mode"] = mode
                    continue
                if "max_completion_tokens" in low and token_parameter == "max_tokens":
                    token_parameter = memo["token_parameter"] = "max_completion_tokens"
                    continue
                if "max_tokens" in low and token_parameter == "max_completion_tokens":
                    token_parameter = memo["token_parameter"] = "max_tokens"
                    continue
            raise qwen_client.InferenceError(diagnose(url, code, detail)) from None
        except qwen_client.InferenceError:
            raise
        except ssl.SSLError as error:
            raise qwen_client.InferenceError(f"Ошибка TLS при обращении к роутеру: {redact(error)[:160]}. " + _network_hint()) from None
        except (TimeoutError, socket.timeout):
            timeout = qwen_client.InferenceTimeout(f"Роутер не прислал данных {cfg.timeoutSeconds} с ({url}). Увеличьте «Ожидание ответа» "
                                                   "в параметрах роутера или выберите более быструю модель")
            timeout.first_token = True
            raise timeout from None
        except (URLError, OSError, http.client.HTTPException) as error:
            reason = redact(getattr(error, "reason", error))[:160]
            raise qwen_client.InferenceError(f"Роутер недоступен по адресу {url}: {reason}. " + _network_hint()) from None
        except (json.JSONDecodeError, UnicodeError):
            raise qwen_client.InferenceError("Роутер вернул некорректный ответ") from None
        break
    else:
        raise qwen_client.InferenceError("Не удалось подобрать параметры запроса, совместимые с выбранной моделью роутера")
    try:
        choice = response["choices"][0]
        content = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        detail = ""
        if isinstance(response, dict):
            err = response.get("error") or response.get("message") or response.get("detail")
            detail = redact(err.get("message") if isinstance(err, dict) else err or "")[:200]
        raise qwen_client.InferenceError("Роутер ответил без результата" + (f": {detail}" if detail else " (в ответе нет вариантов)")) from None
    if meter is not None:
        meter.add(response.get("usage"), (sizes, len(content)))
    stats = response.get("stats") or {}
    if choice.get("finish_reason") == "length":
        # Облако обычно не присылает рассуждение потоком: оно съедает лимит молча. Пустой ответ при исчерпанном лимите — это оно.
        thinking = (bool(stats.get("reasoningDeltas")) and not stats.get("deltas")) or not content.strip()
        raise qwen_client.InferenceTruncated(f"Ответ модели роутера обрезан лимитом {cfg.maxTokens} токенов", content,
                                             stats.get("deltas", 0), stats.get("reasoningDeltas", 0), False, thinking)
    if not content.strip():
        raise qwen_client.InferenceError("Модель роутера вернула пустой ответ. Выберите другую модель или режим «Рассуждения: отключать»")
    return parse_json(content)


def test_connection(config: RouterConfig):
    """Проверка по сохранённым настройкам: ключ и адрес (список моделей), наличие выбранной модели и один короткий ответ.
    Возвращает (результат для показа, счётчик токенов): токены проверки тоже стоят денег и попадают в учёт."""
    check_ready(config)
    started = time.time()
    names = [m["id"] for m in list_models(config.baseUrl)["models"]]
    meter = UsageMeter()
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}
    try:
        chat(connection(config, 1024), [{"role": "user", "content": 'Верни JSON {"ok": true} и больше ничего.'}],
             schema, "connection_test", meter=meter)
    except qwen_client.InferenceTruncated as error:
        if not error.thinking:
            raise
        raise qwen_client.InferenceError("Модель только рассуждает и за 1024 токена не дошла до ответа. Для помощника такая модель "
                                         "дорога и медленна: выберите модель без рассуждений или включите «Рассуждения: отключать»") from None
    return {"ok": True, "models": len(names), "modelListed": config.model in names,
            "latencySeconds": round(time.time() - started, 1), "usage": meter.as_dict()}, meter
