// Проверка сверки пачки распределения В НАСТОЯЩЕМ БРАУЗЕРЕ на НАСТОЯЩЕМ backend с НАСТОЯЩИМ входом (безголовый Chrome, события мыши по DevTools).
// Сервер — scripts/real_auth_server.py на копии БД; данные готовит scripts/prep_alloc_case.py (позиция «A» с остатком).
//
//   node scripts/verify_alloc_browser.mjs <порт> <копия_БД(work.db)> <json_подготовки>
//
// Сценарии: (1) ответ потерян после commit, среднее изделие потом изменил другой пользователь → успех всей пачки НЕ заявлен;
// (2) ответ потерян после commit, вся пачка в ожидаемом состоянии → «текущее состояние соответствует», НЕ подтверждение запроса;
// (3) ответ потерян ДО записи → «не подтверждено», выбор сохранён, БД без изменений; (4) обычный успех → ответ сервера, остаток, состояние после перезагрузки.
import { launch } from "./cdp.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const [port, dbPath, prepPath] = process.argv.slice(2);
const prep = JSON.parse(readFileSync(prepPath, "utf8")).B;                    // позиция B: 8 изделий, 2 из них «Отгружен»/«Доставлен», остаток 4
const BASE = `http://127.0.0.1:${port}`;
const db = new DatabaseSync(dbPath);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const maxHist = one("SELECT COALESCE(MAX(id),0) m FROM status_history").m;
const FAILS = []; let checks = 0;
const check = (name, ok, detail = "") => { checks++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : " — " + detail}`); if (!ok) FAILS.push(name); };
const state = (ids) => all(`SELECT id,current_status s,contract_id c FROM elements WHERE id IN (${ids.join(",")}) ORDER BY id`);

function reset() {                                   // вернуть изделия позиции в исходное состояние (копия БД, только тестовая)
  const st = { [prep.ids[0]]: "shipped", [prep.ids[1]]: "delivered" };
  for (const id of prep.ids) db.prepare("UPDATE elements SET contract_id=NULL, current_status=? WHERE id=?").run(st[id] || "planned", id);
  db.prepare("DELETE FROM status_history WHERE id > ?").run(maxHist);
}

const b = await launch({ width: 1920, height: 1080 });
const txt = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent || ""`);
async function clickText(sel, text, root = "document") {   // настоящий щелчок мышью по центру элемента с текстом
  const r = await b.eval(`(()=>{const e=[...${root}.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!e)return null;e.scrollIntoView({block:"center"});const q=e.getBoundingClientRect();return{cx:q.x+q.width/2,cy:q.y+q.height/2}})()`);
  if (!r) throw new Error(`нет «${text}» в ${sel}`);
  await b.click(r.cx, r.cy);
}

async function login() {
  await b.goto(`${BASE}/v2?object_id=1#/ws-picker`, 800);
  if (await b.eval("!!document.querySelector('input[name=domain_login]')")) {
    await b.clickSel("input[name=domain_login]"); await b.type("admin");
    await b.clickSel("input[name=password]"); await b.type("Test-Pass-1234!"); await b.key("Enter");
  }
  await b.waitFor("!!document.querySelector('.ws-tabs')", 60000);
}
async function openAllocation() {                    // поставщик → контракт → позиция → «Выбрать N на схеме»
  await b.waitFor("[...document.querySelectorAll('.ws-tabs button')].some(x=>x.textContent==='Распределение')", 60000);
  await clickText(".ws-tabs button", "Распределение");
  await b.waitFor("!!document.querySelector('select[data-al=supplier]')", 30000);
  const sel = await b.eval(`(()=>{const s=document.querySelector('select[data-al=supplier]');return[...s.options].some(o=>o.textContent===${JSON.stringify(prep.sup)})})()`);
  if (!sel) throw new Error("поставщика нет в списке");
  await b.eval(`(()=>{const s=document.querySelector('select[data-al=supplier]');s.value=[...s.options].find(o=>o.textContent===${JSON.stringify(prep.sup)}).value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await b.waitFor(`!!document.querySelector('[data-al-c="${prep.cid}"]')`, 30000);
  await b.clickSel(`[data-al-c="${prep.cid}"]`);
  await b.waitFor(`[...document.querySelectorAll('[data-al-l]')].some(x=>x.textContent.includes(${JSON.stringify(prep.mark)}))`, 30000);
  await clickText("[data-al-l]", prep.mark);
  await b.waitFor("/Изделий этой позиции без контракта: \\d/.test(document.querySelector('#ws-panel-body')?.textContent||'')", 60000);
  await clickText("[data-al=pick]", "Выбрать");
  await b.waitFor("/Выделено: 4; подходят: 4/.test(document.querySelector('#ws-panel-body')?.textContent||'')", 30000);
}
async function submit() {                            // «Распределить» + подтверждение в диалоге
  await b.waitFor("!document.querySelector('[data-al=submit]').disabled", 15000);
  await b.clickSel("[data-al=submit]");
  await b.waitFor("!!document.querySelector('dialog[open], .v2-dialog, [role=dialog]')", 15000);
  await clickText("dialog[open] button, .v2-dialog button, [role=dialog] button", "Распределить", "document");
}
const posts = () => b.requests.filter((r) => r.method === "POST" && /\/allocations$/.test(r.url));
// Обёртка fetch на странице: mode "after" — запрос выполняется НАСТОЯЩЕЙ сетью, затем (по желанию) чужая правка, затем ответ «теряется»; mode "before" — до сервера не доходит
const wrap = (mode, mid) => b.eval(`(()=>{ if(!window.__rf) window.__rf = window.fetch.bind(window); const rf = window.__rf;
  window.fetch = async (u, o) => { if (o && o.method === "POST" && /\\/allocations$/.test(String(u))) {
      if (${JSON.stringify(mode)} === "before") throw new TypeError("network lost");
      await rf(u, o);
      ${mid ? `await rf('/elements/${mid}/status', {method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify({status:'in_production'})});` : ""}
      throw new TypeError("network lost"); }
    return rf(u, o); }; return true })()`);
const unwrap = () => b.eval("(()=>{ if(window.__rf) window.fetch = window.__rf; return true })()");

try {
  await login();
  const cand = prep.ids.slice(2, 6);                 // ожидаемая пачка: 4 «Запланирован» первыми (33360… по порядку)
  console.log("(1) ответ потерян после commit, СРЕДНЕЕ изделие потом изменил другой пользователь");
  reset(); await b.goto(`${BASE}/v2?object_id=1#/ws-picker`, 1500); await b.waitFor("!!document.querySelector('.ws-tabs')", 60000);
  await openAllocation(); const mid = cand[1]; await wrap("after", mid); await submit();
  await b.waitFor("/НЕОДНОЗНАЧНО/.test(document.querySelector('#ws-panel-body .ws-err')?.textContent||'')", 60000);
  const s1 = state(cand); const body1 = await txt("#ws-panel-body");
  check("предпосылка: крайние изделия в ожидаемом состоянии (контракт, «Контрактация»)", [s1[0], s1[3]].every((x) => x.c === prep.cid && x.s === "contracting"), JSON.stringify(s1));
  check("предпосылка: среднее изделие изменено другим пользователем", s1[1].s === "in_production" && s1[1].c === prep.cid, JSON.stringify(s1[1]));
  check("успех всей пачки НЕ заявлен (нет блока успеха и слов «Распределено: 4»)", !(await b.eval("!!document.querySelector('#ws-panel-body .ws-ok')")) && !/Распределено: 4|сервер подтвердил/.test(body1));
  check("показано, что соответствует 3 из 4 и названо изделие", /из 4 изд\. соответствуют результату распределения 3/.test(body1) && body1.includes(`№${mid}`), body1.slice(0, 400));
  check("ровно один POST /allocations, автоповтора нет", posts().length === 1, `POST: ${posts().length}`);
  check("состояние всей пачки прочитано одним запросом /allocation-state со всеми 4 id", b.requests.some((r) => /allocation-state\?ids=/.test(r.url) && cand.every((i) => r.url.includes(String(i)))));
  await unwrap();

  console.log("(2) ответ потерян после commit, вся пачка в ожидаемом состоянии");
  reset(); b.requests.length = 0; await b.goto(`${BASE}/v2?object_id=1#/ws-picker`, 1500); await b.waitFor("!!document.querySelector('.ws-tabs')", 60000);
  await openAllocation(); await wrap("after", null); await submit();
  await b.waitFor("/Сверка всей пачки: все 4 изд\\./.test(document.querySelector('#ws-panel-body .ws-warnbox')?.textContent||'')", 60000);
  const body2 = await txt("#ws-panel-body");
  check("сказано «текущее состояние», а не «запрос выполнен»", body2.includes("подтвердить, что его создал именно этот запрос, нельзя"));
  check("блока успеха нет", !(await b.eval("!!document.querySelector('#ws-panel-body .ws-ok')")));
  check("БД: все 4 на контракте, статусы (planned → contracting)", state(cand).every((x) => x.c === prep.cid && x.s === "contracting"));
  check("один POST, история +1 на изделие (не удвоена)", posts().length === 1 && one("SELECT COUNT(*) n FROM status_history WHERE id > ? AND element_id IN (" + cand.join(",") + ")", maxHist).n === 4);
  await unwrap();

  console.log("(3) ответ потерян ДО записи (запрос не дошёл)");
  reset(); b.requests.length = 0; await b.goto(`${BASE}/v2?object_id=1#/ws-picker`, 1500); await b.waitFor("!!document.querySelector('.ws-tabs')", 60000);
  await openAllocation(); const dbBefore = JSON.stringify(state(prep.ids)); await wrap("before"); await submit();
  await b.waitFor("/распределение не подтверждено: все 4 изд\\./.test(document.querySelector('#ws-panel-body .ws-err')?.textContent||'')", 60000);
  check("БД без изменений", JSON.stringify(state(prep.ids)) === dbBefore);
  check("выбор сохранён (кнопка снова доступна, выделено 4)", /Выделено: 4; подходят: 4/.test(await txt("#ws-panel-body")) && !(await b.eval("document.querySelector('[data-al=submit]').disabled")));
  await unwrap();

  console.log("(4) обычный успех и состояние после перезагрузки");
  b.requests.length = 0; await b.eval("document.querySelector('[data-al=submit]').click()");
  await b.waitFor("!!document.querySelector('dialog[open], .v2-dialog, [role=dialog]')", 15000);
  await clickText("dialog[open] button, .v2-dialog button, [role=dialog] button", "Распределить");
  await b.waitFor("/Распределено: 4 шт\\./.test(document.querySelector('#ws-panel-body .ws-ok')?.textContent||'')", 60000);
  check("ответ сервера: «Распределено: 4 шт.», остаток показан", /Остаток по позиции: 0 шт\./.test(await txt("#ws-panel-body .ws-ok")));
  check("БД: 4 изделия на контракте, 2 «Отгружен/Доставлен» не тронуты", state(cand).every((x) => x.c === prep.cid && x.s === "contracting") && state(prep.ids.slice(0, 2)).every((x) => x.c === null));
  await b.goto(`${BASE}/v2?object_id=1#/ws-picker`, 1500); await b.waitFor("!!document.querySelector('.ws-tabs')", 60000);
  await b.waitFor("[...document.querySelectorAll('.ws-tabs button')].some(x=>x.textContent==='Распределение')", 60000);
  await clickText(".ws-tabs button", "Распределение");
  await b.waitFor("!!document.querySelector('select[data-al=supplier]')", 30000);
  check("после перезагрузки страницы клиент показывает то же состояние сервера (остаток 0 по позиции)", await b.eval(`(()=>{const s=document.querySelector('select[data-al=supplier]');s.value=[...s.options].find(o=>o.textContent===${JSON.stringify(prep.sup)}).value;s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`));
  await b.waitFor(`!!document.querySelector('[data-al-c="${prep.cid}"]')`, 30000); await b.clickSel(`[data-al-c="${prep.cid}"]`);
  await b.waitFor(`[...document.querySelectorAll('[data-al-l]')].some(x=>x.textContent.includes(${JSON.stringify(prep.mark)}))`, 30000);
  const em = await b.eval(`[...document.querySelectorAll('[data-al-l]')].find(x=>x.textContent.includes(${JSON.stringify(prep.mark)})).querySelectorAll('em')[2].textContent.trim()`);
  check("остаток по позиции после перезагрузки = 0 (с сервера)", em === "0", `«${em}»`);
} catch (e) {
  console.log("ОШИБКА СЦЕНАРИЯ:", e.message); FAILS.push("сценарий: " + e.message);
  try { await b.shot(dbPath.replace(/work\.db$/, "fail.png")); } catch {}
} finally {
  check("в консоли страницы нет необработанных исключений", b.exceptions.length === 0, b.exceptions.slice(0, 2).join(" | "));
  await b.close();
}
console.log(`\nпроверок: ${checks}; нарушений: ${FAILS.length}`);
process.exit(FAILS.length ? 1 : 0);
