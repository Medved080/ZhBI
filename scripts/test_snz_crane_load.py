"""Crane load counts each issued operation once, across day/night intervals."""
import sys
import unittest
from copy import deepcopy
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_snz as fixtures
from app.snz_export import build_xlsx
from app.snz_registry import crane_load
from openpyxl import load_workbook


class CraneLoadTests(unittest.TestCase):
    def test_lunch_split_counts_norm_once_and_gives_97_percent(self):
        snapshot={'tasks':[
            {'norm_minutes':60,'segments':[{},{}]},
            *[{'norm_minutes':60,'segments':[{}]} for _ in range(9)],
        ]}
        before=deepcopy(snapshot)
        self.assertAlmostEqual(crane_load(snapshot),600/620)
        self.assertEqual(round(crane_load(snapshot)*100),97)
        self.assertEqual(snapshot,before)

    def test_distinct_tasks_of_same_operation_are_all_counted_and_uncapped(self):
        snapshot={'tasks':[
            {'operation_id':'install','element_ids':[eid],'norm_minutes':360,'segments':[{},{}]}
            for eid in (1,2)
        ]}
        self.assertAlmostEqual(crane_load(snapshot),720/620)
        self.assertGreater(crane_load(snapshot),1)

    def test_unscheduled_unknown_empty_and_preparation_rows(self):
        self.assertEqual(crane_load({'tasks':[]}),0)
        self.assertEqual(crane_load({'tasks':[{'norm_minutes':None,'segments':[{},{}]}]}),0)
        self.assertAlmostEqual(crane_load({'crew':{'kind':'preparation'},'tasks':[
            {'norm_minutes':100,'segments':[]},
            {'norm_minutes':90,'segments':[{}]},
        ]}),190/620)

    def test_matches_distinct_operations_in_detailed_export(self):
        for shift in ('day','night'):
            state,items=fixtures.fixture((1,2,3,4),(('install',180,0),),shift=shift)
            order=fixtures.schedule(state,items,shift=shift)
            # Include an unknown and a no-interval task as the export does.
            order['tasks'][0]['norm_minutes']=None
            order['tasks'][-1]['segments']=[]
            wb=load_workbook(BytesIO(build_xlsx(order,daily_details=True)))
            ws=wb['СНЗ'];column=[c.value for c in ws[3]].index('Норматив, мин')
            # The first column is the task number, repeated across its intervals.
            unique={row[0].value:row[column].value for row in ws.iter_rows(min_row=4)}
            total=sum(norm or 0 for norm in unique.values())
            self.assertAlmostEqual(crane_load(order),total/620)


if __name__=='__main__':unittest.main(verbosity=2)
