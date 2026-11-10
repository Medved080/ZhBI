import assert from 'node:assert/strict';
import {firstStepIssue,snzErrorIssue,validateSteps} from '../app/static/v2/snz-validation.js';
const state={operations:[{id:'prepare',name:'Подготовка'}],cards:[{id:'column',name:'Колонна средняя, нижний ярус',steps:[{operation_id:'prepare',minutes:null,wait_after:0}]}]};
for(const value of [null,1,43200]){state.cards[0].steps[0].minutes=value;assert.equal(firstStepIssue(state),null);}
for(const value of [0,-1,1.5,43201,NaN,Infinity]){
 state.cards[0].steps[0].minutes=value;
 const before=structuredClone(state),issue=firstStepIssue(state);
 assert.equal(issue.path,'cards.0.steps.0.minutes');assert.equal(issue.cardId,'column');
 assert.match(issue.message,/Колонна средняя.*Подготовка.*от 1/);assert.throws(()=>validateSteps(state),/Норматив/);assert.deepEqual(state,before);
}
state.cards[0].steps[0].minutes=null;
for(const value of [-1,1.5,43201]){state.cards[0].steps[0].wait_after=value;assert.equal(firstStepIssue(state).path,'cards.0.steps.0.wait_after');}
state.cards[0].steps[0].wait_after=0;
const server={rawDetail:[{loc:['body','cards',0,'steps',0,'minutes'],type:'greater_than_equal',msg:'Input should be greater than or equal to 1'}]};
assert.match(snzErrorIssue(server,state).message,/Колонна средняя.*Подготовка/);
assert.equal(snzErrorIssue({rawDetail:[{loc:['body','cards',99,'steps',0,'minutes']}]},state),null);
console.log('PASS numeric boundaries, null vs zero, Russian card/operation errors, backend 422 locations');
