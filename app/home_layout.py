"""Раскладка начальной страницы «Действия» в режиме «По процессам» (2026-10-26).

Что в какой блок попадает и в каком порядке, решает администратор сервиса: режим «Настройка» на самой странице — перетаскивание
пунктов между блоками и внутри блока, новые блоки, удаление пустых. Раскладка ОБЩАЯ для всех пользователей и хранится одной записью
`app_settings` (системный ключ, объекта нет): личной она быть не может — страница должна выглядеть одинаково для всей команды.

Хранится только то, что выбрал человек: список блоков [{id, title, items: [id разделов]}]. Что показывать пользователю по его правам и
типу объекта, считает клиент — здесь права не проверяются, сервер лишь не принимает мусор. Разделы, которых в сохранённой раскладке нет
(добавлены позже), клиент докладывает в блок по умолчанию сам; пустой ответ — раскладки нет, действует встроенная.
"""

import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import require_system_admin
from app.auth import get_current_user
from app.db import begin_write, get_connection
from app.settings import get_setting, set_setting

router = APIRouter(tags=["home-layout"])

KEY = "home_process_layout"
MAX_CARDS = 40
MAX_ITEMS = 400
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


class CardIn(BaseModel):
    id: str
    title: str
    items: list[str] = []


class LayoutIn(BaseModel):
    cards: list[CardIn]


def _clean(body: LayoutIn) -> dict:
    """Проверка и нормализация: известная форма, уникальные id блоков, раздел встречается не больше одного раза."""
    if len(body.cards) > MAX_CARDS:
        raise HTTPException(status_code=400, detail=f"Блоков не больше {MAX_CARDS}")
    cards, seen_cards, seen_items = [], set(), set()
    for c in body.cards:
        title = (c.title or "").strip()
        if not _ID.match(c.id or ""):
            raise HTTPException(status_code=400, detail="Недопустимый идентификатор блока")
        if c.id in seen_cards:
            raise HTTPException(status_code=400, detail="Идентификатор блока повторяется")
        if not title or len(title) > 80:
            raise HTTPException(status_code=400, detail="У блока должно быть название до 80 знаков")
        items = []
        for it in c.items:
            if not _ID.match(it or ""):
                raise HTTPException(status_code=400, detail="Недопустимый идентификатор раздела")
            if it in seen_items:
                continue   # раздел живёт в одном блоке: повтор — это перенос, который клиент не дочистил
            seen_items.add(it)
            items.append(it)
        if len(seen_items) > MAX_ITEMS:
            raise HTTPException(status_code=400, detail="Слишком много разделов")
        seen_cards.add(c.id)
        cards.append({"id": c.id, "title": title, "items": items})
    return {"cards": cards}


@router.get("/home-layout")
def read_home_layout(user=Depends(get_current_user)):
    conn = get_connection()
    try:
        raw = get_setting(conn, KEY, None)
    finally:
        conn.close()
    try:
        layout = json.loads(raw) if raw else None
    except ValueError:
        layout = None
    return {"layout": layout}


@router.put("/home-layout")
def write_home_layout(body: LayoutIn, user=Depends(require_system_admin)):
    layout = _clean(body)
    conn = get_connection()
    try:
        begin_write(conn)
        set_setting(conn, KEY, None, json.dumps(layout, ensure_ascii=False))
        conn.commit()
    finally:
        conn.close()
    activity.log("home_layout_save", user=user, entity_type="home_layout",
                 details={"cards": len(layout["cards"]), "items": sum(len(c["items"]) for c in layout["cards"])})
    return {"layout": layout}


@router.delete("/home-layout")
def reset_home_layout(user=Depends(require_system_admin)):
    conn = get_connection()
    try:
        begin_write(conn)
        conn.execute("DELETE FROM app_settings WHERE key = ? AND object_id IS NULL", (KEY,))
        conn.commit()
    finally:
        conn.close()
    activity.log("home_layout_reset", user=user, entity_type="home_layout")
    return {"layout": None}
