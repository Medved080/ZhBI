"""Реквизиты контрагента по ИНН из ЕГРЮЛ ФНС (2026-10-26, решение заказчика: «через сервер»).

Откуда. Публичный поиск egrul.nalog.ru (тот же, что на сайте ФНС): запрос по ИНН отдаёт токен, по токену — найденные записи. Ключ не нужен.
Наружу уходит ТОЛЬКО ИНН — публичный реквизит юрлица; сервер больше ничего не отправляет. Интерфейс неофициальный и может измениться без
предупреждения — тогда ответ понятной ошибкой «сервис ФНС недоступен», а ручной ввод в справочнике остаётся как был.

Что отдаётся: краткое и полное наименование, КПП, ОГРН, руководитель и регион. Юридического адреса в этом ответе нет (он есть только в
выписке) — поле «Юридический адрес» подстановка не трогает.

Где используется: кнопка «Заполнить по ИНН» в карточке контрагента и при заведении контрагента из «Численности»; массовое дозаполнение
записей-заглушек «ИНН <номер>», которые создала обработка обновления (связывание подрядчиков численности), — с предпросмотром до записи.

Отключение: переменная окружения ZHBI_EGRUL_DISABLED=1 (сервер без выхода в интернет) — запросы сразу отвечают понятным отказом.
"""

import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app.access import has_feature
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


def _call(url: str, data: Optional[bytes] = None) -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "Mozilla/5.0 (ZhBI)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise HTTPException(status_code=503, detail="Не удалось обратиться к ЕГРЮЛ ФНС: нет выхода в интернет у сервера или сервис недоступен. "
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
    hit = _cache.get(inn)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
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
    _cache[inn] = (time.time(), result)
    return result


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
    rows = conn.execute("SELECT id, full_name, short_name, inn, kpp, ogrn FROM counterparties WHERE inn IS NOT NULL ORDER BY id").fetchall()
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


class FillIn(BaseModel):
    ids: list[int]
    apply: bool = False


@router.post("/fill")
def egrul_fill(body: FillIn, user: sqlite3.Row = Depends(get_current_user)):
    """Предпросмотр (apply=false) или запись (apply=true) реквизитов из ЕГРЮЛ для заглушек. Пачка — до MAX_BATCH записей.
    Пишутся наименования (только если они остались заглушкой «ИНН …»), КПП и ОГРН (только если пусты); остальное не трогается."""
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
