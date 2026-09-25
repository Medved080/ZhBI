// Сверяет высоту КАЖДОГО 3D-изделия редактора с основной схемой V1 на копии БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "model-parity-"));
let browser;
try {
  const { base } = await startServer(8376, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: process.env.MODEL_PARITY_SHOT ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] : [] });
  await browser.goto(`${base}/?ui=v1&object_id=1`, 1200);
  await browser.waitFor("state.objectId === 1 && state.elements.length > 9000", 30000);
  const result = await browser.eval(`(async () => {
    const { computeElementRenderHeights } = await import('/static/v2/element-render-heights.js');
    const actual = computeElementRenderHeights(state.elements);
    const levels = computeColumnLevels(), tops = computeColumnTops(levels);
    const differences = [];
    for (const element of state.elements) {
      if (!element.outline || element.outline.length < 3) continue;
      const expected = elementExtrusionHeight(element, levels, tops);
      const received = actual.get(element.id);
      if (Math.abs(expected - received) > 1e-7) differences.push({ id: element.id, expected, received });
    }
    return { count: actual.size, differences: differences.slice(0, 10) };
  })()`);
  assert.ok(result.count > 9000, `мало изделий с геометрией: ${result.count}`);
  assert.deepEqual(result.differences, []);
  console.log(`PASS геометрия: высота всех ${result.count} изделий совпадает с основной 3D-схемой`);
  if (process.env.MODEL_PARITY_SHOT) {
    await browser.clickSel("#btn-view-3d");
    await browser.waitFor("state.view3d.active && !!state.view3d.controls", 30000);
    await browser.shot(process.env.MODEL_PARITY_SHOT);
  }
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
