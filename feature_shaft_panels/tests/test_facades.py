"""FACADE_DWG_DIR points to the five original СМ1 elevations; no project DB is written."""
import os
from math import dist
from pathlib import Path
import unittest

from app.shaft_panels import DrawingError, facade, storage
from app.shaft_panels_scope import exclude_shaft_panels
from feature_shaft_panels.tests.test_feature import database


class FacadeChecks(unittest.TestCase):
    def test_unresolved_or_duplicate_marks_abort(self):
        label = {'text': 'Пс-2001', 'insert': [2, 3, 0], 'height': 2}
        wall = {'Part-1': (0, 0, 10, 10)}
        for labels, parts in [([label], {}), ([label, label], wall),
                              ([label], {**wall, 'Part-2': wall['Part-1']})]:
            with self.subTest(parts=parts), self.assertRaises(DrawingError):
                facade._match_marks(labels, parts)


@unittest.skipUnless(os.getenv('FACADE_DWG_DIR'), 'Set FACADE_DWG_DIR for the СМ1 DWG integration check')
class FacadeImport(unittest.TestCase):
    def test_five_sheets_on_one_object(self):
        axes = {'numeric': {'1': 0, '5': 18000, '7': 27000, '35': 183000,
                            '36': 192000, '37': 201000, '38': 210000, '39': 219000},
                'letter': {'А': 0, 'Г': 36000, 'Е': 60000, 'Ж': 72000, 'Р': 126000}}
        expected = {'facade-39':146, 'facade-r':285, 'facade-1':353, 'facade-a':565, 'facade-diagonal':108}
        conn = database()
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE allowed_subtypes(object_id,element_type,subtype, UNIQUE(object_id,element_type,subtype))')
        conn.executemany("INSERT INTO axis_lines VALUES('base.dxf',?,?,?)",
                         [(kind, k, v) for kind, values in axes.items() for k,v in values.items()])
        for i in range(3):
            conn.execute("""INSERT INTO elements(source_file,dxf_handle,object_id,element_type,x,y)
                VALUES('base.dxf',?,1,'Колонна',?,?)""", (f'COL{i}',192000+i*9000,8000+i*7460))
        conn.commit()
        count_before = conn.execute('SELECT count(*) FROM elements').fetchone()[0]
        seen = set()
        for path in sorted(Path(os.environ['FACADE_DWG_DIR']).glob('*.dwg')):
            drawing = facade.read_facade(path)
            scope = drawing['scope']
            with self.subTest(scope=scope):
                seen.add(scope)
                grid, source = storage.load_target_axes(conn, 1, facade=True)
                self.assertEqual(source, 'base.dxf')
                supports = facade.diagonal_supports(conn,1,grid) if scope == 'facade-diagonal' else []
                placed = facade.place_facade(drawing,grid,supports,None,0)
                placed['source_file'] = path.name
                for panel in placed['panels']:
                    self.assertEqual(panel['section_layers_mm'], [100, 150, 190])
                    self.assertAlmostEqual(dist(panel['outline'][0], panel['outline'][3]), 440, delta=.002)
                self.assertEqual(len(placed['panels']),expected[scope])
                self.assertEqual(min(p['z'] for p in placed['panels']),20)
                self.assertEqual(max(p['z']+p['height_mm'] for p in placed['panels']),
                                 36290 if supports else 40590)
                preview = storage.analyze(conn,1,placed)
                self.assertEqual(preview['counts']['new'],expected[scope])
                storage.apply(conn,preview,placed,user_id=1,acknowledged_warnings=['facade_placement'],
                              retire_missing=True)
                placed['source_file'] = 'renamed.dwg'
                self.assertEqual(storage.analyze(conn,1,placed)['counts'],
                                 dict(new=0,updated=0,unchanged=expected[scope],missing=0))
        self.assertEqual(seen,expected.keys())
        rows = conn.execute('SELECT * FROM elements WHERE is_current=1').fetchall()
        self.assertEqual(len(exclude_shaft_panels(conn,1,rows)),count_before)
        self.assertEqual(sum(e['element_type']=='Панель' and e['subtype']=='фасадная'
                             and e['mark_id'] is not None for e in rows),sum(expected.values()))
