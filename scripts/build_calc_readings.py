"""Сборка слоя «прочитано с листа» для калькулятора: объём и класс бетона, арматура по классам и диаметрам, закладные/трубы/петли — по листам
изделий (data/calc/assets/sources/docNN.pdf, только чтение). Результат — JSON, который кладут рядом с каталогом (assets/promka-readings.json);
сервис накладывает его на каталог только там, где у изделия пробел (app/calc/readings.py). Метод — scripts/prototypes/vector_ocr/.

Запуск (нужны pypdfium2, Pillow, numpy; ~20 минут на все колонны, подъёмники и шахты; кэш разобранных листов ускоряет повторы):
    ZHBI_CALC_ASSETS_DIR=…/data/calc/assets .venv312/bin/python scripts/build_calc_readings.py out.json [--families Колонны,Подъёмники,Шахты лифтов]
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
        return (n, p, sp["rows"] if sp else None, _plain(sheet) if sheet else None)
    except Exception as error:
        return (n, p, None, None)


def _plain(sheet):
    return {"rods": [[c, d, kg] for (c, d), kg in sheet["rods"].items()], "rebar_total": sheet["rebar_total"], "checks": sheet["checks"]}


def load_cache():
    return {tuple(map(int, k.split(":"))): v for k, v in json.loads(CACHE.read_text()).items()} if CACHE.exists() else {}


def save_cache(cache):
    CACHE.write_text(json.dumps({"%d:%d" % k: v for k, v in cache.items()}, ensure_ascii=False))


def main(out, families):
    from app.calc import document_models as dm
    catalog = dm.catalog()
    models = {k: v for k, v in catalog.items() if v.get("family") in families and (v.get("source") or {}).get("id") and v["source"].get("productPage")}
    offset = steel.sheet_offsets(catalog.values())
    print("моделей:", len(models), "смещения листов:", offset)
    cache = load_cache()
    frontier = {(int(v["source"]["id"][3:]), int(v["source"]["productPage"])) for v in models.values()}
    with Pool(4) as pool:
        while frontier:
            todo = sorted(k for k in frontier if k not in cache)
            if todo:
                for n, p, rows, sheet in pool.map(read_rows, todo, chunksize=2): cache[(n, p)] = {"rows": rows, "steel": sheet}
                save_cache(cache)
            nxt = set()
            for key in frontier:
                for row in (cache[key]["rows"] or []):
                    if steel.SKIP_RE.match(row.get("name", "") or "") or steel.parse_rod(row.get("name")): continue
                    for ref in steel.REF_RE.findall(row.get("oboz", "") or ""):
                        target = (key[0], int(ref) + offset.get(key[0], 0))
                        if target[1] >= 1 and target not in cache: nxt.add(target)
            print("слой: прочитано листов", len(todo), "следующий слой", len(nxt), flush=True)
            frontier = nxt
    def make_assembler():
        return steel.RebarAssembler(lambda d, p: (cache.get((d, p)) or {}).get("rows"), offset)

    def assemble_all():
        asm = make_assembler()
        for v in models.values(): asm.assemble(int(v["source"]["id"][3:]), int(v["source"]["productPage"]), None, None)
        return asm
    assembler = assemble_all()
    # узлы, чьи листы не нашлись по ссылке: дочитываем окно страниц вокруг ожидаемой и повторяем сборку (ссылка «л.108» могла быть прочитана с ошибкой)
    extra = {(d, q) for d, c in assembler.problems for q in range(max(1, c - assembler.window), c + assembler.window + 1) if (d, q) not in cache}
    if extra:
        print("дочитываем окна вокруг неразрешённых ссылок:", len(extra), "листов", flush=True)
        with Pool(4) as pool:
            for n, p, rows, sheet in pool.map(read_rows, sorted(extra), chunksize=2): cache[(n, p)] = {"rows": rows, "steel": sheet}
        save_cache(cache)
        assembler = assemble_all()
    result = {}
    for key, v in models.items():
        doc, page = int(v["source"]["id"][3:]), int(v["source"]["productPage"])
        entry = cache.get((doc, page)) or {}; rows = entry.get("rows") or []
        item = {"sheet": {"doc": doc, "page": page}, "method": "vector_ocr", "confirmed": False}
        for r in rows:
            m = re.match(r"^[БВ]етон", r.get("name", "") or "")
            if m:
                cls = re.search(r"[ВB]\s?(\d+)", r["name"]); volume = steel.num(r.get("qty"))
                if cls: item["concreteClass"] = "В" + cls.group(1)
                if volume: item["volume"] = volume
        tree = assembler.assemble(doc, page, None, None)
        rods = {k: v2 for k, v2 in tree["rods"].items()}
        item["rebar"] = {"fromAssembly": [[c, d, round(kg, 3)] for (c, d), kg in sorted(rods.items())], "unresolvedKg": round(tree["unresolved"], 3), "issues": tree["issues"][:6]}
        if entry.get("steel"): item["rebar"]["fromSteelSheet"] = entry["steel"]["rods"]; item["rebar"]["steelSheetChecks"] = entry["steel"]["checks"]
        result[key] = item
    Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print("записано:", out, len(result))


if __name__ == "__main__":
    fam = ["Колонны", "Подъёмники", "Шахты лифтов", "Лестничные балки"]
    if "--families" in sys.argv: fam = sys.argv[sys.argv.index("--families") + 1].split(",")
    main(sys.argv[1], fam)
