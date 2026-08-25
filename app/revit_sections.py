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
        return {"назначено": 0, "осталось": 0, "зон": 0}

    зоны = build_zones(известные)
    коды = {row["code"]: row["id"] for row in conn.execute(
        "SELECT id, code FROM object_sections WHERE object_id = ?", (object_id,))}

    правки = []
    осталось = 0
    # Пересматриваем и то, что уже было назначено геометрией: модель
    # могла измениться, и прежнее решение должно пересчитаться, а не
    # остаться навсегда.
    for row in conn.execute(
        "SELECT id, outline_json FROM revit_elements "
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
            правки.append((коды[код], row["id"]))
        else:
            осталось += 1

    if правки:
        conn.executemany(
            "UPDATE revit_elements SET section_id = ?, section_source = 'геометрия', "
            "updated_at = datetime('now') WHERE id = ?", правки)
    return {"назначено": len(правки), "осталось": осталось, "зон": len(зоны)}
