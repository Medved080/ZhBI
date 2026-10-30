"""Отчёт «Сверка поставки по договорам» (2026-10-26, запрос заказчика; макет правлен заказчиком 2026-10-28, v0.119+).

Зачем. Снабжению нужно сверять, как идёт поставка по договору: что обещано спецификацией, что реально поставлено и на какие даты
поставка запланирована по каждому ещё не доставленному изделию. Три вопроса — три вкладки одного отчёта (на экране вкладками, в
Excel — листами):

  1. «Спецификация договора» — что предусмотрено: по позициям контрактов выбранных спецификаций (тип, подтип, марка, количество).
     «Срок окончания поставки по договору» (specifications.delivery_end_date) — договорное обязательство, атрибут спецификации, не
     связанный с графиком; выводится аналитикой НАД таблицей (по строке на спецификацию со сроком), а не колонкой;
  2. «Факт поставки» — что поставлено: по каждой позиции (контракт, тип, марка) и каждой фактической дате поставки — сколько изделий
     доставлено в этот день («Доставлен» и дальше по цепочке — «Смонтирован», «Принят»). Нулевых строк нет;
  3. «План поставки» — построчно по изделиям, привязанным к контрактам и ещё НЕ доставленным (статус ниже «Доставлен»): плановая и
     требуемая даты, отклонение (требуемая минус плановая) и «Статус» — «Просрочено» (плановая дата строго раньше даты отчёта),
     «Текущий план» (остальные с плановой датой), «Без даты» (плановой даты нет). Строки сгруппированы в этом порядке.

Область. Договоры объекта (agreements.object_id) за вычетом отработанных (архивных) контрактов; сужается по контрагенту, договору и
спецификации — любым сочетанием. Изделие учитывается, только если оно привязано к контракту (elements.contract_id) и показывается на схеме
(`visible_elements_clause`: исчезнувшие из актуального чертежа не считаются).

Поставленное изделие, чья пара (тип, марка) в позициях контракта отсутствует, показывается на «Факте поставки» наравне с остальными — а
на «Спецификации» её нет: расхождение видно при сравнении вкладок.

«Требуемая дата поставки» — единое правило сервиса (`app/schedule_versions.need_start_dates`): начало СМР последней актуализации
графика, а если у изделия в ней нет записи — директивное начало СМР.

Данные, как у остальных отчётов, считает СЕРВЕР: экран и Excel берут результат одной функции и разойтись не могут.
"""

from datetime import date
from typing import Optional

from app.contracts import build_document_label
from app.db import visible_elements_clause
from app.reports import natural_key
from app.schedule_versions import need_start_dates

TITLE = "Сверка поставки по договорам"
# Заголовок листа Excel — в макете заказчика ячейка A1 («по договору», единственное число).
XLSX_TITLE = "Сверка поставки по договору"

# «Поставлено» — изделие доехало до площадки: статус «Доставлен» и все последующие (монтаж без поставки невозможен).
DELIVERED_STATUSES = ("delivered", "ready_for_installation", "installed", "accepted")

# Статусы позиций вкладки «План поставки» — порядок и есть порядок разделов.
PLAN_OVERDUE = "Просрочено"
PLAN_CURRENT = "Текущий план"
PLAN_NO_DATE = "Без даты"
_PLAN_ORDER = {PLAN_OVERDUE: 0, PLAN_CURRENT: 1, PLAN_NO_DATE: 2}

DELIVERY_END_LABEL = "Срок окончания поставки по договору"

_SPEC_COLS = [
    {"key": "counterparty", "label": "Контрагент", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
    {"key": "contract", "label": "Подтип", "kind": "text"},
    {"key": "mark", "label": "Марка", "kind": "text"},
    {"key": "quantity", "label": "Количество по спецификации", "kind": "num"},
]
_FACT_COLS = [
    {"key": "counterparty", "label": "Контрагент", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "contract", "label": "Контракт", "kind": "text"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
    {"key": "mark", "label": "Марка", "kind": "text"},
    {"key": "fact_date", "label": "Фактическая дата поставки", "kind": "date"},
    {"key": "delivered", "label": "Поставлено", "kind": "num"},
]
_PLAN_COLS = [
    {"key": "counterparty", "label": "Контрагент", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
    {"key": "mark", "label": "Марка", "kind": "text"},
    {"key": "plan_date", "label": "Плановая дата поставки", "kind": "date"},
    {"key": "need_date", "label": "Требуемая дата поставки", "kind": "date"},
    {"key": "delay_days", "label": "Отклонение (требуемая − плановая), дней", "kind": "num"},
    {"key": "status", "label": "Статус", "kind": "text"},
]


def _doc(number, date_str):
    return build_document_label(number, date_str) if number else None


def _nk(value) -> tuple:
    text = "" if value is None else str(value)
    return (1, []) if not text else (0, natural_key(text))


def _scope_sql(object_id: int, counterparty_id, agreement_id, specification_id):
    """Условия отбора контрактов: объект договора, не отработанный контракт и необязательные сужения."""
    where = ["ag.object_id = ?", "c.is_archived = 0"]
    params: list = [object_id]
    for column, value in (("ag.counterparty_id", counterparty_id), ("ag.id", agreement_id), ("sp.id", specification_id)):
        if value is not None:
            where.append(f"{column} = ?")
            params.append(value)
    return " AND ".join(where), params


_CHAIN = """
    FROM contracts c
    JOIN specifications sp ON sp.id = c.specification_id
    JOIN agreements ag ON ag.id = sp.agreement_id
    JOIN counterparties cp ON cp.id = ag.counterparty_id
"""


def recon_options(conn, object_id: int) -> list:
    """Выбор для фильтров экрана: контрагенты объекта → их договоры → спецификации (только те, у которых есть неархивные контракты)."""
    rows = conn.execute(
        f"""SELECT DISTINCT cp.id AS cp_id, cp.short_name AS cp_name, ag.id AS ag_id, ag.number AS ag_number, ag.agreement_date AS ag_date,
                   sp.id AS sp_id, sp.number AS sp_number, sp.specification_date AS sp_date
            {_CHAIN} WHERE ag.object_id = ? AND c.is_archived = 0""", (object_id,)).fetchall()
    cps: dict = {}
    for r in rows:
        cp = cps.setdefault(r["cp_id"], {"id": r["cp_id"], "name": r["cp_name"], "agreements": {}})
        ag = cp["agreements"].setdefault(r["ag_id"], {"id": r["ag_id"], "label": _doc(r["ag_number"], r["ag_date"]), "specifications": []})
        ag["specifications"].append({"id": r["sp_id"], "label": _doc(r["sp_number"], r["sp_date"])})
    out = []
    for cp in sorted(cps.values(), key=lambda x: _nk(x["name"])):
        ags = sorted(cp["agreements"].values(), key=lambda x: _nk(x["label"]))
        for ag in ags:
            ag["specifications"].sort(key=lambda x: _nk(x["label"]))
        out.append({"id": cp["id"], "name": cp["name"], "agreements": ags})
    return out


def build_recon_report(conn, object_id: int, counterparty_id: Optional[int] = None, agreement_id: Optional[int] = None,
                       specification_id: Optional[int] = None, report_date: Optional[str] = None) -> dict:
    """`report_date` (ГГГГ-ММ-ДД) — дата отчёта для статусов вкладки «План поставки»; по умолчанию сегодня."""
    report_day = (report_date or date.today().isoformat())[:10]
    where, params = _scope_sql(object_id, counterparty_id, agreement_id, specification_id)

    # ---- вкладка 1: позиции спецификаций
    lines = conn.execute(
        f"""SELECT cp.short_name AS cp_name, ag.number AS ag_number, ag.agreement_date AS ag_date,
                   sp.number AS sp_number, sp.specification_date AS sp_date, sp.delivery_end_date AS delivery_end,
                   c.id AS contract_id, c.theme AS theme, cl.element_type AS element_type, cl.mark AS mark, cl.quantity AS quantity
            {_CHAIN} JOIN contract_lines cl ON cl.contract_id = c.id
            WHERE {where}""", params).fetchall()
    # Контракты области без единой позиции тоже видны на первой вкладке (строка без типа/марки): иначе спецификация с пустым контрактом
    # выглядела бы так, будто её в отчёте нет.
    empty = conn.execute(
        f"""SELECT cp.short_name AS cp_name, ag.number AS ag_number, ag.agreement_date AS ag_date,
                   sp.number AS sp_number, sp.specification_date AS sp_date, sp.delivery_end_date AS delivery_end,
                   c.id AS contract_id, c.theme AS theme
            {_CHAIN} WHERE {where} AND NOT EXISTS (SELECT 1 FROM contract_lines x WHERE x.contract_id = c.id)""", params).fetchall()

    def chain(r):
        return {"counterparty": r["cp_name"], "agreement": _doc(r["ag_number"], r["ag_date"]),
                "specification": _doc(r["sp_number"], r["sp_date"]), "contract": r["theme"] or None}

    spec_rows = [dict(chain(r), element_type=r["element_type"] or None, mark=r["mark"] or None, quantity=r["quantity"],
                      contract_id=r["contract_id"]) for r in lines]
    spec_rows += [dict(chain(r), element_type=None, mark=None, quantity=None, contract_id=r["contract_id"]) for r in empty]
    sort_keys = ("counterparty", "agreement", "specification", "contract", "element_type", "mark")
    spec_rows.sort(key=lambda x: tuple(_nk(x[k]) for k in sort_keys))

    # Срок окончания поставки — атрибут СПЕЦИФИКАЦИИ (договорное обязательство): аналитика над таблицей, по строке на спецификацию.
    # Одна спецификация — подпись без пояснений; несколько — к подписи добавляются договор и спецификация.
    deadlines: dict = {}
    for r in list(lines) + list(empty):
        deadlines.setdefault((_doc(r["ag_number"], r["ag_date"]), _doc(r["sp_number"], r["sp_date"])), r["delivery_end"] or None)
    several = len(deadlines) > 1
    # У области из нескольких спецификаций строки без срока не выводятся (их число — в предупреждении): иначе над таблицей
    # встала бы стена пустых строк.
    spec_header = [
        {"label": DELIVERY_END_LABEL + (f" — договор {ag or '—'}, спецификация {sp or '—'}" if several else ""),
         "value": day, "kind": "date"}
        for (ag, sp), day in sorted(deadlines.items(), key=lambda kv: (_nk(kv[0][0]), _nk(kv[0][1])))
        if day or not several]

    # ---- изделия контрактов области (для вкладок 2 и 3)
    elements = conn.execute(
        f"""SELECT e.id AS id, e.contract_id AS contract_id, e.element_type AS element_type, e.mark AS mark, e.current_status AS status,
                   e.planned_delivery_date AS plan_date, e.actual_delivery_date AS fact_date,
                   cp.short_name AS cp_name, ag.number AS ag_number, ag.agreement_date AS ag_date,
                   sp.number AS sp_number, sp.specification_date AS sp_date, c.theme AS theme
            FROM elements e
            JOIN contracts c ON c.id = e.contract_id
            JOIN specifications sp ON sp.id = c.specification_id
            JOIN agreements ag ON ag.id = sp.agreement_id
            JOIN counterparties cp ON cp.id = ag.counterparty_id
            WHERE e.object_id = ? AND {visible_elements_clause("e")} AND {where}""", [object_id] + params).fetchall()

    def element_chain(r):
        return chain({"cp_name": r["cp_name"], "ag_number": r["ag_number"], "ag_date": r["ag_date"],
                      "sp_number": r["sp_number"], "sp_date": r["sp_date"], "theme": r["theme"]})

    # ---- вкладка 2: факт — по позиции и фактической дате (нулевых строк нет: строка рождается от поставленного изделия)
    fact: dict = {}
    for r in elements:
        if r["status"] not in DELIVERED_STATUSES:
            continue
        day = (r["fact_date"] or "")[:10] or None
        key = (r["contract_id"], r["element_type"] or None, r["mark"] or None, day)
        if key not in fact:
            fact[key] = dict(element_chain(r), element_type=r["element_type"] or None, mark=r["mark"] or None,
                             fact_date=day, delivered=0)
        fact[key]["delivered"] += 1
    fact_rows = sorted(fact.values(), key=lambda x: tuple(_nk(x[k]) for k in sort_keys) + (_nk(x["fact_date"]),))

    # ---- вкладка 3: ещё не доставленные изделия построчно
    need = need_start_dates(conn, object_id)

    def deviation(need_day, plan_day):
        """Требуемая минус плановая, дней (минус — плановая дата позже требуемой); None, если нет любой из дат."""
        if not need_day or not plan_day:
            return None
        try:
            return (date.fromisoformat(need_day[:10]) - date.fromisoformat(plan_day[:10])).days
        except ValueError:
            return None

    def plan_status(plan_day):
        if not plan_day:
            return PLAN_NO_DATE
        return PLAN_OVERDUE if plan_day < report_day else PLAN_CURRENT

    plan_rows = []
    for r in elements:
        if r["status"] in DELIVERED_STATUSES:
            continue
        plan_day = (r["plan_date"] or "")[:10] or None
        need_day = (need.get(r["id"]) or "")[:10] or None
        plan_rows.append({
            "counterparty": r["cp_name"], "agreement": _doc(r["ag_number"], r["ag_date"]),
            "specification": _doc(r["sp_number"], r["sp_date"]), "element_type": r["element_type"] or None, "mark": r["mark"] or None,
            "plan_date": plan_day, "need_date": need_day, "delay_days": deviation(need_day, plan_day),
            "status": plan_status(plan_day), "_id": r["id"]})
    plan_rows.sort(key=lambda x: (_PLAN_ORDER[x["status"]],)
                   + tuple(_nk(x[k]) for k in ("counterparty", "agreement", "specification", "element_type", "mark"))
                   + (_nk(x["plan_date"]), x["_id"]))
    for row in plan_rows:
        del row["_id"]

    def total(rows, *keys):
        return {"label": "Итого", **{k: sum(r[k] or 0 for r in rows) for k in keys}}

    no_delivery_end = sum(1 for day in deadlines.values() if not day)
    shown_day = f"{report_day[8:10]}.{report_day[5:7]}.{report_day[:4]}"
    return {
        "title": TITLE,
        "object_id": object_id,
        "report_date": report_day,
        "filters": {"counterparty_id": counterparty_id, "agreement_id": agreement_id, "specification_id": specification_id},
        "tabs": [
            {"id": "spec", "title": "Спецификация договора", "subtitle": "Обязательства по договору", "header": spec_header,
             "columns": _SPEC_COLS, "rows": spec_rows, "total": total(spec_rows, "quantity")},
            {"id": "fact", "title": "Факт поставки", "subtitle": "Факт поставки", "columns": _FACT_COLS, "rows": fact_rows,
             "total": total(fact_rows, "delivered"),
             "note": "Поставлено — изделия в статусах «Доставлен», «Смонтирован», «Принят»; по строке на позицию и фактическую дату поставки."},
            {"id": "plan", "title": "План поставки", "subtitle": "План поставки", "columns": _PLAN_COLS, "rows": plan_rows,
             "total": {"label": "Изделий", "count": len(plan_rows), "count_key": "mark"},
             "note": f"Изделия, привязанные к контрактам и ещё не доставленные (статус ниже «Доставлен»). Статус на дату отчёта {shown_day}: "
                     f"«{PLAN_OVERDUE}» — плановая дата раньше даты отчёта, «{PLAN_CURRENT}» — остальные, «{PLAN_NO_DATE}» — плановой "
                     "даты нет. Отклонение = требуемая дата минус плановая (минус — плановая дата позже требуемой)."},
        ],
        "warning": (f"У {no_delivery_end} спецификаций не задан «{DELIVERY_END_LABEL}» — его вносят в справочнике «Контрагенты»."
                    if no_delivery_end else None),
    }


def build_recon_xlsx(report: dict) -> bytes:
    """Три листа — по вкладкам, макет заказчика: A1 — название отчёта, A2 — название вкладки; на «Спецификации» с A3 — срок окончания
    поставки (дата в A, подпись в B), затем пустая строка и шапка таблицы; дата — настоящая дата, а не текст."""
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    from app.element_fields import EXCEL_DATE_FORMAT, to_excel_date

    wb = Workbook()
    wb.remove(wb.active)
    thin = Side(style="thin", color="D5D8DC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_fill = PatternFill("solid", fgColor="EEF2F7")
    mark_fill = PatternFill("solid", fgColor="FFFF00")

    for tab in report["tabs"]:
        ws = wb.create_sheet(tab["title"][:31])
        ws.cell(row=1, column=1, value=XLSX_TITLE).font = Font(size=12)
        ws.cell(row=2, column=1, value=tab.get("subtitle") or tab["title"]).font = Font(bold=True, size=12)
        row = 2
        for item in tab.get("header") or []:
            row += 1
            cell = ws.cell(row=row, column=1, value=to_excel_date(item["value"]))
            cell.number_format = EXCEL_DATE_FORMAT
            cell.fill = mark_fill
            cell.alignment = Alignment(horizontal="center")
            ws.cell(row=row, column=2, value=item["label"])
        top = row + 2    # одна пустая строка между аналитикой и шапкой таблицы
        columns = tab["columns"]
        for i, c in enumerate(columns, 1):
            cell = ws.cell(row=top, column=i, value=c["label"])
            cell.font = Font(bold=True)
            cell.fill = head_fill
            cell.border = border
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        row = top
        for data in tab["rows"]:
            row += 1
            for i, c in enumerate(columns, 1):
                value = data.get(c["key"])
                if c["kind"] == "date":
                    value = to_excel_date(value)
                cell = ws.cell(row=row, column=i, value=value)
                cell.border = border
                if c["kind"] == "date":
                    cell.number_format = EXCEL_DATE_FORMAT
                    cell.alignment = Alignment(horizontal="center")
        row += 1
        total = tab["total"]
        ws.cell(row=row, column=1, value=total["label"]).font = Font(bold=True)
        for i, c in enumerate(columns, 1):
            if c["key"] in total and c["key"] != "label":
                ws.cell(row=row, column=i, value=total[c["key"]]).font = Font(bold=True)
            elif "count" in total and c["key"] == total.get("count_key"):
                ws.cell(row=row, column=i, value=total["count"]).font = Font(bold=True)
        if tab.get("note"):
            ws.cell(row=row + 2, column=1, value=tab["note"]).font = Font(italic=True, color="6B7075")
        for i, c in enumerate(columns, 1):
            widest = max([len(str(c["label"]))] + [len(str(r.get(c["key"]) or "")) for r in tab["rows"][:300]])
            ws.column_dimensions[get_column_letter(i)].width = min(48, max(11, widest * 0.9 + 2))
        ws.row_dimensions[top].height = 32
        ws.freeze_panes = ws.cell(row=top + 1, column=1)
        if tab["rows"]:
            ws.auto_filter.ref = f"A{top}:{get_column_letter(len(columns))}{row - 1}"
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
