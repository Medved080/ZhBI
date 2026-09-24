"""Транзакционные проверки на временной пустой БД, не на данных сервиса."""

import json
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException

from app import db
from app.crane_zone_service import (
    ZoneDraftError, activate_due, create_draft, preview_draft, publish_draft, update_draft,
)
from app.crane_zone_editor import preview_assignments
from app.crane_zone_report import historical_zone_overlay
from app.crane_zone_versions import business_date, ensure_baselines, snapshot_zones


def square(x, y, size):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]


class CraneZoneServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crane-zones-")
        self.db_patch = patch.object(db, "DB_PATH", Path(self.temp.name) / "test.db")
        self.db_patch.start()
        db.init_db()
        self.conn = db.get_connection()
        object_row = self.conn.execute("SELECT id FROM objects ORDER BY id LIMIT 1").fetchone()
        if object_row:
            self.object_id = object_row["id"]
        else:
            self.object_id = self.conn.execute(
                "INSERT INTO objects (name, kind) VALUES ('Тестовый объект', 'zhbi')"
            ).lastrowid
        self.conn.execute("UPDATE objects SET kind = 'zhbi' WHERE id = ?", (self.object_id,))
        self.crane_id = self.conn.execute(
            "INSERT INTO zones (source_file, dxf_handle, category, name, number, "
            "object_id, outline_json, match_status) "
            "VALUES ('test.dxf', 'C1', 'Кран', 'Кран 1', 1, ?, ?, 'matched')",
            (self.object_id, json.dumps(square(0, 0, 10))),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, NULL, ?, 'test.dxf', 'C1')",
            (self.crane_id, json.dumps(square(0, 0, 10))),
        )
        self.stance_id = self.conn.execute(
            "INSERT INTO zones (source_file, dxf_handle, category, name, number, "
            "parent_zone_id, parent_match_status, object_id, outline_json, match_status) "
            "VALUES ('test.dxf', 'S1', 'Стоянка', 'Стоянка 1', 1, ?, "
            "'matched', ?, ?, 'matched')",
            (self.crane_id, self.object_id, json.dumps(square(0, 0, 5))),
        ).lastrowid
        stance_level = self.conn.execute(
            "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, 0, ?, 'test.dxf', 'S1')",
            (self.stance_id, json.dumps(square(0, 0, 5))),
        ).lastrowid
        self.conn.execute(
            "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
            "VALUES (?, 10000, ?, 'test.dxf', 'S1b')",
            (self.stance_id, json.dumps(square(0, 0, 5))),
        )
        self.element_id = self.conn.execute(
            "INSERT INTO elements (source_file, dxf_handle, layer, element_type, mark_source, "
            "x, y, axis_status, elevation_mm, object_id, element_uid, "
            "zone_crane_id, zone_crane_status, zone_stance_id, zone_stance_status, zone_stance_level_id) "
            "VALUES ('test.dxf', 'E1', 'test', 'Колонна', 'none', "
            "2, 2, 'none', 0, ?, 'test-element-uid', ?, 'matched', ?, 'matched', ?)",
            (self.object_id, self.crane_id, self.stance_id, stance_level),
        ).lastrowid
        self.conn.commit()
        ensure_baselines(self.conn)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.db_patch.stop()
        self.temp.cleanup()

    def _draft_with_new_crane(self):
        draft_id = create_draft(self.conn, self.object_id, None, "Тест")
        zones = json.loads(self.conn.execute(
            "SELECT zones_json FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone()[0])
        zones.extend([
            {"id": -1, "category": "Кран", "number": 2, "name": "Кран 2",
             "parent_zone_id": None,
             "levels": [{"elevation_mm": None, "outline": square(20, 0, 10)}]},
            {"id": -2, "category": "Стоянка", "number": 1, "name": "Стоянка 1",
             "parent_zone_id": -1,
             "levels": [{"elevation_mm": 0, "outline": square(20, 0, 5)},
                        {"elevation_mm": 10000, "outline": square(20, 0, 5)}]},
        ])
        token = update_draft(
            self.conn, self.object_id, draft_id, 1, zones,
            {str(self.element_id): {"crane_zone_id": -1, "stance_zone_id": -2}},
            "Добавлен второй кран; изделие перенесено вручную",
        )
        return draft_id, token

    def test_preview_has_no_writes_and_publish_is_consistent(self):
        draft_id, token = self._draft_with_new_crane()
        before = self.conn.total_changes
        preview = preview_draft(self.conn, self.object_id, draft_id)
        self.assertEqual(self.conn.total_changes, before)
        self.assertEqual(preview["total"], 1)
        self.assertEqual(preview["counts"]["crane"], 1)
        result = publish_draft(
            self.conn, self.object_id, draft_id, token, business_date(), None, "Тест",
        )
        self.assertTrue(result["activated"])
        version = self.conn.execute(
            "SELECT zones_json FROM crane_zone_versions WHERE id = ?", (result["version_id"],),
        ).fetchone()
        self.assertEqual(snapshot_zones(self.conn, self.object_id), json.loads(version[0]))
        element = self.conn.execute(
            "SELECT zone_crane_id, zone_stance_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()
        self.assertNotEqual(element["zone_crane_id"], self.crane_id)
        self.assertNotEqual(element["zone_stance_id"], self.stance_id)
        old = self.conn.execute(
            "SELECT crane_zone_id FROM crane_zone_version_assignments "
            "WHERE element_id = ? AND version_id = "
            "(SELECT id FROM crane_zone_versions WHERE object_id = ? AND revision_no = 0)",
            (self.element_id, self.object_id),
        ).fetchone()
        self.assertEqual(old[0], self.crane_id)

    def test_future_version_does_not_change_current_until_activation(self):
        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        result = publish_draft(
            self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест",
        )
        self.assertFalse(result["activated"])
        current = self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()
        self.assertEqual(current[0], self.crane_id)
        with patch("app.crane_zone_service.business_date", return_value=tomorrow):
            self.assertEqual(activate_due(self.conn), [result["version_id"]])
        new = self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()
        self.assertNotEqual(new[0], self.crane_id)

    def test_failure_during_materialization_rolls_back_all(self):
        draft_id, token = self._draft_with_new_crane()
        before_zones = self.conn.execute("SELECT COUNT(*) FROM zones").fetchone()[0]
        self.conn.execute(
            "CREATE TRIGGER fail_element_update BEFORE UPDATE ON elements "
            "BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
        )
        self.conn.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            publish_draft(
                self.conn, self.object_id, draft_id, token, business_date(), None, "Тест",
            )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM zones").fetchone()[0], before_zones)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM crane_zone_versions WHERE object_id = ?", (self.object_id,),
        ).fetchone()[0], 1)
        self.assertIsNotNone(self.conn.execute(
            "SELECT id FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone())

    def test_optimistic_token_prevents_overwrite(self):
        draft_id, token = self._draft_with_new_crane()
        zones = json.loads(self.conn.execute(
            "SELECT zones_json FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone()[0])
        with self.assertRaisesRegex(ZoneDraftError, "другой вкладке"):
            update_draft(self.conn, self.object_id, draft_id, token - 1, zones, {}, "Старая вкладка")

    def test_second_operator_cannot_publish_stale_base(self):
        first, token = self._draft_with_new_crane()
        second = create_draft(self.conn, self.object_id, None, "Другой оператор")
        result = publish_draft(
            self.conn, self.object_id, first, token, business_date(), None, "Тест",
        )
        self.assertTrue(result["activated"])
        self.conn.execute(
            "UPDATE crane_zone_drafts SET note = 'Параллельная правка' WHERE id = ?", (second,),
        )
        self.conn.commit()
        with self.assertRaisesRegex(ZoneDraftError, "устарела"):
            publish_draft(self.conn, self.object_id, second, 1, business_date(), None, "Другой")

    def test_future_activation_refuses_out_of_band_change(self):
        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        result = publish_draft(
            self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест",
        )
        self.conn.execute(
            "UPDATE elements SET zone_crane_id = NULL WHERE id = ?", (self.element_id,),
        )
        self.conn.commit()
        with patch("app.crane_zone_service.business_date", return_value=tomorrow):
            with self.assertRaisesRegex(ZoneDraftError, "вне редакции"):
                activate_due(self.conn)
        row = self.conn.execute(
            "SELECT activated_at FROM crane_zone_versions WHERE id = ?", (result["version_id"],),
        ).fetchone()
        self.assertIsNone(row[0])

    def test_single_stance_tier_uses_import_binder(self):
        self.conn.execute(
            "DELETE FROM zone_levels WHERE zone_id = ? AND elevation_mm = 10000",
            (self.stance_id,),
        )
        zones = snapshot_zones(self.conn, self.object_id)
        with self.assertRaisesRegex(ZoneDraftError, "сетк"):
            preview_assignments(self.conn, self.object_id, zones, zones, {})
        self.conn.executemany(
            "INSERT INTO axis_lines (source_file, kind, label, coord) VALUES ('test.dxf', ?, ?, ?)",
            [("numeric", "1", 0), ("numeric", "2", 10),
             ("letter", "А", 0), ("letter", "Б", 10)],
        )
        result = preview_assignments(self.conn, self.object_id, zones, zones, {})
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["counts"], {})

    def test_legacy_edit_and_delete_are_blocked_after_baseline(self):
        from app.dict_delete import build_plan
        from app.main import update_zone
        from app.models import ZonePatchIn

        admin = self.conn.execute(
            "SELECT * FROM users WHERE domain_login = 'admin'"
        ).fetchone()
        with self.assertRaises(HTTPException) as caught:
            update_zone(self.crane_id, ZonePatchIn(number=1, name="Кран 1", levels=[]), admin)
        self.assertEqual(caught.exception.status_code, 409)
        plan = build_plan(self.conn, "zone", str(self.crane_id))
        self.assertTrue(plan["blockers"])

    def test_historical_overlay_reads_old_zone_without_changing_db(self):
        draft_id, token = self._draft_with_new_crane()
        publish_draft(self.conn, self.object_id, draft_id, token, business_date(), None, "Тест")
        baseline = self.conn.execute(
            "SELECT * FROM crane_zone_versions WHERE object_id = ? AND revision_no = 0",
            (self.object_id,),
        ).fetchone()
        current = self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()[0]
        self.assertNotEqual(current, self.crane_id)
        with historical_zone_overlay(self.conn, baseline):
            old = self.conn.execute(
                "SELECT e.zone_crane_id, z.name FROM elements e "
                "JOIN zones z ON z.id = e.zone_crane_id WHERE e.id = ?", (self.element_id,),
            ).fetchone()
            self.assertEqual((old["zone_crane_id"], old["name"]), (self.crane_id, "Кран 1"))
        self.assertEqual(self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()[0], current)

    def test_delivery_report_refuses_crossing_and_uses_old_stance(self):
        from app.main import ReportRequestIn, _delivery_schedule

        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        publish_draft(self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест")
        admin = self.conn.execute(
            "SELECT * FROM users WHERE domain_login = 'admin'"
        ).fetchone()
        body = ReportRequestIn(
            object_id=self.object_id, source_file="test.dxf", date_from=business_date(),
            date_to=tomorrow, group_by=["stance"],
        )
        with self.assertRaises(HTTPException) as caught:
            _delivery_schedule(self.conn, admin, body)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn(tomorrow, str(caught.exception.detail))
        old = _delivery_schedule(
            self.conn, admin, body.model_copy(update={"date_to": business_date()}),
        )
        self.assertEqual(old["rows"][0]["label"], "Кран 1 · Стоянка 1")
        new = _delivery_schedule(
            self.conn, admin, body.model_copy(update={"date_from": tomorrow}),
        )
        self.assertEqual(new["rows"][0]["label"], "Кран 2 · Стоянка 1")


if __name__ == "__main__":
    unittest.main()
