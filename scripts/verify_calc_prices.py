"""Проверка расценок калькулятора на ВРЕМЕННОЙ базе с настоящим каталогом моделей (каталог только читается).

Что проверяется: смена цены материала, бетона по классу, ставки труда и процентов профиля меняет стоимость ВО ВСЕХ затронутых изделиях без
пересохранения; ручные правки (корректировки строк, ручные поля изделия) не пересчитываются; версии расценок и конфликт при устаревшей версии.
Запуск (нужен каталог: data/calc/assets основного каталога):
    ZHBI_CALC_ASSETS_DIR=/путь/к/data/calc/assets .venv312/bin/python scripts/verify_calc_prices.py
"""
import os
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
tmp = tempfile.mkdtemp(prefix="calc-prices-")
os.environ["ZHBI_DB_PATH"] = str(Path(tmp) / "zhbi.db")
os.environ["ZHBI_CALC_DIR"] = str(Path(tmp) / "calc")
assets = os.environ.get("ZHBI_CALC_ASSETS_DIR")
if not assets or not (Path(assets) / "promka-models.json").exists():
    sys.exit("Нужен каталог моделей: задайте ZHBI_CALC_ASSETS_DIR=…/data/calc/assets")

from app.calc.config import Settings
from app.calc.database import connect, initialize, transaction
from app.calc.import_register import import_register
from app.calc.prices import PricesSave, get_prices, update_prices, get_profile, update_profile
from app.calc.repository import get_product, pricing_context, save_product
from app.calc.schemas import ProductSave, ProfileSave
from fastapi import HTTPException

D = Decimal
FAILS = []


def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        FAILS.append(label)


settings = Settings.embedded()
initialize(settings)
imported = import_register(settings)
check(len(imported) > 900, "каталог ввёл изделия (%d)" % len(imported))


def totals():
    conn = connect(settings.database_path)
    try:
        conn.execute("BEGIN")
        ctx = pricing_context(conn)
        out = {}
        for row in conn.execute("SELECT id,concrete_class,document_model_id FROM products").fetchall():
            entry = get_product(conn, row["id"], ctx)
            out[row["id"]] = (entry["snapshot"]["baseTotal"], row["concrete_class"], entry["product"], entry)
        return out
    finally:
        conn.close()


def with_conn(fn):
    with transaction(settings.database_path) as conn:
        return fn(conn)


base = totals()
prices = with_conn(get_prices)
check(prices["version"] == 1, "прайс создан при старте, версия 1")
check(len(prices["parameters"]["materials"]) >= 40, "в прайсе все материалы каталога (%d)" % len(prices["parameters"]["materials"]))
check(set(prices["parameters"]["concrete"]) >= {"default", "В40", "В50"}, "бетон по классам: " + ",".join(sorted(prices["parameters"]["concrete"])))

# 1. цена материала: арматура Ø16 А500С
key = "steel16A500C"
users = [pid for pid, (t, c, p, e) in base.items() if any(r["id"] == key for r in (e["product"]["documentModel"] or {}).get("resources", []))]
check(len(users) > 50, "изделий с арматурой Ø16 А500С: %d" % len(users))
body = PricesSave(expectedVersion=1, concrete=prices["parameters"]["concrete"], labour=prices["parameters"]["labour"]["rate"],
                  materials={k: v["rate"] for k, v in prices["parameters"]["materials"].items()} | {key: "70000"})
result = with_conn(lambda c: update_prices(c, body, "тест"))
check(result["version"] == 2, "версия расценок выросла до 2")
after = totals()
grew = [pid for pid in users if after[pid][0] > base[pid][0] + 1e-6]
check(len(grew) == len(users), "цена арматуры Ø16 пересчитала ВСЕ изделия с ней (%d из %d)" % (len(grew), len(users)))
others = [pid for pid in base if pid not in users and abs(after[pid][0] - base[pid][0]) > 1e-6]
check(not others, "изделия без этой арматуры не изменились (изменилось %d)" % len(others))
sample = users[0]
res = next(r for r in after[sample][3]["product"]["documentModel"]["resources"] if r["id"] == key)
check(abs(float(res["rate"]) - 70000) < 1e-6, "в карточке цена ресурса = цене из прайса")

# 2. цена бетона по классу
prices = with_conn(get_prices)
concrete = dict(prices["parameters"]["concrete"]); concrete["В40"] = str(D(concrete["В40"]) + 1000)
body = PricesSave(expectedVersion=prices["version"], concrete=concrete, labour=prices["parameters"]["labour"]["rate"], materials={k: v["rate"] for k, v in prices["parameters"]["materials"].items()})
with_conn(lambda c: update_prices(c, body, "тест"))
after2 = totals()
b40 = [pid for pid in after if after[pid][1] == "В40" and after[pid][2]["volume"] > 0]; b50 = [pid for pid in after if after[pid][1] == "В50"]
check(b40 and all(after2[p][0] > after[p][0] for p in b40), "бетон В40 дороже — выросли все изделия В40 с объёмом (%d)" % len(b40))
zero = [pid for pid in after if after[pid][1] == "В40" and after[pid][2]["volume"] == 0]
check(all(abs(after2[p][0] - after[p][0]) < 1e-6 for p in zero), "изделия В40 без объёма бетона не меняются, нет чему расти (%d)" % len(zero))
check(b50 and all(abs(after2[p][0] - after[p][0]) < 1e-6 for p in b50), "изделия В50 не изменились (%d)" % len(b50))

# 3. ставка труда и профиль
prices = with_conn(get_prices)
labour = str(D(prices["parameters"]["labour"]["rate"]) + 100)
body = PricesSave(expectedVersion=prices["version"], concrete=prices["parameters"]["concrete"], labour=labour, materials={k: v["rate"] for k, v in prices["parameters"]["materials"].items()})
with_conn(lambda c: update_prices(c, body, "тест"))
after3 = totals()
withhours = [p for p in after2 if after2[p][2]["hours"] > 0]
check(withhours and all(after3[p][0] > after2[p][0] for p in withhours), "ставка труда пересчитала все изделия с трудоёмкостью (%d)" % len(withhours))
profile = with_conn(get_profile)
new = ProfileSave(expectedVersion=profile["version"], **{**{k: v for k, v in profile["parameters"].items()}, "profitPercent": "10"})
with_conn(lambda c: update_profile(c, new, "тест"))
after4 = totals()
priced = [p for p in after3 if after3[p][0] > 0]
check(priced and all(after4[p][0] > after3[p][0] for p in priced), "маржа 5%% → 10%% пересчитала все изделия со стоимостью (%d)" % len(priced))

# 4. ручные правки сохраняются
conn = connect(settings.database_path)
conn.execute("BEGIN")
pid = users[0]
entry = get_product(conn, pid)
conn.close()
product = {k: entry["product"][k] for k in ("id", "name", "concreteClass", "volume", "weight", "hours", "concreteRate", "otherMaterials", "source")}
product["documentModelId"] = entry["product"]["documentModelId"]
manual_volume = round(entry["product"]["volume"] + 1, 2)
product["volume"] = manual_volume
body = ProductSave.model_validate({"product": product, "overrides": {key: {"rate": "11111"}}, "extra": [], "expectedVersion": entry["product"]["version"], "manualFields": ["volume"]})
with_conn(lambda c: save_product(c, body, "тест"))
saved = totals()[pid][3]
check(abs(saved["product"]["volume"] - manual_volume) < 1e-9, "ручной объём сохранён")
check(saved["product"]["manualFields"] == ["volume"], "поле объёма помечено ручным")
resource = next(r for r in saved["snapshot"]["rows"] if r["id"] == key)
check(abs(resource["effective"]["rate"] - 11111) < 1e-6, "корректировка цены строки применена")
# смена расценок не трогает ручное
prices = with_conn(get_prices)
body = PricesSave(expectedVersion=prices["version"], concrete=prices["parameters"]["concrete"], labour=prices["parameters"]["labour"]["rate"],
                  materials={k: v["rate"] for k, v in prices["parameters"]["materials"].items()} | {key: "80000"})
with_conn(lambda c: update_prices(c, body, "тест"))
final = totals()[pid][3]
check(abs(final["product"]["volume"] - manual_volume) < 1e-9, "ручной объём не пересчитан после смены расценок")
resource = next(r for r in final["snapshot"]["rows"] if r["id"] == key)
check(abs(resource["effective"]["rate"] - 11111) < 1e-6 and abs(resource["rate"] - 80000) < 1e-6, "ручная цена строки осталась, расчётная — по новому прайсу")
other = [p for p in users if p != pid][0]
check(totals()[other][3]["snapshot"]["rows"] is not None, "остальные изделия считаются")

# 5. конфликт версий
try:
    with_conn(lambda c: update_prices(c, PricesSave(expectedVersion=1, concrete=prices["parameters"]["concrete"], labour="1", materials={}), "тест"))
    check(False, "устаревшая версия расценок отклонена")
except HTTPException as error:
    check(error.status_code == 409, "устаревшая версия расценок → 409")

print("\nПровалов: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
