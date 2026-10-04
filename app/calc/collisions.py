"""Коллизии модели: пересечения деталей и арматуры из отчёта проверки модели (solidModel.qa.geometricViolations),
статусы и комментарии людей. Сами пересечения не вычисляются заново: берутся записи проверки поставщика модели
(verify_columns.py) с координатами примеров; по каждому классу пересечений в отчёте только часть примеров —
общее число пар (`pairCount`) показывается рядом, чтобы «показано» не читалось как «всего».
Статусы и комментарии принадлежат модели (а не изделию) и не удаляются."""
import copy
import hashlib
import re
from functools import lru_cache
from uuid import uuid4

from fastapi import HTTPException

from .database import audit, now
from .document_models import model
from . import geometry_check

STATUSES = {"open": "Открыта", "designer": "Передана проектировщику", "accepted": "Принята без изменений", "resolved": "Устранена"}
COLLISION_WORDS = re.compile(r"пересек|пересеч|коллиз|проникнов|столкнов", re.I)


def is_collision_text(*parts):
    return bool(COLLISION_WORDS.search(" ".join(p for p in parts if p)))


def _key(model_id, parts, a, b, at):
    return hashlib.sha1("|".join([model_id, parts or "", a or "", b or "", ",".join(str(v) for v in (at or []))]).encode()).hexdigest()[:16]


@lru_cache(maxsize=512)
def _own_check(model_id):
    solid = (model(model_id) or {}).get("solidModel")
    return geometry_check.tube_classes(model_id, solid) if solid else ([], {"tubes": 0, "bars": 0})


def clear_cache():
    _own_check.cache_clear()


def extract(model_id):
    """Классы пересечений и примеры с координатами. Нет solidModel/qa — пустой список с причиной."""
    entry = model(model_id) if model_id else None
    solid = (entry or {}).get("solidModel")
    qa = (solid or {}).get("qa") or {}
    classes = []
    for index, violation in enumerate(qa.get("geometricViolations") or []):
        items = []
        for example in violation.get("examples") or []:
            at = example.get("at")
            items.append({"key": _key(model_id, violation.get("parts"), example.get("a"), example.get("b"), at),
                          "a": example.get("a"), "b": example.get("b"), "penetrationMm": example.get("penetrationMm"),
                          "at": at if isinstance(at, list) and len(at) == 3 else None})
        classes.append({"id": "c%d" % index, "origin": "report", "originLabel": "Отчёт проверки модели", "parts": violation.get("parts"), "pairCount": violation.get("pairCount"),
                        "uniqueBarPairs": violation.get("uniqueBarPairs"), "maxPenetrationMm": violation.get("maxPenetrationMm"),
                        "sourcePdfPages": violation.get("sourcePdfPages") or [], "declaredAsSourceConflict": bool(violation.get("declaredAsSourceConflict")),
                        "items": items})
    own, own_scope = copy.deepcopy(_own_check(model_id)) if solid else ([], {"tubes": 0, "bars": 0})
    for cls in own:
        for item in cls["items"]:
            item["key"] = _key(model_id, cls["parts"], item["a"], item["b"], item["at"])
        cls["id"] = "c%d" % len(classes)
        classes.append(cls)
    reason = None if solid else "У этого изделия нет восстановленной 3D-модели: данных о пересечениях нет."
    if solid and not classes:
        reason = "Пересечений не найдено ни в отчёте проверки модели, ни при собственной проверке труб (труб в модели: %d)." % own_scope.get("tubes", 0)
    return {"modelId": model_id, "classes": classes, "reason": reason,
            "scope": (qa.get("qaScope") or {}).get("tool") if isinstance(qa.get("qaScope"), dict) else None,
            "totalPairs": sum(c["pairCount"] or 0 for c in classes), "ownCheck": own_scope}


def listing(conn, model_id):
    data = extract(model_id)
    states = {r["collision_key"]: r for r in conn.execute("SELECT * FROM collision_state WHERE model_id=?", (model_id,))}
    notes = {}
    for r in conn.execute("SELECT * FROM collision_notes WHERE model_id=? ORDER BY created_at,id", (model_id,)):
        notes.setdefault(r["collision_key"], []).append({"id": r["id"], "author": r["author_name"], "text": r["text"], "createdAt": r["created_at"]})
    for cls in data["classes"]:
        for item in cls["items"]:
            state = states.get(item["key"])
            item["status"] = state["status"] if state else "open"
            item["statusUpdatedBy"] = state["updated_by"] if state else None
            item["notes"] = notes.get(item["key"], [])
    data["statuses"] = STATUSES
    return data


def _require_key(model_id, key):
    for cls in extract(model_id)["classes"]:
        if any(i["key"] == key for i in cls["items"]):
            return
    raise HTTPException(404, "Коллизия не найдена в модели")


def add_note(conn, model_id, key, text, actor):
    text = (text or "").strip()
    if not text or len(text) > 2000:
        raise HTTPException(422, "Комментарий: от 1 до 2000 символов")
    _require_key(model_id, key)
    identifier = str(uuid4())
    conn.execute("INSERT INTO collision_notes(id,model_id,collision_key,author_id,author_name,text,created_at) VALUES(?,?,?,?,?,?,?)",
                 (identifier, model_id, key, actor["id"], actor["displayName"], text, now()))
    audit(conn, actor["id"], "collision.note", key, {"modelId": model_id})
    return identifier


def set_status(conn, model_id, key, status, actor):
    if status not in STATUSES:
        raise HTTPException(422, "Недопустимый статус")
    _require_key(model_id, key)
    conn.execute("INSERT INTO collision_state VALUES(?,?,?,?,?) ON CONFLICT(model_id,collision_key) DO UPDATE SET status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
                 (model_id, key, status, actor["displayName"], now()))
    audit(conn, actor["id"], "collision.status", key, {"modelId": model_id, "status": status})
