"""Amend an issued order by exclusion, preserving frozen norms and recorded facts."""
from copy import deepcopy
from datetime import datetime, timedelta
from app.snz_core import fragments


def free_windows(windows, occupied):
    result=list(windows)
    for left,right in sorted(occupied):
        next_windows=[]
        for start,end in result:
            if right<=start or left>=end:
                next_windows.append((start,end))
            else:
                if start<left:next_windows.append((start,left))
                if right<end:next_windows.append((right,end))
        result=next_windows
    return result


def revise_order(order, facts, exclude_ids, history):
    """Only remove explicit members; never add other shifts or change dictionaries."""
    removed=set(exclude_ids)
    all_ids={eid for task in order['tasks'] for eid in task['element_ids']}
    if not removed or not removed<=all_ids:
        raise ValueError('Выберите для исключения изделия, входящие в этот СНЗ.')
    for task in order['tasks']:
        overlap=removed.intersection(task['element_ids'])
        if overlap and overlap!=set(task['element_ids']):
            raise ValueError('Общую операцию узла исключают целиком: выберите все его ригели.')
        if overlap and facts.get(task['key'],{}).get('completed'):
            raise ValueError('У исключаемого изделия есть завершённая операция. Исправление состава не отменяет внесённый факт.')
    kept=[deepcopy(t) for t in order['tasks'] if not removed.intersection(t['element_ids'])]
    removed_keys={t['key'] for t in order['tasks'] if removed.intersection(t['element_ids'])}
    if any(removed_keys.intersection(t.get('dependencies',[])) for t in kept):
        raise ValueError('Исключение затрагивает предшествующие работы оставшихся изделий. Проверьте состав узла.')
    start=datetime.fromisoformat(order['start'])
    for later in history:
        if datetime.fromisoformat(later['start'])<start:continue
        if later['start']==order['start'] and later['crew']['id']==order['crew']['id']:continue
        if later['crew']['id']==order['crew']['id'] or any(removed.intersection(t['element_ids']) or removed_keys.intersection(t.get('dependencies',[])) for t in later['tasks']):
            raise ValueError('На более позднюю смену уже выдан связанный СНЗ. Сначала исправьте более поздний документ.')
    result=deepcopy(order)
    windows=[(datetime.fromisoformat(a),datetime.fromisoformat(b)) for a,b in order['windows']]
    known={t['key']:t for item in history for t in item['tasks']}
    known.update({t['key']:t for t in order['tasks']})
    ready={key:datetime.fromisoformat(fact['completed_at'])+timedelta(minutes=known.get(key,{}).get('wait_after',0)) for key,fact in facts.items() if fact.get('completed')}
    occupied={}
    pending={t['key']:t for t in kept if not facts.get(t['key'],{}).get('completed')}
    for task in kept:
        if task['key'] not in pending:
            occupied.setdefault((task['crew_id'],task['team_id']),[]).extend((datetime.fromisoformat(s['start']),datetime.fromisoformat(s['end'])) for s in task['segments'])
    kept_keys={t['key'] for t in kept}
    old_keys={t['key'] for t in order['tasks']}
    warnings=['Исправленная редакция: исключены ошибочно включённые изделия. Нормативы сохранены из выданного документа.']
    for task in pending.values():
        external=[dep for dep in task.get('dependencies',[]) if dep not in old_keys and dep not in ready]
        task['_floor']=datetime.fromisoformat(task['segments'][0]['start']) if external and task['segments'] else windows[0][0]
        task['segments']=[];task['remaining_after']=task['remaining_before']
    while pending:
        candidates=[]
        for key,task in pending.items():
            deps=[dep for dep in task.get('dependencies',[]) if dep in kept_keys or dep in ready]
            if any(dep not in ready for dep in deps):continue
            earliest=max([windows[0][0],datetime.fromisoformat(task['release']),task['_floor']]+[ready[d] for d in deps])
            resource=(task['crew_id'],task['team_id'])
            segments,remaining=fragments(earliest,task['remaining_before'],free_windows(windows,occupied.get(resource,[])))
            if segments:candidates.append((segments[0]['start'],0 if task.get('carry') else 1,task.get('priority') if task.get('priority') is not None else 10**9,task.get('step_index',0),key,segments,remaining))
        if not candidates:break
        _,_,_,_,key,segments,remaining=min(candidates,key=lambda x:x[:5])
        task=pending.pop(key);task['segments']=segments;task['remaining_after']=remaining
        resource=(task['crew_id'],task['team_id'])
        occupied.setdefault(resource,[]).extend((datetime.fromisoformat(s['start']),datetime.fromisoformat(s['end'])) for s in segments)
        if not remaining:ready[key]=datetime.fromisoformat(segments[-1]['end'])+timedelta(minutes=task.get('wait_after',0))
    for task in kept:
        task.pop('_floor',None)
        if not task['segments']:warnings.append(f"«{task['operation']}»: работа не вошла в смену или ожидает выполнения предшественников.")
    kept.sort(key=lambda t:(t['segments'][0]['start'] if t['segments'] else order['end'],t['key']))
    remaining_ids={eid for task in kept for eid in task['element_ids']}
    result.update(tasks=kept,warnings=warnings,assignment_steps={key:value for key,value in order.get('assignment_steps',{}).items() if int(key) in remaining_ids},completed=[t['key'] for t in kept if facts.get(t['key'],{}).get('completed')],
                  excluded_element_ids=sorted(set(order.get('excluded_element_ids',[]))|removed),order_revision=order.get('order_revision',1)+1)
    result.pop('fingerprint',None)
    return result
