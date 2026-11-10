"""Item sequences, complete shift composition and legacy facts on synthetic data."""
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from io import BytesIO
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures
from app.snz_policy import order_items, planning_state
from app.snz_order_edit import revise_order


class SequenceTests(unittest.TestCase):
    def test_unfinished_preparation_previous_shift_never_blocks_mounting(self):
        state,elements=fixtures.fixture((1,2),(("prepare",900,180),("install",40,0),("rebar1",30,0),("concrete1",20,0)))
        previous=fixtures.schedule(state,elements,day='2026-11-09',shift='night',crew='preparation')
        for history in [[],[previous]]:
            result=fixtures.schedule(state,elements,history)
            self.assertEqual(len(order_items(result)),2)
            self.assertEqual(len(result['tasks']),6)
            first=result['tasks'][0]
            self.assertEqual(first['segments'][0]['start'],'2026-11-10T08:20')
            self.assertTrue(all(not any('prepare' in dep for dep in t['dependencies']) for t in result['tasks']))

    def test_each_item_preserves_sequence_and_calendar_wait_without_group_barrier(self):
        state,elements=fixtures.fixture((1,2),(("install",60,90),("rebar1",40,0),("concrete1",20,0),("rebar2",30,0),("concrete2",20,0)))
        state['groups']=[{'id':'cross','name':'Старый узел','element_ids':[1,2,3,4]}]
        # Legacy persisted scopes still read as individual; other group members
        # need not be assigned, installed or even in this synthetic model.
        for operation in state['operations'][3:]:operation['scope']='group'
        result=fixtures.schedule(state,elements)
        self.assertEqual(len(result['tasks']),10)
        self.assertFalse(any(t['group_id'] for t in result['tasks']))
        for eid in [1,2]:
            tasks=[t for t in result['tasks'] if t['element_ids']==[eid]]
            self.assertEqual([t['operation_id'] for t in tasks],['install','rebar1','concrete1','rebar2','concrete2'])
            for before,after in zip(tasks,tasks[1:]):
                from datetime import datetime,timedelta
                ready=datetime.fromisoformat(before['segments'][-1]['end'])+timedelta(minutes=before['wait_after'])
                self.assertGreaterEqual(datetime.fromisoformat(after['segments'][0]['start']),ready)
                self.assertEqual(after['dependencies'],[before['key']])

    def test_all_items_survive_capacity_with_exact_40_minute_carry(self):
        state,elements=fixtures.fixture((1,2,3),(("install",600,0),))
        card=deepcopy(state['cards'][0]);card['id']='short';card['steps'][0]['minutes']=60;state['cards'].append(card)
        for assignment in state['assignments'][1:]:assignment['card_id']='short'
        day=fixtures.schedule(state,elements)
        self.assertEqual(set(order_items(day)),{1,2,3})
        self.assertEqual([len(t['segments']) for t in day['tasks']],[2,1,0])
        self.assertEqual([t['remaining_after'] for t in day['tasks']],[0,40,60])
        self.assertTrue(any('Ограничение времени монтажа' in w and '720' in w and '620' in w and '100' in w for w in day['warnings']))
        state['facts']['e:1:install']={'completed':True,'completed_at':'2026-11-10T19:20'}
        night=fixtures.schedule(state,elements,[day],shift='night')
        self.assertEqual([t['remaining_before'] for t in night['tasks']],[40,60])
        self.assertEqual(night['tasks'][0]['segments'][0]['end'],'2026-11-10T21:00')

    def test_missing_norms_and_other_statuses_stay_in_composition(self):
        state,elements=fixtures.fixture((1,2,3),(("install",None,0),("rebar1",30,0)))
        elements[2]['current_status']='delivered'
        result=fixtures.schedule(state,elements)
        self.assertEqual(set(order_items(result)),{1,2,3})
        self.assertTrue(all(not t['segments'] for t in result['tasks']))
        self.assertTrue(any('не заполнен норматив' in w for w in result['warnings']))
        self.assertTrue(any('статус' in w for w in result['warnings']))
        fixed=revise_order(result,{},[3],[result])
        self.assertEqual(set(order_items(fixed)),{1,2})

    def test_old_completed_shared_fact_is_honoured_without_rewriting_it(self):
        state,elements=fixtures.fixture((1,2),(("install",20,0),("rebar1",40,0),("concrete1",20,0)))
        state['groups']=[{'id':'cross','name':'Крест','element_ids':[1,2,3,4]}]
        state['facts']['g:cross:rebar1']={'completed':True,'completed_at':'2026-11-10T07:30'}
        before=deepcopy(state)
        result=fixtures.schedule(state,elements)
        self.assertFalse(any(t['operation_id']=='rebar1' for t in result['tasks']))
        self.assertEqual(state,before)
        self.assertTrue(all(op['scope']=='element' for op in planning_state(state)['operations'][3:]))

    def test_edit_preserves_wait_of_legacy_shared_fact_for_previously_unscheduled_item(self):
        state,elements=fixtures.fixture((1,2),(("install",600,0),("rebar1",40,120),("concrete1",20,0)))
        card=deepcopy(state['cards'][0]);card['id']='short';card['steps'][0]['minutes']=60
        state['cards'].append(card);state['assignments'][1]['card_id']='short'
        state['groups']=[{'id':'cross','name':'Крест','element_ids':[1,2,3,4]}]
        state['facts']['g:cross:rebar1']={'completed':True,'completed_at':'2026-11-10T09:00'}
        order=fixtures.schedule(state,elements)
        self.assertFalse(next(t for t in order['tasks'] if t['key']=='e:2:concrete1')['segments'])
        fixed=revise_order(order,state['facts'],[1],[order])
        concrete=next(t for t in fixed['tasks'] if t['key']=='e:2:concrete1')
        self.assertEqual(concrete['segments'][0]['start'],'2026-11-10T11:00')

    def test_legacy_completed_shared_wait_is_frozen_from_its_issued_snapshot(self):
        state,elements=fixtures.fixture((1,2,3),(("install",20,0),("rebar1",40,0),("concrete1",20,0)))
        state['groups']=[{'id':'cross','name':'Крест','element_ids':[1,2,3]}]
        state['facts']['g:cross:rebar1']={'completed':True,'completed_at':'2026-11-10T09:00'}
        old={'start':'2026-11-09T20:00','tasks':[{'key':'g:cross:rebar1','element_ids':[1,2,3],'elements':elements,
              'norm_minutes':40,'wait_after':120,'segments':[]}]}
        result=fixtures.schedule(state,elements,[old])
        self.assertEqual(next(t for t in result['tasks'] if t['key']=='e:1:concrete1')['segments'][0]['start'],'2026-11-10T11:00')


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.h=fixtures.IntegrationTests()
        for key in ['snz','db','object_id','ids','admin']:setattr(cls,key,getattr(fixtures.IntegrationTests,key))

    def setUp(self):self.h.setUp()

    def test_overloaded_order_issues_counts_exports_and_deletes_all_members(self):
        from openpyxl import load_workbook
        from app.snz_export import build_pdf
        state,_=fixtures.fixture(tuple(self.ids),(("install",800,0),))
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        issued=self.h.issue();oid=issued['id'];order=self.snz.read_order(self.object_id,oid,self.admin)
        self.assertEqual(len(order['tasks']),4);self.assertEqual(len(order_items(order)),4)
        saved=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(saved['orders'][0]['quantity'],4);self.assertEqual(saved['locked_element_ids'],self.ids)
        output=Path(__file__).resolve().parents[1]/'outputs/snz-item-sequences';output.mkdir(parents=True,exist_ok=True)
        path=output/'all-items.xlsx';path.write_bytes(self.snz.export_xlsx(self.object_id,oid,self.admin).body)
        wb=load_workbook(path)
        self.assertEqual(wb['Изделия'].max_row,5)
        self.assertEqual({r[0].value for r in wb['Изделия'].iter_rows(min_row=2)},set(self.ids))
        self.assertEqual(wb['СНЗ'].max_row,8) # one split task + three zero-time rows
        self.assertTrue(all(wb['СНЗ'].cell(r,9).value is None for r in [6,7,8]))
        import subprocess
        subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(path)],check=True,capture_output=True)
        pdf=self.snz.export_pdf(self.object_id,oid,self.admin).body;(output/'all-items.pdf').write_bytes(pdf)
        text=subprocess.check_output(['/Users/max/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3','-c',"from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))",str(output/'all-items.pdf')],text=True)
        for eid in self.ids:self.assertIn('Р-'+str(eid),text)
        body=self.snz.DeleteOrderIn(revision=saved['revision'],order_revision=1,request_id='delete-overload')
        result=self.snz.delete_issued_order(self.object_id,oid,body,self.admin)
        self.assertEqual(result['cleared_element_ids'],self.ids)

    def test_legacy_shared_snapshot_keeps_its_original_shape_and_facts(self):
        with patch('app.snz_policy.INDIVIDUAL_OPERATIONS',frozenset()):
            state,_=fixtures.fixture(tuple(self.ids),(("install",20,0),("rebar1",30,0)))
            state['groups']=[{'id':'cross','name':'Крест','element_ids':self.ids}]
            next(o for o in state['operations'] if o['id']=='rebar1')['scope']='group'
            self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
            oid=self.h.issue()['id']
        before=self.snz.read_order(self.object_id,oid,self.admin)
        self.assertTrue(any(t['key']=='g:cross:rebar1' for t in before['tasks']))
        data=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(next(o for o in data['state']['operations'] if o['id']=='rebar1')['scope'],'element')
        self.assertEqual(self.snz.read_order(self.object_id,oid,self.admin),before)


if __name__=='__main__':unittest.main(verbosity=2)
