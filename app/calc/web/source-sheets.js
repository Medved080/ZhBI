(()=>{
 'use strict';
 const panel=document.getElementById('pc-sheets-panel'),content=document.getElementById('pc-sheets-content'),api=window.CalcZhBIAPI;
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let productId=null,revision=0,loadedFor=null,sheets=[],active=0,zoom=0,requested=null;
 const selected=new Map();
 function display(){
  const sheet=sheets[active];if(!sheet)return;
  selected.set(productId,sheet.id);zoom=0;
  const stage=content.querySelector('.pc-sheet-stage'),image=stage.querySelector('img'),status=content.querySelector('#pc-sheet-status');
  stage.dataset.zoom='fit';stage.style.removeProperty('--sheet-zoom');stage.scrollTo(0,0);image.hidden=true;image.alt=sheet.titles.join(' · ');image.dataset.ready='false';
  content.querySelector('#pc-sheet-title').textContent=sheet.titles.join(' · ');
  content.querySelector('#pc-sheet-location').textContent=(sheet.sheet?'Лист '+sheet.sheet+' · ':'')+'PDF стр. '+sheet.pdfPage+' · '+sheet.filename;
  const original=content.querySelector('#pc-sheet-original');original.href=sheet.albumUrl.split('#')[0];original.download=sheet.filename;
  content.querySelectorAll('[data-source-sheet]').forEach(button=>button.setAttribute('aria-pressed',Number(button.dataset.sourceSheet)===active));
  content.querySelector('#pc-sheet-prev').disabled=active===0;content.querySelector('#pc-sheet-next').disabled=active===sheets.length-1;
  content.querySelector('#pc-sheet-counter').textContent=(active+1)+' / '+sheets.length;content.querySelector('#pc-sheet-scale').textContent='По размеру окна';
  status.textContent='Загрузка исходного листа…';status.dataset.error='false';
  image.onload=()=>{if(image.getAttribute('src')!==sheet.imageUrl)return;image.hidden=false;image.dataset.ready='true';status.textContent='';};
  image.onerror=()=>{status.textContent='Не удалось загрузить лист. Нажмите «Повторить» или скачайте оригинальный PDF.';status.dataset.error='true';};
  image.src=sheet.imageUrl;
 }
 function showRequested(){
  if(!requested||requested.productId!==productId||loadedFor!==productId)return;
  const target=requested;requested=null;
  const index=sheets.findIndex(s=>s.sourceId===target.sourceId&&s.pdfPage===target.pdfPage);
  if(index>=0){active=index;display();return;}
  const status=content.querySelector('#pc-sheet-status');
  if(status){status.textContent='Связь с запрошенным листом PDF '+target.pdfPage+' не подтверждена для этого изделия.';status.dataset.error='true';}
 }
 function openSource(key,sourceId,pdfPage){
  if(!key||!window.CalcZhBIWorkspace)return;
  requested={productId:key,sourceId,pdfPage};
  window.CalcZhBIWorkspace.select(key,'sheets');showRequested();
 }
 function scale(value){zoom=Math.max(0,Math.min(4,value));const stage=content.querySelector('.pc-sheet-stage');stage.dataset.zoom=zoom?'custom':'fit';stage.style.setProperty('--sheet-zoom',String(zoom||1));content.querySelector('#pc-sheet-scale').textContent=zoom?Math.round(zoom*100)+'%':'По размеру окна';if(!zoom)stage.scrollTo(0,0);}
 async function load(){
  if(!productId||panel.hidden||loadedFor===productId)return;
  const key=productId,token=++revision;content.innerHTML='<p class="pc-context" role="status">Загрузка исходных листов…</p>';
  try{
   const result=await api.request('/calc/api/products/'+key+'/source-sheets');if(token!==revision||productId!==key)return;
   loadedFor=key;sheets=result.sheets;active=Math.max(0,sheets.findIndex(s=>s.id===selected.get(key)));
   if(!sheets.length){content.innerHTML=`<h3>Исходные листы</h3><p class="pc-context">${esc(result.note)}</p><button type="button" data-view="sources">Добавить проектные файлы</button>`;return;}
   content.innerHTML=`<div class="pc-sheet-layout"><aside class="pc-sheet-list" aria-label="Листы изделия"><h3>Исходные листы</h3><p class="pc-context">${esc(result.note)}</p>${sheets.map((s,i)=>`<button type="button" data-source-sheet="${i}" aria-pressed="false"><strong>${esc(s.titles.join(' · '))}</strong><span>${s.sheet?'Лист '+esc(s.sheet)+' · ':''}PDF стр. ${s.pdfPage}</span></button>`).join('')}${result.unresolved.length?`<div class="pc-sheet-unresolved"><strong>Требует уточнения</strong>${result.unresolved.map(s=>`<p>${esc(s)}</p>`).join('')}</div>`:''}</aside><section class="pc-sheet-preview" aria-label="Просмотр исходного листа"><div class="pc-sheet-heading"><h3 id="pc-sheet-title"></h3><p id="pc-sheet-location" class="pc-context"></p></div><div class="pc-sheet-toolbar"><button id="pc-sheet-prev" type="button" aria-label="Предыдущий исходный лист">←</button><span id="pc-sheet-counter" class="pc-context"></span><button id="pc-sheet-next" type="button" aria-label="Следующий исходный лист">→</button><button id="pc-sheet-fit" type="button">Вписать</button><button id="pc-sheet-minus" type="button" aria-label="Уменьшить исходный лист">−</button><span id="pc-sheet-scale" class="pc-context"></span><button id="pc-sheet-plus" type="button" aria-label="Увеличить исходный лист">+</button><a id="pc-sheet-original" download>Скачать PDF</a></div><div class="pc-sheet-stage" tabindex="0" role="region" aria-label="Исходный чертёж. После увеличения лист можно прокручивать."><img hidden alt=""></div><div class="pc-sheet-status"><span id="pc-sheet-status" class="pc-context" role="status" aria-live="polite"></span><button id="pc-sheet-retry" type="button">Повторить</button></div></section></div>`;
   content.querySelector('#pc-sheet-prev').addEventListener('click',()=>{if(active>0){active--;display();}});
   content.querySelector('#pc-sheet-next').addEventListener('click',()=>{if(active<sheets.length-1){active++;display();}});
   content.querySelector('#pc-sheet-fit').addEventListener('click',()=>scale(0));content.querySelector('#pc-sheet-plus').addEventListener('click',()=>scale(zoom?zoom+.5:1.5));content.querySelector('#pc-sheet-minus').addEventListener('click',()=>scale(zoom>1?zoom-.5:0));content.querySelector('#pc-sheet-retry').addEventListener('click',display);
   display();showRequested();
  }catch(error){if(token!==revision)return;loadedFor=null;content.innerHTML=`<p role="status">${esc(error.message)}</p><button type="button" data-sheet-retry>Повторить загрузку листов</button>`;}
 }
 content.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.sourceSheet!==undefined){active=Number(b.dataset.sourceSheet);display();}if(b.hasAttribute('data-sheet-retry'))void load();});
 // The app changes panel.hidden on its root listener; the document listener runs afterwards.
 document.addEventListener('click',e=>{if(e.target.closest('#precast-concept [data-view="sheets"]'))void load();});
 document.addEventListener('click',e=>{
  const link=e.target.closest('#precast-concept a[href]');if(!link||link.hasAttribute('download'))return;
  const url=new URL(link.href,location.href),match=url.pathname.match(/^\/api\/document-source\/([^/]+)$/);
  const pdfPage=Number(new URLSearchParams(url.hash.slice(1)).get('page'));
  if(url.origin!==location.origin||!match||!Number.isInteger(pdfPage)||pdfPage<1)return;
  e.preventDefault();openSource(link.dataset.sourceProduct||window.CalcZhBIProjectKey,decodeURIComponent(match[1]),pdfPage);
 });
 window.addEventListener('calczhbi:product',e=>{if(productId===e.detail)return;productId=e.detail;loadedFor=null;revision++;void load();});
 if(window.CalcZhBIProjectKey)productId=window.CalcZhBIProjectKey;
})();
