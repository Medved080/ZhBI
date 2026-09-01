"""
Геометрия блока «этаж × секция» — параллелепипед из осей здания
(Docs/TZ.md, «Геометрия блока»).

Блок «Учёта по блокам» (app/blocks.py, Docs/block-accounting.md) — пара
(секция, этаж), абстрактная запись без формы. Здесь она получает форму:
прямоугольник в плане, взятый из ДВУХ осей здания (`object_grids`, куда
их сохраняет `app/revit_catalog._apply_grids`) и подогнанный по факту
контуров элементов ИМЕННО этого этажа (`_section_element_bounds`, 2026-
08-27/2026-08-31) — оси на реальных чертежах продолжены далеко за
периметр здания, а здание почти всегда уже к верхним этажам, поэтому
один размер на всю секцию не годится; вдоль осей, наоборот, блок
растягивается наружу, если факт шире — ось лежит внутри стены/колонны,
а не по её грани (Docs/TZ.md, «Геометрия блока»). Вертикальный диапазон
— из отметок этажей (`object_levels`).

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


def section_box_xy(from_line, to_line, element_bounds=None):
    """Прямоугольник секции в плане по двум осям-границам.

    `None`, если оси разнонаправленные («горизонтальная» и
    «вертикальная») — тогда диапазон между ними не определён, привязка
    выбрана неверно.

    `element_bounds` — необязательный `(x0, y0, x1, y1)` реальной
    геометрии (по элементам модели): блок подгоняется под НЕЁ по обоим
    измерениям, оси — только стартовая привязка, не источник истины.
    Поперечный размер ОБРЕЗАЕТСЯ (2026-08-27): на реальных чертежах оси
    сплошь и рядом продолжены далеко за периметр здания под выносные
    линии и подписи (скриншот пользователя, откуда взят весь этот
    механизм) — без обрезки блок расползается на пустое место вокруг
    здания. Продольный размер (между самими осями), наоборот,
    РАСТЯГИВАЕТСЯ наружу, если факт шире (2026-08-31, по прямому запросу
    пользователя): ось — это ОСЬ конструкции, а не её грань, и лежит
    ВНУТРИ стены/колонны — сама стена всегда чуть шире расстояния между
    осями. `block_box` передаёт сюда габарит КОНКРЕТНОГО этажа секции, не
    всей секции целиком: здание почти всегда УЖЕ к верхним этажам, и один
    размер на всю секцию раздувал бы узкие верхние этажи до ширины
    нижнего/самого широкого."""
    ось1, коорд1, пролёт1 = axis_position(from_line)
    ось2, коорд2, пролёт2 = axis_position(to_line)
    if ось1 != ось2:
        return None
    низ, верх = sorted((коорд1, коорд2))
    поперёк_низ = min(пролёт1[0], пролёт2[0])
    поперёк_верх = max(пролёт1[1], пролёт2[1])
    if element_bounds is not None:
        bx0, by0, bx1, by1 = element_bounds
        if ось1 == "x":
            низ = min(низ, bx0)
            верх = max(верх, bx1)
            поперёк_низ = max(поперёк_низ, by0)
            поперёк_верх = min(поперёк_верх, by1)
        else:
            низ = min(низ, by0)
            верх = max(верх, by1)
            поперёк_низ = max(поперёк_низ, bx0)
            поперёк_верх = min(поперёк_верх, bx1)
        if поперёк_низ >= поперёк_верх:
            return None
    if ось1 == "x":
        return {"x0": низ, "x1": верх, "y0": поперёк_низ, "y1": поперёк_верх}
    return {"x0": поперёк_низ, "x1": поперёк_верх, "y0": низ, "y1": верх}


def _section_element_bounds(conn, object_id: int, section_id: int, level_id: int = None):
    """Реальный габарит по КОНТУРАМ элементов модели — этого КОНКРЕТНОГО
    этажа секции (`level_id` передан) либо секции целиком, все этажи
    сразу (не передан — например, для отладочного вызова без привязки к
    этажу). По контурам, не по точкам вставки: последние могут стоять у
    центра/торца элемента и заузить границу там, где стена на самом деле
    ещё продолжается. `json_each` — штатное расширение SQLite (JSON1), в
    проекте до сих пор не использовалось, но всегда включено в обычной
    сборке.

    `None`, если у этажа/секции ещё нет ни одного элемента с контуром —
    обрезать тогда не по чему, используется пролёт осей как есть."""
    where = ["e.object_id = ?", "e.section_id = ?", "e.is_current = 1",
             "e.outline_json IS NOT NULL"]
    params = [object_id, section_id]
    if level_id is not None:
        where.append("e.level_id = ?")
        params.append(level_id)
    row = conn.execute(
        "SELECT MIN(json_extract(pt.value, '$[0]')) AS x0, "
        "       MIN(json_extract(pt.value, '$[1]')) AS y0, "
        "       MAX(json_extract(pt.value, '$[0]')) AS x1, "
        "       MAX(json_extract(pt.value, '$[1]')) AS y1 "
        "FROM revit_elements e, json_each(e.outline_json) AS pt "
        "WHERE " + " AND ".join(where), tuple(params),
    ).fetchone()
    if row is None or row["x0"] is None:
        return None
    return (row["x0"], row["y0"], row["x1"], row["y1"])


def _grid_line(conn, object_id: int, label: str):
    row = conn.execute(
        "SELECT x1, y1, x2, y2 FROM object_grids WHERE object_id = ? AND label = ?",
        (object_id, label),
    ).fetchone()
    if row is None:
        return None
    return [row["x1"], row["y1"], row["x2"], row["y2"]]


def _level_height(conn, object_id: int, section_id: int, floor, z0: float):
    """Высота этажа = отметка СЛЕДУЮЩЕГО по ОТМЕТКЕ этажа минус текущая.
    Для последнего этажа (следующего нет) берётся шаг ПРЕДЫДУЩЕГО и
    возвращается `approx=True` — высота не додумана незаметно, а
    помечена.

    Круг «соседей» — этажи, где у ЭТОЙ секции есть блок (join на
    `blocks`), не все этажи объекта разом (до 2026-09-01 было наоборот —
    этаж считался общей записью объекта, без разбора по секциям). Иначе
    секция с независимым «хвостом» своих верхних ярусов (у секции 1 —
    технический этаж/кровля, заведены на отметках 25650/29400мм, см.
    `_floor_spec`, `app/pdf_import.py`) подхватывала бы в качестве
    «следующего» чужой этаж секции 2, оказавшийся ближайшим по отметке
    лишь случайно (было: кровля секции 1 получала высоту из этажа 10
    секции 2 — считанные сотни мм вместо своих над техническим этажом).
    Соседа ищем по ОТМЕТКЕ, не по номеру этажа — для секции, где номер и
    отметка растут вместе (типовой случай), разницы не видно, но у
    заведённого В КОНЕЦ (номер 26/27, чтобы не столкнуться по `key` с
    этажами 9/10 секции 2) технического этажа/кровли секции 1 расходятся:
    по номеру сосед — за пределами круга секции (следующего попросту
    нет), по отметке — верно найден бы, будь он в круге секции."""
    if floor is None:
        return None, False
    rows = conn.execute(
        "SELECT ol.floor, ol.elevation_mm FROM object_levels ol "
        "JOIN blocks b ON b.level_id = ol.id AND b.section_id = ? "
        "WHERE ol.object_id = ? AND ol.floor IS NOT NULL AND ol.elevation_mm IS NOT NULL "
        "AND ol.elevation_suspect = 0 ORDER BY ol.floor",
        (section_id, object_id),
    ).fetchall()
    отметки = {r["floor"]: r["elevation_mm"] for r in rows}
    этажи = sorted(отметки, key=lambda f: отметки[f])
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
    block = conn.execute(
        "SELECT x0, x1, y0, y1 FROM blocks WHERE section_id = ? AND level_id = ?",
        (section_id, level_id),
    ).fetchone()
    прямая_геометрия = (block is not None and block["x0"] is not None
                        and block["x1"] is not None and block["y0"] is not None
                        and block["y1"] is not None)
    # Прямое хранение (упрощённый импорт из PDF по фасадам, 2026-09-01,
    # см. schema.sql) — в ПРИОРИТЕТЕ и минует привязку к осям целиком: у
    # такого блока оси секции может не быть вовсе (без разбора помещений/
    # стен привязывать не по чему), а форма по высоте всё равно СВОЯ у
    # каждого этажа (тело здания сужается кверху) — то, ради чего заведено
    # хранение, а не общий на секцию прямоугольник по одной паре осей.
    if прямая_геометрия:
        xy = {"x0": block["x0"], "x1": block["x1"], "y0": block["y0"], "y1": block["y1"]}
    else:
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

        xy = section_box_xy(from_line, to_line,
                            _section_element_bounds(conn, object_id, section_id, level_id))
        if xy is None:
            return {"ok": False, "reason": "оси секции разнонаправленные "
                    "(или геометрия этажа не пересекается с пролётом осей)"}

    level = conn.execute(
        "SELECT floor, elevation_mm, elevation_suspect FROM object_levels WHERE id = ?",
        (level_id,),
    ).fetchone()
    if level is None:
        return {"ok": False, "reason": "этаж не найден"}
    if level["elevation_mm"] is None or level["elevation_suspect"]:
        return {"ok": False, "reason": "отметке этажа верить нельзя"}

    z0 = level["elevation_mm"]
    высота, approx = _level_height(conn, object_id, section_id, level["floor"], z0)
    if высота is None:
        return {"ok": False, "reason": "высоту этажа определить не из чего"}

    return {
        "ok": True, "approx_height": approx,
        "x0": xy["x0"], "x1": xy["x1"], "y0": xy["y0"], "y1": xy["y1"],
        "z0": z0, "z1": z0 + высота,
    }
