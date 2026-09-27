"""Focused synthetic checks for the new and frozen legacy geometry rules."""

from types import SimpleNamespace

from app.crane_zone_conversion import materialize_snapshot
from app.crane_zone_editor import ZoneDraftError, _records, validate_zones
from app.crane_zone_import import build_candidate
from scripts.zone_binding import bind_element_to_zones
from scripts.zone_parser import ZoneRecord


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def record(handle, category, elevation, outline, parent=None, name=None):
    return ZoneRecord(handle, category, elevation, outline, name=name or handle,
                      match_status="matched", parent_zone_handle=parent,
                      parent_match_status="matched" if parent else "not_applicable")


def zone(zone_id, category, parent, levels, number=1):
    return {"id": zone_id, "category": category, "name": f"{category} {number}",
            "number": number, "parent_zone_id": parent, "match_status": "matched",
            "parent_match_status": "matched" if parent else "not_applicable",
            "source_file": "synthetic", "dxf_handle": str(zone_id),
            "levels": [{"elevation_mm": elevation, "outline": outline,
                        "source_file": "synthetic", "dxf_handle": str(zone_id)}
                       for elevation, outline in levels]}


def test_union_levels():
    zones = [record("1:0", "Кран", None, []), record("2:0", "Кран", None, []),
             record("11:0", "Стоянка", 0, rect(0, 0, 10, 10), "1:0"),
             record("22:0", "Стоянка", 3000, rect(0, 0, 10, 10), "2:0")]
    def bind(kind, elevation, x=5, outline=None):
        return bind_element_to_zones(kind, x, 5, outline, elevation, zones,
                                     stance_mode="union")
    assert bind("Колонна", 2999)["Кран"].zone_handle == "1:0"
    assert bind("Колонна", 3000)["Кран"].zone_handle == "2:0"
    assert bind("Ригель", 3000, outline=rect(1, 1, 9, 9))["Стоянка"].zone_handle == "11:0"
    assert bind("Плита перекрытия", 3000, outline=rect(1, 1, 9, 9))["Стоянка"].zone_handle == "11:0"
    assert bind("Колонна", -100)["Стоянка"].zone_handle == "11:0"
    assert bind("Колонна", None)["Кран"].status == "not_applicable"
    assert bind("Колонна", None)["Стоянка"].status == "not_applicable"


def test_point_boundary_and_area():
    zones = [record("1:0", "Кран", None, []),
             record("11:0", "Стоянка", 0, rect(0, 0, 10, 10), "1:0"),
             record("12:0", "Стоянка", 0, rect(10, 0, 20, 10), "1:0")]
    boundary = bind_element_to_zones("Колонна", 10, 5, None, 0, zones, stance_mode="union")
    assert boundary["Стоянка"].status == boundary["Кран"].status == "needs_review"
    weak = bind_element_to_zones("Панель", 10, 5, rect(8, 0, 12, 10), 0, zones,
                                  stance_mode="union")
    assert weak["Стоянка"].status == "needs_review"


def test_old_crane_wide_snap():
    old = [record("1:0", "Кран", None, rect(0, 0, 20, 10)),
           record("11:0", "Стоянка", 0, rect(0, 0, 10, 10), "1:0"),
           record("12:0", "Стоянка", 3000, rect(10, 0, 20, 10), "1:0")]
    result = bind_element_to_zones("Колонна", 5, 5, None, 4000, old)
    assert result["Кран"].status == "matched"
    assert result["Стоянка"].status == "unmatched"


def test_global_multitier_disables_staircase():
    source = [zone(1, "Кран", None, [(None, rect(0, 0, 20, 10))]),
              zone(11, "Стоянка", 1, [(0, rect(0, 0, 10, 10))], 1),
              zone(12, "Стоянка", 1, [(0, rect(10, 0, 20, 10))], 2),
              zone(2, "Кран", None, [(None, rect(30, 0, 40, 10))], 2),
              zone(21, "Стоянка", 2, [(4000, rect(30, 0, 40, 10))], 1)]
    old_records = [record("1:0", "Кран", None, rect(0, 0, 20, 10)),
                   record("11:0", "Стоянка", 0, rect(0, 0, 10, 10), "1:0"),
                   record("12:0", "Стоянка", 0, rect(10, 0, 20, 10), "1:0"),
                   record("2:0", "Кран", None, rect(30, 0, 40, 10)),
                   record("21:0", "Стоянка", 4000, rect(30, 0, 40, 10), "2:0")]
    old_match = bind_element_to_zones("Колонна", 5, 5, None, 3000, old_records)
    assert old_match["Стоянка"].zone_handle == "11:0"
    elements = [{"element_type": "Колонна", "elevation_mm": e} for e in (0, 3000, 6000)]
    axes = {"numeric": {"1": 0, "2": 10, "3": 20, "4": 30, "5": 40},
            "letter": {"A": 0, "B": 10}}
    converted, meta = materialize_snapshot(
        source, elements, axes)
    first = next(z for z in converted if z["id"] == 11)
    assert {l["elevation_mm"] for l in first["levels"]} == {0, 4000}
    assert meta["empty_windows"] == 0
    new_match = bind_element_to_zones("Колонна", 5, 5, None, 3000,
                                      _records(converted), stance_mode="union")
    assert new_match["Стоянка"].zone_handle == "11:0"

    drawing = [record("C1", "Кран", None, rect(0, 0, 20, 10), name="Кран 1"),
               record("S11", "Стоянка", 0, rect(0, 0, 10, 10), "C1", "Стоянка 1"),
               record("S12", "Стоянка", 0, rect(10, 0, 20, 10), "C1", "Стоянка 2"),
               record("C2", "Кран", None, rect(30, 0, 40, 10), name="Кран 2"),
               record("S21", "Стоянка", 4000, rect(30, 0, 40, 10), "C2", "Стоянка 1")]
    grid = SimpleNamespace(numeric_axes=axes["numeric"], letter_axes=axes["letter"])
    imported = build_candidate([], drawing, "two-cranes.dxf", grid,
                               [SimpleNamespace(**e) for e in elements])
    imported_first = next(z for z in imported if z["category"] == "Стоянка"
                          and z["name"] == "Стоянка 1" and z["parent_zone_id"] ==
                          next(c["id"] for c in imported if c["category"] == "Кран"
                               and c["number"] == 1))
    assert {l["elevation_mm"] for l in imported_first["levels"]} == {0, 4000}
    imported_match = bind_element_to_zones("Колонна", 5, 5, None, 3000,
                                           _records(imported), stance_mode="union")
    assert imported_match["Стоянка"].zone_handle.startswith(f"{imported_first['id']}:")


def test_single_physical_level_keeps_empty_stair_windows():
    source = [zone(1, "Кран", None, [(None, rect(0, 0, 20, 10))]),
              zone(11, "Стоянка", 1, [(0, rect(0, 0, 10, 10))], 1),
              zone(12, "Стоянка", 1, [(0, rect(10, 0, 20, 10))], 2)]
    elements = [{"element_type": "Колонна", "elevation_mm": e} for e in (0, 3000, 6000)]
    axes = {"numeric": {"1": 0, "2": 10, "3": 20}, "letter": {"A": 0, "B": 10}}
    converted, meta = materialize_snapshot(source, elements, axes)
    first = next(z for z in converted if z["id"] == 11)
    assert {l["elevation_mm"] for l in first["levels"]} == {0}
    assert meta["empty_windows"] > 0

    drawing = [record("C1", "Кран", None, rect(0, 0, 20, 10), name="Кран 1"),
               record("S11", "Стоянка", 0, rect(0, 0, 10, 10), "C1", "Стоянка 1"),
               record("S12", "Стоянка", 0, rect(10, 0, 20, 10), "C1", "Стоянка 2")]
    grid = SimpleNamespace(numeric_axes=axes["numeric"], letter_axes=axes["letter"])
    imported = build_candidate([], drawing, "one-level.dxf", grid,
                               [SimpleNamespace(**e) for e in elements])
    imported_first = next(z for z in imported if z["name"] == "Стоянка 1")
    assert {l["elevation_mm"] for l in imported_first["levels"]} == {0}


def test_validation_across_cranes():
    cranes = [zone(-1, "Кран", None, []), zone(-2, "Кран", None, [], 2)]
    touching = cranes + [zone(-11, "Стоянка", -1, [(0, rect(0, 0, 10, 10))]),
                         zone(-22, "Стоянка", -2, [(0, rect(10, 0, 20, 10))])]
    validate_zones(touching, [])
    touching[-1]["levels"][0]["outline"] = rect(9, 0, 20, 10)
    try:
        validate_zones(touching, [])
    except ZoneDraftError as exc:
        assert "пересекаются" in str(exc)
    else:
        raise AssertionError("Пересечение стоянок разных кранов пропущено")


if __name__ == "__main__":
    test_union_levels()
    test_point_boundary_and_area()
    test_old_crane_wide_snap()
    test_global_multitier_disables_staircase()
    test_single_physical_level_keeps_empty_stair_windows()
    test_validation_across_cranes()
    print("crane stance union: 6 synthetic groups OK")
