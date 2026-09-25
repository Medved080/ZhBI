// Реальные события колеса на 2D/3D схемах ЖБИ и МФР, только чтение на копии БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "scheme-zoom-floor-"));
let browser;
try {
  const { base } = await startServer(8377, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await browser.goto(`${base}/?ui=v1&object_id=1`, 1200);
  await browser.waitFor("!!state.initialView && !!state.view && state.elements.length > 0", 30000);
  await browser.clickSel("#zoom-reset");
  const stage = await browser.rect("#stage");
  await browser.wheel(stage.cx, stage.cy, 800);
  assert.ok(await browser.eval("state.view.w <= state.initialView.w * (1 + 1e-8) && state.view.h <= state.initialView.h * (1 + 1e-8)"));
  assert.equal(await browser.eval("document.querySelector('#zoom-value').textContent"), "100%");
  await browser.wheel(stage.cx, stage.cy, -120);
  assert.ok(await browser.eval("state.view.w < state.initialView.w"));
  await browser.wheel(stage.cx, stage.cy, 800);
  assert.equal(await browser.eval("document.querySelector('#zoom-value').textContent"), "100%");
  console.log("PASS ЖБИ 2D: ниже 100% нельзя, приближение работает");

  await browser.clickSel("#btn-view-3d");
  await browser.waitFor("state.view3d.active && !!state.view3d.controls && !!state.view3d.homeDistance", 30000);
  await browser.clickSel("#zoom-reset-3d");
  const stage3d = await browser.rect("#stage-3d canvas");
  await browser.wheel(stage3d.cx, stage3d.cy, 800);
  assert.ok(await browser.eval("state.view3d.camera.position.distanceTo(state.view3d.controls.target) <= state.view3d.homeDistance * (1 + 1e-8)"));
  assert.ok(await browser.eval("state.view3d.controls.maxDistance === state.view3d.homeDistance"));
  console.log("PASS ЖБИ 3D: отдаление ограничено исходным ракурсом");

  await browser.goto(`${base}/?ui=v1&object_id=4`, 1200);
  await browser.waitFor("state.objectId === 4 && !!revitPlanState.view && !!revitPlanState.fit && !!document.querySelector('#revit-plan-svg')", 30000);
  await browser.clickSel("#mfr-plan-zoom-reset");
  const mfrPlan = await browser.rect("#revit-plan-svg");
  await browser.wheel(mfrPlan.cx, mfrPlan.cy, 800);
  assert.ok(await browser.eval("revitPlanState.view.w <= revitPlanState.fit.w * (1 + 1e-8) && revitPlanState.view.h <= revitPlanState.fit.h * (1 + 1e-8)"));
  assert.equal(await browser.eval("document.querySelector('#mfr-plan-zoom-value').textContent"), "100%");
  await browser.wheel(mfrPlan.cx, mfrPlan.cy, -120);
  assert.ok(await browser.eval("revitPlanState.view.w < revitPlanState.fit.w"));
  console.log("PASS МФР 2D: ниже 100% нельзя, приближение работает");

  await browser.clickSel('#mfr-view-switch [data-mfr-mode="3d"]');
  await browser.waitFor("!!mfr3d.camera && !!mfr3d.controls && !!mfr3d.homeDistance", 30000);
  await browser.clickSel("#mfr-3d-zoom-reset");
  const mfr3dCanvas = await browser.rect("#mfr-3d-canvas canvas");
  await browser.wheel(mfr3dCanvas.cx, mfr3dCanvas.cy, 800);
  assert.ok(await browser.eval("mfr3d.camera.position.distanceTo(mfr3d.controls.target) <= mfr3d.homeDistance * (1 + 1e-8)"));
  assert.ok(await browser.eval("mfr3d.controls.maxDistance === mfr3d.homeDistance"));
  console.log("PASS МФР 3D: отдаление ограничено исходным ракурсом");

  for (const [objectId, route, zoomSelector] of [
    [1, "ws-model", "#zoom-value"],
    [4, "ws-mfr", "#mfr-plan-zoom-value"],
  ]) {
    await browser.goto(`${base}/v2?object_id=${objectId}#/${route}`, 1200);
    await browser.waitFor(`!!document.querySelector('.ws-frame')?.contentDocument?.querySelector('${zoomSelector}') && !!document.querySelector('.ws-tools [data-tool="out"]')`, 30000);
    await browser.waitFor(`document.querySelector('.ws-frame').contentDocument.querySelector('${zoomSelector}').textContent !== '—'`, 30000);
    if (route === "ws-mfr") {
      await browser.clickSel('.ws-seg [data-view="2d"]');
      await browser.waitFor(`document.querySelector('.ws-seg [data-view="2d"]').getAttribute('aria-pressed') === 'true'`, 10000);
    }
    await browser.clickSel('.ws-tools [data-tool="fit"]');
    await browser.waitFor(`document.querySelector('.ws-frame').contentDocument.querySelector('${zoomSelector}').textContent === '100%'`, 10000);
    await browser.clickSel('.ws-tools [data-tool="out"]');
    await browser.clickSel('.ws-tools [data-tool="out"]');
    assert.equal(await browser.eval(`document.querySelector('.ws-frame').contentDocument.querySelector('${zoomSelector}').textContent`), "100%");
    await browser.clickSel('.ws-tools [data-tool="in"]');
    await browser.waitFor(`document.querySelector('.ws-frame').contentDocument.querySelector('${zoomSelector}').textContent !== '100%'`, 10000);
    await browser.clickSel('.ws-tools [data-tool="out"]');
    await browser.waitFor(`document.querySelector('.ws-frame').contentDocument.querySelector('${zoomSelector}').textContent === '100%'`, 10000);
    console.log(`PASS V2 ${route}: кнопки масштаба соблюдают нижний предел 100%`);
  }
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} catch (error) {
  if (browser) console.log("DIAG", await browser.eval("JSON.stringify({objectId:state.objectId,stage3d:document.querySelector('#stage-3d')?.style.display,active:state.view3d.active,controls:!!state.view3d.controls,home:state.view3d.homeDistance,errors:document.querySelector('#stage-3d-hint')?.textContent})").catch(() => "недоступно"), browser.exceptions.slice(-3), browser.consoleLog.slice(-3));
  throw error;
} finally {
  await browser?.close();
  await stopServer();
}
