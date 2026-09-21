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

import { statusBatchBodyProblem, plannedBatchBodyProblem, contractSetBodyProblem, commentBodyProblem, historyEditBodyProblem, fieldsBodyProblem } from "./element-ops-rules.js";

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
  { id: "element.allocate", screen: "ws-picker", action: "Комплектовщик: распределение изделий одной позиции на контракт — одна пачка (запланированные → «Контрактация», прочие статусы сохраняются; всё или ничего)", method: "POST", path: re(`/contracts/\\d+/allocations`), check: allocationBodyProblem, risk: "рабочие данные, история статусов (не отменяется), остатки контракта", allowed: ALLOCATION_ENABLED, proof: "проверено на копии БД по HTTP (scripts/verify_allocation.py) и в браузере; остаток под блокировкой записи, конфликт вместо молчаливого сужения", why: "включается только вместе с исправлением backend (атомарность остатка, `app/allocation.py`); без него на сервере старого образца остаток при одновременных запросах не гарантирован" },
  { id: "block-work.plan", screen: "blocks", action: "ЗР: базовый срок (начало / конец)", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), onlyKeys: ["plan_start", "plan_end"], risk: "данные учёта по блокам", allowed: true, proof: "живая проверка: пусто → срок → пусто, SQL, журнал" },

  // ==== разрешённые операции по областям переноса: каждая область дописывает строки ТОЛЬКО в свой блок (меньше конфликтов слияния) ====
  // ==== область: model (прораб, модель ЖБИ, операции над элементами) ====
  // Все операции ниже выполняются в интерфейсе ТОЛЬКО из карточки выбранного изделия и панели группового выделения на схеме (element-ops.js);
  // права проверяет сервер (раздел и порог «запись» на объекте изделия), форма тела проверяется здесь (element-ops-rules.js).
  { id: "element.status.batch", screen: "element-ops", action: "Схема: смена статуса изделия или пачки — контракт СОХРАНЯЕТСЯ (клиент шлёт только ожидаемое состояние); предпросмотр последствий без записи; возврат на «Запланирован» снимает контракт и фактическую дату (последствия показываются и подтверждаются)", method: "POST", path: re(`/element-ops/status-batch`), check: statusBatchBodyProblem, risk: "рабочие данные, история статусов (не отменяется)", allowed: true, proof: "scripts/verify_element_ops.py (HTTP: предпросмотр, контракт сохраняется, подтверждение последствий, устаревшее состояние, права, повтор, конкуренция, откат, журнал) и браузер на настоящем backend (docs/v2-progress/model.md)" },
  { id: "element.planned.batch", screen: "element-ops", action: "Схема: плановая дата поставки изделия или пачки — одна дата (или снятие), сверка прежней даты, всё или ничего", method: "POST", path: re(`/element-ops/planned-date-batch`), check: plannedBatchBodyProblem, risk: "рабочие данные", allowed: true, proof: "scripts/verify_element_ops.py S10 и браузер на настоящем backend" },
  { id: "element.contract.set", screen: "element-ops", action: "Карточка изделия: назначить, сменить или снять контракт без смены статуса (со сверкой ожидаемого состояния и стражем остатка)", method: "POST", path: re(`/element-ops/contract`), check: contractSetBodyProblem, risk: "рабочие данные, остатки контракта", allowed: true, proof: "scripts/verify_element_ops.py S11 и браузер на настоящем backend" },
  { id: "element.comment", screen: "element-ops", action: "Карточка изделия: комментарий", method: "PATCH", path: re(`/elements/\\d+/comment`), check: commentBodyProblem, risk: "рабочие данные", allowed: true, proof: "браузер на настоящем backend; права раздела «Комментарий» проверяет сервер" },
  { id: "element.fields", screen: "element-ops", action: "Форма изделия: реквизиты (тип, подтип, марка, отметка, этаж, адрес, плановая дата, даты СМР) — только изменённые поля", method: "PATCH", path: re(`/elements/\\d+/fields`), check: fieldsBodyProblem, risk: "рабочие данные (ручная правка запоминается: переимпорт чертежа её не перезапишет)", allowed: true, proof: "браузер на настоящем backend; права раздела «Реквизиты элемента: запись» проверяет сервер" },
  { id: "element.history.edit", screen: "element-ops", action: "Карточка изделия: правка записи истории статусов (статус, момент, автор, комментарий; пересчёт текущего статуса)", method: "PATCH", path: re(`/elements/\\d+/history/\\d+`), check: historyEditBodyProblem, risk: "аудит истории статусов", allowed: true, proof: "браузер на настоящем backend; права раздела «История» проверяет сервер" },
  { id: "element.history.delete", screen: "element-ops", action: "Карточка изделия: удаление записи истории статусов (пересчёт текущего статуса, последнюю запись удалить нельзя)", method: "DELETE", path: re(`/elements/\\d+/history/\\d+`), risk: "аудит истории статусов (не отменяется)", allowed: true, proof: "браузер на настоящем backend; права раздела «История» проверяет сервер" },
  // ==== область: mfr (МФР, учёт по блокам, факт, сроки) ====
  // ==== область: picker (комплектовщик, контрагенты, договоры, спецификации, контракты, замена поставщика) ====
  // ==== область: admin (пользователи, роли, доступы, пароли, проекты и объекты, справочники, настройки) ====
  // ==== область: exchange (импорт, экспорт, документы, отчёты) ====

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
    if (r.check && r.check(body)) continue;                                            // тело не той формы, что проверена
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
