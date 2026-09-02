"""
Ручной ввод секций, этажей и блоков объекта (Docs/block-accounting.md).

Второй контур учёта — «вид работ × блок (этаж + секция) -> статус» — не
зависит от модели Revit: у объекта может не быть вообще никакой выгрузки, и
секции/этажи тогда заводятся руками. Пишет в ТЕ ЖЕ таблицы
(`object_sections`, `object_levels`), что и `app/revit_catalog.py` при
импорте Revit-пакета, — если выгрузка появится позже,
`revit_package.normalize_section` сведёт её секции к тем же кодам `С01`/
`С02`, и уже заведённые вручную записи не задвоятся (уникальность по
`(object_id, code)` / `(object_id, key)`).

Этаж — ОБЩАЯ для всех секций объекта запись (как в Revit-модели: один и тот
же 5-й этаж обычно стоит на одной отметке во всей секции здания), а то, у
какой секции этот этаж есть, решает отдельная явная отметка — блок. Кровля
исключение: у каждой секции своя, и ключ этажа несёт код секции
(`revit_package.Level.key`), поэтому кровля заводится персонально на секцию
(можно на несколько сразу, если крыша общая).

Блоки — НЕ декартово произведение секций и этажей (block-accounting.md §3):
у секции может не быть верхних этажей, поэтому блок создаётся явно.
"""

from app.block_geometry import section_box_xy
from app.revit_package import KIND_ROOF, normalize_section


class BlockError(Exception):
    """Ошибка, предназначенная пользователю (текст в сообщении)."""


def _next_sort_order(conn, table: str, object_id: int) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM %s WHERE object_id = ?" % table,
        (object_id,),
    ).fetchone()
    return row["n"]


# ---------------------------------------------------------------- секции


def list_sections(conn, object_id: int) -> list:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT id, code, name, axis_from, axis_to, sort_order FROM object_sections "
            "WHERE object_id = ? ORDER BY sort_order, code",
            (object_id,),
        )
    ]


def create_section(conn, object_id: int, code_input: str, name: str = None,
                   trusted: bool = False) -> dict:
    """`trusted=True` — вызывающий код сам ручается за код (константа в
    своём модуле, не введённое человеком или Revit-метаданными значение)
    и пропускает `normalize_section`. Только для этого: она защищает от
    МУСОРА (docstring `normalize_section`, «Автостоянка» из Revit-
    выгрузки) — не от осознанно заведённых секций вне формата «С0N»
    (2026-08-31, секция «Паркинг» из PDF-загрузки, прямое уточнение
    пользователя)."""
    code = code_input if trusted else normalize_section(code_input)
    if not code:
        raise BlockError(
            "Не похоже на секцию: «%s». Ожидается «С01», «Секция 1» или «1»." % code_input)
    exists = conn.execute(
        "SELECT id FROM object_sections WHERE object_id = ? AND code = ?",
        (object_id, code),
    ).fetchone()
    if exists:
        raise BlockError("Секция «%s» уже заведена." % code)
    order = _next_sort_order(conn, "object_sections", object_id)
    cur = conn.execute(
        "INSERT INTO object_sections (object_id, code, name, sort_order) VALUES (?,?,?,?)",
        (object_id, code, (name or code).strip(), order),
    )
    conn.commit()
    return {"id": cur.lastrowid, "code": code, "name": (name or code).strip(), "sort_order": order}


def update_section(conn, object_id: int, section_id: int, name: str,
                   axis_from: str = None, axis_to: str = None) -> None:
    """Правится подпись и (опционально) привязка к осям для геометрии
    блока (Docs/TZ.md, «Геометрия блока») — код держит ключи блоков,
    `revit_elements` и `object_level_aliases`, менять его после создания
    нельзя."""
    cur = conn.execute(
        "UPDATE object_sections SET name = ? WHERE id = ? AND object_id = ?",
        (name.strip(), section_id, object_id),
    )
    if cur.rowcount == 0:
        raise BlockError("Секция не найдена.")
    _set_section_axes(conn, object_id, section_id, axis_from, axis_to)
    conn.commit()


def _set_section_axes(conn, object_id: int, section_id: int,
                      axis_from: str = None, axis_to: str = None) -> None:
    """Привязка секции к осям здания. Обе пустые — снять привязку (секция
    остаётся без геометрии, учёт по блокам это не трогает)."""
    axis_from = (axis_from or "").strip() or None
    axis_to = (axis_to or "").strip() or None
    if (axis_from is None) != (axis_to is None):
        raise BlockError("Нужны обе оси сразу — «от» и «до» — или ни одной.")

    if axis_from is not None:
        grids = {
            row["label"]: [row["x1"], row["y1"], row["x2"], row["y2"]]
            for row in conn.execute(
                "SELECT label, x1, y1, x2, y2 FROM object_grids WHERE object_id = ?",
                (object_id,),
            )
        }
        missing = [a for a in (axis_from, axis_to) if a not in grids]
        if missing:
            raise BlockError("Оси не найдены у объекта: %s." % ", ".join(missing))
        if section_box_xy(grids[axis_from], grids[axis_to]) is None:
            raise BlockError(
                "Оси «%s» и «%s» разнонаправленные — прямоугольник между ними "
                "не определён." % (axis_from, axis_to))

    conn.execute(
        "UPDATE object_sections SET axis_from = ?, axis_to = ? WHERE id = ?",
        (axis_from, axis_to, section_id),
    )


def delete_section(conn, object_id: int, section_id: int) -> None:
    row = conn.execute(
        "SELECT id FROM object_sections WHERE id = ? AND object_id = ?",
        (section_id, object_id),
    ).fetchone()
    if not row:
        raise BlockError("Секция не найдена.")
    used = conn.execute(
        "SELECT 1 FROM blocks WHERE section_id = ? "
        "UNION SELECT 1 FROM revit_elements WHERE section_id = ? "
        "UNION SELECT 1 FROM revit_rooms WHERE section_id = ? "
        "UNION SELECT 1 FROM object_flats WHERE section_id = ? "
        "UNION SELECT 1 FROM work_progress WHERE section_id = ?",
        (section_id, section_id, section_id, section_id, section_id),
    ).fetchone()
    if used:
        raise BlockError(
            "Секция используется (блоки, элементы модели или статусы работ) — "
            "сначала удалите ссылки на неё.")
    conn.execute("DELETE FROM object_sections WHERE id = ?", (section_id,))
    conn.commit()


# ----------------------------------------------------------------- этажи


def _level_key(kind: str, floor, section_codes: list) -> str:
    if kind == KIND_ROOF:
        коды = sorted(section_codes or [])
        if not коды:
            raise BlockError("У кровли должна быть хотя бы одна секция.")
        return "кровля:%s" % ",".join(коды)
    if floor is None:
        raise BlockError("Для этажа нужен номер (кровля — исключение).")
    # Этаж ОДНОЙ секции на собственной отметке (техпространство и выход на
    # кровлю секции 1 заводятся как её этажи 9 и 10 — 2026-09-02, живой
    # запрос пользователя «чтобы отбирались все этажи по номерам») — свой
    # ключ, чтобы не склеиться с этажом 9/10 секции 2 на другой отметке.
    # Обычный этаж (без секций в ключе) — как раньше, общая запись объекта.
    if section_codes:
        return "этаж:%d:%s" % (floor, ",".join(sorted(section_codes)))
    return "этаж:%d" % floor


def list_levels(conn, object_id: int) -> list:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT id, key, floor, kind, name, elevation_mm, elevation_suspect, "
            "sort_order FROM object_levels WHERE object_id = ? "
            "ORDER BY sort_order, floor",
            (object_id,),
        )
    ]


def create_level(conn, object_id: int, kind: str, floor: int = None, name: str = None,
                 elevation_mm: float = None, section_codes: list = None,
                 height_mm: float = None) -> dict:
    key = _level_key(kind, floor, section_codes)
    exists = conn.execute(
        "SELECT id FROM object_levels WHERE object_id = ? AND key = ?",
        (object_id, key),
    ).fetchone()
    if exists:
        raise BlockError("Такой этаж уже заведён (%s)." % key)
    display_name = (name or (("Кровля" if kind == KIND_ROOF else "Этаж %d" % floor))).strip()
    order = floor if floor is not None else 9000 + _next_sort_order(conn, "object_levels", object_id)
    cur = conn.execute(
        "INSERT INTO object_levels (object_id, key, floor, kind, name, elevation_mm, "
        "elevation_source, elevation_suspect, sort_order, height_mm) VALUES (?,?,?,?,?,?,?,0,?,?)",
        (object_id, key, floor, kind, display_name, elevation_mm, "вручную", order, height_mm),
    )
    conn.commit()
    return {"id": cur.lastrowid, "key": key, "floor": floor, "kind": kind,
            "name": display_name, "elevation_mm": elevation_mm, "sort_order": order,
            "height_mm": height_mm}


def update_level(conn, object_id: int, level_id: int, name: str = None,
                 elevation_mm: float = None, height_mm: float = None) -> None:
    """Правятся только подпись, отметка и высота — `key`/`floor`/`kind`
    держат блоки и (потенциально) привязку элементов модели."""
    row = conn.execute(
        "SELECT id, name, elevation_mm, height_mm FROM object_levels WHERE id = ? AND object_id = ?",
        (level_id, object_id),
    ).fetchone()
    if not row:
        raise BlockError("Этаж не найден.")
    conn.execute(
        "UPDATE object_levels SET name = ?, elevation_mm = ?, height_mm = ? WHERE id = ?",
        (name.strip() if name is not None else row["name"],
         elevation_mm if elevation_mm is not None else row["elevation_mm"],
         height_mm if height_mm is not None else row["height_mm"],
         level_id),
    )
    conn.commit()


def delete_level(conn, object_id: int, level_id: int) -> None:
    row = conn.execute(
        "SELECT id FROM object_levels WHERE id = ? AND object_id = ?",
        (level_id, object_id),
    ).fetchone()
    if not row:
        raise BlockError("Этаж не найден.")
    used = conn.execute(
        "SELECT 1 FROM blocks WHERE level_id = ? "
        "UNION SELECT 1 FROM revit_elements WHERE level_id = ? "
        "UNION SELECT 1 FROM revit_rooms WHERE level_id = ? "
        "UNION SELECT 1 FROM object_flats WHERE level_id = ?",
        (level_id, level_id, level_id),
    ).fetchone()
    if used:
        raise BlockError(
            "Этаж используется (блоки или элементы модели) — сначала удалите ссылки на него.")
    conn.execute("DELETE FROM object_levels WHERE id = ?", (level_id,))
    conn.commit()


# ---------------------------------------------------------------- блоки


def list_blocks(conn, object_id: int) -> list:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT b.id, b.section_id, s.code AS section_code, s.name AS section_name, "
            "b.level_id, l.key AS level_key, l.floor, l.kind, l.name AS level_name, "
            "l.sort_order AS level_sort "
            "FROM blocks b "
            "JOIN object_sections s ON s.id = b.section_id "
            "JOIN object_levels l ON l.id = b.level_id "
            "WHERE b.object_id = ? "
            "ORDER BY s.sort_order, l.sort_order",
            (object_id,),
        )
    ]


def create_block(conn, object_id: int, section_id: int, level_id: int) -> dict:
    section = conn.execute(
        "SELECT id FROM object_sections WHERE id = ? AND object_id = ?",
        (section_id, object_id),
    ).fetchone()
    level = conn.execute(
        "SELECT id FROM object_levels WHERE id = ? AND object_id = ?",
        (level_id, object_id),
    ).fetchone()
    if not section or not level:
        raise BlockError("Секция или этаж не найдены у этого объекта.")
    cur = conn.execute(
        "INSERT OR IGNORE INTO blocks (object_id, section_id, level_id) VALUES (?,?,?)",
        (object_id, section_id, level_id),
    )
    conn.commit()
    if cur.lastrowid and cur.rowcount:
        block_id = cur.lastrowid
    else:
        block_id = conn.execute(
            "SELECT id FROM blocks WHERE section_id = ? AND level_id = ?",
            (section_id, level_id),
        ).fetchone()["id"]
    return {"id": block_id, "section_id": section_id, "level_id": level_id}


def delete_block(conn, object_id: int, block_id: int) -> None:
    row = conn.execute(
        "SELECT id FROM blocks WHERE id = ? AND object_id = ?", (block_id, object_id),
    ).fetchone()
    if not row:
        raise BlockError("Блок не найден.")
    used = conn.execute(
        "SELECT 1 FROM work_progress WHERE block_id = ?", (block_id,),
    ).fetchone()
    if used:
        raise BlockError("По блоку уже проставлены статусы работ — сначала снимите их.")
    conn.execute("DELETE FROM blocks WHERE id = ?", (block_id,))
    conn.commit()
