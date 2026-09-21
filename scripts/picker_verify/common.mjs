// Общие для сценариев области «picker»: подготовка копии (роли, данные), рабочие приёмы интерфейса, чтение журнала.
import { sql, sql1, exec, sleep, check } from "./lib.mjs";

export const USER_PICKER = "user2";   // на копии получает роль «Комплектовщик» (contract) на объекте 1
export const USER_VIEW = "user4";     // роль «view»

/** Подготовка копии ДО запуска приложения (прямой SQL по КОПИИ): роли и данные для сценариев. */
export function prepareCopy(db) {
  exec(db, `UPDATE user_access SET role='contract' WHERE user_id=(SELECT id FROM users WHERE domain_login='${USER_PICKER}');`);
  // запас свободного количества в контракте 13 по позиции 4П-12 — под перенос при замене поставщика (остальное заполнено «до нуля»)
  exec(db, `UPDATE contract_lines SET quantity = quantity + 6 WHERE contract_id=13 AND mark='4П-12';`);
}

export const eo = (b, js) => b.eval(js);
export const text = (b, sel = "#v2-content") => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
export const has = (b, sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);

/** Выбор значения у <select> с событием change (нативный выпадающий список мышью в безголовом Chrome не открывается). */
export async function selectValue(b, sel, value) {
  await b.eval(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});if(!s)throw new Error('нет select ${sel}');s.value=${JSON.stringify(String(value))};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(150);
}
export async function selectText(b, sel, label) {
  const v = await b.eval(`(()=>{const s=document.querySelector(${JSON.stringify(sel)});const o=[...s.options].find(o=>o.textContent.includes(${JSON.stringify(label)}));return o?o.value:null})()`);
  if (v == null) throw new Error(`нет варианта «${label}» в ${sel}`);
  await selectValue(b, sel, v);
}
/** Щелчок по кнопке диалога V2 (подтверждение, сообщение) — реальное событие мыши. */
export async function dialogClick(b, label, timeout = 8000) {
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, timeout);
  const r = await b.eval(`(()=>{const e=[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!r) throw new Error("нет кнопки диалога «" + label + "»: " + (await b.eval(`document.querySelector('.v2-dialog')?.innerText`)));
  await b.click(r.x, r.y);
  await sleep(200);
}
export const dialogText = (b) => b.eval(`document.querySelector('.v2-dialog')?.innerText || ''`);
export async function clickBtn(b, label, scope = "document") {
  const r = await b.eval(`(()=>{const e=[...${scope}.querySelectorAll('button')].find(x=>x.offsetParent&&!x.disabled&&x.textContent.trim().replace(/\\s+/g,' ')===${JSON.stringify(label)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!r) throw new Error("нет доступной кнопки «" + label + "»");
  await b.click(r.x, r.y);
}
export const btnState = (b, label) => b.eval(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&x.textContent.trim().replace(/\\s+/g,' ')===${JSON.stringify(label)});return e?(e.disabled?'disabled':'enabled'):'absent'})()`);

/** Журнал действий пишется асинхронно (очередь): ждём появления/стабилизации. */
export async function activity(db, where, wait = 1200) {
  await sleep(wait);
  return sql(db, `SELECT action, entity_type, entity_id, old_value, new_value FROM activity_log WHERE ${where} ORDER BY id`);
}
export const maxActivityId = (db) => Number(sql1(db, "SELECT COALESCE(MAX(id),0) FROM activity_log"));

/** Запросы записи, ушедшие на сервер после метки (метод + путь + тело). */
export function writeReqs(b, from = 0, re = null) {
  return b.requests.slice(from).filter((r) => !["GET", "OPTIONS", "HEAD"].includes(r.method) && !/\/activity$/.test(r.url) && (!re || re.test(new URL(r.url).pathname)))
    .map((r) => ({ method: r.method, path: new URL(r.url).pathname, body: r.body, status: r.status }));
}

/** Вызов API от имени текущей сессии страницы напрямую (имитация «другого пользователя» / проверка серверных прав); возвращает {status, json}. */
export function rawApi(b, method, path, body) {
  return b.eval(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'Content-Type':'application/json'},body:${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}}).then(async r=>{let j=null;try{j=await r.json()}catch(e){};return{status:r.status,json:j}})`);
}

/** Потеря ответа: запрос доходит до сервера и ВЫПОЛНЯЕТСЯ, но страница получает сетевую ошибку (для путей, подходящих под шаблон). */
export async function dropResponses(b, patternSource) {
  await b.eval(`(()=>{if(window.__origFetch)return;window.__origFetch=window.fetch;window.__dropped=0;window.fetch=async (u,o)=>{const r=await window.__origFetch(u,o);if(new RegExp(${JSON.stringify(patternSource)}).test(String(u))&&o&&o.method&&o.method!=='GET'){window.__dropped++;throw new TypeError('Failed to fetch')}return r}})()`);
}
export async function restoreFetch(b) { await b.eval(`(()=>{if(window.__origFetch){window.fetch=window.__origFetch;delete window.__origFetch}})()`); }

export { sql, sql1, exec, sleep, check };

/** Реальный щелчок по элементу после прокрутки его в видимую область (координатные события вне окна просмотра не срабатывают). */
export async function clickSelScrolled(b, sel, o) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`);
  await sleep(120);
  await b.clickSel(sel, o);
}

/** Подготовка копии для сценариев контрагентов: роли + синтетические записи «QA-Старый» (с изделиями на контракте) и «QA-Новый» (замены). */
export function prepareCp(db) {
  prepareCopy(db);
  const ins = (q) => { exec(db, q); return Number(sql1(db, "SELECT last_insert_rowid()")); };
  const one = (q) => Number(sql1(db, q));
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Старый»','QA-Старый','QAOLD'),('ООО «QA-Новый»','QA-Новый','QANEW');`);
  const old = one("SELECT id FROM counterparties WHERE short_name='QA-Старый'"), nw = one("SELECT id FROM counterparties WHERE short_name='QA-Новый'");
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (${old},'QA-Д1','2026-09-01',1),(${nw},'QA-Д2','2026-09-02',1),(${nw},'QA-Д3','2026-09-03',1);`);
  const ag = (n) => one(`SELECT id FROM agreements WHERE number='${n}'`);
  exec(db, `INSERT INTO specifications (agreement_id, number, specification_date) VALUES (${ag("QA-Д1")},'QA-С1','2026-09-01'),(${ag("QA-Д2")},'QA-С2','2026-09-02'),(${ag("QA-Д3")},'QA-С4','2026-09-03');`);
  const sp = (n) => one(`SELECT id FROM specifications WHERE number='${n}'`);
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES (${sp("QA-С1")},'QA-старый'),(${sp("QA-С2")},'QA-новый'),(${sp("QA-С4")},'QA-плохой');`);
  const co = (t) => one(`SELECT id FROM contracts WHERE theme='${t}'`);
  exec(db, `INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (${co("QA-старый")},'Ригель','3Р19',5),(${co("QA-новый")},'Ригель','3Р19',20),(${co("QA-плохой")},'Колонна','4Кв3.1',5);`);
  const els = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL AND current_status='planned' AND mark='3Р19' ORDER BY id LIMIT 3").map((r) => r.id);
  exec(db, `UPDATE elements SET contract_id=${co("QA-старый")}, current_status='contracting' WHERE id IN (${els.join(",")});`);
  for (const id of els) exec(db, `INSERT INTO status_history (element_id, status, changed_by, contract_id, comment) VALUES (${id}, 'contracting', 'тест', ${co("QA-старый")}, 'QA');`);
}
export const CP_TABLES = ["counterparties", "counterparty_capacity", "agreements", "specifications", "contracts", "contract_lines", "contract_incidents", "elements", "status_history", "default_contracts"];
export const setInput = (b, sel, value) => b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('нет поля ${sel}');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
