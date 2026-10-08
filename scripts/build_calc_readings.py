"""Сборка слоя «прочитано с листа» для калькулятора: объём и класс бетона, арматура по классам и диаметрам, закладные/трубы/петли — по листам
изделий (data/calc/assets/sources/docNN.pdf, только чтение). Результат — JSON, который кладут рядом с каталогом (assets/promka-readings.json);
сервис накладывает его на каталог только там, где у изделия пробел (app/calc/readings.py). Метод — scripts/prototypes/vector_ocr/.

Запуск (VOCR_REPARSE=1 перечитывает только листы без сошедшейся ведомости; процессов 8, меняется переменной VOCR_PROCS; нужны pypdfium2, Pillow, numpy; ~20 минут на все колонны, подъёмники и шахты; кэш разобранных листов ускоряет повторы):
    ZHBI_CALC_ASSETS_DIR=…/data/calc/assets .venv312/bin/python scripts/build_calc_readings.py out.json [--families Колонны,Подъёмники,Шахты лифтов]
Для обновления хвоста без изменения прежних принятых значений: --preserve-accepted before.json (полная сборка всех групп).
"""
import collections
import json
import os
import re
import sys
from multiprocessing import Pool
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts" / "prototypes" / "vector_ocr"))
import steel, tables as tb, textcells as tc, train_font as tf, vector_ocr as vo  # noqa: E402

CACHE = Path(os.environ.get("VOCR_CACHE", "/tmp/calc-readings-rows.json"))
FONT = None


def read_rows(args):
    """(doc, страница) → строки спецификации листа (список словарей по ролям столбцов) или None; ошибка чтения — None."""
    global FONT
    n, p = args
    if FONT is None: FONT = tc.Font(str(ROOT / "scripts" / "prototypes" / "vector_ocr" / "font_protos.json"))
    try:
        segs = vo.segments(tf.D + "doc%02d.pdf" % n, p); H, V = tb.frame_lines(segs); gl, Ls = tf.load_sheet(n, p, minlen=1)
        boxes = tb.text_in_boxes(gl, Ls, FONT, H, V); sp = tb.parse_spec(boxes)
        sheet = steel.parse_steel(boxes)
        if sheet: sheet = steel.fill_strand(sheet, sp["rows"] if sp else None)
        return (n, p, sp["rows"] if sp else None, _plain(sheet) if sheet else None, steel.sheet_node_marks(boxes))
    except Exception as error:
        return (n, p, None, None, [])


def _plain(sheet):
    return {"rods": [[c, d, kg] for (c, d), kg in sheet["rods"].items()], "rebar_total": sheet["rebar_total"], "checks": sheet["checks"], "embedded_total": sheet.get("embedded_total")}


def load_cache():
    return {tuple(map(int, k.split(":"))): v for k, v in json.loads(CACHE.read_text()).items()} if CACHE.exists() else {}


def save_cache(cache):
    CACHE.write_text(json.dumps({"%d:%d" % k: v for k, v in cache.items()}, ensure_ascii=False))


def store_rows(cache, parsed):
    n, p, rows, sheet, marks = parsed
    cache[(n, p)] = {"rows": rows, "steel": sheet, "node_marks": marks, "numeric_version": 3}


def needs_numeric_refresh(entry):
    """Старый кэш: одиночная «е», буквенная ссылка/размер стержня или безымянный итог узла без штампа."""
    if entry.get("numeric_version", 0) >= 3: return False
    rows = entry.get("rows") or []
    return any((r.get("qty") == "е" and r.get("pos") and r.get("name"))
               or re.search(r"л\.\s*[\dйОо]*[вАУе]", r.get("oboz") or "")
               or re.search(r"(?:^[ØИ][·АУ]+|L=\s*[·АУ])", r.get("name") or "")
               or (set(r) == {"mass"} and steel.num(r["mass"])) for r in rows)


def last_number(text):
    """Последнее число в марке для порядка плит одной таблицы: «4Пд-14» → 14, «Пл2.1» → 2.1."""
    found = re.findall(r"\d+(?:\.\d+)?", (text or "").replace(" ", ""))
    return float(found[-1]) if found else 0.0


def plate_table(models, cache):
    """Плиты, у которых на листе одна таблица на несколько марок (строка = плита: объём бетона и/или масса единицы). Строки сопоставляются с изделиями
    по ПОРЯДКУ (марки в названиях строк OCR искажает, а в исходнике бывают опечатки): изделия листа, упорядоченные по номеру в марке, и строки с позицией —
    только если их поровну. {ключ модели: {'volume': м³ или None, 'mass': кг}} (на листах «объём бет.» есть, на других только масса)."""
    groups = collections.defaultdict(list)
    for key, v in models.items():
        if v.get("family") == "Плиты": groups[(int(v["source"]["id"][3:]), int(v["source"]["productPage"]))].append((key, v))
    out = {}
    for page_key, members in groups.items():
        rows = []
        for r in (cache.get(page_key) or {}).get("rows") or []:
            if not (r.get("pos") or "").strip() or not r.get("name"): continue
            qty, mass = steel.num(r.get("qty")), steel.num(r.get("note")) or steel.num(r.get("mass"))
            volume = qty if qty and "." in (r.get("qty") or "") and qty < 20 else None
            if volume or (mass and mass > 300): rows.append({"volume": volume, "mass": mass})
        members.sort(key=lambda kv: (last_number(kv[1].get("alias")), kv[1].get("alias") or ""))
        if len(rows) != len(members): continue
        for (key, v), row in zip(members, rows): out[key] = row
    return out


def preserve_accepted(result, before):
    """При обновлении хвоста сохраняем уже принятые разделы; новые чтения заполняют пробелы.

    Перечитанный кандидат остаётся в кэше. Изменение принятой арматуры требует отдельной сверки,
    поэтому не подменяет результат при консервативном обновлении файла чтений.
    """
    from verify_calc_readings_regression import accepted
    retained = collections.Counter()
    for key, item in result.items():
        old = before.get(key)
        if not old: continue
        previous, current = accepted(old), accepted(item)
        fields = []
        for field, value in previous.items():
            if value is not None and value != current[field]:
                item[field] = old[field]
                if field == "volume": item["volumeSource"] = old.get("volumeSource")
                retained[field] += 1; fields.append(field)
        if fields: item["retainedAccepted"] = fields
    return dict(retained)


def main(out, families, before_path=None):
    from app.calc import document_models as dm
    catalog = dm.catalog()
    models = {k: v for k, v in catalog.items() if v.get("family") in families and (v.get("source") or {}).get("id") and v["source"].get("productPage")}
    offset = steel.sheet_offsets(catalog.values())
    print("моделей:", len(models), "смещения листов:", offset)
    cache = load_cache()
    refresh = [k for k, v in cache.items() if needs_numeric_refresh(v)]
    if refresh:
        print("перечитываем числовые ячейки и штампы узлов:", len(refresh), flush=True)
        with Pool(int(os.environ.get("VOCR_PROCS", "8"))) as pool:
            for i, parsed in enumerate(pool.imap_unordered(read_rows, refresh), 1):
                store_rows(cache, parsed)
                if i % 20 == 0:
                    save_cache(cache)
                    print("перечитано:", i, "из", len(refresh), flush=True)
        save_cache(cache)
    if os.environ.get("VOCR_REPARSE"):
        # после правок разбора ведомости: перечитать только листы, где она не разобралась или не сошлись проверки (остальные остаются из кэша)
        stale = [k for k, v in cache.items() if v.get("steel") is None or not all(v["steel"]["checks"].values())
                 or not v.get("rows") or not any(r.get("qty") for r in v["rows"])      # спецификация не разобрана или разобрана без столбца «Кол.»
                 or any(r.get("mark") and not r.get("name") for r in v["rows"])]      # таблица серии без наименований стержней      # и листы, где спецификация разобрана без столбца «Кол.»
        for k in stale: del cache[k]
        print("перечитываем листы без сошедшейся ведомости:", len(stale), flush=True)
    frontier = {(int(v["source"]["id"][3:]), int(v["source"]["productPage"])) for v in models.values()}
    product_pages = set(frontier)
    # у ригелей серии 3Р… на листе изделия только чертёж («спецификацию и ведомость стали смотри лист 2»): спецификация на следующей странице,
    # если она не лист другого изделия. Сначала читаем листы изделий, затем добавляем следующие страницы тем, у кого спецификации не нашлось.
    todo = sorted(k for k in frontier if k not in cache)
    if todo:
        with Pool(int(os.environ.get("VOCR_PROCS", "8"))) as pool:
            for parsed in pool.map(read_rows, todo, chunksize=2): store_rows(cache, parsed)
        save_cache(cache)
    spec_next = {k for k in frontier if not (cache[k]["rows"] or []) and (k[0], k[1] + 1) not in product_pages}
    frontier |= {(d, p + 1) for d, p in spec_next}
    print("листов без спецификации, берём следующую страницу:", len(spec_next), flush=True)

    def spec_page(doc, page):
        return (doc, page + 1) if (doc, page) in spec_next else (doc, page)
    with Pool(int(os.environ.get("VOCR_PROCS", "8"))) as pool:
        while frontier:
            todo = sorted(k for k in frontier if k not in cache)
            if todo:
                for parsed in pool.map(read_rows, todo, chunksize=2): store_rows(cache, parsed)
                save_cache(cache)
            nxt = set()
            for key in frontier:
                for row in (cache[key]["rows"] or []):
                    if steel.SKIP_RE.match(row.get("name", "") or "") or steel.parse_rod(row.get("name"), steel.num(row.get("mass"))): continue
                    for ref in steel.ref_numbers(row.get("oboz", "") or ""):
                        target = (key[0], ref + offset.get(key[0], 0))
                        if target[1] >= 1 and target not in cache: nxt.add(target)
            print("слой: прочитано листов", len(todo), "следующий слой", len(nxt), flush=True)
            frontier = nxt
    def make_assembler():
        return steel.RebarAssembler(lambda d, p: (cache.get((d, p)) or {}).get("rows"), offset, pages=lambda d: [p for (dd, p) in cache if dd == d],
                                    marks=lambda d, p: (cache.get((d, p)) or {}).get("node_marks"))

    def assemble_all():
        asm = make_assembler()
        for v in models.values(): asm.assemble(*spec_page(int(v["source"]["id"][3:]), int(v["source"]["productPage"])), None, None)
        return asm
    assembler = assemble_all()
    # узлы, чьи листы не нашлись по ссылке: дочитываем окно страниц вокруг ожидаемой и повторяем сборку (ссылка «л.108» могла быть прочитана с ошибкой)
    extra = {(d, q) for d, c in assembler.problems for q in range(max(1, c - assembler.window), c + assembler.window + 1) if (d, q) not in cache}
    if extra:
        print("дочитываем окна вокруг неразрешённых ссылок:", len(extra), "листов", flush=True)
        with Pool(int(os.environ.get("VOCR_PROCS", "8"))) as pool:
            for parsed in pool.map(read_rows, sorted(extra), chunksize=2): store_rows(cache, parsed)
        save_cache(cache)
        assembler = assemble_all()
    result = {}
    plates = plate_table(models, cache)
    for key, v in models.items():
        doc, page = spec_page(int(v["source"]["id"][3:]), int(v["source"]["productPage"]))
        entry = cache.get((doc, page)) or {}; rows = entry.get("rows") or []
        item = {"sheet": {"doc": doc, "page": page}, "method": "vector_ocr", "confirmed": False}
        if page != int(v["source"]["productPage"]): item["sheet"]["drawingPage"] = int(v["source"]["productPage"])
        mass_total = None
        for r in rows:
            m = re.match(r"^[БВ]етон", r.get("name", "") or "")
            if m:
                cls = re.search(r"[ВB]\s?(\d+)", r["name"]); volume = steel.num(r.get("qty"))
                if cls: item["concreteClass"] = "В" + cls.group(1)
                if volume: item["volume"] = volume; item["volumeSource"] = "спецификация"
            elif re.match(r"^Масса", r.get("name", "") or ""):
                mass_total = steel.num(r.get("qty")) or steel.num(r.get("mass"))
        plate = plates.get(key)
        if not item.get("volume") and plate and plate["volume"]:
            item["volume"] = plate["volume"]; item["volumeSource"] = "таблица плит"
        if plate and plate["mass"]: mass_total = mass_total or plate["mass"]
        # масса изделия в проекте = объём бетона × 2500 кг/м³ (у колонн, подъёмников, шахт, лестничных балок и панелей сходится на 100%, у ригелей на ±3%):
        # где объём не прочитан, а масса есть, объём — масса ÷ 2500
        if not item.get("volume") and mass_total and mass_total > 300:
            item["volume"] = round(mass_total / 2500, 3); item["volumeSource"] = "масса ÷ 2500"
        if mass_total: item["massKg"] = mass_total
        tree = assembler.assemble(doc, page, steel.mark_key(v.get("alias")) or None, None)
        rods = {k: v2 for k, v2 in tree["rods"].items()}
        item["rebar"] = {"fromAssembly": [[c, d, round(kg, 3)] for (c, d), kg in sorted(rods.items())], "unresolvedKg": round(tree["unresolved"], 3), "issues": tree["issues"][:6]}
        item["embedded"] = {"items": [[kind, name, mass, qty, steel.pipe_size(name) if kind == "pipe" else None, steel.pipe_length_m(name, qty) if kind == "pipe" else None] for (kind, name, mass), qty in sorted(tree["emb"].items())], "issues": [i for i in tree["issues"] if "нет количества" in i][:6]}
        if (entry.get("steel") or {}).get("embedded_total") is not None: item["embedded"]["sheetTotalKg"] = entry["steel"]["embedded_total"]
        if entry.get("steel"): item["rebar"]["fromSteelSheet"] = entry["steel"]["rods"]; item["rebar"]["steelSheetChecks"] = entry["steel"]["checks"]
        result[key] = item
    if before_path:
        before = json.loads(Path(before_path).read_text())
        retained = preserve_accepted(result, before)
        from verify_calc_readings_regression import compare
        errors, _, _ = compare(before, result)
        if errors: raise ValueError("Не сохранены принятые результаты: %s" % errors[:3])
        print("сохранено прежних принятых разделов:", retained)
    Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print("записано:", out, len(result))


if __name__ == "__main__":
    fam = ["Колонны", "Подъёмники", "Шахты лифтов", "Лестничные балки", "Ригели", "Плиты", "Цокольные панели"]
    if "--families" in sys.argv: fam = sys.argv[sys.argv.index("--families") + 1].split(",")
    before = sys.argv[sys.argv.index("--preserve-accepted") + 1] if "--preserve-accepted" in sys.argv else None
    main(sys.argv[1], fam, before)
