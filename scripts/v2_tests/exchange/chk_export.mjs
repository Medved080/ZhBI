import { clk, open, screen, text, chk, summary, posts } from "./hx.mjs";
const b = await open("admin");
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1200);
const st = () => text(b, "#ex-status");
console.log("== XLSX");
await screen(b, "export-xls");
chk((await text(b, "#ex-source")).includes("Чертёж-4.dxf"), "чертёж объекта показан: " + (await text(b, "#ex-source")));
// неверный период
await b.eval(`(()=>{const f=document.querySelector('#ex-from'),t=document.querySelector('#ex-to');f.value='2026-10-10';f.dispatchEvent(new Event('input',{bubbles:true}));t.value='2026-10-01';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await b.clickSel("#ex-go"); await b.sleep(300);
chk((await st()).includes("позже конца") && b.requests.filter((r) => r.url.includes("/export.xlsx")).length === 0, "период с > по: отказ на клиенте, запроса нет: " + (await st()));
await b.eval(`(()=>{const f=document.querySelector('#ex-from'),t=document.querySelector('#ex-to');f.value='2026-09-01';f.dispatchEvent(new Event('input',{bubbles:true}));t.value='2026-10-31';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const r = await b.rect("#ex-go");
await b.click(r.cx, r.cy, { count: 2 });
await b.waitFor(`document.querySelector('#ex-status').innerText.includes('сформирован') || document.querySelector('#ex-status').innerText.includes('Не удалось')`, 60000);
const x = b.requests.filter((q) => q.url.includes("/export.xlsx"));
chk(x.length === 1 && x[0].status === 200 && (await st()).includes("сформирован"), `двойной щелчок: один запрос export.xlsx, 200 — ${await st()}`);
chk(JSON.parse(x[0].body).source_file === "Чертёж-4.dxf" && JSON.parse(x[0].body).mode === "history", "тело запроса по чертежу объекта, режим history");
// режим snapshot
await b.eval(`document.querySelector('input[name="ex-mode"][value="snapshot"]').click()`);
await b.eval(`(()=>{const d=document.querySelector('#ex-date');d.value='2026-09-15';d.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await b.clickSel("#ex-go"); await b.waitFor(`document.querySelector('#ex-status').innerText.includes('elements_snapshot_2026-09-15')`, 60000);
chk(JSON.parse(b.requests.filter((q) => q.url.includes("/export.xlsx")).at(-1).body).date === "2026-09-15", "snapshot: дата в теле запроса; " + (await st()));
// сетевой сбой
await b.offline(true);
await b.clickSel("#ex-go"); await b.waitFor(`document.querySelector('#ex-status').innerText.includes('Не удалось')`, 10000);
chk((await st()).includes("Нет связи"), "сетевой сбой: понятный текст без автоповтора: " + (await st()));
const nOff = b.requests.filter((q) => q.url.includes("/export.xlsx")).length;
await b.offline(false); await b.sleep(800);
chk(b.requests.filter((q) => q.url.includes("/export.xlsx")).length === nOff, "автоповтора после восстановления связи нет");
console.log("== PDF");
await screen(b, "export-pdf");
await b.eval(`(()=>{const d=document.querySelector('#ex-date');d.value='2026-09-15';d.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await b.clickSel("#ex-go"); await b.waitFor(`document.querySelector('#ex-status').innerText.includes('сформирован') || document.querySelector('#ex-status').innerText.includes('Не удалось')`, 90000);
const p = b.requests.filter((q) => q.url.includes("/export.pdf"));
chk(p.length === 1 && p[0].status === 200 && (await st()).includes("сформирован"), "PDF: один запрос GET, 200 — " + (await st()));
chk(p[0].url.includes("source_file=") && p[0].url.includes("date=2026-09-15"), "адрес: чертёж объекта и дата");
// объект без чертежа
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value='12';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1500);
chk((await text(b, "#v2-content")).includes("нет загруженного чертежа") && !(await b.eval(`!!document.querySelector('#ex-go')`)), "объект без чертежа: кнопки выгрузки нет");
chk(!b.exceptions.length, "исключений нет");
summary();
await b.close();
