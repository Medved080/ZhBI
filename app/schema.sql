-- Схема БД контроля поставки/монтажа ЖБИ.

CREATE TABLE IF NOT EXISTS elements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    dxf_handle TEXT NOT NULL,
    layer TEXT NOT NULL,
    element_type TEXT NOT NULL,
    mark TEXT,
    mark_source TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL DEFAULT 0,
    address TEXT,
    axis_status TEXT NOT NULL,
    axis_number TEXT,
    axis_letter TEXT,
    nearest_axis_number TEXT,
    nearest_axis_letter TEXT,
    offset_x_mm REAL,
    offset_y_mm REAL,
    current_status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_file, dxf_handle)
);

-- Пользователи и роли (admin/user/view). password_hash/password_salt = NULL
-- означает пустой пароль (вход без пароля разрешён) — до тех пор, пока
-- пользователь (или админ за него) не задаст пароль через UI.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_name TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    patronymic TEXT,
    position TEXT,
    department TEXT,
    domain_login TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'view')),
    password_hash TEXT,
    password_salt TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Пользователь-администратор по умолчанию (см. Docs/backlog.md п.12).
INSERT OR IGNORE INTO users (last_name, first_name, domain_login, role, password_hash, password_salt)
VALUES ('Администратор', '', 'admin', 'admin', NULL, NULL);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Отдельная таблица истории статусов (аудит: кто/когда менял). changed_by
-- хранит имя текстом (снимок на момент изменения — переживёт переименование
-- пользователя), changed_by_user_id — ссылку на аккаунт, если известен.
CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    element_id INTEGER NOT NULL REFERENCES elements (id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    changed_by TEXT,
    changed_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_status_history_element ON status_history (element_id);
CREATE INDEX IF NOT EXISTS idx_elements_status ON elements (current_status);
CREATE INDEX IF NOT EXISTS idx_elements_source_file ON elements (source_file);

-- Сетка осей на файл — сохраняется при импорте (--dxf), чтобы схема в
-- браузере не зависела от исходного DXF (он может быть огромным и лежать
-- только у того, кто делал импорт).
CREATE TABLE IF NOT EXISTS axis_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('numeric', 'letter')),
    label TEXT NOT NULL,
    coord REAL NOT NULL,
    UNIQUE (source_file, kind, label)
);

-- Цвет по статусу — настраивается пользователем через UI, не зашит в код.
CREATE TABLE IF NOT EXISTS status_colors (
    status TEXT PRIMARY KEY,
    color TEXT NOT NULL
);

INSERT OR IGNORE INTO status_colors (status, color) VALUES
    ('planned', '#9aa0a6'),
    ('contracting', '#eab308'),
    ('in_production', '#f4a300'),
    ('shipped', '#3b82f6'),
    ('delivered', '#8b5cf6'),
    ('installed', '#22c55e'),
    ('accepted', '#0f766e');

-- Видимость подписей марок по типу элемента (сейчас только "column", но
-- слои под ригели/плиты уже заложены в parse_zhbi.LAYER_CONFIG — строки
-- заводятся лениво при импорте, см. import_elements.ensure_label_visibility).
CREATE TABLE IF NOT EXISTS label_visibility (
    element_type TEXT PRIMARY KEY,
    visible INTEGER NOT NULL DEFAULT 1
);

-- Контрагенты/Договоры/Спецификации (см. Docs/backlog.md, "Контрактация 2.0") —
-- заменяют старое свободнотекстовое contracts.supplier настоящей юридической
-- иерархией. Контрагент — юрлицо-поставщик, Договор — конкретный договор с
-- ним (номер+дата), Спецификация — приложение к договору (номер+дата), к
-- которому уже привязывается сам Контракт (см. ниже).
CREATE TABLE IF NOT EXISTS counterparties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    inn TEXT,
    kpp TEXT,
    ogrn TEXT,
    legal_address TEXT,
    contact_person TEXT,
    contact_phone TEXT,
    code TEXT,                 -- короткий код для допстроки подписи на схеме
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agreements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    counterparty_id INTEGER NOT NULL REFERENCES counterparties (id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    agreement_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (counterparty_id, number)
);

CREATE TABLE IF NOT EXISTS specifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agreement_id INTEGER NOT NULL REFERENCES agreements (id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    specification_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (agreement_id, number)
);

-- Эвристика "префикс марки -> тип элемента", используется импортом файла
-- контрактации, когда марка позиции ещё не встречается ни у одного
-- загруженного элемента (справочник донастраивается администратором, не
-- хардкод — см. Docs/backlog.md).
CREATE TABLE IF NOT EXISTS mark_type_prefixes (
    prefix TEXT PRIMARY KEY,
    element_type TEXT NOT NULL
);

-- Общие настройки приложения (ключ-значение) — напр. порог "красной"
-- инфо-плашки в днях (см. Docs/backlog.md, "Контрактация 2.0").
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Контракты (см. Docs/backlog.md, второй раунд п.9, третий раунд п.8,
-- "Контрактация 2.0"). Контракт привязан к одной Спецификации (а через неё —
-- транзитивно к Договору и Контрагенту), с расшифровкой законтрактованных
-- количеств по (тип, марка) в contract_lines. Не привязан к конкретному
-- source_file — контракт на поставку колонн действует в рамках всего
-- проекта, не одного чертежа.
CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specification_id INTEGER NOT NULL REFERENCES specifications (id) ON DELETE RESTRICT,
    contract_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Строка контракта — план по (тип, марка). mark допускает NULL (позиция
-- может быть без марки) — сравнение с элементом обязано быть NULL-safe
-- (SQL IS, не =), как раньше делали batch_lines (см. Docs/backlog.md).
-- element_type ТОЖЕ допускает NULL — импорт файла контрактации
-- (app/contracting_import.py) не всегда может определить тип по марке
-- (эвристика по префиксу, справочник mark_type_prefixes); такая позиция
-- создаётся с element_type=NULL и попадает в сводку импорта как
-- "тип не определён", администратор донастраивает вручную.
CREATE TABLE IF NOT EXISTS contract_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
    element_type TEXT,
    mark TEXT,
    quantity INTEGER NOT NULL
);

-- NULL-safe уникальность (contract_id, element_type, mark) — см.
-- app/db.py:_ensure_contract_lines_index(). НЕ здесь: на существующей БД
-- (ещё старой формы, до _migrate_contracts_hierarchy) contract_lines в
-- момент выполнения этого скрипта может не иметь колонки mark —
-- CREATE INDEX сразу упал бы, executescript отрабатывает раньше миграций.

-- Инциденты повреждения элементов на стройке в рамках контракта — только
-- количество (тип + число), без привязки к конкретным elements.id и без
-- отдельного статуса подтверждения (любая запись сразу считается и сразу
-- вычитается из остатка контракта, см. Docs/backlog.md).
CREATE TABLE IF NOT EXISTS contract_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
    element_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    incident_date TEXT NOT NULL,
    description TEXT
);

-- Контракт по умолчанию для каждого типа элемента — подставляется
-- элементу автоматически при первом переводе из "Запланирован" в любой
-- другой статус, если у элемента ещё нет своего контракта.
CREATE TABLE IF NOT EXISTS default_contracts (
    element_type TEXT PRIMARY KEY,
    contract_id INTEGER REFERENCES contracts (id) ON DELETE SET NULL
);

-- Форма маркера на схеме по комбинации (слой, тип элемента) — см.
-- Docs/backlog.md. По умолчанию всё рисуется "как в оригинале" (реальный
-- контур из DXF, отсутствие строки в этой таблице = outline), таблица
-- заполняется только когда пользователь явно назначил что-то другое.
CREATE TABLE IF NOT EXISTS element_shapes (
    layer TEXT NOT NULL,
    element_type TEXT NOT NULL,
    shape TEXT NOT NULL DEFAULT 'outline',
    PRIMARY KEY (layer, element_type)
);

-- Зоны (захватки, зоны работы крана, стоянки крана) — см. Docs/backlog.md,
-- "Разбор структурированных имён слоёв DWG/DXF...". Полигон — в мировых
-- координатах чертежа, как и elements.outline_json. match_status —
-- результат сопоставления с текстом-названием (см. scripts/zone_parser.py):
-- "unmatched" — под полигоном не нашлось ни одного текста, "ambiguous" —
-- нашлось несколько (не гадаем, какой верный).
CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    dxf_handle TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('Захватка', 'Кран', 'Стоянка')),
    elevation_mm INTEGER,
    name TEXT,
    outline_json TEXT NOT NULL,
    match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
    UNIQUE (source_file, dxf_handle)
);

CREATE INDEX IF NOT EXISTS idx_zones_source_file ON zones (source_file);

-- Цвет зоны — персонально на каждый КРАН (не общий на категорию, как
-- раньше — см. Docs/backlog.md, item 7), его стоянки наследуют цвет
-- родительского крана (zones.parent_zone_id) без отдельной записи здесь.
-- Ключ — (source_file, category, name), а НЕ zones.id: id не стабилен
-- между переимпортами файла (upsert_zones делает DELETE+INSERT заново
-- при каждой обработке), имя зоны — единственное, что переживает
-- переимпорт. Автоназначается из фиксированной палитры при первой
-- встрече крана (см. scripts/import_elements.upsert_zones), правится
-- вручную в «Настройки → Цвета зон».
CREATE TABLE IF NOT EXISTS zone_colors (
    source_file TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    PRIMARY KEY (source_file, category, name)
);

-- Справочник допустимых подтипов элементов ЖБИ по новому стандарту имён
-- слоёв — сознательно НЕ зашит в код разбора (scripts/layer_naming.py
-- принимает его параметром), редактируется через "Настройки → Справочник
-- подтипов" (только admin). Сравнение при разборе имени слоя — без учёта
-- регистра (см. layer_naming._ci_lookup), поэтому регистр здесь — просто
-- то, что будет показано в UI, а не что-то, что нужно дублировать под
-- каждый возможный вариант написания в файле. Колонна/Ригель — реальные
-- значения из чертежей заказчика (см. Docs/backlog.md); Панель — из
-- исходной спецификации стандарта, подтверждающих чертежей пока не было.
CREATE TABLE IF NOT EXISTS allowed_subtypes (
    element_type TEXT NOT NULL,
    subtype TEXT NOT NULL,
    PRIMARY KEY (element_type, subtype)
);

INSERT OR IGNORE INTO allowed_subtypes (element_type, subtype) VALUES
    ('Колонна', 'нижняя'),
    ('Колонна', 'средняя нижний ярус'),
    ('Ригель', 'на отм. +15.800'),
    ('Ригель', 'периметральный'),
    ('Панель', 'Цоколь'),
    ('Панель', 'ЛифтоваяШахта'),
    ('Панель', 'ШахтаПодъемника');
