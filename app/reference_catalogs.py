"""
Справочники СМУ и физлиц (2026-09-08, живой запрос: «сделай реквизиты
заказчика в карточке объекта выбираемыми каждый из своего справочника —
создай под них структуру хранения и редактирования, должны появиться
справочники СМУ, Физлица (для директора и ответственного)»).

Реквизиты объекта `smu`/`smu_director`/`responsible` были свободным текстом
(§ Docs/TZ.md 6.3.1). Свободный текст нечем ни переименовать разом, ни
свести опечатки («СМУ-1» / «СМУ 1») — та же причина, по которой маркой стала
запись справочника (app/marks.py), не строка. Здесь два справочника, а не
один: СМУ и физлица — разные сущности. У ФИЗЛИЦ справочник ОДИН на обе роли
объекта («Директор СМУ» и «Ответственный (ДП/РП)») — это один и тот же
класс сущности, ФИО строкой, заводить два одинаковых справочника под разные
подписи поля незачем.

Оба справочника ГЛОБАЛЬНЫЕ, без object_id: подразделение и человек не
привязаны к одной стройке, один директор СМУ обычно ведёт несколько
объектов сразу.

Удаление записи — не здесь, а в app/dict_delete.py (kind "smu"/"individual"),
вместе с остальными справочниками: сначала проверка ссылок из objects,
потом обязательная замена, потом удаление.

find_or_create_* — общие для ручного создания через комбобокс формы И для
загрузки справочника объектов из Excel (app/objects_import.py): «вносить не
найденные по наименованию элементы в справочники» — тот же самый механизм,
не два разных.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import require_service_feature
from app.auth import get_current_user
from app.db import get_connection

router = APIRouter(tags=["reference-catalogs"])


class CatalogEntryIn(BaseModel):
    name: str


def _clean_name(name: str) -> str:
    return (name or "").strip()


def find_or_create_smu(conn, name: Optional[str]) -> Optional[int]:
    """Код СМУ по имени — находит точным совпадением (без учёта регистра),
    не нашёл — заводит новую запись. Пусто на входе — пусто на выходе, это
    не ошибка: подразделение не обязано быть заполнено."""
    name = _clean_name(name)
    if not name:
        return None
    row = conn.execute(
        "SELECT id FROM smu_catalog WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute("INSERT INTO smu_catalog (name) VALUES (?)", (name,))
    return conn.execute(
        "SELECT id FROM smu_catalog WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()["id"]


def find_or_create_individual(conn, name: Optional[str]) -> Optional[int]:
    name = _clean_name(name)
    if not name:
        return None
    row = conn.execute(
        "SELECT id FROM individuals WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    if row:
        return row["id"]
    conn.execute("INSERT INTO individuals (name) VALUES (?)", (name,))
    return conn.execute(
        "SELECT id FROM individuals WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()["id"]


# ------------------------------------------------------------------- СМУ

@router.get("/smu")
def list_smu(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, name FROM smu_catalog ORDER BY name COLLATE NOCASE"
        )]
    finally:
        conn.close()


@router.post("/smu")
def create_smu(body: CatalogEntryIn, admin: sqlite3.Row = Depends(require_service_feature("dict_smu", "write"))):
    name = _clean_name(body.name)
    if not name:
        raise HTTPException(status_code=400, detail="Наименование СМУ не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM smu_catalog WHERE name = ? COLLATE NOCASE", (name,)).fetchone():
            raise HTTPException(status_code=409, detail="Такое СМУ уже есть в справочнике")
        conn.execute("INSERT INTO smu_catalog (name) VALUES (?)", (name,))
        conn.commit()
        new_id = conn.execute("SELECT id FROM smu_catalog WHERE name = ?", (name,)).fetchone()["id"]
    finally:
        conn.close()
    activity.log("smu_create", user=admin, entity_type="smu_catalog", entity_id=new_id, new_value=name)
    return {"id": new_id, "name": name}


@router.patch("/smu/{smu_id}")
def rename_smu(smu_id: int, body: CatalogEntryIn,
               admin: sqlite3.Row = Depends(require_service_feature("dict_smu", "write"))):
    name = _clean_name(body.name)
    if not name:
        raise HTTPException(status_code=400, detail="Наименование СМУ не может быть пустым")
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM smu_catalog WHERE id = ?", (smu_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="СМУ не найдено")
        if conn.execute(
            "SELECT 1 FROM smu_catalog WHERE name = ? COLLATE NOCASE AND id <> ?", (name, smu_id)
        ).fetchone():
            raise HTTPException(status_code=409, detail="Такое СМУ уже есть в справочнике")
        было = row["name"]
        conn.execute(
            "UPDATE smu_catalog SET name = ?, updated_at = datetime('now') WHERE id = ?",
            (name, smu_id),
        )
        conn.commit()
    finally:
        conn.close()
    if было != name:
        activity.log("smu_rename", user=admin, entity_type="smu_catalog", entity_id=smu_id,
                     old_value=было, new_value=name)
    return {"id": smu_id, "name": name}


# --------------------------------------------------------------- физлица

@router.get("/individuals")
def list_individuals(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, name FROM individuals ORDER BY name COLLATE NOCASE"
        )]
    finally:
        conn.close()


@router.post("/individuals")
def create_individual(body: CatalogEntryIn,
                      admin: sqlite3.Row = Depends(require_service_feature("dict_individuals", "write"))):
    name = _clean_name(body.name)
    if not name:
        raise HTTPException(status_code=400, detail="ФИО не может быть пустым")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM individuals WHERE name = ? COLLATE NOCASE", (name,)).fetchone():
            raise HTTPException(status_code=409, detail="Такое физлицо уже есть в справочнике")
        conn.execute("INSERT INTO individuals (name) VALUES (?)", (name,))
        conn.commit()
        new_id = conn.execute("SELECT id FROM individuals WHERE name = ?", (name,)).fetchone()["id"]
    finally:
        conn.close()
    activity.log("individual_create", user=admin, entity_type="individual", entity_id=new_id, new_value=name)
    return {"id": new_id, "name": name}


@router.patch("/individuals/{individual_id}")
def rename_individual(individual_id: int, body: CatalogEntryIn,
                      admin: sqlite3.Row = Depends(require_service_feature("dict_individuals", "write"))):
    name = _clean_name(body.name)
    if not name:
        raise HTTPException(status_code=400, detail="ФИО не может быть пустым")
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM individuals WHERE id = ?", (individual_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Физлицо не найдено")
        if conn.execute(
            "SELECT 1 FROM individuals WHERE name = ? COLLATE NOCASE AND id <> ?", (name, individual_id)
        ).fetchone():
            raise HTTPException(status_code=409, detail="Такое физлицо уже есть в справочнике")
        было = row["name"]
        conn.execute(
            "UPDATE individuals SET name = ?, updated_at = datetime('now') WHERE id = ?",
            (name, individual_id),
        )
        conn.commit()
    finally:
        conn.close()
    if было != name:
        activity.log("individual_rename", user=admin, entity_type="individual", entity_id=individual_id,
                     old_value=было, new_value=name)
    return {"id": individual_id, "name": name}
