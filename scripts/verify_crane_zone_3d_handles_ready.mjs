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
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
  assert.equal(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length"), 4,
    "ручки не появились вместе с 3D-холстом");
  await browser.eval("window.__craneHost=document.querySelector('#cz-3d');window.__craneCanvas=window.__craneHost.querySelector('canvas')");
  await tap(browser, `.cz-stand[data-zone-id="${ids[1]}"]`);
  assert.equal(await browser.eval("document.querySelector('#cz-3d') === window.__craneHost"), true,
    "хост 3D пересоздан при выборе стоянки");
  assert.equal(await browser.eval("document.querySelector('#cz-3d canvas') === window.__craneCanvas"), true);
  assert.equal(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length"), 4,
    "ручки выбранной стоянки появились с задержкой");
  const before = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  const canvas = await browser.rect('#cz-3d canvas');
  const edge = [...before].sort((a,b)=>b.length-a.length)[0];
  await browser.click(canvas.x+edge.x,canvas.y+edge.y);
  await browser.sleep(500);
  const after = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  assert.ok(Math.max(...before.map((p,i)=>Math.hypot(p.x-after[i].x,p.y-after[i].y))) < 1,
    "после первого щелчка схема изменила положение");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: ручки готовы при открытии 3D и выборе стоянки; первый щелчок не двигает схему");
} finally {
  await browser?.close();
  await stopServer();
}
