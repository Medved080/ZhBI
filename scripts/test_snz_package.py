"""Daily ZIP, compact individual sheets and unchanged daily exports on a disposable DB."""
import asyncio
from datetime import date
from io import BytesIO
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_snz_daily_details as daily
import test_snz as fixtures
from app.snz_policy import order_items


class PackageTests(daily.DailyDetailsTests):
    def state_for_day(self):
        state, _ = fixtures.fixture(tuple(self.ids), (("install", 20, 0),))
        for assignment in state['assignments'][2:]:
            assignment['shift'] = 'night'
        self.snz.save_state(self.object_id, self.snz.StateIn(revision=0, **{k:v for k,v in state.items() if k!='facts'}), self.admin)

    def package(self, day='2026-11-10'):
        response = self.snz.export_daily_package(self.object_id, date.fromisoformat(day), self.admin)
        async def consume():
            return b''.join([chunk async for chunk in response.body_iterator])
        self.assertEqual(response.media_type, 'application/zip')
        return asyncio.run(consume())

    def validate(self, payload, name):
        path = Path(__file__).resolve().parents[1]/'outputs/snz-package'/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        subprocess.run([sys.executable, '/Users/max/.codex/scripts/validate_xlsx.py', str(path)], check=True, capture_output=True)
        return path

    def test_individual_xlsx_has_requested_columns_and_valid_native_table(self):
        from openpyxl import load_workbook
        self.state_for_day()
        oid = self.issue('2026-11-10', 'day', 'compact')
        payload = self.snz.export_xlsx(self.object_id, oid, self.admin).body
        self.validate(payload, 'individual-final.xlsx')
        wb = load_workbook(BytesIO(payload))
        self.assertNotIn('СНЗ', wb.sheetnames)
        self.assertIn('Загрузка звеньев', wb.sheetnames)
        items = wb['Изделия']
        self.assertEqual([c.value for c in items[1]], ['Тип элемента','Марка','Отметка, мм','Этаж','Адрес по осям','Бригада','Очередность','Время монтажа','Перенос с'])
        self.assertEqual(items.tables['SNZElements'].ref, f'A1:I{items.max_row}')
        self.assertEqual(items.freeze_panes, 'C2')
        self.assertTrue(all(row[7].number_format == 'dd.mm.yyyy hh:mm' for row in items.iter_rows(min_row=2)))
        self.assertEqual(items.max_row-1, len(order_items(self.snz.read_order(self.object_id, oid, self.admin))))

    def test_package_contains_latest_day_and_night_documents_and_full_daily_files(self):
        from openpyxl import load_workbook
        import fitz
        self.state_for_day()
        first = self.issue('2026-11-10', 'day', 'package-day')
        original = self.snz.read_order(self.object_id, first, self.admin)
        proposal = self.snz.EditPreviewIn(revision=original['current_revision'], order_revision=1, exclude_element_ids=[max(order_items(original))], reason='Учебная редакция')
        preview = self.snz.preview_order_edit(self.object_id, first, proposal, self.admin)
        self.snz.edit_order(self.object_id, first, self.snz.EditOrderIn(**proposal.model_dump(), request_id='package-edit', expected_hash=preview['fingerprint']), self.admin)
        second = self.issue('2026-11-10', 'night', 'package-night')
        third = self.issue('2026-11-11', 'day', 'package-next')
        conn = self.db.get_connection()
        before = '\n'.join(conn.iterdump()); conn.close()
        archive = self.package()
        conn = self.db.get_connection()
        self.assertEqual(before, '\n'.join(conn.iterdump())); conn.close()
        out = Path(__file__).resolve().parents[1]/'outputs/snz-package'
        (out/'package.zip').write_bytes(archive)
        with ZipFile(BytesIO(archive)) as bundle:
            self.assertIsNone(bundle.testzip())
            expected = {f'СНЗ-{oid}-ред-{revision}/СНЗ-{oid}-ред-{revision}{ending}' for oid,revision in [(first,2),(second,1)] for ending in ['.xlsx','-планы.pdf']}
            expected |= {'Реестр-СНЗ-2026-11-10.xlsx','Планы-за-день-2026-11-10.pdf'}
            self.assertEqual(set(bundle.namelist()), expected)
            self.assertFalse(any(f'СНЗ-{third}-' in name for name in bundle.namelist()))
            for name in bundle.namelist():
                payload = bundle.read(name)
                if name.endswith('.xlsx'):
                    self.validate(payload, Path(name).name)
                    wb = load_workbook(BytesIO(payload))
                    if '/' in name:
                        self.assertNotIn('СНЗ', wb.sheetnames)
                        self.assertEqual(wb['Изделия'].max_column,9)
                    else:
                        self.assertEqual(wb.sheetnames,['Реестр СНЗ','СНЗ','Изделия','Загрузка звеньев','Предупреждения'])
                        self.assertEqual(wb['Изделия'].max_column,23)
                        self.assertEqual({r[0].value for r in wb['Изделия'].iter_rows(min_row=2)}, {first,second})
                        self.assertEqual({r[5].value for r in wb['Изделия'].iter_rows(min_row=2) if r[0].value==first}, {2})
                else:
                    with fitz.open(stream=payload,filetype='pdf') as doc:
                        self.assertGreaterEqual(len(doc),1)
                        self.assertTrue(any(page.get_text().strip() for page in doc))

    def test_empty_day_still_has_both_daily_documents(self):
        with ZipFile(BytesIO(self.package())) as bundle:
            self.assertEqual(set(bundle.namelist()), {'Реестр-СНЗ-2026-11-10.xlsx','Планы-за-день-2026-11-10.pdf'})
            self.validate(bundle.read('Реестр-СНЗ-2026-11-10.xlsx'), 'empty-package.xlsx')

    def test_permissions_are_checked_before_export(self):
        from fastapi import HTTPException
        with patch('app.snz.assert_object_feature', side_effect=HTTPException(403,'Нет доступа')), patch('app.snz_package.build_package') as build:
            with self.assertRaises(HTTPException) as error:
                self.snz.export_daily_package(self.object_id, date(2026,11,10), self.admin)
            self.assertEqual(error.exception.status_code,403)
            build.assert_not_called()

    def test_failed_pdf_closes_temporary_archive_without_returning_partial_zip(self):
        from app.snz_package import build_package
        from tempfile import SpooledTemporaryFile
        archive = SpooledTemporaryFile(mode='w+b')
        def fail(_order): raise ValueError('Учебная ошибка плана')
        with patch('app.snz_package.SpooledTemporaryFile', return_value=archive), patch('app.snz_package.build_daily_xlsx', return_value=b'xlsx'), patch('app.snz_package.drawing_order', return_value={}):
            with self.assertRaises(ValueError):
                build_package({'snapshots':[]}, date(2026,11,10), fail)
        self.assertTrue(archive.closed)


if __name__=='__main__': unittest.main(verbosity=2)
