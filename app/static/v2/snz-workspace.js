import {snzErrorIssue} from './snz-validation.js';
import { esc } from './screen-view.js';
import { scopeFor, makeAssignmentState } from './snz-workspace-core.js';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'—';
const options=(rows,key)=>rows.map(x=>`<option value="${esc(x.id)}" ${x.id===key?'selected':''}>${esc(x.name)}</option>`).join('');

export function createSnzWorkspace({api,getObjectId,getSelectedIds,getSelectionCount,getScene,send,register,openAdvanced,statusHtml,bindStatus,captureStatusFocus}) {
  let alive=true,active=false,data=null,object=null,host=null,root=null,ticket=0,loading=false,saving=false,error='',message='';
  let scopeTicket=0,dataVersion=0,visibleVersion=0;
  let mode='',date=today(),shift='day',crewId='install1',cardId='auto',page=0;
  let picked=[],holdSelection=false,sceneKey='',statusKey='',visible=null,scopeKey='',rowsKey='',refreshTimer=null;
  if (!document.querySelector('link[data-snz-workspace]')) {
    const css=document.createElement('link');css.rel='stylesheet';css.href='/static/v2/snz-workspace.css';css.dataset.snzWorkspace='';document.head.append(css);
  }
  const allById=()=>new Map((data?.elements||[]).map(e=>[e.id,e]));
  const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
  const currentRows=()=>data&&visible?data.elements.filter(e=>visible.has(e.id)):[];
  const isOpen=()=>!!root?.isConnected&&active;

  function applyScope(force=false) {
    if (!active||!data||object!==getObjectId()||!getScene()?.loaded||getScene()?.objectId!==object) return;
    const scope=scopeFor({elements:data.elements,assignments:data.state.assignments},{mode,date,shift,crewId});
    const key=JSON.stringify([object,scope.mode,scope.ids]);
    if (!force&&key===scopeKey)return;
    scopeKey=key;visible=null;rowsKey='';
    send('snzScope',{objectId:object,...scope,ticket:++scopeTicket});
    renderRegister();
  }
  async function reload() {
    if(!alive)return;
    const obj=getObjectId(),mine=++ticket;loading=true;error='';render();
    try {
      const result=await api.get(`/objects/${obj}/snz/state`);
      if(!alive||mine!==ticket||obj!==getObjectId())return;
      data=result;object=obj;dataVersion++;
      if(!result.state.crews.some(c=>c.id===crewId&&c.kind==='installation'))crewId=result.state.crews.find(c=>c.kind==='installation')?.id||'';
      if(cardId!=='auto'&&!result.state.cards.some(c=>c.id===cardId))cardId='auto';
      applyScope(true);
    } catch(e){if(mine===ticket&&obj===getObjectId())error=e.message||'Не удалось загрузить СНЗ.';}
    finally {if(mine===ticket){loading=false;render();}}
  }
  function refreshSoon(){if(!alive||!active||saving||loading||refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=null;reload();},180);}
  function syncSelect(selector,html,value){const el=root?.querySelector(selector);if(!el)return;if(el.dataset.options!==html){el.innerHTML=html;el.dataset.options=html;}if(document.activeElement!==el)el.value=value;}
  function renderStatus() {
    if(!isOpen())return;
    const s=getScene(),key=JSON.stringify([s?.selected,s?.multiIds,s?.multiItems,s?.statusOrder,statusHtml()]);
    if(key===statusKey)return;statusKey=key;
    const box=root.querySelector('[data-snzi-status]'),restore=captureStatusFocus(box);
    box.innerHTML=statusHtml();bindStatus(box);restore();
  }
  function render() {
    if(!isOpen()){renderRegister();return;}
    syncSelect('[data-snzi="crew"]','<option value="">Все бригады</option>'+options((data?.state.crews||[]).filter(c=>c.kind==='installation'),crewId),crewId);
    syncSelect('[data-snzi="card"]','<option value="auto">По справочнику автоматически</option>'+options(data?.state.cards||[],cardId),cardId);
    for(const [key,value]of Object.entries({mode,date,shift})){const el=root.querySelector(`[data-snzi="${key}"]`);if(el&&document.activeElement!==el)el.value=value;}
    root.querySelector('[data-snzi-date]').hidden=mode!=='date';
    const count=getSelectionCount(),extra=holdSelection&&picked.length?' Выбор сохранён при смене фильтра.':'';
    root.querySelector('[data-snzi-count]').textContent=`К планированию выбрано: ${picked.length}.${extra}`;
    root.querySelector('[data-snzi-hint]').textContent=mode==='date'?'Модель и реестр: готовые к монтажу на выбранную дату, смену и бригаду.':mode==='unplanned'?'Модель и реестр: готовые к монтажу без назначения даты. Смена и бригада задаются для будущего планирования.':mode==='all'?'Модель и реестр: все готовые к монтажу, независимо от даты, смены и бригады.':'Фильтр СНЗ снят. На модели и в реестре действуют только фильтры слева; назначения сохраняются.';
    root.querySelectorAll('[data-snzi]').forEach(el=>el.disabled=saving);
    const text=error||message||(loading?'Загрузка СНЗ…':'');const result=root.querySelector('[data-snzi-result]');result.hidden=!text;result.textContent=text;result.setAttribute('role',error?'alert':'status');
    root.querySelector('[data-snzi-action="plan"]').disabled=!data?.can_write||loading||saving||!!error||mode!=='date'||!date||!shift||!crewId||!picked.length||(!holdSelection&&count>picked.length);
    root.querySelector('[data-snzi-action="refresh"]').disabled=loading||saving;
    root.querySelector('[data-snzi-action="clear"]').disabled=!picked.length;
    root.querySelector('[data-snzi-action="plan"]').textContent=saving?'Сохранение…':'Запланировать';
    root.querySelector('[data-snzi-rights]').hidden=!data||data.can_write;
    renderStatus();renderRegister();
  }
  function renderRegister() {
    if(!register)return;register.hidden=!active;
    if(!active)return;
    const key=JSON.stringify([object,dataVersion,visibleVersion,loading,error,visible===null,page,picked]);
    if(key===rowsKey)return;rowsKey=key;
    const rows=currentRows(),totalPages=Math.max(1,Math.ceil(rows.length/60));page=Math.min(page,totalPages-1);
    const assignments=new Map((data?.state.assignments||[]).map(a=>[a.element_id,a]));
    const crews=new Map((data?.state.crews||[]).map(c=>[c.id,c.name]));
    const subset=rows.slice(page*60,(page+1)*60),selected=new Set(picked),locked=new Set(data?.locked_element_ids||[]);
    register.innerHTML=`<div class="snzi-head"><h3>Реестр изделий СНЗ</h3><small>${visible===null?'Обновление отбора…':`Найдено: ${rows.length} · выбрано: ${picked.length}`}</small><button type="button" data-snzi-register="select-page" ${!subset.length?'disabled':''}>Выбрать страницу</button><button type="button" data-snzi-register="prev" ${page===0?'disabled':''}>Назад</button><small>${page+1} / ${totalPages}</small><button type="button" data-snzi-register="next" ${page+1>=totalPages?'disabled':''}>Далее</button></div>
      ${subset.length?`<table class="snzi-table"><thead><tr><th>Выбор</th><th>Изделие</th><th>Тип</th><th>Этаж / оси</th><th>Статус</th><th>Дата</th><th>Смена</th><th>Бригада</th><th>Монтаж</th><th>Подготовка</th></tr></thead><tbody>${subset.map(e=>{const a=assignments.get(e.id);return `<tr aria-selected="${selected.has(e.id)}"><td><input type="checkbox" data-snzi-check="${e.id}" ${selected.has(e.id)?'checked':''} aria-label="Выбрать ${esc(e.mark||e.id)}"></td><td><button class="snzi-locate" data-snzi-locate="${e.id}">${esc(e.mark||'ID '+e.id)}</button>${locked.has(e.id)?' · выдано':''}</td><td>${esc(e.element_type)}</td><td>${esc(e.floor??'—')} / ${esc(e.address||'—')}</td><td>${esc(getScene()?.statusLabels?.[e.current_status]||e.current_status)}</td><td>${day(a?.date)}</td><td>${a?(a.shift==='day'?'День':'Ночь'):'—'}</td><td>${esc(a?crews.get(a.crew_id)||a.crew_id:'—')}</td><td>${a?.priority??'—'}</td><td>${a?.prep_priority??'—'}</td></tr>`}).join('')}</tbody></table>`:`<p class="snzi-empty">${visible===null?'Ожидается отбор модели.':'Нет изделий, удовлетворяющих одновременно фильтрам слева и условиям СНЗ.'}</p>`}`;
  }
  function setPicked(ids,notify=true){picked=[...new Set(ids)];holdSelection=false;rowsKey='';if(notify)send('snzSelect',{objectId:getObjectId(),ids:picked});render();}
  function bindRegister(){
    register.addEventListener('change',e=>{const t=e.target.closest('[data-snzi-check]');if(!t)return;const id=Number(t.dataset.snziCheck),next=new Set(picked);t.checked?next.add(id):next.delete(id);setPicked([...next]);});
    register.addEventListener('click',e=>{const locate=e.target.closest('[data-snzi-locate]');if(locate){const id=Number(locate.dataset.snziLocate);setPicked([id]);send('locate',{id});return;}const b=e.target.closest('[data-snzi-register]');if(!b)return;const a=b.dataset.snziRegister;if(a==='next')page++;if(a==='prev')page--;if(a==='select-page')setPicked(currentRows().slice(page*60,(page+1)*60).map(e=>e.id));rowsKey='';renderRegister();});
  }
  async function planPicked(){
    if(saving||loading||!data?.can_write)return;
    let body;try{body=makeAssignmentState(data,picked,{date,shift,crewId,cardId});}catch(e){error=e.message;render();return;}
    saving=true;error='';message='';render();const obj=getObjectId();
    try {
      await api.put(`/objects/${obj}/snz/state`,body);
      if(obj!==getObjectId()||!alive)return;
      message=`Запланировано изделий: ${picked.length}. ${day(date)} · ${shift==='day'?'День':'Ночь'}.`;
      await reload();
      if(obj===getObjectId()&&alive){
        const assigned=new Map((data?.state.assignments||[]).map(a=>[a.element_id,a]));
        for(let start=0;start<picked.length;start+=3000)send('applyElements',{items:picked.slice(start,start+3000).map(id=>({id,planned_installation_date:assigned.get(id)?.date||null}))});
        send('snzSelect',{objectId:obj,ids:picked});
      }
    } catch(e){if(obj===getObjectId()&&alive)error=(e.status===0||e.status>=500)?'Ответ о сохранении не получен. Нажмите «Обновить» и проверьте назначения в реестре перед повтором.':snzErrorIssue(e,data?.state||{})?.message||e.message||'Не удалось запланировать изделия.';}
    finally {saving=false;render();}
  }
  function mount(nextHost){
    host=nextHost;
    if(!host.querySelector('[data-snzi-root]')){
      host.innerHTML=`<section class="snzi-panel" data-snzi-root><h3>Сменные наряд-задания</h3><p>Выбирайте изделия непосредственно на модели или в реестре снизу.</p><div class="snzi-status snzi-section" data-snzi-status></div><section class="snzi-section"><h4>Планирование и отбор</h4><p data-snzi-count></p><div class="snzi-fields">
        <label class="snzi-wide">Дата<select data-snzi="mode"><option value="">Удалить фильтр (пусто)</option><option value="unplanned">Без даты</option><option value="all">Все</option><option value="date">Конкретная дата</option></select></label>
        <label class="snzi-wide" data-snzi-date>Дата смены<input type="date" data-snzi="date" value="${date}"></label>
        <label>Смена<select data-snzi="shift"><option value="">Все смены</option><option value="day">День</option><option value="night">Ночь</option></select></label><label>Бригада<select data-snzi="crew"></select></label>
        <label class="snzi-wide">Карта для назначения<select data-snzi="card"></select></label></div><button type="button" class="snzi-button snzi-primary" data-snzi-action="plan">Запланировать</button><div class="snzi-inline-actions"><button type="button" class="snzi-button" data-snzi-action="clear">Снять выбор</button><button type="button" class="snzi-button" data-snzi-action="refresh">Обновить</button></div><div class="snzi-result" data-snzi-result hidden></div><p data-snzi-hint></p><p data-snzi-rights hidden>Нет права изменять плановые даты на этом объекте.</p><p class="snzi-subtle">Условия СНЗ дополняют все существующие фильтры слева. «Удалить фильтр» не удаляет назначений.</p></section><section class="snzi-section"><button type="button" class="snzi-button" data-snz-open>Открыть планирование СНЗ</button><p>Справочники, узлы ригелей, расчёт и выдача документов.</p></section></section>`;
      root=host.querySelector('[data-snzi-root]');statusKey='';
      root.addEventListener('change',e=>{const k=e.target.dataset.snzi;if(!k)return;const value=e.target.value;
        if(picked.length)holdSelection=true;
        if(k==='mode')mode=value;if(k==='date')date=value;if(k==='shift')shift=value;if(k==='crew')crewId=value;if(k==='card')cardId=value;
        error='';message='';page=0;if(k!=='card')applyScope();render();});
      root.addEventListener('click',e=>{if(e.target.closest('[data-snz-open]')){openAdvanced();return;}const a=e.target.closest('[data-snzi-action]')?.dataset.snziAction;if(a==='refresh')reload();if(a==='plan')planPicked();if(a==='clear'){setPicked([]);send('clearSelection');}});
    }else root=host.querySelector('[data-snzi-root]');
    render();
  }
  bindRegister();
  return {
    mount,
    activate(value){if(value===active)return;active=value;register.hidden=!value;statusKey='';if(value){picked=getSelectedIds();holdSelection=false;if(!data||object!==getObjectId())reload();else applyScope(true);}else{send('snzScope',{objectId:getObjectId(),mode:'',ids:null,ticket:++scopeTicket});scopeKey='';visible=null;root=null;}},
    onScene(scene){if(scene.objectId!==getObjectId())return;const ids=getSelectedIds(),key=ids.join(',');if(key!==sceneKey){sceneKey=key;picked=[...ids];holdSelection=false;}if(data){const map=allById();for(const e of [scene.selected,...(scene.multiItems||[])])if(e&&map.has(e.id)){const old=map.get(e.id);if(Object.entries(e).some(([k,v])=>old[k]!==v)){Object.assign(old,e);dataVersion++;}}}if(active){applyScope();render();}},
    onVisible(ids,obj,receivedTicket){if(obj!==getObjectId()||!active||receivedTicket!==scopeTicket)return;const next=new Set(ids);if(visible&&same([...visible],[...next]))return;visible=next;visibleVersion++;rowsKey='';renderRegister();},
    onElements(items){if(data){const map=allById();for(const x of items)if(map.has(x.id))Object.assign(map.get(x.id),x);dataVersion++;scopeKey='';applyScope();rowsKey='';render();}},
    reload,refreshSoon,
    selectedIds:()=>[...picked],
    clearSelection(){setPicked([],false);},
    isBusy:()=>saving,
    reset(){active=false;ticket++;clearTimeout(refreshTimer);refreshTimer=null;data=null;object=null;picked=[];holdSelection=false;sceneKey='';statusKey='';visible=null;scopeKey='';rowsKey='';error='';message='';loading=false;mode='';date=today();shift='day';crewId='install1';cardId='auto';root=null;if(register){register.innerHTML='';register.hidden=true;}},
    destroy(){alive=false;ticket++;clearTimeout(refreshTimer);},
  };
}
