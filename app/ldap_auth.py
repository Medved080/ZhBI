"""
Доменная (корпоративная) авторизация — вход по учётной записи Active
Directory как АЛЬТЕРНАТИВА паролю сервиса.

Способ проверки — простой LDAP-bind ОТ ИМЕНИ САМОГО ВХОДЯЩЕГО: человек
вводит на обычной форме входа свой доменный логин и ДОМЕННЫЙ пароль,
сервер пробует привязаться этой парой к контроллеру домена. Служебная
учётная запись не нужна вовсе — а значит, сервису не нужно хранить ни
одного чужого секрета: пароль живёт только внутри одного запроса и
никуда не пишется (ни в БД, ни в журнал действий).

Что НЕ делается намеренно:
  * Пользователи из домена не заводятся автоматически (решение
    пользователя 2026-08-03). Войти может только тот, кого администратор
    уже завёл в «Администрирование → Пользователи»: доступ к объектам всё
    равно выдаётся руками грантами (app/access.py), так что автозаведённый
    человек ничего бы не увидел, зато список пользователей заполнился бы
    всем доменом.
  * Ничего не читается из каталога (ФИО, подразделение, группы) — ровно
    по той же причине: единственный вопрос к домену это «пароль верный?».
  * Kerberos/SSO не используется: он требует keytab, SPN и настройки
    браузеров политикой, то есть участия администраторов домена на каждом
    шаге. LDAP-bind работает при нынешней схеме развёртывания как есть.

Режим выбирается У КАЖДОГО ПОЛЬЗОВАТЕЛЯ (users.auth_method), а не глобально:
подрядчики и временные учётные записи домена не имеют, и они остаются на
пароле сервиса. Пробовать домен для всех подряд с откатом на локальный
пароль было бы хуже — каждая опечатка уходила бы в AD и приближала бы
блокировку доменной учётной записи политикой, а человек не понимал бы,
какой из двух паролей у него спросили.

ldap3 импортируется МЯГКО. Библиотека появилась в requirements.txt вместе
с этим модулем, но образ на сервере обновляется отдельно от базы, и старт
всего сервиса не должен падать из-за необязательной возможности: без
библиотеки доменный вход отвечает понятной ошибкой, остальное работает.
"""

import json
import re
import socket
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import activity
from app.access import require_system_admin
from app.auth import PUBLIC_LOGIN_LIST
from app.db import get_connection

try:  # см. про мягкий импорт в docstring модуля
    import ldap3
    from ldap3.core.exceptions import LDAPException
    LDAP3_IMPORT_ERROR: Optional[str] = None
except ImportError as e:  # pragma: no cover - зависит от окружения, не от кода
    ldap3 = None
    LDAPException = Exception
    LDAP3_IMPORT_ERROR = str(e)

router = APIRouter(tags=["ldap"])

# Настройка СИСТЕМНАЯ, не объектная: контроллер домена один на сервис, а не
# свой на каждую стройку. Поэтому она лежит в app_settings с object_id IS
# NULL и читается прямым SQL — get_setting/set_setting из app/settings.py
# требуют объект обязательным аргументом именно для того, чтобы объектную
# настройку нельзя было случайно записать «в никуда» (см. их docstring).
SETTINGS_KEY = "ldap_auth"

DEFAULT_CONFIG = {
    "enabled": False,
    "host": "",                 # dc01.corp.local — имя или адрес контроллера домена
    "port": 389,                # 389 обычный, 636 — LDAPS
    "use_ssl": False,           # ldaps:// — шифрование с первого байта
    "start_tls": False,         # обычное соединение с последующим STARTTLS
    "verify_certificate": True,  # проверять сертификат контроллера домена
    # Из логина сервиса строится имя для bind. Шаблон, а не отдельные поля
    # «домен»/«суффикс»: у AD принято минимум три записи одного и того же
    # («ivanov@corp.local», «CORP\ivanov», полный DN), какая именно принята
    # в конкретном домене — знает только его администратор.
    "login_template": "{login}@example.local",
    "timeout_seconds": 5,
}

# Подкоды Active Directory из текста ошибки bind: «... data 52e, v4563».
# Это единственный способ отличить «неверный пароль» от «пароль истёк» —
# сам код ошибки LDAP у всех этих случаев один и тот же (49,
# invalidCredentials).
_AD_SUBCODES = {
    "525": ("invalid_credentials", "Пользователь не найден в домене"),
    "52e": ("invalid_credentials", "Неверный доменный пароль"),
    "530": ("restricted", "Вход в это время суток запрещён политикой домена"),
    "531": ("restricted", "Вход с этого компьютера запрещён политикой домена"),
    "532": ("password_expired", "Срок действия доменного пароля истёк"),
    "533": ("account_disabled", "Доменная учётная запись отключена"),
    "701": ("account_expired", "Срок действия доменной учётной записи истёк"),
    "773": ("must_change_password", "Требуется сменить доменный пароль"),
    "775": ("locked", "Доменная учётная запись заблокирована"),
}

# Что показывать на ЭКРАНЕ ВХОДА. Подробная причина («учётная запись
# заблокирована», «пользователь не найден») подтверждает существование
# логина тому, кто его просто угадывал, — то же самое возражение, из-за
# которого список логинов живёт под флагом. Поэтому подробности показываются
# ровно тогда, когда список логинов и так открыт (ZHBI_PUBLIC_LOGIN_LIST=1,
# корпоративный контур), и скрываются вместе с ним. Администратору в форме
# проверки подключения подробности видны ВСЕГДА — он уже аутентифицирован.
_GENERIC_LOGIN_ERROR = "Неверный логин или пароль"


class DomainAuthError(Exception):
    """Отказ доменной проверки. code — машинный повод (см. _AD_SUBCODES и
    ветки _bind), detail — подробный русский текст для администратора,
    login_message — то, что не жалко показать на экране входа."""

    def __init__(self, code: str, detail: str, login_message: Optional[str] = None):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.login_message = login_message or (detail if PUBLIC_LOGIN_LIST else _GENERIC_LOGIN_ERROR)


# ---------------------------------------------------------------- конфигурация


def load_config(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ? AND object_id IS NULL", (SETTINGS_KEY,)
    ).fetchone()
    stored = {}
    if row and row["value"]:
        try:
            stored = json.loads(row["value"])
        except ValueError:
            stored = {}
    # Слияние с умолчаниями, а не подмена: настройка, сохранённая до
    # появления нового поля, не должна ронять вход отсутствующим ключом.
    return {k: stored.get(k, v) for k, v in DEFAULT_CONFIG.items()}


def save_config(conn: sqlite3.Connection, config: dict) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, object_id, value) VALUES (?, NULL, ?) "
        "ON CONFLICT(key, COALESCE(object_id, -1)) DO UPDATE SET value = excluded.value",
        (SETTINGS_KEY, json.dumps(config, ensure_ascii=False)),
    )


def is_enabled(conn: sqlite3.Connection) -> bool:
    return bool(load_config(conn).get("enabled"))


def validate_config(config: dict) -> None:
    """Проверки, без которых настройка молча не работала бы. Raises
    ValueError с русским текстом для прямого показа администратору."""
    if not config["enabled"]:
        return  # выключенную настройку можно держать недозаполненной
    if not (config.get("host") or "").strip():
        raise ValueError("Укажите адрес контроллера домена")
    template = config.get("login_template") or ""
    if "{login}" not in template:
        raise ValueError("Шаблон входа должен содержать {login} — на его место подставляется логин пользователя")
    try:
        port = int(config.get("port") or 0)
    except (TypeError, ValueError):
        raise ValueError("Порт должен быть числом")
    if not (1 <= port <= 65535):
        raise ValueError("Порт должен быть в диапазоне 1–65535")
    try:
        timeout = int(config.get("timeout_seconds") or 0)
    except (TypeError, ValueError):
        raise ValueError("Таймаут должен быть числом")
    if not (1 <= timeout <= 60):
        raise ValueError("Таймаут должен быть от 1 до 60 секунд")
    if config.get("use_ssl") and config.get("start_tls"):
        raise ValueError("LDAPS и STARTTLS взаимоисключающи — выберите что-то одно")


def bind_name(config: dict, login: str) -> str:
    return (config.get("login_template") or "{login}").replace("{login}", login)


# ------------------------------------------------------------------ проверка


def _subcode_error(message: str) -> DomainAuthError:
    match = re.search(r"data ([0-9a-fA-F]{3,4})", message or "")
    if match:
        code, detail = _AD_SUBCODES.get(match.group(1).lower(), ("invalid_credentials", ""))
        if detail:
            return DomainAuthError(code, detail)
    return DomainAuthError("invalid_credentials", "Неверный доменный логин или пароль")


def _bind(config: dict, login: str, password: str) -> None:
    """Одна попытка привязки. Возврат = успех, отказ = DomainAuthError."""
    if ldap3 is None:
        raise DomainAuthError(
            "no_library",
            f"На сервере не установлена библиотека ldap3 ({LDAP3_IMPORT_ERROR}). "
            "Обновите образ приложения — она указана в requirements.txt.",
            login_message="Доменная авторизация на сервере недоступна",
        )
    if not password:
        # Критично: LDAP-bind с ПУСТЫМ паролем — это «unauthenticated bind»,
        # и контроллер домена отвечает на него УСПЕХОМ (как на анонимный),
        # то есть без этой проверки пустой пароль пускал бы кого угодно под
        # любым доменным логином. Ровно тот же класс дыры, что закрывали в
        # 2026-07-23 у локальных паролей (password_hash IS NULL).
        raise DomainAuthError("invalid_credentials", "Доменный пароль не может быть пустым")

    tls = None
    if config.get("use_ssl") or config.get("start_tls"):
        import ssl
        tls = ldap3.Tls(
            validate=ssl.CERT_REQUIRED if config.get("verify_certificate") else ssl.CERT_NONE
        )

    timeout = int(config.get("timeout_seconds") or DEFAULT_CONFIG["timeout_seconds"])
    try:
        server = ldap3.Server(
            config["host"], port=int(config["port"]), use_ssl=bool(config.get("use_ssl")),
            tls=tls, get_info=ldap3.NONE, connect_timeout=timeout,
        )
        connection = ldap3.Connection(
            server, user=bind_name(config, login), password=password,
            authentication=ldap3.SIMPLE, raise_exceptions=False, receive_timeout=timeout,
        )
        if config.get("start_tls") and not connection.start_tls():
            raise DomainAuthError(
                "tls_failed",
                f"Не удалось включить STARTTLS: {connection.last_error}",
                login_message="Сервер домена недоступен",
            )
        ok = connection.bind()
    except (LDAPException, socket.error, OSError) as e:
        # Недоступный контроллер домена — это НЕ «неверный пароль»: сказать
        # так значило бы отправить человека менять правильный пароль, а
        # администратора — искать проблему не там.
        raise DomainAuthError(
            "unavailable",
            f"Контроллер домена {config.get('host')}:{config.get('port')} недоступен ({e})",
            login_message="Сервер домена недоступен, попробуйте позже",
        )

    if not ok:
        result = connection.result or {}
        raise _subcode_error(f"{result.get('message', '')} {result.get('description', '')}")

    try:
        connection.unbind()
    except LDAPException:
        pass  # соединение уже своё дело сделало, ошибка закрытия ни на что не влияет


def authenticate(conn: sqlite3.Connection, login: str, password: str) -> None:
    """Проверка доменной учётной записи по СОХРАНЁННОЙ настройке."""
    config = load_config(conn)
    if not config.get("enabled"):
        raise DomainAuthError(
            "disabled",
            "Доменная авторизация выключена в настройках сервиса",
            login_message="Доменная авторизация не настроена, обратитесь к администратору",
        )
    _bind(config, login, password)


# -------------------------------------------------------------------- роуты


class LdapConfigIn(BaseModel):
    enabled: bool = False
    host: str = ""
    port: int = 389
    use_ssl: bool = False
    start_tls: bool = False
    verify_certificate: bool = True
    login_template: str = DEFAULT_CONFIG["login_template"]
    timeout_seconds: int = 5


class LdapTestIn(BaseModel):
    # Логин и пароль ПРОВЕРЯЮЩЕГО — обычно администратор проверяет своей же
    # доменной учётной записью. Ни то, ни другое не сохраняется.
    login: str
    password: str
    # Настройка передаётся вместе с проверкой, чтобы можно было проверить
    # ДО сохранения: иначе единственным способом узнать, правильно ли
    # заполнены поля, было бы записать заведомо неизвестное в рабочую
    # настройку и выгнать доменных пользователей на время проверки.
    config: Optional[LdapConfigIn] = None


def _domain_user_count(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM users WHERE auth_method = 'domain'"
    ).fetchone()["n"]


@router.get("/ldap-settings")
def read_ldap_settings(admin: sqlite3.Row = Depends(require_system_admin)):
    conn = get_connection()
    try:
        return {
            "config": load_config(conn),
            "domain_users": _domain_user_count(conn),
            "library_available": ldap3 is not None,
            "library_error": LDAP3_IMPORT_ERROR,
        }
    finally:
        conn.close()


@router.put("/ldap-settings")
def write_ldap_settings(body: LdapConfigIn, admin: sqlite3.Row = Depends(require_system_admin)):
    config = body.model_dump()
    try:
        validate_config(config)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    conn = get_connection()
    try:
        было = load_config(conn)
        save_config(conn, config)
        conn.commit()
        users = _domain_user_count(conn)
    finally:
        conn.close()
    activity.log("ldap_settings", user=admin,
                 old_value="включена" if было.get("enabled") else "выключена",
                 new_value="включена" if config["enabled"] else "выключена")
    # Выключение при живых доменных пользователях запирает их снаружи —
    # запрещать не за что (это законный откат), но промолчать нельзя.
    warning = None
    if not config["enabled"] and users:
        warning = (f"Доменная авторизация выключена, а доменных пользователей {users} — "
                   "они не смогут войти, пока им не задан пароль сервиса")
    return {"config": config, "domain_users": users, "warning": warning}


@router.post("/ldap-settings/test")
def test_ldap_settings(body: LdapTestIn, admin: sqlite3.Row = Depends(require_system_admin)):
    """Пробная привязка. Отвечает 200 и при неудаче: это диагностика, а не
    попытка входа, и администратору нужен не код ошибки HTTP, а причина."""
    conn = get_connection()
    try:
        config = body.config.model_dump() if body.config else load_config(conn)
    finally:
        conn.close()
    try:
        validate_config({**config, "enabled": True})
    except ValueError as e:
        return {"ok": False, "detail": str(e)}
    try:
        _bind(config, body.login, body.password)
    except DomainAuthError as e:
        return {"ok": False, "code": e.code, "detail": e.detail,
                "bind_name": bind_name(config, body.login)}
    return {"ok": True, "detail": f"Успешно: {bind_name(config, body.login)} принят доменом",
            "bind_name": bind_name(config, body.login)}
