"""
Партия — конкретная поставка в рамках контракта: плановая дата + разбивка
по маркам (тип+подтип+марка -> количество), см. Docs/backlog.md, "Партия —
учёт по маркам внутри контракта". В отличие от contract_lines
(app/contracts.py, план по ТИПУ на весь контракт), batch_lines детализируют
план до марки и относятся к одной конкретной партии.

Назначение элемента на партию (elements.batch_id) — простое живое поле,
БЕЗ версионирования по status_history (в отличие от elements.contract_id) —
назначение партии не привязано к смене статуса, это независимое действие.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_user, require_admin
from app.db import get_connection

router = APIRouter(prefix="/batches", tags=["batches"])


class BatchLineIn(BaseModel):
    element_type: str
    subtype: Optional[str] = None
    mark: Optional[str] = None
    quantity: int


class BatchLineOut(BatchLineIn):
    id: int
    fact: int
    remaining: int
    exceeded: bool


class BatchIn(BaseModel):
    contract_id: int
    planned_date: str
    lines: list[BatchLineIn]


# БЕЗ contract_id — партию нельзя молча "перепривязать" к другому
# контракту через случайно присланное поле в PATCH.
class BatchUpdateIn(BaseModel):
    planned_date: str
    lines: list[BatchLineIn]


class BatchOut(BaseModel):
    id: int
    contract_id: int
    planned_date: str
    label: str
    lines: list[BatchLineOut]


def _batch_line_fact(conn, batch_id: int, element_type: str, subtype: Optional[str], mark: Optional[str]) -> int:
    """Сколько элементов реально назначено на партию под эту марку. Без
    фильтра по статусу (в отличие от ContractLineOut.fact) — само
    назначение на партию УЖЕ есть факт, отдельного "статуса партии" нет."""
    row = conn.execute(
        "SELECT COUNT(*) as n FROM elements "
        "WHERE batch_id = ? AND element_type = ? AND subtype IS ? AND mark IS ?",
        (batch_id, element_type, subtype, mark),
    ).fetchone()
    return row["n"]


def compose_batch_label(contract_row, planned_date: str) -> str:
    """Метка партии по маске «Контрагент. Номер и дата контракта. Дата» —
    единственный источник форматирования (не дублируется на фронтенде).
    contract_date может быть NULL у старых контрактов — часть «от …»
    тогда просто опускается."""
    supplier = contract_row["supplier"]
    name = contract_row["name"]
    contract_date = contract_row["contract_date"]
    contract_part = f"{name} от {contract_date}" if contract_date else name
    return f"{supplier}. {contract_part}. {planned_date}"


def find_matching_batch_line(conn, batch_id: int, element_type: str, subtype: Optional[str], mark: Optional[str]):
    """NULL-safe поиск строки партии под конкретный элемент. None —
    жёсткий отказ (несовпадение марки) — вызывающая сторона решает, что
    с этим делать (см. validate_and_resolve_batch_assignment)."""
    return conn.execute(
        "SELECT * FROM batch_lines WHERE batch_id = ? AND element_type = ? AND subtype IS ? AND mark IS ?",
        (batch_id, element_type, subtype, mark),
    ).fetchone()


def batch_line_warning(conn, batch_id: int, element_type: str, subtype: Optional[str], mark: Optional[str]) -> Optional[dict]:
    """Неблокирующее предупреждение о превышении по СТРОКЕ партии —
    та же форма, что contract_line_warning, но в разрезе марки."""
    line = find_matching_batch_line(conn, batch_id, element_type, subtype, mark)
    if not line:
        return None
    fact = _batch_line_fact(conn, batch_id, element_type, subtype, mark)
    if fact <= line["quantity"]:
        return None
    batch_row = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    contract_row = conn.execute("SELECT * FROM contracts WHERE id = ?", (batch_row["contract_id"],)).fetchone()
    label = compose_batch_label(contract_row, batch_row["planned_date"]) if contract_row else f"#{batch_id}"
    return {
        "batch_id": batch_id,
        "batch_label": label,
        "element_type": element_type,
        "subtype": subtype,
        "mark": mark,
        "quantity": line["quantity"],
        "fact": fact,
    }


def validate_and_resolve_batch_assignment(conn, element_row, batch_id: Optional[int]) -> None:
    """Общая точка валидации для одиночного и массового назначения партии
    (как apply_status_change — единая точка для контракта). Бросает
    ValueError с человекочитаемым сообщением при отказе (вызывающая
    сторона в app/main.py превращает его в 400). batch_id=None (снять
    партию) валидации не требует — снять партию можно всегда."""
    if batch_id is None:
        return
    if element_row["contract_id"] is None:
        raise ValueError(f"Элемент {element_row['id']}: нельзя назначить партию — у элемента нет контракта")
    batch_row = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    if batch_row is None:
        raise ValueError(f"Партия {batch_id} не найдена")
    if batch_row["contract_id"] != element_row["contract_id"]:
        raise ValueError(f"Элемент {element_row['id']}: партия {batch_id} принадлежит другому контракту")
    line = find_matching_batch_line(
        conn, batch_id, element_row["element_type"], element_row["subtype"], element_row["mark"]
    )
    if line is None:
        raise ValueError(
            f"Элемент {element_row['id']}: в партии {batch_id} нет строки для "
            f"{element_row['element_type']}/{element_row['subtype'] or '—'}/{element_row['mark'] or '—'}"
        )


def clear_stale_batch_assignment(conn, element_id: int, new_contract_id: Optional[int]) -> None:
    """Если у элемента сейчас есть batch_id, а партия принадлежит НЕ
    new_contract_id — сбросить batch_id в NULL. Иначе смена контракта
    могла бы молча оставить элемент "привязанным" к партии чужого
    контракта. Вызывается сразу после recompute_element_contract_cache."""
    row = conn.execute("SELECT batch_id FROM elements WHERE id = ?", (element_id,)).fetchone()
    if row is None or row["batch_id"] is None:
        return
    batch_row = conn.execute("SELECT contract_id FROM batches WHERE id = ?", (row["batch_id"],)).fetchone()
    if batch_row is None or batch_row["contract_id"] != new_contract_id:
        conn.execute("UPDATE elements SET batch_id = NULL WHERE id = ?", (element_id,))


def enrich_element_row(conn, row_dict: dict) -> dict:
    """Добавляет contract_code/batch_planned_date (денормализованные
    скаляры для допстроки подписи на схеме) в уже собранный словарь
    ответа элемента — используется везде, где элемент возвращается
    клиенту (apply_status_change, батч-эндпоинты, GET /elements/{id}),
    не только в /plan-data."""
    contract_id = row_dict.get("contract_id")
    batch_id = row_dict.get("batch_id")
    row_dict["contract_code"] = None
    row_dict["batch_planned_date"] = None
    if contract_id is not None:
        c = conn.execute("SELECT code FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        row_dict["contract_code"] = c["code"] if c else None
    if batch_id is not None:
        b = conn.execute("SELECT planned_date FROM batches WHERE id = ?", (batch_id,)).fetchone()
        row_dict["batch_planned_date"] = b["planned_date"] if b else None
    return row_dict


def _to_batch_out(conn, batch_row) -> BatchOut:
    contract_row = conn.execute("SELECT * FROM contracts WHERE id = ?", (batch_row["contract_id"],)).fetchone()
    label = compose_batch_label(contract_row, batch_row["planned_date"]) if contract_row else f"#{batch_row['id']}"
    line_rows = conn.execute(
        "SELECT * FROM batch_lines WHERE batch_id = ? ORDER BY element_type, subtype, mark", (batch_row["id"],)
    ).fetchall()
    lines = []
    for lr in line_rows:
        fact = _batch_line_fact(conn, batch_row["id"], lr["element_type"], lr["subtype"], lr["mark"])
        lines.append(
            BatchLineOut(
                id=lr["id"], element_type=lr["element_type"], subtype=lr["subtype"], mark=lr["mark"],
                quantity=lr["quantity"], fact=fact, remaining=lr["quantity"] - fact, exceeded=fact > lr["quantity"],
            )
        )
    return BatchOut(id=batch_row["id"], contract_id=batch_row["contract_id"], planned_date=batch_row["planned_date"], label=label, lines=lines)


@router.get("", response_model=list[BatchOut])
def list_batches(contract_id: int = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM batches WHERE contract_id = ? ORDER BY planned_date, id", (contract_id,)
        ).fetchall()
        return [_to_batch_out(conn, r) for r in rows]
    finally:
        conn.close()


@router.post("", response_model=BatchOut)
def create_batch(body: BatchIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        contract = conn.execute("SELECT id FROM contracts WHERE id = ?", (body.contract_id,)).fetchone()
        if not contract:
            raise HTTPException(status_code=404, detail="Контракт не найден")
        conn.execute(
            "INSERT INTO batches (contract_id, planned_date) VALUES (?, ?)", (body.contract_id, body.planned_date)
        )
        batch_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        try:
            for line in body.lines:
                conn.execute(
                    "INSERT INTO batch_lines (batch_id, element_type, subtype, mark, quantity) VALUES (?, ?, ?, ?, ?)",
                    (batch_id, line.element_type, line.subtype, line.mark, line.quantity),
                )
        except sqlite3.IntegrityError:
            conn.rollback()
            raise HTTPException(status_code=400, detail="Повторяющаяся строка партии (тип/подтип/марка) в одном запросе")
        conn.commit()
        row = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        return _to_batch_out(conn, row)
    finally:
        conn.close()


@router.get("/{batch_id}", response_model=BatchOut)
def get_batch(batch_id: int, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Партия не найдена")
        return _to_batch_out(conn, row)
    finally:
        conn.close()


@router.patch("/{batch_id}", response_model=BatchOut)
def update_batch(batch_id: int, body: BatchUpdateIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Партия не найдена")
        conn.execute(
            "UPDATE batches SET planned_date=?, updated_at=datetime('now') WHERE id=?",
            (body.planned_date, batch_id),
        )
        # Полная замена строк — тот же приём, что у contract_lines.
        conn.execute("DELETE FROM batch_lines WHERE batch_id = ?", (batch_id,))
        try:
            for line in body.lines:
                conn.execute(
                    "INSERT INTO batch_lines (batch_id, element_type, subtype, mark, quantity) VALUES (?, ?, ?, ?, ?)",
                    (batch_id, line.element_type, line.subtype, line.mark, line.quantity),
                )
        except sqlite3.IntegrityError:
            conn.rollback()
            raise HTTPException(status_code=400, detail="Повторяющаяся строка партии (тип/подтип/марка) в одном запросе")
        conn.commit()
        row = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        return _to_batch_out(conn, row)
    finally:
        conn.close()


@router.delete("/{batch_id}")
def delete_batch(batch_id: int, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Партия не найдена")
        # elements.batch_id -> ON DELETE SET NULL снимает привязку сам
        # (см. app/db.py _COLUMN_MIGRATIONS), batch_lines -> ON DELETE CASCADE.
        conn.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
        conn.commit()
        return {"status": "ok"}
    finally:
        conn.close()
