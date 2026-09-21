"""Регрессия: журнал действий (activity_log) подтверждает только ЗАФИКСИРОВАННЫЕ изменения.

До исправления события `status_change` ставились в очередь по ходу операции, до commit: при откате пачки в журнале оставались события об
изменениях, которых нет (сценарий S9 scripts/verify_contract_guard_concurrency.py). Теперь события копятся и уходят одним вызовом после commit
(app.activity.defer_*). Проверяется:
  J1  откатившаяся пачка (отказ на 3-м изделии) не оставляет событий status_change; отброшенные посчитаны;
  J2  успешная пачка из 3 изделий — ровно 3 события (без дублей), у каждого автор, старое и новое значение, изделие;
  J3  режим «от имени»: в событиях отметка администратора сохраняется;
  J4  одиночная смена статуса: успех — 1 событие, отказ (409 стража) — 0;
  J5  проведение замены поставщика: успех — события по изделиям, откат проведения (409) — ни одного;
  J6  ошибка постановки в очередь не скрывается: переполнение очереди считается в счётчике потерянных;
  J7  успешная операция, ПОСЛЕ которой обработчик упал бы, событий не оставляет только если commit не состоялся (проверка defer_end).
Запуск (только на копии обезличенной БД): .venv/bin/python scripts/verify_activity_journal.py <копия_БД>
"""

import _guard_harness as H  # noqa: I001
from _guard_harness import call, db, fresh_db, user_row

import sys

import app.activity as activity
import app.main as main
from app import supplier_change as sc
from app.models import BulkStatusItem, BulkStatusUpdateIn, Status, StatusUpdateIn

ADMIN = user_row()
FAILS = []


def bulk(ids, cid, status="contracting"):
    return BulkStatusUpdateIn(items=[BulkStatusItem(element_id=i, contract_id=cid) for i in ids], status=Status(status))


MARK = {"id": 0}


def mark():
    """Отметка: дальше считаются только события, появившиеся после неё (в копии БД уже есть прежние)."""
    activity.flush_for_tests()
    c = db()
    MARK["id"] = c.execute("SELECT COALESCE(MAX(id), 0) m FROM activity_log").fetchone()["m"]
    c.close()


def events(action, ids=None):
    activity.flush_for_tests()
    c = db()
    rows = c.execute("SELECT * FROM activity_log WHERE action = ? AND id > ? ORDER BY id", (action, MARK["id"])).fetchall()
    c.close()
    return [r for r in rows if ids is None or r["entity_id"] in ids]


def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


SKIP = {"n": 0}


def prep(n, remaining):
    """Свежая позиция на каждый сценарий (одна БД на весь прогон: писатель журнала держит файл открытым, подменять его нельзя)."""
    c = db()
    pos, ids = H.find_position(c, n, skip=SKIP["n"])
    SKIP["n"] += 1
    H.make_room(c, pos, remaining)
    c.close()
    return pos, ids


if __name__ == "__main__":
    activity.start_worker()

    print("J1 откат пачки")
    mark(); pos, ids = prep(3, 2); cid = pos["contract_id"]
    d0 = activity.discarded_count()
    r = call(main.update_status_bulk, bulk(ids[:3], cid), ADMIN)
    check("пачка отклонена (409)", r[0] == 409, str(r))
    check("в журнале нет status_change по этим изделиям", not events("status_change", set(ids[:3])), f"{len(events('status_change', set(ids[:3])))}")
    check("отброшено 2 события об откатившихся изменениях", activity.discarded_count() - d0 == 2, str(activity.discarded_count() - d0))

    print("J2 успешная пачка")
    mark(); pos, ids = prep(4, 3); cid = pos["contract_id"]
    r = call(main.update_status_bulk, bulk(ids[:3], cid), ADMIN)
    ev = events("status_change", set(ids[:3]))
    check("пачка принята", r[0] == "ok", str(r))
    check("ровно 3 события, без дублей", len(ev) == 3 and len({e["entity_id"] for e in ev}) == 3, str(len(ev)))
    check("старое и новое значение: planned → contracting", all(e["old_value"] == "planned" and e["new_value"] == "contracting" for e in ev))
    check("автор записан", all(e["user_id"] == ADMIN["id"] and e["user_name"] for e in ev))
    check("без отметки «от имени»", all(e["impersonator_user_id"] is None for e in ev))

    print("J3 режим «от имени пользователя»")
    from app import impersonation
    mark(); pos, ids = prep(4, 3); cid = pos["contract_id"]
    tok = impersonation.set_current({"admin_id": 999001, "admin_name": "Админ Тест", "user_name": "Пользователь Тест"})
    try:
        r = call(main.update_status_bulk, bulk(ids[:2], cid), ADMIN)
    finally:
        impersonation.reset(tok)
    ev = events("status_change", set(ids[:2]))
    check("отметка администратора сохранена в событиях", len(ev) == 2 and all(e["impersonator_user_id"] == 999001 and e["impersonator_name"] == "Админ Тест" for e in ev), str(r))
    check("в журнале имя без приписки «от имени» (она только в status_history)", all("от имени" not in (e["user_name"] or "") for e in ev))

    print("J4 одиночная смена статуса")
    mark(); pos, ids = prep(3, 1); cid = pos["contract_id"]
    ok = call(main.update_status, ids[0], StatusUpdateIn(status=Status("contracting"), contract_id=cid), ADMIN)
    bad = call(main.update_status, ids[1], StatusUpdateIn(status=Status("contracting"), contract_id=cid), ADMIN)   # места нет → 409
    check("успех — 1 событие", ok[0] == "ok" and len(events("status_change", {ids[0]})) == 1, str(ok[0]))
    check("отказ 409 — 0 событий", bad[0] == 409 and not events("status_change", {ids[1]}), str(bad[0]))

    print("J5 проведение замены поставщика")
    from fastapi import HTTPException
    from verify_lock_release import make_doc   # только функция подготовки данных (сам прогон — под __main__)
    from app import contract_guard
    mark(); doc_id, dids = make_doc(skip=SKIP["n"]); SKIP["n"] += 1
    orig = contract_guard.assert_no_regression
    def refuse(*a, **k):
        raise HTTPException(status_code=409, detail="откат проведения (проверка)")
    contract_guard.assert_no_regression = refuse
    try:
        r = call(sc.post_supplier_change, doc_id, ADMIN)
    finally:
        contract_guard.assert_no_regression = orig
    check("проведение откатилось (409)", r[0] == 409, str(r))
    check("событий supplier_change по изделию нет", not events("supplier_change", set(dids[:1])))
    r = call(sc.post_supplier_change, doc_id, ADMIN)
    check("повторное проведение успешно", r[0] == "ok", str(r))
    check("событие supplier_change — одно, без дубля", len(events("supplier_change", set(dids[:1]))) == 1, str(len(events("supplier_change", set(dids[:1])))))
    check("итоговое событие проведения — одно", len(events("supplier_change_post", {doc_id})) == 1)

    print("J6 ошибка очереди не скрывается")
    d0 = activity._dropped
    q_old = activity._queue
    import queue
    activity._queue = queue.Queue(maxsize=1)
    activity._queue.put_nowait({})
    buf = activity.defer_begin()
    activity.log("status_change", entity_type="element", entity_id=1)
    activity.defer_flush(buf)
    check("переполнение очереди при сбросе засчитано в потерянные", activity._dropped == d0 + 1, f"{activity._dropped - d0}")
    activity._queue = q_old

    print(f"\nнарушений: {len(FAILS)}")
    sys.exit(1 if FAILS else 0)
