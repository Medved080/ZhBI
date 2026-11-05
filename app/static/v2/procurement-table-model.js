// Pure presentation model. No writes, no aggregation of unlike quantities.
export const progressLabels = {
  complete: "Заказано и оплачено полностью",
  ordered_unpaid: "Заказано полностью, оплата не завершена",
  partial: "Заказано и оплачено меньше потребности",
  unknown: "Требует сопоставления или проверки оплаты",
  not_ordered: "Не заказано и не оплачено",
  cancelled: "Отменено",
};
export const orderLabels = {not_ordered:"Не заказано",partial:"Заказано частично",ordered:"Заказано полностью",excess:"Сверх потребности",needs_mapping:"Требует сопоставления ЗП",cancelled:"Отменено"};
export const qty = v => v == null ? "—" : Number(v).toLocaleString("ru-RU", {maximumFractionDigits:3});
export const rub = v => v == null ? "—" : qty(v / 100) + " ₽";
export function displayDate(v) {
  if(Array.isArray(v)) return v.map(displayDate).join("\n") || "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}
export function paymentInfo(p) {
  // A payment's own date must never be replaced by its order's date.
  const match = /^(.*?)\s+от\s+(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/.exec(p.ref);
  return {number:match ? match[1].replace(/^Заявка на расходование (?:денежных средств|ДС)\s*/i, "") : p.ref,
    date:match ? `${match[4]}-${match[3]}-${match[2]}T${(match[5] || "00").padStart(2,"0")}:${match[6]||"00"}:${match[7]||"00"}` : null};
}
const epsilon = 1e-9;
export function requestProgress(r, orders, documentTotals) {
  if(r.cancelled) return "cancelled";
  if(!r.links.length || r.ordered_qty <= epsilon) return r.pending_orders ? "unknown" : "not_ordered";
  if(r.paid_qty == null || r.qty <= epsilon) return "unknown";
  if(r.ordered_qty + epsilon < r.qty) return r.pending_orders ? "unknown" : "partial";
  // Check every order independently: overpayment of one does not pay another.
  const paid = r.links.every(link => {
    const o=orders.get(link.order_line_id), d=o && documentTotals.get(o.document_key);
    return d && d.amount > 0 && d.paid >= d.amount;
  });
  return paid ? "complete" : "ordered_unpaid";
}
export function combinedProgress(values) {
  const states=values.filter(v=>v!=="cancelled");
  if(!states.length) return "cancelled";
  if(states.includes("unknown")) return "unknown";
  if(states.every(v=>v==="complete")) return "complete";
  if(states.every(v=>["complete","ordered_unpaid"].includes(v))) return "ordered_unpaid";
  if(states.every(v=>v==="not_ordered")) return "not_ordered";
  return "partial";
}
const columns = {
  date:["Дата",displayDate],number:["Номер"],kind:["Документ / строка"],item:["Номенклатура / назначение"],
  order_date:["Дата ЗП",displayDate],order_number:["Номер ЗП"],payment_date:["Дата ЗРДС",displayDate],payment_number:["Номер ЗРДС"],
  basis:["Основание"],warehouse:["Склад"],category:["Категория"],supplier:["Поставщик / контрагент"],
  manager:["Менеджер"],unit:["Ед."],qty:["Количество",qty],ordered:["Заказано",qty],
  percent:["Заказано, %",v=>v==null?"—":qty(v)+"%"],remaining:["Остаток",qty],excess:["Сверх потребности",qty],
  paid_qty:["Оплачено, кол-во расчётно",qty],amount:["Стоимость с НДС / расход",rub],
  paid:["Оплачено расчётно",rub],state:["Заказ и оплата"],source:["Строки Excel"],
  mapping:["Сопоставление номенклатуры"],
};
const sets = {
  chain:["date","number","order_date","order_number","payment_date","payment_number","item","unit","qty","ordered","percent","remaining","excess","paid_qty","mapping","amount","paid","state","warehouse","category","supplier","manager","source"],
  requests:["date","number","item","unit","qty","ordered","percent","remaining","excess","paid_qty","mapping","amount","paid","state","order_date","order_number","payment_date","payment_number","warehouse","category","source"],
  orders:["date","number","item","unit","qty","mapping","amount","paid","state","basis","payment_date","payment_number","supplier","category","source"],
  payments:["date","number","order_date","order_number","amount","supplier","manager","state","source"],
};
export function viewColumns(view) {
  const doc={chain:"ЗВП",requests:"ЗВП",orders:"ЗП",payments:"ЗРДС"}[view];
  return sets[view].map(id=>({id,label:id==="item"?"Номенклатура ЗВП / ЗП":doc && ["date","number"].includes(id)?`${columns[id][0]} ${doc}`:columns[id][0],format:columns[id][1] || (v=>Array.isArray(v)?v.join("\n")||"—":String(v??"—")),
    search:id==="item" ? row=>[row.item,row.request_item,row.order_item,row.mapping].flat().join(" ") : null}));
}
const normalize = v => String(v ?? "").toLocaleLowerCase("ru").replace(/\s/g, "");
export function matchesColumns(row, cols, query="", filters={}) {
  const strings = c => [row[c.id], c.format(row[c.id]),c.search?.(row)].map(normalize);
  if(query && !cols.some(c=>strings(c).some(v=>v.includes(normalize(query))))) return false;
  return cols.every(c=>!filters[c.id] || strings(c).some(v=>v.includes(normalize(filters[c.id]))));
}
export function sortRows(rows, sort={id:"date",direction:1}) {
  const missing=v=>v==null || v==="" || Array.isArray(v)&&(!v.length || v.every(x=>x==null || x===""));
  const compare = (a,b) => {
    const x=a[sort.id], y=b[sort.id];
    if(missing(x)) return missing(y) ? 0 : 1;
    if(missing(y)) return -1;
    return (typeof x==="number" && typeof y==="number" ? x-y : String(x).localeCompare(String(y),"ru",{numeric:true})) * sort.direction;
  };
  return rows.map((row,i)=>({row,i})).sort((a,b)=>compare(a.row,b.row)||a.i-b.i).map(x=>x.row);
}
export function tableModel(report) {
  const orders=new Map(report.orders.map(o=>[o.id,o])), totals=new Map();
  for(const o of report.orders) if(!o.cancelled) {
    const d=totals.get(o.document_key)||{amount:0,paid:0};d.amount+=o.amount_cents;d.paid+=o.paid_cents;totals.set(o.document_key,d);
  }
  const requests=report.requests.map(r=>{
    const progress=requestProgress(r,orders,totals);
    return {date:r.date,number:r.number,item:r.item,warehouse:r.warehouse,category:r.category,unit:r.unit,qty:r.qty,
      ordered:r.ordered_qty,percent:r.order_percent,remaining:r.remaining_qty,excess:r.excess_qty,paid_qty:r.paid_qty,
      amount:r.amount_cents,paid:r.paid_cents,state:progressLabels[progress]+(r.excess_qty>epsilon?"; сверх потребности":"")+(r.replacements?`; замен: ${r.replacements}`:"")+(r.pending_orders?"; в ЗВП есть несопоставленные позиции ЗП":""),
      source:r.source_rows.join(", "),kind:"Позиция ЗВП",progress,raw:r,requestId:r.id,document:r.document_key};
  });
  const requestRows=new Map(requests.map(r=>[r.requestId,r]));
  const unique=values=>[...new Set(values.filter(Boolean))];
  for(const r of requests) {
    r.request_item=r.item;
    r.order_item=unique(r.raw.links.map(l=>orders.get(l.order_line_id)?.item));
    r.mapping=r.raw.cancelled?"Отменено":r.raw.links.length?(r.raw.replacements?"Замена подтверждена":"Сопоставлено: совпадение наименований"):
      r.raw.pending_orders?"Не удалось сопоставить":"Заказ поставщику не найден";
  }
  const orderRows=report.orders.map(o=>{
    const progress=o.cancelled?"cancelled":o.unallocated_qty>epsilon?"unknown":combinedProgress(o.links.map(l=>requestRows.get(l.request_line_id)?.progress || "unknown"));
    return {date:o.date,number:o.number,basis:`ЗВП ${o.request_number}`,item:o.item,supplier:o.supplier,category:o.category,unit:o.unit,qty:o.qty,
      amount:o.amount_cents,paid:o.paid_cents,state:progressLabels[progress]+(o.unallocated_qty>epsilon?`; не распределено: ${qty(o.unallocated_qty)}`:"")+(o.links.some(l=>l.replacement)?"; замена":""),
      source:o.source_rows.join(", "),kind:"Позиция ЗП",progress,raw:o,orderId:o.id,document:o.document_key,
      request_item:unique(o.links.map(l=>requestRows.get(l.request_line_id)?.item)),order_item:o.item,
      mapping:o.cancelled?"Отменено":!o.links.length?"Не удалось сопоставить":o.unallocated_qty>epsilon?"Сопоставлено частично":
        o.links.some(l=>l.replacement)?"Замена подтверждена":"Сопоставлено: совпадение наименований"};
  });
  const paymentRows=report.payments.map(p=>({...paymentInfo(p),basis:p.order_ref,item:"Расход по всему заказу поставщику",amount:p.amount_cents,
    order_date:p.order_date,order_number:p.order_number,
    supplier:p.supplier,manager:p.manager,state:p.linked?"Связана с ЗП":"Нет действующего ЗП в загрузке",source:p.source_row,
    kind:"ЗРДС",raw:p,document:p.document_key}));
  function relatedPayments(docs) {
    return sortRows(paymentRows.filter(p=>p.document && docs.has(p.document)),{id:"date",direction:1});
  }
  for(const r of requests) {
    const docs=new Set(r.raw.links.map(l=>orders.get(l.order_line_id)?.document_key).filter(Boolean));
    const linked=sortRows([...docs].map(doc=>report.orders.find(o=>o.document_key===doc)),{id:"date",direction:1});
    const payments=relatedPayments(docs);
    r.order_date=linked.map(o=>o.date);r.order_number=linked.map(o=>o.number);
    r.payment_date=payments.map(p=>p.date);r.payment_number=payments.map(p=>p.number);
  }
  for(const o of orderRows) {
    const payments=relatedPayments(new Set([o.document]));
    o.payment_date=payments.map(p=>p.date);o.payment_number=payments.map(p=>p.number);
  }
  const docs=new Map();
  for(const r of requests) {
    if(!docs.has(r.document)) docs.set(r.document,{date:r.date,number:r.number,kind:"ЗВП",item:"Исходная потребность",document:r.document,
      requests:[],orders:new Map(),warehouse:"",category:"",groupKey:`r-${r.document}`});
    docs.get(r.document).requests.push({...r});
  }
  const detached=[];
  for(const o of orderRows) {
    const candidates=[...docs.values()].filter(d=>d.number===o.raw.request_number);
    const sameYear=candidates.filter(d=>d.date.slice(0,4)===o.date.slice(0,4));
    const parent=sameYear.length===1?sameYear[0]:sameYear.length===0&&candidates.length===1?candidates[0]:null;
    if(!parent) {detached.push(o);continue;}
    if(!parent.orders.has(o.document)) parent.orders.set(o.document,{date:o.date,number:o.number,kind:"ЗП",basis:`ЗВП ${parent.number}`,
      item:"Заказ поставщику",document:o.document,lines:[],payments:paymentRows.filter(p=>p.document===o.document),groupKey:`o-${parent.document}-${o.document}`});
    parent.orders.get(o.document).lines.push(o);
  }
  for(const d of docs.values()) {
    const active=d.requests.filter(r=>!r.raw.cancelled);
    d.warehouse=[...new Set(d.requests.map(r=>r.warehouse))].join("; ");
    d.category=[...new Set(d.requests.map(r=>r.category))].join("; ");
    d.progress=combinedProgress(d.requests.map(r=>r.progress));d.state=progressLabels[d.progress];
    const complete=active.filter(r=>r.progress==="complete").length;
    d.item=active.length ? `Закрыто позиций: ${complete} из ${active.length}` : "Все позиции отменены";
    d.amount=0;d.paid=0;
    for(const o of d.orders.values()) {
      const valid=o.lines.filter(l=>!l.raw.cancelled);
      o.amount=valid.reduce((n,l)=>n+l.amount,0);o.paid=valid.reduce((n,l)=>n+l.paid,0);
      o.supplier=[...new Set(o.lines.map(l=>l.supplier))].join("; ");
      o.progress=combinedProgress(o.lines.map(l=>l.progress));o.state=progressLabels[o.progress];
      d.amount+=o.amount;d.paid+=o.paid;
      o.lines=o.lines.map(l=>({...l,date:d.date,number:d.number,order_date:o.date,order_number:o.number}));
      o.payments=o.payments.map(p=>({...p,date:d.date,number:d.number,order_date:o.date,order_number:o.number,payment_date:p.date,payment_number:p.number,progress:o.progress}));
      o.payment_date=o.payments.map(p=>p.payment_date);o.payment_number=o.payments.map(p=>p.payment_number);
      o.order_date=o.date;o.order_number=o.number;o.date=d.date;o.number=d.number;
    }
    d.order_date=[...d.orders.values()].map(o=>o.order_date);d.order_number=[...d.orders.values()].map(o=>o.order_number);
    const proof=relatedPayments(new Set(d.orders.keys()));
    d.payment_date=proof.map(p=>p.date);d.payment_number=proof.map(p=>p.number);
  }
  const checkProof=row=>{
    if(row.paid>0 && !row.payment_number?.length) {
      row.payment_note="Есть сумма оплаты, но связанная ЗРДС не найдена. Проверьте выгрузку.";
      row.progress="unknown";row.state=row.payment_note;
    }
  };
  requests.forEach(checkProof);orderRows.forEach(checkProof);
  for(const d of docs.values()) {checkProof(d);d.requests.forEach(checkProof);for(const o of d.orders.values()){checkProof(o);o.lines.forEach(checkProof);}}
  return {requests,orders:orderRows,payments:paymentRows,groups:[...docs.values()],
    detached:detached.map(o=>({...o,date:null,number:o.raw.request_number,order_date:o.date,order_number:o.number})),
    orphanPayments:paymentRows.filter(p=>!p.document).map(p=>({...p,date:null,number:null,payment_date:p.date,payment_number:p.number,progress:"unknown"}))};
}
