"""
Контракты: поставщик x несколько строк "тип элемента + количество"
(Docs/backlog.md, третий раунд, п.8 — переход от одной строки на контракт
к нормальной структуре контракт+строки, было: раунд 2, п.9). Контракты не
привязаны к source_file — контракт на поставку колонн действует в рамках
всего проекта, не одного чертежа.

"Факт" по строке контракта — количество элементов с этим contract_id, этим
element_type и статусом НЕ "planned". Привязка элемента к контракту хранится
в каждой записи status_history (не напрямую у элемента, см. п.7 третьего
раунда — поле у элемента стало только для чтения) — elements.contract_id
остаётся денормализованным кэшем "текущего" контракта (= contract_id самой
последней по changed_at записи истории), пересчитывается бэкендом при
каждом добавлении/удалении записи истории, никогда не устанавливается
напрямую через отдельный API-эндпоинт.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user, require_admin
from app.batches import clear_stale_batch_assignment, enrich_element_row
from app.db import get_connection

router = APIRouter(prefix="/contracts", tags=["contracts"])


class ContractLineIn(BaseModel):
    element_type: str
    quantity: int


class ContractLineOut(ContractLineIn):
    id: int
    fact: int
    damaged: int
    remaining: int
    exceeded: bool


# Инцидент повреждения элементов на стройке — только количество (тип +
# число), без привязки к конкретным elements.id и без отдельного статуса
# подтверждения (см. Docs/backlog.md, "Учёт повреждённых элементов...").
class ContractIncidentIn(BaseModel):
    element_type: str
    quantity: int
    incident_date: str
    description: Optional[str] = None


class ContractIncidentOut(ContractIncidentIn):
    id: int


class ContractIn(BaseModel):
    name: str
    supplier: str
    # Дата подписания контракта (бизнес-дата, не created_at) и короткий
    # код контрагента — оба нужны для формулы метки партии/допстроки
    # подписи на схеме, см. Docs/backlog.md, "Партия — учёт по маркам".
    contract_date: Optional[str] = None
    code: Optional[str] = None
    lines: list[ContractLineIn]
    incidents: list[ContractIncidentIn] = []


class ContractOut(BaseModel):
    id: int
    name: str
    supplier: str
    contract_date: Optional[str] = None
    code: Optional[str] = None
    lines: list[ContractLineOut]
    incidents: list[ContractIncidentOut]


def _line_fact(conn, contract_id: int, element_type: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) as n FROM elements "
        "WHERE contract_id = ? AND element_type = ? AND current_status != 'planned'",
        (contract_id, element_type),
    ).fetchone()
    return row["n"]


def _line_damaged(conn, contract_id: int, element_type: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(quantity), 0) as n FROM contract_incidents WHERE contract_id = ? AND element_type = ?",
        (contract_id, element_type),
    ).fetchone()
    return row["n"]


def _to_contract_out(conn, contract_row) -> ContractOut:
    line_rows = conn.execute(
        "SELECT * FROM contract_lines WHERE contract_id = ? ORDER BY element_type", (contract_row["id"],)
    ).fetchall()
    lines = []
    for lr in line_rows:
        fact = _line_fact(conn, contract_row["id"], lr["element_type"])
        damaged = _line_damaged(conn, contract_row["id"], lr["element_type"])
        lines.append(
            ContractLineOut(
                id=lr["id"], element_type=lr["element_type"], quantity=lr["quantity"],
                fact=fact, damaged=damaged, remaining=lr["quantity"] - fact - damaged,
                exceeded=(fact + damaged) > lr["quantity"],
            )
        )
    incident_rows = conn.execute(
        "SELECT * FROM contract_incidents WHERE contract_id = ? ORDER BY incident_date DESC, id DESC",
        (contract_row["id"],),
    ).fetchall()
    incidents = [
        ContractIncidentOut(
            id=ir["id"], element_type=ir["element_type"], quantity=ir["quantity"],
            incident_date=ir["incident_date"], description=ir["description"],
        )
        for ir in incident_rows
    ]
    return ContractOut(
        id=contract_row["id"], name=contract_row["name"], supplier=contract_row["supplier"],
        contract_date=contract_row["contract_date"], code=contract_row["code"],
        lines=lines, incidents=incidents,
    )


@router.get("", response_model=list[ContractOut])
def list_contracts(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM contracts ORDER BY name, supplier").fetchall()
        return [_to_contract_out(conn, r) for r in rows]
    finally:
        conn.close()


@router.post("", response_model=ContractOut)
def create_contract(body: ContractIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO contracts (name, supplier, contract_date, code) VALUES (?, ?, ?, ?)",
            (body.name, body.supplier, body.contract_date, body.code),
        )
        contract_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        for line in body.lines:
            conn.execute(
                "INSERT INTO contract_lines (contract_id, element_type, quantity) VALUES (?, ?, ?)",
                (contract_id, line.element_type, line.quantity),
            )
        for inc in body.incidents:
            conn.execute(
                "INSERT INTO contract_incidents (contract_id, element_type, quantity, incident_date, description) "
                "VALUES (?, ?, ?, ?, ?)",
                (contract_id, inc.element_type, inc.quantity, inc.incident_date, inc.description),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        return _to_contract_out(conn, row)
    finally:
        conn.close()


@router.patch("/{contract_id}", response_model=ContractOut)
def update_contract(contract_id: int, body: ContractIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Контракт не найден")
        conn.execute(
            "UPDATE contracts SET name=?, supplier=?, contract_date=?, code=?, updated_at=datetime('now') WHERE id=?",
            (body.name, body.supplier, body.contract_date, body.code, contract_id),
        )
        # Полная замена строк/инцидентов — список редактируется в UI
        # целиком, проще и предсказуемее частичного патча по id строки.
        conn.execute("DELETE FROM contract_lines WHERE contract_id = ?", (contract_id,))
        for line in body.lines:
            conn.execute(
                "INSERT INTO contract_lines (contract_id, element_type, quantity) VALUES (?, ?, ?)",
                (contract_id, line.element_type, line.quantity),
            )
        conn.execute("DELETE FROM contract_incidents WHERE contract_id = ?", (contract_id,))
        for inc in body.incidents:
            conn.execute(
                "INSERT INTO contract_incidents (contract_id, element_type, quantity, incident_date, description) "
                "VALUES (?, ?, ?, ?, ?)",
                (contract_id, inc.element_type, inc.quantity, inc.incident_date, inc.description),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM contracts WHERE id = ?", (contract_id,)).fetchone()
        return _to_contract_out(conn, row)
    finally:
        conn.close()


@router.get("/default-map")
def get_default_contracts(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT element_type, contract_id FROM default_contracts").fetchall()
        return {r["element_type"]: r["contract_id"] for r in rows}
    finally:
        conn.close()


@router.put("/default-map")
def set_default_contracts(mapping: dict, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        for element_type, contract_id in mapping.items():
            conn.execute(
                "INSERT INTO default_contracts (element_type, contract_id) VALUES (?, ?) "
                "ON CONFLICT(element_type) DO UPDATE SET contract_id = excluded.contract_id",
                (element_type, contract_id),
            )
        conn.commit()
        rows = conn.execute("SELECT element_type, contract_id FROM default_contracts").fetchall()
        return {r["element_type"]: r["contract_id"] for r in rows}
    finally:
        conn.close()


def resolve_contract_for_new_row(
    conn, element_id: int, explicit: bool, value: Optional[int]
) -> Optional[int]:
    """
    Контракт для НОВОЙ записи status_history. Если пользователь явно выбрал
    значение в диалоге подтверждения (`explicit=True` — поле было в теле
    запроса, даже если это null для "без контракта"), используется оно.
    Иначе — наследуется от самой свежей ПРЕДЫДУЩЕЙ записи истории этого
    элемента, где contract_id не пуст (п.2 третьего раунда: "все следующие
    статусы после контрактации берут контракт из предыдущего статуса").
    """
    if explicit:
        return value
    prev = conn.execute(
        "SELECT contract_id FROM status_history WHERE element_id = ? AND contract_id IS NOT NULL "
        "ORDER BY changed_at DESC, id DESC LIMIT 1",
        (element_id,),
    ).fetchone()
    return prev["contract_id"] if prev else None


def recompute_element_contract_cache(conn, element_id: int) -> Optional[int]:
    """
    elements.contract_id — денормализованный кэш "текущего" контракта,
    всегда равный contract_id самой поздней по changed_at записи истории
    (та же логика пересчёта, что уже используется для current_status —
    важно для корректной работы после backdating и удаления записей, п.3).
    """
    latest = conn.execute(
        "SELECT contract_id FROM status_history WHERE element_id = ? ORDER BY changed_at DESC, id DESC LIMIT 1",
        (element_id,),
    ).fetchone()
    contract_id = latest["contract_id"] if latest else None
    conn.execute("UPDATE elements SET contract_id = ? WHERE id = ?", (contract_id, element_id))
    return contract_id


def apply_status_change(
    conn, element_id: int, status: str, contract_explicit: bool, contract_value: Optional[int],
    changed_at: Optional[str], comment: Optional[str], changed_by: str, changed_by_user_id: int,
) -> dict:
    """
    Общее тело смены статуса ОДНОГО элемента — INSERT в status_history ->
    пересчёт current_status (по самой поздней записи, не обязательно
    только что вставленной, важно для backdating) -> пересчёт кэша
    elements.contract_id -> contract_line_warning. НЕ коммитит сама —
    вызывающая сторона решает, когда коммитить (одиночный PATCH — сразу
    после вызова; массовая смена статуса — один раз после цикла по всем
    элементам, см. update_status_bulk в app/main.py). Используется и
    одиночным, и массовым эндпоинтом — не дублировать эту
    последовательность действий в другом месте.

    contract_explicit/contract_value — та же пара, что раньше собиралась
    вручную в app/main.py через body.model_fields_set (см.
    resolve_contract_for_new_row выше) — для массовой смены статуса
    contract_explicit всегда True (фронт гарантирует явный выбор в
    каждой строке таблицы, см. Docs/backlog.md).
    """
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    if row is None:
        raise LookupError(f"Элемент {element_id} не найден")

    row_contract_id = resolve_contract_for_new_row(conn, element_id, contract_explicit, contract_value)

    if changed_at:
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_at, changed_by, changed_by_user_id, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (element_id, status, changed_at, changed_by, changed_by_user_id, comment, row_contract_id),
        )
    else:
        conn.execute(
            "INSERT INTO status_history (element_id, status, changed_by, changed_by_user_id, comment, contract_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (element_id, status, changed_by, changed_by_user_id, comment, row_contract_id),
        )

    latest = conn.execute(
        "SELECT status FROM status_history WHERE element_id = ? ORDER BY changed_at DESC LIMIT 1",
        (element_id,),
    ).fetchone()
    effective_status = latest["status"]
    conn.execute(
        "UPDATE elements SET current_status = ?, updated_at = datetime('now') WHERE id = ?",
        (effective_status, element_id),
    )

    element_contract_id = recompute_element_contract_cache(conn, element_id)
    # Контракт мог смениться (или пропасть) — партия чужого контракта не
    # должна молча остаться привязанной к элементу, см. app/batches.py.
    clear_stale_batch_assignment(conn, element_id, element_contract_id)
    warning = contract_line_warning(conn, element_contract_id, row["element_type"])

    updated_row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    history_rows = conn.execute(
        "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at", (element_id,)
    ).fetchall()
    data = dict(updated_row)
    data["history"] = [dict(h) for h in history_rows]
    data["contract_warning"] = warning
    enrich_element_row(conn, data)
    return data


def contract_line_warning(conn, contract_id: Optional[int], element_type: str) -> Optional[dict]:
    """Неблокирующее предупреждение о превышении по СТРОКЕ контракта (не по
    контракту в целом) — факт плюс подтверждённые повреждения (см.
    Docs/backlog.md, "Учёт повреждённых элементов...") против плана."""
    if contract_id is None:
        return None
    line = conn.execute(
        "SELECT * FROM contract_lines WHERE contract_id = ? AND element_type = ?",
        (contract_id, element_type),
    ).fetchone()
    if not line:
        return None
    fact = _line_fact(conn, contract_id, element_type)
    damaged = _line_damaged(conn, contract_id, element_type)
    if (fact + damaged) <= line["quantity"]:
        return None
    contract_row = conn.execute("SELECT name FROM contracts WHERE id = ?", (contract_id,)).fetchone()
    return {
        "contract_id": contract_id,
        "contract_name": contract_row["name"] if contract_row else "?",
        "quantity": line["quantity"],
        "fact": fact,
        "damaged": damaged,
    }
