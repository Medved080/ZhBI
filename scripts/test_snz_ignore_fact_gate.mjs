import assert from 'node:assert/strict';
import {checkWrite} from '../app/static/v2/write-gate.js';
for(const endpoint of ['preview','orders']){
 const body={revision:1,date:'2026-11-10',shift:'night',crew_id:'install1'};
 if(endpoint==='orders')Object.assign(body,{request_id:'future',expected_hash:'a'.repeat(64)});
 const path=`/objects/1/snz/${endpoint}`;
 assert.equal(checkWrite('POST',path,body).allowed,true);
 for(const flag of [false,true])assert.equal(checkWrite('POST',path,{...body,ignore_fact:flag}).allowed,true);
 for(const flag of ['true',1,null])assert.equal(checkWrite('POST',path,{...body,ignore_fact:flag}).allowed,false);
 assert.equal(checkWrite('POST',path,{...body,ignore_fact:true,unexpected:1}).allowed,false);
}
console.log('PASS SNZ mode: legacy/default/boolean bodies allowed, bad types and extra fields blocked');
