// Проверка «Учитывать текущий фильтр схемы» на «Графике поставки» (reports-exchange.js) — тот же общий механизм
// read-screen.js, что и у «Статуса комплектации»/«Статуса монтажа»/«Динамики», просто другой renderer. Настоящий
// backend, настоящий вход. Запуск: node scripts/charts_verify/chk_filter_delivery.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8273;
const S = await startServer(PORT, `${SP}/charts_filter_delivery`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_filter_delivery_shots` });
  await openScreen(b, "ws-model", `document.querySelector('#ws-panel-body')`);
  await b.waitFor(`(document.querySelector('#ws-status')?.textContent||'').includes('Показано')`, 20000);
  await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()==='Фильтры')?.click()`);
  await b.waitFor(`!!document.querySelector('input[data-key="status"]')`, 15000);
  await sleep(300);
  const cbRect = await b.eval(`(()=>{const cb=document.querySelector('input[data-key="status"]'); cb.scrollIntoView({block:'center'}); const r=cb.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await b.click(cbRect.x, cbRect.y);
  await sleep(700);
  const snap = await b.eval(`JSON.parse(sessionStorage.getItem('v2.schemeFilterSnapshot')||'null')`);
  check("снимок отбора создан", !!snap && snap.elementIds.length < snap.total);

  await openScreen(b, "report-delivery", `document.querySelector('#rd-use-filter')`);
  await sleep(500);
  const cbState = await b.eval(`(()=>{const c=document.getElementById('rd-use-filter'); return c ? {checked:c.checked, disabled:c.disabled} : null;})()`);
  check("«График поставки»: галочка на месте, по умолчанию не включена, доступна", !!cbState && !cbState.checked && !cbState.disabled, JSON.stringify(cbState));
  const reqBefore = b.requests.length;
  await b.eval(`document.getElementById('rd-use-filter').click()`);
  await b.waitFor(`(()=>{const r=[...document.querySelectorAll('*')].length; return true;})()`, 2000).catch(() => {});
  await sleep(700);
  const req = b.requests.slice(reqBefore).find((r) => /\/reports\/delivery-schedule$/.test(r.url));
  let hasIds = false;
  try { hasIds = Array.isArray(JSON.parse(req?.body || "{}").element_ids); } catch { /* */ }
  check("включение галочки уходит в тело запроса element_ids", hasIds, JSON.stringify(req?.body?.slice(0, 150)));

  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
