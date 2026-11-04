"""Keep ready-for-installation elements fixed, including stale drafts.

Uses a temporary SQLite backup only. Run with data/zhbi.anon.db as argument.
"""
import os
import sqlite3
import sys
import tempfile
from datetime import date
from pathlib import Path

source = Path(sys.argv[1]).resolve()
work = tempfile.TemporaryDirectory(prefix="rebalance-ready-fixed-")
database = Path(work.name) / "copy.db"
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(database) as dst:
    src.backup(dst)
os.environ["ZHBI_DB_PATH"] = str(database)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException
from app import supplier_change as sc
from app.db import get_connection

conn = get_connection()
admin = conn.execute("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
oid = 1
candidates = sc._rebalance_candidates(conn, oid)
contract = max(candidates["contracts"], key=lambda c: c["changed"])
cid = contract["contract_id"]
mark = max(contract["marks"], key=lambda m: m["changed"])["mark"]
original = sc._rebalance_plan(conn, oid, cid, mark)
fixed = next(i["element_id"] for i in original["items"] if i["partner_id"])
ids = [i["element_id"] for i in original["items"]]
checks = 0


def check(condition, message):
    global checks
    assert condition, message
    checks += 1


def create(plan):
    return sc.create_supplier_change(sc.SupplierChangeIn(
        object_id=oid, kind=sc.KIND_REBALANCE, doc_date=date.today().isoformat(),
        from_contract_id=cid, to_contract_id=cid, mark=mark,
        element_ids=[i["element_id"] for i in plan["items"]]), admin)


def element_state(eid):
    return (tuple(conn.execute("SELECT * FROM elements WHERE id=?", (eid,)).fetchone()),
            [tuple(r) for r in conn.execute("SELECT * FROM status_history WHERE element_id=? ORDER BY id", (eid,))])


def document_state(did):
    return tuple(conn.execute("SELECT * FROM supplier_change_docs WHERE id=?", (did,)).fetchone()), [
        tuple(r) for r in conn.execute("SELECT * FROM supplier_change_items WHERE doc_id=? ORDER BY id", (did,))]


# This draft predates the status transition and must not move anything on posting.
stale = create(original)
conn.execute("INSERT INTO status_history(element_id,status,changed_by,changed_at,contract_id) "
             "SELECT id,'ready_for_installation','QA',"
             "COALESCE((SELECT datetime(MAX(changed_at),'+1 second') FROM status_history WHERE element_id=e.id),datetime('now')),"
             "contract_id FROM elements e WHERE id=?", (fixed,))
conn.execute("UPDATE elements SET current_status='ready_for_installation',planned_installation_date='2030-01-15' WHERE id=?", (fixed,))
conn.commit()
check(fixed in sc._history_consistent_ids(conn, [fixed]), "fixture has consistent history")
frozen = element_state(fixed)
row = dict(conn.execute("SELECT * FROM elements WHERE id=?", (fixed,)).fetchone())
for undated in (False, True):
    reason = sc._rebalance_eligible(row, cid, mark, undated)
    check(reason is not None and 'Готов к монтажу' in reason, "ready status must be blocked with an accurate reason")
    check(sc._rebalance_eligible({**row, 'planned_delivery_date': None}, cid, mark, undated) is not None, "undated option cannot enable ready elements")
for status in ('installed', 'accepted'):
    check(sc._rebalance_eligible({**row, 'current_status': status}, cid, mark, True) is not None, "later statuses remain blocked")
for status in ('shipped', 'delivered'):
    check(sc._rebalance_eligible({**row, 'current_status': status}, cid, mark, True) is None, "shipped/delivered remain eligible")

for contract_id, name, pool, undated in [(cid,mark,False,False), (cid,'',False,False),
        (None,'',False,False), (None,'',True,False), (None,'',True,True)]:
    plan = sc._rebalance_plan(conn, oid, contract_id, name, pool=pool, include_undated=undated)
    check(all(i['element_id'] != fixed and i['partner_id'] != fixed for i in plan['items']), "all scopes exclude both the ready element and its place")
    check(element_state(fixed) == frozen, "preview preserves fixed data")

# If only this ready element and its former partner are selected, nothing swaps.
partner = next(i['partner_id'] for i in original['items'] if i['element_id'] == fixed)
pair = sc._rebalance_plan(conn, oid, cid, mark, element_ids=[fixed,partner])
check(pair['summary']['moved'] == 0 and all(i['element_id'] != fixed for i in pair['items']), "fixed element cannot be a swap partner")
for undated in (False, True):
    refreshed = sc._rebalance_candidates(conn, oid, undated)
    plan = sc._rebalance_plan(conn, oid, cid, mark, include_undated=undated)
    selected = next((m for c in refreshed['contracts'] if c['contract_id']==cid for m in c['marks'] if m['mark']==mark), None)
    check((selected['changed'] if selected else 0) == plan['summary']['moved'], "candidate counts follow the same exclusion")

before = [element_state(eid) for eid in ids], document_state(stale['id'])
try:
    sc.post_supplier_change(stale['id'], admin, None)
    raise AssertionError('stale draft must refuse ready element')
except HTTPException as exc:
    check(exc.status_code == 409 and 'Готов к монтажу' in str(exc.detail), "posting rechecks current status")
check(([element_state(eid) for eid in ids], document_state(stale['id'])) == before, "posting refusal changes neither elements nor draft")

# A newly calculated document still balances the remaining elements normally.
fresh = sc._rebalance_plan(conn, oid, cid, mark)
check(fresh['summary']['moved'] > 0, "other elements still need balancing")
doc = create(fresh)
done = sc.post_supplier_change(doc['id'], admin, None)
check(done['moved'] > 0 and element_state(fixed) == frozen, "posting preserves fixed status, contract, dates and full history")
again = sc._rebalance_plan(conn, oid, cid, mark)
check(again['summary']['moved'] == 0, "remaining allocation stays idempotent")
sc.unpost_supplier_change(doc['id'], admin, None)
check(element_state(fixed) == frozen, "unposting a new document leaves fixed element untouched")
conn.close()
print(f'OK: {checks} checks on a temporary anonymized database')
work.cleanup()
