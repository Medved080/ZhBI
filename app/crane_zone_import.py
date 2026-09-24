"""Крановые контуры нового DXF как непубликованный черновик редакции.

Импорт изделий может продолжаться, но старые zones/назначения кранов и
стоянок не трогаются. Контуры проверяются до записи изделий; черновик
сохраняется только после успешного применения всех этапов импорта.
"""

from __future__ import annotations

import json
import sqlite3

from app.crane_zone_editor import ZoneDraftError, validate_zones
from app.db import parse_zone_number


def build_candidate(base_zones: list[dict], records: list, source_file: str) -> list[dict]:
    """Слить распознанные полигоны с действующей целой иерархией.

    Отсутствующую в DXF зону намеренно НЕ удаляем: редактор требует явного
    решения оператора. Полигон без имени/номера/крана нельзя безопасно
    сопоставить, поэтому импорт останавливается до записи изделий.
    """
    result = {zone["id"]: json.loads(json.dumps(zone)) for zone in base_zones}
    cranes = {
        z["number"]: z["id"] for z in base_zones if z["category"] == "Кран"
    }
    stances = {
        (z["parent_zone_id"], z["number"]): z["id"]
        for z in base_zones if z["category"] == "Стоянка"
    }
    handle_to_crane = {}
    touched = set()
    next_id = -1

    def add_level(zone_id, record):
        level = {
            "elevation_mm": record.elevation_mm, "outline": record.outline,
            "source_file": source_file, "dxf_handle": record.handle,
        }
        if zone_id not in touched:
            result[zone_id]["levels"] = []
            touched.add(zone_id)
        if any(l["elevation_mm"] == record.elevation_mm for l in result[zone_id]["levels"]):
            raise ZoneDraftError(f"Повторяется отметка зоны {record.name}")
        result[zone_id]["levels"].append(level)

    for record in (r for r in records if r.category == "Кран"):
        number = parse_zone_number(record.name)
        if not number or record.match_status != "matched":
            raise ZoneDraftError(f"Кран из DXF ({record.handle}) не опознан по имени и номеру")
        zone_id = cranes.get(number)
        if zone_id is None:
            zone_id = next_id
            next_id -= 1
            cranes[number] = zone_id
            result[zone_id] = {
                "id": zone_id, "category": "Кран", "number": number,
                "name": record.name, "parent_zone_id": None,
                "match_status": "matched", "parent_match_status": "not_applicable",
                "source_file": source_file, "dxf_handle": record.handle, "levels": [],
            }
        else:
            result[zone_id]["name"] = record.name
        handle_to_crane[record.handle] = zone_id
        add_level(zone_id, record)

    for record in (r for r in records if r.category == "Стоянка"):
        number = parse_zone_number(record.name)
        parent = handle_to_crane.get(record.parent_zone_handle)
        if (not number or record.match_status != "matched" or
                record.parent_match_status != "matched" or parent is None):
            raise ZoneDraftError(
                f"Стоянка из DXF ({record.handle}) не опознана или не имеет однозначного крана"
            )
        key = (parent, number)
        zone_id = stances.get(key)
        if zone_id is None:
            zone_id = next_id
            next_id -= 1
            stances[key] = zone_id
            result[zone_id] = {
                "id": zone_id, "category": "Стоянка", "number": number,
                "name": record.name, "parent_zone_id": parent,
                "match_status": "matched", "parent_match_status": "matched",
                "source_file": source_file, "dxf_handle": record.handle, "levels": [],
            }
        else:
            result[zone_id]["name"] = record.name
        add_level(zone_id, record)

    for zone in result.values():
        zone["levels"].sort(key=lambda l: (
            l["elevation_mm"] is not None,
            l["elevation_mm"] if l["elevation_mm"] is not None else 0,
        ))
    zones = sorted(result.values(), key=lambda z: (
        z["category"] != "Кран", z.get("parent_zone_id") or 0, z["number"], z["id"],
    ))
    validate_zones(zones, base_zones)
    return zones


def preflight_import_draft(conn: sqlite3.Connection, object_id: int,
                           records: list, source_file: str) -> int | None:
    """Проверить предложение до первой записи и закрепить ID основы."""
    if not any(r.category in ("Кран", "Стоянка") for r in records):
        return None
    base = conn.execute(
        "SELECT id, zones_json FROM crane_zone_versions WHERE object_id = ? "
        "ORDER BY revision_no DESC LIMIT 1", (object_id,),
    ).fetchone()
    if base is None:
        return None
    build_candidate(json.loads(base["zones_json"]), records, source_file)
    return base["id"]


def stage_import_draft(conn: sqlite3.Connection, object_id: int, records: list,
                       source_file: str, user_id: int | None,
                       author_name: str | None,
                       expected_base_version_id: int | None = None) -> int | None:
    """Сохранить предложенную DXF редакцию, не затронув рабочие зоны."""
    if not any(r.category in ("Кран", "Стоянка") for r in records):
        return None
    base = conn.execute(
        "SELECT * FROM crane_zone_versions WHERE object_id = ? "
        "ORDER BY revision_no DESC LIMIT 1", (object_id,),
    ).fetchone()
    if base is None:
        return None
    if expected_base_version_id is not None and base["id"] != expected_base_version_id:
        raise ZoneDraftError("За время импорта опубликована другая редакция зон; "
                             "повторите загрузку чертежа")
    base_zones = json.loads(base["zones_json"])
    candidate = build_candidate(base_zones, records, source_file)
    def logical(zones):
        return [
            (z["id"], z["category"], z["number"], z["name"], z.get("parent_zone_id"),
             [(l["elevation_mm"], l["outline"]) for l in z["levels"]])
            for z in zones
        ]

    if logical(candidate) == logical(base_zones):
        return None
    overrides = {
        str(r["element_id"]): {
            "crane_zone_id": r["crane_zone_id"],
            "stance_zone_id": r["stance_zone_id"],
        }
        for r in conn.execute(
            "SELECT element_id, crane_zone_id, stance_zone_id "
            "FROM crane_zone_version_assignments "
            "WHERE version_id = ? AND source = 'manual'", (base["id"],),
        )
    }
    cur = conn.execute(
        "INSERT INTO crane_zone_drafts "
        "(object_id, base_version_id, zones_json, overrides_json, note, created_by, author_name) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (object_id, base["id"], json.dumps(candidate, ensure_ascii=False),
         json.dumps(overrides, ensure_ascii=False), "", user_id, author_name),
    )
    conn.commit()
    return cur.lastrowid
