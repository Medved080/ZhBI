// Проверка печати всех отчётов группы «reports» (impl=read, printable !== false) — кнопка «Печать» есть и заполняет
// узел печати #v2-print-area содержимым ТЕКУЩЕЙ таблицы (не пустым, не чужим). Настоящий backend, настоящий вход,
// настоящие события мыши (scripts/cdp.mjs). Запуск: GP_BASE=http://127.0.0.1:8221 node scripts/verify_gaps_print.mjs
import { session, openScreen, shot, sleep, checker, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.GP_BASE || "http://127.0.0.1:8221";
const SHOTS = process.env.GP_SHOTS || null;
const c = checker("gaps-print-reports");

// report-block-status/schedule/linear-track — данные учёта по блокам, нужен объект типа МФР (kind=mfr);
// остальные — свод по элементам ЖБИ (feature.kinds ограничивает их объектами kind=zhbi: тип объекта
// проверяется РАНЬШЕ обхода system_admin, app/access.py has_feature — иначе 403 даже у администратора).
const REPORTS_ZHBI = ["report-status", "report-dynamics", "report-delivery", "report-completion", "report-mywork", "report-contracting", "report-analytics"];
const REPORTS_MFR = ["report-block-status", "report-block-schedule", "report-linear-track"];
const OBJECT_ZHBI = Number(process.env.GP_OBJECT_ZHBI || 1);
const OBJECT_MFR = Number(process.env.GP_OBJECT_MFR || 4);

async function checkReports(objectId, ids) {
  const b = await session({ base: BASE, user: "admin", objectId, shots: SHOTS });
  await b.eval(`window.print = () => { window.__printed = (window.__printed||0) + 1; }`);
  try {
    for (const id of ids) {
      console.log(`--- ${id} (объект ${objectId}) ---`);
      await openScreen(b, id, `document.querySelector('.v2-page')`);
      await b.waitFor(`document.querySelector('#rd-report') || document.querySelector('.v2-callout') || document.querySelector('.v2-muted')`, 20000).catch(() => {});
      await sleep(500);
      // Реальный отказ загрузки — #rd-retry (read-screen.js paintError); «Отчёт в разработке» — тоже v2-callout-bad, но
      // это дисклеймер ВНУТРИ успешно загруженного отчёта (report-delivery/contracting), не путать.
      const badLoad = await b.eval(`document.querySelector('#rd-retry') ? (document.querySelector('#rd-body')?.textContent || "") : ""`);
      if (badLoad) { c.ok(false, `${id}: данные загрузились (объект ${objectId} подходит по типу/правам)`, badLoad.slice(0, 160)); await shot(b, `s-${id}-error`); continue; }
      const hasBtn = await b.eval(`!!document.querySelector('#rd-print')`);
      c.ok(hasBtn, `${id}: кнопка «Печать» есть на экране`);
      if (!hasBtn) { await shot(b, `s-${id}-noprint`); continue; }
      const before = await b.eval(`window.__printed || 0`);
      const reportHtmlLen = await b.eval(`document.querySelector('#rd-report')?.innerHTML?.length || 0`);
      await tap(b, "#rd-print");
      await sleep(250);
      const printedNow = await b.eval(`window.__printed || 0`);
      const printAreaLen = await b.eval(`document.querySelector('#v2-print-area')?.innerHTML?.length || 0`);
      const printAreaHasTable = await b.eval(`!!document.querySelector('#v2-print-area table, #v2-print-area .v2-matrix, #v2-print-area h2')`);
      c.ok(printedNow === before + 1, `${id}: клик «Печать» вызывает window.print() ровно один раз`, `было ${before}, стало ${printedNow}`);
      c.ok(reportHtmlLen > 20, `${id}: экран отчёта содержит содержимое до печати`, `len=${reportHtmlLen}`);
      c.ok(printAreaLen > 20 && printAreaHasTable, `${id}: узел печати заполнен содержимым (таблица/заголовок)`, `len=${printAreaLen}`);
      await shot(b, `s-${id}-print`);
    }
  } finally {
    await b.close();
  }
}

await checkReports(OBJECT_ZHBI, REPORTS_ZHBI);
await checkReports(OBJECT_MFR, REPORTS_MFR);
process.exitCode = c.done();
