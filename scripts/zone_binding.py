"""
Привязка элементов ЖБИ к зонам (захватка/кран/стоянка) — см.
Docs/backlog.md, "Разбор структурированных имён слоёв DWG/DXF...".

Метод привязки зависит от ТИПА элемента (не от того, есть ли у него
сохранённый контур): точечные элементы (колонна) — точка вставки внутри
полигона зоны; протяжённые/площадные (ригель, плита, панель) — доля
площади пересечения контура элемента с полигоном зоны. Метрика
пересечения — единая (площадь) для всех протяжённых/площадных типов, а
не отдельная "по длине" для ригелей, — согласовано отдельно (см.
обсуждение в истории разработки): при примерно постоянной ширине ригеля
перекрытие по площади пропорционально перекрытию по длине, а отдельная
метрика длины потребовала бы вычислять ось/направление элемента — заметно
больше работы без ощутимой выгоды в точности.
"""

import re
from dataclasses import dataclass
from typing import Optional

from shapely.geometry import Point, Polygon, box
from shapely.validation import make_valid

# "если максимальное перекрытие меньше ~50% ... — не присваивать"
OVERLAP_MIN_FRACTION = 0.5

# "несколько зон дают близкий результат" — порог не задан заказчиком
# дословно, зафиксирован как разумное значение (10 процентных пунктов
# разницы между первым и вторым кандидатом), обсуждаемо при калибровке
# на реальных данных.
OVERLAP_CLOSE_MARGIN = 0.1

ZONE_CATEGORIES = ("Захватка", "Кран", "Стоянка")

# Точка вставки элемента (например, колонны у самого края захватки) может
# геометрически совпадать с границей полигона зоны, но отличаться от неё в
# младших разрядах float из-за независимого округления координат в DXF —
# тот же класс проблемы, что и при сопоставлении названий зон (см.
# zone_parser.NAME_MATCH_TOLERANCE_MM и Docs/backlog.md). Проверяем допуск
# по расстоянию вместо точного predicate.contains().
POINT_MATCH_TOLERANCE_MM = 1.0

# Типы элементов, которые привязываются по точке вставки, а не по контуру.
POINT_BASED_TYPES = {"Колонна"}

# Типы, которые физически ВЕНЧАЮТ ярус СНИЗУ (лежат на колоннах/ригелях
# нижнего яруса), хотя в имени слоя стоят под отметкой яруса, который они
# венчают, а не яруса, на котором стоят — заказчик подтвердил на реальных
# данных 2026-07-23: Ригель сидит ТОЧНО на отметках яруса колонн
# (15800/25800/34700 в реальном файле), Плита перекрытия — близко к ним
# (15000 против 15800 — на толщину плиты). Привязка к стоянке/крану для
# этих типов ищет ярус СТРОГО НИЖЕ собственной отметки элемента (не <=,
# как для остальных типов, включая саму Колонну — она относится к своему
# ярусу). См. Docs/backlog.md.
TIER_CAPPING_TYPES = {"Плита перекрытия", "Ригель"}


@dataclass
class ZoneBindingResult:
    zone_handle: Optional[str]
    status: str  # "matched" | "unmatched" | "needs_review" | "not_applicable"
    candidates: Optional[list] = None  # для needs_review: [(zone_handle, fraction_или_None), ...]


def _to_valid_polygon(outline):
    if not outline or len(outline) < 3:
        return None
    poly = Polygon(outline)
    if not poly.is_valid:
        poly = make_valid(poly)
        if poly.geom_type != "Polygon":
            polys = [g for g in getattr(poly, "geoms", []) if g.geom_type == "Polygon"]
            poly = max(polys, key=lambda p: p.area) if polys else None
    return poly


def _candidates_for_category(zones, category, element_elevation_mm, own_crane_handle=None, strict_below=False):
    """None означает "неприменимо" (нельзя определить уровень элемента —
    сравнение со стоянками невозможно), а не "нет кандидатов".

    "Стоянка" — снэп на ближайший НИЖЕ реально нарисованный ярус стоянок
    (не точное совпадение отметки) — заказчик подтвердил правило: ригель
    на +5000 относится к стоянкам на 0, элементы на +47000 — к стоянкам
    на +34700 (см. Docs/backlog.md, 2026-07-22). Раньше было точное
    совпадение — этот путь используется только когда build_element_zones
    НЕ передаёт "лесенку" (stance_level_polys/tier_elevations), т.е. для
    файлов, где на каждом ярусе уже нарисованы РЕАЛЬНЫЕ полигоны стоянок
    (несколько отметок в zones) — синтетическая лесенка там не нужна и
    вредна (путает "номер стоянки в ряду" с "ярус", см.
    build_stance_level_polygons).

    strict_below — для TIER_CAPPING_TYPES (Ригель/Плита перекрытия):
    снэп ищет ярус стоянки СТРОГО ниже отметки элемента (e < elevation),
    а не e <= elevation — эти типы венчают ярус снизу, поэтому при
    отметке, совпадающей с отметкой яруса стоянки, должны уйти на ярус
    ниже, а не остаться на этом же (см. TIER_CAPPING_TYPES).

    own_crane_handle — если передан, кандидаты СНАЧАЛА сужаются до стоянок
    ИМЕННО этого крана (parent_zone_handle), а снэп по высоте считается
    уже только среди НИХ. Без этого элемент на ярусе, где у ЕГО крана нет
    своей стоянки, мог геометрически "зацепиться" за стоянку СОСЕДНЕГО
    крана, если её полигон там просто оказался рядом — реальный случай
    (элемент 28083, живая проверка, см. Docs/backlog.md, 2026-07-22).
    Заказчик подтвердил: стоянка — часть рабочей зоны конкретного крана,
    привязка не должна пересекать на чужой кран, даже если его полигон
    геометрически совпал; если у своего крана на этом ярусе стоянки нет —
    снэп ещё ниже, до ближайшего яруса, где она у НЕГО есть."""
    matching = [z for z in zones if z.category == category]
    if category == "Стоянка":
        if element_elevation_mm is None:
            return None
        if own_crane_handle is not None:
            matching = [z for z in matching if z.parent_zone_handle == own_crane_handle]
        stance_elevations = sorted({z.elevation_mm for z in matching if z.elevation_mm is not None})
        if not stance_elevations:
            return []
        if strict_below:
            below = [e for e in stance_elevations if e < element_elevation_mm]
        else:
            below = [e for e in stance_elevations if e <= element_elevation_mm]
        snapped = below[-1] if below else stance_elevations[0]
        matching = [z for z in matching if z.elevation_mm == snapped]
    return matching


def _bind_point_polys(x, y, candidates):
    """candidates — [(handle, shapely.Polygon), ...], уже готовые полигоны
    (в отличие от _bind_point ниже, не выводит их из ZoneRecord.outline —
    переиспользуется и обычными зонами, и "подрезанными по этажу" окнами
    стоянок, см. build_stance_level_polygons)."""
    pt = Point(x, y)
    matched = [h for h, poly in candidates if poly is not None and poly.distance(pt) <= POINT_MATCH_TOLERANCE_MM]
    if len(matched) == 1:
        return ZoneBindingResult(matched[0], "matched")
    if len(matched) == 0:
        return ZoneBindingResult(None, "unmatched")
    return ZoneBindingResult(None, "needs_review", candidates=[(h, None) for h in matched])


def _bind_overlap_polys(outline, candidates):
    elem_poly = _to_valid_polygon(outline)
    if elem_poly is None or elem_poly.area == 0:
        return ZoneBindingResult(None, "unmatched")

    scored = []
    for handle, zone_poly in candidates:
        if zone_poly is None or zone_poly.is_empty:
            continue
        fraction = elem_poly.intersection(zone_poly).area / elem_poly.area
        if fraction > 0:
            scored.append((handle, fraction))
    scored.sort(key=lambda t: -t[1])

    if not scored:
        return ZoneBindingResult(None, "unmatched")
    top_handle, top_fraction = scored[0]
    if top_fraction < OVERLAP_MIN_FRACTION:
        return ZoneBindingResult(None, "needs_review", candidates=scored)
    if len(scored) > 1 and (top_fraction - scored[1][1]) < OVERLAP_CLOSE_MARGIN:
        return ZoneBindingResult(None, "needs_review", candidates=scored)
    return ZoneBindingResult(top_handle, "matched")


def _bind_point(x, y, candidates):
    if candidates is None:
        return ZoneBindingResult(None, "not_applicable")
    polys = [(z.handle, _to_valid_polygon(z.outline)) for z in candidates]
    return _bind_point_polys(x, y, [(h, p) for h, p in polys if p is not None])


def _bind_by_overlap(outline, candidates):
    if candidates is None:
        return ZoneBindingResult(None, "not_applicable")
    polys = [(z.handle, _to_valid_polygon(z.outline)) for z in candidates]
    return _bind_overlap_polys(outline, [(h, p) for h, p in polys if p is not None])


# ---------------------------------------------------------------------------
# Лесенка сужения зоны стоянки крана с высотой — см. Docs/backlog.md,
# "Отнесение элементов на отметках выше 0 к стоянкам крана".
# ---------------------------------------------------------------------------

# Кран стоит у ближнего к себе (общего со следующей стоянкой) края своей
# текущей стоянки и наклоняет стрелу в сторону начала ряда стоянок. Стрела —
# прямая линия от основания (низко, у самого крана) до верхней точки (высоко,
# у дальнего от крана края) — поэтому именно ближний к крану участок ещё "не
# дорос" до высоких этажей первым, а дальний остаётся в зоне охвата дольше.
# Отсюда на каждом следующем ярусе здания ближний к крану край окна стоянки
# отступает на 1 реальный пролёт сетки осей (номера осей допустимо
# пропускать — считаем по факту существующим соседним осям, не по разнице
# номеров) — "лесенка". Освободившееся отступом место подхватывает
# следующая по номеру стоянка того же крана (её ближний край на этом ярусе
# растёт назад ровно настолько, насколько отступил сосед) — так по всей
# высоте здания не остаётся непокрытых мест. Первая стоянка крана — дальний
# (от крана) край её ряда — никогда не отступает (отступать некуда, это
# начало ряда). Последняя стоянка крана — её ближний к крану край никогда
# не отступает — она забирает всё, что осталось выше по этому ярусу.
# Перпендикулярная ряду сторона окна не меняется ни на одном ярусе.

# "Бесконечный" край окна последней стоянки — с большим запасом относительно
# реальных координат чертежа (мм), чтобы гарантированно накрыть всё, что
# осталось выше по этому ярусу.
_STANCE_WINDOW_MARGIN_MM = 1_000_000_000.0

_STANCE_NUMBER_RE = re.compile(r"(\d+)\s*$")


def _stance_number(name):
    if not name:
        return None
    m = _STANCE_NUMBER_RE.search(name)
    return int(m.group(1)) if m else None


def compute_column_tier_elevations(element_records):
    """Ярусы здания — уникальные отметки элементов типа "Колонна", по
    возрастанию (тот же приём, что и для высоты элемента в 3D —
    computeColumnLevels() в app/static/index.html, см. Docs/TZ.md §6.7).
    Индекс яруса в этом списке — это же и индекс "этажа" лесенки сужения
    зоны стоянки (0 = земля)."""
    tiers = sorted({
        r.elevation_mm for r in element_records
        if r.element_type == "Колонна" and r.elevation_mm is not None
    })
    return tiers or [0]


def _tier_index(elevation_mm, tier_elevations, strict_below=False):
    """Индекс яруса для отметки элемента — последний ярус с elevation <=
    elevation_mm; отметки ниже/выше диапазона зажимаются к крайнему ярусу
    (чтобы ни один элемент не остался без возможности отнесения к
    стоянке из-за отметки чуть вне диапазона известных ярусов колонн).

    strict_below — для TIER_CAPPING_TYPES (Ригель/Плита перекрытия):
    ищет последний ярус СТРОГО ниже elevation_mm (t < elevation_mm), а не
    t <= elevation_mm — эти типы венчают ярус снизу, значит при отметке,
    совпадающей с отметкой яруса колонн, должны попасть на ярус ниже."""
    if elevation_mm is None or not tier_elevations:
        return None
    idx = 0
    for i, t in enumerate(tier_elevations):
        if (t < elevation_mm) if strict_below else (t <= elevation_mm):
            idx = i
        else:
            break
    return idx


def _stance_row_axis(stance_polys):
    """('x'|'y') — ось, вдоль которой физически расположен ряд стоянок
    этого крана (числовая ось сетки — координата X, буквенная — Y, см.
    scripts/assign_axes.py). Определяется по тому, вдоль какой координаты
    центроиды стоянок разъезжаются сильнее."""
    centroids = [p.centroid for p in stance_polys]
    xs = [c.x for c in centroids]
    ys = [c.y for c in centroids]
    return "x" if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else "y"


def _nearest_grid_index(value, grid_coords):
    best_i, best_d = 0, None
    for i, coord in enumerate(grid_coords):
        d = abs(value - coord)
        if best_d is None or d < best_d:
            best_i, best_d = i, d
    return best_i


def _clip_polygon_to_window(poly, axis, lo, hi):
    m = _STANCE_WINDOW_MARGIN_MM
    rect = box(lo, -m, hi, m) if axis == "x" else box(-m, lo, m, hi)
    clipped = poly.intersection(rect)
    if clipped.is_empty:
        return None
    if clipped.geom_type == "Polygon":
        return clipped
    polys = [g for g in getattr(clipped, "geoms", []) if g.geom_type == "Polygon"]
    return max(polys, key=lambda p: p.area) if polys else None


def build_stance_level_polygons(zones, numeric_axes, letter_axes, tier_elevations):
    """
    Готовит для каждой стоянки список shapely-полигонов, по одному на
    каждый ярус здания (индекс = индекс в tier_elevations, см.
    compute_column_tier_elevations) — см. комментарий над этим разделом.

    Стоянки, для которых кран не определён однозначно
    (parent_match_status != "matched") или номер не удалось извлечь из
    названия — не участвуют в лесенке ("не с кем и не в каком порядке
    сужаться"), на всех ярусах используется их исходный полигон без
    изменений — безопасный fallback, а не отказ.

    Возвращает {stance_handle: [poly_ярус0, poly_ярус1, ...]}.
    """
    n_levels = len(tier_elevations)
    result = {}

    crane_poly_by_handle = {}
    for z in zones:
        if z.category != "Кран":
            continue
        poly = _to_valid_polygon(z.outline)
        if poly is not None and not poly.is_empty:
            crane_poly_by_handle[z.handle] = poly

    stances_by_crane = {}
    for z in zones:
        if z.category != "Стоянка":
            continue
        poly = _to_valid_polygon(z.outline)
        if poly is None or poly.is_empty:
            continue
        number = _stance_number(z.name)
        if z.parent_match_status != "matched" or number is None or z.parent_zone_handle not in crane_poly_by_handle:
            result[z.handle] = [poly for _ in range(n_levels)]
            continue
        stances_by_crane.setdefault(z.parent_zone_handle, []).append((number, z.handle, poly))

    for crane_handle, entries in stances_by_crane.items():
        entries.sort(key=lambda t: t[0])
        n = len(entries)
        polys = [p for _, _, p in entries]

        if n == 1:
            handle, poly = entries[0][1], entries[0][2]
            result[handle] = [poly for _ in range(n_levels)]
            continue

        axis = _stance_row_axis(polys)
        grid_map = numeric_axes if axis == "x" else letter_axes
        grid_coords = sorted(set(grid_map.values()))

        own_lo_idx, own_hi_idx = [], []
        for poly in polys:
            minx, miny, maxx, maxy = poly.bounds
            lo, hi = (minx, maxx) if axis == "x" else (miny, maxy)
            own_lo_idx.append(_nearest_grid_index(lo, grid_coords))
            own_hi_idx.append(_nearest_grid_index(hi, grid_coords))

        for _, handle, _ in entries:
            result[handle] = []

        # Начиная с яруса 1 "родное" окно стоянки может выйти за пределы её
        # СОБСТВЕННОГО нарисованного полигона (подхватывает то, что уступила
        # предыдущая по номеру стоянка, см. комментарий выше) — поэтому
        # материал для подрезки на этих ярусах — полигон всей рабочей зоны
        # КРАНА целиком (она физически покрывает весь ряд его стоянок), а
        # не полигон отдельной стоянки.
        crane_poly = crane_poly_by_handle[crane_handle]

        for k in range(n_levels):
            if k == 0:
                # Ярус земли — исходный полигон стоянки как есть, без
                # подрезки по сетке (контур обычно не совпадает с осью
                # день-в-день, есть небольшой технологический зазор —
                # подрезка на нулевом ярусе срезала бы этот зазор без
                # всякой причины).
                for _, handle, poly in entries:
                    result[handle].append(poly)
                continue

            prev_hi_idx = None
            for i in range(n):
                handle = entries[i][1]
                lo_idx = own_lo_idx[i] if i == 0 else prev_hi_idx
                if i == n - 1:
                    hi_idx = None  # последняя стоянка крана — без ограничения сверху
                else:
                    hi_idx = max(own_lo_idx[i], own_hi_idx[i] - k)
                lo_coord = grid_coords[lo_idx]
                hi_coord = grid_coords[hi_idx] if hi_idx is not None else _STANCE_WINDOW_MARGIN_MM
                result[handle].append(_clip_polygon_to_window(crane_poly, axis, lo_coord, hi_coord))
                prev_hi_idx = hi_idx if hi_idx is not None else own_hi_idx[i]

    return result


def bind_element_to_zones(
    element_type, x, y, outline, elevation_mm, zones, stance_level_polys=None, tier_elevations=None
):
    """
    element_type — "Колонна"/"Ригель"/"Плита"/"Панель" (определяет метод:
    точка для колонн, площадь пересечения для остальных).
    x, y — точка вставки элемента.
    outline — список вершин контура в мировых координатах, либо None.
    elevation_mm — отметка элемента (из имени слоя), либо None.
    zones — list[zone_parser.ZoneRecord], полный реестр (все категории).
    stance_level_polys, tier_elevations — если оба переданы, категория
    "Стоянка" использует "лесенку" сужения зоны с высотой (см.
    build_stance_level_polygons/compute_column_tier_elevations) вместо
    точного совпадения отметки элемента с отметкой полигона стоянки;
    иначе (по умолчанию, для обратной совместимости старых вызовов —
    например, scripts/verify_zone_pipeline.py) — прежнее поведение
    "Стоянка" сопоставляется только элементам с elevation_mm, точно
    равной отметке полигона стоянки.

    Возвращает {"Захватка": ZoneBindingResult, "Кран": ..., "Стоянка": ...}.
    """
    use_point = element_type in POINT_BASED_TYPES or not outline
    use_tiered_stances = stance_level_polys is not None and tier_elevations is not None
    strict_below = element_type in TIER_CAPPING_TYPES

    result = {}
    for category in ZONE_CATEGORIES:
        if category == "Стоянка" and use_tiered_stances:
            level = _tier_index(elevation_mm, tier_elevations, strict_below=strict_below)
            if level is None:
                result[category] = ZoneBindingResult(None, "not_applicable")
                continue
            candidates = [
                (handle, polys[level])
                for handle, polys in stance_level_polys.items()
                if level < len(polys) and polys[level] is not None
            ]
            result[category] = (
                _bind_point_polys(x, y, candidates) if use_point else _bind_overlap_polys(outline, candidates)
            )
            continue

        if category == "Стоянка":
            # "Кран" уже обработан на этой итерации (см. порядок
            # ZONE_CATEGORIES выше) — сужаем стоянки СВОИМ краном элемента,
            # см. docstring _candidates_for_category.
            crane_result = result.get("Кран")
            own_crane_handle = crane_result.zone_handle if crane_result and crane_result.status == "matched" else None
            candidates = _candidates_for_category(
                zones, category, elevation_mm, own_crane_handle=own_crane_handle, strict_below=strict_below
            )
        else:
            candidates = _candidates_for_category(zones, category, elevation_mm)
        if use_point:
            result[category] = _bind_point(x, y, candidates)
        else:
            result[category] = _bind_by_overlap(outline, candidates)
    return result
