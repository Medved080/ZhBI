// Search each displayed identifier separately. The source's dimensional mark
// (e.g. '1Р 50,5.3.3-6-2') is not the list alias ('1Р2').
function matchesProductName(product, query){
 const normalize=value=>String(value??'').toLocaleLowerCase('ru-RU').replace(/\s/g,'');
 const term=normalize(query);
 return !term || [product.name,product.documentModel?.alias].some(value=>normalize(value).includes(term));
}

(async()=>{
 const root=document.getElementById('precast-concept');
 const q=s=>root.querySelector(s),api=window.CalcZhBIAPI;
 const readJSON=key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
 let workspace,user,migrationMapping=null;
 try{
  user=await api.ready();workspace=await api.request('/calc/api/workspace?lite=1');q('#pc-project-context').textContent=workspace.project.name+(workspace.project.linked?'':' · не привязан к проекту ЖБИ');
  const legacy=readJSON('calczhbi-workspace-v1');
  const migrationKey='calczhbi-migrated-'+workspace.installationId;
  const migrated=readJSON(migrationKey);
  if(legacy&&!migrated&&user.role!=='viewer'){
   let browserId=localStorage.getItem('calczhbi-browser-id');if(!browserId){browserId=crypto.randomUUID();localStorage.setItem('calczhbi-browser-id',browserId);}
   const legacyProducts=legacy.products||workspace.products.map(entry=>entry.product);
   const response=await api.request('/calc/api/migrate-browser',{method:'POST',body:JSON.stringify({browserId,products:legacyProducts.map((product,i)=>({product:{...product,source:product.source||'excel'},extra:legacy.extra?.[i]||[],overrides:legacy.overrides?.[i]||{},legacyKey:'product-'+i}))})});
   migrationMapping=response.mapping;localStorage.setItem(migrationKey,JSON.stringify(migrationMapping));workspace=await api.request('/calc/api/workspace?lite=1');
   q('#pc-migration-status').textContent='Изделия перенесены из браузера в БД.';
  }else migrationMapping=migrated;
 }catch(error){q('#pc-save-status').textContent=error.message;q('#pc-title').textContent='Сервер недоступен';q('#pc-save-retry').hidden=false;q('#pc-save-retry').addEventListener('click',()=>location.reload());return;}
 const profile=Object.fromEntries(Object.entries(workspace.profile).map(([key,value])=>[key,Number(value)]));
 const products=workspace.products.map(entry=>entry.product);
 const detailLoading=new Set();
 const storageKey='calczhbi-ui-'+workspace.installationId+'-'+user.id;
 const saved=readJSON(storageKey);
 const selected=Array.isArray(saved?.selectedIds)?saved.selectedIds.map(id=>products.findIndex(p=>p.id===id)).filter(i=>i>=0):[];
 const active=products.findIndex(p=>p.id===saved?.activeId);
 // Глубокая ссылка из ЖБИ: /calc/#product=<id изделия> (app/calc/marks.py определяет изделие по марке элемента).
 const linkedId=new URLSearchParams(location.hash.slice(1)).get('product')||window.frameElement?.dataset?.calcProduct,linkedIndex=linkedId?products.findIndex(p=>p.id===linkedId):-1;
 window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('product');if(id)window.CalcZhBIWorkspace?.select(id,'calculation');});
 const state={product:linkedIndex>=0?linkedIndex:active>=0?active:0,overrides:workspace.products.map(entry=>entry.overrides),extra:workspace.products.map(entry=>entry.extra),selected:[...new Set(selected)],exporting:false,batch:Boolean(saved?.batch),showConcrete:true,showSteel:true,opacity:30,search:linkedIndex<0&&typeof saved?.search==='string'?saved.search:'',filter:linkedIndex<0&&typeof saved?.filter==='string'?saved.filter:'',grouping:['album','type','none'].includes(saved?.grouping)?saved.grouping:'album',openGroups:new Set(Array.isArray(saved?.openGroups)?saved.openGroups:[]),searchClosedGroups:new Set()};
 window.CalcZhBIAssistantContext=()=>({userId:user.id,title:"Калькулятор ЖБИ",label:"Калькулятор · "+(products[state.product]?.name||""),
  page:{text:JSON.stringify({project:workspace.project.name,product:products[state.product],section:root.dataset.section}).slice(0,12000)}});
 let recoveryPreview=null;
 window.CalcZhBIRecoveryUI={
  selection(scope){
   const indices=scope==='active'?[state.product]:scope==='selected'?state.selected:scope==='visible'?visibleProducts().map(x=>x.i):products.map((p,i)=>({p,i})).filter(({p})=>readiness(p).status!=='complete').map(x=>x.i);
   return indices.map(i=>products[i]).filter(p=>p.documentModelId).map(p=>({id:p.id,name:p.name}));
  },
  async preview(result){await flushSaves();const i=products.findIndex(p=>p.id===result.productId);if(i<0)return;state.product=i;recoveryPreview=result;calculation.classList.remove('pc-calculation-expanded');updateCalculationExpand();render();q('.pc-tabs [data-view="model"]').click();},
  async published(result){await flushSaves();const i=products.findIndex(p=>p.id===result.productId);if(i<0)return;const entry=await api.request('/calc/api/products/'+result.productId);products[i]=entry.product;state.overrides[i]=entry.overrides;state.extra[i]=entry.extra;acknowledged.set(result.productId,fingerprint(i));recoveryPreview=null;render();}
 };
 q('#pc-recovery-return').addEventListener('click',()=>{recoveryPreview=null;render();});
 const money=window.CalcZhBIMoney.format;
 const number=(n,digits=3)=>n==null?'Не указан':n.toLocaleString('ru-RU',{maximumFractionDigits:digits});
 const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const writeable=user.role!=='viewer',jobs=new Map(),acknowledged=new Map(),draftKey='calczhbi-drafts-'+workspace.installationId+'-'+user.id;
 function payload(index){const p=products[index];return {product:{id:p.id,name:p.name,concreteClass:p.concreteClass||'В50',volume:p.volume,weight:p.weight,hours:p.hours,concreteRate:p.concreteRate,otherMaterials:p.otherMaterials??p.material-p.volume*p.concreteRate,geometry:p.geometry||null,volumeFromGeometry:Boolean(p.volumeFromGeometry),source:p.source||'excel',documentModelId:p.documentModelId||null},overrides:state.overrides[index],extra:state.extra[index]};}
 const fingerprint=index=>JSON.stringify(payload(index));
 products.forEach((p,i)=>acknowledged.set(p.id,fingerprint(i)));
 function saveStatus(message,error=false){q('#pc-save-status').textContent=message;q('#pc-save-status').title=message;q('#pc-save-status').dataset.error=String(error);q('#pc-save-retry').hidden=!error;}
 function backupDrafts(){try{const drafts={};for(const [id,job] of jobs){const i=products.findIndex(p=>p.id===id);drafts[id]={...payload(i),expectedVersion:products[i].version||0,request:job.request||null};}localStorage.setItem(draftKey,JSON.stringify(drafts));}catch{saveStatus('Не удалось записать локальный черновик. Сохраните данные на сервере перед закрытием.',true);}}
 function pendingStatus(){if([...jobs.values()].some(j=>j.error))return;saveStatus(jobs.size?'Есть несохранённые изменения':'Сохранено на сервере');}
 function persist(){
  try{localStorage.setItem(storageKey,JSON.stringify({activeId:products[state.product].id,selectedIds:state.selected.map(i=>products[i].id),grouping:state.grouping,search:state.search,filter:state.filter,openGroups:[...state.openGroups],scrollTop:q('#pc-products').scrollTop,batch:state.batch,...window.CalcZhBIUI.preferences()}));}catch{}
  if(!writeable)return;
  const i=state.product,id=products[i].id,current=fingerprint(i),old=jobs.get(id);
  if(current===(old?.fingerprint||acknowledged.get(id)))return;
  const job=old||{revision:0,promise:null,request:null,error:null};job.revision++;job.fingerprint=current;jobs.set(id,job);clearTimeout(job.timer);
  if(!job.error)job.timer=setTimeout(()=>void saveProduct(id).catch(()=>{}),500);
  backupDrafts();pendingStatus();
 }
 let conflictId=null;
 function showConflict(id){const job=jobs.get(id);if(!job?.conflict)return;conflictId=id;const i=products.findIndex(p=>p.id===id);document.getElementById('pc-conflict-description').textContent=products[i].name+': моя сумма '+money(calculate(i).total)+' ₽, на сервере '+money(job.conflict.snapshot.total)+' ₽. Серверная версия: '+job.conflict.product.version+'.';const dialog=document.getElementById('pc-conflict-dialog');if(!dialog.open)dialog.showModal();}
 async function saveProduct(id){
  const job=jobs.get(id);if(!job)return;if(job.promise)return job.promise;if(job.conflict){showConflict(id);throw new Error('Разрешите конфликт версий изделия.');}
  clearTimeout(job.timer);const i=products.findIndex(p=>p.id===id);const revision=job.revision;
  job.request??={...structuredClone(payload(i)),expectedVersion:products[i].version||0,requestId:crypto.randomUUID()};
  const sentFingerprint=JSON.stringify({product:job.request.product,overrides:job.request.overrides,extra:job.request.extra});backupDrafts();saveStatus('Сохраняю на сервер…');
  job.promise=(async()=>{
   try{
    const response=await api.request('/calc/api/products',{method:'POST',body:JSON.stringify(job.request)});
    acknowledged.set(id,sentFingerprint);products[i].version=response.product.version;job.request=null;job.error=null;
    if(fingerprint(i)===sentFingerprint){Object.assign(products[i],response.product);acknowledged.set(id,fingerprint(i));jobs.delete(id);if(state.product===i)totals();window.dispatchEvent(new CustomEvent('calczhbi:saved'));}
   }catch(error){job.error=error;saveStatus(error.message,true);if(error.status===409&&error.detail?.current){job.conflict=error.detail.current;showConflict(id);}if(error.status===401)void api.ready().then(()=>flushSaves()).catch(()=>{});throw error;}
   finally{job.promise=null;backupDrafts();pendingStatus();}
  })();
  await job.promise;
  if(jobs.has(id)&&!job.error)return saveProduct(id);
 }
 async function flushSaves(){for(const id of [...jobs.keys()])await saveProduct(id);}
 window.CalcZhBIFlushSaves=flushSaves;
 q('#pc-save-retry').addEventListener('click',()=>{const conflict=[...jobs.keys()].find(id=>jobs.get(id).conflict);if(conflict)showConflict(conflict);else void flushSaves().catch(()=>{});});
 for(const choice of ['server','mine'])document.getElementById('pc-conflict-'+choice).addEventListener('click',()=>{
  const id=conflictId,job=jobs.get(id);if(!job?.conflict)return;const i=products.findIndex(p=>p.id===id),remote=job.conflict;
  if(choice==='server'){try{localStorage.setItem(draftKey+'-last-discarded',JSON.stringify(payload(i)));}catch{}products[i]=remote.product;state.overrides[i]=remote.overrides;state.extra[i]=remote.extra;jobs.delete(id);acknowledged.set(id,fingerprint(i));render();backupDrafts();pendingStatus();}
  else{products[i].version=remote.product.version;job.request=null;job.conflict=null;job.error=null;job.revision++;void saveProduct(id).catch(()=>{});}
  document.getElementById('pc-conflict-dialog').close();conflictId=null;
 });
 q('#pc-current-user').textContent=user.displayName+(user.local?'':' · '+({admin:'администратор',editor:'редактор',viewer:'просмотр'}[user.role]));q('#pc-logout').hidden=user.local||Boolean(window.frameElement?.dataset?.calcEmbed);q('#pc-logout').addEventListener('click',()=>void flushSaves().then(()=>api.logout()).catch(error=>saveStatus(error.message,true)));
 if(!writeable){q('#pc-edit-product').hidden=true;q('#pc-verify-product').hidden=true;q('#pc-verify-selected').hidden=true;q('#pc-add').hidden=true;q('#pc-clear').hidden=true;}
 window.addEventListener('beforeunload',event=>{if(jobs.size){event.preventDefault();event.returnValue='';}});
 const albumNames={doc01:'Колонны · нижние',doc02:'Колонны · средние, ч. 1',doc03:'Колонны · средние, ч. 2',doc04:'Колонны · верхние',doc05:'Колонны · АБК',doc06:'Ригели · 6.9',doc07:'Ригели · 6.6',doc08:'Ригели · 4.6.5 / 4.4.5',doc09:'Ригели · АБК',doc10:'Плиты · корпус',doc11:'Плиты · АБК',doc12:'Подъёмники',doc13:'Шахты лифтов',doc14:'Лестничные балки',doc15:'Цокольные панели'};
 const albumOptions=[...new Map(products.filter(p=>p.documentModel?.source.id).map(p=>[p.documentModel.source.id,{family:p.documentModel.family,title:p.documentModel.source.title}])).entries()];
 q('#pc-product-filter').innerHTML='<option value="">Все альбомы</option>'+albumOptions.map(([id,doc])=>`<option value="${escapeHTML(id)}">${escapeHTML(albumNames[id]||doc.family)}</option>`).join('');
 function visibleProducts(){return products.map((p,i)=>({p,i})).filter(({p})=>(!state.filter||(p.documentModel?.source.id||(p.documentModelId?'doc02':''))===state.filter)&&matchesProductName(p,state.search));}
 const readiness=p=>p.documentModel?.modelReadiness||{status:'missing',label:'Модель не построена',description:'Нет индивидуальной проектной модели; условная геометрия не считается полной.'};
 async function openModelResults(){
  const dialog=q('#pc-model-results-dialog'),host=q('#pc-model-results-content');host.textContent='Собираю результаты…';dialog.showModal();
  try{
   const result=await api.request('/calc/api/model-results');
   host.innerHTML=`<p class="pc-context">${escapeHTML(result.limitation)}</p><div class="pc-results-grid">${result.groups.map(group=>`<section class="pc-result-group"><div class="pc-context">${escapeHTML(group.name)}</div><div class="pc-result-total">${group.models.length} <span>моделей</span></div><div class="pc-context">Полных: ${group.models.filter(m=>m.status==='complete').length} · Частичных: ${group.models.filter(m=>m.status==='partial').length}</div>${group.capturedAt?`<p class="pc-context">Собрано ${escapeHTML(new Date(group.capturedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}))} МСК</p>`:''}<div class="pc-result-marks">${group.models.map(model=>`<button type="button" data-result-product="${escapeHTML(model.productId)}" aria-label="Открыть 3D ${escapeHTML(model.alias)}" title="${escapeHTML(model.label)}"><span>${escapeHTML(model.alias)}</span><span class="pc-model-indicator" data-model-status="${model.status}">${model.status==='complete'?'✓':'◐'}</span></button>`).join('')}</div><details><summary>Отчёт исполнителя</summary><pre>${escapeHTML(group.report)}</pre></details></section>`).join('')}</div>`;
  }catch(error){host.textContent=error.message;}
 }
 q('#pc-model-results-close').addEventListener('click',()=>q('#pc-model-results-dialog').close());
 // Статусы изделия в списке и что они значат (подсказка на значке): Нет данных → Нет цены → Предварительно → Готово
 const STATUS_TIPS={
  'Нет данных':'Не хватает объёма или класса бетона: стоимость посчитать нельзя. Данные берутся с листов чертежей; недостающее вводится в форме «Изменить параметры изделия» или в «Цены и нормы» → «Класс бетона по типам изделий».',
  'Нет цены':'Не задана цена хотя бы одного материала изделия или бетона его класса (цена 0). Задайте её в «Цены и нормы» → «Цены»: когда цены на все материалы изделия заданы, статус сменится на «Предварительно», а в калькуляции появится полная стоимость.',
  'Предварительно':'Цены заданы, но нормы группы ещё не подтверждены технологом и/или изделие не проверено по чертежу. Статус станет «Готово», когда выполнены оба условия.',
  'Готово':'Цены на все материалы заданы, нормы группы подтверждены технологом, изделие проверено по чертежу.',
  'Расчёт':'Изделие из исходного Excel: расчёт по его собственным нормам.',
 };
 function productRow({p,i}){
  const label=p.documentModel?.alias||p.name,details=p.name+' · '+(p.concreteClass||'класс не указан')+' · '+(p.volume?number(p.volume)+' м³':'объём не подтверждён');
  const missingData=!p.volume||!p.concreteClass||/не указан/i.test(p.concreteClass),missingPrice=(p.documentModel?.resources||[]).some(r=>Number(r.rate)===0)||Number(p.concreteRate)===0;
  const registry=p.documentModel?.kind==='registry',normsConfirmed=(workspace.settings?.normGroups||[]).includes(p.documentModel?.family||'Вне каталога');
  const status=missingData?'Нет данных':missingPrice?'Нет цены':registry?(normsConfirmed&&p.verification?'Готово':'Предварительно'):'Расчёт';
  const model=readiness(p),mark=model.status==='complete'?'✓':model.status==='partial'?'◐':'';
  const badge=mark?`<span class="pc-model-indicator" data-model-status="${model.status}" title="${escapeHTML('3D-модель: '+model.label+'. '+model.description)}">3D ${mark}</span>`:'';
  return `<div class="pc-product-row"><input class="pc-export-check" type="checkbox" data-select-product="${i}" aria-label="Включить ${escapeHTML(p.name)} в выгрузку"><button class="pc-product cursor-interaction" data-product="${i}" aria-label="${escapeHTML(p.name+' · '+status+(mark?' · 3D-модель: '+model.label:''))}" title="${escapeHTML(details)}" aria-pressed="${state.product===i}"><strong>${escapeHTML(label)}</strong><span class="pc-row-badges">${badge}<span class="pc-row-status" data-attention="${missingData||missingPrice}" title="${escapeHTML(STATUS_TIPS[status])}">${status}</span></span></button></div>`;
 }
 function productGroups(visible){
  const groups=new Map();
  for(const row of visible){
   const doc=row.p.documentModel,album=doc?.source.id||(doc?'doc02':'manual');
   const key=state.grouping==='album'?album:(doc?.family||(doc?'Колонны':'Прочие изделия'));
   if(!groups.has(key))groups.set(key,{key,title:state.grouping==='album'?(albumNames[album]||doc?.source.title||'Без альбома'):key,rows:[]});
   groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a,b)=>a.key.localeCompare(b.key,'ru',{numeric:true}));
 }
 function renderProducts(){
  const list=q('#pc-products'),scroll=list.scrollTop,focused=document.activeElement;
  const focusKey=list.contains(focused)?['data-product','data-product-group','data-select-product'].find(key=>focused.hasAttribute(key)):null;
  const focusValue=focusKey?focused.getAttribute(focusKey):null;
  const visible=visibleProducts();
  const search=Boolean(state.search.trim());
  q('#pc-products').innerHTML=!visible.length?'<div class="pc-product-empty">Изделия не найдены</div>':state.grouping==='none'?visible.map(productRow).join(''):productGroups(visible).map((g,n)=>{
   const open=search?!state.searchClosedGroups.has(g.key):state.openGroups.has(g.key);
   return `<section class="pc-product-group"><button class="pc-group-toggle" data-product-group="${escapeHTML(g.key)}" aria-expanded="${open}" aria-controls="pc-group-${n}" title="${escapeHTML(g.title+' · '+g.rows.length+' изделий')}"><span class="pc-group-arrow" aria-hidden="true">${open?'▾':'▸'}</span><span class="pc-group-title">${escapeHTML(g.title)}</span><span class="pc-group-count">${g.rows.length}</span></button><div class="pc-group-products" id="pc-group-${n}" ${open?'':'hidden'}>${open?g.rows.map(productRow).join(''):''}</div></section>`;
  }).join('');
  q('#pc-product-count').textContent=(state.search||state.filter?'Найдено ':'Всего ')+visible.length+(visible.length===products.length?' изделий':' из '+products.length);
  q('#pc-search-clear').hidden=!state.search;
  q('#pc-catalog-active').textContent=visible.some(({i})=>i===state.product)?'Открыто: '+(products[state.product].documentModel?.alias||products[state.product].name):'Изделие вне фильтра';
  list.scrollTop=scroll;
  if(focusKey)[...list.querySelectorAll('['+focusKey+']')].find(el=>el.getAttribute(focusKey)===focusValue)?.focus({preventScroll:true});
  updateSelection();
 }
 q('#pc-product-search').value=state.search;
 if(!albumOptions.some(([id])=>id===state.filter))state.filter='';
 q('#pc-product-filter').value=state.filter;
 if(!Array.isArray(saved?.openGroups)||linkedIndex>=0){const group=productGroups(products.map((p,i)=>({p,i}))).find(g=>g.rows.some(({i})=>i===state.product));if(group)state.openGroups.add(group.key);}
 q('#pc-product-grouping').value=state.grouping;
 q('#pc-product-grouping').addEventListener('change',e=>{state.grouping=e.target.value;state.openGroups.clear();state.searchClosedGroups.clear();const activeGroup=productGroups(products.map((p,i)=>({p,i}))).find(g=>g.rows.some(({i})=>i===state.product));if(activeGroup)state.openGroups.add(activeGroup.key);renderProducts();persist();});
 q('#pc-product-search').addEventListener('input',e=>{state.search=e.target.value;state.searchClosedGroups.clear();renderProducts();q('#pc-products').scrollTop=0;persist();});
 q('#pc-product-filter').addEventListener('change',e=>{state.filter=e.target.value;renderProducts();q('#pc-products').scrollTop=0;persist();});
 q('#pc-search-clear').addEventListener('click',()=>{state.search='';q('#pc-product-search').value='';state.searchClosedGroups.clear();renderProducts();persist();q('#pc-product-search').focus();});
 q('#pc-batch-toggle').addEventListener('click',()=>{state.batch=!state.batch;updateSelection();persist();});
 q('#pc-selection-clear').addEventListener('click',()=>{state.selected=[];updateSelection();persist();});
 q('#pc-reveal-product').addEventListener('click',()=>{state.search='';state.filter='';q('#pc-product-search').value='';q('#pc-product-filter').value='';const g=productGroups(products.map((p,i)=>({p,i}))).find(g=>g.rows.some(({i})=>i===state.product));if(g)state.openGroups.add(g.key);renderProducts();q('[data-product="'+state.product+'"]').scrollIntoView({block:'nearest'});persist();});
 let catalogScrollTimer;
 q('#pc-products').addEventListener('scroll',()=>{clearTimeout(catalogScrollTimer);catalogScrollTimer=setTimeout(persist,150);});
 window.addEventListener('calczhbi:ui-change',persist);
 window.addEventListener('calczhbi:view',persist);
 const calculation=q('#pc-calculation'),expandCalculation=q('#pc-calculation-expand');
 function updateCalculationExpand(){const expanded=calculation.classList.contains('pc-calculation-expanded');expandCalculation.textContent=expanded?'Свернуть':'Развернуть';expandCalculation.setAttribute('aria-label',expanded?'Свернуть калькуляцию':'Развернуть калькуляцию');expandCalculation.setAttribute('aria-expanded',String(expanded));calculation.setAttribute('role',expanded?'dialog':'region');if(expanded)calculation.setAttribute('aria-modal','true');else calculation.removeAttribute('aria-modal');}
 expandCalculation.addEventListener('click',()=>{calculation.classList.toggle('pc-calculation-expanded');updateCalculationExpand();expandCalculation.focus();});
 document.addEventListener('keydown',e=>{
  if(!calculation.classList.contains('pc-calculation-expanded')||document.querySelector('dialog[open]'))return;
  if(e.key==='Escape'){calculation.classList.remove('pc-calculation-expanded');updateCalculationExpand();expandCalculation.focus();}
  if(e.key==='Tab'){
   const controls=[...calculation.querySelectorAll('button:not([disabled]),input:not([disabled]),[tabindex="0"],a[href]')].filter(el=>el.getClientRects().length);
   const first=controls[0],last=controls.at(-1);
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
 });
 function updateSelection(){
  root.querySelectorAll('[data-select-product]').forEach(el=>{el.checked=state.selected.includes(Number(el.dataset.selectProduct));});
  const visible=visibleProducts().map(x=>x.i),count=visible.filter(i=>state.selected.includes(i)).length;q('#pc-select-all').checked=visible.length>0&&count===visible.length;q('#pc-select-all').indeterminate=count>0&&count<visible.length;q('#pc-select-all').disabled=!visible.length;
  q('#pc-selected-count').textContent='Выбрано: '+state.selected.length;
  q('#pc-export').disabled=state.selected.length===0||state.exporting;
  q('#pc-export').textContent='XLSX · '+state.selected.length;
  {const vb=q('#pc-verify-selected');vb.disabled=state.selected.length===0;vb.textContent='Проверено · '+state.selected.length;}
  q('#pc-export-one').disabled=state.exporting;
  root.dataset.batch=String(state.batch);
  q('.pc-select-all').hidden=!state.batch;
  q('.pc-export-actions').hidden=!state.batch;
  q('#pc-active-context').hidden=state.batch;
  q('#pc-batch-toggle').setAttribute('aria-pressed',String(state.batch));
 }
 function exportStatus(message,error=false){const el=q('#pc-export-status');el.textContent=message;el.dataset.error=String(error);}
 function model(){
  const p=products[state.product];
  if(recoveryPreview?.productId!==p.id)recoveryPreview=null;
  q('#pc-recovery-return').hidden=!recoveryPreview;
  window.CalcZhBIModelSpec={productKey:p.id,geometry:p.geometry||null,documentModelId:p.displayModelId||p.documentModelId||null,registry:p.documentModel?.kind==='registry',solidModel:Boolean(p.documentModel?.solidModel),preview3d:p.documentModel?.preview3d||null,sourceUrl:p.documentModel?.source.id?'/calc/api/document-source/'+p.documentModel.source.id+'#page='+p.documentModel.source.productPage:null,showConcrete:state.showConcrete,showSteel:state.showSteel,opacity:state.opacity};
  if(recoveryPreview)Object.assign(window.CalcZhBIModelSpec,{documentModelId:recoveryPreview.drawing.id,drawingOverride:recoveryPreview.drawing,registry:false,solidModel:true,modelKey:recoveryPreview.sha256});
  window.dispatchEvent(new CustomEvent('calczhbi:model',{detail:window.CalcZhBIModelSpec}));
  if(recoveryPreview){q('#pc-steel').disabled=false;q('#pc-model-caption').textContent='Кандидат Qwen · не подключён · частичная сборка, требуется сверка';q('#pc-model-readiness').textContent='Кандидат · частичная';q('#pc-model-readiness').dataset.modelStatus='partial';return;}
  q('#pc-steel').disabled=Boolean(!p.documentModel?.solidModel&&p.documentModel?.preview3d&&!p.documentModel.preview3d.reinforcementGroups?.length);
  q('#pc-model-caption').textContent=p.documentModel?.preview3d?(p.documentModel.preview3d.reinforcementStatus==='partial'?'По чертежам · '+p.documentModel.preview3d.reinforcementGroups.length+' групп · есть детали, требующие уточнения':p.documentModel.preview3d.shape==='outline-slab'?'3D-контур по чертежу · армирование — см. исходные листы':'Габаритный 3D-эскиз · детали и армирование — см. исходные листы'):p.documentModel?.kind==='registry'?'Изделие из КЖИ · 3D и расположение арматуры ещё не восстановлены':p.documentModel?'По чертежам КЖИ · '+p.documentModel.cage+' · гибы показаны упрощённо':p.geometry?'Контур по заданным габаритам · армирование условное':'Условная геометрия и армирование · нужны проектные данные';
  if(p.documentModel?.solidModel)q('#pc-model-caption').textContent='Индивидуальная модель · частичная сборка, есть нерешённые вопросы';
 }
 function rowData(productIndex=state.product){
  const p=products[productIndex],m=p.material,l=p.labour;
  const resources=p.documentModel?.resources||[],resourceAmount=resources.reduce((sum,r)=>sum+r.qty*Number(r.rate),0);
  return [
   {id:'concrete',name:'Бетон '+(p.concreteClass||'В50'),unit:'м³',qty:p.volume,rate:p.concreteRate??profile.defaultConcreteRate,detail:p.documentModel?.kind==='registry'?'Проектный объём × коэффициент производственного расхода из раздела норм. Сверить распознанный объём с чертежом.':p.documentModel?'По проекту: '+number(p.documentModel.projectVolume)+' м³. Расход для калькуляции: '+number(p.volume)+' м³, из Excel с производственным припуском.':'Объём изделия × цена бетона без НДС. Объём и цену можно задать в параметрах изделия.'},
   ...resources.map(r=>({...r,rate:Number(r.rate),detail:(Number(r.rate)===0?'Цена не задана в разделе «Расценки и нормы»: стоимость изделия занижена. ':'')+'По проекту: '+number(r.projectQty,5)+' '+r.unit+'. Для калькуляции: '+number(r.qty)+' '+r.unit+(p.documentModel?.kind==='registry'?'. Проектный расход распознан из спецификации; производственный расход рассчитан по доступным нормам. Сверить количество и класс стали.':'. Расход и цена перенесены из Excel; припуски и округление сохранены. Измените соседние поля для своей калькуляции.')})),
   {id:'rest',name:resources.length?'Прочие материалы':'Арматура и прочие материалы',unit:'компл.',qty:1,rate:(p.otherMaterials??Math.max(0,m-p.volume*(p.concreteRate??profile.defaultConcreteRate)))-resourceAmount,detail:p.documentModel?.kind==='registry'?(p.documentModel?.readings?.embeddedChecked?'Предварительный резерв 1% стоимости известных материалов, по исходному Excel. Закладные, трубы и петли учтены по чтению листа и не подтверждены человеком: сверить со спецификацией.':'Предварительный резерв 1% стоимости известных материалов, по исходному Excel. Закладные и трубы необходимо дополнить по проверенной спецификации.'):resources.length?'Остаток стоимости прочих материалов после выделения арматуры, проволоки и труб. В исходном Excel — 1% материалов.':'Сводная стоимость материалов кроме бетона. Арматурные позиции и закладные требуют проектной спецификации.'},
   {id:'labour',name:'Производственный труд',unit:'чел·ч',qty:p.hours,rate:p.normsLabourRate??profile.labourRate,detail:'Стоимость часа — из раздела «Расценки и нормы».'},
   {id:'soc',name:'Страховые взносы',unit:'%',qty:profile.socialPercent,rate:l/100,detail:'Начисление от оплаты труда — правило профиля.'},
   {id:'energy',name:'Энергоуслуги',unit:'%',qty:profile.energyPercent,rate:m/100,detail:'Начисление от материалов — правило профиля.'},
   {id:'overhead',name:'Общепроизводственные',unit:'%',qty:profile.overheadPercent,rate:m/100,detail:'Начисление от материалов — правило профиля.'},
   {id:'admin',name:'Административные',unit:'%',qty:profile.adminPercent,rate:m/100,detail:'Начисление от материалов — правило профиля.'},
   {id:'commercial',name:'Коммерческие',unit:'%',qty:profile.commercialPercent,rate:m/100,detail:'Начисление от материалов — правило профиля.'},
   ...state.extra[productIndex],
   {id:'profit',name:'Прибыль при марже '+profile.profitPercent+'%',unit:'%',qty:profile.profitPercent,rate:(m+l+l*profile.socialPercent/100+m*(profile.energyPercent+profile.overheadPercent+profile.adminPercent+profile.commercialPercent)/100+state.extra[productIndex].reduce((sum,row)=>sum+row.qty*row.rate,0))/(1-profile.profitPercent/100)/100,detail:'Прибыль считается как маржа до отдельной доставки.'},
   {id:'delivery',name:'Доставка',unit:'%',qty:profile.deliveryPercent,rate:m/100,detail:'Начисление от материалов — правило профиля.'}
  ];
 }
 function getValue(id,field,base,productIndex=state.product){const v=state.overrides[productIndex][id]?.[field];return v===undefined||v===''?base:Number(v);}
 function calculate(productIndex){
  const rows=rowData(productIndex);const amounts={};const bases={};const results=[];let total=0,cost=0,baseTotal=0;
  for(const row of rows){
   let rate=row.rate;
   if(row.id==='soc')rate=amounts.labour/100;
   if(['energy','overhead','admin','commercial','delivery'].includes(row.id))rate=(amounts.concrete+amounts.rest+(products[productIndex].documentModel?.resources||[]).reduce((sum,r)=>sum+amounts[r.id],0))/100;
   if(row.id==='profit'){const pct=getValue(row.id,'qty',profile.profitPercent,productIndex);if(pct>=100)throw new Error(products[productIndex].name+': маржа должна быть меньше 100%.');rate=cost/(1-pct/100)/100;}
   bases[row.id]=rate;
   const qty=getValue(row.id,'qty',row.qty,productIndex),effectiveRate=getValue(row.id,'rate',rate,productIndex);
   const amount=getValue(row.id,'amount',qty*effectiveRate,productIndex);
   if(![row.qty,row.rate,qty,effectiveRate,amount].every(v=>Number.isFinite(v)&&v>=0))throw new Error(products[productIndex].name+': проверьте значения статьи «'+row.name+'».');
   amounts[row.id]=amount;total+=amount;if(!['profit','delivery'].includes(row.id))cost+=amount;
   baseTotal+=row.qty*row.rate;
   results.push({...row,manual:{...state.overrides[productIndex][row.id]},effective:{qty,rate:effectiveRate,amount}});
  }
  return {product:{...products[productIndex]},rows:results,bases,amounts,total,baseTotal};
 }
 function totals(){
  const {rows,bases,amounts,total}=calculate(state.product);
  for(const row of rows){const output=q(`[data-output="${row.id}"]`);if(output)output.textContent=money(amounts[row.id]);for(const field of ['qty','rate','amount']){const input=q(`input[data-id="${row.id}"][data-field="${field}"]`);if(input){input.placeholder=field==='qty'?number(row.qty):money(field==='rate'?bases[row.id]:amounts[row.id]);input.classList.toggle('pc-manual',state.overrides[state.product][row.id]?.[field]!==undefined&&state.overrides[state.product][row.id]?.[field]!=='');}}}
  q('#pc-baseline').textContent=money(products[state.product].price)+' ₽';q('#pc-effective').textContent=money(total)+' ₽';
  const rawDiff=total-products[state.product].price;const diff=Math.abs(rawDiff)<.005?0:rawDiff;q('#pc-delta').textContent=(diff>0?'+':'')+money(diff)+' ₽';q('#pc-vat').textContent='Моя цена с НДС '+profile.vatPercent+'%: '+money(total*(1+profile.vatPercent/100))+' ₽';
 }
 async function exportSelected(single=false){
  const indices=single?[state.product]:[...state.selected];
  const status=(message,error=false)=>{const el=q(single?'#pc-export-one-status':'#pc-export-status');el.textContent=message;el.dataset.error=String(error);};
  if(state.exporting||indices.length===0)return;
  const invalid=root.querySelector('input[data-id]:invalid');if(invalid){invalid.reportValidity();status('Исправьте значение в калькуляции.',true);return;}
  state.exporting=true;updateSelection();q('#pc-export').textContent='Формирую книгу…';status('');
  try{
   await flushSaves();
   const snapshots=await Promise.all(indices.map(i=>api.request('/calc/api/products/'+products[i].id+'/calculation')));
   await window.CalcZhBIExport.download(snapshots);
   status('Книга сформирована. Листов: '+snapshots.length+'.');
  }catch(error){status(error.message||'Не удалось сформировать XLSX. Повторите выгрузку.',true);}
  finally{state.exporting=false;q('#pc-export').textContent='Выгрузить XLSX';updateSelection();}
 }
 function render(){
  const p=products[state.product];q('#pc-title').textContent=p.documentModel?.alias||p.name;q('#pc-card-context').textContent=p.documentModel?.alias?p.name:'Калькуляция изделия';q('#pc-calculation-summary').innerHTML='<span>Бетон: '+(p.volume?number(p.volume)+' м³':'объём не задан')+' · '+escapeHTML(p.concreteClass||'класс не указан')+' · Труд: '+(p.hours?number(p.hours)+' чел·ч':'не задан')+'</span>'+(writeable?'<button id="pc-edit-calculation" type="button">Изменить параметры</button>':'');q('#pc-volume').textContent=number(p.volume)+' м³';q('#pc-weight').textContent=number(p.weight)+' т';q('#pc-hours').textContent=number(p.hours)+' чел·ч';
  const ready=readiness(p);q('#pc-model-readiness').textContent=ready.label;q('#pc-model-readiness').dataset.modelStatus=ready.status;q('#pc-model-readiness').title=ready.description;q('#pc-calculation-product').textContent=p.name;
  window.CalcZhBIProjectKey=p.id;window.dispatchEvent(new CustomEvent('calczhbi:product',{detail:window.CalcZhBIProjectKey}));
  renderProducts();
  q('#pc-property-heading').textContent=p.documentModel?'Проект и калькуляция':p.source==='manual'?'Параметры изделия':'Из калькуляции';
  q('#pc-source-label').textContent=p.documentModel?.kind==='registry'?'КЖИ · предварительно':p.source==='manual'?'Ручной ввод':'Excel МСУ-1';
  q('#pc-weight-label').textContent=p.source==='manual'||p.documentModel?.kind==='registry'?'Арматура':'Арматура, без Вр1';
  if(p.documentModel?.kind==='registry'&&p.documentModel.projectSteel===null)q('#pc-weight').textContent='Не подтверждена';
  {const v=p.verification;      // «проверено человеком»: изделие сверено с чертежом, прочитанные и каталожные значения подтверждены
   q('#pc-verification-state').textContent=v?'Проверено человеком · '+new Date(v.verifiedAt).toLocaleDateString('ru-RU')+(v.note?' · '+v.note:''):'Не проверено человеком: значения из чтения листа и каталога поставщика не подтверждены.';
   q('#pc-verify-product').textContent=v?'Снять отметку проверки':'Отметить: проверено по чертежу';}
  q('#pc-geometry-note').textContent=p.geometry?`${number(p.geometry.length)} × ${number(p.geometry.width)} × ${number(p.geometry.height)} м`:'Габариты не заданы.';
  q('#pc-source-description').textContent=p.source==='manual'?'Источник: параметры введены пользователем. Методика начислений — профиль Excel МСУ-1.':'Источник: «Ресурсная Калькуляция МСУ-1 Колонны.xlsx»';
  q('#pc-geometry-description').textContent=p.geometry?'Внешний контур построен по введённым габаритам прямоугольного изделия. Армирование условное.':'Геометрия и армирование показаны условно: исходный Excel не содержит конструктива.';
  const doc=p.documentModel;q('#pc-project-properties').hidden=!doc;q('#pc-document-info').hidden=!doc;
  const route=q('#pc-tech-panel .pc-route');if(!route.dataset.defaultRoute)route.dataset.defaultRoute=route.innerHTML;
  if(doc){
   const checkedSteel=doc.preview3d?.verifiedSourceSpec?.steelTotalKg,steelDiffers=checkedSteel!=null&&checkedSteel!==doc.projectSteel;
   q('#pc-project-properties').innerHTML=`<dt>Бетон по проекту</dt><dd>${number(doc.projectVolume)} м³</dd><dt>${steelDiffers?'Сталь в каталоге':'Сталь по проекту'}</dt><dd>${number(doc.projectSteel)} кг</dd>${steelDiffers?`<dt>Сталь · сверка листа</dt><dd>${number(checkedSteel)} кг</dd>`:''}`;
   const reading=doc.readings;
   if(reading){
    // автоматически прочитано с листа PDF: что именно взято, откуда, и перечень закладных, труб и петель (для проверки человеком)
    const sheet=reading.sheet||{},names={embedded:'закладные',loop:'петли',pipe:'трубы'};
    const items=(reading.embedded||[]).map(([kind,name,mass,qty])=>`${escapeHTML(name.replace(/^Закладная деталь |^Петлевой выпуск |^Петля /,''))} × ${qty}`);
    q('#pc-project-properties').innerHTML+=`<dt>Прочитано с листа</dt><dd>${escapeHTML(reading.applied.length?reading.applied.join(', '):'пробелов не было')} · альбом doc${String(sheet.doc||0).padStart(2,'0')}, стр. ${sheet.page||'?'} · не подтверждено</dd>${items.length?`<dt>Закладные, трубы, петли по листу</dt><dd>${items.slice(0,14).join(', ')}${items.length>14?' и ещё '+(items.length-14):''}</dd>`:''}`;
   }
   if(doc.kind!=='registry')q('#pc-geometry-note').textContent='Сечение 900 × '+doc.section[1]+' мм · консоль '+(doc.bounds[1][1]-doc.bounds[0][1])+' мм. По бетону 8 940 мм, с выпусками 11 280 мм.';
   q('#pc-source-description').textContent='Конструктив: '+doc.source.title+' · '+doc.source.revision+(doc.kind==='registry'?'. Расход по распознанной спецификации; цены и нормы требуют проверки.':'. Расходы и цены: Excel МСУ-1.');
   q('#pc-geometry-description').textContent=doc.notes.join(' ');
   if(doc.kind==='registry'){
    const url='/calc/api/document-source/'+doc.source.id;
    q('#pc-geometry-note').textContent=(doc.preview3d?'3D-эскиз: '+doc.preview3d.dimensions.map(v=>number(v,0)).join(' × ')+' мм. ':'')+'Предварительная калькуляция: '+doc.issues.join('; ')+'.';
    q('#pc-document-info').innerHTML=`<h3>${escapeHTML(doc.mark)}</h3><p class="pc-context">${escapeHTML(doc.source.revision)} · распознанные данные, требуется сверка</p><p class="pc-document-links"><a href="${url}#page=${doc.source.productPage}">${doc.source.pageVerified===false?'Ведомость · лист требует проверки':'Исходный лист · PDF стр. '+doc.source.productPage}</a><a href="${url}#page=${doc.source.registerPage}">Ведомость изделий</a></p><table class="pc-specification"><thead><tr><th>Ресурс</th><th>Ед.</th><th>По проекту</th><th>Для калькуляции</th></tr></thead><tbody><tr><td>Бетон ${escapeHTML(p.concreteClass)}</td><td>м³</td><td>${number(doc.projectVolume)}</td><td>${p.volume?number(p.volume):'Не задан'}</td></tr>${doc.resources.map(r=>`<tr><td>${escapeHTML(r.name)}</td><td>${escapeHTML(r.unit)}</td><td>${number(r.projectQty,5)}</td><td>${number(r.qty,5)}</td></tr>`).join('')}</tbody></table><h3>Сборочные единицы и детали по спецификации</h3><div class="pc-component-list">${doc.components.map(c=>c.pdfPage?`<a href="${url}#page=${c.pdfPage}">${escapeHTML(c.name)} · лист ${c.sheet}</a>`:`<span>${escapeHTML(c.name)}</span>`).join('')||'Состав требует уточнения по чертежу'}</div>`;
   }else q('#pc-document-info').innerHTML=`<h3>${escapeHTML(doc.mark)}</h3><p class="pc-context">${escapeHTML(doc.source.revision)} · объём и масса по спецификации, без производственных припусков</p><p class="pc-document-links"><a href="/calc/api/document-source/promka-columns#page=${doc.source.productPage}">Чертёж изделия · PDF стр. ${doc.source.productPage}</a><a href="/calc/api/document-source/promka-columns#page=${doc.source.cagePage}">Каркас ${escapeHTML(doc.cage)} · PDF стр. ${doc.source.cagePage}</a></p><table class="pc-specification"><thead><tr><th>Ресурс</th><th>Ед.</th><th>По проекту</th><th>Для калькуляции</th></tr></thead><tbody><tr><td>Бетон B50</td><td>м³</td><td>${number(doc.projectVolume)}</td><td>${number(p.volume)}</td></tr>${doc.resources.map(r=>`<tr><td>${escapeHTML(r.name)}</td><td>${escapeHTML(r.unit)}</td><td>${number(r.projectQty,5)}</td><td>${number(r.qty)}</td></tr>`).join('')}</tbody></table><h3>Состав каркаса</h3><div class="pc-component-list">${doc.groups.map(g=>`<a href="/calc/api/document-source/promka-columns#page=${g.sheet+15}">${escapeHTML(g.name)} · ${g.quantity} ${g.unit} · лист ${g.sheet}</a>`).join('')}</div>`;
   if(doc.solidModel){
    q('#pc-geometry-note').textContent='3D по чертежам: '+doc.solidModel.concreteDimensions.map(v=>number(v,0)).join(' × ')+' мм. Частичная сборка; ограничения — в описании изделия.';
    const qaLink=document.createElement('a');qaLink.href='/calc/api/document-models/'+encodeURIComponent(doc.id)+'/qa';qaLink.download=doc.alias+'-QA.json';qaLink.textContent='Скачать протокол 3D · JSON';q('#pc-document-info .pc-document-links').append(qaLink);
   }
   route.innerHTML=doc.stages.map(s=>`<li>${escapeHTML(s)}</li>`).join('');
  }else route.innerHTML=route.dataset.defaultRoute;
  root.querySelectorAll('[data-product]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.product)===state.product));
  q('#pc-rows').innerHTML=rowData().map(r=>`<tr><td>${r.id.startsWith('extra')?`<input class="pc-extra-name" type="text" data-extra-name="${r.id}" maxlength="100" aria-label="Название дополнительной статьи" value="${escapeHTML(r.name)}">`:`<button class="pc-article cursor-interaction" data-detail="${r.id}" aria-expanded="false">${escapeHTML(r.name)}</button>`}</td><td>${escapeHTML(r.unit)}</td><td class="pc-baseline-cell">${number(r.qty)}</td><td class="pc-baseline-cell">${money(r.rate)}</td><td class="pc-baseline-cell">${money(r.qty*r.rate)}</td>${['qty','rate','amount'].map(f=>`<td><input ${f==='qty'?'type="number"':'type="text" inputmode="decimal" data-money'} min="0" ${r.id==='profit'&&f==='qty'?'max="99.999999"':''} step="any" data-id="${r.id}" data-field="${f}" aria-label="${escapeHTML(r.name)}: моя ${f==='qty'?'норма':f==='rate'?'цена':'сумма'}" value="${escapeHTML(f==='qty'?(state.overrides[state.product][r.id]?.[f]??''):window.CalcZhBIMoney.editable(state.overrides[state.product][r.id]?.[f]??''))}"></td>`).join('')}</tr><tr class="pc-detail" id="pc-detail-${r.id}" hidden><td colspan="8">${escapeHTML(r.detail)}</td></tr>`).join('');
  q('#pc-calculation-heading').textContent=doc?.kind==='registry'?'Предварительная калькуляция на 1 изделие':'Калькуляция на 1 изделие';
  q('#pc-volume').textContent=p.volume?number(p.volume)+' м³':'Не задан';q('#pc-hours').textContent=doc?.kind==='registry'&&!p.hours?'Не задана':number(p.hours)+' чел·ч';
  // Первая загрузка отдаёт каталог без реестра расхождений (десятки МБ): он догружается для открытого изделия.
  if(p.discrepancies===undefined&&!detailLoading.has(p.id)){detailLoading.add(p.id);api.request('/calc/api/products/'+p.id).then(entry=>{Object.assign(p,{discrepancies:entry.product.discrepancies||[],dataIssues:entry.product.dataIssues||[]});if(products[state.product]===p){window.CalcZhBIProjectReport?.renderProduct(p);window.CalcZhBICollisions?.setProduct(p);}}).catch(()=>detailLoading.delete(p.id));}
  window.CalcZhBIProjectReport?.renderProduct(p);window.CalcZhBICollisions?.setProduct(p);
  totals();model();updateSelection();window.CalcZhBIUI?.updateCompare();
  if(!writeable)root.querySelectorAll('#pc-rows input').forEach(input=>{input.disabled=true;});
 }
 root.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.productGroup!==undefined){const key=b.dataset.productGroup,set=state.search.trim()?state.searchClosedGroups:state.openGroups;set.has(key)?set.delete(key):set.add(key);renderProducts();[...root.querySelectorAll('[data-product-group]')].find(el=>el.dataset.productGroup===key)?.focus({preventScroll:true});persist();}
  if(b.dataset.product){window.CalcZhBIUI?.products();window.CalcZhBIProjectReport?.close();window.CalcZhBINorms?.close();state.product=Number(b.dataset.product);render();persist();}
  if(b.dataset.view)window.CalcZhBIUI?.setView(b.dataset.view);
  if(b.dataset.detail){const el=q('#pc-detail-'+b.dataset.detail);el.hidden=!el.hidden;b.setAttribute('aria-expanded',!el.hidden);}
  if(b.id==='pc-clear'){document.getElementById('pc-reset-description').textContent=products[state.product].name;document.getElementById('pc-reset-dialog').showModal();}
  if(b.id==='pc-add'){const i=state.extra[state.product].length+1;state.extra[state.product].push({id:'extra'+i,name:'Дополнительная статья '+i,unit:'компл.',qty:1,rate:0,detail:'Пользовательская статья включена в затраты и в базу прибыли. В полном сервисе можно выбрать группу и основание.'});render();persist();}
  if(b.id==='pc-export')void exportSelected();
  if(b.id==='pc-export-one')void exportSelected(true);
  if(b.id==='pc-edit-product'||b.id==='pc-edit-calculation')openProductForm(state.product);
  if(b.id==='pc-verify-product')void toggleVerification();
  if(b.id==='pc-verify-selected')void verifySelected();
  if(b.id==='pc-product-issues-link'){q('[data-view="issues"]').click();}
  if(b.id==='pc-model-results-open')void openModelResults();
  if(b.dataset.resultProduct){q('#pc-model-results-dialog').close();window.CalcZhBIWorkspace.select(b.dataset.resultProduct,'model');}
 });
 const resetDialog=document.getElementById('pc-reset-dialog');
 document.getElementById('pc-reset-cancel').addEventListener('click',()=>{resetDialog.close();q('.pc-row-menu summary').focus();});
 document.getElementById('pc-reset-confirm').addEventListener('click',()=>{state.overrides[state.product]={};state.extra[state.product]=[];render();persist();resetDialog.close();q('#pc-add').focus();});
 root.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.selectProduct!==undefined){const index=Number(el.dataset.selectProduct);state.selected=el.checked?[...new Set([...state.selected,index])]:state.selected.filter(i=>i!==index);updateSelection();exportStatus('');persist();}
  if(el.id==='pc-select-all'){const visible=visibleProducts().map(x=>x.i);state.selected=el.checked?[...new Set([...state.selected,...visible])]:state.selected.filter(i=>!visible.includes(i));updateSelection();exportStatus('');persist();}
 });
 root.addEventListener('input',e=>{
  const el=e.target;
  if(el.dataset.id){if(!el.validity.valid)return;const o=state.overrides[state.product];o[el.dataset.id]??={};o[el.dataset.id][el.dataset.field]=el.hasAttribute('data-money')?window.CalcZhBIMoney.read(el):el.value;totals();persist();}
  if(el.id==='pc-opacity'){state.opacity=Number(el.value);model();}
  if(el.dataset.extraName){const row=state.extra[state.product].find(r=>r.id===el.dataset.extraName);if(row){row.name=el.value.trim()||'Дополнительная статья';persist();}}
 });
 q('#pc-concrete').addEventListener('change',e=>{state.showConcrete=e.target.checked;model();});q('#pc-steel').addEventListener('change',e=>{state.showSteel=e.target.checked;model();});
 const dialog=document.getElementById('pc-product-dialog'),form=document.getElementById('pc-product-form');let editing=null;
 const field=name=>form.elements.namedItem(name);
 function geometryInputs(){
  if(editing!==null&&products[editing]?.documentModelId){field('hasGeometry').checked=false;field('volumeFromGeometry').checked=false;}
  document.getElementById('pc-geometry-fields').disabled=!field('hasGeometry').checked;
  const auto=field('hasGeometry').checked&&field('volumeFromGeometry').checked;
  field('volume').readOnly=auto;
  if(auto){const volume=['length','width','height'].map(name=>Number(field(name).value)).reduce((a,b)=>a*b,1);if(Number.isFinite(volume)&&volume>0)field('volume').value=Number(volume.toFixed(9));}
 }
 async function verifySelected(){
  // массовая отметка «проверено по чертежу» у выбранных изделий: одна запись в истории («Цены и нормы» → «История»), отметку каждого изделия можно снять
  const picked=state.selected.map(i=>products[i]).filter(Boolean);if(!picked.length)return;
  if(!window.confirm('Отметить изделий: '+picked.length+' как проверенные по чертежу? Запись о действии сохранится в истории.'))return;
  try{const result=await api.request('/calc/api/products/verification/bulk',{method:'POST',body:JSON.stringify({ids:picked.map(p=>p.id),verified:true})});
   picked.forEach(p=>{p.verification=result.verification;});render();saveStatus('Отмечено проверенными: '+result.count,false);}
  catch(error){saveStatus(error.message,true);}
 }
 async function toggleVerification(){
  const p=products[state.product];
  try{const result=await api.request('/calc/api/products/'+p.id+'/verification',{method:'POST',body:JSON.stringify({verified:!p.verification})});p.verification=result.verification;render();}
  catch(error){saveStatus(error.message,true);}
 }
 function openProductForm(index){
  editing=index;form.reset();const p=index===null?null:products[index];
  document.getElementById('pc-dialog-title').textContent=p?'Параметры изделия':'Новое изделие';
  document.getElementById('pc-form-status').textContent='';
  const concreteRate=p?.concreteRate??profile.defaultConcreteRate;
  const documentProduct=Boolean(p?.documentModelId);field('volume').min=p?.documentModel?.kind==='registry'&&p.documentModel.projectVolume===null?'0':'0.000001';field('hasGeometry').disabled=documentProduct;field('otherMaterials').readOnly=documentProduct;
  document.getElementById('pc-form-geometry-note').textContent=p?.documentModel?.kind==='registry'?'Изделие загружено из КЖИ. Производственные нормы необходимо заполнить; распознанные данные сверить с чертежом.':documentProduct?'Контур и армирование взяты из чертежей КЖИ. Объём по габаритному параллелепипеду к этому изделию неприменим. Цены арматуры и труб меняются в строках калькуляции.':'По габаритам строится внешний контур 3D-модели. Арматурный каркас пока показан условно.';
  const values={name:p?.name||'',concreteClass:p?.concreteClass||'В50',volume:p?.volume??1,weight:p?.weight??0,hours:p?.hours??0,concreteRate,otherMaterials:p?(p.otherMaterials??Math.max(0,p.material-p.volume*concreteRate)):0,length:p?.geometry?.length??'',width:p?.geometry?.width??'',height:p?.geometry?.height??''};
  for(const [name,value] of Object.entries(values)){const input=field(name);input.value=input.hasAttribute('data-money')?window.CalcZhBIMoney.editable(value):value;if(input.hasAttribute('data-money'))window.CalcZhBIMoney.validate(input);}
  field('hasGeometry').checked=Boolean(p?.geometry);field('volumeFromGeometry').checked=Boolean(p?.volumeFromGeometry);geometryInputs();dialog.showModal();
 }
 for(const id of ['pc-dialog-close','pc-dialog-cancel'])document.getElementById(id).addEventListener('click',()=>dialog.close());
 form.addEventListener('input',geometryInputs);form.addEventListener('change',geometryInputs);
 form.addEventListener('submit',event=>{
  event.preventDefault();geometryInputs();if(!form.reportValidity())return;
  const name=field('name').value.trim(),concreteClass=field('concreteClass').value.trim();
  if(!name||!concreteClass){document.getElementById('pc-form-status').textContent='Укажите марку изделия и класс бетона.';return;}
  const volume=Number(field('volume').value),weight=Number(field('weight').value),hours=Number(field('hours').value),concreteRate=Number(window.CalcZhBIMoney.read(field('concreteRate'))),otherMaterials=Number(window.CalcZhBIMoney.read(field('otherMaterials')));
  const current=editing===null?null:products[editing];
  const material=volume*concreteRate+otherMaterials,labour=hours*(current?.normsLabourRate??profile.labourRate);
  const price=(material+labour+labour*profile.socialPercent/100+material*(profile.energyPercent+profile.overheadPercent+profile.adminPercent+profile.commercialPercent)/100)/(1-profile.profitPercent/100)+material*profile.deliveryPercent/100;
  if(![material,labour,price].every(Number.isFinite)){document.getElementById('pc-form-status').textContent='Проверьте значения: сумма слишком велика.';return;}
  const geometry=field('hasGeometry').checked?Object.fromEntries(['length','width','height'].map(key=>[key,Number(field(key).value)])):null;
  const product={...(editing===null?{id:crypto.randomUUID(),version:0}:products[editing]),name,concreteClass,volume,weight,hours,concreteRate,otherMaterials,material,labour,price,geometry,volumeFromGeometry:Boolean(geometry&&field('volumeFromGeometry').checked),source:'manual'};
  if(editing===null){products.push(product);state.overrides.push({});state.extra.push([]);state.product=products.length-1;state.selected.push(state.product);}else products[editing]=product;
  persist();render();dialog.close();
 });
 window.CalcZhBIWorkspace={flush:flushSaves,select:(id,view='model')=>{
  const index=products.findIndex(p=>p.id===id);if(index<0)return;
  window.CalcZhBIUI?.products();window.CalcZhBIProjectReport?.close();window.CalcZhBINorms?.close();state.product=index;render();persist();q(`[data-view="${view}"]`)?.click();
 },refresh:async()=>{
  const refreshed=await api.request('/calc/api/workspace?lite=1');
  detailLoading.clear();
  workspace.settings=refreshed.settings;
  for(const remote of refreshed.products){const i=products.findIndex(p=>p.id===remote.product.id);if(i<0)continue;products[i]=remote.product;state.overrides[i]=remote.overrides;state.extra[i]=remote.extra;acknowledged.set(remote.product.id,fingerprint(i));}
  render();
 }};
 q('#pc-project-report').disabled=false;
 window.CalcZhBIUI?.init(saved||{},linkedIndex>=0);
 render();
 if(linkedIndex<0)q('#pc-products').scrollTop=Number(saved?.scrollTop)||0;
 saveStatus('Сохранено на сервере');
 if(writeable){const drafts=readJSON(draftKey)||{};for(const [id,draft] of Object.entries(drafts)){let i=products.findIndex(p=>p.id===id);if(i<0&&draft.expectedVersion===0){i=products.length;products.push({...draft.product,version:0});state.overrides.push({});state.extra.push([]);}
  if(i<0)continue;const remote=workspace.products.find(entry=>entry.product.id===id),version=products[i].version||0;
  Object.assign(products[i],draft.product,{version});products[i].material=products[i].volume*products[i].concreteRate+products[i].otherMaterials;products[i].labour=products[i].hours*(products[i].normsLabourRate??profile.labourRate);
  state.overrides[i]=draft.overrides;state.extra[i]=draft.extra;products[i].price=calculate(i).baseTotal;const job={revision:1,fingerprint:fingerprint(i),request:draft.request,promise:null,error:null};
  if(version!==draft.expectedVersion&&!draft.request){job.conflict=remote;job.error=new Error('Есть конфликт несохранённого черновика');}
  jobs.set(id,job);
 }if(jobs.size){render();void flushSaves().catch(()=>{});}}
 if(migrationMapping&&writeable&&window.CalcZhBIMigrateLegacyFiles)void window.CalcZhBIMigrateLegacyFiles(migrationMapping).catch(error=>{q('#pc-migration-status').textContent='Перенос старых файлов не завершён: '+error.message;});
 if(globalThis.Tweak){const design={opacity:30};const tweak=new Tweak({container:q('.pc-viewer'),onChange:()=>{state.opacity=design.opacity;q('#pc-opacity').value=design.opacity;model();}});tweak.addSlider(design,'opacity',{label:'Непрозрачность бетона',min:0,max:100,unit:'%'});}
})();
