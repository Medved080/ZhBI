import { esc } from "./screen-view.js";
import { viewColumns, tableModel, matchesColumns, sortRows, rub } from "./procurement-table-model.js";

export function createProcurementTable(host,{writable,onRequest,onMap,onPage}) {
  let model=null,view="chain",query="",predicate=()=>true,page=0;
  const states=new Map(),closed=new Set();
  const expandedReferences=new Set();
  let cardScrollLeft=0;
  // The header and cards share one column grid and horizontal scroll position.
  const columnWidths={date:110,number:150,item:320,unit:86,qty:110,ordered:110,percent:110,
    state:260,mapping:230,order_date:110,payment_date:110,order_number:150,payment_number:150};
  host.addEventListener("scroll",event=>{
    const pane=event.target;
    if(!pane.classList?.contains("pr-card-viewport") || pane.scrollLeft===cardScrollLeft)return;
    cardScrollLeft=pane.scrollLeft;
    for(const other of host.querySelectorAll(".pr-card-viewport")){
      if(other!==pane)other.scrollLeft=cardScrollLeft;
    }
  },true);
  let columnMode="all", snapshot=null;
  const presets={
    quantities:new Set(["date","number","item","unit","qty","ordered","percent","remaining","excess","paid_qty","mapping","state","order_number","payment_number"]),
    money:new Set(["date","number","item","amount","paid","state","order_date","order_number","payment_date","payment_number","supplier"])
  };
  const state=()=>{
    if(!states.has(view)) states.set(view,{sort:{id:"date",direction:1},filters:{}});
    return states.get(view);
  };
  const btn=(text,attrs)=>`<button type="button" class="pr-sort" ${attrs}>${text}</button>`;
  const lines=value=>esc(Array.isArray(value)?value.join("\n"):value??"").replace(/\n/g,"<br>");
  function row(r,cols,level=0,group=false) {
    const status=r.progress ? ` pr-progress-${r.progress}` : "";
    return `<tr class="${group?"pr-group":"pr-data"}${status}" data-kind="${esc(group?r.kind:r.kind||view)}" data-level="${level}" ${group?`data-group="${r.groupKey}"`:""}>${cols.map((c,i)=>{
      let value=esc(c.format(r[c.id])).replace(/\n/g,"<br>");
      if(group && c.id===(r.kind==="ЗП"?"order_number":"number")) {
        const name=`${r.kind} ${r.kind==="ЗП"?r.order_number:r.number}`;
        value=`<button type="button" class="pr-group-toggle" data-toggle="${r.groupKey}" aria-expanded="${!closed.has(r.groupKey)}" aria-label="${closed.has(r.groupKey)?"Развернуть":"Свернуть"} ${esc(name)}" title="${closed.has(r.groupKey)?"Развернуть":"Свернуть"} группу"><span class="pr-toggle-icon" aria-hidden="true">${closed.has(r.groupKey)?"+":"−"}</span><span>${esc(r.kind)} ${value}</span></button>`;
      }
      else if(c.id==="number" && r.requestId) value=btn(value,`data-request="${r.requestId}"`);
      if(c.id==="item") {
        if(group && r.kind==="ЗВП") {
          value+=`<small>${esc(r.state)}</small><small>Заказано ${esc(rub(r.amount))} · оплачено ${esc(rub(r.paid))}</small>`;
        }
        if(r.requestId || r.orderId) {
          const cancelled=r.raw.cancelled;
          const missing=cancelled?"Не применимо (отменено)":"Не сопоставлено";
          const source=lines(r.request_item)||missing,ordered=lines(r.order_item)||(r.mapping==="Заказ поставщику не найден"?"Заказ не найден":missing);
          value=`<div class="pr-item-pair"><div><span class="pr-pair-label">ЗВП</span><span>${source}</span></div><div><span class="pr-pair-label">ЗП</span><span>${ordered}</span></div><span class="pr-mapping-note ${r.mapping.includes("Не удалось")||r.mapping.includes("частично")?"pr-mapping-unresolved":""}">${esc(r.mapping)}</span></div>`;
          if(r.orderId && writable && !cancelled) value+=`<button type="button" class="pr-sort pr-match-action" data-map="${r.orderId}">Сопоставить</button>`;
        }
        if(level) value=`<div class="pr-indent" style="--pr-level:${level}">${value}</div>`;
      }
      if(c.id==="payment_date" && r.payment_number?.length) {
        const dates=Array.isArray(r.payment_date)?r.payment_date:[r.payment_date];
        value=dates.map(d=>d?esc(c.format(d)):"<span class=\"pr-missing-date\">Не указана</span>").join("<br>");
      }
      if(c.id==="payment_number" && r.payment_note) value+=`<small class="pr-payment-gap">${esc(r.payment_note)}</small>`;
      if(group && ["order_number","order_date","payment_number","payment_date"].includes(c.id) && Array.isArray(r[c.id]) && r[c.id].length>2) {
        const expanded=expandedReferences.has(r.groupKey);
        if(!expanded) value=value.split("<br>").slice(0,2).join("<br>");
        value+=`<br><button type="button" class="pr-sort pr-match-action" data-refs="${r.groupKey}" aria-expanded="${expanded}">${expanded?"Скрыть список":`Ещё ${r[c.id].length-2}`}</button>`;
      }
      if(c.id==="state" && r.kind==="ЗРДС") value+="<small>Сумма всего ЗП; в другие ЗВП может входить тот же документ</small>";
      return `<td data-field="${c.id}" class="${i===0?"pr-date ":""}${c.id==="number"?"pr-doc-number ":""}${["qty","ordered","percent","remaining","excess","paid_qty","amount","paid"].includes(c.id)?"pr-num":""}">${value}</td>`;
    }).join("")}</tr>`;
  }
  function render() {
    if(!model || host.hidden) return;
    const active=document.activeElement, focus=host.contains(active)&&active.dataset.column;
    const selection=focus?[active.selectionStart,active.selectionEnd]:null;
    const scroll=[host.scrollLeft,host.scrollTop];
    const all=viewColumns(view),s=state();
    const cols=columnMode==="all"?all:all.filter(c=>presets[columnMode].has(c.id));
    if(columnMode!=="all"){
      const priority=[...presets[columnMode]];
      cols.sort((a,b)=>priority.indexOf(a.id)-priority.indexOf(b.id));
    }
    const matches=r=>(view==="chain" || predicate(r,view))&&matchesColumns(r,all,query,s.filters);
    const sort=rs=>sortRows(rs,s.sort);
    const header=`<thead><tr>${cols.map((c,i)=>`<th data-field="${c.id}" class="${i===0?"pr-date ":""}${c.id==="number"?"pr-doc-number":""}" aria-sort="${s.sort.id===c.id?s.sort.direction===1?"ascending":"descending":"none"}">
      ${btn(`<span>${esc(c.label)}</span><span class="pr-sort-direction">${s.sort.id===c.id?s.sort.direction===1?"↑":"↓":"↕"}</span>`,`data-sort="${c.id}"`)}
      <input type="search" data-column="${c.id}" aria-label="Найти: ${esc(c.label)}" placeholder="Найти…" value="${esc(s.filters[c.id]||"")}"></th>`).join("")}</tr></thead>`;
    let body="",count=0,unit="строк",size=100;
    const cards=[];
    if(view==="chain") {
      size=25;unit="групп ЗВП";
      const groups=sort(model.groups.filter(d=>predicate(d,"chain"))).map(d=>{
        const parentMatch=matches(d);
        const req=sort(d.requests.filter(r=>parentMatch||matches(r)));
        const orders=sort([...d.orders.values()]).map(o=>{
          const match=parentMatch||matches(o);
          const lines=sort(o.lines.filter(l=>match||matches(l)));
          const payments=sort(o.payments.filter(p=>match||matches(p)));
          return {...o,lines,payments,visible:match||lines.length||payments.length};
        }).filter(o=>o.visible);
        return {...d,requests:req,children:orders,visible:parentMatch||req.length||orders.length};
      }).filter(d=>d.visible);
      // Unresolved references stay visible without inventing a parent ZВП.
      const detached=model.detached.filter(matches),orphan=model.orphanPayments.filter(matches);
      if((detached.length||orphan.length) && predicate({requests:[],date:"",progress:"unknown"},"chain")) groups.push({groupKey:"unlinked",kind:"Без связанной ЗВП",number:"—",date:null,item:"Документы без однозначной цепочки",requests:[],children:[],loose:[...sort(detached),...sort(orphan)]});
      count=groups.length;page=Math.max(0,Math.min(page,Math.ceil(count/size)-1));
      for(const d of groups.slice(page*size,(page+1)*size)) {
        const card={label:`${d.kind} ${d.number}`,html:row(d,cols,0,true)};
        cards.push(card);
        if(closed.has(d.groupKey)) continue;
        card.html+=d.requests.map(r=>row(r,cols,1)).join("");
        for(const o of d.children) {
          card.html+=row(o,cols,1,true);
          if(!closed.has(o.groupKey)) card.html+=o.lines.map(r=>row(r,cols,2)).join("")+o.payments.map(r=>row(r,cols,3)).join("");
        }
        card.html+=(d.loose||[]).map(r=>row(r,cols,1)).join("");
      }
    } else {
      const rows=sort(model[view].filter(matches));count=rows.length;page=Math.max(0,Math.min(page,Math.ceil(count/size)-1));
      body=rows.slice(page*size,(page+1)*size).map(r=>row(r,cols)).join("");
    }
    host.classList.toggle("pr-card-list",view==="chain");
    if(view==="chain"){
      const widths=cols.map(c=>columnWidths[c.id]||150);
      const width=widths.reduce((sum,n)=>sum+n,0);
      const grid=`<colgroup>${widths.map(w=>`<col style="width:${w}px">`).join("")}</colgroup>`;
      const cardTable=(content,label)=>`<table aria-label="${esc(label)}" class="pr-table pr-analysis-table" style="width:${width}px">${grid}${content}</table>`;
      host.innerHTML=`<div class="pr-card-head pr-card-viewport">${cardTable(header,"Поиск и сортировка")}</div>`+
        cards.map(card=>`<section class="pr-request-card"><div class="pr-card-viewport">${cardTable(`<tbody>${card.html}</tbody>`,card.label)}</div></section>`).join("")+
        (cards.length?"":"<p>Нет подходящих строк</p>");
      for(const pane of host.querySelectorAll(".pr-card-viewport"))pane.scrollLeft=cardScrollLeft;
    }else{
      host.innerHTML=`<table class="pr-table pr-analysis-table">${header}<tbody>${body||`<tr><td colspan="${cols.length}">Нет подходящих строк</td></tr>`}</tbody></table>`;
    }
    host.scrollLeft=scroll[0];host.scrollTop=scroll[1];
    if(focus) {const input=host.querySelector(`[data-column="${focus}"]`);input.focus({preventScroll:true});input.setSelectionRange(...selection);}
    onPage({page,count,size,unit});
  }
  host.addEventListener("input",e=>{
    if(!e.target.dataset.column)return;state().filters[e.target.dataset.column]=e.target.value;if(e.target.value)closed.clear();page=0;render();
  });
  host.addEventListener("click",e=>{
    const b=e.target.closest("button");if(!b)return;
    if(b.dataset.sort){const s=state();s.sort={id:b.dataset.sort,direction:s.sort.id===b.dataset.sort?-s.sort.direction:1};page=0;render();}
    if(b.dataset.toggle){const k=b.dataset.toggle;closed.has(k)?closed.delete(k):closed.add(k);render();}
    if(b.dataset.refs){const key=b.dataset.refs;expandedReferences.has(key)?expandedReferences.delete(key):expandedReferences.add(key);render();}
    if(b.dataset.request)onRequest(b.dataset.request);
    if(b.dataset.map)onMap(b.dataset.map);
  });
  return {
    get model(){return model;},
    update(report){
      model=tableModel(report);
      if(snapshot!==report.id){
        snapshot=report.id;
        closed.clear();
        expandedReferences.clear();
        for(const doc of model.groups)closed.add(doc.groupKey);
        closed.add("unlinked");
      }
      const counts={open:0};
      for(const r of model.requests){
        counts[r.progress]=(counts[r.progress] || 0)+1;
        if(!["complete","cancelled"].includes(r.progress))counts.open++;
      }
      page=0;render();return counts;
    },
    setColumns(mode){
      columnMode=mode;
      for(const s of states.values()){
        if(mode==="all")continue;
        for(const key of Object.keys(s.filters))if(!presets[mode].has(key))delete s.filters[key];
        if(!presets[mode].has(s.sort.id))s.sort={id:"date",direction:1};
      }
      page=0;host.scrollLeft=0;render();
    },
    show(next){view=next;page=0;render();},
    filter(nextQuery,nextPredicate){if(nextQuery && nextQuery!==query)closed.clear();query=nextQuery;predicate=nextPredicate;page=0;render();},
    move(delta){page+=delta;render();},
    reset(){state().filters={};state().sort={id:"date",direction:1};query="";page=0;render();},
    collapseAll(){for(const d of model?.groups||[]){closed.add(d.groupKey);for(const o of d.orders.values())closed.add(o.groupKey);}closed.add("unlinked");render();},
    expandAll(){closed.clear();render();},
  };
}
