import { esc } from "./screen-view.js";
import { displayDate, qty, rub } from "./procurement-table-model.js";

const pageSize=10;
const textKey=value=>String(value??"").toLocaleLowerCase("ru").trim();
function orderText(order){
  return [order.order_number,displayDate(order.order_date),order.supplier,...order.lines.map(l=>l.item),
    ...order.payments.flatMap(p=>[p.payment_number,displayDate(p.payment_date)])].join(" ");
}
function toggle(key,open,label,full=false){
  return `<button type="button" data-map-branch="${esc(key)}" aria-expanded="${open}" class="pr-mm-toggle">${esc(label)} <span aria-hidden="true">${full?(open?"Свернуть −":"Развернуть +"):(open?"−":"+")}</span></button>`;
}
export function quantityMatch(r){
  if(r.raw.cancelled)return "cancelled";
  if(r.qty<=1e-9 && r.ordered<=1e-9)return "empty";
  if(r.ordered<=1e-9)return "missing";
  return Math.abs(r.ordered-r.qty)<=1e-9?"full":"different";
}
function orderMatch(row,requests){
  if(row.raw.cancelled)return {state:"cancelled",note:"Отменено"};
  const links=row.raw.links;
  if(!links.length)return {state:"missing",note:"Не сопоставлено с ЗВП"};
  const reasons=[];
  if(links.some(l=>l.replacement))reasons.push("Замена номенклатуры или единицы");
  if(links.some(l=>{const r=requests.get(l.request_line_id);return r && quantityMatch(r)!=="full";}))reasons.push("Количество отличается от потребности");
  if(row.raw.unallocated_qty>1e-9)reasons.push(`Не сопоставлено: ${qty(row.raw.unallocated_qty)} ${row.unit}`);
  return {state:reasons.length?"different":"full",note:reasons.join(" · ")};
}
function items(rows,isRequest=false,requests=new Map()){
  return `<div class="pr-mm-item-head ${isRequest?"is-request":""}"><span>Номенклатура</span><span>Ед.</span><span>${isRequest?"Исходно":"Кол-во"}</span>${isRequest?"<span>Заказано</span>":""}</div>
    <ul class="pr-mm-items ${isRequest?"is-request":""}">${rows.map(r=>{
      const match=isRequest?quantityMatch(r):"";
      const comparison=isRequest?null:orderMatch(r,requests);
      const note=isRequest?`Нужно ${qty(r.qty)}; заказано ${qty(r.ordered)} ${r.unit}`:comparison.note;
      const caption=r.raw.cancelled?"Отменено":isRequest?(match==="missing"?(r.raw.pending_orders?"Заказ не сопоставлен":"Не заказано"):""):comparison.note;
      return `<li data-mm-item="${isRequest?"request":"order"}" data-mm-id="${r.requestId||r.orderId}" data-quantity-match="${match}" data-order-match="${comparison?.state||""}" data-cancelled="${!!r.raw.cancelled}" title="${esc(note)}">
        <span>${r.raw.cancelled?`<span class="pr-mm-item-name">${esc(r.item)}</span>`:`<button type="button" class="pr-mm-item-select" aria-pressed="false"><span class="pr-mm-item-name">${esc(r.item)}</span></button>`}${caption?`<small>${esc(caption)}</small>`:""}${comparison?.state==="different"&&r.request_item.length?`<small>ЗВП: ${esc(r.request_item.join("; "))}</small>`:""}</span>
        <span>${esc(r.unit)}</span><b data-mm-count="original">${qty(r.qty)}</b>${isRequest?`<b data-mm-count="ordered">${qty(r.ordered)}</b>`:""}</li>`;
    }).join("")}</ul>`;
}
export function createDocumentMap(host){
  let index=[],visible=[],page=0,snapshot=null,rootKey=null;
  const openOrders=new Set();
  let documentTotals=new Map();
  let requestRows=new Map();
  let orderRows=new Map(),requestDocuments=new Map();
  let pinnedItem=null,hoveredItem=null,focusedItem=null;
  const itemSelection=row=>row && row.dataset.cancelled!=="true"?{kind:row.dataset.mmItem,id:row.dataset.mmId}:null;
  const sameItem=(a,b)=>a?.kind===b?.kind && a?.id===b?.id;
  function highlightItems(){
    const selected=hoveredItem||focusedItem||pinnedItem;
    const requests=new Set(selected?.kind==="request"?[selected.id]:selected?orderRows.get(selected.id)?.raw.links.map(l=>l.request_line_id)||[]:[]);
    for(const row of host.querySelectorAll("[data-mm-item]")){
      const item=itemSelection(row);
      const linked=!!(item && selected && (sameItem(item,selected)||(item.kind==="request"?requests.has(item.id):orderRows.get(item.id)?.raw.links.some(l=>requests.has(l.request_line_id)))));
      row.classList.toggle("is-linked",linked);
      row.querySelector(".pr-mm-item-select")?.setAttribute("aria-pressed",String(!!pinnedItem && sameItem(item,pinnedItem)));
    }
  }
  function drawEdges(){
    const canvas=host.querySelector(".pr-mm-canvas");
    if(!canvas || canvas.offsetWidth===0)return;
    const svg=canvas.querySelector("svg"),origin=canvas.getBoundingClientRect();
    const paths=[];
    function connect(from,to){
      const x=from.right-origin.left,y=from.top-origin.top+24;
      const end=to.left-origin.left,bottom=to.top-origin.top+24;
      const bend=Math.max(18,(end-x)*0.55);
      paths.push(`<path data-mm-link="document" d="M${x} ${y} C${x+bend} ${y} ${end-bend} ${bottom} ${end} ${bottom}"/>`);
    }
    for(const [source,target] of [["request","order"],["order","payment"]]){
      for(const active of canvas.querySelectorAll(`[data-mm-node="${source}"].is-active`)){
        for(const node of canvas.querySelectorAll(`[data-mm-node="${target}"]`)){
          if(source==="order" && node.dataset.mmParent!==active.dataset.mmKey)continue;
          connect(active.getBoundingClientRect(),node.getBoundingClientRect());
        }
      }
    }
    svg.innerHTML=paths.join("");
  }
  const observer=new ResizeObserver(drawEdges);
  function paymentStatus(order){
    const totals=documentTotals.get(order.document)||{amount:0,paid:0,count:0};
    if(!totals.count)return '<span class="pr-mm-payment-status is-unpaid">ЗРДС отсутствуют</span>';
    if(totals.amount>0 && totals.paid>=totals.amount)return '<span class="pr-mm-payment-status is-paid">ЗП оплачен полностью</span>';
    return `<span class="pr-mm-payment-status is-unpaid pr-mm-balance"><span>Осталось по ЗП</span><strong>${rub(Math.max(0,totals.amount-totals.paid))}</strong></span>`;
  }
  function requestNode(d){
    const active=d.groupKey===rootKey;
    return `<article class="pr-mm-node pr-progress-${d.progress} ${active?"is-active":""}" data-mm-node="request">
      <small>ЗВП · ${displayDate(d.date)}</small>${toggle(d.groupKey,active,d.number,true)}
      <span>${esc(d.warehouse)}</span><span>${esc(d.item)} · ЗП: ${d.orders.size}</span>
      ${d.orders.size && [...d.orders.values()].every(o=>{const t=documentTotals.get(o.document);return t?.amount>0&&t.paid>=t.amount;})?'<span class="pr-mm-payment-status is-paid">Все связанные ЗП оплачены</span>':""}
      ${items(d.requests,true)}</article>`;
  }
  function orderNode(o){
    const active=openOrders.has(o.groupKey);
    return `<article class="pr-mm-node pr-progress-${o.progress} ${active?"is-active":""}" data-mm-node="order" data-mm-key="${esc(o.groupKey)}">
      <small>ЗП · ${displayDate(o.order_date)}</small>${toggle(o.groupKey,active,o.order_number)}
      <span>${esc(o.supplier)}</span><span>По этой ЗВП <strong>${rub(o.amount)}</strong> · ЗРДС: ${o.payments.length}</span>
      ${paymentStatus(o)}
      ${items(o.lines,false,requestRows)}</article>`;
  }
  function paymentNode(p,parent){
    return `<article class="pr-mm-node pr-mm-payment ${p.amount>0?"is-paid":"is-unpaid"}" data-mm-node="payment" data-mm-parent="${esc(parent)}">
      <small>ЗРДС · ${p.payment_date?displayDate(p.payment_date):"дата не указана"}</small><b>${esc(p.payment_number)}</b>
      <span>Расход по всему ЗП <strong>${rub(p.amount)}</strong></span><span class="pr-mm-payment-status">${p.amount>0?"Есть расход по выгрузке":"Расход по выгрузке отсутствует"}</span></article>`;
  }
  function clearPath(){rootKey=null;openOrders.clear();pinnedItem=hoveredItem=focusedItem=null;}
  function render(){
    hoveredItem=focusedItem=null;
    const left=host.querySelector(".pr-mm-scroll")?.scrollLeft||0;
    const shown=visible.slice(page*pageSize,(page+1)*pageSize).map(x=>x.doc);
    const doc=shown.find(d=>d.groupKey===rootKey);
    const orders=doc?[...doc.orders.values()]:[];
    const expanded=orders.filter(o=>openOrders.has(o.groupKey));
    host.innerHTML=`<div class="pr-mm-toolbar"><strong>Заявки · ${visible.length}</strong>
      ${rootKey?'<button type="button" class="v2-btn" data-map-fold>Свернуть ветку</button>':""}</div>
      <p class="pr-mm-legend">Наведите на номенклатуру, чтобы подсветить сопоставленные позиции. Клик закрепляет подсветку, клик по другой позиции переключает её. Esc снимает выделение.</p>
      <p class="pr-mm-legend">В ЗП: жёлтые позиции — замена или расхождение количества; красные — не сопоставлены с ЗВП. Отменённые позиции зачёркнуты.</p>
      <div class="pr-mm-scroll"><div class="pr-mm-canvas">
      <svg class="pr-mm-wires" aria-hidden="true"></svg>
      <section><h4>ЗВП · Потребность</h4>${shown.map(requestNode).join("")||'<p>Подходящих ЗВП нет.</p>'}</section>
      ${doc?`<section><h4>ЗП · Заказы поставщикам</h4><div class="pr-mm-order-list">${orders.map(orderNode).join("")||'<p>Связанных ЗП нет.</p>'}</div></section>`:""}
      ${expanded.length?`<section><h4>ЗРДС · Оплаты</h4>${expanded.map(o=>`<div class="pr-mm-payment-branch" data-payment-branch="${esc(o.groupKey)}"><h5>ЗП ${esc(o.order_number)}</h5>${o.payments.map(p=>paymentNode(p,o.groupKey)).join("")||'<p>Связанных ЗРДС нет.</p>'}</div>`).join("")}</section>`:""}
      </div></div>
      ${visible.length>pageSize?`<div class="pr-actions"><button type="button" class="v2-btn" data-mm-page="-1" ${page?"":"disabled"}>Назад</button>
      ${page+1} / ${Math.ceil(visible.length/pageSize)} <button type="button" class="v2-btn" data-mm-page="1" ${(page+1)*pageSize>=visible.length?"disabled":""}>Далее</button></div>`:""}`;
    host.querySelector(".pr-mm-scroll").scrollLeft=left;
    const root=host.querySelector('[data-mm-node="request"].is-active');
    const list=host.querySelector(".pr-mm-order-list");
    if(root && list){
      list.style.paddingTop=Math.max(0,root.getBoundingClientRect().top-list.getBoundingClientRect().top)+"px";
      const orderNodes=[...host.querySelectorAll('[data-mm-node="order"]')];
      for(const branch of host.querySelectorAll("[data-payment-branch]")){
        const order=orderNodes.find(n=>n.dataset.mmKey===branch.dataset.paymentBranch);
        if(order)branch.style.paddingTop=Math.max(0,order.getBoundingClientRect().top-branch.getBoundingClientRect().top)+"px";
      }
    }
    drawEdges();
    highlightItems();
  }
  host.onpointerover=e=>{
    const row=e.target.closest("[data-mm-item]");
    if(!row || row.contains(e.relatedTarget))return;
    hoveredItem=itemSelection(row);highlightItems();
  };
  host.onpointerout=e=>{
    const row=e.target.closest("[data-mm-item]");
    if(!row || row.contains(e.relatedTarget))return;
    hoveredItem=null;highlightItems();
  };
  host.onfocusin=e=>{focusedItem=itemSelection(e.target.closest("[data-mm-item]"));highlightItems();};
  host.onfocusout=e=>{
    if(e.target.closest("[data-mm-item]")?.contains(e.relatedTarget))return;
    focusedItem=null;highlightItems();
  };
  host.onkeydown=e=>{
    if(e.key==="Escape"){pinnedItem=hoveredItem=focusedItem=null;highlightItems();}
  };
  host.onclick=e=>{
    const item=itemSelection(e.target.closest("[data-mm-item]"));
    if(item){
      const doc=item.kind==="request"?requestDocuments.get(item.id):null;
      if(doc && doc.groupKey!==rootKey){
        clearPath();rootKey=doc.groupKey;
        for(const order of doc.orders.values())openOrders.add(order.groupKey);
        pinnedItem=item;render();
        [...host.querySelectorAll('[data-mm-item="request"]')].find(row=>row.dataset.mmId===item.id)?.querySelector("button")?.focus({preventScroll:true});
      }else{pinnedItem=item;focusedItem=null;highlightItems();}
      return;
    }
    const b=e.target.closest("button");if(!b)return;
    const isRequest=b.closest('[data-mm-node="request"]')!==null;
    if(b.dataset.mapBranch){
      const key=b.dataset.mapBranch;
      if(isRequest){
        const next=rootKey===key?null:key;
        clearPath();rootKey=next;
        const doc=index.find(x=>x.doc.groupKey===next)?.doc;
        if(doc)for(const o of doc.orders.values())openOrders.add(o.groupKey);
      }else{if(openOrders.has(key))openOrders.delete(key);else openOrders.add(key);}
    }else if(b.hasAttribute("data-map-fold"))clearPath();
    else if(b.dataset.mmPage){page+=Number(b.dataset.mmPage);clearPath();}
    else return;
    const attr=b.getAttributeNames().find(k=>k.startsWith("data-")),value=b.getAttribute(attr);
    render();
    [...host.querySelectorAll("button")].find(n=>n.getAttribute(attr)===value)?.focus({preventScroll:true});
    if(b.dataset.mapBranch && (isRequest?rootKey:openOrders.has(b.dataset.mapBranch))){
      const pane=host.querySelector(".pr-mm-scroll");
      const lane=host.querySelector(isRequest?"section:nth-of-type(2)":"section:nth-of-type(3)");
      if(lane && lane.getBoundingClientRect().right>pane.getBoundingClientRect().right){
        pane.scrollLeft+=lane.getBoundingClientRect().right-pane.getBoundingClientRect().right+12;
      }
    }
  };
  observer.observe(host);
  return {
    destroy(){observer.disconnect();host.onclick=host.onpointerover=host.onpointerout=host.onfocusin=host.onfocusout=host.onkeydown=null;},
    update(model,id){
      requestRows=new Map(model.requests.map(r=>[r.requestId,r]));
      orderRows=new Map(model.orders.map(r=>[r.orderId,r]));
      requestDocuments=new Map(model.groups.flatMap(doc=>doc.requests.map(r=>[r.requestId,doc])));
      documentTotals=new Map();
      for(const order of model.orders){
        if(order.raw.cancelled)continue;
        const totals=documentTotals.get(order.document)||{amount:0,paid:0,count:0};
        totals.amount+=order.amount;documentTotals.set(order.document,totals);
      }
      for(const payment of model.payments){
        const totals=documentTotals.get(payment.document);
        if(totals){totals.paid+=payment.amount;totals.count++;}
      }
      index=model.groups.map(doc=>({doc,text:textKey([doc.number,displayDate(doc.date),doc.warehouse,doc.category,...doc.requests.map(r=>r.item),...[...doc.orders.values()].map(orderText)].join(" "))}))
        .sort((a,b)=>b.doc.date.localeCompare(a.doc.date));
      if(snapshot!==id){snapshot=id;clearPath();}
    },
    filter(query,predicate){
      const q=textKey(query);
      visible=index.filter(x=>predicate(x.doc,"chain")&&x.text.includes(q));
      page=0;
      if(!visible.slice(0,pageSize).some(x=>x.doc.groupKey===rootKey))clearPath();
      render();
    }
  };
}
