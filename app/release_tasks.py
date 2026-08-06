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


def _fill_marks_catalog(conn) -> str:
    """Разложить марки по справочнику `marks` и проставить `elements.mark_id`.

    Что делает. Заводит запись справочника на каждую пару (объект, тип,
    марка), встречающуюся (1) у изделий и (2) в позициях контрактов, чей тип
    определён. Объект позиции контракта берётся по цепочке
    contract_lines → contracts → specifications → agreements.object_id —
    отдельного поля объекта у контракта нет и быть не должно (см. schema.sql).

    Чего НЕ делает — и это главное. Регистр здесь НЕ сворачивается: «К-1» и
    «к-1» становятся ДВУМЯ записями справочника, ровно как они лежат в
    данных. Свёртка задвоенных записей — отдельный шаг (пользователь сначала
    чистит справочник руками, потом приезжает автоматическая обработка):
    свернуть тихо, не показав человеку, что и с чем слиплось, значит принять
    за него решение о том, какое написание марки правильное.

    Текстовое `elements.mark` не трогается вовсе — правило релиза «только
    добавлять». Оба поля живут рядом, пока пользователь не сверит разложение.

    Идемпотентность: записи справочника заводятся через INSERT OR IGNORE по
    уникальному ключу, mark_id проставляется только там, где он ещё пуст.
    """
    из_изделий = conn.execute(
        """
        INSERT OR IGNORE INTO marks (object_id, element_type, name)
        SELECT DISTINCT object_id, element_type, mark FROM elements
        WHERE object_id IS NOT NULL AND element_type IS NOT NULL
          AND mark IS NOT NULL AND trim(mark) <> ''
        """
    ).rowcount
    conn.execute(
        """
        INSERT OR IGNORE INTO marks (object_id, element_type, name)
        SELECT DISTINCT a.object_id, cl.element_type, cl.mark
        FROM contract_lines cl
        JOIN contracts co ON co.id = cl.contract_id
        JOIN specifications s ON s.id = co.specification_id
        JOIN agreements a ON a.id = s.agreement_id
        WHERE a.object_id IS NOT NULL AND cl.element_type IS NOT NULL
          AND cl.mark IS NOT NULL AND trim(cl.mark) <> ''
        """
    )
    всего_записей = conn.execute("SELECT COUNT(*) AS n FROM marks").fetchone()["n"]

    # Сопоставление ТОЧНОЕ, с учётом регистра: подставить изделию запись,
    # отличающуюся написанием, значит молча решить за пользователя ту самую
    # задвоенность, ради разбора которой справочник и заводится.
    cur = conn.execute(
        """
        UPDATE elements SET mark_id = (
            SELECT m.id FROM marks m
            WHERE m.object_id = elements.object_id
              AND m.element_type = elements.element_type
              AND m.name = elements.mark
        )
        WHERE mark_id IS NULL AND object_id IS NOT NULL
          AND mark IS NOT NULL AND trim(mark) <> ''
        """
    )
    if не_разложено := conn.execute(
        "SELECT COUNT(*) AS n FROM elements "
        "WHERE mark_id IS NULL AND mark IS NOT NULL AND trim(mark) <> ''"
    ).fetchone()["n"]:
        хвост = (f"; без записи справочника осталось изделий: {не_разложено} "
                 f"(нет объекта либо типа)")
    else:
        хвост = ""
    return (f"записей справочника марок: {всего_записей} "
            f"(заведено этим проходом из изделий: {из_изделий}); "
            f"проставлено изделиям: {cur.rowcount}{хвост}")


def _ключ_без_регистра(значение) -> str:
    """Ключ сравнения «то же самое, но набрано иначе».

    Регистр приводится В PYTHON, а не в SQL: SQLite без ICU кириллицу к
    одному регистру НЕ приводит — это уже ловили живым багом (см.
    Docs/DECISIONS.md, «Регистронезависимое сравнение кириллицы — только на
    стороне Python»). Заодно схлопываются лишние пробелы: «К-1» и «К-1 » —
    одна и та же марка, набранная неаккуратно.
    """
    return " ".join(str(значение or "").split()).lower()


def _выбрать_основную(записи: list, вес) -> tuple:
    """Какая из задвоенных записей остаётся. Побеждает та, на которую больше
    ссылок: перевесить меньшее число ссылок и дешевле, и безопаснее — ошибка
    в такой свёртке затронет меньше данных. При равенстве остаётся самая
    ранняя (наименьший id): она и есть «оригинал», остальные завелись следом
    опечаткой."""
    порядок = sorted(записи, key=lambda r: (-вес(r), r["id"]))
    return порядок[0], порядок[1:]


def _fold_case_duplicates(conn) -> str:
    """Свернуть записи справочников, различающиеся ТОЛЬКО регистром.

    Второй шаг разбора задвоенности. Первый — `2026-08-05-marks-catalog` —
    разложил марки по справочнику, намеренно НЕ сворачивая регистр: решать,
    какое написание верное, должен был человек. Пользователь почистил
    справочники руками, и остаток сворачивается автоматически.

    Порядок обхода — сверху вниз по иерархии: контрагенты, потом их
    договоры, потом спецификации. Свернув контрагентов первыми, мы стаскиваем
    их договоры в одну запись, и уже среди них ищутся одноимённые; в
    обратном порядке дубли договоров у РАЗНЫХ контрагентов остались бы
    незамеченными.

    Переносы делаются теми же функциями, что и ручное удаление с заменой
    (`app/dict_delete.py`): второй реализацией того же переноса эта
    обработка разошлась бы с интерфейсом — а расходятся такие вещи молча.

    Идемпотентность: после первого прохода задвоенных не остаётся, второй
    проход не находит ни одной группы.
    """
    from app import dict_delete as dd

    отчёт = []

    def свернуть(имя, запрос, ключ, вес, слить, подпись):
        группы = {}
        for r in conn.execute(запрос).fetchall():
            группы.setdefault(ключ(r), []).append(r)
        свёрнуто = 0
        for записи in группы.values():
            if len(записи) < 2:
                continue
            основная, лишние = _выбрать_основную(записи, вес)
            for лишняя in лишние:
                # ЗАПИСЬ В ЖУРНАЛ НА КАЖДУЮ ПАРУ (2026-08-06, живой вопрос
                # «как понять, какие элементы свернулись и какие удалились»).
                # Счётчика «марки: 94» для ответа не хватает: свёртка
                # необратима в том смысле, что удалённой записи больше нет, и
                # единственный способ узнать, что именно исчезло, — журнал.
                # Пишем ДО слияния: после него лишней записи уже не
                # существует, и подпись брать будет неоткуда.
                activity.log(
                    "dictionary_fold", source="system", entity_type=имя,
                    old_value=подпись(лишняя), new_value=подпись(основная),
                    details={"справочник": имя, "свёрнуто": подпись(лишняя),
                             "осталось": подпись(основная),
                             "ссылок у свёрнутой": вес(лишняя),
                             "ссылок у оставшейся": вес(основная)},
                )
                слить(лишняя, основная)
                свёрнуто += 1
        if свёрнуто:
            отчёт.append(f"{имя}: {свёрнуто}")

    # --- контрагенты (вместе со всем, что за ними стоит) ---
    def слить_контрагентов(лишний, основной):
        dd._merge_agreements(conn, лишний["id"], основной["id"], [])
        conn.execute("DELETE FROM counterparties WHERE id = ?", (лишний["id"],))

    свернуть(
        "контрагенты",
        "SELECT id, short_name FROM counterparties",
        lambda r: _ключ_без_регистра(r["short_name"]),
        lambda r: conn.execute("SELECT COUNT(*) AS n FROM agreements WHERE counterparty_id = ?",
                               (r["id"],)).fetchone()["n"],
        слить_контрагентов,
        lambda r: f"«{r['short_name']}»",
    )

    # --- договоры одного контрагента ---
    def слить_договоры(лишний, основной):
        dd._merge_specifications(conn, лишний["id"], основной["id"], [])
        conn.execute("DELETE FROM agreements WHERE id = ?", (лишний["id"],))

    свернуть(
        "договоры",
        "SELECT id, number, counterparty_id FROM agreements",
        lambda r: (r["counterparty_id"], _ключ_без_регистра(r["number"])),
        lambda r: conn.execute("SELECT COUNT(*) AS n FROM specifications WHERE agreement_id = ?",
                               (r["id"],)).fetchone()["n"],
        слить_договоры,
        lambda r: f"договор «{r['number']}»",
    )

    # --- спецификации одного договора ---
    def слить_спецификации(лишняя, основная):
        dd._merge_contracts(conn, лишняя["id"], основная["id"], [])
        conn.execute("DELETE FROM specifications WHERE id = ?", (лишняя["id"],))

    свернуть(
        "спецификации",
        "SELECT id, number, agreement_id FROM specifications",
        lambda r: (r["agreement_id"], _ключ_без_регистра(r["number"])),
        lambda r: conn.execute("SELECT COUNT(*) AS n FROM contracts WHERE specification_id = ?",
                               (r["id"],)).fetchone()["n"],
        слить_спецификации,
        lambda r: f"спецификация «{r['number']}»",
    )

    # --- марки (в пределах объекта и типа) ---
    # _mark_repoint переводит и ссылку, и ТЕКСТ марки у изделий, и позиции
    # контрактов — то есть после свёртки написание становится одним везде.
    def слить_марки(лишняя, основная):
        dd._mark_repoint(conn, лишняя, основная)
        dd._mark_delete(conn, лишняя)

    свернуть(
        "марки",
        "SELECT * FROM marks",
        lambda r: (r["object_id"], r["element_type"], _ключ_без_регистра(r["name"])),
        lambda r: conn.execute("SELECT COUNT(*) AS n FROM elements WHERE mark_id = ?",
                               (r["id"],)).fetchone()["n"],
        слить_марки,
        lambda r: f"{r['element_type']} «{r['name']}»",
    )

    # --- подтипы одного типа ---
    def слить_подтипы(лишний, основной):
        dd._subtype_repoint(conn, лишний, основной)
        dd._subtype_delete(conn, лишний)

    свернуть(
        "подтипы",
        "SELECT rowid AS id, element_type, subtype FROM allowed_subtypes",
        lambda r: (r["element_type"], _ключ_без_регистра(r["subtype"])),
        lambda r: conn.execute(
            "SELECT COUNT(*) AS n FROM elements WHERE element_type = ? AND subtype = ?",
            (r["element_type"], r["subtype"])).fetchone()["n"],
        слить_подтипы,
        lambda r: f"{r['element_type']} / «{r['subtype']}»",
    )

    # --- префиксы марок НЕ сворачиваются ---
    # Их регистровые варианты («КН» и «Кн», «Кс» и «кс») стоят в сидинге
    # НАМЕРЕННО (_MARK_TYPE_PREFIX_SEED, app/db.py): сравнение префикса с
    # маркой было точным, и двойник был единственным способом узнать марку,
    # набранную иначе. С 2026-08-06 сравнение регистронезависимое
    # (_resolve_element_type, app/contracting_import.py), двойники стали
    # безвредны — но свернуть их нельзя: сидинг заводит их заново на КАЖДОМ
    # старте, и обработка удаляла бы их снова и снова, вечно сообщая о
    # проделанной работе (поймано холостым прогоном: «префиксы марок: 2» на
    # базе, где дублей уже не было).

    return ("свёрнуто задвоенных — " + ", ".join(отчёт)) if отчёт else "задвоенных записей не найдено"


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
    {
        "name": "2026-08-05-marks-catalog",
        "version": "0.37",
        "title": "Разложить марки по справочнику",
        "why": "марка была свободным текстом, и одно и то же изделие, набранное в разном "
               "регистре, расщеплялось по двум веткам фильтров и остатков контракта; "
               "справочник даёт марке одну запись, которую можно переименовать и свернуть",
        "kind": KIND_DATA,
        "run": _fill_marks_catalog,
    },
    {
        "name": "2026-08-06-fold-case-duplicates",
        "version": "0.41",
        "title": "Свернуть записи справочников, различающиеся только регистром",
        "why": "«К-1» и «к-1» — одна и та же марка, но система считала их разными: "
               "изделия расщеплялись по двум веткам фильтров, подписей и остатков контракта",
        "kind": KIND_DATA,
        "run": _fold_case_duplicates,
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


def run_by_name(name: str) -> Optional[dict]:
    """Выполнить обработку по имени независимо от того, выполнялась ли она.

    Нужна двум местам: кнопке администратора (повтор упавшей, запуск уборки)
    и холостому прогону перед деплоем (scripts/dry_run_migration.py), который
    прогоняет обработки ВТОРОЙ раз, чтобы проверить их идемпотентность на
    реальных данных сервера. None — обработки с таким именем нет.
    """
    task = next((t for t in RELEASE_TASKS if t["name"] == name), None)
    return None if task is None else _run_one(task)


def data_task_names() -> list:
    """Имена обработок, которые выполняются сами при старте (без уборки)."""
    return [t["name"] for t in RELEASE_TASKS if t.get("kind", KIND_DATA) == KIND_DATA]


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
