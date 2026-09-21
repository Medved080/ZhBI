// Раскладка экранов области «МФР / учёт по блокам» на 1920×1080 и 1366×768 (100% масштаб): страница не прокручивается целиком, нет горизонтальной прокрутки,
// длинные списки прокручиваются ВНУТРИ панелей. Снимки — в каталог проверки.
import { session, openScreen, shot, sleep, checker, tap } from "./verify_mfr_lib.mjs";
const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const SHOTS = process.env.MFR_SHOTS || null;
const c = checker("layout");
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS, width: w, height: h });
  try {
    for (const [id, waitExpr] of [["blocks", `document.querySelectorAll('.mfr-blk').length>5`], ["fact-journal", `document.querySelectorAll('#fj-tbl tr[data-rep]').length>0`], ["chess-flat", `document.querySelector('.mfr-cf-grid')`], ["blk-bulk", `document.querySelector('#bb-analyze')`]]) {
      await openScreen(b, id, waitExpr); await sleep(600);
      if (id === "blocks") { await tap(b, `.mfr-blk`); await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`); }
      const m = await b.eval(`({sh:document.scrollingElement.scrollHeight, sw:document.scrollingElement.scrollWidth, ih:innerHeight, iw:innerWidth})`);
      c.ok(m.sh <= m.ih + 1 && m.sw <= m.iw + 1, `${w}×${h} ${id}: страница не прокручивается (${m.sw}×${m.sh} в ${m.iw}×${m.ih})`);
      const clipped = await b.eval(`(()=>{const bad=[]; for(const e of document.querySelectorAll('.mfr-scr button, .mfr-scr .v2-btn')){ if(e.closest('.mfr-scroll')) continue; const r=e.getBoundingClientRect(); if(r.width>0 && (r.right>innerWidth+1 || r.bottom>innerHeight+1)) bad.push((e.id||e.textContent).slice(0,30)); } return bad;})()`);
      c.ok(clipped.length === 0, `${w}×${h} ${id}: кнопки экрана не выходят за окно`, JSON.stringify(clipped));
      await shot(b, `g-${id}-${w}`);
    }
    // окна поверх экрана: факт и состав работ на этом размере целиком в окне
    await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
    await tap(b, `.mfr-blk`); await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);
    await tap(b, "#bs-fact"); await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length>0`); await sleep(400);
    const mm = await b.eval(`(()=>{const r=document.querySelector('.mfr-modal').getBoundingClientRect(); return {b:r.bottom, r:r.right, t:r.top, l:r.left, ih:innerHeight, iw:innerWidth}})()`);
    c.ok(mm.b <= mm.ih + 1 && mm.r <= mm.iw + 1 && mm.t >= -1 && mm.l >= -1, `${w}×${h}: окно «Факт» целиком в окне браузера`);
    await shot(b, `g-fact-modal-${w}`);
    c.ok(b.exceptions.length === 0, `${w}×${h}: исключений JavaScript нет`, JSON.stringify(b.exceptions.slice(0, 2)));
  } catch (e) { console.log("СБОЙ:", e.message); c.ok(false, `${w}×${h} сценарий завершён`, e.message); await shot(b, `g-fail-${w}`).catch(() => {}); }
  finally { await b.close(); }
}
process.exit(c.done() ? 1 : 0);
