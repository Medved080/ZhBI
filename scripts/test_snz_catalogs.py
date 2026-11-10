"""Initial catalogs: reviewed source evidence, safe upgrade, editing and retries.

Only disposable synthetic databases are used. SNZ_SOURCE_XLSX optionally verifies
all checked-in evidence against the original read-only workbook.
"""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import db, release_tasks
from app.snz import StateIn
from app.snz_catalogs import SEED_VERSION, OPERATIONS, fill_initial_catalogs, manifest, seed_catalogs
from app.snz_core import default_state, suggest_card


def old_state():
    s = default_state()
    s.pop('catalog_seed')
    s['cards'] = s['cards'][:1]
    return s


class CatalogTests(unittest.TestCase):
    def test_new_objects_get_independent_complete_dictionaries(self):
        s = default_state()
        self.assertEqual(s['catalog_seed'], SEED_VERSION)
        self.assertEqual((len(s['teams']), len(s['operations']), len(s['cards'])), (4, 7, 13))
        StateIn(revision=0, **{k: v for k, v in s.items() if k != 'facts'})
        s['cards'][1]['steps'][0]['minutes'] = 888
        self.assertIsNone(default_state()['cards'][1]['steps'][0]['minutes'])
        self.assertEqual([o['scope'] for o in OPERATIONS[3:]], ['element'] * 4)

    def test_only_reviewed_macro_norms_and_literal_waits_are_imported(self):
        cards = manifest()['cards']
        values = {(c['id'], s['operation_id']): s['minutes'] for c in cards for s in c['steps'] if s['minutes'] is not None}
        self.assertEqual(len(values), 6)
        self.assertEqual(values.pop(('ok_column_middle_lower', 'scaffold')), 10)
        self.assertEqual(set(values.values()), {34})
        self.assertTrue(all(k.startswith('ok_beam_') and op == 'install' for k, op in values))
        waits = [(c['id'], s['operation_id'], s['wait_after']) for c in cards for s in c['steps'] if s['wait_after']]
        self.assertEqual(len(waits), 3)
        self.assertTrue(all(op == 'install' and v == 120 for _, op, v in waits))
        for c in cards:
            self.assertTrue(c['source_note'])
            for s in c['steps']:
                self.assertTrue(s['source_note'])
                if s['operation_id'].startswith(('rebar', 'concrete')):
                    self.assertIsNone(s['minutes'])

    def test_real_model_subtypes_axes_and_alias_match_without_guessing(self):
        s = default_state()
        for elevation, direction, length in [(15000, 'numeric', 12), (25800, 'numeric', 12), (25800, 'letter', 9), (34700, 'letter', 9)]:
            shape = [[0, 0], [400, 0], [400, 12000], [0, 12000]] if direction == 'numeric' else [[0, 0], [9000, 0], [9000, 400], [0, 400]]
            e = dict(element_type='Ригель', subtype=f'на отм. +{elevation/1000:.3f}', elevation_mm=elevation, outline_json=json.dumps(shape))
            level = 15800 if elevation == 15000 else elevation
            self.assertEqual(suggest_card(s, e), f'ok_beam_{length}_{level}')
        for subtype, key in [('нижняя', 'lower'), ('средняя нижний ярус', 'middle_lower'), ('средняя верхний ярус', 'middle_upper'), ('верхняя', 'upper')]:
            self.assertEqual(suggest_card(s, dict(element_type='Колонна', subtype=subtype)), 'ok_column_' + key)
        self.assertEqual(suggest_card(s, dict(element_type='Плита перекрытия', subtype='на отм. +15.000', elevation_mm=15000)), 'ok_slab_15800')
        # There is no source card for a 9 m beam at +15.8; do not invent one.
        self.assertEqual(suggest_card(s, dict(element_type='Ригель', elevation_mm=15800, outline_json='[[0,0],[9000,0],[9000,400],[0,400]]')), 'base')

    def test_manual_settings_and_equivalent_cards_are_preserved(self):
        s = old_state()
        s['teams'][0]['name'] = 'Ручное звено'
        s['operations'][2].update(name='Монтаж вручную', team='1')
        s['cards'][0]['steps'][2]['minutes'] = 77
        custom = deepcopy(manifest()['cards'][4]); custom.update(id='manual_beam', name='Ручная карта')
        custom['steps'][2]['minutes'] = 99
        s['cards'].append(custom)
        s['assignments'] = [dict(element_id=1, card_id='base', crew_id='install1')]
        s['groups'] = [dict(id='g', name='Ручной узел', element_ids=[1, 2, 3])]
        s['facts'] = {'e:1:install': {'completed': True, 'completed_at': '2026-11-10T10:00'}}
        before = deepcopy(s)
        new, reason = seed_catalogs(s)
        self.assertEqual(reason, '')
        self.assertEqual(s, before)
        for k in ('crews', 'assignments', 'groups', 'facts', 'operations'):
            self.assertEqual(new[k], before[k])
        self.assertEqual(new['teams'][:4], before['teams'])
        self.assertEqual(new['cards'][:2], before['cards'])
        self.assertNotIn('ok_beam_12_15800', [c['id'] for c in new['cards']])
        self.assertEqual(seed_catalogs(new)[0], new)

    def test_partial_dictionary_team_id_collision_and_conflicting_scope(self):
        s = old_state()
        s['teams'] = [dict(id='1', name='Другие работы'), dict(id='ok_team_1', name='Ещё работы')]
        s['operations'] = []
        new, reason = seed_catalogs(s)
        self.assertFalse(reason)
        self.assertEqual(next(o for o in new['operations'] if o['id'] == 'prepare')['team'], 'ok_team_1_1')
        self.assertEqual(len({t['id'] for t in new['teams']}), len(new['teams']))
        StateIn(revision=0, **{k: v for k, v in new.items() if k != 'facts'})
        s = old_state(); s['operations'][2]['scope'] = 'group'
        new, reason = seed_catalogs(s)
        self.assertIn('install', reason)
        self.assertEqual(s, new)

    def test_marker_preserves_manual_changes_and_deletions_on_force_repeat(self):
        s = default_state()
        s['cards'].pop(4)
        s['operations'][2]['name'] = 'Изменено после заполнения'
        s['cards'][4]['steps'][2]['minutes'] = 72
        new, reason = seed_catalogs(s)
        self.assertFalse(reason)
        self.assertEqual(new, s)

    @unittest.skipUnless(os.environ.get('SNZ_SOURCE_XLSX'), 'original workbook not provided')
    def test_checked_in_evidence_matches_original_without_modifying_it(self):
        import datetime
        import openpyxl
        p = Path(os.environ['SNZ_SOURCE_XLSX'])
        data = p.read_bytes(); m = manifest()
        self.assertEqual(hashlib.sha256(data).hexdigest(), m['source_sha256'])
        f = openpyxl.load_workbook(p, data_only=False)[m['sheet']]
        v = openpyxl.load_workbook(p, data_only=True)[m['sheet']]
        for cell, evidence in m['evidence'].items():
            def normalize(x):
                return str(x) if isinstance(x, (datetime.time, datetime.datetime, datetime.timedelta)) else x
            self.assertEqual(normalize(f[cell].value), evidence['formula_or_value'], cell)
            self.assertEqual(normalize(v[cell].value), evidence['cached_value'], cell)
        sources = {'ok_column_middle_lower': ('scaffold', [31]),
                   'ok_beam_12_15800': ('install', [136, 137, 138]),
                   'ok_beam_12_25800': ('install', [172, 173, 174]),
                   'ok_beam_9_25800': ('install', [207, 208, 209]),
                   'ok_beam_12_34700': ('install', [244, 245, 246]),
                   'ok_beam_9_34700': ('install', [279, 280, 281])}
        for card in m['cards']:
            if card['id'] not in sources:
                continue
            op, rows = sources[card['id']]
            minutes = sum(v[f'D{r}'].value.hour * 60 + v[f'D{r}'].value.minute
                          + v[f'D{r}'].value.second / 60 for r in rows)
            self.assertEqual(next(s['minutes'] for s in card['steps'] if s['operation_id'] == op), minutes)
        for row in (55, 91, 125):
            self.assertEqual(v[f'C{row}'].value, 'Технологический перерыв 2 часа')
        self.assertEqual(p.read_bytes(), data)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='snz_catalogs_')
        self.path = Path(self.tmp.name) / 'synthetic.db'
        self.db_patch = patch.object(db, 'DB_PATH', self.path); self.db_patch.start()
        db.init_db(); self.c = db.get_connection()
        self.ids = [self.c.execute("INSERT INTO objects(name,kind) VALUES (?,?)", (f'Синтетический объект {i}', kind)).lastrowid for i, kind in enumerate(('zhbi', 'zhbi', 'mfr'))]
        self.c.commit()

    def tearDown(self):
        self.c.close(); self.db_patch.stop(); self.tmp.cleanup()

    def snapshot(self):
        return [tuple(r) for r in self.c.execute('SELECT * FROM snz_state ORDER BY object_id')]

    def test_release_registration_fresh_existing_orders_revision_and_repeat(self):
        task = next(t for t in release_tasks.RELEASE_TASKS if t['name'] == '2026-11-10-snz-initial-catalogs')
        self.assertIs(task['run'], fill_initial_catalogs)
        self.assertEqual(task['kind'], release_tasks.KIND_DATA)
        s = old_state(); s['cards'][0]['steps'][2]['minutes'] = 88
        self.c.execute('INSERT INTO snz_state VALUES (?,7,?)', (self.ids[1], json.dumps(s, ensure_ascii=False)))
        self.c.execute("INSERT INTO snz_orders(object_id,work_date,shift,crew_id,source_revision,snapshot_json,created_by,request_id) VALUES (?,'2026-11-10','day','install1',7,'{}','Тест','existing-order')", (self.ids[1],))
        orders = [tuple(r) for r in self.c.execute('SELECT * FROM snz_orders')]
        note = task['run'](self.c); self.c.commit()
        self.assertIn('создано состояний 1, дополнено 1', note)
        self.assertEqual(len(self.snapshot()), 2)  # MFR excluded.
        row = self.c.execute('SELECT revision,data_json FROM snz_state WHERE object_id=?', (self.ids[1],)).fetchone()
        self.assertEqual(row[0], 8)
        self.assertEqual(json.loads(row[1])['cards'][0], s['cards'][0])
        before = self.snapshot()
        for _ in range(3):
            task['run'](self.c); self.c.commit()
            self.assertEqual(self.snapshot(), before)
        self.assertEqual([tuple(r) for r in self.c.execute('SELECT * FROM snz_orders')], orders)

    def test_rollback_is_transactional(self):
        before = self.snapshot()
        self.c.execute('BEGIN IMMEDIATE')
        fill_initial_catalogs(self.c)
        self.c.rollback()
        self.assertEqual(self.snapshot(), before)

    def test_manual_edits_after_upgrade_survive_actual_reopen(self):
        fill_initial_catalogs(self.c); self.c.commit()
        row = self.c.execute('SELECT data_json FROM snz_state WHERE object_id=?', (self.ids[0],)).fetchone()
        s = json.loads(row[0]); s['cards'].pop(); s['cards'][4]['steps'][2]['minutes'] = 63
        self.c.execute('UPDATE snz_state SET revision=revision+1,data_json=? WHERE object_id=?', (json.dumps(s, ensure_ascii=False), self.ids[0])); self.c.commit()
        before = self.snapshot()
        self.c.close(); self.c = db.get_connection()
        fill_initial_catalogs(self.c); self.c.commit()
        self.assertEqual(before, self.snapshot())


if __name__ == '__main__':
    unittest.main(verbosity=2)
