"""User's empty edited SNZ reproduction; synthetic DB only."""
import sys
from test_snz import IntegrationTests
IntegrationTests.setUpClass()
cls=IntegrationTests;h=cls();h.setUp();h.save_fixture();oid=h.issue()['id']
d=cls.snz.get_state(cls.object_id,cls.admin)
body=cls.snz.EditPreviewIn(revision=d['revision'],order_revision=1,exclude_element_ids=cls.ids,reason='Ошибочный состав')
preview=cls.snz.preview_order_edit(cls.object_id,oid,body,cls.admin)
cls.snz.edit_order(cls.object_id,oid,cls.snz.EditOrderIn(**body.model_dump(),request_id='empty-fixture',expected_hash=preview['fingerprint']),cls.admin)
c=cls.db.get_connection();pid=c.execute("INSERT INTO projects(name) VALUES ('Удаление СНЗ — учебный проект')").lastrowid
c.execute('UPDATE objects SET project_id=? WHERE id=?',(pid,cls.object_id))
c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)",(cls.object_id,))
c.commit();c.close()
from app import main,auth,activity
main.app.dependency_overrides[auth.get_current_user]=lambda:cls.admin
activity.start_worker()
print(f'Synthetic empty SNZ {oid} ready',flush=True)
import uvicorn
uvicorn.run(main.app,host='127.0.0.1',port=int(sys.argv[1]) if len(sys.argv)>1 else 8060,log_level='warning',lifespan='off')
