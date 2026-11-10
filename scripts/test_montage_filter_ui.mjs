// Synthetic montage_filter_fixture.py only. Covers actual UI controls and scene predicates, V1/V2 all JBI workspaces/views.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.MONTAGE_TEST_URL||'http://127.0.0.1:8071';
assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const out=new URL('../outputs/montage-filter/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const checks=[],errors=[];const check=(name,ok)=>{checks.push({name,ok});assert.ok(ok,name);console.log('PASS '+name);};
const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
try{
 for(const ui of ['v1','v2'])for(const ws of ['model','foreman','picker']){
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();page.on('pageerror',e=>errors.push(ui+'/'+ws+': '+e.message));
  // Independent saved states; actual persistence is verified explicitly below.
  await page.route('**/me/ui-state?*',r=>r.fulfill({json:{data:null}}));
  await page.goto(ui==='v2'?`${base}/v2?object_id=1#/ws-${ws}`:`${base}/?ui=v1&object_id=1&ws=${ws}`);
  let scene=page;
  if(ui==='v2'){
   await page.waitForSelector('iframe');scene=page.frames().find(f=>f!==page.mainFrame());
   await scene.waitForFunction(()=>typeof state!=='undefined'&&state.elements.length===8);
   if(ws!=='foreman')await page.locator(`[data-tab="${ws==='picker'?'pick':'filters'}"]`).click();
   await page.locator('[data-group="dates:smr"]').click();
  }else{
   await page.waitForFunction(w=>typeof state!=='undefined'&&state.elements.length===8&&workspace===w,ws);
   if(ws==='model')await page.locator('#sidebar [data-tab="filters"]').click();
   const group=page.locator(`${ws==='picker'?'#picker-panel':'#placement-filters'} [data-filter-key="smr"]`);
   // Model/foreman may use another host id; target the unique visible field group.
   const input=page.locator('[aria-label="Факт монтажа: Дата"]:visible');
   if(!await input.isVisible())await page.locator('[data-filter-key="smr"]:visible .filter-expand-btn').click();
  }
  const field=page.locator('[aria-label="Факт монтажа: Дата"]:visible');
  check(`${ui}/${ws} one date input`,await field.count()===1);
  await field.fill('2026-11-08');await field.press('Tab');
  await scene.waitForFunction(()=>state.dateFilters.montageFact.from==='2026-11-08');
  const ids=()=>scene.evaluate(()=>state.elements.filter(passesPlacementFilters).map(e=>e.id));
  check(`${ui}/${ws} report day includes accepted and reinstalled only`,JSON.stringify(await ids())==='[1,2,3]');
  for(const view of ['2d','3d','3d-light']){
   if(ui==='v2')await page.locator(`#ws-modes [data-view="${view}"]`).click();
   else await page.locator(`#btn-view-${view}`).click();
   await scene.waitForFunction(v=>v==='2d'?!state.view3d.active:state.view3d.active&&state.lowSpec===(v==='3d-light'),view);
   check(`${ui}/${ws}/${view} preserves date selection`,JSON.stringify(await ids())==='[1,2,3]');
   check(`${ui}/${ws}/${view} hides other SVG products`,JSON.stringify(await scene.evaluate(()=>[...state.shapeById].filter(([,shape])=>shape.style.display!=='none').map(([id])=>id)))==='[1,2,3]');
  }
  if(ui==='v2')await page.locator('#ws-modes [data-view="2d"]').click();else await page.locator('#btn-view-2d').click();
  // Snapshot persistence, intersection and 2D actual shape visibility.
  check(`${ui}/${ws} saves selected date`,await scene.evaluate(()=>uiStateSnapshot().dates.montageFact.from==='2026-11-08'));
  const predicate=ws==='picker'?'picker':'model';
  await scene.evaluate(kind=>{if(kind==='picker'){state.picker.sel.mark.add('Р-2');onPickerChange();}else{state.placementFilters.status.add('accepted');onPlacementFilterChange();}},predicate);
  check(`${ui}/${ws} intersects existing filters`,JSON.stringify(await ids())===(ws==='picker'?'[2]':'[1,3]'));
  await scene.evaluate(kind=>{if(kind==='picker'){state.picker.sel.mark.clear();onPickerChange();}else{state.placementFilters.status.clear();onPlacementFilterChange();}},predicate);
  await field.fill('2026-11-06');await field.press('Tab');await scene.waitForFunction(()=>state.dateFilters.montageFact.from==='2026-11-06');
  check(`${ui}/${ws} empty day shows no products`,(await ids()).length===0);
  await field.fill('');await field.press('Tab');await scene.waitForFunction(()=>!state.dateFilters.montageFact.from);
  check(`${ui}/${ws} clearing date restores products`,(await ids()).length===8);
  await field.fill('2026-11-08');await field.press('Tab');await scene.waitForFunction(()=>state.dateFilters.montageFact.from==='2026-11-08');
  // Live delta with unchanged installed status must replace the initial forecast-based date.
  await scene.evaluate(()=>{applyElementDelta({id:1,current_status:'installed',actual_installation_date:'2026-11-09'});applyPlacementFilters();});
  check(`${ui}/${ws} live history date edit removes product`,JSON.stringify(await ids())==='[2,3]');
  await scene.evaluate(()=>{applyElementDelta({id:1,current_status:'installed',actual_installation_date:'2026-11-08'});applyPlacementFilters();});
  if(ui==='v2'&&ws==='model'){
   const detail=await page.request.get(base+'/elements/1').then(r=>r.json());
   check('Element API exposes canonical montage date',detail.actual_installation_date==='2026-11-08');
   check('Accepted fixture remains mounted on original day',(await page.request.get(base+'/elements/2').then(r=>r.json())).current_status==='accepted');
   await scene.evaluate(()=>pollChanges(true));
   const change=await page.request.patch(base+`/elements/1/history/${detail.history[0].id}`,{data:{changed_at:'2026-11-09 09:00:00'}});
   check('History update API returns new montage date',(await change.json()).actual_installation_date==='2026-11-09');
   await scene.evaluate(()=>pollChanges(true));
   check('Polling an actual history edit updates active filter',JSON.stringify(await ids())==='[2,3]');
   await page.request.patch(base+`/elements/1/history/${detail.history[0].id}`,{data:{changed_at:'2026-11-08 09:00:00'}});
   await scene.evaluate(()=>pollChanges(true));
   check('Corrected history restores product without reload',JSON.stringify(await ids())==='[1,2,3]');
  }
  if(ui==='v2')await page.waitForFunction(()=>/Показано\s*3\s*из\s*8/.test(document.querySelector('#ws-status')?.textContent||''));
  if(ws==='model')for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
   await page.setViewportSize(size);await page.evaluate(audit);
   const result=await page.evaluate(ui=>{const box=document.querySelector(ui==='v2'?'[data-dfield="montageFact"]':'[data-date-filter-key="montageFact"]');return{align:alignAudit(box),size:sizeAudit(box)};},ui);
   check(`${ui} date layout ${size.width}`,!result.align.length&&!result.size.length);
   await page.screenshot({path:new URL(`${ui}-${size.width}.png`,out).pathname});
  }
  await context.close();
 }
 check('No browser errors',errors.length===0);
 await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
