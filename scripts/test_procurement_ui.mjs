// End-to-end checks using a temporary copy of the anonymized DB, never production.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const work=mkdtempSync(join(tmpdir(),'zhbi-procurement-'));
const fixture=join(work,'synthetic.xlsx'), base='http://127.0.0.1:8161';
const run=(args)=>{const r=spawnSync('.venv312/bin/python',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r;};
run(['scripts/test_procurement.py','--fixture',fixture]);
run(['/Users/max/.codex/scripts/validate_xlsx.py',fixture]);
const server=spawn('.venv312/bin/python',['scripts/real_auth_server.py','data/zhbi.anon.db','8161',work],{
  env:{...process.env,ZHBI_CALC_DIR:join(work,'calc'),ZHBI_CALC_RECOVERY_WORKER:'0'},stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
let browser,page;const checks=[];
const check=(name,result)=>{assert.ok(result,name);checks.push(name);};
try {
  let ready=false;
  for(let i=0;i<180;i++) {try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;if(server.exitCode!=null)throw Error(log);await new Promise(r=>setTimeout(r,250));}
  assert.ok(ready,log);
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  assert.equal((await page.request.post(base+'/login',{data:{domain_login:'admin',password:'Test-Pass-1234!'}})).status(),200);
  await page.goto(base+'/v2#/procurement');await page.locator('#pr-status').filter({hasText:'Пока нет загрузок'}).waitFor();
  await page.locator('#pr-import summary').click();await page.locator('#pr-file').setInputFiles(fixture);
  await page.locator('#pr-analyze').click();await page.locator('#pr-apply').waitFor({state:'visible'});
  check('Analyze does not persist', (await (await page.request.get(base+'/procurement/snapshots')).json()).items.length===0);
  await page.locator('#pr-apply').click();await page.locator('#pr-status').filter({hasText:'Загрузка сохранена'}).waitFor();
  let saved=await (await page.request.get(base+'/procurement/snapshots')).json();const sid=saved.items[0].id;
  let report=await (await page.request.get(base+`/procurement/snapshots/${sid}`)).json();
  check('Partial payments reconcile across multiple requests',report.summary.ordered_cents===100000&&report.summary.paid_cents===50000&&report.summary.orphan_payment_cents===7000);
  check('Interactive overview opens by default',await page.locator('[data-tab="overview"]').getAttribute('aria-pressed')==='true'&&await page.locator('#pr-table table').count()===0);
  await page.locator('[data-stage="partial"]').click();
  check('Status opens individual matching positions',await page.locator('.pr-flow-item').count()===1&&(await page.locator('.pr-flow-item').innerText()).includes('Труба'));
  await page.locator('[data-inspect]').click();
  check('Inline position trail includes linked order and payments',(await page.locator('.pr-trace').innerText()).includes('P1')&&(await page.locator('.pr-trace').innerText()).includes('ЗРДС B'));
  await page.locator('[data-tab="chain"]').click();
  check('Date and number are independent leading columns',await page.locator('#pr-table thead th').nth(0).locator('[data-sort="date"]').count()===1&&await page.locator('#pr-table thead th').nth(1).locator('[data-sort="number"]').count()===1);
  check('Opening view summarizes requests',await page.locator('#pr-table tr.pr-data').count()===0);
  const cards=page.locator('#pr-table .pr-request-card');
  const layout=await cards.evaluateAll(nodes=>nodes.map(node=>({
    top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,
    shadow:getComputedStyle(node).boxShadow,roots:node.querySelectorAll('tr.pr-group[data-level="0"]').length
  })));
  check('Each request is a separate raised card',layout.length>1&&layout.every((c,i)=>c.roots===1&&c.shadow!=='none'&&(!i||c.top-layout[i-1].bottom>=12)));
  await cards.first().locator('.pr-card-viewport').evaluate(node=>{node.scrollLeft=420;});
  await page.waitForFunction(()=>[...document.querySelectorAll('#pr-table .pr-card-viewport')].every(n=>n.scrollLeft===420));
  await page.locator('.pr-card-head').evaluate(node=>{node.scrollLeft=0;});
  await page.waitForFunction(()=>[...document.querySelectorAll('#pr-table .pr-card-viewport')].every(n=>n.scrollLeft===0));
  await page.locator('#pr-expand-all').click();
  const paidRequest=page.locator('#pr-table tr[data-kind="Позиция ЗВП"]').filter({hasText:'Труба'});
  check('Paid ZVP position retains payment requisites',(await paidRequest.locator('[data-field="payment_number"]').innerText()).includes('ЗРДС A'));
  check('Unavailable payment date is explicit',(await paidRequest.locator('[data-field="payment_date"]').innerText()).includes('Не указана'));
  const unmatchedOrder=page.locator('#pr-table tr[data-kind="Позиция ЗП"]').filter({hasText:'Замена материала'});
  check('Unmatched nomenclature shows both sides without guessing',(await unmatchedOrder.locator('[data-field="item"]').innerText()).includes('Не сопоставлено')&&(await unmatchedOrder.locator('[data-field="item"]').innerText()).includes('Замена материала')&&await unmatchedOrder.locator('.pr-mapping-unresolved').count()===1);
  await page.locator('[data-tab="orders"]').click();await page.locator('[data-map]').first().click();
  const target=report.requests.find(r=>r.number==='R1'&&!r.cancelled);
  const mappingDialog=page.getByRole('dialog',{name:'Сопоставление позиций'});
  check('Pair selection opens as a modal',await mappingDialog.evaluate(d=>d.matches(':modal')));
  check('Both remaining-item lists are visible',await mappingDialog.locator('#pr-request-options input[type=radio]').count()===1&&await mappingDialog.locator('#pr-order-options input[type=radio]').count()===1);
  await mappingDialog.locator('#pr-order-options input[type=radio]').first().check();
  await mappingDialog.locator(`input[name="pr-request"][value="${target.id}"]`).check();
  await page.getByLabel('Эквивалент потребности',{exact:true}).fill('8');
  await page.locator('#pr-map-save').click();await page.locator('#pr-editor .pr-map').waitFor({state:'detached'});
  report=await (await page.request.get(base+`/procurement/snapshots/${sid}`)).json();
  const r=report.requests.find(r=>r.id===target.id),o=report.orders.find(o=>o.item==='Замена материала');
  check('Replacement equivalent and calculated paid quantity',r.ordered_qty===8&&r.paid_qty===4&&r.paid_cents===20000&&r.replacements===1);
  const paired=page.locator('#pr-table tr[data-kind="Позиция ЗП"]').filter({hasText:'Замена материала'}).locator('[data-field="item"]');
  check('Matched replacement names are both visible',(await paired.innerText()).includes('Исходный материал')&&(await paired.innerText()).includes('Замена материала'));
  check('Rejects excess allocation', (await page.request.put(base+`/procurement/snapshots/${sid}/allocations/${o.id}`,{data:{expected_revision:report.revision,allocations:[{request_line_id:r.id,order_qty:9,request_qty:8}]}})).status()===422);
  check('Rejects stale revisions', (await page.request.put(base+`/procurement/snapshots/${sid}/allocations/${o.id}`,{data:{expected_revision:0,allocations:[]}})).status()===409);
  await page.locator('[data-map]').first().click();await page.locator('#pr-current-links [data-edit]').first().click();await page.getByLabel('Эквивалент потребности',{exact:true}).fill('9');
  await page.route('**/procurement/snapshots/*/allocations/*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Тест: сервер временно недоступен'})}));
  await page.locator('#pr-map-save').click();await page.locator('#pr-map-error').filter({hasText:'временно недоступен'}).waitFor();
  check('Failed save preserves input',await page.getByLabel('Эквивалент потребности',{exact:true}).inputValue()==='9');
  await page.unroute('**/procurement/snapshots/*/allocations/*');
  // Reload confirms the failed edit did not overwrite the committed mapping.
  page.on('dialog',d=>d.accept());await page.reload();await page.locator('#pr-content').waitFor({state:'visible'});
  report=await (await page.request.get(base+`/procurement/snapshots/${sid}`)).json();
  check('Mapping survives reload',report.requests.find(r=>r.id===target.id).ordered_qty===8);
  await page.locator('#pr-import summary').click();await page.locator('#pr-file').setInputFiles(fixture);await page.locator('#pr-analyze').click();await page.locator('#pr-apply').waitFor({state:'visible'});await page.locator('#pr-apply').click();
  await page.locator('#pr-status').filter({hasText:'Этот файл уже загружен'}).waitFor();
  check('Repeat import is idempotent',(await (await page.request.get(base+'/procurement/snapshots')).json()).items.length===1);
  await page.locator('[data-tab="payments"]').click();await page.locator('#pr-filter').selectOption('orphan');
  check('Orphan payments are visible',await page.locator('#pr-table tbody tr').count()===1&&(await page.locator('#pr-table').innerText()).includes('Нет действующего ЗП'));
  await page.locator('[data-tab="requests"]').click();await page.locator('#pr-filter').selectOption('replacement');
  check('Replacement filter works',await page.locator('#pr-table tbody tr').count()===1);
  await page.locator('[data-request]').click();check('Original and replacement are traceable',(await page.locator('#pr-detail').innerText()).includes('Замена материала'));
  check('Position detail links payments to orders',(await page.locator('#pr-detail').innerText()).includes('ЗРДС B'));
  await page.locator('[data-focus-request]').click();
  check('Drilldown isolates the exact request',await page.locator('#pr-focus').isVisible()&&await page.locator('#pr-table tr.pr-group[data-level="0"]').count()===1);
  await page.locator('[data-clear-focus]').click();
  await page.locator('[data-shortcut="orphan"]').click();
  check('Exception shortcut opens the matching payment',await page.locator('#pr-filter').inputValue()==='orphan'&&await page.locator('#pr-table tbody tr').count()===1);
  await page.locator('[data-shortcut="open"]').click();
  await page.locator('#pr-columns').selectOption('quantities');
  check('Quantity layout prioritizes fulfillment',await page.locator('[data-sort="paid_qty"]').count()===1&&await page.locator('[data-sort="paid"]').count()===0);
  await page.locator('#pr-columns').selectOption('all');
  const denied=await browser.newContext();assert.equal((await denied.request.post(base+'/login',{data:{domain_login:'user4',password:'Test-Pass-1234!'}})).status(),200);
  check('Unassigned users cannot read financial data',(await denied.request.get(base+'/procurement/snapshots')).status()===403);
  check('Unassigned users cannot import',(await denied.request.post(base+'/procurement/import/analyze',{multipart:{file:{name:'synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:readFileSync(fixture)}}})).status()===403);
  run(['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("INSERT INTO object_roles(key,name,rank) VALUES('qa_procurement_read','Проверка чтения закупок',999)")
c.execute("INSERT INTO role_features(role_key,feature_key,level) VALUES('qa_procurement_read','procurement','read')")
c.execute("INSERT INTO user_access(user_id,object_id,role) SELECT u.id,o.id,'qa_procurement_read' FROM users u CROSS JOIN (SELECT id FROM objects ORDER BY id DESC LIMIT 1) o WHERE u.domain_login='user4'")
c.commit();c.close()`,join(work,'work.db')]);
  check('Explicit read grant permits report',(await denied.request.get(base+`/procurement/snapshots/${sid}`)).status()===200);
  check('Read-only user cannot change mappings',(await denied.request.put(base+`/procurement/snapshots/${sid}/allocations/${o.id}`,{data:{expected_revision:report.revision,allocations:[]}})).status()===403);
  const readPage=await denied.newPage();await readPage.goto(base+'/v2#/procurement');await readPage.locator('#pr-content').waitFor({state:'visible'});
  check('Service permission remains visible across objects',await readPage.locator('#pr-import').isHidden());
  await readPage.locator('[data-tab="orders"]').click();check('Read-only UI has no mapping controls',await readPage.locator('[data-map]').count()===0);
  await denied.close();
  // A second real upload supplies all three requested fulfillment states.
  const extended=join(work,'states.xlsx');
  run(['-c',`import sys,copy
from pathlib import Path
sys.path.insert(0,'scripts')
from test_procurement import sample,xlsx_bytes
s=sample()
for n,dt,item,q,cost,paid in [('3','01.02.2026 10:00:00','Полностью обеспеченный материал',5,100,100),('4','01.03.2026 10:00:00','Заказан, но оплачен частично',6,200,100)]:
 r=copy.deepcopy(s['ЗВП'][1]);r[0]='ЗВП R'+n+' от '+dt;r[1]='R'+n;r[2]=dt;r[4]=item;r[6]=q;s['ЗВП'].append(r)
 o=copy.deepcopy(s['ЗП'][1]);o[0]='Заказ поставщику P'+n+' от '+dt;o[1]='P'+n;o[2]=dt;o[3]=item;o[7]=q;o[8]=cost;o[9]='R'+n;s['ЗП'].append(o)
 p=copy.deepcopy(s['Оплаты ЗРДС'][1]);p[0]='Заявка на расходование ДС Z'+n+' от '+dt;p[1]=o[0];p[2]=paid;p[3]=dt;p[4]='P'+n;s['Оплаты ЗРДС'].append(p)
r=copy.deepcopy(next(r for r in s['ЗВП'][1:] if r[1]=='R3'));r[4]='Частичная позиция в той же ЗВП';r[6]=10;s['ЗВП'].append(r)
o=copy.deepcopy(next(o for o in s['ЗП'][1:] if o[1]=='P3'));o[3]=r[4];o[7]=2;o[8]=40;s['ЗП'].append(o)
next(p for p in s['Оплаты ЗРДС'][1:] if p[4]=='P3')[2]=140
for n in ['1','2']:
 r=copy.deepcopy(s['ЗВП'][1]);r[0]='ЗВП R5';r[1]='R5';r[4]='Исходная позиция '+n;r[6]=30;s['ЗВП'].append(r)
 o=copy.deepcopy(s['ЗП'][1]);o[0]='Заказ P5'+n;o[1]='P5'+n;o[3]='Аналог '+n;o[7]=30;o[9]='R5';s['ЗП'].append(o)
p=copy.deepcopy(next(p for p in s['Оплаты ЗРДС'][1:] if p[4]=='P4'));p[0]='Заявка на расходование ДС ZERO от 01.03.2026';p[2]=0;s['Оплаты ЗРДС'].append(p)
r=copy.deepcopy(s['ЗВП'][1]);r[0]='ЗВП R6';r[1]='R6';r[4]='Общая потребность двух заказов';r[6]=5;s['ЗВП'].append(r)
for n,q in [('1',2),('2',3)]:
 o=copy.deepcopy(s['ЗП'][1]);o[0]='Заказ P6'+n;o[1]='P6'+n;o[3]=r[4];o[7]=q;o[8]=q*10;o[9]='R6';s['ЗП'].append(o)
Path(sys.argv[1]).write_bytes(xlsx_bytes(s))`,extended]);
  run(['/Users/max/.codex/scripts/validate_xlsx.py',extended]);
  await page.locator('#pr-file').setInputFiles(extended);await page.locator('#pr-analyze').click();await page.locator('#pr-apply').waitFor({state:'visible'});await page.locator('#pr-apply').click();
  await page.locator('#pr-status').filter({hasText:'Загрузка сохранена'}).waitFor();
  await page.reload();await page.locator('#pr-content').waitFor({state:'visible'});
  await page.locator('[data-tab="chain"]').click();await page.locator('#pr-expand-all').click();
  const chain=await page.locator('#pr-table tbody tr').evaluateAll(rows=>rows.map(r=>({kind:r.dataset.kind,level:r.dataset.level,text:r.innerText})));
  const root=chain.findIndex(r=>r.kind==='ЗВП'&&r.text.includes('R3'));
  const nextRoot=chain.findIndex((r,i)=>i>root&&r.kind==='ЗВП'),branch=chain.slice(root,nextRoot<0?undefined:nextRoot);
  check('Default hierarchy follows ZVP, order, payments',[...new Set(branch.map(r=>r.kind))].join('|')==='ЗВП|Позиция ЗВП|ЗП|Позиция ЗП|ЗРДС');
  const orderHead=await page.locator('#pr-table tr.pr-group[data-level="1"]').filter({hasText:'P3'}).locator('[data-field="order_date"]').innerText();
  check('Order requisites are explicit',orderHead==='01.02.2026'&&await page.locator('#pr-table [data-sort="order_number"]').count()===1);
  const paymentRow=page.locator('#pr-table tr[data-kind="ЗРДС"]').filter({hasText:'Z3'});
  check('Payment requisites are explicit',await paymentRow.locator('[data-field="payment_date"]').innerText()==='01.02.2026'&&await paymentRow.locator('[data-field="payment_number"]').innerText()==='Z3');
  const intensities=await page.locator('#pr-table tr').evaluateAll(rows=>rows.filter(r=>r.classList.contains('pr-progress-partial')).map(r=>({level:r.dataset.level,group:r.classList.contains('pr-group'),intensity:getComputedStyle(r).getPropertyValue('--pr-intensity').trim()})));
  check('Hierarchy controls intensity independently of hue',intensities.some(r=>r.level==='0'&&r.intensity==='26%')&&intensities.some(r=>r.level==='1'&&r.group&&r.intensity==='18%')&&intensities.some(r=>r.level==='2'&&!r.group&&r.intensity==='7%')&&intensities.some(r=>r.level==='3'&&r.intensity==='4%'));
  const mixed=await page.locator('#pr-table tr').evaluateAll(rows=>rows.map(r=>({kind:r.dataset.kind,text:r.innerText,color:getComputedStyle(r).getPropertyValue('--pr-state-color').trim()})));
  check('Position hue is independent of mixed parent',mixed.some(r=>r.kind==='ЗВП'&&r.text.includes('R3')&&r.color==='#cf6b2b')&&mixed.some(r=>r.kind==='Позиция ЗВП'&&r.text.includes('Полностью обеспеченный')&&r.color==='#26875a')&&mixed.some(r=>r.kind==='Позиция ЗВП'&&r.text.includes('Частичная позиция')&&r.color==='#cf6b2b'));
  const inputs=await page.locator('#pr-table thead [data-column]').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().top));
  check('Header search fields share one baseline',Math.max(...inputs)-Math.min(...inputs)<1);
  await page.locator('#pr-collapse-all').click();
  check('Collapse all hides detail rows',await page.locator('#pr-table tr.pr-data').count()===0);
  check('Collapsed paid ZVP retains payment proof',(await page.locator('#pr-table tr.pr-group[data-level="0"]').filter({hasText:'R3'}).locator('[data-field="payment_number"]').innerText()).includes('Z3'));
  await page.locator('#pr-table [data-column="payment_number"]').fill('Z3');
  check('Searching a payment expands its ancestors',await page.locator('#pr-table tr[data-kind="ЗРДС"]').filter({hasText:'Z3'}).count()===1);
  await page.locator('#pr-clear-search').click();await page.locator('#pr-expand-all').click();
  await page.getByRole('button',{name:'Свернуть ЗП P3',exact:true}).click();
  check('An individual supplier order can collapse',await page.locator('#pr-table tr[data-kind="ЗРДС"]').filter({hasText:'Z3'}).count()===0);
  await page.getByRole('button',{name:'Развернуть ЗП P3',exact:true}).click();
  check('An individual supplier order can expand',await page.locator('#pr-table tr[data-kind="ЗРДС"]').filter({hasText:'Z3'}).count()===1);
  await page.locator('#pr-table [data-toggle]').first().click();
  check('Document groups can be collapsed',await page.locator('#pr-table [data-toggle]').first().getAttribute('aria-expanded')==='false');
  await page.locator('#pr-table [data-toggle]').first().click();
  await page.locator('[data-tab="requests"]').click();
  check('Complete request is green',await page.locator('#pr-table tr.pr-progress-complete').filter({hasText:'R3'}).count()===1);
  check('Full order with partial payment is yellow',await page.locator('#pr-table tr.pr-progress-ordered_unpaid').filter({hasText:'R4'}).count()===1);
  check('Partial request is orange',await page.locator('#pr-table tr.pr-progress-partial').filter({hasText:'R1'}).count()===1);
  const columns=await page.locator('#pr-table [data-sort]').evaluateAll(bs=>bs.map(b=>b.dataset.sort));
  check('Quantity, unit, percent are separate columns',columns.includes('qty')&&columns.includes('unit')&&columns.includes('percent'));
  check('Every column has search and sort',await page.locator('#pr-table [data-column]').count()===columns.length);
  await page.locator('#pr-table [data-column="item"]').fill('Замена материала');
  check('Nomenclature search finds supplier item from original request',await page.locator('#pr-table tbody tr').count()===1&&(await page.locator('#pr-table tbody').innerText()).includes('Исходный материал'));
  await page.locator('#pr-clear-search').click();
  await page.locator('#pr-table [data-column="date"]').fill('01.02.2026');await page.locator('#pr-table [data-column="item"]').fill('Полностью обеспеченный');
  check('Date column search uses visible date',await page.locator('#pr-table tbody tr').count()===1&&(await page.locator('#pr-table tbody').innerText()).includes('R3'));
  check('Typing keeps column focus',await page.locator('#pr-table [data-column="item"]').evaluate(e=>e===document.activeElement));
  await page.locator('#pr-clear-search').click();
  await page.locator('#pr-table [data-sort="qty"]').click();
  const nums=await page.locator('#pr-table table').evaluate(t=>{const index=t.querySelector('[data-sort="qty"]').closest('th').cellIndex;return [...t.tBodies[0].rows].map(r=>Number(r.cells[index].textContent.replace(/\s/g,'').replace(',','.')));});
  check('Quantities sort numerically',nums.join()===nums.toSorted((a,b)=>a-b).join());
  await page.locator('#pr-table [data-sort="date"]').click();await page.locator('#pr-table [data-sort="date"]').click();
  check('Date sort toggles direction',await page.locator('#pr-table th').first().getAttribute('aria-sort')==='descending'&&(await page.locator('#pr-table tbody tr').first().innerText()).includes('R4'));
  await page.locator('#pr-table [data-column="qty"]').fill('6');await page.locator('#pr-table [data-column="unit"]').fill('шт');
  check('Column searches combine',await page.locator('#pr-table tbody tr').count()===1&&(await page.locator('#pr-table tbody').innerText()).includes('R4'));
  await page.locator('#pr-clear-search').click();
  await page.locator('#pr-search').fill('Заказано полностью, оплата не завершена');
  check('Global search includes status column',await page.locator('#pr-table tbody tr').count()===2&&(await page.locator('#pr-table tbody').innerText()).includes('R4')&&(await page.locator('#pr-table tbody').innerText()).includes('R6'));
  await page.locator('#pr-clear-search').click();await page.locator('[data-tab="chain"]').click();
  await page.locator('#pr-table [data-column="payment_number"]').fill('Z3');
  check('Child search preserves document ancestors',await page.locator('#pr-table tr.pr-group[data-level="0"]').count()===1&&(await page.locator('#pr-table tbody').innerText()).includes('ЗВП R3')&&(await page.locator('#pr-table tbody').innerText()).includes('ЗП P3'));
  await page.locator('#pr-clear-search').click();
  if(await page.locator('#pr-import').getAttribute('open')!==null)await page.locator('#pr-import summary').click();
  const shots='output/validation/procurement';mkdirSync(shots,{recursive:true});
  // Keep the transition between two neighboring ZVPs in the visual check.
  await page.locator('#pr-table tr.pr-group[data-level="0"]').nth(1).evaluate(r=>r.scrollIntoView({block:'center'}));
  await page.screenshot({path:join(shots,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:1366,height:768});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:join(shots,'laptop.png')});
  check('Page width fits laptop',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-shortcut="unmapped"]').click();
  await page.locator('#pr-table tbody tr').filter({hasText:'Аналог 1'}).locator('[data-map]').click();
  await page.locator('#pr-order-options .pr-option').filter({hasText:'Аналог 2'}).click();
  await page.locator('#pr-request-options .pr-option').filter({hasText:'Исходная позиция 1'}).click();
  await page.locator('#pr-order-qty').fill('7');await page.locator('#pr-request-qty').fill('14');
  await page.locator('#pr-map-save').click();await mappingDialog.waitFor({state:'detached'});
  const latest=await (await page.request.get(base+'/procurement/snapshots')).json();
  const result=await (await page.request.get(base+'/procurement/snapshots/'+latest.items[0].id)).json();
  const first=result.orders.find(o=>o.number==='P51'),second=result.orders.find(o=>o.number==='P52');
  check('Changing the right list saves against the selected order',first.unallocated_qty===30&&second.unallocated_qty===23&&second.links.length===1&&second.links[0].request_qty===14);
  await page.locator('[data-tab="cards"]').click();
  await page.locator('#pr-search').fill('R5');
  check('Card view has no table and selects the matching document',await page.locator('#pr-cards table').count()===0&&await page.locator('.pr-case-choice').count()===1&&await page.locator('#pr-table').isHidden());
  await page.locator('.pr-need').filter({hasText:'Исходная позиция 1'}).click();
  check('Position opens only linked supplier orders',await page.locator('.pr-purchase').count()===1&&(await page.locator('.pr-purchase').innerText()).includes('P52'));
  await page.locator('[data-all-positions]').click();
  check('Returning to the entire document restores all its orders',await page.locator('.pr-purchase').count()===2);
  await page.locator('#pr-cards [data-map]').first().click();await mappingDialog.waitFor();
  await page.locator('#pr-map-cancel').click();
  await page.locator('#pr-search').fill('Z3');
  check('Searching payment reference opens the request card',(await page.locator('.pr-case-content h3').innerText()).includes('R3')&&(await page.locator('.pr-receipts').innerText()).includes('Z3'));
  await page.locator('#pr-cards').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(shots,'request-card.png')});
  await page.locator('[data-tab="overview"]').click();await page.locator('#pr-clear-search').click();
  await page.locator('[data-stage="ordered_unpaid"]').click();await page.locator('[data-inspect]').first().click();
  await page.locator('#pr-overview').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(shots,'fulfillment-overview.png')});
  await page.locator('[data-tab="suppliers"]').click();
  const ledgerRow=page.locator('#pr-suppliers [data-payee]').first();
  check('Supplier view groups orders and shows three monetary totals',(await ledgerRow.innerText()).includes('Оплачено по ЗРДС')&&(await ledgerRow.innerText()).includes('Осталось по ЗП'));
  await ledgerRow.click();
  check('Supplier details show orders and dated payment history',await page.locator('#pr-suppliers .pr-supplier-order').count()>0&&(await page.locator('.pr-supplier-timeline').innerText()).includes('01.02.2026'));
  await page.locator('#pr-search').fill('нет такого контрагента');
  check('Supplier search narrows the ledger',await page.locator('#pr-suppliers [data-payee]').count()===0);
  await page.locator('[data-tab="map"]').click();await page.locator('#pr-clear-search').click();
  const mind=page.locator('#pr-document-map'), mapNodes=kind=>mind.locator(`[data-mm-node="${kind}"]`);
  check('Document map starts with requests only',await mapNodes('request').count()>1&&await mapNodes('order').count()===0&&await mapNodes('payment').count()===0);
  const rootNode=num=>mapNodes('request').filter({has:page.getByText(num,{exact:true})});
  check('All request nomenclature starts collapsed',await mind.locator('[data-mm-item],.pr-mm-item-head').count()===0&&await mind.locator('.pr-mm-expand[aria-expanded="false"]').count()===await mapNodes('request').count());
  const expand=rootNode('R5').getByRole('button',{name:'Развернуть всю детализацию ЗВП R5',exact:true});
  check('Expand button is a translucent square centered on the right',await expand.evaluate(button=>{const b=button.getBoundingClientRect(),card=button.closest('article').getBoundingClientRect();return Math.abs(b.width-b.height)<1&&b.width>=36&&Math.abs(b.top+b.height/2-card.top-card.height/2)<1&&card.right-b.right<=12&&Number(getComputedStyle(button).opacity)<1;}));
  await expand.hover();await page.waitForFunction(()=>{const b=document.querySelector('.pr-mm-expand:hover');return b&&getComputedStyle(b).opacity==='1';});
  check('Expand button becomes bright on hover',await expand.evaluate(button=>getComputedStyle(button).opacity==='1'));
  await mind.scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'document-map-collapsed.png')});
  await rootNode('R5').locator('[data-map-branch]').click();
  check('One expand opens the complete request structure and source nomenclature',await mapNodes('order').count()===2&&await mind.locator('[data-payment-branch]').count()===2&&await mind.locator('[data-mm-item="order"]').count()===2&&await rootNode('R5').locator('li').count()===2);
  const original=rootNode('R5').locator('li').first();
  check('Request line shows original and ordered quantities',await original.locator('[data-mm-count="original"]').innerText()==='30'&&await original.locator('[data-mm-count="ordered"]').innerText()==='14');
  check('Orders without payment requests are labelled',(await mapNodes('order').first().innerText()).includes('ЗРДС отсутствуют'));
  check('Unmatched order positions are highlighted and explained',await mind.locator('[data-mm-item="order"][data-order-match="missing"]').count()===1&&(await mind.locator('[data-order-match="missing"]').innerText()).includes('Не сопоставлено с ЗВП'));
  check('Replacement positions show the original request nomenclature',(await mind.locator('[data-mm-item="order"][data-order-match="different"]').innerText()).includes('ЗВП: Исходная позиция 1'));
  await mapNodes('order').first().locator('[data-map-branch]').click();
  check('Closing one order keeps the neighboring payment branch open',await mapNodes('order').nth(1).locator('[data-map-branch]').getAttribute('aria-expanded')==='true'&&await mind.locator('[data-payment-branch]').count()===1);
  await mapNodes('order').first().locator('[data-map-branch]').click();
  check('Opening a sibling keeps both branches',await mind.locator('[data-payment-branch]').count()===2);
  await rootNode('R1').locator('[data-map-branch]').click();
  check('Switching request opens its own complete path',await mapNodes('order').count()===1&&await mapNodes('payment').count()===2&&(await mapNodes('order').innerText()).includes('P1'));
  check('Switching request also collapses previous source nomenclature',await rootNode('R5').locator('li').count()===0&&await rootNode('R1').locator('li').count()===2);
  check('Cancelled request and order positions are struck through',await rootNode('R1').locator('[data-cancelled="true"]').count()===1&&await mapNodes('order').locator('[data-cancelled="true"]').count()===1&&await mind.locator('[data-cancelled="true"] .pr-mm-item-name').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).textDecorationLine==='line-through')));
  await rootNode('R1').scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'document-map-cancelled.png')});
  await rootNode('R3').locator('[data-map-branch]').click();
  check('Fully paid orders are distinguished',(await mapNodes('order').innerText()).includes('ЗП оплачен полностью'));
  check('Nomenclature links are removed but document links remain',await mind.locator('[data-mm-link="item"],.pr-mm-item-wire,svg circle').count()===0&&await mind.locator('[data-mm-link="document"]').count()===2);
  check('Order rows distinguish matching and differing quantities',await mind.locator('[data-mm-item="order"][data-order-match="full"]').count()===1&&await mind.locator('[data-mm-item="order"][data-order-match="different"]').count()===1&&(await mind.locator('[data-order-match="different"]').innerText()).includes('Количество отличается'));
  check('Original column spacing fits the laptop',await mind.locator('.pr-mm-canvas').evaluate(canvas=>getComputedStyle(canvas).columnGap==='36px'&&canvas.getBoundingClientRect().width<=canvas.parentElement.clientWidth)&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check('Document links remain thin solid curves',await mind.locator('svg path').evaluateAll(paths=>paths.every(p=>p.getAttribute('d').includes(' C')&&!/[HV]/.test(p.getAttribute('d'))&&Number.parseFloat(getComputedStyle(p).strokeWidth)===1&&getComputedStyle(p).strokeDasharray==='none')));
  const sourceItems=rootNode('R3').locator('[data-mm-item="request"]'),orderItems=mind.locator('[data-mm-item="order"]');
  const selectedOrders=()=>mind.locator('[data-mm-item="order"].is-linked');
  await sourceItems.first().hover();
  check('Hover highlights only the mapped order line',await selectedOrders().count()===1&&(await selectedOrders().innerText()).includes('Полностью обеспеченный'));
  await mind.locator('h4').first().hover();
  check('Unpinned hover clears when the mouse leaves',await mind.locator('[data-mm-item].is-linked').count()===0);
  await sourceItems.first().locator('button').click();await mind.locator('h4').first().hover();
  check('Click pins selection after pointer leaves',await selectedOrders().count()===1&&await sourceItems.first().locator('button').getAttribute('aria-pressed')==='true');
  await sourceItems.nth(1).hover();
  check('Hover previews another match while selection is pinned',(await selectedOrders().innerText()).includes('Частичная позиция'));
  await mind.locator('h4').first().hover();
  check('Leaving the preview restores pinned selection',(await selectedOrders().innerText()).includes('Полностью обеспеченный'));
  await sourceItems.nth(1).locator('button').click();await mind.locator('h4').first().hover();
  check('Clicking another item switches the pinned selection',(await selectedOrders().innerText()).includes('Частичная позиция')&&await sourceItems.first().locator('button').getAttribute('aria-pressed')==='false');
  await mapNodes('order').locator('[data-map-branch]').click();
  check('Pinned match survives folding the payment branch',(await selectedOrders().innerText()).includes('Частичная позиция'));
  await mapNodes('order').locator('[data-map-branch]').click();
  await orderItems.first().hover();
  check('Order hover also highlights its original request',await rootNode('R3').locator('[data-mm-item="request"].is-linked').count()===1&&(await rootNode('R3').locator('[data-mm-item="request"].is-linked').innerText()).includes('Полностью обеспеченный'));
  await sourceItems.first().locator('button').focus();await page.keyboard.press('Space');
  await mind.locator('h4').first().hover();
  check('Keyboard can pin a match',await sourceItems.first().locator('button').getAttribute('aria-pressed')==='true'&&(await selectedOrders().innerText()).includes('Полностью обеспеченный'));
  await page.keyboard.press('Escape');
  check('Escape clears pinned selection',await mind.locator('[data-mm-item].is-linked').count()===0);
  await sourceItems.nth(1).locator('button').click();await mind.locator('h4').first().hover();
  await rootNode('R3').scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'document-map-highlight.png')});
  await rootNode('R3').locator('[data-map-branch]').click();
  check('Collapsing the root hides source nomenclature, orders and payments',await mapNodes('order').count()===0&&await mapNodes('payment').count()===0&&await mind.locator('[data-mm-item]').count()===0&&await rootNode('R3').locator('.pr-mm-expand').getAttribute('aria-expanded')==='false');
  await rootNode('R1').getByRole('button',{name:'Развернуть всю детализацию ЗВП R1',exact:true}).focus();await page.keyboard.press('Enter');
  check('Keyboard expand opens all request details',await rootNode('R1').locator('li').count()===2&&await mapNodes('order').count()===1&&await mapNodes('payment').count()===2);
  await rootNode('R1').locator('.pr-mm-item-select').click();
  check('Expanded nomenclature still highlights the replacement',(await selectedOrders().innerText()).includes('Замена материала'));
  await mind.locator('h4').first().hover();
  await rootNode('R1').locator('[data-cancelled="true"]').hover();
  check('Cancelled positions do not replace the pinned selection',(await selectedOrders().innerText()).includes('Замена материала')&&await mind.locator('[data-cancelled="true"].is-linked').count()===0);
  await rootNode('R6').locator('[data-map-branch]').click();await rootNode('R6').locator('.pr-mm-item-select').hover();
  check('One request highlights matching positions in multiple orders',await selectedOrders().count()===2);
  await rootNode('R5').locator('[data-map-branch]').click();await rootNode('R5').locator('.pr-mm-item-select').nth(1).hover();
  check('Unmatched request does not highlight unrelated supplier positions',await selectedOrders().count()===0);
  await mind.locator('[data-map-fold]').click();
  check('Collapse all returns to compact request cards',await mind.locator('[data-mm-item]').count()===0&&await mapNodes('order').count()===0&&await mind.locator('.pr-mm-expand[aria-expanded="true"]').count()===0);
  check('No browser script errors',errors.length===0);
  console.log(JSON.stringify({checks,work},null,2));
} catch(e) {if(page){console.error((await page.locator('body').innerText()).slice(-4500));mkdirSync('output/validation/procurement',{recursive:true});await page.screenshot({path:'output/validation/procurement/failure.png',fullPage:true});}console.error(log);throw e;}
finally {if(browser)await browser.close();server.kill('SIGTERM');}
