import {esc} from './screen-view.js';

// Reuses the existing model and all its standard filters; no second scene or geometry copy.
export function createExtraFactPicker({api,host,getObjectId,getSelectedIds,send,onDone}){
  let panel=null,scope=null,data=null,busy=false,blocked=false,ticket=0,requestId='',error='';
  const uid=()=>crypto.randomUUID().replaceAll('-','');
  const path=()=>`/objects/${scope.object}/snz/facts/extra`;
  function close(){send('snzFactColors',{items:[]});ticket++;panel?.remove();panel=null;scope=null;data=null;busy=false;blocked=false;}
  function returnToFacts(){const back=scope?.onReturn;close();onDone?.();back?.();}
  function update(){
    if(!panel)return;
    const ids=getSelectedIds(),allowed=new Set((data?.items||[]).map(r=>r.id)),valid=ids.filter(id=>allowed.has(id));
    panel.querySelector('[data-extra-count]').textContent=`Выбрано: ${ids.length} · доступно для записи: ${valid.length}`;
    panel.querySelector('[data-extra-save]').disabled=busy||blocked||!data?.can_fact||!ids.length||ids.length>500||valid.length!==ids.length||!panel.querySelector('[data-extra-crew]').value||!panel.querySelector('[data-extra-shift]').value;
    panel.querySelector('[data-extra-alert]').textContent=error||(ids.length&&valid.length!==ids.length?'В выборе есть позиции СНЗ этой даты или уже зарегистрированный доп. факт. Снимите их выбор.':'');
  }
  async function refresh(){
    if(!scope||busy)return;
    const target=scope.object,request=++ticket;
    busy=true;error='';panel.querySelectorAll('select,[data-extra-refresh]').forEach(e=>e.disabled=true);update();
    try{
      const result=await api.get(path()+'-candidates?'+new URLSearchParams({date:scope.date,...((panel.querySelector('[data-extra-crew]').value||scope.crewId)?{crew_id:panel.querySelector('[data-extra-crew]').value||scope.crewId}:{}),...((panel.querySelector('[data-extra-shift]').value||scope.shift)?{shift:panel.querySelector('[data-extra-shift]').value||scope.shift}:{})}));
      if(request!==ticket||target!==getObjectId()||!panel)return;
      data=result;send('snzFactColors',{items:data.planned||[]});blocked=false;requestId=uid();
      const select=panel.querySelector('[data-extra-crew]'),previous=select.value||scope.crewId;
      select.innerHTML='<option value="">Выберите бригаду</option>'+data.crews.map(c=>`<option value="${esc(c.id)}" ${c.id===previous?'selected':''}>${esc(c.name)}</option>`).join('');
    }catch(e){if(request===ticket)error=e.message||'Не удалось загрузить доступные изделия.';}
    finally{if(request===ticket){busy=false;panel?.querySelectorAll('select,[data-extra-refresh]').forEach(e=>e.disabled=false);update();}}
  }
  async function save(){
    const crew=panel.querySelector('[data-extra-crew]'),time=panel.querySelector('[data-extra-time]');
    if(busy||blocked||!crew.reportValidity()||!time.reportValidity()||!data?.can_fact)return;
    const allowed=new Map(data.items.map(r=>[r.id,r])),ids=getSelectedIds();
    if(!ids.length||ids.some(id=>!allowed.has(id)))return;
    const body={revision:data.revision,date:scope.date,crew_id:crew.value,shift:panel.querySelector('[data-extra-shift]').value,completed_at:time.value||null,request_id:requestId,
      items:ids.map(element_id=>({element_id,expected_rev:allowed.get(element_id).expected_rev}))};
    busy=true;error='';update();
    panel.querySelectorAll('input,select,[data-extra-cancel],[data-extra-refresh]').forEach(e=>e.disabled=true);
    try{await api.post(path(),body);send('poll');send('clearSelection');returnToFacts();}
    catch(e){error=e.message||'Результат записи неизвестен. Обновите данные перед повтором.';blocked=!e.status||e.status===409||e.status>=500;}
    finally{if(panel){busy=false;panel.querySelectorAll('input,select,[data-extra-cancel],[data-extra-refresh]').forEach(e=>e.disabled=false);update();}}
  }
  return {
    open(next){
      close();scope={...next,object:getObjectId()};requestId=uid();
      panel=document.createElement('section');panel.className='snz-extra-panel';panel.setAttribute('aria-label','Дополнительный факт на модели');
      panel.innerHTML=`<h3>Доп. факт вне СНЗ</h3><p>Выберите изделия на схеме. Стандартные фильтры доступны в панели отбора.</p><p>Дата начала смен: <strong>${esc(scope.date)}</strong></p>
        <label>Смена<select data-extra-shift required><option value="">Выберите смену</option><option value="day" ${scope.shift==='day'?'selected':''}>День · 08:00–20:00</option><option value="night" ${scope.shift==='night'?'selected':''}>Ночь · 20:00–08:00</option></select></label><label>Бригада<select data-extra-crew required><option value="">Загрузка…</option></select></label>
        <label>Дата и время монтажа (МСК)<input type="datetime-local" step="1" data-extra-time></label><small>Пусто - сейчас. Время должно попадать с 08:00 выбранной даты до 08:00 следующего дня.</small>
        <p>Тёмно-зелёный — монтаж по СНЗ; серый — без монтажа по СНЗ; цвет статуса «Смонтирован» — прочий монтаж. Уже смонтированным изделиям сохраняется время из истории.</p><p data-extra-count role="status"></p><p class="ws-err" data-extra-alert role="alert"></p>
        <div class="ws-actions"><button type="button" class="v2-btn v2-primary" data-extra-save disabled>Записать доп. факт</button><button type="button" class="v2-btn" data-extra-refresh>Обновить</button><button type="button" class="v2-btn" data-extra-cancel>Вернуться к факту</button></div>`;
      host.replaceChildren(panel);panel.querySelector('[data-extra-save]').addEventListener('click',save);
      panel.querySelector('[data-extra-refresh]').addEventListener('click',refresh);
      panel.querySelector('[data-extra-cancel]').addEventListener('click',()=>{if(!busy)returnToFacts();});
      panel.querySelector('[data-extra-crew]').addEventListener('change',refresh);panel.querySelector('[data-extra-shift]').addEventListener('change',refresh);send('clearSelection');refresh();
    },
    update,
    isOpen:()=>!!panel,
    guardLeave:()=>{if(busy)return false;if(panel&&!window.confirm('Закрыть выбор дополнительного факта без записи?'))return false;close();return true;},
    destroy:close,
  };
}
