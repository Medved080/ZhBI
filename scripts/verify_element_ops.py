"""Проверка безопасных операций над изделиями `POST /element-ops/{status-batch,planned-date-batch,contract}` (app/element_ops.py)
по HTTP (настоящий сервер, маршруты, пул потоков, ответы об ошибках) на КОПИИ обезличенной БД. Авторизация — подмена заголовком
`X-Test-User` только в тестовом процессе; без заголовка проверяется настоящий отказ 401.

Сценарии:
 S1 предпросмотр ничего не пишет · S2 смена статуса с контрактом (контракт СОХРАНЯЕТСЯ, история/журнал) · S3 возврат на «Запланирован»:
 последствия в предпросмотре, подтверждение обязательно, контракты и фактическая дата снимаются · S4 устаревшее состояние (контракт/статус
 изменил другой пользователь) — 409 без изменений · S5 недопустимая пачка (дубли, пустая, нет изделия, чужой объект, тот же статус, формат даты,
 лимит) · S6 права: целиком, смешанные объекты, 401 · S7 повтор и двойной клик (идемпотентность, частичный повтор) · S8 назначение контракта
 изделиям без контракта: страж остатка, откат всей пачки, журнал · S9 конкуренция · S10 плановая дата пачки · S11 контракт одного изделия ·
 S12 освобождение блокировки при любом исходе · S13 совместимость прежних операций V1.

Запуск: .venv/bin/python scripts/verify_element_ops.py <копия_БД>
"""

import _guard_harness as H  # noqa: I001
from _guard_harness import db, http, race, start_http_server, user_row

import json
import sys
import threading
import time

import app.activity as activity
import app.db as appdb

PORT, SERVER = start_http_server()
ADMIN = user_row()
ADMIN_ID = ADMIN["id"]
FAILS = []
MARK = {"id": 0}
USER2 = user_row("domain_login = 'user2'")["id"]      # роль user на объекте 1: status/planned_date/comment/history — запись
USER4 = user_row("domain_login = 'user4'")["id"]      # роль view


def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def api(method, path, body=None, user=ADMIN_ID):
    return http(PORT, method, path, body, user)


def el(eid):
    c = db()
    r = dict(c.execute("SELECT * FROM elements WHERE id = ?", (eid,)).fetchone())
    c.close()
    return r


def hist(eid):
    c = db()
    n = c.execute("SELECT COUNT(*) n FROM status_history WHERE element_id = ?", (eid,)).fetchone()["n"]
    c.close()
    return n


def mark_events():
    activity.flush_for_tests()
    c = db()
    MARK["id"] = c.execute("SELECT COALESCE(MAX(id), 0) m FROM activity_log").fetchone()["m"]
    c.close()


def events(action, ids=None):
    activity.flush_for_tests()
    c = db()
    rows = c.execute("SELECT * FROM activity_log WHERE action = ? AND id > ?", (action, MARK["id"])).fetchall()
    c.close()
    return [r for r in rows if ids is None or r["entity_id"] in ids]


def all_events():
    activity.flush_for_tests()
    c = db()
    # request_denied — штатное событие аудита отказа (4xx), а не подтверждение операции: в «журнал операции» не входит
    rows = c.execute("SELECT * FROM activity_log WHERE id > ? AND action != 'request_denied'", (MARK["id"],)).fetchall()
    c.close()
    return rows


USED = set()


def pick(where, n, obj=1):
    """n свободных изделий объекта по условию (не использованных прежними сценариями)."""
    c = db()
    rows = [r["id"] for r in c.execute(f"SELECT id FROM elements WHERE object_id = ? AND is_current = 1 AND {where} ORDER BY id", (obj,)) if r["id"] not in USED]
    c.close()
    out = rows[:n]
    assert len(out) == n, f"в копии не хватило изделий по условию {where}"
    USED.update(out)
    return out


def contracted(status, n):
    return pick(f"current_status = '{status}' AND contract_id IS NOT NULL", n)


def items(ids, target=None):
    """Ожидаемое состояние = то, что сейчас в базе (клиент только что прочитал схему)."""
    return [{"element_id": i, "expected_status": el(i)["current_status"], "expected_contract_id": el(i)["contract_id"]} for i in ids]


def sb(ids, status, mode="apply", expect=None, **extra):
    body = {"mode": mode, "object_id": 1, "status": status, "items": items(ids)}
    if mode == "apply":
        body["expect"] = expect if expect is not None else {"release_contracts": 0, "without_contract": 0}
    body.update(extra)
    return body


def stable(r):
    skip = {"current_status", "contract_id", "updated_at", "actual_delivery_date"}
    return {k: v for k, v in r.items() if k not in skip}


def main_run():
    print(f"сервер на порту {PORT}; администратор {ADMIN['domain_login']}, user2 №{USER2}, user4 №{USER4}")
    H.track_connections(appdb, __import__("app.element_ops", fromlist=["x"]))
    c = db()
    # user4 — роль view: в копии у неё есть запись «статусы»; для проверки отказа записи делаем её чтением (в ВРЕМЕННОЙ копии)
    c.execute("UPDATE role_features SET level = 'read' WHERE role_key = 'view' AND feature_key IN ('status', 'planned_date', 'comment', 'history')")
    c.commit()
    c.close()

    print("S1 предпросмотр ничего не пишет")
    ids = contracted("contracting", 3)
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "in_production", "preview"))
    check("200 и режим preview", st == 200 and js.get("mode") == "preview", f"{st} {js}")
    check("последствия: контрактов снимется 0, останутся те же", js.get("consequences", {}).get("release_contracts") == 0
          and all(i["contract_after"] == i["contract_before"] for i in js.get("items", [])) and len(js.get("items", [])) == 3)
    check("после предпросмотра таблицы как были", H.checksum() == snap)
    check("в журнале нет событий", not all_events())
    check("блокировка записи освобождена", H.other_writer_ok() and not H.released())

    print("S2 смена статуса пачки с контрактом (контракт сохраняется)")
    ids = contracted("contracting", 3)
    before = {i: el(i) for i in ids}; h0 = {i: hist(i) for i in ids}
    others = {i: el(i) for i in pick("current_status = 'contracting' AND contract_id IS NOT NULL", 2)}
    mark_events()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "in_production", changed_at="2026-09-01T09:30", comment="партия 1"))
    check("200, три изделия в ответе", st == 200 and len(js.get("applied", [])) == 3 and not js.get("already_applied"), f"{st} {js}")
    check("статус изменён, КОНТРАКТ СОХРАНЁН", all(el(i)["current_status"] == "in_production" and el(i)["contract_id"] == before[i]["contract_id"] for i in ids))
    check("остальные поля не тронуты", all(stable(el(i)) == stable(before[i]) for i in ids))
    check("история: +1 запись у каждого, с датой, автором и комментарием", all(hist(i) == h0[i] + 1 for i in ids))
    c = db()
    row = c.execute("SELECT * FROM status_history WHERE element_id = ? ORDER BY id DESC LIMIT 1", (ids[0],)).fetchone()
    c.close()
    check("запись истории: 2026-09-01 09:30:00, комментарий, контракт сохранён", row["changed_at"] == "2026-09-01 09:30:00" and row["comment"] == "партия 1"
          and row["contract_id"] == before[ids[0]]["contract_id"] and row["changed_by_user_id"] == ADMIN_ID)
    check("журнал: ровно 3 status_change с автором, без дублей", len(events("status_change", set(ids))) == 3 and all(e["user_id"] == ADMIN_ID for e in events("status_change")))
    check("ответ содержит статус и контракт каждого", all(a["current_status"] == "in_production" and a["contract_id"] == before[a["id"]]["contract_id"] for a in js["applied"]))
    check("изделия вне пачки не тронуты", all(el(i) == others[i] for i in others))

    print("S3 возврат на «Запланирован»: последствия, подтверждение, снятие контракта и фактической даты")
    ids = contracted("delivered", 3)
    ids += pick("current_status = 'installed' AND contract_id IS NOT NULL", 1)
    before = {i: el(i) for i in ids}
    h0 = {i: hist(i) for i in ids}
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "planned", "preview"))
    cons = js.get("consequences", {})
    check("предпросмотр: контрактов снимется 4, есть разбивка по контрактам", st == 200 and cons.get("release_contracts") == 4
          and sum(x["count"] for x in cons.get("released_by_contract", [])) == 4 and all(x.get("name") for x in cons.get("released_by_contract", [])), f"{st} {cons}")
    check("предпросмотр: фактическая дата поставки очистится у всех, у кого она была",
          cons.get("actual_date_cleared") == sum(1 for i in ids if before[i]["actual_delivery_date"]), str(cons))
    check("предпросмотр не изменил базу", H.checksum() == snap)
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "planned", "apply", expect={"release_contracts": 0, "without_contract": 0}))
    check("запись с неверным подтверждением последствий — 409 и ничего не записано", st == 409 and js["detail"].get("kind") == "consequences_changed" and H.checksum() == snap, f"{st}")
    st, js = api("POST", "/element-ops/status-batch", {**sb(ids, "planned", "apply"), "expect": None})
    check("запись без подтверждения — 400", st == 400 and H.checksum() == snap, f"{st}")
    mark_events()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "planned", "apply", expect={"release_contracts": 4, "without_contract": 0}, comment="ошибка ввода"))
    check("запись с верным подтверждением — 200", st == 200 and len(js.get("applied", [])) == 4, f"{st} {js}")
    check("статус «Запланирован», контракт снят, фактическая дата очищена", all(el(i)["current_status"] == "planned" and el(i)["contract_id"] is None and el(i)["actual_delivery_date"] is None for i in ids))
    check("история +1 у каждого", all(hist(i) == h0[i] + 1 for i in ids))
    check("остальные поля не тронуты", all(stable(el(i)) == stable(before[i]) for i in ids))
    check("журнал: 4 status_change", len(events("status_change", set(ids))) == 4)

    print("S4 устаревшее состояние: другой пользователь успел изменить контракт/статус")
    ids = contracted("contracting", 3)
    it = items(ids)                                            # клиент увидел это состояние
    c = db()
    other = c.execute("SELECT id FROM contracts WHERE id != ? AND is_archived = 0 ORDER BY id LIMIT 1", (el(ids[1])["contract_id"],)).fetchone()["id"]
    c.execute("UPDATE elements SET contract_id = ? WHERE id = ?", (other, ids[1]))     # другой пользователь назначил ДРУГОЙ контракт
    c.commit(); c.close()
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/status-batch", {"mode": "apply", "object_id": 1, "status": "in_production", "items": it, "expect": {"release_contracts": 0, "without_contract": 0}})
    check("409 с перечнем, причина state_changed", st == 409 and any(x["reason"] == "state_changed" and x["element_id"] == ids[1] for x in js["detail"]["conflicts"]), f"{st} {js}")
    check("ничего не изменено, чужой контракт не перезаписан", H.checksum() == snap and el(ids[1])["contract_id"] == other)
    check("предпросмотр с устаревшим состоянием тоже отказывает", api("POST", "/element-ops/status-batch", {**{"mode": "preview", "object_id": 1, "status": "in_production", "items": it}})[0] == 409)
    check("журнал пуст", not all_events(), str([(e["action"], e["entity_id"]) for e in all_events()]))
    ids2 = contracted("contracting", 2)
    it = items(ids2)
    c = db(); c.execute("UPDATE elements SET current_status = 'shipped' WHERE id = ?", (ids2[0],)); c.commit(); c.close()   # изменил статус
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", {"mode": "apply", "object_id": 1, "status": "delivered", "items": it, "expect": {"release_contracts": 0, "without_contract": 0}})
    check("устаревший статус — 409, ничего не изменено", st == 409 and H.checksum() == snap, f"{st}")

    print("S5 недопустимая пачка")
    ids = contracted("contracting", 2)
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", sb([], "delivered"))
    check("пустая — 400", st == 400 and H.checksum() == snap, f"{st}")
    b = sb(ids, "delivered"); b["items"] = b["items"] + [b["items"][0]]
    check("дубли — 400", api("POST", "/element-ops/status-batch", b)[0] == 400)
    b = sb(ids, "delivered"); b["items"].append({"element_id": 99999999, "expected_status": "planned", "expected_contract_id": None})
    st, js = api("POST", "/element-ops/status-batch", b)
    check("несуществующее изделие — 404 без изменений", st == 404 and H.checksum() == snap, f"{st}")
    foreign = pick("current_status = 'planned'", 1, obj=2)[0]
    b = sb(ids, "delivered"); b["items"].append({"element_id": foreign, "expected_status": "planned", "expected_contract_id": None})
    st, js = api("POST", "/element-ops/status-batch", b)
    check("изделие другого объекта — 409 other_object, без изменений", st == 409 and any(x["reason"] == "other_object" for x in js["detail"]["conflicts"]) and H.checksum() == snap, f"{st}")
    same = sb(ids, "contracting")
    st, js = api("POST", "/element-ops/status-batch", same)
    check("тот же статус — 409 same_status, без изменений", st == 409 and all(x["reason"] == "same_status" for x in js["detail"]["conflicts"]) and H.checksum() == snap, f"{st}")
    for bad in ("2026-13-45T10:00", "вчера", "2026-09-01 25:00"):
        st, js = api("POST", "/element-ops/status-batch", sb(ids, "delivered", changed_at=bad))
        check(f"неверная дата «{bad}» — 400, без изменений", st == 400 and H.checksum() == snap, f"{st}")
    check("неизвестный статус — 422", api("POST", "/element-ops/status-batch", {**sb(ids, "delivered"), "status": "flying"})[0] == 422)
    check("комментарий длиннее 500 — 422", api("POST", "/element-ops/status-batch", sb(ids, "delivered", comment="я" * 501))[0] == 422)
    big = {"mode": "preview", "object_id": 1, "status": "delivered", "items": [{"element_id": i + 1, "expected_status": "planned"} for i in range(2001)]}
    check("больше 2000 изделий — 400", api("POST", "/element-ops/status-batch", big)[0] == 400)
    check("режим не из списка — 422", api("POST", "/element-ops/status-batch", {**sb(ids, "delivered"), "mode": "dry"})[0] == 422)

    print("S6 права")
    ids = contracted("contracting", 2)
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "in_production"), user=USER4)
    check("роль без права записи (view): 403, ничего не изменено", st == 403 and H.checksum() == snap, f"{st} {js}")
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "in_production", "preview"), user=USER4)
    check("предпросмотр без права: тоже 403", st == 403, f"{st}")
    c = db(); c.execute("DELETE FROM user_access WHERE user_id = ? AND object_id IS NULL", (USER2,)); c.commit(); c.close()   # user2 — только объект 1
    mixed = sb(ids, "in_production")
    mixed["items"].append({"element_id": foreign, "expected_status": "planned", "expected_contract_id": None})
    st, js = api("POST", "/element-ops/status-batch", mixed, user=USER2)
    check("пачка со смешанными объектами у пользователя с доступом только к объекту 1: 403 целиком", st == 403 and H.checksum() == snap, f"{st}")
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "in_production"), user=USER2)
    check("роль user на объекте 1: 200", st == 200 and all(el(i)["current_status"] == "in_production" for i in ids), f"{st} {js}")
    check("без входа — 401", http(PORT, "POST", "/element-ops/status-batch", sb(ids, "delivered"))[0] == 401)
    check("planned-date без входа — 401", http(PORT, "POST", "/element-ops/planned-date-batch", {"object_id": 1, "items": []})[0] == 401)
    check("contract без входа — 401", http(PORT, "POST", "/element-ops/contract", {"element_id": 1, "expected_status": "planned"})[0] == 401)

    print("S7 повтор и двойная отправка (идемпотентность)")
    ids = contracted("contracting", 3)
    body = sb(ids, "delivered")
    h0 = {i: hist(i) for i in ids}; mark_events()
    st1, js1 = api("POST", "/element-ops/status-batch", body)
    st2, js2 = api("POST", "/element-ops/status-batch", body)
    check("первый — 200 применено; повтор — 200 already_applied", st1 == 200 and not js1["already_applied"] and st2 == 200 and js2["already_applied"] and not js2["applied"], f"{st1} {st2}")
    check("история не задвоилась (+1 у каждого)", all(hist(i) == h0[i] + 1 for i in ids))
    check("журнал: 3 события, повтор их не добавил", len(events("status_change", set(ids))) == 3)
    ids = contracted("contracting", 3)
    it = items(ids)
    api("POST", "/element-ops/status-batch", {"mode": "apply", "object_id": 1, "status": "delivered", "items": it[:1], "expect": {"release_contracts": 0, "without_contract": 0}})
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", {"mode": "apply", "object_id": 1, "status": "delivered", "items": it, "expect": {"release_contracts": 0, "without_contract": 0}})
    check("частичный повтор (часть уже применена) — 409 partly_applied, ничего не изменено", st == 409 and any(x["reason"] == "partly_applied" for x in js["detail"]["conflicts"]) and H.checksum() == snap, f"{st}")

    print("S8 назначение контракта изделиям без контракта (страж остатка, откат всей пачки)")
    c = db()
    pos, planned_ids = H.find_position(c, 5)
    c.close()
    cid = pos["contract_id"]
    c = db(); H.make_room(c, pos, 2); c.close()                          # остаток по позиции 2
    ids = planned_ids[:3]; USED.update(ids)
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "contracting", "preview", assign_contract_id=cid))
    check("предпросмотр: страж сообщает о превышении остатка (проблемы в ответе, без записи)", st == 200 and js["problems"] and H.checksum() == snap, f"{st} {js.get('problems')}")
    d0 = activity.discarded_count()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "contracting", assign_contract_id=cid))
    check("запись: 409 (свободного количества нет), ВСЯ пачка откатилась", st == 409 and js["detail"].get("kind") == "contract_guard" and H.checksum() == snap, f"{st} {js}")
    check("журнал не подтверждает несостоявшееся, отброшенные события посчитаны", not events("status_change", set(ids)) and activity.discarded_count() - d0 == 2, str(activity.discarded_count() - d0))
    ids2 = ids[:2]
    h0 = {i: hist(i) for i in ids2}
    st, js = api("POST", "/element-ops/status-batch", sb(ids2, "contracting", assign_contract_id=cid))
    check("в пределах остатка: 200, назначено 2, «Контрактация»", st == 200 and js["consequences"]["assigned"] == 2 and all(el(i)["contract_id"] == cid and el(i)["current_status"] == "contracting" for i in ids2), f"{st} {js}")
    check("последствие «без контракта» = 0 (контракт назначен)", js["consequences"]["without_contract"] == 0)
    check("история +1", all(hist(i) == h0[i] + 1 for i in ids2))
    st, js = api("POST", "/element-ops/status-batch", sb([ids[2]], "contracting", "preview"))
    check("перевод запланированного без контракта: последствие without_contract = 1", st == 200 and js["consequences"]["without_contract"] == 1, f"{st} {js}")
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-batch", sb([ids[2]], "contracting", expect={"release_contracts": 0, "without_contract": 0}))
    check("запись без учёта последствия «без контракта» — 409", st == 409 and H.checksum() == snap, f"{st}")
    c = db()
    arch = c.execute("SELECT id FROM contracts WHERE is_archived = 1 LIMIT 1").fetchone()
    other_obj = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id WHERE a.object_id = 2 AND co.is_archived = 0 LIMIT 1").fetchone()
    c.close()
    if arch:
        check("архивный контракт — 409", api("POST", "/element-ops/status-batch", sb([ids[2]], "contracting", assign_contract_id=arch["id"]))[0] == 409)
    if other_obj:
        st, js = api("POST", "/element-ops/status-batch", sb([ids[2]], "contracting", assign_contract_id=other_obj["id"]))
        check("контракт другого объекта — 409 (страж), без изменений", st == 409 and H.checksum() == snap, f"{st} {js}")
    check("несуществующий контракт — 404", api("POST", "/element-ops/status-batch", sb([ids[2]], "contracting", assign_contract_id=99999999))[0] == 404)
    check("назначение контракта при «Запланирован» — 400", api("POST", "/element-ops/status-batch", sb(contracted("contracting", 1), "planned", assign_contract_id=cid, expect={"release_contracts": 1, "without_contract": 0}))[0] == 400)

    print("S9 конкуренция")
    ids = contracted("contracting", 4)
    body = sb(ids, "delivered")
    h0 = {i: hist(i) for i in ids}
    r = race([(api, "POST", "/element-ops/status-batch", body), (api, "POST", "/element-ops/status-batch", body)])
    codes = sorted(x[1][0] for x in r if x[0] == "ok")
    check("два одинаковых вызова одновременно: оба 200, ровно один записал", codes == [200, 200] and sorted(x[1][1]["already_applied"] for x in r) == [False, True], str(r))
    check("история +1 (без дублей)", all(hist(i) == h0[i] + 1 for i in ids))
    ids = contracted("contracting", 4)
    h0 = {i: hist(i) for i in ids}
    r = race([(api, "POST", "/element-ops/status-batch", sb(ids, "in_production")), (api, "POST", "/element-ops/status-batch", sb(ids, "shipped"))])
    codes = sorted(x[1][0] for x in r if x[0] == "ok")
    check("два разных вызова над одной пачкой: один 200, второй 409", codes == [200, 409], str(r))
    final = {el(i)["current_status"] for i in ids}
    check("итог единообразен (все изделия в одном статусе, история +1)", len(final) == 1 and all(hist(i) == h0[i] + 1 for i in ids), f"{final}")
    check("блокировка освобождена", H.other_writer_ok() and not H.released())
    # конкуренция за остаток контракта
    c = db()
    pos, planned_ids = H.find_position(c, 6, skip=1)
    H.make_room(c, pos, 3); c.close(); USED.update(planned_ids)
    cid = pos["contract_id"]
    a_ids, b_ids = planned_ids[:3], planned_ids[3:6]
    r = race([(api, "POST", "/element-ops/status-batch", sb(a_ids, "contracting", assign_contract_id=cid)),
              (api, "POST", "/element-ops/status-batch", sb(b_ids, "contracting", assign_contract_id=cid))])
    codes = sorted(x[1][0] for x in r if x[0] == "ok")
    c = db()
    linked = H.linked_n(c, cid, pos["element_type"], pos["mark"]); bought = H.bought(c, cid, pos["element_type"], pos["mark"])
    c.close()
    check("два пользователя на остаток 3: один 200, второй 409; занято не больше закупленного", codes == [200, 409] and linked <= bought, f"{codes} {linked}/{bought}")

    print("S10 плановая дата пачки")
    ids = pick("planned_delivery_date IS NULL", 3)
    b = {"object_id": 1, "planned_date": "2026-10-05", "items": [{"element_id": i, "expected_planned_date": None} for i in ids]}
    before = {i: el(i) for i in ids}; mark_events()
    st, js = api("POST", "/element-ops/planned-date-batch", b)
    check("200, дата проставлена, остальные поля не тронуты", st == 200 and all(el(i)["planned_delivery_date"] == "2026-10-05" and stable(el(i)) == stable(before[i]) or
                                                                              {k: v for k, v in stable(el(i)).items() if k != "planned_delivery_date"} == {k: v for k, v in stable(before[i]).items() if k != "planned_delivery_date"} for i in ids), f"{st} {js}")
    check("журнал: 3 planned_date", len(events("planned_date", set(ids))) == 3)
    st, js = api("POST", "/element-ops/planned-date-batch", b)
    check("повтор — 200 already_applied, журнал не задвоился", st == 200 and js["already_applied"] and len(events("planned_date", set(ids))) == 3, f"{st}")
    snap = H.checksum()
    for bad in ("2026-02-31", "05.10.2026", "завтра"):
        st, js = api("POST", "/element-ops/planned-date-batch", {**b, "planned_date": bad, "items": [{"element_id": i, "expected_planned_date": "2026-10-05"} for i in ids]})
        check(f"неверная дата «{bad}» — 400, без изменений", st == 400 and H.checksum() == snap, f"{st}")
    # устаревшая дата
    c = db(); c.execute("UPDATE elements SET planned_delivery_date = '2026-11-01' WHERE id = ?", (ids[1],)); c.commit(); c.close()
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-12-01", "items": [{"element_id": i, "expected_planned_date": "2026-10-05"} for i in ids]})
    check("другой пользователь изменил дату: 409, ничего не изменено, чужая дата цела", st == 409 and H.checksum() == snap and el(ids[1])["planned_delivery_date"] == "2026-11-01", f"{st}")
    check("журнал пуст", not events("planned_date"))
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": None, "items": [{"element_id": ids[0], "expected_planned_date": "2026-10-05"}]})
    check("снятие даты: 200, дата пуста", st == 200 and el(ids[0])["planned_delivery_date"] is None, f"{st}")
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-10-05", "items": [{"element_id": ids[0], "expected_planned_date": "2026-10-05"}]})
    check("та же дата (менять нечего) — 409 same_value", st == 409, f"{st}")
    snap = H.checksum()
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-12-01", "items": [{"element_id": ids[0], "expected_planned_date": None}]}, user=USER4)
    check("роль без planned_date:write — 403, без изменений", st == 403 and H.checksum() == snap, f"{st}")
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-12-01", "items": [{"element_id": ids[0], "expected_planned_date": None}, {"element_id": foreign, "expected_planned_date": None}]}, user=USER2)
    check("смешанные объекты у user2: 403 целиком", st == 403 and H.checksum() == snap, f"{st}")
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-12-01", "items": [{"element_id": ids[0], "expected_planned_date": None}, {"element_id": 99999999, "expected_planned_date": None}]})
    check("несуществующее изделие — 404 без изменений", st == 404 and H.checksum() == snap, f"{st}")
    st, js = api("POST", "/element-ops/planned-date-batch", {"object_id": 1, "planned_date": "2026-12-01", "items": [{"element_id": ids[0], "expected_planned_date": None}, {"element_id": foreign, "expected_planned_date": None}]})
    check("изделие другого объекта — 409 other_object", st == 409 and H.checksum() == snap, f"{st}")
    ids = pick("planned_delivery_date IS NULL", 4)
    b = {"object_id": 1, "planned_date": "2026-10-09", "items": [{"element_id": i, "expected_planned_date": None} for i in ids]}
    r = race([(api, "POST", "/element-ops/planned-date-batch", b), (api, "POST", "/element-ops/planned-date-batch", b)])
    check("двойная одновременная отправка: оба 200, один записал; журнал: 4 события", sorted(x[1][1]["already_applied"] for x in r if x[0] == "ok") == [False, True] and len(events("planned_date", set(ids))) == 4, str(r))

    print("S11 контракт одного изделия")
    ids = contracted("contracting", 2)
    e0 = el(ids[0])
    c = db()
    alt = c.execute("SELECT id FROM contracts WHERE id != ? AND is_archived = 0 LIMIT 1", (e0["contract_id"],)).fetchone()["id"]
    c.close()
    cb = lambda i, cid_: {"element_id": i, "expected_status": el(i)["current_status"], "expected_contract_id": el(i)["contract_id"], "contract_id": cid_}
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/contract", cb(ids[0], None))
    check("снятие контракта: 200, статус не тронут", st == 200 and el(ids[0])["contract_id"] is None and el(ids[0])["current_status"] == e0["current_status"], f"{st} {js}")
    check("журнал: element_contract_set ×1", len(events("element_contract_set", {ids[0]})) == 1)
    b = {"element_id": ids[0], "expected_status": e0["current_status"], "expected_contract_id": e0["contract_id"], "contract_id": None}
    st, js = api("POST", "/element-ops/contract", b)
    check("повтор того же запроса — 200 already_applied", st == 200 and js["already_applied"] and len(events("element_contract_set", {ids[0]})) == 1, f"{st} {js}")
    st, js = api("POST", "/element-ops/contract", {"element_id": ids[0], "expected_status": e0["current_status"], "expected_contract_id": e0["contract_id"], "contract_id": alt})
    check("устаревшее состояние (контракт сняли) — 409, ничего не изменено", st == 409 and el(ids[0])["contract_id"] is None, f"{st}")
    st, js = api("POST", "/element-ops/contract", cb(ids[0], e0["contract_id"]))
    check("назначение вернувшегося контракта: 200 (страж пропускает: место свободно)", st == 200 and el(ids[0])["contract_id"] == e0["contract_id"], f"{st} {js}")
    st, js = api("POST", "/element-ops/contract", cb(ids[0], e0["contract_id"]))
    check("тот же контракт — 400", st == 400, f"{st}")
    snap = H.checksum()
    st, js = api("POST", "/element-ops/contract", cb(ids[1], alt))
    check("контракт без позиции под марку — 409 (страж), ничего не изменено", st == 409 and H.checksum() == snap, f"{st} {js}")
    pl = pick("current_status = 'planned'", 1)[0]
    st, js = api("POST", "/element-ops/contract", {"element_id": pl, "expected_status": "planned", "expected_contract_id": None, "contract_id": alt})
    check("«Запланирован» — 409", st == 409 and H.checksum() == snap, f"{st}")
    check("несуществующее изделие — 404", api("POST", "/element-ops/contract", {"element_id": 99999999, "expected_status": "planned", "contract_id": None})[0] == 404)
    check("нет права (view) — 403", api("POST", "/element-ops/contract", cb(ids[0], None), user=USER4)[0] == 403 and H.checksum() == snap)
    if arch:
        check("архивный — 409", api("POST", "/element-ops/contract", cb(ids[0], None) | {"contract_id": arch["id"]})[0] in (409,))

    print("S12 освобождение блокировки и отсутствие побочных изменений")
    check("ни одного соединения с открытой транзакцией; другой писатель может начать сразу", H.other_writer_ok() and not H.released(), str(H.released()))
    snap = H.checksum()
    ids = contracted("contracting", 1)
    api("POST", "/element-ops/status-batch", sb(ids, "delivered", "preview"))
    api("POST", "/element-ops/status-batch", sb(ids, "delivered", "preview"), user=USER4)
    check("после серии предпросмотров/отказов база не менялась и блокировка свободна", H.checksum() == snap and H.other_writer_ok() and not H.released())
    # занятая БД: второй писатель держит блокировку — 503 без изменений
    appdb.BUSY_TIMEOUT_MS = 300
    hold = __import__("sqlite3").connect(H.WORK, timeout=1, isolation_level=None)
    hold.execute("BEGIN IMMEDIATE")
    t0 = time.time()
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "delivered"))
    hold.execute("ROLLBACK"); hold.close()
    check("база занята другим писателем: 503 и ничего не изменено", st == 503 and H.checksum() == snap, f"{st} {js} {time.time() - t0:.1f}с")
    st, js = api("POST", "/element-ops/status-batch", sb(ids, "delivered"))
    check("после освобождения — 200", st == 200, f"{st}")

    print("S13 совместимость прежних операций V1 (ничего не сломано)")
    ids = contracted("contracting", 2)
    st, js = api("PATCH", f"/elements/{ids[0]}/comment", {"comment": "проверка"})
    check("комментарий (V1) — 200", st == 200 and el(ids[0])["comment"] == "проверка", f"{st}")
    st, js = api("PATCH", f"/elements/{ids[0]}/status", {"status": "in_production"})
    check("смена статуса одного (V1) — 200, контракт цел", st == 200 and el(ids[0])["contract_id"] is not None, f"{st}")
    st, js = api("PATCH", "/elements/bulk-status", {"status": "in_production", "items": [{"element_id": ids[1], "contract_id": el(ids[1])["contract_id"]}]})
    check("bulk-status (V1) — 200", st == 200, f"{st}")
    st, js = api("PATCH", f"/elements/{ids[0]}/planned-delivery-date", {"planned_delivery_date": "2026-10-20"})
    check("плановая дата одного (V1) — 200", st == 200 and el(ids[0])["planned_delivery_date"] == "2026-10-20", f"{st}")
    st, js = api("GET", f"/elements/{ids[0]}")
    check("GET элемента (V1) — 200 и история", st == 200 and js.get("history"), f"{st}")


try:
    main_run()
finally:
    try:
        SERVER.should_exit = True
    except Exception:  # noqa: BLE001
        pass

print()
if FAILS:
    print(f"НАРУШЕНИЙ: {len(FAILS)}")
    for f in FAILS:
        print("  -", f)
    sys.exit(1)
print("нарушений нет")
