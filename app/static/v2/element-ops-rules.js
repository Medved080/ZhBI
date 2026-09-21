// Правила операций над изделиями на схеме (модель ЖБИ, АРМ прораба): чистые функции без DOM — проверка формы тела для шлюза записи
// (`write-gate.js`) и тексты последствий для интерфейса. Серверные маршруты — `app/element_ops.py` (`/element-ops/*`).

const STATUSES = ["planned", "contracting", "in_production", "shipped", "delivered", "installed", "accepted"];
const isObj = (b) => b && typeof b === "object" && !Array.isArray(b);
const extra = (b, allowed) => Object.keys(b).some((k) => !allowed.includes(k));
const posInt = (x) => Number.isInteger(x) && x > 0;

export const MAX_BATCH = 2000;

// Жёсткая форма тела групповой смены статуса (`POST /element-ops/status-batch`): контракты по строкам НЕ передаются — только ожидаемое состояние.
export function statusBatchBodyProblem(body) {
  if (!isObj(body)) return "тело не объект";
  if (extra(body, ["mode", "object_id", "status", "changed_at", "comment", "assign_contract_id", "expect", "items"])) return "лишние поля";
  if (body.mode !== "preview" && body.mode !== "apply") return "режим: preview или apply";
  if (!posInt(body.object_id)) return "не указан объект";
  if (!STATUSES.includes(body.status)) return "неизвестный статус";
  if (body.changed_at !== undefined && body.changed_at !== null && (typeof body.changed_at !== "string" || body.changed_at.length > 25)) return "дата и время";
  if (body.comment !== undefined && body.comment !== null && (typeof body.comment !== "string" || body.comment.length > 500)) return "комментарий";
  if (body.assign_contract_id !== undefined && body.assign_contract_id !== null && !posInt(body.assign_contract_id)) return "контракт для назначения";
  if (body.mode === "apply") {
    const e = body.expect;
    if (!isObj(e) || extra(e, ["release_contracts", "without_contract"]) || !Number.isInteger(e.release_contracts) || !Number.isInteger(e.without_contract) || e.release_contracts < 0 || e.without_contract < 0) return "нет подтверждения последствий";
  } else if (body.expect !== undefined) return "предпросмотр без подтверждения";
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_BATCH) return "пачка пуста или больше лимита";
  const seen = new Set();
  for (const it of body.items) {
    if (!isObj(it) || extra(it, ["element_id", "expected_status", "expected_contract_id"])) return "лишние поля изделия";
    if (!posInt(it.element_id) || !STATUSES.includes(it.expected_status)) return "у изделия нет идентификатора или ожидаемого статуса";
    if (it.expected_contract_id !== null && it.expected_contract_id !== undefined && !posInt(it.expected_contract_id)) return "ожидаемый контракт";
    if (seen.has(it.element_id)) return "изделие повторяется";
    seen.add(it.element_id);
  }
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Плановая дата пачки (`POST /element-ops/planned-date-batch`): одна дата (или null) и ожидаемая прежняя дата каждого изделия.
export function plannedBatchBodyProblem(body) {
  if (!isObj(body)) return "тело не объект";
  if (extra(body, ["object_id", "planned_date", "items"])) return "лишние поля";
  if (!posInt(body.object_id)) return "не указан объект";
  if (body.planned_date !== null && (typeof body.planned_date !== "string" || !DATE.test(body.planned_date))) return "дата ГГГГ-ММ-ДД или null";
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_BATCH) return "пачка пуста или больше лимита";
  const seen = new Set();
  for (const it of body.items) {
    if (!isObj(it) || extra(it, ["element_id", "expected_planned_date"])) return "лишние поля изделия";
    if (!posInt(it.element_id)) return "нет идентификатора изделия";
    if (it.expected_planned_date !== null && (typeof it.expected_planned_date !== "string" || it.expected_planned_date.length > 12)) return "ожидаемая дата";
    if (seen.has(it.element_id)) return "изделие повторяется";
    seen.add(it.element_id);
  }
  return null;
}

// Контракт одного изделия (`POST /element-ops/contract`).
export function contractSetBodyProblem(body) {
  if (!isObj(body)) return "тело не объект";
  if (extra(body, ["element_id", "expected_status", "expected_contract_id", "contract_id"])) return "лишние поля";
  if (!posInt(body.element_id) || !STATUSES.includes(body.expected_status)) return "нет изделия или ожидаемого статуса";
  if (body.expected_contract_id !== null && !posInt(body.expected_contract_id)) return "ожидаемый контракт";
  if (body.contract_id !== null && !posInt(body.contract_id)) return "контракт";
  return null;
}

// Комментарий (`PATCH /elements/{id}/comment`) — только текст.
export function commentBodyProblem(body) {
  if (!isObj(body) || extra(body, ["comment"])) return "лишние поля";
  if (body.comment !== null && (typeof body.comment !== "string" || body.comment.length > 2000)) return "комментарий";
  return null;
}

// Запись истории статусов (`PATCH /elements/{id}/history/{hid}`): статус, момент, автор, комментарий; хотя бы одно поле.
export function historyEditBodyProblem(body) {
  if (!isObj(body) || extra(body, ["status", "changed_at", "changed_by", "comment"])) return "лишние поля";
  if (!Object.keys(body).length) return "пусто";
  if ("status" in body && !STATUSES.includes(body.status)) return "статус";
  if ("changed_at" in body && (typeof body.changed_at !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(body.changed_at))) return "момент";
  for (const k of ["changed_by", "comment"]) if (k in body && body[k] !== null && (typeof body[k] !== "string" || body[k].length > 500)) return k;
  return null;
}

// Реквизиты изделия (`PATCH /elements/{id}/fields`): только редактируемые поля, значения строки/числа/null.
export const FIELD_KEYS = ["element_type", "subtype", "mark", "elevation_mm", "floor", "address", "planned_delivery_date", "project_smr_start_date", "project_delivery_date"];
export function fieldsBodyProblem(body) {
  if (!isObj(body) || extra(body, FIELD_KEYS)) return "лишние поля";
  if (!Object.keys(body).length) return "пусто";
  for (const v of Object.values(body)) if (!(v === null || typeof v === "string" || typeof v === "number")) return "значение";
  return null;
}

// ---- тексты последствий (по ответу сервера в режиме preview) ----
const n = (x) => Number(x).toLocaleString("ru-RU");
/** Строки последствий операции для показа ДО подтверждения; пусто — последствий сверх смены статуса нет. */
export function consequenceLines(c, targetLabel) {
  const L = [];
  if (!c) return L;
  if (c.release_contracts) {
    const by = (c.released_by_contract || []).map((x) => `${x.name || "контракт №" + x.contract_id} — ${n(x.count)} шт.`).join("; ");
    L.push(`Контракт будет СНЯТ у ${n(c.release_contracts)} изд. (статус «${targetLabel}» контракта не имеет)${by ? ": " + by : ""}. Изделия вернутся в остаток позиции контракта.`);
  }
  if (c.actual_date_cleared) L.push(`Фактическая дата поставки будет очищена у ${n(c.actual_date_cleared)} изд.`);
  if (c.without_contract) L.push(`${n(c.without_contract)} изд. уйдут из «Запланирован» БЕЗ контракта (контракт назначается позже — в карточке изделия или распределением).`);
  if (c.assigned) L.push(`Будет назначен контракт: ${n(c.assigned)} изд.`);
  if (c.effective_differs) L.push(`У ${n(c.effective_differs)} изд. в истории есть более поздние записи: запись «${targetLabel}» будет добавлена, но итоговый статус не изменится.`);
  for (const w of c.warnings || []) L.push(`Превышение по контракту «${w.contract_name}»: по спецификации ${w.quantity}, фактически ${w.fact}${w.damaged ? `, брак ${w.damaged}` : ""}.`);
  return L;
}

/** Нужны ли последствия к явному подтверждению человеком (иначе одиночная смена статуса записывается сразу). */
export function needsConfirm(c) {
  return !!c && (c.release_contracts > 0 || c.without_contract > 0 || c.actual_date_cleared > 0 || c.effective_differs > 0 || (c.warnings || []).length > 0);
}

const REASONS = {
  state_changed: "изменились после того, как вы их выбрали (другим пользователем или на другом экране)",
  same_status: "уже в этом статусе",
  same_value: "уже с этим значением",
  other_object: "относятся к другому объекту",
  partly_applied: "частично уже изменены этой операцией",
  duplicate: "повторяются в пачке",
  not_found: "не найдены",
  contract_guard: "не проходят проверку контракта",
};
/** Текст конфликта сервера (409/404/400 с перечнем): сообщение + число изделий по причинам. */
export function conflictText(detail) {
  if (!detail || typeof detail !== "object") return null;
  const list = Array.isArray(detail.conflicts) ? detail.conflicts : [];
  if (detail.kind === "contract_guard" && list.length) {
    return `${detail.message}: ` + list.slice(0, 3).map((p) => `${p.element_type || ""} «${p.mark || "без марки"}» — ${p.message}`).join(" ") + (list.length > 3 ? ` (и ещё ${list.length - 3})` : "");
  }
  if (!list.length) return detail.message || null;
  const by = new Map();
  for (const c of list) by.set(c.reason, (by.get(c.reason) || 0) + 1);
  return `${detail.message} Изделий: ${Array.from(by, ([r, k]) => `${n(k)} ${REASONS[r] || r}`).join("; ")}.`;
}
