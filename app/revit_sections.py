"""
Доопределение секции по геометрии: секция как ЗОНА в плане.

Зачем. У заказчика `MCY_Секция` заполнена не везде: на реальной выгрузке
АР пусто у 4374 элементов из 25 131 (стены, двери, колонны, окна — целая
неадресованная группа). Перевыгрузка тут не поможет, в модели этого
значения просто нет.

Как. Секция — одна на весь дом по высоте (решение пользователя), поэтому
зона строится ПЛОСКОЙ и общей на все этажи: сетка квадратных ячеек, в
каждой побеждает секция, чьих контуров в неё попало больше. Растр, а не
выпуклая оболочка: секции бывают Г-образными и вложенными углом друг в
друга, оболочка их перекрыла бы, и половина дома досталась бы соседке.

Границу зон не сглаживаем и спорные ячейки не додумываем: элемент на
стыке двух секций остаётся неопределённым и виден в сводке. Приписать его
наугад — значит молча испортить учёт работ по блоку.
"""

import json

# Сторона ячейки, мм. Метр: мельче — растр рвётся на редких категориях
# (дверей на этаж десятки, а не тысячи), крупнее — граница между секциями
# гуляет на полкомнаты.
CELL_MM = 1000

# Насколько далеко искать зону, если ячейка элемента пуста, в ячейках.
SEARCH_RADIUS = 6

# Ячейка считается спорной, если второй претендент набрал не меньше этой
# доли от победителя: на стыке секций так и будет, и это честный ответ.
AMBIGUOUS_RATIO = 0.4


def _cells_of(outline):
    """Ячейки, которые накрывает контур. По габаритам контура, а не по
    точной заливке: элементы мелкие, разница в доли ячейки, а перебор
    полигона стоил бы на порядок дороже."""
    xs = [p[0] for p in outline]
    ys = [p[1] for p in outline]
    x0, x1 = int(min(xs) // CELL_MM), int(max(xs) // CELL_MM)
    y0, y1 = int(min(ys) // CELL_MM), int(max(ys) // CELL_MM)
    for cx in range(x0, x1 + 1):
        for cy in range(y0, y1 + 1):
            yield (cx, cy)


def build_zones(known) -> dict:
    """known — последовательность (код секции, контур). Возвращает
    ячейку -> код секции; спорные ячейки в результат не попадают."""
    голоса = {}
    for code, outline in known:
        if not code or not outline:
            continue
        for cell in _cells_of(outline):
            счёт = голоса.setdefault(cell, {})
            счёт[code] = счёт.get(code, 0) + 1

    зоны = {}
    for cell, счёт in голоса.items():
        порядок = sorted(счёт.items(), key=lambda t: -t[1])
        if len(порядок) > 1 and порядок[1][1] >= порядок[0][1] * AMBIGUOUS_RATIO:
            continue                      # стык секций — не решаем
        зоны[cell] = порядок[0][0]
    return зоны


def section_at(зоны: dict, outline) -> str:
    """Секция для контура: сначала своя ячейка, потом кольцами вокруг.

    Кольцами, а не «ближайшая точка»: перебирать тысячи известных
    элементов на каждый неопределённый — это часы на реальном объекте, а
    поиск по сетке укладывается в миллисекунды.
    """
    if not outline:
        return None
    xs = [p[0] for p in outline]
    ys = [p[1] for p in outline]
    cx = int((sum(xs) / len(xs)) // CELL_MM)
    cy = int((sum(ys) / len(ys)) // CELL_MM)

    прямое = зоны.get((cx, cy))
    if прямое:
        return прямое

    for r in range(1, SEARCH_RADIUS + 1):
        найденные = set()
        for dx in range(-r, r + 1):
            for dy in (-r, r):
                код = зоны.get((cx + dx, cy + dy))
                if код:
                    найденные.add(код)
        for dy in range(-r + 1, r):
            for dx in (-r, r):
                код = зоны.get((cx + dx, cy + dy))
                if код:
                    найденные.add(код)
        # На кольце нашлись ОБЕ секции — элемент ровно между ними, и
        # выбирать не из чего.
        if len(найденные) == 1:
            return next(iter(найденные))
        if len(найденные) > 1:
            return None
    return None


def fill_missing(conn, object_id: int) -> dict:
    """Проставить секцию элементам, у которых её нет.

    Зона строится по элементам ВСЕХ разделов сразу: секция — свойство
    здания, а не выгрузки, и конструктив помогает адресовать архитектуру.

    Параметр НЕ перебивается: если проектировщик секцию проставил, берётся
    его значение, даже когда геометрия говорит иначе. Это его модель.
    """
    # Зона строится ТОЛЬКО по элементам, чья секция пришла из модели
    # (параметр) или из имени уровня. Уже доопределённые геометрией в
    # голосовании не участвуют: иначе они становятся источником для
    # следующего прогона, зона расползается от запуска к запуску, и
    # операция перестаёт быть повторяемой.
    известные = []
    for row in conn.execute(
        "SELECT s.code AS code, e.outline_json AS outline FROM revit_elements e "
        "JOIN object_sections s ON s.id = e.section_id "
        "WHERE e.object_id = ? AND e.is_current = 1 AND e.outline_json IS NOT NULL "
        "AND e.section_source IN ('параметр', 'уровень')",
        (object_id,),
    ):
        try:
            известные.append((row["code"], json.loads(row["outline"])))
        except (TypeError, ValueError):
            continue

    if not известные:
        return {"назначено": 0, "осталось": 0, "зон": 0, "конфликтов": 0}

    зоны = build_zones(известные)
    коды = {row["code"]: row["id"] for row in conn.execute(
        "SELECT id, code FROM object_sections WHERE object_id = ?", (object_id,))}

    # Расхождение параметра с зоной. Не исправляем — параметр остаётся
    # главным, — но СЧИТАЕМ: на реальном объекте 448 элементов несут
    # секцию С02, а стоят в зоне С01, и при отборе по секции они
    # показываются в чужой половине дома. Молча это выглядит как ошибка
    # программы, хотя это данные модели, и адресат у неё — проектировщик.
    конфликтов = 0
    for row in conn.execute(
        "SELECT s.code AS code, e.outline_json AS outline FROM revit_elements e "
        "JOIN object_sections s ON s.id = e.section_id "
        "WHERE e.object_id = ? AND e.is_current = 1 AND e.outline_json IS NOT NULL "
        "AND e.section_source = 'параметр'", (object_id,),
    ):
        try:
            контур = json.loads(row["outline"])
        except (TypeError, ValueError):
            continue
        по_зоне = section_at(зоны, контур)
        if по_зоне and по_зоне != row["code"]:
            конфликтов += 1

    правки = []
    осталось = 0
    # Пересматриваем и то, что уже было назначено геометрией: модель
    # могла измениться, и прежнее решение должно пересчитаться, а не
    # остаться навсегда.
    for row in conn.execute(
        "SELECT id, section_id, outline_json FROM revit_elements "
        "WHERE object_id = ? AND is_current = 1 AND outline_json IS NOT NULL "
        "AND (section_id IS NULL OR section_source = 'геометрия')", (object_id,),
    ):
        try:
            outline = json.loads(row["outline_json"])
        except (TypeError, ValueError):
            осталось += 1
            continue
        код = section_at(зоны, outline)
        if код and код in коды:
            # Уже верно назначенное — не трогать: без этой проверки
            # «назначено» на КАЖДЫЙ прогон пересчитывало заново всё, что
            # уже правильно стоит геометрией (лишняя запись в БД и
            # `updated_at`), и отчёт кнопки «Обновить принадлежность»
            # никогда не сходился к нулю, даже когда менять уже нечего
            # (живая проверка 2026-09-09).
            if коды[код] != row["section_id"]:
                правки.append((коды[код], row["id"]))
        else:
            осталось += 1

    if правки:
        conn.executemany(
            "UPDATE revit_elements SET section_id = ?, section_source = 'геометрия', "
            "updated_at = datetime('now') WHERE id = ?", правки)
    return {"назначено": len(правки), "осталось": осталось, "зон": len(зоны),
            "конфликтов": конфликтов}


def _footprint(outline_json, x, y):
    """Габарит элемента в плане — по контуру, а точкой вставки как
    запасной вариант (у части категорий контура нет вовсе)."""
    if outline_json:
        try:
            outline = json.loads(outline_json)
            xs = [p[0] for p in outline]
            ys = [p[1] for p in outline]
            if xs and ys:
                return (min(xs), min(ys), max(xs), max(ys))
        except (TypeError, ValueError, IndexError):
            pass
    if x is not None and y is not None:
        return (x, y, x, y)
    return None


def _overlap_area(footprint, box):
    """Площадь пересечения габарита элемента с прямоугольником секции.
    Точка (нулевая площадь габарита) внутри прямоугольника засчитывается
    целиком — иначе категории без контура (двери, окна) никогда бы не
    попали ни в одну секцию."""
    fx0, fy0, fx1, fy1 = footprint
    bx0, by0, bx1, by1 = box
    ix0, iy0 = max(fx0, bx0), max(fy0, by0)
    ix1, iy1 = min(fx1, bx1), min(fy1, by1)
    if ix1 < ix0 or iy1 < iy0:
        return 0.0
    площадь = (ix1 - ix0) * (iy1 - iy0)
    return площадь if площадь > 0 else 1.0


def fill_by_volume(conn, object_id: int, override_param: bool = False) -> dict:
    """Доопределение секции по ОБЪЁМУ блока (`app.block_geometry.block_box`
    — прямая геометрия `block_boxes` или, второй по приоритету, оси
    здания), а не по растровому голосованию соседей (`fill_missing`).

    Нужна для секции, у которой ДО СИХ ПОР не было ни одного элемента с
    надёжной секцией: `fill_missing` строит зоны голосованием уже
    привязанных элементов и для только что заведённой вручную секции —
    нулевых голосов — не присвоит её код никогда, сколько раз ни запускай.
    Здесь источник геометрии секции другой — её собственный объём, а не
    чужие элементы, поэтому бутстрап работает и с нуля.

    Побеждает секция, куда попала БОЛЬШАЯ часть габарита элемента (площадь
    пересечения), не просто точка внутри контура — прямое требование
    пользователя (2026-09-09): элемент на стыке двух секций достаётся той,
    что накрыла его большей долей.

    `override_param=False` (по умолчанию, автоматические проходы —
    загрузка пакета Revit, сохранение осей/прямоугольников блока):
    параметр не перебивается, тот же инвариант, что у `fill_missing`, —
    «это данные модели, а не брак программы».

    `override_param=True` (только кнопка «Обновить принадлежность» —
    ручное, осознанное действие пользователя с проверкой результата
    глазами): перебивает и `section_source='параметр'` тоже, если
    геометрия явно не согласна. Прямое решение пользователя 2026-09-09 —
    живой пример показал, что инвариант ломается для секции, которой на
    момент исходного разбора PDF ещё не было («Рампа»): стена физически
    внутри её блока, а параметр остался указывать на С01, потому что при
    разборе секция «Рампа» не существовала как область чертежа и делить
    контур было не с чем. Ручная геометрия блока — то, что человек только
    что сам нарисовал, — точнее эвристики парсера PDF на таких стыках."""
    from app.block_geometry import section_level_boxes_xy

    sections = [dict(r) for r in conn.execute(
        "SELECT id, code FROM object_sections WHERE object_id = ?", (object_id,))]
    if not sections:
        return {"назначено": 0, "осталось": 0, "без_геометрии": []}
    levels = [dict(r) for r in conn.execute(
        "SELECT id FROM object_levels WHERE object_id = ?", (object_id,))]

    # этаж -> [(section_id, [(x0,y0,x1,y1), ...]), ...] — только там, где у
    # секции вообще есть объём на этом этаже. Только x,y (`block_box` даёт
    # ещё и высоту, но она тут не нужна и вредна — у только что заведённой
    # секции нет ни одного блока, чтобы взять высоту у соседа по этажу, и
    # `block_box` отказал бы всему этажу, хотя прямоугольник в плане уже
    # известен по осям).
    зоны_по_этажам = {}
    с_геометрией = set()
    for level in levels:
        candidates = []
        for section in sections:
            box = section_level_boxes_xy(conn, object_id, section["id"], level["id"])
            if box.get("ok"):
                candidates.append((section["id"],
                                   [(b["x0"], b["y0"], b["x1"], b["y1"]) for b in box["boxes"]]))
                с_геометрией.add(section["id"])
        if candidates:
            зоны_по_этажам[level["id"]] = candidates

    # Секции вовсе БЕЗ геометрии (ни осей, ни прямоугольника блока хотя бы
    # на одном этаже) — не браку алгоритма, а причина, почему кнопка не
    # может отдать им ни одного элемента: голосовать её объёмом не с чего
    # (2026-09-09, живой отчёт пользователя: секция «Рампа» заведена, но
    # элементы всё равно оставались в соседней — у неё не было задано ни
    # прямоугольника, ни осей). Показывается в отчёте как явная причина, а
    # не молчаливый нуль.
    без_геометрии = [s["code"] for s in sections if s["id"] not in с_геометрией]

    if not зоны_по_этажам:
        return {"назначено": 0, "осталось": 0, "без_геометрии": без_геометрии}

    условие_кандидата = ("is_current = 1" if override_param
                         else "is_current = 1 AND (section_id IS NULL OR section_source = 'геометрия')")
    правки = []
    осталось = 0
    перебито_у_параметра = 0
    for row in conn.execute(
        "SELECT id, section_id, section_source, level_id, outline_json, x, y FROM revit_elements "
        "WHERE object_id = ? AND " + условие_кандидата, (object_id,),
    ):
        candidates = зоны_по_этажам.get(row["level_id"])
        footprint = _footprint(row["outline_json"], row["x"], row["y"]) if candidates else None
        if not candidates or footprint is None:
            if row["section_id"] is None:
                осталось += 1
            continue
        победитель, лучшая_площадь = None, 0.0
        for section_id, boxes in candidates:
            доля = sum(_overlap_area(footprint, box) for box in boxes)
            if доля > лучшая_площадь:
                победитель, лучшая_площадь = section_id, доля
        if победитель is None:
            if row["section_id"] is None:
                осталось += 1
        elif победитель != row["section_id"]:
            # Уже верно назначенное (совпало с параметром/уровнем) трогать
            # незачем — переписывать source на 'геометрия', когда геометрия
            # и так согласна с моделью, только обесценило бы более
            # надёжную пометку без всякой причины.
            if row["section_source"] == "параметр":
                перебито_у_параметра += 1
            правки.append((победитель, row["id"]))

    if правки:
        conn.executemany(
            "UPDATE revit_elements SET section_id = ?, section_source = 'геометрия', "
            "updated_at = datetime('now') WHERE id = ?", правки)
    return {"назначено": len(правки), "осталось": осталось, "без_геометрии": без_геометрии,
            "перебито_у_параметра": перебито_у_параметра}


def fill_missing_levels(conn, object_id: int) -> dict:
    """Доопределить ЭТАЖ по отметке низа элемента (`elevation_mm`) — это
    сырой атрибут модели (`element.get("отметка_низа")`, `build_row`),
    записывается независимо от того, сопоставилось ли ИМЯ уровня элемента
    ни с одной строкой `object_levels` (тогда `level_id` остаётся NULL —
    у заказчика имя уровня отличалось на пробел/регистр, `app.
    revit_package.resolve_section`/`level_index` сводят имя, а не отметку).

    Окно этажа — его СОБСТВЕННЫЕ отметка и высота (`object_levels.
    elevation_mm`/`height_mm`, задаются в «Учёте по блокам» вручную или
    приходят из Revit) — секция и геометрия блока тут ни при чём, а брать
    высоту этажа по соседям (`block_geometry._level_height`) незачем: этаж
    заводится один раз, вручную, отметка либо задана, либо нет. Без высоты
    этажа принимается только ТОЧНОЕ совпадение отметки (в пределах
    полуметра — отметки в Revit и на чертеже иногда расходятся на
    сантиметры при разной точке отсчёта) — не берёмся угадывать границу
    этажа, которой не видно. Элемент, чья отметка не попала ни в одно
    окно и не совпала ни с одной точкой, остаётся без этажа — тем же
    инвариантом «не додумывать», что у `fill_missing`/`fill_by_volume`."""
    floors = [dict(r) for r in conn.execute(
        "SELECT id, elevation_mm, height_mm FROM object_levels "
        "WHERE object_id = ? AND elevation_mm IS NOT NULL AND elevation_suspect = 0",
        (object_id,))]
    if not floors:
        return {"назначено": 0, "осталось": 0}

    правки = []
    осталось = 0
    for row in conn.execute(
        "SELECT id, elevation_mm FROM revit_elements WHERE object_id = ? AND is_current = 1 "
        "AND level_id IS NULL AND elevation_mm IS NOT NULL", (object_id,),
    ):
        z = row["elevation_mm"]
        победитель = None
        for f in floors:
            z0 = f["elevation_mm"]
            if f["height_mm"]:
                if z0 <= z < z0 + f["height_mm"]:
                    победитель = f["id"]
                    break
            elif abs(z - z0) <= 500:
                победитель = f["id"]
                break
        if победитель is not None:
            правки.append((победитель, row["id"]))
        else:
            осталось += 1

    if правки:
        conn.executemany(
            "UPDATE revit_elements SET level_id = ?, updated_at = datetime('now') WHERE id = ?",
            правки)
    return {"назначено": len(правки), "осталось": осталось}


def recalc_membership(conn, object_id: int) -> dict:
    """Пересчитать принадлежность элементов блокам (секция + этаж) целиком
    — три прохода подряд, кнопка «Обновить принадлежность» в «Учёте по
    блокам». Этаж по отметке — ПЕРВЫМ: он ни от чего не зависит, а
    доопределение секции (и растром, и объёмом) само использует
    `level_id` элемента, чтобы понять, В КАКОМ этаже искать зону/блок —
    чем больше элементов уже получили этаж, тем точнее секция.

    Объёмный проход идёт с `override_param=True` — ТОЛЬКО здесь, это
    ручное действие пользователя с проверкой результата глазами (прямое
    решение 2026-09-09, живой пример — «Рампа», см. `fill_by_volume`).
    Растровый проход параметр по-прежнему не трогает: голосование соседей
    эвристичнее нарисованной руками геометрии блока, перебивать им модель
    не тот уровень доверия.

    Отчёт — по факту «было/стало», а не суммой счётчиков «назначено» у
    трёх проходов: растр и объём на спорных элементах иногда решают
    ПО-РАЗНОМУ (застройка на стыке блоков) — растр назначает своё, объём
    внутри того же вызова тут же переигрывает на своё, следующий прогон
    растр переигрывает обратно; итоговые данные при этом стабильны (то же
    значение снова и снова), но сумма «назначено» — нет, и кнопка на
    ровном месте показывала бы «пересчитано 286» на объекте, где на
    самом деле уже нечего менять (живая проверка 2026-09-09)."""
    было = {r["id"]: (r["section_id"], r["level_id"]) for r in conn.execute(
        "SELECT id, section_id, level_id FROM revit_elements "
        "WHERE object_id = ? AND is_current = 1", (object_id,))}

    fill_missing_levels(conn, object_id)
    by_raster = fill_missing(conn, object_id)
    by_volume = fill_by_volume(conn, object_id, override_param=True)
    conn.commit()

    стало = {r["id"]: (r["section_id"], r["level_id"]) for r in conn.execute(
        "SELECT id, section_id, level_id FROM revit_elements "
        "WHERE object_id = ? AND is_current = 1", (object_id,))}
    этажей_изменено = sum(1 for i, (s0, l0) in было.items() if стало[i][1] != l0)
    секций_изменено = sum(1 for i, (s0, l0) in было.items() if стало[i][0] != s0)
    без_этажа = sum(1 for _, l in стало.values() if l is None)
    без_секции = sum(1 for s, _ in стало.values() if s is None)

    return {
        "этажей_назначено": этажей_изменено,
        "этажей_осталось": без_этажа,
        "секций_назначено": секций_изменено,
        "секций_осталось": без_секции,
        "конфликтов": by_raster["конфликтов"],
        "без_геометрии": by_volume.get("без_геометрии") or [],
        "перебито_у_параметра": by_volume.get("перебито_у_параметра") or 0,
    }
