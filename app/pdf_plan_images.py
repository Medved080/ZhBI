"""
Картинки планов этажей из PDF — растр листа, обрезанный по контуру
здания на этом этаже (2026-09-02, живой запрос пользователя: «добавь
сохранение в базе изображения схемы этажа из PDF, обрезай по контуру
здания на каждом из этажей, включать/выключать — лежат на полу этажа»).

Контур — тот же, что у плиты перекрытия (`pdf_rooms.Slab.polygon_mm`,
объединение помещений и стен этажа): всё, что на листе вне здания —
оси, размерные линии, соседняя секция «для информации», врезки,
экспликация — не попадает, снаружи контура картинка прозрачная (PNG с
альфа-каналом). Одна картинка на этаж, даже если этаж делит лист с
другим (листы 10-11: техпространство секции 1 и этаж 9 секции 2 — у
каждого свой контур, своя обрезка).

Перевод «мм общей сетки осей → точка страницы» — обратный к тому, что
делает `pdf_rooms.parse_page` (масштаб листа, сдвиг по верхнему правому
углу застройки, поправка нетипового листа): картинка ложится ровно на
элементы того же этажа. Разрешение — не больше `MAX_WIDTH_PX` по ширине
(типовой этаж ~70м → ~34 px/м, планы читаемы при разумном зуме, а PNG
на этаж — сотни КБ, не мегабайты; 28 этажей ≈ 10-15 МБ в базе).
"""

import io

import fitz
from PIL import Image, ImageDraw
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

from app import pdf_rooms

MAX_WIDTH_PX = 2400
MAX_ZOOM = 4.0
# Запас вокруг контура, мм: наружная грань стены/парапет чуть шире
# контура (тот же порядок, что запас на стену у блоков).
MARGIN_MM = 300
# Затяжка щелей между помещениями и стенами при сборке контура этажа, мм:
# буфер туда и обратно склеивает соседние фигуры в один контур, не
# раздувая его (толщина стены/дверной проём — до 1м; 600 с запасом).
CLOSE_GAP_MM = 600


def _polygons(g) -> list:
    if g.geom_type == "Polygon":
        return [g]
    return [q for sub in getattr(g, "geoms", []) for q in _polygons(sub)]


def floor_contour(polys: list) -> list:
    """Контур здания на этаже — объединение ВСЕХ фигур этажа (помещения +
    стены/перегородки/окна) с затяжкой щелей `CLOSE_GAP_MM`. НЕ плита
    перекрытия из модели: та на этажах выше первого — только коридор
    (`_floor_slab_polygon` теряет остальное, известная неточность
    приближения), резать по ней нельзя. Возвращает список shapely-полигонов
    (секции могут не касаться — тогда их два)."""
    shapes = []
    for pts in polys:
        if len(pts) < 3:
            continue
        shapes.extend(q for q in _polygons(make_valid(Polygon(pts))) if q.area > 0)
    if not shapes:
        return []
    merged = unary_union(shapes).buffer(CLOSE_GAP_MM).buffer(-CLOSE_GAP_MM)
    return [q for q in _polygons(merged) if q.area > 0]


def render_floor_images(doc, rooms: list, walls: list, canonical_grid: dict) -> list:
    """[{floor, page, x0, x1, y0, y1, width, height, png}] — по одной записи
    на этаж из `pdf_rooms.FLOOR_PLANS`, у которого есть хоть одна фигура.
    x0..y1 — фактический охват картинки в мм общей сетки (обрезка
    страницей учтена); маска — по `floor_contour` того же этажа."""
    by_floor = {}
    for r in rooms:
        by_floor.setdefault(r.floor, []).append(r.polygon_mm)
    for w in walls:
        by_floor.setdefault(w.floor, []).append(w.polygon_mm)

    out = []
    page_cache = {}
    for plan in pdf_rooms.FLOOR_PLANS:
        contours = floor_contour(by_floor.get(plan.floor) or [])
        if not contours:
            continue
        page = doc[plan.page - 1]
        if plan.page not in page_cache:
            scale = pdf_rooms._page_scale(page)
            correction = pdf_rooms._page_shift_correction(page, canonical_grid)
            _polys, (sx, sy) = pdf_rooms._room_polygons(page, scale, correction)
            page_cache[plan.page] = (scale, sx, sy)
        scale, sx, sy = page_cache[plan.page]
        H = page.rect.height
        k = pdf_rooms.PT_TO_MM * scale

        def to_pt(x, y):
            return (x + sx) / k, H - (y + sy) / k

        bx0 = min(c.bounds[0] for c in contours) - MARGIN_MM
        by0 = min(c.bounds[1] for c in contours) - MARGIN_MM
        bx1 = max(c.bounds[2] for c in contours) + MARGIN_MM
        by1 = max(c.bounds[3] for c in contours) + MARGIN_MM
        px0, py1 = to_pt(bx0, by0)
        px1, py0 = to_pt(bx1, by1)
        clip = fitz.Rect(px0, py0, px1, py1) & page.rect
        if clip.is_empty or clip.width < 1 or clip.height < 1:
            continue
        zoom = max(1.0, min(MAX_ZOOM, MAX_WIDTH_PX / clip.width))
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        mask = Image.new("L", img.size, 0)
        draw = ImageDraw.Draw(mask)
        for c in contours:
            # с тем же запасом, что и охват: наружная грань стены
            outer = c.buffer(MARGIN_MM)
            for q in _polygons(outer):
                pts = [((px - clip.x0) * zoom, (py - clip.y0) * zoom)
                       for px, py in (to_pt(x, y) for x, y in q.exterior.coords)]
                draw.polygon(pts, fill=255)
        img.putalpha(mask)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        out.append({
            "floor": plan.floor, "page": plan.page,
            "x0": clip.x0 * k - sx, "x1": clip.x1 * k - sx,
            "y0": (H - clip.y1) * k - sy, "y1": (H - clip.y0) * k - sy,
            "width": pix.width, "height": pix.height, "png": buf.getvalue(),
        })
    return out
