"""
Регистрация ошибок и отказов в журнале действий (живой запрос 2026-08-20:
«добавь сквозную регистрацию ошибок — серверных и клиентских»).

Что было. Журнал знал только про удавшиеся действия и про неудачные входы.
Исключение в обработчике уходило трассировкой в `logs/uvicorn-*.log` на
сервере, отказ по правам не оставлял следа вовсе, а ошибка в браузере
прораба не покидала его консоли. Вопрос «почему у него не открывается
отчёт» разбирался пересказом.

Что стало. Любой неуспешный ответ сервиса и любой сбой в браузере — запись
журнала с категорией: `error` (сбой программы: исключение, 5xx) или
`denied` (программа отработала штатно и не дала: нет права, не найдено, не
прошло проверку). Категория здесь передаётся ЯВНО, а не берётся из реестра
по коду действия: у ответа 500 и ответа 403 действие одно и то же, а
категории разные — она зависит от значения, не от кода.

Почему регистрация СКВОЗНАЯ, а не по месту. Расставить `try/except` по
роутам значило бы поймать ровно те сбои, которых ждали, — то есть не
поймать ни одного настоящего. Здесь ловится всё разом: обработчики
исключений FastAPI плюс посредник, смотрящий на статус готового ответа
(его дело — то, что до обработчиков не доходит: отказ по размеру тела,
ошибка внутри другого посредника).

Подавление повторов. «Писать ВСЕ неуспешные ответы» — решение
пользователя, и у него есть цена: вкладка с истёкшей сессией опрашивает
`/changes` каждые несколько секунд и даёт 401 за 401. Поэтому одинаковая
тройка (кто, куда, с каким кодом) записывается не чаще раза в
`_WINDOW_SEC`, а подавленные повторы СЧИТАЮТСЯ и попадают в следующую
запись полем «повторов подавлено» — молчаливая потеря была бы хуже самой
потери (тот же приём, что у переполнения очереди журнала, см.
app/activity.py).
"""

import sqlite3
import threading
import time
import traceback
from typing import Optional

from app import activity
from app.activity_actions import CATEGORY_DENIED, CATEGORY_ERROR
from app.db import get_connection

# Сколько секунд одинаковая ошибка считается «той же самой».
_WINDOW_SEC = 60.0
# Сколько знаков трассировки уходит в журнал. Полная трассировка бывает в
# десятки килобайт (Starlette + FastAPI + shapely), и в таблице, которую
# листают глазами, она не нужна: для опознания места хватает хвоста —
# последних кадров и самой строки исключения.
_TRACE_TAIL = 2000

_seen: dict = {}
_seen_lock = threading.Lock()

# Что в журнал не пишется. Единственное исключение — ПРИЁМ клиентских
# событий (POST /activity): ошибка на нём означала бы, что запись об
# ошибке сама порождает запись об ошибке. Поиск по журналу (GET /activity)
# исключением НЕ является: его отказы разбирают так же, как остальные.
_SKIP = {
    ("POST", "/activity"),
    # Иконку вкладки браузер просит сам, по своему усмотрению и по адресу,
    # которого у сервиса нет (своя иконка отдаётся из /static). Это не
    # отказ сервиса, а привычка браузера — и она повторялась бы у каждого
    # пользователя при каждой загрузке страницы.
    ("GET", "/favicon.ico"),
}


def _should_write(key: tuple) -> Optional[int]:
    """None — повтор, писать не надо. Число — писать, и вот столько
    повторов подавлено с прошлой записи."""
    now = time.monotonic()
    with _seen_lock:
        было = _seen.get(key)
        if было is not None and now - было[0] < _WINDOW_SEC:
            _seen[key] = (было[0], было[1] + 1)
            return None
        подавлено = было[1] if было is not None else 0
        _seen[key] = (now, 0)
        # Ключи копятся по одному на связку «пользователь + путь + код»;
        # чистим просроченные, пока их немного, чтобы словарь не рос
        # бесконечно на живом сервере.
        if len(_seen) > 500:
            for k, v in list(_seen.items()):
                if now - v[0] > _WINDOW_SEC * 10:
                    _seen.pop(k, None)
        return подавлено


def _user_for_log(request) -> tuple:
    """(user_id, user_name) для записи — насколько их вообще можно узнать.

    Зависимости FastAPI к моменту сбоя могли не отработать (сбой мог быть
    как раз в них), поэтому пользователь достаётся из контекста режима «от
    имени», а иначе — прямым запросом по cookie сеанса. Запрос свой, а не
    `auth.get_user_by_session`: та по дороге ПИШЕТ отметку активности
    сеанса, а обработчик ошибки не должен ничего менять в базе.
    """
    try:
        from app import impersonation

        подмена = impersonation.user_row()
        if подмена is not None:
            return подмена["id"], _display(подмена)
    except Exception:  # noqa: BLE001 — журнал не имеет права ронять ответ
        pass
    try:
        from app.auth import SESSION_COOKIE

        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            return None, None
        conn = get_connection()
        try:
            row = conn.execute(
                "SELECT u.id, u.last_name, u.first_name, u.domain_login "
                "FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token = ? AND s.expires_at > datetime('now')",
                (token,),
            ).fetchone()
        finally:
            conn.close()
        return (row["id"], _display(row)) if row is not None else (None, None)
    except Exception:  # noqa: BLE001
        return None, None


def _кто(request) -> str:
    """Дешёвая примета «того же самого клиента» для ключа подавления: токен
    сеанса, а у неаутентифицированного — адрес. Без обращения к базе."""
    try:
        from app.auth import SESSION_COOKIE

        token = request.cookies.get(SESSION_COOKIE)
        if token:
            return token
    except Exception:  # noqa: BLE001 — журнал не имеет права ронять ответ
        pass
    return request.client.host if request.client else "unknown"


def _display(row: sqlite3.Row) -> str:
    фио = f"{row['last_name'] or ''} {row['first_name'] or ''}".strip()
    return фио or row["domain_login"]


def _write(request, *, action: str, category: str, status: int, detail: str,
           trace: Optional[str] = None) -> None:
    путь = request.url.path
    if (request.method, путь) in _SKIP:
        return
    # Подавление повторов — ПЕРВЫМ делом, ДО поиска пользователя: тот ходит
    # в базу, а при шквале одинаковых отказов (вкладка с истёкшей сессией
    # опрашивает `/changes`) это соединение на каждый подавленный повтор.
    # Отличать «кого» в ключе можно и без базы — по токену сеанса, а без
    # него по адресу: разным людям с одной и той же ошибкой достанутся
    # разные ключи, а это всё, что от ключа требуется.
    подавлено = _should_write((_кто(request), request.method, путь, status, detail[:120]))
    if подавлено is None:
        return
    user_id, user_name = _user_for_log(request)
    подробности = {
        "путь": путь,
        "метод": request.method,
        "код": status,
        "сообщение": detail,
    }
    # Строка запроса — только у неуспехов: по ней видно, с какими
    # параметрами отчёт или выборка не открылись.
    if request.url.query:
        подробности["параметры"] = request.url.query
    if trace:
        подробности["трассировка"] = trace[-_TRACE_TAIL:]
    if подавлено:
        подробности["повторов подавлено"] = подавлено
    activity.log(
        action,
        category=category,
        user_id=user_id,
        user_name=user_name,
        entity_type="request",
        new_value=f"{status} {request.method} {путь}",
        details=подробности,
    )
    # Отметка на запросе: посредник, который смотрит на статус готового
    # ответа, не должен записать то же самое второй раз.
    try:
        request.state.error_logged = True
    except Exception:  # noqa: BLE001 — у запроса без state отметка не нужна
        pass


def note_exception(request, exc: BaseException) -> None:
    """Необработанное исключение обработчика — ответ 500."""
    _write(
        request,
        action="server_error",
        category=CATEGORY_ERROR,
        status=500,
        detail=f"{type(exc).__name__}: {exc}",
        trace="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    )


def note_http_error(request, status: int, detail: str) -> None:
    """HTTPException: 5xx — сбой программы, 4xx — отказ."""
    ошибка = status >= 500
    _write(
        request,
        action="server_error" if ошибка else "request_denied",
        category=CATEGORY_ERROR if ошибка else CATEGORY_DENIED,
        status=status,
        detail=detail,
    )


def note_validation_error(request, detail: str) -> None:
    """Тело или параметры запроса не прошли проверку (422)."""
    _write(request, action="request_denied", category=CATEGORY_DENIED,
           status=422, detail=detail)


def note_response(request, status: int) -> None:
    """Неуспешный ответ, о котором обработчики не знают: отказ по размеру
    тела, сбой внутри другого посредника, ответ, собранный роутом вручную.
    Уже записанное сюда не попадает — см. отметку `error_logged`."""
    if getattr(request.state, "error_logged", False):
        return
    ошибка = status >= 500
    _write(
        request,
        action="server_error" if ошибка else "request_denied",
        category=CATEGORY_ERROR if ошибка else CATEGORY_DENIED,
        status=status,
        detail=f"ответ {status} без подробностей",
    )
