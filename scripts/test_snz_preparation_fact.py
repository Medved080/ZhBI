"""Preparation operation facts and closure must never change installation."""
import unittest
from datetime import date
from pathlib import Path
from io import BytesIO
import test_snz as fixtures
from fastapi import HTTPException


class PreparationFactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.base=fixtures.IntegrationTests
        cls.snz=cls.base.snz;cls.db=cls.base.db;cls.object_id=cls.base.object_id;cls.admin=cls.base.admin;cls.ids=cls.base.ids

    def setUp(self):
        self.base().setUp()
        c=self.db.get_connection();c.execute('DELETE FROM status_history');c.execute('DELETE FROM snz_order_revisions');c.commit();c.close()
        state,_=fixtures.fixture(self.ids,(('prepare',20,0),('install',20,0)),shift='night')
        for a in state['assignments'][2:]:a.update(date='2026-11-11',shift='day')
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        self.orders={}
        for shift,crew in [('day','preparation'),('night','preparation'),('night','install1')]:
            params=dict(revision=self.state()['revision'],date='2026-11-10',shift=shift,crew_id=crew,ignore_fact=True)
            plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
            self.orders[shift,crew]=self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id=shift+'-'+crew,expected_hash=plan['fingerprint']),self.admin)['id']

    def state(self):return self.snz.get_state(self.object_id,self.admin)
    def rows(self,shift='day',**kwargs):return self.snz.montage_facts(self.object_id,date(2026,11,10),shift,'preparation',user=self.admin,**kwargs)
    def complete(self,row=None):
        row=row or self.rows()['preparation_items'][0]
        return self.snz.complete(self.object_id,self.snz.FactIn(revision=self.state()['revision'],task_key=row['tasks'][0]['key'],order_id=row['orders'][0]['id'],completed_at='2026-11-10T11:10:00'),self.admin)
    def close(self,shift='day',crew='preparation',request='prep-close'):
        p=self.snz.preview_close_orders(self.object_id,date(2026,11,10),shift,crew,self.admin)
        body=self.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift=shift,crew_id=crew,expected_hash=p['fingerprint'],request_id=request)
        return body,self.snz.close_issued_orders(self.object_id,body,self.admin)
    def elements(self):
        c=self.db.get_connection()
        try:return [tuple(r) for r in c.execute('SELECT id,current_status,planned_installation_date FROM elements ORDER BY id')]
        finally:c.close()

    def test_preparation_fact_is_separate_and_filtered(self):
        before=self.elements();row=self.rows()['preparation_items'][0];self.assertFalse(self.rows()['items'])
        self.complete(row);updated=next(r for r in self.rows()['preparation_items'] if r['id']==row['id'])
        self.assertTrue(updated['completed']);self.assertEqual(updated['completed_at'],'2026-11-10T11:10:00')
        other=next(r for r in self.rows('night')['preparation_items'] if r['id']==row['id'])
        self.assertFalse(other['completed']);self.assertEqual(other['tasks'][0]['attributed_order_id'],row['orders'][0]['id'])
        with self.assertRaises(HTTPException):self.complete(other)
        self.assertNotIn(row['id'],{r['id'] for r in self.rows(without_fact=True)['preparation_items']})
        self.assertFalse(self.snz.montage_facts(self.object_id,date(2026,11,10),'day','install2',user=self.admin)['preparation_items'])
        self.assertEqual(self.elements(),before)
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],0);c.close()
        note=row['orders'][0]['note_key']
        self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=self.state()['revision'],element_id=row['id'],note_key=note,text='Подготовлена опалубка'),self.admin)
        self.assertEqual(self.rows()['preparation_items'][0]['orders'][0]['note'],'Подготовлена опалубка')

    def test_closure_freezes_preparation_without_releasing_installation(self):
        row=self.rows()['preparation_items'][0];self.complete(row);before=self.elements();assigned=self.state()['state']['assignments']
        body,result=self.close();self.assertEqual(result['released_element_ids'],[])
        self.assertTrue(self.snz.close_issued_orders(self.object_id,body,self.admin)['already_closed'])
        self.assertEqual(self.state()['state']['assignments'],assigned);self.assertEqual(self.elements(),before)
        self.assertTrue(all(r['closed'] for r in self.rows()['preparation_items']))
        self.assertEqual([o['id'] for o in self.state()['orders'] if o['closed_at']],[self.orders['day','preparation']])
        with self.assertRaises(HTTPException):self.complete(row)
        pending=next(r for r in self.rows()['preparation_items'] if not r['completed'])
        later=next(r for r in self.rows('night')['preparation_items'] if r['id']==pending['id'])
        self.complete(later)
        self.assertFalse(next(r for r in self.rows()['preparation_items'] if r['id']==pending['id'])['completed'])
        with self.assertRaises(HTTPException):self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=self.state()['revision'],element_id=row['id'],note_key=row['orders'][0]['note_key'],text='Позднее'),self.admin)
        oid=self.orders['day','preparation']
        with self.assertRaises(HTTPException):self.snz.delete_issued_order(self.object_id,oid,self.snz.DeleteOrderIn(revision=self.state()['revision'],order_revision=1,request_id='delete-prep'),self.admin)

    def test_installation_does_not_confirm_preparation_and_can_close_independently(self):
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,self.ids[0],'installed',False,None,'2026-11-10 21:00:00','','Test',self.admin['id']);c.commit();c.close()
        self.assertFalse(self.rows()['preparation_items'][0]['completed'])
        _,result=self.close('night','install1','montage-close')
        self.assertEqual(result['released_element_ids'],[self.ids[1]])
        self.assertFalse(any(o['closed_at'] for o in self.state()['orders'] if o['crew_kind']=='preparation'))

    def test_reports_include_frozen_preparation_and_native_tables(self):
        from app.snz_fact_report import report
        from app.snz_daily_report import collect
        from openpyxl import load_workbook
        self.complete();self.close()
        c=self.db.get_connection();state,_=self.snz._load(c,self.object_id)
        data=report(c,self.object_id,state,'2026-11-10','day','preparation');daily=collect(c,self.object_id,state,'2026-11-10');c.close()
        self.assertEqual((data['registry']['planned'],data['registry']['completed']),(2,1))
        self.assertEqual(next(r for r in daily['registry']['orders'] if r['id']==self.orders['day','preparation'])['completed'],1)
        out=Path(__file__).resolve().parents[1]/'outputs/snz-preparation';out.mkdir(parents=True,exist_ok=True)
        for name,payload in [('facts',self.snz.export_fact_xlsx(self.object_id,date(2026,11,10),crew_id='preparation',user=self.admin).body),
                             ('daily',self.snz.export_registry(self.object_id,date(2026,11,10),self.admin).body)]:
            wb=load_workbook(BytesIO(payload));self.assertIn('Подготовка',wb.sheetnames);self.assertIn('SNZPreparationFacts',wb['Подготовка'].tables)
            self.assertEqual(wb['Подготовка']['B2'].data_type,'d');self.assertEqual(wb['Подготовка']['B2'].number_format,'dd.mm.yyyy')
            self.assertEqual(wb['Подготовка']['M2'].data_type,'d');self.assertEqual(wb['Подготовка']['M2'].number_format,'dd.mm.yyyy hh:mm:ss')
            self.assertEqual(wb['Подготовка']['L2'].value,1);(out/f'{name}.xlsx').write_bytes(payload)

    def test_stale_preview_rights_and_object_are_checked(self):
        p=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','preparation',self.admin);self.complete()
        with self.assertRaises(HTTPException):self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift='day',crew_id='preparation',expected_hash=p['fingerprint'],request_id='stale-prep'),self.admin)
        c=self.db.get_connection();uid=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Viewer','prep-viewer','view')").lastrowid;c.commit();viewer=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();c.close()
        with self.assertRaises(HTTPException):self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','preparation',viewer)
        self.assertFalse(self.snz.montage_facts(self.base.other_id,date(2026,11,10),'day','preparation',user=self.admin)['preparation_items'])

    def test_unfinished_preparation_remains_in_next_schedule(self):
        row=self.rows()['preparation_items'][0];self.complete(row);self.close()
        pending=next(r for r in self.rows()['preparation_items'] if not r['completed'])
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=self.state()['revision'],date='2026-11-11',shift='night',crew_id='preparation'),self.admin)
        self.assertIn(pending['tasks'][0]['key'],{t['key'] for t in plan['tasks']})
        self.assertNotIn(row['tasks'][0]['key'],{t['key'] for t in plan['tasks']})


if __name__=='__main__':unittest.main(verbosity=2)
