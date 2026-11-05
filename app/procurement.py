"""ЗВП → ЗП → оплаты: read-only XLSX parsing and deterministic reconciliation.

Source rows are never deduplicated. Document numbers are scoped by year, and
payments join by the complete order reference (number/date fallback is exact).
An unmatched item requires an explicit allocation, never a fuzzy name match.
"""
import hashlib
import io
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from zipfile import ZipFile, BadZipFile
from xml.etree.ElementTree import ParseError

from openpyxl import load_workbook

PAY_PREFIX = "ЗаявкаНаРасходованиеДенежныхСредств"
SHEETS = {
    "ЗВП": ["Ссылка", "Номер", "Дата", "Склад", "Номенклатура", "Упаковка", "Количество", "КатегорияНоменклатуры", "Отменено"],
    "ЗП": ["Ссылка", "Номер", "Дата", "Номенклатура", "Категория", "Контрагент", "Упаковка", "Количество", "СуммаСНДС", "НомерЗВП", "Отменено"],
    "Оплаты ЗРДС": [PAY_PREFIX, PAY_PREFIX + "ДокументОснование", "СуммаРасход",
                    *[PAY_PREFIX + "ДокументОснование" + s for s in ("Дата", "Номер", "Контрагент", "Менеджер")]],
}


def text(value):
    return " ".join(str(value if value is not None else "").split())


def norm(value):
    return text(value).casefold()


def key(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


def number(value, where):
    try:
        n = Decimal(str(value).replace("\u00a0", "").replace(" ", "").replace(",", "."))
        if not n.is_finite() or n < 0 or n > Decimal("1e14"):
            raise ValueError()
        return n
    except (InvalidOperation, ValueError):
        raise ValueError(f"{where}: ожидается неотрицательное число, получено «{text(value)}»") from None


def cents(value, where):
    return int((number(value, where) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def timestamp(value, where):
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).isoformat()
    for fmt in ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text(value), fmt).isoformat()
        except ValueError:
            pass
    raise ValueError(f"{where}: не распознана дата «{text(value)}»")


def cancelled(value, where):
    v = norm(value)
    if v in ("да", "true", "1"):
        return True
    if v in ("нет", "false", "0"):
        return False
    raise ValueError(f"{where}: в колонке «Отменено» нужно Да или Нет")


def parse_xlsx(data):
    # Bound expanded size/rows as well as HTTP upload size. No files extracted.
    try:
        with ZipFile(io.BytesIO(data)) as z:
            if sum(i.file_size for i in z.infolist()) > 100 * 1024 * 1024:
                raise ValueError("Распакованный Excel превышает 100 МБ")
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (BadZipFile, OSError, KeyError, ParseError, ValueError) as e:
        if isinstance(e, ValueError) and str(e).startswith("Распакованный"):
            raise
        raise ValueError("Файл не читается как Excel (.xlsx)") from None
    out = {"requests": [], "orders": [], "payments": [], "warnings": [], "rows": {}}
    try:
        for sheet, wanted in SHEETS.items():
            if sheet not in wb.sheetnames:
                raise ValueError(f"Нет листа «{sheet}»")
            ws = wb[sheet]
            if ws.max_row and ws.max_row > 100001 or ws.max_column and ws.max_column > 200:
                raise ValueError(f"Лист «{sheet}» превышает 100 000 строк или 200 столбцов")
            rows = ws.iter_rows(values_only=True)
            header = next(rows, ())
            names = [norm(v) for v in header]
            missing = [v for v in wanted if names.count(norm(v)) != 1]
            if missing:
                raise ValueError(f"{sheet}: отсутствуют или повторяются колонки: {', '.join(missing)}")
            columns = [names.index(norm(v)) for v in wanted]
            seen = Counter()
            count = 0
            for rn, row in enumerate(rows, 2):
                if rn > 100001:
                    raise ValueError(f"{sheet}: больше 100 000 строк")
                if not any(v not in (None, "") for v in row):
                    continue
                count += 1
                vals = [row[i] if i < len(row) else None for i in columns]
                seen[tuple(text(v) for v in vals)] += 1
                where = f"{sheet}, строка {rn}"
                if sheet == "ЗВП":
                    ref, num, dt, warehouse, item, unit, qty, category, cancel = vals
                    record = dict(ref=text(ref), number=text(num), date=timestamp(dt, where), warehouse=text(warehouse),
                                  item=text(item), unit=text(unit), qty=float(number(qty, where)), category=text(category),
                                  cancelled=cancelled(cancel, where), source_rows=[rn])
                    out["requests"].append(record)
                elif sheet == "ЗП":
                    ref, num, dt, item, category, supplier, unit, qty, amount, parent, cancel = vals
                    is_cancelled = cancelled(cancel, where)
                    # 1C export uses <0> on cancelled lines in the supplied file.
                    # Preserve its spelling; it never enters active money totals.
                    placeholder = text(amount) == "<0>" and is_cancelled
                    record = dict(ref=text(ref), number=text(num), date=timestamp(dt, where), item=text(item),
                                  category=text(category), supplier=text(supplier), unit=text(unit), qty=float(number(qty, where)),
                                  amount_cents=0 if placeholder else cents(amount, where), request_number=text(parent),
                                  amount_source=text(amount), cancelled=is_cancelled, source_rows=[rn])
                    out["orders"].append(record)
                else:
                    ref, order_ref, amount, dt, num, supplier, manager = vals
                    record = dict(ref=text(ref), order_ref=text(order_ref), amount_cents=cents(amount, where),
                                  order_date=timestamp(dt, where), order_number=text(num), supplier=text(supplier),
                                  manager=text(manager), source_row=rn)
                    out["payments"].append(record)
                required = ("ref", "order_ref", "order_number") if sheet == "Оплаты ЗРДС" else ("ref", "number", "item", "unit")
                if any(not record[f] for f in required):
                    raise ValueError(f"{where}: пустой номер, ссылка, номенклатура или единица измерения")
            out["rows"][sheet] = count
            duplicates = sum(v - 1 for v in seen.values())
            if duplicates:
                out["warnings"].append(f"{sheet}: {duplicates} полностью повторяющихся строк. Сохранены и учтены все строки; проверьте выгрузку.")
    finally:
        wb.close()
    if not out["requests"]:
        raise ValueError("Лист «ЗВП» не содержит потребностей")

    # Repeated nomenclature lines within a document have no source line IDs.
    # Aggregate them without losing quantities, money, or provenance.
    for kind in ("requests", "orders"):
        grouped = {}
        dates = defaultdict(set)
        for row in out[kind]:
            row["document_key"] = key(row["number"], row["date"][:4])
            dates[row["document_key"]].add(row["date"])
            identity = [row["document_key"], norm(row["item"]), norm(row["unit"]), row["cancelled"]]
            identity += [norm(row["warehouse"])] if kind == "requests" else [row["request_number"], norm(row["supplier"])]
            row["id"] = key(*identity)
            if row["id"] in grouped:
                old = grouped[row["id"]]
                old["qty"] = float(Decimal(str(old["qty"])) + Decimal(str(row["qty"])))
                old["source_rows"].extend(row["source_rows"])
                if kind == "orders":
                    old["amount_cents"] += row["amount_cents"]
            else:
                grouped[row["id"]] = row
        out[kind] = list(grouped.values())
        if any(len(v) > 1 for v in dates.values()):
            raise ValueError("Несколько документов с одним номером в одном году: нужна однозначная выгрузка")
    # A number/year is not sufficient if separate documents collide. Refuse
    # ambiguous exports rather than accidentally merge independent orders.
    out["sha256"] = hashlib.sha256(data).hexdigest()
    return out


def default_allocations(data):
    candidates = defaultdict(list)
    by_number = defaultdict(list)
    for r in data["requests"]:
        if not r["cancelled"]:
            by_number[r["number"]].append(r)
            candidates[(r["number"], r["date"][:4], norm(r["item"]), norm(r["unit"]))].append(r)
    result = {}
    for o in data["orders"]:
        if o["cancelled"]:
            continue
        matched = candidates[(o["request_number"], o["date"][:4], norm(o["item"]), norm(o["unit"]))]
        # Cross-year orders are common; only use a unique same-name match in a
        # unique source request document when no current-year request exists.
        if not any(r["date"][:4] == o["date"][:4] for r in by_number[o["request_number"]]):
            possible = [r for r in by_number[o["request_number"]] if norm(r["item"]) == norm(o["item"]) and norm(r["unit"]) == norm(o["unit"])]
            if len({r["document_key"] for r in by_number[o["request_number"]]}) == 1:
                matched = possible
        if len(matched) == 1 and o["qty"] > 0:
            result[o["id"]] = [{"request_line_id": matched[0]["id"], "order_qty": o["qty"], "request_qty": o["qty"]}]
    return result


def request_candidates(data, order):
    rows = [r for r in data["requests"] if not r["cancelled"] and r["number"] == order["request_number"]]
    same_year = [r for r in rows if r["date"][:4] == order["date"][:4]]
    return same_year or (rows if len({r["document_key"] for r in rows}) == 1 else [])


def validate_allocations(data, order_id, allocations):
    order = next((r for r in data["orders"] if r["id"] == order_id), None)
    if not order or order["cancelled"]:
        raise ValueError("Заказанная позиция не найдена или отменена")
    valid = {r["id"]: r for r in request_candidates(data, order)}
    total = Decimal(0)
    seen = set()
    clean = []
    for a in allocations:
        rid = a["request_line_id"]
        if rid not in valid or rid in seen:
            raise ValueError("Выберите разные действующие позиции исходной ЗВП этого заказа")
        seen.add(rid)
        oq, rq = number(a["order_qty"], "Количество ЗП"), number(a["request_qty"], "Эквивалент потребности")
        if oq <= 0 or rq <= 0:
            raise ValueError("Оба количества должны быть больше нуля")
        total += oq
        clean.append(dict(request_line_id=rid, order_qty=float(oq), request_qty=float(rq)))
    if total > Decimal(str(order["qty"])) + Decimal("0.000000001"):
        raise ValueError("Распределено больше количества позиции заказа поставщику")
    return clean


def distribute_cents(amount, weights):
    """Largest remainder allocation: exact cent reconciliation, stable tie order."""
    total = sum(weights)
    if not total:
        return [0] * len(weights)
    raw = [Decimal(amount) * w / total for w in weights]
    parts = [int(v) for v in raw]
    for i in sorted(range(len(parts)), key=lambda i: raw[i] - parts[i], reverse=True)[:amount - sum(parts)]:
        parts[i] += 1
    return parts


def build_report(data, overrides=None):
    overrides = overrides or {}
    allocations = default_allocations(data)
    allocations.update(overrides)
    requests = {r["id"]: dict(r, ordered_qty=0.0, paid_qty=0.0, amount_cents=0, paid_cents=0, links=[]) for r in data["requests"]}
    orders = [dict(o, paid_cents=0, links=[], candidates=[r["id"] for r in request_candidates(data, o)]) for o in data["orders"]]
    documents = defaultdict(list)
    refs, fallback = defaultdict(set), defaultdict(set)
    for o in orders:
        if not o["cancelled"]:
            documents[o["document_key"]].append(o)
            refs[norm(o["ref"])].add(o["document_key"])
            fallback[(o["number"], o["date"])].add(o["document_key"])
    payments, document_paid = [], Counter()
    for p in data["payments"]:
        matches = refs[norm(p["order_ref"])] or fallback[(p["order_number"], p["order_date"])]
        doc = next(iter(matches)) if len(matches) == 1 else None
        payments.append(dict(p, document_key=doc, linked=doc is not None))
        if doc:
            document_paid[doc] += p["amount_cents"]
    zero_value_paid = 0
    document_totals = {}
    for doc, lines in documents.items():
        weights = [o["amount_cents"] for o in lines]
        document_totals[doc] = sum(weights)
        distributed = distribute_cents(document_paid[doc], weights)
        if not sum(weights):
            zero_value_paid += document_paid[doc]
        for o, amount in zip(lines, distributed):
            o["paid_cents"] = amount
    for o in orders:
        o["manual"] = o["id"] in overrides
        o["unallocated_qty"] = 0 if o["cancelled"] else o["qty"]
        if o["cancelled"]:
            continue
        chosen = allocations.get(o["id"], [])
        covered = sum(Decimal(str(a["order_qty"])) for a in chosen)
        remainder = max(Decimal(0), Decimal(str(o["qty"])) - covered)
        weights = [Decimal(str(a["order_qty"])) for a in chosen] + [remainder]
        amounts = distribute_cents(o["amount_cents"], weights)
        paid = distribute_cents(o["paid_cents"], weights)
        for i, a in enumerate(chosen):
            r = requests[a["request_line_id"]]
            replacement = norm(o["item"]) != norm(r["item"]) or norm(o["unit"]) != norm(r["unit"])
            # Do not turn overpayment into extra physical quantity.
            total = document_totals[o["document_key"]]
            ratio = min(1, document_paid[o["document_key"]] / total) if total else None
            link = dict(a, order_line_id=o["id"], item=o["item"], unit=o["unit"], order_number=o["number"],
                        supplier=o["supplier"], replacement=replacement, amount_cents=amounts[i], paid_cents=paid[i],
                        paid_qty=None if ratio is None else a["request_qty"] * ratio)
            r["ordered_qty"] += a["request_qty"]
            if link["paid_qty"] is None:
                r["paid_qty"] = None
            elif r["paid_qty"] is not None:
                r["paid_qty"] += link["paid_qty"]
            r["amount_cents"] += amounts[i]
            r["paid_cents"] += paid[i]
            r["links"].append(link)
            o["links"].append(link)
        o["unallocated_qty"] = float(remainder)
    for r in requests.values():
        r["remaining_qty"] = max(0, r["qty"] - r["ordered_qty"])
        r["excess_qty"] = max(0, r["ordered_qty"] - r["qty"])
        r["order_percent"] = r["ordered_qty"] / r["qty"] * 100 if r["qty"] else None
        r["replacements"] = sum(a["replacement"] for a in r["links"])
        r["status"] = "cancelled" if r["cancelled"] else "excess" if r["excess_qty"] > 1e-9 else "not_ordered" if not r["links"] else "partial" if r["remaining_qty"] > 1e-9 else "ordered"
        r["pending_orders"] = sum(not o["cancelled"] and o["unallocated_qty"] > 1e-9 and r["id"] in o["candidates"] for o in orders)
        if not r["cancelled"] and r["pending_orders"] and r["status"] in ("not_ordered", "partial"):
            r["status"] = "needs_mapping"
    active = [r for r in requests.values() if not r["cancelled"]]
    all_ordered = sum(o["amount_cents"] for o in orders if not o["cancelled"])
    linked_paid = sum(document_paid.values())
    overpaid = sum(max(0, document_paid[d] - sum(o["amount_cents"] for o in lines)) for d, lines in documents.items())
    summary = dict(request_documents=len({r["document_key"] for r in active}), request_lines=len(active),
                   order_documents=len(documents), payment_rows=len(payments),
                   ordered_cents=all_ordered, paid_cents=linked_paid,
                   unpaid_cents=sum(max(0, sum(o["amount_cents"] for o in lines) - document_paid[d]) for d, lines in documents.items()),
                   overpaid_cents=overpaid, total_payment_cents=sum(p["amount_cents"] for p in payments),
                   orphan_payment_cents=sum(p["amount_cents"] for p in payments if not p["linked"]),
                   orphan_payments=sum(not p["linked"] for p in payments),
                   unmapped_orders=sum(o["unallocated_qty"] > 1e-9 for o in orders),
                   replacements=sum(r["replacements"] for r in active),
                   cancelled_requests=sum(r["cancelled"] for r in requests.values()),
                   cancelled_orders=sum(o["cancelled"] for o in orders),
                   fully_ordered=sum(r["status"] in ("ordered", "excess") for r in active),
                   zero_value_paid_cents=zero_value_paid,
                   mapped_cents=sum(r["amount_cents"] for r in active), mapped_paid_cents=sum(r["paid_cents"] for r in active))
    return dict(summary=summary, requests=list(requests.values()), orders=orders, payments=payments,
                warnings=data["warnings"], rows=data["rows"])
