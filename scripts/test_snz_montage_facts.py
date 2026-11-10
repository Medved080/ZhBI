"""Montage time/status linkage on a disposable database, including history edits."""
import sys
import json
import unittest
from pathlib import Path
from datetime import date
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures
from fastapi import HTTPException


class MontageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.h=fixtures.IntegrationTests()
        for key in ['snz','db','object_id','other_id','ids','admin']:setattr(cls,key,getattr(fixtures.IntegrationTests,key))
        from app import main
        cls.main=main

    def setUp(self):
        self.h.setUp()
        c=self.db.get_connection();c.execute('DELETE FROM status_history WHERE element_id IN (SELECT id FROM elements WHERE object_id=?)',(self.object_id,));c.commit();c.close()
        state,_=fixtures.fixture(tuple(self.ids),(("install",20,0),("rebar1",30,0),("concrete1",20,120)))
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        self.oid=self.h.issue()['id']

    def rows(self):return self.snz.montage_facts(self.object_id,user=self.admin)

    def mark(self,index=0,at='2026-11-10T22:15:42'):
        rows=self.rows();row=next(r for r in rows['items'] if r['id']==self.ids[index])
        return self.snz.FactIn(revision=rows['revision'],task_key=row['task_key'],completed_at=at,expected_montage_rev=row['expected_rev'])

    def external(self,eid,status,at):
        from app.contracts import apply_status_change
        c=self.db.get_connection()
        apply_status_change(c,eid,status,False,None,at,'Учебная внешняя отметка','Тест',self.admin['id'])
        c.commit();c.close()

    def raw(self):
        c=self.db.get_connection();row=c.execute('SELECT data_json FROM snz_state WHERE object_id=?',(self.object_id,)).fetchone()[0];c.close();return row

    def test_montage_sets_status_and_exact_time_without_completing_other_operations(self):
        result=self.snz.complete(self.object_id,self.mark(),self.admin)
        self.assertEqual(result['installed'],[self.ids[0]])
        data=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(data['state']['facts'][f'e:{self.ids[0]}:install']['completed_at'],'2026-11-10T22:15:42')
        self.assertNotIn(f'e:{self.ids[0]}:rebar1',data['state']['facts'])
        self.assertEqual(next(e for e in data['elements'] if e['id']==self.ids[0])['current_status'],'installed')
        # Once mounted, unfinished reinforcement/concrete remain available in later shifts.
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=data['revision'],date='2026-11-11',shift='day',crew_id='install1'),self.admin)
        operations=[t['operation_id'] for t in plan['tasks'] if self.ids[0] in t['element_ids']]
        self.assertIn('rebar1',operations);self.assertIn('concrete1',operations);self.assertNotIn('install',operations)

    def test_status_projection_uses_last_continuous_run_and_never_writes_on_read(self):
        eid=self.ids[1];self.external(eid,'installed','2026-11-10 20:00:15')
        self.external(eid,'accepted','2026-11-10 21:00:00')
        before=self.raw();row=next(r for r in self.rows()['items'] if r['id']==eid)
        self.assertEqual(row['completed_at'],'2026-11-10T20:00:15');self.assertTrue(row['completed']);self.assertEqual(self.raw(),before)
        self.external(eid,'delivered','2026-11-10 22:00:00')
        self.assertNotIn(f'e:{eid}:install',self.snz.get_state(self.object_id,self.admin)['state']['facts'])
        self.external(eid,'installed','2026-11-11 08:30:10')
        self.assertEqual(next(r for r in self.rows()['items'] if r['id']==eid)['completed_at'],'2026-11-11T08:30:10')

    def test_history_time_edit_and_delete_reflect_in_snz(self):
        eid=self.ids[0];self.external(eid,'ready_for_installation','2026-11-10 19:00:00')
        self.snz.complete(self.object_id,self.mark(),self.admin)
        row=next(r for r in self.rows()['items'] if r['id']==eid)
        c=self.db.get_connection();hid=c.execute("SELECT id FROM status_history WHERE element_id=? AND status='installed'",(eid,)).fetchone()[0];c.close()
        self.main.update_history_entry(eid,hid,{'changed_at':'2026-11-10T21:30:12'},self.admin)
        updated=next(r for r in self.rows()['items'] if r['id']==eid)
        self.assertEqual(updated['completed_at'],'2026-11-10T21:30:12');self.assertNotEqual(updated['expected_rev'],row['expected_rev'])
        self.main.delete_history_entry(eid,hid,self.admin)
        row=next(r for r in self.rows()['items'] if r['id']==eid)
        self.assertFalse(row['completed']);self.assertFalse(row['status_confirmed'])

    def test_stale_status_and_invalid_backdate_are_atomic(self):
        body=self.mark();eid=self.ids[0]
        self.external(eid,'ready_for_installation','2026-11-11 00:00:00')
        with self.assertRaises(HTTPException) as error:self.snz.complete(self.object_id,body,self.admin)
        self.assertEqual(error.exception.status_code,409)
        before=self.raw()
        with self.assertRaises(HTTPException):self.snz.complete(self.object_id,self.mark(),self.admin)
        self.assertEqual(before,self.raw())
        c=self.db.get_connection();self.assertEqual(c.execute("SELECT COUNT(*) FROM status_history WHERE element_id=? AND status='installed'",(eid,)).fetchone()[0],0);c.close()

    def test_other_stage_does_not_mark_montage_and_legacy_minute_precision_is_preserved(self):
        revision=self.rows()['revision'];eid=self.ids[0]
        result=self.snz.complete(self.object_id,self.snz.FactIn(revision=revision,task_key=f'e:{eid}:rebar1'),self.admin)
        self.assertEqual(result['installed'],[])
        self.assertFalse(next(r for r in self.rows()['items'] if r['id']==eid)['status_confirmed'])
        state=json.loads(self.raw());state['facts'][f'e:{eid}:install']={'completed':True,'completed_at':'2026-11-10T22:15','completed_by':'Старая отметка'}
        c=self.db.get_connection();c.execute('UPDATE snz_state SET data_json=? WHERE object_id=?',(json.dumps(state),self.object_id));c.commit();c.close()
        self.external(eid,'ready_for_installation','2026-11-10 22:15:45')
        self.assertIn(f'e:{eid}:install',self.snz.get_state(self.object_id,self.admin)['state']['facts'])
        self.external(eid,'delivered','2026-11-10 22:16:00')
        self.assertNotIn(f'e:{eid}:install',self.snz.get_state(self.object_id,self.admin)['state']['facts'])

    def test_retry_and_parallel_click_do_not_duplicate_status(self):
        body=self.mark()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.snz.complete(self.object_id,body,self.admin),range(2)))
        self.assertEqual(sum(bool(r.get('already_completed')) for r in results),1)
        c=self.db.get_connection();self.assertEqual(c.execute("SELECT COUNT(*) FROM status_history WHERE element_id=? AND status='installed'",(self.ids[0],)).fetchone()[0],1);c.close()
        same=body.model_copy(update={'revision':0})
        self.assertTrue(self.snz.complete(self.object_id,same,self.admin)['already_completed'])

    def test_filters_default_time_cross_object_and_read_only(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        self.assertEqual(len(self.snz.montage_facts(self.object_id,date=date(2026,11,10),user=self.admin)['items']),4)
        self.assertEqual(self.snz.montage_facts(self.object_id,shift='night',user=self.admin)['items'],[])
        start=datetime.now(ZoneInfo('Europe/Moscow')).replace(tzinfo=None,microsecond=0)
        body=self.mark(at=None);self.snz.complete(self.object_id,body,self.admin)
        at=datetime.fromisoformat(next(r for r in self.rows()['items'] if r['id']==self.ids[0])['completed_at'])
        self.assertGreaterEqual(at,start)
        with self.assertRaises(HTTPException):self.snz.complete(self.other_id,self.mark(index=1),self.admin)
        c=self.db.get_connection();uid=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Наблюдатель','montage-read','view')").lastrowid;c.commit();viewer=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();c.close()
        with self.assertRaises(HTTPException) as error:self.snz.complete(self.object_id,self.mark(index=1),viewer)
        self.assertEqual(error.exception.status_code,403)


if __name__=='__main__':unittest.main(verbosity=2)
