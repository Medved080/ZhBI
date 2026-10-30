"""Сквозной синтетический PDF: контуры разбираются, помещения не импортируются."""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import pdf_import
from scripts.gen_synthetic_pdf_set import build


def check(value, message):
    assert value, message
    print('OK ' + message)


conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
conn.executescript((Path(__file__).resolve().parents[1] / 'app/schema.sql').read_text())
conn.execute('PRAGMA foreign_keys=ON')
obj = conn.execute("INSERT INTO objects(name) VALUES ('Синтетический PDF')").lastrowid
other = conn.execute("INSERT INTO objects(name) VALUES ('Другой объект')").lastrowid
for oid, section, uid in [(obj, 'PDF', 'pdf:1:0'), (obj, 'АР', 'revit-room'),
                          (other, 'PDF', 'pdf:1:0')]:
    conn.execute('INSERT INTO revit_elements(object_id,section_code,uid,category) VALUES (?,?,?,?)',
                 (oid, section, uid, 'Помещение'))
conn.commit()
doc = build('small')
data = doc.tobytes()
doc.close()
before = conn.total_changes
analysis = pdf_import.analyze(conn, obj, data, 'synthetic.pdf')
check(conn.total_changes == before, 'предпросмотр не пишет в БД')
check(analysis['total_rooms'] > 0, 'внутренние контуры помещений сохраняются')
check(analysis['new'] == len(analysis['_walls']) + len(analysis['_slabs']),
      'новые элементы считаются без помещений')
check(analysis['_retired_uids'] == ['pdf:1:0'], 'старое помещение PDF попадает в списание')
result = pdf_import.apply(conn, obj, analysis)
check(result['rooms_written'] == 0 and result['elements_written'] == analysis['new'],
      'записаны только элементы конструкций')
check(conn.execute("SELECT count(*) FROM revit_elements WHERE object_id=? AND section_code='PDF' "
                   "AND category='Помещение' AND is_current=1", (obj,)).fetchone()[0] == 0,
      'актуальных помещений PDF нет')
check(conn.execute("SELECT is_current FROM revit_elements WHERE object_id=? AND uid='pdf:1:0'",
                   (obj,)).fetchone()[0] == 0, 'прежняя строка сохранена без физического удаления')
check(conn.execute("SELECT count(*) FROM revit_elements WHERE category='Помещение' AND is_current=1").fetchone()[0] == 2,
      'Revit и другой объект сохранены')
check(result['walls_written'] > 0 and result['slabs_written'] > 0,
      'стены и перекрытия загружены')
check(result['section_unknown'] == 0 and result['sections_with_axes'] == 2,
      'определение секций по контурам и привязка осей работают')
check(conn.execute('SELECT count(*) FROM level_plan_images WHERE object_id=?', (obj,)).fetchone()[0] > 0,
      'изображения планов сохранены')
counts = [conn.execute('SELECT count(*) FROM ' + table).fetchone()[0]
          for table in ('revit_elements', 'object_levels', 'object_sections', 'blocks', 'object_grids')]
again = pdf_import.analyze(conn, obj, data, 'synthetic.pdf')
check(again['new'] == again['retiring'] == 0 and again['unchanged'] == result['elements_written'],
      'повторная сверка не предлагает помещения и лишнее списание')
pdf_import.apply(conn, obj, again)
check(counts == [conn.execute('SELECT count(*) FROM ' + table).fetchone()[0]
                 for table in ('revit_elements', 'object_levels', 'object_sections', 'blocks', 'object_grids')],
      'повторное применение не создаёт дублей элементов и справочников')
print('Все проверки пройдены')
