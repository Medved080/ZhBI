"""Disposable, synthetic installation-history cases for filter/report parity."""
from test_snz import IntegrationTests, element


def setup():
    IntegrationTests.setUpClass()
    cls = IntegrationTests
    c = cls.db.get_connection()
    pid = c.execute("INSERT INTO projects(name) VALUES ('Учебный проект')").lastrowid
    c.execute("UPDATE objects SET project_id=? WHERE id=?", (pid, cls.object_id))
    c.execute("INSERT INTO object_drawings(object_id,source_file,is_current) VALUES (?,'СНЗ-проверка.dxf',1)", (cls.object_id,))
    for n in range(5, 9):
        e = element(n)
        eid = c.execute("INSERT INTO elements(source_file,dxf_handle,layer,element_type,mark,mark_source,x,y,axis_status,object_id,floor,outline_json,current_status) VALUES (?,?,?,?,?,'manual',?,?,'matched',?,?,?,'ready_for_installation')", (e['source_file'], str(n), 'snz', e['element_type'], e['mark'], e['x'], e['y'], cls.object_id, 2, e['outline_json'])).lastrowid
        cls.ids.append(eid)
    for n in range(5):
        c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','numeric',?,?)", (str(n), n*6000))
    for n in range(4):
        c.execute("INSERT INTO axis_lines(source_file,kind,label,coord) VALUES ('СНЗ-проверка.dxf','letter',?,?)", ('АБВГ'[n], n*6000))
    from app.contracts import apply_status_change
    cases = [
        [('installed', '2026-11-08 09:00:00')],
        [('installed', '2026-11-08 10:00:00'), ('accepted', '2026-11-09 15:00:00')],
        [('installed', '2026-11-07 08:00:00'), ('delivered', '2026-11-07 09:00:00'), ('installed', '2026-11-08 11:00:00')],
        [('installed', '2026-11-08 12:00:00'), ('delivered', '2026-11-08 13:00:00')],
        [('installed', '2026-11-09 00:30:00')],
        [('delivered', '2026-11-08 14:00:00')],
        [('installed', '2026-11-07 14:00:00')],
        [],
    ]
    for eid, history in zip(cls.ids, cases):
        for status, at in history:
            apply_status_change(c, eid, status, False, None, at, 'Учебная отметка', 'Тест', cls.admin['id'])
    c.commit()
    c.close()
    return cls


if __name__ == '__main__':
    import sys
    cls = setup()
    from app import auth, main, activity
    main.app.dependency_overrides[auth.get_current_user] = lambda: cls.admin
    activity.start_worker()
    print('Synthetic montage filter fixture ready', flush=True)
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning', lifespan='off')
