"""Synthetic delivery dates, later installation/acceptance and full rollback."""
from montage_filter_fixture import setup as montage_setup


def setup():
    cls = montage_setup()
    c = cls.db.get_connection()
    from app.contracts import recompute_status_and_actual_date
    # Add delivery before installation; existing montage cases remain unchanged.
    for index, at in [(0, '2026-11-08 08:00:00'), (1, '2026-11-08 09:00:00'),
                      (4, '2026-11-09 00:00:00'), (6, '2026-11-07 13:00:00')]:
        c.execute("INSERT INTO status_history(element_id,status,changed_at) VALUES (?,'delivered',?)", (cls.ids[index], at))
        recompute_status_and_actual_date(c, cls.ids[index])
    # A delivery followed by a full rollback must not retain a factual date.
    eid = cls.ids[7]
    c.execute("INSERT INTO status_history(element_id,status,changed_at) VALUES (?,'delivered','2026-11-08 23:59:59')", (eid,))
    c.execute("INSERT INTO status_history(element_id,status,changed_at) VALUES (?,'planned','2026-11-09 00:00:00')", (eid,))
    recompute_status_and_actual_date(c, eid)
    c.commit()
    c.close()
    return cls


if __name__ == '__main__':
    import sys
    cls = setup()
    from app import auth, main, activity
    main.app.dependency_overrides[auth.get_current_user] = lambda: cls.admin
    activity.start_worker()
    print('Synthetic delivery filter fixture ready', flush=True)
    import uvicorn
    uvicorn.run(main.app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning', lifespan='off')
