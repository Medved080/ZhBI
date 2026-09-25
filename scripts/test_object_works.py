"""Объектный план/факт МФР: тесты только на копии обезличенной БД."""

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db, object_works


class ObjectWorksTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="object-works-test-")
        path = Path(self.temp.name) / "test.db"
        shutil.copy2(Path(__file__).resolve().parent.parent / "data/zhbi.anon.db", path)
        self.db_patch = patch.object(db, "DB_PATH", path)
        self.db_patch.start()
        db.init_db()
        self.conn = db.get_connection()
        self.object_id = 4
        self.wt = object_works.options(self.conn, self.object_id)[0]["id"]
        self.user_id = self.conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()[0]

    def tearDown(self):
        self.conn.close()
        self.db_patch.stop()
        self.temp.cleanup()

    def test_full_cycle_and_object_isolation(self):
        initial = object_works.state(self.conn, self.object_id)
        self.assertNotIn(self.wt, {r["work_type_id"] for r in initial["works"]})
        object_works.save_settings(self.conn, self.object_id, self.user_id, [self.wt], initial["rev"])
        state = object_works.state(self.conn, self.object_id)
        work = next(r for r in state["works"] if r["work_type_id"] == self.wt)
        self.assertNotIn(self.wt, {r["work_type_id"] for r in object_works.state(self.conn, 3)["works"]})
        with self.assertRaisesRegex(object_works.ObjectWorkError, "изменился"):
            object_works.save_settings(self.conn, self.object_id, self.user_id, [], initial["rev"])
        values = dict(plan_start="2026-09-25", plan_end="2026-10-01",
                      forecast_start=None, forecast_end=None, note="Тест")
        object_works.save_dates(self.conn, self.object_id, work["id"], self.user_id,
                                values, object_works.work_rev(work))
        with self.assertRaisesRegex(object_works.ObjectWorkError, "изменились"):
            object_works.save_dates(self.conn, self.object_id, work["id"], self.user_id,
                                    values, object_works.work_rev(work))
        report_id = object_works.save_report(self.conn, self.object_id, self.user_id, None,
                                             "2026-09-25", {work["id"]: 40})
        report = object_works.report(self.conn, self.object_id, report_id)
        self.assertEqual(report["items"][work["id"]], 40)
        object_works.save_report(self.conn, self.object_id, self.user_id, report_id,
                                 "2026-09-25", {work["id"]: 70}, report["rev"])
        self.assertEqual(object_works.state(self.conn, self.object_id)["works"][0]["percent"], 70)
        with self.assertRaisesRegex(object_works.ObjectWorkError, "изменился"):
            object_works.save_report(self.conn, self.object_id, self.user_id, report_id,
                                     "2026-09-25", {work["id"]: 90}, report["rev"])
        object_works.save_settings(self.conn, self.object_id, self.user_id, [],
                                   object_works.state(self.conn, self.object_id)["rev"])
        self.assertEqual(object_works.state(self.conn, self.object_id)["works"], [])
        self.assertEqual(object_works.report(self.conn, self.object_id, report_id)["items"][work["id"]], 70)

    def test_foreign_work_and_invalid_percent_refused(self):
        state = object_works.state(self.conn, self.object_id)
        with self.assertRaisesRegex(object_works.ObjectWorkError, "текущему объекту"):
            object_works.save_settings(self.conn, self.object_id, self.user_id, [999999], state["rev"])
        with self.assertRaisesRegex(object_works.ObjectWorkError, "текущего объекта"):
            object_works.save_report(self.conn, self.object_id, self.user_id, None,
                                     "2026-09-25", {999999: 50})


if __name__ == "__main__":
    unittest.main()
