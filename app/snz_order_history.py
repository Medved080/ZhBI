"""Immutable document versions and readable, adjacent-version changes."""
import json
from copy import deepcopy
from datetime import datetime
from zoneinfo import ZoneInfo
from app.snz_policy import order_items


def normalized_time(value):
    if not value:return None
    stamp=datetime.fromisoformat(value)
    if stamp.tzinfo:stamp=stamp.astimezone(ZoneInfo('Europe/Moscow')).replace(tzinfo=None)
    return stamp.isoformat(timespec='seconds')


def positions(order, facts=None):
    facts = facts if facts is not None else order.get('version_facts', {})
    saved = {p['element_id']:p for p in order.get('editor_positions', [])}
    result = []
    for eid in order_items(order):
        previous = saved.get(eid, {})
        prior = {s['operation_id']:s for s in previous.get('steps', [])}
        steps = []
        for task in order['tasks']:
            if eid not in task['element_ids']:continue
            fact = facts.get(task['key'], {})
            steps.append({'operation_id':task['operation_id'], 'minutes':task['norm_minutes'],
                'wait_after':task.get('wait_after',0), 'team_id':task['team_id'],
                'planned_start':normalized_time(prior.get(task['operation_id'],{}).get('planned_start')),
                'completed':bool(fact.get('completed')), 'completed_at':normalized_time(fact.get('completed_at'))})
        result.append({'element_id':eid, 'card_id':previous.get('card_id'),
            'priority':order.get('item_priorities',{}).get(str(eid),len(result)+1), 'steps':steps})
    return sorted(result,key=lambda p:p['priority'])


def changes(before, after):
    """Compare effective contents, never transient revision/fingerprint metadata."""
    result=[];old=order_items(before) if before else {};new=order_items(after)
    def add(eid,field,left,right,operation=''):
        if left==right:return
        result.append({'element_id':eid,'mark':(new.get(eid) or old.get(eid) or {}).get('mark',str(eid)),
                       'operation':operation,'field':field,'before':left,'after':right})
    for eid in sorted(old.keys() ^ new.keys()):add(eid,'Позиция','В составе' if eid in old else None,'В составе' if eid in new else None)
    bp={p['element_id']:p for p in positions(before)} if before else {}
    ap={p['element_id']:p for p in positions(after)}
    names={t['operation_id']:t['operation'] for o in [before,after] if o for t in o['tasks']}
    def description(p):
        if p is None:return None
        return 'Очередь: '+str(p['priority'])+'; карта: '+str(p['card_id'] or 'ручные показатели')+'; '+ '; '.join(
            f"{names.get(step['operation_id'],step['operation_id'])}: норматив {step['minutes'] if step['minutes'] is not None else 'не задан'} мин, звено {step['team_id']}, техперерыв {step['wait_after']} мин, факт {'100 %' if step['completed'] else '0 %'}"+(f", {step['completed_at']}" if step.get('completed_at') else '') for step in p['steps'])
    for eid in sorted(old.keys() ^ new.keys()):add(eid,'Показатели позиции',description(bp.get(eid)),description(ap.get(eid)))
    for eid in sorted(old.keys() & new.keys()):
        for key,label in [('card_id','Карта'),('priority','Очередность')]:
            if key=='card_id' and 'editor_positions' not in before:continue
            left=bp[eid][key];right=ap[eid][key]
            add(eid,label,before.get('card_names',{}).get(left,left) if key=='card_id' else left,after.get('card_names',{}).get(right,right) if key=='card_id' else right)
        bs={s['operation_id']:s for s in bp[eid]['steps']};ss={s['operation_id']:s for s in ap[eid]['steps']}
        for op in sorted(bs.keys() | ss.keys()):
            name=names.get(op,op)
            if op not in bs or op not in ss:
                add(eid,'Операция','В составе' if op in bs else None,'В составе' if op in ss else None,name)
            # Facts on added/removed operations must also appear in the audit.
            for key,label in [('minutes','Норматив, мин'),('wait_after','Техперерыв, мин'),('team_id','Звено'),
                              ('planned_start','Начать не ранее'),('completed','Факт выполнения'),('completed_at','Время факта')]:
                if key in ('completed','completed_at') and 'version_facts' not in before:continue
                left=bs.get(op,{}).get(key);right=ss.get(op,{}).get(key)
                if key=='team_id':
                    left=next((t['team'] for t in before['tasks'] if t['team_id']==left),left)
                    right=next((t['team'] for t in after['tasks'] if t['team_id']==right),right)
                add(eid,label,left,right,name)
    def timing(order,eid):
        return {t['operation_id']:[(s['start'],s['end']) for s in t['segments']] for t in order['tasks'] if eid in t['element_ids']}
    for eid in sorted(old.keys() & new.keys()):
        a=timing(before,eid);b=timing(after,eid)
        for op in sorted(a.keys() & b.keys()):add(eid,'Плановое время',a[op],b[op],names.get(op,op))
    if not before:result=[{'element_id':None,'mark':'','operation':'','field':'Документ','before':None,'after':'Первоначальная выдача'}]
    return result


def freeze(order,facts,closure=None):
    snapshot=deepcopy(order);snapshot.pop('facts',None);snapshot.pop('current_revision',None)
    snapshot['version_facts']={t['key']:deepcopy(facts.get(t['key'],{})) for t in snapshot['tasks']}
    snapshot['version_closure']=deepcopy(closure)
    return snapshot


def history(conn,object_id,order_id):
    current=conn.execute('SELECT * FROM snz_orders WHERE object_id=? AND id=?',(object_id,order_id)).fetchone()
    if current is None:return []
    rows=[dict(r) for r in conn.execute('SELECT revision,reason,created_at,created_by,snapshot_json FROM snz_order_revisions WHERE object_id=? AND order_id=? ORDER BY revision',(object_id,order_id))]
    snapshot=json.loads(current['snapshot_json']);revision=snapshot.get('order_revision',1)
    if not any(r['revision']==revision for r in rows):
        rows.append({'revision':revision,'reason':snapshot.get('edit_reason','Первоначальная выдача'),
            'created_at':snapshot.get('edited_at',current['created_at']),'created_by':snapshot.get('edited_by',current['created_by']),
            'snapshot_json':current['snapshot_json']})
    rows.sort(key=lambda r:r['revision']);previous=None
    for row in rows:
        order=json.loads(row.pop('snapshot_json'));row['changes']=changes(previous,order)
        row['previous_revision']=previous.get('order_revision',1) if previous else None
        row['facts_recorded']='version_facts' in order
        row['facts_captured_at']=order.get('version_facts_captured_at')
        previous=order
    return rows[::-1]
