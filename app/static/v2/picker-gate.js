// Проверки формы тела запросов области «комплектовщик» (контрагенты, договоры, спецификации, контракты, плановая дата поставки,
// удаление записей справочника контрактации, документы замены поставщика и обмена привязками) — для строк шлюза `write-gate.js`.
//
// Правило то же, что у распределения (`allocationBodyProblem`): у каждой операции шлюза — ЖЁСТКАЯ форма тела. Функция возвращает текст
// причины отказа или null; лишние поля, неверные типы и границы — отказ ДО сети. Серверная проверка прав и данных от этого не зависит
// и выполняется как прежде: шлюз — дополнительный барьер против незавершённого интерфейса, а не замена серверных правил.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (b) => !!b && typeof b === "object" && !Array.isArray(b);
const isId = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === "string";
const isNameStr = (v) => isStr(v) && v.trim().length > 0;
const isNullableStr = (v) => v === null || isStr(v);
export function isIsoDate(v) {
  if (!isStr(v) || !DATE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const isNullableDate = (v) => v === null || isIsoDate(v);
const onlyKeys = (b, keys) => Object.keys(b).every((k) => keys.includes(k));
const optVersion = (b) => !("expected_version" in b) || isStr(b.expected_version);

// Строки нормативов производительности: тип и норматив > 0; комментарий — null или строка
function capacityProblem(cap) {
  if (!Array.isArray(cap) || cap.length > 200) return "нормативы производительности: неверный список";
  for (const c of cap) {
    if (!isObj(c) || !onlyKeys(c, ["element_type", "per_day", "comment"])) return "нормативы: лишние поля";
    if (!isNameStr(c.element_type) || typeof c.per_day !== "number" || !Number.isFinite(c.per_day) || c.per_day <= 0) return "нормативы: тип и число больше нуля обязательны";
    if ("comment" in c && !isNullableStr(c.comment)) return "нормативы: комментарий не строка";
  }
  return null;
}

// POST /counterparties, PATCH /counterparties/{id}
const CP_KEYS = ["full_name", "short_name", "inn", "kpp", "ogrn", "legal_address", "contact_person", "contact_phone", "code", "capacity", "expected_version"];
export function counterpartyBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, CP_KEYS)) return "лишние поля";
  if (!isNameStr(b.full_name) || !isNameStr(b.short_name)) return "не указано наименование";
  for (const k of ["inn", "kpp", "ogrn", "legal_address", "contact_person", "contact_phone", "code"]) if (k in b && !isNullableStr(b[k])) return `поле ${k} не строка`;
  if ("capacity" in b) { const p = capacityProblem(b.capacity); if (p) return p; }
  if (!optVersion(b)) return "версия записи не строка";
  return null;
}

// POST /agreements, PATCH /agreements/{id}
export function agreementBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, ["counterparty_id", "number", "agreement_date", "object_id", "expected_version"])) return "лишние поля";
  if (!isId(b.counterparty_id)) return "не указан контрагент";
  if (!isNameStr(b.number)) return "не указан номер договора";
  if (!isId(b.object_id)) return "не указан объект договора";
  if ("agreement_date" in b && !isNullableDate(b.agreement_date)) return "дата договора неверна";
  if (!optVersion(b)) return "версия записи не строка";
  return null;
}

// POST /specifications, PATCH /specifications/{id}
export function specificationBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, ["agreement_id", "number", "specification_date", "expected_version"])) return "лишние поля";
  if (!isId(b.agreement_id)) return "не указан договор";
  if (!isNameStr(b.number)) return "не указан номер спецификации";
  if ("specification_date" in b && !isNullableDate(b.specification_date)) return "дата спецификации неверна";
  if (!optVersion(b)) return "версия записи не строка";
  return null;
}

// POST /contracts, PATCH /contracts/{id}: позиции (тип, марка, количество), инциденты, нормативы контракта
export function contractBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, ["specification_id", "theme", "is_archived", "lines", "incidents", "capacity", "expected_version"])) return "лишние поля";
  if (!isId(b.specification_id)) return "не указана спецификация";
  if ("theme" in b && !isNullableStr(b.theme)) return "тема не строка";
  if ("is_archived" in b && typeof b.is_archived !== "boolean") return "признак архива не логический";
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 2000) return "нет ни одной позиции";
  const seen = new Set();
  for (const l of b.lines) {
    if (!isObj(l) || !onlyKeys(l, ["element_type", "mark", "quantity"])) return "лишние поля позиции";
    if (!isNullableStr(l.element_type) || !isNullableStr(l.mark)) return "тип и марка позиции — строки";
    if (!(l.element_type || "").trim() && !(l.mark || "").trim()) return "у позиции нет ни типа, ни марки";
    if (!Number.isInteger(l.quantity) || l.quantity < 0 || l.quantity > 1e7) return "количество позиции — целое от 0";
    const key = `${(l.element_type || "").trim().toLowerCase()}|${(l.mark || "").trim().toLowerCase()}`;
    if (seen.has(key)) return "позиция с этими типом и маркой повторяется";
    seen.add(key);
  }
  if ("incidents" in b) {
    if (!Array.isArray(b.incidents) || b.incidents.length > 1000) return "инциденты: неверный список";
    for (const i of b.incidents) {
      if (!isObj(i) || !onlyKeys(i, ["element_type", "quantity", "incident_date", "description"])) return "лишние поля инцидента";
      if (!isNameStr(i.element_type) || !Number.isInteger(i.quantity) || i.quantity < 0 || !isIsoDate(i.incident_date)) return "инцидент: тип, целое количество и дата обязательны";
      if ("description" in i && !isNullableStr(i.description)) return "описание инцидента не строка";
    }
  }
  if ("capacity" in b) { const p = capacityProblem(b.capacity); if (p) return p; }
  if (!optVersion(b)) return "версия записи не строка";
  return null;
}

// PATCH /elements/{id}/planned-delivery-date — дата ГГГГ-ММ-ДД или null (очистка)
export function plannedDateBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, ["planned_delivery_date"]) || !("planned_delivery_date" in b)) return "лишние поля";
  return isNullableDate(b.planned_delivery_date) ? null : "дата неверна";
}

// POST /dictionaries/{counterparty|agreement|specification|contract}/{id}/delete — ТОЛЬКО замена (режим «свёртка дублей» отключён)
const DEL_KEY = /^(counterparty|agreement|specification|contract):\d+$/;
export function contractingDeleteBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, ["replacements", "mode"])) return "лишние поля";
  if (b.mode !== "replace") return "разрешён только режим замены";
  if (!isObj(b.replacements)) return "замены не заданы";
  for (const [k, v] of Object.entries(b.replacements)) if (!DEL_KEY.test(k) || !isStr(v) || !/^\d+$/.test(v)) return "замена: неверный ключ";
  return null;
}

// POST /supplier-changes, PATCH /supplier-changes/{id}: документ «Замена поставщика» (element_ids) и «Обмен привязками» (side_a/side_b)
const SC_KEYS = ["object_id", "kind", "number", "doc_date", "from_contract_id", "to_contract_id", "mark", "reason", "comment", "element_ids", "side_a", "side_b", "expected_version"];
const idList = (v) => Array.isArray(v) && v.length <= 2000 && v.every(isId) && new Set(v).size === v.length;
export function supplierDocBodyProblem(b) {
  if (!isObj(b) || !onlyKeys(b, SC_KEYS)) return "лишние поля";
  if (!isId(b.object_id)) return "не указан объект";
  if (b.kind !== "supplier_change" && b.kind !== "link_swap") return "неизвестный вид документа";
  if (!isIsoDate(b.doc_date)) return "не указана дата документа";
  if (!isId(b.from_contract_id) || !isId(b.to_contract_id)) return "не выбраны контракты";
  if (b.from_contract_id === b.to_contract_id) return "контракты совпадают";
  for (const k of ["number", "mark", "reason", "comment"]) if (k in b && !isNullableStr(b[k])) return `поле ${k} не строка`;
  for (const k of ["element_ids", "side_a", "side_b"]) if (k in b && !idList(b[k])) return `список ${k} неверен`;
  if (b.kind === "supplier_change" && ((b.side_a || []).length || (b.side_b || []).length)) return "у замены поставщика нет сторон обмена";
  if (b.kind === "link_swap") {
    if ((b.element_ids || []).length) return "у обмена привязками нет списка замены";
    if (!isNameStr(b.mark)) return "не выбрана марка обмена";
    const a = new Set(b.side_a || []);
    if ((b.side_b || []).some((x) => a.has(x))) return "изделие на обеих сторонах";
  }
  if (!optVersion(b)) return "версия документа не строка";
  return null;
}

// POST /supplier-changes/{id}/post|unpost — без тела либо только версия документа, которую видел человек
export function supplierDocActionBodyProblem(b) {
  if (b === undefined) return null;
  if (!isObj(b) || !onlyKeys(b, ["expected_version"])) return "лишние поля";
  return optVersion(b) ? null : "версия документа не строка";
}
