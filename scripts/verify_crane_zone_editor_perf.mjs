// Замеры на изолированной обезличенной копии с черновиком; ничего не публикует.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-zone-perf-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await browser.eval("window.__zoneLongTasks=[];new PerformanceObserver(list=>window.__zoneLongTasks.push(...list.getEntries().map(e=>Math.round(e.duration)))).observe({type:'longtask',buffered:true})");
  let t = Date.now();
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.renderedOutlines) > 9000", 30000);
  console.log(`Страница с черновиком и контурами: ${Date.now() - t} мс`);
  await tap(browser, '.cz-crane-toggle');
  const stands = await browser.eval("[...document.querySelectorAll('.cz-crane-stands:not([hidden]) .cz-stand')].slice(0,2).map(e=>({id:e.dataset.zoneId,name:e.textContent.trim()}))");
  t = Date.now();
  await tap(browser, `.cz-stand[data-zone-id="${stands[0].id}"]`);
  await browser.waitFor(`document.querySelector('.cz-stand[data-zone-id="${stands[0].id}"]')?.classList.contains('active')`, 30000);
  console.log(`Выбор стоянки в 2D: ${Date.now() - t} мс`);
  t = Date.now();
  await tap(browser, '#cz-view-3d');
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions'", 30000);
  console.log(`2D → 3D с изделиями: ${Date.now() - t} мс`);
  console.log(`Первая сборка геометрии: ${await browser.eval("document.querySelector('#cz-3d').dataset.modelBuildMs")} мс`);
  t = Date.now();
  await tap(browser, `.cz-stand[data-zone-id="${stands[1].id}"]`);
  await browser.waitFor(`document.querySelector('.cz-stand[data-zone-id="${stands[1].id}"]')?.classList.contains('active') && document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions'`, 30000);
  console.log(`Выбор соседней стоянки в 3D: ${Date.now() - t} мс`);
  console.log(`Сборка после выбора: ${await browser.eval("document.querySelector('#cz-3d').dataset.modelBuildMs")} мс`);
  const handles = await browser.eval("JSON.parse(document.querySelector('#cz-3d').dataset.edgeMidpoints || '[]')");
  assert.equal(await browser.eval("document.querySelectorAll('#cz-3d .cz-3d-grip').length"), 4);
  assert.equal(await browser.eval("getComputedStyle(document.querySelector('#cz-3d .cz-3d-grip')).backgroundColor"), "rgb(239, 107, 51)");
  if (process.env.ZONE_GRIP_SHOT) await browser.shot(process.env.ZONE_GRIP_SHOT);
  const edge = [...handles].sort((a, b) => b.length - a.length)[0];
  const center = handles.reduce((sum, item) => [sum[0] + item.x / handles.length, sum[1] + item.y / handles.length], [0, 0]);
  const inward = [center[0] - edge.x, center[1] - edge.y];
  const distance = Math.hypot(...inward);
  const canvas = await browser.rect("#cz-3d canvas");
  t = Date.now();
  await browser.drag(canvas.x + edge.x, canvas.y + edge.y,
    canvas.x + edge.x + inward[0] / distance * 14,
    canvas.y + edge.y + inward[1] / distance * 14);
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')", 30000);
  console.log(`Изменение размера через видимую ручку: ${Date.now() - t} мс`);
  console.log(`Долгие задачи браузера: ${JSON.stringify((await browser.eval("window.__zoneLongTasks")).sort((a,b)=>b-a).slice(0,10))}`);
  console.log(`Ошибок JavaScript: ${browser.exceptions.length}`);
} finally {
  await browser?.close();
  await stopServer();
}
