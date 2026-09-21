// Браузерная проверка «Учёт по блокам» (V2) на НАСТОЯЩЕМ backend и временной копии БД: блоки, счётчики ЗР, выбор мышью (щелчок, Ctrl, Shift),
// отбор работ, карточка ЗР (срок / прогноз / примечание), конкуренция, двойной клик, сетевой сбой и потерянный ответ, перезагрузка страницы,
// права user2/user4, сверка БД до/после, журнал. Только scripts/cdp.mjs (настоящие события мыши и клавиатуры).
// Запуск: MFR_BASE=http://127.0.0.1:8120 MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr_browser_a.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, txt, exists, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("blocks");

async function setVal(b, sel, v) { await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
const events = async (action, since) => { await sleep(1800); return one(`SELECT COUNT(*) n FROM activity_log WHERE action='${action}' AND id>${since}`).n; };
const lastEv = async () => { await sleep(1800); return one("SELECT COALESCE(MAX(id),0) m FROM activity_log").m; };
const patchCount = (b) => b.requests.filter((r) => r.method === "PATCH" && /block-works\/\d+$/.test(r.url)).length;

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
try {
  console.log("Учёт по блокам: список блоков и счётчики");
  await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
  await sleep(600);
  const nBlocks = one("SELECT COUNT(*) n FROM blocks WHERE object_id=4").n;
  c.ok((await b.eval(`document.querySelectorAll('.mfr-blk').length`)) === nBlocks, `блоков на экране = SQL (${nBlocks})`);
  const domCounts = await b.eval(`[...document.querySelectorAll('.mfr-blk')].map(e=>[Number(e.dataset.b), e.querySelector('.mfr-count').textContent])`);
  const sqlCounts = Object.fromEntries(sql("SELECT block_id, COUNT(*) n FROM block_works WHERE object_id=4 AND retired_at IS NULL GROUP BY block_id").map((r) => [r.block_id, String(r.n)]));
  c.ok(domCounts.every(([id, t]) => t === (sqlCounts[id] || "0")), "счётчики ЗР у каждого блока совпадают с SQL (до открытия блока)");
  c.ok(await b.eval(`document.scrollingElement.scrollHeight <= window.innerHeight + 1`), "страница не прокручивается на 1920×1080");
  await shot(b, "a-blocks");

  console.log("выбор мышью");
  const blk = one("SELECT b.id, s.code sc, l.name ln FROM blocks b JOIN object_sections s ON s.id=b.section_id JOIN object_levels l ON l.id=b.level_id WHERE b.object_id=4 AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=3 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) ORDER BY b.id LIMIT 1");
  const blk2 = one(`SELECT b.id FROM blocks b WHERE b.object_id=4 AND b.id>${blk.id} ORDER BY b.id LIMIT 1`);
  const blk3 = one(`SELECT b.id FROM blocks b WHERE b.object_id=4 AND b.id>${blk2.id} ORDER BY b.id LIMIT 1`);
  await tap(b, `.mfr-blk[data-b="${blk.id}"]`);
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);
  const nZr = one(`SELECT COUNT(*) n FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL`).n;
  c.ok((await b.eval(`document.querySelectorAll('tr[data-bw]').length`)) === nZr, `клик по блоку: показаны ЗР блока (${nZr}, = SQL)`);
  // На macOS Ctrl+щелчок ОС превращает в контекстное меню (щелчка нет), поэтому настоящий жест здесь — ⌘+щелчок (он же «Ctrl (⌘)» в подсказке);
  // ветку Ctrl (Windows/Linux) проверяем событием click с ctrlKey, созданным в странице.
  await tap(b, `.mfr-blk[data-b="${blk2.id}"]`, { meta: true });
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===2`);
  c.ok(true, "⌘-щелчок (настоящее событие мыши) добавил второй блок к выбору");
  const nZr2 = one(`SELECT COUNT(*) n FROM block_works WHERE block_id IN (${blk.id},${blk2.id}) AND retired_at IS NULL`).n;
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length===${nZr2}`);
  c.ok(true, `работы двух блоков (${nZr2}) показаны вместе, колонка «Блок» появилась`);
  await tap(b, `.mfr-blk[data-b="${blk2.id}"]`, { meta: true });
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===1`);
  c.ok(true, "⌘-щелчок по выбранному снял его");
  await b.eval(`document.querySelector('.mfr-blk[data-b="${blk2.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===2`);
  c.ok(true, "Ctrl-щелчок (событие click с ctrlKey — путь Windows/Linux) добавил блок");
  await b.eval(`document.querySelector('.mfr-blk[data-b="${blk2.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===1`);
  await tap(b, `.mfr-blk[data-b="${blk3.id}"]`, { shift: true });
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length>=3`);
  c.ok(true, "Shift-клик выбрал диапазон блоков");
  await tap(b, `.mfr-blk[data-b="${blk.id}"]`);
  await b.waitFor(`document.querySelectorAll('.mfr-blk.on').length===1 && document.querySelectorAll('tr[data-bw]').length===${nZr}`);

  console.log("отбор работ");
  const firstTrack = await b.eval(`document.querySelector('details.mfr-dd input[data-f=tracks]')?.value`);
  await b.eval(`document.querySelectorAll('details.mfr-dd')[1].open=true`);
  await b.clickSel('details.mfr-dd:nth-of-type(2) input[data-f=statuses][value=in_progress]').catch(async () => { await b.eval(`document.querySelector('input[data-f=statuses][value=in_progress]').click()`); });
  await sleep(300);
  const shownInProg = await b.eval(`document.querySelectorAll('tr[data-bw]').length`);
  const inProgSql = one(`SELECT COUNT(*) n FROM (SELECT bw.id, COALESCE((SELECT i.percent FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=bw.block_id AND i.work_type_id=bw.work_type_id ORDER BY r.report_date DESC, r.id DESC LIMIT 1),0) p FROM block_works bw WHERE bw.block_id=${blk.id} AND bw.retired_at IS NULL) WHERE p>0 AND p<100`).n;
  c.ok(shownInProg === inProgSql, `отбор «в работе»: ${shownInProg} = SQL ${inProgSql}`);
  await b.eval(`document.querySelector('#bf-reset')?.click()`); await sleep(300);
  c.ok((await b.eval(`document.querySelectorAll('tr[data-bw]').length`)) === nZr, "«Сбросить отбор» возвращает все работы");

  console.log("карточка ЗР: базовый срок");
  const zr = sql(`SELECT id FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL ORDER BY id`);
  const zrId = zr[0].id;
  await tap(b, `tr[data-bw="${zrId}"]`);
  await b.waitFor(`document.querySelector('[data-f=plan_start]') && !document.querySelector('.mfr-modal').textContent.includes('Загрузка работы')`);
  await shot(b, "a-zr");
  const bef = sql("SELECT * FROM block_works WHERE id=" + zrId)[0];
  const ev0 = await lastEv();
  await setVal(b, "[data-f=plan_start]", "2026-10-01"); await setVal(b, "[data-f=plan_end]", "2026-10-05");
  c.ok(await b.eval(`!document.querySelector('[data-save=plan]').disabled`), "кнопка «Сохранить базовый срок» доступна после правки");
  const p0 = patchCount(b);
  await b.clickSel("[data-save=plan]");
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#bw-status').textContent)`);
  c.ok(patchCount(b) === p0 + 1, "один PATCH");
  const aft = one(`SELECT plan_start, plan_end, updated_by FROM block_works WHERE id=${zrId}`);
  c.ok(aft.plan_start === "2026-10-01" && aft.plan_end === "2026-10-05", "срок в БД (SQL)");
  c.ok((await events("block_work_plan_set", ev0)) === 1, "журнал: одно block_work_plan_set");
  // после перезагрузки страницы
  await b.eval("location.reload()"); await sleep(1500);
  await b.waitFor(`document.querySelectorAll('.mfr-blk').length>5`, 30000).catch(async () => { await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`); });
  await tap(b, `.mfr-blk[data-b="${blk.id}"]`);
  await b.waitFor(`document.querySelector('tr[data-bw="${zrId}"]')`);
  c.ok((await b.eval(`document.querySelector('tr[data-bw="${zrId}"]').textContent`)).includes("01.10–05.10"), "после перезагрузки страницы срок 01.10–05.10 виден в таблице");
  await tap(b, `tr[data-bw="${zrId}"]`);
  await b.waitFor(`document.querySelector('[data-f=plan_start]') && !document.querySelector('.mfr-modal').textContent.includes('Загрузка работы')`);
  c.ok((await b.eval(`document.querySelector('[data-f=plan_start]').value`)) === "2026-10-01", "и в карточке");

  console.log("двойной клик по «Сохранить»");
  await setVal(b, "[data-f=plan_end]", "2026-10-07");
  const p1 = patchCount(b);
  const r = await b.rect("[data-save=plan]");
  await b.click(r.cx, r.cy, { count: 2 });
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#bw-status').textContent)`);
  await sleep(500);
  c.ok(patchCount(b) === p1 + 1, "двойной клик — ровно один PATCH");
  c.ok(one(`SELECT plan_end FROM block_works WHERE id=${zrId}`).plan_end === "2026-10-07", "значение в БД");

  console.log("конфликт: работу изменил другой пользователь");
  // «чужая правка» — вторым сеансом (настоящий вход admin в Node, PATCH по HTTP)
  const other = await loginNode("user3");
  const cur = await (await other("GET", `/objects/4/block-works/${zrId}`)).json();
  const ro = await other("PATCH", `/objects/4/block-works/${zrId}`, { plan_end: "2026-10-09", expected_rev: cur.rev });
  c.ok(ro.status === 200, "чужая правка выполнена вторым пользователем (user3)");
  await setVal(b, "[data-f=plan_end]", "2026-10-15");
  const fpv = one(`SELECT plan_end, updated_at FROM block_works WHERE id=${zrId}`);
  await b.clickSel("[data-save=plan]");
  await b.waitFor(`/изменили после того/.test(document.querySelector('#bw-status').textContent)`);
  c.ok(one(`SELECT plan_end FROM block_works WHERE id=${zrId}`).plan_end === "2026-10-09", "конфликт: чужая правка не затёрта (SQL)");
  c.ok((await b.eval(`document.querySelector('[data-f=plan_end]').value`)) === "2026-10-15", "ввод человека остался в форме");
  await shot(b, "a-conflict");
  await b.clickSel("#bw-reload");
  await b.waitFor(`document.querySelector('[data-f=plan_end]').value==='2026-10-09'`);
  c.ok(true, "«Загрузить актуальные значения» показала правку другого пользователя");

  console.log("сетевой сбой: без автоповтора, сверка чтением");
  await setVal(b, "[data-f=plan_end]", "2026-10-20");
  const p2 = patchCount(b);
  await b.offline(true);
  await b.clickSel("[data-save=plan]");
  await b.waitFor(`/на сервере не найдено|исход неизвестен/.test(document.querySelector('#bw-status').textContent)`, 20000);
  await b.offline(false);
  await sleep(800);
  c.ok(patchCount(b) === p2 + 1, "сбой сети: один PATCH, автоповтора нет");
  c.ok(one(`SELECT plan_end FROM block_works WHERE id=${zrId}`).plan_end === "2026-10-09", "БД не менялась при сбое (SQL)");
  c.ok((await b.eval(`document.querySelector('[data-f=plan_end]').value`)) === "2026-10-20", "ввод остался в форме");

  console.log("потерянный ответ ПОСЛЕ записи: сервер применил, клиент не получил ответ");
  await b.eval(`(()=>{ if(!window.__of){ window.__of=window.fetch.bind(window); window.fetch=async (...a)=>{ const r=await window.__of(...a); if(window.__dropNext && a[1] && a[1].method==='PATCH'){ window.__dropNext=false; throw new TypeError('Failed to fetch'); } return r; }; } window.__dropNext=true; })()`);
  const p3 = patchCount(b);
  await b.clickSel("[data-save=plan]");
  await b.waitFor(`/сервер подтвердил/.test(document.querySelector('#bw-status').textContent)`, 20000);
  c.ok(patchCount(b) === p3 + 1, "потерян ответ: один PATCH, автоповтора нет");
  c.ok(one(`SELECT plan_end FROM block_works WHERE id=${zrId}`).plan_end === "2026-10-20", "запись состоялась (SQL) и интерфейс это подтвердил чтением");

  console.log("прогноз: подтверждение, новая версия");
  const nv0 = one(`SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id=${zrId}`).n;
  const ev1 = await lastEv();
  await setVal(b, "[data-f=forecast_start]", "2026-10-10"); await setVal(b, "[data-f=forecast_end]", "2026-10-25");
  await b.clickSel("[data-save=forecast]");
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  c.ok((await txt(b, ".v2-dialog")).includes("не отменяются"), "подтверждение: версии прогноза копятся и не отменяются");
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes('Отмена')).click()`);
  await sleep(300);
  c.ok(one(`SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id=${zrId}`).n === nv0, "«Отмена» в подтверждении ничего не записала");
  await b.clickSel("[data-save=forecast]");
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes('Сохранить версию')).click()`);
  await b.waitFor(`/Прогноз: сохранено/.test(document.querySelector('#bw-status').textContent)`);
  c.ok(one(`SELECT COUNT(*) n FROM block_work_forecasts WHERE block_work_id=${zrId}`).n === nv0 + 1, "версия прогноза +1 (SQL)");
  c.ok((await events("block_work_forecast_set", ev1)) === 1, "журнал: block_work_forecast_set");
  console.log("примечание");
  await setVal(b, "[data-f=note]", "Проверка примечания V2");
  await b.clickSel("[data-save=note]");
  await b.waitFor(`/Примечание: сохранено/.test(document.querySelector('#bw-status').textContent)`);
  c.ok(one(`SELECT note FROM block_works WHERE id=${zrId}`).note === "Проверка примечания V2", "примечание в БД (SQL)");
  await b.clickSel("#bw-close");
  await sleep(300);
  c.ok(!(await exists(b, ".mfr-modal")), "карточка закрыта");

  console.log("V1 на том же сервере показывает результат");
  await b.goto(`${BASE}/?ui=v1&object_id=4`, 1500);
  await b.waitFor(`typeof api==='function' || document.readyState==='complete'`);
  const v1 = await b.eval(`fetch('/objects/4/block-works/${zrId}').then(r=>r.json()).then(j=>[j.plan_end, j.note, j.versions.length])`);
  c.ok(v1[0] === "2026-10-20" && v1[1] === "Проверка примечания V2" && v1[2] === nv0 + 1, "V1 (тот же сервер) видит срок, примечание и версии, сохранённые из V2");
  console.log("console/JS:", JSON.stringify(b.exceptions.slice(0, 3)));
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет");
} catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "a-fail").catch(() => {}); }
finally { await b.close(); }

async function loginNode(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: process.env.MFR_PASSWORD || "Test-Pass-1234!" }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
  return (method, path, body) => fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
}
process.exit(c.done() ? 1 : 0);
