import { esc } from "./screen-view.js";
import { displayDate, qty, rub } from "./procurement-table-model.js";

function fulfillmentBar(done, needed, paid) {
  const share=value=>needed>0?Math.max(0,Math.min(100,100*value/needed)):0;
  return `<div class="pr-coverage" aria-hidden="true"><i style="width:${share(done)}%"></i><b style="width:${share(paid ?? 0)}%"></b></div>`;
}

function documentSearch(doc) {
  const terms=[doc.number,displayDate(doc.date),doc.warehouse,doc.category,doc.state];
  for(const r of doc.requests)terms.push(r.item,r.mapping,r.unit);
  for(const o of doc.orders.values()){
    terms.push(o.order_number,o.supplier,displayDate(o.order_date));
    for(const line of o.lines)terms.push(line.item,line.mapping);
    for(const p of o.payments)terms.push(p.payment_number,displayDate(p.payment_date));
  }
  return terms.join(" ").toLocaleLowerCase("ru");
}

export function orderCard(o,selected,writable){
    const lines=selected?o.lines.filter(l=>l.raw.links.some(a=>a.request_line_id===selected.requestId)):o.lines;
    if(!lines.length)return "";
    const payments=o.payments.map(p=>`<li><span>ЗРДС ${esc(p.payment_number)} · ${p.payment_date?displayDate(p.payment_date):"дата не указана"}</span><strong>${rub(p.amount)}</strong></li>`).join("");
    return `<article class="pr-purchase"><header><div><strong>ЗП ${esc(o.order_number)}</strong> · ${displayDate(o.order_date)}<small>${esc(o.supplier)}</small></div></header>
      ${lines.map(l=>`<div class="pr-purchase-line"><div><strong>${esc(l.item)}</strong> · ${qty(l.qty)} ${esc(l.unit)}
        <small>${esc(l.mapping)}${l.request_item?.length?" · ЗВП: "+esc(l.request_item.join(", ")):""}</small></div>
        ${writable&&!l.raw.cancelled?`<button type="button" class="pr-sort pr-match-action" data-map="${l.orderId}">Сопоставить</button>`:""}</div>`).join("")}
      ${payments?`<details class="pr-receipts" open><summary>Оплаты по всему ЗП · ${o.payments.length}</summary><ul>${payments}</ul></details>`:"<p class='v2-muted'>Связанных ЗРДС нет.</p>"}</article>`;
  }

export function createRequestCards(host,writable) {
  let index=[],visible=[],documentKey=null,positionId=null,page=0;
  const size=20;
  function positionCard(r) {
    const selected=positionId===r.requestId;
    return `<button type="button" class="pr-need pr-progress-${r.progress}" aria-pressed="${selected}" data-position="${r.requestId}">
      <strong>${esc(r.item)}</strong><span>${esc(r.state)}</span>
      ${fulfillmentBar(r.ordered,r.qty,r.paid_qty)}
      <small>Нужно <b>${qty(r.qty)}</b> · заказано <b>${qty(r.ordered)}</b> · оплачено расчётно <b>${qty(r.paid_qty)}</b> ${esc(r.unit)}</small></button>`;
  }
  function render(){
    const doc=visible.find(d=>d.document===documentKey);
    if(!doc){host.innerHTML='<p class="pr-note">По этому отбору заявок нет.</p>';return;}
    const position=doc.requests.find(r=>r.requestId===positionId);
    const list=visible.slice(page*size,(page+1)*size);
    const purchases=[...doc.orders.values()].map(o=>orderCard(o,position,writable)).join("");
    host.innerHTML=`<div class="pr-case-layout"><aside class="pr-case-list" aria-label="Выбор ЗВП">
      <h3>Заявки <small>${visible.length}</small></h3>
      ${list.map(d=>`<button type="button" class="pr-case-choice pr-progress-${d.progress}" data-case="${d.document}" aria-pressed="${d.document===documentKey}">
      <b>${displayDate(d.date)} · ${esc(d.number)}</b><small>${esc(d.item)}</small></button>`).join("")}
      ${visible.length>size?`<div class="pr-actions"><button data-case-page="-1" ${page===0?"disabled":""}>Назад</button>
      ${page+1} / ${Math.ceil(visible.length/size)} <button data-case-page="1" ${(page+1)*size>=visible.length?"disabled":""}>Далее</button></div>`:""}</aside>
      <section class="pr-case-content"><header><h3>${displayDate(doc.date)} · ЗВП ${esc(doc.number)}</h3><p>${esc(doc.warehouse)}</p>
      <div class="pr-case-money"><div>Заказано с НДС<strong>${rub(doc.amount)}</strong></div><div>Оплачено по ЗП<strong>${rub(doc.paid)}</strong></div><div>Исполнение<strong>${esc(doc.item)}</strong></div></div></header>
      <h4>Потребности</h4><div class="pr-needs">${doc.requests.map(positionCard).join("")}</div>
      <div class="pr-case-section"><h4>${position?"Заказы и оплаты выбранной позиции":"Заказы и оплаты ЗВП"}</h4>
      ${position?'<button type="button" class="v2-btn" data-all-positions>Все позиции</button>':""}</div>
      ${position?`<p>${esc(position.item)} · расчётная оплата ${rub(position.paid)}</p>`:""}
      ${purchases || '<p class="pr-note">Связанный заказ для выбранной потребности отсутствует.</p>'}</section></div>`;
  }
  host.onclick=e=>{
    const b=e.target.closest("button");
    if(!b)return;
    if(b.dataset.case){documentKey=b.dataset.case;positionId=null;}
    else if(b.dataset.position){positionId=b.dataset.position===positionId?null:b.dataset.position;}
    else if(b.hasAttribute("data-all-positions"))positionId=null;
    else if(b.dataset.casePage){page+=Number(b.dataset.casePage);documentKey=visible[page*size].document;positionId=null;}
    else return;
    render();
  };
  return {
    update(model){index=model.groups.map(doc=>({doc,text:documentSearch(doc)})).sort((a,b)=>b.doc.date.localeCompare(a.doc.date));},
    filter(query,predicate){
      const term=query.toLocaleLowerCase("ru");
      visible=index.filter(x=>x.text.includes(term)&&predicate(x.doc,"chain")).map(x=>x.doc);
      const at=visible.findIndex(d=>d.document===documentKey);
      if(at<0){documentKey=visible[0]?.document;positionId=null;}
      page=Math.floor(Math.max(0,at)/size);
      render();
    }
  };
}
