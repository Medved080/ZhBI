(()=>{
 'use strict';
 // Главная страница калькулятора: готовность калькуляций по всем изделиям. Данные — GET /calc/api/readiness (app/calc/readiness.py), считаются на сервере
 // от каталога, чтений с листов и текущих расценок. Готовность открывается отдельным разделом; при загрузке остаётся рабочая карточка изделия.
 const q=s=>document.querySelector(s),api=window.CalcZhBIAPI,main=q('.pc-main'),panel=q('#pc-home-panel');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=n=>new Intl.NumberFormat('ru-RU').format(n),pct=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(n);
 const share=(n,total)=>total?100*n/total:0;
 let data=null,loading=false,openState=[];      // openState — какие сворачиваемые разделы раскрыты (переживает «Обновить»)
 const OWNER={'чтение листов':'разработка','вы':'вы','технолог':'технолог','проверка':'проверка'};
 const CELLS=[['volume','Объём'],['concreteClass','Класс'],['rebar','Арматура'],['embedded','Закладные, трубы, петли'],['prices','Цены'],['norms','Нормы'],['verified','Проверено'],['ready','Готово']];

 function isHome(){return main.dataset.home==='1';}
 function show(){window.CalcZhBINorms?.close();window.CalcZhBIProjectReport?.close();window.CalcZhBIUI?.enter('home');main.dataset.home='1';q('#pc-home-open')?.setAttribute('aria-pressed','true');if(!data)load();}
 function leave(){if(!isHome())return;window.CalcZhBIUI?.products();delete main.dataset.home;q('#pc-home-open')?.setAttribute('aria-pressed','false');}

 const level=(n,total)=>n>=total&&total?'full':n>0?'part':'none';
 function bar(n,total){return `<span class="pc-home-bar" role="img" aria-label="${num(n)} из ${num(total)}"><span style="width:${share(n,total)}%"></span></span>`;}

 function hero(d){
  const f=d.funnel,base=f[2].cumulative,full=f[3].cumulative,priced=f[4].cumulative;
  return `<section class="pc-home-hero"><div class="pc-home-big"><strong>${num(d.ready)}</strong><span>из ${num(d.total)} изделий готовы полностью</span></div>
   <div class="pc-home-overall"><div class="pc-home-overall-head"><span>Общая готовность</span><strong>${pct(d.percent)}%</strong></div>${bar(d.percent,100)}
    <p class="pc-context">Среднее по семи условиям готовности (каждое равноправно). Изделие готово, когда выполнены все семь.</p></div>
   <div class="pc-home-steps">
    <div><strong>${num(base)}</strong><span>основа расчёта: объём, класс бетона и арматура</span></div>
    <div><strong>${num(full)}</strong><span>с закладными, трубами и петлями</span></div>
    <div><strong>${num(priced)}</strong><span>и с ценами на все материалы</span></div>
   </div></section>`;
 }

 function funnel(d){
  return `<section class="pc-home-block"><h3>Путь изделия до готовности</h3><p class="pc-context">Изделие проходит шаг, если выполнены все предыдущие. «Само по себе» — сколько изделий выполняют условие независимо от остальных.</p>
   <ol class="pc-home-funnel">${d.funnel.map((s,i)=>`<li data-level="${level(s.cumulative,d.total)}"><div class="pc-home-row"><span class="pc-home-step">${i+1}</span><div class="pc-home-title"><strong>${esc(s.title)}</strong><span class="pc-home-owner" data-owner="${esc(s.owner)}">${esc(OWNER[s.owner]||s.owner)}</span></div>
     <div class="pc-home-count"><strong>${num(s.cumulative)}</strong> из ${num(d.total)}<span class="pc-context"> · осталось ${num(d.total-s.cumulative)}${s.alone!==s.cumulative?' · само по себе '+num(s.alone):''}</span></div></div>${bar(s.cumulative,d.total)}<p class="pc-context">${esc(s.hint)}</p></li>`).join('')}</ol></section>`;
 }

 function families(d){
  const head=CELLS.map(([k,t])=>`<th scope="col">${esc(t)}</th>`).join('');
  const rows=d.families.map(f=>`<tr><th scope="row">${esc(f.name)}<span class="pc-context"> ${num(f.total)}</span></th>${CELLS.map(([k])=>`<td data-level="${level(f[k],f.total)}" title="${num(f[k])} из ${num(f.total)}">${num(f[k])}</td>`).join('')}</tr>`).join('');
  return `<section class="pc-home-block"><h3>По группам изделий</h3><p class="pc-context">Сколько изделий группы выполняют каждое условие (рядом с названием — число изделий в группе).</p><div class="pc-home-scroll"><table class="pc-home-table"><thead><tr><th scope="col">Группа</th>${head}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
 }

 function owners(d){
  const groups=d.norms.families.filter(f=>f!=='Вне каталога'),sum=key=>d.funnel.find(s=>s.key===key);
  const miss=key=>d.total-sum(key).alone;
  const cards=[
   ['Разработка · чтение листов',[`нет объёма бетона: ${num(miss('volume'))}`,`не указан класс бетона: ${num(miss('concreteClass'))}`,`нет арматуры: ${num(miss('rebar'))}`,`нет закладных, труб, петель: ${num(miss('embedded'))}`],'изделий'],
   ['Вы · расценки',[`материалов без цены: ${num(d.prices.unpriced)} из ${num(d.prices.materials)}`,`изделий без полного набора цен: ${num(miss('prices'))}`,`классов бетона без цены: ${num(d.prices.classes.filter(c=>!c.priced&&c.name!=='Не указан').length)}`],''],
   ['Технолог · нормы и классы',[`групп без подтверждённых норм: ${num(groups.length-d.norms.confirmed.length)} из ${num(groups.length)}`,`типов изделий без класса бетона: ${num(d.classTypes.filter(x=>!x.assigned).length)}`,'подтверждение и классы — в «Расценки и нормы»'],''],
   ['Проверка человеком',[`не проверено: ${num(miss('verified'))} из ${num(d.total)}`,'отметка — кнопкой в карточке изделия'],'']];
  return `<section class="pc-home-block"><h3>Что осталось до финала, по исполнителям</h3><div class="pc-home-owners">${cards.map(([t,items])=>`<article><h4>${esc(t)}</h4><ul>${items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul></article>`).join('')}</div></section>`;
 }

 function gaps(d){
  if(!d.gaps.length)return '';
  return `<section class="pc-home-block"><h3>Самые большие пробелы</h3><ol class="pc-home-gaps">${d.gaps.map(g=>`<li><strong>${esc(g.family)}</strong> — ${esc(g.title.toLowerCase())}: <b>${num(g.missing)}</b> изд. <span class="pc-home-owner" data-owner="${esc(g.owner)}">${esc(OWNER[g.owner]||g.owner)}</span></li>`).join('')}</ol></section>`;
 }

 function prices(d){
  const p=d.prices;
  const list=p.unpricedList.length?`<ul class="pc-home-unpriced">${p.unpricedList.map(m=>`<li><span>${esc(m.name)}</span><span class="pc-context">в ${num(m.products)} изд.</span></li>`).join('')}</ul>${p.unpriced>p.unpricedList.length?`<p class="pc-context">и ещё ${num(p.unpriced-p.unpricedList.length)}</p>`:''}`:'<p class="pc-context">У всех материалов, которые встречаются в изделиях, цена задана.</p>';
  const classes=p.classes.map(c=>`<tr data-level="${c.priced?'full':c.name==='Не указан'?'none':'part'}"><th scope="row">${esc(c.name)}</th><td>${num(c.products)}</td><td>${c.name==='Не указан'?'цена по умолчанию':c.priced?'задана':'не задана'}</td></tr>`).join('');
  return `<section class="pc-home-block"><h3>Расценки</h3><div class="pc-home-two"><div><h4>Материалы без цены: ${num(p.unpriced)} из ${num(p.materials)}</h4>${list}<button type="button" id="pc-home-prices" class="pc-home-link">Открыть «Расценки и нормы» →</button></div>
   <div><h4>Бетон по классам</h4><table class="pc-home-table pc-home-small"><thead><tr><th scope="col">Класс</th><th scope="col">Изделий</th><th scope="col">Цена</th></tr></thead><tbody>${classes}</tbody></table><p class="pc-context">Ставка труда: ${num(Math.round(p.labourRate))} ₽/чел·ч${p.labourRate>0?'':' — не задана'}. Версия расценок ${p.pricesVersion}.</p></div></div></section>`;
 }

 function origin(d){
  const names=[['volume','Объём бетона'],['concreteClass','Класс бетона'],['rebar','Арматура']];
  const line=(o,k)=>Object.entries(o[k]||{}).map(([s,n])=>`${esc(s)}: ${num(n)}`).join(' · ')||'—';
  return `<section class="pc-home-block"><h3>Откуда данные</h3><p class="pc-context">«Чтение листа» — прочитано с PDF автоматически и не подтверждено человеком; значения поставщика чтением не заменяются.</p><dl class="pc-home-origin">${names.map(([k,t])=>`<dt>${t}</dt><dd>${line(d.origin,k)}</dd>`).join('')}</dl></section>`;
 }

 function model3d(d){
  const m=d.model3d,withRebar=(m.complete||0)+(m.partial||0);
  return `<section class="pc-home-block"><h3>3D-модели</h3><p>С арматурой: <b>${num(withRebar)}</b> из ${num(d.total)} (полных ${num(m.complete||0)}, частичных ${num(m.partial||0)}). 3D не входит в условия готовности калькуляции: стоимость от неё не зависит.</p></section>`;
 }

 // Сворачиваемый раздел: явный блок с рамкой, шапкой-кнопкой и шевроном (раньше — просто строка текста)
 function section(title,meta,body){return `<details class="pc-home-detail"><summary><span class="pc-home-chevron" aria-hidden="true"></span><span class="pc-home-detail-title">${esc(title)}</span><span class="pc-home-detail-meta">${esc(meta)}</span></summary>${body}</details>`;}
 function render(){
  const d=data;
  panel.innerHTML=`<header class="pc-home-header"><div><div class="pc-context">Калькулятор ЖБИ</div><h2>Готовность калькуляций</h2></div><div class="pc-home-tools"><span class="pc-context" id="pc-home-stamp">Данные на ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span><button type="button" id="pc-home-refresh">Обновить</button><button type="button" id="pc-home-products">К изделиям →</button></div></header>
   ${hero(d)}${model3d(d)}
   ${section('Что мешает завершить расчёты','по исполнителям · самые большие пробелы',owners(d)+gaps(d))}
   ${section('Условия готовности и группы изделий',d.funnel.length+' условий · '+d.families.length+' групп',funnel(d)+families(d))}
   ${section('Расценки и источники данных','без цены: '+num(d.prices.unpriced)+' из '+num(d.prices.materials)+' материалов',prices(d)+origin(d))}`;
  openState.forEach((value,index)=>{const el=panel.querySelectorAll('details.pc-home-detail')[index];if(el)el.open=value;});      // «Обновить» не схлопывает раскрытое
 }

 async function load(){
  if(loading)return;loading=true;
  if(!data)panel.innerHTML='<p class="pc-context" role="status">Считаю готовность…</p>';
  try{data=await api.request('/calc/api/readiness');render();}
  catch(error){panel.innerHTML=`<div class="pc-home-error" role="alert"><strong>Не удалось получить готовность</strong><p>${esc(error.message)}</p><button type="button" id="pc-home-refresh">Повторить</button> <button type="button" id="pc-home-products">К изделиям →</button></div>`;}
  finally{loading=false;}
 }

 panel.addEventListener('toggle',event=>{if(event.target.matches?.('details.pc-home-detail'))openState=[...panel.querySelectorAll('details.pc-home-detail')].map(el=>el.open);},true);
 panel.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.id==='pc-home-refresh'){data=null;load();}
  else if(b.id==='pc-home-products')leave();
  else if(b.id==='pc-home-prices'){leave();q('#pc-open-norms')?.click();}
 });
 q('#pc-home-open')?.addEventListener('click',()=>{
  // из любого раздела — на главную: закрыть настройки, если открыты; цифры всегда свежие
  if(!q('#pc-norms-panel').hidden)q('#pc-open-norms').click();
  data=null;show();
 });
 // выбор изделия, отчёт, передача и обработка — выводят с главной
 document.addEventListener('click',event=>{
  if(isHome()&&event.target.closest('#pc-products .pc-product,#pc-project-report,#pc-sync-open,#pc-recovery-open,#pc-model-results-open'))leave();
 },true);
})();
