from io import BytesIO

from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from app.contracts import build_contract_name
from app.models import STATUS_LABELS_RU

ELEMENT_COLUMNS = [
    ("id", "ID"),
    ("dxf_handle", "DXF handle"),
    ("layer", "Слой"),
    ("element_type", "Тип"),
    ("subtype", "Подтип"),
    ("mark", "Марка"),
    ("mark_source", "Источник марки"),
    ("x", "X, мм"),
    ("y", "Y, мм"),
    ("z", "Z, мм"),
    ("elevation_mm", "Отметка, мм"),
    ("address", "Адрес по осям"),
    ("axis_status", "Статус адресации"),
    ("axis_number", "Числовая ось"),
    ("axis_letter", "Буквенная ось"),
    ("nearest_axis_number", "Ближайшая числовая ось"),
    ("nearest_axis_letter", "Ближайшая буквенная ось"),
    ("offset_x_mm", "Смещение X, мм"),
    ("offset_y_mm", "Смещение Y, мм"),
    # "Контрактация 2.0" (см. Docs/backlog.md) — четыре независимые шкалы
    # дат поставки, простые колонки elements, доступны в обоих экспортах
    # (снимок на дату и полная история) без отдельной логики.
    ("planned_delivery_date", "Плановая дата поставки"),
    ("project_delivery_date", "Дата завершения СМР"),
    ("project_smr_start_date", "Начало СМР"),
    ("actual_delivery_date", "Фактическая дата поставки"),
]

# Привязка к зонам (см. Docs/backlog.md, "Разбор структурированных имён
# слоёв DWG/DXF...") — только id+status хранятся в elements, реальное
# название зоны резолвится отдельным запросом к zones (см. _zone_names),
# тем же способом, что и карточка элемента на фронтенде (zoneBindingText
# в app/static/index.html) — сюда попадает не сырой id, а имя зоны.
ZONE_COLUMNS = [
    ("zone_zakhvatka_id", "zone_zakhvatka_status", "Захватка"),
    ("zone_crane_id", "zone_crane_status", "Кран"),
    ("zone_stance_id", "zone_stance_status", "Стоянка"),
]

ZONE_STATUS_LABELS_RU = {
    "unmatched": "не определено", "needs_review": "требует проверки", "not_applicable": "неприменимо",
}


def _zone_names(conn) -> dict:
    return {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM zones").fetchall()}


def _contract_labels(conn) -> dict:
    # "Контрактация 2.0" (см. Docs/backlog.md) — contracts.supplier убран,
    # контрагент резолвится через цепочку specification->agreement->
    # counterparty, та же схема, что app/contracts.py:_specification_chain.
    # Наименование контракта не хранится — генерируется build_contract_name
    # (та же функция, что и /contracts, /plan-data, живой запрос
    # пользователя, 2026-07-28), не дублируем логику.
    return {
        r["id"]: build_contract_name(
            r["counterparty_short_name"], r["agreement_number"], r["agreement_date"],
            r["specification_number"], r["specification_date"], r["theme"],
        )
        for r in conn.execute(
            """
            SELECT co.id AS id, co.theme AS theme,
                   c.short_name AS counterparty_short_name,
                   a.number AS agreement_number, a.agreement_date AS agreement_date,
                   s.number AS specification_number, s.specification_date AS specification_date
            FROM contracts co
            JOIN specifications s ON s.id = co.specification_id
            JOIN agreements a ON a.id = s.agreement_id
            JOIN counterparties c ON c.id = a.counterparty_id
            """
        ).fetchall()
    }


def _zone_cell(row, id_field, status_field, zone_names) -> str:
    status = row[status_field]
    if status == "matched":
        zid = row[id_field]
        name = zone_names.get(zid)
        return name if name else (f"зона #{zid}" if zid else "")
    return ZONE_STATUS_LABELS_RU.get(status, status or "")


def _contract_cell(contract_id, contract_labels) -> str:
    if not contract_id:
        return ""
    return contract_labels.get(contract_id, f"#{contract_id}")


def _autosize(ws):
    for i, col in enumerate(ws.columns, start=1):
        width = max((len(str(c.value)) if c.value is not None else 0) for c in col) + 2
        ws.column_dimensions[get_column_letter(i)].width = min(width, 60)


def _day_bounds(date_from, date_to):
    lo = f"{date_from} 00:00:00" if date_from else None
    hi = f"{date_to} 23:59:59" if date_to else None
    return lo, hi


def build_snapshot_xlsx(conn, source_file, date):
    wb = Workbook()
    ws = wb.active
    ws.title = "Статус на дату"

    zone_names = _zone_names(conn)
    contract_labels = _contract_labels(conn)

    header = (
        [label for _, label in ELEMENT_COLUMNS]
        + [label for _, _, label in ZONE_COLUMNS]
        + ["Контракт", "Статус", "Статус изменён"]
    )
    ws.append(header)

    clause = "WHERE source_file = ?" if source_file else ""
    params = (source_file,) if source_file else ()
    elements = conn.execute(f"SELECT * FROM elements {clause} ORDER BY id", params).fetchall()

    for el in elements:
        if date:
            hi = f"{date} 23:59:59"
            row = conn.execute(
                "SELECT status, changed_at FROM status_history "
                "WHERE element_id = ? AND changed_at <= ? ORDER BY changed_at DESC LIMIT 1",
                (el["id"], hi),
            ).fetchone()
            status = row["status"] if row else None
            changed_at = row["changed_at"] if row else None
        else:
            status = el["current_status"]
            changed_at = el["updated_at"]

        values = [el[key] for key, _ in ELEMENT_COLUMNS]
        values.extend(_zone_cell(el, id_field, status_field, zone_names) for id_field, status_field, _ in ZONE_COLUMNS)
        values.append(_contract_cell(el["contract_id"], contract_labels))
        values.append(STATUS_LABELS_RU.get(status, status) if status else "(нет данных на эту дату)")
        values.append(changed_at or "")
        ws.append(values)

    _autosize(ws)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_history_xlsx(conn, source_file, date_from, date_to):
    wb = Workbook()
    ws = wb.active
    ws.title = "История статусов"

    zone_names = _zone_names(conn)
    contract_labels = _contract_labels(conn)

    header = (
        [label for _, label in ELEMENT_COLUMNS]
        + [label for _, _, label in ZONE_COLUMNS]
        + ["Статус", "Изменено", "Кто изменил", "Комментарий", "Контракт на момент изменения"]
    )
    ws.append(header)

    lo, hi = _day_bounds(date_from, date_to)
    clauses = []
    params = []
    if source_file:
        clauses.append("e.source_file = ?")
        params.append(source_file)
    if lo:
        clauses.append("sh.changed_at >= ?")
        params.append(lo)
    if hi:
        clauses.append("sh.changed_at <= ?")
        params.append(hi)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    rows = conn.execute(
        f"""
        SELECT e.*, sh.status as event_status, sh.changed_at, sh.changed_by, sh.comment,
               sh.contract_id as event_contract_id
        FROM status_history sh
        JOIN elements e ON e.id = sh.element_id
        {where}
        ORDER BY e.id, sh.changed_at
        """,
        params,
    ).fetchall()

    for r in rows:
        values = [r[key] for key, _ in ELEMENT_COLUMNS]
        values.extend(_zone_cell(r, id_field, status_field, zone_names) for id_field, status_field, _ in ZONE_COLUMNS)
        values.append(STATUS_LABELS_RU.get(r["event_status"], r["event_status"]))
        values.append(r["changed_at"])
        values.append(r["changed_by"] or "")
        values.append(r["comment"] or "")
        # Контракт НА МОМЕНТ этого события (sh.contract_id), а не текущий
        # контракт элемента — история должна отражать, что было тогда,
        # а не что сейчас (см. Docs/backlog.md).
        values.append(_contract_cell(r["event_contract_id"], contract_labels))
        ws.append(values)

    _autosize(ws)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
