// Fresh snz_workspace_test_server.py database only; never a production endpoint.
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8069';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-montage-facts/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
const action=async name=>{await page.locator(`.snz-dialog [data-action="${name}"]`).click();await settled();};
const data=async()=>await(await page.request.get(base+'/objects/1/snz/state')).json();
const row=id=>page.locator(`[data-montage-row="${id}"]`),time=id=>page.locator(`[data-montage-time="${id}"]`);
try{
 const initial=await data();for(const a of initial.state.assignments)Object.assign(a,{date:'2026-11-10',shift:'day',crew_id:'install1'});delete initial.state.facts;
 assert.equal((await page.request.put(base+'/objects/1/snz/state',{data:{revision:initial.revision,...initial.state}})).status(),200);
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settled();
 await page.locator('[data-filter="date"]').fill('2026-11-10');await page.locator('[data-filter="date"]').press('Tab');await page.getByLabel('Не учитывать факт',{exact:true}).check();await action('preview');await action('issue');
 await page.locator('.snz-dialog [data-tab="facts"]').click();await settled();
 check('Fact tab lists installation items from issued documents',await page.locator('[data-montage-row]').count()===4);
 await time(1).fill('2026-11-10T22:30:15');await row(1).locator('[data-action="montage-complete"]').click();await settled();
 let saved=await data();check('Explicit time creates only montage fact and mounted status',saved.state.facts['e:1:install'].completed_at==='2026-11-10T22:30:15'&&!saved.state.facts['e:1:rebar1']&&saved.elements.find(e=>e.id===1).current_status==='installed');
 check('Confirmed time is displayed from the status timeline',await time(1).inputValue()==='2026-11-10T22:30:15'&&!await time(1).isEnabled());
 await row(2).locator('[data-action="montage-complete"]').click();await settled();check('Empty time defaults to status assignment time',!!(await data()).state.facts['e:2:install'].completed_at&&await time(2).inputValue()!=='');
 const status=await page.request.patch(base+'/elements/3/status',{data:{status:'installed',changed_at:'2026-11-11 02:10:11',comment:'Учебная внешняя отметка'}});assert.equal(status.status(),200);
 await action('facts-refresh');check('A status set outside SNZ appears as completed montage',await time(3).inputValue()==='2026-11-11T02:10:11'&&await row(3).innerText().then(t=>t.includes('100 %')));
 const history=(await status.json()).history,hid=history.find(h=>h.status==='installed').id;
 assert.equal((await page.request.patch(base+`/elements/3/history/${hid}`,{data:{changed_at:'2026-11-11T02:20:12'}})).status(),200);
 await action('facts-refresh');check('A history time correction is reflected in SNZ',await time(3).inputValue()==='2026-11-11T02:20:12');
 assert.equal((await page.request.patch(base+'/elements/3/status',{data:{status:'delivered',changed_at:'2026-11-11 03:00:00'}})).status(),200);
 await action('facts-refresh');check('Status rollback removes mounted confirmation',await time(3).inputValue()===''&&await row(3).innerText().then(t=>t.includes('0 %')));
 await page.locator('[data-fact-filter="shift"]').selectOption('night');await settled();check('Shift filter selects the issued shift',await page.locator('[data-montage-row]').count()===0);
 await page.locator('[data-fact-filter="shift"]').selectOption('');await settled();await page.locator('[data-fact-search]').fill('Р-4');check('Fact search selects an individual item',await page.locator('[data-montage-row]').count()===1);await page.locator('[data-fact-search]').fill('');
 await page.route('**/objects/1/snz/facts',async route=>route.request().method()==='POST'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Учебный конфликт'})}):route.continue());
 await time(4).fill('2026-11-10T23:15');await row(4).locator('[data-action="montage-complete"]').click();await settled();check('Conflict preserves entered time and blocks repeated writes',await time(4).inputValue()==='2026-11-10T23:15'&&!await row(4).locator('[data-action="montage-complete"]').isEnabled());
 await page.unrouteAll({behavior:'wait'});page.once('dialog',d=>d.accept());await action('facts-refresh');
 let afterWrite=false;await page.route('**/objects/1/snz/facts**',async route=>{if(route.request().method()==='POST'){afterWrite=true;await route.continue();}else if(afterWrite){afterWrite=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Учебный сбой чтения'})});}else await route.continue();});
 await time(4).fill('2026-11-10T23:15');await row(4).locator('[data-action="montage-complete"]').click();await settled();check('A confirmed save with failed refresh cannot be repeated',!!(await data()).state.facts['e:4:install']&&!await row(4).locator('[data-action="montage-complete"]').isEnabled());
 await page.unrouteAll({behavior:'wait'});await action('facts-refresh');check('Refresh restores the confirmed result',!await time(4).isEnabled());
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);const issues=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
  check('Fact layout aligned '+size.width,!issues.align.length&&!issues.size.length);await page.screenshot({path:new URL(`facts-${size.width}.png`,out).pathname});
 }
 await page.route('**/objects/1/snz/facts?*',async route=>{const response=await route.fetch(),body=await response.json();body.can_fact=false;await route.fulfill({response,json:body});});await action('facts-refresh');
 check('Read-only users can filter but cannot record facts',await page.locator('[data-fact-filter="shift"]').isEnabled()&&!await time(3).isEnabled()&&!await row(3).locator('[data-action="montage-complete"]').isEnabled());
 check('No browser errors',errors.length===0);await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}catch(e){await page.screenshot({path:new URL('failure.png',out).pathname});console.log((await page.locator('.snz-dialog').innerText()).slice(0,1200));throw e;}finally{await browser.close();}
