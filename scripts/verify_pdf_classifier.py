"""Категории PDF, перенос накопленных данных и цвета. Только синтетика в памяти."""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import classifier_categories as cc, pdf_import, pdf_rooms, release_tasks, revit_colors
from app.object_geometry_features import get_wall_segments


def check(value, message):
    assert value, message
    print('OK ' + message)


conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
conn.executescript((Path(__file__).resolve().parents[1] / 'app/schema.sql').read_text())
conn.execute('PRAGMA foreign_keys=ON')
objects = [conn.execute('INSERT INTO objects (name) VALUES (?)', (name,)).lastrowid
           for name in ('PDF', 'Смешанный', 'Revit')]
cat = conn.execute("INSERT INTO work_element_categories (name) VALUES ('Тестовая категория')").lastrowid
polygon = [[0,0],[3000,0],[3000,200],[0,200],[0,0]]
materials = [('',cc.CLS_WALL_MONOLITH),('',cc.CLS_SLAB_MONOLITH),
             (pdf_rooms.EXTERIOR_MASONRY_MATERIAL,cc.CLS_MASONRY_OUTER),('Кирпич',cc.CLS_MASONRY_INNER)]
old_names = ['Стены монолит','Перекрытия','Стены блоки','Стены кирпич']
ids = []
for i, (old, (material, expected)) in enumerate(zip(old_names, materials)):
    ids.append(conn.execute('INSERT INTO revit_elements (object_id,section_code,uid,category,type_name,outline_json,elevation_mm,height_mm) VALUES (?,?,?,?,?,?,0,3000)',
                            (objects[0],'PDF',f'pdf:{i}',old,material,json.dumps(polygon))).lastrowid)
    conn.execute('INSERT INTO object_category_map VALUES (?,?,?)',(objects[0],cat,old))
for obj, section, uid in [(objects[1],'PDF','mixed-pdf'),(objects[1],'АР','mixed-revit'),(objects[2],'АР','revit')]:
    conn.execute('INSERT INTO revit_elements (object_id,section_code,uid,category,type_name) VALUES (?,?,?,?,?)',
                 (obj,section,uid,'Стены блоки','Блоки'))
for obj in objects[1:]:conn.execute('INSERT INTO object_category_map VALUES (?,?,?)',(obj,cat,'Стены блоки'))
conn.commit()
before = [tuple(r) for r in conn.execute('SELECT id,uid,outline_json,elevation_mm,height_mm FROM revit_elements ORDER BY id')]
release_tasks._rename_pdf_categories_to_classifier(conn)
check([conn.execute('SELECT category FROM revit_elements WHERE id=?',(i,)).fetchone()[0] for i in ids] == [x[1] for x in materials],
      'PDF: монолит, перекрытия, наружная и внутренняя кладка переименованы по материалу')
check(before == [tuple(r) for r in conn.execute('SELECT id,uid,outline_json,elevation_mm,height_mm FROM revit_elements ORDER BY id')],
      'id, UID, контуры и высотные отметки сохранены')
check({r[0] for r in conn.execute("SELECT category FROM revit_elements WHERE section_code='АР'")} == {'Стены блоки'},
      'Revit-выгрузки не переименованы')
check({r[0] for r in conn.execute('SELECT model_category FROM object_category_map WHERE object_id=?',(objects[0],))} == set(cc.PDF_CLASSIFIER_NAMES),
      'ручные соответствия PDF перенесены')
check(all(conn.execute('SELECT 1 FROM object_category_map WHERE object_id=? AND model_category=?',(o,'Стены блоки')).fetchone() for o in objects[1:]),
      'соответствия Revit и смешанного объекта сохранены')
def snapshot():
    return [tuple(r) for r in conn.execute('SELECT * FROM revit_elements ORDER BY id')], [tuple(r) for r in conn.execute('SELECT * FROM object_category_map ORDER BY 1,2,3')]
first = snapshot(); release_tasks._rename_pdf_categories_to_classifier(conn)
check(first == snapshot(), 'повтор обработки идемпотентен')
check(not conn.execute('PRAGMA foreign_key_check').fetchall(), 'внешние ключи целы')
walls = [pdf_rooms.WallSegment(floor='1',index=i,category=old,material=mat,polygon_mm=polygon,thickness_mm=200)
         for i,(old,mat) in enumerate([('Стены монолит','Бетон'),('Стены блоки',pdf_rooms.EXTERIOR_MASONRY_MATERIAL),('Стены кирпич','Кирпич'),('Окна','Окно')])]
built = pdf_import.build_wall_rows(walls, {'1':(None,[])}, {})
check([r['category'] for r in built] == [cc.CLS_WALL_MONOLITH,cc.CLS_MASONRY_OUTER,cc.CLS_MASONRY_INNER,'Окна'],
      'новый импорт пишет категории классификатора, окна сохранены')
check([r['uid'] for r in built[:3]] == [f'pdf:стена:1:{i}' for i in range(3)], 'переименование не меняет ключи повторного импорта')
check(pdf_import.build_slab_rows([pdf_rooms.Slab(floor='1',polygon_mm=polygon)],{'1':(None,[])})[0]['category'] == cc.CLS_SLAB_MONOLITH,
      'новые плиты получают категорию классификатора')
conn.execute('INSERT INTO app_settings (key,object_id,value) VALUES (?,?,?)', (revit_colors.SETTING_KEY,objects[0],json.dumps({'preset':'custom','colors':{'Стены монолит':'#112233','Стены блоки':'#223344','Стены кирпич':'#334455','Перекрытия':'#445566'},'opacity':{'Стены монолит':12},'glow':{'Стены монолит':7}})))
scheme = revit_colors.scheme(conn,objects[0])
check([scheme['colors'][x] for x in cc.PDF_CLASSIFIER_NAMES] == ['#112233','#445566','#223344','#334455'] and scheme['opacity'][cc.CLS_WALL_MONOLITH] == 12 and scheme['glow'][cc.CLS_WALL_MONOLITH] == 7,
      'новые категории наследуют пользовательские цвет, прозрачность и свечение')
conn.execute('UPDATE app_settings SET value=? WHERE key=? AND object_id=?', (json.dumps({'preset':'custom','colors':{'Стены блоки':'#556677'},'opacity':{'Стены блоки':15}}),revit_colors.SETTING_KEY,objects[0]))
scheme = revit_colors.scheme(conn,objects[0])
check(scheme['colors'][cc.CLS_MASONRY_INNER]=='#556677' and scheme['opacity'][cc.CLS_MASONRY_INNER]==15,
      'внутренняя кладка наследует блоки, если цвет кирпича ранее не задавался')
check(get_wall_segments(conn,objects[0])['segment_count_total'] > 0,'переименованные стены участвуют в геометрической привязке')
print('Все проверки пройдены')
