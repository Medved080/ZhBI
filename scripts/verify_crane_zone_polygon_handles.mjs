// Реальные контуры стоянок 10 и 11 крана 3 имеют больше четырёх вершин.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-polygon-handles-"));
let browser;
try {
  const { base } = await startServer(8379, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  if (!await browser.eval("!!document.querySelector('#cz-draft-select')?.value && !document.querySelector('#cz-draft-select option:checked')?.textContent.includes('устарел')")) {
    await tap(browser, '#cz-new');
    await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value", 30000);
  }
  const crane = await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].find(e => e.textContent.includes('Кран 3'))?.dataset.craneToggle");
  assert.ok(crane, "кран 3 не найден на проверочной копии");
  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${crane}"]`);
  const stands = await browser.eval(`(() => {
    const group = document.querySelector('.cz-crane-toggle[data-crane-toggle="${crane}"]')?.closest('.cz-crane');
    return [10, 11].map(number => [...group.querySelectorAll('.cz-stand')]
      .find(button => button.textContent.includes('Стоянка ' + number))?.dataset.zoneId);
  })()`);
  assert.ok(stands.every(Boolean), "стоянки 10 и 11 не найдены у крана 3");
  for (const [i, expectedEdges] of [[0, 6], [1, 8]]) {
    await tap(browser, `.cz-stand[data-zone-id="${stands[i]}"]`);
    await browser.waitFor(`JSON.parse(document.querySelector('#cz-canvas')?.dataset.edgeMidpoints || '[]').length === ${expectedEdges}`, 10000);
    const points2d = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
    assert.equal(points2d.length, expectedEdges, "2D не показывает рёбра сложной стоянки");
    const canvas = await browser.rect('#cz-canvas');
    const edge = [...points2d].sort((a, b) => b.length - a.length)[0];
    await browser.move(canvas.x + edge.x, canvas.y + edge.y);
    assert.match(await browser.eval("document.querySelector('#cz-canvas').style.cursor"), /data:image\/svg\+xml/);
  }
  const points = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
  const edge = [...points].sort((a, b) => b.length - a.length)[0];
  const center = points.reduce((sum, point) => [sum[0] + point.x / points.length, sum[1] + point.y / points.length], [0, 0]);
  const toward = [center[0] - edge.x, center[1] - edge.y], distance = Math.hypot(...toward);
  const canvas = await browser.rect('#cz-canvas');
  await browser.drag(canvas.x + edge.x, canvas.y + edge.y,
    canvas.x + edge.x + toward[0] / distance * 8,
    canvas.y + edge.y + toward[1] / distance * 8);
  assert.equal(await browser.eval("!!document.querySelector('#cz-save:not(:disabled)')"), true,
    "стрелка сложной стоянки не меняет её контур");
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
  for (const [i, expectedEdges] of [[0, 6], [1, 8]]) {
    await tap(browser, `.cz-stand[data-zone-id="${stands[i]}"]`);
    await browser.waitFor(`JSON.parse(document.querySelector('#cz-3d')?.dataset.edgeMidpoints || '[]').length === ${expectedEdges}`, 10000);
    const points3d = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
    assert.equal(points3d.length, expectedEdges, "3D потерял рёбра сложной стоянки");
    assert.ok(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length > 0"),
      "в 3D не появились стрелки выбранной стоянки");
    const visibleGrip = await browser.eval(`(() => {
      const host = document.querySelector('#cz-3d');
      return [...host.querySelectorAll('.cz-3d-grip')].some(grip => {
        const x = parseFloat(grip.style.left), y = parseFloat(grip.style.top);
        return x >= 13 && x <= host.clientWidth - 13 && y >= 13 && y <= host.clientHeight - 13;
      });
    })()`);
    assert.equal(visibleGrip, true, "стрелки созданы за пределами видимой 3D-схемы");
  }
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: стоянки 10 и 11 крана 3 показывают стрелки изменения размера в 2D и 3D");
} finally {
  await browser?.close();
  await stopServer();
}
