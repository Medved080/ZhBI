"""
Обработки релиза — то, что новая версия кода делает с уже накопленными
данными, чтобы они подходили этому коду.

Зачем. Обновление приезжает на сервер пайплайном (`Docs/DEPLOYMENT_LINUX.md`
§3), и подключаться к серверу ради «а теперь запусти скрипт» нельзя — SSH там
остался только на аварийные случаи (откат образа, восстановление базы,
возврат пароля). Требование пользователя 2026-08-04 дословно: «добавляй все
обработки в само обновление и пусть они сами выполняются при старте после
обновления». Поэтому обработка — не скрипт в `scripts/`, а запись в реестре
ниже: она уезжает вместе с кодом и выполняется первым же стартом.

Чем это отличается от миграции схемы (`app/db.py`, `_apply_migrations`).
Миграция меняет СТРУКТУРУ (добавить колонку, индекс, таблицу) и обязана
пройти, иначе код не сможет работать вовсе — она выполняется до всего
остального и при непроходимости роняет старт. Обработка меняет ДАННЫЕ
(разложить по новым полям, дозаполнить, привести к инварианту) и падение
одной из них не должно останавливать стройку: сервис поднимается,
предупреждает и даёт повторить (решение пользователя 2026-08-04).

Версии. Версия кода — верхняя запись `app/changelog.py`; версия базы —
`app_settings.db_release_version` (системная запись, `object_id IS NULL`).
Версия базы догоняет версию кода ТОЛЬКО когда все обработки этого релиза
выполнены успешно — по этому и видно в «Что нового», завершено обновление
или нет. При этом решение «выполнять или не выполнять» принимается ПО ИМЕНИ
обработки, а не по сравнению версий: обработка, дописанная в уже вышедшую
версию, при сравнении номеров была бы пропущена молча.

Сохранность данных. Перед первым стартом новой версии снимается
автоматическая копия базы (`backup_before_update`), поэтому любая обработка
откатывается восстановлением копии из интерфейса. Отсюда же правило для
самих обработок: **релиз только ДОБАВЛЯЕТ** — новые поля, новые таблицы,
заполнение новых структур из старых. Старое не удаляется в том же релизе,
даже когда оно уже никому не нужно: пока данные не сконвертированы у ВСЕХ
площадок и не проверены, удалять нечего и незачем. Уборка живёт отдельным
видом обработок (`KIND_CLEANUP`), при старте не выполняется никогда и ждёт
кнопки администратора — с предварительной копией базы.

Как добавить обработку:

    def _моя_обработка(conn) -> str:
        n = conn.execute("UPDATE ... ").rowcount
        return f"обновлено записей: {n}"

    RELEASE_TASKS = [
        ...,
        {"name": "2026-08-10-что-делает", "version": "0.37",
         "title": "Человеческое название", "why": "зачем это нужно новому коду",
         "kind": KIND_DATA, "run": _моя_обработка},
    ]

Требование к `run`: **идемпотентность**. Обработку может повторить
администратор кнопкой, и повтор обязан быть безвредным — поэтому условие
всегда пишется от состояния данных («где ещё не заполнено»), а не от факта
«я уже выполнялась».
"""

import sqlite3
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app import activity
from app.access import require_system_admin
from app.auth import get_current_user
from app.changelog import CHANGELOG
from app.db import get_connection

router = APIRouter(tags=["release"])

KIND_DATA = "data"          # выполняется сама при старте после обновления
KIND_CLEANUP = "cleanup"    # уборка отжившего — только по кнопке администратора

DB_VERSION_KEY = "db_release_version"


def code_version() -> Optional[str]:
    """Версия КОДА — верхняя запись журнала версий. Одна на всё (решение
    пользователя 2026-08-04): свой счётчик версии данных пришлось бы
    показывать вторым номером и объяснять, чем он отличается."""
    return CHANGELOG[0]["version"] if CHANGELOG else None


# ==================== РЕЕСТР ОБРАБОТОК ====================


def _backfill_element_uids(conn) -> str:
    """GUID изделия (`element_uid`) — основа опознания при переимпорте
    чертежа (см. Docs/DECISIONS.md, «Идентичность элемента»). Он выдаётся при
    вставке и при импорте, но у записей, переживших ручные правки базы или
    частично применённую миграцию, может остаться пустым — и такое изделие
    новая версия чертежа не узнает, то есть заведёт заново, потеряв статус и
    историю.

    Отдельная функция `assign_missing_element_uids` в app/db.py делает это
    для ОДНОГО объекта и зовётся из импорта; здесь тот же приём по всей базе.
    Идемпотентно: заполняются только пустые.
    """
    import uuid
    rows = conn.execute("SELECT id FROM elements WHERE element_uid IS NULL").fetchall()
    for row in rows:
        conn.execute("UPDATE elements SET element_uid = ? WHERE id = ?", (uuid.uuid4().hex, row["id"]))
    return f"GUID выдан изделиям: {len(rows)}" if rows else "все изделия уже с GUID"


def _clear_contract_on_planned(conn) -> str:
    """Инвариант «Запланирован ⇒ контракт пуст» (Docs/DECISIONS.md, «Статусы,
    история, контрактация»). Держится в одном месте — `sync_element_contract`,
    — но записи, заведённые до его появления или восстановленные импортом
    истории, могли разойтись: изделие числится запланированным и при этом
    занимает место в остатке контракта, то есть остаток врёт.

    Идемпотентно: условие смотрит на состояние данных, а не на факт
    выполнения.
    """
    cur = conn.execute(
        "UPDATE elements SET contract_id = NULL "
        "WHERE current_status = 'planned' AND contract_id IS NOT NULL"
    )
    return (f"снят контракт с запланированных изделий: {cur.rowcount}"
            if cur.rowcount else "расхождений с инвариантом нет")


RELEASE_TASKS = [
    {
        "name": "2026-08-04-element-uid-backfill",
        "version": "0.36",
        "title": "Выдать GUID изделиям, у которых его нет",
        "why": "без GUID изделие не опознаётся при загрузке новой версии чертежа — "
               "оно завелось бы заново, потеряв статус и историю",
        "kind": KIND_DATA,
        "run": _backfill_element_uids,
    },
    {
        "name": "2026-08-04-planned-contract-clear",
        "version": "0.36",
        "title": "Снять контракт с изделий в статусе «Запланирован»",
        "why": "запланированное изделие не должно занимать место в остатке контракта — "
               "иначе остатки при выборе контракта показывают меньше, чем есть",
        "kind": KIND_DATA,
        "run": _clear_contract_on_planned,
    },
]


# ==================== ВЕРСИЯ БАЗЫ ====================
#
# Прямым SQL, а не через app/settings.py: тот импортирует app.db и рассчитан
# на настройки ОБЪЕКТА (object_id обязателен позиционно), а здесь запись
# системная — object_id IS NULL, как у маркеров миграций рядом.


def db_version(conn) -> Optional[str]:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ? AND object_id IS NULL", (DB_VERSION_KEY,)
    ).fetchone()
    return row["value"] if row else None


def _set_db_version(conn, version: Optional[str]) -> None:
    if version is None:
        return
    conn.execute("DELETE FROM app_settings WHERE key = ? AND object_id IS NULL", (DB_VERSION_KEY,))
    conn.execute(
        "INSERT INTO app_settings (key, object_id, value) VALUES (?, NULL, ?)",
        (DB_VERSION_KEY, version),
    )


def backup_before_update() -> Optional[dict]:
    """Копия базы ПЕРЕД первым стартом новой версии — до миграций схемы и до
    обработок. Вызывается из on_startup раньше init_db().

    Зачем именно здесь: миграция и обработка применяются автоматически, без
    человека, и единственная возможность вернуться — копия, снятая ДО них.
    Раньше её полагалось снимать руками перед деплоем; теперь сервис снимает
    сам, и это ещё одна причина не подключаться к серверу.

    Тихо ничего не делает, если базы ещё нет (первый запуск вообще) или
    версия уже совпадает — копия на каждый рестарт забила бы диск: рестарт
    случается и при падении, и при `docker compose up`.
    """
    from app import backups
    from app.db import DB_PATH

    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # Таблицы может не быть: база от версии, где app_settings ещё не
        # завели, или пустой файл. Тогда копировать нечего — данных нет.
        try:
            было = db_version(conn)
        except sqlite3.Error:
            return None
    finally:
        conn.close()
    стало = code_version()
    if стало is None or было == стало:
        return None
    return backups.create_backup(
        kind=backups.KIND_BEFORE_UPDATE,
        comment=f"перед обновлением {было or 'до v0.36'} → {стало}",
    )


# ==================== ВЫПОЛНЕНИЕ ====================


def _record(conn, task, status: str, note: str, duration_ms: int) -> None:
    conn.execute(
        """
        INSERT INTO release_tasks (name, version, kind, status, note, applied_at, duration_ms, attempts)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, 1)
        ON CONFLICT(name) DO UPDATE SET
            version = excluded.version, kind = excluded.kind, status = excluded.status,
            note = excluded.note, applied_at = excluded.applied_at,
            duration_ms = excluded.duration_ms, attempts = release_tasks.attempts + 1
        """,
        (task["name"], task.get("version"), task.get("kind", KIND_DATA), status, note, duration_ms),
    )


def _run_one(task) -> dict:
    """Одна обработка в СВОЁМ соединении и своей транзакции: упавшая не
    должна утащить за собой уже выполненные соседние."""
    conn = get_connection()
    started = time.monotonic()
    try:
        try:
            note = task["run"](conn) or "выполнено"
            conn.commit()
            status = "ok"
        except Exception as e:  # noqa: BLE001 — причина уходит в запись и в журнал
            conn.rollback()
            status, note = "error", f"{type(e).__name__}: {e}"
        duration = int((time.monotonic() - started) * 1000)
        _record(conn, task, status, note, duration)
        conn.commit()
    finally:
        conn.close()
    activity.log(
        "release_task" if status == "ok" else "release_task_failed",
        source="system", entity_type="release_task",
        new_value=f"{task['name']}: {note}",
    )
    print(f"[release] {task['name']}: {status} — {note}")
    return {"name": task["name"], "status": status, "note": note, "duration_ms": duration}


def run_pending() -> list:
    """Выполняет обработки, у которых ещё нет успешной записи. Зовётся при
    старте (после init_db и после запуска писателя журнала).

    Уборка (KIND_CLEANUP) сюда не попадает никогда — она ждёт кнопки
    администратора, см. шапку модуля.
    """
    conn = get_connection()
    try:
        готовы = {
            r["name"] for r in conn.execute(
                "SELECT name FROM release_tasks WHERE status = 'ok'").fetchall()
        }
    finally:
        conn.close()

    результаты = []
    for task in RELEASE_TASKS:
        if task.get("kind", KIND_DATA) != KIND_DATA or task["name"] in готовы:
            continue
        результаты.append(_run_one(task))

    # Версия базы догоняет версию кода, только когда НИ ОДНОЙ незавершённой
    # обработки не осталось: она и есть ответ на вопрос «обновление завершено?»
    if not [r for r in результаты if r["status"] != "ok"] and not _pending_names():
        conn = get_connection()
        try:
            прежняя = db_version(conn)
            if прежняя != code_version():
                _set_db_version(conn, code_version())
                conn.commit()
                activity.log("release_version", source="system",
                             old_value=прежняя, new_value=code_version())
                print(f"[release] версия базы: {прежняя} → {code_version()}")
        finally:
            conn.close()
    return результаты


def _pending_names() -> list:
    conn = get_connection()
    try:
        готовы = {
            r["name"] for r in conn.execute(
                "SELECT name FROM release_tasks WHERE status = 'ok'").fetchall()
        }
    finally:
        conn.close()
    return [t["name"] for t in RELEASE_TASKS
            if t.get("kind", KIND_DATA) == KIND_DATA and t["name"] not in готовы]


def status() -> dict:
    """Состояние обновления: версии, завершено ли, и что с каждой обработкой."""
    conn = get_connection()
    try:
        записи = {r["name"]: dict(r) for r in conn.execute("SELECT * FROM release_tasks").fetchall()}
        версия_базы = db_version(conn)
    finally:
        conn.close()
    задачи = []
    for task in RELEASE_TASKS:
        запись = записи.get(task["name"], {})
        задачи.append({
            "name": task["name"],
            "version": task.get("version"),
            "title": task["title"],
            "why": task.get("why"),
            "kind": task.get("kind", KIND_DATA),
            "status": запись.get("status") or "pending",
            "note": запись.get("note"),
            "applied_at": запись.get("applied_at"),
            "duration_ms": запись.get("duration_ms"),
            "attempts": запись.get("attempts") or 0,
        })
    ошибки = [t for t in задачи if t["kind"] == KIND_DATA and t["status"] == "error"]
    ждут = [t for t in задачи if t["kind"] == KIND_DATA and t["status"] == "pending"]
    return {
        "code_version": code_version(),
        "db_version": версия_базы,
        "complete": not ошибки and not ждут and версия_базы == code_version(),
        "failed": len(ошибки),
        "pending": len(ждут),
        "cleanup_available": len([t for t in задачи
                                  if t["kind"] == KIND_CLEANUP and t["status"] != "ok"]),
        "tasks": задачи,
    }


@router.get("/release-status")
def release_status(user: sqlite3.Row = Depends(get_current_user)):
    """Состояние обновления для формы «Что нового».

    Обычному пользователю — только версии и «завершено/не завершено»
    (решение пользователя 2026-08-04): ему важно, доведена ли база до текущей
    версии, а перечень обработок — техническая внутренность. Администратору
    сервиса — полный список с результатами и кнопками.
    """
    данные = status()
    if user["role"] != "admin":
        данные.pop("tasks", None)
    return данные


@router.post("/release-tasks/{name}/run")
def run_release_task(name: str, admin: sqlite3.Row = Depends(require_system_admin)):
    """Повтор упавшей обработки или запуск уборки — без подключения к серверу.

    Перед УБОРКОЙ снимается копия базы: уборка удаляет отжившие структуры, и
    вернуться к ним иначе будет неоткуда. Перед обычной обработкой копия не
    нужна — она уже снята при первом старте новой версии
    (backup_before_update), а сама обработка идемпотентна.
    """
    task = next((t for t in RELEASE_TASKS if t["name"] == name), None)
    if task is None:
        raise HTTPException(status_code=404, detail="Обработка не найдена")
    if task.get("kind", KIND_DATA) == KIND_CLEANUP:
        from app import backups
        backups.create_backup(
            kind=backups.KIND_BEFORE_CLEANUP,
            user_name=" ".join(p for p in (admin["last_name"], admin["first_name"]) if p),
            user_id=admin["id"],
            comment=f"перед уборкой: {task['title']}",
        )
    результат = _run_one(task)
    # Успешный повтор мог закрыть последнюю незавершённую обработку — тогда
    # версия базы обязана догнать версию кода тем же правилом, что и при старте.
    if результат["status"] == "ok" and not _pending_names():
        conn = get_connection()
        try:
            if db_version(conn) != code_version():
                _set_db_version(conn, code_version())
                conn.commit()
        finally:
            conn.close()
    return {**результат, **status()}
