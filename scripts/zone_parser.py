"""
Реестр зон (захватки, зоны работы крана, стоянки крана) — строится из
слоёв, распознанных layer_naming.parse_layer_name() как group="zone".

Пара слоёв на каждую (категорию, отметку): один роли "Зона" (замкнутые
контуры-полигоны), один роли "Наименование" (текстовые подписи). Название
сопоставляется полигону по принципу "точка вставки текста внутри полигона"
— см. match_names_to_zones().
"""

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ezdxf.tools.text import plain_mtext
from shapely.geometry import Point, Polygon
from shapely.validation import make_valid

from layer_naming import LayerNameError, parse_layer_name
from parse_zhbi import get_text_content, is_effectively_closed, to_vec2


@dataclass
class ZoneRecord:
    handle: str
    category: str  # "Захватка" | "Кран" | "Стоянка"
    elevation_mm: Optional[int]
    outline: list  # [(x, y), ...] вершины полигона в мировых координатах
    name: Optional[str] = None
    match_status: str = "unmatched"  # "matched" | "unmatched" | "ambiguous"
    # Только для category="Стоянка" — handle зоны категории "Кран", в чьём
    # полигоне физически находится эта стоянка (см. _link_stances_to_cranes,
    # Docs/backlog.md). None — не определено (см. match_status ниже,
    # переиспользуем то же поле: "matched" однозначно, "unmatched"/
    # "ambiguous" — 0 либо больше 1 кандидата-крана).
    parent_zone_handle: Optional[str] = None
    parent_match_status: str = "not_applicable"  # "matched"|"unmatched"|"ambiguous"|"not_applicable" (не Стоянка)


@dataclass
class ZoneReviewItem:
    kind: str  # "zone_no_name" | "zone_multiple_names" | "text_no_zone" | "text_multiple_zones"
    detail: dict


def _to_shapely_polygon(outline: list) -> Optional[Polygon]:
    if len(outline) < 3:
        return None
    poly = Polygon(outline)
    if not poly.is_valid:
        poly = make_valid(poly)
        if poly.geom_type != "Polygon":
            # make_valid может вернуть MultiPolygon/GeometryCollection на
            # совсем вырожденной геометрии — берём крупнейший полигон, чтобы
            # не падать, но геометрия в этом случае подозрительна.
            polys = [g for g in getattr(poly, "geoms", []) if g.geom_type == "Polygon"]
            poly = max(polys, key=lambda p: p.area) if polys else None
    return poly


def _multileader_name(entity):
    """Название зоны на реальных чертежах приходит как MULTILEADER (выноска
    с текстом), не TEXT/MTEXT (см. Docs/backlog.md) — этот код разворачивает
    его так же, как parse_zhbi.collect_annotations() разворачивает
    MULTILEADER-марки элементов. Точка для сопоставления с полигоном — ОСТРИЁ
    выноски (arrow), а не место, где висит сам текстовый блок: текст обычно
    вынесен за пределы зоны, а остриё указывает непосредственно на неё."""
    arrow_points = []
    for leader in entity.context.leaders:
        for line in leader.lines:
            arrow_points.extend(to_vec2(v) for v in line.vertices)
    if not arrow_points:
        return None
    raw_text = entity.get_mtext_content() or ""
    text = plain_mtext(raw_text).strip() if raw_text else ""
    if not text:
        return None
    point = arrow_points[0]
    return text, (point.x, point.y)


def discover_layer_names(msp) -> set:
    """Слои, реально используемые хоть одной сущностью в modelspace —
    надёжнее, чем таблица слоёв документа (которая может содержать
    объявленные, но не использованные слои, и наоборот — не все DXF
    аккуратно объявляют все использованные слои)."""
    return {e.dxf.layer for e in msp}


def classify_layers(layer_names: set, allowed_subtypes: dict) -> dict:
    """
    Прогоняет каждое имя слоя через layer_naming.parse_layer_name().
    Возвращает {layer_name: ParsedLayerName} только для слоёв, подходящих
    под стандарт (group="zhbi" или "zone") — слои без префикса "WEB_"
    молча опускаются (это НЕ отклонение от стандарта, а просто чужие
    слои чертежа, см. parse_layer_name).

    Кидает LayerNameError (не перехватывает) на первом же слое с
    префиксом "WEB_", не подходящем ни под одну грамматику — вызывающий
    код должен явно решить, как сообщить об этом пользователю, а не
    продолжать с частично обработанными данными.
    """
    result = {}
    for name in sorted(layer_names):
        parsed = parse_layer_name(name, allowed_subtypes)
        if parsed is not None:
            result[name] = parsed
    return result


def _group_zone_layers(classified: dict) -> dict:
    """{(категория, отметка): {"Зона": [имена слоёв], "Наименование": [имена слоёв]}}"""
    groups = {}
    for layer_name, parsed in classified.items():
        if parsed.group != "zone":
            continue
        key = (parsed.type_or_category, parsed.elevation_mm)
        groups.setdefault(key, {"Зона": [], "Наименование": []})
        groups[key][parsed.role].append(layer_name)
    return groups


# Остриё выноски MULTILEADER на реальных чертежах нередко ложится точно на
# границу полигона зоны (а не строго внутрь), но координаты выноски и
# полигона в DXF независимо округляются CAD-системой — геометрически
# совпадающие точки могут отличаться в 10-11-м знаке после запятой. Из-за
# этого точный предикат covers()/contains() иногда не срабатывает даже при
# расстоянии ~1e-11 мм. NAME_MATCH_TOLERANCE_MM — допуск по расстоянию до
# границы полигона вместо точного предиката (см. Docs/backlog.md).
NAME_MATCH_TOLERANCE_MM = 1.0

# Запасной путь, если острие выноски не попало в допуск NAME_MATCH_
# TOLERANCE_MM ни у одного полигона — на реальных чертежах острие
# MULTILEADER иногда ложится за пределами полигона на несколько мм и
# больше (не 1e-11 мм в 10-м знаке, как для "стыка по границе", а
# полноценный зазор — до ~20мм на живых данных, см. Docs/backlog.md,
# 2026-07-22). Считаем текст сопоставленным ближайшему полигону, ТОЛЬКО
# если тот заметно (NAME_NEAR_MISS_MARGIN_MM) ближе любого другого
# кандидата — иначе рискуем угадать не ту зону там, где несколько стоянок
# стоят вплотную. На реальных случаях правильный кандидат был в 2-18мм,
# ложные — дальше 1000мм, так что оба порога — с большим запасом.
NAME_NEAR_MISS_TOLERANCE_MM = 50.0
NAME_NEAR_MISS_MARGIN_MM = 200.0


def match_names_to_zones(zone_polys: list, name_texts: list):
    """
    zone_polys: [(handle, shapely.Polygon), ...]
    name_texts: [(handle, text, (x, y)), ...]

    Возвращает (zone_name_by_handle, review) — review содержит и тексты,
    не сопоставленные однозначно ни одному полигону, и полигоны без
    однозначного названия (не гадаем, помечаем явно — см. Docs/backlog.md).
    """
    candidates_by_zone = {handle: [] for handle, _ in zone_polys}
    review = []

    for text_handle, text, (tx, ty) in name_texts:
        pt = Point(tx, ty)
        containing = [handle for handle, poly in zone_polys if poly.distance(pt) <= NAME_MATCH_TOLERANCE_MM]
        if not containing and zone_polys:
            distances = sorted((poly.distance(pt), handle) for handle, poly in zone_polys)
            nearest_d, nearest_handle = distances[0]
            if nearest_d <= NAME_NEAR_MISS_TOLERANCE_MM and (
                len(distances) == 1 or distances[1][0] - nearest_d >= NAME_NEAR_MISS_MARGIN_MM
            ):
                containing = [nearest_handle]
        if len(containing) == 1:
            candidates_by_zone[containing[0]].append(text)
        elif len(containing) == 0:
            review.append(ZoneReviewItem("text_no_zone", {"handle": text_handle, "text": text}))
        else:
            review.append(
                ZoneReviewItem("text_multiple_zones", {"handle": text_handle, "text": text, "zones": containing})
            )

    zone_name_by_handle = {}
    for handle, candidates in candidates_by_zone.items():
        if len(candidates) == 1:
            zone_name_by_handle[handle] = candidates[0]
        elif len(candidates) == 0:
            zone_name_by_handle[handle] = None
            review.append(ZoneReviewItem("zone_no_name", {"handle": handle}))
        else:
            zone_name_by_handle[handle] = None
            review.append(ZoneReviewItem("zone_multiple_names", {"handle": handle, "candidates": candidates}))

    return zone_name_by_handle, review


def _polygon_to_outline(poly) -> Optional[list]:
    """shapely Polygon -> [(x, y), ...] без повторения замыкающей вершины
    (тот же формат, что и ZoneRecord.outline из DXF). MultiPolygon/
    GeometryCollection (пересечение невыпуклых контуров иногда даёт их) —
    берём крупнейший кусок, тот же приём, что и в _to_shapely_polygon."""
    if poly.geom_type != "Polygon":
        polys = [g for g in getattr(poly, "geoms", []) if g.geom_type == "Polygon"]
        poly = max(polys, key=lambda p: p.area) if polys else None
        if poly is None:
            return None
    coords = list(poly.exterior.coords)
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    return coords if len(coords) >= 3 else None


def _link_stances_to_cranes(zones: list) -> list:
    """Определяет связь каждой зоны категории "Стоянка" с зоной(ами)
    категории "Кран" — по факту ГЕОМЕТРИЧЕСКОГО ПЕРЕСЕЧЕНИЯ (площадь > 0),
    не по центроиду: на части ярусов (см. Docs/backlog.md, 2026-07-23)
    стоянка нарисована ОДНИМ вытянутым прямоугольником сразу для всех
    кранов (заказчик подтвердил на реальном файле — каждая стоянка яруса
    +25800/+34700 пересекает все 3 крана заметной площадью, а не только
    ближайший по центроиду), а не отдельным прямоугольником на кран, как
    на ярусах 0/+15800.

    - Пересекает РОВНО один кран (любой ненулевой площадью) — обычный
      случай (0/+15800 в реальном файле) — ничего не меняем, тот же
      ZoneRecord, parent_zone_handle на этот кран, контур КАК ЕСТЬ, без
      обрезки (заказчик подтвердил — на этих ярусах трогать не нужно).
    - Не пересекает НИ ОДНОГО крана — как раньше, "unmatched".
    - Пересекает НЕСКОЛЬКО кранов заметной площадью — это не одна зона, а
      общая заготовка "стоянка N для любого крана" (+25800/+34700 в
      реальном файле) — заменяем ОДНОЙ записью на КАЖДЫЙ кран, контур
      каждой — пересечение исходного контура с зоной этого крана (заказчик
      подтвердил: "по любому ненулевому" пересечению, без минимального
      порога площади). Handle — составной (исходный#кран), чтобы не
      конфликтовать с UNIQUE(source_file, dxf_handle) в БД.

    Мутирует список zones НА МЕСТЕ (заменяет записи категории "Стоянка"),
    как и раньше. Возвращает список ZoneReviewItem с деталями по каждой
    несопоставленной стоянке."""
    cranes = []
    for z in zones:
        if z.category != "Кран":
            continue
        poly = _to_shapely_polygon(z.outline)
        if poly is not None:
            cranes.append((z, poly))

    review = []
    new_stances = []
    for z in zones:
        if z.category != "Стоянка":
            continue
        poly = _to_shapely_polygon(z.outline)
        if poly is None or poly.is_empty:
            z.parent_match_status = "unmatched"
            new_stances.append(z)
            continue

        overlapping = []
        for cz, cpoly in cranes:
            inter = poly.intersection(cpoly)
            if not inter.is_empty and inter.area > 0:
                overlapping.append((cz, inter))

        if len(overlapping) == 0:
            z.parent_match_status = "unmatched"
            new_stances.append(z)
            review.append(ZoneReviewItem("stance_no_crane", {"handle": z.handle}))
        elif len(overlapping) == 1:
            cz, _inter = overlapping[0]
            z.parent_zone_handle = cz.handle
            z.parent_match_status = "matched"
            new_stances.append(z)
        else:
            for cz, inter in overlapping:
                outline = _polygon_to_outline(inter)
                if outline is None:
                    continue
                new_stances.append(ZoneRecord(
                    handle=f"{z.handle}#{cz.handle}",
                    category=z.category,
                    elevation_mm=z.elevation_mm,
                    outline=outline,
                    name=z.name,
                    match_status=z.match_status,
                    parent_zone_handle=cz.handle,
                    parent_match_status="matched",
                ))

    zones[:] = [z for z in zones if z.category != "Стоянка"] + new_stances
    return review


def build_zone_registry(msp, allowed_subtypes: dict):
    """
    Точка входа для отдельного использования (например, тестов) — сама
    заново разбирает ВСЕ слои файла, без учёта того, что часть из них уже
    может быть распознана старым конвейером (см. предупреждение у
    build_zone_registry_from_classified). Для интеграции с
    app/dxf_import.py используется build_zone_registry_from_classified
    с уже отфильтрованным набором слоёв — см.
    scripts/new_standard_pipeline.py.
    """
    layer_names = discover_layer_names(msp)
    classified = classify_layers(layer_names, allowed_subtypes)
    return build_zone_registry_from_classified(msp, classified)


def build_zone_registry_from_classified(msp, classified: dict):
    """
    Главная логика. Принимает уже готовый {имя_слоя: ParsedLayerName} —
    ВАЖНО: если в classified попадут слои, уже занятые старым конвейером
    (например, "WEB_Оси"), они либо не пройдут строгую валидацию (упадут
    с LayerNameError на этапе classify_layers ДО вызова этой функции), либо
    будут ошибочно учтены как часть нового стандарта. Правильный набор —
    только слои, не распознанные старым конвейером (см.
    app/dxf_import.py:_KNOWN_OLD_LAYERS).

    Возвращает (zones, review):
      zones — list[ZoneRecord], одна запись на каждый полигон-зону
              (match_status выставлен по итогам сопоставления с названиями);
      review — list[ZoneReviewItem], всё, что требует ручной проверки.
    """
    groups = _group_zone_layers(classified)

    zones: list[ZoneRecord] = []
    review: list[ZoneReviewItem] = []

    for (category, elevation_mm), roles in groups.items():
        zona_layers = roles["Зона"]
        naim_layers = roles["Наименование"]

        if len(zona_layers) == 0:
            review.append(
                ZoneReviewItem(
                    "group_missing_zona",
                    {"category": category, "elevation_mm": elevation_mm, "naim_layers": naim_layers},
                )
            )
            continue
        if len(zona_layers) > 1:
            review.append(
                ZoneReviewItem(
                    "group_duplicate_zona",
                    {"category": category, "elevation_mm": elevation_mm, "layers": zona_layers},
                )
            )
        if len(naim_layers) > 1:
            review.append(
                ZoneReviewItem(
                    "group_duplicate_naim",
                    {"category": category, "elevation_mm": elevation_mm, "layers": naim_layers},
                )
            )

        # Полигоны — со всех слоёв роли "Зона" в группе (обычно один слой,
        # но при дубликате слоя выше уже помечено review — не блокируем
        # обработку, просто собираем полигоны со всех).
        zone_records_by_handle = {}
        polys_for_matching = []
        for layer_name in zona_layers:
            for e in msp.query("LWPOLYLINE"):
                if e.dxf.layer != layer_name or not is_effectively_closed(e):
                    continue
                outline = [(p[0], p[1]) for p in e.get_points()]
                poly = _to_shapely_polygon(outline)
                if poly is None or poly.is_empty:
                    review.append(
                        ZoneReviewItem(
                            "zone_invalid_geometry",
                            {"handle": e.dxf.handle, "layer": layer_name},
                        )
                    )
                    continue
                rec = ZoneRecord(handle=e.dxf.handle, category=category, elevation_mm=elevation_mm, outline=outline)
                zone_records_by_handle[e.dxf.handle] = rec
                polys_for_matching.append((e.dxf.handle, poly))

        name_texts = []
        for layer_name in naim_layers:
            for e in msp.query("TEXT MTEXT"):
                if e.dxf.layer != layer_name:
                    continue
                text = get_text_content(e)
                if not text:
                    continue
                point = to_vec2(e.dxf.insert)
                name_texts.append((e.dxf.handle, text, (point.x, point.y)))
            for e in msp.query("MULTILEADER"):
                if e.dxf.layer != layer_name:
                    continue
                result = _multileader_name(e)
                if result is None:
                    continue
                text, point = result
                name_texts.append((e.dxf.handle, text, point))

        zone_name_by_handle, group_review = match_names_to_zones(polys_for_matching, name_texts)
        review.extend(group_review)

        for handle, rec in zone_records_by_handle.items():
            name = zone_name_by_handle.get(handle)
            rec.name = name
            # ambiguous — только если сама эта зона стала предметом review
            # (несколько названий внутри неё); "нет названия" — unmatched,
            # не ambiguous (разные по смыслу статусы, см. Docs/backlog.md).
            is_ambiguous = any(
                r.kind == "zone_multiple_names" and r.detail.get("handle") == handle for r in group_review
            )
            rec.match_status = "ambiguous" if is_ambiguous else ("matched" if name else "unmatched")
            zones.append(rec)

    review.extend(_link_stances_to_cranes(zones))
    return zones, review
