"""Read-only, aggregate preflight for the crane stance conversion.

Usage: ZHBI_DB_PATH=/path/to/anonymized.db python scripts/audit_crane_stance_union.py
The same pure ``build_conversion`` is called by the release transition.
"""

import json
import os
import sqlite3
from collections import Counter
from pathlib import Path

from app.crane_zone_conversion import ConversionError, build_conversion
from app.crane_zone_versions import business_date, snapshot_zones, version_for_date


def read_object(conn, object_id):
    zones = snapshot_zones(conn, object_id)
    rows = conn.execute(
        "SELECT e.id, e.element_uid, e.element_type, e.x, e.y, e.outline_json, "
        "e.elevation_mm, e.zone_crane_id AS crane_zone_id, "
        "e.zone_crane_status AS crane_status, e.zone_stance_id AS stance_zone_id, "
        "e.zone_stance_status AS stance_status, l.elevation_mm AS stance_elevation_mm "
        "FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
        "WHERE e.object_id = ? AND e.is_current = 1 ORDER BY e.id", (object_id,),
    ).fetchall()
    elements = [{k: row[k] for k in ("id", "element_uid", "element_type", "x", "y", "elevation_mm")}
                | {"outline": json.loads(row["outline_json"]) if row["outline_json"] else None}
                for row in rows]
    current = {row["id"]: {k: row[k] for k in (
        "crane_zone_id", "crane_status", "stance_zone_id", "stance_status",
        "stance_elevation_mm")} for row in rows}
    drawing = conn.execute("SELECT source_file FROM object_drawings WHERE object_id = ? "
                           "AND is_current = 1 LIMIT 1", (object_id,)).fetchone()
    source = drawing["source_file"] if drawing else None
    axes = {"numeric": {}, "letter": {}}
    if source:
        for axis in conn.execute("SELECT kind, label, coord FROM axis_lines WHERE source_file = ?", (source,)):
            if axis["kind"] in axes:
                axes[axis["kind"]][axis["label"]] = axis["coord"]
    return zones, elements, current, axes


def inspect(conn):
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    versioned = "crane_zone_versions" in tables
    summary = Counter()
    errors = []
    details = []
    for obj in conn.execute("SELECT id FROM objects WHERE kind = 'zhbi' ORDER BY id"):
        object_id = obj["id"]
        zones, elements, current, axes = read_object(conn, object_id)
        summary["objects"] += 1
        summary["elements"] += len(elements)
        sources = {}
        future = []
        if versioned:
            active = version_for_date(conn, object_id, business_date())
            future = conn.execute(
                "SELECT id, effective_date FROM crane_zone_versions WHERE object_id = ? "
                "AND activated_at IS NULL ORDER BY effective_date", (object_id,),
            ).fetchall()
            if active:
                sources = {r["element_id"]: r["source"] for r in conn.execute(
                    "SELECT element_id, source FROM crane_zone_version_assignments "
                    "WHERE version_id = ? AND source = 'manual'", (active["id"],))}
                if json.loads(active["zones_json"]) != zones:
                    errors.append({"object_id": object_id,
                                   "error": "Текущие зоны отличаются от действующей редакции"})
                    continue
        if future:
            summary["waiting_objects"] += 1
            details.append({"object_id": object_id, "waiting_dates": [r["effective_date"] for r in future]})
            continue
        try:
            plan = build_conversion(zones, elements, axes, current, sources)
        except (ConversionError, ValueError, KeyError) as exc:
            errors.append({"object_id": object_id, "error": str(exc)})
            summary["error_objects"] += 1
            continue
        summary["ready_objects"] += 1
        summary["exceptions"] += sum(v["source"] == "conversion" for v in plan["overrides"].values())
        summary["manual"] += sum(v["source"] == "manual" for v in plan["overrides"].values())
        summary["empty_windows"] += plan["geometry"]["empty_windows"]
        summary.update({f"reason_{k}": v for k, v in plan["reasons"].items()})
        details.append({"object_id": object_id, "elements": len(elements),
                        "reasons": plan["reasons"], "geometry": plan["geometry"],
                        "conversion_exceptions": sum(v["source"] == "conversion"
                                                     for v in plan["overrides"].values())})
    return {"summary": dict(summary), "errors": errors, "details": details,
            "versioned_schema": versioned}


def main():
    path = Path(os.environ["ZHBI_DB_PATH"])
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        print(json.dumps(inspect(conn), ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
