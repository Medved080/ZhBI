# -*- coding: utf-8 -*-
"""Описание схемы БД: назначение каждой таблицы, каждого поля и каждой связи.

ЕДИНСТВЕННЫЙ источник этих сведений в проекте. Отсюда их берут двое:

- `scripts/gen_db_schema_drawio.py` — рисует `Docs/db-schema.drawio`;
- `app/db_status.py` — отчёт «Состояние БД» в интерфейсе администратора.

Почему один модуль, а не два списка рядом с каждым потребителем: состав
таблиц и полей из SQLite достаётся сама (`PRAGMA table_info`), а вот
НАЗНАЧЕНИЕ поля — «что это значит и чем меняется» — нигде, кроме как здесь,
не записано; два таких списка разъехались бы на первой же миграции, и один
из них начал бы врать молча. Тот же довод, что у `app/import_templates.py`
(описание формата живёт рядом с кодом, который формат проверяет) и у
`app/admin_guide.py` (экран и выгружаемый файл строятся из одного `SECTIONS`).

**Правило при миграции**: добавили колонку — допишите её сюда ВМЕСТЕ с
назначением. Оба потребителя сверяются с реальной базой (`verify`) и
показывают расхождение: генератор отказывается собирать схему, отчёт
выводит красную плашку «описание отстало от базы». Молча устареть это
описание не может — ради этого сверка и сделана.

Модуль намеренно БЕЗ зависимостей (только стандартная библиотека и никаких
импортов из `app`): его подключает скрипт, который запускают системным
python3 на сервере, где ни venv, ни FastAPI может не быть.
"""

# цвета доменов
C_HIER = "#dae8fc"   # проекты/объекты
C_USER = "#d5e8d4"   # пользователи/доступ
C_ELEM = "#ffe6cc"   # элементы и история
C_ZONE = "#e1d5e7"   # зоны
C_CONTR = "#fff2cc"  # контрактация
C_REF = "#f5f5f5"    # справочники/настройки/журнал

S_HIER = "#6c8ebf"
S_USER = "#82b366"
S_ELEM = "#d79b00"
S_ZONE = "#9673a6"
S_CONTR = "#d6b656"
S_REF = "#999999"

# ------------------------------------------------------------------ таблицы
# (имя, подпись, цвет, обводка, [(поле, тип, ключ, назначение), ...])
# ключ: "PK" | "FK" | "PK,FK" | "" | "U" (уникальный)

TABLES = [
("projects", "projects — Проект", C_HIER, S_HIER, [
    ("id", "INTEGER", "PK", "идентификатор проекта"),
    ("name", "TEXT", "U", "название проекта (уникально)"),
    ("address", "TEXT", "", "адрес стройплощадки"),
    ("description", "TEXT", "", "описание"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("objects", "objects — Объект (здание)", C_HIER, S_HIER, [
    ("id", "INTEGER", "PK", "идентификатор объекта; единица показа схемы"),
    ("name", "TEXT", "U", "название объекта (уникально; ключ переноса настроек)"),
    ("project_id", "INTEGER", "FK", "проект-владелец → projects.id (RESTRICT)"),
    ("address", "TEXT", "", "адрес объекта"),
    ("description", "TEXT", "", "описание"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("object_drawings", "object_drawings — версии чертежа объекта", C_HIER, S_HIER, [
    ("object_id", "INTEGER", "PK,FK", "объект → objects.id (CASCADE)"),
    ("source_file", "TEXT", "PK", "имя DXF-файла (версия чертежа)"),
    ("is_current", "INTEGER", "", "1 — актуальная версия (ровно одна на объект)"),
    ("imported_at", "TEXT", "", "когда загружен"),
]),
("users", "users — Пользователи", C_USER, S_USER, [
    ("id", "INTEGER", "PK", "идентификатор пользователя"),
    ("last_name", "TEXT", "", "фамилия"),
    ("first_name", "TEXT", "", "имя"),
    ("patronymic", "TEXT", "", "отчество"),
    ("position", "TEXT", "", "должность"),
    ("department", "TEXT", "", "подразделение"),
    ("domain_login", "TEXT", "U", "доменный логин (уникален, по нему вход)"),
    ("role", "TEXT", "", "СИСТЕМНАЯ роль: admin/user/view (ведение сервиса)"),
    ("password_hash", "TEXT", "", "хэш пароля сервиса; NULL = входа по паролю нет"),
    ("password_salt", "TEXT", "", "соль пароля"),
    ("auth_method", "TEXT", "", "чем проверяется вход: local (пароль сервиса) / domain (учётная запись домена, LDAP)"),
    ("label_color", "TEXT", "", "персональный цвет подписей марок на схеме"),
    ("ui_theme", "TEXT", "", "персональная цветовая гамма интерфейса; NULL = по умолчанию"),
    ("must_change_password", "INTEGER", "", "пароль задан администратором и должен быть заменён при первом входе"),
    ("changelog_ack_version", "TEXT", "", "подтверждённая кнопкой «Ознакомился» версия «Что нового»; NULL = не подтверждал"),
    ("view3d_pitch_deg", "REAL", "", "начальный ракурс 3D: подъём камеры над горизонтом, градусы (90 = вид сверху)"),
    ("view3d_yaw_deg", "REAL", "", "начальный ракурс 3D: поворот вокруг объекта, градусы (0 = числовые оси вертикально)"),
    ("last_object_id", "INTEGER", "FK", "последний выбранный объект → objects.id"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("sessions", "sessions — Сессии входа", C_USER, S_USER, [
    ("token", "TEXT", "PK", "токен из cookie"),
    ("user_id", "INTEGER", "FK", "владелец сессии → users.id (CASCADE)"),
    ("created_at", "TEXT", "", "начало сессии"),
    ("expires_at", "TEXT", "", "истекает (30 дней)"),
    ("created_ip", "TEXT", "", "адрес, с которого вошли; NULL у сеансов, выданных до появления колонки"),
    ("user_agent", "TEXT", "", "устройство и браузер входа (для списка активных сеансов)"),
    ("last_seen_at", "TEXT", "", "когда сеансом пользовались (пишется не чаще раза в минуту; по нему считается таймаут бездействия)"),
]),
("user_access", "user_access — Доступ и роль на объекте", C_USER, S_USER, [
    ("id", "INTEGER", "PK", "идентификатор гранта"),
    ("user_id", "INTEGER", "FK", "кому выдан → users.id (CASCADE)"),
    ("project_id", "INTEGER", "FK", "проект → projects.id (CASCADE)"),
    ("object_id", "INTEGER", "FK", "объект → objects.id; NULL = весь проект"),
    ("role", "TEXT", "", "роль на этом объекте/проекте: admin/contract/user/view"),
    ("created_at", "TEXT", "", "выдан"),
]),
("elements", "elements — Элементы ЖБИ (ядро)", C_ELEM, S_ELEM, [
    ("id", "INTEGER", "PK", "идентификатор строки"),
    ("element_uid", "TEXT", "U", "сквозной идентификатор, переживает перевыпуск чертежа"),
    ("object_id", "INTEGER", "FK", "объект-владелец → objects.id"),
    ("source_file", "TEXT", "", "файл, из которого элемент пришёл в последний раз"),
    ("dxf_handle", "TEXT", "", "handle объекта в DXF (уникален с source_file)"),
    ("is_current", "INTEGER", "", "1 — есть в актуальной версии чертежа; 0 — исчез"),
    ("layer", "TEXT", "", "имя слоя DXF (WEB_констр_…)"),
    ("element_type", "TEXT", "", "тип: Колонна / Ригель / Панель / Плита перекрытия"),
    ("subtype", "TEXT", "", "подтип (нижняя/верхняя, «на отм. +15.000», …)"),
    ("mark", "TEXT", "", "марка изделия (напр. 4Кв2)"),
    ("mark_source", "TEXT", "", "откуда взята марка при разборе DXF"),
    ("x", "REAL", "", "координата X марки/выноски, мм"),
    ("y", "REAL", "", "координата Y марки/выноски, мм"),
    ("z", "REAL", "", "координата Z, мм"),
    ("elevation_mm", "INTEGER", "", "отметка яруса, мм"),
    ("floor", "INTEGER", "", "этаж (из суффикса слоя либо расчёт по отметке)"),
    ("outline_json", "TEXT", "", "реальный контур (JSON-точки) — основа 2D/3D-геометрии"),
    ("address", "TEXT", "", "готовый адрес по осям"),
    ("axis_status", "TEXT", "", "результат адресации (точно/приблизительно/нет)"),
    ("axis_number", "TEXT", "", "цифровая ось при точном попадании"),
    ("axis_letter", "TEXT", "", "буквенная ось при точном попадании"),
    ("nearest_axis_number", "TEXT", "", "ближайшая цифровая ось"),
    ("nearest_axis_letter", "TEXT", "", "ближайшая буквенная ось"),
    ("offset_x_mm", "REAL", "", "смещение от ближайшей оси по X, мм"),
    ("offset_y_mm", "REAL", "", "смещение от ближайшей оси по Y, мм"),
    ("zone_zakhvatka_id", "INTEGER", "FK", "захватка → zones.id"),
    ("zone_zakhvatka_status", "TEXT", "", "как определилась привязка к захватке"),
    ("zone_crane_id", "INTEGER", "FK", "кран → zones.id"),
    ("zone_crane_status", "TEXT", "", "как определилась привязка к крану"),
    ("zone_stance_id", "INTEGER", "FK", "стоянка крана → zones.id"),
    ("zone_stance_status", "TEXT", "", "как определилась привязка к стоянке"),
    ("zone_stance_level_id", "INTEGER", "FK", "конкретный ярус стоянки → zone_levels.id"),
    ("current_status", "TEXT", "", "текущий статус — по последней записи истории (changed_at)"),
    ("contract_id", "INTEGER", "FK", "контракт-реквизит → contracts.id; пуст при «Запланирован»"),
    ("planned_delivery_date", "TEXT", "", "плановая дата поставки (правится вручную)"),
    ("project_smr_start_date", "TEXT", "", "начало СМР по графику MS Project"),
    ("project_delivery_date", "TEXT", "", "завершение СМР по графику MS Project"),
    ("actual_delivery_date", "TEXT", "", "факт перехода в «Доставлено» (кэш по истории)"),
    ("manual_fields", "TEXT", "", "JSON-список полей, правленных вручную (импорт их не трогает)"),
    ("comment", "TEXT", "", "произвольный комментарий к изделию («отбит угол при разгрузке»)"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён (по нему работает опрос /changes)"),
]),
("attachments", "attachments — Вложения (проект/объект/элемент)", C_USER, S_USER, [
    ("id", "INTEGER", "PK", "идентификатор вложения"),
    ("entity_type", "TEXT", "", "владелец: project / object / element"),
    ("entity_id", "INTEGER", "", "идентификатор владельца в своей таблице (не FK — таблиц три)"),
    ("filename", "TEXT", "", "исходное имя файла у пользователя"),
    ("stored_name", "TEXT", "", "имя на диске (uuid, в uploads/attachments/)"),
    ("size", "INTEGER", "", "размер, байт"),
    ("content_type", "TEXT", "", "тип содержимого из загрузки"),
    ("description", "TEXT", "", "описание"),
    ("uploaded_at", "TEXT", "", "когда загружен"),
    ("uploaded_by", "TEXT", "", "ФИО загрузившего на момент загрузки"),
    ("uploaded_by_user_id", "INTEGER", "FK", "загрузивший → users.id (SET NULL)"),
]),
("status_history", "status_history — История статусов (аудит)", C_ELEM, S_ELEM, [
    ("id", "INTEGER", "PK", "идентификатор записи"),
    ("element_id", "INTEGER", "FK", "элемент → elements.id (CASCADE)"),
    ("status", "TEXT", "", "статус на этот момент"),
    ("changed_at", "TEXT", "", "«рабочая дата» — по ней и определяется текущий статус"),
    ("changed_by", "TEXT", "", "ФИО снимком (переживает переименование пользователя)"),
    ("changed_by_user_id", "INTEGER", "FK", "аккаунт → users.id (SET NULL)"),
    ("contract_id", "INTEGER", "FK", "контракт снимком → contracts.id (аудит)"),
    ("comment", "TEXT", "", "комментарий к смене"),
]),
("axis_lines", "axis_lines — Сетка осей чертежа", C_ELEM, S_ELEM, [
    ("id", "INTEGER", "PK", "идентификатор линии"),
    ("source_file", "TEXT", "U", "файл чертежа"),
    ("kind", "TEXT", "U", "numeric — цифровая ось, letter — буквенная"),
    ("label", "TEXT", "U", "подпись оси"),
    ("coord", "REAL", "", "координата оси, мм"),
]),
("zones", "zones — Зоны: захватка / кран / стоянка", C_ZONE, S_ZONE, [
    ("id", "INTEGER", "PK", "идентификатор записи справочника зон"),
    ("object_id", "INTEGER", "FK", "объект → objects.id"),
    ("category", "TEXT", "", "Захватка / Кран / Стоянка"),
    ("number", "INTEGER", "", "номер зоны — часть идентичности при переимпорте"),
    ("name", "TEXT", "", "подпись зоны из чертежа"),
    ("parent_zone_id", "INTEGER", "FK", "родительский кран у стоянки → zones.id"),
    ("parent_match_status", "TEXT", "", "как определился родительский кран"),
    ("match_status", "TEXT", "", "matched / unmatched / ambiguous — сопоставление с текстом"),
    ("is_current", "INTEGER", "", "1 — зона актуальной версии чертежа"),
    ("source_file", "TEXT", "", "происхождение: файл последнего импорта"),
    ("dxf_handle", "TEXT", "", "происхождение: handle полигона в DXF"),
    ("elevation_mm", "INTEGER", "", "наследие старой ярусной формы (геометрия — в zone_levels)"),
    ("outline_json", "TEXT", "", "наследие старой формы: контур зон прошлых версий"),
]),
("zone_levels", "zone_levels — Ярусы зоны (полигоны)", C_ZONE, S_ZONE, [
    ("id", "INTEGER", "PK", "идентификатор яруса"),
    ("zone_id", "INTEGER", "FK", "зона → zones.id (CASCADE)"),
    ("elevation_mm", "INTEGER", "", "отметка яруса; NULL у захватки и крана"),
    ("outline_json", "TEXT", "", "контур яруса (JSON-точки, мировые координаты)"),
    ("source_file", "TEXT", "", "происхождение: файл"),
    ("dxf_handle", "TEXT", "", "происхождение: handle в DXF"),
]),
("zone_edit_undo", "zone_edit_undo — Снимок «до» правки зоны", C_ZONE, S_ZONE, [
    ("id", "INTEGER", "PK", "идентификатор снимка"),
    ("zone_id", "INTEGER", "FK", "зона → zones.id (CASCADE)"),
    ("user_id", "INTEGER", "FK", "кто правил → users.id (SET NULL)"),
    ("user_name", "TEXT", "", "ФИО снимком"),
    ("zone_json", "TEXT", "", "реквизиты и ярусы зоны до правки"),
    ("bindings_json", "TEXT", "", "прежние привязки элементов, изменённые пересчётом"),
    ("created_at", "TEXT", "", "когда сделан снимок"),
    ("undone_at", "TEXT", "", "когда откат применён (защита от повторного отката)"),
]),
("zone_colors", "zone_colors — Цвет зоны (на кран)", C_ZONE, S_ZONE, [
    ("object_id", "INTEGER", "PK,FK", "объект → objects.id (CASCADE)"),
    ("category", "TEXT", "PK", "категория зоны"),
    ("name", "TEXT", "PK", "имя зоны (переживает переимпорт, в отличие от id)"),
    ("color", "TEXT", "", "цвет; стоянки наследуют цвет своего крана"),
]),
("counterparties", "counterparties — Контрагенты", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор контрагента (сквозной для всех строек)"),
    ("full_name", "TEXT", "", "полное наименование юрлица"),
    ("short_name", "TEXT", "", "краткое наименование"),
    ("inn", "TEXT", "", "ИНН"),
    ("kpp", "TEXT", "", "КПП"),
    ("ogrn", "TEXT", "", "ОГРН"),
    ("legal_address", "TEXT", "", "юридический адрес"),
    ("contact_person", "TEXT", "", "контактное лицо"),
    ("contact_phone", "TEXT", "", "телефон"),
    ("code", "TEXT", "", "короткий код для допстроки подписи на схеме"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("agreements", "agreements — Договоры", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор договора"),
    ("counterparty_id", "INTEGER", "FK", "контрагент → counterparties.id (CASCADE)"),
    ("object_id", "INTEGER", "FK", "объект → objects.id (RESTRICT); договор — объектный"),
    ("number", "TEXT", "U", "номер договора (уникален у контрагента)"),
    ("agreement_date", "TEXT", "", "дата договора"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("specifications", "specifications — Спецификации", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор спецификации"),
    ("agreement_id", "INTEGER", "FK", "договор → agreements.id (CASCADE)"),
    ("number", "TEXT", "U", "номер спецификации (уникален в договоре)"),
    ("specification_date", "TEXT", "", "дата спецификации (она же дата контракта)"),
    ("created_at", "TEXT", "", "создана"),
    ("updated_at", "TEXT", "", "изменена"),
]),
("contracts", "contracts — Контракты", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор контракта"),
    ("specification_id", "INTEGER", "FK", "спецификация → specifications.id (RESTRICT)"),
    ("theme", "TEXT", "", "тема; наименование целиком генерируется из цепочки реквизитов"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("contract_lines", "contract_lines — Позиции контракта", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор позиции"),
    ("contract_id", "INTEGER", "FK", "контракт → contracts.id (CASCADE)"),
    ("element_type", "TEXT", "", "тип элемента; NULL — импорт не определил тип по марке"),
    ("mark", "TEXT", "", "марка изделия; NULL допустим"),
    ("quantity", "INTEGER", "", "законтрактованное количество (план)"),
]),
("contract_incidents", "contract_incidents — Повреждения по контракту", C_CONTR, S_CONTR, [
    ("id", "INTEGER", "PK", "идентификатор инцидента"),
    ("contract_id", "INTEGER", "FK", "контракт → contracts.id (CASCADE)"),
    ("element_type", "TEXT", "", "тип повреждённых изделий"),
    ("quantity", "INTEGER", "", "количество (сразу вычитается из остатка)"),
    ("incident_date", "TEXT", "", "дата инцидента"),
    ("description", "TEXT", "", "описание"),
]),
("default_contracts", "default_contracts — Контракт по умолчанию", C_CONTR, S_CONTR, [
    ("object_id", "INTEGER", "PK,FK", "объект → objects.id (CASCADE)"),
    ("element_type", "TEXT", "PK", "тип элемента"),
    ("contract_id", "INTEGER", "FK", "подставляемый контракт → contracts.id (SET NULL)"),
]),
("mark_type_prefixes", "mark_type_prefixes — Префикс марки → тип", C_REF, S_REF, [
    ("prefix", "TEXT", "PK", "начало марки (эвристика импорта контрактации)"),
    ("element_type", "TEXT", "", "тип элемента для такой марки"),
]),
("allowed_subtypes", "allowed_subtypes — Допустимые подтипы", C_REF, S_REF, [
    ("element_type", "TEXT", "PK", "тип элемента"),
    ("subtype", "TEXT", "PK", "разрешённый подтип (разбор имени слоя без учёта регистра)"),
]),
("status_colors", "status_colors — Цвета статусов", C_REF, S_REF, [
    ("status", "TEXT", "PK", "код статуса (planned, delivered, …)"),
    ("color", "TEXT", "", "цвет заливки на схеме"),
]),
("element_shapes", "element_shapes — Форма маркера", C_REF, S_REF, [
    ("layer", "TEXT", "PK", "слой DXF"),
    ("element_type", "TEXT", "PK", "тип элемента"),
    ("shape", "TEXT", "", "форма на схеме; по умолчанию реальный контур"),
]),
("label_visibility", "label_visibility — Видимость подписей", C_REF, S_REF, [
    ("object_id", "INTEGER", "PK,FK", "объект → objects.id (CASCADE)"),
    ("element_type", "TEXT", "PK", "тип элемента"),
    ("visible", "INTEGER", "", "показывать марку (по умолчанию выключено — быстродействие)"),
    ("dates_visible", "INTEGER", "", "показывать допстроку с кодом и датой"),
]),
("app_settings", "app_settings — Настройки (ключ-значение)", C_REF, S_REF, [
    ("key", "TEXT", "U", "ключ настройки"),
    ("object_id", "INTEGER", "FK", "объект → objects.id; NULL = системная запись (маркер миграции)"),
    ("value", "TEXT", "", "значение (часто JSON)"),
]),
("report_notes", "report_notes — Тексты отчёта на дату", C_REF, S_REF, [
    ("id", "INTEGER", "PK", "идентификатор редакции"),
    ("object_id", "INTEGER", "FK", "объект → objects.id (CASCADE)"),
    ("effective_date", "TEXT", "U", "дата, с которой действует редакция (одна на дату)"),
    ("key_events", "TEXT", "", "ключевые события, JSON-массив строк"),
    ("key_tasks", "TEXT", "", "ключевые задачи, JSON-массив"),
    ("open_questions", "TEXT", "", "открытые вопросы, JSON-массив"),
    ("updated_at", "TEXT", "", "изменена"),
    ("updated_by", "TEXT", "", "кем изменена (ФИО снимком)"),
]),
("activity_log", "activity_log — Журнал действий", C_REF, S_REF, [
    ("id", "INTEGER", "PK", "идентификатор события"),
    ("at", "TEXT", "", "момент события, время СЕРВЕРА"),
    ("source", "TEXT", "", "server — событие сервиса, client — тайминг браузера"),
    ("user_id", "INTEGER", "FK", "пользователь → users.id (SET NULL)"),
    ("user_name", "TEXT", "", "ФИО снимком"),
    ("action", "TEXT", "", "действие: status_change, form_open, import_input, …"),
    ("entity_type", "TEXT", "", "над чем: element / contract / …"),
    ("entity_id", "INTEGER", "", "идентификатор сущности (без FK — журнал переживает удаление)"),
    ("element_type", "TEXT", "", "тип снимком (по нему ищут в журнале)"),
    ("subtype", "TEXT", "", "подтип снимком"),
    ("mark", "TEXT", "", "марка снимком"),
    ("old_value", "TEXT", "", "было"),
    ("new_value", "TEXT", "", "стало"),
    ("duration_ms", "REAL", "", "длительность; у клиента — по performance.now()"),
    ("request_id", "TEXT", "", "связывает клиентские и серверные события одной операции"),
    ("details", "TEXT", "", "произвольный JSON с подробностями"),
]),
]

# ------------------------------------------------------------------- связи
# (таблица-потомок, поле, таблица-предок, поле, подпись)
FKS = [
    ("objects", "project_id", "projects", "id", "RESTRICT"),
    ("object_drawings", "object_id", "objects", "id", "CASCADE"),
    ("users", "last_object_id", "objects", "id", "SET NULL"),
    ("sessions", "user_id", "users", "id", "CASCADE"),
    ("attachments", "uploaded_by_user_id", "users", "id", "SET NULL"),
    ("user_access", "user_id", "users", "id", "CASCADE"),
    ("user_access", "project_id", "projects", "id", "CASCADE"),
    ("user_access", "object_id", "objects", "id", "CASCADE"),
    ("elements", "object_id", "objects", "id", "SET NULL"),
    ("elements", "contract_id", "contracts", "id", "SET NULL"),
    ("elements", "zone_zakhvatka_id", "zones", "id", "SET NULL"),
    ("elements", "zone_crane_id", "zones", "id", "SET NULL"),
    ("elements", "zone_stance_id", "zones", "id", "SET NULL"),
    ("elements", "zone_stance_level_id", "zone_levels", "id", "SET NULL"),
    ("status_history", "element_id", "elements", "id", "CASCADE"),
    ("status_history", "changed_by_user_id", "users", "id", "SET NULL"),
    ("status_history", "contract_id", "contracts", "id", "SET NULL"),
    ("zones", "object_id", "objects", "id", "SET NULL"),
    ("zones", "parent_zone_id", "zones", "id", "стоянка → кран"),
    ("zone_levels", "zone_id", "zones", "id", "CASCADE"),
    ("zone_edit_undo", "zone_id", "zones", "id", "CASCADE"),
    ("zone_edit_undo", "user_id", "users", "id", "SET NULL"),
    ("zone_colors", "object_id", "objects", "id", "CASCADE"),
    ("agreements", "counterparty_id", "counterparties", "id", "CASCADE"),
    ("agreements", "object_id", "objects", "id", "RESTRICT"),
    ("specifications", "agreement_id", "agreements", "id", "CASCADE"),
    ("contracts", "specification_id", "specifications", "id", "RESTRICT"),
    ("contract_lines", "contract_id", "contracts", "id", "CASCADE"),
    ("contract_incidents", "contract_id", "contracts", "id", "CASCADE"),
    ("default_contracts", "object_id", "objects", "id", "CASCADE"),
    ("default_contracts", "contract_id", "contracts", "id", "SET NULL"),
    ("label_visibility", "object_id", "objects", "id", "CASCADE"),
    ("app_settings", "object_id", "objects", "id", "CASCADE"),
    ("report_notes", "object_id", "objects", "id", "CASCADE"),
    ("activity_log", "user_id", "users", "id", "SET NULL"),
]

# логические связи без внешнего ключа (пунктиром)
SOFT = [
    ("elements", "source_file", "object_drawings", "source_file", "версия чертежа"),
    ("axis_lines", "source_file", "object_drawings", "source_file", "сетка осей файла"),
    ("zones", "source_file", "object_drawings", "source_file", "происхождение"),
    ("elements", "current_status", "status_colors", "status", "цвет статуса"),
    ("elements", "subtype", "allowed_subtypes", "subtype", "справочник подтипов"),
    ("elements", "layer", "element_shapes", "layer", "форма маркера"),
    ("elements", "element_type", "label_visibility", "element_type", "видимость подписей"),
    ("elements", "element_type", "default_contracts", "element_type", "контракт по умолчанию"),
    ("contract_lines", "mark", "mark_type_prefixes", "prefix", "тип по префиксу марки"),
    ("elements", "mark", "contract_lines", "mark", "план по марке ↔ факт"),
]

# ------------------------------------------------------------------ раскладка
# Порядок колонок подобран так, чтобы таблицы стояли рядом со своими
# предками: короткая связь не пересекает половину полотна.

BY_NAME = {t[0]: t for t in TABLES}

# Домен таблицы — по цвету заливки: чем окрашена в схеме, к той группе и
# относится. Отдельного поля «домен» у таблицы нет намеренно, иначе цвет и
# группа разошлись бы.
DOMAIN_BY_FILL = {
    C_HIER: "Иерархия: проекты и объекты",
    C_USER: "Пользователи, сессии, доступ",
    C_ELEM: "Элементы ЖБИ и история статусов",
    C_ZONE: "Зоны: захватка / кран / стоянка",
    C_CONTR: "Контрактация",
    C_REF: "Справочники, настройки, журнал",
}

# Колонки, значение которых нельзя показывать НИКОМУ, даже системному
# администратору: это не «личные данные», а материал для входа под чужой
# учётной записью. Хэш с солью — материал для подбора пароля офлайн, токен
# сессии — готовый вход без пароля (достаточно подставить его в cookie).
# Просмотр содержимого таблиц (`app/db_status.py`) их маскирует.
SECRET_COLUMNS = {
    ("users", "password_hash"),
    ("users", "password_salt"),
    ("sessions", "token"),
}


def fields_of(table: str) -> list:
    """Поля таблицы: список (имя, тип, ключ, назначение). Пусто — таблицы нет."""
    row = BY_NAME.get(table)
    return list(row[4]) if row else []


def purpose_of(table: str, field: str) -> str:
    for имя, _тип, _ключ, назначение in fields_of(table):
        if имя == field:
            return назначение
    return ""


def verify(conn) -> list:
    """Сверить это описание с реальной схемой открытой базы.

    Возвращает список расхождений (пустой — всё сходится). Сверяются состав
    таблиц, состав полей у каждой и внешние ключи: ровно то, что ломается
    после миграции и чего в самой диаграмме глазами не увидеть.

    Принимает готовое соединение, а не путь: у приложения оно уже открыто
    (`app/db.get_connection`), а скрипт открывает своё в режиме только чтения.
    """
    problems = []
    db_tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%'")}
    mine = set(BY_NAME)
    for t in sorted(db_tables - mine):
        problems.append("таблица есть в БД, но не в описании: %s" % t)
    for t in sorted(mine - db_tables):
        problems.append("таблица есть в описании, но не в БД: %s" % t)

    for name in sorted(db_tables & mine):
        db_fields = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % name)]
        my_fields = [f[0] for f in BY_NAME[name][4]]
        for c in db_fields:
            if c not in my_fields:
                problems.append("%s: поле есть в БД, но не в описании: %s" % (name, c))
        for c in my_fields:
            if c not in db_fields:
                problems.append("%s: поле есть в описании, но не в БД: %s" % (name, c))

    db_fks = set()
    for name in db_tables:
        for r in conn.execute("PRAGMA foreign_key_list(%s)" % name):
            db_fks.add((name, r[3], r[2], r[4] or "id"))
    my_fks = {(a, b, c, d) for a, b, c, d, _ in FKS}
    for fk in sorted(db_fks - my_fks):
        problems.append("внешний ключ есть в БД, но не в описании: %s.%s -> %s.%s" % fk)
    for fk in sorted(my_fks - db_fks):
        problems.append("внешний ключ есть в описании, но не в БД: %s.%s -> %s.%s" % fk)
    return problems
