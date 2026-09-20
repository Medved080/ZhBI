// Фейковый бэкенд для браузерного тестового стенда интерфейса V2.
//
// Что это. Чистый ES-модуль (без сборщика и зависимостей), который подменяет
// globalThis.fetch и отвечает так, как отвечает настоящий бэкенд (app/*.py),
// но целиком из ПАМЯТИ: без сервера, без БД, без входа. Настоящие модули V2
// (api.js, users-access.js, projects-objects.js, main.js, login.js) работают
// поверх него без единой правки. Работает и в браузере, и в Node >= 22.
//
// Где взята форма ответов. Не выдумана: списки полей, тексты ошибок, порядок
// проверок (401 → 403 → 422 → логика) и коды статусов перенесены из
// app/auth.py, users.py, roles.py, rights_matrix.py, access.py, features.py,
// models.py, reference_catalogs.py, attachments.py, dict_delete.py, kladr.py,
// project_map.py и обработчиков /projects, /objects в app/main.py. Реестр
// разделов прав (FEATURE_ROWS) выгружен из app/features.py как есть.
//
// Осознанные ОТЛИЧИЯ от настоящего бэкенда (тесты не должны на них опираться):
//   * тексты 401 — «Требуется вход» (по заданию стенда), а не «Не авторизован»;
//   * POST /users с ПУСТОЙ (после trim) фамилией или логином отвечает 422
//     (string_too_short) — настоящий бэкенд такое принимает; клиент V2 такую
//     форму до отправки не пропускает, так что 422 нужен только стенду;
//     отключается опцией strictUserNames: false;
//   * GET /counterparties — заглушка, всегда пустой список (нужна, чтобы
//     раздел «Контрагенты» смонтировался без ошибки); остальное — 404;
//   * delete-plan для объекта/проекта перечисляет ссылки (`checked`) только
//     из реестра fk_handled dict_delete.py, а не по PRAGMA всей схемы.
//
// Паттерны маршрутов (pathPattern) везде одинаковы: строка — ПОДСТРОКА
// «МЕТОД /путь?запрос» (например "POST /users" или "/users/3/access"), либо
// RegExp по той же строке. Строка с префиксом «=» — точное совпадение пути
// без запроса ("=/projects" не заденет "/projects-tree"). Необязательный
// method дополнительно сужает метод.
//
// Порядок обработки запроса: запись в ctl.log (СИНХРОННО при вызове fetch) →
// такт setTimeout(0) → hold (ждём release/fail) → задержка setLatency →
// авторизация/маршрут. failNext и hold сопоставляются в момент ВЫЗОВА fetch,
// поэтому «следующие N запросов» определяются порядком вызовов.

// ------------------------------------ ИНТЕРФЕЙС ------------------------------
//   const ctl = installFakeBackend({overrides, latency, origin, now, external, strictUserNames, maxUploadMb});
//   ctl.uninstall()                       — вернуть оригинальный fetch (удерживаемые запросы падают как сетевой сбой)
//   ctl.reset(overrides?)                 — данные заново из фикстур; сбрасываются журнал, задержки, failNext, hold.
//                                            overrides: users|roles|roleFeatures|access(grants)|projects|objects|smu|
//                                            individuals|attachments — массив ЦЕЛИКОМ или функция rows => rows;
//                                            settings — слияние; me / permissions — как setUser / setPermissions;
//                                            session (bool|{active,userId}); userId. Неизвестный ключ — ошибка.
//   ctl.data                              — изменяемые таблицы (ссылка стабильна; строки правятся на месте):
//                                            users, roles, roleFeatures, access (= grants), projects, objects, smu,
//                                            individuals, attachments, settings, session, mePatch, permissionsPatch;
//                                            data.avatars — ПРОИЗВОДНАЯ {objectId: attachmentId} (только чтение).
//   ctl.log / ctl.clearLog() / ctl.count([method,] pathPattern) / ctl.waitFor([method,] pathPattern, {count,timeout})
//   ctl.setLatency(pathPattern, ms, method?)   ms=0 снимает
//   ctl.hold(pathPattern, method?) → {release(n?), fail(status, detail, {n, network}), pending, entries,
//                                     waitForRequest(count?, timeoutMs?), dispose()}
//   ctl.failNext(pathPattern, {status=500, detail, times=1, network=false, method, rawBody, contentType})
//   ctl.setSession(bool) / ctl.loginAs(userId) / ctl.setUser(patch|null) / ctl.setPermissions(patch|null, {replace})
//   ctl.whenIdle() / ctl.clearRules() / ctl.internalErrors (исключения внутри самого стенда; должно быть пусто)
//
// Профиль прав (setPermissions) сужает РАЗДЕЛЫ и проверки 403 «сервера», но не прячет данные у записи с ролью
// admin; настоящую видимость по грантам даёт loginAs(<id не-админа>).

// -------------------------------- КАРТА ФИКСТУР ------------------------------
// Пользователи (data.users; пароль в открытом виде — поле password, у доменного — domainPassword):
// Пароли синтетические и генерируются при каждом запуске (secret()); в исходниках их нет — читать из data.users[i].password.
//   1 qa.admin      админ сервиса (вход по умолчанию)
//   2 qa.writer     user; Прораб на проекте 1 + Комплектовщик на объекте 4
//   3 qa.reader     view; Наблюдатель на проекте 2
//   4 qa.noaccess   user; ни одного гранта, пароль не задан
//   5 qa.longname   user; длинные ФИО/должность/подразделение; Наблюдатель на объектах 7 и 8
//   6 qa.grants     user; гранты на объекте (14 — Прораб), проекте (3 — Наблюдатель), «все проекты» (Комплектовщик)
//   7 qa.domain     user; доменная учётная запись (пароль сервиса не используется)
//   8 qa.mustchange user; пароль надо сменить при входе (временный пароль)
// Роли объекта (data.roles): view «QA-Наблюдатель», user «QA-Прораб», contract «QA-Комплектовщик»,
//   admin «QA-Администратор объекта» — заводская раскладка из app/features.py (baseline) в data.roleFeatures.
// Проекты 1–14, объекты 1–20 (data.projects / data.objects):
//   проект 1 (объекты 1,2,3): 1 «тяжёлый» — blockers у delete-plan; 3 — 3 вложения, превью, длинное имя файла
//   проект 2 (4,5,6): 6 — единственный тип учёта mfr; 5 — перспективный, blocker «Марки»
//   проект 9 — БЕЗ объектов, удаляется чисто; проект 10 и объект 16 — очень длинные название и адрес
//   проект 14 (объект 20) — оба удаляются чисто (после удаления объекта 20 проект 14 тоже пуст)
//   статусы: 4,13 perspective · 5 suspended · 6 completed · 7 archived (объект 13) · остальные active
//   координаты (для карты/наследования): объекты 1,2,3,4,7,11,14,17; у проектов 1,2,3,6,8,11
// Вложения (data.attachments): 1 png (превью объекта 3), 2 pdf, 3 docx с длинным именем — объект 3;
//   4 png — объект 1; 5 pdf — проект 1.  СМУ 1–5, физлица 1–5 (у СМУ 4 длинное название).

// ======================= реестр разделов прав (app/features.py) ==============

const FEATURE_ROWS = [
  {"key": "plan", "section": "Схема объекта", "title": "Схема, карточка изделия, фильтры, 3D", "note": "Схема только показывает данные — изменение относится к самим изделиям, строки ниже.", "sources": ["POST /plan-data", "GET /elements", "GET /axis-grid"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "status", "section": "Схема объекта", "title": "Статусы изделий: смена по одному и группой", "note": "Сюда же откат статуса и выбор контракта при уходе с «Запланирован».", "sources": ["PATCH /elements/{id}/status", "PATCH /elements/bulk-status", "PATCH /elements/{id}/contract"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "write", "contract": "write", "admin": "write"}},
  {"key": "history", "section": "Схема объекта", "title": "История статусов: правка и удаление записей", "note": null, "sources": ["PATCH /elements/{id}/history/{hid}", "DELETE /elements/{id}/history/{hid}"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "write", "contract": "write", "admin": "write"}},
  {"key": "planned_date", "section": "Схема объекта", "title": "Плановая дата поставки изделия", "note": null, "sources": ["PATCH /elements/{id}/planned-delivery-date", "PATCH /elements/bulk-planned-delivery-date"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "write", "contract": "write", "admin": "write"}},
  {"key": "comment", "section": "Схема объекта", "title": "Комментарий к изделию", "note": null, "sources": ["PATCH /elements/{id}/comment"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "write", "contract": "write", "admin": "write"}},
  {"key": "attachments", "section": "Схема объекта", "title": "Вложения: просмотр и добавление", "note": "Удаление — строка ниже: порог у него был выше, и сводить их в одну строку значило бы отдать чужие акты и письма тому, кому доверена только отметка статуса.", "sources": ["GET/POST /attachments"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "write", "contract": "write", "admin": "write"}},
  {"key": "attachments_delete", "section": "Схема объекта", "title": "Вложения: удаление", "note": null, "sources": ["DELETE /attachments/{id}"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "none", "user": "none", "contract": "none", "admin": "write"}},
  {"key": "element_fields", "section": "Схема объекта", "title": "Реквизиты изделий: правка полей", "note": "Правка того, что пришло из чертежа: марка, отметка, зоны, этаж.", "sources": ["PATCH /elements/{id}/fields"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "element_catalog", "section": "Схема объекта", "title": "Справочник элементов объекта", "note": null, "sources": ["GET /elements (списком)"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "export", "section": "Схема объекта", "title": "Выгрузка схемы в XLSX и PDF", "note": null, "sources": ["POST /export.xlsx", "GET /export.pdf"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "workspace_model", "section": "Рабочие места", "title": "«Модель»: схема, 2D и 3D", "note": "Основное рабочее место. Закрыть его роли, у которой есть доступ к объекту, значит оставить человека без экрана вовсе.", "sources": ["переключатель рабочего места в тулбаре"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "workspace_picker", "section": "Рабочие места", "title": "«АРМ комплектовщика»: дашборд срезов", "note": "Гашение интерфейсное: дашборд считает по тем же данным, что уже пришли на схему, ничего сверх доступного он не показывает.", "sources": ["переключатель рабочего места в тулбаре"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "none", "user": "none", "contract": "read", "admin": "read"}},
  {"key": "workspace_foreman", "section": "Рабочие места", "title": "«АРМ прораба»: фильтры панелью слева", "note": "Та же схема и тот же отбор, что в «Модели», разложенные иначе. Прятать его не от чего, поэтому заводски открыт всем, у кого есть доступ к объекту.", "sources": ["переключатель рабочего места в тулбаре"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "zones", "section": "Зоны и чертёж", "title": "Зоны: захватки, краны, стоянки", "note": "Сюда же пересчёт привязки изделий к зонам и вывод зон из работы.", "sources": ["GET /zones", "PATCH/DELETE /zones/{id}", "POST /zones/{id}/undo"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "zone_colors", "section": "Зоны и чертёж", "title": "Цвета зон", "note": null, "sources": ["GET/PUT /zone-colors"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "drawings", "section": "Зоны и чертёж", "title": "Чертежи: загрузка DXF и переимпорт версии", "note": "Переимпорт переписывает геометрию всего объекта.", "sources": ["GET /objects/{id}/drawings", "POST /import-dxf/analyze и /apply"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "contracts", "section": "Контрактация", "title": "Контракты и их позиции", "note": null, "sources": ["GET /contracts", "POST/PATCH /contracts"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "agreements", "section": "Контрактация", "title": "Договоры и спецификации", "note": null, "sources": ["POST/PATCH /agreements, /specifications"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "counterparties", "section": "Контрактация", "title": "Справочник контрагентов", "note": "Справочник общесервисный: одна и та же организация возит на несколько строек, и проверять его по показываемому объекту не за что.", "sources": ["GET /counterparties/full", "POST/PATCH /counterparties"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "default_contracts", "section": "Контрактация", "title": "Контракт по умолчанию по типу изделия", "note": null, "sources": ["GET/PUT /contracts/default-map"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "doc_supplier_change", "section": "Контрактация", "title": "Документ «Замена поставщика»", "note": "Проведение и его отмена — то же изменение: документ меняет привязки изделий к контрактам, и разделять их значило бы разрешить создать документ, но не применить.", "sources": ["POST/PATCH/DELETE /supplier-changes (kind=supplier_change)", "POST /supplier-changes/{id}/post|unpost"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "doc_link_swap", "section": "Контрактация", "title": "Документ «Обмен привязками»", "note": null, "sources": ["POST/PATCH/DELETE /supplier-changes (kind=link_swap)", "POST /supplier-changes/{id}/post|unpost"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "schedule", "section": "Контрактация", "title": "График СМР: версии, исходные данные, расчёт, визуализация", "note": "Загрузка файла графика — отдельный раздел «Импорт графика MS Project».", "sources": ["GET /schedule-versions", "GET /schedule-versions/gantt", "GET /schedule-versions/gantt.xlsx|.pdf", "DELETE /schedule-versions/{id}", "GET/PUT /schedule-calc/inputs", "POST /schedule-calc"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "write", "admin": "write"}},
  {"key": "report_status", "section": "Отчёты", "title": "Статус монтажа", "note": null, "sources": ["POST /reports/status(.xlsx|.pdf)"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_dynamics", "section": "Отчёты", "title": "Динамика поставки и монтажа", "note": null, "sources": ["POST /reports/dynamics(.xlsx|.pdf)"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_delivery", "section": "Отчёты", "title": "График поставки", "note": null, "sources": ["POST /reports/delivery-schedule"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_completion", "section": "Отчёты", "title": "Статус комплектации", "note": null, "sources": ["POST /reports/completion(.xlsx|.pdf)"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_mywork", "section": "Отчёты", "title": "Моя работа", "note": null, "sources": ["POST /reports/my-work"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_contracting", "section": "Отчёты", "title": "График контрактации и поставки", "note": null, "sources": ["POST /reports/contracting-schedule"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_analytics", "section": "Отчёты", "title": "Аналитическая справка", "note": null, "sources": ["POST /reports/analytics(.xlsx|.pdf)"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "map", "section": "Отчёты", "title": "Карта проектов", "note": "Показывает объекты с координатами на карте: где стройка, сколько элементов, сколько смонтировано. Подложка карты и координаты не покидают контур — файл карты лежит на сервере.", "sources": ["GET /map/objects", "GET /map/config"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_notes", "section": "Отчёты", "title": "Примечания к отчётам: события, задачи, вопросы", "note": null, "sources": ["GET /report-notes", "PUT/DELETE /report-notes"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "activity", "section": "Отчёты", "title": "Журнал действий по объекту: свои действия", "note": "Чистка журнала сервиса — другая строка, в «Ведении сервиса».", "sources": ["GET /elements/{id}/activity", "GET /objects/{id}/activity-users"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "activity_others", "section": "Отчёты", "title": "Журнал и «Моя работа»: действия ДРУГИХ людей", "note": "Отдельно от строки выше: работать на объекте и наблюдать за коллегами — разные права. До 2026-08-14 второе было привязано к «Полным правам на объекте».", "sources": ["GET /objects/{id}/activity-users (выбор пользователя)", "POST /elements/changed", "POST /reports/my-work (чужие)"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "none", "user": "none", "contract": "none", "admin": "read"}},
  {"key": "dict_marks", "section": "Справочники", "title": "Марки", "note": "Читать справочник мог каждый, у кого есть доступ к объекту; заводить и переименовывать марки — только администратор сервиса.", "sources": ["GET /marks", "POST/PATCH /marks"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_subtypes", "section": "Справочники", "title": "Типы и подтипы элементов", "note": null, "sources": ["POST/DELETE /allowed-subtypes"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_mark_prefixes", "section": "Справочники", "title": "Префиксы марок", "note": null, "sources": ["POST/DELETE /mark-type-prefixes"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_status_colors", "section": "Справочники", "title": "Цвета статусов", "note": null, "sources": ["PUT /status-colors"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_element_shapes", "section": "Справочники", "title": "Форма маркеров", "note": null, "sources": ["GET /layer-type-combinations", "PUT /element-shapes"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_smu", "section": "Справочники", "title": "СМУ", "note": "Читать справочник может каждый (заполняет реквизиты объекта из выпадашки); заводить и переименовывать записи — только администратор сервиса.", "sources": ["GET /smu", "POST/PATCH /smu"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "dict_individuals", "section": "Справочники", "title": "Физлица", "note": "Один справочник на обе роли объекта — «Директор СМУ» и «Ответственный (ДП/РП)».", "sources": ["GET /individuals", "POST/PATCH /individuals"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "address_load", "section": "Справочники", "title": "Загрузка адресного классификатора КЛАДР", "note": "Разовая операция обслуживания: пишет на диск сервера сотни мегабайт и занимает минуты. Подсказки по адресу видны всем вошедшим и от этого раздела не зависят.", "sources": ["GET /address/regions-in-file", "POST /address/load, /address/unpack"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "dict_delete", "section": "Справочники", "title": "Удаление записей справочников с заменой ссылок", "note": "Действие необратимое и сквозное: удаление контрагента уносит его договоры, спецификации и контракты, а изделия и история переезжают на выбранную замену.", "sources": ["GET /dictionaries/{вид}/{ключ}/delete-plan", "POST /dictionaries/{вид}/{ключ}/delete"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "label_visibility", "section": "Настройки объекта", "title": "Видимость подписей марок и дат по типам", "note": null, "sources": ["GET/PUT /label-visibility", "GET/PUT /label-dates-visibility"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "info_plate", "section": "Настройки объекта", "title": "Порог опоздания поставки", "note": null, "sources": ["GET/PUT /info-plate-settings"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "project_card", "section": "Настройки объекта", "title": "Карточка проекта и объекта", "note": null, "sources": ["GET/PUT /project-card"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "projects", "section": "Настройки объекта", "title": "Справочники «Проекты» и «Объекты»", "note": "Видно те проекты и объекты, к которым есть доступ; заводить и править их до 2026-08-14 мог только администратор сервиса.", "sources": ["GET /projects-tree", "POST/PATCH/DELETE /projects, /objects"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "import_history", "section": "Загрузка данных файлом", "title": "Импорт истории статусов", "note": null, "sources": ["POST /import-history-xlsx"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "external_models", "section": "Загрузка данных файлом", "title": "Внешние 3D-модели (благоустройство и т.п.)", "note": "Модель принадлежит ОБЪЕКТУ (проект — только группировка объектов, своих данных не имеет). Видна в 3D ЖБИ и «Модели МФР» этого объекта.", "sources": ["GET /objects/{id}/external-models", "POST /objects/{id}/external-models", "PATCH/DELETE /objects/{id}/external-models/{model_id}"], "scope": "object", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "bulk_edit", "section": "Загрузка данных файлом", "title": "Массовая правка через Excel", "note": "«Чтение» — только выгрузка снимка в Excel; загрузка правленого файла и применение правок требуют «Изменения». Отбор строк по доступным объектам ещё не сделан (хвост этапа C): выдав раздел роли — даже на «Чтение», — вы откроете ей и чужие объекты.", "sources": ["POST /elements/bulk-edit/export (read)", "POST /elements/bulk-edit/analyze|apply (write)"], "scope": "service", "io": "both", "kinds": ["zhbi"], "baseline": {}},
  {"key": "import_contracting", "section": "Загрузка данных файлом", "title": "Импорт файла контрактации", "note": "Объект выбирается в форме и обязателен: договор заключается на объект.", "sources": ["POST /import-contracting-xlsx"], "scope": "object", "io": null, "kinds": ["zhbi"], "baseline": {}},
  {"key": "import_objects", "section": "Загрузка данных файлом", "title": "Загрузка справочника объектов из Excel", "note": "Создаёт и правит проекты и объекты пачкой — тот же уровень риска, что и полный доступ к справочнику «Проекты и объекты», поэтому не выдан заводски никому.", "sources": ["POST /objects-import/analyze|apply"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "import_schedule", "section": "Загрузка данных файлом", "title": "Импорт графика MS Project", "note": "Объект и вид графика (базовый или актуализированный) выбираются в форме.", "sources": ["POST /import-schedule-xlsx"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {}},
  {"key": "import_input", "section": "Загрузка данных файлом", "title": "Загрузка чертежей из папки Input", "note": "Читает папку НА СЕРВЕРЕ, объект определяется содержимым файла.", "sources": ["GET /admin/input-files", "POST /admin/import-input"], "scope": "service", "io": null, "kinds": ["zhbi"], "baseline": {}},
  {"key": "settings_io", "section": "Загрузка данных файлом", "title": "Экспорт и импорт настроек", "note": null, "sources": ["GET /settings/export", "POST /settings/import"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "users", "section": "Ведение сервиса", "title": "Пользователи и выдача доступов", "note": "Тот, кто правит доступы, может выдать их себе. Снять роль администратора сервиса с самого себя нельзя ни этой строкой, ни какой-либо другой.", "sources": ["GET/POST/PATCH /users*", "PUT /users/{id}/access"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "roles", "section": "Ведение сервиса", "title": "Настройка ролей и разрешений", "note": "Правка этой самой матрицы. Выдав раздел роли, вы отдаёте ей определение всех остальных прав на стройке.", "sources": ["GET /roles", "POST/PATCH/DELETE /roles", "PUT /roles/features"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "sessions", "section": "Ведение сервиса", "title": "Сеансы пользователей", "note": null, "sources": ["GET /users/sessions", "DELETE /users/sessions/{id}"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "ldap", "section": "Ведение сервиса", "title": "Доменная авторизация", "note": null, "sources": ["GET/PUT /ldap-settings", "POST /ldap-search"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "backups", "section": "Ведение сервиса", "title": "Резервные копии", "note": null, "sources": ["GET/POST /admin/backups*"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "db_status", "section": "Ведение сервиса", "title": "Состояние БД", "note": null, "sources": ["GET /admin/db-status*"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "db_transfer", "section": "Ведение сервиса", "title": "Перенос базы целиком между серверами", "note": "Полная ЗАМЕНА снимком, а не дополнение.", "sources": ["POST /admin/db-transfer/*"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "activity_log", "section": "Ведение сервиса", "title": "Журнал действий сервиса и его очистка", "note": null, "sources": ["GET /activity", "POST /activity/cleanup"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "admin_guide", "section": "Ведение сервиса", "title": "Памятка администратора", "note": null, "sources": ["GET /admin-guide", "GET /admin-guide.md"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "reset_history", "section": "Ведение сервиса", "title": "Очистка истории статусов", "note": "Необратимо и по всей базе.", "sources": ["POST /admin/reset-status-history"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "release_tasks", "section": "Ведение сервиса", "title": "Обработки данных при обновлении", "note": "Повторный запуск обработки кнопкой в «Что нового».", "sources": ["POST /release-tasks/{name}/run"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "fill_scope", "section": "Ведение сервиса", "title": "Заполнить пустые «Объект» и «Проект» (временная)", "note": "Лечит дообъектное наследие; удалить вместе с наследием.", "sources": ["GET/POST /admin/fill-empty-scope"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "training", "section": "Обучение", "title": "Инструкция и тест по своим разделам", "note": "Показывается ровно то, что доступно ролям человека: раздел, закрытый ему в матрице, в инструкцию не попадает, а абзацы про изменение видит только тот, у кого «Изменение».", "sources": ["GET /training/guide", "POST /training/attempts", "POST /training/attempts/{id}/answer"], "scope": "service", "io": null, "kinds": [], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "training_admin", "section": "Обучение", "title": "История прохождения тестов ДРУГИМИ людьми", "note": "Отдельно от строки выше по тому же доводу, что у «действий других людей»: учиться и наблюдать за коллегами — разные права. Свою историю видит каждый.", "sources": ["GET /training/attempts?user_id=…", "GET /training/ratings"], "scope": "service", "io": null, "kinds": [], "baseline": {}},
  {"key": "own_settings", "section": "Личные настройки", "title": "Гамма, ракурс 3D, порог показа подписей, свой пароль", "note": "Своё меняет каждый сам, независимо от ролей; чужое — тот, кому выдан раздел «Пользователи».", "sources": ["PATCH /users/{id}/ui-theme, /view3d, /min-label-px, /set-password"], "scope": "self", "io": null, "kinds": [], "baseline": {}},
  {"key": "revit_import", "section": "Модель Revit", "title": "Загрузка выгрузок из Revit: пакеты разделов", "note": "Грузится не модель, а компактный пакет, который делает скрипт внутри Revit. «Чтение» разрешает посмотреть сводку, «Изменение» — применить её.", "sources": ["POST /import-revit/analyze", "POST /import-revit/apply"], "scope": "object", "io": "import", "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "workspace_mfr", "section": "Рабочие места", "title": "«Модель МФР»: план по этажам", "note": "Рабочее место объектов МФР. У них нет схемы по чертежу DXF, и без этого места человек попадал бы на пустой экран.", "sources": ["переключатель рабочего места в тулбаре"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "revit_model", "section": "Модель Revit", "title": "План модели: этажи, секции, категории, карточка элемента", "note": "Только показ: у элементов модели нет статусов, это другой контур учёта.", "sources": ["GET /revit-plan/filters", "GET /revit-plan/elements", "GET /revit-plan/element", "GET/PUT /revit-plan/colors"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "pdf_import", "section": "Модель Revit", "title": "Загрузка помещений из PDF", "note": "Второй, помимо Revit, источник геометрии для «Модели МФР»: контуры и площади помещений из архитектурного чертежа PDF, своим разделом (не задваивает и не трогает данные из Revit, если они появятся позже на этом же объекте).", "sources": ["POST /import-pdf/analyze", "POST /import-pdf/apply"], "scope": "object", "io": "import", "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "blocks", "section": "Учёт по блокам", "title": "Секции, этажи и блоки объекта", "note": "Второй контур учёта, независимый от модели Revit и от сборного ЖБИ: секции и этажи заводятся здесь вручную (или приезжают из Revit-выгрузки, если она появится позже — справочники общие), блок — отмеченная пара секция+этаж.", "sources": ["GET/POST/PATCH/DELETE /objects/{id}/sections", "GET/POST/PATCH/DELETE /objects/{id}/levels", "GET/POST/DELETE /objects/{id}/blocks"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "work_progress", "section": "Учёт по блокам", "title": "Виды работ и статус по блокам", "note": "Справочник видов работ грузится перезагружаемым xlsx (путь по дереву — ключ записи). Для операций «сек»/«компл» статус по-прежнему ставит человек кликом («Выполнено» — приёмка, не арифметика по изделиям). Для «эт/сек»/«кв.эт/сек» план блока — явные Запланированные работы (ЗР, «Настройки»): у каждой директивный и актуализированный (версиями) срок, процент — документами «Факт» на дату. Снятие ЗР с фактом/сроками — мягкая пометка, не удаление.", "sources": ["PUT /objects/{id}/blocks/{id}/work-types-settings", "GET/PATCH /objects/{id}/block-works(/{id})", "PUT /objects/{id}/block-works/bulk", "GET/POST/PUT/DELETE /objects/{id}/blocks/{id}/fact-reports", "GET /objects/{id}/blocks/{id}/progress"], "scope": "object", "io": "import", "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "write"}},
  {"key": "report_block_schedule", "section": "Отчёты", "title": "График работ по блокам", "note": "ЗР с планом, прогнозом, процентом, отклонением и признаком сроков; группировка строк — Трек / Раздел WBS / Операция / Секция / Этаж, порядок выбирается на экране. Выгрузка XLSX/PDF, включая вид «Гант».", "sources": ["POST /reports/block-schedule(.xlsx|.pdf)"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_block_status", "section": "Отчёты", "title": "Учёт по блокам: статусы", "note": "Матрица видов работ × блоков/секций/объекта на выбранную дату — для «эт/сек»/«кв.эт/сек» показ переключается процент/план/прогноз/отклонение, правка ячейки доступна только в режиме «процент». До 2026-09-10 был закрыт разделом «Учёт по блокам» без своей строки в матрице прав.", "sources": ["POST /reports/block-status"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
  {"key": "report_linear_track", "section": "Отчёты", "title": "Линейный трек", "note": "Полный список позиций справочника видов работ (WBS) объекта — без привязки к блоку/секции и (пока) без прогресса: дополняет «График работ по блокам», который строится только из ЗР (эт/сек/кв.эт/сек) и не показывает остальные единицы измерения. Выгрузка XLSX.", "sources": ["POST /reports/linear-track(.xlsx)"], "scope": "object", "io": null, "kinds": ["mfr"], "baseline": {"view": "read", "user": "read", "contract": "read", "admin": "read"}},
];

const FEATURES = FEATURE_ROWS;
const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));
const SECTIONS = [...new Set(FEATURES.map((f) => f.section))];

const LEVELS = ["none", "read", "write"];
const LEVEL_LABELS = { none: "Нет", read: "Чтение", write: "Изменение" };
const SCOPE_LABELS = { object: "На объекте", service: "Хотя бы на одном объекте", self: "Своё" };
const IO_HINTS = {
  export: "Выгрузка файла — «Чтение».",
  import: "Загрузка файла — «Изменение».",
  both: "«Чтение» разрешает ВЫГРУЗКУ файла, «Изменение» — ещё и ЗАГРУЗКУ его обратно.",
};
const KIND_LABELS = { zhbi: "ЖБИ", mfr: "МФР" };
const KINDS = ["zhbi", "mfr"];
const CATALOG_STATUSES = ["perspective", "active", "suspended", "completed", "archived"];
const CATALOG_STATUS_LABELS = {
  perspective: "Перспективный", active: "В работе", suspended: "Приостановлен",
  completed: "Завершён", archived: "Архивный",
};
const AVATAR_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ADDRESS_COLS = ["address", "address_code", "address_source", "address_region",
  "address_parts", "postal_code", "address_note", "lat", "lon"];
const DEFAULT_ORIGIN = "http://fake.local";
const MIN_PASSWORD_LENGTH = 8;

const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 410: "Gone",
  413: "Payload Too Large", 422: "Unprocessable Entity", 500: "Internal Server Error",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

// ============================== мелкие утилиты ===============================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const jsonClone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deepClone = (x) => (typeof structuredClone === "function" ? structuredClone(x) : jsonClone(x));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// SQLite COLLATE NOCASE складывает регистр ТОЛЬКО у ASCII: кириллица остаётся
// как есть — повторяем именно это, а не toLowerCase() целиком.
const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
const cmpNoCase = (a, b) => cmp(asciiLower(a), asciiLower(b));
// NULL в SQLite при ORDER BY по возрастанию идёт первым.
const cmpNullFirst = (a, b) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : cmp(a, b));
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const textBytes = (s) => new TextEncoder().encode(s);

// PNG 1x1 — настоящая картинка для вложений-изображений и превью объекта.
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class HttpError extends Error {
  constructor(status, detail, extra = {}) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
    this.extra = extra; // {rawBody, contentType} — ответ не-JSON (HTML прокси и т.п.)
  }
}
const fail = (status, detail) => { throw new HttpError(status, detail); };
const validation = (errors) => new HttpError(422, errors);
const created = (body) => ({ __status: 201, body });

function nowStr(nowFn) {
  const d = nowFn ? new Date(nowFn()) : new Date();
  return d.toISOString().slice(0, 19).replace("T", " "); // как datetime('now') в SQLite
}

// ---------------------------- мини-pydantic (v2) -----------------------------
// Достаточно, чтобы 422 выглядели как у FastAPI: {type, loc, msg, input}.

function coerce(type, v) {
  switch (type) {
    case "str":
      return typeof v === "string" ? { v } : { e: ["string_type", "Input should be a valid string"] };
    case "int":
      if (typeof v === "number") {
        return Number.isInteger(v) ? { v }
          : { e: ["int_from_float", "Input should be a valid integer, got a number with a fractional part"] };
      }
      if (typeof v === "string") {
        return /^[+-]?\d+$/.test(v.trim()) ? { v: Number(v.trim()) }
          : { e: ["int_parsing", "Input should be a valid integer, unable to parse string as an integer"] };
      }
      return { e: ["int_type", "Input should be a valid integer"] };
    case "float":
      if (typeof v === "number") return Number.isFinite(v) ? { v } : { e: ["finite_number", "Input should be a finite number"] };
      if (typeof v === "string") {
        const t = v.trim();
        return t !== "" && Number.isFinite(Number(t)) ? { v: Number(t) }
          : { e: ["float_parsing", "Input should be a valid number, unable to parse string as a number"] };
      }
      return { e: ["float_type", "Input should be a valid number"] };
    case "bool":
      if (typeof v === "boolean") return { v };
      if (v === 0 || v === 1) return { v: v === 1 };
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (["true", "t", "yes", "y", "on", "1"].includes(t)) return { v: true };
        if (["false", "f", "no", "n", "off", "0"].includes(t)) return { v: false };
        return { e: ["bool_parsing", "Input should be a valid boolean, unable to interpret input"] };
      }
      return { e: ["bool_type", "Input should be a valid boolean"] };
    case "dict":
      // Копия: строка таблицы не должна делить объект с записью в ctl.log.
      return isObj(v) ? { v: jsonClone(v) } : { e: ["dict_type", "Input should be a valid dictionary"] };
    case "dictstr": {
      if (!isObj(v)) return { e: ["dict_type", "Input should be a valid dictionary"] };
      for (const val of Object.values(v)) if (typeof val !== "string") return { e: ["string_type", "Input should be a valid string"] };
      return { v };
    }
    default:
      return { v };
  }
}

// spec: {поле: {type, required?, nullable?, default?, items?(спека элемента), of?(тип элемента)}}.
// Возвращает {values, given}: given — какие поля реально пришли (model_fields_set).
function parseModel(body, spec, loc = ["body"]) {
  if (body === undefined || body === null) {
    throw validation([{ type: "missing", loc, msg: "Field required", input: null }]);
  }
  if (!isObj(body)) {
    throw validation([{ type: "model_attributes_type", loc,
      msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  const errors = [], values = {}, given = new Set();
  for (const [name, f] of Object.entries(spec)) {
    const here = [...loc, name];
    if (!hasOwn(body, name)) {
      if (f.required) errors.push({ type: "missing", loc: here, msg: "Field required", input: body });
      else values[name] = hasOwn(f, "default") ? deepClone(f.default) : null;
      continue;
    }
    given.add(name);
    const raw = body[name];
    if (raw === null && f.nullable) { values[name] = null; continue; }
    if (f.type === "list") {
      if (!Array.isArray(raw)) { errors.push({ type: "list_type", loc: here, msg: "Input should be a valid list", input: raw }); continue; }
      const out = [];
      raw.forEach((item, i) => {
        if (f.items) {
          try { out.push(parseModel(item, f.items, [...here, i]).values); }
          catch (e) { if (e instanceof HttpError && Array.isArray(e.detail)) errors.push(...e.detail); else throw e; }
        } else if (f.of) {
          const r = coerce(f.of, item);
          if (r.e) errors.push({ type: r.e[0], loc: [...here, i], msg: r.e[1], input: item }); else out.push(r.v);
        } else out.push(item);
      });
      values[name] = out;
      continue;
    }
    const r = coerce(f.type, raw);
    if (r.e) errors.push({ type: r.e[0], loc: here, msg: r.e[1], input: raw });
    else values[name] = r.v;
  }
  if (errors.length) throw validation(errors);
  return { values, given };
}

const S = (o = {}) => ({ type: "str", ...o });
const ADDRESS_SPEC = {
  address: S({ nullable: true }), address_code: S({ nullable: true }), address_source: S({ nullable: true }),
  address_region: S({ nullable: true }), address_parts: { type: "dict", nullable: true },
  postal_code: S({ nullable: true }), address_note: S({ nullable: true }),
  lat: { type: "float", nullable: true }, lon: { type: "float", nullable: true },
};
const USER_CREATE_SPEC = {
  last_name: S({ required: true }), first_name: S({ default: "" }), patronymic: S({ nullable: true }),
  position: S({ nullable: true }), department: S({ nullable: true }),
  domain_login: S({ required: true }), role: S({ required: true }),
  auth_method: S({ default: "local" }), must_change_password: { type: "bool", default: true },
};
const USER_UPDATE_SPEC = { ...USER_CREATE_SPEC, must_change_password: { type: "bool", default: false } };
const SET_PASSWORD_SPEC = { password: S({ default: "" }), must_change_password: { type: "bool", default: true } };
const GRANTS_SPEC = {
  grants: { type: "list", default: [], items: {
    project_id: { type: "int", nullable: true }, object_id: { type: "int", nullable: true }, role: S({ required: true }),
  } },
};
const ROLE_SPEC = { name: S({ required: true }) };
const ROLE_ORDER_SPEC = { keys: { type: "list", required: true, of: "str" } };
const CELLS_SPEC = {
  items: { type: "list", required: true, items: {
    role_key: S({ required: true }), feature_key: S({ required: true }), level: S({ required: true }),
  } },
};
const PROJECT_IN_SPEC = { ...ADDRESS_SPEC, name: S({ required: true }), status: S({ nullable: true }), description: S({ nullable: true }) };
const PROJECT_PATCH_SPEC = { ...ADDRESS_SPEC, name: S({ nullable: true }), status: S({ nullable: true }), description: S({ nullable: true }) };
const OBJECT_REFS = {
  smu_id: { type: "int", nullable: true }, smu_director_id: { type: "int", nullable: true },
  responsible_id: { type: "int", nullable: true }, media_url: S({ nullable: true }), smr_start_reported: S({ nullable: true }),
};
const OBJECT_CREATE_SPEC = {
  ...ADDRESS_SPEC, name: S({ required: true }), project_id: { type: "int", required: true },
  status: S({ nullable: true }), description: S({ nullable: true }), kind: S({ nullable: true }), ...OBJECT_REFS,
};
const OBJECT_PATCH_SPEC = {
  ...ADDRESS_SPEC, name: S({ nullable: true }), status: S({ nullable: true }),
  project_id: { type: "int", nullable: true }, description: S({ nullable: true }), kind: S({ nullable: true }), ...OBJECT_REFS,
};
const AVATAR_SPEC = { attachment_id: { type: "int", nullable: true } };
const DELETE_SPEC = { replacements: { type: "dictstr", default: {} }, mode: S({ default: "replace" }) };
const CATALOG_ENTRY_SPEC = { name: S({ required: true }) };
// Синтетический пароль фикстуры: случайный на каждый запуск, в коде не хранится.
function secret() { return "s-" + Math.random().toString(36).slice(2, 12); }

const LOGIN_SPEC = { domain_login: S({ required: true }), password: S({ default: "" }) };
const CHANGE_OWN_SPEC = { current_password: S({ required: true }), new_password: S({ required: true }) };

// ================================ фикстуры ===================================
// Все данные синтетические, узнаются по префиксу «QA-». Каждый вызов строит
// НОВЫЕ объекты — таблицы стенда никогда не разделяют состояние между reset().

function buildFixtures() {
  const ts = (d, t = "09:00:00") => `2026-09-${d} ${t}`;

  const U = (id, o) => ({
    id, last_name: "", first_name: "", patronymic: null, position: null, department: null,
    domain_login: "", role: "user", auth_method: "local", password: null, must_change_password: false,
    label_color: null, ui_theme: null, menu_prefs: null, changelog_unseen: false,
    view3d_pitch_deg: 30.0, view3d_yaw_deg: -30.0, min_label_px: 12.0, ...o,
  });
  const users = [
    // 1 — администратор сервиса: вход по умолчанию, права «в обход» всего.
    U(1, { last_name: "QA-Админов", first_name: "Анатолий", patronymic: "Сергеевич", position: "Администратор сервиса",
      department: "Отдел информационных систем", domain_login: "qa.admin", role: "admin", password: secret() }),
    // 2 — обычный пользователь с записью: Прораб на проекте 1, Комплектовщик на объекте 4.
    U(2, { last_name: "QA-Записев", first_name: "Борис", patronymic: "Игоревич", position: "Прораб",
      department: "Строительное управление №1", domain_login: "qa.writer", role: "user", password: secret() }),
    // 3 — только чтение: Наблюдатель на проекте 2.
    U(3, { last_name: "QA-Читалкин", first_name: "Виктор", patronymic: "Павлович", position: "Инженер ПТО",
      department: "Производственно-технический отдел", domain_login: "qa.reader", role: "view", password: secret() }),
    // 4 — без доступа: ни одного гранта, пароль не задан.
    U(4, { last_name: "QA-Бездоступов", first_name: "Глеб", position: "Стажёр",
      domain_login: "qa.noaccess", role: "user", password: null }),
    // 5 — длинные ФИО, должность и подразделение (~80 символов).
    U(5, { last_name: "QA-Длинноименов-Перегрудин", first_name: "Александр-Максимилиан", patronymic: "Константинович-Оглы",
      position: "Заместитель главного инженера по организации строительства и техническому надзору",
      department: "Управление организации строительного производства, технического надзора и охраны труда",
      domain_login: "qa.longname", role: "user", password: secret() }),
    // 6 — гранты на трёх уровнях: объект 14, проект 3, «все проекты».
    U(6, { last_name: "QA-Грантов", first_name: "Дмитрий", patronymic: "Олегович", position: "Начальник участка",
      department: "Участок №3", domain_login: "qa.grants", role: "user", password: secret() }),
    // 7 — доменная учётная запись (пароль сервиса не используется).
    U(7, { last_name: "QA-Доменов", first_name: "Егор", patronymic: "Львович", position: "Инженер",
      department: "ИТ", domain_login: "qa.domain", role: "user", auth_method: "domain", password: null,
      domainPassword: secret() }),
    // 8 — пароль задан администратором и должен быть заменён при первом входе.
    U(8, { last_name: "QA-Смена", first_name: "Жанна", patronymic: "Романовна", position: "Диспетчер",
      department: "Диспетчерская", domain_login: "qa.mustchange", role: "user", password: secret(), must_change_password: true }),
  ];

  const roles = [
    { id: 1, key: "view", name: "QA-Наблюдатель", rank: 10 },
    { id: 2, key: "user", name: "QA-Прораб", rank: 20 },
    { id: 3, key: "contract", name: "QA-Комплектовщик", rank: 30 },
    { id: 4, key: "admin", name: "QA-Администратор объекта", rank: 40 },
  ];
  // Заводская раскладка (baseline из app/features.py) — четыре роли с разными
  // наборами разрешений; уровень «Нет» строкой не хранится (как в БД).
  const roleFeatures = [];
  for (const f of FEATURES) {
    for (const r of roles) {
      const level = f.baseline[r.key];
      if (level && level !== "none") roleFeatures.push({ role_key: r.key, feature_key: f.key, level });
    }
  }

  const A = (id, user_id, project_id, object_id, role) => ({ id, user_id, project_id, object_id, role });
  const access = [
    A(1, 2, 1, null, "user"), A(2, 2, 2, 4, "contract"),
    A(3, 3, 2, null, "view"),
    A(4, 5, 3, 7, "view"), A(5, 5, 3, 8, "view"),
    A(6, 6, 8, 14, "user"), A(7, 6, 3, null, "view"), A(8, 6, null, null, "contract"),
    A(9, 7, 5, null, "view"),
    A(10, 8, 4, null, "user"),
  ];

  const longProjectName = "QA-Проект с очень длинным наименованием: комплексное освоение территории микрорайона "
    + "у реки Тестовой, первая, вторая и третья очереди строительства с объектами социальной инфраструктуры";
  const longAddress = "Российская Федерация, Тестовая область, городской округ Тестоградский, посёлок городского типа "
    + "Нижние Тестовицы, микрорайон «Заречный-2», улица Имени Героев-Строителей Тестового Края, участок 14/3, "
    + "корпус 2, строение 5, вблизи очистных сооружений, ориентир — бывший элеватор";

  const P = (id, name, o = {}) => ({
    id, name, status: "active", description: null,
    address: null, address_code: null, address_source: null, address_region: null, address_parts: null,
    postal_code: null, address_note: null, lat: null, lon: null, ...o,
  });
  const projects = [
    P(1, "QA-Проект 01 «Северный квартал»", { description: "Основной синтетический проект: три объекта, вложения, гранты.",
      address: "г Тестоград, ул QA-Ленина, д 10", address_region: "Тестовая область", postal_code: "101000", lat: 55.7512, lon: 37.6184 }),
    P(2, "QA-Проект 02 «Речной берег»", { address: "г Тестоград, наб QA-Речная, д 3", address_region: "Тестовая область", lat: 55.7601, lon: 37.6302 }),
    P(3, "QA-Проект 03 «Промзона Юг»", { address: "г Тестоград, проезд QA-Заводской, д 7", lat: 55.6803, lon: 37.5902 }),
    P(4, "QA-Проект 04 «Школа»", { status: "perspective" }),
    P(5, "QA-Проект 05 «Детсад»", { status: "suspended", address: "г QA-Малоград, ул QA-Садовая, д 2" }),
    P(6, "QA-Проект 06 «Больница»", { status: "completed", lat: 55.7901, lon: 37.5502 }),
    P(7, "QA-Проект 07 «Архив»", { status: "archived" }),
    P(8, "QA-Проект 08 «Логистический парк»", { address: "г Тестоград, шоссе QA-Южное, д 15", lat: 55.6201, lon: 37.7002 }),
    // 9 — БЕЗ объектов и без зависимостей: удаляется чисто.
    P(9, "QA-Проект 09 без объектов", { description: "Пустой проект: удаление без блокеров." }),
    // 10 — очень длинные название и адрес.
    P(10, longProjectName, { address: longAddress, address_note: "Въезд со стороны технической дороги, шлагбаум №2" }),
    P(11, "QA-Проект 11 «Депо»", { lat: 55.7101, lon: 37.6802 }),
    P(12, "QA-Проект 12 «Мост»"),
    P(13, "QA-Проект 13 «Парк»", { status: "perspective" }),
    P(14, "QA-Проект 14 «Пустая площадка»"),
  ];

  const O = (id, project_id, name, o = {}) => ({
    id, project_id, name, kind: "zhbi", status: "active", description: null,
    address: null, address_code: null, address_source: null, address_region: null, address_parts: null,
    postal_code: null, address_note: null, lat: null, lon: null,
    smu_id: null, smu_director_id: null, responsible_id: null, media_url: null, smr_start_reported: null,
    avatar_attachment_id: null, elements_current: 0, elements_retired: 0, revit_elements: 0, mounted: 0,
    // drawings: [{source_file, is_current, imported_at}] — «Версии чертежа» в delete-plan.
    drawings: [],
    // deps — то, что держит удаление (см. _object_blockers): зоны, договоры, марки.
    deps: { zones: 0, agreements: 0, marks: 0 },
    // cascade — что уходит вместе с объектом (см. _object_cascade).
    cascade: { app_settings: 0, label_visibility: 0, zone_colors: 0, report_notes: 0, default_contracts: 0 },
    smr_start: null, smr_end: null, ...o,
  });
  const dwg = (name, cur = true, at = "2026-08-30 10:00:00") => ({ source_file: name, is_current: cur, imported_at: at });
  const objects = [
    // 1 — «тяжёлый»: изделия, зоны, договоры, чертежи, марки → delete-plan с blockers.
    O(1, 1, "QA-Корпус 1.1", { description: "Синтетический объект: есть изделия, зоны и договоры.",
      address: "г Тестоград, ул QA-Ленина, д 10, корпус 1", address_region: "Тестовая область", postal_code: "101000",
      lat: 55.7512, lon: 37.6184, smu_id: 1, smu_director_id: 1, responsible_id: 2, elements_current: 1240, elements_retired: 12,
      mounted: 612, drawings: [dwg("QA-корпус-1-1_v3.dxf"), dwg("QA-корпус-1-1_v2.dxf", false, "2026-08-10 09:00:00")],
      deps: { zones: 8, agreements: 2, marks: 15 }, cascade: { app_settings: 1, label_visibility: 0, zone_colors: 0, report_notes: 3, default_contracts: 0 },
      media_url: "https://example.invalid/qa-media-1", smr_start_reported: "2026-02-15", smr_start: "2026-03-01", smr_end: "2027-06-30" }),
    O(2, 1, "QA-Корпус 1.2", { address: "г Тестоград, ул QA-Ленина, д 10, корпус 2", lat: 55.7520, lon: 37.6200,
      smu_id: 1, responsible_id: 3, elements_current: 860, mounted: 130, drawings: [dwg("QA-корпус-1-2_v1.dxf")],
      deps: { zones: 4, agreements: 0, marks: 6 }, smr_start: "2026-05-01", smr_end: "2027-09-30" }),
    // 3 — вложения (в т.ч. изображение) и назначенное превью.
    O(3, 1, "QA-Корпус 1.3 (вложения и превью)", { description: "Объект с вложениями и превью (вложение №1).",
      address: "г Тестоград, ул QA-Ленина, д 10, корпус 3", lat: 55.7530, lon: 37.6220, smu_id: 2, smu_director_id: 4,
      responsible_id: 5, avatar_attachment_id: 1, elements_current: 300, drawings: [dwg("QA-корпус-1-3_v1.dxf")],
      deps: { zones: 0, agreements: 0, marks: 2 } }),
    O(4, 2, "QA-Секция 2.1", { address: "г Тестоград, наб QA-Речная, д 3, секция 1", lat: 55.7601, lon: 37.6302,
      smu_id: 2, elements_current: 150, drawings: [dwg("QA-секция-2-1_v1.dxf")] }),
    O(5, 2, "QA-Секция 2.2 (перспективная)", { status: "perspective", deps: { zones: 0, agreements: 0, marks: 2 } }),
    // 6 — единственный объект с типом учёта МФР.
    O(6, 2, "QA-МФР Корпус 2.3", { kind: "mfr", description: "Учёт по блокам из модели Revit.",
      revit_elements: 640, deps: { zones: 0, agreements: 1, marks: 0 }, smu_id: 3, responsible_id: 1 }),
    O(7, 3, "QA-Цех 3.1", { address: "г Тестоград, проезд QA-Заводской, д 7", lat: 55.6803, lon: 37.5902, elements_current: 90, drawings: [dwg("QA-цех-3-1_v1.dxf")] }),
    O(8, 3, "QA-Цех 3.2 (приостановлен)", { status: "suspended", elements_current: 40, drawings: [dwg("QA-цех-3-2_v1.dxf")] }),
    O(9, 4, "QA-Школа 4.1", { status: "perspective", deps: { zones: 1, agreements: 0, marks: 0 } }),
    O(10, 5, "QA-Детсад 5.1", { status: "suspended", elements_current: 22 }),
    O(11, 6, "QA-Больница 6.1 (завершён)", { status: "completed", elements_current: 2100, elements_retired: 40, mounted: 2100,
      lat: 55.7901, lon: 37.5502, drawings: [dwg("QA-больница-6-1_v5.dxf")] }),
    O(12, 6, "QA-Больница 6.2", { elements_current: 780, mounted: 210, drawings: [dwg("QA-больница-6-2_v2.dxf")] }),
    O(13, 7, "QA-Склад 7.1 (архив)", { status: "archived", elements_current: 500 }),
    O(14, 8, "QA-Логпарк 8.1", { address: "г Тестоград, шоссе QA-Южное, д 15", lat: 55.6201, lon: 37.7002, elements_current: 310, drawings: [dwg("QA-логпарк-8-1_v1.dxf")] }),
    O(15, 8, "QA-Логпарк 8.2", { drawings: [dwg("QA-логпарк-8-2_v1.dxf")] }),
    // 16 — очень длинные название и адрес.
    O(16, 10, "QA-Корпус 10.1 — жилой дом переменной этажности со встроенно-пристроенными помещениями общественного "
      + "назначения и подземной автостоянкой (секции 1–6, этапы строительства 1 и 2)",
      { address: longAddress, address_note: "Строительная площадка №4, вход через КПП-2", elements_current: 45,
        smu_id: 4, smu_director_id: 2, responsible_id: 4 }),
    O(17, 11, "QA-Депо 11.1", { elements_current: 12, lat: 55.7101, lon: 37.6802 }),
    O(18, 12, "QA-Мост 12.1", { elements_current: 77 }),
    // 19 — пустой, но со «сквозными» настройками (уходят вместе с объектом).
    O(19, 13, "QA-Парк 13.1", { status: "perspective", cascade: { app_settings: 0, label_visibility: 0, zone_colors: 0, report_notes: 2, default_contracts: 0 } }),
    // 20 — пустой и без зависимостей: удаляется чисто.
    O(20, 14, "QA-Пустой объект 14.1", { description: "Удаляется без блокеров." }),
  ];

  const smu = [
    { id: 1, name: "QA-СМУ-1 Северное" }, { id: 2, name: "QA-СМУ-2 Речное" }, { id: 3, name: "QA-СМУ-3 Промышленное" },
    { id: 4, name: "QA-СМУ «Строительно-монтажное управление №4 по возведению жилых и общественных зданий»" },
    { id: 5, name: "QA-СМУ-5 Южное" },
  ];
  const individuals = [
    { id: 1, name: "QA-Иванов Иван Иванович" }, { id: 2, name: "QA-Петров Пётр Петрович" },
    { id: 3, name: "QA-Сидорова Мария Александровна" }, { id: 4, name: "QA-Кузнецов Сергей Николаевич" },
    { id: 5, name: "QA-Орлова Елена Викторовна" },
  ];

  const png = () => b64bytes(PNG_1X1_B64);
  const longName = "QA-Очень-длинное-имя-файла-вложения-которое-не-помещается-в-строку-списка-вложений-и-должно-"
    + "переноситься-или-обрезаться_версия_2_финал_(копия).docx";
  const F = (id, entity_type, entity_id, filename, content_type, bytes, o = {}) => ({
    id, entity_type, entity_id, filename, size: bytes.length, content_type, description: null,
    uploaded_at: ts("12", "08:30:00"), uploaded_by: "QA-Админов Анатолий Сергеевич", uploaded_by_user_id: 1, _bytes: bytes, ...o,
  });
  const attachments = [
    F(1, "object", 3, "QA-фасад-превью.png", "image/png", png(), { description: "Превью объекта" }),
    F(2, "object", 3, "QA-акт-освидетельствования.pdf", "application/pdf", textBytes("%PDF-1.4 QA fake"), { description: "Акт скрытых работ" }),
    F(3, "object", 3, longName, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", textBytes("QA docx"),
      { description: "Очень длинное описание вложения, которое проверяет перенос строк и обрезку в списке вложений карточки объекта" }),
    F(4, "object", 1, "QA-схема-корпуса.png", "image/png", png(), { uploaded_at: ts("14", "10:00:00") }),
    F(5, "project", 1, "QA-договор-проекта.pdf", "application/pdf", textBytes("%PDF-1.4 QA project"), { description: "Договор" }),
  ];

  return {
    users, roles, roleFeatures, access, projects, objects, smu, individuals, attachments,
    // Настройки «сервера»: включена ли доменная авторизация, открыт ли список логинов на экране
    // входа, что загружено в классификатор КЛАДР (пусто = «не загружен»).
    settings: { ldapEnabled: true, publicLoginList: true, kladrLoaded: [], onlineTiles: false },
    session: { active: true, userId: 1 },
    mePatch: null,
    permissionsPatch: null,
  };
}

// ============================ «серверная» часть ==============================

function createServer(opts) {
  const nowFn = opts.now || null;
  const data = {};
  const counters = {};
  const internalErrors = [];

  // avatars — производная таблица: источник правды — objects.avatar_attachment_id.
  Object.defineProperty(data, "avatars", {
    enumerable: true, configurable: false,
    get() {
      const m = {};
      for (const o of data.objects || []) if (o.avatar_attachment_id != null) m[o.id] = o.avatar_attachment_id;
      return m;
    },
  });

  // grants — синоним access («гранты по пользователям»: строки user_access).
  Object.defineProperty(data, "grants", { enumerable: false, configurable: false, get() { return data.access; } });

  const TABLES = ["users", "roles", "roleFeatures", "access", "projects", "objects", "smu", "individuals", "attachments"];
  const OVERRIDE_ALIASES = { grants: "access", role_features: "roleFeatures" };

  // Таблицы правятся НА МЕСТЕ: тест может держать ссылку ctl.data.access и после удаления строк.
  function setRows(table, rows) { const a = data[table]; a.splice(0, a.length, ...rows); }

  function takeId(table) {
    const rows = data[table] || [];
    const max = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
    counters[table] = Math.max(counters[table] || 1, max + 1);
    return counters[table]++;
  }

  function reset(overrides = {}) {
    const fx = buildFixtures();
    for (const k of Object.keys(data)) if (k !== "avatars") delete data[k];
    Object.assign(data, fx);
    for (const k of Object.keys(counters)) delete counters[k];
    for (const [rawKey, val] of Object.entries(overrides || {})) {
      const key = OVERRIDE_ALIASES[rawKey] || rawKey;
      if (TABLES.includes(key)) {
        data[key] = typeof val === "function" ? val(data[key]) : deepClone(val);
      } else if (key === "settings") {
        Object.assign(data.settings, val);
      } else if (key === "me") {
        data.mePatch = val ? { ...val } : null;
      } else if (key === "permissions") {
        data.permissionsPatch = val ? deepClone(val) : null;
      } else if (key === "session") {
        if (typeof val === "boolean") data.session.active = val; else Object.assign(data.session, val);
      } else if (key === "userId" || key === "meId") {
        data.session.userId = val;
      } else {
        throw new Error(`fake-backend: неизвестный ключ overrides «${rawKey}»`);
      }
    }
  }

  // ------------------------------ права --------------------------------------

  const roleRows = () => [...data.roles].sort((a, b) => cmp(a.rank, b.rank) || cmp(a.id || 0, b.id || 0));
  const roleList = () => roleRows().map((r) => ({ key: r.key, name: r.name, rank: r.rank }));
  const roleKeys = () => roleRows().map((r) => r.key);
  const roleLabels = () => Object.fromEntries(data.roles.map((r) => [r.key, r.name]));
  const objectById = (id) => data.objects.find((o) => o.id === id) || null;
  const projectById = (id) => data.projects.find((p) => p.id === id) || null;
  const objectKind = (id) => objectById(id)?.kind || "zhbi";

  function roleLevel(roles, featureKey) {
    let best = 0;
    for (const rf of data.roleFeatures) {
      if (rf.feature_key === featureKey && roles.has(rf.role_key)) best = Math.max(best, LEVELS.indexOf(rf.level));
    }
    return LEVELS[best];
  }

  // Гранты трёх уровней складываются (app/access.py _ГРАНТ_ПОДХОДИТ).
  function grantMatches(g, obj) {
    return g.object_id === obj.id
      || (g.object_id == null && g.project_id != null && g.project_id === obj.project_id)
      || (g.object_id == null && g.project_id == null);
  }
  function objectRoleKeys(user, objectId) {
    const obj = objectById(objectId);
    if (!obj) return new Set();
    return new Set(data.access.filter((g) => g.user_id === user.id && grantMatches(g, obj)).map((g) => g.role));
  }
  function objectRoleSources(user, objectId) {
    const obj = objectById(objectId);
    const out = {};
    if (!obj) return out;
    const rank = {};
    for (const g of data.access) {
      if (g.user_id !== user.id || !grantMatches(g, obj)) continue;
      let label, r;
      if (g.object_id === obj.id) { label = obj.name; r = 0; }
      else if (g.object_id == null && g.project_id === obj.project_id && g.project_id != null) {
        label = `проект «${projectById(obj.project_id)?.name}»`; r = 1;
      } else { label = "все проекты"; r = 2; }
      if (rank[g.role] === undefined || r < rank[g.role]) { rank[g.role] = r; out[g.role] = label; }
    }
    return out;
  }
  const allRoleKeys = (user) => new Set(data.access.filter((g) => g.user_id === user.id).map((g) => g.role));
  function accessibleObjectIds(user, sysAdmin) {
    if (sysAdmin) return null;
    return new Set(data.objects.filter((o) => data.access.some((g) => g.user_id === user.id && grantMatches(g, o))).map((o) => o.id));
  }

  // Уровень раздела для пользователя — has_feature/feature_level_for из app/access.py.
  function computeLevel(user, key, objectId, sysAdmin) {
    const f = FEATURE_BY_KEY.get(key);
    if (!f) throw new Error(`fake-backend: неизвестный раздел ${key}`);
    if (f.scope === "self") return "write";
    if (f.kinds.length && objectId != null && !f.kinds.includes(objectKind(objectId))) return "none";
    if (sysAdmin) return "write";
    let roles;
    if (objectId != null) roles = objectRoleKeys(user, objectId);
    else if (f.scope === "object") return "none";
    else roles = allRoleKeys(user);
    return roleLevel(roles, key);
  }

  // «Действующий» пользователь: строка из таблицы + точечные замены ctl.setUser().
  function effectiveUser() {
    const row = data.users.find((u) => u.id === data.session.userId);
    if (!row) return null;
    return data.mePatch ? { ...row, ...data.mePatch } : row;
  }
  const perm = () => data.permissionsPatch || null;
  function isAdmin(user) {
    const p = perm();
    if (p && typeof p.system_admin === "boolean") return p.system_admin;
    return user.role === "admin";
  }
  function currentLevel(user, key, objectId) {
    const f = FEATURE_BY_KEY.get(key);
    const p = perm();
    if (p && p.features && hasOwn(p.features, key) && f.scope !== "self") {
      if (f.kinds.length && objectId != null && !f.kinds.includes(objectKind(objectId))) return "none";
      return p.features[key];
    }
    return computeLevel(user, key, objectId, isAdmin(user));
  }
  // ВИДИМОСТЬ ДАННЫХ (списки проектов/объектов, дерево, карта) определяется учётной записью,
  // а не профилем прав из ctl.setPermissions(): «system_admin:false» в профиле сужает
  // РАЗДЕЛЫ и проверки 403, но не прячет данные у записи с ролью admin (иначе профиль
  // «только чтение» показывал бы пустые каталоги). Настоящую видимость по грантам даёт
  // ctl.loginAs(<id пользователя без роли admin>).
  const seesAll = (user) => user.role === "admin" || !!(perm() && perm().system_admin === true);

  function hasFeature(user, key, kind, objectId) {
    const lv = currentLevel(user, key, objectId);
    return kind === "write" ? lv === "write" : lv === "read" || lv === "write";
  }
  // Текст отказа — как assert_feature в app/access.py.
  function assertFeature(user, key, kind, objectId = null) {
    if (hasFeature(user, key, kind, objectId)) return;
    const f = FEATURE_BY_KEY.get(key);
    const action = kind === "write" ? "изменение" : "просмотр";
    const where = f.scope === "object" ? "на объекте" : "хотя бы на одном объекте";
    const fit = [];
    for (const r of data.roles) {
      const lv = roleLevel(new Set([r.key]), key);
      if (lv === "write" || (kind === "read" && lv !== "none")) fit.push(r.name);
    }
    fit.sort();
    const tail = fit.length ? `; такое даёт роль: ${fit.join(", ")}`
      : "; ни одной роли этот раздел не выдан — только администратору сервиса";
    fail(403, `«${f.title}»: ${action} требует роли ${where}${tail}`);
  }
  function assertObjectFeature(user, objectId, key, kind) {
    if (!objectById(objectId)) fail(404, "Объект не найден");
    assertFeature(user, key, kind, objectId);
  }

  // Матрица прав одного пользователя на одном объекте (rights_for в rights_matrix.py).
  function rightsFor(user, objectId, { current = false } = {}) {
    const labels = roleLabels();
    const sys = current ? isAdmin(user) : user.role === "admin";
    const roles = objectId != null && !sys ? objectRoleKeys(user, objectId) : new Set();
    const sources = objectId != null && !sys ? objectRoleSources(user, objectId) : {};
    const kind = objectId != null ? objectKind(objectId) : null;
    const rows = FEATURES.map((f) => {
      const target = f.scope === "object" ? objectId : null;
      const notApplicable = !!(f.kinds.length && kind && !f.kinds.includes(kind));
      const level = current ? currentLevel(user, f.key, target) : computeLevel(user, f.key, target, sys);
      return {
        not_applicable: notApplicable, kinds: [...f.kinds], key: f.key, section: f.section, title: f.title,
        note: f.note, sources: f.sources, io: f.io, io_hint: IO_HINTS[f.io] || null,
        scope: f.scope, scope_label: SCOPE_LABELS[f.scope] || null, level,
        from_roles: [...roles].filter((r) => roleLevel(new Set([r]), f.key) !== "none")
          .map((r) => ({ role: labels[r] || r, source: sources[r] ?? null }))
          .sort((a, b) => cmp(a.role, b.role)),
      };
    });
    return {
      user_id: user.id, object_id: objectId, object_kind: kind, object_kind_label: KIND_LABELS[kind] || null,
      object_roles: [...roles].map((r) => labels[r] || r).sort(), system_admin: sys, features: rows,
    };
  }

  // ------------------------------ выходные формы -----------------------------

  const displayName = (u) => [u.last_name, u.first_name, u.patronymic].filter(Boolean).join(" ");
  const authMethod = (u) => (u.auth_method === "domain" ? "domain" : "local");
  const mustChange = (u) => !!u.must_change_password && authMethod(u) === "local";

  function userOut(u) {
    return {
      id: u.id, last_name: u.last_name, first_name: u.first_name ?? "", patronymic: u.patronymic ?? null,
      position: u.position ?? null, department: u.department ?? null, domain_login: u.domain_login, role: u.role,
      display_name: displayName(u), has_password: !!u.password, label_color: u.label_color ?? null,
      auth_method: authMethod(u), must_change_password: mustChange(u), ui_theme: u.ui_theme ?? null,
      menu_prefs: u.menu_prefs ?? null, changelog_unseen: !!u.changelog_unseen,
      view3d_pitch_deg: u.view3d_pitch_deg ?? 30.0, view3d_yaw_deg: u.view3d_yaw_deg ?? -30.0,
      min_label_px: u.min_label_px ?? 12.0, impersonated_by: null,
    };
  }
  const addressOut = (row) => Object.fromEntries(ADDRESS_COLS.map((c) => [c, row[c] ?? null]));

  function visibleObjects(user) {
    const ids = accessibleObjectIds(user, seesAll(user));
    return ids === null ? data.objects : data.objects.filter((o) => ids.has(o.id));
  }

  function projectOut(p, user) {
    const objs = visibleObjects(user).filter((o) => o.project_id === p.id);
    const starts = objs.map((o) => o.smr_start).filter(Boolean).sort();
    const ends = objs.map((o) => o.smr_end).filter(Boolean).sort();
    return {
      ...addressOut(p), id: p.id, name: p.name, status: p.status || "active", description: p.description ?? null,
      objects_count: objs.length, elements_count: objs.reduce((s, o) => s + (o.elements_current || 0), 0),
      smr_start: starts[0] ?? null, smr_end: ends.length ? ends[ends.length - 1] : null,
    };
  }
  function objectOut(o) {
    const nameOf = (rows, id) => (id == null ? null : rows.find((r) => r.id === id)?.name ?? null);
    const dr = [...o.drawings].sort((a, b) => cmp(a.imported_at, b.imported_at));
    return {
      ...addressOut(o), id: o.id, name: o.name, kind: o.kind || "zhbi", status: o.status || "active",
      project_id: o.project_id ?? null, project_name: o.project_id == null ? null : projectById(o.project_id)?.name ?? null,
      description: o.description ?? null, current_source_file: dr.find((d) => d.is_current)?.source_file ?? null,
      drawings: dr.map((d) => d.source_file), elements_current: o.elements_current || 0, elements_retired: o.elements_retired || 0,
      smu_id: o.smu_id ?? null, smu_name: nameOf(data.smu, o.smu_id),
      smu_director_id: o.smu_director_id ?? null, smu_director_name: nameOf(data.individuals, o.smu_director_id),
      responsible_id: o.responsible_id ?? null, responsible_name: nameOf(data.individuals, o.responsible_id),
      media_url: o.media_url ?? null, smr_start_reported: o.smr_start_reported ?? null,
      has_avatar: !!o.avatar_attachment_id, avatar_attachment_id: o.avatar_attachment_id ?? null,
    };
  }
  const attachmentOut = (a) => ({
    id: a.id, entity_type: a.entity_type, entity_id: a.entity_id, filename: a.filename, size: a.size,
    content_type: a.content_type ?? null, description: a.description ?? null, uploaded_at: a.uploaded_at, uploaded_by: a.uploaded_by,
  });
  const attachmentsFor = (type, id) => data.attachments.filter((a) => a.entity_type === type && a.entity_id === id)
    .sort((a, b) => cmp(b.uploaded_at, a.uploaded_at) || cmp(b.id, a.id)).map(attachmentOut);

  // ------------------------------ проверки ввода -----------------------------

  function parse(ctx, spec) {
    if (ctx.jsonInvalid) {
      throw validation([{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {}, ctx: { error: "Expecting value" } }]);
    }
    return parseModel(ctx.body, spec);
  }
  function pathInt(ctx, name) {
    const raw = ctx.params[name];
    const r = coerce("int", raw);
    if (r.e) throw validation([{ type: r.e[0], loc: ["path", name], msg: r.e[1], input: raw }]);
    return r.v;
  }
  function queryValue(ctx, name, { type = "str", required = false } = {}) {
    const raw = ctx.query.get(name);
    if (raw === null) {
      if (required) throw validation([{ type: "missing", loc: ["query", name], msg: "Field required", input: null }]);
      return null;
    }
    const r = coerce(type, raw);
    if (r.e) throw validation([{ type: r.e[0], loc: ["query", name], msg: r.e[1], input: raw }]);
    return r.v;
  }
  function validStatus(value) {
    if (value === null || value === undefined || value === "") return "active";
    if (!CATALOG_STATUSES.includes(value)) {
      fail(400, "Статус бывает " + CATALOG_STATUSES.map((k) => `${k} (${CATALOG_STATUS_LABELS[k]})`).join(", "));
    }
    return value;
  }
  function validKind(value) {
    if (value === null || value === undefined || value === "") return "zhbi";
    if (!KINDS.includes(value)) fail(400, "Тип объекта бывает " + KINDS.map((k) => `${k} (${KIND_LABELS[k]})`).join(", "));
    return value;
  }
  function validCoord(field, value) {
    if (value === null || value === undefined || value === "") return null;
    const limit = field === "lat" ? 90 : 180;
    if (!(Math.abs(value) <= limit)) {
      fail(400, `${field === "lat" ? "Широта" : "Долгота"} вне допустимого диапазона (±${limit})`);
    }
    return value;
  }
  // Пары «колонка — значение» только для ПРИСЛАННЫХ адресных полей (_адресные_правки).
  function addressEdits(values, given) {
    const out = [];
    for (const col of ADDRESS_COLS) {
      if (!given.has(col)) continue;
      let v = values[col];
      if (col === "address_parts") v = v && Object.keys(v).length ? v : null;
      else if (col === "lat" || col === "lon") v = validCoord(col, v);
      else if (typeof v === "string") v = v.trim() || null;
      out.push([col, v]);
    }
    return out;
  }
  const REQUISITE_COLS = ["media_url", "smr_start_reported"];
  function requisiteEdits(values, given) {
    return REQUISITE_COLS.filter((c) => given.has(c)).map((c) => [c, typeof values[c] === "string" ? (values[c].trim() || null) : values[c]]);
  }
  const REF_FIELDS = {
    smu_id: ["smu", "СМУ"], smu_director_id: ["individuals", "Физлицо (директор СМУ)"],
    responsible_id: ["individuals", "Физлицо (ответственный)"],
  };
  function refEdits(values, given) {
    const out = [];
    for (const [field, [table, label]] of Object.entries(REF_FIELDS)) {
      if (!given.has(field)) continue;
      const v = values[field];
      if (v !== null && !data[table].some((r) => r.id === v)) fail(404, `${label}: запись справочника не найдена`);
      out.push([field, v]);
    }
    return out;
  }
  function validatePasswordStrength(password) {
    if (password.length < MIN_PASSWORD_LENGTH) fail(422, `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
    if (!(/\p{L}/u.test(password) && /\p{Nd}/u.test(password))) fail(422, "Пароль должен содержать и буквы, и цифры");
  }
  function validateRole(role) {
    if (!["admin", "user", "view"].includes(role)) fail(422, `Неизвестная роль: ${role}`);
  }
  function validateAuthMethod(method) {
    if (!["local", "domain"].includes(method)) fail(422, `Неизвестный способ входа: ${method}`);
    if (method === "domain" && !data.settings.ldapEnabled) {
      fail(422, "Доменная авторизация выключена — включите её в «Администрирование → Доменная авторизация», "
        + "иначе этот пользователь не сможет войти");
    }
  }

  // ------------------------------ ключ роли ----------------------------------

  const TRANSLIT = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  function roleKeyFromName(name) {
    let base = [...(name || "").trim().toLowerCase()].map((c) => (hasOwn(TRANSLIT, c) ? TRANSLIT[c] : c)).join("");
    base = base.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "role";
    const taken = new Set(roleKeys());
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }
  const grantedCount = (key) => data.access.filter((g) => g.role === key).length;

  // ------------------------------ маршруты -----------------------------------

  const routes = [];
  function route(method, pattern, handler, { pub = false } = {}) {
    const keys = [];
    const re = new RegExp("^" + pattern.split("/").map((seg) => {
      if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/") + "/?$");
    routes.push({ method, pattern, re, keys, handler, pub });
  }

  // ---- вход и «я» ----
  route("GET", "/login-users", () => {
    if (!data.settings.publicLoginList) fail(404, "Список пользователей отключён");
    return [...data.users].sort((a, b) => cmp(a.last_name, b.last_name) || cmp(a.first_name, b.first_name))
      .map((u) => ({ domain_login: u.domain_login, display_name: displayName(u) }));
  }, { pub: true });

  route("POST", "/login", (ctx) => {
    const { values } = parse(ctx, LOGIN_SPEC);
    const user = data.users.find((u) => u.domain_login === values.domain_login);
    if (!user) fail(401, "Неверный логин или пароль");
    const ok = authMethod(user) === "domain" ? user.domainPassword === values.password : !!user.password && user.password === values.password;
    if (!ok) fail(401, "Неверный логин или пароль");
    data.session.active = true;
    data.session.userId = user.id;
    return userOut(user);
  }, { pub: true });

  route("POST", "/logout", () => { data.session.active = false; return { status: "ok" }; }, { pub: true });

  route("POST", "/me/change-password", (ctx) => {
    const user = ctx.user;
    const { values } = parse(ctx, CHANGE_OWN_SPEC);
    if (authMethod(user) === "domain") fail(409, "У вас доменная авторизация — пароль меняется в домене, а не здесь");
    if (!user.password || user.password !== values.current_password) fail(403, "Текущий пароль указан неверно");
    if (values.new_password === values.current_password) fail(422, "Новый пароль должен отличаться от текущего");
    validatePasswordStrength(values.new_password);
    const row = data.users.find((u) => u.id === user.id);
    row.password = values.new_password;
    row.must_change_password = false;
    return userOut(effectiveUser());
  });

  route("GET", "/me", (ctx) => {
    const out = userOut(ctx.user);
    return data.mePatch ? { ...out, ...data.mePatch } : out;
  });

  route("GET", "/me/permissions", (ctx) => {
    const user = ctx.user;
    const objectId = queryValue(ctx, "object_id", { type: "int" });
    if (objectId !== null && !objectById(objectId)) fail(404, "Объект не найден");
    const d = rightsFor(user, objectId, { current: true });
    const rf = {};
    for (const r of data.roleFeatures) (rf[r.role_key] ||= {})[r.feature_key] = r.level;
    const out = {
      object_id: objectId, object_roles: d.object_roles, system_admin: d.system_admin,
      features: Object.fromEntries(d.features.map((f) => [f.key, f.level])),
      object_kind: d.object_kind, not_applicable: d.features.filter((f) => f.not_applicable).map((f) => f.key),
      role_features: rf, roles: roleList(),
    };
    const p = perm();
    if (!p) return out;
    const { features, ...rest } = p;
    return { ...out, ...deepClone(rest), features: { ...out.features, ...(features || {}) } };
  });

  // ---- пользователи ----
  route("GET", "/users/access-matrix", (ctx) => {
    assertFeature(ctx.user, "users", "read");
    const grants = {};
    for (const g of data.access) {
      (grants[String(g.user_id)] ||= []).push({ project_id: g.project_id, object_id: g.object_id, role: g.role });
    }
    return { grants, roles: roleList(), role_labels: roleLabels() };
  });

  route("GET", "/users", (ctx) => {
    assertFeature(ctx.user, "users", "read");
    return [...data.users].sort((a, b) => cmp(a.last_name, b.last_name) || cmp(a.first_name, b.first_name)).map(userOut);
  });

  route("POST", "/users", (ctx) => {
    assertFeature(ctx.user, "users", "write");
    const { values: b } = parse(ctx, USER_CREATE_SPEC);
    if (opts.strictUserNames !== false) {
      const errs = [];
      for (const f of ["last_name", "domain_login"]) {
        if (!b[f].trim()) errs.push({ type: "string_too_short", loc: ["body", f], msg: "String should have at least 1 character",
          input: b[f], ctx: { min_length: 1 } });
      }
      if (errs.length) throw validation(errs);
    }
    validateRole(b.role);
    if (data.users.some((u) => u.domain_login === b.domain_login)) fail(409, "Такое доменное имя уже занято");
    validateAuthMethod(b.auth_method);
    const row = {
      id: takeId("users"), last_name: b.last_name, first_name: b.first_name, patronymic: b.patronymic, position: b.position,
      department: b.department, domain_login: b.domain_login, role: b.role, auth_method: b.auth_method, password: null,
      must_change_password: !!(b.must_change_password && b.auth_method === "local"),
      label_color: null, ui_theme: null, menu_prefs: null, changelog_unseen: false,
      view3d_pitch_deg: 30.0, view3d_yaw_deg: -30.0, min_label_px: 12.0,
    };
    data.users.push(row);
    return userOut(row);
  });

  route("PATCH", "/users/:user_id", (ctx) => {
    assertFeature(ctx.user, "users", "write");
    const id = pathInt(ctx, "user_id");
    const { values: b } = parse(ctx, USER_UPDATE_SPEC);
    validateRole(b.role);
    const row = data.users.find((u) => u.id === id);
    if (!row) fail(404, "Пользователь не найден");
    // Снять с себя роль администратора сервиса нельзя (app/users.py).
    if (row.id === ctx.user.id && row.role === "admin" && b.role !== "admin") {
      fail(409, "Нельзя снять роль администратора сервиса с самого себя: вернуть её будет некому. "
        + "Попросите об этом другого администратора");
    }
    if (data.users.some((u) => u.domain_login === b.domain_login && u.id !== id)) fail(409, "Такое доменное имя уже занято");
    validateAuthMethod(b.auth_method);
    Object.assign(row, {
      last_name: b.last_name, first_name: b.first_name, patronymic: b.patronymic, position: b.position,
      department: b.department, domain_login: b.domain_login, role: b.role, auth_method: b.auth_method,
      must_change_password: !!(b.must_change_password && b.auth_method === "local"),
    });
    // Пароль сервиса снимается вместе с переводом на домен.
    if (b.auth_method === "domain") row.password = null;
    return userOut(row);
  });

  route("POST", "/users/:user_id/set-password", (ctx) => {
    const cur = ctx.user;
    const id = pathInt(ctx, "user_id");
    const { values: b } = parse(ctx, SET_PASSWORD_SPEC);
    if (cur.role !== "admin" && cur.id !== id) fail(403, "Можно менять только свой пароль");
    if (b.password === "") {
      if (cur.role !== "admin") fail(403, "Нельзя снять собственный пароль");
    } else validatePasswordStrength(b.password);
    const row = data.users.find((u) => u.id === id);
    if (!row) fail(404, "Пользователь не найден");
    if (authMethod(row) === "domain") {
      fail(409, "У пользователя доменная авторизация — пароль сервиса не используется. "
        + "Чтобы задать пароль, сначала переключите способ входа на «Пароль сервиса».");
    }
    row.password = b.password === "" ? null : b.password;
    row.must_change_password = !!(b.must_change_password && b.password !== "");
    return userOut(row);
  });

  function listAccess(userId) {
    const row = data.users.find((u) => u.id === userId);
    if (!row) fail(404, "Пользователь не найден");
    const grants = data.access.filter((g) => g.user_id === userId).map((g) => ({
      id: g.id, project_id: g.project_id, object_id: g.object_id, role: g.role,
      project_name: g.project_id == null ? null : projectById(g.project_id)?.name ?? null,
      object_name: g.object_id == null ? null : objectById(g.object_id)?.name ?? null,
    })).sort((a, b) => cmpNullFirst(a.project_name, b.project_name) || cmpNullFirst(a.object_name, b.object_name));
    return { system_admin: row.role === "admin", grants };
  }
  route("GET", "/users/:user_id/access", (ctx) => {
    assertFeature(ctx.user, "users", "read");
    return listAccess(pathInt(ctx, "user_id"));
  });

  route("PUT", "/users/:user_id/access", (ctx) => {
    assertFeature(ctx.user, "users", "write");
    const id = pathInt(ctx, "user_id");
    const { values } = parse(ctx, GRANTS_SPEC);
    const known = new Set(roleKeys());
    for (const g of values.grants) {
      if (!known.has(g.role)) fail(400, `Неизвестная роль «${g.role}»`);
      if (g.object_id !== null && g.project_id === null) {
        fail(400, "Грант на объект должен указывать и проект — иначе связь объекта с проектом пришлось бы угадывать при каждой проверке");
      }
    }
    const keys = values.grants.map((g) => `${g.project_id}|${g.object_id}|${g.role}`);
    if (new Set(keys).size !== keys.length) fail(400, "В наборе есть повторяющиеся роли на одном уровне");
    if (!data.users.some((u) => u.id === id)) fail(404, "Пользователь не найден");
    for (const g of values.grants) {
      if (g.project_id !== null && !projectById(g.project_id)) fail(404, "Проект не найден");
      if (g.object_id !== null) {
        const obj = objectById(g.object_id);
        if (!obj) fail(404, "Объект не найден");
        if (obj.project_id !== g.project_id) fail(400, "Объект не принадлежит выбранному проекту");
      }
    }
    setRows("access", data.access.filter((g) => g.user_id !== id));
    for (const g of values.grants) {
      data.access.push({ id: takeId("access"), user_id: id, project_id: g.project_id, object_id: g.object_id, role: g.role });
    }
    return listAccess(id);
  });

  route("GET", "/users/:user_id/rights-matrix", (ctx) => {
    assertFeature(ctx.user, "users", "read");
    const id = pathInt(ctx, "user_id");
    const objectId = queryValue(ctx, "object_id", { type: "int" });
    const row = data.users.find((u) => u.id === id);
    if (!row) fail(404, "Пользователь не найден");
    if (objectId !== null && !objectById(objectId)) fail(404, "Объект не найден");
    return rightsFor(row, objectId);
  });

  // ---- роли ----
  route("GET", "/roles", (ctx) => {
    assertFeature(ctx.user, "roles", "read");
    const levels = {};
    for (const r of data.roleFeatures) (levels[r.feature_key] ||= {})[r.role_key] = r.level;
    return {
      roles: roleList().map((r) => ({ ...r, granted: grantedCount(r.key) })),
      features: FEATURES.map((f) => ({
        key: f.key, section: f.section, title: f.title, note: f.note, scope: f.scope, scope_label: SCOPE_LABELS[f.scope] || null,
        sources: f.sources, io: f.io, io_hint: IO_HINTS[f.io] || null, fixed: f.scope === "self", levels: levels[f.key] || {},
      })),
      sections: SECTIONS, level_labels: LEVEL_LABELS,
    };
  });

  route("POST", "/roles", (ctx) => {
    assertFeature(ctx.user, "roles", "write");
    const { values } = parse(ctx, ROLE_SPEC);
    const name = values.name.trim();
    if (!name) fail(400, "Название роли не может быть пустым");
    if (data.roles.some((r) => r.name === name)) fail(409, `Роль «${name}» уже есть`);
    const last = data.roles.reduce((m, r) => Math.max(m, r.rank), 0);
    const key = roleKeyFromName(name);
    data.roles.push({ id: takeId("roles"), key, name, rank: last + 10 });
    return created({ key, name, rank: last + 10, granted: 0 });
  });

  route("PUT", "/roles/order", (ctx) => {
    assertFeature(ctx.user, "roles", "write");
    const { values } = parse(ctx, ROLE_ORDER_SPEC);
    const current = roleKeys();
    if (JSON.stringify([...values.keys].sort()) !== JSON.stringify([...current].sort())) {
      fail(400, "Порядок задаётся полным списком ролей: получен не тот набор");
    }
    values.keys.forEach((key, i) => { data.roles.find((r) => r.key === key).rank = (i + 1) * 10; });
    return { roles: roleList() };
  });

  route("PUT", "/roles/features", (ctx) => {
    assertFeature(ctx.user, "roles", "write");
    const { values } = parse(ctx, CELLS_SPEC);
    const known = new Set(roleKeys());
    // Транзакция: всё или ничего — ошибка на N-й ячейке не оставляет предыдущие.
    const staged = data.roleFeatures.map((r) => ({ ...r }));
    const changed = [];
    for (const item of values.items) {
      const f = FEATURE_BY_KEY.get(item.feature_key);
      if (!f) fail(400, `Неизвестный раздел «${item.feature_key}»`);
      if (f.scope === "self") fail(400, `«${f.title}» роли не подчиняется: своё каждый меняет сам`);
      if (!known.has(item.role_key)) fail(400, `Неизвестная роль «${item.role_key}»`);
      if (!LEVELS.includes(item.level)) fail(400, `Неизвестный уровень «${item.level}»`);
      const idx = staged.findIndex((r) => r.role_key === item.role_key && r.feature_key === item.feature_key);
      const was = idx >= 0 ? staged[idx].level : "none";
      if (was === item.level) continue;
      if (item.level === "none") staged.splice(idx, 1);
      else if (idx >= 0) staged[idx].level = item.level;
      else staged.push({ role_key: item.role_key, feature_key: item.feature_key, level: item.level });
      changed.push({ role: item.role_key, feature: item.feature_key, was, now: item.level });
    }
    setRows("roleFeatures", staged);
    return { changed };
  });

  route("GET", "/roles/:key/delete-plan", (ctx) => {
    assertFeature(ctx.user, "roles", "read");
    const key = ctx.params.key;
    if (!data.roles.some((r) => r.key === key)) fail(404, "Роль не найдена");
    return {
      key, granted: grantedCount(key), users: new Set(data.access.filter((g) => g.role === key).map((g) => g.user_id)).size,
      permissions: data.roleFeatures.filter((r) => r.role_key === key).length,
    };
  });

  route("PATCH", "/roles/:key", (ctx) => {
    assertFeature(ctx.user, "roles", "write");
    const key = ctx.params.key;
    const { values } = parse(ctx, ROLE_SPEC);
    const name = values.name.trim();
    if (!name) fail(400, "Название роли не может быть пустым");
    const row = data.roles.find((r) => r.key === key);
    if (!row) fail(404, "Роль не найдена");
    if (data.roles.some((r) => r.name === name && r.key !== key)) fail(409, `Роль «${name}» уже есть`);
    row.name = name;
    return { key, name };
  });

  route("DELETE", "/roles/:key", (ctx) => {
    assertFeature(ctx.user, "roles", "write");
    const key = ctx.params.key;
    if (!data.roles.some((r) => r.key === key)) fail(404, "Роль не найдена");
    const removed = grantedCount(key);
    setRows("access", data.access.filter((g) => g.role !== key));
    setRows("roleFeatures", data.roleFeatures.filter((r) => r.role_key !== key));
    setRows("roles", data.roles.filter((r) => r.key !== key));
    return { deleted: key, granted: removed };
  });

  // ---- проекты и объекты ----
  route("GET", "/projects-tree", (ctx) => {
    const user = ctx.user;
    const visible = new Set(visibleObjects(user).map((o) => o.id));
    const roles = (objId) => {
      if (seesAll(user)) return [];
      return [...objectRoleKeys(user, objId)].sort();
    };
    const treeObj = (o) => ({
      id: o.id, name: o.name, address: o.address ?? null, kind: o.kind || "zhbi", status: o.status || "active",
      source_file: [...o.drawings].find((d) => d.is_current)?.source_file ?? null,
      elements: (o.kind || "zhbi") === "mfr" ? (o.revit_elements || 0) : (o.elements_current || 0),
      roles: roles(o.id),
    });
    const tree = [];
    for (const p of [...data.projects].sort((a, b) => cmp(a.name, b.name))) {
      const objs = data.objects.filter((o) => o.project_id === p.id && visible.has(o.id)).sort((a, b) => cmp(a.name, b.name)).map(treeObj);
      if (!objs.length) continue;
      tree.push({ id: p.id, name: p.name, address: p.address ?? null, status: p.status || "active", description: p.description ?? null, objects: objs });
    }
    const orphans = data.objects.filter((o) => (o.project_id == null) && visible.has(o.id)).sort((a, b) => cmp(a.name, b.name)).map(treeObj);
    if (orphans.length) {
      tree.push({ id: null, name: "Без проекта", address: null, status: "active", description: "Объекты, не привязанные к проекту", objects: orphans });
    }
    return { projects: tree, last_object_id: ctx.user.last_object_id ?? null };
  });

  function listProjects(user) {
    const admin = seesAll(user);
    const seen = new Set(visibleObjects(user).map((o) => o.project_id));
    return [...data.projects].sort((a, b) => cmp(a.name, b.name)).filter((p) => admin || seen.has(p.id)).map((p) => projectOut(p, user));
  }
  route("GET", "/projects", (ctx) => listProjects(ctx.user));

  route("POST", "/projects", (ctx) => {
    assertFeature(ctx.user, "projects", "write");
    const { values: b, given } = parse(ctx, PROJECT_IN_SPEC);
    const name = b.name.trim();
    if (!name) fail(400, "Наименование проекта не может быть пустым");
    if (data.projects.some((p) => p.name === name)) fail(409, "Проект с таким наименованием уже есть");
    const status = validStatus(b.status);
    const row = {
      id: takeId("projects"), name, status, description: b.description,
      address: null, address_code: null, address_source: null, address_region: null, address_parts: null,
      postal_code: null, address_note: null, lat: null, lon: null,
    };
    for (const [col, v] of addressEdits(b, given)) row[col] = v;
    data.projects.push(row);
    return projectOut(row, ctx.user);
  });

  route("PATCH", "/projects/:id", (ctx) => {
    assertFeature(ctx.user, "projects", "write");
    const id = pathInt(ctx, "id");
    const { values: b, given } = parse(ctx, PROJECT_PATCH_SPEC);
    const row = projectById(id);
    if (!row) fail(404, "Проект не найден");
    const edits = [];
    if (given.has("name")) {
      const name = (b.name || "").trim();
      if (!name) fail(400, "Наименование проекта не может быть пустым");
      if (data.projects.some((p) => p.name === name && p.id !== id)) fail(409, "Проект с таким наименованием уже есть");
      edits.push(["name", name]);
    }
    if (given.has("status")) {
      const status = validStatus(b.status);
      if (status === "archived") {
        const n = data.objects.filter((o) => o.project_id === id && (o.status || "active") === "active").length;
        if (n) fail(409, `В проекте ${n} активн(ый/ых) объект(ов) — сначала завершите или заархивируйте их`);
      }
      edits.push(["status", status]);
    }
    if (given.has("description")) edits.push(["description", b.description]);
    edits.push(...addressEdits(b, given));
    for (const [col, v] of edits) row[col] = v;
    return projectOut(row, ctx.user);
  });

  route("DELETE", "/projects/:id", (ctx) => {
    assertFeature(ctx.user, "projects", "write");
    const id = pathInt(ctx, "id");
    if (!projectById(id)) fail(404, "Проект не найден");
    const n = data.objects.filter((o) => o.project_id === id).length;
    if (n) fail(409, `В проекте ${n} объект(ов) — сначала перенесите их в другой проект`);
    removeProject(id);
    return { deleted: id };
  });

  function removeProject(id) {
    setRows("attachments", data.attachments.filter((a) => !(a.entity_type === "project" && a.entity_id === id)));
    setRows("access", data.access.filter((g) => g.project_id !== id));
    setRows("projects", data.projects.filter((p) => p.id !== id));
  }
  function removeObject(id) {
    setRows("attachments", data.attachments.filter((a) => !(a.entity_type === "object" && a.entity_id === id)));
    setRows("access", data.access.filter((g) => g.object_id !== id));
    for (const u of data.users) if (u.last_object_id === id) u.last_object_id = null;
    setRows("objects", data.objects.filter((o) => o.id !== id));
  }

  route("GET", "/objects", (ctx) => [...visibleObjects(ctx.user)].sort((a, b) => cmp(a.id, b.id)).map(objectOut));

  route("POST", "/objects", (ctx) => {
    assertFeature(ctx.user, "projects", "write");
    const { values: b, given } = parse(ctx, OBJECT_CREATE_SPEC);
    const name = b.name.trim();
    if (!name) fail(400, "Наименование объекта не может быть пустым");
    if (!projectById(b.project_id)) fail(404, "Проект не найден");
    if (data.objects.some((o) => o.name === name)) fail(409, "Объект с таким наименованием уже есть");
    const status = validStatus(b.status), kind = validKind(b.kind);
    const row = {
      id: takeId("objects"), project_id: b.project_id, name, kind, status, description: b.description,
      address: null, address_code: null, address_source: null, address_region: null, address_parts: null,
      postal_code: null, address_note: null, lat: null, lon: null,
      smu_id: null, smu_director_id: null, responsible_id: null, media_url: null, smr_start_reported: null,
      avatar_attachment_id: null, elements_current: 0, elements_retired: 0, revit_elements: 0, mounted: 0, drawings: [],
      deps: { zones: 0, agreements: 0, marks: 0 },
      cascade: { app_settings: 0, label_visibility: 0, zone_colors: 0, report_notes: 0, default_contracts: 0 },
      smr_start: null, smr_end: null,
    };
    for (const [col, v] of [...addressEdits(b, given), ...requisiteEdits(b, given), ...refEdits(b, given)]) row[col] = v;
    data.objects.push(row);
    return objectOut(row);
  });

  route("PATCH", "/objects/:id", (ctx) => {
    assertFeature(ctx.user, "projects", "write");
    const id = pathInt(ctx, "id");
    const { values: b, given } = parse(ctx, OBJECT_PATCH_SPEC);
    const row = objectById(id);
    if (!row) fail(404, "Объект не найден");
    const edits = [];
    if (given.has("name")) {
      const name = (b.name || "").trim();
      if (!name) fail(400, "Наименование объекта не может быть пустым");
      if (data.objects.some((o) => o.name === name && o.id !== id)) fail(409, "Объект с таким наименованием уже есть");
      edits.push(["name", name]);
    }
    // project_id: null — «не менять» (иначе форма без поля выкинула бы объект из проекта).
    if (b.project_id !== null) {
      if (!projectById(b.project_id)) fail(404, "Проект не найден");
      edits.push(["project_id", b.project_id]);
    }
    if (b.kind !== null) edits.push(["kind", validKind(b.kind)]);
    if (given.has("status")) edits.push(["status", validStatus(b.status)]);
    if (given.has("description")) edits.push(["description", b.description]);
    edits.push(...addressEdits(b, given), ...requisiteEdits(b, given), ...refEdits(b, given));
    for (const [col, v] of edits) row[col] = v;
    return objectOut(row);
  });

  route("PUT", "/objects/:id/avatar", (ctx) => {
    const id = pathInt(ctx, "id");
    const { values } = parse(ctx, AVATAR_SPEC);
    const row = objectById(id);
    if (!row) fail(404, "Объект не найден");
    assertObjectFeature(ctx.user, id, "attachments", "write");
    if (values.attachment_id !== null) {
      const att = data.attachments.find((a) => a.id === values.attachment_id);
      if (!att || att.entity_type !== "object" || att.entity_id !== id) fail(404, "Вложение не найдено у этого объекта");
      if (!AVATAR_MIME.includes(att.content_type || "")) fail(400, "Превью может быть только изображением (jpeg, png, webp, gif)");
    }
    row.avatar_attachment_id = values.attachment_id;
    return { avatar_attachment_id: values.attachment_id };
  });

  route("GET", "/objects/:id/avatar", (ctx) => {
    const id = pathInt(ctx, "id");
    const row = objectById(id);
    if (!row) fail(404, "Объект не найден");
    if (row.avatar_attachment_id == null) fail(404, "У объекта нет превью");
    assertObjectFeature(ctx.user, id, "attachments", "read");
    const att = data.attachments.find((a) => a.id === row.avatar_attachment_id);
    if (!att || !AVATAR_MIME.includes(att.content_type || "")) fail(404, "У объекта нет превью");
    if (!att._bytes) fail(410, "Файл превью отсутствует на диске");
    return { __blob: { bytes: att._bytes, type: att.content_type, headers: { "Cache-Control": "private, max-age=300" } } };
  });

  // ---- справочники СМУ и физлиц ----
  function catalogRoutes(path, table, featureKey, labels) {
    route("GET", path, () => [...data[table]].sort((a, b) => cmpNoCase(a.name, b.name)).map((r) => ({ id: r.id, name: r.name })));
    route("POST", path, (ctx) => {
      assertFeature(ctx.user, featureKey, "write");
      const { values } = parse(ctx, CATALOG_ENTRY_SPEC);
      const name = values.name.trim();
      if (!name) fail(400, labels.empty);
      if (data[table].some((r) => asciiLower(r.name) === asciiLower(name))) fail(409, labels.dup);
      const row = { id: takeId(table), name };
      data[table].push(row);
      return { id: row.id, name };
    });
    route("PATCH", `${path}/:id`, (ctx) => {
      assertFeature(ctx.user, featureKey, "write");
      const id = pathInt(ctx, "id");
      const { values } = parse(ctx, CATALOG_ENTRY_SPEC);
      const name = values.name.trim();
      if (!name) fail(400, labels.empty);
      const row = data[table].find((r) => r.id === id);
      if (!row) fail(404, labels.missing);
      if (data[table].some((r) => r.id !== id && asciiLower(r.name) === asciiLower(name))) fail(409, labels.dup);
      row.name = name;
      return { id, name };
    });
  }
  catalogRoutes("/smu", "smu", "dict_smu", {
    empty: "Наименование СМУ не может быть пустым", dup: "Такое СМУ уже есть в справочнике", missing: "СМУ не найдено",
  });
  catalogRoutes("/individuals", "individuals", "dict_individuals", {
    empty: "ФИО не может быть пустым", dup: "Такое физлицо уже есть в справочнике", missing: "Физлицо не найдено",
  });

  // ---- вложения ----
  function attachmentGuard(user, entityType, entityId, key, kind) {
    if (!["project", "object", "element"].includes(entityType)) fail(400, `Неизвестный вид сущности «${entityType}»`);
    if (entityType === "project") {
      if (!isAdmin(user)) fail(403, "Вложения проекта правит администратор сервиса");
      if (!projectById(entityId)) fail(404, "Проект не найден");
      return;
    }
    // Элементов в стенде нет: как у настоящего бэкенда, владелец «без объекта».
    const objectId = entityType === "object" ? (objectById(entityId) ? entityId : null) : null;
    if (objectId === null) {
      if (!isAdmin(user)) fail(404, entityType === "object" ? "Объект не найден" : "Элемент не найден");
      return;
    }
    assertObjectFeature(user, objectId, key, kind);
  }

  route("GET", "/attachments", (ctx) => {
    const entityType = queryValue(ctx, "entity_type", { required: true });
    const entityId = queryValue(ctx, "entity_id", { type: "int", required: true });
    attachmentGuard(ctx.user, entityType, entityId, "attachments", "read");
    return { attachments: attachmentsFor(entityType, entityId) };
  });

  route("POST", "/attachments", async (ctx) => {
    const form = ctx.form;
    const errors = [];
    const get = (name) => (form ? form.get(name) : null);
    const entityType = get("entity_type");
    const entityIdRaw = get("entity_id");
    const file = get("file");
    if (typeof entityType !== "string") errors.push({ type: "missing", loc: ["body", "entity_type"], msg: "Field required", input: null });
    let entityId = null;
    if (entityIdRaw === null || entityIdRaw === undefined) errors.push({ type: "missing", loc: ["body", "entity_id"], msg: "Field required", input: null });
    else {
      const r = coerce("int", typeof entityIdRaw === "string" ? entityIdRaw : "x");
      if (r.e) errors.push({ type: r.e[0], loc: ["body", "entity_id"], msg: r.e[1], input: entityIdRaw }); else entityId = r.v;
    }
    if (!(file && typeof file === "object" && typeof file.arrayBuffer === "function")) {
      errors.push({ type: "missing", loc: ["body", "file"], msg: "Field required", input: null });
    }
    if (errors.length) throw validation(errors);
    attachmentGuard(ctx.user, entityType, entityId, "attachments", "write");
    const original = ((file.name || "файл").trim()) || "файл";
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) fail(400, "Файл пустой");
    const maxBytes = (opts.maxUploadMb ?? 200) * 1024 * 1024;
    if (bytes.length > maxBytes) fail(413, "Файл слишком большой");
    const mime = (file.type || "").split(";")[0].trim().toLowerCase();
    const okMime = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(mime) ? mime : null;
    const descRaw = get("description");
    data.attachments.push({
      id: takeId("attachments"), entity_type: entityType, entity_id: entityId, filename: original.slice(0, 255), size: bytes.length,
      content_type: okMime, description: (typeof descRaw === "string" ? descRaw.trim() : "") || null,
      uploaded_at: nowStr(nowFn), uploaded_by: displayName(ctx.user), uploaded_by_user_id: ctx.user.id, _bytes: bytes,
    });
    return { attachments: attachmentsFor(entityType, entityId) };
  });

  route("GET", "/attachments/:id/download", (ctx) => {
    const id = pathInt(ctx, "id");
    const att = data.attachments.find((a) => a.id === id);
    if (!att) fail(404, "Вложение не найдено");
    attachmentGuard(ctx.user, att.entity_type, att.entity_id, "attachments", "read");
    if (!att._bytes) fail(410, "Файл вложения отсутствует на диске");
    return { __blob: { bytes: att._bytes, type: "application/octet-stream", headers: {
      "Content-Disposition": `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
    } } };
  });

  route("DELETE", "/attachments/:id", (ctx) => {
    const id = pathInt(ctx, "id");
    const att = data.attachments.find((a) => a.id === id);
    if (!att) fail(404, "Вложение не найдено");
    attachmentGuard(ctx.user, att.entity_type, att.entity_id, "attachments_delete", "write");
    setRows("attachments", data.attachments.filter((a) => a.id !== id));
    // objects.avatar_attachment_id — ON DELETE SET NULL.
    for (const o of data.objects) if (o.avatar_attachment_id === id) o.avatar_attachment_id = null;
    return { attachments: attachmentsFor(att.entity_type, att.entity_id) };
  });

  // ---- удаление записей справочников (app/dict_delete.py): проект и объект ----
  const nonEmpty = (pairs) => pairs.filter(([, n]) => n).map(([label, count]) => ({ label, count }));
  const DICT_KINDS = {
    object: {
      title: "Объект",
      load: (id) => objectById(id),
      blockers: (o) => nonEmpty([
        ["Изделия", (o.elements_current || 0) + (o.elements_retired || 0)], ["Зоны", o.deps.zones],
        ["Договоры", o.deps.agreements], ["Версии чертежа", o.drawings.length], ["Марки", o.deps.marks],
      ]),
      cascade: (o) => nonEmpty([
        ["Настройки объекта", o.cascade.app_settings], ["Видимость подписей", o.cascade.label_visibility],
        ["Цвета зон", o.cascade.zone_colors], ["События, задачи, вопросы", o.cascade.report_notes],
        ["Контракты по умолчанию", o.cascade.default_contracts],
        ["Выданные доступы", data.access.filter((g) => g.object_id === o.id).length],
      ]),
      checked: (o) => [
        ["agreements.object_id", o.deps.agreements, "держит удаление"],
        ["app_settings.object_id", o.cascade.app_settings, "удаляется вместе"],
        ["default_contracts.object_id", o.cascade.default_contracts, "удаляется вместе"],
        ["elements.object_id", (o.elements_current || 0) + (o.elements_retired || 0), "держит удаление"],
        ["label_visibility.object_id", o.cascade.label_visibility, "удаляется вместе"],
        ["marks.object_id", o.deps.marks, "держит удаление"],
        ["object_drawings.object_id", o.drawings.length, "держит удаление"],
        ["report_notes.object_id", o.cascade.report_notes, "удаляется вместе"],
        ["user_access.object_id", data.access.filter((g) => g.object_id === o.id).length, "удаляется вместе"],
        ["users.last_object_id", data.users.filter((u) => u.last_object_id === o.id).length, "ссылка снимается"],
        ["zone_colors.object_id", o.cascade.zone_colors, "удаляется вместе"],
        ["zones.object_id", o.deps.zones, "держит удаление"],
      ],
      remove: (o) => removeObject(o.id),
    },
    project: {
      title: "Проект",
      load: (id) => projectById(id),
      blockers: (p) => nonEmpty([["Объекты", data.objects.filter((o) => o.project_id === p.id).length]]),
      cascade: (p) => nonEmpty([["Выданные доступы", data.access.filter((g) => g.project_id === p.id).length]]),
      checked: (p) => [
        ["objects.project_id", data.objects.filter((o) => o.project_id === p.id).length, "держит удаление"],
        ["user_access.project_id", data.access.filter((g) => g.project_id === p.id).length, "удаляется вместе"],
      ],
      remove: (p) => removeProject(p.id),
    },
  };

  function buildPlan(kind, key) {
    const view = DICT_KINDS[kind];
    if (!view) fail(404, `Неизвестный справочник: ${kind}`);
    if (!/^\s*[+-]?\d+\s*$/.test(String(key))) fail(422, "Неверный ключ записи");
    const row = view.load(Number(key));
    if (!row) fail(404, `${view.title}: запись не найдена`);
    return {
      kind, key: String(row.id), kind_title: view.title, label: row.name, parent_kind: null, refs: [],
      cascade: view.cascade(row), checked: view.checked(row).map(([label, count, handled]) => ({ label, count, handled })),
      blockers: view.blockers(row), children: [], needs_replacement: false, replaceable: false, mergeable: false,
      adopt_title: null, _row: row,
    };
  }
  const planOut = ({ _row, ...rest }) => rest;
  const planBlockers = (plan) => plan.blockers.map((b) => ({ ...b, owner: `${plan.kind_title} «${plan.label}»` }));

  route("GET", "/dictionaries/:kind/:key/delete-plan", (ctx) => {
    assertFeature(ctx.user, "dict_delete", "read");
    const plan = buildPlan(ctx.params.kind, ctx.params.key);
    return { plan: planOut(plan), blockers: planBlockers(plan) };
  });

  route("POST", "/dictionaries/:kind/:key/delete", (ctx) => {
    assertFeature(ctx.user, "dict_delete", "write");
    const { values } = parse(ctx, DELETE_SPEC);
    const plan = buildPlan(ctx.params.kind, ctx.params.key);
    const blocking = planBlockers(plan);
    if (blocking.length) {
      fail(409, "Удалить нельзя, за записью ещё стоят данные: "
        + blocking.map((b) => `${b.owner}: ${b.label} — ${b.count}`).join(", "));
    }
    if (values.mode === "merge") fail(400, `У записи «${plan.kind_title}» нет подчинённых, которые можно перенести`);
    DICT_KINDS[plan.kind].remove(plan._row);
    return { deleted: [{ kind: plan.kind, label: plan.label }], moved: [] };
  });

  // ---- адресный классификатор (app/kladr.py) ----
  // Классификатор «не загружен»: статус с пустым loaded — виджет уходит в ручной ввод.
  route("GET", "/address/status", () => ({
    dir: "data/kladr", files: [], loaded: deepClone(data.settings.kladrLoaded || []), objects_total: 0,
    db_size: 0, has_7z: false, job: null,
  }));
  route("GET", "/address/settlements", (ctx) => { queryValue(ctx, "q"); return { items: [] }; });
  route("GET", "/address/streets", (ctx) => { queryValue(ctx, "parent", { required: true }); return { items: [] }; });
  route("GET", "/address/houses", (ctx) => { queryValue(ctx, "parent", { required: true }); return { items: [] }; });
  route("GET", "/address/check-house", (ctx) => {
    queryValue(ctx, "parent", { required: true }); queryValue(ctx, "number", { required: true });
    return { found: false, postal_code: null };
  });
  route("GET", "/address/resolve", (ctx) => {
    queryValue(ctx, "code", { required: true });
    fail(404, "Адрес по этому коду не найден");
  });

  // ---- карта (app/project_map.py) ----
  route("GET", "/map/config", (ctx) => {
    assertFeature(ctx.user, "map", "read");
    const online = !!data.settings.onlineTiles;
    return {
      basemaps: [], attribution: "© OpenStreetMap contributors", default_center: { lat: 55.75, lon: 37.62 }, default_zoom: 4,
      online, online_url: online ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : null,
      geocode_url: online ? "https://nominatim.openstreetmap.org/search" : null,
    };
  });
  route("GET", "/map/objects", (ctx) => {
    assertFeature(ctx.user, "map", "read");
    const out = []; let without = 0;
    for (const o of [...visibleObjects(ctx.user)].sort((a, b) => cmp(projectById(a.project_id)?.name || "", projectById(b.project_id)?.name || "") || cmp(a.name, b.name))) {
      const p = projectById(o.project_id);
      let lat = o.lat, lon = o.lon, inherited = false;
      if (lat == null || lon == null) { lat = p?.lat ?? null; lon = p?.lon ?? null; inherited = lat != null && lon != null; }
      if (lat == null || lon == null) { without++; continue; }
      const elements = o.elements_current || 0, mounted = o.mounted || 0;
      out.push({
        id: o.id, name: o.name, kind: o.kind || "zhbi", status: o.status || "active", project_id: o.project_id,
        project_name: p?.name ?? null, address: o.address ?? null, region: o.address_region ?? null, description: o.description ?? null,
        has_avatar: !!o.avatar_attachment_id, lat, lon, inherited, elements, mounted,
        percent: elements ? Math.round((mounted * 100) / elements) : null, smr_start: o.smr_start, smr_end: o.smr_end,
      });
    }
    return { objects: out, without_coords: without };
  });

  // ---- заглушки (см. заголовок файла) ----
  route("GET", "/counterparties", () => []);

  // ------------------------------ диспетчер ----------------------------------

  const ALLOWED_WHILE_PASSWORD_EXPIRED = new Set(["/me", "/me/change-password", "/logout"]);

  function matchRoute(method, path) {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch (e) { params[k] = m[i + 1]; }
      });
      return { route: r, params };
    }
    return pathMatched ? "405" : null;
  }

  function authenticate(ctx) {
    if (!data.session.active) fail(401, "Требуется вход");
    const user = effectiveUser();
    if (!user) fail(401, "Сессия истекла или недействительна");
    if (mustChange(user) && !ALLOWED_WHILE_PASSWORD_EXPIRED.has(ctx.path)) {
      fail(403, "Пароль задан администратором и должен быть заменён — смените пароль, чтобы продолжить работу");
    }
    ctx.user = user;
  }

  // Возвращает описание ответа: {status, json|rawBody|blob, headers}.
  async function handle(req) {
    const m = matchRoute(req.method, req.path);
    if (m === "405") return { status: 405, json: { detail: "Method Not Allowed" } };
    if (!m) return { status: 404, json: { detail: "Not Found" } };
    const ctx = { ...req, params: m.params, user: null };
    try {
      if (!m.route.pub) authenticate(ctx);
      const out = await m.route.handler(ctx);
      if (out && out.__blob) return { status: 200, blob: out.__blob };
      if (out && out.__status) return { status: out.__status, json: out.body };
      return { status: 200, json: out === undefined ? null : out };
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.extra.rawBody !== undefined) return { status: e.status, rawBody: e.extra.rawBody, contentType: e.extra.contentType };
        return { status: e.status, json: { detail: e.detail } };
      }
      internalErrors.push(e);
      return { status: 500, json: { detail: `fake-backend: внутренняя ошибка стенда — ${e && e.message}` } };
    }
  }

  reset(opts.overrides);
  return { data, reset, handle, internalErrors, takeId, roleList, effectiveUser, isAdmin, userOut, rightsFor };
}

// ============================ подмена fetch ==================================

function makeMatcher(pattern, method) {
  const m = method && method !== "*" ? String(method).toUpperCase() : null;
  return (entry) => {
    if (m && entry.method !== m) return false;
    if (pattern === undefined || pattern === null || pattern === "") return true;
    if (pattern instanceof RegExp) { pattern.lastIndex = 0; return pattern.test(`${entry.method} ${entry.path}`); }
    const p = String(pattern);
    if (p.startsWith("=")) {
      const want = p.slice(1);
      const bare = entry.path.split("?")[0];
      return want.includes(" ") ? `${entry.method} ${bare}` === want : bare === want;
    }
    return `${entry.method} ${entry.path}`.includes(p);
  };
}

const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|\*)$/;
// (метод, паттерн) или (паттерн[, метод]) → [паттерн, метод]: HTTP-глагол первым аргументом — метод.
function splitMethodArg(a, b) {
  if (typeof a === "string" && HTTP_VERB.test(a) && b !== undefined && !(isObj(b) && !(b instanceof RegExp))) return [b, a];
  return [a, typeof b === "string" ? b : undefined];
}

function defaultDetail(status) {
  const texts = {
    400: "Некорректный запрос", 401: "Требуется вход", 403: "Недостаточно прав", 404: "Не найдено",
    409: "Конфликт данных", 410: "Файл отсутствует", 413: "Файл слишком большой",
    422: [{ type: "missing", loc: ["body", "name"], msg: "Field required", input: {} }],
  };
  return status in texts ? texts[status] : "Внутренняя ошибка сервера";
}

function makeResponse(spec, url) {
  const status = spec.status;
  const headers = typeof Headers === "function" ? new Headers() : new Map();
  const setHeader = (k, v) => (typeof Headers === "function" ? headers.set(k, v) : headers.set(k.toLowerCase(), v));
  let bytes = null, text = "", type = "application/json";
  if (spec.blob) {
    bytes = spec.blob.bytes; type = spec.blob.type || "application/octet-stream";
    for (const [k, v] of Object.entries(spec.blob.headers || {})) setHeader(k, v);
  } else if (spec.rawBody !== undefined) {
    text = String(spec.rawBody); type = spec.contentType || "text/plain; charset=utf-8";
  } else if (status !== 204) {
    text = JSON.stringify(spec.json === undefined ? null : spec.json);
  } else text = "";
  setHeader("Content-Type", type);
  if (typeof headers.get !== "function") headers.get = () => null;
  const textOf = () => (bytes ? new TextDecoder().decode(bytes) : text);
  const bytesOf = () => bytes || new TextEncoder().encode(text);
  const res = {
    ok: status >= 200 && status < 300, status, statusText: STATUS_TEXT[status] || "", headers, url,
    redirected: false, type: "basic", bodyUsed: false,
    text: async () => textOf(),
    json: async () => JSON.parse(textOf()),
    blob: async () => new Blob([bytesOf()], { type }),
    arrayBuffer: async () => bytesOf().slice().buffer,
    clone: () => makeResponse(spec, url),
  };
  return res;
}

export function installFakeBackend(opts = {}) {
  // Повторная установка заменяет предыдущий стенд (прогон тестов без uninstall).
  if (globalThis.__fakeBackendCtl && typeof globalThis.__fakeBackendCtl.uninstall === "function") {
    globalThis.__fakeBackendCtl.uninstall();
  }
  const originalFetch = globalThis.fetch;
  let origin = DEFAULT_ORIGIN;
  try { origin = new URL(opts.origin || globalThis.location?.origin || DEFAULT_ORIGIN).origin; }
  catch (e) { /* file:// и т.п. — берём условный origin */ }
  const server = createServer(opts);
  const log = [];
  let seq = 0;
  let inflight = 0;
  let idleWaiters = [];
  const latencyRules = [];
  const failRules = [];
  const holds = [];
  const entryWaiters = [];

  // ---- задержки ----
  function setLatency(pathPattern, ms, method) {
    const key = pathPattern instanceof RegExp ? pathPattern.source + pathPattern.flags : String(pathPattern);
    const i = latencyRules.findIndex((r) => r.key === key && r.method === (method || null));
    if (i >= 0) latencyRules.splice(i, 1);
    if (ms) latencyRules.push({ key, method: method || null, ms, match: makeMatcher(pathPattern, method) });
  }
  const latencyFor = (entry) => {
    for (let i = latencyRules.length - 1; i >= 0; i--) if (latencyRules[i].match(entry)) return latencyRules[i].ms;
    return opts.latency || 0;
  };

  // ---- hold ----
  function hold(pathPattern, method) {
    const h = { match: makeMatcher(pathPattern, method), queue: [], waiters: [], active: true };
    holds.push(h);
    const deactivate = () => { h.active = false; const i = holds.indexOf(h); if (i >= 0) holds.splice(i, 1); };
    const notify = () => {
      h.waiters = h.waiters.filter((w) => {
        if (h.queue.length >= w.count) { clearTimeout(w.timer); w.resolve(h.queue[0].entry); return false; }
        return true;
      });
    };
    h.enter = (entry, signal) => new Promise((resolve, reject) => {
      const item = { entry, resolve, reject };
      h.queue.push(item);
      if (signal) {
        signal.addEventListener("abort", () => {
          const i = h.queue.indexOf(item);
          if (i >= 0) { h.queue.splice(i, 1); reject(new DOMException("The operation was aborted.", "AbortError")); }
        }, { once: true });
      }
      notify();
    });
    const take = (n) => (n === undefined ? h.queue.splice(0) : h.queue.splice(0, n));
    const handle = {
      get pending() { return h.queue.length; },
      get active() { return h.active; },
      get entries() { return h.queue.map((q) => q.entry); },
      // release() — отпустить все накопленные и снять удержание (следующие идут свободно);
      // release(n) — только n первых, удержание остаётся.
      release(n) {
        const items = take(n);
        if (n === undefined) deactivate();
        for (const it of items) it.resolve({ ok: true });
        return items.length;
      },
      // fail(status, detail) — ответить накопленным ошибкой; fail({status, detail, network}) — то же
      // объектом; в третьем аргументе {n, network} можно ограничить число запросов.
      fail(status = 500, detail, o = {}) {
        const spec = typeof status === "object" && status !== null ? status : { status, detail, ...o };
        const items = take(spec.n);
        if (spec.n === undefined) deactivate();
        for (const it of items) it.resolve({ fail: spec });
        return items.length;
      },
      waitForRequest(count = 1, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
          if (h.queue.length >= count) { resolve(h.queue[0].entry); return; }
          const w = { count, resolve };
          if (timeoutMs > 0) w.timer = setTimeout(() => {
            h.waiters = h.waiters.filter((x) => x !== w);
            reject(new Error(`fake-backend: hold — за ${timeoutMs} мс не накопилось запросов: ${count}`));
          }, timeoutMs);
          h.waiters.push(w);
        });
      },
      dispose() { const items = take(); deactivate(); for (const it of items) it.resolve({ ok: true }); },
    };
    h.handle = handle;
    return handle;
  }

  // ---- failNext ----
  function failNext(pathPattern, o = {}) {
    failRules.push({
      match: makeMatcher(pathPattern, o.method), remaining: o.times ?? 1, status: o.status ?? 500, detail: o.detail,
      network: !!o.network, rawBody: o.rawBody, contentType: o.contentType,
    });
  }
  function failureSpec(f) {
    if (f.rawBody !== undefined) return { status: f.status, rawBody: f.rawBody, contentType: f.contentType };
    return { status: f.status, json: { detail: f.detail === undefined ? defaultDetail(f.status) : f.detail } };
  }

  // ---- журнал ----
  const settle = (entry) => { entry.done = true; };
  function notifyEntry() {
    for (let i = entryWaiters.length - 1; i >= 0; i--) {
      const w = entryWaiters[i];
      if (log.filter(w.match).length >= w.count) { clearTimeout(w.timer); entryWaiters.splice(i, 1); w.resolve(log.filter(w.match)[w.count - 1]); }
    }
  }
  function notifyIdle() {
    if (inflight > 0) return;
    const ws = idleWaiters; idleWaiters = [];
    for (const w of ws) w();
  }

  function parseBody(rawBody) {
    if (rawBody === undefined || rawBody === null) return { body: undefined, form: null, jsonInvalid: false };
    if (typeof FormData === "function" && rawBody instanceof FormData) {
      const names = [], files = [];
      for (const [k, v] of rawBody.entries()) {
        names.push(k);
        if (v && typeof v === "object" && typeof v.name === "string") files.push(v.name);
      }
      return { body: { __form: [...names, ...files] }, form: rawBody, jsonInvalid: false };
    }
    if (typeof rawBody === "string") {
      try { return { body: JSON.parse(rawBody), form: null, jsonInvalid: false }; }
      catch (e) { return { body: { __raw: rawBody }, form: null, jsonInvalid: true }; }
    }
    return { body: { __raw: String(rawBody) }, form: null, jsonInvalid: false };
  }

  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  function raceAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
      promise.then(resolve, reject);
    });
  }

  async function run(entry, req, planned, heldBy, latency, signal, url) {
    await sleep(0);
    if (signal?.aborted) throw abortError();
    let decision = null;
    if (heldBy && heldBy.active) {
      entry.held = true;
      entry.released = false;
      decision = await raceAbort(heldBy.enter(entry, signal), signal);
      entry.released = true;
    }
    if (latency > 0) await raceAbort(sleep(latency), signal);
    const failure = decision && decision.fail ? decision.fail : planned;
    if (failure) {
      if (failure.network) { entry.status = 0; entry.error = "network"; throw new TypeError("Failed to fetch"); }
      const spec = failureSpec({ status: failure.status ?? 500, detail: failure.detail, rawBody: failure.rawBody, contentType: failure.contentType });
      entry.status = spec.status;
      return makeResponse(spec, url);
    }
    const spec = await server.handle(req);
    entry.status = spec.status;
    return makeResponse(spec, url);
  }

  function fakeFetch(input, init = {}) {
    let target = input;
    let method = init.method;
    if (typeof Request === "function" && input instanceof Request) { target = input.url; method = method || input.method; }
    const u = new URL(String(target && target.href ? target.href : target), origin + "/");
    method = String(method || "GET").toUpperCase();
    if (u.origin !== origin) {
      if (typeof opts.external === "function") return Promise.resolve(opts.external(u.href, init));
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    // Статика (JS/CSS самого стенда) — не API: отдаём настоящему fetch, в журнал не пишем.
    if (u.pathname.startsWith("/static/") && typeof originalFetch === "function") return originalFetch(input, init);

    const { body, form, jsonInvalid } = parseBody(init.body);
    const entry = {
      seq: ++seq, t: Date.now(), method, path: u.pathname + u.search, body, status: null, released: true,
      held: false, done: false,
    };
    log.push(entry);
    const planned = (() => {
      for (const r of failRules) if (r.remaining > 0 && r.match(entry)) { r.remaining--; return r; }
      return null;
    })();
    const heldBy = holds.find((h) => h.active && h.match(entry)) || null;
    const latency = latencyFor(entry);
    const req = { method, path: u.pathname, query: u.searchParams, body, form, jsonInvalid };
    inflight++;
    notifyEntry();
    return run(entry, req, planned, heldBy, latency, init.signal, u.href).then(
      (res) => { settle(entry); inflight--; notifyIdle(); return res; },
      (err) => { settle(entry); if (entry.status === null) entry.status = 0; inflight--; notifyIdle(); throw err; },
    );
  }
  fakeFetch.__fakeBackend = true;

  // ---- контроллер ----
  const ctl = {
    data: server.data,
    log,
    // Ошибки самого стенда (исключения внутри обработчиков) — пусто, если всё в порядке.
    get internalErrors() { return server.internalErrors; },
    uninstall() {
      if (globalThis.fetch === fakeFetch) globalThis.fetch = originalFetch;
      // Не оставляем зависшие запросы: удерживаемые падают как сетевой сбой.
      for (const h of [...holds]) h.handle.fail({ status: 0, network: true });
      if (globalThis.__fakeBackendCtl === ctl) delete globalThis.__fakeBackendCtl;
    },
    reset(overrides) {
      for (const h of [...holds]) h.handle.fail({ status: 0, network: true });
      latencyRules.length = 0; failRules.length = 0;
      log.length = 0; seq = 0;
      server.reset(overrides);
    },
    clearLog() { log.length = 0; },
    // Сколько запросов ОТПРАВЛЕНО (в журнале с момента вызова fetch, до ответа).
    // count("GET", "=/users") или count("=/users") — метод необязателен.
    count(method, pathPattern) {
      const [pattern, m] = splitMethodArg(method, pathPattern);
      return log.filter(makeMatcher(pattern, m)).length;
    },
    setLatency,
    hold,
    failNext,
    clearRules() { latencyRules.length = 0; failRules.length = 0; },
    setSession(active) { server.data.session.active = !!active; },
    // Войти под другим пользователем стенда (по id строки data.users).
    loginAs(userId) { server.data.session.userId = userId; server.data.session.active = true; server.data.mePatch = null; },
    setUser(patch) { server.data.mePatch = patch ? { ...(server.data.mePatch || {}), ...patch } : null; },
    setPermissions(patch, o = {}) {
      if (!patch) { server.data.permissionsPatch = null; return; }
      const prev = o.replace ? {} : (server.data.permissionsPatch || {});
      server.data.permissionsPatch = { ...prev, ...deepClone(patch),
        ...(patch.features ? { features: { ...(prev.features || {}), ...patch.features } } : {}) };
    },
    // Дождаться запроса в журнале (даже не отвеченного): waitFor("GET", "=/users", {count, timeout}).
    // Аргументы — как у count(): метод необязателен и может стоять первым.
    waitFor(a, b, { count = 1, timeout = 10000 } = {}) {
      const [pathPattern, method] = splitMethodArg(a, b);
      const match = makeMatcher(pathPattern, method);
      const have = log.filter(match);
      if (have.length >= count) return Promise.resolve(have[count - 1]);
      return new Promise((resolve, reject) => {
        const w = { match, count, resolve };
        if (timeout > 0) w.timer = setTimeout(() => {
          const i = entryWaiters.indexOf(w); if (i >= 0) entryWaiters.splice(i, 1);
          reject(new Error(`fake-backend: не дождались запроса ${method || ""} ${pathPattern}`));
        }, timeout);
        entryWaiters.push(w);
      });
    },
    // Дождаться, пока не останется запросов в полёте (удерживаемые hold тоже считаются).
    whenIdle() { return inflight === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)); },
  };
  globalThis.fetch = fakeFetch;
  globalThis.__fakeBackendCtl = ctl;
  return ctl;
}
