"""
Пересчёт привязки элементов к зонам после ручной правки геометрии зоны
(решения З11, З12) и откат этой операции.

Главное правило: пересчёт идёт ТЕМИ ЖЕ функциями, что импорт
(scripts/zone_binding.bind_element_to_zones), а не собственной реализацией
«точка в полигоне». В привязке живёт неочевидная логика — ригель и плита
перекрытия относятся к ярусу СТРОГО ниже своей отметки, колонна привязывается
точкой, остальные типы площадью пересечения, — и вторая её копия неизбежно
разъехалась бы с первой.

Отдельная тонкость про «лесенку» сужения зоны стоянки с высотой: импорт
включает её ТОЛЬКО когда в чертеже физически один ярус стоянок, и опирается
при этом на сетку осей. Если такой чертёж встретится, автоматический пересчёт
здесь отказывается работать явной ошибкой, а не считает по другому правилу
молча (см. can_recalculate).
"""

import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from zone_binding import bind_element_to_zones
from zone_parser import ZoneRecord

_CATEGORY_COLUMNS = {
    "Захватка": ("zone_zakhvatka_id", "zone_zakhvatka_status"),
    "Кран": ("zone_crane_id", "zone_crane_status"),
    "Стоянка": ("zone_stance_id", "zone_stance_status"),
}

# Поля привязки элемента, которые пересчёт может изменить, — они же
# сохраняются в снимок для отката.
_BINDING_FIELDS = (
    "zone_zakhvatka_id", "zone_zakhvatka_status",
    "zone_crane_id", "zone_crane_status",
    "zone_stance_id", "zone_stance_status", "zone_stance_level_id",
)


def _handle(zone_id: int, level_id: int) -> str:
    """Синтетический handle яруса для zone_binding: он работает в терминах
    handle'ов чертежа, а у нас идентичность — пара (зона, ярус)."""
    return f"{zone_id}:{level_id}"


def _parse_handle(handle: Optional[str]) -> tuple:
    if not handle:
        return (None, None)
    zone_id, level_id = handle.split(":")
    return (int(zone_id), int(level_id))


def can_recalculate(conn: sqlite3.Connection, object_id: int) -> Optional[str]:
    """None — пересчитывать можно. Иначе строка с причиной отказа.

    Отказ ровно один и осознанный: чертёж с ОДНИМ физическим ярусом стоянок.
    Для таких файлов импорт синтезирует ярусы «лесенкой» по сетке осей
    (build_stance_level_polygons), и пересчёт без неё дал бы другую привязку —
    расхождение, которое пользователь не увидит глазами. Лучше честно
    отказаться и оставить привязку от импорта.
    """
    elevations = {
        r["elevation_mm"]
        for r in conn.execute(
            "SELECT DISTINCT l.elevation_mm FROM zone_levels l JOIN zones z ON z.id = l.zone_id "
            "WHERE z.object_id = ? AND z.category = 'Стоянка' AND z.is_current = 1",
            (object_id,),
        )
        if r["elevation_mm"] is not None
    }
    if len(elevations) <= 1:
        return (
            "В чертеже один ярус стоянок крана — для таких файлов привязка "
            "считается «лесенкой» по сетке осей, и пересчитать её отдельно от "
            "импорта нельзя. Загрузите чертёж заново, чтобы обновить привязку."
        )
    return None


def _zone_records(conn: sqlite3.Connection, object_id: int) -> list:
    """Реестр зон в том виде, в каком его ждёт zone_binding: по одной записи
    на ЯРУС. Родитель стоянки — handle яруса её крана; у крана ярус один
    (на всех реальных чертежах отметки у кранов нет вовсе), при нескольких
    берётся первый — привязка стоянки к крану от яруса не зависит."""
    crane_handle_by_zone = {}
    for row in conn.execute(
        "SELECT z.id AS zone_id, MIN(l.id) AS level_id FROM zones z "
        "JOIN zone_levels l ON l.zone_id = z.id "
        "WHERE z.object_id = ? AND z.category = 'Кран' AND z.is_current = 1 GROUP BY z.id",
        (object_id,),
    ):
        crane_handle_by_zone[row["zone_id"]] = _handle(row["zone_id"], row["level_id"])

    records = []
    for row in conn.execute(
        "SELECT z.id AS zone_id, z.category, z.name, z.match_status, z.parent_zone_id, "
        "z.parent_match_status, l.id AS level_id, l.elevation_mm, l.outline_json "
        "FROM zones z JOIN zone_levels l ON l.zone_id = z.id "
        "WHERE z.object_id = ? AND z.is_current = 1",
        (object_id,),
    ):
        records.append(ZoneRecord(
            handle=_handle(row["zone_id"], row["level_id"]),
            category=row["category"],
            elevation_mm=row["elevation_mm"],
            outline=[tuple(p) for p in json.loads(row["outline_json"])],
            name=row["name"],
            match_status=row["match_status"] or "matched",
            parent_zone_handle=crane_handle_by_zone.get(row["parent_zone_id"]),
            parent_match_status=row["parent_match_status"] or "not_applicable",
        ))
    return records


def recalculate(conn: sqlite3.Connection, object_id: int) -> dict:
    """Пересчитывает привязку всех актуальных элементов объекта.

    Возвращает {"changed": N, "by_category": {...}, "before": [...]} — before
    это снимок ПРЕЖНИХ значений только у изменившихся элементов, его хватает
    для точного отката и он не раздувается до всей таблицы.
    """
    zones = _zone_records(conn, object_id)
    elements = conn.execute(
        "SELECT id, element_type, x, y, outline_json, elevation_mm, "
        + ", ".join(_BINDING_FIELDS) +
        " FROM elements WHERE object_id = ? AND is_current = 1",
        (object_id,),
    ).fetchall()

    changed_rows, by_category = [], {"Захватка": 0, "Кран": 0, "Стоянка": 0}
    for element in elements:
        outline = json.loads(element["outline_json"]) if element["outline_json"] else None
        bindings = bind_element_to_zones(
            element["element_type"], element["x"], element["y"], outline,
            element["elevation_mm"], zones,
        )
        updates = {}
        for category, result in bindings.items():
            id_col, status_col = _CATEGORY_COLUMNS[category]
            zone_id, level_id = _parse_handle(result.zone_handle)
            if element[id_col] != zone_id or element[status_col] != result.status:
                updates[id_col] = zone_id
                updates[status_col] = result.status
                by_category[category] += 1
            if category == "Стоянка" and element["zone_stance_level_id"] != level_id:
                updates["zone_stance_level_id"] = level_id
        if not updates:
            continue
        changed_rows.append({field: element[field] for field in _BINDING_FIELDS} | {"id": element["id"]})
        assignments = ", ".join(f"{col} = :{col}" for col in updates)
        conn.execute(
            f"UPDATE elements SET {assignments}, updated_at = datetime('now') WHERE id = :id",
            updates | {"id": element["id"]},
        )

    conn.commit()
    return {"changed": len(changed_rows), "by_category": by_category, "before": changed_rows}


def capture_bindings(conn: sqlite3.Connection, zone_id: int, category: str) -> list:
    """Прежние привязки элементов ЭТОЙ зоны — снимается ДО правки геометрии.

    Дорого купленная тонкость: сохранение зоны переписывает ярусы через
    DELETE + INSERT, а на elements.zone_stance_level_id стоит
    ON DELETE SET NULL — то есть к моменту пересчёта ярус у элементов уже
    обнулён, и снимок, сделанный позже, записал бы None вместо настоящего
    яруса (поймано проверкой отката: геометрия восстанавливалась точно, а 443
    элемента оставались без яруса).

    Рядом с id яруса сохраняется его ОТМЕТКА: после отката ярусы вставляются
    заново и получают другие id, поэтому восстанавливать привязку надо по
    отметке, а не по исчезнувшему id.
    """
    id_col, _ = _CATEGORY_COLUMNS[category]
    rows = conn.execute(
        f"SELECT e.id, {', '.join('e.' + f for f in _BINDING_FIELDS)}, l.elevation_mm AS stance_level_elevation "
        f"FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
        f"WHERE e.{id_col} = ?",
        (zone_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def merge_bindings(pre_edit: list, after_recalc: list) -> list:
    """Объединяет снимок «до правки геометрии» со снимком пересчёта.

    Пересечение разрешается в пользу ПЕРВОГО: у него настоящий ярус, у
    второго — уже обнулённый каскадом. Элементы, которых в первом наборе нет
    (привязка появилась или сменилась на другую зону), берутся из второго."""
    merged = {row["id"]: row for row in after_recalc}
    for row in pre_edit:
        merged[row["id"]] = row
    return list(merged.values())


def save_undo(conn: sqlite3.Connection, zone_id: int, user, zone_before: dict, bindings_before: list) -> int:
    """Снимок «до» на одну правку зоны: и реквизиты с геометрией, и прежние
    привязки изменившихся элементов. Хранится вся история правок (объём
    мизерный — сотни полигонов), откат берёт последний неиспользованный
    снимок этой зоны."""
    conn.execute(
        "INSERT INTO zone_edit_undo (zone_id, user_id, user_name, zone_json, bindings_json) "
        "VALUES (?, ?, ?, ?, ?)",
        (zone_id, user["id"] if user else None,
         f"{(user['last_name'] if user else '') or ''} {(user['first_name'] if user else '') or ''}".strip() or None,
         json.dumps(zone_before, ensure_ascii=False),
         json.dumps(bindings_before, ensure_ascii=False)),
    )
    undo_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.commit()
    return undo_id


def undo(conn: sqlite3.Connection, zone_id: int) -> dict:
    """Откатывает последнюю правку зоны целиком: реквизиты, ярусы И привязки
    элементов, изменившиеся при пересчёте (решение З12 — «все изменения,
    которые задевает изменение точки, должны откатываться»)."""
    row = conn.execute(
        "SELECT * FROM zone_edit_undo WHERE zone_id = ? AND undone_at IS NULL "
        "ORDER BY id DESC LIMIT 1",
        (zone_id,),
    ).fetchone()
    if row is None:
        return {"restored": False, "reason": "Отменять нечего — правок этой зоны в журнале нет"}

    zone_before = json.loads(row["zone_json"])
    conn.execute(
        "UPDATE zones SET number = ?, name = ?, parent_zone_id = ? WHERE id = ?",
        (zone_before.get("number"), zone_before.get("name"),
         zone_before.get("parent_zone_id"), zone_id),
    )
    conn.execute("DELETE FROM zone_levels WHERE zone_id = ?", (zone_id,))
    zone_row = conn.execute("SELECT source_file, dxf_handle FROM zones WHERE id = ?", (zone_id,)).fetchone()
    for level in zone_before.get("levels", []):
        conn.execute(
            "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, ?, ?, ?, ?)",
            (zone_id, level.get("elevation_mm"), json.dumps(level["outline"]),
             zone_row["source_file"], zone_row["dxf_handle"]),
        )

    # Ярусы после восстановления получили НОВЫЕ id (вставлены заново), поэтому
    # привязку к ярусу восстанавливаем по отметке, а сохранённый id используем
    # только если он ещё существует.
    level_id_by_elevation = {
        r["elevation_mm"]: r["id"]
        for r in conn.execute("SELECT id, elevation_mm FROM zone_levels WHERE zone_id = ?", (zone_id,))
    }
    alive_levels = {r["id"] for r in conn.execute("SELECT id FROM zone_levels")}

    bindings = json.loads(row["bindings_json"])
    for saved in bindings:
        values = {field: saved.get(field) for field in _BINDING_FIELDS}
        values["id"] = saved["id"]
        level_id = values.get("zone_stance_level_id")
        if level_id is None or level_id not in alive_levels:
            values["zone_stance_level_id"] = level_id_by_elevation.get(
                saved.get("stance_level_elevation")
            ) if saved.get("zone_stance_id") == zone_id else level_id
        assignments = ", ".join(f"{f} = :{f}" for f in _BINDING_FIELDS)
        conn.execute(
            f"UPDATE elements SET {assignments}, updated_at = datetime('now') WHERE id = :id", values
        )
    conn.execute("UPDATE zone_edit_undo SET undone_at = datetime('now') WHERE id = ?", (row["id"],))
    conn.commit()
    return {
        "restored": True,
        "levels": len(zone_before.get("levels", [])),
        "elements": len(bindings),
    }
