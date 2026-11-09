import { esc } from "./screen-view.js";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const timeText = (s) => s?.slice(11, 16) || "—";
const dayText = (s) => s ? s.slice(0, 10).split("-").reverse().join(".") : "—";
const shiftText = (s) => s === "day" ? "День" : "Ночь";
const scopes = [["preparation", "Подготовка"], ["element", "Изделие"], ["group", "Узел из 3–4 ригелей"]];
const options = (rows, value, key = "id", title = "name") => rows.map(r => `<option value="${esc(r[key])}" ${r[key] === value ? "selected" : ""}>${esc(r[title])}</option>`).join("");
const textInput = (path, value, extra = "") => `<input data-path="${path}" value="${esc(value ?? "")}" ${extra}>`;

export function createSnz({ api, getObjectId, getSelectedIds, send }) {
  let data = null, draft = null, dialog = null, dirty = false, busy = false, error = "", message = "";
  let tab = "plan", selection = new Set(), plan = null, cardId = "base", assignmentCard = "auto", date = today(), shift = "day", crewId = "install1";
  let filter = "", status = "ready_for_installation", dateFilter = "", crewFilter = "", noPriority = false, noDate = false, page = 0, generation = 0;
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
    data = result; draft = structuredClone(data.state); dirty = false;
    if (!draft.crews.some(c => c.id === crewId)) crewId = draft.crews.find(c => c.kind === "installation").id;
    if (!draft.cards.some(c => c.id === cardId)) cardId = draft.cards[0].id;
    return true;
  }
  async function run(fn) {
    if (busy) return;
    busy = true; error = ""; message = ""; render();
    try { await fn(); } catch (e) { error = e.message || "Не удалось выполнить действие"; }
    finally { busy = false; render(); }
  }
  async function save() {
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
    });
    dialog.showModal(); busy = true; render();
    try { if (await load()) { if (orderId) plan = await api.get(path() + `/orders/${orderId}`); } }
    catch (e) { error = e.message; }
    finally { busy = false; render(); }
  }
  function close(force = false) {
    if (busy && !force) return false;
    if (dirty && !force && !window.confirm("Закрыть СНЗ без сохранения изменений?")) return false;
    dialog?.close(); dialog?.remove(); dialog = null; dirty = false; generation++; return true;
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
      <label class="snz-check"><input type="checkbox" data-filter="noPriority" ${noPriority?"checked":""}>Без очередности</label><label class="snz-check"><input type="checkbox" data-filter="noDate" ${noDate?"checked":""}>Без даты монтажа</label></div>
      <fieldset ${!canWrite() ? "disabled" : ""}><div class="snz-controls">
      <label>Карта для назначения<select data-filter="assignmentCard"><option value="auto" ${assignmentCard==="auto"?"selected":""}>По справочнику автоматически</option>${options(draft.cards,assignmentCard)}</select></label>
      <button data-action="assign" ${draft.crews.find(c=>c.id===crewId)?.kind!=="installation"?"disabled title='Выберите монтажную бригаду в поле СНЗ бригады'":""}>Назначить выбранные</button>
      <button data-action="show-sequence" ${dirty?"disabled":""}>Показать очередность на модели</button>
      </div><div data-items>${itemsHtml()}</div></fieldset>
      ${planHtml()}`;
  }
  function planHtml() {
    if (!plan) return "";
    const origin = new Date(plan.start).getTime(), offset = s => Math.max(0, Math.min(100, (new Date(s).getTime()-origin)/432000));
    const teams = [...new Set(plan.tasks.map(t=>t.team))], facts = plan.facts || draft.facts;
    return `<section class="snz-result"><div class="snz-controls"><h3>${plan.id ? "Выданный СНЗ № "+plan.id : "Расчёт смены"} · ${dayText(plan.date)} · ${shiftText(plan.shift)} · ${esc(plan.crew.name)}</h3>
      ${plan.id ? `<button data-action="xlsx">Excel</button><button data-action="pdf">Поэтажные планы PDF</button>` : ""}</div>
      ${plan.warnings.length ? `<details class="snz-warnings"><summary>Предупреждения: ${plan.warnings.length}</summary><ul>${plan.warnings.map(w=>`<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}
      <p class="snz-muted">План: ${plan.tasks.length} операций · ${plan.tasks.reduce((n,t)=>n+t.segments.reduce((m,s)=>m+s.minutes,0),0)} минут работы звеньев. Факт: только 0 или 100 %.</p>
      <div class="snz-gantt" role="img" aria-label="Загрузка звеньев в течение смены"><div class="snz-gantt-row"><strong>Звено</strong><div class="snz-hours">${Array.from({length:13},(_,i)=>`<span style="left:${i/12*100}%">${String((Number(plan.start.slice(11,13))+i)%24).padStart(2,"0")}:00</span>`).join("")}</div></div>
      ${teams.map(team=>`<div class="snz-gantt-row"><strong>${esc(team)}</strong><div class="snz-track">
      ${[[0,20],...(plan.shift==="day"?[[300,360]]:[[240,300]]),[700,720]].map(([a,b])=>`<span class="snz-break" style="left:${a/720*100}%;width:${(b-a)/720*100}%"></span>`).join("")}
      ${plan.tasks.flatMap((t,i)=>t.team!==team?[]:t.segments.map(s=>`<span class="snz-bar snz-color-${i%5}" style="left:${offset(s.start)}%;width:${offset(s.end)-offset(s.start)}%" title="${esc(t.operation)} · ${esc(t.elements.map(e=>e.mark||e.id).join(', '))} · ${timeText(s.start)}–${timeText(s.end)}">${i+1}</span>`)).join("")}</div></div>`).join("")}</div>
      <div class="snz-table-wrap"><table class="snz-table"><thead><tr><th>№</th><th>Операция / изделие</th><th>Звено</th><th>Время</th><th>Норматив / остаток</th><th>Факт</th></tr></thead><tbody>
      ${plan.tasks.map((t,i)=>`<tr><td>${i+1}</td><td><strong>${esc(t.operation)}</strong><small>${esc(t.group_name || t.elements.map(e=>e.mark||e.id).join(', '))}${t.group_name?" · "+esc(t.elements.map(e=>e.mark||e.id).join(', ')):""}${t.carry?" · перенос":""}</small></td><td>${esc(t.team)}</td>
      <td>${t.segments.map(s=>`${timeText(s.start)}–${timeText(s.end)}`).join("<br>")}</td><td>${t.norm_minutes} / ${t.remaining_after} мин</td>
      <td>${facts[t.key]?.completed?'<span class="snz-done">100 % · завершено</span>':`<span>0 %</span> ${plan.id && data.can_fact?`<button data-action="complete" data-key="${esc(t.key)}">Завершить</button>`:""}`}</td></tr>`).join("") || '<tr><td colspan="6">Нет рассчитанных работ.</td></tr>'}</tbody></table></div></section>`;
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
  function ordersHtml() {
    return `<p class="snz-muted">Один выданный документ относится к одному прорабу и одной смене. Его состав и расписание сохраняются без последующих изменений.</p>
      <table class="snz-table"><thead><tr><th>№</th><th>Дата</th><th>Смена</th><th>Бригада</th><th>Выдал</th><th></th></tr></thead><tbody>${data.orders.map(o=>`<tr><td>${o.id}</td><td>${dayText(o.work_date)}</td><td>${shiftText(o.shift)}</td><td>${esc(crewName(o.crew_id))}</td><td>${esc(o.created_by)}</td><td><button data-action="open-order" data-id="${o.id}">Открыть</button></td></tr>`).join("")||'<tr><td colspan="6">Выданных СНЗ пока нет.</td></tr>'}</tbody></table>${planHtml()}`;
  }
  function render() {
    if (!dialog) return;
    const active = document.activeElement, focusKey = active?.dataset?.path;
    dialog.innerHTML = `<header class="snz-head"><div><h2>Сменные наряд-задания</h2><p data-dirty>${dirty?"Есть несохранённые изменения":"Планирование, загрузка звеньев и выдача прорабам"}</p></div><span class="snz-spacer"></span>
      <button data-action="save" class="snz-primary" ${!dirty||busy||!canWrite()?"disabled":""}>Сохранить изменения</button><button data-action="reload" ${busy?"disabled":""}>Обновить</button><button data-action="close" ${busy?"disabled":""} aria-label="Закрыть СНЗ">Закрыть</button></header>
      <nav class="snz-tabs" aria-label="Разделы СНЗ">${[["plan","Планирование"],["cards","Нормативы"],["operations","Операции"],["teams","Звенья"],["crews","Бригады"],["groups","Узлы ригелей"],["orders","Выданные СНЗ"]].map(([id,name])=>`<button data-tab="${id}" aria-pressed="${id===tab}" ${busy?"disabled":""}>${name}</button>`).join("")}</nav>
      <div class="snz-content" ${busy?'aria-busy="true"':""}>${error?`<p class="snz-error" role="alert">${esc(error)}</p>`:""}${message?`<p class="snz-message" role="status">${esc(message)}</p>`:""}
      ${!draft?"<p>Загрузка данных СНЗ…</p>":`<fieldset ${busy?"disabled":""}>${tab==="plan"?plannerHtml():tab==="orders"?ordersHtml():`<fieldset ${!canWrite()?"disabled":""}>${tab==="cards"?cardsHtml():tab==="operations"?operationsHtml():tab==="teams"?teamsHtml():tab==="crews"?crewsHtml():groupsHtml()}</fieldset>`}</fieldset>`}</div>`;
    if (focusKey) dialog.querySelector(`[data-path="${CSS.escape(focusKey)}"]`)?.focus();
  }
  function change(e) {
    const target = e.target;
    if (target.dataset.path) {
      const parts = target.dataset.path.split("."), key = parts.pop();
      let holder = draft; for (const part of parts) holder = holder[part];
      holder[key] = target.type === "number" ? (target.value === "" ? (key==="wait_after"?0:null) : Number(target.value)) : target.value;
      if (key==="card_id" && target.dataset.path.startsWith("groups.") && !target.value) holder[key]=null;
      dirtyMark();
    } else if (target.dataset.select) {
      const id = Number(target.dataset.select); if (target.checked) selection.add(id); else selection.delete(id); renderItems();
    } else if (target.dataset.filter) {
      const k = target.dataset.filter, v = target.value;
      if (k==="date") { date=v;plan=null; }
      if (k==="shift") { shift=v;plan=null; }
      if (k==="crew") { crewId=v;plan=null; }
      if (k==="card") cardId=v;
      if (k==="assignmentCard") assignmentCard=v;
      if (k==="status") status=v;
      if (k==="dateFilter") dateFilter=v;
      if (k==="crewFilter") crewFilter=v;
      if (k==="noPriority") noPriority=target.checked;
      if (k==="noDate") noDate=target.checked;
      page=0; render();
    }
  }
  async function click(e) {
    const button = e.target.closest("button"); if (!button || button.disabled || busy) return;
    if (button.dataset.tab) { tab=button.dataset.tab;error="";message="";render();return; }
    const action = button.dataset.action;
    if (action==="close") { close();return; }
    if (action==="save") { await run(save);return; }
    if (action==="reload") { if (dirty&&!window.confirm("Отменить несохранённые изменения и загрузить данные заново?"))return; await run(async()=>{await load();plan=null;});return; }
    if (action==="preview") { await run(async()=>{plan=await api.post(path()+"/preview",{revision:data.revision,date,shift,crew_id:crewId});});return; }
    if (action==="issue") { const requestId=uid(); await run(async()=>{const r=await api.post(path()+"/orders",{revision:data.revision,date,shift,crew_id:crewId,request_id:requestId,expected_hash:plan.fingerprint});await load();plan=await api.get(path()+`/orders/${r.id}`);message="СНЗ выдан и сохранён";});return; }
    if (action==="open-order") { if(dirty){error="Сначала сохраните изменения или обновите данные.";render();return;} await run(async()=>{plan=await api.get(path()+`/orders/${Number(button.dataset.id)}`);});return; }
    if (action==="complete") { const key=button.dataset.key; await run(async()=>{const r=await api.post(path()+"/facts",{revision:data.revision,task_key:key});await load();plan=await api.get(path()+`/orders/${plan.id}`);message=r.warnings?.join(" ")||"Операция завершена";send("poll");});return; }
    if (action==="xlsx" || action==="pdf") {
      await run(async()=>{const blob=await api.download(path()+`/orders/${plan.id}/export.${action}`,undefined,{method:"GET"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`СНЗ-${plan.id}.${action}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});return;
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
    html: () => `<section class="ws-pad"><h3>Сменные наряд-задания</h3><p>Нормативы, назначения изделий, узлы ригелей и загрузка звеньев.</p><p>Выбрано на модели: ${getSelectedIds().length}</p><button type="button" data-snz-open>Открыть планирование СНЗ</button><p class="v2-muted">Выделенные на модели изделия будут выбраны в планировании.</p></section>`,
    bind: host => host.querySelector("[data-snz-open]")?.addEventListener("click",()=>open()),
    isDirty: () => dirty || busy,
    guardLeave: () => !dialog || close(),
    reset: () => {close(true);data=null;draft=null;plan=null;selection.clear();},
    destroy: () => close(true),
    hideLabels: () => send("snzLabels", { items: [] }),
  };
}
