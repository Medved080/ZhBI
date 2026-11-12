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
const snapshot={product:{name:'Тестовая колонна',volume:2.1,documentModel:{alias:'1КС1',mark:'К-1',projectVolume:2,resources:materials}},rows:[row('concrete','Бетон В40','м³',2.1,6000),...materials.map(r=>row(r.id,r.name,r.unit,r.qty,r.rate)),row('rest','Прочие материалы','компл.',1,500),row('labour','Труд','чел·ч',10,800),row('soc','Страховые взносы','%',30,80),row('energy','Энергоуслуги','%',12,150),row('overhead','Общепроизводственные','%',10,150),row('admin','Административные','%',5,150),row('commercial','Коммерческие','%',0,150),row('extra1','Дополнительная статья','компл.',1,300),row('profit','Прибыль','%',15,300),row('delivery','Доставка','%',3,150)],baseTotal:20000,total:20000};
snapshot.rows[1].manual={qty:0,rate:65000,amount:123};snapshot.rows[1].effective={qty:0,rate:65000,amount:123};
snapshot.rows[6].manual={qty:12};snapshot.rows[6].effective={qty:12,rate:800,amount:9600};
snapshot.total=snapshot.rows.reduce((sum,r)=>sum+r.effective.amount,0);
snapshot.projectQuantity=17;
snapshot.exportReference={referenceStatus:'found',proposedName:'Колонна железобетонная',ttnName:'Колонна К-1 согласно проекту',sourceQuantity:16,sourceRows:[8]};
snapshot.exportReference.sourceCells=Array.from({length:16},()=>({value:null,numberFormat:'General',formula:null}));
snapshot.exportReference.sourceCells[2]={value:'Комментарий\nиз скрытой колонки',numberFormat:'General',formula:null};
snapshot.exportReference.sourceCells[13]={value:83596.8454258675,numberFormat:'#,##0.00',formula:null};
snapshot.exportReference.sourceCells[14]={value:14840112,numberFormat:'#,##0.00',formula:'=N8*K8'};
snapshot.exportReference.sourceCells[15]={value:0,numberFormat:'0.00',formula:'=N8/L8'};
const original=JSON.stringify(snapshot),book=exporter.buildMaterialsWorkbook([snapshot]),sheet=book.worksheets[0];
assert.equal(JSON.stringify(snapshot),original,'export must preserve the snapshot');
assert.equal(book.worksheets.length,1);assert.equal(sheet.rowCount,snapshot.rows.length+1,'every calculation row, including zero amounts');
assert.deepEqual(Array.from(sheet.getRow(1).values).slice(1,17),['Номенклатура','Марка изделия','Строка калькуляции','ЕИ','Проектный объем / масса','Коэффициент','Объем / масса с учетом коэффициента','Цена, ₽','Сумма, ₽','Статья','на м3 руб','на м3 кол-во','Количество по модели в проекте, шт.','Количество по таблице, шт.','Предлагаемое наименование','Наименование в ТТН']);
assert.equal(sheet.columnCount,29);assert.equal(sheet.getCell('R2').value,'Комментарий\nиз скрытой колонки');
assert.equal(sheet.getCell('AA2').value,83596.8454258675);assert.equal(sheet.getCell('AB2').value,14840112);
assert.equal(sheet.getCell('AC2').value,0);assert.equal(sheet.getCell('AC2').numFmt,'0.00');assert.match(sheet.getCell('AB2').note,/N8\*K8/);
assert.equal(sheet.getCell('A2').value,'К-1','full project mark stays in nomenclature');
for(let r=2;r<=sheet.rowCount;r++)assert.equal(sheet.getCell('B'+r).value,'1КС1','short catalog mark repeats on every row');
assert.equal(sheet.getCell('G2').formula,'E2*F2');
assert.equal(sheet.getCell('I2').formula,'IF(OR(G2="",H2=""),"",G2*H2)');
assert.equal(sheet.getCell('AA2').font.bold,true);assert.equal(sheet.getCell('AA2').fill.fgColor.argb,'FFDFEAF7');
assert.equal(sheet.getCell('M2').value,17);
assert.equal(sheet.getCell('N2').value,16);assert.equal(sheet.getCell('O2').value,'Колонна железобетонная');assert.equal(sheet.getCell('P2').value,'Колонна К-1 согласно проекту');
assert.match(sheet.getCell('M2').note,/Расхождение: 1 шт/);
for(let r=3;r<=sheet.rowCount;r++)for(let col=13;col<=29;col++)assert.equal(sheet.getCell(r,col).value,null,'project metadata appears only on first row of the product block');
assert.equal(sheet.getCell('E2').value,2,'drawing volume, without allowance');
assert.equal(sheet.getCell('F2').value,1.05);assert.equal(sheet.getCell('G2').value.result,2.1);
assert.equal(sheet.getCell('D3').value,'кг');assert.equal(sheet.getCell('E3').value,100);
assert.equal(sheet.getCell('H3').value,65,'manual price converted to rub/kg');
assert.equal(sheet.getCell('F3').value,0);assert.equal(sheet.getCell('G3').result,0,'manual quantity zero is preserved');
assert.equal(sheet.getCell('I3').value,123,'manual amount is preserved independently of quantity and rate');
assert.equal(sheet.getCell('K3').value.result,61.5);assert.equal(sheet.getCell('L3').result,0);
assert.equal(sheet.getCell('J4').value,'металл');assert.equal(sheet.getCell('D5').value,'м');
assert.equal(sheet.getCell('E5').value,1.4);assert.equal(sheet.getCell('G5').value.result,1.442);assert.equal(sheet.getCell('J6').value,'Прочие');
assert.equal(sheet.getCell('F4').value,1.5,'rounded production quantity determines the actual coefficient');
assert.equal(sheet.getCell('E8').value,10);assert.equal(sheet.getCell('F8').value,1.2);assert.equal(sheet.getCell('G8').value.result,12);
assert.match(sheet.getCell('E9').note,/исходная норма/);assert.equal(sheet.getCell('F9').value,1);assert.equal(sheet.getCell('G9').value.result,30);
const cellValue=cell=>cell.value?.formula?cell.result:cell.value;
const assertSnapshot=(sheet,snapshot,start=2)=>{
 let total=0;
 snapshot.rows.forEach((source,i)=>{
  const r=start+i,scale=source.unit==='т'?1000:1;
  assert.equal(sheet.getCell('C'+r).value,source.name,'calculation order and complete rows');
  assert.ok(Math.abs(cellValue(sheet.getCell('G'+r))-source.effective.qty*scale)<1e-9,source.name+': effective quantity');
  assert.ok(Math.abs(cellValue(sheet.getCell('I'+r))-source.effective.amount)<1e-7,source.name+': effective amount');
  total+=cellValue(sheet.getCell('I'+r));
 });
 assert.ok(Math.abs(total-snapshot.total)<1e-6,'export amounts reconcile to the calculation total');
};
assertSnapshot(sheet,snapshot);
assert.equal(sheet.autoFilter,'A1:AC'+sheet.rowCount);assert.equal(sheet.views[0].ySplit,1);
const zero=structuredClone(snapshot);zero.product.documentModel.projectVolume=0;zero.product.documentModel.resources[0].projectQty=null;
const zeroSheet=exporter.buildMaterialsWorkbook([zero]).worksheets[0];
assert.equal(zeroSheet.getCell('E3').value,null);assert.equal(zeroSheet.getCell('G3').value,0);
assert.equal(zeroSheet.getCell('F2').value,null);assert.equal(zeroSheet.getCell('G2').value,2.1,'zero project base does not discard production usage');
assert.equal(zeroSheet.getCell('K2').value.result??'','');assert.equal(zeroSheet.getCell('L4').value.result??'','');
assert.ok(zeroSheet.getCell('K2').note);assert.ok(zeroSheet.getCell('E3').note);
assertSnapshot(zeroSheet,zero);
const manual=structuredClone(snapshot);manual.product.documentModel=null;
const manualSheet=exporter.buildMaterialsWorkbook([manual]).worksheets[0];
assert.equal(manualSheet.getCell('B2').value,manual.product.name,'manual product keeps its entered name');
const legacy=structuredClone(snapshot);delete legacy.product.documentModel.alias;
legacy.product.documentModel.mark='1КС89,4-7.9-243/20.16-1 (1КС1)';
assert.equal(exporter.buildMaterialsWorkbook([legacy]).worksheets[0].getCell('B2').value,'1КС1','original columns use the designation in parentheses');
legacy.product.documentModel.mark='Полная марка без короткого обозначения';
assert.equal(exporter.buildMaterialsWorkbook([legacy]).worksheets[0].getCell('B2').value,legacy.product.name);
assert.equal(manualSheet.rowCount,manual.rows.length+1);assert.equal(manualSheet.getCell('E2').value,2.1);
assertSnapshot(manualSheet,manual);
assert.throws(()=>exporter.buildMaterialsWorkbook([]),/хотя бы/);
const second=structuredClone(snapshot);second.product.documentModel.alias='ПЦ-10';
const multi=exporter.buildMaterialsWorkbook([snapshot,second]);
const nextBlock=snapshot.rows.length+2;
assert.equal(multi.worksheets[0].getCell('M'+nextBlock).value,17);
for(let r=nextBlock;r<=multi.worksheets[0].rowCount;r++)assert.equal(multi.worksheets[0].getCell('B'+r).value,'ПЦ-10');
const noMatch=structuredClone(snapshot);noMatch.projectQuantity=0;
assert.equal(exporter.buildMaterialsWorkbook([noMatch]).worksheets[0].getCell('M2').value,0);
noMatch.projectQuantity=null;noMatch.projectQuantityStatus='ambiguous';
const ambiguous=exporter.buildMaterialsWorkbook([noMatch]).worksheets[0];
assert.equal(ambiguous.getCell('M2').value,null);assert.match(ambiguous.getCell('M2').note,/неоднозначно/);
assert.equal(multi.worksheets[0].getCell('K'+(nextBlock+1)).value.formula,`IF(OR($E$${nextBlock}="",$E$${nextBlock}=0,I${nextBlock+1}=""),"",I${nextBlock+1}/$E$${nextBlock})`);
writeFileSync(join(work,'unit.xlsx'),await book.xlsx.writeBuffer());writeFileSync(join(work,'missing.xlsx'),await zeroSheet.workbook.xlsx.writeBuffer());
const reopened=new ExcelJS.Workbook();await reopened.xlsx.load(readFileSync(join(work,'unit.xlsx')));
assertSnapshot(reopened.worksheets[0],snapshot);
assert.equal(reopened.worksheets[0].getCell('B2').value,'1КС1');
console.log('PASS: all calculation rows, project quantities, coefficients, effective quantities/amounts, units, zero/missing inputs, multiple products, XLSX round trip');

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
 const calculationResponse=page.waitForResponse(r=>/\/calc\/api\/products\/[^/]+\/calculation$/.test(new URL(r.url()).pathname));
 const one=await saveDownload('#pc-export-materials-one','Калькуляции ЖБИ (плоская).xlsx');
 const calculation=await (await calculationResponse).json();
 const actual=new ExcelJS.Workbook();await actual.xlsx.load(readFileSync(one));assert.equal(actual.worksheets.length,1);assert.ok(actual.worksheets[0].rowCount>2);
 assert.equal(actual.worksheets[0].rowCount,calculation.rows.length+1);assertSnapshot(actual.worksheets[0],calculation);
 assert.equal(actual.worksheets[0].getCell('B1').value,'Марка изделия');
 for(let r=2;r<=actual.worksheets[0].rowCount;r++)assert.equal(actual.worksheets[0].getCell('B'+r).value,'1КС1');
 assert.equal(actual.worksheets[0].columnCount,29);assert.ok(Number.isInteger(actual.worksheets[0].getCell('M2').value));
 assert.equal(actual.worksheets[0].getCell('N2').value,28);
 assert.match(actual.worksheets[0].getCell('O2').value,/Колонны железобетонные/);assert.match(actual.worksheets[0].getCell('P2').value,/Колонна 1КС1/);
 const sourceEntry=Object.values(counts.products).find(entry=>entry.ttnName===actual.worksheets[0].getCell('P2').value);
 assert.ok(sourceEntry?.sourceCells?.length===16);
 for(const [target,index] of [['Q',0],['R',2],['S',3],['T',4],['U',5],['V',8],['W',9],['X',10],['Y',11],['Z',12],['AA',13],['AB',14],['AC',15]])assert.equal(actual.worksheets[0].getCell(target+'2').value,sourceEntry.sourceCells[index].value);
 for(let r=3;r<=actual.worksheets[0].rowCount;r++)for(let col=13;col<=29;col++)assert.equal(actual.worksheets[0].getCell(r,col).value,null);
 await page.locator('#pc-batch-toggle').click();assert.ok(await page.locator('#pc-export-materials').isDisabled());
 await page.locator('#pc-catalog-options').click();await page.locator('#pc-product-grouping').selectOption('none');
 await page.locator('[data-select-product]').nth(0).check();await page.locator('[data-select-product]').nth(1).check();
 assert.equal(await page.locator('#pc-export-materials').innerText(),'Плоская XLSX · 2');
 const pending=page.waitForEvent('download');await page.locator('#pc-export-materials').click();const batch=await pending;const batchPath=join(work,'batch.xlsx');await batch.saveAs(batchPath);outputs.push(batchPath);
 const batchBook=new ExcelJS.Workbook();await batchBook.xlsx.load(readFileSync(batchPath));const names=new Set();batchBook.worksheets[0].eachRow((r,n)=>{if(n>1)names.add(r.getCell(1).value);});assert.equal(names.size,2);
 const marks=new Map();batchBook.worksheets[0].eachRow((r,n)=>{if(n>1){const name=r.getCell(1).value,mark=r.getCell(2).value;assert.ok(mark);if(marks.has(name))assert.equal(mark,marks.get(name));else marks.set(name,mark);}});assert.equal(new Set(marks.values()).size,2);
 let blocks=0,previous=null;batchBook.worksheets[0].eachRow((r,n)=>{if(n===1)return;const start=r.getCell(1).value!==previous;if(start){blocks++;assert.ok(Number.isInteger(r.getCell(13).value));}else assert.equal(r.getCell(13).value,null);previous=r.getCell(1).value;});assert.equal(blocks,2);
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
