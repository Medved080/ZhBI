"""
Парсер DXF-чертежа: извлекает элементы ЖБИ (блоки-вставки) с целевых слоёв
и определяет их марку — либо из атрибута блока, либо через геометрически
ближайшую выноску (LEADER / MULTILEADER), если атрибут пуст.

Запуск:
    python scripts/parse_zhbi.py test_data/sample.dxf
    python scripts/parse_zhbi.py test_data/sample.dxf --out output/elements.csv

Результат:
    - таблица-сводка в консоль (всего / по атрибуту / по выноске / unresolved)
    - детальный CSV со всеми элементами
"""

import argparse
import csv
import sys
from dataclasses import dataclass, asdict
from typing import Optional

import ezdxf
from ezdxf.math import Vec2
from ezdxf.tools.text import plain_mtext

# ---------------------------------------------------------------------------
# КОНФИГУРАЦИЯ — под реальный чертёж эти значения нужно будет поправить.
# ---------------------------------------------------------------------------

# Слой -> тип элемента. Значения подтверждены на реальных файлах заказчика
# ("Чертежи для WEB.dxf" / "Чертежи для WEB-1.dxf" / "260714_Чертежи для WEB.dxf").
# В -1 версии колонны разбиты на два слоя (видимо, "нижняя" — отдельный
# ярус/отметка) — оба ведут на element_type="Колонна", т.к. геометрически
# это тот же тип элемента, просто расположенный отдельно; ярус будет
# определяться по координатам на шаге адресации, а не по этому словарю.
# Ригели найдены в 260714_Чертежи для WEB.dxf на слое ниже. Плиты по-прежнему
# не встречались ни в одном файле — добавить, когда появятся данные.
#
# Значения — русские, единый словарь с новым стандартом имён слоёв
# (scripts/layer_naming.ZHBI_TYPES) — раньше здесь были "column"/"beam"
# (английские), из-за чего одни и те же по сути типы элементов давали ДВЕ
# разные строки element_type в зависимости от того, какой конвейер обработал
# файл, и удваивались в экранах настроек, завязанных на element_type
# (видимость подписей, контракт по умолчанию) — см. Docs/backlog.md.
LAYER_CONFIG = {
    "Колонны": "Колонна",
    "WEB_Колонна_нижняя": "Колонна",
    "WEB_Ригель_на отм. +15.800": "Ригель",
    # "Плиты": "Плита",    # добавить, когда появятся данные с плитами
}

# Слои, на которых лежат текстовые сноски марок и старые LEADER-ы. Слой
# геометрии ригелей сам входит сюда тоже — на нём же лежат единичные
# MULTILEADER/TEXT-марки нескольких ригелей (не вынесенные на отдельный
# слой марок, в отличие от большинства).
ANNOTATION_LAYERS = {
    "колонны мои",
    "WEB_Колонна_нижняя_марки",
    "WEB_Ригели_на отм. +15.800_марки",
    "WEB_Ригель_на отм. +15.800",
}

# Варианты имени тега атрибута с маркой (регистр не важен) — на реальном
# чертеже тег может называться иначе (MARKA, МАРКА и т.д.), просто добавьте
# сюда нужный вариант.
MARK_ATTRIBUTE_TAGS = ["MARK", "MARKA", "МАРКА", "TAG"]

# Максимальное расстояние (в единицах чертежа) от точки вставки элемента до
# точки-стрелки выноски/текста, при котором мы считаем аннотацию
# "относящейся" к элементу. На реальном файле единицы — миллиметры
# ($INSUNITS=4). Для колонн фактическое расстояние стрелка->колонна
# стабильно ~50мм (при шаге между колоннами в метрах). Для ригелей марки —
# отдельный TEXT без выноски, стоящий у конца/сбоку от вытянутого элемента,
# а не у его центроида — расстояние до центроида доходит до ~1540мм на
# реальном файле; проверено, что даже при увеличенном пороге у каждой марки
# явно один ближайший ригель (второй кандидат заметно дальше — 627 из 627
# случаев неоднозначны меньше чем на 30%), поэтому порог можно безопасно
# поднять для всех типов элементов сразу.
MAX_LEADER_MATCH_DISTANCE = 1800.0

# Максимальное расстояние от "хвоста" старого LEADER-а до текста сноски.
MAX_LEADER_TEXT_DISTANCE = 300.0


@dataclass
class ElementRecord:
    id: str
    layer: str
    element_type: str
    mark: Optional[str]
    source: str  # "attribute" | "leader" | "unresolved"
    x: float
    y: float
    z: float
    # Реальный контур элемента (мировые координаты, как в DXF) — есть только
    # у элементов, извлечённых из LWPOLYLINE (см. iter_candidate_elements);
    # у INSERT-блоков геометрия не извлекается, outline = None. Нужен для
    # отображения вытянутых элементов (ригелей) на схеме их настоящей
    # прямоугольной формой, а не условным маркером фиксированного размера.
    outline: Optional[list[tuple[float, float]]] = None
    # Подтип и отметка из нового стандарта имён слоёв (см.
    # scripts/layer_naming.py, scripts/new_standard_pipeline.py) — всегда
    # None для элементов старого конвейера (LAYER_CONFIG).
    subtype: Optional[str] = None
    elevation_mm: Optional[int] = None
    # {"Захватка": zone_binding.ZoneBindingResult, "Кран": ..., "Стоянка": ...}
    # — заполняется только новым конвейером (scripts/new_standard_pipeline.py),
    # None для элементов старого конвейера.
    zone_bindings: Optional[dict] = None


def to_vec2(point) -> Vec2:
    """point может быть Vec3/Vec2 (атрибут .x/.y) или обычным кортежем (x, y, z)."""
    if hasattr(point, "x"):
        return Vec2(point.x, point.y)
    return Vec2(point[0], point[1])


def get_attribute_mark(insert_entity) -> Optional[str]:
    """Возвращает непустой текст атрибута марки, если он есть на блоке."""
    tags = {t.upper() for t in MARK_ATTRIBUTE_TAGS}
    for attrib in insert_entity.attribs:
        if attrib.dxf.tag.upper() in tags:
            text = (attrib.dxf.text or "").strip()
            if text:
                return text
    return None


def polyline_centroid(entity) -> Vec2:
    points = [(p[0], p[1]) for p in entity.get_points()]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return Vec2(sum(xs) / len(xs), sum(ys) / len(ys))


def is_effectively_closed(entity, tol: float = 1e-6) -> bool:
    """
    Замкнутый контур — это либо явный DXF-флаг closed, либо (найдено на
    "260714_Чертежи для WEB.dxf", слой ригелей) контур, где первая и
    последняя точки геометрически совпадают, а флаг при этом не выставлен —
    судя по всему, артефакт того, чем контур рисовался/эталонировался.
    Проверка по флагу остаётся первой и достаточной для уже проверенных
    файлов (колонны) — это чисто аддитивное расширение.
    """
    if entity.closed:
        return True
    points = list(entity.get_points())
    if len(points) < 3:
        return False
    first, last = points[0], points[-1]
    return abs(first[0] - last[0]) < tol and abs(first[1] - last[1]) < tol


def iter_candidate_elements(msp):
    """
    Отдаёт элементы с целевых слоёв в едином виде (layer, handle, точка,
    марка_из_атрибута_или_None, контур_или_None). Два источника геометрии
    на слое:

      - INSERT (блок-вставка) — обычный случай, марка может быть в атрибуте;
        реальный контур не извлекается (outline=None) — блок мог бы иметь
        свою геометрию, но это отдельная, более сложная задача, не нужная
        сегодняшним файлам (колонны с INSERT уже устраивает точка+маркер).
      - если блоков на слое нет вообще, замкнутый LWPOLYLINE — так выглядит
        чертёж после explode (например "260713_Чертежи для WEB.dxf": ни
        одного INSERT во всём файле, только сырая геометрия). У контура
        нет атрибута, поэтому марка для таких элементов всегда ищется
        через выноску, а точкой привязки служит центроид контура; сам
        контур (вершины в мировых координатах) отдаётся отдельно — нужен,
        чтобы вытянутые элементы (ригели) можно было нарисовать на схеме
        их настоящей формой, а не условным маркером (см. Docs/backlog.md).
    """
    for layer in LAYER_CONFIG:
        inserts = [e for e in msp.query("INSERT") if e.dxf.layer == layer]
        if inserts:
            for e in inserts:
                yield layer, e.dxf.handle, to_vec2(e.dxf.insert), get_attribute_mark(e), None
            continue

        polylines = [
            e for e in msp.query("LWPOLYLINE") if e.dxf.layer == layer and is_effectively_closed(e)
        ]
        for e in polylines:
            outline = [(p[0], p[1]) for p in e.get_points()]
            yield layer, e.dxf.handle, polyline_centroid(e), None, outline


def get_text_content(entity) -> str:
    if entity.dxftype() == "MTEXT":
        return entity.plain_text().strip()
    return (entity.dxf.text or "").strip()


def collect_annotations(msp, layers=None):
    """Собирает LEADER, MULTILEADER и текстовые сущности с слоёв-аннотаций.

    layers=None — старое поведение, глобальный ANNOTATION_LAYERS (все
    существующие вызовы). Явный набор слоёв нужен новому стандарту имён
    (scripts/new_standard_pipeline.py) — там аннотации ищутся отдельно на
    каждом слое роли "Марка", своём для каждой группы (тип/подтип/отметка),
    а не в одном общем множестве слоёв на весь файл."""
    if layers is None:
        layers = ANNOTATION_LAYERS
    old_leaders = []  # [{handle, arrow: Vec2, tail: Vec2}]
    multi_leaders = []  # [{handle, arrow_points: [Vec2, ...], text: str}]
    texts = []  # [{handle, point: Vec2, text: str}]

    for entity in msp:
        if entity.dxf.layer not in layers:
            continue
        dxftype = entity.dxftype()

        if dxftype == "LEADER":
            vertices = list(entity.vertices)
            if len(vertices) < 2:
                continue
            old_leaders.append(
                {
                    "handle": entity.dxf.handle,
                    "arrow": to_vec2(vertices[0]),
                    "tail": to_vec2(vertices[-1]),
                }
            )

        elif dxftype == "MULTILEADER":
            arrow_points = []
            for leader in entity.context.leaders:
                for line in leader.lines:
                    arrow_points.extend(to_vec2(v) for v in line.vertices)
            # get_mtext_content() возвращает СЫРОЙ MTEXT-текст с кодами
            # форматирования (например "{\C10;9КН3}" — переопределение
            # цвета) — plain_mtext() их вырезает, оставляя только текст
            # марки (см. Docs/backlog.md, раунд 1 п.13 / раунд 3, скриншот).
            raw_text = entity.get_mtext_content() or ""
            text = plain_mtext(raw_text).strip() if raw_text else ""
            if arrow_points and text:
                multi_leaders.append(
                    {
                        "handle": entity.dxf.handle,
                        "arrow_points": arrow_points,
                        "text": text,
                    }
                )

        elif dxftype in ("TEXT", "MTEXT"):
            texts.append(
                {
                    "handle": entity.dxf.handle,
                    "point": to_vec2(entity.dxf.insert),
                    "text": get_text_content(entity),
                }
            )

    return old_leaders, multi_leaders, texts


def find_nearest_text_entry(point: Vec2, texts, max_distance: float) -> Optional[dict]:
    best = None
    best_dist = max_distance
    for t in texts:
        dist = point.distance(t["point"])
        if dist <= best_dist:
            best_dist = dist
            best = t
    return best


def build_leader_pool(old_leaders, multi_leaders, texts):
    """
    Приводит LEADER, MULTILEADER и "голые" TEXT/MTEXT без выноски к единому
    виду: точка-стрелка (у элемента) + текст марки на другом конце.

    Для старого LEADER текст ищется среди отдельных TEXT/MTEXT сразу здесь —
    это не зависит от того, какому элементу выноска в итоге достанется.

    Найдено на "260714_Чертежи для WEB.dxf": марки ригелей — это отдельные
    TEXT БЕЗ линии-указателя вообще (просто текст рядом с элементом). Такие
    "голые" тексты (не потреблённые для сопоставления с LEADER выше)
    добавляются в пул сами по себе — точка привязки текста служит и точкой
    "стрелки". Глобальная жадная сортировка по расстоянию в
    resolve_via_leaders() ниже гарантирует, что более близкий (и, скорее
    всего, верный) кандидат-элемент заберёт текст раньше более далёкого.
    """
    pool = []  # [{points: [Vec2, ...], text: str, handle: str}]
    used_text_ids = set()

    for ml in multi_leaders:
        pool.append({"points": ml["arrow_points"], "text": ml["text"], "handle": ml["handle"]})

    for leader in old_leaders:
        entry = find_nearest_text_entry(leader["tail"], texts, MAX_LEADER_TEXT_DISTANCE)
        if entry:
            pool.append({"points": [leader["arrow"]], "text": entry["text"], "handle": leader["handle"]})
            used_text_ids.add(id(entry))

    for t in texts:
        if id(t) in used_text_ids:
            continue
        pool.append({"points": [t["point"]], "text": t["text"], "handle": t["handle"]})

    return pool


def resolve_via_leaders(pending: list[dict], leader_pool: list[dict]) -> dict:
    """
    Глобально сопоставляет элементы без марки и доступные выноски: каждая
    выноска может достаться только одному элементу. Наивное "ближайшая
    выноска к каждому элементу по отдельности" ошибается, когда одна
    выноска геометрически ближе всего сразу к нескольким элементам —
    здесь пары (элемент, выноска) сортируются по расстоянию и разбираются
    жадно, поэтому "своя" выноска элемента (расстояние ~0) забирается
    раньше, чем до неё дотянется чужой более далёкий элемент.

    Возвращает {element_index: mark_text}.
    """
    pairs = []  # (dist, element_idx, leader_idx)
    for e_idx, element in enumerate(pending):
        for l_idx, leader in enumerate(leader_pool):
            dist = min(element["point"].distance(p) for p in leader["points"])
            if dist <= MAX_LEADER_MATCH_DISTANCE:
                pairs.append((dist, e_idx, l_idx))

    pairs.sort(key=lambda p: p[0])

    result = {}
    used_elements = set()
    used_leaders = set()
    for dist, e_idx, l_idx in pairs:
        if e_idx in used_elements or l_idx in used_leaders:
            continue
        result[e_idx] = leader_pool[l_idx]["text"]
        used_elements.add(e_idx)
        used_leaders.add(l_idx)

    return result


def parse_dxf(path: str) -> list[ElementRecord]:
    doc = ezdxf.readfile(path)
    return parse_dxf_from_doc(doc)


def parse_dxf_from_doc(doc) -> list[ElementRecord]:
    """Как parse_dxf(), но принимает уже открытый ezdxf-документ — чтобы не
    перечитывать один и тот же (возможно, десятки МБ) DXF с диска дважды,
    когда вызывающему коду отдельно нужна и сетка осей (см. assign_axes.py)."""
    msp = doc.modelspace()

    old_leaders, multi_leaders, texts = collect_annotations(msp)
    leader_pool = build_leader_pool(old_leaders, multi_leaders, texts)

    records: list[ElementRecord] = []
    pending = []  # элементы без марки в атрибуте, ждущие сопоставления с выноской

    for layer, handle, insert_point, mark, outline in iter_candidate_elements(msp):
        record = ElementRecord(
            id=handle,
            layer=layer,
            element_type=LAYER_CONFIG[layer],
            mark=mark,
            source="attribute" if mark is not None else "unresolved",
            x=insert_point.x,
            y=insert_point.y,
            z=0.0,
            outline=outline,
        )
        records.append(record)

        if mark is None:
            pending.append({"record": record, "point": insert_point})

    matches = resolve_via_leaders(pending, leader_pool)
    for e_idx, mark in matches.items():
        record = pending[e_idx]["record"]
        record.mark = mark
        record.source = "leader"

    return records


def print_summary(records: list[ElementRecord]) -> None:
    total = len(records)
    by_source = {"attribute": 0, "leader": 0, "unresolved": 0}
    for r in records:
        by_source[r.source] += 1

    print("=" * 40)
    print("СВОДКА ПО ЭЛЕМЕНТАМ")
    print("=" * 40)
    print(f"{'Всего элементов:':<28}{total}")
    print(f"{'  из атрибута блока:':<28}{by_source['attribute']}")
    print(f"{'  из выноски:':<28}{by_source['leader']}")
    print(f"{'  не определено (unresolved):':<28}{by_source['unresolved']}")
    print("=" * 40)

    if by_source["unresolved"]:
        print("Элементы, требующие ручной проверки:")
        for r in records:
            if r.source == "unresolved":
                print(f"  - handle={r.id} layer={r.layer} x={r.x} y={r.y}")


def write_csv(records: list[ElementRecord], out_path: str) -> None:
    # outline (список вершин контура) сознательно не идёт в CSV — там нет
    # места для вложенной структуры, и сам CLI-путь не сохраняет контур
    # (см. ElementRecord.outline / import_elements.read_rows) — контур
    # доступен только при загрузке DXF через веб-UI (app/dxf_import.py),
    # где ElementRecord используется в памяти напрямую, без CSV.
    fieldnames = ["id", "layer", "element_type", "mark", "source", "x", "y", "z"]
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for r in records:
            writer.writerow(asdict(r))
    print(f"Детальный список сохранён: {out_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dxf_path", help="Путь к DXF-файлу")
    parser.add_argument(
        "--out", default="output/elements.csv", help="Путь к результирующему CSV"
    )
    args = parser.parse_args()

    try:
        records = parse_dxf(args.dxf_path)
    except IOError:
        print(f"Не удалось открыть файл: {args.dxf_path}", file=sys.stderr)
        sys.exit(1)
    except ezdxf.DXFStructureError:
        print(f"Файл повреждён или не является корректным DXF: {args.dxf_path}", file=sys.stderr)
        sys.exit(1)

    print_summary(records)
    write_csv(records, args.out)


if __name__ == "__main__":
    main()
