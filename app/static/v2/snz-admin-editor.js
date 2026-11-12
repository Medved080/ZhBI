import {esc} from './screen-view.js';
const uid=()=>crypto.randomUUID().replaceAll('-','');
const now=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date()).replace(' ','T');
const opts=(rows,value)=>rows.map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(r.name)}</option>`).join('');
const value=v=>v==null?'':v;
export function diffHtml(rows){
 const stamp=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(s)?s.slice(0,10).split('-').reverse().join('.')+' '+s.slice(11,19):s;
 const show=v=>v==null?'—':typeof v==='boolean'?(v?'100 %':'0 %'):Array.isArray(v)?v.map(pair=>Array.isArray(pair)?pair.map(stamp).join(' — '):String(pair)).join('; '):typeof v==='object'?JSON.stringify(v):stamp(String(v));
 return `<div class="snz-table-wrap"><table class="snz-table snz-diff"><thead><tr><th>Изделие</th><th>Операция</th><th>Показатель</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.mark||'Документ')}${r.element_id?` · ID ${r.element_id}`:''}</td><td>${esc(r.operation)}</td><td>${esc(r.field)}</td><td>${esc(show(r.before))}</td><td>${esc(show(r.after))}</td></tr>`).join('')||'<tr><td colspan="5">Изменений состава и плановых показателей не зафиксировано.</td></tr>'}</tbody></table></div>`;
}
export const historyTime=s=>{if(!s)return '—';const text=/Z$|[+-]\d\d:\d\d$/.test(s)?s:s.replace(' ','T')+'Z';const d=new Date(text);return Number.isNaN(d.getTime())?s:new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'medium'}).format(d);};

export function createAdminEditor({api,path,getData,run,render,onSaved,previewHtml}){
 let ctx=null,rows=[],reason='',preview=null,changed=false,blocked=false,query='',page=0;
 const active=()=>!!ctx;
 const dirty=()=>!!ctx&&changed;
 const reset=()=>{ctx=null;rows=[];reason='';preview=null;changed=false;blocked=false;query='';page=0;};
 const invalidate=()=>{changed=true;preview=null;};
 function cardSteps(cardId){
  const card=ctx.cards.find(c=>c.id===cardId),ops=new Map(ctx.operations.map(o=>[o.id,o]));
  return (card?.steps||[]).filter(s=>(ops.get(s.operation_id)?.scope==='preparation')===(ctx.order.crew.kind==='preparation')).map(s=>({operation_id:s.operation_id,minutes:s.minutes,wait_after:s.wait_after||0,team_id:ops.get(s.operation_id).team,planned_start:null,completed:false,completed_at:null}));
 }
 function applyCard(row,cardId){
  const previous=new Map(row.steps.map(s=>[s.operation_id,s]));row.card_id=cardId||null;if(!cardId)return;
  row.steps=cardSteps(cardId).map(s=>({...s,completed:previous.get(s.operation_id)?.completed||false,completed_at:previous.get(s.operation_id)?.completed_at||null}));
 }
 function html(){
  if(!ctx)return '';
  const chosen=new Set(rows.map(p=>p.element_id)),members=new Map([...ctx.elements,...(ctx.order.items||[]),...ctx.order.tasks.flatMap(t=>t.elements)].map(e=>[e.id,e]));
  const candidates=ctx.elements.filter(e=>e.is_current&&!chosen.has(e.id)&&(!query||[e.mark,e.id,e.element_type,e.address].join(' ').toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))).slice(0,100);
  const pages=Math.max(1,Math.ceil(rows.length/10));page=Math.min(page,pages-1);const shown=rows.slice(page*10,(page+1)*10);
  const attr=(p,i,key)=>`data-admin-field="${key}" data-admin-id="${p.element_id}" data-admin-step="${i}"`;
  return `<section class="snz-edit snz-admin-editor"><h3>Редактирование СНЗ № ${ctx.order.id} · версия ${ctx.order_revision}${ctx.order.closed_at?' · закрыт':''}</h3>
   <p>Изменения создают новую версию. Факт монтажа связан со статусом изделия в модели. Исправление блокируется при конфликте с последующими СНЗ. Справочники и другие документы не пересчитываются.</p>
   <div class="snz-controls"><label>Найти изделие<input type="search" data-admin-search value="${esc(query)}" placeholder="Марка, оси или ID"></label><label>Добавить позицию<select data-admin-candidate><option value="">Выберите изделие</option>${candidates.map(e=>`<option value="${e.id}">${esc(e.mark||e.id)} · ID ${e.id} · ${esc(e.address||'')}</option>`).join('')}</select></label><button data-action="admin-add" ${blocked?'disabled':''}>Добавить</button></div>
   <div class="snz-controls"><span>Позиций: ${rows.length}</span><button data-action="admin-prev" ${!page?'disabled':''}>Назад</button><span>${page+1} / ${pages}</span><button data-action="admin-next" ${page+1>=pages?'disabled':''}>Далее</button></div>
   <fieldset ${blocked?'disabled':''}>${shown.map(p=>{const e=members.get(p.element_id)||{};return `<article class="snz-admin-position" data-admin-position="${p.element_id}"><div class="snz-controls"><strong>${p.priority}. ${esc(e.mark||p.element_id)} · ID ${p.element_id}</strong><label>Карта<select ${attr(p,-1,'card_id')}><option value="">Ручные показатели</option>${opts(ctx.cards,p.card_id)}</select></label><button data-action="admin-up" data-id="${p.element_id}" ${p.priority===1?'disabled':''}>↑ Выше</button><button data-action="admin-down" data-id="${p.element_id}" ${p.priority===rows.length?'disabled':''}>↓ Ниже</button><button data-action="admin-remove" data-id="${p.element_id}">Удалить позицию</button></div>
   <div class="snz-table-wrap"><table class="snz-table snz-admin-steps"><thead><tr><th>Операция</th><th>Норматив, мин</th><th>Звено</th><th>Техперерыв, мин</th><th>Начать не ранее (МСК)</th><th>Факт</th><th>Время факта (МСК)</th><th>Действия</th></tr></thead><tbody>${p.steps.map((s,i)=>`<tr><td>${esc(ctx.operations.find(o=>o.id===s.operation_id)?.name||s.operation_id)}</td><td><input type="number" min="1" max="43200" ${attr(p,i,'minutes')} value="${value(s.minutes)}" aria-label="Норматив ${p.element_id} ${s.operation_id}"></td><td><select ${attr(p,i,'team_id')}>${opts(ctx.teams,s.team_id)}</select></td><td><input type="number" min="0" max="43200" ${attr(p,i,'wait_after')} value="${s.wait_after}" aria-label="Техперерыв ${p.element_id} ${s.operation_id}"></td><td><input type="datetime-local" step="60" ${attr(p,i,'planned_start')} value="${esc(s.planned_start||'')}" aria-label="Плановое начало ${p.element_id} ${s.operation_id}"></td><td><label class="snz-check"><input type="checkbox" ${attr(p,i,'completed')} ${s.completed?'checked':''}>100 %</label></td><td><input type="datetime-local" step="1" ${attr(p,i,'completed_at')} value="${esc(s.completed_at||'')}" ${s.completed?'':'disabled'} aria-label="Время факта ${p.element_id} ${s.operation_id}"></td><td><button data-action="admin-step-up" data-id="${p.element_id}" data-step="${i}" ${!i?'disabled':''}>↑</button> <button data-action="admin-step-remove" data-id="${p.element_id}" data-step="${i}">Удалить</button></td></tr>`).join('')||'<tr><td colspan="8">Операций нет. Добавьте операцию или выберите карту.</td></tr>'}</tbody></table></div>
   <div class="snz-controls"><label>Добавить операцию<select data-admin-new-op="${p.element_id}">${opts(ctx.operations.filter(o=>(o.scope==='preparation')===(ctx.order.crew.kind==='preparation')&&!p.steps.some(s=>s.operation_id===o.id)),'')}</select></label><button data-action="admin-step-add" data-id="${p.element_id}">Добавить операцию</button></div></article>`;}).join('')}
   <label class="snz-edit-reason">Причина исправления<textarea data-admin-reason maxlength="1000" rows="2">${esc(reason)}</textarea></label></fieldset>
   ${blocked?'<p class="snz-error">Результат записи не подтверждён или данные изменились. Обновите документ и проверьте историю перед повтором.</p>':''}
   <div class="snz-controls"><button data-action="admin-preview" ${!changed||!reason.trim()||blocked?'disabled':''}>Проверить изменения</button><button class="snz-primary" data-action="admin-save" ${!preview||blocked?'disabled':''}>Сохранить версию</button><button data-action="admin-refresh">Обновить документ</button><button data-action="admin-cancel">Отмена</button></div>
   ${preview?`<h3>Изменения версии ${ctx.order_revision} → ${ctx.order_revision+1}</h3>${diffHtml(preview.changes)}${previewHtml({...preview.snapshot,id:ctx.order.id,editPreview:true,facts:preview.snapshot.version_facts})}`:''}</section>`;
 }
 async function open(id){
  await run(async()=>{const next=await api.get(path()+`/orders/${id}/admin-edit`);reset();ctx=next;rows=structuredClone(next.positions);});
 }
 function change(target){
  if(!ctx||!target.dataset.adminField)return false;
  const p=rows.find(p=>p.element_id===Number(target.dataset.adminId)),i=Number(target.dataset.adminStep),key=target.dataset.adminField;if(!p)return true;
  if(key==='card_id'){
   if(target.value&&!window.confirm('Заменить плановые операции и нормативы позиции выбранной картой? Факт совпадающих операций сохранится.')){render();return true;}
   applyCard(p,target.value);
  }else{
   const s=p.steps[i];if(!s)return true;
   s[key]=key==='completed'?target.checked:['minutes','wait_after'].includes(key)?(target.value===''?(key==='wait_after'?0:null):Number(target.value)):(target.value||null);
   if(key==='completed'){if(s.completed&&!s.completed_at)s.completed_at=now();if(!s.completed)s.completed_at=null;}
  }
  invalidate();render();return true;
 }
 function input(target){
  if(!ctx)return false;
  if(target.matches('[data-admin-reason]')){reason=target.value;invalidate();const b=target.closest('.snz-dialog');b.querySelector('[data-action="admin-preview"]').disabled=!reason.trim()||blocked;b.querySelector('[data-action="admin-save"]').disabled=true;return true;}
  if(target.matches('[data-admin-search]')){query=target.value;render();return true;}
  return false;
 }
 async function click(button){
  const a=button.dataset.action;if(!a?.startsWith('admin-'))return false;
  if(a==='admin-edit-open'){
   if(dirty()&&!window.confirm('Отменить несохранённое исправление?'))return true;
   await open(Number(button.dataset.id));return true;
  }
  if(!ctx)return true;
  if(a==='admin-cancel'){if(dirty()&&!window.confirm('Отменить несохранённое исправление?'))return true;reset();render();return true;}
  if(a==='admin-refresh'){if(dirty()&&!window.confirm('Отменить несохранённые изменения и загрузить документ заново?'))return true;await open(ctx.order.id);return true;}
  if(blocked)return true;
  const id=Number(button.dataset.id),index=rows.findIndex(p=>p.element_id===id),p=rows[index],step=Number(button.dataset.step);
  if(a==='admin-add'){
   const eid=Number(document.querySelector('[data-admin-candidate]')?.value);if(!eid||rows.some(p=>p.element_id===eid))return true;
   const e=ctx.elements.find(e=>e.id===eid),card=e?.suggested_card_id||ctx.cards[0]?.id;
   const row={element_id:eid,card_id:card,priority:rows.length+1,steps:cardSteps(card)};
   const montage=ctx.montage?.[eid];if(montage?.completed_at){const s=row.steps.find(s=>s.operation_id==='install');if(s){s.completed=true;s.completed_at=montage.completed_at;}}
   rows.push(row);page=Math.floor((rows.length-1)/10);
  }else if(a==='admin-remove')rows.splice(index,1);
  else if(a==='admin-up'||a==='admin-down'){const next=index+(a==='admin-up'?-1:1);if(index>=0&&next>=0&&next<rows.length)[rows[index],rows[next]]=[rows[next],rows[index]];}
  else if(a==='admin-step-remove')p.steps.splice(step,1);
  else if(a==='admin-step-up'&&step>0)[p.steps[step-1],p.steps[step]]=[p.steps[step],p.steps[step-1]];
  else if(a==='admin-step-add'){
   const op=ctx.operations.find(o=>o.id===document.querySelector(`[data-admin-new-op="${id}"]`)?.value);if(!op||p.steps.some(s=>s.operation_id===op.id))return true;
   p.steps.push({operation_id:op.id,team_id:op.team,minutes:null,wait_after:0,planned_start:null,completed:false,completed_at:null});
  }else if(a==='admin-prev'||a==='admin-next'){page+=a==='admin-prev'?-1:1;render();return true;}
  else if(a==='admin-preview'){
   preview=null;await run(async()=>{
    if(rows.length>2000)throw new Error('В одной редакции допускается не более 2 000 изделий.');
    for(const p of rows)for(const s of p.steps){
     if(s.minutes!=null&&(!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>43200))throw new Error(`ID ${p.element_id}: норматив — целое число от 1 до 43 200 минут. Неизвестный норматив оставьте пустым.`);
     if(!Number.isInteger(s.wait_after)||s.wait_after<0||s.wait_after>43200)throw new Error(`ID ${p.element_id}: техперерыв — целое число от 0 до 43 200 минут.`);
     if(s.completed&&!s.completed_at)throw new Error(`ID ${p.element_id}: укажите время фактического выполнения.`);
    }
    preview=await api.post(path()+`/orders/${ctx.order.id}/admin-preview`,{revision:ctx.revision,order_revision:ctx.order_revision,positions:rows,reason});});return true;
  }else if(a==='admin-save'&&preview){
   if(!window.confirm('Сохранить новую версию СНЗ и изменения фактического выполнения? Изменение факта монтажа также исправляет статус и время в модели. Прежняя версия сохранится в истории.'))return true;
   const oid=ctx.order.id,body={revision:ctx.revision,order_revision:ctx.order_revision,positions:rows,reason,request_id:uid(),expected_hash:preview.fingerprint};
   await run(async()=>{try{await api.post(path()+`/orders/${oid}/admin-revisions`,body);}catch(e){preview=null;blocked=!e.status||e.status===409||e.status>=500;throw e;}reset();await onSaved(oid);});return true;
  }else return true;
  rows.forEach((r,i)=>r.priority=i+1);invalidate();render();return true;
 }
 return {html,active,dirty,reset,click,change,input};
}
