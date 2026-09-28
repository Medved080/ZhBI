"""Снятие публикации редакций крановых зон (2026-09-28) на временной пустой БД.

Подготовка данных — из test_crane_zone_service (кран, стоянка на двух ярусах,
одно изделие, исходная редакция №0 и конверсия №1). Запуск:
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:scripts .venv/bin/python scripts/test_crane_zone_withdraw.py
"""

import json
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_crane_zone_service as base_test  # noqa: E402

from app.crane_zone_service import (  # noqa: E402
    ZoneDraftError, activate_due, create_draft, preview_draft, publish_draft,
    register_import_membership, update_draft, withdraw_versions,
)
from app.crane_zone_versions import business_date, snapshot_zones  # noqa: E402


def tomorrow(days=1):
    return (date.fromisoformat(business_date()) + timedelta(days=days)).isoformat()


class WithdrawTest(base_test.CraneZoneServiceTest):
    def _versions(self):
        return self.conn.execute(
            "SELECT * FROM crane_zone_versions WHERE object_id = ? ORDER BY revision_no",
            (self.object_id,),
        ).fetchall()

    def _conversion(self):
        return self._versions()[-1] if self._versions()[-1]["kind"] == "conversion" else None

    def _element(self, element_id=None):
        return self.conn.execute(
            "SELECT e.zone_crane_id, e.zone_crane_status, e.zone_stance_id, e.zone_stance_status, "
            "l.elevation_mm FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
            "WHERE e.id = ?", (element_id or self.element_id,),
        ).fetchone()

    def _publish_new_crane(self, day=None):
        draft_id, token = self._draft_with_new_crane()
        return publish_draft(self.conn, self.object_id, draft_id, token, day or business_date(), None, "Тест")

    def test_withdraw_active_returns_elements_and_makes_draft(self):
        conversion = self._conversion()
        before_zones = snapshot_zones(self.conn, self.object_id)
        before = tuple(self._element())
        published = self._publish_new_crane()
        self.assertNotEqual(tuple(self._element()), before)
        result = withdraw_versions(self.conn, self.object_id, conversion["id"],
                                   published["version_id"], None, "Тест")
        self.assertEqual([v["revision_no"] for v in result["withdrawn"]], [published["revision_no"]])
        self.assertEqual(result["changed_elements"], 1)
        self.assertEqual(tuple(self._element()), before, "изделие вернулось к назначению конверсии")
        self.assertEqual(snapshot_zones(self.conn, self.object_id), before_zones)
        self.assertEqual([v["id"] for v in self._versions()][-1], conversion["id"])
        self.assertEqual(self.conn.execute(
            "SELECT activated_at FROM crane_zone_versions WHERE id = ?", (conversion["id"],),
        ).fetchone()[0], conversion["activated_at"], "дата действия прежней редакции не меняется")
        draft = self.conn.execute("SELECT * FROM crane_zone_drafts WHERE id = ?",
                                  (result["drafts"][0]["draft_id"],)).fetchone()
        self.assertEqual(draft["base_version_id"], conversion["id"])
        self.assertEqual(draft["note"], "Добавлен второй кран; изделие перенесено вручную")
        zones = json.loads(draft["zones_json"])
        new = [z for z in zones if z["id"] < 0]
        self.assertEqual(sorted(z["category"] for z in new), ["Кран", "Стоянка"])
        crane = next(z for z in new if z["category"] == "Кран")
        stance = next(z for z in new if z["category"] == "Стоянка")
        self.assertEqual(stance["parent_zone_id"], crane["id"])
        overrides = json.loads(draft["overrides_json"])
        self.assertEqual(overrides[str(self.element_id)]["crane_zone_id"], crane["id"])
        self.assertEqual(overrides[str(self.element_id)]["stance_zone_id"], stance["id"])
        # Черновик — полноценный: предпросмотр и повторная публикация.
        self.assertEqual(preview_draft(self.conn, self.object_id, draft["id"])["total"], 1)
        again = publish_draft(self.conn, self.object_id, draft["id"], draft["edit_token"],
                              business_date(), None, "Тест")
        self.assertTrue(again["activated"])
        self.assertEqual(again["revision_no"], published["revision_no"])
        self.assertNotEqual(self._element()["zone_crane_id"], self.crane_id)

    def test_withdraw_future_version_changes_nothing_current(self):
        conversion = self._conversion()
        before = tuple(self._element())
        published = self._publish_new_crane(tomorrow())
        result = withdraw_versions(self.conn, self.object_id, conversion["id"],
                                   published["version_id"], None, "Тест")
        self.assertEqual(result["changed_elements"], 0)
        self.assertFalse(result["withdrawn"][0]["was_active"])
        self.assertEqual(tuple(self._element()), before)
        with patch("app.crane_zone_service.business_date", return_value=tomorrow()):
            self.assertEqual(activate_due(self.conn), [], "снятая будущая редакция не активируется")

    def test_return_to_any_earlier_withdraws_all_later(self):
        conversion = self._conversion()
        before = tuple(self._element())
        first = self._publish_new_crane()
        draft_id = create_draft(self.conn, self.object_id, None, "Тест")
        zones = snapshot_zones(self.conn, self.object_id)
        token = update_draft(self.conn, self.object_id, draft_id, 1, zones, {}, "Вторая правка")
        second = publish_draft(self.conn, self.object_id, draft_id, token, tomorrow(), None, "Тест")
        result = withdraw_versions(self.conn, self.object_id, conversion["id"],
                                   second["version_id"], None, "Тест")
        self.assertEqual([v["revision_no"] for v in result["withdrawn"]],
                         [second["revision_no"], first["revision_no"]])
        self.assertEqual(len(result["drafts"]), 2)
        self.assertEqual(tuple(self._element()), before)
        self.assertEqual(self._versions()[-1]["id"], conversion["id"])

    def test_new_element_after_target_becomes_unassigned_arrival(self):
        conversion = self._conversion()
        new_id = self.conn.execute(
            "INSERT INTO elements (source_file, dxf_handle, layer, element_type, mark_source, "
            "x, y, axis_status, elevation_mm, object_id, element_uid) "
            "VALUES ('test.dxf', 'E2', 'test', 'Колонна', 'none', 3, 3, 'none', 0, ?, 'new-uid')",
            (self.object_id,),
        ).lastrowid
        register_import_membership(self.conn, self.object_id)
        self.conn.commit()
        published = self._publish_new_crane()
        self.assertIsNotNone(self._element(new_id)["zone_crane_id"], "новая редакция привязала изделие")
        withdraw_versions(self.conn, self.object_id, conversion["id"], published["version_id"], None, "Тест")
        self.assertEqual(tuple(self._element(new_id)), (None, None, None, None, None))
        self.assertTrue(self.conn.execute(
            "SELECT 1 FROM crane_zone_import_arrivals WHERE element_id = ?", (new_id,)).fetchone())
        # После снятия можно открыть новый черновик: текущее состояние согласовано с редакцией.
        self.assertTrue(create_draft(self.conn, self.object_id, None, "Тест"))

    def test_technical_versions_cannot_be_withdrawn(self):
        baseline = self._versions()[0]
        conversion = self._conversion()
        with self.assertRaisesRegex(ZoneDraftError, "служебная"):
            withdraw_versions(self.conn, self.object_id, baseline["id"], conversion["id"], None, "Тест")
        with self.assertRaisesRegex(ZoneDraftError, "нет публикаций"):
            withdraw_versions(self.conn, self.object_id, conversion["id"], conversion["id"], None, "Тест")

    def test_stale_latest_is_refused_without_changes(self):
        conversion = self._conversion()
        published = self._publish_new_crane()
        before = tuple(self._element())
        with self.assertRaisesRegex(ZoneDraftError, "изменился"):
            withdraw_versions(self.conn, self.object_id, conversion["id"], conversion["id"], None, "Тест")
        self.assertEqual(tuple(self._element()), before)
        self.assertEqual(self._versions()[-1]["id"], published["version_id"])

    def test_open_draft_on_withdrawn_version_is_rebased_and_editable(self):
        conversion = self._conversion()
        published = self._publish_new_crane()
        open_id = create_draft(self.conn, self.object_id, None, "Тест")
        result = withdraw_versions(self.conn, self.object_id, conversion["id"],
                                   published["version_id"], None, "Тест")
        self.assertEqual(result["rebased_drafts"], [open_id])
        row = self.conn.execute("SELECT * FROM crane_zone_drafts WHERE id = ?", (open_id,)).fetchone()
        self.assertEqual(row["base_version_id"], conversion["id"])
        self.assertTrue(any(z["id"] < 0 for z in json.loads(row["zones_json"])))
        update_draft(self.conn, self.object_id, open_id, row["edit_token"],
                     json.loads(row["zones_json"]), json.loads(row["overrides_json"]), "Правка после отката")
        self.assertEqual(preview_draft(self.conn, self.object_id, open_id)["total"], 1)

    def test_failure_rolls_back_everything(self):
        conversion = self._conversion()
        published = self._publish_new_crane()
        before = tuple(self._element())
        drafts = self.conn.execute("SELECT COUNT(*) FROM crane_zone_drafts").fetchone()[0]
        with patch("app.crane_zone_service._apply_current", side_effect=RuntimeError("сбой")):
            with self.assertRaises(RuntimeError):
                withdraw_versions(self.conn, self.object_id, conversion["id"],
                                  published["version_id"], None, "Тест")
        self.assertEqual(tuple(self._element()), before)
        self.assertEqual(self._versions()[-1]["id"], published["version_id"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM crane_zone_drafts").fetchone()[0], drafts)


if __name__ == "__main__":
    loader = unittest.TestLoader()
    loader.testMethodPrefix = "test_"
    names = [n for n in loader.getTestCaseNames(WithdrawTest) if n not in dir(base_test.CraneZoneServiceTest)]
    suite = unittest.TestSuite(WithdrawTest(name) for name in names)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
