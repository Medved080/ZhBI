(()=>{
 'use strict';
 // Коллизии изделия: закладка «Коллизии», карточка коллизии рядом с 3D-моделью и метки на модели (viewer-3d.js).
 // Данные — GET /calc/api/products/{id}/collisions (отчёт проверки модели + статусы и комментарии людей).
 const q=s=>document.querySelector(s),api=window.CalcZhBIAPI;
 const panel=q('#pc-collisions-panel'),card=q('#pc-collision-card'),toggle=q('#pc-collisions'),toggleLabel=q('#pc-collisions-label'),counter=q('#pc-collisions-count');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const when=s=>new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});
 const num=v=>v==null?'—':Number(v).toLocaleString('ru-RU',{maximumFractionDigits:2});
 const collisionText=/пересек|пересеч|коллиз|проникнов|столкнов/i;
 let product=null,data=null,selected=null,view='calculation',serial=0,error='';
 const canWrite=()=>api.user&&api.user.role!=='viewer';
 const items=()=>data?data.classes.flatMap(c=>c.items.map(i=>({...i,cls:c}))):[];
 const find=key=>items().find(i=>i.key===key);
 const registryItems=()=>product?[...(product.discrepancies||[]),...(product.dataIssues||[])].filter(i=>collisionText.test(i.title+' '+i.description)):[];
 const registryPending=()=>(product?.documentModel?.solidModel?.pending||[]).filter(p=>collisionText.test(p));
 const sourceId=()=>(window.CalcZhBIModelSpec?.sourceUrl||'').match(/document-source\/([^#/]+)/)?.[1];

 function publish(){
  const list=items().filter(i=>i.at),open=list.filter(i=>i.status==='open').length;
  toggleLabel.hidden=!list.length;counter.textContent=list.length?'('+list.length+(open!==list.length?', открытых '+open:'')+')':'';
  window.dispatchEvent(new CustomEvent('calczhbi:collisions',{detail:{productKey:product?.id,selected,visible:toggle.checked,items:list.map(i=>({key:i.key,at:i.at,status:i.status,penetrationMm:i.penetrationMm,notes:i.notes.length,title:i.a+' × '+i.b}))}}));
 }
 function pages(cls){const id=sourceId();return (cls.sourcePdfPages||[]).map(p=>id?`<a href="/calc/api/document-source/${esc(id)}#page=${p}">PDF стр. ${p}</a>`:'PDF стр. '+p).join(' · ');}
 function noteHtml(item){
  const statuses=Object.entries(data.statuses).map(([k,v])=>`<option value="${k}" ${k===item.status?'selected':''}>${esc(v)}</option>`).join('');
  return `<article class="pc-collision-detail" data-collision-card="${esc(item.key)}" data-status="${esc(item.status)}">
   <h4>${esc(item.a)} × ${esc(item.b)}</h4>
   <dl><dt>Класс</dt><dd>${esc(item.cls.parts)}</dd><dt>Источник</dt><dd>${esc(item.cls.originLabel||'')}</dd><dt>Проникновение</dt><dd>${num(item.penetrationMm)} мм</dd>${item.lengthMm!=null?`<dt>Длина участка</dt><dd>${num(item.lengthMm)} мм</dd>`:''}${item.at?`<dt>Место, мм</dt><dd>X ${num(item.at[0])} · Y ${num(item.at[1])} · Z ${num(item.at[2])}</dd>`:''}<dt>Листы</dt><dd>${pages(item.cls)||'—'}</dd></dl>
   ${item.cls.declaredAsSourceConflict?'<p class="pc-context">Класс заявлен как расхождение источника: нужен ответ проектировщика.</p>':''}
   <label class="pc-collision-status">Статус <select data-collision-status="${esc(item.key)}" ${canWrite()?'':'disabled'}>${statuses}</select></label>
   ${item.statusUpdatedBy?`<span class="pc-context">изменил: ${esc(item.statusUpdatedBy)}</span>`:''}
   <h5>Комментарии (${item.notes.length})</h5>
   <ul class="pc-collision-notes">${item.notes.map(n=>`<li><div class="pc-context">${esc(n.author)} · ${esc(when(n.createdAt))}</div>${esc(n.text)}</li>`).join('')||'<li class="pc-context">Комментариев пока нет.</li>'}</ul>
   ${canWrite()?`<form data-collision-form="${esc(item.key)}"><textarea maxlength="2000" rows="3" placeholder="Комментарий для проектировщика или технолога" aria-label="Комментарий к коллизии" required></textarea><button type="submit">Добавить комментарий</button><span class="pc-context" data-collision-msg role="status"></span></form>`:''}
  </article>`;
 }
 function renderCard(){
  const item=selected&&find(selected);
  const showCard=item&&view==='model';
  card.hidden=!showCard;card.innerHTML=showCard?'<h3>Коллизия</h3>'+noteHtml(item):'';
 }
 function badge(item){return `<span class="pc-collision-badge" data-status="${esc(item.status)}">${esc(data.statuses[item.status])}</span>`;}
 function renderPanel(){
  if(!product){panel.innerHTML='';return;}
  let html='<h3>Коллизии</h3>';
  if(error)html+=`<p class="pc-error">${esc(error)}</p>`;
  else if(!data)html+='<p class="pc-context" role="status">Загрузка…</p>';
  else{
   const shown=items().length;
   html+=`<p class="pc-context">Пересечения деталей и арматуры по отчёту проверки модели. Показано пересечений: ${shown} из ${data.totalPairs} пар в ${data.classes.length} классах (классы из отчёта проверки модели приводят только примеры, классы «труба × арматура» — собственная проверка калькулятора — перечислены полностью). Проникновение по трубам измеряется в пределах толщины стенки. Метки видны на вкладке «Модель и параметры» (флажок «Коллизии»).</p>`;
   if(data.reason)html+=`<p class="pc-context">${esc(data.reason)}</p>`;
   html+=data.classes.map(c=>`<details class="pc-collision-class" ${c.declaredAsSourceConflict?'open':''}><summary><strong>${esc(c.parts)}</strong>${c.origin==='check'?' <span class="pc-collision-badge">проверка калькулятора</span>':''} · пар: ${num(c.pairCount)} · макс. проникновение ${num(c.maxPenetrationMm)} мм${c.declaredAsSourceConflict?' · расхождение источника':''}</summary>
    ${c.items.length?`<ul class="pc-collision-list">${c.items.map(i=>`<li class="${i.key===selected?'pc-selected':''}" data-collision-row="${esc(i.key)}"><button type="button" data-collision-open="${esc(i.key)}">${esc(i.a)} × ${esc(i.b)}</button><span>${num(i.penetrationMm)} мм</span>${badge(i)}<span class="pc-context">комментариев: ${i.notes.length}</span>${i.at?`<button type="button" data-collision-show="${esc(i.key)}">Показать в 3D</button>`:''}</li>`).join('')}</ul>`:'<p class="pc-context">Примеры с координатами в отчёте не приведены.</p>'}</details>`).join('');
   const selectedItem=selected&&find(selected);
   if(selectedItem)html+='<section class="pc-collision-selected">'+noteHtml(selectedItem)+'</section>';
  }
  const reg=registryItems(),pending=registryPending();
  if(reg.length||pending.length){
   html+=`<h3>Замечания о пересечениях из реестра</h3><p class="pc-context">Записаны текстом, без координат: на 3D-модели не отмечены.</p>`+reg.map(i=>`<article class="pc-issue-card" data-severity="${esc(i.severity)}"><div class="pc-context">${esc(i.kindLabel)} · ${i.status==='resolved'?'Устранено':'Требует уточнения'}</div><strong>${esc(i.title)}</strong><p>${esc(i.description)}</p><p><b>Уточнить:</b> ${esc(i.recommendation)}</p><div class="pc-issue-sources">${(i.sources||[]).map(s=>`<a href="${esc(s.url)}">${esc(s.label||s.sourceId)} · PDF стр. ${s.pdfPage}</a>`).join(' · ')}</div></article>`).join('')+(pending.length?`<div class="pc-issue-pending"><ul>${pending.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>`:'');
  }
  panel.innerHTML=html;
 }
 function renderAll(){renderPanel();renderCard();publish();}
 async function load(){
  if(!product)return;const mine=++serial,id=product.id;data=null;error='';renderAll();
  try{const result=await api.request('/calc/api/products/'+id+'/collisions');if(mine!==serial)return;data=result;if(selected&&!find(selected))selected=null;}
  catch(e){if(mine!==serial)return;error='Не удалось загрузить коллизии: '+e.message;}
  renderAll();
 }
 function select(key,{show=false}={}){
  selected=key;
  if(show){q('.pc-tabs [data-view="model"]').click();renderAll();setTimeout(()=>window.dispatchEvent(new CustomEvent('calczhbi:collision-focus',{detail:{key}})),700);}
  else renderAll();
 }
 async function mutate(path,method,body){
  try{data=await api.request('/calc/api/products/'+product.id+'/collisions/'+path,{method,body:JSON.stringify(body)});error='';}
  catch(e){error=e.message;}
  renderAll();
 }
 document.addEventListener('click',event=>{
  const open=event.target.closest('[data-collision-open]'),show=event.target.closest('[data-collision-show]');
  if(open)select(open.dataset.collisionOpen);
  if(show)select(show.dataset.collisionShow,{show:true});
 });
 document.addEventListener('change',event=>{
  const s=event.target.closest('[data-collision-status]');if(s)void mutate(s.dataset.collisionStatus+'/status','PUT',{status:s.value});
 });
 document.addEventListener('submit',event=>{
  const form=event.target.closest('[data-collision-form]');if(!form)return;event.preventDefault();
  const text=form.querySelector('textarea').value.trim();if(!text)return;
  void mutate(form.dataset.collisionForm+'/notes','POST',{text});
 });
 toggle?.addEventListener('change',publish);
 window.addEventListener('calczhbi:collision-pick',event=>{selected=event.detail.key;renderAll();});
 window.addEventListener('calczhbi:view',event=>{view=event.detail;renderCard();if(view==='collisions')renderPanel();});
 window.CalcZhBICollisions={
  // Вызывается при каждой перерисовке карточки изделия; данные перезагружаются только при смене изделия.
  setProduct(next){const changed=!product||product.id!==next.id;product=next;if(changed){selected=null;void load();}else renderPanel();},
 };
})();
