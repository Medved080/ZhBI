"""Управление пользователями — доступно только администратору, кроме смены
собственного пароля (её может сделать любой залогиненный пользователь себе)."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user, hash_password, require_admin, user_out, UserOut
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


VALID_ROLES = {"admin", "user", "view"}


def _validate_role(role: str):
    if role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Неизвестная роль: {role}")


@router.get("", response_model=list[UserOut])
def list_users(admin: sqlite3.Row = Depends(require_admin)):
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY last_name, first_name").fetchall()
        return [user_out(r) for r in rows]
    finally:
        conn.close()


@router.post("", response_model=UserOut)
def create_user(body: UserCreateIn, admin: sqlite3.Row = Depends(require_admin)):
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
def update_user(user_id: int, body: UserUpdateIn, admin: sqlite3.Row = Depends(require_admin)):
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
    user_id: int, body: SetPasswordIn, current: sqlite3.Row = Depends(get_current_user)
):
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только свой пароль")

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
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user_out(updated)
    finally:
        conn.close()
