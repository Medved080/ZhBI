"""Регрессия: каждый обработчик, берущий блокировку записи (app.db.begin_write), освобождает её при ЛЮБОМ исходе.

Причина появления: в `update_contract` начало транзакции и проверки доступа стояли ДО try/finally; отказ в правах оставлял соединение с
открытой пишущей транзакцией, и второй писатель получал «database is locked» (найдено проверяющим на пустой временной БД).

Для каждого обработчика и каждого вида отказа проверяется: (1) соединения, открытые обработчиком, закрыты/без открытой транзакции — ссылки на них
удерживаются тестом, поэтому проверка НЕ зависит от сборщика мусора; (2) другой писатель сразу начинает пишущую транзакцию; (3) отпечаток таблиц
не изменился (частичных изменений нет).
Виды отказа: права, отсутствующая сущность (404), исключение внутри операции ПОСЛЕ записи, таймаут ожидания блокировки (503), ошибка валидации.

Запуск (только на копии обезличенной БД):  .venv/bin/python scripts/verify_lock_release.py <копия_БД>
"""

import _guard_harness as H  # noqa: E402,I001  (первым: задаёт путь к БД)
from _guard_harness import call, db, fresh_db, other_writer_ok, released, user_row  # noqa: E402

import sqlite3  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import app.db as appdb  # noqa: E402
import app.main as main  # noqa: E402
from app import contract_guard  # noqa: E402
from app import contracts as contracts_mod  # noqa: E402
from app import supplier_change as sc  # noqa: E402
from app.models import BulkStatusItem, BulkStatusUpdateIn, Status, StatusUpdateIn  # noqa: E402

MODS = [main, contracts_mod, sc]
try:
    import app.allocation as allocation  # noqa: E402
    MODS.append(allocation)
except ImportError:
    allocation = None
H.track_connections(*MODS)

ADMIN = user_row()
NOBODY = user_row("role != 'admin'")   # обычный пользователь; на КОПИИ у него забираются все выданные роли (reset) — значит, прав на объекте нет


def reset():
    """Свежая копия БД; у NOBODY нет ни одного гранта (отказ в правах воспроизводится стражами обработчиков)."""
    fresh_db()
    c = db()
    c.execute("DELETE FROM user_access WHERE user_id = ?", (NOBODY["id"],))
    c.commit()
    c.close()


FAILS = []
CASES = 0


def check(name, before, res, expect):
    """expect: код HTTP / 'exc' / 'ok'."""
    global CASES
    CASES += 1
    bad = []
    got = res[0]
    if got != expect:
        bad.append(f"исход {got!r}, ожидался {expect!r}: {res[1] if len(res) > 1 else ''}")
    bad += released()
    if not other_writer_ok():
        bad.append("другой писатель не смог начать транзакцию («database is locked»)")
    if expect != "ok" and H.checksum() != before:
        bad.append("после отказа изменились таблицы (частичные изменения)")
    H.TRACKED.clear()
    print(("  ✓ " if not bad else "  ✗ ") + name + (f" → {got}" if not bad else ""))
    for b in bad:
        print("      " + b)
        FAILS.append(f"{name}: {b}")


def prep_elements(n=4, remaining=3):
    c = db()
    pos, ids = H.find_position(c, n)
    H.make_room(c, pos, remaining)
    c.close()
    return pos, ids


def bulk(ids, cid):
    return BulkStatusUpdateIn(items=[BulkStatusItem(element_id=i, contract_id=cid) for i in ids], status=Status("contracting"))


def contract_body(pos):
    c = db()
    co = c.execute("SELECT * FROM contracts WHERE id = ?", (pos["contract_id"],)).fetchone()
    lines = [contracts_mod.ContractLineIn(element_type=r["element_type"], mark=r["mark"], quantity=r["quantity"])
             for r in c.execute("SELECT * FROM contract_lines WHERE contract_id = ?", (pos["contract_id"],))]
    c.close()
    return contracts_mod.ContractIn(specification_id=co["specification_id"], theme=co["theme"], is_archived=False, lines=lines, incidents=[], capacity=[])


def make_doc(skip=0):
    """Черновик замены поставщика: одно изделие с контракта A на контракт B (остаток в B есть)."""
    c = db()
    pos, ids = H.find_position(c, 4, skip=skip)
    a = pos["contract_id"]
    b = c.execute("SELECT co.id FROM contracts co JOIN specifications s ON s.id = co.specification_id JOIN agreements ag ON ag.id = s.agreement_id "
                  "WHERE ag.object_id = 1 AND co.is_archived = 0 AND co.id != ? ORDER BY co.id LIMIT 1", (a,)).fetchone()["id"]
    for cid, qty in ((a, 3), (b, 3)):
        c.execute("DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ? AND mark = ?", (cid, pos["element_type"], pos["mark"]))
        c.execute("INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (?, ?, ?, ?)", (cid, pos["element_type"], pos["mark"], qty))
    c.execute("UPDATE elements SET contract_id = ?, current_status = 'contracting' WHERE id = ?", (a, ids[0]))
    c.execute("INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (?, 'contracting', 'тест', ?)", (ids[0], a))
    c.commit()
    c.close()
    doc = sc.create_supplier_change(sc.SupplierChangeIn(object_id=1, doc_date="2026-09-21", from_contract_id=a, to_contract_id=b, element_ids=[ids[0]]), ADMIN)
    H.TRACKED.clear()
    return doc["id"], ids


class Boom(RuntimeError):
    pass


def boom(*a, **kw):
    raise Boom("сбой внутри операции")


def with_patch(obj, name, repl, fn):
    orig = getattr(obj, name)
    setattr(obj, name, repl)
    try:
        return fn()
    finally:
        setattr(obj, name, orig)


def lock_timeout(fn):
    """Чужая пишущая транзакция держит блокировку дольше busy_timeout (0,3 с) → чистый отказ."""
    old = appdb.BUSY_TIMEOUT_MS
    appdb.BUSY_TIMEOUT_MS = 300
    hold = sqlite3.connect(H.WORK, isolation_level=None, timeout=5)
    hold.execute("BEGIN IMMEDIATE")
    t0 = time.time()
    try:
        r = fn()
    finally:
        hold.execute("ROLLBACK")
        hold.close()
        appdb.BUSY_TIMEOUT_MS = old
    return r + (time.time() - t0,)[:0]


def run():
    handlers = {}
    # ---- update_contract
    def uc(name, mk):
        reset(); pos, ids = prep_elements(); before = H.checksum(); H.TRACKED.clear()
        return pos, ids, before

    print("update_contract")
    reset(); pos, ids = prep_elements(); before = H.checksum()
    check("update_contract: отказ в правах", before, call(contracts_mod.update_contract, pos["contract_id"], contract_body(pos), NOBODY), 403)
    check("update_contract: нет контракта", before, call(contracts_mod.update_contract, 99999999, contract_body(pos), ADMIN), 404)
    b = contract_body(pos)
    b.specification_id = 99999999
    check("update_contract: нет спецификации", before, call(contracts_mod.update_contract, pos["contract_id"], b, ADMIN), 404)
    check("update_contract: исключение внутри операции (после записи)", before,
          with_patch(contract_guard, "assert_no_regression", boom, lambda: call(contracts_mod.update_contract, pos["contract_id"], contract_body(pos), ADMIN)), "exc")
    check("update_contract: таймаут ожидания блокировки", before, lock_timeout(lambda: call(contracts_mod.update_contract, pos["contract_id"], contract_body(pos), ADMIN)), 503)

    print("update_status / update_status_bulk / set_element_contract")
    for label, fn, mk_args in (
        ("update_status", main.update_status, lambda ids, cid, u: (ids[0], StatusUpdateIn(status=Status("contracting"), contract_id=cid), u)),
        ("update_status_bulk", main.update_status_bulk, lambda ids, cid, u: (bulk([ids[0]], cid), u)),
    ):
        reset(); pos, ids = prep_elements(); before = H.checksum(); cid = pos["contract_id"]
        check(f"{label}: отказ в правах", before, call(fn, *mk_args(ids, cid, NOBODY)), 403)
        args404 = mk_args([99999999], cid, ADMIN)
        check(f"{label}: нет изделия", before, call(fn, *args404), 404)
        check(f"{label}: исключение внутри операции (после записи истории)", before,
              with_patch(contracts_mod, "recompute_status_and_actual_date", boom, lambda: call(fn, *mk_args(ids, cid, ADMIN))), "exc")
        check(f"{label}: таймаут ожидания блокировки", before, lock_timeout(lambda: call(fn, *mk_args(ids, cid, ADMIN))), 503)
    reset(); pos, ids = prep_elements(); c = db(); H.set_status(c, [ids[0]], "shipped"); c.close(); before = H.checksum(); cid = pos["contract_id"]
    body = main.ElementContractIn(contract_id=cid)
    check("set_element_contract: отказ в правах", before, call(main.set_element_contract, ids[0], body, NOBODY), 403)
    check("set_element_contract: нет изделия", before, call(main.set_element_contract, 99999999, body, ADMIN), 404)
    check("set_element_contract: исключение внутри операции", before, with_patch(main, "sync_element_contract", boom, lambda: call(main.set_element_contract, ids[0], body, ADMIN)), "exc")
    check("set_element_contract: таймаут ожидания блокировки", before, lock_timeout(lambda: call(main.set_element_contract, ids[0], body, ADMIN)), 503)

    print("post_supplier_change / unpost_supplier_change")
    reset(); doc_id, ids = make_doc(); before = H.checksum()
    check("post_supplier_change: отказ в правах", before, call(sc.post_supplier_change, doc_id, NOBODY), 403)
    check("post_supplier_change: нет документа", before, call(sc.post_supplier_change, 99999999, ADMIN), 404)
    check("post_supplier_change: исключение внутри операции (после записи)", before,
          with_patch(contract_guard, "assert_no_regression", boom, lambda: call(sc.post_supplier_change, doc_id, ADMIN)), "exc")
    check("post_supplier_change: таймаут ожидания блокировки", before, lock_timeout(lambda: call(sc.post_supplier_change, doc_id, ADMIN)), 503)
    r = call(sc.post_supplier_change, doc_id, ADMIN)
    H.TRACKED.clear(); before = H.checksum()
    check("unpost_supplier_change: отказ в правах", before, call(sc.unpost_supplier_change, doc_id, NOBODY), 403)
    check("unpost_supplier_change: нет документа", before, call(sc.unpost_supplier_change, 99999999, ADMIN), 404)
    check("unpost_supplier_change: исключение внутри операции (после записи)", before,
          with_patch(sc, "touch_elements", boom, lambda: call(sc.unpost_supplier_change, doc_id, ADMIN)), "exc")
    check("unpost_supplier_change: таймаут ожидания блокировки", before, lock_timeout(lambda: call(sc.unpost_supplier_change, doc_id, ADMIN)), 503)
    assert r[0] == "ok", r

    print("ошибка валидации (до открытия соединения)")
    n0 = len(H.TRACKED)
    try:
        contracts_mod.ContractIn(specification_id="не число", lines=[], incidents=[])
        FAILS.append("валидация: некорректное тело принято")
    except Exception as e:  # noqa: BLE001
        ok = type(e).__name__ == "ValidationError" and len(H.TRACKED) == n0 and other_writer_ok()
        print(("  ✓ " if ok else "  ✗ ") + "ContractIn с неверными типами → ValidationError, соединений не открыто, писатель свободен")
        if not ok:
            FAILS.append("валидация")

    if allocation is not None and hasattr(allocation, "ALLOCATION_LOCK_CASES"):
        allocation.ALLOCATION_LOCK_CASES(check, H)


if __name__ == "__main__":
    run()
    print(f"\nпроверок: {CASES}; нарушений: {len(FAILS)}")
    sys.exit(1 if FAILS else 0)
