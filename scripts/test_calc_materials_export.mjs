// node scripts/test_calc_materials_export.mjs
// Browser/download checks use disposable copies; no writes to user databases.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const require=createRequire(import.meta.url),ExcelJS=require('../app/calc/web/vendor/exceljs.min.js');
const context={window:{}};
new Function('window','ExcelJS','globalThis',readFileSync('app/calc/web/export-xlsx.js','utf8'))(context.window,ExcelJS,{ExcelJS});
const exporter=context.window.CalcZhBIExport;
const work=mkdtempSync(join(tmpdir(),'calc-materials-'));
const resource=(id,name,unit,projectQty,qty,rate)=>({id,name,unit,projectQty,qty,rate});
const materials=[resource('steel','Арматура Ø10 А500С','т',.1,.105,60000),resource('wire','Проволока Вр-1','т',.002,.003,70000),resource('pipe','Труба 50×5','м',1.4,1.442,1000),resource('electrode','Электрод Э46','кг',.05,.06,120)];
const row=(id,name,unit,qty,rate)=>({id,name,unit,qty,rate,effective:{qty,rate,amount:qty*rate}});
const snapshot={product:{name:'Тестовая колонна',volume:2.1,documentModel:{mark:'К-1',projectVolume:2,resources:materials}},rows:[row('concrete','Бетон В40','м³',2.1,6000),...materials.map(r=>row(r.id,r.name,r.unit,r.qty,r.rate)),row('rest','Прочие материалы','компл.',1,500),row('labour','Труд','чел·ч',10,800),row('extra1','Дополнительная статья','компл.',1,300)],baseTotal:20000,total:20000};
snapshot.rows[1].manual={qty:0,rate:65000,amount:123};snapshot.rows[1].effective={qty:0,rate:65000,amount:123};
snapshot.projectQuantity=17;
snapshot.exportReference={referenceStatus:'found',proposedName:'Колонна железобетонная',ttnName:'Колонна К-1 согласно проекту',sourceQuantity:16,sourceRows:[8]};
snapshot.exportReference.sourceCells=Array.from({length:16},()=>({value:null,numberFormat:'General',formula:null}));
snapshot.exportReference.sourceCells[2]={value:'Комментарий\nиз скрытой колонки',numberFormat:'General',formula:null};
snapshot.exportReference.sourceCells[13]={value:83596.8454258675,numberFormat:'#,##0.00',formula:null};
snapshot.exportReference.sourceCells[14]={value:14840112,numberFormat:'#,##0.00',formula:'=N8*K8'};
snapshot.exportReference.sourceCells[15]={value:0,numberFormat:'0.00',formula:'=N8/L8'};
const original=JSON.stringify(snapshot),book=exporter.buildMaterialsWorkbook([snapshot]),sheet=book.worksheets[0];
assert.equal(JSON.stringify(snapshot),original,'export must preserve the snapshot');
assert.equal(book.worksheets.length,1);assert.equal(sheet.rowCount,6,'only concrete and specification resources');
assert.deepEqual(Array.from(sheet.getRow(1).values).slice(1,14),['Номенклтура','Материал','ЕИ','Количество чертеж','Цена','Сумма чертеж','Статья','на м3 руб','на м3 кол-во','Количество по модели в проекте, шт.','Количество по таблице, шт.','Предлагаемое наименование','Наименование в ТТН']);
assert.equal(sheet.columnCount,26);assert.equal(sheet.getCell('O2').value,'Комментарий\nиз скрытой колонки');
assert.equal(sheet.getCell('X2').value,83596.8454258675);assert.equal(sheet.getCell('Y2').value,14840112);
assert.equal(sheet.getCell('Z2').value,0);assert.equal(sheet.getCell('Z2').numFmt,'0.00');assert.match(sheet.getCell('Y2').note,/N8\*K8/);
assert.equal(sheet.getCell('X2').font.bold,true);assert.equal(sheet.getCell('X2').fill.fgColor.argb,'FFDFEAF7');
assert.equal(sheet.getCell('J2').value,17);
assert.equal(sheet.getCell('K2').value,16);assert.equal(sheet.getCell('L2').value,'Колонна железобетонная');assert.equal(sheet.getCell('M2').value,'Колонна К-1 согласно проекту');
assert.match(sheet.getCell('J2').note,/Расхождение: 1 шт/);
for(let r=3;r<=sheet.rowCount;r++)for(let col=10;col<=26;col++)assert.equal(sheet.getCell(r,col).value,null,'project metadata appears only on first row of the product block');
assert.equal(sheet.getCell('D2').value,2,'drawing volume, without allowance');
assert.equal(sheet.getCell('C3').value,'кг');assert.equal(sheet.getCell('D3').value,100);
assert.equal(sheet.getCell('E3').value,65,'manual price converted to rub/kg');
assert.equal(sheet.getCell('F3').value.result,6500,'drawing quantity times current price, not manual production amount');
assert.equal(sheet.getCell('H3').value.result,3250);assert.equal(sheet.getCell('I3').value.result,50);
assert.equal(sheet.getCell('G4').value,'металл');assert.equal(sheet.getCell('C5').value,'м');
assert.equal(sheet.getCell('D5').value,1.4);assert.equal(sheet.getCell('G6').value,'Прочие');
assert.equal(sheet.autoFilter,'A1:Z6');assert.equal(sheet.views[0].ySplit,1);
const zero=structuredClone(snapshot);zero.product.documentModel.projectVolume=0;zero.product.documentModel.resources[0].projectQty=null;
const zeroSheet=exporter.buildMaterialsWorkbook([zero]).worksheets[0];
assert.equal(zeroSheet.getCell('D3').value,null);assert.equal(zeroSheet.getCell('F3').value.result??'','');
assert.equal(zeroSheet.getCell('H2').value.result??'','');assert.equal(zeroSheet.getCell('I4').value.result??'','');
assert.ok(zeroSheet.getCell('H2').note);assert.ok(zeroSheet.getCell('D3').note);
const manual=structuredClone(snapshot);manual.product.documentModel=null;
const manualSheet=exporter.buildMaterialsWorkbook([manual]).worksheets[0];
assert.equal(manualSheet.rowCount,2);assert.equal(manualSheet.getCell('D2').value,2.1);
assert.throws(()=>exporter.buildMaterialsWorkbook([]),/хотя бы/);
const multi=exporter.buildMaterialsWorkbook([snapshot,snapshot]);
assert.equal(multi.worksheets[0].getCell('J7').value,17);
const noMatch=structuredClone(snapshot);noMatch.projectQuantity=0;
assert.equal(exporter.buildMaterialsWorkbook([noMatch]).worksheets[0].getCell('J2').value,0);
noMatch.projectQuantity=null;noMatch.projectQuantityStatus='ambiguous';
const ambiguous=exporter.buildMaterialsWorkbook([noMatch]).worksheets[0];
assert.equal(ambiguous.getCell('J2').value,null);assert.match(ambiguous.getCell('J2').note,/неоднозначно/);
assert.equal(multi.worksheets[0].getCell('H8').value.formula,'IF(OR($D$7="",$D$7=0,F8=""),"",F8/$D$7)');
writeFileSync(join(work,'unit.xlsx'),await book.xlsx.writeBuffer());writeFileSync(join(work,'missing.xlsx'),await zeroSheet.workbook.xlsx.writeBuffer());
const reopened=new ExcelJS.Workbook();await reopened.xlsx.load(readFileSync(join(work,'unit.xlsx')));
assert.equal(reopened.worksheets[0].getCell('F3').value.result,6500);
console.log('PASS: drawing quantities, effective prices, units, categories, formulas, missing inputs, multiple products, XLSX round trip');

const copied=spawnSync('.venv312/bin/python',['-c',`import sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1])/'calc';p.mkdir()
s=sqlite3.connect('file:data/calc/calczhbi.sqlite3?mode=ro',uri=True);d=sqlite3.connect(p/'calczhbi.sqlite3');s.backup(d);d.close();s.close()
`,work],{encoding:'utf8'});assert.equal(copied.status,0,copied.stderr);
const port=18167,base='http://127.0.0.1:'+port;
const server=spawn('.venv312/bin/python',['scripts/real_auth_server.py','data/zhbi.anon.db',String(port),work],{env:{...process.env,ZHBI_CALC_DIR:join(work,'calc'),ZHBI_CALC_ASSETS_DIR:resolve('data/calc/assets'),ZHBI_CALC_RECOVERY_WORKER:'0'},stdio:['ignore','pipe','pipe']});
let log='',browser;server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
const outputs=['unit.xlsx','missing.xlsx'].map(p=>join(work,p));
try{
 let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,250));}assert.ok(ready,log);
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const login=await page.request.post(base+'/login',{data:{domain_login:'admin',password:'Test-Pass-1234!'}});assert.equal(login.status(),200);
 await page.goto(base+'/calc/');await page.locator('#pc-export-materials-one').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.getElementById('pc-export-materials-one').disabled);
 const countsResponse=await page.request.get(base+'/calc/api/project-quantities');assert.equal(countsResponse.status(),200);
 const counts=await countsResponse.json();assert.ok(counts.project);
 const saveDownload=async(id,file)=>{const pending=page.waitForEvent('download');await page.locator(id).click();const download=await pending;assert.equal(download.suggestedFilename(),file);const path=join(work,file);await download.saveAs(path);outputs.push(path);return path;};
 const one=await saveDownload('#pc-export-materials-one','Материалы ЖБИ.xlsx');
 const actual=new ExcelJS.Workbook();await actual.xlsx.load(readFileSync(one));assert.equal(actual.worksheets.length,1);assert.ok(actual.worksheets[0].rowCount>2);
 assert.equal(actual.worksheets[0].columnCount,26);assert.ok(Number.isInteger(actual.worksheets[0].getCell('J2').value));
 assert.equal(actual.worksheets[0].getCell('K2').value,28);
 assert.match(actual.worksheets[0].getCell('L2').value,/Колонны железобетонные/);assert.match(actual.worksheets[0].getCell('M2').value,/Колонна 1КС1/);
 const sourceEntry=Object.values(counts.products).find(entry=>entry.ttnName===actual.worksheets[0].getCell('M2').value);
 assert.ok(sourceEntry?.sourceCells?.length===16);
 for(const [target,index] of [['N',0],['O',2],['P',3],['Q',4],['R',5],['S',8],['T',9],['U',10],['V',11],['W',12],['X',13],['Y',14],['Z',15]])assert.equal(actual.worksheets[0].getCell(target+'2').value,sourceEntry.sourceCells[index].value);
 for(let r=3;r<=actual.worksheets[0].rowCount;r++)for(let col=10;col<=26;col++)assert.equal(actual.worksheets[0].getCell(r,col).value,null);
 await page.locator('#pc-batch-toggle').click();assert.ok(await page.locator('#pc-export-materials').isDisabled());
 await page.locator('#pc-catalog-options').click();await page.locator('#pc-product-grouping').selectOption('none');
 await page.locator('[data-select-product]').nth(0).check();await page.locator('[data-select-product]').nth(1).check();
 assert.equal(await page.locator('#pc-export-materials').innerText(),'Материалы XLSX · 2');
 const pending=page.waitForEvent('download');await page.locator('#pc-export-materials').click();const batch=await pending;const batchPath=join(work,'batch.xlsx');await batch.saveAs(batchPath);outputs.push(batchPath);
 const batchBook=new ExcelJS.Workbook();await batchBook.xlsx.load(readFileSync(batchPath));const names=new Set();batchBook.worksheets[0].eachRow((r,n)=>{if(n>1)names.add(r.getCell(1).value);});assert.equal(names.size,2);
 let blocks=0,previous=null;batchBook.worksheets[0].eachRow((r,n)=>{if(n===1)return;const start=r.getCell(1).value!==previous;if(start){blocks++;assert.ok(Number.isInteger(r.getCell(10).value));}else assert.equal(r.getCell(10).value,null);previous=r.getCell(1).value;});assert.equal(blocks,2);
 await page.screenshot({path:join(work,'calculator.png'),fullPage:true});
 // Existing detailed export still downloads and contains the calculation form.
 const old=await saveDownload('#pc-export-one','Калькуляция ЖБИ.xlsx');const oldBook=new ExcelJS.Workbook();await oldBook.xlsx.load(readFileSync(old));assert.ok(oldBook.worksheets[0].getCell('C2').value);
 // Failure must release both export controls and show the API error.
 await page.route('**/calc/api/products/*/calculation',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({detail:'Тестовая ошибка выгрузки'})}));
 await page.locator('#pc-export-materials-one').click();await page.waitForFunction(()=>document.getElementById('pc-export-one-status').textContent.includes('Тестовая ошибка'));
 assert.ok(await page.locator('#pc-export-one').isEnabled());assert.ok(await page.locator('#pc-export-materials-one').isEnabled());
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(work,'mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: actual single/batch downloads, empty selection, existing export, API error recovery, desktop/mobile layout');
}finally{await browser?.close();server.kill('SIGTERM');}
for(const path of outputs){
 for(const script of ['/Users/max/.codex/scripts/validate_xlsx.py','scripts/verify_calc_xlsx.py']){
  const result=spawnSync('.venv312/bin/python',[script,path],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);console.log(result.stdout.trim());
 }
}
console.log('QA files: '+work);
