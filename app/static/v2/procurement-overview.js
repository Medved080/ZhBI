import { esc } from "./screen-view.js";
import { displayDate, qty, rub } from "./procurement-table-model.js";
import { orderCard } from "./procurement-request-cards.js";

const buckets=[
  ["not_ordered","Без заказа"],["partial","Заказано частично"],["ordered_unpaid","Ожидают оплаты"],
  ["unknown","Требуют проверки"],["complete","Закрыты"],["cancelled","Отменены"]
];
const pageSize=12;

export function createProcurementOverview(host,writable){
  let indexed=[],filtered=[],bucket="",page=0,opened=null;
  function inspect({r,orders,unallocated}){
    const receipts=orders.map(o=>orderCard(o,r,writable)).join("");
    const pending=unallocated.map(l=>`<li>${esc(l.item)} · ЗП ${esc(l.order_number)} · остаток ${qty(l.raw.unallocated_qty)} ${esc(l.unit)}
      ${writable?`<button class="pr-sort pr-match-action" data-map="${l.orderId}">Сопоставить</button>`:""}</li>`).join("");
    return `<div class="pr-trace"><div class="pr-trace-heading"><strong>Заказы и оплаты</strong><span>На позицию приходится ${rub(r.paid)}</span></div>
      ${receipts||'<p>Сопоставленных строк заказа нет.</p>'}
      ${pending?`<details><summary>Осталось сопоставить в этой ЗВП · ${unallocated.length}</summary><ul>${pending}</ul></details>`:""}</div>`;
  }
  function render(){
    const counts=new Map();
    for(const {r} of filtered)counts.set(r.progress,(counts.get(r.progress)||0)+1);
    const selected=filtered.filter(x=>!bucket || x.r.progress===bucket);
    page=Math.max(0,Math.min(page,Math.ceil(selected.length/pageSize)-1));
    const buttons=buckets.map(([key,label])=>`<button type="button" class="pr-stage pr-progress-${key}" data-stage="${key}" aria-pressed="${key===bucket}">
      <strong>${counts.get(key)||0}</strong><span>${esc(label)}</span></button>`).join("");
    const entries=selected.slice(page*pageSize,(page+1)*pageSize).map(entry=>{
      const r=entry.r,expanded=opened===r.requestId;
      return `<article class="pr-flow-item pr-progress-${r.progress}"><button type="button" class="pr-flow-open" data-inspect="${r.requestId}" aria-expanded="${expanded}">
        <span><small>${displayDate(r.date)} · ЗВП ${esc(r.number)}</small><strong>${esc(r.item)}</strong><small>${esc(r.state)}</small></span>
        <span class="pr-flow-values">${[["Нужно",r.qty],["Заказано",r.ordered],["Оплачено¹",r.paid_qty]].map(([name,v])=>`<span><small>${name}</small><b>${qty(v)}</b> ${esc(r.unit)}</span>`).join("")}</span>
        <span aria-hidden="true">${expanded?"−":"+"}</span></button>${expanded?inspect(entry):""}</article>`;
    }).join("");
    host.innerHTML=`<nav class="pr-stages" aria-label="Состояние позиций">${buttons}</nav>
      <div class="pr-flow-title"><h3>${esc(buckets.find(([key])=>key===bucket)?.[1]||"Все позиции")} · ${selected.length}</h3>
      ${bucket?'<button type="button" data-stage="" class="pr-sort pr-match-action">Все состояния</button>':""}</div>
      ${entries||'<p class="pr-note">Подходящих позиций нет.</p>'}
      <small class="v2-muted">¹ Оплаченное количество рассчитано по доле оплаты заказа.</small>
      ${selected.length>pageSize?`<div class="pr-actions"><button class="v2-btn" data-step="-1" ${page?"":"disabled"}>Назад</button>
      ${page+1} / ${Math.ceil(selected.length/pageSize)} <button class="v2-btn" data-step="1" ${(page+1)*pageSize>=selected.length?"disabled":""}>Далее</button></div>`:""}`;
  }
  host.onclick=e=>{
    const b=e.target.closest("button");if(!b)return;
    if(b.hasAttribute("data-stage")){bucket=bucket===b.dataset.stage?"":b.dataset.stage;page=0;opened=null;}
    else if(b.dataset.inspect)opened=opened===b.dataset.inspect?null:b.dataset.inspect;
    else if(b.dataset.step){page+=Number(b.dataset.step);opened=null;}
    else return;
    render();
    const selector=b.dataset.inspect?'[data-inspect]':b.hasAttribute("data-stage")?'[data-stage]':'[data-step]';
    [...host.querySelectorAll(selector)].find(n=>n.getAttribute(selector.slice(1,-1))===b.getAttribute(selector.slice(1,-1)))?.focus({preventScroll:true});
  };
  return {
    update(model){
      indexed=[];
      for(const doc of model.groups){
        const byRequest=new Map(),unallocated=[];
        for(const order of doc.orders.values()){
          const linked=new Set();
          for(const line of order.lines){
            if(line.raw.unallocated_qty>1e-9 && !line.raw.cancelled)unallocated.push(line);
            for(const link of line.raw.links)linked.add(link.request_line_id);
          }
          for(const id of linked){
            if(!byRequest.has(id))byRequest.set(id,[]);
            byRequest.get(id).push(order);
          }
        }
        for(const r of doc.requests){
          const orders=byRequest.get(r.requestId)||[];
          const terms=[r.item,r.order_item,r.number,displayDate(r.date),r.warehouse,r.category,r.mapping,r.state,
            ...orders.flatMap(o=>[o.order_number,o.supplier,...o.payments.map(p=>p.payment_number)])];
          indexed.push({r,orders,unallocated,text:terms.join(" ").toLocaleLowerCase("ru")});
        }
      }
      indexed.sort((a,b)=>b.r.date.localeCompare(a.r.date));
    },
    reset(){bucket="";opened=null;page=0;},
    filter(query,predicate){
      const term=query.toLocaleLowerCase("ru");
      filtered=indexed.filter(x=>x.text.includes(term)&&predicate(x.r,"requests"));page=0;render();
    }
  };
}
