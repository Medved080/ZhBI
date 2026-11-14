"""Work group entry points on a disposable database, including legacy writers."""
import json
import os
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
TEMP=tempfile.TemporaryDirectory(prefix='work-groups-')
os.environ['ZHBI_DB_PATH']=str(Path(TEMP.name)/'test.db')
from app import db, work_groups as wg
from app import work_groups_api as api
from fastapi import HTTPException


class WorkGroupsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.admin={'role':'admin','id':1,'last_name':'Тест','first_name':'','patronymic':''}

    def setUp(self):
        self.conn=db.get_connection()
        c=self.conn
        project=c.execute('INSERT INTO projects(name) VALUES (?)',(os.urandom(8).hex(),)).lastrowid
        self.oid=c.execute("INSERT INTO objects(name,project_id,kind) VALUES (?,?,'zhbi')",(os.urandom(8).hex(),project)).lastrowid
        wg.ensure_object(c,self.oid)
        self.gs=wg.groups(c,self.oid);self.base,self.facade=[g['id'] for g in self.gs]
        self.ids=[self.element('Колонна',None,0),self.element('Панель','фасадная',15000),self.element('Панель','фасадная',25800)]
        c.commit()

    def tearDown(self): self.conn.close()

    def element(self,kind,subtype,elevation):
        return self.conn.execute('''INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark_source,x,y,axis_status,object_id,subtype,elevation_mm,outline_json,is_current) VALUES (?,?,?,?,'test',5,5,'matched',?,?,?, ?,1)''',
                                 ('test.dxf',os.urandom(8).hex(),'test',kind,self.oid,subtype,elevation,json.dumps([[4,4],[6,4],[6,6],[4,6]]))).lastrowid

    def action(self,payload):
        p=api.action(self.oid,payload|{'preview':True},self.admin)
        return api.action(self.oid,payload|{'expected_hash':p['expected_hash']},self.admin)

    def zone(self,gid,name='Захватка 1',low=None,high=None):
        self.action({'action':'zone','zone':{'work_group_id':gid,'name':name,'number':1,'levels':[{'outline':[[0,0],[10,0],[10,10],[0,10]],'elevation_mm':low,'upper_elevation_mm':high}]}})
        return self.conn.execute("SELECT id FROM zones WHERE object_id=? AND work_group_id=? ORDER BY id DESC",(self.oid,gid)).fetchone()[0]

    def read(self,eid):return dict(self.conn.execute('SELECT * FROM elements WHERE id=?',(eid,)).fetchone())

    def test_default_groups_and_trigger_classification(self):
        self.assertEqual([self.read(i)['work_group_id'] for i in self.ids],[self.base,self.facade,self.facade])
        self.assertEqual(len(self.gs),2)

    def test_same_contour_and_number_in_two_groups(self):
        a=self.zone(self.base); b=self.zone(self.facade)
        self.assertEqual([self.read(i)['zone_zakhvatka_id'] for i in self.ids],[a,b,b])

    def test_elevation_band_and_null_floor(self):
        b=self.zone(self.facade,low=15000,high=25800)
        self.assertEqual(self.read(self.ids[1])['zone_zakhvatka_id'],b)
        self.assertIsNone(self.read(self.ids[2])['zone_zakhvatka_id'])

    def test_preview_is_read_only_and_stale_apply_fails(self):
        body={'action':'zone','zone':{'work_group_id':self.facade,'name':'Фасад','levels':[]}}
        p=api.action(self.oid,body|{'preview':True},self.admin)
        self.assertFalse(self.conn.execute('SELECT 1 FROM zones WHERE object_id=?',(self.oid,)).fetchone())
        self.conn.execute('UPDATE elements SET x=6 WHERE id=?',(self.ids[1],));self.conn.commit()
        with self.assertRaises(HTTPException) as exc:api.action(self.oid,body|{'expected_hash':p['expected_hash']},self.admin)
        self.assertEqual(exc.exception.status_code,409)

    def test_manual_assignment_legacy_import_and_reset(self):
        z=self.zone(self.facade)
        self.action({'action':'assign','zone_id':z,'element_ids':[self.ids[1]]})
        e=self.read(self.ids[1]);self.assertEqual(e['capture_assignment_mode'],'manual')
        self.conn.execute("UPDATE elements SET x=999,outline_json='[[998,4],[1000,4],[1000,6],[998,6]]' WHERE id=?",(e['id'],));self.conn.commit()
        from scripts.import_elements import apply_zone_bindings
        from scripts.zone_binding import ZoneBindingResult
        from types import SimpleNamespace
        record=SimpleNamespace(id=e['dxf_handle'],zone_bindings={'Захватка':ZoneBindingResult(None,'unmatched')})
        apply_zone_bindings(self.conn,'test.dxf',[record],{})
        self.assertEqual(self.read(e['id'])['zone_zakhvatka_id'],z)
        self.action({'action':'auto','element_ids':[e['id']]})
        self.assertEqual(self.read(e['id'])['capture_assignment_mode'],'auto')
        self.assertIsNone(self.read(e['id'])['zone_zakhvatka_id'])

    def test_type_change_invalidates_cross_group_manual(self):
        z=self.zone(self.facade)
        self.action({'action':'assign','zone_id':z,'element_ids':[self.ids[1]]})
        self.conn.execute("UPDATE elements SET subtype='другая' WHERE id=?",(self.ids[1],));self.conn.commit()
        e=self.read(self.ids[1]);self.assertEqual(e['work_group_id'],self.base);self.assertIsNone(e['zone_zakhvatka_id'])

    def test_cross_group_and_foreign_object_rejected(self):
        z=self.zone(self.base)
        for ids in ([self.ids[1]],[987654321]):
            with self.assertRaises(HTTPException): self.action({'action':'assign','zone_id':z,'element_ids':ids})

    def test_conflicting_rules_and_future_type_overlap_rejected(self):
        rules=deepcopy(wg.DEFAULT_GROUPS)
        rules.append({'key':'extra','name':'Другая','rules':[{'element_type':'*','subtype':'фасадная'}]})
        rules[1]['rules']=[{'element_type':'Панель','subtype':'*'}]
        with self.assertRaises(HTTPException):wg.validate(rules)

    def test_template_merges_independent_object_edits(self):
        local=wg.definition(self.gs);local[0]['name']='Каркас объекта'
        self.action({'action':'groups','groups':local})
        remote=deepcopy(wg.DEFAULT_GROUPS);remote[1]['name']='Фасад шаблона'
        api.save_template({'revision':wg.template(self.conn)['revision'],'groups':remote},self.admin)
        self.action({'action':'template_apply'})
        self.assertEqual([g['name'] for g in wg.groups(self.conn,self.oid)],['Каркас объекта','Фасад шаблона'])

    def test_template_conflict_requires_choice(self):
        local=wg.definition(self.gs);local[1]['name']='Местный фасад'
        self.action({'action':'groups','groups':local})
        remote=deepcopy(wg.template(self.conn)['groups']);remote[1]['name']='Новый общий фасад'
        api.save_template({'revision':wg.template(self.conn)['revision'],'groups':remote},self.admin)
        p=api.action(self.oid,{'action':'template_apply','preview':True},self.admin)
        self.assertEqual(p['conflicts'][0]['key'],'facade')
        self.action({'action':'template_apply','choices':{'facade':'local'}})
        self.assertEqual(wg.groups(self.conn,self.oid)[1]['name'],'Местный фасад')

    def test_migration_idempotent_and_remembers_facade_binding(self):
        project=self.conn.execute('SELECT project_id FROM objects WHERE id=?',(self.oid,)).fetchone()[0]
        old=self.conn.execute("INSERT INTO objects(name,project_id,kind) VALUES (?,?,'zhbi')",(os.urandom(8).hex(),project)).lastrowid
        e=self.conn.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark_source,x,y,axis_status,object_id,subtype) VALUES ('legacy',?,'x','Панель','test',1,1,'matched',?,'фасадная')",(os.urandom(8).hex(),old)).lastrowid
        z=self.conn.execute("INSERT INTO zones(source_file,dxf_handle,category,object_id,name,outline_json) VALUES ('legacy',?,'Захватка',?,'№ 1','[]')",(os.urandom(8).hex(),old)).lastrowid
        self.conn.execute("UPDATE elements SET zone_zakhvatka_id=?,zone_zakhvatka_status='matched' WHERE id=?",(z,e))
        wg.migrate(self.conn); self.conn.commit()
        h=self.conn.execute('SELECT before_json FROM work_group_history WHERE element_id=?',(e,)).fetchone()
        self.assertEqual(json.loads(h[0])['zone_zakhvatka_id'],z)
        self.assertIsNone(self.read(e)['zone_zakhvatka_id'])
        before=list(self.conn.execute('SELECT * FROM work_groups'));wg.migrate(self.conn)
        self.assertEqual([tuple(r) for r in before],[tuple(r) for r in self.conn.execute('SELECT * FROM work_groups')])
        self.assertFalse(self.conn.execute('PRAGMA foreign_key_check').fetchall())

    def test_user_contours_survive_dxf_sync(self):
        z=self.zone(self.facade)
        from app.zone_sync import sync_zones
        sync_zones(self.conn,self.oid,'new.dxf',[],allowed_categories={'Захватка'})
        self.assertEqual(self.conn.execute('SELECT is_current FROM zones WHERE id=?',(z,)).fetchone()[0],1)

    def test_undo_geometry_preserves_later_manual_assignment(self):
        zid=self.zone(self.facade)
        zone=next(z for z in wg.zone_catalog(self.conn,self.oid) if z['id']==zid)
        zone['levels'][0]['outline']=[[100,100],[110,100],[110,110],[100,110]]
        self.action({'action':'zone','zone':zone})
        history_id=self.conn.execute("SELECT MAX(id) FROM work_group_history WHERE object_id=? AND action='zone'",(self.oid,)).fetchone()[0]
        self.action({'action':'assign','zone_id':zid,'element_ids':[self.ids[1]]})
        self.action({'action':'undo_zone','history_id':history_id})
        element=self.read(self.ids[1])
        self.assertEqual(element['zone_zakhvatka_id'],zid)
        self.assertEqual(element['capture_assignment_mode'],'manual')
        self.assertEqual(wg.zone_catalog(self.conn,self.oid)[0]['levels'][0]['outline'],[[0,0],[10,0],[10,10],[0,10]])

    def test_rename_preserves_assignments_and_manual_mode(self):
        zid=self.zone(self.facade)
        self.action({'action':'assign','zone_id':zid,'element_ids':[self.ids[1]]})
        before=wg.binding(self.read(self.ids[1]))
        items=wg.definition(self.gs);items[1]['name']='Фасадные работы'
        self.action({'action':'groups','groups':items})
        self.assertEqual(wg.binding(self.read(self.ids[1])),before)

    def test_viewer_cannot_change_settings_or_template(self):
        viewer={'id':99999999,'role':'view','last_name':'Тест','first_name':''}
        for call in [lambda:api.save_template({'revision':1,'groups':wg.DEFAULT_GROUPS},viewer),
                     lambda:api.action(self.oid,{'action':'auto','element_ids':self.ids,'preview':True},viewer)]:
            with self.assertRaises(HTTPException) as exc:call()
            self.assertEqual(exc.exception.status_code,403)

    def test_legacy_zone_edit_respects_group_numbers_and_manual_assignment(self):
        self.zone(self.base)
        zid=self.zone(self.facade,low=15000,high=25800)
        self.action({'action':'assign','zone_id':zid,'element_ids':[self.ids[1]]})
        from app.main import update_zone,undo_zone_edit
        from app.models import ZonePatchIn
        body=ZonePatchIn(name='Новое название',number=1,levels=[{'elevation_mm':15000,'outline':[[0,0],[20,0],[20,20],[0,20]]}])
        update_zone(zid,body,self.admin)
        self.assertEqual(wg.zone_catalog(self.conn,self.oid)[1]['levels'][0]['upper_elevation_mm'],25800)
        self.assertEqual(self.read(self.ids[1])['capture_assignment_mode'],'manual')
        self.assertTrue(undo_zone_edit(zid,self.admin)['restored'])

    def test_dictionary_replacement_respects_work_group(self):
        base=self.zone(self.base);facade=self.zone(self.facade)
        from app.dict_delete import _zone_candidates,_zone_repoint
        old=self.conn.execute('SELECT * FROM zones WHERE id=?',(base,)).fetchone()
        target=self.conn.execute('SELECT * FROM zones WHERE id=?',(facade,)).fetchone()
        self.assertNotIn(str(facade),[r['key'] for r in _zone_candidates(self.conn,old,None)])
        with self.assertRaises(HTTPException):_zone_repoint(self.conn,old,target)

    def test_plan_labels_include_manual_captures_without_geometry(self):
        source=f'capture-labels-{self.oid}.dxf'
        self.conn.execute('UPDATE elements SET source_file=? WHERE object_id=?',(source,self.oid))
        self.conn.execute('INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,?,1)',(self.oid,source))
        self.conn.commit()
        self.action({'action':'zone','zone':{'work_group_id':self.facade,'name':'Ось 1','number':1,'levels':[]}})
        zid=self.conn.execute('SELECT id FROM zones WHERE object_id=?',(self.oid,)).fetchone()[0]
        self.action({'action':'assign','zone_id':zid,'element_ids':[self.ids[1]]})
        from app.main import plan_data
        from app.models import PlanSelectionIn
        response=plan_data(PlanSelectionIn(selection=[{'object_id':self.oid}]),self.admin)
        payload=json.loads(response.body)
        labels=[z for z in payload['zone_labels'] if z['category']=='Захватка']
        self.assertEqual([(z['number'],z['name']) for z in labels],[(1,'Ось 1')])
        self.assertEqual(payload['zones'],[])
        element=next(e for e in payload['elements'] if e['id']==self.ids[1])
        self.assertEqual(element['zone_zakhvatka_id'],labels[0]['id'])


if __name__=='__main__':unittest.main()
