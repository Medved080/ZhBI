// Run against the disposable, anonymized fixture on port 8043.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { launch } from './cdp.mjs';

const base = process.env.WORK_GROUPS_BASE || 'http://127.0.0.1:8043';
assert.equal(new URL(base).port, '8043', 'Use the disposable fixture');
const output = new URL('../output/work-group-viewport/', import.meta.url);
mkdirSync(output, { recursive: true });
const browser = await launch({ width: 1440, height: 900 });
const view = () => browser.eval("document.querySelector('.wg-map').getAttribute('viewBox').split(' ').map(Number)");
try {
  await browser.goto(`${base}/v2`, 700);
  await browser.eval("location.hash='#/zones'");
  await browser.waitFor("document.querySelector('#wg-zoom')?.textContent==='100%'", 20000);
  await browser.eval(readFileSync(new URL('./ui_align_audit.js', import.meta.url), 'utf8'));

  for (const [width, height] of [[1440, 900], [2560, 1440], [1440, 700]]) {
    await browser.viewport(width, height);
    await browser.eval("document.querySelector('#v2-content').scrollTop=0");
    const page = await browser.rect('#v2-content');
    await browser.wheel(page.x + page.w - 12, page.y + 60, 1200);
    await browser.sleep(250);
    assert.ok(await browser.eval("document.querySelector('#v2-content').scrollTop>0"), 'Page scrolls with the mouse wheel');
    await browser.eval("document.querySelector('.wg-map').scrollIntoView({block:'center'})");
    const map = await browser.rect('.wg-map');
    assert.ok(map.x >= page.x && map.x + map.w <= page.x + page.w + 1, 'Map fits page width');
    assert.ok(map.y >= page.y - 1 && map.y + map.h <= height + 1, 'Complete map is reachable inside the window');
    await browser.shot(new URL(`map-${width}x${height}.png`, output).pathname);
  }

  const map = await browser.rect('.wg-map');
  const initial = await view();
  const scrollTop = await browser.eval("document.querySelector('#v2-content').scrollTop");
  await browser.wheel(map.cx, map.cy, 100);
  await browser.sleep(100);
  let current = await view();
  assert.ok(Math.abs(current[2] / initial[2] - Math.sqrt(1.2)) < 1e-10, 'Wheel sensitivity is halved');
  const beforeSmallDelta = current[2];
  await browser.wheel(map.cx, map.cy, 1);
  await browser.sleep(100);
  current = await view();
  assert.ok(current[2] / beforeSmallDelta < 1.002, 'Small trackpad deltas remain small');
  for (let i = 0; i < 40; i++) await browser.wheel(map.cx, map.cy, 100);
  await browser.sleep(150);
  current = await view();
  assert.ok(Math.abs(initial[2] / current[2] - 0.25) < 1e-10, 'Minimum zoom is 25 percent');
  assert.equal(await browser.eval("document.querySelector('#wg-zoom').textContent"), '25%');
  for (let i = 0; i < 5; i++) await browser.wheel(map.cx, map.cy, 100);
  await browser.sleep(100);
  assert.deepEqual(await view(), current, 'Further scrolling at the limit does not move the map');
  assert.equal(await browser.eval("document.querySelector('#v2-content').scrollTop"), scrollTop, 'Map zoom does not scroll the page');

  await browser.eval("document.querySelector('[data-wg=fit]').scrollIntoView({block:'center'})");
  await browser.clickSel('[data-wg=fit]');
  await browser.waitFor("document.querySelector('#wg-zoom')?.textContent==='100%'", 10000);
  assert.deepEqual(await view(), initial, 'Fit restores 100 percent');
  const audit = await browser.eval("({align:alignAudit(document.querySelector('.wg-root')),size:sizeAudit(document.querySelector('.wg-root'))})");
  assert.deepEqual(audit, { align: [], size: [] });
  await browser.eval("document.querySelector('[data-cat=Кран]').click()");
  assert.equal(await browser.eval("getComputedStyle(document.querySelector('#v2-content')).overflowY"), 'hidden');
  assert.deepEqual(browser.exceptions, []);
  console.log('Viewport, scrolling, half-speed zoom, 25% bound and fit checks passed');
} finally {
  await browser.close();
}
