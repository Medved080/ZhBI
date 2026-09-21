// Браузерная проверка «Факт» (создание, исправление, построчный аудит, удаление), «Состав работ» (одного блока и группы, мягкое снятие, предпросмотр,
// конкуренция) и групповой правки сроков (предпросмотр, применение, конкуренция, отказ внутри пачки) на НАСТОЯЩЕМ backend и временной копии БД.
// Только scripts/cdp.mjs (настоящие события мыши и клавиатуры). Запуск: MFR_BASE=... MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr_browser_b.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, txt, exists, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("fact+settings+bulk");
const events = async (action, since) => { await sleep(1800); return one(`SELECT COUNT(*) n FROM activity_log WHERE action='${action}' AND id>${since}`).n; };
const lastEv = async () => { await sleep(1800); return one("SELECT COALESCE(MAX(id),0) m FROM activity_log").m; };
async function setVal(b, sel, v) { await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
const reqs = (b, method, re) => b.requests.filter((r) => r.method === method && re.test(r.url)).length;
async function typeNum(b, sel, text) { await tap(b, sel); await b.eval(`document.querySelector(${JSON.stringify(sel)}).select()`); await b.type(text); }
async function dialogBtn(b, label) { await b.waitFor(`document.querySelector('.v2-dialog')`); await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`); }
async function loginNode(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: process.env.MFR_PASSWORD || "Test-Pass-1234!" }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
  return (method, path, body) => fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
}

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
try {
  await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
  // блок без документов факта, с ≥ 3 активными ЗР; второй такой же — для группы
  const cand = sql("SELECT b.id FROM blocks b WHERE b.object_id=4 AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=4 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) ORDER BY b.id LIMIT 3");
  const blk = cand[0].id, blk2 = cand[1].id;
  const wts = sql(`SELECT work_type_id w FROM block_works WHERE block_id=${blk} AND retired_at IS NULL ORDER BY id`).map((r) => r.w);
  await tap(b, `.mfr-blk[data-b="${blk}"]`);
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);

  console.log("Факт: новый документ");
  await tap(b, "#bs-fact");
  await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length===${wts.length}`);
  c.ok(true, `форма факта: строк по числу работ блока (${wts.length})`);
  await shot(b, "b-fact-new");
  await setVal(b, "#ff-date", "2026-09-15");
  const w0 = wts[0], w1 = wts[1];
  await typeNum(b, `.mfr-fact-row[data-wt="${w0}"] [data-number]`, "35");
  await typeNum(b, `.mfr-fact-row[data-wt="${w1}"] [data-number]`, "100");
  c.ok(await b.eval(`!document.querySelector('#ff-save').disabled`), "«Сохранить» доступна после ввода (настоящий ввод с клавиатуры)");
  const rq0 = reqs(b, "POST", /fact-reports$/);
  await tap(b, "#ff-save");
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#ff-status').textContent)`);
  const rep = one(`SELECT id, report_date FROM work_fact_reports WHERE block_id=${blk} ORDER BY id DESC LIMIT 1`);
  c.ok(reqs(b, "POST", /fact-reports$/) === rq0 + 1 && rep && rep.report_date === "2026-09-15", "один POST, документ создан (SQL)");
  const items = Object.fromEntries(sql(`SELECT work_type_id w, percent p FROM work_fact_items WHERE report_id=${rep.id}`).map((r) => [r.w, r.p]));
  c.ok(items[w0] === 35 && items[w1] === 100 && Object.keys(items).length === wts.length, "строки документа в БД (SQL): 35 и 100");
  await b.eval(`location.reload()`); await sleep(1500);
  await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
  await tap(b, `.mfr-blk[data-b="${blk}"]`);
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);
  const shownPct = await b.eval(`[...document.querySelectorAll('tr[data-bw]')].map(t=>t.querySelector('.num').textContent)`);
  c.ok(shownPct.includes("35%") && shownPct.includes("100%"), "после перезагрузки страницы проценты 35% и 100% видны в таблице работ");
  await tap(b, "#bs-fact");
  await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length===${wts.length}`);
  await tap(b, `.mfr-fact-rep[data-rep="${rep.id}"]`);
  await b.waitFor(`document.querySelector('.mfr-fact-row[data-wt="${w0}"] [data-number]').value==='35'`);
  c.ok(true, "документ открывается из списка документов блока, значения на месте");

  console.log("Факт: исправление, построчная история");
  await typeNum(b, `.mfr-fact-row[data-wt="${w0}"] [data-number]`, "60");
  const put0 = reqs(b, "PUT", /fact-reports\/\d+$/);
  const r0 = await b.rect("#ff-save");
  await b.click(r0.cx, r0.cy, { count: 2 });   // двойной клик
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#ff-status').textContent)`);
  await sleep(400);
  c.ok(reqs(b, "PUT", /fact-reports\/\d+$/) === put0 + 1, "двойной клик по «Сохранить» — ровно один PUT");
  c.ok(one(`SELECT percent p FROM work_fact_items WHERE report_id=${rep.id} AND work_type_id=${w0}`).p === 60, "исправленное значение в БД (SQL)");
  const h = one(`SELECT percent_old o, percent_new n FROM work_fact_item_history WHERE report_id=${rep.id}`);
  c.ok(h && h.o === 35 && h.n === 60 && one(`SELECT COUNT(*) n FROM work_fact_item_history WHERE report_id=${rep.id}`).n === 1, "построчная история правок: «было 35 → стало 60», одна запись (SQL)");
  await tap(b, `[data-audit="${w0}"]`);
  await b.waitFor(`document.querySelector('[data-audit-box="${w0}"] table')`);
  const audit = await txt(b, `[data-audit-box="${w0}"]`);
  c.ok(audit.includes("60") && audit.includes("35% → 60%"), "построчный аудит на экране: значения по датам и «35% → 60%»");
  await shot(b, "b-fact-audit");

  console.log("Факт: конфликт, сбой сети, потерянный ответ");
  const other = await loginNode("user3");
  const cur = await (await other("GET", `/objects/4/blocks/${blk}/fact-reports/${rep.id}`)).json();
  const ro = await other("PUT", `/objects/4/blocks/${blk}/fact-reports/${rep.id}`, { report_date: "2026-09-15", items: { ...cur.items, [w1]: 90 }, expected_rev: cur.rev });
  c.ok(ro.status === 200, "чужая правка документа (user3)");
  await typeNum(b, `.mfr-fact-row[data-wt="${w0}"] [data-number]`, "65");
  await tap(b, "#ff-save");
  await b.waitFor(`/изменили после того/.test(document.querySelector('#ff-status').textContent)`);
  c.ok(one(`SELECT percent p FROM work_fact_items WHERE report_id=${rep.id} AND work_type_id=${w0}`).p === 60 && one(`SELECT percent p FROM work_fact_items WHERE report_id=${rep.id} AND work_type_id=${w1}`).p === 90, "конфликт: чужая правка не затёрта, ничего не записано (SQL)");
  c.ok((await b.eval(`document.querySelector('.mfr-fact-row[data-wt="${w0}"] [data-number]').value`)) === "65", "ввод человека остался в форме");
  await tap(b, "#ff-reload");
  await b.waitFor(`document.querySelector('.mfr-fact-row[data-wt="${w1}"] [data-number]').value==='90'`);
  c.ok(true, "«Загрузить версию сервера» показала правку другого пользователя");
  await typeNum(b, `.mfr-fact-row[data-wt="${w0}"] [data-number]`, "70");
  const put1 = reqs(b, "PUT", /fact-reports\/\d+$/);
  await b.offline(true);
  await tap(b, "#ff-save");
  await b.waitFor(`/на сервере не найдено|исход неизвестен/.test(document.querySelector('#ff-status').textContent)`, 20000);
  await b.offline(false); await sleep(600);
  c.ok(reqs(b, "PUT", /fact-reports\/\d+$/) === put1 + 1 && one(`SELECT percent p FROM work_fact_items WHERE report_id=${rep.id} AND work_type_id=${w0}`).p === 60, "сбой сети: один PUT, автоповтора нет, БД не менялась (SQL)");
  c.ok((await b.eval(`document.querySelector('.mfr-fact-row[data-wt="${w0}"] [data-number]').value`)) === "70", "ввод остался в форме");
  await b.eval(`(()=>{ if(!window.__of){ window.__of=window.fetch.bind(window); window.fetch=async (...a)=>{ const r=await window.__of(...a); if(window.__dropNext && a[1] && (a[1].method==='PUT'||a[1].method==='POST'||a[1].method==='DELETE')){ window.__dropNext=false; throw new TypeError('Failed to fetch'); } return r; }; } window.__dropNext=true; })()`);
  await tap(b, "#ff-save");
  await b.waitFor(`/сервер подтвердил/.test(document.querySelector('#ff-status').textContent)`, 20000);
  c.ok(one(`SELECT percent p FROM work_fact_items WHERE report_id=${rep.id} AND work_type_id=${w0}`).p === 70 && reqs(b, "PUT", /fact-reports\/\d+$/) === put1 + 2, "потерян ответ ПОСЛЕ записи: запись состоялась, интерфейс подтвердил чтением, повторной отправки нет");

  console.log("Факт: удаление (необратимо, с подтверждением)");
  await tap(b, "#ff-del");
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  const dlg = await txt(b, ".v2-dialog");
  c.ok(dlg.includes("15.09.2026") && dlg.includes("необратимо"), "подтверждение показывает дату и необратимость");
  await dialogBtn(b, "Отмена"); await sleep(300);
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${rep.id}`).n === 1, "«Отмена» — документ цел (SQL)");
  const ev0 = await lastEv();
  await tap(b, "#ff-del");
  await dialogBtn(b, "Удалить документ");
  await b.waitFor(`/удалён/.test(document.querySelector('#ff-status').textContent)`);
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${rep.id}`).n === 0 && one(`SELECT COUNT(*) n FROM work_fact_items WHERE report_id=${rep.id}`).n === 0 && one(`SELECT COUNT(*) n FROM work_fact_item_history WHERE report_id=${rep.id}`).n === 0, "документ, строки и история удалены (SQL)");
  c.ok((await events("block_fact_report_delete", ev0)) === 1, "журнал: block_fact_report_delete");
  await tap(b, ".mfr-modal [data-mclose]");

  console.log("Состав работ одного блока: мягкое снятие, предпросмотр");
  const zrsoft = sql(`SELECT id, work_type_id w FROM block_works WHERE block_id=${blk} AND retired_at IS NULL AND (plan_start IS NOT NULL OR forecast_start IS NOT NULL) ORDER BY id LIMIT 1`)[0];
  const softId = zrsoft ? zrsoft.id : sql(`SELECT id FROM block_works WHERE block_id=${blk} AND retired_at IS NULL ORDER BY id LIMIT 1`)[0].id;
  if (!zrsoft) { const o = await loginNode("admin"); const w = await (await o("GET", `/objects/4/block-works/${softId}`)).json(); await o("PATCH", `/objects/4/block-works/${softId}`, { plan_start: "2026-10-01", plan_end: "2026-10-03", expected_rev: w.rev }); }
  const softWt = one(`SELECT work_type_id w FROM block_works WHERE id=${softId}`).w;
  await tap(b, "#bs-settings");
  await b.waitFor(`document.querySelector('input[data-op]')`);
  await shot(b, "b-settings");
  await tap(b, `input[data-op="${softWt}"]`);
  await tap(b, "#ss-preview-btn");
  await b.waitFor(`document.querySelector('#ss-apply')`);
  const pv = await txt(b, "#ss-preview");
  c.ok(/Снимется «мягко».*: 1/.test(pv.replace(/\n/g, " ")) || pv.includes("мягко"), "предпросмотр: работа со сроками снимается «мягко»");
  await shot(b, "b-settings-preview");
  const fpBefore = one(`SELECT retired_at FROM block_works WHERE id=${softId}`);
  c.ok(fpBefore.retired_at === null, "до применения работа не снята (предпросмотр ничего не пишет)");
  await tap(b, "#ss-apply");
  await b.waitFor(`/подтверждён чтением/.test(document.querySelector('#ss-status').textContent)`);
  c.ok(one(`SELECT retired_at IS NOT NULL r FROM block_works WHERE id=${softId}`).r === 1, "ЗР со сроками снята мягко: строка цела, retired_at заполнен (SQL)");
  await tap(b, ".mfr-modal [data-mclose]");
  await b.waitFor(`!document.querySelector('.mfr-modal')`);
  // возврат: включить обратно
  await tap(b, "#bs-settings");
  await b.waitFor(`document.querySelector('input[data-op]')`);
  await tap(b, `input[data-op="${softWt}"]`);
  await tap(b, "#ss-preview-btn");
  await b.waitFor(`document.querySelector('#ss-apply')`);
  await tap(b, "#ss-apply");
  await b.waitFor(`/подтверждён чтением/.test(document.querySelector('#ss-status').textContent)`);
  c.ok(one(`SELECT retired_at IS NULL a FROM block_works WHERE id=${softId}`).a === 1, "возврат: retired_at очищен, строка та же (SQL)");
  await tap(b, ".mfr-modal [data-mclose]");

  console.log("Состав работ ГРУППЫ блоков: предпросмотр, конкуренция, атомарность");
  await tap(b, `.mfr-blk[data-b="${blk2}"]`, { meta: true });
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===2`);
  await tap(b, "#bs-settings");
  await b.waitFor(`document.querySelector('input[data-op]')`);
  const groupWt = one(`SELECT work_type_id w FROM block_works WHERE block_id=${blk2} AND retired_at IS NULL ORDER BY id DESC LIMIT 1`).w;
  await tap(b, `input[data-op="${groupWt}"]`);
  await tap(b, "#ss-preview-btn");
  await b.waitFor(`document.querySelector('#ss-apply')`);
  c.ok((await txt(b, "#ss-preview")).includes("одной операцией"), "предпросмотр группы: «все блоки сохраняются одной операцией»");
  // чужая правка состава между предпросмотром и применением
  const o2 = await loginNode("user3");
  const setg = await (await o2("GET", `/objects/4/blocks/${blk2}/work-types-settings`)).json();
  const pv2 = await (await o2("POST", `/objects/4/blocks/work-types-settings/preview`, { block_ids: [blk2], work_type_ids: setg.selected.filter((x) => x !== setg.selected[0]) })).json();
  const rr = await o2("PUT", `/objects/4/blocks/${blk2}/work-types-settings`, { work_type_ids: setg.selected.filter((x) => x !== setg.selected[0]), expected: pv2.expected[String(blk2)] });
  c.ok(rr.status === 200, "чужая правка состава блока (user3)");
  const snap = JSON.stringify(sql(`SELECT id, retired_at FROM block_works WHERE block_id IN (${blk},${blk2}) ORDER BY id`));
  await tap(b, "#ss-apply");
  await dialogBtn(b, "Применить");   // подтверждение: в набор входят пустые работы, их удаление необратимо
  await b.waitFor(`/изменили после предпросмотра|Обновить состав/.test(document.querySelector('#ss-status').textContent + (document.querySelector('#ss-reload')?.textContent||''))`);
  c.ok(JSON.stringify(sql(`SELECT id, retired_at FROM block_works WHERE block_id IN (${blk},${blk2}) ORDER BY id`)) === snap, "конфликт при применении группы: ни один блок не изменился (SQL)");
  await tap(b, ".mfr-modal [data-mclose]");
  await dialogBtn(b, "Не сохранять");   // сторож: состав изменён, но не сохранён
  await b.waitFor(`!document.querySelector('.mfr-modal')`);
  c.ok(true, "закрытие окна с несохранённым составом спрашивает подтверждение (сторож)");
  // вернуть состав blk2
  const back = await (await o2("POST", `/objects/4/blocks/work-types-settings/preview`, { block_ids: [blk2], work_type_ids: setg.selected })).json();
  await o2("PUT", `/objects/4/blocks/${blk2}/work-types-settings`, { work_type_ids: setg.selected, expected: back.expected[String(blk2)] });

  console.log("Групповая правка сроков: предпросмотр → применение, конкуренция, граница дат");
  await tap(b, `.mfr-blk[data-b="${blk}"]`);
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===1 && document.querySelectorAll('tr[data-bw]').length>=3`);
  await tap(b, "#bs-pick-all");
  await b.waitFor(`!document.querySelector('#bs-bulk').disabled`);
  const ids = await b.eval(`[...document.querySelectorAll('tr[data-bw]')].map(t=>Number(t.dataset.bw))`);
  const before = sql(`SELECT id, plan_start, plan_end FROM block_works WHERE id IN (${ids.join(",")}) ORDER BY id`);
  await tap(b, "#bs-bulk");
  await b.waitFor(`document.querySelector('#bd-days')`);
  await tap(b, "#bd-days"); await b.type("3");
  await tap(b, "#bd-preview");
  await b.waitFor(`document.querySelector('#bd-apply')`);
  const willText = await b.eval(`document.querySelector('#bd-pv p b')?.textContent`);
  const nWill = Number((willText || "").match(/(\d+) из/)?.[1]);
  const withDates = before.filter((r) => r.plan_start || r.plan_end).length;
  c.ok(nWill === withDates, `предпросмотр: изменится ${nWill} = число работ с датами (${withDates}); БД ещё не менялась`);
  c.ok(JSON.stringify(sql(`SELECT id, plan_start, plan_end FROM block_works WHERE id IN (${ids.join(",")}) ORDER BY id`)) === JSON.stringify(before), "предпросмотр ничего не записал (SQL до/после)");
  await shot(b, "b-bulk-preview");
  // чужая правка после предпросмотра → конфликт
  const o3 = await loginNode("user3");
  const victim = ids[ids.length - 1];
  const vw = await (await o3("GET", `/objects/4/block-works/${victim}`)).json();
  await o3("PATCH", `/objects/4/block-works/${victim}`, { note: "чужая правка", expected_rev: vw.rev });
  const snap2 = JSON.stringify(sql(`SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works WHERE id IN (${ids.join(",")}) ORDER BY id`));
  await tap(b, "#bd-apply");
  await b.waitFor(`/изменили после предпросмотра|Ничего не изменено/.test(document.querySelector('#bd-status').textContent)`);
  c.ok(JSON.stringify(sql(`SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works WHERE id IN (${ids.join(",")}) ORDER BY id`)) === snap2, "конфликт: ни одна работа пачки не изменилась (SQL до/после)");
  // заново: предпросмотр → применение
  await tap(b, "#bd-days").catch(() => {});
  await b.waitFor(`document.querySelector('#bd-preview')`);
  await tap(b, "#bd-preview");
  await b.waitFor(`document.querySelector('#bd-apply')`);
  const ev1 = await lastEv();
  await tap(b, "#bd-apply");
  await b.waitFor(`/Применено/.test(document.querySelector('#bd-status').textContent)`);
  const after = sql(`SELECT id, plan_start, plan_end FROM block_works WHERE id IN (${ids.join(",")}) ORDER BY id`);
  const shifted = (d, n) => { if (!d) return d; const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  c.ok(before.every((r, i) => after[i].plan_start === shifted(r.plan_start, 3) && after[i].plan_end === shifted(r.plan_end, 3)), "после применения все даты сдвинуты на +3 дня (SQL)");
  c.ok((await events("block_work_bulk_edit", ev1)) === 1, "журнал: одно сводное block_work_bulk_edit");
  await tap(b, ".mfr-modal [data-mclose]");
  // граница дат: работа с датой 9999-12-30 → применение недоступно
  const w9 = await (await o3("GET", `/objects/4/block-works/${ids[0]}`)).json();
  await o3("PATCH", `/objects/4/block-works/${ids[0]}`, { plan_start: "9999-12-01", plan_end: "9999-12-30", expected_rev: w9.rev });
  await tap(b, `.mfr-blk[data-b="${blk2}"]`); await tap(b, `.mfr-blk[data-b="${blk}"]`);
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>=3`);
  await tap(b, "#bs-pick-all");
  await tap(b, "#bs-bulk");
  await b.waitFor(`document.querySelector('#bd-days')`);
  await tap(b, "#bd-days"); await b.type("3");
  await tap(b, "#bd-preview");
  await b.waitFor(`document.querySelector('#bd-pv')`);
  await sleep(500);
  c.ok(await b.eval(`document.querySelector('#bd-apply') ? document.querySelector('#bd-apply').disabled : true`), "сдвиг за границу дат: «Применить» недоступна (набор применяется целиком или никак)");
  await tap(b, ".mfr-modal [data-mclose]");
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет", JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "b-fail").catch(() => {}); }
finally { await b.close(); }
process.exit(c.done() ? 1 : 0);
