"""
Отчёт «График работ по блокам» (`report_block_schedule`, этап 5 задания
«Запланированная работа по блоку», Docs/block-works-schedule-task.md §8).

Источник строк — `app/block_works.py::list_block_works`: одна ЗР (операция,
поставленная в план конкретного блока) на строку, уже с производными
(процент, статус, отклонение, признак сроков). Группировка — порядок
уровней выбирается на экране (тот же орган `createGroupChooser`, что у
«Графика поставки», см. app/report_delivery.py): Трек / Раздел WBS /
Операция / Секция / Этаж, в любом порядке и не обязательно все сразу.

Вид «Гант» (`view="gantt"`) — те же строки и та же группировка, только на
экране и в XLSX вместо чисел рисуется полоса плана и полоса прогноза;
неделя-сетка в XLSX — тем же приёмом, что у app/schedule_gantt_export.py
(график СМР ЖБИ). PDF вида «Гант» НЕ реализован (см. примечание в
build_block_schedule_pdf) — canvas-диаграмма ганта для ЖБИ калибровалась
под фиксированные 4 уровня группировки; здесь их до 5 и порядок произволен,
а редактируемый PDF не тот случай, где стоит гнаться за полным
соответствием экрану с первой версии. PDF отдаёт ту же таблицу, что вид
«таблица» — с явной пометкой в подписи файла.
"""

from typing import Optional

from app import block_works as _block_works
from app.reports import natural_key, pdf_text

# ---------------------------------------------------------------- группировка

GROUPS = [
    {"key": "track", "label": "Трек"},
    {"key": "wbs_section", "label": "Раздел WBS"},
    {"key": "operation", "label": "Операция"},
    {"key": "section", "label": "Секция"},
    {"key": "floor", "label": "Этаж"},
]
GROUP_KEYS = [g["key"] for g in GROUPS]
GROUP_LABELS = {g["key"]: g["label"] for g in GROUPS}
DEFAULT_GROUPS = ["track", "wbs_section", "operation", "section", "floor"]

NO_TRACK = "Без трека"
NO_SECTION = "Секция не определена"
NO_FLOOR = "Этаж не определён"

# Признак сроков, который считается «отстаёт» для сводки по группе (§8:
# «число отстающих») — три тревожных из пяти; «без сроков» не в счёт, у
# него отставать нечему сравнить.
_ОТСТАЮЩИЕ_ПРИЗНАКИ = {_block_works.DEADLINE_BEHIND, _block_works.DEADLINE_OVERDUE,
                       _block_works.DEADLINE_NOT_STARTED}


def _normalize_groups(group_by: Optional[list]) -> list:
    if not group_by:
        return list(DEFAULT_GROUPS)
    seen = []
    for key in group_by:
        if key in GROUP_KEYS and key not in seen:
            seen.append(key)
    return seen or list(DEFAULT_GROUPS)


def _label_and_key(key: str, row: dict, track_names: dict):
    if key == "track":
        code = row.get("track_code")
        return (track_names.get(code, code) if code else NO_TRACK), code
    if key == "wbs_section":
        путь = row.get("путь") or ""
        части = путь.split(" / ")
        родитель = " / ".join(части[:-1]) if len(части) > 1 else "—"
        return родитель, родитель
    if key == "operation":
        return row.get("название") or "(без названия)", row.get("work_type_id")
    if key == "section":
        return row.get("section_code") or NO_SECTION, row.get("section_code")
    if key == "floor":
        floor = row.get("level_floor")
        return (f"{floor} этаж" if floor is not None else NO_FLOOR), floor
    return "—", None


def _new_node(label, level, gkey=None) -> dict:
    return {"label": label, "level": level, "gkey": gkey, "children": {}, "rows": []}


def _aggregate(node: dict, all_rows: list) -> dict:
    """Итоги по группе (§8): доля выполненных, среднее отклонение (по
    окончанию — та же величина, что и признак «отстаёт»/«просрочена»),
    число отстающих. Считается по ВСЕМ строкам поддерева (собственные rows
    узла плюс rows всех потомков — те уже посчитаны рекурсивно ниже)."""
    total = len(all_rows)
    done = sum(1 for r in all_rows if r["percent"] >= 100)
    deviations = [r["deviation_end"] for r in all_rows if r["deviation_end"] is not None]
    behind = sum(1 for r in all_rows if r["deadline"] in _ОТСТАЮЩИЕ_ПРИЗНАКИ)
    return {
        "всего": total,
        "выполнено": done,
        "доля_выполненных": round(100 * done / total) if total else None,
        "среднее_отклонение": round(sum(deviations) / len(deviations), 1) if deviations else None,
        "отстают": behind,
    }


def _finish(node: dict) -> tuple:
    """Возвращает (список детей узла — рекурсивно достроенных и
    отсортированных, список ВСЕХ строк поддерева — для агрегата родителя)."""
    all_rows = list(node["rows"])
    children = []
    for child in sorted(node["children"].values(), key=lambda n: natural_key(n["label"])):
        child_children, child_rows = _finish(child)
        child["children"] = child_children
        child["agg"] = _aggregate(child, child_rows)
        all_rows.extend(child_rows)
        children.append(child)
    return children, all_rows


def build_block_schedule_report(conn, object_id: int, today: str, *,
                                group_by: Optional[list] = None,
                                block_ids: Optional[list] = None,
                                track_code: Optional[str] = None,
                                status: Optional[list] = None,
                                deadline: Optional[list] = None,
                                view: Optional[str] = None) -> dict:
    groups = _normalize_groups(group_by)
    view = view if view in ("table", "gantt") else "table"
    rows = _block_works.list_block_works(
        conn, object_id, today, block_ids=block_ids, track_code=track_code,
        status=status, deadline=deadline)

    track_names = {t["код"]: t["название"] for t in _work_fact_all_tracks(conn, object_id)}
    responsible = _responsible_names(conn, [r["id"] for r in rows])
    for r in rows:
        r["ответственный"] = responsible.get(r["id"])

    root = _new_node("", -1)
    for row in rows:
        node = root
        for depth, key in enumerate(groups):
            label, gkey = _label_and_key(key, row, track_names)
            node = node["children"].setdefault(label, _new_node(label, depth, gkey))
        node["rows"].append(row)
    children, all_rows = _finish(root)
    total_agg = _aggregate(root, all_rows)

    return {
        "title": "График работ по блокам",
        "object_id": object_id,
        "group_by": groups,
        "group_labels": [GROUP_LABELS[k] for k in groups],
        "view": view,
        "rows": children,
        "total": total_agg,
        "elements": len(rows),
        "today": today,
    }


def _work_fact_all_tracks(conn, object_id: int) -> list:
    from app import work_fact
    return work_fact.all_planning_tracks(conn, object_id)


def _responsible_names(conn, bw_ids: list) -> dict:
    """«Ответственный» столбца отчёта — кто последним правил ЗР
    (block_works.updated_by): своего поля «ответственный» у ЗР нет (решение
    пользователя, этап 2) — это то же приближение, что уже принято в
    карточке ЗР."""
    if not bw_ids:
        return {}
    placeholders = ",".join("?" for _ in bw_ids)
    rows = conn.execute(
        f"SELECT bw.id, u.last_name, u.first_name FROM block_works bw "
        f"LEFT JOIN users u ON u.id = bw.updated_by WHERE bw.id IN ({placeholders})",
        bw_ids,
    ).fetchall()
    return {
        r["id"]: " ".join(p for p in (r["last_name"], r["first_name"]) if p) or None
        for r in rows
    }


# ---------------------------------------------------------------- плоский список (экспорт)

def flatten(report: dict) -> list:
    out = []

    def walk(nodes, depth):
        for n in nodes:
            out.append({"kind": "group", "depth": depth, "node": n})
            for r in n["rows"]:
                out.append({"kind": "row", "depth": depth + 1, "row": r})
            walk(n["children"], depth + 1)

    walk(report["rows"], 0)
    return out


# ---------------------------------------------------------------- XLSX

_XLSX_COLUMNS = [
    ("Операция / группа", 46), ("План начало", 12), ("План окончание", 12),
    ("Прогноз начало", 12), ("Прогноз окончание", 12), ("Процент", 9),
    ("Отклонение, дн", 12), ("Признак сроков", 18), ("Ответственный", 20),
]


def build_block_schedule_xlsx(report: dict, object_name: str) -> bytes:
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    from app.element_fields import EXCEL_DATE_FORMAT, to_excel_date

    wb = Workbook()
    ws = wb.active
    ws.title = "График работ по блокам"
    ws.append([object_name])
    ws.cell(row=1, column=1).font = Font(bold=True, size=13)
    ws.append([f"Группировка: {' → '.join(report['group_labels'])}" +
              (" · вид «Гант» — в XLSX те же данные таблицей, полосы см. ниже" if report["view"] == "gantt" else "")])
    ws.append([])
    header_row = 4
    ws.append([c for c, _ in _XLSX_COLUMNS])
    for i, (_, width) in enumerate(_XLSX_COLUMNS, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width
        ws.cell(row=header_row, column=i).font = Font(bold=True)
    ws.freeze_panes = f"A{header_row + 1}"
    ws.sheet_properties.outlinePr.summaryBelow = False

    date_cols = {2, 3, 4, 5}
    строка = header_row
    for item in flatten(report):
        строка += 1
        if item["kind"] == "group":
            n, depth = item["node"], item["depth"]
            agg = n["agg"]
            сводка = (f"{n['label']} — всего {agg['всего']}, выполнено {agg['выполнено']}"
                     f" ({agg['доля_выполненных']}%)"
                     + (f", среднее отклонение {agg['среднее_отклонение']:+g} дн" if agg['среднее_отклонение'] is not None else "")
                     + f", отстают {agg['отстают']}")
            ws.append([сводка])
            ws.cell(row=строка, column=1).font = Font(bold=True)
            ws.row_dimensions[строка].outline_level = depth
        else:
            r = item["row"]
            ws.append([
                r["название"], to_excel_date(r["plan_start"]), to_excel_date(r["plan_end"]),
                to_excel_date(r["forecast_start"]), to_excel_date(r["forecast_end"]),
                r["percent"], r["deviation_end"], r["deadline_label"], r["ответственный"] or "",
            ])
            for col in date_cols:
                ws.cell(row=строка, column=col).number_format = EXCEL_DATE_FORMAT
            ws.row_dimensions[строка].outline_level = item["depth"]

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- PDF

def build_block_schedule_pdf(report: dict, object_name: str) -> bytes:
    """Таблица (не диаграмма) — тем же приёмом, что build_completion_report_pdf
    (Platypus Table, а не рисование по канве): у вида «Гант» PDF пока нет,
    см. docstring модуля."""
    from io import BytesIO

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from app.element_fields import ru_date_text
    from app.pdf_export import FONT_BOLD, FONT_REGULAR

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=10 * mm, rightMargin=10 * mm, topMargin=10 * mm, bottomMargin=10 * mm,
        title=report["title"],
    )
    title_style = ParagraphStyle("t", fontName=FONT_BOLD, fontSize=14, leading=18)
    sub_style = ParagraphStyle("s", fontName=FONT_REGULAR, fontSize=9, leading=12,
                               textColor=colors.HexColor("#666666"))
    group_style = ParagraphStyle("g", fontName=FONT_BOLD, fontSize=7.5, leading=10)
    cell_style = ParagraphStyle("c", fontName=FONT_REGULAR, fontSize=7, leading=9)

    story = [Paragraph(pdf_text(f"{report['title']} — {object_name}"), title_style),
            Paragraph(pdf_text(f"Группировка: {' → '.join(report['group_labels'])}" +
                               (" · вид «Гант» в файле показан таблицей" if report["view"] == "gantt" else "")),
                      sub_style),
            Spacer(1, 4 * mm)]

    headers = ["Операция / группа", "План", "Прогноз", "%", "Откл., дн", "Признак", "Ответственный"]
    data = [[Paragraph(pdf_text(h), group_style) for h in headers]]
    span_commands = []
    for item in flatten(report):
        row_i = len(data)
        if item["kind"] == "group":
            n, agg = item["node"], item["node"]["agg"]
            текст = (f"{n['label']} — всего {agg['всего']}, выполнено {agg['доля_выполненных'] or 0}%, "
                    f"отстают {agg['отстают']}")
            data.append([Paragraph(pdf_text(текст), group_style), "", "", "", "", "", ""])
            span_commands.append(("SPAN", (0, row_i), (-1, row_i)))
            span_commands.append(("BACKGROUND", (0, row_i), (-1, row_i), colors.HexColor("#EFEFEF")))
        else:
            r = item["row"]
            план = f"{ru_date_text(r['plan_start']) or '—'} – {ru_date_text(r['plan_end']) or '—'}"
            прогноз = f"{ru_date_text(r['forecast_start']) or '—'} – {ru_date_text(r['forecast_end']) or '—'}"
            откл = "" if r["deviation_end"] is None else f"{r['deviation_end']:+d}"
            отступ = "&nbsp;" * (4 * item["depth"])
            data.append([
                Paragraph(отступ + pdf_text(r["название"] or ""), cell_style),
                Paragraph(pdf_text(план), cell_style), Paragraph(pdf_text(прогноз), cell_style),
                Paragraph(pdf_text(str(r["percent"])), cell_style), Paragraph(pdf_text(откл), cell_style),
                Paragraph(pdf_text(r["deadline_label"]), cell_style),
                Paragraph(pdf_text(r["ответственный"] or ""), cell_style),
            ])

    table = Table(data, colWidths=[85 * mm, 38 * mm, 38 * mm, 12 * mm, 18 * mm, 28 * mm, 30 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCCCCC")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDDDDD")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        *span_commands,
    ]))
    story.append(table)
    doc.build(story)
    return buf.getvalue()
