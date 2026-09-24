"""Историческая привязка кранов/стоянок для существующих SQL-отчётов.

Отчёты уже читают ``elements`` и ``zones`` напрямую в десятках запросов.
Временные VIEW на ОДНОМ соединении дают им согласованную редакцию, не
переписывая бизнес-расчёты и не изменяя рабочие таблицы. Никакой другой
запрос через это соединение до выхода из контекста выполнять нельзя.
"""

import json
import sqlite3
from contextlib import contextmanager


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@contextmanager
def historical_zone_overlay(conn: sqlite3.Connection, version):
    """Подменить только кран/стоянку в читаемых отчётом ``e`` и ``z``.

    Состав изделий берётся из снимка редакции; изделие, появившееся позже,
    не задним числом попадает в старый отчёт. Даты/статусы самого изделия
    остаются существующей логикой отчёта — этот слой отвечает только за
    крановое зонирование, не обещает полный исторический снимок учёта.
    """
    version_id = int(version["id"])
    zones = json.loads(version["zones_json"])
    try:
        conn.execute(
            "CREATE TEMP TABLE crane_hist_labels "
            "(id INTEGER PRIMARY KEY, number INTEGER, name TEXT, parent_zone_id INTEGER)"
        )
        conn.executemany(
            "INSERT INTO crane_hist_labels (id, number, name, parent_zone_id) VALUES (?, ?, ?, ?)",
            [(z["id"], z["number"], z["name"], z.get("parent_zone_id")) for z in zones],
        )
        conn.execute(
            "CREATE TEMP TABLE crane_hist_levels "
            "(id INTEGER PRIMARY KEY, zone_id INTEGER, elevation_mm INTEGER, "
            "outline_json TEXT, source_file TEXT, dxf_handle TEXT)"
        )
        levels = [
            (-index, z["id"], level["elevation_mm"], json.dumps(level["outline"]),
             level.get("source_file"), level.get("dxf_handle"))
            for index, (z, level) in enumerate(
                ((z, level) for z in zones if z["category"] == "Стоянка"
                 for level in z["levels"]), start=1,
            )
        ]
        conn.executemany(
            "INSERT INTO crane_hist_levels "
            "(id, zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, ?, ?, ?, ?, ?)", levels,
        )
        cols = [row["name"] for row in conn.execute("PRAGMA main.table_info(elements)")]
        overrides = {
            "zone_crane_id": "a.crane_zone_id",
            "zone_crane_status": "a.crane_status",
            "zone_stance_id": "a.stance_zone_id",
            "zone_stance_status": "a.stance_status",
            "zone_stance_level_id": "hl.id",
        }
        select_cols = [f"{overrides.get(c, 'e.' + _ident(c))} AS {_ident(c)}" for c in cols]
        conn.execute(
            f"CREATE TEMP VIEW elements AS SELECT {', '.join(select_cols)} "
            "FROM main.elements e JOIN main.crane_zone_version_assignments a "
            f"ON a.element_id = e.id AND a.version_id = {version_id} "
            "LEFT JOIN temp.crane_hist_levels hl ON hl.zone_id = a.stance_zone_id "
            "AND hl.elevation_mm IS a.stance_elevation_mm"
        )
        conn.execute("CREATE TEMP VIEW zone_levels AS SELECT * FROM temp.crane_hist_levels")
        zone_cols = [row["name"] for row in conn.execute("PRAGMA main.table_info(zones)")]
        zone_overrides = {
            c: f"CASE WHEN h.id IS NOT NULL THEN h.{_ident(c)} ELSE z.{_ident(c)} END"
            for c in ("number", "name", "parent_zone_id")
        }
        select_zone_cols = [
            f"{zone_overrides.get(c, 'z.' + _ident(c))} AS {_ident(c)}" for c in zone_cols
        ]
        conn.execute(
            f"CREATE TEMP VIEW zones AS SELECT {', '.join(select_zone_cols)} "
            "FROM main.zones z LEFT JOIN temp.crane_hist_labels h ON h.id = z.id"
        )
        yield
    finally:
        conn.execute("DROP VIEW IF EXISTS temp.zones")
        conn.execute("DROP VIEW IF EXISTS temp.zone_levels")
        conn.execute("DROP VIEW IF EXISTS temp.elements")
        conn.execute("DROP TABLE IF EXISTS temp.crane_hist_levels")
        conn.execute("DROP TABLE IF EXISTS temp.crane_hist_labels")
