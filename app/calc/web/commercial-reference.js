/* Read-only prices; all monetary comparisons come from the Decimal API. */
(()=>{
 'use strict';
 const panel=document.getElementById('pc-commercial-reference'),api=window.CalcZhBIAPI;
 const dialog=document.getElementById('pc-commercial-dialog'),content=document.getElementById('pc-commercial-content');
 const money=value=>window.CalcZhBIMoney.format(value)+' ₽';
 const number=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3}).format(Number(value));
 let productId=null,revision=0;
 function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
 function link(label,url,download=false){const a=element('a',label);a.href=url;if(download)a.setAttribute('download','');else {a.target='_blank';a.rel='noopener';}return a;}
 function values(data){
  const row=element('div',undefined,'pc-commercial-values');
  for(const [label,value] of [['КП за изделие',data.unitPriceGross],['Моя сохранённая цена',data.savedCalculationGross],['Разница сумм с НДС',data.differenceGross]]){
   const item=element('div');item.append(element('span',label),element('strong',money(value)));row.append(item);
  }
  return row;
 }
 document.getElementById('pc-commercial-close').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>panel.querySelector('#pc-commercial-open')?.focus({preventScroll:true}));
 content.addEventListener('click',event=>{
  const a=event.target.closest('a[href]');if(!a||a.hasAttribute('download'))return;
  const url=new URL(a.href,location.href);
  if(url.origin===location.origin&&url.pathname.startsWith('/calc/api/document-source/')&&url.hash)dialog.close();
 });
 async function refresh(){
  if(!productId)return;
  const request=++revision,id=productId;
  panel.setAttribute('aria-busy','true');
  if(!panel.children.length)panel.replaceChildren(element('h3','Ориентир КП'),element('p','Загрузка справочной цены…','pc-context'));
  try{
   const data=await api.request('/calc/api/products/'+id+'/commercial-reference');
   if(request!==revision||id!==productId)return;
   const head=element('div',undefined,'pc-commercial-heading');head.append(element('h3','Ориентир КП'),element('span','Справочно · с НДС','pc-context'));
   panel.replaceChildren(head);
   document.getElementById('pc-commercial-dialog-title').textContent='Ориентир КП · '+document.getElementById('pc-title').textContent;
   content.replaceChildren();
   if(data.available){
    panel.append(values(data));content.append(values(data),element('p',data.note+' После редактирования сравнение обновляется при сохранении.','pc-context'),element('h3','Источник и условия сравнения'));
    content.append(element('p',data.filename+' · лист «'+data.sheet+'» · строка '+data.row+' · '+data.priceCell));
    content.append(element('p',money(data.pricePerM3Gross)+'/м³ × '+number(data.sourceVolume)+' м³/шт.'));
    if(data.sourceQuantity)content.append(element('p','Количество в источнике: '+number(data.sourceQuantity)+' шт. · сумма '+money(data.sourceLotGross)));
    content.append(element('p','Редакция каталога: '+data.drawingRevision+'. '+data.revisionNote),element('p',data.vatNote+' НДС калькуляции: '+number(data.calculationVatPercent)+'%.'));
    content.append(link('Проверенный лист изделия',data.drawingUrl));
   }else {panel.append(element('p','Подтверждённая цена отсутствует','pc-context'));content.append(element('p',data.note,'pc-context'));}
   const links=element('div',undefined,'pc-commercial-links');links.append(link('Таблица КП',data.sourceUrl,true),link('Основание · СЗ',data.instructionUrl),link('Реестр сверки',data.auditUrl,true));content.append(links);
   const open=element('button','Условия и источник');open.id='pc-commercial-open';open.type='button';open.setAttribute('aria-haspopup','dialog');open.setAttribute('aria-controls',dialog.id);open.title='Источник, количество, редакция и условия сравнения с сохранённой ценой';open.addEventListener('click',()=>dialog.showModal());panel.append(open);
  }catch(error){if(request!==revision)return;panel.replaceChildren(element('h3','Ориентир КП'),element('p',error.message,'pc-context'));const retry=element('button','Повторить');retry.type='button';retry.addEventListener('click',refresh);panel.append(retry);}
  finally{if(request===revision)panel.removeAttribute('aria-busy');}
 }
 window.addEventListener('calczhbi:product',event=>{if(event.detail!==productId){if(dialog.open)dialog.close();panel.replaceChildren();}productId=event.detail;refresh();});
 window.addEventListener('calczhbi:saved',refresh);
})();
