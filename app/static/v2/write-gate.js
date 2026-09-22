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

import {
  counterpartyBodyProblem, agreementBodyProblem, specificationBodyProblem, contractBodyProblem, plannedDateBodyProblem,
  contractingDeleteBodyProblem, supplierDocBodyProblem, supplierDocActionBodyProblem,
} from "./picker-gate.js";
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


// ---- формы тел операций области «МФР / учёт по блокам» (`check` возвращает текст проблемы или null; тело в запрос уходит только такой формы) ----
const isObj = (b) => b && typeof b === "object" && !Array.isArray(b);
const realDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "")); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const dateOrNull = (v) => v === null || realDate(v);
const hasRev = (b) => typeof b.expected_rev === "string" && b.expected_rev.length > 0;
// ЗР: правка ОДНОЙ группы полей (срок / прогноз / примечание) с отпечатком работы
export const blockWorkGroupProblem = (group) => (b) => {
  if (!isObj(b) || !hasRev(b)) return "нет отпечатка работы";
  if (group === "plan") return "plan_start" in b && "plan_end" in b && dateOrNull(b.plan_start) && dateOrNull(b.plan_end) ? null : "форма базового срока";
  if (group === "forecast") return "forecast_start" in b && "forecast_end" in b && dateOrNull(b.forecast_start) && dateOrNull(b.forecast_end) ? null : "форма прогноза";
  return typeof b.note === "string" && b.note.length <= 4000 ? null : "форма примечания";
};
const idsOk = (a, max = 2000) => Array.isArray(a) && a.length > 0 && a.length <= max && a.every((x) => Number.isInteger(x) && x > 0) && new Set(a).size === a.length;
export function blockWorksBulkProblem(b) {
  if (!isObj(b) || !idsOk(b.block_work_ids) || !isObj(b.expected)) return "нет набора работ или их отпечатков";
  if (!b.block_work_ids.every((i) => typeof b.expected[String(i)] === "string")) return "нет отпечатка у работы";
  if (b.op === "shift") return ["plan", "forecast"].includes(b.field) && Number.isInteger(b.days) && b.days !== 0 && Math.abs(b.days) <= 3650 ? null : "форма сдвига";
  return b.op === "forecast_equals_plan" && b.field === undefined && b.days === undefined ? null : "неизвестная операция";
}
export function blockSettingsProblem(b) {
  if (!isObj(b) || !Array.isArray(b.work_type_ids) || !b.work_type_ids.every((x) => Number.isInteger(x) && x > 0) || typeof b.expected !== "string") return "форма состава работ";
  return null;
}
export function blocksSettingsProblem(b) {
  if (!isObj(b) || !idsOk(b.block_ids) || !Array.isArray(b.work_type_ids) || !b.work_type_ids.every((x) => Number.isInteger(x) && x > 0) || !isObj(b.expected)) return "форма группового состава работ";
  return b.block_ids.every((i) => typeof b.expected[String(i)] === "string") ? null : "нет отпечатка блока";
}
export function factReportProblem(b) {
  if (!isObj(b) || !realDate(b.report_date) || !isObj(b.items) || !Object.keys(b.items).length) return "форма документа факта";
  return Object.entries(b.items).every(([k, v]) => /^\d+$/.test(k) && Number.isInteger(v) && v >= 0 && v <= 100) ? null : "процент вне 0..100";
}
export const factReportUpdateProblem = (b) => factReportProblem(b) || (hasRev(b) ? null : "нет отпечатка документа");
export function chessBatchProblem(b) {
  if (!isObj(b) || !realDate(b.report_date) || typeof b.track_code !== "string" || !b.track_code || typeof b.idempotency_key !== "string" || b.idempotency_key.length < 8) return "форма пакета";
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 2000) return "пакет пуст или слишком велик";
  return b.items.every((i) => isObj(i) && Number.isInteger(i.block_id) && Number.isInteger(i.work_type_id) && Number.isInteger(i.percent) && i.percent >= 0 && i.percent <= 100 && Number.isInteger(i.expected_percent) && Object.keys(i).length === 4) ? null : "строка пакета";
}
const BULK_FIELDS = ["percent", "plan_start", "plan_end", "forecast_start", "forecast_end"];
export function strictApplyProblem(b) {
  if (!isObj(b) || !Array.isArray(b.changes) || !b.changes.length || b.changes.length > 20000) return "форма набора изменений";
  return b.changes.every((c) => isObj(c) && Number.isInteger(c.bw_id) && BULK_FIELDS.includes(c.field) && "was" in c && "now" in c) ? null : "строка изменения";
}

// ---- формы тел операций справочников «Марки» и «Зоны» ----
function markBodyProblem(b) {
  if (!isObj(b) || Object.keys(b).some((k) => !["object_id", "element_type", "name"].includes(k))) return "лишние поля";
  if (!Number.isInteger(b.object_id) || b.object_id <= 0) return "не указан объект";
  if (typeof b.element_type !== "string" || !b.element_type) return "не указан тип элемента";
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) return "название марки пусто или слишком длинно";
  return null;
}
const isTransferToken = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
function dbTransferApplyProblem(b) {
  if (!isObj(b) || Object.keys(b).some((k) => !["token", "confirm"].includes(k))) return "лишние поля";
  if (!isTransferToken(b.token)) return "нет идентификатора загруженного снимка";
  if (typeof b.confirm !== "string" || !b.confirm.trim() || b.confirm.length > 50) return "не введено кодовое слово";
  return null;
}
function dbTransferForgetProblem(b) {
  if (!isObj(b) || Object.keys(b).some((k) => k !== "token")) return "лишние поля";
  return isTransferToken(b.token) ? null : "нет идентификатора загруженного снимка";
}
function fillScopeApplyProblem(b) {
  if (!isObj(b) || Object.keys(b).some((k) => !["project_id", "object_id", "keys"].includes(k))) return "лишние поля";
  if (!(b.project_id === null || (Number.isInteger(b.project_id) && b.project_id > 0))) return "неверный проект";
  if (!(b.object_id === null || (Number.isInteger(b.object_id) && b.object_id > 0))) return "неверный объект";
  if (!Array.isArray(b.keys) || !b.keys.length || !b.keys.every((k) => typeof k === "string" && k)) return "не выбрано ни одного справочника";
  return null;
}
function boolMapProblem(b) {
  if (!isObj(b)) return "тело не объект";
  if (!Object.keys(b).length) return "нет изменённых строк";
  if (!Object.values(b).every((v) => typeof v === "boolean")) return "значение не да/нет";
  return null;
}
function zoneBodyProblem(b) {
  if (!isObj(b) || Object.keys(b).some((k) => !["number", "name", "parent_zone_id", "levels"].includes(k))) return "лишние поля";
  if (!(b.number === null || b.number === undefined || Number.isInteger(b.number))) return "номер не целое число";
  if (!(b.name === null || b.name === undefined || typeof b.name === "string")) return "неверное наименование";
  if (!(b.parent_zone_id === null || b.parent_zone_id === undefined || (Number.isInteger(b.parent_zone_id) && b.parent_zone_id > 0))) return "неверный кран-владелец";
  if (!Array.isArray(b.levels) || !b.levels.length) return "у зоны должен быть хотя бы один ярус";
  for (const l of b.levels) {
    if (!isObj(l) || !("id" in l) || !("elevation_mm" in l) || !("outline" in l)) return "ярус неверной формы";
    if (!(l.id === null || Number.isInteger(l.id))) return "ярус: неверный идентификатор";
    if (!(l.elevation_mm === null || Number.isInteger(l.elevation_mm))) return "ярус: неверная отметка";
    if (!Array.isArray(l.outline) || l.outline.length < 3) return "ярус: контур короче трёх точек";
    if (!l.outline.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))) return "ярус: точка контура не пара чисел";
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
  { id: "min-label-px.set", screen: "appearance", action: "Личный минимальный размер подписей на схеме", method: "PATCH", path: re(`/users/\\d+/min-label-px`), onlyKeys: ["min_label_px"], risk: "личная (общая для V1 и V2 у этого пользователя)", allowed: true, proof: "HTTP+браузер: запись → SQL → возврат, отказ вне диапазона 400, 403 на чужого пользователя" },
  { id: "view3d.set", screen: "appearance", action: "Личный начальный ракурс 3D (подъём и поворот камеры)", method: "PATCH", path: re(`/users/\\d+/view3d`), onlyKeys: ["view3d_pitch_deg", "view3d_yaw_deg"], risk: "личная (общая для V1 и V2 у этого пользователя)", allowed: true, proof: "HTTP+браузер: запись → SQL → возврат, отказ вне диапазона 400, поворот приводится к ±180°, 403 на чужого пользователя" },
  { id: "label-visibility.set", screen: "label-visibility", action: "Видимость подписей марок по типу — настройка объекта по умолчанию (только изменённые строки)", method: "PUT", path: re("/label-visibility"), check: boolMapProblem, risk: "общая для объекта (видна и в V1)", allowed: true, proof: "HTTP+браузер: запись → SQL → возврат, 403 без права" },
  { id: "label-dates-visibility.set", screen: "label-visibility", action: "Видимость дат в допстроке подписи по типу — настройка объекта по умолчанию (только изменённые строки)", method: "PUT", path: re("/label-dates-visibility"), check: boolMapProblem, risk: "общая для объекта (видна и в V1)", allowed: true, proof: "HTTP+браузер: запись → SQL → возврат, 403 без права" },
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
  { id: "block-work.plan", screen: "blocks", action: "ЗР: базовый срок (начало / конец) — с отпечатком работы (конкуренция проверяется сервером)", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), onlyKeys: ["plan_start", "plan_end", "expected_rev"], check: blockWorkGroupProblem("plan"), risk: "данные учёта по блокам", allowed: true, proof: "браузер и HTTP на настоящем backend (scripts/verify_mfr_ops.py): срок → SQL → журнал; 409 при устаревшем отпечатке; 403 у чтения" },
  { id: "block-work.forecast", screen: "blocks", action: "ЗР: новая версия прогноза (версии копятся и не отменяются; перед записью — подтверждение)", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), onlyKeys: ["forecast_start", "forecast_end", "expected_rev"], check: blockWorkGroupProblem("forecast"), risk: "данные, необратимо (версии прогноза копятся)", allowed: true, proof: "браузер и HTTP на настоящем backend: версия +1 в block_work_forecasts, журнал, 409, 403" },
  { id: "block-work.note", screen: "blocks", action: "ЗР: примечание", method: "PATCH", path: re(`/objects/\\d+/block-works/\\d+`), onlyKeys: ["note", "expected_rev"], check: blockWorkGroupProblem("note"), risk: "данные учёта по блокам", allowed: true, proof: "браузер и HTTP на настоящем backend: запись → SQL, 409, 403" },
  { id: "block-work.bulk", screen: "blocks", action: "ЗР: групповая правка сроков (сдвиг плана/прогноза; прогноз = план) — только по предпросмотру, с отпечатками работ, одна транзакция", method: "PUT", path: re(`/objects/\\d+/block-works/bulk`), onlyKeys: ["block_work_ids", "op", "field", "days", "expected"], check: blockWorksBulkProblem, risk: "данные, версии прогноза необратимы", allowed: true, proof: "HTTP и браузер: предпросмотр = результат; 409 при чужой правке; откат целиком; два вызова одновременно; журнал" },
  { id: "block-settings.set", screen: "blocks", action: "Состав работ блока (ЗР): добавить / снять (с историей — мягко) — по предпросмотру, с отпечатком состава", method: "PUT", path: re(`/objects/\\d+/blocks/\\d+/work-types-settings`), onlyKeys: ["work_type_ids", "expected"], check: blockSettingsProblem, risk: "данные учёта по блокам", allowed: true, proof: "браузер и HTTP на настоящем backend: мягкое снятие при факте/сроках, удаление пустой ЗР, возврат снятой, 409, 403" },
  { id: "block-settings.group", screen: "blocks", action: "Состав работ ГРУППЫ блоков — по предпросмотру, все блоки одной транзакцией (всё или ничего)", method: "PUT", path: re(`/objects/\\d+/blocks/work-types-settings`), onlyKeys: ["block_ids", "work_type_ids", "expected"], check: blocksSettingsProblem, risk: "данные, групповая операция", allowed: true, proof: "HTTP и браузер: атомарность (отказ на блоке — откат всех), 409, два вызова одновременно, журнал одним событием" },
  { id: "fact.create", screen: "fact-journal", action: "Факт: новый документ на дату (проценты по работам блока)", method: "POST", path: re(`/objects/\\d+/blocks/\\d+/fact-reports`), onlyKeys: ["report_date", "items"], check: factReportProblem, risk: "данные факта (документ на дату)", allowed: true, proof: "браузер и HTTP на настоящем backend: документ и строки в SQL, проценты после перезагрузки, 403, валидация" },
  { id: "fact.update", screen: "fact-journal", action: "Факт: исправить документ (с отпечатком документа; построчная история правок пишется сервером)", method: "PUT", path: re(`/objects/\\d+/blocks/\\d+/fact-reports/\\d+`), onlyKeys: ["report_date", "items", "expected_rev"], check: factReportUpdateProblem, risk: "данные факта", allowed: true, proof: "браузер и HTTP: правка → SQL, work_fact_item_history, 409 при чужой правке, 403" },
  { id: "fact.delete", screen: "fact-journal", action: "Факт: удалить документ целиком (необратимо; по подтверждению с последствиями, с отпечатком документа)", method: "DELETE", path: re(`/objects/\\d+/blocks/\\d+/fact-reports/\\d+`), check: (b, q) => (/(^|&)expected_rev=[0-9a-f]{12}(&|$)/.test(q) ? null : "нет отпечатка документа"), risk: "данные факта, необратимо", allowed: true, proof: "браузер и HTTP: удаление → SQL (документ, строки, история), журнал block_fact_report_delete, 409, 403" },
  { id: "chess.batch", screen: "chess-flat", action: "Шахматка: пакетный ввод факта по нескольким блокам (одна транзакция, ключ идемпотентности, сверка «ожидалось»)", method: "POST", path: re(`/objects/\\d+/blocks/chess-flat-batch`), onlyKeys: ["report_date", "track_code", "idempotency_key", "items"], check: chessBatchProblem, risk: "данные факта, групповая операция", allowed: true, proof: "HTTP и браузер: пакет целиком, повтор с тем же ключом, 409 при чужой правке, два пакета одновременно, откат целиком" },
  { id: "bulk-edit.analyze", screen: "blk-bulk", action: "Excel-правка ЗР: сверка загруженного файла с базой (ничего не пишет)", method: "POST", path: re(`/objects/\\d+/block-works/bulk-edit/analyze`), risk: "чтение (загрузка файла для сверки)", allowed: true, proof: "HTTP и браузер: сверка на копии, БД до/после не изменилась" },
  { id: "bulk-edit.apply", screen: "blk-bulk", action: "Excel-правка ЗР: применить отмеченное — «всё или ничего», по сверке, с проверкой изменившегося после сверки", method: "POST", path: re(`/objects/\\d+/block-works/bulk-edit/apply-strict`), onlyKeys: ["changes"], check: strictApplyProblem, risk: "данные, групповая операция, версии прогноза необратимы", allowed: true, proof: "HTTP и браузер: применение → SQL; 409 при изменении после сверки; откат целиком при отказе внутри пачки; два вызова одновременно" },
  // ==== область: picker (комплектовщик, контрагенты, договоры, спецификации, контракты, замена поставщика) ====
  // Контрактация: у каждой операции своя строка и жёсткая форма тела (picker-gate.js). Серверные права — как в V1 (require_contracting /
  // assert_object_feature); правка записи целиком проверяет версию, которую видел человек (`expected_version`, app/record_version.py).
  { id: "counterparty.create", screen: "counterparties", action: "Контрагенты: создать контрагента (наименования, реквизиты, код, нормативы производительности)", method: "POST", path: re("/counterparties"), check: counterpartyBodyProblem, risk: "общий справочник", allowed: true, proof: "scripts/picker_verify/cp.mjs на копии БД: успех и SQL после перезагрузки, 403 у роли view, валидация, двойной клик, обрыв сети, журнал" },
  { id: "counterparty.update", screen: "counterparties", action: "Контрагенты: правка карточки контрагента целиком (с проверкой версии записи)", method: "PATCH", path: re(`/counterparties/\\d+`), check: counterpartyBodyProblem, risk: "общий справочник", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, конфликт устаревших данных, 403, обрыв сети; scripts/verify_picker_backend.py: гонка двух правок" },
  { id: "agreement.create", screen: "counterparties", action: "Договоры: создать договор контрагента на объект", method: "POST", path: re("/agreements"), check: agreementBodyProblem, risk: "данные контрактации", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, дубль номера, 403 на чужой объект" },
  { id: "agreement.update", screen: "counterparties", action: "Договоры: правка договора (номер, дата, объект; с проверкой версии)", method: "PATCH", path: re(`/agreements/\\d+`), check: agreementBodyProblem, risk: "данные контрактации", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, конфликт устаревших данных; объект с чужими изделиями — отказ сервера" },
  { id: "specification.create", screen: "counterparties", action: "Спецификации: создать спецификацию договора", method: "POST", path: re("/specifications"), check: specificationBodyProblem, risk: "данные контрактации", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, дубль номера (400)" },
  { id: "specification.update", screen: "counterparties", action: "Спецификации: правка спецификации (номер, дата; с проверкой версии)", method: "PATCH", path: re(`/specifications/\\d+`), check: specificationBodyProblem, risk: "данные контрактации", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, конфликт устаревших данных" },
  { id: "contract.create", screen: "counterparties", action: "Контракты: создать контракт под спецификацией (тема, позиции, инциденты, нормативы)", method: "POST", path: re("/contracts"), check: contractBodyProblem, risk: "данные контрактации", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех, повтор позиции (400, откат), 403, двойной клик" },
  { id: "contract.update", screen: "counterparties", action: "Контракты: правка контракта целиком — позиции и количество (не ниже привязанного), инциденты, архив, нормативы (с проверкой версии, под блокировкой записи и стражем покрытия)", method: "PATCH", path: re(`/contracts/\\d+`), check: contractBodyProblem, risk: "данные контрактации, остатки контракта", allowed: true, proof: "scripts/picker_verify/cp.mjs: количество ниже привязанного — отказ стража без изменений, конфликт версий; scripts/verify_contract_guard_concurrency.py, verify_lock_release.py" },
  { id: "element.planned-date", screen: "counterparties", action: "Развёрнутый контракт: плановая дата поставки ОДНОГО изделия (дата или очистка)", method: "PATCH", path: re(`/elements/\\d+/planned-delivery-date`), onlyKeys: ["planned_delivery_date"], check: plannedDateBodyProblem, risk: "рабочие данные (дата), журнал", allowed: true, proof: "scripts/picker_verify/cp.mjs: успех и SQL, очистка, 403 без права planned_date, неверная дата не уходит в сеть" },
  { id: "counterparty.delete", screen: "counterparties", action: "Контрагенты: удалить контрагента по плану последствий (с договорами, спецификациями, контрактами; ссылки — только на замену)", method: "POST", path: re(`/dictionaries/counterparty/\\d+/delete`), check: contractingDeleteBodyProblem, risk: "общая, необратимо", allowed: true, proof: "scripts/picker_verify/cp.mjs: предпросмотр, удаление, отказ при ссылках без замены, замена с переносом, полный откат" },
  { id: "agreement.delete", screen: "counterparties", action: "Договоры: удалить договор по плану последствий", method: "POST", path: re(`/dictionaries/agreement/\\d+/delete`), check: contractingDeleteBodyProblem, risk: "общая, необратимо", allowed: true, proof: "scripts/picker_verify/cp.mjs" },
  { id: "specification.delete", screen: "counterparties", action: "Спецификации: удалить спецификацию по плану последствий", method: "POST", path: re(`/dictionaries/specification/\\d+/delete`), check: contractingDeleteBodyProblem, risk: "общая, необратимо", allowed: true, proof: "scripts/picker_verify/cp.mjs" },
  { id: "contract.delete", screen: "counterparties", action: "Контракты: удалить контракт с переносом изделий и истории на выбранный контракт-замену", method: "POST", path: re(`/dictionaries/contract/\\d+/delete`), check: contractingDeleteBodyProblem, risk: "общая, необратимо, привязки изделий", allowed: true, proof: "scripts/picker_verify/cp.mjs: замена, отказ стража, откат, конфликт, обрыв ответа" },
  // Документы контрактации: «Замена поставщика» и «Обмен привязками» (перепривязка контракта у изделий; НЕ «смена планируемого поставщика» — такой сущности нет, Docs/v2-workspaces.md §9в)
  { id: "supplier-doc.create", screen: "supplier-change", action: "Документы контрактации: создать черновик «Замены поставщика» или «Обмена привязками» (данные изделий не меняет)", method: "POST", path: re("/supplier-changes"), check: supplierDocBodyProblem, risk: "документ (черновик)", allowed: true, proof: "scripts/picker_verify/docs.mjs на копии БД" },
  { id: "supplier-doc.update", screen: "supplier-change", action: "Документы контрактации: правка ЧЕРНОВИКА (шапка и состав; с проверкой версии документа)", method: "PATCH", path: re(`/supplier-changes/\\d+`), check: supplierDocBodyProblem, risk: "документ (черновик)", allowed: true, proof: "scripts/picker_verify/docs.mjs; scripts/verify_picker_backend.py: правка ↔ проведение под блокировкой" },
  { id: "supplier-doc.delete", screen: "supplier-change", action: "Документы контрактации: удалить черновик (проведённый не удаляется)", method: "DELETE", path: re(`/supplier-changes/\\d+`), risk: "документ, необратимо", allowed: true, proof: "scripts/picker_verify/docs.mjs; scripts/verify_picker_backend.py: удаление ↔ проведение под блокировкой" },
  { id: "supplier-doc.post", screen: "supplier-change", action: "Документы контрактации: ПРОВЕСТИ документ — переносит привязки изделий (всё или ничего; остаток проверяет страж «до/после»)", method: "POST", path: re(`/supplier-changes/\\d+/post`), onlyKeys: ["expected_version"], check: supplierDocActionBodyProblem, risk: "рабочие данные: привязки изделий, история; отменяется отдельным действием", allowed: true, proof: "scripts/picker_verify/docs.mjs: перенос и SQL, отказ при нехватке остатка без изменений, конфликт версии, двойной клик, обрыв ответа; verify_contract_guard_concurrency.py (S3)" },
  { id: "supplier-doc.unpost", screen: "supplier-change", action: "Документы контрактации: ОТМЕНИТЬ проведение — возвращает привязки, плановые даты и историю изделий как до документа", method: "POST", path: re(`/supplier-changes/\\d+/unpost`), onlyKeys: ["expected_version"], check: supplierDocActionBodyProblem, risk: "рабочие данные: привязки изделий, история", allowed: true, proof: "scripts/picker_verify/docs.mjs: возврат и SQL (включая историю и плановые даты обмена), конфликт версии, двойной клик" },
  // ==== область: admin (пользователи, роли, доступы, пароли, проекты и объекты, справочники, настройки) ====
  // -- пользователи, пароли, доступ, роли, сеансы (2026-09-21; проверено на настоящем backend и входе, scripts/verify_admin_backend.py + scripts/verify_admin_ui.mjs) --
  { id: "auth.logout", screen: "(вход)", action: "Выход из системы (завершает свой сеанс)", method: "POST", path: re("/logout"), risk: "свой сеанс", allowed: true, proof: "HTTP+браузер: сеанс удалён на сервере, повторный запрос 401" },
  // -- справочники «Физлица», «Проекты и объекты» (проверено: scripts/verify_admin_backend.py, scripts/verify_admin_ui.mjs) --
  { id: "individuals.create", screen: "dict-individuals", action: "Физлица: добавить запись", method: "POST", path: re("/individuals"), onlyKeys: ["name"], risk: "общая (справочник, персональные данные)", allowed: true, proof: "HTTP+браузер: успех, дубль 409, пустое 400, 403 без права, журнал" },
  { id: "individuals.rename", screen: "dict-individuals", action: "Физлица: переименовать", method: "PATCH", path: re(`/individuals/\\d+`), onlyKeys: ["name"], risk: "общая (справочник, персональные данные)", allowed: true, proof: "HTTP+браузер: успех, дубль 409, 404, 403" },
  { id: "individuals.delete", screen: "dict-individuals", action: "Физлица: удалить НЕиспользуемую запись (по плану; с зависимостями — отказ, замена в V1)", method: "POST", path: re(`/dictionaries/individual/\\d+/delete`), onlyKeys: ["replacements", "mode"], risk: "общая, необратимо", allowed: true, proof: "HTTP+браузер: удаление неиспользуемой, отказ для используемой, повтор 404" },
  // -- справочники «Марки», «Зоны» (2026-09-22; проверено на настоящем backend, scripts/verify_admin2_backend.py + браузер) --
  { id: "mark.create", screen: "subtypes", action: "Марки: создание", method: "POST", path: re("/marks"), onlyKeys: ["object_id", "element_type", "name"], check: markBodyProblem, risk: "общая (справочник объекта)", allowed: true, proof: "HTTP+браузер: успех, дубль 409, пустое 422, 403" },
  { id: "mark.rename", screen: "subtypes", action: "Марки: переименование — текст марки переносится у изделий и в позициях контрактов (план последствий и подтверждение — в интерфейсе, перед отправкой)", method: "PATCH", path: re(`/marks/\\d+`), onlyKeys: ["object_id", "element_type", "name"], check: markBodyProblem, risk: "общая (справочник объекта), рабочие данные (текст марки у изделий и позиций контрактов)", allowed: true, proof: "HTTP+браузер: успех и перенос текста у изделий/позиций, дубль 409, 404, 403" },
  { id: "mark.delete", screen: "subtypes", action: "Марки: удаление записи с заменой ссылок (по плану последствий)", method: "POST", path: re(`/dictionaries/mark/\\d+/delete`), onlyKeys: ["replacements", "mode"], risk: "общая, необратимо, рабочие данные (переносит ссылки у изделий и позиций контрактов)", allowed: true, proof: "HTTP+браузер: план, замена, откат при отказе, отказ без выбранной замены, 403" },
  { id: "zone.update", screen: "zones", action: "Зоны: правка (номер, наименование, кран-владелец, геометрия ярусов; пересчёт привязки элементов — автоматически на сервере)", method: "PATCH", path: re(`/zones/\\d+`), check: zoneBodyProblem, risk: "рабочие данные (геометрия зоны и привязка изделий к зонам)", allowed: true, proof: "HTTP+браузер: успех и пересчёт привязки, отказ валидации (самопересечение, дубль номера), 403" },
  { id: "zone.undo", screen: "zones", action: "Зоны: откат последней правки целиком (реквизиты, геометрия, привязки изделий, которые задел пересчёт)", method: "POST", path: re(`/zones/\\d+/undo`), risk: "рабочие данные, необратимо после следующей правки", allowed: true, proof: "HTTP+браузер: откат и восстановление привязок, отказ «нечего отменять» 409, 403" },
  { id: "zone.delete", screen: "zones", action: "Зоны: удаление записи с заменой ссылок (по плану последствий)", method: "POST", path: re(`/dictionaries/zone/\\d+/delete`), onlyKeys: ["replacements", "mode"], risk: "общая, необратимо, рабочие данные (переносит привязку изделий)", allowed: true, proof: "HTTP+браузер: план, замена, откат при отказе, 403" },
  { id: "projects.create", screen: "projects-objects", action: "Проекты: создание", method: "POST", path: re("/projects"), onlyKeys: ["name", "status", "description", "address", "address_note", "address_code", "address_source", "address_region", "address_parts", "postal_code", "lat", "lon"], risk: "данные иерархии", allowed: true, proof: "HTTP+браузер: успех и перезагрузка, пустое/дубль, 403, журнал" },
  { id: "projects.update", screen: "projects-objects", action: "Проекты: правка (с проверкой «запись устарела»)", method: "PATCH", path: re(`/projects/\\d+`), onlyKeys: ["name", "status", "description", "address", "address_note", "address_code", "address_source", "address_region", "address_parts", "postal_code", "lat", "lon", "expected_version"], check: (b) => (typeof b?.expected_version === "string" ? null : "нет версии записи"), risk: "данные иерархии", allowed: true, proof: "HTTP+браузер: успех, устаревшая версия 409 без записи, архивация проекта с активными объектами отказ, 403" },
  { id: "projects.delete", screen: "projects-objects", action: "Проекты: удаление ПУСТОГО проекта (план последствий, подтверждение вводом названия)", method: "POST", path: re(`/dictionaries/project/\\d+/delete`), onlyKeys: ["replacements", "mode"], risk: "данные иерархии, необратимо", allowed: true, proof: "HTTP+браузер: удаление пустого, отказ для проекта с объектами (без изменений), повтор 404, обрыв ответа, 403" },
  { id: "objects.create", screen: "projects-objects", action: "Объекты: создание", method: "POST", path: re("/objects"), onlyKeys: ["name", "project_id", "status", "description", "kind", "smu_id", "smu_director_id", "responsible_id", "smr_start_reported", "media_url", "address", "address_note", "address_code", "address_source", "address_region", "address_parts", "postal_code", "lat", "lon"], risk: "данные иерархии", allowed: true, proof: "HTTP+браузер: успех и перезагрузка, пустое/дубль/чужой проект, 403, журнал" },
  { id: "objects.update", screen: "projects-objects", action: "Объекты: правка (с проверкой «запись устарела»)", method: "PATCH", path: re(`/objects/\\d+`), onlyKeys: ["name", "project_id", "status", "description", "kind", "smu_id", "smu_director_id", "responsible_id", "smr_start_reported", "media_url", "address", "address_note", "address_code", "address_source", "address_region", "address_parts", "postal_code", "lat", "lon", "expected_version"], check: (b) => (typeof b?.expected_version === "string" ? null : "нет версии записи"), risk: "данные иерархии", allowed: true, proof: "HTTP+браузер: успех, устаревшая версия 409 без записи, перенос в другой проект, 403" },
  { id: "objects.delete", screen: "projects-objects", action: "Объекты: удаление ПУСТОГО объекта (план последствий, подтверждение вводом названия)", method: "POST", path: re(`/dictionaries/object/\\d+/delete`), onlyKeys: ["replacements", "mode"], risk: "данные иерархии, необратимо", allowed: true, proof: "HTTP+браузер: удаление пустого со всем каскадом, отказ для объекта с данными (без изменений), повтор 404, 403" },
  { id: "objects.avatar", screen: "projects-objects", action: "Объекты: превью (фото) из приложенного изображения", method: "PUT", path: re(`/objects/\\d+/avatar`), onlyKeys: ["attachment_id"], risk: "данные объекта", allowed: true, proof: "HTTP+браузер: назначить, снять, не изображение 400, чужое вложение 404, 403" },
  { id: "attachments.add", screen: "projects-objects", action: "Вложения проекта и объекта: приложить файл", method: "POST", path: re("/attachments"), risk: "данные, файлы на сервере", allowed: true, proof: "HTTP+браузер: успех и перезагрузка, слишком большой/запрещённый тип отказ, 403" },
  { id: "attachments.delete", screen: "projects-objects", action: "Вложения проекта и объекта: удалить", method: "DELETE", path: re(`/attachments/\\d+`), risk: "данные, необратимо", allowed: true, proof: "HTTP+браузер: удаление и файл на диске, повтор 404, 403" },
  // -- служебные операции администратора (проверено: scripts/verify_admin_backend.py, scripts/verify_admin_ui.mjs) --
  { id: "reset.history", screen: "reset-history", action: "Очистить историю статусов ВСЕХ элементов (предпросмотр, копия перед сбросом, подтверждение словом; число записей из предпросмотра передаётся серверу)", method: "POST", path: re("/admin/reset-status-history"), risk: "данные всех объектов, необратимо", allowed: true, proof: "HTTP+браузер: предпросмотр, устаревший предпросмотр 409, откат при сбое внутри операции (триггер), копия перед сбросом, 403, журнал" },
  { id: "backups.create", screen: "backups", action: "Резервные копии: создать копию", method: "POST", path: re("/admin/backups"), onlyKeys: ["comment"], risk: "служебное, место на диске", allowed: true, proof: "HTTP+браузер: успех, файл и описание, двойной клик, 403" },
  { id: "backups.restore", screen: "backups", action: "Резервные копии: восстановить базу из копии (предпросмотр, служебная копия перед восстановлением, подтверждение словом)", method: "POST", path: re(`/admin/backups/[^/]+/restore`), risk: "данные всей системы, необратимо (кроме служебной копии)", allowed: true, proof: "HTTP+браузер на копии БД: восстановление, служебная копия, данные и сеансы, 404, 403" },
  { id: "backups.delete", screen: "backups", action: "Резервные копии: удалить копию", method: "DELETE", path: re(`/admin/backups/[^/]+`), risk: "служебное, необратимо", allowed: true, proof: "HTTP+браузер: удаление файла и описания, повтор 404, 403" },
  { id: "ldap.save", screen: "ldap", action: "Доменная авторизация: сохранить настройки (с проверкой «устарело» на клиенте)", method: "PUT", path: re("/ldap-settings"), onlyKeys: ["enabled", "host", "port", "use_ssl", "start_tls", "verify_certificate", "login_template", "timeout_seconds", "base_dn"], risk: "вход доменных пользователей", allowed: true, proof: "HTTP+браузер: успех и перезагрузка, валидация 422, 403, конфликт, обрыв ответа" },
  { id: "ldap.test", screen: "ldap", action: "Доменная авторизация: пробная привязка (логин и пароль вводит человек, не сохраняются)", method: "POST", path: re("/ldap-settings/test"), onlyKeys: ["login", "password", "config"], risk: "пароли (значения вводит человек; нигде не сохраняются)", allowed: true, proof: "HTTP+браузер: недоступный сервер — причина показана, пароль очищается, 403" },
  { id: "ldap.search", screen: "users-access", action: "Пользователи: поиск человека в каталоге домена (логин и пароль вводит администратор; не сохраняются; данные не меняются)", method: "POST", path: re("/ldap-search"), onlyKeys: ["login", "password", "query"], risk: "пароли (значения вводит человек; нигде не сохраняются)", allowed: true, proof: "HTTP+браузер: домен выключен — сообщение, недоступный сервер — причина, пароль очищается, 403" },
  { id: "training.start", screen: "training", action: "Обучение: начать тест (или продолжить незавершённую попытку)", method: "POST", path: re("/training/attempts"), onlyKeys: ["object_id", "role_key", "feature_key"], risk: "личные данные обучения", allowed: true, proof: "HTTP+браузер: старт, возобновление вместо второй попытки, неизвестный раздел 400, журнал" },
  { id: "training.answer", screen: "training", action: "Обучение: ответить на вопрос теста (ответ не меняется)", method: "POST", path: re(`/training/attempts/\\d+/answer`), onlyKeys: ["question_key", "option"], risk: "личные данные обучения", allowed: true, proof: "HTTP+браузер: верный/неверный ответ и разбор, повтор 409, чужая попытка 404, 401" },
  { id: "map.online", screen: "map-admin", action: "Карта: включить/выключить онлайн-подложку", method: "PUT", path: re("/map/online-tiles"), onlyKeys: ["enabled"], risk: "внешние запросы браузеров", allowed: true, proof: "HTTP+браузер: успех, SQL, перезагрузка, 403" },
  { id: "map.upload", screen: "map-admin", action: "Карта: загрузить файл подложки PMTiles", method: "POST", path: re("/map/tiles/upload"), risk: "файлы на сервере", allowed: true, proof: "HTTP+браузер: успех, не-PMTiles отказ без следа на диске, 403" },
  { id: "activity.cleanup", screen: "activity", action: "Журнал действий: очистить записи раньше даты (счёт заранее, подтверждение датой)", method: "POST", path: re("/activity/cleanup"), risk: "журнал, необратимо", allowed: true, proof: "HTTP+браузер: счёт, очистка, факт очистки в журнале, 403" },
  { id: "release.run", screen: "changelog", action: "Что нового: повторить обработку данных обновления (копия базы снимается сервером)", method: "POST", path: re(`/release-tasks/[^/]+/run`), risk: "данные, служебное", allowed: true, proof: "HTTP+браузер: повтор выполненной обработки идемпотентен, 404, 403" },
  { id: "fill-scope.apply", screen: "fill-scope", action: "Заполнить пустые «Объект» и «Проект» у отмеченных справочников (временная необратимая обработка, предпросмотр и подтверждение словом — в интерфейсе)", method: "POST", path: re("/admin/fill-empty-scope/apply"), check: fillScopeApplyProblem, risk: "данные иерархии нескольких справочников, необратимо через интерфейс, служебное (администратор сервиса)", allowed: true, proof: "HTTP+браузер: применение отмеченного → SQL (пустых полей стало меньше), 403 у не-администратора, конфликт объекта/проекта из разных строк — отказ без изменений" },
  { id: "db-transfer.stage", screen: "bulk-edit", action: "Перенос базы: принять снимок (.zip) и сверить с текущей базой — ничего не меняет", method: "POST", path: re("/admin/db-transfer/stage"), check: uploadCheck({ ext: ["zip"] }), risk: "чтение (сверка), файл лежит в очереди на диске до применения или отмены", allowed: true, proof: "HTTP+браузер: сверка своим же снимком, числа таблиц совпадают, предупреждения по несовпадению версии/таблиц, 403 у не-администратора" },
  { id: "db-transfer.apply", screen: "bulk-edit", action: "Перенос базы: ПОЛНАЯ ЗАМЕНА текущей базы и вложений содержимым сверенного снимка (кодовое слово проверяет сервер; служебная копия текущего состояния снимается перед заменой)", method: "POST", path: re("/admin/db-transfer/apply"), onlyKeys: ["token", "confirm"], check: dbTransferApplyProblem, risk: "ВСЯ база и вложения, необратимо интерфейсом (только из служебной копии)", allowed: true, proof: "HTTP+браузер на копии БД: применение своим же снимком → служебная копия создана, счётчики совпали, неверное слово отклонено без изменений, 403 у не-администратора" },
  { id: "db-transfer.forget", screen: "bulk-edit", action: "Перенос базы: убрать снимок из очереди, не применяя", method: "POST", path: re("/admin/db-transfer/forget"), onlyKeys: ["token"], check: dbTransferForgetProblem, risk: "служебное (файл снимка на диске)", allowed: true, proof: "HTTP+браузер: повторное применение забытого токена → 404" },
  { id: "users.create", screen: "users-access", action: "Пользователи: создание учётной записи", method: "POST", path: re("/users"), onlyKeys: ["last_name", "first_name", "domain_login", "role"], risk: "права и учётные записи", allowed: true, proof: "HTTP+браузер: успех и БД, 403 у user2/user4, дубль логина 409, пустые поля 422, журнал" },
  { id: "users.update", screen: "users-access", action: "Пользователи: правка карточки (с проверкой «запись устарела»)", method: "PATCH", path: re(`/users/\\d+`), onlyKeys: ["last_name", "first_name", "patronymic", "position", "department", "domain_login", "role", "auth_method", "must_change_password", "expected_version"], check: (b) => (typeof b?.expected_version === "string" ? null : "нет версии записи"), risk: "права и учётные записи", allowed: true, proof: "HTTP+браузер: успех, устаревшая версия 409 без записи, снятие своей роли администратора 409, 403" },
  { id: "users.password", screen: "users-access", action: "Пароль пользователя: задать или заблокировать вход (пустой пароль — только чужому)", method: "POST", path: re(`/users/\\d+/set-password`), onlyKeys: ["password", "must_change_password"], check: (b) => (typeof b?.password === "string" ? null : "нет пароля"), risk: "пароли (значение вводит человек; в журнал не попадает)", allowed: true, proof: "HTTP+браузер на тестовых пользователях копии: политика 422, 403 у не-админов, блокировка, вход настоящей формой, сеансы завершаются, журнал без паролей и хэшей" },
  { id: "users.access", screen: "users-access", action: "Доступ к проектам и объектам: замена набора (с проверкой «устарело»)", method: "PUT", path: re(`/users/\\d+/access`), onlyKeys: ["grants", "expected_grants"], check: (b) => (Array.isArray(b?.grants) && Array.isArray(b?.expected_grants) ? null : "нет набора грантов или ожидаемого набора"), risk: "права", allowed: true, proof: "HTTP+браузер: успех и перезагрузка, валидация 400/404, устаревший набор 409, 403, журнал" },
  { id: "users.access-bulk", screen: "access-matrix", action: "Групповая выдача и снятие доступа (предпросмотр и применение, всё или ничего)", method: "POST", path: re("/users/access-bulk"), onlyKeys: ["changes", "dry_run"], check: (b) => (Array.isArray(b?.changes) && b.changes.length ? null : "нет изменений"), risk: "права, массовая операция", allowed: true, proof: "HTTP+браузер: предпросмотр без записи, применение, устаревшие данные 409, откат при сбое внутри пачки, конкуренция, 403" },
  { id: "users.impersonate", screen: "users-access", action: "Зайти под пользователем (отладочный сеанс; вкладка открывается в текущем интерфейсе)", method: "POST", path: re(`/users/\\d+/impersonate`), risk: "права, журнал на имя администратора", allowed: true, proof: "HTTP+браузер: токен, заголовок X-Impersonate-Token, отметка в журнале, 403" },
  { id: "roles.create", screen: "users-access", action: "Роли: создание (пустая, без разрешений)", method: "POST", path: re("/roles"), onlyKeys: ["name"], risk: "права", allowed: true, proof: "HTTP+браузер: успех, дубль 409, пустое 400, 403" },
  { id: "roles.rename", screen: "users-access", action: "Роли: переименование (с проверкой «устарело»)", method: "PATCH", path: re(`/roles/[^/]+`), onlyKeys: ["name", "expected_name"], risk: "права", allowed: true, proof: "HTTP+браузер: успех, устаревшее название 409, 404, 403" },
  { id: "roles.order", screen: "users-access", action: "Роли: порядок колонок матрицы", method: "PUT", path: re("/roles/order"), onlyKeys: ["keys"], risk: "показ", allowed: true, proof: "HTTP+браузер: успех, неполный список 400" },
  { id: "roles.features", screen: "users-access", action: "Роли: ячейки матрицы разрешений (с ожидаемым прежним уровнем)", method: "PUT", path: re("/roles/features"), onlyKeys: ["items"], check: (b) => (Array.isArray(b?.items) && b.items.every((i) => typeof i?.was === "string") ? null : "нет прежнего уровня ячейки"), risk: "права", allowed: true, proof: "HTTP+браузер: успех, устаревшее «было» 409 без записи, неизвестный раздел откатывает пачку, 403, журнал" },
  { id: "roles.delete", screen: "users-access", action: "Роли: удаление по плану (число выдач из плана передаётся серверу)", method: "DELETE", path: re(`/roles/[^/]+`), risk: "права, необратимо", allowed: true, proof: "HTTP+браузер: успех по актуальному плану, устаревший план 409, повтор 404, 403" },
  { id: "me.password", screen: "change-password", action: "Смена своего пароля (в том числе обязательная)", method: "POST", path: re("/me/change-password"), onlyKeys: ["current_password", "new_password"], risk: "пароли (значения вводит человек; в журнал не попадают)", allowed: true, proof: "HTTP+браузер на тестовом пользователе копии: неверный текущий 403, слабый 422, успех, прочие сеансы завершены, журнал без паролей" },
  { id: "sessions.own.end", screen: "sessions", action: "Мои сеансы: завершить один", method: "DELETE", path: re(`/me/sessions/[^/]+`), risk: "вход на других устройствах", allowed: true, proof: "HTTP+браузер: свой другой сеанс завершается, повтор 404, текущий сохраняется" },
  { id: "sessions.own.close-others", screen: "sessions", action: "Мои сеансы: завершить все, кроме текущего", method: "POST", path: re("/me/sessions/close-others"), risk: "вход на других устройствах", allowed: true, proof: "HTTP+браузер: остальные завершены, текущий жив" },
  { id: "sessions.admin.end", screen: "sessions", action: "Сеансы пользователей (администратор): завершить один сеанс", method: "DELETE", path: re(`/sessions/[^/]+`), risk: "вход на других устройствах", allowed: true, proof: "HTTP+браузер: успех, повтор 404, 403 у не-администратора" },
  { id: "sessions.admin.close-others", screen: "sessions", action: "Сеансы пользователей (администратор): завершить все, кроме своего", method: "POST", path: re("/sessions/close-others"), risk: "вход всех пользователей, массовая операция", allowed: true, proof: "HTTP+браузер: с подтверждением и числом; свой сеанс жив; 403 у не-администратора" },
  { id: "sessions.admin.user-all", screen: "users-access", action: "Сеансы человека (администратор): завершить все", method: "DELETE", path: re(`/users/\\d+/sessions`), risk: "вход человека на других устройствах", allowed: true, proof: "HTTP+браузер: успех, пароль цел, 403, 404" },
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
  { id: "drawing.analyze", screen: "upload-drawing", action: "Загрузка чертежа DXF: разбор и сводка изменений по выбранному объекту (в базу не пишет, файл сохраняется в uploads/)", method: "POST", path: re("/import-dxf/analyze"), check: uploadCheck({ ext: ["dxf"], fields: { object_id: isIntStr } }), risk: "чтение (разбор), данные не меняются; файл кладётся во временную папку сервера", allowed: true, proof: "настоящий backend: разбор синтетического DXF, отказ 403 у user2/user4, 4xx на пустой и битый файл" },
  { id: "drawing.apply", screen: "upload-drawing", action: "Загрузка чертежа DXF: применить показанную сводку (изделия, сетка осей, зоны и привязки объекта)", method: "POST", path: re("/import-dxf/apply"), check: dxfApplyProblem, risk: "геометрия и привязки изделий объекта; этапами (не одна транзакция, как в V1), копия базы перед применением", allowed: true, proof: "настоящий backend: применение по токену, повтор токена отклоняется, двойная отправка — один запрос, отказ 403, журнал после сохранения" },
  { id: "input.import", screen: "import-input", action: "Загрузка из папки Input/ сервера: чертежи и таблицы пачкой в выбранный объект", method: "POST", path: re("/admin/import-input"), check: inputImportProblem, risk: "геометрия изделий объекта и график СМР; каждый файл отдельно (ошибка одного не отменяет остальные), копия базы перед загрузкой", allowed: true, proof: "настоящий backend: построчный отчёт, отказ 403 у не-админа, повтор безопасен (обновление по handle), журнал" },
  { id: "revit.analyze", screen: "revit-import", action: "Загрузка из Revit: разбор пакетов выгрузки по выбранному объекту и сводка (в базу не пишет)", method: "POST", path: re("/import-revit/analyze"), check: uploadCheck({ ext: ["gz", "json"], fileField: "files", maxFiles: 12, fields: { object_id: isIntStr } }), risk: "чтение (разбор), данные не меняются", allowed: true, proof: "настоящий backend: разбор синтетического пакета КР, отказ 403 у не-админа, 4xx на битый пакет и на дубль раздела" },
  { id: "revit.apply", screen: "revit-import", action: "Загрузка из Revit: применить показанную сводку (секции, этажи, элементы и помещения модели объекта)", method: "POST", path: re("/import-revit/apply"), check: tokenOnlyProblem, risk: "справочники и элементы модели МФР объекта; этапами (как в V1), копия базы перед применением", allowed: true, proof: "настоящий backend: применение по токену, повтор токена отклоняется, отказ 403, списание исчезнувших внутри раздела" },
  { id: "bulk.apply", screen: "bulk-edit", action: "Массовая правка через Excel: применить отмеченные расхождения (реквизиты изделий / история статусов / контрактация)", method: "POST", path: re("/elements/bulk-edit/apply"), check: bulkApplyProblem, risk: "данные изделий, история статусов, контрактация; одна транзакция, копия базы перед применением", allowed: true, proof: "настоящий backend: применение отмеченного, откат при отказе стража, отказ 403, журнал после сохранения, устаревшая сверка не применяется" },

  // ---- временно отключено (справочно: для пояснений на экранах и для документа; всё, чего нет в списке, отключено тоже) ----
  { id: "counterparties.write", screen: "counterparties", action: "Прочие операции контрактации: контракт по умолчанию по типу изделия, свёртка дублей справочников (режим переноса подчинённых), прежние маршруты правки изделий (их заменили операции экрана «Операции над элементами»)", method: "POST/PATCH/PUT/DELETE", path: re(`/(counterparties|agreements|specifications|contracts|elements)(/.+)?|/dictionaries/(?!smu/|subtype/|mark_prefix/|mark/|zone/).+`), allowed: false, risk: "данные контрактации", why: "операции вне перечня разрешённых выше не проверялись в новом интерфейсе" },
];

// ---- проверка ----
const ALLOWED = POLICY.filter((r) => r.allowed);

function bodyKeys(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
}

/** Можно ли отправить изменяющий запрос. Не бросает: возвращает {allowed, rule?, message?}. */
export function checkWrite(method, pathWithQuery, body) {
  const m = String(method || "").toUpperCase();
  const [path, query = ""] = String(pathWithQuery || "").split("?");
  let problem = null;   // причина отказа проверки формы у ПОДХОДЯЩЕЙ по методу и пути строки — текст точнее, чем «операция отключена»
  for (const r of ALLOWED) {
    if (r.method !== m || !r.path.test(path)) continue;
    if (r.onlyKeys && !bodyKeys(body).every((k) => r.onlyKeys.includes(k))) { problem = problem || "лишние поля в запросе"; continue; } // поля вне разрешённой группы
    if (r.check) { const p = r.check(body, query, pathWithQuery); if (p) { problem = problem || p; continue; } }                    // тело/запрос/адрес не той формы, что проверена
    return { allowed: true, rule: r };
  }
  const known = POLICY.find((r) => !r.allowed && r.path.test(path));
  return {
    allowed: false,
    rule: known || null,
    problem,
    message: problem
      ? `Запрос не отправлен: ${problem}.`
      : `Операция отключена в экспериментальном интерфейсе${known ? ` («${known.action}»)` : ""}. Выполните её в текущем интерфейсе.`,
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
// и параметры адреса (все обязательны). Возвращает функцию (body, query, pathWithQuery) → текст проблемы или null (в проверке — «проблема ⇒ отказ»).
function uploadCheck({ ext, fields = {}, query = {}, maxBytes = 200 * 1024 * 1024, fileField = "file", maxFiles = 1 }) {
  return (body, _query, pathWithQuery) => {
    if (typeof FormData === "undefined" || !(body instanceof FormData)) return "не форма загрузки";
    const keys = [...new Set([...body.keys()])];
    if (keys.some((k) => k !== fileField && !(k in fields))) return "лишние поля формы";
    const files = body.getAll(fileField);
    if (files.length < 1 || files.length > maxFiles || files.some((f) => typeof f !== "object" || f === null || typeof f.name !== "string")) return maxFiles === 1 ? "нужен ровно один файл" : `нужно от 1 до ${maxFiles} файлов`;
    for (const f of files) {
      const e = (f.name.split(".").pop() || "").toLowerCase();
      if (!ext.includes(e)) return "неверное расширение файла";
      if (!(f.size > 0)) return "файл пуст";
      if (f.size > maxBytes) return "файл больше лимита сервера";
    }
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

// Применение чертежа: токен разбора и решения человека (принять смену марок; перезаполнить ручные поля: {id изделия: [поля]}; создать новые записи зон).
function dxfApplyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => !["token", "accept_mark_changes", "keep_mark_element_ids", "refill_manual_fields", "create_new_zone_ids"].includes(k))) return "лишние поля";
  if (typeof body.token !== "string" || !/^[0-9a-f]{16,64}$/.test(body.token)) return "нет токена разбора";
  if (typeof body.accept_mark_changes !== "boolean") return "решение по маркам не задано";
  if (!Array.isArray(body.keep_mark_element_ids) || !Array.isArray(body.create_new_zone_ids) || body.create_new_zone_ids.some((x) => !Number.isInteger(x))) return "списки решений неверны";
  const r = body.refill_manual_fields;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.entries(r).some(([k, v]) => !/^\d+$/.test(k) || !Array.isArray(v) || v.some((f) => typeof f !== "string"))) return "решения по ручным полям неверны";
  return null;
}

// Загрузка из папки Input: только объект пачки (целое число).
function inputImportProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => k !== "object_id")) return "лишние поля";
  if (!Number.isInteger(body.object_id) || body.object_id <= 0) return "не указан объект";
  return null;
}

// Применение по токену разбора без иных решений (Revit).
function tokenOnlyProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "тело не объект";
  if (Object.keys(body).some((k) => k !== "token")) return "лишние поля";
  if (typeof body.token !== "string" || !/^[0-9a-f]{16,64}$/.test(body.token)) return "нет токена разбора";
  return null;
}
