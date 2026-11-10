// End-to-end against snz_workspace_test_server.py. Only disposable loopback data.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8053';
assert.ok(new URL(base).hostname==='127.0.0.1');
const out=new URL('../outputs/snz-workspace/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('PASS '+name);};
const mode=page.locator('[data-snzi="mode"]'), rows=page.locator('#snz-register tbody tr[aria-selected]');
const waitRows=n=>page.waitForFunction(n=>document.querySelectorAll('#snz-register tbody tr[aria-selected]').length===n,n);
const field=(k,v)=>page.locator(`[data-snzi="${k}"]`).selectOption(v);
try{
 await page.request.patch(base+'/elements/7/status',{data:{status:'delivered',comment:'Сброс учебной проверки'}});
 const initial=await(await page.request.get(base+'/objects/1/snz/state')).json();delete initial.state.facts;initial.state.assignments=initial.state.assignments.filter(a=>a.element_id<=4);await page.request.put(base+'/objects/1/snz/state',{data:{revision:initial.revision,...initial.state}});
 await page.goto(base+'/v2?object_id=1#/ws-foreman');
 await page.locator('.ws-tabs [data-tab="snz"]').click();await waitRows(8);
 check('Registry starts with all elements and left filters stay visible',await page.locator('#ws-left').isVisible());
 check('Old registry toolbar and card selector are removed',await page.locator('.snzi-head,[data-snzi="card"]').count()===0);
 check('Expanded planner button is directly below the title',await page.locator('.snzi-panel h3 + [data-snz-open]').count()===1);
 check('Planning date and date filter are separate fields',await page.getByLabel('Дата (отбор)',{exact:true}).count()===1&&await page.getByLabel('Дата',{exact:true}).isVisible());
 check('Chronology control is hidden in foreman workspace',!await page.frameLocator('iframe.ws-frame').locator('#timeline-bar').isVisible());
 check('Status starts collapsed',await page.locator('[data-snzi-fold]').getAttribute('open')===null);
 await page.locator('[data-snzi-page]').check();await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 8.'));
 check('Header checkbox selects the current page',await page.locator('[data-snzi-check]:checked').count()===8);
 await page.locator('[data-snzi-page]').uncheck();await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 0.'));

 await field('mode','all');await waitRows(6);
 check('All shows only ready elements',await rows.count()===6);
 await field('mode','unplanned');await waitRows(2);
 check('No date shows only unplanned ready elements',await rows.count()===2);

 const frame=page.frameLocator('iframe.ws-frame');
 await frame.locator('.element-shape[data-id="5"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 1.'));
 await page.locator('[data-snzi-fold] summary').click();
 check('Single click on model selects item for planning',await page.locator('#ws-sform').isVisible());
 check('Ready status remains available for a ready item',await page.locator('#ws-sform option[value="ready_for_installation"]').count()===1);
 await frame.locator('.element-shape[data-id="6"]').click({modifiers:['Meta']});
 await page.waitForFunction(()=>document.querySelector('[data-snzi-count]').textContent.startsWith('Выбрано: 2.'));
 check('Ctrl click adds a second model item',await page.locator('[data-snzi-status]').innerText().then(t=>t.includes('Выбрано изделий: 2')));
 await page.locator('[data-snzi="date"]').fill('2026-11-12');await page.locator('[data-snzi="date"]').press('Tab');
 await field('shift','night');await field('crew','install2');await waitRows(2);
 check('Planning under no-date filter is enabled',await page.locator('[data-snzi-action="plan"]').isEnabled());
 let puts=0;page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/snz/state'))puts++;});
 await page.locator('[data-snzi-action="plan"]').click();await waitRows(0);
 check('One atomic save assigns both items and removes them from unplanned',puts===1);
 const saved=await(await page.request.get(base+'/objects/1/snz/state')).json();
 check('Assigned date shift and crew persist',saved.state.assignments.filter(a=>[5,6].includes(a.element_id)).every(a=>a.date==='2026-11-12'&&a.shift==='night'&&a.crew_id==='install2'));
 await field('mode','date');await page.locator('[data-snzi="filterDate"]').fill('2026-11-12');await page.locator('[data-snzi="filterDate"]').press('Tab');await waitRows(2);
 await page.locator('[data-snzi="date"]').fill('2026-11-13');await page.locator('[data-snzi="date"]').press('Tab');await waitRows(2);
 check('Planning date does not change the date filter',await page.locator('[data-snzi="filterDate"]').inputValue()==='2026-11-12');
 await page.reload();await page.locator('.ws-tabs [data-tab="snz"]').click();await waitRows(8);
 await field('mode','date');await page.locator('[data-snzi="filterDate"]').fill('2026-11-10');await page.locator('[data-snzi="filterDate"]').press('Tab');await waitRows(1);
 await field('shift','night');await waitRows(1);await field('crew','install2');await waitRows(0);await field('crew','');await waitRows(1);
 check('Date day/night and crew filters intersect',await rows.count()===1);
 await field('shift','');await waitRows(3);await field('crew','install2');await waitRows(1);
 await field('mode','all');await waitRows(6);
 const floor=page.locator('#ws-left [data-group="floor"]');await floor.click();
 const floorChecks=page.locator('#ws-left input[data-g="floor"]');
 if(await floorChecks.count()) {await floorChecks.first().uncheck();await page.waitForTimeout(400);check('Left filters intersect extra SNZ filter',await rows.count()<6);}
 else throw new Error('Find floor filter selectors');
 await field('mode','');await page.waitForTimeout(400);
 check('Empty date removes only SNZ filter',await rows.count()===4);
 await page.locator('#ws-left [data-act="reset-filters"]').click();await waitRows(8);
 await page.locator('[data-snzi-check="7"]').check();
 await page.locator('[data-snzi-fold] summary').click();
 await page.locator('#eo-gform').waitFor();
 check('Existing bulk status form is available inside SNZ',await page.locator('[data-snzi-status] form').count()===1);
 await page.locator('#eo-gform [name="status"]').selectOption('ready_for_installation');
 await page.locator('#eo-gform [name="comment"]').fill('Учебная проверка из вкладки СНЗ');
 await page.locator('#eo-gform button[type="submit"]').click();await page.locator('[data-eo="g-apply"]').click();await page.getByRole('button',{name:'Применить',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#snz-register [data-snzi-check="7"]')?.closest('tr').textContent.includes('Готов к монтажу'));
 check('Status save updates the registry through the existing handler',true);
 const rowField=(id,field)=>page.locator(`[data-snzi-row="${field}"][data-id="${id}"]`);
 const rowSave=async(id,field,value)=>{
   const response=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/snz/state'));
   if(['shift','crew_id'].includes(field))await rowField(id,field).selectOption(value);
   else{await rowField(id,field).fill(value);await rowField(id,field).press('Tab');}
   assert.equal((await response).status(),200);
   await page.waitForFunction(()=>!document.querySelector('[data-snzi-action="refresh"]').disabled);
 };
 await rowSave(5,'date','2026-11-14');await rowSave(6,'shift','day');await rowSave(6,'crew_id','install1');await rowSave(6,'priority','17');
 const edited=await(await page.request.get(base+'/objects/1/snz/state')).json();
 check('Row date, shift, crew and order save to the real API',edited.state.assignments.find(a=>a.element_id===5).date==='2026-11-14'&&edited.state.assignments.find(a=>a.element_id===6).priority===17&&edited.state.assignments.find(a=>a.element_id===6).crew_id==='install1'&&edited.state.assignments.find(a=>a.element_id===6).shift==='day');
 check('Order replaces the old mounting column',await page.locator('.snzi-table th').allTextContents().then(headers=>headers.includes('Очередность')&&!headers.includes('Монтаж')));
 check('Delivered items have read-only appointment fields',!await rowField(8,'date').isEnabled());
 await page.locator('#snz-register').evaluate(el=>el.scrollTop=120);
 const sticky=await page.locator('#snz-register').evaluate(el=>{const header=el.querySelector('th').getBoundingClientRect(),box=el.getBoundingClientRect();return Math.abs(header.top-box.top)<3;});
 check('Table header stays visible while registry scrolls',sticky);
 await page.locator('[data-snzi-fold] summary').click();await field('mode','all');await waitRows(7);
 check('Collapsed status survives scene updates',await page.locator('[data-snzi-fold]').getAttribute('open')===null);
 await field('mode','');await waitRows(8);
 // A stale revision must preserve persisted values and require refresh.
 await page.route('**/objects/1/snz/state',async route=>{
   if(route.request().method()==='PUT')await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Назначения изменились. Обновите СНЗ.'})});else await route.continue();
 });
 const conflict=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/snz/state'));
 await rowField(6,'priority').fill('18');await rowField(6,'priority').press('Tab');assert.equal((await conflict).status(),409);
 await page.locator('[data-snzi-result][role="alert"]').waitFor();
 check('Conflict preserves the row and blocks repeated writes',await rowField(6,'priority').inputValue()==='17'&&!await rowField(6,'priority').isEnabled());
 await page.unrouteAll({behavior:'wait'});await page.locator('[data-snzi-action="refresh"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-snzi-action="refresh"]').disabled);
 check('Refresh restores row editing after conflict',await rowField(6,'priority').isEnabled());
 let failFollowingRead=false;
 await page.route('**/objects/1/snz/state',async route=>{
   if(route.request().method()==='PUT'){failFollowingRead=true;await route.continue();}
   else if(failFollowingRead){failFollowingRead=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Учебный отказ обновления'})});}
   else await route.continue();
 });
 await rowSave(6,'priority','18');
 const committedAfterReadFailure=await(await page.request.get(base+'/objects/1/snz/state')).json();
 check('Confirmed save remains visible if subsequent reading fails',await rowField(6,'priority').inputValue()==='18'&&!await rowField(6,'priority').isEnabled()&&committedAfterReadFailure.state.assignments.find(a=>a.element_id===6).priority===18);
 await page.unrouteAll({behavior:'wait'});await page.locator('[data-snzi-action="refresh"]').click();await page.waitForFunction(()=>!document.querySelector('[data-snzi-action="refresh"]').disabled);
 await rowSave(6,'priority','17');

 await page.route('**/objects/1/snz/state',async route=>{const response=await route.fetch(),body=await response.json();body.locked_element_ids=[...body.locked_element_ids,5];await route.fulfill({response,json:body});});
 await page.locator('[data-snzi-action="refresh"]').click();await page.waitForFunction(()=>!document.querySelector('[data-snzi-action="refresh"]').disabled);
 check('Issued assignments have protected date, shift, crew and order',!await rowField(5,'shift').isEnabled()&&!await rowField(5,'crew_id').isEnabled()&&!await rowField(5,'priority').isEnabled());
 await page.unrouteAll({behavior:'wait'});await page.locator('[data-snzi-action="refresh"]').click();await page.waitForFunction(()=>!document.querySelector('[data-snzi-row="date"][data-id="5"]').disabled);
 await page.locator('#snz-register').evaluate(el=>el.scrollLeft=0);
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);
  const issues=await page.evaluate(()=>({a:alignAudit(document.querySelector('.snzi-panel')),s:[...sizeAudit(document.querySelector('.snzi-panel')),...sizeAudit(document.querySelector('#snz-register'))]}));
  check('Fields aligned and sized at '+size.width,!issues.a.length&&!issues.s.length);
  await page.screenshot({path:new URL(`workspace-${size.width}.png`,out).pathname});
 }
 await page.locator('[data-snz-open]').click();await page.locator('.snz-dialog [data-tab="cards"]').click();
 await page.locator('[data-filter="card"]').selectOption('ok_column_middle_lower');
 const bad=page.locator('[data-path="cards.2.steps.0.minutes"]');await bad.fill('0');await bad.press('Tab');
 await page.locator('.snz-dialog [data-tab="plan"]').click();const priorPuts=puts;
 await page.locator('.snz-dialog [data-action="save"]').click();
 await page.locator('[data-path="cards.2.steps.0.minutes"][aria-invalid="true"]').waitFor();
 check('Zero norm opens its card, highlights the field and preserves edits',puts===priorPuts&&await bad.inputValue()==='0');
 check('Norm error names the card and operation in Russian',await page.locator('.snz-error').innerText().then(t=>t.includes('Колонна средняя')&&t.includes('Подготовка')&&!t.includes('cards.')));
 await bad.fill('');await bad.press('Tab');await page.locator('.snz-dialog [data-action="save"]').click();
 await page.waitForFunction(()=>document.querySelector('.snz-message')?.textContent.includes('сохранены'));
 const fixed=await(await page.request.get(base+'/objects/1/snz/state')).json();
 check('Clearing a norm saves unknown as null',fixed.state.cards[2].steps[0].minutes===null);
 await page.locator('.snz-dialog [data-action="close"]').click();
 await page.locator('.ws-tabs [data-tab="props"]').click();check('Leaving SNZ hides registry',await page.locator('#snz-register').isHidden());
 await page.locator('.ws-tabs [data-tab="snz"]').click();await field('mode','all');await waitRows(7);
 await page.frames().find(f=>f!==page.mainFrame()).evaluate(()=>window.parent.postMessage({proto:'zhbi-scene/1',evt:'filtered-ids',objectId:1,ids:[8],snzTicket:-1},window.parent.location.origin));
 await page.waitForTimeout(200);check('Stale scope response cannot replace the register',await rows.count()===7);
 await field('mode','');await waitRows(8);
 await page.locator('#v2-object-btn').click();await page.locator('[data-object-id="2"]').click();await page.locator('[data-go="ws-foreman"]').click();await page.locator('.ws-tabs [data-tab="snz"]').click();await waitRows(0);
 check('Switching object resets scope and reloads its state',await mode.inputValue()==='');
 await page.locator('#v2-object-btn').click();await page.locator('[data-object-id="1"]').click();await page.locator('[data-go="ws-foreman"]').click();await page.locator('.ws-tabs [data-tab="snz"]').click();await waitRows(8);
 check('Returning to object restores its assignments',await rowField(5,'date').inputValue()==='2026-11-14');
 await page.route('**/me/permissions?object_id=1',async route=>{const r=await route.fetch(),body=await r.json();body.system_admin=false;body.features.status='read';await route.fulfill({response:r,json:body});});
 await page.route('**/objects/1/snz/state',async route=>{const r=await route.fetch(),body=await r.json();body.can_write=false;await route.fulfill({response:r,json:body});});
 await page.reload();await page.locator('.ws-tabs [data-tab="snz"]').click();await waitRows(8);
 await page.locator('[data-snzi-check="5"]').check();await field('mode','date');
 await page.locator('[data-snzi-fold] summary').click();
 await page.locator('[data-snzi-status]').getByText('Нет права изменять статусы на этом объекте.').waitFor();
 check('Registry is read-only without planning rights',!await rowField(1,'date').isEnabled()&&!await rowField(1,'shift').isEnabled()&&!await rowField(1,'crew_id').isEnabled());
 check('Read-only rights allow filters but disable writes',!await page.locator('[data-snzi-action="plan"]').isEnabled()&&await page.locator('[data-snzi-status] form').count()===0);
 const ordinary=await browser.newPage({viewport:{width:1440,height:900}});
 await ordinary.goto(base+'/v2?object_id=1#/ws-model');
 await ordinary.frameLocator('iframe.ws-frame').locator('#timeline-bar').waitFor();
 check('Chronology is retained in ordinary model workspace',await ordinary.frameLocator('iframe.ws-frame').locator('#timeline-bar').isVisible());await ordinary.close();
 check('No browser errors',errors.length===0);
 await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
