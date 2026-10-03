(()=>{
 const list=document.getElementById('pc-history-list'),details=document.getElementById('pc-history-snapshot'),api=window.CalcZhBIAPI;
 let productId=null,revision=0;
 const money=window.CalcZhBIMoney.format;
 async function load(){
  if(!productId)return;const identifier=productId,version=++revision;list.textContent='Загрузка версий…';details.replaceChildren();
  try{
   await window.CalcZhBIFlushSaves?.();const history=await api.request('/calc/api/products/'+identifier+'/history');if(version!==revision)return;list.replaceChildren();
   for(const item of history){const button=document.createElement('button');button.type='button';button.textContent='Версия '+item.product_version+' · '+new Date(item.created_at).toLocaleString('ru-RU');button.addEventListener('click',()=>void snapshot(identifier,item,version));list.append(button);}
  }catch(error){if(version===revision)list.textContent=error.message;}
 }
 async function snapshot(identifier,item,version){
  try{
   const data=await api.request('/calc/api/products/'+identifier+'/history/'+item.id);if(version!==revision)return;details.replaceChildren();
   const title=document.createElement('h3');title.textContent=data.product.name+' · версия '+item.product_version;
   const totals=document.createElement('p');totals.textContent='Расчёт сервиса: '+money(data.baseTotal)+' ₽ · Моя калькуляция: '+money(data.total)+' ₽ без НДС';
   const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent='Выгрузить эту версию в XLSX';exportButton.addEventListener('click',()=>void window.CalcZhBIExport.download([data]).catch(error=>{totals.textContent=error.message;}));
   const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');
   for(const name of ['Статья','Расчёт сервиса, ₽','Моя сумма, ₽']){const cell=document.createElement('th');cell.textContent=name;tr.append(cell);}head.append(tr);table.append(head);
   const body=document.createElement('tbody');for(const row of data.rows){const tr=document.createElement('tr');for(const value of [row.name,money(row.qty*row.rate),money(row.effective.amount)]){const cell=document.createElement('td');cell.textContent=value;tr.append(cell);}body.append(tr);}table.append(body);
   details.append(title,totals,exportButton,table);
  }catch(error){if(version===revision)details.textContent=error.message;}
 }
 window.addEventListener('calczhbi:product',event=>{productId=event.detail;revision++;list.replaceChildren();details.replaceChildren();if(!document.getElementById('pc-history-panel').hidden)void load();});
 document.querySelector('[data-view=history]').addEventListener('click',()=>void load());
})();
