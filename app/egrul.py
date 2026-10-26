"""Реквизиты контрагента по ИНН (2026-10-26; запрос идёт с сервера).

Два источника. Основной — **DaData** (`findById/party`): нужен токен, его вносит администратор (файл `<база>.egrul-secrets.json`, права 0600,
вне БД и резервных копий — по образцу ключа бота eXpress); отдаёт и юридический адрес. Запасной, пока токена нет, — публичный поиск ЕГРЮЛ
ФНС (egrul.nalog.ru): ключ не нужен, но интерфейс неофициальный, а адреса в ответе нет. Наружу уходит ТОЛЬКО ИНН — публичный реквизит
юрлица; больше сервер ничего не отправляет. Недоступность любого источника — понятная ошибка, ручной ввод остаётся как был.

Что отдаётся: краткое и полное наименование, КПП, ОГРН, руководитель, регион и (только DaData) юридический адрес.

Где используется: кнопка «Заполнить по ИНН» в карточке контрагента и при заведении контрагента из «Численности»; массовое дозаполнение
записей-заглушек «ИНН <номер>», которые создала обработка обновления (связывание подрядчиков численности), — с предпросмотром до записи.

Отключение: переменная окружения ZHBI_EGRUL_DISABLED=1 (сервер без выхода в интернет) — запросы сразу отвечают понятным отказом.
"""

import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app import db as _db
from app.access import has_feature, is_system_admin
from app.auth import get_current_user
from app.db import begin_write, get_connection

router = APIRouter(prefix="/egrul", tags=["egrul"])

BASE = "https://egrul.nalog.ru"
TIMEOUT = 12
CACHE_TTL = 600
MAX_BATCH = 15          # записей за один запрос массового дозаполнения: каждая — два обращения к ФНС
PAUSE = 0.4             # пауза между обращениями, чтобы не нагружать чужой сервис
_cache: dict = {}
PLACEHOLDER = re.compile(r"^\s*ИНН\s*\d+\s*$", re.IGNORECASE)
DADATA_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
_TOKEN = re.compile(r"^[A-Za-z0-9]{20,64}$")
_secret_lock = threading.Lock()


# ---------------------------------------------------------------- токен DaData (файл рядом с базой, не в БД)

def _secret_path():
    return _db.DB_PATH.with_name(_db.DB_PATH.name + ".egrul-secrets.json")


def _read_secrets() -> dict:
    try:
        data = json.loads(_secret_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_secrets(data: dict) -> None:
    path = _secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # права заданы при создании: окна «читаем всеми» нет
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(tmp, path)


def dadata_token() -> str:
    return str(_read_secrets().get("dadata_token") or "").strip()


def _call(url: str, data: Optional[bytes] = None, headers: Optional[dict] = None, who: str = "ЕГРЮЛ ФНС") -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "Mozilla/5.0 (ZhBI)", "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if who == "DaData" and exc.code in (401, 403):
            raise HTTPException(status_code=503, detail="DaData отклонила токен (неверный или исчерпан дневной лимит). Администратор может заменить токен "
                                                        "в окне «Дозаполнить из ЕГРЮЛ».")
        raise HTTPException(status_code=503, detail=f"{who} ответил ошибкой {exc.code}. Реквизиты можно внести вручную.")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise HTTPException(status_code=503, detail=f"Не удалось обратиться к {who}: нет выхода в интернет у сервера или сервис недоступен. "
                                                    "Реквизиты можно внести вручную.")


def clean_inn(value) -> Optional[str]:
    text = re.sub(r"\s", "", str(value or ""))
    return text if text.isdigit() and len(text) in (10, 12) else None


def lookup(inn: str) -> Optional[dict]:
    """Реквизиты по ИНН или None, если ФНС ничего не нашла. Результат помнится десять минут (повторные нажатия не ходят наружу)."""
    inn = clean_inn(inn)
    if inn is None:
        raise HTTPException(status_code=400, detail="ИНН: 10 знаков у юрлица, 12 у ИП")
    if os.environ.get("ZHBI_EGRUL_DISABLED") == "1":
        raise HTTPException(status_code=503, detail="Запросы к ЕГРЮЛ отключены на этом сервере. Реквизиты можно внести вручную.")
    token_dd = dadata_token()
    cache_key = (inn, bool(token_dd))
    hit = _cache.get(cache_key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    if token_dd:
        result = _lookup_dadata(inn, token_dd)
        _cache[cache_key] = (time.time(), result)
        return result
    token = _call(BASE + "/", urllib.parse.urlencode({"query": inn}).encode("ascii"))
    if token.get("captchaRequired") or not token.get("t"):
        raise HTTPException(status_code=503, detail="ЕГРЮЛ ФНС потребовал проверку (капчу) — повторите позже или внесите реквизиты вручную.")
    time.sleep(PAUSE)
    rows = _call(f"{BASE}/search-result/{urllib.parse.quote(token['t'])}").get("rows") or []
    rows = [r for r in rows if str(r.get("i")) == inn]
    # действующая запись предпочтительнее прекращённой (у прекращённой есть дата в «e»)
    rows.sort(key=lambda r: 1 if r.get("e") else 0)
    result = None
    if rows:
        r = rows[0]
        full = (r.get("n") or "").strip() or None
        result = {"inn": inn, "kind": "ip" if r.get("k") == "fl" else "ul", "full_name": full,
                  "short_name": (r.get("c") or "").strip() or full, "kpp": r.get("p") or None, "ogrn": r.get("o") or None,
                  "director": (r.get("g") or "").strip() or None, "region": r.get("rn") or None,
                  "registered": r.get("r") or None, "terminated": r.get("e") or None, "source": "ЕГРЮЛ ФНС"}
    _cache[cache_key] = (time.time(), result)
    return result


def _lookup_dadata(inn: str, token: str) -> Optional[dict]:
    body = json.dumps({"query": inn, "count": 5}).encode("utf-8")
    rows = _call(DADATA_URL, body, {"Authorization": f"Token {token}", "Content-Type": "application/json"}, who="DaData").get("suggestions") or []
    rows = [r for r in rows if str((r.get("data") or {}).get("inn")) == inn]
    # головная организация предпочтительнее филиала; действующая — прекращённой
    rows.sort(key=lambda r: (1 if (r["data"].get("branch_type") == "BRANCH") else 0,
                             0 if ((r["data"].get("state") or {}).get("status") in (None, "ACTIVE")) else 1))
    if not rows:
        return None
    d = rows[0]["data"]
    name = d.get("name") or {}
    full = (name.get("full_with_opf") or rows[0].get("unrestricted_value") or rows[0].get("value") or "").strip() or None
    short = (name.get("short_with_opf") or rows[0].get("value") or full or "").strip() or None
    mgmt = d.get("management") or {}
    state = d.get("state") or {}
    director = " ".join(x for x in (str(mgmt.get("post") or "").upper(), str(mgmt.get("name") or "")) if x) or None
    return {"inn": inn, "kind": "ip" if d.get("type") == "INDIVIDUAL" else "ul", "full_name": full, "short_name": short,
            "kpp": d.get("kpp") or None, "ogrn": d.get("ogrn") or None, "director": director,
            "region": ((d.get("address") or {}).get("data") or {}).get("region_with_type"),
            "address": (d.get("address") or {}).get("unrestricted_value") or (d.get("address") or {}).get("value") or None,
            "registered": None, "terminated": (str(state.get("liquidation_date")) if state.get("status") not in (None, "ACTIVE") else None),
            "source": "DaData"}


def _guard(conn, user) -> None:
    if not has_feature(conn, user, "counterparties", "write"):
        raise HTTPException(status_code=403, detail="Нужно право на запись в справочнике контрагентов (Контрактация)")


@router.get("/lookup")
def egrul_lookup(inn: str = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        _guard(conn, user)
    finally:
        conn.close()
    found = lookup(inn)
    return {"found": found is not None, "requisites": found}


def _placeholder_rows(conn) -> list:
    rows = conn.execute("SELECT id, full_name, short_name, inn, kpp, ogrn, legal_address FROM counterparties WHERE inn IS NOT NULL ORDER BY id").fetchall()
    return [r for r in rows if clean_inn(r["inn"]) and (PLACEHOLDER.match(r["short_name"] or "") or PLACEHOLDER.match(r["full_name"] or ""))]


@router.get("/placeholders")
def egrul_placeholders(user: sqlite3.Row = Depends(get_current_user)):
    """Контрагенты-заглушки «ИНН <номер>» — что дозаполнять."""
    conn = get_connection()
    try:
        _guard(conn, user)
        return {"items": [{"id": r["id"], "inn": clean_inn(r["inn"]), "short_name": r["short_name"]} for r in _placeholder_rows(conn)]}
    finally:
        conn.close()


class SettingsIn(BaseModel):
    dadata_token: str


@router.get("/settings")
def egrul_settings(user: sqlite3.Row = Depends(get_current_user)):
    """Откуда берутся реквизиты сейчас; сам токен наружу не отдаётся никогда."""
    conn = get_connection()
    try:
        _guard(conn, user)
        admin = is_system_admin(user)
    finally:
        conn.close()
    has = bool(dadata_token())
    return {"provider": "dadata" if has else "fns", "provider_title": "DaData" if has else "ЕГРЮЛ ФНС (без юридического адреса)",
            "token_set": has, "can_edit": admin}


@router.put("/settings")
def egrul_save_settings(body: SettingsIn, user: sqlite3.Row = Depends(get_current_user)):
    if not is_system_admin(user):
        raise HTTPException(status_code=403, detail="Токен меняет администратор сервиса")
    token = (body.dadata_token or "").strip()
    if not _TOKEN.match(token):
        raise HTTPException(status_code=400, detail="Токен DaData — латинские буквы и цифры, 20–64 знака (ключ API из личного кабинета DaData)")
    with _secret_lock:
        data = _read_secrets(); data["dadata_token"] = token; _write_secrets(data)
    _cache.clear()
    activity.log("egrul_settings", user=user, entity_type="egrul", new_value="токен DaData задан")
    return {"token_set": True}


@router.delete("/settings")
def egrul_clear_settings(user: sqlite3.Row = Depends(get_current_user)):
    if not is_system_admin(user):
        raise HTTPException(status_code=403, detail="Токен меняет администратор сервиса")
    with _secret_lock:
        data = _read_secrets(); data.pop("dadata_token", None); _write_secrets(data)
    _cache.clear()
    activity.log("egrul_settings", user=user, entity_type="egrul", new_value="токен DaData удалён")
    return {"token_set": False}


class FillIn(BaseModel):
    ids: list[int]
    apply: bool = False


@router.post("/fill")
def egrul_fill(body: FillIn, user: sqlite3.Row = Depends(get_current_user)):
    """Предпросмотр (apply=false) или запись (apply=true) реквизитов из ЕГРЮЛ для заглушек. Пачка — до MAX_BATCH записей.
    Пишутся наименования (только если они остались заглушкой «ИНН …»), КПП, ОГРН и юридический адрес (только если пусты); остальное не трогается."""
    if len(body.ids) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"За один запрос — не больше {MAX_BATCH} записей")
    conn = get_connection()
    try:
        _guard(conn, user)
        wanted = {r["id"]: r for r in _placeholder_rows(conn)}
    finally:
        conn.close()
    out = []
    for cid in body.ids:
        row = wanted.get(cid)
        if row is None:
            out.append({"id": cid, "status": "skip", "message": "уже не заглушка"})
            continue
        inn = clean_inn(row["inn"])
        try:
            req = lookup(inn)
        except HTTPException as exc:
            out.append({"id": cid, "inn": inn, "status": "error", "message": exc.detail})
            if exc.status_code == 503:
                break   # сервис недоступен — остальные заведомо не ответят
            continue
        if req is None:
            out.append({"id": cid, "inn": inn, "status": "notfound", "message": "в ЕГРЮЛ не найден"})
            continue
        change = {
            "full_name": req["full_name"] if PLACEHOLDER.match(row["full_name"] or "") else None,
            "short_name": req["short_name"] if PLACEHOLDER.match(row["short_name"] or "") else None,
            "kpp": req["kpp"] if not (row["kpp"] or "").strip() else None,
            "ogrn": req["ogrn"] if not (row["ogrn"] or "").strip() else None,
            "legal_address": req.get("address") if not (row["legal_address"] or "").strip() else None,
        }
        change = {k: v for k, v in change.items() if v}
        item = {"id": cid, "inn": inn, "status": "ok", "current": {"short_name": row["short_name"], "full_name": row["full_name"]},
                "proposed": change, "terminated": req["terminated"]}
        if body.apply and change:
            conn = get_connection()
            try:
                begin_write(conn)
                sets = ", ".join(f"{k} = ?" for k in change)
                conn.execute(f"UPDATE counterparties SET {sets}, updated_at = datetime('now') WHERE id = ?", [*change.values(), cid])
                conn.commit()
            finally:
                conn.close()
            activity.log("counterparty_egrul_fill", user=user, entity_type="counterparty", entity_id=cid,
                         old_value=row["short_name"], new_value=change.get("short_name") or row["short_name"], details={"inn": inn})
            item["status"] = "applied"
        out.append(item)
        time.sleep(PAUSE)
    return {"items": out}
