"""Close scope, snapshot immutability, released assignments and dated carry provenance."""
import unittest
from datetime import date
import test_snz_fact_reporting as reporting
from fastapi import HTTPException


class ClosureTests(reporting.ReportingTests):
    def close(self,shift=None,crew='install1',day=date(2026,11,10),request='close-one'):
        p=self.snz.preview_close_orders(self.object_id,day,shift,crew,self.admin)
        body=self.snz.CloseScopeIn(revision=p['revision'],date=day,shift=shift,crew_id=crew,expected_hash=p['fingerprint'],request_id=request)
        return body,self.snz.close_issued_orders(self.object_id,body,self.admin)

    def test_close_is_filtered_atomic_releases_only_unmounted(self):
        rows=self.rows();row=rows['items'][0]
        self.snz.complete(self.object_id,self.snz.FactIn(revision=rows['revision'],task_key=row['task_key'],completed_at='2026-11-10T11:10:00',expected_montage_rev=row['expected_rev']),self.admin)
        c=self.db.get_connection();before={r['id']:r['snapshot_json'] for r in c.execute('SELECT id,snapshot_json FROM snz_orders')};c.close()
        body,result=self.close('day')
        self.assertEqual(result['closed_order_ids'],[self.orders[0]]);self.assertEqual(result['released_element_ids'],[self.base.ids[1]])
        self.assertTrue(self.snz.close_issued_orders(self.object_id,body,self.admin)['already_closed'])
        state=self.state();self.assertNotIn(self.base.ids[1],{a['element_id'] for a in state['state']['assignments']})
        item=next(e for e in state['elements'] if e['id']==self.base.ids[1]);self.assertEqual(item['current_status'],'ready_for_installation');self.assertIsNone(item['planned_installation_date']);self.assertEqual(item['transfer_from'],'2026-11-10')
        self.assertNotIn(self.base.ids[1],state['locked_element_ids']);self.assertIn(self.base.ids[2],state['locked_element_ids'])
        self.assertTrue(next(o for o in state['orders'] if o['id']==self.orders[0])['closed_at'])
        c=self.db.get_connection();after={r['id']:r['snapshot_json'] for r in c.execute('SELECT id,snapshot_json FROM snz_orders')};c.close();self.assertEqual(before,after)

    def test_closed_order_facts_notes_edit_delete_are_read_only(self):
        self.close('day');oid=self.orders[0]
        order=self.snz.read_order(self.object_id,oid,self.admin);self.assertTrue(order['closed_at'])
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,self.snz.EditPreviewIn(revision=self.state()['revision'],order_revision=1,exclude_element_ids=[self.base.ids[0]],reason='Не разрешено'),self.admin)
        with self.assertRaises(HTTPException):self.snz.delete_issued_order(self.object_id,oid,self.snz.DeleteOrderIn(revision=self.state()['revision'],order_revision=1,request_id='delete-closed'),self.admin)
        row=next(r for r in self.rows()['items'] if r['id']==self.base.ids[0]);self.assertTrue(row['closed'])
        with self.assertRaises(HTTPException):self.snz.complete(self.object_id,self.snz.FactIn(revision=self.state()['revision'],task_key=row['task_key'],order_id=oid),self.admin)
        with self.assertRaises(HTTPException):self.snz.save_fact_note(self.object_id,self.snz.FactNoteIn(revision=self.state()['revision'],element_id=row['id'],note_key=row['orders'][0]['note_key'],text='Не разрешено'),self.admin)

    def test_later_montage_does_not_change_closed_report(self):
        self.close('day');eid=self.base.ids[0]
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,eid,'installed',False,None,'2026-11-11 12:00:00','','Тест',self.admin['id']);c.commit();c.close()
        row=next(r for r in self.rows(date=date(2026,11,10),shift='day')['items'] if r['id']==eid)
        self.assertFalse(row['status_confirmed']);self.assertIsNone(row['completed_at'])
        order=self.snz.read_order(self.object_id,self.orders[0],self.admin);self.assertFalse(order['facts'][f'e:{eid}:install']['completed'])
        archive=self.snz.read_order_revision(self.object_id,self.orders[0],1,self.admin);self.assertFalse(archive['facts'][f'e:{eid}:install']['completed'])

    def test_transfer_is_frozen_in_next_order_and_not_automatically_carried(self):
        self.close();s=self.state();eid=self.base.ids[0]
        params={'revision':s['revision'],'date':'2026-11-11','shift':'day','crew_id':'install1','ignore_fact':False}
        empty=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin);self.assertFalse(empty['tasks'])
        body={k:v for k,v in s['state'].items() if k!='facts'}
        body['assignments'].append({'element_id':eid,'date':'2026-11-11','shift':'day','crew_id':'install1','card_id':'base','priority':1,'prep_priority':None})
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=s['revision'],**body),self.admin)
        params['revision']=self.state()['revision'];plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        self.assertEqual(plan['tasks'][0]['elements'][0]['transfer_from'],'2026-11-10')
        issued=self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id='next-day',expected_hash=plan['fingerprint']),self.admin)
        self.assertEqual(self.snz.read_order(self.object_id,issued['id'],self.admin)['tasks'][0]['elements'][0]['transfer_from'],'2026-11-10')

    def test_unfinished_post_montage_work_survives_closure(self):
        import test_snz as fixtures
        c=self.db.get_connection();c.execute('DELETE FROM snz_orders');c.execute('DELETE FROM snz_state');c.commit();c.close()
        eid=self.base.ids[0];st,_=fixtures.fixture((eid,),(('install',20,0),('rebar1',35,0),('concrete1',15,0)))
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in st.items() if k!='facts'}),self.admin)
        params={'revision':self.state()['revision'],'date':'2026-11-10','shift':'day','crew_id':'install1'}
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        oid=self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id='montage-stages',expected_hash=plan['fingerprint']),self.admin)['id']
        r=self.rows()['items'][0]
        self.snz.complete(self.object_id,self.snz.FactIn(revision=self.state()['revision'],task_key=r['task_key'],order_id=oid,completed_at='2026-11-10T10:00:00'),self.admin)
        self.close('day')
        params.update(date='2026-11-11',revision=self.state()['revision'])
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        self.assertEqual({t['operation_id'] for t in plan['tasks']},{'rebar1','concrete1'})
        new=self.snz.issue(self.object_id,self.snz.IssueIn(**params,request_id='carry-stages',expected_hash=plan['fingerprint']),self.admin)['id']
        task=next(t for t in plan['tasks'] if t['operation_id']=='rebar1')
        self.snz.complete(self.object_id,self.snz.FactIn(revision=self.state()['revision'],task_key=task['key'],order_id=new),self.admin)
        old=self.snz.read_order(self.object_id,oid,self.admin)
        self.assertFalse(old['facts'].get(task['key'],{}).get('completed'))

    def test_normal_issue_requires_previous_closure_but_advance_mode_remains(self):
        state=self.state();params={'revision':state['revision'],'date':'2026-11-11','shift':'day','crew_id':'install1'}
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(**params),self.admin)
        body=self.snz.IssueIn(**params,expected_hash=plan['fingerprint'],request_id='blocked-before-close')
        with self.assertRaises(HTTPException) as error:self.snz.issue(self.object_id,body,self.admin)
        self.assertEqual(error.exception.status_code,409);self.assertIn('закройте предыдущие',error.exception.detail)
        self.assertEqual(self.state()['revision'],state['revision']);self.assertEqual(len(self.state()['orders']),2)
        # The two setup documents were explicitly issued ahead with ignore_fact=True.
        self.assertTrue(all(self.snz.read_order(self.object_id,oid,self.admin)['ignore_fact'] for oid in self.orders))
        from app.snz_closure import assert_previous_orders_closed
        c=self.db.get_connection()
        try:
            assert_previous_orders_closed(c,self.object_id,'2026-11-11','day','install2',False)
            assert_previous_orders_closed(c,self.object_id,'2026-11-11','day','install1',True)
        finally:c.close()

    def test_fact_change_after_preview_rejects_closing(self):
        p=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','install1',self.admin)
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,self.base.ids[0],'installed',False,None,'2026-11-10 12:00:00','','Тест',self.admin['id']);c.commit();c.close()
        body=self.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift='day',crew_id='install1',expected_hash=p['fingerprint'],request_id='stale-close')
        with self.assertRaises(HTTPException):self.snz.close_issued_orders(self.object_id,body,self.admin)
        self.assertFalse(any(o['closed_at'] for o in self.state()['orders']))


if __name__=='__main__':unittest.main(verbosity=2)
