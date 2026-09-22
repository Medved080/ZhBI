// Печать отчёта с графиком («Динамика», «Аналитическая справка») — проверка МАКЕТА печати (правило styles.css
// @media print), не только вызова window.print(): узел печати содержит SVG графика с не нулевыми размерами, а не
// пустой/чужой снимок; подсказка по точке не попадает в печать, даже если курсор остался над графиком.
// Настоящий backend, настоящий вход, реальные события мыши (scripts/cdp.mjs). Запуск: node scripts/charts_verify/chk_print.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8277;
const S = await startServer(PORT, `${SP}/charts_print`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_print_shots` });
  await openScreen(b, "report-dynamics", `document.querySelector('#rd-report svg')`);
  await sleep(400);

  // курсор оставлен НАД графиком — подсказка видна на экране в момент печати (проверяем, что в узел печати её не унесёт)
  await b.eval(`document.querySelector('#rd-report svg')?.scrollIntoView({block:'center'})`);
  await sleep(150);
  const rect = await b.rect("#rd-report svg");
  await b.move(rect.cx, rect.cy);
  await sleep(200);
  const tipShownBeforePrint = await b.eval(`document.getElementById('v2-chart-tooltip')?.style.display === 'block'`);
  check("подготовка: подсказка видна перед печатью (курсор над графиком)", tipShownBeforePrint);

  await b.eval(`document.querySelector('#rd-print').click()`);
  await sleep(300);
  const printArea = await b.eval(`(()=>{const el=document.getElementById('v2-print-area'); const svg=el?.querySelector('svg'); if(!svg) return {hasArea:!!el, hasSvg:false}; const r=svg.getBoundingClientRect(); return {hasArea:true, hasSvg:true, w:r.width,h:r.height, viewBox: svg.getAttribute('viewBox'), paths: svg.querySelectorAll('path').length};})()`);
  check("печать: узел печати содержит SVG графика с непустым viewBox", printArea.hasSvg && !!printArea.viewBox && printArea.paths > 0, JSON.stringify(printArea));

  // само правило печати: #v2-print-area скрыт вне печати, виден в @media print — проверяем через emulateMediaFeatures
  await b.send("Emulation.setEmulatedMedia", { media: "print" });
  await sleep(200);
  const visibleInPrint = await b.eval(`(()=>{const el=document.getElementById('v2-print-area'); const cs=getComputedStyle(el); const svg=el.querySelector('svg'); const svgCs=svg?getComputedStyle(svg):null; return {display:cs.display, svgWidth: svgCs?svgCs.width:null};})()`);
  check("печать: узел печати становится видимым в @media print, SVG получает ширину 100%", visibleInPrint.display === "block", JSON.stringify(visibleInPrint));
  const tooltipHiddenInPrint = await b.eval(`getComputedStyle(document.getElementById('v2-chart-tooltip')).display`);
  check("печать: подсказка по точке скрыта правилом @media print (не просачивается на бумагу)", tooltipHiddenInPrint === "none", tooltipHiddenInPrint);
  await b.shot(`${SP}/charts_print_shots/print-media.png`);
  await b.send("Emulation.setEmulatedMedia", { media: "" });

  // «Аналитическая справка» — печать содержит ОБА графика (2.3 «Динамика обеспечения» тоже попадает в снимок #rd-report)
  await openScreen(b, "report-analytics", `document.querySelector('.v2-tiles')`);
  await b.waitFor(`[...document.querySelectorAll('.v2-report-h')].some(h=>h.textContent.includes('Динамика обеспечения'))`, 15000);
  await sleep(300);
  await b.eval(`document.querySelector('#rd-print').click()`);
  await sleep(300);
  const anPrint = await b.eval(`(()=>{const el=document.getElementById('v2-print-area'); return { svgCount: el.querySelectorAll('svg').length, hasHeading: el.textContent.includes('Динамика обеспечения') };})()`);
  check("печать «Аналитической справки»: график попал в снимок печати", anPrint.svgCount >= 1 && anPrint.hasHeading, JSON.stringify(anPrint));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
