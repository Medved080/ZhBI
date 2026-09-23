// Аудит «рабочие места и отчёты»: шесть отчётов V2 (reports-work.js) против V1 на ОДНОМ настоящем сервере.
// Настоящий backend (копия обезличенной БД), настоящий вход формой V2, настоящие щелчки мышью (scripts/cdp.mjs);
// числа V2 сверяются с самим V1 (та же сессия, та же копия), выбор V1 — его же функциями switchReport/loadReport.
// Запуск: node scripts/audit_work/chk_reports.mjs   (порт 8371)
import { startServer, stopServer, check, summary, sleep, SP, session, setObject, openScreen, tap, choose, exec, sql, sql1, openV1 } from "./lib.mjs";

const PORT = 8371;
const S = await startServer(PORT, `${SP}/aw_reports`, {
  setup(db) {
    // данные копии: редакция «событий, задач, вопросов» объекта 1 и сроки у части ЗР объекта 4 (иначе Гант и отклонение пусты)
    exec(db, `INSERT INTO report_notes (object_id, effective_date, key_events, key_tasks, open_questions, updated_by) VALUES (1, '2026-09-01', '["Событие аудита 1","Событие аудита 2"]', '["Задача аудита"]', '["Вопрос аудита"]', 'аудит')`);
    exec(db, `UPDATE block_works SET plan_start='2026-09-01', plan_end='2026-09-20', forecast_start='2026-09-05', forecast_end='2026-10-02' WHERE id IN (SELECT id FROM block_works WHERE object_id=4 AND retired_at IS NULL ORDER BY id LIMIT 12)`);
  },
});
const V2ROWS = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].length`;
let b;
try {
  b = await session(S.base, "admin", { objectId: 1 });

  // ---------------- «Аналитическая справка»
  await openScreen(b, "report-analytics", `document.querySelector('.rw-an-table')`);
  const an2 = await b.eval(`(()=>{const t=document.querySelector('.rw-an-table'); const rows=[...t.tBodies[0].rows]; return { rows: rows.length, total: rows.at(-1).innerText.replace(/\\s+/g,' ').trim(), verdictObj: document.querySelector('#rd-report').innerText.includes('[object Object]'), pills: document.querySelectorAll('.rw-pill').length, status: document.querySelector('#rd-report p[role=status]').innerText, days: [...t.querySelectorAll('td')].some(td=>/^идёт \\d+ дн\\.$/.test(td.textContent.trim())) }; })()`);
  check("справка: вердикты — плашками (нет «[object Object]»)", !an2.verdictObj && an2.pills > 0, JSON.stringify({ pills: an2.pills }));
  check("справка: итог «Итого по горизонту» в таблице этапов", /Итого по горизонту/.test(an2.total), an2.total);
  check("справка: «идёт N дн.» у начатых этапов (как V1)", an2.days);
  // щелчок настоящей мышью по «Только позиции с дефицитом»
  const stagesAll = await b.eval(`fetch('/reports/analytics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:1,source_file:null})}).then(r=>r.json()).then(d=>({all:d.stages.rows.length, deficit:d.stages.rows.filter(r=>r.deficit>0).length}))`);
  check("справка: по умолчанию «только с дефицитом» — строк = строк с дефицитом + итог", an2.rows === stagesAll.deficit + 1, `${an2.rows} vs ${stagesAll.deficit}+1`);
  await tap(b, "#an-only-deficit");
  await sleep(500);
  const anAll = await b.eval(V2ROWS(".rw-an-table:first-of-type tbody tr"));
  const anAllFirst = await b.eval(`document.querySelector('.rw-an-table').tBodies[0].rows.length`);
  check("справка: снятие галочки показывает все этапы", anAllFirst === stagesAll.all + 1, `${anAllFirst} vs ${stagesAll.all}+1 (${anAll})`);
  await tap(b, "#an-only-deficit"); await sleep(400);

  // ---------------- «Динамика»: редакция событий на дату, таблицы статуса
  await openScreen(b, "report-dynamics", `document.querySelector('.rw-dyn-tbl')`);
  const dyn2 = await b.eval(`(()=>({ ev: [...document.querySelectorAll('.rw-dyn-events li')].map(l=>l.textContent), q: [...document.querySelectorAll('.rw-dyn-questions li')].map(l=>l.textContent), tbl: [...document.querySelectorAll('.rw-dyn-tbl tbody td')].map(td=>td.textContent.replace(/\\s/g,'')), head: document.querySelector('.rw-dyn-head').innerText, edit: document.querySelectorAll('[data-dyn-edit]').length, from: document.querySelector('input[data-param=week_from]').value }))()`);
  check("динамика: блоки «Ключевые события»/«Открытые вопросы» из редакции на дату", dyn2.ev.join("|") === "Событие аудита 1|Событие аудита 2" && dyn2.q.join("|") === "Вопрос аудита", JSON.stringify(dyn2.ev));
  check("динамика: шапка «Ежедневный отчёт за …» и две таблицы статуса", /Ежедневный отчёт за/.test(dyn2.head) && dyn2.tbl.length === 16, dyn2.tbl.join(","));
  check("динамика: поле «Период с» показывает фактическое начало срока (как V1)", /^\d{4}-\d{2}-\d{2}$/.test(dyn2.from), dyn2.from);
  // «✎ Изменить» — раздел «События, задачи, вопросы» на отчётную дату (редакции на 22.09 нет → новая с этой датой)
  const today = await b.eval(`document.querySelector('input[data-param=report_date]').value`);
  await tap(b, "[data-dyn-edit]");
  await b.waitFor(`location.hash==='#/report-notes' && document.querySelector('#rn-date')`, 15000);
  await sleep(600);
  const rnDate = await b.eval(`document.querySelector('#rn-date').value`);
  check("динамика: «✎ Изменить» открывает «События, задачи, вопросы» с отчётной датой", rnDate === today, `${rnDate} vs ${today}`);
  await b.eval(`history.back()`);
  await sleep(300);
  // выход с незаполненной новой редакцией: «Не сохранять», если оболочка спросит
  try { await b.waitFor(`[...document.querySelectorAll('dialog button, .v2-dialog button')].some(x=>/Не сохранять|Выйти без/.test(x.textContent))`, 2500); await b.eval(`[...document.querySelectorAll('dialog button, .v2-dialog button')].find(x=>/Не сохранять|Выйти без/.test(x.textContent)).click()`); } catch { /* диалога нет */ }
  await b.waitFor(`location.hash==='#/report-dynamics' && document.querySelector('.rw-dyn-tbl')`, 15000);
  check("динамика: возврат назад к отчёту", true);

  // ---------------- «Моя работа»: период, все пользователи, изделие/объект, переход к изделию на схеме
  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  const setDate = async (param, v) => { await b.eval(`(()=>{const i=document.querySelector('input[data-param=${param}]'); i.value='${v}'; i.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(900); };
  await setDate("date_from", "2026-08-11"); await setDate("date_to", "2026-08-11");
  await b.waitFor(`document.querySelector('[data-user-select]')`, 10000);
  await choose(b, "[data-user-select]", "__all__");
  await b.waitFor(`document.querySelector('#mw-table')`, 15000);
  await sleep(500);
  const mw2 = await b.eval(`(()=>({ rows: document.querySelectorAll('#mw-table tbody tr').length, loc: document.querySelectorAll('#mw-table tr.rw-locatable').length, addr: [...document.querySelectorAll('#mw-table tbody td:nth-child(4)')].some(td=>/этаж/.test(td.textContent)), status: document.querySelector('#rd-report p[role=status]').innerText }))()`);
  check("моя работа: колонка «Изделие / объект» с адресом и этажом", mw2.addr && mw2.loc > 0, JSON.stringify(mw2));

  // ---------------- «Статус монтажа» (итог)
  await openScreen(b, "report-status", `document.querySelector('.lvl-total')`);
  const st2 = await b.eval(`document.querySelector('.lvl-total').innerText.replace(/\\s/g,'')`);

  // ---------------- МФР-отчёты (объект 4)
  await setObject(b, 4);
  await openScreen(b, "report-linear-track", `document.querySelector('#rd-report table')`);
  const lin2 = await b.eval(`(()=>({ rows: document.querySelectorAll('#rd-report tbody tr').length, head: [...document.querySelectorAll('#rd-report thead th')].map(t=>t.textContent), first: [...document.querySelector('#rd-report tbody tr').cells].map(c=>c.textContent.trim()) }))()`);
  check("линейный трек: колонки V1 (WBS, Код, Ед. изм., Трек планирования, Примечание)", lin2.head.join("|") === "WBS|Код|Ед. изм.|Трек планирования|Примечание", lin2.head.join("|"));

  await openScreen(b, "report-block-status", `document.querySelector('.v2-matrix')`);
  check("учёт по блокам: по умолчанию всё дерево WBS, как в V1", await b.eval(`document.querySelector('#bs-all').checked && document.querySelectorAll('.v2-matrix tr.rw-node').length > 0`));
  await sleep(600);
  const bsAll = await b.eval(`(()=>({ rows: document.querySelectorAll('.v2-matrix tbody tr').length, nodes: document.querySelectorAll('.v2-matrix tr.rw-node').length, inputs: document.querySelectorAll('.v2-matrix-input').length }))()`);
  await choose(b, "#bs-mode", "plan"); await sleep(300);
  const bsPlan = await b.eval(`(()=>({ inputs: document.querySelectorAll('.v2-matrix-input').length, dates: [...document.querySelectorAll('.v2-matrix td')].filter(td=>/^(\\d\\d\\.\\d\\d|—)–(\\d\\d\\.\\d\\d|—)$/.test(td.textContent.trim())).length, cycles: document.querySelectorAll('.v2-matrix-cycle').length }))()`);
  check("учёт по блокам: «Показывать: план» — даты «дд.мм–дд.мм» вместо полей ввода", bsPlan.inputs === 0 && bsPlan.dates > 0, JSON.stringify(bsPlan));
  check("учёт по блокам: «сек/компл» кликабельны и в режиме «план» (как V1)", bsPlan.cycles > 0, String(bsPlan.cycles));
  await choose(b, "#bs-mode", "deviation"); await sleep(300);
  const bsDev = await b.eval(`[...document.querySelectorAll('.v2-matrix td')].filter(td=>/^([+-]?\\d+ дн|±0 дн|—)$/.test(td.textContent.trim())).length`);
  check("учёт по блокам: «Показывать: отклонение»", bsDev > 0, String(bsDev));
  await choose(b, "#bs-mode", "percent"); await sleep(300);
  check("учёт по блокам: «Показать все» — дерево WBS с разделами, поля процента в режиме «процент»", bsAll.nodes > 0 && bsAll.inputs > 0 && (await b.eval(`document.querySelectorAll('.v2-matrix-input').length`)) === bsAll.inputs, JSON.stringify(bsAll));

  // «График работ по блокам»: группировка фишками (как V1, общий ключ localStorage), вид «Гант», итог
  await b.eval(`localStorage.removeItem('zhbi_block_schedule_groups')`);
  await openScreen(b, "report-block-schedule", `document.querySelector('#bsch-table')`);
  const reqN = b.requests.length;
  await tap(b, '[data-bsg-toggle="operation"]');
  await b.waitFor(`document.querySelector('#bsch-table') && !document.querySelector('[data-bsg-toggle="operation"]').checked`, 10000);
  await sleep(800);
  const bodyGb = b.requests.slice(reqN).filter((r) => r.url.endsWith("/reports/block-schedule")).map((r) => JSON.parse(r.body).group_by);
  check("график работ: снятие «Операция» — перезапрос без уровня operation", bodyGb.length === 1 && !bodyGb[0].includes("operation") && bodyGb[0].length === 4, JSON.stringify(bodyGb));
  await tap(b, '[data-bsg-move="section"][data-dir="-1"]');
  await sleep(1200);
  const saved = await b.eval(`JSON.parse(localStorage.getItem('zhbi_block_schedule_groups')).map(g=>g.key+':'+(g.on?1:0)).join(',')`);
  check("график работ: порядок уровней меняется ◀ и сохраняется под ключом V1", saved === "track:1,wbs_section:1,section:1,operation:0,floor:1", saved);
  const bs2 = await b.eval(`(()=>({ groups: document.querySelectorAll('#bsch-table tr.rw-bsch-group').length, rows: document.querySelectorAll('#bsch-table tbody tr').length, total: document.querySelector('.rw-bsch-total').innerText }))()`);
  await choose(b, "select[data-param=view]", "gantt");
  await b.waitFor(`document.querySelectorAll('.rw-gantt-bar').length > 0`, 15000);
  const bars = await b.eval(`(()=>{const p=[...document.querySelectorAll('.rw-gantt-bar.rw-gantt-plan')]; return { plan: p.length, fc: document.querySelectorAll('.rw-gantt-bar.rw-gantt-forecast').length, styled: p.every(x=>/left:[\\d.]+%;width:[\\d.]+%/.test(x.getAttribute('style'))) };})()`);
  const withPlan = sql1(S.db, "SELECT COUNT(*) FROM block_works WHERE object_id=4 AND retired_at IS NULL AND (plan_start IS NOT NULL OR plan_end IS NOT NULL)");
  const withFc = sql1(S.db, "SELECT COUNT(*) FROM block_works WHERE object_id=4 AND retired_at IS NULL AND (forecast_start IS NOT NULL OR forecast_end IS NOT NULL)");
  check("график работ: вид «Гант» — полосы плана и прогноза (= ЗР со сроками по SQL)", bars.plan === withPlan && bars.fc === withFc && bars.styled, `${JSON.stringify(bars)} SQL план ${withPlan}, прогноз ${withFc}`);
  await choose(b, "select[data-param=view]", "table"); await sleep(1000);
  // выгрузка — тем же телом запроса (группировка и вид)
  const nX = b.requests.length;
  await tap(b, '[data-export="xlsx"]');
  await b.waitFor(`/сформирован|Не удалось/.test(document.querySelector('#rd-export-status').textContent)`, 30000);
  const xr = b.requests.slice(nX).find((r) => r.url.endsWith("/reports/block-schedule.xlsx"));
  const lastRep = b.requests.slice(0, nX).filter((r) => r.url.endsWith("/reports/block-schedule")).at(-1);
  check("график работ: XLSX уходит с той же группировкой и видом, что отчёт на экране", !!xr && xr.status === 200 && JSON.stringify(JSON.parse(xr.body).group_by) === JSON.stringify(JSON.parse(lastRep.body).group_by) && JSON.parse(xr.body).view === "table", xr ? xr.body : "нет запроса");

  // ---------------- V1 на том же сервере, в той же сессии
  await openV1(b, S.base, null);   // V1 открывается на последнем объекте пользователя — 4 (выбран в V2 выше)
  check("V1 открыт на объекте 4 (МФР)", (await b.eval(`state.objectId`)) === 4);
  const v1 = async (key, waitExpr) => {
    await b.eval(`(()=>{document.getElementById('reports-backdrop').classList.add('open'); switchReport('${key}');})()`);
    await b.waitFor(`!/Построение/.test(document.getElementById('report-status-line').textContent) && document.getElementById('report-body').children.length > 0 ${waitExpr ? "&& " + waitExpr : ""}`, 60000);
    await sleep(500);
  };
  await v1("linear_track", `!!document.querySelector('.lintrack-table')`);
  const lin1 = await b.eval(`(()=>({ rows: document.querySelectorAll('.lintrack-table tbody tr').length, first: [...document.querySelector('.lintrack-table tbody tr').cells].map(c=>c.textContent.trim()) }))()`);
  check("V1 = V2: «Линейный трек», строки и первая строка", lin1.rows === lin2.rows && lin1.first.join("|") === lin2.first.join("|"), `V1 ${lin1.rows} ${lin1.first.join("|")} / V2 ${lin2.rows} ${lin2.first.join("|")}`);
  await v1("block_status", `!!document.querySelector('#wp-matrix-table')`);
  const bs1 = await b.eval(`document.querySelectorAll('#wp-matrix-table tbody tr').length`);
  check("V1 = V2: «Учёт по блокам: статусы», строк дерева WBS («Показать все»)", bs1 === bsAll.rows, `V1 ${bs1} / V2 ${bsAll.rows}`);
  await v1("block_schedule", `!!document.querySelector('#bsch-table')`);
  await sleep(800);
  const bsch1 = await b.eval(`(()=>({ groups: document.querySelectorAll('#bsch-table tr.bsch-group').length, rows: document.querySelectorAll('#bsch-table tbody tr').length, total: document.querySelector('#bsch-table tr.bsch-total').innerText }))()`);
  check("V1 = V2: «График работ по блокам» с той же группировкой (общий ключ): группы, строки, итог", bsch1.groups === bs2.groups && bsch1.rows === bs2.rows && bsch1.total.replace(/\s/g, "") === bs2.total.replace(/\s/g, ""), `V1 ${JSON.stringify(bsch1)} / V2 ${JSON.stringify(bs2)}`);
  await b.eval(`(async()=>{ await switchObject(1); })()`); await b.waitFor(`state.objectId===1 && state.elements.length > 0 && !!state.sourceFile`, 60000); await sleep(1000);
  await v1("analytics", `!!document.querySelector('.an-table')`);
  const an1 = await b.eval(`document.querySelector('.an-table').tBodies[0].rows.length`);
  check("V1 = V2: «Аналитическая справка», строк этапов (только с дефицитом) + итог", an1 === an2.rows, `V1 ${an1}, V2 ${an2.rows}`);
  await v1("dynamics", `!!document.querySelector('.dyn-tables')`);
  const dyn1 = await b.eval(`(()=>({ ev: [...document.querySelectorAll('.dyn-box.events li')].map(l=>l.textContent), tbl: [...document.querySelectorAll('.dyn-tables table tr:nth-child(3) td, .dyn-tables table tbody tr:last-child td')].map(td=>td.textContent.replace(/\\s/g,'')) }))()`);
  const norm = (a) => a.map((x) => x.replace(/ /g, "")).join(",");
  check("V1 = V2: «Динамика», события редакции", dyn1.ev.join("|") === dyn2.ev.join("|"), dyn1.ev.join("|"));
  check("V1 = V2: «Динамика», таблицы статуса монтажа/поставки", norm(dyn1.tbl.slice(0, 16)) === norm(dyn2.tbl), `V1 ${dyn1.tbl.join(",")} / V2 ${dyn2.tbl.join(",")}`);
  await v1("status", `!!document.querySelector('#report-table tr.total')`);
  const st1 = await b.eval(`document.querySelector('#report-table tr.total').innerText.replace(/\\s/g,'')`);
  check("V1 = V2: «Статус монтажа», итоговая строка", st1.replace(/ /g, "") === st2.replace(/ /g, ""), `V1 ${st1} / V2 ${st2}`);
  await b.eval(`(()=>{document.getElementById('reports-backdrop').classList.add('open'); switchReport('mywork');})()`);
  await b.waitFor(`document.getElementById('mw-user').options.length > 0`, 20000);
  await b.eval(`(()=>{document.getElementById('mw-from').value='2026-08-11'; document.getElementById('mw-to').value='2026-08-11'; document.getElementById('mw-user').value='all'; loadReport();})()`);
  await b.waitFor(`!!document.querySelector('#mw-table') && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  const mw1 = await b.eval(`(()=>({ rows: document.querySelectorAll('#mw-table tbody tr').length, loc: document.querySelectorAll('#mw-table tr.mw-locatable').length }))()`);
  check("V1 = V2: «Моя работа», строк и изделий со ссылкой на схему", mw1.rows === mw2.rows && mw1.loc === mw2.loc, `V1 ${JSON.stringify(mw1)} / V2 ${mw2.rows}/${mw2.loc}`);
  check("V1 работает: исключений JavaScript за сценарий нет", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("Отчёты V2 против V1") ? 1 : 0);
