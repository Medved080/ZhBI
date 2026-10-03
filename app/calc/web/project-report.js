(()=>{
 'use strict';
 const q=s=>document.querySelector(s),api=window.CalcZhBIAPI,panel=q('#pc-project-report-panel');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=s=>new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
 const sources=(issue,productId=issue.productId)=>(issue.sources||[]).map(s=>`<a href="${esc(s.url)}" data-source-product="${esc(productId)}">${esc(s.label||s.sourceId)} · PDF стр. ${s.pdfPage}</a>`).join(' · ');
 let report=null,previousView='model',page=0,request=0;
 function close(){if(panel.hidden)return;request++;panel.hidden=true;q('.pc-tabs').hidden=false;q('#pc-'+previousView+'-panel').hidden=false;}
 function renderProduct(product){
  const items=[...(product.discrepancies||[]),...(product.dataIssues||[])],pending=product.documentModel?.solidModel?.pending||product.documentModel?.preview3d?.pendingReinforcement||[],host=q('#pc-product-discrepancies');
  host.hidden=!items.length&&!pending.length;
  host.innerHTML=`<h3>Расхождения и вопросы по изделию</h3>${items.map(i=>`<article class="pc-issue-card" data-severity="${esc(i.severity)}"><div class="pc-context">${esc(i.kindLabel)} · ${i.status==='resolved'?'Устранено':'Требует уточнения'}</div><strong>${esc(i.title)}</strong><p>${esc(i.description)}</p><p><b>Уточнить:</b> ${esc(i.recommendation)}</p><div class="pc-issue-sources">${sources(i,product.id)}</div></article>`).join('')}${pending.length?`<div class="pc-issue-pending"><strong>Не завершено в модели</strong><ul>${pending.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>`:''}`;
  const button=q('#pc-product-issues-link');button.hidden=!items.length&&!pending.length;button.textContent='Вопросы по изделию: '+items.filter(i=>i.status==='open').length+(pending.length?' · модель частичная':'');
 }
 function matches(){const term=q('#pc-report-search').value.toLocaleLowerCase('ru'),kind=q('#pc-report-kind').value;return report.issues.filter(i=>(!kind||(kind==='source'?i.kind!=='data_quality':i.kind===kind))&&(!term||(i.productName+' '+i.alias+' '+i.title+' '+i.description).toLocaleLowerCase('ru').includes(term)));}
 function renderIssues(){
  const items=matches(),size=40;page=Math.max(0,Math.min(page,Math.ceil(items.length/size)-1));
  q('#pc-report-count').textContent='Замечаний: '+items.length+' · страница '+(page+1)+' из '+Math.max(1,Math.ceil(items.length/size));
  q('#pc-report-issues').innerHTML=items.slice(page*size,(page+1)*size).map(i=>`<article class="pc-issue-card" data-severity="${esc(i.severity)}"><div class="pc-issue-heading"><button type="button" data-report-product="${esc(i.productId)}">${esc(i.productName)}</button><span class="pc-context">${esc(i.kindLabel)} · ${i.status==='resolved'?'Устранено':'Открыто'}</span></div><strong>${esc(i.title)}</strong><p>${esc(i.description)}</p><p><b>Уточнить:</b> ${esc(i.recommendation)}</p><div class="pc-context">${esc(i.album)} · ${esc(i.sourceRevision)}</div><div class="pc-issue-sources">${sources(i)}</div></article>`).join('')||'<p>По этому фильтру замечаний нет.</p>';
  q('#pc-report-prev').disabled=page===0;q('#pc-report-next').disabled=(page+1)*size>=items.length;
 }
 function render(){
  const s=report.summary;
  panel.innerHTML=`<div class="pc-report-heading"><div><div class="pc-context">Весь проект · ${esc(date(report.generatedAt))} МСК</div><h2>Расхождения и готовность изделий</h2></div><div class="pc-report-actions"><button id="pc-report-refresh" type="button">Обновить</button><button id="pc-report-download" type="button">Скачать XLSX · вся база</button><button id="pc-report-close" type="button">Вернуться к изделию</button></div></div><div class="pc-report-summary"><div><strong>${s.products}</strong><span>Изделий в базе</span></div><div><strong>${s.fullModels}</strong><span>Полных визуальных моделей</span></div><div><strong>${s.discrepancies}</strong><span>Вопросов по чертежам и размещению</span></div><div><strong>${s.dataIssues}</strong><span>Замечаний к данным</span></div></div><p class="pc-context">${esc(report.limitation)}</p><div class="pc-report-filters"><input id="pc-report-search" type="search" placeholder="Марка или текст замечания" aria-label="Поиск по отчёту"><select id="pc-report-kind" aria-label="Вид замечаний"><option value="source">Чертежи и размещение</option><option value="">Все замечания</option><option value="drawing_conflict">Противоречия чертежей</option><option value="placement_question">Вопросы размещения</option><option value="data_quality">Неполные данные</option></select><span id="pc-report-count" class="pc-context"></span></div><div id="pc-report-status" class="pc-context" role="status"></div><div id="pc-report-issues"></div><div class="pc-report-pages"><button id="pc-report-prev" type="button">Предыдущая</button><button id="pc-report-next" type="button">Следующая</button></div>`;
  renderIssues();q('#pc-report-search').addEventListener('input',()=>{page=0;renderIssues();});q('#pc-report-kind').addEventListener('change',()=>{page=0;renderIssues();});
  q('#pc-report-close').addEventListener('click',close);q('#pc-report-refresh').addEventListener('click',load);
  for(const [id,delta] of [['prev',-1],['next',1]])q('#pc-report-'+id).addEventListener('click',()=>{page+=delta;renderIssues();q('.pc-report-filters')?.scrollIntoView();panel.scrollTop=0;});
  q('#pc-report-download').addEventListener('click',download);
 }
 async function load(){
  const serial=++request;panel.textContent='Формирую отчёт по всей базе…';
  try{await window.CalcZhBIWorkspace?.flush();const result=await api.request('/calc/api/project-report');if(serial!==request||panel.hidden)return;report=result;page=0;render();}
  catch(e){if(serial===request){panel.innerHTML=`<p>${esc(e.message)}</p><button id="pc-report-close" type="button">Вернуться к изделию</button>`;q('#pc-report-close').addEventListener('click',close);}}
 }
 function open(){window.CalcZhBINorms?.close();previousView=q('.pc-tabs [data-view][aria-pressed="true"]')?.dataset.view||'model';q('.pc-tabs').hidden=true;for(const view of ['calculation','model','tech','sources','sheets','history'])q('#pc-'+view+'-panel').hidden=true;panel.hidden=false;void load();}
 function table(workbook,name,headers,rows,widths){
  const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:1}],pageSetup:{orientation:'landscape',paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0}});
  sheet.columns=headers.map((header,i)=>({header,width:widths[i]||25}));sheet.addRows(rows);sheet.autoFilter={from:{row:1,column:1},to:{row:rows.length+1,column:headers.length}};
  sheet.eachRow((row,n)=>{row.height=n===1?34:Math.min(240,Math.max(32,...row.values.slice(1).map((v,i)=>typeof v==='string'?Math.ceil(v.length/(widths[i]||25))*15+12:32)));row.eachCell(cell=>{cell.font={name:'Arial',size:11,color:{argb:'FF17212E'}};cell.alignment={vertical:'top',wrapText:true};if(n===1){cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF165D98'}};cell.font={name:'Arial',size:11,bold:true,color:{argb:'FFFFFFFF'}};}else cell.border={bottom:{style:'hair',color:{argb:'FFD9E0E8'}}};});});return sheet;
 }
 function buildWorkbook(report,origin){
   const wb=new globalThis.ExcelJS.Workbook();wb.creator='CalcZhBI';wb.created=new Date(report.generatedAt);
   const s=report.summary;
   table(wb,'Сводка',['Показатель','Значение'],[['Проект',report.project.name],['Сформирован, МСК',date(report.generatedAt)],['Изделий',s.products],['Полных визуальных моделей',s.fullModels],['Частичных моделей',s.partialModels],['Габаритных схем',s.envelopes],['Без индивидуальной модели',s.missingModels],['Вопросов по чертежам и размещению',s.discrepancies],['Изделий с такими вопросами',s.productsWithDiscrepancies],['Замечаний к данным',s.dataIssues],['Область отчёта',report.limitation]],[46,100]);
   table(wb,'Изделия',['Марка','Тип','Альбом','Изменение','PDF стр.','Готовность модели','Вопросы чертежей','Замечания к данным','Не завершено в модели','Ограничения','UUID изделия','Версия карточки'],report.products.map(p=>[p.name,p.family,p.album,p.sourceRevision,p.productPage,p.modelLabel,p.discrepancyCount,p.dataIssueCount,p.pendingModel.join('; '),p.limitations.join(' '),p.id,p.productVersion]),[28,20,55,24,12,25,18,18,65,85,38,15]);
   const headers=['Марка','Тип','Альбом','Изменение','Категория','Статус','Суть вопроса','Описание','Что уточнить','Исходные листы','Ссылки на PDF','ID замечания'];
   const rows=items=>items.map(i=>[i.productName,i.family,i.album,i.sourceRevision,i.kindLabel,i.status==='resolved'?'Устранено':'Открыто',i.title,i.description,i.recommendation,i.sources.map(x=>(x.label||x.sourceId)+' · PDF стр. '+x.pdfPage).join('; '),i.sources.map(x=>new URL(x.url,origin).href).join('\n'),i.id]);
   const widths=[28,20,55,24,25,14,55,80,75,60,65,55];
   table(wb,'Расхождения',headers,rows(report.issues.filter(i=>i.kind!=='data_quality')),widths);
   table(wb,'Неполные данные',headers,rows(report.issues.filter(i=>i.kind==='data_quality')),widths);
   return wb;
 }
 async function download(){
  const button=q('#pc-report-download'),status=q('#pc-report-status');button.disabled=true;status.textContent='Подготавливаю XLSX…';
  try{
   if(!globalThis.ExcelJS)throw new Error('Модуль XLSX не загружен. Обновите страницу.');
   // A report is an immutable snapshot of the complete server response.
   const wb=buildWorkbook(report,location.origin);
   const buffer=await wb.xlsx.writeBuffer(),url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const link=document.createElement('a');link.href=url;link.download='Отчёт-по-проекту-'+report.generatedAt.slice(0,10)+'.xlsx';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
   status.textContent='Отчёт выгружен: '+report.products.length+' изделий. Фильтр экрана и выбор изделий на его состав не влияют.';
  }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
 }
 q('#pc-project-report').addEventListener('click',open);
 panel.addEventListener('click',e=>{const b=e.target.closest('[data-report-product]');if(b){close();window.CalcZhBIWorkspace.select(b.dataset.reportProduct,'sources');}});
 window.CalcZhBIProjectReport={close,renderProduct,buildWorkbook};
})();
