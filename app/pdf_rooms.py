"""
Разбор PDF-комплекта чертежей объекта 80-0924-ОКЭФ-1/Н-3 — второй, помимо
Revit, источник геометрии для рабочего места «Модель МФР» (Docs/TZ.md §3а).

Модуль намеренно ЖЁСТКО завязан на ОДИН конкретный комплект листов: имена
слоёв — соглашение конкретного архитектора (экспорт GSPublisher/ArchiCAD),
у другого проектировщика они будут другими, а разбивка «страница → этаж →
отметки» физически привязана к вёрстке именно ЭТИХ 22 листов. Это осознанное
решение (обсуждено с пользователем 2026-08-26), а не забытая доработка:
кнопка «Загрузить из PDF» на другом объекте работать не будет, пока для его
комплекта не заведут такую же таблицу.

Отметки этажей — не подобраны, а сняты с разреза (лист 18, `Docs/revit-
import.md` §13, где описана и методика: подпись «N этаж» сопоставлена с
ближайшей отметкой вида `±X,XXX`). Секция 1 (этажи 1-8) и секция 2 (этажи
1-24 + технический + кровля) делят общие нижние этажи.

Что модуль ДАЁТ: контур и площадь каждого помещения (слой
`оо_ПЛОЩАДИ_помещений.оо` — единственный на этом листе, где помещение
нарисовано целым полигоном, а не штриховкой).

Что НЕ даёт и почему — проверено, не предположено:

* **Стены как отдельные сущности с толщиной.** Слои `]]]_СТ_вн_*`/
  `]]]_СТЕНЫ_*` — штриховка материала, тысячи мелких обрывков линий на
  этаж, не полигоны.
* **Дверные/оконные проёмы.** Слой `Б_блок ПРОЕМ.Б` устроен так же —
  дуговые обрывки, не фигуры.
* **Номер помещения/квартиры.** Слой `№_МАРКА_помещений.№` и подписи вида
  `№1.1` есть на листе, но НЕ рядом с нарисованной комнатой — при проверке
  (2026-08-26) ближайшая такая подпись оказалась в 5–27 МЕТРАХ от контура
  ближайшего помещения на типовых этажах. Это отдельная таблица-каталог
  типов квартир сбоку листа, не подписи на самом плане (совпадение на
  этаже 1 было случайным — там же смешанное назначение первого этажа даёт
  другую вёрстку листа). Сопоставить квартирографию с конкретной
  нарисованной комнатой можно только по ФОРМЕ (сравнение контура с
  эталонной планировкой каталога) — не реализовано, отдельная и
  существенно более тяжёлая задача.

Секция помещения на этажах, общих для нескольких секций объекта, ОПРЕДЕЛЯЕТСЯ
— по подписям осей (замечено пользователем 2026-08-26, до этого считалась
неопределимой). Каждая ось на любом листе подписана в форме `<метка>с<N>`
(«Ас1», «1с2», …) — номер секции зашит В САМОЙ ПОДПИСИ. Проверено на всех
проверенных листах: подписи `…с1` и `…с2` всегда лежат в НЕПЕРЕСЕКАЮЩИХСЯ
диапазонах X листа с чистым зазором (на разных листах от 20 до 30 pt) — по
этой границе, а не по голосованию зон, и определяется секция комнаты.

Те же подписи осей (`extract_axis_grid`/`page_axis_labels`) дают и позицию
оси для геометрии блока (`app/block_geometry.py`, `object_grids`) — только
позицию, не саму линию: линии осей на чертеже не извлекаются (слой
`$_ОСИ.·`* — тысячи фрагментов пунктира, как и штриховка стен, см. ниже),
поэтому пролёт оси берётся из фактического охвата помещений своей секции,
а не из чертежа. Для параллелепипеда блока (не точного контура) этого
достаточно; `app/pdf_import._apply_axis_grid` берёт из подписей только ДВЕ
крайние вертикальные (пронумерованные) оси секции — `axis_from`/`axis_to`.

Раз номера нет, идентичность помещения при повторной загрузке — порядковый
индекс после сортировки по центроиду контура (см. `Room.index`), а не
устойчивый естественный ключ. Это слабее, чем `Element.UniqueId` у Revit
(`app/revit_elements.py`, docstring), но безопасно: у комнаты в
`revit_elements` нет своих данных, которые можно потерять (не то что у
статуса ЖБИ-изделия) — максимум, что бывает при чуть изменившейся
геометрии между перевыгрузками, это списание старой строки и добавление
новой вместо обновления на месте.
"""

import re
from dataclasses import dataclass
from typing import Optional

import fitz
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

ROOM_LAYER = "оо_ПЛОЩАДИ_помещений.оо"

PT_TO_MM = 25.4 / 72.0

# Площадь: «14,3» — запятая, без единицы (единица «м2» отдельным словом рядом).
_AREA_RE = re.compile(r'^\d{1,4}[.,]\d$')
_SCALE_RE = re.compile(r'М\s*1\s*:\s*(\d+)')
# Подпись оси: «Ас1», «1с2», «15с1» — буква/номер оси + номер секции.
# Группа 1 — метка оси («А», «15»), группа 2 — номер секции.
_AXIS_RE = re.compile(r'^([A-ZА-Я0-9]{1,2})с(\d)$', re.IGNORECASE)

# Слой чертежа (штриховка материала стены/перегородки) -> (категория,
# материал). Слой определяет материал НАПРЯМУЮ, по имени — не нужен разбор
# цвета: имена слоёв — то же соглашение архитектора, что и у остальных
# слоёв этого комплекта (`ROOM_LAYER` и т.п.), и ИМЕННО эти слои несут и
# сами стены на плане, и образцы легенды материалов на каждом листе (см.
# `_LEGEND_MARGIN_MM`). Категории — «Стены»/«Перекрытия» существующие в
# `app/revit_colors.py` (готовый цвет в любой палитре), «Перегородки» —
# новая, добавлена туда же.
_WALL_LAYERS = {
    "]]]_СТ_вн_Бетон": ("Стены", "Монолитный железобетон"),
    "]]]_СТ_вн_Кирпич": ("Стены", "Кирпич"),
    "]]]_СТ_вн_Газосиликат": ("Стены", "Ячеистый бетон (газосиликат)"),
    "]]]_СТ_вн_Газобетон": ("Стены", "Ячеистый бетон (газобетон)"),
    "]]]_ст100_вн_Пазогребневые": ("Перегородки", "Пазогребневые плиты, 100мм"),
    "]]]_ст80_вн_Пазогребневые": ("Перегородки", "Пазогребневые плиты, 80мм"),
    "]]]_СТ_вн_Пазогребневые": ("Перегородки", "Пазогребневые плиты"),
    "]_100_влаг_Пазогребневые": ("Перегородки", "Пазогребневые плиты гидрофобизированные, 100мм"),
    "]]]_СТ_влагост_Пазогребневые": ("Перегородки", "Пазогребневые плиты гидрофобизированные"),
    "]]]_СТ_вн_Гипсокартон": ("Перегородки", "Гипсокартон"),
    "]_Гипс80": ("Перегородки", "Гипсокартон, 80мм"),
}

# Отступ вокруг охвата помещений листа, в пределах которого фигура слоя
# материала считается настоящей стеной, а не образцом легенды (та же
# легенда, что и у пользователя на скриншоте, напечатана на КАЖДОМ листе
# плана теми же слоями — проверено: минимальный зазор между легендой и
# зданием на проверенных листах 7000мм, отступ здесь заведомо меньше).
_LEGEND_MARGIN_MM = 3000

# Толщина плиты перекрытия «в основании этажа» — не с чертежа (отдельного
# слоя плиты на планах нет, только в разрезе на нечитаемых для этого
# конвейера листах 18/20), а то же круглое число, что у монолита в
# легенде — приближение, а не измерение, честно с ним и названо.
_SLAB_THICKNESS_MM = 200


class PdfRoomsError(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


@dataclass
class RoomPlan:
    """Один физический этаж: контуры помещений одной страницы плюс отметки."""

    floor: str          # "1".."24", "подземный", "технический (секция 2)"
    page: int           # 1-based номер листа в PDF
    z0: float
    z1: float
    section_codes: tuple = ()   # к каким секциям относится этаж


# (этаж(и), страница, z0, z1) — буквально таблица из Docs/revit-import.md §13.
_FLOOR_HEIGHT = 3000

_SPEC = [
    ("подземный", 3, -6450, 0, ("С01", "С02")),
    ("1", 5, 0, 4650, ("С01", "С02")),
    ("2", 6, 4650, 7650, ("С01", "С02")),
    ("3", 7, 7650, 10650, ("С01", "С02")),
    ("4", 8, 10650, 13650, ("С01", "С02")),
    ("5", 8, 13650, 16650, ("С01", "С02")),
    ("6", 8, 16650, 19650, ("С01", "С02")),
    ("7", 9, 19650, 22650, ("С01", "С02")),
    ("8", 9, 22650, 25650, ("С01", "С02")),
    ("9", 10, 25650, 28650, ("С02",)),
    ("10", 11, 28650, 31650, ("С02",)),
]
for _n in range(11, 21):
    _z0 = 31650 + (_n - 11) * _FLOOR_HEIGHT
    _SPEC.append((str(_n), 12, _z0, _z0 + _FLOOR_HEIGHT, ("С02",)))
for _n in range(21, 24):
    _z0 = 61650 + (_n - 21) * _FLOOR_HEIGHT
    _SPEC.append((str(_n), 13, _z0, _z0 + _FLOOR_HEIGHT, ("С02",)))
_SPEC.append(("24", 14, 70650, 73650, ("С02",)))
_SPEC.append(("технический (секция 2)", 15, 73650, 76800, ("С02",)))

FLOOR_PLANS = [RoomPlan(floor=f, page=p, z0=z0, z1=z1, section_codes=s)
              for f, p, z0, z1, s in _SPEC]


@dataclass
class WallSegment:
    """Один ПРЯМОЙ участок стены/перегородки — не вся стена целиком: на
    чертеже она приходит уже разрезанной на прямые куски (по одному
    залитому прямоугольнику слоя материала на кусок), см. докстрока
    `_wall_segments_raw`. Идентичность — как у `Room`: порядковый индекс
    после сортировки по центроиду, не устойчивый ключ."""

    floor: str
    index: int
    category: str              # "Стены" | "Перегородки" — см. _WALL_LAYERS
    material: str
    polygon_mm: list
    thickness_mm: float
    section: Optional[str] = None
    page: int = 0


@dataclass
class Slab:
    """Плита перекрытия этажа — приближение контуром здания (объединение
    контуров помещений и стен этого этажа), не измерение: отдельного слоя
    плиты на планах нет (см. `_SLAB_THICKNESS_MM`). Одна на этаж, без
    деления на секции."""

    floor: str
    polygon_mm: list
    page: int = 0


@dataclass
class Room:
    floor: str
    index: int                 # порядковый номер на этаже — см. docstring модуля
    polygon_mm: list           # [(x, y), ...] в мм, локальные координаты листа
    area_m2: Optional[float] = None
    section: Optional[str] = None   # "С01" | "С02" | None — см. _axis_boundary_x
    page: int = 0               # номер листа PDF — для params_json элемента


def _axis_boundary_x(words) -> Optional[float]:
    """Граница между подписями осей секции 1 («…с1») и секции 2 («…с2»)
    в СЫРЫХ координатах листа (pt, до перевода в мм и сдвига). `None`, если
    на листе нет подписей обеих секций сразу (граница не определена — не
    гадаем, откуда её брать)."""
    s1_x = [w[0] for w in words if (m := _AXIS_RE.match(w[4])) and m.group(2) == "1"]
    s2_x = [w[0] for w in words if (m := _AXIS_RE.match(w[4])) and m.group(2) == "2"]
    if not s1_x or not s2_x:
        return None
    s1_max, s2_min = max(s1_x), min(s2_x)
    if s1_max >= s2_min:
        return None  # диапазоны пересеклись — на этом листе границе верить нельзя
    return (s1_max + s2_min) / 2


def _page_scale(page) -> int:
    m = _SCALE_RE.search(page.get_text())
    if not m:
        raise PdfRoomsError(
            "На листе не найден масштаб (подпись «М1:NNN») — без него "
            "координаты страницы нельзя перевести в миллиметры.")
    return int(m.group(1))


def _room_polygons(page, scale: int) -> tuple:
    """Полигоны слоя площадей — каждый СВОЕЙ фигурой, без объединения.
    Возвращает (полигоны, (сдвиг_x, сдвиг_y)).

    Сдвиг — выравнивание листа по верхнему правому углу застройки (сам угол
    становится (0,0)): у КАЖДОГО листа комплекта своя точка отсчёта на
    странице, а верхний правый угол здания при печати остаётся практически
    на месте от листа к листу (проверено на прототипе-«массе» этой же
    сессии: правый край 90469±20 мм, верхний край 73791..73841 мм у девяти
    разных листов). Без этого шага этажи с разных листов стояли бы в
    несовместимых координатах и не собрались бы в одно здание."""
    H = page.rect.height
    raw = []
    for d in page.get_cdrawings():
        if d.get("layer") != ROOM_LAYER or d["type"] != "f":
            continue
        pts = [it[1] for it in d["items"] if it[0] == "l"]
        if d["items"]:
            pts.append(d["items"][-1][2])
        if len(pts) < 3:
            continue
        bbox_area_pt = (d["rect"][2] - d["rect"][0]) * (d["rect"][3] - d["rect"][1])
        if bbox_area_pt < 20:
            continue  # шум — крошечные обрывки контура
        poly = [(x * PT_TO_MM * scale, (H - y) * PT_TO_MM * scale) for x, y in pts]
        raw.append(poly)
    if not raw:
        return [], (0.0, 0.0)
    shift_x = max(x for poly in raw for x, _ in poly)
    shift_y = max(y for poly in raw for _, y in poly)
    polys = [[(x - shift_x, y - shift_y) for x, y in poly] for poly in raw]
    return polys, (shift_x, shift_y)


def parse_page(page) -> tuple:
    """Возвращает (список Room с пустым `floor`, предупреждения). `floor`
    проставляется вызывающим кодом — одна страница может обслуживать
    несколько физических этажей (типовые планы). Порядок и `index` —
    по центроиду контура (сначала сверху вниз, потом слева направо в
    координатах листа), детерминированно от запуска к запуску."""
    scale = _page_scale(page)
    H = page.rect.height
    polygons_mm, (shift_x, shift_y) = _room_polygons(page, scale)

    def centroid_key(poly):
        n = len(poly)
        cx = sum(p[0] for p in poly) / n
        cy = sum(p[1] for p in poly) / n
        return (-round(cy), round(cx))  # сверху вниз (Y уже инвертирован в мм)

    polygons_mm.sort(key=centroid_key)
    rooms = [Room(floor="", index=i, polygon_mm=poly)
            for i, poly in enumerate(polygons_mm)]
    shapely_rooms = [Polygon(r.polygon_mm) for r in rooms]

    words = page.get_text("words")

    def to_mm(x_pt, y_pt):
        return (x_pt * PT_TO_MM * scale - shift_x,
                (H - y_pt) * PT_TO_MM * scale - shift_y)

    # секция: центроид комнаты по одну или другую сторону границы осей
    # «…с1»/«…с2» (см. _axis_boundary_x) — считается один раз на лист, в
    # тех же сырых координатах (pt), что и сами подписи осей.
    boundary_pt = _axis_boundary_x(words)
    if boundary_pt is not None:
        boundary_mm = boundary_pt * PT_TO_MM * scale - shift_x
        for room, poly in zip(rooms, shapely_rooms):
            cx = poly.centroid.x
            room.section = "С01" if cx < boundary_mm else "С02"

    # площадь: число вида «14,3» рядом со словом «м2», центр — в комнате
    matched_area = 0
    for i, w in enumerate(words):
        if not _AREA_RE.match(w[4]):
            continue
        nxt = words[i + 1] if i + 1 < len(words) else None
        if not nxt or "м2" not in nxt[4].replace("²", "2"):
            continue
        px, py = to_mm(w[0], w[1])
        point = Point(px, py)
        for room, poly in zip(rooms, shapely_rooms):
            if poly.contains(point):
                room.area_m2 = float(w[4].replace(",", "."))
                matched_area += 1
                break

    warnings = []
    if rooms and matched_area < len(rooms) * 0.5:
        warnings.append(
            f"площадь найдена только у {matched_area} из {len(rooms)} "
            "помещений — проверьте разбор этого листа отдельно")
    if rooms and boundary_pt is None:
        warnings.append(
            "граница осей секций не определена (нет подписей «…с1»/«…с2» "
            "обеих секций сразу) — секция помещений этого листа не проставлена")
    return rooms, warnings


def parse_document(doc) -> tuple:
    """Разбор всего комплекта по FLOOR_PLANS. `doc` — уже открытый
    `fitz.Document` (см. `load()`). Возвращает (список Room, предупреждения)."""
    all_rooms = []
    warnings = []
    page_cache = {}
    for plan in FLOOR_PLANS:
        if plan.page not in page_cache:
            page = doc[plan.page - 1]
            try:
                page_cache[plan.page] = parse_page(page)
            except PdfRoomsError as e:
                warnings.append(f"Лист {plan.page} (этаж {plan.floor}): {e.message}")
                page_cache[plan.page] = ([], [])
        rooms, page_warnings = page_cache[plan.page]
        for w in page_warnings:
            warnings.append(f"Лист {plan.page} (этаж {plan.floor}): {w}")
        # Этаж с ОДНОЙ возможной секцией — она известна из таблицы этажей
        # надёжнее любой геометрии; определение по осям только для этажей,
        # общих для нескольких секций (иначе шум на границе листа мог бы
        # переспорить заведомо известный факт).
        known_section = plan.section_codes[0] if len(plan.section_codes) == 1 else None
        for r in rooms:
            all_rooms.append(Room(floor=plan.floor, index=r.index,
                                  polygon_mm=r.polygon_mm, area_m2=r.area_m2,
                                  section=known_section or r.section,
                                  page=plan.page))
    return all_rooms, warnings


def _wall_segments_raw(page, scale: int, shift_x: float, shift_y: float) -> list:
    """Залитые прямоугольники слоёв материала стен (`_WALL_LAYERS`) на
    ВСЁМ листе — легенда материалов ещё не отсечена (см. `parse_walls_
    page`). Один прямоугольник — один ПРЯМОЙ участок стены: под
    штриховкой (тысячи мелких обрывков линий, `type == "s"`, о них
    докстрока модуля) лежит настоящая заливка (`type == "f"`) — по одной
    фигуре на прямой кусок стены между углами/проёмами, толщина —
    короткая сторона её прямоугольника. `shift_x`/`shift_y` — тот же сдвиг
    выравнивания, что и у `_room_polygons` (передаётся, а не считается
    заново — один и тот же для всех слоёв листа)."""
    H = page.rect.height
    out = []
    for d in page.get_cdrawings():
        spec = _WALL_LAYERS.get(d.get("layer"))
        if not spec or d["type"] != "f":
            continue
        pts = [it[1] for it in d["items"] if it[0] == "l"]
        if d["items"]:
            pts.append(d["items"][-1][2])
        if len(pts) < 3:
            continue
        rect = d["rect"]
        if (rect[2] - rect[0]) * (rect[3] - rect[1]) < 0.05:
            continue  # шум — точечные обрывки контура
        poly = [(x * PT_TO_MM * scale - shift_x, (H - y) * PT_TO_MM * scale - shift_y)
                for x, y in pts]
        category, material = spec
        thickness = round(min(rect[2] - rect[0], rect[3] - rect[1]) * PT_TO_MM * scale, 1)
        out.append({"category": category, "material": material,
                    "polygon_mm": poly, "thickness_mm": thickness})
    return out


def _seg_centroid(poly) -> tuple:
    n = len(poly)
    return (sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n)


def parse_walls_page(page) -> tuple:
    """Стены и перегородки листа, за вычетом легенды материалов, плюс их
    секция (по той же границе подписей осей, что и у помещений — см.
    `_axis_boundary_x`). Возвращает (список словарей, предупреждения)."""
    scale = _page_scale(page)
    room_polys, (shift_x, shift_y) = _room_polygons(page, scale)
    segments = _wall_segments_raw(page, scale, shift_x, shift_y)
    warnings = []
    if not room_polys:
        return [], warnings

    xs = [x for poly in room_polys for x, _ in poly]
    ys = [y for poly in room_polys for _, y in poly]
    x0, x1 = min(xs) - _LEGEND_MARGIN_MM, max(xs) + _LEGEND_MARGIN_MM
    y0, y1 = min(ys) - _LEGEND_MARGIN_MM, max(ys) + _LEGEND_MARGIN_MM
    segments = [s for s in segments
               if x0 <= _seg_centroid(s["polygon_mm"])[0] <= x1
               and y0 <= _seg_centroid(s["polygon_mm"])[1] <= y1]

    words = page.get_text("words")
    boundary_pt = _axis_boundary_x(words)
    if boundary_pt is not None:
        boundary_mm = boundary_pt * PT_TO_MM * scale - shift_x
        for s in segments:
            s["section"] = "С01" if _seg_centroid(s["polygon_mm"])[0] < boundary_mm else "С02"
    else:
        for s in segments:
            s["section"] = None

    segments.sort(key=lambda s: (-round(_seg_centroid(s["polygon_mm"])[1]),
                                 round(_seg_centroid(s["polygon_mm"])[0])))
    return segments, warnings


def _floor_slab_polygon(room_polys: list, wall_polys: list) -> Optional[list]:
    """Контур плиты перекрытия — приближение объединением контуров
    помещений и стен этажа (см. докстрока `Slab`), а не измерение.
    Внутренние отверстия объединения (шахты, колодцы) отбрасываются —
    это контур ЗДАНИЯ, а не точная форма плиты со всеми вырезами."""
    shapes = []
    for poly in room_polys + wall_polys:
        if len(poly) < 3:
            continue
        try:
            shp = Polygon(poly).buffer(0)
        except Exception:
            continue
        if shp and not shp.is_empty:
            shapes.append(shp)
    if not shapes:
        return None
    merged = unary_union(shapes)
    if merged.is_empty:
        return None
    if merged.geom_type == "MultiPolygon":
        merged = max(merged.geoms, key=lambda g: g.area)
    if merged.geom_type != "Polygon":
        return None
    return [(round(x, 1), round(y, 1)) for x, y in merged.exterior.coords[:-1]]


def parse_walls_document(doc, rooms: list) -> tuple:
    """Стены, перегородки и плиты перекрытия по тем же листам, что и
    `parse_document`. `rooms` — уже разобранные помещения (тот же вызов) —
    их контуры участвуют в приближении плиты и не разбираются заново.

    Возвращает (список WallSegment, список Slab, предупреждения)."""
    rooms_by_floor = {}
    for r in rooms:
        rooms_by_floor.setdefault(r.floor, []).append(r.polygon_mm)

    all_walls = []
    all_slabs = []
    warnings = []
    page_cache = {}
    for plan in FLOOR_PLANS:
        if plan.page not in page_cache:
            page = doc[plan.page - 1]
            try:
                page_cache[plan.page] = parse_walls_page(page)
            except PdfRoomsError as e:
                warnings.append(f"Лист {plan.page} (этаж {plan.floor}): {e.message}")
                page_cache[plan.page] = ([], [])
        segments, page_warnings = page_cache[plan.page]
        for w in page_warnings:
            warnings.append(f"Лист {plan.page} (этаж {plan.floor}): {w}")

        known_section = plan.section_codes[0] if len(plan.section_codes) == 1 else None
        for i, s in enumerate(segments):
            all_walls.append(WallSegment(
                floor=plan.floor, index=i, page=plan.page,
                category=s["category"], material=s["material"],
                polygon_mm=s["polygon_mm"], thickness_mm=s["thickness_mm"],
                section=known_section or s.get("section")))

        room_polys = rooms_by_floor.get(plan.floor) or []
        slab_poly = _floor_slab_polygon(room_polys, [s["polygon_mm"] for s in segments])
        if slab_poly:
            all_slabs.append(Slab(floor=plan.floor, polygon_mm=slab_poly, page=plan.page))
        elif room_polys:
            warnings.append(f"Лист {plan.page} (этаж {plan.floor}): "
                           "не удалось приблизить контур плиты перекрытия")
    return all_walls, all_slabs, warnings


def page_axis_labels(page) -> dict:
    """Подписи осей листа (см. `_AXIS_RE`) в тех же выровненных мм-
    координатах, что и контуры помещений (`_room_polygons` — тот же сдвиг,
    независимо посчитанный для этого листа). Возвращает `{подпись:
    (направление, координата)}`: направление `'x'` — вертикальная ось
    (подпись цифрой, «1», «15» — стандартное черчение нумерует ими
    вертикальные оси), `'y'` — горизонтальная (подпись буквой, «А», «Б»).
    Несколько вхождений одной подписи на листе — координата усредняется."""
    scale = _page_scale(page)
    _, (shift_x, shift_y) = _room_polygons(page, scale)
    H = page.rect.height
    buckets = {}
    for w in page.get_text("words"):
        m = _AXIS_RE.match(w[4])
        if not m:
            continue
        label = w[4]
        направление = "x" if m.group(1).isdigit() else "y"
        x_mm = w[0] * PT_TO_MM * scale - shift_x
        y_mm = (H - w[1]) * PT_TO_MM * scale - shift_y
        координата = x_mm if направление == "x" else y_mm
        buckets.setdefault(label, (направление, []))[1].append(координата)
    return {label: (направление, sum(coords) / len(coords))
            for label, (направление, coords) in buckets.items()}


def extract_axis_grid(doc) -> dict:
    """Подписи осей обеих секций сразу — с одного листа общего этажа
    (`RoomPlan.section_codes` из двух кодов, см. `_SPEC`): только там
    заведомо показаны оси и секции 1, и секции 2 (та же логика, что у
    `_axis_boundary_x`). `{}`, если такого листа в комплекте нет."""
    shared = next((p for p in FLOOR_PLANS if len(p.section_codes) == 2), None)
    if shared is None:
        return {}
    return page_axis_labels(doc[shared.page - 1])


def load(data: bytes):
    try:
        return fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        raise PdfRoomsError("Файл не открылся как PDF: %s" % e)
