"""
Конвейер разбора слоёв по новому стандарту имён (см. Docs/backlog.md,
"Разбор структурированных имён слоёв DWG/DXF..."). Работает ПАРАЛЛЕЛЬНО
со старым LAYER_CONFIG-конвейером (scripts/parse_zhbi.py), не заменяет
его — вызывается отдельно из app/dxf_import.py, результаты обоих
конвейеров объединяются на уровне записи в БД.

Обрабатывает только слои с префиксом "WEB_", НЕ распознанные старой
системой (не в LAYER_CONFIG/ANNOTATION_LAYERS/AXIS_LAYER) — иначе старые
файлы сломались бы на "WEB_Оси" и подобных, которые не подходят под новую
грамматику. Строгая валидация (LayerNameError) применяется только к этому
"неизвестному старой системе" остатку слоёв.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from layer_naming import LayerNameError, parse_layer_name
from parse_zhbi import (
    ElementRecord,
    build_leader_pool,
    collect_annotations,
    is_effectively_closed,
    polyline_centroid,
    resolve_via_leaders,
)
from zone_binding import bind_element_to_zones, build_stance_level_polygons, compute_column_tier_elevations
from zone_parser import build_zone_registry_from_classified, classify_layers


def discover_unclaimed_web_layers(msp, known_old_layers: set) -> set:
    """Слои с префиксом 'WEB_', реально используемые хоть одной сущностью,
    за вычетом уже распознанных старой системой (LAYER_CONFIG,
    ANNOTATION_LAYERS, AXIS_LAYER — передаются вызывающим кодом, чтобы
    этот модуль не тянул знание об их точном составе)."""
    return {
        e.dxf.layer for e in msp
        if e.dxf.layer.startswith("WEB_") and e.dxf.layer not in known_old_layers
    }


def _group_zhbi_layers(classified: dict) -> dict:
    """{(тип, подтип, отметка): {"Элемент": имя_слоя_или_None, "Марка": имя_слоя_или_None}}"""
    groups = {}
    for layer_name, parsed in classified.items():
        if parsed.group != "zhbi":
            continue
        key = (parsed.type_or_category, parsed.subtype, parsed.elevation_mm)
        groups.setdefault(key, {"Элемент": None, "Марка": None})
        groups[key][parsed.role] = layer_name
    return groups


def parse_new_standard_elements(msp, zhbi_groups: dict) -> list:
    """Один элемент = один замкнутый LWPOLYLINE на слое роли "Элемент"
    внутри группы (тип, подтип, отметка); марка ищется среди аннотаций
    ТОЛЬКО на парном слое роли "Марка" этой же группы (не глобально) —
    так разные группы (например, ригели разных ярусов) не путают друг
    другу выноски."""
    records: list[ElementRecord] = []

    for (element_type, subtype, elevation_mm), roles in zhbi_groups.items():
        elem_layer = roles["Элемент"]
        if not elem_layer:
            # Есть слой "Марка" для этой группы, но нет "Элемент" — геометрии
            # разбирать нечего; сами марки без элементов ни на что не влияют.
            continue

        pending = []
        for e in msp.query("LWPOLYLINE"):
            if e.dxf.layer != elem_layer or not is_effectively_closed(e):
                continue
            outline = [(p[0], p[1]) for p in e.get_points()]
            record = ElementRecord(
                id=e.dxf.handle,
                layer=elem_layer,
                element_type=element_type,
                mark=None,
                source="unresolved",
                x=polyline_centroid(e).x,
                y=polyline_centroid(e).y,
                z=0.0,
                outline=outline,
                subtype=subtype,
                elevation_mm=elevation_mm,
            )
            records.append(record)
            pending.append({"record": record, "point": polyline_centroid(e)})

        mark_layer = roles["Марка"]
        if mark_layer and pending:
            old_leaders, multi_leaders, texts = collect_annotations(msp, layers={mark_layer})
            leader_pool = build_leader_pool(old_leaders, multi_leaders, texts)
            matches = resolve_via_leaders(pending, leader_pool)
            for idx, mark in matches.items():
                pending[idx]["record"].mark = mark
                pending[idx]["record"].source = "leader"

    return records


def process(msp, known_old_layers: set, allowed_subtypes: dict, axis_grid=None):
    """
    Главная точка входа. Возвращает (element_records, zones, review) —
    element_records: list[ElementRecord] (с уже проставленными
    subtype/elevation_mm/outline), zones: list[zone_parser.ZoneRecord],
    review: list[zone_parser.ZoneReviewItem].

    axis_grid — assign_axes.AxisGrid (numeric_axes/letter_axes), уже
    посчитанная вызывающим кодом (app/dxf_import.py, ДО этого вызова —
    см. там же) — нужна для "лесенки" сужения зоны стоянки крана с
    высотой (см. zone_binding.build_stance_level_polygons). Без неё
    (None, для старых вызовов/тестов, например
    scripts/verify_zone_pipeline.py) категория "Стоянка" сопоставляется
    по-старому — только элементам с отметкой, точно равной отметке
    полигона стоянки.

    Бросает LayerNameError, если среди "неизвестных старой системе"
    WEB_-слоёв нашёлся хоть один, не подходящий под новую грамматику —
    вызывающий код (app/dxf_import.py) должен прервать импорт с понятным
    сообщением, а не продолжать с частично разобранными данными (это и
    есть требуемая "строгая валидация", см. Docs/backlog.md).
    """
    unclaimed = discover_unclaimed_web_layers(msp, known_old_layers)
    classified = classify_layers(unclaimed, allowed_subtypes)  # может бросить LayerNameError

    zhbi_groups = _group_zhbi_layers(classified)
    element_records = parse_new_standard_elements(msp, zhbi_groups)

    zones, review = build_zone_registry_from_classified(msp, classified)

    stance_level_polys, tier_elevations = None, None
    if axis_grid is not None:
        tier_elevations = compute_column_tier_elevations(element_records)
        stance_level_polys = build_stance_level_polygons(
            zones, axis_grid.numeric_axes, axis_grid.letter_axes, tier_elevations
        )

    for record in element_records:
        bindings = bind_element_to_zones(
            record.element_type, record.x, record.y, record.outline, record.elevation_mm, zones,
            stance_level_polys=stance_level_polys, tier_elevations=tier_elevations,
        )
        record.zone_bindings = bindings

    return element_records, zones, review
