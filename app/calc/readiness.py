"""Готовность калькуляций: сколько изделий уже можно считать до конца и чего для этого не хватает (домашняя страница калькулятора).

У изделия семь условий готовности: объём бетона, класс бетона, арматура, закладные/трубы/петли, цены на все его материалы,
подтверждённые нормы его группы, проверка человеком. Воронка накладывает условия по порядку (изделие «дошло» до шага, если выполнены все
предыдущие), таблица по группам показывает каждое условие отдельно. Всё считается на лету от каталога, чтений с листов и текущих расценок,
ничего не хранится: изменили расценку — готовность пересчиталась.

Подтверждение норм группы хранится в нормах (norms.parameters.groups[группа].confirmed, ставит технолог в «Расценки и нормы»), проверка человеком — в таблице
product_verifications (кнопка в карточке изделия). Пока никто ничего не подтвердил, эти условия не выполнены ни у одного изделия: честный ноль, а не пропуск шага.
"""
import collections
import json

from .document_models import model, model_readiness
from .prices import norm_class
from .norms import type_key
from .repository import dynamic_values, pricing_context

UNSET = ("", "не указан")

CRITERIA = [
    ("volume", "Объём бетона", "чтение листов", "Строка «Бетон кл. … м³» спецификации листа изделия или ввод вручную"),
    ("concreteClass", "Класс бетона", "чтение листов", "Цена бетона зависит от класса; для типов без класса на листе (плиты) его вводят в «Расценки и нормы» → «Класс бетона по типам изделий»"),
    ("rebar", "Арматура по диаметрам и классам", "чтение листов", "Ведомость расхода стали или сборка по листам каркасов и сеток"),
    ("embedded", "Закладные, трубы, петли", "чтение листов", "Количества и массы из спецификации листа изделия"),
    ("prices", "Цены на все материалы изделия", "вы", "Раздел «Расценки и нормы»: цена бетона класса, ставка труда, цены ресурсов"),
    ("norms", "Нормы группы подтверждены", "технолог", "Технолог отмечает нормы группы в «Расценки и нормы» (по умолчанию действует общая норма, выведенная по двум колоннам)"),
    ("verified", "Проверено человеком", "проверка", "Кнопка «Отметить: проверено по чертежу» в карточке изделия: выборка по изделиям каждого типа"),
]
STEEL = ("steel", "mainsteel", "wire")
EMBEDDED = ("embedded", "loop", "pipe")


def _unset(value):
    return (value or "").strip().lower() in UNSET


def readiness(conn):
    ctx = pricing_context(conn)
    prices = ctx["prices"]["parameters"]
    labour_ok = float(prices["labour"]["rate"]) > 0
    norm_groups = (ctx["norms"]["parameters"].get("groups") or {}) if ctx["norms"] else {}
    confirmed_groups = {f for f, g in norm_groups.items() if g.get("confirmed")} | {"Вне каталога"}      # две исходные колонны из Excel — основание общей нормы
    class_by_type = (ctx["norms"]["parameters"].get("classByType") or {}) if ctx["norms"] else {}
    verified_ids = {r[0] for r in conn.execute("SELECT product_id FROM product_verifications").fetchall()}
    types_without_class = collections.defaultdict(lambda: {"count": 0, "family": ""})
    rows = conn.execute("SELECT * FROM products").fetchall()
    products = []
    usage = collections.defaultdict(lambda: {"name": "", "products": 0})
    classes = collections.Counter()
    shown_3d = collections.Counter()
    for row in rows:
        doc = model(row["document_model_id"]) if row["document_model_id"] else None
        values = dynamic_values(row, ctx)
        manual = set(json.loads(row["manual_fields"] or "[]"))
        family = (doc or {}).get("family") or "Вне каталога"
        volume = float(values.get("volume", row["volume"]) or 0)
        concrete_class = values.get("concreteClass") or row["concrete_class"]
        resources = values.get("resources") if values.get("resources") is not None else (doc or {}).get("resources") or []
        rate = float(values.get("concreteRate", 0) or 0)
        ids = [r["id"] for r in resources]
        applied = " ".join(((doc or {}).get("readings") or {}).get("applied") or [])
        checks = {
            "volume": volume > 0,
            "concreteClass": not _unset(concrete_class),
            "rebar": any(i.startswith(STEEL) for i in ids),
            "embedded": any(i.startswith(EMBEDDED) for i in ids) or bool(((doc or {}).get("readings") or {}).get("embeddedChecked")),   # лист прочитан, закладных на нём нет — тоже результат
            "prices": bool(resources) and rate > 0 and labour_ok and all(float(r["rate"]) > 0 for r in resources),
            "norms": family in confirmed_groups,
            "verified": row["id"] in verified_ids,
        }
        origin = {
            "volume": "вручную" if "volume" in manual else "чтение листа" if "объём" in applied else "каталог поставщика",
            "concreteClass": "чтение листа" if "класс" in applied else "каталог поставщика",
            "rebar": "оценка по нормативу" if "steelEstimate" in ids else "чтение листа" if "арматура" in applied else "каталог поставщика",
        }
        if doc and doc.get("family") and doc.get("alias") and _unset(doc.get("concreteClass")):      # изделия вне каталога (две колонны из Excel) в таблицу типов не входят
            entry = types_without_class[type_key(doc)]; entry["count"] += 1; entry["family"] = family
        products.append({"family": family, "checks": checks, "origin": origin})
        classes[(concrete_class or "Не указан") if not _unset(concrete_class) else "Не указан"] += 1
        for r in resources:
            usage[r["id"]]["name"] = r["name"]; usage[r["id"]]["products"] += 1
        status = model_readiness(doc)["status"] if doc else "missing"
        shown_3d[status if status in ("complete", "partial", "envelope") else "missing"] += 1

    total = len(products)
    keys = [c[0] for c in CRITERIA]
    funnel = []
    for index, (key, title, owner, hint) in enumerate(CRITERIA):
        done = sum(all(p["checks"][k] for k in keys[:index + 1]) for p in products)
        alone = sum(p["checks"][key] for p in products)
        funnel.append({"key": key, "title": title, "owner": owner, "hint": hint, "cumulative": done, "alone": alone})
    families = {}
    for p in products:
        f = families.setdefault(p["family"], {"name": p["family"], "total": 0, **{k: 0 for k in keys}, "ready": 0})
        f["total"] += 1
        for k in keys:
            f[k] += p["checks"][k]
        f["ready"] += all(p["checks"].values())
    origin = {k: collections.Counter(p["origin"][k] for p in products if p["checks"][k]) for k in ("volume", "concreteClass", "rebar")}
    gaps = sorted(({"family": f["name"], "criterion": key, "title": title, "owner": owner, "missing": f["total"] - f[key]}
                   for f in families.values() for key, title, owner, _ in CRITERIA[:5] if f["total"] - f[key] > 0), key=lambda g: -g["missing"])[:12]
    materials = prices["materials"]
    unpriced = sorted(({"id": i, "name": u["name"], "products": u["products"]} for i, u in usage.items()
                       if float((materials.get(i) or {"rate": 0})["rate"]) <= 0), key=lambda m: -m["products"])
    concrete = prices["concrete"]
    class_rows = [{"name": c, "products": n, "priced": c != "Не указан" and float(concrete.get(norm_class(c), 0) or 0) > 0}
                  for c, n in sorted(classes.items(), key=lambda x: -x[1])]
    # прогресс целиком: среднее долей по семи условиям (каждое условие равноправно)
    percent = round(100 * sum(f["alone"] for f in funnel) / (total * len(funnel)), 1) if total else 0
    return {
        "total": total, "ready": funnel[-1]["cumulative"], "percent": percent, "funnel": funnel,
        "families": sorted(families.values(), key=lambda f: -f["total"]), "gaps": gaps, "origin": {k: dict(v) for k, v in origin.items()},
        "prices": {"materials": len(materials), "unpriced": len(unpriced), "unpricedList": unpriced[:15], "usage": {i: u["products"] for i, u in usage.items()}, "classes": class_rows,
                   "labourRate": float(prices["labour"]["rate"]), "pricesVersion": ctx["prices"]["version"]},
        "norms": {"families": sorted(families), "confirmed": sorted(confirmed_groups),
                  "basis": "Общая норма (труд на м³, коэффициент расхода) выведена по двум исходным колоннам; группа считается подтверждённой, когда технолог отметил её нормы в «Расценки и нормы»."},
        "classTypes": sorted(({"key": k, "family": v["family"], "count": v["count"], "assigned": class_by_type.get(k) or ""} for k, v in types_without_class.items()), key=lambda x: -x["count"]),
        "model3d": dict(shown_3d),
    }
