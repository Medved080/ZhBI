"""
Журнал действий пользователей и отработки команд системой (живой запрос
2026-07-29): кто, когда, какую функцию вызвал, что именно изменилось, и
сколько это заняло. Цель — не только аудит, но и сравнение быстродействия
на разных компьютерах прорабов.

ПИШЕТ В ФОНЕ. Это требование пользователя, и оно же техническая
необходимость: запись в журнал не должна удлинять сам ответ сервера,
иначе журнал быстродействия сам стал бы источником замедления. Событие
кладётся в очередь (операция в памяти, микросекунды), а отдельный
фоновый поток пишет их пачками в БД.

Почему свой поток, а не BackgroundTasks FastAPI: BackgroundTasks
выполняются ПОСЛЕ ответа, но в том же потоке пула, то есть занимают
рабочий поток и на массовых операциях всё равно конкурируют с запросами.
Отдельный поток-писатель с собственным соединением к SQLite развязывает
это полностью.

Почему пачками: SQLite делает fsync на каждый commit. Массовая смена
статуса 9422 элементов даёт 9422 события; поштучный commit превратил бы
это в 9422 fsync и был бы виден невооружённым глазом. Пачка до
_BATCH_MAX_ROWS записей в одной транзакции сводит это к единицам
коммитов.

Потеря последних событий при жёстком падении процесса допустима: журнал
наблюдательный, а не бухгалтерский — истина по статусам живёт в
status_history и от журнала не зависит.
"""

import json
import queue
import sqlite3
import threading
from datetime import datetime
from typing import Optional

import app.db as _db  # модулем, а не `from ... import DB_PATH`: путь читается в
                      # момент подключения, иначе подмена DB_PATH (тесты,
                      # scripts/rebuild_db.py) не подхватилась бы этим потоком

# Верхняя граница очереди. При переполнении события ОТБРАСЫВАЮТСЯ, а не
# блокируют запрос: журнал не должен уметь остановить работу сервиса.
# Отброшенные считаются и попадают в журнал отдельной записью — тихая
# потеря была бы хуже самой потери.
_QUEUE_MAX = 10000
_BATCH_MAX_ROWS = 500
_FLUSH_INTERVAL_SEC = 1.0

_queue: "queue.Queue[dict]" = queue.Queue(maxsize=_QUEUE_MAX)
_worker: Optional[threading.Thread] = None
_dropped = 0
_dropped_lock = threading.Lock()

_COLUMNS = (
    "at", "source", "user_id", "user_name", "action", "entity_type", "entity_id",
    "element_type", "subtype", "mark", "old_value", "new_value", "duration_ms",
    "request_id", "details",
)


def _now() -> str:
    """Время с миллисекундами — 'нажал кнопку / открылась форма' различаются
    десятками миллисекунд, посекундной точности datetime('now') не хватает."""
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S.") + f"{datetime.utcnow().microsecond // 1000:03d}"


def log(
    action: str,
    *,
    source: str = "server",
    user: Optional[sqlite3.Row] = None,
    user_id: Optional[int] = None,
    user_name: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    element_type: Optional[str] = None,
    subtype: Optional[str] = None,
    mark: Optional[str] = None,
    old_value: Optional[str] = None,
    new_value: Optional[str] = None,
    duration_ms: Optional[float] = None,
    request_id: Optional[str] = None,
    details: Optional[dict] = None,
    at: Optional[str] = None,
) -> None:
    """Положить событие в очередь. Никогда не бросает исключений и не ждёт:
    сбой журналирования не должен ронять и не должен задерживать само
    действие пользователя."""
    global _dropped
    if user is not None:
        user_id = user["id"] if user_id is None else user_id
        if user_name is None:
            last = user["last_name"] or ""
            first = user["first_name"] or ""
            user_name = f"{last} {first}".strip() or user["domain_login"]
    event = {
        "at": at or _now(),
        "source": source,
        "user_id": user_id,
        "user_name": user_name,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "element_type": element_type,
        "subtype": subtype,
        "mark": mark,
        "old_value": old_value,
        "new_value": new_value,
        "duration_ms": duration_ms,
        "request_id": request_id,
        "details": json.dumps(details, ensure_ascii=False) if details else None,
    }
    try:
        _queue.put_nowait(event)
    except queue.Full:
        with _dropped_lock:
            _dropped += 1


def _drain_dropped() -> int:
    global _dropped
    with _dropped_lock:
        n, _dropped = _dropped, 0
    return n


def _write_batch(conn: sqlite3.Connection, events: list) -> None:
    placeholders = ", ".join("?" for _ in _COLUMNS)
    conn.executemany(
        f"INSERT INTO activity_log ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
        [tuple(e[c] for c in _COLUMNS) for e in events],
    )
    conn.commit()


def _run() -> None:
    conn = sqlite3.connect(_db.DB_PATH, check_same_thread=False)
    try:
        while True:
            batch = []
            try:
                # Блокирующее ожидание первого события — поток спит, пока
                # ничего не происходит, а не крутит пустой цикл.
                batch.append(_queue.get(timeout=_FLUSH_INTERVAL_SEC))
            except queue.Empty:
                pass
            while len(batch) < _BATCH_MAX_ROWS:
                try:
                    batch.append(_queue.get_nowait())
                except queue.Empty:
                    break

            dropped = _drain_dropped()
            if dropped:
                batch.append({
                    **{c: None for c in _COLUMNS},
                    "at": _now(), "source": "server", "action": "log_overflow",
                    "new_value": str(dropped),
                    "details": json.dumps({"сообщение": "события журнала отброшены — очередь переполнена"},
                                          ensure_ascii=False),
                })
            if not batch:
                continue
            try:
                _write_batch(conn, batch)
            except Exception as e:  # noqa: BLE001
                # Журнал не должен ронять сервис ни при каких обстоятельствах.
                print(f"[activity] не удалось записать {len(batch)} событий: {e!r}")
    finally:
        conn.close()


def start_worker() -> None:
    """Запускается один раз при старте приложения (app/main.py, on_startup).
    daemon=True — поток не мешает завершению процесса; недописанные события
    теряются, что для наблюдательного журнала приемлемо (см. модуль)."""
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    _worker = threading.Thread(target=_run, name="activity-log", daemon=True)
    _worker.start()


def flush_for_tests(timeout: float = 5.0) -> None:
    """Дождаться, пока очередь опустеет. Только для проверок — в обычной
    работе ждать журнал не нужно и не следует."""
    import time

    deadline = time.time() + timeout
    while not _queue.empty() and time.time() < deadline:
        time.sleep(0.02)
    time.sleep(_FLUSH_INTERVAL_SEC + 0.3)  # дать писателю завершить последнюю пачку
