// Disposable synthetic server: scripts/snz_fact_report_test_server.py 8079.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8079';
assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-model-fact/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const field=k=>page.locator(`[data-snzf="${k}"]`),action=k=>page.locator(`[data-snzf-action="${k}"]`);
const api=async path=>(await page.request.get(base+'/objects/1/snz/'+path)).json();
const settle=()=>page.waitForFunction(()=>!document.querySelector('[data-snzf-action="refresh"]')?.disabled);
const pick=async ids=>{
 if(await action('clear').isEnabled()){await action('clear').click();await page.waitForFunction(()=>document.querySelector('[data-snzf-count]').textContent==='Выбрано: 0.');}
 for(const id of ids)await page.locator(`[data-snzi-check="${id}"]`).check();
};
try{
 const initial=await api('state');
 await page.goto(base+'/v2?object_id=1#/ws-foreman');
 await page.locator('.ws-tabs [data-tab="snz"]').click();await settle();
 assert.match(await field('time').inputValue(),/^\d{2}:\d{2}:\d{2}$/);
 const defaults=await page.evaluate(async()=>{
  const {factTimestamp}=await import('/static/v2/snz-model-fact.js');
  return [factTimestamp('2026-11-10','night','01:23'),factTimestamp('2026-11-10','day','11:23')];
 });
 assert.deepEqual(defaults,['2026-11-11T01:23:00','2026-11-10T11:23:00']);
 await page.locator('[data-snzi-filter-fold] summary').click();await page.locator('[data-snzi-planning-fold] summary').click();
 await field('date').fill('2026-11-10');await field('date').press('Tab');await settle();
 await field('shift').selectOption('day');await settle();await field('crew').selectOption('install1');await settle();
 await field('time').fill('11:10:00');await field('time').press('Tab');
 assert.equal(await page.locator('[data-snzi="date"]').inputValue(),new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
 await pick([3]);assert.ok(await action('save').isDisabled());assert.match(await page.locator('[data-snzf-result]').innerText(),/другой смены/);
 await action('clear').click();const scene=page.frameLocator('iframe.ws-frame');await scene.locator('.element-shape[data-id="1"]').click();await scene.locator('.element-shape[data-id="5"]').click({modifiers:['Meta']});await page.waitForFunction(()=>!document.querySelector('[data-snzf-action="save"]').disabled);
 console.log('PASS independent scope, current time, night date, wrong-shift protection, mixed selection');
 for(const [width,height] of [[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});await page.evaluate(await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8'));
  assert.deepEqual(await page.evaluate(()=>({a:alignAudit(document.querySelector('.snzi-panel')),s:sizeAudit(document.querySelector('.snzi-panel'))})),{a:[],s:[]});
  await field('time').scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`fact-${width}.png`,out).pathname});
 }
 let posts=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/snz/facts/model'))posts++;});
 await action('save').click();await page.getByText('Факт отмечен: 2 шт. Доп. факт вне СНЗ: 1 шт.',{exact:true}).waitFor();await settle();
 assert.equal(posts,1);assert.deepEqual((await api('state')).state.orders,initial.state.orders);
 let rows=(await api('facts?date=2026-11-10&shift=day&crew_id=install1')).items;
 for(const id of [1,5]){const row=rows.find(r=>r.id===id);assert.ok(row.status_confirmed);assert.equal(row.completed_at,'2026-11-10T11:10:00');}
 assert.ok(rows.find(r=>r.id===5).extra.length);
 console.log('PASS one atomic request, montage and extra, timestamps and immutable issued composition');
 // Existing montage may be attributed again in the same scope without rewriting its time.
 await pick([5]);await field('time').fill('15:55:00');await field('time').press('Tab');await action('save').click();await settle();
 rows=(await api('facts?date=2026-11-10')).items;assert.equal(rows.find(r=>r.id===5).completed_at,'2026-11-10T11:10:00');
 console.log('PASS existing montage timestamp preserved');
 await action('clear').click();await page.waitForFunction(()=>document.querySelector('[data-snzf-count]').textContent==='Выбрано: 0.');
 assert.equal(await page.locator('[data-snzi-check]:checked').count(),0);
 // Unknown result blocks retry until explicit refresh and preserves user input.
 await pick([2]);await page.route('**/objects/1/snz/facts/model',route=>route.fulfill({status:503,json:{detail:'Учебный отказ'}}));
 await action('save').click();await page.getByText(/Ответ о записи не получен/).waitFor();assert.ok(await action('save').isDisabled());assert.equal(await field('time').inputValue(),'15:55:00');
 await page.unrouteAll({behavior:'wait'});await action('refresh').click();await settle();await page.waitForFunction(()=>!document.querySelector('[data-snzf-action="save"]').disabled);
 assert.equal((await api('facts?date=2026-11-10')).items.find(r=>r.id===2).status_confirmed,false);
 console.log('PASS clear selection, unknown result blocks retry and refresh restores editing');
 await page.route('**/objects/1/snz/facts/model-candidates?*',async route=>{const response=await route.fetch(),body=await response.json();body.can_fact=false;await route.fulfill({response,json:body});});
 await action('refresh').click();await settle();assert.ok(await action('save').isDisabled());assert.ok(await field('date').isEnabled());
 console.log('PASS read-only candidates block writes, filters available');
 await page.unrouteAll({behavior:'wait'});await action('refresh').click();await settle();
 const preview=await api('facts/close-preview?date=2026-11-10&shift=day&crew_id=install1');
 const close=await page.request.post(base+'/objects/1/snz/facts/close',{data:{revision:preview.revision,date:'2026-11-10',shift:'day',crew_id:'install1',expected_hash:preview.fingerprint,request_id:'ui-model-close'}});
 assert.equal(close.status(),200);await action('refresh').click();await settle();
 assert.ok(await action('save').isDisabled());assert.match(await page.locator('[data-snzf-result]').innerText(),/закрыт/);
 await page.locator('[data-snzf-fold] summary').click();assert.equal(await page.locator('[data-snzf-fold]').getAttribute('open'),null);
 assert.deepEqual(errors,[]);console.log('PASS closed orders immutable, collapsible section, no browser errors');
 await page.locator('[data-snz-open]').click();await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
 const previewResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/snz/preview'));
 await page.locator('.snz-dialog [data-action="preview"]').click();assert.equal((await previewResponse).status(),200);
 await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
 const reloadResponse=page.waitForResponse(r=>r.url().endsWith('/snz/state'));await page.locator('.snz-dialog [data-action="reload"]').click();assert.equal((await reloadResponse).status(),200);
 await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));await page.locator('.snz-dialog [data-action="close"]').click();assert.equal(await page.locator('.snz-dialog').count(),0);
 console.log('PASS expanded planner calculation, reload and close handlers');
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
