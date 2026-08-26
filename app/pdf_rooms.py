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

ROOM_LAYER = "оо_ПЛОЩАДИ_помещений.оо"

PT_TO_MM = 25.4 / 72.0

# Площадь: «14,3» — запятая, без единицы (единица «м2» отдельным словом рядом).
_AREA_RE = re.compile(r'^\d{1,4}[.,]\d$')
_SCALE_RE = re.compile(r'М\s*1\s*:\s*(\d+)')
# Подпись оси: «Ас1», «1с2», «15с1» — буква/номер оси + номер секции.
_AXIS_RE = re.compile(r'^[A-ZА-Я0-9]{1,2}с(\d)$', re.IGNORECASE)


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
class Room:
    floor: str
    index: int                 # порядковый номер на этаже — см. docstring модуля
    polygon_mm: list           # [(x, y), ...] в мм, локальные координаты листа
    area_m2: Optional[float] = None
    section: Optional[str] = None   # "С01" | "С02" | None — см. _axis_boundary_x


def _axis_boundary_x(words) -> Optional[float]:
    """Граница между подписями осей секции 1 («…с1») и секции 2 («…с2»)
    в СЫРЫХ координатах листа (pt, до перевода в мм и сдвига). `None`, если
    на листе нет подписей обеих секций сразу (граница не определена — не
    гадаем, откуда её брать)."""
    s1_x = [w[0] for w in words if (m := _AXIS_RE.match(w[4])) and m.group(1) == "1"]
    s2_x = [w[0] for w in words if (m := _AXIS_RE.match(w[4])) and m.group(1) == "2"]
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
                                  section=known_section or r.section))
    return all_rooms, warnings


def load(data: bytes):
    try:
        return fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        raise PdfRoomsError("Файл не открылся как PDF: %s" % e)
