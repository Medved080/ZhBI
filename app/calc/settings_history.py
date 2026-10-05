"""История изменений настроек калькулятора: расценки, начисления, нормы, подтверждения изделий — из журнала аудита (audit_log).

Каждое сохранение расценок, профиля и норм уже пишет в журнал новую версию с содержанием «было → стало»; здесь они приводятся к читаемому виду
(кто, когда, версия, список изменений с русскими подписями) для раздела «История» в «Цены и нормы». Ничего не хранится отдельно."""
import json
from decimal import Decimal, InvalidOperation

ACTIONS = ("norms.updated", "prices.updated", "profile.updated", "products.verified.bulk", "product.verified", "product.unverified")
KIND = {"norms.updated": "norms", "prices.updated": "prices", "profile.updated": "profile",
        "products.verified.bulk": "verification", "product.verified": "verification", "product.unverified": "verification"}
KIND_TITLE = {"norms": "Нормы", "prices": "Расценки", "profile": "Начисления и НДС", "verification": "Проверка изделий"}
PROFILE_LABELS = {"socialPercent": "Страховые взносы, % от оплаты труда", "energyPercent": "Энергоуслуги, % от материалов", "overheadPercent": "Общепроизводственные, % от материалов",
                  "adminPercent": "Административные, % от материалов", "commercialPercent": "Коммерческие, % от материалов", "profitPercent": "Маржа (прибыль), %",
                  "deliveryPercent": "Доставка, % от материалов", "vatPercent": "НДС, %"}
GROUP_FIELDS = {"hoursPerM3": "труд на м³, чел·ч", "concreteFactor": "расход бетона, коэфф.", "steelKgPerM3": "арматура без чертежа, кг на м³", "confirmed": "подтверждено технологом"}


def _show(value):
    """Значение для показа: число без хвоста нулей, пусто — «общая норма / не задано»."""
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "да" if value else "нет"
    try:
        return format(Decimal(str(value)).normalize(), "f").replace(".", ",")
    except (InvalidOperation, ValueError):
        return str(value)


def _norms_changes(before, after):
    """Что изменилось в нормах между двумя версиями: общие показатели, коэффициенты ресурсов, нормы групп, классы по типам."""
    changes = []
    for key, title in (("concreteFactor", "Расход бетона: общий коэффициент"), ("hoursPerM3", "Труд на м³: общая норма, чел·ч")):
        if str(before.get(key)) != str(after.get(key)):
            changes.append({"label": title, "before": _show(before.get(key)), "after": _show(after.get(key))})
    for key, entry in (after.get("resources") or {}).items():
        old = (before.get("resources") or {}).get(key, {}).get("factor")
        if old is not None and str(old) != str(entry.get("factor")):
            changes.append({"label": "Коэффициент расхода: " + (entry.get("name") or key), "before": _show(old), "after": _show(entry.get("factor"))})
    groups_before, groups_after = before.get("groups") or {}, after.get("groups") or {}
    for family in sorted(set(groups_before) | set(groups_after)):
        a, b = groups_before.get(family) or {}, groups_after.get(family) or {}
        for field, title in GROUP_FIELDS.items():
            if a.get(field) != b.get(field) and not (field == "confirmed" and not a.get(field) and not b.get(field)):
                changes.append({"label": "%s: %s" % (family, title), "before": _show(a.get(field)), "after": _show(b.get(field))})
    classes_before, classes_after = before.get("classByType") or {}, after.get("classByType") or {}
    for kind in sorted(set(classes_before) | set(classes_after)):
        if classes_before.get(kind) != classes_after.get(kind):
            changes.append({"label": "Класс бетона типа «%s»" % kind, "before": _show(classes_before.get(kind)), "after": _show(classes_after.get(kind))})
    return changes


def _price_changes(detail, names):
    result = []
    for change in detail.get("changes") or []:
        item = change["item"]
        if item.startswith("concrete:"):
            label = "Бетон: цена по умолчанию, ₽/м³" if item == "concrete:default" else "Бетон %s, ₽/м³" % item[9:]
        elif item == "labour":
            label = "Труд, ₽/чел·ч"
        else:
            key = item.split(":", 1)[1]
            label = "Цена: " + names.get(key, key)
        result.append({"label": label, "before": _show(change.get("before")), "after": _show(change.get("after"))})
    return result


def entries(conn, limit=150, kind=None):
    """Записи истории, новые первыми. kind — norms | prices | profile | verification | None (все)."""
    from .prices import get_prices
    names = {key: meta["name"] for key, meta in get_prices(conn, persist=False)["parameters"]["materials"].items()}
    actions = [a for a in ACTIONS if kind in (None, KIND[a])]
    rows = conn.execute("SELECT id,actor_id,action,entity_id,detail_json,created_at FROM audit_log WHERE action IN (%s) ORDER BY id DESC LIMIT ?" % ",".join("?" * len(actions)),
                        (*actions, int(limit))).fetchall()
    products = {}
    out = []
    for row in rows:
        detail = json.loads(row["detail_json"] or "{}")
        kind_of = KIND[row["action"]]
        entry = {"id": row["id"], "at": row["created_at"], "actorId": row["actor_id"], "kind": kind_of, "kindTitle": KIND_TITLE[kind_of], "version": detail.get("version"), "changes": [], "summary": ""}
        if row["action"] == "norms.updated":
            entry["changes"] = _norms_changes(detail.get("before") or {}, detail.get("after") or {})
        elif row["action"] == "prices.updated":
            entry["changes"] = _price_changes(detail, names)
        elif row["action"] == "profile.updated":
            entry["changes"] = [{"label": PROFILE_LABELS.get(c["item"], c["item"]), "before": _show(c["before"]), "after": _show(c["after"])} for c in detail.get("changes") or []]
        elif row["action"] == "products.verified.bulk":
            ids = detail.get("ids") or []
            for pid in ids[:60]:
                if pid not in products:
                    found = conn.execute("SELECT name FROM products WHERE id=?", (pid,)).fetchone()
                    products[pid] = found["name"] if found else pid
            verb = "отмечены проверенными" if detail.get("verified", True) else "сняты отметки проверки"
            entry["summary"] = "%s: %d изд.%s" % (verb[0].upper() + verb[1:], len(ids), (" · " + detail["note"]) if detail.get("note") else "")
            entry["changes"] = [{"label": products[pid], "before": "—" if detail.get("verified", True) else "проверено", "after": "проверено" if detail.get("verified", True) else "—"} for pid in ids[:60]]
            if len(ids) > 60:
                entry["changes"].append({"label": "и ещё %d изд." % (len(ids) - 60), "before": "", "after": ""})
        else:
            pid = row["entity_id"]
            if pid not in products:
                found = conn.execute("SELECT name FROM products WHERE id=?", (pid,)).fetchone()
                products[pid] = found["name"] if found else pid
            ok = row["action"] == "product.verified"
            entry["summary"] = "%s: %s%s" % ("Отмечено проверенным" if ok else "Снята отметка проверки", products[pid], (" · " + detail["note"]) if detail.get("note") else "")
        out.append(entry)
    return out


def with_names(items):
    """Подписи исполнителей из пользователей ЖБИ (id → «Фамилия И.О.»); неизвестный id остаётся как есть."""
    ids = sorted({str(i["actorId"]) for i in items if i["actorId"] and str(i["actorId"]).isdigit()})
    names = {}
    if ids:
        from app.db import get_connection
        from app.auth import format_display_name
        conn = get_connection()
        try:
            for row in conn.execute("SELECT * FROM users WHERE id IN (%s)" % ",".join("?" * len(ids)), ids).fetchall():
                names[str(row["id"])] = format_display_name(row) or row["domain_login"]
        finally:
            conn.close()
    for item in items:
        item["actor"] = names.get(str(item["actorId"]), str(item["actorId"] or "система"))
    return items
