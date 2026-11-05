import { esc } from "./screen-view.js";
import { displayDate, paymentInfo, rub } from "./procurement-table-model.js";

function supplierKey(name) {
  const match = /ИНН\s*[:№]?\s*(\d{10}(?:\d{2})?)(?!\d)/iu.exec(name || "");
  return match ? "inn:"+match[1] : "name:"+(name || "").trim().replace(/\s+/g," ").toLocaleLowerCase("ru");
}

export function supplierLedger(report) {
  const suppliers=new Map(), byDocument=new Map();
  function get(name) {
    const key=supplierKey(name);
    if(!suppliers.has(key))suppliers.set(key,{key,name:name || "Контрагент не указан",orders:new Map(),payments:[],ordered:0,paid:0,unlinked:0,due:0,over:0});
    return suppliers.get(key);
  }
  for(const line of report.orders){
    if(line.cancelled)continue;
    const supplier=get(line.supplier);
    if(!supplier.orders.has(line.document_key)){
      const order={number:line.number,date:line.date,amount:0,paid:0,requests:new Set(),payments:[]};
      supplier.orders.set(line.document_key,order);
      if(!byDocument.has(line.document_key))byDocument.set(line.document_key,new Map());
      byDocument.get(line.document_key).set(supplier.key,supplier);
    }
    const order=supplier.orders.get(line.document_key);
    order.amount+=line.amount_cents;
    if(line.request_number)order.requests.add(line.request_number);
    supplier.ordered+=line.amount_cents;
  }
  for(const row of report.payments){
    const candidates=byDocument.get(row.document_key);
    // An empty payee can be recovered only from a uniquely identified order.
    const supplier=!row.supplier && candidates?.size===1 ? candidates.values().next().value : get(row.supplier);
    const order=supplier.orders.get(row.document_key);
    const payment={...paymentInfo(row),amount:row.amount_cents,orderNumber:row.order_number,linked:Boolean(order),row:row.source_row};
    supplier.payments.push(payment);
    supplier.paid+=payment.amount;
    if(order){
      order.paid+=payment.amount;
      order.payments.push(payment);
    } else supplier.unlinked+=payment.amount;
  }
  for(const s of suppliers.values()){
    for(const o of s.orders.values()){
      s.due+=Math.max(0,o.amount-o.paid);
      s.over+=Math.max(0,o.paid-o.amount);
    }
    s.payments.sort((a,b)=>(a.date||"9999").localeCompare(b.date||"9999") || a.row-b.row);
  }
  return [...suppliers.values()].sort((a,b)=>b.due-a.due || b.ordered-a.ordered || a.name.localeCompare(b.name,"ru"));
}

export function createSupplierView(host){
  let suppliers=[],query="",expanded=null;
  const metric=(label,value)=>`<span><small>${label}</small><strong>${rub(value)}</strong></span>`;
  function detail(s){
    const orders=[...s.orders.values()].sort((a,b)=>a.date.localeCompare(b.date));
    let running=0;
    const timeline=s.payments.map(p=>{
      running+=p.amount;
      const context=p.linked?"ЗП "+p.orderNumber:"Без совпавшего ЗП контрагента · "+p.orderNumber;
      return `<li><span><b>${p.date?displayDate(p.date):"Дата ЗРДС не указана"}</b> · ${esc(p.number)}<small>${esc(context)}</small></span>
        <span><strong>${rub(p.amount)}</strong><small>${p.date?"Накоплено по датированным ЗРДС · "+rub(running):""}</small></span></li>`;
    }).join("");
    return `<div class="pr-trace"><h4>Заказы поставщику</h4>${orders.map(o=>
      `<details class="pr-supplier-order"><summary>${displayDate(o.date)} · ЗП ${esc(o.number)} · ${rub(o.amount)}</summary>
      <p>ЗВП ${esc([...o.requests].join(", ")||"не указана")} · По связанным ЗРДС ${rub(o.paid)} · Осталось ${rub(Math.max(0,o.amount-o.paid))}</p>
      ${o.payments.map(p=>`<div>${p.date?displayDate(p.date):"Дата не указана"} · ${esc(p.number)} · ${rub(p.amount)}</div>`).join("")}</details>`
    ).join("")||"<p>Действующих ЗП в загрузке нет.</p>"}
    <h4>Хронология по датам ЗРДС</h4>${timeline?`<ul class="pr-supplier-timeline">${timeline}</ul>`:"<p>Строк расхода по ЗРДС нет.</p>"}</div>`;
  }
  function render(){
    const rows=suppliers.filter(s=>s.name.toLocaleLowerCase("ru").includes(query));
    host.innerHTML=`<p class="v2-muted">По действующим ЗП показана стоимость с НДС. Оплачено — сумма «СуммаРасход» из ЗРДС. Остаток считается отдельно по каждому заказу. Хронология использует дату заявки на расходование средств.</p>`+rows.map(s=>
      `<article class="pr-supplier"><button class="pr-supplier-open" data-payee="${esc(s.key)}" aria-expanded="${s.key===expanded}">
      <span><b>${esc(s.name)}</b><small>Заказов · ${s.orders.size} &nbsp; Строк ЗРДС · ${s.payments.length}</small></span>
      ${metric("Всего по ЗП",s.ordered)}${metric("Оплачено по ЗРДС",s.paid)}${metric("Осталось по ЗП",s.due)}<span aria-hidden="true">${s.key===expanded?"−":"+"}</span></button>
      ${s.unlinked || s.over?`<p class="pr-supplier-note">${[s.unlinked?"В оплатах без совпавшего ЗП контрагента · "+rub(s.unlinked):"",s.over?"Переплата по заказам · "+rub(s.over):""].filter(Boolean).join(" · ")}</p>`:""}
      ${s.key===expanded?detail(s):""}</article>`
    ).join("")+(rows.length?"":"<p>Контрагенты не найдены.</p>");
  }
  host.onclick=e=>{
    const b=e.target.closest("[data-payee]");if(!b)return;
    expanded=expanded===b.dataset.payee?null:b.dataset.payee;
    render();
    [...host.querySelectorAll('[data-payee]')].find(x=>x.dataset.payee===b.dataset.payee)?.focus({preventScroll:true});
  };
  return {update(report){suppliers=supplierLedger(report);},filter(text){query=text.trim().toLocaleLowerCase("ru");render();}};
}
