// Живая проверка 3D-редактора на временной копии обезличенной БД. Публикации нет.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";
import { elementsOnStanceLevel } from "../app/static/v2/crane-zone-editor.js";

const elements = [
  { id: 1, elevation_mm: 0, element_type: "Колонна" },
  { id: 2, elevation_mm: 3000, element_type: "Колонна" },
  { id: 3, elevation_mm: 3000, element_type: "Ригель" },
  { id: 4, elevation_mm: 6000, element_type: "Плита перекрытия" },
  { id: 5, elevation_mm: null, element_type: "Колонна" },
];
const levels = [{ elevation_mm: 0 }, { elevation_mm: 3000 }, { elevation_mm: 6000 }];
assert.deepEqual(elementsOnStanceLevel(elements, levels, 0).map((e) => e.id), [1, 3]);
assert.deepEqual(elementsOnStanceLevel(elements, levels, 1).map((e) => e.id), [2, 4]);
console.log("PASS отбор изделий по ярусу: граничные ригели и плиты относятся к нижнему ярусу");

const work = mkdtempSync(join(tmpdir(), "crane-3d-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1,
    width: Number(process.env.ZONE_TEST_WIDTH) || 1366, height: Number(process.env.ZONE_TEST_HEIGHT) || 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-add-crane')");
  await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.renderedOutlines) > 9000", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-canvas').dataset.renderKind"), "outlines");
  const switch2d = await browser.rect("#cz-view-2d");
  if (process.env.ZONE_2D_SHOT) await browser.shot(process.env.ZONE_2D_SHOT);
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions'", 30000);
  const switch3d = await browser.rect("#cz-view-2d");
  assert.ok(Math.abs(switch2d.x - switch3d.x) < 1, "переключатель 2D/3D сдвинулся при смене режима");
  const craneOneHighlighted = Number(await browser.eval("document.querySelector('#cz-3d').dataset.highlightedElements"));
  assert.ok(craneOneHighlighted > 0);
  if (process.env.ZONE_CRANE_SHOT) await browser.shot(process.env.ZONE_CRANE_SHOT);
  const secondCrane = await browser.eval("document.querySelectorAll('.cz-tree-item:not(.cz-stand)')[1]?.dataset.zoneId");
  if (secondCrane) {
    await tap(browser, `.cz-tree-item[data-zone-id="${secondCrane}"]`);
    await browser.waitFor(`document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions' && Number(document.querySelector('#cz-3d')?.dataset.highlightedElements) > 0 && Number(document.querySelector('#cz-3d')?.dataset.highlightedElements) !== ${craneOneHighlighted}`, 10000);
    const recolored = Number(await browser.eval("document.querySelector('#cz-3d').dataset.highlightedElements"));
    assert.ok(recolored > 0);
    console.log(`PASS V2: выбор другого крана обновляет подсветку ${craneOneHighlighted} → ${recolored} изделий`);
  }
  await tap(browser, "#cz-view-2d");
  console.log("PASS V2: в 2D нарисованы контуры изделий; переключатель 2D/3D виден и не сдвигается");
  await tap(browser, "#cz-add-crane");
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')");
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("!!document.querySelector('#cz-3d canvas') && document.querySelector('#cz-3d').dataset.editable === 'true'", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-view-3d').getAttribute('aria-pressed')"), "true");
  const count = Number(await browser.eval("document.querySelector('#cz-3d').dataset.visibleElements"));
  assert.ok(count > 0);
  const frame = await browser.rect("#cz-3d canvas");
  if (process.env.ZONE_3D_SHOT) await browser.shot(process.env.ZONE_3D_SHOT);
  assert.ok(frame.w > 300 && frame.h > 200);
  await tap(browser, "#cz-zoom-in");
  assert.equal(await browser.eval("document.querySelector('#cz-zoom-value').textContent"), "110%");
  await tap(browser, "#cz-zoom-out");
  assert.equal(await browser.eval("document.querySelector('#cz-zoom-value').textContent"), "100%");
  console.log("PASS V2: 3D-схема открылась, доступна правка и масштаб 100–110%");

  assert.equal(await browser.eval("document.querySelector('#cz-3d').dataset.modelKind"), "extrusions");
  await tap(browser, "#cz-show-elements");
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'hidden'", 10000);
  await tap(browser, "#cz-show-elements");
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'extrusions'", 60000);
  assert.equal(Number(await browser.eval("document.querySelector('#cz-3d').dataset.modelCount")), count);
  if (process.env.ZONE_MODEL_SHOT) await browser.shot(process.env.ZONE_MODEL_SHOT);
  console.log(`PASS V2: слой из ${count} полупрозрачных объёмных изделий включается и выключается`);
  await tap(browser, "#cz-show-elements");
  await browser.waitFor("document.querySelector('#cz-3d')?.dataset.modelKind === 'hidden'", 10000);

  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  await browser.waitFor("!!document.querySelector('#cz-3d').dataset.edgeMidpoints", 5000);
  const edge = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"))
    .sort((a, b) => b.length - a.length)[0];
  assert.ok(edge.length > 20, `не хватает места для перетаскивания ребра: ${edge.length}`);
  await browser.drag(frame.x + edge.x, frame.y + edge.y, frame.x + edge.x + 18, frame.y + edge.y + 14);
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')", 5000);
  console.log("PASS V2: контур изменён перетаскиванием в 3D");
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-add-stand')", 30000);
  const stand = await browser.eval("document.querySelector('.cz-tree-item.cz-stand')?.dataset.zoneId || null");
  if (stand) {
    await tap(browser, `.cz-tree-item.cz-stand[data-zone-id="${stand}"]`);
    await browser.waitFor("!!document.querySelector('.cz-level[data-level]')");
    await browser.waitFor("Number(document.querySelector('#cz-canvas')?.dataset.renderedOutlines) > 0", 5000);
    const shown = Number((await browser.eval("document.querySelector('.cz-map-summary').textContent.match(/(\\d+) изделий/)?.[1]")) || 0);
    assert.ok(shown < count, `при выборе яруса список не сократился: ${shown} из ${count}`);
    await tap(browser, "#cz-view-3d");
    await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
    assert.equal(Number(await browser.eval("document.querySelector('#cz-3d').dataset.visibleElements")), shown);
    const highlighted = Number(await browser.eval("document.querySelector('#cz-3d').dataset.highlightedElements"));
    assert.ok(highlighted > 0 && highlighted < shown, `выделение выбранной стоянки: ${highlighted} из ${shown}`);
    console.log(`PASS V2: цвет стоянки применяется к ${highlighted} из ${shown} изделий`);
    if (process.env.ZONE_STAND_SHOT) await browser.shot(process.env.ZONE_STAND_SHOT);
    console.log(`PASS V2: стоянка показывает только ${shown} изделий выбранного яруса в 2D и 3D`);
    assert.equal(await browser.eval("document.querySelector('#cz-3d').dataset.editable"), "true");
    await browser.waitFor("!!document.querySelector('#cz-3d').dataset.edgeMidpoints", 5000);
    const standEdge = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"))
      .sort((a, b) => b.length - a.length)[0];
    const standFrame = await browser.rect("#cz-3d canvas");
    assert.ok(standEdge.length > 12);
    await browser.drag(standFrame.x + standEdge.x, standFrame.y + standEdge.y,
      standFrame.x + standEdge.x + 12, standFrame.y + standEdge.y + 12);
    await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')", 5000);
    console.log("PASS V2: контур стоянки изменён перетаскиванием в 3D");
    await tap(browser, "#cz-save");
    await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
    const levelsCount = Number(await browser.eval("document.querySelectorAll('.cz-level').length"));
    if (levelsCount > 1) {
      await tap(browser, '.cz-level[data-level="1"]');
      await browser.waitFor("!!document.querySelector('#cz-3d canvas')", 30000);
      const second = Number(await browser.eval("document.querySelector('#cz-3d').dataset.visibleElements"));
      assert.notEqual(second, shown, "выбор другого яруса должен изменить состав изделий");
      console.log(`PASS V2: переключение яруса меняет состав изделий: ${shown} → ${second}`);
    }
  }
  await browser.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-zones-crane`, 1000);
  await browser.waitFor("!!document.querySelector('.cz-v1-modal .cz-root')", 30000);
  const v1Switch2d = await browser.rect(".cz-v1-modal #cz-view-2d");
  assert.ok(v1Switch2d.w > 20 && v1Switch2d.x > 0);
  await tap(browser, "#cz-view-3d");
  await browser.waitFor("!!document.querySelector('.cz-v1-modal #cz-3d canvas')", 30000);
  const v1Switch3d = await browser.rect(".cz-v1-modal #cz-view-2d");
  assert.ok(Math.abs(v1Switch2d.x - v1Switch3d.x) < 1);
  console.log("PASS V1: тот же 3D-редактор доступен в текущем интерфейсе");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  assert.equal(browser.requests.filter((request) => /\/publish$/.test(request.url)).length, 0);
} finally {
  await browser?.close();
  await stopServer();
}
