import assert from 'node:assert/strict';
import {scopeFor,makeAssignmentState,isDay} from '../app/static/v2/snz-workspace-core.js';
const data={revision:7,locked_element_ids:[5],state:{crews:[{id:'a',kind:'installation'},{id:'b',kind:'installation'},{id:'p',kind:'preparation'}],cards:[{id:'manual'},{id:'suggested'}],teams:[],operations:[],groups:[],catalog_seed:'keep',facts:{done:true},assignments:[
 {element_id:1,date:'2026-11-10',shift:'day',crew_id:'a',card_id:'manual',priority:3,prep_priority:8},
 {element_id:2,date:'2026-11-10',shift:'night',crew_id:'b',card_id:'suggested',priority:5,prep_priority:2},
 {element_id:3,date:'2026-11-11',shift:'day',crew_id:'a',card_id:'suggested',priority:4,prep_priority:3},
]},elements:[1,2,3,4,5,6,7,8].map(id=>({id,current_status:id===6?'delivered':'ready_for_installation',is_current:id===7?0:1,suggested_card_id:id===8?null:'suggested'}))};
const filters=(mode,date='2026-11-10',shift='',crewId='')=>scopeFor({elements:data.elements,assignments:data.state.assignments},{mode,date,shift,crewId});
assert.deepEqual(filters(''),{mode:'',ids:null});assert.deepEqual(filters('all'),{mode:'all',ids:null});
assert.deepEqual(filters('unplanned').ids,[4,5,6,7,8]);
assert.deepEqual(filters('date').ids,[1,2]);assert.deepEqual(filters('date',undefined,'day').ids,[1]);assert.deepEqual(filters('date',undefined,'','b').ids,[2]);
assert.deepEqual(filters('date','2026-02-30').ids,[]);
for(const value of ['2026-11-10','2028-02-29'])assert.ok(isDay(value));
for(const value of ['2026-02-29','2026-02-30','2026-13-01','2026-1-01','',null])assert.ok(!isDay(value));
const before=structuredClone(data),args={date:'2026-11-12',shift:'night',crewId:'a'};
const body=makeAssignmentState(data,[1,4,4],args);
assert.deepEqual(data,before);assert.equal(body.revision,7);assert.equal(body.facts,undefined);assert.equal(body.catalog_seed,'keep');
assert.deepEqual(body.assignments.find(a=>a.element_id===1),{...data.state.assignments[0],date:args.date,shift:args.shift,priority:1});
assert.deepEqual(body.assignments.find(a=>a.element_id===4),{element_id:4,crew_id:'a',card_id:'suggested',date:args.date,shift:'night',priority:2,prep_priority:null});
assert.deepEqual(body.assignments[1],{...data.state.assignments[1],priority:1});
assert.equal(makeAssignmentState(data,[1],{...args,crewId:'b'}).assignments[0].priority,1);
for(const ids of [[],[0],[99],[1,5],[1,6],[1,7],[1,8]])assert.throws(()=>makeAssignmentState(data,ids,args));
for(const arg of [{date:'2026-02-30'},{shift:''},{crewId:'p'},{cardId:'missing'}])assert.throws(()=>makeAssignmentState(data,[1],{...args,...arg}));
assert.equal(makeAssignmentState(data,[8],{...args,cardId:'manual'}).assignments.at(-1).card_id,'manual');
console.log('PASS SNZ date scopes, atomic validation, manual cards, priorities, immutable input');

const {editAssignmentState}=await import('../app/static/v2/snz-workspace-core.js');
const changedDate=editAssignmentState(data,1,'date','2026-11-20');
assert.equal(changedDate.assignments[0].date,'2026-11-20');assert.equal(changedDate.assignments[0].card_id,'manual');
assert.equal(changedDate.assignments[0].prep_priority,8);
assert.equal(editAssignmentState(data,1,'shift','night').assignments[0].shift,'night');
assert.equal(editAssignmentState(data,1,'crew_id','b').assignments[0].priority,1);
assert.equal(editAssignmentState(data,1,'priority',22).assignments[0].priority,1);
assert.equal(editAssignmentState(data,1,'priority',null).assignments[0].priority,1);
assert.equal(editAssignmentState(data,4,'date','2026-11-20',{crewId:'b',shift:'night'}).assignments.at(-1).shift,'night');
for(const [id,field,value]of [[1,'date',''],[1,'date','2026-02-30'],[1,'priority',0],[1,'priority',1.2],[1,'priority',1000001],[1,'crew_id','p'],[1,'shift','bad'],[5,'date','2026-11-20'],[4,'shift','night'],[1,'card_id','manual']])assert.throws(()=>editAssignmentState(data,id,field,value));
assert.deepEqual(data,before);
console.log('PASS row dates, shift, crew, priorities, protected assignments and immutable input');

const {moveShiftItem}=await import('../app/static/v2/snz-workspace-core.js');
assert.deepEqual(filters('',undefined,'night').ids,[2]);
assert.deepEqual(filters('all',undefined,'none').ids,[4,5,6,7,8]);
assert.deepEqual(filters('',undefined,'','none').ids,[4,5,6,7,8]);
assert.deepEqual(filters('unplanned',undefined,'day').ids,[]);
const ordered=makeAssignmentState(data,[4,8],{date:'2026-11-20',shift:'day',crewId:'a',cardId:'manual'});
assert.deepEqual(ordered.assignments.filter(a=>a.date==='2026-11-20').map(a=>[a.element_id,a.priority]),[[4,1],[8,2]]);
const moved=moveShiftItem({...data,state:{...data.state,...ordered}},{date:'2026-11-20',shift:'day',crewId:'a'},8,-1);
assert.equal(moved.assignments.find(a=>a.element_id===8).priority,1);
assert.equal(moved.assignments.find(a=>a.element_id===4).priority,2);
assert.deepEqual(data,before);
console.log('PASS independent all/unassigned filters and selection order/reordering');

const {normalizeMontageAssignments}=await import('../app/static/v2/snz-workspace-core.js');
const scopes=[{element_id:10,date:'2026-11-10',shift:'day',crew_id:'a',priority:14},{element_id:11,date:'2026-11-10',shift:'day',crew_id:'a',priority:18},{element_id:12,date:'2026-11-10',shift:'night',crew_id:'a',priority:35},{element_id:13,date:'2026-11-10',shift:'day',crew_id:'b',priority:7}];
normalizeMontageAssignments(scopes);assert.deepEqual(scopes.map(a=>a.priority),[1,2,1,1]);
normalizeMontageAssignments(scopes,[],{id:11,position:1});assert.deepEqual(scopes.map(a=>a.priority),[2,1,1,1]);
console.log('PASS contiguous per-date, shift and crew positions and explicit row moves');
