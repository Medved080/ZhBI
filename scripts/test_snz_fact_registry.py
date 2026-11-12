"""Per-document plan/fact totals, correct scopes, history and frozen old facts."""
import unittest,sys
from pathlib import Path
from copy import deepcopy
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.snz_fact_registry import summarize
from app.snz_fact_report import build_xlsx


def fixture():
    orders=[];items=[];statuses={};eid=0
    for oid,shift,crew,plan,done,extra in [(17,'day','green',4,3,0),(16,'day','red',3,3,0),(15,'night','yellow',11,11,2),(14,'day','yellow',6,5,0),(13,'day','white',19,19,0)]:
        orders.append(dict(id=oid,work_date='2026-11-11',shift=shift,crew_id=crew,crew_name='Монтажная бригада '+crew,foreman='Прораб проверки',quantity=plan,crew_kind='installation'))
        for i in range(plan+extra):
            eid+=1;confirmed=i<done or i>=plan
            ref={'id':oid,'date':'2026-11-11','shift':shift,'crew_id':crew,'crew':'Монтажная бригада '+crew,'foreman':'Прораб проверки'}
            statuses[eid]={'current_status':'installed' if confirmed else 'ready_for_installation','completed_at':'2026-11-12T01:00:00' if confirmed else None,'history_id':eid}
            row={'id':eid,'orders':[ref] if i<plan else [],'extra':[] if i<plan else [{**ref,'history_id':eid}],
                 'mark':f'П-{eid}','element_type':'Плита перекрытия','current_status':statuses[eid]['current_status'],
                 'completed_at':statuses[eid]['completed_at'],'status_confirmed':confirmed}
            items.append(row)
    return orders,items,statuses


class RegisterTests(unittest.TestCase):
    def test_reference_case_43_plan_43_fact_and_fact_exceeds_plan(self):
        orders,items,statuses=fixture();before=deepcopy((orders,items,statuses))
        result=summarize(orders,items,statuses)
        self.assertEqual([(r['planned'],r['completed']) for r in result['orders']],[(4,3),(3,3),(11,13),(6,5),(19,19)])
        self.assertEqual((result['planned'],result['completed']),(43,43))
        self.assertEqual(before,(orders,items,statuses))

    def test_closed_facts_are_per_order_not_merged_per_product(self):
        orders,items,statuses=fixture();eid=items[0]['id']
        orders=orders[:2]
        items=[{'id':eid,'orders':[{'id':17,'closed_at':'closed','frozen':{'status_confirmed':False}},
                                  {'id':16,'closed_at':'closed','frozen':{'status_confirmed':True}}]}]
        result=summarize(orders,items,{eid:{'current_status':'installed'}})
        self.assertEqual([r['completed'] for r in result['orders']],[0,1])

    def test_extra_only_in_its_crew_and_shift_and_once(self):
        orders,items,statuses=fixture();extra=items[18]
        extra=next(r for r in items if not r['orders']);extra['extra'].append(deepcopy(extra['extra'][0]))
        result=summarize(orders,items,statuses)
        self.assertEqual([(r['id'],r['completed']) for r in result['orders'] if r['crew_id']=='yellow'],[(15,13),(14,5)])
        statuses[extra['id']]['history_id']=-1
        self.assertEqual(summarize(orders,items,statuses)['orders'][2]['completed'],12)
        statuses[extra['id']]['completed_at']=None
        self.assertEqual(summarize(orders,items,statuses)['orders'][2]['completed'],12)

    def test_orphan_extra_is_separate_and_preparation_excluded(self):
        orders,items,statuses=fixture()
        result=summarize([r for r in orders if r['shift']=='day'],items,statuses)
        self.assertEqual(result['unassigned_extra'],2)
        orders[0]['crew_kind']='preparation'
        self.assertNotIn(17,[r['id'] for r in summarize(orders,items,statuses)['orders']])

    def data(self):
        orders,items,statuses=fixture();register=summarize(orders,items,statuses)
        return {'date':'2026-11-11','shift':None,'crew_id':None,'object_name':'Учебный объект','generated_at':'2026-11-12T12:00:00',
                'registry':register,'items':items,'totals':{'planned':43,'completed_plan':41,'uncompleted':2,'extra':2,'completed_total':43,'unique_items':45}}

    def test_xlsx_first_sheet_headers_totals_typed_dates_and_literal_names(self):
        from openpyxl import load_workbook
        data=self.data();data['registry']['orders'][0]['foreman']='=FORMULA()'
        payload=build_xlsx(data);wb=load_workbook(BytesIO(payload));ws=wb['Реестр СНЗ']
        self.assertEqual(wb.sheetnames,['Реестр СНЗ','План и факт','Итоги по бригадам'])
        self.assertEqual([c.value for c in ws[4]],['№ СНЗ','Дата','Смена','Бригада','Прораб','Количество план, шт','Количество факт, шт'])
        self.assertEqual((ws['F10'].value,ws['G10'].value),(43,43))
        self.assertEqual(ws['B5'].number_format,'dd.mm.yyyy');self.assertEqual(ws['B5'].data_type,'d')
        self.assertEqual(ws['E5'].data_type,'s');self.assertEqual(ws['E5'].value,'=FORMULA()')
        self.assertEqual(ws.tables['SNZDailyPlanFactRegister'].ref,'A4:G9')
        out=Path(__file__).resolve().parents[1]/'outputs/snz-fact-register';out.mkdir(parents=True,exist_ok=True)
        # Render a readable example with synthetic data and the user's totals.
        data['registry']['orders'][0]['foreman']='Прораб проверки';(out/'register.xlsx').write_bytes(build_xlsx(data))

    def test_empty_report_has_zero_totals_and_no_invalid_empty_table(self):
        from openpyxl import load_workbook
        data=self.data();data['items']=[];data['registry']=summarize([],[],{})
        wb=load_workbook(BytesIO(build_xlsx(data)));ws=wb['Реестр СНЗ']
        self.assertEqual((ws['F5'].value,ws['G5'].value),(0,0));self.assertFalse(ws.tables)


if __name__=='__main__':unittest.main(verbosity=2)
