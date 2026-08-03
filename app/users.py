"""Управление пользователями — доступно только администратору, кроме смены
собственного пароля (её может сделать любой залогиненный пользователь себе)."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator

from app import activity, ldap_auth
from app.access import OBJECT_ROLES, ROLE_LABELS as OBJECT_ROLE_LABELS, require_system_admin
from app.auth import (
    SESSION_COOKIE, auth_method_of, get_current_user, hash_password,
    user_out, validate_password_strength, UserOut,
)
from app.db import get_connection
from app.models import validate_color

router = APIRouter(prefix="/users", tags=["users"])


class UserCreateIn(BaseModel):
    last_name: str
    first_name: str = ""
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str
    auth_method: str = "local"


class UserUpdateIn(BaseModel):
    last_name: str
    first_name: str = ""
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str
    auth_method: str = "local"


class SetPasswordIn(BaseModel):
    password: str = ""  # пустая строка — сбросить в "пароль не задан"


class SetLabelColorIn(BaseModel):
    label_color: Optional[str] = None  # null — сброс на дефолт

    @field_validator("label_color")
    @classmethod
    def _color_ok(cls, v: Optional[str]) -> Optional[str]:
        # Значение уходит в CSS-переменную --mark-label-color и в fillStyle
        # холста. Настройка личная (менять можно только себе), поэтому на
        # чужой сеанс не влияет — но формат проверяем тем же одним
        # валидатором, что и остальные цвета, чтобы не заводить второе
        # правило (см. app/models.validate_color).
        return None if v is None else validate_color(v, "Цвет подписей")


VALID_ROLES = {"admin", "user", "view"}

# Чем проверяется вход. CHECK на колонке есть только у свежих БД (ALTER
# TABLE ADD COLUMN его не принимает, см. app/db.py) — поэтому набор
# значений держится здесь.
AUTH_METHODS = {"local", "domain"}


def _validate_role(role: str):
    if role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Неизвестная роль: {role}")


def _validate_auth_method(conn, auth_method: str):
    """Доменный способ входа разрешаем заводить только при НАСТРОЕННОЙ
    доменной авторизации. Иначе администратор молча создал бы учётную
    запись, которой физически нечем войти: локальный пароль ей уже не
    подойдёт, а домен ещё не подключён — и разбираться в этом пришлось бы
    по 401 на экране входа."""
    if auth_method not in AUTH_METHODS:
        raise HTTPException(status_code=422, detail=f"Неизвестный способ входа: {auth_method}")
    if auth_method == "domain" and not ldap_auth.is_enabled(conn):
        raise HTTPException(
            status_code=422,
            detail="Доменная авторизация выключена — включите её в «Администрирование → "
                   "Доменная авторизация», иначе этот пользователь не сможет войти",
        )


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
        _validate_auth_method(conn, body.auth_method)
        conn.execute(
            """
            INSERT INTO users (last_name, first_name, patronymic, position, department,
                domain_login, role, auth_method)
            VALUES (:last_name, :first_name, :patronymic, :position, :department,
                :domain_login, :role, :auth_method)
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
        _validate_auth_method(conn, body.auth_method)
        conn.execute(
            """
            UPDATE users SET
                last_name=:last_name, first_name=:first_name, patronymic=:patronymic,
                position=:position, department=:department, domain_login=:domain_login,
                role=:role, auth_method=:auth_method, updated_at=datetime('now')
            WHERE id=:id
            """,
            {**body.model_dump(), "id": user_id},
        )
        if body.auth_method == "domain":
            # Пароль сервиса снимается ВМЕСТЕ с переводом на домен. Два живых
            # способа входа в одну учётную запись — это не «альтернатива», а
            # вторая, никем не наблюдаемая дверь: оставленный локальный пароль
            # продолжал бы подходить, если учётку когда-нибудь вернут на
            # 'local', и пережил бы увольнение владельца доменной записи.
            conn.execute(
                "UPDATE users SET password_hash = NULL, password_salt = NULL WHERE id = ?",
                (user_id,),
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
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        if auth_method_of(row) == "domain":
            # Молча принять пароль здесь было бы худшим вариантом: он лёг бы
            # в базу, вход бы его не спрашивал, и админ был бы уверен, что
            # выдал рабочие учётные данные.
            raise HTTPException(
                status_code=409,
                detail="У пользователя доменная авторизация — пароль сервиса не используется. "
                       "Чтобы задать пароль, сначала переключите способ входа на «Пароль сервиса».",
            )

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

class SetUiThemeIn(BaseModel):
    # None — вернуть базовое оформление. Список допустимых имён закрыт: тема
    # подставляется в атрибут data-skin, и принимать оттуда произвольную
    # строку от клиента незачем.
    ui_theme: Optional[str] = None


UI_THEMES = ("gos", "msu", "graphite", "indigo", "neon", "emerald", "sand")


@router.patch("/{user_id}/ui-theme", response_model=UserOut)
def set_ui_theme(
    user_id: int, body: SetUiThemeIn, current: sqlite3.Row = Depends(get_current_user)
):
    """Персональная цветовая гамма — тот же guard самообслуживания, что у
    set_label_color и set_password: менять можно только себе, если ты не
    администратор сервиса."""
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только своё оформление")
    if body.ui_theme is not None and body.ui_theme not in UI_THEMES:
        raise HTTPException(status_code=400, detail=f"Неизвестное оформление «{body.ui_theme}»")
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        conn.execute(
            "UPDATE users SET ui_theme = ?, updated_at = datetime('now') WHERE id = ?",
            (body.ui_theme, user_id),
        )
        conn.commit()
        return user_out(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    finally:
        conn.close()


# ==================== ДОСТУП К ОБЪЕКТАМ (этап C) ====================
#
# Роль на объекте — свойство ГРАНТА, а не пользователя (решение П2).
# users.role осталась системной ролью: она про ведение сервиса.


class AccessGrantIn(BaseModel):
    """Один грант. Оба поля необязательны — это и есть три уровня:

      project_id=None, object_id=None — все проекты (в т.ч. будущие);
      project_id задан, object_id=None — весь проект (в т.ч. будущие объекты);
      object_id задан                  — конкретный объект.
    """
    project_id: Optional[int] = None
    object_id: Optional[int] = None
    role: str


class AccessGrantsIn(BaseModel):
    grants: list[AccessGrantIn] = []


@router.get("/{user_id}/access")
def list_access(user_id: int, admin: sqlite3.Row = Depends(require_system_admin)):
    """Гранты пользователя с расшифровкой названий.

    Системному администратору гранты не нужны — он видит всё в обход, и
    список у него пуст не по ошибке. Об этом сообщает сам ответ, чтобы
    пустая таблица не читалась как «доступа нет».
    """
    conn = get_connection()
    try:
        row = conn.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        grants = [
            dict(r) for r in conn.execute(
                """
                SELECT ua.id, ua.project_id, ua.object_id, ua.role,
                       p.name AS project_name, o.name AS object_name
                FROM user_access ua
                LEFT JOIN projects p ON p.id = ua.project_id
                LEFT JOIN objects o ON o.id = ua.object_id
                WHERE ua.user_id = ?
                ORDER BY p.name, o.name
                """,
                (user_id,),
            )
        ]
        return {"system_admin": row["role"] == "admin", "grants": grants}
    finally:
        conn.close()


@router.put("/{user_id}/access")
def replace_access(user_id: int, body: AccessGrantsIn,
                   admin: sqlite3.Row = Depends(require_system_admin)):
    """Заменяет ВЕСЬ набор грантов пользователя присланным.

    Замена целиком, а не «добавить один»/«удалить один» (так было до
    2026-08-02): права задаются деревом проектов и объектов, где
    администратор видит и правит всю картину сразу. Отправлять из такой
    формы разницу значило бы считать её на клиенте и надеяться, что она
    совпала с тем, что на сервере; отправлять состояние — не значит.

    Пустой список — законный ответ «доступа нет вовсе», а не ошибка: это
    единственный способ отобрать всё.
    """
    for грант in body.grants:
        if грант.role not in OBJECT_ROLES:
            raise HTTPException(status_code=400, detail=f"Неизвестная роль «{грант.role}»")
        if грант.object_id is not None and грант.project_id is None:
            raise HTTPException(
                status_code=400,
                detail="Грант на объект должен указывать и проект — иначе связь объекта с "
                       "проектом пришлось бы угадывать при каждой проверке",
            )
    # Дубли ловим ДО записи: уникальный индекс тоже их не пропустит, но
    # ошибка SQLite ничего не скажет о том, какая именно строка задвоена.
    ключи = [(г.project_id, г.object_id) for г in body.grants]
    if len(set(ключи)) != len(ключи):
        raise HTTPException(status_code=400, detail="В наборе есть повторяющиеся уровни доступа")

    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        for грант in body.grants:
            if грант.project_id is not None and conn.execute(
                    "SELECT 1 FROM projects WHERE id = ?", (грант.project_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Проект не найден")
            if грант.object_id is not None:
                obj = conn.execute(
                    "SELECT project_id FROM objects WHERE id = ?", (грант.object_id,)).fetchone()
                if obj is None:
                    raise HTTPException(status_code=404, detail="Объект не найден")
                # Иначе грант «объект A в проекте B» пережил бы перенос объекта
                # и молча перестал действовать — искать такую причину долго.
                if obj["project_id"] != грант.project_id:
                    raise HTTPException(
                        status_code=400, detail="Объект не принадлежит выбранному проекту")
        было = conn.execute(
            "SELECT COUNT(*) AS n FROM user_access WHERE user_id = ?", (user_id,)).fetchone()["n"]
        conn.execute("DELETE FROM user_access WHERE user_id = ?", (user_id,))
        for грант in body.grants:
            conn.execute(
                "INSERT INTO user_access (user_id, project_id, object_id, role) VALUES (?, ?, ?, ?)",
                (user_id, грант.project_id, грант.object_id, грант.role),
            )
        conn.commit()
    finally:
        conn.close()
    activity.log("access_replace", user=admin, entity_type="user", entity_id=user_id,
                 old_value=f"грантов {было}", new_value=f"грантов {len(body.grants)}")
    return list_access(user_id, admin)
