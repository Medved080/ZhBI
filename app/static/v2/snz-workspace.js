import {snzErrorIssue} from './snz-validation.js';
import {esc} from './screen-view.js';
import {scopeFor, makeAssignmentState, editAssignmentState, isDay, READY} from './snz-workspace-core.js';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=v=>v?String(v).slice(0,10).split('-').reverse().join('.'):'—';
const options=(rows,key)=>rows.map(x=>`<option value="${esc(x.id)}" ${x.id===key?'selected':''}>${esc(x.name)}</option>`).join('');

export function createSnzWorkspace({api,getObjectId,getSelectedIds,getSelectionCount,getScene,send,register,openAdvanced,statusHtml,bindStatus,captureStatusFocus}) {
  let alive=true,active=false,data=null,object=null,root=null,ticket=0,loading=false,saving=false,error='',message='',writeBlocked=false;
  let scopeTicket=0,dataVersion=0,visibleVersion=0;
  let mode='',filterDate=today(),date=today(),shift='day',crewId='install1',page=0,statusOpen=false,filterOpen=true,planningOpen=true,filterCrew='',filterShift='';
  let picked=[],holdSelection=false,sceneKey='',statusKey='',visible=null,scopeKey='',rowsKey='',refreshTimer=null;
  if(!document.querySelector('link[data-snz-workspace]')){
    const css=document.createElement('link');css.rel='stylesheet';css.href='/static/v2/snz-workspace.css';css.dataset.snzWorkspace='';document.head.append(css);
  }
  const allById=()=>new Map((data?.elements||[]).map(e=>[e.id,e]));
  const same=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
  const currentRows=()=>data&&visible?data.elements.filter(e=>visible.has(e.id)):[];
  const isOpen=()=>!!root?.isConnected&&active;
  const installationCrews=()=>data?.state.crews.filter(c=>c.kind==='installation')||[];

  function applyScope(force=false){
    if(!active||!data||object!==getObjectId()||!getScene()?.loaded||getScene()?.objectId!==object)return;
    const scope=scopeFor({elements:data.elements,assignments:data.state.assignments},{mode,date:filterDate,shift:filterShift,crewId:filterCrew});
    const key=JSON.stringify([object,scope.mode,scope.ids]);
    if(!force&&key===scopeKey)return;
    scopeKey=key;visible=null;rowsKey='';
    send('snzScope',{objectId:object,...scope,ticket:++scopeTicket});
    renderRegister();
  }
  async function reload(){
    if(!alive)return false;
    const obj=getObjectId(),mine=++ticket;loading=true;error='';render();
    try{
      const result=await api.get(`/objects/${obj}/snz/state`);
      if(!alive||mine!==ticket||obj!==getObjectId())return false;
      data=result;object=obj;dataVersion++;writeBlocked=false;
      if(crewId&&!installationCrews().some(c=>c.id===crewId))crewId=installationCrews()[0]?.id||'';
      applyScope(true);return true;
    }catch(e){if(mine===ticket&&obj===getObjectId()){error=e.message||'Не удалось загрузить СНЗ.';writeBlocked=true;}return false;}
    finally{if(mine===ticket){loading=false;render();}}
  }
  function refreshSoon(){if(!alive||!active||saving||loading||refreshTimer)return;refreshTimer=setTimeout(()=>{refreshTimer=null;reload();},180);}
  function syncSelect(selector,html,value){
    const el=root?.querySelector(selector);if(!el)return;
    if(el.dataset.options!==html){el.innerHTML=html;el.dataset.options=html;}
    if(document.activeElement!==el)el.value=value;
  }
  function renderStatus(){
    if(!isOpen())return;
    const s=getScene(),html=statusHtml(),key=JSON.stringify([s?.selected,s?.multiIds,s?.multiItems,s?.statusOrder,html]);
    if(key===statusKey)return;statusKey=key;
    const box=root.querySelector('[data-snzi-status]'),restore=captureStatusFocus(box);
    box.innerHTML=html;bindStatus(box);restore();
  }
  function render(){
    if(!isOpen()){renderRegister();return;}
    syncSelect('[data-snzi="crew"]',options(installationCrews(),crewId),crewId);
    syncSelect('[data-snzi="filterCrew"]','<option value="">Все</option><option value="none">Не назначено</option>'+options(installationCrews(),filterCrew),filterCrew);
    for(const[key,value]of Object.entries({mode,date,filterDate,shift,filterShift})){
      const el=root.querySelector(`[data-snzi="${key}"]`);if(el&&document.activeElement!==el)el.value=value;
    }
    root.querySelector('[data-snzi-filter-date]').hidden=mode!=='date';
    const byId=allById(),lockedIds=new Set(data?.locked_element_ids||[]),count=getSelectionCount(),blocked=picked.some(id=>lockedIds.has(id)||byId.get(id)?.current_status!==READY),extra=holdSelection&&picked.length?' Выбор сохранён при смене отбора.':'';
    root.querySelector('[data-snzi-count]').textContent=`Выбрано: ${picked.length}.${extra}${visible?` Показано в реестре: ${visible.size}.`:''}`;
    root.querySelector('[data-snzi-hint]').textContent='Отбор дополняет фильтры слева. Бригада и смена отбирают существующие назначения. Пустая дата снимает только отбор по дате СНЗ.';
    root.querySelectorAll('[data-snzi]').forEach(el=>el.disabled=saving);
    root.querySelector('[data-snzi-status]').disabled=saving;
    const text=error||message||(loading?'Загрузка СНЗ…':''),result=root.querySelector('[data-snzi-result]');
    result.hidden=!text;result.textContent=text;result.setAttribute('role',error?'alert':'status');
    root.querySelector('[data-snzi-action="plan"]').disabled=!data?.can_write||loading||saving||writeBlocked||!isDay(date)||!shift||!crewId||!picked.length||count>picked.length||blocked;
    root.querySelector('[data-snzi-action="refresh"]').disabled=loading||saving;
    root.querySelector('[data-snzi-action="clear"]').disabled=!picked.length||saving;
    root.querySelector('[data-snzi-action="plan"]').textContent=saving?'Сохранение…':'Запланировать';
    root.querySelector('[data-snzi-rights]').hidden=!data||data.can_write;
    renderStatus();renderRegister();
  }
  function rowHtml(e,assignments,selected,locked){
    const a=assignments.get(e.id),disabled=!data.can_write||loading||saving||writeBlocked||locked.has(e.id)||e.current_status!==READY?'disabled':'';
    const rowInput=(field,value,attrs)=>`<input data-snzi-row="${field}" data-id="${e.id}" value="${esc(value??'')}" aria-label="${field==='date'?'Дата':field==='priority'?'Очередность':field} ${esc(e.mark||e.id)}" ${attrs} ${disabled}>`;
    const rowSelect=(field,rows,value,label)=>`<select data-snzi-row="${field}" data-id="${e.id}" aria-label="${label} ${esc(e.mark||e.id)}" ${disabled}>${options(rows,value)}</select>`;
    return `<tr aria-selected="${selected.has(e.id)}">
      <td><input type="checkbox" data-snzi-check="${e.id}" ${selected.has(e.id)?'checked':''} aria-label="Выбрать ${esc(e.mark||e.id)}"></td>
      <td><button class="snzi-locate" data-snzi-locate="${e.id}">${esc(e.mark||'ID '+e.id)}</button>${locked.has(e.id)?' · выдано':''}${e.transfer_from?`<small>Перенос с ${esc(e.transfer_from.split('-').reverse().join('.'))}</small>`:''}</td>
      <td>${esc(e.element_type)}</td><td>${esc(e.floor??'—')} / ${esc(e.address||'—')}</td><td>${esc(getScene()?.statusLabels?.[e.current_status]||e.current_status)}</td>
      <td>${rowInput('date',a?.date,'type="date"')}</td>
      <td>${rowSelect('shift',[{id:'day',name:'День'},{id:'night',name:'Ночь'}],a?.shift||shift||'day','Смена')}</td>
      <td>${rowSelect('crew_id',installationCrews(),a?.crew_id||crewId||installationCrews()[0]?.id,'Бригада')}</td>
      <td>${rowInput('priority',a?.priority,'type="number" min="1" max="1000000" step="1"')}</td><td>${a?'Авто':'—'}</td></tr>`;
  }
  function renderRegister(){
    if(!register)return;register.hidden=!active;if(!active)return;
    // Frequent scene snapshots must not replace an input while the user edits it.
    if(!saving&&register.contains(document.activeElement)&&document.activeElement.matches('[data-snzi-row]'))return;
    const key=JSON.stringify([object,dataVersion,visibleVersion,loading,saving,writeBlocked,error,visible===null,page,picked,shift,crewId]);
    if(key===rowsKey)return;rowsKey=key;
    const rows=currentRows(),totalPages=Math.max(1,Math.ceil(rows.length/60));page=Math.min(page,totalPages-1);
    const assignments=new Map((data?.state.assignments||[]).map(a=>[a.element_id,a]));
    const subset=rows.slice(page*60,(page+1)*60),selected=new Set(picked),locked=new Set(data?.locked_element_ids||[]);
    const scroll={top:register.scrollTop,left:register.scrollLeft};
    register.setAttribute('aria-label',`Реестр изделий СНЗ, найдено: ${rows.length}`);
    register.innerHTML=`<table class="snzi-table"><thead><tr>
      <th><label>Выбор <input type="checkbox" data-snzi-page aria-label="Выбрать страницу" ${subset.length&&subset.every(e=>selected.has(e.id))?'checked':''} ${!subset.length?'disabled':''}></label></th>
      <th>Изделие</th><th>Тип</th><th>Этаж / оси</th><th>Статус</th><th>Дата</th><th>Смена</th><th>Бригада</th><th>Очередность</th><th>Подготовка</th>
      </tr></thead><tbody>${subset.length?subset.map(e=>rowHtml(e,assignments,selected,locked)).join(''):`<tr><td colspan="10" class="snzi-empty">${visible===null?'Ожидается отбор модели.':'Нет изделий, удовлетворяющих одновременно фильтрам слева и условиям СНЗ.'}</td></tr>`}</tbody></table>
      ${totalPages>1?`<div class="snzi-pagination"><small>Найдено: ${rows.length} · ${page+1} / ${totalPages}</small><button type="button" data-snzi-register="prev" ${page===0?'disabled':''}>Назад</button><button type="button" data-snzi-register="next" ${page+1>=totalPages?'disabled':''}>Далее</button></div>`:''}`;
    register.scrollTop=scroll.top;register.scrollLeft=scroll.left;
  }
  function setPicked(ids,notify=true){
    picked=[...new Set(ids)];holdSelection=false;rowsKey='';
    if(notify)send('snzSelect',{objectId:getObjectId(),ids:picked});render();
  }
  function bindRegister(){
    register.addEventListener('change',e=>{
      const row=e.target.closest('[data-snzi-row]');
      if(row){const value=row.dataset.snziRow==='priority'?(row.value===''?null:Number(row.value)):row.value;row.blur();editRow(Number(row.dataset.id),row.dataset.snziRow,value);return;}
      const t=e.target.closest('[data-snzi-check]');
      if(t){const id=Number(t.dataset.snziCheck),next=new Set(picked);t.checked?next.add(id):next.delete(id);setPicked([...next]);return;}
      if(e.target.matches('[data-snzi-page]')){
        const next=new Set(picked);for(const row of currentRows().slice(page*60,(page+1)*60))e.target.checked?next.add(row.id):next.delete(row.id);setPicked([...next]);
      }
    });
    register.addEventListener('click',e=>{
      const locate=e.target.closest('[data-snzi-locate]');if(locate){const id=Number(locate.dataset.snziLocate);setPicked([id]);send('locate',{id});return;}
      const action=e.target.closest('[data-snzi-register]')?.dataset.snziRegister;if(!action)return;
      page+=action==='next'?1:-1;rowsKey='';renderRegister();
    });
  }
  async function persist(body,ids,text){
    if(saving||loading||writeBlocked||!data?.can_write)return;
    saving=true;error='';message='';render();const obj=getObjectId(),selection=[...picked];
    try{
      const result=await api.put(`/objects/${obj}/snz/state`,body);
      if(obj!==getObjectId()||!alive)return;
      // Reflect only the state confirmed by PUT, even if the following GET fails.
      const{revision,...confirmed}=body;data={...data,revision:result.revision,state:{...confirmed,facts:data.state.facts}};dataVersion++;
      const assigned=new Map(body.assignments.map(a=>[a.element_id,a]));
      for(let start=0;start<ids.length;start+=3000)send('applyElements',{items:ids.slice(start,start+3000).map(id=>({id,planned_installation_date:assigned.get(id)?.date||null}))});
      message=text;await reload();
      if(obj===getObjectId()&&alive&&same(picked,selection))send('snzSelect',{objectId:obj,ids:picked});
    }catch(e){
      if(obj===getObjectId()&&alive){
        writeBlocked=e.status===0||e.status===409||e.status>=500;
        error=(e.status===0||e.status>=500)?'Ответ о сохранении не получен. Нажмите «Обновить» и проверьте назначения перед повтором.':snzErrorIssue(e,data?.state||{})?.message||e.message||'Не удалось сохранить назначение.';
      }
    }finally{saving=false;rowsKey='';render();}
  }
  function planPicked(){
    if(saving||loading||writeBlocked||!data?.can_write)return;
    try{const ids=[...picked],body=makeAssignmentState(data,ids,{date,shift,crewId});persist(body,ids,`Запланировано изделий: ${ids.length}. ${day(date)} · ${shift==='day'?'День':'Ночь'}.`);}
    catch(e){error=e.message;render();}
  }
  function editRow(id,field,value){
    if(saving||loading||writeBlocked||!data?.can_write)return;
    try{const body=editAssignmentState(data,id,field,value,{shift,crewId});persist(body,[id],'Назначение изделия сохранено.');}
    catch(e){error=e.message;rowsKey='';render();}
  }
  function mount(host){
    if(!host.querySelector('[data-snzi-root]')){
      host.innerHTML=`<section class="snzi-panel" data-snzi-root>
        <h3>Сменные наряд-задания</h3><button type="button" class="snzi-button" data-snz-open>Открыть планирование СНЗ</button>
        <details class="snzi-section snzi-status" data-snzi-fold ${statusOpen?'open':''}><summary>Изменить статус</summary><fieldset data-snzi-status></fieldset></details>
        <details class="snzi-section" data-snzi-filter-fold ${filterOpen?'open':''}><summary>Отбор</summary><div class="snzi-fields">
        <label class="snzi-wide">Дата<select data-snzi="mode" aria-label="Дата отбора СНЗ"><option value="">Удалить фильтр (пусто)</option><option value="unplanned">Без даты</option><option value="all">Все</option><option value="date">Конкретная дата</option></select></label>
        <label class="snzi-wide" data-snzi-filter-date>Дата отбора<input type="date" data-snzi="filterDate" aria-label="Дата отбора" value="${filterDate}"></label>
        <label>Бригада<select data-snzi="filterCrew" aria-label="Бригада (отбор)"></select></label>
        <label>Смена<select data-snzi="filterShift" aria-label="Смена (отбор)"><option value="">Все</option><option value="none">Не назначено</option><option value="day">День</option><option value="night">Ночь</option></select></label>
        </div><p data-snzi-hint></p></details>
        <details class="snzi-section" data-snzi-planning-fold ${planningOpen?'open':''}><summary>Планирование</summary><p data-snzi-count></p><div class="snzi-fields">
        <label class="snzi-wide">Дата<input type="date" data-snzi="date" aria-label="Дата" value="${date}"></label>
        <label>Смена<select data-snzi="shift" aria-label="Смена планирования"><option value="day">День</option><option value="night">Ночь</option></select></label>
        <label>Бригада<select data-snzi="crew" aria-label="Бригада планирования"></select></label></div>
        <button type="button" class="snzi-button snzi-primary" data-snzi-action="plan">Запланировать</button>
        <div class="snzi-inline-actions"><button type="button" class="snzi-button" data-snzi-action="clear">Снять выбор</button><button type="button" class="snzi-button" data-snzi-action="refresh">Обновить</button></div>
        <div class="snzi-result" data-snzi-result hidden></div><p data-snzi-rights hidden>Нет права изменять плановые даты на этом объекте.</p>
        <p class="snzi-subtle">Дата, смена, бригада и очередность в строках реестра сохраняются при изменении. Для нового назначения сначала укажите дату. Неоднозначную карту уточните в расширенном планировании.</p>
        </details></section>`;
      root=host.querySelector('[data-snzi-root]');statusKey='';
      root.querySelector('[data-snzi-fold]').addEventListener('toggle',e=>{statusOpen=e.target.open;});
      root.querySelector('[data-snzi-filter-fold]').addEventListener('toggle',e=>{filterOpen=e.target.open;});
      root.querySelector('[data-snzi-planning-fold]').addEventListener('toggle',e=>{planningOpen=e.target.open;});
      root.addEventListener('change',e=>{
        const k=e.target.dataset.snzi;if(!k)return;const value=e.target.value;
        const filtering=['mode','filterDate','filterCrew','filterShift'].includes(k);
        if(picked.length&&filtering)holdSelection=true;
        if(k==='mode')mode=value;if(k==='filterDate')filterDate=value;if(k==='filterCrew')filterCrew=value;if(k==='filterShift')filterShift=value;
        if(k==='date')date=value;if(k==='shift')shift=value;if(k==='crew')crewId=value;
        if(!writeBlocked)error='';message='';if(filtering){page=0;applyScope();}render();
      });
      root.addEventListener('click',e=>{
        if(e.target.closest('[data-snz-open]')){openAdvanced();return;}
        const action=e.target.closest('[data-snzi-action]')?.dataset.snziAction;
        if(action==='refresh')reload();if(action==='plan')planPicked();if(action==='clear'){setPicked([]);send('clearSelection');}
      });
    }else root=host.querySelector('[data-snzi-root]');
    render();
  }
  bindRegister();
  return{
    mount,
    activate(value){
      if(value===active)return;active=value;register.hidden=!value;statusKey='';
      if(value){picked=getSelectedIds();holdSelection=false;if(!data||object!==getObjectId())reload();else applyScope(true);}
      else{send('snzScope',{objectId:getObjectId(),mode:'',ids:null,ticket:++scopeTicket});scopeKey='';visible=null;root=null;}
    },
    onScene(scene){
      if(scene.objectId!==getObjectId())return;
      const ids=getSelectedIds(),key=ids.join(',');if(key!==sceneKey){sceneKey=key;picked=[...ids];holdSelection=false;const a=data?.state.assignments.find(a=>ids.length===1&&a.element_id===ids[0]);if(a){date=a.date;shift=a.shift;crewId=a.crew_id;}}
      if(data){const map=allById();for(const e of[scene.selected,...(scene.multiItems||[])])if(e&&map.has(e.id)){const old=map.get(e.id);if(Object.entries(e).some(([k,v])=>old[k]!==v)){Object.assign(old,e);dataVersion++;}}}
      if(active){applyScope();render();}
    },
    onVisible(ids,obj,receivedTicket){
      if(obj!==getObjectId()||!active||receivedTicket!==scopeTicket)return;
      const next=new Set(ids);if(visible&&same([...visible],[...next]))return;
      visible=next;visibleVersion++;rowsKey='';render();
    },
    onElements(items){
      if(data){const map=allById();for(const x of items)if(map.has(x.id))Object.assign(map.get(x.id),x);dataVersion++;scopeKey='';applyScope();rowsKey='';render();}
    },
    reload,refreshSoon,selectedIds:()=>[...picked],clearSelection(){setPicked([],false);},isBusy:()=>saving,
    reset(){active=false;ticket++;clearTimeout(refreshTimer);refreshTimer=null;data=null;object=null;picked=[];holdSelection=false;sceneKey='';statusKey='';visible=null;scopeKey='';rowsKey='';error='';message='';loading=false;writeBlocked=false;mode='';filterCrew='';filterShift='';date=today();filterDate=today();shift='day';crewId='install1';root=null;if(register){register.innerHTML='';register.hidden=true;}},
    destroy(){alive=false;ticket++;clearTimeout(refreshTimer);},
  };
}
