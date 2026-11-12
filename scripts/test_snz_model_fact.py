"""Atomic model montage: planned and extra, history, closure, scope and retries."""
import sys,unittest
from pathlib import Path
from datetime import date
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz_fact_reporting as reporting
from fastapi import HTTPException


class ModelFactTests(reporting.ReportingTests):
    def body(self,ids=None,**overrides):
        candidates=self.snz.model_fact_candidates(self.object_id,date(2026,11,10),'day','install1',self.admin)
        rows={r['id']:r for r in candidates['items']};ids=ids or [self.base.ids[0],self.extra]
        return self.snz.ModelFactIn(**{'revision':candidates['revision'],'date':'2026-11-10','shift':'day','crew_id':'install1',
            'completed_at':'2026-11-10T11:10:00','request_id':'model-test','items':[{'element_id':eid,'expected_rev':rows[eid]['expected_rev']} for eid in ids],**overrides})

    def test_mixed_plan_and_extra_atomic_and_idempotent(self):
        before=self.state()['orders'];body=self.body()
        result=self.snz.complete_model_fact(self.object_id,body,self.admin)
        self.assertEqual(set(result['confirmed']),{self.base.ids[0],self.extra});self.assertEqual(result['extra'],[self.extra])
        self.assertEqual(self.state()['orders'],before)
        rows={r['id']:r for r in self.rows()['items']}
        self.assertTrue(rows[self.base.ids[0]]['orders']);self.assertFalse(rows[self.extra]['orders']);self.assertTrue(rows[self.extra]['extra'])
        self.assertTrue(all(rows[eid]['status_confirmed'] for eid in result['confirmed']))
        self.assertTrue(self.snz.complete_model_fact(self.object_id,body,self.admin)['already_completed'])
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],2);c.close()
        saved=self.state();self.snz.save_state(self.object_id,self.snz.StateIn(revision=saved['revision'],**{k:v for k,v in saved['state'].items() if k!='facts'}),self.admin)
        self.assertTrue(self.snz.complete_model_fact(self.object_id,body,self.admin)['already_completed'])
        self.assertTrue(next(r for r in self.rows()['items'] if r['id']==self.extra)['extra'])
        altered=body.model_copy(update={'crew_id':'install2'})
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,altered,self.admin)

    def test_already_installed_preserves_history_and_acceptance(self):
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,self.extra,'installed',False,None,'2026-11-09 12:00:00','','Test',self.admin['id']);apply_status_change(c,self.extra,'accepted',False,None,'2026-11-09 13:00:00','','Test',self.admin['id']);c.commit()
        before=[tuple(r) for r in c.execute('SELECT * FROM status_history')];c.close()
        self.snz.complete_model_fact(self.object_id,self.body([self.extra]),self.admin)
        row=next(r for r in self.rows()['items'] if r['id']==self.extra)
        self.assertEqual(row['completed_at'],'2026-11-09T12:00:00');self.assertEqual(row['current_status'],'accepted')
        c=self.db.get_connection();after=[tuple(r) for r in c.execute('SELECT * FROM status_history')];c.close();self.assertEqual(before,after)

    def test_wrong_scope_does_not_partially_install(self):
        before=self.state()['revision']
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body([self.extra,self.base.ids[2]]),self.admin)
        self.assertEqual(self.state()['revision'],before)
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],0);c.close()

    def test_closed_scope_and_stale_status_rejected(self):
        body=self.body();c=self.db.get_connection()
        from app.contracts import apply_status_change
        apply_status_change(c,self.extra,'delivered',False,None,'2026-11-10 10:30:00','','Test',self.admin['id']);c.commit();c.close()
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,body,self.admin)
        preview=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','install1',self.admin)
        self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=preview['revision'],date='2026-11-10',shift='day',crew_id='install1',expected_hash=preview['fingerprint'],request_id='close-model'),self.admin)
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body([self.base.ids[0]]),self.admin)

    def test_date_time_and_duplicate_ids_are_checked(self):
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body(completed_at='2026-11-11T01:00:00'),self.admin)
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,self.body([self.extra,self.extra]),self.admin)
        body=self.body([self.extra],shift='night',completed_at='2026-11-11T01:00:00')
        result=self.snz.complete_model_fact(self.object_id,body,self.admin);self.assertEqual(result['extra'],[self.extra])
        self.assertEqual(next(r for r in self.rows(shift='night')['items'] if r['id']==self.extra)['completed_at'],'2026-11-11T01:00:00')

    def test_model_fact_requires_status_rights_and_current_object(self):
        c=self.db.get_connection();uid=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Viewer','model-fact-viewer','view')").lastrowid;c.commit();viewer=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();c.close()
        body=self.body()
        with self.assertRaises(HTTPException) as error:self.snz.complete_model_fact(self.object_id,body,viewer)
        self.assertEqual(error.exception.status_code,403)
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.base.other_id,body,self.admin)
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM status_history').fetchone()[0],0);c.close()

    def test_late_status_rolls_back_whole_batch(self):
        c=self.db.get_connection();from app.contracts import apply_status_change
        apply_status_change(c,self.extra,'delivered',False,None,'2026-11-10 12:00:00','','Test',self.admin['id']);c.commit();c.close()
        body=self.body()
        with self.assertRaises(HTTPException):self.snz.complete_model_fact(self.object_id,body,self.admin)
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT current_status FROM elements WHERE id=?',(self.base.ids[0],)).fetchone()[0],'ready_for_installation');c.close()


if __name__=='__main__':unittest.main(verbosity=2)
