"""Управление пользователями — доступно только администратору, кроме смены
собственного пароля (её может сделать любой залогиненный пользователь себе)."""

import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator

from app import activity, ldap_auth
from app.access import OBJECT_ROLES, ROLE_LABELS as OBJECT_ROLE_LABELS, require_system_admin
from app.auth import (
    SESSION_COOKIE, SESSION_IDLE_HOURS, SESSION_TTL_DAYS, auth_method_of, forget_session,
    format_display_name, get_current_user, hash_password, list_sessions, session_public_id,
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
    # По умолчанию ВКЛЮЧЕНО при заведении: пароль новому человеку задаёт
    # администратор, то есть пароль знают двое, и до первой смены он не
    # является личным (2026-08-03).
    must_change_password: bool = True


class UserUpdateIn(BaseModel):
    last_name: str
    first_name: str = ""
    patronymic: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    domain_login: str
    role: str
    auth_method: str = "local"
    # В ПРАВКЕ по умолчанию выключено: снимать требование, забыв поставить
    # галочку, опаснее, чем не поставить её на существующем пользователе.
    must_change_password: bool = False


class SetPasswordIn(BaseModel):
    password: str = ""  # пустая строка — сбросить в "пароль не задан"
    # Администратор задал пароль другому человеку — тот же случай, что и при
    # заведении: пароль знают двое. По умолчанию требуем смену.
    must_change_password: bool = True


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
                domain_login, role, auth_method, must_change_password)
            VALUES (:last_name, :first_name, :patronymic, :position, :department,
                :domain_login, :role, :auth_method, :must_change_password)
            """,
            {**body.model_dump(),
             # Доменной учётной записи требование смены бессмысленно: её
             # пароль живёт в домене (см. auth.must_change_password_of).
             "must_change_password": int(body.must_change_password
                                         and body.auth_method == "local")},
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM users WHERE domain_login = ?", (body.domain_login,)
        ).fetchone()
        activity.log("user_create", user=admin, entity_type="user", entity_id=row["id"],
                     new_value=f"{body.domain_login} ({body.role}, {body.auth_method})")
        return user_out(row)
    finally:
        conn.close()


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdateIn, request: Request,
                admin: sqlite3.Row = Depends(require_system_admin)):
    _validate_role(body.role)
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        было = auth_method_of(row)
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
                role=:role, auth_method=:auth_method,
                must_change_password=:must_change_password, updated_at=datetime('now')
            WHERE id=:id
            """,
            {**body.model_dump(), "id": user_id,
             "must_change_password": int(body.must_change_password
                                         and body.auth_method == "local")},
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
        if было != body.auth_method:
            # Сессии этого пользователя обесцениваются вместе со сменой
            # способа входа — по той же причине, по которой их сбрасывает
            # смена пароля (см. set_password ниже): способ входа меняют в
            # том числе потому, что заподозрили компрометацию, и оставленная
            # в чужом браузере cookie пережила бы «пароль сервиса больше не
            # действует» на все 30 дней жизни сессии.
            #
            # Сессия, которой ПРЯМО СЕЙЧАС пользуется вызывающий, исключается
            # — тот же приём и та же причина, что у set_password: администратор
            # вправе поменять способ входа и себе, и выкидывать его из системы
            # посреди настройки нельзя (тем более что доменная авторизация в
            # этот момент может быть настроена неверно, и войти заново было бы
            # нечем).
            текущий_токен = request.cookies.get(SESSION_COOKIE)
            if текущий_токен:
                conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?",
                             (user_id, текущий_токен))
            else:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            activity.log("user_auth_method", user=admin, entity_type="user",
                         entity_id=user_id, old_value=было, new_value=body.auth_method)
        conn.commit()
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        activity.log("user_update", user=admin, entity_type="user", entity_id=user_id,
                     old_value=f"{row['last_name']} {row['first_name']} ({row['role']}, {row['domain_login']})",
                     new_value=f"{body.last_name} {body.first_name} ({body.role}, {body.domain_login})")
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

        # Требование сменить пароль ставится только вместе с НЕПУСТЫМ
        # паролем: у заблокированной учётной записи (пароль снят) менять
        # нечего, и поднятый признак просто мешал бы её потом оживить.
        требовать = int(bool(body.must_change_password) and body.password != "")
        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ?, "
            "must_change_password = ?, updated_at = datetime('now') WHERE id = ?",
            (password_hash, password_salt, требовать, user_id),
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
        # Сам пароль в журнал, разумеется, не попадает — только факт смены,
        # кто менял и кому. Именно это спрашивает служба ИБ, разбирая
        # инцидент; до 2026-08-03 не писалось ничего.
        activity.log("user_password", user=current, entity_type="user", entity_id=user_id,
                     new_value=("снят (вход по паролю запрещён)" if not body.password else "изменён"),
                     details={"себе": current["id"] == user_id})
        return user_out(updated)
    finally:
        conn.close()


# Сеансы ВСЕХ пользователей — отдельным пунктом «Администрирование →
# Сеансы» (2026-08-03, живой запрос). Свой роутер без префикса `/users`:
# это не операция над конкретным пользователем, а взгляд на систему целиком
# («кто сейчас в сервисе»), и прятать его под /users/... значило бы
# спорить с адресом ради экономии одного объекта.
sessions_router = APIRouter(tags=["sessions"])


@sessions_router.get("/sessions")
def all_sessions(request: Request, admin: sqlite3.Row = Depends(require_system_admin)):
    """Кто сейчас в системе. Текущий сеанс администратора помечен — чтобы
    он не оборвал сам себя, не поняв этого."""
    текущий = request.cookies.get(SESSION_COOKIE)
    conn = get_connection()
    try:
        строки = conn.execute(
            "SELECT s.token, s.created_at, s.expires_at, s.created_ip, s.user_agent, "
            "s.last_seen_at, u.id AS user_id, u.last_name, u.first_name, u.patronymic, "
            "u.domain_login FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.expires_at > datetime('now') "
            "ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC"
        ).fetchall()
        return {"sessions": [{
            "id": session_public_id(r["token"]),
            "current": текущий is not None and r["token"] == текущий,
            "user_id": r["user_id"],
            "user": format_display_name(r) or r["domain_login"],
            "domain_login": r["domain_login"],
            "created_at": r["created_at"],
            "last_seen_at": r["last_seen_at"],
            "expires_at": r["expires_at"],
            "ip": r["created_ip"],
            "user_agent": r["user_agent"],
        } for r in строки], "idle_hours": SESSION_IDLE_HOURS, "ttl_days": SESSION_TTL_DAYS}
    finally:
        conn.close()


@sessions_router.delete("/sessions/{public_id}")
def drop_any_session(public_id: str, admin: sqlite3.Row = Depends(require_system_admin)):
    """Оборвать ОДИН любой сеанс по отпечатку.

    Раньше администратору был доступен только обрыв всех сеансов человека —
    рассудили, что выбирать между чужими вкладками не по чему. Живой запрос
    показал обратное: в списке видно устройство, адрес и время, и «вот этот
    вход с незнакомого адреса» — ровно то, что хочется закрыть, не выгоняя
    человека из его рабочего сеанса.
    """
    conn = get_connection()
    try:
        for r in conn.execute("SELECT token, user_id FROM sessions"):
            if session_public_id(r["token"]) == public_id:
                conn.execute("DELETE FROM sessions WHERE token = ?", (r["token"],))
                conn.commit()
                forget_session(r["token"])
                activity.log("session_revoked", user=admin, entity_type="user",
                             entity_id=r["user_id"], new_value="администратор оборвал сеанс")
                return {"status": "ok"}
    finally:
        conn.close()
    raise HTTPException(status_code=404, detail="Сеанс не найден — возможно, он уже завершён")


@sessions_router.post("/sessions/close-others")
def close_all_other_sessions(request: Request,
                             admin: sqlite3.Row = Depends(require_system_admin)):
    """Оборвать ВСЕ сеансы всех пользователей, кроме своего текущего. То, что
    делают при подозрении на компрометацию: одним действием все входят
    заново."""
    текущий = request.cookies.get(SESSION_COOKIE)
    conn = get_connection()
    try:
        if текущий:
            удалено = conn.execute("DELETE FROM sessions WHERE token != ?", (текущий,)).rowcount
        else:
            удалено = conn.execute("DELETE FROM sessions").rowcount
        conn.commit()
    finally:
        conn.close()
    activity.log("session_revoked", user=admin,
                 new_value=f"администратор завершил все сеансы, кроме своего: {удалено}")
    return {"closed": удалено}


@router.get("/{user_id}/sessions")
def user_sessions(user_id: int, admin: sqlite3.Row = Depends(require_system_admin)):
    """Активные сеансы ЛЮБОГО пользователя — для администратора сервиса.
    Свои сеансы человек смотрит сам через `GET /me/sessions`."""
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        # current_token=None: администратор смотрит ЧУЖИЕ сеансы, среди них
        # его текущего быть не может, и помечать нечего.
        return {"sessions": list_sessions(conn, user_id, None)}
    finally:
        conn.close()


@router.delete("/{user_id}/sessions")
def close_user_sessions(user_id: int, admin: sqlite3.Row = Depends(require_system_admin)):
    """Оборвать ВСЕ сеансы пользователя — то, что делают, когда человек
    уволился или потерял ноутбук. Пароль при этом не трогается: учётную
    запись может понадобиться сохранить рабочей."""
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        удалено = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
        conn.commit()
    finally:
        conn.close()
    activity.log("session_revoked", user=admin, entity_type="user", entity_id=user_id,
                 new_value=f"администратор завершил сеансов: {удалено}")
    return {"closed": удалено}


@router.patch("/{user_id}/label-color", response_model=UserOut)
def set_label_color(
    user_id: int, body: SetLabelColorIn, current: sqlite3.Row = Depends(require_system_admin)
):
    """Цвет подписей марок — настройка АДМИНИСТРАТОРА СЕРВИСА (2026-08-04,
    решение пользователя), как и цвета статусов.

    Хранится по-прежнему за пользователем (`users.label_color`): цвет
    применяется в его собственном виде схемы, и общей записи для него нет.
    Изменилось только то, КТО его задаёт — до этого настройка была
    самообслуживанием и менялась каждым себе.
    """
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
        activity.log("user_label_color", user=current, entity_type="user", entity_id=user_id,
                     new_value=body.label_color or "по умолчанию")
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
        activity.log("user_ui_theme", user=current, entity_type="user", entity_id=user_id,
                     new_value=body.ui_theme or "по умолчанию")
        return user_out(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    finally:
        conn.close()


class SetView3dIn(BaseModel):
    """Начальный ракурс 3D (2026-08-03, живой запрос).

    pitch — подъём камеры над горизонтом: 90° это взгляд строго сверху (вид
    плана), 0° — с уровня земли. yaw — поворот вокруг объекта, ноль отсчитан
    от вида, где числовые оси стоят вертикально, а буквенные горизонтально
    (то есть от привычного вида плана); положительный угол — по часовой
    стрелке, если смотреть на план сверху, отрицательный — против."""
    view3d_pitch_deg: float
    view3d_yaw_deg: float


# Границы подъёма. Верхняя — 89, а не 90: строго сверху азимут вырождается
# (камера ровно над целью), и поворот молча перестал бы что-либо значить.
# Нижняя — 1: с нуля камера оказывается внутри перекрытий первого яруса.
VIEW3D_PITCH_MIN, VIEW3D_PITCH_MAX = 1.0, 89.0


@router.patch("/{user_id}/view3d", response_model=UserOut)
def set_view3d(
    user_id: int, body: SetView3dIn, current: sqlite3.Row = Depends(get_current_user)
):
    """Тот же guard самообслуживания, что у set_ui_theme и set_label_color:
    менять можно только себе, если ты не администратор сервиса."""
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только свой ракурс")
    if not VIEW3D_PITCH_MIN <= body.view3d_pitch_deg <= VIEW3D_PITCH_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"Подъём камеры — от {VIEW3D_PITCH_MIN:g}° до {VIEW3D_PITCH_MAX:g}°",
        )
    # Поворот замыкается по кругу, поэтому не отвергается, а приводится к
    # (−180; 180]: «330°» и «−30°» — один и тот же ракурс, и отказывать в
    # первом было бы придиркой.
    yaw = (body.view3d_yaw_deg + 180) % 360 - 180
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        conn.execute(
            "UPDATE users SET view3d_pitch_deg = ?, view3d_yaw_deg = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (body.view3d_pitch_deg, yaw, user_id),
        )
        conn.commit()
        activity.log("user_view3d", user=current, entity_type="user", entity_id=user_id,
                     new_value=f"подъём {body.view3d_pitch_deg:g}°, поворот {yaw:g}°")
        return user_out(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
    finally:
        conn.close()


class SetMinLabelPxIn(BaseModel):
    """Порог читаемости подписей в пикселях (2026-08-04, живой запрос).
    Подпись мельче порога не рисуется вовсе — ни на схеме, ни в 3D."""
    min_label_px: float


# Границы порога. Нижняя — 4: ниже подпись перестаёт быть подписью, а
# нулевой порог возвращает ровно то состояние, из-за которого его и вводили
# (тысячи нечитаемых наклеек кадром и поверх чертежа). Верхняя — 40: выше
# подписи исчезают уже и на рабочем масштабе, и настройка читается как
# «подписи сломались».
MIN_LABEL_PX_MIN, MIN_LABEL_PX_MAX = 4.0, 40.0


@router.patch("/{user_id}/min-label-px", response_model=UserOut)
def set_min_label_px(
    user_id: int, body: SetMinLabelPxIn, current: sqlite3.Row = Depends(get_current_user)
):
    """Тот же guard самообслуживания, что у set_ui_theme и set_view3d:
    менять можно только себе, если ты не администратор сервиса. Настройка
    именно личная — она про экран и мощность машины конкретного человека, а
    не про данные объекта."""
    if current["role"] != "admin" and current["id"] != user_id:
        raise HTTPException(status_code=403, detail="Можно менять только свою настройку")
    if not MIN_LABEL_PX_MIN <= body.min_label_px <= MIN_LABEL_PX_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"Порог показа подписей — от {MIN_LABEL_PX_MIN:g} до {MIN_LABEL_PX_MAX:g} пикселей",
        )
    conn = get_connection()
    try:
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        conn.execute(
            "UPDATE users SET min_label_px = ?, updated_at = datetime('now') WHERE id = ?",
            (body.min_label_px, user_id),
        )
        conn.commit()
        activity.log("user_min_label_px", user=current, entity_type="user", entity_id=user_id,
                     new_value=f"{body.min_label_px:g} px")
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
