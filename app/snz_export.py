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
    if 'snapshots' in report:
        from app.snz_daily_export import add_daily_details
        add_daily_details(wb, report['snapshots'], day)
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def build_xlsx(order, *, daily_details=False):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
    from openpyxl.worksheet.table import Table, TableStyleInfo
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    crew = order["crew"]
    ws = None
    if daily_details:
        ws = wb.active
        ws.title = "СНЗ"
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

    else:
        wb.remove(wb.active)

    items = wb.create_sheet("Изделия")
    item_headers = ["ID изделия", "Тип элемента", "Подтип", "Марка", "Отметка, мм", "Этаж", "Адрес по осям", "Контрагент (справочно)", "Захватка", "Кран", "Стоянка", "Бригада", "Очередность", "Смена", "Дата", "Время монтажа", "Перенос с"]
    columns = list(range(17)) if daily_details else [1, 3, 4, 5, 6, 11, 12, 15, 16]
    items.append([item_headers[i] for i in columns])
    elements = order_items(order)
    for eid, e in sorted(elements.items()):
        install = next((t for t in order["tasks"] if t["operation_id"] == "install" and eid in t["element_ids"]), None)
        related = next((t for t in order["tasks"] if eid in t["element_ids"]), {})
        values = [eid, e["element_type"], e.get("subtype"), e.get("mark"), e.get("elevation_mm"), e.get("floor"), e.get("address"),
                      e.get("counterparty"), e.get("zakhvatka"), e.get("crane"), e.get("stance"), crew["name"], order.get("item_priorities", related.get("priorities", {})).get(str(eid)),
                      "День" if order["shift"] == "day" else "Ночь", datetime.fromisoformat(order["date"]),
                      datetime.fromisoformat(install["segments"][0]["start"]) if install and install["segments"] else None, e.get("transfer_from")]
        items.append([values[i] for i in columns])
    if elements:
        table = Table(displayName="SNZElements", ref=f"A1:{get_column_letter(len(columns))}{items.max_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        items.add_table(table)
    items.freeze_panes = "E2" if daily_details else "C2"
    for i, original in enumerate(columns, 1):
        items.column_dimensions[get_column_letter(i)].width = 13 if original in (4, 5, 12) else 23
    if not daily_details:
        items.column_dimensions['C'].width = 16
        items.column_dimensions['G'].width = 17
    for row in items.iter_rows(min_row=2):
        if daily_details: row[columns.index(14)].number_format = "dd.mm.yyyy"
        row[columns.index(15)].number_format = "dd.mm.yyyy hh:mm"

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
    gantt.cell(len(teams)+5,1,"Серым показаны развод, обед и сдача инструмента. Шкала — 10 минут; " + ("точное время каждой операции приведено на листе СНЗ." if daily_details else "точное время монтажа приведено на листе «Изделия»."))
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
    if ws is not None:
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


def build_pdf(order, context, axes, zones=(), status_colors=None, floor_levels=()):
    from app.snz_plans import build_floor_plans
    return build_floor_plans(order, context, axes, zones, status_colors, floor_levels)
