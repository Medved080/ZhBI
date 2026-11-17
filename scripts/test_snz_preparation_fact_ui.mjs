// Only scripts/snz_preparation_test_server.py on a disposable local port.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8089';
assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const out=new URL('../outputs/snz-preparation-ui/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=async path=>(await page.request.get(base+'/objects/1/snz/'+path)).json();
const settle=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
const action=k=>page.locator(`.snz-dialog [data-action="${k}"]`),filter=k=>page.locator(`[data-fact-filter="${k}"]`);
try{
 const before=await api('state');
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settle();
 await page.locator('.snz-tabs [data-tab="facts"]').click();await settle();
 assert.ok(await filter('crew').locator('option[value="preparation"]').count());
 await filter('date').fill('2026-11-10');await settle();await filter('crew').selectOption('preparation');await settle();await filter('shift').selectOption('day');await settle();
 assert.equal(await page.locator('[data-preparation-row]').count(),2);assert.equal(await page.locator('[data-montage-row]').count(),0);
 assert.equal(await action('extra-fact').count(),0);assert.ok(await action('close-orders').isEnabled());
 const first=page.locator('[data-preparation-row]').first();
 await first.locator('textarea').fill('Подготовлено к монтажу');await first.locator('[data-action="save-fact-note"]').click();await settle();
 await first.locator('[data-preparation-time]').fill('2026-11-10T11:10');await first.locator('[data-action="preparation-complete"]').click();await settle();
 assert.match(await first.innerText(),/100 % · Подготовлено/);assert.ok(await first.locator('[data-preparation-time]').isDisabled());
 await filter('without').check();await settle();assert.equal(await page.locator('[data-preparation-row]').count(),1);
 await filter('without').uncheck();await settle();
 console.log('PASS preparation crew, operation fact, notes, time and without-fact filter');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8'));
  assert.deepEqual(await page.evaluate(()=>({a:alignAudit(document.querySelector('.snz-dialog')),s:sizeAudit(document.querySelector('.snz-dialog'))})),{a:[],s:[]});
  await page.screenshot({path:new URL(`preparation-${size.width}.png`,out).pathname});
 }
 const download=page.waitForEvent('download');await action('fact-xlsx').click();await(await download).saveAs(new URL('preparation.xlsx',out).pathname);await settle();
 page.once('dialog',d=>d.dismiss());await action('close-orders').click();await settle();assert.ok((await api('state')).orders.every(o=>!o.closed_at));
 page.once('dialog',d=>d.accept());await action('close-orders').click();await settle();
 const after=await api('state');assert.equal(after.orders.filter(o=>o.closed_at).length,1);
 assert.equal(after.orders.find(o=>o.closed_at).crew_kind,'preparation');assert.deepEqual(after.state.assignments,before.state.assignments);
 const key=e=>({id:e.id,current_status:e.current_status,planned_installation_date:e.planned_installation_date});
 assert.deepEqual(after.elements.map(key),before.elements.map(key));
 for(const row of await page.locator('[data-preparation-row]').all()){
  assert.ok(await row.locator('[data-action="preparation-complete"]').isDisabled());assert.ok(await row.locator('textarea').isDisabled());
 }
 await filter('open').check();await settle();assert.equal(await page.locator('[data-preparation-row]').count(),0);
 await filter('shift').selectOption('night');await settle();assert.ok(await action('close-orders').isEnabled());
 assert.ok(await filter('open').isChecked());
 assert.ok(await page.locator('[data-preparation-row]').count());
 assert.match(await page.locator('[data-action="preparation-complete"]').first().innerText(),/Учтено в СНЗ №/);
 assert.ok(await page.locator('[data-action="preparation-complete"]').first().isDisabled());
 await page.route('**/objects/1/snz/facts?*',async route=>{const response=await route.fetch(),body=await response.json();body.can_fact=false;await route.fulfill({response,json:body});});
 await action('facts-refresh').click();await settle();assert.ok(await action('close-orders').isDisabled());
 assert.ok(await page.locator('[data-action="preparation-complete"]').first().isDisabled());assert.ok(await filter('crew').isEnabled());assert.deepEqual(errors,[]);
 console.log('PASS exports, cancellation, closure, frozen facts, unchanged installation, independent night shift, permissions and layout');
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
