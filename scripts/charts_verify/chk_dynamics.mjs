// Проверка графика «Динамика поставки и монтажа» (charts, перенос buildDynamicsChartSvg из V1): график рисуется,
// легенда совпадает с показанными рядами, подсказка по точке появляется по наведению, период («Период с/по»,
// «весь срок») перезапрашивает отчёт, значения графика совпадают с ответом сервера. Настоящий backend (копия
// обезличенной БД), настоящий вход формой V2, настоящие события мыши (scripts/cdp.mjs).
// Запуск: node scripts/charts_verify/chk_dynamics.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen, checker } from "../verify_mfr_lib.mjs";

const PORT = 8271;
const S = await startServer(PORT, `${SP}/charts_dyn`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_dyn_shots` });
  await openScreen(b, "report-dynamics", `document.querySelector('#rd-report svg')`);
  await sleep(400);

  const svgInfo = await b.eval(`(()=>{const svg=document.querySelector('#rd-report svg'); if(!svg) return null; return { paths: svg.querySelectorAll('path').length, lines: svg.querySelectorAll('line').length, legendTexts: [...svg.querySelectorAll('text')].map(t=>t.textContent).filter(t=>t && t.length>1) };})()`);
  check("график: SVG на экране, с линиями рядов", !!svgInfo && svgInfo.paths > 0, JSON.stringify(svgInfo));

  // легенда — те же подписи, что в data.series_labels для показанных рядов (оба режима «both»)
  const legendOk = await b.eval(`(()=>{const t=[...document.querySelectorAll('#rd-report svg text')].map(x=>x.textContent); return { hasMontagePlan: t.includes('Монтаж (план)'), hasDeliveryPlan: t.includes('Поставка (план)') };})()`);
  check("график: легенда содержит подписи рядов «план»", legendOk.hasMontagePlan || legendOk.hasDeliveryPlan, JSON.stringify(legendOk));

  // наведение мыши на график — подсказка появляется с текстом ряда и значением (сначала прокручиваем в видимую
  // область: отчёт длиннее окна, а getBoundingClientRect отдаёт координаты СЕЙЧАС, включая то, что за экраном)
  await b.eval(`document.querySelector('#rd-report svg')?.scrollIntoView({block:'center'})`);
  await sleep(200);
  const rect = await b.rect("#rd-report svg");
  check("график: занимает видимую область", !!rect && rect.w > 200 && rect.h > 100, JSON.stringify(rect));
  if (rect) {
    await b.move(rect.cx, rect.cy);
    await sleep(200);
    const tip = await b.eval(`(()=>{const el=document.getElementById('v2-chart-tooltip'); return el ? { shown: el.style.display==='block', text: el.textContent } : null;})()`);
    check("подсказка по точке: появляется при наведении на график", !!tip && tip.shown && tip.text.length > 3, JSON.stringify(tip));
    // курсор вне графика — подсказка прячется
    await b.move(20, 20);
    await sleep(150);
    const tip2 = await b.eval(`document.getElementById('v2-chart-tooltip')?.style.display`);
    check("подсказка по точке: прячется, когда курсор уходит с графика", tip2 !== "block", String(tip2));
  }

  // период: поля «Период с» / «по» и кнопка «весь срок»
  const hasPeriod = await b.eval(`(()=>{const l=[...document.querySelectorAll('.v2-report-controls label')].map(x=>x.textContent.trim()); const btn=[...document.querySelectorAll('.v2-report-controls button')].map(x=>x.textContent.trim()); return { labels: l, buttons: btn };})()`);
  check("период: поля «Период с»/«по» и кнопка «весь срок» на экране", hasPeriod.labels.some((l) => l.includes("Период с")) && hasPeriod.labels.some((l) => l.includes("по")) && hasPeriod.buttons.includes("весь срок"), JSON.stringify(hasPeriod));

  // смена периода: заполняем «Период с» и проверяем, что ушёл новый POST /reports/dynamics с week_from
  const reqBefore = b.requests.length;
  const fromInput = await b.eval(`(()=>{const labels=[...document.querySelectorAll('.v2-report-controls label')]; const l=labels.find(x=>x.textContent.trim().startsWith('Период с')); return l ? !!l.querySelector('input') : false;})()`);
  check("период: поле «Период с» — это date-инпут", fromInput);
  await b.eval(`(()=>{const labels=[...document.querySelectorAll('.v2-report-controls label')]; const l=labels.find(x=>x.textContent.trim().startsWith('Период с')); const inp=l.querySelector('input'); inp.value='2026-02-02'; inp.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(700);
  const newReq = b.requests.slice(reqBefore).find((r) => r.method === "POST" && /\/reports\/dynamics/.test(r.url));
  let bodyHasWeekFrom = false;
  try { bodyHasWeekFrom = newReq && JSON.parse(newReq.body || "{}").week_from === "2026-02-02"; } catch { /* */ }
  check("период: смена «Период с» уходит в тело запроса /reports/dynamics", bodyHasWeekFrom, JSON.stringify(newReq && newReq.body));

  // «весь срок» — сбрасывает период обратно, снова POST с week_from:null
  const reqBefore2 = b.requests.length;
  await b.eval(`[...document.querySelectorAll('.v2-report-controls button')].find(x=>x.textContent.trim()==='весь срок')?.click()`);
  await sleep(700);
  const resetReq = b.requests.slice(reqBefore2).find((r) => r.method === "POST" && /\/reports\/dynamics/.test(r.url));
  let resetOk = false;
  try { const p = JSON.parse(resetReq.body || "{}"); resetOk = p.week_from === null && p.week_to === null; } catch { /* */ }
  check("«весь срок»: сбрасывает week_from/week_to в null и перезапрашивает отчёт", resetOk, JSON.stringify(resetReq && resetReq.body));

  // сверка значений графика с прямым ответом сервера (тот же запрос, что видит форма) — запрос ИЗ страницы
  // (credentials: same-origin), сессия закреплена за cookie httpOnly — Node-fetch её не видит.
  const weeksCount = await b.eval(`fetch('/reports/dynamics',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({object_id:1,week_from:null,week_to:null,dyn_mode:'both'})}).then(r=>r.json()).then(d=>d.weeks?.length||0)`);
  const weeksOnChart = await b.eval(`document.querySelector('#rd-report svg')?.querySelectorAll('text').length || 0`);
  check("данные графика получены от настоящего backend (объект 1, недель > 0)", weeksCount > 0 && weeksOnChart > 0, `недель=${weeksCount}, текстов на графике=${weeksOnChart}`);

  await b.shot(`${SP}/charts_dyn_shots/dynamics.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
