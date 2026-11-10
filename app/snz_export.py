"""Server-side СНЗ exports using the application's existing XLSX/PDF stack."""
import json
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from app.snz_policy import order_items


def build_registry_xlsx(report, day):
    """A frozen daily register; quantities count physical items within each order."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    ws = wb.active
    ws.title = "Реестр СНЗ"
    ws.append([f"Реестр выданных СНЗ за {day.strftime('%d.%m.%Y')}"])
    ws.merge_cells("A1:J1")
    ws.append(["Дата относится к началу смены. Ночь: 20:00 выбранной даты — 08:00 следующего дня."])
    ws.merge_cells("A2:J2")
    ws.append([])
    ws.append(["№ СНЗ", "Дата", "Смена", "Начало", "Окончание", "Бригада", "Прораб", "Количество шт", "Выдал", "Редакция"])
    for row in report["orders"]:
        ws.append([row["id"], datetime.fromisoformat(row["work_date"]), "День" if row["shift"] == "day" else "Ночь",
                   datetime.fromisoformat(row["start"]), datetime.fromisoformat(row["end"]), row["crew_name"],
                   row["foreman"] or "Не назначен", row["quantity"], row["created_by"], row["order_revision"]])
    end = ws.max_row
    if report["orders"]:
        table = Table(displayName="SNZDailyRegister", ref=f"A4:J{end}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        ws.add_table(table)
    else:
        ws.append(["За выбранную дату СНЗ не выдавались."])
        ws.merge_cells(start_row=5, start_column=1, end_row=5, end_column=10)
    ws.append([])
    ws.append(["Итого по документам, шт", None, None, None, None, None, None, report["registry_total"]["quantity"]])
    ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=7)
    ws.append(["Уникальных изделий, шт", None, None, None, None, None, None, report["registry_total"]["unique_quantity"]])
    ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=7)
    ws.append(["Перенос одного изделия между сменами учитывается в каждом СНЗ; уникальные изделия — один раз за день."])
    ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=10)
    for row in ws:
        ws.row_dimensions[row[0].row].height = 36
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
            cell.font = Font(name="Calibri", size=11)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
    for cell in ws[4]:
        cell.fill = PatternFill("solid", fgColor="17365D")
        cell.font = Font(name="Calibri", size=11, color="FFFFFF", bold=True)
    ws["A1"].font = Font(name="Calibri", size=16, bold=True, color="17365D")
    for row in ws.iter_rows(min_row=5, max_row=end):
        row[1].number_format = "dd.mm.yyyy"
        row[3].number_format = row[4].number_format = "dd.mm.yyyy hh:mm"
        row[7].number_format = "#,##0"
    for i, width in enumerate([9, 15, 11, 23, 23, 37, 29, 17, 29, 12], 1):
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "D5"
    ws.sheet_view.showGridLines = False
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:4"
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def build_xlsx(order):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "СНЗ"
    crew = order["crew"]
    ws.append([f"Сменное наряд-задание · {order['object_name']}" + (f" · редакция {order['order_revision']}" if order.get("order_revision", 1) > 1 else "")])
    ws.append([f"{order['date']} · {'День' if order['shift'] == 'day' else 'Ночь'} · {crew['name']} · Прораб: {crew['foreman'] or 'не назначен'}"])
    ws.merge_cells("A1:N1")
    ws.merge_cells("A2:N2")
    headers = ["№", "Операция", "Звено", "Узел", "ID изделий", "Марки", "Этажи", "Адреса", "Начало", "Окончание", "Минут в интервале", "Норматив, мин", "Остаток после смены, мин", "Перенос"]
    ws.append(headers)
    for index, task in enumerate(order["tasks"], 1):
        for seg in task["segments"] or [{"start": None, "end": None, "minutes": 0}]:
            es = task["elements"]
            ws.append([index, task["operation"], task["team"], task.get("group_name") or "",
                       ", ".join(str(e["id"]) for e in es), ", ".join(e.get("mark") or "—" for e in es),
                       ", ".join(str(f) for f in dict.fromkeys(e.get("floor") for e in es)),
                       "; ".join(dict.fromkeys(e.get("address") or "—" for e in es)),
                       datetime.fromisoformat(seg["start"]) if seg["start"] else None, datetime.fromisoformat(seg["end"]) if seg["end"] else None, seg["minutes"],
                       task["norm_minutes"], task["remaining_after"], "Да" if task["carry"] else "Нет"])
    if len(order["tasks"]):
        table = Table(displayName="SNZOperations", ref=f"A3:N{ws.max_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        ws.add_table(table)
    ws.freeze_panes = "C4"
    for row in ws.iter_rows(min_row=4):
        row[8].number_format = row[9].number_format = "dd.mm.yyyy hh:mm"
    for col, width in enumerate([5, 31, 21, 20, 22, 27, 10, 27, 22, 22, 17, 17, 23, 12], 1):
        ws.column_dimensions[get_column_letter(col)].width = width

    items = wb.create_sheet("Изделия")
    items.append(["ID изделия", "Тип элемента", "Подтип", "Марка", "Отметка, мм", "Этаж", "Адрес по осям", "Контрагент (справочно)", "Захватка", "Кран", "Стоянка", "Бригада", "Очередность", "Смена", "Дата", "Время монтажа"])
    elements = order_items(order)
    for eid, e in sorted(elements.items()):
        install = next((t for t in order["tasks"] if t["operation_id"] == "install" and eid in t["element_ids"]), None)
        related = next((t for t in order["tasks"] if eid in t["element_ids"]), {})
        items.append([eid, e["element_type"], e.get("subtype"), e.get("mark"), e.get("elevation_mm"), e.get("floor"), e.get("address"),
                      e.get("counterparty"), e.get("zakhvatka"), e.get("crane"), e.get("stance"), crew["name"], order.get("item_priorities", related.get("priorities", {})).get(str(eid)),
                      "День" if order["shift"] == "day" else "Ночь", datetime.fromisoformat(order["date"]),
                      datetime.fromisoformat(install["segments"][0]["start"]) if install and install["segments"] else None])
    if elements:
        table = Table(displayName="SNZElements", ref=f"A1:P{items.max_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        items.add_table(table)
    items.freeze_panes = "E2"
    for i in range(1, 17):
        items.column_dimensions[get_column_letter(i)].width = 23 if i not in (5, 6, 13) else 13
    for row in items.iter_rows(min_row=2):
        row[14].number_format = "dd.mm.yyyy"
        row[15].number_format = "dd.mm.yyyy hh:mm"

    gantt = wb.create_sheet("Загрузка звеньев")
    gantt.append([f"Загрузка звеньев · {crew['name']} · {order['date']} · {order['start'][11:16]}–{order['end'][11:16]}"])
    gantt.merge_cells("A1:BU1")
    origin = datetime.fromisoformat(order["start"])
    gantt.append(["Звено"] + [origin + timedelta(minutes=10 * i) for i in range(72)])
    teams = list(dict.fromkeys(t["team"] for t in order["tasks"]))
    colors = ["2563EB", "0F766E", "7C3AED", "B45309", "BE185D"]
    for ri, team in enumerate(teams, 3):
        gantt.cell(ri, 1, team)
        gantt.row_dimensions[ri].height = 35
        for ci in range(2, 74):
            slot = origin + timedelta(minutes=(ci - 2) * 10)
            productive = any(datetime.fromisoformat(a) <= slot < datetime.fromisoformat(b) for a, b in order["windows"])
            gantt.cell(ri, ci).fill = PatternFill("solid", fgColor="F8FAFC" if productive else "E2E8F0")
        for ti, task in enumerate(order["tasks"], 1):
            if task["team"] != team:
                continue
            for seg in task["segments"]:
                a, b = datetime.fromisoformat(seg["start"]), datetime.fromisoformat(seg["end"])
                left = max(2, 2 + int((a - origin).total_seconds() // 600))
                right = min(73, 2 + int(((b - origin).total_seconds() - 1) // 600))
                for ci in range(left, right + 1):
                    gantt.cell(ri, ci).fill = PatternFill("solid", fgColor=colors[(ti - 1) % len(colors)])
                    gantt.cell(ri, ci).font = Font(color="FFFFFF", size=9)
                gantt.cell(ri, left, str(ti))
    gantt.column_dimensions["A"].width = 25
    for ci in range(2, 74):
        gantt.column_dimensions[get_column_letter(ci)].width = 4
        gantt.cell(2, ci).number_format = "hh:mm"
    for hour in range(12):
        ci = 2 + hour * 6
        gantt.merge_cells(start_row=2, start_column=ci, end_row=2, end_column=ci+5)
        gantt.cell(2, ci).alignment = Alignment(horizontal="left", vertical="center")
    gantt.freeze_panes = "B3"
    gantt.row_dimensions[2].height = 30
    gantt.cell(len(teams)+5,1,"Серым показаны развод, обед и сдача инструмента. Шкала — 10 минут; точное время каждой операции приведено на листе СНЗ.")
    gantt.merge_cells(start_row=len(teams)+5,start_column=1,end_row=len(teams)+5,end_column=73)
    gantt.sheet_properties.pageSetUpPr.fitToPage = True
    gantt.page_setup.orientation = "landscape"
    gantt.page_setup.paperSize = gantt.PAPERSIZE_A3
    gantt.page_setup.fitToWidth = 1
    gantt.page_setup.fitToHeight = 1
    if order["warnings"]:
        notes = wb.create_sheet("Предупреждения")
        notes.append(["Предупреждение"])
        for warning in order["warnings"]:
            notes.append([warning])
        notes.column_dimensions["A"].width = 120
    thin = Side(style="hair", color="D9E2EC")
    for sheet in wb:
        sheet.sheet_view.showGridLines = False
        for row in sheet:
            for cell in row:
                # Model marks and editable names are text, never Excel formulas.
                if isinstance(cell.value, str):
                    cell.data_type = "s"
                if sheet != gantt:
                    cell.font = Font(name="Calibri", size=11)
                    cell.alignment = Alignment(vertical="center", wrap_text=True)
                    cell.border = Border(bottom=thin)
        header_row = 3 if sheet == ws else 2 if sheet == gantt else 1
        for cell in sheet[header_row]:
            cell.fill = PatternFill("solid", fgColor="17365D")
            cell.font = Font(name="Calibri", color="FFFFFF", bold=True, size=11)
        sheet.print_options.horizontalCentered = True
        sheet.page_setup.orientation = "landscape"
        sheet.sheet_properties.pageSetUpPr.fitToPage = True
        sheet.page_setup.fitToWidth = 1
        sheet.page_setup.fitToHeight = 0 if sheet != gantt else 1
        sheet.print_title_rows = f"1:{header_row}"
        if sheet != gantt:
            import math
            for rn in range(header_row, sheet.max_row + 1):
                lines = max((math.ceil(len(str(cell.value or "")) / max(8, sheet.column_dimensions[cell.column_letter].width - 2)) for cell in sheet[rn]), default=1)
                sheet.row_dimensions[rn].height = max(28, 16 * lines + 8)
    ws["A1"].font = Font(name="Calibri", size=14, bold=True)
    ws.row_dimensions[1].height = 27
    ws.row_dimensions[2].height = 24
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def _points(e):
    try:
        points = json.loads(e.get("outline_json") or "[]")
        if len(points) >= 3:
            return [(float(p[0]), float(p[1])) for p in points]
    except (ValueError, TypeError, IndexError, KeyError):
        pass
    x, y = float(e["x"]), float(e["y"])
    return [(x - 150, y - 150), (x + 150, y - 150), (x + 150, y + 150), (x - 150, y + 150)]


def build_pdf(order, context, axes):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.lib.colors import HexColor

    fonts = Path(__file__).parent / "fonts"
    for name, filename in (("SNZ", "DejaVuSans.ttf"), ("SNZ-Bold", "DejaVuSans-Bold.ttf")):
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(fonts / filename)))
    output = BytesIO()
    w, h = landscape(A3)
    pdf = canvas.Canvas(output, pagesize=(w, h))
    pdf.setTitle("СНЗ — поэтажные планы")
    selected = order_items(order)
    if not selected:
        pdf.setFont("SNZ-Bold", 18)
        pdf.drawString(35, h - 45, "СНЗ без работ после исправления состава")
        pdf.setFont("SNZ", 11)
        pdf.drawString(35, h - 70, f"{order['date']} · {'День' if order['shift'] == 'day' else 'Ночь'} · редакция {order.get('order_revision', 1)}")
        pdf.drawString(35, h - 92, "Исходный состав сохранён в истории редакций СНЗ.")
        pdf.showPage()
    floors = sorted({e.get("floor") for e in selected.values()}, key=lambda f: (f is None, f or 0))
    for page, floor in enumerate(floors, 1):
        active = {eid: e for eid, e in selected.items() if e.get("floor") == floor}
        sources = {e["source_file"] for e in active.values()}
        backdrop = [e for e in context if e.get("floor") == floor and e["source_file"] in sources]
        # Issued elements survive subsequent model changes in their saved geometry.
        visible = {e["id"]: e for e in backdrop}
        visible.update(active)
        points = [p for e in visible.values() for p in _points(e)]
        xmin, xmax = min(p[0] for p in points), max(p[0] for p in points)
        ymin, ymax = min(p[1] for p in points), max(p[1] for p in points)
        xmin -= 1000; xmax += 1000; ymin -= 1000; ymax += 1000
        left, bottom, width, height = 65, 65, w - 130, h - 155
        scale = min(width / max(1, xmax - xmin), height / max(1, ymax - ymin))
        ox = left + (width - (xmax - xmin) * scale) / 2
        oy = bottom + (height - (ymax - ymin) * scale) / 2
        def xy(x, y):
            return ox + (x - xmin) * scale, oy + (y - ymin) * scale
        title = f"СНЗ · {order['object_name']} · Этаж {floor if floor is not None else 'не задан'}" + (f" · ред. {order['order_revision']}" if order.get("order_revision", 1) > 1 else "")
        title_size = 15
        while pdf.stringWidth(title, "SNZ-Bold", title_size) > w - 70 and title_size > 8:
            title_size -= .5
        pdf.setFont("SNZ-Bold", title_size)
        pdf.drawString(35, h - 32, title)
        pdf.setFont("SNZ", 10)
        pdf.drawString(35, h - 51, f"{order['date']} · {'Дневная' if order['shift'] == 'day' else 'Ночная'} смена · {order['crew']['name']} · Прораб: {order['crew']['foreman'] or 'не назначен'}")
        pdf.setStrokeColor(HexColor("#CBD5E1")); pdf.setLineWidth(.5)
        for axis in axes:
            if axis["source_file"] not in sources:
                continue
            coord = axis["coord"]
            if axis["kind"] == "numeric" and xmin <= coord <= xmax:
                x, _ = xy(coord, ymin)
                pdf.line(x, bottom, x, bottom + height)
                tx, ty = x, bottom - 15
            elif axis["kind"] == "letter" and ymin <= coord <= ymax:
                _, y = xy(xmin, coord)
                pdf.line(left, y, left + width, y)
                tx, ty = left - 18, y
            else:
                continue
            pdf.setFillColor(HexColor("#FFFFFF")); pdf.circle(tx, ty, 11, fill=1, stroke=1)
            pdf.setFillColor(HexColor("#334155")); pdf.setFont("SNZ", 8)
            pdf.drawCentredString(tx, ty - 3, axis["label"])
        for eid, e in visible.items():
            pdf.saveState()
            is_active = eid in active
            pdf.setFillColor(HexColor("#2563EB" if is_active else "#64748B"))
            pdf.setStrokeColor(HexColor("#1D4ED8" if is_active else "#94A3B8"))
            pdf.setFillAlpha(.65 if is_active else .10)
            pdf.setStrokeAlpha(1 if is_active else .15)
            path = pdf.beginPath()
            for i, p in enumerate(_points(e)):
                x, y = xy(*p)
                if i == 0: path.moveTo(x, y)
                else: path.lineTo(x, y)
            path.close()
            pdf.drawPath(path, fill=1, stroke=1)
            pdf.restoreState()
        placed = []
        for eid, e in sorted(active.items()):
            task = next((t for t in order["tasks"] if eid in t["element_ids"]), {})
            priority = order.get("item_priorities", task.get("priorities", {})).get(str(eid))
            label = f"{priority if priority is not None else '—'} · {e.get('mark') or eid}"
            font_size = 8
            text_w = pdfmetrics.stringWidth(label, "SNZ-Bold", font_size) + 8
            x, y = xy(e["x"], e["y"])
            lx, ly = min(max(left, x + 10), w - text_w - 35), min(max(bottom, y + 8), h - 88)
            for _ in range(80):
                if not any(lx < bx + bw and lx + text_w > bx and ly < by + 14 and ly + 14 > by for bx, by, bw in placed):
                    break
                ly += 15
                if ly > h - 88:
                    ly = bottom; lx = max(left, lx - text_w - 10)
            placed.append((lx, ly, text_w))
            pdf.setStrokeColor(HexColor("#475569")); pdf.setLineWidth(.5)
            pdf.line(x, y, lx, ly + 6)
            pdf.setFillColor(HexColor("#FFFFFF")); pdf.rect(lx, ly, text_w, 14, fill=1, stroke=0)
            pdf.setFillColor(HexColor("#0F172A")); pdf.setFont("SNZ-Bold", font_size)
            pdf.drawString(lx + 4, ly + 4, label)
        pdf.setFont("SNZ", 8); pdf.setFillColor(HexColor("#475569"))
        pdf.drawString(35, 22, "Синим — изделия СНЗ; окружение показано полупрозрачным. Подпись: очередность · марка изделия.")
        pdf.drawRightString(w - 35, 22, f"Лист {page} из {len(floors)}")
        pdf.showPage()
    pdf.save()
    return output.getvalue()
