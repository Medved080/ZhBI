// Раскладка затронутых экранов (отчёты с графиком, график СМР) без прокрутки ВСЕЙ страницы — 1920×1080 и
// 1366×768, панель навигации открыта/свёрнута. Настоящий backend, настоящий вход, копия обезличенной БД.
// Запуск: node scripts/charts_verify/chk_layout.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8279;
const S = await startServer(PORT, `${SP}/charts_layout`);
let b;
const metrics = () => b.eval(`(()=>{const d=document.scrollingElement;return {sh:d.scrollHeight, ih:innerHeight, sw:d.scrollWidth, iw:innerWidth};})()`);
const noScroll = (m) => m.sh <= m.ih + 2 && m.sw <= m.iw + 2;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_layout_shots` });
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await b.viewport(w, h);
    const tag = `${w}×${h}`;
    await openScreen(b, "report-dynamics", `document.querySelector('#rd-report svg')`);
    await sleep(400);
    check(`${tag} «Динамика»: страница не прокручивается целиком (график длинный, но внутри своей области)`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await openScreen(b, "report-analytics", `document.querySelector('.v2-tiles')`);
    await b.waitFor(`[...document.querySelectorAll('.v2-report-h')].some(h=>h.textContent.includes('Динамика обеспечения'))`, 15000);
    await sleep(400);
    check(`${tag} «Аналитическая справка»: то же самое`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await openScreen(b, "schedule", `document.querySelector('.v2-gantt-wrap')`);
    await sleep(400);
    check(`${tag} «График СМР», «Визуализация»`, noScroll(await metrics()), JSON.stringify(await metrics()));
    // полноэкранный режим — тоже не даёт прокрутки страницы (сам оверлей inset:0, внутри своя прокрутка)
    await b.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Во весь экран')?.click()`);
    await sleep(300);
    check(`${tag} «График СМР», полноэкранный режим`, noScroll(await metrics()), JSON.stringify(await metrics()));
    await b.key("Escape");
    await sleep(200);
    // навигация свёрнута
    await b.eval(`document.querySelector('#v2-shellnav-toggle,[data-a=\"nav-toggle\"],.v2-shellnav-collapse')?.click?.()`).catch(() => {});
  }
  check("нет ошибок JavaScript", b.exceptions.length === 0, b.exceptions.slice(0, 3).join("; "));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
