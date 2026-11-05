import { esc } from "./screen-view.js";
import { displayDate, qty } from "./procurement-table-model.js";

const epsilon=1e-9;

export function openMappingDialog(host, report, orderId, actions) {
  const initial=report.orders.find(o=>o.id===orderId);
  if(!initial || initial.cancelled)return;
  const requests=new Map(report.requests.map(r=>[r.id,r]));
  const first=requests.get(initial.candidates[0]);
  const parent=first?.document_key;
  const orders=report.orders.filter(o=>!o.cancelled && (o.id===orderId ||
    (parent && requests.get(o.candidates[0])?.document_key===parent)));
  const available=orders.filter(o=>o.unallocated_qty>epsilon);
  let selectedOrder=initial, selectedRequest=null, editing=false, saving=false;
  host.innerHTML=`<dialog class="pr-mapping-dialog pr-map" aria-labelledby="pr-mapping-title">
    <fieldset><header><div><h3 id="pr-mapping-title">Сопоставление позиций</h3>
    <p>ЗВП ${esc(initial.request_number || "без номера")} ${first?"от "+displayDate(first.date):""}</p></div>
    <button type="button" class="v2-btn" id="pr-map-cancel">Закрыть</button></header>
    <div class="pr-match-lists">
      <section><h4>Потребности ЗВП с остатком</h4><input type="search" aria-label="Поиск в ЗВП" placeholder="Найти номенклатуру ЗВП">
      <div class="pr-options" id="pr-request-options"></div></section>
      <section><h4>Нераспределённые позиции ЗП</h4><input type="search" aria-label="Поиск в ЗП" placeholder="Найти номенклатуру или номер ЗП">
      <div class="pr-options" id="pr-order-options"></div></section>
    </div>
    <div class="pr-match-selection"><p id="pr-pair" role="status"></p><div class="pr-actions">
      <label>Количество из ЗП <span id="pr-order-unit"></span><input type="number" step="any" min="0" aria-label="Количество из ЗП" id="pr-order-qty"></label>
      <label>Эквивалент потребности <span id="pr-request-unit"></span><input type="number" step="any" min="0" aria-label="Эквивалент потребности" id="pr-request-qty"></label>
      <button type="button" class="v2-btn" id="pr-map-save">Сохранить пару</button></div></div>
    <p id="pr-map-error" class="pr-error" role="alert"></p>
    <details id="pr-current-links"><summary>Сохранённые сопоставления</summary><div></div></details>
    </fieldset></dialog>`;
  const dialog=host.querySelector("dialog");
  const fieldset=dialog.querySelector("fieldset");
  const get=id=>dialog.querySelector("#"+id);
  const orderQty=get("pr-order-qty"), requestQty=get("pr-request-qty");
  function options(id,items,name,render,selected) {
    get(id).innerHTML=items.map(item=>`<label class="pr-option"><input type="radio" name="${name}" value="${esc(item.id)}" ${item===selected?"checked":""}><span>${render(item)}</span></label>`).join("")+
      '<p class="pr-no-options" hidden>Подходящих позиций нет.</p>';
    filterList(get(id).parentElement);
  }
  function filterList(section) {
    const query=section.querySelector('input[type=search]').value.trim().toLocaleLowerCase("ru");
    const labels=[...section.querySelectorAll(".pr-option")];
    for(const label of labels)label.hidden=!label.textContent.toLocaleLowerCase("ru").includes(query);
    section.querySelector(".pr-no-options").hidden=labels.some(label=>!label.hidden);
  }
  function drawLists(){
    options("pr-order-options",available,"pr-order",o=>
      `${esc(o.item)}<small>ЗП ${esc(o.number)} · остаток ${qty(o.unallocated_qty)} ${esc(o.unit)}</small>`,selectedOrder);
    const choices=(selectedOrder?.candidates || []).map(id=>requests.get(id)).filter(r=>r&&!r.cancelled&&r.remaining_qty>epsilon);
    options("pr-request-options",choices,"pr-request",r=>
      `${esc(r.item)}<small>Осталось заказать ${qty(r.remaining_qty)} ${esc(r.unit)}</small>`,selectedRequest);
  }
  function pair(link=null){
    const ready=selectedRequest && selectedOrder;
    const orderRemaining=selectedOrder.unallocated_qty;
    get("pr-pair").textContent=ready ?
      `${editing?"Изменение пары":"Выбранная пара"} · ${selectedRequest.item} → ${selectedOrder.item} (ЗП ${selectedOrder.number})` :
      "Выберите потребность ЗВП и позицию ЗП.";
    get("pr-order-unit").textContent=selectedOrder.unit;
    get("pr-request-unit").textContent=selectedRequest?.unit || "";
    orderQty.disabled=requestQty.disabled=get("pr-map-save").disabled=!ready;
    const sameUnit=ready && selectedRequest.unit===selectedOrder.unit;
    orderQty.value=link?.order_qty ?? (ready?(sameUnit?Math.min(orderRemaining,selectedRequest.remaining_qty):orderRemaining):"");
    requestQty.value=link?.request_qty ?? (sameUnit?orderQty.value:"");
    get("pr-map-error").textContent="";
  }
  function plainLinks(order){
    return order.links.map(({request_line_id,order_qty,request_qty})=>({request_line_id,order_qty,request_qty}));
  }
  async function commit(order,links,reset=false){
    if(saving)return;
    saving=true;fieldset.disabled=true;
    try {await actions.save(order.id,links,reset);}
    catch(e){get("pr-map-error").textContent=e.message;}
    finally {saving=false;fieldset.disabled=false;}
  }
  get("pr-map-save").onclick=()=>{
    if(!selectedRequest || !selectedOrder)return;
    const oq=orderQty.valueAsNumber,rq=requestQty.valueAsNumber;
    const links=plainLinks(selectedOrder);
    const previous=links.find(a=>a.request_line_id===selectedRequest.id);
    const limit=selectedOrder.unallocated_qty+(editing && previous?previous.order_qty:0);
    if(!Number.isFinite(oq)||!Number.isFinite(rq)||oq<=0||rq<=0||oq>limit+epsilon){
      get("pr-map-error").textContent=`Введите два положительных количества. Доступно из ЗП: ${qty(limit)} ${selectedOrder.unit}.`;
      return;
    }
    if(previous){
      previous.order_qty=editing?oq:previous.order_qty+oq;
      previous.request_qty=editing?rq:previous.request_qty+rq;
    }else links.push({request_line_id:selectedRequest.id,order_qty:oq,request_qty:rq});
    commit(selectedOrder,links);
  };
  dialog.onchange=e=>{
    if(e.target.name==="pr-order"){
      selectedOrder=available.find(o=>o.id===e.target.value);
      if(!selectedOrder.candidates.includes(selectedRequest?.id))selectedRequest=null;
    }else if(e.target.name==="pr-request"){
      selectedRequest=requests.get(e.target.value);
      if(!available.includes(selectedOrder))selectedRequest=null;
    }else return;
    editing=false;drawLists();pair();actions.changed();
  };
  dialog.oninput=e=>{
    if(e.target.type==="search")filterList(e.target.closest("section"));
    if(e.target.type==="number")actions.changed();
  };
  const history=get("pr-current-links");
  history.querySelector("div").innerHTML=orders.filter(o=>o.links.length||o.manual).map(o=>
    `<section><strong>ЗП ${esc(o.number)} · ${esc(o.item)}</strong>${o.links.map(l=>
      `<p>${esc(requests.get(l.request_line_id)?.item)} · ${qty(l.order_qty)} ${esc(o.unit)} → ${qty(l.request_qty)} ${esc(requests.get(l.request_line_id)?.unit)}
      <button class="v2-btn" data-edit="${o.id}" data-rid="${l.request_line_id}">Изменить</button>
      <button class="v2-btn" data-remove="${o.id}" data-rid="${l.request_line_id}">Снять связь</button></p>`).join("")}
      ${o.manual?`<button class="v2-btn" data-reset="${o.id}">Вернуть автоматическое сопоставление</button>`:""}</section>`
  ).join("") || "<p>Сохранённых пар нет.</p>";
  history.onclick=e=>{
    const b=e.target.closest("button");if(!b||saving)return;
    const order=orders.find(o=>o.id===(b.dataset.edit||b.dataset.remove||b.dataset.reset));
    if(!order)return;
    if(b.dataset.edit){
      selectedOrder=order;selectedRequest=requests.get(b.dataset.rid);editing=true;
      drawLists();pair(order.links.find(l=>l.request_line_id===selectedRequest.id));orderQty.focus();
    }else if(b.dataset.remove && window.confirm("Снять связь этой пары?")){
      commit(order,plainLinks(order).filter(a=>a.request_line_id!==b.dataset.rid));
    }else if(b.dataset.reset && window.confirm("Вернуть автоматическое сопоставление этой строки ЗП?")){
      commit(order,[],true);
    }
  };
  get("pr-map-cancel").onclick=()=>actions.close();
  dialog.oncancel=e=>{e.preventDefault();if(!saving)actions.close();};
  if(!available.includes(initial) && available.length)selectedOrder=available[0];
  history.open=!initial.unallocated_qty && !!initial.links.length;
  drawLists();pair();dialog.showModal();
}
