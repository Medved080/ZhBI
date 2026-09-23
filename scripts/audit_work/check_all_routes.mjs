// Финальная проверка маршрутов V2 на настоящем backend и временной копии БД.
// Это проверка доступности/монтирования, а НЕ приёмка действий записи каждого экрана.
// Запуск: AUDIT_SP=/private/tmp/<отдельный-каталог> node scripts/audit_work/check_all_routes.mjs
import { readFileSync } from "node:fs";
import { startServer, stopServer, session, setObject, sleep, check, summary, ROOT } from "./lib.mjs";

const screens = JSON.parse(readFileSync(`${ROOT}/app/static/v2/screens.json`, "utf8")).screens
  .filter((s) => s.status === 5 && (!process.argv[2] || s.id === process.argv[2]));
const MFR = new Set(["ws-mfr", "chess-flat", "blocks", "fact-journal", "report-block-status",
  "report-block-schedule", "report-linear-track", "blk-bulk", "revit-import", "pdf-import", "mfr-colors"]);
const dir = `${process.env.AUDIT_SP || "/private/tmp"}/all_routes`;
const S = await startServer(8378, dir);
let b;
try {
  b = await session(S.base, "admin", { objectId: 1,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  for (const s of screens) {
    const objectId = MFR.has(s.id) ? 4 : 1;
    await setObject(b, objectId);
    const oldErrors = b.exceptions.length;
    const oldRequests = b.requests.length;
    try {
      await b.eval(`location.hash=${JSON.stringify(`#/${s.id}`)}`);
      await b.waitFor(`document.querySelector('#v2-head-section')?.textContent===${JSON.stringify(s.title)} &&
        (document.querySelector('#v2-content')?.children.length || 0)>0`, 30000, 200);
      if (s.id === "ws-mfr") {
        await b.waitFor(`document.querySelector('iframe.ws-frame')?.contentDocument?.querySelectorAll('#revit-plan-canvas rect[data-block-id]').length>0`, 120000, 300);
      } else if (s.impl === "workspace") {
        await b.waitFor(`(document.querySelector('#ws-status')?.textContent||'').includes('Показано') ||
          (document.querySelector('#v2-content')?.innerText||'').includes('Показано')`, 90000, 300);
      } else if (s.impl === "map-screen") {
        await b.waitFor(`(document.querySelector('#v2-content')?.innerText||'').includes('Карту не удалось построить') ||
          (!!document.querySelector('.maplibregl-canvas') &&
          !(document.querySelector('#v2-content')?.innerText||'').includes('Загрузка карты'))`, 30000, 300);
      }
      await sleep(700);
      const state = await b.eval(`({title:document.title, text:(document.querySelector('#v2-content')?.innerText||'').slice(0,240),
        html:document.querySelector('#v2-content')?.innerHTML.length||0,
        scrollX:document.documentElement.scrollWidth-innerWidth,
        scrollY:document.documentElement.scrollHeight-innerHeight})`);
      const newErrors = b.exceptions.slice(oldErrors);
      const serverErrors = b.requests.slice(oldRequests).filter((r) => r.status >= 500);
      const mapError = s.impl === "map-screen" && state.text.includes("Карту не удалось построить");
      check(`${s.id}: монтирование`, state.title.startsWith(s.title) && state.html > 50 && !mapError && !newErrors.length && !serverErrors.length,
        JSON.stringify({ objectId, ...state, newErrors: newErrors.slice(0, 2), serverErrors: serverErrors.map((r) => `${r.status} ${r.url}`) }));
      if (s.impl === "workspace" || s.impl === "map-screen") {
        check(`${s.id}: без прокрутки страницы при 1920×1080`, state.scrollX <= 1 && state.scrollY <= 1,
          `${state.scrollX}×${state.scrollY}`);
        await b.viewport(1366, 768);
        await sleep(350);
        const compact = await b.eval(`({x:document.documentElement.scrollWidth-innerWidth,
          y:document.documentElement.scrollHeight-innerHeight})`);
        check(`${s.id}: без прокрутки страницы при 1366×768`, compact.x <= 1 && compact.y <= 1,
          `${compact.x}×${compact.y}`);
        await b.viewport(1920, 1080);
      }
    } catch (e) {
      const state = await b.eval(`({hash:location.hash,title:document.title,head:document.querySelector('#v2-head-section')?.textContent,
        text:(document.querySelector('#v2-content')?.innerText||'').slice(0,300)})`).catch(() => ({}));
      check(`${s.id}: монтирование`, false, JSON.stringify({ error: String(e.message || e), state,
        exceptions: b.exceptions.slice(oldErrors, oldErrors + 2) }));
    }
  }
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("Маршруты V2") ? 1 : 0);
