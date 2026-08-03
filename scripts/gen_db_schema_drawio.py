#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пересборка схемы базы данных в формате draw.io (Docs/db-schema.drawio).

  python3 scripts/gen_db_schema_drawio.py

Зачем отдельный генератор, а не рисование руками: схема из 28 таблиц и
210 полей руками не переживает ни одной миграции — её перестают
обновлять на второй правке, и она начинает врать. Здесь же достаточно
дописать поле в список и перезапустить.

ЧТО ЗДЕСЬ ИСТОЧНИК ЧЕГО. Состав таблиц, полей и внешних ключей берётся
из РЕАЛЬНОЙ базы (`data/zhbi.db` после всех миграций) — но только для
СВЕРКИ, не для генерации: назначения полей («что это поле значит и чем
меняется») из SQLite вытащить нельзя, они написаны руками в TABLES ниже.
Поэтому скрипт сначала сверяет свой список с базой и, если они
разошлись, НИЧЕГО НЕ ПИШЕТ, а печатает расхождения: после миграции
нужно дописать новое поле вместе с его назначением, иначе схема тихо
устареет — ровно то, ради чего генератор и заводился.

  --db ПУТЬ      база для сверки (по умолчанию $ZHBI_DB_PATH или
                 data/zhbi.db; если файла нет — сверка пропускается)
  --out ПУТЬ     куда писать (по умолчанию Docs/db-schema.drawio)
  --force        собрать несмотря на расхождения со схемой БД
  --no-check     не сверяться с базой вовсе

Зависимостей нет, только стандартная библиотека. Проверить результат
можно экспортом самим draw.io (на Mac разработчика он установлен):

  /Applications/draw.io.app/Contents/MacOS/draw.io --export --format png \\
      --scale 0.5 --output /tmp/schema.png Docs/db-schema.drawio
"""

import html
import os
import sqlite3
import sys
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.environ.get("ZHBI_DB_PATH") or os.path.join(REPO, "data", "zhbi.db")
DEFAULT_OUT = os.path.join(REPO, "Docs", "db-schema.drawio")

# ------------------------------------------------------------------ геометрия
W = 520          # ширина таблицы
HEAD = 34        # высота заголовка
ROW = 24         # высота строки поля
COL_GAP = 260    # промежуток между колонками — в нём лежат «дорожки» связей
ROW_GAP = 90
Y0 = 120
X0 = 320         # отступ слева: в нём разворачиваются связи внутри первой колонки

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
    ("last_object_id", "INTEGER", "FK", "последний выбранный объект → objects.id"),
    ("created_at", "TEXT", "", "создан"),
    ("updated_at", "TEXT", "", "изменён"),
]),
("sessions", "sessions — Сессии входа", C_USER, S_USER, [
    ("token", "TEXT", "PK", "токен из cookie"),
    ("user_id", "INTEGER", "FK", "владелец сессии → users.id (CASCADE)"),
    ("created_at", "TEXT", "", "начало сессии"),
    ("expires_at", "TEXT", "", "истекает (30 дней)"),
]),
("user_access", "user_access — Доступ и роль на объекте", C_USER, S_USER, [
    ("id", "INTEGER", "PK", "идентификатор гранта"),
    ("user_id", "INTEGER", "FK", "кому выдан → users.id (CASCADE)"),
    ("project_id", "INTEGER", "FK", "проект → projects.id (CASCADE)"),
    ("object_id", "INTEGER", "FK", "объект → objects.id; NULL = весь проект"),
    ("role", "TEXT", "", "роль на этом объекте/проекте: admin/user/view"),
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
COLUMNS = [
    ["users", "sessions", "user_access", "attachments", "activity_log", "status_colors",
     "element_shapes", "allowed_subtypes"],
    ["projects", "objects", "object_drawings", "label_visibility", "zone_colors",
     "app_settings", "report_notes"],
    ["elements", "status_history", "axis_lines"],
    ["zones", "zone_levels", "zone_edit_undo", "default_contracts", "mark_type_prefixes"],
    ["counterparties", "agreements", "specifications", "contracts", "contract_lines",
     "contract_incidents"],
]

BY_NAME = {t[0]: t for t in TABLES}

# Цвет связи — по таблице, НА КОТОРУЮ она ссылается: все линии, ведущие в
# objects, одного цвета, в contracts — другого. Так пучок из десятка ссылок
# на один справочник читается как единое целое, а соседние пучки не путаются.
PARENT_COLOR = {
    "objects":           "#1a73c8",
    "projects":          "#0b7285",
    "users":             "#2f9e44",
    "elements":          "#e8590c",
    "contracts":         "#b54708",
    "zones":             "#7048e8",
    "zone_levels":       "#c026d3",
    "counterparties":    "#c2255c",
    "agreements":        "#9d174d",
    "specifications":    "#7c3aed",
    "object_drawings":   "#0e9f9f",
    "status_colors":     "#8d6e63",
    "allowed_subtypes":  "#5c6bc0",
    "element_shapes":    "#6d4c41",
    "label_visibility":  "#00838f",
    "default_contracts": "#946200",
    "contract_lines":    "#a16207",
    "mark_type_prefixes": "#78716c",
}

EDGE_BASE = ("edgeStyle=orthogonalEdgeStyle;rounded=1;arcSize=12;html=1;fontSize=10;"
             "jumpStyle=arc;jumpSize=10;labelBackgroundColor=#ffffff;")

LEGEND_ITEMS = [
    ("Иерархия: проекты и объекты", C_HIER, S_HIER),
    ("Пользователи, сессии, доступ", C_USER, S_USER),
    ("Элементы ЖБИ и история статусов", C_ELEM, S_ELEM),
    ("Зоны: захватка / кран / стоянка", C_ZONE, S_ZONE),
    ("Контрактация", C_CONTR, S_CONTR),
    ("Справочники, настройки, журнал", C_REF, S_REF),
]


def esc(s):
    return html.escape(str(s), quote=True)


def key_badge(k):
    """Пометка ключа перед именем поля: PK / FK / PK+FK / U."""
    if not k:
        return ""
    if k == "U":
        return '<font color="#7f0000">U&nbsp;</font>'
    return '<font color="#00527c"><b>%s</b>&nbsp;</font>' % k.replace(",", "+")


def build_xml(subtitle):
    """Собрать полный XML диаграммы. Возвращает строку."""
    missing = {n for col in COLUMNS for n in col} ^ set(BY_NAME)
    if missing:
        raise SystemExit("раскладка COLUMNS расходится со списком TABLES: %s"
                         % ", ".join(sorted(missing)))

    cells = []
    row_ids = {}    # (таблица, поле) -> id ячейки строки
    row_y = {}      # (таблица, поле) -> абсолютная Y середины строки
    col_x = []      # X каждой колонки
    table_col = {}  # таблица -> индекс колонки
    bottom = Y0     # нижняя граница самой длинной колонки — под ней идут «шины»

    # --------------------------------------------------------------- таблицы
    x = X0
    for ci, col in enumerate(COLUMNS):
        col_x.append(x)
        y = Y0
        for name in col:
            table_col[name] = ci
            tname, caption, fill, stroke, fields = BY_NAME[name]
            h = HEAD + ROW * len(fields)
            tid = "t_" + tname
            cells.append(
                '<mxCell id="%s" value="%s" style="shape=table;startSize=%d;container=1;'
                'collapsible=0;childLayout=tableLayout;fixedRows=1;rowLines=0;fontStyle=1;'
                'fontSize=13;align=center;resizeLast=1;html=1;fillColor=%s;strokeColor=%s;'
                'swimlaneFillColor=#ffffff;" vertex="1" parent="1">'
                '<mxGeometry x="%d" y="%d" width="%d" height="%d" as="geometry"/></mxCell>'
                % (tid, esc(caption), HEAD, fill, stroke, x, y, W, h)
            )
            for i, (fname, ftype, fkey, purpose) in enumerate(fields):
                rid = "%s_%s_%d" % (tid, fname, i)
                row_ids[(tname, fname)] = rid
                # абсолютная середина строки — нужна для ручной маршрутизации связей
                row_y[(tname, fname)] = y + HEAD + i * ROW + ROW // 2
                cells.append(
                    '<mxCell id="%s" value="" style="shape=tableRow;horizontal=0;startSize=0;'
                    'swimlaneHead=0;swimlaneBody=0;fillColor=none;collapsible=0;dropTarget=0;'
                    'points=[[0,0.5],[1,0.5]];portConstraint=eastwest;top=0;left=0;right=0;'
                    'bottom=0;strokeColor=%s;" vertex="1" parent="%s">'
                    '<mxGeometry y="%d" width="%d" height="%d" as="geometry"/></mxCell>'
                    % (rid, stroke, tid, HEAD + i * ROW, W, ROW)
                )
                # HTML-разметка подписи собирается сырой, а затем целиком
                # экранируется — это значение XML-атрибута, drawio разбирает
                # её обратно. Без экранирования файл просто не открывается.
                label = esc('%s<b>%s</b> <font color="#808080">%s</font> — %s'
                            % (key_badge(fkey), fname, ftype, purpose))
                cells.append(
                    '<mxCell id="%s_c" value="%s" style="shape=partialRectangle;connectable=0;'
                    'fillColor=none;align=left;verticalAlign=middle;strokeColor=none;'
                    'overflow=hidden;spacingLeft=8;spacingRight=8;html=1;fontSize=11;" '
                    'vertex="1" parent="%s"><mxGeometry width="%d" height="%d" as="geometry"/>'
                    '</mxCell>' % (rid, label, rid, W, ROW)
                )
            y += h + ROW_GAP
            bottom = max(bottom, y - ROW_GAP)
        x += W + COL_GAP

    # ----------------------------------------------------------------- связи
    # Счётчики «дорожек»: у каждой связи собственная вертикаль в промежутке
    # между колонками, иначе десяток ссылок на objects.id слился бы в одну
    # линию — их было бы не различить и не проследить.
    lanes = {}
    state = {"bus": 0, "label_slot": 0}

    def lane_x(side, ci):
        """X вертикального участка. side: 'L' — слева от колонки, 'R' — справа."""
        k = lanes.get((side, ci), 0)
        lanes[(side, ci)] = k + 1
        if side == "L":
            return col_x[ci] - 30 - k * 18
        return col_x[ci] + W + 30 + k * 18

    def edge_xml(eid, child, cf, parent, pf, label, soft):
        ccol, pcol = table_col[child], table_col[parent]
        cy, py = row_y[(child, cf)], row_y[(parent, pf)]
        color = PARENT_COLOR.get(parent, "#4d4d4d")

        if ccol == pcol:
            # Внутри одной колонки — разворот в промежутке слева от неё.
            side, exitp, entryp = "L", (0, 0.5), (0, 0.5)
        elif ccol < pcol:
            # Предок правее: подходим к нему слева.
            side, exitp, entryp = "L", (1, 0.5), (0, 0.5)
        else:
            # Предок левее: подходим справа.
            side, exitp, entryp = "R", (0, 0.5), (1, 0.5)
        lx = lane_x(side, pcol)

        if abs(ccol - pcol) >= 2:
            # Связь через две и более колонки: горизонтальный участок на
            # уровне строки прошёл бы ПОВЕРХ промежуточных таблиц и
            # перечеркнул их текст. Поэтому такие связи уходят вниз, идут по
            # своей «шине» под схемой и поднимаются к предку — по дороге не
            # задевая ни одной таблицы.
            cside = "R" if pcol > ccol else "L"
            cx = lane_x(cside, ccol)
            by = bottom + 70 + state["bus"] * 22
            state["bus"] += 1
            pts = [(cx, cy), (cx, by), (lx, by), (lx, py)]
        else:
            pts = [(lx, cy)]

        style = (EDGE_BASE + "strokeColor=%s;fontColor=%s;exitX=%s;exitY=%s;exitDx=0;"
                 "exitDy=0;entryX=%s;entryY=%s;entryDx=0;entryDy=0;"
                 % (color, color, exitp[0], exitp[1], entryp[0], entryp[1]))
        if soft:
            style += ("dashed=1;dashPattern=6 6;strokeWidth=1;startArrow=none;"
                      "endArrow=open;endFill=0;opacity=70;")
        else:
            style += "strokeWidth=1.6;startArrow=ERmany;startFill=0;endArrow=ERone;endFill=0;"
        points = "".join('<mxPoint x="%d" y="%d"/>' % p for p in pts)
        # Подписи сдвигаются вдоль линии по очереди: в пучке (три ссылки
        # elements на zones подряд) все они иначе встают в одну точку.
        shift = (-0.45, 0.0, 0.45, -0.22, 0.22)[state["label_slot"] % 5]
        state["label_slot"] += 1
        return (
            '<mxCell id="%s" value="%s" style="%s" edge="1" parent="1" source="%s" '
            'target="%s"><mxGeometry x="%.2f" relative="1" as="geometry">'
            '<Array as="points">%s</Array></mxGeometry></mxCell>'
            % (eid, esc(label), style, row_ids[(child, cf)], row_ids[(parent, pf)],
               shift, points)
        )

    for n, (child, cf, parent, pf, label) in enumerate(FKS, 1):
        cells.append(edge_xml("e%d" % n, child, cf, parent, pf, label, soft=False))
    for n, (child, cf, parent, pf, label) in enumerate(SOFT, 1):
        cells.append(edge_xml("s%d" % n, child, cf, parent, pf, label, soft=True))

    # -------------------------------------------------- заголовок и легенда
    cells.append(
        '<mxCell id="title" value="%s" style="text;html=1;fontSize=28;fontStyle=1;'
        'align=left;verticalAlign=middle;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="20" width="1600" height="50" as="geometry"/></mxCell>'
        % (esc("ЖБИ-трекер — схема базы данных (SQLite). " + subtitle), X0)
    )

    lx = x + 40
    cells.append(
        '<mxCell id="lg" value="Условные обозначения" style="rounded=0;whiteSpace=wrap;'
        'html=1;verticalAlign=top;fontStyle=1;fontSize=14;align=left;spacingLeft=10;'
        'spacingTop=6;fillColor=#ffffff;strokeColor=#666666;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="%d" width="440" height="%d" as="geometry"/></mxCell>'
        % (lx, Y0, 60 + 34 * len(LEGEND_ITEMS) + 300)
    )
    ly = Y0 + 44
    for i, (text, fill, stroke) in enumerate(LEGEND_ITEMS):
        cells.append(
            '<mxCell id="lgb%d" value="" style="rounded=0;html=1;fillColor=%s;'
            'strokeColor=%s;" vertex="1" parent="1"><mxGeometry x="%d" y="%d" width="26" '
            'height="20" as="geometry"/></mxCell>' % (i, fill, stroke, lx + 14, ly + i * 34)
        )
        cells.append(
            '<mxCell id="lgt%d" value="%s" style="text;html=1;align=left;'
            'verticalAlign=middle;fontSize=12;" vertex="1" parent="1">'
            '<mxGeometry x="%d" y="%d" width="360" height="20" as="geometry"/></mxCell>'
            % (i, esc(text), lx + 50, ly + i * 34)
        )
    cells.append(
        '<mxCell id="lgn" value="%s" style="text;html=1;whiteSpace=wrap;align=left;'
        'verticalAlign=top;fontSize=11;spacingLeft=4;" vertex="1" parent="1">'
        '<mxGeometry x="%d" y="%d" width="400" height="290" as="geometry"/></mxCell>'
        % (esc(
            "<b>PK</b> — первичный ключ, <b>FK</b> — внешний ключ, <b>U</b> — уникальность."
            "<br><br><b>Сплошная</b> линия — внешний ключ, подпись = поведение ON DELETE."
            "<br>«Гусиная лапка» — сторона «многие», одинарная черта — сторона «один»."
            "<br><b>Пунктир</b> — логическая связь по значению, без FK в схеме."
            "<br><br><b>Цвет линии</b> — таблица, НА КОТОРУЮ она ссылается: все ссылки "
            'на <font color="#1a73c8">objects</font> синие, на '
            '<font color="#2f9e44">users</font> зелёные, на '
            '<font color="#b54708">contracts</font> коричневые, на '
            '<font color="#7048e8">zones</font> фиолетовые.'
            "<br>Дуга-«мостик» на пересечении означает, что линии не связаны."
            "<br><br>У каждой связи своя вертикальная дорожка в промежутке между "
            "колонками. Связи через две и более колонки уходят вниз, на «шину» под "
            "схемой, и поднимаются к предку — чтобы не проходить поверх таблиц."
        ), lx + 14, ly + 34 * len(LEGEND_ITEMS) + 10)
    )

    return (
        '<mxfile host="app.diagrams.net" agent="scripts/gen_db_schema_drawio.py" '
        'version="24.0.0">\n'
        '  <diagram id="zhbi-db" name="ЖБИ — схема БД">\n'
        '    <mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" '
        'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        'pageWidth="1169" pageHeight="826" math="0" shadow="0">\n'
        '      <root>\n'
        '        <mxCell id="0"/>\n'
        '        <mxCell id="1" parent="0"/>\n'
        '        ' + '\n        '.join(cells) + '\n'
        '      </root>\n'
        '    </mxGraphModel>\n'
        '  </diagram>\n'
        '</mxfile>\n'
    )


def verify(db_path):
    """Сверить списки в этом файле с реальной схемой БД.

    Возвращает список расхождений (пустой — всё сходится). Сверяются состав
    таблиц, состав полей у каждой из них и внешние ключи: ровно то, что
    ломается после миграции и чего глазами в диаграмме не заметить.
    """
    problems = []
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        db_tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'")}
        mine = set(BY_NAME)
        for t in sorted(db_tables - mine):
            problems.append("таблица есть в БД, но не в схеме: %s" % t)
        for t in sorted(mine - db_tables):
            problems.append("таблица есть в схеме, но не в БД: %s" % t)

        for name in sorted(db_tables & mine):
            db_fields = [r[1] for r in con.execute("PRAGMA table_info(%s)" % name)]
            my_fields = [f[0] for f in BY_NAME[name][4]]
            for c in db_fields:
                if c not in my_fields:
                    problems.append("%s: поле есть в БД, но не в схеме: %s" % (name, c))
            for c in my_fields:
                if c not in db_fields:
                    problems.append("%s: поле есть в схеме, но не в БД: %s" % (name, c))

        db_fks = set()
        for name in db_tables:
            for r in con.execute("PRAGMA foreign_key_list(%s)" % name):
                db_fks.add((name, r[3], r[2], r[4] or "id"))
        my_fks = {(a, b, c, d) for a, b, c, d, _ in FKS}
        for fk in sorted(db_fks - my_fks):
            problems.append("внешний ключ есть в БД, но не в схеме: %s.%s -> %s.%s" % fk)
        for fk in sorted(my_fks - db_fks):
            problems.append("внешний ключ есть в схеме, но не в БД: %s.%s -> %s.%s" % fk)
    finally:
        con.close()
    return problems


def main():
    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__)
        return 0

    def opt(flag, default):
        return args[args.index(flag) + 1] if flag in args else default

    db_path = opt("--db", DEFAULT_DB)
    out_path = opt("--out", DEFAULT_OUT)

    checked = None
    if "--no-check" not in args:
        if not os.path.exists(db_path):
            print("! базы %s нет — сверка пропущена" % db_path)
        else:
            problems = verify(db_path)
            checked = db_path
            if problems:
                print("Схема БД и списки в скрипте разошлись (%d):" % len(problems))
                for p in problems:
                    print("  -", p)
                if "--force" not in args:
                    print("\nДопишите поля вместе с их назначением в TABLES/FKS "
                          "(%s) и запустите снова.\n"
                          "Собрать как есть: --force" % os.path.abspath(__file__))
                    return 1
                print("  (--force: собираю как есть)")
            else:
                print("Сверка с %s: расхождений нет" % db_path)

    subtitle = ("Сверено с %s, %s" % (os.path.basename(checked),
                                      date.today().strftime("%d.%m.%Y"))
                if checked else "Структура на %s" % date.today().strftime("%d.%m.%Y"))
    xml = build_xml(subtitle)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(xml)
    print("Записано: %s (таблиц %d, полей %d, связей %d + %d логических)"
          % (out_path, len(TABLES), sum(len(t[4]) for t in TABLES), len(FKS), len(SOFT)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
