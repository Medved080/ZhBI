"""
Общие настройки приложения (ключ-значение, таблица app_settings) — сейчас
единственная настройка — порог "красной" инфо-плашки в днях (см.
Docs/backlog.md, "Контрактация 2.0"). Серверная, не персональная —
значение одно на всех менеджеров, в отличие от клиентских Вид-переключателей
(state.zoneVisibility/labelVisibility/infoPlateVisible), которые остаются
только в браузере.
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user, require_admin
from app.db import get_connection

router = APIRouter(prefix="/settings", tags=["settings"])

INFO_PLATE_THRESHOLD_KEY = "info_plate_late_threshold_days"


def get_setting(conn, key: str, default: str = None):
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


class InfoPlateSettingsOut(BaseModel):
    late_threshold_days: int


class InfoPlateSettingsIn(BaseModel):
    late_threshold_days: int


@router.get("/info-plate", response_model=InfoPlateSettingsOut)
def get_info_plate_settings(user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        value = get_setting(conn, INFO_PLATE_THRESHOLD_KEY, "0")
        return {"late_threshold_days": int(value)}
    finally:
        conn.close()


@router.put("/info-plate", response_model=InfoPlateSettingsOut)
def set_info_plate_settings(body: InfoPlateSettingsIn, admin: sqlite3.Row = Depends(require_admin)):
    if body.late_threshold_days < 0:
        raise HTTPException(status_code=400, detail="Порог не может быть отрицательным")
    conn = get_connection()
    try:
        set_setting(conn, INFO_PLATE_THRESHOLD_KEY, str(body.late_threshold_days))
        conn.commit()
        return {"late_threshold_days": body.late_threshold_days}
    finally:
        conn.close()
