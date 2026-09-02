"""
Упрощённый импорт из PDF — «по фасадам» (Docs/backlog.md, 2026-09-01,
живой запрос пользователя): блоки (этаж×секция) строятся напрямую из
фасадных чертежей (высота + ступенчатая ширина/глубина по высоте), БЕЗ
разбора помещений/стен `pdf_rooms.py`. Результат — макет здания: только
габарит блока, без внутренней начинки. Жёстко привязан к конкретному
комплекту чертежей объекта 80-0924-ОКЭФ-1/Н-3, как и `pdf_rooms.py`.

Источники данных:
- Z (высоты этажей) — таблица `pdf_rooms.FLOOR_PLANS` (уже сверена с
  разрезом, см. Docs/revit-import.md §13) — она же источник для
  детального разбора, здесь ПЕРЕИСПОЛЬЗУЕТСЯ, не дублируется.
- X/Y (ширина и глубина этажа) — с фасадных листов (20 и 21 в PDF: «1-4»/
  «А-В» и «4-1»/«Б-А» соответственно) — АНАЛИЗОМ РАСТРА, не векторной
  геометрией: сама отрисовка фасада на этих листах — почти целиком
  встроенные растровые тайлы (фоновая подложка), а не заливки по слоям,
  как на планах этажей (проверено 2026-09-01: 18 векторных заливок на
  весь лист против 301 картинки) — векторный разбор, как у `pdf_rooms.
  parse_page`, здесь не работает, годного слоя с контуром помещений нет.
  Используются ОБА листа каждого направления (вторая итерация 2026-09-01):
  зеркальный отражается и сводится с прямым (`_combine_sheets`) — лишний
  штрих одного листа гасится вторым.

Метод — сродни компьютерному зрению, не парсингу чертежа:
1. Вертикальная калибровка (`_vertical_calibration`) — подписи высотных
   отметок «+N,NNN» на фасадных листах образуют строгую прямую
   «страничная координата -> мм» (МНК с отбрасыванием выбросов —
   вспомогательных подписей вроде отметок верха/низа плиты рядом с
   основной линейкой). Общая для всех четырёх фасадных изображений (один
   и тот же чертёжный шаблон и масштаб).
2. Для каждого этажа таблицы `FLOOR_PLANS` вырезается горизонтальная
   полоса рендера листа (`fitz.Pixmap`) на высоту этого этажа и ищется
   ширина «непустого» содержимого по X (`_band_extent`) — не по чистому
   белому/небелому: рамка листа и служебная графика исключаются отдельно
   (`_frame_columns` — столбец, закрашенный почти по всей высоте клипа,
   это рамка, не стена).
3. Секция (С01/С02) на разделяемых этажах (1-8) — по типовому левому краю
   башни (медиана по заведомо однo-секционным верхним этажам): левее
   него на общей ширине — секция 1, правее — секция 2. Для лестничного
   выхода/технического этажа секции 1 (только одна секция в кадре)
   диапазон просто обрезается этой же границей.

Против «ступенек» там, где стены отвесные (вторая итерация 2026-09-01):
прогоны закрашенных колонок у'же `_MIN_RUN_MM` выбрасываются (стойки
ограждений, выносные линии), близкие края этажей прищёлкиваются к
медиане кластера (`_snap_edges`), листы направления сверяются друг с
другом (`_combine_sheets`). Ярус, оставшийся вовсе без собственного
силуэта (кровля надстройки), наследует габарит нижнего яруса той же
секции.

Известное упрощение (не решалось — не совпадает с целью «этажи не
пустые»): ширина ВКЛЮЧАЕТ балконные выступы (фасад рисует видимый
силуэт здания, а не грань несущей стены) — на 5-15% шире, чем у
детального разбора `pdf_rooms`, это ожидаемо для макета, не брак.
Глубина (Y) не делится на секции — для граней «А-В»/«Б-А» видимого
разделения секций 1/2 нет (секция 1 не выступает на эту грань), общая
глубина отдаётся ОБЕИМ секциям этажа.
"""

import re
import uuid

import fitz
import numpy as np
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.validation import make_valid

from . import blocks as blocks_mod
from . import pdf_import
from . import pdf_rooms

PT_TO_MM = pdf_rooms.PT_TO_MM

class PdfFacadeImportError(Exception):
    """Тот же приём, что `pdf_import.PdfImportError` — код ответа при себе,
    не общий с `pdf_rooms.PdfRoomsError` (та без кода, для веб-обвязки не
    годится)."""
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(message)

# Токены незавершённого разбора (фаза 1 -> фаза 2) — тот же приём, что у
# `pdf_import._PENDING`, но свой словарь: разбор по фасадам синхронный
# (секунды, не ~30с детального) и не нуждается в фоновом потоке/прогрессе
# — простого запрос-ответа достаточно, отдельный `_JOBS`-механизм был бы
# лишним.
_PENDING = {}
_PENDING_LIMIT = 3

_ELEV_RE = re.compile(r'^([+-])?(\d{1,3}),(\d{3})$')


def _parse_elev_mm(text: str):
    """«+78,750» -> 78750 (запятая тут — разделитель тысяч мм, НЕ
    десятичная точка метров, несмотря на вид числа — проверено
    сопоставлением с уже известными отметками объекта, напр. «+25,650»
    у восьмого этажа)."""
    m = _ELEV_RE.match(text)
    if not m:
        return None
    sign, whole, frac = m.groups()
    mm = int(whole) * 1000 + int(frac)
    return -mm if sign == "-" else mm


# (страница PDF, 0-based, клип-прямоугольник в pt, зеркален ли лист) —
# по ДВА листа на направление (2026-09-01, вторая итерация): «1-4»+«4-1»
# для ширины по X, «А-В»+«Б-А» для глубины по Y. Противоположный фасад
# зеркален (наблюдатель с другой стороны), его координаты отражаются
# перед сведением; проекционная ширина силуэта от стороны взгляда не
# зависит, поэтому листы обязаны сходиться — расхождение сверх
# `_CROSS_TOL_MM` значит мусор на одном из листов (выносная линия,
# дорисованный только с одной стороны козырёк), берётся пересечение.
# Оба листа сведены в одном чертёжном шаблоне и масштабе — вертикальная
# калибровка общая (`_CALIBRATION_PAGES`).
_FACADE_X = (
    (20, fitz.Rect(50, 150, 1330, 1400), False),    # «1-4»
    (21, fitz.Rect(50, 150, 1330, 1400), True),     # «4-1» — зеркален
)
_FACADE_Y = (
    (20, fitz.Rect(1350, 150, 1790, 1400), False),  # «А-В»
    (21, fitz.Rect(1350, 150, 1790, 1400), True),   # «Б-А» — зеркален
)
_CALIBRATION_PAGES = (20, 21)

# Минимальная ширина непрерывного прогона закрашенных колонок, чтобы
# считать его частью здания. Уже 300мм стен не бывает; всё, что тоньше —
# стойки ограждения кровли (~70мм с шагом ~300мм), выносные линии подписей
# (1px..24мм) — именно они растягивали габарит техэтажей/кровли на метры
# (Docs/backlog.md 09-01: «+4м глубины у верха башни», «фантомная ширина
# кровли секции 1»). Проверено на реальном комплекте: у настоящих стен
# краеобразующие прогоны 517мм и шире — запас больше полутора раз.
# ВАЖНО: фильтр отбрасывает узкие КУСКИ, а не режет по РАЗРЫВАМ между
# ними — отклонённый ранее `_GAP_TOLERANCE` (см. backlog 09-01) делал
# второе и разваливал здание: внутри настоящего контура есть разрывы
# плотности до 9,5м (середина башни), их трогать нельзя.
_MIN_RUN_MM = 300
# Разрывы в прогоне мельче этого (антиалиасинг растровой подложки)
# склеиваются ДО фильтра по ширине — чтобы один волосяной просвет не
# разрезал настоящую стену на два «узких» куска.
_RUN_GAP_PX = 3
# Края этажей, отличающиеся меньше чем на это, прищёлкиваются к медиане
# своего кластера (`_snap_edges`) — остаточный пиксельный джиттер (±1px ≈
# 24мм при zoom=3) убирается, стены типовых этажей строго отвесны.
# Настоящие архитектурные уступы (цоколь +5,4м, переход секций, кровля)
# на порядок крупнее и в один кластер не слипаются.
_SNAP_TOL_MM = 200
# Допуск сведения двух листов одного направления: в пределах — среднее
# (гасит ±1px разночтения), сверх — пересечение (мусор одного листа).
_CROSS_TOL_MM = 300

# Поправки, снятые с натуры реального комплекта (модуль и так жёстко
# привязан к нему, см. докстроку): полоса яруса не всегда совпадает с его
# стенами по высоте (2026-09-01, живой запрос пользователя — «техэтаж
# первой секции идёт до контуров здания, а выход на кровлю — отдельным
# параллелепипедом внутри контура»).
#  - Технический этаж секции 1: стены идут ПО КОНТУРУ здания (проверено
#    полосой нижних 3м — сплошной прогон, как у этажа 8), но выше них в
#    той же полосе — кровля с ограждением: плотность на целой полосе
#    размывается ниже порога, и собственный замер видел бы только выход
#    на кровлю в середине. Габарит — наследованием от этажа ниже.
_INHERIT_FLOORS = {"технический (секция 1)"}
#  - Кровля секции 1: единственный объём яруса — выход на кровлю,
#    небольшой параллелепипед ВНУТРИ контура; по высоте он занимает
#    только нижнюю половину полосы (выше — воздух, замерено: в верхней
#    половине нет ни одного прогона шире фильтра). Меряется по нижней
#    половине; наследовать контур, как техэтаж, ему как раз НЕЛЬЗЯ.
_LOWER_HALF_FLOORS = {"кровля (секция 1)"}

# Ярусы, которых на фасаде НЕТ или которые растр фасада не берёт (2026-09-02,
# живой запрос пользователя): их габарит снимается с ПЛАНА — теми же
# помещениями, что читает детальный разбор (`pdf_rooms.parse_page`), но
# только с двух листов, а не со всех.
#  - Подземный этаж (лист 3): фасад начинается с «+0,000», под землёй его
#    нет; на плане — паркинг (одно помещение «один блок без деления», своя
#    секция «Паркинг») и подвальные части секций 1/2.
#  - Выход на кровлю секции 2 (лист 16, три помещения: машинное помещение
#    лифта, помещение оконечных устройств, лестничная клетка — 65,1 м² по
#    экспликации): на фасаде надстройка нарисована стенами с точечной
#    фактурой, растр её не видит (плотность ниже порога даже 0.2 — замерено
#    по обеим граням), высота — по подписям отметок (`pdf_import.
#    _FACADE_ONLY_LEVELS`).
# Координаты плана — общая сетка осей объекта (`extract_axis_grid` +
# поправка листа); в систему координат фасадного режима они переводятся
# переносом, снятым по ТИПОВОМУ этажу башни (`_PLAN_TYPICAL_*`): центр
# габарита помещений секции 2 на плане совмещается с центром её же блока
# по фасаду. По центрам, не по краям: фасадный габарит включает балконы и
# на ~1,1 м шире плана по помещениям — совмещение краёв перекосило бы на
# половину этой разницы. Знак по Y проверен по выходу на кровлю: и на
# плане (у оси А), и на грани «А-В» (левая часть) он на одной стороне.
_PLAN_TYPICAL_PAGE, _PLAN_TYPICAL_FLOOR = 12, "12"
_PLAN_BASEMENT_PAGE, _PLAN_BASEMENT_FLOOR = 3, "подземный"
_PLAN_ROOF2_PAGE, _PLAN_ROOF2_FLOOR, _PLAN_ROOF2_SECTION = 16, "кровля (секция 2)", "С02"
# Помещения — внутренний контур; блок по ним расширяется на толщину стены
# с каждой стороны, как и у детального разбора, где габарит блока идёт по
# стенам, а не по помещениям.
_ROOM_WALL_MARGIN_MM = 250
# Помещение подвала считается «в основном контуре здания», если его верх
# не выше верхней грани помещений С02 больше чем на это (толщина стены).
_BASEMENT_TOP_TOL_MM = 500
_PARKING_SECTION = pdf_rooms._PARKING_SECTION
_RAMP_SECTION = pdf_rooms._RAMP_SECTION


def _vertical_calibration(doc, max_iter=15, final_thresh=2.0):
    """(a, b): y_pt = a*z_mm + b — прямая по подписям отметок обеих
    фасадных страниц разом (устойчивее, чем по одной — больше точек на
    ту же прямую). МНК с итеративным отбрасыванием выбросов (вторичные
    подписи вроде «верх плиты», offset на 0.5-1pt от основной линейки).
    `None`, если подписей katastroficheski мало (подписей отметок не
    нашлось — лист не тот/не тот формат)."""
    pts = []
    for pno in _CALIBRATION_PAGES:
        for w in doc[pno].get_text("words"):
            mm = _parse_elev_mm(w[4].replace(" ", ""))
            if mm is None:
                continue
            if not (50 <= w[0] <= 1790 and 100 <= w[1] <= 1450):
                continue
            pts.append((mm, (w[1] + w[3]) / 2))

    def fit(pts):
        n = len(pts)
        sx = sum(p[0] for p in pts); sy = sum(p[1] for p in pts)
        sxx = sum(p[0] ** 2 for p in pts); sxy = sum(p[0] * p[1] for p in pts)
        denom = n * sxx - sx * sx
        if abs(denom) < 1e-9:
            return None
        a = (n * sxy - sx * sy) / denom
        return a, (sy - a * sx) / n

    cur = pts
    ab = None
    for _ in range(max_iter):
        ab = fit(cur)
        if ab is None or len(cur) < 6:
            return None
        a, b = ab
        resid = sorted(((abs(a * mm + b - y), (mm, y)) for mm, y in cur), key=lambda t: -t[0])
        if resid[0][0] <= final_thresh:
            return a, b
        cur = [p for _, p in resid[max(1, len(resid) // 6):]]
    return ab


def _frame_columns(arr, thresh=250, frame_density=0.9):
    """Столбцы рамки листа — закрашены почти по ВСЕЙ высоте клипа разом
    (в отличие от стены, которая занимает только свой этаж) — исключаются
    из поиска силуэта здания, иначе левый/правый край рамки листа
    подменяет собой край здания."""
    non_white = np.any(arr[:, :, :3] < thresh, axis=2)
    return non_white.mean(axis=0) > frame_density


def _column_runs(mask):
    """Непрерывные прогоны True в одномерной маске -> [(нач, кон)]
    включительно, в индексах колонок."""
    idx = np.where(mask)[0]
    if len(idx) == 0:
        return []
    breaks = np.where(np.diff(idx) > 1)[0]
    starts = np.concatenate(([idx[0]], idx[breaks + 1]))
    ends = np.concatenate((idx[breaks], [idx[-1]]))
    return list(zip(starts.tolist(), ends.tolist()))


def _band_extent(arr, clip_x0, zoom, row0, row1, frame_cols, min_run_px,
                 density=0.5, thresh=250, col_hi=None):
    """Левый/правый край непустого содержимого (силуэт здания) в полосе
    [row0,row1) пикселей — «непустое» по плотности закрашенных строк
    внутри полосы (`density`), не по единственному пикселю: тонкие
    выносные линии подписей отметок так отсеиваются (они пересекают
    полосу лишь местами), а собственно стена/окно — плотная заливка на
    всю высоту своего этажа.

    `density=0.5` (не 0.3, как в первой версии) — живой запрос
    пользователя, «стены ступеньками, а на визуализации в pdf стены
    ровные вертикальные» (2026-09-01): при 0.3 порог ловит подоконники,
    окантовку окон и артефакты сжатия растровой подложки — у типовых
    этажей, где стена должна быть ОДНОЙ прямой линией на всю высоту
    тиража, измеренная ширина скакала на 1-2.5м между соседними
    идентичными этажами. Проверено на всех этажах обеих граней (X и Y)
    реального комплекта: при 0.5 типовые прогоны этажей (11-23 по X,
    2-24 почти целиком по Y) дают РОВНО одно и то же значение до
    пиксельной точности, а настоящие архитектурные уступы (шире —
    первый этаж/цоколь, у'же — кровля, ступень на переходе секции 1→2)
    остаются на месте.

    Колонки, прошедшие порог плотности, дополнительно группируются в
    непрерывные прогоны (с подклейкой волосяных разрывов `_RUN_GAP_PX`);
    прогоны у'же `min_run_px` выбрасываются целиком — см. `_MIN_RUN_MM`.
    Возвращается охват ОСТАВШИХСЯ прогонов (min/max), либо `None`, когда
    в полосе не нашлось ни одного куска здания (такой ярус наследует
    габарит нижнего, см. `compute_facade_blocks`).

    `col_hi` (колонка, px) — правая граница поиска: колонки правее неё
    игнорируются. Нужна одно-секционным ярусам подле границы секций
    (выход на кровлю секции 1): в их высотной полосе стоит и башня
    соседней секции, без предела min/max перепрыгивал бы на неё."""
    row0 = max(0, row0); row1 = min(arr.shape[0], row1)
    if row1 <= row0:
        return None
    strip = arr[row0:row1, :, :3]
    non_white = np.any(strip < thresh, axis=2)
    frac = non_white.mean(axis=0).copy()
    frac[frame_cols] = 0
    if col_hi is not None:
        frac[max(0, int(col_hi)):] = 0
    runs = _column_runs(frac >= density)
    merged = []
    for s, e in runs:
        if merged and s - merged[-1][1] - 1 <= _RUN_GAP_PX:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    wide = [(s, e) for s, e in merged if e - s + 1 >= min_run_px]
    if not wide:
        return None
    return clip_x0 + wide[0][0] / zoom, clip_x0 + wide[-1][1] / zoom


def _render(doc, page_no, clip, zoom=3):
    page = doc[page_no]
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    return arr, zoom


def _sheet_extents(doc, a, b, bands, page_no, clip, mirrored, scale,
                   col_hi_pt=None):
    """{этаж: (лево, право) в pt | None} по одному фасадному листу;
    `bands` — [(этаж, z0, z1)] с уже применёнными поправками высот
    (`_LOWER_HALF_FLOORS`). У зеркального листа (противоположный фасад)
    координаты отражаются (x -> -x): сведение с прямым листом дальше
    идёт в одном направлении, сдвиг систем координат снимает
    `_combine_sheets`. `col_hi_pt` — правый предел поиска в pt страницы
    (только для прямого листа, см. `_band_extent`)."""
    arr, zoom = _render(doc, page_no, clip)
    frame = _frame_columns(arr)
    min_run_px = _MIN_RUN_MM * scale * zoom
    col_hi = None if col_hi_pt is None else (col_hi_pt - clip.x0) * zoom
    out = {}
    for floor, z0, z1 in bands:
        y0pt, y1pt = a * z1 + b, a * z0 + b
        ext = _band_extent(
            arr, clip.x0, zoom,
            int((y0pt - clip.y0) * zoom), int((y1pt - clip.y0) * zoom),
            frame, min_run_px, col_hi=col_hi)
        if ext and mirrored:
            ext = (-ext[1], -ext[0])
        out[floor] = ext
    return out


def _combine_sheets(e1, e2, scale):
    """Сведение двух листов одного направления (прямого и уже отражённого
    зеркального) в один набор {этаж: (лево, право)}. Системы координат
    листов различаются переносом — он оценивается медианой поэтажных
    разностей краёв (устойчиво к паре грязных этажей). Дальше по краям:
    расхождение в пределах `_CROSS_TOL_MM` — среднее (гасит ±1px
    разночтения рендера), сверх — пересечение (широкий мусор, дорисованный
    только на одном листе: козырёк, штриховая скрытая линия). Этаж, взятый
    лишь одним листом, идёт как есть."""
    diffs = [
        e1[f][i] - e2[f][i]
        for f in e1 if e1.get(f) and e2.get(f) for i in (0, 1)]
    if not diffs:
        return dict(e1) if any(e1.values()) else dict(e2)
    diffs.sort()
    t = diffs[len(diffs) // 2]
    tol = _CROSS_TOL_MM * scale
    out = {}
    for f in e1:
        v1, v2 = e1.get(f), e2.get(f)
        if v2:
            v2 = (v2[0] + t, v2[1] + t)
        if v1 and v2:
            lo = (v1[0] + v2[0]) / 2 if abs(v1[0] - v2[0]) <= tol else max(v1[0], v2[0])
            hi = (v1[1] + v2[1]) / 2 if abs(v1[1] - v2[1]) <= tol else min(v1[1], v2[1])
            out[f] = (lo, hi) if lo < hi else v1
        else:
            out[f] = v1 or v2
    return out


def _snap_edges(extents, scale):
    """Прищёлкивание краёв к отвесной прямой: значения одного края
    (лево и право порознь), различающиеся меньше `_SNAP_TOL_MM`,
    сводятся к медиане своего кластера — типовые этажи получают
    математически одинаковый габарит вместо «почти одинакового» с
    пиксельным джиттером. Кластеры строятся по цепочке соседних
    отсортированных значений; настоящие уступы (метры) в одну цепочку
    с типовым краем не попадают."""
    tol = _SNAP_TOL_MM * scale

    def snap(values):
        # values: {этаж: значение}; -> {этаж: прищёлкнутое значение}
        items = sorted(values.items(), key=lambda kv: kv[1])
        if not items:
            return {}
        groups, cur = [], [items[0]]
        for f, v in items[1:]:
            if v - cur[-1][1] <= tol:
                cur.append((f, v))
            else:
                groups.append(cur); cur = [(f, v)]
        groups.append(cur)
        out = {}
        for g in groups:
            med = sorted(v for _, v in g)[len(g) // 2]
            for f, _ in g:
                out[f] = med
        return out

    lo = snap({f: v[0] for f, v in extents.items() if v})
    hi = snap({f: v[1] for f, v in extents.items() if v})
    return {f: ((lo[f], hi[f]) if v else None) for f, v in extents.items()}


def compute_facade_blocks(doc) -> dict:
    """Возвращает {этаж: {"С01": (x0,x1,y0,y1) | None, "С02": (...) | None}}
    в мм, в САМОСТОЯТЕЛЬНОЙ системе координат (не привязана к системе
    координат Revit/детального PDF-импорта того же объекта — этот режим
    не предполагает их совместной загрузки на одном объекте). Подземный
    этаж пропущен — на фасаде его нет (наземная часть от «+0,000»)."""
    calib = _vertical_calibration(doc)
    if calib is None:
        raise pdf_rooms.PdfRoomsError(
            "Не нашлись подписи высотных отметок на фасадных листах — "
            "упрощённый разбор по фасадам недоступен для этого комплекта.")
    a, b = calib
    scale = abs(a)  # pt/мм, изотропный чертёж (М1:200 в обоих направлениях)

    floors = [p for p in pdf_rooms.FLOOR_PLANS if p.z0 >= 0]
    bands = [
        (p.floor, p.z0,
         (p.z0 + p.z1) / 2 if p.floor in _LOWER_HALF_FLOORS else p.z1)
        for p in floors if p.floor not in _INHERIT_FLOORS]
    # По каждому направлению: замер обоих листов -> сведение (зеркальный
    # уже отражён в `_sheet_extents`) -> прищёлкивание краёв к отвесу.
    raw_x = _snap_edges(_combine_sheets(
        _sheet_extents(doc, a, b, bands, *_FACADE_X[0], scale),
        _sheet_extents(doc, a, b, bands, *_FACADE_X[1], scale), scale), scale)
    raw_y = _snap_edges(_combine_sheets(
        _sheet_extents(doc, a, b, bands, *_FACADE_Y[0], scale),
        _sheet_extents(doc, a, b, bands, *_FACADE_Y[1], scale), scale), scale)

    # типовой левый край башни (секция 2) по X — медиана среди заведомо
    # односекционных этажей (не первых/не технических — там силуэт может
    # захватывать соседнюю секцию по высоте, см. докстрока модуля).
    tower_candidates = sorted(
        raw_x[p.floor][0] for p in floors
        if p.section_codes == ("С02",) and raw_x.get(p.floor) and p.floor.isdigit()
        and 10 < int(p.floor) < 24)
    if not tower_candidates:
        raise pdf_rooms.PdfRoomsError(
            "Не нашлось ни одного типового этажа секции 2 для калибровки границы "
            "секций по фасаду.")
    tower_x0 = tower_candidates[len(tower_candidates) // 2]

    # Повторный замер одно-секционных ярусов секции 1 (выход на кровлю)
    # В ПРЕДЕЛАХ своей стороны от границы секций: в их высотной полосе
    # стоит и башня секции 2, без предела extent дотягивался до неё, а
    # обрезка результата границей секций (`min(x1, tower_x0)`) растягивала
    # маленький объём до самой башни. Замер по прямому листу — предел в
    # его системе координат, зеркальному его не передать без лишней
    # машинерии (сдвиг систем живёт внутри `_combine_sheets`), а листы
    # для этих ярусов расходились лишь на ±1px.
    solo_c01 = [bd for bd in bands
                if next(p for p in floors if p.floor == bd[0]).section_codes == ("С01",)]
    if solo_c01:
        limited = _sheet_extents(
            doc, a, b, solo_c01, *_FACADE_X[0], scale, col_hi_pt=tower_x0)
        for floor, ext in limited.items():
            raw_x[floor] = ext

    # Общий якорь по каждому направлению — самая левая точка среди ВСЕХ
    # полос: относительные мм-координаты от него, не только ширина/
    # глубина сами по себе — иначе секции/этажи легли бы друг на друга
    # в одной точке (0,0) вместо реального взаимного положения по X/Y.
    x_anchor = min(v[0] for v in raw_x.values() if v)
    y_anchor = min(v[0] for v in raw_y.values() if v)

    def to_mm_x(pt):
        return (pt - x_anchor) / scale

    def to_mm_y(pt):
        return (pt - y_anchor) / scale

    min_width_pt = _MIN_RUN_MM * scale
    result = {plan.floor: {} for plan in floors}
    # Ярус без собственного замера наследует габарит ближайшего НИЖНЕГО
    # яруса той же секции: сюда попадают `_INHERIT_FLOORS` (техэтаж
    # секции 1 — стены по контуру, но собственная полоса размыта, см.
    # комментарий у константы) и любой ярус, у которого после фильтра
    # мелочи пусто либо диапазон схлопнулся при обрезке границей секций.
    # Отсюда обход этажей по z, а не в порядке `FLOOR_PLANS`.
    last_by_section = {}
    for plan in sorted(floors, key=lambda p: p.z0):
        x = raw_x.get(plan.floor)
        y = raw_y.get(plan.floor)
        c01_x = c02_x = None
        if x:
            if set(plan.section_codes) >= {"С01", "С02"}:
                c01_x, c02_x = (x[0], tower_x0), (tower_x0, x[1])
            elif plan.section_codes == ("С01",):
                c01_x = (x[0], min(x[1], tower_x0))
            elif plan.section_codes == ("С02",):
                c02_x = (max(x[0], tower_x0), x[1])
        for code, xr in (("С01", c01_x), ("С02", c02_x)):
            if code not in plan.section_codes:
                continue
            box = None
            if xr is not None and y is not None and xr[1] - xr[0] >= min_width_pt:
                box = (to_mm_x(xr[0]), to_mm_x(xr[1]), to_mm_y(y[0]), to_mm_y(y[1]))
            if box is None:
                box = last_by_section.get(code)
            if box is None:
                continue
            result[plan.floor][code] = box
            last_by_section[code] = box
    return result


def _plan_rooms_canonical(doc, page_no: int, grid: dict) -> list:
    """Помещения листа (1-based номер, как в `pdf_rooms._SPEC`) в ОБЩЕЙ сетке
    осей объекта: [(секция, контур_мм)]. Поправка листа (`_page_shift_
    correction`) выравнивает нетиповые листы по подписям осей; остаток
    (лист, где помещений мало и «верхний правый угол застройки» — не угол
    здания: лист 16 с одной надстройкой на весь план кровли) снимается
    медианой разностей координат ОБЩИХ подписей осей листа и канонической
    сетки — на листе 16 это ровно (15030, 7630) по всем 45 подписям."""
    page = doc[page_no - 1]
    correction = pdf_rooms._page_shift_correction(page, grid)
    rooms, _warnings = pdf_rooms.parse_page(page, correction)
    labels = pdf_rooms.page_axis_labels(page, correction)
    shifts = {}
    for axis in ("x", "y"):
        diffs = sorted(
            labels[k][1] - grid[k][1]
            for k in labels if k in grid and grid[k][0] == axis == labels[k][0])
        shifts[axis] = diffs[len(diffs) // 2] if diffs else 0.0
    return [(r.section, [(x - shifts["x"], y - shifts["y"]) for x, y in r.polygon_mm])
            for r in rooms]


def _bbox(polys: list):
    pts = [p for poly in polys for p in poly]
    if not pts:
        return None
    return (min(p[0] for p in pts), max(p[0] for p in pts),
            min(p[1] for p in pts), max(p[1] for p in pts))


def _basement_boxes(rooms: list, boundary_x) -> dict:
    """Подземный этаж — ТРИ соседние непересекающиеся области (по плану
    листа 3, прямое уточнение пользователя 2026-09-02): подвальная часть
    секции 1, подвальная часть секции 2 и паркинг — правая верхняя часть
    этажа. Габариты помещений сами по себе пересекаются: коридор подвала
    тянется под обеими секциями (bbox помещений С02 заходит под С01 на
    11м), контур паркинга — «клубок» на 989 м² поверх всего этажа. Поэтому:
    - шов секций — граница осей (та же, что у детального разбора);
    - верх основного контура здания — верхняя грань помещений С02;
    - С01/С02 — помещения секции в пределах основного контура, обрезанные
      швом; помещения С01 ВЫШЕ контура (пандус въезда, тамбуры у него —
      x −56..−41м, y до +4,2м) относятся к паркингу, он к ним примыкает;
    - паркинг — всё, что от контура паркинга и этих помещений осталось
      вне двух подвальных областей секций (`shapely.difference`), с
      обрезкой снизу верхом контура здания.
    Возвращает {секция: (x0,x1,y0,y1)} в общей сетке осей, без запаса на
    стены — общие грани должны совпасть точно, см. `_snap_shared_edges`."""
    by_sec = {}
    for sec, poly in rooms:
        if sec:
            by_sec.setdefault(sec, []).append(poly)
    c02 = by_sec.get("С02") or []
    c01 = by_sec.get("С01") or []
    if not c02 or not c01 or boundary_x is None:
        return {}
    top = _bbox(c02)[3]
    main_c01 = [p for p in c01 if max(y for _, y in p) <= top + _BASEMENT_TOP_TOL_MM]
    above_c01 = [p for p in c01 if p not in main_c01]
    b02 = _bbox(c02)
    b01 = _bbox(main_c01) if main_c01 else _bbox(c01)
    box_c02 = (max(b02[0], boundary_x), b02[1], b02[2], top)
    box_c01 = (b01[0], min(b01[1], boundary_x), b01[2], top)
    out = {"С01": box_c01, "С02": box_c02}

    parking_polys = (by_sec.get(_PARKING_SECTION) or []) + above_c01
    if parking_polys:
        def _polygons(g):
            if g.geom_type == "Polygon":
                return [g]
            return [q for sub in getattr(g, "geoms", []) for q in _polygons(sub)]
        parts = [q for poly in parking_polys for q in _polygons(make_valid(Polygon(poly)))
                 if q.area > 0]
        region = unary_union(parts)
        for bx in (box_c01, box_c02):
            region = region.difference(box(bx[0], bx[2], bx[1], bx[3]))
        if not region.is_empty:
            x0, y0, x1, y1 = region.bounds
            out[_PARKING_SECTION] = (x0, x1, max(y0, top), y1)
    # Рампа (2026-09-02, схема пользователя: четвёртый блок подземного
    # этажа) — полоса въезда между левым краем секции 1 и «языком» паркинга
    # (помещениями С01 над контуром), от верха контура здания до верха
    # этих помещений: на листе 3 это проезд между осями 1с1–4с1 и Ес1–Ба,
    # без заливки слоя помещений — как помещение не читается, только по
    # соседям.
    if above_c01 and _PARKING_SECTION in out:
        tongue = _bbox(above_c01)
        if tongue[0] > box_c01[0] + 1000:
            out[_RAMP_SECTION] = (box_c01[0], tongue[0], top, tongue[3])
    return out


def _snap_shared_edges(box_m, sec: str, basement: dict):
    """Запас на стену (`_ROOM_WALL_MARGIN_MM`) уже добавлен со всех сторон
    — на ОБЩИХ гранях трёх областей подвала он дал бы нахлёст в 500мм;
    общие грани возвращаются точно: шов секций (x) у С01/С02 и верх
    контура здания (y) у всех трёх."""
    top = basement["С02"][3]
    seam = basement["С02"][0]
    x0, x1, y0, y1 = box_m
    if sec == "С01":
        return (x0, seam, y0, top)
    if sec == "С02":
        return (seam, x1, y0, top)
    if sec == _RAMP_SECTION and _PARKING_SECTION in basement:
        # общая грань с паркингом справа — его левый край с тем же запасом
        return (x0, basement[_PARKING_SECTION][0] - _ROOM_WALL_MARGIN_MM, top, y1)
    return (x0, x1, top, y1)


def compute_plan_blocks(doc, facade_blocks: dict) -> dict:
    """Ярусы по ПЛАНУ (см. `_PLAN_*`) и перевод ВСЕГО макета в общую сетку
    осей объекта. Возвращает {"blocks": {этаж: {секция: (x0,x1,y0,y1)}},
    "grid": {подпись: (направление, координата)}, "shift": (tx, ty)} —
    блоки в общей сетке осей (той же, что у детального разбора и у
    `object_grids`), либо `{}`, если типовой этаж башни не нашёлся ни на
    плане, ни по фасаду — тогда переносу не по чему калиброваться, и
    макет остаётся в собственной системе координат фасада, без осей.

    Почему макет переводится в сетку осей, а не оси в макет (2026-09-02,
    живой запрос пользователя — «оси только в одном углу»): у объекта с
    детальным разбором оси и элементы уже лежат в сетке, и блоки в своей
    системе (сдвиг ≈ 69,5м по X, 16,8м по Y) не сходились с ними — в охват
    блоков попадал случайный угол сетки. Одна система на всё."""
    tower_f = (facade_blocks.get(_PLAN_TYPICAL_FLOOR) or {}).get(_PLAN_ROOF2_SECTION)
    if not tower_f:
        return {}
    grid = pdf_rooms.extract_axis_grid(doc)
    typical = _plan_rooms_canonical(doc, _PLAN_TYPICAL_PAGE, grid)
    tower_c = _bbox([poly for sec, poly in typical if sec == _PLAN_ROOF2_SECTION])
    if not tower_c:
        return {}
    tx = (tower_f[0] + tower_f[1]) / 2 - (tower_c[0] + tower_c[1]) / 2
    ty = (tower_f[2] + tower_f[3]) / 2 - (tower_c[2] + tower_c[3]) / 2
    m = _ROOM_WALL_MARGIN_MM

    def with_margin(box):
        return (box[0] - m, box[1] + m, box[2] - m, box[3] + m)

    out = {}
    basement = _basement_boxes(
        _plan_rooms_canonical(doc, _PLAN_BASEMENT_PAGE, grid),
        pdf_rooms._page_section_boundary_mm(doc[_PLAN_TYPICAL_PAGE - 1], (0.0, 0.0)))
    if basement:
        out[_PLAN_BASEMENT_FLOOR] = {
            sec: _snap_shared_edges(with_margin(box), sec, basement)
            for sec, box in basement.items()}
    roof = _bbox([poly for sec, poly in _plan_rooms_canonical(doc, _PLAN_ROOF2_PAGE, grid)
                  if sec == _PLAN_ROOF2_SECTION])
    if roof:
        out[_PLAN_ROOF2_FLOOR] = {_PLAN_ROOF2_SECTION: with_margin(roof)}
    return {"blocks": out, "grid": grid, "shift": (tx, ty)}


def _grid_lines(grid: dict, blocks: dict) -> list:
    """Оси для `object_grids` из подписей осей чертежа: положение — из
    подписи, пролёт — габарит блоков СВОЕЙ секции по всем ярусам (тот же
    приём, что у детального разбора, `pdf_import._apply_axis_grid`, только
    там пролёт — охват помещений). [(подпись, направление, x1,y1,x2,y2)]."""
    extent = {}
    for sections in blocks.values():
        for code, (x0, x1, y0, y1) in sections.items():
            e = extent.get(code)
            extent[code] = ((min(e[0], x0), max(e[1], x1), min(e[2], y0), max(e[3], y1))
                            if e else (x0, x1, y0, y1))
    lines = []
    for label, (direction, coord) in grid.items():
        match = pdf_rooms._AXIS_RE.match(label)
        if not match:
            continue
        e = extent.get("С0" + match.group(2))
        if e is None:
            continue
        if direction == "x":
            lines.append((label, "x", coord, e[2], coord, e[3]))
        else:
            lines.append((label, "y", e[0], coord, e[1], coord))
    return lines


def analyze(conn, object_id: int, data: bytes, filename: str = None) -> dict:
    """Фаза 1: разбор фасадов и подсчёт габаритов. В БД не пишет ничего.
    Синхронный (секунды, не десятки секунд детального разбора) — фонового
    потока/прогресса не нужно, см. докстрока `_PENDING`."""
    doc = pdf_rooms.load(data)
    facade = compute_facade_blocks(doc)
    aligned = compute_plan_blocks(doc, facade)
    grids = []
    if aligned:
        # Макет — в общую сетку осей (см. докстроку `compute_plan_blocks`).
        tx, ty = aligned["shift"]
        facade = {
            floor: {code: (x0 - tx, x1 - tx, y0 - ty, y1 - ty)
                    for code, (x0, x1, y0, y1) in sections.items()}
            for floor, sections in facade.items()}
    plan = aligned.get("blocks", {}) if aligned else {}
    # Порядок — снизу вверх: подвал, этажи по фасаду, выход на кровлю.
    blocks = {}
    if _PLAN_BASEMENT_FLOOR in plan:
        blocks[_PLAN_BASEMENT_FLOOR] = plan[_PLAN_BASEMENT_FLOOR]
    blocks.update(facade)
    if _PLAN_ROOF2_FLOOR in plan:
        blocks[_PLAN_ROOF2_FLOOR] = plan[_PLAN_ROOF2_FLOOR]
    if aligned:
        grids = _grid_lines(aligned["grid"], blocks)

    row = conn.execute("SELECT name FROM objects WHERE id = ?", (object_id,)).fetchone()
    object_name = row["name"] if row else ""

    by_floor = {}
    total_blocks = 0
    for floor, sections in blocks.items():
        by_floor[floor] = {
            code: {"ширина_мм": round(x1 - x0), "глубина_мм": round(y1 - y0)}
            for code, (x0, x1, y0, y1) in sections.items()
        }
        total_blocks += len(sections)

    return {
        "object_id": object_id,
        "object_name": object_name,
        "total_blocks": total_blocks,
        "total_floors": len(blocks),
        "by_floor": by_floor,
        "axes": len(grids),
        "_blocks": blocks,
        "_grids": grids,
        "filename": filename,
    }


def apply(conn, object_id: int, analysis: dict) -> dict:
    """Фаза 2: заводит секции/этажи и блоки с готовой (прямой) геометрией.
    НЕ пишет `revit_elements` — этот режим их не производит вовсе, «начинка»
    блока (стены/окна/помещения) здесь не появляется, только его габарит.
    Секции/этажи — тем же путём, что и детальный разбор (`pdf_import.
    _ensure_section`/`_ensure_level` — переиспользованы, не продублированы:
    один и тот же справочник `object_levels`/`object_sections` на объект,
    какой бы режим загрузки его ни заполнил)."""
    blocks = analysis["_blocks"]
    section_codes = sorted({code for sections in blocks.values() for code in sections})
    section_ids = {code: pdf_import._ensure_section(conn, object_id, code) for code in section_codes}

    written = 0
    for floor, sections in blocks.items():
        level_id, _key = pdf_import._ensure_level(conn, object_id, floor)
        for code, (x0, x1, y0, y1) in sections.items():
            block = blocks_mod.create_block(conn, object_id, section_ids[code], level_id)
            conn.execute(
                "UPDATE blocks SET x0 = ?, x1 = ?, y0 = ?, y1 = ? WHERE id = ?",
                (x0, x1, y0, y1, block["id"]))
            written += 1
    # Оси здания (`object_grids`) — слой «Оси» «Модели МФР»: те же подписи
    # осей чертежа, что и у детального разбора, в той же общей сетке
    # (2026-09-02, живой запрос пользователя — «оси только в одном углу»);
    # тот же upsert по подписи, что у `pdf_import._apply_axis_grid`.
    for label, kind, x1, y1, x2, y2 in analysis.get("_grids") or []:
        conn.execute(
            "INSERT INTO object_grids (object_id, label, kind, x1, y1, x2, y2) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT (object_id, label) DO UPDATE SET "
            "kind=excluded.kind, x1=excluded.x1, y1=excluded.y1, "
            "x2=excluded.x2, y2=excluded.y2",
            (object_id, label, kind, x1, y1, x2, y2))
    conn.commit()
    return {"blocks_written": written, "sections": len(section_ids), "floors": len(blocks),
            "axes": len(analysis.get("_grids") or [])}


def remember_pending(analysis: dict) -> str:
    token = uuid.uuid4().hex
    _PENDING[token] = analysis
    while len(_PENDING) > _PENDING_LIMIT:
        _PENDING.pop(next(iter(_PENDING)))
    return token


def get_pending(token: str) -> dict:
    analysis = _PENDING.get(token)
    if analysis is None:
        raise PdfFacadeImportError(
            410, "Результат разбора уже недоступен (сервер перезапускался или "
            "разбор устарел). Загрузите файл заново.")
    return analysis


def forget_pending(token: str) -> None:
    _PENDING.pop(token, None)
