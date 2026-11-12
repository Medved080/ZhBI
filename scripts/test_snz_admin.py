"""Full issued-order amendments, frozen audit and downstream collision guards."""
import sys,unittest,json
from pathlib import Path
from copy import deepcopy
from datetime import date
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixture
from fastapi import HTTPException


class AdminTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.IntegrationTests.setUpClass();cls.base=fixture.IntegrationTests;cls.snz=cls.base.snz;cls.db=cls.base.db;cls.admin=cls.base.admin;cls.object_id=cls.base.object_id
        from app import snz_admin
        cls.api=snz_admin
        c=cls.db.get_connection();e=fixture.element(5)
        cls.extra=c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,'ready_for_installation')",(e['source_file'],'extra','snz',e['element_type'],'Доп-5',e['x'],e['y'],cls.object_id,1,e['outline_json'])).lastrowid
        cls.viewer=c.execute("INSERT INTO users(last_name,domain_login,role) VALUES ('Observer','admin-snz-view','view')").lastrowid
        c.commit();c.close()

    def setUp(self):
        self.base().setUp();c=self.db.get_connection();c.execute('DELETE FROM status_history');c.commit();c.close()
        self.base().save_fixture();self.oid=self.base().issue()['id']

    def editor(self):return self.api.read_editor(self.object_id,self.oid,self.admin)

    def proposal(self,edit=None):
        data=self.editor();rows=deepcopy(data['positions'])
        if edit:edit(rows)
        return self.api.AdminPreviewIn(revision=data['revision'],order_revision=data['order_revision'],positions=rows,reason='Учебное исправление')

    def save(self,proposal,request='admin-test'):
        preview=self.api.preview_editor(self.object_id,self.oid,proposal,self.admin)
        body=self.api.AdminSaveIn(**proposal.model_dump(),request_id=request,expected_hash=preview['fingerprint'])
        return self.api.save_editor(self.object_id,self.oid,body,self.admin),body,preview

    def close(self):
        data=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','install1',self.admin)
        self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=data['revision'],date='2026-11-10',shift='day',crew_id='install1',expected_hash=data['fingerprint'],request_id='admin-close'),self.admin)

    def test_add_remove_edit_and_version_differences(self):
        original=self.snz.read_order(self.object_id,self.oid,self.admin)
        def change(rows):
            rows.pop(1);added=deepcopy(rows[0]);added.update(element_id=self.extra,priority=4);rows.append(added)
            for i,row in enumerate(rows,1):row['priority']=i
            rows[0]['steps'][0].update(minutes=35,team_id='4',wait_after=5,planned_start='2026-11-10T09:00:00')
        result,body,preview=self.save(self.proposal(change))
        self.assertEqual(result['order_revision'],2);self.assertIn(self.extra,{e['id'] for e in self.editor()['order']['items']})
        self.assertNotIn(self.base.ids[1],{e['id'] for e in self.editor()['order']['items']})
        fields={r['field'] for r in preview['changes']};self.assertTrue({'Позиция','Норматив, мин','Звено','Техперерыв, мин','Плановое время'}<=fields)
        first=self.snz.read_order_revision(self.object_id,self.oid,1,self.admin);self.assertEqual(first['tasks'],original['tasks'])
        hist=self.snz.list_order_revisions(self.object_id,self.oid,self.admin)
        self.assertEqual([r['revision'] for r in hist],[2,1]);self.assertTrue(hist[0]['created_by']);self.assertTrue(hist[0]['created_at']);self.assertTrue(hist[0]['changes'])
        self.assertTrue(self.api.save_editor(self.object_id,self.oid,body,self.admin)['already_applied'])
        self.assertEqual(len(self.snz.list_order_revisions(self.object_id,self.oid,self.admin)),2)
        changed=body.model_copy(update={'reason':'Different'})
        with self.assertRaises(HTTPException):self.api.save_editor(self.object_id,self.oid,changed,self.admin)

    def test_closed_fact_correction_status_time_and_frozen_versions(self):
        self.close();proposal=self.proposal(lambda rows:rows[0]['steps'][0].update(completed=True,completed_at='2026-11-10T10:15:00'))
        self.save(proposal);current=self.snz.read_order(self.object_id,self.oid,self.admin)
        self.assertTrue(current['closed_at']);self.assertTrue(current['facts'][f'e:{self.base.ids[0]}:install']['completed'])
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT current_status FROM elements WHERE id=?',(self.base.ids[0],)).fetchone()[0],'installed');c.close()
        self.save(self.proposal(lambda rows:rows[0]['steps'][0].update(completed_at='2026-11-10T10:25:00')),'time-fix')
        self.assertEqual(self.editor()['positions'][0]['steps'][0]['completed_at'],'2026-11-10T10:25:00')
        archive=self.snz.read_order_revision(self.object_id,self.oid,2,self.admin)
        self.assertEqual(archive['facts'][f'e:{self.base.ids[0]}:install']['completed_at'],'2026-11-10T10:15:00')
        self.save(self.proposal(lambda rows:rows[0]['steps'][0].update(completed=False,completed_at=None)),'fact-reset')
        self.assertFalse(self.editor()['positions'][0]['steps'][0]['completed'])
        self.assertTrue(self.snz.read_order_revision(self.object_id,self.oid,2,self.admin)['facts'][f'e:{self.base.ids[0]}:install']['completed'])

    def later(self,shared):
        c=self.db.get_connection();raw=json.loads(c.execute('SELECT snapshot_json FROM snz_orders WHERE id=?',(self.oid,)).fetchone()[0]);raw['date']='2026-11-11';raw['start']='2026-11-11T08:00';raw['end']='2026-11-11T20:00'
        if not shared:
            e=fixture.element(self.extra);raw['items']=[e]
            for t in raw['tasks']:t['element_ids']=[self.extra];t['elements']=[e];t['key']=f'e:{self.extra}:install'
        oid=c.execute("INSERT INTO snz_orders(object_id,work_date,shift,crew_id,source_revision,request_id,created_by,snapshot_json) VALUES (?,?,?,? ,?,?,?,?)",(self.object_id,'2026-11-11','day','install1',1,'later-test','Other',json.dumps(raw))).lastrowid;c.commit();c.close();return oid

    def test_conflicting_later_order_rejects_atomically(self):
        later=self.later(True);p=self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=30))
        with self.assertRaises(HTTPException) as error:self.api.preview_editor(self.object_id,self.oid,p,self.admin)
        self.assertEqual(error.exception.status_code,409);self.assertIn(str(later),str(error.exception.detail));self.assertEqual(self.editor()['order_revision'],1)

    def test_new_remainder_conflicts_with_later_resource_plan(self):
        later=self.later(False);proposal=self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=43200))
        with self.assertRaises(HTTPException) as error:self.api.preview_editor(self.object_id,self.oid,proposal,self.admin)
        self.assertIn(str(later),str(error.exception.detail));self.assertEqual(self.editor()['order_revision'],1)

    def test_unrelated_later_order_allows_change_and_is_unchanged(self):
        later=self.later(False);original=self.snz.read_order(self.object_id,later,self.admin)
        self.save(self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=30)))
        self.assertEqual(self.snz.read_order(self.object_id,later,self.admin)['tasks'],original['tasks'])

    def test_fact_only_change_preserves_plan_and_other_operations(self):
        proposal=self.proposal(lambda rows:rows[0]['steps'][0].update(completed=True,completed_at='2026-11-10T09:10:00'))
        tasks=self.editor()['order']['tasks'];self.save(proposal)
        self.assertEqual(self.editor()['order']['tasks'],tasks)
        self.assertEqual(self.editor()['positions'][0]['steps'][0]['completed_at'],'2026-11-10T09:10:00')

    def test_rights_other_object_stale_revision_and_fingerprint(self):
        c=self.db.get_connection();viewer=c.execute('SELECT * FROM users WHERE id=?',(self.viewer,)).fetchone();c.close()
        with self.assertRaises(HTTPException) as error:self.api.read_editor(self.object_id,self.oid,viewer)
        self.assertEqual(error.exception.status_code,403)
        with self.assertRaises(HTTPException):self.api.read_editor(self.base.other_id,self.oid,self.admin)
        denied=self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=30))
        with self.assertRaises(HTTPException):self.api.preview_editor(self.object_id,self.oid,denied,viewer)
        with self.assertRaises(HTTPException):self.api.save_editor(self.object_id,self.oid,self.api.AdminSaveIn(**denied.model_dump(),request_id='denied',expected_hash='0'*64),viewer)
        p=self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=30));preview=self.api.preview_editor(self.object_id,self.oid,p,self.admin)
        with self.assertRaises(HTTPException):self.api.save_editor(self.object_id,self.oid,self.api.AdminSaveIn(**p.model_dump(),request_id='bad',expected_hash='0'*64),self.admin)
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,self.base.ids[0],'installed',False,None,'2026-11-10 11:00:00','','External',self.admin['id']);c.commit();c.close()
        with self.assertRaises(HTTPException):self.api.save_editor(self.object_id,self.oid,self.api.AdminSaveIn(**p.model_dump(),request_id='stale',expected_hash=preview['fingerprint']),self.admin)
        self.assertEqual(self.editor()['order_revision'],1)

    def test_invalid_unknown_and_empty_document(self):
        for edit in [lambda rows:rows.append(deepcopy(rows[0])),lambda rows:rows[0].update(element_id=999999),lambda rows:rows[0]['steps'][0].update(team_id='absent'),lambda rows:rows[0]['steps'][0].update(completed=True,completed_at=None)]:
            with self.assertRaises(HTTPException):self.api.preview_editor(self.object_id,self.oid,self.proposal(edit),self.admin)
        self.save(self.proposal(lambda rows:rows.clear()))
        self.assertEqual(self.editor()['order']['items'],[]);self.assertEqual(self.editor()['order']['tasks'],[])

    def test_independent_operation_fact_does_not_install_product(self):
        def change(rows):rows[0]['steps'].append({'operation_id':'rebar1','minutes':30,'wait_after':0,'team_id':'4','planned_start':None,'completed':True,'completed_at':'2026-11-10T10:00:00'})
        self.save(self.proposal(change));data=self.snz.read_order(self.object_id,self.oid,self.admin)
        self.assertTrue(data['facts'][f'e:{self.base.ids[0]}:rebar1']['completed'])
        self.assertFalse(data['facts'][f'e:{self.base.ids[0]}:install']['completed'])
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT current_status FROM elements WHERE id=?',(self.base.ids[0],)).fetchone()[0],'ready_for_installation');c.close()

    def test_failed_fact_correction_rolls_back_versions_and_status(self):
        from app.contracts import apply_status_change
        c=self.db.get_connection();apply_status_change(c,self.base.ids[0],'delivered',False,None,'2026-11-10 12:00:00','','External',self.admin['id']);c.commit();c.close()
        proposal=self.proposal(lambda rows:rows[0]['steps'][0].update(completed=True,completed_at='2026-11-10T10:00:00'))
        preview=self.api.preview_editor(self.object_id,self.oid,proposal,self.admin)
        with self.assertRaises(HTTPException):self.api.save_editor(self.object_id,self.oid,self.api.AdminSaveIn(**proposal.model_dump(),request_id='rollback',expected_hash=preview['fingerprint']),self.admin)
        self.assertEqual(self.editor()['order_revision'],1)
        c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM snz_order_revisions').fetchone()[0],0);self.assertEqual(c.execute('SELECT current_status FROM elements WHERE id=?',(self.base.ids[0],)).fetchone()[0],'delivered');c.close()

    def test_non_colliding_card_reference_allows_related_later_order(self):
        self.later(True);card=self.editor()['cards'][1]['id']
        result,_,_=self.save(self.proposal(lambda rows:rows[0].update(card_id=card)))
        self.assertEqual(result['order_revision'],2)

    def test_accepted_status_and_contract_preserved_on_time_correction(self):
        from app.contracts import apply_status_change
        eid=self.base.ids[0];c=self.db.get_connection()
        apply_status_change(c,eid,'installed',False,None,'2026-11-10 09:00:00','','Before',self.admin['id']);apply_status_change(c,eid,'accepted',False,None,'2026-11-10 13:00:00','','Before',self.admin['id']);c.commit();contract=c.execute('SELECT contract_id FROM elements WHERE id=?',(eid,)).fetchone()[0];c.close()
        self.save(self.proposal(lambda rows:rows[0]['steps'][0].update(completed_at='2026-11-10T09:15:00')))
        c=self.db.get_connection();row=c.execute('SELECT current_status,contract_id FROM elements WHERE id=?',(eid,)).fetchone();c.close()
        self.assertEqual(tuple(row),('accepted',contract));self.assertEqual(self.editor()['positions'][0]['steps'][0]['completed_at'],'2026-11-10T09:15:00')

    def test_concurrent_identical_save_creates_one_version(self):
        from concurrent.futures import ThreadPoolExecutor
        proposal=self.proposal(lambda rows:rows[0]['steps'][0].update(minutes=30));preview=self.api.preview_editor(self.object_id,self.oid,proposal,self.admin)
        body=self.api.AdminSaveIn(**proposal.model_dump(),request_id='parallel',expected_hash=preview['fingerprint'])
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.api.save_editor(self.object_id,self.oid,body,self.admin),range(2)))
        self.assertTrue(any(r.get('already_applied') for r in results));self.assertEqual(len(self.snz.list_order_revisions(self.object_id,self.oid,self.admin)),2)


if __name__=='__main__':unittest.main(verbosity=2)
