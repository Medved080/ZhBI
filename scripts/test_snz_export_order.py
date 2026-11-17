"""Physical row order and native Excel sort state match issued priorities."""
import unittest
from copy import deepcopy
from io import BytesIO
import test_snz as fixtures
from app.snz_export import build_xlsx
from openpyxl import load_workbook


class ExportOrderTests(unittest.TestCase):
    def order(self):
        state,items=fixtures.fixture((1,2,3,4,5,6),(('install',20,0),))
        return fixtures.schedule(state,items)

    def test_numeric_order_with_stable_ties_and_missing_priorities_last(self):
        order=self.order();order['item_priorities']={'1':10,'2':2,'4':2}
        for task in order['tasks']:task['priorities']={}
        before=deepcopy(order)
        wb=load_workbook(BytesIO(build_xlsx(order)));ws=wb['Изделия']
        self.assertEqual([r[1].value for r in ws.iter_rows(min_row=2)],['Р-2','Р-4','Р-1','Р-3','Р-5','Р-6'])
        self.assertEqual([r[6].value for r in ws.iter_rows(min_row=2)],[2,2,10,None,None,None])
        sort=ws.tables['SNZElements'].autoFilter.sortState
        self.assertEqual(sort.sortCondition[0].ref,'G2:G7');self.assertFalse(sort.sortCondition[0].descending)
        self.assertEqual(order,before)

    def test_legacy_task_priorities_and_detailed_mode(self):
        order=self.order();order.pop('item_priorities',None)
        for task in order['tasks']:
            task['priorities']={str(eid):7-eid for eid in task['element_ids']}
        for detailed in (False,True):
            ws=load_workbook(BytesIO(build_xlsx(order,daily_details=detailed)))['Изделия']
            header=[c.value for c in ws[1]];mark=header.index('Марка');priority=header.index('Очередность')
            self.assertEqual([r[mark].value for r in ws.iter_rows(min_row=2)],['Р-6','Р-5','Р-4','Р-3','Р-2','Р-1'])
            self.assertEqual([r[priority].value for r in ws.iter_rows(min_row=2)],[1,2,3,4,5,6])
            self.assertEqual(ws.tables['SNZElements'].autoFilter.sortState.sortCondition[0].ref,'M2:M7' if detailed else 'G2:G7')


if __name__=='__main__':unittest.main(verbosity=2)
