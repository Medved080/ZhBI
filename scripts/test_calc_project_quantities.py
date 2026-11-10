"""Project-wide quantities: synthetic databases only, no user-data writes."""
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.calc.project_quantities import project_quantities
from app.calc.database import PROJECT_ID
from app.calc.export_reference import export_references, title_marks


class ProjectQuantitiesTests(unittest.TestCase):
    def setUp(self):
        self.calc = sqlite3.connect(':memory:'); self.calc.row_factory = sqlite3.Row
        self.zhbi = sqlite3.connect(':memory:'); self.zhbi.row_factory = sqlite3.Row
        self.calc.executescript('CREATE TABLE products(id TEXT,name TEXT,document_model_id TEXT); CREATE TABLE projects(id TEXT,zhbi_project_id INTEGER);')
        self.calc.execute('INSERT INTO projects VALUES(?,1)', (PROJECT_ID,))
        self.calc.executemany('INSERT INTO products VALUES(?,?,?)', [('c','Колонна 1КС1','c'), ('r','Ригель 1КС1','r'), ('point','Колонна 1КС1.1','point'), ('eleven','Колонна 1КС11','eleven'), ('absent','Колонна 9КС1','absent')])
        self.zhbi.executescript('CREATE TABLE projects(id INTEGER,name TEXT); CREATE TABLE objects(id INTEGER,project_id INTEGER); CREATE TABLE elements(object_id INTEGER,element_type TEXT,mark TEXT,is_current INTEGER); INSERT INTO projects VALUES(1,"Проект"),(2,"Другой"); INSERT INTO objects VALUES(1,1),(2,1),(3,2);')
        self.zhbi.executemany('INSERT INTO elements VALUES(?,?,?,?)', [(1,'Колонна','1КС1',1)]*2+[(2,'Колонна','1KC1',1)]*3+[(3,'Колонна','1КС1',1)]*7+[(1,'Колонна','1КС1',0)]*11+[(2,'Ригель','1КС1',1)]*4+[(1,'Колонна','1КС1.1',1),(1,'Колонна','1КС11',1)])
        self.catalog = patch('app.calc.marks.catalog', return_value={}); self.catalog.start()

    def tearDown(self):
        self.catalog.stop(); self.calc.close(); self.zhbi.close()

    def test_sums_every_object_and_excludes_other_projects_and_old_elements(self):
        result=project_quantities(self.calc,self.zhbi)
        self.assertEqual(result['project'],{'id':1,'name':'Проект'})
        self.assertEqual(result['products']['c']['quantity'],5)
        self.assertEqual(result['products']['r']['quantity'],4)
        self.assertEqual(result['products']['point']['quantity'],1)
        self.assertEqual(result['products']['eleven']['quantity'],1)
        self.assertEqual(result['products']['absent'],{'quantity':0,'status':'not-found'})

    def test_alias_and_ambiguous_products(self):
        self.calc.execute('UPDATE products SET name="Колонна Полная-марка" WHERE id="c"')
        with patch('app.calc.marks.catalog',return_value={'c':{'alias':'1КС1'}}):
            self.assertEqual(project_quantities(self.calc,self.zhbi)['products']['c']['quantity'],5)
            self.calc.execute('INSERT INTO products VALUES("duplicate","Колонна 1КС1",NULL)')
            result=project_quantities(self.calc,self.zhbi)
            self.assertEqual(result['products']['c'],{'quantity':None,'status':'ambiguous'})
            self.assertEqual(result['products']['duplicate'],{'quantity':None,'status':'ambiguous'})

    def test_missing_project_is_unknown_not_zero(self):
        self.calc.execute('UPDATE projects SET zhbi_project_id=NULL')
        result=project_quantities(self.calc,self.zhbi)
        self.assertIsNone(result['project'])
        self.assertTrue(all(v=={'quantity':None,'status':'unlinked'} for v in result['products'].values()))

    def test_reference_names_and_ambiguous_source_rows(self):
        cells=[{'value':None,'numberFormat':'General','formula':None} for _ in range(16)]
        cells[14]={'value':12345.67,'numberFormat':'#,##0.00','formula':'=N8*K8'}
        rows=[{'row':8,'proposedName':'Колонна железобетонная','ttnName':'Колонна 1КС1 согласно проекту','sourceQuantity':5,'modelIds':['c'],'sourceCells':cells}]
        with patch('app.calc.export_reference.source_rows',return_value=rows), patch('app.calc.export_reference.catalog',return_value={}):
            result=export_references(self.calc)
            self.assertEqual(result['c']['proposedName'],'Колонна железобетонная')
            self.assertEqual(result['c']['sourceQuantity'],5)
            self.assertEqual(result['c']['sourceCells'],cells)
            self.assertEqual(result['r']['referenceStatus'],'not-found')
            rows.append({**rows[0],'row':9,'proposedName':'Другое описание'})
            self.assertEqual(export_references(self.calc)['c']['referenceStatus'],'ambiguous')

    def test_grouped_reference_does_not_assign_combined_quantity_to_each_product(self):
        rows=[{'row':8,'proposedName':'Группа','ttnName':'Несколько изделий','sourceQuantity':9,'modelIds':['c','r']}]
        with patch('app.calc.export_reference.source_rows',return_value=rows), patch('app.calc.export_reference.catalog',return_value={}):
            result=export_references(self.calc)
            self.assertIsNone(result['c']['sourceQuantity'])
            self.assertIsNone(result['r']['sourceQuantity'])
            self.assertEqual(result['c']['sourceCells'],[])

    def test_source_mark_parsing_keeps_separate_variants(self):
        self.assertEqual(title_marks('Колонна6кС1 согласно проекту'),[('Колонна','6кС1')])
        self.assertEqual(title_marks('Плита перекрытия 4ПИ-20 300мм согласно проекту + Плита перекрытия 4ПИ-21 согласно проекту'),[('Плита перекрытия','4ПИ-20'),('Плита перекрытия','4ПИ-21')])


if __name__=='__main__':
    unittest.main()
