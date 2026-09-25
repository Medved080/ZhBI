// Проверка существующего крана с 21 стоянкой на временной копии БД.
// Публикация не вызывается, порт 8000 и его база не затрагиваются.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";
import { overlapArea, polygonArea } from "../app/static/v2/zone-overlap.js";

const work = mkdtempSync(join(tmpdir(), "crane-many-stances-"));
let browser;
const zoneId = 22762;
async function draft() {
  return browser.eval(`(async()=>{
    const id = Number(document.querySelector('#cz-draft-select').value);
    return (await (await fetch('/objects/1/crane-zone-versions/drafts/' + id)).json());
  })()`);
}
function craneLevel(crane, elevation) {
  if (crane.levels.length === 1) return crane.levels[0];
  const lower = crane.levels.filter((level) => Number(level.elevation_mm) <= Number(elevation));
  return lower.sort((a, b) => Number(b.elevation_mm) - Number(a.elevation_mm))[0] || crane.levels[0];
}
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-draft-select')", 30000);
  await tap(browser, '#cz-new');
  await browser.waitFor("!!document.querySelector('#cz-draft-select').value", 30000);
  await tap(browser, `.cz-tree-item[data-zone-id="${zoneId}"]`);
  await tap(browser, '#cz-fit');
  const before = await draft();
  const craneBefore = before.zones.find((zone) => zone.id === zoneId);
  const standsBefore = before.zones.filter((zone) => zone.category === "Стоянка" && zone.parent_zone_id === zoneId);
  assert.equal(standsBefore.length, 21, "ожидался кран с 21 стоянкой");

  let resized = false;
  for (let attempt = 0; attempt < 10 && !resized; attempt++) {
    const edges = await browser.eval(`(()=>{
      const canvas=document.querySelector('#cz-canvas'), rect=canvas.getBoundingClientRect();
      const items=JSON.parse(canvas.dataset.edgeMidpoints || '[]');
      const cx=items.reduce((sum,item)=>sum+item.x,0)/items.length;
      const cy=items.reduce((sum,item)=>sum+item.y,0)/items.length;
      return items.map((edge)=>({
        x:rect.left+edge.x,y:rect.top+edge.y,length:edge.length,
        nx:(edge.x-cx)/Math.hypot(edge.x-cx,edge.y-cy),
        ny:(edge.y-cy)/Math.hypot(edge.x-cx,edge.y-cy)
      }));
    })()`);
    if (edges.length !== 4) throw new Error(`Ожидались 4 ребра, найдено ${edges.length}`);
    if (Math.max(...edges.map((edge) => edge.length)) < 35) {
      await browser.wheel(edges[0].x, edges[0].y, -180);
      continue;
    }
    for (const edge of edges.sort((a, b) => b.length - a.length)) {
      if (edge.x < 15 || edge.y < 15 || edge.x > 1351 || edge.y > 753) continue;
      for (const sign of [-1, 1]) {
        const dx = edge.nx * sign * 8;
        const dy = edge.ny * sign * 8;
        await browser.drag(edge.x, edge.y, edge.x + dx, edge.y + dy);
        if (await browser.eval("!document.querySelector('#cz-save').disabled")) { resized = true; break; }
      }
      if (resized) break;
    }
  }
  assert.ok(resized, `Не удалось изменить грань крана: ${await browser.eval("document.querySelector('#cz-feedback')?.textContent")}`);
  assert.match(await browser.eval(`document.querySelector('.cz-tree-item.active b').textContent`), /^≈\d+$/,
    "при изменении границы счётчик изделий должен обновляться до сохранения");
  await tap(browser, '#cz-save');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.startsWith('Черновик сохранён')", 30000);
  const after = await draft();
  const craneAfter = after.zones.find((zone) => zone.id === zoneId);
  const standsAfter = after.zones.filter((zone) => zone.category === "Стоянка" && zone.parent_zone_id === zoneId);
  assert.notDeepEqual(craneAfter.levels[0].outline, craneBefore.levels[0].outline, "кран не изменился");
  assert.equal(standsAfter.length, 21);
  for (const stand of standsAfter) {
    const previous = standsBefore.find((item) => item.id === stand.id);
    assert.notDeepEqual(stand.levels.map((level) => level.outline), previous.levels.map((level) => level.outline),
      `стоянка ${stand.id} не подстроилась вслед за краном`);
    for (const level of stand.levels) {
      const parent = craneLevel(craneAfter, level.elevation_mm);
      assert.ok(overlapArea(level.outline, parent.outline) >= Math.abs(polygonArea(level.outline)) - 1,
        `стоянка ${stand.id} вышла за границы крана`);
    }
  }
  assert.equal(browser.requests.filter((request) => /\/publish$/.test(request.url)).length, 0);
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join('\n'));
  console.log("PASS: существующий кран с 21 стоянкой изменён, все стоянки остались внутри, черновик сохранён, счётчик обновился");
} finally {
  await browser?.close();
  await stopServer();
}
