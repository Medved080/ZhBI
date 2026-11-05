// Presentation logic: real report shape, typed sorting, tree context, status edges.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {tableModel,requestProgress,sortRows,viewColumns,matchesColumns,paymentInfo} from '../app/static/v2/procurement-table-model.js';

const run=spawnSync('.venv312/bin/python',['-c',`import sys,json
sys.path.insert(0,'scripts')
from test_procurement import sample,xlsx_bytes
from app.procurement import parse_xlsx,build_report,validate_allocations
d=parse_xlsx(xlsx_bytes(sample()))
o,r=d['orders'][0],d['requests'][0]
a=validate_allocations(d,o['id'],[dict(request_line_id=r['id'],order_qty=4,request_qty=8)])
print(json.dumps(build_report(d,{o['id']:a})))`],{encoding:'utf8'});
assert.equal(run.status,0,run.stderr);
const report=JSON.parse(run.stdout),model=tableModel(report);
assert.equal(model.groups.length,2);
assert.equal(model.groups[0].orders.size,1);
assert.equal([...model.groups[0].orders.values()][0].payments.length,2);
assert.equal([...model.groups[1].orders.values()][0].payments.length,2);
assert.equal(model.orphanPayments.length,1);
assert.equal(model.requests[0].progress,'partial');
assert.equal(model.requests[2].progress,'cancelled');
assert.equal([...model.groups[0].orders.values()][0].amount,40000);
assert.equal([...model.groups[1].orders.values()][0].amount,60000);
assert.equal(model.groups.reduce((n,d)=>n+d.paid,0),report.summary.paid_cents);
for(const d of model.groups) {
  assert.ok(d.paid===0 || d.payment_number.length,'paid collapsed ZVP must show ZRDS');
  for(const r of d.requests) assert.ok(r.paid===0 || r.payment_number.length,'paid ZVP position must show ZRDS');
  for(const o of d.orders.values()) {
    assert.ok(o.paid===0 || o.payment_number.length,'collapsed order must show ZRDS');
    for(const l of o.lines)assert.ok(l.paid===0 || l.payment_number.length,'paid order position must show ZRDS');
  }
}
assert.equal(model.requests[0].request_item,'Исходный материал');
assert.deepEqual(model.requests[0].order_item,['Замена материала']);
assert.equal(model.requests[0].mapping,'Замена подтверждена');
const unmatchedReport=structuredClone(report);unmatchedReport.orders[0].links=[];unmatchedReport.orders[0].unallocated_qty=4;
const unmatched=tableModel(unmatchedReport).orders[0];
assert.deepEqual(unmatched.request_item,[]);assert.equal(unmatched.order_item,'Замена материала');assert.equal(unmatched.mapping,'Не удалось сопоставить');
for(const view of ['chain','requests','orders','payments']) {
  const cols=viewColumns(view);
  assert.equal(cols[0].id,'date');assert.equal(cols[1].id,'number');
  const row=model[view==='chain'?'requests':view][0];
  for(const c of cols) {
    const v=c.format(row[c.id]);
    assert.ok(matchesColumns(row,cols,'',{[c.id]:v}),`${view}: search ${c.label}`);
    assert.equal(matchesColumns(row,cols,'',{[c.id]:'never-match-91842'}),false);
    assert.ok(matchesColumns(row,cols,v),`${view}: global search ${c.label}`);
  }
}
for(const view of ['chain','requests']) {
  const cols=viewColumns(view);
  assert.ok(cols.some(c=>c.id==='qty'));assert.ok(cols.some(c=>c.id==='unit'));assert.ok(cols.some(c=>c.id==='percent'));
  assert.equal(cols.find(c=>c.id==='qty').format(123),'123');
  assert.equal(cols.find(c=>c.id==='percent').format(80),'80%');
  const item=cols.findIndex(c=>c.id==='item');assert.equal(cols[item+1].id,'unit');assert.equal(cols[item+2].id,'qty');
}
assert.deepEqual(sortRows([{qty:100},{qty:2},{qty:20}],{id:'qty',direction:1}).map(r=>r.qty),[2,20,100]);
assert.deepEqual(sortRows([{date:'2026-02-01'},{date:'2026-01-31'}],{id:'date',direction:1}).map(r=>r.date),['2026-01-31','2026-02-01']);
assert.deepEqual(sortRows([{qty:0},{qty:null},{qty:3}],{id:'qty',direction:-1}).map(r=>r.qty),[3,0,null]);
assert.deepEqual(sortRows([{order_date:[]},{order_date:['2026-02-01']},{order_date:[null]}],{id:'order_date',direction:1}).map(r=>r.order_date),[['2026-02-01'],[],[null]]);
assert.equal(paymentInfo({ref:'Заявка на расходование ДС 02УС-001 от 05.11.2026 8:20:00',order_date:'1999-01-01'}).date,'2026-11-05T08:20:00');
assert.equal(paymentInfo({ref:'ЗРДС без даты',order_date:'2026-01-01'}).date,null);
// Full order / full payment; full order / partial payment; partial coverage.
const base={cancelled:false,pending_orders:0,qty:10,ordered_qty:10,paid_qty:10,links:[{order_line_id:'one'},{order_line_id:'two'}]};
const orders=new Map([['one',{document_key:'a'}],['two',{document_key:'b'}]]);
const totals=new Map([['a',{amount:100,paid:100}],['b',{amount:100,paid:100}]]);
assert.equal(requestProgress(base,orders,totals),'complete');
totals.set('a',{amount:100,paid:150});totals.set('b',{amount:100,paid:50});
assert.equal(requestProgress(base,orders,totals),'ordered_unpaid','overpayment cannot mask unpaid order');
assert.equal(requestProgress({...base,ordered_qty:8,paid_qty:4},orders,totals),'partial');
assert.equal(requestProgress({...base,pending_orders:1},orders,totals),'ordered_unpaid','unmapped sibling must not hide confirmed full ordering');
assert.equal(requestProgress({...base,ordered_qty:8,pending_orders:1},orders,totals),'unknown');
assert.equal(requestProgress({...base,paid_qty:null},orders,totals),'unknown');
assert.equal(requestProgress({...base,ordered_qty:0,links:[]},orders,totals),'not_ordered');
const mixedReport={requests:[
  {...report.requests[0],id:'full',number:'M',document_key:'M',qty:5,ordered_qty:5,paid_qty:5,pending_orders:1,status:'ordered',links:[{order_line_id:'full-order'}]},
  {...report.requests[0],id:'part',number:'M',document_key:'M',qty:10,ordered_qty:2,paid_qty:2,pending_orders:0,status:'partial',links:[{order_line_id:'part-order'}]}],
  orders:[{...report.orders[0],id:'full-order',number:'F',document_key:'F',request_number:'M',qty:5,amount_cents:500,paid_cents:500,unallocated_qty:0,links:[{request_line_id:'full'}]},
    {...report.orders[0],id:'part-order',number:'P',document_key:'P',request_number:'M',qty:2,amount_cents:200,paid_cents:200,unallocated_qty:0,links:[{request_line_id:'part'}]}],
  payments:[{...report.payments[0],document_key:'F',linked:true,amount_cents:500},{...report.payments[1],document_key:'P',linked:true,amount_cents:200}]};
const mixed=tableModel(mixedReport);
assert.equal(mixed.groups[0].progress,'partial');assert.equal(mixed.requests[0].progress,'complete');assert.equal(mixed.requests[1].progress,'partial');
const chainOrder=[...mixed.groups[0].orders.values()][0];assert.equal(chainOrder.order_number,'F');assert.equal(chainOrder.number,'M');
const missingProof=structuredClone(report);missingProof.payments=[];
const noProof=tableModel(missingProof);
assert.equal(noProof.requests[0].progress,'unknown');assert.ok(noProof.requests[0].payment_note.includes('ЗРДС не найдена'));
assert.equal(noProof.groups[0].progress,'unknown');
console.log('Procurement table: grouping, statuses, per-column search, numeric/date sorting passed');
