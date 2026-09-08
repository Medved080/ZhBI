import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

import ezdxf
from app.shaft_panels import TYPE, DrawingError, parse_drawing, place_panels
from app.shaft_panels import storage
from app.shaft_panels.api import PendingStore
from fastapi import HTTPException

# ROOT — корень репозитория (../.. от feature_shaft_panels/tests): регрессия
# гоняет ЖИВОЙ подключённый модуль app.shaft_panels, а не копию в комплекте
# (её больше нет — единое ядро, см. feature_shaft_panels/CLAUDE_CODE.md §3).
# Запуск из корня: .venv/bin/python -m unittest discover -s feature_shaft_panels/tests -t . -v
ROOT=Path(__file__).resolve().parents[2]
DXF=Path(os.environ.get('SHAFT_DXF', ROOT/'Input/260908_ПП 5-7_Е-Ж.dxf'))


def database():
    c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.executescript('''
    CREATE TABLE objects(id INTEGER PRIMARY KEY,kind TEXT);
    INSERT INTO objects VALUES(1,'zhbi'),(2,'zhbi'),(3,'mfr');
    CREATE TABLE elements(id INTEGER PRIMARY KEY,source_file TEXT NOT NULL,dxf_handle TEXT NOT NULL,
      layer TEXT,element_type TEXT,mark TEXT,mark_source TEXT,x REAL,y REAL,z REAL,address TEXT,
      axis_status TEXT,axis_number TEXT,axis_letter TEXT,nearest_axis_number TEXT,nearest_axis_letter TEXT,
      offset_x_mm REAL,offset_y_mm REAL,outline_json TEXT,subtype TEXT,elevation_mm REAL,floor INTEGER,
      object_id INTEGER REFERENCES objects(id),element_uid TEXT,mark_id INTEGER,manual_fields TEXT,
      current_status TEXT DEFAULT 'planned',contract_id INTEGER,planned_delivery_date TEXT,
      is_current INTEGER DEFAULT 1,updated_at TEXT DEFAULT (datetime('now')),UNIQUE(source_file,dxf_handle));
    CREATE TABLE status_history(id INTEGER PRIMARY KEY,element_id INTEGER REFERENCES elements(id),status TEXT,changed_by TEXT,comment TEXT);
    CREATE TABLE marks(id INTEGER PRIMARY KEY,object_id INTEGER,element_type TEXT,name TEXT,UNIQUE(object_id,element_type,name));
    CREATE TABLE axis_lines(source_file TEXT,kind TEXT,label TEXT,coord REAL);
    CREATE TABLE object_drawings(object_id INTEGER,source_file TEXT,is_current INTEGER,imported_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(object_id,source_file));
    INSERT INTO elements(source_file,dxf_handle,element_type,object_id,current_status,contract_id,planned_delivery_date)
      VALUES('base.dxf','EXISTING','Колонна',1,'mounted',42,'2026-09-01');
    INSERT INTO object_drawings(object_id,source_file,is_current) VALUES(1,'base.dxf',1);
    ''')
    storage.install_schema(c);c.commit()
    return c


@unittest.skipUnless(DXF.exists(),'Use SHAFT_DXF to supply the real drawing')
class DrawingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.drawing=parse_drawing(DXF)
        cls.axes={'numeric':{'5':10000.,'7':19000.},'letter':{'Е':20000.,'Ж':32000.}}
        cls.surface=place_panels(cls.drawing,cls.axes)
        # 60 is a synthetic test input, NOT a measured product dimension.
        cls.placed=place_panels(cls.drawing,cls.axes,thickness_mm=60.)

    def test_real_inventory(self):
        d=self.drawing
        self.assertEqual(d['counts']['panels'],184);self.assertEqual(d['counts']['plan_contours'],13)
        self.assertEqual(len(d['counts']['by_mark']),30)
        self.assertEqual(d['counts']['by_method'],{'inside':161,'external_unique':23})
        self.assertEqual(sum(p['shaft']=='ГП1' for p in d['panels']),92)
        self.assertEqual(len({p['physical_key'] for p in d['panels']}),184)

    def test_exact_geometric_controls(self):
        p=next(p for p in self.surface['panels'] if p['handle']=='120B')
        self.assertEqual(p['mark'],'ПП7')
        self.assertAlmostEqual(p['front_xyz_mm'][0][0],10300.,places=2)
        self.assertAlmostEqual(p['front_xyz_mm'][0][1],22220.,places=2)
        self.assertEqual(p['z'],-110.);self.assertEqual(p['height_mm'],1130.)
        self.assertEqual(p['width_mm'],5700.)
        self.assertEqual(max(p['z']+p['height_mm'] for p in self.surface['panels']),31290.)

    def test_normals_and_jamb_labels(self):
        normals={p['face']:p['normal_xy'] for p in self.surface['panels']}
        self.assertEqual(normals,dict(zip('АБВГДЕЖИ',[[-1,0],[0,1],[1,0],[0,-1]]*2)))
        p=next(p for p in self.drawing['panels'] if p['handle']=='133B')
        self.assertEqual((p['mark'],p['face'],p['width_mm']),('ПП2','Б',150.))

    def test_units_and_bad_level_are_explicit(self):
        self.assertEqual(self.drawing['header_insunits'],1)
        self.assertEqual(next(l for l in self.drawing['levels'] if l['label']=='-0,800')['residual_mm'],680.)
        self.assertIn('header_units',{w['code'] for w in self.drawing['warnings']})

    def test_no_guessed_thickness(self):
        self.assertFalse(self.surface['commit_ready']);self.assertIsNone(self.surface['panels'][0]['outline'])
        # Санитарный потолок (500 мм) — от случайной лишней цифры, не от
        # реального значения: 300 мм подтверждено спецификацией изделия
        # 2026-09-08 и больше НЕ отклоняется (см. test_shared_wall_overlap_warning).
        with self.assertRaises(DrawingError):place_panels(self.drawing,self.axes,thickness_mm=3000)

    def test_shared_wall_overlap_warning(self):
        # Панель В (ГП1) и панель Д (ГП2) продолжаются друг на друга вглубь
        # ОДНОЙ общей стенки (~300 мм). Толщина изделия 300 мм — реальное
        # подтверждённое значение (2026-09-08) — их физически перекрывает;
        # предупреждение требует явного подтверждения, но не блокирует.
        placed=place_panels(self.drawing,self.axes,thickness_mm=300.)
        self.assertIn('shared_wall_overlap',{w['code'] for w in placed['warnings']})
        self.assertTrue(placed['commit_ready'])
        # Толщина заметно меньше половины стены — перекрытия нет, предупреждения тоже.
        thin=place_panels(self.drawing,self.axes,thickness_mm=60.)
        self.assertNotIn('shared_wall_overlap',{w['code'] for w in thin['warnings']})

    def test_axis_mismatch_and_nan_rejected(self):
        axes=copy.deepcopy(self.axes);axes['numeric']['7']+=100
        with self.assertRaises(DrawingError):place_panels(self.drawing,axes)
        axes['numeric']['7']=float('nan')
        with self.assertRaises(DrawingError):place_panels(self.drawing,axes)

    def test_mirror_registration(self):
        axes=copy.deepcopy(self.axes);axes['numeric']={'5':19000,'7':10000}
        p=place_panels(self.drawing,axes)['panels'][0]
        self.assertEqual(p['normal_xy'],[1,0])
        self.assertAlmostEqual(p['front_xyz_mm'][0][0],18700.,places=2)

    def test_corrupt_dxf(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'bad.dxf';path.write_text('broken')
            with self.assertRaises(DrawingError):parse_drawing(path)

    def test_missing_label_fails_instead_of_partial_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=ezdxf.readfile(DXF);d.modelspace().delete_entity(d.entitydb['1211'])
            path=Path(tmp)/'missing.dxf';d.saveas(path)
            with self.assertRaises(DrawingError):parse_drawing(path)

    def test_duplicate_panel_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=ezdxf.readfile(DXF);d.modelspace().add_entity(d.entitydb['120B'].copy())
            path=Path(tmp)/'duplicate.dxf';d.saveas(path)
            with self.assertRaises(DrawingError):parse_drawing(path)

    def setUp(self):self.c=database()
    def tearDown(self):self.c.close()
    def analyze(self,placed=None,obj=1):return storage.analyze(self.c,obj,placed or self.placed)
    def commit(self,preview=None,placed=None,**kw):
        placed=placed or self.placed
        return storage.apply(self.c,preview or self.analyze(placed),placed,user_id=1,
            acknowledged_warnings=[w['code'] for w in placed['warnings']],**kw)

    def test_schema_is_idempotent_and_analysis_is_readonly(self):
        storage.install_schema(self.c);count=self.c.total_changes
        self.analyze();self.assertEqual(self.c.total_changes,count)

    def test_initial_import_preserves_base_drawing(self):
        self.assertEqual(self.commit()['new'],184)
        e=self.c.execute('SELECT * FROM elements WHERE id=1').fetchone()
        self.assertEqual((e['current_status'],e['contract_id'],e['planned_delivery_date'],e['is_current']),('mounted',42,'2026-09-01',1))
        self.assertEqual(self.c.execute('SELECT is_current FROM object_drawings WHERE source_file="base.dxf"').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM marks').fetchone()[0],30)
        self.assertEqual(self.c.execute('SELECT count(*) FROM status_history').fetchone()[0],184)

    def test_reimport_does_not_reset_state_or_duplicate(self):
        self.commit();self.c.execute("UPDATE elements SET current_status='mounted',contract_id=7,planned_delivery_date='2026-10-01' WHERE id=2");self.c.commit()
        r=self.commit();self.assertEqual((r['new'],r['unchanged']),(0,184))
        self.assertEqual(self.c.execute('SELECT current_status FROM elements WHERE id=2').fetchone()[0],'mounted')
        self.assertEqual(self.c.execute('SELECT count(*) FROM elements').fetchone()[0],185)
        self.assertEqual(self.c.execute('SELECT count(*) FROM status_history').fetchone()[0],184)

    def test_rename_file_and_handles_does_not_duplicate(self):
        self.commit();d=copy.deepcopy(self.placed);d['source_file']='new.dxf'
        for p in d['panels']:p['handle']='new-'+p['handle']
        self.assertEqual(self.commit(placed=d)['new'],0)

    def test_another_object_has_independent_identity(self):
        self.commit();r=self.commit(preview=self.analyze(obj=2));self.assertEqual(r['new'],184)

    def test_stale_preview_rejected(self):
        self.commit();p=self.analyze();self.c.execute("UPDATE elements SET current_status='delivered' WHERE id=2");self.c.commit()
        with self.assertRaises(DrawingError):self.commit(preview=p)

    def test_tampered_payload_rejected(self):
        p=self.analyze();d=copy.deepcopy(self.placed);d['panels'][0]['mark']='ПП999'
        with self.assertRaises(DrawingError):self.commit(preview=p,placed=d)

    def test_transaction_rolls_back_on_host_hook_failure(self):
        def fail(*args):raise RuntimeError('hook failure')
        with self.assertRaises(RuntimeError):self.commit(before_commit=fail)
        self.assertEqual(self.c.execute('SELECT count(*) FROM elements').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM shaft_panel_geometry').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT count(*) FROM marks').fetchone()[0],0)

    def test_retirement_is_explicit_and_scoped(self):
        self.commit();d=copy.deepcopy(self.placed);d['panels']=d['panels'][1:]
        self.assertEqual(self.commit(placed=d)['retired'],0)
        self.assertEqual(self.commit(placed=d,retire_missing=True)['retired'],1)
        self.assertEqual(self.c.execute('SELECT is_current FROM elements WHERE id=1').fetchone()[0],1)

    def test_contract_change_and_manual_change_are_conflicts(self):
        self.commit();self.c.execute('UPDATE elements SET contract_id=4 WHERE id=2');self.c.commit()
        d=copy.deepcopy(self.placed);d['panels'][0]['mark']='ПП999'
        self.assertTrue(self.analyze(d)['conflicts'])
        with self.assertRaises(DrawingError):self.commit(placed=d)
        self.c.execute('UPDATE elements SET manual_fields=?,address=? WHERE id=2',(json.dumps(['address']),'manual'));self.c.commit()
        self.assertTrue(self.analyze()['conflicts'])

    def test_mfr_and_warning_bypass_rejected(self):
        with self.assertRaises(DrawingError):self.analyze(obj=3)
        with self.assertRaises(DrawingError):storage.apply(self.c,self.analyze(),self.placed,user_id=1)


    def test_standard_import_cannot_retire_panels(self):
        from types import SimpleNamespace
        from app import shaft_panels_scope as helpers
        self.commit()
        rows=[dict(r) for r in self.c.execute('SELECT * FROM elements')]
        self.assertEqual([r['id'] for r in helpers.exclude_shaft_panels(self.c,1,rows)],[1])
        with self.assertRaises(ValueError):
            helpers.assert_standard_match(self.c,1,SimpleNamespace(matched=[],retired_ids=[2]))
        helpers.assert_standard_match(self.c,1,SimpleNamespace(matched=[],retired_ids=[1]))

    def test_primary_drawing_registration_preserves_supplement(self):
        from app import shaft_panels_scope as helpers
        self.commit()
        helpers.register_primary_drawing(self.c,1,'base-v2.dxf')
        current=helpers.current_drawing_sources(self.c,1)
        self.assertEqual(len(current),2)
        self.assertIn('base-v2.dxf',current)
        self.assertNotIn('base.dxf',current)
        supplement=next(name for name in current if name!='base-v2.dxf')
        with self.assertRaises(ValueError):helpers.register_primary_drawing(self.c,1,supplement)


class TokenTests(unittest.TestCase):
    def test_owner_and_one_time_contract(self):
        s=PendingStore();t=s.put(1,1,{'value':42})
        with self.assertRaises(HTTPException) as caught:s.get(t,2)
        self.assertEqual(caught.exception.status_code,403)
        self.assertEqual(s.get(t,1)['payload']['value'],42)
        s.items.pop(t)
        with self.assertRaises(HTTPException):s.get(t,1)

    def test_ttl_and_capacity(self):
        s=PendingStore(ttl=-1);t=s.put(1,1,{})
        with self.assertRaises(HTTPException):s.get(t,1)
        s=PendingStore(limit=1);s.put(1,1,{})
        with self.assertRaises(HTTPException) as caught:s.put(1,1,{})
        self.assertEqual(caught.exception.status_code,429)



@unittest.skipUnless(DXF.exists(),'Use SHAFT_DXF to supply the real drawing')
class ApiTests(unittest.TestCase):
    def setUp(self):
        from fastapi import FastAPI
        from app.shaft_panels.api import build_router
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'test.db'
        c=database();c2=sqlite3.connect(self.path);c.backup(c2);c.close()
        axes={'numeric':{'5':10000,'7':19000},'letter':{'Е':20000,'Ж':32000}}
        c2.executemany('INSERT INTO axis_lines VALUES(?,?,?,?)',[('base.dxf',kind,k,v) for kind,a in axes.items() for k,v in a.items()]);c2.commit();c2.close()
        def connection():
            c=sqlite3.connect(self.path);c.row_factory=sqlite3.Row;return c
        def access(c,user,oid):
            if oid!=1:raise HTTPException(403,'denied')
        self.backups=[];self.hooks=[]
        app=FastAPI();app.include_router(build_router(connection_factory=connection,get_user=lambda:{'id':1},
            assert_access=access,backup=lambda user,oid:self.backups.append(oid),
            before_commit=lambda c,user,oid,ids,summary:self.hooks.append(len(ids))))
        self.client=AsgiClient(app)

    def tearDown(self):self.client.close();self.tmp.cleanup()
    def upload(self,obj=1,thickness=None):
        data={'object_id':str(obj)}
        if thickness is not None:data['thickness_mm']=str(thickness)
        return self.client.post('/shaft-panels/analyze',data=data,files={'file':('drawing.dxf',DXF.read_bytes(),'application/octet-stream')})

    def test_acl_before_parsing(self):
        r=self.upload(obj=2);self.assertEqual(r.status_code,403);self.assertEqual(self.backups,[])

    def test_surface_preview_and_thickness_block(self):
        r=self.upload();self.assertEqual(r.status_code,200,r.text)
        d=r.json();self.assertIsNone(d['analysis'])
        self.assertEqual(self.client.post('/shaft-panels/apply',json={'token':d['token']}).status_code,409)

    def test_full_http_import_and_consumed_token(self):
        r=self.upload(thickness=60);self.assertEqual(r.status_code,200,r.text);d=r.json()
        body={'token':d['token'],'acknowledged_warnings':[w['code'] for w in d['drawing']['warnings']]}
        applied=self.client.post('/shaft-panels/apply',json=body)
        self.assertEqual(applied.status_code,200,applied.text);self.assertEqual(applied.json()['new'],184)
        self.assertEqual(self.backups,[1]);self.assertEqual(self.hooks,[184])
        self.assertEqual(self.client.post('/shaft-panels/apply',json=body).status_code,410)


class AsgiClient:
    """Tiny in-process HTTP driver so tests need no httpx dependency."""
    def __init__(self,app):self.app=app
    def close(self):pass
    def post(self,path,*,json=None,data=None,files=None):
        import asyncio
        import json as js
        from types import SimpleNamespace
        headers=[]
        if files:
            boundary='shaft-test-boundary'
            chunks=[]
            for k,v in (data or {}).items():
                chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
            for k,(name,content,mime) in files.items():
                chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode()+content+b'\r\n')
            chunks.append(f'--{boundary}--\r\n'.encode());body=b''.join(chunks)
            headers.append((b'content-type',f'multipart/form-data; boundary={boundary}'.encode()))
        else:
            body=js.dumps(json).encode();headers.append((b'content-type',b'application/json'))
        headers.append((b'content-length',str(len(body)).encode()))
        messages=[]
        async def run():
            consumed=False
            async def receive():
                nonlocal consumed
                if consumed:return {'type':'http.disconnect'}
                consumed=True;return {'type':'http.request','body':body,'more_body':False}
            async def send(value):messages.append(value)
            await self.app({'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','scheme':'http',
                'method':'POST','path':path,'raw_path':path.encode(),'root_path':'','query_string':b'',
                'headers':headers,'server':('test',80),'client':('127.0.0.1',1)},receive,send)
        asyncio.run(run())
        text=b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body').decode()
        return SimpleNamespace(status_code=next(m['status'] for m in messages if m['type']=='http.response.start'),
                               text=text,json=lambda:js.loads(text))


if __name__=='__main__':unittest.main()
