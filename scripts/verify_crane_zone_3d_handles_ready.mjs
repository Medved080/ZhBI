// Ручки выбранной стоянки должны быть готовы вместе с 3D-схемой; выбор другой
// стоянки и первый щелчок не должны пересоздавать холст или двигать камеру.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-handles-ready-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle') && !!document.querySelector('#cz-draft-select')?.value", 30000);
  await tap(browser, '.cz-crane-toggle');
  const ids = await browser.eval("[...document.querySelectorAll('.cz-crane-stands:not([hidden]) .cz-stand')].slice(0,2).map(e=>e.dataset.zoneId)");
  await tap(browser, `.cz-stand[data-zone-id="${ids[0]}"]`);
  await browser.waitFor("!!document.querySelector('#cz-canvas')?.dataset.edgeMidpoints", 30000);
  const canvas2d = await browser.rect('#cz-canvas');
  const points2d = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
  assert.equal(points2d.length, 4);
  assert.ok(points2d.every((point) => Number.isFinite(point.angle)), "на 2D-ручках нет направления");
  await browser.move(canvas2d.x + points2d[0].x, canvas2d.y + points2d[0].y);
  const cursor2dA = await browser.eval("document.querySelector('#cz-canvas').style.cursor");
  await browser.move(canvas2d.x + points2d[1].x, canvas2d.y + points2d[1].y);
  const cursor2dB = await browser.eval("document.querySelector('#cz-canvas').style.cursor");
  assert.ok(cursor2dA.includes('data:image/svg+xml') && cursor2dB.includes('data:image/svg+xml'));
  assert.notEqual(cursor2dA, cursor2dB, "соседние грани 2D показывают один курсор");
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
  assert.equal(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length"), 4,
    "ручки не появились вместе с 3D-холстом");
  const points3d = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  assert.ok(points3d.every((point) => Number.isFinite(point.angle)), "на 3D-ручках нет направления");
  assert.equal(await browser.eval("[...document.querySelectorAll('#cz-3d .cz-3d-grip')].every((grip, index) => Math.abs(parseFloat(grip.style.getPropertyValue('--cz-resize-angle')) - JSON.parse(document.querySelector('#cz-3d').dataset.edgeMidpoints)[index].angle) < .001)"), true);
  const initialCanvas3d = await browser.rect('#cz-3d canvas');
  await browser.move(initialCanvas3d.x + points3d[0].x, initialCanvas3d.y + points3d[0].y);
  const cursor3dA = await browser.eval("document.querySelector('#cz-3d canvas').style.cursor");
  await browser.move(initialCanvas3d.x + points3d[1].x, initialCanvas3d.y + points3d[1].y);
  const cursor3dB = await browser.eval("document.querySelector('#cz-3d canvas').style.cursor");
  assert.ok(cursor3dA.includes('data:image/svg+xml') && cursor3dB.includes('data:image/svg+xml'));
  assert.notEqual(cursor3dA, cursor3dB, "соседние грани 3D показывают один курсор");
  if (process.env.RESIZE_DIRECTION_SHOTS) await browser.shot(`${process.env.RESIZE_DIRECTION_SHOTS}-3d.png`);
  await browser.eval("window.__craneHost=document.querySelector('#cz-3d');window.__craneCanvas=window.__craneHost.querySelector('canvas')");
  await tap(browser, `.cz-stand[data-zone-id="${ids[1]}"]`);
  assert.equal(await browser.eval("document.querySelector('#cz-3d') === window.__craneHost"), true,
    "хост 3D пересоздан при выборе стоянки");
  assert.equal(await browser.eval("document.querySelector('#cz-3d canvas') === window.__craneCanvas"), true);
  assert.equal(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length"), 4,
    "ручки выбранной стоянки появились с задержкой");
  await browser.sleep(200);
  const before = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  const canvas = await browser.rect('#cz-3d canvas');
  const edge = [...before].sort((a,b)=>b.length-a.length)[0];
  await browser.click(canvas.x+edge.x,canvas.y+edge.y);
  await browser.sleep(500);
  const after = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  const cameraShift = Math.max(...before.map((p,i)=>Math.hypot(p.x-after[i].x,p.y-after[i].y)));
  assert.ok(cameraShift < 1,
    `после первого щелчка схема изменила положение: ${cameraShift.toFixed(1)} px`);
  await tap(browser, '#cz-view-2d');
  await browser.waitFor("!!document.querySelector('#cz-canvas')?.dataset.edgeMidpoints", 30000);
  if (process.env.RESIZE_DIRECTION_SHOTS) await browser.shot(`${process.env.RESIZE_DIRECTION_SHOTS}-2d.png`);
  const resizePoints = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
  const resizeEdge = [...resizePoints].sort((a,b)=>b.length-a.length)[0];
  const center = resizePoints.reduce((sum,p)=>[sum[0]+p.x/resizePoints.length,sum[1]+p.y/resizePoints.length],[0,0]);
  const toward = [center[0]-resizeEdge.x,center[1]-resizeEdge.y];
  const distance = Math.hypot(...toward);
  const resizeCanvas = await browser.rect('#cz-canvas');
  await browser.drag(resizeCanvas.x+resizeEdge.x,resizeCanvas.y+resizeEdge.y,
    resizeCanvas.x+resizeEdge.x+toward[0]/distance*8,
    resizeCanvas.y+resizeEdge.y+toward[1]/distance*8);
  assert.equal(await browser.eval("!!document.querySelector('#cz-save:not(:disabled)')"), true,
    "2D-ручка не захватывается за видимый значок");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: стрелки и курсоры показывают направление в 2D/3D; ручки готовы сразу, первый щелчок не двигает схему");
} finally {
  await browser?.close();
  await stopServer();
}
