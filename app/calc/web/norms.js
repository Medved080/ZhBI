(()=>{
 'use strict';
 // Настройки сервиса: расценки на материалы и работы, проценты начислений и НДС, нормы расхода и труда.
 // Стоимость во всех изделиях считается сервером от текущих значений, поэтому после сохранения достаточно обновить рабочую область.
 const panel=document.getElementById('pc-norms-panel'),open=document.getElementById('pc-open-norms'),api=window.CalcZhBIAPI;
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=s=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(Number(s));
 const LABELS={socialPercent:'Страховые взносы, % от оплаты труда',energyPercent:'Энергоуслуги, % от материалов',overheadPercent:'Общепроизводственные, % от материалов',adminPercent:'Административные, % от материалов',commercialPercent:'Коммерческие, % от материалов',profitPercent:'Маржа (прибыль), %',deliveryPercent:'Доставка, % от материалов',vatPercent:'НДС, %'};
 let prices,norms,readiness,previousView='model';
 function close(){if(panel.hidden)return;panel.hidden=true;document.querySelector('.pc-tabs').hidden=false;document.querySelector('.pc-header').hidden=false;document.getElementById('pc-'+previousView+'-panel').hidden=false;open.setAttribute('aria-pressed','false');if(window.CalcZhBIUI?.section==='norms')window.CalcZhBIUI.enter('products');}
 // Денежное поле: хранит точное значение в data-exact; если пользователь не менял показанное округлённое — уходит точное
 function money(name,value,max=1e9){const display=String(Number(Number(value).toFixed(2)));return `<input type="text" inputmode="decimal" data-money required min="0" max="${max}" name="${esc(name)}" value="${window.CalcZhBIMoney.editable(display)}" data-exact="${esc(value)}" data-default="${display}">`;}
 function plain(name,value,min,max){const display=String(Number(Number(value).toFixed(6)));return `<input type="number" required min="${min}" max="${max}" step="any" name="${esc(name)}" value="${display}" data-exact="${esc(value)}" data-default="${display}">`;}
 const read=el=>{const value=el.hasAttribute('data-money')?window.CalcZhBIMoney.read(el):el.value;return value===el.dataset.default?el.dataset.exact:value;};
 const changed=(el)=>Number(read(el))!==Number(el.dataset.exact);
 function unpriced(){return Object.values(prices.parameters.materials).filter(m=>Number(m.rate)===0).length;}

 // Нормы по группам изделий: свои значения (пусто — общая норма) и подтверждение технологом; список групп и число изделий — из готовности (/api/readiness)
 function groupsSection(np){
  const gs=np.groups||{},families=(readiness?.families||[]).filter(f=>f.name!=='Вне каталога');
  if(!families.length)return '';
  const when=g=>g.confirmed&&g.confirmedAt?' · '+esc(new Date(g.confirmedAt).toLocaleDateString('ru-RU')):'';
  return `<h3>Нормы по группам изделий</h3><p class="pc-context">Пустое поле — действует общая норма. «Подтверждено» ставит технолог после проверки норм группы: пока норма не подтверждена, расчёт группы считается предварительным.</p>
  <div class="pc-bulk" id="pc-groups-bulk"><span class="pc-bulk-title">Массово для всех групп</span>
   <label>труд, чел·ч/м³<input type="number" step="any" min="0" max="1000" data-bulk-field="hoursPerM3"></label><label>расход бетона<input type="number" step="any" min="1" max="3" data-bulk-field="concreteFactor"></label><label>арматура, кг/м³<input type="number" step="any" min="0" max="500" data-bulk-field="steelKgPerM3"></label>
   <button type="button" data-bulk="fill">Заполнить у всех групп</button><button type="button" data-bulk="confirm">Подтвердить все группы</button><button type="button" data-bulk="unconfirm">Снять подтверждения</button></div>
  <p class="pc-context">Массовые кнопки только заполняют поля. Новая версия норм появится после «Сохранить расценки и нормы»; предыдущие версии и автор изменений — во вкладке «История».</p>
  <div class="pc-norms-table"><table id="pc-groups-table"><thead><tr><th>Группа</th><th>Изделий</th><th>Труд на 1 м³, чел·ч</th><th>Расход бетона, коэфф.</th><th title="Только изделиям, у которых арматуры по чертежам нет (плиты): отдельная позиция «оценка по нормативу» со своей ценой в прайсе">Арматура без чертежа, кг на м³</th><th>Подтверждено технологом</th></tr></thead><tbody>${families.map(f=>{const g=gs[f.name]||{};
   return `<tr><td>${esc(f.name)}</td><td>${n(f.total)}</td><td><input type="number" step="any" min="0" max="1000" name="g:${esc(f.name)}:hoursPerM3" value="${esc(g.hoursPerM3??'')}" placeholder="${esc(n(np.hoursPerM3))}"></td><td><input type="number" step="any" min="1" max="3" name="g:${esc(f.name)}:concreteFactor" value="${esc(g.concreteFactor??'')}" placeholder="${esc(n(np.concreteFactor))}"></td><td><input type="number" step="any" min="0" max="500" name="g:${esc(f.name)}:steelKgPerM3" value="${esc(g.steelKgPerM3??'')}" placeholder="нет"></td><td><label><input type="checkbox" name="g:${esc(f.name)}:confirmed" ${g.confirmed?'checked':''}> ${g.confirmed?'подтверждено'+when(g):'нет'}</label></td></tr>`;}).join('')}</tbody></table></div>`;
 }
 // Класс бетона по типам изделий, у которых на листах чертежей класса нет (например, плиты): цена бетона таких изделий считается по этому классу
 function typesSection(np){
  const types=readiness?.classTypes||[],assigned=np.classByType||{};
  if(!types.length)return '';
  return `<h3>Класс бетона по типам изделий</h3><p class="pc-context">Для типов, у которых класс бетона не указан на листах чертежей. Запишите класс (В30, В40…): цена бетона этих изделий считается по нему.</p>
  <div class="pc-bulk" id="pc-types-bulk"><span class="pc-bulk-title">Массово</span><label>класс всем типам<input type="text" maxlength="4" data-bulk-class placeholder="В30"></label><button type="button" data-bulk="class">Задать всем типам</button></div>
  <div class="pc-norms-table"><table id="pc-types-table"><thead><tr><th>Тип изделия</th><th>Изделий</th><th>Класс бетона</th></tr></thead><tbody>${types.map(x=>`<tr><td>${esc(x.key)}</td><td>${n(x.count)}</td><td><input type="text" maxlength="4" name="t:${esc(x.key)}" value="${esc(assigned[x.key]||'')}" placeholder="не задан" pattern="[ВBвb]?\\s?\\d{2}"></td></tr>`).join('')}</tbody></table></div>`;
 }
 function render(){
  const writer=api.user.role!=='viewer',pp=prices.parameters,np=norms.parameters,profile=prices.profile.parameters;
  const classes=Object.keys(pp.concrete).filter(k=>k!=='default');
  const classUse=Object.fromEntries((readiness?.prices?.classes||[]).map(c=>[c.name,c.products]));
  const usage=readiness?.prices?.usage||{};      // сколько изделий используют материал: материалы без цены идут первыми и по убыванию — видно, с чего начать
  const materials=Object.entries(pp.materials).sort((a,b)=>(Number(a[1].rate)>0)-(Number(b[1].rate)>0)||(usage[b[0]]||0)-(usage[a[0]]||0)||a[1].name.localeCompare(b[1].name,'ru'));
  panel.innerHTML=`<div class="pc-norms-heading"><div class="pc-context">Настройки сервиса · расценки v${prices.version} · профиль v${prices.profile.version} · нормы v${norms.version}</div><h2>Расценки и нормы</h2>
  <p>Все цены — без НДС. Изменение расценок, процентов или норм сразу пересчитывает стоимость во всех изделиях. Ручные правки в карточке изделия (корректировки строк расчёта, объём, труд и материалы, заданные вручную) при этом не меняются.</p>
  <p class="pc-norms-warning">${esc(np.limitation)}</p></div>
  <nav class="pc-settings-tabs" aria-label="Настройки расчёта"><button type="button" data-settings-section="prices">Цены</button><button type="button" data-settings-section="norms">Нормы</button><button type="button" data-settings-section="profile">Начисления</button><button type="button" data-settings-section="excel">Excel</button><button type="button" data-settings-section="history">История</button></nav><form id="pc-norms-form"><fieldset ${writer?'':'disabled'}>
  <section data-settings-panel="prices"><h3>Бетон и труд</h3><div class="pc-norms-table"><table id="pc-base-table"><thead><tr><th>Позиция</th><th>Ед.</th><th title="Сколько изделий считаются по этому классу бетона">Изделий</th><th>Цена, ₽ без НДС</th></tr></thead><tbody>
   <tr><td>Бетон: класс не указан или без своей цены</td><td>₽/м³</td><td>${classUse['Не указан']?n(classUse['Не указан']):'—'}</td><td>${money('c:default',pp.concrete.default)}</td></tr>
   ${classes.map(c=>`<tr><td>Бетон ${esc(c)}</td><td>₽/м³</td><td>${classUse[c]?n(classUse[c]):'—'}</td><td>${money('c:'+c,pp.concrete[c])}</td></tr>`).join('')}
   <tr><td>Труд</td><td>₽/чел·ч</td><td>—</td><td>${money('labour',pp.labour.rate)}</td></tr></tbody></table></div>
  <h3>Материалы</h3><div class="pc-context pc-prices-bar"><input type="search" id="pc-prices-search" placeholder="Найти материал (Ø16, А500С, труба…)" aria-label="Поиск материала"><label><input type="checkbox" id="pc-prices-empty"> только без цены</label><span class="pc-bulk pc-bulk-inline"><label>цена для показанных<input type="text" inputmode="decimal" id="pc-prices-bulk-value" placeholder="₽ за ед."></label><button type="button" data-bulk="price">Применить ко всем показанным</button></span><span id="pc-prices-count"></span></div>
  <div class="pc-norms-table"><table id="pc-prices-table"><thead><tr><th>Материал</th><th>Ед.</th><th title="Сколько изделий используют материал">Изделий</th><th>Цена, ₽ за ед.</th></tr></thead><tbody>${materials.map(([k,m])=>`<tr data-name="${esc(m.name.toLowerCase())}"><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td>${usage[k]?n(usage[k]):'—'}</td><td>${money('m:'+k,m.rate)}</td></tr>`).join('')}</tbody></table></div>
  </section><section data-settings-panel="profile"><h3>Начисления и НДС</h3><div class="pc-norms-table"><table id="pc-profile-table"><thead><tr><th>Статья</th><th>Значение, %</th></tr></thead><tbody>${Object.keys(LABELS).map(k=>`<tr><td>${esc(LABELS[k])}</td><td>${plain('p:'+k,profile[k],0,k==='socialPercent'||k==='profitPercent'||k==='vatPercent'?99.99:999)}</td></tr>`).join('')}</tbody></table></div>
  </section><section data-settings-panel="norms"><h3>Нормы расхода и труда</h3><p class="pc-context">${esc(np.method)}</p><div class="pc-norms-table"><table id="pc-general-norms"><thead><tr><th>Показатель</th><th>Значение</th><th>Пояснение</th></tr></thead><tbody>
   <tr><td>Бетон: производственный / проектный расход</td><td>${plain('concreteFactor',np.concreteFactor,1,3)}</td><td>коэффициент ${n(np.concreteFactor)} · припуск ${n((Number(np.concreteFactor)-1)*100)}%</td></tr>
   <tr><td>Труд на 1 м³ производственного бетона</td><td>${plain('hoursPerM3',np.hoursPerM3,0,1000)}</td><td>чел·ч на м³</td></tr></tbody></table></div>
  <div class="pc-norms-table"><table><thead><tr><th>Ресурс</th><th>Ед.</th><th>По проекту, сумма</th><th>В Excel, сумма</th><th>Коэффициент расхода</th></tr></thead><tbody>${Object.entries(np.resources).map(([k,r])=>`<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${n(r.projectTotal)}</td><td>${n(r.productionTotal)}</td><td>${plain('f:'+k,r.factor,1,10)}</td></tr>`).join('')}</tbody></table></div>
  ${groupsSection(np)}${typesSection(np)}
  </section></fieldset><div class="pc-norms-actions"><button type="submit" ${writer?'':'disabled'}>Сохранить расценки и нормы</button><span id="pc-norms-status" class="pc-context" role="status" aria-live="polite"></span></div></form><section data-settings-panel="history" hidden><h3>История изменений</h3><p class="pc-context">Каждое сохранение расценок, начислений и норм и каждая отметка проверки — отдельная запись: кто, когда и что изменено (было → стало). Прежние значения не теряются.</p><div id="pc-sh-list" class="pc-sh-list"></div></section><section data-settings-panel="excel" hidden><h3>Заполнение из Excel</h3>
  <ol class="pc-excel-steps"><li><strong>Скачайте шаблон.</strong> В нём все недостающие параметры: цены материалов без цены, нормы групп, класс бетона по типам, объём и класс там, где их нет, отметки проверки.</li>
   <li><strong>Заполните жёлтые ячейки</strong> (пустая ячейка — без изменений) и сохраните файл. Листы и заголовки менять нельзя.</li>
   <li><strong>Загрузите файл и нажмите «Проверить»:</strong> система покажет, что изменится, и укажет ошибки с адресом ячейки. «Применить» доступно, когда ошибок нет; применяется всё сразу новой версией, записи появятся во вкладке «История».</li></ol>
  <div class="pc-excel-actions"><a class="pc-excel-download" href="/calc/api/settings-template.xlsx" download>Скачать шаблон XLSX</a>
   <label class="pc-excel-file">Файл XLSX<input type="file" id="pc-excel-file" accept=".xlsx"></label>
   <button type="button" data-excel="check">Проверить файл</button><button type="button" data-excel="apply" disabled>Применить изменения</button></div>
  <div id="pc-excel-result" class="pc-excel-result" role="status" aria-live="polite"></div></section>
  <details><summary>Основание норм и методика</summary><h3>Основание норм</h3><table class="pc-norms-basis"><thead><tr><th>Изделие</th><th>Бетон по проекту, м³</th><th>Бетон в Excel, м³</th><th>Труд в Excel, чел·ч</th><th>Труд / м³</th></tr></thead><tbody>${np.basis.map(b=>`<tr><td>${esc(b.name)}</td><td>${n(b.projectVolume)}</td><td>${n(b.productionVolume)}</td><td>${n(b.hours)}</td><td>${n(b.hoursPerM3)}</td></tr>`).join('')}</tbody></table>
  <p class="pc-context">Нормы и расценки хранятся в базе с историей изменений. Бетон округляется до 0,01 м³, нормируемая сталь — вверх до 0,001 т. Материал без цены считается по нулю — стоимость такого изделия занижена, пока цена не задана. Неподтверждённый объём не участвует в оценке труда.</p></details>`;
  window.CalcZhBIUI?.bindSettings(panel);
  const form=panel.querySelector('form'),search=panel.querySelector('#pc-prices-search'),empty=panel.querySelector('#pc-prices-empty'),count=panel.querySelector('#pc-prices-count');
  const filter=()=>{const q=search.value.trim().toLowerCase();let shown=0;for(const row of panel.querySelectorAll('#pc-prices-table tbody tr')){const input=row.querySelector('input'),zero=Number(read(input))===0,ok=(!q||row.dataset.name.includes(q))&&(!empty.checked||zero);row.hidden=!ok;shown+=ok;}count.textContent='Показано '+shown+' из '+materials.length+' · без цены: '+unpriced();};
  search.addEventListener('input',filter);empty.addEventListener('change',filter);filter();
  form.addEventListener('submit',e=>{e.preventDefault();void save();});
 }

 // Массовые кнопки только заполняют поля формы (сохранение — обычной кнопкой, одной новой версией); история версий — вкладка «История»
 function bulkStatus(text){const s=panel.querySelector('#pc-norms-status');if(s){s.textContent=text;delete s.dataset.error;}}
 function setField(el,value){el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}
 let historyKind='';
 function when(iso){const d=new Date(/Z|[+-]\d\d:?\d\d$/.test(iso)?iso:iso+'Z');return d.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});}
 function historyHtml(r){
  const bar=`<div class="pc-sh-filter" role="group" aria-label="Вид записей">${[['','Все'],...Object.entries(r.kinds)].map(([k,title])=>`<button type="button" data-history-kind="${esc(k)}" aria-pressed="${k===historyKind}">${esc(title)}</button>`).join('')}</div>`;
  if(!r.entries.length)return bar+'<p class="pc-context">Изменений пока нет.</p>';
  return bar+r.entries.map(e=>{
   const head=`<div class="pc-sh-head"><strong>${esc(e.kindTitle)}${e.version?' · версия '+e.version:''}</strong><span>${esc(e.actor)}</span><span class="pc-context">${esc(when(e.at))} МСК</span></div>${e.summary?`<p>${esc(e.summary)}</p>`:''}`;
   const rows=e.changes.map(c=>`<tr><td>${esc(c.label)}</td><td>${esc(c.before)}</td><td>${esc(c.after)}</td></tr>`).join('');
   const table=e.changes.length?`<table class="pc-sh-table"><thead><tr><th>Что</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows}</tbody></table>`:'';
   return `<article class="pc-sh-item" data-kind="${esc(e.kind)}">${head}${table?(e.changes.length>8?`<details class="pc-sh-more"><summary>Показать изменения (${e.changes.length})</summary>${table}</details>`:table):''}</article>`;
  }).join('');
 }
 async function loadHistory(){
  const host=panel.querySelector('#pc-sh-list');if(!host)return;host.textContent='Загружаю историю…';
  try{host.innerHTML=historyHtml(await api.request('/calc/api/history/settings'+(historyKind?'?kind='+historyKind:'')));}catch(e){host.textContent=e.message;}
 }
 panel.addEventListener('change',event=>{if(event.target.id==='pc-excel-file'){excelFile=event.target.files[0]||null;excelState=excelFile?{message:'Выбран файл: '+excelFile.name+'. Нажмите «Проверить файл».'}:null;excelRefresh();}});
 panel.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.settingsSection!==undefined){const bar=panel.querySelector('.pc-norms-actions');if(bar)bar.hidden=['history','excel'].includes(b.dataset.settingsSection);if(b.dataset.settingsSection==='history')void loadHistory();return;}      // в истории сохранять нечего
  if(b.dataset.historyKind!==undefined){historyKind=b.dataset.historyKind;void loadHistory();return;}
  if(b.dataset.excel){void excelRun(b.dataset.excel==='apply');return;}
  const action=b.dataset.bulk;if(!action)return;
  if(action==='fill'){
   const values=[...panel.querySelectorAll('[data-bulk-field]')].filter(el=>el.value!=='');if(!values.length){bulkStatus('Введите значение хотя бы в одно поле «Массово для всех групп».');return;}
   let groups=0;for(const el of values)for(const target of panel.querySelectorAll('#pc-groups-table input[name$=":'+el.dataset.bulkField+'"]')){setField(target,el.value);groups++;}
   bulkStatus('Заполнено полей: '+groups+'. Нажмите «Сохранить расценки и нормы» — появится новая версия норм.');
  }else if(action==='confirm'||action==='unconfirm'){
   const boxes=[...panel.querySelectorAll('#pc-groups-table input[name$=":confirmed"]')];boxes.forEach(el=>{el.checked=action==='confirm';});
   bulkStatus((action==='confirm'?'Подтверждены':'Сняты подтверждения у')+' групп: '+boxes.length+'. Нажмите «Сохранить расценки и нормы».');
  }else if(action==='class'){
   const value=panel.querySelector('[data-bulk-class]').value.trim();if(!value){bulkStatus('Введите класс бетона, например В30.');return;}
   const inputs=[...panel.querySelectorAll('#pc-types-table input[name^="t:"]')];inputs.forEach(el=>setField(el,value));
   bulkStatus('Класс '+value+' задан типам: '+inputs.length+'. Нажмите «Сохранить расценки и нормы».');
  }else if(action==='price'){
   const raw=panel.querySelector('#pc-prices-bulk-value').value.replace(/\s/g,'').replace(',','.'),price=Number(raw);
   if(raw===''||!Number.isFinite(price)||price<0){bulkStatus('Введите цену — число не меньше нуля.');return;}
   const rows=[...panel.querySelectorAll('#pc-prices-table tbody tr')].filter(r=>!r.hidden);
   rows.forEach(r=>setField(r.querySelector('input'),window.CalcZhBIMoney.editable(String(price))));
   bulkStatus('Цена '+price+' ₽ поставлена показанным материалам: '+rows.length+'. Нажмите «Сохранить расценки и нормы» — появится новая версия расценок.');
  }
 });

 // Заполнение из Excel: шаблон со всеми недостающими параметрами → заполнение → проверка («что изменится», ошибки по ячейкам) → применение одной транзакцией
 let excelFile=null,excelState=null;
 function excelHtml(){
  const s=excelState;if(!s)return '';
  if(s.message&&!s.errors?.length&&!s.changes)return `<p class="pc-excel-msg">${esc(s.message)}</p>`;
  const errors=s.errors?.length?`<div class="pc-excel-errors" role="alert"><strong>Ошибки (${s.errors.length}) — ничего не применено:</strong><ul>${s.errors.slice(0,60).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>${s.errors.length>60?`<p>и ещё ${s.errors.length-60}</p>`:''}</div>`:'';
  const sm=s.summary||{},parts=[['prices','цен'],['groups','норм групп'],['classes','классов по типам'],['products','изделий'],['verified','отметок проверки'],['unverified','снятий отметки']].filter(([k])=>sm[k]).map(([k,w])=>sm[k]+' '+w).join(', ');
  const head=s.applied?`<p class="pc-excel-msg"><strong>Применено.</strong> ${esc(parts||'изменения')}. Стоимость изделий пересчитана; записи — во вкладке «История».</p>`:s.changesTotal?`<p><strong>Будет изменено:</strong> ${esc(parts||s.changesTotal+' значений')} (всего значений: ${s.changesTotal}).</p>`:(s.errors?.length?'':'<p class="pc-excel-msg">В файле нет изменений относительно текущих значений.</p>');
  const rows=(s.changes||[]).map(c=>`<tr><td>${esc(c.sheet)}</td><td>${esc(c.label)}</td><td>${esc(c.before)}</td><td>${esc(c.after)}</td></tr>`).join('');
  return errors+head+(rows?`<div class="pc-norms-table"><table class="pc-sh-table"><thead><tr><th>Лист</th><th>Что</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows}</tbody></table></div>${s.changesTotal>s.changes.length?`<p class="pc-context">Показаны первые ${s.changes.length} из ${s.changesTotal}.</p>`:''}`:'');
 }
 function excelRefresh(){
  const host=panel.querySelector('#pc-excel-result');if(host)host.innerHTML=excelHtml();
  const apply=panel.querySelector('[data-excel="apply"]');if(apply)apply.disabled=!(excelState&&!excelState.applied&&excelState.changesTotal&&!excelState.errors?.length);
 }
 async function excelRun(applyNow){
  if(!excelFile){excelState={message:'Сначала выберите файл XLSX.'};excelRefresh();return;}
  const form=new FormData();form.append('file',excelFile);
  excelState={message:applyNow?'Применяю…':'Проверяю файл…'};excelRefresh();
  try{
   const result=await api.request('/calc/api/settings-import?apply='+(applyNow?'true':'false'),{method:'POST',body:form});
   excelState=result;excelRefresh();
   if(applyNow&&result.applied){
    [prices,norms,readiness]=await Promise.all([api.request('/calc/api/prices'),api.request('/calc/api/norms'),api.request('/calc/api/readiness').catch(()=>null)]);
    await window.CalcZhBIWorkspace.refresh();const keep=excelState;render();excelState=keep;excelRefresh();
    panel.querySelector('[data-settings-section="excel"]')?.click();
   }
  }catch(e){excelState={errors:[e.message]};excelRefresh();}
 }
 async function save(){
  const form=panel.querySelector('form');if(!form.reportValidity())return;
  const status=panel.querySelector('#pc-norms-status'),buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);status.textContent='Сохранение…';delete status.dataset.error;
  const field=name=>form.elements[name],group=prefix=>[...form.elements].filter(el=>el.name?.startsWith(prefix));
  try{
   await window.CalcZhBIWorkspace.flush();
   const messages=[];
   const priceInputs=[...group('c:'),field('labour'),...group('m:')];
   if(priceInputs.some(changed)){
    const body={expectedVersion:prices.version,concrete:{},labour:read(field('labour')),materials:{}};
    for(const el of group('c:'))body.concrete[el.name.slice(2)]=read(el);
    for(const el of group('m:'))body.materials[el.name.slice(2)]=read(el);
    const result=await api.request('/calc/api/prices',{method:'PUT',body:JSON.stringify(body)});prices=result;messages.push('расценки v'+result.version);
   }
   const profileInputs=group('p:');
   if(profileInputs.some(changed)){
    const body={expectedVersion:prices.profile.version};for(const el of profileInputs)body[el.name.slice(2)]=read(el);
    prices=await api.request('/calc/api/profile',{method:'PUT',body:JSON.stringify(body)});messages.push('профиль v'+prices.profile.version);
   }
   const normInputs=[field('concreteFactor'),field('hoursPerM3'),...group('f:')];
   const extra=[...group('g:'),...group('t:')],extraChanged=extra.some(el=>el.type==='checkbox'?el.checked!==el.defaultChecked:el.value!==el.defaultValue);
   if(normInputs.some(changed)||extraChanged){
    const body={expectedVersion:norms.version,resources:{}};for(const k of ['concreteFactor','hoursPerM3'])body[k]=read(field(k));
    for(const el of group('f:'))body.resources[el.name.slice(2)]={factor:read(el)};
    if(group('g:').length){body.groups={};for(const el of group('g:')){const [,family,key]=el.name.split(':');const g=body.groups[family]??={confirmed:false,hoursPerM3:null,concreteFactor:null,steelKgPerM3:null};if(key==='confirmed')g.confirmed=el.checked;else g[key]=el.value===''?null:el.value;}}
    if(group('t:').length){body.classByType={};for(const el of group('t:'))body.classByType[el.name.slice(2)]=el.value.trim();}
    norms=await api.request('/calc/api/norms',{method:'PUT',body:JSON.stringify(body)});messages.push('нормы v'+norms.version);
   }
   if(messages.length)await window.CalcZhBIWorkspace.refresh();
   render();panel.querySelector('#pc-norms-status').textContent=messages.length?'Сохранено: '+messages.join(', ')+'. Стоимость изделий пересчитана.':'Изменений нет.';
  }catch(e){status.textContent=e.message;status.dataset.error='true';}finally{buttons.forEach(b=>b.disabled=false);}
 }
 open.addEventListener('click',async()=>{
  if(!panel.hidden){close();return;}
  window.CalcZhBIProjectReport?.close();window.CalcZhBIUI?.enter('norms');await api.ready();if(window.CalcZhBIUI?.section!=='norms')return;previousView=document.querySelector('.pc-tabs [data-view][aria-pressed=true]')?.dataset.view||'model';
  document.querySelector('.pc-tabs').hidden=true;for(const v of ['calculation','model','tech','issues','collisions','sources','sheets','history'])document.getElementById('pc-'+v+'-panel').hidden=true;
  panel.hidden=false;open.setAttribute('aria-pressed','true');panel.textContent='Загрузка расценок и норм…';
  try{[prices,norms,readiness]=await Promise.all([api.request('/calc/api/prices'),api.request('/calc/api/norms'),api.request('/calc/api/readiness').catch(()=>null)]);render();}catch(e){panel.textContent=e.message;}
 });window.CalcZhBINorms={close};
})();
