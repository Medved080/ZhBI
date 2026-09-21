// Сверка ВСЕЙ пачки после неопределённого исхода распределения (ответ потерян: обрыв сети, 5xx, тайм-аут).
//
// Что различаем (и что НЕ утверждаем):
//  * подтверждённый результат конкретной операции — это только успешный ответ сервера на сам запрос; здесь его нет;
//  * текущее состояние изделий на сервере — то, что читается сейчас (`GET /allocation-state`, один снимок на всю пачку);
//    сервер не хранит идентификатор операции, поэтому даже полное совпадение состояния НЕ доказывает, что его создал именно
//    наш запрос (могла распределить и другая сессия) — формулировка для человека говорит «текущее состояние соответствует»;
//  * неизвестный результат — сверку выполнить не удалось или состояние пачки неоднозначно; автоповтора записи нет никогда.
//
// Ожидаемое состояние изделия ПОСЛЕ распределения: контракт = выбранный, статус «Запланирован» → «Контрактация», прочие сохраняются.
// Проверяется КАЖДОЕ изделие пачки (не только крайние): пачка атомарна на сервере, но позже изделия могли изменить другие люди.

export const expectedStatusAfter = (pre) => (pre === "planned" ? "contracting" : pre);

/**
 * @param {{element_id:number, expected_status:string}[]} items — пачка так, как она отправлялась (состояние ДО)
 * @param {{items:{id:number,current_status:string,contract_id:number|null}[], missing?:number[]}} state — ответ `GET /allocation-state`
 * @param {number} contractId
 * @returns {{kind:"state_matches"|"not_applied"|"mixed", total:number, asRequested:number, untouched:number, other:number, missing:number, sample:{id:number,now:string}[]}}
 */
export function classifyAllocation(items, state, contractId) {
  const byId = new Map((state?.items || []).map((r) => [r.id, r]));
  let asRequested = 0, untouched = 0, other = 0, missing = 0;
  const sample = [];
  for (const it of items) {
    const now = byId.get(it.element_id);
    if (!now) { missing++; if (sample.length < 5) sample.push({ id: it.element_id, now: "нет данных" }); continue; }
    if (now.contract_id === contractId && now.current_status === expectedStatusAfter(it.expected_status)) asRequested++;
    else if (now.contract_id == null && now.current_status === it.expected_status) { untouched++; if (sample.length < 5) sample.push({ id: it.element_id, now: "без изменений" }); }
    else { other++; if (sample.length < 5) sample.push({ id: it.element_id, now: `статус «${now.current_status}», контракт ${now.contract_id ?? "нет"}` }); }
  }
  const total = items.length;
  const kind = asRequested === total ? "state_matches" : untouched === total ? "not_applied" : "mixed";
  return { kind, total, asRequested, untouched, other, missing, sample };
}

/** Читает состояние всей пачки одним запросом и классифицирует. Бросает ошибку запроса — вызывающий покажет «исход неизвестен». */
export async function verifyAllocationBatch(api, items, contractId) {
  const ids = items.map((i) => i.element_id);
  const state = await api.get(`/allocation-state?ids=${ids.join(",")}`);
  return classifyAllocation(items, state, contractId);
}

/** Текст для человека по итогу сверки. `ok:true` — только для полного совпадения текущего состояния (это НЕ подтверждение запроса). */
export function verdictText(v, contractName) {
  if (v.kind === "state_matches") {
    return { level: "warn", text: `Ответ не получен. Сверка всей пачки: все ${v.total} изд. на сервере сейчас в состоянии, которое даёт это распределение на «${contractName}» `
      + `(«Запланирован» → «Контрактация», прочие статусы сохранены). Это текущее состояние на момент проверки: подтвердить, что его создал именно этот запрос, нельзя — сервер не хранит идентификатор операции. Повторно ничего не отправлялось; схема и остатки перечитаны.` };
  }
  if (v.kind === "not_applied") {
    return { level: "error", text: `Ответ не получен, распределение не подтверждено: все ${v.total} изд. на сервере без изменений (проверено по каждому). Выбор сохранён — проверьте связь и подтвердите снова.` };
  }
  const ex = v.sample.map((s) => `№${s.id}: ${s.now}`).join("; ");
  return { level: "error", text: `Ответ не получен, состояние пачки НЕОДНОЗНАЧНО: из ${v.total} изд. соответствуют результату распределения ${v.asRequested}, без изменений ${v.untouched}`
    + `, иначе изменены или не найдены ${v.other + v.missing}${ex ? ` (${ex})` : ""}. Распределение целиком не подтверждено. Ничего не отправлено повторно — схема перечитана: проверьте изделия и остатки контракта.` };
}
