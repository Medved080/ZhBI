"""Current planning policy and compatibility with immutable legacy snapshots."""
from copy import deepcopy

POLICY = 'item-sequence-2026-11-10'
INDIVIDUAL_OPERATIONS = frozenset(('rebar1', 'concrete1', 'rebar2', 'concrete2'))


def planning_state(state):
    # Read projection: no startup rewrite of manual settings, norms or facts.
    result = deepcopy(state)
    for operation in result['operations']:
        if operation['id'] in INDIVIDUAL_OPERATIONS:
            operation['scope'] = 'element'
    return result


def planning_steps(steps):
    result = deepcopy(steps)
    for step in result:
        if step['id'] in INDIVIDUAL_OPERATIONS:
            step['scope'] = 'element'
    return result


def step_fact(state, eid, operation_id, key=None, group_lookup=None):
    direct = state['facts'].get(key or f'e:{eid}:{operation_id}', {})
    if direct.get('completed') or operation_id not in INDIVIDUAL_OPERATIONS:
        return direct
    group = group_lookup.get(eid) if group_lookup is not None else next((g for g in state['groups'] if eid in g['element_ids']), None)
    return state['facts'].get(f"g:{group['id']}:{operation_id}", direct) if group else direct


def order_items(order):
    items = {e['id']: e for task in order['tasks'] for e in task['elements']}
    items.update({e['id']: e for e in order.get('items', [])})
    return items


def montage_warnings(tasks, item_count, productive_minutes):
    installation = [t for t in tasks if t['operation_id'] == 'install' and t.get('norm_minutes')]
    required = sum(t['remaining_before'] for t in installation)
    allocated = sum(s['minutes'] for t in installation for s in t['segments'])
    if required <= allocated:
        return []
    return [f'Ограничение времени монтажа: рабочее время смены — {productive_minutes} мин; '
            f'в расписание монтажа вошло {allocated} из {required} мин, остаток — {required - allocated} мин. '
            f'Все назначенные изделия включены в СНЗ ({item_count} шт.), в том числе не вошедшие в рабочее время.']
