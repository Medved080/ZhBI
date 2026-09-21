// Браузерная проверка ОГРАНИЧЕННЫХ ролей (user2 — роль «user», user4 — роль «view», обе с доступом к объекту 4) на НАСТОЯЩЕМ backend: интерфейс не показывает
// изменяющих кнопок, поля карточек заблокированы, а прямая отправка изменяющих запросов через шлюз V2 получает ОТВЕТ СЕРВЕРА 403 (не отказ шлюза) и БД не меняется.
// Запуск: MFR_BASE=... MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr_browser_e.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, txt, exists, tap, closeModal } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("roles");
const snapshot = () => JSON.stringify(["block_works", "block_work_forecasts", "work_fact_reports", "work_fact_items", "chess_flat_batches"].map((t) => one(`SELECT COUNT(*) n, COALESCE(SUM(rowid),0) s FROM ${t}`))) + JSON.stringify(sql("SELECT id, plan_start, plan_end, note, retired_at, updated_at FROM block_works ORDER BY id"));

for (const user of ["user2", "user4"]) {
  console.log(`\n== ${user} ==`);
  const b = await session({ base: BASE, user, objectId: 4, shots: SHOTS });
  try {
    const nav = await b.eval(`[...document.querySelectorAll('.v2-nav [data-section]')].map(x=>x.dataset.section)`);
    c.ok(nav.includes("blocks") && nav.includes("fact-journal") && nav.includes("ws-mfr"), `${user}: учёт по блокам, журнал факта и рабочее место МФР доступны для просмотра`);
    c.ok(!nav.includes("chess-flat"), `${user}: «Плоская шахматка» (ввод факта) в навигации скрыта — как в V1 (нужно право на изменение)`);
    await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
    c.ok((await txt(b, "#bs-cap")).includes("только просмотр"), `${user}: подпись «только просмотр»`);
    const blk = one("SELECT b.id FROM blocks b WHERE b.object_id=4 AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=1 ORDER BY b.id LIMIT 1");
    await tap(b, `.mfr-blk[data-b="${blk.id}"]`);
    await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);
    c.ok(!(await exists(b, "#bs-fact")) && !(await exists(b, "#bs-settings")) && !(await exists(b, "#bs-bulk")), `${user}: кнопок «Факт», «Состав работ», «Сроки: групповая правка» нет`);
    await tap(b, `tr[data-bw]`);
    await b.waitFor(`document.querySelector('[data-f=plan_start]') && !document.querySelector('.mfr-modal').textContent.includes('Загрузка работы')`);
    c.ok(await b.eval(`[...document.querySelectorAll('.mfr-modal [data-f]')].every(x=>x.disabled) && !document.querySelector('.mfr-modal [data-save]')`), `${user}: поля карточки ЗР заблокированы, кнопок сохранения нет`);
    await shot(b, `e-${user}-zr`);
    await closeModal(b);
    await openScreen(b, "fact-journal", `document.querySelectorAll('#fj-tbl tr[data-rep]').length>0`);
    c.ok(!(await exists(b, "#fj-new")) && !(await exists(b, "[data-del]")), `${user}: журнал — нет «Новый отчёт» и «Удалить»`);
    await tap(b, `#fj-tbl tr[data-rep]`);
    await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length>0`);
    c.ok(await b.eval(`[...document.querySelectorAll('.mfr-fact-row input')].every(x=>x.disabled) && !document.querySelector('#ff-save') && !document.querySelector('#ff-del')`), `${user}: документ факта открыт только для чтения (поля заблокированы, нет «Сохранить»/«Удалить»)`);
    await closeModal(b);
    await openScreen(b, "ws-mfr", `document.querySelector('iframe.ws-frame')`);
    await b.waitFor(`document.querySelector('#ws-panel-body .mfr-blk') || document.querySelector('#ws-panel-body .mfr-wp')`, 90000);
    await sleep(800);
    c.ok(/только просмотр/.test(await txt(b, ".ws-status")), `${user}: рабочее место МФР — «только просмотр»`);
    await shot(b, `e-${user}-ws`);

    // прямой изменяющий запрос через шлюз V2: разрешён шлюзом, но сервер отвечает 403; БД не меняется
    const before = snapshot();
    const ids = { blk: blk.id, zr: one(`SELECT id FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL ORDER BY id LIMIT 1`).id, wt: one(`SELECT work_type_id w FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL LIMIT 1`).w };
    const res = await b.eval(`(async()=>{ const {api}=await import('/static/v2/api.js'); const out={}; const run=async(k,f)=>{ try{ await f(); out[k]='ok'; }catch(e){ out[k]=[e.status, !!e.blockedByPolicy]; } };
      const zr=await api.get('/objects/4/block-works/${ids.zr}');
      await run('patch', ()=>api.patch('/objects/4/block-works/${ids.zr}', {plan_start:'2026-12-01', plan_end:null, expected_rev: zr.rev}));
      await run('note', ()=>api.patch('/objects/4/block-works/${ids.zr}', {note:'x', expected_rev: zr.rev}));
      await run('fact', ()=>api.post('/objects/4/blocks/${ids.blk}/fact-reports', {report_date:'2026-09-15', items:{'${ids.wt}':10}}));
      await run('bulk', ()=>api.put('/objects/4/block-works/bulk', {block_work_ids:[${ids.zr}], op:'shift', field:'plan', days:1, expected:{'${ids.zr}': zr.rev}}));
      await run('settings', ()=>api.put('/objects/4/blocks/${ids.blk}/work-types-settings', {work_type_ids:[${ids.wt}], expected:'abcdef012345'}));
      await run('group', ()=>api.put('/objects/4/blocks/work-types-settings', {block_ids:[${ids.blk}], work_type_ids:[${ids.wt}], expected:{'${ids.blk}':'abcdef012345'}}));
      await run('chess', ()=>api.post('/objects/4/blocks/chess-flat-batch', {report_date:'2026-09-15', track_code:'3', idempotency_key:'k'+Date.now()+'-xxxxxxxx', items:[{block_id:${ids.blk}, work_type_id:${ids.wt}, percent:10, expected_percent:0}]}));
      await run('apply', ()=>api.post('/objects/4/block-works/bulk-edit/apply-strict', {changes:[{bw_id:${ids.zr}, field:'plan_end', was:null, now:'2026-12-01'}]}));
      await run('preview', ()=>api.readPost('/objects/4/block-works/bulk-preview', {block_work_ids:[${ids.zr}], op:'shift', field:'plan', days:1}));
      return out; })()`);
    for (const k of ["patch", "note", "fact", "bulk", "settings", "group", "chess", "apply", "preview"]) c.ok(Array.isArray(res[k]) && res[k][0] === 403 && res[k][1] === false, `${user}: ${k} — ответ СЕРВЕРА 403 (шлюз пропустил, права проверил backend)`, JSON.stringify(res[k]));
    c.ok(snapshot() === before, `${user}: БД не изменилась после всех отказов (SQL до/после)`);
    c.ok(b.exceptions.length === 0, `${user}: исключений JavaScript нет`, JSON.stringify(b.exceptions.slice(0, 2)));
  } catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, `${user}: сценарий завершён`, e.message); await shot(b, `e-${user}-fail`).catch(() => {}); }
  finally { await b.close(); }
}
process.exit(c.done() ? 1 : 0);
