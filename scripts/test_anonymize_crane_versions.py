"""Regression for private text in newly versioned crane-zone data."""

import json
import sqlite3
import unittest

from scripts.anonymize_db import (
    Mapping, anonymize_crane_zone_history, find_leaks, zone_snapshot_source_files,
)


class CraneVersionAnonymizationTest(unittest.TestCase):
    def test_snapshot_files_and_free_text_are_scrubbed(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE crane_zone_versions
                (id INTEGER PRIMARY KEY, zones_json TEXT, author_name TEXT, note TEXT);
            CREATE TABLE crane_zone_drafts
                (id INTEGER PRIMARY KEY, zones_json TEXT, author_name TEXT,
                 note TEXT, overrides_json TEXT);
            CREATE TABLE crane_zone_version_assignments (reason TEXT);
            CREATE TABLE crane_zone_transition
                (object_id INTEGER PRIMARY KEY, last_error TEXT, summary_json TEXT);
            CREATE TABLE release_tasks (name TEXT);
        """)
        snapshot = json.dumps([{
            "id": 1, "source_file": "private.dxf", "name": "Кран 1",
            "levels": [{"elevation_mm": 0, "outline": [[1, 2], [3, 4], [5, 6]],
                        "source_file": "private.dxf"}],
        }])
        self.assertEqual(zone_snapshot_source_files(snapshot), {"private.dxf"})
        conn.execute("INSERT INTO crane_zone_versions VALUES (1, ?, 'Surname', 'Surname')",
                     (snapshot,))
        conn.execute(
            "INSERT INTO crane_zone_drafts VALUES (1, ?, 'Surname', 'Surname', ?)",
            (snapshot, json.dumps({"7": {"source": "conversion", "reason": "Surname"}})),
        )
        conn.execute("INSERT INTO crane_zone_version_assignments VALUES ('Surname')")
        conn.execute("INSERT INTO crane_zone_transition VALUES (1, 'Surname', ?)",
                     (json.dumps({"reason": "Surname", "count": 2}),))
        conn.execute("INSERT INTO release_tasks VALUES ('2026-09-27-crane-stance-union')")
        mapping = Mapping()
        mapping.put("source_file", "private.dxf", "Чертёж-1.dxf")
        mapping.put("users.last_name", "Surname", "Фамилия1")
        mapping.put("status_history.changed_by", "crane", "Система")

        anonymize_crane_zone_history(conn, mapping)
        self.assertEqual(find_leaks(conn, mapping.needles()), [])
        version = json.loads(conn.execute(
            "SELECT zones_json FROM crane_zone_versions"
        ).fetchone()[0])[0]
        self.assertEqual(version["source_file"], "Чертёж-1.dxf")
        self.assertEqual(version["levels"][0]["source_file"], "Чертёж-1.dxf")
        self.assertEqual(version["levels"][0]["outline"], [[1, 2], [3, 4], [5, 6]])
        override = json.loads(conn.execute(
            "SELECT overrides_json FROM crane_zone_drafts"
        ).fetchone()[0])
        self.assertTrue(override["7"]["reason"])
        before = [tuple(row) for row in conn.execute(
            "SELECT * FROM crane_zone_versions"
        )]
        anonymize_crane_zone_history(conn, mapping)
        self.assertEqual(before, [tuple(row) for row in conn.execute(
            "SELECT * FROM crane_zone_versions"
        )])
        conn.close()


if __name__ == "__main__":
    unittest.main()
