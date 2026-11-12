// Only snz_fact_report_test_server.py's disposable synthetic data.
import {chromium} from 'playwright';import assert from 'node:assert/strict';import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8082';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-admin/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
const get=async path=>(await page.request.get(base+'/objects/1/snz/'+path)).json();
const action=a=>page.locator(`.snz-admin-editor [data-action="${a}"]`);
const field=(id,key)=>page.locator(`[data-admin-field="${key}"][data-admin-id="${id}"][data-admin-step="0"]`);
const fill=async(id,key,v)=>{await field(id,key).fill(v);await field(id,key).press('Tab');};
const open=async id=>{await page.locator(`.snz-orders-top [data-action="admin-edit-open"][data-id="${id}"]`).click();await settled();await page.locator('.snz-admin-editor').waitFor();};
const check=async()=>{await action('admin-preview').click();await settled();await page.locator('.snz-admin-editor h3').filter({hasText:'Изменения версии'}).waitFor();};
const save=async()=>{const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/admin-revisions'));await action('admin-save').click();assert.equal((await response).status(),200);await settled();await page.getByText('Новая версия СНЗ сохранена.',{exact:false}).waitFor();};
try{
 const initial=await get('state'),oid=initial.orders.find(o=>o.shift==='day').id;
 await page.addInitScript(()=>localStorage.setItem('snz-issued-height','.15'));
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settled();await page.locator('.snz-tabs [data-tab="orders"]').click();
 await open(oid);await fill(1,'minutes','35');await fill(1,'planned_start','2026-11-10T09:00');
 await page.locator('[data-action="admin-remove"][data-id="2"]').click();await page.locator('[data-admin-candidate]').selectOption('5');await action('admin-add').click();
 await field(1,'completed').check();await fill(1,'completed_at','2026-11-10T09:45');
 await page.locator('[data-admin-reason]').fill('Уточнение состава, норматива и факта');await check();
 assert.match(await page.locator('.snz-admin-editor').innerText(),/Норматив, мин/);
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const[width,height]of[[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});await page.evaluate(audit);
  const issues=await page.evaluate(()=>({a:alignAudit(document.querySelector('.snz-admin-editor')),s:sizeAudit(document.querySelector('.snz-admin-editor'))}));assert.deepEqual(issues,{a:[],s:[]});
  await page.locator('.snz-admin-editor h3').first().scrollIntoViewIfNeeded();await page.screenshot({path:new URL(`editor-${width}.png`,out).pathname});
 }
 await save();const current=await get(`orders/${oid}`);assert.equal(current.order_revision,2);assert.deepEqual(current.items.map(e=>e.id).sort(),[1,5]);assert.equal(current.tasks.find(t=>t.element_ids[0]===1).norm_minutes,35);
 assert.equal(current.facts['e:1:install'].completed_at,'2026-11-10T09:45:00');
 console.log('PASS add/remove, indicators, planned time and montage fact saved atomically from UI');
 await page.locator('.snz-result [data-action="order-revisions"]').click();await settled();
 const history=await get(`orders/${oid}/revisions`);assert.deepEqual(history.map(r=>r.revision),[2,1]);assert.ok(history[0].created_by&&history[0].created_at);assert.ok(history[0].changes.some(r=>r.field==='Факт выполнения'));
 await page.locator('[data-history-version="2"]').waitFor();assert.match(await page.locator('.snz-history').innerText(),/Уточнение состава/);
 for(const[width,height]of[[1440,900],[2560,1440]]){await page.setViewportSize({width,height});await page.evaluate(audit);assert.deepEqual(await page.evaluate(()=>({a:alignAudit(document.querySelector('.snz-history')),s:sizeAudit(document.querySelector('.snz-history'))})),{a:[],s:[]});await page.screenshot({path:new URL(`history-${width}.png`,out).pathname});}
 console.log('PASS history on form: adjacent differences, author and Moscow save time');
 const closing=await get('facts/close-preview?date=2026-11-10&shift=day&crew_id=install1');
 assert.equal((await page.request.post(base+'/objects/1/snz/facts/close',{data:{revision:closing.revision,date:'2026-11-10',shift:'day',crew_id:'install1',expected_hash:closing.fingerprint,request_id:'admin-ui-close'}})).status(),200);
 await page.locator('.snz-dialog [data-action="reload"]').click();await settled();await open(oid);await fill(1,'completed_at','2026-11-10T10:05');await page.locator('[data-admin-reason]').fill('Уточнено время закрытого СНЗ');await check();await save();
 assert.ok((await get(`orders/${oid}`)).closed_at);assert.equal((await get(`orders/${oid}/revisions/2`)).facts['e:1:install'].completed_at,'2026-11-10T09:45:00');
 console.log('PASS closed order can be amended, previous version retains its fact');
 await open(oid);await fill(1,'minutes','40');await page.locator('[data-admin-reason]').fill('Сохранить при восстановлении связи');await check();
 await page.route('**/admin-revisions',r=>r.fulfill({status:503,json:{detail:'Учебный отказ'}}));await action('admin-save').click();await settled();assert.ok(await action('admin-save').isDisabled());assert.equal(await field(1,'minutes').inputValue(),'40');assert.match(await page.locator('.snz-admin-editor').innerText(),/Результат записи не подтверждён/);
 await page.unrouteAll({behavior:'wait'});await action('admin-refresh').click();await settled();assert.equal(await field(1,'minutes').inputValue(),'35');await action('admin-cancel').click();
 console.log('PASS unknown save result blocks retry, retains edits; refresh reloads persisted version');
 await page.locator('.snz-dialog [data-action="close"]').click();
 await page.route('**/objects/1/snz/state',async route=>{const response=await route.fetch(),body=await response.json();body.can_admin_edit=false;await route.fulfill({response,json:body});});
 await page.locator('[data-snz-open]').click();await settled();await page.locator('.snz-tabs [data-tab="orders"]').click();assert.equal(await page.locator('[data-action="admin-edit-open"]').count(),0);assert.ok(await page.locator('[data-action="order-revisions"]').count()>0);
 assert.deepEqual(errors,[]);console.log('PASS administrative controls hidden for regular users; no browser errors');
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
