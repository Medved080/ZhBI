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

# Блокировка подбора пароля. In-memory (один процесс uvicorn, без внешнего
# кэша), окно — скользящее.
#
# ПОЧЕМУ НЕ ПРОСТО «ПО IP», как было до 2026-08-03. Счётчик по одному лишь
# адресу писался, когда пользователей было трое и каждый сидел за своим
# компьютером. При массовом использовании клиенты выходят через
# корпоративный NAT, и сервер видит ОДИН адрес на весь офис: пятеро
# опечатались — вход закрыт всем, включая тех, кто вводит правильно. То
# есть защита от подбора превращалась в отказ в обслуживании по расписанию
# рабочего дня.
#
# ПОЧЕМУ НЕ «ПО ЛОГИНУ» — довод исходного комментария остаётся верным:
# блокировка учётной записи позволяет запереть чужого человека, зная только
# его логин, а логин перебрать несравнимо проще пароля.
#
# Поэтому счётчиков ДВА, с разным смыслом:
#   * (логин, адрес) — «человек ошибается»: 5 попыток за 5 минут. Точный
#     счётчик, соседей по офису не задевает вовсе;
#   * адрес — «одна машина молотит по многим учётным записям»: порог
#     заметно выше (50), чтобы на него не наткнулся живой офис, но перебор
#     словаря логинов упёрся в него быстро.
# Учётная запись как таковая НЕ блокируется никогда — подозрительная
# активность по ней только пишется в журнал (см. _note_login_bruteforce):
# запись в журнале атакующему бесполезна, а блокировка была бы подарком.
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = int(os.environ.get("ZHBI_LOGIN_ATTEMPTS", "5"))
LOGIN_RATE_LIMIT_MAX_PER_IP = int(os.environ.get("ZHBI_LOGIN_ATTEMPTS_PER_IP", "50"))
# Сколько неудач по ОДНОЙ учётной записи (с любых адресов) считать поводом
# для записи в журнал. Не блокировка — сигнал службе безопасности.
LOGIN_SUSPICIOUS_PER_ACCOUNT = int(os.environ.get("ZHBI_LOGIN_SUSPICIOUS", "20"))

# Ключ → отметки времени неудач. Ключи трёх видов: ("pair", логин, адрес),
# ("ip", адрес), ("login", логин).
_login_attempts: dict[tuple, list[float]] = {}
# Пары «логин+адрес» разнообразны (перебор логинов плодит новый ключ на
# каждую попытку), и без уборки словарь растёт до конца жизни процесса.
# Убираем не на каждый запрос, а раз в минуту — на входе в систему это
# незаметно, а обход словаря на каждую попытку при массовом использовании
# сам стал бы нагрузкой.
_login_attempts_pruned_at = 0.0
LOGIN_PRUNE_INTERVAL_SECONDS = 60


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


def _recent(key: tuple, now: float) -> list:
    """Отметки неудач по ключу внутри окна. Побочно подчищает сам ключ."""
    отметки = [t for t in _login_attempts.get(key, []) if now - t < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
    if отметки:
        _login_attempts[key] = отметки
    else:
        _login_attempts.pop(key, None)
    return отметки


def _prune_login_attempts(now: float) -> None:
    global _login_attempts_pruned_at
    if now - _login_attempts_pruned_at < LOGIN_PRUNE_INTERVAL_SECONDS:
        return
    _login_attempts_pruned_at = now
    протухшие = [k for k, v in _login_attempts.items()
                 if not v or now - max(v) >= LOGIN_RATE_LIMIT_WINDOW_SECONDS]
    for k in протухшие:
        _login_attempts.pop(k, None)


def _check_login_rate_limit(client_ip: str, login: str) -> None:
    now = time.time()
    _prune_login_attempts(now)

    пара = _recent(("pair", login, client_ip), now)
    if len(пара) >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
        _log_login("login_blocked", client_ip, login=login,
                   detail=f"{len(пара)} неудачных попыток по этой учётной записи "
                          f"с этого адреса за {LOGIN_RATE_LIMIT_WINDOW_SECONDS} с")
        raise HTTPException(status_code=429, detail="Слишком много попыток входа, попробуйте позже")

    адрес = _recent(("ip", client_ip), now)
    if len(адрес) >= LOGIN_RATE_LIMIT_MAX_PER_IP:
        # Порог широкой сети выбран так, чтобы живой офис за одним NAT его не
        # достал: 50 неудач за 5 минут — это уже не «все опечатались», а
        # перебор с одной машины.
        _log_login("login_blocked_ip", client_ip, login=login,
                   detail=f"{len(адрес)} неудачных попыток с адреса за "
                          f"{LOGIN_RATE_LIMIT_WINDOW_SECONDS} с (порог {LOGIN_RATE_LIMIT_MAX_PER_IP})")
        raise HTTPException(status_code=429, detail="Слишком много попыток входа, попробуйте позже")


def _record_login_failure(client_ip: str, login: str) -> None:
    now = time.time()
    for ключ in (("pair", login, client_ip), ("ip", client_ip), ("login", login)):
        _login_attempts.setdefault(ключ, []).append(now)
    # Много неудач по ОДНОЙ учётной записи с РАЗНЫХ адресов — признак того,
    # что подбирают именно её. Учётную запись не блокируем (это и был бы
    # способ запереть человека), но событие пишем: журнал — то место, где
    # такое замечают, и стоит оно ничего.
    попытки = _recent(("login", login), now)
    if len(попытки) == LOGIN_SUSPICIOUS_PER_ACCOUNT:
        _log_login("login_bruteforce_suspected", client_ip, login=login,
                   detail=f"{len(попытки)} неудачных попыток по учётной записи за "
                          f"{LOGIN_RATE_LIMIT_WINDOW_SECONDS} с; запись НЕ заблокирована")


def _reset_login_attempts(client_ip: str, login: str) -> None:
    """Успешный вход обнуляет счётчики САМОГО ВОШЕДШЕГО, но не широкую сеть
    по адресу: иначе атакующий, у которого есть одна своя учётная запись,
    сбрасывал бы себе ограничение каждым удачным входом."""
    _login_attempts.pop(("pair", login, client_ip), None)
    _login_attempts.pop(("login", login), None)


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


def must_change_password_of(user: sqlite3.Row) -> bool:
    """Требуется ли смена пароля. Для доменной учётной записи — НИКОГДА:
    её пароль живёт в домене, менять его нашей формой нечем, а поднятый
    признак запер бы человека в окне, которое ему нечем закрыть."""
    if "must_change_password" not in user.keys():
        return False
    return bool(user["must_change_password"]) and auth_method_of(user) == "local"


def changelog_unseen_of(user: sqlite3.Row) -> bool:
    """Есть ли в журнале «Что нового» запись, которую человек ещё не
    подтвердил кнопкой «Ознакомился» (2026-08-03, живой запрос).

    Сравнение делает СЕРВЕР, а клиенту отдаётся готовое «да/нет»: иначе при
    каждом входе пришлось бы тянуть весь журнал версий только чтобы узнать,
    показывать его или нет. Импорт локальный — app.changelog не должен
    затягиваться в модуль аутентификации на уровне файла."""
    from app.changelog import CHANGELOG

    if not CHANGELOG:
        return False
    if "changelog_ack_version" not in user.keys():
        return True
    return user["changelog_ack_version"] != CHANGELOG[0]["version"]


# Значения по умолчанию заданы пользователем (2026-08-03): подъём 30° над
# горизонтом, поворот −30° (против часовой стрелки). Держатся ЗДЕСЬ и
# дублируются в DEFAULT миграции — второе место нужно самой БД, но правда
# одна: при расхождении верен этот модуль, он же отвечает на /me.
DEFAULT_VIEW3D_PITCH = 30.0
DEFAULT_VIEW3D_YAW = -30.0


# Порог читаемости подписей в пикселях. 12 — значение, которое до
# 2026-08-04 было константой MIN_LABEL_READABLE_PX в app.js (сначала
# поставили 8, живой ответ пользователя: «появляются на нечитаемом
# расстоянии, порог раза в 1,5 больше»). Теперь это персональная настройка,
# а число здесь — её значение по умолчанию: экран, масштаб интерфейса, RDP
# и мощность машины у всех разные.
DEFAULT_MIN_LABEL_PX = 12.0


def min_label_px_of(user: sqlite3.Row) -> float:
    """Через .keys(), как view3d_angles_of рядом, — строка пользователя
    приходит и из выборок, сделанных до миграции."""
    value = user["min_label_px"] if "min_label_px" in user.keys() else None
    return DEFAULT_MIN_LABEL_PX if value is None else float(value)


def view3d_angles_of(user: sqlite3.Row) -> tuple:
    """Персональный начальный ракурс 3D: (подъём, поворот) в градусах.
    Через .keys(), как auth_method и ui_theme рядом, — строка пользователя
    приходит и из выборок, сделанных до миграции."""
    pitch = user["view3d_pitch_deg"] if "view3d_pitch_deg" in user.keys() else None
    yaw = user["view3d_yaw_deg"] if "view3d_yaw_deg" in user.keys() else None
    return (DEFAULT_VIEW3D_PITCH if pitch is None else float(pitch),
            DEFAULT_VIEW3D_YAW if yaw is None else float(yaw))


def format_display_name(user: sqlite3.Row) -> str:
    parts = [user["last_name"], user["first_name"], user["patronymic"]]
    return " ".join(p for p in parts if p)


# Уборка истёкших сессий. Не про безопасность (get_user_by_session и так не
# отдаёт просроченную строку), а про то, что таблица иначе растёт вечно:
# срок сессии 30 дней, и при массовом использовании это тысячи мёртвых строк
# на каждый месяц работы, которые никто никогда не удалял.
#
# По времени, а не на каждый вход: чистить на каждый вход значит платить
# DELETE-ом за каждое нажатие «Войти» ради строк, которые никому не мешают.
_sessions_pruned_at = 0.0
SESSION_PRUNE_INTERVAL_SECONDS = 3600


def prune_expired_sessions(conn: sqlite3.Connection, force: bool = False) -> int:
    """Удаляет просроченные сессии. Возвращает, сколько удалено."""
    global _sessions_pruned_at
    now = time.time()
    if not force and now - _sessions_pruned_at < SESSION_PRUNE_INTERVAL_SECONDS:
        return 0
    _sessions_pruned_at = now
    удалено = conn.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')").rowcount
    if удалено:
        conn.commit()
    return удалено


# Таймаут бездействия (2026-08-03). Абсолютный срок сеанса — 30 дней, и на
# площадке этого мало: оставленная в общем браузере вкладка живёт месяц.
# Считается по last_seen_at, который обновляется не чаще раза в минуту (см.
# touch_session) — иначе каждый запрос стоил бы записи в базу.
#
# 12 часов по умолчанию: смену это переживает (человек не выпадает из
# системы посреди рабочего дня), а вкладка, оставленная на ночь, умирает.
# Уменьшать — переменной окружения, если политика потребует строже.
SESSION_IDLE_HOURS = int(os.environ.get("ZHBI_SESSION_IDLE_HOURS", "12"))
SESSION_TOUCH_INTERVAL_SECONDS = 60
_session_touched: dict[str, float] = {}


def forget_session(token: str) -> None:
    """Забыть троттлинг отметки активности для оборванного сеанса: иначе
    словарь помнил бы токены, которых больше нет."""
    _session_touched.pop(token, None)


def session_public_id(token: str) -> str:
    """Короткий отпечаток сеанса для списка и обрыва.

    Сам токен клиенту не отдаётся НИКОГДА: показать список сеансов с их
    токенами значило бы раздать ключи от всех этих сеансов тому, кто просто
    открыл список. Отпечаток необратим, но постоянен — им можно указать,
    какой именно сеанс оборвать."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def create_session(conn: sqlite3.Connection, user_id: int, client_ip: Optional[str] = None,
                   user_agent: Optional[str] = None) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at, created_ip, user_agent, last_seen_at) "
        "VALUES (?, ?, ?, ?, ?, datetime('now'))",
        (token, user_id, expires_at, client_ip, (user_agent or "")[:300] or None),
    )
    conn.commit()
    return token


def touch_session(conn: sqlite3.Connection, token: str) -> None:
    """Отметить, что сеансом только что пользовались. Не чаще раза в минуту
    на сеанс: на это время опирается таймаут бездействия, и минутная
    точность для него избыточна, а запись в базу на КАЖДЫЙ запрос — нет."""
    now = time.time()
    if now - _session_touched.get(token, 0) < SESSION_TOUCH_INTERVAL_SECONDS:
        return
    _session_touched[token] = now
    conn.execute("UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?", (token,))
    conn.commit()


def get_user_by_session(conn: sqlite3.Connection, token: str) -> Optional[sqlite3.Row]:
    строка = conn.execute(
        "SELECT s.last_seen_at, s.created_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > datetime('now')",
        (token,),
    ).fetchone()
    if строка is None:
        return None
    if SESSION_IDLE_HOURS > 0:
        # Сессии, выданные до появления столбца, считаются от created_at:
        # иначе NULL пришлось бы трактовать как «бездействует вечно»
        # (выкинуть всех при обновлении) или «активна всегда» (не применить
        # таймаут вовсе). Дата создания — единственное, что о них известно.
        отметка = строка["last_seen_at"] or строка["created_at"]
        просрочен = conn.execute(
            "SELECT ? <= datetime('now', ?) AS истёк", (отметка, f"-{SESSION_IDLE_HOURS} hours")
        ).fetchone()["истёк"]
        if просрочен:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
            _session_touched.pop(token, None)
            return None
    touch_session(conn, token)
    return строка


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
    _guard_must_change_password(request, user)
    return user


# Что доступно, пока пароль не заменён. Всё остальное — 403.
#
# Проверка ЗДЕСЬ, а не только в интерфейсе: смысл требования в том, что
# заданный администратором пароль перестаёт работать как рабочий. Если бы
# окно смены можно было закрыть (или обойти прямым запросом к API), пароль,
# который знает ещё один человек, продолжал бы открывать доступ ко всему —
# то есть требование было бы украшением.
#
# get_current_user — единственное место, через которое проходят ВСЕ
# защищённые эндпоинты, поэтому список исключений один и короткий, и
# забыть закрыть новый эндпоинт невозможно.
_ALLOWED_WHILE_PASSWORD_EXPIRED = frozenset({
    "/me",                  # клиенту надо узнать, что от него хотят
    "/me/change-password",  # собственно смена
    "/logout",              # уйти всегда можно
})


def _guard_must_change_password(request: Request, user: sqlite3.Row) -> None:
    if not must_change_password_of(user):
        return
    if request.url.path in _ALLOWED_WHILE_PASSWORD_EXPIRED:
        return
    raise HTTPException(
        status_code=403,
        detail="Пароль задан администратором и должен быть заменён — смените пароль, "
               "чтобы продолжить работу",
    )


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
    # Пароль задан администратором и должен быть заменён при первом входе
    # (2026-08-03). Клиент по этому признаку показывает форму смены пароля,
    # сервер — не пускает никуда, кроме неё (см. get_current_user).
    must_change_password: bool = False
    # Персональная цветовая гамма интерфейса (2026-08-02). NULL = базовое
    # оформление. Хранится на сервере, а не в браузере: настройка следует за
    # человеком — на площадке за одной машиной работают посменно.
    ui_theme: Optional[str] = None
    # Есть ли в «Что нового» непрочитанная запись (2026-08-03). Считает
    # сервер (changelog_unseen_of): иначе клиент тянул бы весь журнал версий
    # при каждом входе только чтобы решить, показывать его или нет.
    changelog_unseen: bool = False
    # Персональный начальный ракурс 3D в градусах (2026-08-03).
    view3d_pitch_deg: float = DEFAULT_VIEW3D_PITCH
    view3d_yaw_deg: float = DEFAULT_VIEW3D_YAW
    # Персональный порог читаемости подписей в пикселях (2026-08-04).
    min_label_px: float = DEFAULT_MIN_LABEL_PX


def user_out(user: sqlite3.Row) -> UserOut:
    pitch, yaw = view3d_angles_of(user)
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
        must_change_password=must_change_password_of(user),
        ui_theme=user["ui_theme"] if "ui_theme" in user.keys() else None,
        changelog_unseen=changelog_unseen_of(user),
        view3d_pitch_deg=pitch,
        view3d_yaw_deg=yaw,
        min_label_px=min_label_px_of(user),
    )


@router.post("/login", response_model=UserOut)
def login(body: LoginRequest, request: Request, response: Response):
    client_ip = _client_ip(request)
    _check_login_rate_limit(client_ip, body.domain_login)

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
            _record_login_failure(client_ip, body.domain_login)
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
                _record_login_failure(client_ip, body.domain_login)
                # Причина отказа домена уходит в журнал действий целиком, а
                # человеку показывается ровно столько, сколько разрешает
                # PUBLIC_LOGIN_LIST (см. DomainAuthError.login_message).
                _log_login("login_domain_failed", client_ip, user=user,
                           detail=f"{e.code}: {e.detail}")
                raise HTTPException(status_code=401, detail=e.login_message)
        elif not verify_password(body.password, user["password_hash"], user["password_salt"]):
            _record_login_failure(client_ip, body.domain_login)
            _log_login("login_failed", client_ip, user=user,
                       detail="неверный пароль сервиса"
                               if user["password_hash"] is not None else "пароль не задан, вход запрещён")
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")

        token = create_session(conn, user["id"], client_ip,
                               request.headers.get("user-agent"))
        _reset_login_attempts(client_ip, body.domain_login)
        _log_login("login", client_ip, user=user, detail=auth_method_of(user))
        # Уборка привязана к входу, а не к отдельному расписанию: вход —
        # единственное частое событие, которое и так пишет в эту таблицу, а
        # сама уборка ограничена по времени изнутри (раз в час).
        убрано = prune_expired_sessions(conn)
        if убрано:
            activity.log("sessions_pruned", user=user, new_value=f"удалено истёкших сессий: {убрано}")
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


class ChangeOwnPasswordIn(BaseModel):
    current_password: str
    new_password: str


@router.post("/me/change-password", response_model=UserOut)
def change_own_password(body: ChangeOwnPasswordIn, request: Request,
                        user: sqlite3.Row = Depends(get_current_user)):
    """Смена СВОЕГО пароля с подтверждением ТЕКУЩЕГО.

    Отдельно от `POST /users/{id}/set-password`: та существует для
    администратора, задающего пароль другому человеку, и текущего пароля не
    спрашивает — у администратора его и нет. Здесь наоборот: человек меняет
    свой, и без проверки старого любая оставленная без присмотра вкладка
    позволяла бы посадить в учётную запись новый пароль и запереть в ней
    владельца.

    Работает и когда смена ТРЕБУЕТСЯ (must_change_password), и когда человек
    меняет пароль по своей воле — это одна и та же операция, и разводить её
    на две значило бы держать две проверки сложности и два места, где
    сбрасываются чужие сессии.
    """
    if auth_method_of(user) == "domain":
        raise HTTPException(
            status_code=409,
            detail="У вас доменная авторизация — пароль меняется в домене, а не здесь",
        )
    if not verify_password(body.current_password, user["password_hash"], user["password_salt"]):
        # Считаем как неудачную попытку входа: подбор старого пароля через
        # эту форму — такой же перебор, только из-под живой сессии.
        client_ip = _client_ip(request)
        _record_login_failure(client_ip, user["domain_login"])
        _log_login("password_change_failed", client_ip, user=user, detail="неверный текущий пароль")
        raise HTTPException(status_code=403, detail="Текущий пароль указан неверно")
    if body.new_password == body.current_password:
        raise HTTPException(status_code=422, detail="Новый пароль должен отличаться от текущего")
    try:
        validate_password_strength(body.new_password)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    password_hash, password_salt = hash_password(body.new_password)
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, "
            "updated_at = datetime('now') WHERE id = ?",
            (password_hash, password_salt, user["id"]),
        )
        # Прочие сессии этого человека обесцениваются — как и при смене
        # пароля администратором: пароль меняют в том числе потому, что его
        # кто-то знает. Своя сессия остаётся: иначе человек, которого
        # ЗАСТАВИЛИ сменить пароль, тут же оказывался бы на экране входа.
        текущий = request.cookies.get(SESSION_COOKIE)
        if текущий:
            conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?",
                         (user["id"], текущий))
        else:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
        conn.commit()
        обновлён = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    finally:
        conn.close()
    activity.log("password_changed", user=user, entity_type="user", entity_id=user["id"],
                 new_value="смена собственного пароля")
    return user_out(обновлён)


# ------------------------------------------------------ активные сеансы
#
# Зачем: до этого оборвать чужой сеанс можно было только косвенно — сменив
# пароль или способ входа. Человек уволился, ноутбук потерян, вкладка
# осталась в общем браузере на площадке — а cookie живёт до 30 дней.


def list_sessions(conn: sqlite3.Connection, user_id: int, current_token: Optional[str]) -> list[dict]:
    строки = conn.execute(
        "SELECT token, created_at, expires_at, created_ip, user_agent, last_seen_at "
        "FROM sessions WHERE user_id = ? AND expires_at > datetime('now') "
        "ORDER BY COALESCE(last_seen_at, created_at) DESC",
        (user_id,),
    ).fetchall()
    return [{
        "id": session_public_id(r["token"]),
        "current": current_token is not None and r["token"] == current_token,
        "created_at": r["created_at"],
        "last_seen_at": r["last_seen_at"],
        "expires_at": r["expires_at"],
        "ip": r["created_ip"],
        "user_agent": r["user_agent"],
    } for r in строки]


def _drop_session_by_public_id(conn: sqlite3.Connection, user_id: int, public_id: str) -> bool:
    """Обрыв по отпечатку. Перебор строк, а не WHERE по значению — отпечаток
    не хранится, он считается от токена; сеансов у человека единицы."""
    for r in conn.execute("SELECT token FROM sessions WHERE user_id = ?", (user_id,)):
        if session_public_id(r["token"]) == public_id:
            conn.execute("DELETE FROM sessions WHERE token = ?", (r["token"],))
            conn.commit()
            _session_touched.pop(r["token"], None)
            return True
    return False


@router.get("/me/sessions")
def my_sessions(request: Request, user: sqlite3.Row = Depends(get_current_user)):
    conn = get_connection()
    try:
        return {"sessions": list_sessions(conn, user["id"], request.cookies.get(SESSION_COOKIE)),
                "idle_hours": SESSION_IDLE_HOURS, "ttl_days": SESSION_TTL_DAYS}
    finally:
        conn.close()


@router.delete("/me/sessions/{public_id}")
def drop_my_session(public_id: str, request: Request,
                    user: sqlite3.Row = Depends(get_current_user)):
    """Оборвать свой сеанс, в том числе ТЕКУЩИЙ (это просто выход)."""
    conn = get_connection()
    try:
        if not _drop_session_by_public_id(conn, user["id"], public_id):
            raise HTTPException(status_code=404, detail="Сеанс не найден — возможно, он уже завершён")
    finally:
        conn.close()
    activity.log("session_revoked", user=user, entity_type="user", entity_id=user["id"],
                 new_value="свой сеанс")
    return {"status": "ok"}


@router.post("/me/sessions/close-others")
def close_other_sessions(request: Request, user: sqlite3.Row = Depends(get_current_user)):
    """«Завершить все, кроме текущего» — одно нажатие вместо перебора
    списка: именно это делают, заподозрив, что где-то остался чужой вход."""
    текущий = request.cookies.get(SESSION_COOKIE)
    conn = get_connection()
    try:
        if текущий:
            удалено = conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?",
                                   (user["id"], текущий)).rowcount
        else:
            удалено = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],)).rowcount
        conn.commit()
    finally:
        conn.close()
    activity.log("session_revoked", user=user, entity_type="user", entity_id=user["id"],
                 new_value=f"завершено чужих сеансов: {удалено}")
    return {"closed": удалено}


@router.get("/me", response_model=UserOut)
def me(user: sqlite3.Row = Depends(get_current_user)):
    return user_out(user)
