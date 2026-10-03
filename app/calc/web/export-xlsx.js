/* Native browser exporter. Layout/styles come from the user's MSU-1 examples. */
(()=>{
 'use strict';
 const has=(row,field)=>row.manual?.[field]!==undefined&&row.manual[field]!=='';
 const formula=(expression,result)=>({formula:expression,result});
 const clone=value=>JSON.parse(JSON.stringify(value));
 const money=value=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
 function sheetName(name,used){
  const base=String(name).replace(/[\\/*?:\[\]\x00-\x1f]/g,' ').replace(/^'+|'+$/g,'').trim()||'Изделие';
  let candidate=base.slice(0,31),suffix=1;
  while(used.has(candidate.toLowerCase())){const tail=' ('+(++suffix)+')';candidate=base.slice(0,31-tail.length)+tail;}
  used.add(candidate.toLowerCase());return candidate;
 }
 function addProductSheet(workbook,snapshot,name,template){
  const {product,rows}=snapshot;
  const original=['1KS1-r1','2KS3-r1'].includes(product.documentModelId);
  const layout=template.layouts[product.documentModelId==='2KS3-r1'?1:0],header=layout.header;
  const offset=header-5;
  const sheet=workbook.addWorksheet(name,{views:[{state:'normal',showGridLines:true,zoomScale:80}],pageSetup:clone(layout.pageSetup)});
  layout.columns.forEach((width,i)=>{sheet.getColumn(i+1).width=width;});
  // Preserve the baseline without changing the printed six-column form.
  for(const col of ['I','J','K','L']){sheet.getColumn(col).width=20;sheet.getColumn(col).hidden=true;}
  const byId=Object.fromEntries(rows.map(row=>[row.id,row]));
  const materialIds=new Set(['concrete','rest',...(product.documentModel?.resources||[]).map(r=>r.id)]);
  const materials=rows.filter(row=>materialIds.has(row.id));
  const fixedIds=new Set([...materialIds,'labour','soc','energy','overhead','admin','commercial','profit','delivery']);
  const extra=rows.filter(row=>!fixedIds.has(row.id)),shift=materials.length-11;
  // Semantic row numbers refer to the first example; resource/extra rows expand it.
  const n=reference=>reference+offset+(reference>=19?shift:0)+(reference>=40?extra.length:0);
  function copyRow(target,reference,source=null){
   const selected=source||layout,index=source?reference:reference+offset;
   const r=selected.rows[index-1];if(!r)return;
   sheet.getRow(target).height=r.height||15;
   for(let col=2;col<=7;col++){
    const cell=sheet.getCell(target,col);cell.style=clone(template.styles[r.styles[col-2]]);
    if(r.labels[col-2]!==null)cell.value=r.labels[col-2];
   }
  }
  for(let row=1;row<header;row++)copyRow(row,row,layout);
  for(let row=5;row<=7;row++)copyRow(n(row),row);
  materials.forEach((row,i)=>copyRow(header+3+i,original?8+i:row.id==='rest'?18:row.id==='concrete'?8:row.unit==='м'?16:9));
  for(let row=19;row<=49;row++)copyRow(n(row),row);
  for(const merge of layout.merges)sheet.mergeCells(merge);
  sheet.getCell('C2').value=original?layout.sourceTitle:
   ['Промышленный корпус.',product.documentModel?.source?.title?'Альбом '+product.documentModel.source.title+'.':'',product.documentModel?.mark||product.name,product.documentModel?.kind==='registry'?'Предварительная калькуляция.':''].filter(Boolean).join('\n');
  if(!original&&String(sheet.getCell('C2').value).length>180)sheet.getRow(2).height=Math.max(131.25,Math.ceil(String(sheet.getCell('C2').value).length/40)*25);
  const start=header+3,end=start+materials.length-1;
  const materialSum=n(19),labourHeader=n(20),labourSum=n(25),social=n(26),energy=n(34),direct=n(36),cost=n(40),profit=n(41),delivery=n(42),net=n(43),vat=n(44),gross=n(45);
  sheet.getCell('G'+(header-1)).value=formula('E'+start,byId.concrete.effective.qty);
  const numberById={labour:labourHeader,soc:social,energy,overhead:n(37),admin:n(38),commercial:n(39),profit,delivery};
  materials.forEach((row,i)=>{numberById[row.id]=start+i;});
  extra.forEach((row,i)=>{numberById[row.id]=n(39)+1+i;copyRow(numberById[row.id],37);});
  ['Объём расчёта сервиса','Цена расчёта сервиса','Сумма расчёта сервиса','Объём труда с корректировками'].forEach((v,i)=>{sheet.getCell(header,i+9).value=v;});
  function baseline(row,r){
   sheet.getCell('I'+r).value=Number(row.precise?.qty??row.qty);
   sheet.getCell('J'+r).value=Number(row.precise?.rate??row.rate);
   sheet.getCell('K'+r).value=Number(row.precise?.amount??row.qty*row.rate);
   for(const col of ['J','K'])sheet.getCell(col+r).numFmt='#,##0.00';
  }
  function annotate(row,r){
   for(const [field,col] of [['qty','E'],['rate','F'],['amount','G']])if(has(row,field))sheet.getCell(col+r).note='Задано пользователем: '+row.manual[field]+'. Расчёт сервиса: '+(field==='amount'?(row.precise?.amount??row.qty*row.rate):(row.precise?.[field]??row[field]))+'.';
   if(product.documentModel?.kind==='registry'&&row.rate===0)sheet.getCell('F'+r).note='Цена не задана. Ноль — предварительное значение сервиса, а не подтверждённая бесплатная стоимость.';
  }
  function resource(row,r,label){
   baseline(row,r);sheet.getCell('C'+r).value=label||row.name;
   sheet.getCell('D'+r).value=row.unit==='м³'?'м3':row.unit;
   sheet.getCell('E'+r).value=Number(has(row,'qty')?row.manual.qty:row.precise?.qty??row.qty);
   sheet.getCell('F'+r).value=Number(has(row,'rate')?row.manual.rate:row.precise?.rate??row.rate);
   sheet.getCell('G'+r).value=has(row,'amount')?Number(row.manual.amount):formula('E'+r+'*F'+r,row.effective.amount);
   sheet.getCell('F'+r).numFmt=sheet.getCell('G'+r).numFmt='#,##0.00';
   if(!original||has(row,'qty'))sheet.getCell('E'+r).numFmt='#,##0.###';
   annotate(row,r);
  }
  materials.forEach((row,i)=>{
   const r=numberById[row.id],label=original&&row.id!=='concrete'?layout.rows[header+2+i].labels[1]:row.name;
   sheet.getCell('B'+r).value='1.'+(i+1);resource(row,r,label);
   if(row.id==='rest'){
    const reserve=rows.filter(a=>materialIds.has(a.id)&&a.id!=='rest').reduce((sum,a)=>sum+a.qty*a.rate,0)/100;
    if(Math.abs(reserve-row.rate)<Math.max(1e-7,Math.abs(row.rate)*1e-12)){
     sheet.getCell('D'+r).value='%';if(!has(row,'rate'))sheet.getCell('F'+r).value=null;
     if(!has(row,'amount'))sheet.getCell('G'+r).value=formula('E'+r+'*'+(has(row,'rate')?'F':'J')+r,row.effective.amount);
     sheet.getCell('G'+r).note=(sheet.getCell('G'+r).note||'')+' Резерв исходной калькуляции (1% базовых материалов). Его ставка в сервисе фиксирована; правки других материалов не меняют резерв автоматически.';
    }
   }
  });
  const materialTotal=materials.reduce((sum,row)=>sum+row.effective.amount,0);
  sheet.getCell('G'+n(7)).value=formula('SUM(G'+start+':G'+end+')',materialTotal);
  sheet.getCell('G'+materialSum).value=formula('G'+n(7),materialTotal);
  const steel=materials.filter(row=>row.unit==='т'&&!/проволок/i.test(row.name));
  sheet.getCell('E'+n(7)).value=steel.length?formula(steel.map(row=>'E'+numberById[row.id]).join('+'),steel.reduce((sum,row)=>sum+row.effective.qty,0)):null;
  const labour=byId.labour;baseline(labour,labourHeader);sheet.getCell('L'+labourHeader).value=labour.effective.qty;
  if(original){
   const prep=n(21),rebar=n(22),casting=n(23),control=n(24),formHours=labour.effective.qty/2.352;
   for(const r of [prep,rebar,casting,control]){
    sheet.getCell('F'+r).value=Number(has(labour,'rate')?labour.manual.rate:labour.precise?.rate??labour.rate);
    // The reference's accounting formats already contain digit separators.
   }
   sheet.getCell('E'+casting).value=formula('L'+labourHeader+'/2.352',formHours);
   sheet.getCell('E'+rebar).value=formula('E'+casting+'*1.1',formHours*1.1);
   sheet.getCell('E'+prep).value=formula('(E'+rebar+'+E'+casting+')*10/100',formHours*2.1*.1);
   sheet.getCell('E'+control).value=formula('(E'+rebar+'+E'+casting+')*2/100',formHours*2.1*.02);
   for(const r of [prep,rebar,casting,control])sheet.getCell('G'+r).value=formula('E'+r+'*F'+r,(r===casting?formHours:r===rebar?formHours*1.1:r===prep?formHours*.21:formHours*.042)*labour.effective.rate);
   sheet.getCell('G'+labourHeader).value=has(labour,'amount')?Number(labour.manual.amount):formula('SUM(G'+prep+':G'+control+')',labour.effective.amount);
   sheet.getCell('E'+labourSum).value=formula('SUM(E'+prep+':E'+control+')',labour.effective.qty);
   sheet.getCell('C'+casting).note='Доли труда из примера этого изделия: формование, армирование 110%, заготовка 10%, контроль 2% от суммы армирования и формования. При правке общего труда сохраняются эти доли.';
  }else{
   resource(labour,labourHeader,'Трудовые ресурсы:');sheet.getCell('B'+labourHeader).value='2';
   sheet.getCell('E'+labourSum).value=formula('E'+labourHeader,labour.effective.qty);
   for(const r of [n(21),n(22),n(23),n(24)])sheet.getCell('C'+r).note='Отдельная норма операции для изделия не задана. В итог включён общий труд из сервиса; разбивка исходных колонн на другое изделие не переносится.';
  }
  sheet.getCell('G'+labourSum).value=formula('G'+labourHeader,labour.effective.amount);annotate(labour,labourHeader);
  function percent(id,r,dependency,label){
   const row=byId[id];baseline(row,r);sheet.getCell('C'+r).value=label;sheet.getCell('E'+r).value=row.effective.qty;
   sheet.getCell('F'+r).value=has(row,'rate')?Number(row.manual.rate):null;
   const rate=has(row,'rate')?'F'+r:dependency;
   sheet.getCell('G'+r).value=has(row,'amount')?Number(row.manual.amount):formula('E'+r+'*('+rate+')',row.effective.amount);
   sheet.getCell('F'+r).numFmt=sheet.getCell('G'+r).numFmt='#,##0.00';annotate(row,r);
  }
  const pct=id=>String(byId[id].effective.qty).replace('.',',');
  percent('soc',social,'G'+labourSum+'/100','Страховые взносы:');
  for(const r of [n(27),n(28),n(29),n(30)]){
   if(!original)sheet.getCell('E'+r).value=null;
   sheet.getCell('C'+r).note='Справочная строка образца. Отдельное начисление не задано и не прибавляется к общей ставке страховых взносов.';
  }
  percent('energy',energy,'G'+materialSum+'/100','Энергоуслуги - '+pct('energy')+'% от п.1 (2025г)');
  sheet.getCell('G'+direct).value=formula('SUM(G'+energy+',G'+labourSum+',G'+materialSum+',G'+social+')',materialTotal+labour.effective.amount+byId.soc.effective.amount+byId.energy.effective.amount);
  percent('overhead',n(37),'G'+materialSum+'/100','Общепроизводственные расходы  - '+pct('overhead')+'% от п.1 (2025г)');
  percent('admin',n(38),'G'+materialSum+'/100','Административные расходы '+pct('admin')+'% от п.1 (2025г)');
  percent('commercial',n(39),'G'+materialSum+'/100','Коммерческие расходы '+pct('commercial')+'% от п.1 (2025г)');
  extra.forEach((row,i)=>{resource(row,numberById[row.id]);sheet.getCell('B'+numberById[row.id]).value='12.'+(i+1);});
  const costTotal=rows.filter(row=>!['profit','delivery'].includes(row.id)).reduce((sum,row)=>sum+row.effective.amount,0);
  sheet.getCell('G'+cost).value=formula('SUM(G'+direct+':G'+(cost-1)+')',costTotal);
  percent('profit',profit,'G'+cost+'/(1-E'+profit+'/100)/100','Рентабельность '+pct('profit')+'%');
  percent('delivery',delivery,'G'+materialSum+'/100','Доставка '+pct('delivery')+'% от п.1 (2025г)');
  sheet.getCell('G'+net).value=formula('SUM(G'+cost+':G'+delivery+')',Number(snapshot.precise?.total??snapshot.total));
  sheet.getCell('E'+vat).value=snapshot.vatPercent??22;sheet.getCell('C'+vat).value='НДС '+(snapshot.vatPercent??22)+'%';
  sheet.getCell('G'+vat).value=formula('G'+net+'*E'+vat+'/100',snapshot.total*(snapshot.vatPercent??22)/100);
  sheet.getCell('G'+gross).value=formula('SUM(G'+net+':G'+vat+')',Number(snapshot.precise?.grossTotal??snapshot.total*(1+(snapshot.vatPercent??22)/100)));
  sheet.getCell('K'+net).value=Number(snapshot.precise?.baseTotal??snapshot.baseTotal);
  sheet.getCell('G'+net).note='Калькуляция с пользовательскими корректировками. Расчёт сервиса без НДС: '+money(snapshot.baseTotal)+' руб. Точный итог сервера: '+(snapshot.precise?.total??snapshot.total)+'. Базовые объёмы, цены и суммы сохранены в скрытых колонках I–K.';
  for(const r of [net,vat,gross])sheet.getCell('G'+r).numFmt='#,##0.00';
  if(original)layout.quotes.forEach((value,i)=>{sheet.getCell('G'+n(47+i)).value=value;sheet.getCell('G'+n(47+i)).numFmt='#,##0';sheet.getCell('G'+n(47+i)).note='Справочная цена исходного примера МСУ-1; не итог текущей калькуляции сервиса.';});
  const notices=[];
  if(product.documentModel?.kind==='registry')notices.push('Предварительные нормы от двух колонн, версия '+product.normsVersion+'. Цены и производственный расход требуют подтверждения.');
  for(const issue of product.discrepancies||[])notices.push('Расхождение: '+issue.title+'. '+issue.description+' Уточнить: '+issue.recommendation+' Источники: '+(issue.sources||[]).map(s=>(s.label||s.sourceId)+' / PDF стр. '+s.pdfPage).join('; '));
  for(const issue of product.dataIssues||[])notices.push('Неполные данные: '+issue.title+'. '+issue.recommendation);
  for(const pending of product.documentModel?.solidModel?.pending||product.documentModel?.preview3d?.pendingReinforcement||[])notices.push('Не завершено в модели: '+pending);
  for(const issue of product.documentModel?.issues||[])notices.push('Требует уточнения: '+issue);
  sheet.getCell('C2').note=notices.join('\n\n')+'\nИсточник формы: '+template.source+'. Источник изделия: '+(product.documentModel?.source?.title||product.name)+'.';
  for(let r=n(38);r<=gross;r++)if(!extra.some(row=>numberById[row.id]===r))sheet.getCell('B'+r).value=formula('B'+(r-1)+'+1',11+r-n(38)-extra.filter(row=>numberById[row.id]<r).length);
  if(extra.length)sheet.getCell('B'+cost).value=formula('B'+n(39)+'+1',13);
  sheet.pageSetup.printArea='B1:G'+n(49);
  if(shift>0||extra.length){sheet.pageSetup.fitToHeight=0;sheet.pageSetup.printTitlesRow=header+':'+header;}
  return sheet;
 }
 function buildWorkbook(snapshots,template){
  if(!globalThis.ExcelJS||!template?.layouts||!template?.styles)throw new Error('Не удалось загрузить шаблон XLSX. Обновите страницу.');
  if(!Array.isArray(snapshots)||!snapshots.length)throw new Error('Выберите хотя бы одно изделие.');
  const workbook=new ExcelJS.Workbook();workbook.creator='CalcZhBI';workbook.calcProperties.fullCalcOnLoad=true;const used=new Set();
  for(const snapshot of snapshots){
   if(![snapshot.baseTotal,snapshot.total].every(Number.isFinite))throw new Error('Не удалось рассчитать '+snapshot.product.name+'.');
   addProductSheet(workbook,snapshot,sheetName(snapshot.product.name+' (кальк)',used),template);
  }
  return workbook;
 }
 async function download(snapshots){
  const template=await window.CalcZhBIAPI.request('/calc/api/calculation-export-template');
  const workbook=buildWorkbook(snapshots,template),buffer=await workbook.xlsx.writeBuffer();
  const url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download='Калькуляция ЖБИ.xlsx';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
 }
 window.CalcZhBIExport={buildWorkbook,download};
})();
