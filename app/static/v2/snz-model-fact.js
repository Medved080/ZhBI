import {esc} from './screen-view.js';
import {isDay} from './snz-workspace-core.js';
const clock=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function factTimestamp(date,shift,time){
 if(!isDay(date)||!/^\d{2}:\d{2}(?::\d{2})?$/.test(time))return null;
 let day=date;if(shift==='night'&&Number(time.slice(0,2))<8){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+1);day=d.toISOString().slice(0,10);}
 return day+'T'+(time.length===5?time+':00':time);
}

export function createModelFact({api,getObjectId,getPicked,getSelectionCount,getState,refreshState,clearSelection,onSaved,onBusy,isParentBusy}){
 let root=null,alive=true,open=true,data=null,key='',ticket=0,loading=false,saving=false,blocked=false,error='',message='';
 let date=today(),shift=Number(clock().slice(0,2))>=8&&Number(clock().slice(0,2))<20?'day':'night',crew='',time=clock();
 if(Number(time.slice(0,2))<8){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);date=d.toISOString().slice(0,10);}
 const path=()=>`/objects/${getObjectId()}/snz/facts/model`;
 const crews=()=>getState()?.state.crews.filter(c=>c.kind==='installation')||[];
 const currentKey=()=>JSON.stringify([getObjectId(),date,shift,crew,getState()?.revision]);
 function render(){
  if(!root?.isConnected)return;
  if(!crews().some(c=>c.id===crew))crew=crews()[0]?.id||'';
  const select=root.querySelector('[data-snzf="crew"]'),html='<option value="">Выберите бригаду</option>'+crews().map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if(select.dataset.options!==html){select.innerHTML=html;select.dataset.options=html;}
  for(const[k,v]of Object.entries({date,shift,crew,time})){const el=root.querySelector(`[data-snzf="${k}"]`);if(document.activeElement!==el)el.value=v;el.disabled=saving||isParentBusy();}
  const ids=getPicked(),byId=new Map((data?.items||[]).map(r=>[r.id,r])),invalid=ids.find(id=>!byId.has(id)||byId.get(id).kind==='blocked');
  const reason=invalid?(byId.get(invalid)?.reason||'Данные выбранных изделий обновляются.'):'';
  root.querySelector('[data-snzf-count]').textContent=`Выбрано: ${ids.length}.`;
  const result=root.querySelector('[data-snzf-result]'),text=error||message||reason||(loading?'Загрузка факта…':'');
  result.hidden=!text;result.textContent=text;result.setAttribute('role',error||reason?'alert':'status');
  root.querySelector('[data-snzf-action="save"]').disabled=saving||isParentBusy()||loading||blocked||!data?.can_fact||!getState()?.can_fact||key!==currentKey()||!ids.length||ids.length>500||getSelectionCount()>ids.length||!!invalid||!factTimestamp(date,shift,time);
  root.querySelector('[data-snzf-action="save"]').textContent=saving?'Сохранение…':'Отметить факт';
  root.querySelector('[data-snzf-action="clear"]').disabled=saving||isParentBusy()||!ids.length;
  root.querySelector('[data-snzf-action="refresh"]').disabled=saving||isParentBusy()||loading;
  root.querySelector('[data-snzf-rights]').hidden=!getState()||getState().can_fact;
 }
 async function reload(){
  if(!alive||!getState()||!isDay(date)||!shift||!crew||saving)return;
  const request=++ticket,obj=getObjectId(),wanted=currentKey();loading=true;error='';render();
  try{
   const next=await api.get(path()+'-candidates?'+new URLSearchParams({date,shift,crew_id:crew}));
   if(!alive||request!==ticket||obj!==getObjectId()||wanted!==currentKey())return;
   data=next;key=wanted;blocked=false;
  }catch(e){if(request===ticket){error=e.message||'Не удалось загрузить факт.';blocked=true;}}
  finally{if(request===ticket){loading=false;render();}}
 }
 async function save(){
  if(saving||isParentBusy()||loading||blocked||!data?.can_fact||!getState()?.can_fact||key!==currentKey())return;
  const ids=[...getPicked()],map=new Map(data.items.map(r=>[r.id,r]));
  if(!factTimestamp(date,shift,time)||getSelectionCount()>ids.length||!ids.length||ids.length>500||ids.some(id=>!map.has(id)||map.get(id).kind==='blocked'))return;
  const obj=getObjectId(),body={revision:data.revision,date,shift,crew_id:crew,completed_at:factTimestamp(date,shift,time),request_id:crypto.randomUUID().replaceAll('-',''),items:ids.map(id=>({element_id:id,expected_rev:map.get(id).expected_rev}))};
  saving=true;error='';message='';render();onBusy();
  try{
   const result=await api.post(path(),body);
   if(!alive||obj!==getObjectId())return;
   message=`Факт отмечен: ${result.confirmed.length} шт. Доп. факт вне СНЗ: ${result.extra.length} шт.`;
   await onSaved(result);key='';
  }catch(e){if(alive&&obj===getObjectId()){blocked=e.status===0||e.status===409||e.status>=500;error=e.status===0||e.status>=500?'Ответ о записи не получен. Нажмите «Обновить» и проверьте факт перед повтором.':e.message||'Не удалось записать факт.';}}
  finally{saving=false;render();onBusy();if(!blocked)reload();}
 }
 return{
  mount(host){
   root=host;host.innerHTML=`<details class="snzi-section" data-snzf-fold ${open?'open':''}><summary>Факт</summary><p data-snzf-count></p><div class="snzi-fields">
   <label class="snzi-wide">Дата<input type="date" data-snzf="date" aria-label="Дата факта СНЗ"></label>
   <label>Смена<select data-snzf="shift" aria-label="Смена факта"><option value="day">День</option><option value="night">Ночь</option></select></label>
   <label>Бригада<select data-snzf="crew" aria-label="Бригада факта"></select></label>
   <label class="snzi-wide">Время (МСК)<input type="time" step="1" data-snzf="time" aria-label="Время монтажа (МСК)"></label></div>
   <button type="button" class="snzi-button snzi-primary" data-snzf-action="save">Отметить факт</button><div class="snzi-inline-actions"><button type="button" class="snzi-button" data-snzf-action="clear">Снять выбор</button><button type="button" class="snzi-button" data-snzf-action="refresh">Обновить</button></div>
   <div class="snzi-result" data-snzf-result hidden></div><p data-snzf-rights hidden>Нет права изменять статусы на этом объекте.</p><p class="snzi-subtle">Дата — начало смены. Ночь: 20:00–08:00 следующего дня. Уже смонтированным изделиям сохраняется время истории. Для изделий вне СНЗ записывается доп. факт. Максимум 500 изделий за раз.</p></details>`;
   root.querySelector('[data-snzf-fold]').addEventListener('toggle',e=>{open=e.target.open;});
   root.addEventListener('change',e=>{const k=e.target.dataset.snzf;if(!k)return;if(k==='date')date=e.target.value;if(k==='shift')shift=e.target.value;if(k==='crew')crew=e.target.value;if(k==='time')time=e.target.value;message='';if(!blocked)error='';if(k!=='time'){key='';if(!blocked)reload();}render();});
   root.addEventListener('click',e=>{const action=e.target.closest('[data-snzf-action]')?.dataset.snzfAction;if(action==='save')save();if(action==='clear')clearSelection();if(action==='refresh'){message='';refreshState().then(()=>reload());}});
   render();if(getState())reload();
  },
  render(){render();if(!saving&&!loading&&getState()&&key!==currentKey()&&!blocked)reload();},
  isBusy:()=>saving,
  reset(){ticket++;data=null;key='';root=null;loading=false;blocked=false;error='';message='';crew='';date=today();time=clock();shift=Number(time.slice(0,2))>=8&&Number(time.slice(0,2))<20?'day':'night';if(Number(time.slice(0,2))<8){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);date=d.toISOString().slice(0,10);}},
  destroy(){alive=false;ticket++;root=null;},
 };
}
