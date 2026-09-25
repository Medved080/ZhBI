// Регрессия изоляции текущего объекта на настоящем backend и копии обезличенной БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, stopServer, session, setObject, openScreen, tap, openV1, sql, sql1 } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "zhbi-object-scope-"));
let browser;
try {
  const { base, db } = await startServer(8376, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  const request = async (path, body) => browser.eval(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, ${body === undefined ? "{}" : JSON.stringify({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })});
    return { status: response.status, data: await response.json() };
  })()`);
  const count = (objectId) => Number(sql1(db, `SELECT COUNT(*) FROM elements WHERE object_id=${objectId} AND is_current=1`));
  for (const objectId of [1, 2]) {
    const elements = await request(`/element-catalog?object_id=${objectId}&limit=10`);
    assert.equal(elements.status, 200);
    assert.equal(elements.data.total, count(objectId));
    assert.ok(elements.data.rows.every((row) => row.object_id === objectId));
    const zones = await request(`/zones?category=${encodeURIComponent("Захватка")}&object_id=${objectId}`);
    assert.equal(zones.status, 200);
    assert.ok(zones.data.length > 0);
    const ownZoneIds = new Set(sql(db, `SELECT id FROM zones WHERE object_id=${objectId} AND category='Захватка' AND is_current=1`).map((row) => row.id));
    assert.ok(zones.data.every((zone) => ownZoneIds.has(zone.id)));
    const contracts = await request(`/contracts?object_id=${objectId}`);
    assert.equal(contracts.status, 200);
    const expected = Number(sql1(db, `SELECT COUNT(*) FROM contracts co JOIN specifications s ON s.id=co.specification_id JOIN agreements a ON a.id=s.agreement_id WHERE a.object_id=${objectId}`));
    assert.equal(contracts.data.length, expected);
    const plan = await request("/plan-data", { selection: [{ object_id: objectId }] });
    assert.equal(plan.status, 200);
    assert.ok(plan.data.elements.every((element) => element.object_id === objectId));
    const contractIds = new Set(contracts.data.map((contract) => contract.id));
    assert.ok((plan.data.contracts || []).every((contract) => contractIds.has(contract.id)));
    const allZoneIds = new Set(sql(db, `SELECT id FROM zones WHERE object_id=${objectId}`).map((row) => row.id));
    assert.ok((plan.data.zones || []).every((zone) => allZoneIds.has(zone.id)));
    console.log(`PASS API: объект ${objectId} — изделия, зоны, контракты и схема изолированы`);
  }
  const mixed = await request("/plan-data", { selection: [{ object_id: 1 }, { object_id: 2 }] });
  assert.equal(mixed.status, 400);
  console.log("PASS API: смешанная схема двух объектов отклонена");

  await openScreen(browser, "element-catalog", "document.querySelector('#ec-summary')?.textContent.includes('Найдено')");
  assert.ok((await browser.eval("document.querySelector('#ec-summary').textContent")).includes(String(count(1))));
  assert.ok(browser.requests.some((r) => r.url.includes("/element-catalog?") && r.url.includes("object_id=1")));
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  const ownZones = Number(sql1(db, "SELECT COUNT(*) FROM zones WHERE object_id=1 AND category='Захватка' AND is_current=1"));
  assert.equal(await browser.eval("document.querySelector('#ze-count')?.textContent"), `Найдено ${ownZones} из ${ownZones}`);
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-canvas')?.dataset.highlightColor", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-canvas').dataset.highlightColor"), "#ff6a00");
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("!!document.querySelector('#cz-3d')?.dataset.highlightColor", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-3d').dataset.highlightColor"), "#ff6a00");
  console.log("PASS V2: справочник и редактор зон текущего объекта, контрастная подсветка 2D/3D");

  await openScreen(browser, "contracts", "!!document.querySelector('#cl-inner [data-open]')");
  await tap(browser, "#cl-inner [data-open]");
  await browser.waitFor("!!document.querySelector('#ctr-theme')", 30000);
  console.log("PASS V2: контракт текущего объекта открывается в карточке поставщика");

  assert.ok(await setObject(browser, 2));
  await openScreen(browser, "element-catalog", "document.querySelector('#ec-summary')?.textContent.includes('Найдено')");
  assert.ok((await browser.eval("document.querySelector('#ec-summary').textContent")).includes(String(count(2))));
  await openScreen(browser, "zones", "!!document.querySelector('#ze-count')");
  const otherZones = Number(sql1(db, "SELECT COUNT(*) FROM zones WHERE object_id=2 AND category='Захватка' AND is_current=1"));
  assert.equal(await browser.eval("document.querySelector('#ze-count').textContent"), `Найдено ${otherZones} из ${otherZones}`);
  console.log("PASS V2: смена объекта обновляет каталог и зоны без старых данных");

  await openV1(browser, base, 1);
  await browser.eval("renderElementCatalog()");
  await browser.waitFor("document.querySelector('#ec-summary')?.textContent.includes('Найдено')", 30000);
  assert.ok((await browser.eval("document.querySelector('#ec-summary').textContent")).includes(String(count(1))));
  assert.ok(browser.requests.some((r) => r.url.includes("/element-catalog?") && r.url.includes("object_id=1")));
  await browser.eval('openZonesModal("Захватка")');
  await browser.waitFor("document.querySelector('#zones-rows table')?.rows.length > 1", 30000);
  assert.equal(await browser.eval("document.querySelector('#zones-rows table tbody').rows.length"), ownZones);
  console.log("PASS V1: каталог изделий и список зон относятся к объекту в шапке");
  const reports = execFileSync("node", ["scripts/verify_v1_cross_object_reports.mjs"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: { ...process.env, V1_CROSS_BASE: base },
    encoding: "utf8", timeout: 120000,
  });
  console.log(reports.trim());
} finally {
  try { await browser?.close(); } catch { /* */ }
  await stopServer();
}
