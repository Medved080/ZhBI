"""Copy to app/shaft_panels_host.py AFTER copying the package to app/shaft_panels.

Source bindings verified against this checkout on 2026-09-08.
The main.py glue is in CLAUDE_CODE.md. This file is not loaded by the kit.
"""
import json
from app import activity
from app.auth import audit_display_name, get_current_user
from app.access import assert_object_feature
from app.backups import backup_before_import
from app.db import get_connection, touch_elements
from app import zone_recalc
from app.shaft_panels import DrawingError, TYPE
from app.shaft_panels.api import build_router


def assert_access(conn,user,object_id):
    assert_object_feature(conn,user,object_id,'drawings','write')


def backup(user,object_id):
    backup_before_import(f'Панели облицовки шахт → объект #{object_id}',audit_display_name(user),user['id'])


def before_commit(conn,user,object_id,changed_ids,summary):
    conn.execute('INSERT OR IGNORE INTO label_visibility (object_id,element_type,visible) VALUES (?,?,0)',(object_id,TYPE))
    # Reuse the existing zone algorithm, touching ONLY newly imported/changed
    # shaft elements. zone_recalc.recalculate() commits and updates the whole
    # building, so it cannot be called from this transaction.
    zones=zone_recalc._zone_records(conn,object_id)
    if zones:
        if any(z.category=='Стоянка' for z in zones):
            reason=zone_recalc.can_recalculate(conn,object_id)
            if reason:
                raise DrawingError('Привязка панелей к зонам требует поддержки схемы «лесенкой»: '+reason)
        for element_id in changed_ids:
            row=conn.execute('''SELECT e.* FROM elements e JOIN shaft_panel_geometry g ON g.element_id=e.id
                WHERE e.id=? AND e.object_id=? AND e.is_current=1''',(element_id,object_id)).fetchone()
            if row is None:continue
            bindings=zone_recalc.bind_element_to_zones(row['element_type'],row['x'],row['y'],
                json.loads(row['outline_json']),row['elevation_mm'],zones)
            updates={}
            for category,result in bindings.items():
                id_col,status_col=zone_recalc._CATEGORY_COLUMNS[category]
                zone_id,level_id=zone_recalc._parse_handle(result.zone_handle)
                updates[id_col]=zone_id;updates[status_col]=result.status
                if category=='Стоянка':updates['zone_stance_level_id']=level_id
            if updates:
                conn.execute('UPDATE elements SET '+','.join(f'{k}=?' for k in updates)+' WHERE id=?',(*updates.values(),element_id))
    touch_elements(conn,changed_ids)


def after_apply(user,object_id,summary):
    # ПОСЛЕ commit (storage.apply уже вернул результат) — событие успеха не
    # пишется раньше фиксации. shaft_panel_imports уже атомарно записан
    # внутри транзакции и остаётся первичным доказательством применения;
    # это — только отображение в общем журнале действий.
    activity.log('import_dxf',user=user,entity_type='object',entity_id=object_id,
                details={'kind':'shaft_panels','object_id':object_id,'summary':summary})


router=build_router(connection_factory=get_connection,get_user=get_current_user,
                    assert_access=assert_access,backup=backup,before_commit=before_commit,
                    after_apply=after_apply)
