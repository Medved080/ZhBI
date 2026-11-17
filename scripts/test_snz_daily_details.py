"""Daily register details use only current immutable documents of that start date."""
import sys
import unittest
from pathlib import Path
from datetime import date
from io import BytesIO
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_snz as fixtures


class DailyDetailsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.IntegrationTests.setUpClass();cls.h=fixtures.IntegrationTests()
        for key in ['snz','db','object_id','ids','admin']:setattr(cls,key,getattr(fixtures.IntegrationTests,key))

    def setUp(self):self.h.setUp()

    def assert_registry_load(self, workbook):
        details=workbook['СНЗ']
        norm=[c.value for c in details[1]].index('Норматив, мин')
        operations={}
        for row in details.iter_rows(min_row=2):
            operations.setdefault(row[0].value,{})[row[6].value]=row[norm].value or 0
        totals={oid:sum(tasks.values()) for oid,tasks in operations.items()}
        register=workbook['Реестр СНЗ']
        self.assertEqual(register['F4'].value,'Загрузка крана')
        for row in register.iter_rows(min_row=5,max_row=4+len(totals)):
            self.assertAlmostEqual(row[5].value,totals[row[0].value]/620)
            self.assertEqual(row[5].number_format,'0%')
        self.assertIsNone(register.cell(5+len(totals),6).value)

    def issue(self,day,shift,request):
        d=self.snz.get_state(self.object_id,self.admin)
        body=self.snz.PlanIn(revision=d['revision'],date=day,shift=shift,crew_id='install1')
        preview=self.snz.preview(self.object_id,body,self.admin)
        # Historical overlapping carry snapshots remain readable/editable under their original rules.
        from unittest.mock import patch
        with patch('app.snz_closure.assert_previous_orders_closed'):
            return self.snz.issue(self.object_id,self.snz.IssueIn(**body.model_dump(),request_id=request,expected_hash=preview['fingerprint']),self.admin)['id']

    def test_all_daily_sheets_include_both_shifts_and_exclude_next_start_date(self):
        from openpyxl import load_workbook
        import subprocess
        state,_=fixtures.fixture(tuple(self.ids),(("install",20,0),))
        state['crews'][1]['foreman']='Учебный прораб'
        for a in state['assignments'][2:]:a['shift']='night'
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        first=self.issue('2026-11-10','day','day');second=self.issue('2026-11-10','night','night');third=self.issue('2026-11-11','day','next-day')
        result=self.snz.export_registry(self.object_id,date(2026,11,10),self.admin)
        out=Path(__file__).resolve().parents[1]/'outputs/snz-daily-details';out.mkdir(parents=True,exist_ok=True)
        path=out/'daily.xlsx';path.write_bytes(result.body)
        subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(path)],check=True,capture_output=True)
        wb=load_workbook(BytesIO(result.body))
        self.assert_registry_load(wb)
        self.assertEqual(wb.sheetnames,['Реестр СНЗ','СНЗ','Изделия','Загрузка звеньев','Предупреждения'])
        for name in ['СНЗ','Изделия','Предупреждения']:
            ws=wb[name];self.assertEqual({row[0].value for row in ws.iter_rows(min_row=2)},{first,second})
            self.assertEqual(len(ws.tables),1)
            for row in ws:
                for cell in row:
                    # A copied style must refer to this workbook's registries.
                    _=cell.font.name,cell.fill.fill_type
                    self.assertNotEqual(cell.data_type,'f')
        self.assertEqual(wb['Изделия'].max_row,7)
        self.assertEqual({r[6].value for r in wb['Изделия'].iter_rows(min_row=2)},set(self.ids))
        night=[r for r in wb['СНЗ'].iter_rows(min_row=2) if r[0].value==second]
        self.assertTrue(all(r[14].value.date()==date(2026,11,10) for r in night))
        labels='\n'.join(str(c.value) for row in wb['Загрузка звеньев'] for c in row if c.value is not None)
        self.assertIn('2026-11-11 08:00',labels)
        self.assertIn(f'СНЗ № {first}',labels);self.assertIn(f'СНЗ № {second}',labels);self.assertNotIn(f'СНЗ № {third}',labels)
        self.assertTrue(any(c.fill.fgColor.rgb=='002563EB' for row in wb['Загрузка звеньев'] for c in row))
        self.assertNotIn('snapshots',self.snz.get_state(self.object_id,self.admin))

    def test_empty_day_has_all_five_sheets_without_broken_tables(self):
        from openpyxl import load_workbook
        import subprocess
        result=self.snz.export_registry(self.object_id,date(2026,11,10),self.admin)
        out=Path(__file__).resolve().parents[1]/'outputs/snz-daily-details';out.mkdir(parents=True,exist_ok=True)
        path=out/'empty-daily.xlsx';path.write_bytes(result.body)
        subprocess.run([sys.executable,'/Users/max/.codex/scripts/validate_xlsx.py',str(path)],check=True,capture_output=True)
        wb=load_workbook(BytesIO(result.body));self.assertEqual(len(wb.sheetnames),5)
        self.assertEqual(sum(len(ws.tables) for ws in wb),0)

    def test_details_use_current_revision_not_original_or_live_model(self):
        from openpyxl import load_workbook
        state,_=fixtures.fixture(tuple(self.ids),(("install",20,0),))
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),self.admin)
        oid=self.issue('2026-11-10','day','original')
        data=self.snz.get_state(self.object_id,self.admin)
        proposal=self.snz.EditPreviewIn(revision=data['revision'],order_revision=1,exclude_element_ids=[self.ids[-1]],reason='Исправление учебного состава')
        preview=self.snz.preview_order_edit(self.object_id,oid,proposal,self.admin)
        self.snz.edit_order(self.object_id,oid,self.snz.EditOrderIn(**proposal.model_dump(),request_id='edit',expected_hash=preview['fingerprint']),self.admin)
        conn=self.db.get_connection()
        conn.execute("UPDATE elements SET mark='Новая марка модели' WHERE id=?",(self.ids[0],));conn.commit();conn.close()
        current=self.snz.get_state(self.object_id,self.admin)
        changed={k:v for k,v in current['state'].items() if k!='facts'}
        changed['cards'][0]['steps'][0]['minutes']=99
        self.snz.save_state(self.object_id,self.snz.StateIn(revision=current['revision'],**changed),self.admin)
        wb=load_workbook(BytesIO(self.snz.export_registry(self.object_id,date(2026,11,10),self.admin).body))
        self.assert_registry_load(wb)
        self.assertAlmostEqual(wb['Реестр СНЗ']['F5'].value,20*len(self.ids[:-1])/620)
        self.assertEqual({r[6].value for r in wb['Изделия'].iter_rows(min_row=2)},set(self.ids[:-1]))
        self.assertEqual({r[5].value for r in wb['СНЗ'].iter_rows(min_row=2)},{2})
        self.assertNotIn('Новая марка модели',{r[9].value for r in wb['Изделия'].iter_rows(min_row=2)})


if __name__=='__main__':unittest.main(verbosity=2)
