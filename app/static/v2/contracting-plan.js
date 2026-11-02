import {
  showConfirmDialog
} from "./dialogs.js";
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));
const day = v => v ? String(v).split("-").reverse().join(".") : "—";
const STATUS = {
  rd:"Ожидается РД",vor:"Подготовка ВОР",tz:"Подготовка ТЗ",upload:"Ожидается загрузка в 1С",completed:"Загружено в 1С",archived:"Архив"
};
const ACTION = {
  save_rd:"Марка РД",save_work:"Вид работ",save_lot:"Лот",save_assignment:"Распределение / выдача РД",save_document:"Документ ВОР/ТЗ",delete_rd:"Удалена марка РД",delete_work:"Удалена работа",delete_assignment:"Снято назначение",delete_document:"Удалён документ",archive:"Лот в архив",restore:"Лот восстановлен",upload:"Загрузка в 1С",reopen:"Снят факт 1С"
};
const FIELDS = {
  rd:[["code","Шифр марки РД","text",true],["name","Наименование раздела","text",true],["responsible_id","Ответственный по РД","people"],["composition_confirmed","Состав марки детализирован полностью","check"],["note","Примечание по РД: проблема, условия, срок решения","area"],["customer_agreement","Согласование с заказчиком (справочно)","area"]],
  work:[["rd_id","Марка РД","rd",true],["title","Вид работ / отдельная позиция","text",true],["classifier_id","Позиция общего кодификатора","classifier"],["required_start","Требуемое начало СМР по работе","date"],["note","Примечание по работе","area"]],
  lot:[["code","Шифр лота","text",true],["title","Наименование лота","text",true],["pto_id","Ответственный ПТО","people"],["required_start","Требуемое начало СМР лота","date"],["vor_due","Срок подготовки ВОР","date"],["tz_due","Срок подготовки ТЗ","date"],["note","Текущие проблемы и сроки решения","area"],["gpr_note","Примечание по ГПР","area"]],
  assignment:[["lot_id","Лот","lot",true],["work_id","Вид работ","work",true],["share","Доля объёма работ, %","number",true],["scope","Часть работ: корпус / этажи / этап","text",true],["rd_planned","План выдачи достаточной РД","date"],["rd_agreed","Согласованный с проектировщиком срок","date"],["rd_issued","Фактическая выдача РД","date"],["rd_sufficient","Выданной части РД достаточно для конкурса","check"],["rd_scope","Какая часть РД выдана","area"],["rd_ref","Ссылка / реквизиты выданной РД","text"]],
  document:[["number","Номер документа","text",true],["document_date","Дата документа","date",true],["reference","Ссылка / реквизиты документа в хранилище","text",true],["note","Примечание к документу","area"]],
  upload:[["tz_id","ТЗ, загруженное в 1С","tz",true],["uploaded_date","Фактическая дата загрузки в 1С","date",true],["upload_ref","Номер / ссылка подтверждения загрузки в 1С","text",true]],
  archive:[["reason","Причина вывода лота из работы","area",true]],
  reopen:[["reason","Причина снятия факта загрузки в 1С","area",true]]
};
export function mountContractingPlan(el,{
  objectId,api
}) {
  if(!document.getElementById("cp-plan-css")){
    const l=document.createElement("link");
    l.id="cp-plan-css";
    l.rel="stylesheet";
    l.href="/static/v2/contracting-plan.css";
    document.head.append(l);
  }
  el.className="v2-page";
  if(!objectId){
    el.innerHTML='<p>Выберите объект в шапке.</p>';
    return {
      destroy(){
      }
    };
  }
  const path=`/objects/${objectId}/contracting-plan`;
  let data=null,tab="lots",selected=null,editor=null,dirty=false,busy=false,dead=false,search="",filter="active",notice="",frozenLot=null,historyMore=true;
  const by=(kind,id)=>data?.[kind]?.find(r=>r.id===Number(id));
  const can=()=>!!data?.can_write;
  const person=id=>data.people.find(p=>p.id===id)?.name||"Не назначен";
  const btn=(text,action,id="")=>`<button type="button" class="v2-btn" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
  const editable=l=>can()&&!l.archived_at&&!l.uploaded_date;
  const ref=v=>/^https?:\/\//i.test(v||"")?`<a class="v2-link" href="${esc(v)}" target="_blank" rel="noopener noreferrer">Открыть документ</a>`:esc(v||"—");
  const assignments=l=>data.assignment.filter(a=>a.lot_id===l.id);
  const docs=(l,k)=>data.document.filter(d=>d.lot_id===l.id&&d.kind===k);
  const workName=w=>`${by("rd",w.rd_id)?.code||""} · ${w.title}`;
  function table(headers,rows){
    return `<div class="cp-table-scroll"><table class="cp-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.join(""):`<tr><td colspan="${headers.length}" class="v2-muted">Нет записей. Добавьте марки РД и лоты, затем распределите виды работ.</td></tr>`}</tbody></table></div>`;
  }
  function lotsView(){
    const lots=data.lot.filter(l=>(filter==="all"||(filter==="archive"?!!l.archived_at:!l.archived_at))&&(filter!=="late"||l.overdue)&&[l.code,l.title,l.note,l.gpr_note,...assignments(l).map(a=>workName(by("work",a.work_id)))].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return `<div class="cp-toolbar"><label>Поиск <input data-search value="${esc(search)}" placeholder="Лот, марка РД, работа"></label><label>Показать <select data-filter>${[["active","Активные лоты"],["late","С просрочкой"],["archive","Архив"],["all","Все лоты"]].map(([v,t])=>`<option value="${v}" ${filter===v?"selected":""}>${t}</option>`).join("")}</select></label>${can()?btn("Добавить лот","new-lot"):""}</div>`+table(["Лот / ПТО","Работы / части / марки РД","Требуемое начало СМР","Достаточная РД","ВОР","ТЗ","1С / состояние"],lots.map(l=>`<tr class="${selected===l.id?"cp-selected":""}"><td><button class="cp-title-link" data-action="select-lot" data-id="${l.id}">${esc(l.code)} · ${esc(l.title)}</button><small>${esc(person(l.pto_id))}</small><small>${esc(l.note)}</small>${l.gpr_note?`<small>По ГПР: ${esc(l.gpr_note)}</small>`:""}</td><td>${assignments(l).map(a=>`<div>${esc(workName(by("work",a.work_id)))}<small>${a.share}% · ${esc(a.scope)}</small></div>`).join("")||"Не назначены"}</td><td><strong>${day(l.required_start)}</strong>${assignments(l).map(a=>`<small>${esc(by("work",a.work_id).title)}: ${day(by("work",a.work_id).required_start)}</small>`).join("")}</td><td>${assignments(l).map(a=>`<div>${a.rd_sufficient?"✓ Достаточно":"Ожидается"}<small>План ${day(a.rd_planned)}<br>Согл. ${day(a.rd_agreed)}<br>Факт ${day(a.rd_issued)}</small></div>`).join("")||"—"}</td><td>${docs(l,"vor").map(d=>esc(d.number)).join(", ")||"—"}<small>Срок ${day(l.vor_due)}</small></td><td>${docs(l,"tz").map(d=>esc(d.number)).join(", ")||"—"}<small>Срок ${day(l.tz_due)}</small></td><td><span class="cp-status ${l.overdue?"cp-late":""}">${l.overdue?"Просрочка · ":""}${STATUS[l.status]}</span>${l.uploaded_date?`<small>Факт ${day(l.uploaded_date)}<br>${esc(l.upload_ref)}</small>`:""}${btn("Открыть","select-lot",l.id)}</td></tr>`))+(selected?lotDetail(by("lot",selected)):"");
  }
  function lotDetail(l){
    if(!l)return "";
    const edit=editable(l);
    return `<section class="cp-detail"><div class="cp-toolbar"><h3>${esc(l.code)} · ${esc(l.title)}</h3>${btn("Закрыть карточку","close-detail")}${l.completion_json?btn("Зафиксированный состав","snapshot",l.id):""}${edit?btn("Изменить лот","edit-lot",l.id)+btn("Назначить работу","new-assignment",l.id)+btn("Добавить ВОР","new-vor",l.id)+btn("Добавить ТЗ","new-tz",l.id):""}${can()?(l.archived_at?btn("Восстановить","restore",l.id):l.uploaded_date?btn("Возобновить","reopen",l.id)+btn("Вывести в архив","archive",l.id):btn("Вывести в архив","archive",l.id)):""}${edit?btn("Подтвердить загрузку в 1С","upload",l.id):""}</div><p>ПТО: <strong>${esc(person(l.pto_id))}</strong> · Начало СМР: <strong>${day(l.required_start)}</strong> · ${STATUS[l.status]}</p>${l.uploaded_date?`<p>Подтверждённый состав зафиксирован ${day(l.uploaded_date)}. Реестр РД может развиваться дальше.</p>`:""}${l.archived_at?`<p>Причина архива: ${esc(l.archive_reason)}</p>`:""}${l.blockers.length&&!l.uploaded_date?`<div class="cp-warning"><strong>До завершения лота:</strong><ul>${l.blockers.map(r=>`<li>${esc(r)}</li>`).join("")}</ul></div>`:""}<div class="cp-notes"><p><strong>Примечание:</strong> ${esc(l.note)||"—"}</p><p><strong>По ГПР:</strong> ${esc(l.gpr_note)||"—"}</p></div>`+table(["Работа / часть","РД: план / согласовано / факт","Достаточная часть РД / документ","Действия"],assignments(l).map(a=>`<tr><td>${esc(workName(by("work",a.work_id)))}<small>${a.share}% · ${esc(a.scope)} · СМР ${day(by("work",a.work_id).required_start)}</small></td><td>${day(a.rd_planned)} / ${day(a.rd_agreed)} / ${day(a.rd_issued)}</td><td>${a.rd_sufficient?"✓ Достаточно для конкурса":"Не подтверждено"}<small>${esc(a.rd_scope)}</small>${ref(a.rd_ref)}</td><td>${edit?btn("Изменить / выдача РД","edit-assignment",a.id)+btn("Снять назначение","delete-assignment",a.id):"Только просмотр"}</td></tr>`))+`<h4>Документы лота</h4><p class="v2-muted">Регистрация документов и их состава: несколько ВОР в одном ТЗ. Ссылки ведут в принятое хранилище. Сервис не объединяет файлы и не отправляет их в 1С.</p>`+table(["Документ","Дата / ссылка / реквизиты","Состав","Действия"],data.document.filter(d=>d.lot_id===l.id).map(d=>{
      const items=d.kind==="vor"?data.document_work.filter(i=>i.document_id===d.id).map(i=>by("work",i.work_id)?.title):data.tz_vor.filter(i=>i.tz_id===d.id).map(i=>by("document",i.vor_id)?.number);
      return `<tr><td>${d.kind==="vor"?"ВОР":"ТЗ"} ${esc(d.number)}</td><td>${day(d.document_date)}<small>${ref(d.reference)}</small>${esc(d.note)}</td><td>${items.map(esc).join("; ")}</td><td>${edit?btn("Изменить","edit-document",d.id)+btn("Удалить","delete-document",d.id):"Только просмотр"}</td></tr>`;
    }))+`</section>`;
  }
  function rdView(){
    return `<div class="cp-toolbar"><p class="v2-muted">Полнота по внесённому реестру РД: подтвердите состав каждой марки и распределите 100% каждой работы. Завершённые лоты сохраняют занятые доли и в архиве.</p>${can()?btn("Добавить марку РД","new-rd"):""}</div>`+data.rd.map(r=>`<section class="cp-detail"><div class="cp-toolbar"><h3>${esc(r.code)} · ${esc(r.name)}</h3>${can()?btn("Изменить РД","edit-rd",r.id)+btn("Добавить вид работ","new-work",r.id)+btn("Удалить марку","delete-rd",r.id):""}</div><p>${r.composition_confirmed?"✓ Состав детализирован полностью":"Состав не подтверждён"} · Ответственный: ${esc(person(r.responsible_id))}</p><div class="cp-notes"><p><strong>По РД:</strong> ${esc(r.note)||"—"}</p><p><strong>Согласование с заказчиком:</strong> ${esc(r.customer_agreement)||"—"}</p></div>`+table(["Вид работ","Требуемое начало СМР","Распределение","Действия"],data.work.filter(w=>w.rd_id===r.id).map(w=>`<tr><td>${esc(w.title)}${w.classifier_id?`<small>Кодификатор: ${esc(data.classifier.find(c=>c.id===w.classifier_id)?.path||w.classifier_id)}</small>`:""}<small>${esc(w.note)}</small></td><td>${day(w.required_start)}</td><td><strong class="${w.allocated_share!==100?"cp-incomplete":""}">${w.allocated_share}% из 100%</strong>${data.assignment.filter(a=>a.work_id===w.id).map(a=>`<small>${esc(by("lot",a.lot_id)?.code)} · ${a.share}% · ${esc(a.scope)}${by("lot",a.lot_id)?.archived_at?(by("lot",a.lot_id)?.uploaded_date?" (архив, факт 1С сохранён)":" (архив, не учитывается)"):""}</small>`).join("")}</td><td>${can()?btn("Изменить","edit-work",w.id)+btn("Распределить","assign-work",w.id)+btn("Удалить","delete-work",w.id):"Только просмотр"}</td></tr>`))+`</section>`).join("");
  }
  function historyView(){
    return `<p class="v2-muted">История изменений с подгрузкой более ранних записей. История сохраняется после вывода лота из работы и снятия факта 1С.</p>`+table(["Когда","Кто","Изменение","Данные / причина"],data.history.map(h=>{
      let p={
      };
      try{
        p=JSON.parse(h.after_json);
      }catch{
      }return `<tr><td>${esc(h.created_at)} UTC</td><td>${esc(h.actor||"Удалённый пользователь")}</td><td>${esc(ACTION[h.action]||h.action)} · №${h.entity_id}</td><td>${esc([p.code,p.name,p.title,p.number,p.reason,p.rd_scope,p.upload_ref].filter(Boolean).join(" · "))||"Изменены реквизиты / состав"}${historyDetails(h)}</td></tr>`;
    }))+(historyMore&&data.history.length>=200?btn("Загрузить более ранние изменения","history-more"):"");
  }
  function render(){
    if(dead)return;
    const c=data.completeness,problems=c.rd_without_works.length+c.rd_unconfirmed.length+c.unallocated_works.length;
    el.innerHTML=`<div class="v2-container cp-root"><div class="v2-crumbs"><a class="v2-link" href="#/">Начало</a> › Контрактация и график</div><div class="cp-toolbar"><h2>График контрактации СМР</h2><span class="v2-muted">${can()?"Можно изменять":"Только просмотр"}</span>${btn("Обновить","refresh")}</div><p class="v2-muted">РД → виды работ → лоты → ВОР → ТЗ → подтверждённая загрузка в 1С. Достаточная для конкурса РД может быть частичной.</p><div class="cp-summary ${problems?"cp-warning":""}">${data.rd.length?`Марок РД: ${data.rd.length} · Без видов работ: ${c.rd_without_works.length} · Состав не подтверждён: ${c.rd_unconfirmed.length} · Работ распределено не на 100%: ${c.unallocated_works.length}`:"Реестр РД пуст — полнота не определена."}</div><div class="cp-tabs" role="tablist">${[["lots","График лотов"],["rd","РД и распределение"],["history","История"]].map(([v,t])=>`<button role="tab" aria-selected="${tab===v}" class="v2-btn ${tab===v?"v2-primary":""}" data-action="tab" data-id="${v}">${t}</button>`).join("")}</div><div class="cp-notice" role="status">${esc(notice)}</div><div data-editor></div><div data-view>${tab==="lots"?lotsView():tab==="rd"?rdView():historyView()}</div></div>`;
    if(editor)renderEditor();
    else if(frozenLot)renderFrozen();
  }
  function options(type){
    if(type==="people")return data.people.map(x=>[x.id,x.name]);
    if(type==="classifier")return data.classifier.map(x=>[x.id,x.path+" · "+x.name]);
    if(type==="rd")return data.rd.map(x=>[x.id,x.code+" · "+x.name]);
    if(type==="lot")return data.lot.filter(l=>!l.archived_at&&!l.uploaded_date).map(x=>[x.id,x.code+" · "+x.title]);
    if(type==="work")return data.work.map(x=>[x.id,workName(x)]);
    if(type==="tz")return docs(by("lot",editor.value.id),"tz").filter(d=>by("lot",editor.value.id).valid_tz_ids.includes(d.id)).map(d=>[d.id,d.number]);
    return [];
  }
  function historyDetails(h){
    let before={
    },after={
    };
    try{
      before=JSON.parse(h.before_json)||{
      };
      after=JSON.parse(h.after_json)||{
      };
    }catch{
      return "";
    }
    const labels={
      ...Object.fromEntries(Object.values(FIELDS).flat().map(f=>[f[0],f[1]])),kind:"Вид документа",item_ids:"Позиции состава",items:"Предыдущий состав",uploaded_tz_id:"ТЗ, загруженное в 1С",archive_reason:"Причина архива",archived_at:"Момент архива"
    };
    const value=v=>Array.isArray(v)?v.map(x=>Array.isArray(x)?x.join(" → "):x).join("; "):typeof v==="boolean"?v?"Да":"Нет":v??"—";
    const keys=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>labels[k]&&JSON.stringify(before[k])!==JSON.stringify(after[k]));
    return `<details><summary>Изменённые поля</summary>${table(["Поле","Было","Стало"],keys.map(k=>`<tr><td>${esc(labels[k])}</td><td>${esc(value(before[k]))}</td><td>${esc(value(after[k]))}</td></tr>`))}</details>`;
  }
  function renderFrozen(){
    const l=by("lot",frozenLot);
    let s;
    try{
      s=JSON.parse(l.completion_json);
    }catch{
      return;
    }
    const rd=id=>s.rd.find(r=>r.id===id),work=id=>s.work.find(w=>w.id===id);
    el.querySelector("[data-editor]").innerHTML=`<section class="cp-detail cp-frozen"><div class="cp-toolbar"><h3>Зафиксированный состав: ${esc(s.lot.code)} · ${day(l.uploaded_date)}</h3>${btn("Закрыть снимок","close-snapshot")}</div><p>Состав на момент подтверждения внешней загрузки в 1С. Последующие изменения реестра РД сюда не переносятся.</p><p>${esc(l.upload_ref)}</p>`+table(["Марка РД / работа","Часть / доля","Начало СМР","Выданная часть РД / факт"],s.assignment.map(a=>`<tr><td>${esc(rd(work(a.work_id).rd_id).code)} · ${esc(work(a.work_id).title)}</td><td>${esc(a.scope)} · ${a.share}%</td><td>${day(work(a.work_id).required_start)}</td><td>${esc(a.rd_scope)} · ${day(a.rd_issued)}<small>${ref(a.rd_ref)}</small></td></tr>`))+table(["Документ","Дата","Ссылка / реквизиты","Состав"],s.document.map(d=>`<tr><td>${d.kind==="vor"?"ВОР":"ТЗ"} ${esc(d.number)}</td><td>${day(d.document_date)}</td><td>${ref(d.reference)}</td><td>${d.kind==="vor"?s.document_work.filter(i=>i.document_id===d.id).map(i=>esc(work(i.work_id)?.title)).join("; "):s.tz_vor.filter(i=>i.tz_id===d.id).map(i=>esc(s.document.find(v=>v.id===i.vor_id)?.number)).join("; ")}</td></tr>`))+`</section>`;
  }
  function documentItems(){
    const v=editor.value;
    const choices=v.kind==="vor"?data.assignment.filter(a=>a.lot_id===v.lot_id).map(a=>[a.work_id,`${workName(by("work",a.work_id))} · ${a.share}% · ${a.scope}`]):docs(by("lot",v.lot_id),"vor").map(d=>[d.id,`${d.number} · ${day(d.document_date)}`]);
    return `<fieldset class="cp-item-list"><legend>${v.kind==="vor"?"Работы в составе ВОР":"ВОР в составе ТЗ (можно выбрать несколько)"}</legend>${choices.length?choices.map(([id,title])=>`<label class="cp-check"><input type="checkbox" name="item_ids" value="${id}" ${v.item_ids?.includes(id)?"checked":""}>${esc(title)}</label>`).join(""):"Сначала добавьте "+(v.kind==="vor"?"работы в лот":"ВОР лота")}</fieldset>`;
  }
  function renderEditor(){
    const {
      kind,value,title
    }=editor,host=el.querySelector("[data-editor]");
    host.innerHTML=`<section class="cp-editor"><h3>${esc(title)}</h3>${kind==="assignment"?'<p class="v2-muted">Целая позиция: 100% и «Весь объём». При дроблении укажите долю и границы части. Сумма долей не может превышать 100%.</p>':""}${kind==="upload"?'<p>Подтверждайте факт после загрузки выбранного ТЗ в 1С. Сервис регистрирует факт внешней загрузки; интеграция с 1С не выполняется.</p>':""}<form class="cp-form"><div class="cp-fields">${FIELDS[kind].map(([name,label,type,required])=>{const v=value[name]??"",req=required?"required":"",max=name==="code"?150:["title","name"].includes(name)?500:name==="scope"?1000:4000;if(type==="check")return `<label class="cp-check"><input type="checkbox" name="${name}" ${v?"checked":""}>${esc(label)}</label>`;const select=!["text","area","date","number"].includes(type);return `<label>${esc(label)}${required?" *":""}${select?`<select name="${name}" ${req}><option value="">— Выберите —</option>${options(type).map(([id,text])=>`<option value="${id}" ${Number(v)===id?"selected":""}>${esc(text)}</option>`).join("")}</select>`:type==="area"?`<textarea name="${name}" maxlength="${max}" ${req}>${esc(v)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(v)}" ${type==="number"?'min="1" max="100" step="1"':type==="text"?`maxlength="${max}"`:""} ${req}>`}</label>`;}).join("")}</div>${kind==="document"?documentItems():""}<div class="cp-form-error" role="alert"></div><div class="cp-toolbar"><button class="v2-btn v2-primary" type="submit">${kind==="upload"?"Подтвердить факт загрузки":"Сохранить"}</button>${btn("Отмена","cancel-edit")}</div></form></section>`;
    host.querySelector("form").addEventListener("input",()=>dirty=true);
    host.querySelector("form").addEventListener("change",()=>dirty=true);
    host.querySelector("form").addEventListener("submit",saveEditor);
  }
  async function leave(){
    if(busy)return false;
    return !dirty||await showConfirmDialog("В форме есть несохранённые изменения. Закрыть её?",{
      confirmLabel:"Закрыть без сохранения"
    });
  }
  async function open(kind,value={
  },title="Изменение"){
    if(!await leave())return;
    editor={
      kind,value:{
        ...value
      },title
    };
    frozenLot=null;
    dirty=false;
    notice="";
    render();
    el.querySelector("[data-editor]").scrollIntoView({
      block:"start",behavior:"smooth"
    });
    el.querySelector("[data-editor] input,[data-editor] select,[data-editor] textarea")?.focus();
  }
  async function mutate(action,payload){
    if(busy)return;
    busy=true;
    el.querySelectorAll("button,input,select,textarea").forEach(b=>b.disabled=true);
    try{
      const result=await api.post(path+"/commands",{
        expected_revision:data.revision,action,payload
      });
      if(dead)return;
      data=result;
      editor=null;
      dirty=false;
      notice="Изменения сохранены.";
      render();
    }catch(err){
      if(dead)return;
      const msg=err.status===0?"Связь прервана. Результат сохранения неизвестен. Обновите график и проверьте запись перед повтором.":err.message;
      const target=el.querySelector(".cp-form-error")||el.querySelector(".cp-notice");
      target.textContent=msg;
    }finally{
      busy=false;
      el.querySelectorAll("button,input,select,textarea").forEach(b=>b.disabled=false);
    }
  }
  async function saveEditor(event){
    event.preventDefault();
    if(busy)return;
    const form=event.target;
    if(!form.reportValidity())return;
    const fd=new FormData(form),v=editor.value,payload={
    };
    if(v.id)payload.id=v.id;
    for(const [name,,type] of FIELDS[editor.kind]){
      const value=fd.get(name);
      payload[name]=type==="check"?fd.has(name):["people","rd","lot","work","classifier","tz","number"].includes(type)?value?Number(value):null:type==="date"?value||null:String(value||"");
    }if(editor.kind==="document"){
      payload.lot_id=v.lot_id;
      payload.kind=v.kind;
      payload.item_ids=fd.getAll("item_ids").map(Number);
      if(!payload.item_ids.length){
        form.querySelector(".cp-form-error").textContent="Выберите хотя бы одну позицию состава документа.";
        return;
      }
    }await mutate(["archive","reopen","upload"].includes(editor.kind)?editor.kind:`save_${editor.kind}`,payload);
  }
  async function refresh(){
    if(!await leave())return;
    busy=true;
    try{
      const result=await api.get(path);
      if(dead)return;
      data=result;
      editor=null;
      frozenLot=null;
      historyMore=true;
      dirty=false;
      notice="";
      render();
    }catch(err){
      if(!dead){
        if(data)el.querySelector(".cp-notice").textContent=err.message;
        else el.innerHTML=`<p role="alert">${esc(err.message)}</p>`;
      }
    }finally{
      busy=false;
    }
  }
  async function click(event){
    const b=event.target.closest("[data-action]");
    if(!b||busy)return;
    const action=b.dataset.action,id=Number(b.dataset.id);
    if(action==="refresh")return refresh();
    if(action==="snapshot"){
      if(await leave()){
        editor=null;
        dirty=false;
        frozenLot=id;
        render();
        el.querySelector("[data-editor]").scrollIntoView({
          block:"start"
        });
      }return;
    }
    if(action==="close-snapshot"){
      frozenLot=null;
      render();
      return;
    }
    if(action==="history-more"){
      busy=true;
      try{
        const items=await api.get(path+"/history?before_id="+data.history.at(-1).id);
        if(dead)return;
        data.history.push(...items);
        historyMore=items.length===200;
        render();
      }catch(err){
        if(!dead)el.querySelector(".cp-notice").textContent=err.message;
      }finally{
        busy=false;
      }return;
    }if(action==="cancel-edit"){
      if(await leave()){
        editor=null;
        dirty=false;
        render();
      }return;
    }if(action==="tab"){
      if(await leave()){
        tab=b.dataset.id;
        editor=null;
        dirty=false;
        notice="";
        render();
      }return;
    }if(action==="select-lot"||action==="close-detail"){
      if(await leave()){
        selected=action==="select-lot"?id:null;
        editor=null;
        dirty=false;
        render();
      }return;
    }
    if(action.startsWith("new-")||action.startsWith("edit-")){
      const [op,kind]=action.split("-");
      if(kind==="vor"||kind==="tz")return open("document",{
        lot_id:id,kind,item_ids:[]
      },kind==="vor"?"Новая ВОР":"Новое ТЗ: выберите ВОР");
      let v=op==="edit"?{
        ...by(kind,id)
      }:{
      };
      if(kind==="work"&&op==="new")v.rd_id=id;
      if(kind==="assignment"&&op==="new")v={
        lot_id:id,share:100,scope:"Весь объём"
      };
      if(kind==="document")v.item_ids=v.kind==="vor"?data.document_work.filter(i=>i.document_id===id).map(i=>i.work_id):data.tz_vor.filter(i=>i.tz_id===id).map(i=>i.vor_id);
      return open(kind,v,op==="new"?"Добавление":"Изменение");
    }
    if(action==="assign-work")return open("assignment",{
      work_id:id,share:100-(by("work",id).allocated_share||0)||100,scope:"Весь объём"
    },"Назначение работы лоту");
    if(["archive","reopen","upload"].includes(action))return open(action,{
      id
    },action==="archive"?"Вывести лот из работы":action==="reopen"?"Возобновить подготовку лота":"Подтвердить загрузку ТЗ в 1С");
    if(action==="restore"||action.startsWith("delete-")){
      if(!await leave())return;
      if(await showConfirmDialog(action==="restore"?"Восстановить лот с сохранённым составом и документами?":"Удалить запись? Связанные работы и документы защищены. История сохранится.",{
        confirmLabel:action==="restore"?"Восстановить":"Удалить",danger:action!=="restore"
      }))return mutate(action.replace("-","_"),{
        id
      });
    }
  }
  function change(event){
    if(event.target.matches("[data-search]")){
      search=event.target.value;
      el.querySelector("[data-view]").innerHTML=lotsView();
    }if(event.target.matches("[data-filter]")){
      filter=event.target.value;
      el.querySelector("[data-view]").innerHTML=lotsView();
    }
  }
  el.addEventListener("click",click);
  el.addEventListener("change",change);
  el.innerHTML='<p class="v2-muted">Загрузка графика…</p>';
  refresh();
  return {
    hasUnsavedChanges:()=>dirty,guardLeave:leave,destroy(){
      dead=true;
      el.removeEventListener("click",click);
      el.removeEventListener("change",change);
    }
  };
}
