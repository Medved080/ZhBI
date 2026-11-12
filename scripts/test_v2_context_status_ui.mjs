// Disposable loopback fixture: snz_fact_report_test_server.py 8084.
import {chromium} from 'playwright';import assert from 'node:assert/strict';import {mkdir,readFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8084';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/v2-context-status/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl']}),page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const menu=page.locator('.v2-scene-context'),dialog=page.locator('.eo-context-status');
const scene=()=>page.frames().find(f=>f!==page.mainFrame());
const context=async id=>{await page.frameLocator('iframe.ws-frame').locator(`.element-shape[data-id="${id}"]`).click({button:'right'});await menu.waitFor();};
const closeDialog=async()=>page.locator('.eo-dialog [data-x]').click();
try{
 await page.goto(base+'/v2?object_id=1#/ws-model');await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="1"]').waitFor();
 await context(1);assert.equal(await menu.locator('[data-context-status]').count(),8);assert.ok(await menu.locator('[data-context-status="ready_for_installation"]').isDisabled());assert.ok(await page.frameLocator('iframe.ws-frame').locator('#ctx-menu').isHidden());
 await page.keyboard.press('Escape');assert.equal(await menu.count(),0);
 // A different element becomes the sole target, even after a former multi-selection.
 await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').click();await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="3"]').click({modifiers:['Meta']});await context(1);assert.match(await menu.innerText(),/Р-1/);
 await menu.locator('[data-context-status="installed"]').click();await dialog.waitFor();assert.equal(await dialog.locator('[name="status"]').inputValue(),'installed');
 await dialog.locator('[name="at"]').fill('2026-11-10T11:35');await dialog.locator('[name="comment"]').fill('Монтаж через ПКМ V2');
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const[width,height]of[[1440,900],[2560,1440]]){await page.setViewportSize({width,height});await page.evaluate(audit);assert.deepEqual(await page.evaluate(()=>({a:alignAudit(document.querySelector('.eo-context-status')),s:sizeAudit(document.querySelector('.eo-context-status'))})),{a:[],s:[]});await page.screenshot({path:new URL(`form-${width}.png`,out).pathname});}
 const writes=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/element-ops/status-batch'))writes.push({frame:r.frame()===page.mainFrame(),body:r.postDataJSON()});});
 await dialog.locator('button[type="submit"]').click();
 const confirmation=page.getByRole('dialog').filter({hasText:'Изменение попадёт в историю статусов.'});if(await confirmation.count())await confirmation.getByRole('button',{name:'Сохранить',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.eo-context-status')?.textContent.includes('Статус изменён')||document.querySelector('.eo-context-status')?.textContent.includes('Уже выполнено'));
 assert.ok(writes.length>=2&&writes.every(r=>r.frame&&r.body.items.length===1&&r.body.items[0].element_id===1));
 const facts=await(await page.request.get(base+'/objects/1/snz/facts?date=2026-11-10')).json();assert.equal(facts.items.find(e=>e.id===1).completed_at,'2026-11-10T11:35:00');assert.equal(facts.items.find(e=>e.id===2).current_status,'ready_for_installation');
 console.log('PASS real 2D right click, eight statuses, modal/date/comment, V2-only preview/apply, SNZ montage integration');await closeDialog();
 // Double-click uses the same entry point; cancel sends no new mutation.
 const count=writes.length;await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').dblclick();await menu.waitFor();await menu.locator('[data-context-status="delivered"]').click();await dialog.waitFor();await closeDialog();assert.equal(writes.length,count);
 console.log('PASS double click and cancellation');
 for(const[width,height]of[[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});await context(2);await page.evaluate(audit);assert.deepEqual(await page.evaluate(()=>alignAudit(document.querySelector('.v2-scene-context'))),[]);const box=await menu.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);await page.screenshot({path:new URL(`menu-${width}.png`,out).pathname});await page.keyboard.press('Escape');
 }
 // Rendered 3D and light 3D: find a visible triangle using the renderer's real raycast.
 for(const mode of ['3d','3d-light']){
  await page.locator(`#ws-modes [data-view="${mode}"]`).click();await scene().waitForFunction(()=>state.view3d.active&&state.view3d.merged&&state.view3d.renderer);
  const point=await scene().evaluate(()=>{
   const v=state.view3d,r=v.renderer.domElement.getBoundingClientRect();
   for(let y=r.top+10;y<r.bottom-10;y+=8)for(let x=r.left+10;x<r.right-10;x+=8){const el=pick3DElementAt(x,y);if(el)return{x,y,id:el.id};}return null;
  });assert.ok(point,mode+' has visible products');
  const box=await page.locator('iframe.ws-frame').boundingBox();await page.mouse.click(box.x+point.x,box.y+point.y,{button:'right'});await menu.waitFor();assert.match(await menu.innerText(),new RegExp('Р-'+point.id));await page.keyboard.press('Escape');
  await page.mouse.move(box.x+point.x,box.y+point.y);await page.mouse.down({button:'right'});await page.mouse.move(box.x+point.x+18,box.y+point.y+18,{steps:4});await page.mouse.up({button:'right'});await page.waitForTimeout(120);assert.equal(await menu.count(),0);
 }
 console.log('PASS real raycast right click in 3D and light 3D');
 // Chronological view must never open the status entry point.
 await page.locator('#ws-modes [data-view="2d"]').click();await scene().evaluate(()=>window.zhbiTimeline._setMode('chrono'));await page.waitForTimeout(300);
 await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').click({button:'right'});await page.waitForTimeout(250);assert.equal(await menu.count(),0);
 console.log('PASS historical view blocks editing');
 await page.route('**/me/permissions?object_id=1',async route=>{const response=await route.fetch(),body=await response.json();body.system_admin=false;body.features.status='read';await route.fulfill({response,json:body});});
 await page.reload();await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').waitFor();await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').click({button:'right'});await page.waitForTimeout(200);assert.equal(await menu.count(),0);
 await page.unrouteAll({behavior:'wait'});
 for(const ws of ['foreman','picker']){
  await page.goto(base+`/v2?object_id=1#/ws-${ws}`);await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="2"]').waitFor();await context(2);
  await menu.locator('[data-context-status="delivered"]').click();await dialog.waitFor();await closeDialog();
  await context(2);await page.frameLocator('iframe.ws-frame').locator('.element-shape[data-id="1"]').click();await page.waitForFunction(()=>!document.querySelector('.v2-scene-context'));
 }
 console.log('PASS foreman and picker workspaces, outside-scene click dismisses menu');
 await page.evaluate(()=>window.postMessage({proto:'zhbi-scene/1',evt:'context-menu',objectId:1,id:2,x:50,y:50,state:{objectId:1,selectedId:2}},location.origin));await page.waitForTimeout(100);assert.equal(await menu.count(),0);
 assert.deepEqual(errors,[]);console.log('PASS read-only rights, source validation, no JavaScript errors');
}finally{await page.screenshot({path:new URL('last.png',out).pathname});await browser.close();}
