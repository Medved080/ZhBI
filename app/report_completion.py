"""
Отчёт «Статус комплектации» (живой запрос 2026-08-03, по образцу заказчика
«Статус комплектации.xlsx»).

Смысл: ПЛОСКИЙ перечень «что, где и по какому контракту» — строка на
уникальное сочетание «кран · стоянка · тип · подтип · марка · контракт ·
три даты», в строке количество таких изделий. Это не сводка по статусам
(для неё есть «Статусы») и не календарь (для него «График поставки»), а
рабочий список комплектации, который заказчик до сих пор собирал руками:
по нему видно, чем закрыта конкретная стоянка конкретного крана и на
какие даты по ней есть план, факт и потребность.

Дерева здесь нет НАМЕРЕННО: образец — плоская таблица, которую в Excel
крутят сводными и фильтрами, а любая наша группировка этому мешала бы
(колонка со склеенным заголовком в сводную таблицу не входит). По той же
причине реквизиты контракта разложены на три колонки — «Завод»,
«Договор», «Спецификация», — а не склеены в имя контракта; формат каждого
документа общий с интерфейсом и XLS-экспортом (`build_document_label`).

Три даты — те же три независимые шкалы, что и в «Графике поставки»
(см. app/report_delivery.py):
  Плановая дата поставки    — `planned_delivery_date` (контракт/логистика);
  Фактическая дата поставки — `actual_delivery_date` (переход в «Доставлено»);
  Требуемая дата поставки   — `project_smr_start_date`, дата начала СМР:
      к ней изделие обязано быть на площадке, из неё и раскладывается
      потребность. Не `project_delivery_date` — та означает ЗАВЕРШЕНИЕ СМР
      (см. app/schedule_import.py) и к поставке отношения не имеет.

Кран и стоянка выводятся НОМЕРОМ (`zones.number`), как в образце, а не
именем: имя формата «Стоянка 03» менялось между версиями чертежа, а по
номеру в Excel сортируют и фильтруют. Имя остаётся запасным вариантом на
случай зоны без номера.

Данные, как и у остальных отчётов, считает СЕРВЕР — экран, XLSX и PDF
берут результат одной и той же функции и разойтись не могут.
"""

from typing import Optional

from app.contracts import build_document_label
from app.db import visible_elements_clause
from app.reports import natural_key, pdf_text

TITLE = "Статус комплектации"

# Колонки — ровно те и в том порядке, что в образце заказчика. kind
# определяет и выравнивание на экране, и формат ячейки в Excel:
# «date» кладётся НАСТОЯЩЕЙ датой с числовым форматом, а не текстом.
COLUMNS = [
    {"key": "crane", "label": "Кран", "kind": "num"},
    {"key": "stance", "label": "Стоянка", "kind": "num"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
    {"key": "subtype", "label": "Подтип", "kind": "text"},
    {"key": "mark", "label": "Маркировка изделий", "kind": "text"},
    {"key": "count", "label": "Кол-во", "kind": "num"},
    {"key": "counterparty", "label": "Завод", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "plan_date", "label": "Плановая дата поставки", "kind": "date"},
    {"key": "fact_date", "label": "Фактическая дата поставки", "kind": "date"},
    {"key": "need_date", "label": "Требуемая дата поставки", "kind": "date"},
]

TOTAL_LABEL = "Итого"

# Порядок сортировки строк. Дата сортируется как ISO-текст — тот же приём,
# что в истории статусов (см. CLAUDE.md): формат хранения одинаковый, и
# разбирать её в объект ради сравнения незачем.
SORT_KEYS = ["crane", "stance", "element_type", "subtype", "mark",
             "counterparty", "agreement", "specification",
             "plan_date", "fact_date", "need_date"]


def _sort_key(value):
    """Пусто — всегда в конец, остальное «по-человечески» (Стоянка 2 раньше
    Стоянки 10, см. natural_key). Номера зон приходят числами, марки и
    реквизиты — текстом; общий ключ приводит и то, и другое к одному виду."""
    text = "" if value is None else str(value)
    return (1, []) if not text else (0, natural_key(text))


def build_completion_report(conn, source_file: Optional[str],
                            element_ids: Optional[list] = None) -> dict:
    """element_ids — необязательное сужение до конкретных элементов (тот же
    приём, что у остальных отчётов и XLS-экспорта: фильтры схемы живут на
    клиенте, сервер получает готовый список id).

    Для ЭТОГО отчёта сужение — основной режим работы: галочка «Учитывать
    текущий фильтр схемы» у него включена по умолчанию (живой запрос),
    потому что перечень комплектации читают по конкретной захватке или
    стоянке, а не по всей стройке разом."""
    clauses, params = [visible_elements_clause("e")], []
    if source_file:
        clauses.append("e.source_file = ?")
        params.append(source_file)
    if element_ids is not None:
        if not element_ids:
            clauses.append("1=0")
        else:
            clauses.append(f"e.id IN ({','.join('?' * len(element_ids))})")
            params.extend(element_ids)
    where = f"WHERE {' AND '.join(clauses)}"

    rows = conn.execute(
        f"""
        SELECT zc.number AS crane_number, zc.name AS crane_name,
               zs.number AS stance_number, zs.name AS stance_name,
               e.element_type AS element_type, e.subtype AS subtype, e.mark AS mark,
               cp.short_name AS cp_name,
               ag.number AS ag_number, ag.agreement_date AS ag_date,
               sp.number AS sp_number, sp.specification_date AS sp_date,
               e.planned_delivery_date AS plan_date,
               e.actual_delivery_date AS fact_date,
               e.project_smr_start_date AS need_date,
               COUNT(*) AS n
        FROM elements e
        LEFT JOIN zones zc ON zc.id = e.zone_crane_id
        LEFT JOIN zones zs ON zs.id = e.zone_stance_id
        LEFT JOIN contracts c ON c.id = e.contract_id
        LEFT JOIN specifications sp ON sp.id = c.specification_id
        LEFT JOIN agreements ag ON ag.id = sp.agreement_id
        LEFT JOIN counterparties cp ON cp.id = ag.counterparty_id
        {where}
        GROUP BY e.zone_crane_id, e.zone_stance_id, e.element_type, e.subtype, e.mark,
                 e.contract_id, e.planned_delivery_date, e.actual_delivery_date,
                 e.project_smr_start_date
        """,
        params,
    ).fetchall()

    def zone_value(number, name):
        # Номер — то, что в образце; имя — запасной вариант для зоны без
        # номера (такие бывают у чертежей старого формата имён слоёв).
        return number if number is not None else (name or None)

    def document(number, date_str):
        # Тот же формат «НОМЕР от ДД.ММ.ГГГГ», что в карточке контракта и в
        # XLS-экспорте: одна функция на все места (app/contracts.py).
        return build_document_label(number, date_str) if number else None

    out = [{
        "crane": zone_value(r["crane_number"], r["crane_name"]),
        "stance": zone_value(r["stance_number"], r["stance_name"]),
        "element_type": r["element_type"],
        "subtype": r["subtype"] or None,
        "mark": r["mark"] or None,
        "count": r["n"],
        "counterparty": r["cp_name"] or None,
        "agreement": document(r["ag_number"], r["ag_date"]),
        "specification": document(r["sp_number"], r["sp_date"]),
        "plan_date": r["plan_date"] or None,
        "fact_date": r["fact_date"] or None,
        "need_date": r["need_date"] or None,
    } for r in rows]
    out.sort(key=lambda row: tuple(_sort_key(row[k]) for k in SORT_KEYS))

    return {
        "title": TITLE,
        "columns": COLUMNS,
        "rows": out,
        # Итог — и число изделий, и число строк: строка здесь не изделие, а
        # их группа, и «Всего: 9422» рядом с тремя тысячами строк без второго
        # числа читалось бы как ошибка.
        "total": {"label": TOTAL_LABEL,
                  "count": sum(row["count"] for row in out),
                  "rows": len(out)},
    }


# ---------- выгрузка того же отчёта в файлы ----------
#
# Обе функции получают УЖЕ ПОСТРОЕННЫЙ отчёт, а не строят его заново —
# иначе числа на экране, в Excel и в PDF со временем разошлись бы.

def build_completion_report_xlsx(report: dict) -> bytes:
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    from app.element_fields import EXCEL_DATE_FORMAT, to_excel_date

    wb = Workbook()
    ws = wb.active
    ws.title = "Комплектация"

    thin = Side(style="thin", color="D5D8DC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill("solid", fgColor="EEF2F7")

    columns = report["columns"]
    header = [c["label"] for c in columns]
    ws.append(header)
    header_row = 1
    for i in range(1, len(header) + 1):
        cell = ws.cell(row=header_row, column=i)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.border = border
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    # Номер строки ведём СВОИМ счётчиком: `ws.max_row` в openpyxl — не
    # счётчик, а максимум по всем ячейкам листа, и обращение к нему в цикле
    # по строкам даёт квадратичный рост (см. CLAUDE.md; на выгрузке
    # реквизитов это стоило 88 секунд вместо 1,7). Строк здесь тысячи.
    row = header_row
    for data in report["rows"]:
        # Даты — НАСТОЯЩИМИ датами с числовым форматом, а не текстом: по
        # такой колонке в Excel сортируют и строят сводные (см. CLAUDE.md).
        ws.append([to_excel_date(data[c["key"]]) if c["kind"] == "date" else data[c["key"]]
                   for c in columns])
        row += 1
        for i, c in enumerate(columns, start=1):
            cell = ws.cell(row=row, column=i)
            cell.border = border
            if c["kind"] == "date":
                cell.number_format = EXCEL_DATE_FORMAT

    total = report["total"]
    # Итог — только в колонке «Кол-во»: складывать номера стоянок или даты
    # бессмысленно, а пустая ячейка в остальных колонках это и показывает.
    ws.append([total["label"]] + [""] * (len(columns) - 1))
    row += 1
    ws.cell(row=row, column=[c["key"] for c in columns].index("count") + 1).value = total["count"]
    for i in range(1, len(header) + 1):
        cell = ws.cell(row=row, column=i)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.border = border

    widths = {"crane": 8, "stance": 10, "element_type": 18, "subtype": 26,
              "mark": 20, "count": 9, "counterparty": 22, "agreement": 22,
              "specification": 22, "plan_date": 16, "fact_date": 18, "need_date": 16}
    for i, c in enumerate(columns, start=1):
        ws.column_dimensions[get_column_letter(i)].width = widths.get(c["key"], 16)
    ws.freeze_panes = ws.cell(row=header_row + 1, column=1)
    # Автофильтр по шапке: перечень комплектации в Excel именно фильтруют —
    # ради этого он и плоский.
    ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(header))}{row - 1}"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_completion_report_pdf(report: dict, subtitle: str = "") -> bytes:
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

    story = [Paragraph(pdf_text(report["title"]), title_style)]
    if subtitle:
        story.append(Paragraph(pdf_text(subtitle), sub_style))
    story.append(Spacer(1, 5 * mm))

    columns = report["columns"]
    # Длинные значения (подтип, марка, реквизиты договора) переносятся
    # внутри ячейки: без Paragraph reportlab обрезал бы их по ширине
    # колонки молча. pdf_text — обязательное экранирование пользовательского
    # текста (см. app/reports.py).
    cell_style = ParagraphStyle("c", fontName=FONT_REGULAR, fontSize=6.5, leading=8)
    head_style = ParagraphStyle("h", fontName=FONT_BOLD, fontSize=6.5, leading=8, alignment=1)

    def cell(value, kind):
        if value is None or value == "":
            return ""
        if kind == "date":
            return ru_date_text(value)
        if kind == "num":
            return str(value)
        return Paragraph(pdf_text(value), cell_style)

    data = [[Paragraph(pdf_text(c["label"]), head_style) for c in columns]]
    for row in report["rows"]:
        data.append([cell(row[c["key"]], c["kind"]) for c in columns])

    total = report["total"]
    data.append([total["label"] if c["key"] == "crane"
                 else (total["count"] if c["key"] == "count" else "")
                 for c in columns])

    # Доли ширины полосы набора: под текстовые колонки её нужно больше, чем
    # под номер крана и количество.
    shares = {"crane": 0.5, "stance": 0.6, "element_type": 1.2, "subtype": 1.7,
              "mark": 1.3, "count": 0.6, "counterparty": 1.3, "agreement": 1.3,
              "specification": 1.3, "plan_date": 1.0, "fact_date": 1.0, "need_date": 1.0}
    band = 277 * mm
    total_share = sum(shares.get(c["key"], 1.0) for c in columns)
    widths = [band * shares.get(c["key"], 1.0) / total_share for c in columns]

    last = len(data) - 1
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT_REGULAR),
        ("FONTSIZE", (0, 0), (-1, -1), 6.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F7")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D5D8DC")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 1), (1, -1), "CENTER"),
        ("ALIGN", (5, 1), (5, -1), "CENTER"),
        ("ALIGN", (9, 1), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("FONTNAME", (0, last), (-1, last), FONT_BOLD),
        ("BACKGROUND", (0, last), (-1, last), colors.HexColor("#EEF2F7")),
    ]))
    story.append(table)
    doc.build(story)
    return buf.getvalue()
