"""
Данные для показа загруженной модели Revit на плане.

Почему это ОТДЕЛЬНЫЙ вид, а не слой поверх обычной схемы: элементы Revit
лежат в общих координатах площадки (у ЖУ30 это около 16 550 000 мм по X),
а элементы DXF — в координатах чертежа. Наложить одно на другое без
привязки нельзя, а рисовать их в одном окне «как будто совместилось» —
значит показывать неправду. Кроме того, у элементов модели нет статусов
поставки и монтажа: это другой контур учёта.

Показ идёт ПО ЭТАЖАМ. Не ради красоты: в объекте 28 тысяч элементов, и
единственный осмысленный разрез плана — этаж. На этаже их около тысячи,
что рисуется мгновенно.
"""

import json


def _level_row(row) -> dict:
    """Строка этажа для интерфейса. `key` — технический ключ сшивки
    разделов, показывать его человеку нельзя: «этаж:-1» и «этаж:1» рядом
    читаются как один и тот же этаж дважды (живой отчёт пользователя),
    минус в мелком шрифте не замечается. Название — словами."""
    данные = dict(row)
    if данные["kind"] == "кровля":
        имя = "Кровля"
    elif данные["floor"] is None:
        имя = данные["name"] or данные["key"]
    elif данные["floor"] < 0:
        имя = "Подземный этаж" if данные["floor"] == -1 else "Подземный %d" % -данные["floor"]
    else:
        имя = "%d этаж" % данные["floor"]
    # У кровель секция входит в название: у С01 и С02 они на разных
    # отметках, и без секции это две одинаковые строки «Кровля».
    if данные["kind"] == "кровля" and данные["key"].startswith("кровля:"):
        секции = данные["key"].split(":", 1)[1]
        if секции and секции != "?":
            имя = "Кровля %s" % секции
    данные["title"] = имя
    return данные


def filters(conn, object_id: int) -> dict:
    """Что вообще есть у объекта: этажи, секции, разделы, категории — с
    количествами. Считается по всему объекту, а не по текущему фильтру:
    иначе, отфильтровав, пользователь перестал бы видеть, куда вернуться."""
    levels = [
        _level_row(row) for row in conn.execute(
            "SELECT l.id, l.key, l.floor, l.kind, l.name, l.elevation_mm, "
            "       l.elevation_suspect, COUNT(e.id) AS elements "
            "FROM object_levels l "
            "LEFT JOIN revit_elements e ON e.level_id = l.id AND e.is_current = 1 "
            "WHERE l.object_id = ? GROUP BY l.id ORDER BY l.sort_order",
            (object_id,))
    ]
    sections = [
        dict(row) for row in conn.execute(
            "SELECT s.id, s.code, COUNT(e.id) AS elements FROM object_sections s "
            "LEFT JOIN revit_elements e ON e.section_id = s.id AND e.is_current = 1 "
            "WHERE s.object_id = ? GROUP BY s.id ORDER BY s.sort_order",
            (object_id,))
    ]
    parts = [
        dict(row) for row in conn.execute(
            "SELECT section_code AS code, COUNT(*) AS elements FROM revit_elements "
            "WHERE object_id = ? AND is_current = 1 GROUP BY section_code "
            "ORDER BY section_code", (object_id,))
    ]
    categories = [
        dict(row) for row in conn.execute(
            "SELECT category, COUNT(*) AS elements FROM revit_elements "
            "WHERE object_id = ? AND is_current = 1 GROUP BY category "
            "ORDER BY COUNT(*) DESC", (object_id,))
    ]
    # Элементы без этажа и без секции показываются отдельной строкой, а не
    # прячутся: на реальной выгрузке это 120 и 4307 штук, и молчаливое
    # исчезновение четырёх тысяч элементов со схемы — худший вид ошибки.
    orphans = conn.execute(
        "SELECT SUM(level_id IS NULL) AS без_этажа, SUM(section_id IS NULL) AS без_секции "
        "FROM revit_elements WHERE object_id = ? AND is_current = 1", (object_id,)
    ).fetchone()
    return {
        "levels": levels,
        "sections": sections,
        "parts": parts,
        "categories": categories,
        "without_level": orphans["без_этажа"] or 0,
        "without_section": orphans["без_секции"] or 0,
    }


# Предохранитель от запроса, который положит браузер. Не «разумное
# ограничение показа»: на реальном объекте (КР 3693 + АР 25 131) прежние
# 20 000 отрезали 5131 элемент, и в 3D это выглядело как восьмиметровый
# разрыв в здании с висящим над ним куском — метры с 52-го по 59-й
# оставались пусты. Отбор идёт по id, поэтому вырезается не «лишнее», а
# произвольный хвост.
ELEMENTS_LIMIT = 60000


def _in_clause(column: str, значения, where: list, params: list,
               пустое_как_null: bool = False) -> None:
    """Условие «поле входит в набор». Пустой набор — НЕ условие вовсе:
    отбор по категории считается снятым, а не «не подходит ничего».

    `пустое_как_null` — для этажа и секции: ноль в наборе означает строку
    «без этажа» / «без секции», и она обязана отбираться наравне с
    остальными, иначе четыре тысячи элементов без секции нельзя было бы
    посмотреть.
    """
    значения = [v for v in (значения or []) if v is not None]
    if not значения:
        return
    куски = []
    конкретные = [v for v in значения if not (пустое_как_null and v == 0)]
    if пустое_как_null and any(v == 0 for v in значения):
        куски.append("%s IS NULL" % column)
    if конкретные:
        куски.append("%s IN (%s)" % (column, ",".join("?" * len(конкретные))))
        params.extend(конкретные)
    where.append("(" + " OR ".join(куски) + ")")


def elements(conn, object_id: int, level_ids=None, section_ids=None,
             parts=None, categories=None, limit: int = ELEMENTS_LIMIT) -> dict:
    """Контуры для отрисовки. В наборе этажей и секций 0 означает «без
    этажа» / «без секции»."""
    where = ["object_id = ?", "is_current = 1", "outline_json IS NOT NULL"]
    params = [object_id]
    _in_clause("level_id", level_ids, where, params, пустое_как_null=True)
    _in_clause("section_id", section_ids, where, params, пустое_как_null=True)
    _in_clause("section_code", parts, where, params)
    _in_clause("category", categories, where, params)

    # Только то, что нужно ОТРИСОВКЕ. Карточка элемента (марка, семейство,
    # объём, отметка) берётся отдельным запросом по клику: на этаже в
    # полторы тысячи элементов метаданные весят больше самой геометрии —
    # один `uid` это 45 символов, а рисовать по нему нечего.
    rows = conn.execute(
        "SELECT id, category, outline_json, outline_approx, "
        "       elevation_mm, height_mm "
        "FROM revit_elements WHERE " + " AND ".join(where) +
        " ORDER BY id LIMIT ?", (*params, limit + 1)
    ).fetchall()

    truncated = len(rows) > limit
    rows = rows[:limit]

    # Контуры разбираются ДВАЖДЫ: сначала чтобы узнать угол плана, потом
    # чтобы сложить координаты относительно него. Это дешевле, чем гонять
    # по сети абсолютные координаты площадки: X вида 16549600.0 — это
    # десять знаков на число, а относительный 0..57000 — пять. На этаже в
    # полторы тысячи элементов разница почти вдвое по объёму ответа.
    parsed = []
    xs, ys = [], []
    for row in rows:
        try:
            outline = json.loads(row["outline_json"])
        except (TypeError, ValueError):
            continue
        for point in outline:
            xs.append(point[0])
            ys.append(point[1])
        parsed.append((row, outline))

    origin_x = min(xs) if xs else 0
    origin_y = min(ys) if ys else 0

    # Категория — ИНДЕКСОМ в списке, а не строкой: «Обобщенные модели» это
    # 18 символов на каждом из тысяч элементов, а цвет по ней один.
    names = []
    index = {}
    out = []
    for row, outline in parsed:
        name = row["category"] or ""
        if name not in index:
            index[name] = len(names)
            names.append(name)
        out.append({
            "id": row["id"],
            "кат": index[name],
            "приб": 1 if row["outline_approx"] else 0,
            # Для 3D: низ и высота. Отдаются всегда, а не по отдельному
            # запросу — это два числа, а второй запрос ради них удвоил бы
            # обращения при каждом переключении этажа.
            "отм": row["elevation_mm"],
            "выс": row["height_mm"],
            "контур": [[int(round(p[0] - origin_x)), int(round(p[1] - origin_y))]
                       for p in outline],
        })

    return {
        "elements": out,
        "categories": names,
        # Угол плана в ОБЩИХ координатах: контуры отданы относительно него.
        "origin": [origin_x, origin_y] if xs else None,
        "size": [int(round(max(xs) - origin_x)), int(round(max(ys) - origin_y))] if xs else None,
        "truncated": truncated,
    }


def card(conn, object_id: int, element_id: int):
    """Карточка одного элемента — по клику на плане."""
    row = conn.execute(
        "SELECT e.*, s.code AS section_code_name, l.name AS level_full "
        "FROM revit_elements e "
        "LEFT JOIN object_sections s ON s.id = e.section_id "
        "LEFT JOIN object_levels l ON l.id = e.level_id "
        "WHERE e.object_id = ? AND e.id = ?", (object_id, element_id)
    ).fetchone()
    if row is None:
        return None
    data = dict(row)
    extra = {}
    if data.get("params_json"):
        try:
            extra = json.loads(data["params_json"])
        except (TypeError, ValueError):
            extra = {}
    return {
        "id": data["id"], "uid": data["uid"],
        "категория": data["category"], "семейство": data["family"],
        "типоразмер": data["type_name"], "марка": data["mark"],
        "раздел": data["section_code"], "секция": data["section_code_name"],
        "источник секции": data["section_source"],
        "уровень": data["level_name"], "этаж": data["level_full"],
        "отметка низа": data["elevation_mm"], "высота": data["height_mm"],
        "объём": data["volume"], "площадь": data["area"],
        "рабочий набор": data["workset"],
        "контур габаритный": bool(data["outline_approx"]),
        "параметры": extra,
    }
