// Браузерная проверка переноса V1 → V2 области «lines» (продолжение области model): вложения изделия, построчная плановая дата,
// построчная смена статуса с контрактом — на НАСТОЯЩЕМ backend и временной копии БД (настоящие события мыши по протоколу DevTools).
//
// Запуск (сервер и копия — как в BRIEF):
//   .venv/bin/python scripts/real_auth_server.py <база> <порт> <каталог_копии>      # в фоне
//   node scripts/verify_lines_ui.mjs <порт> <каталог_копии> <файл_для_загрузки> [раздел ...]   # разделы: attach plan status rights v1
import { launch } from "./cdp.mjs";
import { execFileSync } from "node:child_process";

const PORT = process.argv[2], WORK = process.argv[3], UPLOAD_FILE = process.argv[4];
const ONLY = new Set(process.argv.slice(5));
if (!PORT || !WORK || !UPLOAD_FILE) { console.error("нужны порт, каталог копии и путь к файлу для загрузки"); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`, DB = `${WORK}/work.db`, PASS = "Test-Pass-1234!";
// у роли view в копии по умолчанию «status» стоит на запись (след прежних проверок, см. Docs/v2-progress/model.md) — для проверки отказа
// на ВРЕМЕННОЙ копии переводим на чтение (тот же приём, что scripts/verify_element_ops.py делает через _guard_harness)
execFileSync("sqlite3", [`${WORK}/work.db`, "UPDATE role_features SET level='read' WHERE role_key='view' AND feature_key='status'"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql) => { const t = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8" }).trim(); return t ? JSON.parse(t) : []; };
const one = (sql) => q(sql)[0];
const fails = [];
let okN = 0;
const ok = (name, cond, detail = "") => { if (cond) { okN++; console.log("  ✓ " + name); } else { fails.push(name); console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
const sec = (n) => console.log("\n" + n);
const want = (k) => !ONLY.size || ONLY.has(k);

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
// Верхний (последний в DOM) диалог — когда один открыт ПОВЕРХ другого (выбор контракта строки поверх окна построчного статуса): оба
// подходят под `.v2-dialog`, а querySelector берёт первый по document order, то есть НИЖНИЙ. Здесь — намеренно последний.
const topDialogText = (b) => b.eval(`(()=>{const l=document.querySelectorAll('.v2-dialog');return l.length?l[l.length-1].innerText:''})()`);
// Диалог подтверждения (showConfirmDialog, dialogs.js) стоит ПОВЕРХ окна с формой (оба — .v2-dialog): целимся именно в него по role/aria-label,
// а не первой попавшейся кнопкой «Применить» — под подтверждением остаётся ТА ЖЕ кнопка формы, ещё видимая (offsetParent не знает про z-index).
async function clickConfirm(b) {
  await b.waitFor(`!!document.querySelector('.v2-dialog[role="alertdialog"] [data-choice="confirm"]')`, 8000);
  await b.eval(`document.querySelector('.v2-dialog[role="alertdialog"] [data-choice="confirm"]').click()`);
}
const clearSel = async (b) => { await b.clickSel('.ws-tools [data-tool="clear"]'); await b.sleep(400); };

async function topHits(b) {
  const hit = await b.eval(`(()=>{const f=${F};const d=f.contentDocument;const fr=f.getBoundingClientRect();const out=[];for(const s of d.querySelectorAll('.element-shape')){const r=s.getBoundingClientRect();if(r.width<5||r.height<5)continue;const cx=r.x+r.width/2,cy=r.y+r.height/2;if(cx<70||cy<70||cx>fr.width-70||cy>fr.height-70)continue;const top=d.elementFromPoint(cx,cy);const sh=top&&top.closest('.element-shape');const id=+s.getAttribute('data-id');if(sh&&+sh.getAttribute('data-id')===id)out.push({id,x:Math.round(fr.x+cx),y:Math.round(fr.y+cy)});}return out})()`);
  const rows = q(`select id,current_status st,contract_id c,element_type t,mark m,planned_delivery_date pd,object_id o from elements where id in (${hit.map((h) => h.id).join(",")})`);
  const by = new Map(rows.map((r) => [r.id, r]));
  return hit.map((h) => ({ ...h, ...by.get(h.id) }));
}
async function pickOne(b, h, o) { await b.click(h.x, h.y, o); await b.sleep(650); }
async function pickMany(b, list) { await clearSel(b); await b.click(list[0].x, list[0].y); await b.sleep(500); for (const h of list.slice(1)) { await b.click(h.x, h.y, { meta: true }); await b.sleep(220); } await b.sleep(700); }
const el = (id) => one(`select current_status st, contract_id c, actual_delivery_date ad, planned_delivery_date pd, comment cm, floor, address, mark, updated_at from elements where id=${id}`);
const attN = (id) => one(`select count(*) n from attachments where entity_type='element' and entity_id=${id}`).n;
const events = (action, since) => q(`select * from activity_log where id > ${since} and action='${action}'`);
const lastEvent = () => one("select coalesce(max(id),0) m from activity_log").m;
async function flushJournal() { await sleep(1500); }

const loseResponse = (b, urlPart) => b.eval(`(()=>{const orig=window.__origFetch||(window.__origFetch=window.fetch.bind(window));window.fetch=async(u,o)=>{const r=await orig(u,o);if(String(u).includes(${JSON.stringify(urlPart)})){window.__lost=(window.__lost||0)+1;throw new TypeError('Failed to fetch');}return r;};})()`);
const restoreFetch = (b) => b.eval(`(()=>{if(window.__origFetch){window.fetch=window.__origFetch;window.__lost=0;}})()`);

async function setFileInput(b, sel, path) {
  const doc = await b.send("DOM.getDocument", { depth: -1 });
  const n = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  if (!n.nodeId) throw new Error("нет поля файла " + sel);
  await b.send("DOM.setFileInputFiles", { files: [path], nodeId: n.nodeId });
}

// ================================================================= подготовка
console.log(`Проверка на ${BASE}, копия ${DB}, файл для загрузки ${UPLOAD_FILE}`);
const admin = await login("admin");
let b = await openWs("admin");
const HITS = await topHits(b);
const contr = HITS.filter((h) => h.st === "contracting" && h.c);
const planned = HITS.filter((h) => h.st === "planned");
console.log(`видимых изделий: ${HITS.length} (контрактация с контрактом ${contr.length}, запланировано ${planned.length})`);
let used = 0;
const take = (arr, n) => { const r = arr.slice(used, used + n); used += n; return r; };
const T = { a1: contr.slice(0, 1), pl1: contr.slice(5, 8), pl2: contr.slice(10, 13), st1: contr.slice(20, 23), st2: contr.slice(30, 33), r1: contr.slice(40, 41) };
await b.close();

// Обёртка раздела: браузер ЭТОГО раздела закрывается даже при необработанном исключении внутри — не оставляет процесс Chrome висеть
// (BRIEF запрещает завершать чужие процессы по имени; открытый браузер этой проверки закрывает только она сама).
async function section(name, fn) {
  sec(name);
  try {
    await fn();
  } catch (e) {
    fails.push(`${name}: исключение — ${e.message}`);
    console.log(`  ✗ ИСКЛЮЧЕНИЕ: ${e.message}`);
  } finally {
    if (b) { try { await b.close(); } catch (e2) { /* уже закрыт */ } b = null; }
  }
}

// ================================================================= A. вложения изделия
if (want("attach")) await section("A. Вложения изделия (карточка)", async () => {
  b = await openWs("admin");
  const target = T.a1[0];
  await pickOne(b, target);
  // заголовок <h4> рисуется CSS text-transform:uppercase — innerText отдаёт УЖЕ преобразованный регистр, сравниваем без учёта регистра
  await b.waitFor(`(document.querySelector('#ws-panel-body')?.innerText||'').toLowerCase().includes('вложения')`, 8000).catch(() => {});
  ok("карточка показывает блок «Вложения»", (await panel(b)).toLowerCase().includes("вложения"));
  await b.waitFor(`document.querySelector('#eo-attach-file')!=null || document.querySelector('.eo-attach')?.textContent.includes('Файлов нет')`, 8000).catch(() => {});
  await b.sleep(400);
  const before = attN(target.id);
  await setFileInput(b, "#eo-attach-file", UPLOAD_FILE);
  await b.eval(`document.querySelector('#eo-attach-desc').value='проверка lines'`);
  await clickBtn(b, "#ws-panel-body", "Приложить");
  await b.waitFor(`(document.querySelector('#eo-attach-status')?.textContent||'')===''`, 15000);
  await b.sleep(300);
  ok("после загрузки: +1 вложение в БД", attN(target.id) === before + 1, `было ${before}, стало ${attN(target.id)}`);
  ok("файл виден в списке (имя файла в панели)", (await panel(b)).includes(UPLOAD_FILE.split("/").pop()));
  const evUp = events("attachment_add", lastEvent() - 20);
  ok("журнал: attachment_add", evUp.some((e) => e.entity_id === target.id), JSON.stringify(evUp));

  // после перезагрузки страницы вложение на месте
  await b.eval(`location.reload()`);
  await b.waitFor(`!!document.querySelector('#v2-object')`, 20000);
  await b.eval(`location.hash='#/ws-model'`);
  await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 90000, 300);
  const hits2 = await topHits(b);
  const target2 = hits2.find((h) => h.id === target.id);
  ok("изделие снова доступно после перезагрузки", !!target2);
  if (target2) { await pickOne(b, target2); await b.sleep(400); ok("после перезагрузки вложение в списке", (await panel(b)).includes(UPLOAD_FILE.split("/").pop())); }

  // удаление
  {
    const before2 = attN(target.id);
    await b.eval(`(()=>{const r=[...document.querySelectorAll('.eo-attach [data-ea="del"]')][0];if(r)r.click();})()`);
    await b.sleep(500);
    const conf = await dialogText(b);
    ok("диалог подтверждения удаления показан", /Удалить вложение/.test(conf), conf);
    await clickBtn(b, ".v2-dialog", "Удалить");
    await b.sleep(700);
    ok("после подтверждения: −1 вложение в БД", attN(target.id) === before2 - 1, `было ${before2}, стало ${attN(target.id)}`);
    const evDel = events("attachment_delete", lastEvent() - 30);
    ok("журнал: attachment_delete", evDel.some((e) => e.entity_id === target.id));
  }
  await b.close();

  // права: user2 (роль user, доступ к объекту 1) может приложить и удалить; user4 (view) — не может (нет формы, сервер 403)
  b = await openWs("user2");
  const t2 = (await topHits(b)).find((h) => h.st === "contracting" && h.c) || T.a1[0];
  await pickOne(b, t2);
  await b.sleep(300);
  ok("user2 (роль user): форма загрузки видна", (await panel(b)).includes("Приложить"));
  await b.close();

  b = await openWs("user4");
  const hits4 = await topHits(b);
  if (hits4.length) {
    await pickOne(b, hits4[0]);
    await b.sleep(300);
    ok("user4 (роль view): формы загрузки нет (только чтение)", !(await panel(b)).includes("Приложить"));
    // прямой запрос без прав — сервер отказывает 403 (форма скрыта, но сервер — источник истины)
    const r = await b.eval(`(async()=>{const fd=new FormData();fd.append('entity_type','element');fd.append('entity_id','${hits4[0].id}');fd.append('file',new Blob(['x']),'x.txt');const res=await fetch('/attachments',{method:'POST',body:fd,credentials:'same-origin'});return res.status;})()`);
    ok("прямой POST /attachments у view — 403 от сервера", r === 403, String(r));
  }
  await b.close();
});

// ================================================================= P. построчная плановая дата
if (want("plan")) await section("P. Плановая дата поставки по строкам", async () => {
  b = await openWs("admin");
  await pickMany(b, T.pl1);
  ok("групповая панель открыта (Выбрано элементов)", (await panel(b)).includes("Выбрано элементов"));
  ok("есть кнопка «По строкам: своя дата у каждого изделия…»", await hasBtn(b, "#ws-panel-body", "По строкам: своя дата"));
  await clickBtn(b, "#ws-panel-body", "По строкам: своя дата");
  await b.sleep(400);
  ok("модальное окно построчных дат открыто", /Плановая дата поставки по строкам/.test(await dialogText(b)));
  const snapBefore = T.pl1.map((h) => el(h.id));
  // даты, заведомо отличные от текущих (повторный прогон на той же копии не должен наткнуться на «нечего менять»)
  const altDate = (cur) => (cur === "2026-12-01" ? "2026-12-04" : "2026-12-01");
  const dates = snapBefore.map((h, i) => (i === 0 ? altDate(h.pd) : i === 1 ? (h.pd === "2026-12-02" ? "2026-12-05" : "2026-12-02") : (h.pd === "2026-12-03" ? "2026-12-06" : "2026-12-03")));
  for (let i = 0; i < T.pl1.length; i++) {
    await b.eval(`(()=>{const inp=document.querySelectorAll('.eor-date')[${i}];inp.value=${JSON.stringify(dates[i])};inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }
  await b.sleep(200);
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`document.querySelector('.v2-dialog')?.innerText.includes('Предпросмотр')`, 10000);
  ok("предпросмотр ничего не записал", T.pl1.every((h, i) => el(h.id).pd === snapBefore[i].pd));
  await clickBtn(b, ".v2-dialog", "Применить");
  await b.waitFor(`!!document.querySelector('.v2-dialog[role="alertdialog"]')`, 8000);
  const conf2 = await b.eval(`document.querySelector('.v2-dialog[role="alertdialog"]')?.innerText||''`);
  ok("диалог подтверждения показан", /Изменить плановую дату/.test(conf2), conf2);
  await clickConfirm(b);
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 15000);
  await b.sleep(300);
  ok("даты установлены по строкам (каждая своя)", T.pl1.every((h, i) => el(h.id).pd === dates[i]), JSON.stringify(T.pl1.map((h) => el(h.id).pd)));
  ok("баннер с итогом показан", /Плановая дата изменена/.test(await panel(b)));

  // конфликт: устаревшая дата строки (другой пользователь успел изменить ПОСЛЕ того, как браузер прочитал схему) — предпросмотр отказывает,
  // модальное окно ЗАКРЫВАЕТСЯ (как и у групповой смены статуса без строк), баннер с причиной — в панели, схема перечитывается
  await clearSel(b);
  await pickMany(b, T.pl2);
  await clickBtn(b, "#ws-panel-body", "По строкам: своя дата");
  await b.sleep(400);
  const conflictSnap = T.pl2.map((h) => el(h.id));
  const q1 = (sql) => execFileSync("sqlite3", [DB, sql]);   // прямая запись в копию — «другой пользователь успел изменить»
  q1(`UPDATE elements SET planned_delivery_date='2026-01-15' WHERE id=${T.pl2[0].id}`);
  for (let i = 0; i < T.pl2.length; i++) await b.eval(`(()=>{const inp=document.querySelectorAll('.eor-date')[${i}];inp.value='2026-12-1${i}';inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 10000);
  await b.sleep(500);
  const errBanner = await panel(b);
  ok("устаревшая дата строки: окно закрылось с отказом, ничего не применено", /измен|Обновите/i.test(errBanner), errBanner.slice(0, 300));
  ok("ничего не применилось (кроме подстроенного значения)", el(T.pl2[0].id).pd === "2026-01-15" && el(T.pl2[1].id).pd === conflictSnap[1].pd);
  await b.waitFor(`/Показано \\d+ из \\d+/.test(document.querySelector('#ws-status')?.textContent||'')`, 30000, 300);   // схема перечиталась (needReload)
  await clearSel(b);
  await b.sleep(300);

  // потеря ответа: запрос доходит, ответ обрывается — интерфейс не автоповторяет, сверяет чтением (групповая панель нужна ⇒ минимум 2 изделия выбраны)
  const lostPair = contr.slice(55, 57);
  await pickMany(b, lostPair);
  await clickBtn(b, "#ws-panel-body", "По строкам: своя дата");
  await b.sleep(300);
  const targetLost = lostPair[0];
  const prevDate = el(targetLost.id).pd;
  await b.eval(`(()=>{const inp=document.querySelectorAll('.eor-date')[0];inp.value='2026-12-25';inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`document.querySelector('.v2-dialog')?.innerText.includes('Предпросмотр')`, 10000);
  await loseResponse(b, "/element-ops/planned-date-rows");
  await clickBtn(b, ".v2-dialog", "Применить");
  await clickConfirm(b);
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 15000);
  await restoreFetch(b);
  await b.sleep(500);
  ok("потеря ответа: запись состоялась на сервере (сверка), баннер это отражает", el(targetLost.id).pd === "2026-12-25", `дата в БД: ${el(targetLost.id).pd} (была ${prevDate})`);
  ok("баннер предупреждает, а не «сервер подтвердил»", /соответствует запросу|не подтвердить/.test((await panel(b)).toLowerCase()) || /Ответ не получен/.test(await panel(b)), await panel(b));
  await b.close();
});

// ================================================================= S. построчная смена статуса с контрактом
if (want("status")) await section("S. Смена статуса с контрактом по строкам", async () => {
  b = await openWs("admin");
  await pickMany(b, T.st1);
  await clickBtn(b, "#ws-panel-body", "По строкам: статус со своим контрактом");
  await b.sleep(400);
  ok("модальное окно построчного статуса открыто", /Смена статуса по строкам/.test(await dialogText(b)));
  await b.eval(`(()=>{const s=document.querySelector('#eor-status');s.value='in_production';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.sleep(300);
  ok("таблица строк показана (Марка/Тип/Было)", /Марка/.test(await dialogText(b)));
  ok("кнопка «Проверить последствия» доступна без выбора контракта (контракт сохраняется по умолчанию)", await hasBtn(b, ".v2-dialog", "Проверить последствия"));
  const before3 = T.st1.map((h) => el(h.id));
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`document.querySelector('.v2-dialog')?.innerText.includes('Предпросмотр')`, 10000);
  ok("предпросмотр ничего не записал", T.st1.every((h, i) => el(h.id).st === before3[i].st));
  await clickBtn(b, ".v2-dialog", "Применить");
  await clickConfirm(b);
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 15000);
  await b.sleep(400);
  ok("статус изменён у всех строк, контракты СОХРАНЕНЫ", T.st1.every((h, i) => el(h.id).st === "in_production" && el(h.id).c === before3[i].c), JSON.stringify(T.st1.map((h) => el(h.id))));

  // явное снятие контракта у одной строки построчно
  await clearSel(b);
  await pickMany(b, T.st2);
  await clickBtn(b, "#ws-panel-body", "По строкам: статус со своим контрактом");
  await b.sleep(300);
  await b.eval(`(()=>{const s=document.querySelector('#eor-status');s.value='shipped';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.sleep(300);
  await b.eval(`document.querySelectorAll('[data-eor-c]')[0].click()`);   // кнопка контракта первой строки (независимо от того, выбран ли уже контракт по умолчанию)
  await b.waitFor(`!!document.querySelector('.eo-crow[data-c="none"]')`, 8000);
  ok("окно выбора контракта строки открыто", /^Контракт ·/.test(await topDialogText(b)), await topDialogText(b));
  await b.eval(`document.querySelector('.eo-crow[data-c="none"]').click()`);   // «— без контракта —» (leading), не текстовым поиском: строка начинается с «—»
  await b.sleep(400);
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`document.querySelector('.v2-dialog')?.innerText.includes('Предпросмотр')`, 10000);
  ok("предпросмотр показывает снятие контракта у 1 изд.", /СНЯТ/.test(await dialogText(b)));
  await clickBtn(b, ".v2-dialog", "Применить");
  await clickConfirm(b);
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 15000);
  await b.sleep(400);
  ok("контракт снят именно у той строки, где выбрано «без контракта»", el(T.st2[0].id).c === null && el(T.st2[0].id).st === "shipped");
  await clearSel(b);

  // V1 допускал выбор прежнего статуса с новой привязкой. V2 должен менять только явно изменённую строку, не создавать историю соседям.
  const samePair = contr.slice(40, 42);
  await pickMany(b, samePair);
  const sameBefore = samePair.map((h) => el(h.id));
  const histN = (id) => one(`select count(*) n from status_history where element_id=${id}`).n;
  const histBefore = samePair.map((h) => histN(h.id));
  await clickBtn(b, "#ws-panel-body", "По строкам: статус со своим контрактом");
  await b.eval(`(()=>{const s=document.querySelector('#eor-status');s.value='contracting';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.sleep(250);
  ok("при прежнем статусе обе строки видны, пока изменений нет", (await dialogText(b)).includes("Изменится: 0 из 2") && (await b.eval(`document.querySelectorAll('[data-eor-c]').length`)) === 2);
  await b.eval(`document.querySelectorAll('[data-eor-c]')[0].click()`);
  await b.waitFor(`!!document.querySelector('.eo-crow[data-c="none"]')`, 8000);
  await b.eval(`document.querySelector('.eo-crow[data-c="none"]').click()`);
  await b.sleep(250);
  ok("предпросмотр активен для одной изменённой строки", (await dialogText(b)).includes("Изменится: 1 из 2"));
  await clickBtn(b, ".v2-dialog", "Проверить последствия");
  await b.waitFor(`document.querySelector('.v2-dialog')?.innerText.includes('Предпросмотр')`, 10000);
  ok("предпросмотр сообщает о снятии контракта без смены статуса", /СНЯТ/.test(await dialogText(b)) && samePair.every((h, i) => el(h.id).c === sameBefore[i].c));
  await clickBtn(b, ".v2-dialog", "Применить");
  await clickConfirm(b);
  await b.waitFor(`!document.querySelector('.eo-dialog')`, 15000);
  ok("прежний статус сохранён, контракт сменился только у первой строки", el(samePair[0].id).st === "contracting" && el(samePair[0].id).c === null && el(samePair[1].id).c === sameBefore[1].c);
  ok("история +1 только у изменённой строки", histN(samePair[0].id) === histBefore[0] + 1 && histN(samePair[1].id) === histBefore[1]);
  await clearSel(b);
  await b.close();

  // права: user4 (view) не видит кнопку построчного режима (нет статуса:write)
  b = await openWs("user4");
  const hitsV = await topHits(b);
  if (hitsV.filter((h) => h.st === "contracting").length >= 2) {
    await pickMany(b, hitsV.filter((h) => h.st === "contracting").slice(0, 2));
    await b.sleep(300);
    ok("user4 (view): нет кнопки построчного статуса", !(await hasBtn(b, "#ws-panel-body", "По строкам: статус")));
  }
  await b.close();
});

// ================================================================= V1. совместимость
if (want("v1")) await section("V1. Совместимость на том же сервере", async () => {
  const r = await admin("GET", "/");
  ok("V1 открывается на том же сервере (200)", r.status === 200, String(r.status));
});

// ================================================================= итог
console.log(`\n${okN} ✓, ${fails.length} ✗` + (fails.length ? `\nПровалено: ${fails.join("; ")}` : ""));
process.exit(fails.length ? 1 : 0);
