"""Привязка ввода к работам подрядчика, примечания и полный ряд диаграммы. Только копия обезличенной БД."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if not os.environ.get("ZHBI_DB_PATH") or Path(os.environ["ZHBI_DB_PATH"]).name == "zhbi.db":
    sys.exit("Укажите ZHBI_DB_PATH на тестовую копию базы")
from fastapi import HTTPException
from app import db, headcount as hc

db.init_db()
c = db.get_connection()
admin = c.execute("SELECT * FROM users WHERE role='admin' LIMIT 1").fetchone()
obj = c.execute("SELECT id FROM objects ORDER BY id LIMIT 1").fetchone()[0]
ctr = c.execute("INSERT INTO headcount_contractors (object_id,name_raw,inn_raw) VALUES (?,'Проверка назначений','9999999998')", (obj,)).lastrowid
w = c.execute("INSERT INTO work_codifier (code,name) VALUES ('ASSIGN-1','880001. Каркас')").lastrowid
other = c.execute("INSERT INTO work_codifier (code,name) VALUES ('ASSIGN-2','880002. Прочее')").lastrowid
c.execute("INSERT INTO headcount_contractor_works (contractor_id,codifier_id,note) VALUES (?,?,'Каркас')", (ctr,w))
c.commit(); c.close()

def save(day, work, count):
    return hc.save_records(obj, hc.SaveIn(date=day, rows=[hc.RowIn(contractor_id=ctr,codifier_id=work,workers=count)]), user=admin)

save('2026-10-01',w,7)
save('2026-10-03',w,11)
try:
    save('2026-10-02',other,50)
    raise AssertionError('Принят неназначенный вид работ')
except HTTPException as e:
    assert e.status_code == 400 and 'назначенный' in e.detail
day = hc.get_day(obj, '2026-10-01', user=admin)
assert next(r for r in day['rows'] if r['contractor_id']==ctr)['note']=='Каркас'
args = dict(as_of='2026-10-03',date_from='2026-10-01',date_to='2026-10-03',object_ids=str(obj),
            smu_id=None,section=None,work_code=None,contractor_inn='9999999998',staff='total',user=admin)
report = hc.report(levels='contractor,section,note',**args)
assert report['rows'][0]['note']['label']=='Каркас'
assert report['series']==[{'date':'2026-10-01','total':7},{'date':'2026-10-02','total':0},{'date':'2026-10-03','total':11}]
assert hc.report(levels='note,contractor',**args)['levels']==['note','contractor']
c=db.get_connection();c.execute('DELETE FROM headcount_contractor_works WHERE contractor_id=?',(ctr,));c.commit();c.close()
save('2026-10-01',w,9)
print('OK: неназначенный вид отклонён; примечание из подрядчиков; обе группировки; все дни диаграммы; прежние записи доступны для исправления')
