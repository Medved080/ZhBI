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
from app import zone_sync
from app.crane_zone_service import (
    ZoneDraftError, activate_due, create_draft, preview_draft, publish_draft,
    register_import_membership, update_draft,
)
from app.crane_zone_editor import preview_assignments
from app.crane_zone_report import historical_zone_overlay
from app.crane_zone_import import build_candidate, stage_import_draft
from app.crane_zone_versions import business_date, ensure_baselines, snapshot_zones
from zone_parser import ZoneRecord


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

    def test_import_adds_new_element_only_to_live_and_pending_versions(self):
        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        published = publish_draft(
            self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест",
        )
        new_id = self.conn.execute(
            "INSERT INTO elements (source_file, dxf_handle, layer, element_type, mark_source, "
            "x, y, axis_status, elevation_mm, object_id, element_uid) "
            "VALUES ('test.dxf', 'E2', 'test', 'Колонна', 'none', 3, 3, 'none', 0, ?, 'new-uid')",
            (self.object_id,),
        ).lastrowid
        self.assertEqual(register_import_membership(self.conn, self.object_id), 2)
        self.assertEqual(register_import_membership(self.conn, self.object_id), 0)
        self.conn.commit()
        self.assertIsNotNone(self.conn.execute(
            "SELECT element_id FROM crane_zone_version_assignments "
            "WHERE version_id = ? AND element_id = ?", (published["version_id"], new_id),
        ).fetchone())
        with patch("app.crane_zone_service.business_date", return_value=tomorrow):
            self.assertEqual(activate_due(self.conn), [published["version_id"]])
        self.assertIsNone(self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (new_id,),
        ).fetchone()[0])

    def test_dxf_zone_proposal_stays_in_draft_without_changing_live_zones(self):
        before = snapshot_zones(self.conn, self.object_id)
        records = [
            ZoneRecord("C2", "Кран", None, square(0, 0, 12), "Кран 1", "matched"),
            ZoneRecord("S2", "Стоянка", 0, square(0, 0, 6), "Стоянка 1", "matched",
                       "C2", "matched"),
            ZoneRecord("S2b", "Стоянка", 10000, square(0, 0, 6), "Стоянка 1",
                       "matched", "C2", "matched"),
        ]
        draft_id = stage_import_draft(
            self.conn, self.object_id, records, "new.dxf", None, "Импорт DXF",
        )
        self.assertIsNotNone(draft_id)
        self.assertEqual(snapshot_zones(self.conn, self.object_id), before)
        self.assertEqual(self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()[0], self.crane_id)
        draft = self.conn.execute(
            "SELECT zones_json FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone()
        zones = json.loads(draft[0])
        self.assertEqual(zones[0]["levels"][0]["outline"], square(0, 0, 12))
        self.assertEqual(zones[1]["levels"][0]["outline"], square(0, 0, 6))
        self.assertIsNone(stage_import_draft(
            self.conn, self.object_id,
            [
                ZoneRecord("C1", "Кран", None, square(0, 0, 10), "Кран 1", "matched"),
                ZoneRecord("S1", "Стоянка", 0, square(0, 0, 5), "Стоянка 1",
                           "matched", "C1", "matched"),
                ZoneRecord("S1b", "Стоянка", 10000, square(0, 0, 5), "Стоянка 1",
                           "matched", "C1", "matched"),
            ], "same.dxf", None, "Импорт DXF",
        ))

    def test_scoped_zone_sync_never_retires_cranes_or_stances(self):
        before = snapshot_zones(self.conn, self.object_id)
        zone_sync.sync_zones(
            self.conn, self.object_id, "new.dxf",
            [ZoneRecord("Z1", "Захватка", None, square(0, 0, 10),
                        "Захватка 1", "matched")],
            allowed_categories={"Захватка"},
        )
        self.assertEqual(snapshot_zones(self.conn, self.object_id), before)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM zones WHERE object_id = ? AND category = 'Захватка' "
            "AND is_current = 1", (self.object_id,),
        ).fetchone()[0], 1)

    def test_full_dxf_import_stages_crane_contours_without_applying_them(self):
        import ezdxf
        from app.dxf_import import analyze_drawing, apply_drawing, parse_drawing
        from scripts import generate_test_zones_dxf

        path = Path(self.temp.name) / "synthetic_zones.dxf"
        with patch.object(generate_test_zones_dxf, "OUTPUT_PATH", str(path)):
            generate_test_zones_dxf.main()
        drawing = ezdxf.readfile(path)
        for entity in drawing.modelspace().query("TEXT"):
            if entity.dxf.text == "Стоянка A":
                entity.dxf.text = "Стоянка 1"
            elif entity.dxf.text == "Стоянка B":
                entity.dxf.text = "Стоянка 2"
        drawing.saveas(path)
        before = snapshot_zones(self.conn, self.object_id)
        parsed = parse_drawing(path, path.name, self.object_id)
        analysis = analyze_drawing(parsed, self.object_id)
        result = apply_drawing(parsed, analysis)
        self.assertEqual(result.inserted, 3)
        self.assertEqual(snapshot_zones(self.conn, self.object_id), before)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM crane_zone_drafts WHERE object_id = ?",
            (self.object_id,),
        ).fetchone()[0], 1)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM elements WHERE object_id = ? AND is_current = 1 "
            "AND zone_crane_id IS NOT NULL", (self.object_id,),
        ).fetchone()[0], 0)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM crane_zone_version_assignments a "
            "JOIN elements e ON e.id = a.element_id WHERE e.object_id = ? "
            "AND a.version_id = (SELECT id FROM crane_zone_versions "
            "WHERE object_id = ? AND revision_no = 0)",
            (self.object_id, self.object_id),
        ).fetchone()[0], 4)

    def test_renaming_stance_migrates_schedule_flow_atomically(self):
        self.conn.execute(
            "INSERT INTO schedule_flow (object_id, crane_name, stance_name, floor, order_no) "
            "VALUES (?, 'Кран 1', 'Стоянка 1', 1, 7)", (self.object_id,),
        )
        self.conn.commit()
        draft_id = create_draft(self.conn, self.object_id, None, "Тест")
        zones = json.loads(self.conn.execute(
            "SELECT zones_json FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone()[0])
        for zone in zones:
            if zone["id"] == self.stance_id:
                zone["name"] = "Стоянка 01 обновлённая"
        token = update_draft(self.conn, self.object_id, draft_id, 1, zones, {},
                             "Уточнили название стоянки")
        publish_draft(self.conn, self.object_id, draft_id, token,
                      business_date(), None, "Тест")
        row = self.conn.execute(
            "SELECT crane_name, stance_name, order_no FROM schedule_flow WHERE object_id = ?",
            (self.object_id,),
        ).fetchone()
        self.assertEqual(tuple(row), ("Кран 1", "Стоянка 01 обновлённая", 7))

    def test_crane_color_survives_rename_and_new_crane_gets_color(self):
        self.conn.execute(
            "INSERT INTO zone_colors (object_id, category, name, color) "
            "VALUES (?, 'Кран', 'Кран 1', '#abcdef')", (self.object_id,),
        )
        self.conn.commit()
        draft_id, token = self._draft_with_new_crane()
        zones = json.loads(self.conn.execute(
            "SELECT zones_json FROM crane_zone_drafts WHERE id = ?", (draft_id,),
        ).fetchone()[0])
        next(zone for zone in zones if zone["id"] == self.crane_id)["name"] = "Кран 01"
        token = update_draft(self.conn, self.object_id, draft_id, token, zones,
                             {str(self.element_id): {
                                 "crane_zone_id": -1, "stance_zone_id": -2,
                             }}, "Изменили название и добавили кран")
        publish_draft(self.conn, self.object_id, draft_id, token,
                      business_date(), None, "Тест")
        colors = {row["name"]: row["color"] for row in self.conn.execute(
            "SELECT name, color FROM zone_colors WHERE object_id = ?", (self.object_id,),
        )}
        self.assertEqual(colors["Кран 01"], "#abcdef")
        self.assertIn("Кран 2", colors)
        self.assertNotEqual(colors["Кран 2"], "#abcdef")

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
                "SELECT e.zone_crane_id, z.name, zl.elevation_mm FROM elements e "
                "JOIN zones z ON z.id = e.zone_crane_id "
                "LEFT JOIN zone_levels zl ON zl.id = e.zone_stance_level_id "
                "WHERE e.id = ?", (self.element_id,),
            ).fetchone()
            self.assertEqual((old["zone_crane_id"], old["name"]), (self.crane_id, "Кран 1"))
            self.assertEqual(old["elevation_mm"], 0)
        self.assertEqual(self.conn.execute(
            "SELECT zone_crane_id FROM elements WHERE id = ?", (self.element_id,),
        ).fetchone()[0], current)

    def test_history_scene_shows_saved_assignments_not_current(self):
        from app.crane_zone_api import zone_scene

        draft_id, token = self._draft_with_new_crane()
        publish_draft(self.conn, self.object_id, draft_id, token,
                      business_date(), None, "Тест")
        old_id = self.conn.execute(
            "SELECT id FROM crane_zone_versions WHERE object_id = ? AND revision_no = 0",
            (self.object_id,),
        ).fetchone()[0]
        admin = self.conn.execute(
            "SELECT * FROM users WHERE domain_login = 'admin'"
        ).fetchone()
        history = zone_scene(self.object_id, old_id, admin)
        current = zone_scene(self.object_id, None, admin)
        self.assertEqual(history["elements"][0]["zone_crane_id"], self.crane_id)
        self.assertNotEqual(current["elements"][0]["zone_crane_id"], self.crane_id)
        with self.assertRaises(HTTPException) as missing:
            zone_scene(self.object_id, 9999999, admin)
        self.assertEqual(missing.exception.status_code, 404)

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

    def test_completion_pivot_requires_homogeneous_period_for_crane_group(self):
        from app.main import ReportRequestIn, _completion

        self.conn.execute(
            "UPDATE elements SET planned_delivery_date = ? WHERE id = ?",
            (business_date(), self.element_id),
        )
        self.conn.commit()
        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        published = publish_draft(
            self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест",
        )
        with patch("app.crane_zone_service.business_date", return_value=tomorrow):
            self.assertEqual(activate_due(self.conn), [published["version_id"]])
        admin = self.conn.execute(
            "SELECT * FROM users WHERE domain_login = 'admin'"
        ).fetchone()
        common = ReportRequestIn(
            object_id=self.object_id, source_file="test.dxf", view="pivot",
            group_by=["crane"],
        )
        with self.assertRaises(HTTPException) as missing:
            _completion(self.conn, admin, common)
        self.assertIn("укажите обе даты", str(missing.exception.detail))
        with self.assertRaises(HTTPException) as crossing:
            _completion(self.conn, admin, common.model_copy(update={
                "date_from": business_date(), "date_to": tomorrow,
            }))
        self.assertIn(tomorrow, str(crossing.exception.detail))
        old = _completion(self.conn, admin, common.model_copy(update={
            "date_from": business_date(), "date_to": business_date(),
        }))
        self.assertEqual(old["rows"][0]["label"], "Кран 1")
        self.assertEqual(old["total"]["total"], 1)
        self.assertEqual(old["date_from"], business_date())
        self.assertEqual(old["date_to"], business_date())
        # Без крановых уровней прежняя сводная не требует выбора периода.
        ungrouped = _completion(self.conn, admin, common.model_copy(update={
            "group_by": ["mark"],
        }))
        self.assertEqual(ungrouped["total"]["total"], 1)

    def test_analytics_uses_zone_revision_for_report_date(self):
        from app.main import ReportRequestIn, _analytics

        draft_id, token = self._draft_with_new_crane()
        tomorrow = (date.fromisoformat(business_date()) + timedelta(days=1)).isoformat()
        publish_draft(self.conn, self.object_id, draft_id, token, tomorrow, None, "Тест")
        admin = self.conn.execute(
            "SELECT * FROM users WHERE domain_login = 'admin'"
        ).fetchone()
        today_report = _analytics(
            self.conn, admin,
            ReportRequestIn(object_id=self.object_id, source_file="test.dxf",
                            report_date=business_date()),
        )
        future_report = _analytics(
            self.conn, admin,
            ReportRequestIn(object_id=self.object_id, source_file="test.dxf",
                            report_date=tomorrow),
        )
        self.assertEqual(today_report["unmapped"]["no_level"], 0)
        self.assertEqual(future_report["unmapped"]["no_level"], 0)
        self.assertEqual(today_report["front"]["rows"][0]["crane"], "Кран 1")
        self.assertEqual(future_report["front"]["rows"][0]["crane"], "Кран 2")


if __name__ == "__main__":
    unittest.main()
