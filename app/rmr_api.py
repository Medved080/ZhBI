"""Настройки облачного роутера red_mad_robot для помощника: чтение, сохранение, ключ, модели, проверка, расход.

Доступ — как у всей «Интеграции с ИИ»: системный администратор или право `ai_settings/write`.
Ключ принимается отдельным запросом и обратно не отдаётся: наружу — только «задан / не задан» и источник.
Устройство и причины ограничений — `app/rmr_router.py`, `Docs/ai-assistant-design.md` («Облачный роутер»).
"""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app import activity, rmr_pricing, rmr_router
from app.ai_integration import admin, read_config
from app.calc import qwen_client
from app.calc.recovery_schema import StrictModel
from app.db import get_connection

router = APIRouter(prefix="/ai/router", tags=["ai-router"])


class KeyBody(StrictModel):
    key: str = Field(max_length=400)


class ModelsBody(StrictModel):
    baseUrl: str = Field(default=rmr_router.DEFAULT_URL, max_length=500)


def _view(config: rmr_router.RouterConfig) -> dict:
    return {**config.model_dump(), "revision": rmr_router.fingerprint(config), "key": rmr_router.key_state(),
            "defaultUrl": rmr_router.DEFAULT_URL, "billingUrl": rmr_router.BILLING_URL, "dataNotice": rmr_router.DATA_NOTICE}


@router.get("/config")
def configuration(user=Depends(admin)):
    return _view(rmr_router.read_config())


@router.put("/config")
def save_configuration(body: rmr_router.RouterSave, user=Depends(admin)):
    config = rmr_router.RouterConfig.model_validate(body.model_dump(exclude={"expectedRevision"}))
    config = config.model_copy(update={"baseUrl": config.baseUrl.strip(), "model": config.model.strip()})
    try:
        rmr_router.validate_url(config.baseUrl)
        if config.enabled:
            rmr_router.check_ready(config)       # включить можно только то, что действительно готово к работе
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        before = rmr_router.read_config(conn)
        if rmr_router.fingerprint(before) != body.expectedRevision:
            raise HTTPException(409, "Настройки роутера уже изменены. Обновите страницу и повторите правку.")
        rmr_router.write_config(conn, config)
        conn.commit()
    finally:
        conn.close()
    activity.log("ai_router_settings", user=user, new_value=config.model, details={
        "включён": config.enabled, "согласие на передачу данных": config.dataConsent, "модель": config.model,
        "узел": urlsplit(config.baseUrl).hostname, "было включено": before.enabled})
    return _view(config)


@router.put("/key")
def save_key(body: KeyBody, user=Depends(admin)):
    try:
        rmr_router.set_key(body.key)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    activity.log("ai_router_key", user=user, details={"действие": "ключ задан"})       # сам ключ в журнал не попадает
    return {"key": rmr_router.key_state()}


@router.delete("/key")
def delete_key(user=Depends(admin)):
    rmr_router.clear_key()
    activity.log("ai_router_key", user=user, details={"действие": "ключ удалён"})
    return {"key": rmr_router.key_state()}


@router.post("/models")
def models(body: ModelsBody, user=Depends(admin)):
    try:
        return rmr_router.list_models(body.baseUrl)
    except (ValueError, qwen_client.InferenceError) as error:
        raise HTTPException(422, rmr_router.redact(error)) from error


@router.post("/test")
def test(user=Depends(admin)):
    """Проверка сохранённых настроек: адрес, ключ, модель и один короткий ответ."""
    config = rmr_router.read_config()
    try:
        result, meter = rmr_router.test_connection(config)
    except (ValueError, qwen_client.InferenceError) as error:
        raise HTTPException(422, rmr_router.redact(error)) from error
    rmr_pricing.record_usage(user, config.model, meter, kind="проверка подключения")
    rub = rmr_pricing.cost(rmr_pricing.lookup(config.model), meter.prompt, meter.completion)
    return {**result, "costRub": round(rub, 4) if rub is not None else None}


@router.get("/billing")
def billing(user=Depends(admin)):
    return rmr_pricing.view(rmr_router.read_config().model, read_config().assistantContextTokens)
