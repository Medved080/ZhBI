// Сквозная публикация ступенчатой стоянки — только временная копия обезличенной БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, sql, sql1, openScreen } from "./audit_work/lib.mjs";
import { displacedRectFace } from "../app/static/v2/zone-edge-geometry.js";

const work = mkdtempSync(join(tmpdir(), "zhbi-crane-stair-"));
let browser;
try {
  const { base, db } = await startServer(8377, work);
  browser = await session(base, "admin", { objectId: 1 });
  const request = (method, path, body) => browser.eval(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)},
      headers: { "Content-Type": "application/json" },
      ${body === undefined ? "" : `body: JSON.stringify(${JSON.stringify(body)}),`}
    });
    return { status: response.status, data: await response.json() };
  })()`);
  const prefix = "/objects/1/crane-zone-versions";
  const versions = await request("GET", prefix);
  assert.equal(versions.status, 200);
  const baseVersion = versions.data.find((row) => row.activated_at);
  assert.ok(baseVersion);
  const detail = await request("GET", `${prefix}/${baseVersion.id}`);
  assert.equal(detail.status, 200);
  const zones = detail.data.zones;
  const crane = zones.find((zone) => zone.category === "Кран" && zone.number === 1);
  const stand = zones.find((zone) => zone.category === "Стоянка" && zone.parent_zone_id === crane.id && zone.number === 1);
  assert.ok(crane && stand && stand.levels.length >= 4);
  const oldStandId = stand.id;
  const beforeAssignments = sql(db, `SELECT id,current_status,contract_id,zone_stance_id FROM elements WHERE object_id=1 AND is_current=1 AND zone_stance_id=${oldStandId}`);
  const otherBefore = sql(db, "SELECT id,zone_crane_id,zone_stance_id,zone_stance_level_id FROM elements WHERE object_id=2 AND is_current=1 ORDER BY id");
  const newNumber = Math.max(...zones.filter((zone) => zone.category === "Стоянка" && zone.parent_zone_id === crane.id).map((zone) => zone.number)) + 1;
  const strips = [];
  for (const level of stand.levels) {
    const old = level.outline.map((point) => [...point]);
    const edge = old.map((point, i) => ({ i, x: (point[0] + old[(i + 1) % 4][0]) / 2 })).sort((a, b) => b.x - a.x)[0].i;
    const reduced = displacedRectFace(old, edge, -4000, 0);
    assert.ok(reduced);
    const oldMaxX = Math.max(...old.map((point) => point[0]));
    const newMaxX = Math.max(...reduced.map((point) => point[0]));
    assert.ok(oldMaxX - newMaxX > 3900);
    level.outline = reduced;
    const y0 = Math.min(...old.map((point) => point[1]));
    const y1 = Math.max(...old.map((point) => point[1]));
    strips.push({ elevation_mm: level.elevation_mm,
      outline: [[newMaxX, y0], [oldMaxX, y0], [oldMaxX, y1], [newMaxX, y1]] });
  }
  assert.ok(new Set(strips.map((level) => Math.round(level.outline[0][0]))).size >= 3, "новая стоянка не стала ступенчатой");
  zones.push({ id: -1, category: "Стоянка", parent_zone_id: crane.id,
    number: newNumber, name: `Стоянка ${newNumber} · тест ступеней`, levels: strips });

  const draft = await request("POST", `${prefix}/drafts`);
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const saved = await request("PATCH", `${prefix}/drafts/${draft.data.draft_id}`,
    { edit_token: draft.data.edit_token, zones, overrides: {}, note: "Тест уменьшения стоянки и публикации ступенчатой зоны" });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const preview = await request("POST", `${prefix}/drafts/${draft.data.draft_id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.total, Number(sql1(db, "SELECT COUNT(*) FROM elements WHERE object_id=1 AND is_current=1")));
  assert.ok(preview.data.counts.stance > 0, "в предпросмотре нет смены стоянки у изделий");
  console.log(`PASS: черновик сохранён; предпросмотр — ${preview.data.counts.stance} изменений стоянки`);

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const published = await request("POST", `${prefix}/drafts/${draft.data.draft_id}/publish`,
    { edit_token: saved.data.edit_token, effective_date: day });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.equal(published.data.activated, true);
  const newZone = sql(db, `SELECT id,name,parent_zone_id,number FROM zones WHERE object_id=1 AND name='Стоянка ${newNumber} · тест ступеней'`)[0];
  assert.ok(newZone && newZone.parent_zone_id === crane.id);
  assert.equal(Number(sql1(db, `SELECT COUNT(*) FROM zone_levels WHERE zone_id=${newZone.id}`)), strips.length);
  const moved = beforeAssignments.filter((row) => Number(sql1(db, `SELECT zone_stance_id FROM elements WHERE id=${row.id}`)) === newZone.id);
  assert.ok(moved.length > 0, "ни одно изделие не перешло в новую стоянку");
  for (const element of moved) {
    const after = sql(db, `SELECT current_status,contract_id,zone_stance_status,zone_stance_level_id FROM elements WHERE id=${element.id}`)[0];
    assert.equal(after.current_status, element.current_status);
    assert.equal(after.contract_id, element.contract_id);
    assert.equal(after.zone_stance_status, "matched");
    assert.ok(after.zone_stance_level_id);
  }
  assert.deepEqual(sql(db, "SELECT id,zone_crane_id,zone_stance_id,zone_stance_level_id FROM elements WHERE object_id=2 AND is_current=1 ORDER BY id"), otherBefore);
  assert.equal(Number(sql1(db, `SELECT COUNT(*) FROM crane_zone_version_assignments WHERE version_id=${published.data.version_id}`)), preview.data.total);
  console.log(`PASS: редакция опубликована; ${moved.length} изделий переведены в новую стоянку, статус и контракт сохранены`);

  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await browser.eval("document.querySelector('[data-cat=Стоянка]').click()");
  await browser.waitFor(`document.querySelectorAll('.cz-tree-item.cz-stand').length >= ${newNumber}`, 30000);
  assert.ok((await browser.eval("document.querySelector('.cz-tree')?.innerText || ''")).includes(`Стоянка ${newNumber}`));
  console.log("PASS V2: новая стоянка видна в редакторе после публикации");
} finally {
  try { await browser?.close(); } catch { /* */ }
  await stopServer();
}
