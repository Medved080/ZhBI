"""Regression: S-curve continuity at schedule update, daily cut and subsequent variance.

Run: PYTHONPATH=. .venv312/bin/python scripts/test_dynamics_forecast.py
Uses only an in-memory synthetic database.
"""

import sqlite3
import unittest
from unittest.mock import patch

from app.reports import _forecast_from_loading, build_dynamics_report
from app.settings import NOTE_FIELDS, PROJECT_CARD_DEFAULT


class DynamicsForecastTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.executescript("""
            CREATE TABLE elements (id INTEGER PRIMARY KEY, object_id INTEGER, is_current INTEGER,
                                   source_file TEXT, current_status TEXT);
            CREATE TABLE status_history (id INTEGER PRIMARY KEY, element_id INTEGER, status TEXT, changed_at TEXT);
            CREATE TABLE schedule_versions (id INTEGER PRIMARY KEY, object_id INTEGER, kind TEXT, loaded_at TEXT);
            CREATE TABLE schedule_version_dates (version_id INTEGER, element_id INTEGER,
                                                 smr_start_date TEXT, smr_end_date TEXT);
            INSERT INTO elements VALUES (1,1,1,'drawing','installed'), (2,1,1,'drawing','delivered'),
                                        (3,1,1,'drawing','planned'), (4,1,1,'drawing','installed');
            INSERT INTO status_history VALUES (1,1,'delivered','2026-10-19'), (2,1,'installed','2026-10-20'),
                                              (3,2,'delivered','2026-10-27'), (4,4,'installed','2026-10-30');
            INSERT INTO schedule_versions VALUES (1,1,'current','2026-10-28 12:00:00');
            INSERT INTO schedule_version_dates VALUES (1,2,'2026-11-12','2026-10-30'),
                                                      (1,3,'2026-11-19','2026-11-06');
        """)

    def report(self, day="2026-10-28", **kwargs):
        notes = {key: [] for key in NOTE_FIELDS} | {"effective_date": None}
        with patch("app.report_status_summary.plan_day_counts", return_value=([], [])), \
                patch("app.settings.get_project_card", return_value=dict(PROJECT_CARD_DEFAULT)), \
                patch("app.settings.get_notes_for_date", return_value=notes), \
                patch("app.schedule_versions.forecast_gap", return_value={}):
            return build_dynamics_report(self.conn, "drawing", day, object_id=1, **kwargs)

    def test_fresh_update_joins_each_fact_and_excludes_future_days(self):
        data = self.report()
        cut = data["weeks"].index("2026-10-26")
        for kind, expected in (("montage", 1), ("delivery", 2)):
            self.assertEqual(data["series"][f"fact_{kind}"][cut], expected)
            self.assertEqual(data["series"][f"forecast_{kind}"][cut], expected)
            self.assertEqual(data[kind]["cumulative"]["fact"], expected)
        # Friday's montage and Thursday's delivery remain in the forecast after the update.
        self.assertEqual(data["series"]["forecast_montage"][-1], 3)
        self.assertEqual(data["series"]["forecast_delivery"][-1], 4)

    def test_delay_after_update_is_preserved_in_same_week(self):
        self.conn.execute("DELETE FROM status_history WHERE element_id=4")
        self.conn.execute("UPDATE elements SET current_status='planned' WHERE id=4")
        data = self.report("2026-10-30")
        cut = data["weeks"].index("2026-10-26")
        self.assertEqual(data["series"]["fact_montage"][cut], 1)
        self.assertEqual(data["series"]["forecast_montage"][cut], 2)

    def test_weekend_update_and_already_due_dates(self):
        weeks = ["2026-10-19", "2026-10-26", "2026-11-02"]
        facts = [{"d": "2026-10-20", "n": 10}]
        pairs = [("2026-10-20", 5), ("2026-10-25", 7), ("2026-10-26", 3), ("2026-11-02", 2)]
        self.assertEqual(_forecast_from_loading(pairs, facts, weeks, "2026-10-25", "2026-10-25"),
                         [10, 13, 15])
        self.assertEqual(_forecast_from_loading(pairs, facts, weeks, "2026-10-27", "2026-10-25"),
                         [None, 13, 15])

    def test_no_forecast_or_report_before_update(self):
        self.assertTrue(all(v is None for v in self.report("2026-10-27")["series"]["forecast_montage"]))
        self.conn.execute("DELETE FROM schedule_version_dates")
        self.assertTrue(all(v is None for v in self.report()["series"]["forecast_montage"]))
        self.conn.execute("DELETE FROM schedule_versions")
        self.assertTrue(all(v is None for v in self.report()["series"]["forecast_delivery"]))

    def test_period_is_only_a_slice(self):
        full = self.report()
        cropped = self.report(week_from="2026-10-26", week_to="2026-11-02")
        indices = [i for i, w in enumerate(full["weeks"]) if "2026-10-26" <= w <= "2026-11-02"]
        for key, values in full["series"].items():
            self.assertEqual(cropped["series"][key], [values[i] for i in indices])


if __name__ == "__main__":
    unittest.main()
