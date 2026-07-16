"""
Присваивает элементам адрес по координационным осям (например "3/Г") на
основе сетки осей, зашитой в DXF как блок с вложенными подписями-маркерами.

Использует parse_zhbi.py для получения списка элементов с марками, затем
для каждого элемента ищет ближайшую числовую (X) и буквенную (Y) ось и
считает смещение от их пересечения — на реальных чертежах большинство
элементов НЕ сидят точно на пересечении (есть "привязка"), поэтому адрес
всегда даётся как "ближайшие оси + смещение", без потери точности.

Запуск:
    python scripts/assign_axes.py "test_data/Чертежи для WEB-1.dxf" --out output/elements_with_address.csv

Результат:
    - сводка в консоль
    - CSV с адресом и смещением для каждого элемента
"""

import argparse
import csv
import logging
import re
import sys
from dataclasses import asdict, dataclass
from typing import Optional

import ezdxf

from parse_zhbi import parse_dxf, ElementRecord

# ezdxf ругается на служебные прокси-объекты (ACDB_BLOCKREPRESENTATION_DATA
# и т.п.) при разворачивании вложенных блоков сетки осей — на извлекаемые
# нами атрибуты это не влияет, глушим, чтобы не засорять вывод.
logging.getLogger("ezdxf").setLevel(logging.ERROR)

# ---------------------------------------------------------------------------
# КОНФИГУРАЦИЯ
# ---------------------------------------------------------------------------

# Слой, где лежит блок(и) с сеткой осей. Стандарт имён слоёв поменялся
# (см. Docs/backlog.md) — новые файлы используют "WEB_тех_Оси", старые
# файлы всё ещё "WEB_Оси". AXIS_LAYER остаётся дефолтом для обратной
# совместимости (CLI, старые вызовы); AXIS_LAYER_CANDIDATES — для
# автоопределения, какой из вариантов реально есть в файле (см.
# find_axis_layer() и app/dxf_import.py).
AXIS_LAYER = "WEB_Оси"
AXIS_LAYER_CANDIDATES = ["WEB_тех_Оси", "WEB_Оси"]

# Варианты имени тега атрибута с меткой оси (номер или буква).
AXIS_LABEL_ATTRS = ["А1", "AXIS", "ОСЬ"]

# Смещение (в единицах чертежа, здесь — мм) от пересечения осей, в пределах
# которого считаем, что элемент "сидит на пересечении" без привязки.
ON_AXIS_TOLERANCE = 10.0

# Насколько за пределы известной сетки осей (bounding box) разрешаем
# элементу выходить и всё ещё привязываться к ближайшей оси. Если элемент
# дальше — значит для этой части чертежа сетки осей просто ещё нет, и
# подсовывать "ближайшую" ось из другого яруса было бы неверно.
AXIS_GRID_MARGIN = 3000.0

CYRILLIC_LETTER = re.compile(r"[А-Яа-яЁё]")


@dataclass
class AxisGrid:
    numeric_axes: dict  # label -> x
    letter_axes: dict  # label -> y

    def bbox(self):
        xs = list(self.numeric_axes.values())
        ys = list(self.letter_axes.values())
        return (min(xs), max(xs), min(ys), max(ys))


def collect_axis_markers(entity, depth=0, max_depth=6):
    """
    Рекурсивно разворачивает вложенные INSERT на слое сетки осей, пока не
    найдёт блоки с атрибутами (это и есть подписи-маркеры оси). Так сетка
    остаётся рабочей независимо от того, на сколько уровней блоков она
    вложена в конкретном файле.
    """
    if depth > max_depth:
        return []
    if entity.dxftype() != "INSERT":
        return []
    if entity.attribs:
        return [entity]
    markers = []
    for child in entity.virtual_entities():
        markers.extend(collect_axis_markers(child, depth + 1, max_depth))
    return markers


def get_axis_label(marker) -> Optional[str]:
    tags = {t.upper() for t in AXIS_LABEL_ATTRS}
    for attrib in marker.attribs:
        if attrib.dxf.tag.upper() in tags:
            text = (attrib.dxf.text or "").strip()
            if text:
                return text
    return None


def build_axis_grid(doc, axis_layer: str = AXIS_LAYER) -> AxisGrid:
    msp = doc.modelspace()
    numeric_axes = {}
    letter_axes = {}

    # Вариант А: сетка осей — вложенный блок с маркерами-INSERT, у каждого
    # атрибут с меткой оси (так было в "Чертежи для WEB-1.dxf").
    for entity in msp:
        if entity.dxf.layer != axis_layer or entity.dxftype() != "INSERT":
            continue
        for marker in collect_axis_markers(entity):
            label = get_axis_label(marker)
            if label is None:
                continue
            _add_axis(label, marker.dxf.insert, numeric_axes, letter_axes)

    # Вариант Б: сетка "распакована" в сырую геометрию (после explode блоков
    # в файле не остаётся вообще, метка оси лежит прямо в теге голого
    # ATTDEF, не во вложенном блоке) — так устроен
    # "260713_Чертежи для WEB.dxf".
    if not numeric_axes and not letter_axes:
        for entity in msp.query("ATTDEF"):
            if entity.dxf.layer != axis_layer:
                continue
            label = (entity.dxf.tag or "").strip()
            if not label:
                continue
            _add_axis(label, entity.dxf.insert, numeric_axes, letter_axes)

    return AxisGrid(numeric_axes=numeric_axes, letter_axes=letter_axes)


def build_axis_grid_auto(doc, candidates: list = AXIS_LAYER_CANDIDATES) -> AxisGrid:
    """Пробует по очереди все известные варианты имени слоя сетки осей
    (новый стандарт, затем старый) и возвращает первый непустой результат
    — так один и тот же вызов работает и для старых, и для новых файлов
    без знания заранее, какой стандарт применён в конкретном файле."""
    grid = AxisGrid(numeric_axes={}, letter_axes={})
    for layer in candidates:
        grid = build_axis_grid(doc, axis_layer=layer)
        if grid.numeric_axes or grid.letter_axes:
            return grid
    return grid


def _add_axis(label, point, numeric_axes, letter_axes):
    if CYRILLIC_LETTER.search(label):
        letter_axes[label] = point.y
    else:
        numeric_axes[label] = point.x


def nearest_axis(value: float, axis_map: dict):
    best_label, best_coord, best_dist = None, None, None
    for label, coord in axis_map.items():
        dist = abs(value - coord)
        if best_dist is None or dist < best_dist:
            best_label, best_coord, best_dist = label, coord, dist
    return best_label, best_coord, best_dist


def bracket_label(value: float, axis_map: dict, tolerance: float) -> str:
    """
    Метка положения по одному измерению: если значение попадает точно на
    ось (в пределах tolerance) — просто её метка ("3"). Если элемент лежит
    между двумя соседними осями (обычная ситуация для колонн с привязкой) —
    метка вида "1-2" / "А-Б" по шаблону заказчика: между какими осями стоит
    элемент, а не просто ближайшая ось. У самого края сетки (за последней
    осью, но ещё в пределах допустимого запаса AXIS_GRID_MARGIN) соседа с
    одной стороны нет — тогда используется одна ближайшая метка.
    """
    ordered = sorted(axis_map.items(), key=lambda kv: kv[1])

    lower = None
    for label, coord in ordered:
        if abs(value - coord) <= tolerance:
            return label
        if coord < value:
            lower = (label, coord)
        elif coord > value:
            upper = (label, coord)
            if lower is None:
                return upper[0]
            return f"{lower[0]}-{upper[0]}"

    return lower[0] if lower else ordered[0][0]


def in_grid_range(value: float, axis_map: dict, margin: float) -> bool:
    coords = axis_map.values()
    return (min(coords) - margin) <= value <= (max(coords) + margin)


def assign_address(record: ElementRecord, grid: AxisGrid) -> dict:
    if not grid.numeric_axes or not grid.letter_axes:
        return {"address": None, "status": "no_axis_grid"}

    if not in_grid_range(record.x, grid.numeric_axes, AXIS_GRID_MARGIN) or not in_grid_range(
        record.y, grid.letter_axes, AXIS_GRID_MARGIN
    ):
        return {"address": None, "status": "outside_axis_grid"}

    num_label, num_coord, dnum = nearest_axis(record.x, grid.numeric_axes)
    let_label, let_coord, dlet = nearest_axis(record.y, grid.letter_axes)

    offset_x = round(record.x - num_coord, 1)
    offset_y = round(record.y - let_coord, 1)
    on_axis = abs(offset_x) <= ON_AXIS_TOLERANCE and abs(offset_y) <= ON_AXIS_TOLERANCE

    axis_number = bracket_label(record.x, grid.numeric_axes, ON_AXIS_TOLERANCE)
    axis_letter = bracket_label(record.y, grid.letter_axes, ON_AXIS_TOLERANCE)

    return {
        "address": f"{axis_number}/{axis_letter}",
        "status": "on_axis" if on_axis else "offset",
        "axis_number": axis_number,
        "axis_letter": axis_letter,
        "nearest_axis_number": num_label,
        "nearest_axis_letter": let_label,
        "offset_x_mm": offset_x,
        "offset_y_mm": offset_y,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dxf_path", help="Путь к DXF-файлу")
    parser.add_argument(
        "--out", default="output/elements_with_address.csv", help="Путь к результирующему CSV"
    )
    args = parser.parse_args()

    try:
        doc = ezdxf.readfile(args.dxf_path)
    except IOError:
        print(f"Не удалось открыть файл: {args.dxf_path}", file=sys.stderr)
        sys.exit(1)

    records = parse_dxf(args.dxf_path)
    grid = build_axis_grid(doc)

    print(f"Сетка осей: {len(grid.numeric_axes)} числовых, {len(grid.letter_axes)} буквенных")

    rows = []
    status_counts = {}
    for r in records:
        addr = assign_address(r, grid)
        status_counts[addr["status"]] = status_counts.get(addr["status"], 0) + 1
        rows.append({**asdict(r), **addr})

    print("=" * 40)
    print("СВОДКА ПО АДРЕСАЦИИ")
    print("=" * 40)
    print(f"{'Всего элементов:':<28}{len(rows)}")
    print(f"{'  точно на пересечении:':<28}{status_counts.get('on_axis', 0)}")
    print(f"{'  с привязкой (offset):':<28}{status_counts.get('offset', 0)}")
    print(f"{'  вне сетки осей:':<28}{status_counts.get('outside_axis_grid', 0)}")
    print(f"{'  сетки осей нет:':<28}{status_counts.get('no_axis_grid', 0)}")
    print("=" * 40)

    fieldnames = [
        "id", "layer", "element_type", "mark", "source",
        "x", "y", "z",
        "address", "status", "axis_number", "axis_letter",
        "nearest_axis_number", "nearest_axis_letter",
        "offset_x_mm", "offset_y_mm",
    ]
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in fieldnames})
    print(f"Детальный список сохранён: {args.out}")


if __name__ == "__main__":
    main()
