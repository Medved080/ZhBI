"""Report date parity and all live element response paths; no persisted date/migration."""
import unittest
from montage_filter_fixture import setup


class MontageFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = setup()

    def test_report_parity_and_read_only(self):
        from app.contracts import enrich_element_row
        from app.schedule_versions import forecast_dates
        from app.report_status_summary import build_status_summary
        from app.element_ops import _element_out
        from app import main
        c = self.h.db.get_connection()
        before = c.total_changes
        forecast = forecast_dates(c, self.h.object_id)
        days = {}
        for eid in self.h.ids:
            row = enrich_element_row(c, dict(c.execute('SELECT * FROM elements WHERE id=?', (eid,)).fetchone()))
            day = row['actual_installation_date']
            days[eid] = day
            self.assertEqual(day, forecast.get(eid, (None, None, False))[1] if row['current_status'] in ('installed', 'accepted') else None)
            self.assertEqual(_element_out(c, eid)['actual_installation_date'], day)
        self.assertEqual(list(days.values()), ['2026-11-08', '2026-11-08', '2026-11-08', None, '2026-11-09', None, '2026-11-07', None])
        ids = [eid for eid, day in days.items() if day == '2026-11-08']
        report = build_status_summary(c, None, ids, self.h.object_id, on_date='2026-11-08')
        self.assertEqual(report['fact']['montage']['n'], len(ids))
        self.assertEqual(c.total_changes, before)
        c.close()
        changes = main.get_changes(source_file='СНЗ-проверка.dxf', since='2000-01-01', user=self.h.admin)
        self.assertEqual({r['id']: r['actual_installation_date'] for r in changes['elements']}, days)


if __name__ == '__main__':
    unittest.main(verbosity=2)
