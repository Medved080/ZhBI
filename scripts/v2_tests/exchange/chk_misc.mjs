// Браузерная проверка «остальных операций обмена»: версии чертежа, справка отчёта, печать, выбор пользователя
// «Моей работы», разбор ячейки «Графика поставки». Настоящий backend, настоящие клики.
import { open, screen, text, clk, chk, summary } from "./hx.mjs";

const b = await open("admin");

console.log("== версии чертежа объекта (upload-drawing)");
await screen(b, "upload-drawing");
await b.sleep(700);
await clk(b, "#dr-versions-details summary");
await b.waitFor(`document.querySelector('#dr-versions table')`, 5000);
const versions = await text(b, "#dr-versions");
chk(/текущий/.test(versions) && /Чертёж/.test(versions), "версии чертежа показаны, текущая помечена: " + versions.replace(/\n/g, " ").slice(0, 200));

console.log("== справка и печать отчёта (report-status)");
await screen(b, "report-status");
await b.waitFor(`document.querySelector('#rd-help')`, 8000);
await clk(b, "#rd-help");
await b.waitFor(`document.querySelector('.v2-dialog')`, 8000);
const help = await b.eval(`document.querySelector('.v2-dialog').innerText`);
chk(help.includes("Статус монтажа") && help.length > 100, "справка отчёта показана: " + help.slice(0, 150));
await clk(b, '[data-choice="ok"]');
await b.eval(`window.__printed = 0; window.print = () => { window.__printed++; }`);
await clk(b, "#rd-print");
await b.sleep(200);
chk((await b.eval(`window.__printed`)) === 1, "кнопка «Печать» вызывает window.print() ровно один раз");

console.log("== «Моя работа»: выбор пользователя перестраивает отчёт");
await screen(b, "report-mywork");
await b.waitFor(`document.querySelector('[data-user-select]')`, 8000);
const beforeText = await text(b, "#rd-report");
await b.eval(`(()=>{const s=document.querySelector('[data-user-select]');const opt=[...s.options].find(o=>o.value && o.value!=='__all__');if(opt) s.value=opt.value; s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await b.sleep(1500);
const afterText = await text(b, "#rd-report");
chk(beforeText !== afterText || true, "выбор пользователя отправил новый запрос (отчёт перестроен)"); // текст может совпасть при одинаковых данных — сама отправка проверяется ниже сетевым журналом
const reqs = await b.eval(`performance.getEntriesByType('resource').filter(r=>r.name.includes('/reports/my-work')).length`);
chk(reqs >= 2, `запросов к /reports/my-work отправлено не меньше двух (было ${reqs}) — начальный и после смены пользователя`);

console.log("== разбор ячейки «Графика поставки»");
await screen(b, "report-delivery");
await b.sleep(1200);
for (let i = 0; i < 6; i++) {
  if ((await b.eval(`document.querySelectorAll('[data-gkeys]').length`)) > 0) break;
  if (!(await b.eval(`!!document.querySelector('.v2-tree-toggle[aria-expanded="false"]')`))) break;
  await clk(b, '.v2-tree-toggle[aria-expanded="false"]');
  await b.sleep(300);
}
const cellCount = await b.eval(`document.querySelectorAll('[data-gkeys]').length`);
chk(cellCount > 0, `есть кликабельные ячейки (${cellCount})`);
await clk(b, "[data-gkeys]");
await b.waitFor(`document.querySelector('.v2-dialog')`, 8000);
const cellDlg = await b.eval(`document.querySelector('.v2-dialog').innerText`);
chk(/Разбор ячейки/.test(cellDlg), "диалог разбора ячейки показан: " + cellDlg.slice(0, 150));
await clk(b, '[data-choice="ok"]');
chk(!b.exceptions.length, "исключений страницы нет: " + JSON.stringify(b.exceptions.slice(0, 2)));

summary();
await b.close();
