"""Безопасность черновика и ручных назначений без рабочей БД."""

import copy
import unittest

from app.crane_zone_editor import ZoneDraftError, validate_overrides, validate_zones


def square(x, y, size):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]


class CraneZoneDraftTest(unittest.TestCase):
    def setUp(self):
        self.baseline = [
            {"id": 1, "category": "Кран", "number": 1, "name": "Кран 1",
             "parent_zone_id": None, "levels": [{"elevation_mm": None, "outline": square(0, 0, 10)}]},
            {"id": 2, "category": "Стоянка", "number": 1, "name": "Стоянка 1",
             "parent_zone_id": 1, "levels": [{"elevation_mm": 0, "outline": square(0, 0, 5)}]},
        ]

    def test_add_nested_crane_and_stance(self):
        draft = copy.deepcopy(self.baseline)
        draft.extend([
            {"id": -1, "category": "Кран", "number": 2, "name": "Кран 2",
             "parent_zone_id": None, "levels": [{"elevation_mm": None, "outline": square(20, 0, 10)}]},
            {"id": -2, "category": "Стоянка", "number": 1, "name": "Стоянка 1",
             "parent_zone_id": -1, "levels": [{"elevation_mm": 0, "outline": square(20, 0, 5)}]},
        ])
        by_id = validate_zones(draft, self.baseline)
        self.assertEqual(validate_overrides({"44": {"crane_zone_id": -1, "stance_zone_id": -2}},
                                            by_id, {44})[44]["stance_zone_id"], -2)

    def test_stance_cannot_belong_to_another_crane(self):
        by_id = validate_zones(self.baseline, self.baseline)
        with self.assertRaisesRegex(ZoneDraftError, "не принадлежит"):
            validate_overrides({"44": {"crane_zone_id": None, "stance_zone_id": 2}}, by_id, {44})

    def test_foreign_element_refused(self):
        by_id = validate_zones(self.baseline, self.baseline)
        with self.assertRaisesRegex(ZoneDraftError, "не входит"):
            validate_overrides({"45": {"crane_zone_id": 1, "stance_zone_id": 2}}, by_id, {44})

    def test_missing_old_zone_refused(self):
        with self.assertRaisesRegex(ZoneDraftError, "Удаление"):
            validate_zones(self.baseline[:1], self.baseline)

    def test_self_intersection_refused(self):
        draft = copy.deepcopy(self.baseline)
        draft[1]["levels"][0]["outline"] = [[0, 0], [5, 5], [0, 5], [5, 0]]
        with self.assertRaisesRegex(ZoneDraftError, "самопересекается"):
            validate_zones(draft, self.baseline)

    def test_duplicate_number_in_same_crane_refused(self):
        draft = copy.deepcopy(self.baseline)
        duplicate = copy.deepcopy(draft[1])
        duplicate["id"] = -1
        draft.append(duplicate)
        with self.assertRaisesRegex(ZoneDraftError, "повторяется"):
            validate_zones(draft, self.baseline)

    def test_touching_peer_stance_is_allowed_but_overlap_is_not(self):
        draft = copy.deepcopy(self.baseline)
        draft.append({"id": -1, "category": "Стоянка", "number": 2,
                      "name": "Стоянка 2", "parent_zone_id": 1,
                      "levels": [{"elevation_mm": 0, "outline": square(5, 0, 5)}]})
        validate_zones(draft, self.baseline)
        draft[-1]["levels"][0]["outline"] = square(4, 0, 5)
        with self.assertRaisesRegex(ZoneDraftError, "пересекаются"):
            validate_zones(draft, self.baseline)

    def test_existing_overlap_may_shrink_but_not_grow(self):
        baseline = copy.deepcopy(self.baseline)
        baseline.append({"id": 3, "category": "Стоянка", "number": 2,
                         "name": "Стоянка 2", "parent_zone_id": 1,
                         "levels": [{"elevation_mm": 0, "outline": square(4, 0, 5)}]})
        validate_zones(baseline, baseline)
        draft = copy.deepcopy(baseline)
        draft[-1]["levels"][0]["outline"] = square(5, 0, 5)
        validate_zones(draft, baseline)
        draft[-1]["levels"][0]["outline"] = square(3, 0, 5)
        with self.assertRaisesRegex(ZoneDraftError, "пересекаются"):
            validate_zones(draft, baseline)

    def test_stance_with_one_level_cannot_run_through_upper_peer(self):
        baseline = copy.deepcopy(self.baseline)
        baseline[1]["levels"].append({"elevation_mm": 3000, "outline": square(5, 0, 5)})
        draft = copy.deepcopy(baseline)
        draft.append({"id": -1, "category": "Стоянка", "number": 2,
                      "name": "Новая стоянка", "parent_zone_id": 1,
                      "levels": [{"elevation_mm": 0, "outline": square(5, 0, 5)}]})
        with self.assertRaisesRegex(ZoneDraftError, "пересекаются"):
            validate_zones(draft, baseline)


if __name__ == "__main__":
    unittest.main()
