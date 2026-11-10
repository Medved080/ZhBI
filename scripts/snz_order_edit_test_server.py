"""Issued day/night documents on disposable synthetic data only."""
import sys
from test_snz import IntegrationTests, fixture
IntegrationTests.setUpClass()
cls=IntegrationTests
c=cls.db.get_connection()
pid=c.execute("INSERT INTO projects(name) VALUES ('СНЗ — учебный проект')").lastrowid
c.execute("UPDATE objects SET project_id=? WHERE id=?",(pid,cls.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(cls.object_id,))
c.commit();c.close()
state,_=fixture(tuple(cls.ids[:3]),(("install",60,0),))
state['crews'][1]['foreman']='Учебный прораб'
for a in state['assignments'][1:]:a['shift']='night'
cls.snz.save_state(cls.object_id,cls.snz.StateIn(revision=0,**{k:v for k,v in state.items() if k!='facts'}),cls.admin)
def issue(shift,request):
    d=cls.snz.get_state(cls.object_id,cls.admin)
    p=cls.snz.preview(cls.object_id,cls.snz.PlanIn(revision=d['revision'],date='2026-11-10',shift=shift,crew_id='install1'),cls.admin)
    return cls.snz.issue(cls.object_id,cls.snz.IssueIn(revision=d['revision'],date='2026-11-10',shift=shift,crew_id='install1',request_id=request,expected_hash=p['fingerprint']),cls.admin)['id']
issue('day','day-fixture')
d=cls.snz.get_state(cls.object_id,cls.admin)
d['state']['assignments'].append(dict(d['state']['assignments'][0],element_id=cls.ids[3],priority=4,prep_priority=4))
cls.snz.save_state(cls.object_id,cls.snz.StateIn(revision=d['revision'],**{k:v for k,v in d['state'].items() if k!='facts'}),cls.admin)
night=issue('night','night-fixture')
from datetime import datetime
class FixtureClock(datetime):
    @classmethod
    def now(cls,tz=None):return cls(2026,11,10,7,40,tzinfo=tz)
cls.snz.datetime=FixtureClock
d=cls.snz.get_state(cls.object_id,cls.admin)
cls.snz.complete(cls.object_id,cls.snz.FactIn(revision=d['revision'],task_key=f'e:{cls.ids[2]}:install'),cls.admin)
from app import auth,main,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:cls.admin
activity.start_worker()
print(f'Synthetic SNZ fixture object={cls.object_id} night={night}',flush=True)
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]) if len(sys.argv)>1 else 8056,log_level='warning',lifespan='off')
