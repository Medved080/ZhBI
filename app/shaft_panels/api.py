"""FastAPI router factory. Dependencies must be supplied by the host service.

The bounded token store is for ONE uvicorn worker (the current deployment).
For multiple workers replace PendingStore with shared storage before rollout.
"""
from copy import deepcopy
from pathlib import Path
import secrets
import tempfile
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .parser import DrawingError, parse_drawing
from .placement import place_panels
from . import storage


class PendingStore:
    def __init__(self,ttl=900,limit=8):
        self.ttl,self.limit=ttl,limit
        self.items={}
        self.lock=threading.RLock()

    def put(self,user_id,object_id,payload):
        with self.lock:
            now=time.monotonic()
            self.items={k:v for k,v in self.items.items() if v['expires']>now}
            if len(self.items)>=self.limit:
                raise HTTPException(429,'Очередь анализов заполнена; отмените предыдущий анализ или дождитесь 15 минут')
            token=secrets.token_urlsafe(32)
            self.items[token]={'user_id':user_id,'object_id':object_id,'expires':now+self.ttl,'payload':deepcopy(payload)}
            return token

    def get(self,token,user_id):
        value=self.items.get(token)
        if not value or value['expires']<=time.monotonic():
            self.items.pop(token,None)
            raise HTTPException(410,'Анализ истек — загрузите чертеж повторно')
        if value['user_id']!=user_id:
            raise HTTPException(403,'Этот анализ принадлежит другому пользователю')
        return value


class ApplyRequest(BaseModel):
    token: str = Field(min_length=20,max_length=100)
    acknowledged_warnings: list[str] = Field(default_factory=list,max_length=20)
    retire_missing: bool = False


def build_router(*,connection_factory,get_user,assert_access,backup,before_commit,after_apply=None):
    """Required host callbacks:
    assert_access(conn,user,object_id) -> enforces drawings/write.
    backup(user,object_id) -> app's backup_before_import wrapper.
    before_commit(conn,user,object_id,changed_ids,summary) -> no commit, no second writer.
    get_user -> normal cookie-session dependency (preserves host CSRF middleware).
    after_apply(user,object_id,summary) -> OPTIONAL, called AFTER the transaction has
    committed (storage.apply() already returned). Best-effort: a failure here must not
    make the caller believe the import itself failed, since shaft_panel_imports already
    recorded it — exceptions are swallowed.
    """
    router=APIRouter(prefix='/shaft-panels',tags=['shaft-panels'])
    pending=PendingStore()

    @router.post('/analyze')
    def analyze_endpoint(file:UploadFile=File(...),object_id:int=Form(...),
                         thickness_mm:Optional[float]=Form(None),grid_source:Optional[str]=Form(None),
                         user=Depends(get_user)):
        conn=connection_factory()
        try:
            assert_access(conn,user,object_id)
            axes,axis_source=storage.load_target_axes(conn,object_id,grid_source)
            if not (file.filename or '').lower().endswith('.dxf'):
                raise DrawingError('Ожидается DXF')
            with tempfile.TemporaryDirectory(prefix='shaft-panels-') as folder:
                path=Path(folder)/'drawing.dxf'
                total=0
                with path.open('wb') as dest:
                    while chunk:=file.file.read(1024*1024):
                        total+=len(chunk)
                        if total>30*1024*1024:
                            raise HTTPException(413,'DXF больше 30 МиБ')
                        dest.write(chunk)
                drawing=parse_drawing(path)
            drawing['source_file']=Path(file.filename.replace('\\','/')).name
            placed=place_panels(drawing,axes,thickness_mm=thickness_mm)
            analysis=storage.analyze(conn,object_id,placed) if placed['commit_ready'] else None
            token=pending.put(user['id'],object_id,{'placed':placed,'analysis':analysis,
                                                   'grid_source':axis_source,'axes_digest':storage.digest(axes)})
            return {'token':token,'drawing':placed,'analysis':analysis,'grid_source':axis_source}
        except DrawingError as exc:
            raise HTTPException(422,str(exc)) from exc
        finally:
            conn.close()
            file.file.close()

    @router.post('/apply')
    def apply_endpoint(body:ApplyRequest,user=Depends(get_user)):
        # Single lock also prevents double-use while SQL is being committed.
        with pending.lock:
            entry=pending.get(body.token,user['id']);object_id=entry['object_id'];data=entry['payload']
            conn=connection_factory()
            try:
                assert_access(conn,user,object_id)
                if data['analysis'] is None:
                    raise DrawingError('Укажите толщину и повторите анализ')
                axes,_=storage.load_target_axes(conn,object_id,data['grid_source'])
                if storage.digest(axes)!=data['axes_digest']:
                    raise DrawingError('Сетка осей изменилась после анализа')
                # Check obvious conflicts before the host creates its backup.
                fresh=storage.analyze(conn,object_id,data['placed'])
                if fresh['state_digest']!=data['analysis']['state_digest'] or fresh['conflicts']:
                    raise DrawingError('Данные или ручные правки изменились — повторите анализ')
                required={w['code'] for w in data['placed']['warnings']}
                if not required<=set(body.acknowledged_warnings):
                    raise DrawingError('Подтвердите замечания к чертежу')
                backup(user,object_id)
                def checked_hook(tx,oid,changed,summary):
                    assert_access(tx,user,oid)
                    current_axes,_=storage.load_target_axes(tx,oid,data['grid_source'])
                    if storage.digest(current_axes)!=data['axes_digest']:
                        raise DrawingError('Сетка осей изменилась во время применения')
                    before_commit(tx,user,oid,changed,summary)
                result=storage.apply(conn,data['analysis'],data['placed'],user_id=user['id'],
                    acknowledged_warnings=body.acknowledged_warnings,retire_missing=body.retire_missing,
                    before_commit=checked_hook)
                pending.items.pop(body.token,None)
                if after_apply:
                    try:
                        after_apply(user,object_id,result)
                    except Exception:
                        pass
                return result
            except DrawingError as exc:
                raise HTTPException(409,str(exc)) from exc
            finally:
                conn.close()

    @router.delete('/pending/{token}')
    def cancel_endpoint(token:str,user=Depends(get_user)):
        with pending.lock:
            pending.get(token,user['id'])
            pending.items.pop(token,None)
        return {'cancelled':True}

    return router
