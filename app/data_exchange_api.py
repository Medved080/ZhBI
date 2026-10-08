"""
HTTP-слой обмена данными между серверами (2026-10-08). Логика сверки и применения — app/data_exchange.py.

Два набора маршрутов под одним префиксом `/admin/data-exchange`, и каждый сервер может быть и тем, и другим:

* «серверные» (их вызывает другой сервер или этот же интерфейс): `info`, `export`, `upload`, `analyze`,
  `analysis/{id}/items`, `apply` — работают с БАЗОЙ ЭТОГО сервера;
* «инициатор» (их вызывает человек из интерфейса): `connect` (вход на ДРУГОМ сервере по логину и паролю его
  администратора), `pull` (получить: чужой пакет → сверка с этой базой), `push` (отправить: этот пакет → сверка с чужой
  базой), `remote/{id}/…` (просмотр сверки и применение на чужом сервере).

Доступ — право «Перенос базы целиком» (`db_transfer`, только администратор сервиса): обмен того же уровня доверия.
Пароль чужого сервера нигде не сохраняется: после входа в памяти процесса держится только cookie сеанса (30 минут без
действий), «Отключиться» (и истечение срока) закрывает сеанс на том сервере.

Отправка требует ДВОЙНОГО подтверждения (решение пользователя 2026-10-08): сервер сам проверяет, что запрос несёт отметку
первого шага и введённое вручную имя принимающего сервера (`confirm.typed`). Получение — одно подтверждение в интерфейсе.
Перед КАЖДЫМ применением принимающий сервер снимает копию базы.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import secrets
import socket
import ssl
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app import activity, data_exchange as dx
from app.access import require_service_feature
from app.auth import audit_display_name
from app.backups import backup_before_import
from app.db import begin_write, get_connection

ROOT = Path(__file__).resolve().parent.parent
STAGING_DIR = ROOT / "data" / "exchange"
STAGING_TTL = 12 * 3600
CONN_TTL = 30 * 60
CHUNK = 1024 * 1024
MIN_CHUNK = 32 * 1024
ITEMS_LIMIT = 300
HEX32 = re.compile(r"^[0-9a-f]{32}$")
CONFIRM_WORD = "ОТПРАВИТЬ"

router = APIRouter(prefix="/admin/data-exchange")
_read = require_service_feature("db_transfer", "read")
_write = require_service_feature("db_transfer", "write")
_APPLY_LOCK = threading.Lock()


def _fail(error: dx.ExchangeError):
    return HTTPException(status_code=error.status, detail=str(error))


# ----------------------------------------------------------------------------- хранилище сверок
def _staging_path(kind: str, ident: str) -> Path:
    if not HEX32.match(ident or ""):
        raise HTTPException(400, "Недопустимый идентификатор")
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    return STAGING_DIR / f"{ident}.{kind}"


def _cleanup() -> None:
    if not STAGING_DIR.is_dir():
        return
    now = time.time()
    for p in STAGING_DIR.iterdir():
        try:
            if now - p.stat().st_mtime > STAGING_TTL:
                p.unlink()
        except OSError:
            pass


_CACHE: dict = {}          # id сверки → (пакет, сверка, мета); небольшой кэш, чтобы постраничный просмотр не перечитывал файл


def _save_analysis(package: dict, analysis: dict, meta: dict) -> str:
    _cleanup()
    aid = uuid.uuid4().hex
    _staging_path("ana", aid).write_text(json.dumps({"meta": meta, "analysis": analysis}, ensure_ascii=False), encoding="utf-8")
    pid = meta["package_id"]
    path = _staging_path("pkg", pid)
    if not path.exists():
        path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
    _CACHE[aid] = (package, analysis, meta)
    while len(_CACHE) > 3:
        _CACHE.pop(next(iter(_CACHE)))
    return aid


def _load_analysis(aid: str, user) -> tuple:
    if aid in _CACHE:
        package, analysis, meta = _CACHE[aid]
    else:
        path = _staging_path("ana", aid)
        if not path.exists():
            raise HTTPException(404, "Сверка не найдена или устарела — выполните её заново")
        stored = json.loads(path.read_text(encoding="utf-8"))
        meta, analysis = stored["meta"], stored["analysis"]
        pkg_path = _staging_path("pkg", meta["package_id"])
        if not pkg_path.exists():
            raise HTTPException(404, "Пакет сверки не найден — выполните сверку заново")
        package = json.loads(pkg_path.read_text(encoding="utf-8"))
        _CACHE[aid] = (package, analysis, meta)
    if meta.get("user_id") != user["id"]:
        raise HTTPException(403, "Сверка выполнена другим пользователем")
    return package, analysis, meta


def _summary(aid: str, analysis: dict, meta: dict) -> dict:
    groups = []
    by_group: dict = {}
    for r in analysis["entities"]:
        if r["state"] == "same":
            continue
        g = by_group.setdefault((r["kind"], r["state"]), {"count": 0, "reasons": {}})
        g["count"] += 1
        for p in r.get("problems", []):
            g["reasons"][p] = g["reasons"].get(p, 0) + 1
    same: dict = {}
    for r in analysis["entities"]:
        if r["state"] == "same":
            same[r["kind"]] = same.get(r["kind"], 0) + 1
    order = {k: i for i, k in enumerate(dx.KIND_ORDER)}
    for (kind, state), g in sorted(by_group.items(), key=lambda x: (order[x[0][0]], ["new", "changed", "blocked"].index(x[0][1]))):
        top = sorted(g["reasons"].items(), key=lambda x: -x[1])[:3]
        groups.append({"id": dx.group_id(kind, state), "kind": kind, "state": state, "section": dx.KIND_SECTION[kind],
                       "title": dx.KIND_TITLES[kind], "count": g["count"],
                       "reasons": [{"text": t, "count": n} for t, n in top]})
    kinds = sorted({r["kind"] for r in analysis["entities"]}, key=lambda k: order[k])
    return {"analysis_id": aid, "direction": meta["direction"], "sections": meta.get("sections"), "groups": groups,
            "same": {k: same.get(k, 0) for k in kinds}, "kinds": [{"kind": k, "title": dx.KIND_TITLES[k], "section": dx.KIND_SECTION[k]} for k in kinds],
            "source": analysis.get("source"), "created_at": meta.get("created_at")}


def _items(analysis: dict, group: str, offset: int, limit: int) -> dict:
    try:
        kind, state = group.split(":")
    except ValueError:
        raise HTTPException(400, "Недопустимая группа")
    rows = [r for r in analysis["entities"] if r["kind"] == kind and r["state"] == state]
    limit = max(1, min(limit, ITEMS_LIMIT))
    page = rows[offset:offset + limit]
    return {"total": len(rows), "offset": offset,
            "items": [{"id": r["id"], "label": r["label"], "state": r["state"], "changes": r.get("changes", []),
                       "problems": r.get("problems", []), "warnings": r.get("warnings", [])} for r in page]}


# ----------------------------------------------------------------------------- серверные маршруты
class ExportIn(BaseModel):
    sections: list[str]
    objects: Optional[list[str]] = None


@router.get("/info")
def info(user: sqlite3.Row = Depends(_read)):
    conn = get_connection()
    try:
        names = [r["name"] for r in conn.execute("SELECT name FROM objects ORDER BY name")]
        return {"server": dx.server_info(conn), "objects": names,
                "sections": [{"key": k, "title": v["title"], "hint": v["hint"]} for k, v in dx.SECTIONS.items()],
                "user": audit_display_name(user)}
    finally:
        conn.close()


@router.post("/export")
def export(body: ExportIn, user: sqlite3.Row = Depends(_write)):
    """Пакет выбранных разделов этой базы — для получения другим сервером. Ничего не меняет."""
    conn = get_connection()
    try:
        package = dx.build_package(conn, body.sections, body.objects)
    except dx.ExchangeError as e:
        raise _fail(e)
    finally:
        conn.close()
    activity.log("data_exchange_export", user=user, new_value=", ".join(body.sections),
                 details={"сущностей": len(package["entities"]), "объекты": body.objects})
    return package


@router.put("/upload")
async def upload(request: Request, id: str, offset: int, size: int, sha256: str, user: sqlite3.Row = Depends(_write)):
    """Приём пакета блоками (прокси режут большие тела). Готов, когда принят целиком и сошлась SHA-256."""
    if not re.fullmatch(r"[0-9a-f]{64}", sha256 or "") or size < 0 or size > 512 * 1024 * 1024:
        raise HTTPException(400, "Недопустимые параметры загрузки")
    data = await request.body()
    part = _staging_path("part", id)
    if offset == 0:
        _cleanup()
        part.unlink(missing_ok=True)
    current = part.stat().st_size if part.exists() else 0
    if offset != current:
        raise HTTPException(409, {"message": f"Смещение {offset} не совпадает с принятым объёмом {current}", "received": current})
    if current + len(data) > size:
        raise HTTPException(413, "Принято больше заявленного размера")
    with part.open("ab") as stream:
        stream.write(data)
    received = current + len(data)
    complete = received == size
    if complete:
        digest = hashlib.sha256(part.read_bytes()).hexdigest()
        if digest != sha256:
            part.unlink(missing_ok=True)
            raise HTTPException(409, "Контрольная сумма пакета не совпала — отправьте его заново")
        part.replace(_staging_path("pkg", id))
    return {"received": received, "complete": complete}


class AnalyzeIn(BaseModel):
    package_id: str


@router.post("/analyze")
def analyze(body: AnalyzeIn, user: sqlite3.Row = Depends(_write)):
    """Сверка принятого пакета с базой ЭТОГО сервера. Ничего не пишет."""
    path = _staging_path("pkg", body.package_id)
    if not path.exists():
        raise HTTPException(404, "Пакет не найден на сервере — отправьте его заново")
    package = json.loads(path.read_text(encoding="utf-8"))
    conn = get_connection()
    try:
        analysis = dx.analyze(conn, package)
    except dx.ExchangeError as e:
        raise _fail(e)
    finally:
        conn.close()
    meta = {"package_id": body.package_id, "user_id": user["id"], "direction": "incoming",
            "sections": package.get("sections"), "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    aid = _save_analysis(package, analysis, meta)
    activity.log("data_exchange_stage", user=user, new_value=", ".join(package.get("sections") or []),
                 details={"сущностей": len(package["entities"]), "источник": (package.get("source") or {}).get("host")})
    return _summary(aid, analysis, meta)


@router.get("/analysis/{aid}/items")
def analysis_items(aid: str, group: str, offset: int = 0, limit: int = ITEMS_LIMIT, user: sqlite3.Row = Depends(_write)):
    _, analysis, _ = _load_analysis(aid, user)
    return _items(analysis, group, max(0, offset), limit)


class ApplyIn(BaseModel):
    analysis_id: str
    selection: dict


@router.post("/apply")
def apply_selected(body: ApplyIn, user: sqlite3.Row = Depends(_write)):
    """Применяет отмеченное к базе ЭТОГО сервера: копия базы → блокировка записи → одна транзакция."""
    package, analysis, meta = _load_analysis(body.analysis_id, user)
    chosen = dx.selected_ids(analysis["entities"], body.selection or {})
    if not chosen:
        raise HTTPException(400, "Не отмечено ничего, что можно применить")
    if not _APPLY_LOCK.acquire(blocking=False):
        raise HTTPException(409, "На сервере уже применяется другой обмен данными")
    conn = None
    события = activity.defer_begin()
    try:
        name = audit_display_name(user)
        backup_before_import(f"обмен данными с другим сервером ({', '.join(package.get('sections') or [])})", name, user["id"])
        conn = get_connection()
        begin_write(conn)
        try:
            result = dx.apply(conn, package, analysis, body.selection or {}, name, user["id"])
        except dx.ExchangeError as e:
            conn.rollback()
            raise _fail(e)
        except sqlite3.Error as e:
            conn.rollback()
            raise HTTPException(409, f"База отклонила запись: {e}. Ничего не применено.")
        activity.log("data_exchange_apply", user=user, new_value=", ".join(package.get("sections") or []),
                     details={"применено": result["applied"], "пропущено": len(result["skipped"]),
                              "источник": (package.get("source") or {}).get("host"), "направление": meta.get("direction")})
        activity.defer_flush(события)
        _CACHE.pop(body.analysis_id, None)
        return result
    finally:
        activity.defer_end(события)
        if conn is not None:
            conn.close()
        _APPLY_LOCK.release()


# ----------------------------------------------------------------------------- клиент чужого сервера
class RemoteError(Exception):
    def __init__(self, status: int, message: str, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail if detail is not None else {"detail": message}


def _detail_text(raw: str) -> str:
    try:
        d = json.loads(raw)
    except ValueError:
        return raw[:300]
    d = d.get("detail", d) if isinstance(d, dict) else d
    if isinstance(d, dict):
        return str(d.get("message") or d)
    if isinstance(d, list):
        return "; ".join(str(x.get("msg", x)) if isinstance(x, dict) else str(x) for x in d)[:300]
    return str(d)


def check_remote_url(url: str) -> str:
    """Адрес чужого сервера: только http/https без вложенных данных; служебные адреса облака и канальный уровень закрыты."""
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, "Адрес сервера — вида https://сервер или http://сервер:порт")
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)):
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
                raise HTTPException(400, "Этот адрес недопустим для обмена данными")
    except socket.gaierror:
        raise HTTPException(400, f"Адрес «{parts.hostname}» не найден (VPN включён?)")
    return f"{parts.scheme}://{parts.netloc}"


class RemoteSession:
    """Минимальный клиент чужого сервера на urllib (без новых зависимостей): вход по логину и паролю, cookie сеанса в памяти."""

    def __init__(self, base: str, insecure_tls: bool = False):
        self.base = base
        self.cookie: Optional[str] = None
        self.chunk = CHUNK
        if insecure_tls and base.startswith("https"):
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
        else:
            self.opener = urllib.request.build_opener()

    def _open(self, method: str, path: str, data: Optional[bytes], content_type: str, headers: Optional[dict], timeout: int, login: bool = False):
        h = {"Content-Type": content_type}
        if self.cookie:
            h["Cookie"] = self.cookie
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            resp = self.opener.open(req, timeout=timeout)
            if login:
                for c in resp.headers.get_all("Set-Cookie") or []:
                    if c.startswith("zhbi_session="):
                        self.cookie = c.split(";", 1)[0]
            return resp
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = {"detail": text[:300]}
            raise RemoteError(e.code, _detail_text(text), parsed if isinstance(parsed, dict) else {"detail": parsed}) from None
        except ssl.SSLError as e:
            raise RemoteError(0, f"Не удалось проверить сертификат сервера: {e}. Если сервер внутренний, отметьте «Не проверять сертификат».") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            raise RemoteError(0, f"Нет связи с сервером (VPN включён?): {getattr(e, 'reason', e)}") from None

    def call(self, method: str, path: str, body=None, raw: Optional[bytes] = None, timeout: int = 600, login: bool = False,
             headers: Optional[dict] = None):
        data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None)
        with self._open(method, path, data, "application/octet-stream" if raw is not None else "application/json", headers, timeout, login) as resp:
            text = resp.read().decode("utf-8")
            return json.loads(text) if text else {}

    def call_bytes(self, path: str, timeout: int = 600) -> bytes:
        with self._open("GET", path, None, "application/json", None, timeout) as resp:
            return resp.read()

    def upload_package(self, data: bytes) -> str:
        """Блочная отправка пакета; размер блока уменьшается на 413 (прокси режет тело)."""
        ident = uuid.uuid4().hex
        sha = hashlib.sha256(data).hexdigest()
        size = len(data)
        offset = 0
        while offset < size or size == 0:
            chunk = data[offset:offset + self.chunk]
            for attempt in range(4):
                try:
                    res = self.call("PUT", f"/admin/data-exchange/upload?id={ident}&offset={offset}&size={size}&sha256={sha}", raw=chunk, timeout=300)
                    break
                except RemoteError as e:
                    if (e.status == 413 or (e.status == 0 and self.chunk > 256 * 1024 and attempt == 0)) and self.chunk > MIN_CHUNK:
                        self.chunk = max(MIN_CHUNK, self.chunk // 4)
                        chunk = data[offset:offset + self.chunk]
                        continue
                    if e.status in (0, 502, 503, 504) and attempt < 3:
                        time.sleep(2 ** attempt)
                        continue
                    raise
            offset += len(chunk)
            if size == 0 or res.get("complete"):
                break
        return ident


class _Conn:
    def __init__(self, user_id, base, session, login, info):
        self.user_id, self.base, self.session, self.login, self.info = user_id, base, session, login, info
        self.created = self.last = time.time()


_CONNS: dict = {}
_CONNS_LOCK = threading.Lock()


def _prune() -> None:
    now = time.time()
    with _CONNS_LOCK:
        for cid in [c for c, v in _CONNS.items() if now - v.last > CONN_TTL]:
            _close(_CONNS.pop(cid))


def _close(c: "_Conn") -> None:
    try:
        c.session.call("POST", "/logout", body={}, timeout=10)
    except Exception:  # noqa: BLE001 — сеанс всё равно истечёт на том сервере
        pass


def _conn(cid: str, user) -> "_Conn":
    _prune()
    c = _CONNS.get(cid)
    if c is None or c.user_id != user["id"]:
        raise HTTPException(404, "Подключение закрыто (истекло 30 минут без действий) — подключитесь заново")
    c.last = time.time()
    return c


def _remote_call(c: "_Conn", *a, **kw):
    try:
        return c.session.call(*a, **kw)
    except RemoteError as e:
        if e.status == 401:
            raise HTTPException(409, "Сеанс на другом сервере закрыт — подключитесь заново")
        if e.status == 403:
            raise HTTPException(403, "На другом сервере у этой учётной записи нет права на обмен данными (нужен администратор сервиса)")
        raise HTTPException(502 if e.status in (0, 502, 503, 504) else (e.status if 400 <= e.status < 500 else 502), f"Другой сервер: {e}")


def _public(cid: str, c: "_Conn") -> dict:
    return {"connection_id": cid, "url": c.base, "login": c.login, "server": c.info.get("server"), "objects": c.info.get("objects"),
            "sections": c.info.get("sections"), "host": urlsplit(c.base).hostname, "remote_user": c.info.get("user")}


# ----------------------------------------------------------------------------- маршруты инициатора
class ConnectIn(BaseModel):
    url: str
    login: str
    password: str
    insecure_tls: bool = False


@router.post("/connect")
def connect(body: ConnectIn, user: sqlite3.Row = Depends(_write)):
    base = check_remote_url(body.url)
    session = RemoteSession(base, body.insecure_tls)
    try:
        session.call("POST", "/login", body={"domain_login": body.login, "password": body.password}, timeout=30, login=True)
        if not session.cookie:
            raise RemoteError(0, "сервер не выдал сеанс")
        info = session.call("GET", "/admin/data-exchange/info", timeout=60)
    except RemoteError as e:
        activity.log("data_exchange_connect", user=user, new_value=base, details={"результат": "отказ", "причина": str(e)[:200]})
        if e.status == 403:
            raise HTTPException(403, "Вход выполнен, но у этой учётной записи нет права на обмен данными на том сервере (нужен администратор сервиса)")
        if e.status == 404:
            raise HTTPException(502, "На том сервере нет обмена данными: он ещё не обновлён до этой версии")
        raise HTTPException(401 if e.status == 401 else 502, f"Не удалось подключиться: {e}")
    cid = secrets.token_hex(16)
    _prune()
    with _CONNS_LOCK:
        mine = [k for k, v in _CONNS.items() if v.user_id == user["id"]]
        for k in mine[:-4]:
            _close(_CONNS.pop(k))
        _CONNS[cid] = _Conn(user["id"], base, session, body.login, info)
    activity.log("data_exchange_connect", user=user, new_value=base, details={"результат": "подключено", "логин": body.login,
                                                                              "роль сервера": (info.get("server") or {}).get("role")})
    return _public(cid, _CONNS[cid])


@router.get("/connections")
def connections(user: sqlite3.Row = Depends(_read)):
    _prune()
    return {"connections": [_public(k, v) for k, v in _CONNS.items() if v.user_id == user["id"]]}


@router.delete("/connections/{cid}")
def disconnect(cid: str, user: sqlite3.Row = Depends(_write)):
    c = _CONNS.pop(cid, None)
    if c is not None and c.user_id == user["id"]:
        _close(c)
    elif c is not None:
        _CONNS[cid] = c
    return {"ok": True}


class TransferIn(BaseModel):
    connection_id: str
    sections: list[str]
    objects: Optional[list[str]] = None


def _same_server(local_info: dict, remote_info: dict) -> bool:
    """Тот же процесс/файл базы: обмен «сам с собой» бессмыслен и опасен (применение перезаписало бы то, что сверялось)."""
    return bool(local_info.get("db_id")) and local_info.get("db_id") == remote_info.get("db_id") and local_info.get("host") == remote_info.get("host")


@router.post("/pull")
def pull(body: TransferIn, user: sqlite3.Row = Depends(_write)):
    """ПОЛУЧИТЬ: пакет выбранных разделов чужого сервера → сверка с базой ЭТОГО сервера. Ничего не пишет."""
    c = _conn(body.connection_id, user)
    package = _remote_call(c, "POST", "/admin/data-exchange/export", body={"sections": body.sections, "objects": body.objects}, timeout=900)
    conn = get_connection()
    try:
        if _same_server(dx.server_info(conn), package.get("source") or {}):
            raise HTTPException(400, "Это тот же сервер и та же база — обмениваться не с кем")
        analysis = dx.analyze(conn, package)
    except dx.ExchangeError as e:
        raise _fail(e)
    finally:
        conn.close()
    pid = uuid.uuid4().hex
    meta = {"package_id": pid, "user_id": user["id"], "direction": "receive", "sections": package.get("sections"),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "peer": c.base}
    aid = _save_analysis(package, analysis, meta)
    activity.log("data_exchange_pull", user=user, new_value=c.base,
                 details={"разделы": package.get("sections"), "сущностей": len(package["entities"])})
    out = _summary(aid, analysis, meta)
    out["peer"] = _public(body.connection_id, c)
    return out


@router.post("/push")
def push(body: TransferIn, user: sqlite3.Row = Depends(_write)):
    """ОТПРАВИТЬ: пакет выбранных разделов ЭТОЙ базы → чужой сервер → сверка с ЕГО базой. Ничего не пишет."""
    c = _conn(body.connection_id, user)
    conn = get_connection()
    try:
        if _same_server(dx.server_info(conn), c.info.get("server") or {}):
            raise HTTPException(400, "Это тот же сервер и та же база — обмениваться не с кем")
        package = dx.build_package(conn, body.sections, body.objects)
    except dx.ExchangeError as e:
        raise _fail(e)
    finally:
        conn.close()
    try:
        pid = c.session.upload_package(json.dumps(package, ensure_ascii=False).encode("utf-8"))
        summary = c.session.call("POST", "/admin/data-exchange/analyze", body={"package_id": pid}, timeout=900)
    except RemoteError as e:
        raise HTTPException(502 if e.status in (0, 502, 503, 504) else (e.status if 400 <= e.status < 500 else 502), f"Другой сервер: {e}")
    activity.log("data_exchange_push", user=user, new_value=c.base,
                 details={"разделы": package.get("sections"), "сущностей": len(package["entities"])})
    summary["direction"] = "send"
    summary["peer"] = _public(body.connection_id, c)
    return summary


@router.get("/remote/{cid}/analysis/{aid}/items")
def remote_items(cid: str, aid: str, group: str, offset: int = 0, limit: int = ITEMS_LIMIT, user: sqlite3.Row = Depends(_write)):
    c = _conn(cid, user)
    from urllib.parse import quote
    return _remote_call(c, "GET", f"/admin/data-exchange/analysis/{aid}/items?group={quote(group)}&offset={int(offset)}&limit={int(limit)}", timeout=120)


class RemoteApplyIn(BaseModel):
    analysis_id: str
    selection: dict
    confirm: dict


@router.post("/remote/{cid}/apply")
def remote_apply(cid: str, body: RemoteApplyIn, user: sqlite3.Row = Depends(_write)):
    """Применить на ЧУЖОМ сервере. Двойное подтверждение проверяется здесь, а не только в интерфейсе."""
    c = _conn(cid, user)
    expected_host = (urlsplit(c.base).hostname or "").lower()
    typed = str((body.confirm or {}).get("typed") or "").strip().lower()
    if not (body.confirm or {}).get("step1") or typed not in {expected_host, CONFIRM_WORD.lower()}:
        raise HTTPException(400, f"Нет двойного подтверждения: отметьте первый шаг и введите «{CONFIRM_WORD}» или имя сервера «{expected_host}»")
    result = _remote_call(c, "POST", "/admin/data-exchange/apply", body={"analysis_id": body.analysis_id, "selection": body.selection}, timeout=1800)
    activity.log("data_exchange_push_apply", user=user, new_value=c.base,
                 details={"применено": result.get("applied"), "пропущено": len(result.get("skipped") or [])})
    return result


# ----------------------------------------------------------------------------- калькулятор
class CalcPlanIn(BaseModel):
    connection_id: str
    direction: str


def _calc_module():
    try:
        from app.calc import exchange
    except Exception as exc:  # noqa: BLE001 — подсистема не подключена (нет Python 3.12 и т.п.)
        raise HTTPException(503, f"Подсистема «Калькулятор» на этом сервере не подключена: {exc}")
    return exchange


def _calc_remote_error(exc: Exception):
    status = getattr(exc, "status", None)
    detail = getattr(exc, "detail", None)
    text = (detail.get("detail") if isinstance(detail, dict) else None) or str(exc)
    if status == 403:
        return HTTPException(403, "На другом сервере у этой учётной записи нет права на «Калькулятор» (нужна роль «Калькулятор» или администратор)")
    if status == 404:
        return HTTPException(502, "На другом сервере нет подсистемы «Калькулятор» или она старой версии")
    if status == 409 and isinstance(detail, dict) and "assetsNeeded" in detail:
        return HTTPException(409, f"{text}: на другом сервере не хватает файлов — повторите передачу")
    return HTTPException(502 if (status in (0, None) or status >= 500) else status, f"Другой сервер: {text}")


@router.post("/calc/plan")
def calc_plan(body: CalcPlanIn, user: sqlite3.Row = Depends(_write)):
    """Сверка калькулятора (ничего не меняет). Калькулятор передаётся целиком; приоритет у данных принимающей стороны."""
    if body.direction not in ("send", "receive"):
        raise HTTPException(400, "Направление — send или receive")
    c = _conn(body.connection_id, user)
    ex = _calc_module()
    try:
        out = ex.plan(c.session, body.direction, user["id"], body.connection_id)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _calc_remote_error(exc)
    activity.log("data_exchange_calc_plan", user=user, new_value=c.base,
                 details={"направление": body.direction, "файлов исходников": out["assets_needed"], "вложений": out["blobs_needed"]})
    return out


class CalcApplyIn(BaseModel):
    connection_id: str
    direction: str
    plan_id: str
    confirm: Optional[dict] = None


@router.post("/calc/apply")
def calc_apply(body: CalcApplyIn, user: sqlite3.Row = Depends(_write)):
    """Запуск фоновой передачи/приёма калькулятора. Отправка — с двойным подтверждением, как и отправка разделов."""
    if body.direction not in ("send", "receive"):
        raise HTTPException(400, "Направление — send или receive")
    c = _conn(body.connection_id, user)
    if body.direction == "send":
        host = (urlsplit(c.base).hostname or "").lower()
        typed = str((body.confirm or {}).get("typed") or "").strip().lower()
        if not (body.confirm or {}).get("step1") or typed not in {host, CONFIRM_WORD.lower()}:
            raise HTTPException(400, f"Нет двойного подтверждения: отметьте первый шаг и введите «{CONFIRM_WORD}» или имя сервера «{host}»")
    ex = _calc_module()
    try:
        job_id = ex.start(c.session, body.plan_id, body.direction, user["id"])
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _calc_remote_error(exc)
    activity.log("data_exchange_calc", user=user, new_value=c.base, details={"направление": body.direction})
    return {"job_id": job_id}


@router.get("/calc/jobs/{job_id}")
def calc_job(job_id: str, user: sqlite3.Row = Depends(_write)):
    return _calc_module().job_state(job_id, user["id"])
