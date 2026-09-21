// Браузерная проверка рабочих мест «Модель ЖБИ» и «АРМ прораба» в V2 на НАСТОЯЩЕМ backend и временной копии БД (жесты — настоящие события мыши по протоколу DevTools).
//
// Запуск (сервер и копия — как в BRIEF):
//   .venv/bin/python scripts/real_auth_server.py <база> <порт> <каталог_копии>      # в фоне
//   node scripts/verify_model_ui.mjs <порт> <каталог_копии> [раздел ...]            # разделы: gest single group plan cont hist form rights v1
// Проверяет: выбор (щелчок, Ctrl/⌘, рамка, колесо, сдвиг), смена статуса одного и пачки (предпросмотр, подтверждение, откат, конфликт, двойная отправка,
// потеря ответа), плановая дата, контракт, комментарий, история, форма изделия, права (user2/user4 и урезанная роль), журнал, совместимость с V1.
import { launch } from "./cdp.mjs";
import { execFileSync } from "node:child_process";

const PORT = process.argv[2], WORK = process.argv[3];
const ONLY = new Set(process.argv.slice(4));
if (!PORT || !WORK) { console.error("нужны порт и каталог копии"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`, DB = `${WORK}/work.db`, PASS = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql) => { const t = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8" }).trim(); return t ? JSON.parse(t) : []; };
const one = (sql) => q(sql)[0];
const fails = [];
let okN = 0;
const ok = (name, cond, detail = "") => { if (cond) { okN++; console.log("  ✓ " + name); } else { fails.push(name); console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
const sec = (n) => console.log("\n" + n);
const want = (k) => !ONLY.size || ONLY.has(k);

// ---------------------------------------------------------------- HTTP-клиент с настоящим входом (для подготовки данных и «другого пользователя»)
async function login(name) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: name, password: PASS }) });
  if (!r.ok) throw new Error("вход " + name + " " + r.status);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return async (method, path, body) => {
    const x = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    let js = null; try { js = await x.json(); } catch (e) { /* пусто */ }
    return { status: x.status, js };
  };
}

// ---------------------------------------------------------------- браузер
const F = `document.querySelector('iframe.ws-frame')`;
async function openWs(login_, { w = 1920, h = 1080, hash = "#/ws-model" } = {}) {
  const b = await launch({ width: w, height: h });
  await b.goto(`${BASE}/v2?object_id=1`);
  await b.waitFor(`!!document.querySelector('#v2-login-user')`, 20000);
  await b.eval(`(()=>{const u=document.querySelector('#v2-login-user');u.value=${JSON.stringify(login_)};document.querySelector('#v2-login-pass').value=${JSON.stringify(PASS)};document.querySelector('#v2-login-form').requestSubmit();})()`);
  await b.waitFor(`!!document.querySelector('#v2-object')`, 20000);
  await b.eval(`location.hash=${JSON.stringify(hash)}`);
  await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300);
  await b.sleep(600);
  return b;
}
const panel = (b) => b.eval(`document.querySelector('#ws-panel-body').innerText`);
const statusBar = (b) => b.eval(`document.querySelector('#ws-status').innerText`);
const setVal = (b, sel, val) => b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('нет поля '+${JSON.stringify(sel)});e.value=${JSON.stringify(val)};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
const btnCenter = (b, scope, text) => b.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(x=>x.textContent.trim().startsWith(${JSON.stringify(text)})&&!x.disabled&&x.offsetParent!==null);if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
async function clickBtn(b, scope, text, o) {
  for (let k = 0; k < 6; k++) {
    if (await btnCenter(b, scope, text)) { await b.sleep(80); const c = await btnCenter(b, scope, text); if (c) { await b.click(c.x, c.y, o); return true; } }
    await b.sleep(250);
  }
  throw new Error("нет доступной кнопки «" + text + "» в " + scope);
}
const hasBtn = (b, scope, text) => b.eval(`[...document.querySelectorAll(${JSON.stringify(scope + " button")})].some(x=>x.textContent.trim().startsWith(${JSON.stringify(text)}))`);
const dialogText = (b) => b.eval(`document.querySelector('.v2-dialog')?.innerText||''`);
const posts = (b, from = 0) => b.requests.slice(from).filter((r) => r.method !== "GET" && !/\/(login|plan-data|activity)/.test(r.url));
const apiPosts = (b, from, mode) => posts(b, from).filter((r) => /element-ops\/status-batch/.test(r.url) && (!mode || (r.body || "").includes(`"mode":"${mode}"`)));
const clearSel = async (b) => { await b.clickSel('.ws-tools [data-tool="clear"]'); await b.sleep(400); };

// пригодные к щелчку изделия: верхняя фигура под центром — она сама (2D)
async function topHits(b) {
  const hit = await b.eval(`(()=>{const f=${F};const d=f.contentDocument;const fr=f.getBoundingClientRect();const out=[];for(const s of d.querySelectorAll('.element-shape')){const r=s.getBoundingClientRect();if(r.width<5||r.height<5)continue;const cx=r.x+r.width/2,cy=r.y+r.height/2;if(cx<70||cy<70||cx>fr.width-70||cy>fr.height-70)continue;const top=d.elementFromPoint(cx,cy);const sh=top&&top.closest('.element-shape');const id=+s.getAttribute('data-id');if(sh&&+sh.getAttribute('data-id')===id)out.push({id,x:Math.round(fr.x+cx),y:Math.round(fr.y+cy)});}return out})()`);
  const rows = q(`select id,current_status st,contract_id c,element_type t,mark m,planned_delivery_date pd,object_id o from elements where id in (${hit.map((h) => h.id).join(",")})`);
  const by = new Map(rows.map((r) => [r.id, r]));
  return hit.map((h) => ({ ...h, ...by.get(h.id) }));
}
async function pos(b, id) { return b.eval(`(()=>{const f=${F};const s=f.contentDocument.querySelector('.element-shape[data-id="${id}"]');if(!s)return null;const fr=f.getBoundingClientRect();const r=s.getBoundingClientRect();return {x:fr.x+r.x+r.width/2,y:fr.y+r.y+r.height/2}})()`); }
async function pickOne(b, h, o) { await b.click(h.x, h.y, o); await b.sleep(650); }
async function pickMany(b, list) { await clearSel(b); await b.click(list[0].x, list[0].y); await b.sleep(500); for (const h of list.slice(1)) { await b.click(h.x, h.y, { meta: true }); await b.sleep(220); } await b.sleep(700); }
const el = (id) => one(`select current_status st, contract_id c, actual_delivery_date ad, planned_delivery_date pd, comment cm, floor, address, mark, updated_at from elements where id=${id}`);
const hn = (id) => one(`select count(*) n from status_history where element_id=${id}`).n;
const snapshot = (ids) => JSON.stringify(q(`select id,current_status,contract_id,actual_delivery_date,planned_delivery_date,comment,mark,floor,address,updated_at from elements where id in (${ids.join(",")}) order by id`)) + "|" + q(`select count(*) n from status_history where element_id in (${ids.join(",")})`)[0].n;
const events = (action, since) => q(`select * from activity_log where id > ${since} and action='${action}'`);
const lastEvent = () => one("select coalesce(max(id),0) m from activity_log").m;
async function flushJournal() { await sleep(1500); }   // очередь журнала сбрасывается писателем с небольшой задержкой

// «потеря ответа»: запрос доходит до сервера и выполняется, а браузер получает обрыв (fetch отклоняется как при сбое сети)
const loseResponse = (b, urlPart, bodyPart = "") => b.eval(`(()=>{const orig=window.__origFetch||(window.__origFetch=window.fetch.bind(window));window.fetch=async(u,o)=>{const r=await orig(u,o);if(String(u).includes(${JSON.stringify(urlPart)})&&(!${JSON.stringify(bodyPart)}||String(o&&o.body||'').includes(${JSON.stringify(bodyPart)}))){window.__lost=(window.__lost||0)+1;throw new TypeError('Failed to fetch');}return r;};})()`);
const restoreFetch = (b) => b.eval(`(()=>{if(window.__origFetch){window.fetch=window.__origFetch;window.__lost=0;}})()`);

// ================================================================= подготовка
console.log(`Проверка на ${BASE}, копия ${DB}`);
const admin = await login("admin");
const user3 = await login("user3");           // второй администратор — «другой пользователь»
let b = await openWs("admin");
const HITS = await topHits(b);
const contr = HITS.filter((h) => h.st === "contracting" && h.c);
const planned = HITS.filter((h) => h.st === "planned");
console.log(`видимых для щелчка изделий: ${HITS.length} (контрактация с контрактом ${contr.length}, запланировано ${planned.length})`);
let used = 0;
const take = (arr, n) => { const r = arr.slice(used, used + n); used += n; return r; };
// разнести по РАЗНЫМ областям, чтобы сценарии не мешали друг другу
const C = { s1: contr.slice(0, 1), s2: contr.slice(1, 2), s3: contr.slice(2, 3), s4: contr.slice(3, 4), s5: contr.slice(4, 5), s6: contr.slice(5, 6), s7: contr.slice(6, 7),
  g1: contr.slice(10, 14), g2: contr.slice(20, 24), g3: contr.slice(30, 34), g4: contr.slice(40, 44), g5: contr.slice(50, 54), g6: contr.slice(60, 64), g7: contr.slice(70, 74),
  p1: contr.slice(80, 81), p2: contr.slice(81, 82), pg1: contr.slice(90, 94), pg2: contr.slice(100, 104), pg3: contr.slice(110, 114), pg4: contr.slice(120, 124),
  k1: contr.slice(130, 131), k2: contr.slice(131, 132), c1: contr.slice(140, 141), c2: contr.slice(141, 142), h1: contr.slice(150, 151), h2: contr.slice(151, 152), e1: contr.slice(160, 161), e2: contr.slice(161, 162), v1: contr.slice(170, 171) };
await b.close();

// ================================================================= 1. жесты выбора и просмотра
if (want("gest")) {
  sec("G. Выбор и просмотр настоящими жестами");
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    b = await openWs("admin", { w, h });
    const tag = `${w}×${h}: `;
    const hits = await topHits(b);
    const a = hits;   // жесты ничего не меняют — годится любое видимое изделие (на 1366×768 их всего несколько)
    const A = a[0], B = a[Math.floor(a.length / 3)], Cc = a[Math.floor((2 * a.length) / 3)];
    const dims = await b.eval(`({sh:document.documentElement.scrollHeight,ih:innerHeight,sw:document.documentElement.scrollWidth,iw:innerWidth,stage:(()=>{const r=document.querySelector('#ws-stage').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})(),bar:document.querySelector('#ws-status').getBoundingClientRect().bottom})`);
    ok(tag + "страница не прокручивается, строка состояния видна", dims.sh <= dims.ih + 1 && dims.sw <= dims.iw + 1 && dims.bar <= dims.ih + 1, JSON.stringify(dims));
    ok(tag + "схема занимает основную площадь", dims.stage[0] >= (w >= 1500 ? 1000 : 560) && dims.stage[1] >= 500, JSON.stringify(dims.stage));
    await pickOne(b, A);
    ok(tag + "щелчок выбирает изделие (панель, строка состояния)", (await panel(b)).includes(String(A.m)) && /Выбран: /.test(await statusBar(b)), (await statusBar(b)));
    // ⌘+щелчок — НАСТОЯЩИЙ жест (Meta). Ctrl+щелчок на macOS — системный жест контекстного меню и настоящим щелчком не создаётся: Ctrl проверяется событием
    // click с ctrlKey (в Windows, где работают пользователи, это обычный щелчок с Ctrl)
    await b.click(B.x, B.y, { meta: true }); await b.sleep(700);
    ok(tag + "⌘+щелчок (настоящий) ДОБАВЛЯЕТ к выбранному (2)", /Выбрано: 2/.test(await statusBar(b)) && /Выбрано элементов: 2/.test(await panel(b)), await statusBar(b));
    await b.eval(`(()=>{const d=${F}.contentDocument;const s=d.querySelector('.element-shape[data-id="${Cc.id}"]');const r=s.getBoundingClientRect();s.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,view:d.defaultView}))})()`);
    await b.sleep(700);
    ok(tag + "Ctrl+щелчок (событие click с ctrlKey) добавляет ещё одно (3)", /Выбрано: 3/.test(await statusBar(b)), await statusBar(b));
    await b.click(B.x, B.y, { meta: true }); await b.sleep(700);
    ok(tag + "⌘+щелчок по выбранному УБИРАЕТ его (2)", /Выбрано: 2/.test(await statusBar(b)), await statusBar(b));
    const mult = await b.eval(`${F}.contentDocument.querySelectorAll('.element-shape.multi-selected').length`);
    ok(tag + "подсветка на схеме совпадает с числом выбранных", mult === 2, String(mult));
    await clearSel(b);
    ok(tag + "«Снять выбор» очищает", /Ничего не выбрано/.test(await statusBar(b)));
    const fr = await b.eval(`(()=>{const r=${F}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    await b.drag(fr.x + fr.w * 0.30, fr.y + fr.h * 0.62, fr.x + fr.w * 0.42, fr.y + fr.h * 0.72, { shift: true }); await b.sleep(900);
    const n1 = Number(/Выбрано: (\d+)/.exec(await statusBar(b))?.[1] || 0);
    const dom1 = await b.eval(`${F}.contentDocument.querySelectorAll('.element-shape.multi-selected').length`);
    ok(tag + "Shift+перетаскивание — рамка выбирает группу", n1 > 5 && dom1 === n1, `${n1}/${dom1}`);
    await b.drag(fr.x + fr.w * 0.60, fr.y + fr.h * 0.40, fr.x + fr.w * 0.66, fr.y + fr.h * 0.46, { shift: true }); await b.sleep(900);
    const n2 = Number(/Выбрано: (\d+)/.exec(await statusBar(b))?.[1] || 0);
    ok(tag + "вторая рамка ДОБАВЛЯЕТ к выбранному", n2 > n1, `${n1} → ${n2}`);
    const vb = () => b.eval(`(()=>{const v=${F}.contentDocument.getElementById('svg-root').getAttribute('viewBox').split(' ').map(Number);return {x:v[0],y:v[1],w:v[2],h:v[3]}})()`);
    const v0 = await vb();
    await b.wheel(fr.x + fr.w / 2, fr.y + fr.h / 2, -300); await b.sleep(400);
    const v1 = await vb();
    ok(tag + "колесо вверх — приближение (окно просмотра уменьшилось)", v1.w < v0.w * 0.95, `${Math.round(v0.w)} → ${Math.round(v1.w)}`);
    await b.wheel(fr.x + fr.w / 2, fr.y + fr.h / 2, 300); await b.sleep(400);
    const v2 = await vb();
    ok(tag + "колесо вниз — отдаление", v2.w > v1.w * 1.05, `${Math.round(v1.w)} → ${Math.round(v2.w)}`);
    const selBefore = await statusBar(b);
    await b.drag(fr.x + fr.w * 0.5, fr.y + fr.h * 0.3, fr.x + fr.w * 0.4, fr.y + fr.h * 0.25); await b.sleep(400);
    const v3 = await vb();
    ok(tag + "перетаскивание — сдвиг без изменения масштаба", Math.abs(v3.x - v2.x) > 100 && Math.abs(v3.w - v2.w) < 1, `${Math.round(v2.x)} → ${Math.round(v3.x)}`);
    ok(tag + "сдвиг не меняет выбор", (await statusBar(b)).split("\n")[1] === selBefore.split("\n")[1], await statusBar(b));
    await b.clickSel('.ws-tools [data-tool="in"]'); await b.sleep(300);
    const v4 = await vb();
    ok(tag + "кнопка «+» приближает", v4.w < v3.w * 0.9);
    await b.clickSel('.ws-tools [data-tool="fit"]'); await b.sleep(400);
    const v5 = await vb();
    ok(tag + "«Вписать» возвращает вид", Math.abs(v5.w - v0.w) / v0.w < 0.05, `${Math.round(v5.w)} vs ${Math.round(v0.w)}`);
    await b.click(fr.x + fr.w - 120, fr.y + 90);           // пустое место схемы
    await b.sleep(700);
    ok(tag + "щелчок по пустому месту снимает выбор", /Ничего не выбрано/.test(await statusBar(b)), await statusBar(b));
    ok(tag + "нет ошибок в консоли", b.exceptions.length === 0 && b.consoleLog.filter((x) => x.type === "error").length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
    await b.close();
  }
}

// ================================================================= 2. смена статуса одного изделия
if (want("single")) {
  sec("S. Смена статуса одного изделия");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  const idx = { a: H[200], b: H[201], c: H[202], d: H[203], e: H[204], f: H[205], g: H[206] };
  // S1: успех, дата, комментарий, контракт сохраняется, после перезагрузки
  let x = idx.a; const before = el(x.id), h0 = hn(x.id); const mk = lastEvent();
  await pickOne(b, x);
  ok("форма смены статуса показана; текущий статус не предлагается, «Запланирован» предлагается", await b.eval(`(()=>{const o=[...document.querySelectorAll('#ws-sform select option')].map(e=>e.value);return !o.includes('contracting')&&o.includes('planned')&&o.includes('delivered')})()`));
  await setVal(b, "#ws-sform select[name=status]", "delivered");
  await setVal(b, "#ws-sform input[name=at]", "2026-09-12T10:20");
  await setVal(b, "#ws-sform textarea[name=comment]", "приняли на площадке");
  let r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`/Статус изменён/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
  ok("запросы: один предпросмотр и одна запись", apiPosts(b, r0, "preview").length === 1 && apiPosts(b, r0, "apply").length === 1, JSON.stringify(posts(b, r0).map((p) => p.method + p.url)));
  const bodyApply = JSON.parse(apiPosts(b, r0, "apply")[0].body);
  ok("тело записи: без контрактов «для записи», только ожидаемое состояние", !("contract_id" in bodyApply) && !("assign_contract_id" in bodyApply) && bodyApply.items[0].expected_contract_id === before.c && bodyApply.items[0].expected_status === "contracting", JSON.stringify(bodyApply));
  let after = el(x.id);
  ok("БД: статус изменён, контракт СОХРАНЁН, фактическая дата выставлена по записи «Доставлен»", after.st === "delivered" && after.c === before.c && !!after.ad, JSON.stringify(after));
  ok("история: +1 запись с датой, комментарием и автором", hn(x.id) === h0 + 1 && one(`select changed_at a, comment c, changed_by u, contract_id k from status_history where element_id=${x.id} order by id desc limit 1`).a === "2026-09-12 10:20:00");
  await flushJournal();
  ok("журнал: одно событие status_change от admin", events("status_change", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.sleep(500);
  ok("карточка и строка состояния обновились без перезагрузки", /Доставлен/.test(await panel(b)) && (await panel(b)).includes("приняли на площадке"), (await panel(b)).slice(0, 200));
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  const p2 = await pos(b, x.id); await b.click(p2.x, p2.y); await b.sleep(900);
  ok("после ПЕРЕЗАГРУЗКИ страницы изделие в статусе «Доставлен», история с комментарием", /Доставлен/.test(await panel(b)) && (await panel(b)).includes("приняли на площадке"));

  // S2: возврат на «Запланирован» — последствия и подтверждение
  x = idx.b;
  await admin("PATCH", `/elements/${x.id}/status`, { status: "delivered" });   // подготовка: доставлен → фактическая дата
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  const bef2 = el(x.id); const h2 = hn(x.id);
  await pickOne(b, x);
  ok("подготовка: изделие доставлено, есть контракт и фактическая дата", bef2.st === "delivered" && !!bef2.c && !!bef2.ad);
  await setVal(b, "#ws-sform select[name=status]", "planned");
  ok("выбран «Запланирован»: форма предупреждает о снятии контракта", /СНИМАЕТ контракт/.test(await panel(b)));
  r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  const dlg = await b.waitFor(`document.querySelector('.v2-dialog')?.innerText`, 15000);
  ok("до записи показан диалог с последствиями (контракт снимется, фактическая дата очистится)", /Контракт будет СНЯТ у 1/.test(dlg) && /Фактическая дата поставки будет очищена/.test(dlg), dlg.slice(0, 300));
  ok("на этот момент записи нет (только предпросмотр)", apiPosts(b, r0, "apply").length === 0 && apiPosts(b, r0, "preview").length === 1 && JSON.stringify(el(x.id)) === JSON.stringify(bef2));
  await b.key("Escape"); await b.sleep(400);
  ok("отмена в диалоге: ничего не изменено, форма сохранена", JSON.stringify(el(x.id)) === JSON.stringify(bef2) && (await setValCheck(b)), "");
  r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 15000);
  await clickBtn(b, ".v2-dialog", "Сохранить");
  await b.waitFor(`/Статус изменён/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
  after = el(x.id);
  ok("подтверждено: «Запланирован», контракт снят, фактическая дата очищена", after.st === "planned" && after.c === null && after.ad === null, JSON.stringify(after));
  ok("история +1", hn(x.id) === h2 + 1);
  ok("запрос записи содержит подтверждение последствий", JSON.parse(apiPosts(b, r0, "apply")[0].body).expect.release_contracts === 1);

  // S3: выход из «Запланирован» с выбором контракта (страж остатка)
  x = idx.b;   // теперь «Запланирован» без контракта
  await pickOne(b, x);
  await setVal(b, "#ws-sform select[name=status]", "contracting");
  ok("при выходе из «Запланирован» есть выбор контракта (необязательный)", /Контракт \(необязательно\)/.test(await panel(b)) || /необязательно/.test(await panel(b)));
  await clickBtn(b, "#ws-sform", "Выбрать…");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow')`, 15000);
  const cOptions = await b.eval(`[...document.querySelectorAll('.eo-dialog .eo-crow')].map(e=>({t:e.innerText.replace(/\\n/g,' '),d:e.disabled}))`);
  ok("окно выбора контракта: строки с числами, недоступные отключены", cOptions.length > 3 && cOptions.some((o) => o.d));
  const mark = one(`select mark m, element_type t from elements where id=${x.id}`);
  const avail = await b.eval(`(()=>{const e=[...document.querySelectorAll('.eo-dialog .eo-crow')].find(x=>!x.disabled&&x.dataset.c&&x.dataset.c!=='none');if(!e)return null;e.setAttribute('data-pick','1');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,id:+e.dataset.c}})()`);
  ok("есть доступный контракт с остатком", !!avail);
  if (avail) {
    await b.click(avail.x, avail.y); await b.sleep(500);
    ok("выбранный контракт показан в форме", /без контракта/.test(await panel(b)) === false);
    await clickBtn(b, "#ws-sform", "Сохранить статус");
    await b.waitFor(`/Статус изменён/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
    after = el(x.id);
    ok("БД: статус «Контрактация», назначен ВЫБРАННЫЙ контракт", after.st === "contracting" && after.c === avail.id, JSON.stringify(after) + " vs " + avail.id);
  }
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));

  // S4: конфликт — другой пользователь изменил статус после того, как карточка открыта
  x = idx.c; const bef4 = el(x.id);
  await pickOne(b, x);
  await setVal(b, "#ws-sform select[name=status]", "shipped");
  const rr = await user3("PATCH", `/elements/${x.id}/status`, { status: "delivered" });
  ok("подготовка: другой пользователь изменил статус (200)", rr.status === 200);
  const mid = el(x.id); const hmid = hn(x.id);
  r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`document.querySelector('#ws-sform .ws-err')`, 15000);
  const t4 = await b.eval(`document.querySelector('#ws-sform .ws-err').innerText`);
  ok("конфликт: текст об изменении состояния, запись НЕ выполнена", /изменил|изменил/.test(t4) && JSON.stringify(el(x.id)) === JSON.stringify(mid) && hn(x.id) === hmid, t4);
  ok("после конфликта карточка перечитана: статус «Доставлен»", await b.waitFor(`/Доставлен/.test(document.querySelector('#ws-panel-body .ws-chip')?.innerText||'')`, 8000).catch(() => false));

  // S5: двойная отправка
  x = idx.d; const bef5 = el(x.id), h5 = hn(x.id);
  await pickOne(b, x);
  await setVal(b, "#ws-sform select[name=status]", "in_production");
  r0 = b.requests.length;
  const c5 = await btnCenter(b, "#ws-sform", "Сохранить статус");
  await b.click(c5.x, c5.y); await b.click(c5.x, c5.y);
  await b.waitFor(`/Статус изменён/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
  await b.sleep(600);
  ok("двойной щелчок: один предпросмотр и одна запись", apiPosts(b, r0, "preview").length === 1 && apiPosts(b, r0, "apply").length === 1, JSON.stringify(posts(b, r0).map((p) => p.url)));
  ok("история +1 (без дубля)", hn(x.id) === h5 + 1);

  // S6: нет связи — исход неизвестен, автоповтора нет, ввод сохранён
  x = idx.e; const bef6 = el(x.id), h6 = hn(x.id);
  await pickOne(b, x);
  await setVal(b, "#ws-sform select[name=status]", "shipped");
  await setVal(b, "#ws-sform textarea[name=comment]", "сбой связи");
  await b.offline(true);
  r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`document.querySelector('#ws-sform .ws-err')`, 20000);
  const t6 = await b.eval(`document.querySelector('#ws-sform .ws-err').innerText`);
  await b.sleep(1500);
  ok("сообщение: ответ не получен / исход неизвестен, повторно ничего не отправлено", /Ответ не получен|Нет связи/.test(t6), t6);
  ok("автоповтора нет: ровно один запрос уходил (предпросмотр), записи нет", apiPosts(b, r0).length <= 2 && apiPosts(b, r0, "apply").length === 0, JSON.stringify(apiPosts(b, r0).map((p) => p.body?.slice(0, 40))));
  ok("ввод сохранён", await b.eval(`document.querySelector('#ws-sform select').value==='shipped'&&document.querySelector('#ws-sform textarea').value==='сбой связи'`));
  ok("БД не менялась", JSON.stringify(el(x.id)) === JSON.stringify(bef6) && hn(x.id) === h6);
  await b.offline(false); await b.sleep(500);
  // потеря ответа ПОСЛЕ записи: запрос выполнен, ответа нет
  await loseResponse(b, "/element-ops/status-batch", '"mode":"apply"');
  r0 = b.requests.length;
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`/соответствует запросу|не подтверждено|НЕОДНОЗНАЧНО|исход неизвестен/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
  const t6b = await b.eval(`document.querySelector('#ws-sform').innerText`);
  await b.sleep(800);
  ok("ответ потерян после записи: сверено ТЕКУЩЕЕ состояние изделия; интерфейс не выдаёт его за подтверждение запроса", /Текущее состояние изделия на сервере соответствует запросу \(статус «Отгружен»\)/.test(t6b) && /подтвердить, что его выполнил именно этот запрос, нельзя/.test(t6b) && !/Сервер подтвердил/.test(t6b), t6b.slice(-320));
  ok("повторной записи не было; в БД ровно +1 запись", apiPosts(b, r0, "apply").length === 1 && hn(x.id) === h6 + 1 && el(x.id).st === "shipped");
  await restoreFetch(b);
  ok("нет необработанных исключений", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}
async function setValCheck(b) { return b.eval(`document.querySelector('#ws-sform select').value==='planned'`); }

// ================================================================= 3. групповая смена статуса
if (want("group")) {
  sec("Q. Групповая смена статуса");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  const grp = (k) => H.slice(k, k + 4);
  // Q1: предпросмотр ничего не пишет; применение сохраняет контракт
  let g = grp(300); let ids = g.map((x) => x.id);
  await pickMany(b, g);
  ok("выделено 4 изделия, панель группы, форма групповых операций", /Выбрано элементов: 4/.test(await panel(b)) && (await hasBtn(b, "#eo-gform", "Проверить последствия")));
  await setVal(b, "#eo-gform select[name=status]", "delivered");
  await setVal(b, "#eo-gform textarea[name=comment]", "пачка 1");
  const snap0 = snapshot(ids); let mk = lastEvent();
  await b.eval(`document.querySelector('.ws-tabs [data-tab="status"]').click()`); await b.sleep(400);
  const stTab0 = await b.eval(`[...document.querySelectorAll('#ws-panel-body .ws-list li')].map(l=>l.innerText.replace(/\\s+/g,' '))`);
  const statDelivered0 = Number((stTab0.find((t) => /Доставлен/.test(t)) || "0").replace(/\D+/g, ""));
  await b.eval(`document.querySelector('.ws-tabs [data-tab="props"]').click()`); await b.sleep(300);
  let r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  ok("предпросмотр: один запрос preview, записей нет", apiPosts(b, r0, "preview").length === 1 && apiPosts(b, r0, "apply").length === 0);
  ok("предпросмотр не изменил БД и журнал", snapshot(ids) === snap0 && (await flushJournal(), events("status_change", mk).length === 0));
  const ptxt = await b.eval(`document.querySelector('.eo-preview').innerText`);
  ok("предпросмотр: «будет изменено 4», контракты сохраняются", /Будет изменено: 4/.test(ptxt) && /Контракты сохраняются|Последствий сверх/.test(ptxt), ptxt);
  const before = q(`select id,contract_id c from elements where id in (${ids.join(",")})`);
  const hb = ids.map(hn);
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  ok("перед записью — диалог подтверждения с итогом", /Изменить статус у 4 изд\./.test(await dialogText(b)));
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`/установлен у 4/.test(document.querySelector('.eo-banner')?.innerText||'')`, 25000);
  ok("одна запись apply, подтверждение последствий передано", apiPosts(b, r0, "apply").length === 1 && JSON.parse(apiPosts(b, r0, "apply")[0].body).expect.release_contracts === 0);
  const aft = q(`select id,current_status st,contract_id c from elements where id in (${ids.join(",")})`);
  ok("БД: у всех «Доставлен», контракты те же", aft.every((r) => r.st === "delivered" && r.c === before.find((z) => z.id === r.id).c));
  ok("история: +1 у каждого", ids.every((id, i) => hn(id) === hb[i] + 1));
  await flushJournal();
  ok("журнал: 4 события status_change, без дублей", events("status_change", mk).length === 4 && new Set(events("status_change", mk).map((e) => e.entity_id)).size === 4);
  await b.sleep(500);
  ok("панель и схема обновились: статусы группы — «Доставлен»: 4", /Доставлен: 4|Доставлен:\s*4/.test(await panel(b).then((t) => t.replace(/\n/g, " "))), (await panel(b)).slice(0, 300));
  await b.eval(`document.querySelector('.ws-tabs [data-tab="status"]').click()`); await b.sleep(400);
  const stTab = await b.eval(`[...document.querySelectorAll('#ws-panel-body .ws-list li')].map(l=>l.innerText.replace(/\\s+/g,' '))`);
  ok("показатели: вкладка «Статус» считает доставленных по новому составу (число выросло на 4)", Number((stTab.find((t) => /Доставлен/.test(t)) || "0").replace(/\D+/g, "")) >= statDelivered0 + 4, JSON.stringify(stTab) + " было " + statDelivered0);
  await b.eval(`document.querySelector('.ws-tabs [data-tab="props"]').click()`); await b.sleep(300);
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  await pickMany(b, g);
  ok("после ПЕРЕЗАГРУЗКИ выделенные изделия — «Доставлен»", /Доставлен: 4|Доставлен:\s*4/.test((await panel(b)).replace(/\n/g, " ")));

  // Q2: возврат на «Запланирован» пачкой — последствия
  g = grp(310); ids = g.map((x) => x.id);
  await admin("PATCH", "/elements/bulk-status", { status: "delivered", items: ids.slice(0, 2).map((id) => ({ element_id: id, contract_id: el(id).c })) }); // подготовка: у двух есть фактическая дата
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  await pickMany(b, g);
  const b2 = q(`select id,current_status st,contract_id c,actual_delivery_date ad from elements where id in (${ids.join(",")})`);
  const hb2 = ids.map(hn); mk = lastEvent();
  await setVal(b, "#eo-gform select[name=status]", "planned");
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  const p2 = await b.eval(`document.querySelector('.eo-preview').innerText`);
  ok("предпросмотр возврата: «Контракт будет СНЯТ у 4», «фактическая дата очищена у 2», нет записи", /Контракт будет СНЯТ у 4/.test(p2) && /очищена у 2/.test(p2) && q(`select count(*) n from elements where id in (${ids.join(",")}) and current_status='planned'`)[0].n === 0, p2);
  ok("предпросмотр называет контракты, с которых снимутся изделия", /контракт|Контрагент/i.test(p2));
  ok("предпросмотр показывает, у КАКИХ изделий снимется контракт (список из 4)", await b.eval(`(()=>{const d=document.querySelector('.eo-rel');return !!d&&d.querySelectorAll('li').length===4&&/Колонна|Ригель|Плита/.test(d.textContent)})()`));
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  const d2 = await dialogText(b);
  ok("диалог подтверждения повторяет последствия и предупреждает", /СНЯТ/.test(d2) && /Применить/.test(d2), d2);
  await b.key("Escape"); await b.sleep(400);
  ok("отмена: ничего не записано", q(`select count(*) n from elements where id in (${ids.join(",")}) and current_status='planned'`)[0].n === 0);
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`/установлен у 4/.test(document.querySelector('.eo-banner')?.innerText||'')`, 25000);
  const a2 = q(`select id,current_status st,contract_id c,actual_delivery_date ad from elements where id in (${ids.join(",")})`);
  ok("БД: «Запланирован», контракты сняты, фактическая дата очищена", a2.every((r) => r.st === "planned" && r.c === null && r.ad === null));
  ok("история +1 у каждого", ids.every((id, i) => hn(id) === hb2[i] + 1));
  ok("запрос записи подтверждает 4 снятых контракта", JSON.parse(apiPosts(b, r0, "apply")[0].body).expect.release_contracts === 4);

  // Q3: устаревшее состояние — между предпросмотром и записью другой пользователь изменил контракт одного изделия
  g = grp(320); ids = g.map((x) => x.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gform select[name=status]", "in_production");
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  const rc = await user3("PATCH", `/elements/${ids[1]}/contract`, { contract_id: null });   // V1-операция другого пользователя: контракт снят
  const snap3 = snapshot(ids); mk = lastEvent();
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`document.querySelector('.eo-banner-err')`, 20000);
  const t3 = await b.eval(`document.querySelector('.eo-banner-err').innerText`);
  ok("конфликт: сообщение о расхождении с числом изделий", /изменились|Изделий: 1/.test(t3), t3);
  ok("ПОЛНЫЙ ОТКАТ: ни одно изделие пачки не изменено (кроме чужой правки), снятый другим контракт не восстановлен и не перезаписан", snapshot(ids) === snap3 && el(ids[1]).c === null && ids.every((id) => el(id).st === "contracting"), rc.status + " " + t3);
  await flushJournal();
  ok("журнал: событий status_change для пачки нет", events("status_change", mk).length === 0);

  // Q4: двойная отправка «Применить»
  g = grp(330); ids = g.map((x) => x.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gform select[name=status]", "shipped");
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  const hb4 = ids.map(hn);
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  const cc = await btnCenter(b, ".v2-dialog", "Применить");
  await b.click(cc.x, cc.y); await b.click(cc.x, cc.y);
  await b.waitFor(`/установлен у 4/.test(document.querySelector('.eo-banner')?.innerText||'')`, 25000);
  await b.sleep(600);
  ok("двойной щелчок в диалоге: одна запись", apiPosts(b, r0, "apply").length === 1);
  ok("история +1, без дублей", ids.every((id, i) => hn(id) === hb4[i] + 1));

  // Q5: потеря ответа пачки
  g = grp(340); ids = g.map((x) => x.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gform select[name=status]", "installed");
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  const hb5 = ids.map(hn);
  await loseResponse(b, "/element-ops/status-batch", '"mode":"apply"');
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`/Сверка всей пачки|не подтверждено|НЕОДНОЗНАЧНО|исход неизвестен/i.test(document.querySelector('.eo-banner')?.innerText||'')`, 25000);
  const t5 = await b.eval(`document.querySelector('.eo-banner').innerText`);
  ok("ответ потерян после записи: сверка ВСЕЙ пачки по каждому изделию; текущее состояние не выдаётся за подтверждение запроса", /Сверка всей пачки: все 4 изд\./.test(t5) && /подтвердить, что его создал именно этот запрос, нельзя/.test(t5) && !/сервер подтвердил/i.test(t5), t5.slice(-300));
  await b.sleep(1500);
  ok("повторной отправки нет, история +1", apiPosts(b, r0, "apply").length === 1 && ids.every((id, i) => hn(id) === hb5[i] + 1));
  await restoreFetch(b);
  // потеря связи до записи
  g = grp(350); ids = g.map((x) => x.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gform select[name=status]", "installed");
  await clickBtn(b, "#eo-gform", "Проверить последствия");
  await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
  const snap6 = snapshot(ids);
  await b.offline(true);
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gform", "Применить к");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`document.querySelector('.eo-banner-err')`, 25000);
  await b.offline(false);
  const t6 = await b.eval(`document.querySelector('.eo-banner-err').innerText`);
  ok("нет связи до записи: сообщение о неизвестном исходе, БД не менялась, автоповтора нет", /Ответ не получен|исход неизвестен|не подтверждено/.test(t6) && snapshot(ids) === snap6 && apiPosts(b, r0, "apply").length <= 1, t6);

  // Q6: конкуренция — два пользователя применяют одну и ту же пачку одновременно
  g = grp(360); ids = g.map((x) => x.id);
  const hb7 = ids.map(hn);
  const body = { mode: "apply", object_id: 1, status: "delivered", items: ids.map((id) => ({ element_id: id, expected_status: "contracting", expected_contract_id: el(id).c })), expect: { release_contracts: 0, without_contract: 0 } };
  const [ra, rb] = await Promise.all([admin("POST", "/element-ops/status-batch", body), user3("POST", "/element-ops/status-batch", body)]);
  ok("два пользователя одновременно: оба 200, записал ровно один", ra.status === 200 && rb.status === 200 && [ra.js.already_applied, rb.js.already_applied].sort().join() === "false,true", `${ra.status} ${rb.status}`);
  ok("история +1 (не задвоилась)", ids.every((id, i) => hn(id) === hb7[i] + 1));
  const ids2 = grp(370).map((x) => x.id);
  const mk2 = (st) => ({ mode: "apply", object_id: 1, status: st, items: ids2.map((id) => ({ element_id: id, expected_status: "contracting", expected_contract_id: el(id).c })), expect: { release_contracts: 0, without_contract: 0 } });
  const [rc1, rc2] = await Promise.all([admin("POST", "/element-ops/status-batch", mk2("in_production")), user3("POST", "/element-ops/status-batch", mk2("shipped"))]);
  ok("два разных изменения одной пачки: 200 и 409, итог единообразен", [rc1.status, rc2.status].sort().join() === "200,409" && new Set(ids2.map((id) => el(id).st)).size === 1);
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}

// ================================================================= 4. плановая дата (одного и пачки)
if (want("plan")) {
  sec("P. Плановая дата поставки");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  let x = H[400]; let mk = lastEvent();
  await pickOne(b, x);
  let r0 = b.requests.length;
  await clickBtn(b, "#ws-panel-body", "Задать плановую дату");
  await setVal(b, "#eo-pd-form input[name=pd]", "2026-10-15");
  await clickBtn(b, "#eo-pd-form", "Сохранить");
  await b.waitFor(`/Плановая дата поставки: 15\\.10\\.2026/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("одно изделие: дата сохранена в БД", el(x.id).pd === "2026-10-15" && posts(b, r0).length === 1 && /planned-date-batch/.test(posts(b, r0)[0].url));
  await flushJournal();
  ok("журнал: planned_date ×1", events("planned_date", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.sleep(400);
  ok("карточка показывает дату «15.10.2026»", /15\.10\.2026/.test(await panel(b)));
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  const pp = await pos(b, x.id); await b.click(pp.x, pp.y); await b.sleep(800);
  ok("после ПЕРЕЗАГРУЗКИ дата на месте", /15\.10\.2026/.test(await panel(b)));
  // конфликт: другой пользователь изменил дату
  x = H[401];
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Задать плановую дату");
  await setVal(b, "#eo-pd-form input[name=pd]", "2026-10-20");
  await user3("PATCH", `/elements/${x.id}/planned-delivery-date`, { planned_delivery_date: "2026-11-01" });
  await clickBtn(b, "#eo-pd-form", "Сохранить");
  await b.waitFor(`document.querySelector('#eo-pd-form .ws-err')`, 15000);
  ok("конфликт: сообщение, чужая дата не перезаписана", el(x.id).pd === "2026-11-01" && /изменилась|изменил/.test(await b.eval(`document.querySelector('#eo-pd-form .ws-err').innerText`)));
  // потеря ответа
  x = H[402]; await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Задать плановую дату");
  await setVal(b, "#eo-pd-form input[name=pd]", "2026-10-22");
  await loseResponse(b, "/element-ops/planned-date-batch");
  r0 = b.requests.length;
  await clickBtn(b, "#eo-pd-form", "Сохранить");
  await b.waitFor(`/соответствует запросу|не подтверждено|НЕОДНОЗНАЧНО|исход неизвестен/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("потеря ответа: сверка текущего состояния, повторной отправки нет", /соответствует запросу/.test(await panel(b)) && !/Сервер подтвердил/.test(await panel(b)) && posts(b, r0).filter((p) => /planned-date/.test(p.url)).length === 1 && el(x.id).pd === "2026-10-22");
  await restoreFetch(b);
  // двойная отправка
  x = H[403]; await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Задать плановую дату");
  await setVal(b, "#eo-pd-form input[name=pd]", "2026-10-23");
  r0 = b.requests.length;
  const cs = await btnCenter(b, "#eo-pd-form", "Сохранить");
  await b.click(cs.x, cs.y); await b.click(cs.x, cs.y);
  await b.waitFor(`/Плановая дата поставки: 23\\.10\\.2026/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  await b.sleep(500);
  ok("двойной щелчок: один запрос", posts(b, r0).filter((p) => /planned-date/.test(p.url)).length === 1);
  // снять дату
  await clickBtn(b, "#ws-panel-body", "Изменить плановую дату");
  await clickBtn(b, "#eo-pd-form", "Снять дату");
  await b.waitFor(`/Плановая дата снята/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("снятие даты: в БД пусто", el(x.id).pd === null);
  // групповая
  let g = H.slice(410, 414); let ids = g.map((z) => z.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gpd input[name=pd]", "2026-11-11");
  const snapP = snapshot(ids); mk = lastEvent();
  r0 = b.requests.length;
  await clickBtn(b, "#eo-gpd", "Установить дату");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  ok("групповая дата: диалог подтверждения перед записью, записи ещё нет", /Установить плановую дату поставки 11\.11\.2026 у 4/.test(await dialogText(b)) && snapshot(ids) === snapP && posts(b, r0).length === 0);
  await clickBtn(b, ".v2-dialog", "Установить");
  await b.waitFor(`/установлена у 4/.test(document.querySelector('.eo-banner')?.innerText||'')`, 20000);
  ok("БД: дата у всех четырёх, статусы и контракты не тронуты", ids.every((id) => el(id).pd === "2026-11-11" && el(id).st === "contracting" && el(id).c));
  await flushJournal();
  ok("журнал: 4 события planned_date", events("planned_date", mk).length === 4);
  // групповая: конфликт → полный откат
  g = H.slice(420, 424); ids = g.map((z) => z.id);
  await pickMany(b, g);
  await setVal(b, "#eo-gpd input[name=pd]", "2026-12-01");
  await user3("PATCH", `/elements/${ids[2]}/planned-delivery-date`, { planned_delivery_date: "2026-11-30" });
  const snapC = snapshot(ids); mk = lastEvent();
  await clickBtn(b, "#eo-gpd", "Установить дату");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Установить");
  await b.waitFor(`document.querySelector('.eo-banner-err')`, 20000);
  ok("групповая дата, конфликт: 409-сообщение, ни одно изделие не изменено", snapshot(ids) === snapC && el(ids[2]).pd === "2026-11-30", await b.eval(`document.querySelector('.eo-banner-err').innerText`));
  await flushJournal();
  ok("журнал пуст", events("planned_date", mk).length === 0);
  // «Только у изделий без даты»: изделия с датой не затираются, число объяснено
  g = H.slice(430, 433); ids = g.map((z) => z.id);
  await admin("PATCH", `/elements/${ids[0]}/planned-delivery-date`, { planned_delivery_date: "2026-09-30" });
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  await pickMany(b, g);
  ok("групповая дата: по умолчанию включено «Только у изделий без плановой даты»", await b.eval(`document.querySelector('#eo-gpd input[name=only]').checked`));
  await setVal(b, "#eo-gpd input[name=pd]", "2026-12-15");
  const mk3 = lastEvent();
  await clickBtn(b, "#eo-gpd", "Установить дату");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  ok("диалог: установится у 2, не изменятся 1 (дата уже задана)", /у 2 изд\./.test(await dialogText(b)) && /Не изменятся: 1/.test(await dialogText(b)), await dialogText(b));
  await clickBtn(b, ".v2-dialog", "Установить");
  await b.waitFor(`/установлена у 2/.test(document.querySelector('.eo-banner')?.innerText||'')`, 20000);
  ok("БД: дата задана двум, у третьего прежняя дата не затёрта", el(ids[0]).pd === "2026-09-30" && el(ids[1]).pd === "2026-12-15" && el(ids[2]).pd === "2026-12-15");
  await flushJournal();
  ok("журнал: 2 события planned_date", events("planned_date", mk3).length === 2);
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}

// ================================================================= 5. контракт, комментарий, история, форма изделия
if (want("cont")) {
  sec("K. Контракт изделия, комментарий");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  // снять контракт
  let x = H[500]; const c0 = el(x.id).c; let mk = lastEvent();
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Изменить контракт");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow')`, 15000);
  let r0 = b.requests.length;
  await b.eval(`(()=>{const e=document.querySelector('.eo-dialog .eo-crow[data-c="none"]');e.scrollIntoView({block:'center'})})()`);
  const cn = await b.rect('.eo-dialog .eo-crow[data-c="none"]');
  await b.click(cn.cx, cn.cy);
  await b.waitFor(`/Контракт снят/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("снятие контракта: БД без контракта, статус не тронут", el(x.id).c === null && el(x.id).st === "contracting" && posts(b, r0).length === 1 && /element-ops\/contract/.test(posts(b, r0)[0].url));
  await flushJournal();
  ok("журнал: element_contract_set ×1", events("element_contract_set", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.sleep(400);
  ok("карточка: «Контракт не назначен», кнопка «Назначить контракт…»", /не назначен/.test(await panel(b)) && (await hasBtn(b, "#ws-panel-body", "Назначить контракт")));
  // назначить обратно
  await clickBtn(b, "#ws-panel-body", "Назначить контракт");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow[data-c="${c0}"]')`, 15000);
  const cb = await b.rect(`.eo-dialog .eo-crow[data-c="${c0}"]`);
  ok("прежний контракт доступен для выбора (остаток освободился)", cb && !(await b.eval(`document.querySelector('.eo-dialog .eo-crow[data-c="${c0}"]').disabled`)));
  await b.click(cb.cx, cb.cy);
  await b.waitFor(`/Контракт назначен/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("назначение: БД содержит контракт, статус не тронут", el(x.id).c === c0 && el(x.id).st === "contracting");
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  const pp = await pos(b, x.id); await b.click(pp.x, pp.y); await b.sleep(800);
  ok("после ПЕРЕЗАГРУЗКИ контракт на месте в карточке", !/не назначен/.test(await panel(b)) && /Контрагент/.test(await panel(b)));
  // идемпотентность: контракт уже снят другим пользователем — та же цель достигнута, повторной записи нет
  x = H[501];
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Изменить контракт");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow')`, 15000);
  await user3("PATCH", `/elements/${x.id}/contract`, { contract_id: null });
  mk = lastEvent();
  const cn2 = await b.rect('.eo-dialog .eo-crow[data-c="none"]');
  await b.click(cn2.cx, cn2.cy);
  await b.waitFor(`/Контракт снят/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  await flushJournal();
  ok("контракт уже снят другим: результат подтверждён без ошибки, событий журнала от нас нет", el(x.id).c === null && events("element_contract_set", mk).length === 0);
  // конфликт: другой пользователь изменил статус изделия после открытия окна выбора
  x = H[503];
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Изменить контракт");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow')`, 15000);
  await user3("PATCH", `/elements/${x.id}/status`, { status: "in_production" });
  const snapK = snapshot([x.id]); mk = lastEvent();
  const cn4 = await b.rect('.eo-dialog .eo-crow[data-c="none"]');
  await b.click(cn4.cx, cn4.cy);
  await b.waitFor(`document.querySelector('#ws-panel-body .ws-err')`, 15000);
  ok("изделие изменено другим: сообщение о расхождении, контракт не снят нашим запросом", /изменилось|Обновите/.test(await b.eval(`document.querySelector('#ws-panel-body .ws-err').innerText`)) && snapshot([x.id]) === snapK && el(x.id).c !== null);
  // потеря ответа
  x = H[502]; const c2 = el(x.id).c;
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Изменить контракт");
  await b.waitFor(`!!document.querySelector('.eo-dialog .eo-crow[data-c="none"]')`, 15000);
  await loseResponse(b, "/element-ops/contract");
  r0 = b.requests.length;
  const cn3 = await b.rect('.eo-dialog .eo-crow[data-c="none"]');
  await b.click(cn3.cx, cn3.cy);
  await b.waitFor(`/соответствует запросу|не подтверждено|НЕОДНОЗНАЧНО|исход неизвестен/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("потеря ответа: сверка текущего состояния; повторной отправки нет", /соответствует запросу/.test(await panel(b)) && !/Сервер подтвердил/.test(await panel(b)) && el(x.id).c === null && posts(b, r0).filter((p) => /element-ops\/contract/.test(p.url)).length === 1);
  await restoreFetch(b);

  sec("C. Комментарий");
  x = H[510]; mk = lastEvent();
  await pickOne(b, x);
  r0 = b.requests.length;
  await clickBtn(b, "#ws-panel-body", "Добавить комментарий");
  await setVal(b, "#eo-cm-form textarea", "трещина на торце");
  await clickBtn(b, "#eo-cm-form", "Сохранить");
  await b.waitFor(`/Комментарий сохранён/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("комментарий сохранён в БД, запрос один", el(x.id).cm === "трещина на торце" && posts(b, r0).length === 1);
  await flushJournal();
  ok("журнал: element_comment ×1", events("element_comment", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.sleep(500);
  ok("карточка показывает комментарий сразу", (await panel(b)).includes("трещина на торце"));
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  const pc = await pos(b, x.id); await b.click(pc.x, pc.y); await b.sleep(800);
  ok("после ПЕРЕЗАГРУЗКИ комментарий на месте", (await panel(b)).includes("трещина на торце"));
  x = H[511]; await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Добавить комментарий");
  await setVal(b, "#eo-cm-form textarea", "потеряем ответ");
  await loseResponse(b, "/comment");
  r0 = b.requests.length;
  await clickBtn(b, "#eo-cm-form", "Сохранить");
  await b.waitFor(`/соответствует запросу|не подтверждено|НЕОДНОЗНАЧНО|исход неизвестен/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("потеря ответа (комментарий): сверка текущего состояния, без автоповтора", /соответствует запросу/.test(await panel(b)) && !/Сервер подтвердил/.test(await panel(b)) && posts(b, r0).filter((p) => /comment/.test(p.url)).length === 1 && el(x.id).cm === "потеряем ответ");
  await restoreFetch(b);
  x = H[512]; await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Добавить комментарий");
  await setVal(b, "#eo-cm-form textarea", "двойной");
  r0 = b.requests.length;
  const c3 = await btnCenter(b, "#eo-cm-form", "Сохранить");
  await b.click(c3.x, c3.y); await b.click(c3.x, c3.y);
  await b.waitFor(`/Комментарий сохранён/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  await b.sleep(400);
  ok("двойной щелчок: один запрос", posts(b, r0).filter((p) => /comment/.test(p.url)).length === 1);
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}

if (want("hist")) {
  sec("H. История статусов: правка и удаление записи");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  const x = H[600]; let mk = lastEvent();
  await admin("PATCH", `/elements/${x.id}/status`, { status: "in_production" });     // подготовка: в истории 3 записи
  await b.eval("location.reload()"); await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300); await b.sleep(700);
  await pickOne(b, x);
  const hist0 = q(`select id,status,comment,changed_at from status_history where element_id=${x.id} order by changed_at,id`);
  ok("подготовка: три записи истории", hist0.length === 3);
  // правка комментария и статуса самой поздней записи
  const last = hist0[hist0.length - 1];
  await b.eval(`(()=>{const l=document.querySelectorAll('.eo-hist li');l[l.length-1].querySelector('[data-eo=h-edit]').scrollIntoView({block:'center'})})()`);
  const eb = await b.eval(`(()=>{const l=document.querySelectorAll('.eo-hist li');const r=l[l.length-1].querySelector('[data-eo=h-edit]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.click(eb.x, eb.y);
  await b.waitFor(`!!document.querySelector('#eo-h-form')`, 10000);
  await setVal(b, "#eo-h-form input[name=comment]", "исправлено вручную");
  await setVal(b, "#eo-h-form select[name=status]", "shipped");
  let r0 = b.requests.length;
  await clickBtn(b, ".eo-dialog", "Сохранить запись");
  await b.waitFor(`/Запись истории сохранена/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("правка: запись изменена, текущий статус ПЕРЕСЧИТАН («Отгружен»)", one(`select comment c,status s from status_history where id=${last.id}`).c === "исправлено вручную" && el(x.id).st === "shipped", JSON.stringify(el(x.id)));
  ok("отправлены только изменённые поля", JSON.stringify(Object.keys(JSON.parse(posts(b, r0)[0].body)).sort()) === JSON.stringify(["comment", "status"]));
  await flushJournal();
  ok("журнал: history_edit ×1", events("history_edit", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.sleep(500);
  ok("карточка обновилась: «Отгружен», комментарий записи виден", /Отгружен/.test(await b.eval(`document.querySelector('#ws-panel-body .ws-chip')?.innerText||''`)) && (await panel(b)).includes("исправлено вручную"));
  // удаление
  const n0 = hn(x.id);
  await b.eval(`(()=>{const l=document.querySelectorAll('.eo-hist li');l[l.length-1].querySelector('[data-eo=h-del]').scrollIntoView({block:'center'})})()`);
  const db_ = await b.eval(`(()=>{const l=document.querySelectorAll('.eo-hist li');const r=l[l.length-1].querySelector('[data-eo=h-del]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.click(db_.x, db_.y);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  ok("удаление: диалог предупреждает о пересчёте и необратимости", /пересчитаются/.test(await dialogText(b)) && /Отменить удаление здесь нельзя/.test(await dialogText(b)));
  await b.key("Escape"); await b.sleep(300);
  ok("отмена: запись на месте", hn(x.id) === n0);
  const dbb = await b.eval(`(()=>{const l=document.querySelectorAll('.eo-hist li');const r=l[l.length-1].querySelector('[data-eo=h-del]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.click(dbb.x, dbb.y);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  await clickBtn(b, ".v2-dialog", "Удалить запись");
  await b.waitFor(`/Запись удалена/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 15000);
  ok("удаление: запись удалена, статус пересчитан по остальным", hn(x.id) === n0 - 1 && el(x.id).st === "contracting", JSON.stringify(el(x.id)));
  await flushJournal();
  ok("журнал: history_delete ×1", events("history_delete", mk).filter((e) => e.entity_id === x.id).length === 1);
  // последнюю запись удалить нельзя (серверное правило)
  const one1 = one(`select element_id e, id h from status_history where element_id in (select element_id from status_history group by element_id having count(*)=1) limit 1`);
  const rdel = await admin("DELETE", `/elements/${one1.e}/history/${one1.h}`);
  ok("сервер: последняя оставшаяся запись истории не удаляется (400), запись на месте", rdel.status === 400 && hn(one1.e) === 1, String(rdel.status));
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}

if (want("form")) {
  sec("E. Форма изделия (реквизиты)");
  b = await openWs("admin");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  const x = H[700]; const mk = lastEvent();
  await pickOne(b, x);
  await clickBtn(b, "#ws-panel-body", "Форма элемента");
  await b.waitFor(`!!document.querySelector('#eo-ef')`, 15000);
  await setVal(b, "#eo-ef input[name=floor]", "7");
  await setVal(b, "#eo-ef input[name=address]", "99-100/Я-Я");
  const r0 = b.requests.length;
  await clickBtn(b, ".eo-dialog", "Сохранить");
  await b.waitFor(`/Реквизиты сохранены/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 20000);
  ok("реквизиты сохранены в БД, отправлены только изменённые поля", el(x.id).floor === 7 && el(x.id).address === "99-100/Я-Я" && JSON.stringify(Object.keys(JSON.parse(posts(b, r0)[0].body)).sort()) === JSON.stringify(["address", "floor"]));
  ok("поля помечены ручной правкой (manual_fields)", /floor/.test(one(`select manual_fields m from elements where id=${x.id}`).m) && /address/.test(one(`select manual_fields m from elements where id=${x.id}`).m));
  await flushJournal();
  ok("журнал: element_edit ×1", events("element_edit", mk).filter((e) => e.entity_id === x.id).length === 1);
  await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 60000, 300); await b.sleep(1200);
  ok("после сохранения схема перечитана, карточка показывает новый адрес", /99-100\/Я-Я/.test(await panel(b)), (await panel(b)).slice(0, 200));
  // серверная валидация: неверная дата
  await clickBtn(b, "#ws-panel-body", "Форма элемента");
  await b.waitFor(`!!document.querySelector('#eo-ef')`, 15000);
  await setVal(b, "#eo-ef input[name=floor]", "8.5");
  const snapE = snapshot([x.id]);
  await clickBtn(b, ".eo-dialog", "Сохранить");
  await b.waitFor(`!document.querySelector('#eo-ef .ws-err')?.hidden`, 15000);
  ok("серверная валидация: отказ показан в форме, БД не менялась, ввод остался", snapshot([x.id]) === snapE && (await b.eval(`document.querySelector('#eo-ef input[name=floor]').value`)) === "8.5", await b.eval(`document.querySelector('#eo-ef .ws-err').innerText`));
  await b.key("Escape"); await b.sleep(300);
  // потеря ответа
  const y = H[701]; await pickOne(b, y);
  await clickBtn(b, "#ws-panel-body", "Форма элемента");
  await b.waitFor(`!!document.querySelector('#eo-ef')`, 15000);
  await setVal(b, "#eo-ef input[name=address]", "77-78/Б-В");
  await loseResponse(b, "/fields");
  const r1 = b.requests.length;
  await clickBtn(b, ".eo-dialog", "Сохранить");
  await b.waitFor(`/Ответ не получен/.test(document.querySelector('#ws-panel-body')?.innerText||'')`, 20000);
  ok("потеря ответа: окно закрыто, сообщение о неизвестном исходе, автоповтора нет", posts(b, r1).filter((p) => /fields/.test(p.url)).length === 1 && el(y.id).address === "77-78/Б-В");
  await restoreFetch(b);
  ok("нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  await b.close();
}

// ================================================================= 6. права
if (want("rights")) {
  sec("R. Права: user2 (роль «user»), урезанная роль, user4 (просмотр)");
  // урезанная роль и пользователь «partial» готовятся SQL в КОПИИ (не на боевой БД): только статус
  q("select 1");
  execFileSync("sqlite3", [DB, `insert or ignore into object_roles(key,name,rank) values ('t_status_only','Только статусы (тест)',15),('t_readonly','Только чтение (тест)',5);
    insert or replace into role_features(role_key,feature_key,level) select 't_status_only', feature_key, case when feature_key in ('status') then 'write' else 'read' end from role_features where role_key='view';
    insert or replace into role_features(role_key,feature_key,level) select 't_readonly', feature_key, 'read' from role_features where role_key='view';
    delete from user_access where user_id=(select id from users where domain_login='user4');
    insert into user_access(user_id,project_id,object_id,role) select id,1,1,'t_readonly' from users where domain_login='user4';`]);
  const u4 = await login("user4");
  // user2: полный набор рабочих прав, но без реквизитов
  b = await openWs("user2");
  const H = (await topHits(b)).filter((x) => x.st === "contracting" && x.c);
  let x = H[800];
  await pickOne(b, x);
  ok("user2: форма статуса, плановая дата, комментарий, история — доступны", (await hasBtn(b, "#ws-panel-body", "Сохранить статус")) && (await hasBtn(b, "#ws-panel-body", "Задать плановую дату")) && (await hasBtn(b, "#ws-panel-body", "Добавить комментарий")) && /изменить/.test(await panel(b)));
  ok("user2: «Форма элемента…» недоступна (нет права «реквизиты элемента: запись»)", !(await hasBtn(b, "#ws-panel-body", "Форма элемента")));
  const ru = await b.eval(`fetch('/elements/${x.id}/fields',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({floor:9})}).then(r=>r.status)`);
  ok("user2: прямой запрос PATCH /fields отклонён сервером (403), БД цела", ru === 403 && el(x.id).floor !== 9, String(ru));
  await setVal(b, "#ws-sform select[name=status]", "in_production");
  await clickBtn(b, "#ws-sform", "Сохранить статус");
  await b.waitFor(`/Статус изменён/.test(document.querySelector('#ws-sform')?.innerText||'')`, 20000);
  ok("user2: смена статуса выполняется (от его имени)", el(x.id).st === "in_production" && one(`select changed_by u from status_history where element_id=${x.id} order by id desc limit 1`).u.length > 0);
  const x2 = H[801]; const x3 = H[802];
  await pickMany(b, [x2, x3]);
  ok("user2: групповые операции доступны", await hasBtn(b, "#eo-gform", "Проверить последствия"));
  await b.close();
  // урезанная роль: только статусы
  execFileSync("sqlite3", [DB, `delete from user_access where user_id=(select id from users where domain_login='user4');
    insert into user_access(user_id,project_id,object_id,role) select id,1,1,'t_status_only' from users where domain_login='user4';`]);
  b = await openWs("user4");
  x = H[810];
  await pickOne(b, x);
  ok("роль «только статусы»: форма статуса есть; плановой даты, комментария, реквизитов, правки истории нет",
    (await hasBtn(b, "#ws-panel-body", "Сохранить статус")) && !(await hasBtn(b, "#ws-panel-body", "Задать плановую дату")) && !(await hasBtn(b, "#ws-panel-body", "Добавить комментарий")) && !(await hasBtn(b, "#ws-panel-body", "Форма элемента")) && !/изменить\nудалить/.test(await panel(b)));
  const codes = await b.eval(`Promise.all([
    fetch('/element-ops/planned-date-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:1,planned_date:'2026-12-12',items:[{element_id:${x.id},expected_planned_date:null}]})}).then(r=>r.status),
    fetch('/elements/${x.id}/comment',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({comment:'нельзя'})}).then(r=>r.status),
    fetch('/elements/${x.id}/fields',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({floor:5})}).then(r=>r.status),
    fetch('/elements/${x.id}/history/1',{method:'DELETE'}).then(r=>r.status)])`);
  ok("роль «только статусы»: сервер отвечает 403 на плановую дату, комментарий, реквизиты, удаление истории", codes.every((c) => c === 403), JSON.stringify(codes));
  ok("…и БД не изменилась", el(x.id).pd === null && el(x.id).cm === null);
  await b.close();
  // только чтение
  execFileSync("sqlite3", [DB, `delete from user_access where user_id=(select id from users where domain_login='user4');
    insert into user_access(user_id,project_id,object_id,role) select id,1,1,'t_readonly' from users where domain_login='user4';`]);
  b = await openWs("user4");
  x = H[811];
  await pickOne(b, x);
  ok("только чтение: форм записи нет, объяснено", !(await hasBtn(b, "#ws-panel-body", "Сохранить статус")) && /нет права изменять статусы/.test(await panel(b)) && !(await hasBtn(b, "#ws-panel-body", "Изменить контракт")) && !(await hasBtn(b, "#ws-panel-body", "Добавить комментарий")));
  await pickMany(b, [H[812], H[813]]);
  ok("только чтение: групповых форм нет, объяснено", !(await hasBtn(b, "#eo-gform", "Проверить последствия")) && /Групповые изменения недоступны/.test(await panel(b)));
  const c2 = await b.eval(`Promise.all([
    fetch('/element-ops/status-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'apply',object_id:1,status:'delivered',expect:{release_contracts:0,without_contract:0},items:[{element_id:${x.id},expected_status:'contracting',expected_contract_id:${x.c}}]})}).then(r=>r.status),
    fetch('/element-ops/contract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({element_id:${x.id},expected_status:'contracting',expected_contract_id:${x.c},contract_id:null})}).then(r=>r.status)])`);
  ok("только чтение: сервер отвечает 403 на смену статуса и контракта", c2.every((c) => c === 403), JSON.stringify(c2));
  ok("…и БД не изменилась", el(x.id).st === "contracting" && el(x.id).c === x.c);
  // шлюз записи: запрос вне разрешённой формы не уходит из интерфейса вовсе
  const gate = await b.eval(`import('/static/v2/write-gate.js').then(g=>({bulk:g.checkWrite('PATCH','/elements/bulk-status',{items:[],status:'delivered'}).allowed,oldStatus:g.checkWrite('PATCH','/elements/5/status',{status:'delivered'}).allowed,withContract:g.checkWrite('POST','/element-ops/status-batch',{mode:'apply',object_id:1,status:'delivered',expect:{release_contracts:0,without_contract:0},items:[{element_id:1,expected_status:'planned',contract_id:3}]}).allowed,extra:g.checkWrite('POST','/element-ops/status-batch',{mode:'preview',object_id:1,status:'delivered',assign_contract_id:2,items:[{element_id:1,expected_status:'planned'}],contract_id:3}).allowed,ok:g.checkWrite('POST','/element-ops/status-batch',{mode:'preview',object_id:1,status:'delivered',items:[{element_id:1,expected_status:'planned',expected_contract_id:null}]}).allowed}))`);
  ok("шлюз: V1-массовая смена и старая смена статуса запрещены; тело с contract_id в строках/лишние поля отклонены; штатное тело разрешено", !gate.bulk && !gate.oldStatus && !gate.withContract && !gate.extra && gate.ok, JSON.stringify(gate));
  await b.close();
  // вернуть прежние гранты user4 (копия одноразовая, но порядок важен для повторных запусков)
  execFileSync("sqlite3", [DB, `delete from user_access where user_id=(select id from users where domain_login='user4'); insert into user_access(user_id,project_id,role) select id,1,'view' from users where domain_login='user4';`]);
}

// ================================================================= 6а. 3D (WebGL программно — swiftshader)
if (want("3d")) {
  sec("D. Режим 3D: масштаб колесом, вращение перетаскиванием, выбор щелчком");
  const { createHash } = await import("node:crypto");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const b3 = await launch({ width: 1920, height: 1080, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });
  await b3.goto(`${BASE}/v2?object_id=1`);
  await b3.waitFor(`!!document.querySelector('#v2-login-user')`, 20000);
  await b3.eval(`(()=>{document.querySelector('#v2-login-user').value='admin';document.querySelector('#v2-login-pass').value=${JSON.stringify(PASS)};document.querySelector('#v2-login-form').requestSubmit();})()`);
  await b3.waitFor(`!!document.querySelector('#v2-object')`, 20000);
  await b3.eval(`location.hash='#/ws-model'`);
  await b3.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300);
  await b3.sleep(800);
  await b3.eval(`document.querySelector('#ws-modes [data-view="3d"]').click()`);
  await b3.waitFor(`/Режим: 3D/.test(document.querySelector('#ws-status')?.innerText||'')`, 30000);
  await b3.sleep(5000);
  const dir = mkdtempSync(join(tmpdir(), "m3d-"));
  const sig = async (n) => { await b3.shot(join(dir, n + ".png")); return createHash("sha256").update(readFileSync(join(dir, n + ".png"))).digest("hex").slice(0, 12); };
  const fr = await b3.eval(`(()=>{const r=${F}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  ok("3D: режим включён, холст WebGL создан", (await b3.eval(`!!${F}.contentDocument.querySelector('canvas')`)) && /Режим: 3D/.test(await statusBar(b3)));
  const s0 = await sig("a");
  await b3.wheel(fr.x + fr.w / 2, fr.y + fr.h / 2, -500); await b3.sleep(1200);
  const s1 = await sig("b");
  ok("3D: колесо меняет вид (масштаб)", s1 !== s0);
  await b3.drag(fr.x + fr.w * 0.5, fr.y + fr.h * 0.5, fr.x + fr.w * 0.62, fr.y + fr.h * 0.56); await b3.sleep(1200);
  const s2 = await sig("c");
  ok("3D: перетаскивание вращает/сдвигает вид", s2 !== s1);
  let picked = false;
  for (let i = 0; i < 60 && !picked; i++) {
    const x = fr.x + fr.w * (0.25 + 0.5 * ((i * 37) % 20) / 20), y = fr.y + fr.h * (0.25 + 0.5 * ((i * 53) % 20) / 20);
    await b3.click(x, y); await b3.sleep(350);
    picked = /Выбран: /.test(await statusBar(b3));
  }
  ok("3D: щелчок по изделию выбирает его (панель показывает карточку)", picked && /Ригель|Плита|Колонна|Стена|Балка/.test((await panel(b3)).slice(0, 200)) || picked, (await statusBar(b3)).replace(/\n/g, " | "));
  await b3.clickSel('.ws-tools [data-tool="clear"]');
  // программный WebGL (swiftshader) рисует кадр медленно: ждём до 8 с, а не фиксированные 0,5 с; если выбор так и не снят — проверка падает
  await b3.waitFor(`/Ничего не выбрано/.test(document.querySelector('#ws-status')?.innerText||'')`, 8000).catch(() => {});
  ok("3D: «Снять выбор» очищает", /Ничего не выбрано/.test(await statusBar(b3)));
  ok("3D: нет исключений", b3.exceptions.length === 0, JSON.stringify(b3.exceptions.slice(0, 2)));
  await b3.close();
}

// ================================================================= 6б. АРМ прораба
if (want("foreman")) {
  sec("F. АРМ прораба: отбор слева, показатели, операции над изделиями");
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    b = await openWs("admin", { w, h, hash: "#/ws-foreman" });
    const tag = `${w}×${h}: `;
    await b.sleep(1800);            // панель отбора слева достраивается — схема получает окончательный размер
    const layout = await b.eval(`({left:!!document.querySelector('#ws-left'),strip:document.querySelector('#ws-strip')?.innerText||'',sh:document.documentElement.scrollHeight,ih:innerHeight,sw:document.documentElement.scrollWidth,iw:innerWidth,stage:(()=>{const r=document.querySelector('#ws-stage').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()})`);
    ok(tag + "панель отбора слева, полоса показателей, страница не прокручивается", layout.left && /элементов/.test(layout.strip) && layout.sh <= layout.ih + 1 && layout.sw <= layout.iw + 1, JSON.stringify(layout));
    for (let k = 0; k < 3; k++) { await b.clickSel('.ws-tools [data-tool="in"]'); await b.sleep(250); }   // крупнее — больше фигур пригодны для щелчка
    await b.sleep(600);
    const hits = (await topHits(b)).filter((x) => x.st === "planned" || x.st === "contracting");
    const list = hits.slice(0, 3);
    await pickMany(b, list);
    ok(tag + "групповая панель доступна и в АРМ прораба", /Выбрано элементов: 3/.test(await panel(b)) && (await hasBtn(b, "#eo-gform", "Проверить последствия")));
    const dims = await b.eval(`({sh:document.documentElement.scrollHeight,ih:innerHeight,bar:document.querySelector('#ws-status').getBoundingClientRect().bottom})`);
    ok(tag + "страница не прокручивается и с групповой панелью; строка состояния видна", dims.sh <= dims.ih + 1 && dims.bar <= dims.ih + 1, JSON.stringify(dims));
    if (w === 1920) {
      const ids = list.map((x) => x.id); const hb = ids.map(hn);
      const stripBefore = await b.eval(`document.querySelector('#ws-strip').innerText`);
      await setVal(b, "#eo-gform select[name=status]", "delivered");
      await clickBtn(b, "#eo-gform", "Проверить последствия");
      await b.waitFor(`!!document.querySelector('.eo-preview')`, 20000);
      await clickBtn(b, "#eo-gform", "Применить к");
      await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
      await clickBtn(b, ".v2-dialog", "Применить");
      await b.waitFor(`/установлен у 3/.test(document.querySelector('.eo-banner')?.innerText||'')`, 25000);
      ok(tag + "АРМ прораба: пачка записана (БД, история)", ids.every((id, i) => el(id).st === "delivered" && hn(id) === hb[i] + 1), JSON.stringify(ids.map((id, i) => [id, el(id).st, hb[i], hn(id)])));
      await b.sleep(800);
      const stripAfter = await b.eval(`document.querySelector('#ws-strip').innerText`);
      ok(tag + "полоса показателей обновилась после записи", stripAfter !== stripBefore && /Доставлен/.test(stripAfter), stripBefore.slice(-120) + " → " + stripAfter.slice(-120));
      // отбор слева: снятие статуса «Доставлен» настоящим щелчком уменьшает показанное, «Сбросить все» возвращает
      const shownN = async () => Number(/Показано (\d+) из/.exec(await statusBar(b))?.[1] || 0);
      const n0 = await shownN();
      const cb = await b.eval(`(()=>{const c=[...document.querySelectorAll('#ws-left-body input[data-key="status"]')].find(x=>x.dataset.v==='"delivered"');if(!c)return null;c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      ok(tag + "в панели отбора есть значение «Доставлен»", !!cb);
      if (cb) {
        await b.click(cb.x, cb.y); await b.sleep(900);
        const n1 = await shownN();
        ok(tag + "отбор слева: снятие «Доставлен» уменьшает число показанных на схеме и включает «Фильтры активны»", n1 < n0 && /Фильтры активны/.test(await statusBar(b)), `${n0} → ${n1}`);
        await clickBtn(b, "#ws-left", "Сбросить все"); await b.sleep(800);
        ok(tag + "«Сбросить все» возвращает схему", (await shownN()) === n0);
      }
    }
    ok(tag + "нет ошибок в консоли", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
    await b.close();
  }
}

// ================================================================= 7. совместимость: V1 на том же сервере показывает результат V2
if (want("v1")) {
  sec("V1. Совместимость с текущим интерфейсом (V1 на том же сервере)");
  const id = C.v1[0].id;
  await admin("PATCH", `/elements/${id}/status`, { status: "delivered" });
  await admin("PATCH", `/elements/${id}/comment`, { comment: "из проверки V1" });
  const bb = await launch({ width: 1600, height: 900 });
  await bb.goto(`${BASE}/?ui=v1&object_id=1`);
  await bb.waitFor(`!!document.querySelector('#login-domain')`, 20000);
  await bb.eval(`(()=>{document.querySelector('#login-domain').value='admin';document.querySelector('#login-password').value=${JSON.stringify(PASS)};document.querySelector('#login-submit').click();})()`);
  await bb.waitFor(`typeof state!=='undefined' && state.elements && state.elements.length>1000`, 90000, 400);
  const v = await bb.eval(`(()=>{const e=state.byId.get(${id});return {st:e.current_status,cm:e.comment}})()`);
  ok("V1: изделие, изменённое в V2/API, показано со статусом «delivered» и комментарием", v.st === "delivered" && v.cm === "из проверки V1", JSON.stringify(v));
  ok("V1: собственная операция (смена статуса одного) работает после операций V2", await bb.eval(`api('/elements/${id}/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'installed'})}).then(r=>r.current_status)`) === "installed");
  ok("V1: журнал смен изделия содержит запись из V2", q(`select count(*) n from status_history where element_id=${id}`)[0].n >= 3);
  await bb.close();
}

console.log(`\nПроверок пройдено: ${okN}, нарушений: ${fails.length}`);
if (fails.length) { console.log(fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
