// Same limits as app.snz.Step. Empty norms are unknown; zero never means skip.
export function stepIssue(state, ci, si, field) {
  const card=state.cards?.[ci],step=card?.steps?.[si];
  if(!card||!step||!['minutes','wait_after'].includes(field))return null;
  const operation=state.operations?.find(o=>o.id===step.operation_id)?.name||step.operation_id;
  const prefix=`Карта «${card.name}», операция «${operation}»`;
  const hint=field==='minutes'
    ? 'Норматив — целое число от 1 до 43 200 минут. Если норма неизвестна, очистите поле. Если операция не нужна, уберите её из карты.'
    : 'Ожидание — целое число от 0 до 43 200 минут; без ожидания укажите 0.';
  return {path:`cards.${ci}.steps.${si}.${field}`,cardId:card.id,message:`${prefix}: ${hint}`};
}
export function firstStepIssue(state) {
  for(const [ci,card]of(state.cards||[]).entries())for(const[si,step]of(card.steps||[]).entries()){
    if(step.minutes!=null&&(!Number.isInteger(step.minutes)||step.minutes<1||step.minutes>43200))return stepIssue(state,ci,si,'minutes');
    if(!Number.isInteger(step.wait_after??0)||(step.wait_after??0)<0||step.wait_after>43200)return stepIssue(state,ci,si,'wait_after');
  }
  return null;
}
export function snzErrorIssue(error,state) {
  const details=error?.rawDetail??error?.detail;
  for(const detail of Array.isArray(details)?details:[]){
    const loc=(detail?.loc||[]).filter(x=>x!=='body');
    if(loc.length===5&&loc[0]==='cards'&&loc[2]==='steps'){
      const issue=stepIssue(state,loc[1],loc[3],loc[4]);if(issue)return issue;
    }
  }
  return null;
}
export function validateSteps(state) {
  const issue=firstStepIssue(state);if(issue){const error=new Error(issue.message);error.snzIssue=issue;throw error;}
}
