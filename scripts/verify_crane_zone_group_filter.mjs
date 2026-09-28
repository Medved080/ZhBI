// Отбор стоянок по крану и совместный просмотр нескольких стоянок.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-group-filter-"));
let browser;
try {
  const { base } = await startServer(8379, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  const crane3 = await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].find(e => e.textContent.includes('Кран 3'))?.dataset.craneToggle");
  assert.ok(crane3);
  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${crane3}"]`);
  const ids = await browser.eval(`(() => {
    const group = document.querySelector('.cz-crane-toggle[data-crane-toggle="${crane3}"]')?.closest('.cz-crane');
    return [10, 11].map(number => [...group.querySelectorAll('.cz-stand')]
      .find(button => button.textContent.includes('Стоянка ' + number))?.dataset.zoneId);
  })()`);
  assert.ok(ids.every(Boolean));
  assert.match(await browser.eval("document.querySelector('.cz-map-summary').textContent"), /21 из 21/);
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("!!document.querySelector('#cz-3d')?.dataset.zoneBands", 30000);
  const groupBands = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.zoneBands"));
  const craneStandIds = await browser.eval(`[...document.querySelector('.cz-crane-toggle[data-crane-toggle="${crane3}"]').closest('.cz-crane').querySelectorAll('.cz-stand')].map(e => Number(e.dataset.zoneId))`);
  assert.equal(new Set(groupBands.map((band) => band.zoneId)).size, 21);
  assert.ok(groupBands.every((band) => craneStandIds.includes(band.zoneId)), "видны стоянки другого крана");

  await tap(browser, `.cz-stand[data-zone-id="${ids[0]}"]`);
  assert.deepEqual([...new Set(JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.zoneBands")).map((band) => band.zoneId))], [Number(ids[0])]);
  await browser.eval(`(() => {
    const checkbox = document.querySelector('[data-view-stance="${ids[1]}"]');
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const selectedBands = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.zoneBands"));
  assert.deepEqual([...new Set(selectedBands.map((band) => band.zoneId))].sort((a, b) => a - b),
    ids.map(Number).sort((a, b) => a - b));
  if (process.env.CRANE_GROUP_SHOT) await browser.shot(process.env.CRANE_GROUP_SHOT);
  assert.match(await browser.eval("document.querySelector('.cz-map-summary').textContent"), /2 из 21/);
  assert.equal(await browser.eval("document.querySelector('#cz-save')?.disabled"), true,
    "выбор стоянок изменил черновик");

  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${crane3}"]`);
  const resetBands = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.zoneBands"));
  assert.equal(new Set(resetBands.map((band) => band.zoneId)).size, 21,
    "повторный выбор крана не вернул все его стоянки");
  const crane2 = await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].find(e => e.textContent.includes('Кран 2'))?.dataset.craneToggle");
  assert.ok(crane2);
  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${crane2}"]`);
  const crane2Ids = await browser.eval(`[...document.querySelector('.cz-crane-toggle[data-crane-toggle="${crane2}"]').closest('.cz-crane').querySelectorAll('.cz-stand')].map(e => Number(e.dataset.zoneId))`);
  const otherBands = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.zoneBands"));
  assert.ok(otherBands.length && otherBands.every((band) => crane2Ids.includes(band.zoneId)),
    "при переходе к другому крану остались контуры прежнего");
  await tap(browser, `.cz-stand[data-zone-id="${crane2Ids[0]}"]`);
  const stanceVisible = `(() => {
    const host = document.querySelector('#cz-3d');
    return JSON.parse(host.dataset.edgeMidpoints || '[]').some(point => {
      const x = point.x, y = point.y;
      return x >= 13 && x <= host.clientWidth - 13 && y >= 13 && y <= host.clientHeight - 13;
    });
  })()`;
  await browser.waitFor(stanceVisible, 10000);
  assert.equal(await browser.eval(stanceVisible), true, "камера не подвелась к стоянкам другого крана");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: кран показывает только свои стоянки, галочки объединяют несколько контуров без изменения черновика");
} finally {
  await browser?.close();
  await stopServer();
}
