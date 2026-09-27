"""Transaction, retry and future-activation checks on a private DB copy.

Usage: PYTHONPATH=. python scripts/test_crane_zone_transition.py data/zhbi.baseline.db
"""

import json
import sqlite3
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from app import db
from app import crane_zone_service as service
from app import crane_zone_transition as transition
from app.crane_zone_versions import ensure_baselines, snapshot_zones


def object_content(conn, object_id):
    tables = {
        "zones": ("object_id",), "elements": ("object_id",),
        "crane_zone_versions": ("object_id",),
        "crane_zone_transition": ("object_id",),
    }
    out = {}
    for table in tables:
        out[table] = [tuple(row) for row in conn.execute(
            f"SELECT * FROM {table} WHERE object_id = ? ORDER BY rowid", (object_id,))]
    out["zone_levels"] = [tuple(row) for row in conn.execute(
        "SELECT l.* FROM zone_levels l JOIN zones z ON z.id = l.zone_id "
        "WHERE z.object_id = ? ORDER BY l.id", (object_id,))]
    out["assignments"] = [tuple(row) for row in conn.execute(
        "SELECT a.* FROM crane_zone_version_assignments a "
        "JOIN crane_zone_versions v ON v.id = a.version_id "
        "WHERE v.object_id = ? ORDER BY a.version_id, a.element_id", (object_id,))]
    return out


def main(source):
    with tempfile.TemporaryDirectory(prefix="crane-transition-") as temporary:
        path = Path(temporary) / "copy.db"
        src = sqlite3.connect(f"file:{Path(source).resolve()}?mode=ro", uri=True)
        dst = sqlite3.connect(path)
        src.backup(dst)
        src.close(); dst.close()
        db.DB_PATH = path
        db.init_db()
        conn = db.get_connection()
        try:
            ensure_baselines(conn)
            conn.commit()
            before = object_content(conn, 1)
            for failpoint in ("after_snapshot", "after_materialization"):
                try:
                    transition._convert_one(conn, 1, failpoint=failpoint)
                except RuntimeError as exc:
                    assert "test failpoint" in str(exc)
                else:
                    raise AssertionError(f"failpoint {failpoint} missed")
                assert object_content(conn, 1) == before, failpoint
            first = transition._convert_one(conn, 1)
            assert first["elements"] > 0
            assert transition._convert_one(conn, 1) == {"already_ready": 1}

            base = conn.execute("SELECT * FROM crane_zone_versions WHERE object_id=2 "
                                "AND kind='baseline'").fetchone()
            tomorrow = (date.fromisoformat(transition.business_date()) + timedelta(days=1)).isoformat()
            cur = conn.execute(
                "INSERT INTO crane_zone_versions "
                "(object_id,revision_no,kind,effective_date,known_from,note,zones_json,assignment_count) "
                "VALUES (2,1,'published',?,?,?,?,?)",
                (tomorrow, transition.business_date(), "future test", base["zones_json"],
                 base["assignment_count"]),
            )
            future_id = cur.lastrowid
            conn.execute(
                "INSERT INTO crane_zone_version_assignments "
                "(version_id,element_id,element_uid,crane_zone_id,crane_status,"
                "stance_zone_id,stance_status,stance_elevation_mm,source,reason) "
                "SELECT ?,element_id,element_uid,crane_zone_id,crane_status,"
                "stance_zone_id,stance_status,stance_elevation_mm,source,reason "
                "FROM crane_zone_version_assignments WHERE version_id=?",
                (future_id, base["id"]),
            )
            conn.commit()
            old_future = conn.execute("SELECT zones_json FROM crane_zone_versions WHERE id=?",
                                      (future_id,)).fetchone()[0]
            assert transition._convert_one(conn, 2) == {"waiting": 1}
            assert conn.execute("SELECT state FROM crane_zone_transition WHERE object_id=2").fetchone()[0] == "waiting"
            service.business_date = lambda: tomorrow
            transition.business_date = lambda: tomorrow
            assert future_id in service.activate_due(conn)
            assert snapshot_zones(conn, 2) == json.loads(old_future)
            second = transition._convert_one(conn, 2)
            assert second["elements"] > 0
            assert conn.execute("SELECT zones_json FROM crane_zone_versions WHERE id=?",
                                (future_id,)).fetchone()[0] == old_future
            assert conn.execute("SELECT state FROM crane_zone_transition WHERE object_id=2").fetchone()[0] == "ready"
            assert len(conn.execute("PRAGMA foreign_key_check").fetchall()) == 0
            print("transition: rollback, retry, waiting, due activation, old snapshot OK")
        finally:
            conn.close()


if __name__ == "__main__":
    main(sys.argv[1])
