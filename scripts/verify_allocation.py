"""Проверка атомарного распределения `POST /contracts/{id}/allocations` по HTTP (настоящий сервер, маршруты, пул потоков, ответы об ошибках)
на КОПИИ обезличенной БД. Авторизация — подмена заголовком `X-Test-User` только в тестовом процессе; без заголовка проверяется настоящий отказ 401.

Сценарии: A1 пачка «Запланирован» · A2 смешанная пачка (статусы сохраняются) · A3 превышение остатка + откат + журнал · A4 изделие получило контракт после
открытия формы · A5 статус изменился · A6 недопустимая пачка (дубли, чужая позиция/объект/контракт, архивный, пустая, нет изделия) · A7 права и 401 · A8 повторная
отправка и двойной клик · A9 два пользователя на последнее место · A10 таймаут блокировки и ошибка валидации · A11 совместимость прежних операций V1.

Запуск: .venv/bin/python scripts/verify_allocation.py <копия_БД>
"""

import _guard_harness as H  # noqa: I001
from _guard_harness import db, http, race, start_http_server, user_row

import sqlite3
import sys
import threading

import app.activity as activity
import app.db as appdb

PORT, SERVER = start_http_server()
ADMIN = user_row()
ADMIN_ID = ADMIN["id"]
FAILS = []
SKIP = {"n": 0}
MARK = {"id": 0}


def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def api(method, path, body=None, user=ADMIN_ID):
    return http(PORT, method, path, body, user)


def post(cid, b):
    return api("POST", f"/contracts/{cid}/allocations", b)


def position(n_free=6, remaining=3):
    """Свежая позиция (тип, марка) контракта объекта 1 с достаточным числом запланированных изделий без контракта; остаток = remaining."""
    c = db()
    pos, ids = H.find_position(c, n_free, skip=SKIP["n"])
    SKIP["n"] += 1
    H.make_room(c, pos, remaining)
    c.close()
    return pos, ids


def body(pos, ids, statuses=None, obj=1):
    st = statuses or {}
    return {"object_id": obj, "element_type": pos["element_type"], "mark": pos["mark"],
            "items": [{"element_id": i, "expected_status": st.get(i, "planned")} for i in ids]}


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


def prep_status(ids, status):
    c = db()
    H.set_status(c, ids, status)
    c.close()


def stable_cols(r):
    skip = {"current_status", "contract_id", "updated_at", "actual_delivery_date"}
    return {k: v for k, v in r.items() if k not in skip}


def main_run():
    print(f"сервер на порту {PORT}; пользователь {ADMIN['domain_login']}")

    print("A1 пачка «Запланирован»")
    pos, ids = position(); cid = pos["contract_id"]; use = ids[:3]
    before = {i: el(i) for i in use}; h0 = {i: hist(i) for i in use}; others = {i: el(i) for i in ids[3:5]}
    mark_events()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, use))
    check("200 и три изделия в ответе", st == 200 and len(js.get("applied", [])) == 3 and not js.get("already_applied"), f"{st} {js if st != 200 else ''}")
    check("ответ: статус «Контрактация» и контракт у каждого", all(a["current_status"] == "contracting" and a["contract_id"] == cid for a in js.get("applied", [])))
    check("в базе: статус и контракт назначены, остальные поля не тронуты", all(el(i)["current_status"] == "contracting" and el(i)["contract_id"] == cid and stable_cols(el(i)) == stable_cols(before[i]) for i in use))
    check("история: ровно одна новая запись у каждого", all(hist(i) == h0[i] + 1 for i in use))
    check("остаток после операции в ответе: 0", js.get("position", {}).get("remaining") == 0, str(js.get("position")))
    check("другие изделия не изменены", all(el(i) == others[i] for i in others))
    check("журнал: 3 status_change + 1 contract_allocate, без дублей", len(events("status_change", set(use))) == 3 and len(events("contract_allocate", {cid})) == 1)

    print("A2 смешанная пачка (статусы сохраняются)")
    pos, ids = position(6, 5); cid = pos["contract_id"]
    planned, shipped = ids[:2], ids[2:4]
    prep_status(shipped, "shipped")
    prep_status([ids[4]], "delivered")   # изделие, не входящее в пачку
    b = {i: el(i) for i in planned + shipped}; h0 = {i: hist(i) for i in planned + shipped}
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, planned + shipped, {i: "shipped" for i in shipped}))
    check("200, четыре изделия", st == 200 and len(js.get("applied", [])) == 4, f"{st} {js if st != 200 else ''}")
    check("«Запланирован» → «Контрактация» и контракт", all(el(i)["current_status"] == "contracting" and el(i)["contract_id"] == cid for i in planned))
    check("статус «Отгружен» СОХРАНЁН, контракт назначен", all(el(i)["current_status"] == "shipped" and el(i)["contract_id"] == cid for i in shipped))
    check("история: +1 у запланированных, без изменений у остальных", all(hist(i) == h0[i] + 1 for i in planned) and all(hist(i) == h0[i] for i in shipped))
    check("остальные поля у всех четырёх не тронуты", all(stable_cols(el(i)) == stable_cols(b[i]) for i in b))
    check("изделие вне пачки не тронуто", el(ids[4])["contract_id"] is None and el(ids[4])["current_status"] == "delivered")

    print("A3 превышение остатка: откат всей пачки, журнал не подтверждает")
    pos, ids = position(); cid = pos["contract_id"]; H.make_room(db(), pos, 2); use = ids[:3]
    snap = H.checksum(); mark_events(); d0 = activity.discarded_count()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, use))
    check("409 — свободного количества нет", st == 409, f"{st} {js}")
    check("ничего не изменено (таблицы как были)", H.checksum() == snap)
    check("в журнале нет status_change и contract_allocate", not events("status_change", set(use)) and not events("contract_allocate"))
    check("отброшенные события посчитаны (2 изделия обработаны до отказа)", activity.discarded_count() - d0 == 2, str(activity.discarded_count() - d0))

    print("A4 изделие получило контракт после открытия формы (другим пользователем)")
    pos, ids = position(); cid = pos["contract_id"]
    other_c = None
    c = db()
    other_c = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements a ON a.id = s.agreement_id "
                        "WHERE a.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (cid,)).fetchone()["id"]
    c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (other_c, pos["element_type"], pos["mark"]))
    c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, 5)", (other_c, pos["element_type"], pos["mark"]))
    c.commit(); c.close()
    use = ids[:2]
    st2, _ = api("PATCH", f"/elements/{use[0]}/status", {"status": "contracting", "contract_id": other_c})   # «другой пользователь» назначил свой контракт
    snap_other = el(use[0])
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, use))
    conf = js.get("detail", {}).get("conflicts", []) if isinstance(js, dict) else []
    check("409 с перечнем расхождений (contract_assigned)", st == 409 and any(x["reason"] == "contract_assigned" and x["element_id"] == use[0] for x in conf), f"{st} {js}")
    check("чужой контракт НЕ перезаписан", el(use[0])["contract_id"] == other_c and el(use[0]) == snap_other)
    check("второе изделие пачки НЕ распределено молча", el(use[1])["contract_id"] is None and el(use[1])["current_status"] == "planned")

    print("A5 статус изменился после открытия формы")
    pos, ids = position(); cid = pos["contract_id"]; use = ids[:2]
    prep_status([use[0]], "shipped")
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, use))   # клиент ждал «Запланирован»
    conf = js.get("detail", {}).get("conflicts", []) if isinstance(js, dict) else []
    check("409 status_changed, ничего не применено", st == 409 and any(x["reason"] == "status_changed" for x in conf) and el(use[1])["contract_id"] is None, f"{st} {js}")

    print("A6 недопустимая пачка")
    pos, ids = position(); cid = pos["contract_id"]
    snap = H.checksum()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, [ids[0], ids[0], ids[1]]))
    check("дубли идентификаторов → 400, изменений нет", st == 400 and H.checksum() == snap, f"{st} {js}")
    st, js = api("POST", f"/contracts/{cid}/allocations", {"object_id": 1, "element_type": pos["element_type"], "mark": pos["mark"], "items": []})
    check("пустая пачка → 400", st == 400, f"{st}")
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, [ids[0], 99999999]))
    check("несуществующее изделие → 404, изменений нет", st == 404 and H.checksum() == snap, f"{st} {js}")
    c = db()
    alien = c.execute("SELECT id FROM elements WHERE object_id = 1 AND contract_id IS NULL AND current_status = 'planned' AND NOT (element_type = ? AND mark = ?) LIMIT 1",
                      (pos["element_type"], pos["mark"])).fetchone()["id"]
    c.close()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, [ids[0], alien]))
    check("изделие другой позиции → 409 other_position, изменений нет", st == 409 and H.checksum() == snap, f"{st} {js}")
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, [ids[0]], obj=2))
    check("объект пачки не совпадает с объектом контракта → 400", st == 400 and H.checksum() == snap, f"{st} {js}")
    c = db(); c.execute("UPDATE contracts SET is_archived = 1 WHERE id = ?", (cid,)); c.commit(); c.close()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, [ids[0]]))
    check("архивный контракт → 409", st == 409, f"{st} {js}")
    c = db(); c.execute("UPDATE contracts SET is_archived = 0 WHERE id = ?", (cid,)); c.commit(); c.close()
    st, js = api("POST", "/contracts/99999999/allocations", body(pos, [ids[0]]))
    check("несуществующий контракт → 404", st == 404, f"{st}")

    print("A7 права и авторизация")
    pos, ids = position(); cid = pos["contract_id"]
    c = db()
    nobody = c.execute("SELECT id FROM users WHERE role != 'admin' ORDER BY id LIMIT 1").fetchone()["id"]
    c.execute("DELETE FROM user_access WHERE user_id = ?", (nobody,)); c.commit(); c.close()
    snap = H.checksum()
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, ids[:2]), user=nobody)
    check("недостаточные права → 403 для всей пачки, изменений нет", st == 403 and H.checksum() == snap, f"{st} {js}")
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, ids[:2]), user=None)
    check("без сеанса → 401 (настоящая проверка)", st == 401 and H.checksum() == snap, f"{st} {js}")

    print("A8 повторная отправка и двойной клик")
    pos, ids = position(); cid = pos["contract_id"]; use = ids[:3]
    st1, js1 = api("POST", f"/contracts/{cid}/allocations", body(pos, use))
    h1 = {i: hist(i) for i in use}; rem1 = js1["position"]["remaining"]
    st2, js2 = api("POST", f"/contracts/{cid}/allocations", body(pos, use))   # потерянный ответ → клиент повторяет
    check("повтор: 200 already_applied, ничего не применено", st2 == 200 and js2.get("already_applied") is True and not js2.get("applied"), f"{st2} {js2}")
    check("повтор: новой истории нет, остаток тот же", all(hist(i) == h1[i] for i in use) and js2["position"]["remaining"] == rem1)
    pos, ids = position(); cid = pos["contract_id"]; use = ids[:3]; h0 = {i: hist(i) for i in use}
    res = race([(post, cid, body(pos, use)) for _ in range(2)])
    codes = sorted(str(r[1][0]) if r[0] == "ok" else str(r[0]) for r in res)
    info = [r[1][1].get("already_applied") for r in res if r[0] == "ok" and isinstance(r[1][1], dict)]
    check("двойной клик (два одновременных запроса): история +1 у каждого изделия", all(hist(i) == h0[i] + 1 for i in use), f"{codes}")
    check("двойной клик: исходы " + ",".join(codes) + " — применён один раз (второй: already_applied или 409), остаток не потрачен дважды", codes.count("200") >= 1 and all(c in ("200", "409") for c in codes), str(codes))

    print("A9 два пользователя на последнее место")
    outs = []
    for _ in range(5):
        pos, ids = position(4, 1); cid = pos["contract_id"]
        res = race([(post, cid, body(pos, [i])) for i in ids[:2]])
        codes = sorted(r[1][0] for r in res if r[0] == "ok")
        c = db()
        n = H.linked_n(c, cid, pos["element_type"], pos["mark"]); q = H.bought(c, cid, pos["element_type"], pos["mark"]); c.close()
        outs.append((codes, n <= q))
    check("в каждом из 5 раундов: один 200 и один 409, привязано не больше закупленного", all(o[0] == [200, 409] and o[1] for o in outs), str(outs))

    print("A10 таймаут блокировки и ошибка валидации")
    pos, ids = position(); cid = pos["contract_id"]; snap = H.checksum()
    old = appdb.BUSY_TIMEOUT_MS
    appdb.BUSY_TIMEOUT_MS = 300
    hold = sqlite3.connect(H.WORK, isolation_level=None, timeout=5)
    hold.execute("BEGIN IMMEDIATE")
    st, js = api("POST", f"/contracts/{cid}/allocations", body(pos, ids[:2]))
    hold.execute("ROLLBACK"); hold.close()
    appdb.BUSY_TIMEOUT_MS = old
    check("занятая БД → 503 с понятным текстом, изменений нет", st == 503 and "База занята" in str(js) and H.checksum() == snap, f"{st} {js}")
    check("после отказа другой писатель свободен", H.other_writer_ok())
    st, js = api("POST", f"/contracts/{cid}/allocations", {"object_id": "не число"})
    check("ошибка валидации → 422", st == 422, f"{st}")
    check("после 422 писатель свободен и запрос повторно проходит", H.other_writer_ok() and api("POST", f"/contracts/{cid}/allocations", body(pos, ids[:2]))[0] == 200)

    print("A11 совместимость прежних операций V1 (по HTTP)")
    pos, ids = position(); cid = pos["contract_id"]
    st, js = api("PATCH", "/elements/bulk-status", {"status": "contracting", "items": [{"element_id": ids[0], "contract_id": cid}]})
    check("bulk-status: 200 и контракт назначен", st == 200 and el(ids[0])["contract_id"] == cid and el(ids[0])["current_status"] == "contracting", f"{st}")
    st, js = api("PATCH", f"/elements/{ids[1]}/status", {"status": "contracting", "contract_id": cid})
    check("одиночная смена статуса: 200", st == 200 and el(ids[1])["contract_id"] == cid, f"{st}")
    prep_status([ids[2]], "shipped")
    st, js = api("PATCH", f"/elements/{ids[2]}/contract", {"contract_id": cid})
    check("назначение контракта изделию в статусе «Отгружен»: 200, статус сохранён", st == 200 and el(ids[2])["current_status"] == "shipped" and el(ids[2])["contract_id"] == cid, f"{st} {js if st != 200 else ''}")
    st, js = api("GET", f"/contracts/positions?element_type={pos['element_type']}")
    check("GET /contracts/positions: 200 (чтение не затронуто)", st == 200 and isinstance(js, list), f"{st}")
    st, js = api("GET", "/elements/" + str(ids[0]), user=None)
    check("GET без сеанса → 401", st == 401, f"{st}")

    print(f"\nнарушений: {len(FAILS)}")
    SERVER.should_exit = True
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main_run()
