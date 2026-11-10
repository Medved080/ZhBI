"""Deletion, unlocking and reissue of SNZ on a disposable synthetic database."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_snz as fixtures


class DeleteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass()
        cls.h = fixtures.IntegrationTests()
        for key in ['snz', 'db', 'object_id', 'other_id', 'admin', 'ids']:
            setattr(cls, key, getattr(fixtures.IntegrationTests, key))

    def setUp(self):
        self.h.setUp()
        c = self.db.get_connection();c.execute('DELETE FROM snz_deleted_orders');c.commit();c.close()

    def prepare(self, empty=False):
        self.h.save_fixture();oid=self.h.issue()['id']
        if empty:
            d=self.snz.get_state(self.object_id,self.admin)
            body=self.snz.EditPreviewIn(revision=d['revision'],order_revision=1,exclude_element_ids=self.ids,reason='Все изделия попали ошибочно')
            preview=self.snz.preview_order_edit(self.object_id,oid,body,self.admin)
            self.snz.edit_order(self.object_id,oid,self.snz.EditOrderIn(**body.model_dump(),request_id='empty',expected_hash=preview['fingerprint']),self.admin)
        return oid

    def body(self,oid,request='delete'):
        return self.snz.DeleteOrderIn(revision=self.snz.get_state(self.object_id,self.admin)['revision'],
            order_revision=self.snz.read_order(self.object_id,oid,self.admin)['order_revision'],request_id=request)

    def delete(self,oid,body=None):
        return self.snz.delete_issued_order(self.object_id,oid,body or self.body(oid),self.admin)

    def test_empty_edited_order_can_be_deleted_reassigned_and_reissued(self):
        oid=self.prepare(empty=True)
        before=self.snz.get_state(self.object_id,self.admin)
        c=self.db.get_connection();original=dict(c.execute('SELECT * FROM snz_orders WHERE id=?',(oid,)).fetchone())
        revisions=[dict(r) for r in c.execute('SELECT * FROM snz_order_revisions WHERE order_id=? ORDER BY revision',(oid,))];c.close()
        body=self.body(oid);r=self.delete(oid,body)
        self.assertEqual(r['cleared_element_ids'],self.ids)
        after=self.snz.get_state(self.object_id,self.admin)
        self.assertEqual(after['orders'],[]);self.assertEqual(after['locked_element_ids'],[])
        self.assertEqual(after['state']['assignments'],[])
        for key in ['cards','crews','teams','operations','groups','facts']:
            self.assertEqual(after['state'][key],before['state'][key])
        self.assertTrue(all(e['planned_installation_date'] is None for e in after['elements']))
        c=self.db.get_connection();archive=c.execute('SELECT * FROM snz_deleted_orders WHERE order_id=?',(oid,)).fetchone()
        self.assertEqual(json.loads(archive['order_json']),original)
        self.assertEqual(json.loads(archive['revisions_json']),revisions)
        self.assertEqual(c.execute('SELECT COUNT(*) FROM snz_order_revisions').fetchone()[0],0);c.close()
        self.assertTrue(self.delete(oid,body)['already_deleted'])
        self.assertEqual(after,self.snz.get_state(self.object_id,self.admin))
        new=after['state'];new['assignments']=before['state']['assignments']
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=after['revision'],**{k:v for k,v in new.items() if k!='facts'}),self.admin)
        issued=self.h.issue(revision=after['revision']+1,request_id='reissue')
        self.assertNotEqual(issued['id'],oid)
        self.assertEqual(len(self.snz.read_order(self.object_id,issued['id'],self.admin)['tasks']),4)

    def test_full_document_is_removed_with_no_fact_changes(self):
        oid=self.prepare();before=self.snz.get_state(self.object_id,self.admin)
        r=self.delete(oid)
        self.assertEqual(r['released_element_ids'],self.ids)
        self.assertEqual(self.snz.get_state(self.object_id,self.admin)['state']['facts'],before['state']['facts'])
        with self.assertRaises(HTTPException):self.snz.read_order(self.object_id,oid,self.admin)

    def test_new_manual_assignment_after_exclusion_is_preserved(self):
        oid=self.prepare(empty=True);d=self.snz.get_state(self.object_id,self.admin)
        d['state']['assignments'][0]['date']='2026-11-11'
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=d['revision'],**{k:v for k,v in d['state'].items() if k!='facts'}),self.admin)
        r=self.delete(oid);after=self.snz.get_state(self.object_id,self.admin)
        self.assertNotIn(self.ids[0],r['cleared_element_ids'])
        self.assertEqual(after['state']['assignments'],[d['state']['assignments'][0]])
        self.assertEqual(after['elements'][0]['planned_installation_date'],'2026-11-11')

    def test_completed_and_later_connected_documents_are_protected(self):
        oid=self.prepare();d=self.snz.get_state(self.object_id,self.admin)
        order=self.snz.read_order(self.object_id,oid,self.admin)
        self.snz.complete(self.object_id,self.snz.FactIn(revision=d['revision'],task_key=order['tasks'][0]['key']),self.admin)
        before=self.snz.get_state(self.object_id,self.admin)
        with self.assertRaises(HTTPException):self.delete(oid)
        self.assertEqual(before,self.snz.get_state(self.object_id,self.admin))
        self.setUp();oid=self.prepare();d=self.snz.get_state(self.object_id,self.admin)
        p=self.snz.PlanIn(revision=d['revision'],date='2026-11-10',shift='night',crew_id='install1')
        preview=self.snz.preview(self.object_id,p,self.admin)
        night=self.snz.issue(self.object_id,self.snz.IssueIn(**p.model_dump(),request_id='night',expected_hash=preview['fingerprint']),self.admin)['id']
        with self.assertRaises(HTTPException):self.delete(oid)
        r=self.delete(night)
        self.assertEqual(r['released_element_ids'],[]);self.assertTrue(all(ids==[oid] for ids in r['kept_in_orders'].values()))
        self.assertEqual(len(self.snz.get_state(self.object_id,self.admin)['state']['assignments']),4)

    def test_permission_object_and_stale_revisions(self):
        oid=self.prepare();body=self.body(oid);before=self.snz.get_state(self.object_id,self.admin)
        for changed in [body.model_copy(update={'revision':0}),body.model_copy(update={'order_revision':2})]:
            with self.assertRaises(HTTPException):self.delete(oid,changed)
        with self.assertRaises(HTTPException) as e:self.snz.delete_issued_order(self.other_id,oid,body,self.admin)
        self.assertEqual(e.exception.status_code,404)
        with patch('app.snz.assert_object_feature',side_effect=HTTPException(403,'Нет прав')):
            with self.assertRaises(HTTPException) as e:self.delete(oid,body)
            self.assertEqual(e.exception.status_code,403)
        self.assertEqual(before,self.snz.get_state(self.object_id,self.admin))

    def test_failure_rolls_back_archive_document_and_planning(self):
        oid=self.prepare();before=self.snz.get_state(self.object_id,self.admin)
        c=self.db.get_connection();c.execute("CREATE TRIGGER fail_snz_delete BEFORE DELETE ON snz_orders BEGIN SELECT RAISE(ABORT,'failure'); END");c.commit();c.close()
        try:
            with self.assertRaises(Exception):self.delete(oid)
            self.assertEqual(before,self.snz.get_state(self.object_id,self.admin))
            c=self.db.get_connection();self.assertEqual(c.execute('SELECT COUNT(*) FROM snz_deleted_orders').fetchone()[0],0);c.close()
        finally:
            c=self.db.get_connection();c.execute('DROP TRIGGER fail_snz_delete');c.commit();c.close()

    def test_concurrent_retry_is_one_delete_and_request_id_cannot_change(self):
        oid=self.prepare();body=self.body(oid)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.delete(oid,body),range(2)))
        self.assertEqual(sum(bool(r.get('already_deleted')) for r in results),1)
        self.assertEqual(self.snz.get_state(self.object_id,self.admin)['revision'],body.revision+1)
        with self.assertRaises(HTTPException):self.delete(oid,body.model_copy(update={'order_revision':99}))


if __name__=='__main__':unittest.main(verbosity=2)
