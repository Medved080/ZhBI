import os
import sqlite3
import uuid
from pathlib import Path

# ZHBI_DB_PATH — путь к базе. По умолчанию data/zhbi.db рядом с кодом (так
# было всегда, и на этом держится bind-mount в Docker: см.
# docker-compose.yml, том на /app/data). Переменная нужна для запуска
# сервиса на ИЗОЛИРОВАННОЙ копии данных: методология проекта — проверять
# правки живым браузером на копии реальной БД, а не на боевой, и раньше для
# этого приходилось копировать дерево кода целиком (Path(__file__).resolve()
# идёт по симлинкам и всё равно приводил к настоящей базе).
DB_PATH = Path(os.environ.get("ZHBI_DB_PATH") or Path(__file__).resolve().parent.parent / "data" / "zhbi.db")
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Колонки, добавленные в существующие таблицы уже после первого релиза схемы.
# CREATE TABLE IF NOT EXISTS в schema.sql не трогает таблицы, которые уже
# существуют на диске — без этого пользователи с накопленной БД теряли бы
# доступ к новым полям (или падали бы на INSERT/SELECT) после обновления,
# пока не удалят data/zhbi.db вручную.
_COLUMN_MIGRATIONS = [
    ("status_history", "changed_by_user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"),
    ("elements", "contract_id", "INTEGER REFERENCES contracts(id) ON DELETE SET NULL"),
    ("status_history", "contract_id", "INTEGER REFERENCES contracts(id) ON DELETE SET NULL"),
    # JSON-список вершин контура в мировых координатах (см. scripts/parse_zhbi.py
    # ElementRecord.outline) — есть только у элементов, извлечённых из
    # LWPOLYLINE, NULL у элементов из INSERT-блоков. Нужен для отображения
    # вытянутых элементов (ригелей) на схеме их настоящей формой.
    ("elements", "outline_json", "TEXT"),
    # Поля нового стандарта имён слоёв (см. scripts/layer_naming.py) —
    # заполняются только для элементов, чей слой распознан этим стандартом;
    # для старых файлов (LAYER_CONFIG) остаются NULL.
    ("elements", "subtype", "TEXT"),
    ("elements", "elevation_mm", "INTEGER"),
    ("elements", "zone_zakhvatka_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_zakhvatka_status", "TEXT"),
    ("elements", "zone_crane_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_crane_status", "TEXT"),
    ("elements", "zone_stance_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("elements", "zone_stance_status", "TEXT"),
    # Только у зон category='Стоянка' — зона категории 'Кран', в чьей
    # рабочей зоне физически находится эта стоянка (см.
    # scripts/zone_parser._link_stances_to_cranes, Docs/backlog.md).
    ("zones", "parent_zone_id", "INTEGER REFERENCES zones(id) ON DELETE SET NULL"),
    ("zones", "parent_match_status", "TEXT"),
    # ("contracts", "code", ...) сюда сознательно НЕ входит и был убран —
    # "Контрактация 2.0" (см. Docs/backlog.md) переносит короткий код на
    # counterparties.code; если оставить эту миграцию, _apply_migrations
    # будет молча возвращать contracts.code на каждом следующем старте
    # приложения (_migrate_contracts_hierarchy — одноразовая по маркеру
    # supplier, снять код второй раз ей уже нечем).
    # ("contracts", "contract_date", ...) — та же ловушка, тем же способом
    # убрана отсюда 2026-07-28: contract_date больше не поле контракта
    # (наименование генерируется, дата — из спецификации, см.
    # _migrate_contracts_theme ниже) — если бы миграция осталась здесь,
    # _apply_migrations молча возвращала бы contract_date на каждом
    # старте, а _migrate_contracts_theme (одноразовая, по маркеру "name")
    # снять её второй раз уже не сможет.
    # Персональный цвет подписей марок (2D/3D) — NULL = использовать
    # дефолт (см. DEFAULT_LABEL_COLOR на фронтенде).
    ("users", "label_color", "TEXT"),
    # Этаж — из суффикса "_этаж N" в конце имени слоя нового стандарта
    # (см. scripts/layer_naming.py, Docs/backlog.md, "Свойство 'этаж'").
    # NULL у элементов, чьи слои этот суффикс ещё не проставляют.
    ("elements", "floor", "INTEGER"),
    # "Контрактация 2.0" (см. Docs/backlog.md) — четыре независимые шкалы
    # дат поставки элемента. planned/actual пишутся индивидуально на каждый
    # физический элемент (не на партию, партии убраны); project_* —
    # заполняются импортом графика MS Project по блоку
    # Кран/Стоянка/Этаж/Тип/Подтип (см. app/schedule_import.py).
    ("elements", "planned_delivery_date", "TEXT"),
    ("elements", "project_delivery_date", "TEXT"),
    ("elements", "project_smr_start_date", "TEXT"),
    ("elements", "actual_delivery_date", "TEXT"),
    # Подпункт "Даты" в Настройках (см. Docs/backlog.md) — независимый от
    # visible переключатель допстроки (код контрагента + плановая дата) по
    # типу элемента. NOT NULL DEFAULT 1 — сохраняет прежнее поведение
    # (допстрока показывалась всегда) для уже накопленных БД.
    ("label_visibility", "dates_visible", "INTEGER NOT NULL DEFAULT 1"),
    # Объект и сквозная идентичность элемента (2026-07-30, этап 1, решения
    # О1/И1 — см. Docs/backlog.md, запись "Задача… объекты системы").
    #
    # object_id — к какому объекту относится элемент. NULL у элементов
    # УСТАРЕВШИХ версий чертежа: по решению И5 старые версии в объект не
    # переносятся, но и не удаляются (в БД накопились 260713…260722), они
    # просто остаются вне новой модели.
    #
    # element_uid — стабильный ВНЕШНИЙ ключ элемента, живущий дольше любого
    # чертежа. Внутри БД идентичность несёт elements.id (история, контракты
    # и даты ссылаются на него, и переимпорт теперь ОБНОВЛЯЕТ строку, а не
    # создаёт новую), а uid нужен наружу: в выгрузку XLS и обратный импорт,
    # где сопоставление по (source_file, dxf_handle) ломается ровно тогда,
    # когда заказчик перерисовал чертёж (замеры — в той же записи backlog:
    # дважды из шести переходов handle обнулялись полностью).
    #
    # is_current — элемент присутствует в АКТУАЛЬНОМ чертеже объекта. 0 =
    # исчез из чертежа (решение И2, п.3): строка, история и статусы
    # сохраняются, но на схеме и в фильтрах элемента больше нет.
    ("elements", "object_id", "INTEGER REFERENCES objects(id) ON DELETE SET NULL"),
    ("elements", "element_uid", "TEXT"),
    ("elements", "is_current", "INTEGER NOT NULL DEFAULT 1"),
    # Справочники зон (2026-07-30, этап 2 — решения З5, З7, З9, З15). Зона
    # перестаёт быть производной от чертежа и становится записью
    # справочника уровня Объекта; геометрия ярусов переезжает в zone_levels.
    #
    # number — НОМЕР зоны, целое (решение З9). Первично разбирается из имени
    # («Стоянка 01» -> 1, ведущие нули срезаются: формат имени менялся между
    # версиями чертежа — в 260720 «Стоянка 1», в 260723 «Стоянка 01», и по
    # строке имени одна и та же стоянка не сопоставилась бы). Уникален:
    # кран и захватка — в рамках объекта, стоянка — в рамках своего крана.
    #
    # is_current — зона присутствует в актуальном чертеже объекта. 0 =
    # помечена неактуальной (решение З4): не удаляется, но скрывается из
    # схемы и фильтров.
    ("zones", "object_id", "INTEGER REFERENCES objects(id) ON DELETE SET NULL"),
    ("zones", "number", "INTEGER"),
    ("zones", "is_current", "INTEGER NOT NULL DEFAULT 1"),
    # Ярус стоянки, к которому привязан элемент (решение З10). До этого ярус
    # был закодирован в самом zone_stance_id — каждая ярусная запись была
    # отдельной зоной; после склейки ярусов в одну запись справочника эта
    # информация потерялась бы.
    ("elements", "zone_stance_level_id", "INTEGER REFERENCES zone_levels(id) ON DELETE SET NULL"),
    # Поля, правленные РУКАМИ в справочнике элементов (этап 3, решение Э4) —
    # JSON-список имён колонок. Переимпорт чертежа их не перезаписывает, а
    # показывает расхождение в сводке: пользователь выбирает, оставить ручное
    # значение или перезаполнить из чертежа. Без этого признака ручная правка
    # жила бы до первой загрузки нового чертежа и молча исчезала.
    ("elements", "manual_fields", "TEXT"),
]


def _apply_migrations(conn: sqlite3.Connection, changes: list) -> None:
    for table, column, coltype in _COLUMN_MIGRATIONS:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
            changes.append(f"добавлена колонка {table}.{column}")


def _migrate_contracts_structure(conn: sqlite3.Connection) -> None:
    """
    Раунд 2 хранил контракт как одну строку (название+поставщик+тип+кол-во).
    Раунд 3 (Docs/backlog.md, п.8) вводит нормальную структуру: контракт
    (название, поставщик) + строки contract_lines (тип, количество) внутри
    него. На новой БД CREATE TABLE IF NOT EXISTS в schema.sql уже создаёт
    новую форму сразу — эта функция нужна только для БД, накопленных со
    старой формой (наличие столбца element_type в contracts — маркер).
    Группировка старых строк в контракты — по (name, supplier).
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(contracts)")}
    if "element_type" not in cols:
        return

    # ВАЖНО: ALTER TABLE ... RENAME TO молча переписывает FK-констрейнты в ДРУГИХ
    # таблицах (elements.contract_id, default_contracts.contract_id), которые
    # ссылались на "contracts", так что они начинают ссылаться на "contracts_old".
    # Без отключения foreign_keys последующий DROP TABLE contracts_old запускает
    # ON DELETE SET NULL по этим констрейнтам и обнуляет то, что мы только что
    # аккуратно перенесли на новые id (найдено и проверено эмпирически). Не
    # включаем PRAGMA обратно явно — это соединение короткоживущее (закрывается
    # в конце init_db()), а любое новое соединение уже получает foreign_keys=ON
    # по умолчанию через get_connection().
    #
    # PRAGMA foreign_keys — no-op, если вызвана посреди уже открытой
    # транзакции (документированное поведение SQLite) — тогда foreign_keys
    # молча ОСТАЁТСЯ включённой, RENAME переписывает FK ДРУГИХ таблиц на
    # "contracts_old", и после DROP TABLE contracts_old эти FK становятся
    # битыми НАВСЕГДА (ссылка на несуществующую таблицу, сохраняется в
    # sqlite_master) — проявляется как "no such table: main.contracts_old"
    # при следующей же операции с этими таблицами, даже в СЛЕДУЮЩЕМ запуске
    # сервера. commit() здесь безопасен — все более ранние шаги уже
    # представляют собой согласованное состояние, не полуготовое.
    if conn.in_transaction:
        conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE contracts RENAME TO contracts_old")
    conn.execute(
        """
        CREATE TABLE contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            supplier TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contract_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id INTEGER NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
            element_type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            UNIQUE (contract_id, element_type)
        )
        """
    )

    old_rows = conn.execute("SELECT * FROM contracts_old ORDER BY id").fetchall()
    group_to_new_id = {}
    id_map = {}
    for row in old_rows:
        key = (row["name"], row["supplier"])
        if key not in group_to_new_id:
            conn.execute(
                "INSERT INTO contracts (name, supplier, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (row["name"], row["supplier"], row["created_at"], row["updated_at"]),
            )
            group_to_new_id[key] = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        new_id = group_to_new_id[key]
        id_map[row["id"]] = new_id
        conn.execute(
            "INSERT INTO contract_lines (contract_id, element_type, quantity) VALUES (?, ?, ?) "
            "ON CONFLICT(contract_id, element_type) DO UPDATE SET quantity = excluded.quantity",
            (new_id, row["element_type"], row["quantity"]),
        )

    for old_id, new_id in id_map.items():
        conn.execute("UPDATE elements SET contract_id = ? WHERE contract_id = ?", (new_id, old_id))
        conn.execute("UPDATE default_contracts SET contract_id = ? WHERE contract_id = ?", (new_id, old_id))

    conn.execute("DROP TABLE contracts_old")


def _migrate_contracts_hierarchy(conn: sqlite3.Connection) -> None:
    """
    "Контрактация 2.0" (см. Docs/backlog.md) заменяет contracts.supplier
    (свободный текст) на цепочку specification_id -> agreements ->
    counterparties, а contract_lines получает mark. Живой запрос
    пользователя — тестовый контур, старые contracts/contract_lines/
    contract_incidents/batches/batch_lines НЕ переносятся, а сбрасываются
    (маркер старой формы — наличие столбца supplier в contracts; на новой
    БД CREATE TABLE IF NOT EXISTS в schema.sql уже создаёт новую форму
    сразу, эта функция тогда не находит supplier и сразу возвращается).
    Тот же rename->create->drop приём, что уже применялся в
    _migrate_contracts_structure выше (там же — почему PRAGMA foreign_keys
    выключается на время rename+drop).
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(contracts)")}
    if "supplier" not in cols:
        return

    # PRAGMA foreign_keys — no-op посреди уже открытой транзакции (например,
    # если _migrate_contracts_structure выше только что сделала свою DML-
    # тяжёлую миграцию в ЭТОМ ЖЕ соединении и не закоммитила) — тогда
    # foreign_keys молча остаётся включённой, RENAME ниже переписывает FK
    # других таблиц на "contracts_old_v3", и после DROP они становятся
    # битыми навсегда ("no such table: main.contracts_old_v3" при первой же
    # операции с этими таблицами, в т.ч. на следующем запуске сервера — живой
    # инцидент, см. Docs/backlog.md). commit() здесь безопасен — то, что
    # сделала предыдущая миграция, уже согласованное состояние.
    if conn.in_transaction:
        conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DELETE FROM contract_incidents")
    conn.execute("DELETE FROM contract_lines")
    has_batches = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='batches'"
    ).fetchone()
    if has_batches:
        conn.execute("DELETE FROM batch_lines")
        conn.execute("DELETE FROM batches")
    conn.execute("UPDATE elements SET contract_id = NULL")
    if "batch_id" in {row["name"] for row in conn.execute("PRAGMA table_info(elements)")}:
        conn.execute("UPDATE elements SET batch_id = NULL")
    conn.execute("UPDATE status_history SET contract_id = NULL")
    conn.execute("UPDATE default_contracts SET contract_id = NULL")

    conn.execute("ALTER TABLE contracts RENAME TO contracts_old_v3")
    conn.execute(
        """
        CREATE TABLE contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            specification_id INTEGER NOT NULL REFERENCES specifications (id) ON DELETE RESTRICT,
            contract_date TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute("DROP TABLE contracts_old_v3")

    conn.execute("ALTER TABLE contract_lines RENAME TO contract_lines_old_v3")
    conn.execute(
        """
        CREATE TABLE contract_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contract_id INTEGER NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
            element_type TEXT,
            mark TEXT,
            quantity INTEGER NOT NULL
        )
        """
    )
    conn.execute("DROP TABLE contract_lines_old_v3")

    conn.execute("DROP TABLE IF EXISTS batch_lines")
    conn.execute("DROP TABLE IF EXISTS batches")


def _migrate_contracts_theme(conn: sqlite3.Connection) -> None:
    """
    Наименование контракта больше не хранится, генерируется всегда заново
    из цепочки Контрагент/Договор/Спецификация + theme (см.
    build_contract_name, app/contracts.py, живой запрос пользователя,
    2026-07-28) — "name" и "contract_date" убраны из contracts, добавлена
    "theme" (свободный текст). Маркер старой формы — наличие столбца
    "name" (на новой БД CREATE TABLE в schema.sql уже создаёт новую форму
    сразу, эта функция тогда не находит "name" и сразу возвращается).
    ALTER TABLE ... DROP COLUMN — обычная rename→create→drop миграция
    здесь не нужна: DROP COLUMN не переименовывает саму таблицу "contracts"
    (в отличие от _migrate_contracts_hierarchy выше), поэтому FK-ссылки на
    неё в других таблицах (contract_lines.contract_id и т.д.) не рискуют
    быть молча переписаны на временное имя — тот баг, из-за которого
    ПЕРЕД PRAGMA foreign_keys = OFF выше стоит commit(), здесь просто не
    может произойти. Commit перед ALTER всё равно ставим — тот же общий
    принцип (не полагаться на состояние транзакции, оставшееся от
    предыдущей миграции).

    ВАЖНО: три условия ("name" есть / "contract_date" есть / "theme" нет)
    проверяются и применяются НЕЗАВИСИМО, не одним общим ранним return по
    "name" — живой пойманный случай: столбец "contract_date" одно время
    ОДНОВРЕМЕННО был и в _COLUMN_MIGRATIONS (ADD COLUMN, ещё старая
    запись), и уже удалялся этой функцией. При автоперезагрузке сервера
    (uvicorn --reload) между двумя правками этого файла порядок миграций
    в одном запуске воскрешал "contract_date" уже ПОСЛЕ того, как "name"
    была снята — общий ранний return по "name" тогда молча пропустил бы
    повторное удаление "contract_date" навсегда (тот же класс ошибки, что
    и историческая ловушка с contracts.code, см. _COLUMN_MIGRATIONS выше).
    Независимые проверки каждого столбца самовосстанавливаются от любого
    такого частичного состояния, а не только от чистого "до"/"после".
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(contracts)")}
    if "name" not in cols and "contract_date" not in cols and "theme" in cols:
        return
    if conn.in_transaction:
        conn.commit()
    if "name" in cols:
        conn.execute("ALTER TABLE contracts DROP COLUMN name")
    if "contract_date" in cols:
        conn.execute("ALTER TABLE contracts DROP COLUMN contract_date")
    if "theme" not in cols:
        conn.execute("ALTER TABLE contracts ADD COLUMN theme TEXT")


def _migrate_elements_drop_batch_id(conn: sqlite3.Connection, changes: list) -> None:
    """Снимает колонку elements.batch_id — остаток убранных "Партий"
    ("Контрактация 2.0", 2026-07-28): таблицу batches тогда удалили, а
    колонку с внешним ключом на неё оставили.

    Это НЕ уборка мусора, а исправление поломки: с PRAGMA foreign_keys = ON
    (его включает get_connection) SQLite разрешает цель внешнего ключа в
    момент ЗАПИСИ, поэтому схема проходила init_db() молча, а любая вставка
    в elements падала на "no such table: main.batches" — то есть загрузка
    любого чертежа была невозможна (см. Docs/backlog.md, 2026-07-30).

    ALTER TABLE ... DROP COLUMN, а НЕ приём rename->create->drop: проверено
    эмпирически (см. запись backlog), DROP COLUMN убирает и колонку, и её
    висячий FK, при этом НЕ переименовывает таблицу elements — значит
    внешние ключи ДРУГИХ таблиц на elements (status_history.element_id и
    др.) не могут быть молча переписаны на временное имя. Именно на таком
    переименовании проект однажды потерял FK навсегда
    (_migrate_contracts_hierarchy, "Второй раунд" в backlog), поэтому здесь
    выбран путь, где этого класса ошибки просто нет. Требует SQLite 3.35+
    (в образе python:3.12-slim — 3.40+, локально 3.51).

    commit перед PRAGMA foreign_keys = OFF — обязателен: посреди уже
    открытой транзакции PRAGMA молча не срабатывает (документированное
    поведение SQLite), и ровно это когда-то испортило схему. Здесь колонка
    не индексирована и данных в ней нет (проверено на боевой БД: 39545
    строк, 0 непустых batch_id), так что перенос данных не нужен.
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(elements)")}
    if "batch_id" not in cols:
        return
    if conn.in_transaction:
        conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE elements DROP COLUMN batch_id")
    changes.append("снята колонка elements.batch_id (висячий внешний ключ на удалённую таблицу batches)")


def _ensure_element_uid_index(conn: sqlite3.Connection) -> None:
    """Уникальность element_uid — частичным индексом (WHERE ... NOT NULL):
    uid есть только у элементов, привязанных к объекту, а обычный UNIQUE в
    SQLite не считает NULL=NULL, так что NULL-строки индексу не помешали бы
    и без условия — но с ним индекс ещё и не хранит их вовсе (элементов
    устаревших версий чертежа в БД больше, чем актуальных).

    Создаётся здесь, а не в schema.sql, по той же причине, что и соседние
    индексы: колонка добавляется миграцией (_COLUMN_MIGRATIONS), а
    executescript отрабатывает РАНЬШЕ миграций — на ещё не мигрированной
    БД CREATE INDEX упал бы."""
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_elements_uid "
        "ON elements (element_uid) WHERE element_uid IS NOT NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_elements_object ON elements (object_id, is_current)"
    )


def _bootstrap_default_object(conn: sqlite3.Connection, changes: list) -> None:
    """Заводит первый Объект на уже накопленной БД и привязывает к нему
    АКТУАЛЬНЫЙ чертёж. Идемпотентно: срабатывает только когда таблица
    objects пуста, а элементы уже есть — то есть ровно один раз, при
    обновлении существующей установки.

    Актуальным считается чертёж с самым большим elements.id — то есть
    загруженный последним. Не по имени файла: имена вида "260723_..."
    сортируются по дате только пока заказчик не сменит схему именования, а
    порядок загрузки известен точно.

    Старые версии чертежа (в накопленной БД это 260713…260722) остаются с
    object_id IS NULL и is_current=0 — решение И5 ("актуален только
    последний"). Ничего не удаляется: строки, статусы и история на месте,
    просто эти элементы вне новой модели. Удалять их — отдельное осознанное
    действие пользователя, не побочный эффект обновления версии.
    """
    if conn.execute("SELECT 1 FROM objects LIMIT 1").fetchone():
        return
    latest = conn.execute(
        "SELECT source_file, MAX(id) AS last_id FROM elements "
        "GROUP BY source_file ORDER BY last_id DESC LIMIT 1"
    ).fetchone()
    if latest is None:
        return  # пустая БД — объект появится при первом импорте

    source_file = latest["source_file"]
    conn.execute(
        "INSERT INTO objects (name, description) VALUES (?, ?)",
        ("Объект 1", "Заведён автоматически при переходе на модель объектов; переименуйте в «Действия → Объекты»."),
    )
    object_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.execute(
        "INSERT INTO object_drawings (object_id, source_file, is_current) VALUES (?, ?, 1)",
        (object_id, source_file),
    )
    conn.execute(
        "UPDATE elements SET object_id = ?, is_current = 1 WHERE source_file = ?",
        (object_id, source_file),
    )
    conn.execute(
        "UPDATE elements SET is_current = 0 WHERE source_file <> ?", (source_file,)
    )
    assign_missing_element_uids(conn, object_id)


def parse_zone_number(name) -> "int | None":
    """Номер зоны из её имени: «Стоянка 01» -> 1, «Кран 2» -> 2 (решение З9).

    Ведущие нули срезаются намеренно: формат имени менялся между версиями
    чертежа (в 260720 «Стоянка 1», в 260723 «Стоянка 01»), и если бы номер
    хранил «01» строкой, одна и та же стоянка при переимпорте не
    сопоставилась бы сама с собой. Берётся ПОСЛЕДНЕЕ число в строке —
    в реальных именах номер стоит в конце, а в начале может оказаться
    отметка или ярус.
    """
    if not name:
        return None
    import re

    matches = re.findall(r"\d+", str(name))
    return int(matches[-1]) if matches else None


def _migrate_zones_to_catalog(conn: sqlite3.Connection, changes: list) -> None:
    """Сворачивает ярусные записи zones в записи СПРАВОЧНИКА + zone_levels
    (решения З5/З7/З9) и переносит на них ссылки элементов.

    Маркер выполненности — непустая zone_levels: миграция одноразовая.

    Что переносится: зоны АКТУАЛЬНОГО чертежа объекта. Зоны устаревших
    версий чертежа остаются строками старой формы (с собственным
    outline_json, object_id IS NULL, is_current=0) — то же решение И5, что и
    для элементов: старые версии не переносим, но и не удаляем, чтобы уже
    загруженные чертежи продолжали рисоваться. Поэтому колонка
    zones.outline_json НЕ удаляется — она остаётся носителем геометрии для
    этих legacy-строк, а у записей справочника пустая.

    Ссылки elements.zone_*_id перевешиваются с ярусной записи на запись
    справочника, а для стоянки дополнительно заполняется
    zone_stance_level_id — иначе потерялось бы, к какому именно ярусу
    привязан элемент (решение З10).
    """
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "zone_levels" not in tables:
        return
    if conn.execute("SELECT 1 FROM zone_levels LIMIT 1").fetchone():
        return

    current = conn.execute(
        "SELECT object_id, source_file FROM object_drawings WHERE is_current = 1"
    ).fetchall()
    if not current:
        return

    for drawing in current:
        object_id, source_file = drawing["object_id"], drawing["source_file"]
        rows = conn.execute(
            "SELECT * FROM zones WHERE source_file = ? ORDER BY id", (source_file,)
        ).fetchall()
        if not rows:
            continue

        # Группировка ярусных записей в записи справочника. Ключ — категория
        # + номер + родительский кран: номер стоянки уникален только внутри
        # своего крана («Стоянка 1» есть у каждого из трёх кранов).
        # Родитель на этом шаге — ещё СТАРЫЙ zones.id крана; на новый
        # пересчитывается вторым проходом, когда все записи справочника уже
        # созданы.
        groups = {}
        for row in rows:
            number = parse_zone_number(row["name"])
            key = (row["category"], number, row["name"], row["parent_zone_id"])
            groups.setdefault(key, []).append(row)

        # Старым строкам временно меняем dxf_handle: на zones висит
        # UNIQUE (source_file, dxf_handle), а запись справочника наследует
        # handle своего первого яруса — вставка столкнулась бы с ещё живой
        # ярусной строкой. Удалить старые строки ЗАРАНЕЕ нельзя: на
        # elements.zone_*_id стоит ON DELETE SET NULL, и ссылки обнулились бы
        # до того, как мы их перевесим.
        conn.execute(
            "UPDATE zones SET dxf_handle = dxf_handle || ':перенос' WHERE source_file = ?",
            (source_file,),
        )

        old_to_new, old_to_level, new_by_old_parent = {}, {}, {}
        for (category, number, name, old_parent), level_rows in groups.items():
            first = level_rows[0]
            conn.execute(
                "INSERT INTO zones (object_id, source_file, dxf_handle, category, elevation_mm, "
                "name, outline_json, match_status, parent_match_status, number, is_current) "
                "VALUES (?, ?, ?, ?, NULL, ?, '', ?, ?, ?, 1)",
                (object_id, source_file, first["dxf_handle"], category, name,
                 first["match_status"], first["parent_match_status"], number),
            )
            new_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            new_by_old_parent[new_id] = old_parent
            for level in level_rows:
                conn.execute(
                    "INSERT INTO zone_levels (zone_id, elevation_mm, outline_json, source_file, dxf_handle) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (new_id, level["elevation_mm"], level["outline_json"],
                     level["source_file"], level["dxf_handle"]),
                )
                old_to_new[level["id"]] = new_id
                old_to_level[level["id"]] = conn.execute(
                    "SELECT last_insert_rowid() AS id").fetchone()["id"]

        # Родитель стоянки — на новую запись крана.
        for new_id, old_parent in new_by_old_parent.items():
            if old_parent is not None and old_parent in old_to_new:
                conn.execute(
                    "UPDATE zones SET parent_zone_id = ? WHERE id = ?",
                    (old_to_new[old_parent], new_id),
                )

        # Ссылки элементов: на запись справочника, плюс ярус у стоянки.
        for column in ("zone_zakhvatka_id", "zone_crane_id", "zone_stance_id"):
            for old_id, new_id in old_to_new.items():
                if column == "zone_stance_id":
                    # Ярус берём из соответствия, построенного при вставке:
                    # каждая старая ярусная строка стала ровно одной строкой
                    # zone_levels (искать по handle было бы лишним запросом
                    # и лишним допущением).
                    conn.execute(
                        f"UPDATE elements SET zone_stance_id = ?, zone_stance_level_id = ? "
                        f"WHERE {column} = ?",
                        (new_id, old_to_level.get(old_id), old_id),
                    )
                else:
                    conn.execute(
                        f"UPDATE elements SET {column} = ? WHERE {column} = ?", (new_id, old_id)
                    )

        # Старые ярусные строки этого чертежа больше не нужны: их геометрия
        # уже в zone_levels, ссылки переведены.
        placeholders = ", ".join("?" for _ in old_to_new)
        conn.execute(f"DELETE FROM zones WHERE id IN ({placeholders})", tuple(old_to_new))
        changes.append(
            f"зоны чертежа {source_file} переведены в справочник: "
            f"записей {len(groups)}, ярусов {len(old_to_new)}"
        )

    # Зоны устаревших версий чертежа — вне справочника (решение И5).
    conn.execute(
        "UPDATE zones SET is_current = 0 WHERE object_id IS NULL AND is_current <> 0"
    )


# Типы, которые физически ВЕНЧАЮТ ярус снизу и потому относятся к ярусу
# СТРОГО ниже своей отметки. Дубль scripts/zone_binding.TIER_CAPPING_TYPES —
# осознанный: app/db.py не должен зависеть от scripts/ (миграция обязана
# работать в любом окружении, включая CLI без sys.path на scripts). При
# расхождении источник истины — zone_binding, там это правило и живёт.
_TIER_CAPPING_TYPES = {"Плита перекрытия", "Ригель"}


def _heal_zone_stance_levels(conn: sqlite3.Connection, changes: list) -> int:
    """Дозаполняет elements.zone_stance_level_id там, где он пуст, а стоянка
    у элемента известна.

    Зачем отдельно от _migrate_zones_to_catalog: миграция одноразовая по
    маркеру «zone_levels не пуста», и если она отработала ПРОМЕЖУТОЧНОЙ
    версией кода (ровно это и случилось на машине разработчика — локальный
    `uvicorn --reload` применил миграцию к боевой БД на первом же сохранении
    файла, ещё до того, как перенос яруса был доведён), то повторно она уже
    не запустится и поле осталось бы пустым навсегда. Тот же принцип, что у
    _migrate_contracts_theme: чиниться от любого частичного состояния, а не
    только от чистого «до»/«после».

    Правило выбора яруса повторяет прямой снэп из scripts/zone_binding:
    ближайший ярус стоянки НЕ ВЫШЕ отметки элемента, а для Ригеля и Плиты
    перекрытия — строго НИЖЕ (они венчают ярус снизу, лежат на его колоннах).
    После первого же переимпорта чертежа или пересчёта привязки поле
    перезапишется настоящим расчётом — здесь важно не оставить его пустым.

    Идемпотентна: трогает только строки с NULL.
    """
    if not conn.execute("SELECT 1 FROM zone_levels LIMIT 1").fetchone():
        return 0
    rows = conn.execute(
        "SELECT id, element_type, elevation_mm, zone_stance_id FROM elements "
        "WHERE zone_stance_id IS NOT NULL AND zone_stance_level_id IS NULL"
    ).fetchall()
    if not rows:
        return 0

    levels_by_zone = {}
    for level in conn.execute("SELECT id, zone_id, elevation_mm FROM zone_levels ORDER BY elevation_mm"):
        levels_by_zone.setdefault(level["zone_id"], []).append(level)

    healed = 0
    for row in rows:
        levels = levels_by_zone.get(row["zone_stance_id"]) or []
        if not levels:
            continue
        if len(levels) == 1:
            chosen = levels[0]
        elif row["elevation_mm"] is None:
            chosen = levels[0]
        else:
            strict = row["element_type"] in _TIER_CAPPING_TYPES
            below = [
                lv for lv in levels
                if lv["elevation_mm"] is not None
                and (lv["elevation_mm"] < row["elevation_mm"] if strict
                     else lv["elevation_mm"] <= row["elevation_mm"])
            ]
            chosen = below[-1] if below else levels[0]
        conn.execute(
            "UPDATE elements SET zone_stance_level_id = ? WHERE id = ?", (chosen["id"], row["id"])
        )
        healed += 1

    if healed:
        changes.append(f"дозаполнен ярус стоянки у элементов: {healed}")
    return healed


def visible_elements_clause(alias: str = "") -> str:
    """Условие «элемент показывается на схеме и в отчётах».

    Элемент, исчезнувший из актуального чертежа объекта (is_current=0),
    сохраняет строку, статус, историю, контракт и даты — но со схемы уходит
    (решение И2, п.3). Без этого условия он остался бы виден: исчезнувшая
    строка сохраняет source_file того чертежа, где её видели последний раз,
    а это ровно тот файл, который сейчас открыт.

    `object_id IS NULL` — элементы УСТАРЕВШИХ версий чертежа, не перенесённые
    в объект (решение И5). Им is_current=0 выставлен бутстрапом, и без этой
    половины условия старые чертежи в списке рисовались бы пустыми — то есть
    выглядели бы как поломка, хотя данные на месте.

    Одна функция вместо повторения условия строками: мест чтения элементов по
    чертежу восемь, и разъехавшееся условие видимости — ровно тот класс
    расхождений, который потом ловится только живым репортом."""
    prefix = f"{alias}." if alias else ""
    return f"({prefix}is_current = 1 OR {prefix}object_id IS NULL)"


def assign_missing_element_uids(conn: sqlite3.Connection, object_id: int) -> int:
    """Выдаёт element_uid всем элементам объекта, у которых его ещё нет.
    Отдельная функция (не внутренность бутстрапа) — тем же вызовом
    пользуется импорт: новые элементы получают uid при вставке, но
    восстановление после ручных правок БД или частично выполненной миграции
    должно уметь дозаполнить пропуски."""
    rows = conn.execute(
        "SELECT id FROM elements WHERE object_id = ? AND element_uid IS NULL", (object_id,)
    ).fetchall()
    for row in rows:
        conn.execute(
            "UPDATE elements SET element_uid = ? WHERE id = ?", (uuid.uuid4().hex, row["id"])
        )
    return len(rows)


def _ensure_zone_level_index(conn: sqlite3.Connection) -> None:
    """Уникальность яруса внутри зоны. COALESCE, а не обычный UNIQUE:
    elevation_mm допускает NULL (захватка и кран приходят без отметки), а
    SQLite не считает NULL=NULL — два яруса без отметки продублировались бы
    молча. Ровно та же ловушка, что уже была в contract_lines."""
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_levels_unique "
        "ON zone_levels (zone_id, COALESCE(elevation_mm, -1000000))"
    )


def _ensure_contract_lines_index(conn: sqlite3.Connection) -> None:
    """Создаётся отдельно от schema.sql, а не CREATE INDEX IF NOT EXISTS
    прямо в скрипте — на существующей БД, ещё не прошедшей
    _migrate_contracts_hierarchy к моменту выполнения executescript,
    contract_lines может быть старой формы (без колонки mark), и CREATE
    INDEX упал бы раньше, чем миграция успела бы пересоздать таблицу.
    Вызывается после обеих структурных миграций, когда форма уже
    гарантированно новая — что на свежей БД (schema.sql создал сразу),
    что на мигрированной. COALESCE на ОБЕИХ колонках — element_type тоже
    допускает NULL (импорт с нераспознанным типом марки, см.
    app/contracting_import.py), обычный UNIQUE(...) в SQLite не считает
    NULL=NULL, без COALESCE две строки-дубликата с одинаковой маркой без
    определённого типа продублировались бы молча."""
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_lines_unique "
        "ON contract_lines (contract_id, COALESCE(element_type, ''), COALESCE(mark, ''))"
    )


def _ensure_elements_contract_line_index(conn: sqlite3.Connection) -> None:
    """Индекс под запрос «сколько элементов уже пришло по этой строке
    контракта» — (contract_id, element_type, mark) с фильтром по
    current_status. Без него это полный скан elements, и он выполнялся:
    (1) на КАЖДУЮ строку каждого контракта при GET /contracts (замерено —
    406 сканов, 2757 мс, из-за чего долго открывалось окно массовой смены
    статуса, см. Docs/backlog.md); (2) на КАЖДЫЙ элемент при смене статуса
    (contract_line_warning → _line_fact, app/contracts.py) — то есть на
    массовой смене статуса тысячи сканов подряд. Первое устранено
    групповым запросом (_load_contract_bundle), второе принципиально
    поштучное и лечится именно индексом.

    Создаётся здесь, а не в schema.sql, по той же причине, что и
    idx_contract_lines_unique выше: elements.contract_id добавляется
    миграцией (_COLUMN_MIGRATIONS), а executescript отрабатывает РАНЬШЕ
    миграций — на ещё не мигрированной БД CREATE INDEX упал бы."""
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_elements_contract_line "
        "ON elements (contract_id, element_type, mark, current_status)"
    )


_MARK_TYPE_PREFIX_SEED = [
    ("КН", "Колонна"), ("Кн", "Колонна"), ("Кс", "Колонна"), ("кс", "Колонна"),
    ("П-", "Плита перекрытия"), ("ПИ-", "Плита перекрытия"), ("Пд-", "Плита перекрытия"),
    ("Р", "Ригель"), ("РИ", "Ригель"), ("Рк", "Ригель"),
    ("ПЦ-", "Панель"),
]

_APP_SETTINGS_SEED = [
    ("info_plate_late_threshold_days", "0"),
]


def _seed_reference_data(conn: sqlite3.Connection) -> None:
    """Идемпотентный сидинг (INSERT OR IGNORE) — безопасно гонять на каждом
    старте, как и _normalize_element_type_vocabulary ниже."""
    conn.executemany(
        "INSERT OR IGNORE INTO mark_type_prefixes (prefix, element_type) VALUES (?, ?)",
        _MARK_TYPE_PREFIX_SEED,
    )
    conn.executemany(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
        _APP_SETTINGS_SEED,
    )


# Старый конвейер (LAYER_CONFIG в scripts/parse_zhbi.py) когда-то отдавал
# английские element_type ("column"/"beam"), новый стандарт имён слоёв —
# русские ("Колонна"/"Ригель"/...) — парсер уже приведён к единому русскому
# словарю (см. Docs/backlog.md), но данные, загруженные ДО этого
# исправления, всё ещё хранят старые значения (а Input/ переобрабатывает
# на каждом старте только файлы, которые сейчас лежат в этой папке — для
# остальных источников самоисправление не сработает).
# "Плита" -> "Плита перекрытия" (2026-07-30): генерик-тип убран из словаря
# (scripts/layer_naming.ZHBI_TYPES), два имени для одного типа расщепляли бы
# элементы по двум веткам фильтров и контрактов. В боевой БД таких записей
# нет, но на другой установке они могли накопиться — без переименования они
# остались бы с типом, которого больше нет в словаре.
_ELEMENT_TYPE_RENAMES = {"column": "Колонна", "beam": "Ригель", "Плита": "Плита перекрытия"}


def _normalize_element_type_vocabulary(conn: sqlite3.Connection, changes: list) -> None:
    """Идемпотентно — можно спокойно гонять на каждом старте (после первого
    успешного прогона английских значений нигде не остаётся, дальше это
    просто холостой обход пустых выборок).

    elements.element_type не участвует ни в каком уникальном ключе — там
    просто UPDATE. label_visibility/default_contracts/element_shapes/
    contract_lines хранят element_type как часть первичного/уникального
    ключа — прямое переименование могло бы столкнуться с уже существующей
    строкой под русским именем; в этом случае оставляем русскую (считаем
    её уже осмысленно настроенной), английскую просто удаляем."""
    for old, new in _ELEMENT_TYPE_RENAMES.items():
        # Сколько строк реально переименовано — попадает в список изменений и
        # дальше в журнал действий (событие schema_migration). Иначе смена
        # словаря типов прошла бы на сервере совершенно молча, и понять, что
        # именно случилось с элементами, было бы нечем.
        affected = conn.execute(
            "SELECT COUNT(*) AS n FROM elements WHERE element_type = ?", (old,)
        ).fetchone()["n"]
        conn.execute("UPDATE elements SET element_type = ? WHERE element_type = ?", (new, old))
        if affected:
            changes.append(f"тип элемента «{old}» переименован в «{new}»: элементов {affected}")

        if conn.execute("SELECT 1 FROM label_visibility WHERE element_type = ?", (new,)).fetchone():
            conn.execute("DELETE FROM label_visibility WHERE element_type = ?", (old,))
        else:
            conn.execute("UPDATE label_visibility SET element_type = ? WHERE element_type = ?", (new, old))

        if conn.execute("SELECT 1 FROM default_contracts WHERE element_type = ?", (new,)).fetchone():
            conn.execute("DELETE FROM default_contracts WHERE element_type = ?", (old,))
        else:
            conn.execute("UPDATE default_contracts SET element_type = ? WHERE element_type = ?", (new, old))

        for row in conn.execute("SELECT layer FROM element_shapes WHERE element_type = ?", (old,)).fetchall():
            layer = row["layer"]
            if conn.execute(
                "SELECT 1 FROM element_shapes WHERE layer = ? AND element_type = ?", (layer, new)
            ).fetchone():
                conn.execute("DELETE FROM element_shapes WHERE layer = ? AND element_type = ?", (layer, old))
            else:
                conn.execute(
                    "UPDATE element_shapes SET element_type = ? WHERE layer = ? AND element_type = ?",
                    (new, layer, old),
                )

        # allowed_subtypes ключуется парой (тип, подтип) — та же коллизия, что
        # и у остальных справочников ниже: при совпадении оставляем строку под
        # новым именем, старую удаляем.
        for row in conn.execute(
            "SELECT subtype FROM allowed_subtypes WHERE element_type = ?", (old,)
        ).fetchall():
            subtype = row["subtype"]
            if conn.execute(
                "SELECT 1 FROM allowed_subtypes WHERE element_type = ? AND subtype = ?", (new, subtype)
            ).fetchone():
                conn.execute(
                    "DELETE FROM allowed_subtypes WHERE element_type = ? AND subtype = ?", (old, subtype)
                )
            else:
                conn.execute(
                    "UPDATE allowed_subtypes SET element_type = ? WHERE element_type = ? AND subtype = ?",
                    (new, old, subtype),
                )

        for row in conn.execute(
            "SELECT contract_id FROM contract_lines WHERE element_type = ?", (old,)
        ).fetchall():
            contract_id = row["contract_id"]
            if conn.execute(
                "SELECT 1 FROM contract_lines WHERE contract_id = ? AND element_type = ?", (contract_id, new)
            ).fetchone():
                conn.execute(
                    "DELETE FROM contract_lines WHERE contract_id = ? AND element_type = ?", (contract_id, old)
                )
            else:
                conn.execute(
                    "UPDATE contract_lines SET element_type = ? WHERE contract_id = ? AND element_type = ?",
                    (new, contract_id, old),
                )


def init_db() -> list:
    """Возвращает список СТРУКТУРНЫХ изменений, реально применённых к базе
    (пустой список — схема уже была актуальной).

    Зачем возвращать, а не журналировать здесь же: init_db вызывается и из
    CLI-скриптов (scripts/rebuild_db.py), где фоновый писатель журнала не
    запущен — записи молча пропали бы в очереди. Вызывающий сам решает, что
    с этим списком делать: сервер пишет его в журнал действий после старта
    писателя (app/main.on_startup), скрипты печатают."""
    changes = []
    conn = get_connection()
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        _apply_migrations(conn, changes)
        _migrate_contracts_structure(conn)
        _migrate_contracts_hierarchy(conn)
        _migrate_contracts_theme(conn)
        # Строго ПОСЛЕ миграций контрактов: _migrate_contracts_hierarchy на
        # старой БД ещё обнуляет batch_id, пока колонка существует.
        _migrate_elements_drop_batch_id(conn, changes)
        _ensure_contract_lines_index(conn)
        _ensure_elements_contract_line_index(conn)
        _ensure_element_uid_index(conn)
        _bootstrap_default_object(conn, changes)
        # Строго ПОСЛЕ бутстрапа объекта: миграция зон опирается на
        # object_drawings, чтобы понять, какой чертёж актуален.
        _migrate_zones_to_catalog(conn, changes)
        _ensure_zone_level_index(conn)
        # Не часть одноразовой миграции: чинит частичное состояние, если
        # миграция зон отработала промежуточной версией кода (см. docstring).
        _heal_zone_stance_levels(conn, changes)
        _normalize_element_type_vocabulary(conn, changes)
        _seed_reference_data(conn)
        conn.commit()
    finally:
        conn.close()
    return changes
