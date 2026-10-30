"""Фасад, основание и белые дубли ЖБ: синтетика, без проектных данных и рабочей БД."""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from app import pdf_rooms as p, pdf_import, release_tasks as tasks


def check(value, message):
    assert value, message
    print('OK '+message)


def candidate(shape):
    x0,y0,x1,y1=shape.bounds
    return {'poly':list(shape.exterior.coords),'w':x1-x0,'h':y1-y0}


solid=box(0,0,3000,200)
coat=box(0,-150,3000,0)
base=box(3000,0,5000,200)
parts=p._exterior_wall_parts([candidate(solid),candidate(coat),candidate(base)],[list(solid.exterior.coords)])
check(len(parts)==2,'белая подложка монолита не создаёт вторую стену')
check({r['category'] for r in parts}=={p.CAT_FACADE,p.CAT_WALL_BLOCKS},'фасад 150 мм и основание 200 мм разделены')
check(next(r for r in parts if r['category']==p.CAT_FACADE)['material']==p.FACADE_MATERIAL,'утепление не названо ячеистыми блоками')
remaining=p._exterior_wall_parts([candidate(box(2800,0,5000,200))],[list(solid.exterior.coords)])
check(unary_union([Polygon(r['polygon_mm']) for r in remaining]).equals(base),'частичное пересечение с ЖБ вырезано без потери настоящего основания')
outer=box(0,0,1000,1000);inner=box(200,200,800,800)
parts=p._exterior_wall_parts([candidate(outer)],[list(inner.exterior.coords)])
geometry=unary_union([Polygon(r['polygon_mm']) for r in parts])
check(geometry.symmetric_difference(outer.difference(inner)).area<.01,'отверстия не заливаются при разложении сложных фигур')
win=p.WallSegment(floor='1',index=2,category='Окна',material='Окно',polygon_mm=list(coat.exterior.coords),thickness_mm=150,z_offset_mm=750,z_height_mm=1750)
bands=p.window_infill(win,3000)
check(len(bands)==2 and all(b.category==p.CAT_WALL_BLOCKS and b.material==p.EXTERIOR_MASONRY_MATERIAL for b in bands),'под и над окнами создаётся подтверждённая кладка из блоков')
built=pdf_import.build_wall_rows(bands,{'1':(None,[])},{})
check(all(r['category']=='Кладка наружная' and r['uid'].startswith('pdf:стена:') for r in built),'кладка под/над окнами экспортируется с прежним пространством UID')

conn=sqlite3.connect(':memory:');conn.row_factory=sqlite3.Row
conn.executescript((Path(__file__).resolve().parents[1]/'app/schema.sql').read_text())
obj=conn.execute("INSERT INTO objects (name) VALUES ('Тест фасада')").lastrowid
def insert(uid,shape,material,category='Кладка наружная',z=0,level='этаж 1',section='PDF',object_id=obj):
    return conn.execute('INSERT INTO revit_elements (object_id,section_code,uid,category,type_name,outline_json,elevation_mm,height_mm,level_name,params_json) VALUES (?,?,?,?,?,?,?,3000,?,?)',
                        (object_id,section,uid,category,material,json.dumps(list(shape.exterior.coords)),z,level,json.dumps({'страница':6,'материал':material}))).lastrowid
mono=insert('pdf:стена:1:0',solid,p.MONOLITH_MATERIAL,p.CAT_WALL_MONOLITH)
duplicate=insert('pdf:стена:1:1',solid,p.EXTERIOR_MASONRY_MATERIAL)
duplicate_170=insert('pdf:стена:1:9',box(0,0,500,170),p.EXTERIOR_MASONRY_MATERIAL)
thin=insert('pdf:стена:1:2',coat,p.EXTERIOR_MASONRY_MATERIAL)
real=insert('pdf:стена:1:3',base,p.EXTERIOR_MASONRY_MATERIAL)
band=insert('pdf:стена:1:1000004',box(6000,0,7000,200),p.EXTERIOR_MASONRY_MATERIAL)
other_floor=insert('pdf:стена:3:1',solid,p.EXTERIOR_MASONRY_MATERIAL,z=6000,level='этаж 3')
revit=insert('pdf:external-revit',coat,p.EXTERIOR_MASONRY_MATERIAL,section='АР')
other_obj=conn.execute("INSERT INTO objects (name) VALUES ('Другой объект')").lastrowid
other_object=insert('pdf:стена:1:1',solid,p.EXTERIOR_MASONRY_MATERIAL,object_id=other_obj)
partial=insert('pdf:стена:1:8',box(2800,0,5000,200),p.EXTERIOR_MASONRY_MATERIAL)
before=[tuple(r) for r in conn.execute('SELECT id,uid,outline_json,elevation_mm,height_mm FROM revit_elements ORDER BY id')]
tasks._correct_pdf_facade_materials(conn)
check(all(conn.execute('SELECT category FROM revit_elements WHERE id=?',(i,)).fetchone()[0]==p.CAT_FACADE for i in (thin,)),'прежние фасадные полосы исправлены без перезагрузки PDF')
check(before==[tuple(r) for r in conn.execute('SELECT id,uid,outline_json,elevation_mm,height_mm FROM revit_elements ORDER BY id')],'исправление материала сохраняет id, UID, геометрию и отметки')
check(conn.execute('SELECT is_current FROM revit_elements WHERE id=?',(duplicate,)).fetchone()[0]==1,'автоматическая обработка не убирает строки')
conn.execute("UPDATE revit_elements SET category=?,type_name=? WHERE id=?", (p.CAT_FACADE,p.FACADE_MATERIAL,band))
tasks._correct_pdf_window_bands(conn)
check(conn.execute('SELECT category FROM revit_elements WHERE id=?',(band,)).fetchone()[0]=='Кладка наружная','ранее загруженные заполнения окон возвращены в наружную кладку')
check(before==[tuple(r) for r in conn.execute('SELECT id,uid,outline_json,elevation_mm,height_mm FROM revit_elements ORDER BY id')],'исправление заполнений окон сохраняет геометрию и идентификаторы')
tasks._retire_pdf_facade_duplicates(conn)
check(all(conn.execute('SELECT is_current FROM revit_elements WHERE id=?',(i,)).fetchone()[0]==0 for i in (duplicate,duplicate_170)),'отдельная уборка снимает доказанные дубли, включая уже переклассифицированный')
check(all(conn.execute('SELECT is_current FROM revit_elements WHERE id=?',(i,)).fetchone()[0]==1 for i in (mono,thin,real,band,other_floor,revit,other_object,partial)), 'настоящие материалы, частичные остатки, другой объект/этаж и Revit сохраняются')
check(conn.execute('SELECT category FROM revit_elements WHERE id=?',(revit,)).fetchone()[0]=='Кладка наружная','Revit не переклассифицирован')
first=[tuple(r) for r in conn.execute('SELECT * FROM revit_elements ORDER BY id')]
tasks._correct_pdf_facade_materials(conn);tasks._correct_pdf_window_bands(conn);tasks._retire_pdf_facade_duplicates(conn)
check(first==[tuple(r) for r in conn.execute('SELECT * FROM revit_elements ORDER BY id')],'обе обработки идемпотентны, строки не удаляются')
kind={r['name']:r['kind'] for r in tasks.RELEASE_TASKS}
check(kind['2026-10-30-pdf-facade-duplicates']==tasks.KIND_CLEANUP,'уборка дублей запускается только администратором')
print('Все проверки пройдены')
