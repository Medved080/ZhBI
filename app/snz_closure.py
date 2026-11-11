"""Close issued montage orders without rewriting their snapshots or later historical facts."""
import hashlib
import json
from copy import deepcopy
from app.snz_fact_store import records
from app.snz_policy import order_items
from app.snz_montage import status_montage
from fastapi import HTTPException


def assert_previous_orders_closed(conn, object_id, day, shift, crew_id, ignore_fact):
    """Normal issuance requires closure; explicit advance planning keeps its exception."""
    if ignore_fact:return
    closed=closed_orders(conn,object_id)
    pending=[]
    for row in conn.execute("SELECT id,snapshot_json FROM snz_orders WHERE object_id=? AND crew_id=? "
                            "AND (work_date<? OR (work_date=? AND shift='day' AND ?='night')) ORDER BY work_date,id",
                            (object_id,crew_id,day,day,shift)):
        if str(row['id']) in closed:continue
        if json.loads(row['snapshot_json'])['crew'].get('kind')=='preparation':continue
        pending.append(row['id'])
    if pending:raise HTTPException(409,'Перед выдачей закройте предыдущие СНЗ этой бригады на вкладке «Факт»: № '+', '.join(map(str,pending))+'. Для выдачи нескольких смен заранее используйте «Не учитывать факт».')


def closed_orders(conn, object_id):
    row=conn.execute('SELECT data_json FROM snz_state WHERE object_id=?',(object_id,)).fetchone()
    return records(json.loads(row[0])).get('closed',{}) if row else {}


def close_scope(conn, object_id, state, day=None, shift=None, crew_id=None):
    closed=records(state).get('closed',{});orders=[]
    for row in conn.execute('SELECT id,work_date,shift,crew_id,snapshot_json FROM snz_orders WHERE object_id=? ORDER BY work_date,shift,id',(object_id,)):
        if str(row['id']) in closed:continue
        if day and row['work_date']!=day:continue
        if shift and row['shift']!=shift:continue
        if crew_id and row['crew_id']!=crew_id:continue
        order=json.loads(row['snapshot_json'])
        if order['crew'].get('kind')=='preparation':continue
        orders.append({**order,'id':row['id']})
    statuses=status_montage(conn,object_id)
    ids={eid for order in orders for eid in order_items(order)}
    pending=sorted(eid for eid in ids if eid in statuses and statuses[eid]['current_status'] not in ('installed','accepted'))
    digest={'orders':orders,'status_revisions':{str(eid):statuses.get(eid,{}).get('expected_rev') for eid in sorted(ids)}}
    fingerprint=hashlib.sha256(json.dumps(digest,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return {'orders':orders,'order_ids':[o['id'] for o in orders],'order_count':len(orders),
            'pending_element_ids':pending,'fingerprint':fingerprint,'statuses':statuses}


def closure_projection(order, closure):
    if not closure:return order
    result=deepcopy(order)
    result.update(closed_at=closure['closed_at'],closed_by=closure['closed_by'])
    for e in list(result.get('items',[]))+[e for t in result['tasks'] for e in t['elements']]:
        if str(e['id']) in closure['rows']:e['current_status']=closure['rows'][str(e['id'])]['current_status']
    return result
