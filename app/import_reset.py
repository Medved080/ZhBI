"""
Отладочная очистка справочников объекта, связанных с загрузкой из Revit/PDF
(Docs/TZ.md, «Очистка перед повторной загрузкой»).

Пока подбирается алгоритм секций/этажей (сшивка разделов, доопределение
секции по геометрии), нужны частые повторные загрузки «с чистого листа» —
иначе хвосты, оставленные предыдущей версией логики, мешают сравнивать
результат новой. Три независимые группы, пользователь отмечает нужные явно:

  elements  — сами элементы модели/помещения (revit_elements, revit_rooms,
              revit_packages, object_flats), в границах ОДНОГО источника:
              elements_source="revit" чистит разделы Revit (всё, что не
              раздел PDF), elements_source="pdf" — только раздел PDF. Они не
              пересекаются (Docs/TZ.md §3а, «Второй источник геометрии»),
              поэтому загрузка одного не должна списывать данные другого.
  structure — секции и этажи объекта (object_sections, object_levels,
              object_level_aliases). ОБЩИЕ со вторым контуром учёта —
              «Учёт по блокам» (Docs/block-accounting.md): их удаление
              каскадом сносит blocks и завязанный на них work_progress,
              даже если группа work не отмечена.
  work      — виды работ и статусы блоков (work_types, blocks,
              work_progress).
"""

import sqlite3


def clear(conn: sqlite3.Connection, object_id: int, *, elements: bool = False,
          elements_source: str = None, structure: bool = False,
          work: bool = False) -> dict:
    counts: dict = {}

    def _delete(table: str, where: str, params: tuple, key: str) -> None:
        n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0]
        if n:
            conn.execute(f"DELETE FROM {table} WHERE {where}", params)
        counts[key] = counts.get(key, 0) + n

    if elements:
        if elements_source not in ("revit", "pdf"):
            raise ValueError("elements_source must be 'revit' or 'pdf'")
        # Раздел PDF задан фиксированной строкой в app/pdf_import.py —
        # так же, как там, а не через отдельную константу: значение нигде,
        # кроме этих двух мест, не используется.
        секция = "section_code = 'PDF'" if elements_source == "pdf" else "section_code != 'PDF'"
        _delete("revit_elements", f"object_id = ? AND {секция}", (object_id,), "revit_elements")
        _delete("revit_rooms", f"object_id = ? AND {секция}", (object_id,), "revit_rooms")
        if elements_source == "revit":
            # Пакеты и квартиры — только Revit: PDF не даёт ни выгрузок
            # (это разбор одного файла, не «пакет»), ни номеров помещений,
            # из которых собираются квартиры.
            _delete("revit_packages", "object_id = ?", (object_id,), "revit_packages")
            _delete("object_flats", "object_id = ?", (object_id,), "object_flats")

    if structure:
        _delete("object_level_aliases", "object_id = ?", (object_id,), "object_level_aliases")
        _delete("object_levels", "object_id = ?", (object_id,), "object_levels")
        _delete("object_sections", "object_id = ?", (object_id,), "object_sections")

    if work:
        _delete("blocks", "object_id = ?", (object_id,), "blocks")
        _delete("work_types", "object_id = ?", (object_id,), "work_types")

    conn.commit()
    return counts
