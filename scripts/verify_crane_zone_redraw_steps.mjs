// Каждая точка и промежуточный отрезок проверяются до изменения черновика.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerSegmentIntrusion } from "../app/static/v2/zone-overlap.js";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-redraw-steps-"));
let browser;
try {
  const { base } = await startServer(8377, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  if (!await browser.eval("!!document.querySelector('#cz-draft-select')?.value && !document.querySelector('#cz-draft-select option:checked')?.textContent.includes('устарел')")) {
    await tap(browser, "#cz-new");
    await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value", 30000);
  }
  const crane = await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].find(e => e.textContent.includes('Кран 3'))?.dataset.craneToggle");
  await tap(browser, '.cz-crane-toggle[data-crane-toggle="' + crane + '"]');
  const ids = await browser.eval("(() => { const group=[...document.querySelectorAll('.cz-crane-toggle')].find(e=>e.textContent.includes('Кран 3')).closest('.cz-crane'); const stands=[...group.querySelectorAll('.cz-stand')]; return [10,11].map(n=>Number(stands.find(e=>e.textContent.includes('Стоянка '+n))?.dataset.zoneId)); })()");
  assert.ok(ids.every(Number.isFinite));
  await tap(browser, '.cz-stand[data-zone-id="' + ids[1] + '"]');
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.highlightedOutlines) > 0", 10000);
  const canvas = await browser.rect("#cz-canvas");
  const draft = await browser.eval("(async()=>{const id=document.querySelector('#cz-draft-select').value;return await (await fetch('/objects/1/crane-zone-versions/drafts/'+id)).json()})()");
  const selected = draft.zones.find((zone) => zone.id === ids[1]);
  const peer = draft.zones.find((zone) => zone.id === ids[0]);
  const elevation = selected.levels[0].elevation_mm;
  const outline = selected.levels[0].outline;
  const x0 = Math.min(...outline.map((p) => p[0])), x1 = Math.max(...outline.map((p) => p[0]));
  const y0 = Math.min(...outline.map((p) => p[1])), y1 = Math.max(...outline.map((p) => p[1]));
  const scale = Math.min(canvas.w / ((x1 - x0) * 1.18), canvas.h / ((y1 - y0) * 1.18));
  const project = ([x, y]) => [canvas.x + canvas.w / 2 + (x - (x0 + x1) / 2) * scale,
    canvas.y + canvas.h / 2 - (y - (y0 + y1) / 2) * scale];
  const otherZones = draft.zones.filter((zone) => zone.id !== peer.id);
  let fixture = null;
  for (const py of [0, 80, -80, 150, -150]) {
    for (const px of [0, 90, -90, 180, -180, 260, -260]) {
      const x = (x0 + x1) / 2 + px / scale, y = (y0 + y1) / 2 - py / scale;
      const left = [x - 55 / scale, y], right = [x + 55 / scale, y];
      if (project(left)[0] < canvas.x + 20 || project(right)[0] > canvas.x + canvas.w - 20 ||
        project(left)[1] < canvas.y + 110 || project(left)[1] > canvas.y + canvas.h - 25) continue;
      if (peerSegmentIntrusion(otherZones, selected, elevation, left, right)) continue;
      fixture = { x, y, left, right }; break;
    }
    if (fixture) break;
  }
  assert.ok(fixture, "не найден свободный участок для тестовой соседней стоянки");
  const halfX = 18 / scale, halfY = 28 / scale;
  peer.levels[0].elevation_mm = elevation;
  peer.levels[0].outline = [[fixture.x - halfX, fixture.y - halfY], [fixture.x + halfX, fixture.y - halfY],
    [fixture.x + halfX, fixture.y + halfY], [fixture.x - halfX, fixture.y + halfY]];
  const payload = { edit_token: draft.edit_token, zones: draft.zones, overrides: draft.overrides || {}, note: draft.note || "" };
  const saved = await browser.eval("(async()=>{const id=document.querySelector('#cz-draft-select').value;const r=await fetch('/objects/1/crane-zone-versions/drafts/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(" +
    JSON.stringify(payload) + ")});return {status:r.status,data:await r.json()}})()");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await browser.eval("document.querySelector('#cz-draft-select').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.waitFor("document.querySelector('.cz-tree-item.active')?.dataset.zoneId !== '" + ids[1] + "'", 10000);
  await tap(browser, '.cz-stand[data-zone-id="' + ids[1] + '"]');
  await browser.waitFor("!!document.querySelector('#cz-redraw-polygon')", 10000);
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.highlightedOutlines) > 0", 10000);
  await tap(browser, "#cz-redraw-polygon");
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.highlightedOutlines) === 0", 10000);
  await browser.click(...project([fixture.x, fixture.y]));
  assert.equal(await browser.eval("document.querySelector('#cz-draw-undo').disabled"), true,
    "первая точка внутри чужой стоянки была добавлена");
  assert.match(await browser.eval("document.querySelector('.cz-draw-guide-text').textContent"), /чужую стоянку/);
  await browser.click(...project(fixture.left));
  assert.equal(await browser.eval("document.querySelector('#cz-draw-undo').disabled"), false,
    "допустимая первая точка не добавилась");
  await browser.move(...project(fixture.right));
  assert.equal(await browser.eval("document.querySelector('#cz-canvas').style.cursor"), "not-allowed",
    "отрезок через чужую стоянку не помечен при наведении");
  await browser.click(...project(fixture.right));
  assert.match(await browser.eval("document.querySelector('.cz-draw-guide-text').textContent"), /чужую стоянку/);
  await tap(browser, "#cz-draw-undo");
  assert.equal(await browser.eval("document.querySelector('#cz-draw-undo').disabled"), true,
    "отрезок через стоянку был добавлен, хотя должен быть отклонён");
  await tap(browser, "#cz-draw-cancel");
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.highlightedOutlines) > 0", 10000);
  assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
  console.log("PASS: чужая зона блокирует первую точку и проходящий через неё отрезок; подсветка скрыта во время рисования");
} finally {
  await browser?.close();
  await stopServer();
}
