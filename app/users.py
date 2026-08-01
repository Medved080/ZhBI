"""Управление пользователями — доступно только администратору, кроме смены
собственного пароля (её может сделать любой залогиненный пользователь себе)."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.access import require_system_admin
from app.auth import (
    SESSION_COOKIE, get_current_user, hash_password, require_admin,
    user_out, validate_password_strength, UserOut,
)
from app.db import get_connection

router = APIRouter(prefix="/users", tags=["users"])


class UserCreateIn(BaseModel):
    last_name: str
    first_name: str = ""
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str


class UserUpdateIn(BaseModel):
    last_name: str
    first_name: str = ""
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str


class SetPasswordIn(BaseModel):
    password: str = ""  # пустая строка — сбросить в "пароль не задан"


class SetLabelColorIn(BaseModel):
    label_color: Optional[str] = None  # null — сброс на дефолт


VALID_ROLES = {"admin", "user", "view"}


def _validate_role(role: str):
    if role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Неизвестная роль: {role}")


@router.get("", response_model=list[UserOut])
def list_users(admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY last_name, first_name").fetchall()
        return [user_out(r) for r in rows]
    finally:
        conn.close()


@router.post("", response_model=UserOut)
def create_user(body: UserCreateIn, admin: sqlite3.Row = Depends(require_system_admin)):
    _validate_role(body.role)
    conn = get_connection()
    try:
        existing = conn.execute(
            "SELECT id FROM users WHERE domain_login = ?", (body.domain_login,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Такое доменное имя уже занято")
        conn.execute(
            """
            INSERT INTO users (last_name, first_name, patronymic, position, department, domain_login, role)
            VALUES (:last_name, :first_name, :patronymic, :position, :department, :domain_login, :role)
            """,
            body.model_dump(),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM users WHERE domain_login = ?", (body.domain_login,)
        ).fetchone()
        return user_out(row)
    finally:
        conn.close()


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdateIn, admin: sqlite3.Row = Depends(require_system_admin)):
    _validate_role(body.role)
    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        conflict = conn.execute(
            "SELECT id FROM users WHERE domain_login = ? AND id != ?", (body.domain_login, user_id)
        ).fetchone()
        if conflict:
            raise HTTPException(status_code=409, detail="Такое доменное имя уже занято")
        conn.execute(
            """
            UPDATE users SET
                last_name=:last_name, first_name=:first_name, patronymic=:patronymic,
                position=:position, department=:department, domain_login=:domain_login,
                role=:role, updated_at=datetime('now')
            WHERE id=:id
            """,
            {**body.model_dump(), "id": user_id},
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user_out(updated)
    finally:
        conn.close()


@router.post("/{user_id}/set-password", response_model=UserOut)
def set_password(
    user_id: int, body: SetPasswordIn, request: Request, current: sqlite3.Row = Depends(get_current_user)
):
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только свой пароль")

    if body.password == "":
        # password_hash=NULL теперь означает "вход запрещён" (см.
        # app/auth.py verify_password), а не "пароль не требуется" — то
        # есть это осознанная БЛОКИРОВКА аккаунта, не самообслуживание.
        # Разрешаем только админу и только над чужим аккаунтом.
        if current["role"] != "admin":
            raise HTTPException(status_code=403, detail="Нельзя снять собственный пароль")
    else:
        try:
            validate_password_strength(body.password)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))

    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")

        if body.password == "":
            password_hash, password_salt = None, None
        else:
            password_hash, password_salt = hash_password(body.password)

        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?",
            (password_hash, password_salt, user_id),
        )
        # Смена пароля обесценивает уже выданные cookie этого пользователя —
        # иначе украденная или оставленная в общем браузере сессия
        # продолжала бы работать даже после того, как владелец (сам или
        # через админа) поменял пароль именно потому, что заподозрил её
        # компрометацию. Сессия, которой ПРЯМО СЕЙЧАС пользуется вызывающий
        # (самообслуживание — меняешь себе, останешься в ней же), не
        # трогается — иначе смена собственного пароля мгновенно
        # разлогинивала бы автора действия.
        current_token = request.cookies.get(SESSION_COOKIE)
        if current_token:
            conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token != ?", (user_id, current_token)
            )
        else:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user_out(updated)
    finally:
        conn.close()


@router.patch("/{user_id}/label-color", response_model=UserOut)
def set_label_color(
    user_id: int, body: SetLabelColorIn, current: sqlite3.Row = Depends(get_current_user)
):
    """Персональная настройка (см. Docs/backlog.md) — тот же guard, что у
    set_password: менять можно только себе, если ты не admin."""
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только свой цвет подписей")

    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        conn.execute(
            "UPDATE users SET label_color = ?, updated_at = datetime('now') WHERE id = ?",
            (body.label_color, user_id),
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user_out(updated)
    finally:
        conn.close()
