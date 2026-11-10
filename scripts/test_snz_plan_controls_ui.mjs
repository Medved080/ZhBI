// snz_workspace_test_server.py, fresh disposable database only.
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8065';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-plan-controls/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const field=(key,value)=>page.locator(`[data-snzi="${key}"]`).selectOption(value);
const rows=n=>page.waitForFunction(n=>document.querySelectorAll('#snz-register tbody tr[aria-selected]').length===n,n);
const saved=()=>page.waitForFunction(()=>!document.querySelector('[data-snzi-action="refresh"]').disabled);
const state=async()=>await(await page.request.get(base+'/objects/1/snz/state')).json();
const action=async name=>{await page.locator(`.snz-dialog [data-action="${name}"]`).click();await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));};
try{
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await rows(8);
 const frame=page.frameLocator('iframe.ws-frame');
 check('Separate filter and planning sections are open',await page.locator('[data-snzi-filter-fold]').getAttribute('open')!==null&&await page.locator('[data-snzi-planning-fold]').getAttribute('open')!==null);
 await page.locator('[data-snzi-filter-fold] summary').click();await page.locator('[data-snzi-planning-fold] summary').click();
 await frame.locator('.element-shape[data-id="1"]').click();
 check('Both folds stay collapsed after model selection',await page.locator('[data-snzi-filter-fold]').getAttribute('open')===null&&await page.locator('[data-snzi-planning-fold]').getAttribute('open')===null);
 await page.locator('[data-snzi-filter-fold] summary').click();await page.locator('[data-snzi-planning-fold] summary').click();
 await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 1.'));
 check('Existing unissued assignment is editable from the model',await page.locator('[data-snzi-action="plan"]').isEnabled());
 const original=(await state()).state.assignments.find(a=>a.element_id===1);
 await page.locator('[data-snzi="date"]').fill('2026-11-15');await page.locator('[data-snzi="date"]').press('Tab');await field('shift','night');await field('crew','install2');await rows(8);
 await page.locator('[data-snzi-action="plan"]').click();await saved();
 check('Planning controls update an existing assignment',(await state()).state.assignments.find(a=>a.element_id===1).date==='2026-11-15');
 let data=await state();data.state.assignments=data.state.assignments.map(a=>a.element_id===1?original:a);delete data.state.facts;
 await page.request.put(base+'/objects/1/snz/state',{data:{revision:data.revision,...data.state}});
 await page.reload();await page.locator('.ws-tabs [data-tab="snz"]').click();await rows(8);
 await field('filterCrew','none');await rows(4);
 check('Unassigned crew works with cleared date filter',true);
 await field('filterShift','day');await rows(0);await field('filterShift','none');await rows(4);
 check('Unassigned shift and crew intersect independently',true);
 await field('filterCrew','install1');await field('filterShift','day');await rows(2);
 check('Assigned crew and shift filter across dates',true);
 await field('mode','date');await page.locator('[data-snzi="filterDate"]').fill('2026-11-10');await page.locator('[data-snzi="filterDate"]').press('Tab');await rows(1);
 await field('filterCrew','');await field('filterShift','night');await rows(1);
 check('All three filters intersect',true);
 await field('filterCrew','');await field('filterShift','');await field('mode','unplanned');await rows(2);
 await frame.locator('.element-shape[data-id="6"]').click();await frame.locator('.element-shape[data-id="5"]').click({modifiers:['Meta']});
 await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 2.'));
 await page.locator('[data-snzi="date"]').fill('2026-11-20');await page.locator('[data-snzi="date"]').press('Tab');await field('shift','day');await field('crew','install1');
 await rows(2);check('Planning fields do not alter filtering or selection',await page.locator('[data-snzi-action="plan"]').isEnabled());
 await page.locator('[data-snzi-action="plan"]').click();await saved();await rows(0);
 data=await state();check('Installation order follows model addition order',data.state.assignments.find(a=>a.element_id===6).priority===1&&data.state.assignments.find(a=>a.element_id===5).priority===2);
 await page.locator('[data-snz-open]').click();await page.locator('[data-filter="date"]').fill('2026-11-20');await page.locator('[data-filter="date"]').press('Tab');await action('preview');
 check('Calculated sequence starts with first added item',await page.locator('[data-sequence-item]').first().getAttribute('data-sequence-item')==='6');
 await page.locator('[data-action="sequence-up"][data-id="5"]').click();await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
 check('Up button saves and recalculates mounting order',await page.locator('[data-sequence-item]').first().getAttribute('data-sequence-item')==='5'&&(await state()).state.assignments.find(a=>a.element_id===5).priority===1);
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);const issues=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
  check('Sequence controls alignment '+size.width,!issues.align.length&&!issues.size.length);
  await page.locator('[data-sequence-item]').first().scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`sequence-${size.width}.png`,out).pathname});
 }
 await page.route('**/objects/1/snz/state',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Учебный конфликт'})});else await route.continue();});
 await page.locator('[data-action="sequence-up"][data-id="6"]').click();await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
 check('Reorder conflict invalidates stale schedule',await page.locator('[data-action="issue"]').isDisabled()&&await page.locator('.snz-error').isVisible());
 await page.unrouteAll({behavior:'wait'});await action('reload');await action('preview');await action('issue');
 check('Issued documents expose no reordering controls',await page.locator('[data-action="sequence-up"]').count()===0);
 await page.locator('[data-tab="orders"]').click();await page.locator('[data-filter="ordersDate"]').fill('2026-11-20');await page.locator('[data-filter="ordersDate"]').press('Tab');
 const download=page.waitForEvent('download');await action('registry-xlsx');await(await download).saveAs(new URL('daily.xlsx',out).pathname);
 await action('close');await field('mode','all');await rows(6);await frame.locator('.element-shape[data-id="5"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-snzi-row="date"][data-id="5"]')?.disabled&&!document.querySelector('[data-snzi-action="refresh"]').disabled);
 check('Issued items remain protected from planning changes',await page.locator('[data-snzi-row="date"][data-id="5"]').isDisabled());
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);const issues=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snzi-panel')),size:sizeAudit(document.querySelector('.snzi-panel'))}));
  check('Split panel alignment '+size.width,!issues.align.length&&!issues.size.length);await page.screenshot({path:new URL(`panel-${size.width}.png`,out).pathname});
 }
 check('No browser errors',errors.length===0);await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
