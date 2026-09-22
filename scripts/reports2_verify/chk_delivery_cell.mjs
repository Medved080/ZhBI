// Регрессия общего механизма read-screen.js (найдено в reports2): у «Графика поставки» каждый показ отчёта добавлял на
// постоянный #rd-body ещё один обработчик разбора ячейки — после смены шага ОДИН щелчок по ячейке слал ДВА запроса
// POST /reports/delivery-schedule/cell. Проверка: несколько перезапросов отчёта, затем один НАСТОЯЩИЙ щелчок по листовой
// ячейке — ровно один запрос разбора и одно окно. Настоящий backend (копия обезличенной БД), настоящий вход формой V2.
// Запуск: node scripts/reports2_verify/chk_delivery_cell.mjs
import { startServer, stopServer, check, summary, sleep, SP, chooseValue, clickEl } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8346;
const S = await startServer(PORT, `${SP}/r2_delivery`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/r2_delivery_shots` });
  await openScreen(b, "report-delivery", `!!document.querySelector('#rd-report table')`);
  const ready = `!!document.querySelector('#rd-report table') && !/Загрузка/.test(document.querySelector('#rd-body')?.textContent||'')`;
  const cur = await b.eval(`document.querySelector('select[data-param="step"]').value`);
  // два перезапроса отчёта сменой шага (настоящий щелчок по подписи + буква)
  await chooseValue(b, "Шаг", cur === "month" ? "Н" : "М", cur === "month" ? "week" : "month", ready);
  await chooseValue(b, "Шаг", "Д", "day", ready);
  const loads = b.requests.filter((r) => /\/reports\/delivery-schedule$/.test(r.url)).length;
  check("отчёт перезапрошен после смены шага (показов отчёта ≥ 3)", loads >= 3, `запросов отчёта: ${loads}`);
  for (let i = 0; i < 8 && !(await b.eval(`!!document.querySelector('#rd-report td[data-gkeys]')`)); i++) {
    await clickEl(b, `document.querySelector('#rd-report .v2-tree-toggle[aria-expanded="false"]')`); await sleep(300);
  }
  const from = b.requests.length;
  await clickEl(b, `document.querySelector('#rd-report td[data-gkeys]')`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 20000);
  await sleep(1500);
  const cells = b.requests.slice(from).filter((r) => /delivery-schedule\/cell$/.test(r.url));
  check("один щелчок по ячейке — ровно ОДИН запрос разбора (200) и одно окно", cells.length === 1 && cells[0].status === 200 && (await b.eval(`document.querySelectorAll('.v2-dialog').length`)) === 1, `запросов /cell: ${cells.length}`);
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
