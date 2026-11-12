"""Daily open plan/closed fact and unallocated model installation, synthetic DB."""
import sys,json,unittest
from pathlib import Path
from datetime import date
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz_fact_reporting as reporting
from app.snz_daily_report import collect,drawing_order
from app.contracts import apply_status_change


class DailyReportTests(reporting.ReportingTests):
    def data(self,day='2026-11-10'):
        c=self.db.get_connection()
        try:
            state,_=self.snz._load(c,self.object_id)
            return collect(c,self.object_id,state,day)
        finally:c.close()

    def install(self,eid,when):
        c=self.db.get_connection();apply_status_change(c,eid,'installed',False,None,when,'','Test',self.admin['id']);c.commit();c.close()

    def close_day(self):
        preview=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'day','install1',self.admin)
        self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=preview['revision'],date='2026-11-10',shift='day',crew_id='install1',expected_hash=preview['fingerprint'],request_id='daily-close'),self.admin)

    def workbook(self):
        from openpyxl import load_workbook
        return load_workbook(BytesIO(self.snz.export_registry(self.object_id,date(2026,11,10),self.admin).body))

    def test_open_orders_are_plan_only_even_if_model_has_actuals(self):
        self.install(self.base.ids[0],'2026-11-10 12:00:00')
        data=self.data();self.assertEqual(data['mode'],'plan')
        self.assertTrue(all(row['completed'] is None for row in data['registry']['orders']))
        sheet=self.workbook()['Реестр СНЗ']
        self.assertIn('план за',sheet['A1'].value)
        self.assertEqual(sheet.tables['SNZDailyPlanFactRegister'].ref,'A4:F6')
        self.assertIsNone(sheet['G4'].value)

    def test_mixed_closure_is_per_row_and_closed_result_stays_frozen(self):
        self.install(self.base.ids[0],'2026-11-10 12:00:00');self.close_day()
        data=self.data();self.assertEqual(data['mode'],'plan_fact')
        rows={r['shift']:r for r in data['registry']['orders']}
        self.assertEqual(rows['day']['completed'],1);self.assertIsNone(rows['night']['completed'])
        self.install(self.base.ids[1],'2026-11-11 12:00:00')
        data=self.data();self.assertEqual(next(r for r in data['registry']['orders'] if r['shift']=='day')['completed'],1)
        sheet=self.workbook()['Реестр СНЗ']
        self.assertEqual(sheet.tables['SNZDailyPlanFactRegister'].ref,'A4:G6')
        values={sheet.cell(i,3).value:sheet.cell(i,7).value for i in (5,6)}
        self.assertEqual(values,{'День':1,'Ночь':None})
        selected={e['id']:e for e in drawing_order(data)['items']}
        self.assertTrue(selected[self.base.ids[1]]['closed'])
        self.assertEqual(selected[self.base.ids[1]]['current_status'],'ready_for_installation')

    def test_model_montage_without_snz_includes_night_morning_and_separate_registry(self):
        self.install(self.extra,'2026-11-11 07:59:59')
        data=self.data();self.assertEqual([r['id'] for r in data['unallocated']],[self.extra]);self.assertEqual(data['unallocated'][0]['shift'],'night')
        sheet=self.workbook()['Реестр СНЗ'];self.assertIn('SNZUnallocatedMontage',sheet.tables)
        header=int(sheet.tables['SNZUnallocatedMontage'].ref.split(':')[0][1:])
        self.assertEqual(sheet.cell(header+1,2).value,'Доп-5');self.assertEqual(sheet.cell(header+1,7).value,1)
        self.assertEqual(sheet.cell(header+1,6).number_format,'dd.mm.yyyy hh:mm:ss')
        out=Path(__file__).resolve().parents[1]/'outputs/snz-daily-report';out.mkdir(parents=True,exist_ok=True)
        (out/'daily.xlsx').write_bytes(self.snz.export_registry(self.object_id,date(2026,11,10),self.admin).body)
        pdf=self.snz.export_daily_pdf(self.object_id,date(2026,11,10),self.admin).body;(out/'daily.pdf').write_bytes(pdf)
        import fitz
        pages=fitz.open(stream=pdf,filetype='pdf');self.assertEqual(len(pages),1)
        self.assertIn('БЕЗ СНЗ - Доп-5',pages[0].get_text())
        selected={e['id'] for e in drawing_order(data)['items']};self.assertEqual(selected,set(self.base.ids)|{self.extra})

    def test_eight_to_eight_boundaries_and_current_status(self):
        for when,included in [('2026-11-10 07:59:59',False),('2026-11-10 08:00:00',True),('2026-11-11 07:59:59',True),('2026-11-11 08:00:00',False)]:
            c=self.db.get_connection();c.execute('DELETE FROM status_history WHERE element_id=?',(self.extra,));c.execute("UPDATE elements SET current_status='ready_for_installation' WHERE id=?",(self.extra,));c.commit();c.close()
            self.install(self.extra,when);self.assertEqual(bool(self.data()['unallocated']),included,when)
        c=self.db.get_connection();apply_status_change(c,self.extra,'delivered',False,None,'2026-11-11 08:05:00','','Test',self.admin['id']);c.commit();c.close()
        self.assertFalse(self.data()['unallocated'])

    def test_attributed_extra_not_repeated_in_unallocated_even_if_time_outside_date(self):
        self.install(self.extra,'2026-11-10 07:30:00')
        body=self.extra_body(shift='day',completed_at=None);self.snz.complete_extra_fact(self.object_id,body,self.admin)
        self.assertFalse(self.data()['unallocated']);self.assertFalse(self.data('2026-11-09')['unallocated'])
        selected={e['id']:e for e in drawing_order(self.data())['items']}
        self.assertIn(self.extra,selected);self.assertTrue(selected[self.extra]['outside_snz'])

    def test_new_install_after_rollback_of_old_attribution_is_unallocated(self):
        self.snz.complete_extra_fact(self.object_id,self.extra_body(),self.admin)
        c=self.db.get_connection();apply_status_change(c,self.extra,'delivered',False,None,'2026-11-11 08:10:00','','Test',self.admin['id']);c.commit();c.close()
        self.install(self.extra,'2026-11-11 09:00:00')
        self.assertFalse(self.data()['unallocated']);self.assertEqual([r['id'] for r in self.data('2026-11-11')['unallocated']],[self.extra])

    def test_inactive_models_not_included(self):
        self.install(self.extra,'2026-11-10 12:00:00')
        c=self.db.get_connection();c.execute('UPDATE elements SET is_current=0 WHERE id=?',(self.extra,));c.commit();c.close()
        try:self.assertFalse(self.data()['unallocated'])
        finally:
            c=self.db.get_connection();c.execute('UPDATE elements SET is_current=1 WHERE id=?',(self.extra,));c.commit();c.close()

    def test_all_closed_zero_is_fact_not_empty_pending_value(self):
        self.close_day()
        preview=self.snz.preview_close_orders(self.object_id,date(2026,11,10),'night','install1',self.admin)
        self.snz.close_issued_orders(self.object_id,self.snz.CloseScopeIn(revision=preview['revision'],date='2026-11-10',shift='night',crew_id='install1',expected_hash=preview['fingerprint'],request_id='daily-close-night'),self.admin)
        result=self.data();self.assertEqual(result['mode'],'plan_fact')
        self.assertEqual([r['completed'] for r in result['registry']['orders']],[0,0])

    def test_model_only_day_has_fact_and_pdf_without_any_snz(self):
        self.install(self.extra,'2026-11-11 12:00:00')
        result=self.data('2026-11-11');self.assertEqual(result['mode'],'fact')
        self.assertFalse(result['snapshots']);self.assertEqual([r['id'] for r in result['unallocated']],[self.extra])
        import fitz
        response=self.snz.export_daily_pdf(self.object_id,date(2026,11,11),self.admin)
        text=''.join(p.get_text() for p in fitz.open(stream=response.body,filetype='pdf'))
        self.assertIn('Суточный факт вне СНЗ',text);self.assertIn('БЕЗ СНЗ - Доп-5',text)

    def test_no_writes_and_empty_day_pdf(self):
        c=self.db.get_connection();before=[tuple(r) for r in c.execute('SELECT * FROM snz_state')];c.close()
        for _ in range(2):self.data()
        c=self.db.get_connection();after=[tuple(r) for r in c.execute('SELECT * FROM snz_state')];c.close();self.assertEqual(before,after)
        import fitz
        data=self.snz.export_daily_pdf(self.object_id,date(2026,11,20),self.admin).body
        text=''.join(p.get_text() for p in fitz.open(stream=data,filetype='pdf'))
        self.assertIn('За выбранную дату нет СНЗ',text)


if __name__=='__main__':unittest.main(verbosity=2)
