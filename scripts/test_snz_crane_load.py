"""Crane load matches the supplied daily Excel's SUMIFS semantics."""
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
    def test_split_norm_repeats_as_in_reference_and_uncapped(self):
        snapshot={'tasks':[
            {'norm_minutes':60,'segments':[{},{}]},
            *[{'norm_minutes':60,'segments':[{}]} for _ in range(9)],
        ]}
        before=deepcopy(snapshot)
        self.assertAlmostEqual(crane_load(snapshot),660/620)
        self.assertGreater(crane_load(snapshot),1)
        self.assertEqual(snapshot,before)

    def test_unscheduled_unknown_empty_and_preparation_rows(self):
        self.assertEqual(crane_load({'tasks':[]}),0)
        self.assertEqual(crane_load({'tasks':[{'norm_minutes':None,'segments':[{},{}]}]}),0)
        self.assertAlmostEqual(crane_load({'crew':{'kind':'preparation'},'tasks':[
            {'norm_minutes':100,'segments':[]},
            {'norm_minutes':90,'segments':[{}]},
        ]}),190/620)

    def test_matches_numeric_norm_column_in_detailed_export(self):
        for shift in ('day','night'):
            state,items=fixtures.fixture((1,2,3,4),(('install',180,0),),shift=shift)
            order=fixtures.schedule(state,items,shift=shift)
            # Include an unknown and a no-interval task as the export does.
            order['tasks'][0]['norm_minutes']=None
            order['tasks'][-1]['segments']=[]
            wb=load_workbook(BytesIO(build_xlsx(order,daily_details=True)))
            ws=wb['СНЗ'];column=[c.value for c in ws[3]].index('Норматив, мин')
            total=sum(row[column].value or 0 for row in ws.iter_rows(min_row=4))
            self.assertAlmostEqual(crane_load(order),total/620)


if __name__=='__main__':unittest.main(verbosity=2)
