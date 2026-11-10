"""Montage facts share the status timeline; reads never rewrite old data."""
import hashlib
import json
from datetime import datetime, timedelta
from app.snz_policy import order_items


def status_montage(conn, object_id):
    rows=conn.execute("""
        SELECT e.id,e.current_status,l.id AS latest_id,l.changed_at AS latest_at,
               h.id AS history_id,h.changed_at,h.changed_by
        FROM elements e
        LEFT JOIN status_history l ON l.id=(SELECT x.id FROM status_history x
            WHERE x.element_id=e.id ORDER BY x.changed_at DESC,x.id DESC LIMIT 1)
        LEFT JOIN status_history h ON h.id=(SELECT s.id FROM status_history s
            WHERE s.element_id=e.id AND s.status IN ('installed','accepted')
            AND NOT EXISTS (SELECT 1 FROM status_history x WHERE x.element_id=e.id
                AND x.status NOT IN ('installed','accepted')
                AND (x.changed_at>s.changed_at OR (x.changed_at=s.changed_at AND x.id>s.id)))
            ORDER BY s.changed_at,s.id LIMIT 1)
        WHERE e.object_id=?
    """,(object_id,))
    result={}
    for row in rows:
        item=dict(row)
        item['completed_at']=None
        if item['current_status'] in ('installed','accepted') and item['changed_at']:
            try:item['completed_at']=datetime.fromisoformat(item['changed_at']).isoformat(timespec='seconds')
            except ValueError:pass
        item['expected_rev']=hashlib.sha256(json.dumps(item,sort_keys=True).encode()).hexdigest()
        result[item['id']]=item
    return result


def project_montage(state, statuses):
    assigned={a['element_id'] for a in state['assignments']}
    for eid,item in statuses.items():
        key=f'e:{eid}:install'
        if eid not in assigned and key not in state['facts']:continue
        old=state['facts'].get(key,{})
        if item['completed_at']:
            state['facts'][key]={**old,'completed':True,'completed_at':item['completed_at'],
                'completed_by':item['changed_by'],'status_history_id':item['history_id'],'source':'status_history'}
        elif old.get('status_history_id') or old.get('source')=='status_history':
            state['facts'].pop(key,None)
        elif old.get('completed') and item['latest_at']:
            # Preserve legacy SNZ-only marks unless a later status rolled them back.
            try:
                completed=datetime.fromisoformat(old['completed_at'])
                if len(old['completed_at'])==16:completed+=timedelta(minutes=1)
                if datetime.fromisoformat(item['latest_at'])>=completed:
                    state['facts'].pop(key,None)
            except (ValueError,KeyError):pass


def fact_rows(conn, object_id, state, statuses, day=None, shift=None, crew_id=None):
    grouped={}
    for row in conn.execute('SELECT id,work_date,shift,crew_id,snapshot_json FROM snz_orders WHERE object_id=? ORDER BY work_date,shift,id',(object_id,)):
        if day and row['work_date']!=day:continue
        if shift and row['shift']!=shift:continue
        if crew_id and row['crew_id']!=crew_id:continue
        order=json.loads(row['snapshot_json']);members=order_items(order)
        for task in order['tasks']:
            if task['operation_id']!='install':continue
            for eid in task['element_ids']:
                item=grouped.setdefault(eid,{**members[eid],'orders':[],
                    'task_key':task['key'] if task['element_ids']==[eid] else None})
                item['orders'].append({'id':row['id'],'date':row['work_date'],'shift':row['shift'],'crew':order['crew']['name']})
    for eid,item in grouped.items():
        status=statuses.get(eid,{})
        fact=state['facts'].get(item['task_key'],{})
        item.update(current_status=status.get('current_status',item.get('current_status')),
                    completed=bool(status.get('completed_at') or fact.get('completed')),completed_at=status.get('completed_at') or fact.get('completed_at'),
                    status_confirmed=status.get('current_status') in ('installed','accepted'),
                    expected_rev=status.get('expected_rev'))
    return list(grouped.values())
