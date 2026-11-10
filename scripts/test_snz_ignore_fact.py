"""Optional plan-only calculation; facts and ordinary carry remain intact."""
import sys
import unittest
from copy import deepcopy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures
from app.snz_core import build_schedule
from fastapi import HTTPException


class CalculationTests(unittest.TestCase):
    def test_switch_excludes_carry_but_default_keeps_it(self):
        state,elements=fixtures.fixture((1,2),(("install",60,0),))
        state['assignments'][1]['shift']='night'
        day=build_schedule(state,elements,[],'2026-11-10','day','install1')
        normal=build_schedule(state,elements,[day],'2026-11-10','night','install1')
        planned=build_schedule(state,elements,[day],'2026-11-10','night','install1',ignore_fact=True)
        self.assertEqual({e['id'] for e in normal['items']},{1,2})
        self.assertEqual([e['id'] for e in planned['items']],[2])
        self.assertTrue(all(not t['carry'] for t in planned['tasks']))
        self.assertFalse(normal['ignore_fact']);self.assertTrue(planned['ignore_fact'])

    def test_ignores_completion_without_mutating_facts_statuses_or_internal_order(self):
        state,elements=fixtures.fixture((1,),(("install",250,120),("rebar1",10,0)))
        state['facts']['e:1:install']={'completed':True,'completed_at':'2026-11-10T12:30'}
        elements[0]['current_status']='installed'
        before=deepcopy((state,elements))
        result=build_schedule(state,elements,[],'2026-11-10','day','install1',ignore_fact=True)
        self.assertEqual([t['operation_id'] for t in result['tasks']],['install','rebar1'])
        self.assertEqual(result['tasks'][0]['remaining_before'],250)
        self.assertEqual(result['tasks'][1]['segments'][0]['start'],'2026-11-10T14:30')
        self.assertEqual((state,elements),before)
        self.assertEqual(result['completed'],[])


class IssueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.h=fixtures.IntegrationTests()
        for key in ['snz','db','object_id','ids','admin']:setattr(cls,key,getattr(fixtures.IntegrationTests,key))

    def setUp(self):
        self.h.setUp()
        state,_=fixtures.fixture(tuple(self.ids),(("install",60,0),))
        for a,(day,shift) in zip(state['assignments'],self.scopes()):a.update(date=day,shift=shift)
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)

    @staticmethod
    def scopes():return [('2026-11-10','day'),('2026-11-10','night'),('2026-11-11','day'),('2026-11-11','night')]

    def preview(self,day,shift,ignore=True):
        revision=self.snz.get_state(self.object_id,self.admin)['revision']
        body=self.snz.PlanIn(revision=revision,date=day,shift=shift,crew_id='install1',ignore_fact=ignore)
        return body,self.snz.preview(self.object_id,body,self.admin)

    def test_issue_four_shifts_without_completing_previous_work(self):
        for index,(day,shift) in enumerate(self.scopes()):
            body,preview=self.preview(day,shift)
            self.assertEqual([e['id'] for e in preview['items']],[self.ids[index]])
            self.assertTrue(all(not t['carry'] for t in preview['tasks']))
            issue=self.snz.IssueIn(**body.model_dump(),expected_hash=preview['fingerprint'],request_id=f'future-{index}')
            oid=self.snz.issue(self.object_id,issue,self.admin)['id']
            saved=self.snz.read_order(self.object_id,oid,self.admin)
            self.assertTrue(saved['ignore_fact'])
            self.assertEqual([e['id'] for e in saved['items']],[self.ids[index]])
            self.assertEqual(self.snz.issue(self.object_id,issue,self.admin)['id'],oid)
        data=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(len(data['orders']),4);self.assertEqual(data['state']['facts'],{})

    def test_mode_is_bound_to_fingerprint_and_idempotency(self):
        body,normal=self.preview('2026-11-10','day',False)
        _,planned=self.preview('2026-11-10','day',True)
        self.assertNotEqual(normal['fingerprint'],planned['fingerprint'])
        mismatched=self.snz.IssueIn(**body.model_copy(update={'ignore_fact':True}).model_dump(),expected_hash=normal['fingerprint'],request_id='wrong-mode')
        with self.assertRaises(HTTPException) as error:self.snz.issue(self.object_id,mismatched,self.admin)
        self.assertEqual(error.exception.status_code,409)
        issue=mismatched.model_copy(update={'expected_hash':planned['fingerprint']})
        oid=self.snz.issue(self.object_id,issue,self.admin)['id']
        with self.assertRaises(HTTPException):self.snz.issue(self.object_id,issue.model_copy(update={'ignore_fact':False}),self.admin)
        _,existing=self.preview('2026-11-10','day',False)
        self.assertEqual(existing['id'],oid);self.assertTrue(existing['ignore_fact'])
        self.assertFalse(self.snz.PlanIn(revision=0,date='2026-11-10',shift='day',crew_id='install1').ignore_fact)


if __name__=='__main__':unittest.main(verbosity=2)
