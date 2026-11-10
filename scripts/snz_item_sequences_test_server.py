"""Synthetic model: unfinished preparation, per-item work and mounting overload."""
import sys
from test_snz import IntegrationTests,fixture
IntegrationTests.setUpClass();cls=IntegrationTests
c=cls.db.get_connection();pid=c.execute("INSERT INTO projects(name) VALUES ('СНЗ — последовательность изделий')").lastrowid
c.execute('UPDATE objects SET project_id=? WHERE id=?',(pid,cls.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(cls.object_id,))
c.commit();c.close()
state,_=fixture(tuple(cls.ids),(("prepare",900,0),("install",400,0),("rebar1",30,0),("concrete1",20,0),("rebar2",30,0),("concrete2",20,0)))
state['crews'][1]['foreman']='Учебный прораб'
cls.snz.save_state(cls.object_id,cls.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),cls.admin)
from app import main,auth,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:cls.admin
activity.start_worker()
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]) if len(sys.argv)>1 else 8062,log_level='warning',lifespan='off')
