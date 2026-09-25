// Проверка настоящим жестом мыши на временной копии БД. Не публикует редакцию.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-edge-"));
let browser;
async function edgeCandidate() {
  return browser.eval(`(async () => {
    const prefix = '/objects/1/crane-zone-versions';
    const draftId = Number(document.querySelector('#cz-draft-select').value);
    const draft = await (await fetch(prefix + '/drafts/' + draftId)).json();
    const scene = await (await fetch(prefix + '/scene')).json();
    const zoneId = Number(document.querySelector('.cz-tree-item.active').dataset.zoneId);
    const zone = draft.zones.find(z => z.id === zoneId);
    const points = draft.zones.filter(z => z.category === 'Кран').flatMap(z => z.levels.flatMap(l => l.outline));
    for (const item of scene.elements) if (Number.isFinite(item.x) && Number.isFinite(item.y)) points.push([item.x, item.y]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    const canvas = document.querySelector('#cz-canvas'), rect = canvas.getBoundingClientRect();
    const scale = Math.min(canvas.clientWidth / (Math.max(1, maxX - minX) * 1.18), canvas.clientHeight / (Math.max(1, maxY - minY) * 1.18));
    const screen = p => [rect.left + (p[0] - centerX) * scale + canvas.clientWidth / 2, rect.top + (centerY - p[1]) * scale + canvas.clientHeight / 2];
    const outline = zone.levels[0].outline;
    const edges = outline.map((a, i) => { const p = screen(a), q = screen(outline[(i + 1) % outline.length]); return { index: i, p, q, len: Math.hypot(q[0] - p[0], q[1] - p[1]) }; });
    const edge = edges.sort((a, b) => b.len - a.len)[0];
    return { draftId, zoneId, outline, index: edge.index, length: edge.len, x: (edge.p[0] + edge.q[0]) / 2, y: (edge.p[1] + edge.q[1]) / 2, dx: -(edge.q[1] - edge.p[1]) / edge.len * 12, dy: (edge.q[0] - edge.p[0]) / edge.len * 12 };
  })()`);
}
async function dragAndVerify(label) {
  const before = await edgeCandidate();
  assert.ok(before.length > 25, `ребро слишком короткое на схеме: ${before.length}px`);
  await browser.drag(before.x, before.y, before.x + before.dx, before.y + before.dy);
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')");
  assert.match(await browser.eval("document.querySelector('#cz-status').textContent"), /несохранённые изменения/);
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  const after = await browser.eval(`(async () => {
    const draft = await (await fetch('/objects/1/crane-zone-versions/drafts/${before.draftId}')).json();
    return draft.zones.find(z => z.id === ${before.zoneId}).levels[0].outline;
  })()`);
  const i = before.index, j = (i + 1) % before.outline.length;
  const shiftA = [after[i][0] - before.outline[i][0], after[i][1] - before.outline[i][1]];
  const shiftB = [after[j][0] - before.outline[j][0], after[j][1] - before.outline[j][1]];
  assert.ok(Math.hypot(...shiftA) > 0, "ребро не сдвинулось");
  assert.ok(Math.hypot(shiftA[0] - shiftB[0], shiftA[1] - shiftB[1]) < 1e-7, "концы ребра сдвинулись по-разному");
  console.log(`PASS ${label}: ребро перетащено и сохранено в черновик без изменения направления`);
}
try {
  const { base } = await startServer(8379, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Кран]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('#cz-add-crane')");
  await tap(browser, "#cz-add-crane");
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')");
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')");
  await tap(browser, "#cz-fit");
  if (process.env.EDGE_SHOT) await browser.shot(process.env.EDGE_SHOT);

  await dragAndVerify("V2");
  await browser.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-zones-crane`, 1000);
  await browser.waitFor("!!document.querySelector('.cz-v1-modal .cz-root') && !!document.querySelector('.cz-v1-modal .cz-tree-item[data-zone-id=\"-1\"]')", 30000);
  await tap(browser, '.cz-v1-modal .cz-tree-item[data-zone-id="-1"]');
  await tap(browser, "#cz-fit");
  await dragAndVerify("V1");
  assert.equal(browser.requests.filter(r => /\/publish$/.test(r.url)).length, 0, "публикация не должна вызываться");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
