"""
Отчёты (живой запрос 2026-07-29). Пока один — «Статусы»: сводка по
статусам монтажа с иерархией Захватка → Этаж → Тип изделия.

Данные считаются ЗДЕСЬ, на сервере, а не на клиенте, хотя элементы уже
лежат в браузере. Причина: тот же отчёт выгружается в XLSX и PDF, и если
считать его в двух местах, числа в файле и на экране однажды разойдутся.
Экран, Excel и PDF берут результат одной и той же функции.

Структура повторяет сводную таблицу, которую заказчик собирал вручную:
строки — три уровня вложенности, колонки — статусы, ФАКТИЧЕСКИ
встретившиеся в данных (кроме «Запланирован»), затем «Остаток» и «В
проекте». «Остаток» = «В проекте» минус сумма показанных статусов, то есть
сколько изделий ещё не сдвинулось с планового состояния.
"""

from typing import Optional

from app.models import STATUS_LABELS_RU, STATUS_ORDER, Status

TITLE = "Статус монтажа изделий"
ROOT_LABEL = "ЖБ изделия"
TOTAL_LABEL = "В проекте"

# «Запланирован» намеренно НЕ становится колонкой: он и есть «Остаток».
# Отдельная колонка дублировала бы её, а сумма по строке перестала бы
# сходиться с «В проекте».
BASE_STATUS = Status.PLANNED.value

NO_ZAKHVATKA = "Захватка не определена"
NO_FLOOR = "Этаж не определён"


def _floor_label(floor: Optional[int]) -> str:
    return f"{floor} этаж" if floor is not None else NO_FLOOR


def _item_label(element_type: str, subtype: Optional[str]) -> str:
    """«Колонна нижняя», «Плита перекрытия на отм. +15.000», «Ригель
    периметральный» — тип и подтип через пробел, как в исходной сводной
    таблице заказчика. Без подтипа — только тип."""
    return f"{element_type} {subtype}".strip() if subtype else element_type


def build_status_report(conn, source_file: Optional[str], element_ids: Optional[list] = None) -> dict:
    """element_ids — необязательное сужение до конкретных элементов (тот же
    приём, что у XLS-экспорта: фильтры живут на клиенте, сервер получает
    готовый список id, а не пересчитывает их сам)."""
    clauses, params = [], []
    if source_file:
        clauses.append("e.source_file = ?")
        params.append(source_file)
    if element_ids is not None:
        if not element_ids:
            clauses.append("1=0")
        else:
            clauses.append(f"e.id IN ({','.join('?' * len(element_ids))})")
            params.extend(element_ids)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    rows = conn.execute(
        f"""
        SELECT z.name AS zakhvatka, e.floor AS floor, e.element_type AS element_type,
               e.subtype AS subtype, e.current_status AS status, COUNT(*) AS n
        FROM elements e
        LEFT JOIN zones z ON z.id = e.zone_zakhvatka_id
        {where}
        GROUP BY z.name, e.floor, e.element_type, e.subtype, e.current_status
        """,
        params,
    ).fetchall()

    # Какие статусы реально встретились — только они становятся колонками.
    # Показывать все семь смысла нет: пустые колонки занимают ширину и
    # мешают читать (в исходной сводной их тоже не было).
    present = {r["status"] for r in rows if r["status"] != BASE_STATUS}
    statuses = [s.value for s in STATUS_ORDER if s.value in present]
    columns = [{"key": s, "label": STATUS_LABELS_RU[Status(s)]} for s in statuses]

    def empty_values() -> dict:
        return {s: 0 for s in statuses} | {"total": 0}

    tree: dict = {}
    for r in rows:
        zak = r["zakhvatka"] or NO_ZAKHVATKA
        flo = _floor_label(r["floor"])
        item = _item_label(r["element_type"], r["subtype"])
        node = tree.setdefault(zak, {"values": empty_values(), "children": {}})
        floor_node = node["children"].setdefault(flo, {"values": empty_values(), "children": {}})
        item_node = floor_node["children"].setdefault(item, {"values": empty_values()})
        for target in (node, floor_node, item_node):
            target["values"]["total"] += r["n"]
            if r["status"] in target["values"]:
                target["values"][r["status"]] += r["n"]

    def finish(values: dict) -> dict:
        # «Остаток» считается ВЫЧИТАНИЕМ, а не подсчётом «Запланирован»:
        # так сумма по строке всегда сходится с «В проекте», даже если в
        # данных появится статус, которого нет среди колонок.
        used = sum(values[s] for s in statuses)
        return values | {"remainder": values["total"] - used}

    # Сортировка: захватки и этажи — «по-человечески» (Захватка 2 раньше
    # Захватки 10), изделия — по алфавиту, как в исходной сводной.
    def natural_key(text: str):
        import re
        return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", text)]

    out_rows = []
    for zak in sorted(tree, key=natural_key):
        znode = tree[zak]
        zrow = {"label": zak, "level": 0, "values": finish(znode["values"]), "children": []}
        for flo in sorted(znode["children"], key=natural_key):
            fnode = znode["children"][flo]
            frow = {"label": flo, "level": 1, "values": finish(fnode["values"]), "children": []}
            for item in sorted(fnode["children"], key=natural_key):
                frow["children"].append({
                    "label": item, "level": 2,
                    "values": finish(fnode["children"][item]["values"]), "children": [],
                })
            zrow["children"].append(frow)
        out_rows.append(zrow)

    grand = empty_values()
    for r in rows:
        grand["total"] += r["n"]
        if r["status"] in grand:
            grand[r["status"]] += r["n"]

    return {
        "title": TITLE,
        "root_label": ROOT_LABEL,
        "columns": columns + [{"key": "remainder", "label": "Остаток"},
                              {"key": "total", "label": TOTAL_LABEL}],
        "rows": out_rows,
        "total": {"label": TOTAL_LABEL, "values": finish(grand)},
    }


def flatten(report: dict) -> list:
    """Плоский список строк с уровнем вложенности — для XLSX и PDF, где
    дерева нет, а есть отступ и группировка."""
    out = []

    def walk(node):
        out.append(node)
        for child in node.get("children", []):
            walk(child)

    for row in report["rows"]:
        walk(row)
    return out


# ---------- выгрузка того же отчёта в файлы ----------
#
# Обе функции получают УЖЕ ПОСТРОЕННЫЙ отчёт (build_status_report), а не
# строят его заново — иначе числа на экране, в Excel и в PDF со временем
# разошлись бы.

def build_status_report_xlsx(report: dict) -> bytes:
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Статусы"

    thin = Side(style="thin", color="D5D8DC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill("solid", fgColor="EEF2F7")

    ws.append([report["title"]])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([])

    header = [report["root_label"]] + [c["label"] for c in report["columns"]]
    ws.append(header)
    header_row = ws.max_row
    for i in range(1, len(header) + 1):
        cell = ws.cell(row=header_row, column=i)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.border = border
        cell.alignment = Alignment(horizontal="center" if i > 1 else "left", wrap_text=True)

    for node in flatten(report):
        # Отступ вложенности — через indent у ячейки, а не пробелами в
        # тексте: Excel умеет отступ сам, и текст остаётся пригодным для
        # фильтров и формул.
        ws.append([node["label"]] + [node["values"].get(c["key"], 0) or None for c in report["columns"]])
        row = ws.max_row
        ws.cell(row=row, column=1).alignment = Alignment(indent=node["level"] * 2)
        if node["level"] < 2:
            for i in range(1, len(header) + 1):
                ws.cell(row=row, column=i).font = Font(bold=True)
        # Группировка строк — Excel рисует те же "+/−", что и в исходной
        # сводной таблице заказчика.
        if node["level"] > 0:
            ws.row_dimensions[row].outlineLevel = node["level"]
        for i in range(1, len(header) + 1):
            ws.cell(row=row, column=i).border = border

    total = report["total"]
    ws.append([total["label"]] + [total["values"].get(c["key"], 0) or None for c in report["columns"]])
    for i in range(1, len(header) + 1):
        cell = ws.cell(row=ws.max_row, column=i)
        cell.font = Font(bold=True)
        cell.fill = head_fill
        cell.border = border

    ws.column_dimensions["A"].width = 44
    for i in range(2, len(header) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 15
    ws.freeze_panes = ws.cell(row=header_row + 1, column=2)
    # Свёрнутый вид по умолчанию — как на исходном скриншоте, где раскрыта
    # только первая захватка. Разворачивает пользователь сам.
    ws.sheet_properties.outlinePr.summaryBelow = False

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_status_report_pdf(report: dict, subtitle: str = "") -> bytes:
    from io import BytesIO

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from app.pdf_export import FONT_BOLD, FONT_REGULAR

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(A4),
        leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm, bottomMargin=12 * mm,
        title=report["title"],
    )
    title_style = ParagraphStyle("t", fontName=FONT_BOLD, fontSize=14, leading=18)
    sub_style = ParagraphStyle("s", fontName=FONT_REGULAR, fontSize=9, leading=12,
                               textColor=colors.HexColor("#666666"))

    story = [Paragraph(report["title"], title_style)]
    if subtitle:
        story.append(Paragraph(subtitle, sub_style))
    story.append(Spacer(1, 6 * mm))

    data = [[report["root_label"]] + [c["label"] for c in report["columns"]]]
    styles = [
        ("FONTNAME", (0, 0), (-1, -1), FONT_REGULAR),
        ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F7")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D5D8DC")),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    for node in flatten(report):
        # Отступ пробелами — в PDF-таблице нет понятия уровня, а колонка
        # одна; неразрывные пробелы не дают reportlab схлопнуть их.
        data.append([" " * (node["level"] * 4) + node["label"]]
                    + [node["values"].get(c["key"], 0) or "" for c in report["columns"]])
        if node["level"] < 2:
            styles.append(("FONTNAME", (0, len(data) - 1), (-1, len(data) - 1), FONT_BOLD))

    total = report["total"]
    data.append([total["label"]] + [total["values"].get(c["key"], 0) or "" for c in report["columns"]])
    last = len(data) - 1
    styles += [("FONTNAME", (0, last), (-1, last), FONT_BOLD),
               ("BACKGROUND", (0, last), (-1, last), colors.HexColor("#EEF2F7"))]

    widths = [110 * mm] + [(150 * mm) / max(len(report["columns"]), 1)] * len(report["columns"])
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle(styles))
    story.append(table)
    doc.build(story)
    return buf.getvalue()


# ==================== Отчёт «Динамика монтажа и поставки» ====================
#
# Повторяет ежедневный отчёт, который заказчик собирал вручную (см.
# Docs/backlog.md): шапка с карточкой объекта, три накопительные кривые,
# две таблицы «план / факт / отклонение» и текстовые блоки.
#
# Что откуда берётся:
#   План СМР      — elements.project_smr_start_date (импорт графика MS Project)
#   План поставки — elements.planned_delivery_date
#   Факт монтажа  — status_history, переход в «Смонтирован»
#   Факт поставки — status_history, переход в «Доставлен»
#
# Кривые строятся НАКОПИТЕЛЬНО по неделям: у заказчика на графике недельная
# сетка (27 июл, 03 авг, 10 авг …), и дневная детализация на полугодовом
# горизонте превратила бы линию в шум.

DYNAMICS_TITLE = "Динамика монтажа и поставки ТМЦ"


def _week_start(date_str: str) -> str:
    """Понедельник недели, в которую попадает дата. Точка кривой — неделя,
    а не день (см. комментарий выше)."""
    from datetime import date, timedelta

    d = date.fromisoformat(date_str[:10])
    return (d - timedelta(days=d.weekday())).isoformat()


def _cumulative(pairs: list, weeks: list) -> list:
    """Накопительный итог по заранее заданной сетке недель. Сетка общая для
    всех кривых — иначе линии на графике стояли бы на разных абсциссах и
    сравнивать их было бы нельзя."""
    by_week: dict = {}
    for week, n in pairs:
        by_week[week] = by_week.get(week, 0) + n
    out, running = [], 0
    for w in weeks:
        running += by_week.get(w, 0)
        out.append(running)
    return out


def build_dynamics_report(conn, source_file: Optional[str], report_date: Optional[str] = None,
                          element_ids: Optional[list] = None) -> dict:
    from datetime import date

    from app.settings import get_project_card

    today = report_date or date.today().isoformat()

    clauses, params = [], []
    if source_file:
        clauses.append("e.source_file = ?")
        params.append(source_file)
    if element_ids is not None:
        if not element_ids:
            clauses.append("1=0")
        else:
            clauses.append(f"e.id IN ({','.join('?' * len(element_ids))})")
            params.extend(element_ids)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    total = conn.execute(f"SELECT COUNT(*) AS n FROM elements e {where}", params).fetchone()["n"]

    plan_smr = conn.execute(
        f"SELECT project_smr_start_date AS d, COUNT(*) AS n FROM elements e {where} "
        f"{'AND' if where else 'WHERE'} project_smr_start_date IS NOT NULL GROUP BY d", params).fetchall()
    plan_delivery = conn.execute(
        f"SELECT planned_delivery_date AS d, COUNT(*) AS n FROM elements e {where} "
        f"{'AND' if where else 'WHERE'} planned_delivery_date IS NOT NULL GROUP BY d", params).fetchall()

    # Факт — по ПЕРВОМУ переходу элемента в статус: повторные записи истории
    # (откат и возврат) не должны считаться вторым смонтированным изделием.
    def fact_rows(status: str):
        return conn.execute(
            f"""
            SELECT d, COUNT(*) AS n FROM (
                SELECT date(MIN(sh.changed_at)) AS d
                FROM status_history sh JOIN elements e ON e.id = sh.element_id
                {where} {'AND' if where else 'WHERE'} sh.status = ?
                GROUP BY sh.element_id
            ) GROUP BY d
            """, params + [status]).fetchall()

    fact_montage = fact_rows("installed")
    fact_delivery = fact_rows("delivered")

    series_raw = {
        "plan_smr": [(_week_start(r["d"]), r["n"]) for r in plan_smr if r["d"]],
        "plan_delivery": [(_week_start(r["d"]), r["n"]) for r in plan_delivery if r["d"]],
        "fact_montage": [(_week_start(r["d"]), r["n"]) for r in fact_montage if r["d"]],
        "fact_delivery": [(_week_start(r["d"]), r["n"]) for r in fact_delivery if r["d"]],
    }

    card = get_project_card(conn)
    weeks = sorted({w for pairs in series_raw.values() for w, _ in pairs} | {_week_start(today)})
    # Вехи и контрольные даты тоже задают правую границу графика — иначе
    # веха «Завершение 3 Захватки» оказалась бы за краем.
    for extra in [card.get("montage_deadline"), card.get("delivery_deadline")] + \
                 [m.get("date") for m in card.get("milestones", [])]:
        if extra:
            weeks.append(_week_start(extra))
    weeks = sorted(set(weeks))

    series = {k: _cumulative(v, weeks) for k, v in series_raw.items()}

    def upto(pairs, limit_date, only_day=None):
        if only_day:
            return sum(n for d, n in pairs if d == only_day)
        return sum(n for d, n in pairs if d <= limit_date)

    raw_days = {
        "plan_smr": [(r["d"][:10], r["n"]) for r in plan_smr if r["d"]],
        "plan_delivery": [(r["d"][:10], r["n"]) for r in plan_delivery if r["d"]],
        "fact_montage": [(r["d"][:10], r["n"]) for r in fact_montage if r["d"]],
        "fact_delivery": [(r["d"][:10], r["n"]) for r in fact_delivery if r["d"]],
    }

    def block(plan_key, fact_key):
        cum_plan = upto(raw_days[plan_key], today)
        cum_fact = upto(raw_days[fact_key], today)
        day_plan = upto(raw_days[plan_key], today, only_day=today)
        day_fact = upto(raw_days[fact_key], today, only_day=today)
        return {
            "total": total,
            "cumulative": {"plan": cum_plan, "fact": cum_fact, "deviation": cum_fact - cum_plan},
            "day": {"plan": day_plan, "fact": day_fact, "deviation": day_fact - day_plan},
            "percent": round(cum_fact / total * 100) if total else 0,
        }

    return {
        "title": DYNAMICS_TITLE,
        "report_date": today,
        "card": card,
        "weeks": weeks,
        "series": series,
        "series_labels": {"plan_smr": "План СМР", "plan_delivery": "Поставка (план)",
                          "fact_delivery": "Поставка", "fact_montage": "Монтаж"},
        "montage": block("plan_smr", "fact_montage"),
        "delivery": block("plan_delivery", "fact_delivery"),
        # Честная пометка о неполноте плана: на тестовых данных проектные
        # даты есть не у всех изделий, и молча рисовать такую кривую как
        # полный план нельзя (см. разбор в Docs/backlog.md).
        "plan_coverage": {
            "smr": sum(n for _, n in raw_days["plan_smr"]),
            "delivery": sum(n for _, n in raw_days["plan_delivery"]),
            "total": total,
        },
    }
