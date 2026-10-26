"""Отчёт «Сверка поставки по договорам» (2026-10-26, запрос заказчика).

Зачем. Снабжению нужно сверять, как идёт поставка по договору: что обещано спецификацией, что реально поставлено и смонтировано, на какие
даты поставка запланирована по каждому изделию. Три вопроса — три вкладки одного отчёта (на экране вкладками, в Excel — листами):

  1. «Спецификация договора» — что предусмотрено: по позициям контрактов выбранных спецификаций (тип, марка, количество) и справочный
     «Срок окончания поставки по договору» (specifications.delivery_end_date);
  2. «Факт поставки» — то, что есть в системе: по тем же позициям количество поставленных («Доставлен» и дальше по цепочке — «Смонтирован»,
     «Принят»), из них смонтированных, в пути («Отгружен»), остаток и первая/последняя фактические даты поставки;
  3. «Плановые даты поставки» — построчно по изделиям, привязанным к контрактам: плановая и фактическая даты, статус, отклонение.

Область. Договоры объекта (agreements.object_id) за вычетом отработанных (архивных) контрактов; сужается по контрагенту, договору и
спецификации — любым сочетанием. Изделие учитывается, только если оно привязано к контракту (elements.contract_id) и показывается на схеме
(`visible_elements_clause`: исчезнувшие из актуального чертежа не считаются).

Количество «по спецификации» — сумма contract_lines.quantity; одна позиция = (контракт, тип, марка). Поставленное изделие, чья пара
(тип, марка) в позициях контракта отсутствует, показывается отдельной строкой с нулём «по спецификации» — молча терять его нельзя: это и
есть расхождение, ради которого отчёт нужен.

Данные, как у остальных отчётов, считает СЕРВЕР: экран и Excel берут результат одной функции и разойтись не могут.
"""

from datetime import date
from typing import Optional

from app.contracts import build_document_label
from app.db import visible_elements_clause
from app.models import STATUS_LABELS_RU, Status
from app.reports import natural_key

TITLE = "Сверка поставки по договорам"

# «Поставлено» — изделие доехало до площадки: статус «Доставлен» и все последующие (монтаж без поставки невозможен).
DELIVERED_STATUSES = ("delivered", "installed", "accepted")
INSTALLED_STATUSES = ("installed", "accepted")

_SPEC_COLS = [
    {"key": "counterparty", "label": "Контрагент", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "delivery_end", "label": "Срок окончания поставки по договору", "kind": "date"},
    {"key": "contract", "label": "Контракт", "kind": "text"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
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
    {"key": "quantity", "label": "По спецификации", "kind": "num"},
    {"key": "delivered", "label": "Поставлено", "kind": "num"},
    {"key": "installed", "label": "из них смонтировано", "kind": "num"},
    {"key": "shipped", "label": "В пути (отгружено)", "kind": "num"},
    {"key": "remaining", "label": "Остаток к поставке", "kind": "num"},
    {"key": "first_delivery", "label": "Первая поставка", "kind": "date"},
    {"key": "last_delivery", "label": "Последняя поставка", "kind": "date"},
]
_PLAN_COLS = [
    {"key": "counterparty", "label": "Контрагент", "kind": "text"},
    {"key": "agreement", "label": "Договор", "kind": "text"},
    {"key": "specification", "label": "Спецификация", "kind": "text"},
    {"key": "element_type", "label": "Тип", "kind": "text"},
    {"key": "mark", "label": "Марка", "kind": "text"},
    {"key": "status", "label": "Статус", "kind": "text"},
    {"key": "plan_date", "label": "Плановая дата поставки", "kind": "date"},
    {"key": "fact_date", "label": "Фактическая дата поставки", "kind": "date"},
    {"key": "delay_days", "label": "Отклонение факта от плана, дней", "kind": "num"},
    {"key": "guid", "label": "GUID", "kind": "text"},
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
                       specification_id: Optional[int] = None) -> dict:
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

    spec_rows = [dict(chain(r), delivery_end=r["delivery_end"] or None, element_type=r["element_type"] or None,
                      mark=r["mark"] or None, quantity=r["quantity"], contract_id=r["contract_id"]) for r in lines]
    spec_rows += [dict(chain(r), delivery_end=r["delivery_end"] or None, element_type=None, mark=None, quantity=None,
                       contract_id=r["contract_id"]) for r in empty]
    sort_keys = ("counterparty", "agreement", "specification", "contract", "element_type", "mark")
    spec_rows.sort(key=lambda x: tuple(_nk(x[k]) for k in sort_keys))

    # ---- изделия контрактов области (для вкладок 2 и 3)
    elements = conn.execute(
        f"""SELECT e.contract_id AS contract_id, e.element_type AS element_type, e.mark AS mark, e.current_status AS status,
                   e.planned_delivery_date AS plan_date, e.actual_delivery_date AS fact_date, e.element_uid AS guid,
                   cp.short_name AS cp_name, ag.number AS ag_number, ag.agreement_date AS ag_date,
                   sp.number AS sp_number, sp.specification_date AS sp_date, c.theme AS theme
            FROM elements e
            JOIN contracts c ON c.id = e.contract_id
            JOIN specifications sp ON sp.id = c.specification_id
            JOIN agreements ag ON ag.id = sp.agreement_id
            JOIN counterparties cp ON cp.id = ag.counterparty_id
            WHERE e.object_id = ? AND {visible_elements_clause("e")} AND {where}""", [object_id] + params).fetchall()

    # ---- вкладка 2: факт по позициям
    fact: dict = {}

    def slot(contract_id, element_type, mark, base):
        key = (contract_id, element_type or None, mark or None)
        if key not in fact:
            fact[key] = dict(base, element_type=element_type or None, mark=mark or None, quantity=0, delivered=0, installed=0,
                             shipped=0, first_delivery=None, last_delivery=None)
        return fact[key]

    for r in lines:
        slot(r["contract_id"], r["element_type"], r["mark"], chain(r))["quantity"] += r["quantity"] or 0
    for r in elements:
        s = slot(r["contract_id"], r["element_type"], r["mark"], chain(
            {"cp_name": r["cp_name"], "ag_number": r["ag_number"], "ag_date": r["ag_date"],
             "sp_number": r["sp_number"], "sp_date": r["sp_date"], "theme": r["theme"]}))
        if r["status"] in DELIVERED_STATUSES:
            s["delivered"] += 1
            day = (r["fact_date"] or "")[:10] or None
            if day:
                s["first_delivery"] = day if s["first_delivery"] is None else min(s["first_delivery"], day)
                s["last_delivery"] = day if s["last_delivery"] is None else max(s["last_delivery"], day)
        if r["status"] in INSTALLED_STATUSES:
            s["installed"] += 1
        if r["status"] == "shipped":
            s["shipped"] += 1
    fact_rows = list(fact.values())
    for s in fact_rows:
        s["remaining"] = max(0, s["quantity"] - s["delivered"])
        # Поставлено больше, чем в спецификации (или вне её), — это и есть расхождение; остаток при этом не отрицательный.
    fact_rows.sort(key=lambda x: tuple(_nk(x[k]) for k in sort_keys))

    # ---- вкладка 3: изделия построчно
    def delay(plan, fact_day):
        if not plan or not fact_day:
            return None
        try:
            return (date.fromisoformat(fact_day[:10]) - date.fromisoformat(plan[:10])).days
        except ValueError:
            return None

    plan_rows = []
    for r in elements:
        try:
            status = STATUS_LABELS_RU[Status(r["status"])]
        except ValueError:
            status = r["status"]
        plan_rows.append({
            "counterparty": r["cp_name"], "agreement": _doc(r["ag_number"], r["ag_date"]),
            "specification": _doc(r["sp_number"], r["sp_date"]), "element_type": r["element_type"] or None, "mark": r["mark"] or None,
            "status": status, "plan_date": (r["plan_date"] or "")[:10] or None, "fact_date": (r["fact_date"] or "")[:10] or None,
            "delay_days": delay(r["plan_date"], r["fact_date"]), "guid": r["guid"] or None})
    plan_rows.sort(key=lambda x: tuple(_nk(x[k]) for k in ("counterparty", "agreement", "specification", "element_type", "mark"))
                   + (_nk(x["plan_date"]), _nk(x["guid"])))

    def total(rows, *keys):
        return {"label": "Итого", **{k: sum(r[k] or 0 for r in rows) for k in keys}}

    no_delivery_end = len({(r["agreement"], r["specification"]) for r in spec_rows if not r["delivery_end"]})
    return {
        "title": TITLE,
        "object_id": object_id,
        "filters": {"counterparty_id": counterparty_id, "agreement_id": agreement_id, "specification_id": specification_id},
        "tabs": [
            {"id": "spec", "title": "Спецификация договора", "columns": _SPEC_COLS, "rows": spec_rows, "total": total(spec_rows, "quantity")},
            {"id": "fact", "title": "Факт поставки", "columns": _FACT_COLS, "rows": fact_rows,
             "total": total(fact_rows, "quantity", "delivered", "installed", "shipped", "remaining"),
             "note": "Поставлено — изделия в статусах «Доставлен», «Смонтирован», «Принят»; смонтировано — «Смонтирован» и «Принят»; в пути — «Отгружен»."},
            {"id": "plan", "title": "Плановые даты поставки", "columns": _PLAN_COLS, "rows": plan_rows,
             "total": {"label": "Изделий", "count": len(plan_rows)},
             "note": "Построчно по изделиям, привязанным к контрактам. Отклонение = фактическая дата минус плановая (плюс — позже плана)."},
        ],
        "warning": (f"У {no_delivery_end} спецификаций не задан «Срок окончания поставки по договору» — его вносят в справочнике «Контрагенты»."
                    if no_delivery_end else None),
    }


def build_recon_xlsx(report: dict, object_name: Optional[str] = None) -> bytes:
    """Три листа — по вкладкам; формат ячеек и стиль шапки те же, что у остальных отчётов (дата — настоящая дата, а не текст)."""
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

    for tab in report["tabs"]:
        ws = wb.create_sheet(tab["title"][:31])
        top = 1
        if object_name:
            ws.cell(row=1, column=1, value=f"{report['title']} — {object_name}").font = Font(bold=True, size=12)
            top = 3
        columns = tab["columns"]
        if tab.get("note") and object_name:
            ws.cell(row=2, column=1, value=tab["note"]).font = Font(italic=True, color="6B7075")
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
        if "count" in total:
            ws.cell(row=row, column=2, value=total["count"]).font = Font(bold=True)
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
