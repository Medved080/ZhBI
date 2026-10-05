(()=>{
 'use strict';
 // Настройки сервиса: расценки на материалы и работы, проценты начислений и НДС, нормы расхода и труда.
 // Стоимость во всех изделиях считается сервером от текущих значений, поэтому после сохранения достаточно обновить рабочую область.
 const panel=document.getElementById('pc-norms-panel'),open=document.getElementById('pc-open-norms'),api=window.CalcZhBIAPI;
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=s=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(Number(s));
 const LABELS={socialPercent:'Страховые взносы, % от оплаты труда',energyPercent:'Энергоуслуги, % от материалов',overheadPercent:'Общепроизводственные, % от материалов',adminPercent:'Административные, % от материалов',commercialPercent:'Коммерческие, % от материалов',profitPercent:'Маржа (прибыль), %',deliveryPercent:'Доставка, % от материалов',vatPercent:'НДС, %'};
 let prices,norms,previousView='model';
 function close(){if(panel.hidden)return;panel.hidden=true;document.querySelector('.pc-tabs').hidden=false;document.querySelector('.pc-header').hidden=false;document.getElementById('pc-'+previousView+'-panel').hidden=false;open.setAttribute('aria-pressed','false');if(window.CalcZhBIUI?.section==='norms')window.CalcZhBIUI.enter('products');}
 // Денежное поле: хранит точное значение в data-exact; если пользователь не менял показанное округлённое — уходит точное
 function money(name,value,max=1e9){const display=String(Number(Number(value).toFixed(2)));return `<input type="text" inputmode="decimal" data-money required min="0" max="${max}" name="${esc(name)}" value="${window.CalcZhBIMoney.editable(display)}" data-exact="${esc(value)}" data-default="${display}">`;}
 function plain(name,value,min,max){const display=String(Number(Number(value).toFixed(6)));return `<input type="number" required min="${min}" max="${max}" step="any" name="${esc(name)}" value="${display}" data-exact="${esc(value)}" data-default="${display}">`;}
 const read=el=>{const value=el.hasAttribute('data-money')?window.CalcZhBIMoney.read(el):el.value;return value===el.dataset.default?el.dataset.exact:value;};
 const changed=(el)=>Number(read(el))!==Number(el.dataset.exact);
 function unpriced(){return Object.values(prices.parameters.materials).filter(m=>Number(m.rate)===0).length;}
 function render(){
  const writer=api.user.role!=='viewer',pp=prices.parameters,np=norms.parameters,profile=prices.profile.parameters;
  const classes=Object.keys(pp.concrete).filter(k=>k!=='default');
  const materials=Object.entries(pp.materials).sort((a,b)=>a[1].name.localeCompare(b[1].name,'ru'));
  panel.innerHTML=`<div class="pc-norms-heading"><div class="pc-context">Настройки сервиса · расценки v${prices.version} · профиль v${prices.profile.version} · нормы v${norms.version}</div><h2>Расценки и нормы</h2>
  <p>Все цены — без НДС. Изменение расценок, процентов или норм сразу пересчитывает стоимость во всех изделиях. Ручные правки в карточке изделия (корректировки строк расчёта, объём, труд и материалы, заданные вручную) при этом не меняются.</p>
  <p class="pc-norms-warning">${esc(np.limitation)}</p></div>
  <nav class="pc-settings-tabs" aria-label="Настройки расчёта"><button type="button" data-settings-section="prices">Цены</button><button type="button" data-settings-section="norms">Нормы</button><button type="button" data-settings-section="profile">Начисления</button></nav><form id="pc-norms-form"><fieldset ${writer?'':'disabled'}>
  <section data-settings-panel="prices"><h3>Бетон и труд</h3><div class="pc-norms-fields">
   <label>Бетон: цена по умолчанию, ₽/м³ (класс без своей цены, «не указан»)${money('c:default',pp.concrete.default)}</label>
   ${classes.map(c=>`<label>Бетон ${esc(c)}, ₽/м³${money('c:'+c,pp.concrete[c])}</label>`).join('')}
   <label>Труд, ₽/чел·ч${money('labour',pp.labour.rate)}</label></div>
  <h3>Материалы</h3><div class="pc-context pc-prices-bar"><input type="search" id="pc-prices-search" placeholder="Найти материал (Ø16, А500С, труба…)" aria-label="Поиск материала"><label><input type="checkbox" id="pc-prices-empty"> только без цены</label><span id="pc-prices-count"></span></div>
  <div class="pc-norms-table"><table id="pc-prices-table"><thead><tr><th>Материал</th><th>Ед.</th><th>Цена, ₽ за ед.</th></tr></thead><tbody>${materials.map(([k,m])=>`<tr data-name="${esc(m.name.toLowerCase())}"><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td>${money('m:'+k,m.rate)}</td></tr>`).join('')}</tbody></table></div>
  </section><section data-settings-panel="profile"><h3>Начисления и НДС</h3><div class="pc-norms-fields">${Object.keys(LABELS).map(k=>`<label>${esc(LABELS[k])}${plain('p:'+k,profile[k],0,k==='socialPercent'||k==='profitPercent'||k==='vatPercent'?99.99:999)}</label>`).join('')}</div>
  </section><section data-settings-panel="norms"><h3>Нормы расхода и труда</h3><p class="pc-context">${esc(np.method)}</p><div class="pc-norms-fields">
   <label>Бетон: производственный / проектный расход${plain('concreteFactor',np.concreteFactor,1,3)}<small>Коэффициент ${n(np.concreteFactor)} · припуск ${n((Number(np.concreteFactor)-1)*100)}%</small></label>
   <label>Труд на 1 м³ производственного бетона, чел·ч${plain('hoursPerM3',np.hoursPerM3,0,1000)}</label></div>
  <div class="pc-norms-table"><table><thead><tr><th>Ресурс</th><th>Ед.</th><th>По проекту, сумма</th><th>В Excel, сумма</th><th>Коэффициент расхода</th></tr></thead><tbody>${Object.entries(np.resources).map(([k,r])=>`<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${n(r.projectTotal)}</td><td>${n(r.productionTotal)}</td><td>${plain('f:'+k,r.factor,1,10)}</td></tr>`).join('')}</tbody></table></div>
  </section></fieldset><div class="pc-norms-actions"><button type="submit" ${writer?'':'disabled'}>Сохранить расценки и нормы</button><span id="pc-norms-status" class="pc-context" role="status" aria-live="polite"></span></div></form>
  <details><summary>Основание норм и методика</summary><h3>Основание норм</h3><table class="pc-norms-basis"><thead><tr><th>Изделие</th><th>Бетон по проекту, м³</th><th>Бетон в Excel, м³</th><th>Труд в Excel, чел·ч</th><th>Труд / м³</th></tr></thead><tbody>${np.basis.map(b=>`<tr><td>${esc(b.name)}</td><td>${n(b.projectVolume)}</td><td>${n(b.productionVolume)}</td><td>${n(b.hours)}</td><td>${n(b.hoursPerM3)}</td></tr>`).join('')}</tbody></table>
  <p class="pc-context">Нормы и расценки хранятся в базе с историей изменений. Бетон округляется до 0,01 м³, нормируемая сталь — вверх до 0,001 т. Материал без цены считается по нулю — стоимость такого изделия занижена, пока цена не задана. Неподтверждённый объём не участвует в оценке труда.</p></details>`;
  window.CalcZhBIUI?.bindSettings(panel);
  const form=panel.querySelector('form'),search=panel.querySelector('#pc-prices-search'),empty=panel.querySelector('#pc-prices-empty'),count=panel.querySelector('#pc-prices-count');
  const filter=()=>{const q=search.value.trim().toLowerCase();let shown=0;for(const row of panel.querySelectorAll('#pc-prices-table tbody tr')){const input=row.querySelector('input'),zero=Number(read(input))===0,ok=(!q||row.dataset.name.includes(q))&&(!empty.checked||zero);row.hidden=!ok;shown+=ok;}count.textContent='Показано '+shown+' из '+materials.length+' · без цены: '+unpriced();};
  search.addEventListener('input',filter);empty.addEventListener('change',filter);filter();
  form.addEventListener('submit',e=>{e.preventDefault();void save();});
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
   if(normInputs.some(changed)){
    const body={expectedVersion:norms.version,resources:{}};for(const k of ['concreteFactor','hoursPerM3'])body[k]=read(field(k));
    for(const el of group('f:'))body.resources[el.name.slice(2)]={factor:read(el)};
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
  try{[prices,norms]=await Promise.all([api.request('/calc/api/prices'),api.request('/calc/api/norms')]);render();}catch(e){panel.textContent=e.message;}
 });window.CalcZhBINorms={close};
})();
