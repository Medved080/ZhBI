"""Связь элемента: категория × свой блок; независимость от соседей и чужих объектов."""
import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.work_classifier import element_works
class ElementWorksTest(unittest.TestCase):
 def setUp(self):
  self.c=sqlite3.connect(':memory:');self.c.row_factory=sqlite3.Row
  self.c.executescript('''
  CREATE TABLE revit_elements(id,object_id,category,section_id,level_id);
  CREATE TABLE object_sections(id,code); CREATE TABLE object_levels(id,name);
  CREATE TABLE blocks(id,object_id,section_id,level_id);
  CREATE TABLE work_types(id,object_id,classifier_id,code,name,path,sort_order,retired_at);
  CREATE TABLE block_works(id,object_id,block_id,work_type_id,retired_at,plan_start,plan_end);
  CREATE TABLE work_classifier_categories(classifier_id,category_id);
  CREATE TABLE object_category_map(object_id,category_id,model_category);
  CREATE TABLE work_fact_reports(id,block_id,report_date);CREATE TABLE work_fact_items(report_id,work_type_id,percent);
  INSERT INTO revit_elements VALUES(1,1,'Стена',10,20),(2,1,'Окно',10,20),(3,1,'Стена',NULL,20),(4,2,'Стена',10,20);
  INSERT INTO object_sections VALUES(10,'С01');INSERT INTO object_levels VALUES(20,'Этаж 3'),(21,'Этаж 4');
  INSERT INTO blocks VALUES(100,1,10,20),(101,1,10,21),(200,2,10,20);
  INSERT INTO work_types VALUES(1,1,1001,'W1','Монолит','1.1',1,NULL),(2,1,1002,'W2','Окна','1.2',2,NULL),
  (3,1,1001,'W3','Снятая работа','1.3',3,NULL),(4,1,1001,'W4','Архивная WBS','1.4',4,'2026-01-01'),(5,2,1001,'W5','Чужой объект','2.1',5,NULL);
  INSERT INTO block_works VALUES(1,1,100,1,NULL,'2026-10-01','2026-11-10'),(2,1,100,2,NULL,NULL,NULL),
  (3,1,101,1,NULL,NULL,NULL),(4,1,100,3,'2026-01-01',NULL,NULL),(5,1,100,4,NULL,NULL,NULL),(6,2,200,5,NULL,NULL,NULL);
  INSERT INTO work_classifier_categories VALUES(1001,1),(1001,3),(1002,2);
  INSERT INTO object_category_map VALUES(1,1,'Стена'),(1,3,'Стена'),(1,2,'Окно'),(2,1,'Стена');
  INSERT INTO work_fact_reports VALUES(1,100,'2026-10-18'),(2,100,'2026-11-01'),(3,101,'2026-11-01'),(4,100,'2026-10-25');
  INSERT INTO work_fact_items VALUES(1,1,10),(2,1,57),(3,1,100),(4,1,30);
  ''')
 def tearDown(self):self.c.close()
 def test_only_own_category_block_current_fact_without_duplicates(self):
  d=element_works(self.c,1,1);self.assertEqual(d['block_id'],100)
  self.assertEqual([(x['id'],x['percent'],x['status']) for x in d['items']],[(1,57,'in_progress')])
  self.assertEqual(d['items'][0]['plan_end'],'2026-11-10')
 def test_unreported_operation_is_not_started(self):self.assertEqual(element_works(self.c,1,2)['items'][0]['percent'],0)
 def test_missing_section_is_not_guessed(self):
  d=element_works(self.c,1,3);self.assertEqual(d['items'],[]);self.assertIsNone(d['block_id'])
 def test_element_from_other_object_is_not_visible(self):self.assertEqual(element_works(self.c,1,4)['items'],[])
 def test_card_hides_work_details_without_work_permission(self):
  from app.revit_plan import card
  from unittest.mock import patch
  columns=['uid','family','type_name','mark','section_code','section_source','level_name','elevation_mm','height_mm','volume','area','workset','outline_approx','params_json']
  for column in columns:self.c.execute('alter table revit_elements add column '+column)
  with patch('app.revit_plan.revit_sections.section_shares',return_value=[]), patch('app.revit_plan.work_classifier.element_works') as query:
   d=card(self.c,1,1,include_works=False)
   self.assertEqual(d['связанные_работы']['items'],[])
   self.assertIn('Нет доступа',d['связанные_работы']['reason']);query.assert_not_called()
 def test_missing_mapping_and_block_are_explicit(self):
  self.c.execute('delete from object_category_map where object_id=1');self.assertTrue(element_works(self.c,1,1)['reason'])
  self.c.execute('delete from blocks where id=100');self.assertIn('не создан блок',element_works(self.c,1,1)['reason'])
if __name__=='__main__':unittest.main()
