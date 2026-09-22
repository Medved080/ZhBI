// «Статус комплектации» в V2 — вид «сводная таблица» (перенос из V1: renderCompletionPivot, createGroupChooser, cmp-view/
// cmp-scale/cmp-step). Настоящий backend (копия обезличенной БД), настоящий вход формой V2, НАСТОЯЩИЕ события: выбор в
// списках — щелчок по подписи поля + буква с клавиатуры, фишки группировки и свёртка — щелчки мышью. Числа на экране
// сверяются с ответом сервера, который получил сам экран (DevTools Network.getResponseBody).
// Копия БД готовится SQL: у одного изделия объекта 1 плановая поставка сдвинута на 2029 год — иначе шаг «День» не
// превышает потолок в 400 колонок и путь «сервер отказал из-за настроек» не проверить.
// Запуск: node scripts/reports2_verify/chk_pivot.mjs
import { startServer, stopServer, check, summary, sleep, SP, exec, sql1, hardGoto, chooseByLabel, clickEl, responseJson, waitReq } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8341;
const FAR_ID = { v: null };
const S = await startServer(PORT, `${SP}/r2_pivot`, {
  setup: (db) => {
    FAR_ID.v = sql1(db, "SELECT min(id) FROM elements WHERE object_id=1 AND is_current=1 AND planned_delivery_date IS NULL");
    exec(db, `UPDATE elements SET planned_delivery_date='2029-12-31' WHERE id=${FAR_ID.v}`);
  },
});
const SHOTS = `${SP}/r2_pivot_shots`;
const norm = (s) => String(s ?? "").replace(/[\s ]/g, "");
const cmpBody = (r) => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };
const lastCmpReq = (b, from) => b.requests.slice(from).filter((r) => /\/reports\/completion$/.test(r.url)).pop();
// Видимые строки при правиле свёртки V1 (defaultCollapsedTree): раскрыта первая ветка верхнего уровня и первая ветка в ней.
function expectedVisible(rows) {
  const collapsed = new Set();
  rows.forEach((row, i) => { if (i > 0) collapsed.add(row.label); else (row.children || []).forEach((f, j) => { if (j > 0) collapsed.add(`${row.label}/${f.label}`); }); });
  let n = 0;
  const walk = (node, path) => { n++; if (collapsed.has(path)) return; (node.children || []).forEach((c) => walk(c, `${path}/${c.label}`)); };
  rows.forEach((r) => walk(r, r.label));
  return n;
}
const domTable = (b) => b.eval(`(()=>{const t=document.querySelector('#rd-report table.v2-cmp-pivot'); if(!t) return null;
  const head=[...t.querySelectorAll('thead th')].map(x=>x.textContent.trim());
  const rows=[...t.querySelectorAll('tbody tr')].map(tr=>({lvl:tr.className, cells:[...tr.children].map(td=>td.textContent.trim())}));
  return {head, rows};})()`);

let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: SHOTS });
  await openScreen(b, "report-completion", `/Позиций/.test(document.querySelector('#rd-report')?.textContent||'')`);
  check("по умолчанию — вид «Перечень позиций» (как в V1 при пустой настройке)", await b.eval(`document.querySelector('select[data-param="view"]')?.value === 'list' && !document.querySelector('select[data-param="step"]')`));
  check("в перечне есть поиск по таблице; шкалы, шага и группировки нет", await b.eval(`!document.getElementById('rd-search').hidden && !document.querySelector('[data-groups]')`));

  // ---- 1. переключение вида: щелчок по подписи «Вид» + буква «С» ----
  let from = b.requests.length;
  await chooseByLabel(b, "Вид", "С");
  await b.waitFor(`/Изделий:/.test(document.querySelector('#rd-report')?.textContent||'') && !!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  let req = await waitReq(b, /\/reports\/completion$/, from);
  let body = cmpBody(req);
  check("вид «Сводная таблица» уходит в запрос: view=pivot, группировка по умолчанию V1, шаг не задан (подберёт сервер)",
    body.view === "pivot" && JSON.stringify(body.group_by) === JSON.stringify(["counterparty", "agreement", "specification", "type", "subtype", "mark"]) && body.step === undefined, JSON.stringify({ ...body, element_ids: body.element_ids ? `[${body.element_ids.length}]` : undefined }));
  let data = await responseJson(b, req);
  let dom = await domTable(b);
  check("шапка таблицы = корень + колонки календаря + «Без даты» + «Итого» из ответа сервера",
    JSON.stringify(dom.head) === JSON.stringify([data.root_label, ...data.columns.map((c) => c.label), data.total_label]), `${dom.head.length} колонок: ${dom.head.slice(0, 4).join(" | ")} … ${dom.head.slice(-2).join(" | ")}`);
  const totRow = dom.rows[dom.rows.length - 1].cells;
  const expTot = [data.total.label, ...data.columns.map((c) => (data.total.values[c.key] ? String(data.total.values[c.key]) : "")), String(data.total.total)];
  check("строка «Итого»: каждое число совпадает с ответом сервера (ноль — пустая ячейка)", JSON.stringify(totRow.map(norm)) === JSON.stringify(expTot.map(norm)), `итого ${norm(totRow[totRow.length - 1])}`);
  const statusText = await b.eval(`document.querySelector('#rd-report [role=status]')?.textContent`);
  check("строка состояния «Изделий: N» (как у V1 в виде сводной)", norm(statusText) === `Изделий:${data.total.total}`, statusText);
  const lvl0 = dom.rows.filter((r) => r.lvl === "lvl-0").map((r) => [norm(r.cells[0]).replace(/^[▸▾]/, ""), norm(r.cells[r.cells.length - 1])]);
  check("строки верхнего уровня (заводы) и их итоги = ответу сервера", JSON.stringify(lvl0) === JSON.stringify(data.rows.map((r) => [norm(r.label), String(r.total)])), JSON.stringify(lvl0.slice(0, 3)));
  check("свёрнуто всё, кроме первой ветки (правило V1): число видимых строк", dom.rows.length - 1 === expectedVisible(data.rows), `видно ${dom.rows.length - 1}, по правилу V1 ${expectedVisible(data.rows)}`);
  check("подпись и предупреждение сервера показаны над таблицей", await b.eval(`(document.querySelector('#rd-report')?.textContent||'').includes(${JSON.stringify(data.subtitle)})`) && (!data.warning || await b.eval(`(document.querySelector('#rd-report')?.textContent||'').includes(${JSON.stringify(data.warning)})`)));
  check("поиск по таблице в сводной скрыт (в V1 его нет)", await b.eval(`document.getElementById('rd-search').hidden`));
  await b.shot(`${SHOTS}/pivot-default.png`);

  // ---- 2. свёртка/развёртка — щелчок мышью, без запроса ----
  from = b.requests.length;
  const firstLabel = data.rows[0].label;
  await clickEl(b, `document.querySelector('#rd-report .v2-tree-toggle[data-path=${JSON.stringify(JSON.stringify(firstLabel)).slice(1, -1)}]')`);
  await sleep(300);
  let dom2 = await domTable(b);
  check("щелчок по ▾ первой ветки сворачивает её (строк меньше), запроса к серверу нет", dom2.rows.length < dom.rows.length && !b.requests.slice(from).some((r) => /reports/.test(r.url)), `${dom.rows.length} → ${dom2.rows.length}`);
  await clickEl(b, `document.querySelector('#rd-report .v2-tree-toggle[data-path=${JSON.stringify(JSON.stringify(firstLabel)).slice(1, -1)}]')`);
  await sleep(300);
  check("повторный щелчок разворачивает обратно", (await domTable(b)).rows.length === dom.rows.length);

  // ---- 3. шаг: на первом открытии его подобрал сервер (здесь — «Месяц»); выбираем «Неделя» (буква «Н») ----
  check("шаг на первом открытии — подобранный сервером, показан в поле «Шаг»", await b.eval(`document.querySelector('select[data-param="step"]')?.value`) === data.step, data.step);
  from = b.requests.length;
  await chooseByLabel(b, "Шаг", "Н");
  req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`document.querySelector('select[data-param="step"]')?.value === 'week' && !!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  body = cmpBody(req); data = await responseJson(b, req);
  check("шаг «Неделя» уходит в запрос, колонки — недели", body.step === "week" && data.step === "week" && (await domTable(b)).head.length === data.columns.length + 2, `колонок ${data.columns.length}: ${data.columns.slice(0, 3).map((c) => c.label).join(", ")}…`);

  // ---- 4. колонки: «Требуемая дата поставки» (буква «Т»); выбранный шаг сохраняется ----
  from = b.requests.length;
  await chooseByLabel(b, "Колонки", "Т");
  req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`document.querySelector('select[data-param="date_scale"]')?.value === 'need' && !!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  body = cmpBody(req); data = await responseJson(b, req);
  check("шкала «Требуемая» уходит в запрос (date_scale=need), выбранный шаг остаётся", body.date_scale === "need" && body.step === "week" && data.scale === "need", data.subtitle);

  // ---- 5. группировка: «Марка» выше (◀), снять «Подтип», последний уровень снять нельзя ----
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-group-move="mark"][data-dir="-1"]')`);
  req = await waitReq(b, /\/reports\/completion$/, from);
  body = cmpBody(req);
  check("◀ у «Марка» поднимает её на уровень выше: порядок group_by в запросе", JSON.stringify(body.group_by) === JSON.stringify(["counterparty", "agreement", "specification", "type", "mark", "subtype"]), JSON.stringify(body.group_by));
  await b.waitFor(`!!document.querySelector('[data-group-toggle="subtype"]')`, 30000);
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-group-toggle="subtype"]')`);
  req = await waitReq(b, /\/reports\/completion$/, from);
  body = cmpBody(req); data = await responseJson(b, req);
  check("снятая галочка «Подтип» убирает уровень из запроса и из подписи отчёта", !body.group_by.includes("subtype") && !data.group_labels.includes("Подтип"), data.group_labels.join(" → "));
  // оставить один уровень: снимаем все, кроме «Завод»
  for (const k of ["agreement", "specification", "type", "mark"]) {
    await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot') && document.querySelector('[data-group-toggle="${k}"]')?.checked`, 30000);
    await clickEl(b, `document.querySelector('[data-group-toggle="${k}"]')`);
    await sleep(200);
  }
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot') && [...document.querySelectorAll('[data-group-toggle]')].filter(x=>x.checked).length===1`, 30000);
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-group-toggle="counterparty"]')`);
  await sleep(600);
  const lastState = await b.eval(`({checked: document.querySelector('[data-group-toggle="counterparty"]').checked, msg: document.querySelector('[data-groups-msg]')?.textContent})`);
  check("последний уровень снять нельзя: галочка осталась, объяснение рядом, запроса нет", lastState.checked && /Хотя бы один уровень/.test(lastState.msg) && !b.requests.slice(from).some((r) => /reports\/completion/.test(r.url)), JSON.stringify(lastState));
  const ls = await b.eval(`({view: localStorage.getItem('zhbi_completion_view'), groups: JSON.parse(localStorage.getItem('zhbi_completion_pivot_groups')||'null')})`);
  check("вид и уровни запомнены в localStorage ключами и форматом V1 ([{key,on}] по порядку)", ls.view === "pivot" && Array.isArray(ls.groups) && ls.groups.length === 9 && ls.groups.filter((g) => g.on).map((g) => g.key).join() === "counterparty" && ls.groups.findIndex((g) => g.key === "mark") < ls.groups.findIndex((g) => g.key === "subtype"), JSON.stringify(ls.groups));
  // вернуть «Тип» и «Марка» для следующих шагов
  for (const k of ["type", "mark"]) {
    await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
    await clickEl(b, `document.querySelector('[data-group-toggle="${k}"]')`);
    await sleep(300);
  }
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot') && [...document.querySelectorAll('[data-group-toggle]')].filter(x=>x.checked).length===3`, 30000);

  // ---- 6. перезагрузка страницы: вид и группировка восстановлены; шаг/шкала — нет (в V1 они тоже не запоминаются) ----
  await hardGoto(b, `${S.base}/v2#/report-completion`, 1500);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  req = b.requests.filter((r) => /\/reports\/completion$/.test(r.url)).pop();
  body = cmpBody(req);
  check("после перезагрузки: сводная и сохранённые уровни (Завод → Тип → Марка) — в первом же запросе", body.view === "pivot" && JSON.stringify(body.group_by) === JSON.stringify(["counterparty", "type", "mark"]), JSON.stringify(body.group_by));

  // ---- 7. выгрузка XLSX и PDF — тот же запрос, что у экрана, имя файла «(сводная)» как в V1 ----
  for (const ext of ["xlsx", "pdf"]) {
    from = b.requests.length;
    await clickEl(b, `document.querySelector('[data-export="${ext}"]')`);
    const dl = await waitReq(b, new RegExp(`/reports/completion\\.${ext}$`), from);
    await b.waitFor(`/сформирован|Не удалось/.test(document.getElementById('rd-export-status')?.textContent||'')`, 30000);
    const st = await b.eval(`document.getElementById('rd-export-status').textContent`);
    const same = JSON.stringify(cmpBody(dl)) === JSON.stringify(body);
    const n = b.requests.slice(from).filter((r) => new RegExp(`/reports/completion\\.${ext}$`).test(r.url)).length;
    check(`выгрузка ${ext.toUpperCase()}: 200, тело запроса = телу отчёта на экране, один запрос, имя «Статус комплектации (сводная).${ext}»`, dl.status === 200 && same && n === 1 && st.includes(`Статус комплектации (сводная).${ext}`), `${dl.status}; ${st}`);
  }

  // ---- 8. печать: вся таблица (без обрезки по высоте окна) ----
  await clickEl(b, `document.querySelector('#rd-print')`);
  await sleep(400);
  await b.send("Emulation.setEmulatedMedia", { media: "print" });
  await sleep(200);
  const pr = await b.eval(`(()=>{const a=document.getElementById('v2-print-area'); const t=a?.querySelector('table.v2-cmp-pivot'); const w=a?.querySelector('.v2-ds-wrap'); return {display:getComputedStyle(a).display, table:!!t, rows:t?t.querySelectorAll('tbody tr').length:0, screenRows: document.querySelectorAll('#rd-report table.v2-cmp-pivot tbody tr').length, clipped: w ? w.scrollHeight > w.clientHeight + 2 : null, title: a?.querySelector('h2')?.textContent};})()`);
  check("печать: в узле печати сводная таблица целиком (те же строки, что на экране; область не обрезана по высоте)", pr.display === "block" && pr.table && pr.rows === pr.screenRows && pr.clipped === false, JSON.stringify(pr));
  await b.send("Emulation.setEmulatedMedia", { media: "" });

  // ---- 9. отказ сервера из-за настроек: шаг «День» по плановой дате (одно изделие сдвинуто на 2029 год) ----
  // после перезагрузки шкала — снова плановая (шкалу и шаг V1 тоже не запоминает между сеансами)
  check("после перезагрузки шкала — плановая по умолчанию, шаг — подобранный сервером", await b.eval(`document.querySelector('select[data-param="date_scale"]')?.value === 'plan' && !('date_scale' in ${JSON.stringify(body)}) && !('step' in ${JSON.stringify(body)})`));
  from = b.requests.length;
  await chooseByLabel(b, "Шаг", "Д");
  req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-body [role=alert]')`, 30000);
  const err = await b.eval(`({alert: document.querySelector('#rd-body [role=alert]').textContent, step: document.querySelector('select[data-param="step"]')?.value, groups: !!document.querySelector('[data-groups]')})`);
  check("400 «слишком много колонок»: текст сервера показан, настройки остались на экране (шаг «День» виден)", req.status === 400 && /Укрупните шаг/.test(err.alert) && err.step === "day" && err.groups, `${req.status}: ${err.alert.slice(0, 120)}`);
  await b.shot(`${SHOTS}/pivot-error.png`);
  from = b.requests.length;
  await chooseByLabel(b, "Шаг", "М");
  req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  check("исправление настройкой прямо под ошибкой: шаг «Месяц» — отчёт построен", req.status === 200 && cmpBody(req).step === "month");

  // ---- 10. обратно в перечень: шкала/шаг/группировка в запрос не идут ----
  from = b.requests.length;
  await chooseByLabel(b, "Вид", "П");
  req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`/Позиций:/.test(document.querySelector('#rd-report')?.textContent||'')`, 30000);
  body = cmpBody(req);
  check("вид «Перечень»: в запросе view=list без date_scale/step/group_by (как шлёт V1)", body.view === "list" && !("date_scale" in body) && !("step" in body) && !("group_by" in body), JSON.stringify(body));
  check("в перечне поиск снова виден, настройки сводной скрыты", await b.eval(`!document.getElementById('rd-search').hidden && !document.querySelector('[data-groups]') && !document.querySelector('select[data-param="step"]')`));
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
