"""Disposable UI fixture for facts, supplementary montage, floor catalog and closure."""
import sys
from test_snz_fact_reporting import ReportingTests
ReportingTests.setUpClass();test=ReportingTests();test.setUp()
c=test.db.get_connection()
pid=c.execute("INSERT INTO projects(name) VALUES ('Учебный проект')").lastrowid
c.execute('UPDATE objects SET project_id=? WHERE id=?',(pid,test.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(test.object_id,))
for n in range(5):c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','numeric',?,?)",(str(n),n*6000))
for n in range(4):c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','letter',?,?)",('АБВГ'[n],n*6000))
if '--existing' in sys.argv:
 from app.contracts import apply_status_change
 apply_status_change(c,test.extra,'installed',False,None,'2026-11-10 11:15:00','','Учебный монтаж',test.admin['id'])
 apply_status_change(c,test.base.ids[0],'installed',False,None,'2026-11-10 10:00:00','','Учебный монтаж',test.admin['id'])
if '--tiny-label' in sys.argv:
 c.execute("UPDATE elements SET mark='ID 44560',element_type='Другое',outline_json='[[6000,6000],[6020,6000],[6020,6020],[6000,6020]]' WHERE id=?",(test.extra,))
c.commit();c.close()
from app import main,auth,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:test.admin
activity.start_worker()
print('Synthetic SNZ daily facts fixture ready',flush=True)
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]),log_level='warning',lifespan='off')
