// Проверка пункта 2 задания gaps2: GET /objects/{id}/blocks/track-progress числился «только переход в V1» в матрице
// (Docs/v2-progress/gaps.md), но фактически уже вызывается ИЗ V2 — рабочее место «Модель МФР» (workspace.js) держит сцену V1
// в кадре embed=scene (сознательная архитектура, НЕ «переход в V1»: своя шапка/панели V2, изменения — только через api.js/write-gate.js
// оболочки), а вкладка «Вид» правой панели (mfr-block-panel.js: viewHtml/bind) — это НАСТОЯЩИЙ элемент управления V2, который переключает
// доску «Шахматка» в режим «по срокам» командой моста mfrChess; кадр (app.js) в ответ сам делает GET .../track-progress.
// Здесь — живой прогон: вход, объект с блоками МФР, экран «Модель МФР», выбор доски, переключение на «по срокам», проверка сетевого
// запроса И что раскраска/легенда сменились на "по срокам".
import { session, openScreen, sleep } from "./verify_mfr_lib.mjs";

const base = process.argv[2] || "http://127.0.0.1:8250";
const objectId = Number(process.argv[3] || 4);

(async () => {
  const b = await session({ base, user: "admin", objectId });
  await openScreen(b, "ws-mfr", `document.querySelector('.v2-ws')`);
  await sleep(4000);
  // вкладка «Вид»
  const hasViewTab = await b.eval(`!!document.querySelector('[data-tab="view"], [data-ws-tab="view"]') || [...document.querySelectorAll('button,a')].some(x=>x.textContent.trim()==='Вид')`);
  await b.eval(`(()=>{const t=[...document.querySelectorAll('button,a,[role=tab]')].find(x=>x.textContent.trim()==='Вид'); if(t) t.click();})()`);
  await sleep(400);
  const trackSelectFound = await b.eval(`!!document.querySelector('[data-mbp-c="track"]')`);
  console.log("вкладка «Вид» найдена:", hasViewTab, "| select доски найден:", trackSelectFound);
  if (!trackSelectFound) { console.log("ПРОВАЛ: панель «Шахматка» не отрисована — переключатель режима не найден"); process.exit(1); }
  // выбрать первую доску (если есть)
  const trackVal = await b.eval(`(()=>{const s=document.querySelector('[data-mbp-c="track"]'); const opt=[...s.options].find(o=>o.value); if(!opt) return null; s.value=opt.value; s.dispatchEvent(new Event('change',{bubbles:true})); return opt.value;})()`);
  console.log("выбранная доска:", trackVal);
  if (!trackVal) {
    console.log("consoleLog хвост:", b.consoleLog.slice(-10));
    console.log("exceptions:", b.exceptions.slice(-5));
    console.log("select options count:", await b.eval(`document.querySelector('[data-mbp-c="track"]')?.options.length`));
    console.log("ПРОВАЛ: у объекта нет ни одной доски (трека планирования) — печать пуста, но экран должен показать список"); process.exit(1);
  }
  await sleep(800);
  // переключить режим на "по срокам"
  const switched = await b.eval(`(()=>{const r=document.querySelector('input[name="mbp-mode"][value="deadline"]'); if(!r) return false; r.checked=true; r.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  console.log("радио «по срокам» переключено:", switched);
  await sleep(1200);
  const hit = b.requests.filter((r) => /\/blocks\/track-progress/.test(r.url));
  console.log("запросов к .../blocks/track-progress:", hit.length, hit.map((r) => `${r.method} ${r.status}`));
  const legend = await b.eval(`document.querySelector('.mfr-lgs')?.innerText || ""`);
  console.log("легенда после переключения:", JSON.stringify(legend));
  const ok = hit.length > 0 && hit.every((r) => r.status === 200) && /в графике|отстаёт|просрочен/.test(legend);
  console.log(ok ? "ИТОГ: ПОДТВЕРЖДЕНО — V2 уже вызывает track-progress через встроенный движок" : "ИТОГ: НЕ подтверждено");
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
