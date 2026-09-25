// Новая зона крана не появляется внутри соседа; сервер отвергает наложение.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";
import { overlapArea } from "../app/static/v2/zone-overlap.js";
import { displacedRectFace } from "../app/static/v2/zone-edge-geometry.js";

const work = mkdtempSync(join(tmpdir(), "crane-nonoverlap-"));
let browser;
try {
  const { base } = await startServer(8376, work);
  browser = await session(base, "admin", { objectId: 1 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-add-crane')");
  await tap(browser, "#cz-add-crane");
  await browser.waitFor("!!document.querySelector('.cz-tree-item.active[data-zone-id=\"-1\"]')", 30000);
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  const draftId = Number(await browser.eval("document.querySelector('#cz-draft-select').value"));
  const request = (method, path, body) => browser.eval(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)},
      headers:{"Content-Type":"application/json"},body:${JSON.stringify(body) === undefined ? "undefined" : `JSON.stringify(${JSON.stringify(body)})`}});
    return {status:r.status,data:await r.json()};
  })()`);
  const prefix = `/objects/1/crane-zone-versions/drafts/${draftId}`;
  const d = await request("GET", prefix);
  assert.equal(d.status, 200);
  const added = d.data.zones.find((z) => z.id < 0);
  assert.ok(added && added.category === "Кран");
  const peers = d.data.zones.filter((z) => z.category === "Кран" && z.id !== added.id);
  const shape = added.levels[0].outline;
  for (const peer of peers) for (const level of peer.levels.filter((l) => l.elevation_mm === added.levels[0].elevation_mm))
    assert.ok(overlapArea(level.outline, shape) <= 1, `новая зона крана зашла в ${peer.id}`);
  console.log("PASS: новый кран расположен рядом без наложения на соседей");
  const other = peers.find((z) => z.levels.some((l) => l.elevation_mm === added.levels[0].elevation_mm));
  assert.ok(other);
  const level = other.levels.find((l) => l.elevation_mm === added.levels[0].elevation_mm);
  added.levels[0].outline = level.outline;
  const bad = await request("PATCH", prefix, { edit_token: d.data.edit_token, zones: d.data.zones,
    overrides: d.data.overrides || {}, note: "Проверка пересечения" });
  assert.equal(bad.status, 409, JSON.stringify(bad.data));
  assert.match(JSON.stringify(bad.data), /пересекаются/);
  console.log("PASS: сервер отказал в сохранении наложенной зоны крана");

  // Освобождаем полосу у стоянки в черновике и просим UI поставить новую
  // стоянку именно в освободившееся место, рядом с прежней.
  const fresh = (await request("GET", prefix)).data;
  const crane = fresh.zones.find((z) => z.category === "Кран" && z.number === 1);
  const stand = fresh.zones.find((z) => z.category === "Стоянка" && z.parent_zone_id === crane.id && z.number === 1);
  for (const item of stand.levels) {
    const old = item.outline;
    const edge = old.map((point, i) => ({ i, x: (point[0] + old[(i + 1) % 4][0]) / 2 })).sort((a, b) => b.x - a.x)[0].i;
    item.outline = displacedRectFace(old, edge, -4000, 0);
  }
  const reduced = await request("PATCH", prefix, { edit_token: fresh.edit_token, zones: fresh.zones,
    overrides: fresh.overrides || {}, note: "Тест размещения новой стоянки в освобождённой полосе" });
  assert.equal(reduced.status, 200, JSON.stringify(reduced.data));
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-add-stand')");
  await browser.eval("document.querySelector('#cz-draft-select').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.waitFor(`!!document.querySelector('[data-zone-id="${stand.id}"]')`);
  await tap(browser, `[data-zone-id="${stand.id}"]`);
  await tap(browser, "#cz-add-stand");
  await browser.waitFor("!!document.querySelector('.cz-tree-item.cz-stand.active[data-zone-id=\"-2\"]')", 30000);
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  const withStand = (await request("GET", prefix)).data;
  const newStand = withStand.zones.find((z) => z.id === -2);
  assert.ok(newStand && newStand.parent_zone_id === crane.id);
  assert.equal(newStand.levels.length, stand.levels.length, "новая стоянка должна повторять число ярусов");
  for (const peer of withStand.zones.filter((z) => z.category === "Стоянка" && z.parent_zone_id === crane.id && z.id !== -2))
    for (const addedLevel of newStand.levels)
      for (const level of peer.levels.filter((l) => l.elevation_mm === addedLevel.elevation_mm))
        assert.ok(overlapArea(level.outline, addedLevel.outline) <= 1, `новая стоянка зашла в ${peer.id} на ${addedLevel.elevation_mm}`);
  console.log("PASS: новая стоянка заняла свободную полосу рядом с существующей");
} finally {
  try { await browser?.close(); } catch { /* */ }
  await stopServer();
}
