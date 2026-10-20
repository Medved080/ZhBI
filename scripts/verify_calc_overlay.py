"""Проверка правил наложения чтений 2026-10-20: замена неполной арматуры поставщика чтением листа, возврат прежних ресурсов, подтверждение закладных проектировщиками,
исключённые изделия. Синтетические модели, без чертежей и базы.
Запуск:  ZHBI_CALC_ASSETS_DIR=…/data/calc/assets .venv312/bin/python scripts/verify_calc_overlay.py
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("ZHBI_DB_PATH", str(Path(tempfile.mkdtemp(prefix="overlay-")) / "zhbi.db"))

from app.calc import readings, reinforcement  # noqa: E402

failed = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        failed.append(label)


def steel(rid, kg):
    return {"id": rid, "name": rid, "unit": "т", "projectQty": kg / 1000, "qty": kg / 1000, "rate": "0"}


def model(alias, family, volume, resources, **extra):
    return {"id": "m-" + alias, "kind": "registry", "alias": alias, "family": family, "mark": family + " " + alias, "projectVolume": volume, "concreteClass": "В40",
            "resources": resources, "issues": [], "notes": [], **extra}


def reading(rods, volume=None):
    return {"sheet": {"doc": 1, "page": 1}, "method": "vector_ocr", "confirmed": False, "volume": volume,
            "rebar": {"fromSteelSheet": rods, "steelSheetChecks": {"А500С": True, "total": True}, "fromAssembly": [], "unresolvedKg": 0}, "embedded": {"items": []}}


def run(models, data):
    folder = Path(tempfile.mkdtemp(prefix="overlay-assets-"))
    (folder / readings.SOURCE_FILE).write_text(json.dumps(data))
    readings.apply_readings(models, folder)
    return models


# группа из 6 колонн с нормальной арматурой (~200 кг/м³) — эталон; одна колонна с «поставщиком» в 100 раз завышенным (как 1Р9) и одна с неполным
base = {}
data = {}
for i in range(6):
    base[f"c{i}"] = model(f"К{i}", "Колонны", 2.0, [steel("steel12A500C", 400)])
    data[f"c{i}"] = reading([["А500С", 12, 400.0]], 2.0)
base["big"] = model("Кбольш", "Колонны", 2.0, [steel("steel12A500C", 99000), steel("pipe50", 0)])      # поставщик: 49 500 кг/м³
data["big"] = reading([["А500С", 12, 410.0]], 2.0)
base["small"] = model("Кмало", "Колонны", 3.84, [steel("steel8A500C", 2.1)])                          # 0,5 кг/м³, как 14КВ1.1
data["small"] = reading([["А500С", 12, 748.0]], 3.84)
base["ok"] = model("Кнорма", "Колонны", 2.0, [steel("steel16A500C", 380)])                            # в диапазоне: поставщика не трогаем
data["ok"] = reading([["А500С", 12, 410.0]], 2.0)
base["bad"] = model("Кчтение", "Колонны", 2.0, [steel("steel8A500C", 1.0)])                           # чтение тоже вне диапазона: оставляем поставщика
data["bad"] = reading([["А500С", 12, 3.0]], 2.0)
original = copy.deepcopy(base)
models = run(base, data)

big = models["big"]
check(sum(r["projectQty"] for r in big["resources"] if r["id"].startswith("steel")) == 0.41, "1Р9: арматура поставщика (99 т) заменена чтением (410 кг)")
check(any(r["id"] == "pipe50" for r in big["resources"]), "несталевые ресурсы поставщика сохранены")
check(big["readings"]["replacedResources"] and big["readings"]["replacedResources"][0]["projectQty"] == 99.0, "прежняя арматура поставщика записана в чтении")
check("заменены чтением" in " ".join(big["readings"]["applied"]), "в пометке чтения сказано, что данные поставщика заменены")
restored = readings.without_readings(big)
check(restored["resources"] == original["big"]["resources"] or sorted(r["id"] for r in restored["resources"]) == sorted(r["id"] for r in original["big"]["resources"]), "without_readings возвращает ресурсы поставщика")
check(models["small"]["resources"][0]["id"] == "steel12A500C" and models["small"]["resources"][0]["projectQty"] == 0.748, "14КВ1.1: 2,1 кг заменены на 748 кг")
check(models["ok"]["resources"][0]["id"] == "steel16A500C" and "replacedResources" not in (models["ok"].get("readings") or {}), "арматура в диапазоне не заменяется")
check(models["bad"]["resources"][0]["projectQty"] == 0.001, "если чтение тоже вне диапазона — остаётся поставщик")
after = reinforcement.assess(models["big"], reinforcement.build_references(models))
check(after is not None and after["status"] == "ok", "после замены коэффициент армирования в диапазоне (%s кг/м³)" % (after or {}).get("value"))

# закладные: подтверждение проектировщиками снимает сверку с итогом ведомости
rd = reading([["А500С", 12, 400.0]], 2.0)
rd["embedded"] = {"items": [["embedded", "Закладная деталь ЗД5", 14.7, 9.0, None, None]], "sheetTotalKg": 172.17}
check(readings.embedded_verified(rd) is False, "итог ведомости не сошёлся — закладные не принимаются")
rd["embedded"]["confirmedBy"] = "Ответ проектировщиков"
check(readings.embedded_verified(rd) is True, "подтверждено проектировщиками — закладные принимаются")
only = {"k": model("К13", "Колонны", 3.0, [steel("steel10A500C", 90)])}
run(only, {"k": rd})
check(any(r["id"] == "embeddedParts" for r in only["k"]["resources"]), "закладные подтверждённой колонны добавлены в ресурсы")

# исключённые изделия не попадают в эталон
refs = reinforcement.build_references({**copy.deepcopy(models), "x": {**model("Км9", "Колонны", 0.2, [steel("steel8A500C", 1.0)]), "excluded": {"reason": "монолит"}}})
check(refs[0]["Колонны"][1] == len([m for m in models.values()]), "исключённые модели в эталон армирования не входят")

print("\nпровалено: %d" % len(failed))
sys.exit(1 if failed else 0)
