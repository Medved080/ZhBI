"""Shift isolation, retained carry and versioned correction on a disposable DB."""
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures
fixture=fixtures.fixture
schedule=fixtures.schedule
from app.snz_order_edit import revise_order
from fastapi import HTTPException


class ShiftTests(unittest.TestCase):
    def test_unissued_day_and_night_are_separate(self):
        state,elements=fixture((1,2),(("install",60,0),))
        state['assignments'][1]['shift']='night'
        day=schedule(state,elements)
        night=schedule(state,elements,shift='night')
        self.assertEqual([t['element_ids'] for t in day['tasks']],[[1]])
        self.assertEqual([t['element_ids'] for t in night['tasks']],[[2]])
        for task in night['tasks']:
            self.assertFalse(task['carry'])
            self.assertTrue(all('2026-11-10T20:'<=s['start']<'2026-11-11T08:' for s in task['segments']))

    def test_issued_partial_residue_still_carries_40(self):
        state,elements=fixture((1,2,3),(("install",600,0),))
        state['cards'].append({'id':'short','name':'60 мин','element_type':'','subtype':'','steps':[{'operation_id':'install','minutes':60,'wait_after':0}]})
        for a in state['assignments'][1:]:a['card_id']='short'
        state['assignments'][2]['shift']='night'
        day=schedule(state,elements)
        self.assertEqual([t['element_ids'] for t in day['tasks']],[[1],[2]])
        self.assertEqual(day['tasks'][1]['remaining_after'],40)
        state['facts']['e:1:install']={'completed':True,'completed_at':'2026-11-10T19:40'}
        night=schedule(state,elements,[day],shift='night')
        self.assertEqual(night['tasks'][0]['element_ids'],[2])
        self.assertEqual(night['tasks'][0]['remaining_before'],40)
        self.assertEqual(night['tasks'][1]['element_ids'],[3])
        self.assertTrue(all(night['start']<=s['start']<s['end']<=night['end'] for t in night['tasks'] for s in t['segments']))

    def test_frozen_norms_and_complete_reservations_survive(self):
        state,elements=fixture((1,2,3),(("install",60,0),))
        original=schedule(state,elements)
        facts={'e:1:install':{'completed':True,'completed_at':'2026-11-10T09:20'}}
        corrected=revise_order(original,facts,[2],[original])
        self.assertEqual(corrected['tasks'][0],original['tasks'][0])
        self.assertEqual(corrected['tasks'][1]['segments'][0]['start'],'2026-11-10T09:20')
        self.assertEqual(corrected['tasks'][1]['norm_minutes'],60)
        self.assertEqual(original['tasks'][2]['segments'][0]['start'],'2026-11-10T10:20')
        with self.assertRaises(ValueError):revise_order(original,facts,[1],[original])


class EditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass()
        cls.h=fixtures.IntegrationTests()
        cls.snz=fixtures.IntegrationTests.snz;cls.db=fixtures.IntegrationTests.db
        cls.object_id=fixtures.IntegrationTests.object_id;cls.other_id=fixtures.IntegrationTests.other_id
        cls.admin=fixtures.IntegrationTests.admin;cls.ids=fixtures.IntegrationTests.ids

    def setUp(self):self.h.setUp()

    def prepare(self):
        self.h.save_fixture()
        oid=self.h.issue()['id']
        original=self.snz.read_order(self.object_id,oid,self.admin)
        return oid,original

    def proposal(self,oid,removed,reason='Лишнее изделие в ночной смене'):
        data=self.snz.get_state(self.object_id,self.admin)
        order=self.snz.read_order(self.object_id,oid,self.admin)
        return self.snz.EditPreviewIn(revision=data['revision'],order_revision=order['order_revision'],exclude_element_ids=removed,reason=reason)

    def apply(self,oid,proposal,request='correction-1'):
        preview=self.snz.preview_order_edit(self.object_id,oid,proposal,self.admin)
        body=self.snz.EditOrderIn(**proposal.model_dump(),request_id=request,expected_hash=preview['fingerprint'])
        return self.snz.edit_order(self.object_id,oid,body,self.admin),body

    def test_edit_recalculates_only_this_order_and_preserves_assignments(self):
        oid,original=self.prepare();before=self.snz.get_state(self.object_id,self.admin)
        r,body=self.apply(oid,self.proposal(oid,[self.ids[0]]))
        self.assertEqual(r['order_revision'],2)
        current=self.snz.read_order(self.object_id,oid,self.admin)
        self.assertNotIn(self.ids[0],{e for t in current['tasks'] for e in t['element_ids']})
        self.assertEqual(current['tasks'][0]['segments'][0]['start'],original['tasks'][0]['segments'][0]['start'])
        after=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(before['state'],after['state'])
        self.assertNotIn(self.ids[0],after['locked_element_ids'])
        archive=self.snz.read_order_revision(self.object_id,oid,1,self.admin)
        for key in ['tasks','assignment_steps','windows']:self.assertEqual(archive[key],original[key])
        self.assertEqual(len(self.snz.list_order_revisions(self.object_id,oid,self.admin)),2)
        self.assertTrue(self.snz.edit_order(self.object_id,oid,body,self.admin)['already_applied'])
        self.assertEqual(len(self.snz.list_order_revisions(self.object_id,oid,self.admin)),2)
        preview=self.snz.preview(self.object_id,self.snz.PlanIn(revision=after['revision'],date='2026-11-10',shift='day',crew_id='install1'),self.admin)
        self.assertEqual(preview['id'],oid);self.assertEqual(preview['tasks'],current['tasks'])

    def test_revision_facts_and_hash_conflicts(self):
        oid,_=self.prepare();p=self.proposal(oid,[self.ids[0]])
        preview=self.snz.preview_order_edit(self.object_id,oid,p,self.admin)
        bad=self.snz.EditOrderIn(**p.model_dump(),request_id='bad-hash',expected_hash='0'*64)
        with self.assertRaises(HTTPException):self.snz.edit_order(self.object_id,oid,bad,self.admin)
        body=self.snz.EditOrderIn(**p.model_dump(),request_id='good-hash',expected_hash=preview['fingerprint'])
        self.snz.edit_order(self.object_id,oid,body,self.admin)
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,p,self.admin)
        other=body.model_copy(update={'reason':'Другой запрос'})
        with self.assertRaises(HTTPException):self.snz.edit_order(self.object_id,oid,other,self.admin)

    def test_group_and_completed_exclusion_rejected(self):
        # Reproduce a legacy shared snapshot, while the new default is individual.
        from unittest.mock import patch
        with patch('app.snz_policy.INDIVIDUAL_OPERATIONS',frozenset()):
            self.h.save_fixture(grouped=True)
            d=self.snz.get_state(self.object_id,self.admin)
            next(o for o in d['state']['operations'] if o['id']=='rebar1')['scope']='group'
            self.snz.save_state(self.object_id,self.snz.StateIn(revision=d['revision'],**{k:v for k,v in d['state'].items() if k!='facts'}),self.admin)
            oid=self.h.issue(revision=d['revision']+1)['id']
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,self.proposal(oid,[self.ids[0]]),self.admin)
        self.h.setUp();oid,original=self.prepare()
        d=self.snz.get_state(self.object_id,self.admin)
        self.snz.complete(self.object_id,self.snz.FactIn(revision=d['revision'],task_key=original['tasks'][0]['key']),self.admin)
        before=self.snz.get_state(self.object_id,self.admin)
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,self.proposal(oid,[self.ids[0]]),self.admin)
        self.assertEqual(before,self.snz.get_state(self.object_id,self.admin))

    def test_later_issued_order_protects_history(self):
        oid,_=self.prepare();data=self.snz.get_state(self.object_id,self.admin)
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=data['revision'],date='2026-11-10',shift='night',crew_id='install1'),self.admin)
        # Historical overlapping carry snapshots remain readable/editable under their original rules.
        from unittest.mock import patch
        with patch('app.snz_closure.assert_previous_orders_closed'):
            self.snz.issue(self.object_id,self.snz.IssueIn(revision=data['revision'],date='2026-11-10',shift='night',crew_id='install1',expected_hash=plan['fingerprint'],request_id='later'),self.admin)
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,self.proposal(oid,[self.ids[0]]),self.admin)

    def test_other_object_unknown_member_and_no_permission(self):
        oid,_=self.prepare();p=self.proposal(oid,[self.ids[0]])
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.other_id,oid,p,self.admin)
        with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,p.model_copy(update={'exclude_element_ids':[999999]}),self.admin)
        from unittest.mock import patch
        with patch('app.snz.assert_object_feature',side_effect=HTTPException(403,'Нет прав')):
            with self.assertRaises(HTTPException):self.snz.preview_order_edit(self.object_id,oid,p,self.admin)
            with self.assertRaises(HTTPException):self.snz.edit_order(self.object_id,oid,self.snz.EditOrderIn(**p.model_dump(),request_id='denied',expected_hash='0'*64),self.admin)

    def test_transaction_rollback_preserves_legacy_original(self):
        oid,original=self.prepare();p=self.proposal(oid,[self.ids[0]])
        preview=self.snz.preview_order_edit(self.object_id,oid,p,self.admin)
        c=self.db.get_connection();c.execute("CREATE TRIGGER fail_snz_edit BEFORE UPDATE ON snz_orders BEGIN SELECT RAISE(ABORT,'test failure'); END");c.commit();c.close()
        try:
            with self.assertRaises(Exception):self.snz.edit_order(self.object_id,oid,self.snz.EditOrderIn(**p.model_dump(),request_id='rollback',expected_hash=preview['fingerprint']),self.admin)
            c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM snz_order_revisions').fetchone()[0],0);c.close()
            self.assertEqual(self.snz.read_order(self.object_id,oid,self.admin),original)
        finally:
            c=self.db.get_connection();c.execute('DROP TRIGGER fail_snz_edit');c.commit();c.close()

    def test_all_positions_can_be_excluded_without_deleting_the_order(self):
        oid,original=self.prepare();self.apply(oid,self.proposal(oid,list(self.ids)))
        current=self.snz.read_order(self.object_id,oid,self.admin)
        self.assertEqual(current['tasks'],[])
        self.assertEqual(len(self.snz.list_order_revisions(self.object_id,oid,self.admin)),2)
        self.assertEqual(self.snz.read_order_revision(self.object_id,oid,1,self.admin)['tasks'],original['tasks'])
        out=Path(__file__).resolve().parents[1]/'outputs/snz-order-edit';out.mkdir(parents=True,exist_ok=True)
        (out/'empty.pdf').write_bytes(self.snz.export_pdf(self.object_id,oid,self.admin).body)
        xlsx=out/'empty.xlsx';xlsx.write_bytes(self.snz.export_xlsx(self.object_id,oid,self.admin).body)
        import subprocess
        subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(xlsx)],check=True,capture_output=True)

    def test_concurrent_same_request_creates_one_revision(self):
        oid,_=self.prepare();p=self.proposal(oid,[self.ids[0]])
        preview=self.snz.preview_order_edit(self.object_id,oid,p,self.admin)
        body=self.snz.EditOrderIn(**p.model_dump(),request_id='concurrent-edit',expected_hash=preview['fingerprint'])
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.snz.edit_order(self.object_id,oid,body,self.admin),range(2)))
        self.assertEqual(sum(bool(r.get('already_applied')) for r in results),1)
        self.assertEqual(len(self.snz.list_order_revisions(self.object_id,oid,self.admin)),2)
        self.assertEqual(self.snz.get_state(self.object_id,self.admin)['revision'],p.revision+1)

    def test_old_and_new_exports_are_valid(self):
        oid,original=self.prepare();self.apply(oid,self.proposal(oid,[self.ids[0]]))
        from openpyxl import load_workbook
        from io import BytesIO
        for rev in [1,2]:
            xlsx=self.snz.export_xlsx(self.object_id,oid,self.admin,revision=rev).body
            wb=load_workbook(BytesIO(xlsx));self.assertGreater(wb['СНЗ'].max_row,5)
            pdf=self.snz.export_pdf(self.object_id,oid,self.admin,revision=rev).body;self.assertTrue(pdf.startswith(b'%PDF'))
            path=Path(__file__).resolve().parents[1]/'outputs/snz-order-edit'/f'revision-{rev}.xlsx';path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(xlsx);path.with_suffix('.pdf').write_bytes(pdf)
            import subprocess
            subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(path)],check=True,capture_output=True)

    def test_daily_registry_counts_frozen_foreman_and_night_date(self):
        oid,_=self.prepare()
        data=self.snz.get_state(self.object_id,self.admin)
        plan=self.snz.preview(self.object_id,self.snz.PlanIn(revision=data['revision'],date='2026-11-10',shift='night',crew_id='install1'),self.admin)
        # Historical overlapping carry snapshots remain readable/editable under their original rules.
        from unittest.mock import patch
        with patch('app.snz_closure.assert_previous_orders_closed'):
            self.snz.issue(self.object_id,self.snz.IssueIn(revision=data['revision'],date='2026-11-10',shift='night',crew_id='install1',expected_hash=plan['fingerprint'],request_id='night'),self.admin)
        data=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(data['registry_by_date']['2026-11-10'],{'quantity':8,'unique_quantity':4})
        self.assertEqual(data['orders'][0]['quantity'],4)
        self.assertEqual(data['orders'][0]['end'],'2026-11-11T08:00')
        data['state']['crews'][1]['foreman']='Changed after issue'
        data['state']['crews'][1]['name']='Changed crew'
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=data['revision'],**{k:v for k,v in data['state'].items() if k!='facts'}),self.admin)
        rows=self.snz.get_state(self.object_id,self.admin)['orders']
        self.assertNotEqual(rows[0]['foreman'],'Changed after issue')
        self.assertNotEqual(rows[0]['crew_name'],'Changed crew')
        from datetime import date
        from openpyxl import load_workbook
        from io import BytesIO
        import subprocess
        for day,name in [(date(2026,11,10),'daily-register'),(date(2026,11,11),'empty-register')]:
            response=self.snz.export_registry(self.object_id,day,self.admin)
            path=Path(__file__).resolve().parents[1]/'outputs/snz-order-edit'/f'{name}.xlsx'
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(response.body)
            subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(path)],check=True,capture_output=True)
            ws=load_workbook(BytesIO(response.body)).active
            if day.day==10:
                self.assertEqual(ws['B5'].value.isoformat(),'2026-11-10T00:00:00')
                self.assertEqual(ws['F5'].value,4)
                totals={r[0].value:r[5].value for r in ws if r[0].value in ('Итого по документам, шт','Уникальных изделий плана, шт')}
                self.assertEqual(totals,{'Итого по документам, шт':8,'Уникальных изделий плана, шт':4})
            else:self.assertEqual(len(ws.tables),0)


if __name__=='__main__':unittest.main(verbosity=2)
