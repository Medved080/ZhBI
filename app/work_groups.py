"""Object work groups, versioned template and capture assignments.

All mutating operations use the caller's transaction. Preview fingerprints include
rules, geometry and element assignments, so concurrent edits require a fresh preview.
"""
import hashlib
import json
import math
import uuid
from copy import deepcopy

from fastapi import HTTPException

DEFAULT_GROUPS = [
    {'key': 'zhbi', 'name': 'Монтаж ЖБИ', 'rules': [{'element_type': '*', 'subtype': '*'}]},
    {'key': 'facade', 'name': 'Монтаж фасадных панелей', 'rules': [{'element_type': 'Панель', 'subtype': 'фасадная'}]},
]


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def fail(message, status=422):
    raise HTTPException(status_code=status, detail=message)


def install_schema(conn, changes=None):
    additions = []
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_groups'").fetchone() is None:
        additions.append('таблицы групп работ ЖБИ, шаблонов и истории назначений')
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS work_group_templates (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            groups_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS work_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            group_key TEXT NOT NULL,
            name TEXT NOT NULL,
            rules_json TEXT NOT NULL,
            UNIQUE(object_id,group_key)
        );
        CREATE TABLE IF NOT EXISTS work_group_settings (
            object_id INTEGER PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
            template_revision INTEGER NOT NULL REFERENCES work_group_templates(revision),
            base_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_group_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            element_id INTEGER REFERENCES elements(id) ON DELETE SET NULL,
            action TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            actor TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    ''')
    for table, fields in {
        'elements': [('work_group_id', 'INTEGER REFERENCES work_groups(id)'),
                     ('capture_assignment_mode', "TEXT NOT NULL DEFAULT 'auto'")],
        'zones': [('work_group_id', 'INTEGER REFERENCES work_groups(id)'),
                  ('capture_source', "TEXT NOT NULL DEFAULT 'drawing'"),
                  ('capture_floor', 'INTEGER')],
    }.items():
        columns = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
        for name, declaration in fields:
            if name not in columns:
                conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {declaration}')
                additions.append(f'{table}.{name}')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_elements_work_group ON elements(object_id,work_group_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_work_group_history_object ON work_group_history(object_id,id)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_zones_work_group ON zones(object_id,work_group_id)')
    # Covers established element writers, including imports and bulk edits.
    resolve = '''SELECT g.id FROM work_groups g, json_each(g.rules_json) r
        WHERE g.object_id=NEW.object_id
        AND (json_extract(r.value,'$.element_type')='*' OR json_extract(r.value,'$.element_type')=NEW.element_type)
        AND (json_extract(r.value,'$.subtype')='*' OR json_extract(r.value,'$.subtype')=COALESCE(NEW.subtype,''))
        ORDER BY ((json_extract(r.value,'$.element_type')<>'*') + (json_extract(r.value,'$.subtype')<>'*')) DESC,g.id LIMIT 1'''
    for name, event in [('insert', 'INSERT'), ('type', 'UPDATE OF element_type,subtype,object_id')]:
        conn.execute(f'''CREATE TRIGGER IF NOT EXISTS trg_work_group_{name} AFTER {event} ON elements
            WHEN EXISTS(SELECT 1 FROM work_group_settings WHERE object_id=NEW.object_id)
            BEGIN
                UPDATE elements SET work_group_id=({resolve}) WHERE id=NEW.id;
                UPDATE elements SET zone_zakhvatka_id=NULL,zone_zakhvatka_status='unmatched',capture_assignment_mode='auto'
                    WHERE id=NEW.id AND zone_zakhvatka_id IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM zones z WHERE z.id=zone_zakhvatka_id AND z.object_id=elements.object_id AND z.work_group_id=elements.work_group_id
                    );
            END''')

    if changes is not None:
        changes.extend(additions)


def template(conn):
    row = conn.execute('SELECT * FROM work_group_templates ORDER BY revision DESC LIMIT 1').fetchone()
    if row is None:
        conn.execute('INSERT INTO work_group_templates(groups_json) VALUES (?)', (dumps(DEFAULT_GROUPS),))
        return template(conn)
    return {'revision': row['revision'], 'groups': json.loads(row['groups_json'])}


def groups(conn, object_id):
    return [dict(r) | {'key': r['group_key'], 'rules': json.loads(r['rules_json'])}
            for r in conn.execute('SELECT * FROM work_groups WHERE object_id=? ORDER BY id', (object_id,))]


def definition(items):
    return [{'key': g['key'], 'name': g['name'], 'rules': g['rules']} for g in items]


def ensure_object(conn, object_id):
    row = conn.execute('SELECT kind FROM objects WHERE id=?', (object_id,)).fetchone()
    if row is None or row['kind'] != 'zhbi':
        return
    if conn.execute('SELECT 1 FROM work_group_settings WHERE object_id=?', (object_id,)).fetchone():
        return
    t = template(conn)
    for g in t['groups']:
        conn.execute('INSERT INTO work_groups(object_id,group_key,name,rules_json) VALUES (?,?,?,?)',
                     (object_id, g['key'], g['name'], dumps(g['rules'])))
    conn.execute('INSERT INTO work_group_settings VALUES (?,?,?)', (object_id, t['revision'], dumps(t['groups'])))


def classify(items, element):
    matches = [(sum(rule[k] != '*' for k in ('element_type', 'subtype')), g['id'])
               for g in items for rule in g['rules']
               if rule['element_type'] in ('*', element['element_type'])
               and rule['subtype'] in ('*', element['subtype'] or '')]
    return max(matches, default=(0, None))[1]


def validate(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        fail('Укажите от 1 до 100 групп')
    keys, names, rules = set(), set(), []
    for group in items:
        group.setdefault('key', uuid.uuid4().hex)
        key, name = group['key'], str(group.get('name', '')).strip()
        if not isinstance(key, str) or not key or len(key) > 80 or key in keys:
            fail('Идентификаторы групп должны быть уникальными')
        if not name or len(name) > 150 or name.casefold() in names:
            fail('Укажите уникальные названия групп длиной до 150 символов')
        keys.add(key); names.add(name.casefold()); group['name'] = name
        if not isinstance(group.get('rules'), list) or not group['rules'] or len(group['rules']) > 200:
            fail('У каждой группы должен быть состав изделий')
        for r in group['rules']:
            if set(r) != {'element_type', 'subtype'} or any(not isinstance(v, str) or len(v) > 200 for v in r.values()):
                fail('Правило должно содержать тип и подтип изделия')
            if not r['element_type']:
                fail('Укажите тип изделия')
            for other_key, other_name, other in rules:
                overlap = all(r[k] == '*' or other[k] == '*' or r[k] == other[k] for k in r)
                if other_key != key and overlap and sum(v != '*' for v in r.values()) == sum(v != '*' for v in other.values()):
                    fail(f'Правила групп «{name}» и «{other_name}» пересекаются с одинаковым приоритетом')
            rules.append((key, name, r))
    base = next((g for g in items if g['key'] == 'zhbi'), None)
    if base is None or {'element_type': '*', 'subtype': '*'} not in base['rules']:
        fail('Сохраните базовую группу с правилом «Все типы / Все подтипы»')


def log_change(conn, object_id, element_id, action, before, after, actor=None):
    conn.execute('INSERT INTO work_group_history(object_id,element_id,action,before_json,after_json,actor) VALUES (?,?,?,?,?,?)',
                 (object_id, element_id, action, dumps(before), dumps(after), actor))


def migrate(conn):
    template(conn)
    for obj in conn.execute("SELECT id FROM objects WHERE kind='zhbi'").fetchall():
        oid = obj['id']
        if conn.execute('SELECT 1 FROM work_group_settings WHERE object_id=?', (oid,)).fetchone():
            continue
        ensure_object(conn, oid)
        catalog = groups(conn, oid)
        base = next(g['id'] for g in catalog if g['key'] == 'zhbi')
        conn.execute("UPDATE zones SET work_group_id=? WHERE object_id=? AND category='Захватка'", (base, oid))
        for row in conn.execute('SELECT * FROM elements WHERE object_id=?', (oid,)).fetchall():
            e = dict(row); gid = classify(catalog, e)
            if gid != base:
                log_change(conn, oid, e['id'], 'migration', binding(e), {'work_group_id': gid, 'zone_zakhvatka_id': None, 'zone_zakhvatka_status': 'unmatched', 'capture_assignment_mode': 'auto'})
                conn.execute("UPDATE elements SET work_group_id=?,zone_zakhvatka_id=NULL,zone_zakhvatka_status='unmatched' WHERE id=?", (gid, e['id']))
            else:
                conn.execute('UPDATE elements SET work_group_id=? WHERE id=?', (gid, e['id']))
    return 'Шаблон ЖБИ и фасадов заполнен, существующие назначения сохранены в истории перехода'


FIELDS = ('work_group_id', 'zone_zakhvatka_id', 'zone_zakhvatka_status', 'capture_assignment_mode')


def binding(e):
    return {k: e.get(k) for k in FIELDS}


def zone_catalog(conn, object_id):
    result = []
    for row in conn.execute("SELECT * FROM zones WHERE object_id=? AND category='Захватка' ORDER BY id", (object_id,)):
        z = dict(row)
        z['levels'] = [dict(l) | {'outline': json.loads(l['outline_json'])}
                       for l in conn.execute('SELECT * FROM zone_levels WHERE zone_id=? AND is_reference=0 ORDER BY elevation_mm', (z['id'],))]
        result.append(z)
    return result


def zone_signature(zone):
    return {k: zone.get(k) for k in ('id','work_group_id','name','number','capture_floor','is_current')} | {
        'levels': [{k: level.get(k) for k in ('outline','elevation_mm','upper_elevation_mm')} for level in zone.get('levels', [])]
    }


def elevation_bounds(conn, object_id, floor):
    rows = list(conn.execute('SELECT floor,elevation_mm FROM object_levels WHERE object_id=? AND elevation_mm IS NOT NULL AND elevation_suspect=0 ORDER BY elevation_mm', (object_id,)))
    low = next((r['elevation_mm'] for r in rows if r['floor'] == floor), None)
    high = next((r['elevation_mm'] for r in rows if low is not None and r['elevation_mm'] > low), None)
    return low, high


def automatic(conn, e, zones):
    from scripts.zone_binding import _bind_point_polys, _bind_overlap_polys, _to_valid_polygon
    candidates = []
    for z in zones:
        if not z['is_current'] or z['work_group_id'] != e['work_group_id']:
            continue
        if z.get('capture_floor') is not None:
            if e.get('floor') is not None:
                if e['floor'] != z['capture_floor']:
                    continue
            else:
                low, high = elevation_bounds(conn, e['object_id'], z['capture_floor'])
                if low is None or e.get('elevation_mm') is None or e['elevation_mm'] < low or (high is not None and e['elevation_mm'] >= high):
                    continue
        for level in z['levels']:
            low, high, at = level['elevation_mm'], level.get('upper_elevation_mm'), e.get('elevation_mm')
            if (low is not None or high is not None) and (at is None or (low is not None and at < low) or (high is not None and at >= high)):
                continue
            poly = _to_valid_polygon(level['outline'])
            if poly is not None:
                candidates.append((z['id'], poly))
    # Several levels of one capture are a single candidate.
    from shapely.ops import unary_union
    combined = [(zid, unary_union([p for key,p in candidates if key == zid])) for zid in dict.fromkeys(key for key,p in candidates)]
    outline = json.loads(e['outline_json']) if e.get('outline_json') else None
    r = (_bind_point_polys(e['x'], e['y'], combined) if e['element_type'] == 'Колонна' or not outline
         else _bind_overlap_polys(outline, combined))
    return {'zone_zakhvatka_id': r.zone_handle, 'zone_zakhvatka_status': r.status}


def recalculate(conn, object_id, *, ids=None, group_ids=None, reset_manual=False, actor=None):
    catalog, zones = groups(conn, object_id), zone_catalog(conn, object_id)
    selected = set(ids) if ids is not None else None
    changes = []
    for row in conn.execute('SELECT * FROM elements WHERE object_id=? AND is_current=1', (object_id,)).fetchall():
        e = dict(row)
        if selected is not None and e['id'] not in selected:
            continue
        old = binding(e); e['work_group_id'] = classify(catalog, e)
        if group_ids is not None and e['work_group_id'] not in group_ids:
            continue
        valid = any(z['id'] == e['zone_zakhvatka_id'] and z['is_current'] and z['work_group_id'] == e['work_group_id'] for z in zones)
        if reset_manual or e['capture_assignment_mode'] != 'manual' or not valid or old['work_group_id'] != e['work_group_id']:
            e['capture_assignment_mode'] = 'auto'
            e.update(automatic(conn, e, zones))
        new = binding(e)
        if old != new:
            conn.execute('UPDATE elements SET work_group_id=?,zone_zakhvatka_id=?,zone_zakhvatka_status=?,capture_assignment_mode=?,updated_at=strftime(\'%Y-%m-%d %H:%M:%f\',\'now\') WHERE id=?', (*new.values(), e['id']))
            log_change(conn, object_id, e['id'], 'rebind', old, new, actor)
            changes.append({'id': e['id'], 'before': old, 'after': new})
    if changes:
        from app.db import touch_elements
        touch_elements(conn, [r['id'] for r in changes])
    return changes


def state(conn, object_id):
    gs = groups(conn, object_id)
    counts = {r['work_group_id']: dict(r) for r in conn.execute("SELECT work_group_id,count(*) AS elements,sum(zone_zakhvatka_id IS NULL) AS unassigned FROM elements WHERE object_id=? AND is_current=1 GROUP BY work_group_id", (object_id,))}
    zones = zone_catalog(conn, object_id)
    for g in gs:
        g.update(counts.get(g['id'], {'elements': 0, 'unassigned': 0}))
        g['captures'] = sum(z['work_group_id'] == g['id'] and z['is_current'] for z in zones)
    saved = conn.execute('SELECT * FROM work_group_settings WHERE object_id=?', (object_id,)).fetchone()
    from app.models import ZHBI_ELEMENT_TYPES
    from app.shaft_panels import TYPE as SHAFT_PANEL_TYPE
    types = set(ZHBI_ELEMENT_TYPES) | {SHAFT_PANEL_TYPE}
    pairs = set((r[0], r[1] or '') for r in conn.execute('SELECT element_type,subtype FROM allowed_subtypes WHERE object_id=? UNION SELECT element_type,subtype FROM elements WHERE object_id=?', (object_id, object_id)))
    for g in gs + template(conn)['groups']:
        pairs.update((r['element_type'], r['subtype']) for r in g['rules'] if r['element_type'] != '*' and r['subtype'] != '*')
    types.update(t for t,s in pairs)
    return {'groups': gs, 'zones': zones, 'template': template(conn), 'applied_revision': saved['template_revision'] if saved else None,
            'types': sorted(types), 'subtypes': {t: sorted(s for tt,s in pairs if t==tt) for t in sorted(types)}}


def fingerprint(conn, object_id):
    return digest({'groups': definition(groups(conn, object_id)), 'zones': zone_catalog(conn, object_id),
                   'elements': [tuple(r) for r in conn.execute('SELECT id,element_type,subtype,x,y,elevation_mm,floor,outline_json,work_group_id,zone_zakhvatka_id,zone_zakhvatka_status,capture_assignment_mode,is_current FROM elements WHERE object_id=? ORDER BY id', (object_id,))],
                   'template': template(conn)})


def merge_template(conn, object_id, choices):
    saved = conn.execute('SELECT * FROM work_group_settings WHERE object_id=?', (object_id,)).fetchone()
    base = {g['key']:g for g in json.loads(saved['base_json'])}
    local = {g['key']:g for g in definition(groups(conn, object_id))}
    remote = {g['key']:g for g in template(conn)['groups']}
    merged, conflicts = [], []
    for key in dict.fromkeys([*local, *remote]):
        b, l, r = base.get(key), local.get(key), remote.get(key)
        if l == b:
            value = r
        elif r == b or l == r:
            value = l
        elif b is not None and l is not None and r is not None:
            value = {'key':key}
            conflicted = False
            for field in ('name','rules'):
                if l[field] == b[field]: value[field] = r[field]
                elif r[field] == b[field] or l[field] == r[field]: value[field] = l[field]
                elif choices.get(key) in ('local','template'):
                    value[field] = l[field] if choices[key]=='local' else r[field]
                else:
                    conflicted = True; value[field] = l[field]
            if conflicted: conflicts.append({'key':key,'local':l,'template':r})
        elif choices.get(key) in ('local','template'):
            value = l if choices[key]=='local' else r
        else:
            conflicts.append({'key':key,'local':l,'template':r}); value = l
        if value is not None:
            merged.append(value)
    return merged, conflicts


def save_groups(conn, object_id, items):
    validate(items)
    existing = {g['key']:g for g in groups(conn, object_id)}
    for g in items:
        conn.execute('INSERT INTO work_groups(object_id,group_key,name,rules_json) VALUES (?,?,?,?) ON CONFLICT(object_id,group_key) DO UPDATE SET name=excluded.name,rules_json=excluded.rules_json',
                     (object_id,g['key'],g['name'],dumps(g['rules'])))
    removed = [g for key,g in existing.items() if key not in {i['key'] for i in items}]
    for g in removed:
        if conn.execute('SELECT 1 FROM zones WHERE work_group_id=? LIMIT 1', (g['id'],)).fetchone():
            fail(f'У группы «{g["name"]}» есть захватки. Измените её состав или перенесите захватки')
    return removed


def apply_action(conn, object_id, body, actor):
    action = body.get('action')
    conflicts = []
    if action in ('groups','template_apply'):
        items = deepcopy(body.get('groups', []))
        if action == 'template_apply':
            items, conflicts = merge_template(conn, object_id, body.get('choices', {}))
        if conflicts:
            return {'conflicts':conflicts,'changes':[]}
        before_groups = definition(groups(conn, object_id))
        removed = save_groups(conn, object_id, items)
        log_change(conn,object_id,None,action,before_groups,definition(items),actor)
        current_groups = groups(conn, object_id)
        affected = [r['id'] for r in conn.execute('SELECT id,element_type,subtype,work_group_id FROM elements WHERE object_id=? AND is_current=1',(object_id,))
                    if classify(current_groups,dict(r)) != r['work_group_id']]
        changes = recalculate(conn, object_id, ids=affected, actor=actor)
        for g in removed:
            conn.execute('UPDATE elements SET work_group_id=NULL WHERE work_group_id=? AND is_current=0', (g['id'],))
            conn.execute('DELETE FROM work_groups WHERE id=?', (g['id'],))
        if action == 'template_apply':
            t=template(conn)
            conn.execute('UPDATE work_group_settings SET template_revision=?,base_json=? WHERE object_id=?', (t['revision'],dumps(t['groups']),object_id))
    elif action == 'zone':
        z = deepcopy(body.get('zone', {}))
        group_ids = {g['id'] for g in groups(conn,object_id)}
        if z.get('work_group_id') not in group_ids: fail('Выберите группу объекта')
        name = str(z.get('name','')).strip()
        if not name or len(name)>150: fail('Укажите название захватки до 150 символов')
        zid = z.get('id'); levels = z.get('levels', [])
        from shapely.geometry import Polygon
        if not isinstance(levels,list) or len(levels)>100:
            fail('Укажите до 100 ярусов захватки')
        elevations=set()
        for level in levels:
            if not isinstance(level,dict): fail('Проверьте описание яруса')
            if level.get('elevation_mm') in elevations: fail('Нижние отметки ярусов должны отличаться')
            elevations.add(level.get('elevation_mm'))
            pts=level.get('outline',[])
            try:
                shape=Polygon(pts)
                valid=len(pts)>=3 and shape.is_valid and shape.area>0
            except (TypeError,ValueError): valid=False
            if not valid: fail('Контур должен быть замкнутым многоугольником без самопересечений')
            low,high=level.get('elevation_mm'),level.get('upper_elevation_mm')
            if any(v is not None and (not isinstance(v,(int,float)) or not math.isfinite(v)) for v in (low,high)) or (low is not None and high is not None and low>=high): fail('Проверьте границы отметок')
        floor=z.get('capture_floor')
        if floor is not None and not isinstance(floor,int): fail('Этаж должен быть целым числом')
        number=z.get('number')
        if number is not None and not isinstance(number,int): fail('Номер должен быть целым числом')
        duplicates = conn.execute("SELECT id,name FROM zones WHERE object_id=? AND work_group_id=? AND category='Захватка' AND is_current=1 AND id<>?",(object_id,z['work_group_id'],zid or -1))
        if any(row['name'] and row['name'].casefold()==name.casefold() for row in duplicates):
            fail('Название захватки уже занято в этой группе')
        if number is not None and conn.execute("SELECT 1 FROM zones WHERE object_id=? AND work_group_id=? AND category='Захватка' AND is_current=1 AND number=? AND id<>?",(object_id,z['work_group_id'],number,zid or -1)).fetchone(): fail('Номер захватки уже занят в этой группе')
        before_zone = next((zone for zone in zone_catalog(conn,object_id) if zone['id']==zid), {})
        if zid:
            old=conn.execute("SELECT * FROM zones WHERE id=? AND object_id=? AND category='Захватка'",(zid,object_id)).fetchone()
            if not old: fail('Захватка не найдена',404)
            if old['work_group_id']!=z['work_group_id']: fail('Группа существующей захватки сохраняется при правке. Создайте захватку нужной группы')
            conn.execute('UPDATE zones SET name=?,number=?,capture_floor=?,is_current=? WHERE id=?',(name,number,floor,int(z.get('is_current',1)),zid))
        else:
            uid=uuid.uuid4().hex
            zid=conn.execute("INSERT INTO zones(object_id,source_file,dxf_handle,category,name,number,outline_json,match_status,is_current,work_group_id,capture_source,capture_floor) VALUES (?,?,?,'Захватка',?,?,'','matched',1,?,'user',?)",(object_id,f'work-group:{object_id}',uid,name,number,z['work_group_id'],floor)).lastrowid
        conn.execute('DELETE FROM zone_levels WHERE zone_id=?',(zid,))
        for level in levels:
            conn.execute('INSERT INTO zone_levels(zone_id,elevation_mm,upper_elevation_mm,outline_json) VALUES (?,?,?,?)',(zid,level.get('elevation_mm'),level.get('upper_elevation_mm'),dumps(level['outline'])))
        after_zone = next(zone for zone in zone_catalog(conn,object_id) if zone['id']==zid)
        log_change(conn,object_id,None,'zone',before_zone,after_zone,actor)
        changes=recalculate(conn,object_id,group_ids={z['work_group_id']},actor=actor)
    elif action in ('assign','auto'):
        ids=body.get('element_ids',[])
        if not isinstance(ids,list) or not ids or len(ids)>50000 or any(type(i) is not int for i in ids): fail('Выберите изделия')
        ids=set(ids)
        items=[dict(r) for r in conn.execute('SELECT * FROM elements WHERE object_id=? AND is_current=1',(object_id,)) if r['id'] in ids]
        if len(items)!=len(ids): fail('Часть изделий недоступна на этом объекте',409)
        if action=='auto': changes=recalculate(conn,object_id,ids=ids,reset_manual=True,actor=actor)
        else:
            z=conn.execute("SELECT * FROM zones WHERE id=? AND object_id=? AND category='Захватка' AND is_current=1",(body.get('zone_id'),object_id)).fetchone()
            if not z: fail('Выберите действующую захватку объекта')
            if any(e['work_group_id']!=z['work_group_id'] for e in items): fail('Выделите изделия одной группы и выберите захватку этой группы')
            changes=[]
            for e in items:
                old=binding(e); new=old|{'zone_zakhvatka_id':z['id'],'zone_zakhvatka_status':'matched','capture_assignment_mode':'manual'}
                if new==old: continue
                conn.execute("UPDATE elements SET zone_zakhvatka_id=?,zone_zakhvatka_status='matched',capture_assignment_mode='manual' WHERE id=?",(z['id'],e['id']))
                log_change(conn,object_id,e['id'],'manual',old,new,actor)
                changes.append({'id':e['id'],'before':old,'after':new})
            from app.db import touch_elements
            touch_elements(conn,ids)
    elif action=='undo_zone':
        record=conn.execute("SELECT * FROM work_group_history WHERE id=? AND object_id=? AND action='zone'",(body.get('history_id'),object_id)).fetchone()
        if record is None: fail('Правка захватки не найдена',404)
        if conn.execute("SELECT 1 FROM work_group_history WHERE object_id=? AND action='zone_undo' AND json_extract(before_json,'$.history_id')=?",(object_id,record['id'])).fetchone():
            fail('Эта правка уже отменена',409)
        before,after=json.loads(record['before_json']),json.loads(record['after_json'])
        current=next((z for z in zone_catalog(conn,object_id) if z['id']==after['id']),None)
        if current is None or zone_signature(current) != zone_signature(after): fail('Захватка изменилась после этой правки. Обновите историю',409)
        target=before or (after | {'is_current':0})
        result = apply_action(conn,object_id,{'action':'zone','zone':target},actor)
        undo_id = conn.execute("SELECT MAX(id) FROM work_group_history WHERE object_id=? AND action='zone'",(object_id,)).fetchone()[0]
        conn.execute("UPDATE work_group_history SET action='zone_undo',before_json=? WHERE id=?",(dumps({'history_id':record['id']}),undo_id))
        return result
    elif action=='restore':
        history=conn.execute('SELECT * FROM work_group_history WHERE id=? AND object_id=?',(body.get('history_id'),object_id)).fetchone()
        if not history or history['element_id'] is None: fail('Запись истории недоступна',404)
        old=json.loads(history['before_json'])
        return apply_action(conn,object_id,{'action':'assign','element_ids':[history['element_id']],'zone_id':old.get('zone_zakhvatka_id')},actor)
    else: fail('Неизвестное действие')
    from collections import Counter
    counts=Counter((str(r['after']['work_group_id']),r['after']['zone_zakhvatka_status'] or 'unmatched') for r in changes)
    return {'changes':changes,'changed':len(changes),'conflicts':conflicts,
            'summary':[{'group_id':int(g) if g!='None' else None,'status':s,'count':n} for (g,s),n in counts.items()],
            'manual_affected':sum(r['before'].get('capture_assignment_mode')=='manual' for r in changes)}
