// Fresh synthetic fixture only. No user database or existing issued documents.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8062';assert.equal(new URL(base).hostname,'127.0.0.1');
const out=new URL('../outputs/snz-item-sequences/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true}),checks=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const action=async name=>{await page.locator(`.snz-dialog [data-action="${name}"]`).click();await page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy="true"]'));};
try{
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('.ws-tabs [data-tab="snz"]').click();await page.locator('[data-snz-open]').click();
 await page.locator('[data-filter="date"]').fill('2026-11-10');await page.locator('[data-filter="date"]').press('Tab');await action('preview');
 check('Mounting starts without previous shift preparation fact',await page.locator('.snz-result tbody tr').first().innerText().then(t=>t.includes('08:20')));
 check('All 20 item operations are shown despite capacity',await page.locator('.snz-result tbody tr').count()===20);
 check('Unscheduled operations are visible with an explanation',await page.locator('.snz-result').getByText('Не вошла в смену',{exact:true}).count()>0);
 await page.locator('.snz-warnings summary').filter({hasText:'Предупреждения:'}).click();
 check('Mounting time limit and full composition appear in warnings',await page.locator('.snz-result').innerText().then(t=>t.includes('Ограничение времени монтажа')&&t.includes('620 мин')&&t.includes('4 шт.')));
 await page.locator('.snz-result summary').filter({hasText:'Состав СНЗ:'}).click();
 check('Composition lists all four assigned marks',await page.locator('.snz-result').innerText().then(t=>[1,2,3,4].every(id=>t.includes('Р-'+id))));
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const size of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(size);await page.evaluate(audit);
  const result=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
  check('Sequence layout alignment '+size.width,!result.align.length&&!result.size.length);
  await page.locator('.snz-result h3').scrollIntoViewIfNeeded();
  await page.screenshot({path:new URL(`sequence-${size.width}.png`,out).pathname});
 }
 await action('issue');
 const data=await(await page.request.get(base+'/objects/1/snz/state')).json();
 check('Issued registry counts all assigned pieces',data.orders.length===1&&data.orders[0].quantity===4&&data.locked_element_ids.length===4);
 const order=await(await page.request.get(base+'/objects/1/snz/orders/'+data.orders[0].id)).json();
 check('Reinforcement and concreting have individual identities',order.tasks.filter(t=>/rebar|concrete/.test(t.operation_id)).every(t=>t.element_ids.length===1&&!t.group_id));
 check('All allocations remain within one shift window',order.tasks.every(t=>t.segments.every(s=>order.start<=s.start&&s.end<=order.end)));
 for(const format of ['xlsx','pdf']){const dl=page.waitForEvent('download');await action(format);await(await dl).saveAs(new URL(`ui-all-items.${format}`,out).pathname);check('Complete document downloads '+format,true);}
 check('No browser errors',errors.length===0);
 await writeFile(new URL('ui-checks.json',out),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
