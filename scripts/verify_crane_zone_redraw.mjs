// Рисование нового ортогонального контура мышью в настоящем редакторе.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-redraw-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('.cz-crane-toggle')", 30000);
  if (!await browser.eval("!!document.querySelector('#cz-draft-select')?.value && !document.querySelector('#cz-draft-select option:checked')?.textContent.includes('устарел')")) {
    await tap(browser, "#cz-new");
    await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value", 30000);
  }
  const crane = await browser.eval("[...document.querySelectorAll('.cz-crane-toggle')].find(e => e.textContent.includes('Кран 3'))?.dataset.craneToggle");
  assert.ok(crane);
  await tap(browser, `.cz-crane-toggle[data-crane-toggle="${crane}"]`);
  const stance = await browser.eval(`[...document.querySelector('.cz-crane-toggle[data-crane-toggle="${crane}"]').closest('.cz-crane').querySelectorAll('.cz-stand')].find(e => e.textContent.includes('Стоянка 11'))?.dataset.zoneId`);
  assert.ok(stance);
  await tap(browser, `.cz-stand[data-zone-id="${stance}"]`);
  await browser.waitFor("!!document.querySelector('#cz-redraw-polygon')", 10000);
  const initial = await browser.eval("[...document.querySelectorAll('.cz-point-list span')].map(e => e.textContent)");
  await tap(browser, "#cz-redraw-polygon");
  assert.equal(await browser.eval("!!document.querySelector('.cz-draw-guide')"), true);

  const shape = await browser.eval(`(() => {
    const vertices = [...document.querySelectorAll('.cz-point-list span')].map(e => {
      const m = e.textContent.match(/^\\d+\\.\\s+(-?[\\d.]+);\\s+(-?[\\d.]+)$/);
      return m ? [Number(m[1]), Number(m[2])] : null;
    });
    if (vertices.some(p => !p)) return null;
    const handles = JSON.parse(document.querySelector('#cz-canvas').dataset.edgeMidpoints || '[]');
    // В режиме рисования ручки скрыты, поэтому масштаб берём из вписанного вида:
    // сначала найдем вершины по цвету нельзя; до включения режима масштаб
    // можно восстановить из прежних ручек, сохранённых ниже.
    return { vertices, handles };
  })()`);
  assert.equal(shape.handles.length, 0, "ручки должны скрываться во время рисования");
  // Для выбранной стоянки центр карты получается из габаритов контура: при
  // выборе стоянки 2D автоматически вписывает её контур с 18% полями.
  const canvas = await browser.rect("#cz-canvas");
  const xs = shape.vertices.map(p => p[0]), ys = shape.vertices.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const scale = Math.min(canvas.w / ((x1 - x0) * 1.18), canvas.h / ((y1 - y0) * 1.18));
  const project = ([x, y]) => [canvas.x + canvas.w / 2 + (x - (x0 + x1) / 2) * scale,
    canvas.y + canvas.h / 2 - (y - (y0 + y1) / 2) * scale];
  const inside = (point) => {
    let yes = false;
    for (let i = 0, j = shape.vertices.length - 1; i < shape.vertices.length; j = i++) {
      const a = shape.vertices[i], b = shape.vertices[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  };
  let square = null;
  const stepX = (x1 - x0) / 35, stepY = (y1 - y0) / 35;
  const halfX = Math.max(2, Math.min((x1 - x0) / 12, 20 / scale));
  const halfY = Math.max(2, Math.min((y1 - y0) / 12, 20 / scale));
  for (let x = x0 + 3 * stepX; x < x1 - 3 * stepX && !square; x += stepX) {
    for (let y = y0 + 3 * stepY; y < y1 - 3 * stepY; y += stepY) {
      const corners = [[x - halfX, y - halfY], [x + halfX, y - halfY], [x + halfX, y + halfY], [x - halfX, y + halfY]];
      if (corners.every(inside)) { square = corners; break; }
    }
  }
  assert.ok(square, "не нашлось места для тестового прямоугольника внутри стоянки");
  for (const point of square.slice(0, 3)) await browser.click(...project(point));
  assert.deepEqual(await browser.eval("[...document.querySelectorAll('.cz-point-list span')].map(e => e.textContent)"), initial,
    "до замыкания исходный контур должен оставаться неизменным");
  await browser.click(...project(square[0]));
  await browser.waitFor("!document.querySelector('.cz-draw-guide')", 10000);
  const next = await browser.eval("[...document.querySelectorAll('.cz-point-list span')].map(e => e.textContent)");
  assert.equal(next.length, 4, "замкнутый прямоугольник должен содержать четыре точки");
  assert.notDeepEqual(next, initial);
  assert.equal(await browser.eval("!!document.querySelector('#cz-save:not(:disabled)')"), true);
  await tap(browser, '#cz-save');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Черновик сохранён')", 30000);
  const stored = await browser.eval(`(async () => {
    const id = document.querySelector('#cz-draft-select').value;
    const draft = await (await fetch('/objects/1/crane-zone-versions/drafts/' + id)).json();
    return draft.zones.find(z => z.id === ${Number(stance)}).levels[0].outline;
  })()`);
  assert.equal(stored.length, 4, "новый контур должен сохраниться в том же черновике");
  assert.equal(browser.exceptions.length, 0, JSON.stringify(browser.exceptions));
  console.log("PASS: новый ортогональный контур нарисован и замкнут в 2D, исходный остаётся до замыкания");
} finally {
  await browser?.close();
  await stopServer();
}
