"""Inheritance and explicit removal of conversion exceptions on a private copy."""

import json
import sqlite3
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from app import db
from app import crane_zone_service as service


def source_count(conn, version_id, source):
    return conn.execute(
        "SELECT count(*) FROM crane_zone_version_assignments WHERE version_id=? AND source=?",
        (version_id, source),
    ).fetchone()[0]


def main(source):
    with tempfile.TemporaryDirectory(prefix="crane-exceptions-") as directory:
        path = Path(directory) / "copy.db"
        a = sqlite3.connect(f"file:{Path(source).resolve()}?mode=ro", uri=True)
        b = sqlite3.connect(path)
        a.backup(b); a.close(); b.close()
        db.DB_PATH = path
        conn = db.get_connection()
        try:
            original = conn.execute(
                "SELECT count(*) FROM crane_zone_version_assignments a "
                "JOIN crane_zone_versions v ON v.id=a.version_id "
                "WHERE v.object_id=2 AND v.kind='conversion' AND a.source='conversion'"
            ).fetchone()[0]
            assert original > 0
            today = date.fromisoformat(service.business_date())
            for step in range(1, 4):
                day = (today + timedelta(days=step)).isoformat()
                service.business_date = lambda day=day: day
                draft_id = service.create_draft(conn, 2, None, "test")
                row = conn.execute("SELECT * FROM crane_zone_drafts WHERE id=?", (draft_id,)).fetchone()
                overrides = json.loads(row["overrides_json"])
                assert sum(v.get("source") == "conversion" for v in overrides.values()) == original
                token = service.update_draft(conn, 2, draft_id, row["edit_token"],
                                             json.loads(row["zones_json"]), overrides,
                                             f"Проверка наследования {step}")
                published = service.publish_draft(conn, 2, draft_id, token, day, None, "test")
                assert published["activated"]
                assert source_count(conn, published["version_id"], "conversion") == original

            day = (today + timedelta(days=4)).isoformat()
            service.business_date = lambda: day
            draft_id = service.create_draft(conn, 2, None, "test")
            row = conn.execute("SELECT * FROM crane_zone_drafts WHERE id=?", (draft_id,)).fetchone()
            overrides = json.loads(row["overrides_json"])
            removed_id = next(iter(overrides))
            overrides.pop(removed_id)
            zones = json.loads(row["zones_json"])
            token = service.update_draft(conn, 2, draft_id, row["edit_token"], zones,
                                         overrides, "Явно снять исключение")
            result = service.publish_draft(conn, 2, draft_id, token, day, None, "test")
            assert source_count(conn, result["version_id"], "conversion") == original - 1
            removed = conn.execute(
                "SELECT source FROM crane_zone_version_assignments WHERE version_id=? AND element_id=?",
                (result["version_id"], int(removed_id)),
            ).fetchone()
            assert removed["source"] == "geometry"

            day = (today + timedelta(days=5)).isoformat()
            service.business_date = lambda: day
            draft_id = service.create_draft(conn, 2, None, "test")
            row = conn.execute("SELECT * FROM crane_zone_drafts WHERE id=?", (draft_id,)).fetchone()
            overrides = json.loads(row["overrides_json"])
            zones = json.loads(row["zones_json"])
            stance = next(z for z in zones if z["category"] == "Стоянка")
            overrides[removed_id] = {"crane_zone_id": stance["parent_zone_id"],
                                     "stance_zone_id": stance["id"], "source": "manual"}
            token = service.update_draft(conn, 2, draft_id, row["edit_token"], zones,
                                         overrides, "Ручное переназначение")
            result = service.publish_draft(conn, 2, draft_id, token, day, None, "test")
            manual = conn.execute(
                "SELECT source, crane_zone_id, stance_zone_id FROM crane_zone_version_assignments "
                "WHERE version_id=? AND element_id=?", (result["version_id"], int(removed_id)),
            ).fetchone()
            assert tuple(manual) == ("manual", stance["parent_zone_id"], stance["id"])
            print("conversion exceptions: three publications, explicit removal, manual reassignment OK")
        finally:
            conn.close()


if __name__ == "__main__":
    main(sys.argv[1])
