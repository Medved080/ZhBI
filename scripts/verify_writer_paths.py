"""Аудит писателей, которые могут менять привязки изделий к контрактам или доступное количество: защищены ли они от чтения устаревшего состояния.

Критерий — «блокировка записи первым действием»: на КАЖДОМ соединении, открытом обработчиком, первое выражение (кроме PRAGMA) — `BEGIN IMMEDIATE`;
до него не выполняется ни одного чтения. Проверяется трассой SQL (sqlite3.set_trace_callback) при вызове самих обработчиков на КОПИИ обезличенной БД:
вызов идёт в путь отказа, достижимый уже после начала транзакции (несуществующая запись и т.п.), поэтому ничего не меняется.
Дополнительно: при занятой БД каждый писатель отвечает 503 и не оставляет изменений.

Запуск: .venv/bin/python scripts/verify_writer_paths.py <копия_БД>
"""

import io

import _guard_harness as H  # noqa: I001
from _guard_harness import call, db, other_writer_ok, released, user_row

import sqlite3
import sys
import time

import app.db as appdb
import app.main as main
from app import contracts as contracts_mod
from app import dict_delete
from app import supplier_change as sc
from app.models import BulkStatusItem, BulkStatusUpdateIn, Status, StatusUpdateIn

MODS = [main, contracts_mod, sc, dict_delete]
try:
    import app.allocation as allocation
    MODS.append(allocation)
except ImportError:
    allocation = None
H.track_connections(*MODS)
ADMIN = user_row()
FAILS = []


class FakeUpload:
    filename = "x.xlsx"

    def __init__(self, data=b"not xlsx"):
        self.file = io.BytesIO(data)


def _import_stub():
    """Файл-заглушка: разбор подменяется, чтобы путь дошёл до БД (сам разбор от БД не зависит и стоит до блокировки)."""
    orig = main.parse_contracting_xlsx
    main.parse_contracting_xlsx = lambda content: {}
    try:
        return main.import_contracting_xlsx(FakeUpload(), 99999999, ADMIN)
    finally:
        main.parse_contracting_xlsx = orig


def paths():
    """(название, вызов, в чём защита) — обработчики, меняющие привязку/статус изделия или количество позиции."""
    c = db()
    pos, ids = H.find_position(c, 2)
    cid = pos["contract_id"]
    c.close()
    P = [
        ("PATCH /elements/{id}/status (update_status)", lambda: main.update_status(99999999, StatusUpdateIn(status=Status("contracting"), contract_id=cid), ADMIN), "блокировка + страж"),
        ("PATCH /elements/bulk-status (update_status_bulk)", lambda: main.update_status_bulk(BulkStatusUpdateIn(items=[BulkStatusItem(element_id=99999999, contract_id=cid)], status=Status("contracting")), ADMIN), "блокировка + страж"),
        ("PATCH /elements/{id}/contract (set_element_contract)", lambda: main.set_element_contract(99999999, main.ElementContractIn(contract_id=cid), ADMIN), "блокировка + страж"),
        ("PATCH /contracts/{id} (update_contract)", lambda: contracts_mod.update_contract(99999999, contracts_mod.ContractIn(specification_id=1, lines=[], incidents=[], capacity=[]), ADMIN), "блокировка + сверка «до/после»"),
        ("POST /supplier-changes/{id}/post", lambda: sc.post_supplier_change(99999999, ADMIN), "блокировка + сверка «до/после»"),
        ("POST /supplier-changes/{id}/unpost", lambda: sc.unpost_supplier_change(99999999, ADMIN), "блокировка"),
        ("PATCH /elements/{id}/fields (update_element_fields)", lambda: main.update_element_fields(99999999, {}, False, ADMIN), "блокировка (сам путь только предупреждает о марке вне спецификации — не запрет)"),
        ("PATCH /elements/{id}/history/{hid} (update_history_entry)", lambda: main.update_history_entry(99999999, 1, {"comment": "x"}, ADMIN), "блокировка"),
        ("DELETE /elements/{id}/history/{hid} (delete_history_entry)", lambda: main.delete_history_entry(99999999, 1, ADMIN), "блокировка"),
        ("POST /bulk-edit/apply (массовая правка Excel)", lambda: main.bulk_edit_apply(main.BulkEditApplyIn(changes=[{"element_id": 99999999}], mode="contracting"), ADMIN), "блокировка + страж (link_problem в contracting_bulk_edit)"),
        ("POST /import-contracting-xlsx (импорт контрактации)", lambda: _import_stub(), "блокировка (разбор файла — до неё); проверки «до/после» в самом импорте нет"),
        ("POST /dictionaries/{kind}/{key}/delete (замена записи справочника)", lambda: dict_delete.delete_entry("contract", "99999999", dict_delete.DeleteIn(), ADMIN), "блокировка + сверка «до/после»"),
    ]
    if allocation is not None:
        P.append(("POST /contracts/{id}/allocations (allocate)", lambda: allocation.allocate(99999999, allocation.AllocationIn(
            object_id=1, element_type="x", mark=None, items=[allocation.AllocationItem(element_id=1, expected_status="planned")]), ADMIN), "блокировка + страж остатка + сверка состояния"))
    return P


def first_statement_ok(idx):
    """Первое не-PRAGMA выражение соединения — BEGIN IMMEDIATE (или выражений нет вовсе: до блокировки ничего не читалось)."""
    sts = [sql for i, sql in H.TRACE if i == idx]
    return (not sts) or sts[0].strip().upper().startswith("BEGIN IMMEDIATE"), sts[:2]


def main_run():
    print("A. блокировка записи — первым действием (трасса SQL)")
    rows = []
    for name, fn, what in paths():
        H.TRACKED.clear(); H.TRACE.clear()
        r = call(fn)
        ok, head = True, []
        for i in range(len(H.TRACKED)):
            o, h = first_statement_ok(i)
            ok = ok and o
            head = head or h
        if not H.TRACKED:
            ok, head = False, ["соединение не открывалось — путь не достигнут"]
        bad = released()
        good = ok and not bad
        print(("  ✓ " if good else "  ✗ ") + name + f" [{r[0]}]" + ("" if good else f"  первые выражения: {head} {bad}"))
        if not good:
            FAILS.append(name)
        rows.append((name, what, good))
    print("\nB. занятая БД: 503 без изменений")
    old = appdb.BUSY_TIMEOUT_MS
    for name, fn, what in paths():
        H.TRACKED.clear()
        before = H.checksum()
        appdb.BUSY_TIMEOUT_MS = 300
        hold = sqlite3.connect(H.WORK, isolation_level=None, timeout=5)
        hold.execute("BEGIN IMMEDIATE")
        r = call(fn)
        hold.execute("ROLLBACK"); hold.close()
        appdb.BUSY_TIMEOUT_MS = old
        good = r[0] == 503 and H.checksum() == before and not released() and other_writer_ok()
        print(("  ✓ " if good else "  ✗ ") + name + f" → {r[0]}" + ("" if good else f" {r[1] if len(r) > 1 else ''} {released()}"))
        if not good:
            FAILS.append(name + " (503)")
    print("\nСводка защиты:")
    for name, what, good in rows:
        print(f"  {'ЗАЩИЩЁН' if good else 'НЕ ЗАЩИЩЁН':10} {name}: {what}")
    print(f"\nнарушений: {len(FAILS)}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main_run()
