"""Read-only inventory of scheme marks, calculator products, readings and stock slabs.

Run: .venv312/bin/python scripts/audit_calc_catalog_coverage.py --out /tmp/coverage.json
Customer data is written only to the requested report; neither database is changed.
"""
import argparse
import collections
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.calc import document_models as dm  # noqa: E402
from app.calc.marks import normalize, resolve  # noqa: E402
from app.calc.readings import embedded_verified  # noqa: E402


def connect_readonly(path):
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def stock_slabs(assets):
    """Extract stock slab positions from the native text of the two floor schedules.

    These are supplier references, not the separate 4Пд/4ПИ drawing catalog.
    Values remain source facts; no concrete volume/class/rebar is inferred.
    """
    import pypdfium2 as pdfium
    rows = []
    for doc, page in ((19, 87), (20, 227)):
        with pdfium.PdfDocument(assets / "sources" / f"doc{doc:02d}.pdf") as pdf:
            sheet = pdf[page - 1]
            textpage = sheet.get_textpage()
            text = textpage.get_text_range()
            textpage.close(); sheet.close()
        for match in re.finditer(r"(?<!\w)([1-4])\s*П\s*-\s*(\d+)\b", text):
            length = re.search(r"\bL=\s*(\d+)", text[match.end():])
            if not length: continue
            row = text[match.end():match.end() + length.end()]
            full = re.search(r"[1-3]\s*ПБ\s*\d[\d.,]*-(?:24\s*Вр\s*1400-\d+|\d+-\d+)", row)
            if not full: continue
            numbers = row[full.end():row.index("L=")].split()
            if len(numbers) < 2 or not all(n.isdigit() for n in numbers):
                raise ValueError(f"Unparsed source row: doc{doc}, page {page}: {row}")
            rows.append({"mark": match[1] + "П-" + match[2], "supplierMark": re.sub(r"\s+", "", full[0]),
                         "sourceQty": int(numbers[-2]), "massKg": int(numbers[-1]), "lengthMm": int(length[1]),
                         "doc": doc, "page": page})
    return rows


def audit(args):
    dm.ASSETS = args.assets.resolve()
    dm.catalog.cache_clear()
    catalog = dm.catalog()
    registry = {k: v for k, v in catalog.items() if v.get("kind") == "registry"}
    readings = json.loads((args.assets / "promka-readings.json").read_text())
    main = connect_readonly(args.scheme_db)
    calc = connect_readonly(args.calc_db)
    try:
        main.execute("BEGIN"); calc.execute("BEGIN")
        marks = main.execute("""SELECT m.name, m.element_type, m.object_id, COUNT(e.id) AS elements
            FROM marks m JOIN elements e ON e.mark_id=m.id AND e.is_current=1 GROUP BY m.id""").fetchall()
        kinds = collections.defaultdict(dict)
        for m in marks: kinds[m["element_type"]][m["name"]] = {"mark": m["name"], "type": m["element_type"]}
        links = {(kind, name): value for kind, items in kinds.items()
                 for name, value in resolve(calc, list(items.values())).items()}
        products = calc.execute("SELECT name,document_model_id FROM products").fetchall()
    finally:
        main.close(); calc.close()
    counts = collections.Counter(links[(m["element_type"], m["name"])]["status"] for m in marks)
    gaps = [{"mark": m["name"], "type": m["element_type"], "objectId": m["object_id"], "elements": m["elements"],
             **links[(m["element_type"], m["name"])]} for m in marks if links[(m["element_type"], m["name"])]["status"] != "found"]
    families = collections.defaultdict(lambda: collections.Counter())
    for key, model in registry.items():
        group = families[model["family"]]
        group["total"] += 1
        group["readings"] += key in readings
        group["volume"] += bool(model.get("projectVolume"))
        group["concreteClass"] += model.get("concreteClass") not in (None, "", "Не указан")
        group["rebar"] += any(r["id"].startswith("steel") for r in model.get("resources") or [])
    aliases = {normalize(v.get("alias")) for v in registry.values()}
    active = collections.Counter()
    for m in marks:
        if m["element_type"] == "Плита перекрытия": active[normalize(m["name"])] += m["elements"]
    stock = stock_slabs(args.assets)
    for row in stock:
        row["inCatalog"] = normalize(row["mark"]) in aliases
        row["onActiveScheme"] = normalize(row["mark"]) in active
        row["schemeQty"] = active.get(normalize(row["mark"]), 0)
        row["sourceMinusScheme"] = row["sourceQty"] - row["schemeQty"]
    ids = {p["document_model_id"] for p in products}
    missing = [{"id": key, "mark": registry[key]["alias"]} for key in sorted(set(registry) - ids)]
    return {"capturedAt": datetime.now(ZoneInfo("Europe/Moscow")).isoformat(),
            "scheme": {"marks": len(marks), "elements": sum(m["elements"] for m in marks), "links": dict(counts),
                       "unmatchedElements": sum(m["elements"] for m in gaps), "gaps": gaps},
            "catalog": {"registryEntries": len(registry), "calculatorProducts": len(products),
                        "registryNotInDatabase": missing,
                        "databaseNotInRegistry": [dict(p) for p in products if p["document_model_id"] not in registry],
                        "families": {name: dict(values) for name, values in families.items()},
                        "withoutReading": sorted(set(registry) - set(readings)),
                        "failedEmbedded": [registry[k]["alias"] for k, v in readings.items()
                                           if k in registry and embedded_verified(v) is False]},
            "stockSlabs": stock,
            "limits": ["Existing catalog completeness does not imply coverage of all scheme marks.",
                       "Stock source rows come from floor schedules doc19:87 and doc20:227, not factory reinforcement drawings.",
                       "No similarly named products are linked and no source/calculation values are changed."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scheme-db", type=Path, default=ROOT / "data/zhbi.db")
    parser.add_argument("--calc-db", type=Path, default=ROOT / "data/calc/calczhbi.sqlite3")
    parser.add_argument("--assets", type=Path, default=ROOT / "data/calc/assets")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print("Scheme:", result["scheme"]["marks"], "marks; links:", result["scheme"]["links"])
    print("Stock slab source rows:", len(result["stockSlabs"]), "; absent from catalog:", sum(not s["inCatalog"] for s in result["stockSlabs"]))
    print("Report:", args.out)
