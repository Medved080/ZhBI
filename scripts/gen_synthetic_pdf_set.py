#!/usr/bin/env python3
"""
Генератор СИНТЕТИЧЕСКОГО PDF-комплекта чертежей для проверки двух конвейеров
загрузки V1 без обращения к реальным чертежам заказчика:

- `app/pdf_import.py` + `app/pdf_rooms.py` — детальная загрузка помещений
  (полигоны слоя `оо_ПЛОЩАДИ_помещений.оо`, масштаб «М1:100» на листе,
  подписи осей «Ас1»/«1с2», площади «14,3 м2», слои стен `_WALL_LAYERS`);
- `app/pdf_facade_import.py` — упрощённая загрузка «только фасады» (подписи
  высотных отметок «+N,NNN» на листах 21/22, образующие прямую «координата
  страницы -> мм», плюс те же планы этажей для привязки подвала/кровли-2).

Оба модуля ЖЁСТКО завязаны на конкретный комплект чертежей объекта
80-0924-ОКЭФ-1/Н-3 — номера листов, имена слоёв, формат подписей взяты
буквально из `app/pdf_rooms.FLOOR_PLANS`/`app/pdf_facade_import._FACADE_X`
и т.п. (не продублированы вручную, чтобы не разойтись с кодом при правках).
Файл — 22 страницы, как настоящий комплект; листы, не участвующие в разборе
(1,2,4,17,18,19,20), — пустые с поясняющей подписью.

Как устроена геометрия. Каждая страница рисуется в СВОИХ PDF-координатах
(pt) без предварительного сдвига под общий охват — `pdf_rooms._room_polygons`
сам выравнивает лист по верхнему правому углу застройки при разборе. Все
страницы планов используют ОДИНАКОВУЮ раскладку помещений (одна и та же
сетка осей на каждом листе) — это осознанное упрощение синтетики: реальный
комплект несёт РАЗНЫЕ отпечатки этажей (подземный/1-2 этаж шире типовой
башни), из-за чего в V1 существует `_page_shift_correction`; здесь эта
поправка просто не нужна (все листы уже выровнены одинаково), но сам код
её всё равно вызывает и получает (0, 0) — путь кода отрабатывает, просто
без реальной работы.

Площадь помещений считается ОТ РИСУЕМОЙ геометрии (масштаб 1:100), поэтому
подписи площадей всегда физически совпадают с контуром — `pdf_rooms.
_area_label` сопоставления с геометрией не проверяет (берёт ближайшую
подпись из нескольких кандидатов), но для честности подписи не выдуманы.

Ограничения (см. отчёт задачи, не повторяются в коде отдельно):
секция «Паркинг»/«Рампа» (`pdf_rooms._drop_oversized_rooms`, «один блок без
деления») синтетикой НЕ воспроизведена — единственный путь, которым V1
присваивает эту секцию, требует полигона-«клубка» почти во весь этаж с
самопересечениями; подземный этаж здесь — обычные помещения С01/С02, как и
остальные этажи. Окна (`_exterior_infill_segments`, слой
`]]]_СТЕНЫ_наружные.]`) тоже не рисуются — это отдельный, не запрошенный
путь (кластеризация повторяющихся фигур по размеру).
"""

import argparse
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import pdf_rooms as pr  # noqa: E402
from app import pdf_facade_import as pfi  # noqa: E402


# ------------------------------------------------------------------ шрифт
# Базовые PDF-шрифты (helv/times) кириллицу не несут — insert_text молча
# подставляет «·» вместо букв (проверено при отладке), а весь конвейер V1
# держится на кириллических подписях («М1:100», «Ас1», «м2»). Arial.ttf —
# системный шрифт macOS, встраивается в каждую вставку текста отдельно
# (`fontfile=`, без общего `insert_font`) — проще и не требует вести список
# уже зарегистрированных страниц.
_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
_FONT_CACHE = {}


def _font_file() -> str:
    if "path" not in _FONT_CACHE:
        for p in _FONT_CANDIDATES:
            if Path(p).exists():
                _FONT_CACHE["path"] = p
                break
        else:
            raise RuntimeError(
                "Не нашёлся TTF-шрифт с кириллицей ни по одному известному "
                "пути — нужен для подписей осей/площадей/отметок в "
                "синтетическом PDF. Добавьте путь в _FONT_CANDIDATES.")
    return _FONT_CACHE["path"]


def _text(page, x, y, s, size=7):
    page.insert_text((x, y), s, fontsize=size, fontfile=_font_file(), fontname="cyr")


def _rect_pts(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


def _fill(page, pts, oc, color=(0.82, 0.82, 0.82)):
    """Залитый полигон через draw_polyline — ТОЛЬКО так `get_cdrawings()`
    отдаёт точки списком 'l'-примитивов (`pr._room_polygons`/
    `_wall_segments_raw` ждут именно такой вид items; `draw_rect` кладёт
    примитив другого типа, который тот же код не читает — проверено при
    отладке: cdrawings с draw_rect не даёт ожидаемых 'l'-элементов)."""
    shape = page.new_shape()
    shape.draw_polyline(pts)
    shape.finish(fill=color, color=None, oc=oc)
    shape.commit()


_OCG_CACHE = {}


def _ocg(doc, name):
    """Optional Content Group — документный объект, заводится один раз на
    документ и переиспользуется на всех страницах (в отличие от шрифта,
    который встраивается per-insert)."""
    key = (id(doc), name)
    if key not in _OCG_CACHE:
        _OCG_CACHE[key] = doc.add_ocg(name, on=True)
    return _OCG_CACHE[key]


# --------------------------------------------------------------- масштаб
SCALE = 100  # «М1:100» — тот же множитель, что читает pr._page_scale
PT_TO_MM = pr.PT_TO_MM


def _area_m2(w_pt, h_pt) -> float:
    return (w_pt * PT_TO_MM * SCALE) * (h_pt * PT_TO_MM * SCALE) / 1e6


def _fmt_area(v: float) -> str:
    return ("%.1f" % v).replace(".", ",")


def _fmt_elev(z_mm: int) -> str:
    """78750 -> «+78,750»; -6450 -> «-6,450»; 0 -> «0,000» — тот же формат,
    что читает pr._parse_elev_mm... нет, читает pfi._parse_elev_mm
    («метры,мм», НЕ десятичная точка)."""
    sign = "-" if z_mm < 0 else ("+" if z_mm > 0 else "")
    whole, frac = divmod(abs(z_mm), 1000)
    return "%s%d,%03d" % (sign, whole, frac)


# Слой стен — «]]]_СТ_вн_Бетон» (Стены, Монолитный железобетон): единственный
# материал из pr._WALL_LAYERS, который ЕЩЁ И входит в pr._STRUCTURE_MATERIALS
# — переживает фильтр «только конструкция, выделенная цветом» на кровле/
# техэтаже секции 2 (pr._STRUCTURE_ONLY_FLOORS), поэтому стены не выпадают
# ни на одном этаже комплекта. Второй слой («]]]_СТ_вн_Кирпич», Кирпич) —
# для проверки, что несколько РАЗНЫХ слоёв стен разбираются одинаково
# (запрошено заданием, «1-2 слоя стен»); используется только в варианте
# `ok` на «богатых» страницах, чтобы не раздувать минимальные варианты.
_WALL_LAYER_1 = "]]]_СТ_вн_Бетон"
_WALL_LAYER_2 = "]]]_СТ_вн_Кирпич"
_WALL_THICKNESS_PT = 6.0  # 6pt * PT_TO_MM * 100 ≈ 212мм — толще порога 45мм


def _wall_strip(page, doc, x0, y0, x1, y1, layer=_WALL_LAYER_1):
    _fill(page, _rect_pts(x0, y0, x1, y1), _ocg(doc, layer), color=(0.55, 0.55, 0.55))


# ------------------------------------------------------------ раскладка
# Общая раскладка для «двухсекционных» листов (обе секции на одном листе)
# и для «только С02» листов (типовые верхние этажи/техэтаж-2/кровля-2).
# Секция С01 всегда СТРОГО левее секции С02 с зазором (обязательное условие
# pr._axis_boundary_x: `s1_max < s2_min`).
_C01_X0 = 150
_C02_X0 = 650
_ZONE_Y0, _ZONE_Y1 = 150, 700


def _c01_rooms(rich: bool):
    if rich:
        return [(_C01_X0, _ZONE_Y0, 350, _ZONE_Y1), (350, _ZONE_Y0, 550, _ZONE_Y1)]
    return [(_C01_X0, _ZONE_Y0, 350, _ZONE_Y1)]


def _c02_rooms(rich: bool):
    if rich:
        x0, xm, x1 = _C02_X0, 950, 1250
        ym = (_ZONE_Y0 + _ZONE_Y1) / 2
        return [
            (x0, _ZONE_Y0, xm, ym), (xm, _ZONE_Y0, x1, ym),
            (x0, ym, xm, _ZONE_Y1), (xm, ym, x1, _ZONE_Y1),
        ]
    return [(_C02_X0, _ZONE_Y0, 850, _ZONE_Y1)]


def _draw_rooms(page, doc, rects, warn_free=True):
    ocg = _ocg(doc, pr.ROOM_LAYER)
    for x0, y0, x1, y1 in rects:
        _fill(page, _rect_pts(x0, y0, x1, y1), ocg)
        area = _area_m2(x1 - x0, y1 - y0)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        _text(page, cx - 22, cy, "%s м2" % _fmt_area(area), 7)


def draw_two_section_page(doc, page, rich: bool, with_scale: bool = True):
    """Лист с помещениями ОБЕИХ секций (подземный, этажи 1-8, технический
    этаж/кровля секции 1 бок о бок с этажом 9/10 секции 2 — см. FLOOR_PLANS:
    у всех этих записей либо `section_codes` из двух кодов, либо запись
    делит физическую страницу с другой, у которой единственный код —
    единая раскладка листа годится в обоих случаях: `parse_document`
    решает, что оставить, по границе осей/известной секции этажа."""
    if with_scale:
        _text(page, 50, 50, "М1:100", 8)
    c01 = _c01_rooms(rich)
    c02 = _c02_rooms(rich)
    _draw_rooms(page, doc, c01)
    _draw_rooms(page, doc, c02)

    c01_x1 = max(r[2] for r in c01)
    c02_x1 = max(r[2] for r in c02)
    _wall_strip(page, doc, _C01_X0, _ZONE_Y1, c01_x1, _ZONE_Y1 + _WALL_THICKNESS_PT)
    _wall_strip(page, doc, _C02_X0, _ZONE_Y1, c02_x1, _ZONE_Y1 + _WALL_THICKNESS_PT)
    if rich:
        # второй слой стен — узкая полоса слева секции С01 (кирпичная
        # перегородка), только на «богатых» листах.
        _wall_strip(page, doc, _C01_X0 - _WALL_THICKNESS_PT, _ZONE_Y0,
                   _C01_X0, _ZONE_Y1, layer=_WALL_LAYER_2)

    # оси: числовые (вертикальные, направление "x") и буквенные
    # (горизонтальные, "y") — обе секции, с зазором между с1/с2 по X.
    _text(page, _C01_X0 + 5, 725, "1с1", 7)
    _text(page, c01_x1 - 15, 725, "2с1", 7)
    _text(page, _C02_X0 + 5, 725, "1с2", 7)
    _text(page, c02_x1 - 15, 725, "2с2", 7)
    _text(page, 100, 140, "Ас1", 7)
    _text(page, 100, 705, "Бс1", 7)
    _text(page, 600, 140, "Ас2", 7)
    _text(page, 600, 705, "Бс2", 7)


def draw_c02_only_page(doc, page, rich: bool, fake_c1_axis: bool, with_scale: bool = True):
    """Лист, где физически размечена только секция С02 (типовые верхние
    этажи 11-24, технический этаж/кровля секции 2). `fake_c1_axis` —
    добавить числовые подписи «...с1» БЕЗ самих помещений С01: нужно
    только двум листам (типовой этаж, кровля-2), которые
    `pdf_facade_import._plan_rooms_canonical` читает НАПРЯМУЮ через
    `pr.parse_page` — без обхода через `parse_document.known_section`,
    поэтому секция помещения там определяется ИСКЛЮЧИТЕЛЬНО по границе
    осей `_axis_boundary_x`, которой без пары «с1»/«с2» не будет (см.
    докстроку модуля/итоговый отчёт)."""
    if with_scale:
        _text(page, 50, 50, "М1:100", 8)
    c02 = _c02_rooms(rich)
    _draw_rooms(page, doc, c02)
    c02_x1 = max(r[2] for r in c02)
    _wall_strip(page, doc, _C02_X0, _ZONE_Y1, c02_x1, _ZONE_Y1 + _WALL_THICKNESS_PT)

    _text(page, _C02_X0 + 5, 725, "1с2", 7)
    _text(page, c02_x1 - 15, 725, "2с2", 7)
    _text(page, 600, 140, "Ас2", 7)
    _text(page, 600, 705, "Бс2", 7)
    if fake_c1_axis:
        _text(page, _C01_X0 + 5, 725, "1с1", 7)
        _text(page, 350 - 15, 725, "2с1", 7)


def draw_blank_page(page, note: str):
    _text(page, 50, 50, note, 9)


# ------------------------------------------------------------- фасады
# Листы 21/22 (1-based) = doc[20]/doc[21] (0-based, см. `pfi._FACADE_X`/
# `_CALIBRATION_PAGES` — там ЯВНО «0-based» в комментарии) — последние два
# листа 22-страничного комплекта. На каждом — ДВА вида бок о бок (X-силуэт
# слева, Y-силуэт справа, как в `pfi._FACADE_X`/`_FACADE_Y`) плюс подписи
# высотных отметок в зазоре между ними; второй лист — зеркальное отражение
# первого (см. докстроку `_build_facade`).
_FACADE_A_X = (500, 700)   # С01, силуэт по X, до отметки 31000мм
_FACADE_B_X = (700, 940)   # С02, силуэт по X, до отметки 77000мм (типовая башня)
_FACADE_MIRROR_AXIS = (_FACADE_A_X[0] + _FACADE_B_X[1]) / 2
_FACADE_Y0 = 1350   # y_pt при z=0 (нижний край силуэта на листе)
_FACADE_K = 0.01    # pt/мм по вертикали: y_pt = _FACADE_Y0 - _FACADE_K*z
_FACADE_DEPTH_X = (1500, 1700)  # Y-силуэт (глубина) — общий на обе секции
_FACADE_ELEV_POINTS = (0, 4650, 25650, 31650, 61650, 73650, 76800)
_FACADE_A_TOP_MM = 31000
_FACADE_B_TOP_MM = 77000


def _facade_y(z_mm: float) -> float:
    return _FACADE_Y0 - _FACADE_K * z_mm


def _rect(page, x0, y0, x1, y1, color=(0.15, 0.15, 0.15)):
    shape = page.new_shape()
    shape.draw_polyline(_rect_pts(x0, y0, x1, y1))
    shape.finish(fill=color, color=None)
    shape.commit()


def _mirror_x(x):
    return 2 * _FACADE_MIRROR_AXIS - x


def draw_facade_pages(doc):
    """Рисует ОБА фасадных листа. Раскраска идентична (одна и та же
    застройка), но второй лист — ГЕОМЕТРИЧЕСКИ ЗЕРКАЛЬНАЯ копия первого
    (координаты X отражены относительно `_FACADE_MIRROR_AXIS`), а не
    буквальный дубликат: `pfi._sheet_extents` сам отражает измерение
    второго листа обратно (`mirrored=True` -> `ext=(-ext[1],-ext[0])`), и
    только у ИСТИННОГО зеркала это отражение даёт ПОСТОЯННОЕ («одно и то
    же для каждого этажа») расхождение с первым листом, которое
    `pfi._combine_sheets` снимает медианой. Проверено на прогоне
    (`compute_facade_blocks`) при отладке — с буквальным дубликатом (без
    отражения) для типовых этажей и для этажей 1-8 получались РАЗНЫЕ
    константы сдвига, и секция С01 на этажах 1-8 терялась (объединение
    сведений «пересечением» вместо «средним» отрезало её до нуля)."""
    for page_no in pfi._CALIBRATION_PAGES:  # (20, 21), 0-based
        page = doc[page_no]
        mirrored = page_no != pfi._CALIBRATION_PAGES[0]

        def mx(x):
            return _mirror_x(x) if mirrored else x

        a0, a1 = sorted((mx(_FACADE_A_X[0]), mx(_FACADE_A_X[1])))
        b0, b1 = sorted((mx(_FACADE_B_X[0]), mx(_FACADE_B_X[1])))
        y_a_top = _facade_y(_FACADE_A_TOP_MM)
        y_b_top = _facade_y(_FACADE_B_TOP_MM)
        _rect(page, a0, y_a_top, a1, _FACADE_Y0)
        _rect(page, b0, y_b_top, b1, _FACADE_Y0)
        # глубина (Y-направление) секциями не делится (см. докстроку
        # pdf_facade_import) — один прямоугольник на всю высоту типовой
        # башни, дублируется на обоих листах без отражения (единственная
        # «форма» в этом направлении — отражать нечего, см. отчёт).
        _rect(page, _FACADE_DEPTH_X[0], y_b_top, _FACADE_DEPTH_X[1], _FACADE_Y0)
        for z in _FACADE_ELEV_POINTS:
            _text(page, 1333, _facade_y(z), _fmt_elev(z), 7)


# --------------------------------------------------------- сборка листов
# Номера листов (1-based) — из pr.FLOOR_PLANS, НЕ продублированы вручную.
_UNIQUE_PLAN_PAGES = sorted({p.page for p in pr.FLOOR_PLANS})
_SECTION_CODES_BY_PAGE = {}
for _p in pr.FLOOR_PLANS:
    _SECTION_CODES_BY_PAGE.setdefault(_p.page, set()).update(_p.section_codes)

# Листы, где физически показана ТОЛЬКО секция С02 (по факту — все планы,
# где ни один FLOOR_PLANS-этаж этой страницы не несёт код "С01").
_C02_ONLY_PAGES = {p for p in _UNIQUE_PLAN_PAGES if _SECTION_CODES_BY_PAGE[p] == {"С02"}}
_TWO_SECTION_PAGES = sorted(set(_UNIQUE_PLAN_PAGES) - _C02_ONLY_PAGES)

# Листы, которые pdf_facade_import читает НАПРЯМУЮ через pr.parse_page (не
# через parse_document/known_section) — нужны подписи осей «с1» ДАЖЕ без
# помещений С01, иначе секция С02 там не определится вовсе (см. докстроку
# draw_c02_only_page и итоговый отчёт задачи).
_FAKE_C1_PAGES = {pfi._PLAN_TYPICAL_PAGE, pfi._PLAN_ROOF2_PAGE}

TOTAL_PAGES = 22
_FACADE_PAGES_1BASED = {p + 1 for p in pfi._CALIBRATION_PAGES}  # {21, 22}
_USED_PAGES = set(_UNIQUE_PLAN_PAGES) | _FACADE_PAGES_1BASED
_FILLER_PAGES = sorted(set(range(1, TOTAL_PAGES + 1)) - _USED_PAGES)


def build(variant: str) -> fitz.Document:
    doc = fitz.open()
    for _ in range(TOTAL_PAGES):
        doc.new_page(width=1900, height=1500)

    if variant == "no_rooms":
        # Ни одной фигуры слоя помещений нигде в файле — pdf_import.analyze
        # обязан упасть на «в файле не нашлось ни одного помещения». «М1:100»
        # ОБЯЗАТЕЛЬНА на каждом листе планов — иначе разбор падает РАНЬШЕ,
        # на `pdf_rooms.extract_axis_grid` (см. итоговый отчёт задачи: она
        # проходит по ВСЕМ уникальным листам `FLOOR_PLANS` за пределами
        # per-page try/except `parse_document`, ДО того как накопится
        # список помещений, и без масштаба падает необёрнутым
        # `PdfRoomsError`, а не чистой «в файле не нашлось ни одного
        # помещения»). Без слоя помещений, но С масштабом — воспроизводит
        # именно запрошенное поведение.
        for page_no in _UNIQUE_PLAN_PAGES:
            _text(doc[page_no - 1], 50, 50, "М1:100", 8)
        for page_no in _FILLER_PAGES:
            draw_blank_page(doc[page_no - 1], "Лист %d — тестовый комплект (без помещений)" % page_no)
        for page_no in _FACADE_PAGES_1BASED:
            draw_blank_page(doc[page_no - 1], "Лист %d — тестовый комплект (без помещений)" % page_no)
        return doc

    rich = variant == "ok"
    # bad_scale: тот же минимальный комплект, что у small, но лист 3
    # (подземный) — БЕЗ подписи «М1:100» (единственное отличие).
    scale_missing_page = 3 if variant == "bad_scale" else None

    for page_no in _TWO_SECTION_PAGES:
        with_scale = page_no != scale_missing_page
        draw_two_section_page(doc, doc[page_no - 1], rich, with_scale=with_scale)
    for page_no in _C02_ONLY_PAGES:
        with_scale = page_no != scale_missing_page
        draw_c02_only_page(doc, doc[page_no - 1], rich,
                           fake_c1_axis=page_no in _FAKE_C1_PAGES, with_scale=with_scale)
    draw_facade_pages(doc)
    for page_no in _FILLER_PAGES:
        draw_blank_page(doc[page_no - 1], "Лист %d — вне разбора (тестовый комплект)" % page_no)
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("output", help="путь к выходному PDF")
    ap.add_argument("--variant", choices=["ok", "no_rooms", "bad_scale", "small"],
                    default="ok")
    args = ap.parse_args()

    doc = build(args.variant)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    print("Записано %d страниц -> %s (вариант %s)" % (doc.page_count, out, args.variant))


if __name__ == "__main__":
    main()
