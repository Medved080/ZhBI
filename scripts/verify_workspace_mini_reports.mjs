// Мини-отчёты «Статус» V2 на настоящем backend и обезличенной копии.
// Запуск: MINI_BASE=http://127.0.0.1:8371 node scripts/verify_workspace_mini_reports.mjs
// Сервер запускается отдельно через scripts/real_auth_server.py на копии БД.
import { session, openScreen, openV1, tap, sleep } from "./audit_work/lib.mjs";

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
  await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .side-table.side-tree') && window.__miniIds.length>0`, 60000);
  if (process.env.MINI_SHOT) await b.shot(process.env.MINI_SHOT);
  const initial = await b.eval(`(()=>{const m=window.__miniIds.at(-1), t=document.querySelector('#ws-panel-body').innerText;
    return {ids:m.ids, objectId:m.objectId, text:t, sections:[...document.querySelectorAll('.ws-mini-section')].length,
      chart:!!document.querySelector('.side-chart svg'), scroll:document.documentElement.scrollHeight>innerHeight};})()`);
  check("комплектовщик: три мини-отчёта и график Динамики без прокрутки страницы",
    initial.sections === 3 && initial.chart && !initial.scroll, `${initial.sections} раздела, ${initial.ids.length} id`);
  const panel = await b.eval(`(()=>{const root=document.querySelector('#ws-panel-body');
    return {heads:[...root.querySelectorAll('.side-section-head h3')].map(x=>x.textContent),
      controls:!!root.querySelector('[data-mini-mode]')&&!!root.querySelector('[data-mini-date]')&&!!root.querySelector('[data-mini-from]')&&!!root.querySelector('[data-mini-to]'),
      chart:root.querySelector('.side-chart svg')?.getAttribute('viewBox'),legend:root.querySelectorAll('.side-chart-legend span').length,
      tables:root.querySelectorAll('.side-dyn-block .side-table.side-dyn').length,
      dayRows:[...root.querySelectorAll('.side-dyn-block .side-table.side-dyn')].every(t=>t.rows.length===3),
      notes:[...root.querySelectorAll('.side-dyn-notes summary')].map(x=>x.textContent),
      statusTree:!!root.querySelector('.side-table.side-tree'),deviation:!!root.querySelector('.side-table.side-dyn')};})()`);
  check("правая панель: состав и компактная форма трёх отчётов как в V1",
    panel.heads.join("|") === "Статус монтажа|Отклонение от базового графика|Отчёт о динамике поставки и монтажа" &&
    panel.controls && panel.chart === "0 0 280 150" && panel.legend > 0 && panel.tables === 2 && panel.dayRows &&
    panel.notes.length === 3 && panel.statusTree && panel.deviation, JSON.stringify(panel));
  const v2Values = await b.eval(`(()=>({status:[...document.querySelectorAll('.ws-mini .side-tree tr.total td')].map(x=>x.textContent.trim()),
    deviation:(()=>{const r=document.querySelectorAll('.ws-mini-section')[1]?.querySelector('.ws-mini-content');return{head:r?.querySelector('.hint-text')?.textContent.replace(/\\s+/g,' ').trim(),cells:[...r.querySelectorAll('th,td')].map(x=>x.textContent.trim())}})(),
    dynamics:[...document.querySelectorAll('.ws-mini .side-dyn-block')].map(b=>[...b.querySelectorAll('th,td')].map(x=>x.textContent.trim()))}))()`);
  if (process.env.MINI_SHOT_DYN) {
    await b.eval(`document.querySelector('#ws-panel-body').scrollTop=document.querySelector('#ws-panel-body').scrollHeight`);
    await sleep(150);
    await b.shot(process.env.MINI_SHOT_DYN);
    await b.eval(`document.querySelector('#ws-panel-body').scrollTop=0`);
  }
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
  await b.waitFor(`window.__miniIds.at(-1).ids.length < ${initial.ids.length} && !!document.querySelector('#ws-panel-body .ws-mini-table .side-table.side-tree')`, 60000);
  const filtered = await b.eval(`(()=>{const m=window.__miniIds.at(-1);return{ids:m.ids,text:document.querySelector('#ws-panel-body').innerText}})()`);
  check("смена среза комплектовщика пересчитала мини-отчёты",
    filtered.ids.length > 0 && filtered.ids.length < initial.ids.length && filtered.text.includes(`Всего изделий: ${filtered.ids.length}`),
    `${initial.ids.length} → ${filtered.ids.length}`);
  await tap(b, '[data-mini-full="status"]');
  await b.waitFor(`location.hash==='#/report-status' && !!document.querySelector('#rd-use-filter')`, 30000);
  const full = await b.eval(`({checked:document.querySelector('#rd-use-filter').checked,note:document.querySelector('#rd-filter-note').textContent})`);
  check("⤢ открыл полный отчёт с тем же срезом комплектовщика", full.checked && full.note.includes("АРМ комплектовщика"), full.note.slice(0, 100));

  await openScreen(b, "ws-picker", `document.querySelector('.ws-tabs button[data-tab="status"]')`);
  await tap(b, '.ws-tabs button[data-tab="status"]');
  await b.waitFor(`!!document.querySelector('[data-mini-full="dynamics"]') && !!document.querySelector('.side-chart svg')`, 60000);
  const dynRequests = () => b.requests.filter((r) => r.method === "POST" && r.url.endsWith("/reports/dynamics")).length;
  const beforeMode = dynRequests();
  await b.eval(`(()=>{const s=document.querySelector('[data-mini-mode]');s.value='delivery';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`document.querySelector('[data-mini-mode]')?.value==='delivery'`);
  check("режим «только поставку» меняет кривые и легенду без нового запроса",
    dynRequests() === beforeMode && await b.eval(`document.querySelectorAll('.side-chart-legend span').length>0 && document.querySelectorAll('.side-chart-legend span').length<=3`));
  const lastWeek = await b.eval(`document.querySelector('[data-mini-to]').max`);
  await b.eval(`(()=>{const s=document.querySelector('[data-mini-from]');s.value=${JSON.stringify(lastWeek)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`document.querySelector('[data-mini-range-reset]')?.hidden===false`);
  check("период меняет только масштаб графика, сброс «весь проект» доступен",
    dynRequests() === beforeMode && await b.eval(`document.querySelector('[data-mini-from]').value===${JSON.stringify(lastWeek)}`));
  await tap(b, '[data-mini-range-reset]');
  const previousDate = await b.eval(`(()=>{const d=new Date(document.querySelector('[data-mini-date]').value+'T00:00:00');d.setDate(d.getDate()-7);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')})()`);
  await b.eval(`(()=>{const s=document.querySelector('[data-mini-date]');s.value=${JSON.stringify(previousDate)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`document.querySelector('[data-mini-date]')?.value===${JSON.stringify(previousDate)} && !!document.querySelector('.side-chart svg')`, 60000);
  await sleep(300); // дождаться перерисовки после трёх параллельных запросов мини-отчётов
  await tap(b, '[data-mini-full="dynamics"]');
  await b.waitFor(`location.hash==='#/report-dynamics' && !!document.querySelector('#rd-use-filter')`, 30000);
  const dynamicsFull = await b.eval(`({checked:document.querySelector('#rd-use-filter').checked,note:document.querySelector('#rd-filter-note').textContent,date:document.querySelector('input[data-param="report_date"]')?.value})`);
  check("⤢ Динамики открыл полный отчёт с тем же отбором и датой",
    dynamicsFull.checked && dynamicsFull.note.includes("АРМ комплектовщика") && dynamicsFull.date === previousDate,
    `${dynamicsFull.date} / ${previousDate}`);

  for (const ws of ["ws-model", "ws-foreman"]) {
    await openScreen(b, ws, `document.querySelector('.ws-tabs button[data-tab="status"]')`);
    await tap(b, '.ws-tabs button[data-tab="status"]');
    await b.waitFor(`!!document.querySelector('#ws-panel-body .ws-mini-table .side-table.side-tree')`, 60000);
    check(`${ws}: мини-отчёты построены`, await b.eval(`document.querySelectorAll('.ws-mini-section').length===3`));
  }
  check("необработанных ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
  await openV1(b, BASE, 1);
  await b.eval(`switchTab('status')`);
  await b.waitFor(`!!document.querySelector('#side-status-body .side-tree tr.total') && document.querySelectorAll('#side-dyn-body .side-dyn-block').length===2`, 60000);
  const v1Values = await b.eval(`(()=>({status:[...document.querySelectorAll('#side-status-body .side-tree tr.total td')].map(x=>x.textContent.trim()),
    deviation:(()=>{const r=document.querySelector('#side-dev-body');return{head:r?.querySelector('.hint-text')?.textContent.replace(/\\s+/g,' ').trim(),cells:[...r.querySelectorAll('th,td')].map(x=>x.textContent.trim())}})(),
    dynamics:[...document.querySelectorAll('#side-dyn-body .side-dyn-block')].map(b=>[...b.querySelectorAll('th,td')].map(x=>x.textContent.trim()))}))()`);
  check("сводка, отклонение и Динамика V2 совпадают с V1 на одном объекте и дате",
    JSON.stringify(v2Values) === JSON.stringify(v1Values),
    JSON.stringify({v2:v2Values, v1:v1Values}).slice(0, 350));
} finally { await b?.close(); }
const fails = results.filter((x) => !x).length;
console.log(`Итого: ${results.length - fails} PASS / ${fails} FAIL из ${results.length}`);
process.exitCode = fails ? 1 : 0;
