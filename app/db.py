import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "zhbi.db"
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
]


def _apply_migrations(conn: sqlite3.Connection) -> None:
    for table, column, coltype in _COLUMN_MIGRATIONS:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


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
_ELEMENT_TYPE_RENAMES = {"column": "Колонна", "beam": "Ригель"}


def _normalize_element_type_vocabulary(conn: sqlite3.Connection) -> None:
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
        conn.execute("UPDATE elements SET element_type = ? WHERE element_type = ?", (new, old))

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


def init_db() -> None:
    conn = get_connection()
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        _apply_migrations(conn)
        _migrate_contracts_structure(conn)
        _migrate_contracts_hierarchy(conn)
        _migrate_contracts_theme(conn)
        _ensure_contract_lines_index(conn)
        _normalize_element_type_vocabulary(conn)
        _seed_reference_data(conn)
        conn.commit()
    finally:
        conn.close()
