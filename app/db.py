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
    # Цветовая гамма интерфейса — ПЕРСОНАЛЬНАЯ, как и цвет подписей рядом
    # (2026-08-02, живой запрос «добавь пользователю выбор для себя»).
    # На сервере, а не в localStorage: настройка следует за человеком, а не
    # за компьютером — на площадке за одной машиной работают посменно.
    # NULL = базовое оформление.
    ("users", "ui_theme", "TEXT"),
    # Чем проверяется вход: 'local' — пароль сервиса (PBKDF2 в
    # password_hash), 'domain' — доменная учётная запись через LDAP-bind к
    # контроллеру домена (см. app/ldap_auth.py, 2026-08-03). NOT NULL
    # DEFAULT 'local' — все уже накопленные учётные записи остаются на
    # прежнем способе, доменный включается каждому явно.
    # CHECK сюда добавить нельзя (ALTER TABLE ADD COLUMN его не принимает),
    # поэтому набор значений проверяет Python — app/users.py AUTH_METHODS.
    ("users", "auth_method", "TEXT NOT NULL DEFAULT 'local'"),
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
    # Произвольный комментарий к элементу (2026-08-02, живой запрос) —
    # то, чего нет и не может быть в чертеже: «отбит угол при разгрузке»,
    # «ждём согласование замены». Импорт чертежа его не трогает (в списке
    # обновляемых колонок element_sync его нет), поэтому в manual_fields он
    # не участвует: перезаписывать нечему.
    ("elements", "comment", "TEXT"),
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
    # Иерархия Проект -> Объект (2026-07-31). project_id добавляется
    # миграцией, а не стоит в schema.sql, по общей причине: CREATE TABLE IF
    # NOT EXISTS не трогает уже существующую таблицу objects.
    #
    # NULL здесь допустим только технически (SQLite не умеет ADD COLUMN NOT
    # NULL без значения по умолчанию) — фактическую обязательность держит
    # _bootstrap_default_project ниже: любой объект без проекта
    # подхватывается проектом по умолчанию на ближайшем старте.
    ("objects", "project_id", "INTEGER REFERENCES projects(id) ON DELETE RESTRICT"),
    ("objects", "address", "TEXT"),
    # Договор заключается на конкретный объект (решение пользователя
    # 2026-07-31): контрагент остаётся сквозным справочником юрлиц, а
    # договор, спецификация и контракт — принадлежность объекта. Объект
    # контракта выводится по цепочке contracts -> specifications ->
    # agreements.object_id и отдельным полем НЕ дублируется — иначе
    # появился бы второй источник правды, который однажды разъедется.
    ("agreements", "object_id", "INTEGER REFERENCES objects(id) ON DELETE RESTRICT"),
    # Последний выбранный объект — на ПОЛЬЗОВАТЕЛЯ, а не в localStorage:
    # человек садится за другой компьютер и должен попасть туда же.
    ("users", "last_object_id", "INTEGER REFERENCES objects(id) ON DELETE SET NULL"),
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


ACCESS_SEED_MARKER = "user_access_seeded"


def _seed_user_access(conn: sqlite3.Connection, changes: list) -> None:
    """Выдаёт существующим пользователям доступ ко всем проектам с их
    нынешней ролью — одноразово, при переходе на разграничение (этап C).

    Без этого первый же деплой запер бы всех, кроме системного
    администратора: гранты пусты, а «нет гранта» означает «нет доступа».
    Молча оставить прораба перед пустым экраном хуже, чем на день оставить
    доступ шире нужного: сузить его администратор может за минуту, а
    объяснять людям, куда делась работа, придётся долго.

    Системным администраторам гранты не нужны — они видят всё в обход.

    За маркером в app_settings, а не «выдавать всем на каждом старте»:
    иначе снятый администратором доступ возвращался бы при ближайшем
    перезапуске, то есть отобрать права было бы нельзя.
    """
    marker = conn.execute(
        # object_id IS NULL — маркер системный; без этого условия он мог бы
        # прочитаться из объектной строки с тем же ключом.
        "SELECT value FROM app_settings WHERE key = ? AND object_id IS NULL", (ACCESS_SEED_MARKER,)
    ).fetchone()
    if marker and marker["value"]:
        return
    projects = [r["id"] for r in conn.execute("SELECT id FROM projects")]
    users = conn.execute("SELECT id, role FROM users WHERE role <> 'admin'").fetchall()
    granted = 0
    for u in users:
        for pid in projects:
            conn.execute(
                "INSERT OR IGNORE INTO user_access (user_id, project_id, object_id, role) "
                "VALUES (?, ?, NULL, ?)",
                (u["id"], pid, u["role"]),
            )
            granted += 1
    conn.execute(
        # Маркеры — СИСТЕМНЫЕ (object_id NULL). Конфликт указывается по тому
        # же выражению, что и уникальный индекс после этапа D: голый
        # ON CONFLICT(key) перестал соответствовать индексу, и вставка
        # падала с «does not match any PRIMARY KEY or UNIQUE constraint».
        "INSERT INTO app_settings (key, object_id, value) VALUES (?, NULL, '1') "
        "ON CONFLICT (key, COALESCE(object_id, -1)) DO UPDATE SET value = '1'",
        (ACCESS_SEED_MARKER,),
    )
    if granted:
        changes.append(f"выдан доступ к проектам существующим пользователям: {granted} грант(ов)")


# Настройки, которые с этапа D принадлежат ОБЪЕКТУ, а не системе. Остальные
# ключи app_settings (маркеры одноразовых миграций) остаются системными —
# у них object_id NULL, и смешивать их с объектными нельзя.
OBJECT_SCOPED_SETTINGS = ("project_card", "info_plate_late_threshold_days")


def _migrate_object_scoped_tables(conn: sqlite3.Connection, changes: list) -> None:
    """Переносит справочники и настройки ВНУТРЬ объекта (этап D).

    Пять таблиц получают object_id в составе ключа: label_visibility,
    zone_colors, report_notes, default_contracts, app_settings.

    **Почему пересборка здесь безопасна, в отличие от прошлых инцидентов.**
    Дважды сервер ломался на `ALTER TABLE ... RENAME`: он молча переписывает
    внешние ключи ДРУГИХ таблиц на новое имя, и после удаления временной
    таблицы ссылки остаются битыми навсегда. Проверено запросом: на эти пять
    таблиц не ссылается НИКТО (`PRAGMA foreign_key_list` по всем таблицам —
    ни одного попадания), поэтому переименование новой таблицы в старое имя
    ничьих ключей не задевает. Это не рассуждение по аналогии, а проверка
    конкретного условия, из-за которого класс ошибки и возникал.

    commit() перед `PRAGMA foreign_keys = OFF` обязателен: посреди открытой
    транзакции PRAGMA — молчаливый no-op (документированное поведение
    SQLite), и ровно это когда-то испортило схему.

    Идемпотентность — по наличию колонки object_id, без маркера: состояние
    само себя описывает, а лишний маркер пришлось бы согласовывать со
    схемой при каждой правке.

    Куда попадают накопленные строки: в объект по умолчанию (наименьший id),
    а у zone_colors — в объект СВОЕГО чертежа, он там известен точно. На
    боевой базе объект один, так что распределение однозначно в любом случае.
    """
    if conn.execute("SELECT COUNT(*) AS n FROM objects").fetchone()["n"] == 0:
        return  # свежая установка: переносить нечего, таблицы создаст schema.sql
    default_object = conn.execute("SELECT MIN(id) AS id FROM objects").fetchone()["id"]

    def has_column(table, column):
        return column in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}

    todo = [t for t in ("label_visibility", "zone_colors", "report_notes",
                        "default_contracts", "app_settings")
            if not has_column(t, "object_id")]
    if not todo:
        return

    if conn.in_transaction:
        conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")

    if "label_visibility" in todo:
        conn.execute("""
            CREATE TABLE label_visibility_new (
                object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
                element_type TEXT NOT NULL,
                visible INTEGER NOT NULL DEFAULT 1,
                dates_visible INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (object_id, element_type)
            )""")
        conn.execute(
            "INSERT INTO label_visibility_new (object_id, element_type, visible, dates_visible) "
            "SELECT ?, element_type, visible, dates_visible FROM label_visibility",
            (default_object,))
        conn.execute("DROP TABLE label_visibility")
        conn.execute("ALTER TABLE label_visibility_new RENAME TO label_visibility")

    if "zone_colors" in todo:
        conn.execute("""
            CREATE TABLE zone_colors_new (
                object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                PRIMARY KEY (object_id, category, name)
            )""")
        # Объект берётся из чертежа, которому цвет принадлежал. Несколько
        # версий чертежа одного объекта дают один и тот же object_id и
        # схлопываются по ключу — берём цвет последней (ON CONFLICT ... DO
        # UPDATE), а не первой попавшейся.
        conn.execute(
            "INSERT INTO zone_colors_new (object_id, category, name, color) "
            "SELECT COALESCE(od.object_id, ?), zc.category, zc.name, zc.color "
            "FROM zone_colors zc LEFT JOIN object_drawings od ON od.source_file = zc.source_file "
            "WHERE 1 ON CONFLICT (object_id, category, name) DO UPDATE SET color = excluded.color",
            (default_object,))
        conn.execute("DROP TABLE zone_colors")
        conn.execute("ALTER TABLE zone_colors_new RENAME TO zone_colors")

    if "report_notes" in todo:
        conn.execute("""
            CREATE TABLE report_notes_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
                effective_date TEXT NOT NULL,
                key_events TEXT NOT NULL DEFAULT '[]',
                key_tasks TEXT NOT NULL DEFAULT '[]',
                open_questions TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_by TEXT,
                UNIQUE (object_id, effective_date)
            )""")
        conn.execute(
            "INSERT INTO report_notes_new (object_id, effective_date, key_events, key_tasks, "
            "open_questions, updated_at, updated_by) "
            "SELECT ?, effective_date, key_events, key_tasks, open_questions, updated_at, updated_by "
            "FROM report_notes", (default_object,))
        conn.execute("DROP TABLE report_notes")
        conn.execute("ALTER TABLE report_notes_new RENAME TO report_notes")

    if "default_contracts" in todo:
        conn.execute("""
            CREATE TABLE default_contracts_new (
                object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
                element_type TEXT NOT NULL,
                contract_id INTEGER REFERENCES contracts (id) ON DELETE SET NULL,
                PRIMARY KEY (object_id, element_type)
            )""")
        conn.execute(
            "INSERT INTO default_contracts_new (object_id, element_type, contract_id) "
            "SELECT ?, element_type, contract_id FROM default_contracts", (default_object,))
        conn.execute("DROP TABLE default_contracts")
        conn.execute("ALTER TABLE default_contracts_new RENAME TO default_contracts")

    if "app_settings" in todo:
        # object_id ЗДЕСЬ NULLABLE, в отличие от остальных четырёх: маркеры
        # одноразовых миграций (legacy_elements_purged, user_access_seeded)
        # — системные, у них объекта нет и быть не может. Уникальность —
        # индексом через COALESCE: обычный UNIQUE в SQLite не считает
        # NULL=NULL, и системный ключ можно было бы завести дважды.
        conn.execute("""
            CREATE TABLE app_settings_new (
                key TEXT NOT NULL,
                object_id INTEGER REFERENCES objects (id) ON DELETE CASCADE,
                value TEXT
            )""")
        marks = ",".join("?" * len(OBJECT_SCOPED_SETTINGS))
        conn.execute(
            f"INSERT INTO app_settings_new (key, object_id, value) "
            f"SELECT key, CASE WHEN key IN ({marks}) THEN ? ELSE NULL END, value FROM app_settings",
            (*OBJECT_SCOPED_SETTINGS, default_object))
        conn.execute("DROP TABLE app_settings")
        conn.execute("ALTER TABLE app_settings_new RENAME TO app_settings")

    conn.commit()
    # ОБЯЗАТЕЛЬНО вернуть проверку ключей: дальше по init_db идёт чистка
    # наследия, которая рассчитывает на каскад status_history -> elements.
    # С выключенными ключами DELETE не каскадирует, и на копии это дало
    # 30 155 осиротевших записей истории при «успешной» миграции —
    # поймано PRAGMA foreign_key_check, а не глазами.
    conn.execute("PRAGMA foreign_keys = ON")
    changes.append("справочники и настройки перенесены внутрь объекта: " + ", ".join(todo))


def _migrate_user_access_global(conn: sqlite3.Connection, changes: list) -> None:
    """Разрешает грант на ВСЕ проекты сразу: project_id становится
    NULLABLE (2026-08-02, живой запрос).

    Уровней доступа стало три, от общего к частному:
      project_id IS NULL, object_id IS NULL — все проекты, включая будущие;
      project_id задан, object_id IS NULL   — весь проект, включая будущие
                                              объекты внутри него;
      object_id задан                       — конкретный объект.
    Действующая роль ищется от САМОГО ЧАСТНОГО к общему, см. access.object_role.

    Пересборка таблицы безопасна по тому же проверенному условию, что и на
    этапе D: на user_access не ссылается НИКТО (`PRAGMA foreign_key_list`
    по всем таблицам — ни одного попадания), поэтому переименование новой
    таблицы в старое имя ничьих ключей не переписывает. Это проверка
    конкретного условия, из-за которого класс ошибки возникал, а не
    рассуждение по аналогии.

    Идемпотентность — по признаку NOT NULL у колонки, без маркера:
    состояние само себя описывает.
    """
    колонки = {r["name"]: r for r in conn.execute("PRAGMA table_info(user_access)")}
    if "project_id" not in колонки or not колонки["project_id"]["notnull"]:
        return

    if conn.in_transaction:
        conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("""
        CREATE TABLE user_access_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
            object_id INTEGER REFERENCES objects (id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'view')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )""")
    conn.execute(
        "INSERT INTO user_access_new (id, user_id, project_id, object_id, role, created_at) "
        "SELECT id, user_id, project_id, object_id, role, created_at FROM user_access")
    conn.execute("DROP TABLE user_access")
    conn.execute("ALTER TABLE user_access_new RENAME TO user_access")
    # Индекс пересоздаётся под новую форму: в ключе теперь ОБА уровня через
    # COALESCE — обычный UNIQUE не считает NULL = NULL, и грант «на все
    # проекты» можно было бы завести дважды.
    conn.execute("DROP INDEX IF EXISTS idx_user_access_unique")
    conn.execute("CREATE UNIQUE INDEX idx_user_access_unique ON user_access "
                 "(user_id, COALESCE(project_id, -1), COALESCE(object_id, -1))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_user_access_user ON user_access (user_id)")
    conn.commit()
    # ОБЯЗАТЕЛЬНО вернуть проверку ключей: с выключенными дальнейшие DELETE
    # по ходу старта не каскадируют, и это уже давало 30 155 осиротевших
    # записей истории при внешне успешной миграции (этап D).
    conn.execute("PRAGMA foreign_keys = ON")
    changes.append("доступ: разрешён грант на все проекты сразу (project_id стал необязательным)")


def _ensure_object_scoped_indexes(conn: sqlite3.Connection) -> None:
    """Индексы объектных таблиц — ЗДЕСЬ, а не в schema.sql.

    schema.sql выполняется ПЕРВЫМ, до всех миграций. На базе, где перенос
    ещё не отработал, `CREATE INDEX ... (object_id, ...)` падает на
    несуществующей колонке и роняет старт целиком — этот класс ошибки уже
    один раз оставлял сервер лежать (см. Docs/backlog.md, «Контрактация
    2.0»). Поэтому индексы создаются после переноса и только тогда, когда
    колонка действительно есть: на свежей установке её создаёт schema.sql,
    на накопленной — миграция выше.

    idx_app_settings_key — не просто ускорение, а уникальность ключа:
    обычный UNIQUE в SQLite не считает NULL = NULL, и системный ключ
    (object_id IS NULL) можно было бы завести дважды. На него же ссылается
    ON CONFLICT в set_setting.
    """
    def has_object_id(table):
        return "object_id" in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}

    if has_object_id("app_settings"):
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_key "
                     "ON app_settings (key, COALESCE(object_id, -1))")
    if has_object_id("report_notes"):
        conn.execute("DROP INDEX IF EXISTS idx_report_notes_date")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_report_notes_date "
                     "ON report_notes (object_id, effective_date)")


def _reconcile_contract_from_history(conn: sqlite3.Connection, changes: list) -> None:
    """Переносит контракт из истории в элемент ТАМ, ГДЕ У ЭЛЕМЕНТА ЕГО НЕТ —
    разовая сверка на переходе к новой модели контракта (2026-08-01).

    Зачем. Пока elements.contract_id был кэшем, значение можно было
    восстановить пересчётом из истории в любой момент. После перехода
    пересчёта больше нет: что стоит в элементе, то и есть. Если на какой-то
    базе кэш отстал (в элементе пусто, а в последней записи истории
    контракт есть), старый код восстановил бы его при ближайшей смене
    статуса, а новый — уже никогда. Эта функция закрывает разрыв ровно один
    раз, в момент перехода.

    ТОЛЬКО заполняет пустое, никогда не перезаписывает непустое. Обратное
    (материализовать кэш для всех подряд) выглядит стройнее, но уничтожило
    бы привязки, проставленные в обход истории — а такие в данных есть
    (на боевой базе их оказалось две, см. Docs/backlog.md 2026-08-01).
    Заполнение пустого не может отнять ничего.

    Элементы в статусе «Запланирован» пропускаются: у них контракт обязан
    быть пуст, этим занимается _enforce_planned_has_no_contract ниже.
    """
    rows = conn.execute(
        "SELECT e.id, ("
        "  SELECT h.contract_id FROM status_history h WHERE h.element_id = e.id "
        "  ORDER BY h.changed_at DESC, h.id DESC LIMIT 1"
        ") AS hist_contract_id "
        "FROM elements e "
        "WHERE e.contract_id IS NULL AND e.current_status <> 'planned'"
    ).fetchall()
    restored = [(r["hist_contract_id"], r["id"]) for r in rows if r["hist_contract_id"] is not None]
    if not restored:
        return
    conn.executemany(
        "UPDATE elements SET contract_id = ?, updated_at = datetime('now') WHERE id = ?",
        restored,
    )
    changes.append(
        f"контракт перенесён из истории в элемент (кэш отставал): {len(restored)}"
    )


def _enforce_planned_has_no_contract(conn: sqlite3.Connection, changes: list) -> None:
    """Снимает контракт с элементов в статусе «Запланирован» — инвариант
    новой модели контракта (2026-08-01, см. app/contracts.py).

    Не «уборка», а починка расхождения, которое уже было в данных. Пока
    elements.contract_id был кэшем последней записи истории, такие строки
    были невозможны «по построению» — и всё же на боевой базе их оказалось
    две (`4П-13` и `3Р13`, контракты 4 и 5 при единственной записи истории
    «Запланирован» без контракта). То есть кто-то писал контракт мимо
    истории, а первый же пересчёт молча снял бы его. Теперь пересчёта нет,
    и без этой миграции неверные строки жили бы вечно.

    Не одноразовая и без маркера, в отличие от _purge_legacy_elements:
    здесь нечего терять — условие описывает состояние, которого не должно
    существовать, а не разовое событие. Пусть чинит и впредь, если какой-то
    путь записи снова его нарушит.
    """
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM elements "
        "WHERE current_status = 'planned' AND contract_id IS NOT NULL"
    ).fetchone()["n"]
    if not n:
        return
    conn.execute(
        "UPDATE elements SET contract_id = NULL, updated_at = datetime('now') "
        "WHERE current_status = 'planned' AND contract_id IS NOT NULL"
    )
    changes.append(
        f"снят контракт с элементов в статусе «Запланирован»: {n} "
        f"(инвариант «Запланирован ⇒ контракт пуст»)"
    )


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


DEFAULT_PROJECT_NAME = "Проект по умолчанию"


def _bootstrap_default_project(conn: sqlite3.Connection, changes: list) -> None:
    """Подвешивает объекты без проекта под проект по умолчанию.

    Идемпотентно и самовосстанавливающе: условие — не «таблица projects
    пуста» (так сделан _bootstrap_default_object выше), а «есть объект с
    project_id IS NULL». Разница важна — объект без проекта не должен
    существовать в принципе, но если он как-то возникнет (сбойная миграция,
    ручная правка БД), он окажется недостижим ни через один селектор и
    исчезнет с глаз вместе со всеми своими элементами. Пусть лучше всплывёт
    в проекте по умолчанию, чем потеряется молча.

    Имя проекта не берётся из карточки объекта, хотя соблазн есть: карточка
    описывает ЗДАНИЕ («Промышленный корпус на земельных участках…»), а не
    группу зданий, и подставлять её значит выдавать за проектное имя то, чем
    оно не является. Нейтральное имя с подсказкой переименовать — тот же
    приём, что уже применён к «Объект 1».
    """
    orphans = conn.execute(
        "SELECT id FROM objects WHERE project_id IS NULL ORDER BY id"
    ).fetchall()
    if not orphans:
        return
    row = conn.execute(
        "SELECT id FROM projects WHERE name = ?", (DEFAULT_PROJECT_NAME,)
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO projects (name, description) VALUES (?, ?)",
            (DEFAULT_PROJECT_NAME,
             "Заведён автоматически при переходе на иерархию проектов; "
             "переименуйте в «Действия → Проекты»."),
        )
        project_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        changes.append(f"заведён проект «{DEFAULT_PROJECT_NAME}»")
    else:
        project_id = row["id"]
    conn.execute(
        "UPDATE objects SET project_id = ?, updated_at = datetime('now') "
        "WHERE project_id IS NULL",
        (project_id,),
    )
    changes.append(f"объектов привязано к проекту по умолчанию: {len(orphans)}")


LEGACY_PURGE_MARKER = "legacy_elements_purged"


def _purge_legacy_elements(conn: sqlite3.Connection, changes: list) -> None:
    """Одноразово удаляет ДООБЪЕКТНОЕ наследие: элементы, зоны, оси и цвета
    зон тех версий чертежа, что накопились до введения Объекта (в боевой БД
    — 30 123 элемента из 10 файлов, 260713…260722 плюс два безымянных и
    sample.dxf). Решение пользователя от 2026-07-31.

    Что при этом теряется, зафиксировано явно: из 30 123 элементов статус
    отличен от «Запланирован» ровно у 24 (все — «Смонтирован»), и все их
    марки присутствуют в актуальном чертеже, то есть уникальной информации
    в слое нет. История удаляется каскадом (status_history.element_id ON
    DELETE CASCADE), ярусы зон — тоже (zone_levels.zone_id).

    НЕ трогает элементы с is_current=0 при ЖИВОМ object_id — это совсем
    другая сущность: элемент, исчезнувший из новой версии чертежа, но
    сохранивший статус и историю (решение И2 этапа 1). По нему видно, что
    заказчик убрал колонну, по которой уже была поставка; удалить его
    значило бы уничтожить результат сверки при переимпорте.

    Маркер в app_settings, а не «удалять всё с object_id IS NULL на каждом
    старте»: условие выглядит самоидемпотентным, но тогда любая будущая
    строка, случайно оставшаяся без объекта, молча уничтожалась бы при
    ближайшем перезапуске сервера — а перезапуск случается на каждом
    деплое. Разовое действие и должно быть разовым.

    Порядок удаления обязателен: сначала элементы, потом зоны. Обратный
    порядок сработал бы через elements.zone_*_id ON DELETE SET NULL —
    зоны бы обнулились у ещё не удалённых строк, и следы привязки
    пропали бы раньше, чем сами строки. Проверено на боевой БД: актуальных
    элементов, ссылающихся на легаси-зоны, ноль.
    """
    # Прямым SQL, а не через app.settings.get_setting: app/settings.py сам
    # импортирует app.db — импорт отсюда был бы циклическим.
    marker = conn.execute(
        "SELECT value FROM app_settings WHERE key = ? AND object_id IS NULL", (LEGACY_PURGE_MARKER,)
    ).fetchone()
    if marker and marker["value"]:
        return
    # Пустая БД (свежая установка) — чистить нечего, но маркер ставим:
    # наследие может появиться только из прошлого, а не из будущего.
    kept_files = {
        r["source_file"]
        for r in conn.execute("SELECT source_file FROM object_drawings")
    }
    n_elements = conn.execute(
        "SELECT COUNT(*) AS n FROM elements WHERE object_id IS NULL"
    ).fetchone()["n"]
    n_zones = conn.execute(
        "SELECT COUNT(*) AS n FROM zones WHERE object_id IS NULL"
    ).fetchone()["n"]
    conn.execute("DELETE FROM elements WHERE object_id IS NULL")
    conn.execute("DELETE FROM zones WHERE object_id IS NULL")
    if kept_files:
        marks = ",".join("?" * len(kept_files))
        params = tuple(kept_files)
        n_axes = conn.execute(
            f"SELECT COUNT(*) AS n FROM axis_lines WHERE source_file NOT IN ({marks})",
            params,
        ).fetchone()["n"]
        conn.execute(
            f"DELETE FROM axis_lines WHERE source_file NOT IN ({marks})", params
        )
        # Цвета зон чистятся по чертежу только ДО этапа D. После переноса
        # внутрь объекта у таблицы нет source_file: цвета легаси-файлов уже
        # схлопнулись в объект по ключу, чистить там нечего.
        if "source_file" in {r["name"] for r in conn.execute("PRAGMA table_info(zone_colors)")}:
            conn.execute(
                f"DELETE FROM zone_colors WHERE source_file NOT IN ({marks})", params
            )
    else:
        n_axes = 0
    conn.execute(
        # Маркеры — СИСТЕМНЫЕ (object_id NULL). Конфликт указывается по тому
        # же выражению, что и уникальный индекс после этапа D: голый
        # ON CONFLICT(key) перестал соответствовать индексу, и вставка
        # падала с «does not match any PRIMARY KEY or UNIQUE constraint».
        "INSERT INTO app_settings (key, object_id, value) VALUES (?, NULL, '1') "
        "ON CONFLICT (key, COALESCE(object_id, -1)) DO UPDATE SET value = '1'",
        (LEGACY_PURGE_MARKER,),
    )
    if n_elements or n_zones or n_axes:
        changes.append(
            f"удалено дообъектное наследие: элементов {n_elements}, "
            f"зон {n_zones}, линий осей {n_axes}"
        )


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

    Прежняя вторая половина условия (`OR object_id IS NULL` — элементы
    устаревших версий чертежа, не перенесённые в объект) убрана 2026-07-31:
    таких элементов больше нет в принципе, их чистит _purge_legacy_elements,
    а новые появиться не могут (импорт всегда проставляет объект). Держать
    ветку «элементы вне объектов» дальше означало бы тащить её через каждый
    новый запрос с проверкой доступа.

    Одна функция вместо повторения условия строками: мест чтения элементов по
    чертежу восемь, и разъехавшееся условие видимости — ровно тот класс
    расхождений, который потом ловится только живым репортом."""
    prefix = f"{alias}." if alias else ""
    return f"({prefix}is_current = 1)"


def object_source_file(conn: sqlite3.Connection, object_id: int) -> str:
    """Актуальный чертёж объекта. Точка перевода «объект -> файл» (этап B,
    2026-08-01).

    С этапа B единица показа — ОБЪЕКТ: клиент присылает object_id, а
    source_file выводит сервер. Переписывать под object_id запросы всех 22
    эндпоинтов не понадобилось и не нужно: source_file остался тем, чем и
    был — именем файла в строке элемента. Изменилось только то, КТО его
    выбирает. Перевод в одном месте, а не в каждом эндпоинте, — по той же
    причине, что и visible_elements_clause: разъехавшееся правило выбора
    чертежа ловится потом только живым репортом.
    """
    row = conn.execute(
        "SELECT source_file FROM object_drawings WHERE object_id = ? AND is_current = 1",
        (object_id,),
    ).fetchone()
    if row is None:
        raise LookupError(f"У объекта #{object_id} нет актуального чертежа")
    return row["source_file"]


def projects_tree(conn: sqlite3.Connection, allowed_object_ids=None) -> list:
    """Проекты со своими объектами — для переключателя в тулбаре.

    Счётчик элементов здесь же: пустой объект в списке ничем не отличался бы
    от загруженного, а переключиться на него и увидеть чистый лист — самый
    неприятный способ это узнать.

    allowed_object_ids — множество доступных пользователю объектов; None
    означает «доступны все» (системный администратор). Отбор ЗДЕСЬ, в одном
    месте: дерево — единственный источник для переключателя, и вырезать
    недоступное надо ровно один раз, а не в каждом из 22 эндпоинтов.
    Проект, у которого не осталось видимых объектов, не показывается вовсе —
    иначе в списке висели бы пустые заголовки чужих площадок.
    """
    counts = {
        r["object_id"]: r["n"]
        for r in conn.execute(
            "SELECT object_id, COUNT(*) AS n FROM elements "
            f"WHERE object_id IS NOT NULL AND {visible_elements_clause('')} GROUP BY object_id"
        )
    }
    drawings = {
        r["object_id"]: r["source_file"]
        for r in conn.execute(
            "SELECT object_id, source_file FROM object_drawings WHERE is_current = 1"
        )
    }
    def visible(object_id):
        return allowed_object_ids is None or object_id in allowed_object_ids

    tree = []
    for proj in conn.execute("SELECT id, name, address, description FROM projects ORDER BY name"):
        objects = [
            {"id": o["id"], "name": o["name"], "address": o["address"],
             "source_file": drawings.get(o["id"]), "elements": counts.get(o["id"], 0)}
            for o in conn.execute(
                "SELECT id, name, address FROM objects WHERE project_id = ? ORDER BY name",
                (proj["id"],),
            )
            if visible(o["id"])
        ]
        if not objects:
            continue
        tree.append({"id": proj["id"], "name": proj["name"], "address": proj["address"],
                     "description": proj["description"], "objects": objects})
    # Объекты без проекта не должны существовать (_bootstrap_default_project
    # их подбирает), но если такой появится — он обязан быть ВИДЕН, иначе
    # исчезнет вместе со всеми своими элементами.
    orphans = [
        {"id": o["id"], "name": o["name"], "address": o["address"],
         "source_file": drawings.get(o["id"]), "elements": counts.get(o["id"], 0)}
        for o in conn.execute("SELECT id, name, address FROM objects WHERE project_id IS NULL ORDER BY name")
        if visible(o["id"])
    ]
    if orphans:
        tree.append({"id": None, "name": "Без проекта", "address": None,
                     "description": "Объекты, не привязанные к проекту", "objects": orphans})
    return tree


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
    # Значение по умолчанию заводится ДЛЯ КАЖДОГО ОБЪЕКТА (этап D): порог
    # опоздания стал объектной настройкой. Прежний вариант — одна строка без
    # объекта — после переноса создавал ВТОРУЮ запись того же ключа рядом с
    # перенесённой (NULL и object_id различаются, OR IGNORE не срабатывал), и
    # чтение брало произвольную из двух.
    objects = [r["id"] for r in conn.execute("SELECT id FROM objects")]
    for key, value in _APP_SETTINGS_SEED:
        for object_id in objects:
            conn.execute(
                "INSERT OR IGNORE INTO app_settings (key, object_id, value) VALUES (?, ?, ?)",
                (key, object_id, value),
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

        # С этапа D обе таблицы объектные, и столкновение «русская строка
        # уже есть» решается ОТДЕЛЬНО ПО КАЖДОМУ ОБЪЕКТУ: проверка «есть ли
        # где-нибудь строка с новым именем» здесь была бы неверной в обе
        # стороны — либо удалила бы английскую строку объекта, где русской
        # нет (настройка пропала), либо попыталась переименовать её там,
        # где русская уже есть (нарушение уникального ключа).
        for table in ("label_visibility", "default_contracts"):
            conn.execute(
                f"DELETE FROM {table} WHERE element_type = ? AND object_id IN "
                f"(SELECT object_id FROM {table} WHERE element_type = ?)",
                (old, new),
            )
            conn.execute(
                f"UPDATE {table} SET element_type = ? WHERE element_type = ?", (new, old)
            )

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
        # Строго ПОСЛЕ бутстрапа объекта: проекту нужны объекты, которые он
        # подхватит, а бутстрап объекта заводит их на накопленной БД.
        _bootstrap_default_project(conn, changes)
        # Строго ПОСЛЕ заведения объекта и проекта (нужен объект, куда
        # переносить) и строго ДО всего, что пишет в app_settings: чистка
        # наследия и выдача доступов ставят там маркеры, а до переноса у
        # таблицы нет колонки object_id.
        _migrate_object_scoped_tables(conn, changes)
        _migrate_user_access_global(conn, changes)
        _ensure_object_scoped_indexes(conn)
        # Строго ПОСЛЕ бутстрапа объекта: миграция зон опирается на
        # object_drawings, чтобы понять, какой чертёж актуален.
        _migrate_zones_to_catalog(conn, changes)
        _ensure_zone_level_index(conn)
        # Не часть одноразовой миграции: чинит частичное состояние, если
        # миграция зон отработала промежуточной версией кода (см. docstring).
        _heal_zone_stance_levels(conn, changes)
        # Строго ПОСЛЕ миграции зон в справочник: она проставляет object_id
        # зонам актуального чертежа, а чистка удаляет всё, у чего его нет.
        # В обратном порядке зоны актуального чертежа были бы уничтожены
        # ровно перед тем, как их собирались перенести.
        _purge_legacy_elements(conn, changes)
        # Порядок обязателен: сначала подобрать отставший кэш, потом снять
        # контракт с «Запланированных» — иначе сверка вернула бы им то, что
        # инвариант обязан убрать. Обе — ПОСЛЕ чистки наследия: незачем
        # сверять контракты у строк, которые сейчас будут удалены.
        _seed_user_access(conn, changes)
        _reconcile_contract_from_history(conn, changes)
        _enforce_planned_has_no_contract(conn, changes)
        _normalize_element_type_vocabulary(conn, changes)
        _seed_reference_data(conn)
        conn.commit()
    finally:
        conn.close()
    return changes
