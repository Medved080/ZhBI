"""
Единая точка записи плановой даты поставки элемента (см. Docs/backlog.md,
"Контрактация 2.0", п.3/4) — простое живое поле elements.planned_delivery_date,
БЕЗ версионирования по status_history (как раньше elements.batch_id: партии
убраны, но принцип "назначение даты — независимое действие от смены
статуса" остался). И развёрнутая таблица контракта, и назначение даты из
2D/3D-рабочей области обязаны звать эти же функции — единственный способ
не дать поведению разойтись между двумя точками входа.
"""

from typing import Optional

import sqlite3

from app import activity
from app.contracts import enrich_element_row


def set_planned_installation_dates(conn, element_ids, value, user=None):
    """Атомарная правка даты только для готовых к монтажу изделий. Транзакцией владеет вызывающий код."""
    from datetime import date
    from fastapi import HTTPException
    if value is not None:
        try:
            value = date.fromisoformat(value).isoformat()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Плановая дата монтажа: ожидается существующая дата ГГГГ-ММ-ДД")
    ids = list(dict.fromkeys(element_ids))
    rows = [conn.execute("SELECT * FROM elements WHERE id = ?", (i,)).fetchone() for i in ids]
    if any(r is None for r in rows):
        raise HTTPException(status_code=404, detail="Одно или несколько изделий не найдены")
    if any(r["current_status"] != "ready_for_installation" for r in rows):
        raise HTTPException(status_code=409, detail="Плановую дату монтажа можно менять только у изделий в статусе «Готов к монтажу». Выберите только такие изделия")
    updated = []
    for r in rows:
        conn.execute("UPDATE elements SET planned_installation_date = ?, updated_at = datetime('now') WHERE id = ?", (value, r["id"]))
        if r["planned_installation_date"] != value:
            activity.log("planned_installation_date", user=user, entity_type="element", entity_id=r["id"],
                         element_type=r["element_type"], subtype=r["subtype"], mark=r["mark"],
                         old_value=r["planned_installation_date"], new_value=value)
        item = dict(conn.execute("SELECT * FROM elements WHERE id = ?", (r["id"],)).fetchone())
        enrich_element_row(conn, item)
        updated.append(item)
    return updated


def set_planned_delivery_date(conn, element_id: int, planned_delivery_date: Optional[str],
                              user: Optional[sqlite3.Row] = None) -> Optional[dict]:
    """user — кто правит. Нужен только журналу (app/activity.py) и потому
    необязателен: функцию зовут и служебные пути без живого пользователя.

    Запись в журнал стоит ЗДЕСЬ, в единой точке, ровно по той же причине,
    по которой здесь стоит сам UPDATE: точек входа две (карточка элемента и
    развёрнутая таблица контракта), и логирование у каждой своё разъехалось
    бы. Без этой записи плановая дата была единственным реквизитом, правка
    которого нигде не отмечалась — ни в журнале, ни, следовательно, в
    отчёте «Моя работа» и в фильтре «Изменения»."""
    row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    if row is None:
        return None
    conn.execute(
        "UPDATE elements SET planned_delivery_date = ?, updated_at = datetime('now') WHERE id = ?",
        (planned_delivery_date, element_id),
    )
    if row["planned_delivery_date"] != planned_delivery_date:
        activity.log(
            "planned_date", user=user, entity_type="element", entity_id=element_id,
            element_type=row["element_type"], subtype=row["subtype"], mark=row["mark"],
            old_value=row["planned_delivery_date"], new_value=planned_delivery_date,
        )
    updated_row = conn.execute("SELECT * FROM elements WHERE id = ?", (element_id,)).fetchone()
    history_rows = conn.execute(
        "SELECT * FROM status_history WHERE element_id = ? ORDER BY changed_at", (element_id,)
    ).fetchall()
    data = dict(updated_row)
    data["history"] = [dict(h) for h in history_rows]
    enrich_element_row(conn, data)
    return data


def set_planned_delivery_dates_bulk(conn, items: list[tuple[int, Optional[str]]],
                                    user: Optional[sqlite3.Row] = None) -> list[dict]:
    """items — список (element_id, planned_delivery_date). Возвращает
    обогащённые словари ТОЛЬКО для найденных элементов — вызывающая сторона
    (app/main.py) отвечает за 404 на отсутствующие id, как и bulk-status."""
    updated = []
    for element_id, planned_delivery_date in items:
        data = set_planned_delivery_date(conn, element_id, planned_delivery_date, user)
        if data is not None:
            updated.append(data)
    return updated
