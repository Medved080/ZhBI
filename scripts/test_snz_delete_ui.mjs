// Synthetic empty edited document -> delete -> unplanned -> assign -> new issue.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8060';assert.equal(new URL(base).hostname,'127.0.0.1');
const output=new URL('../outputs/snz-delete/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const state=async()=>await(await page.request.get(base+'/objects/1/snz/state')).json();
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
const action=async name=>{await page.locator(`.snz-dialog [data-action="${name}"]`).click();await settled();};
try{
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settled();
 await page.locator('[data-tab="orders"]').click();
 const before=await state(),oldId=before.orders[0].id;
 check('Reproduced empty issued document with four old assignments',before.orders.length===1&&before.orders[0].quantity===0&&before.state.assignments.length===4);
 check('Delete SNZ button is present',await page.locator('[data-action="delete-order"]').isVisible());
 page.once('dialog',d=>d.dismiss());await action('delete-order');
 check('Cancel leaves document and revision unchanged',JSON.stringify(await state())===JSON.stringify(before));
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);
  const issues=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
  check('Delete layout alignment '+size.width,!issues.align.length&&!issues.size.length);
  await page.screenshot({path:new URL(`delete-${size.width}.png`,output).pathname});
 }
 await page.setViewportSize({width:1440,height:900});page.once('dialog',d=>d.accept());await action('delete-order');
 const removed=await state();
 check('Empty document is removed and date/shift/crew slot is free',removed.orders.length===0);
 check('All unreferenced assignments return to unplanned',removed.state.assignments.length===0&&removed.locked_element_ids.length===0&&removed.elements.every(e=>!e.planned_installation_date));
 check('Dictionaries and facts are unchanged',JSON.stringify({...removed.state,assignments:[]})===JSON.stringify({...before.state,assignments:[]}));
 await action('close');await page.locator('[data-snzi="mode"]').selectOption('unplanned');
 await page.waitForFunction(()=>document.querySelectorAll('#snz-register tbody tr[aria-selected]').length===4);
 check('Model workspace immediately shows all four unplanned items',await page.locator('#snz-register tbody tr[aria-selected]').count()===4);
 await page.locator('[data-snz-open]').click();await settled();
 await page.locator('[data-tab="plan"]').click();
 await page.locator('[data-filter="noDate"]').check();
 check('Unplanned search includes the four released items',await page.locator('[data-items] tbody tr').count()===4);
 await action('page-all');
 await page.locator('[data-filter="date"]').fill('2026-11-10');await page.locator('[data-filter="date"]').press('Tab');
 await page.locator('[data-filter="assignmentCard"]').selectOption('base');await action('assign');await action('save');
 check('All items can be reassigned immediately',(await state()).state.assignments.length===4);
 await action('preview');
 check('Same date and shift now calculate a new document',await page.locator('.snz-result h3').innerText().then(t=>t.includes('Расчёт смены')));
 await action('issue');
 const after=await state();
 check('A new SNZ is issued for the formerly occupied slot',after.orders.length===1&&after.orders[0].id!==oldId&&after.orders[0].quantity===4);
 check('Reissued assignments are locked by the new SNZ',after.locked_element_ids.length===4);
 await page.locator('[data-tab="orders"]').click();await page.screenshot({path:new URL('reissued.png',output).pathname});
 // A reader can use registry filters, but does not receive a destructive button.
 await action('close');
 await page.route('**/objects/1/snz/state',async route=>{
  const response=await route.fetch(),data=await response.json();data.can_write=false;
  await route.fulfill({response,json:data});
 });
 await page.locator('[data-snz-open]').click();await settled();await page.locator('[data-tab="orders"]').click();
 check('Read-only registry has no delete button',await page.locator('[data-action="delete-order"]').count()===0);
 check('No browser errors',errors.length===0);
 await writeFile(new URL('checks.json',output),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
