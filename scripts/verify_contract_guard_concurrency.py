"""Воспроизводимая проверка: держит ли backend остаток контракта при ОДНОВРЕМЕННЫХ операциях (страж app/contract_guard.py).

Что проверяется (каждый сценарий — серия раундов, каждый раунд на свежей копии БД):
  S1  «последнее место»: N потоков одновременно распределяют по одному изделию на позицию с остатком 1 (пачка bulk-status);
  S2  пачки «всё или ничего»: две пачки по 2 изделия на остаток 3 — применяется ровно одна целиком, вторая откатывается без следа;
  S3  разные обработчики: одиночная смена статуса, пачка и назначение контракта (set_element_contract) на одно последнее место;
  S4  замена поставщика (проведение документа) против распределения на то же последнее место нового контракта;
  S5  изменение количества контракта (update_contract) против распределения: после операций привязано не больше закупленного;
  S6  откат при отказе внутри пачки: ни статусов, ни контрактов, ни записей истории, ни updated_at не остаётся;
  S7  ожидание блокировки: писатель ждёт не дольше busy_timeout, затем чистый отказ (без частичных изменений), после освобождения — успех;
  S10 контракт ЧУЖОГО объекта с позицией под ту же марку не принимается (пачкой и одиночной сменой статуса);
  S11 одиночная смена статуса без contract_id (как делает форма V2) — что происходит с контрактом (наблюдение);
  S14 отмена проведения замены поставщика (unpost) против операции, занимающей освободившийся остаток «прежнего» контракта —
      только один исход побеждает, отмена не превышает остаток молча (2026-09-22, дефект app/supplier_change.py unpost_supplier_change);
  (журнал действий при откате пачки проверяет scripts/verify_activity_journal.py)
  S8  СВОЙСТВА пачки bulk-status (не гонка): что она делает с контрактом (перезапись устаревшим, снятие, «Запланирован», архивный, чужой объект).

Запуск (только на КОПИИ обезличенной БД; сама БД не меняется — каждый раунд работает на временной копии):
    ZHBI_DB_PATH=<временный путь> .venv/bin/python scripts/verify_contract_guard_concurrency.py <копия_БД> [--rounds N] [--only S1,S3]
Код возврата 0 — все инварианты сохранены во всех раундах; 1 — есть нарушения (печатается, сколько и в каких сценариях).
Вызываются сами обработчики (app.main / app.contracts / app.supplier_change) в потоках, у каждого свой connection — как в сервере,
где синхронные роуты идут в пуле потоков; авторизация не задействована (берётся строка администратора копии).
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

args = sys.argv[1:]
if not args:
    print(__doc__)
    sys.exit(2)
BASE = Path(args[0]).resolve()
ROUNDS = int(args[args.index("--rounds") + 1]) if "--rounds" in args else 12
ONLY = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None

WORK = Path(tempfile.mkdtemp(prefix="zhbi_guard_")) / "work.db"
os.environ["ZHBI_DB_PATH"] = str(WORK)          # ДО импорта app: путь читается при импорте
shutil.copyfile(BASE, WORK)

from fastapi import HTTPException  # noqa: E402

import app.db as appdb  # noqa: E402
import app.main as main  # noqa: E402
from app import contracts as contracts_mod  # noqa: E402
from app import supplier_change as sc  # noqa: E402
from app.models import BulkStatusItem, BulkStatusUpdateIn, Status, StatusUpdateIn  # noqa: E402

assert Path(appdb.DB_PATH) == WORK, "путь к БД должен быть временной копией"


def fresh_db():
    """Свежая копия БД для раунда (соединения раунда уже закрыты)."""
    for suf in ("-wal", "-shm"):
        p = Path(str(WORK) + suf)
        if p.exists():
            p.unlink()
    shutil.copyfile(BASE, WORK)


def db():
    c = sqlite3.connect(WORK)
    c.row_factory = sqlite3.Row
    return c


def admin_row():
    c = db()
    try:
        return c.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    finally:
        c.close()


USER = None


def bulk_body(ids, contract_id, status="contracting"):
    return BulkStatusUpdateIn(items=[BulkStatusItem(element_id=i, contract_id=contract_id) for i in ids], status=Status(status))


def call(fn, *a, **kw):
    """Результат вызова обработчика: ('ok', ответ) | (код HTTP, текст) | ('exc', тип)."""
    try:
        return ("ok", fn(*a, **kw))
    except HTTPException as e:
        return (e.status_code, str(e.detail)[:120])
    except Exception as e:  # noqa: BLE001 — любое иное исключение — тоже исход, его надо видеть
        return ("exc", f"{type(e).__name__}: {str(e)[:100]}")


def race(jobs):
    """Запустить работы одновременно (барьер) и вернуть исходы по порядку."""
    out = [None] * len(jobs)
    bar = threading.Barrier(len(jobs))

    def run(i, job):
        bar.wait()
        out[i] = call(*job)

    ts = [threading.Thread(target=run, args=(i, j)) for i, j in enumerate(jobs)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    return out


# ------------------------------------------------------------------ данные сценариев
def find_position(c, need_free, obj=1):
    """Позиция контракта объекта, у которой есть >= need_free запланированных изделий без контракта (тип, марка)."""
    rows = c.execute(
        "SELECT cl.contract_id, cl.element_type, cl.mark, co.specification_id FROM contract_lines cl "
        "JOIN contracts co ON co.id = cl.contract_id JOIN specifications s ON s.id = co.specification_id "
        "JOIN agreements a ON a.id = s.agreement_id WHERE a.object_id = ? AND co.is_archived = 0 AND cl.mark IS NOT NULL", (obj,)).fetchall()
    for r in rows:
        ids = [x["id"] for x in c.execute(
            "SELECT id FROM elements WHERE object_id = ? AND element_type = ? AND mark = ? AND contract_id IS NULL "
            "AND current_status = 'planned' ORDER BY id LIMIT ?", (obj, r["element_type"], r["mark"], need_free + 4))]
        if len(ids) >= need_free:
            return dict(r), ids
    raise SystemExit("в копии не нашлось подходящей позиции")


def linked_n(c, cid, etype, mark):
    return c.execute("SELECT COUNT(*) n FROM elements WHERE contract_id = ? AND element_type = ? AND mark = ? AND current_status != 'planned'",
                     (cid, etype, mark)).fetchone()["n"]


def bought(c, cid, etype, mark):
    return c.execute("SELECT COALESCE(SUM(quantity), 0) n FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?",
                     (cid, etype, mark)).fetchone()["n"]


def hist_n(c, ids):
    q = ",".join("?" * len(ids))
    return c.execute(f"SELECT COUNT(*) n FROM status_history WHERE element_id IN ({q})", ids).fetchone()["n"]


def make_room(c, pos, remaining):
    """Довести остаток позиции до `remaining`: количество = уже привязано + remaining (без обращения к остальным данным)."""
    fact = linked_n(c, pos["contract_id"], pos["element_type"], pos["mark"])
    c.execute("UPDATE contract_lines SET quantity = ? WHERE contract_id = ? AND element_type = ? AND mark = ?",
              (fact + remaining, pos["contract_id"], pos["element_type"], pos["mark"]))
    c.commit()


def state_of(c, ids):
    q = ",".join("?" * len(ids))
    return [tuple(r) for r in c.execute(f"SELECT id, current_status, contract_id, updated_at, actual_delivery_date FROM elements WHERE id IN ({q}) ORDER BY id", ids)]


# ------------------------------------------------------------------ сценарии
def alloc_job(ids, cid, pos):
    """Работа для race(): то же распределение новым маршрутом POST /contracts/{id}/allocations (одна пачка, сверка состояния)."""
    import app.allocation as alloc
    body = alloc.AllocationIn(object_id=1, element_type=pos["element_type"], mark=pos["mark"],
                              items=[alloc.AllocationItem(element_id=i, expected_status="planned") for i in ids])
    return (alloc.allocate, cid, body, USER)


def s1(round_no):
    fresh_db()
    c = db()
    pos, ids = find_position(c, 8)
    make_room(c, pos, 1)
    before = state_of(c, ids[:8]); h0 = hist_n(c, ids[:8])
    c.close()
    res = race([(main.update_status_bulk, bulk_body([i], pos["contract_id"]), USER) for i in ids[:8]])
    c = db()
    n = linked_n(c, pos["contract_id"], pos["element_type"], pos["mark"]); q = bought(c, pos["contract_id"], pos["element_type"], pos["mark"])
    winners = [i for i, r in zip(ids[:8], res) if r[0] == "ok"]
    losers = [i for i, r in zip(ids[:8], res) if r[0] != "ok"]
    clean = all(s == b for s, b in zip(state_of(c, losers), [b for b in before if b[0] in losers])) if losers else True
    h_ok = hist_n(c, ids[:8]) == h0 + len(winners)
    c.close()
    bad = []
    if n > q:
        bad.append(f"привязано {n} > закуплено {q}")
    if len(winners) != 1:
        bad.append(f"успешных запросов {len(winners)}, ожидался 1")
    if not clean:
        bad.append("у проигравших изменились статус/контракт/updated_at")
    if not h_ok:
        bad.append("история не соответствует числу успешных")
    return bad, Counter(str(r[0]) for r in res)


def s2(round_no):
    fresh_db()
    c = db()
    pos, ids = find_position(c, 4)
    make_room(c, pos, 3)
    before = state_of(c, ids[:4]); h0 = hist_n(c, ids[:4])
    c.close()
    res = race([(main.update_status_bulk, bulk_body(ids[0:2], pos["contract_id"]), USER), (main.update_status_bulk, bulk_body(ids[2:4], pos["contract_id"]), USER)])
    c = db()
    n = linked_n(c, pos["contract_id"], pos["element_type"], pos["mark"]); q = bought(c, pos["contract_id"], pos["element_type"], pos["mark"])
    ok = [i for i, r in enumerate(res) if r[0] == "ok"]
    after = state_of(c, ids[:4]); h1 = hist_n(c, ids[:4])
    c.close()
    bad = []
    if n > q:
        bad.append(f"привязано {n} > закуплено {q}")
    if len(ok) != 1:
        bad.append(f"применено пачек {len(ok)}, ожидалась 1")
    else:
        lost = [0, 1] if ok[0] == 1 else [2, 3]
        if any(after[k] != before[k] for k in lost):
            bad.append("проигравшая пачка оставила следы")
        if h1 != h0 + 2:
            bad.append(f"записей истории +{h1 - h0}, ожидалось +2")
    return bad, Counter(str(r[0]) for r in res)


def other_status_element(c, pos, skip):
    """Изделие той же позиции БЕЗ контракта в статусе, отличном от «Запланирован» (готовится SQL-ом: смена типа изделий не нужна)."""
    e = c.execute("SELECT id FROM elements WHERE object_id = 1 AND element_type = ? AND mark = ? AND contract_id IS NULL AND current_status = 'planned' "
                  "AND id NOT IN (%s) ORDER BY id LIMIT 1" % ",".join("?" * len(skip)), [pos["element_type"], pos["mark"], *skip]).fetchone()["id"]
    c.execute("UPDATE elements SET current_status = 'shipped' WHERE id = ?", (e,))
    c.execute("INSERT INTO status_history (element_id, status, changed_by) VALUES (?, 'shipped', 'тест')", (e,))
    c.commit()
    return e


def s3(round_no):
    fresh_db()
    c = db()
    pos, ids = find_position(c, 6)
    make_room(c, pos, 1)
    third = other_status_element(c, pos, ids[:4])
    c.close()
    cid = pos["contract_id"]
    from app.contracts import ContractLineIn  # noqa: F401
    res = race([
        (main.update_status_bulk, bulk_body([ids[0]], cid), USER),
        (main.update_status, ids[1], StatusUpdateIn(status=Status("contracting"), contract_id=cid), USER),
        (main.set_element_contract, third, main.ElementContractIn(contract_id=cid), USER),
    ])
    c = db()
    n = linked_n(c, cid, pos["element_type"], pos["mark"]); q = bought(c, cid, pos["element_type"], pos["mark"])
    c.close()
    bad = []
    if n > q:
        bad.append(f"привязано {n} > закуплено {q}")
    if sum(1 for r in res if r[0] == "ok") != 1:
        bad.append(f"успешных {sum(1 for r in res if r[0] == 'ok')}, ожидался 1")
    return bad, Counter(str(r[0]) for r in res)


def s4(round_no, alloc=False):
    """Замена поставщика: документ переносит одно изделие A→B, одновременно на последнее место B распределяют другое изделие."""
    fresh_db()
    c = db()
    pos, ids = find_position(c, 6)
    a_id = pos["contract_id"]
    b_row = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements a ON a.id = s.agreement_id "
                      "WHERE a.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (a_id,)).fetchone()
    b_id = b_row["id"]
    # позиция в A — 3 места, в B — 2 места; в A и B уже привязано по одному изделию
    for cid, qty in ((a_id, 3), (b_id, 2)):
        c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (cid, pos["element_type"], pos["mark"]))
        c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)", (cid, pos["element_type"], pos["mark"], qty))
    for e, cid in ((ids[0], a_id), (ids[1], a_id), (ids[2], b_id)):
        c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (cid, e))
        c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (e, cid))
    c.commit()
    c.close()
    doc = sc.create_supplier_change(sc.SupplierChangeIn(object_id=1, doc_date="2026-09-21", from_contract_id=a_id, to_contract_id=b_id, element_ids=[ids[0]]), USER)
    res = race([
        (sc.post_supplier_change, doc["id"], USER),
        (alloc_job([ids[3]], b_id, pos) if alloc else (main.update_status_bulk, bulk_body([ids[3]], b_id), USER)),
    ])
    c = db()
    n = linked_n(c, b_id, pos["element_type"], pos["mark"]); q = bought(c, b_id, pos["element_type"], pos["mark"])
    c.close()
    bad = []
    if n > q:
        bad.append(f"в новом контракте привязано {n} > закуплено {q}")
    if sum(1 for r in res if r[0] == "ok") != 1:
        bad.append(f"успешных {sum(1 for r in res if r[0] == 'ok')}, ожидался 1")
    return bad, Counter(str(r[0]) for r in res)


def s5(round_no, alloc=False):
    """Количество позиции уменьшают до числа уже привязанного, одновременно распределяют ещё одно изделие."""
    fresh_db()
    c = db()
    pos, ids = find_position(c, 4)
    cid = pos["contract_id"]
    make_room(c, pos, 1)
    q0 = bought(c, cid, pos["element_type"], pos["mark"]); fact = linked_n(c, cid, pos["element_type"], pos["mark"])
    co = c.execute("SELECT * FROM contracts WHERE id = ?", (cid,)).fetchone()
    lines = [contracts_mod.ContractLineIn(element_type=r["element_type"], mark=r["mark"], quantity=(fact if (r["element_type"], r["mark"]) == (pos["element_type"], pos["mark"]) else r["quantity"]))
             for r in c.execute("SELECT * FROM contract_lines WHERE contract_id = ?", (cid,))]
    incs = [contracts_mod.ContractIncidentIn(element_type=r["element_type"], quantity=r["quantity"], incident_date=r["incident_date"], description=r["description"])
            for r in c.execute("SELECT * FROM contract_incidents WHERE contract_id = ?", (cid,))]
    c.close()
    body = contracts_mod.ContractIn(specification_id=co["specification_id"], theme=co["theme"], is_archived=bool(co["is_archived"]), lines=lines, incidents=incs, capacity=[])
    res = race([
        (contracts_mod.update_contract, cid, body, USER),
        (alloc_job([ids[0]], cid, pos) if alloc else (main.update_status_bulk, bulk_body([ids[0]], cid), USER)),
    ])
    c = db()
    n = linked_n(c, cid, pos["element_type"], pos["mark"]); q = bought(c, cid, pos["element_type"], pos["mark"])
    c.close()
    bad = []
    if n > q:
        bad.append(f"привязано {n} > закуплено {q} (было {q0} и привязано {fact})")
    if sum(1 for r in res if r[0] == "ok") != 1:
        bad.append(f"успешных {sum(1 for r in res if r[0] == 'ok')}, ожидался 1")
    return bad, Counter(str(r[0]) for r in res)


def s6(round_no):
    fresh_db()
    c = db()
    pos, ids = find_position(c, 3)
    make_room(c, pos, 2)
    before = state_of(c, ids[:3]); h0 = hist_n(c, ids[:3])
    ev0 = c.execute("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'activity_log'").fetchone()["n"]
    c.close()
    r = call(main.update_status_bulk, bulk_body(ids[:3], pos["contract_id"]), USER)   # третье изделие не помещается
    c = db()
    after = state_of(c, ids[:3]); h1 = hist_n(c, ids[:3])
    c.close()
    bad = []
    if r[0] != 409:
        bad.append(f"ожидался отказ 409, получено {r[0]}")
    if after != before:
        bad.append("после отказа изменились статусы/контракты/updated_at")
    if h1 != h0:
        bad.append(f"после отказа появились записи истории (+{h1 - h0})")
    return bad, Counter([str(r[0])])


def s7(round_no):
    fresh_db()
    c = db()
    pos, ids = find_position(c, 2)
    make_room(c, pos, 2)
    before = state_of(c, ids[:2]); h0 = hist_n(c, ids[:2])
    c.close()
    old = appdb.BUSY_TIMEOUT_MS
    appdb.BUSY_TIMEOUT_MS = 300
    hold = sqlite3.connect(WORK, isolation_level=None, timeout=5)
    hold.execute("BEGIN IMMEDIATE")                       # чужая пишущая транзакция
    t0 = time.time()
    r = call(main.update_status_bulk, bulk_body(ids[:2], pos["contract_id"]), USER)
    waited = time.time() - t0
    c = db()
    after = state_of(c, ids[:2]); h1 = hist_n(c, ids[:2])
    c.close()
    hold.execute("ROLLBACK"); hold.close()
    r2 = call(main.update_status_bulk, bulk_body(ids[:2], pos["contract_id"]), USER)   # после освобождения — успех
    appdb.BUSY_TIMEOUT_MS = old
    bad = []
    if r[0] != 503:
        bad.append(f"при занятой БД ожидался чистый отказ 503, получено {r[0]}: {r[1] if len(r) > 1 else ''}")
    if after != before or h1 != h0:
        bad.append("при отказе по блокировке остались частичные изменения")
    if not (0.25 <= waited <= 2.0):
        bad.append(f"ожидание блокировки {waited:.2f} с вне ожидаемых пределов (busy_timeout 0,3 с)")
    if r2[0] != "ok":
        bad.append(f"после освобождения блокировки операция не прошла: {r2[0]}")
    return bad, Counter([str(r[0]), "затем " + str(r2[0])])


def s8(round_no):
    """Свойства пачки bulk-status — фиксируем, что ДЕЛАЕТ backend (это не гонка). Возвращает описание, нарушений нет."""
    fresh_db()
    c = db()
    pos, ids = find_position(c, 6)
    cid = pos["contract_id"]
    other = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements a ON a.id = s.agreement_id "
                      "WHERE a.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (cid,)).fetchone()["id"]
    for k in (cid, other):
        c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (k, pos["element_type"], pos["mark"]))
        c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, 10)", (k, pos["element_type"], pos["mark"]))
    e = ids[0]
    c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (cid, e))
    c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (e, cid))
    c.commit()
    facts = {}

    def cur(x):
        return tuple(db().execute("SELECT current_status, contract_id FROM elements WHERE id = ?", (x,)).fetchone())

    # (a) устаревший контракт: клиент «помнит» контракт `other`, у изделия на деле `cid` — пачка молча перезаписывает
    r = call(main.update_status_bulk, bulk_body([e], other, "in_production"), USER)
    facts["устаревший контракт в теле → " + str(r[0])] = f"итог у изделия: {cur(e)} (контракт был {cid}, стал {cur(e)[1]})"
    # (b) контракт null в теле снимает контракт
    r = call(main.update_status_bulk, BulkStatusUpdateIn(items=[BulkStatusItem(element_id=e, contract_id=None)], status=Status("shipped")), USER)
    facts["contract_id=null в теле → " + str(r[0])] = f"итог: {cur(e)}"
    # (c) переход в «Запланирован» снимает контракт
    c2 = db(); c2.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (cid, ids[1])); c2.commit(); c2.close()
    r = call(main.update_status_bulk, bulk_body([ids[1]], cid, "planned"), USER)
    facts["статус «Запланирован» с контрактом в теле → " + str(r[0])] = f"итог: {cur(ids[1])}"
    # (d) архивный контракт
    c2 = db(); c2.execute("UPDATE contracts SET is_archived = 1 WHERE id = ?", (other,)); c2.commit(); c2.close()
    r = call(main.update_status_bulk, bulk_body([ids[2]], other), USER)
    facts["архивный контракт в теле → " + str(r[0])] = f"итог: {cur(ids[2])}" + ("" if r[0] == "ok" else f" ({r[1]})")
    # (e) контракт другого объекта, у которого есть позиция под ту же марку
    c2 = db()
    foreign = c2.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements a ON a.id = s.agreement_id "
                         "WHERE a.object_id != 1 AND co.is_archived = 0 ORDER BY co.id LIMIT 1").fetchone()
    if not foreign:   # в копии у контрактов один объект — заводим контракт объекта 2 (договор → спецификация → контракт) в ВРЕМЕННОЙ копии
        cp = c2.execute("SELECT counterparty_id FROM agreements LIMIT 1").fetchone()["counterparty_id"]
        c2.execute("INSERT INTO agreements (counterparty_id, number, object_id) VALUES (?, 'ТЕСТ-ЧУЖОЙ', 2)", (cp,))
        ag = c2.execute("SELECT last_insert_rowid() i").fetchone()["i"]
        c2.execute("INSERT INTO specifications (agreement_id, number) VALUES (?, 'ТЕСТ-СП')", (ag,))
        sp = c2.execute("SELECT last_insert_rowid() i").fetchone()["i"]
        c2.execute("INSERT INTO contracts (specification_id) VALUES (?)", (sp,))
        foreign = {"id": c2.execute("SELECT last_insert_rowid() i").fetchone()["i"]}
    if foreign:
        c2.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (foreign["id"], pos["element_type"], pos["mark"]))
        c2.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, 10)", (foreign["id"], pos["element_type"], pos["mark"]))
        c2.commit(); c2.close()
        r = call(main.update_status_bulk, bulk_body([ids[3]], foreign["id"]), USER)
        facts["контракт ДРУГОГО объекта с той же позицией в теле → " + str(r[0])] = f"итог: {cur(ids[3])}" + ("" if r[0] == "ok" else f" ({r[1]})")
        r = call(main.update_status, ids[5], StatusUpdateIn(status=Status("contracting"), contract_id=foreign["id"]), USER)
        facts["то же через одиночную смену статуса (update_status) → " + str(r[0])] = f"итог: {cur(ids[5])}" + ("" if r[0] == "ok" else f" ({r[1]})")
        c3 = db(); c3.execute("UPDATE elements SET current_status = 'shipped' WHERE id = ?", (ids[4],)); c3.commit(); c3.close()   # не «Запланирован»
        r = call(main.set_element_contract, ids[4], main.ElementContractIn(contract_id=foreign["id"]), USER)
        facts["то же через set_element_contract (одиночное назначение) → " + str(r[0])] = "" if r[0] == "ok" else str(r[1])
    else:
        c2.close()
    return [], facts


def s10(round_no):
    """Контракт ЧУЖОГО объекта с позицией под ту же марку не должен приниматься ни пачкой, ни одиночной сменой статуса."""
    fresh_db()
    c = db()
    pos, ids = find_position(c, 3)
    cp = c.execute("SELECT counterparty_id FROM agreements LIMIT 1").fetchone()["counterparty_id"]
    c.execute("INSERT INTO agreements (counterparty_id, number, object_id) VALUES (?, 'ТЕСТ-ЧУЖОЙ', 2)", (cp,))
    ag = c.execute("SELECT last_insert_rowid() i").fetchone()["i"]
    c.execute("INSERT INTO specifications (agreement_id, number) VALUES (?, 'ТЕСТ-СП')", (ag,))
    sp = c.execute("SELECT last_insert_rowid() i").fetchone()["i"]
    c.execute("INSERT INTO contracts (specification_id) VALUES (?)", (sp,))
    foreign = c.execute("SELECT last_insert_rowid() i").fetchone()["i"]
    c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, 10)", (foreign, pos["element_type"], pos["mark"]))
    c.commit()
    before = state_of(c, ids[:2]); h0 = hist_n(c, ids[:2])
    c.close()
    r1 = call(main.update_status_bulk, bulk_body([ids[0]], foreign), USER)
    r2 = call(main.update_status, ids[1], StatusUpdateIn(status=Status("contracting"), contract_id=foreign), USER)
    c = db()
    after = state_of(c, ids[:2]); h1 = hist_n(c, ids[:2])
    c.close()
    bad = []
    if r1[0] == "ok" or r2[0] == "ok":
        bad.append(f"контракт чужого объекта принят (пачка: {r1[0]}, одиночная: {r2[0]})")
    if (after != before or h1 != h0) and not bad:
        bad.append("при отказе остались изменения")
    return bad, Counter([f"пачка {r1[0]}", f"одиночная {r2[0]}"])


def s11(round_no):
    """Одиночная смена статуса БЕЗ contract_id в теле (так делает форма V2): что происходит с контрактом изделия. Наблюдения."""
    fresh_db()
    c = db()
    pos, ids = find_position(c, 4)
    cid = pos["contract_id"]
    make_room(c, pos, 3)
    e_linked, e_plan, e_back = ids[0], ids[1], ids[2]
    for e in (e_linked, e_back):
        c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (cid, e))
        c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (e, cid))
    c.commit()
    c.close()

    def cur(x):
        return tuple(db().execute("SELECT current_status, contract_id FROM elements WHERE id = ?", (x,)).fetchone())

    facts = {}
    r = call(main.update_status, e_linked, StatusUpdateIn(status=Status("in_production")), USER)
    facts["контракт есть, «В производстве» без contract_id → " + str(r[0])] = f"итог: {cur(e_linked)} (контракт сохранён)"
    r = call(main.update_status, e_plan, StatusUpdateIn(status=Status("contracting")), USER)
    facts["«Запланирован» → «Контрактация» без contract_id → " + str(r[0])] = f"итог: {cur(e_plan)} (контракт не назначается — его выбирают отдельно)"
    r = call(main.update_status, e_back, StatusUpdateIn(status=Status("planned")), USER)
    facts["контракт есть, возврат в «Запланирован» без contract_id → " + str(r[0])] = f"итог: {cur(e_back)} (контракт СНЯТ)"
    return [], facts


def s14(round_no):
    """Отмена проведения замены поставщика (unpost) против операции, занимающей освободившийся остаток «прежнего» контракта.

    Готовим: контракт A (прежний) — 2 места, оба заняты; контракт B (новый) — 2 места, занято 1. Проводим замену поставщика,
    переносящую одно изделие A → B (в B было свободно ровно 1 место): после проведения в A освобождается ровно 1 место.
    Гоняем НАПЕРЕГОНКИ отмену проведения этого документа (она вернёт изделие назад в A) и отдельную операцию, занимающую то же
    освободившееся место в A другим изделием той же позиции. Ровно один исход должен победить при любом порядке — либо отмена
    успевает первой и конкурент получает честный отказ (точечная проверка assert_link_allowed, она была и раньше), либо
    конкурент успевает первым и ТЕПЕРЬ отмена обязана отказать 409 (assert_no_regression, дефект 2026-09-22, до исправления
    отмена превышала остаток молча). В обоих случаях привязано в A не должно быть больше закупленного.
    """
    fresh_db()
    c = db()
    pos, ids = find_position(c, 6)
    a_id = pos["contract_id"]
    b_row = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements a ON a.id = s.agreement_id "
                      "WHERE a.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (a_id,)).fetchone()
    b_id = b_row["id"]
    # Количество — ПОВЕРХ уже привязанного на каждом контракте под эту позицию (как make_room), а не абсолютное число: в
    # накопленных данных на a_id/b_id уже может быть что-то привязано под эту же (тип, марка), и абсолютная цифра тогда
    # создавала бы фиктивное превышение с самого начала, не относящееся к проверяемой гонке.
    fact_a = linked_n(c, a_id, pos["element_type"], pos["mark"])
    fact_b = linked_n(c, b_id, pos["element_type"], pos["mark"])
    for cid, qty in ((a_id, fact_a + 2), (b_id, fact_b + 2)):
        c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (cid, pos["element_type"], pos["mark"]))
        c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)", (cid, pos["element_type"], pos["mark"], qty))
    # A: +2 новых привязки — полностью занят (0 свободных мест из добавленных qty). B: +1 — остаётся ровно 1 свободное
    # место (второе из добавленных qty) — его займёт проведение замены поставщика.
    for e, cid in ((ids[0], a_id), (ids[1], a_id), (ids[2], b_id)):
        c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (cid, e))
        c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (e, cid))
    c.commit()
    c.close()
    doc = sc.create_supplier_change(sc.SupplierChangeIn(object_id=1, doc_date="2026-09-21", from_contract_id=a_id, to_contract_id=b_id, element_ids=[ids[0]]), USER)
    sc.post_supplier_change(doc["id"], USER)   # A: свободно ровно 1 место (переехавшее); B: полностью занят
    res = race([
        (sc.unpost_supplier_change, doc["id"], USER),
        (main.update_status_bulk, bulk_body([ids[3]], a_id), USER),   # занимает то же свободное место в A
    ])
    c = db()
    n = linked_n(c, a_id, pos["element_type"], pos["mark"]); q = bought(c, a_id, pos["element_type"], pos["mark"])
    doc_status = c.execute("SELECT status FROM supplier_change_docs WHERE id = ?", (doc["id"],)).fetchone()["status"]
    c.close()
    bad = []
    if n > q:
        bad.append(f"в «прежнем» контракте привязано {n} > закуплено {q}")
    ok_n = sum(1 for r in res if r[0] == "ok")
    if ok_n != 1:
        bad.append(f"успешных {ok_n}, ожидался 1")
    unpost_ok = res[0][0] == "ok"
    if unpost_ok and doc_status != sc.DRAFT:
        bad.append(f"отмена сообщила об успехе, но документ не в статусе «черновик» (статус «{doc_status}»)")
    if not unpost_ok and doc_status != sc.POSTED:
        bad.append(f"отмена отклонена, но документ не остался проведённым (статус «{doc_status}»)")
    return bad, Counter(str(r[0]) for r in res)


SCENARIOS = [("S1", "последнее место: 8 одновременных пачек по 1 изделию", s1), ("S2", "две пачки по 2 на остаток 3 (всё или ничего)", s2),
             ("S3", "три разных обработчика на последнее место", s3), ("S4", "проведение замены поставщика против распределения", s4),
             ("S5", "уменьшение количества контракта против распределения", s5), ("S6", "откат при отказе внутри пачки", s6),
             ("S7", "ожидание блокировки и чистый отказ", s7), ("S10", "контракт чужого объекта отклоняется", s10),
             ("S12", "проведение замены поставщика против НОВОГО распределения (allocations)", lambda k: s4(k, alloc=True)),
             ("S13", "уменьшение количества позиции против НОВОГО распределения (allocations)", lambda k: s5(k, alloc=True)),
             ("S14", "отмена проведения замены поставщика против занятия освободившегося остатка", s14)]

if __name__ == "__main__":
    USER = admin_row()
    total_bad = 0
    for sid, title, fn in SCENARIOS:
        if ONLY and sid not in ONLY:
            continue
        bad_rounds, outcomes = 0, Counter()
        first_bad = []
        rounds = 1 if sid in ("S6", "S7", "S10") else ROUNDS
        for k in range(rounds):
            bad, oc = fn(k)
            outcomes.update(oc)
            if bad:
                bad_rounds += 1
                first_bad = first_bad or bad
        total_bad += bad_rounds
        print(f"{sid} {title}: раундов {rounds}, нарушений {bad_rounds}; исходы запросов: {dict(outcomes)}" + (f"\n    пример нарушения: {'; '.join(first_bad)}" if first_bad else ""))
    if not ONLY or "S11" in ONLY:
        _, f11 = s11(0)
        print("S11 одиночная смена статуса без contract_id (наблюдения):")
        for k, v in f11.items():
            print(f"    {k}: {v}")
    if not ONLY or "S8" in ONLY:
        _, facts = s8(0)
        print("S8 свойства пачки bulk-status (наблюдения, не гонка):")
        for k, v in facts.items():
            print(f"    {k}: {v}")
    shutil.rmtree(WORK.parent, ignore_errors=True)
    print("ИТОГ:", "нарушений нет" if not total_bad else f"нарушений: {total_bad} раундов")
    sys.exit(1 if total_bad else 0)
