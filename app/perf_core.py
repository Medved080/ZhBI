"""Встроенные замеры производительности — ядро (2026-10-23).

Запрос администратора: чтобы при работе с системой фиксировались ДЕТАЛЬНЫЕ замеры времени, расходуемого на операции, —
по ним потом оптимизировать и ускорять. Здесь — серверная часть сбора; приём замеров браузера, сводки и выгрузка — в `app/perf.py`,
браузерная часть — `app/static/perf.js`.

Что мерит сервер, КОГДА ЗАМЕРЫ ВКЛЮЧЕНЫ (включает и выключает только администратор, пока выключено — запрос не платит ничего, кроме
одной проверки числа):

* каждый HTTP-запрос: маршрут (по шаблону, `GET /objects/{object_id}/blocks`), статус, время до первого байта ответа (то, что потратил
  обработчик), полное время (с отправкой тела), размер отправленного (после сжатия) и кто спрашивал;
* внутри запроса — время в SQLite: сколько запросов, сколько всего заняли `execute` и выборка строк (`fetch*`/перебор курсора), три
  самых долгих запроса (текст без параметров, до 160 знаков);
* именованные отрезки обработчика (`perf.span("сериализация")`) — там, где их расставили вручную.

Ответ получает заголовок `Server-Timing: app;dur=<мс до первого байта>` — браузер видит его в Resource Timing и кладёт рядом со своим
замером: разница «браузер минус сервер» — это сеть и разбор на машине пользователя.

Замеры не пишутся в базу по одному: обработчик кладёт строку в память, фоновый поток раз в две секунды вставляет накопленное ОДНОЙ
транзакцией (писатель в SQLite один, и каждый запрос не должен за него драться). Строки старше RETENTION_DAYS (3 суток) удаляются сами.

Модуль не импортирует ни `app.db`, ни `app.access` на верхнем уровне: `app.db` сам берёт отсюда классы соединения (замер SQL), а
`app.auth` — `note_user`; иначе получился бы круг.
"""
import contextvars
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

RETENTION_DAYS = 3                 # сколько суток хранятся замеры (решение пользователя 2026-10-23)
MAX_ROWS = 500_000                 # предел таблицы: при переполнении самые старые удаляются
DEFAULT_MINUTES = 120              # автоостановка: забытый включённым сбор не должен писать вечно
STATE_KEY = "perf.capture"         # app_settings (object_id IS NULL): {"run_id","started_at","started_by","until"}
_STATE_TTL = 2.0                   # как часто перечитывать состояние из базы (несколько процессов сервера видят друг друга)
_FLUSH_EVERY = 2.0
_CLEANUP_EVERY = 600.0
_BUF_MAX = 20000
_SLOW_SQL_KEEP = 3


def _now() -> str:
    """Тот же формат, что у activity_log.at: 'ГГГГ-ММ-ДД ЧЧ:ММ:СС.ммм', UTC."""
    d = datetime.utcnow()
    return d.strftime("%Y-%m-%d %H:%M:%S.") + f"{d.microsecond // 1000:03d}"


def at_ago(ago_ms: float) -> str:
    d = datetime.utcnow() - timedelta(milliseconds=max(0.0, ago_ms))
    return d.strftime("%Y-%m-%d %H:%M:%S.") + f"{d.microsecond // 1000:03d}"


# ----------------------------------------------------------------------------- состояние «замеры включены»

_state = {"run_id": None, "until": None, "info": None, "checked": 0.0}
_state_lock = threading.Lock()
_last_cleanup = 0.0


def _load_state() -> None:
    from app.db import get_connection
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ? AND object_id IS NULL", (STATE_KEY,)).fetchone()
    except sqlite3.Error:
        return
    finally:
        conn.close()
    info = None
    if row and row[0]:
        try:
            info = json.loads(row[0])
        except ValueError:
            info = None
    _state["info"] = info
    _state["run_id"] = info.get("run_id") if info and info.get("on") else None
    _state["until"] = info.get("until") if info else None


def current_run() -> Optional[str]:
    """Идентификатор текущего сбора или None (замеры выключены или время вышло). Горячий путь каждого запроса."""
    now = time.monotonic()
    if now - _state["checked"] > _STATE_TTL:
        with _state_lock:
            if now - _state["checked"] > _STATE_TTL:
                _state["checked"] = now
                _load_state()
                _maybe_cleanup(now)
    run = _state["run_id"]
    if run and _state["until"] and _now_epoch() > _state["until"]:
        return None
    return run


def _now_epoch() -> float:
    return time.time()


def state_info() -> dict:
    """Что отдать клиенту: идёт ли сбор, какой, до какого времени (по часам сервера, unix-секунды)."""
    run = current_run()
    info = _state["info"] or {}
    return {"on": bool(run), "run_id": run, "started_at": info.get("started_at"), "started_by": info.get("started_by"),
            "until": info.get("until") if run else None}


def set_capture(on: bool, by: str, minutes: int = DEFAULT_MINUTES) -> dict:
    """Включить (новый сбор со своим идентификатором) или выключить. Вызывает только администратор (app/perf.py)."""
    from app.db import get_connection
    prev = _state["info"] or {}
    if on:
        run_id = datetime.utcnow().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        info = {"on": True, "run_id": run_id, "started_at": _now(), "started_by": by,
                "until": time.time() + max(1, min(int(minutes), 24 * 60)) * 60}
    else:
        info = {**prev, "on": False, "stopped_at": _now()}
    conn = get_connection()
    try:
        conn.execute("INSERT INTO app_settings (key, object_id, value) VALUES (?, NULL, ?) "
                     "ON CONFLICT(key, COALESCE(object_id, -1)) DO UPDATE SET value = excluded.value",
                     (STATE_KEY, json.dumps(info, ensure_ascii=False)))
        conn.commit()
    finally:
        conn.close()
    with _state_lock:
        _state["checked"] = 0.0
        _load_state()
        _state["checked"] = time.monotonic()
    if not on:
        flush()
    return state_info()


# ----------------------------------------------------------------------------- замеры внутри запроса (SQLite, отрезки)

_STATS: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("zhbi_perf_stats", default=None)


def _sql_text(sql) -> str:
    return " ".join(str(sql).split())[:160]


def _sql_done(st: dict, sql, seconds: float) -> None:
    ms = seconds * 1000.0
    st["sql_ms"] += ms
    st["sql_n"] += 1
    slow = st["sql_slow"]
    if len(slow) < _SLOW_SQL_KEEP or ms > slow[-1][0]:
        slow.append((round(ms, 2), _sql_text(sql)))
        slow.sort(key=lambda x: -x[0])
        del slow[_SLOW_SQL_KEEP:]


class PerfCursor(sqlite3.Cursor):
    """Курсор, который меряет себя, ТОЛЬКО пока идёт замеряемый запрос (иначе — прямой вызов родителя)."""

    def execute(self, sql, *a):
        st = _STATS.get()
        if st is None:
            return super().execute(sql, *a)
        t = time.perf_counter()
        try:
            return super().execute(sql, *a)
        finally:
            _sql_done(st, sql, time.perf_counter() - t)

    def executemany(self, sql, *a):
        st = _STATS.get()
        if st is None:
            return super().executemany(sql, *a)
        t = time.perf_counter()
        try:
            return super().executemany(sql, *a)
        finally:
            _sql_done(st, sql, time.perf_counter() - t)

    def _timed_fetch(self, fn, *a):
        st = _STATS.get()
        if st is None:
            return fn(*a)
        t = time.perf_counter()
        try:
            return fn(*a)
        finally:
            st["sql_fetch_ms"] += (time.perf_counter() - t) * 1000.0

    def fetchone(self):
        return self._timed_fetch(super().fetchone)

    def fetchmany(self, *a):
        return self._timed_fetch(super().fetchmany, *a)

    def fetchall(self):
        return self._timed_fetch(super().fetchall)

    def __next__(self):
        st = _STATS.get()
        if st is None:
            return super().__next__()
        t = time.perf_counter()
        try:
            return super().__next__()
        finally:
            st["sql_fetch_ms"] += (time.perf_counter() - t) * 1000.0


class PerfConnection(sqlite3.Connection):
    """Соединение с БД (см. app.db.get_connection). Вне замеряемого запроса ведёт себя как обычное."""

    def execute(self, sql, *a):
        if _STATS.get() is None:
            return super().execute(sql, *a)
        return self.cursor(PerfCursor).execute(sql, *a)

    def executemany(self, sql, *a):
        if _STATS.get() is None:
            return super().executemany(sql, *a)
        return self.cursor(PerfCursor).executemany(sql, *a)

    def executescript(self, script):
        st = _STATS.get()
        if st is None:
            return super().executescript(script)
        t = time.perf_counter()
        try:
            return super().executescript(script)
        finally:
            _sql_done(st, "executescript " + str(script), time.perf_counter() - t)


@contextmanager
def span(name: str):
    """Именованный отрезок обработчика: `with perf.span("сериализация"): ...`. Вне замеряемого запроса не делает ничего."""
    st = _STATS.get()
    if st is None:
        yield
        return
    t = time.perf_counter()
    try:
        yield
    finally:
        sp = st["spans"]
        sp[name] = round(sp.get(name, 0.0) + (time.perf_counter() - t) * 1000.0, 2)


def mark(name: str) -> None:
    """Отметка границы этапа обработчика: время с прошлой отметки (или с начала запроса) записывается в отрезок `name`.
    Для длинных обработчиков, которые неудобно оборачивать в `with span(...)` (пришлось бы сдвигать сотни строк)."""
    st = _STATS.get()
    if st is None:
        return
    now = time.perf_counter()
    sp = st["spans"]
    sp[name] = round(sp.get(name, 0.0) + (now - st.get("_mark", st["t0"])) * 1000.0, 2)
    st["_mark"] = now


def note_user(user) -> None:
    """Кто делает запрос (зовёт app.auth.get_current_user). Вне замеряемого запроса — пустой вызов."""
    st = _STATS.get()
    if st is None or user is None:
        return
    try:
        st["user_id"] = user["id"]
        last = user["last_name"] or ""
        first = user["first_name"] or ""
        st["user_name"] = f"{last} {first}".strip() or user["domain_login"]
    except (KeyError, IndexError, TypeError):
        pass


def note_object(object_id) -> None:
    st = _STATS.get()
    if st is not None and isinstance(object_id, int):
        st["object_id"] = object_id


# ----------------------------------------------------------------------------- буфер и запись

_buf: list = []
_buf_lock = threading.Lock()
_flusher: Optional[threading.Thread] = None


def enqueue(rows: list) -> None:
    global _flusher
    with _buf_lock:
        _buf.extend(rows)
        if len(_buf) > _BUF_MAX:
            del _buf[: len(_buf) - _BUF_MAX]
        if _flusher is None:
            _flusher = threading.Thread(target=_flush_loop, name="perf-flush", daemon=True)
            _flusher.start()


def _flush_loop() -> None:
    while True:
        time.sleep(_FLUSH_EVERY)
        try:
            flush()
        except Exception:  # сбой замеров не должен ничего ронять
            pass


_COLUMNS = ("at", "run_id", "side", "kind", "op", "duration_ms", "user_id", "user_name", "client_id", "object_id", "details")


def flush() -> int:
    with _buf_lock:
        rows = _buf[:]
        _buf.clear()
    if not rows:
        return 0
    from app.db import get_connection
    conn = get_connection()
    try:
        conn.executemany(
            f"INSERT INTO perf_samples ({', '.join(_COLUMNS)}) VALUES ({', '.join('?' * len(_COLUMNS))})",
            [tuple(r.get(c) for c in _COLUMNS) for r in rows])
        conn.commit()
    except sqlite3.Error:
        return 0
    finally:
        conn.close()
    return len(rows)


def cleanup(conn: Optional[sqlite3.Connection] = None) -> int:
    """Удалить замеры старше RETENTION_DAYS и лишнее сверх MAX_ROWS."""
    from app.db import get_connection
    own = conn is None
    conn = conn or get_connection()
    try:
        cutoff = (datetime.utcnow() - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%d %H:%M:%S.000")
        n = conn.execute("DELETE FROM perf_samples WHERE at < ?", (cutoff,)).rowcount
        total = conn.execute("SELECT COUNT(*) FROM perf_samples").fetchone()[0]
        if total > MAX_ROWS:
            conn.execute("DELETE FROM perf_samples WHERE id IN (SELECT id FROM perf_samples ORDER BY id LIMIT ?)",
                         (total - MAX_ROWS + MAX_ROWS // 10,))
        conn.commit()
        return n
    except sqlite3.Error:
        return 0
    finally:
        if own:
            conn.close()


def _maybe_cleanup(now: float) -> None:
    global _last_cleanup
    if now - _last_cleanup < _CLEANUP_EVERY:
        return
    _last_cleanup = now
    threading.Thread(target=cleanup, name="perf-cleanup", daemon=True).start()


# ----------------------------------------------------------------------------- посредник (ASGI)

_SKIP_PREFIXES = ("/perf/",)
_SKIP_EXACT = {("POST", "/activity")}


class PerfMiddleware:
    """Мерит каждый HTTP-запрос, пока замеры включены. Чистый ASGI-класс: contextvar со статистикой должен дойти до обработчиков,
    выполняемых в пуле потоков (Starlette копирует контекст при запуске синхронного обработчика)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        run = current_run()
        method = scope["method"]
        path = scope["path"]
        if run is None or method == "OPTIONS" or path.startswith(_SKIP_PREFIXES) or (method, path) in _SKIP_EXACT:
            return await self.app(scope, receive, send)
        t0 = time.perf_counter()
        st = {"sql_ms": 0.0, "sql_fetch_ms": 0.0, "sql_n": 0, "sql_slow": [], "spans": {}, "t0": t0}
        token = _STATS.set(st)
        info = {"status": 0, "ttfb": None, "bytes": 0}
        req_id = None
        for k, v in scope.get("headers", ()):
            if k == b"x-perf-id":
                req_id = v.decode("latin-1")[:60]
                break

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                info["status"] = message["status"]
                info["ttfb"] = (time.perf_counter() - t0) * 1000.0
                headers = list(message.get("headers", ()))
                headers.append((b"server-timing", f"app;dur={info['ttfb']:.1f}".encode()))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body":
                info["bytes"] += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            total = (time.perf_counter() - t0) * 1000.0
            _STATS.reset(token)
            try:
                route = scope.get("route")
                if path.startswith("/static/"):
                    shape = "/static/*"
                else:
                    shape = getattr(route, "path", None) or path
                details = {"status": info["status"], "ttfb_ms": round(info["ttfb"], 1) if info["ttfb"] is not None else None,
                           "bytes": info["bytes"], "sql_ms": round(st["sql_ms"], 1), "sql_fetch_ms": round(st["sql_fetch_ms"], 1),
                           "sql_n": st["sql_n"]}
                if st["sql_slow"]:
                    details["sql_slow"] = [{"ms": m, "sql": s} for m, s in st["sql_slow"]]
                if st["spans"]:
                    spans = dict(st["spans"])
                    # после последней отметки обработчика до первого байта ответа — это кодирование ответа в JSON и сжатие
                    if "_mark" in st and info["ttfb"] is not None:
                        spans["после обработчика: JSON и сжатие"] = round(max(0.0, info["ttfb"] - (st["_mark"] - t0) * 1000.0), 2)
                    details["spans"] = spans
                if req_id:
                    details["req"] = req_id
                if path.startswith("/static/"):
                    details["path"] = path[:120]
                client_id = req_id.split(".")[0] if req_id else None
                enqueue([{"at": _now(), "run_id": run, "side": "server", "kind": "http", "op": f"{method} {shape}",
                          "duration_ms": round(total, 2), "user_id": st.get("user_id"), "user_name": st.get("user_name"),
                          "client_id": client_id, "object_id": st.get("object_id"),
                          "details": json.dumps(details, ensure_ascii=False)}])
            except Exception:  # замер не должен менять исход запроса
                pass
