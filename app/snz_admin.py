"""Administrative amendments of issued SNZ, including facts and closed orders."""
import hashlib,json
from copy import deepcopy
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from fastapi import APIRouter,Depends,HTTPException
from pydantic import BaseModel,ConfigDict,Field
from app import activity
from app.access import assert_object_feature,is_system_admin
from app.auth import get_current_user,audit_display_name
from app.db import get_connection,begin_write,touch_elements
from app.snz_core import fragments
from app.snz_policy import order_items,montage_warnings
from app.snz_fact_store import records
from app.snz_montage import status_montage,project_montage
from app.snz_order_history import positions,changes,freeze

router=APIRouter()
KEY=r'^[a-zA-Z0-9_-]{1,64}$'


class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid')


class AdminStep(Strict):
    operation_id:str=Field(pattern=KEY)
    minutes:int|None=Field(default=None,ge=1,le=43200)
    wait_after:int=Field(default=0,ge=0,le=43200)
    team_id:str=Field(pattern=KEY)
    planned_start:datetime|None=None
    completed:bool=Field(default=False,strict=True)
    completed_at:datetime|None=None


class AdminPosition(Strict):
    element_id:int=Field(gt=0)
    card_id:str|None=Field(default=None,pattern=KEY)
    priority:int=Field(ge=1,le=1000000)
    steps:list[AdminStep]=Field(max_length=100)


class AdminPreviewIn(Strict):
    revision:int=Field(ge=0)
    order_revision:int=Field(ge=1)
    positions:list[AdminPosition]=Field(max_length=2000)
    reason:str=Field(min_length=1,max_length=1000)


class AdminSaveIn(AdminPreviewIn):
    request_id:str=Field(pattern=KEY)
    expected_hash:str=Field(pattern=r'^[0-9a-f]{64}$')


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def local(value):
    if value is None:return None
    when=datetime.fromisoformat(str(value)) if not isinstance(value,datetime) else value
    if when.tzinfo:when=when.astimezone(ZoneInfo('Europe/Moscow')).replace(tzinfo=None)
    return when.replace(microsecond=0).isoformat(timespec='seconds')


def authorize(conn,user,object_id):
    if not is_system_admin(user):raise HTTPException(403,'Изменять выданный СНЗ целиком может только администратор.')
    assert_object_feature(conn,user,object_id,'plan','read')


def context(conn,object_id,order_id):
    from app import snz
    state,revision=snz._load(conn,object_id);order={**snz._order(conn,object_id,order_id),'id':order_id}
    closure=records(state).get('closed',{}).get(str(order_id))
    facts=closure['facts'] if closure else snz._public_facts(state)
    ops={o['id']:deepcopy(o) for o in state['operations']};teams={t['id']:t['name'] for t in state['teams']}
    for task in order['tasks']:
        ops[task['operation_id']]={'id':task['operation_id'],'name':task['operation'],'team':task['team_id'],'scope':task['scope']}
        teams[task['team_id']]=task['team']
    rows=positions(order,facts);saved={a['element_id']:a for a in state['assignments']}
    for row in rows:
        row['card_id']=row['card_id'] or saved.get(row['element_id'],{}).get('card_id')
        for step in row['steps']:
            step['completed_at']=local(step['completed_at'])
            step['planned_start']=local(step['planned_start'])
    order['editor_positions']=deepcopy(rows)
    order['card_names']={c['id']:c['name'] for c in state['cards']}
    return {'order':order,'revision':revision,'order_revision':order.get('order_revision',1),'positions':rows,
            'operations':list(ops.values()),'teams':[{'id':key,'name':value} for key,value in teams.items()],
            'cards':state['cards'],'elements':snz._elements(conn,object_id),'montage':status_montage(conn,object_id),'state':state,'facts':facts,'closure':closure}


@router.get('/orders/{order_id}/admin-edit')
def read_editor(object_id:int,order_id:int,user=Depends(get_current_user)):
    conn=get_connection()
    try:
        authorize(conn,user,object_id);data=context(conn,object_id,order_id)
        return {k:v for k,v in data.items() if k not in ('state','facts','closure')}
    finally:conn.close()


def build_order(data,rows):
    old=data['order'];result=deepcopy(old);members=order_items(old)
    current={e['id']:e for e in data['elements']};ops={o['id']:o for o in data['operations']};teams={t['id']:t['name'] for t in data['teams']}
    old_tasks={(eid,t['operation_id']):t for t in old['tasks'] for eid in t['element_ids']}
    cards={c['id'] for c in data['cards']};tasks=[];facts={};items=[]
    if len({p['element_id'] for p in rows})!=len(rows):raise HTTPException(422,'В составе повторяется изделие.')
    priorities=[p['priority'] for p in rows]
    if len(set(priorities))!=len(priorities):raise HTTPException(422,'Очередность изделий не должна повторяться.')
    for index,row in enumerate(sorted(rows,key=lambda p:p['priority']),1):
        eid=row['element_id'];member=members.get(eid) or current.get(eid)
        if not member or (eid not in members and not member.get('is_current',1)):
            raise HTTPException(422,'Добавлять можно только изделия актуальной модели этого объекта.')
        if row['card_id'] is not None and row['card_id'] not in cards and row['card_id']!=next((p['card_id'] for p in data['positions'] if p['element_id']==eid),None):
            raise HTTPException(422,'Карта отсутствует в справочнике.')
        items.append(deepcopy(member));row['priority']=index
        if len({s['operation_id'] for s in row['steps']})!=len(row['steps']):raise HTTPException(422,'Операция изделия повторяется.')
        chain=[]
        for si,step in enumerate(row['steps']):
            op=ops.get(step['operation_id']);team=teams.get(step['team_id'])
            if not op or team is None:raise HTTPException(422,'Операция или звено отсутствует в справочнике.')
            if (op['scope']=='preparation')!=(old['crew']['kind']=='preparation'):
                raise HTTPException(422,'Подготовительные и монтажные операции относятся к разным бригадам.')
            key=f'e:{eid}:{op["id"]}';source=old_tasks.get((eid,op['id']),{})
            remaining=source.get('remaining_before') if source.get('norm_minutes')==step['minutes'] else step['minutes']
            if remaining is None:remaining=step['minutes']
            task={'key':key,'operation_id':op['id'],'operation':op['name'],'scope':'preparation' if op['scope']=='preparation' else 'element',
                'team_id':step['team_id'],'team':team,'crew_id':old['crew']['id'],'norm_minutes':step['minutes'],
                'remaining_before':remaining,'remaining_after':remaining,'wait_after':step['wait_after'],
                'element_ids':[eid],'elements':[deepcopy(member)],'priority':index,'priorities':{str(eid):index},
                'group_id':None,'group_name':None,'carry':source.get('carry',False),'release':old['start'],
                'dependencies':chain[-1:],'segments':[],'step_index':si,'admin_start':step['planned_start']}
            tasks.append(task);chain.append(key)
            facts[key]={'completed':step['completed'],**({'completed_at':step['completed_at']} if step['completed'] else {})}
    def plan_fields(ps):return [{**p,'steps':[{k:v for k,v in s.items() if k not in ('completed','completed_at')} for s in p['steps']]} for p in ps]
    if plan_fields(rows)==plan_fields(data['positions']):
        tasks=deepcopy(old['tasks'])
        facts={t['key']:facts.get(t['key'],data['facts'].get(t['key'],{})) for t in tasks}
    else:
        windows=[(datetime.fromisoformat(a),datetime.fromisoformat(b)) for a,b in old['windows']]
        ready={};resources={};pending={t['key']:t for t in tasks};mount=[t['key'] for t in tasks if t['operation_id']=='install'];previous=dict(zip(mount[1:],mount))
        while pending:
            candidates=[]
            for key,t in pending.items():
                deps=t['dependencies']+([previous[key]] if key in previous else [])
                if not t['norm_minutes'] or any(d not in ready for d in deps):continue
                begin=max([windows[0][0],resources.get(t['team_id'],windows[0][0])]+[ready[d] for d in deps]+([datetime.fromisoformat(t['admin_start'])] if t['admin_start'] else []))
                segs,rest=fragments(begin,t['remaining_before'],windows)
                if segs:candidates.append((segs[0]['start'],t['priority'],t['step_index'],key,segs,rest))
            if not candidates:break
            _,_,_,key,segs,rest=min(candidates,key=lambda c:c[:4]);t=pending.pop(key);t['segments']=segs;t['remaining_after']=rest
            resources[t['team_id']]=datetime.fromisoformat(segs[-1]['end'])
            if not rest:ready[key]=resources[t['team_id']]+timedelta(minutes=t['wait_after'])
        for t in tasks:t.pop('admin_start',None)
        tasks.sort(key=lambda t:(t['segments'][0]['start'] if t['segments'] else old['end'],t['priority'],t['step_index']))
    result.update(items=items,tasks=tasks,editor_positions=deepcopy(rows),item_priorities={str(p['element_id']):p['priority'] for p in rows},
        assignment_steps={str(p['element_id']):[{'id':s['operation_id'],'name':ops[s['operation_id']]['name'],'team_id':s['team_id'],'team':teams[s['team_id']],
            'scope':ops[s['operation_id']]['scope'],'minutes':s['minutes'],'wait_after':s['wait_after']} for s in p['steps']] for p in rows},
        order_revision=data['order_revision']+1,version_facts=facts,completed=[k for k,f in facts.items() if f.get('completed')])
    result['revision']=data['revision']
    result['excluded_element_ids']=sorted((set(old.get('excluded_element_ids',[]))|set(members))-set(p['element_id'] for p in rows))
    result['completed_ready']={t['key']:(datetime.fromisoformat(facts[t['key']]['completed_at'])+timedelta(minutes=t['wait_after'])).isoformat(timespec='minutes')
        for t in tasks if facts.get(t['key'],{}).get('completed') and facts[t['key']].get('completed_at')}
    result['warnings']=montage_warnings(tasks,len(items),sum(int((b-a).total_seconds()/60) for a,b in [(datetime.fromisoformat(a),datetime.fromisoformat(b)) for a,b in old['windows']]))
    result['warnings'] += [f"{t['elements'][0].get('mark') or t['element_ids'][0]} · {t['operation']}: норматив не задан или работа не вошла в смену." for t in tasks if not t['segments']]
    for key in ('fingerprint','facts','current_revision','historical'):result.pop(key,None)
    return result


def collision_check(conn,object_id,order_id,before,after):
    """Only effective downstream changes conflict; unrelated later shifts stay valid."""
    rows=changes(before,after)
    consequential={r['element_id'] for r in rows if r['field'] not in ('Карта','Очередность')}
    # Shared legacy keys changing into individual keys are a real dependency change.
    oldkeys={t['key'] for t in before['tasks']};newkeys={t['key'] for t in after['tasks']}
    if oldkeys!=newkeys:consequential.update(eid for t in before['tasks']+after['tasks'] if t['key'] in oldkeys^newkeys for eid in t['element_ids'])
    affected_keys={t['key'] for t in before['tasks']+after['tasks'] if consequential.intersection(t['element_ids'])}
    old_tasks={t['key']:t for t in before['tasks']}
    spill=any((t.get('remaining_after') or 0)>(old_tasks.get(t['key'],{}).get('remaining_after') or 0)
        or (t.get('norm_minutes') is None and old_tasks.get(t['key'],{}).get('norm_minutes') is not None)
        for t in after['tasks'])
    conflicts=[]
    for row in conn.execute('SELECT id,snapshot_json FROM snz_orders WHERE object_id=? AND id<>?',(object_id,order_id)):
        later=json.loads(row['snapshot_json'])
        if later['start']<=before['start']:continue
        related=consequential.intersection(order_items(later)) or any(affected_keys.intersection(t.get('dependencies',[])) for t in later['tasks'])
        if related or (spill and later['crew']['id']==before['crew']['id'] and not later.get('ignore_fact')):conflicts.append(row['id'])
    if conflicts:raise HTTPException(409,'Изменение вызывает коллизию со следующими связанными СНЗ: № '+', '.join(map(str,conflicts))+'. Сначала исправьте последующие задания.')
    added=set(order_items(after))-set(order_items(before))
    for row in conn.execute('SELECT id,snapshot_json FROM snz_orders WHERE object_id=? AND id<>?',(object_id,order_id)):
        other=json.loads(row['snapshot_json'])
        if other['start']==before['start'] and added.intersection(order_items(other)):
            raise HTTPException(409,f'Добавляемое изделие уже включено в другую бригаду этой смены: СНЗ № {row["id"]}.')


def preview(conn,object_id,order_id,body):
    from app import snz
    data=context(conn,object_id,order_id);snz._version(data['revision'],body.revision)
    if data['order_revision']!=body.order_revision:raise HTTPException(409,'Редакция СНЗ изменилась. Откройте документ заново.')
    if not body.reason.strip():raise HTTPException(422,'Укажите причину исправления.')
    rows=[p.model_dump(mode='json') for p in body.positions];oldsteps={(p['element_id'],s['operation_id']):s for p in data['positions'] for s in p['steps']}
    if sum(len(p['steps']) for p in rows)>20000:raise HTTPException(422,'В одной редакции допускается не более 20 000 операций.')
    live=status_montage(conn,object_id)
    for row in rows:
        for step in row['steps']:
            step['planned_start']=local(step['planned_start']);step['completed_at']=local(step['completed_at']) if step['completed'] else None
            if step['planned_start'] and datetime.fromisoformat(step['planned_start']).second:raise HTTPException(422,'Плановое начало указывается с точностью до минуты.')
            if step['planned_start'] and not data['order']['start']<=step['planned_start']<data['order']['end']:raise HTTPException(422,'Плановое начало должно попадать в выбранную смену.')
            prior=oldsteps.get((row['element_id'],step['operation_id']),{})
            if not prior and step['operation_id']=='install':prior={'completed':bool(live.get(row['element_id'],{}).get('completed_at')),'completed_at':live.get(row['element_id'],{}).get('completed_at')}
            if step['completed'] and not step['completed_at']:raise HTTPException(422,'Для выполненной операции укажите время факта (МСК).')
            if step['completed'] and (not prior.get('completed') or prior.get('completed_at')!=step['completed_at']):
                if not data['order']['start']<=step['completed_at']<data['order']['end']:raise HTTPException(422,'Исправленное время факта должно попадать в смену СНЗ.')
    added={p['element_id'] for p in rows}-set(order_items(data['order']))
    for a in data['state']['assignments']:
        if a['element_id'] in added and (a['date'],a['shift'],a['crew_id'])!=(data['order']['date'],data['order']['shift'],data['order']['crew']['id']):
            raise HTTPException(409,'Добавляемое изделие уже назначено на другую дату, смену или бригаду. Сначала уточните его назначение.')
    result=build_order(data,rows);before=freeze(data['order'],data['facts'],data['closure'])
    delta=changes(before,result)
    if not delta:raise HTTPException(422,'Документ не изменён.')
    collision_check(conn,object_id,order_id,before,result)
    statuses=status_montage(conn,object_id)
    result['edit_reason']=body.reason.strip()
    fingerprint=digest({'snapshot':result,'before':before,'revision':data['revision'],
        'statuses':{str(eid):statuses.get(eid,{}).get('expected_rev') for eid in set(order_items(before))|set(order_items(result))}})
    return data,result,delta,fingerprint


@router.post('/orders/{order_id}/admin-preview')
def preview_editor(object_id:int,order_id:int,body:AdminPreviewIn,user=Depends(get_current_user)):
    conn=get_connection()
    try:
        authorize(conn,user,object_id);data,snapshot,delta,fingerprint=preview(conn,object_id,order_id,body)
        return {'snapshot':snapshot,'changes':delta,'fingerprint':fingerprint,'revision':data['revision']}
    finally:conn.close()


def apply_facts(conn,object_id,order_id,data,snapshot,user):
    from app.contracts import apply_status_change,recompute_status_and_actual_date,adopt_contract_from_history
    state=data['state'];before={(p['element_id'],s['operation_id']):s for p in data['positions'] for s in p['steps']}
    name=audit_display_name(user);statuses=status_montage(conn,object_id);changed=[]
    for p in snapshot['editor_positions']:
        eid=p['element_id']
        for step in p['steps']:
            previous=before.get((eid,step['operation_id']),{})
            if not previous and step['operation_id']=='install':previous={'completed':bool(statuses[eid].get('completed_at')),'completed_at':statuses[eid].get('completed_at')}
            key=f'e:{eid}:{step["operation_id"]}'
            different=(bool(previous.get('completed')),previous.get('completed_at'))!=(step['completed'],step['completed_at'])
            if different and step['operation_id']=='install':
                status=statuses[eid]
                if step['completed']:
                    if status.get('completed_at'):
                        conn.execute('UPDATE status_history SET changed_at=?,comment=COALESCE(comment,\'\') || ? WHERE id=? AND element_id=?',
                            (step['completed_at'].replace('T',' '),f'\nИсправление СНЗ № {order_id}: {snapshot["edit_reason"]} · {name}',status['history_id'],eid))
                        effective,_=recompute_status_and_actual_date(conn,eid)
                        adopt_contract_from_history(conn,eid,effective)
                        activity.log('history_edit',user=user,entity_type='element',entity_id=eid,
                            old_value=status['completed_at'],new_value=step['completed_at'],details={'history_id':status['history_id'],'order_id':order_id,'reason':snapshot['edit_reason']})
                    else:apply_status_change(conn,eid,'installed',False,None,step['completed_at'].replace('T',' '),f'Исправление факта СНЗ № {order_id}',name,user['id'])
                    actual=status_montage(conn,object_id)[eid]
                    if actual.get('completed_at')!=step['completed_at']:raise HTTPException(409,'Исправление времени конфликтует с последующей историей статусов изделия. Проверьте историю.')
                elif status['current_status'] in ('installed','accepted'):
                    now=datetime.now(ZoneInfo('Europe/Moscow')).replace(tzinfo=None,microsecond=0)
                    if status.get('latest_at') and datetime.fromisoformat(status['latest_at'])>now:raise HTTPException(409,'В истории изделия есть будущий статус. Проверьте историю перед отменой факта.')
                    apply_status_change(conn,eid,'ready_for_installation',False,None,now.isoformat(sep=' '),f'Отмена факта в редакции СНЗ № {order_id}',name,user['id'])
                changed.append(eid)
            if different or key not in state['facts']:
                state['facts'][key]={'completed':step['completed'],**({'completed_at':step['completed_at'],'completed_by':name} if step['completed'] else {})}
    project_montage(state,status_montage(conn,object_id))
    closure=data['closure']
    if closure:
        updated=deepcopy(closure);updated['facts']=deepcopy(snapshot['version_facts']);updated['rows']={}
        for p in snapshot['editor_positions']:
            install=next((s for s in p['steps'] if s['operation_id']=='install'),None)
            old=closure['rows'].get(str(p['element_id']),{})
            confirmed=bool(install['completed']) if install else bool(old.get('status_confirmed',statuses.get(p['element_id'],{}).get('completed_at')))
            updated['rows'][str(p['element_id'])]={'current_status':('accepted' if old.get('current_status')=='accepted' else 'installed') if confirmed else 'ready_for_installation',
                'status_confirmed':confirmed,'completed':confirmed,'completed_at':(install['completed_at'] if install else old.get('completed_at',statuses.get(p['element_id'],{}).get('completed_at'))) if confirmed else None}
        records(state,True)['closed'][str(order_id)]=updated;snapshot['version_closure']=deepcopy(updated)
    return changed


@router.post('/orders/{order_id}/admin-revisions')
def save_editor(object_id:int,order_id:int,body:AdminSaveIn,user=Depends(get_current_user)):
    from app import snz
    conn=get_connection();events=activity.defer_begin()
    try:
        begin_write(conn);authorize(conn,user,object_id)
        payload=digest(body.model_dump(mode='json'))
        existing=conn.execute('SELECT order_id,revision,request_hash FROM snz_order_revisions WHERE object_id=? AND request_id=?',(object_id,body.request_id)).fetchone()
        if existing:
            if existing['order_id']!=order_id or existing['request_hash']!=payload:raise HTTPException(409,'Ключ сохранения уже использован для другого изменения.')
            return {'id':order_id,'order_revision':existing['revision'],'already_applied':True}
        data,snapshot,delta,fingerprint=preview(conn,object_id,order_id,body)
        if fingerprint!=body.expected_hash:raise HTTPException(409,'После проверки документ или факт изменились. Проверьте редакцию заново.')
        row=conn.execute('SELECT * FROM snz_orders WHERE object_id=? AND id=?',(object_id,order_id)).fetchone()
        original=freeze(data['order'],data['facts'],data['closure'])
        original['version_facts_captured_at']=datetime.now(ZoneInfo('UTC')).isoformat(timespec='seconds')
        conn.execute('INSERT OR IGNORE INTO snz_order_revisions(object_id,order_id,revision,snapshot_json,created_at,created_by,reason) VALUES (?,?,?,?,?,?,?)',
            (object_id,order_id,data['order_revision'],json.dumps(original,ensure_ascii=False),data['order'].get('edited_at',row['created_at']),data['order'].get('edited_by',row['created_by']),data['order'].get('edit_reason','Первоначальная выдача')))
        changed=apply_facts(conn,object_id,order_id,data,snapshot,user)
        name=audit_display_name(user);now=datetime.now(ZoneInfo('UTC')).isoformat(timespec='seconds')
        snapshot.update(edited_at=now,edited_by=name,version_saved_at=now,version_facts_captured_at=now)
        raw=json.dumps(snapshot,ensure_ascii=False)
        conn.execute('INSERT INTO snz_order_revisions(object_id,order_id,revision,snapshot_json,created_at,created_by,reason,request_id,request_hash) VALUES (?,?,?,?,?,?,?,?,?)',
            (object_id,order_id,snapshot['order_revision'],raw,now,name,body.reason.strip(),body.request_id,payload))
        conn.execute('UPDATE snz_orders SET snapshot_json=?,source_revision=? WHERE object_id=? AND id=?',(raw,data['revision'],object_id,order_id))
        # Release removed appointments only when no other issued order still owns them.
        removed=set(order_items(data['order']))-set(order_items(snapshot));others={eid for r in conn.execute('SELECT snapshot_json FROM snz_orders WHERE object_id=? AND id<>?',(object_id,order_id)) for eid in order_items(json.loads(r[0]))}
        released=removed-others
        if data['closure']:
            closed=records(data['state'],True)['closed'][str(order_id)]
            pending={int(eid) for eid,item in closed['rows'].items() if not item['status_confirmed']}
            released|=pending-others
            for eid in pending:
                records(data['state'],True).setdefault('transfers',{})[str(eid)]={'from_date':snapshot['date'],'from_shift':snapshot['shift'],'order_id':order_id,'closed_at':closed['closed_at']}
        else:
            additions=set(order_items(snapshot))-set(order_items(data['order']))
            assigned={a['element_id'] for a in data['state']['assignments']}
            for p in snapshot['editor_positions']:
                if p['element_id'] in additions-assigned:
                    data['state']['assignments'].append({'element_id':p['element_id'],'crew_id':snapshot['crew']['id'],'card_id':p['card_id'] or data['state']['cards'][0]['id'],
                        'date':snapshot['date'],'shift':snapshot['shift'],'priority':p['priority'],'prep_priority':None})
                    conn.execute('UPDATE elements SET planned_installation_date=? WHERE object_id=? AND id=?',(snapshot['date'],object_id,p['element_id']))
        positions_by_id={p['element_id']:p for p in snapshot['editor_positions']}
        valid_cards={c['id'] for c in data['state']['cards']}
        for a in data['state']['assignments']:
            if a['element_id'] in positions_by_id and (a['date'],a['shift'],a['crew_id'])==(snapshot['date'],snapshot['shift'],snapshot['crew']['id']):
                p=positions_by_id[a['element_id']];a['priority']=p['priority']
                if p['card_id'] in valid_cards:a['card_id']=p['card_id']
        data['state']['assignments']=[a for a in data['state']['assignments'] if not(a['element_id'] in released and a['date']==snapshot['date'] and a['shift']==snapshot['shift'] and a['crew_id']==snapshot['crew']['id'])]
        for eid in released:conn.execute('UPDATE elements SET planned_installation_date=NULL WHERE object_id=? AND id=? AND planned_installation_date=?',(object_id,eid,snapshot['date']))
        snz._write(conn,object_id,data['state'],data['revision']);touch_elements(conn,list(set(changed)|removed|set(order_items(snapshot))))
        conn.commit();activity.defer_flush(events)
        activity.log('snz_issue',user=user,entity_type='object',entity_id=object_id,details={'action':'admin_revision','order_id':order_id,'order_revision':snapshot['order_revision'],'changes':delta,'reason':body.reason.strip()})
        return {'id':order_id,'order_revision':snapshot['order_revision'],'revision':data['revision']+1}
    finally:activity.defer_end(events);conn.close()
