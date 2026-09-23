// Проверка режима «только просмотр» экрана V2 «Документы контрактации» (app/static/v2/supplier-docs.js, 2026-09-22) на НАСТОЯЩЕМ backend
// (scripts/real_auth_server.py — app.main:app целиком, настоящий вход) и ВРЕМЕННОЙ копии обезличенной БД. Браузер — scripts/cdp.mjs
// (безголовый Chrome, настоящие события мыши/клавиатуры); сверка БД до/после — прямым SQL по копии.
//
// Кто есть кто на копии (объект 1):
//   admin  — администратор сервиса: пишущий, полный прежний сценарий;
//   user4  — роль «view»: заводская матрица уже даёт «Чтение» на doc_supplier_change/doc_link_swap — ЧИТАТЕЛЬ (настройка не нужна);
//   user2  — роль «user»: в КОПИИ у роли сняты оба раздела (SQL) — НЕТ ПРАВА вовсе; в конце в КОПИИ ей дают «Изменение» на замену
//            поставщика и «Чтение» на обмен привязками — СМЕШАННЫЕ права (один вид правит, другой только смотрит).
// Данные: к двум черновикам обмена копии (№1 пустой, №2 — 7 пар) администратор через HTTP добавляет черновик и проведённую «Замену
// поставщика», черновик обмена с 2 парами и проводит обмен №2 — так у читателя есть черновик и проведённый документ каждого вида.
//
// Запуск:  node scripts/verify_docsview.mjs
//   DV_PORT (8350) — порт стенда; DV_DIR — каталог копии (по умолчанию во временном каталоге системы; удаляется в конце, KEEP=1 — оставить);
//   DV_SRC — база-источник (по умолчанию data/zhbi.anon.db этого каталога); DV_SHOTS — каталог снимков экрана (необязательно).
import { launch } from "./cdp.mjs";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const PORT = Number(process.env.DV_PORT) || 8350;
if ([8000, 8010, 8020].includes(PORT)) throw new Error("порт занят под настоящие серверы пользователя");
const DIR = process.env.DV_DIR || join(tmpdir(), `zhbi_docsview_${PORT}`);
const SRC = process.env.DV_SRC || `${ROOT}/data/zhbi.anon.db`;
const SHOTS = process.env.DV_SHOTS || null;
const PASS = "Test-Pass-1234!";
const BASE = `http://127.0.0.1:${PORT}`;
const PY = `${ROOT}/.venv/bin/python`;
const DB = `${DIR}/work.db`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ итоги
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  return !!ok;
}

// ------------------------------------------------------------------ SQL по копии
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", DB, q], { encoding: "utf8", maxBuffer: 64 << 20 }).trim(); return out ? JSON.parse(out) : []; };
const sql1 = (q) => { const r = sql(q); return r.length ? Object.values(r[0])[0] : null; };
const exec = (q) => execFileSync("sqlite3", [DB, q]);
// Точный отпечаток таблиц: sha256 всех строк по порядку rowid (python, без приближений)
const TABLES = ["supplier_change_docs", "supplier_change_items", "supplier_change_history_moves", "elements", "status_history", "contract_lines", "contracts", "role_features", "user_access"];
function fingerprint() {
  const code = `import sqlite3,hashlib,json,sys
c=sqlite3.connect(sys.argv[1]); out={}
for t in ${JSON.stringify(TABLES)}:
    h=hashlib.sha256()
    for r in c.execute(f"SELECT * FROM {t} ORDER BY rowid"): h.update(repr(r).encode())
    out[t]=h.hexdigest()[:16]
out["activity_docs"]=c.execute("SELECT COUNT(*) FROM activity_log WHERE action LIKE 'supplier_change%' OR action='link_swap'").fetchone()[0]
print(json.dumps(out))`;
  return JSON.parse(execFileSync(PY, ["-c", code, DB], { encoding: "utf8" }));
}
const fpDiff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

// ------------------------------------------------------------------ стенд
let srv = null;
function prepareCopy() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  // штатный sqlite backup; источник открывается только на чтение (immutable, если рядом нет -wal)
  const uri = `file:${SRC}?${existsSync(SRC + "-wal") ? "mode=ro" : "immutable=1"}`;
  execFileSync(PY, ["-c", `import sqlite3,sys; s=sqlite3.connect(sys.argv[1],uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()`, uri, DB]);
  // запас свободного количества в контракте 13 по 4П-12 — под «Замену поставщика» 14 → 13 (в копии контракты заполнены «до нуля»)
  exec(`UPDATE contract_lines SET quantity = quantity + 6 WHERE contract_id=13 AND mark='4П-12';`);
  // user2 (роль «user»): у роли сняты оба раздела документов — пользователь БЕЗ права (только в копии)
  exec(`DELETE FROM role_features WHERE role_key='user' AND feature_key IN ('doc_supplier_change','doc_link_swap');`);
}
async function startServer() {
  const log = `${DIR}/server.log`;
  srv = spawn(PY, [`${ROOT}/scripts/real_auth_server.py`, DB, String(PORT), DIR], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; const keep = (d) => { out += d; writeFileSync(log, out); };
  srv.stdout.on("data", keep); srv.stderr.on("data", keep);
  for (let i = 0; i < 200; i++) {
    await sleep(300);
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* ждём */ }
  }
  throw new Error("сервер не поднялся: " + out.slice(-600));
}
async function stopServer() {
  if (srv) { try { srv.kill("SIGTERM"); } catch { /* */ } await sleep(600); try { srv.kill("SIGKILL"); } catch { /* */ } srv = null; }
}

// ------------------------------------------------------------------ HTTP от имени пользователя (подготовка данных, прямые запросы)
async function httpLogin(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: PASS }) });
  if (!r.ok) throw new Error(`вход ${user}: ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
async function http(cookie, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* пусто */ }
  return { status: r.status, json };
}

// ------------------------------------------------------------------ браузер
async function browserAs(user, w = 1920, h = 1080) {
  const b = await launch({ width: w, height: h });
  await b.goto(`${BASE}/v2`, 500);
  await b.waitFor(`!!document.querySelector('#v2-login-user')`, 20000);
  await b.clickSel("#v2-login-user"); await b.type(user);            // настоящая форма входа V2
  await b.clickSel("#v2-login-pass"); await b.type(PASS);
  await b.key("Enter");
  await b.waitFor(`!!document.querySelector('.v2-head') && !!document.querySelector('#v2-object')`, 30000);
  await sleep(500);
  // объект 1 — через совместимый хук выбора объекта в шапке (тот же changeObject, что у кнопки объекта)
  await b.eval(`(()=>{const s=document.querySelector('#v2-object'); if(s.value!=='1'){s.value='1'; s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await b.waitFor(`document.querySelector('#v2-object').value==='1'`, 10000);
  await sleep(1200);
  return b;
}
const shot = async (b, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await b.shot(`${SHOTS}/${name}.png`); } };
const inner = (b) => b.eval(`document.querySelector('#sd-inner')?.innerText || ''`);
async function tapSel(b, sel) {
  await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`); await sleep(120);
  await b.clickSel(sel);
}
async function tapText(b, label, scope = "document") {
  const r = await b.eval(`(()=>{const e=[...${scope}.querySelectorAll('button')].find(x=>x.offsetParent&&!x.disabled&&x.textContent.trim().replace(/\\s+/g,' ')===${JSON.stringify(label)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!r) throw new Error("нет доступной кнопки «" + label + "»");
  await b.click(r.x, r.y);
}
// Переход на экран так, как это делает человек: пункт левой навигации (раскрыть панель при необходимости), иначе — адрес
// Раскрыть левую навигацию настоящим щелчком по кнопке «Меню разделов» (в свёрнутом виде на полосе только рабочие места)
async function openNav(b) {
  if (await b.eval(`document.querySelector('#v2-shellnav-menu')?.getAttribute('aria-expanded')==='true'`)) return;
  await b.clickSel("#v2-shellnav-menu"); await sleep(500);
}
// Группа «Контрактация и график» бывает свёрнута — раскрыть её щелчком по заголовку (если она вообще есть у этой роли)
async function expandContracting(b) {
  if (await b.eval(`document.querySelector('.v2-shellnav-group-head[data-group="contracting"]')?.getAttribute('aria-expanded')==='false'`)) {
    await b.eval(`document.querySelector('.v2-shellnav-group-head[data-group="contracting"]').scrollIntoView({block:'center'})`);
    await b.clickSel('.v2-shellnav-group-head[data-group="contracting"]'); await sleep(400);
  }
  return b.eval(`document.querySelector('.v2-shellnav-group-head[data-group="contracting"]')?.getAttribute('aria-expanded') ?? 'нет группы'`);
}
async function openScreen(b) {
  await openNav(b);
  await expandContracting(b);
  const viaNav = await b.eval(`(()=>{const e=[...document.querySelectorAll('[data-section="supplier-change"]')].find(x=>x.offsetParent); if(!e) return false; e.scrollIntoView({block:'center'}); return true;})()`);
  if (viaNav) {
    const r = await b.eval(`(()=>{const e=[...document.querySelectorAll('[data-section="supplier-change"]')].find(x=>x.offsetParent); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await b.click(r.x, r.y);
  } else await b.eval(`location.hash='#/supplier-change'`);
  await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Документы объекта')`, 20000);
  await b.waitFor(`!document.querySelector('#sd-status')?.textContent.includes('Выполняется')`, 10000);
  await sleep(400);
  return viaNav;
}
const WRITE_ACTIONS = ["save", "post", "unpost", "delete", "pick", "pk-all", "pk-apply", "pk-cancel", "mv", "rm", "reload-cand", "new-supplier_change", "new-link_swap"];
const writeControls = (b) => b.eval(`(()=>{const acts=${JSON.stringify(WRITE_ACTIONS)}; const n=[...document.querySelectorAll('#v2-content [data-a]')].filter(e=>acts.includes(e.dataset.a)).map(e=>e.dataset.a);
  return {actions:n, qty:document.querySelectorAll('#sd-inner [data-qty]').length, chk:document.querySelectorAll('#sd-inner input[data-el], #sd-inner [data-pk-el]').length,
          svg:!!document.querySelector('#sd-pick-svg'), footButtons:document.querySelectorAll('#sd-foot button').length,
          enabledFields:[...document.querySelectorAll('#sd-inner input, #sd-inner select')].filter(e=>!e.disabled).length}})()`);
const metrics = (b) => b.eval(`(()=>{const d=document.scrollingElement;return {sh:d.scrollHeight,ih:innerHeight,sw:d.scrollWidth,iw:innerWidth}})()`);
const noPageScroll = (m) => m.sh <= m.ih + 2 && m.sw <= m.iw + 2;
function reqsSince(b, from, re = /\/supplier-changes/) { return b.requests.slice(from).filter((r) => re.test(new URL(r.url).pathname)); }
// Прямой запрос из страницы МИМО клиентского шлюза записи (write-gate.js работает в api.js, здесь — голый fetch): отвечает сервер
const rawFetch = (b, method, path, body) => b.eval(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:'same-origin',headers:{'Content-Type':'application/json'},body:${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}}).then(async r=>{let j=null;try{j=await r.json()}catch(e){};return{status:r.status,detail:j&&j.detail}})`);

// ==================================================================================================================================
let exitCode = 1;
try {
  prepareCopy();
  await startServer();
  console.log(`стенд: ${BASE} (копия ${DB})`);

  // ---------------------------------------------------------------- подготовка документов (администратор, HTTP)
  const admin = await httpLogin("admin");
  const today = new Date().toISOString().slice(0, 10);
  const r2 = await http(admin, "POST", "/supplier-changes/2/post", {});
  if (r2.status !== 200) throw new Error("проведение обмена №2: " + r2.status + " " + JSON.stringify(r2.json));
  const used = new Set(sql(`SELECT element_id FROM supplier_change_items`).map((r) => r.element_id));
  const pickIds = (contract, n, status = "contracting") => sql(`SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id=${contract} AND mark='4П-12' AND current_status='${status}' ORDER BY id`).map((r) => r.id).filter((id) => !used.has(id)).slice(0, n).map((id) => (used.add(id), id));
  const scDraft = await http(admin, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: today, from_contract_id: 14, to_contract_id: 13, reason: "Проверка просмотра: черновик", element_ids: pickIds(14, 3) });
  const scPosted = await http(admin, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: today, from_contract_id: 14, to_contract_id: 13, reason: "Проверка просмотра: проведён", element_ids: pickIds(14, 2) });
  const scPost = await http(admin, "POST", `/supplier-changes/${scPosted.json?.id}/post`, {});
  const swDraft = await http(admin, "POST", "/supplier-changes", { object_id: 1, kind: "link_swap", doc_date: today, from_contract_id: 14, to_contract_id: 12, mark: "4П-12", reason: "Проверка просмотра: обмен", side_a: pickIds(14, 2), side_b: pickIds(12, 2) });
  if (![scDraft, scPosted, swDraft].every((r) => r.status === 200) || scPost.status !== 200) throw new Error("подготовка документов: " + JSON.stringify([scDraft.status, scPosted.status, scPost.status, swDraft.status, scDraft.json?.detail, swDraft.json?.detail]));
  const DOCS = [
    { key: "замена, черновик", id: scDraft.json.id, kind: "supplier_change", posted: false },
    { key: "замена, проведён", id: scPosted.json.id, kind: "supplier_change", posted: true },
    { key: "обмен, черновик (2 пары)", id: swDraft.json.id, kind: "link_swap", posted: false },
    { key: "обмен, проведён (7 пар)", id: 2, kind: "link_swap", posted: true },
    { key: "обмен, пустой черновик", id: 1, kind: "link_swap", posted: false },
  ];
  const docCount = Number(sql1(`SELECT COUNT(*) FROM supplier_change_docs WHERE object_id=1`));
  check("P0 подготовка: документы обоих видов в обоих состояниях", docCount === 5 && sql1(`SELECT COUNT(*) FROM supplier_change_docs WHERE status='posted'`) === 2, `документов объекта 1: ${docCount}`);

  // ---------------------------------------------------------------- A. ЧИТАТЕЛЬ (user4, роль view → «Чтение»)
  console.log("\n== A. читатель: user4 (роль «view», «Чтение» на оба раздела) ==");
  const fpA0 = fingerprint();
  {
    const b = await browserAs("user4");
    try {
      const perm = await b.eval(`fetch('/me/permissions?object_id=1',{credentials:'same-origin'}).then(r=>r.json()).then(j=>[j.features.doc_supplier_change,j.features.doc_link_swap,j.system_admin])`);
      check("A0 права user4 на объекте 1 (сервер, /me/permissions): «Чтение» на оба раздела, не администратор", perm[0] === "read" && perm[1] === "read" && perm[2] === false, JSON.stringify(perm));
      const mark0 = b.requests.length;
      const viaNav = await openScreen(b);
      check("A1 экран открывается читателю" + (viaNav ? " — щелчком по пункту левой навигации" : " (по адресу; пункт навигации свёрнут)"), (await b.eval("location.hash")) === "#/supplier-change");
      const rows = await b.eval(`document.querySelectorAll('#sd-inner tbody tr').length`);
      check("A2 список: все документы объекта (как в БД)", rows === docCount, `строк ${rows}, в БД ${docCount}`);
      let wc = await writeControls(b);
      check("A3 в списке нет кнопок создания документов", !wc.actions.length, JSON.stringify(wc.actions));
      check("A4 в списке — пояснение «Только просмотр»", await b.eval(`!!document.querySelector('[data-readonly-note]')`));
      await shot(b, "A-list-1920");
      check("A5 1920×1080: список без прокрутки всей страницы", noPageScroll(await metrics(b)), JSON.stringify(await metrics(b)));

      for (const d of DOCS) {
        const head = (await http(admin, "GET", `/supplier-changes/${d.id}`)).json;
        await tapSel(b, `[data-open="${d.id}"]`);                            // настоящий щелчок по номеру документа
        await b.waitFor(`!!document.querySelector('#sd-inner [data-a="back"]') && (document.querySelector('#sd-inner h3')?.innerText||'').includes('№ ${head.number} ')`, 15000);
        await sleep(300);
        const t = await inner(b);
        wc = await writeControls(b);
        const tag = await b.eval(`!!document.querySelector('[data-readonly-tag]')`);
        const foot = await b.eval(`document.querySelector('#sd-foot')?.innerText||''`);
        check(`A6 [${d.key}] открыт с меткой «Только просмотр», состояние «${head.status_title}»`, tag && t.includes(d.posted ? "Проведён" : "Черновик"));
        check(`A7 [${d.key}] нет кнопок записи/подбора, полей ввода количества и отметок, мини-схемы; все поля заблокированы`, !wc.actions.length && !wc.qty && !wc.chk && !wc.svg && wc.enabledFields === 0 && wc.footButtons === 0, JSON.stringify(wc));
        check(`A8 [${d.key}] подвал: «Только просмотр: нет права изменять…»`, foot.includes("Только просмотр"), foot);
        const fromSel = await b.eval(`document.querySelector('[data-f="from"]').selectedOptions[0]?.textContent||''`), toSel = await b.eval(`document.querySelector('[data-f="to"]').selectedOptions[0]?.textContent||''`);
        check(`A9 [${d.key}] контракты — как записаны в документе (${head.from_contract_name} / ${head.to_contract_name})`, fromSel === head.from_contract_name && toSel === head.to_contract_name, `${fromSel} / ${toSel}`);
        if (d.kind === "supplier_change") {
          const n = await b.eval(`document.querySelectorAll('#sd-inner table tbody tr').length`);
          const addrOk = head.items.every((i) => t.includes(i.address || `№${i.element_id}`));
          check(`A10 [${d.key}] состав: «Изделия документа (${head.items.length})», строки и адреса — как в БД`, t.includes(`Изделия документа (${head.items.length})`) && n === head.items.length && addrOk, `строк ${n}`);
        } else {
          const a = head.items.filter((i) => i.side === 1).length, bb = head.items.filter((i) => i.side === 2).length;
          const markSel = await b.eval(`document.querySelector('[data-f="mark"]').selectedOptions[0]?.textContent||''`);
          check(`A10 [${d.key}] стороны обмена: ${a} / ${bb} шт., марка «${head.mark}», пары`, t.includes(`Сторона 1: ${a} шт.`) && t.includes(`Сторона 2: ${bb} шт.`) && markSel === head.mark && (a ? t.includes(`Пар к обмену: ${Math.min(a, bb)}`) : true), markSel);
        }
        if (d.posted) check(`A11 [${d.key}] история проведения: кто провёл (${head.posted_by})`, t.includes(`Проведён: ${head.posted_by}`));
        // попытка ввода в заблокированное поле настоящими событиями — значение не меняется, «несохранённых изменений» нет
        const before = await b.eval(`document.querySelector('[data-f="reason"]').value`);
        await b.clickSel('[data-f="reason"]'); await b.type("ПРАВКА ЧИТАТЕЛЯ"); await sleep(200);
        const after = await b.eval(`document.querySelector('[data-f="reason"]').value`), st = await b.eval(`document.querySelector('#sd-status').textContent`);
        check(`A12 [${d.key}] ввод в поле с клавиатуры не меняет документ, индикатора несохранённого нет`, before === after && !st.includes("несохранённые"), `«${after}» / «${st}»`);
        if (d.id === 2) {
          await shot(b, "A-doc-swap-posted-1920");
          check("A13 1920×1080: форма документа без прокрутки всей страницы (длинное — внутри области)", noPageScroll(await metrics(b)), JSON.stringify(await metrics(b)));
          await b.viewport(1366, 768); await sleep(400);
          await shot(b, "A-doc-swap-posted-1366");
          check("A14 1366×768: форма документа без прокрутки всей страницы", noPageScroll(await metrics(b)), JSON.stringify(await metrics(b)));
          await b.viewport(1920, 1080); await sleep(300);
        }
        await tapText(b, "← К списку");                                      // настоящий щелчок, без диалога сторожа
        await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Документы объекта') && !document.querySelector('.v2-dialog')`, 10000);
        await sleep(300);
      }
      await b.viewport(1366, 768); await sleep(400);
      await shot(b, "A-list-1366");
      check("A15 1366×768: список без прокрутки всей страницы", noPageScroll(await metrics(b)), JSON.stringify(await metrics(b)));
      await b.viewport(1920, 1080);

      const rq = reqsSince(b, mark0);
      const writes = rq.filter((r) => r.method !== "GET");
      const denied = rq.filter((r) => r.status === 403 || r.status === 0);
      const refsLike = rq.filter((r) => /\/supplier-changes\/(refs|candidates|contract-marks|mark-contracts|swap-elements)/.test(r.url));
      check("A16 браузер читателя НЕ отправил ни одного изменяющего запроса к документам", writes.length === 0, JSON.stringify(writes.map((r) => r.method + " " + r.url)));
      check("A17 справочные запросы правки (/refs, /candidates, …) читателю не отправлялись, отказов 403 по дороге нет", refsLike.length === 0 && denied.length === 0, `GET: ${rq.length}, отказов: ${denied.length}, справочных: ${refsLike.length}`);

      // прямые изменяющие запросы читателя МИМО клиентского шлюза — отвечает сервер
      const sc = DOCS[0].id, scp = DOCS[1].id, sw = DOCS[2].id;
      const tries = [
        ["POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: today, from_contract_id: 14, to_contract_id: 13, element_ids: [] }],
        ["POST", "/supplier-changes", { object_id: 1, kind: "link_swap", doc_date: today, from_contract_id: 14, to_contract_id: 12, mark: "4П-12", side_a: [], side_b: [] }],
        ["PATCH", `/supplier-changes/${sc}`, { object_id: 1, kind: "supplier_change", doc_date: today, from_contract_id: 14, to_contract_id: 13, reason: "взлом", element_ids: [] }],
        ["PATCH", `/supplier-changes/${sw}`, { object_id: 1, kind: "link_swap", doc_date: today, from_contract_id: 14, to_contract_id: 12, mark: "4П-12", reason: "взлом", side_a: [], side_b: [] }],
        ["DELETE", `/supplier-changes/${sc}`], ["DELETE", `/supplier-changes/1`],
        ["POST", `/supplier-changes/${sc}/post`, {}], ["POST", `/supplier-changes/${sw}/post`, {}],
        ["POST", `/supplier-changes/${scp}/unpost`, {}], ["POST", `/supplier-changes/2/unpost`, {}],
      ];
      const got = [];
      for (const [m, p, body] of tries) got.push([m, p, await rawFetch(b, m, p, body)]);
      check(`A18 прямые изменяющие запросы читателя (${tries.length}: создание обоих видов, правка, удаление, проведение, отмена) — 403 от СЕРВЕРА`, got.every(([, , r]) => r.status === 403), got.map(([m, p, r]) => `${m} ${p} → ${r.status}`).join("; "));
      check("A19 текст отказа сервера — про «изменение», а не шлюз клиента", got.every(([, , r]) => String(r.detail || "").includes("изменение")), String(got[0][2].detail));
      check("A20 исключений JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
    } finally { await b.close(); }
  }
  const fpA1 = fingerprint();
  check("A21 SQL до/после сеанса читателя: документы, состав, переезды истории, изделия, история, контракты, права — без изменений; событий документов в журнале не прибавилось", fpDiff(fpA0, fpA1).length === 0, JSON.stringify(fpDiff(fpA0, fpA1)));

  // ---------------------------------------------------------------- B. БЕЗ ПРАВА (user2, в копии у роли «user» разделов нет)
  console.log("\n== B. без права: user2 ==");
  {
    const b = await browserAs("user2");
    try {
      const perm = await b.eval(`fetch('/me/permissions?object_id=1',{credentials:'same-origin'}).then(r=>r.json()).then(j=>[j.features.doc_supplier_change,j.features.doc_link_swap])`);
      check("B0 права user2 на объекте 1: «Нет» на оба раздела", perm[0] === "none" && perm[1] === "none", JSON.stringify(perm));
      await openNav(b);
      const grp = await expandContracting(b);
      const navItems = await b.eval(`document.querySelectorAll('[data-section]').length`);
      check("B1 в раскрытой левой навигации (группа «Контрактация и график» раскрыта) пункта «Документы контрактации» нет", navItems > 3 && !(await b.eval(`!!document.querySelector('[data-section="supplier-change"]')`)), `пунктов навигации: ${navItems}, группа: ${grp}`);
      await b.eval(`location.hash='#/supplier-change'`); await sleep(1500);
      check("B2 переход по адресу — экран не открывается (возврат на начальную страницу)", (await b.eval("location.hash")) !== "#/supplier-change" && !(await b.eval(`!!document.querySelector('#sd-inner')`)), await b.eval("location.hash"));
      const g1 = await rawFetch(b, "GET", "/supplier-changes?object_id=1"), g2 = await rawFetch(b, "GET", "/supplier-changes/2"), g3 = await rawFetch(b, "GET", `/supplier-changes/${DOCS[0].id}`);
      const p1 = await rawFetch(b, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: today, from_contract_id: 14, to_contract_id: 13, element_ids: [] });
      check("B3 сервер: список, документ обоих видов и создание — 403", [g1, g2, g3, p1].every((r) => r.status === 403), [g1, g2, g3, p1].map((r) => r.status).join(","));
    } finally { await b.close(); }
  }

  // Список API должен скрывать и реквизиты вида, на который нет права.
  exec(`INSERT INTO role_features(role_key, feature_key, level) VALUES ('user','doc_supplier_change','write');`);
  const oneKind = await httpLogin("user2");
  const supplierOnly = await http(oneKind, "GET", "/supplier-changes?object_id=1");
  check("C0 список API: при праве только на замену выдаёт только замены",
    supplierOnly.status === 200 && supplierOnly.json.length > 0 && supplierOnly.json.every((d) => d.kind === "supplier_change"),
    `${supplierOnly.status}, видов: ${[...new Set((supplierOnly.json || []).map((d) => d.kind))].join(",")}`);
  const deniedSwap = await http(oneKind, "GET", `/supplier-changes/${swDraft.json.id}`);
  check("C0a карточка обмена без права недоступна", deniedSwap.status === 403, String(deniedSwap.status));
  exec(`DELETE FROM role_features WHERE role_key='user' AND feature_key='doc_supplier_change';`);
  exec(`INSERT INTO role_features(role_key, feature_key, level) VALUES ('user','doc_link_swap','read');`);
  const swapOnly = await http(oneKind, "GET", "/supplier-changes?object_id=1");
  check("C0b список API: при праве только на обмен выдаёт только обмены",
    swapOnly.status === 200 && swapOnly.json.length > 0 && swapOnly.json.every((d) => d.kind === "link_swap"),
    `${swapOnly.status}, видов: ${[...new Set((swapOnly.json || []).map((d) => d.kind))].join(",")}`);

  // ---------------------------------------------------------------- C. СМЕШАННЫЕ права (user2: замена — «Изменение», обмен — «Чтение»)
  console.log("\n== C. смешанные права: user2 — замена «Изменение», обмен «Чтение» ==");
  exec(`INSERT INTO role_features(role_key, feature_key, level) VALUES ('user','doc_supplier_change','write');`);
  {
    const fpC0 = fingerprint();
    const b = await browserAs("user2");
    try {
      await openScreen(b);
      check("C1 список: «Новая замена поставщика» есть, «Нового обмена привязками» нет, пояснения «только просмотр» нет",
        (await b.eval(`!!document.querySelector('[data-a="new-supplier_change"]') && !document.querySelector('[data-a="new-link_swap"]') && !document.querySelector('[data-readonly-note]')`)));
      await tapSel(b, `[data-open="${DOCS[0].id}"]`);
      await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Что переносить')`, 15000);
      const wcS = await writeControls(b);
      check("C2 черновик замены поставщика открыт для ПРАВКИ (подбор количеств, «Удалить черновик», «Сохранить», «Провести»)", wcS.qty > 0 && wcS.actions.includes("delete") && wcS.actions.includes("save") && wcS.actions.includes("post") && !(await b.eval(`!!document.querySelector('[data-readonly-tag]')`)), JSON.stringify(wcS));
      await tapText(b, "← К списку"); await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Документы объекта')`, 10000); await sleep(300);
      await tapSel(b, `[data-open="${DOCS[2].id}"]`);
      await b.waitFor(`!!document.querySelector('[data-readonly-tag]')`, 15000); await sleep(300);
      const wcW = await writeControls(b);
      check("C3 черновик обмена привязками — только просмотр (нет «Подбор…», стрелок, «Сохранить»), поля заблокированы", !wcW.actions.length && wcW.enabledFields === 0 && !wcW.svg, JSON.stringify(wcW));
      const pw = await rawFetch(b, "PATCH", `/supplier-changes/${DOCS[2].id}`, { object_id: 1, kind: "link_swap", doc_date: today, from_contract_id: 14, to_contract_id: 12, mark: "4П-12", side_a: [], side_b: [] });
      const pp = await rawFetch(b, "POST", `/supplier-changes/2/unpost`, {});
      check("C4 сервер: правка черновика обмена и отмена проведения обмена — 403 (вид без «Изменения»)", pw.status === 403 && pp.status === 403, `${pw.status}, ${pp.status}`);
      check("C5 исключений JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
    } finally { await b.close(); }
    check("C6 SQL: ничего не изменилось", fpDiff(fpC0, fingerprint()).length === 0);
  }

  // ---------------------------------------------------------------- D. ПИШУЩИЙ (admin) — прежний вид
  console.log("\n== D. пишущий: admin ==");
  {
    const b = await browserAs("admin");
    try {
      await openScreen(b);
      check("D1 список: обе кнопки создания, пояснения «только просмотр» нет", await b.eval(`!!document.querySelector('[data-a="new-supplier_change"]') && !!document.querySelector('[data-a="new-link_swap"]') && !document.querySelector('[data-readonly-note]')`));
      const mark = b.requests.length;
      await tapSel(b, `[data-open="${DOCS[2].id}"]`);
      await b.waitFor(`!!document.querySelector('[data-a="pick"][data-side="a"]')`, 15000); await sleep(600);
      const wc = await writeControls(b);
      check("D2 черновик обмена: «Подбор…» обеих сторон, стрелки, «Сохранить», «Провести», поля доступны; метки «только просмотр» нет",
        wc.actions.filter((a) => a === "pick").length === 2 && wc.actions.includes("mv") && wc.actions.includes("save") && wc.enabledFields > 0 && !(await b.eval(`!!document.querySelector('[data-readonly-tag]')`)), JSON.stringify(wc));
      check("D3 пишущему по-прежнему грузятся марки контракта стороны 1 (справочный запрос правки)", reqsSince(b, mark).some((r) => /contract-marks/.test(r.url) && r.status === 200));
      await tapSel(b, `[data-a="pick"][data-side="a"]`);
      await b.waitFor(`!!document.querySelector('#sd-pick-svg')`, 15000);
      check("D4 подбор открывает мини-схему", await b.eval(`document.querySelectorAll('#sd-pick-svg .sd-pick-shape').length>0`));
      await tapText(b, "Отмена");
      await tapText(b, "← К списку"); await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Документы объекта')`, 10000); await sleep(300);
      await tapSel(b, `[data-open="${DOCS[1].id}"]`);
      await b.waitFor(`(document.querySelector('#sd-foot')?.innerText||'').includes('Отменить проведение')`, 15000);
      check("D5 проведённая замена: «Отменить проведение» доступна, текст про отмену проведения на месте", (await inner(b)).includes("сначала отмените проведение"));
      check("D6 исключений JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));

      // ---------------------------------------------------------------- E. V1 на том же сервере
      console.log("\n== E. V1 ==");
      await b.goto(`${BASE}/?ui=v1&object_id=1`, 2500);
      await b.waitFor(`!!document.getElementById('menu-supplier-change') && document.getElementById('menu-supplier-change').style.display!=='none'`, 30000);
      await b.clickSel("#btn-settings-menu"); await sleep(300);
      const vis = await b.eval(`!!document.getElementById('menu-supplier-change').offsetParent`);
      if (vis) await b.clickSel("#menu-supplier-change"); else await b.eval(`document.getElementById('menu-supplier-change').click()`);
      await b.waitFor(`document.querySelectorAll('#scd-list .scd-doc-card').length>0`, 15000);
      const cards = await b.eval(`document.querySelectorAll('#scd-list .scd-doc-card').length`);
      check("E1 V1 (admin): пункт «Смена поставщика» виден, окно открывает список тех же документов", cards === docCount, `карточек ${cards}`);
      const card = await b.eval(`(()=>{const c=[...document.querySelectorAll('#scd-list .scd-doc-card')].find(x=>x.innerText.includes('№ 2 '));const r=c.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await b.click(card.x, card.y);
      await b.waitFor(`document.getElementById('supplier-change-form-backdrop').classList.contains('open')`, 15000); await sleep(500);
      check("E2 V1: проведённый обмен №2 открывается формой с «Отменить проведение» (как прежде)", await b.eval(`document.getElementById('scd-unpost').style.display!=='none' && document.getElementById('scd-form-title').textContent.includes('№ 2')`));
    } finally { await b.close(); }
  }
  {
    const b = await browserAs("user4");
    try {
      await b.goto(`${BASE}/?ui=v1&object_id=1`, 2500);
      // права применены к меню, когда хоть один пункт уже погашен (у роли «view» закрытых разделов много)
      await b.waitFor(`document.querySelectorAll('#settings-menu [data-feature][style*="display"]').length>0`, 30000);
      await sleep(500);
      check("E3 V1 (user4, «Чтение»): пункт «Смена поставщика» по-прежнему скрыт (V1 не менялся: режима просмотра у окна V1 нет)", await b.eval(`document.getElementById('menu-supplier-change').style.display==='none'`));
    } finally { await b.close(); }
  }
  exitCode = results.some((r) => !r.ok) ? 1 : 0;
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  await stopServer();
  if (!process.env.KEEP) rmSync(DIR, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} PASS / ${bad} FAIL из ${results.length}`);
process.exit(bad ? 1 : exitCode);
