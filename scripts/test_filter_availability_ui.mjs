// Disposable montage_filter_fixture.py on port 8071 only.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.MONTAGE_TEST_URL||'http://127.0.0.1:8071';
assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const output=new URL('../outputs/filter-availability/',import.meta.url);await mkdir(output,{recursive:true});
const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[];
try {
 for(const ui of ['v1','v2']) for(const ws of ['model','foreman','picker']) {
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(`${ui}/${ws}: ${e.message}`));
  await page.route('**/me/ui-state?*',r=>r.fulfill({json:{data:null}}));
  await page.goto(ui==='v2'?`${base}/v2?object_id=1#/ws-${ws}`:`${base}/?ui=v1&object_id=1&ws=${ws}`);
  let scene=page;
  if(ui==='v2') {
   await page.waitForSelector('iframe');scene=page.frames().find(f=>f!==page.mainFrame());
   await scene.waitForFunction(()=>typeof state!=='undefined'&&state.elements.length===8);
   if(ws!=='foreman')await page.locator(`[data-tab="${ws==='picker'?'pick':'filters'}"]`).click();
   await page.locator('[data-group="dates:smr"]').click();
  } else {
   await page.waitForFunction(w=>typeof state!=='undefined'&&state.elements.length===8&&workspace===w,ws);
   if(ws==='model')await page.locator('#sidebar [data-tab="filters"]').click();
   if(!await page.locator('[aria-label="Факт монтажа: Дата"]:visible').isVisible())await page.locator('[data-filter-key="smr"]:visible .filter-expand-btn').click();
  }
  await scene.evaluate(picker=>{
   if(picker){state.picker.sel.floor.add(1);onPickerChange();}
   else {state.placementFilters.floor.add(2);onPlacementFilterChange();}
  },ws==='picker');
  const field=page.locator('[aria-label="Факт монтажа: Дата"]:visible');
  await field.fill('2026-11-08');await field.press('Tab');
  await scene.waitForFunction(()=>state.dateFilters.montageFact.from==='2026-11-08');
  async function floorRow(n) {
   if(ui==='v2') {
    const header=page.locator(ws==='picker'?'[data-pkgroup="pk:floor"]':'[data-group="floor"]');
    if(await header.getAttribute('aria-expanded')==='false')await header.click();
    return page.locator(ws==='picker'?`[data-pk="floor"][data-v='${n}']`:`[data-key="floor"][data-v='${n}']`);
   }
   if(ws==='picker') {
    const group=page.locator('[data-picker-list="floor"]').locator('..');
    const list=page.locator('[data-picker-list="floor"]');
    if(!await list.isVisible())await group.locator('.filter-expand-btn').click();
    return list.locator('.picker-row').filter({hasText:`Этаж ${n}`});
   }
   const group=page.locator('[data-filter-key="floor"]:visible');
   if(!await group.locator('.filter-group-body').evaluate(e=>e.classList.contains('open')))await group.locator('.filter-group-header .filter-expand-btn').click();
   return group.locator('label').filter({hasText:`Этаж ${n}`}).locator('input');
  }
  await floorRow(1);
  await page.waitForTimeout(150);
  assert.equal(await (await floorRow(2)).count(),0,`${ui}/${ws}: unavailable floor is absent`);
  assert.equal(await scene.evaluate(picker=>picker?state.picker.sel.floor.has(1):state.placementFilters.floor.has(2),ws==='picker'),true,'Hidden selection is preserved');
  if(ws!=='picker') {
   // Own exclusion must never hide the row needed to switch it back on.
   await (await floorRow(1)).click();
   await scene.waitForFunction(()=>state.placementFilters.floor.has(1));
   assert.equal(await (await floorRow(1)).count(),1);
   await (await floorRow(1)).click();
   await scene.waitForFunction(()=>!state.placementFilters.floor.has(1));
  }
  if(ui==='v2'&&ws==='foreman') {
   await page.locator('.ws-fhead').filter({hasText:'Показано 3 из 8'}).waitFor();
   await page.evaluate(audit);
   for(const [width,height] of [[1440,900],[2560,1440]]) {
    await page.setViewportSize({width,height});
    const issues=await page.evaluate(()=>{const r=document.querySelector('[data-group="floor"]').closest('section');return {align:alignAudit(r),size:sizeAudit(r)}});
    assert.deepEqual(issues,{align:[],size:[]});
    await page.screenshot({path:new URL(`filters-${width}.png`,output).pathname});
   }
  }
  await field.fill('');await field.press('Tab');
  await scene.waitForFunction(()=>!state.dateFilters.montageFact.from);
  await (await floorRow(2)).waitFor({state:'visible'});
  if(ws!=='picker')assert.equal(await (await floorRow(2)).isChecked(),false,'Restored row retains its checkbox state');
  console.log(`PASS ${ui}/${ws}: unavailable hidden, choice retained, row restored`);
  await context.close();
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close()}
