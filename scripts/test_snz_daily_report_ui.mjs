// A fresh --existing --tiny-label synthetic fixture; never port 8000.
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const base=process.env.SNZ_TEST_URL||'http://127.0.0.1:8078';assert.equal(new URL(base).hostname,'127.0.0.1');assert.notEqual(new URL(base).port,'8000');
const out=new URL('../outputs/snz-daily-ui/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=(name,ok)=>{checks.push({name,ok});assert.ok(ok,name);console.log('PASS '+name)};
const action=name=>page.locator(`[data-action="${name}"]`),settled=()=>page.waitForFunction(()=>!document.querySelector('.snz-content[aria-busy=true]'));
const tab=async name=>{await page.locator(`.snz-tabs [data-tab="${name}"]`).click();await settled();};
async function download(actionName,name){const waiting=page.waitForEvent('download');await action(actionName).click();const file=await waiting;await file.saveAs(new URL(name,out).pathname);await settled();check('download '+name,true);}
try{
 await page.goto(base+'/v2?object_id=1#/ws-foreman');await page.locator('[data-tab="snz"]').click();await page.locator('[data-snz-open]').click();await settled();await tab('orders');
 check('daily exports require a date',!await action('registry-xlsx').isEnabled()&&!await action('registry-pdf').isEnabled());
 await page.locator('[data-filter="ordersDate"]').fill('2026-11-10');await settled();check('daily exports enabled for selected date',await action('registry-xlsx').isEnabled()&&await action('registry-pdf').isEnabled());
 const audit=await readFile(new URL('./ui_align_audit.js',import.meta.url),'utf8');
 for(const viewport of [{width:1440,height:900},{width:2560,height:1440}]){
  await page.setViewportSize(viewport);await page.evaluate(audit);
  const issues=await page.evaluate(()=>({align:alignAudit(document.querySelector('.snz-dialog')),size:sizeAudit(document.querySelector('.snz-dialog'))}));
  check('daily controls aligned '+viewport.width,!issues.align.length&&!issues.size.length);await page.screenshot({path:new URL(`daily-${viewport.width}.png`,out).pathname});
 }
 await download('registry-xlsx','open.xlsx');await download('registry-pdf','open.pdf');
 await tab('facts');await page.locator('[data-fact-filter="date"]').fill('2026-11-10');await settled();await page.locator('[data-fact-filter="shift"]').selectOption('day');await settled();
 page.once('dialog',d=>d.accept());await action('close-orders').click();await settled();await tab('orders');
 await download('registry-xlsx','mixed.xlsx');await download('registry-pdf','mixed.pdf');
 check('no browser errors',errors.length===0);await writeFile(new URL('checks.json',out),JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:new URL('failure.png',out).pathname});throw error;}finally{await browser.close();}
