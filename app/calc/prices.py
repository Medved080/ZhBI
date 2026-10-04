"""Единый прайс-лист сервиса: расценки на материалы и работы (цены без НДС).

Бетон — цена за м³ по классам (ключ «default» — для класса без цены и «Не указан»); материалы — цена по коду ресурса каталога
(арматура по диаметру и классу, проволока, трубы); труд — ставка чел·ч. Проценты начислений и НДС лежат в профиле расчёта
(calculation_profiles). Стоимость изделий всегда считается от ТЕКУЩИХ расценок (repository.get_product), поэтому смена расценки
сразу меняет все изделия, и ничего не перезаписывается; ручные правки изделия (строки расчёта и поля, помеченные manual_fields)
сохраняются. Версия прайса растёт при каждом изменении; изменения пишутся в журнал аудита с составом «было → стало»."""
import json
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from .database import PROFILE_ID, audit, dumps, now

PRICE_ID = "main"
_LATIN = str.maketrans("ABCEHKMOPTXY", "АВСЕНКМОРТХУ")   # латинские буквы, похожие на кириллические (В40 в чертежах пишут по-разному)
D = lambda value: Decimal(str(value))


def norm_class(value):
    """Класс бетона в единой записи: верхний регистр, без пробелов, кириллица («b40» → «В40»)."""
    return str(value or "").strip().upper().replace(" ", "").translate(_LATIN)


def catalog_materials():
    """Материалы каталога проектной документации: {код ресурса: {name, unit}}."""
    from .document_models import catalog
    found = {}
    for doc in catalog().values():
        for resource in doc.get("resources") or []:
            found.setdefault(resource["id"], {"name": resource["name"], "unit": resource["unit"]})
    return dict(sorted(found.items()))


def catalog_classes():
    from .document_models import catalog
    return sorted({norm_class(doc["concreteClass"]) for doc in catalog().values() if doc.get("concreteClass") and doc["concreteClass"] != "Не указан"})


def initial_prices(conn):
    """Начальный прайс из того, что действовало до его появления: цена бетона и ставка труда — из норм (иначе из профиля),
    цены арматуры и проволоки — из норм для тех типов, что нормы знали; остальные — 0 («цена не задана»)."""
    from .norms import match_resource
    profile = json.loads(conn.execute("SELECT parameters_json FROM calculation_profiles WHERE id=?", (PROFILE_ID,)).fetchone()[0])
    row = conn.execute("SELECT parameters_json FROM production_norms WHERE id='msu-1-columns'").fetchone()
    norms = json.loads(row[0]) if row else None
    concrete = str((norms or {}).get("concreteRate") or profile["defaultConcreteRate"])
    materials = {}
    for key, meta in catalog_materials().items():
        norm = match_resource({"id": key, **meta}, norms) if norms else None
        materials[key] = {**meta, "rate": str(norm["rate"]) if norm else "0"}
    return {"concrete": {"default": concrete, **{c: concrete for c in catalog_classes()}},
            "labour": {"rate": str((norms or {}).get("labourRate") or profile["labourRate"])},
            "materials": materials}


def complete(parameters):
    """Дополняет прайс ключами, появившимися в каталоге после сохранения (цена 0 — «не задана»). Ничего не записывает."""
    result = json.loads(dumps(parameters))
    for key, meta in catalog_materials().items():
        result["materials"].setdefault(key, {**meta, "rate": "0"})
    for cls in catalog_classes():
        result["concrete"].setdefault(cls, result["concrete"]["default"])
    return result


def get_prices(conn, persist=True):
    """Текущий прайс {version, parameters, updatedAt}. persist=True (в записывающей транзакции: старт сервиса, приём каталога) создаёт прайс
    из начального (initial_prices) и дополняет его по каталогу; persist=False (чтение) ничего не пишет и при отсутствии прайса возвращает начальный."""
    row = conn.execute("SELECT * FROM price_list WHERE id=?", (PRICE_ID,)).fetchone()
    if row is None and not persist:
        return {"version": 1, "parameters": complete(initial_prices(conn)), "updatedAt": now()}
    if row is None:
        parameters = initial_prices(conn)
        conn.execute("INSERT INTO price_list VALUES(?,?,?,?,?)", (PRICE_ID, 1, dumps(parameters), now(), "system"))
        _mark_manual_fields(conn, parameters)
        row = conn.execute("SELECT * FROM price_list WHERE id=?", (PRICE_ID,)).fetchone()
    elif persist and row["version"] == 1 and row["actor_id"] == "system" and len(json.loads(row["parameters_json"])["materials"]) < len(catalog_materials()):
        # прайс создан до того, как на сервер пришёл каталог моделей, и ещё никем не менялся — пересоздаём из норм и каталога
        parameters = initial_prices(conn)
        conn.execute("UPDATE price_list SET parameters_json=?,updated_at=? WHERE id=?", (dumps(parameters), now(), PRICE_ID))
        _mark_manual_fields(conn, parameters)
        row = conn.execute("SELECT * FROM price_list WHERE id=?", (PRICE_ID,)).fetchone()
    return {"version": row["version"], "parameters": complete(json.loads(row["parameters_json"])), "updatedAt": row["updated_at"]}


def concrete_rate(parameters, concrete_class):
    """Цена бетона класса; класса нет в прайсе или он не указан — цена по умолчанию."""
    return D(parameters["concrete"].get(norm_class(concrete_class), parameters["concrete"]["default"]))


def material_rate(parameters, key, fallback=0):
    entry = parameters["materials"].get(key)
    return D(entry["rate"]) if entry else D(fallback)


class PricesSave(BaseModel):
    expectedVersion: int = Field(ge=1)
    concrete: dict[str, Decimal]
    labour: Decimal
    materials: dict[str, Decimal]

    @model_validator(mode="after")
    def check(self):
        if "default" not in self.concrete:
            raise ValueError("Нужна цена бетона по умолчанию")
        for value in [*self.concrete.values(), self.labour, *self.materials.values()]:
            if not value.is_finite() or value < 0 or value > Decimal("1e9"):
                raise ValueError("Цена должна быть числом от 0 до 1 000 000 000")
        return self


def update_prices(conn, body, actor):
    from fastapi import HTTPException
    current = get_prices(conn)
    if current["version"] != body.expectedVersion:
        raise HTTPException(409, "Расценки изменены другим пользователем. Обновите раздел.")
    parameters = current["parameters"]
    if set(body.materials) - set(parameters["materials"]):
        raise HTTPException(422, "В прайсе есть материалы, которых нет в каталоге")
    before = json.loads(dumps(parameters))
    parameters["concrete"] = {key: str(value) for key, value in body.concrete.items()}
    parameters["labour"] = {"rate": str(body.labour)}
    for key, value in body.materials.items():
        parameters["materials"][key]["rate"] = str(value)
    changes = _diff(before, parameters)
    if not changes:
        return current
    version = current["version"] + 1
    conn.execute("UPDATE price_list SET version=?,parameters_json=?,updated_at=?,actor_id=? WHERE id=?", (version, dumps(parameters), now(), actor, PRICE_ID))
    audit(conn, actor, "prices.updated", PRICE_ID, {"version": version, "changes": changes})
    return {"version": version, "parameters": parameters, "updatedAt": now()}


def _diff(before, after):
    changes = []
    for key in sorted(set(before["concrete"]) | set(after["concrete"])):
        a, b = before["concrete"].get(key), after["concrete"].get(key)
        if a is None or b is None or D(a) != D(b):
            changes.append({"item": "concrete:" + key, "before": a, "after": b})
    if D(before["labour"]["rate"]) != D(after["labour"]["rate"]):
        changes.append({"item": "labour", "before": before["labour"]["rate"], "after": after["labour"]["rate"]})
    for key, entry in after["materials"].items():
        old = before["materials"].get(key, {}).get("rate")
        if old is None or D(old) != D(entry["rate"]):
            changes.append({"item": "material:" + key, "before": old, "after": entry["rate"]})
    return changes


def _mark_manual_fields(conn, parameters, ids=None):
    """Один раз при создании прайса: у изделий, где сохранённое значение расходится с расчётом по нормам и начальным расценкам,
    поле было правкой пользователя — оно помечается ручным и дальше не пересчитывается. Совпадающие поля становятся расчётными.
    ids — пересчитать пометки только у этих изделий (починка), иначе у всех."""
    from .document_models import model
    from .norms import get_norms, parameters_for
    from .readings import without_readings
    try:
        norms = get_norms(conn)
    except (FileNotFoundError, KeyError):
        norms = None
    for row in conn.execute("SELECT id,concrete_class,volume,labour_hours,concrete_rate,other_materials,document_model_id,norms_version FROM products").fetchall():
        if ids is not None and row["id"] not in ids: continue
        manual = []
        if abs(D(row["concrete_rate"]) - concrete_rate(parameters, row["concrete_class"])) > D("0.005"):
            manual.append("concreteRate")
        doc = model(row["document_model_id"]) if row["document_model_id"] else None
        if doc: doc = without_readings(doc)      # значения, сохранённые до появления чтений с листов, ручными правками не считаются
        if norms and doc and doc.get("kind") == "registry" and row["norms_version"] is not None:
            values = parameters_for(doc, norms, parameters)
            if abs(D(row["volume"]) - values["volume"]) > D("0.005"):
                manual.append("volume")
            if abs(D(row["labour_hours"]) - D(row["volume"]) * D(norms["parameters"]["hoursPerM3"])) > D("0.005"):
                manual.append("hours")
            if abs(D(row["other_materials"]) - values["otherMaterials"]) > D("0.5"):
                manual.append("otherMaterials")
        conn.execute("UPDATE products SET manual_fields=? WHERE id=?", (dumps(manual), row["id"]))


PROFILE_PERCENTS = ["socialPercent", "energyPercent", "overheadPercent", "adminPercent", "commercialPercent", "profitPercent", "deliveryPercent", "vatPercent"]


def get_profile(conn):
    """Проценты начислений и НДС профиля расчёта: {version, parameters}."""
    row = conn.execute("SELECT * FROM calculation_profiles WHERE id=?", (PROFILE_ID,)).fetchone()
    parameters = json.loads(row["parameters_json"])
    return {"version": row["version"], "name": row["name"], "parameters": {key: parameters[key] for key in PROFILE_PERCENTS}}


def update_profile(conn, body, actor):
    from fastapi import HTTPException
    row = conn.execute("SELECT * FROM calculation_profiles WHERE id=?", (PROFILE_ID,)).fetchone()
    if row["version"] != body.expectedVersion:
        raise HTTPException(409, "Профиль расчёта изменён другим пользователем. Обновите раздел.")
    parameters = json.loads(row["parameters_json"])
    changes = []
    for key in PROFILE_PERCENTS:
        value = str(getattr(body, key))
        if D(parameters[key]) != D(value):
            changes.append({"item": key, "before": parameters[key], "after": value})
            parameters[key] = value
    if not changes:
        return get_profile(conn)
    version = row["version"] + 1
    conn.execute("UPDATE calculation_profiles SET version=?,parameters_json=? WHERE id=?", (version, dumps(parameters), PROFILE_ID))
    audit(conn, actor, "profile.updated", PROFILE_ID, {"version": version, "changes": changes})
    return get_profile(conn)
