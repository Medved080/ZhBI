"""Личное состояние интерфейса пользователя на сервере (2026-10-08, запрос пользователя).

Фильтры схемы, видимость зон и подписей, режим 2D/3D и камера раньше жили в памяти страницы и слетали при каждом обновлении.
Теперь они сохраняются за УЧЁТНОЙ ЗАПИСЬЮ (не за браузером): переживают обновление, долгую паузу, новый вход и работу с другого
компьютера. Область (`scope`) — «scene:<id объекта>»: у каждого объекта свои значения фильтров.

Это настройки, а не рабочие данные: отдельной проверки прав на объект нет (человек пишет только свои строки), но размер и
форма ограничены. Во время режима «от имени пользователя» запись молча пропускается — иначе администратор затирал бы
чужие настройки, просто посмотрев на экран подопечного."""
import json
import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import impersonation
from app.auth import get_current_user
from app.db import get_connection

router = APIRouter(tags=["ui-state"])

SCOPE_RE = re.compile(r"^[a-z0-9:_.-]{1,80}$")
MAX_BYTES = 256 * 1024


class UiStateIn(BaseModel):
    scope: str
    data: dict


def _scope(scope: str) -> str:
    if not SCOPE_RE.match(scope or ""):
        raise HTTPException(status_code=400, detail="Недопустимое имя области состояния")
    return scope


@router.get("/me/ui-state")
def get_ui_state(scope: str = Query(...), user: sqlite3.Row = Depends(get_current_user)):
    scope = _scope(scope)
    conn = get_connection()
    try:
        row = conn.execute("SELECT data, updated_at FROM user_ui_state WHERE user_id = ? AND scope = ?",
                           (user["id"], scope)).fetchone()
    finally:
        conn.close()
    if row is None:
        return {"scope": scope, "data": None, "updated_at": None}
    try:
        data = json.loads(row["data"])
    except ValueError:
        data = None
    return {"scope": scope, "data": data, "updated_at": row["updated_at"]}


@router.put("/me/ui-state")
def put_ui_state(body: UiStateIn, user: sqlite3.Row = Depends(get_current_user)):
    scope = _scope(body.scope)
    text = json.dumps(body.data, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Состояние интерфейса слишком большое")
    if impersonation.current() is not None:
        return {"ok": True, "skipped": "режим «от имени пользователя»"}
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO user_ui_state (user_id, scope, data, updated_at) VALUES (?, ?, ?, datetime('now')) "
            "ON CONFLICT (user_id, scope) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (user["id"], scope, text))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
