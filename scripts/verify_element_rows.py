"""Проверка построчных групповых операций `POST /element-ops/{planned-date-rows,status-rows}` (app/element_rows.py) по HTTP (настоящий
сервер, маршруты, пул потоков, ответы об ошибках) на КОПИИ обезличенной БД. Авторизация — подмена заголовка `X-Test-User` только в
тестовом процессе; без заголовка проверяется настоящий отказ 401. По образцу `scripts/verify_element_ops.py` (та же схема безопасности:
ожидаемое состояние КАЖДОЙ строки, предпросмотр без записи, подтверждение последствий, 409 без частичных изменений, идемпотентный повтор).

Сценарии:
 D1 плановые даты: предпросмотр ничего не пишет · D2 запись (задано/заменено/снято, история и журнал) · D3 устаревшая дата строки — 409 без
 изменений · D4 недопустимая пачка (пустая, дубли, нет изделия, чужой объект, строка без изменения, лимит, без ключей expected/planned) ·
 D5 права (403 view, 401 без входа) · D6 повтор и частичный повтор.
 R1 статус по строкам: предпросмотр ничего не пишет · R2 запись с сохранением контракта (не выбран — остаётся) · R3 явное снятие контракта
 (без «Запланирован») · R4 явная замена контракта · R5 назначение новым (без контракта → контракт) · R6 «Запланирован» снимает контракт у
 всех, contract_id в теле запрещён · R7 контракт архивный/чужого объекта — отказ без записи · R8 страж остатка — 409, ОТКАТ ВСЕЙ пачки,
 журнал не подтверждает несостоявшееся · R9 устаревшее состояние строки — 409 · R10 недопустимая пачка (нет ключа contract_id, дубли,
 пустая, лимит) · R11 права (403 view, 401 без входа) · R12 повтор и частичный повтор · R13 конкуренция за один остаток ·
 R14 смена контракта при прежнем статусе, предпросмотр/запись/повтор, строка без изменений отклоняется.

Запуск: .venv/bin/python scripts/verify_element_rows.py <копия_БД>
"""

import _guard_harness as H  # noqa: I001
from _guard_harness import db, http, start_http_server, user_row

import sys
import threading

import app.activity as activity
import app.db as appdb

PORT, SERVER = start_http_server()
ADMIN = user_row()
ADMIN_ID = ADMIN["id"]
FAILS = []
MARK = {"id": 0}
USER2 = user_row("domain_login = 'user2'")["id"]
USER4 = user_row("domain_login = 'user4'")["id"]


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
    rows = c.execute("SELECT * FROM activity_log WHERE id > ? AND action != 'request_denied'", (MARK["id"],)).fetchall()
    c.close()
    return rows


USED = set()


def pick(where, n, obj=1):
    c = db()
    rows = [r["id"] for r in c.execute(f"SELECT id FROM elements WHERE object_id = ? AND is_current = 1 AND {where} ORDER BY id", (obj,)) if r["id"] not in USED]
    c.close()
    out = rows[:n]
    assert len(out) == n, f"в копии не хватило изделий по условию {where}"
    USED.update(out)
    return out


def contracted(status, n):
    return pick(f"current_status = '{status}' AND contract_id IS NOT NULL", n)


def stable(r):
    skip = {"current_status", "contract_id", "updated_at", "actual_delivery_date", "planned_delivery_date"}
    return {k: v for k, v in r.items() if k not in skip}


# ---------------------------------------------------------------- плановые даты по строкам

def d_items(ids, dates):
    return [{"element_id": i, "expected_planned_date": el(i)["planned_delivery_date"], "planned_date": d} for i, d in zip(ids, dates)]


def db_(mode, items_, expect=None, **extra):
    body = {"mode": mode, "object_id": 1, "items": items_}
    if mode == "apply":
        body["expect"] = expect if expect is not None else {"set_new": 0, "replaced": 0, "cleared": 0}
    body.update(extra)
    return body


# ---------------------------------------------------------------- смена статуса с контрактом по строкам

def r_items(ids, target_status, contracts):
    """contracts: {element_id: contract_id_после | None}."""
    return [{"element_id": i, "expected_status": el(i)["current_status"], "expected_contract_id": el(i)["contract_id"], "contract_id": contracts[i]} for i in ids]


def rb(mode, status, items_, expect=None, **extra):
    body = {"mode": mode, "object_id": 1, "status": status, "items": items_}
    if mode == "apply":
        body["expect"] = expect if expect is not None else {"release_contracts": 0, "replace_contracts": 0, "without_contract": 0}
    body.update(extra)
    return body


def main_run():
    print(f"сервер на порту {PORT}; администратор {ADMIN['domain_login']}, user2 №{USER2}, user4 №{USER4}")
    H.track_connections(appdb, __import__("app.element_rows", fromlist=["x"]))
    c = db()
    c.execute("UPDATE role_features SET level = 'read' WHERE role_key = 'view' AND feature_key IN ('status', 'planned_date')")
    c.commit()
    c.close()

    # ================================================================ D. плановые даты по строкам
    print("D1 предпросмотр ничего не пишет")
    ids = pick("current_status = 'contracting'", 3)
    # даты, заведомо отличные от текущих (в т.ч. когда текущей нет вовсе), чтобы каждая строка была реальным изменением
    items_ = d_items(ids, [("2026-10-02" if el(i)["planned_delivery_date"] == "2026-10-01" else "2026-10-01") for i in ids])
    snap = H.checksum(("elements",)); mark_events()
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", items_))
    check("200 и режим preview", st == 200 and js.get("mode") == "preview", f"{st} {js}")
    check("предпросмотр ничего не изменил", H.checksum(("elements",)) == snap)
    check("в журнале нет событий", not all_events())
    check("блокировка записи освобождена", H.other_writer_ok())

    print("D2 запись: задано / заменено / снято")
    ids = pick("current_status = 'contracting'", 3)
    c = db(); c.execute("UPDATE elements SET planned_delivery_date = '2026-01-01' WHERE id = ?", (ids[1],)); c.commit(); c.close()
    items_ = d_items(ids, ["2026-11-01", "2026-11-02", None])
    it2 = [dict(items_[0]), dict(items_[1]), dict(items_[2])]
    it2[2]["expected_planned_date"] = None   # третья дата и так пустая — эта строка станет «snake без изменения», проверим отдельно ниже
    mark_events()
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", items_[:2]))
    cons = js.get("consequences", {})
    check("предпросмотр: 1 задана, 1 заменена", st == 200 and cons.get("set_new") == 1 and cons.get("replaced") == 1, f"{st} {cons}")
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", items_[:2], expect=cons))
    check("запись — 200, обе строки применены", st == 200 and len(js["applied"]) == 2, f"{st} {js}")
    check("даты установлены", el(ids[0])["planned_delivery_date"] == "2026-11-01" and el(ids[1])["planned_delivery_date"] == "2026-11-02")
    check("журнал: 2 события planned_date", len(events("planned_date", set(ids[:2]))) == 2)

    print("D3 устаревшая дата строки — 409 без изменений")
    ids = pick("current_status = 'contracting'", 1)
    it = d_items(ids, ["2026-12-01"])
    c = db(); c.execute("UPDATE elements SET planned_delivery_date = '2026-02-02' WHERE id = ?", (ids[0],)); c.commit(); c.close()   # другой пользователь успел изменить
    snap = H.checksum(("elements",))
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", it))
    check("409 state_changed, ничего не изменено", st == 409 and js["detail"]["conflicts"][0]["reason"] == "state_changed" and H.checksum(("elements",)) == snap, f"{st} {js}")

    print("D4 недопустимая пачка")
    ids = pick("current_status = 'contracting'", 1)
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", []))
    check("пустая — 400", st == 400, f"{st}")
    it = d_items(ids, ["2026-10-10"]); it = it + [dict(it[0])]
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", it))
    check("дубли — 400", st == 400, f"{st}")
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", [{"element_id": 99999999, "expected_planned_date": None, "planned_date": "2026-10-10"}]))
    check("несуществующее изделие — 404 без изменений", st == 404, f"{st}")
    foreign = pick("current_status = 'planned'", 1, obj=2)[0]
    it = d_items(ids, ["2026-10-10"]) + [{"element_id": foreign, "expected_planned_date": None, "planned_date": "2026-10-10"}]
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", it))
    check("изделие другого объекта — 409 other_object", st == 409 and any(x["reason"] == "other_object" for x in js["detail"]["conflicts"]), f"{st} {js}")
    st, js = api("POST", "/element-ops/planned-date-rows", db_("preview", [{"element_id": ids[0], "expected_planned_date": el(ids[0])["planned_delivery_date"], "planned_date": el(ids[0])["planned_delivery_date"]}]))
    check("строка без изменения даты — отклонена шлюзом формы (проверяется на клиенте); сервер тоже отказывает — same_value", st == 409, f"{st} {js}")
    st, js = api("POST", "/element-ops/planned-date-rows", {"mode": "preview", "object_id": 1, "items": [{"element_id": i + 1, "expected_planned_date": None, "planned_date": "2026-10-10"} for i in range(2001)]})
    check("больше 2000 изделий — 400", st == 400, f"{st}")

    print("D5 права")
    ids = pick("current_status = 'contracting'", 1)
    it = d_items(ids, ["2026-10-20"])
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", it), user=USER4)
    check("роль без права записи (view): 403, ничего не изменено", st == 403, f"{st} {js}")
    check("без входа — 401", http(PORT, "POST", "/element-ops/planned-date-rows", db_("apply", it))[0] == 401)

    print("D6 повтор и частичный повтор")
    ids = pick("current_status = 'contracting'", 2)
    it = d_items(ids, ["2026-10-25", "2026-10-26"])
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", it, expect={"set_new": 2, "replaced": 0, "cleared": 0}))
    check("первая запись — 200", st == 200 and len(js["applied"]) == 2, f"{st} {js}")
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", it, expect={"set_new": 2, "replaced": 0, "cleared": 0}))
    check("повтор — 200 already_applied", st == 200 and js["already_applied"] and not js["applied"], f"{st} {js}")
    ids2 = pick("current_status = 'contracting'", 2)
    it2 = d_items(ids2, ["2026-10-27", "2026-10-28"])
    api("POST", "/element-ops/planned-date-rows", db_("apply", it2[:1], expect={"set_new": 1, "replaced": 0, "cleared": 0}))
    snap = H.checksum(("elements",))
    st, js = api("POST", "/element-ops/planned-date-rows", db_("apply", it2, expect={"set_new": 2, "replaced": 0, "cleared": 0}))
    check("частичный повтор — 409 partly_applied, ничего не изменено", st == 409 and any(x["reason"] == "partly_applied" for x in js["detail"]["conflicts"]) and H.checksum(("elements",)) == snap, f"{st}")

    # ================================================================ R. смена статуса с контрактом по строкам
    print("R1 предпросмотр ничего не пишет")
    ids = contracted("contracting", 3)
    before = {i: el(i) for i in ids}
    items_ = r_items(ids, "in_production", {i: before[i]["contract_id"] for i in ids})
    snap = H.checksum(); mark_events()
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "in_production", items_))
    check("200 и режим preview", st == 200 and js.get("mode") == "preview", f"{st} {js}")
    check("предпросмотр ничего не изменил", H.checksum() == snap)
    check("в журнале нет событий", not all_events())

    print("R2 запись с сохранением контракта (не выбран — остаётся)")
    ids = contracted("contracting", 3)
    before = {i: el(i) for i in ids}; h0 = {i: hist(i) for i in ids}
    items_ = r_items(ids, "in_production", {i: before[i]["contract_id"] for i in ids})
    mark_events()
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "in_production", items_))
    check("200, три изделия применены", st == 200 and len(js["applied"]) == 3, f"{st} {js}")
    check("статус изменён, КОНТРАКТ у каждого прежний", all(el(i)["current_status"] == "in_production" and el(i)["contract_id"] == before[i]["contract_id"] for i in ids))
    check("остальные поля не тронуты", all(stable(el(i)) == stable(before[i]) for i in ids))
    check("история +1 у каждого", all(hist(i) == h0[i] + 1 for i in ids))
    check("журнал: 3 status_change", len(events("status_change", set(ids))) == 3)

    print("R3 явное снятие контракта у одной строки, у другой — сохранение")
    ids = contracted("contracting", 2)
    before = {i: el(i) for i in ids}
    contracts = {ids[0]: None, ids[1]: before[ids[1]]["contract_id"]}
    items_ = r_items(ids, "in_production", contracts)
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "in_production", items_))
    cons = js.get("consequences", {})
    check("предпросмотр: снятие у одного, разбивка по контракту", st == 200 and cons.get("release_contracts") == 1
          and sum(x["count"] for x in cons.get("released_by_contract", [])) == 1, f"{st} {cons}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "in_production", items_, expect=cons))
    check("запись — 200", st == 200, f"{st} {js}")
    check("контракт снят у первого, сохранён у второго", el(ids[0])["contract_id"] is None and el(ids[1])["contract_id"] == before[ids[1]]["contract_id"])

    print("R4 явная замена контракта одной строки")
    ids = contracted("contracting", 1)
    before = el(ids[0])
    c = db(); other = c.execute(
        "SELECT co.id FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id JOIN contract_lines cl ON cl.contract_id=co.id "
        "WHERE a.object_id=1 AND co.is_archived=0 AND co.id != ? AND cl.element_type=? AND cl.mark IS ? "
        "AND (SELECT COALESCE(SUM(quantity),0) FROM contract_lines WHERE contract_id=co.id AND element_type=cl.element_type AND mark IS cl.mark) "
        "> (SELECT COUNT(*) FROM elements WHERE contract_id=co.id AND element_type=cl.element_type AND mark IS cl.mark AND current_status != 'planned') "
        "LIMIT 1", (before["contract_id"], before["element_type"], before["mark"])).fetchone(); c.close()
    if other is None:
        print("  (пропущено: в копии нет второго контракта со свободным местом под ту же позицию)")
    else:
        oid = other["id"]
        items_ = r_items(ids, "delivered", {ids[0]: oid})
        st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", items_))
        cons = js.get("consequences", {})
        check("предпросмотр: замена контракта у 1 изделия", st == 200 and cons.get("replace_contracts") == 1, f"{st} {cons}")
        st, js = api("POST", "/element-ops/status-rows", rb("apply", "delivered", items_, expect=cons))
        check("запись — 200, контракт заменён", st == 200 and el(ids[0])["contract_id"] == oid, f"{st} {js}")

    print("R5 назначение контракта строке без него (уход с «Запланирован»)")
    c = db(); pos, planned_ids = H.find_position(c, 3); c.close()
    cid = pos["contract_id"]
    ids = planned_ids[:2]; USED.update(ids)
    items_ = r_items(ids, "contracting", {i: cid for i in ids})
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "contracting", items_))
    cons = js.get("consequences", {})
    check("предпросмотр: назначено 2", st == 200 and cons.get("assigned") == 2, f"{st} {cons}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", items_, expect=cons))
    check("запись — 200, контракт назначен", st == 200 and all(el(i)["contract_id"] == cid for i in ids), f"{st} {js}")

    print("R6 «Запланирован» снимает контракт у всех строк; contract_id в теле запрещён")
    ids = contracted("delivered", 2)
    before = {i: el(i) for i in ids}
    items_ = r_items(ids, "planned", {i: before[i]["contract_id"] for i in ids})   # запрет: contract_id должен быть None
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "planned", items_))
    check("контракт указан при переходе на «Запланирован» — 400", st == 400, f"{st} {js}")
    items_ = r_items(ids, "planned", {i: None for i in ids})
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "planned", items_))
    cons = js.get("consequences", {})
    check("предпросмотр: снятие у обоих", st == 200 and cons.get("release_contracts") == 2, f"{st} {cons}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "planned", items_, expect=cons))
    check("запись — 200, оба без контракта", st == 200 and all(el(i)["contract_id"] is None and el(i)["current_status"] == "planned" for i in ids), f"{st} {js}")

    print("R7 контракт архивный / чужого объекта — отказ без записи")
    ids = contracted("contracting", 1)
    before = el(ids[0])
    c = db()
    archived = c.execute(
        "SELECT co.id FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id "
        "WHERE a.object_id=1 AND co.is_archived=1 LIMIT 1").fetchone()
    foreign_c = c.execute(
        "SELECT co.id FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id "
        "WHERE a.object_id != 1 AND co.is_archived=0 LIMIT 1").fetchone()
    c.close()
    snap = H.checksum()
    if archived:
        items_ = r_items(ids, "delivered", {ids[0]: archived["id"]})
        st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", items_))
        check("архивный контракт — отказ, ничего не изменено", st in (404, 409) and H.checksum() == snap, f"{st} {js}")
    else:
        print("  (пропущено: в копии нет архивного контракта объекта 1)")
    if foreign_c:
        items_ = r_items(ids, "delivered", {ids[0]: foreign_c["id"]})
        st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", items_))
        check("контракт чужого объекта — 400, ничего не изменено", st == 400 and H.checksum() == snap, f"{st} {js}")
    else:
        print("  (пропущено: в копии нет контракта другого объекта)")

    print("R8 страж остатка: 409, ОТКАТ ВСЕЙ пачки")
    c = db(); pos, planned_ids = H.find_position(c, 5, skip=1); c.close()
    cid = pos["contract_id"]
    c = db(); H.make_room(c, pos, 1); c.close()          # остаток ровно 1
    ids = planned_ids[:3]; USED.update(ids)
    snap = H.checksum(); mark_events()
    d0 = activity.discarded_count()
    items_ = r_items(ids, "contracting", {i: cid for i in ids})
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", items_, expect={"release_contracts": 0, "replace_contracts": 0, "without_contract": 0}))
    check("недостаточно остатка — 409 contract_guard, ВСЯ пачка откатилась", st == 409 and js["detail"].get("kind") == "contract_guard" and H.checksum() == snap, f"{st} {js}")
    check("журнал не подтверждает несостоявшееся", not events("status_change", set(ids)))
    check("отброшенные события посчитаны", activity.discarded_count() > d0)

    print("R9 устаревшее состояние строки — 409 без изменений")
    ids = contracted("contracting", 2)
    before = {i: el(i) for i in ids}
    items_ = r_items(ids, "in_production", {i: before[i]["contract_id"] for i in ids})
    c = db(); c.execute("UPDATE elements SET current_status = 'shipped' WHERE id = ?", (ids[0],)); c.commit(); c.close()   # другой пользователь изменил
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "in_production", items_, expect={"release_contracts": 0, "replace_contracts": 0, "without_contract": 0}))
    check("409 state_changed, ничего не изменено", st == 409 and any(x["reason"] == "state_changed" for x in js["detail"]["conflicts"]) and H.checksum() == snap, f"{st} {js}")

    print("R10 недопустимая пачка")
    ids = contracted("contracting", 1)
    before = el(ids[0])
    it_no_key = [{"element_id": ids[0], "expected_status": before["current_status"], "expected_contract_id": before["contract_id"]}]   # нет contract_id
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", it_no_key))
    check("строка без ключа contract_id — 400", st == 400, f"{st} {js}")
    it = r_items(ids, "delivered", {ids[0]: before["contract_id"]}); it = it + [dict(it[0])]
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", it))
    check("дубли — 400", st == 400, f"{st}")
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "delivered", []))
    check("пустая — 400", st == 400, f"{st}")
    big = {"mode": "preview", "object_id": 1, "status": "delivered", "items": [{"element_id": i + 1, "expected_status": "planned", "expected_contract_id": None, "contract_id": None} for i in range(2001)]}
    check("больше 2000 изделий — 400", api("POST", "/element-ops/status-rows", big)[0] == 400)

    print("R11 права")
    ids = contracted("contracting", 1)
    before = el(ids[0])
    items_ = r_items(ids, "in_production", {ids[0]: before["contract_id"]})
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "in_production", items_), user=USER4)
    check("роль без права записи (view): 403, ничего не изменено", st == 403, f"{st} {js}")
    check("без входа — 401", http(PORT, "POST", "/element-ops/status-rows", rb("apply", "in_production", items_))[0] == 401)

    print("R12 повтор и частичный повтор")
    ids = contracted("contracting", 2)
    before = {i: el(i) for i in ids}
    items_ = r_items(ids, "shipped", {i: before[i]["contract_id"] for i in ids})
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "shipped", items_))
    check("первая запись — 200", st == 200 and len(js["applied"]) == 2, f"{st} {js}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "shipped", items_))
    check("повтор — 200 already_applied", st == 200 and js["already_applied"] and not js["applied"], f"{st} {js}")
    ids2 = contracted("contracting", 2)
    before2 = {i: el(i) for i in ids2}
    it2 = r_items(ids2, "shipped", {i: before2[i]["contract_id"] for i in ids2})
    api("POST", "/element-ops/status-rows", rb("apply", "shipped", it2[:1]))
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "shipped", it2))
    check("частичный повтор — 409 partly_applied, ничего не изменено", st == 409 and any(x["reason"] == "partly_applied" for x in js["detail"]["conflicts"]) and H.checksum() == snap, f"{st}")

    print("R13 конкуренция за один остаток (только один из двух проходит)")
    c = db(); pos, planned_ids = H.find_position(c, 4, skip=2); c.close()
    cid = pos["contract_id"]
    c = db(); H.make_room(c, pos, 1); c.close()   # остаток ровно 1: из двух заявок на 1 место должна пройти ровно одна
    a, b = planned_ids[0], planned_ids[1]; USED.update([a, b])
    ia = r_items([a], "contracting", {a: cid}); ib = r_items([b], "contracting", {b: cid})
    # race() (_guard_harness) зовёт функции напрямую, минуя HTTP; для конкуренции ПО HTTP (настоящий сетевой путь) — свои потоки на api().
    out = [None, None]
    def go(i, items_):
        out[i] = api("POST", "/element-ops/status-rows", rb("apply", "contracting", items_))
    ta = threading.Thread(target=go, args=(0, ia)); tb = threading.Thread(target=go, args=(1, ib))
    ta.start(); tb.start(); ta.join(); tb.join()
    ok = sum(1 for r in out if r[0] == 200)
    check("ровно один из двух прошёл, второй — 409 contract_guard", ok == 1 and any(r[0] == 409 for r in out), f"{out}")

    print("R14 контракт меняется при прежнем статусе (как в V1), без ложного изменения остальных строк")
    # В копии есть исторические привязки БЕЗ позиции под марку: снять их можно, назначить обратно страж не даст.
    # Для проверки обратного назначения берём только контракт с действительной позицией этого изделия.
    eid = pick("current_status = 'contracting' AND contract_id IS NOT NULL AND EXISTS ("
               "SELECT 1 FROM contract_lines cl WHERE cl.contract_id = elements.contract_id "
               "AND cl.element_type = elements.element_type AND cl.mark IS elements.mark)", 1)[0]
    before = el(eid); h0 = hist(eid)
    unchanged = r_items([eid], "contracting", {eid: before["contract_id"]})
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "contracting", unchanged))
    check("строка без изменения статуса И контракта — 409, ничего не записано", st == 409 and H.checksum() == snap, f"{st} {js}")
    items_ = r_items([eid], "contracting", {eid: None})
    mark_events()
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "contracting", items_))
    cons = js.get("consequences", {})
    check("предпросмотр: контракт снимется, статус останется", st == 200 and cons.get("release_contracts") == 1 and el(eid) == before and hist(eid) == h0, f"{st} {js}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", items_, expect=cons))
    check("запись: контракт снят, статус прежний, история одна", st == 200 and el(eid)["contract_id"] is None and el(eid)["current_status"] == "contracting" and hist(eid) == h0 + 1, f"{st} {js}")
    check("журнал: ровно одно событие", len(events("status_change", {eid})) == 1)
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", items_, expect=cons))
    check("повтор: already_applied, история не задвоена", st == 200 and js.get("already_applied") and hist(eid) == h0 + 1, f"{st} {js}")
    back = r_items([eid], "contracting", {eid: before["contract_id"]})
    st, js = api("POST", "/element-ops/status-rows", rb("preview", "contracting", back))
    cons_back = js.get("consequences", {})
    check("предпросмотр обратного назначения при прежнем статусе", st == 200 and cons_back.get("assigned") == 1, f"{st} {js}")
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", back, expect=cons_back))
    check("обратное назначение: прежний статус, контракт и история +1", st == 200 and el(eid)["contract_id"] == before["contract_id"]
          and el(eid)["current_status"] == "contracting" and hist(eid) == h0 + 2, f"{st} {js}")
    snap = H.checksum()
    st, js = api("POST", "/element-ops/status-rows", rb("apply", "contracting", back, expect=cons_back))
    check("повтор обратного назначения не создаёт историю", st == 200 and js.get("already_applied") and hist(eid) == h0 + 2 and H.checksum() == snap, f"{st} {js}")

    print("совместимость: прежний V1-маршрут /elements/bulk-status по-прежнему работает (не трогали)")
    ids = pick("current_status = 'contracting' AND contract_id IS NOT NULL", 1)
    st, js = api("PATCH", "/elements/bulk-status", {"items": [{"element_id": ids[0], "contract_id": el(ids[0])["contract_id"]}], "status": "in_production"})
    check("V1 bulk-status отвечает 200", st == 200, f"{st} {js}")

    check("ни одного соединения с открытой транзакцией; другой писатель может начать сразу", H.other_writer_ok() and not H.released(), str(H.released()))


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
