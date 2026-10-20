"""Внести в калькулятор ответы проектировщиков от 2026-10-19 и новые редакции альбомов.

Что делает (идемпотентно):
  * подключает как источники новые редакции томов (doc21 КЖ.И1-1.3 изм.7, doc22 КЖ.И7.1 изм.3, doc23 КЖ2-1 АБЧ изм.9, doc24 КЖ2-2 изм.7) и альбом плит
    УДС-1ПБ (doc25) отдельными файлами, не заменяя прежние doc04/15/19/20: номера страниц в новых редакциях сдвинулись;
  * исключает из расчёта монолитные колонны Км1…Км4 (7 моделей) и плиту 4П-15, которой нет в проекте: модель получает поле excluded, изделие удаляется из базы
    (с зависимыми версиями расчёта; полная копия строк остаётся в резервной копии);
  * 4П-2: масса 2095 кг, объём 0,838 м³; ПЦ-5: лист 9 из новой редакции, В25, 1,78 м³;
  * класс бетона плит: 4П — по последнему числу в марке, 1П–3П и «Пл» — В30 (ответ: марка бетона в названии изделия, альбом УДС-1ПБ, п.1.8);
  * закладные 13КВ2.5 и 13К82.7: подтверждены проектировщиками (ЗД5 — 9 шт.), сверка с ошибочным итогом ведомости не нужна.
Без --apply работает на копиях (staging) и ничего не меняет в рабочих данных.

Запуск (Python 3.12):
    .venv312/bin/python scripts/apply_calc_designer_answers.py --documents "…/CalcZhBI/Документы" [--apply]
"""
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pypdfium2 as pdfium  # noqa: E402

DATE = "2026-10-19"
BASIS = "Ответ проектировщиков " + DATE
NEW_SOURCES = {
    "doc21": ("77_113_114-Р-КЖ.И1-1.3-Сб. ж.б. колонны верхние. Производ. часть изм.7 16.10.26.pdf", "Изм.7 от 16.10.26", "doc04"),
    "doc22": ("77_113_114-Р-КЖ.И7.1-Цокольные стеновые панели. Произв. часть изм.3 13.04.26.pdf", "Изм.3 от 13.04.26", "doc15"),
    "doc23": ("77_113_114-Р-КЖ2-1-Конструкц. ж.б. выше 0,000. АБЧ изм.9 16.10.26.pdf", "Изм.9 от 16.10.26", "doc19"),
    "doc24": ("77_113_114-Р-КЖ2-2-Конструкц. ж.б. выше 0,000. Производ. часть изм.7 19.10.26.pdf", "Изм.7 от 19.10.26", "doc20"),
    "doc25": ("Альбом УДС-1ПБ3.02.2020 плиты ж.б многопустотные 300 мм (1).pdf", "Альбом УДС-1ПБ3.02.2020", None),
}
ASSET_FILES = ("promka-register.json", "promka-readings.json", "promka-reviewed-readings.json", "promka-sources.json", "promka-discrepancies.json")


def sha256(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def plate_class_evidence(text):
    return {"sourceId": "doc25", "pdfPage": 3, "label": text + " (альбом УДС-1ПБ3.02.2020, п.1.8; " + BASIS + ")", "url": "/calc/api/document-source/doc25#page=3"}


def edit_documents(docs, documents_dir):
    """docs: {имя файла: содержимое}. Возвращает (docs, отчёт). Ничего не пишет на диск."""
    from app.calc.readings import reviewed_page_matches
    reg, readings, reviewed, sources, discrepancies = (docs[n] for n in ASSET_FILES)
    report = {"новые источники": [], "исключено": [], "классы плит": [], "прочее": []}
    by_alias = {}
    for key, model in reg.items():
        by_alias.setdefault(model.get("alias"), []).append(key)

    # --- источники
    for source_id, (filename, revision, replaces) in NEW_SOURCES.items():
        path = Path(documents_dir) / filename
        if source_id in sources:
            continue
        sources[source_id] = {"storageName": source_id + ".pdf", "filename": filename, "sha256": sha256(path), "pages": len(pdfium.PdfDocument(str(path))),
                              "revision": revision, **({"supersedes": replaces} if replaces else {})}
        report["новые источники"].append("%s: %s, %d стр." % (source_id, revision, sources[source_id]["pages"]))

    def keys_of(alias, family=None):
        return [k for k in by_alias.get(alias, []) if family is None or reg[k].get("family") == family]

    def set_reading(key, **changes):
        base = copy.deepcopy(readings.get(key) or reviewed.get(key) or {"method": "source-review", "confirmed": False})
        for name, value in changes.items():
            if isinstance(value, dict) and isinstance(base.get(name), dict):
                base[name] = {**base[name], **value}
            else:
                base[name] = value
        readings[key] = base
        reviewed[key] = copy.deepcopy(base)
        reg[key]["readingMode"] = "reviewed"
        return base

    # --- исключённые изделия
    excluded = []
    for alias in ("Км1", "Км1.1", "Км2.1", "Км2.2", "Км3", "Км3.1", "Км4"):
        for key in keys_of(alias, "Колонны"):
            reg[key]["excluded"] = {"reason": "Монолитная колонна: на заводе не изготавливается, в калькуляцию не входит (спецификация монолитных колонн КЖ2-1 АБК). " + BASIS + ".",
                                    "label": "монолитная колонна", "date": DATE}
            excluded.append(key)
    for key in keys_of("4П-15", "Плиты"):
        reg[key]["excluded"] = {"reason": "Плиты 4П-15 нет ни в спецификации, ни на схеме расположения (КЖ2-1, КЖ2-2). " + BASIS + ".", "label": "в проекте отсутствует", "date": DATE}
        excluded.append(key)
    report["исключено"] = [reg[k]["alias"] for k in excluded]
    for item in discrepancies:
        if item["id"].startswith("km22-"):
            item["status"] = "resolved"
            item["resolution"] = "Км2.2 — монолитная колонна, из калькуляции исключена. " + BASIS + "."

    # --- 4П-2: масса и объём
    for key in keys_of("4П-2", "Плиты"):
        reg[key]["projectMassKg"] = 2095
        reg[key]["calculationPending"] = [p for p in reg[key].get("calculationPending", []) if p.get("key") != "stock-mass-conflict"]
        set_reading(key, massKg=2095, volume=round(2095 / 2500, 3), volumeSource="масса 2095 кг ÷ 2500 (" + BASIS + ")")
        report["прочее"].append("4П-2: масса 2095 кг, объём %.3f м³" % (2095 / 2500))

    # --- ПЦ-5: лист 9 новой редакции
    for key in keys_of("ПЦ-5", "Цокольные панели"):
        meta = sources["doc22"]
        reg[key]["source"] = {"id": "doc22", "title": meta["filename"], "revision": "Изм.3 (зам) от 13.04.26", "productPage": 18, "registerPage": 5, "sheet": "9",
                              "sha256": meta["sha256"], "pageVerified": True}
        reg[key]["calculationPending"] = [p for p in reg[key].get("calculationPending", []) if "drawing" not in p.get("key", "") and "sheet" not in p.get("key", "")]
        base = copy.deepcopy(readings[key])
        base["sheet"] = {"doc": 22, "page": 18, "ведомость расхода стали": 19}
        for stale in ("drawingMissing",):
            base["sheet"].pop(stale, None)
        base["volume"], base["volumeSource"], base["massKg"] = 1.78, "спецификация", 4450
        base["concreteClass"] = "В25"
        base["concreteClassSource"] = {"sourceId": "doc22", "pdfPage": 18, "label": "Лист 9: «Бетон кл. В25, м³ 1,780», масса 4450 кг (" + BASIS + ")", "url": "/calc/api/document-source/doc22#page=18"}
        readings[key] = base
        reviewed[key] = copy.deepcopy(base)
        report["прочее"].append("ПЦ-5: лист 9 (doc22, стр. 18), В25, 1,78 м³")

    # --- класс бетона плит
    def mark_classes(text):
        return sorted(set(re.findall(r"Вр1400-(\d+)", text or "")))
    for key, model in reg.items():
        if model.get("family") != "Плиты" or model.get("excluded"):
            continue
        alias = model.get("alias") or ""
        cls, text = None, None
        if re.match(r"^4П-\d+$", alias) and model.get("supplierMark"):
            found = mark_classes(model["supplierMark"])
            if len(found) == 1:
                cls, text = found[0], "Класс бетона — последнее число в марке %s" % model["supplierMark"]
        elif re.match(r"^[123]П-\d+$", alias):
            cls, text = "30", "Марка ПБ…Вр1400-30 в ВОР/КП: последнее число — класс бетона"
        elif re.match(r"^Пл\d", alias):
            found = mark_classes(model.get("mark"))
            if len(found) == 1:
                cls, text = found[0], "Марки плит …Вр1400-%s: последнее число — класс бетона" % found[0]
        if not cls:
            continue
        reading = copy.deepcopy(readings.get(key))
        if reading is None:
            continue
        source = model.get("source") or {}
        if model.get("readingMode") != "reviewed" and not reviewed_page_matches(reading, source):
            # чтение не привязано к странице изделия: класс кладём в сам каталог, чтобы не терять его при пересборке чтений
            model["concreteClass"] = "В" + cls
            model["concreteClassSource"] = plate_class_evidence(text)
            report["классы плит"].append("%s: В%s (в каталог)" % (alias, cls))
            continue
        set_reading(key, concreteClass="В" + cls, concreteClassSource=plate_class_evidence(text))
        report["классы плит"].append("%s: В%s" % (alias, cls))

    # --- закладные 13КВ2.5 и 13К82.7
    for alias in ("13КВ2.5", "13К82.7"):
        for key in keys_of(alias, "Колонны"):
            reading = copy.deepcopy(readings[key])
            if not reviewed_page_matches(reading, reg[key].get("source") or {}):
                report["прочее"].append("%s: чтение не привязано к странице изделия, закладные не подтверждены" % alias)
                continue
            set_reading(key, embedded={"confirmedBy": BASIS + ": ЗД5 — 9 шт. (л.118 и л.122 КЖ.И1-1.3); итог ведомости 172,17 кг завышен",
                                       "confirmedMassKg": round(sum(i[2] * i[3] for i in reading["embedded"]["items"] if i[0] in ("embedded", "pipe")), 2)})
            report["прочее"].append("%s: закладные подтверждены (ЗД5 — 9 шт.)" % alias)
    return docs, report, excluded


def apply_db(database, excluded_keys, backup_dir):
    """Удаляет изделия исключённых моделей вместе с версиями расчёта; строки сохраняет в резервную копию."""
    with sqlite3.connect(database, timeout=60) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        products = conn.execute("SELECT * FROM products WHERE document_model_id IN (%s)" % ",".join("?" * len(excluded_keys)), list(excluded_keys)).fetchall()
        removed = []
        saved = {}
        for p in products:
            pid = p["id"]
            saved[pid] = {"product": dict(p)}
            for table in ("calculation_versions", "product_resource_baselines", "extra_lines", "line_overrides", "product_verifications", "project_files"):
                rows = conn.execute("SELECT * FROM %s WHERE product_id=?" % table, (pid,)).fetchall()
                saved[pid][table] = [dict(r) for r in rows]
                conn.execute("DELETE FROM %s WHERE product_id=?" % table, (pid,))
            conn.execute("DELETE FROM products WHERE id=?", (pid,))
            conn.execute("INSERT INTO audit_log(actor_id,action,entity_id,detail_json,created_at) VALUES(?,?,?,?,?)",
                         ("system", "product.excluded", pid, json.dumps({"name": p["name"], "reason": BASIS}, ensure_ascii=False), datetime.now().isoformat(timespec="seconds")))
            removed.append(p["name"])
        conn.commit()
    if backup_dir and saved:
        (Path(backup_dir) / "deleted-products.json").write_text(json.dumps(saved, ensure_ascii=False, indent=1, default=str))
    return removed


def align_classes(database, catalog):
    """Класс бетона изделия в базе (сохранён при прежнем импорте, не ручная правка) главнее класса модели: выравнивает его по каталогу там, где они расходятся."""
    changed = []
    unset = lambda value: (value or "").strip().lower() in ("", "не указан")
    with sqlite3.connect(database, timeout=60) as conn:
        conn.row_factory = sqlite3.Row
        for row in conn.execute("SELECT id,name,concrete_class,manual_fields,document_model_id FROM products").fetchall():
            model = catalog.get(row["document_model_id"])
            if not model or unset(model.get("concreteClass")) or unset(row["concrete_class"]) or row["concrete_class"] == model["concreteClass"]:
                continue
            if "concreteClass" in json.loads(row["manual_fields"] or "[]"):
                continue
            conn.execute("UPDATE products SET concrete_class=? WHERE id=?", (model["concreteClass"], row["id"]))
            conn.execute("INSERT INTO audit_log(actor_id,action,entity_id,detail_json,created_at) VALUES(?,?,?,?,?)",
                         ("system", "product.class.aligned", row["id"], json.dumps({"name": row["name"], "was": row["concrete_class"], "now": model["concreteClass"], "basis": BASIS}, ensure_ascii=False),
                          datetime.now().isoformat(timespec="seconds")))
            changed.append("%s: %s → %s" % (row["name"], row["concrete_class"], model["concreteClass"]))
        conn.commit()
    return changed


def run(args):
    assets = Path(args.assets)
    docs = {name: json.loads((assets / name).read_text()) for name in ASSET_FILES}
    docs, report, excluded = edit_documents(copy.deepcopy(docs), args.documents)
    from app.calc import document_models as dm

    with tempfile.TemporaryDirectory(prefix="calc-answers-") as folder:
        stage = Path(folder) / "assets"
        stage.mkdir()
        for path in assets.iterdir():
            if path.name not in ASSET_FILES and path.name != "sources":
                (stage / path.name).symlink_to(path.resolve())
        (stage / "sources").mkdir()
        for path in (assets / "sources").iterdir():
            (stage / "sources" / path.name).symlink_to(path.resolve())
        for source_id, (filename, _, _) in NEW_SOURCES.items():
            (stage / "sources" / (source_id + ".pdf")).unlink(missing_ok=True)
            (stage / "sources" / (source_id + ".pdf")).symlink_to((Path(args.documents) / filename).resolve())
        for name, value in docs.items():
            (stage / name).write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n")
        staged_db = Path(folder) / "calczhbi.sqlite3"
        with sqlite3.connect(Path(args.database).resolve().as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(staged_db) as dst:
            src.backup(dst)
        removed = apply_db(staged_db, excluded, None)
        dm.ASSETS = stage
        dm.catalog.cache_clear()
        catalog = dm.catalog()
        print(json.dumps({"отчёт": report, "удалено изделий (на копии)": removed}, ensure_ascii=False, indent=1))
        comparison = compare(args, stage, staged_db, catalog)
        print(json.dumps(comparison, ensure_ascii=False, indent=1))
        if not args.apply:
            print("Предварительный просмотр: рабочие данные не менялись. Для применения добавьте --apply.")
            return

    database = Path(args.database)
    backup = database.parent / "backups" / ("designer-answers-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-apply")
    backup.mkdir(parents=True)
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(backup / database.name) as dst:
        src.backup(dst)
    for name in ASSET_FILES:
        shutil.copy2(assets / name, backup / name)
    for source_id, (filename, _, _) in NEW_SOURCES.items():
        target = assets / "sources" / (source_id + ".pdf")
        if not target.exists():
            shutil.copy2(Path(args.documents) / filename, target)
    for name, value in docs.items():
        temp = assets / (name + ".applying")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n")
        os.replace(temp, assets / name)
    removed = apply_db(database, excluded, backup)
    dm.ASSETS = assets
    dm.catalog.cache_clear()
    aligned = align_classes(database, dm.catalog())
    print(json.dumps({"применено": True, "резервная копия": str(backup), "удалено изделий": removed, "класс бетона выровнен": aligned}, ensure_ascii=False, indent=1))


def compare(args, stage, staged_db, new_catalog):
    """Сводка до/после: что изменилось в каталоге и готовности."""
    from app.calc import document_models as dm
    from app.calc.readiness import readiness
    live_assets = Path(args.assets)
    dm.ASSETS = live_assets
    dm.catalog.cache_clear()
    old_catalog = json.loads(json.dumps(dm.catalog()))
    with sqlite3.connect(Path(args.database).resolve().as_uri() + "?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        before = readiness(conn)
    dm.ASSETS = stage
    dm.catalog.cache_clear()
    with sqlite3.connect(staged_db) as conn:
        conn.row_factory = sqlite3.Row
        after = readiness(conn)
    def pick(r):
        return {"всего": r["total"], "готово": r["ready"], "процент": r["percent"], **{f["key"]: f["cumulative"] for f in r["funnel"]}, "армирование вне диапазона": r["reinforcement"]["low"] + r["reinforcement"]["high"]}
    changed = collections_counter()
    steel_replaced = []
    for key, model in new_catalog.items():
        old = old_catalog.get(key)
        if not old:
            continue
        if json.dumps(old.get("resources"), sort_keys=True) != json.dumps(model.get("resources"), sort_keys=True):
            changed["ресурсы изменены"] += 1
            if (model.get("readings") or {}).get("replacedResources"):
                steel_replaced.append(model.get("alias"))
        if old.get("projectVolume") != model.get("projectVolume"):
            changed["объём изменён"] += 1
        if old.get("concreteClass") != model.get("concreteClass"):
            changed["класс бетона изменён"] += 1
    return {"готовность до": pick(before), "готовность после": pick(after), "изменения в каталоге": dict(changed), "арматура заменена чтением (шт.)": len(steel_replaced), "примеры": steel_replaced[:12]}


def collections_counter():
    import collections
    return collections.Counter()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--documents", required=True, help="папка с новыми томами и альбомом (CalcZhBI/Документы)")
    parser.add_argument("--assets", default=str(ROOT / "data/calc/assets"))
    parser.add_argument("--database", default=str(ROOT / "data/calc/calczhbi.sqlite3"))
    parser.add_argument("--apply", action="store_true")
    run(parser.parse_args())
