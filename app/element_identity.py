"""
Сопоставление элементов между версиями чертежа — решение И2 (см.
Docs/backlog.md, запись 2026-07-30 "Задача… объекты системы").

Зачем вообще: до этого идентичностью элемента была пара (source_file,
dxf_handle), то есть имя файла входило в идентичность, и новая версия
чертежа давала полный набор новых строк со статусом "Запланирован".
Теперь элементы живут на уровне Объекта, а переимпорт ОБНОВЛЯЕТ их —
значит нужно уметь надёжно узнать "тот же физический элемент".

Почему сверка многоуровневая, а не по одному ключу — замерено на всех
версиях чертежа, лежащих в БД (числа в записи backlog):

  * `dxf_handle` — точен там, где сработал (совпал handle => марка и
    координаты совпадали в 100% случаев), но дважды из шести переходов
    обнулялся ПОЛНОСТЬЮ: заказчик перерисовывал чертёж заново. На
    260716 -> 260720 он опознал лишь 3333 элемента из 5330.

  * геометрия (тип + центроид контура) — ловит перерисованное: на том же
    переходе опознала 4856, включая 1523 элемента со сменившимся handle.
    Но САМА теряет там, где handle цел: на 260722 -> 260723 у 1771
    элемента при неизменных handle и геометрии сменилась ОТМЕТКА
    (15800->15000 у 634 шт. и т.д. — заказчик переразметил ярусы).

Отсюда конструкция: сначала handle, затем геометрия по остатку, причём
отметка — АТРИБУТ (её расхождение попадает в сводку), а не часть ключа.
Иначе те 1771 элемента выглядели бы как "1771 исчезло + 1771 новых" и
потеряли бы статусы.

Модуль намеренно чистый: никаких обращений к БД и к ezdxf, только
структуры данных на входе и выходе. Так его можно прогонять на реальных
данных изолированным скриптом (методология проекта), что и сделано.
"""

import json
from dataclasses import dataclass, field
from typing import Optional

# Допуск сопоставления по геометрии, мм. 50 мм — не «подобрано, чтобы
# сошлось»: на реальных переходах результат одинаков при 1, 50 и 200 мм
# (замер в записи backlog), то есть центроиды либо совпадают точно, либо
# расходятся на порядки больше. Небольшой допуск нужен на случай, если
# заказчик перерисует контур с микросдвигом.
GEOMETRY_TOLERANCE_MM = 50.0

# Поля, расхождение которых у сопоставленного элемента показывается в
# сводке. Марка — отдельно и громко (решение И4): она привязана к позиции
# контракта, молчаливая смена сломала бы назначение.
_TRACKED_FIELDS = ("mark", "element_type", "subtype", "elevation_mm", "floor")


@dataclass
class ElementMatch:
    """Одна найденная пара «строка в БД <-> элемент в новом чертеже»."""
    element_id: int
    incoming_index: int
    how: str  # "handle" | "geometry"
    changes: dict = field(default_factory=dict)  # поле -> (было, стало)


@dataclass
class MatchResult:
    matched: list = field(default_factory=list)      # list[ElementMatch]
    new_indexes: list = field(default_factory=list)  # индексы в incoming
    retired_ids: list = field(default_factory=list)  # id элементов, исчезнувших из чертежа

    @property
    def by_handle(self) -> list:
        return [m for m in self.matched if m.how == "handle"]

    @property
    def by_geometry(self) -> list:
        return [m for m in self.matched if m.how == "geometry"]

    @property
    def mark_changes(self) -> list:
        return [m for m in self.matched if "mark" in m.changes]

    def counts(self) -> dict:
        return {
            "matched_by_handle": len(self.by_handle),
            "matched_by_geometry": len(self.by_geometry),
            "new": len(self.new_indexes),
            "retired": len(self.retired_ids),
            "mark_changed": len(self.mark_changes),
            "attribute_changed": sum(1 for m in self.matched if m.changes),
        }


def _outline_of(row) -> Optional[list]:
    """Контур из строки БД (outline_json — текст) или из строки импорта
    (там уже готовый JSON-текст, см. import_elements.build_row)."""
    raw = row.get("outline_json")
    if not raw:
        return None
    if isinstance(raw, (list, tuple)):
        return list(raw)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if parsed else None


def centroid_of(row) -> Optional[tuple]:
    """Центр РЕАЛЬНОГО контура, а не x/y элемента: x/y — точка вставки
    марки-выноски, она заметно смещена от фигуры (на этом же основании
    строится rubberBandTestPoint на фронтенде и привязка концов ригеля к
    колоннам, см. Docs/backlog.md). Элементов без контура на реальном
    файле 0 из 9422, но старый конвейер (INSERT-блоки) их допускает —
    такие сопоставляются только по handle."""
    outline = _outline_of(row)
    if not outline:
        return None
    n = len(outline)
    return (sum(p[0] for p in outline) / n, sum(p[1] for p in outline) / n)


def _changes_between(existing, incoming) -> dict:
    changes = {}
    for key in _TRACKED_FIELDS:
        was = existing.get(key)
        now = incoming.get(key)
        if was != now:
            changes[key] = (was, now)
    return changes


def _bucket(centroid, tolerance) -> tuple:
    return (int(centroid[0] // tolerance), int(centroid[1] // tolerance))


def match_elements(existing_rows, incoming_rows, tolerance=GEOMETRY_TOLERANCE_MM) -> MatchResult:
    """existing_rows — элементы объекта, как они сейчас в БД (нужны ключи
    id, dxf_handle, element_type, mark, subtype, elevation_mm, floor,
    outline_json). incoming_rows — строки нового чертежа в порядке
    import_elements.build_row().

    Возвращает MatchResult. Ни одна строка БД и ни один элемент чертежа не
    участвуют в двух парах одновременно.
    """
    result = MatchResult()

    existing_by_id = {row["id"]: row for row in existing_rows}
    free_existing = set(existing_by_id)

    # --- Уровень 1: dxf_handle ---------------------------------------
    # handle уникален внутри файла, а все элементы объекта пришли из одного
    # (актуального) чертежа — значит внутри объекта он тоже уникален.
    by_handle = {}
    for row in existing_rows:
        by_handle.setdefault(row["dxf_handle"], row["id"])

    unmatched_incoming = []
    for index, row in enumerate(incoming_rows):
        element_id = by_handle.get(row["dxf_handle"])
        if element_id is not None and element_id in free_existing:
            free_existing.discard(element_id)
            result.matched.append(ElementMatch(
                element_id=element_id, incoming_index=index, how="handle",
                changes=_changes_between(existing_by_id[element_id], row),
            ))
        else:
            unmatched_incoming.append(index)

    # --- Уровень 2а: точное совпадение тип + отметка + центроид -------
    # Дешёвый проход по остатку: ловит элементы, которые просто перерисовали
    # (handle новый), не сдвинув и не переразметив.
    exact_key_to_id = {}
    for element_id in free_existing:
        row = existing_by_id[element_id]
        centroid = centroid_of(row)
        if centroid is None:
            continue
        key = (row["element_type"], row.get("elevation_mm"), round(centroid[0]), round(centroid[1]))
        exact_key_to_id.setdefault(key, []).append(element_id)

    still_unmatched = []
    for index in unmatched_incoming:
        row = incoming_rows[index]
        centroid = centroid_of(row)
        if centroid is None:
            still_unmatched.append(index)
            continue
        key = (row["element_type"], row.get("elevation_mm"), round(centroid[0]), round(centroid[1]))
        candidates = [i for i in exact_key_to_id.get(key, []) if i in free_existing]
        if candidates:
            element_id = min(candidates)
            free_existing.discard(element_id)
            result.matched.append(ElementMatch(
                element_id=element_id, incoming_index=index, how="geometry",
                changes=_changes_between(existing_by_id[element_id], row),
            ))
        else:
            still_unmatched.append(index)

    # --- Уровень 2б: ближайший в плане, с допуском --------------------
    # Отметка здесь НЕ в ключе (иначе потеряли бы 1771 переразмеченный
    # элемент), но участвует как ВТОРОЙ критерий близости: колонны стоят
    # стопкой на 4 ярусах в одной точке плана (без отметки ключ давал 3357
    # дублей на 9422 элементах), и различить их можно только по ней.
    # Проход по возрастанию отметки делает раздачу внутри стопки
    # предсказуемой, а не зависящей от порядка в файле.
    buckets = {}
    for element_id in free_existing:
        row = existing_by_id[element_id]
        centroid = centroid_of(row)
        if centroid is None:
            continue
        buckets.setdefault((row["element_type"], _bucket(centroid, tolerance)), []).append(
            (element_id, centroid)
        )

    def _sort_key(index):
        elevation = incoming_rows[index].get("elevation_mm")
        return (elevation if elevation is not None else -1, index)

    for index in sorted(still_unmatched, key=_sort_key):
        row = incoming_rows[index]
        centroid = centroid_of(row)
        if centroid is None:
            result.new_indexes.append(index)
            continue
        bx, by = _bucket(centroid, tolerance)
        best = None  # (расстояние в плане, |разница отметок|, element_id)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for element_id, other in buckets.get((row["element_type"], (bx + dx, by + dy)), []):
                    if element_id not in free_existing:
                        continue
                    distance = max(abs(other[0] - centroid[0]), abs(other[1] - centroid[1]))
                    if distance > tolerance:
                        continue
                    was = existing_by_id[element_id].get("elevation_mm")
                    now = row.get("elevation_mm")
                    elevation_gap = abs((was or 0) - (now or 0)) if (was is not None and now is not None) else 0
                    candidate = (distance, elevation_gap, element_id)
                    if best is None or candidate < best:
                        best = candidate
        if best is None:
            result.new_indexes.append(index)
            continue
        element_id = best[2]
        free_existing.discard(element_id)
        result.matched.append(ElementMatch(
            element_id=element_id, incoming_index=index, how="geometry",
            changes=_changes_between(existing_by_id[element_id], row),
        ))

    result.new_indexes.sort()
    result.retired_ids = sorted(free_existing)
    return result
