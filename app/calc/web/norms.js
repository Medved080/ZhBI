(()=>{
 'use strict';
 const panel=document.getElementById('pc-norms-panel'),open=document.getElementById('pc-open-norms'),api=window.CalcZhBIAPI;
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=s=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:6}).format(Number(s));
 let current,previousView='model';
 function close(){if(panel.hidden)return;panel.hidden=true;document.querySelector('.pc-tabs').hidden=false;document.querySelector('.pc-header').hidden=false;document.getElementById('pc-'+previousView+'-panel').hidden=false;open.setAttribute('aria-pressed','false');}
 function input(name,value,min,max,step='any'){const currency=name.endsWith('Rate')||name.endsWith('-rate'),digits=currency?2:6,display=String(Number(Number(value).toFixed(digits)));return `<input ${currency?'type="text" inputmode="decimal" data-money':'type="number"'} required min="${min}" max="${max}" step="${step}" name="${name}" value="${currency?window.CalcZhBIMoney.editable(display):display}" data-exact="${esc(value)}" data-default="${display}">`;}
 function render(){const p=current.parameters,writer=api.user.role!=='viewer';
 panel.innerHTML=`<div class="pc-norms-heading"><div class="pc-context">Справочник производства · версия ${current.version}</div><h2>Производственные нормы</h2><p>${esc(p.method)}</p><p class="pc-norms-warning">${esc(p.limitation)}</p></div><form id="pc-norms-form"><fieldset ${writer?'':'disabled'}><div class="pc-norms-fields"><label>Бетон: производственный / проектный расход${input('concreteFactor',p.concreteFactor,1,3)}<small>Коэффициент ${n(p.concreteFactor)} · припуск ${n((Number(p.concreteFactor)-1)*100)}%</small></label><label>Труд на 1 м³ производственного бетона, чел·ч${input('hoursPerM3',p.hoursPerM3,0,1000)}</label><label>Цена бетона, ₽/м³ без НДС${input('concreteRate',p.concreteRate,0,1e9)}</label><label>Стоимость труда, ₽/чел·ч${input('labourRate',p.labourRate,0,1e9)}</label></div><h3>Ресурсные нормы и цены</h3><div class="pc-norms-table"><table><thead><tr><th>Ресурс</th><th>Ед.</th><th>По проекту, сумма</th><th>В Excel, сумма</th><th>Коэффициент расхода</th><th>Цена, ₽ без НДС</th></tr></thead><tbody>${Object.entries(p.resources).map(([k,r])=>`<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${n(r.projectTotal)}</td><td>${n(r.productionTotal)}</td><td>${input(k+'-factor',r.factor,1,10)}</td><td>${input(k+'-rate',r.rate,0,1e9)}</td></tr>`).join('')}</tbody></table></div></fieldset><div class="pc-norms-actions"><button type="submit" ${writer?'':'disabled'}>Сохранить нормы</button><button id="pc-apply-norms" type="button" ${writer?'':'disabled'}>Сохранить и пересчитать изделия</button><span id="pc-norms-status" class="pc-context" role="status" aria-live="polite"></span></div></form><h3>Основание расчёта</h3><table class="pc-norms-basis"><thead><tr><th>Изделие</th><th>Бетон по проекту, м³</th><th>Бетон в Excel, м³</th><th>Труд в Excel, чел·ч</th><th>Труд / м³</th></tr></thead><tbody>${p.basis.map(b=>`<tr><td>${esc(b.name)}</td><td>${n(b.projectVolume)}</td><td>${n(b.productionVolume)}</td><td>${n(b.hours)}</td><td>${n(b.hoursPerM3)}</td></tr>`).join('')}</tbody></table><p class="pc-context">Нормы сохраняются в базе с историей изменений. При пересчёте меняется колонка расчёта сервиса для новых изделий из КЖИ. Пользовательские значения и дополнительные статьи сохраняются. Две исходные калькуляции сохраняют расходы из Excel.</p><p class="pc-context">Бетон округляется до 0,01 м³, нормируемая сталь — вверх до 0,001 т. Для диаметра или класса стали без исходной нормы остаётся проектный расход; неизвестная цена показывается как 0. Неподтверждённый объём не участвует в оценке труда.</p>`;
 const form=panel.querySelector('form');form.addEventListener('submit',e=>{e.preventDefault();void save(false);});panel.querySelector('#pc-apply-norms').addEventListener('click',()=>void save(true));
 }
 async function save(apply){const form=panel.querySelector('form');if(!form.reportValidity())return;
 const status=panel.querySelector('#pc-norms-status'),buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);status.textContent=apply?'Сохранение и пересчёт…':'Сохранение…';
 try{
  await window.CalcZhBIWorkspace.flush();
  const exact=el=>{const value=el.hasAttribute('data-money')?window.CalcZhBIMoney.read(el):el.value;return value===el.dataset.default?el.dataset.exact:value;};
  const body={expectedVersion:current.version,resources:{}};
  for(const k of ['concreteFactor','hoursPerM3','concreteRate','labourRate'])body[k]=exact(form.elements[k]);
  for(const k of Object.keys(current.parameters.resources))body.resources[k]={factor:exact(form.elements[k+'-factor']),rate:exact(form.elements[k+'-rate'])};
  current=await api.request('/calc/api/norms',{method:'PUT',body:JSON.stringify(body)});
  let message='Нормы сохранены. Версия '+current.version+'.';
  if(apply){const result=await api.request('/calc/api/norms/apply',{method:'POST'});await window.CalcZhBIWorkspace.refresh();message+=' Пересчитано изделий: '+result.products+'.';}
  render();panel.querySelector('#pc-norms-status').textContent=message;
 }catch(e){status.textContent=e.message;status.dataset.error='true';}finally{buttons.forEach(b=>b.disabled=false);}
 }
 open.addEventListener('click',async()=>{
  if(!panel.hidden){close();return;}
  window.CalcZhBIProjectReport?.close();await api.ready();previousView=document.querySelector('.pc-tabs [data-view][aria-pressed=true]')?.dataset.view||'model';
  document.querySelector('.pc-tabs').hidden=true;for(const v of ['calculation','model','tech','issues','collisions','sources','sheets','history'])document.getElementById('pc-'+v+'-panel').hidden=true;
  panel.hidden=false;open.setAttribute('aria-pressed','true');panel.textContent='Загрузка норм…';
  try{current=await api.request('/calc/api/norms');render();}catch(e){panel.textContent=e.message;}
 });window.CalcZhBINorms={close};
})();
