// Настоящее перетаскивание соседних стоянок на временной обезличенной БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";
import { overlapArea, peerOverlap } from "../app/static/v2/zone-overlap.js";

const rect = (x) => [[x, 0], [x + 100, 0], [x + 100, 100], [x, 100]];
const own = { id: 1, category: "Стоянка" };
const peer = { id: 2, category: "Стоянка", levels: [{ elevation_mm: 0, outline: rect(100) }] };
const collision = peerOverlap([own, peer], own, 0, rect(20));
assert.equal(collision.length, 1);
assert.deepEqual(collision[0].contact, [100, 50]);

const work = mkdtempSync(join(tmpdir(), "crane-collision-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  if (!await browser.eval("!!document.querySelector('#cz-draft-select')?.value && !document.querySelector('#cz-draft-select option:checked')?.textContent.includes('устарел')")) {
    await tap(browser, '#cz-new');
    await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value", 30000);
  }
  await tap(browser, '.cz-crane-toggle');
  const standId = await browser.eval("document.querySelectorAll('.cz-crane-stands:not([hidden]) .cz-stand')[1].dataset.zoneId");
  await tap(browser, `.cz-stand[data-zone-id="${standId}"]`);
  await browser.waitFor("JSON.parse(document.querySelector('#cz-canvas')?.dataset.edgeMidpoints || '[]').length === 4");
  const target = await browser.eval(`(async () => {
    const id = document.querySelector('#cz-draft-select').value;
    const draft = await (await fetch('/objects/1/crane-zone-versions/drafts/' + id)).json();
    const zone = draft.zones.find(z => z.id === ${Number(standId)}), level = zone.levels[0];
    const center = points => [points.reduce((n,p)=>n+p[0],0)/points.length, points.reduce((n,p)=>n+p[1],0)/points.length];
    const own = center(level.outline);
    const neighborOutlines = draft.zones.filter(z => z.category === 'Стоянка' && z.id !== zone.id)
      .map(z => z.levels.find(l => l.elevation_mm === level.elevation_mm)).filter(Boolean)
      .map(l => l.outline);
    const neighbors = neighborOutlines.map(center);
    const other = neighbors.sort((a,b)=>Math.hypot(a[0]-own[0],a[1]-own[1])-Math.hypot(b[0]-own[0],b[1]-own[1]))[0];
    const edges = JSON.parse(document.querySelector('#cz-canvas').dataset.edgeMidpoints);
    const mids = level.outline.map((p,i)=>[(p[0]+level.outline[(i+1)%4][0])/2,(p[1]+level.outline[(i+1)%4][1])/2]);
    const direction = [other[0]-own[0],other[1]-own[1]];
    const index = mids.map((p,i)=>({i,d:(p[0]-own[0])*direction[0]+(p[1]-own[1])*direction[1]})).sort((a,b)=>b.d-a.d)[0].i;
    const scale = edges[index].length / Math.hypot(...[level.outline[(index+1)%4][0]-level.outline[index][0],level.outline[(index+1)%4][1]-level.outline[index][1]]);
    return { index, edge:edges[index], dx:(other[0]-own[0])*scale, dy:-(other[1]-own[1])*scale,
      scale, worldMid:mids[index], neighborOutlines };
  })()`);
  const canvas = await browser.rect('#cz-canvas');
  const length = Math.hypot(target.dx, target.dy);
  await browser.drag(canvas.x + target.edge.x, canvas.y + target.edge.y,
    canvas.x + target.edge.x + target.dx / length * 110,
    canvas.y + target.edge.y + target.dy / length * 110, { steps: 24 });
  const draggedOutline = await browser.eval(`[...document.querySelectorAll('.cz-point-list span')]
    .map(e => e.textContent.match(/^\\d+\\.\\s+(-?[\\d.]+);\\s+(-?[\\d.]+)$/))
    .map(m => [Number(m[1]), Number(m[2])])`);
  assert.ok(target.neighborOutlines.every((outline) => overlapArea(draggedOutline, outline) <= 1),
    "перетаскивание ребра допустило пересечение ещё до сохранения черновика");
  assert.equal(await browser.eval("document.querySelector('#cz-collision').classList.contains('is-visible')"), true);
  assert.equal(await browser.eval("document.querySelector('#cz-feedback').textContent.includes('Грань достигла')"), false);
  await browser.waitFor("Number(getComputedStyle(document.querySelector('#cz-collision')).opacity) > .8", 1200, 50);
  const pin = await browser.eval(`(() => {
    const svg = document.querySelector('#cz-collision-tail');
    const points = svg.querySelector('polygon').getAttribute('points').split(' ').map(p=>p.split(',').map(Number));
    const map = document.querySelector('.cz-map').getBoundingClientRect();
    const canvas = document.querySelector('#cz-canvas').getBoundingClientRect();
    return { point:points[1], x:canvas.left-map.left, y:canvas.top-map.top,
      anchored:points[1][0]===Number(svg.dataset.contactX) && points[1][1]===Number(svg.dataset.contactY) };
  })()`);
  assert.equal(pin.anchored, true, "кончик не доходит до рассчитанной точки контакта");
  const world = [target.worldMid[0] + (pin.point[0] - pin.x - target.edge.x) / target.scale,
    target.worldMid[1] - (pin.point[1] - pin.y - target.edge.y) / target.scale];
  const edgeDistance = (a, b) => {
    const dx = b[0]-a[0], dy=b[1]-a[1], t=Math.max(0,Math.min(1,
      ((world[0]-a[0])*dx+(world[1]-a[1])*dy)/(dx*dx+dy*dy)));
    return Math.hypot(world[0]-a[0]-t*dx,world[1]-a[1]-t*dy);
  };
  const nearestBoundary = Math.min(...target.neighborOutlines.flatMap(points =>
    points.map((point,i) => edgeDistance(point,points[(i+1)%points.length]))));
  assert.ok(nearestBoundary < .01, `кончик вне границы соседней стоянки: ${nearestBoundary} мм`);
  if (process.env.ZONE_COLLISION_2D_SHOT) await browser.shot(process.env.ZONE_COLLISION_2D_SHOT);
  console.log("PASS 2D: предупреждение возле контакта, вне строки статуса");

  await browser.waitFor("!document.querySelector('#cz-collision').classList.contains('is-visible')", 4000);
  const edges2d = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
  const zoneCenter = edges2d.reduce((sum, edge) => [sum[0] + edge.x / 4, sum[1] + edge.y / 4], [0, 0]);
  await browser.drag(canvas.x + zoneCenter[0], canvas.y + zoneCenter[1],
    canvas.x + zoneCenter[0] + target.dx / length * 110,
    canvas.y + zoneCenter[1] + target.dy / length * 110, { steps: 24 });
  assert.equal(await browser.eval("document.querySelector('#cz-collision').classList.contains('is-visible')"), true);
  console.log("PASS 2D: перенос всей стоянки показывает тот же указатель");

  await tap(browser, '#cz-view-3d');
  await browser.waitFor("JSON.parse(document.querySelector('#cz-3d')?.dataset.edgeMidpoints || '[]').length === 4", 30000);
  const handles = JSON.parse(await browser.eval("document.querySelector('#cz-3d').dataset.edgeMidpoints"));
  const grip = handles[target.index];
  const center = handles.reduce((s,p)=>[s[0]+p.x/4,s[1]+p.y/4],[0,0]);
  const outward = [grip.x-center[0],grip.y-center[1]], distance = Math.hypot(...outward);
  const view = await browser.rect('#cz-3d canvas');
  await browser.drag(view.x + grip.x, view.y + grip.y,
    view.x + grip.x + outward[0] / distance * 110,
    view.y + grip.y + outward[1] / distance * 110, { steps: 24 });
  assert.equal(await browser.eval("document.querySelector('#cz-collision').classList.contains('is-visible')"), true);
  await browser.waitFor("Number(getComputedStyle(document.querySelector('#cz-collision')).opacity) > .8", 1200, 50);
  if (process.env.ZONE_COLLISION_3D_SHOT) await browser.shot(process.env.ZONE_COLLISION_3D_SHOT);
  console.log("PASS 3D: предупреждение возле контакта");
  await browser.sleep(2200);
  assert.equal(await browser.eval("document.querySelector('#cz-collision').classList.contains('is-visible')"), false);
  console.log("PASS: предупреждение плавно исчезает");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
