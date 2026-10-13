"""Коэффициент армирования: расход арматуры на 1 м³ проектного бетона, кг/м³ — контроль полноты арматуры изделия.

Арматура считается по чертежам готовыми килограммами, поэтому «арматура есть» ещё не значит «арматура полная»: у колонны, для которой каталог поставщика знает
один хомут, показатель около 1 кг/м³ при типичных 200. Здесь показатель сравнивается с типичным значением того же типа изделий (если в типе не меньше MIN_TYPE
изделий) или группы: ниже LOW × типичного — арматура, скорее всего, прочитана не полностью; выше HIGH × типичного — она относится к другому изделию или объём
занижен. Типичное значение — медиана по каталогу. В расчёт стоимости показатель не входит: это проверка, а не вход.
"""
import collections
import statistics

from .document_models import catalog
from .norms import type_key

STEEL = ("steel", "mainsteel", "wire")
ESTIMATE_ID = "steelEstimate"      # оценка по нормативу группы (плиты): это не арматура по чертежам, в показатель не входит
LOW, HIGH = 0.25, 3.0
MIN_TYPE, MIN_FAMILY = 15, 5
_cache = {"catalog": None, "refs": None}


def coefficient(volume, resources):
    """кг/м³ по проектному объёму и ресурсам модели (projectQty — тонны) или None, если объёма или арматуры по чертежам нет."""
    volume = float(volume or 0)
    kg = sum(float(r.get("projectQty") or 0) for r in resources or [] if r["id"].startswith(STEEL) and r["id"] != ESTIMATE_ID) * 1000
    return kg / volume if volume > 0 and kg > 0 else None


def _references():
    """Типичные значения: ({группа: (медиана, число изделий)}, {тип: (медиана, число изделий)}); пересчитываются при смене каталога."""
    models = catalog()
    if _cache["catalog"] is models:
        return _cache["refs"]
    by_family, by_type = collections.defaultdict(list), collections.defaultdict(list)
    for model in models.values():
        if model.get("kind") != "registry" or not model.get("family"):
            continue
        value = coefficient(model.get("projectVolume"), model.get("resources"))
        if value:
            by_family[model["family"]].append(value)
            by_type[type_key(model)].append(value)
    refs = ({k: (statistics.median(v), len(v)) for k, v in by_family.items() if len(v) >= MIN_FAMILY},
            {k: (statistics.median(v), len(v)) for k, v in by_type.items() if len(v) >= MIN_TYPE})
    _cache["catalog"], _cache["refs"] = models, refs
    return refs


def assess(doc):
    """Оценка модели изделия: {value, reference, scopeName, count, min, max, status} или None, если показателя нет.
    status: 'ok' — в диапазоне, 'low' — ниже, 'high' — выше, 'unknown' — типичного значения нет (мало изделий в группе)."""
    if not doc or doc.get("kind") != "registry":
        return None
    value = coefficient(doc.get("projectVolume"), doc.get("resources"))
    if value is None:
        return None
    families, types = _references()
    key = type_key(doc)
    if key in types:
        reference, count = types[key]; scope = key
    elif doc.get("family") in families:
        reference, count = families[doc["family"]]; scope = doc["family"]
    else:
        return {"value": round(value, 1), "reference": None, "scopeName": "", "count": 0, "min": None, "max": None, "status": "unknown"}
    status = "low" if value < reference * LOW else "high" if value > reference * HIGH else "ok"
    return {"value": round(value, 1), "reference": round(reference), "scopeName": scope, "count": count,
            "min": round(reference * LOW), "max": round(reference * HIGH), "status": status}


def issue_text(found):
    """Текст замечания для изделия вне диапазона."""
    head = "%g кг/м³ при типичных %d для «%s» (допустимо %d–%d, по %d изделиям). " % (found["value"], found["reference"], found["scopeName"], found["min"], found["max"], found["count"])
    if found["status"] == "low":
        return head + "Мало: арматура, скорее всего, прочитана не полностью. Сверить ведомость расхода стали и спецификации каркасов и сеток; если данные верны — отметить изделие проверенным."
    return head + "Много: арматура, скорее всего, относится к другому изделию или объём бетона занижен. Сверить лист; если данные верны — отметить изделие проверенным."
