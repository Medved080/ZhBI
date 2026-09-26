"""Pure, repeatable conversion of a legacy crane snapshot into stance boxes.

This module has no SQL or commits. The audit and release task call the same
function, then the release task rechecks the source under BEGIN IMMEDIATE.
"""

from __future__ import annotations

import copy
from collections import Counter
from types import SimpleNamespace

from shapely.geometry import Polygon

from app.crane_zone_editor import _records, _resolved
from scripts.zone_binding import (
    bind_element_to_zones, build_stance_level_polygons,
    compute_column_tier_elevations,
)
from scripts.zone_parser import ZoneRecord


FIELDS = ("crane_zone_id", "crane_status", "stance_zone_id", "stance_status",
          "stance_elevation_mm")


class ConversionError(ValueError):
    """Source data cannot be materialized without inventing geometry."""


def _polygon_outline(poly):
    if poly is None or poly.is_empty:
        return None
    if poly.geom_type != "Polygon":
        raise ConversionError(f"Лесенка дала неподдерживаемый контур {poly.geom_type}")
    return [[float(x), float(y)] for x, y in list(poly.exterior.coords)[:-1]]


def _legacy_records(zones):
    first_crane = {z["id"]: f"{z['id']}:0" for z in zones if z["category"] == "Кран"}
    return [ZoneRecord(
        handle=f"{z['id']}:{i}", category=z["category"],
        elevation_mm=level["elevation_mm"], outline=level["outline"],
        name=z["name"], match_status=z.get("match_status") or "matched",
        parent_zone_handle=first_crane.get(z.get("parent_zone_id")),
        parent_match_status=z.get("parent_match_status") or "not_applicable",
    ) for z in zones for i, level in enumerate(z["levels"])]


def materialize_snapshot(zones: list[dict], elements: list[dict],
                         axes: dict | None = None) -> tuple[list[dict], dict]:
    """Return new zones and geometry diagnostics, without changing input.

    The old binder's single-level stair builder is used *exactly* for its
    clipping. Multi-level drawings copy the polygons selected by the old
    crane-wide snap. ``None`` windows remain absent, including after a new
    object level splits a strip.
    """
    candidate = copy.deepcopy(zones)
    cranes = {z["id"]: z for z in zones if z["category"] == "Кран"}
    stances = [z for z in zones if z["category"] == "Стоянка"]
    for stance in stances:
        if stance.get("parent_zone_id") not in cranes:
            raise ConversionError(f"У стоянки {stance['id']} отсутствует родительский кран")
    for crane in candidate:
        if crane["category"] == "Кран":
            crane["levels"] = []
            crane["report_levels"] = []
    if not stances:
        return candidate, {"empty_windows": 0, "working_levels": 0}
    # Build each crane's actual old windows first. Other cranes may introduce
    # intermediate object levels; split these windows afterwards. In
    # particular, an absent (None) stair window stays absent when split.
    column_tiers = compute_column_tier_elevations([
        SimpleNamespace(element_type=e["element_type"], elevation_mm=e["elevation_mm"])
        for e in elements
    ])
    legacy = _legacy_records(zones)
    source_windows = {}
    all_levels = set()
    for crane_id in cranes:
        members = [s for s in stances if s.get("parent_zone_id") == crane_id]
        if not members:
            continue
        crane_levels = sorted({l["elevation_mm"] for s in members for l in s["levels"]
                               if l["elevation_mm"] is not None})
        if not crane_levels:
            raise ConversionError(f"У стоянок крана {crane_id} нет числовых отметок")
        if len(crane_levels) == 1:
            if len(column_tiers) > 1 and len(members) > 1 and (
                not axes or not axes.get("numeric") or not axes.get("letter")
            ):
                raise ConversionError("Нет полной сетки осей для материализации лесенки")
            try:
                windows = build_stance_level_polygons(
                    [r for r in legacy if r.category == "Стоянка" and
                     r.parent_zone_handle == f"{crane_id}:0"] +
                    [r for r in legacy if r.category == "Кран" and r.handle == f"{crane_id}:0"],
                    (axes or {}).get("numeric", {}), (axes or {}).get("letter", {}),
                    column_tiers,
                )
            except (IndexError, ValueError, KeyError, ZeroDivisionError) as exc:
                raise ConversionError(f"Не удалось построить лесенку крана {crane_id}: {exc}") from exc
            all_levels.update(column_tiers)
            for stance in members:
                handle = f"{stance['id']}:0"
                if handle not in windows:
                    raise ConversionError(f"Нет окон лесенки для стоянки {stance['id']}")
                old = stance["levels"][0]
                source_windows[stance["id"]] = {
                    elevation: ({**old, "elevation_mm": elevation, "outline": outline}
                                if (outline := _polygon_outline(poly)) is not None else None)
                    for elevation, poly in zip(column_tiers, windows[handle])
                }
        else:
            all_levels.update(crane_levels)
            for stance in members:
                source_windows[stance["id"]] = {
                    elevation: next((l for l in stance["levels"] if l["elevation_mm"] == elevation), None)
                    for elevation in crane_levels
                }
    if not all_levels:
        raise ConversionError("Нет рабочих уровней стоянок")
    empty_windows = 0
    for zone in candidate:
        if zone["category"] != "Стоянка":
            continue
        source = source_windows[zone["id"]]
        source_levels = sorted(source)
        new_levels = []
        for elevation in sorted(all_levels):
            below = [v for v in source_levels if v <= elevation]
            active = below[-1] if below else source_levels[0]
            old = source[active]
            if old is None:
                empty_windows += 1
            else:
                new_levels.append({**old, "elevation_mm": elevation})
        zone["levels"] = new_levels
    for zone in candidate:
        if zone["category"] != "Стоянка":
            continue
        if zone.get("parent_zone_id") not in cranes:
            raise ConversionError(f"У стоянки {zone['id']} отсутствует родительский кран")
        zone["report_levels"] = []
    working = {l["elevation_mm"] for z in candidate if z["category"] == "Стоянка"
               for l in z["levels"]}
    return candidate, {"empty_windows": empty_windows, "working_levels": len(working)}


def build_conversion(zones: list[dict], elements: list[dict], axes: dict | None,
                     current: dict[int, dict], sources: dict[int, str] | None = None) -> dict:
    """One pure source of truth for the preflight audit and actual migration."""
    candidate, geometry = materialize_snapshot(zones, elements, axes)
    by_id = {z["id"]: z for z in candidate}
    records = _records(candidate)
    sources = sources or {}
    assignments, overrides, reasons = [], {}, Counter()
    for element in elements:
        element_id = element["id"]
        old = current[element_id]
        bound = bind_element_to_zones(
            element["element_type"], element["x"], element["y"], element.get("outline"),
            element["elevation_mm"], records, stance_mode="union",
        )
        crane_id, _, crane_status = _resolved(bound["Кран"], by_id)
        stance_id, elevation, stance_status = _resolved(bound["Стоянка"], by_id)
        new = {"element_id": element_id, "element_uid": element["element_uid"],
               "crane_zone_id": crane_id, "crane_status": crane_status,
               "stance_zone_id": stance_id, "stance_status": stance_status,
               "stance_elevation_mm": elevation, "source": "geometry"}
        differences = [field for field in FIELDS if old[field] != new[field]]
        old_source = sources.get(element_id)
        if differences or old_source == "manual":
            source = "manual" if old_source == "manual" else "conversion"
            reason = ("прежнее ручное назначение" if source == "manual" else
                      "расходятся: " + ", ".join(differences))
            overrides[str(element_id)] = {field: old[field] for field in FIELDS} | {
                "source": source, "reason": reason,
            }
            new.update({field: old[field] for field in FIELDS})
            new["source"] = source
            if source == "conversion":
                for field in differences:
                    reasons[field] += 1
                if differences == ["stance_elevation_mm"]:
                    reasons["only_elevation"] += 1
                if all(f in ("crane_status", "stance_status") for f in differences):
                    reasons["only_status"] += 1
        assignments.append(new)
    for zone in candidate:
        if zone["category"] != "Стоянка":
            continue
        working = {l["elevation_mm"] for l in zone["levels"]}
        reports = {a["stance_elevation_mm"] for a in assignments
                   if a["stance_zone_id"] == zone["id"] and a["stance_elevation_mm"] is not None}
        zone["report_levels"] = sorted(reports - working)
    return {"zones": candidate, "assignments": assignments,
            "overrides": overrides, "reasons": dict(reasons), "geometry": geometry}
