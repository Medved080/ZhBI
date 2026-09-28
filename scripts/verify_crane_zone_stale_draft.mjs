// Черновик старой редакции остаётся доступен, но не выбирается для правки;
// изменение стоянки сохраняется в новом черновике текущей редакции.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-stale-draft-"));
let browser;
try {
  const { base } = await startServer(8377, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Стоянка]')");
  await tap(browser, '[data-cat="Кран"]');
  await browser.waitFor("!!document.querySelector('.cz-root')", 30000);
  assert.equal(await browser.eval("!!document.querySelector('#cz-new')"), false,
    "редактирование осталось в разделе зон кранов");
  await tap(browser, '[data-cat="Стоянка"]');
  await browser.waitFor("!!document.querySelector('#cz-draft-select') && !!document.querySelector('.cz-crane-toggle')", 30000);
  const old = await browser.eval("[...document.querySelector('#cz-draft-select').options].find(o=>o.textContent.includes('устарел'))?.value");
  assert.ok(old, "нет сохранённого старого черновика на проверочной копии");
  assert.equal(await browser.eval("document.querySelector('#cz-draft-select').value"), "",
    "старый черновик автоматически открылся для правки");
  assert.equal(await browser.eval("!!document.querySelector('#cz-delete-zone')"), true,
    "кнопка удаления крана не видна без черновика");
  if (!await browser.eval("!!document.querySelector('.cz-crane-stands:not([hidden]) .cz-stand')")) await tap(browser, '.cz-crane-toggle');
  await tap(browser, '.cz-crane-stands:not([hidden]) .cz-stand');
  assert.equal(await browser.eval("document.querySelector('#cz-elevation')?.readOnly"), true);
  assert.equal(await browser.eval("!!document.querySelector('#cz-delete-zone')"), true,
    "кнопка удаления стоянки не видна без черновика");
  if (process.env.AUDIT_SHOT) await browser.shot(process.env.AUDIT_SHOT);
  assert.match(await browser.eval("document.querySelector('#cz-feedback').textContent"), /прежней редакции/);
  await browser.eval(`document.querySelector('#cz-draft-select').value=${JSON.stringify(old)};document.querySelector('#cz-draft-select').dispatchEvent(new Event('change',{bubbles:true}))`);
  await browser.waitFor(`document.querySelector('#cz-draft-select')?.value === ${JSON.stringify(old)} && document.querySelector('#cz-feedback')?.textContent.includes('создан до перехода')`, 30000);
  assert.match(await browser.eval("document.querySelector('#cz-feedback').textContent"), /создан до перехода/);
  if (!await browser.eval("!!document.querySelector('.cz-crane-stands:not([hidden]) .cz-stand')")) await tap(browser, '.cz-crane-toggle');
  await tap(browser, '.cz-crane-stands:not([hidden]) .cz-stand');
  assert.equal(await browser.eval("document.querySelector('#cz-save').disabled"), true);
  assert.equal(await browser.eval("document.querySelector('#cz-preview').disabled"), true);
  assert.equal(await browser.eval("document.querySelector('#cz-name')?.disabled"), true);
  assert.equal(await browser.eval("!!document.querySelector('#cz-add-level')"), false,
    "устаревший черновик не должен предлагать добавление яруса");
  const selectedStanceId = await browser.eval("document.querySelector('.cz-stand.active')?.dataset.zoneId");
  const oldToken = await browser.eval(`(async()=> (await (await fetch('/objects/1/crane-zone-versions/drafts/${old}')).json()).edit_token)()`);
  await tap(browser, '#cz-new');
  await browser.waitFor(`!!document.querySelector('#cz-draft-select')?.value && document.querySelector('#cz-draft-select').value !== ${JSON.stringify(old)}`, 30000);
  assert.notEqual(await browser.eval("document.querySelector('#cz-draft-select').value"), old);
  assert.equal(await browser.eval("document.querySelector('#cz-upper-elevation').readOnly"), false,
    "поле верхней отметки не стало редактируемым после выбора");
  assert.equal(await browser.eval("document.querySelector('#cz-elevation').readOnly"), false,
    "поле нижней отметки не стало редактируемым после выбора");
  assert.equal(await browser.eval("document.querySelector('.cz-stand.active')?.dataset.zoneId"), selectedStanceId,
    "при создании черновика потерян выбор стоянки");
  if (!await browser.eval("!!document.querySelector('.cz-crane-stands:not([hidden]) .cz-stand')")) await tap(browser, '.cz-crane-toggle');
  await tap(browser, '.cz-crane-stands:not([hidden]) .cz-stand');
  await browser.waitFor("JSON.parse(document.querySelector('#cz-canvas')?.dataset.edgeMidpoints || '[]').length === 4", 30000);
  const points = JSON.parse(await browser.eval("document.querySelector('#cz-canvas').dataset.edgeMidpoints"));
  const edge = [...points].sort((a,b)=>b.length-a.length)[0];
  const center = points.reduce((sum,p)=>[sum[0]+p.x/points.length,sum[1]+p.y/points.length],[0,0]);
  const direction = [center[0]-edge.x,center[1]-edge.y];
  const distance = Math.hypot(...direction);
  const canvas = await browser.rect('#cz-canvas');
  await browser.drag(canvas.x+edge.x,canvas.y+edge.y,
    canvas.x+edge.x+direction[0]/distance*8,canvas.y+edge.y+direction[1]/distance*8);
  await browser.waitFor("!!document.querySelector('#cz-save:not(:disabled)')", 5000);
  await tap(browser, '#cz-save');
  await browser.waitFor("document.querySelector('#cz-status')?.textContent.startsWith('Черновик сохранён')", 10000);
  const currentDraft = await browser.eval("document.querySelector('#cz-draft-select').value");
  const draftCount = await browser.eval("document.querySelector('#cz-draft-select').options.length");
  await browser.eval("document.querySelector('#cz-draft-select').value='';document.querySelector('#cz-draft-select').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.waitFor("document.querySelector('#cz-draft-select')?.value === ''", 10000);
  if (!await browser.eval("!!document.querySelector('.cz-crane-stands:not([hidden]) .cz-stand')")) await tap(browser, '.cz-crane-toggle');
  await tap(browser, '.cz-crane-stands:not([hidden]) .cz-stand');
  await tap(browser, '#cz-add-level');
  await browser.waitFor(`document.querySelector('#cz-draft-select')?.value === ${JSON.stringify(currentDraft)} && document.querySelectorAll('.cz-level').length > 1`, 10000);
  assert.equal(await browser.eval("document.querySelector('#cz-draft-select').options.length"), draftCount,
    "добавление яруса создало ещё один черновик");
  assert.equal(await browser.eval("!!document.querySelector('#cz-upper-elevation')"), true,
    "нет поля верхней отметки яруса");
  assert.equal(await browser.eval("document.querySelector('#cz-upper-elevation').hasAttribute('list')"), false,
    "верхняя отметка всё ещё ограничена списком");
  const stableFields = await browser.eval(`(() => {
    const panel = document.querySelector('.cz-properties');
    panel.scrollTop = 50;
    const scrollBefore = panel.scrollTop;
    window.__upperFieldBefore = document.querySelector('#cz-upper-elevation');
    window.__lowerFieldBefore = document.querySelector('#cz-elevation');
    window.__panelBefore = panel;
    const upper = window.__upperFieldBefore;
    upper.value = '8725'; upper.dispatchEvent(new Event('change', { bubbles: true }));
    const lower = window.__lowerFieldBefore;
    lower.value = '4250'; lower.dispatchEvent(new Event('change', { bubbles: true }));
    return panel === document.querySelector('.cz-properties') &&
      upper === document.querySelector('#cz-upper-elevation') &&
      lower === document.querySelector('#cz-elevation') && panel.scrollTop === scrollBefore;
  })()`);
  assert.equal(stableFields, true, "форма пересоздалась или прокрутилась при вводе отметки");
  assert.equal(await browser.eval("document.querySelector('.cz-level.active').textContent.includes('8725')"), true);
  await browser.eval("document.querySelector('#cz-upper-elevation').value='-1';document.querySelector('#cz-upper-elevation').dispatchEvent(new Event('change',{bubbles:true}))");
  await tap(browser, '#cz-save');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('Перед публикацией исправьте')", 10000);
  assert.equal(await browser.eval("document.querySelector('#cz-publish').disabled"), true,
    "ошибочный черновик можно публиковать");
  const levelCount = await browser.eval("document.querySelectorAll('.cz-level').length");
  await tap(browser, '#cz-delete-level');
  await tap(browser, '.v2-dialog [data-choice=confirm]');
  assert.equal(await browser.eval("document.querySelectorAll('.cz-level').length"), levelCount - 1);
  const deletedStanceId = await browser.eval("document.querySelector('.cz-tree-item.cz-stand.active')?.dataset.zoneId");
  await tap(browser, '#cz-delete-zone');
  await tap(browser, '.v2-dialog [data-choice=confirm]');
  assert.equal(await browser.eval(`!!document.querySelector('[data-zone-id="${deletedStanceId}"]')`), false);
  await tap(browser, '#cz-save');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.startsWith('Черновик сохранён')", 10000);
  await tap(browser, '#cz-delete-draft');
  await browser.waitFor("!!document.querySelector('.v2-dialog [data-choice=confirm]')", 5000);
  await tap(browser, '.v2-dialog [data-choice=confirm]');
  await browser.waitFor("document.querySelector('#cz-feedback')?.textContent.includes('удалён') || document.querySelector('#cz-feedback')?.dataset.tone === 'error'", 10000);
  assert.equal(await browser.eval("document.querySelector('#cz-feedback')?.dataset.tone"), "success",
    await browser.eval("document.querySelector('#cz-feedback')?.textContent"));
  assert.equal(await browser.eval("document.querySelector('#cz-draft-select')?.value"), "");
  if (!await browser.eval("!!document.querySelector('.cz-crane-stands:not([hidden]) .cz-stand')")) await tap(browser, '.cz-crane-toggle');
  await tap(browser, '.cz-crane-stands:not([hidden]) .cz-stand');
  await tap(browser, '#cz-elevation');
  await browser.waitFor("!!document.querySelector('#cz-draft-select')?.value && !document.querySelector('#cz-elevation')?.readOnly", 30000);
  assert.equal(await browser.eval("document.querySelector('#cz-upper-elevation')?.readOnly"), false);
  assert.equal(await browser.eval(`(async()=> (await (await fetch('/objects/1/crane-zone-versions/drafts/${old}')).json()).edit_token)()`), oldToken,
    "старый черновик изменился при создании нового");
  assert.equal(browser.exceptions.length, 0, browser.exceptions.join("\n"));
  console.log("PASS: старый черновик только для просмотра; контур стоянки сохранён в новом черновике");
} finally {
  await browser?.close();
  await stopServer();
}
