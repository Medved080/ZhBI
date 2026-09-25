// Реальные жесты 2D на временной копии БД: перенос зоны, вписанная стоянка,
// прокрутка дерева. Рабочий сервер 8000 и его база не затрагиваются.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";
import { overlapArea, polygonArea } from "../app/static/v2/zone-overlap.js";
import { countElementsInZone } from "../app/static/v2/zone-live-count.js";

const work = mkdtempSync(join(tmpdir(), "crane-move-"));
let browser;
const close = (a, b) => Math.abs(a - b) < 1e-6;
async function draft() {
  return browser.eval(`(async()=>{
    const id = Number(document.querySelector('#cz-draft-select').value);
    return (await (await fetch('/objects/1/crane-zone-versions/drafts/' + id)).json());
  })()`);
}
async function centerOfActive() {
  return browser.eval(`(()=>{
    const canvas = document.querySelector('#cz-canvas'), rect = canvas.getBoundingClientRect();
    const edges = JSON.parse(canvas.dataset.edgeMidpoints || '[]');
    if (edges.length !== 4) return null;
    return {x:rect.left + edges.reduce((s,e)=>s+e.x,0)/4,
      y:rect.top + edges.reduce((s,e)=>s+e.y,0)/4,
      minLength:Math.min(...edges.map(e=>e.length))};
  })()`);
}
async function zoomToInterior() {
  for (let i = 0; i < 9; i++) {
    const center = await centerOfActive();
    assert.ok(center, "не найден выбранный контур");
    if (center.minLength > 35) return center;
    await browser.wheel(center.x, center.y, -180);
  }
  const center = await centerOfActive();
  assert.ok(center.minLength > 25, `контур слишком мал для захвата изнутри: ${center.minLength}`);
  return center;
}
async function save() {
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')");
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.startsWith('Черновик сохранён')", 30000);
}
try {
  const { base } = await startServer(8377, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-add-crane')");
  await tap(browser, "#cz-add-crane");
  await browser.waitFor("document.querySelector('.cz-tree-item[data-zone-id=\"-1\"] b')?.textContent.startsWith('≈')", 30000);
  assert.match(await browser.eval("document.querySelector('.cz-tree-item.active b').textContent"), /^≈\d+$/,
    "черновик должен сразу показывать предварительное количество изделий");
  await save();
  await tap(browser, '.cz-tree-item[data-zone-id="-1"]');
  await tap(browser, "#cz-fit");
  const beforeMove = await draft();
  const craneBefore = beforeMove.zones.find((z) => z.id === -1);
  const center = await zoomToInterior();
  let moved = false;
  for (const [dx, dy] of [[15, 0], [-15, 0], [0, 15], [0, -15]]) {
    await browser.drag(center.x, center.y, center.x + dx, center.y + dy);
    if (await browser.eval("!document.querySelector('#cz-save').disabled")) { moved = true; break; }
  }
  assert.ok(moved, "зону не удалось переместить изнутри в свободном направлении");
  await save();
  const afterMove = await draft();
  const craneMoved = afterMove.zones.find((z) => z.id === -1);
  const scene = await browser.eval("(async()=> (await (await fetch('/objects/1/crane-zone-versions/scene')).json()).elements)()");
  const liveBadge = await browser.eval("document.querySelector('.cz-tree-item.active b').textContent");
  const expectedCount = countElementsInZone(craneMoved, scene);
  assert.equal(liveBadge, `≈${expectedCount}`,
    "число в дереве должно соответствовать текущему контуру");
  assert.match(await browser.eval("document.querySelector('#cz-live-count').textContent"),
    new RegExp(`≈${expectedCount} изделий`), "число должно быть видно и в свойствах выбранной зоны");
  const offsets = craneMoved.levels[0].outline.map((point, i) =>
    [point[0] - craneBefore.levels[0].outline[i][0], point[1] - craneBefore.levels[0].outline[i][1]]);
  assert.ok(Math.hypot(...offsets[0]) > 0, "зона не сдвинулась");
  const firstOffset = offsets[0];
  assert.ok(offsets.every((offset) => close(offset[0], firstOffset[0]) && close(offset[1], firstOffset[1])),
    "перемещение исказило форму зоны");
  console.log("PASS V2: контур захвачен внутри, перенесён без изменения формы и сохранён");

  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor('!!document.querySelector("#cz-add-stand")');
  await tap(browser, '.cz-tree-item[data-zone-id="-1"]');
  await tap(browser, "#cz-add-stand");
  await save();
  const withStance = await draft();
  const stanceBefore = withStance.zones.find((z) => z.category === "Стоянка" && z.parent_zone_id === -1);
  assert.ok(stanceBefore, "новая стоянка не создана");

  // После выбора другой стоянки дерево остаётся на прежней позиции.
  const manyStances = await browser.eval(`(()=>{
    const group=[...document.querySelectorAll('.cz-crane')].find((item)=>item.querySelectorAll('.cz-stand').length>5);
    if (!group) return false;
    group.querySelector('.cz-tree-item').click(); return true;
  })()`);
  assert.ok(manyStances, "не найден кран с длинным списком стоянок");
  const scroll = await browser.eval(`(()=>{
    const tree=document.querySelector('.cz-tree'); tree.scrollTop=250;
    return {top:tree.scrollTop,count:tree.querySelectorAll('.cz-stand').length};
  })()`);
  assert.ok(scroll.count > 5 && scroll.top > 0, "для проверки нужен прокручиваемый список стоянок");
  await browser.eval("document.querySelectorAll('.cz-tree .cz-stand')[5].click()");
  const held = await browser.eval(`(()=>{
    const tree=document.querySelector('.cz-tree'), head=tree.querySelector('.cz-tree-head');
    const t=tree.getBoundingClientRect(), h=head.getBoundingClientRect();
    return {top:tree.scrollTop, headerTop:h.top, treeTop:t.top, buttonTop:head.querySelector('#cz-add-stand').getBoundingClientRect().top};
  })()`);
  assert.ok(Math.abs(held.top - scroll.top) < 2, "список стоянок перескочил при выборе");
  assert.ok(held.headerTop >= held.treeTop - 2 && held.buttonTop >= held.treeTop,
    "заголовок и кнопка не закреплены при прокрутке");
  console.log("PASS V2: прокрутка списка сохраняется, заголовок и кнопка закреплены");

  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor('!!document.querySelector("#cz-add-crane")');
  await tap(browser, '.cz-tree-item[data-zone-id="-1"]');
  await tap(browser, "#cz-fit");
  await zoomToInterior();
  const edge = await browser.eval(`(()=>{
    const canvas=document.querySelector('#cz-canvas'), r=canvas.getBoundingClientRect();
    const edges=JSON.parse(canvas.dataset.edgeMidpoints || '[]');
    const right=edges.sort((a,b)=>b.x-a.x)[0];
    return {x:r.left+right.x,y:r.top+right.y,length:right.length};
  })()`);
  assert.ok(edge.length > 20);
  await browser.drag(edge.x, edge.y, edge.x - 9, edge.y);
  await save();
  const resized = await draft();
  const craneAfter = resized.zones.find((z) => z.id === -1);
  const stanceAfter = resized.zones.find((z) => z.id === stanceBefore.id);
  assert.notDeepEqual(craneAfter.levels[0].outline, craneMoved.levels[0].outline);
  assert.notDeepEqual(stanceAfter.levels.map((l) => l.outline), stanceBefore.levels.map((l) => l.outline),
    "стояночные контуры не изменились вслед за краном");
  for (const level of stanceAfter.levels) {
    assert.ok(overlapArea(craneAfter.levels[0].outline, level.outline) >= Math.abs(polygonArea(level.outline)) - 1,
      "стоянка вышла за границы крана");
  }
  console.log("PASS V2: изменение грани крана подстроило стоянку и оставило её внутри");

  await browser.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-zones-crane`, 1000);
  await browser.waitFor('!!document.querySelector(".cz-v1-modal .cz-root")', 30000);
  await tap(browser, '.cz-v1-modal .cz-tree-item[data-zone-id="-1"]');
  await tap(browser, "#cz-fit");
  const v1Center = await zoomToInterior();
  let v1Moved = false;
  for (const [dx, dy] of [[15, 0], [-15, 0], [0, 15], [0, -15]]) {
    await browser.drag(v1Center.x, v1Center.y, v1Center.x + dx, v1Center.y + dy);
    if (await browser.eval("!document.querySelector('#cz-save').disabled")) { v1Moved = true; break; }
  }
  assert.ok(v1Moved, "в V1 зону не удалось перетащить изнутри");
  await save();
  const afterV1Move = await draft();
  const craneV1 = afterV1Move.zones.find((z) => z.id === -1);
  const stanceV1 = afterV1Move.zones.find((z) => z.id === stanceBefore.id);
  const craneShift = [craneV1.levels[0].outline[0][0] - craneAfter.levels[0].outline[0][0],
    craneV1.levels[0].outline[0][1] - craneAfter.levels[0].outline[0][1]];
  const stanceShift = [stanceV1.levels[0].outline[0][0] - stanceAfter.levels[0].outline[0][0],
    stanceV1.levels[0].outline[0][1] - stanceAfter.levels[0].outline[0][1]];
  assert.ok(close(craneShift[0], stanceShift[0]) && close(craneShift[1], stanceShift[1]),
    "при переносе крана стоянка должна перемещаться вместе с ним");
  console.log("PASS V1: кран и вложенная стоянка перемещаются вместе и сохраняются");
  assert.equal(browser.requests.filter((r) => /\/publish$/.test(r.url)).length, 0);
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
