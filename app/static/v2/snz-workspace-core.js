import {validateSteps} from './snz-validation.js';
// Pure rules shared by the model filter and the inline SNZ register.
export const READY = 'ready_for_installation';
export const DATE_MODES = ['', 'date', 'unplanned', 'all'];
export const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number(v.slice(0,4))>0 && !Number.isNaN(Date.parse(v+'T12:00:00Z')) && new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;

export function scopeFor(state, {mode, date, shift, crewId}) {
  if (!DATE_MODES.includes(mode)) throw new Error('Неизвестный режим даты.');
  if ((!mode||mode==='all')&&!shift&&!crewId) return {mode, ids:null};
  const assigned=new Map(state.assignments.map(a=>[a.element_id,a]));
  const ids=state.elements.filter(e=>{
    const a=assigned.get(e.id);
    const dateMatches=mode==='unplanned'?!a?.date:mode==='date'?isDay(date)&&a?.date===date:true;
    return dateMatches && (!shift||(shift==='none'?!a?.shift:a?.shift===shift))
      && (!crewId||(crewId==='none'?!a?.crew_id:a?.crew_id===crewId));
  }).map(e=>e.id);
  return {mode, ids};
}

// Normalize only editable scope groups; issued assignments are immutable.
export function normalizeMontageAssignments(assignments, lockedIds=[], move=null) {
  const locked=new Set(lockedIds),groups=new Map();
  for(const a of assignments){const key=JSON.stringify([a.date,a.shift,a.crew_id]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
  for(const rows of groups.values()){
    if(rows.some(a=>locked.has(a.element_id)))continue;
    rows.sort((a,b)=>(a.priority??1e9)-(b.priority??1e9));
    const index=move?rows.findIndex(a=>a.element_id===move.id):-1;
    if(index>=0){const [item]=rows.splice(index,1);rows.splice(Math.max(0,Math.min(rows.length,(move.position??rows.length+1)-1)),0,item);}
    rows.forEach((a,i)=>{a.priority=i+1;});
  }
}

export function makeAssignmentState(state, ids, {date, shift, crewId, cardId='auto'}) {
  const chosen=[...new Set(ids)], elements=new Map(state.elements.map(e=>[e.id,e]));
  if (!chosen.length) throw new Error('Выберите изделия на модели или в реестре.');
  if (chosen.length>20000 || chosen.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error('Недопустимый выбор изделий.');
  if (!isDay(date) || !['day','night'].includes(shift)) throw new Error('Укажите дату и дневную или ночную смену.');
  if (!state.state.crews.some(c=>c.id===crewId&&c.kind==='installation')) throw new Error('Выберите монтажную бригаду.');
  const locked=new Set(state.locked_element_ids), cards=new Set(state.state.cards.map(c=>c.id));
  for (const id of chosen) {
    const e=elements.get(id);
    if (!e || e.is_current===0) throw new Error('Одно из выбранных изделий отсутствует в актуальной модели. Обновите данные.');
    if (e.current_status!==READY) throw new Error('Запланировать можно только изделия «Готов к монтажу». Измените статус или снимите лишний выбор.');
    if (locked.has(id)) throw new Error('Выбраны изделия из выданного СНЗ. Их назначения защищены; снимите их с выбора.');
  }
  const body=structuredClone(state.state);delete body.facts;
  normalizeMontageAssignments(body.assignments,state.locked_element_ids);
  let priority=Math.max(0,...body.assignments.filter(a=>a.crew_id===crewId&&a.date===date&&a.shift===shift).map(a=>a.priority||0));
  const map=new Map(body.assignments.map(a=>[a.element_id,a]));
  for (const id of chosen) {
    const old=map.get(id), e=elements.get(id);
    const card=cardId==='auto' ? old?.card_id||e.suggested_card_id : cardId;
    if (!card || !cards.has(card)) throw new Error('Для части изделий нет однозначной карты. Укажите карту в расширенном планировании СНЗ.');
    const next={element_id:id,crew_id:crewId,card_id:card,date,shift,
      priority:old?.crew_id===crewId&&old.date===date&&old.shift===shift&&old.priority!=null?old.priority:++priority,
      prep_priority:old?.prep_priority??null};
    if (old) Object.assign(old,next); else {body.assignments.push(next);map.set(id,next);}
  }
  normalizeMontageAssignments(body.assignments,state.locked_element_ids);
  validateSteps(body);
  return {revision:state.revision,...body};
}

// A row edit keeps the card and other assignments, with the same revision guard.
export function editAssignmentState(data, id, field, value, defaults={}) {
  if(!['date','shift','crew_id','priority'].includes(field))throw new Error('Недопустимое поле назначения.');
  const old=data.state.assignments.find(a=>a.element_id===id);
  const date=field==='date'?value:old?.date;
  if(!isDay(date))throw new Error('Укажите дату в строке изделия. Для снятия назначения откройте расширенное планирование СНЗ.');
  if(field==='priority'&&value!==null&&(!Number.isInteger(value)||value<1||value>1000000))throw new Error('Очередность — целое число от 1 до 1 000 000 или пустое поле.');
  const body=makeAssignmentState(data,[id],{date,
    shift:field==='shift'?value:old?.shift||defaults.shift||'day',
    crewId:field==='crew_id'?value:old?.crew_id||defaults.crewId||data.state.crews.find(c=>c.kind==='installation')?.id});
  if(field==='priority')normalizeMontageAssignments(body.assignments,data.locked_element_ids,{id,position:value});
  return body;
}

export function moveShiftItem(data, {date,shift,crewId}, id, delta) {
  const rows=data.state.assignments.filter(a=>a.date===date&&a.shift===shift&&a.crew_id===crewId)
    .map((a,index)=>({...a,index})).sort((a,b)=>(a.priority??1e9)-(b.priority??1e9)||a.index-b.index);
  const index=rows.findIndex(a=>a.element_id===id),other=index+delta;
  if(![-1,1].includes(delta)||index<0||other<0||other>=rows.length)throw new Error('Позицию нельзя переместить дальше.');
  const locked=new Set(data.locked_element_ids);
  if(rows.some(a=>locked.has(a.element_id)))throw new Error('Очередность изделий выданного СНЗ защищена.');
  [rows[index],rows[other]]=[rows[other],rows[index]];
  const priority=new Map(rows.map((a,i)=>[a.element_id,i+1]));
  const body=structuredClone(data.state);delete body.facts;
  for(const a of body.assignments)if(priority.has(a.element_id))a.priority=priority.get(a.element_id);
  return {revision:data.revision,...body};
}
