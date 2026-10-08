# -*- coding: utf-8 -*-
"""Проверка «провести → отменить проведение» у документа «Балансировка поставки»: ВСЁ возвращается как было.

Работает на КОПИИ базы: указанный файл не изменяется (сначала снимается копия средствами SQLite во временный каталог).
Сценарий на каждый охват (все контракты × все марки, то же с общим пулом, один контракт × все марки, один контракт × одна марка):

  1. снимок ВСЕХ таблиц;
  2. создать черновик → провести (должны смениться даты, статусы и контракты изделий);
  3. отрицательная проверка: после проведения «чужая» запись в истории изделия — отмена обязана отказать (409) и ничего не менять;
  4. убрать «чужую» запись → отменить проведение → удалить черновик;
  5. снимок ВСЕХ таблиц и построчное сравнение с первым.

Допустимые различия (ожидаемо, это журнал и служебные метки): `activity_log` (дописаны события), `sqlite_sequence` (счётчики
автонумерации), `elements.updated_at` (метка последнего изменения — по ней клиенты узнают об изменениях, её возвращать нельзя).
Всё остальное обязано совпасть. Код возврата 0 — совпало, 1 — есть расхождения.

  .venv312/bin/python scripts/verify_rebalance_roundtrip.py data/zhbi.anon.db [object_id]
  .venv312/bin/python scripts/verify_rebalance_roundtrip.py /путь/к/копии_боевой_базы.db 1
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IGNORED_TABLES = {"activity_log", "sqlite_sequence"}
IGNORED_COLUMNS = {("elements", "updated_at")}


def snapshot(path: str) -> dict:
    """Все строки всех таблиц: {таблица: (колонки, {первичный ключ или rowid: кортеж значений})}."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    out = {}
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").fetchall():
        info = conn.execute(f"PRAGMA table_info({name})").fetchall()
        cols = [r[1] for r in info]
        pk_cols = [r[1] for r in info if r[5] > 0]
        rows = {}
        for r in conn.execute(f"SELECT rowid AS _rid, * FROM {name}"):
            rows[r[pk_cols[0]] if len(pk_cols) == 1 else r["_rid"]] = tuple(r[c] for c in cols)
        out[name] = (cols, rows)
    conn.close()
    return out


def diff(before: dict, after: dict) -> list:
    problems = []
    for name in sorted(set(before) | set(after)):
        if name in IGNORED_TABLES:
            continue
        if name not in before or name not in after:
            problems.append(f"{name}: таблица есть не в обоих снимках")
            continue
        cols, a = before[name]
        _, b = after[name]
        skip = {i for i, c in enumerate(cols) if (name, c) in IGNORED_COLUMNS}
        added, removed = set(b) - set(a), set(a) - set(b)
        changed = []
        for k in set(a) & set(b):
            ra = tuple(v for i, v in enumerate(a[k]) if i not in skip)
            rb = tuple(v for i, v in enumerate(b[k]) if i not in skip)
            if ra != rb:
                changed.append(k)
        if added or removed or changed:
            line = f"{name}: добавлено {len(added)}, удалено {len(removed)}, изменено {len(changed)}"
            for k in sorted(changed)[:3]:
                diffs = [f"{cols[i]}: {a[k][i]!r} → {b[k][i]!r}" for i in range(len(cols)) if i not in skip and a[k][i] != b[k][i]]
                line += f"\n    id={k}: " + "; ".join(diffs)
            problems.append(line)
    return problems


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = os.path.abspath(sys.argv[1])
    tmp = tempfile.mkdtemp(prefix="rb_roundtrip_")
    work = os.path.join(tmp, "copy.db")
    s, d = sqlite3.connect(src), sqlite3.connect(work)
    s.backup(d)
    s.close()
    d.close()
    os.environ["ZHBI_DB_PATH"] = work
    sys.path.insert(0, REPO)
    from fastapi import HTTPException
    from app.db import get_connection
    from app import supplier_change as sc

    conn = get_connection()
    conn.row_factory = sqlite3.Row
    admin = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    if admin is None:
        print("В базе нет пользователя с ролью admin")
        return 2
    oid = int(sys.argv[2]) if len(sys.argv) > 2 else conn.execute("SELECT id FROM objects ORDER BY id LIMIT 1").fetchone()["id"]
    cands = sc._rebalance_candidates(conn, oid)
    if not cands["contracts"]:
        print("Балансировать нечего: на объекте нет контрактов с обменами — проверка не имеет смысла")
        return 2
    big = max(cands["contracts"], key=lambda c: c["changed"])
    big_mark = max(big["marks"], key=lambda m: m["changed"])["mark"]
    scopes = [
        ("все контракты × все марки", dict(all_contracts=True, all_marks=True, pool=False), None, ""),
        ("все контракты × все марки, общий пул", dict(all_contracts=True, all_marks=True, pool=True), None, ""),
        (f"один контракт ({big['name'][:40]}) × все марки", dict(all_contracts=False, all_marks=True, pool=False), big["contract_id"], ""),
        (f"один контракт × одна марка ({big_mark})", dict(all_contracts=False, all_marks=False, pool=False), big["contract_id"], big_mark),
    ]
    bad = 0
    for title, flags, contract_id, mark in scopes:
        print(f"\n=== {title}")
        before = snapshot(work)
        plan = sc._rebalance_plan(conn, oid, contract_id, mark, None, flags["pool"])
        sm = plan["summary"]
        print(f"  план: изделий {sm['count']}, затронуто {sm['moved']} ({sm['pairs']} пар, {sm['chains']} цепочек), "
              f"просрочено {sm['late_before']} → {sm['late_after']}, дней {sm['late_days_before']} → {sm['late_days_after']}")
        body = sc.SupplierChangeIn(
            object_id=oid, kind=sc.KIND_REBALANCE, doc_date=date.today().isoformat(),
            from_contract_id=contract_id or 0, to_contract_id=contract_id or 0, mark=mark or None,
            element_ids=[i["element_id"] for i in plan["items"]], **flags)
        doc = sc.create_supplier_change(body, admin)
        done = sc.post_supplier_change(doc["id"], admin, None)
        mid = snapshot(work)
        changed_mid = diff(before, mid)
        print(f"  проведён: затронуто {done['moved']} изд. ({done['pairs']} пар, {done['chains']} цепочек); таблиц изменено: {len(changed_mid)}")
        if done["moved"] and not any(p.startswith("elements:") for p in changed_mid):
            print("  ✗ проведение ничего не изменило в elements")
            bad += 1
        # отрицательная проверка: после проведения у изделия появилась «чужая» запись истории — отмена обязана отказать
        moved = conn.execute("SELECT element_id FROM supplier_change_items WHERE doc_id = ? AND pair_no IS NOT NULL ORDER BY id LIMIT 1",
                             (doc["id"],)).fetchone()
        if moved is not None:
            conn.execute("INSERT INTO status_history (element_id, status, changed_by, comment) "
                         "SELECT id, current_status, 'проверка', 'чужая правка после проведения' FROM elements WHERE id = ?",
                         (moved["element_id"],))
            conn.commit()
            frozen = snapshot(work)
            try:
                sc.unpost_supplier_change(doc["id"], admin, None)
                print("  ✗ отмена НЕ отказала при чужой правке после проведения")
                bad += 1
            except HTTPException as e:
                after_refuse = snapshot(work)
                same = not diff(frozen, after_refuse)
                print(f"  отмена при чужой правке: отказ {e.status_code}, база не тронута: {'да' if same else 'НЕТ'}")
                if e.status_code != 409 or not same:
                    bad += 1
            conn.execute("DELETE FROM status_history WHERE comment = 'чужая правка после проведения'")
            conn.commit()
        sc.unpost_supplier_change(doc["id"], admin, None)
        sc.delete_supplier_change(doc["id"], admin)
        problems = diff(before, snapshot(work))
        if problems:
            bad += 1
            print("  ✗ ПОСЛЕ ОТМЕНЫ ЕСТЬ РАСХОЖДЕНИЯ С ИСХОДНЫМ СОСТОЯНИЕМ:")
            for p in problems:
                print("   ", p)
        else:
            print("  ✓ после отмены все таблицы (кроме журнала и метки updated_at) совпадают с исходными")
    # Принудительная отмена (2026-10-08): после проведения изделия правили (контракт, плановая дата, чужая запись истории — как после
    # загрузки данных с другого сервера); обычная отмена отказывает, с force_conflicts — проходит, и контракт и плановая дата ВСЕХ
    # изделий возвращаются к исходным.
    print("\n=== принудительная отмена после чужих правок")
    contract_id, mark = None, ""
    before_el = {r["id"]: (r["contract_id"], r["planned_delivery_date"]) for r in conn.execute("SELECT id, contract_id, planned_delivery_date FROM elements")}
    plan = sc._rebalance_plan(conn, oid, contract_id, mark, None, False)
    body = sc.SupplierChangeIn(
        object_id=oid, kind=sc.KIND_REBALANCE, doc_date=date.today().isoformat(), from_contract_id=0, to_contract_id=0,
        mark=None, element_ids=[i["element_id"] for i in plan["items"]], all_contracts=True, all_marks=True, pool=False)
    doc = sc.create_supplier_change(body, admin)
    done = sc.post_supplier_change(doc["id"], admin, None)
    items = [r["element_id"] for r in conn.execute("SELECT element_id FROM supplier_change_items WHERE doc_id = ? AND pair_no IS NOT NULL", (doc["id"],))]
    if not items:
        print("  изделий в обмене нет — сценарий пропущен")
    else:
        # правки «после проведения»: чужая запись истории и сдвиг плановой даты у первого изделия
        conn.execute("INSERT INTO status_history (element_id, status, changed_by, comment) "
                     "SELECT id, current_status, 'проверка', 'чужая правка после проведения' FROM elements WHERE id = ?", (items[0],))
        conn.execute("UPDATE elements SET planned_delivery_date = '2099-01-01' WHERE id = ?", (items[-1],))
        conn.commit()
        try:
            sc.unpost_supplier_change(doc["id"], admin, None)
            print("  ✗ обычная отмена НЕ отказала")
            bad += 1
        except HTTPException as e:
            print(f"  обычная отмена: отказ {e.status_code}")
            if e.status_code != 409:
                bad += 1
        res = sc.unpost_supplier_change(doc["id"], admin, sc.DocActionIn(force_conflicts=True))
        head = conn.execute("SELECT status FROM supplier_change_docs WHERE id = ?", (doc["id"],)).fetchone()
        after_el = {r["id"]: (r["contract_id"], r["planned_delivery_date"]) for r in conn.execute("SELECT id, contract_id, planned_delivery_date FROM elements")}
        wrong = [i for i in before_el if before_el[i] != after_el.get(i)]
        print(f"  принудительная отмена: документ «{head['status']}», изделий возвращено {res['elements']}, расхождений контракта/даты: {len(wrong)}")
        if head["status"] != sc.DRAFT or wrong:
            bad += 1
        sc.delete_supplier_change(doc["id"], admin)
    conn.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print("\nИТОГ:", "всё возвращается к исходному состоянию" if not bad else f"ЕСТЬ ПРОБЛЕМЫ ({bad})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
