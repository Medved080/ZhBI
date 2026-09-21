// Центральное ограничение ИЗМЕНЯЮЩИХ операций экспериментального интерфейса (ограниченный выпуск V2, 2026-09-21).
//
// Зачем. V1 — основной интерфейс; V2 показывается заказчику для оценки и не проходил полной приёмки. Операции записи,
// которые не были проверены на настоящем backend (правильная цель и область, повторный клик, сохранение ввода при ошибке,
// повторное чтение результата, неизвестный исход без автоповтора), в V2 ОТКЛЮЧЕНЫ: их надо выполнять в текущем интерфейсе.
//
// Как. Единственная точка, через которую V2 отправляет запросы, — `api.js` (`request`); он вызывает `checkWrite` ДО `fetch`.
// Поэтому ограничение действует в обработчике действия, а не в разметке: Enter в поле, сохранение из диалога ухода,
// повторная отправка, любая новая кнопка — все идут через тот же вызов и получают отказ без сетевого запроса. Политика
// «запрещено всё, что не разрешено явно» (fail-closed): новая, не внесённая в таблицу операция по умолчанию отключена.
//
// Чем НЕ является. Это не защита данных на сервере и не замена прав доступа: серверная авторизация и проверки backend
// работают как прежде и на разрешённые операции тоже действуют. Ограничение — дополнительная защита от незавершённого UI.
// Ограничение относится ТОЛЬКО к V2 (модуль подключается из `app/static/v2/`), на штатные операции V1 не влияет.
//
// Таблица политики — единственный источник для проверки, для пояснений на экранах и для документа
// `Docs/v2-limited-release.md` (генерируется `scripts/gen_v2_write_policy.mjs`).

export const EXPERIMENTAL_NOTICE =
  "Экспериментальный интерфейс. Часть функций ещё дорабатывается. Непроверенные операции выполняйте в текущем интерфейсе";

const ID = "[^/]+";
const re = (s) => new RegExp("^" + s + "$");

// Распределение изделий на контракт (`POST /contracts/{id}/allocations`, одна серверная операция на пачку): включается ТОЛЬКО вместе с версией backend,
// где остаток проверяется под блокировкой записи (Docs/v2-workspaces.md, §9). Флаг — единственное место включения; общей настройки «разрешить» нет.
export const ALLOCATION_ENABLED = true;

// Жёсткая форма тела распределения (`POST /contracts/{id}/allocations`): объект, позиция (тип + марка) и пачка изделий с ожидаемым статусом; лишних полей нет.
export function allocationBodyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => !["object_id", "element_type", "mark", "items"].includes(k))) return "лишние поля";
  if (!Number.isInteger(body.object_id) || body.object_id <= 0) return "не указан объект";
  if (typeof body.element_type !== "string" || !body.element_type || !(body.mark === null || typeof body.mark === "string")) return "не указана позиция";
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) return "пачка пуста или больше 500";
  const seen = new Set();
  for (const it of body.items) {
    if (!it || typeof it !== "object" || Object.keys(it).some((k) => !["element_id", "expected_status"].includes(k))) return "лишние поля изделия";
    if (!Number.isInteger(it.element_id) || it.element_id <= 0 || typeof it.expected_status !== "string" || !it.expected_status) return "у изделия нет идентификатора или ожидаемого статуса";
    if (seen.has(it.element_id)) return "изделие повторяется";
    seen.add(it.element_id);
  }
  return null;
}

// allowed: true — операция разрешена (пройден барьер безопасности и есть проверка на настоящем backend);
// allowed: false — отключена, `why` — коротко почему; `onlyKeys` — разрешены только эти поля тела (остальные — отказ).
// risk: «личная» — своя настройка пользователя; «общая» — настройка, видимая всем пользователям (V1 тоже); «данные» — рабочие
// данные; «права/пароли» и т.п. — особо охраняемое.
// Проверка «на настоящем backend» — сокращённо в `proof`; полные записи — в `screens.json` (`checks`) и `Docs/v2-limited-release.md`.
export const POLICY = [
  // ---- разрешено ----
  { id: "auth.login", screen: "(вход)", action: "Вход в V2 тем же логином и паролем, что в V1", method: "POST", path: re("/login"), risk: "аутентификация, данные не меняет", allowed: true, proof: "тот же эндпоинт, что у V1 (пароль вводит человек)" },
  { id: "appearance.theme", screen: "appearance", action: "Смена личной цветовой гаммы", method: "PATCH", path: re(`/users/\\d+/ui-theme`), risk: "личная (общая для V1 и V2 у этого пользователя)", allowed: true, proof: "живая проверка: запись → SQL → возврат" },
  { id: "label-color.set", screen: "label-color", action: "Личный цвет подписей марок (сброс — null)", method: "PATCH", path: re(`/users/\\d+/label-color`), risk: "личная (V1 и V2)", allowed: true, proof: "живая проверка: запись → SQL → сброс" },
  { id: "changelog.ack", screen: "changelog", action: "Отметка «Ознакомился» в «Что нового»", method: "POST", path: re("/changelog/ack"), risk: "личная", allowed: true, proof: "живая проверка: запись → SQL" },
  { id: "smu.create", screen: "dict-smu", action: "СМУ: добавить запись", method: "POST", path: re("/smu"), risk: "общая (справочник)", allowed: true, proof: "живая проверка на синтетической записи" },
  { id: "smu.rename", screen: "dict-smu", action: "СМУ: переименовать", method: "PATCH", path: re(`/smu/\\d+`), risk: "общая (справочник)", allowed: true, proof: "живая проверка на синтетической записи" },
  { id: "smu.delete", screen: "dict-smu", action: "СМУ: удалить НЕиспользуемую запись (по плану последствий; с зависимостями — отказ)", method: "POST", path: re(`/dictionaries/smu/\\d+/delete`), risk: "общая, необратимо", allowed: true, proof: "живая проверка: удаление неиспользуемой, отказ для используемой" },
  { id: "card.save", screen: "project-card", action: "Карточка объекта: наименование, сроки, вехи (запись целой карточки)", method: "PUT", path: re("/settings/project-card"), risk: "данные объекта", allowed: true, proof: "живая проверка: SQL — JSON целиком, исходный восстановлен" },
  { id: "notes.save", screen: "report-notes", action: "События, задачи, вопросы: сохранить редакцию на дату", method: "PUT", path: re("/settings/report-notes"), onlyKeys: ["effective_date", "key_events", "key_tasks", "open_questions"], risk: "данные отчётов", allowed: true, proof: "живая проверка: новая редакция, отказ занятой даты" },
  { id: "notes.delete", screen: "report-notes", action: "События, задачи, вопросы: удалить редакцию (с подтверждением)", method: "DELETE", path: re(`/settings/report-notes/[0-9-]+`), risk: "данные отчётов, необратимо", allowed: true, proof: "живая проверка: удаление своей редакции" },
  { id: "subtype.add", screen: "subtypes", action: "Подтипы: добавить подтип типа элемента объекта", method: "POST", path: re("/allowed-subtypes"), risk: "общая (справочник объекта)", allowed: true, proof: "живая проверка на синтетической записи" },
  { id: "subtype.delete", screen: "subtypes", action: "Подтипы: удалить неиспользуемый (по плану; используемый — отказ)", method: "POST", path: re(`/dictionaries/subtype/${ID}/delete`), risk: "общая, необратимо", allowed: true, proof: "живая проверка: удаление и отказ для подтипа с 2021 изделием" },
  { id: "prefix.set", screen: "mark-prefixes", action: "Префиксы марок: добавить / заменить тип (с подтверждением)", method: "POST", path: re("/mark-type-prefixes"), risk: "общая (влияет на разбор марок при импорте)", allowed: true, proof: "живая проверка: добавление, замена, возврат" },
  { id: "prefix.delete", screen: "mark-prefixes", action: "Префиксы марок: удалить неиспользуемый", method: "POST", path: re(`/dictionaries/mark_prefix/${ID}/delete`), risk: "общая, необратимо", allowed: true, proof: "живая проверка: удаление через план" },
  { id: "late.threshold", screen: "late-threshold", action: "Порог опоздания поставки объекта", method: "PUT", path: re("/settings/info-plate"), onlyKeys: ["late_threshold_days"], risk: "общая для объекта", allowed: true, proof: "живая проверка: 0→2→0, SQL" },
  { id: "zone.colors", screen: "zone-colors", action: "Цвета кранов объекта (только изменённые)", method: "PUT", path: re("/zone-colors"), risk: "общая для объекта", allowed: true, proof: "живая проверка: цвет → SQL → возврат" },
  { id: "status.colors", screen: "status-colors", action: "Цвета статусов (только изменённые)", method: "PUT", path: re("/status-colors"), risk: "общая для всех (видна в V1)", allowed: true, proof: "живая проверка: цвет → SQL → возврат" },
  { id: "shape.set", screen: "marker-shapes", action: "Форма маркера по паре «слой / тип» (только изменённые)", method: "PUT", path: re("/element-shapes"), risk: "общая для всех (видна в V1)", allowed: true, proof: "живая проверка: контур→круг→контур, изменена одна строка" },
  { id: "revit.colors", screen: "mfr-colors", action: "Цветовая схема модели МФР объекта (целиком)", method: "PUT", path: re("/revit-plan/colors"), risk: "общая для объекта", allowed: true, proof: "живая проверка: запись, шаблон, возврат" },
  { id: "element.status", screen: "ws-model", action: "Схема: смена статуса ОДНОГО элемента (контракт не передаётся и сохраняется прежним; «Запланирован» не предлагается — возврат на него снимает контракт; дата/время и комментарий — по желанию)", method: "PATCH", path: re(`/elements/\\d+/status`), onlyKeys: ["status", "changed_at", "comment"], risk: "рабочие данные, история статусов (не отменяется)", allowed: true, proof: "живая проверка на настоящем backend: статус → SQL и история → схема; контракт не передаётся; повтор и сбой — без автоповтора" },
  { id: "element.allocate", screen: "ws-picker", action: "Комплектовщик: распределение изделий одной позиции на контракт — одна пачка (запланированные → «Контрактация», прочие статусы сохраняются; всё или ничего)", method: "POST", path: re(`/contracts/\\d+/allocations`), check: allocationBodyProblem, risk: "рабочие данные, история статусов (не отменяется), остатки контракта", allowed: ALLOCATION_ENABLED, proof: "проверено на копии БД по HTTP (scripts/verify_allocation.py) и в браузере; остаток под блокировкой записи, конфликт вместо молчаливого сужения", why: "включается только вместе с исправлением backend (атомарность остатка, `app/allocation.py`); без него на сервере старого образца остаток при одновременных запросах не гарантирован" },
  { id: "block-work.plan", screen: "blocks", action: "ЗР: базовый срок (начало / конец)", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), onlyKeys: ["plan_start", "plan_end"], risk: "данные учёта по блокам", allowed: true, proof: "живая проверка: пусто → срок → пусто, SQL, журнал" },

  // ==== разрешённые операции по областям переноса: каждая область дописывает строки ТОЛЬКО в свой блок (меньше конфликтов слияния) ====
  // ==== область: model (прораб, модель ЖБИ, операции над элементами) ====
  // ==== область: mfr (МФР, учёт по блокам, факт, сроки) ====
  // ==== область: picker (комплектовщик, контрагенты, договоры, спецификации, контракты, замена поставщика) ====
  // ==== область: admin (пользователи, роли, доступы, пароли, проекты и объекты, справочники, настройки) ====
  // ==== область: exchange (импорт, экспорт, документы, отчёты) ====
  // Загрузка файла — multipart (FormData): `check` видит поля формы и сам файл (расширение, размер) и параметры адреса. Разбор и проверки — на сервере, здесь
  // только форма запроса, которую проверили на настоящем backend (scripts/verify_exchange.py и живая проверка в браузере, Docs/v2-progress/exchange.md).
  { id: "import.contracting", screen: "contracting-import", action: "Импорт контрактации из XLSX в выбранный объект (контрагенты, договоры, спецификации, контракты, позиции)", method: "POST", path: re("/import-contracting-xlsx"), check: uploadCheck({ ext: ["xlsx"], query: { object_id: isIntStr } }), risk: "данные контрактации, одна транзакция (всё или ничего), копия базы перед загрузкой", allowed: true, proof: "настоящий backend: успех и повтор без дублей, отказ 403 у user2/user4, 422 на неверный файл, откат, журнал только после сохранения, двойной клик — один запрос" },
  { id: "import.schedule", screen: "schedule-import", action: "Импорт графика MS Project из XLSX (базовый — даты изделий; актуализированный — новая версия прогноза)", method: "POST", path: re("/import-schedule-xlsx"), check: uploadCheck({ ext: ["xlsx"], fields: { object_id: isIntStr, kind: isOneOf(["baseline", "current"]) } }), risk: "данные графика и даты изделий, копия базы перед загрузкой", allowed: true, proof: "настоящий backend: базовый и прогноз, отказ 403, 422 на неверный файл, откат, журнал после сохранения" },
  { id: "import.history", screen: "history-import", action: "Импорт истории статусов из XLSX по чертежу объекта (скорректировать / дополнить / заменить)", method: "POST", path: re("/import-history-xlsx"), check: uploadCheck({ ext: ["xlsx"], fields: { source_file: isNonEmpty, mode: isOneOf(["sync", "merge", "replace"]) } }), risk: "история статусов (режим «заменить» удаляет текущую историю сопоставленных изделий), копия базы перед загрузкой", allowed: true, proof: "настоящий backend: три режима, откат страж покрытия, отказ 403, журнал после сохранения" },
  { id: "status.restore", screen: "status-restore", action: "Восстановление статусов из выгрузки (режим «заменить» по чертежу объекта)", method: "POST", path: re("/import-history-xlsx"), check: uploadCheck({ ext: ["xlsx"], fields: { source_file: isNonEmpty, mode: isOneOf(["replace"]) } }), risk: "история статусов пересоздаётся по файлу, копия базы перед загрузкой", allowed: true, proof: "настоящий backend: замена истории по файлу, отказ 403, откат" },
  { id: "objects.analyze", screen: "objects-import", action: "Справочник объектов из Excel: сверка файла со справочником (ничего не пишет)", method: "POST", path: re("/objects-import/analyze"), check: uploadCheck({ ext: ["xlsx"] }), risk: "чтение (сверка), данные не меняются", allowed: true, proof: "настоящий backend: расхождения построчно, 422 на неверный файл, отказ 403" },
  { id: "objects.apply", screen: "objects-import", action: "Справочник объектов из Excel: применить отмеченные правки (создание объектов и проектов, правка реквизитов)", method: "POST", path: re("/objects-import/apply"), check: objectsApplyProblem, risk: "справочник объектов и проектов, одна транзакция, копия базы перед применением", allowed: true, proof: "настоящий backend: применение отмеченного, повтор без дублей, откат, отказ 403, журнал после сохранения" },
  { id: "bulk.analyze", screen: "bulk-edit", action: "Массовая правка через Excel: сверка файла с базой (ничего не пишет)", method: "POST", path: re("/elements/bulk-edit/analyze"), check: uploadCheck({ ext: ["xlsx"], fields: { mode: isOneOf(["fields", "statuses", "contracting"]) } }), risk: "чтение (сверка), данные не меняются", allowed: true, proof: "настоящий backend: расхождения по трём режимам, 400/422 на неверный файл, отказ 403" },
  { id: "bulk.apply", screen: "bulk-edit", action: "Массовая правка через Excel: применить отмеченные расхождения (реквизиты изделий / история статусов / контрактация)", method: "POST", path: re("/elements/bulk-edit/apply"), check: bulkApplyProblem, risk: "данные изделий, история статусов, контрактация; одна транзакция, копия базы перед применением", allowed: true, proof: "настоящий backend: применение отмеченного, откат при отказе стража, отказ 403, журнал после сохранения, устаревшая сверка не применяется" },

  // ---- временно отключено (справочно: для пояснений на экранах и для документа; всё, чего нет в списке, отключено тоже) ----
  { id: "block-work.forecast-note", screen: "blocks", action: "ЗР: версия прогноза и примечание", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), allowed: false, risk: "данные, необратимо (версии прогноза копятся и не отменяются)", why: "на настоящем backend не проверялись" },
  { id: "users.write", screen: "users-access", action: "Пользователи: создание и правка", method: "POST/PATCH", path: re(`/users(/\\d+)?`), allowed: false, risk: "права и учётные записи", why: "приёмка раздела не завершена" },
  { id: "users.password", screen: "users-access", action: "Задать пароль пользователю", method: "POST", path: re(`/users/\\d+/set-password`), allowed: false, risk: "пароли", why: "пароли выполняются только человеком в текущем интерфейсе" },
  { id: "users.access", screen: "users-access", action: "Доступ к проектам и объектам (выдача, снятие ролей)", method: "PUT", path: re(`/users/\\d+/access`), allowed: false, risk: "права", why: "приёмка раздела не завершена" },
  { id: "roles.write", screen: "users-access", action: "Роли и их права (создание, порядок, матрица, удаление)", method: "POST/PUT/DELETE", path: re(`/roles(/.+)?`), allowed: false, risk: "права", why: "приёмка раздела не завершена" },
  { id: "me.password", screen: "(вход)", action: "Обязательная смена пароля", method: "POST", path: re("/me/change-password"), allowed: false, risk: "пароли", why: "смена пароля — в текущем интерфейсе" },
  { id: "sessions.end", screen: "sessions", action: "Мои сеансы: завершение сеансов", method: "DELETE/POST", path: re(`/me/sessions(/.+)?`), allowed: false, risk: "вход на других устройствах", why: "на настоящем backend не проверялось (нет второго сеанса)" },
  { id: "individuals.write", screen: "dict-individuals", action: "Физлица: добавление, правка, удаление", method: "POST/PATCH", path: re(`/individuals(/\\d+)?|/dictionaries/individual/\\d+/delete`), allowed: false, risk: "персональные данные", why: "отдельно на настоящем backend не проверялись" },
  { id: "counterparties.write", screen: "counterparties", action: "Контрагенты, договоры, спецификации, контракты, привязки, плановая дата поставки", method: "POST/PATCH/PUT/DELETE", path: re(`/(counterparties|agreements|specifications|contracts|elements)(/.+)?|/dictionaries/(?!smu/|subtype/|mark_prefix/).+`), allowed: false, risk: "данные контрактации", why: "приёмка раздела не завершена" },
  { id: "projects.write", screen: "projects-objects", action: "Проекты и объекты: создание, правка, удаление, фото, вложения", method: "POST/PATCH/PUT/DELETE", path: re(`/(projects|objects|attachments)(/.+)?`), allowed: false, risk: "данные иерархии, удаление с зависимостями", why: "приёмка раздела не завершена" },
];

// ---- проверка ----
const ALLOWED = POLICY.filter((r) => r.allowed);

function bodyKeys(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
}

/** Можно ли отправить изменяющий запрос. Не бросает: возвращает {allowed, rule?, message?}. */
export function checkWrite(method, pathWithQuery, body) {
  const m = String(method || "").toUpperCase();
  const path = String(pathWithQuery || "").split("?")[0];
  for (const r of ALLOWED) {
    if (r.method !== m || !r.path.test(path)) continue;
    if (r.onlyKeys && !bodyKeys(body).every((k) => r.onlyKeys.includes(k))) continue; // поля вне разрешённой группы
    if (r.check && r.check(body, pathWithQuery)) continue;                             // тело (или форма загрузки) и адрес не той формы, что проверена
    return { allowed: true, rule: r };
  }
  const known = POLICY.find((r) => !r.allowed && r.path.test(path));
  return {
    allowed: false,
    rule: known || null,
    message: `Операция отключена в экспериментальном интерфейсе${known ? ` («${known.action}»)` : ""}. Выполните её в текущем интерфейсе.`,
  };
}

/** Отключённые операции экрана (для пояснения над содержимым). */
export function disabledForScreen(screenId) {
  return POLICY.filter((r) => !r.allowed && r.screen === screenId);
}

/** Есть ли у экрана хотя бы одна разрешённая операция записи (для меток «правка» и пояснений). */
export function hasAllowedWrites(screenId) {
  return ALLOWED.some((r) => r.screen === screenId);
}

/** Разрешённые операции экрана. */
export function allowedForScreen(screenId) {
  return POLICY.filter((r) => r.allowed && r.screen === screenId);
}

// Сообщение об отказе показывается модулем в его строке статуса; кроме того, оболочка слушает это событие и
// показывает то же пояснение над содержимым — на случай, если модуль отказ не отобразил.
export const BLOCKED_EVENT = "v2:write-blocked";
export function announceBlocked(result, method, path) {
  try {
    window.dispatchEvent(new CustomEvent(BLOCKED_EVENT, { detail: { message: result.message, method, path, rule: result.rule?.id || null } }));
  } catch (e) { /* уведомление вторично, отказ уже принят */ }
}

// ==== вспомогательные проверки области exchange: форма загрузки (multipart) и тела разбора/применения ====
// Объявлены как function (поднимаются в начало модуля), потому что строки POLICY выше вычисляются при загрузке модуля.

function isIntStr(v) { return typeof v === "string" && /^[1-9][0-9]{0,9}$/.test(v); }
function isNonEmpty(v) { return typeof v === "string" && v.trim() !== "" && v.length <= 500; }
function isOneOf(list) { return (v) => typeof v === "string" && list.includes(v); }

// Проверка формы загрузки: ровно один непустой файл разрешённого расширения (не больше лимита сервера), только перечисленные поля формы
// и параметры адреса (все обязательны). Возвращает функцию (body, pathWithQuery) → текст проблемы или null (в проверке — «проблема ⇒ отказ»).
function uploadCheck({ ext, fields = {}, query = {}, maxBytes = 200 * 1024 * 1024 }) {
  return (body, pathWithQuery) => {
    if (typeof FormData === "undefined" || !(body instanceof FormData)) return "не форма загрузки";
    const keys = [...new Set([...body.keys()])];
    if (keys.some((k) => k !== "file" && !(k in fields))) return "лишние поля формы";
    const files = body.getAll("file");
    if (files.length !== 1 || typeof files[0] !== "object" || files[0] === null || typeof files[0].name !== "string") return "нужен ровно один файл";
    const f = files[0];
    const e = (f.name.split(".").pop() || "").toLowerCase();
    if (!ext.includes(e)) return "неверное расширение файла";
    if (!(f.size > 0)) return "файл пуст";
    if (f.size > maxBytes) return "файл больше лимита сервера";
    for (const [k, valid] of Object.entries(fields)) {
      const vals = body.getAll(k);
      if (vals.length !== 1 || !valid(vals[0])) return `поле «${k}» не заполнено или неверно`;
    }
    const q = new URLSearchParams(String(pathWithQuery || "").split("?")[1] || "");
    const qkeys = [...new Set([...q.keys()])];
    if (qkeys.some((k) => !(k in query))) return "лишние параметры адреса";
    for (const [k, valid] of Object.entries(query)) {
      const vals = q.getAll(k);
      if (vals.length !== 1 || !valid(vals[0])) return `параметр «${k}» не задан или неверен`;
    }
    return null;
  };
}

// Применение справочника объектов: только `changes`; каждая правка — объект с известным видом. Ничего сверх этого сервер и не принимает.
function objectsApplyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => k !== "changes")) return "лишние поля";
  if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 5000) return "правок нет или больше 5000";
  const kinds = ["create", "update", "address_link"];
  for (const c of body.changes) {
    if (!c || typeof c !== "object" || Array.isArray(c) || !kinds.includes(c.kind) || typeof c.key !== "string" || !c.key.trim()) return "правка неверной формы";
  }
  return null;
}

// Применение массовой правки: `changes` (правки, как их вернула сверка), режим и — только для режима реквизитов — дата статуса «Контрактация».
function bulkApplyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => !["changes", "mode", "contracting_date"].includes(k))) return "лишние поля";
  if (!["fields", "statuses", "contracting"].includes(body.mode)) return "неизвестный режим";
  if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 100000) return "правок нет или больше 100000";
  if (body.changes.some((c) => !c || typeof c !== "object" || Array.isArray(c))) return "правка неверной формы";
  if (body.contracting_date != null && (body.mode !== "fields" || typeof body.contracting_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.contracting_date))) return "дата статуса неверна";
  return null;
}
