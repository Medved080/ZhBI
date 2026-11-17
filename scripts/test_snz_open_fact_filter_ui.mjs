// Disposable fixture: snz_fact_report_test_server.py 8087 --open-filter.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8087';
assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const out=new URL('../outputs/snz-open-filter-ui/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=async path=>(await page.request.get(base+'/objects/1/snz/'+path)).json();
const settle=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
const filter=k=>page.locator(`[data-fact-filter="${k}"]`),action=k=>page.locator(`.snz-dialog [data-action="${k}"]`);
const ids=()=>page.locator('[data-montage-row]').evaluateAll(rows=>rows.map(r=>Number(r.dataset.montageRow)).sort((a,b)=>a-b));
try{
 const before=await api('state');
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settle();
 await page.locator('.snz-tabs [data-tab="facts"]').click();await settle();
 assert.ok(await filter('open').isEnabled());assert.ok(!await filter('open').isChecked());
 await filter('date').fill('2026-11-10');await settle();assert.deepEqual(await ids(),[1,2,3,4,5]);
 await filter('open').check();await settle();assert.deepEqual(await ids(),[3,4]);
 assert.ok(!await page.locator('[data-fact-rows]').innerText().then(t=>t.includes('СНЗ закрыт')||t.includes('Вне СНЗ')));
 await filter('shift').selectOption('day');await settle();assert.deepEqual(await ids(),[]);
 await filter('shift').selectOption('night');await settle();assert.deepEqual(await ids(),[3,4]);
 await filter('shift').selectOption('');await settle();await action('facts-all').click();await settle();
 assert.equal(await filter('date').inputValue(),'');assert.ok(await filter('open').isChecked());assert.deepEqual(await ids(),[1,3,4]);
 assert.ok(!await page.locator('[data-montage-row="1"]').innerText().then(t=>t.includes('СНЗ закрыт')));
 await filter('crew').selectOption('install2');await settle();assert.deepEqual(await ids(),[]);
 await filter('crew').selectOption('install1');await settle();assert.deepEqual(await ids(),[1,3,4]);
 await page.locator('[data-fact-search]').fill('Р-3');assert.deepEqual(await ids(),[3]);await page.locator('[data-fact-search]').fill('');
 await filter('date').fill('2026-11-10');await settle();assert.deepEqual(await api('state'),before);
 console.log('PASS selected date, all dates, open references, extra exclusion, shift/crew/search and read-only filtering');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8'));
  assert.deepEqual(await page.evaluate(()=>({a:alignAudit(document.querySelector('.snz-dialog')),s:sizeAudit(document.querySelector('.snz-dialog'))})),{a:[],s:[]});
  await page.screenshot({path:new URL(`open-filter-${size.width}.png`,out).pathname});
 }
 await filter('without').check();await settle();
 const row=page.locator('[data-montage-row="3"]');await row.locator('[data-montage-time]').fill('2026-11-10T21:00');await row.locator('[data-action="montage-complete"]').click();await settle();assert.deepEqual(await ids(),[4]);
 await filter('without').uncheck();await settle();assert.deepEqual(await ids(),[3,4]);
 page.once('dialog',d=>d.accept());await action('close-orders').click();await settle();assert.deepEqual(await ids(),[]);assert.ok(await filter('open').isChecked());
 await filter('open').uncheck();await settle();assert.deepEqual(await ids(),[1,2,3,4,5]);
 await filter('open').check();await settle();await action('facts-all').click();await settle();assert.deepEqual(await ids(),[1]);
 const note=page.locator('[data-montage-row="1"] textarea');await note.fill('Несохранённое примечание');
 page.once('dialog',d=>d.dismiss());await filter('open').click();await settle();assert.ok(await filter('open').isChecked());assert.equal(await note.inputValue(),'Несохранённое примечание');
 page.once('dialog',d=>d.accept());await filter('open').uncheck();await settle();assert.ok(!await filter('open').isChecked());
 await page.route('**/objects/1/snz/facts?*',async route=>{const response=await route.fetch(),body=await response.json();body.can_fact=false;await route.fulfill({response,json:body});});
 await action('facts-refresh').click();await settle();await filter('open').check();await settle();assert.deepEqual(await ids(),[1]);assert.ok(await filter('open').isEnabled());assert.ok(await action('close-orders').isDisabled());
 assert.deepEqual(errors,[]);console.log('PASS without-fact intersection, close refresh, disabling filter, draft guard, read-only rights and layouts');
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
