"""Историческая привязка кранов/стоянок для существующих SQL-отчётов.

Отчёты уже читают ``elements`` и ``zones`` напрямую в десятках запросов.
Временные VIEW на ОДНОМ соединении дают им согласованную редакцию, не
переписывая бизнес-расчёты и не изменяя рабочие таблицы. Никакой другой
запрос через это соединение до выхода из контекста выполнять нельзя.
"""

import json
import sqlite3
from contextlib import contextmanager
from datetime import date


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@contextmanager
def historical_zone_overlay(conn: sqlite3.Connection, version, as_of: str):
    """Подменить только кран/стоянку в читаемых отчётом ``e`` и ``z``.

    Доступные строки берутся из снимка редакции и поступлений на дату:
    изделие, появившееся позже, не попадает в старый отчёт. Но стандартный
    фильтр отчёта ``is_current = 1`` продолжает исключать снятые позднее
    изделия. Даты/статусы изделия также остаются нынешними: этот слой
    восстанавливает только крановое зонирование, не полный исторический
    снимок учёта.
    """
    version_id = int(version["id"])
    date.fromisoformat(as_of)
    # SQLite VIEW не принимает параметры; дата после строгого ISO-разбора.
    day_sql = as_of.replace("'", "''")
    object_id = int(version["object_id"])
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
            "FROM main.elements e JOIN ("
            "SELECT element_id, crane_zone_id, crane_status, stance_zone_id, "
            "stance_status, stance_elevation_mm "
            "FROM main.crane_zone_version_assignments "
            f"WHERE version_id = {version_id} UNION ALL "
            "SELECT i.element_id, NULL, NULL, NULL, NULL, NULL "
            "FROM main.crane_zone_import_arrivals i "
            f"WHERE i.object_id = {object_id} AND i.first_seen_date <= '{day_sql}' "
            "AND NOT EXISTS (SELECT 1 FROM main.crane_zone_version_assignments old "
            f"WHERE old.version_id = {version_id} AND old.element_id = i.element_id)"
            ") a ON a.element_id = e.id "
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
