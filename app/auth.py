"""
Аутентификация по логину/паролю с серверной сессией (httponly-cookie).
Пароль хранится как PBKDF2-HMAC-SHA256 хэш с индивидуальной солью — без
внешних зависимостей (hashlib из стандартной библиотеки достаточно для
внутреннего инструмента такого масштаба). password_hash IS NULL означает
"пароль не задан" — вход в систему для такого пользователя ЗАПРЕЩЁН (см.
verify_password), а не разрешён с пустым паролем, как было раньше: пустой
пароль был бы дырой в открытом интернете (см. Docs/backlog.md, аудит
безопасности). Единственный способ ожить такому аккаунту — админ
задаёт пароль через UI, либо (если админов не осталось) —
scripts/reset_password.py напрямую в БД.
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

from app import activity
from app.db import get_connection

SESSION_COOKIE = "zhbi_session"
SESSION_TTL_DAYS = 30
PBKDF2_ITERATIONS = 260_000

# Минимальные требования к сложности пароля — проверяются при установке/смене
# (POST /users/{id}/set-password и scripts/reset_password.py), НЕ при входе:
# на существующие хэши задним числом не действуют, иначе пользователи с уже
# заданным паролем короче MIN_PASSWORD_LENGTH оказались бы заперты снаружи.
MIN_PASSWORD_LENGTH = 8

# По умолчанию выключено — деплой сейчас на чистом HTTP внутри локальной
# сети (см. Docs/DEPLOYMENT_WINDOWS.md, там нигде нет TLS/reverse-proxy),
# secure=True безусловно сломал бы вход. Включить переменной окружения
# ZHBI_SECURE_COOKIES=1, если/когда появится HTTPS.
SECURE_COOKIES = os.environ.get("ZHBI_SECURE_COOKIES") == "1"

# По умолчанию выключено. Если сервер стоит НАПРЯМУЮ (как сейчас, см.
# DEPLOYMENT_WINDOWS.md) — request.client.host уже настоящий IP клиента,
# доверять заголовку X-Forwarded-For НЕЛЬЗЯ: любой клиент сам его
# подставляет и тривиально обходит rate-limit (или запирает чужой IP).
# Включать ТОЛЬКО если перед сервером реально стоит доверенный
# reverse-proxy (nginx/Caddy и т.п.), который сам перезаписывает этот
# заголовок настоящим адресом клиента — тогда request.client.host видел
# бы адрес самого прокси, и блокировка по IP иначе била бы по ВСЕМ
# пользователям сразу после 5 неудачных попыток КОГО УГОДНО.
TRUST_PROXY_HEADERS = os.environ.get("ZHBI_TRUST_PROXY_HEADERS") == "1"

# Список пользователей на экране входа (выпадающий список вместо ручного
# ввода логина). ВКЛЮЧЁН по умолчанию — по явному решению пользователя
# (2026-07-29): сервис работает внутри корпоративного контура и наружу не
# смотрит, а ручной ввод логина на практике оказался источником неудачных
# входов (логин в БД может отличаться от того, что человек помнит).
#
# Это осознанный компромисс, а не недосмотр: эндпоинт раскрывает список
# валидных логинов и ФИО НЕаутентифицированному клиенту, то есть снимает с
# атакующего половину работы (остаётся подобрать только пароль). Ровно по
# этой причине он был удалён при аудите безопасности 2026-07-23 и сейчас
# возвращается уже под флагом. **Если сервис когда-нибудь станет доступен
# извне — выставить ZHBI_PUBLIC_LOGIN_LIST=0.** Форма входа при
# выключенном флаге сама откатывается на обычное текстовое поле, так что
# выключение ничего не ломает.
PUBLIC_LOGIN_LIST = os.environ.get("ZHBI_PUBLIC_LOGIN_LIST", "1") == "1"

router = APIRouter()

# Блокировка подбора пароля — по IP клиента, не по логину: блокировка по
# логину позволила бы атакующему намеренно запереть чужого пользователя,
# зная только его логин (а логин угадать/перебрать несравнимо проще, чем
# пароль). In-memory (один процесс uvicorn, без внешнего кэша).
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5
_login_attempts: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # Самый левый адрес — тот, кто ПЕРВЫМ отправил запрос (каждый
            # промежуточный прокси добавляет свой адрес В КОНЕЦ списка).
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _log_login(action: str, client_ip: str, user: Optional[sqlite3.Row] = None,
               login: Optional[str] = None, detail: Optional[str] = None) -> None:
    """Событие входа в журнал действий (аудит безопасности 2026-08-03).

    До этого журналировались ТОЛЬКО неудачные ДОМЕННЫЕ попытки: успешных
    входов, неудачных локальных и выходов не было вовсе, а IP-адреса не
    было ни у одного события. Расследовать инцидент («кто заходил под этой
    учётной записью и откуда») было нечем — а это первое, что спросит
    служба ИБ.

    IP кладётся в `details` (произвольный JSON), а не в отдельную колонку:
    колонку пришлось бы добавлять миграцией всей таблице ради полей,
    осмысленных только у четырёх видов событий. Поиск по адресу — обычным
    LIKE по details.

    `login` для неизвестной учётной записи пишется в user_name: иначе
    попытки подбора несуществующих логинов не отличить друг от друга.
    """
    activity.log(
        action,
        user=user,
        user_name=None if user is not None else (login or "неизвестный"),
        entity_type="user",
        entity_id=user["id"] if user is not None else None,
        new_value=detail,
        details={"ip": client_ip},
    )


def _check_login_rate_limit(client_ip: str) -> None:
    now = time.time()
    attempts = [t for t in _login_attempts.get(client_ip, []) if now - t < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
    _login_attempts[client_ip] = attempts
    if len(attempts) >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
        # Срабатывание блокировки — это уже не «человек ошибся паролем», а
        # признак подбора; в журнале оно нужно отдельным событием.
        _log_login("login_blocked", client_ip,
                   detail=f"{len(attempts)} неудачных попыток за {LOGIN_RATE_LIMIT_WINDOW_SECONDS} с")
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
        # Пароль не задан (или явно снят админом) — вход запрещён, а не
        # разрешён с пустой строкой (см. модуль docstring).
        return False
    if password_salt is None:
        return False
    derived, _ = hash_password(password, password_salt)
    return secrets.compare_digest(derived, password_hash)


def validate_password_strength(password: str) -> None:
    """Требования к новому/меняемому паролю. Вызывается ДО hash_password в
    местах, где пароль реально становится непустым (не в момент входа —
    verify_password существующие хэши не проверяет на соответствие этим
    правилам задним числом). Raises ValueError с русским текстом для
    прямого показа пользователю."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Пароль должен быть не короче {MIN_PASSWORD_LENGTH} символов")
    has_letter = any(ch.isalpha() for ch in password)
    has_digit = any(ch.isdigit() for ch in password)
    if not (has_letter and has_digit):
        raise ValueError("Пароль должен содержать и буквы, и цифры")


def auth_method_of(user: sqlite3.Row) -> str:
    """'local' (пароль сервиса) или 'domain' (доменная учётная запись).

    Через .keys(), как и ui_theme рядом: колонка добавляется миграцией, а
    строка пользователя приходит и из мест, где выборка сделана до неё (тот
    же приём уже применён для ui_theme). Неизвестное значение трактуется как
    'local' — способ входа не должен зависеть от опечатки в данных."""
    if "auth_method" not in user.keys():
        return "local"
    return "domain" if user["auth_method"] == "domain" else "local"


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


# require_roles/require_admin/require_editor УДАЛЕНЫ 2026-08-02.
#
# Они проверяли СИСТЕМНУЮ роль (users.role) там, где решение принадлежит
# объекту, и объект не проверяли вовсе. На живом сервере это замерено:
# пользователь с системной ролью `user` и без единого гранта менял статус
# элемента ЧУЖОГО объекта, а прораб с грантом `user` НА объекте получал
# 403 — одна и та же проверка была и дырой, и помехой.
#
# Замена — зависимости из app/access.py: require_system_admin (ведение
# сервиса), require_object_access/require_object_editor/require_object_admin
# (объект приходит параметром) и _guard_elements/_guard_source_file в
# app/main.py там, где объект ВЫВОДИТСЯ из сущности.
#
# Удалены, а не оставлены «на всякий случай», намеренно: пока функция
# существует, ею кто-нибудь закроет следующий эндпоинт — и дыра вернётся
# в новом месте, где её никто не ищет.


class LoginRequest(BaseModel):
    domain_login: str
    password: str = ""


class PublicUserOut(BaseModel):
    domain_login: str
    display_name: str


@router.get("/login-users", response_model=list[PublicUserOut])
def login_users():
    """Список для выпадающего списка на экране входа. Публичный по
    необходимости — форма входа обращается к нему ДО того, как появится
    сессия. Отдаёт только логин и ФИО: ни ролей, ни признака наличия
    пароля, ни любых других сведений, которые помогли бы выбрать цель.

    Управляется флагом PUBLIC_LOGIN_LIST (см. его комментарий выше о том,
    когда это надо выключать). При выключенном флаге — 404, и форма входа
    молча возвращается к текстовому полю."""
    if not PUBLIC_LOGIN_LIST:
        raise HTTPException(status_code=404, detail="Список пользователей отключён")
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY last_name, first_name").fetchall()
        return [PublicUserOut(domain_login=r["domain_login"], display_name=format_display_name(r)) for r in rows]
    finally:
        conn.close()


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
    # Чем проверяется вход: 'local' — пароль сервиса, 'domain' — доменная
    # учётная запись (LDAP-bind, см. app/ldap_auth.py).
    auth_method: str = "local"
    # Персональная цветовая гамма интерфейса (2026-08-02). NULL = базовое
    # оформление. Хранится на сервере, а не в браузере: настройка следует за
    # человеком — на площадке за одной машиной работают посменно.
    ui_theme: Optional[str] = None


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
        auth_method=auth_method_of(user),
        ui_theme=user["ui_theme"] if "ui_theme" in user.keys() else None,
    )


@router.post("/login", response_model=UserOut)
def login(body: LoginRequest, request: Request, response: Response):
    client_ip = _client_ip(request)
    _check_login_rate_limit(client_ip)

    # Импорт здесь, а не наверху файла: app/ldap_auth.py сам импортирует
    # app.auth (PUBLIC_LOGIN_LIST — один флаг на обе подробности о входе),
    # и на уровне модуля это был бы цикл.
    from app import ldap_auth

    conn = get_connection()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE domain_login = ?", (body.domain_login,)
        ).fetchone()
        if user is None:
            # Несуществующий логин отвечает ровно так же, как неверный
            # пароль, и НЕ уходит в домен: иначе перебор логинов на нашей
            # форме превратился бы в перебор по чужому каталогу.
            _record_login_failure(client_ip)
            _log_login("login_failed", client_ip, login=body.domain_login,
                       detail="учётной записи с таким логином нет")
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")

        # Способ проверки — свойство учётной записи, а не глобальный режим:
        # доменный пароль НИКОГДА не проверяется локальным хэшем и наоборот
        # (см. app/ldap_auth.py о том, почему нет отката с одного на другой).
        if auth_method_of(user) == "domain":
            try:
                ldap_auth.authenticate(conn, body.domain_login, body.password)
            except ldap_auth.DomainAuthError as e:
                _record_login_failure(client_ip)
                # Причина отказа домена уходит в журнал действий целиком, а
                # человеку показывается ровно столько, сколько разрешает
                # PUBLIC_LOGIN_LIST (см. DomainAuthError.login_message).
                _log_login("login_domain_failed", client_ip, user=user,
                           detail=f"{e.code}: {e.detail}")
                raise HTTPException(status_code=401, detail=e.login_message)
        elif not verify_password(body.password, user["password_hash"], user["password_salt"]):
            _record_login_failure(client_ip)
            _log_login("login_failed", client_ip, user=user,
                       detail="неверный пароль сервиса"
                               if user["password_hash"] is not None else "пароль не задан, вход запрещён")
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")

        token = create_session(conn, user["id"])
        _login_attempts.pop(client_ip, None)
        _log_login("login", client_ip, user=user, detail=auth_method_of(user))
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
            вышел = get_user_by_session(conn, token)
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
            if вышел is not None:
                _log_login("logout", _client_ip(request), user=вышел)
        finally:
            conn.close()
    response.delete_cookie(SESSION_COOKIE)
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(user: sqlite3.Row = Depends(get_current_user)):
    return user_out(user)
