import { clk, open, screen, text, reload, chk, summary, posts, sql, SP } from "./hx.mjs";
const b = await open("admin");
// объект 2 (есть контракты и даты)
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1200);
await screen(b, "report-delivery");
await b.waitFor(`document.querySelector('#rd-report table')`, 30000);
chk((await text(b, "#rd-report")).includes("Отчёт в разработке"), "график поставки: пометка «в разработке» показана");
chk((await text(b, "#rd-report")).includes("потребность / план / факт"), "легенда ячейки показана");
chk(await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`) >= 2, "таблица построена: " + await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`) + " строк");
chk(posts(b, "/reports/delivery-schedule").length === 1 && posts(b, "/reports/delivery-schedule")[0].status === 200, "запрос отчёта один, 200");
await b.shot("${SP}/exchange_work/s_delivery.png");
// сворачивание/разворачивание
const nRows = await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`);
await b.eval(`document.querySelector('#rd-report .v2-tree-toggle[aria-expanded="false"]')?.click()`); await b.sleep(200);
chk(await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`) > nRows, "разворачивание строки добавляет строки");
// шаг
await b.eval(`(()=>{const s=document.querySelector('[data-param="step"]');s.value='week';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await b.waitFor(`document.querySelectorAll('.v2-read-table th').length>0 && ${JSON.stringify(1)}`, 5000); await b.sleep(1500);
const last = posts(b, "/reports/delivery-schedule").at(-1);
chk(JSON.parse(last.body).step === "week", "смена шага: в теле запроса step=week");
chk((await text(b, "#rd-report")).includes("Неделя"), "подпись отчёта: шаг «Неделя»");
// период
await b.eval(`(()=>{const s=document.querySelector('[data-param="date_from"]');s.value='2026-09-20';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1500);
chk(JSON.parse(posts(b, "/reports/delivery-schedule").at(-1).body).date_from === "2026-09-20", "смена периода: date_from в теле запроса");
// выгрузки
for (const ext of ["xlsx", "pdf"]) {
  const n0 = b.requests.filter((r) => r.url.includes("/reports/delivery-schedule." + ext)).length;
  await b.eval(`document.querySelector('[data-export="${ext}"]').click()`);
  await b.waitFor(`document.querySelector('#rd-export-status').innerText.includes('сформирован') || document.querySelector('#rd-export-status').innerText.includes('Не удалось')`, 30000);
  const t = await text(b, "#rd-export-status");
  const reqs = b.requests.filter((r) => r.url.includes("/reports/delivery-schedule." + ext));
  chk(reqs.length === n0 + 1 && reqs.at(-1).status === 200 && t.includes("сформирован"), `выгрузка ${ext.toUpperCase()}: один запрос, 200 — ${t}`);
}
// контрактация
await screen(b, "report-contracting");
await b.waitFor(`document.querySelector('#rd-report table')`, 30000);
chk((await text(b, "#rd-report")).includes("Отчёт в разработке") && (await text(b, "#rd-report")).includes("Итого по объекту"), "контрактация: таблица и пометка");
chk(!(await b.eval(`!!document.querySelector('[data-export]')`)), "контрактация: кнопок выгрузки нет (у отчёта нет файловой выгрузки, как и в V1)");
const nr = await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`);
await b.eval(`document.querySelector('#cs-deficit').click()`); await b.sleep(300);
chk(await b.eval(`document.querySelectorAll('#rd-report tbody tr').length`) <= nr, "«Только марки с дефицитом» сужает список");
await b.eval(`(()=>{const s=document.querySelector('[data-param="scale"]');s.value='week';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1500);
chk(JSON.parse(posts(b, "/reports/contracting-schedule").at(-1).body).scale === "week", "смена масштаба: scale=week в теле запроса");
await b.eval(`document.querySelector('#rd-report [data-cs]')?.click()`); await b.sleep(200);
chk(await b.eval(`!!document.querySelector('#rd-report .v2-cs-child')`), "разворот марки показывает контракты");
await b.shot("${SP}/exchange_work/s_contracting_report.png");
// объект без чертежа/данных
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value='12';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(2500);
chk(!(await text(b, "#v2-content")).includes("undefined") && !(await text(b, "#v2-content")).includes("[object"), "объект без данных: без «undefined»: " + (await text(b, "#rd-body")).slice(0, 120).replace(/\n/g, " "));
chk(!b.exceptions.length, "исключений нет: " + JSON.stringify(b.exceptions.slice(0, 2)));
summary();
await b.close();
