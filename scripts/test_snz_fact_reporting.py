"""Daily facts, independent notes and extra montage; disposable synthetic database only."""
import sys
import unittest
from pathlib import Path
from datetime import datetime,date
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures
from fastapi import HTTPException


class ReportingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.base=fixtures.IntegrationTests
        from app import snz
        cls.snz=snz;cls.db=cls.base.db;cls.object_id=cls.base.object_id;cls.admin=cls.base.admin
        c=cls.db.get_connection()
        e=fixtures.element(5)
        cls.extra=c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,'delivered')",(e['source_file'],'extra','snz',e['element_type'],'Доп-5',e['x'],e['y'],cls.object_id,1,e['outline_json'])).lastrowid
        c.commit();c.close()

    def setUp(self):
        self.base().setUp()
        c=self.db.get_connection();c.execute('DELETE FROM status_history');c.execute("UPDATE elements SET current_status='ready_for_installation',actual_delivery_date=NULL");c.commit();c.close()
        state,_=fixtures.fixture(tuple(self.base.ids),(('install',20,0),))
        state['assignments'][2]['shift']='night';state['assignments'][3]['shift']='night'
        state['floor_levels']=[{'floor':1,'elevation_mm':5000}]
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        self.orders=[]
        for shift in ('day','night'):
            revision=self.state()['revision'];params={'revision':revision,'date':'2026-11-10','shift':shift,'crew_id':'install1','ignore_fact':True}
            plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
            self.orders.append(self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id='issue-'+shift,expected_hash=plan['fingerprint']),self.admin)['id'])

    def state(self):return self.snz.get_state(self.object_id,self.admin)
    def rows(self,**kwargs):return self.snz.montage_facts(self.object_id,user=self.admin,**kwargs)
    def extra_body(self,**kwargs):
        data=self.snz.extra_fact_candidates(self.object_id,date(2026,11,10),self.admin)
        item=next(r for r in data['items'] if r['id']==self.extra)
        return self.snz.ExtraFactIn(**{'revision':data['revision'],'date':'2026-11-10','crew_id':'install1','completed_at':'2026-11-11T01:30:00','request_id':'extra-test','items':[{'element_id':self.extra,'expected_rev':item['expected_rev']}],**kwargs})

    def test_extra_is_separate_atomic_idempotent_and_in_night_report(self):
        body=self.extra_body();before=self.state();result=self.snz.complete_extra_fact(self.object_id,body,self.admin)
        self.assertEqual(result['installed'],[self.extra]);self.assertTrue(self.snz.complete_extra_fact(self.object_id,body,self.admin)['already_completed'])
        after=self.state();self.assertEqual(before['orders'],after['orders']);self.assertEqual(before['state']['assignments'],after['state']['assignments'])
        rows=self.rows(date=date(2026,11,10),shift='night')['items'];extra=next(r for r in rows if r['id']==self.extra)
        self.assertTrue(extra['status_confirmed']);self.assertEqual(extra['completed_at'],'2026-11-11T01:30:00');self.assertFalse(extra['orders'])
        self.assertNotIn(self.extra,{r['id'] for r in self.rows(date=date(2026,11,11))['items']})
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history WHERE element_id=?',(self.extra,)).fetchone()[0],1);c.close()

    def test_note_persists_through_planning_and_does_not_change_status(self):
        row=self.rows()['items'][0];key=row['orders'][0]['note_key']
        self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=self.rows()['revision'],element_id=row['id'],note_key=key,text='Не доставлен крепёж'),self.admin)
        state=self.state();self.assertNotIn('__montage_reporting_v1',state['state']['facts']);self.snz.save_state(self.object_id,self.snz.StateIn(revision=state['revision'],**{k:v for k,v in state['state'].items() if k!='facts'}),self.admin)
        row=next(r for r in self.rows()['items'] if r['id']==row['id']);self.assertEqual(row['orders'][0]['note'],'Не доставлен крепёж');self.assertFalse(row['status_confirmed'])
        with self.assertRaises(HTTPException):self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=0,element_id=row['id'],note_key=key,text='Чужая правка'),self.admin)

    def test_without_fact_and_report_exports_include_both_shifts(self):
        rows=self.rows();row=rows['items'][0]
        self.snz.complete(self.object_id,self.snz.FactIn(revision=rows['revision'],task_key=row['task_key'],completed_at='2026-11-10T11:10:00',expected_montage_rev=row['expected_rev']),self.admin)
        self.assertEqual(len(self.rows(date=date(2026,11,10),without_fact=True)['items']),3)
        self.snz.complete_extra_fact(self.object_id,self.extra_body(),self.admin)
        pending=next(r for r in self.rows()['items'] if r['id']==self.base.ids[1]);ref=pending['orders'][0]
        self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=self.rows()['revision'],element_id=pending['id'],note_key=ref['note_key'],text='Отсутствует крепёж, требуется доставка на рабочую захватку'),self.admin)
        from openpyxl import load_workbook
        data=self.snz.export_fact_xlsx(self.object_id,date(2026,11,10),user=self.admin).body
        wb=load_workbook(BytesIO(data));self.assertEqual(wb.sheetnames,['План и факт','Итоги по бригадам'])
        table=wb['План и факт'];self.assertIn('Вне СНЗ',[table.cell(i,7).value for i in range(6,11)])
        self.assertEqual({table.cell(i,9).value for i in range(6,11)},{'День','Ночь'})
        out=Path(__file__).resolve().parents[1]/'outputs/snz-fact-report';out.mkdir(parents=True,exist_ok=True);(out/'facts.xlsx').write_bytes(data)
        pdf=self.snz.export_fact_pdf(self.object_id,date(2026,11,10),user=self.admin).body;(out/'facts.pdf').write_bytes(pdf)
        import fitz
        text='\n'.join(p.get_text() for p in fitz.open(stream=pdf,filetype='pdf'));self.assertIn('отм +5.000',text);self.assertIn('ДОП - Доп-5',text)

    def test_extra_rejects_planned_wrong_crew_time_status_and_object(self):
        for change in ({'crew_id':'missing'},{'completed_at':'2026-11-12T01:00:00'}, {'items':[{'element_id':self.base.ids[0],'expected_rev':'0'*64}]}):
            with self.subTest(change=change):
                before=self.state()['revision']
                with self.assertRaises(HTTPException):self.snz.complete_extra_fact(self.object_id,self.extra_body(**change),self.admin)
                self.assertEqual(self.state()['revision'],before)
        body=self.extra_body();c=self.db.get_connection()
        from app.contracts import apply_status_change
        apply_status_change(c,self.extra,'delivered',False,None,'2026-11-10 09:00:00','','Тест',self.admin['id']);c.commit();c.close()
        with self.assertRaises(HTTPException):self.snz.complete_extra_fact(self.object_id,body,self.admin)

    def test_new_fact_mutations_require_rights_and_stay_in_object(self):
        c=self.db.get_connection();uid=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Наблюдатель','facts-report-readonly','view')").lastrowid;c.commit();viewer=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();c.close()
        row=self.rows()['items'][0]
        note=self.snz.FactNoteIn(revision=self.rows()['revision'],element_id=row['id'],note_key=row['orders'][0]['note_key'],text='Недопустимая запись')
        for call in (lambda:self.snz.save_fact_note(self.object_id,note,viewer),lambda:self.snz.complete_extra_fact(self.object_id,self.extra_body(),viewer),lambda:self.snz.preview_close_orders(self.object_id,user=viewer)):
            with self.assertRaises(HTTPException) as error:call()
            self.assertEqual(error.exception.status_code,403)
        with self.assertRaises(HTTPException):self.snz.save_fact_note(self.base.other_id,note,self.admin)
        with self.assertRaises(HTTPException):self.snz.complete_extra_fact(self.base.other_id,self.extra_body(),self.admin)
        self.assertEqual(len(self.rows()['items']),4)

    def test_floor_catalog_preserved_for_old_clients_and_unique(self):
        s=self.state();body={k:v for k,v in s['state'].items() if k not in ('facts','floor_levels')}
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=s['revision'],**body),self.admin)
        self.assertEqual(self.state()['state']['floor_levels'],[{'floor':1,'elevation_mm':5000}])
        body['floor_levels']=[{'floor':1,'elevation_mm':5000},{'floor':1,'elevation_mm':6000}]
        with self.assertRaises(HTTPException):self.snz.save_state(self.object_id,self.snz.StateIn(revision=self.state()['revision'],**body),self.admin)


if __name__=='__main__':unittest.main(verbosity=2)
