"""Сверка сводной таблицы сборных ЖБИ («Лист1» книги «Промкорпус с названиями.xlsx») с каталогом калькулятора и со схемой ЖБИ.

Что сверяется:
  * объём одного изделия (м³ ÷ шт. в таблице) с проектным объёмом изделия в каталоге;
  * количество изделий в таблице с числом элементов на схеме (по маркам, через то же определение изделия, что и кнопка «Открыть в калькуляторе»);
  * позиции таблицы, которых в каталоге нет (кандидаты на пополнение каталога).
Кроме того в отчёт выводится цена КП за 1 м³ по сопоставленным изделиям: эталон для приёмки калькуляций.

Книга лежит вне репозитория (данные заказчика, поставщики и цены КП); названия и ИНН поставщиков в отчёт НЕ попадают. Отчёт — xlsx, по умолчанию в data/calc/ (в git не входит).

Запуск (Python 3.12):
    ZHBI_CALC_ASSETS_DIR=…/data/calc/assets .venv312/bin/python scripts/audit_calc_vs_price_list.py "…/Промкорпус с названиями.xlsx" \
        [--calc-db data/calc/calczhbi.sqlite3] [--scheme-db data/zhbi.anon.db] [--objects 1,2] [--out data/calc/list1-audit.xlsx]
"""
import argparse
import collections
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import openpyxl  # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

LOOK = str.maketrans("ABCEHKMOPTXYacekopxyg", "АВСЕНКМОРТХУАСЕКОРХУд")      # латиница, похожая на кириллицу (в названиях встречается «3КH», «Пg»)
STOP = {"колонна", "ригель", "панель", "плита", "перекрытия", "покрытия", "шахты", "лифта", "подъемника", "подьемника", "грузового", "грузовых",
        "цокольная", "стеновая", "железобетонные"}
VOLUME_TOLERANCE = 0.02
PB_WIDTH = {"1": "10", "2": "12", "3": "15"}      # 1ПБ… → ширина 1,0 м, 2ПБ… → 1,2 м, 3ПБ… → 1,5 м (в таблице серия без цифры, ширина в названии)


def norm(text):
    """Название для сравнения: нижний регистр, латиница → кириллица, без служебных слов и знаков препинания."""
    words = re.split(r"\s+", str(text or "").translate(LOOK).lower().replace("ё", "е").replace("ъ", "ь"))
    words = [w for w in words if w and w not in STOP]
    return re.sub(r"к[в8](?=\d)", "к8", re.sub(r"[^0-9a-zа-я]", "", "".join(words)).replace("з", "3"))      # «КВ1.1» и «К81.1» — одна марка (как в app/calc/marks.py)


def read_list(path):
    """Позиции «Лист1»: строки с количеством. Колонки: F — наименование, H — ед., J — шт., K — м³ всего, U — наиболее экономичная цена за ед., AA — цена за 1 м³,
    AE — количество по КП (факт), AG — объём одного изделия по КП (факт)."""
    ws = openpyxl.load_workbook(path, data_only=True)["Лист1"]
    out, group = [], ""
    for r in range(8, ws.max_row + 1):
        name = ws[f"F{r}"].value
        if name is None:
            continue
        pieces, volume = ws[f"J{r}"].value, ws[f"K{r}"].value
        if pieces is None and volume is None:
            group = str(name).strip()
            continue
        out.append({"row": r, "group": group, "name": str(name).strip(), "pieces": pieces, "volume": volume,
                    "unit_price": ws[f"U{r}"].value, "price_m3": ws[f"AA{r}"].value,
                    "kp_pieces": ws[f"AE{r}"].value, "kp_volume": ws[f"AG{r}"].value})
    return out


def pb_key(length, width, load):
    return (round(float(length.replace(",", ".")), 2), str(width), str(load))


def build_indexes(models):
    by_name, by_alias, by_pb = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    for m in models.values():
        if m.get("kind") != "registry":
            continue
        for key in (m.get("mark"), m.get("rawTitle"), m.get("alias"), m.get("supplierMark")):
            if key:
                by_name[norm(key)].append(m)
        if m.get("alias"):
            by_alias[re.sub(r"\s", "", m["alias"]).replace(",", ".").lower()].append(m)
        sup = re.match(r"^([123])ПБ([\d.,]+)-(\d+)-(\d+)$", str(m.get("supplierMark") or "").replace(" ", ""))
        if sup:
            by_pb[(sup.group(2), PB_WIDTH[sup.group(1)], sup.group(4))].append(m)
    return by_name, by_alias, by_pb


def match(item, indexes):
    """(модель, способ) или (None, причина). Способы: по названию; по номеру ПЦ-n; по типоразмеру плиты ПБ."""
    by_name, by_alias, by_pb = indexes
    name = item["name"]
    found = by_name.get(norm(name))
    if found:
        return found[0], "по названию"
    pc = re.match(r"^ПЦ[\d,.]+-(\d+)$", name.replace(" ", ""))
    if pc and by_alias.get(f"пц-{pc.group(1)}"):
        return by_alias[f"пц-{pc.group(1)}"][0], "по номеру ПЦ (название отличается)"
    pb = re.match(r"^ПБ\s*([\d,.]+?)\.(\d+)-(\d+)Вр1400-\d+$", name)
    if pb:
        length, width, load = pb.group(1).replace(",", "."), pb.group(2), pb.group(3)
        for (l2, w2, n2), models in by_pb.items():
            if w2 == width and n2 == load and abs(float(l2) - float(length)) < 0.06:
                return models[0], "по типоразмеру плиты ПБ"
    return None, ""


def missing_reason(item, models):
    name = item["name"]
    if re.match(r"^1ПБ\s*[\d,.]+\.[\d,]+-24Вр1400", name):
        return "типоразмер заводской плиты 1ПБ, на схеме не используется (в каталоге только марки схемы)"
    series = re.match(r"^(?:Колонна|Ригель)\s*(\d*[A-Za-zА-Яа-я]+)", name)
    if series:
        key = series.group(1).translate(LOOK).upper()
        known = {re.match(r"^(?:Колонна|Ригель)\s*(\d*[A-Za-zА-Яа-я]+)", str(m.get("mark") or "")).group(1).translate(LOOK).upper()
                 for m in models.values() if re.match(r"^(?:Колонна|Ригель)\s*\d*[A-Za-zА-Яа-я]+", str(m.get("mark") or ""))}
        return "серии «%s» в каталоге нет" % series.group(1) if key not in known else "серия «%s» в каталоге есть, этого номера нет" % series.group(1)
    return "не найдено по названию"


def scheme_counts(calc_conn, scheme_db, objects):
    """Число элементов схемы на модель каталога: элементы → изделие (тот же marks.resolve, что у кнопки «Открыть в калькуляторе») → модель."""
    from app.calc import marks
    model_of = {r["id"]: r["document_model_id"] for r in calc_conn.execute("SELECT id,document_model_id FROM products")}
    db = sqlite3.connect(f"file:{scheme_db}?mode=ro", uri=True)
    counts = collections.Counter()
    marks_count = 0
    query = "SELECT element_type, mark, COUNT(*) FROM elements WHERE is_current=1 AND object_id IN (%s) GROUP BY element_type, mark" % ",".join("?" * len(objects))
    for element_type, mark, n in db.execute(query, objects):
        mark = (mark or "").strip()
        if not mark:
            continue
        res = marks.resolve(calc_conn, [{"mark": mark, "type": element_type}])[mark]
        marks_count += 1
        if res["status"] == "found":
            counts[model_of.get(res["productId"])] += n
    return counts, marks_count


def conclusion(per, kp, calc_v):
    """Кто из трёх (столбец K таблицы, объём по КП, каталог) расходится с остальными."""
    close = lambda a, b: a and b and abs(float(a) / float(b) - 1) <= VOLUME_TOLERANCE
    if kp and close(calc_v, kp):
        return "каталог = объём по КП; ошибка в столбце K таблицы"
    if kp and close(per, kp):
        return "таблица согласована с КП, а каталог расходится: проверить каталог"
    return "расходятся все три значения: проверить по листу" if kp else "объёма по КП нет: проверить по листу"


def guess_cause(ratio):
    for factor, text in ((10, "сдвиг запятой (×10)"), (3, "в таблице втрое меньше (вероятно, объём на 1 из 3 шт.)"), (2, "в таблице вдвое меньше")):
        if abs(ratio - 1 / factor) < 0.03 * (1 / factor) or abs(ratio - factor) < 0.03 * factor:
            return text
    return ""


def write_sheet(wb, title, header, rows, widths=None):
    ws = wb.create_sheet(title)
    ws.append(header)
    for row in rows:
        ws.append(row)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="D9E2F3")
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "A2"
    for i, w in enumerate(widths or [], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    return ws


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--calc-db", default=str(ROOT / "data/calc/calczhbi.sqlite3"))
    parser.add_argument("--scheme-db", default=str(ROOT / "data/zhbi.anon.db"))
    parser.add_argument("--objects", default="1,2", help="объекты схемы ЖБИ, элементы которых сравниваются с количеством в таблице")
    parser.add_argument("--out", default=str(ROOT / "data/calc/list1-audit.xlsx"))
    args = parser.parse_args()

    from app.calc.document_models import catalog
    models = catalog()
    items = read_list(args.workbook)
    indexes = build_indexes(models)
    calc_conn = sqlite3.connect(f"file:{args.calc_db}?mode=ro", uri=True)
    calc_conn.row_factory = sqlite3.Row
    scheme, scheme_marks = ({}, 0)
    if Path(args.scheme_db).exists():
        scheme, scheme_marks = scheme_counts(calc_conn, args.scheme_db, [int(x) for x in args.objects.split(",")])

    matched, missing, volume_rows, file_qty, file_volume = [], [], [], collections.Counter(), collections.Counter()
    ways = collections.Counter()
    for item in items:
        model, how = match(item, indexes)
        if not model:
            missing.append(item)
            continue
        ways[how] += 1
        per = float(item["volume"]) / float(item["pieces"]) if item["pieces"] and item["volume"] else None
        calc_v = model.get("projectVolume")
        diff = (per / float(calc_v) - 1) if per and calc_v else None
        file_qty[model["id"]] += int(item["pieces"] or 0)
        file_volume[model["id"]] += float(item["volume"] or 0)
        matched.append((item, model, how, per, calc_v, diff))
        if diff is not None and abs(diff) > VOLUME_TOLERANCE:
            volume_rows.append([item["name"], model.get("mark"), model.get("alias"), item["pieces"], round(per, 4), item["kp_volume"], calc_v, round(100 * diff, 1),
                                conclusion(per, item["kp_volume"], calc_v), guess_cause(per / float(calc_v)), how])
    volume_rows.sort(key=lambda r: (r[8], -abs(r[7])))
    verdicts = collections.Counter(r[8] for r in volume_rows)

    compared = [m for m in matched if m[5] is not None]
    agree = sum(1 for m in compared if abs(m[5]) <= VOLUME_TOLERANCE)
    qty_rows, qty_agree, qty_models = [], 0, 0
    if scheme:
        seen = set()
        for model_id in sorted(set(file_qty) | set(scheme), key=lambda i: str((models.get(i) or {}).get("alias"))):
            m = models.get(model_id)
            if not m:
                continue
            in_file, on_scheme = file_qty.get(model_id, 0), scheme.get(model_id, 0)
            qty_models += 1
            if in_file == on_scheme:
                qty_agree += 1
                continue
            note = "нет в таблице" if not in_file else "нет на схеме" if not on_scheme else ""
            qty_rows.append([m.get("alias"), m.get("mark"), in_file, on_scheme, in_file - on_scheme, note])
        qty_rows.sort(key=lambda r: -abs(r[4]))

    # суммарный объём: «м³ всего» таблицы против «элементов на схеме × объём изделия в каталоге» — не зависит от того, верен ли столбец «шт.»
    total_rows, total_agree, total_models = [], 0, 0
    for model_id, in_file in file_volume.items():
        m = models.get(model_id)
        on_scheme = scheme.get(model_id, 0)
        if not (m and m.get("projectVolume") and on_scheme and in_file):
            continue
        total_models += 1
        expected = on_scheme * float(m["projectVolume"])
        diff = in_file / expected - 1
        if abs(diff) <= VOLUME_TOLERANCE:
            total_agree += 1
        else:
            total_rows.append([m.get("alias"), m.get("mark"), round(in_file, 3), on_scheme, m["projectVolume"], round(expected, 3), round(100 * diff, 1), file_qty.get(model_id)])
    total_rows.sort(key=lambda r: -abs(r[6]))

    wb = openpyxl.Workbook()
    summary = wb.active
    summary.title = "Сводка"
    lines = [
        ("Позиций в таблице (строки с количеством)", len(items)),
        ("Найдено в каталоге калькулятора", len(matched)),
        *[(f"   способ: {k}", v) for k, v in ways.items()],
        ("Не найдено в каталоге", len(missing)),
        ("Сравнено объёмов одного изделия", len(compared)),
        (f"   совпали в пределах {int(VOLUME_TOLERANCE * 100)}%", agree),
        ("   расходятся", len(compared) - agree),
        *[(f"      {k}", v) for k, v in verdicts.items()],
        ("Изделий каталога, сравнённых по количеству с схемой", qty_models if scheme else "схема не подключена"),
        ("   количество совпало", qty_agree if scheme else ""),
        ("   количество расходится", len(qty_rows) if scheme else ""),
        ("Суммарный объём: изделий в таблице и на схеме одновременно", total_models if scheme else ""),
        ("   «м³ всего» таблицы = схема × объём каталога (в пределах 2%)", total_agree if scheme else ""),
        ("   расходится", len(total_rows) if scheme else ""),
        ("Пар «тип + марка» схемы, разобранных для сравнения", scheme_marks),
    ]
    for line in lines:
        summary.append(list(line))
    summary.column_dimensions["A"].width = 70
    summary.column_dimensions["B"].width = 16
    write_sheet(wb, "Объём - расхождения", ["Название в таблице", "Марка в каталоге", "Обозначение", "Штук в таблице", "м³ на 1 шт. (столбец K ÷ шт.)", "м³ на 1 шт. по КП (факт)", "м³ на 1 шт. (каталог)", "Расхождение каталога со столбцом K, %", "Вывод", "Вероятная причина", "Способ сопоставления"], volume_rows, [52, 52, 14, 12, 16, 16, 14, 16, 62, 40, 30])
    write_sheet(wb, "Количество - таблица и схема", ["Обозначение", "Марка в каталоге", "Штук в таблице", "Элементов на схеме", "Разница (таблица − схема)", "Примечание"], qty_rows, [14, 56, 14, 16, 18, 20])
    write_sheet(wb, "Суммарный объём", ["Обозначение", "Марка в каталоге", "м³ всего (таблица)", "Элементов на схеме", "м³ на 1 шт. (каталог)", "Ожидается: схема × каталог, м³", "Расхождение, %", "Штук в таблице"], total_rows, [14, 56, 16, 14, 14, 20, 12, 12])
    write_sheet(wb, "Нет в каталоге", ["Название в таблице", "Раздел таблицы", "Штук", "м³ всего", "Цена КП за ед., ₽ с НДС", "Причина (предположение)"],
                [[i["name"], i["group"], i["pieces"], i["volume"], i["unit_price"], missing_reason(i, models)] for i in missing], [60, 28, 8, 10, 18, 70])
    write_sheet(wb, "Сопоставление и цена КП", ["Название в таблице", "Марка в каталоге", "Обозначение", "Способ", "Штук", "м³ на 1 шт. (таблица)", "м³ на 1 шт. (каталог)", "Цена КП за ед., ₽ с НДС", "Цена КП за 1 м³, ₽ с НДС"],
                [[i["name"], m.get("mark"), m.get("alias"), how, i["pieces"], round(per, 4) if per else None, v, i["unit_price"], i["price_m3"]] for i, m, how, per, v, _ in matched], [52, 52, 14, 30, 8, 14, 14, 18, 18])
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    wb.save(args.out)

    print(f"позиций в таблице: {len(items)}; найдено в каталоге: {len(matched)} ({dict(ways)}); не найдено: {len(missing)}")
    print(f"объём одного изделия: сравнено {len(compared)}, совпало ≤{int(VOLUME_TOLERANCE * 100)}%: {agree}, расходится: {len(compared) - agree}")
    for k, v in verdicts.items():
        print(f"   {k}: {v}")
    if scheme:
        print(f"количество: изделий {qty_models}, совпало {qty_agree}, расходится {len(qty_rows)} (марок схемы разобрано {scheme_marks})")
        print(f"суммарный объём (таблица и схема есть одновременно): {total_models}, совпал {total_agree}, расходится {len(total_rows)}")
    print("отчёт:", args.out)


if __name__ == "__main__":
    main()
