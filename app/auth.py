"""
Аутентификация по логину/паролю с серверной сессией (httponly-cookie).
Пароль хранится как PBKDF2-HMAC-SHA256 хэш с индивидуальной солью — без
внешних зависимостей (hashlib из стандартной библиотеки достаточно для
внутреннего инструмента такого масштаба). password_hash IS NULL означает
"пароль не задан" — вход разрешён с пустым паролем, пока кто-то (сам
пользователь или админ) не установит настоящий через UI.
"""

import hashlib
import os
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app.db import get_connection

SESSION_COOKIE = "zhbi_session"
SESSION_TTL_DAYS = 30
PBKDF2_ITERATIONS = 260_000

# По умолчанию выключено — деплой сейчас на чистом HTTP внутри локальной
# сети (см. Docs/DEPLOYMENT_WINDOWS.md, там нигде нет TLS/reverse-proxy),
# secure=True безусловно сломал бы вход. Включить переменной окружения
# ZHBI_SECURE_COOKIES=1, если/когда появится HTTPS.
SECURE_COOKIES = os.environ.get("ZHBI_SECURE_COOKIES") == "1"

router = APIRouter()

# Блокировка подбора пароля — по IP клиента, не по логину: логины и так
# публично видны через GET /login-users, блокировка по логину позволила
# бы атакующему намеренно запереть чужого пользователя, зная только его
# логин. In-memory (один процесс uvicorn, без внешнего кэша).
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5
_login_attempts: dict[str, list[float]] = {}


def _check_login_rate_limit(client_ip: str) -> None:
    now = time.time()
    attempts = [t for t in _login_attempts.get(client_ip, []) if now - t < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
    _login_attempts[client_ip] = attempts
    if len(attempts) >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Слишком много попыток входа, попробуйте позже")


def _record_login_failure(client_ip: str) -> None:
    _login_attempts.setdefault(client_ip, []).append(time.time())


def hash_password(password: str, salt: Optional[str] = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return derived.hex(), salt


def verify_password(password: str, password_hash: Optional[str], password_salt: Optional[str]) -> bool:
    if password_hash is None:
        return password == ""
    if password_salt is None:
        return False
    derived, _ = hash_password(password, password_salt)
    return secrets.compare_digest(derived, password_hash)


def format_display_name(user: sqlite3.Row) -> str:
    parts = [user["last_name"], user["first_name"], user["patronymic"]]
    return " ".join(p for p in parts if p)


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", (token, user_id, expires_at)
    )
    conn.commit()
    return token


def get_user_by_session(conn: sqlite3.Connection, token: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > datetime('now')",
        (token,),
    ).fetchone()


def get_current_user(request: Request) -> sqlite3.Row:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Не авторизован")
    conn = get_connection()
    try:
        user = get_user_by_session(conn, token)
    finally:
        conn.close()
    if user is None:
        raise HTTPException(status_code=401, detail="Сессия истекла или недействительна")
    return user


def require_roles(*roles: str):
    def dependency(user: sqlite3.Row = Depends(get_current_user)) -> sqlite3.Row:
        if user["role"] not in roles:
            raise HTTPException(status_code=403, detail="Недостаточно прав")
        return user

    return dependency


require_admin = require_roles("admin")
require_editor = require_roles("admin", "user")  # может менять статусы/грузить чертежи


class LoginRequest(BaseModel):
    domain_login: str
    password: str = ""


class UserOut(BaseModel):
    id: int
    last_name: str
    first_name: str
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str
    display_name: str
    has_password: bool
    label_color: Optional[str] = None  # персональный цвет подписей марок (2D/3D), NULL = дефолт


def user_out(user: sqlite3.Row) -> UserOut:
    return UserOut(
        id=user["id"],
        last_name=user["last_name"],
        first_name=user["first_name"],
        patronymic=user["patronymic"],
        position=user["position"],
        department=user["department"],
        domain_login=user["domain_login"],
        role=user["role"],
        display_name=format_display_name(user),
        has_password=user["password_hash"] is not None,
        label_color=user["label_color"],
    )


class PublicUserOut(BaseModel):
    domain_login: str
    display_name: str


@router.get("/login-users", response_model=list[PublicUserOut])
def login_users():
    """
    Публичный (без авторизации — им же и пользуется форма входа до логина)
    список для выпадающего списка на экране входа (п.7 бэклога). Отдаёт
    ТОЛЬКО ФИО и логин, никаких ролей/паролей — это осознанный компромисс:
    раскрывает список валидных логинов неаутентифицированному клиенту ради
    удобства входа, приемлемо для внутреннего инструмента, но не годится,
    если сервис когда-нибудь станет публично доступным.
    """
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY last_name, first_name").fetchall()
        return [PublicUserOut(domain_login=r["domain_login"], display_name=format_display_name(r)) for r in rows]
    finally:
        conn.close()


@router.post("/login", response_model=UserOut)
def login(body: LoginRequest, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"
    _check_login_rate_limit(client_ip)

    conn = get_connection()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE domain_login = ?", (body.domain_login,)
        ).fetchone()
        if user is None or not verify_password(body.password, user["password_hash"], user["password_salt"]):
            _record_login_failure(client_ip)
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
        token = create_session(conn, user["id"])
        _login_attempts.pop(client_ip, None)
    finally:
        conn.close()

    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", secure=SECURE_COOKIES,
        max_age=SESSION_TTL_DAYS * 86400,
    )
    return user_out(user)


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        conn = get_connection()
        try:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
        finally:
            conn.close()
    response.delete_cookie(SESSION_COOKIE)
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(user: sqlite3.Row = Depends(get_current_user)):
    return user_out(user)
