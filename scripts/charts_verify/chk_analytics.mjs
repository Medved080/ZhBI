// Проверка графика «2.3. Динамика обеспечения» в «Аналитической справке» (charts, перенос anChartHtml из V1):
// четыре накопительные кривые, подсказка по точке, линия «дата справки». Настоящий backend, настоящий вход,
// настоящие события мыши (scripts/cdp.mjs). Запуск: node scripts/charts_verify/chk_analytics.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8274;
const S = await startServer(PORT, `${SP}/charts_an`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_an_shots` });
  await openScreen(b, "report-analytics", `document.querySelector('.v2-report-h')`);
  await b.waitFor(`[...document.querySelectorAll('.v2-report-h')].some(h=>h.textContent.includes('Динамика обеспечения'))`, 15000);
  await sleep(400);

  const info = await b.eval(`(()=>{const hs=[...document.querySelectorAll('.v2-report-h')]; const h=hs.find(x=>x.textContent.includes('Динамика обеспечения')); if(!h) return null; let n=h.nextElementSibling; const svg=n?.querySelector('svg'); return svg ? { found:true, lines: svg.querySelectorAll('polyline').length, texts:[...svg.querySelectorAll('text')].map(t=>t.textContent) } : { found:false };})()`);
  check("график «Динамика обеспечения»: заголовок и SVG с 4 кривыми на месте", info?.found && info.lines === 4, JSON.stringify(info));
  check("график: подпись «дата справки» (линия сегодня) на месте", info?.texts?.some((t) => t.includes("дата справки")), JSON.stringify(info?.texts));
  const legendText = await b.eval(`(()=>{const hs=[...document.querySelectorAll('.v2-report-h')]; const h=hs.find(x=>x.textContent.includes('Динамика обеспечения')); const p = h?.parentElement?.querySelector('.v2-chart-wrap p'); return p ? p.textContent : null;})()`);
  check("легенда текстом под графиком: Потребность/Законтрактовано/Поставлено/Смонтировано", !!legendText && ["Потребность", "Законтрактовано", "Поставлено", "Смонтировано"].every((w) => legendText.includes(w)), legendText);

  // наведение — подсказка (общий механизм chart-hover.js, уже проверен у «Динамики», здесь — что он же сработал на ВТОРОМ графике страницы)
  const box = await b.eval(`(()=>{const hs=[...document.querySelectorAll('.v2-report-h')]; const h=hs.find(x=>x.textContent.includes('Динамика обеспечения')); const svg=h?.parentElement?.querySelector('svg'); if(!svg) return null; svg.scrollIntoView({block:'center'}); return true;})()`);
  await sleep(200);
  const rect = await b.eval(`(()=>{const hs=[...document.querySelectorAll('.v2-report-h')]; const h=hs.find(x=>x.textContent.includes('Динамика обеспечения')); const svg=h?.parentElement?.querySelector('svg'); const r=svg.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};})()`);
  if (rect) {
    await b.move(rect.cx, rect.cy);
    await sleep(200);
    const tip = await b.eval(`(()=>{const el=document.getElementById('v2-chart-tooltip'); return el ? { shown: el.style.display==='block', text: el.textContent } : null;})()`);
    check("подсказка по точке: работает и на графике «Аналитической справки»", !!tip && tip.shown && tip.text.length > 3, JSON.stringify(tip));
  } else check("график «Аналитической справки» найден для наведения", false);

  await b.shot(`${SP}/charts_an_shots/analytics.png`);
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
