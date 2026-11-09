"""Local browser fixture: fresh synthetic DB; no real data or authentication changes."""
import sys
from test_snz import IntegrationTests, fixture

IntegrationTests.setUpClass()
cls=IntegrationTests
c=cls.db.get_connection()
pid=c.execute("INSERT INTO projects(name) VALUES ('СНЗ — тестовый проект')").lastrowid
c.execute("UPDATE objects SET project_id=? WHERE id=?",(pid,cls.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(cls.object_id,))
for i in range(5):
    c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','numeric',?,?)",(str(i),i*6000))
for i in range(3):
    c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','letter',?,?)",("АБВ"[i],i*6000))
c.commit();c.close()
state,_=fixture(tuple(cls.ids),(("prepare",20,0),("scaffold",10,0),("install",40,0),("rebar1",40,0),("concrete1",20,120),("rebar2",40,0),("concrete2",20,0)))
state["crews"][1]["foreman"]="Тестовый прораб"
cls.snz.save_state(cls.object_id,cls.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!="facts"}),cls.admin)

from app import auth,main,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:cls.admin
activity.start_worker()
print(f"SNZ fixture object_id={cls.object_id}",flush=True)
import uvicorn
uvicorn.run(main.app,host="127.0.0.1",port=int(sys.argv[1]) if len(sys.argv)>1 else 8038,log_level="warning",lifespan="off")
