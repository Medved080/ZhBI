// Совместимость с V1 на ТОМ ЖЕ backend: «Динамика» и «Аналитическая справка» показывают ОДНИ И ТЕ ЖЕ числа в V1
// (модальный отчёт, app.js) и в V2 (read-screen.js/reports.js) для одного объекта. Настоящий backend (копия
// обезличенной БД), настоящий вход формой, реальный переход между V1 (`/`) и V2 (`/v2`) в одной сессии (общая cookie).
// Запуск: node scripts/charts_verify/chk_v1_compat.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8275;
const S = await startServer(PORT, `${SP}/charts_compat`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_compat_shots` });

  // ---- V1: отчёт «Динамика» ---- (reportData — `let` верхнего уровня классического скрипта: лексический глобал,
  // а НЕ свойство window — ждём голым идентификатором, не window.reportData)
  await b.goto(`${S.base}/`, 800);
  await b.waitFor(`typeof switchObject === "function"`, 15000);
  await b.eval(`(async()=>{ await switchObject(1); })()`);
  await b.waitFor(`document.getElementById("menu-report-dynamics") && state.objectId === 1`, 15000);
  // Кнопка отчёта лежит в скрытом бургер-меню V1 (offsetParent=false до раскрытия) — здесь снимаем ЭТАЛОННЫЕ числа
  // из уже проверенного V1, программный клик достаточен (реальные события мыши обязательны для операций ПОД
  // проверкой в V2, не для чтения образца в неизменной V1).
  await b.eval(`document.getElementById("menu-report-dynamics").click()`);
  await b.waitFor(`typeof reportData !== "undefined" && !!reportData && !!reportData.montage`, 15000);
  await sleep(300);
  const v1Dyn = await b.eval(`({ montageFact: reportData.montage.cumulative.fact, montagePlan: reportData.montage.cumulative.plan, deliveryFact: reportData.delivery.cumulative.fact, weeks: reportData.weeks.length, reportDate: reportData.report_date })`);
  console.log("V1 dynamics:", v1Dyn);

  // ---- V2: тот же отчёт, тот же объект ----
  await b.goto(`${S.base}/v2`, 800);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await openScreen(b, "report-dynamics", `document.querySelector('#rd-report svg')`);
  await sleep(400);
  // V2 форматирует числа общим правилом toLocaleString("ru-RU") (везде в отчётах V2, не только здесь) — разделитель
  // тысяч NBSP; сверяем ЗНАЧЕНИЕ, а не буквальную подстроку с пробелом.
  const v2DynText = await b.eval(`(document.querySelector('#rd-report')?.textContent || "").replace(/\\u00a0/g, "")`);
  const v2Weeks = await b.eval(`document.querySelector('#rd-report svg')?.dataset ? document.querySelectorAll('#rd-report svg text').length : 0`);
  check("«Динамика»: факт монтажа нарастающим итогом совпадает V1/V2", v2DynText.includes(`факт ${v1Dyn.montageFact}`), `V1=${v1Dyn.montageFact}; в тексте V2 есть «факт ${v1Dyn.montageFact}»? ${v2DynText.includes(`факт ${v1Dyn.montageFact}`)}`);
  check("«Динамика»: план монтажа нарастающим итогом совпадает V1/V2", v2DynText.includes(`план ${v1Dyn.montagePlan}`), `V1=${v1Dyn.montagePlan}`);
  check("«Динамика»: факт поставки нарастающим итогом совпадает V1/V2", v2DynText.includes(`факт ${v1Dyn.deliveryFact}`), `V1=${v1Dyn.deliveryFact}`);
  check("«Динамика»: график V2 построен (есть подписи недель)", v2Weeks > 0, `недель на графике: ${v2Weeks}`);

  // ---- V1: «Аналитическая справка» ----
  await b.goto(`${S.base}/`, 800);
  await b.waitFor(`typeof switchObject === "function"`, 15000);
  await b.eval(`(async()=>{ await switchObject(1); })()`);
  await b.waitFor(`document.getElementById("menu-report-analytics") && state.objectId === 1`, 15000);
  await b.eval(`document.getElementById("menu-report-analytics").click()`);
  await b.waitFor(`typeof reportData !== "undefined" && !!reportData && !!reportData.tiles`, 15000);
  await sleep(300);
  const v1An = await b.eval(`({ tiles: reportData.tiles.map(t=>({label:t.label, value:t.value})), dynWeeks: reportData.dynamics.weeks.length, need: reportData.dynamics.series.need, contracted: reportData.dynamics.series.contracted })`);
  console.log("V1 analytics tiles:", v1An.tiles, "dynWeeks:", v1An.dynWeeks);

  // ---- V2: тот же отчёт ----
  await b.goto(`${S.base}/v2`, 800);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await openScreen(b, "report-analytics", `document.querySelector('.v2-tiles')`);
  await sleep(400);
  const v2Tiles = await b.eval(`[...document.querySelectorAll('.v2-tile')].map(t=>({value: t.querySelector('.v2-tile-value')?.textContent, label: t.children[1]?.textContent}))`);
  let tilesMatch = v1An.tiles.length > 0 && v1An.tiles.every((t) => v2Tiles.some((v) => v.label === t.label && v.value === String(t.value)));
  check("«Аналитическая справка»: плитки (значения) совпадают V1/V2", tilesMatch, JSON.stringify({ v1: v1An.tiles, v2: v2Tiles }));
  const v2AnLines = await b.eval(`(()=>{const hs=[...document.querySelectorAll('.v2-report-h')]; const h=hs.find(x=>x.textContent.includes('Динамика обеспечения')); const svg=h?.parentElement?.querySelector('svg'); return svg ? svg.querySelectorAll('polyline').length : 0;})()`);
  check("«Аналитическая справка»: график V2 построен (4 кривые)", v2AnLines === 4, `кривых: ${v2AnLines}`);

  await b.shot(`${SP}/charts_compat_shots/compat.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
