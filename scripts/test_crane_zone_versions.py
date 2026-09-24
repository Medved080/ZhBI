"""Проверки временных границ кранового зонирования без рабочей БД."""

import sqlite3
import unittest

from app.crane_zone_versions import period_version, version_for_date


class CraneZonePeriodTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            "CREATE TABLE crane_zone_versions ("
            "id INTEGER PRIMARY KEY, object_id INTEGER, revision_no INTEGER, "
            "kind TEXT, effective_date TEXT, known_from TEXT)"
        )
        self.conn.executemany(
            "INSERT INTO crane_zone_versions VALUES (?, 1, ?, ?, ?, ?)",
            [
                (1, 0, "baseline", None, "2026-09-24"),
                (2, 1, "published", "2026-10-01", "2026-09-24"),
                (3, 2, "published", "2026-11-10", "2026-10-15"),
            ],
        )

    def tearDown(self):
        self.conn.close()

    def test_edit_day_is_not_effective_day(self):
        self.assertEqual(version_for_date(self.conn, 1, "2026-09-30")["id"], 1)
        self.assertEqual(version_for_date(self.conn, 1, "2026-10-01")["id"], 2)

    def test_baseline_is_not_fictional_past(self):
        self.assertIsNone(version_for_date(self.conn, 1, "2026-09-23"))
        with self.assertRaisesRegex(ValueError, "нет достоверной"):
            period_version(self.conn, 1, "2026-09-20", "2026-09-23")

    def test_period_starting_on_change_is_homogeneous(self):
        self.assertEqual(period_version(self.conn, 1, "2026-10-01", "2026-11-09")["id"], 2)

    def test_period_crossing_effective_day_refused(self):
        with self.assertRaisesRegex(ValueError, "2026-10-01"):
            period_version(self.conn, 1, "2026-09-30", "2026-10-01")
        with self.assertRaisesRegex(ValueError, "2026-11-10"):
            period_version(self.conn, 1, "2026-11-09", "2026-11-10")

    def test_object_isolation(self):
        self.assertIsNone(version_for_date(self.conn, 2, "2026-10-10"))


if __name__ == "__main__":
    unittest.main()
