"""Three planned columns + three night slabs installed during the day."""
import unittest
from datetime import date
from pathlib import Path
import test_snz_fact_reporting as reporting
import test_snz as fixtures
from fastapi import HTTPException


class CrossShiftFactTests(unittest.TestCase):
    future_day='2026-11-10'

    @classmethod
    def setUpClass(cls):
        reporting.ReportingTests.setUpClass()
        cls.base=reporting.ReportingTests
        cls.snz=cls.base.snz;cls.db=cls.base.db;cls.object_id=cls.base.object_id;cls.admin=cls.base.admin
        c=cls.db.get_connection();e=fixtures.element(6)
        cls.sixth=c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,'ready_for_installation')",
            (e['source_file'],'cross-sixth','snz','Плита перекрытия','П-6',e['x'],e['y'],cls.object_id,1,e['outline_json'])).lastrowid
        c.commit();c.close()

    def setUp(self):
        self.fixture=self.base();self.fixture.setUp()
        self.ids=[*self.base.base.ids,self.base.extra,self.sixth]
        c=self.db.get_connection();c.execute('DELETE FROM snz_order_revisions');c.execute('DELETE FROM snz_orders');c.execute('DELETE FROM snz_state')
        for i,eid in enumerate(self.ids):
            c.execute('UPDATE elements SET element_type=?,mark=? WHERE id=?',('Колонна' if i<3 else 'Плита перекрытия',f'К-{i+1}' if i<3 else f'П-{i-2}',eid))
        c.commit();c.close()
        state,_=fixtures.fixture(self.ids,getattr(self,'steps',(('install',20,0),)))
        for a in state['assignments'][3:]:a.update(shift='night',date=self.future_day)
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        self.orders=[]
        for shift in ('day','night'):
            params=dict(revision=self.fixture.state()['revision'],date=self.future_day if shift=='night' else '2026-11-10',
                        shift=shift,crew_id='install1',ignore_fact=True)
            plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
            self.orders.append(self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id='cross-'+shift,expected_hash=plan['fingerprint']),self.admin)['id'])

    def body(self,ids=None,shift='day',request='cross-fact',**overrides):
        data=self.snz.model_fact_candidates(self.object_id,date(2026,11,10),shift,'install1',self.admin)
        rows={r['id']:r for r in data['items']}
        return self.snz.ModelFactIn(**dict(revision=data['revision'],date='2026-11-10',shift=shift,crew_id='install1',request_id=request,
            completed_at='2026-11-10T11:10:00' if shift=='day' else '2026-11-11T01:10:00',
            items=[dict(element_id=eid,expected_rev=rows[eid]['expected_rev']) for eid in (ids or self.ids)],**overrides))

    def close(self,shift):
        p=self.snz.preview_close_orders(self.object_id,date(2026,11,10),shift,'install1',self.admin)
        return self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift=shift,crew_id='install1',expected_hash=p['fingerprint'],request_id='cross-close-'+shift),self.admin)

    def report(self,shift=None,day='2026-11-10'):
        from app.snz_fact_report import report
        c=self.db.get_connection()
        try:
            state,_=self.snz._load(c,self.object_id)
            return report(c,self.object_id,state,day,shift,'install1')
        finally:c.close()

    def snapshots(self):
        c=self.db.get_connection()
        try:return [tuple(r) for r in c.execute('SELECT id,snapshot_json FROM snz_orders ORDER BY id')]
        finally:c.close()

    def test_three_columns_and_three_night_slabs_in_day_fact_and_closure(self):
        before=self.snapshots();body=self.body()
        result=self.snz.complete_model_fact(self.object_id,body,self.admin)
        self.assertEqual(result['extra'],self.ids[3:]);self.assertEqual(result['confirmed'],self.ids)
        self.assertTrue(self.snz.complete_model_fact(self.object_id,body,self.admin)['already_completed'])
        self.assertEqual(self.snapshots(),before)
        for shift,plan,fact in [('day',3,6),('night',3,0)]:
            report=self.report(shift);self.assertEqual((report['registry']['planned'],report['registry']['completed']),(plan,fact))
        self.assertEqual((self.report()['registry']['planned'],self.report()['registry']['completed']),(6,6))
        night=self.report('night')['items'];self.assertTrue(all(r['montage_elsewhere']['shift']=='day' and not r['status_confirmed'] and not r['task_key'] for r in night))
        for shift in ('day','night'):self.assertEqual(self.close(shift)['released_element_ids'],[])
        self.assertEqual(self.snapshots(),before)
        self.assertEqual([r['completed'] for r in sorted(self.report()['registry']['orders'],key=lambda r:r['shift'])],[6,0])
        frozen=self.snz.read_order(self.object_id,self.orders[1],self.admin)['facts']
        self.assertTrue(all(not frozen[f'e:{eid}:install']['completed'] for eid in self.ids[3:]))
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],6)
        self.assertTrue(all(r[0]=='installed' for r in c.execute('SELECT current_status FROM elements WHERE object_id=?',(self.object_id,))));c.close()
        from app.snz_fact_report import build_xlsx
        out=Path(__file__).resolve().parents[1]/'outputs/snz-cross-shift';out.mkdir(parents=True,exist_ok=True)
        for shift in ('day','night'):(out/f'{shift}.xlsx').write_bytes(build_xlsx(self.report(shift)))

    def test_reverse_shift_and_next_morning(self):
        result=self.snz.complete_model_fact(self.object_id,self.body(shift='night'),self.admin)
        self.assertEqual(result['extra'],self.ids[:3]);self.assertEqual(self.report('night')['registry']['completed'],6)
        self.assertEqual(self.report('day')['registry']['completed'],0)
        self.assertTrue(all(r['completed_at']=='2026-11-11T01:10:00' for r in self.report('night')['items']))

    def test_extra_picker_moves_future_plan_fact_and_colors_actual_shift(self):
        for future_day in ('2026-11-10','2026-11-12'):
            with self.subTest(future_day=future_day):
                self.future_day=future_day
                self.setUp()
                eid=self.ids[3]
                planned=self.ids[0]
                self.snz.complete_model_fact(self.object_id,self.body([planned]),self.admin)

                def picker(shift='day'):
                    return self.snz.extra_fact_candidates(self.object_id,date(2026,11,10),self.admin,shift,'install1')

                data=picker()
                item=next(r for r in data['items'] if r['id']==eid)
                self.assertEqual(item['source_order_ids'],[self.orders[1]])
                self.assertNotIn(planned,{r['id'] for r in data['items']})
                body=self.snz.ExtraFactIn(revision=data['revision'],date='2026-11-10',shift='day',crew_id='install1',
                    completed_at='2026-11-10T11:15:00',request_id='picker-early',
                    items=[{'element_id':eid,'expected_rev':item['expected_rev']}])
                before=self.snapshots()
                self.snz.complete_extra_fact(self.object_id,body,self.admin)
                self.assertTrue(self.snz.complete_extra_fact(self.object_id,body,self.admin)['already_completed'])
                self.assertEqual(self.snapshots(),before)
                self.assertEqual({r['id'] for r in picker()['planned'] if r['completed']},{planned,eid})
                future=self.snz.extra_fact_candidates(self.object_id,date.fromisoformat(future_day),self.admin,'night','install1')
                self.assertFalse(next(r for r in future['planned'] if r['id']==eid)['completed'])
                self.assertEqual(self.report('day')['registry']['completed'],2)
                self.assertEqual(self.report('night',future_day)['registry']['completed'],0)
                source=self.snz.read_order(self.object_id,self.orders[1],self.admin)
                self.assertTrue(source['facts'][f'e:{eid}:install']['montage_elsewhere'])
                self.close('day')
                self.assertEqual(self.report('day')['registry']['completed'],2)

                from app import snz_admin
                oid=self.orders[1]
                editor=snz_admin.read_editor(self.object_id,oid,self.admin)
                proposal=snz_admin.AdminPreviewIn(revision=editor['revision'],order_revision=editor['order_revision'],
                    positions=[r for r in editor['positions'] if r['element_id']!=eid],reason='Монтаж в предыдущую смену')
                preview=snz_admin.preview_editor(self.object_id,oid,proposal,self.admin)
                snz_admin.save_editor(self.object_id,oid,snz_admin.AdminSaveIn(**proposal.model_dump(),
                    request_id='remove-early-montage',expected_hash=preview['fingerprint']),self.admin)
                revised=self.snz.read_order(self.object_id,oid,self.admin)
                self.assertEqual(len(revised['items']),2)
                self.assertEqual(revised['tasks'][0]['segments'][0]['start'],source['tasks'][0]['segments'][0]['start'])
                self.assertEqual(self.report('day')['registry']['completed'],2)
                self.assertEqual(self.report('night',future_day)['registry']['planned'],2)

    def test_other_crew_and_closed_source_or_target_are_atomic(self):
        wrong=self.body().model_copy(update={'crew_id':'install2'})
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,wrong,self.admin)
        for closed in ('day','night'):
            with self.subTest(closed=closed):
                self.setUp();self.close(closed);revision=self.fixture.state()['revision']
                with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body(self.ids[3:]),self.admin)
                self.assertEqual(self.fixture.state()['revision'],revision)
                c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],0);c.close()

    def test_acceptance_rollback_reinstallation_and_closed_history(self):
        from app.contracts import apply_status_change
        self.snz.complete_model_fact(self.object_id,self.body(),self.admin)
        eid=self.ids[3]
        c=self.db.get_connection();apply_status_change(c,eid,'accepted',False,None,'2026-11-10 12:00:00','','Test',self.admin['id']);c.commit();c.close()
        self.assertEqual(self.report('day')['registry']['completed'],6);self.assertEqual(self.report('night')['registry']['completed'],0)
        self.close('night')
        c=self.db.get_connection();apply_status_change(c,eid,'delivered',False,None,'2026-11-10 13:00:00','','Test',self.admin['id']);c.commit();c.close()
        self.assertEqual(self.report('day')['registry']['completed'],5)
        c=self.db.get_connection();apply_status_change(c,eid,'installed',False,None,'2026-11-10 21:00:00','','Test',self.admin['id']);c.commit();c.close()
        self.assertEqual(self.report('day')['registry']['completed'],5);self.assertEqual(self.report('night')['registry']['completed'],0)

    def test_post_montage_operations_survive_source_closure(self):
        self.steps=(('install',20,0),('rebar1',35,0))
        self.setUp()
        self.snz.complete_model_fact(self.object_id,self.body(),self.admin)
        self.close('day');self.close('night')
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=self.fixture.state()['revision'],date='2026-11-11',shift='day',crew_id='install1'),self.admin)
        self.assertEqual({t['element_ids'][0] for t in plan['tasks'] if t['operation_id']=='rebar1'},set(self.ids))
        self.assertFalse(any(t['operation_id']=='install' for t in plan['tasks']))

    def test_existing_montage_history_is_preserved_and_cannot_be_counted_twice(self):
        from app.contracts import apply_status_change
        c=self.db.get_connection()
        for eid in self.ids[3:]:apply_status_change(c,eid,'installed',False,None,'2026-11-10 10:00:00','','Test',self.admin['id'])
        c.commit();before=[tuple(r) for r in c.execute('SELECT * FROM status_history')];c.close()
        self.snz.complete_model_fact(self.object_id,self.body(self.ids[3:]),self.admin)
        self.assertEqual(self.report('day')['registry']['completed'],3);self.assertEqual(self.report('night')['registry']['completed'],0)
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body(self.ids[3:],shift='night',request='cross-again'),self.admin)
        c=self.db.get_connection();self.assertEqual(before,[tuple(r) for r in c.execute('SELECT * FROM status_history')]);c.close()


if __name__=='__main__':unittest.main(verbosity=2)
