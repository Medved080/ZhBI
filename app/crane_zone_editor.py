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
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from zone_binding import (  # noqa: E402
    TIER_CAPPING_TYPES, bind_element_to_zones, object_stance_levels,
)
from zone_parser import ZoneRecord  # noqa: E402


class ZoneDraftError(ValueError):
    pass


def _zone_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value == 0:
        raise ZoneDraftError("У каждой зоны нужен целочисленный id (новые: отрицательные)")
    return value


def validate_zones(zones: list[dict], base_zones: list[dict], *,
                   allow_geometry_errors: bool = False,
                   allow_deletions: bool = False) -> dict[int, dict]:
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
        if not isinstance(levels, list) or len(levels) > 100:
            raise ZoneDraftError(f"У зоны {zone_id} неверный список ярусов")
        if category == "Кран" and levels:
            raise ZoneDraftError(f"Кран {zone_id} — справочник; рабочие контуры задаются стоянками")
        if category == "Стоянка" and not levels:
            raise ZoneDraftError(f"У стоянки {zone_id} нужен хотя бы один рабочий ярус")
        references = zone.get("report_levels", [])
        if not isinstance(references, list) or len(references) > 100 or any(
            v is not None and (isinstance(v, bool) or not isinstance(v, int))
            for v in references
        ) or len(references) != len(set(references)):
            raise ZoneDraftError(f"У зоны {zone_id} неверные служебные отметки")
        if category == "Кран" and references:
            raise ZoneDraftError(f"Кран {zone_id} не имеет отчётных ярусов")
        elevations = set()
        for level in levels:
            if not isinstance(level, dict):
                raise ZoneDraftError(f"Ярус зоны {zone_id} должен быть объектом")
            elevation = level.get("elevation_mm")
            if elevation is None or isinstance(elevation, bool) or not isinstance(elevation, int):
                raise ZoneDraftError(f"Отметка яруса зоны {zone_id} должна быть целым числом")
            if elevation in elevations:
                raise ZoneDraftError(f"У зоны {zone_id} повторяется отметка {elevation}")
            elevations.add(elevation)
            upper = level.get("upper_elevation_mm")
            if upper is not None and (isinstance(upper, bool) or not isinstance(upper, int)
                                      or upper <= elevation):
                raise ZoneDraftError(f"Верхняя отметка яруса зоны {zone_id} должна быть выше нижней")
            outline = level.get("outline")
            if not isinstance(outline, list) or not 3 <= len(outline) <= 10000:
                raise ZoneDraftError(f"У яруса зоны {zone_id} неверное количество точек")
            for point in outline:
                if (not isinstance(point, (list, tuple)) or len(point) != 2 or
                        any(isinstance(v, bool) or not isinstance(v, (int, float)) or
                            not math.isfinite(v) for v in point)):
                    raise ZoneDraftError(f"У яруса зоны {zone_id} недопустимая координата")
            polygon = Polygon(outline)
            if not allow_geometry_errors and (not polygon.is_valid or polygon.area <= 0):
                raise ZoneDraftError(f"Контур яруса зоны {zone_id} самопересекается или пуст")
        by_id[zone_id] = zone
    missing = set(original) - set(by_id)
    if missing and not allow_deletions:
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
    if allow_geometry_errors:
        return by_id
    # Без заданного верха ярус действует до следующего уровня всего объекта.
    # Проверяем пересечение объёмов, включая разные нижние отметки.
    peers = [z for z in by_id.values() if z["category"] == "Стоянка"]
    levels = sorted({l["elevation_mm"] for z in peers for l in z["levels"]})
    bands = [(z, l, Polygon(l["outline"]), l["elevation_mm"],
              l["upper_elevation_mm"] if l.get("upper_elevation_mm") is not None else
              next((v for v in levels if v > l["elevation_mm"]), math.inf))
             for z in peers for l in z["levels"]]
    for index, (zone, _, poly, lower, upper) in enumerate(bands):
        for other, peer, peer_poly, peer_lower, peer_upper in bands[index + 1:]:
            if lower >= peer_upper or peer_lower >= upper:
                continue
            if zone["id"] == other["id"]:
                raise ZoneDraftError(f"Ярусы стоянки «{zone['name']}» перекрываются по высоте")
            area = poly.intersection(peer_poly).area
            old_a = next((l for l in original.get(zone["id"], {}).get("levels", [])
                          if l["elevation_mm"] == lower), None)
            old_b = next((l for l in original.get(other["id"], {}).get("levels", [])
                          if l["elevation_mm"] == peer_lower), None)
            baseline = (Polygon(old_a["outline"]).intersection(Polygon(old_b["outline"])).area
                        if old_a and old_b and lower == peer_lower else 0)
            if area > max(1, baseline + 1):
                raise ZoneDraftError(
                    f"Стоянки «{zone['name']}» и «{other['name']}» пересекаются "
                    f"между отметками {max(lower, peer_lower)} и {min(upper, peer_upper)} мм. "
                    "Уменьшите контуры до касания."
                )
    return by_id


def validate_overrides(overrides: dict, by_id: dict[int, dict],
                       current: dict[int, dict]) -> dict[int, dict]:
    if not isinstance(overrides, dict):
        raise ZoneDraftError("Ручные назначения должны быть объектом")
    normalized = {}
    for raw_id, item in overrides.items():
        try:
            element_id = int(raw_id)
        except (TypeError, ValueError) as exc:
            raise ZoneDraftError("Недопустимый id изделия в назначении") from exc
        if str(element_id) != str(raw_id) or element_id not in current:
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
        source = item.get("source", "manual")
        if source not in ("manual", "conversion"):
            raise ZoneDraftError(f"Неизвестный источник назначения изделия {raw_id}")
        normalized_item = {"crane_zone_id": crane_id, "stance_zone_id": stance_id,
                           "source": source}
        full_fields = ("crane_zone_id", "crane_status", "stance_zone_id",
                       "stance_status", "stance_elevation_mm")
        has_full = all(field in item for field in full_fields)
        if source == "conversion" and not has_full:
            raise ZoneDraftError(f"Исключение изделия {raw_id} потеряло сохранённые поля")
        if has_full:
            saved = {field: item[field] for field in full_fields}
            matches_current = all(saved[field] == current[element_id][field] for field in full_fields)
            if source == "conversion" and not matches_current:
                raise ZoneDraftError(
                    f"Исключение изделия {raw_id} изменено: снимите его явно или переназначьте вручную"
                )
            if matches_current:
                normalized_item.update(saved)
                normalized_item["preserve_full"] = True
                if source == "conversion":
                    reason = item.get("reason")
                    if not isinstance(reason, str) or not reason or len(reason) > 500:
                        raise ZoneDraftError(f"У исключения изделия {raw_id} отсутствует причина")
                    normalized_item["reason"] = reason
        normalized[element_id] = normalized_item
    return normalized


def _records(zones: list[dict]) -> list[ZoneRecord]:
    first_crane_level = {
        z["id"]: f"{z['id']}:0" for z in zones if z["category"] == "Кран"
    }
    records = [ZoneRecord(
        handle=handle, category="Кран", elevation_mm=None, outline=[],
        name=next(z["name"] for z in zones if z["id"] == zone_id),
        match_status="matched",
    ) for zone_id, handle in first_crane_level.items()]
    records.extend([
        ZoneRecord(
            handle=f"{z['id']}:{index}", category=z["category"],
            elevation_mm=level["elevation_mm"],
            upper_elevation_mm=level.get("upper_elevation_mm"),
            outline=[tuple(p) for p in level["outline"]],
            name=z["name"], match_status=z.get("match_status") or "matched",
            parent_zone_handle=first_crane_level.get(z.get("parent_zone_id")),
            parent_match_status="matched" if z["category"] == "Стоянка" else "not_applicable",
        )
        for z in zones if z["category"] == "Стоянка"
        for index, level in enumerate(z["levels"])
    ])
    return records


def _resolved(result, by_id):
    if not result.zone_handle:
        return None, None, result.status
    zone_id, level_index = map(int, result.zone_handle.split(":"))
    levels = by_id[zone_id]["levels"]
    return zone_id, levels[level_index]["elevation_mm"] if levels else None, result.status


def preview_assignments(conn: sqlite3.Connection, object_id: int,
                        zones: list[dict], base_zones: list[dict], overrides: dict) -> dict:
    """Все привязки новой редакции; без INSERT/UPDATE/COMMIT."""
    by_id = validate_zones(zones, base_zones, allow_deletions=True)
    elements = conn.execute(
        "SELECT e.id, e.element_uid, e.element_type, e.x, e.y, e.outline_json, e.elevation_mm, "
        "e.zone_crane_id AS crane_zone_id, e.zone_crane_status AS crane_status, "
        "e.zone_stance_id AS stance_zone_id, e.zone_stance_status AS stance_status, "
        "l.elevation_mm AS stance_elevation_mm "
        "FROM elements e LEFT JOIN zone_levels l ON l.id = e.zone_stance_level_id "
        "WHERE e.object_id = ? AND e.is_current = 1 ORDER BY e.id", (object_id,),
    ).fetchall()
    manual = validate_overrides(overrides, by_id, {e["id"]: dict(e) for e in elements})
    records = _records(zones)
    changed = Counter()
    assignments = []
    for element in elements:
        outline = json.loads(element["outline_json"]) if element["outline_json"] else None
        bound = bind_element_to_zones(
            element["element_type"], element["x"], element["y"], outline,
            element["elevation_mm"], records,
            stance_mode="union",
        )
        crane_id, _, crane_status = _resolved(bound["Кран"], by_id)
        stance_id, stance_elevation, stance_status = _resolved(bound["Стоянка"], by_id)
        source = "geometry"
        reason = None
        if element["id"] in manual:
            override = manual[element["id"]]
            source = override["source"]
            crane_id = override["crane_zone_id"]
            stance_id = override["stance_zone_id"]
            if override.get("preserve_full"):
                crane_status = override["crane_status"]
                stance_status = override["stance_status"]
                stance_elevation = override["stance_elevation_mm"]
                reason = override.get("reason")
            else:
                crane_status = "matched" if crane_id is not None else "unmatched"
                stance_status = "matched" if stance_id is not None else "unmatched"
            # Ярус ручной стоянки определяется отметкой изделия отдельно от
            # геометрии. Без однозначной отметки не обещаем точный отчёт.
            if stance_id is not None and not override.get("preserve_full"):
                strict_below = element["element_type"] in TIER_CAPPING_TYPES
                levels = object_stance_levels(records)
                if element["elevation_mm"] is None or not levels:
                    raise ZoneDraftError(f"Нет рабочего уровня для изделия {element['id']}")
                eligible = [l for l in levels if (l < element["elevation_mm"] if strict_below
                                                  else l <= element["elevation_mm"])]
                stance_elevation = eligible[-1] if eligible else levels[0]
            elif stance_id is None and not override.get("preserve_full"):
                stance_elevation = None
            if stance_id is not None and override.get("preserve_full") and stance_elevation not in (
                {l["elevation_mm"] for l in by_id[stance_id]["levels"]} |
                set(by_id[stance_id].get("report_levels", []))
            ):
                raise ZoneDraftError(
                    f"У стоянки изделия {element['id']} нет сохранённой отчётной отметки "
                    f"{stance_elevation}; восстановите ссылку или снимите исключение"
                )
        if crane_id != element["crane_zone_id"]:
            changed["crane"] += 1
        if stance_id != element["stance_zone_id"]:
            changed["stance"] += 1
        if crane_status != element["crane_status"] or stance_status != element["stance_status"]:
            changed["status"] += 1
        if stance_elevation != element["stance_elevation_mm"]:
            changed["tier"] += 1
        if crane_status == "needs_review" or stance_status == "needs_review":
            changed["needs_review"] += 1
        if source == "conversion":
            changed["conversion_exceptions"] += 1
        if source == "manual":
            changed["manual"] += 1
        assignments.append({
            "element_id": element["id"], "element_uid": element["element_uid"],
            "crane_zone_id": crane_id, "crane_status": crane_status,
            "stance_zone_id": stance_id, "stance_status": stance_status,
            "stance_elevation_mm": stance_elevation, "source": source,
            "reason": reason,
        })
    zone_counts = Counter()
    for assignment in assignments:
        if assignment["crane_zone_id"] is not None:
            zone_counts[str(assignment["crane_zone_id"])] += 1
        if assignment["stance_zone_id"] is not None:
            zone_counts[str(assignment["stance_zone_id"])] += 1
    return {"assignments": assignments, "counts": dict(changed),
            "zone_counts": dict(zone_counts), "total": len(assignments)}
