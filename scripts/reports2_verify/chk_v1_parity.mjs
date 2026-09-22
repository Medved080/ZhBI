// «Статус комплектации», сводная таблица: V2 против САМОГО V1 на одном сервере, в одном сеансе (общая cookie).
// Три случая: (A) настройки по умолчанию; (B) другие шкала/шаг/уровни; (C) с отбором фильтром схемы — одно и то же
// значение «Статус» снимается НАСТОЯЩИМ щелчком и в рабочем месте V2 «Модель», и в панели фильтров V1; галочка
// «Учитывать текущий фильтр схемы» включена по умолчанию в обоих. Сравниваются: ответы сервера, которые получили
// экраны (JSON целиком), видимые строки таблиц (каждая ячейка), наборы id отбора.
// Настоящий backend (копия обезличенной БД), настоящий вход формой V2. Запуск: node scripts/reports2_verify/chk_v1_parity.mjs
import { startServer, stopServer, check, summary, sleep, SP, hardGoto, chooseByLabel, clickEl, responseJson, waitReq, v2ExcludeFirstStatus, v1ExcludeStatus, v1OpenReport } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8342;
const S = await startServer(PORT, `${SP}/r2_parity`);
const SHOTS = `${SP}/r2_parity_shots`;
const norm = (s) => String(s ?? "").replace(/[\s ▸▾]/g, "");
const body = (r) => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };
// ответ сервера без полей, зависящих только от момента запроса (таких у сводной нет — сравнивается целиком)
const canon = (d) => JSON.stringify(d);
const v2Rows = (b) => b.eval(`[...document.querySelectorAll('#rd-report table.v2-cmp-pivot tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent))`);
const v2Head = (b) => b.eval(`[...document.querySelectorAll('#rd-report table.v2-cmp-pivot thead th')].map(th=>th.textContent)`);
const v1Rows = (b) => b.eval(`[...document.querySelectorAll('#cmp-pivot-table tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent))`);
const v1Head = (b) => b.eval(`[...document.querySelectorAll('#cmp-pivot-table thead th')].map(th=>th.textContent)`);
const sameGrid = (a, b) => a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((c, j) => norm(c) === norm(b[i][j])));

async function v2Pivot(b) {
  await openScreen(b, "report-completion", `!!document.querySelector('#rd-report table.v2-cmp-pivot') || /Позиций/.test(document.querySelector('#rd-report')?.textContent||'')`);
  if (!(await b.eval(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`))) {
    await chooseByLabel(b, "Вид", "С");
    await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  }
}
async function v1Goto(b) {
  // Изредка (1 из ~3 прогонов) V1 после перехода из V2 не доходит до загрузки схемы за 30 с — природа не выяснена
  // (по видимости, отменённая навигация безголового Chrome); тогда одна повторная загрузка страницы, с записью в журнал.
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await b.goto(`${S.base}/`, 800); else await hardGoto(b, `${S.base}/`, 1200);
    try {
      await b.waitFor(`typeof switchObject === "function"`, 20000);
      await b.eval(`(async()=>{ await switchObject(1); })()`);
      await b.waitFor(`state.objectId === 1 && state.elements.length > 0 && document.getElementById("menu-report-completion")`, 30000);
      break;
    } catch (e) {
      console.log(`V1 не готов (попытка ${attempt}):`, await b.eval(`({href: location.href, st: typeof state !== 'undefined' ? {o: state.objectId, n: state.elements.length} : null})`).catch(() => null));
      if (attempt >= 2) throw e;
    }
  }
  await sleep(300);
}
const lastReq = (b, re) => b.requests.filter((r) => re.test(r.url) && r.status !== undefined).pop();

let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: SHOTS });

  // ================= (A) по умолчанию =================
  await v2Pivot(b);
  let v2req = lastReq(b, /\/reports\/completion$/);
  const v2A = await responseJson(b, v2req);
  const v2HeadA = await v2Head(b), v2RowsA = await v2Rows(b);
  await v1Goto(b);
  await v1OpenReport(b, "completion");   // вид — из localStorage, который только что записал V2 (общий ключ)
  const v1A = await b.eval(`reportData`);
  check("(A) V1 открылся сразу в сводной — вид V2 и V1 общий (zhbi_completion_view)", v1A.view === "pivot" && (await b.eval(`document.getElementById('cmp-view').value`)) === "pivot");
  const v1reqA = lastReq(b, /\/reports\/completion$/);
  check("(A) ответ сервера V1 и V2 совпал целиком (строки, колонки, итоги, подпись)", canon(v1A) === canon(v2A), `итого V1 ${v1A.total.total}, V2 ${v2A.total.total}; колонок ${v1A.columns.length}/${v2A.columns.length}; V1 шлёт element_ids: ${Array.isArray(body(v1reqA).element_ids) ? body(v1reqA).element_ids.length : "нет"}`);
  const v1HeadA = await v1Head(b), v1RowsA = await v1Rows(b);
  check("(A) шапка таблицы V1 = V2", sameGrid([v1HeadA], [v2HeadA]), `${v1HeadA.length} колонок`);
  check("(A) каждая видимая строка (подпись и все числа) V1 = V2, та же свёртка", sameGrid(v1RowsA, v2RowsA), `строк V1 ${v1RowsA.length}, V2 ${v2RowsA.length}`);
  check("(A) строка состояния: V1 «Изделий: N» = V2", norm(await b.eval(`document.getElementById('report-status-line').textContent`)) === `Изделий:${v2A.total.total}`);
  await b.shot(`${SHOTS}/v1-pivot.png`);

  // ================= (B) шкала «Требуемая», шаг «Месяц», уровни: Кран включён, Марка выше Подтипа =================
  await b.goto(`${S.base}/v2`, 800);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 20000);
  await v2Pivot(b);
  let from = b.requests.length;
  await chooseByLabel(b, "Колонки", "Т");
  await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`document.querySelector('select[data-param="date_scale"]')?.value==='need' && !!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  from = b.requests.length;
  await chooseByLabel(b, "Шаг", "М");
  await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`document.querySelector('select[data-param="step"]')?.value==='month' && !!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-group-toggle="crane"]')`);
  await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot') && document.querySelector('[data-group-toggle="crane"]')?.checked`, 30000);
  from = b.requests.length;
  await clickEl(b, `document.querySelector('[data-group-move="mark"][data-dir="-1"]')`);
  v2req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  await sleep(300);
  const v2B = await responseJson(b, v2req);
  const v2RowsB = await v2Rows(b);
  check("(B) V2: настройки ушли в запрос", body(v2req).date_scale === "need" && body(v2req).step === "month" && body(v2req).group_by.join() === "counterparty,agreement,specification,type,mark,subtype,crane", JSON.stringify(body(v2req).group_by));
  await v1Goto(b);
  // уровни V1 читает из того же localStorage при загрузке страницы; шкалу и шаг V1 не запоминает — задаются в его форме
  await b.eval(`document.getElementById("menu-report-completion").click()`);
  await b.waitFor(`typeof reportData !== "undefined" && reportData && reportData.view === 'pivot'`, 30000);
  await b.eval(`(()=>{const s=document.getElementById('cmp-scale'); s.value='need'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`reportData && reportData.scale === 'need' && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  await b.eval(`(()=>{const s=document.getElementById('cmp-step'); s.value='month'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`reportData && reportData.step === 'month' && reportData.scale === 'need' && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  await sleep(300);
  const v1B = await b.eval(`reportData`);
  check("(B) V1 взял уровни группировки, выбранные в V2 (общий ключ zhbi_completion_pivot_groups)", v1B.group_by.join() === "counterparty,agreement,specification,type,mark,subtype,crane", v1B.group_by.join(" → "));
  check("(B) ответ сервера V1 и V2 совпал целиком", canon(v1B) === canon(v2B), `итого ${v1B.total.total}/${v2B.total.total}; колонок ${v1B.columns.length}/${v2B.columns.length}`);
  const v1RowsB = await v1Rows(b);
  check("(B) каждая видимая строка V1 = V2", sameGrid(v1RowsB, v2RowsB), `строк ${v1RowsB.length}/${v2RowsB.length}`);

  // ================= (C) отбор фильтром схемы (галочка включена по умолчанию у обоих) =================
  await b.goto(`${S.base}/v2`, 800);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 20000);
  const { label, snap } = await v2ExcludeFirstStatus(b, openScreen);
  console.log(`снято значение «${label}»: показано ${snap.shown} из ${snap.total}`);
  await v2Pivot(b);
  await b.waitFor(`document.getElementById('rd-use-filter')?.checked`, 15000);
  from = b.requests.length;
  await clickEl(b, `document.getElementById('rd-refresh')`);
  v2req = await waitReq(b, /\/reports\/completion$/, from);
  await b.waitFor(`!!document.querySelector('#rd-report table.v2-cmp-pivot')`, 30000);
  await sleep(300);
  const v2C = await responseJson(b, v2req);
  const v2ids = body(v2req).element_ids || [];
  const v2RowsC = await v2Rows(b);
  check("(C) V2: галочка включена по умолчанию, в запросе element_ids из снимка", v2ids.length === snap.elementIds.length && v2ids.length < snap.total, `${v2ids.length} из ${snap.total}`);
  check("(C) V2: сводная сузилась (изделий меньше, чем без отбора)", v2C.total.total < v2B.total.total || v2C.total.total < v2A.total.total, `${v2C.total.total} < ${v2A.total.total}`);
  await v1Goto(b);
  const v1ids = await v1ExcludeStatus(b, label);
  await b.eval(`document.getElementById("menu-report-completion").click()`);
  await b.waitFor(`typeof reportData !== "undefined" && reportData && reportData.view === 'pivot' && document.getElementById('report-use-filter').checked && !/Построение/.test(document.getElementById('report-status-line').textContent)`, 30000);
  // шкала и шаг после новой загрузки страницы — по умолчанию и в V1, и в V2 (не запоминаются ни там, ни там)
  check("(C) шкала и шаг по умолчанию у обоих, уровни — общие из (B)", (await b.eval(`reportData.scale`)) === v2C.scale && (await b.eval(`reportData.step`)) === v2C.step && (await b.eval(`reportData.group_by.join()`)) === v2C.group_by.join(), `${v2C.scale}/${v2C.step}`);
  const v1reqC = lastReq(b, /\/reports\/completion$/);
  const v1sent = body(v1reqC).element_ids || [];
  const setEq = (x, y) => x.length === y.length && new Set(x).size === new Set([...x, ...y]).size;
  check("(C) один и тот же отбор: набор id V1 (state.elements ∩ фильтр) = снимку V2", setEq(v1sent, v2ids) && setEq(v1ids, v2ids), `V1 ${v1sent.length}, V2 ${v2ids.length}`);
  const v1C = await b.eval(`reportData`);
  check("(C) ответ сервера с отбором V1 = V2 целиком", canon(v1C) === canon(v2C), `итого ${v1C.total.total}/${v2C.total.total}`);
  const v1RowsC = await v1Rows(b);
  check("(C) каждая видимая строка V1 = V2 при одном отборе", sameGrid(v1RowsC, v2RowsC), `строк ${v1RowsC.length}/${v2RowsC.length}`);
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
