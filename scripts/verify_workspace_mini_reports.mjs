// Мини-отчёты «Статус» V2 на настоящем backend и обезличенной копии.
// Запуск: MINI_BASE=http://127.0.0.1:8371 node scripts/verify_workspace_mini_reports.mjs
// Сервер запускается отдельно через scripts/real_auth_server.py на копии БД.
import { session, openScreen, tap, sleep } from "./audit_work/lib.mjs";

const BASE = process.env.MINI_BASE;
if (!BASE || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error("Укажите MINI_BASE на локальный обезличенный стенд");
const results = [];
const check = (title, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${title}${detail ? " — " + detail : ""}`);
};
let b;
try {
  b = await session(BASE, "admin", { objectId: 1, width: 1366, height: 768 });
  await b.eval(`window.__miniIds=[]; window.addEventListener('message', e => {
    if (e.origin === location.origin && e.data?.proto === 'zhbi-scene/1' && e.data.evt === 'report-ids') window.__miniIds.push(e.data);
  });`);
  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs')`);
  await b.waitFor(`!!document.querySelector('input[data-pk="elementType"]')`, 120000);
  await tap(b, '.ws-tabs button[data-tab="status"]');
  await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .v2-read-tbl') && window.__miniIds.length>0`, 60000);
  if (process.env.MINI_SHOT) await b.shot(process.env.MINI_SHOT);
  const initial = await b.eval(`(()=>{const m=window.__miniIds.at(-1), t=document.querySelector('#ws-panel-body').innerText;
    return {ids:m.ids, objectId:m.objectId, text:t, sections:[...document.querySelectorAll('.ws-mini-section')].length,
      chart:!!document.querySelector('.ws-mini-chart svg'), scroll:document.documentElement.scrollHeight>innerHeight};})()`);
  check("комплектовщик: три мини-отчёта и график Динамики без прокрутки страницы",
    initial.sections === 3 && initial.chart && !initial.scroll, `${initial.sections} раздела, ${initial.ids.length} id`);
  const direct = await b.eval(`fetch('/reports/status',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:1,element_ids:${JSON.stringify(initial.ids)}})}).then(r=>r.json()).then(d=>d.total.values.total)`);
  // Серверный отчёт дополнительно ограничен актуальным source_file объекта:
  // на копии у объекта 1 показано 9580 изделий двух файлов, в отчёте 9422.
  // Проверяем точное равенство двух ответов отчёта и явное пояснение разницы.
  const rendered = Number((initial.text.match(/Всего изделий:\s*([\d\s]+)/) || [])[1]?.replace(/\D/g, ""));
  const scopeExplained = direct === initial.ids.length || initial.text.includes(
    `Отчёты учитывают ${direct.toLocaleString("ru-RU")} изделий актуального чертежа из ${initial.ids.length.toLocaleString("ru-RU")} показанных`);
  check("комплектовщик: итог мини-отчёта = серверному отчёту по показанным id",
    initial.objectId === 1 && rendered === direct && scopeExplained,
    `на схеме ${initial.ids.length}, сервер и мини-отчёт ${direct}, пояснение ${scopeExplained}`);

  await tap(b, '.ws-tabs button[data-tab="pick"]');
  await tap(b, 'input[data-pk="elementType"]');
  await b.waitFor(`!!document.querySelector('[data-pk-clear="elementType"]')`, 20000);
  await tap(b, '.ws-tabs button[data-tab="status"]');
  await b.waitFor(`window.__miniIds.at(-1).ids.length < ${initial.ids.length} && !!document.querySelector('#ws-panel-body .ws-mini-table .v2-read-tbl')`, 60000);
  const filtered = await b.eval(`(()=>{const m=window.__miniIds.at(-1);return{ids:m.ids,text:document.querySelector('#ws-panel-body').innerText}})()`);
  check("смена среза комплектовщика пересчитала мини-отчёты",
    filtered.ids.length > 0 && filtered.ids.length < initial.ids.length && filtered.text.includes(`Всего изделий: ${filtered.ids.length.toLocaleString("ru-RU")}`),
    `${initial.ids.length} → ${filtered.ids.length}`);
  await tap(b, '[data-mini-full="status"]');
  await b.waitFor(`location.hash==='#/report-status' && !!document.querySelector('#rd-use-filter')`, 30000);
  const full = await b.eval(`({checked:document.querySelector('#rd-use-filter').checked,note:document.querySelector('#rd-filter-note').textContent})`);
  check("⤢ открыл полный отчёт с тем же срезом комплектовщика", full.checked && full.note.includes("АРМ комплектовщика"), full.note.slice(0, 100));

  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs button[data-tab="status"]')`);
  await tap(b, '.ws-tabs button[data-tab="status"]');
  await b.waitFor(`!!document.querySelector('[data-mini-full="dynamics"]')`, 60000);
  await tap(b, '[data-mini-full="dynamics"]');
  await b.waitFor(`location.hash==='#/report-dynamics' && !!document.querySelector('#rd-use-filter')`, 30000);
  const dynamicsFull = await b.eval(`({checked:document.querySelector('#rd-use-filter').checked,note:document.querySelector('#rd-filter-note').textContent})`);
  check("⤢ Динамики открыл полный отчёт с отбором", dynamicsFull.checked && dynamicsFull.note.includes("АРМ комплектовщика"));

  for (const ws of ["ws-model", "ws-foreman"]) {
    await openScreen(b, ws, `document.querySelector('.ws-tabs button[data-tab="status"]')`);
    await tap(b, '.ws-tabs button[data-tab="status"]');
    await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .v2-read-tbl')`, 60000);
    check(`${ws}: мини-отчёты построены`, await b.eval(`document.querySelectorAll('.ws-mini-section').length===3`));
  }
  check("необработанных ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
} finally { await b?.close(); }
const fails = results.filter((x) => !x).length;
console.log(`Итого: ${results.length - fails} PASS / ${fails} FAIL из ${results.length}`);
process.exitCode = fails ? 1 : 0;
