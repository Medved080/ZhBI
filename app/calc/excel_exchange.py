"""Обмен настройками калькулятора через Excel: шаблон со всеми недостающими параметрами → заполнение человеком → загрузка обратно.

Шаблон (build_template) — книга XLSX с листами: «Инструкция», «Цены материалов» (материалы без цены, цены бетона по классам, ставка труда), «Нормы групп» (труд, расход бетона,
расход арматуры без чертежа, подтверждение технологом), «Классы по типам» (класс бетона типов, у которых на листах его нет), «Изделия» (объём и класс там, где их нет),
«Проверка изделий» (отметка «проверено по чертежу» по каждому изделию). Желтые столбцы — для заполнения; в остальных значения «как сейчас», так что повторная загрузка ничего не ломает.

Загрузка (parse_workbook → apply_plan): файл разбирается целиком, пустые и неизменённые ячейки пропускаются, ошибки собираются с адресом ячейки; применяется всё или ничего,
одной транзакцией, через те же функции, что и экраны (новые версии расценок и норм, запись в историю «было → стало»)."""
import io
import json
from datetime import datetime
from decimal import Decimal, InvalidOperation

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from .database import audit, now
from .document_models import model
from .norms import GroupNorm, NormsSave, get_norms, type_key, update_norms
from .prices import PricesSave, get_prices, norm_class, update_prices
from .readiness import readiness
from .repository import dynamic_values, pricing_context

S_HELP, S_PRICES, S_GROUPS, S_TYPES, S_PRODUCTS, S_VERIFY = "Инструкция", "Цены материалов", "Нормы групп", "Классы по типам", "Изделия", "Проверка изделий"
H_PRICES = ["Код", "Материал", "Ед.", "Изделий", "Цена сейчас, ₽ без НДС", "НОВАЯ ЦЕНА, ₽ без НДС"]
H_GROUPS = ["Группа", "Изделий", "Труд на 1 м³, чел·ч", "Расход бетона, коэфф.", "Арматура без чертежа, кг на м³", "Подтверждено технологом (да/нет)"]
H_TYPES = ["Тип изделия", "Изделий", "Класс бетона (В30, В40…)"]
H_PRODUCTS = ["ID", "Изделие", "Группа", "Лист чертежа", "Чего не хватает", "Объём бетона на изделие, м³", "Класс бетона"]
H_VERIFY = ["ID", "Изделие", "Группа", "Статус сейчас", "Проверено по чертежу (да/нет)", "Примечание"]
YES = {"да", "yes", "y", "1", "+", "true", "истина"}
NO = {"нет", "no", "n", "0", "-", "false", "ложь"}
INPUT = PatternFill("solid", fgColor="FFF4C2")
HEAD = PatternFill("solid", fgColor="DCE6F8")
LINE = Side(style="thin", color="B8C4DA")


def _D(value):
    return Decimal(str(value))


def _clean(value):
    return "" if value is None else str(value).strip()


def _num(value):
    """Число из ячейки: пусто → None; запятая как десятичный знак допускается; не число → ValueError."""
    if value is None or _clean(value) == "":
        return None
    if isinstance(value, (int, float)):
        return _D(value)
    try:
        return Decimal(_clean(value).replace("\xa0", "").replace(" ", "").replace(",", "."))
    except InvalidOperation:
        raise ValueError("«%s» — не число" % _clean(value))


def _same(a, b):
    return a is not None and b is not None and Decimal(str(a)) == Decimal(str(b))


def _short(value):
    try:
        return format(round(_D(value), 4).normalize(), "f").replace(".", ",")
    except (InvalidOperation, ValueError, TypeError):
        return "—"


def _fmt(value):
    if value is None or value == "":
        return "—"
    try:
        return format(_D(value).normalize(), "f").replace(".", ",")
    except InvalidOperation:
        return str(value)


# ------------------------------------------------------------------ шаблон
def _status(values, doc, verified, confirmed):
    resources = values.get("resources") or (doc or {}).get("resources") or []
    volume = float(values.get("volume", 0) or 0)
    klass = values.get("concreteClass") or (doc or {}).get("concreteClass")
    if volume <= 0 or not (klass or "").strip() or (klass or "").strip().lower() == "не указан":
        return "Нет данных"
    if any(float(r["rate"]) <= 0 for r in resources) or float(values.get("concreteRate", 0) or 0) <= 0:
        return "Нет цены"
    return "Готово" if verified and (doc or {}).get("family", "Вне каталога") in confirmed else "Предварительно"


def _sheet(wb, title, headers, widths, input_columns=()):
    ws = wb.create_sheet(title)
    ws.append(headers)
    for index, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(index)].width = width
    for index in range(1, len(headers) + 1):
        cell = ws.cell(1, index)
        cell.font = Font(bold=True)
        cell.fill = INPUT if index in input_columns else HEAD
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        cell.border = Border(bottom=LINE)
    ws.row_dimensions[1].height = 34
    ws.freeze_panes = "A2"
    return ws


def _mark_inputs(ws, columns, rows):
    for row in range(2, rows + 2):
        for column in columns:
            cell = ws.cell(row, column)
            cell.fill = INPUT
            cell.border = Border(left=LINE, right=LINE, top=LINE, bottom=LINE)


def build_template(conn):
    """Книга XLSX (байты) со всеми недостающими параметрами и текущими значениями; желтые столбцы заполняет человек."""
    ctx = pricing_context(conn)
    prices = ctx["prices"]["parameters"]
    norms = ctx["norms"]["parameters"] if ctx["norms"] else {}
    state = readiness(conn)
    usage = state["prices"]["usage"]
    class_use = {c["name"]: c["products"] for c in state["prices"]["classes"]}
    wb = Workbook()
    wb.remove(wb.active)

    ws = wb.create_sheet(S_HELP)
    ws.column_dimensions["A"].width = 120
    lines = [
        ("Заполнение недостающих параметров калькулятора", True),
        ("Выгружено: %s. Желтые ячейки — для заполнения; остальные — справочные (значения как сейчас). Файл загружается обратно в «Цены и нормы» → «Excel».", False),
        ("", False),
        ("1. «Цены материалов» — впишите в столбец «НОВАЯ ЦЕНА» цену за единицу без НДС (₽). В списке материалы без цены (по убыванию числа изделий), цены бетона по классам и ставка труда. Пустая ячейка — без изменений.", False),
        ("2. «Нормы групп» — свой труд на м³, коэффициент расхода бетона и расход арматуры (кг на м³) для изделий без арматуры по чертежам (плиты). Пусто — действует общая норма. «Подтверждено» — только после проверки технологом.", False),
        ("3. «Классы по типам» — класс бетона для типов изделий, у которых на чертежах его нет (например, плиты): В30, В40…", False),
        ("4. «Изделия» — объём и класс бетона там, где их не удалось прочитать с листа. Объём вводится «как есть» на одно изделие и больше не пересчитывается от чтения листов.", False),
        ("5. «Проверка изделий» — «да» у изделий, значения которых сверены с чертежом; «нет» снимает отметку. Примечание сохраняется вместе с отметкой.", False),
        ("Общая норма (действует, если ячейка группы в листе «Нормы групп» пуста): труд %s чел·ч на 1 м³, расход бетона (производственный / проектный) %s." % (_short(norms.get("hoursPerM3")), _short(norms.get("concreteFactor"))), False),
        ("", False),
        ("Не меняйте названия листов, заголовки столбцов и столбцы «Код» / «ID» / «Группа» / «Тип изделия». Строки можно удалять, если не хотите менять эти значения. Число — с запятой или точкой.", False),
        ("Перед применением система покажет, что изменится, и укажет ошибки с адресом ячейки; при любой ошибке не применяется ничего. Изменения попадают в «Цены и нормы» → «История».", False),
    ]
    for index, (text, bold) in enumerate(lines, 1):
        cell = ws.cell(index, 1, text.replace("%s", datetime.now().strftime("%d.%m.%Y %H:%M")))
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        cell.font = Font(bold=bold, size=13 if bold else 11)

    # --- цены
    ws = _sheet(wb, S_PRICES, H_PRICES, [16, 52, 9, 10, 20, 24], (6,))
    rows = [("c:default", "Бетон: класс не указан или без своей цены", "₽/м³", class_use.get("Не указан"), prices["concrete"]["default"])]
    rows += [("c:" + key, "Бетон " + key, "₽/м³", class_use.get(key), value) for key, value in prices["concrete"].items() if key != "default"]
    rows.append(("labour", "Труд", "₽/чел·ч", None, prices["labour"]["rate"]))
    unpriced = sorted(((k, m) for k, m in prices["materials"].items() if _D(m["rate"]) <= 0), key=lambda km: (-usage.get(km[0], 0), km[1]["name"]))
    rows += [("m:" + key, meta["name"], meta["unit"], usage.get(key), meta["rate"]) for key, meta in unpriced]
    for row in rows:
        ws.append([row[0], row[1], row[2], row[3], float(row[4]) if row[4] is not None else None, None])
    _mark_inputs(ws, (6,), len(rows))
    for r in range(2, len(rows) + 2):
        ws.cell(r, 5).number_format = ws.cell(r, 6).number_format = "#,##0.00"
    validation = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1="0", allow_blank=True, showErrorMessage=True, errorTitle="Цена", error="Введите число не меньше нуля")
    ws.add_data_validation(validation)
    validation.add("F2:F%d" % (len(rows) + 1))

    # --- нормы групп
    groups = norms.get("groups") or {}
    families = [f["name"] for f in state["families"] if f["name"] != "Вне каталога"]
    ws = _sheet(wb, S_GROUPS, H_GROUPS, [26, 10, 22, 22, 28, 28], (3, 4, 5, 6))
    for family in families:
        g = groups.get(family) or {}
        total = next(f["total"] for f in state["families"] if f["name"] == family)
        ws.append([family, total, float(g["hoursPerM3"]) if g.get("hoursPerM3") not in (None, "") else None,
                   float(g["concreteFactor"]) if g.get("concreteFactor") not in (None, "") else None,
                   float(g["steelKgPerM3"]) if g.get("steelKgPerM3") not in (None, "") else None, "да" if g.get("confirmed") else "нет"])
    _mark_inputs(ws, (3, 4, 5, 6), len(families))
    for column, low, high, title in ((3, 0, 1000, "Труд"), (4, 1, 3, "Коэффициент"), (5, 0, 500, "Арматура")):
        dv = DataValidation(type="decimal", operator="between", formula1=str(low), formula2=str(high), allow_blank=True, showErrorMessage=True, errorTitle=title, error="Допустимо от %s до %s" % (low, high))
        ws.add_data_validation(dv)
        dv.add("%s2:%s%d" % (get_column_letter(column), get_column_letter(column), len(families) + 1))
    yes_no = DataValidation(type="list", formula1='"да,нет"', allow_blank=False, showErrorMessage=True)
    ws.add_data_validation(yes_no)
    yes_no.add("F2:F%d" % (len(families) + 1))

    # --- классы по типам
    ws = _sheet(wb, S_TYPES, H_TYPES, [34, 10, 28], (3,))
    class_map = norms.get("classByType") or {}
    for item in state["classTypes"]:
        ws.append([item["key"], item["count"], class_map.get(item["key"]) or None])
    _mark_inputs(ws, (3,), len(state["classTypes"]))

    # --- изделия с пробелами и проверка
    confirmed = {f for f, g in groups.items() if g.get("confirmed")} | {"Вне каталога"}
    verified = {r["product_id"]: r for r in conn.execute("SELECT product_id,note FROM product_verifications").fetchall()}
    ws_p = _sheet(wb, S_PRODUCTS, H_PRODUCTS, [38, 22, 22, 18, 22, 26, 18], (6, 7))
    ws_v = _sheet(wb, S_VERIFY, H_VERIFY, [38, 22, 22, 16, 28, 40], (5, 6))
    gap_rows = 0
    for row in conn.execute("SELECT * FROM products ORDER BY created_at,id").fetchall():
        doc = model(row["document_model_id"]) if row["document_model_id"] else None
        values = dynamic_values(row, ctx)
        family = (doc or {}).get("family") or "Вне каталога"
        volume = float(values.get("volume", row["volume"]) or 0)
        klass = values.get("concreteClass") or row["concrete_class"]
        no_class = not (klass or "").strip() or (klass or "").strip().lower() == "не указан"
        own_class = next((c for c in (row["concrete_class"], (doc or {}).get("concreteClass")) if (c or "").strip().lower() not in ("", "не указан")), None)      # собственный класс изделия; класс типа сюда не подставляется
        source = (doc or {}).get("source") or {}
        sheet = ("%s, стр. %s" % (source.get("id"), source.get("productPage"))) if source.get("id") else ""
        name = (doc or {}).get("alias") or row["name"]
        if volume <= 0 or no_class:
            gap_rows += 1
            ws_p.append([row["id"], name, family, sheet, ("объём и класс" if volume <= 0 and no_class else "объём" if volume <= 0 else "класс"),
                         volume if volume > 0 else None, own_class])      # класс из таблицы типов в строку не пишем: иначе повторная загрузка файла закрепит старый класс типа за изделиями
        mark = verified.get(row["id"])
        ws_v.append([row["id"], name, family, _status(values, doc, bool(mark), confirmed), "да" if mark else "нет", mark["note"] if mark else None])
    _mark_inputs(ws_p, (6, 7), gap_rows)
    _mark_inputs(ws_v, (5, 6), ws_v.max_row - 1)
    dv = DataValidation(type="list", formula1='"да,нет"', allow_blank=False, showErrorMessage=True)
    ws_v.add_data_validation(dv)
    dv.add("E2:E%d" % ws_v.max_row)
    if gap_rows == 0:
        ws_p.cell(3, 1, "Пробелов в объёме и классе бетона нет.")
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


# ------------------------------------------------------------------ загрузка
def _columns(ws, headers, errors):
    """Номера столбцов по заголовкам первой строки; нет столбца — ошибка листа."""
    found = {_clean(c.value): c.column for c in ws[1] if _clean(c.value)}
    result = {}
    for header in headers:
        if header in found:
            result[header] = found[header]
        else:
            errors.append("Лист «%s»: нет столбца «%s» (заголовки менять нельзя)" % (ws.title, header))
    return result if len(result) == len(headers) else None


def _rows(ws, columns):
    for row in range(2, ws.max_row + 1):
        values = {h: ws.cell(row, c).value for h, c in columns.items()}
        if _clean(values.get(next(iter(columns)))) == "":
            continue
        yield row, values, {h: "%s%d" % (get_column_letter(c), row) for h, c in columns.items()}


def parse_workbook(conn, data):
    """Разбор загруженного файла в план изменений: {errors, warnings, changes, prices, norms, classes, products, verification, summary}. Ничего не записывает."""
    errors, warnings, changes = [], [], []
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True)
    except Exception:
        return {"errors": ["Файл не читается как книга Excel (.xlsx)"], "warnings": [], "changes": [], "summary": {}}
    ctx = pricing_context(conn)
    prices = ctx["prices"]["parameters"]
    norms = ctx["norms"]["parameters"] if ctx["norms"] else {}
    state = readiness(conn)      # один раз: расчёт готовности занимает больше секунды
    plan = {"prices": {"concrete": {}, "materials": {}, "labour": None}, "groups": {}, "classes": {}, "products": [], "verify": {"set": [], "unset": []}}

    def change(sheet, label, before, after):
        changes.append({"sheet": sheet, "label": label, "before": _fmt(before), "after": _fmt(after)})

    if S_PRICES in wb.sheetnames and (cols := _columns(wb[S_PRICES], H_PRICES, errors)):
        for row, v, addr in _rows(wb[S_PRICES], cols):
            code, cell = _clean(v["Код"]), addr["НОВАЯ ЦЕНА, ₽ без НДС"]
            try:
                new = _num(v["НОВАЯ ЦЕНА, ₽ без НДС"])
            except ValueError as error:
                errors.append("%s!%s: %s" % (S_PRICES, cell, error)); continue
            if new is None:
                continue
            if new < 0 or new > Decimal("1e9"):
                errors.append("%s!%s: цена должна быть от 0 до 1 000 000 000" % (S_PRICES, cell)); continue
            name = _clean(v["Материал"])
            if code == "labour":
                if not _same(new, prices["labour"]["rate"]):
                    plan["prices"]["labour"] = str(new); change(S_PRICES, "Труд, ₽/чел·ч", prices["labour"]["rate"], new)
            elif code.startswith("c:"):
                key = code[2:]
                if key not in prices["concrete"]:
                    errors.append("%s!%s: класса бетона «%s» нет в прайс-листе" % (S_PRICES, cell, key)); continue
                if not _same(new, prices["concrete"][key]):
                    plan["prices"]["concrete"][key] = str(new); change(S_PRICES, name, prices["concrete"][key], new)
            elif code.startswith("m:"):
                key = code[2:]
                if key not in prices["materials"]:
                    errors.append("%s!%s: материала «%s» нет в прайс-листе" % (S_PRICES, cell, key)); continue
                if not _same(new, prices["materials"][key]["rate"]):
                    plan["prices"]["materials"][key] = str(new); change(S_PRICES, "Цена: " + prices["materials"][key]["name"], prices["materials"][key]["rate"], new)
            else:
                errors.append("%s!%s: неизвестный код «%s»" % (S_PRICES, addr["Код"], code))

    groups_now = norms.get("groups") or {}
    families = {f["name"] for f in state["families"]}
    if S_GROUPS in wb.sheetnames and (cols := _columns(wb[S_GROUPS], H_GROUPS, errors)):
        for row, v, addr in _rows(wb[S_GROUPS], cols):
            family = _clean(v["Группа"])
            if family not in families:
                errors.append("%s!%s: неизвестная группа «%s»" % (S_GROUPS, addr["Группа"], family)); continue
            before = groups_now.get(family) or {}
            entry, bad = {}, False
            for header, field, low, high in (("Труд на 1 м³, чел·ч", "hoursPerM3", 0, 1000), ("Расход бетона, коэфф.", "concreteFactor", 1, 3), ("Арматура без чертежа, кг на м³", "steelKgPerM3", 0, 500)):
                try:
                    value = _num(v[header])
                except ValueError as error:
                    errors.append("%s!%s: %s" % (S_GROUPS, addr[header], error)); bad = True; continue
                if value is not None and not (low <= value <= high):
                    errors.append("%s!%s: допустимо от %s до %s" % (S_GROUPS, addr[header], low, high)); bad = True; continue
                entry[field] = value
            flag = _clean(v["Подтверждено технологом (да/нет)"]).lower()
            if flag and flag not in YES | NO:
                errors.append("%s!%s: укажите «да» или «нет»" % (S_GROUPS, addr["Подтверждено технологом (да/нет)"])); bad = True
            if bad:
                continue
            entry["confirmed"] = flag in YES if flag else bool(before.get("confirmed"))
            plan["groups"][family] = entry
            for field, title in (("hoursPerM3", "труд на м³, чел·ч"), ("concreteFactor", "расход бетона, коэфф."), ("steelKgPerM3", "арматура без чертежа, кг на м³")):
                old = before.get(field) if before.get(field) not in ("",) else None
                if (old is None) != (entry[field] is None) or (old is not None and not _same(old, entry[field])):
                    change(S_GROUPS, "%s: %s" % (family, title), old, entry[field])
            if bool(before.get("confirmed")) != entry["confirmed"]:
                change(S_GROUPS, "%s: подтверждено технологом" % family, bool(before.get("confirmed")) and "да" or "нет", "да" if entry["confirmed"] else "нет")

    classes_now = norms.get("classByType") or {}
    type_keys = {t["key"] for t in state["classTypes"]} | set(classes_now)
    if S_TYPES in wb.sheetnames and (cols := _columns(wb[S_TYPES], H_TYPES, errors)):
        for row, v, addr in _rows(wb[S_TYPES], cols):
            kind, raw = _clean(v["Тип изделия"]), _clean(v["Класс бетона (В30, В40…)"])
            if kind not in type_keys:
                errors.append("%s!%s: неизвестный тип «%s»" % (S_TYPES, addr["Тип изделия"], kind)); continue
            value = raw.upper().replace(" ", "").replace("B", "В")
            if value and not (len(value) == 3 and value[0] == "В" and value[1:].isdigit()):
                errors.append("%s!%s: класс записывается как В30, В40" % (S_TYPES, addr["Класс бетона (В30, В40…)"])); continue
            if value != (classes_now.get(kind) or ""):
                plan["classes"][kind] = value; change(S_TYPES, "Класс бетона типа «%s»" % kind, classes_now.get(kind), value or None)

    if S_PRODUCTS in wb.sheetnames and (cols := _columns(wb[S_PRODUCTS], H_PRODUCTS, errors)):
        for row, v, addr in _rows(wb[S_PRODUCTS], cols):
            pid = _clean(v["ID"])
            product = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
            if not product:
                errors.append("%s!%s: изделия с таким ID нет" % (S_PRODUCTS, addr["ID"])); continue
            values = dynamic_values(product, ctx)
            update = {}
            try:
                volume = _num(v["Объём бетона на изделие, м³"])
            except ValueError as error:
                errors.append("%s!%s: %s" % (S_PRODUCTS, addr["Объём бетона на изделие, м³"], error)); continue
            if volume is not None:
                if not (Decimal("0") < volume <= Decimal("1000")):
                    errors.append("%s!%s: объём должен быть больше нуля и не больше 1000 м³" % (S_PRODUCTS, addr["Объём бетона на изделие, м³"])); continue
                current = values.get("volume", product["volume"])
                if not _same(volume, current):
                    update["volume"] = str(volume); change(S_PRODUCTS, "%s: объём, м³" % _clean(v["Изделие"]), current, volume)
            raw = _clean(v["Класс бетона"]).upper().replace(" ", "").replace("B", "В")
            if raw:
                if not (len(raw) == 3 and raw[0] == "В" and raw[1:].isdigit()):
                    errors.append("%s!%s: класс записывается как В30, В40" % (S_PRODUCTS, addr["Класс бетона"])); continue
                current = values.get("concreteClass") or product["concrete_class"]
                if norm_class(raw) != norm_class(current):
                    update["concrete_class"] = raw; change(S_PRODUCTS, "%s: класс бетона" % _clean(v["Изделие"]), current, raw)
            if update:
                plan["products"].append({"id": pid, "name": _clean(v["Изделие"]), "update": update, "before": {"volume": str(values.get("volume", product["volume"])), "concrete_class": product["concrete_class"]}})

    if S_VERIFY in wb.sheetnames and (cols := _columns(wb[S_VERIFY], H_VERIFY, errors)):
        now_verified = {r["product_id"]: r["note"] for r in conn.execute("SELECT product_id,note FROM product_verifications").fetchall()}
        for row, v, addr in _rows(wb[S_VERIFY], cols):
            pid = _clean(v["ID"])
            if not conn.execute("SELECT 1 FROM products WHERE id=?", (pid,)).fetchone():
                errors.append("%s!%s: изделия с таким ID нет" % (S_VERIFY, addr["ID"])); continue
            flag = _clean(v["Проверено по чертежу (да/нет)"]).lower()
            if flag and flag not in YES | NO:
                errors.append("%s!%s: укажите «да» или «нет»" % (S_VERIFY, addr["Проверено по чертежу (да/нет)"])); continue
            note = _clean(v["Примечание"])[:500] or None
            if flag in YES and (pid not in now_verified or (note and note != now_verified.get(pid))):
                plan["verify"]["set"].append((pid, note))
            elif flag in NO and pid in now_verified:
                plan["verify"]["unset"].append(pid)
        if plan["verify"]["set"]:
            change(S_VERIFY, "Отметить проверенными", None, "%d изд." % len(plan["verify"]["set"]))
        if plan["verify"]["unset"]:
            change(S_VERIFY, "Снять отметку проверки", None, "%d изд." % len(plan["verify"]["unset"]))

    if not any(name in wb.sheetnames for name in (S_PRICES, S_GROUPS, S_TYPES, S_PRODUCTS, S_VERIFY)):
        errors.append("В книге нет ни одного из листов шаблона — загрузите файл, выгруженный из «Цены и нормы» → «Excel»")
    plan["summary"] = {"prices": len(plan["prices"]["materials"]) + len(plan["prices"]["concrete"]) + (1 if plan["prices"]["labour"] else 0), "groups": len([c for c in changes if c["sheet"] == S_GROUPS]),
                       "classes": len(plan["classes"]), "products": len(plan["products"]), "verified": len(plan["verify"]["set"]), "unverified": len(plan["verify"]["unset"])}
    plan.update(errors=errors, warnings=warnings, changes=changes)
    return plan


def apply_plan(conn, plan, actor):
    """Применяет разобранный план одной транзакцией (conn — внутри transaction): расценки, нормы, изделия, проверка. Возвращает сводку применённого."""
    applied = {}
    prices = plan["prices"]
    if prices["materials"] or prices["concrete"] or prices["labour"]:
        current = get_prices(conn)
        parameters = current["parameters"]
        body = PricesSave(expectedVersion=current["version"], concrete={**parameters["concrete"], **prices["concrete"]}, labour=prices["labour"] or parameters["labour"]["rate"],
                          materials={**{k: m["rate"] for k, m in parameters["materials"].items()}, **prices["materials"]})
        applied["prices"] = update_prices(conn, body, actor)["version"]
    if plan["groups"] or plan["classes"]:
        current = get_norms(conn)
        params = current["parameters"]
        groups = {family: GroupNorm(confirmed=e["confirmed"], hoursPerM3=e["hoursPerM3"], concreteFactor=e["concreteFactor"], steelKgPerM3=e["steelKgPerM3"]) for family, e in plan["groups"].items()}
        for family, old in (params.get("groups") or {}).items():
            groups.setdefault(family, GroupNorm(confirmed=bool(old.get("confirmed")), hoursPerM3=old.get("hoursPerM3"), concreteFactor=old.get("concreteFactor"), steelKgPerM3=old.get("steelKgPerM3")))
        classes = {**(params.get("classByType") or {}), **{k: v for k, v in plan["classes"].items()}}
        body = NormsSave(expectedVersion=current["version"], concreteFactor=params["concreteFactor"], hoursPerM3=params["hoursPerM3"],
                         resources={k: {"factor": r["factor"]} for k, r in params["resources"].items()}, groups=groups, classByType={k: v for k, v in classes.items() if v})
        applied["norms"] = update_norms(conn, body, actor)["version"]
    if plan["products"]:
        stamp, log = now(), []
        for item in plan["products"]:
            row = conn.execute("SELECT version,manual_fields FROM products WHERE id=?", (item["id"],)).fetchone()
            manual = set(json.loads(row["manual_fields"] or "[]"))
            sets, args = ["version=?", "updated_at=?"], [row["version"] + 1, stamp]
            if "volume" in item["update"]:
                sets.append("volume=?"); args.append(item["update"]["volume"]); manual.add("volume")
            if "concrete_class" in item["update"]:
                sets.append("concrete_class=?"); args.append(item["update"]["concrete_class"])
            sets.append("manual_fields=?"); args.append(json.dumps(sorted(manual)))
            conn.execute("UPDATE products SET %s WHERE id=?" % ",".join(sets), (*args, item["id"]))
            log.append({"id": item["id"], "name": item["name"], "update": item["update"], "before": item["before"]})
        audit(conn, actor, "products.imported", "products", {"count": len(log), "items": log})
        applied["products"] = len(log)
    verify = plan["verify"]
    if verify["set"] or verify["unset"]:
        stamp = now()
        for pid, note in verify["set"]:
            conn.execute("INSERT OR REPLACE INTO product_verifications VALUES(?,?,?,?)", (pid, actor, stamp, note))
        for pid in verify["unset"]:
            conn.execute("DELETE FROM product_verifications WHERE product_id=?", (pid,))
        if verify["set"]:
            audit(conn, actor, "products.verified.bulk", "products", {"ids": [p for p, _ in verify["set"]], "verified": True, "note": "загрузка из Excel", "count": len(verify["set"])})
        if verify["unset"]:
            audit(conn, actor, "products.verified.bulk", "products", {"ids": verify["unset"], "verified": False, "note": "загрузка из Excel", "count": len(verify["unset"])})
        applied["verified"] = len(verify["set"]); applied["unverified"] = len(verify["unset"])
    return applied
