// Полная форма норм: отдельные диаметры и сохранение только на временной копии.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright';

const work=mkdtempSync(join(tmpdir(),'calc-norm-diameters-'));
const copied=spawnSync('.venv312/bin/python',['-c',`import sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1])/'calc';p.mkdir()
with sqlite3.connect('file:data/calc/calczhbi.sqlite3?mode=ro',uri=True) as src, sqlite3.connect(p/'calczhbi.sqlite3') as dst:src.backup(dst)
`,work],{encoding:'utf8'});
assert.equal(copied.status,0,copied.stderr);
const base='http://127.0.0.1:18169';
const server=spawn('.venv312/bin/python',['scripts/real_auth_server.py','data/zhbi.anon.db','18169',work],{
 env:{...process.env,ZHBI_CALC_DIR:join(work,'calc'),ZHBI_CALC_ASSETS_DIR:resolve('data/calc/assets'),ZHBI_CALC_RECOVERY_WORKER:'0'},stdio:['ignore','pipe','pipe']});
let log='',browser;server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
try{
 let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,250));}assert.ok(ready,log);
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 assert.equal((await page.request.post(base+'/login',{data:{domain_login:'admin',password:'Test-Pass-1234!'}})).status(),200);
 await page.goto(base+'/calc/');
 try{await page.waitForFunction(()=>Boolean(window.CalcZhBIWorkspace));}catch(error){console.log({errors});throw error;}
 await page.locator('#pc-open-norms').click();
 await page.locator('[data-settings-section="norms"]').click();
 const table=page.locator('#pc-resource-norms');await table.waitFor({state:'visible'});
 // Числовые поля не должны попадать в автозаполнение контактов, в том числе после перерисовки.
 const checkNumericFields=async()=>{
  const fields=await page.locator('input[type="number"],input[inputmode="decimal"],input[inputmode="numeric"]').evaluateAll(inputs=>inputs.map(el=>({
   name:el.name||el.id||el.dataset.bulkField||el.dataset.field,
   autocomplete:el.autocomplete,
   label:el.getAttribute('aria-label')||[...el.labels].map(l=>l.textContent.trim()).join(' '),
  })));
  assert.ok(fields.length>100);
  for(const field of fields){assert.equal(field.autocomplete,'off',field.name);assert.ok(field.label&&!field.label.includes('undefined'),field.name);}
  assert.equal(await page.locator('#pc-login-form [name="login"]').getAttribute('autocomplete'),'username');
  assert.equal(await page.locator('#pc-login-form [name="password"]').getAttribute('autocomplete'),'current-password');
 };
 await checkNumericFields();
 const factor=table.locator('input[name="f:steel6A500C"]');
 assert.match(await factor.getAttribute('aria-label'),/Арматура.*коэффициент расхода/);
 const original=await factor.inputValue();
 for(const value of ['0.99','10.01']){await factor.fill(value);assert.equal(await factor.evaluate(el=>el.checkValidity()),false);}
 await factor.fill('1.01');assert.equal(await factor.evaluate(el=>el.checkValidity()),true);
 await factor.fill(original);
 await page.locator('[data-settings-section="prices"]').click();
 const price=page.locator('#pc-base-table input[name="c:default"]'),originalPrice=await price.inputValue();
 await price.fill('12 345,67');assert.equal(await price.evaluate(el=>window.CalcZhBIMoney.read(el)),'12345.67');
 assert.equal(await price.evaluate(el=>el.checkValidity()),true);
 await price.fill('-1');assert.equal(await price.evaluate(el=>el.checkValidity()),false);
 await price.fill(originalPrice);
 await page.locator('[data-settings-section="norms"]').click();
 const readNorms=async()=>{const response=await page.request.get(base+'/calc/api/norms');assert.equal(response.status(),200);return response.json();};
 const before=await readNorms();
 for(const key of ['mainsteel','wire','steel8','steel10a240','steel10a500','steel25a240','steel25a500'])assert.equal(await table.locator(`input[name="f:${key}"]`).count(),0);
 assert.equal(await table.locator('input[name^="f:"]').count(),Object.keys(before.parameters.resources).length);
 for(const key of ['steel18A500C','steel6A240','steel18A300','steel20A500','steel12K7','steel15K7','steel3Vr1','steel5Vr1','steel10Vr1','steel14Vr1','steel16Vr1'])assert.equal(await table.locator(`input[name="f:${key}"]`).count(),1,key);
 const projectRow=table.locator('tr').filter({has:page.locator('input[name="f:steel18A500C"]')});
 assert.match(await projectRow.innerText(),/Надбавка не задана/);
 assert.equal(await projectRow.locator('input').inputValue(),'1');
 const keys=Object.keys(before.parameters.resources).filter(k=>k.endsWith('A600C'));
 assert.ok(keys.includes('steel28A600C')&&keys.includes('steel36A600C')&&keys.includes('steel32A600C'));
 assert.equal(await table.locator('input[name$="A600C"]').count(),keys.length);
 const row=table.locator('tr').filter({has:page.locator('input[name="f:steel32A600C"]')});
 assert.equal(await row.locator('td').nth(2).innerText(),'—');
 const auditScript=readFileSync('scripts/ui_align_audit.js','utf8');
 for(const [width,height] of [[1440,900],[2560,1440]]){
  await page.setViewportSize({width,height});
  const audits=await page.evaluate(auditScript+'\n({align:alignAudit(document.querySelector(\'#pc-resource-norms\')),size:sizeAudit(document.querySelector(\'#pc-resource-norms\'))})');
  assert.deepEqual(audits,{align:[],size:[]});
  await table.locator('input[name="f:steel18A500C"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(work,`norms-${width}.png`),fullPage:true});
  await table.locator('input[name="f:steel5Vr1"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(work,`wire-${width}.png`),fullPage:true});
 }
 let current=before;
 for(const target of ['steel18A500C','steel5Vr1','steel12K7','steel28A600C']){
  const next=Number(current.parameters.resources[target].factor)===1.12?'1.13':'1.12';
  await table.locator(`input[name="f:${target}"]`).fill(next);
  await page.locator('#pc-norms-form button[type="submit"]').click();
  try{await page.waitForFunction(()=>document.querySelector('#pc-norms-status')?.textContent.startsWith('Сохранено:'),null,{timeout:15000});}
  catch(error){console.log(await page.evaluate(()=>({status:document.querySelector('#pc-norms-status')?.textContent,invalid:[...document.querySelectorAll('#pc-norms-form :invalid')].filter(e=>e.name).map(e=>({name:e.name,value:e.value,message:e.validationMessage}))})));throw error;}
  const after=await readNorms();assert.equal(after.version,current.version+1);
  assert.equal(Number(after.parameters.resources[target].factor),Number(next));
  assert.equal(after.parameters.resources[target].factorBasis,'manual');
  for(const [key,value] of Object.entries(current.parameters.resources))if(key!==target)assert.deepEqual(after.parameters.resources[key],value,key);
  await checkNumericFields();
  current=after;
 }
 await page.locator('[data-settings-section="history"]').click();
 await page.getByText('Коэффициент расхода: Арматура Ø28 А600С',{exact:true}).first().waitFor();
 await page.getByText('Коэффициент расхода: Арматура Ø18 А500С',{exact:true}).first().waitFor();
 await page.getByText('Коэффициент расхода: Проволока Ø5 Вр-1',{exact:true}).first().waitFor();
 await page.getByText('Коэффициент расхода: Канат К7 Ø12',{exact:true}).first().waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: actual norms form, independent diameter save, history, layout at 1440/2560. QA files: '+work);
}finally{await browser?.close();server.kill('SIGTERM');}
