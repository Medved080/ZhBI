"""Scoped SQLite import. No connection to the service is opened on import.

Analyze is read-only. Apply owns one IMMEDIATE transaction. Supplementary
shaft drawings never retire columns/beams/slabs or another shaft scope.
"""
from hashlib import sha256
import json
import sqlite3
import uuid
from .parser import DrawingError, TYPE

SCOPE = 'gp1-gp2'


def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def install_schema(conn):
    """Call from app/db.py migration, never from analyze. No implicit commit."""
    if 'height_mm' not in {r[1] for r in conn.execute('PRAGMA table_info(elements)')}:
        conn.execute('ALTER TABLE elements ADD COLUMN height_mm REAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS shaft_panel_geometry (
        element_id INTEGER PRIMARY KEY REFERENCES elements(id) ON DELETE CASCADE,
        object_id INTEGER NOT NULL REFERENCES objects(id),
        scope_key TEXT NOT NULL,
        physical_key TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(object_id, scope_key, physical_key)
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS shaft_panel_imports (
        id INTEGER PRIMARY KEY,
        object_id INTEGER NOT NULL REFERENCES objects(id),
        scope_key TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )''')


def load_target_axes(conn, object_id, source_file=None):
    """Read only the selected object's registered grids; never merge layouts."""
    rows = conn.execute('''SELECT a.kind,a.label,a.coord,a.source_file FROM axis_lines a
        JOIN object_drawings d ON d.source_file=a.source_file
        WHERE d.object_id=? AND (? IS NULL OR a.source_file=?)
        ORDER BY d.is_current DESC,d.imported_at DESC,a.source_file''',
        (object_id,source_file,source_file)).fetchall()
    by_source={}
    for r in rows:
        r=dict(r)
        by_source.setdefault(r['source_file'],{'numeric':{},'letter':{}})[r['kind']][r['label']]=r['coord']
    candidates=[(name,axes) for name,axes in by_source.items()
                if {'5','7'}<=set(axes['numeric']) and {'Е','Ж'}<=set(axes['letter'])]
    if not candidates:
        raise DrawingError('В выбранном объекте нет зарегистрированной сетки с осями 5, 7, Е, Ж')
    signatures={tuple(round(a[k][label],3) for k,label in [('numeric','5'),('numeric','7'),('letter','Е'),('letter','Ж')])
                for _,a in candidates}
    if len(signatures)>1:
        raise DrawingError('В объекте несколько разных сеток: укажите исходный чертеж для привязки')
    return candidates[0][1],candidates[0][0]


def _existing(conn, object_id, scope):
    return [dict(r) for r in conn.execute('''SELECT e.*,g.physical_key,g.metadata_json
        FROM shaft_panel_geometry g JOIN elements e ON e.id=g.element_id
        WHERE g.object_id=? AND g.scope_key=? ORDER BY e.id''',(object_id,scope))]


def _row(p,object_id,scope):
    return {'source_file':f'Панели шахт {scope} (объект {object_id}).dxf',
        'dxf_handle':'SP:'+digest([scope,p['physical_key']])[:24],
        'layer':f"Шахта {p['shaft']} / {p['face']}", 'element_type':TYPE,
        'mark':p['mark'],'mark_source':'shaft_dxf_'+p['mark_method'],
        'x':p['x'],'y':p['y'],'z':p['z'],'address':p['address'],'axis_status':'offset',
        'axis_number':None,'axis_letter':None,'nearest_axis_number':p['nearest_axis_number'],
        'nearest_axis_letter':p['nearest_axis_letter'],'offset_x_mm':p['offset_x_mm'],
        'offset_y_mm':p['offset_y_mm'],'outline_json':canonical(p['outline']),
        'subtype':None,'elevation_mm':p['elevation_mm'],'height_mm':p['height_mm'],
        'floor':None,'object_id':object_id}


def analyze(conn,object_id,placed,scope=SCOPE):
    obj=conn.execute('SELECT kind FROM objects WHERE id=?',(object_id,)).fetchone()
    if not obj or obj['kind']!='zhbi':
        raise DrawingError('Нужен существующий объект ЖБИ')
    if not scope or len(scope)>60 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in scope):
        raise DrawingError('Некорректная область импорта')
    if not placed.get('commit_ready'):
        raise DrawingError('Для записи объемов укажите подтвержденную толщину панели')
    if not placed.get('panels'):
        raise DrawingError('Пустой импорт запрещен')
    old=_existing(conn,object_id,scope); by_key={e['physical_key']:e for e in old}
    seen=set();new=[];updated=[];unchanged=[];conflicts=[]
    for p in placed['panels']:
        key=p['physical_key']
        if key in seen:
            raise DrawingError('Повтор идентификатора панели')
        seen.add(key); e=by_key.get(key); row=_row(p,object_id,scope)
        if not e:
            new.append(key); continue
        changed={k:[e.get(k),v] for k,v in row.items() if e.get(k)!=v}
        if e['object_id']!=object_id or e['element_type']!=TYPE:
            raise DrawingError('Нарушена область данных панели')
        if 'mark' in changed and e.get('contract_id') is not None:
            conflicts.append({'id':e['id'],'reason':'Смена марки законтрактованной панели: нужен штатный contract_guard'})
        manual=set(json.loads(e.get('manual_fields') or '[]'))
        if manual.intersection(changed):
            conflicts.append({'id':e['id'],'reason':'Расхождение ручных полей: требуется разрешить его в штатном редакторе'})
        (updated if changed or not e['is_current'] else unchanged).append({'id':e['id'],'physical_key':key,'changes':changed})
    missing=[{'id':e['id'],'physical_key':e['physical_key']} for e in old if e['is_current'] and e['physical_key'] not in seen]
    return {'object_id':object_id,'scope':scope,'state_digest':digest(old),'payload_digest':digest(placed),
            'new':new,'updated':updated,'unchanged':unchanged,'missing':missing,'conflicts':conflicts,
            'counts':{'new':len(new),'updated':len(updated),'unchanged':len(unchanged),'missing':len(missing)}}


def apply(conn,preview,placed,*,user_id,acknowledged_warnings=(),retire_missing=False,before_commit=None):
    """Use only a server-side preview after fresh ACL check and backup.

    before_commit(conn, object_id, changed_ids, summary) must not commit or
    open a second writer. Any hook failure rolls the whole import back.
    """
    if conn.in_transaction:
        raise DrawingError('Apply requires a connection with no open transaction')
    conn.execute('BEGIN IMMEDIATE')
    try:
        object_id=preview['object_id'];scope=preview['scope']
        if digest(placed)!=preview['payload_digest']:
            raise DrawingError('Результат распознавания изменился — повторите анализ')
        fresh=analyze(conn,object_id,placed,scope)
        if fresh['state_digest']!=preview['state_digest']:
            raise DrawingError('Данные изменились после анализа — повторите анализ')
        if fresh['conflicts']:
            raise DrawingError('Есть неразрешенные конфликты марки или ручных полей')
        required={w['code'] for w in placed['warnings']}
        if not required<=set(acknowledged_warnings):
            raise DrawingError('Подтвердите замечания к чертежу в предпросмотре')
        old={e['physical_key']:e for e in _existing(conn,object_id,scope)}
        changed=[]
        counts=fresh['counts'] | {'retired':len(fresh['missing']) if retire_missing else 0}
        updates={v['id'] for v in fresh['updated']}
        for p in placed['panels']:
            row=_row(p,object_id,scope);e=old.get(p['physical_key'])
            if e:
                element_id=e['id']
                if element_id in updates:
                    conn.execute('UPDATE elements SET '+','.join(f'{k}=?' for k in row)+
                        ",is_current=1,updated_at=datetime('now') WHERE id=? AND object_id=?",
                        (*row.values(),element_id,object_id))
                    changed.append(element_id)
            else:
                row['element_uid']=uuid.uuid4().hex
                cur=conn.execute('INSERT INTO elements ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
                element_id=cur.lastrowid;changed.append(element_id)
                conn.execute("INSERT INTO status_history (element_id,status,changed_by,comment) VALUES (?,'planned','import','Создан импортом панелей шахт')",(element_id,))
            conn.execute('''INSERT INTO shaft_panel_geometry
                (element_id,object_id,scope_key,physical_key,source_name,source_sha256,metadata_json)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(element_id) DO UPDATE SET
                source_name=excluded.source_name,source_sha256=excluded.source_sha256,metadata_json=excluded.metadata_json''',
                (element_id,object_id,scope,p['physical_key'],placed['source_file'],placed['source_sha256'],canonical(p)))
        if retire_missing:
            for e in fresh['missing']:
                conn.execute("UPDATE elements SET is_current=0,updated_at=datetime('now') WHERE id=? AND object_id=?",(e['id'],object_id))
                changed.append(e['id'])
        source=_row(placed['panels'][0],object_id,scope)['source_file']
        # Add an independent current drawing; do NOT call _register_drawing(),
        # which would set every other drawing of this building to inactive.
        conn.execute('''INSERT INTO object_drawings (object_id,source_file,is_current)
            VALUES (?,?,1) ON CONFLICT(object_id,source_file) DO UPDATE SET is_current=1,imported_at=datetime('now')''',(object_id,source))
        conn.execute('DELETE FROM axis_lines WHERE source_file=?',(source,))
        conn.executemany('INSERT INTO axis_lines (source_file,kind,label,coord) VALUES (?,?,?,?)',
                         [(source,kind,k,v) for kind,axes in placed['target_axes'].items() for k,v in axes.items()])
        # Common catalogs in this service, scoped to the target object.
        for mark in sorted({p['mark'] for p in placed['panels']}):
            conn.execute('INSERT OR IGNORE INTO marks (object_id,element_type,name) VALUES (?,?,?)',(object_id,TYPE,mark))
        conn.execute('''UPDATE elements SET mark_id=(SELECT m.id FROM marks m
            WHERE m.object_id=elements.object_id AND m.element_type=elements.element_type AND m.name=elements.mark)
            WHERE id IN (SELECT element_id FROM shaft_panel_geometry WHERE object_id=? AND scope_key=?)''',(object_id,scope))
        conn.execute('''INSERT INTO shaft_panel_imports
            (object_id,scope_key,user_id,source_name,source_sha256,summary_json) VALUES (?,?,?,?,?,?)''',
            (object_id,scope,user_id,placed['source_file'],placed['source_sha256'],canonical(counts)))
        if before_commit:
            before_commit(conn,object_id,changed,counts)
        conn.commit()
        return counts
    except BaseException:
        conn.rollback()
        raise
