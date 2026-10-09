"""Учёт численности персонала по объектам — API (2026-10-09, Docs/headcount.md).

Что хранится. Сколько рабочих подрядчик вывел на объект за день по виду работ (кодификатор). Ключ записи — (объект, день,
подрядчик, вид работ): повторный ввод по ключу заменяет число, прежнее остаётся в `headcount_history`. Вносит менеджер проекта
(руководитель проекта) или начальник участка; право — раздел `headcount` (app/features.py).

Срок по приказу П-ОД-38 (приложение 1): данные за рабочий день — до 11:00 того же дня, за субботу и воскресенье — до 11:00
понедельника. Вносить можно и позже, без ограничений; такая запись получает `late = 1` при ПЕРВОМ внесении и подсвечивается.
Праздничные дни не учитываются: календаря нерабочих дней в системе нет. Время — московское: сервис живёт по UTC, а срок задан
местным временем.

Отчёт (`/headcount/report`) устроен так, чтобы показатели можно было складывать вверх по иерархии: «среднее за неделю» и «среднее
за месяц» — сумма человек-дней за окно, делённая на число дней окна, в которые в ВЫБОРКЕ есть хоть одна запись; делитель один на
всю выборку, поэтому среднее у родителя равно сумме средних у детей. (Допущение, в макете Power BI формула не раскрыта — сверить с
заказчиком.)
"""

import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import activity
from app.access import accessible_object_ids, assert_object_feature, has_feature
from app.auth import get_current_user
from app.db import begin_write, get_connection

FEATURE_KEY = "headcount"
MSK = ZoneInfo("Europe/Moscow")
DEADLINE_TIME = time(11, 0)
MAX_WORKERS = 100_000
MAX_ROWS_PER_SAVE = 500
SOURCES = ("form", "import", "bot")

router = APIRouter(prefix="/objects/{object_id}/headcount", tags=["headcount"])
global_router = APIRouter(prefix="/headcount", tags=["headcount"])


# ------------------------------------------------------------------ время и срок

def now_msk() -> datetime:
    return datetime.now(MSK)


def deadline_for(work_date: date) -> datetime:
    """Срок внесения численности за день: рабочий день — 11:00 этого же дня; суббота и воскресенье — 11:00 понедельника."""
    due = work_date
    if due.weekday() == 5:
        due += timedelta(days=2)
    elif due.weekday() == 6:
        due += timedelta(days=1)
    return datetime.combine(due, DEADLINE_TIME, tzinfo=MSK)


def _db_time(value: Optional[str]) -> Optional[datetime]:
    """Момент из БД (`datetime('now')` — UTC без пояса, строка «ГГГГ-ММ-ДД ЧЧ:ММ:СС») → московское время."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("T", " ")).replace(tzinfo=timezone.utc).astimezone(MSK)
    except ValueError:
        return None


def _db_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def is_late(work_date: date, entered_at: datetime) -> bool:
    return entered_at > deadline_for(work_date)


def _parse_date(value: str, field: str = "Дата") -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field}: ожидается дата в формате ГГГГ-ММ-ДД")


# ------------------------------------------------------------------ ИНН и подрядчики

def clean_inn(value: Optional[str]) -> Optional[str]:
    """ИНН как внесён: без пробелов, пустое → None. Содержимое не проверяется — грузим как есть (решение 2026-10-09)."""
    value = "".join(str(value or "").split())
    return value or None


def inn_status(inn: Optional[str]) -> str:
    """ok — 10 цифр (юрлицо) или 12 (ИП, физлицо); none — ИНН не задан; unverified — «ИНН не проверен» (не цифры или другая длина)."""
    if not inn:
        return "none"
    if inn.isdigit() and len(inn) in (10, 12):
        return "ok"
    return "unverified"


def _clean_name(value: Optional[str]) -> Optional[str]:
    value = " ".join(str(value or "").split())
    return value or None


def find_counterparty_by_inn(conn: sqlite3.Connection, inn: Optional[str]) -> Optional[int]:
    """Контрагент по ИНН — только если он ОДИН: при двух с одним ИНН выбирать молча нельзя."""
    if not inn:
        return None
    rows = conn.execute("SELECT id FROM counterparties WHERE REPLACE(TRIM(COALESCE(inn, '')), ' ', '') = ?", (inn,)).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def _contractor_out(row: sqlite3.Row) -> dict:
    name = row["name_raw"] or row["counterparty_name"]
    inn = row["inn_raw"]
    status = inn_status(inn)
    if name and inn:
        display = f"{name} (ИНН {inn})"
    elif inn:
        display = f"ИНН {inn}"
    else:
        display = name or ""
    return {
        "id": row["id"], "object_id": row["object_id"], "name": row["name_raw"], "inn": inn,
        "counterparty_id": row["counterparty_id"], "counterparty_name": row["counterparty_name"],
        "display": display, "inn_status": status,
        "inn_note": "ИНН не проверен" if status == "unverified" else None,
        "records": row["records"],
    }


_CONTRACTOR_SELECT = (
    "SELECT c.*, COALESCE(cp.short_name, cp.full_name) AS counterparty_name, "
    "(SELECT COUNT(*) FROM headcount_records r WHERE r.contractor_id = c.id) AS records "
    "FROM headcount_contractors c LEFT JOIN counterparties cp ON cp.id = c.counterparty_id ")


def _contractor_row(conn, object_id: int, contractor_id: int) -> sqlite3.Row:
    row = conn.execute(_CONTRACTOR_SELECT + "WHERE c.id = ? AND c.object_id = ?", (contractor_id, object_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Подрядчик не найден на этом объекте")
    return row


class ContractorIn(BaseModel):
    name: Optional[str] = None
    inn: Optional[str] = None
    counterparty_id: Optional[int] = None


def _assert_inn_free(conn, object_id: int, inn: Optional[str], name: Optional[str], exclude_id: Optional[int] = None) -> None:
    """Подрядчик в пуле объекта уникален: по ИНН, а без ИНН — по названию (без учёта регистра, в Python — кириллицу SQLite не сравнивает)."""
    rows = conn.execute("SELECT id, name_raw, inn_raw FROM headcount_contractors WHERE object_id = ?", (object_id,)).fetchall()
    for r in rows:
        if r["id"] == exclude_id:
            continue
        if inn and r["inn_raw"] == inn:
            raise HTTPException(status_code=409, detail=f"Подрядчик с ИНН {inn} уже есть в списке объекта")
        if not inn and not r["inn_raw"] and name and r["name_raw"] and \
                " ".join(r["name_raw"].split()).lower() == name.lower():
            raise HTTPException(status_code=409, detail=f"Подрядчик «{name}» уже есть в списке объекта")


@router.get("/contractors")
def list_contractors(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(_CONTRACTOR_SELECT + "WHERE c.object_id = ?", (object_id,)).fetchall()
        items = sorted((_contractor_out(r) for r in rows), key=lambda x: (x["display"] or "").lower())
        return {"contractors": items}
    finally:
        conn.close()


@router.post("/contractors")
def create_contractor(object_id: int, body: ContractorIn, user: sqlite3.Row = Depends(get_current_user)):
    name, inn = _clean_name(body.name), clean_inn(body.inn)
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        counterparty_id = body.counterparty_id
        if counterparty_id is not None:
            cp = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
            if cp is None:
                raise HTTPException(status_code=404, detail="Контрагент не найден")
            inn = inn or clean_inn(cp["inn"])
            name = name or _clean_name(cp["short_name"] or cp["full_name"])
        if not name and not inn:
            raise HTTPException(status_code=400, detail="Укажите название или ИНН подрядчика")
        _assert_inn_free(conn, object_id, inn, name)
        if counterparty_id is None:
            counterparty_id = find_counterparty_by_inn(conn, inn)
        cur = conn.execute(
            "INSERT INTO headcount_contractors (object_id, counterparty_id, name_raw, inn_raw) VALUES (?, ?, ?, ?)",
            (object_id, counterparty_id, name, inn))
        conn.commit()
        out = _contractor_out(_contractor_row(conn, object_id, cur.lastrowid))
    finally:
        conn.close()
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, new_value=out["display"],
                 details={"действие": "добавлен", "подрядчик": out["id"]})
    return out


@router.patch("/contractors/{contractor_id}")
def update_contractor(object_id: int, contractor_id: int, body: ContractorIn, user: sqlite3.Row = Depends(get_current_user)):
    """Поля, которых нет в теле, не меняются; явный `null` у `counterparty_id` снимает связь с контрагентом. ИНН добавляют позже —
    при этом, если связь не задана, она подбирается по ИНН."""
    given = body.model_fields_set
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = _contractor_row(conn, object_id, contractor_id)
        name = _clean_name(body.name) if "name" in given else row["name_raw"]
        inn = clean_inn(body.inn) if "inn" in given else row["inn_raw"]
        counterparty_id = row["counterparty_id"]
        if "counterparty_id" in given:
            counterparty_id = body.counterparty_id
            if counterparty_id is not None and conn.execute(
                    "SELECT 1 FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Контрагент не найден")
        elif "inn" in given and counterparty_id is None:
            counterparty_id = find_counterparty_by_inn(conn, inn)
        if not name and not inn:
            raise HTTPException(status_code=400, detail="У подрядчика должно остаться название или ИНН")
        _assert_inn_free(conn, object_id, inn, name, exclude_id=contractor_id)
        conn.execute(
            "UPDATE headcount_contractors SET counterparty_id = ?, name_raw = ?, inn_raw = ?, updated_at = datetime('now') WHERE id = ?",
            (counterparty_id, name, inn, contractor_id))
        conn.commit()
        out = _contractor_out(_contractor_row(conn, object_id, contractor_id))
    finally:
        conn.close()
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, new_value=out["display"],
                 details={"действие": "изменён", "подрядчик": contractor_id})
    return out


@router.delete("/contractors/{contractor_id}")
def delete_contractor(object_id: int, contractor_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = _contractor_row(conn, object_id, contractor_id)
        if row["records"]:
            raise HTTPException(
                status_code=409,
                detail=f"У подрядчика есть внесённая численность (записей: {row['records']}) — удалить его нельзя")
        if conn.execute("SELECT 1 FROM headcount_history WHERE contractor_id = ? LIMIT 1", (contractor_id,)).fetchone():
            # история переживает удаление записей, а при удалении подрядчика она ушла бы вместе с ним (каскад)
            raise HTTPException(status_code=409, detail="По подрядчику есть история численности — удалить его нельзя")
        conn.execute("DELETE FROM headcount_contractors WHERE id = ?", (contractor_id,))
        conn.commit()
        display = _contractor_out(row)["display"]
    finally:
        conn.close()
    activity.log("headcount_contractor", user=user, entity_type="object", entity_id=object_id, old_value=display,
                 details={"действие": "удалён", "подрядчик": contractor_id})
    return {"deleted": contractor_id}


# ------------------------------------------------------------------ кодификатор (чтение)

@router.get("/codifier")
def list_codifier(object_id: int, user: sqlite3.Row = Depends(get_current_user)):
    """Действующие виды работ для выбора в форме: дерево собирает клиент по section_name → parent_name → name."""
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(
            "SELECT id, code, name, parent_name, section_name, unit FROM work_codifier WHERE retired_at IS NULL "
            "ORDER BY sort_order, code").fetchall()
        return {"works": [dict(r) for r in rows]}
    finally:
        conn.close()


# ------------------------------------------------------------------ ввод и день

class RowIn(BaseModel):
    contractor_id: int
    codifier_id: int
    workers: int


class SaveIn(BaseModel):
    date: str
    rows: list[RowIn] = Field(min_length=1, max_length=MAX_ROWS_PER_SAVE)


def _user_name(row: sqlite3.Row, prefix: str) -> Optional[str]:
    last, first = row[f"{prefix}_last"], row[f"{prefix}_first"]
    return " ".join(p for p in (last, first) if p) or None


_RECORD_SELECT = (
    "SELECT r.*, w.code AS work_code, w.name AS work_name, w.section_name, c.name_raw, c.inn_raw, "
    "COALESCE(cp.short_name, cp.full_name) AS counterparty_name, "
    "ue.last_name AS ue_last, ue.first_name AS ue_first, uu.last_name AS uu_last, uu.first_name AS uu_first, "
    "(SELECT COUNT(*) FROM headcount_history h WHERE h.object_id = r.object_id AND h.work_date = r.work_date "
    " AND h.contractor_id = r.contractor_id AND h.codifier_id = r.codifier_id) AS changes "
    "FROM headcount_records r JOIN work_codifier w ON w.id = r.codifier_id "
    "JOIN headcount_contractors c ON c.id = r.contractor_id "
    "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
    "LEFT JOIN users ue ON ue.id = r.entered_by LEFT JOIN users uu ON uu.id = r.updated_by ")


def _record_out(row: sqlite3.Row) -> dict:
    work_date = date.fromisoformat(row["work_date"])
    entered = _db_time(row["entered_at"])
    overdue_minutes = None
    if row["late"] and entered:
        overdue_minutes = max(1, int((entered - deadline_for(work_date)).total_seconds() // 60))
    contractor = _contractor_out_from_parts(row["name_raw"], row["counterparty_name"], row["inn_raw"])
    return {
        "id": row["id"], "date": row["work_date"], "contractor_id": row["contractor_id"], "contractor": contractor["display"],
        "inn_status": contractor["inn_status"], "codifier_id": row["codifier_id"], "work_code": row["work_code"],
        "work_name": row["work_name"], "section": row["section_name"], "workers": row["workers"],
        "late": bool(row["late"]), "overdue_minutes": overdue_minutes, "source": row["source"],
        "entered_at": row["entered_at"], "entered_by": _user_name(row, "ue"),
        "updated_at": row["updated_at"], "updated_by": _user_name(row, "uu"),
        "changes": max(0, row["changes"] - 1),   # первое внесение — тоже строка истории, «правок» меньше на одну
    }


def _contractor_out_from_parts(name_raw, counterparty_name, inn) -> dict:
    name = name_raw or counterparty_name
    status = inn_status(inn)
    display = f"{name} (ИНН {inn})" if name and inn else (f"ИНН {inn}" if inn else (name or ""))
    return {"display": display, "inn_status": status}


def _day_payload(conn, object_id: int, work_date: date) -> dict:
    rows = conn.execute(
        _RECORD_SELECT + "WHERE r.object_id = ? AND r.work_date = ? ORDER BY c.name_raw, c.inn_raw, w.code",
        (object_id, work_date.isoformat())).fetchall()
    items = [_record_out(r) for r in rows]
    due = deadline_for(work_date)
    return {
        "date": work_date.isoformat(), "deadline": due.isoformat(), "overdue_now": now_msk() > due,
        "rows": items, "total": sum(i["workers"] for i in items),
    }


@router.get("/day")
def get_day(object_id: int, day: str = Query(..., alias="date", description="День, ГГГГ-ММ-ДД"),
            user: sqlite3.Row = Depends(get_current_user)):
    work_date = _parse_date(day)
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        return _day_payload(conn, object_id, work_date)
    finally:
        conn.close()


@router.put("/records")
def save_records(object_id: int, body: SaveIn, user: sqlite3.Row = Depends(get_current_user)):
    """Внести или заменить численность за день пакетом. Атомарно: либо сохраняются все строки, либо ни одной."""
    work_date = _parse_date(body.date)
    now = now_msk()
    if work_date > now.date():
        raise HTTPException(status_code=400, detail="Численность за будущую дату внести нельзя")
    seen = set()
    for row in body.rows:
        if not 1 <= row.workers <= MAX_WORKERS:
            raise HTTPException(status_code=400, detail=f"Число рабочих — целое от 1 до {MAX_WORKERS}")
        key = (row.contractor_id, row.codifier_id)
        if key in seen:
            raise HTTPException(status_code=400, detail="Карточка содержит дубликат численности, сохранение невозможно")
        seen.add(key)
    iso = work_date.isoformat()
    late = 1 if is_late(work_date, now) else 0
    created = changed = unchanged = 0
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        contractors = {r["id"] for r in conn.execute(
            "SELECT id FROM headcount_contractors WHERE object_id = ?", (object_id,))}
        works = {r["id"]: r["retired_at"] for r in conn.execute("SELECT id, retired_at FROM work_codifier")}
        stamp = _db_now()
        for row in body.rows:
            if row.contractor_id not in contractors:
                raise HTTPException(status_code=400, detail="Подрядчик не относится к этому объекту")
            if row.codifier_id not in works:
                raise HTTPException(status_code=400, detail="Вид работ не найден в кодификаторе")
            current = conn.execute(
                "SELECT id, workers FROM headcount_records WHERE object_id = ? AND work_date = ? AND contractor_id = ? AND codifier_id = ?",
                (object_id, iso, row.contractor_id, row.codifier_id)).fetchone()
            if current is None:
                if works[row.codifier_id]:
                    raise HTTPException(status_code=400, detail="Вид работ выведен из действия: новую численность по нему не вносят")
                cur = conn.execute(
                    "INSERT INTO headcount_records (object_id, work_date, contractor_id, codifier_id, workers, late, source, "
                    "entered_at, entered_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'form', ?, ?, ?, ?)",
                    (object_id, iso, row.contractor_id, row.codifier_id, row.workers, late, stamp, user["id"], stamp, user["id"]))
                _history(conn, cur.lastrowid, object_id, iso, row.contractor_id, row.codifier_id, None, row.workers, "form", stamp, user["id"])
                created += 1
            elif current["workers"] == row.workers:
                unchanged += 1
            else:
                conn.execute("UPDATE headcount_records SET workers = ?, updated_at = ?, updated_by = ?, source = 'form' WHERE id = ?",
                             (row.workers, stamp, user["id"], current["id"]))
                _history(conn, current["id"], object_id, iso, row.contractor_id, row.codifier_id, current["workers"], row.workers, "form", stamp, user["id"])
                changed += 1
        conn.commit()
        payload = _day_payload(conn, object_id, work_date)
    finally:
        conn.close()
    if created or changed:
        activity.log("headcount_set", user=user, entity_type="object", entity_id=object_id, new_value=iso,
                     details={"добавлено": created, "изменено": changed, "без изменений": unchanged, "просрочено": bool(late)})
    return {"created": created, "changed": changed, "unchanged": unchanged, "late": bool(late), **payload}


def _history(conn, record_id, object_id, iso, contractor_id, codifier_id, old, new, source, stamp, user_id) -> None:
    conn.execute(
        "INSERT INTO headcount_history (record_id, object_id, work_date, contractor_id, codifier_id, old_workers, new_workers, "
        "source, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (record_id, object_id, iso, contractor_id, codifier_id, old, new, source, stamp, user_id))


@router.delete("/records/{record_id}")
def delete_record(object_id: int, record_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "write")
        begin_write(conn)
        row = conn.execute("SELECT * FROM headcount_records WHERE id = ? AND object_id = ?", (record_id, object_id)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Запись численности не найдена")
        _history(conn, record_id, object_id, row["work_date"], row["contractor_id"], row["codifier_id"], row["workers"], None, "form", _db_now(), user["id"])
        conn.execute("DELETE FROM headcount_records WHERE id = ?", (record_id,))
        conn.commit()
    finally:
        conn.close()
    activity.log("headcount_delete", user=user, entity_type="object", entity_id=object_id, old_value=str(row["workers"]),
                 details={"дата": row["work_date"], "подрядчик": row["contractor_id"], "вид работ": row["codifier_id"]})
    return {"deleted": record_id}


@router.get("/history")
def get_history(object_id: int, date_from: Optional[str] = None, date_to: Optional[str] = None,
                contractor_id: Optional[int] = None, codifier_id: Optional[int] = None,
                limit: int = Query(200, ge=1, le=1000), user: sqlite3.Row = Depends(get_current_user)):
    """Все значения по ключам, новые сверху: создание (было пусто), замены, удаления (стало пусто)."""
    where, params = ["h.object_id = ?"], [object_id]
    if date_from:
        where.append("h.work_date >= ?"); params.append(_parse_date(date_from, "Дата с").isoformat())
    if date_to:
        where.append("h.work_date <= ?"); params.append(_parse_date(date_to, "Дата по").isoformat())
    if contractor_id is not None:
        where.append("h.contractor_id = ?"); params.append(contractor_id)
    if codifier_id is not None:
        where.append("h.codifier_id = ?"); params.append(codifier_id)
    conn = get_connection()
    try:
        assert_object_feature(conn, user, object_id, FEATURE_KEY, "read")
        rows = conn.execute(
            "SELECT h.*, w.code AS work_code, w.name AS work_name, c.name_raw, c.inn_raw, "
            "COALESCE(cp.short_name, cp.full_name) AS counterparty_name, u.last_name AS u_last, u.first_name AS u_first "
            "FROM headcount_history h JOIN work_codifier w ON w.id = h.codifier_id "
            "JOIN headcount_contractors c ON c.id = h.contractor_id LEFT JOIN counterparties cp ON cp.id = c.counterparty_id "
            "LEFT JOIN users u ON u.id = h.changed_by WHERE " + " AND ".join(where) +
            " ORDER BY h.changed_at DESC, h.id DESC LIMIT ?", (*params, limit)).fetchall()
        return {"history": [{
            "id": r["id"], "date": r["work_date"], "contractor": _contractor_out_from_parts(
                r["name_raw"], r["counterparty_name"], r["inn_raw"])["display"],
            "work_code": r["work_code"], "work_name": r["work_name"], "old": r["old_workers"], "new": r["new_workers"],
            "source": r["source"], "changed_at": r["changed_at"], "changed_by": _user_name(r, "u"),
        } for r in rows]}
    finally:
        conn.close()


# ------------------------------------------------------------------ отчёт по факту

# уровень → (выражение ключа, выражение подписи). Подрядчики разных объектов с одним ИНН сводятся в одну строку.
_LEVELS = {
    "smu": ("COALESCE(CAST(o.smu_id AS TEXT), '')", "COALESCE(s.name, 'Без подразделения')"),
    "object": ("CAST(o.id AS TEXT)", "o.name"),
    "section": ("COALESCE(w.section_name, '')", "COALESCE(w.section_name, 'Без раздела')"),
    "work": ("CAST(w.id AS TEXT)", "w.name"),
    "contractor": ("COALESCE(c.inn_raw, 'name:' || c.name_raw)",
                   "COALESCE(c.name_raw, cp.short_name, cp.full_name, '') || CASE WHEN c.inn_raw IS NOT NULL "
                   "THEN ' (ИНН ' || c.inn_raw || ')' ELSE '' END"),
}


def _readable_object_ids(conn, user, wanted: Optional[list]) -> list:
    """Объекты, по которым у человека есть чтение численности (из запрошенных, если заданы)."""
    allowed = accessible_object_ids(conn, user)
    if wanted is None:
        ids = [r["id"] for r in conn.execute("SELECT id FROM objects")] if allowed is None else sorted(allowed)
    else:
        ids = [i for i in wanted if allowed is None or i in allowed]
    return [i for i in ids if has_feature(conn, user, FEATURE_KEY, "read", i)]


@global_router.get("/report")
def report(levels: str = Query("object", description="Уровни через запятую из: smu, object, section, work, contractor"),
           as_of: Optional[str] = Query(None, description="Опорный день (по умолчанию — вчера)"),
           date_from: Optional[str] = None, date_to: Optional[str] = None,
           object_ids: Optional[str] = Query(None, description="Объекты через запятую; по умолчанию все доступные"),
           smu_id: Optional[int] = None, section: Optional[str] = None, work_code: Optional[str] = Query(
               None, description="Код кодификатора или его начало (130 — весь раздел)"),
           contractor_inn: Optional[str] = None, user: sqlite3.Row = Depends(get_current_user)):
    """Факт численности: за опорный день, среднее за неделю (7 дней по опорный включительно), среднее за месяц опорного дня и, если заданы
    `date_from`/`date_to`, сумма человек-дней и среднее за период. Плана и отклонений нет (первый этап, решение 2026-10-09).
    Показатели складываются вверх по иерархии — см. докстроку модуля."""
    level_list = [x.strip() for x in levels.split(",") if x.strip()]
    if not level_list or any(x not in _LEVELS for x in level_list) or len(set(level_list)) != len(level_list):
        raise HTTPException(status_code=400, detail="levels: список без повторов из smu, object, section, work, contractor")
    ref = _parse_date(as_of, "Опорный день") if as_of else now_msk().date() - timedelta(days=1)
    week_from, month_from = ref - timedelta(days=6), ref.replace(day=1)
    p_from = _parse_date(date_from, "Дата с") if date_from else None
    p_to = _parse_date(date_to, "Дата по") if date_to else None
    wanted = None
    if object_ids:
        try:
            wanted = [int(x) for x in object_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="object_ids: список чисел через запятую")
    conn = get_connection()
    try:
        ids = _readable_object_ids(conn, user, wanted)
        if not ids:
            return _empty_report(level_list, ref)
        where, params = [f"r.object_id IN ({','.join('?' * len(ids))})"], list(ids)
        if smu_id is not None:
            where.append("o.smu_id = ?"); params.append(smu_id)
        if section:
            where.append("w.section_name = ?"); params.append(section)
        if work_code:
            where.append("w.code LIKE ? ESCAPE '\\'")
            params.append(work_code.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        if contractor_inn:
            where.append("c.inn_raw = ?"); params.append(clean_inn(contractor_inn))
        join = ("FROM headcount_records r JOIN objects o ON o.id = r.object_id LEFT JOIN smu_catalog s ON s.id = o.smu_id "
                "JOIN work_codifier w ON w.id = r.codifier_id JOIN headcount_contractors c ON c.id = r.contractor_id "
                "LEFT JOIN counterparties cp ON cp.id = c.counterparty_id WHERE " + " AND ".join(where))

        def days(start: date, end: date) -> int:
            return conn.execute("SELECT COUNT(DISTINCT r.work_date) " + join + " AND r.work_date BETWEEN ? AND ?",
                                (*params, start.isoformat(), end.isoformat())).fetchone()[0]

        week_days, month_days = days(week_from, ref), days(month_from, ref)
        period_days = days(p_from, p_to) if p_from and p_to else 0
        keys = ", ".join(f"{_LEVELS[x][0]} AS k_{x}, {_LEVELS[x][1]} AS l_{x}" for x in level_list)
        group = ", ".join(f"k_{x}" for x in level_list)
        extra = ""
        if p_from and p_to:
            extra = ", COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN r.workers END), 0) AS period_sum"
        sql = (f"SELECT {keys}, COALESCE(SUM(CASE WHEN r.work_date = ? THEN r.workers END), 0) AS fact_day, "
               "COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN r.workers END), 0) AS week_sum, "
               "COALESCE(SUM(CASE WHEN r.work_date BETWEEN ? AND ? THEN r.workers END), 0) AS month_sum"
               f"{extra} {join} GROUP BY {group} ORDER BY {', '.join(f'l_{x}' for x in level_list)}")
        sql_params = [ref.isoformat(), week_from.isoformat(), ref.isoformat(), month_from.isoformat(), ref.isoformat()]
        if extra:
            sql_params += [p_from.isoformat(), p_to.isoformat()]
        rows = conn.execute(sql, (*sql_params, *params)).fetchall()

        out_rows = []
        for r in rows:
            if not (r["fact_day"] or r["week_sum"] or r["month_sum"] or (extra and r["period_sum"])):
                continue   # строка есть в группировке, а в окнах показателей пуста — не показываем
            item = {x: {"key": r[f"k_{x}"], "label": r[f"l_{x}"]} for x in level_list}
            item["fact_day"] = r["fact_day"]
            item["week_avg"] = round(r["week_sum"] / week_days, 1) if week_days else 0
            item["month_avg"] = round(r["month_sum"] / month_days, 1) if month_days else 0
            if extra:
                item["period_sum"] = r["period_sum"]
                item["period_avg"] = round(r["period_sum"] / period_days, 1) if period_days else 0
            out_rows.append(item)
        # итог — из СУММ, а не из округлённых строк: иначе он расходился бы с суммой показанных значений на десятые
        week_sum, month_sum = sum(r["week_sum"] for r in rows), sum(r["month_sum"] for r in rows)
        total = {"fact_day": sum(i["fact_day"] for i in out_rows),
                 "week_avg": round(week_sum / week_days, 1) if week_days else 0,
                 "month_avg": round(month_sum / month_days, 1) if month_days else 0}
        if extra:
            total["period_sum"] = sum(i["period_sum"] for i in out_rows)
            total["period_avg"] = round(total["period_sum"] / period_days, 1) if period_days else 0

        year_from = (p_from or ref.replace(month=1, day=1)).replace(day=1)
        month_rows = conn.execute(
            "SELECT substr(r.work_date, 1, 7) AS m, SUM(r.workers) AS s, COUNT(DISTINCT r.work_date) AS d " + join +
            " AND r.work_date >= ? AND r.work_date <= ? GROUP BY m ORDER BY m",
            (*params, year_from.isoformat(), (p_to or ref).isoformat())).fetchall()
        months = [{"month": m["m"], "avg": round(m["s"] / m["d"], 1) if m["d"] else 0, "days": m["d"]} for m in month_rows]
        return {"levels": level_list, "as_of": ref.isoformat(), "week_from": week_from.isoformat(), "month_from": month_from.isoformat(),
                "week_days": week_days, "month_days": month_days, "period_days": period_days, "rows": out_rows,
                "total": total, "months": months, "objects": len(ids)}
    finally:
        conn.close()


def _empty_report(level_list: list, ref: date) -> dict:
    return {"levels": level_list, "as_of": ref.isoformat(), "rows": [], "total": {"fact_day": 0, "week_avg": 0, "month_avg": 0},
            "months": [], "objects": 0}
