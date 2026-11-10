// Only snz_workspace_test_server.py with a fresh disposable synthetic database.
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8068';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-ignore-fact/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));
const action=async name=>{await page.locator(`.snz-dialog [data-action="${name}"]`).click();await settled();};
const state=async()=>await(await page.request.get(base+'/objects/1/snz/state')).json();
try{
 const initial=await state(),scopes=[['2026-11-10','day'],['2026-11-10','night'],['2026-11-11','day'],['2026-11-11','night']];
 initial.state.assignments=initial.state.assignments.map((a,i)=>({...a,date:scopes[i][0],shift:scopes[i][1],crew_id:'install1',priority:1}));initial.state.assignments.push({...initial.state.assignments[1],element_id:5,priority:2});delete initial.state.facts;
 assert.equal((await page.request.put(base+'/objects/1/snz/state',{data:{revision:initial.revision,...initial.state}})).status(),200);
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settled();
 const flag=page.getByLabel('Не учитывать факт',{exact:true});check('Ordinary calculation is the default',!await flag.isChecked());
 await page.locator('[data-filter="date"]').fill('2026-11-10');await page.locator('[data-filter="date"]').press('Tab');await action('preview');
 check('Ordinary preview can be issued',await page.locator('[data-action="issue"]').isEnabled());
 await flag.check();check('Changing mode invalidates the old preview',await page.locator('[data-action="issue"]').isDisabled()&&await page.locator('.snz-result').count()===0);
 for(let i=0;i<scopes.length;i++){
  const [day,shift]=scopes[i];await page.locator('[data-filter="date"]').fill(day);await page.locator('[data-filter="date"]').press('Tab');await page.locator('[data-filter="shift"]').selectOption(shift);
  if(i===1){await flag.uncheck();await action('preview');check('Ordinary night still carries unfinished day work',await page.locator('.snz-result').innerText().then(t=>t.includes('перенос')));await flag.check();}
  await action('preview');check('Plan-only preview has no carry '+i,!await page.locator('.snz-result').innerText().then(t=>t.includes(' · перенос'))&&await page.locator('[data-snz-mode]').isVisible());
  if(i===1){
   await page.locator('[data-action="sequence-up"][data-id="5"]').click();await settled();
   check('Reordering keeps the plan-only mode',await page.locator('[data-snz-mode]').isVisible()&&!await page.locator('.snz-result').innerText().then(t=>t.includes(' · перенос')));
   const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
   for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
    await page.setViewportSize(size);await page.evaluate(audit);const problems=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
    check('Checkbox alignment '+size.width,!problems.align.length&&!problems.size.length);await page.screenshot({path:new URL(`ignore-fact-${size.width}.png`,out).pathname});
   }
  }
  await action('issue');const data=await state(),order=data.orders[0],saved=await(await page.request.get(base+`/objects/1/snz/orders/${order.id}`)).json();
  check('Independent issued composition '+i,saved.ignore_fact===true&&JSON.stringify(saved.items.map(e=>e.id).sort((a,b)=>a-b))===JSON.stringify(i===1?[2,5]:[i+1]));
  check('Mode is visible in issued document '+i,await page.locator('[data-snz-mode]').isVisible());
 }
 check('Four future shifts issued without completing earlier work',(await state()).orders.length===4&&Object.keys((await state()).state.facts).length===0);
 check('No browser errors',errors.length===0);await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
