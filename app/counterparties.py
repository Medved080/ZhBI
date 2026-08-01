"""
Контрагенты -> Договоры -> Спецификации — юридическая иерархия, к которой
привязывается Контракт (app/contracts.py, поле specification_id). Заменяет
старое свободнотекстовое contracts.supplier (см. Docs/backlog.md,
"Контрактация 2.0").

Плюс справочник mark_type_prefixes — эвристика "префикс марки -> тип
элемента", донастраиваемая администратором, используется импортом файла
контрактации (app/contracting_import.py) для позиций, чья марка ещё не
встречается ни у одного загруженного элемента.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.access import require_system_admin
from app.auth import get_current_user, require_admin
from app.db import get_connection

router = APIRouter(tags=["counterparties"])


class CounterpartyIn(BaseModel):
    full_name: str
    short_name: str
    inn: Optional[str] = None
    kpp: Optional[str] = None
    ogrn: Optional[str] = None
    legal_address: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    code: Optional[str] = None


class CounterpartyOut(CounterpartyIn):
    id: int


class AgreementIn(BaseModel):
    counterparty_id: int
    number: str
    agreement_date: Optional[str] = None


class AgreementOut(AgreementIn):
    id: int


class SpecificationIn(BaseModel):
    agreement_id: int
    number: str
    specification_date: Optional[str] = None


class SpecificationOut(SpecificationIn):
    id: int


class MarkTypePrefixIn(BaseModel):
    prefix: str
    element_type: str


# --- find-or-create — переиспользуются и роутером ниже, и импортёром
# файла контрактации (app/contracting_import.py). ---


def _generate_counterparty_code(conn, short_name: str) -> str:
    """Короткий код для допстроки подписи на схеме — по умолчанию первое
    слово краткого наименования, до 6 символов, верхний регистр; при
    коллизии добавляется числовой суффикс. Администратор может поменять
    вручную после создания (справочник Контрагенты)."""
    base = (short_name.split()[0] if short_name.split() else short_name).upper()[:6]
    base = base or "К"
    candidate = base
    n = 2
    existing = {r["code"] for r in conn.execute("SELECT code FROM counterparties WHERE code IS NOT NULL")}
    while candidate in existing:
        candidate = f"{base}{n}"
        n += 1
    return candidate


def find_or_create_counterparty(
    conn,
    full_name: str,
    short_name: str,
    inn: Optional[str] = None,
    kpp: Optional[str] = None,
    ogrn: Optional[str] = None,
    legal_address: Optional[str] = None,
    contact_person: Optional[str] = None,
    contact_phone: Optional[str] = None,
    code: Optional[str] = None,
) -> int:
    """Ключ поиска: по ИНН, если указан (устойчивее к разночтениям в
    названии), иначе — точное совпадение short_name."""
    if inn:
        row = conn.execute("SELECT id FROM counterparties WHERE inn = ?", (inn,)).fetchone()
        if row:
            return row["id"]
    else:
        row = conn.execute(
            "SELECT id FROM counterparties WHERE short_name = ?", (short_name,)
        ).fetchone()
        if row:
            return row["id"]

    resolved_code = code or _generate_counterparty_code(conn, short_name)
    conn.execute(
        "INSERT INTO counterparties "
        "(full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, code) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, resolved_code),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def find_or_create_agreement(conn, counterparty_id: int, number: str, agreement_date: Optional[str] = None) -> int:
    row = conn.execute(
        "SELECT id FROM agreements WHERE counterparty_id = ? AND number = ?", (counterparty_id, number)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT INTO agreements (counterparty_id, number, agreement_date) VALUES (?, ?, ?)",
        (counterparty_id, number, agreement_date),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def find_or_create_specification(conn, agreement_id: int, number: str, specification_date: Optional[str] = None) -> int:
    row = conn.execute(
        "SELECT id FROM specifications WHERE agreement_id = ? AND number = ?", (agreement_id, number)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute(
        "INSERT INTO specifications (agreement_id, number, specification_date) VALUES (?, ?, ?)",
        (agreement_id, number, specification_date),
    )
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


# --- Контрагенты ---


@router.get("/counterparties", response_model=list[CounterpartyOut])
def list_counterparties(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM counterparties ORDER BY short_name").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/counterparties/full")
def list_counterparties_full(user: sqlite3.Row = Depends(get_current_user)):
    """Вложенное дерево Контрагент -> Договоры -> Спецификации одним
    запросом — для каскадных селектов в форме контракта."""
    conn = get_connection()
    try:
        counterparties = [dict(r) for r in conn.execute("SELECT * FROM counterparties ORDER BY short_name")]
        agreements = [dict(r) for r in conn.execute("SELECT * FROM agreements ORDER BY number")]
        specifications = [dict(r) for r in conn.execute("SELECT * FROM specifications ORDER BY number")]

        specs_by_agreement: dict[int, list] = {}
        for s in specifications:
            specs_by_agreement.setdefault(s["agreement_id"], []).append(s)
        agreements_by_counterparty: dict[int, list] = {}
        for a in agreements:
            a["specifications"] = specs_by_agreement.get(a["id"], [])
            agreements_by_counterparty.setdefault(a["counterparty_id"], []).append(a)
        for c in counterparties:
            c["agreements"] = agreements_by_counterparty.get(c["id"], [])
        return counterparties
    finally:
        conn.close()


@router.post("/counterparties", response_model=CounterpartyOut)
def create_counterparty(body: CounterpartyIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        code = body.code or _generate_counterparty_code(conn, body.short_name)
        conn.execute(
            "INSERT INTO counterparties "
            "(full_name, short_name, inn, kpp, ogrn, legal_address, contact_person, contact_phone, code) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.full_name, body.short_name, body.inn, body.kpp, body.ogrn,
                body.legal_address, body.contact_person, body.contact_phone, code,
            ),
        )
        counterparty_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
        row = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.patch("/counterparties/{counterparty_id}", response_model=CounterpartyOut)
def update_counterparty(counterparty_id: int, body: CounterpartyIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Контрагент не найден")
        conn.execute(
            "UPDATE counterparties SET full_name=?, short_name=?, inn=?, kpp=?, ogrn=?, legal_address=?, "
            "contact_person=?, contact_phone=?, code=?, updated_at=datetime('now') WHERE id=?",
            (
                body.full_name, body.short_name, body.inn, body.kpp, body.ogrn,
                body.legal_address, body.contact_person, body.contact_phone, body.code, counterparty_id,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM counterparties WHERE id = ?", (counterparty_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


# --- Договоры ---


@router.get("/agreements", response_model=list[AgreementOut])
def list_agreements(counterparty_id: int = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM agreements WHERE counterparty_id = ? ORDER BY number", (counterparty_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/agreements", response_model=AgreementOut)
def create_agreement(body: AgreementIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        counterparty = conn.execute(
            "SELECT id FROM counterparties WHERE id = ?", (body.counterparty_id,)
        ).fetchone()
        if not counterparty:
            raise HTTPException(status_code=404, detail="Контрагент не найден")
        try:
            agreement_id = find_or_create_agreement(conn, body.counterparty_id, body.number, body.agreement_date)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="У этого контрагента уже есть договор с таким номером")
        conn.commit()
        row = conn.execute("SELECT * FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.patch("/agreements/{agreement_id}", response_model=AgreementOut)
def update_agreement(agreement_id: int, body: AgreementIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Договор не найден")
        conn.execute(
            "UPDATE agreements SET counterparty_id=?, number=?, agreement_date=?, updated_at=datetime('now') WHERE id=?",
            (body.counterparty_id, body.number, body.agreement_date, agreement_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM agreements WHERE id = ?", (agreement_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


# --- Спецификации ---


@router.get("/specifications", response_model=list[SpecificationOut])
def list_specifications(agreement_id: int = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM specifications WHERE agreement_id = ? ORDER BY number", (agreement_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/specifications", response_model=SpecificationOut)
def create_specification(body: SpecificationIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        agreement = conn.execute("SELECT id FROM agreements WHERE id = ?", (body.agreement_id,)).fetchone()
        if not agreement:
            raise HTTPException(status_code=404, detail="Договор не найден")
        try:
            specification_id = find_or_create_specification(
                conn, body.agreement_id, body.number, body.specification_date
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="У этого договора уже есть спецификация с таким номером")
        conn.commit()
        row = conn.execute("SELECT * FROM specifications WHERE id = ?", (specification_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


@router.patch("/specifications/{specification_id}", response_model=SpecificationOut)
def update_specification(specification_id: int, body: SpecificationIn, admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM specifications WHERE id = ?", (specification_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Спецификация не найдена")
        conn.execute(
            "UPDATE specifications SET agreement_id=?, number=?, specification_date=?, updated_at=datetime('now') WHERE id=?",
            (body.agreement_id, body.number, body.specification_date, specification_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM specifications WHERE id = ?", (specification_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


# --- Справочник префиксов марок ---


@router.get("/mark-type-prefixes")
def list_mark_type_prefixes(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT prefix, element_type FROM mark_type_prefixes ORDER BY prefix").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/mark-type-prefixes")
def upsert_mark_type_prefix(body: MarkTypePrefixIn, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO mark_type_prefixes (prefix, element_type) VALUES (?, ?) "
            "ON CONFLICT(prefix) DO UPDATE SET element_type = excluded.element_type",
            (body.prefix, body.element_type),
        )
        conn.commit()
        return {"prefix": body.prefix, "element_type": body.element_type}
    finally:
        conn.close()


@router.delete("/mark-type-prefixes/{prefix}")
def delete_mark_type_prefix(prefix: str, admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM mark_type_prefixes WHERE prefix = ?", (prefix,))
        conn.commit()
        return {"status": "ok"}
    finally:
        conn.close()
