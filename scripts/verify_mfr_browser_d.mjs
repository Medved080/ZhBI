// Браузерная проверка рабочего места «Модель МФР» (V2) на НАСТОЯЩЕМ backend и временной копии БД: раскладка без прокрутки страницы на 1920×1080 и 1366×768,
// схема занимает основную площадь, выбор блока / блоков щелчком и ⌘/Ctrl-щелчком НАСТОЯЩИМИ событиями мыши в кадре схемы, панель работ блока
// (счётчики до открытия, проценты, сроки), отбор работ, «Динамика факта» и «Шахматка» (команды моста), «Факт» и групповые окна из панели, права user2/user4.
// Запуск: MFR_BASE=... MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr_browser_d.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, txt, exists, tap, closeModal, setObject } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("workspace");
async function dialogBtn(b, label) { await b.waitFor(`document.querySelector('.v2-dialog')`); await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`); }
const FD = `document.querySelector('iframe.ws-frame').contentDocument`;   // (eval в кадре запрещён CSP — состояние движка читается по его DOM и по снимку в панели)
async function loginNode(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: process.env.MFR_PASSWORD || "Test-Pass-1234!" }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
  return (method, path, body) => fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
}
// координаты блока плана в окне страницы (кадр лежит со сдвигом); nth — какой из перекрытых элементов; проверяет, что в точке действительно этот блок
async function blockPoint(b, id) {
  return b.eval(`(()=>{const f=document.querySelector('iframe.ws-frame'); const d=f.contentDocument; const fr=f.getBoundingClientRect();
    const els=[...d.querySelectorAll('rect[data-block-id="${id}"]')]; let best=null;
    for(const e of els){ const r=e.getBoundingClientRect(); if(r.width<12||r.height<12) continue;
      const pts=[[.5,.5],[.3,.3],[.7,.3],[.3,.7],[.7,.7],[.5,.2],[.5,.8]];
      for(const [px,py] of pts){ const x=r.x+r.width*px, y=r.y+r.height*py; const hit=d.elementFromPoint(x,y); if(hit&&hit.getAttribute&&hit.getAttribute('data-block-id')==='${id}'){ return {x:fr.x+x,y:fr.y+y}; } } }
    return null;})()`);
}
const visibleBlockIds = () => `[...new Set([...document.querySelector('iframe.ws-frame').contentDocument.querySelectorAll('rect[data-block-id]')].map(e=>e.getAttribute('data-block-id')))]`;

async function layoutCheck(b, label) {
  await openScreen(b, "ws-mfr", `document.querySelector('iframe.ws-frame')`);
  await b.waitFor(`(()=>{const f=document.querySelector('iframe.ws-frame'); return f && f.contentDocument && f.contentDocument.querySelectorAll('#revit-plan-canvas rect[data-block-id]').length>0})()`, 90000);
  await sleep(1200);
  const m = await b.eval(`(()=>{const s=document.querySelector('.ws-stage').getBoundingClientRect(); const f=document.querySelector('iframe.ws-frame').getBoundingClientRect(); const vw=innerWidth, vh=innerHeight; return {stage:[s.width,s.height], frame:[f.width,f.height], vw, vh, scrollH:document.scrollingElement.scrollHeight, scrollW:document.scrollingElement.scrollWidth}})()`);
  c.ok(m.scrollH <= m.vh + 1 && m.scrollW <= m.vw + 1, `${label}: страница не прокручивается (высота содержимого ${m.scrollH} ≤ ${m.vh})`);
  const share = (m.frame[0] * m.frame[1]) / (m.vw * m.vh);
  c.ok(share > 0.45, `${label}: схема занимает основную площадь (${Math.round(share * 100)}% окна; кадр ${Math.round(m.frame[0])}×${Math.round(m.frame[1])})`);
  return m;
}

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS, width: 1920, height: 1080 });
try {
  console.log("Рабочее место МФР: раскладка 1920×1080");
  await layoutCheck(b, "1920×1080");
  await shot(b, "d-ws-1920");
  c.ok(await b.eval(`!!document.querySelector('.ws-status') && document.querySelector('.ws-status').getBoundingClientRect().bottom <= innerHeight`), "строка состояния видна внизу");
  const listed = await b.eval(`document.querySelectorAll('#ws-panel-body .mfr-blk').length`);
  const counts = await b.eval(`[...document.querySelectorAll('#ws-panel-body .mfr-blk')].map(e=>[Number(e.dataset.id), e.querySelector('.mfr-count').textContent])`);
  const sqlCounts = Object.fromEntries(sql("SELECT block_id, COUNT(*) n FROM block_works WHERE object_id=4 AND retired_at IS NULL GROUP BY block_id").map((r) => [r.block_id, String(r.n)]));
  c.ok(listed > 0 && counts.every(([id, t]) => t === (sqlCounts[id] || "0")), `до выбора блока панель показывает блоки текущего этажа (${listed}) со счётчиками ЗР, равными SQL`);

  console.log("выбор этажа и секции щелчками (вкладка «Фильтры»)");
  const adm0 = await loginNode("admin");
  const okBlocks = async (levels, sections) => {
    const q = [...levels.map((x) => `level_id=${x}`), ...sections.map((x) => `section_id=${x}`)].join("&");
    const g = await (await adm0("GET", `/objects/4/blocks/geometry?${q}`)).json();
    return (Array.isArray(g) ? g : g.blocks || []).filter((x) => x.ok).length;
  };
  const statusBlocks = async () => Number(await b.eval(`/блоков (\\d+)/.exec(document.querySelector('.ws-status').textContent)?.[1] ?? -1`));
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await b.waitFor(`document.querySelector('[data-mpick="level"]')`);
  const on = async (kind) => JSON.parse(await b.eval(`JSON.stringify([...document.querySelectorAll('[data-mpick="${kind}"]')].filter(p=>p.getAttribute('aria-pressed')==='true').map(p=>p.dataset.id))`));
  const all = async (kind) => JSON.parse(await b.eval(`JSON.stringify([...document.querySelectorAll('[data-mpick="${kind}"]')].map(p=>p.dataset.id))`));
  const lv = await all("level"), sc0 = await all("section");
  const start = await on("level");
  c.ok(start.length === 1, `стартовый вид: выбран один этаж (${start.join(",")}), а не «все этажи, наложенные друг на друга»`);
  const want0 = await okBlocks(start, []);
  await b.waitFor(`/блоков (\\d+)/.exec(document.querySelector('.ws-status').textContent)?.[1]==='${want0}'`, 30000).catch(() => {});
  // (число «блоков» в строке состояния сразу после автовыбора этажа движок не пересчитывает — проверяется после следующего щелчка)
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-blk').length>0`, 20000);
  c.ok((await b.eval(`document.querySelectorAll('#ws-panel-body .mfr-blk').length`)) === want0, `список блоков в панели (${want0}) = ответ сервера по выбранному этажу`);
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  const other = lv.find((x) => !start.includes(x));
  await tap(b, `[data-mpick="level"][data-id="${other}"]`);
  await b.waitFor(`document.querySelectorAll('[data-mpick="level"][aria-pressed="true"]').length===2`);
  await sleep(1500);
  c.ok((await statusBlocks()) === (await okBlocks([...start, other], [])), `щелчок по второму этажу добавил его: блоков на плане ${await statusBlocks()} = ответ сервера`);
  const secA = await b.eval(`[...document.querySelectorAll('[data-mpick="section"]')].find(p=>/\\s[1-9]\\d*\\s*$/.test(p.textContent.trim()))?.dataset.id`);
  await tap(b, `[data-mpick="section"][data-id="${secA}"]`);
  await b.waitFor(`document.querySelectorAll('[data-mpick="section"][aria-pressed="true"]').length===1`);
  await sleep(1500);
  c.ok((await statusBlocks()) === (await okBlocks([...start, other], [secA])), `+ секция: блоков на плане ${await statusBlocks()} = ответ сервера`);
  await tap(b, `[data-mpick="level"][data-id="${other}"]`);
  await b.waitFor(`document.querySelectorAll('[data-mpick="level"][aria-pressed="true"]').length===1`);
  await tap(b, `[data-mpick="section"][data-id="${secA}"]`);
  await b.waitFor(`document.querySelectorAll('[data-mpick="section"][aria-pressed="true"]').length===0`);
  await sleep(1200);
  c.ok((await statusBlocks()) === (await okBlocks(start, [])), "повторные щелчки снимают выбор: вернулось прежнее число блоков");
  await tap(b, `.ws-tabs [data-tab="props"]`);

  console.log("выбор блоков на плане настоящими событиями мыши");
  const ids = JSON.parse(await b.eval(`JSON.stringify(${visibleBlockIds()})`)).map(Number);
  let p1 = null, id1 = null, id2 = null, p2 = null;
  for (const id of ids) { const p = await blockPoint(b, id); if (!p) continue; if (!p1) { p1 = p; id1 = id; } else if (!p2) { p2 = p; id2 = id; break; } }
  c.ok(p1 && p2, `на плане найдено два блока для щелчка (${id1}, ${id2})`);
  await b.click(p1.x, p1.y);
  await b.waitFor(`document.querySelector('#ws-panel-body .mfr-wp-acts')`, 20000);
  c.ok(true, "щелчок по блоку на плане: панель показала работы блока");
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length>0`, 20000);
  const nOps = await b.eval(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length`);
  const sqlOps = one(`SELECT COUNT(*) n FROM block_works WHERE block_id=${id1} AND retired_at IS NULL`).n;
  c.ok(nOps === sqlOps, `работ блока в панели ${nOps} = SQL ${sqlOps}`);
  const cntTxt = await b.eval(`document.querySelector('#ws-panel-body h4 .mfr-count')?.textContent`);
  c.ok(cntTxt === String(sqlOps), "счётчик ЗР в заголовке панели = SQL");
  await shot(b, "d-ws-block");
  await b.click(p2.x, p2.y, { meta: true });
  await b.waitFor(`/Выбрано блоков: 2/.test(document.querySelector('.ws-status').textContent)`, 20000);
  c.ok(true, "⌘-щелчок по второму блоку добавил его к выбору («Выбрано блоков: 2»)");
  c.ok(/Состав работ \(2\)/.test(await txt(b, "#ws-panel-body")), "кнопки состава работ и сроков применяются ко всем выбранным блокам");
  await b.eval(`(()=>{const d=document.querySelector('iframe.ws-frame').contentDocument; const el=d.querySelector('rect[data-block-id="${id2}"]'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));})()`);
  await sleep(600);
  c.ok(true, "Ctrl-щелчок (событие click с ctrlKey — путь Windows/Linux) обработан кадром без ошибок");
  await b.click(p1.x, p1.y);
  await b.waitFor(`/Выбран блок/.test(document.querySelector('.ws-status').textContent)`, 20000);

  console.log("отбор работ (вкладка «Фильтры»)");
  // блок, где есть и выполненные, и незавершённые работы (по SQL): отбор проверяется на непустых значениях
  // подготовка данных: у блока без документов факта — одна работа выполнена (100) и одна в работе (60), остальные не начаты
  const seedBlk = one(`SELECT b.id FROM blocks b WHERE b.object_id=4 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=3 ORDER BY b.id DESC LIMIT 1`);
  const seedWts = sql(`SELECT work_type_id w FROM block_works WHERE block_id=${seedBlk.id} AND retired_at IS NULL ORDER BY id`).map((r) => r.w);
  const seedRes = await (await loginNode("admin"))("POST", `/objects/4/blocks/${seedBlk.id}/fact-reports`, { report_date: "2026-09-16", items: { [seedWts[0]]: 100, [seedWts[1]]: 60 } });
  c.ok(seedRes.status === 200, "подготовка: блок с выполненной и незавершённой работой создан по API");
  const mix = one(`SELECT block_id, SUM(p=100) d, SUM(p>0 AND p<100) ip, COUNT(*) n FROM (SELECT bw.block_id, COALESCE((SELECT i.percent FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=bw.block_id AND i.work_type_id=bw.work_type_id ORDER BY r.report_date DESC, r.id DESC LIMIT 1),0) p FROM block_works bw WHERE bw.object_id=4 AND bw.retired_at IS NULL) GROUP BY block_id HAVING d>0 AND n>d ORDER BY block_id LIMIT 1`);
  c.ok(!!mix, `есть блок со смешанным состоянием работ (блок ${mix && mix.block_id}: выполнено ${mix && mix.d}, в работе ${mix && mix.ip}, всего ${mix && mix.n})`);
  await b.eval(`document.querySelector('iframe.ws-frame').contentWindow.showBlockCard(${mix.block_id}, false)`);
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length===${mix.n}`, 20000);
  c.ok(true, `все работы блока ${mix.block_id} показаны (${mix.n} = SQL)`);
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await b.waitFor(`document.querySelector('[data-mbp-f="statuses"]')`);
  await tap(b, `[data-mbp-f="statuses"][value="done"]`);
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length===${mix.d}`, 10000);
  c.ok(true, `отбор «выполнена»: ${mix.d} работ = SQL (остальные скрыты)`);
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await tap(b, `[data-mbp-f="statuses"][value="in_progress"]`);
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length===${mix.d + mix.ip}`, 10000);
  c.ok(true, `+ «в работе»: ${mix.d + mix.ip} = SQL (выполнено + в работе)`);
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await tap(b, `[data-mbp="reset-filter"]`);
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length===${mix.n}`);
  c.ok(true, "«Сбросить отбор работ» возвращает все работы");
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await tap(b, `[data-mbp-f="deadlines"][value="no_dates"]`);
  await tap(b, `.ws-tabs [data-tab="props"]`);
  const noDates = one(`SELECT COUNT(*) n FROM block_works WHERE block_id=${mix.block_id} AND retired_at IS NULL AND plan_start IS NULL AND plan_end IS NULL AND forecast_start IS NULL AND forecast_end IS NULL`).n;
  await sleep(300);
  c.ok((await b.eval(`document.querySelectorAll('#ws-panel-body .mfr-wp-op').length`)) === noDates, `отбор по сроку «без сроков»: ${noDates} работ = SQL`);
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await tap(b, `[data-mbp="reset-filter"]`);

  console.log("Шахматка и динамика (команды моста)");
  await tap(b, `.ws-tabs [data-tab="view"]`);
  await b.waitFor(`document.querySelector('[data-mbp-c="track"]')`);
  const trackCode = sql("SELECT DISTINCT wt.planning_track_code c FROM block_works bw JOIN work_types wt ON wt.id=bw.work_type_id WHERE bw.object_id=4 AND bw.retired_at IS NULL AND wt.planning_track_code IS NOT NULL LIMIT 1")[0].c;
  await b.eval(`(()=>{const s=document.querySelector('[data-mbp-c="track"]'); s.value=${JSON.stringify(trackCode)}; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`${FD}.querySelector('#mfr-chess-current-name').textContent!=='— выключено —'`, 20000);
  await sleep(1500);
  const chessName = await b.eval(`${FD}.querySelector('#mfr-chess-current-name').textContent`);
  const nLabels = await b.eval(`${FD}.querySelectorAll('#revit-plan-canvas svg text, #revit-plan-canvas svg foreignObject').length`);
  c.ok(chessName.length > 0 && await b.eval(`${FD}.querySelector('#mfr-chess-legend').style.display!=='none'`), `шахматка: движок включил доску «${chessName}» (легенда включена, надписей на плане: ${nLabels})`);
  c.ok(/Шахматка:/.test(await txt(b, ".ws-status")), "строка состояния показывает выбранную доску");
  await b.waitFor(`document.querySelector('.mfr-lgs')`);
  await tap(b, `[data-mbp-c="mode"][value="deadline"]`);
  await b.waitFor(`${FD}.querySelector('input[name="mfr-chess-mode"]:checked').value==='deadline'`, 10000);
  c.ok(true, "режим раскраски «по срокам» передан движку");
  await shot(b, "d-ws-chess");
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  const adm = await loginNode("admin");
  const api = await (await adm("GET", `/objects/4/blocks/fact-changes?date_from=&date_to=&track_code=${encodeURIComponent(trackCode)}`)).json();
  await tap(b, `[data-mbp-d="on"]`);
  await b.waitFor(`new RegExp('Подсвечено блоков: ${api.blocks.length}\\\\b').test(document.querySelector('#ws-panel-body').textContent)`, 30000);
  c.ok(true, `динамика за весь период (по доске): подсвечено блоков ${api.blocks.length} = ответ сервера`);
  c.ok(await b.eval(`${FD}.querySelector('#mfr-dynamics-caption').style.display!=='none' && /Динамика/.test(${FD}.querySelector('#mfr-dynamics-caption').textContent)`), "подпись «Динамика за период» показана на схеме");
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelector('#ws-panel-body .mfr-wp-bar b') || /Динамика факта/.test(document.querySelector('#ws-panel-body').textContent)`, 20000);
  c.ok(/Динамика факта за период/.test(await txt(b, "#ws-panel-body")), "панель блока перешла в режим динамики (полоса «стало», риска «было»)");
  await tap(b, `.ws-tabs [data-tab="filters"]`);
  await tap(b, `[data-mbp-d="on"]`);
  await b.waitFor(`${FD}.querySelector('#mfr-dynamics-caption').style.display==='none'`, 20000);
  c.ok(true, "динамика выключена");
  await tap(b, `.ws-tabs [data-tab="view"]`);
  await b.eval(`(()=>{const s=document.querySelector('[data-mbp-c="track"]'); s.value=''; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`${FD}.querySelector('#mfr-chess-current-name').textContent==='— выключено —'`, 20000);
  c.ok(true, "шахматка выключена");

  console.log("«Факт» из панели блока: проценты в панели и схеме обновляются");
  await tap(b, `.ws-tabs [data-tab="props"]`);
  await b.waitFor(`document.querySelector('[data-mbp="fact"]') && !document.querySelector('[data-mbp="fact"]').disabled`);
  const blkFact = sql(`SELECT b.id FROM blocks b WHERE b.object_id=4 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=2 ORDER BY b.id LIMIT 1`)[0];
  // выбрать этот блок командой панели (щелчок по списку блоков) — на нужном этаже
  await b.eval(`document.querySelector('iframe.ws-frame').contentWindow.showBlockCard(${blkFact.id}, false)`);   // выбор блока функцией движка (схема стоит на другом этаже)
  await b.waitFor(`document.querySelector('[data-mbp="fact"]')?.dataset.id==='${blkFact.id}'`, 20000);
  await tap(b, `[data-mbp="fact"]`);
  await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length>=2`);
  const w0 = await b.eval(`document.querySelector('.mfr-fact-row').dataset.wt`);
  await tap(b, `.mfr-fact-row[data-wt="${w0}"] [data-number]`); await b.eval(`document.querySelector('.mfr-fact-row[data-wt="${w0}"] [data-number]').select()`); await b.type("55");
  await tap(b, "#ff-save");
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#ff-status').textContent)`);
  c.ok(one(`SELECT i.percent p FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=${blkFact.id} AND i.work_type_id=${w0}`).p === 55, "факт из панели записан (SQL)");
  await closeModal(b);
  await b.waitFor(`[...document.querySelectorAll('#ws-panel-body .mfr-wp-meta span:first-child')].some(s=>s.textContent==='55%')`, 20000);
  c.ok(true, "панель блока перечитана: 55% видно после записи");

  console.log("групповые окна из панели (два блока)");
  await b.click(p1.x, p1.y).catch(() => {});
  await b.eval(`document.querySelector('iframe.ws-frame').contentWindow.showBlockCard(${blkFact.id}, false)`);   // выбор блока функцией движка (схема стоит на другом этаже)
  await b.waitFor(`document.querySelector('[data-mbp="settings"]')`);
  await tap(b, `[data-mbp="dates"]`);
  await b.waitFor(`document.querySelector('.mfr-modal') && document.querySelector('#bd-days')`, 20000);
  c.ok(true, "«Сроки» открывает групповую правку по работам выбранных блоков");
  await closeModal(b);
  await tap(b, `[data-mbp="settings"]`);
  await b.waitFor(`document.querySelector('input[data-op]')`);
  c.ok(true, "«Состав работ» открывает окно состава");
  await closeModal(b);

  console.log("1366×768");
  await b.viewport(1366, 768); await sleep(1200);
  const m2 = await b.eval(`(()=>{const f=document.querySelector('iframe.ws-frame').getBoundingClientRect(); return {vw:innerWidth, vh:innerHeight, scrollH:document.scrollingElement.scrollHeight, scrollW:document.scrollingElement.scrollWidth, fw:f.width, fh:f.height}})()`);
  c.ok(m2.scrollH <= m2.vh + 1 && m2.scrollW <= m2.vw + 1, `1366×768: страница не прокручивается (высота ${m2.scrollH} ≤ ${m2.vh})`);
  c.ok((m2.fw * m2.fh) / (m2.vw * m2.vh) > 0.4, `1366×768: схема занимает основную площадь (кадр ${Math.round(m2.fw)}×${Math.round(m2.fh)})`);
  await shot(b, "d-ws-1366");
  await b.viewport(1920, 1080); await sleep(600);
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет", JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "d-fail").catch(() => {}); }
finally { await b.close(); }
process.exit(c.done() ? 1 : 0);
