import { esc } from "./screen-view.js";
import { createProcurementOverview } from "./procurement-overview.js";
import { createRequestCards } from "./procurement-request-cards.js";
import { openMappingDialog } from "./procurement-mapping-dialog.js";
import { createProcurementTable } from "./procurement-table.js";
import { progressLabels, displayDate, paymentInfo } from "./procurement-table-model.js";

const fmt = (v, digits=2) => v == null ? "нет данных" : Number(v).toLocaleString("ru-RU", {maximumFractionDigits:digits});
const money = v => fmt(v / 100) + " ₽";
const savedTime = v => new Date(v.replace(" ", "T") + "Z").toLocaleString("ru-RU", {timeZone:"Europe/Moscow"}) + " МСК";
const labels = {not_ordered:"Не заказано", partial:"Заказано частично", ordered:"Заказано полностью", excess:"Сверх потребности", needs_mapping:"Требует сопоставления ЗП", cancelled:"Отменено"};
const button = (text, attrs="") => `<button type="button" class="v2-btn" ${attrs}>${text}</button>`;

export function mountProcurementScreen(el, {api, rights, screen}) {
  if (!document.querySelector("link[data-procurement-css]")) {
    const css=document.createElement("link"); css.rel="stylesheet"; css.href="/static/v2/procurement.css";
    css.dataset.procurementCss="1"; document.head.append(css);
  }
  const writable = rights?.system_admin || rights?.features?.procurement === "write";
  let report=null, preview=null, selectedFile=null, snapshotId=null, tab="overview", focusedDocument=null, busy=false, disposed=false, dirty=false, generation=0;
  el.className="v2-page";
  el.innerHTML=`<div class="v2-container v2-screen pr-page"><div class="v2-crumbs">Документы</div>
    <div class="pr-heading"><h2>${esc(screen.title)}</h2>
    <div class="pr-toolbar"><label>Сохранённая загрузка<select id="pr-snapshot" aria-label="Сохранённая загрузка"></select></label>${button("Обновить",'id="pr-refresh"')}</div>
    </div><details id="pr-import" ${writable ? "" : "hidden"}><summary>Загрузить Excel</summary>
      <p>Нужны листы «ЗВП», «ЗП», «Оплаты ЗРДС». Каждая выгрузка сохраняется отдельным снимком. Повтор того же файла не добавляет оплаты.</p>
      <div class="pr-actions"><input type="file" id="pr-file" accept=".xlsx" aria-label="Файл закупок и оплат">${button("Анализировать файл",'id="pr-analyze"')}${button("Сохранить загрузку",'id="pr-apply" hidden')}</div><div id="pr-preview"></div></details>
    <p id="pr-error" class="pr-error" role="alert"></p><p id="pr-status" role="status" aria-live="polite"></p>
    <div id="pr-content" hidden><div class="pr-summary-line"><strong>По всей загрузке</strong><span id="pr-doc-counts"></span></div><div id="pr-metrics" class="pr-metrics"></div><details class="pr-checks"><summary id="pr-check-title">Сверка загрузки</summary><div id="pr-warnings"></div></details>
      <details class="pr-note"><summary>Как считаются количества и оплаты</summary>
      <p>Совпадающие наименования и единицы в одной ЗВП связываются автоматически. Замену сопоставьте вручную: укажите количество из заказа и эквивалент в единицах исходной потребности. Одна позиция ЗП может распределяться на несколько позиций своей ЗВП.</p>
      <p>«Оплачено» — сумма «СуммаРасход» из листа «Оплаты ЗРДС». Она распределяется между действующими позициями всего ЗП пропорционально стоимости с НДС. Оплаченное количество — расчётная доля количества, а не подтверждение оплаты конкретной позиции или поставки. При переплате количество ограничено заказанным. ЗРДС сама по себе не доказывает проведение платежа в банке.</p>
      <p>Отменённые строки исключены. Повторы строк сохранены. Количества разных номенклатур и единиц не суммируются. Фильтры меняют таблицу, итоги выше относятся ко всей загрузке.</p></details>
      <div id="pr-shortcuts" class="pr-shortcuts" aria-label="Быстрый отбор позиций"></div>
      <div class="pr-tabs">${[ ["overview","Обзор исполнения"],["chain","ЗВП → ЗП → ЗРДС"],["cards","Карточка заявки"],["requests","Потребности ЗВП"],["orders","Заказы и замены"],["payments","Оплаты ЗРДС"] ].map(([id,label])=>button(label,`data-tab="${id}" aria-pressed="${id===tab}"`)).join("")}</div>
      <div class="pr-filters"><label><span id="pr-search-label">Поиск</span><input id="pr-search" type="search" placeholder="Дата, номер, количество, состояние…"></label>
      <label>Состояние<select id="pr-filter"></select></label><label>Колонки<select id="pr-columns"><option value="all">Все колонки</option><option value="quantities">Количество и замены</option><option value="money">Суммы и оплаты</option></select></label>
      <details class="pr-extra"><summary>Дополнительные фильтры</summary><div class="pr-actions"><label data-demand-filter>Склад<select id="pr-warehouse"><option value="">Все склады</option></select></label>
      <label data-demand-filter>Категория<select id="pr-category"><option value="">Все категории</option></select></label>
      <label data-demand-filter>Дата ЗВП с<input id="pr-from" type="date"></label><label data-demand-filter>по<input id="pr-to" type="date"></label></div></details>${button("Сбросить отбор",'id="pr-clear-search"')}</div>
      <div id="pr-group-actions" class="pr-actions">${button("Свернуть все группы",'id="pr-collapse-all"')}${button("Развернуть все группы",'id="pr-expand-all"')}<span class="v2-muted">Кнопки + / − у номера сворачивают отдельную ЗВП или ЗП.</span></div>
      <div id="pr-focus" class="pr-focus" hidden></div><div id="pr-editor"></div><div id="pr-detail"></div><div id="pr-overview" hidden></div><div id="pr-cards" hidden></div><div class="pr-scroll" id="pr-table"></div>
      <div class="pr-actions">${button("Назад",'id="pr-prev"')}<span id="pr-page"></span>${button("Далее",'id="pr-next"')}</div></div></div>`;
  const $=s=>el.querySelector(s);
  const grid=createProcurementTable($("#pr-table"),{writable,onRequest:detail,onMap:editor,onPage:({page,count,size,unit})=>{
    $("#pr-page").textContent=count?`${page*size+1}–${Math.min(count,(page+1)*size)} из ${count} ${unit}`:"0 строк";
    $("#pr-prev").disabled=page===0;$("#pr-next").disabled=(page+1)*size>=count;
  }});
  const overview=createProcurementOverview($("#pr-overview"),writable);
  const cards=createRequestCards($("#pr-cards"),writable);
  const error=e=>{if(!disposed) $("#pr-error").textContent=e?.message || String(e);};
  function setBusy(value) {
    busy=value;
    for (const s of ["#pr-analyze","#pr-apply","#pr-file","#pr-snapshot","#pr-refresh"]) {
      el.querySelectorAll(s).forEach(b=>b.disabled=value);
    }
  }
  async function leaveEditor() {
    if (busy || (dirty && !window.confirm("Закрыть сопоставление без сохранения?"))) return false;
    $("#pr-editor dialog")?.close();
    dirty=false; $("#pr-editor").replaceChildren(); return true;
  }
  async function listSnapshots(preferred) {
    const result=await api.get("/procurement/snapshots"); if(disposed) return;
    $("#pr-snapshot").innerHTML=result.items.map(s=>`<option value="${s.id}">${esc(s.filename)} · ${esc(savedTime(s.created_at))}</option>`).join("");
    if (!result.items.length) {$("#pr-status").textContent="Пока нет загрузок. Выберите Excel и выполните анализ."; return;}
    snapshotId=String(preferred || result.items[0].id); $("#pr-snapshot").value=snapshotId;
    await load();
  }
  async function load() {
    const token=++generation;
    $("#pr-content").hidden=true;
    $("#pr-error").textContent="";
    $("#pr-status").textContent="Загрузка анализа…";
    const next=await api.get(`/procurement/snapshots/${snapshotId}`);
    if(disposed || token!==generation) return;
    report=next; dirty=false; $("#pr-editor").replaceChildren(); $("#pr-detail").replaceChildren();
    $("#pr-content").hidden=false; $("#pr-status").textContent=`Загрузка: ${report.filename}`;
    const s=report.summary;
    $("#pr-doc-counts").textContent=`ЗВП — ${s.request_documents} · позиций — ${s.request_lines} · ЗП — ${s.order_documents} · строк оплат — ${s.payment_rows}`;
    $("#pr-metrics").innerHTML=[
      ["Заказано с НДС",s.ordered_cents],["Оплачено по ЗП",s.paid_cents],
      ["Осталось оплатить",s.unpaid_cents],["Переплата по ЗП",s.overpaid_cents]
    ].map(([label,cents])=>`<div class="pr-metric">${label}<strong>${esc(money(cents))}</strong></div>`).join("");
    $("#pr-check-title").textContent=`Сверка загрузки · предупреждений: ${report.warnings.length + Number(s.zero_value_paid_cents>0)}`;
    $("#pr-warnings").innerHTML=`<p class="v2-muted">Исключено отменённых позиций: ЗВП — ${s.cancelled_requests}, ЗП — ${s.cancelled_orders}. Подтверждённых замен: ${s.replacements}.</p>` + report.warnings.map(w=>`<p class="pr-warning">${esc(w)}</p>`).join("") +
      (s.zero_value_paid_cents ? `<p class="pr-warning">${money(s.zero_value_paid_cents)} относятся к ЗП с нулевой стоимостью. Распределить по позициям невозможно.</p>`:"");
    for (const [id, field, label] of [["warehouse","warehouse","Все склады"],["category","category","Все категории"]]) {
      const select=$("#pr-"+id), prev=select.value;
      select.innerHTML=`<option value="">${label}</option>`+[...new Set(report.requests.map(r=>r[field]))].sort().map(v=>`<option>${esc(v)}</option>`).join(""); select.value=prev;
    }
    if(focusedDocument && !report.requests.some(r=>r.document_key===focusedDocument)) clearFocus();
    filterOptions();
    const counts=grid.update(report);
    cards.update(grid.model);
    overview.update(grid.model);
    const shortcuts=[
      ["requests","open","Незакрытые потребности",counts.open],
      ["requests","progress:ordered_unpaid","Ожидают полной оплаты",counts.ordered_unpaid || 0],
      ["orders","unmapped","Требуют сопоставления",s.unmapped_orders],
      ["payments","orphan","Оплаты без ЗП",s.orphan_payments]
    ];
    $("#pr-shortcuts").innerHTML=shortcuts.map(([view,filter,label,count])=>
      `<button type="button" class="v2-btn" data-shortcut="${filter}" data-view="${view}">${label} <b>${count}</b></button>`).join("");
    renderTable();
  }
  function filterOptions() {
    const progressOptions=Object.entries(progressLabels).map(([k,v])=>["progress:"+k,v]);
    const options=["chain","cards"].includes(tab) ? progressOptions : tab==="requests" ? progressOptions.concat([["open","Незакрытые потребности"]],Object.entries(labels),[["replacement","С заменами"]]) : tab==="orders" ? progressOptions.concat([["unmapped","Нужно сопоставить"],["replacement","Подтверждённые замены"],["cancelled","Отменено"]]) : [["orphan","Без найденного ЗП"],["linked","Связаны с ЗП"]];
    $("#pr-filter").innerHTML='<option value="">Все состояния</option>'+options.map(([v,l])=>`<option value="${v}">${l}</option>`).join("");
    el.querySelectorAll("[data-demand-filter]").forEach(e=>e.hidden=!["chain","cards","requests","overview"].includes(tab));
    const cardView=tab==="cards", summaryView=tab==="overview", listView=cardView||summaryView;
    $("#pr-overview").hidden=!summaryView;
    $("#pr-shortcuts").hidden=summaryView;
    $("#pr-filter").closest("label").hidden=summaryView;
    $("#pr-search-label").textContent=listView?"Поиск по заявкам и позициям":"Поиск по всем колонкам";
    $("#pr-search").placeholder=listView?"Номенклатура, номер ЗВП, ЗП или ЗРДС":"Дата, номер, количество, состояние…";
    $("#pr-cards").hidden=!cardView;
    $("#pr-table").hidden=listView;
    for(const panel of [$("#pr-overview"),$("#pr-cards"),$("#pr-table")]){
      if(panel.hidden)panel.replaceChildren();
    }
    $("#pr-page").closest(".pr-actions").hidden=listView;
    $("#pr-columns").closest("label").hidden=listView;
    $("#pr-group-actions").hidden=tab!=="chain";
    $(".pr-extra").hidden=!["chain","cards","requests","overview"].includes(tab);
  }
  function table(headers, rows) { return `<table class="pr-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">Нет подходящих строк</td></tr>`}</tbody></table>`; }
  const td=(v,cls="")=>`<td class="${cls}">${v}</td>`;
  function renderTable() {
    if(!report) return;
    const state=$("#pr-filter").value;
    el.querySelectorAll("[data-shortcut]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.view===tab && b.dataset.shortcut===state)));
    const activeView=tab==="overview"?overview:tab==="cards"?cards:grid;
    activeView.filter($("#pr-search").value.trim(),(row,view)=>{
      const r=row.raw||row;
      if(["chain","requests"].includes(view)) {
        const values=field=>view==="chain"?row.requests.map(v=>v[field]):[row[field]];
        if($("#pr-warehouse").value && !values("warehouse").includes($("#pr-warehouse").value))return false;
        if($("#pr-category").value && !values("category").includes($("#pr-category").value))return false;
        if($("#pr-from").value && row.date.slice(0,10)<$("#pr-from").value || $("#pr-to").value && row.date.slice(0,10)>$("#pr-to").value)return false;
      }
      if(view==="chain" && focusedDocument && row.document!==focusedDocument)return false;
      if(state.startsWith("progress:"))return row.progress===state.slice(9);
      if(view==="chain")return !focusedDocument || row.document===focusedDocument;
      if(view==="requests" && state==="open")return !["complete","cancelled"].includes(row.progress);
      if(view==="requests")return !state || (state==="replacement"?r.replacements>0:r.status===state);
      if(view==="orders")return !state || (state==="cancelled"?r.cancelled:state==="unmapped"?r.unallocated_qty>1e-9:r.links.some(l=>l.replacement));
      return !state || (state==="orphan"?!r.linked:r.linked);
    });
  }
  function detail(rid) {
    const r=report.requests.find(r=>r.id===rid);
    const relevant=report.orders.filter(o=>o.candidates.includes(rid));
    const linkedLines=new Set(r.links.map(link=>link.order_line_id));
    const linkedDocuments=new Set(relevant.filter(o=>linkedLines.has(o.id)).map(o=>o.document_key));
    const payments=report.payments.filter(p=>linkedDocuments.has(p.document_key));
    $("#pr-detail").innerHTML=`<section class="pr-detail"><h3>${displayDate(r.date)} · ЗВП ${esc(r.number)} — ${esc(r.item)}</h3><p>Потребность: ${fmt(r.qty)} ${esc(r.unit)}. Заказано: ${fmt(r.ordered_qty)}. Оплачено расчётно: ${fmt(r.paid_qty)}.</p>
    ${table(["Дата ЗП","Номер ЗП","Номенклатура ЗП","Количество ЗП","Ед. ЗП","Эквивалент потребности","Ед. ЗВП","Оплачено расчётно","Связь"],r.links.map(l=>`<tr>${td(displayDate(report.orders.find(o=>o.id===l.order_line_id)?.date))}${td(esc(l.order_number))}${td(esc(l.item))}${td(fmt(l.order_qty),"pr-num")}${td(esc(l.unit))}${td(fmt(l.request_qty),"pr-num")}${td(esc(r.unit))}${td(money(l.paid_cents))}${td(l.replacement?"Замена":"Совпадение")}</tr>`))}
    ${payments.length?`<h4>Оплаты по связанным заказам</h4>${table(["Дата ЗРДС","Номер ЗРДС","Заказ поставщику","Расход по всему ЗП"],payments.map(p=>{
      const doc=paymentInfo(p);
      return `<tr>${td(doc.date?displayDate(doc.date):"Не указана")}${td(esc(doc.number))}${td(esc(p.order_number))}${td(money(p.amount_cents),"pr-num")}</tr>`;
    }))}<p>Расчётная оплата этой позиции — ${money(r.paid_cents)}.</p>`:"<p>Связанные ЗРДС отсутствуют.</p>"}
    <p>Все позиции ЗП, ссылающиеся на эту ЗВП: ${relevant.length}. Без полного сопоставления: ${relevant.filter(o=>o.unallocated_qty>1e-9).length}.</p>
    ${relevant.filter(o=>!o.cancelled && o.unallocated_qty>1e-9).map(o=>`<p>${esc(o.number)}: ${esc(o.item)} — ${fmt(o.qty)} ${esc(o.unit)} ${writable?button("Сопоставить",`data-map="${o.id}"`):""}</p>`).join("")}${button("Открыть цепочку ЗВП",`data-focus-request="${r.id}"`)} ${button("Закрыть подробности",'id="pr-close-detail"')}</section>`;
    $("#pr-detail").scrollIntoView({block:"nearest"});
  }
  async function editor(oid) {
    if(!writable || !await leaveEditor()) return;
    openMappingDialog($("#pr-editor"),report,oid,{
      changed(){dirty=true;},
      close:leaveEditor,
      async save(orderId,allocations,reset){
        setBusy(true);
        try {
          await api.put(`/procurement/snapshots/${report.id}/allocations/${orderId}`,{
            expected_revision:report.revision,allocations,reset
          });
          dirty=false;
          $("#pr-editor dialog")?.close();
          $("#pr-editor").replaceChildren();
          try {await load();} catch(e){error(e);}
        } finally {if(!disposed)setBusy(false);}
      }
    });
  }
  $("#pr-file").onchange=()=>{selectedFile=$("#pr-file").files[0]||null;preview=null;$("#pr-preview").replaceChildren();$("#pr-apply").hidden=true;};
  $("#pr-analyze").onclick=async()=>{
    if(busy) return; if(!selectedFile) {error("Выберите файл .xlsx");return;} setBusy(true);$("#pr-error").textContent="";
    try {const form=new FormData();form.append("file",selectedFile); preview=await api.upload("/procurement/import/analyze",form);if(disposed)return;
      $("#pr-preview").innerHTML=`<p>Строк ЗВП: ${preview.rows["ЗВП"]}; ЗП: ${preview.rows["ЗП"]}; оплат: ${preview.rows["Оплаты ЗРДС"]}. Заказано: ${money(preview.summary.ordered_cents)}. Оплаты без найденного ЗП: ${preview.summary.orphan_payments}.</p>${preview.warnings.map(w=>`<p class="pr-warning">${esc(w)}</p>`).join("")}<p>Новая загрузка сохраняет предыдущие. Неизменившиеся ручные сопоставления переносятся из последней загрузки.</p>`;$("#pr-apply").hidden=false;
    }catch(e){error(e);}finally{if(!disposed)setBusy(false);}
  };
  $("#pr-apply").onclick=async()=>{
    if(busy || !preview || !await leaveEditor())return;setBusy(true);$("#pr-error").textContent="";
    try{const form=new FormData();form.append("file",selectedFile);form.append("expected_sha256",preview.sha256);const result=await api.upload("/procurement/import/apply",form);if(disposed)return;await listSnapshots(result.id);$("#pr-status").textContent=result.unchanged?"Этот файл уже загружен. Открыта сохранённая загрузка.":`Загрузка сохранена. Перенесено сопоставлений: ${result.carried_mappings}.`;}
    catch(e){error(e);}finally{if(!disposed)setBusy(false);}
  };
  $("#pr-snapshot").onchange=async()=>{const wanted=$("#pr-snapshot").value;if(!await leaveEditor()){$("#pr-snapshot").value=snapshotId;return;}snapshotId=wanted;try{setBusy(true);await load();}catch(e){error(e);}finally{if(!disposed)setBusy(false);}};
  $("#pr-refresh").onclick=async()=>{if(busy||!await leaveEditor())return;try{setBusy(true);await listSnapshots(snapshotId);}catch(e){error(e);}finally{if(!disposed)setBusy(false);}};
  for(const selector of ["#pr-search","#pr-warehouse","#pr-category","#pr-filter","#pr-from","#pr-to"]) $(selector).addEventListener(selector==="#pr-search"?"input":"change",renderTable);
  $("#pr-prev").onclick=()=>grid.move(-1);$("#pr-next").onclick=()=>grid.move(1);
  $("#pr-collapse-all").onclick=()=>grid.collapseAll();$("#pr-expand-all").onclick=()=>grid.expandAll();
  function clearFocus() {
    focusedDocument=null;
    $("#pr-focus").hidden=true;
  }
  function resetFilters() {
    for(const selector of ["#pr-search","#pr-warehouse","#pr-category","#pr-filter","#pr-from","#pr-to"])$(selector).value="";
    clearFocus();
    overview.reset();
    grid.reset();
  }
  $("#pr-columns").onchange=()=>grid.setColumns($("#pr-columns").value);
  $("#pr-clear-search").onclick=()=>{resetFilters();renderTable();};
  async function switchTab(next) {
    if(!await leaveEditor()) return false;
    tab=next;
    clearFocus();
    el.querySelectorAll("[data-tab]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.tab===tab)));
    $("#pr-detail").replaceChildren();
    filterOptions();
    if(tab!=="cards" && tab!=="overview")grid.show(tab);
    return true;
  }
  el.addEventListener("click",async e=>{
    const b=e.target.closest("button");if(!b||busy)return;
    if(b.dataset.tab && await switchTab(b.dataset.tab)) renderTable();
    if(b.dataset.shortcut && await switchTab(b.dataset.view)) {
      resetFilters();
      $("#pr-filter").value=b.dataset.shortcut;
      renderTable();
    }
    if(b.dataset.focusRequest && await switchTab("chain")) {
      resetFilters();
      const r=report.requests.find(row=>row.id===b.dataset.focusRequest);
      focusedDocument=r.document_key;
      $("#pr-focus").innerHTML=`ЗВП ${esc(r.number)} от ${displayDate(r.date)} ${button("Показать все ЗВП",'data-clear-focus="1"')}`;
      $("#pr-focus").hidden=false;
      grid.expandAll();
      renderTable();
    }
    if(b.dataset.clearFocus){clearFocus();renderTable();}
    // Table events are handled by the grid; detail links use the same actions.
    if(b.dataset.map && !$("#pr-table").contains(b))editor(b.dataset.map);
    if(b.id==="pr-close-detail")$("#pr-detail").replaceChildren();
  });
  setBusy(true);listSnapshots().catch(error).finally(()=>{if(!disposed)setBusy(false);});
  return {hasUnsavedChanges:()=>dirty,guardLeave:leaveEditor,destroy(){disposed=true;generation++;}};
}
