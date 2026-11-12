// Run only against a fresh snz_fact_report_test_server.py fixture.
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8073';assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const out=new URL('../outputs/snz-fact-report-ui/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));const check=(name,ok)=>{checks.push({name,ok});assert.ok(ok,name);console.log('PASS '+name)};
const state=()=>page.request.get(base+'/objects/1/snz/state').then(r=>r.json());const facts=()=>page.request.get(base+'/objects/1/snz/facts?date=2026-11-10').then(r=>r.json());
const action=a=>page.locator(`[data-action="${a}"]`).click();
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
const tab=async k=>{await page.locator(`.snz-tabs [data-tab="${k}"]`).click();await settled();};
const row=id=>page.locator(`[data-montage-row="${id}"]`);
const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
async function layout(root,name){for(const size of [{width:1440,height:900},{width:2560,height:1440}]){await page.setViewportSize(size);await page.evaluate(audit);
 const issue=await page.evaluate(sel=>({align:alignAudit(document.querySelector(sel)),size:sizeAudit(document.querySelector(sel))}),root);
 check(`${name} aligned ${size.width}`,!issue.align.length&&!issue.size.length);await page.screenshot({path:new URL(`${name}-${size.width}.png`,out).pathname});}await page.setViewportSize({width:1440,height:900});}
try{
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('[data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await page.waitForSelector('.snz-dialog');await settled();await tab('facts');
 check('Date defaults to today Moscow',await page.locator('[data-fact-filter="date"]').inputValue()===new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
 await page.locator('[data-fact-filter="date"]').fill('2026-11-10');await settled();check('Date includes both issued shifts',await page.locator('[data-montage-row]').count()===4);
 await row(2).locator('textarea').fill('Ожидается крепёж');await row(2).locator('[data-action="save-fact-note"]').click();await settled();check('Note saved independently of status', (await facts()).items.find(r=>r.id===2).orders[0].note==='Ожидается крепёж'&&(await facts()).items.find(r=>r.id===2).current_status==='ready_for_installation');
 await page.route('**/snz/facts/note',r=>r.fulfill({status:409,json:{detail:'Учебный конфликт примечания'}}));await row(2).locator('textarea').fill('Сохранить ввод при конфликте');await row(2).locator('[data-action="save-fact-note"]').click();await settled();
 check('Conflict keeps note text and blocks repeated writes',await row(2).locator('textarea').inputValue()==='Сохранить ввод при конфликте'&&!await row(2).locator('[data-action="save-fact-note"]').isEnabled());
 await page.unrouteAll({behavior:'wait'});page.once('dialog',d=>d.accept());await action('facts-refresh');await settled();
 await page.locator('[data-fact-filter="without"]').check();await settled();await row(1).locator('[data-montage-time]').fill('2026-11-10T11:10');await row(1).locator('[data-action="montage-complete"]').click();await settled();
 check('Without fact removes newly mounted item',await page.locator('[data-montage-row]').count()===3&&!await row(1).count());
 await page.locator('[data-fact-filter="without"]').uncheck();await settled();check('Confirmed time is read only',!await row(1).locator('[data-montage-time]').isEnabled());
 await page.locator('[data-fact-filter="crew"]').selectOption('install2');await settled();check('Crew filter applies',await page.locator('[data-montage-row]').count()===0);
 await page.locator('[data-fact-filter="crew"]').selectOption('install1');await settled();await page.locator('[data-fact-filter="shift"]').selectOption('night');await settled();check('Shift filter applies',await page.locator('[data-montage-row]').count()===2);await page.locator('[data-fact-filter="shift"]').selectOption('');await settled();
 await layout('.snz-dialog','facts');
 await tab('floors');await action('add-floor');await action('save');await settled();check('Missing floor elevation is not guessed',await page.locator('.snz-error').innerText().then(t=>t.includes('отметку пола')));
 await page.locator('[data-path="floor_levels.1.elevation_mm"]').fill('15800');await page.locator('[data-path="floor_levels.1.elevation_mm"]').press('Tab');await action('save');await settled();check('Manual floor catalog saved',(await state()).state.floor_levels.some(r=>r.floor===2&&r.elevation_mm===15800));await layout('.snz-dialog','floors');await tab('facts');
 for(const [act,file] of [['fact-xlsx','facts.xlsx'],['fact-pdf','facts.pdf']]){const next=page.waitForEvent('download');await action(act);const download=await next;await download.saveAs(new URL(file,out).pathname);await settled();check('Download '+file,true);}
 await action('extra-fact');await page.waitForSelector('.snz-extra-panel');check('Extra fact opens model and preserves standard filters',await page.locator('#ws-left [data-group="status"]').isVisible()&&!await page.locator('.snz-dialog').count());
 const scene=page.frames().find(f=>f!==page.mainFrame());await scene.locator('.element-shape[data-id="5"]').click();await page.locator('[data-extra-time]').fill('2026-11-11T01:30');check('Crew is required',!await page.locator('[data-extra-save]').isEnabled());await page.locator('[data-extra-shift]').selectOption('night');await page.waitForFunction(()=>!document.querySelector('[data-extra-refresh]').disabled);await page.locator('[data-extra-crew]').selectOption('install1');await page.waitForFunction(()=>!document.querySelector('[data-extra-save]').disabled);
 await layout('.snz-extra-panel','extra');await page.locator('[data-extra-save]').click();await page.waitForSelector('.snz-dialog');await settled();
 check('Extra fact returns to facts with outside label',await row(5).innerText().then(t=>t.includes('Вне СНЗ'))&&(await facts()).items.find(r=>r.id===5).completed_at==='2026-11-11T01:30:00');
 check('Extra fact does not edit issued composition',(await state()).orders.every(o=>o.quantity===2));
 await page.locator('[data-fact-filter="shift"]').selectOption('day');await settled();let prompt='';page.once('dialog',d=>{prompt=d.message();d.dismiss()});await action('close-orders');await settled();check('Close cancellation keeps documents open',!(await state()).orders.some(o=>o.closed_at));
 check('Close confirmation text matches requirement',prompt==='Перед закрытием СНЗ необходимо разнести факт, точно завершить СНЗ?');
 page.once('dialog',d=>d.accept());await action('close-orders');await settled();let s=await state();check('Close respects date shift and crew',s.orders.filter(o=>o.closed_at).length===1&&s.orders.find(o=>o.closed_at).shift==='day');
 check('Close releases only unmounted products',!s.state.assignments.some(a=>a.element_id===2)&&s.elements.find(e=>e.id===2).planned_installation_date===null&&s.elements.find(e=>e.id===2).transfer_from==='2026-11-10');
 check('Closed fact rows are read only',!await row(2).locator('[data-action="montage-complete"]').isEnabled()&&!await row(2).locator('textarea').isEnabled());
 await page.locator('[data-fact-filter="shift"]').selectOption('night');await settled();page.once('dialog',d=>d.accept());await action('close-orders');await settled();
 await tab('orders');check('Closed documents have no edit or delete buttons',await page.locator('[data-action="edit-order"]').count()===0&&await page.locator('[data-action="delete-order"]').count()===0);
 await tab('plan');await action('clear');await page.locator('[data-select="2"]').check();await page.locator('[data-filter="date"]').fill('2026-11-11');await page.locator('[data-filter="assignmentCard"]').selectOption('base');await action('assign');await action('save');await settled();await action('preview');await settled();
 check('Next day preview shows transfer source',await page.locator('.snz-result').innerText().then(t=>t.includes('Перенос с 10.11.2026')));await action('issue');await settled();
 s=await state();check('New SNZ contains only reassigned product',s.orders.find(o=>o.work_date==='2026-11-11').quantity===1);
 await tab('facts');await page.locator('[data-fact-filter="shift"]').selectOption('');await settled();await page.locator('[data-fact-filter="date"]').fill('2026-11-11');await settled();
 await page.route('**/objects/1/snz/facts?*',async route=>{const response=await route.fetch(),body=await response.json();body.can_fact=false;await route.fulfill({response,json:body});});await action('facts-refresh');await settled();
 check('Read-only users can filter and export but cannot change facts',await page.locator('[data-fact-filter="crew"]').isEnabled()&&await page.locator('[data-action="fact-xlsx"]').isEnabled()&&!await row(2).locator('textarea').isEnabled()&&!await page.locator('[data-action="close-orders"]').isEnabled()&&!await page.locator('[data-action="extra-fact"]').isEnabled());
 check('No browser errors',errors.length===0);await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}catch(e){await page.screenshot({path:new URL('failure.png',out).pathname});console.log((await page.locator('.snz-dialog').innerText().catch(()=>page.locator('body').innerText())).slice(0,1600));throw e;}finally{await browser.close();}
