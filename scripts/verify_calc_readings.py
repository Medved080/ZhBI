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

# база и каталог данных теста — во временном каталоге, ДО импорта приложения: пути вычисляются при импорте (app/calc/paths.py)
RUN_DIR = Path(tempfile.mkdtemp(prefix="calc-readings-run-"))
os.environ["ZHBI_DB_PATH"] = str(RUN_DIR / "zhbi.db"); os.environ["ZHBI_CALC_DIR"] = str(RUN_DIR / "calc")

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
    or (base[k].get("resources") and models[k].get("resources")[:len(base[k]["resources"])] != base[k]["resources"]))]      # ресурсы поставщика остаются как были, чтение может только добавить виды в конец
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

# 8. закладные, трубы, петли: наложение по видам, коды ресурсов, без дублей, лист без закладных тоже «прочитан»
from app.calc.readings import without_readings

plain = next(k for k, v in base.items() if v.get("family") == "Колонны" and not v.get("resources") and not v.get("projectVolume"))
legacy = next((k for k, v in base.items() if any(r["id"] == "pipe50" for r in v.get("resources") or [])), None)
synthetic = {
    "sheet": {"doc": 1, "page": 1}, "method": "vector_ocr", "confirmed": False, "volume": 2.0, "concreteClass": "В40",
    "rebar": {"fromSteelSheet": [], "steelSheetChecks": {}, "fromAssembly": [], "unresolvedKg": 0},
    "embedded": {"items": [["embedded", "Закладная деталь ЗД1", 9.4, 10, None, None], ["embedded", "Закладная деталь ЗД2", 5.0, 2, None, None],
                           ["loop", "Петля П1", 2.3, 4, None, None],
                           ["pipe", "Труба 68х1 ГОСТ 32678-2014 L=700", 1.1, 2, "68x1", 1.4], ["pipe", "Труба 50х5 ГОСТ 32678-2014 L=400", 4.0, 3, "50x5", 1.2],
                           ["pipe", "Труба 68х5 ГОСТ 32678-2014 L=300", 3.0, 1, "68x5", 0.3]]},
}
empty = {"sheet": {"doc": 1, "page": 2}, "method": "vector_ocr", "confirmed": False, "volume": 1.0, "rebar": {}, "embedded": {"items": []}}
payload = {plain: synthetic}
if legacy: payload[legacy] = synthetic
tmp3 = Path(tempfile.mkdtemp(prefix="calc-embedded-")); (tmp3 / SOURCE_FILE).write_text(json.dumps(payload, ensure_ascii=False))
models3 = copy.deepcopy(base); apply_readings(models3, tmp3)
res = {r["id"]: r for r in models3[plain]["resources"]}
check(abs(float(res["embeddedParts"]["projectQty"]) - (9.4 * 10 + 5.0 * 2) / 1000) < 1e-6 and res["embeddedParts"]["unit"] == "т", "закладные: масса в тоннах (%s)" % res["embeddedParts"]["projectQty"])
check(abs(float(res["loopParts"]["projectQty"]) - 2.3 * 4 / 1000) < 1e-6, "петли: масса в тоннах")
check(res["pipe68"]["unit"] == "м" and abs(float(res["pipe68"]["projectQty"]) - 1.4) < 1e-9 and abs(float(res["pipe50"]["projectQty"]) - 1.2) < 1e-9, "трубы 68×1 и 50×5 — коды каталога, метры")
check("pipe68x5" in res and abs(float(res["pipe68x5"]["projectQty"]) - 0.3) < 1e-9, "труба нового типоразмера получила код pipe68x5")
check(models3[plain]["readings"]["embeddedChecked"] and "embeddedParts" in models3[plain]["readings"]["addedResources"], "в пометке записаны добавленные ресурсы")
if legacy:
    old = {r["id"]: r for r in base[legacy]["resources"]}
    new = {r["id"]: r for r in models3[legacy]["resources"]}
    check(new["pipe50"] == old["pipe50"] and sum(1 for r in models3[legacy]["resources"] if r["id"] == "pipe50") == 1, "трубы поставщика не дублируются и не меняются")
    check("embeddedParts" in new, "закладные у модели с готовыми трубами добавлены")
restored = without_readings(models3[plain])
check(restored["resources"] == [] and not restored["projectVolume"], "без_чтений возвращает состояние до наложения")
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: empty}, ensure_ascii=False))
models4 = copy.deepcopy(base); apply_readings(models4, tmp3)
check(models4[plain]["readings"]["embeddedChecked"] and not models4[plain].get("resources"), "лист без закладных помечен прочитанным и ресурсов не добавляет")
old_format = {"sheet": {"doc": 1, "page": 3}, "method": "vector_ocr", "confirmed": False, "volume": 1.0, "rebar": {}}      # чтение прежнего формата: раздела embedded нет
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: old_format}, ensure_ascii=False))
models5 = copy.deepcopy(base); apply_readings(models5, tmp3)
check(not models5[plain].get("readings", {}).get("embeddedChecked"), "чтение прежнего формата не засчитывает закладные прочитанными")
by_mass = {**old_format, "volumeSource": "масса ÷ 2500", "volume": 0.78}
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: by_mass}, ensure_ascii=False))
models6 = copy.deepcopy(base); apply_readings(models6, tmp3)
check(models6[plain]["projectVolume"] == 0.78 and any("масса ÷ 2500" in a for a in models6[plain]["readings"]["applied"]), "объём по массе ÷ 2500 помечен источником")
check(without_readings(models6[plain])["projectVolume"] is None, "без_чтений убирает объём, вычисленный по массе")

# 9. петли и сверка закладных с итогом ведомости
with_sheet = {**synthetic, "rebar": {"fromSteelSheet": [["А500С", 12, 100.0]], "steelSheetChecks": {"total": True}, "fromAssembly": [], "unresolvedKg": 0}}
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: with_sheet}, ensure_ascii=False))
models7 = copy.deepcopy(base); apply_readings(models7, tmp3)
ids7 = {r["id"] for r in models7[plain]["resources"]}
check("steel12A500C" in ids7 and "embeddedParts" in ids7 and "loopParts" not in ids7, "арматура из ведомости уже включает петли: отдельных петель нет")
by_assembly = {**synthetic, "rebar": {"fromSteelSheet": [], "steelSheetChecks": {}, "fromAssembly": [["А500С", 12, 100.0]], "unresolvedKg": 0}}
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: by_assembly}, ensure_ascii=False))
models8 = copy.deepcopy(base); apply_readings(models8, tmp3)
check("loopParts" in {r["id"] for r in models8[plain]["resources"]}, "арматура из сборки петель не включает: петли добавлены")
matching = {**synthetic, "embedded": {**synthetic["embedded"], "sheetTotalKg": 9.4 * 10 + 5.0 * 2 + 1.1 * 2 + 4.0 * 3 + 3.0 * 1}}
wrong = {**synthetic, "embedded": {**synthetic["embedded"], "sheetTotalKg": 500.0}}
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: matching}, ensure_ascii=False))
models9 = copy.deepcopy(base); apply_readings(models9, tmp3)
check(models9[plain]["readings"]["embeddedVerified"] is True and "embeddedParts" in {r["id"] for r in models9[plain]["resources"]}, "закладные сошлись с итогом ведомости: наложены, проверено")
(tmp3 / SOURCE_FILE).write_text(json.dumps({plain: wrong}, ensure_ascii=False))
models10 = copy.deepcopy(base); apply_readings(models10, tmp3)
check(not any(r["id"] in ("embeddedParts", "loopParts") or r["id"].startswith("pipe") for r in models10[plain].get("resources") or []) and not models10[plain]["readings"]["embeddedChecked"],
      "закладные не сошлись с итогом ведомости: не накладываются и не засчитаны прочитанными")

# 10. подтверждение человеком, нормы по группам, класс бетона по типу изделия
from app.calc.norms import GroupNorm, NormsSave, get_norms, type_key, update_norms

with transaction(settings.database_path) as conn:
    before = readiness(conn)
    plate_row = conn.execute("SELECT id,document_model_id FROM products WHERE document_model_id IN (SELECT 'x' WHERE 0)").fetchone()
    victim = conn.execute("SELECT id FROM products LIMIT 1").fetchone()["id"]
    conn.execute("INSERT INTO product_verifications VALUES(?,?,?,?)", (victim, "тест", "2026-10-05T00:00:00", "сверено с чертежом"))
    after = readiness(conn)
check(after["funnel"][-1]["alone"] == before["funnel"][-1]["alone"] + 1, "подтверждённое человеком изделие попало в условие «проверено»")
check(get_product(connect(settings.database_path), victim)["product"]["verification"]["note"] == "сверено с чертежом", "в карточке изделия есть отметка проверки")
from app.calc.sync import product_bundle
with transaction(settings.database_path) as conn:
    with_mark = product_bundle(conn, victim)
    conn.execute("DELETE FROM product_verifications WHERE product_id=?", (victim,))
    without_mark = product_bundle(conn, victim)
    conn.execute("INSERT INTO product_verifications VALUES(?,?,?,?)", (victim, "тест", "2026-10-05T00:00:00", "сверено с чертежом"))
check(len(with_mark["verifications"]) == 1 and with_mark["verifications"][0]["note"] == "сверено с чертежом", "отметка проверки входит в пакет передачи изделия")
check(with_mark["contentHash"] != without_mark["contentHash"] and not without_mark["verifications"], "отметка проверки меняет контрольную сумму изделия")

with transaction(settings.database_path) as conn:
    norms = get_norms(conn)
    families = sorted({(dm.model(r["document_model_id"]) or {}).get("family") for r in conn.execute("SELECT document_model_id FROM products WHERE document_model_id IS NOT NULL").fetchall()} - {None})
    resources = {k: {"factor": v["factor"]} for k, v in norms["parameters"]["resources"].items()}
    family = "Ригели" if "Ригели" in families else families[0]
    body = NormsSave(expectedVersion=norms["version"], concreteFactor=norms["parameters"]["concreteFactor"], hoursPerM3=norms["parameters"]["hoursPerM3"], resources=resources,
                     groups={family: GroupNorm(confirmed=True, hoursPerM3="11.5")}, classByType={})
    update_norms(conn, body, "технолог")
    after_norms = readiness(conn)
    saved = get_norms(conn)["parameters"]["groups"][family]
check(saved["confirmed"] and saved["confirmedBy"] == "технолог" and saved["hoursPerM3"] == "11.5", "нормы группы сохранены с подтверждением (%s)" % family)
check(family in after_norms["norms"]["confirmed"], "подтверждённая группа учтена в готовности")
conn = connect(settings.database_path); conn.execute("BEGIN"); ctx2 = pricing_context(conn)
member = next(r["id"] for r in conn.execute("SELECT id,document_model_id FROM products").fetchall() if (dm.model(r["document_model_id"]) or {}).get("family") == family and (dm.model(r["document_model_id"]) or {}).get("projectVolume"))
entry = get_product(conn, member, ctx2)["product"]
check(abs(entry["hours"] - entry["volume"] * 11.5) < 0.01, "труд на м³ взят из норм группы, не из общей нормы")
conn.close()

with transaction(settings.database_path) as conn:
    types = readiness(conn)["classTypes"]
check(isinstance(types, list), "список типов без класса есть (%d)" % len(types))
if types:
    kind = types[0]["key"]
    with transaction(settings.database_path) as conn:
        norms = get_norms(conn)
        resources = {k: {"factor": v["factor"]} for k, v in norms["parameters"]["resources"].items()}
        update_norms(conn, NormsSave(expectedVersion=norms["version"], concreteFactor=norms["parameters"]["concreteFactor"], hoursPerM3=norms["parameters"]["hoursPerM3"], resources=resources,
                                     classByType={kind: "в 30"}), "технолог")
        classed = readiness(conn)
    check(next(t for t in classed["classTypes"] if t["key"] == kind)["assigned"] == "В30", "класс типа «%s» сохранён как В30" % kind)
    check(classed["funnel"][1]["alone"] >= after_norms["funnel"][1]["alone"] + types[0]["count"] - 0, "изделия типа получили класс бетона (%d)" % types[0]["count"])

# 11. оценка арматуры по нормативу группы (плиты: арматуры по чертежам нет)
with transaction(settings.database_path) as conn:
    norms = get_norms(conn)
    resources = {k: {"factor": v["factor"]} for k, v in norms["parameters"]["resources"].items()}
    update_norms(conn, NormsSave(expectedVersion=norms["version"], concreteFactor=norms["parameters"]["concreteFactor"], hoursPerM3=norms["parameters"]["hoursPerM3"], resources=resources,
                                 groups={"Плиты": GroupNorm(confirmed=False, steelKgPerM3="60")}), "технолог")
conn = connect(settings.database_path); conn.execute("BEGIN"); ctx3 = pricing_context(conn)
plate_id = next(r["id"] for r in conn.execute("SELECT id,document_model_id FROM products").fetchall() if (dm.model(r["document_model_id"]) or {}).get("family") == "Плиты" and (dm.model(r["document_model_id"]) or {}).get("projectVolume"))
entry = get_product(conn, plate_id, ctx3)
est = [r for r in entry["product"]["documentModel"]["resources"] if r["id"] == "steelEstimate"]
volume = entry["product"]["volume"]
check(est and est[0]["unit"] == "т" and abs(est[0]["qty"] - volume * 60 / 1000) < 0.0011, "плите без арматуры по чертежам добавлена оценка по нормативу: %s т при %.2f м³" % (est[0]["qty"] if est else "—", volume))
row_ids = {r["id"] for r in entry["snapshot"]["rows"]}
check("steelEstimate" in row_ids, "оценка арматуры есть в строках калькуляции")
conn.close()
from app.calc.prices import catalog_materials
check("steelEstimate" in catalog_materials(), "оценка арматуры есть в прайс-листе материалов (цена задаётся там)")
with transaction(settings.database_path) as conn:
    sources = readiness(conn)["origin"]["rebar"]
check(sources.get("оценка по нормативу", 0) > 0, "на главной оценка по нормативу видна в источниках арматуры (%s)" % sources)

# 12. файл чтений заменили на лету (положили вручную, не пакетом): каталог в памяти обновляется без перезапуска
live = Path(tempfile.mkdtemp(prefix="calc-refresh-"))
for item in Path(assets).iterdir():
    if item.name != SOURCE_FILE:
        (live / item.name).symlink_to(item)
target = next(k for k, v in base.items() if v.get("family") == "Колонны" and not v.get("projectVolume"))
def put(volume):
    (live / SOURCE_FILE).write_text(json.dumps({target: {"sheet": {"doc": 1, "page": 1}, "method": "vector_ocr", "confirmed": False, "volume": volume, "rebar": {}}}, ensure_ascii=False))
    os.utime(live / SOURCE_FILE, (volume * 1000, volume * 1000))      # время изменения гарантированно разное
dm.ASSETS = live; dm.catalog.cache_clear(); dm._seen = None
put(1.11); dm.refresh(); first = dm.catalog()[target]["projectVolume"]
put(2.22); dm.refresh(); second = dm.catalog()[target]["projectVolume"]
check(first == 1.11 and second == 2.22, "замена файла чтений видна без перезапуска (%s → %s)" % (first, second))

# 13. история настроек: версии норм, цен и массовая отметка проверки читаются из журнала
from app.calc.database import audit
from app.calc.settings_history import entries

with transaction(settings.database_path) as conn:
    audit(conn, "тест", "products.verified.bulk", "products", {"ids": [victim], "verified": True, "note": "сверка", "count": 1})
    norms_log = entries(conn, 50, "norms")
    prices_log = entries(conn, 50, "prices")
    checks_log = entries(conn, 50, "verification")
labels = " ".join(c["label"] for e in norms_log for c in e["changes"])
check(any(e["version"] for e in norms_log) and "Ригели" in labels and "подтверждено технологом" in labels, "в истории норм видны группа, поле и версия (%d записей)" % len(norms_log))
check(prices_log and all(c["label"] and c["after"] != "" for c in prices_log[0]["changes"]) and prices_log[0]["changes"][0]["label"], "в истории расценок есть подписи материалов и значения «было → стало» (%d записей)" % len(prices_log))
check(checks_log and checks_log[0]["summary"].startswith("Отмечены проверенными: 1") and checks_log[0]["changes"][0]["after"] == "проверено", "массовая отметка проверки — одной записью со списком изделий")
check(all(e["at"] for e in norms_log + prices_log + checks_log), "у всех записей есть время")

print("\nПровалов: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
