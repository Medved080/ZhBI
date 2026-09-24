"""Единое назначение цветов кранам при DXF-импорте и смене редакции."""

from __future__ import annotations

import sqlite3


ZONE_COLOR_PALETTE = [
    "#c0392b", "#1f8a4c", "#8e44ad", "#d68910", "#2471a3",
    "#16a085", "#a04000", "#5b2c6f", "#117864", "#b03a2e",
]


def _field(zone, name):
    return zone.get(name) if isinstance(zone, dict) else getattr(zone, name)


def ensure_crane_colors(conn: sqlite3.Connection, object_id: int, zones: list,
                        previous: list | None = None) -> None:
    """Сохранить настроенный цвет при переименовании, новым дать свободный.

    Транзакцией управляет вызывающий код: в публикации нельзя отдельно
    зафиксировать цвет раньше зон и назначений изделий.
    """
    previous_by_id = {
        _field(zone, "id"): _field(zone, "name")
        for zone in previous or [] if _field(zone, "category") == "Кран"
    }
    rows = conn.execute(
        "SELECT name, color FROM zone_colors WHERE object_id = ? AND category = 'Кран'",
        (object_id,),
    ).fetchall()
    colors = {row["name"]: row["color"] for row in rows}
    used = set(colors.values())
    for zone in sorted(
        (item for item in zones if _field(item, "category") == "Кран" and _field(item, "name")),
        key=lambda item: _field(item, "name"),
    ):
        name = _field(zone, "name")
        if name in colors:
            continue
        color = colors.get(previous_by_id.get(_field(zone, "id")))
        if color is None:
            color = next((item for item in ZONE_COLOR_PALETTE if item not in used), None)
        if color is None:
            color = ZONE_COLOR_PALETTE[len(used) % len(ZONE_COLOR_PALETTE)]
        conn.execute(
            "INSERT OR IGNORE INTO zone_colors (object_id, category, name, color) "
            "VALUES (?, 'Кран', ?, ?)",
            (object_id, name, color),
        )
        colors[name] = color
        used.add(color)
