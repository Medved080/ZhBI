"""Внести в калькулятор ответы проектировщиков от 2026-10-20 (продолжение scripts/apply_calc_designer_answers.py).

Что делает (идемпотентно):
  * исключает из расчёта монолитные ригели РМ (в каталоге РМ1, РМ2, РМ4, РМ5; проектировщики назвали РМ1…РМ6): у модели поле excluded с причиной, изделия удаляются
    из базы вместе с версиями расчёта (полная копия строк остаётся в резервной копии), повторный импорт реестра их не создаёт;
  * класс бетона плит 4Пд (41) и 4ПИ (22): последнее число в марке спецификации «1ПБ …-24Вр1400-<класс>» (КЖ2-2, лист «Спецификация к схеме расположения элементов
    перекрытия»: doc24 стр. 234, прежняя редакция doc20 стр. 227). Марки читаются из текстового слоя страницы и сверяются между редакциями.
Без --apply работает на копиях (staging) и ничего не меняет в рабочих данных.

Запуск (Python 3.12):
    .venv312/bin/python scripts/apply_calc_designer_answers_20261020.py [--apply]
"""
import argparse
import collections
import copy
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_calc_designer_answers as first  # noqa: E402  — apply_db, align_classes, compare, список файлов каталога

DATE = "2026-10-20"
BASIS = "Ответ проектировщиков " + DATE
ASSET_FILES = first.ASSET_FILES
first.BASIS = BASIS          # основание в записях журнала, которые пишут функции первого скрипта
SPEC_PAGES = (("doc24", 234, "КЖ2-2 изм.7"), ("doc20", 227, "КЖ2-2"))     # спецификация к схеме перекрытия: сначала действующая редакция, потом прежняя для сверки
NAME = re.compile(r"^4\s*(Пд|ПИ|П)\s*-\s*(\d+)$")
MARK = re.compile(r"^1\s*ПБ\s*([\d.,]+)\s*-\s*24\s*Вр\s*(?:1400){1,2}\s*-\s*(\d+)\s*$")      # «Вр 14001400-40»: на листе два наложенных текста


def read_spec_classes(assets, doc_id, page):
    """{(вид, номер): (длина в марке, класс, текст марки)} со страницы спецификации: имя плиты и марка — рядом в одной строке одной половины таблицы."""
    pdf = fitz.open(assets / "sources" / (doc_id + ".pdf"))
    names, marks = [], []
    for block in pdf[page - 1].get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                text = span["text"].strip()
                if not text:
                    continue
                if NAME.match(text):
                    kind, number = NAME.match(text).groups()
                    names.append((kind, int(number), span["bbox"]))
                elif MARK.match(text):
                    length, cls = MARK.match(text).groups()
                    marks.append((length, int(cls), span["bbox"], text))
    result, used = {}, set()
    for kind, number, bbox in names:
        cy = (bbox[1] + bbox[3]) / 2
        near = [(abs((m[2][1] + m[2][3]) / 2 - cy), i) for i, m in enumerate(marks)
                if i not in used and 0 < m[2][0] - bbox[0] < 400 and abs((m[2][1] + m[2][3]) / 2 - cy) < 4]
        if not near:
            raise SystemExit("%s стр. %d: для плиты 4%s-%d не нашлось марки в строке" % (doc_id, page, kind, number))
        used.add(min(near)[1])
        length, cls, _, text = marks[min(near)[1]]
        result[(kind, number)] = (length, cls, text)
    return result


def edit_documents(docs, assets):
    reg, readings, reviewed, sources, discrepancies = (docs[n] for n in ASSET_FILES)
    report = {"исключено": [], "классы плит": [], "прочее": []}

    # --- монолитные ригели РМ
    excluded = []
    for key, model in reg.items():
        if model.get("family") == "Ригели" and re.match(r"^РМ\d+$", model.get("alias") or ""):
            model["excluded"] = {"reason": "Монолитный ригель: на заводе не изготавливается, в калькуляцию не входит. " + BASIS + " (РМ1…РМ6 исключить из калькуляции ЖБИ).",
                                 "label": "монолитный ригель", "date": DATE}
            excluded.append(key)
    report["исключено"] = sorted(reg[k]["alias"] for k in excluded)

    # --- класс бетона 4Пд и 4ПИ по марке спецификации
    spec = {}
    for doc_id, page, title in SPEC_PAGES:
        spec[doc_id] = read_spec_classes(assets, doc_id, page)
    (primary_id, primary_page, primary_title), (old_id, _, _) = SPEC_PAGES[0], SPEC_PAGES[1]
    differ = [k for k in spec[primary_id] if spec[old_id].get(k, (None, None))[1] != spec[primary_id][k][1]]
    if differ:
        raise SystemExit("редакции спецификации расходятся по классу бетона: %s" % differ)
    kinds = {"Пд": "4Пд", "ПИ": "4ПИ"}
    for key, model in reg.items():
        alias = model.get("alias") or ""
        match = re.match(r"^(4Пд|4ПИ)-(\d+)$", alias)
        if model.get("family") != "Плиты" or not match or model.get("excluded"):
            continue
        kind = "Пд" if match.group(1) == "4Пд" else "ПИ"
        length, cls, text = spec[primary_id][(kind, int(match.group(2)))]
        label = "Класс бетона — последнее число в марке спецификации %s (%s, стр. %d; %s)" % (re.sub(r"\s+", "", text), primary_title, primary_page, BASIS)
        model["concreteClass"] = "В%d" % cls
        model["concreteClassSource"] = {"sourceId": primary_id, "pdfPage": primary_page, "label": label, "url": "/calc/api/document-source/%s#page=%d" % (primary_id, primary_page)}
        report["классы плит"].append("%s: В%d" % (alias, cls))
    count = collections.Counter(line.split(": ")[1] for line in report["классы плит"])
    report["классы по числу плит"] = dict(sorted(count.items()))
    return docs, report, excluded


def run(args):
    assets, database = Path(args.assets), Path(args.database)
    docs = {name: json.loads((assets / name).read_text()) for name in ASSET_FILES}
    docs, report, excluded = edit_documents(copy.deepcopy(docs), assets)
    from app.calc import document_models as dm

    with tempfile.TemporaryDirectory(prefix="calc-answers2-") as folder:
        stage = Path(folder) / "assets"
        stage.mkdir()
        for path in assets.iterdir():
            if path.name not in ASSET_FILES:
                (stage / path.name).symlink_to(path.resolve())
        for name, value in docs.items():
            (stage / name).write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n")
        staged_db = Path(folder) / "calczhbi.sqlite3"
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(staged_db) as dst:
            src.backup(dst)
        removed = first.apply_db(staged_db, excluded, None)
        dm.ASSETS = stage
        dm.catalog.cache_clear()
        catalog = dm.catalog()
        aligned_stage = first.align_classes(staged_db, catalog)
        print(json.dumps({"отчёт": {k: (v if k != "классы плит" else "%d плит" % len(v)) for k, v in report.items()}, "удалено изделий (на копии)": removed,
                          "класс бетона выровнен у изделий (на копии)": len(aligned_stage)}, ensure_ascii=False, indent=1))
        print(json.dumps(first.compare(argparse.Namespace(assets=str(assets), database=str(database)), stage, staged_db, catalog), ensure_ascii=False, indent=1))
        if not args.apply:
            print("Предварительный просмотр: рабочие данные не менялись. Для применения добавьте --apply.")
            return

    backup = database.parent / "backups" / ("designer-answers-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-apply2")
    backup.mkdir(parents=True)
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(backup / database.name) as dst:
        src.backup(dst)
    for name in ASSET_FILES:
        shutil.copy2(assets / name, backup / name)
    for name, value in docs.items():
        temp = assets / (name + ".applying")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n")
        os.replace(temp, assets / name)
    removed = first.apply_db(database, excluded, backup)
    dm.ASSETS = assets
    dm.catalog.cache_clear()
    aligned = first.align_classes(database, dm.catalog())
    print(json.dumps({"применено": True, "резервная копия": str(backup), "удалено изделий": removed, "класс бетона выровнен у изделий": len(aligned)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", default=str(ROOT / "data/calc/assets"))
    parser.add_argument("--database", default=str(ROOT / "data/calc/calczhbi.sqlite3"))
    parser.add_argument("--apply", action="store_true")
    run(parser.parse_args())
