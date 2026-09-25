// Общие подсказки V1/V2 и полный сценарий кнопок редактора зон — только копия обезличенной БД.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, openV1, noPageScroll, sql1 } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "zhbi-ui-tooltips-"));
let browser;
try {
  const { base, db } = await startServer(8374, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-save')");
  assert.match(await browser.eval("document.querySelector('#cz-feedback').textContent"), /Шаг 1 из 3/);
  assert.equal(await browser.eval("document.querySelector('#cz-save').disabled"), true);
  const disabledSave = await browser.rect("#cz-save");
  await browser.move(disabledSave.cx, disabledSave.cy);
  await browser.waitFor("document.querySelector('#ui-control-tooltip')?.textContent.includes('Сначала создайте черновик')");
  assert.equal(await browser.eval("document.querySelector('#ui-control-tooltip').dataset.visible"), "true");
  console.log("PASS V2: disabled-кнопка объясняет причину недоступности при наведении");

  await tap(browser, "#cz-new");
  await browser.waitFor("!!document.querySelector('#cz-note') && document.querySelector('#cz-feedback')?.textContent.includes('Создан черновик')", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-save').disabled"), true);
  const publishedBefore = Number(sql1(db, "SELECT COUNT(*) FROM crane_zone_versions WHERE object_id=1 AND activated_at IS NOT NULL"));
  await browser.eval(`(() => {
    const name = document.querySelector('#cz-name');
    name.value += ' · тест кнопок';
    name.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await browser.waitFor("document.querySelector('#cz-save')?.disabled === false");
  await tap(browser, "#cz-note");
  await browser.type("Проверка полного сценария сохранения и публикации через интерфейс");
  await tap(browser, "#cz-save");
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Черновик сохранён')", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-feedback').dataset.tone"), "success");
  assert.equal(await browser.eval("document.querySelector('#cz-publish').disabled"), true);
  const disabledPublish = await browser.rect("#cz-publish");
  await browser.move(disabledPublish.cx, disabledPublish.cy);
  await browser.waitFor("document.querySelector('#ui-control-tooltip')?.textContent.includes('Сначала выполните предпросмотр')");
  await browser.eval("document.querySelector('#cz-preview').focus()");
  await browser.waitFor("document.querySelector('#ui-control-tooltip')?.textContent.includes('Рассчитать назначения изделий')");
  console.log("PASS V2: сохранение видно; публикация объясняет обязательный предпросмотр");

  await tap(browser, "#cz-preview");
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Предпросмотр рассчитан')", 60000);
  assert.equal(await browser.eval("document.querySelector('#cz-publish').disabled"), false);
  await tap(browser, "#cz-publish");
  await browser.waitFor("!!document.querySelector('.v2-dialog-backdrop [data-choice=confirm]')", 10000);
  await tap(browser, '.v2-dialog-backdrop [data-choice="confirm"]');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Редакция опубликована')", 60000);
  assert.equal(await browser.eval("document.querySelector('#cz-feedback').dataset.tone"), "success");
  assert.equal(Number(sql1(db, "SELECT COUNT(*) FROM crane_zone_versions WHERE object_id=1 AND activated_at IS NOT NULL")), publishedBefore + 1);
  assert.ok(await noPageScroll(browser), "после добавления строки действий страница не должна прокручиваться на 1366×768");
  console.log("PASS V2: кнопки реально сохраняют, рассчитывают предпросмотр и публикуют редакцию на копии БД");

  await openV1(browser, base, 1);
  const control = await browser.eval(`(() => {
    const el = [...document.querySelectorAll('button, a[href], input:not([type=hidden])')]
      .find((item) => { const r = item.getBoundingClientRect(); return r.width > 30 && r.height > 15 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
    if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(control, "не найден видимый элемент управления V1");
  await browser.move(control.x, control.y);
  await browser.waitFor("document.querySelector('#ui-control-tooltip')?.dataset.visible === 'true'");
  assert.ok((await browser.eval("document.querySelector('#ui-control-tooltip').textContent")).trim());
  console.log("PASS V1: общий механизм показывает подсказку и в старом интерфейсе");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
} finally {
  try { await browser?.close(); } catch { /* */ }
  await stopServer();
}
