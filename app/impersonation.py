"""
Режим «Зайти под пользователем» (2026-08-05, живой запрос).

Администратор сервиса открывает ДОПОЛНИТЕЛЬНУЮ ВКЛАДКУ, в которой система
ведёт себя ровно так, как у выбранного пользователя: те же пункты меню, те
же объекты, те же права. Это отладка чужих прав по жалобе «у меня не видно
пункт X» — единственный способ увидеть чужой интерфейс, не зная чужого
пароля и не переставляя себе роли.

ПОЧЕМУ НЕ ПОДМЕНА COOKIE. Cookie одна на браузер, а не на вкладку: подмена
превратила бы в «пользователя X» и все остальные вкладки администратора,
включая ту, из которой он этот режим включил. Поэтому:

  * режим живёт в ОТДЕЛЬНОЙ сессии в таблице `sessions` с заполненным
    `impersonator_user_id` — это её отличие от обычной;
  * токен этой сессии клиент кладёт в `sessionStorage` (он свой у КАЖДОЙ
    вкладки, в отличие от localStorage и cookie) и шлёт заголовком
    IMPERSONATION_HEADER на каждый запрос;
  * по cookie такая сессия НЕ ПОДХОДИТ вовсе (см. get_user_by_session):
    иначе токен, положенный в cookie, дал бы вход под чужой учётной
    записью без единой отметки в журнале — то есть ровно то, ради чего
    журнал и заводился.

Заголовок вместо cookie попутно закрывает CSRF: заголовок с чужого сайта
без разрешающего CORS не поставить, а CORS здесь не настроен.

ПОЧЕМУ CONTEXTVAR. Отметку «сделано администратором от имени» обязаны
получить и журнал действий, и `status_history.changed_by`, а пишут их
десятки мест, до которых `Request` не доходит. Контекст запроса —
единственное, что видно из любого из них. Устанавливается ЧИСТЫМ
ASGI-посредником (ImpersonationMiddleware), а не зависимостью FastAPI:
синхронная зависимость выполняется в отдельном потоке пула с КОПИЕЙ
контекста, и установленная в ней переменная до обработчика не доедет.
"""

import sqlite3
from contextvars import ContextVar, Token
from typing import Optional

IMPERSONATION_HEADER = "x-impersonate-token"

# Срок отладочного сеанса. Намеренно короткий (обычный — 30 дней): это
# инструмент на «посмотреть и закрыть», а вкладка, забытая под чужой
# учётной записью, — чужой рабочий день от чужого имени.
IMPERSONATION_TTL_HOURS = 4

# Что лежит в контексте: строка пользователя, от чьего имени идёт работа,
# плюс кто именно её ведёт. None — обычный запрос, никакого режима нет.
_current: ContextVar[Optional[dict]] = ContextVar("zhbi_impersonation", default=None)


def current() -> Optional[dict]:
    """Сведения о режиме «от имени» для ТЕКУЩЕГО запроса или None."""
    return _current.get()


def set_current(info: Optional[dict]) -> Token:
    return _current.set(info)


def reset(token: Token) -> None:
    _current.reset(token)


def audit_name(fallback: str) -> str:
    """Имя для аудиторского СНИМКА одной строкой: «Админ (от имени: X)».

    Одной строкой — потому что попадает в `status_history.changed_by`, где
    второй колонки нет и не будет: карточка изделия обязана честно
    показывать, что статус поставил администратор, а не сам пользователь.
    В журнале действий колонок две (см. app/activity.py), и там слитная
    строка была бы дублем."""
    info = current()
    return fallback if info is None else f"{info['admin_name']} (от имени: {info['user_name']})"


def plain_name(audit_or_plain: str) -> str:
    """Обратное к audit_name: имя БЕЗ приписки, для журнала действий.

    Нужно там, где одна и та же строка идёт и в `status_history.changed_by`,
    и в `activity.log(user_name=...)` — например в apply_status_change. В
    журнале приписка была бы дублем колонки impersonator_name, и колонка
    «Пользователь» перестала бы совпадать с user_id."""
    info = current()
    return audit_or_plain if info is None else info["user_name"]


class ImpersonationMiddleware:
    """Чистый ASGI-посредник (как MaxBodySizeMiddleware в app/upload_limits.py).

    Именно чистый, а не `@app.middleware("http")`: тот оборачивается в
    BaseHTTPMiddleware и запускает приложение отдельной задачей — на
    распространение contextvars вниз полагаться там нельзя, а здесь
    обработчик выполняется в ТОМ ЖЕ контексте, где переменная установлена.

    Запрос без заголовка не стоит ничего: обращения к базе не будет.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        token = None
        for name, value in scope.get("headers", []):
            if name == IMPERSONATION_HEADER.encode("latin-1"):
                token = value.decode("latin-1")
                break
        info = None
        if token:
            from starlette.concurrency import run_in_threadpool
            info = await run_in_threadpool(resolve, token)
        if info is None:
            await self.app(scope, receive, send)
            return
        ctx = set_current(info)
        try:
            await self.app(scope, receive, send)
        finally:
            reset(ctx)


def resolve(token: str) -> Optional[dict]:
    """Токен отладочного сеанса -> сведения о режиме или None.

    None означает «режима нет», а не «отказ»: дальше запрос идёт обычным
    путём по cookie, то есть от имени самого администратора. Молчаливого
    повышения прав это не даёт — cookie принадлежит ему же.

    Проверяем и то, что администратор ВСЁ ЕЩЁ администратор: разжаловали
    или удалили — отладочные сеансы, которые он успел открыть, гаснут сами.
    """
    from app.db import get_connection

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT s.impersonator_user_id AS admin_id, u.* "
            "FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.impersonator_user_id IS NOT NULL "
            "AND s.expires_at > datetime('now')",
            (token,),
        ).fetchone()
        if row is None:
            return None
        admin = conn.execute(
            "SELECT * FROM users WHERE id = ?", (row["admin_id"],)
        ).fetchone()
        if admin is None or admin["role"] != "admin":
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?", (token,)
        )
        conn.commit()
    finally:
        conn.close()

    from app.auth import format_display_name

    return {
        "token": token,
        "user_row": row,
        "user_id": row["id"],
        "user_name": format_display_name(row),
        "admin_id": admin["id"],
        "admin_name": format_display_name(admin),
        "admin_row": admin,
    }


def user_row() -> Optional[sqlite3.Row]:
    info = current()
    return None if info is None else info["user_row"]
