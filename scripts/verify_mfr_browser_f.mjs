// Смоук-проверка связанных отчётов «чтение» (V2) на настоящем backend: «Учёт по блокам: статусы», «График работ по блокам», «Линейный трек» —
// открываются на объекте МФР, без ошибок загрузки и исключений, с данными; никаких изменяющих запросов; 1920×1080 и 1366×768.
import { session, openScreen, shot, sleep, checker, txt, exists } from "./verify_mfr_lib.mjs";
const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const SHOTS = process.env.MFR_SHOTS || null;
const c = checker("reports");
const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
try {
  for (const [id, title] of [["report-block-status", "Учёт по блокам: статусы"], ["report-block-schedule", "График работ по блокам"], ["report-linear-track", "Линейный трек"]]) {
    await openScreen(b, id, `document.querySelector('#rd-body') && !/Загрузка/.test(document.querySelector('#rd-body').textContent)`);
    await sleep(500);
    const body = await txt(b, "#rd-body");
    c.ok(!(await exists(b, ".v2-callout-bad")) && body.length > 40, `${id}: открыт, ошибок нет, данные показаны (${body.length} знаков)`);
    c.ok(await b.eval(`document.scrollingElement.scrollHeight <= innerHeight + 1 || getComputedStyle(document.querySelector('#v2-content')).overflowY!=='visible'`), `${id}: страница не прокручивается целиком (прокрутка внутри области)`);
    await shot(b, `f-${id}`);
  }
  const writes = b.requests.filter((r) => r.method !== "GET" && !(r.method === "POST" && /\/reports\/[a-z-]+$/.test(r.url)) && !/\/login$/.test(r.url));
  c.ok(writes.length === 0, "во время просмотра нет изменяющих запросов (кроме чтения отчётов POST /reports/…)", JSON.stringify(writes.map((w) => w.method + " " + w.url)));
  await b.viewport(1366, 768); await sleep(800);
  c.ok(await b.eval(`document.scrollingElement.scrollWidth <= innerWidth + 1`), "1366×768: нет горизонтальной прокрутки страницы");
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет", JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "f-fail").catch(() => {}); }
finally { await b.close(); }
process.exit(c.done() ? 1 : 0);
