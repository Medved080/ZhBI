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

// ---- построчные групповые операции (область lines): у каждой строки своё значение, всё выбранное человеком явно ----
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonNeg = (x) => Number.isInteger(x) && x >= 0;

// Плановые даты по строкам (`POST /element-ops/planned-date-rows`): у каждой строки прежняя и НОВАЯ дата (null — не задана / снять), обе указаны явно.
export function plannedRowsBodyProblem(body) {
  if (!isObj(body)) return "тело не объект";
  if (extra(body, ["mode", "object_id", "expect", "items"])) return "лишние поля";
  if (body.mode !== "preview" && body.mode !== "apply") return "режим: preview или apply";
  if (!posInt(body.object_id)) return "не указан объект";
  if (body.mode === "apply") {
    const e = body.expect;
    if (!isObj(e) || extra(e, ["set_new", "replaced", "cleared"]) || !nonNeg(e.set_new) || !nonNeg(e.replaced) || !nonNeg(e.cleared)) return "нет подтверждения последствий";
  } else if (body.expect !== undefined) return "предпросмотр без подтверждения";
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_BATCH) return "пачка пуста или больше лимита";
  const seen = new Set();
  for (const it of body.items) {
    if (!isObj(it) || extra(it, ["element_id", "expected_planned_date", "planned_date"])) return "лишние поля изделия";
    if (!hasOwn(it, "expected_planned_date") || !hasOwn(it, "planned_date")) return "у строки не указаны прежняя и новая дата";
    if (!posInt(it.element_id)) return "нет идентификатора изделия";
    if (it.expected_planned_date !== null && (typeof it.expected_planned_date !== "string" || it.expected_planned_date.length > 12)) return "ожидаемая дата";
    if (it.planned_date !== null && (typeof it.planned_date !== "string" || !DATE.test(it.planned_date))) return "дата строки ГГГГ-ММ-ДД или null";
    if (it.planned_date === it.expected_planned_date) return "у строки дата не меняется";
    if (seen.has(it.element_id)) return "изделие повторяется";
    seen.add(it.element_id);
  }
  return null;
}

// Смена статуса с контрактом по строкам (`POST /element-ops/status-rows`): у каждой строки ожидаемое состояние и контракт ПОСЛЕ операции (число или null) — явно.
export function statusRowsBodyProblem(body) {
  if (!isObj(body)) return "тело не объект";
  if (extra(body, ["mode", "object_id", "status", "changed_at", "comment", "expect", "items"])) return "лишние поля";
  if (body.mode !== "preview" && body.mode !== "apply") return "режим: preview или apply";
  if (!posInt(body.object_id)) return "не указан объект";
  if (!STATUSES.includes(body.status)) return "неизвестный статус";
  if (body.changed_at !== undefined && body.changed_at !== null && (typeof body.changed_at !== "string" || body.changed_at.length > 25)) return "дата и время";
  if (body.comment !== undefined && body.comment !== null && (typeof body.comment !== "string" || body.comment.length > 500)) return "комментарий";
  if (body.mode === "apply") {
    const e = body.expect;
    if (!isObj(e) || extra(e, ["release_contracts", "replace_contracts", "without_contract"]) || !nonNeg(e.release_contracts) || !nonNeg(e.replace_contracts) || !nonNeg(e.without_contract)) return "нет подтверждения последствий";
  } else if (body.expect !== undefined) return "предпросмотр без подтверждения";
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_BATCH) return "пачка пуста или больше лимита";
  const seen = new Set();
  for (const it of body.items) {
    if (!isObj(it) || extra(it, ["element_id", "expected_status", "expected_contract_id", "contract_id"])) return "лишние поля изделия";
    if (!hasOwn(it, "expected_contract_id") || !hasOwn(it, "contract_id")) return "у строки не указан контракт";
    if (!posInt(it.element_id) || !STATUSES.includes(it.expected_status)) return "у изделия нет идентификатора или ожидаемого статуса";
    if (it.expected_contract_id !== null && !posInt(it.expected_contract_id)) return "ожидаемый контракт";
    if (it.contract_id !== null && !posInt(it.contract_id)) return "контракт строки";
    if (body.status === "planned" && it.contract_id !== null) return "у «Запланирован» контракта не бывает";
    if (seen.has(it.element_id)) return "изделие повторяется";
    seen.add(it.element_id);
  }
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
/** Последствия операции для показа ДО подтверждения: [{text, sub?: [строки]}]; пусто — последствий сверх смены статуса нет. */
export function consequenceItems(c, targetLabel) {
  const L = [];
  if (!c) return L;
  if (c.release_contracts) {
    L.push({ text: `Контракт будет СНЯТ у ${n(c.release_contracts)} изд. (статус «${targetLabel}» контракта не имеет); изделия вернутся в остаток позиции контракта.`,
      sub: (c.released_by_contract || []).map((x) => `${x.name || "контракт №" + x.contract_id} — ${n(x.count)} шт.`) });
  }
  if (c.actual_date_cleared) L.push({ text: `Фактическая дата поставки будет очищена у ${n(c.actual_date_cleared)} изд.` });
  if (c.without_contract) L.push({ text: `${n(c.without_contract)} изд. уйдут из «Запланирован» БЕЗ контракта (контракт назначается позже — в карточке изделия или распределением).` });
  if (c.assigned) L.push({ text: `Будет назначен контракт: ${n(c.assigned)} изд.` });
  if (c.effective_differs) L.push({ text: `У ${n(c.effective_differs)} изд. в истории есть более поздние записи: запись «${targetLabel}» будет добавлена, но итоговый статус не изменится.` });
  for (const w of c.warnings || []) L.push({ text: `Превышение по контракту «${w.contract_name}»: по спецификации ${w.quantity}, фактически ${w.fact}${w.damaged ? `, брак ${w.damaged}` : ""}.` });
  return L;
}
/** То же плоскими строками (для диалогов подтверждения и сообщений). */
export function consequenceLines(c, targetLabel) {
  return consequenceItems(c, targetLabel).flatMap((x) => [x.text, ...(x.sub || []).map((t) => "     – " + t)]);
}

/** Последствия построчной смены статуса (`POST /element-ops/status-rows`, режим preview): снятие и ЗАМЕНА контракта названы отдельно и поимённо. */
export function rowsConsequenceItems(c, targetLabel) {
  const L = [];
  if (!c) return L;
  if (c.release_contracts) {
    L.push({ text: `Контракт будет СНЯТ у ${n(c.release_contracts)} изд.; изделия вернутся в остаток позиции контракта.`,
      sub: (c.released_by_contract || []).map((x) => `${x.name || "контракт №" + x.contract_id} — ${n(x.count)} шт.`) });
  }
  if (c.replace_contracts) {
    L.push({ text: `Контракт будет ЗАМЕНЁН у ${n(c.replace_contracts)} изд.`,
      sub: (c.replaced || []).map((x) => `${x.from_name || "контракт №" + x.from_id} → ${x.to_name || "контракт №" + x.to_id} — ${n(x.count)} шт.`) });
  }
  if (c.assigned) {
    L.push({ text: `Будет назначен контракт: ${n(c.assigned)} изд.`, sub: (c.assigned_by_contract || []).map((x) => `${x.name || "контракт №" + x.contract_id} — ${n(x.count)} шт.`) });
  }
  if (c.without_contract) L.push({ text: `${n(c.without_contract)} изд. останутся БЕЗ контракта (выбрано «без контракта»).` });
  if (c.actual_date_cleared) L.push({ text: `Фактическая дата поставки будет очищена у ${n(c.actual_date_cleared)} изд.` });
  if (c.effective_differs) L.push({ text: `У ${n(c.effective_differs)} изд. в истории есть более поздние записи: запись «${targetLabel}» будет добавлена, но итоговый статус не изменится.` });
  for (const w of c.warnings || []) L.push({ text: `Превышение по контракту «${w.contract_name}»: по спецификации ${w.quantity}, фактически ${w.fact}${w.damaged ? `, брак ${w.damaged}` : ""}.` });
  return L;
}
/** Последствия построчной смены плановых дат (`POST /element-ops/planned-date-rows`). */
export function datesConsequenceLines(c) {
  const L = [];
  if (c.set_new) L.push(`Дата будет ЗАДАНА у ${n(c.set_new)} изд. (раньше не была задана).`);
  if (c.replaced) L.push(`Ранее заданная дата будет ЗАМЕНЕНА у ${n(c.replaced)} изд.`);
  if (c.cleared) L.push(`Дата будет СНЯТА у ${n(c.cleared)} изд.`);
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

// ---- сверка после неопределённого исхода (ответ потерян: обрыв связи, 5xx) ----
// Различаем: (1) подтверждённый результат ЗАПРОСА — только успешный ответ сервера, его здесь нет; (2) ТЕКУЩЕЕ состояние изделий (`GET /element-ops/state`, один снимок на
// всю пачку) — сервер не хранит идентификатор операции, поэтому даже полное совпадение состояния не доказывает, что его создал именно наш запрос (мог другой пользователь);
// (3) неизвестный результат. Автоповтора записи нет никогда. Проверяется КАЖДОЕ изделие пачки, а не только крайние.
/** checks: [{id, matches(now)→bool, untouched(now)→bool}]; state — ответ `GET /element-ops/state`. */
export function classifyState(checks, state) {
  const byId = new Map((state?.items || []).map((r) => [r.id, r]));
  let asRequested = 0, untouched = 0, other = 0, missing = 0;
  for (const c of checks) {
    const now = byId.get(c.id);
    if (!now) { missing++; continue; }
    if (c.matches(now)) asRequested++; else if (c.untouched(now)) untouched++; else other++;
  }
  const total = checks.length;
  const kind = asRequested === total ? "state_matches" : untouched === total ? "not_applied" : "mixed";
  return { kind, total, asRequested, untouched, other, missing };
}
/** Текст для человека: `what` — что делала операция («статус «Доставлен»»); `single` — одно изделие. level: warn — состояние совпало (НЕ подтверждение запроса), err — нет/неоднозначно. */
export function verdictText(v, what, single = false) {
  if (v.kind === "state_matches") {
    return { level: "warn", text: single
      ? `Ответ не получен. Текущее состояние изделия на сервере соответствует запросу (${what}), но подтвердить, что его выполнил именно этот запрос, нельзя — сервер не хранит идентификатор операции. Повторно ничего не отправлялось; схема перечитана.`
      : `Ответ не получен. Сверка всей пачки: все ${n(v.total)} изд. на сервере сейчас в состоянии, которое даёт эта операция (${what}). Это текущее состояние на момент проверки: подтвердить, что его создал именно этот запрос, нельзя — сервер не хранит идентификатор операции. Повторно ничего не отправлялось; схема перечитана.` };
  }
  if (v.kind === "not_applied") {
    return { level: "err", text: `Ответ не получен, изменение не подтверждено: ${single ? "изделие на сервере без изменений" : `все ${n(v.total)} изд. на сервере без изменений (проверено по каждому)`}. Введённое сохранено — проверьте связь и отправьте снова.` };
  }
  return { level: "err", text: `Ответ не получен, состояние ${single ? "изделия" : "пачки"} НЕОДНОЗНАЧНО: из ${n(v.total)} изд. соответствуют результату ${n(v.asRequested)}, без изменений ${n(v.untouched)}, иначе изменены или не найдены ${n(v.other + v.missing)}. Операция целиком не подтверждена. Ничего не отправлено повторно — схема перечитана: проверьте изделия.` };
}
