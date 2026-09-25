"""Подготовка редакции кранов/стоянок без записи в рабочие таблицы.

Здесь нет HTTP и COMMIT: одна и та же проверка и привязка вызывается для
предпросмотра и повторно внутри атомарной публикации. Зональную геометрию
считает штатный импортный binder, не его упрощённая копия.
"""

import json
import math
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from zone_binding import (  # noqa: E402
    TIER_CAPPING_TYPES, bind_element_to_zones, build_stance_level_polygons,
    compute_column_tier_elevations,
)
from zone_parser import ZoneRecord  # noqa: E402


class ZoneDraftError(ValueError):
    pass


def _zone_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value == 0:
        raise ZoneDraftError("У каждой зоны нужен целочисленный id (новые: отрицательные)")
    return value


def stance_containment_issues(zones: list[dict]) -> list[str]:
    """Понятные оператору причины, мешающие публикации черновика."""
    by_id = {zone["id"]: zone for zone in zones}
    issues = []
    for zone in zones:
        if zone["category"] != "Стоянка":
            continue
        crane = by_id.get(zone["parent_zone_id"])
        if crane is None or crane["category"] != "Кран":
            continue
        crane_polys = [Polygon(level["outline"]) for level in crane["levels"]]
        for level in zone["levels"]:
            if not any(poly.covers(Point(point)) for poly in crane_polys for point in level["outline"]):
                tier = (f" на ярусе +{level['elevation_mm']} мм"
                        if level["elevation_mm"] is not None else "")
                issues.append(
                    f"«{zone['name']}»{tier} оказалась вне зоны «{crane['name']}». "
                    "Расширьте кран или переместите стоянку внутрь него, затем проверьте редакцию."
                )
    return issues


def validate_zones(zones: list[dict], base_zones: list[dict], *,
                   allow_outside_stances: bool = False) -> dict[int, dict]:
    """Сверяет весь снимок; старые зоны нельзя молча потерять из черновика."""
    if not isinstance(zones, list):
        raise ZoneDraftError("Список зон должен быть массивом")
    if len(zones) > 2000:
        raise ZoneDraftError("В черновике слишком много зон")
    original = {_zone_id(z["id"]): z for z in base_zones}
    by_id = {}
    names = set()
    for zone in zones:
        if not isinstance(zone, dict):
            raise ZoneDraftError("Зона должна быть объектом")
        zone_id = _zone_id(zone.get("id"))
        if zone_id in by_id:
            raise ZoneDraftError(f"Зона {zone_id} повторяется")
        if zone_id > 0 and zone_id not in original:
            raise ZoneDraftError(f"Зона {zone_id} не входит в исходную редакцию")
        if zone_id < 0 and zone_id in original:
            raise ZoneDraftError("Новая зона должна иметь новый временный id")
        category = zone.get("category")
        if category not in ("Кран", "Стоянка"):
            raise ZoneDraftError(f"Недопустимая категория зоны {zone_id}")
        if zone_id in original and category != original[zone_id]["category"]:
            raise ZoneDraftError("Тип существующей зоны менять нельзя")
        number = zone.get("number")
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise ZoneDraftError(f"У зоны {zone_id} нужен положительный номер")
        name = zone.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ZoneDraftError(f"У зоны {zone_id} нужно название до 200 знаков")
        levels = zone.get("levels")
        if not isinstance(levels, list) or not levels or len(levels) > 100:
            raise ZoneDraftError(f"У зоны {zone_id} нужен хотя бы один ярус")
        elevations = set()
        for level in levels:
            if not isinstance(level, dict):
                raise ZoneDraftError(f"Ярус зоны {zone_id} должен быть объектом")
            elevation = level.get("elevation_mm")
            if elevation is not None and (isinstance(elevation, bool) or not isinstance(elevation, int)):
                raise ZoneDraftError(f"Отметка яруса зоны {zone_id} должна быть целым числом")
            if elevation in elevations:
                raise ZoneDraftError(f"У зоны {zone_id} повторяется отметка {elevation}")
            elevations.add(elevation)
            outline = level.get("outline")
            if not isinstance(outline, list) or not 3 <= len(outline) <= 10000:
                raise ZoneDraftError(f"У яруса зоны {zone_id} неверное количество точек")
            for point in outline:
                if (not isinstance(point, (list, tuple)) or len(point) != 2 or
                        any(isinstance(v, bool) or not isinstance(v, (int, float)) or
                            not math.isfinite(v) for v in point)):
                    raise ZoneDraftError(f"У яруса зоны {zone_id} недопустимая координата")
            polygon = Polygon(outline)
            if not polygon.is_valid or polygon.area <= 0:
                raise ZoneDraftError(f"Контур яруса зоны {zone_id} самопересекается или пуст")
        by_id[zone_id] = zone
    missing = set(original) - set(by_id)
    if missing:
        raise ZoneDraftError(
            "Удаление зон пока не поддерживается: " + ", ".join(map(str, sorted(missing)[:8]))
        )
    for zone_id, zone in by_id.items():
        parent = zone.get("parent_zone_id")
        if zone["category"] == "Кран":
            if parent is not None:
                raise ZoneDraftError(f"Кран {zone_id} не может быть вложен в другую зону")
        elif parent not in by_id or by_id[parent]["category"] != "Кран":
            raise ZoneDraftError(f"Стоянка {zone_id} должна иметь существующий кран")
        key = (zone["category"], parent if zone["category"] == "Стоянка" else None,
               zone["number"])
        if key in names:
            raise ZoneDraftError(f"Номер {zone['number']} повторяется в одном кране")
        names.add(key)
    if not allow_outside_stances:
        issues = stance_containment_issues(zones)
        if issues:
            raise ZoneDraftError(issues[0])
    # Соседние зоны одного яруса могут касаться рёбрами, но не должны
    # накладываться площадью. Исторические DXF-контуры местами уже имеют
    # небольшие наложения: сохранять их без ухудшения разрешаем, увеличение
    # площади пересечения (или новый конфликт) — нет. Стоянка и её кран
    # намеренно вложены; стоянки разных кранов здесь не сопоставляются.
    peers = list(by_id.values())
    highest = max((level["elevation_mm"] or 0 for zone in peers for level in zone["levels"]), default=0) + 3000

    def segments(zone):
        ordered = sorted(zone["levels"], key=lambda item: item["elevation_mm"] or 0)
        return [((level["elevation_mm"] or 0),
                 (ordered[index + 1]["elevation_mm"] or 0) if index + 1 < len(ordered) else highest,
                 Polygon(level["outline"])) for index, level in enumerate(ordered)]

    def old_polygon_at(zone, elevation):
        if zone is None:
            return None
        eligible = [level for level in zone["levels"] if (level["elevation_mm"] or 0) <= elevation]
        if not eligible:
            return None
        return Polygon(max(eligible, key=lambda item: item["elevation_mm"] or 0)["outline"])

    for index, zone in enumerate(peers):
        for other in peers[index + 1:]:
            if zone["category"] != other["category"] or (
                zone["category"] == "Стоянка" and zone["parent_zone_id"] != other["parent_zone_id"]
            ):
                continue
            old_zone, old_other = original.get(zone["id"]), original.get(other["id"])
            for start, end, poly in segments(zone):
                for peer_start, peer_end, peer_poly in segments(other):
                    if max(start, peer_start) >= min(end, peer_end):
                        continue  # грани на границе ярусов могут касаться
                    area = poly.intersection(peer_poly).area
                    midpoint = (max(start, peer_start) + min(end, peer_end)) / 2
                    old_a, old_b = old_polygon_at(old_zone, midpoint), old_polygon_at(old_other, midpoint)
                    baseline = old_a.intersection(old_b).area if old_a is not None and old_b is not None else 0
                    if area > max(1, baseline + 1):
                        raise ZoneDraftError(
                            f"Зоны «{zone['name']}» и «{other['name']}» пересекаются на ярусе "
                            f"{start if zone['category'] == 'Стоянка' else 'без отметки'}. "
                            "Уменьшите контур до касания границ."
                        )
    return by_id


def validate_overrides(overrides: dict, by_id: dict[int, dict], element_ids: set[int]) -> dict[int, dict]:
    if not isinstance(overrides, dict):
        raise ZoneDraftError("Ручные назначения должны быть объектом")
    normalized = {}
    for raw_id, item in overrides.items():
        try:
            element_id = int(raw_id)
        except (TypeError, ValueError) as exc:
            raise ZoneDraftError("Недопустимый id изделия в назначении") from exc
        if str(element_id) != str(raw_id) or element_id not in element_ids:
            raise ZoneDraftError(f"Изделие {raw_id} не входит в текущий объект")
        if not isinstance(item, dict):
            raise ZoneDraftError(f"Назначение изделия {raw_id} должно быть объектом")
        crane_id, stance_id = item.get("crane_zone_id"), item.get("stance_zone_id")
        if crane_id is not None and (crane_id not in by_id or by_id[crane_id]["category"] != "Кран"):
            raise ZoneDraftError(f"Неизвестный кран у изделия {raw_id}")
        if stance_id is not None and (stance_id not in by_id or by_id[stance_id]["category"] != "Стоянка"):
            raise ZoneDraftError(f"Неизвестная стоянка у изделия {raw_id}")
        if stance_id is not None and by_id[stance_id]["parent_zone_id"] != crane_id:
            raise ZoneDraftError(f"Стоянка изделия {raw_id} не принадлежит его крану")
        normalized[element_id] = {"crane_zone_id": crane_id, "stance_zone_id": stance_id}
    return normalized


def _records(zones: list[dict]) -> list[ZoneRecord]:
    first_crane_level = {
        z["id"]: f"{z['id']}:0" for z in zones if z["category"] == "Кран"
    }
    return [
        ZoneRecord(
            handle=f"{z['id']}:{index}", category=z["category"],
            elevation_mm=level["elevation_mm"],
            outline=[tuple(p) for p in level["outline"]],
            name=z["name"], match_status=z.get("match_status") or "matched",
            parent_zone_handle=first_crane_level.get(z.get("parent_zone_id")),
            parent_match_status="matched" if z["category"] == "Стоянка" else "not_applicable",
        )
        for z in zones for index, level in enumerate(z["levels"])
    ]


def _resolved(result, by_id):
    if not result.zone_handle:
        return None, None, result.status
    zone_id, level_index = map(int, result.zone_handle.split(":"))
    return zone_id, by_id[zone_id]["levels"][level_index]["elevation_mm"], result.status


def preview_assignments(conn: sqlite3.Connection, object_id: int,
                        zones: list[dict], base_zones: list[dict], overrides: dict) -> dict:
    """Все привязки для будущей редакции; без INSERT/UPDATE/COMMIT.

    Для одного физического яруса используем ТУ ЖЕ «лесенку» по осям,
    что импорт чертежа; если сетка отсутствует, даём явный отказ.
    """
    by_id = validate_zones(zones, base_zones)
    stance_elevations = {
        l["elevation_mm"] for z in zones if z["category"] == "Стоянка"
        for l in z["levels"] if l["elevation_mm"] is not None
    }
    elements = conn.execute(
        "SELECT id, element_uid, element_type, x, y, outline_json, elevation_mm, "
        "zone_crane_id, zone_crane_status, zone_stance_id, zone_stance_status "
        "FROM elements WHERE object_id = ? AND is_current = 1 ORDER BY id", (object_id,),
    ).fetchall()
    manual = validate_overrides(overrides, by_id, {e["id"] for e in elements})
    records = _records(zones)
    stance_level_polys = tier_elevations = None
    if len(stance_elevations) <= 1 and any(z["category"] == "Стоянка" for z in zones):
        drawing = conn.execute(
            "SELECT source_file FROM object_drawings WHERE object_id = ? "
            "AND is_current = 1 LIMIT 1", (object_id,),
        ).fetchone()
        source_file = drawing["source_file"] if drawing else next(
            (z.get("source_file") for z in zones if z.get("source_file")), None
        )
        axes = {"numeric": {}, "letter": {}}
        if source_file:
            for axis in conn.execute(
                "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?", (source_file,),
            ):
                if axis["kind"] in axes:
                    axes[axis["kind"]][axis["label"]] = axis["coord"]
        if not axes["numeric"] or not axes["letter"]:
            raise ZoneDraftError(
                "У чертежа с одним ярусом стоянок нет полной сетки осей; "
                "невозможно надёжно пересчитать «лесенку» стоянок."
            )
        tier_elevations = compute_column_tier_elevations([
            SimpleNamespace(element_type=e["element_type"], elevation_mm=e["elevation_mm"])
            for e in elements
        ])
        try:
            stance_level_polys = build_stance_level_polygons(
                records, axes["numeric"], axes["letter"], tier_elevations,
            )
        except (IndexError, ValueError, KeyError, ZeroDivisionError) as exc:
            raise ZoneDraftError("Не удалось построить ярусы стоянок по сетке осей") from exc
    changed = Counter()
    assignments = []
    for element in elements:
        outline = json.loads(element["outline_json"]) if element["outline_json"] else None
        bound = bind_element_to_zones(
            element["element_type"], element["x"], element["y"], outline,
            element["elevation_mm"], records,
            stance_level_polys=stance_level_polys, tier_elevations=tier_elevations,
        )
        crane_id, _, crane_status = _resolved(bound["Кран"], by_id)
        stance_id, stance_elevation, stance_status = _resolved(bound["Стоянка"], by_id)
        source = "geometry"
        if element["id"] in manual:
            source = "manual"
            crane_id = manual[element["id"]]["crane_zone_id"]
            stance_id = manual[element["id"]]["stance_zone_id"]
            crane_status = "matched" if crane_id is not None else "unmatched"
            stance_status = "matched" if stance_id is not None else "unmatched"
            # Ярус ручной стоянки определяется отметкой изделия отдельно от
            # геометрии. Без однозначной отметки не обещаем точный отчёт.
            if stance_id is not None:
                strict_below = element["element_type"] in TIER_CAPPING_TYPES
                levels = [l["elevation_mm"] for l in by_id[stance_id]["levels"]
                          if l["elevation_mm"] is not None and
                          element["elevation_mm"] is not None and
                          (l["elevation_mm"] < element["elevation_mm"] if strict_below
                           else l["elevation_mm"] <= element["elevation_mm"])]
                if not levels:
                    raise ZoneDraftError(f"Нет подходящего яруса у стоянки изделия {element['id']}")
                stance_elevation = max(levels)
            else:
                stance_elevation = None
        if crane_id != element["zone_crane_id"]:
            changed["crane"] += 1
        if stance_id != element["zone_stance_id"]:
            changed["stance"] += 1
        if crane_status == "needs_review" or stance_status == "needs_review":
            changed["needs_review"] += 1
        assignments.append({
            "element_id": element["id"], "element_uid": element["element_uid"],
            "crane_zone_id": crane_id, "crane_status": crane_status,
            "stance_zone_id": stance_id, "stance_status": stance_status,
            "stance_elevation_mm": stance_elevation, "source": source,
        })
    return {"assignments": assignments, "counts": dict(changed), "total": len(assignments)}
