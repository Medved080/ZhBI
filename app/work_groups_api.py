"""HTTP entry points for work groups and capture operations."""
from copy import deepcopy

from fastapi import APIRouter, Depends, HTTPException

from app import work_groups as wg
from app.access import assert_object_feature
from app.auth import get_current_user
from app.db import get_connection

router = APIRouter(prefix='/work-groups', tags=['work-groups'])


def admin_only(user):
    if user['role'] != 'admin':
        raise HTTPException(403, 'Изменение общего шаблона доступно администратору сервиса')


@router.get('/template')
def get_template(user=Depends(get_current_user)):
    admin_only(user)
    conn = get_connection()
    try:
        result = wg.template(conn); conn.commit()
        return result
    finally:
        conn.close()


@router.put('/template')
def save_template(body: dict, user=Depends(get_current_user)):
    admin_only(user)
    conn=get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        old=wg.template(conn)
        if body.get('revision')!=old['revision']:
            wg.fail('Шаблон изменился. Обновите страницу',409)
        items=deepcopy(body.get('groups',[])); wg.validate(items)
        revision=conn.execute('INSERT INTO work_group_templates(groups_json) VALUES (?)',(wg.dumps(wg.definition(items)),)).lastrowid
        conn.commit()
        return {'revision':revision,'groups':wg.definition(items)}
    finally: conn.close()


@router.get('/{object_id}')
def get_groups(object_id: int, user=Depends(get_current_user)):
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'zones','read')
        wg.ensure_object(conn,object_id)
        if not wg.groups(conn,object_id):
            wg.fail('Группы монтажных работ доступны для объектов ЖБИ')
        result=wg.state(conn,object_id); conn.commit()
        result['can_edit_template']=user['role']=='admin'
        if result['can_edit_template']:
            pairs = list(conn.execute("SELECT s.element_type,s.subtype FROM allowed_subtypes s JOIN objects o ON o.id=s.object_id WHERE o.kind='zhbi' UNION SELECT e.element_type,e.subtype FROM elements e JOIN objects o ON o.id=e.object_id WHERE o.kind='zhbi'"))
            result['template_types'] = sorted(set(result['types']) | {r[0] for r in pairs})
            result['template_subtypes'] = {t: sorted({r[1] or '' for r in pairs if r[0]==t} | set(result['subtypes'].get(t,[]))) for t in result['template_types']}

        return result
    finally: conn.close()


@router.post('/{object_id}/action')
def action(object_id: int, body: dict, user=Depends(get_current_user)):
    conn=get_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        assert_object_feature(conn,user,object_id,'zones','write')
        wg.ensure_object(conn,object_id)
        fingerprint=wg.fingerprint(conn,object_id)
        payload={k:v for k,v in body.items() if k not in ('preview','expected_hash')}
        expected=wg.digest({'state':fingerprint,'action':payload})
        if not body.get('preview',False) and body.get('expected_hash')!=expected:
            wg.fail('Данные изменились. Выполните предпросмотр ещё раз',409)
        actor=' '.join(str(user[k] or '') for k in ('last_name','first_name')).strip()
        result=wg.apply_action(conn,object_id,payload,actor)
        if result.get('conflicts'):
            conn.rollback(); return result
        result['expected_hash']=expected
        if body.get('preview',False):
            conn.rollback()
        else:
            conn.commit()
            from app import activity
            for change in result.get('changes',[]):
                activity.log('zone_rebind',user=user,entity_type='element',entity_id=change['id'],old_value=wg.dumps(change['before']),new_value=wg.dumps(change['after']))
            activity.log('zone_edit',user=user,entity_type='object',entity_id=object_id,details={'work_group_action':payload['action'],'changed':result.get('changed',0)})
        return result
    finally: conn.close()


@router.get('/{object_id}/history')
def history(object_id: int, element_id: int | None = None, user=Depends(get_current_user)):
    conn=get_connection()
    try:
        assert_object_feature(conn,user,object_id,'zones','read')
        clauses='h.object_id=?'; params=[object_id]
        if element_id is not None: clauses+=' AND h.element_id=?'; params.append(element_id)
        return [dict(r) for r in conn.execute(f"SELECT h.*,EXISTS(SELECT 1 FROM work_group_history u WHERE u.object_id=h.object_id AND u.action='zone_undo' AND json_extract(u.before_json,'$.history_id')=h.id) AS undone FROM work_group_history h WHERE {clauses} ORDER BY id DESC LIMIT 500",params)]
    finally: conn.close()
