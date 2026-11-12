"""Atomic montage input from the model: issued plan and extra fact together."""
import hashlib,json
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from app.snz_montage import fact_rows,status_montage,project_montage
from app.snz_fact_store import records


def candidates(conn,object_id,state,day,shift,crew_id,statuses=None):
    statuses=statuses if statuses is not None else status_montage(conn,object_id)
    if not any(c['id']==crew_id and c['kind']=='installation' for c in state['crews']):
        raise HTTPException(422,'Выберите монтажную бригаду.')
    rows={r['id']:r for r in fact_rows(conn,object_id,state,statuses,day)}
    active={r['id'] for r in conn.execute('SELECT id FROM elements WHERE object_id=? AND is_current=1',(object_id,))}
    result=[]
    for eid,status in statuses.items():
        if eid not in active:continue
        row=rows.get(eid,{});orders=row.get('orders',[]);extra=row.get('extra',[])
        item={'id':eid,'expected_rev':status['expected_rev'],'kind':'extra','reason':''}
        match=[r for r in orders if r['shift']==shift and r['crew_id']==crew_id]
        attributed=[r for r in extra if r['shift']==shift and r['crew_id']==crew_id and r['history_id']==status.get('history_id') and status.get('completed_at')]
        if orders:
            if not match:item.update(kind='blocked',reason='Изделие выдано в СНЗ другой смены или бригады этой даты.')
            elif any(r.get('closed_at') for r in match):item.update(kind='blocked',reason='СНЗ закрыт. Изменение факта запрещено.')
            elif not row.get('task_key'):item.update(kind='blocked',reason='В СНЗ нет операции монтажа изделия.')
            else:item.update(kind='order',order_id=match[0]['id'],task_key=row['task_key'])
        elif extra:
            item.update(kind='done' if attributed else 'blocked',reason='' if attributed else 'Изделие уже отнесено через «Доп. факт» этой даты.')
        if status['current_status'] in ('installed','accepted') and not status.get('completed_at'):
            item.update(kind='blocked',reason='В истории отсутствует время монтажа.')
        result.append(item)
    return result


def apply(conn,object_id,state,revision,body,user):
    from app import snz
    from app.contracts import apply_status_change
    from app.auth import audit_display_name
    payload=hashlib.sha256(body.model_dump_json(exclude={'revision'}).encode()).hexdigest()
    store=records(state,True);previous=store.get('model_requests',{}).get(body.request_id)
    if previous:
        if previous['payload_hash']!=payload:raise HTTPException(409,'Ключ отметки факта уже использован с другими параметрами.')
        return {**previous['result'],'revision':revision,'already_completed':True}
    snz._version(revision,body.revision)
    snz._unique([r.model_dump() for r in body.items],'element_id','Факт монтажа')
    statuses=status_montage(conn,object_id)
    eligible={r['id']:r for r in candidates(conn,object_id,state,body.date.isoformat(),body.shift,body.crew_id,statuses)}
    for item in body.items:
        row=eligible.get(item.element_id)
        if row is None:raise HTTPException(422,'Выбранное изделие отсутствует в актуальной модели этого объекта.')
        if row['kind']=='blocked':raise HTTPException(409,f"ID {item.element_id}: {row['reason']}")
        if row['expected_rev']!=item.expected_rev:raise HTTPException(409,'Статус изделия изменился. Нажмите «Обновить» перед записью.')
    now=body.completed_at or datetime.now(ZoneInfo('Europe/Moscow'))
    if now.tzinfo:now=now.astimezone(ZoneInfo('Europe/Moscow')).replace(tzinfo=None)
    now=now.replace(microsecond=0)
    start=datetime.combine(body.date,datetime.min.time()).replace(hour=8 if body.shift=='day' else 20)
    new=[r.element_id for r in body.items if statuses[r.element_id]['current_status'] not in ('installed','accepted')]
    if new and not start<=now<start+timedelta(hours=12):raise HTTPException(422,'Время монтажа не попадает в выбранные дату и смену. Уточните поле «Время».')
    elements={e['id']:e for e in snz._elements(conn,object_id)}
    installed=[];extras=[];orders=[]
    for item in body.items:
        eid=item.element_id;candidate=eligible[eid]
        if candidate['kind']=='order':
            snz._assert_open_order(conn,object_id,candidate['order_id'])
            snapshot=json.loads(conn.execute('SELECT snapshot_json FROM snz_orders WHERE id=? AND object_id=?',(candidate['order_id'],object_id)).fetchone()[0])
            if not any(t['key']==candidate['task_key'] and t['operation_id']=='install' and eid in t['element_ids'] for t in snapshot['tasks']):
                raise HTTPException(409,'В выбранном СНЗ нет операции монтажа этого изделия.')
            orders.append(candidate['order_id'])
        if eid in new:
            apply_status_change(conn,eid,'installed',False,None,now.isoformat(sep=' ',timespec='seconds'),
                                'Факт монтажа с модели СНЗ',audit_display_name(user),user['id'])
            if conn.execute('SELECT current_status FROM elements WHERE id=?',(eid,)).fetchone()[0] not in ('installed','accepted'):
                raise HTTPException(409,'После указанного времени есть другой статус. Проверьте историю изделия.')
            installed.append(eid)
        if candidate['kind']=='extra':extras.append(eid)
        state['facts'].setdefault(f'e:{eid}:install',{})
    statuses=status_montage(conn,object_id)
    if extras:
        crew=next(c for c in state['crews'] if c['id']==body.crew_id)
        store['extra']['model_'+body.request_id]={'date':body.date.isoformat(),'crew_id':crew['id'],'crew':crew,
            'payload_hash':payload,'created_by':audit_display_name(user),'created_at':now.isoformat(timespec='seconds'),
            'items':[{'element':elements[eid],'history_id':statuses[eid]['history_id'],'shift':body.shift} for eid in extras]}
    project_montage(state,statuses)
    result={'revision':revision+1,'installed':installed,'confirmed':[r.element_id for r in body.items],
            'extra':extras,'order_ids':sorted(set(orders)),
            'updates':[{'id':r.element_id,'current_status':statuses[r.element_id]['current_status']} for r in body.items]}
    store.setdefault('model_requests',{})[body.request_id]={'payload_hash':payload,'result':result}
    snz._write(conn,object_id,state,revision)
    snz.touch_elements(conn,[r.element_id for r in body.items])
    return result
