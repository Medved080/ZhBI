"""Disposable synthetic UI fixture, never the application database."""
import sys
from test_snz_preparation_fact import PreparationFactTests
PreparationFactTests.setUpClass();test=PreparationFactTests();test.setUp()
c=test.db.get_connection();pid=c.execute("INSERT INTO projects(name) VALUES ('Учебный проект подготовки')").lastrowid
c.execute('UPDATE objects SET project_id=? WHERE id=?',(pid,test.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(test.object_id,));c.commit();c.close()
from app import main,auth
main.app.dependency_overrides[auth.get_current_user]=lambda:test.admin
import uvicorn
print('Synthetic preparation fixture ready',flush=True)
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]),log_level='warning',lifespan='off')
