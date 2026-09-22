// «График контрактации и поставки»: галочка «Учитывать текущий фильтр схемы» — в V2 (общий механизм снимка отбора
// read-screen.js, как у остальных отчётов) и в САМОМ V1 (после исправления сервера), на одном сервере и одном отборе.
// Отбор задаётся НАСТОЯЩИМ щелчком (снято одно значение «Статус») и в рабочем месте V2 «Модель», и в панели фильтров V1;
// галочки — настоящими щелчками. Числа сверяются с ответами, которые получили экраны, и с прямым SQL по копии БД.
// Настоящий backend (копия обезличенной БД), настоящий вход формой V2. Запуск: node scripts/reports2_verify/chk_contracting_ui.mjs
import { startServer, stopServer, check, summary, sleep, SP, sql1, hardGoto, chooseValue, clickEl, responseJson, waitReq, v2ExcludeFirstStatus, v1ExcludeStatus, v1OpenReport } from "./lib.mjs";
import { session, openScreen, setObject } from "../verify_mfr_lib.mjs";

const PORT = 8343;
const S = await startServer(PORT, `${SP}/r2_contracting`);
const SHOTS = `${SP}/r2_contracting_shots`;
const EP = /\/reports\/contracting-schedule$/;
const body = (r) => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };
const canon = (d) => JSON.stringify(d);
const setEq = (x, y) => x.length === y.length && new Set(x).size === new Set([...x, ...y]).size;
const rdText = (b) => b.eval(`(document.querySelector('#rd-report')?.textContent||'').replace(/\\u00a0/g,' ')`);
const numRu = (n) => n.toLocaleString("ru-RU").replace(/ /g, " ");

async function openContracting(b) {
  await openScreen(b, "report-contracting", `!!document.querySelector('#rd-report table.v2-cs-tbl')`);
}
async function v1Goto(b) {
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await b.goto(`${S.base}/`, 800); else await hardGoto(b, `${S.base}/`, 1200);
    try {
      await b.waitFor(`typeof switchObject === "function"`, 20000);
      await b.eval(`(async()=>{ await switchObject(1); })()`);
      await b.waitFor(`state.objectId === 1 && state.elements.length > 0 && document.getElementById("menu-report-contracting")`, 30000);
      break;
    } catch (e) { console.log(`V1 не готов (попытка ${attempt})`); if (attempt >= 2) throw e; }
  }
  await sleep(300);
}

let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: SHOTS });

  // ---- 0. до отбора: галочка есть, недоступна, объяснение рядом ----
  await openContracting(b);
  const st0 = await b.eval(`(()=>{const c=document.getElementById('rd-use-filter'); return c ? {checked:c.checked, disabled:c.disabled, note: document.getElementById('rd-filter-note')?.textContent} : null;})()`);
  check("V2: галочка «Учитывать текущий фильтр схемы» появилась; без снимка — снята и недоступна, с объяснением", !!st0 && !st0.checked && st0.disabled && /не задавался/.test(st0.note), JSON.stringify(st0));

  // ---- 1. отбор в рабочем месте «Модель» ----
  const { label, snap } = await v2ExcludeFirstStatus(b, openScreen);
  check("снимок отбора: снято значение «Статус»", snap.objectId === 1 && snap.elementIds.length < snap.total, `«${label}»: ${snap.elementIds.length} из ${snap.total}`);

  // ---- 2. отчёт без галочки (по умолчанию выключена, как в V1) ----
  let from = b.requests.length;
  await openContracting(b);
  let req = await waitReq(b, EP, from);
  const R0 = await responseJson(b, req);
  const st1 = await b.eval(`({checked: document.getElementById('rd-use-filter').checked, disabled: document.getElementById('rd-use-filter').disabled, note: document.getElementById('rd-filter-note').textContent})`);
  check("V2: со снимком галочка доступна, по умолчанию выключена (как в V1), рядом — чей отбор", !st1.checked && !st1.disabled && /Модель/.test(st1.note) && /показано/.test(st1.note), st1.note);
  check("V2: без галочки запрос без element_ids, ответ без element_filter, «Итого по объекту»", !("element_ids" in body(req)) && !R0.element_filter && (await rdText(b)).includes("Итого по объекту"), `марок ${R0.rows.length}, потребность ${R0.totals.need}`);

  // ---- 3. включить галочку настоящим щелчком ----
  from = b.requests.length;
  await clickEl(b, `document.getElementById('rd-use-filter')`);
  req = await waitReq(b, EP, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cs-tbl') && document.getElementById('rd-use-filter')?.checked`, 30000);
  await sleep(300);
  const R1 = await responseJson(b, req);
  const ids = body(req).element_ids || [];
  check("V2: щелчок по галочке — перезапрос с element_ids = снимку «Модели»", setEq(ids, snap.elementIds), `${ids.length} id`);
  const expNeed = sql1(S.db, `SELECT count(*) FROM elements WHERE object_id=1 AND is_current=1 AND mark IS NOT NULL AND trim(mark)<>'' AND id IN (${ids.join(",")})`);
  check("V2: сервер сузил отчёт — потребность = изделиям отбора с маркой (прямой SQL)", R1.totals.need === expNeed && R1.totals.need < R0.totals.need && R1.element_filter?.elements === expNeed, `с отбором ${R1.totals.need} (SQL ${expNeed}), без отбора ${R0.totals.need}; марок ${R1.rows.length} из ${R0.rows.length}`);
  const txt1 = await rdText(b);
  check("V2: на экране «Итого по отбору», строка «Учтён фильтр схемы», число марок и итоги — из ответа", txt1.includes("Итого по отбору") && txt1.includes("Учтён фильтр схемы") && txt1.includes(`Марок: ${R1.rows.length}`) && txt1.includes(`потребность ${numRu(R1.totals.need)}, законтрактовано ${numRu(R1.totals.contracted)}, дефицит ${numRu(R1.totals.deficit)}`), `Марок: ${R1.rows.length}; потребность ${R1.totals.need}, законтрактовано ${R1.totals.contracted}, дефицит ${R1.totals.deficit}`);
  await b.shot(`${SHOTS}/v2-filtered.png`);

  // ---- 4. масштаб при включённом отборе (буква «П» с клавиатуры до «По неделям») ----
  const ready = `!!document.querySelector('#rd-report table.v2-cs-tbl') && !/Загрузка/.test(document.querySelector('#rd-body')?.textContent||'')`;
  from = b.requests.length;
  await chooseValue(b, "Масштаб", "П", "week", ready);
  req = b.requests.slice(from).filter((r) => EP.test(r.url)).pop();
  const Rw = await responseJson(b, req);
  check("V2: смена масштаба при отборе — в запросе и scale=week, и те же element_ids; итоги те же", body(req).scale === "week" && setEq(body(req).element_ids || [], ids) && Rw.totals.need === R1.totals.need && Rw.scale === "week", `периодов ${Rw.periods.length}`);
  await chooseValue(b, "Масштаб", "П", "month", ready);

  // ---- 5. снять галочку — прежний отчёт ----
  from = b.requests.length;
  await clickEl(b, `document.getElementById('rd-use-filter')`);
  req = await waitReq(b, EP, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cs-tbl') && !document.getElementById('rd-use-filter')?.checked`, 30000);
  const R0b = await responseJson(b, req);
  check("V2: снятая галочка — запрос без element_ids, ответ побайтово как до отбора", !("element_ids" in body(req)) && canon(R0b) === canon(R0));

  // ---- 6. САМ V1 на том же сервере и том же отборе ----
  await v1Goto(b);
  const v1ids = await v1ExcludeStatus(b, label);
  check("V1: тот же отбор (снято то же значение «Статус») даёт тот же набор id, что снимок V2", setEq(v1ids, snap.elementIds), `${v1ids.length} id`);
  await v1OpenReport(b, "contracting");
  const v1noFilter = await b.eval(`({checked: document.getElementById('report-use-filter').checked, data: reportData})`);
  check("V1: галочка по умолчанию снята, ответ = V2 без отбора", !v1noFilter.checked && canon(v1noFilter.data) === canon(R0));
  from = b.requests.length;
  await clickEl(b, `document.getElementById('report-use-filter')`);
  req = await waitReq(b, EP, from);
  await b.waitFor(`reportData && reportData.element_filter && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  await sleep(300);
  const v1F = await b.eval(`reportData`);
  check("V1: галочка теперь работает — V1 шлёт element_ids (тот же набор), сервер их учитывает", setEq(body(req).element_ids || [], ids) && v1F.totals.need === R1.totals.need, `V1 потребность ${v1F.totals.need}`);
  check("V1 = V2 при одном отборе: ответ сервера целиком", canon(v1F) === canon(R1));
  const v1Dom = await b.eval(`({total: document.querySelector('.cs-table tr.cs-total td')?.textContent.trim(), warn: document.querySelector('#report-body .dyn-warn')?.textContent || '', line: document.getElementById('report-status-line').textContent})`);
  check("V1: «Итого по отбору», строка «Учтён фильтр схемы» над таблицей, строка состояния по отбору", v1Dom.total === "Итого по отбору" && v1Dom.warn.includes("Учтён фильтр схемы") && v1Dom.line.includes(`Марок: ${R1.rows.length}. Потребность: ${R1.totals.need}`), v1Dom.line);
  await b.shot(`${SHOTS}/v1-filtered.png`);

  // ---- 7. V2: снимок ЧУЖОГО объекта не применяется ----
  await b.goto(`${S.base}/v2`, 800);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 20000);
  await openContracting(b);
  // список объектов шапки заполняется асинхронно после входа на страницу — ждём, что объект 2 в нём есть
  await b.waitFor(`[...(document.querySelector('#v2-object')?.options||[])].some(o=>o.value==='2')`, 20000);
  // Пока оболочка ещё занята переходом (navBusy), смена объекта намеренно отклоняется и список возвращается к прежнему
  // значению — тогда повтор, как сделал бы человек, увидевший в шапке прежний объект.
  from = b.requests.length;
  let switched = false;
  for (let i = 0; i < 3 && !switched; i++) {
    await setObject(b, 2);
    await sleep(800);
    switched = await b.eval(`document.querySelector('#v2-object').value === '2' && /Объект-2/.test(document.getElementById('v2-object-btn')?.textContent||'')`);
  }
  check("V2: переключение на объект 2 в шапке", switched);
  await waitReq(b, EP, from);
  await b.waitFor(`!!document.getElementById('rd-use-filter') && !/Загрузка/.test(document.querySelector('#rd-body')?.textContent||'')`, 30000);
  await sleep(300);
  const st2 = await b.eval(`({checked: document.getElementById('rd-use-filter').checked, disabled: document.getElementById('rd-use-filter').disabled, note: document.getElementById('rd-filter-note').textContent})`);
  check("V2, объект 2: галочка снята и недоступна, рядом — «отбор относится к другому объекту»", !st2.checked && st2.disabled && /друго/.test(st2.note), st2.note);
  from = b.requests.length;
  await clickEl(b, `document.getElementById('rd-refresh')`);
  req = await waitReq(b, EP, from);
  check("V2, объект 2: в запрос не ушли id объекта 1", body(req).object_id === 2 && !("element_ids" in body(req)), JSON.stringify(body(req)));
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
