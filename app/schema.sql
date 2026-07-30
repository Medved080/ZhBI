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
-- dates_visible — подпункт "Даты" (см. Docs/backlog.md): управляет ТОЛЬКО
-- допстрокой наклейки (код контрагента + плановая дата у этого типа
-- элемента), независимо от visible (видимость самой марки). По умолчанию
-- включён — сохраняет прежнее поведение (допстрока показывалась всегда,
-- без возможности отключить по типу).
CREATE TABLE IF NOT EXISTS label_visibility (
    element_type TEXT PRIMARY KEY,
    visible INTEGER NOT NULL DEFAULT 1,
    dates_visible INTEGER NOT NULL DEFAULT 1
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
-- name НЕ хранится — наименование контракта ВСЕГДА генерируется из цепочки
-- Контрагент/Договор/Спецификация + theme (build_contract_name,
-- app/contracts.py, живой запрос пользователя, 2026-07-28), не может
-- разойтись с реальными реквизитами. contract_date тоже не хранится —
-- избыточна, есть дата спецификации (specifications.specification_date).
-- theme — единственное свободное поле, относящееся к названию.
CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    specification_id INTEGER NOT NULL REFERENCES specifications (id) ON DELETE RESTRICT,
    theme TEXT,
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

-- Объект (здание/стройплощадка) — уровень, к которому привязана идентичность
-- элементов и (этап 2) справочники зон. Введён 2026-07-30, см.
-- Docs/backlog.md, запись "Задача… объекты системы", решения О1/И1.
--
-- Зачем: до этого идентичностью элемента была пара (source_file,
-- dxf_handle), то есть имя файла ВХОДИЛО в идентичность — новая версия
-- чертежа давала полный набор новых строк со статусом "Запланирован", а
-- старые оставались мёртвым слоем. Объект отвязывает "какой это физически
-- элемент" от "из какого файла он пришёл в последний раз".
CREATE TABLE IF NOT EXISTS objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Какие чертежи относятся к объекту и какой из них актуален. is_current=1
-- ровно у одного чертежа объекта (поддерживается кодом импорта, не
-- констрейнтом: SQLite не умеет частичный UNIQUE в CREATE TABLE).
CREATE TABLE IF NOT EXISTS object_drawings (
    object_id INTEGER NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    source_file TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (object_id, source_file)
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

-- Ярусы зоны (этап 2, 2026-07-30): произвольный набор полигонов с отметками
-- внутри ОДНОЙ записи справочника — решение З7. Раньше «Стоянка 01» на
-- четырёх ярусах была четырьмя строками zones, из-за чего на фронтенде
-- появился костыль stanceLogicalKey (склейка записей в один пункт фильтра
-- по паре «кран + имя»).
--
-- elevation_mm NULL — захватка и кран: на всех реальных чертежах они
-- приходят без отметки (проверено), объём считается от 0 до верха здания.
-- Уникальность (zone_id, elevation_mm) — отдельным COALESCE-индексом, а не
-- констрейнтом: обычный UNIQUE в SQLite не считает NULL=NULL, и два яруса
-- без отметки продублировались бы молча (та же ловушка, что уже была в
-- contract_lines).
--
-- source_file/dxf_handle — «откуда пришёл этот полигон в последний раз».
-- Это сведения о происхождении, а не идентичность: идентичность зоны —
-- категория + номер (+ родительский кран у стоянки), см. решение З2.
CREATE TABLE IF NOT EXISTS zone_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
    elevation_mm INTEGER,
    outline_json TEXT NOT NULL,
    source_file TEXT,
    dxf_handle TEXT
);

CREATE INDEX IF NOT EXISTS idx_zone_levels_zone ON zone_levels (zone_id);

-- Снимок «до» на одну правку зоны (решение З12): реквизиты с геометрией плюс
-- ПРЕЖНИЕ привязки тех элементов, которые изменил пересчёт. Правка точки
-- задевает цепочку последствий, и откатываться должна вся цепочка, а не
-- только сам полигон.
--
-- Храним историю целиком, а не один последний снимок: объём мизерный
-- (сотни полигонов), а «отменить» после нескольких правок подряд —
-- нормальное ожидание. undone_at помечает уже применённый откат, чтобы
-- повторное нажатие не откатывало ещё на шаг назад молча.
CREATE TABLE IF NOT EXISTS zone_edit_undo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    undone_at TEXT,
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    user_name TEXT,
    zone_json TEXT NOT NULL,
    bindings_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_zone_edit_undo_zone ON zone_edit_undo (zone_id, undone_at);

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
-- каждый возможный вариант написания в файле. Колонна/Ригель/Плита
-- перекрытия — реальные значения из чертежей заказчика (см.
-- Docs/backlog.md), полный список сверен по факту с уже накопленной
-- реальной БД (2026-07-28, см. scripts/rebuild_db.py — без этого полная
-- пересборка БД теряет вручную добавленные значения, и реальный чертёж
-- заказчика перестаёт загружаться на "верхняя"/отметках выше +15.800);
-- Панель — из исходной спецификации стандарта, подтверждающих чертежей
-- пока не было.
CREATE TABLE IF NOT EXISTS allowed_subtypes (
    element_type TEXT NOT NULL,
    subtype TEXT NOT NULL,
    PRIMARY KEY (element_type, subtype)
);

INSERT OR IGNORE INTO allowed_subtypes (element_type, subtype) VALUES
    ('Колонна', 'нижняя'),
    ('Колонна', 'верхняя'),
    ('Колонна', 'средняя нижний ярус'),
    ('Колонна', 'средняя верхний ярус'),
    ('Ригель', 'на отм. +15.000'),
    ('Ригель', 'на отм. +15.800'),
    ('Ригель', 'на отм. +25.800'),
    ('Ригель', 'на отм. +34.700'),
    ('Ригель', 'на отм. +39.200'),
    ('Ригель', 'периметральный'),
    ('Плита перекрытия', 'на отм. +15.000'),
    ('Плита перекрытия', 'на отм. +25.800'),
    ('Плита перекрытия', 'на отм. +34.700'),
    ('Плита перекрытия', 'на отм. +39.200'),
    ('Плита перекрытия', 'на отм. +47.000'),
    ('Панель', 'Цоколь'),
    ('Панель', 'ЛифтоваяШахта'),
    ('Панель', 'ШахтаПодъемника');

-- Журнал действий пользователей и отработки команд системой (живой запрос
-- 2026-07-29). Две разные вещи в одной таблице намеренно: серверные события
-- ("статус изменён", "импорт выполнен") и клиентские тайминги ("нажал
-- кнопку", "форма открылась") — чтобы одна операция читалась целиком одной
-- выборкой по request_id, а не сшивалась из двух таблиц.
--
-- at — момент события. Для серверных событий это время СЕРВЕРА; для
-- клиентских — тоже серверное время приёма пачки, а собственная длительность
-- операции приходит отдельным полем duration_ms, измеренным монотонным
-- таймером браузера. Часы на клиентских машинах расходятся между собой на
-- минуты, и сравнивать их абсолютные метки между компьютерами нельзя —
-- а именно сравнение быстродействия разных машин и есть цель журнала.
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,                 -- 'ГГГГ-ММ-ДД ЧЧ:ММ:СС.ммм' UTC, время сервера
    source TEXT NOT NULL,             -- 'server' | 'client'
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT,                   -- снимок ФИО на момент события (переживёт переименование)
    action TEXT NOT NULL,             -- 'status_change', 'form_open', 'import_input', ...
    entity_type TEXT,                 -- 'element' | 'contract' | ...
    entity_id INTEGER,
    element_type TEXT,                -- тип/подтип/марка — снимок на момент события:
    subtype TEXT,                     -- по ним ищут в журнале, а элемент мог измениться
    mark TEXT,
    old_value TEXT,
    new_value TEXT,
    duration_ms REAL,                 -- сколько заняло; у клиентских — по performance.now()
    request_id TEXT,                  -- связывает клиентские и серверные события одной операции
    details TEXT                      -- произвольный JSON, если нужны подробности
);

-- Поиск в журнале почти всегда идёт "за период", часто с сужением по
-- пользователю или действию; очистка за период — тем же условием по at.
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log (at);
CREATE INDEX IF NOT EXISTS idx_activity_user_at ON activity_log (user_id, at);
CREATE INDEX IF NOT EXISTS idx_activity_action_at ON activity_log (action, at);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log (entity_type, entity_id);

-- Редакции текстовых блоков ежедневного отчёта (живой запрос 2026-07-29:
-- «ключевые события, задачи и вопросы должны обновляться на определённые
-- даты, отчёт берёт актуальную информацию на выбранную дату»).
--
-- Отдельная таблица, а не поля в карточке объекта: это список с историей,
-- он растёт, выбирается по дате и правится построчно. Карточка (название
-- объекта, контрольные даты, вехи) осталась одной записью в app_settings —
-- она меняется редко и версии ей не нужны.
--
-- Одна редакция на дату (UNIQUE): повторное сохранение той же даты
-- заменяет её, а не плодит дубли. Отчёт на дату D берёт САМУЮ ПОЗДНЮЮ
-- редакцию с effective_date <= D — то есть последнюю действовавшую, даже
-- если в этот день её не обновляли.
CREATE TABLE IF NOT EXISTS report_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_date TEXT NOT NULL UNIQUE,
    key_events TEXT NOT NULL DEFAULT '[]',      -- JSON-массив строк
    key_tasks TEXT NOT NULL DEFAULT '[]',
    open_questions TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_notes_date ON report_notes (effective_date);
