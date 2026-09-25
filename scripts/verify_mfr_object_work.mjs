// Живая проверка правой панели МФР и объектного плана/факта на копии БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, sql1 } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "mfr-object-work-"));
let browser;
try {
  const { base, db } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 4 });
  await openScreen(browser, "ws-mfr", '!!document.querySelector(\'[data-mbp="object-settings"]\')', 45000);
  assert.match(await browser.eval("document.querySelector('.ws-empty')?.innerText || ''"), /Объект целиком/);
  await tap(browser, '[data-mbp="object-settings"]');
  await browser.waitFor("!!document.querySelector('#mow-tree input[data-op]')");
  const option = Number(await browser.eval("document.querySelector('#mow-tree input[data-op]').dataset.op"));
  await tap(browser, `#mow-tree input[data-op="${option}"]`);
  await tap(browser, "#mow-settings-save");
  await browser.waitFor("document.querySelector('.mfr-status')?.textContent === 'Сохранено'");
  assert.equal(Number(sql1(db, `SELECT COUNT(*) FROM object_works WHERE object_id=4 AND work_type_id=${option} AND retired_at IS NULL`)), 1);
  assert.equal(Number(sql1(db, `SELECT COUNT(*) FROM object_works WHERE object_id<>4 AND work_type_id=${option}`)), 0);
  await tap(browser, '[data-mow-tab="dates"]');
  await browser.waitFor("!!document.querySelector('#mow-plan-start')");
  await browser.eval("(()=>{const e=document.querySelector('#mow-plan-start');e.value='2026-09-25';e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await tap(browser, "#mow-dates-save");
  await browser.waitFor("document.querySelector('.mfr-status')?.textContent === 'Сохранено'");
  assert.equal(sql1(db, `SELECT plan_start FROM object_works WHERE object_id=4 AND work_type_id=${option}`), "2026-09-25");
  await tap(browser, '[data-mow-tab="fact"]');
  await browser.waitFor("!!document.querySelector('[data-mow-percent]')");
  await browser.eval("(()=>{const e=document.querySelector('[data-mow-percent]');e.value='35';e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await tap(browser, "#mow-fact-save");
  await browser.waitFor("document.querySelector('.mfr-status')?.textContent === 'Сохранено'");
  assert.equal(Number(sql1(db, "SELECT percent FROM object_fact_items ORDER BY report_id DESC LIMIT 1")), 35);
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: V2 объектный состав, сроки и факт сохраняются и изолированы по объекту");
} finally {
  try { await browser?.close(); } catch { /* браузер мог уже завершиться */ }
  await stopServer();
}
