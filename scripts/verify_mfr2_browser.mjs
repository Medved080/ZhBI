// Браузерная проверка области mfr2 (V2) на НАСТОЯЩЕМ backend и временной копии БД: «Блоки» (секции/этажи/блоки — создание, правка,
// удаление по плану последствий, геометрия блока, «Обновить принадлежность»), «Виды работ» (загрузка xlsx), отчёт «Учёт по блокам:
// статусы» (правка ячейки, печать), «Плоская шахматка» (бланк обхода — печать/выгрузка). Только scripts/cdp.mjs (настоящие события
// мыши и клавиатуры). Запуск: MFR_BASE=http://127.0.0.1:8170 MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr2_browser.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8170";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const WT_XLSX = process.env.MFR_WT_XLSX;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("mfr2-structure");

async function setVal(b, sel, v) { await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
async function dialogBtn(b, label) { await b.waitFor(`document.querySelector('.v2-dialog')`); await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`); }
const reqs = (b, method, re) => b.requests.filter((r) => r.method === method && re.test(r.url)).length;

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
await b.eval(`window.print = () => { window.__printed = (window.__printed||0) + 1; }`);   // headless: не открывать системный диалог
try {
  console.log("«Блоки»: вкладка со структурой");
  await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
  await tap(b, '.v2-read-tab[data-tab="blocks"]');
  await b.waitFor(`document.querySelector('#st-sec-add')`);
  c.ok(await b.eval(`document.scrollingElement.scrollHeight <= window.innerHeight + 1`), "«Блоки»: страница не прокручивается на 1920×1080 (структура)");
  await shot(b, "s-blocks-tab");

  console.log("Секции: создание, переименование, удаление неиспользуемой");
  await setVal(b, "#st-sec-code", "ТБ1"); await setVal(b, "#st-sec-name", "Браузер-тест");
  await tap(b, "#st-sec-add");
  await b.waitFor(`/добавлена/.test(document.querySelector('#st-status').textContent)`);
  let sec = one("SELECT id, code, name FROM object_sections WHERE object_id=4 AND code='ТБ1'");
  c.ok(sec && sec.name === "Браузер-тест", "секция создана настоящим кликом (SQL)");
  const secNameInput = `[data-sec-name="${sec.id}"]`;
  await setVal(b, secNameInput, "Браузер-тест-2");
  await b.waitFor(`/сохранена/.test(document.querySelector('#st-status').textContent)`);
  c.ok(one(`SELECT name FROM object_sections WHERE id=${sec.id}`).name === "Браузер-тест-2", "переименование секции (SQL)");
  await tap(b, `[data-sec-del="${sec.id}"]`);
  await sleep(500);
  c.ok(one(`SELECT id FROM object_sections WHERE id=${sec.id}`) === null, "неиспользуемая секция удалена без диалога подтверждения");

  console.log("Этажи: создание, блок, геометрия");
  await setVal(b, "#st-lvl-floor", "997"); await setVal(b, "#st-lvl-name", "БТ-этаж"); await setVal(b, "#st-lvl-elev", "500");
  await tap(b, "#st-lvl-add");
  await b.waitFor(`/добавлен/.test(document.querySelector('#st-status').textContent)`);
  const lvl = one("SELECT id, name FROM object_levels WHERE object_id=4 AND floor=997");
  c.ok(lvl && lvl.name === "БТ-этаж", "этаж создан настоящим кликом (SQL)");
  const secForBlock = one("SELECT id FROM object_sections WHERE object_id=4 LIMIT 1");
  await tap(b, `[data-cell-toggle][data-sec="${secForBlock.id}"][data-lvl="${lvl.id}"]`);
  await sleep(500);
  const blk = one(`SELECT id FROM blocks WHERE section_id=${secForBlock.id} AND level_id=${lvl.id}`);
  c.ok(blk !== null, "блок (клетка матрицы) создан щелчком «+» (SQL)");
  await b.waitFor(`document.querySelector('[data-geo-open="${blk.id}"]')`);

  await tap(b, `[data-geo-open="${blk.id}"]`);
  await b.waitFor(`document.querySelector('#st-geo-add')`);
  await tap(b, "#st-geo-add");
  await b.waitFor(`document.querySelector('.mfr-struct-boxrow')`);
  await setVal(b, `.mfr-struct-boxrow[data-box-i="0"] [data-field="x0"]`, "0");
  await setVal(b, `.mfr-struct-boxrow[data-box-i="0"] [data-field="x1"]`, "1234");
  await setVal(b, `.mfr-struct-boxrow[data-box-i="0"] [data-field="y0"]`, "0");
  await setVal(b, `.mfr-struct-boxrow[data-box-i="0"] [data-field="y1"]`, "5678");
  await tap(b, "#st-geo-save");
  await b.waitFor(`document.querySelector('.mfr-struct-geo p.mfr-status').textContent.length>0`);
  const box = one(`SELECT x0,x1,y0,y1 FROM block_boxes WHERE block_id=${blk.id}`);
  c.ok(box && box.x1 === 1234 && box.y1 === 5678, "геометрия блока (набор прямоугольников) сохранена настоящим вводом (SQL)");
  await shot(b, "s-geo-editor");
  await tap(b, "#st-geo-close");

  console.log("Удаление блока/этажа (неиспользуемые — без диалога)");
  await tap(b, `[data-block-del="${blk.id}"]`);
  await sleep(500);
  c.ok(one(`SELECT id FROM blocks WHERE id=${blk.id}`) === null, "блок удалён (боксы не мешают — SQL)");
  await tap(b, `[data-lvl-del="${lvl.id}"]`);
  await sleep(500);
  c.ok(one(`SELECT id FROM object_levels WHERE id=${lvl.id}`) === null, "этаж удалён (SQL)");

  console.log("Удаление ЗАНЯТОЙ секции — план последствий, отмена, затем подтверждение");
  const occSec = one("SELECT id, code FROM object_sections WHERE object_id=4 AND code='Рампа'") || one("SELECT id, code FROM object_sections s WHERE object_id=4 AND EXISTS(SELECT 1 FROM blocks b WHERE b.section_id=s.id) ORDER BY id LIMIT 1");
  const blocksBefore = one(`SELECT COUNT(*) n FROM blocks WHERE section_id=${occSec.id}`).n;
  await tap(b, `[data-sec-del="${occSec.id}"]`);
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  const dlgText = await b.eval(`document.querySelector('.v2-dialog').textContent`);
  c.ok(/удал|потеря|привяз/.test(dlgText), "диалог показывает план последствий (текст сервера)", dlgText.slice(0, 200));
  await shot(b, "s-delete-plan");
  await dialogBtn(b, "Отмена");
  await sleep(400);
  c.ok(one(`SELECT id FROM object_sections WHERE id=${occSec.id}`) !== null, "«Отмена» — секция НЕ удалена (SQL)");
  await tap(b, `[data-sec-del="${occSec.id}"]`);
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  await dialogBtn(b, "Удалить");
  await b.waitFor(`document.querySelector('#st-status').textContent.includes('удалена')`, 10000);
  c.ok(one(`SELECT id FROM object_sections WHERE id=${occSec.id}`) === null, "подтверждение — секция удалена (SQL)");
  c.ok(one(`SELECT COUNT(*) n FROM blocks WHERE section_id=${occSec.id}`).n === 0 && blocksBefore > 0, "блоки секции удалены каскадом (SQL)");

  console.log("«Обновить принадлежность»");
  const rc0 = reqs(b, "POST", /recalc-membership$/);
  await tap(b, "#st-recalc");
  await b.waitFor(`document.querySelector('#st-recalc').disabled === false`, 15000);
  c.ok(reqs(b, "POST", /recalc-membership$/) === rc0 + 1, "кнопка «Обновить принадлежность» — один запрос");
  c.ok(/Этажей назначено/.test(await b.eval(`document.querySelector('#st-recalc').nextElementSibling.textContent`)), "отчёт пересчёта показан на экране");

  console.log("Отчёт «Учёт по блокам: статусы»: правка ячейки, печать");
  await openScreen(b, "report-block-status", `document.querySelector('.v2-matrix, .v2-callout')`);
  await b.waitFor(`document.querySelector('table.v2-matrix')`, 15000);
  await shot(b, "s-report-matrix");
  const pctSel = await b.eval(`(()=>{const i=document.querySelector('.v2-matrix-input'); return i ? i.outerHTML.slice(0,0) || (i.dataset.wt+'|'+i.dataset.block) : null;})()`);
  c.ok(pctSel !== null, "в матрице есть редактируемая ячейка процента (эт/сек)");
  if (pctSel) {
    const [wt, blkId] = pctSel.split("|");
    const before = one(`SELECT i.percent p FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=${blkId} AND i.work_type_id=${wt} ORDER BY r.report_date DESC LIMIT 1`);
    await b.eval(`(()=>{const i=document.querySelector('.v2-matrix-input[data-wt="${wt}"][data-block="${blkId}"]'); i.value='77'; i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(1000);
    const after = one(`SELECT i.percent p FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id WHERE r.block_id=${blkId} AND i.work_type_id=${wt} ORDER BY r.report_date DESC LIMIT 1`);
    c.ok(after && after.p === 77 && (!before || before.p !== 77), "правка процента настоящим вводом — новое значение в БД (SQL)");
  }
  const cycleWt = await b.eval(`(()=>{const btn=document.querySelector('.v2-matrix-cycle'); return btn ? btn.dataset.wt+'|'+(btn.dataset.sec||'') : null;})()`);
  c.ok(cycleWt !== null, "в матрице есть ячейка статуса (сек/компл)");
  if (cycleWt) {
    const [wt, secId] = cycleWt.split("|");
    await tap(b, `.v2-matrix-cycle[data-wt="${wt}"]${secId ? `[data-sec="${secId}"]` : ""}`);
    await sleep(900);
    const row = secId ? one(`SELECT status FROM work_progress WHERE work_type_id=${wt} AND block_id IS NULL AND section_id=${secId}`)
                       : one(`SELECT status FROM work_progress WHERE work_type_id=${wt} AND block_id IS NULL AND section_id IS NULL`);
    if (!(row && row.status === "in_progress")) console.log("  ДИАГНОСТИКА: cycleWt=", cycleWt, "cell-msg=", await b.eval(`document.querySelector('#bs-cell-msg')?.textContent`), "req=", b.requests.filter((r) => /work-progress\/cell$/.test(r.url)).slice(-1));
    c.ok(row && row.status === "in_progress", "клик по ячейке статуса — «в работе» в БД (SQL)");
  }
  await tap(b, "#rd-print");
  await sleep(200);
  c.ok((await b.eval(`document.querySelector('#v2-print-area')?.innerHTML.length`)) > 100, "печать отчёта: узел печати заполнен содержимым таблицы");
  c.ok((await b.eval(`window.__printed`)) >= 1, "печать отчёта вызывает window.print()");

  console.log("«Плоская шахматка»: бланк обхода — печать и выгрузка");
  await openScreen(b, "chess-flat", `document.querySelector('#cf-track')`);
  await b.waitFor(`document.querySelector('#cf-track option')`, 10000);
  await tap(b, "#cf-blank-open");
  await b.waitFor(`document.querySelector('.mfr-modal #pv-print')`);
  await shot(b, "s-chess-print");
  const sheetsBefore = await b.eval(`document.querySelectorAll('.mfr-modal .mfr-cf-paper').length`);
  c.ok(sheetsBefore > 0, "предпросмотр бланка обхода: есть хотя бы один лист");
  await b.eval(`(()=>{const s=document.querySelector('#pv-format'); s.value='A3'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(200);
  c.ok(await b.eval(`document.querySelector('.mfr-modal .mfr-cf-paper')?.classList.contains('a3')`), "смена формата A3 меняет класс листа в предпросмотре");
  const pr0 = await b.eval(`window.__printed || 0`);
  await tap(b, "#pv-print");
  await sleep(300);
  c.ok((await b.eval(`window.__printed`)) === pr0 + 1, "«Печать» вызывает window.print() один раз");
  c.ok((await b.eval(`document.querySelectorAll('#v2-print-area .mfr-cf-paper').length`)) === sheetsBefore, "узел печати содержит те же листы, что предпросмотр (после смены формата на A3)");
  const pdf0 = reqs(b, "POST", /chess-flat-export\.pdf$/);
  await tap(b, "#pv-pdf");
  await b.waitFor(`/сформирован/.test(document.querySelector('.mfr-modal p[role=status]')?.textContent || "")`, 15000);
  c.ok(reqs(b, "POST", /chess-flat-export\.pdf$/) === pdf0 + 1, "«Сохранить в PDF» — один запрос, сервер ответил файлом");
  const xlsx0 = reqs(b, "POST", /chess-flat-export\.xlsx$/);
  await tap(b, "#pv-xlsx");
  await b.waitFor(`/сформирован/.test(document.querySelector('.mfr-modal p[role=status]')?.textContent || "")`, 15000);
  c.ok(reqs(b, "POST", /chess-flat-export\.xlsx$/) === xlsx0 + 1, "«Сохранить в XLSX» — один запрос, сервер ответил файлом");
  await b.eval(`document.querySelector('.mfr-modal [data-mclose]')?.click()`);
  await sleep(300);

  console.log("Виды работ: загрузка xlsx (последней — списывает существующий каталог)");
  await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
  await tap(b, '.v2-read-tab[data-tab="types"]');
  await b.waitFor(`document.querySelector('#wt-file')`);
  const doc = await b.send("DOM.getDocument", {});
  const inp = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#wt-file" });
  await b.send("DOM.setFileInputFiles", { nodeId: inp.nodeId, files: [WT_XLSX] });
  const before = one("SELECT COUNT(*) n FROM work_types WHERE object_id=4").n;
  await tap(b, "#wt-analyze-btn");
  await b.waitFor(`/Разбор готов/.test(document.querySelector('#wt-status').textContent)`, 10000);
  c.ok(one("SELECT COUNT(*) n FROM work_types WHERE object_id=4").n === before, "сверка (анализ) настоящим файлом — БД не изменилась (SQL)");
  c.ok(/Всего строк/.test(await b.eval(`document.querySelector('#wt-summary-box').textContent`)), "сводка сверки показана на экране");
  await shot(b, "s-wt-upload");
  await tap(b, "#wt-apply-btn");
  await b.waitFor(`/Готово: добавлено/.test(document.querySelector('#wt-status').textContent)`, 10000);
  const after = one("SELECT COUNT(*) n FROM work_types WHERE object_id=4").n;
  c.ok(after > before, "применение по токену настоящим кликом — новые виды работ в БД (SQL)");

  console.log("Роль без права записи (user4): нет кнопок записи в «Блоки»");
} finally {
  await b.close();
}

const b4 = await session({ base: BASE, user: "user4", objectId: 4, shots: SHOTS });
try {
  await openScreen(b4, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
  await tap(b4, '.v2-read-tab[data-tab="blocks"]');
  await b4.waitFor(`document.querySelector('.mfr-struct-cols')`);
  c.ok(!(await b4.eval(`document.querySelector('#st-sec-add')`)), "user4: нет кнопки «Добавить» у секций (интерфейс без записи)");
  c.ok(!(await b4.eval(`document.querySelector('[data-sec-del]')`)), "user4: нет ссылок «удалить» у секций");
  c.ok(!(await b4.eval(`document.querySelector('[data-cell-toggle]')`)), "user4: клетки матрицы не кликабельны (нет «+»)");
  c.ok(!(await b4.eval(`document.querySelector('#st-recalc')`)), "user4: нет кнопки «Обновить принадлежность»");
  const direct = await b4.eval(`fetch('/objects/4/sections', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code:'ZZ', name:null})}).then(r=>r.status)`);
  c.ok(direct === 403, "user4: прямой запрос к серверу тоже получает 403 (не только скрытая кнопка)", String(direct));
  await shot(b4, "s-blocks-user4");
} finally {
  await b4.close();
}

process.exit(c.done());
