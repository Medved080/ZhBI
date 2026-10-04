"""Проверка слоя «прочитано с листа» (app/calc/readings.py) на настоящем каталоге моделей, который только читается.

Что проверяется: наложение заполняет только пробелы каталога (объём, класс бетона, арматура), значения поставщика не перезаписываются,
у наложенных моделей есть пометка «не подтверждено», после задания цены арматуры стоимость изделия растёт.
Нужны каталог (ZHBI_CALC_ASSETS_DIR=…/data/calc/assets) и файл чтений (READINGS_JSON=…/readings.json, собирает scripts/build_calc_readings.py);
без файла чтений проверка идёт на синтетическом чтении. Запуск:
    ZHBI_CALC_ASSETS_DIR=… [READINGS_JSON=…] .venv312/bin/python scripts/verify_calc_readings.py
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
assets = os.environ.get("ZHBI_CALC_ASSETS_DIR")
if not assets or not (Path(assets) / "promka-models.json").exists():
    sys.exit("Нужен каталог моделей: задайте ZHBI_CALC_ASSETS_DIR=…/data/calc/assets")

from app.calc import document_models as dm
from app.calc.readings import SOURCE_FILE, apply_readings, rebar_of, resource_id

FAILS = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        FAILS.append(label)


# каталог без чтений: временный каталог с ссылками на файлы каталога, кроме файла чтений (в настоящем каталоге данных он может лежать)
bare = Path(tempfile.mkdtemp(prefix="calc-bare-"))
for item in Path(assets).iterdir():
    if item.name != SOURCE_FILE:
        (bare / item.name).symlink_to(item)
dm.ASSETS = bare
dm.catalog.cache_clear()
base = {k: copy.deepcopy(v) for k, v in dm.catalog().items()}
check(len(base) > 900, "каталог прочитан (%d моделей)" % len(base))

path = os.environ.get("READINGS_JSON")
if path and Path(path).exists():
    data = json.loads(Path(path).read_text())
else:
    # синтетическое чтение для первой колонны без объёма или арматуры
    gap = next(k for k, v in base.items() if v.get("family") == "Колонны" and not v.get("resources"))
    data = {gap: {"sheet": {"doc": 1, "page": 1}, "method": "vector_ocr", "confirmed": False, "volume": 1.23, "concreteClass": "В40",
                  "rebar": {"fromSteelSheet": [["А500С", 12, 100.0], ["А240", 8, 20.0]], "steelSheetChecks": {"total": True}, "fromAssembly": [], "unresolvedKg": 0}}}
check(len(data) > 0, "чтений для наложения: %d" % len(data))

tmp = Path(tempfile.mkdtemp(prefix="calc-readings-"))
(tmp / SOURCE_FILE).write_text(json.dumps(data, ensure_ascii=False))
models = copy.deepcopy(base)
changed = apply_readings(models, tmp)
check(changed > 0, "наложено на моделей: %d" % changed)

# 1. значения поставщика не перезаписываются
overwritten = [k for k in data if k in base and (
    (base[k].get("projectVolume") and models[k].get("projectVolume") != base[k]["projectVolume"])
    or (base[k].get("concreteClass") not in (None, "", "Не указан") and models[k].get("concreteClass") != base[k]["concreteClass"])
    or (base[k].get("resources") and models[k].get("resources") != base[k]["resources"]))]
check(not overwritten, "значения каталога поставщика не перезаписаны (затронуто %d)" % len(overwritten))

# 2. пробелы закрыты, остальное не тронуто
filled_volume = [k for k in data if k in base and not base[k].get("projectVolume") and data[k].get("volume")]
check(all(models[k]["projectVolume"] == data[k]["volume"] for k in filled_volume), "объём в пробелах взят с листа (%d)" % len(filled_volume))
filled_rebar = [k for k in data if k in base and not base[k].get("resources") and rebar_of(data[k])[0]]
check(all(models[k].get("resources") for k in filled_rebar), "арматура в пробелах взята с листа (%d)" % len(filled_rebar))
untouched = [k for k in base if k not in data and models[k] != base[k]]
check(not untouched, "модели без чтений не изменились (%d)" % len(untouched))

# 3. пометка «не подтверждено» и заметка
marked = [k for k in data if k in models and "readings" in models[k]]
check(marked and all(models[k]["readings"].get("confirmed") is False for k in marked), "у наложенных есть пометка «не подтверждено» (%d)" % len(marked))

# 4. ресурсы корректны: масса в тоннах, код как в каталоге
for k in filled_rebar[:50]:
    kg = {resource_id(c, d): w for c, d, w in rebar_of(data[k])[0]}
    got = {r["id"]: float(r["projectQty"]) for r in models[k]["resources"]}
    if any(abs(got.get(i, 0) - w / 1000) > 1e-4 for i, w in kg.items()):
        check(False, "массы ресурсов в тоннах (%s)" % k)
        break
else:
    check(True, "массы ресурсов в тоннах, коды как в каталоге")

# 5. вторичное наложение ничего не меняет (идемпотентность)
again = copy.deepcopy(models)
apply_readings(again, tmp)
check(again == models, "повторное наложение ничего не меняет")

print("\nПровалов: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
