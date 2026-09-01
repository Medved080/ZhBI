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

Известное упрощение первой версии (не решалось — не совпадает с целью
«этажи не пустые»): ширина ВКЛЮЧАЕТ балконные выступы (фасад рисует
видимый силуэт здания, а не грань несущей стены) — на 5-15% шире, чем
у детального разбора `pdf_rooms`, это ожидаемо для макета, не брак.
Глубина (Y) не делится на секции — для граней «А-В»/«Б-А» видимого
разделения секций 1/2 нет (секция 1 не выступает на эту грань), общая
глубина отдаётся ОБЕИМ секциям этажа.
"""

import re
import uuid

import fitz
import numpy as np

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


# (страница PDF, 0-based, клип-прямоугольник в pt) — по одному месту на
# направление; «1-4» и «А-В» достаточно (обе стороны здания видны на них
# полностью для этого объекта), «4-1»/«Б-А» не используются — первая
# версия, см. докстрока модуля.
_FACADE_X = (20, fitz.Rect(50, 150, 1330, 1400))    # «1-4» — ширина по X
_FACADE_Y = (20, fitz.Rect(1350, 150, 1790, 1400))  # «А-В» — глубина по Y
_CALIBRATION_PAGES = (20, 21)


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


def _band_extent(arr, clip_x0, zoom, row0, row1, frame_cols, density=0.3, thresh=250):
    """Левый/правый край непустого содержимого (силуэт здания) в полосе
    [row0,row1) пикселей — «непустое» по плотности закрашенных строк
    внутри полосы (`density`), не по единственному пикселю: тонкие
    выносные линии подписей отметок так отсеиваются (они пересекают
    полосу лишь местами), а собственно стена/окно — плотная заливка на
    всю высоту своего этажа."""
    row0 = max(0, row0); row1 = min(arr.shape[0], row1)
    if row1 <= row0:
        return None
    strip = arr[row0:row1, :, :3]
    non_white = np.any(strip < thresh, axis=2)
    frac = non_white.mean(axis=0).copy()
    frac[frame_cols] = 0
    cols = np.where(frac >= density)[0]
    if len(cols) == 0:
        return None
    return clip_x0 + cols.min() / zoom, clip_x0 + cols.max() / zoom


def _render(doc, page_no, clip, zoom=3):
    page = doc[page_no]
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    return arr, zoom


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

    def y_of(mm):
        return a * mm + b

    arr_x, zoom_x = _render(doc, *_FACADE_X)
    frame_x = _frame_columns(arr_x)
    arr_y, zoom_y = _render(doc, *_FACADE_Y)
    frame_y = _frame_columns(arr_y)

    floors = [p for p in pdf_rooms.FLOOR_PLANS if p.z0 >= 0]
    raw_x, raw_y = {}, {}
    for plan in floors:
        y0pt, y1pt = y_of(plan.z1), y_of(plan.z0)
        raw_x[plan.floor] = _band_extent(
            arr_x, _FACADE_X[1].x0, zoom_x,
            int((y0pt - _FACADE_X[1].y0) * zoom_x), int((y1pt - _FACADE_X[1].y0) * zoom_x), frame_x)
        raw_y[plan.floor] = _band_extent(
            arr_y, _FACADE_Y[1].x0, zoom_y,
            int((y0pt - _FACADE_Y[1].y0) * zoom_y), int((y1pt - _FACADE_Y[1].y0) * zoom_y), frame_y)

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

    scale = abs(a)  # pt/мм, изотропный чертёж (М1:200 в обоих направлениях)
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

    result = {}
    for plan in floors:
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
        row = {}
        for code, xr in (("С01", c01_x), ("С02", c02_x)):
            if xr is None or y is None or code not in plan.section_codes:
                continue
            row[code] = (to_mm_x(xr[0]), to_mm_x(xr[1]), to_mm_y(y[0]), to_mm_y(y[1]))
        result[plan.floor] = row
    return result


def analyze(conn, object_id: int, data: bytes, filename: str = None) -> dict:
    """Фаза 1: разбор фасадов и подсчёт габаритов. В БД не пишет ничего.
    Синхронный (секунды, не десятки секунд детального разбора) — фонового
    потока/прогресса не нужно, см. докстрока `_PENDING`."""
    doc = pdf_rooms.load(data)
    blocks = compute_facade_blocks(doc)

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
        "_blocks": blocks,
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
    conn.commit()
    return {"blocks_written": written, "sections": len(section_ids), "floors": len(blocks)}


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
