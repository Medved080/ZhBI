// Real shell on a disposable anonymised DB and a fresh calculator DB; no production writes.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright';

const work=mkdtempSync(join(tmpdir(),'calc-updates-session-')),base='http://127.0.0.1:18172';
const out=resolve('output/validation/calc-updates-session');mkdirSync(out,{recursive:true});
const server=spawn('.venv312/bin/python',['scripts/real_auth_server.py','data/zhbi.anon.db','18172',work],{
 env:{...process.env,ZHBI_CALC_DIR:join(work,'calc'),ZHBI_CALC_ASSETS_DIR:resolve('data/calc/assets'),ZHBI_CALC_RECOVERY_WORKER:'0'},stdio:['ignore','pipe','pipe']});
let log='',browser;server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
const audit=readFileSync('scripts/ui_align_audit.js','utf8');
async function login(context){assert.equal((await context.request.post(base+'/login',{data:{domain_login:'admin',password:'Test-Pass-1234!'}})).status(),200);}
try{
 let ready=false;for(let i=0;i<160;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,250));}assert.ok(ready,log);
 const seeded=spawnSync('.venv312/bin/python',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE products SET document_model_id='1KS1-r1' WHERE legacy_key='product-0'\"); c.commit(); c.close()",join(work,'calc/calczhbi.sqlite3')],{encoding:'utf8'});assert.equal(seeded.status,0,seeded.stderr);
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:900}});await login(context);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();
 let build={build:'same-code',version:'0.147'},buildCalls=0;
 await page.route('**/app-build',route=>{buildCalls++;return route.fulfill({json:build});});
 // Long readings reproduce the overflow independently of a specific source product.
 await page.route('**/calc/api/workspace?lite=1',async route=>{
  const response=await route.fetch(),data=await response.json();data.project.name='Учебный калькулятор';
  const product=data.products[0].product;
  product.reinforcement={value:483.9,reference:250,scopeName:'Учебная группа',status:'high'};
  product.documentModel.readings={sheet:{doc:13,page:63},applied:['Арматура (ведомость расхода стали), закладные и петлевые выпуски '.repeat(8)],embedded:[['embedded','Закладная деталь МН1 — длинное обозначение детали',1,4]]};
  await route.fulfill({response,json:data});
 });
 await page.goto(base+'/calc/');await page.waitForFunction(()=>Boolean(window.CalcZhBIWorkspace));
 await page.locator('.pc-tabs [data-view="model"]').click();
 await page.waitForFunction(()=>document.querySelector('#pc-volume').textContent.trim());
 assert.ok(buildCalls>=1);
 assert.equal(await page.locator('#pc-update-notice').isHidden(),true);
 await page.clock.fastForward(15001);await page.waitForTimeout(50);
 assert.ok(buildCalls>=2);assert.equal(await page.locator('#pc-update-notice').isHidden(),true);
 console.log('PASS same build / server restart does not show update');
 await page.clock.resume();
 for(const [width,height] of [[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});
  await page.waitForTimeout(200);
  const bounds=await page.locator('#pc-project-properties').evaluate(el=>{
   const box=el.getBoundingClientRect();return {width:el.clientWidth,scroll:el.scrollWidth,cells:[...el.children].map(c=>{const r=c.getBoundingClientRect();return {text:c.textContent,left:r.left,right:r.right,bottom:r.bottom,top:r.top};}),left:box.left,right:box.right};
  });
  assert.ok(bounds.width>100);assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
  for(const cell of bounds.cells)assert.ok(cell.left>=bounds.left-1&&cell.right<=bounds.right+1,cell.text);
  assert.match(await page.locator('#pc-project-properties').innerText(),/Бетон по проекту/);
  assert.match(await page.locator('#pc-project-properties').innerText(),/Коэффициент армирования/);
  assert.match(await page.locator('#pc-project-properties').innerText(),/483,9/);
  assert.ok(await page.locator('#pc-project-properties dd').first().innerText());
  await page.screenshot({path:join(out,`properties-${width}.png`)});
 }
 console.log('PASS long source descriptions keep all properties within the panel');
 build={build:'changed-code-same-version',version:'0.147'};
 await page.clock.fastForward(15001);await page.locator('#pc-update-notice').waitFor({state:'visible'});
 for(const [width,height] of [[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(200);await page.evaluate(audit);
  assert.equal(await page.locator('#pc-update-notice').count(),1);
  assert.equal(await page.locator('.pc-workspace-nav').count(),1);
  assert.deepEqual(await page.evaluate(()=>({align:alignAudit(document.querySelector('#pc-update-notice')),size:sizeAudit(document.querySelector('#pc-update-notice'))})),{align:[],size:[]});
  await page.screenshot({path:join(out,`update-${width}.png`)});
 }
 console.log('PASS changed build, even with the same release version, shows persistent update notice');
 await page.locator('#pc-open-norms').click();await page.locator('#pc-norms-form').waitFor();
 const input=page.locator('#pc-norms-form input[name="c:default"]');await input.fill('12345');
 await page.locator('#pc-update-reload').click();assert.match(await page.locator('#pc-update-status').innerText(),/Сначала сохраните/);
 assert.equal(await input.evaluate(el=>window.CalcZhBIMoney.read(el)),'12345');
 // Restore form defaults, then ensure a failed product save blocks reload as well.
 await input.evaluate(el=>el.value=el.defaultValue);await page.locator('#pc-products-open').click();
 await page.evaluate(()=>{window.CalcZhBIWorkspace.select(window.CalcZhBIModelSpec.productKey,'calculation');});
 await page.route('**/calc/api/products',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{detail:'Проверка отказа сохранения'}}):route.continue());
 const qty=page.locator('#pc-rows input[data-id="concrete"][data-field="qty"]');await qty.fill('3');await qty.dispatchEvent('input');
 await page.locator('#pc-update-reload').click();await page.waitForFunction(()=>document.querySelector('#pc-update-status').textContent.includes('Проверка отказа сохранения'));
 assert.equal(await qty.inputValue(),'3');
 console.log('PASS unsaved norms and failed product saves preserve input and block reload');
 await page.unroute('**/calc/api/products');
 await Promise.all([page.waitForEvent('framenavigated',f=>f===page.mainFrame()),page.locator('#pc-update-reload').click()]);
 await page.waitForFunction(()=>Boolean(window.CalcZhBIWorkspace));
 assert.equal(await page.locator('#pc-update-notice').isHidden(),true);
 assert.equal(await page.locator('#pc-rows input[data-id="concrete"][data-field="qty"]').inputValue(),'3');
 console.log('PASS successful flush saves the correction before reload');
 await context.close();

 // Standalone and embedded calculator share session expiry with V2; initial login failure is not expiry.
 for(const target of ['/calc/','/v2#/calc','/?ui=v1']){
  const ctx=await browser.newContext({viewport:{width:1440,height:900}});await login(ctx);
  const p=await ctx.newPage();await p.goto(base+target);
  let frame=p;
  if(target==='/v2#/calc'){
   await p.waitForSelector('iframe[data-calc-embed]');frame=p.frames().find(f=>f!==p.mainFrame());
  }
  if(target.includes('calc'))await frame.waitForFunction(()=>Boolean(window.CalcZhBIWorkspace));
  else await p.waitForFunction(()=>state.currentUser!==null);
  if(target==='/v2#/calc'){
   await ctx.route('**/app-build',route=>route.fulfill({json:{build:'new-embedded-build',version:'0.148'}}));
   await frame.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await frame.locator('#pc-update-notice').waitFor({state:'visible'});
   await Promise.all([p.waitForEvent('framenavigated',f=>f===p.mainFrame()),frame.locator('#pc-update-reload').click()]);
   await p.waitForSelector('iframe[data-calc-embed]');frame=p.frames().find(f=>f!==p.mainFrame());
   await frame.waitForFunction(()=>Boolean(window.CalcZhBIWorkspace));
   console.log('PASS embedded update reloads the V2 shell and fetches fresh iframe HTML');
  }
  await p.route('**/fake-unauthorised',r=>r.fulfill({status:401,json:{detail:'Not a session error'}}));
  const result=await p.evaluate(async()=>{const r=await fetch('/fake-unauthorised');return {status:r.status,body:await r.json()};});
  assert.equal(result.status,401);assert.equal(result.body.detail,'Not a session error');assert.equal(await p.locator('#zhbi-session-expired').count(),0);
  await p.route('**/me',route=>route.fulfill({status:503,json:{detail:'Temporary outage'}}));
  await p.evaluate(()=>fetch('/fake-unauthorised'));assert.equal(await p.locator('#zhbi-session-expired').count(),0);
  await p.unroute('**/me');
  await ctx.clearCookies();
  if(target.includes('calc')){
   await frame.evaluate(()=>Promise.allSettled([window.CalcZhBIAPI.request('/calc/api/auth/me'),window.CalcZhBIAPI.ready()]));
  }else await p.evaluate(()=>fetch('/me'));
  await p.locator('#zhbi-session-expired').waitFor({state:'visible'});
  if(target==='/v2#/calc')assert.equal(await frame.locator('#zhbi-session-expired').count(),0);
  assert.equal(await p.locator('#zhbi-session-expired').count(),1);
  await p.keyboard.press('Escape');assert.equal(await p.locator('#zhbi-session-expired').isVisible(),true);
  await p.evaluate(()=>Promise.all([fetch('/me'),fetch('/me')]));assert.equal(await p.locator('#zhbi-session-expired').count(),1);
  for(const [width,height] of [[1440,900],[2560,1440]]){await p.setViewportSize({width,height});await p.screenshot({path:join(out,`session-${target.includes('v2')?'embedded':target.includes('calc')?'calc':'v1'}-${width}.png`)});}
  await ctx.close();
 }
 const guest=await browser.newContext(),guestPage=await guest.newPage();await guestPage.goto(base+'/v2');
 await guestPage.waitForSelector('input[name="domain_login"]');
 await guestPage.evaluate(()=>fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain_login:'admin',password:'wrong-test-password'})}));
 assert.equal(await guestPage.locator('#zhbi-session-expired').count(),0);await guest.close();
 console.log('PASS confirmed expiry blocks V1, standalone calculator and V2 including iframe; one modal, no redirect loop');
 assert.deepEqual(errors,[]);console.log('PASS no browser errors; QA: '+out);
}catch(error){console.error(log);throw error;}
finally{await browser?.close();server.kill('SIGTERM');}
