"""Подготовка данных для проверки распределения на КОПИИ БД (только временной копии, `work.db` из real_auth_server.py).

Для каждой запрошенной позиции (A, B, …) подбирает контракт объекта 1 и марку, у которых есть не менее 6 свободных изделий «Запланирован»,
и выставляет количество позиции так, чтобы доступный остаток был заданным (A — 3, B — 4). Для «B» два первых изделия переводятся в «Отгружен»
и «Доставлен» (смешанная пачка). Печатает JSON с описанием подготовленных позиций (контракт, поставщик, тип, марка, изделия).

Запуск:  python3 scripts/prep_alloc_case.py <work.db> A,B > prep.json
"""
import json
import sqlite3
import sys

W, names = sys.argv[1], sys.argv[2].split(",")
REM = {"A": 3, "B": 4, "C": 1, "D": 3, "E": 3, "F": 3}
c = sqlite3.connect(W)
c.row_factory = sqlite3.Row
rows = c.execute(
    "SELECT cl.contract_id, cl.element_type, cl.mark, ag.number an, s.number sn, co.theme, cp.short_name sup "
    "FROM contract_lines cl JOIN contracts co ON co.id = cl.contract_id JOIN specifications s ON s.id = co.specification_id "
    "JOIN agreements ag ON ag.id = s.agreement_id JOIN counterparties cp ON cp.id = ag.counterparty_id "
    "WHERE ag.object_id = 1 AND co.is_archived = 0 ORDER BY cl.contract_id, cl.id").fetchall()


def fact(cid, t, m):
    return c.execute("SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND element_type = ? AND mark = ? AND current_status != 'planned'", (cid, t, m)).fetchone()["n"]


out, k = {}, 0
for r in rows:
    if k >= len(names):
        break
    ids = [x["id"] for x in c.execute(
        "SELECT id FROM elements WHERE object_id = 1 AND element_type = ? AND mark = ? AND contract_id IS NULL AND current_status = 'planned' ORDER BY id LIMIT 8",
        (r["element_type"], r["mark"]))]
    if len(ids) < 6:
        continue
    name = names[k]
    k += 1
    if name == "B":
        for e, st in ((ids[0], "shipped"), (ids[1], "delivered")):
            c.execute("UPDATE elements SET current_status = ? WHERE id = ?", (st, e))
            c.execute("INSERT INTO status_history(element_id, status, changed_by) VALUES (?, ?, 'тест')", (e, st))
    q = fact(r["contract_id"], r["element_type"], r["mark"]) + REM[name]
    c.execute("UPDATE contract_lines SET quantity = ? WHERE contract_id = ? AND element_type = ? AND mark = ?", (q, r["contract_id"], r["element_type"], r["mark"]))
    out[name] = {"cid": r["contract_id"], "sup": r["sup"], "contract": " · ".join(x for x in (r["an"], r["sn"], r["theme"]) if x),
                 "type": r["element_type"], "mark": r["mark"], "ids": ids, "rem": REM[name]}
c.commit()
print(json.dumps(out, ensure_ascii=False))
