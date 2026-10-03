"""Вход и права калькулятора — это вход и права ЖБИ.

Собственных пользователей, сессий и попыток входа у подсистемы нет. Человек
входит в ЖБИ; здесь проверяется раздел `calc` («Чтение» — смотреть, «Изменение»
— править). Администратор сервиса проходит в обход матрицы, как и везде.

CSRF. Куки ЖБИ — SameSite=Lax, а запросы калькулятора изменяют данные, поэтому
сохранён прежний протокол подсистемы: клиент получает токен из /api/auth/me и
возвращает его заголовком X-CSRF-Token. Токен — HMAC от токена сессии, на
сервере ничего не хранится.
"""
import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request

from app.access import assert_feature, has_feature
from app.auth import SESSION_COOKIE, format_display_name, get_current_user
from app.db import get_connection
from app.features import READ, WRITE

_KEY = b"calc-csrf-v1"  # секретом служит HttpOnly-токен сессии, ключ только метка


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def csrf_for(request: Request) -> str:
    token = request.cookies.get(SESSION_COOKIE, "")
    return hmac.new(_KEY, token.encode(), hashlib.sha256).hexdigest()


def _describe(request: Request, row, level: str) -> dict:
    return {"id": str(row["id"]), "login": row["domain_login"], "displayName": format_display_name(row) or row["domain_login"],
            "role": "admin" if row["role"] == "admin" else ("editor" if level == WRITE else "viewer"),
            "csrfToken": csrf_for(request), "local": False,
            "uiTheme": row["ui_theme"] if "ui_theme" in row.keys() else None}


def current_user(request: Request):
    row = get_current_user(request)
    conn = get_connection()
    try:
        assert_feature(conn, row, "calc", READ)
        level = WRITE if has_feature(conn, row, "calc", WRITE) else READ
    finally:
        conn.close()
    return _describe(request, row, level)


def writer(request: Request):
    user = current_user(request)
    if user["role"] not in {"admin", "editor"}:
        raise HTTPException(403, "Недостаточно прав для изменения данных калькулятора")
    require_csrf(request, user)
    return user


def require_csrf(request, user):
    token = request.headers.get("x-csrf-token", "")
    if not secrets.compare_digest(token, user["csrfToken"]):
        raise HTTPException(403, "Обновите страницу: токен защиты формы не совпадает")
