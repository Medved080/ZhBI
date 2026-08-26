"""
Геометрия блока «этаж × секция» — параллелепипед из осей здания
(Docs/TZ.md, «Геометрия блока»).

Блок «Учёта по блокам» (app/blocks.py, Docs/block-accounting.md) — пара
(секция, этаж), абстрактная запись без формы. Здесь она получает форму:
прямоугольник в плане, взятый из ДВУХ осей здания (`object_grids`, куда
их сохраняет `app/revit_catalog._apply_grids`), и вертикальный диапазон
из отметок этажей (`object_levels`).

`axis_position`/`section_box_xy` — чистые функции без БД, как
`app/revit_package.py`: изолированно проверяются на синтетических
данных. `block_box` — единственная функция с обращением к БД, собирает
готовый параллелепипед по объекту/секции/этажу.

Не додумывает: без обеих осей секции, без отметки этажа, при
подозрительной отметке (`elevation_suspect`) или разнонаправленных
осях геометрия не строится вовсе — возвращается причина, а не
приблизительное значение, выданное за точное.
"""


def axis_position(line) -> tuple:
    """`line` — `[x1, y1, x2, y2]`, отрезок оси через всё здание в одном
    направлении. Короткая разница координат — направление «поперёк»
    (это и есть положение оси); длинная — «вдоль» (пролёт оси, он же
    нужный поперечный размер параллелепипеда: ось нарисована из конца в
    конец здания).

    Возвращает `(ось, координата, пролёт)`, где `ось` — `'x'` или `'y'`.
    """
    x1, y1, x2, y2 = line
    if abs(x1 - x2) <= abs(y1 - y2):
        return "x", (x1 + x2) / 2, (min(y1, y2), max(y1, y2))
    return "y", (y1 + y2) / 2, (min(x1, x2), max(x1, x2))


def section_box_xy(from_line, to_line):
    """Прямоугольник секции в плане по двум осям-границам.

    `None`, если оси разнонаправленные («горизонтальная» и
    «вертикальная») — тогда диапазон между ними не определён, привязка
    выбрана неверно."""
    ось1, коорд1, пролёт1 = axis_position(from_line)
    ось2, коорд2, пролёт2 = axis_position(to_line)
    if ось1 != ось2:
        return None
    низ, верх = sorted((коорд1, коорд2))
    поперёк_низ = min(пролёт1[0], пролёт2[0])
    поперёк_верх = max(пролёт1[1], пролёт2[1])
    if ось1 == "x":
        return {"x0": низ, "x1": верх, "y0": поперёк_низ, "y1": поперёк_верх}
    return {"x0": поперёк_низ, "x1": поперёк_верх, "y0": низ, "y1": верх}


def _grid_line(conn, object_id: int, label: str):
    row = conn.execute(
        "SELECT x1, y1, x2, y2 FROM object_grids WHERE object_id = ? AND label = ?",
        (object_id, label),
    ).fetchone()
    if row is None:
        return None
    return [row["x1"], row["y1"], row["x2"], row["y2"]]


def _level_height(conn, object_id: int, floor, z0: float):
    """Высота этажа = отметка СЛЕДУЮЩЕГО по номеру этажа объекта минус
    текущая (этаж — общая запись объекта, не по секции). Для последнего
    этажа (следующего нет) берётся шаг ПРЕДЫДУЩЕГО и возвращается
    `approx=True` — высота не додумана незаметно, а помечена."""
    if floor is None:
        return None, False
    rows = conn.execute(
        "SELECT floor, elevation_mm FROM object_levels "
        "WHERE object_id = ? AND floor IS NOT NULL AND elevation_mm IS NOT NULL "
        "AND elevation_suspect = 0 ORDER BY floor",
        (object_id,),
    ).fetchall()
    отметки = {r["floor"]: r["elevation_mm"] for r in rows}
    этажи = sorted(отметки)
    if floor not in этажи:
        return None, False
    idx = этажи.index(floor)
    if idx + 1 < len(этажи):
        высота = отметки[этажи[idx + 1]] - z0
        return (высота, False) if высота > 0 else (None, False)
    if idx > 0:
        высота = z0 - отметки[этажи[idx - 1]]
        return (высота, True) if высота > 0 else (None, False)
    return None, False


def block_box(conn, object_id: int, section_id: int, level_id: int) -> dict:
    """Параллелепипед блока — или причина, почему его нет.

    Возвращает `{"ok": False, "reason": "..."}` либо `{"ok": True,
    "approx_height": bool, "x0","x1","y0","y1","z0","z1"}` (координаты —
    в общих координатах площадки, как у `revit_elements`)."""
    section = conn.execute(
        "SELECT axis_from, axis_to FROM object_sections WHERE id = ?", (section_id,)
    ).fetchone()
    if section is None:
        return {"ok": False, "reason": "секция не найдена"}
    if not section["axis_from"] or not section["axis_to"]:
        return {"ok": False, "reason": "у секции не заданы оси"}

    from_line = _grid_line(conn, object_id, section["axis_from"])
    to_line = _grid_line(conn, object_id, section["axis_to"])
    if from_line is None or to_line is None:
        return {"ok": False, "reason": "ось секции не найдена в модели объекта"}

    xy = section_box_xy(from_line, to_line)
    if xy is None:
        return {"ok": False, "reason": "оси секции разнонаправленные"}

    level = conn.execute(
        "SELECT floor, elevation_mm, elevation_suspect FROM object_levels WHERE id = ?",
        (level_id,),
    ).fetchone()
    if level is None:
        return {"ok": False, "reason": "этаж не найден"}
    if level["elevation_mm"] is None or level["elevation_suspect"]:
        return {"ok": False, "reason": "отметке этажа верить нельзя"}

    z0 = level["elevation_mm"]
    высота, approx = _level_height(conn, object_id, level["floor"], z0)
    if высота is None:
        return {"ok": False, "reason": "высоту этажа определить не из чего"}

    return {
        "ok": True, "approx_height": approx,
        "x0": xy["x0"], "x1": xy["x1"], "y0": xy["y0"], "y1": xy["y1"],
        "z0": z0, "z1": z0 + высота,
    }
