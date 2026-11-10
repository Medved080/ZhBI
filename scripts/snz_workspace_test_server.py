"""Disposable synthetic fixture for inline model planning; loopback only."""
import sys
from test_snz import IntegrationTests, fixture, element
IntegrationTests.setUpClass()
cls=IntegrationTests
c=cls.db.get_connection()
pid=c.execute("INSERT INTO projects(name) VALUES ('Учебный проект СНЗ')").lastrowid
c.execute("UPDATE objects SET project_id=? WHERE id IN (?,?)",(pid,cls.object_id,cls.other_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(cls.object_id,))
for n in range(5,9):
    e=element(n)
    eid=c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,?)",(e['source_file'],str(n),'snz',e['element_type'],e['mark'],e['x'],e['y'],cls.object_id,2,e['outline_json'],'ready_for_installation' if n<7 else 'delivered')).lastrowid
    cls.ids.append(eid)
for n in range(5):c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','numeric',?,?)",(str(n),n*6000))
for n in range(4):c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','letter',?,?)",('АБВГ'[n],n*6000))
c.commit();c.close()
state,_=fixture(tuple(cls.ids[:4]),(("prepare",20,0),("scaffold",10,0),("install",40,0),("rebar1",40,0),("concrete1",20,120),("rebar2",40,0),("concrete2",20,0)))
state['assignments'][1].update(shift='night')
state['assignments'][2].update(date='2026-11-11')
state['assignments'][3].update(crew_id='install2')
cls.snz.save_state(cls.object_id,cls.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),cls.admin)
from app import auth,main,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:cls.admin
activity.start_worker()
print('SNZ inline fixture ready',flush=True)
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]) if len(sys.argv)>1 else 8053,log_level='warning',lifespan='off')
