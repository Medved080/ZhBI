"""
Справочник МАРОК (2026-08-05).

Зачем понадобился. Марка была свободным текстом в `elements.mark` и в
`contract_lines.mark`, и одно и то же изделие, набранное в разном регистре
(«К-1» и «к-1»), расщеплялось на две ветки во всём сразу: в фильтрах, в
подписях на схеме, в остатках контракта. Свободный текст нечем ни
переименовать разом, ни свернуть — поэтому марка стала записью справочника,
на которую изделие ССЫЛАЕТСЯ (`elements.mark_id`).

Владелец марки — ТИП элемента, область — ОБЪЕКТ (решение пользователя
2026-08-05): марки нумерует проектировщик в пределах здания, и одноимённые
марки соседних зданий это разные изделия. Отсюда ключ
(object_id, element_type, name), см. schema.sql.

Текстовое `elements.mark` живёт РЯДОМ с `mark_id` и остаётся источником
правды для всего остального кода — фильтров, отчётов, экспорта, импортов.
Так решено намеренно (правило релиза «только добавлять»): пока пользователь
не сверил, что справочник разложился верно, снимать старое поле нельзя. Из
этого следует главное требование к этому модулю: **любая правка справочника
обязана двигать текст вместе со ссылкой**. Переименовали марку — тот же
текст поехал в elements.mark и в contract_lines.mark, иначе два поля
разъедутся молча и сверять будет нечего.

Удаление записи справочника живёт не здесь, а в `app/dict_delete.py` —
вместе с удалением остальных справочников, потому что правило у них общее:
сначала проверка ссылок, потом замена, потом удаление.
"""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import activity
from app.access import assert_object_access, require_system_admin
from app.auth import get_current_user
from app.db import get_connection
from app.models import ZHBI_ELEMENT_TYPES

router = APIRouter(tags=["marks"])


class MarkIn(BaseModel):
    object_id: int
    element_type: str
    name: str


def _check_type(element_type: str) -> None:
    if element_type not in ZHBI_ELEMENT_TYPES:
        raise HTTPException(status_code=422, detail=f"Неизвестный тип элемента: {element_type}")


def _mark_row(conn, mark_id: int):
    row = conn.execute("SELECT * FROM marks WHERE id = ?", (mark_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Марка не найдена")
    return row


def mark_usage(conn, row) -> dict:
    """Сколько всего ссылается на запись справочника: изделий и позиций
    контрактов. Одним запросом на каждую сторону — список марок объекта
    измеряется сотнями, и запрос на строку превратил бы форму в тысячу
    обращений к базе."""
    elements = conn.execute(
        "SELECT COUNT(*) AS n FROM elements WHERE mark_id = ?", (row["id"],)
    ).fetchone()["n"]
    lines = conn.execute(
        """
        SELECT COUNT(*) AS n FROM contract_lines cl
        JOIN contracts co ON co.id = cl.contract_id
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        WHERE a.object_id = ? AND cl.element_type = ? AND cl.mark = ?
        """,
        (row["object_id"], row["element_type"], row["name"]),
    ).fetchone()["n"]
    return {"elements": elements, "contract_lines": lines}


@router.get("/marks")
def list_marks(object_id: int = Query(...), element_type: Optional[str] = Query(None),
               user: sqlite3.Row = Depends(get_current_user)):
    """Марки объекта — все или одного типа. Со счётчиками ссылок: без них
    администратор не отличит запись, за которой стоят изделия, от опечатки,
    заведённой импортом и не использованной ни разу."""
    conn = get_connection()
    try:
        assert_object_access(conn, user, object_id, "view")
        sql = "SELECT * FROM marks WHERE object_id = ?"
        params = [object_id]
        if element_type:
            sql += " AND element_type = ?"
            params.append(element_type)
        sql += " ORDER BY element_type, name COLLATE NOCASE"
        rows = conn.execute(sql, params).fetchall()

        # Счётчики — двумя групповыми запросами на весь список, а не по
        # запросу на строку (см. mark_usage: она для одиночных случаев).
        по_изделиям = {
            r["mark_id"]: r["n"] for r in conn.execute(
                "SELECT mark_id, COUNT(*) AS n FROM elements "
                "WHERE object_id = ? AND mark_id IS NOT NULL GROUP BY mark_id", (object_id,))
        }
        по_позициям = {
            (r["element_type"], r["mark"]): r["n"] for r in conn.execute(
                """
                SELECT cl.element_type, cl.mark, COUNT(*) AS n FROM contract_lines cl
                JOIN contracts co ON co.id = cl.contract_id
                JOIN specifications s ON s.id = co.specification_id
                JOIN agreements a ON a.id = s.agreement_id
                WHERE a.object_id = ? GROUP BY cl.element_type, cl.mark
                """, (object_id,))
        }
        return [
            {**dict(r),
             "elements_count": по_изделиям.get(r["id"], 0),
             "contract_lines_count": по_позициям.get((r["element_type"], r["name"]), 0)}
            for r in rows
        ]
    finally:
        conn.close()


@router.post("/marks")
def create_mark(body: MarkIn, admin: sqlite3.Row = Depends(require_system_admin)):
    _check_type(body.element_type)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Марка не может быть пустой")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM objects WHERE id = ?", (body.object_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Объект не найден")
        # Проверка ТОЧНАЯ, с учётом регистра — как и уникальный ключ таблицы.
        # Регистронезависимое сопоставление это отдельный, ещё не принятый шаг:
        # пока задвоенные записи разбирает человек, запрет «похоже на
        # существующую» отнял бы у него возможность завести обе и сравнить.
        if conn.execute(
            "SELECT 1 FROM marks WHERE object_id = ? AND element_type = ? AND name = ?",
            (body.object_id, body.element_type, name),
        ).fetchone():
            raise HTTPException(status_code=409, detail="Такая марка у этого типа уже есть")
        conn.execute(
            "INSERT INTO marks (object_id, element_type, name) VALUES (?, ?, ?)",
            (body.object_id, body.element_type, name),
        )
        mark_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
        row = _mark_row(conn, mark_id)
    finally:
        conn.close()
    activity.log("mark_create", user=admin, entity_type="mark", entity_id=mark_id,
                 element_type=body.element_type, new_value=name,
                 details={"object_id": body.object_id})
    return {**dict(row), "elements_count": 0, "contract_lines_count": 0}


@router.patch("/marks/{mark_id}")
def rename_mark(mark_id: int, body: MarkIn, admin: sqlite3.Row = Depends(require_system_admin)):
    """Переименование ведёт за собой ТЕКСТ марки везде, где он лежит копией:
    у изделий (`elements.mark`) и в позициях контрактов
    (`contract_lines.mark`). Иначе справочник и текст разъедутся, а сверять
    разложение станет нечем — ради этой сверки оба поля и держатся рядом.

    Тип и объект здесь не меняются: перенос марки в другой тип — это не
    переименование, а слияние с чужой веткой справочника, и делается оно
    удалением с заменой (`app/dict_delete.py`), где видно, что и куда
    поедет.
    """
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Марка не может быть пустой")
    conn = get_connection()
    try:
        row = _mark_row(conn, mark_id)
        if body.element_type != row["element_type"] or body.object_id != row["object_id"]:
            raise HTTPException(
                status_code=400,
                detail="Тип и объект марки не меняются переименованием — "
                       "перенос в другую ветку справочника делается удалением с заменой",
            )
        if name == row["name"]:
            return {**dict(row), **{f"{k}_count": v for k, v in mark_usage(conn, row).items()}}
        if conn.execute(
            "SELECT 1 FROM marks WHERE object_id = ? AND element_type = ? AND name = ? AND id <> ?",
            (row["object_id"], row["element_type"], name, mark_id),
        ).fetchone():
            raise HTTPException(
                status_code=409,
                detail="Такая марка у этого типа уже есть — чтобы объединить их, "
                       "удалите эту запись с заменой на ту",
            )
        conn.execute("UPDATE marks SET name = ?, updated_at = datetime('now') WHERE id = ?",
                     (name, mark_id))
        изделий = conn.execute(
            "UPDATE elements SET mark = ?, updated_at = datetime('now') WHERE mark_id = ?",
            (name, mark_id),
        ).rowcount
        позиций = _rename_contract_lines(conn, row, name)
        conn.commit()
        обновлённая = _mark_row(conn, mark_id)
    finally:
        conn.close()
    activity.log("mark_rename", user=admin, entity_type="mark", entity_id=mark_id,
                 element_type=row["element_type"], old_value=row["name"], new_value=name,
                 details={"изделий": изделий, "позиций контрактов": позиций})
    return {**dict(обновлённая), "elements_count": изделий,
            "contract_lines_count": позиций}


def _rename_contract_lines(conn, mark_row, new_name: str) -> int:
    """Переименовать марку в позициях контрактов ЭТОГО объекта и типа.

    Ловушка, ради которой это отдельная функция: у `contract_lines` уникален
    набор (contract_id, element_type, mark). Если в том же контракте уже есть
    позиция с новым написанием, простой UPDATE упал бы на уникальном индексе
    — а по смыслу это ровно то слияние, ради которого правку и затеяли:
    количества складываются, лишняя строка уходит.
    """
    строки = conn.execute(
        """
        SELECT cl.id, cl.contract_id, cl.quantity FROM contract_lines cl
        JOIN contracts co ON co.id = cl.contract_id
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        WHERE a.object_id = ? AND cl.element_type = ? AND cl.mark = ?
        """,
        (mark_row["object_id"], mark_row["element_type"], mark_row["name"]),
    ).fetchall()
    затронуто = 0
    for строка in строки:
        существующая = conn.execute(
            "SELECT id, quantity FROM contract_lines "
            "WHERE contract_id = ? AND element_type IS ? AND mark IS ? AND id <> ?",
            (строка["contract_id"], mark_row["element_type"], new_name, строка["id"]),
        ).fetchone()
        if существующая:
            conn.execute("UPDATE contract_lines SET quantity = ? WHERE id = ?",
                         (существующая["quantity"] + строка["quantity"], существующая["id"]))
            conn.execute("DELETE FROM contract_lines WHERE id = ?", (строка["id"],))
        else:
            conn.execute("UPDATE contract_lines SET mark = ? WHERE id = ?", (new_name, строка["id"]))
        затронуто += 1
    return затронуто
