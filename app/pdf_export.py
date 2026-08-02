"""
Экспорт схемы в PDF-отчёт (Docs/backlog.md, второй раунд, п.13). Шаблон
согласован с заказчиком:
  - шапка: логотип + "Статус по <чертёж>" + дата отчёта (статусы элементов
    считаются актуальными НА эту дату — тот же принцип, что у режима
    "снимок на дату" в XLS-экспорте, см. app/export.py::build_snapshot_xlsx);
  - схема — весь чертёж целиком (авто-fit), альбомная ориентация, подписи
    марок показаны, легенда цветов статусов отдельным блоком;
  - подпись/футер: автоподпись системы + блок для ручной подписи
    (Составил/Проверил/Утвердил).
"""

import io
from pathlib import Path
from typing import Optional

from reportlab.lib.colors import HexColor, black, grey
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF

from app.models import STATUS_LABELS_RU

LOGO_PATH = Path(__file__).resolve().parent / "static" / "logo.svg"
FONTS_DIR = Path(__file__).resolve().parent / "fonts"

# Стандартные PDF-шрифты (Helvetica и т.п.) не содержат кириллицу — вместо
# них регистрируем DejaVu Sans (шрифт зашит в репозиторий, лицензия
# разрешает распространение, см. app/fonts/DEJAVU_LICENSE.txt), иначе все
# русские подписи в отчёте превращаются в чёрные прямоугольники.
FONT_REGULAR = "DejaVuSans"
FONT_BOLD = "DejaVuSans-Bold"
FONT_OBLIQUE = "DejaVuSans-Oblique"

pdfmetrics.registerFont(TTFont(FONT_REGULAR, str(FONTS_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont(FONT_BOLD, str(FONTS_DIR / "DejaVuSans-Bold.ttf")))
pdfmetrics.registerFont(TTFont(FONT_OBLIQUE, str(FONTS_DIR / "DejaVuSans-Oblique.ttf")))

PAGE_W, PAGE_H = landscape(A3)
MARGIN = 36
HEADER_H = 54
LEGEND_H = 26
SIGNATURE_H = 78
FOOTER_TEXT_H = 14

MAX_MARKER_PT = 5.0
MAX_FONT_PT = 7.0


def _fetch_status_as_of(conn, element_id, date):
    if date:
        row = conn.execute(
            "SELECT status FROM status_history WHERE element_id = ? AND changed_at <= ? "
            "ORDER BY changed_at DESC LIMIT 1",
            (element_id, f"{date} 23:59:59"),
        ).fetchone()
        return row["status"] if row else None
    return None  # используем current_status у самого элемента


def _estimate_marker_radius(points):
    n = len(points)
    if n < 2:
        return 1.0
    nearest = []
    for i, (xi, yi) in enumerate(points):
        best = None
        for j, (xj, yj) in enumerate(points):
            if i == j:
                continue
            d2 = (xi - xj) ** 2 + (yi - yj) ** 2
            if best is None or d2 < best:
                best = d2
        if best is not None and best > 0:
            nearest.append(best ** 0.5)
    if not nearest:
        return 1.0
    nearest.sort()
    return nearest[len(nearest) // 2] * 0.25


def build_schema_pdf(conn, source_file: str, date, generated_by: str,
                     object_id: Optional[int] = None) -> bytes:
    elements = [dict(r) for r in conn.execute(
        "SELECT * FROM elements WHERE source_file = ? ORDER BY id", (source_file,)
    ).fetchall()]
    if not elements:
        raise ValueError(f"Нет элементов для source_file={source_file!r}")

    for el in elements:
        status = _fetch_status_as_of(conn, el["id"], date) if date else el["current_status"]
        el["_report_status"] = status  # None -> элемента ещё не существовало на эту дату

    axis_rows = conn.execute(
        "SELECT kind, label, coord FROM axis_lines WHERE source_file = ?", (source_file,)
    ).fetchall()
    numeric_axes = {r["label"]: r["coord"] for r in axis_rows if r["kind"] == "numeric"}
    letter_axes = {r["label"]: r["coord"] for r in axis_rows if r["kind"] == "letter"}

    colors = {
        r["status"]: r["color"] for r in conn.execute("SELECT status, color FROM status_colors").fetchall()
    }
    # Видимость подписей — настройка ОБЪЕКТА (этап D). Без объекта берётся
    # пустой словарь: `.get(type, True)` ниже трактует это как «показывать
    # все марки» — прежнее поведение файла без настроек.
    label_visibility = {
        r["element_type"]: bool(r["visible"])
        for r in conn.execute(
            "SELECT element_type, visible FROM label_visibility WHERE object_id = ?",
            (object_id,),
        ).fetchall()
    }

    # ---- bbox (авто-fit): элементы + сетка осей с запасом под подписи осей ----
    xs = [e["x"] for e in elements]
    ys = [e["y"] for e in elements]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    if numeric_axes and letter_axes:
        num_vals = list(numeric_axes.values())
        let_vals = list(letter_axes.values())
        margin = max(max(num_vals) - min(num_vals), max(let_vals) - min(let_vals)) * 0.03
        extra = margin * 2.8
        min_x = min(min_x, min(num_vals) - extra)
        max_x = max(max_x, max(num_vals) + extra)
        min_y = min(min_y, min(let_vals) - extra)
        max_y = max(max_y, max(let_vals) + extra)

    pad_x = (max_x - min_x) * 0.04 or 1.0
    pad_y = (max_y - min_y) * 0.04 or 1.0
    min_x -= pad_x; max_x += pad_x
    min_y -= pad_y; max_y += pad_y

    # ---- области страницы ----
    draw_x0 = MARGIN
    draw_x1 = PAGE_W - MARGIN
    draw_y1 = PAGE_H - MARGIN - HEADER_H
    draw_y0 = MARGIN + SIGNATURE_H + FOOTER_TEXT_H + LEGEND_H
    draw_w = draw_x1 - draw_x0
    draw_h = draw_y1 - draw_y0

    scale = min(draw_w / (max_x - min_x), draw_h / (max_y - min_y))

    def to_page(x, y):
        px = draw_x0 + (x - min_x) * scale + (draw_w - (max_x - min_x) * scale) / 2
        py = draw_y0 + (y - min_y) * scale + (draw_h - (max_y - min_y) * scale) / 2
        return px, py

    world_points = [(e["x"], e["y"]) for e in elements]
    base_r_world = _estimate_marker_radius(world_points)
    marker_r = min(base_r_world * scale, MAX_MARKER_PT)
    marker_r = max(marker_r, 1.0)
    font_size = min(marker_r * 1.3, MAX_FONT_PT)
    font_size = max(font_size, 3.5)

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))

    _draw_header(c, source_file, date)
    _draw_axis_grid(c, numeric_axes, letter_axes, to_page)
    _draw_elements(c, elements, colors, label_visibility, to_page, marker_r, font_size)
    _draw_legend(c, colors)
    _draw_footer(c, generated_by)

    c.showPage()
    c.save()
    return buf.getvalue()


def _draw_header(c, source_file, date):
    top = PAGE_H - MARGIN
    if LOGO_PATH.exists():
        drawing = svg2rlg(str(LOGO_PATH))
        renderPDF.draw(drawing, c, MARGIN, top - drawing.height)
        text_x = MARGIN + drawing.width + 16
    else:
        text_x = MARGIN

    c.setFont(FONT_BOLD, 15)
    c.setFillColor(black)
    date_label = date if date else "текущий момент"
    c.drawString(text_x, top - 20, f"Статус по {source_file}")
    c.setFont(FONT_REGULAR, 10)
    c.setFillColor(grey)
    c.drawString(text_x, top - 36, f"Дата отчёта: {date_label}")


def _draw_axis_grid(c, numeric_axes, letter_axes, to_page):
    if not numeric_axes or not letter_axes:
        return
    c.setStrokeColor(HexColor("#c4c4c4"))
    c.setFillColor(HexColor("#9a9a9a"))
    c.setLineWidth(0.4)
    c.setFont(FONT_REGULAR, 7)

    num_vals = list(numeric_axes.values())
    let_vals = list(letter_axes.values())
    y_min_w, y_max_w = min(let_vals), max(let_vals)
    x_min_w, x_max_w = min(num_vals), max(num_vals)

    for label, x in numeric_axes.items():
        p0 = to_page(x, y_min_w)
        p1 = to_page(x, y_max_w)
        c.line(p0[0], p0[1], p1[0], p1[1])
        c.drawCentredString(p0[0], p0[1] - 10, label)
        c.drawCentredString(p1[0], p1[1] + 4, label)

    for label, y in letter_axes.items():
        p0 = to_page(x_min_w, y)
        p1 = to_page(x_max_w, y)
        c.line(p0[0], p0[1], p1[0], p1[1])
        c.drawRightString(p0[0] - 6, p0[1] - 2.5, label)


def _draw_elements(c, elements, colors, label_visibility, to_page, marker_r, font_size):
    c.setFont(FONT_REGULAR, font_size)
    for el in elements:
        px, py = to_page(el["x"], el["y"])
        status = el["_report_status"]
        if status is None:
            fill = HexColor("#e0e0e0")
        else:
            fill = HexColor(colors.get(status, "#999999"))
        c.setFillColor(fill)
        c.setStrokeColor(black)
        c.setLineWidth(0.5)
        c.circle(px, py, marker_r, stroke=1, fill=1)

        if el["mark"] and label_visibility.get(el["element_type"], True):
            c.setFillColor(HexColor("#333333"))
            c.drawString(px + marker_r * 1.3, py - font_size * 0.35, el["mark"])


def _draw_legend(c, colors):
    y = MARGIN + SIGNATURE_H + FOOTER_TEXT_H + 4
    x = MARGIN
    c.setFont(FONT_REGULAR, 8)
    for status, label in STATUS_LABELS_RU.items():
        color = colors.get(status.value, "#999999")
        c.setFillColor(HexColor(color))
        c.circle(x + 4, y + 4, 4, stroke=0, fill=1)
        c.setFillColor(black)
        c.drawString(x + 12, y, label)
        x += 16 + len(label) * 4.6 + 18


def _draw_footer(c, generated_by):
    from datetime import datetime

    y = MARGIN + SIGNATURE_H
    c.setFont(FONT_OBLIQUE, 7)
    c.setFillColor(grey)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    c.drawString(MARGIN, y, f"Сформировано автоматически системой ЖБИ, {ts} ({generated_by})")

    rows = ["Составил", "Проверил", "Утвердил"]
    col_w = (PAGE_W - 2 * MARGIN) / len(rows)
    base_y = MARGIN + SIGNATURE_H - 24
    c.setFont(FONT_REGULAR, 9)
    c.setFillColor(black)
    for i, role in enumerate(rows):
        x = MARGIN + i * col_w
        c.drawString(x, base_y, f"{role}: ______________________")
        c.setFont(FONT_REGULAR, 8)
        c.setFillColor(grey)
        c.drawString(x + 12, base_y - 14, "(подпись, ФИО)")
        c.drawString(x, base_y - 32, "Дата: ______________________")
        c.setFont(FONT_REGULAR, 9)
        c.setFillColor(black)
