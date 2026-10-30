"""Замечания разбора PDF с точной геометрией и просмотром исходного листа.

Изображение создаётся по запросу из временного результата разбора, в БД
ничего не записывается. Координаты фигур сохраняются до их отбрасывания.
"""
import math

import fitz


class PdfWarning(str):
    """Строка для прежних клиентов + координаты для графического комментария."""

    def __new__(cls, message, *, page=None, floor=None, polygons_mm=None):
        value = super().__new__(cls, message)
        value.page = page
        value.floor = floor
        value.polygons_mm = polygons_mm or []
        return value

    @classmethod
    def context(cls, warning, page, floor):
        return cls(f"Лист {page} (этаж {floor}): {warning}", page=page, floor=floor,
                   polygons_mm=getattr(warning, 'polygons_mm', []))


def describe(warnings, page_count):
    """Метаданные без геометрии: сама геометрия остаётся на сервере."""
    return [dict(index=i, message=str(w), page=getattr(w, 'page', None),
                 floor=getattr(w, 'floor', None),
                 figures=len(getattr(w, 'polygons_mm', [])),
                 pages=[w.page] if getattr(w, 'page', None) else list(range(1, page_count + 1)))
            for i, w in enumerate(warnings)]


def render(analysis, index, *, overview=False, page_number=None):
    """PNG: красные контуры/номера на исходном чертеже, фрагмент или весь лист."""
    from app import pdf_rooms

    warning = analysis['warnings'][index]
    number = getattr(warning, 'page', None) or page_number or 1
    with fitz.open(stream=analysis['_source_pdf'], filetype='pdf') as doc:
        if not 1 <= number <= len(doc):
            raise ValueError('Лист вне комплекта')
        page = doc[number - 1]
        polygons = getattr(warning, 'polygons_mm', [])
        points = []
        if polygons:
            correction = pdf_rooms._page_shift_correction(page, analysis['_axis_grid'])
            scale = pdf_rooms._page_scale(page)
            _, (sx, sy) = pdf_rooms._room_polygons(page, scale, correction)
            k = pdf_rooms.PT_TO_MM * scale
            for i, polygon in enumerate(polygons, 1):
                pts = [fitz.Point((x + sx) / k, page.rect.height - (y + sy) / k)
                       for x, y in polygon if math.isfinite(x) and math.isfinite(y)]
                if len(pts) < 3:
                    continue
                page.draw_polyline(pts, closePath=True, color=(.9, 0, 0),
                                   fill=(1, .15, .1), fill_opacity=.2, width=1.5, overlay=True)
                center = fitz.Point(sum(p.x for p in pts) / len(pts),
                                    sum(p.y for p in pts) / len(pts))
                page.draw_circle(center, 7, color=(.9, 0, 0), fill=(1, 1, 1), overlay=True)
                page.insert_text((center.x - 4, center.y + 3), str(i), fontsize=9,
                                 color=(.8, 0, 0), overlay=True)
                points.extend(pts)
        clip = page.rect
        if points and not overview:
            bounds = fitz.Rect(min(p.x for p in points), min(p.y for p in points),
                               max(p.x for p in points), max(p.y for p in points))
            margin = max(25, max(bounds.width, bounds.height) * .08)
            focused = (bounds + (-margin, -margin, margin, margin)) & page.rect
            if not focused.is_empty:
                clip = focused
        zoom = min(4, 2400 / max(clip.width, clip.height))
        return page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip).tobytes('png')
