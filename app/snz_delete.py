"""Remove an issued order atomically while retaining its complete audit archive."""
import hashlib
import json
from fastapi import HTTPException
from app.db import touch_elements
from app.snz_order_edit import revise_order
from app.snz_policy import order_items


def delete_order(conn, object_id, order_id, body, author, load, write, version):
    payload = json.dumps(body.model_dump(mode='json'), ensure_ascii=False, sort_keys=True)
    request_hash = hashlib.sha256(payload.encode()).hexdigest()
    retry = conn.execute('SELECT order_id,request_hash FROM snz_deleted_orders WHERE object_id=? AND request_id=?', (object_id, body.request_id)).fetchone()
    if retry and (retry['order_id'] != order_id or retry['request_hash'] != request_hash):
        raise HTTPException(409, 'Этот запрос уже использован для другого удаления СНЗ.')
    archived = conn.execute('SELECT result_json FROM snz_deleted_orders WHERE object_id=? AND order_id=?', (object_id, order_id)).fetchone()
    state, revision = load(conn, object_id)
    if archived:
        return {**json.loads(archived[0]), 'revision': revision, 'already_deleted': True}
    row = conn.execute('SELECT * FROM snz_orders WHERE object_id=? AND id=?', (object_id, order_id)).fetchone()
    if not row:
        raise HTTPException(404, 'СНЗ не найден.')
    version(revision, body.revision)
    order = json.loads(row['snapshot_json'])
    if order.get('order_revision', 1) != body.order_revision:
        raise HTTPException(409, 'Редакция СНЗ изменилась. Обновите реестр перед удалением.')
    history = [(r['id'], json.loads(r['snapshot_json'])) for r in conn.execute('SELECT id,snapshot_json FROM snz_orders WHERE object_id=?', (object_id,))]
    current_ids = set(order_items(order))
    if current_ids:
        try:
            revise_order(order, state['facts'], sorted(current_ids), [snapshot for _, snapshot in history])
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
    revisions = [dict(r) for r in conn.execute('SELECT * FROM snz_order_revisions WHERE object_id=? AND order_id=? ORDER BY revision', (object_id, order_id))]
    # Empty edited documents still remember their removed members. Include old
    # revisions for compatibility with any previously issued edited snapshot.
    members = current_ids | set(order.get('excluded_element_ids', []))
    for item in revisions:
        snapshot = json.loads(item['snapshot_json'])
        members.update(order_items(snapshot))
        members.update(snapshot.get('excluded_element_ids', []))
    kept_in_orders = {}
    for oid, snapshot in history:
        if oid == order_id:
            continue
        for eid in members.intersection(order_items(snapshot)):
            kept_in_orders.setdefault(str(eid), set()).add(oid)
    released_ids = members - {int(eid) for eid in kept_in_orders}
    released = sorted(released_ids)
    # An item excluded earlier may already have a new, unissued assignment.
    # Clear only assignments still belonging to the document being deleted.
    cleared = {a['element_id'] for a in state['assignments'] if a['element_id'] in released_ids
               and (a['date'], a['shift'], a['crew_id']) == (row['work_date'], row['shift'], row['crew_id'])}
    state['assignments'] = [a for a in state['assignments'] if a['element_id'] not in cleared]
    result = {'id': order_id, 'revision': revision + 1, 'released_element_ids': released,
              'cleared_element_ids': sorted(cleared), 'kept_in_orders': {eid: sorted(ids) for eid, ids in kept_in_orders.items()}}
    conn.execute('INSERT INTO snz_deleted_orders(order_id,object_id,order_json,revisions_json,result_json,created_by,request_id,request_hash) VALUES (?,?,?,?,?,?,?,?)',
                 (order_id, object_id, json.dumps(dict(row), ensure_ascii=False), json.dumps(revisions, ensure_ascii=False), json.dumps(result), author, body.request_id, request_hash))
    conn.execute('DELETE FROM snz_orders WHERE object_id=? AND id=?', (object_id, order_id))
    # Do not rely on FK pragmas in maintenance/test connections for the archive.
    conn.execute('DELETE FROM snz_order_revisions WHERE object_id=? AND order_id=?', (object_id, order_id))
    for eid in cleared:
        conn.execute('UPDATE elements SET planned_installation_date=NULL WHERE object_id=? AND id=?', (object_id, eid))
    touch_elements(conn, cleared)
    write(conn, object_id, state, revision)
    return result
