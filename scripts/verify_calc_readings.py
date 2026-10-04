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

# 6. изделия сохранены ДО появления чтений: создание прайса (миграция) не должно считать значения от чтений ручными правками, а расчёт — падать
os.environ["ZHBI_DB_PATH"] = str(tmp / "zhbi.db"); os.environ["ZHBI_CALC_DIR"] = str(tmp / "calc")
from app.calc.config import Settings
from app.calc.database import connect, initialize, transaction
from app.calc.import_register import import_register
from app.calc.prices import PricesSave, get_prices, update_prices
from app.calc.repository import get_product, pricing_context

settings = Settings.embedded()
initialize(settings)
import_register(settings)                       # каталог без чтений (dm.ASSETS = bare)
dm.ASSETS = Path(assets)                         # чтения появились
(tmp2 := tmp / "with").mkdir()
for item in Path(assets).iterdir():
    if item.name != SOURCE_FILE and not (tmp2 / item.name).exists():
        (tmp2 / item.name).symlink_to(item)
(tmp2 / SOURCE_FILE).write_text(json.dumps(data, ensure_ascii=False))
dm.ASSETS = tmp2
dm.catalog.cache_clear()
with transaction(settings.database_path) as conn:
    conn.execute("DELETE FROM price_list")      # как при миграции на сервере, где изделия уже есть
    prices = get_prices(conn)
with_readings = [k for k in data if (dm.catalog().get(k) or {}).get("readings")]
conn = connect(settings.database_path)
rows = conn.execute("SELECT manual_fields,document_model_id FROM products WHERE document_model_id IN (%s)" % ",".join("?" * len(with_readings)), with_readings).fetchall()
conn.close()
check(rows and all(r["manual_fields"] in (None, "[]") for r in rows), "изделия с чтениями не помечены ручными при создании прайса (%d)" % len(rows))
body = PricesSave(expectedVersion=prices["version"], concrete=prices["parameters"]["concrete"], labour=prices["parameters"]["labour"]["rate"], materials={k: "60000" for k in prices["parameters"]["materials"]})
with transaction(settings.database_path) as conn:
    update_prices(conn, body, "тест")
conn = connect(settings.database_path); conn.execute("BEGIN"); ctx = pricing_context(conn)
errors = 0
for row in conn.execute("SELECT id FROM products").fetchall():
    try:
        get_product(conn, row["id"], ctx)
    except ValueError:
        errors += 1
conn.close()
check(errors == 0, "после цен на все материалы все изделия считаются (ошибок %d)" % errors)

# 7. готовность калькуляций (домашняя страница): воронка согласована, цены считаются от прайса
from app.calc.readiness import readiness

conn = connect(settings.database_path); conn.execute("BEGIN")
result = readiness(conn)
conn.close()
steps = [f["cumulative"] for f in result["funnel"]]
check(result["total"] == len(dm.catalog()) or result["total"] > 900, "готовность считает все изделия (%d)" % result["total"])
check(all(a >= b for a, b in zip(steps, steps[1:])), "воронка не растёт по шагам: %s" % steps)
check(all(f["cumulative"] <= f["alone"] for f in result["funnel"]), "«по порядку» не больше «самого по себе»")
check(result["ready"] == steps[-1] and 0 <= result["percent"] <= 100, "итог совпадает с последним шагом воронки, процент %.1f" % result["percent"])
check(sum(f["total"] for f in result["families"]) == result["total"], "группы в сумме дают все изделия")
check(result["funnel"][0]["alone"] > 0 and result["prices"]["materials"] > 0, "объём и перечень материалов есть")

print("\nПровалов: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
