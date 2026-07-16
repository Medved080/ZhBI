"""
Прогоняет полный конвейер (разбор имён слоёв -> реестр зон -> привязка
элементов) на синтетическом файле test_data/synthetic_zones.dxf и
проверяет каждый ожидаемый результат явным assert — не глазами (см.
Docs/backlog.md, п.4 задачи по захваткам/кранам/стоянкам: "прежде чем
пробовать на реальном чертеже").

Запуск:
    python scripts/verify_zone_pipeline.py
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
logging.getLogger("ezdxf").setLevel(logging.ERROR)

import ezdxf

from layer_naming import LayerNameError, parse_layer_name
from parse_zhbi import to_vec2
from zone_binding import bind_element_to_zones
from zone_parser import build_zone_registry, classify_layers, discover_layer_names

DXF_PATH = "test_data/synthetic_zones.dxf"

# Справочник подтипов для этого теста — пуст (в синтетическом файле подтипы
# не используются), но нужен параметром по контракту parse_layer_name.
ALLOWED_SUBTYPES = {}

failures = []


def check(label, condition, detail=""):
    status = "OK  " if condition else "FAIL"
    print(f"{status} {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def main():
    doc = ezdxf.readfile(DXF_PATH)
    msp = doc.modelspace()

    print("=== 1. Разбор имён слоёв ===")
    layer_names = discover_layer_names(msp)
    classified = classify_layers(layer_names, ALLOWED_SUBTYPES)
    zone_layer_names = {n for n, p in classified.items() if p.group == "zone"}
    zhbi_layer_names = {n for n, p in classified.items() if p.group == "zhbi"}
    print(f"  всего распознанных слоёв: {len(classified)} (zone={len(zone_layer_names)}, zhbi={len(zhbi_layer_names)})")
    check("слой 'WEB_тех_Захватки_область' распознан как zone/Захватка",
          classified.get("WEB_тех_Захватки_область") and classified["WEB_тех_Захватки_область"].type_or_category == "Захватка")
    check("слой 'WEB_тех_Стоянки крана_ОТМП15800_область' распознан с отметкой +15800",
          classified.get("WEB_тех_Стоянки крана_ОТМП15800_область") and classified["WEB_тех_Стоянки крана_ОТМП15800_область"].elevation_mm == 15800)
    check("слой 'WEB_констр_Колонна_ОТМП15800_элемент' распознан с отметкой +15800",
          classified.get("WEB_констр_Колонна_ОТМП15800_элемент") and classified["WEB_констр_Колонна_ОТМП15800_элемент"].elevation_mm == 15800)

    # строгая валидация: испорченное имя должно явно упасть
    try:
        parse_layer_name("WEB_констр_Мусор_элемент", ALLOWED_SUBTYPES)
        check("строгая валидация ловит неизвестный тип", False, "исключение не брошено")
    except LayerNameError:
        check("строгая валидация ловит неизвестный тип", True)

    # регистр отдельных токенов не имеет значения (префикс "WEB_" — как есть)
    try:
        p_ci = parse_layer_name("WEB_КОНСТР_колонна_ЭЛЕМЕНТ", ALLOWED_SUBTYPES)
        check("сравнение токенов регистронезависимо", p_ci is not None and p_ci.type_or_category == "Колонна" and p_ci.role == "Элемент")
    except LayerNameError as e:
        check("сравнение токенов регистронезависимо", False, str(e))

    print()
    print("=== 2. Реестр зон ===")
    zones, review = build_zone_registry(msp, ALLOWED_SUBTYPES)
    by_name = {z.name: z for z in zones if z.name}
    print(f"  всего зон: {len(zones)}, требуют проверки: {len(review)}")
    for z in zones:
        print(f"    {z.category:10s} elev={z.elevation_mm} name={z.name!r} status={z.match_status}")
    for r in review:
        print(f"    REVIEW {r.kind}: {r.detail}")

    check("Захватка 1 сопоставлена с названием", "Захватка 1" in by_name and by_name["Захватка 1"].match_status == "matched")
    check("Захватка 2 сопоставлена с названием", "Захватка 2" in by_name and by_name["Захватка 2"].match_status == "matched")
    zakhvatka3 = [z for z in zones if z.category == "Захватка" and z.name is None]
    check("Захватка 3 (без названия) присутствует в реестре как unmatched",
          len(zakhvatka3) == 1 and zakhvatka3[0].match_status == "unmatched")
    check("Захватка 3 попала в review-список (zone_no_name)",
          any(r.kind == "zone_no_name" and r.detail.get("handle") == zakhvatka3[0].handle for r in review) if zakhvatka3 else False)
    stoyanka_a = [z for z in zones if z.category == "Стоянка" and z.elevation_mm == 15800]
    stoyanka_b = [z for z in zones if z.category == "Стоянка" and z.elevation_mm == 18800]
    check("Стоянка A (+15800) есть в реестре, отдельно от Стоянки B (+18800)", len(stoyanka_a) == 1 and len(stoyanka_b) == 1)
    kran = [z for z in zones if z.category == "Кран"]
    check("Г-образная зона крана распознана (невыпуклый полигон)", len(kran) == 1 and kran[0].match_status == "matched")

    print()
    print("=== 3. Привязка элементов к зонам ===")

    mark_layers = {n for n, p in classified.items() if p.group == "zhbi" and p.role == "Марка"}

    def find_element(mark_text):
        for e in msp.query("LWPOLYLINE"):
            layer = e.dxf.layer
            parsed = classified.get(layer)
            if not parsed or parsed.group != "zhbi" or parsed.role != "Элемент":
                continue
            pts = [(p[0], p[1]) for p in e.get_points()]
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            texts = [
                t for t in msp.query("TEXT") if t.dxf.layer in mark_layers
                and abs(t.dxf.insert.x - cx) < 1 and abs(t.dxf.insert.y - cy) < 1
            ]
            if texts and texts[0].dxf.text == mark_text:
                return layer, parsed, pts, cx, cy
        raise LookupError(mark_text)

    layer1, parsed1, pts1, cx1, cy1 = find_element("К1")
    result1 = bind_element_to_zones(parsed1.type_or_category, cx1, cy1, pts1, parsed1.elevation_mm, zones)
    print(f"  Колонна К1 (внутри Захватки 1, отметка +15800): {[(k, v.status, v.zone_handle) for k, v in result1.items()]}")
    check("К1: захватка matched = Захватка 1", result1["Захватка"].status == "matched" and result1["Захватка"].zone_handle == by_name["Захватка 1"].handle)
    check("К1: кран matched (внутри Г-образной зоны)", result1["Кран"].status == "matched")
    check("К1: стоянка matched = Стоянка A, а не Стоянка B", result1["Стоянка"].status == "matched" and result1["Стоянка"].zone_handle == stoyanka_a[0].handle)

    layer2, parsed2, pts2, cx2, cy2 = find_element("Р1")
    result2 = bind_element_to_zones(parsed2.type_or_category, cx2, cy2, pts2, parsed2.elevation_mm, zones)
    print(f"  Ригель Р1 (на границе Захватки 1/2, без отметки): {[(k, v.status, v.zone_handle, v.candidates) for k, v in result2.items()]}")
    check("Р1: захватка needs_review (граница 50/50)", result2["Захватка"].status == "needs_review")
    check("Р1: стоянка not_applicable (нет отметки у элемента)", result2["Стоянка"].status == "not_applicable")

    layer3, parsed3, pts3, cx3, cy3 = find_element("К2")
    result3 = bind_element_to_zones(parsed3.type_or_category, cx3, cy3, pts3, parsed3.elevation_mm, zones)
    print(f"  Колонна К2 (внутри Захватки 3 без названия): {[(k, v.status, v.zone_handle) for k, v in result3.items()]}")
    check("К2: захватка matched геометрически, хотя у зоны нет имени",
          result3["Захватка"].status == "matched" and result3["Захватка"].zone_handle == zakhvatka3[0].handle)

    print()
    print("=== СВОДКА ===")
    print(f"Обработано элементов: 3, зон: {len(zones)} (захватка={sum(1 for z in zones if z.category=='Захватка')}, "
          f"кран={sum(1 for z in zones if z.category=='Кран')}, стоянка={sum(1 for z in zones if z.category=='Стоянка')})")
    print(f"Зон, требующих проверки: {len(review)}")
    needs_review_elements = sum(
        1 for r in (result1, result2, result3) for v in r.values() if v.status == "needs_review"
    )
    print(f"Привязок элементов, требующих проверки: {needs_review_elements}")
    print()
    if failures:
        print(f"ПРОВАЛЕНО ПРОВЕРОК: {len(failures)}")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    else:
        print("Все проверки пройдены.")


if __name__ == "__main__":
    main()
