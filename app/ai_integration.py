"""Общее подключение к локальному ИИ; настройки сервиса, без изменения схемы БД."""
import hashlib
import json
from contextlib import contextmanager
from threading import Lock
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app import activity
from app.access import assert_feature
from app.auth import get_current_user
from app.db import get_connection
from app.calc import qwen_client, runtime
from app.calc.database import connect, transaction
from app.calc.recovery_schema import ConnectionConfig, StrictModel

router = APIRouter(prefix="/ai", tags=["local-ai"])
KEY = "service_local_ai"
_GPU = Lock()


class IntegrationConfig(StrictModel):
    connection: ConnectionConfig = Field(default_factory=ConnectionConfig)
    assistantModel: str = Field(default="", max_length=200)
    assistantEnabled: bool = True
    assistantContextTokens: int = Field(default=16384, ge=8192, le=65536)


class SaveConfig(IntegrationConfig):
    expectedRevision: str = Field(pattern=r"^[0-9a-f]{64}$")


def fingerprint(config):
    return hashlib.sha256(config.model_dump_json().encode()).hexdigest()


def read_config(conn=None):
    own = conn is None
    conn = conn or get_connection()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key=? AND object_id IS NULL", (KEY,)).fetchone()
        if row:
            return IntegrationConfig.model_validate_json(row[0])
        # Старое подключение сразу доступно. Перенос сохраняется при первом сохранении
        # администратором; старый файл калькулятора не изменяется и не требуется миграция.
        cfg = runtime.settings()
        if cfg.database_path.exists():
            legacy = connect(cfg.database_path)
            try:
                row = legacy.execute("SELECT config_json FROM recovery_settings WHERE id=1").fetchone()
                if row:
                    return IntegrationConfig(connection=ConnectionConfig.model_validate_json(row[0]))
            finally:
                legacy.close()
        return IntegrationConfig()
    finally:
        if own:
            conn.close()


def admin(user=Depends(get_current_user)):
    conn = get_connection()
    try:
        assert_feature(conn, user, "ai_settings", "write")
    finally:
        conn.close()
    return user


@router.get("/config")
def configuration(user=Depends(admin)):
    from app.calc import recovery
    config = read_config()
    drawing = recovery.get_configuration(runtime.settings()) if runtime.ready() else {}
    return {**config.model_dump(), "revision": fingerprint(config),
            "apiKeyConfigured": bool(runtime.settings().qwen_api_key),
            "drawingProbe": drawing.get("probe"), "workerEnabled": drawing.get("workerEnabled", False)}


@router.put("/config")
def save_configuration(body: SaveConfig, user=Depends(admin)):
    config = IntegrationConfig.model_validate(body.model_dump(exclude={"expectedRevision"}))
    try:
        qwen_client.validate_endpoint(config.connection, runtime.settings())
        qwen_client.validate_endpoint(config.connection.model_copy(update={"model": config.assistantModel}), runtime.settings())
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if fingerprint(read_config(conn)) != body.expectedRevision:
            raise HTTPException(409, "Настройки ИИ уже изменены. Обновите страницу и повторите правку.")
        conn.execute("INSERT INTO app_settings(key,object_id,value) VALUES(?,NULL,?) "
                     "ON CONFLICT(key, COALESCE(object_id, -1)) DO UPDATE SET value=excluded.value",
                     (KEY, config.model_dump_json()))
        conn.commit()
    finally:
        conn.close()
    activity.log("ai_settings", user=user, new_value=config.assistantModel,
                 details={"provider": config.connection.provider, "drawing_model": config.connection.model,
                          "assistant_enabled": config.assistantEnabled})
    return configuration(user)


@router.post("/models")
def models(body: ConnectionConfig, user=Depends(admin)):
    try:
        return qwen_client.list_models(body, runtime.settings())
    except (ValueError, qwen_client.InferenceError) as error:
        raise HTTPException(422, str(error)) from error


@router.post("/drawing-test", status_code=202)
def drawing_test(user=Depends(admin)):
    from app.calc import recovery
    runtime.require_ready()
    return recovery.start_probe(runtime.settings())


@router.get("/drawing-test")
def drawing_test_state(user=Depends(admin)):
    from app.calc import recovery
    return recovery.probe_state()


@contextmanager
def gpu_slot(config, cancel):
    """Общая аренда GPU с обработкой чертежей, в том числе между процессами."""
    from app.calc import recovery
    if not _GPU.acquire(blocking=False):
        raise HTTPException(409, "Локальная модель занята другим запросом. Повторите после его завершения.")
    token = str(uuid4())
    shared = runtime.ready()
    claimed = False
    try:
        if shared:
            with transaction(runtime.settings().database_path) as conn:
                claimed = recovery.claim_gpu(conn, token, config.timeoutSeconds, "assistant")
            if not claimed:
                raise HTTPException(409, "GPU занят обработкой чертежей или проверкой подключения. Повторите после завершения.")
        def progress(info):
            import time
            if shared:
                with transaction(runtime.settings().database_path) as conn:
                    row = conn.execute("SELECT value FROM application_meta WHERE key='recovery_gpu_lease'").fetchone()
                    lease = json.loads(row[0]) if row else {}
                    if lease.get("token") != token:
                        cancel.set()
                        return
                    lease["expires"] = time.time() + config.timeoutSeconds + 60
                    conn.execute("UPDATE application_meta SET value=? WHERE key='recovery_gpu_lease'", (json.dumps(lease),))
        yield progress
    finally:
        try:
            if claimed:
                with transaction(runtime.settings().database_path) as conn:
                    recovery.release_gpu(conn, token)
        finally:
            _GPU.release()


@router.post("/dialog-test", status_code=202)
def dialog_test(user=Depends(admin)):
    from app.assistant import Ask, start_request
    from datetime import datetime
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Europe/Moscow"))
    return start_request(Ask(question="Ответь одной фразой: подключение к модели работает."), user,
                         {"capturedAt": now.isoformat(), "period": {"from": now.date().isoformat(), "to": now.date().isoformat()},
                          "scope": "connection-test", "objects": [], "sources": [], "warnings": [], "page": None})
