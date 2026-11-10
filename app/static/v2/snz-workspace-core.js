import {validateSteps} from './snz-validation.js';
// Pure rules shared by the model filter and the inline SNZ register.
export const READY = 'ready_for_installation';
export const DATE_MODES = ['', 'date', 'unplanned', 'all'];
export const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number(v.slice(0,4))>0 && !Number.isNaN(Date.parse(v+'T12:00:00Z')) && new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;

export function scopeFor(state, {mode, date, shift, crewId}) {
  if (!DATE_MODES.includes(mode)) throw new Error('Неизвестный режим даты.');
  if (!mode) return {mode:'', ids:null};
  if (mode==='all') return {mode:'all', ids:null};
  const assigned=new Map(state.assignments.map(a=>[a.element_id,a]));
  const ids=state.elements.filter(e=>{
    const a=assigned.get(e.id);
    return mode==='unplanned' ? !a?.date : isDay(date) && a?.date===date
      && (!shift || a.shift===shift) && (!crewId || a.crew_id===crewId);
  }).map(e=>e.id);
  return {mode, ids};
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
  let priority=Math.max(0,...body.assignments.filter(a=>a.crew_id===crewId).map(a=>a.priority||0));
  let prep=Math.max(0,...body.assignments.map(a=>a.prep_priority||0));
  const map=new Map(body.assignments.map(a=>[a.element_id,a]));
  for (const id of chosen) {
    const old=map.get(id), e=elements.get(id);
    const card=cardId==='auto' ? old?.card_id||e.suggested_card_id : cardId;
    if (!card || !cards.has(card)) throw new Error('Для части изделий нет однозначной карты. Выберите карту вручную или уточните справочник.');
    const next={element_id:id,crew_id:crewId,card_id:card,date,shift,
      priority:old?.crew_id===crewId&&old.priority!=null?old.priority:++priority,
      prep_priority:old?.prep_priority??++prep};
    if (old) Object.assign(old,next); else {body.assignments.push(next);map.set(id,next);}
  }
  validateSteps(body);
  return {revision:state.revision,...body};
}
