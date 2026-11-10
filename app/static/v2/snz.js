import { esc } from "./screen-view.js";
import { bindIssuedLayout } from "./snz-issued-layout.js";
import { validateSteps, snzErrorIssue } from "./snz-validation.js";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const timeText = (s) => s?.slice(11, 16) || "—";
const dayText = (s) => s ? s.slice(0, 10).split("-").reverse().join(".") : "—";
const shiftText = (s) => s === "day" ? "День" : "Ночь";
const scopes = [["preparation", "Подготовка"], ["element", "Изделие"], ["group", "Узел из 3–4 ригелей"]];
const options = (rows, value, key = "id", title = "name") => rows.map(r => `<option value="${esc(r[key])}" ${r[key] === value ? "selected" : ""}>${esc(r[title])}</option>`).join("");
const textInput = (path, value, extra = "") => `<input data-path="${path}" value="${esc(value ?? "")}" ${extra}>`;

export function createSnz({ api, getObjectId, getSelectedIds, send, onChanged }) {
  let validationIssue = null, orderEdit = null, revisions = null, scrollToEdit = false;
  const editDirty = () => !!orderEdit && (orderEdit.exclude.size > 0 || !!orderEdit.reason.trim());
  let data = null, draft = null, dialog = null, dirty = false, busy = false, error = "", message = "";
  let tab = "plan", selection = new Set(), plan = null, cardId = "base", assignmentCard = "auto", date = today(), shift = "day", crewId = "install1";
  let filter = "", status = "ready_for_installation", dateFilter = "", crewFilter = "", shiftFilter = "", noPriority = false, noDate = false, page = 0, generation = 0;
  let ordersDate = "";
  const path = () => `/objects/${getObjectId()}/snz`;
  const canWrite = () => !!data?.can_write;
  const assignById = () => new Map(draft.assignments.map(a => [a.element_id, a]));
  const selected = () => data.elements.filter(e => selection.has(e.id));
  const locked = (id) => data.locked_element_ids.includes(id);
  const crewName = (id) => draft.crews.find(c => c.id === id)?.name || id;
  const dirtyMark = () => { dirty = true; plan = null; const el = dialog?.querySelector("[data-dirty]"); if (el) el.textContent = "Есть несохранённые изменения"; const saveButton=dialog?.querySelector('[data-action="save"]');if(saveButton)saveButton.disabled=!canWrite();for(const b of dialog?.querySelectorAll('[data-action="preview"],[data-action="issue"]')||[])b.disabled=true; };

  async function load() {
    const object = getObjectId(), ticket = ++generation;
    const result = await api.get(path() + "/state");
    if (ticket !== generation || object !== getObjectId()) return false;
    data = result; draft = structuredClone(data.state); dirty = false; validationIssue = null;
    if (!draft.crews.some(c => c.id === crewId)) crewId = draft.crews.find(c => c.kind === "installation").id;
    if (!draft.cards.some(c => c.id === cardId)) cardId = draft.cards[0].id;
    return true;
  }
  async function run(fn) {
    if (busy) return;
    busy = true; error = ""; message = ""; render();
    try { await fn(); } catch (e) { validationIssue=e.snzIssue||snzErrorIssue(e,draft||{}); error=validationIssue?.message||e.message||"Не удалось выполнить действие";if(validationIssue){tab="cards";cardId=validationIssue.cardId;} }
    finally { busy = false; render(); }
  }
  async function save() {
    validateSteps(draft);
    const { facts, ...body } = draft;
    const result = await api.put(path() + "/state", { revision: data.revision, ...body });
    data.revision = result.revision;
    dirty = false; plan = null; message = "Изменения сохранены";
    await load();
  }
  async function open(nextTab = "plan", orderId = null) {
    if (dialog) return;
    tab = nextTab; error = ""; message = ""; plan = null; selection = new Set(getSelectedIds());
    dialog = document.createElement("dialog"); dialog.className = "snz-dialog";
    dialog.setAttribute("aria-label", "Сменные наряд-задания"); document.body.append(dialog);
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
    dialog.addEventListener("click", click);
    dialog.addEventListener("change", change);
    dialog.addEventListener("input", e => {
      if (e.target.matches("[data-filter=search]")) { filter = e.target.value; page = 0; renderItems(); }
      if(e.target.matches("[data-edit-search]")&&orderEdit){orderEdit.filter=e.target.value;orderEdit.page=0;render();}
      if (e.target.matches("[data-edit-reason]") && orderEdit) {
        orderEdit.reason=e.target.value;orderEdit.preview=null;
        dialog.querySelector('[data-action="edit-apply"]')?.setAttribute("disabled", "");
        const button=dialog.querySelector('[data-action="edit-preview"]');if(button)button.disabled=!orderEdit.exclude.size||!orderEdit.reason.trim();
      }
    });
    dialog.showModal(); busy = true; render();
    try { if (await load()) { if (orderId) plan = await api.get(path() + `/orders/${orderId}`); } }
    catch (e) { error = e.message; }
    finally { busy = false; render(); }
  }
  function close(force = false) {
    if (busy && !force) return false;
    if ((dirty || editDirty()) && !force && !window.confirm("Закрыть СНЗ без сохранения изменений?")) return false;
    const wasOpen=!!dialog;
    dialog?.close(); dialog?.remove(); dialog = null; dirty = false; orderEdit=null;revisions=null;generation++;
    if(wasOpen)onChanged?.();
    return true;
  }
  function planHeader() {
    return `<div class="snz-controls">
      <label>Дата начала смены<input type="date" data-filter="date" value="${date}" required></label>
      <label>Смена<select data-filter="shift"><option value="day" ${shift === "day" ? "selected" : ""}>День · 08:00–20:00</option><option value="night" ${shift === "night" ? "selected" : ""}>Ночь · 20:00–08:00</option></select></label>
      <label>СНЗ бригады<select data-filter="crew">${options(draft.crews, crewId)}</select></label>
      <button data-action="preview" ${dirty ? "disabled title='Сначала сохраните изменения'" : ""}>Рассчитать смену</button>
      <button data-action="issue" class="snz-primary" ${!plan || plan.id || dirty || !plan.tasks.length || !canWrite() ? "disabled" : ""}>Выдать СНЗ</button>
    </div>`;
  }
  function filtered() {
    const assignments = assignById(), q = filter.trim().toLocaleLowerCase("ru");
    return data.elements.filter(e => e.is_current !== 0 && (!status || e.current_status === status)
      && (!q || [e.mark, e.element_type, e.subtype, e.address, e.floor, e.id].join(" ").toLocaleLowerCase("ru").includes(q))
      && (!dateFilter || assignments.get(e.id)?.date === dateFilter)
      && (!noDate || !assignments.get(e.id)?.date)
      && (!crewFilter || assignments.get(e.id)?.crew_id === crewFilter)
      && (!shiftFilter || assignments.get(e.id)?.shift === shiftFilter)
      && (!noPriority || assignments.get(e.id)?.priority == null));
  }
  function itemsHtml() {
    const rows = filtered(), assignments = assignById(), pages = Math.max(1, Math.ceil(rows.length / 60));
    page = Math.min(page, pages - 1);
    const shown = rows.slice(page * 60, (page + 1) * 60);
    return `<div class="snz-controls snz-selection"><span>Найдено: ${rows.length} · Выбрано: ${selection.size}</span>
      <button data-action="page-all">Выбрать страницу</button><button data-action="clear">Снять выбор</button>
      <span class="snz-spacer"></span><button data-action="prev" ${page === 0 ? "disabled" : ""}>Назад</button><span>${page + 1} / ${pages}</span><button data-action="next" ${page + 1 >= pages ? "disabled" : ""}>Далее</button></div>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>Выбор</th><th>Изделие</th><th>Этаж / оси</th><th>Дата</th><th>Смена</th><th>Бригада</th><th>Очередь монтажа</th><th>Очередь подготовки</th><th>Карта</th><th></th></tr></thead><tbody>
      ${shown.map(e => {
        const a = assignments.get(e.id), ai = draft.assignments.indexOf(a), disabled = locked(e.id) ? "disabled title='Назначение включено в выданный СНЗ'" : "";
        const prefix = `assignments.${ai}`;
        return `<tr ${selection.has(e.id) ? 'class="snz-selected"' : ""}><td><input type="checkbox" aria-label="Выбрать ${esc(e.mark || e.id)}" data-select="${e.id}" ${selection.has(e.id) ? "checked" : ""}></td>
          <td><strong>${esc(e.mark || "Без марки")}</strong><small>${esc(e.element_type)} · ${esc(e.subtype || "")} · ID ${e.id}${disabled ? " · выдано" : ""}</small>${e.completed_operations?.length?`<small class="snz-done">Выполнено: ${esc(e.completed_operations.join(", "))}</small>`:""}</td>
          <td>${esc(e.floor ?? "—")}<small>${esc(e.address || "—")}</small></td>
          ${a ? `<td>${textInput(prefix + ".date", a.date, `type="date" aria-label="Дата монтажа ${e.id}" ${disabled}`)}</td>
          <td><select data-path="${prefix}.shift" aria-label="Смена ${e.id}" ${disabled}>${options([{id:"day",name:"День"},{id:"night",name:"Ночь"}], a.shift)}</select></td>
          <td><select data-path="${prefix}.crew_id" aria-label="Бригада ${e.id}" ${disabled}>${options(draft.crews.filter(c => c.kind === "installation"), a.crew_id)}</select></td>
          <td>${textInput(prefix + ".priority", a.priority, `type="number" min="1" aria-label="Очередь монтажа ${e.id}" ${disabled}`)}</td>
          <td>${textInput(prefix + ".prep_priority", a.prep_priority, `type="number" min="1" aria-label="Очередь подготовки ${e.id}" ${disabled}`)}</td>
          <td><select data-path="${prefix}.card_id" aria-label="Карта ${e.id}" ${disabled}>${options(draft.cards, a.card_id)}</select></td>
          <td><button data-action="remove-assignment" data-id="${e.id}" ${disabled}>Снять</button></td>` : `<td colspan="7" class="snz-muted">Не запланировано</td>`}</tr>`;
      }).join("") || '<tr><td colspan="10">Изделий по выбранным условиям нет.</td></tr>'}</tbody></table></div>`;
  }
  function renderItems() { const host = dialog?.querySelector("[data-items]"); if (host) host.innerHTML = itemsHtml(); }
  function plannerHtml() {
    return `${planHeader()}
      <p class="snz-muted">Назначьте монтаж на выбранную дату и смену. Подготовка попадёт в предыдущую смену со своей очередностью. Серые строки назначения уже включены в выданный документ.</p>
      <div class="snz-controls"><label>Поиск<input type="search" data-filter="search" value="${esc(filter)}" placeholder="Марка, тип, оси или ID"></label>
      <label>Статус<select data-filter="status">${options([{id:"ready_for_installation",name:"Готов к монтажу"},{id:"installed",name:"Смонтирован"},{id:"",name:"Все статусы"}],status)}</select></label>
      <label>Дата монтажа<input type="date" data-filter="dateFilter" value="${dateFilter}"></label>
      <label>Поток<select data-filter="crewFilter"><option value="">Все потоки</option>${options(draft.crews.filter(c=>c.kind==="installation"),crewFilter)}</select></label>
      <label>Смена (отбор)<select data-filter="shiftFilter" aria-label="Смена позиций"><option value="">Все смены</option>${options([{id:"day",name:"День"},{id:"night",name:"Ночь"}],shiftFilter)}</select></label>
      <label class="snz-check"><input type="checkbox" data-filter="noPriority" ${noPriority?"checked":""}>Без очередности</label><label class="snz-check"><input type="checkbox" data-filter="noDate" ${noDate?"checked":""}>Без даты монтажа</label></div>
      <fieldset ${!canWrite() ? "disabled" : ""}><div class="snz-controls">
      <label>Карта для назначения<select data-filter="assignmentCard"><option value="auto" ${assignmentCard==="auto"?"selected":""}>По справочнику автоматически</option>${options(draft.cards,assignmentCard)}</select></label>
      <button data-action="assign" ${draft.crews.find(c=>c.id===crewId)?.kind!=="installation"?"disabled title='Выберите монтажную бригаду в поле СНЗ бригады'":""}>Назначить выбранные</button>
      <button data-action="show-sequence" ${dirty?"disabled":""}>Показать очередность на модели</button>
      </div><div data-items>${itemsHtml()}</div></fieldset>
      ${planHtml()}`;
  }
  function planHtml(doc = plan) {
    if (!doc) return "";
    const origin = new Date(doc.start).getTime(), offset = s => Math.max(0, Math.min(100, (new Date(s).getTime()-origin)/432000));
    const teams = [...new Set(doc.tasks.map(t=>t.team))], facts = doc.facts || draft.facts;
    return `<section class="snz-result"><div class="snz-controls"><h3>${doc.editPreview ? "Предпросмотр исправления СНЗ № "+doc.id : doc.id ? "Выданный СНЗ № "+doc.id : "Расчёт смены"}${doc.order_revision ? " · ред. "+doc.order_revision : ""}${doc.historical ? " · архив" : ""} · ${dayText(doc.date)} · ${shiftText(doc.shift)} · ${esc(doc.crew.name)}</h3>
      ${doc.id && !doc.editPreview ? `<button data-action="xlsx">Excel</button><button data-action="pdf">Поэтажные планы PDF</button>` : ""}</div>
      ${doc.warnings.length ? `<details class="snz-warnings"><summary>Предупреждения: ${doc.warnings.length}</summary><ul>${doc.warnings.map(w=>`<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
      <p class="snz-muted">План: ${doc.tasks.length} операций · ${doc.tasks.reduce((n,t)=>n+t.segments.reduce((m,s)=>m+s.minutes,0),0)} минут работы звеньев. Факт: только 0 или 100 %.</p>
      <div class="snz-gantt" role="img" aria-label="Загрузка звеньев в течение смены"><div class="snz-gantt-row"><strong>Звено</strong><div class="snz-hours">${Array.from({length:13},(_,i)=>`<span style="left:${i/12*100}%">${String((Number(doc.start.slice(11,13))+i)%24).padStart(2,"0")}:00</span>`).join("")}</div></div>
      ${teams.map(team=>`<div class="snz-gantt-row"><strong>${esc(team)}</strong><div class="snz-track">
      ${[[0,20],...(doc.shift==="day"?[[300,360]]:[[240,300]]),[700,720]].map(([a,b])=>`<span class="snz-break" style="left:${a/720*100}%;width:${(b-a)/720*100}%"></span>`).join("")}
      ${doc.tasks.flatMap((t,i)=>t.team!==team?[]:t.segments.map(s=>`<span class="snz-bar snz-color-${i%5}" style="left:${offset(s.start)}%;width:${offset(s.end)-offset(s.start)}%" title="${esc(t.operation)} · ${esc(t.elements.map(e=>e.mark||e.id).join(', '))} · ${timeText(s.start)}–${timeText(s.end)}">${i+1}</span>`)).join("")}</div></div>`).join("")}</div>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>№</th><th>Операция / изделие</th><th>Звено</th><th>Время</th><th>Норматив / остаток</th><th>Факт</th></tr></thead><tbody>
      ${doc.tasks.map((t,i)=>`<tr><td>${i+1}</td><td><strong>${esc(t.operation)}</strong><small>${esc(t.group_name || t.elements.map(e=>e.mark||e.id).join(', '))}${t.group_name?" · "+esc(t.elements.map(e=>e.mark||e.id).join(', ')):""}${t.carry?" · перенос":""}</small></td><td>${esc(t.team)}</td>
      <td>${t.segments.map(s=>`${timeText(s.start)}–${timeText(s.end)}`).join("<br>")}</td><td>${t.norm_minutes} / ${t.remaining_after} мин</td>
      <td>${facts[t.key]?.completed?'<span class="snz-done">100 % · завершено</span>':`<span>0 %</span> ${doc.id && !doc.editPreview && !doc.historical && data.can_fact?`<button data-action="complete" data-key="${esc(t.key)}">Завершить</button>`:""}`}</td></tr>`).join("") || '<tr><td colspan="6">Нет рассчитанных работ.</td></tr>'}</tbody></table></div></section>`;
  }
  function cardsHtml() {
    const card = draft.cards.find(c=>c.id===cardId) || draft.cards[0], ci = draft.cards.indexOf(card);
    return `<div class="snz-controls"><label>Операционная карта<select data-filter="card">${options(draft.cards,card.id)}</select></label><button data-action="add-card">Добавить карту</button><button data-action="copy-card">Копировать карту</button></div>
      <p class="snz-muted">Минуты задаются на звено и не зависят от численности. Пустой норматив требует заполнения. Задержка после операции — календарные минуты, включая обед; звено на это время освобождается.</p>
      ${card.source_note ? `<details class="snz-warnings"><summary>Источник и уточнения по карте</summary><p>${esc(card.source_note)}</p></details>` : ""}
      <div class="snz-controls"><label>Название${textInput(`cards.${ci}.name`,card.name,'maxlength="160"')}</label><label>Тип изделия${textInput(`cards.${ci}.element_type`,card.element_type)}</label><label>Подтип${textInput(`cards.${ci}.subtype`,card.subtype)}</label></div>
      <div class="snz-controls"><label>Отметка, мм${textInput(`cards.${ci}.elevation_mm`,card.elevation_mm,'type="number" aria-label="Отметка карты"')}</label><label>Направление ригеля<select data-path="cards.${ci}.axis_direction">${options([{id:"",name:"Любое"},{id:"letter",name:"Вдоль буквенных осей · 9 м"},{id:"numeric",name:"Вдоль цифровых осей · 12 м"}],card.axis_direction||"")}</select></label><span class="snz-muted">Отметки +15.000 и +15.800 считаются соответствующими.</span></div>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>Порядок</th><th>Операция</th><th>Норматив, мин</th><th>Задержка после, мин</th><th></th></tr></thead><tbody>
      ${card.steps.map((s,i)=>`<tr><td>${i+1} <button data-action="step-up" data-index="${i}" ${!i?"disabled":""}>↑</button><button data-action="step-down" data-index="${i}" ${i===card.steps.length-1?"disabled":""}>↓</button></td>
      <td>${esc(draft.operations.find(o=>o.id===s.operation_id)?.name||s.operation_id)}${s.source_note ? `<details><summary>${s.minutes == null ? "Уточнить норматив" : "Источник норматива"}</summary><small>${esc(s.source_note)}</small></details>` : ""}</td><td>${textInput(`cards.${ci}.steps.${i}.minutes`,s.minutes,'type="number" min="1" max="43200" aria-label="Норматив операции"')}</td>
      <td>${textInput(`cards.${ci}.steps.${i}.wait_after`,s.wait_after,'type="number" min="0" max="43200" aria-label="Задержка после операции"')}</td><td><button data-action="remove-step" data-index="${i}">Убрать из карты</button></td></tr>`).join("")}</tbody></table></div>
      <div class="snz-controls"><label>Добавить операцию<select data-new-step>${options(draft.operations.filter(o=>!card.steps.some(s=>s.operation_id===o.id)),"")}</select></label><button data-action="add-step">Добавить в карту</button></div>`;
  }
  function operationsHtml() {
    return `<p class="snz-muted">Состав операций можно расширять. Область «Узел» создаёт одну общую работу для вручную объединённых ригелей.</p>
      <table class="snz-table"><thead><tr><th>Операция</th><th>Звено</th><th>Область выполнения</th></tr></thead><tbody>${draft.operations.map((o,i)=>`<tr><td>${textInput(`operations.${i}.name`,o.name)}</td>
      <td><select data-path="operations.${i}.team">${options(draft.teams,o.team)}</select></td><td><select data-path="operations.${i}.scope">${options(scopes.map(([id,name])=>({id,name})),o.scope)}</select></td></tr>`).join("")}</tbody></table><button data-action="add-operation">Добавить операцию</button>`;
  }
  function crewsHtml() {
    return `<p class="snz-muted">Одна подготовительная бригада обслуживает монтажные потоки. Укажите прораба для каждого потока.</p><table class="snz-table"><thead><tr><th>Бригада / поток</th><th>Прораб</th><th>Назначение</th></tr></thead><tbody>
      ${draft.crews.map((c,i)=>`<tr><td>${textInput(`crews.${i}.name`,c.name)}</td><td>${textInput(`crews.${i}.foreman`,c.foreman)}</td><td>${c.kind==="preparation"?"Подготовка":"Монтаж"}</td></tr>`).join("")}</tbody></table><button data-action="add-crew">Добавить монтажную бригаду</button>`;
  }
  function teamsHtml() {
    return `<p class="snz-muted">Каждая бригада имеет по одному звену каждой используемой профессии. Звено выполняет только одну операцию одновременно.</p><table class="snz-table"><thead><tr><th>Звено</th></tr></thead><tbody>${draft.teams.map((t,i)=>`<tr><td>${textInput(`teams.${i}.name`,t.name)}</td></tr>`).join("")}</tbody></table><button data-action="add-team">Добавить звено</button>`;
  }
  function groupsHtml() {
    return `<p>Выберите в планировании три или четыре ригеля одного этажа, затем создайте общий узел. Сейчас выбрано: ${selection.size}.</p>
      <div class="snz-controls"><label>Название узла<input data-group-name placeholder="Например, крест в осях 7/Е"></label><button data-action="add-group">Создать из выбранных</button></div>
      <p class="snz-muted">Если ригели имеют разные нормативы общих операций, выберите для узла отдельную карту — например, для трёх или четырёх ригелей.</p>
      <table class="snz-table"><thead><tr><th>Узел</th><th>Ригели</th><th>Карта общих операций</th><th></th></tr></thead><tbody>${draft.groups.map((g,i)=>`<tr><td>${textInput(`groups.${i}.name`,g.name, g.element_ids.some(locked)?"disabled":"")}</td><td>${g.element_ids.map(id=>esc(data.elements.find(e=>e.id===id)?.mark||id)+" ("+id+")").join(", ")}</td><td><select data-path="groups.${i}.card_id" ${g.element_ids.some(locked)?"disabled":""}><option value="">Из карт изделий</option>${options(draft.cards,g.card_id)}</select></td><td><button data-action="remove-group" data-id="${g.id}" ${g.element_ids.some(locked)?"disabled":""}>Удалить</button></td></tr>`).join("")||'<tr><td colspan="4">Узлы пока не заданы.</td></tr>'}</tbody></table>`;
  }
  function orderEditHtml(){
    if(!orderEdit)return "";
    const order=orderEdit.order, members=new Map(order.tasks.flatMap(t=>t.elements.map(e=>[e.id,e])));
    const protectedIds=new Set(order.tasks.filter(t=>order.facts[t.key]?.completed).flatMap(t=>t.element_ids));
    const assignments=assignById(),query=orderEdit.filter.trim().toLocaleLowerCase("ru");
    const rows=[...members.values()].filter(e=>!query||[e.mark,e.id,e.element_type,e.address].join(" ").toLocaleLowerCase("ru").includes(query));
    const pages=Math.max(1,Math.ceil(rows.length/60));orderEdit.page=Math.min(orderEdit.page,pages-1);
    const pageRows=rows.slice(orderEdit.page*60,(orderEdit.page+1)*60);
    return `<section class="snz-edit"><h3>Редактирование состава СНЗ № ${order.id} · ${dayText(order.date)} · ${shiftText(order.shift)}</h3>
      <p>Отметьте изделия для исключения. Изменяется только этот СНЗ; назначения и внесённый факт сохраняются. Исходная редакция останется в истории. Ригели с общей операцией исключаются всем узлом.</p>
      <div class="snz-controls"><label>Поиск изделия<input type="search" data-edit-search value="${esc(orderEdit.filter)}" placeholder="Марка, тип или ID"></label><span>Найдено: ${rows.length} · исключить: ${orderEdit.exclude.size}</span><button data-action="edit-prev" ${orderEdit.page===0?"disabled":""}>Назад</button><span>${orderEdit.page+1} / ${pages}</span><button data-action="edit-next" ${orderEdit.page+1>=pages?"disabled":""}>Далее</button></div>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>Исключить</th><th>Изделие</th><th>Назначено на</th><th>Состояние</th></tr></thead><tbody>${pageRows.map(e=>{const a=assignments.get(e.id);return `<tr><td><input type="checkbox" data-edit-exclude="${e.id}" ${orderEdit.exclude.has(e.id)?"checked":""} ${protectedIds.has(e.id)?"disabled":""} aria-label="Исключить ${esc(e.mark||e.id)}"></td><td>${esc(e.mark||e.id)}<small>${esc(e.element_type)} · ID ${e.id}</small></td><td>${dayText(a?.date)} · ${a?shiftText(a.shift):"—"}</td><td>${protectedIds.has(e.id)?"Есть завершённые операции":"Можно исключить"}</td></tr>`}).join("")||'<tr><td colspan="4">В документе нет изделий.</td></tr>'}</tbody></table></div>
      <label class="snz-edit-reason">Причина исправления<textarea data-edit-reason rows="2" maxlength="1000" placeholder="Например, изделие относится к дневной смене">${esc(orderEdit.reason)}</textarea></label>
      <div class="snz-controls"><button data-action="edit-preview" ${!orderEdit.exclude.size||!orderEdit.reason.trim()?"disabled":""}>Проверить исправление</button><button class="snz-primary" data-action="edit-apply" ${!orderEdit.preview?"disabled":""}>Сохранить редакцию</button><button data-action="edit-cancel">Отмена</button></div>
      ${orderEdit.preview?planHtml({...orderEdit.preview,id:order.id,editPreview:true,facts:order.facts}):""}</section>`;
  }
  function revisionsHtml(){
    if(!revisions)return "";
    return `<section class="snz-edit"><h3>Редакции СНЗ № ${revisions.id}</h3><table class="snz-table"><thead><tr><th>Редакция</th><th>Дата</th><th>Автор</th><th>Причина</th><th></th></tr></thead><tbody>${revisions.rows.map(r=>`<tr><td>${r.revision}</td><td>${esc(r.created_at)}</td><td>${esc(r.created_by)}</td><td>${esc(r.reason)}</td><td><button data-action="open-revision" data-id="${revisions.id}" data-revision="${r.revision}">Открыть редакцию</button></td></tr>`).join("")}</tbody></table></section>`;
  }
  function ordersHtml() {
    const rows=data.orders.filter(o=>!ordersDate||o.work_date===ordersDate);
    const total=(ordersDate?data.registry_by_date?.[ordersDate]:data.registry_total)||{quantity:0,unique_quantity:0};
    return `<div class="snz-issued-layout"><section class="snz-orders-top" aria-label="Реестр выданных СНЗ">
      <div class="snz-controls"><label>Дата СНЗ (отбор)<input type="date" data-filter="ordersDate" value="${esc(ordersDate)}"></label><button data-action="orders-all">Все даты</button><button data-action="registry-xlsx" ${!ordersDate?"disabled title='Выберите дату реестра'":""}>Реестр за день в Excel</button></div>
      <p class="snz-muted">Дата — начало смены. Ночь: 20:00 выбранного дня — 08:00 следующего.</p>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>№</th><th>Дата</th><th>Смена</th><th>Бригада</th><th>Прораб</th><th>Количество шт</th><th>Выдал</th><th>Действия</th></tr></thead><tbody>${rows.map(o=>`<tr><td>${o.id}${o.order_revision>1?` · ред. ${o.order_revision}`:""}</td><td>${dayText(o.work_date)}</td><td title="${dayText(o.start)} ${timeText(o.start)} — ${dayText(o.end)} ${timeText(o.end)}">${shiftText(o.shift)}</td><td>${esc(o.crew_name)}</td><td>${esc(o.foreman||"Не назначен")}</td><td>${o.quantity}</td><td>${esc(o.created_by)}</td><td><div class="snz-order-actions"><button data-action="open-order" data-id="${o.id}">Открыть</button>${canWrite()?`<button data-action="edit-order" data-id="${o.id}">Редактировать</button><button data-action="delete-order" data-id="${o.id}">Удалить СНЗ</button>`:""}<button data-action="order-revisions" data-id="${o.id}">Редакции</button></div></td></tr>`).join("")||'<tr><td colspan="8">За выбранную дату СНЗ не выдавались.</td></tr>'}</tbody></table></div>
      <p class="snz-registry-total"><strong>Итого по документам: ${total.quantity} шт.</strong> Уникальных изделий: ${total.unique_quantity} шт. · СНЗ: ${rows.length}</p></section>
      <div class="snz-issued-splitter" data-snz-splitter role="separator" aria-label="Высота реестра и открытого СНЗ" aria-orientation="horizontal" aria-valuemin="15" aria-valuemax="80" tabindex="0" title="Перетащите для изменения высоты; стрелки вверх и вниз — с клавиатуры"></div>
      <section class="snz-orders-bottom" aria-label="Открытый СНЗ">${orderEditHtml()}${revisionsHtml()}${!orderEdit?planHtml():""}${!orderEdit&&!revisions&&!plan?'<p class="snz-muted">Откройте СНЗ в реестре сверху. Высоту частей можно изменить разделителем.</p>':""}</section></div>`;
  }
  function render() {
    if (!dialog) return;
    const active = document.activeElement, focusKey = active?.dataset?.path;
    const paneScroll=[...dialog.querySelectorAll('.snz-orders-top,.snz-orders-bottom')].map(el=>el.scrollTop);
    const editScroll=orderEdit?dialog.querySelector('.snz-content')?.scrollTop:null;
    const searchFocus=active?.matches('[data-edit-search]')?active.selectionStart:null;
    dialog.innerHTML = `<header class="snz-head"><div><h2>Сменные наряд-задания</h2><p data-dirty>${dirty?"Есть несохранённые изменения":"Планирование, загрузка звеньев и выдача прорабам"}</p></div><span class="snz-spacer"></span>
      <button data-action="save" class="snz-primary" ${!dirty||busy||!canWrite()?"disabled":""}>Сохранить изменения</button><button data-action="reload" ${busy?"disabled":""}>Обновить</button><button data-action="close" ${busy?"disabled":""} aria-label="Закрыть СНЗ">Закрыть</button></header>
      <nav class="snz-tabs" aria-label="Разделы СНЗ">${[["plan","Планирование"],["cards","Нормативы"],["operations","Операции"],["teams","Звенья"],["crews","Бригады"],["groups","Узлы ригелей"],["orders","Выданные СНЗ"]].map(([id,name])=>`<button data-tab="${id}" aria-pressed="${id===tab}" ${busy?"disabled":""}>${name}</button>`).join("")}</nav>
      <div class="snz-content ${tab==="orders"?"snz-issued-content":""}" ${busy?'aria-busy="true"':""}>${error?`<p class="snz-error" role="alert">${esc(error)}</p>`:""}${message?`<p class="snz-message" role="status">${esc(message)}</p>`:""}
      ${!draft?"<p>Загрузка данных СНЗ…</p>":`<fieldset ${busy?"disabled":""}>${tab==="plan"?plannerHtml():tab==="orders"?ordersHtml():`<fieldset ${!canWrite()?"disabled":""}>${tab==="cards"?cardsHtml():tab==="operations"?operationsHtml():tab==="teams"?teamsHtml():tab==="crews"?crewsHtml():groupsHtml()}</fieldset>`}</fieldset>`}</div>`;
    bindIssuedLayout(dialog);
    dialog.querySelectorAll('.snz-orders-top,.snz-orders-bottom').forEach((el,i)=>{el.scrollTop=paneScroll[i]||0;});
    if(editScroll!=null)dialog.querySelector('.snz-content').scrollTop=editScroll;
    if(searchFocus!=null){const input=dialog.querySelector('[data-edit-search]');input?.focus();input?.setSelectionRange(searchFocus,searchFocus);}
    if(scrollToEdit&&!busy){dialog.querySelector('.snz-edit')?.scrollIntoView({block:'start'});scrollToEdit=false;}
    const invalid=validationIssue&&dialog.querySelector(`[data-path="${CSS.escape(validationIssue.path)}"]`);
    if(invalid){invalid.setAttribute("aria-invalid","true");invalid.title=validationIssue.message;if(!busy){invalid.focus();invalid.scrollIntoView({block:"nearest"});}}
    else if (focusKey) dialog.querySelector(`[data-path="${CSS.escape(focusKey)}"]`)?.focus();
  }
  function change(e) {
    const target = e.target;
    if (target.dataset.path) {
      const parts = target.dataset.path.split("."), key = parts.pop();
      let holder = draft; for (const part of parts) holder = holder[part];
      holder[key] = target.type === "number" ? (target.value === "" ? (key==="wait_after"?0:null) : Number(target.value)) : target.value;
      if (key==="card_id" && target.dataset.path.startsWith("groups.") && !target.value) holder[key]=null;
      if(validationIssue?.path===target.dataset.path){validationIssue=null;error="";target.removeAttribute("aria-invalid");target.removeAttribute("title");dialog.querySelector(".snz-error")?.remove();}
      dirtyMark();
    } else if (target.dataset.editExclude && orderEdit) {
      const id=Number(target.dataset.editExclude),group=orderEdit.order.tasks.find(t=>t.group_id&&t.element_ids.includes(id));
      for(const member of group?.element_ids||[id])target.checked?orderEdit.exclude.add(member):orderEdit.exclude.delete(member);
      orderEdit.preview=null;render();
    } else if (target.dataset.select) {
      const id = Number(target.dataset.select); if (target.checked) selection.add(id); else selection.delete(id); renderItems();
    } else if (target.dataset.filter) {
      const k = target.dataset.filter, v = target.value;
      if (k==="ordersDate") ordersDate=v;
      if (k==="date") { date=v;plan=null; }
      if (k==="shift") { shift=v;plan=null; }
      if (k==="crew") { crewId=v;plan=null; }
      if (k==="card") cardId=v;
      if (k==="assignmentCard") assignmentCard=v;
      if (k==="status") status=v;
      if (k==="dateFilter") dateFilter=v;
      if (k==="crewFilter") crewFilter=v;
      if (k==="shiftFilter") shiftFilter=v;
      if (k==="noPriority") noPriority=target.checked;
      if (k==="noDate") noDate=target.checked;
      page=0; render();
    }
  }
  async function click(e) {
    const button = e.target.closest("button"); if (!button || button.disabled || busy) return;
    if (button.dataset.tab) { if(editDirty()){error="Сначала сохраните исправление или нажмите «Отмена».";render();return;} tab=button.dataset.tab;error="";message="";render();return; }
    const action = button.dataset.action;
    if(action==="orders-all"){ordersDate="";render();return;}
    if(action==="registry-xlsx"&&ordersDate){
      await run(async()=>{const blob=await api.download(path()+`/registry.xlsx?date=${ordersDate}`,undefined,{method:"GET"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`Реестр-СНЗ-${ordersDate}.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});return;
    }
    if (action==="close") { close();return; }
    if (action==="save") { await run(save);return; }
    if (action==="reload") { if ((dirty||editDirty())&&!window.confirm("Отменить несохранённые изменения и загрузить данные заново?"))return; await run(async()=>{await load();plan=null;orderEdit=null;revisions=null;});return; }
    if (action==="preview") { await run(async()=>{plan=await api.post(path()+"/preview",{revision:data.revision,date,shift,crew_id:crewId});if(plan.id)message="СНЗ этой смены уже выдан: открыт сохранённый документ. Для исправления состава используйте «Редактировать».";});return; }
    if (action==="issue") { const requestId=uid(); await run(async()=>{const r=await api.post(path()+"/orders",{revision:data.revision,date,shift,crew_id:crewId,request_id:requestId,expected_hash:plan.fingerprint});await load();plan=await api.get(path()+`/orders/${r.id}`);message="СНЗ выдан и сохранён";});return; }
    if (["delete-order","edit-order","order-revisions","open-revision","open-order"].includes(action) && editDirty()) {
      error="Сначала сохраните исправление или нажмите «Отмена».";render();return;
    }
    if(["delete-order","edit-order","edit-preview","edit-apply"].includes(action)&&!canWrite())return;
    if(action==="delete-order"){
      if(dirty){error="Сначала сохраните изменения планирования.";render();return;}
      const id=Number(button.dataset.id),order=data.orders.find(o=>o.id===id);
      if(!order)return;
      if(!window.confirm(`Удалить СНЗ № ${id} · ${dayText(order.work_date)} · ${shiftText(order.shift)} · ${order.crew_name}?\n\nДокумент и его редакции сохранятся в архиве. Назначения этой смены будут сняты с изделий, которых нет в других выданных СНЗ. Смену можно будет выдать заново.`))return;
      await run(async()=>{
        const result=await api.post(path()+`/orders/${id}/delete`,{revision:data.revision,order_revision:order.order_revision,request_id:uid()});
        plan=null;orderEdit=null;revisions=null;
        await load();
        const held=[...new Set(Object.values(result.kept_in_orders).flat())];
        message=`СНЗ № ${id} удалён. Снято назначений: ${result.cleared_element_ids.length}. Можно назначить изделия и выдать новый СНЗ.`+(held.length?` Часть изделий остаётся в выданных СНЗ № ${held.join(", ")}; их назначения сохранены.`:"");
        send("poll");onChanged?.();
      });return;
    }
    if(action==="edit-order"){
      if(dirty){error="Сначала сохраните изменения планирования.";render();return;}
      await run(async()=>{await load();const order=await api.get(path()+`/orders/${Number(button.dataset.id)}`);orderEdit={order,exclude:new Set(),reason:"",preview:null,filter:"",page:0};plan=null;revisions=null;scrollToEdit=true;});return;
    }
    if(["edit-prev","edit-next"].includes(action)&&orderEdit){orderEdit.page+=action==="edit-next"?1:-1;render();return;}
    if(action==="edit-cancel"){if(editDirty()&&!window.confirm("Отменить исправление состава СНЗ?"))return;orderEdit=null;error="";render();return;}
    if(action==="edit-preview"&&orderEdit){
      await run(async()=>{orderEdit.preview=await api.post(path()+`/orders/${orderEdit.order.id}/edit-preview`,{revision:data.revision,order_revision:orderEdit.order.order_revision,exclude_element_ids:[...orderEdit.exclude],reason:orderEdit.reason});});return;
    }
    if(action==="edit-apply"&&orderEdit?.preview){
      if(!window.confirm(`Сохранить новую редакцию СНЗ № ${orderEdit.order.id}? Исключается изделий: ${orderEdit.exclude.size}. Исходная редакция останется в истории.`))return;
      const id=orderEdit.order.id,body={revision:data.revision,order_revision:orderEdit.order.order_revision,exclude_element_ids:[...orderEdit.exclude],reason:orderEdit.reason,request_id:uid(),expected_hash:orderEdit.preview.fingerprint};
      await run(async()=>{try{await api.post(path()+`/orders/${id}/revisions`,body);}catch(e){orderEdit.preview=null;throw e;}orderEdit=null;revisions=null;await load();plan=await api.get(path()+`/orders/${id}`);message="Исправленная редакция СНЗ сохранена. Исходная доступна в «Редакциях».";});return;
    }
    if(action==="order-revisions"){
      if(dirty){error="Сначала сохраните изменения планирования.";render();return;}
      await run(async()=>{const id=Number(button.dataset.id);revisions={id,rows:await api.get(path()+`/orders/${id}/revisions`)};orderEdit=null;});return;
    }
    if(action==="open-revision"){
      await run(async()=>{plan=await api.get(path()+`/orders/${Number(button.dataset.id)}/revisions/${Number(button.dataset.revision)}`);});return;
    }
    if (action==="open-order") { if(dirty){error="Сначала сохраните изменения или обновите данные.";render();return;} await run(async()=>{plan=await api.get(path()+`/orders/${Number(button.dataset.id)}`);orderEdit=null;revisions=null;});return; }
    if (action==="complete") { const key=button.dataset.key; await run(async()=>{const r=await api.post(path()+"/facts",{revision:data.revision,task_key:key});await load();plan=await api.get(path()+`/orders/${plan.id}`);message=r.warnings?.join(" ")||"Операция завершена";send("poll");});return; }
    if (action==="xlsx" || action==="pdf") {
      await run(async()=>{const blob=await api.download(path()+`/orders/${plan.id}/export.${action}${plan.historical?"?revision="+plan.order_revision:""}`,undefined,{method:"GET"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`СНЗ-${plan.id}${plan.order_revision?"-ред-"+plan.order_revision:""}.${action}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});return;
    }
    if (action==="show-sequence") { const items=draft.assignments.filter(a=>a.date===date&&a.shift===shift&&a.crew_id===crewId).map(a=>({id:a.element_id,priority:a.priority}));if(close()){send("setView",{mode:"2d"});send("snzLabels",{items});}return; }
    if (action==="clear") selection.clear();
    if (action==="page-all") for(const el of filtered().slice(page*60,(page+1)*60))selection.add(el.id);
    if (action==="prev") page--;
    if (action==="next") page++;
    if (["clear","page-all","prev","next"].includes(action)){renderItems();return;}
    if (!canWrite())return;
    const card=draft.cards.find(c=>c.id===cardId)||draft.cards[0];
    if (action==="assign") {
      if(!date||!selection.size){error="Выберите изделия и дату монтажа.";render();return;}
      const chosen=selected();
      if(chosen.some(e=>e.current_status!=="ready_for_installation")){error="Назначать можно только изделия «Готов к монтажу».";render();return;}
      if(assignmentCard==="auto" && dirty){error="Сначала сохраните справочники для автоматического подбора карты.";render();return;}
      if(assignmentCard==="auto" && chosen.some(e=>!e.suggested_card_id)){error="Для части изделий нет однозначного соответствия карте. Уточните справочник или выберите карту вручную.";render();return;}
      let priority=Math.max(0,...draft.assignments.filter(a=>a.crew_id===crewId).map(a=>a.priority||0));
      let prepPriority=Math.max(0,...draft.assignments.map(a=>a.prep_priority||0));
      for(const el of chosen){if(locked(el.id))continue;const a=draft.assignments.find(a=>a.element_id===el.id);const v={element_id:el.id,crew_id:crewId,card_id:assignmentCard==="auto"?el.suggested_card_id:assignmentCard,date,shift,priority:a?.priority||++priority,prep_priority:a?.prep_priority||++prepPriority};if(a)Object.assign(a,v);else draft.assignments.push(v);}
      dirtyMark();
    }
    if(action==="remove-assignment"){draft.assignments=draft.assignments.filter(a=>a.element_id!==Number(button.dataset.id));dirtyMark();}
    if(action==="add-card"||action==="copy-card"){const newCard=action==="copy-card"?structuredClone(card):{name:"Новая карта",element_type:"",subtype:"",steps:draft.operations.map(o=>({operation_id:o.id,minutes:null,wait_after:0}))};newCard.id=uid();if(action==="copy-card")newCard.name+=" — копия";draft.cards.push(newCard);cardId=newCard.id;dirtyMark();}
    if(action==="add-operation"){draft.operations.push({id:uid(),name:"Новая операция",team:draft.teams[0].id,scope:"element"});dirtyMark();}
    if(action==="add-team"){draft.teams.push({id:uid(),name:"Новое звено"});dirtyMark();}
    if(action==="add-crew"){draft.crews.push({id:uid(),name:"Новая монтажная бригада",foreman:"",kind:"installation"});dirtyMark();}
    if(action==="add-step"){const op=dialog.querySelector("[data-new-step]")?.value;if(op){card.steps.push({operation_id:op,minutes:null,wait_after:0});dirtyMark();}}
    if(action==="remove-step"){if(card.steps.length===1){error="В карте должна остаться хотя бы одна операция.";}else{card.steps.splice(Number(button.dataset.index),1);dirtyMark();}}
    if(action==="step-up"||action==="step-down"){const i=Number(button.dataset.index),j=i+(action==="step-up"?-1:1);[card.steps[i],card.steps[j]]=[card.steps[j],card.steps[i]];dirtyMark();}
    if(action==="add-group"){
      const name=dialog.querySelector("[data-group-name]").value.trim(),es=selected();
      if(!name||![3,4].includes(es.length)||es.some(e=>!e.element_type.toLocaleLowerCase("ru").includes("ригел"))){error="Введите название и выберите три или четыре ригеля.";}
      else if(es.some(e=>draft.groups.some(g=>g.element_ids.includes(e.id)))){error="Один из ригелей уже входит в другой узел.";}
      else{draft.groups.push({id:uid(),name,element_ids:es.map(e=>e.id)});dirtyMark();}
    }
    if(action==="remove-group"){draft.groups=draft.groups.filter(g=>g.id!==button.dataset.id);dirtyMark();}
    render();
  }
  return {
    open,
    html: () => `<section class="ws-pad"><h3>Сменные наряд-задания</h3><p>Нормативы, назначения изделий, узлы ригелей и загрузка звеньев.</p><p>Выбрано на модели: ${getSelectedIds().length}</p><button type="button" data-snz-open>Открыть планирование СНЗ</button><p class="v2-muted">Выделенные на модели изделия будут выбраны в планировании.</p></section>`,
    bind: host => host.querySelector("[data-snz-open]")?.addEventListener("click",()=>open()),
    isDirty: () => dirty || busy || editDirty(),
    guardLeave: () => !dialog || close(),
    reset: () => {close(true);data=null;draft=null;plan=null;selection.clear();},
    destroy: () => close(true),
    hideLabels: () => send("snzLabels", { items: [] }),
  };
}
