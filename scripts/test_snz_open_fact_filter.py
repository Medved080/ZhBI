"""Open-order filtering before grouping; only disposable synthetic data."""
import unittest
from datetime import date
import test_snz_fact_reporting as reporting


def seed_mixed_orders(test):
    test.snz.complete_extra_fact(test.object_id,test.extra_body(shift='day',completed_at='2026-11-10T11:15:00'),test.admin)
    p=test.snz.preview_close_orders(test.object_id,date(2026,11,10),'day','install1',test.admin)
    test.snz.close_issued_orders(test.object_id,test.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift='day',crew_id='install1',expected_hash=p['fingerprint'],request_id='filter-close-day'),test.admin)
    saved=test.state();state={k:v for k,v in saved['state'].items() if k!='facts'}
    state['assignments'].append({'element_id':test.base.ids[0],'crew_id':'install1','card_id':'base','date':'2026-11-11','shift':'day','priority':1,'prep_priority':None})
    test.snz.save_state(test.object_id,test.snz.StateIn(revision=saved['revision'],**state),test.admin)
    params=dict(revision=test.state()['revision'],date='2026-11-11',shift='day',crew_id='install1',ignore_fact=True)
    plan=test.snz.preview(test.object_id,test.snz.PlanIn(**params),test.admin)
    return test.snz.issue(test.object_id,test.snz.IssueIn(**params,request_id='filter-next-date',expected_hash=plan['fingerprint']),test.admin)['id']


class OpenFactFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reporting.ReportingTests.setUpClass()
        cls.snz=reporting.ReportingTests.snz;cls.db=reporting.ReportingTests.db
        cls.object_id=reporting.ReportingTests.object_id;cls.admin=reporting.ReportingTests.admin
        cls.ids=reporting.ReportingTests.base.ids

    def setUp(self):
        self.fixture=reporting.ReportingTests();self.fixture.setUp()
        self.next_order=seed_mixed_orders(self.fixture)

    def rows(self,**kwargs):
        return self.snz.montage_facts(self.object_id,user=self.admin,**kwargs)['items']

    def test_selected_date_hides_closed_orders_and_outside_fact(self):
        before=self.fixture.state()
        all_rows=self.rows(date=date(2026,11,10));self.assertEqual(len(all_rows),5)
        rows=self.rows(date=date(2026,11,10),open_only=True)
        self.assertEqual({r['id'] for r in rows},set(self.ids[2:]))
        self.assertTrue(all(r['orders'] and not r.get('extra') and not r['closed'] for r in rows))
        self.assertEqual(self.fixture.state(),before)

    def test_empty_date_includes_all_open_dates_without_closed_references(self):
        rows=self.rows(open_only=True)
        self.assertEqual({r['id'] for r in rows},{self.ids[0],*self.ids[2:]})
        self.assertEqual({ref['date'] for r in rows for ref in r['orders']},{'2026-11-10','2026-11-11'})
        reused=next(r for r in rows if r['id']==self.ids[0])
        self.assertEqual([ref['id'] for ref in reused['orders']],[self.next_order])
        self.assertTrue(all(not ref['closed_at'] for r in rows for ref in r['orders']))
        self.assertEqual({r['id'] for r in self.rows(date=date(2026,11,11),open_only=True)},{self.ids[0]})
        self.assertEqual(self.rows(date=date(2026,11,12),open_only=True),[])

    def test_filters_intersect_and_completed_open_orders_are_included(self):
        row=self.rows(date=date(2026,11,10),open_only=True)[0]
        self.snz.complete(self.object_id,self.snz.FactIn(revision=self.fixture.state()['revision'],task_key=row['task_key'],order_id=row['orders'][0]['id'],expected_montage_rev=row['expected_rev'],completed_at='2026-11-10T21:00:00'),self.admin)
        self.assertEqual(len(self.rows(date=date(2026,11,10),open_only=True)),2)
        self.assertEqual({r['id'] for r in self.rows(date=date(2026,11,10),shift='night',crew_id='install1',open_only=True,without_fact=True)},{self.ids[3]})
        self.assertEqual({r['id'] for r in self.rows(shift='day',open_only=True)},{self.ids[0]})
        self.assertEqual(self.rows(crew_id='install2',open_only=True),[])

    def test_closing_last_selected_order_makes_filtered_list_empty(self):
        p=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'night','install1',self.admin)
        self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=p['revision'],date='2026-11-10',shift='night',crew_id='install1',expected_hash=p['fingerprint'],request_id='filter-close-night'),self.admin)
        self.assertEqual(self.rows(date=date(2026,11,10),open_only=True),[])
        self.assertTrue(self.rows(date=date(2026,11,10)))
        self.assertEqual({r['id'] for r in self.rows(open_only=True)},{self.ids[0]})


if __name__=='__main__':unittest.main(verbosity=2)
