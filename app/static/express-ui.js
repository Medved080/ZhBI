// Бот eXpress — вкладка «Бот eXpress» общего экрана численности для V1 и V2 (2026-10-23, Docs/express-bot.md).
//
// Бот по расписанию пишет выбранному контакту в eXpress и спрашивает численность по объекту; ответ попадает в систему с источником «бот».
// Модуль ОБЩИЙ с V1/V2 (как headcount-ui.js, чьи стили и классы `hc-*` он использует; свои классы `ex-*` — в конце headcount.css) и грузится
// лениво из вкладки. Транспорт и права передаются явно: ctx = { api, objectId, canWrite, canAdmin, confirm, sub, onSub }.
//   canWrite — раздел `express_bot` «Изменение» на объекте (расписания, контакты, ручная отправка);
//   canAdmin — раздел `express_admin` (подключение, ключ, журнал обмена, удаление контактов).
// Сервер (app/express_api.py) проверяет права и все значения сам; клиент только показывает и отправляет.

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => (e && typeof e.detail === "string" && e.detail) || (e && e.message) || String(e);
const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const fmtMoment = (s) => {
  if (!s) return "";
  const raw = String(s);
  const d = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const DAYS = [[1, "Пн"], [2, "Вт"], [3, "Ср"], [4, "Чт"], [5, "Пт"], [6, "Сб"], [7, "Вс"]];
// «Пн–Пт», «ежедневно», иначе перечень коротких названий
const daysText = (days) => {
  const set = [...days].sort((a, b) => a - b).join(",");
  if (set === "1,2,3,4,5,6,7") return "ежедневно";
  if (set === "1,2,3,4,5") return "Пн–Пт";
  return DAYS.filter(([n]) => days.includes(n)).map(([, t]) => t).join(", ");
};
const STATUS = { pending: ["ожидает отправки", "warn"], sent: ["отправлен, ждём ответ", ""], answered: ["внесено, запрос открыт", "ok"], closed: ["закрыт", "ok"], failed: ["не доставлен", "bad"] };
const SUBS = [["schedules", "Расписания"], ["requests", "Запросы и ответы"], ["chat", "Переписка"], ["contacts", "Контакты"]];
const SUBS_ADMIN = [["connection", "Подключение"], ["log", "Журнал обмена"]];

function ensureCss() {
  if (document.querySelector("link[data-hc-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/headcount.css"; l.setAttribute("data-hc-css", "1");
  document.head.appendChild(l);
}

// ctx.mode: "object" (по умолчанию) — вкладка «Бот eXpress» в численности: расписания, запросы, контакты выбранного объекта;
//           "admin" — экран «Администрирование → Бот eXpress»: подключение, ключ, журнал обмена (сервисные настройки, объекта нет).
export function mountExpress(el, ctx) {
  const { api } = ctx;
  let dead = false;
  const adminMode = ctx.mode === "admin";
  const subs = adminMode ? SUBS_ADMIN : SUBS;
  if (adminMode) { ensureCss(); if (!el.closest(".hc-root")) el.classList.add("hc-root"); }
  const st = {
    sub: subs.some(([k]) => k === ctx.sub) ? ctx.sub : subs[0][0], status: null, schedules: null, requests: null, contacts: null, individuals: null,
    form: null, contactForm: null, sendForm: null, config: null, log: null, logErrors: false, logContact: "", logObject: "", chat: null, chatContact: "", msg: "", msgKind: "", busy: false,
  };
  el.innerHTML = `<div class="ex-tabs" role="tablist" aria-label="Разделы бота eXpress">${subs.map(([k, t]) => `<button type="button" role="tab" class="ex-tab" data-sub="${k}">${esc(t)}</button>`).join("")}</div><div id="ex-pane"></div>`;
  const pane = el.querySelector("#ex-pane");
  // При переходе между подвкладками данные запрашиваются заново: пока вкладка была закрыта, контакт мог привязаться, ответить боту, расписание — сработать
  el.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.sub !== st.sub) { st.contacts = st.requests = st.schedules = st.status = st.log = st.chat = null; }
    st.sub = b.dataset.sub; st.msg = ""; ctx.onSub?.(st.sub); paint();
  }));
  const setMsg = (t, kind = "") => { st.msg = t; st.msgKind = kind; const n = pane.querySelector("#ex-msg"); if (n) { n.textContent = t; n.className = `hc-msg ${kind}`; } };
  const msgLine = () => `<p id="ex-msg" class="hc-msg ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>`;
  const guard = async (fn, okText) => {
    if (st.busy) return;
    st.busy = true;
    try { const r = await fn(); if (okText) setMsg(okText, "ok"); return r; }
    catch (e) { setMsg(errText(e), "bad"); }
    finally { st.busy = false; }
  };
  // разметка полей: подпись над полем, флажок — подпись СПРАВА от флажка
  const field = (label, control, cls = "") => `<label class="ex-field ${cls}">${esc(label)}${control}</label>`;
  const check = (id, label, on, extra = "") => `<label class="ex-check"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${extra}> ${label}</label>`;

  async function load(what) {
    try {
      if (what === "status" || what === "all") st.status = await api.get("/express/status");
      if (what === "schedules" || what === "all") st.schedules = await api.get(`/objects/${ctx.objectId}/express/schedules`);
      if (what === "requests" || what === "all") st.requests = await api.get(`/objects/${ctx.objectId}/express/requests?days=14`);
      if (what === "contacts" || what === "all") st.contacts = await api.get("/express/contacts");
      if (what === "individuals") st.individuals = await api.get("/individuals");
      if (what === "config") st.config = await api.get("/express/config");
      if (what === "log") st.log = await api.get(`/express/log?limit=200${st.logErrors ? "&only_errors=true" : ""}${st.logContact ? `&contact_id=${st.logContact}` : ""}${st.logObject ? `&object_id=${st.logObject}` : ""}`);
      if (what === "chat") st.chat = await api.get(`/objects/${ctx.objectId}/express/log?days=14${st.chatContact ? `&contact_id=${st.chatContact}` : ""}`);
    } catch (e) { if (!dead) { pane.innerHTML = `<div class="hc-callout bad" role="alert">${esc(errText(e))}</div>`; } return false; }
    return !dead;
  }

  function paint() {
    if (dead) return;
    el.querySelectorAll("[data-sub]").forEach((b) => { const on = b.dataset.sub === st.sub; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const need = { schedules: ["status", "schedules", "contacts"], requests: ["requests"], chat: ["chat"], contacts: ["status", "contacts"], connection: ["config"], log: ["log"] }[st.sub];
    const missing = need.find((k) => st[k] === null);
    if (missing) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; load(missing).then((ok) => ok && paint()); return; }
    ({ schedules: paintSchedules, requests: paintRequests, chat: paintChat, contacts: paintContacts, connection: paintConnection, log: paintLog })[st.sub]();
  }

  const botCallout = () => {
    const s = st.status;
    if (!s || s.active) return "";
    return `<div class="hc-callout warn" role="status"><strong>Бот выключен или не настроен</strong> — запросы по расписанию не уходят. ${ctx.canAdmin ? "Включите его в «Администрирование → Бот eXpress»." : "Обратитесь к администратору сервиса."}</div>`;
  };
  const botName = () => esc(st.status?.bot_name || "бота");

  // =====================================================================  РАСПИСАНИЯ
  function paintSchedules() {
    const f = st.form, sf = st.sendForm;
    const activeContacts = st.contacts.filter((c) => c.active);
    const contactOptions = (sel, emptyLabel) => `${emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : ""}${activeContacts.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}`;
    pane.innerHTML = `${botCallout()}
      <div class="hc-bar"><strong>Расписания опроса</strong><span class="hc-muted">кого и когда бот спрашивает о численности по этому объекту</span>
        ${ctx.canWrite ? `<button type="button" class="hc-btn primary" id="ex-new">Добавить расписание</button><button type="button" class="hc-btn" id="ex-send-open">Спросить сейчас</button>` : ""}<button type="button" class="hc-btn" id="ex-summaries-open">Рассылка сводок…</button></div>
      ${sf ? `<form class="ex-card" id="ex-send-form"><h4>Спросить сейчас</h4><div class="ex-row">
          ${field("Кого спросить", `<select id="ex-s-contact">${contactOptions(sf.contact_id, "— выберите —")}</select>`)}
          ${field("За какой день", `<input type="date" id="ex-s-date" value="${esc(sf.date)}" max="${esc(todayIso())}">`)}</div>
        <div class="ex-actions"><button type="submit" class="hc-btn primary">Отправить</button><button type="button" class="hc-btn" id="ex-s-cancel">Отмена</button></div></form>` : ""}
      ${f ? scheduleForm(f, contactOptions) : ""}
      ${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Контакт</th><th>Дни</th><th>Отправка</th><th>Спрашиваем за</th><th>Напоминание</th><th>Следующий запуск</th><th></th></tr></thead><tbody>${
        st.schedules.length ? st.schedules.map((s) => `<tr${s.active ? "" : ' class="hc-muted"'}>
          <td>${esc(s.contact_name)}${s.contact_bound ? "" : ` <span class="hc-badge warn" title="Контакт ещё не писал боту: пока он не отправит боту /start, писать ему некуда">не писал боту</span>`}</td>
          <td style="white-space:nowrap">${daysText(s.weekdays)}</td><td class="hc-num">${esc(s.send_time)}</td>
          <td>${s.day_offset === 0 ? "сегодня" : "вчера"}</td><td class="hc-num">${esc(s.remind_time || "—")}</td>
          <td>${s.active ? esc(fmtMoment(s.next_run) || "—") : '<span class="hc-badge">приостановлено</span>'}</td>
          <td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-edit="${s.id}">Изменить</button> <button type="button" class="hc-btn danger mini" data-del="${s.id}">Удалить</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="7" class="hc-muted">Расписаний нет. Добавьте контакт на вкладке «Контакты» и заведите расписание.</td></tr>`}</tbody></table></div>
      <p class="ex-hint">Время — московское. Срок внесения численности по приказу — до 11:00. Ответ контакта попадает в «Ввод численности» с источником «бот».</p>`;
    wireSchedules();
    pane.querySelector("#ex-summaries-open")?.addEventListener("click", openSummaryWindow);
  }

  let summaryDialog = null;
  async function openSummaryWindow() {
    summaryDialog?.remove();
    const dialog = document.createElement("dialog"); summaryDialog = dialog;
    dialog.className = "hc-root ex-card ex-summary-dialog";
    dialog.setAttribute("aria-label", "Рассылка сводок по объекту");
    document.body.appendChild(dialog); dialog.showModal();
    const base = `/objects/${ctx.objectId}/express/summary-schedules`;
    let rows = [], editing = null, error = "", busy = false;
    const fresh = () => ({contact_ids:[],weekdays:[1,2,3,4,5],send_time:"12:30",day_offset:0,active:true,note:""});
    let form = fresh();
    const loadRows = async () => { rows = await api.get(base); };
    const render = () => {
      dialog.innerHTML = `<div class="hc-bar"><h3>Рассылка сводок по объекту</h3><button type="button" class="hc-btn" data-close>Закрыть</button></div>
        <p>Обе смены. Подрядчик / Примечание / Рабочие / ИТР / Механизаторы. Расписание независимо от опроса ответственных.</p>
        <p class="hc-msg bad" role="alert">${esc(error)}</p>
        <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Получатели</th><th>Дни</th><th>Время МСК</th><th>За день</th><th></th></tr></thead><tbody>${rows.map((s) => `<tr><td>${esc(s.contact_names.join(", "))}${s.active ? "" : " (приостановлено)"}</td><td>${daysText(s.weekdays)}</td><td>${esc(s.send_time)}</td><td>${s.day_offset ? "вчера" : "сегодня"}</td><td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-summary-edit="${s.id}">Изменить</button> <button type="button" class="hc-btn mini danger" data-summary-del="${s.id}">Удалить</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5">Рассылок пока нет.</td></tr>'}</tbody></table></div>
        ${ctx.canWrite ? `<form><h4>${editing ? "Изменить рассылку" : "Добавить рассылку"}</h4>
        <fieldset><legend>Получатели (можно несколько)</legend><div class="ex-row">${st.contacts.filter((c) => c.active).map((c) => `<label class="ex-check"><input type="checkbox" data-summary-contact="${c.id}" ${form.contact_ids.includes(c.id) ? "checked" : ""}>${esc(c.name)}</label>`).join("")}</div></fieldset>
        <div class="ex-row">${field("Время МСК", `<input type="time" name="time" value="${esc(form.send_time)}" required>`)}${field("За день", `<select name="offset"><option value="0" ${form.day_offset === 0 ? "selected" : ""}>Сегодня</option><option value="-1" ${form.day_offset === -1 ? "selected" : ""}>Вчера</option></select>`)}</div>
        <div class="ex-days">${DAYS.map(([d,t]) => `<label class="ex-day"><input type="checkbox" data-summary-day="${d}" ${form.weekdays.includes(d) ? "checked" : ""}>${t}</label>`).join("")}</div>
        <label class="ex-check"><input type="checkbox" name="active" ${form.active ? "checked" : ""}>Рассылка включена</label>
        <div class="ex-actions"><button type="submit" class="hc-btn primary" ${busy ? "disabled" : ""}>Сохранить рассылку</button><button type="button" class="hc-btn" data-new>Новая рассылка</button></div></form>` : ""}`;
      dialog.querySelector("[data-close]").onclick = () => {dialog.close();dialog.remove();summaryDialog=null;};
      if (ctx.canWrite) dialog.querySelector("[data-new]").onclick = () => {editing=null;form=fresh();error="";render();};
      dialog.querySelectorAll("[data-summary-edit]").forEach((b) => {b.onclick=()=>{const row=rows.find((s)=>s.id===Number(b.dataset.summaryEdit));editing=row.id;form={...row,contact_ids:[...row.contact_ids],weekdays:[...row.weekdays]};error="";render();};});
      dialog.querySelectorAll("[data-summary-del]").forEach((b) => {b.onclick=async()=>{if(busy || !(await ctx.confirm("Удалить расписание рассылки сводки?")))return;busy=true;try{await api.delete(`${base}/${b.dataset.summaryDel}`);await loadRows();}catch(e){error=errText(e);}finally{busy=false;render();}};});
      if (ctx.canWrite) dialog.querySelector("form").onsubmit=async(e)=>{
        e.preventDefault();if(busy)return;
        const node=e.currentTarget;
        form={contact_ids:[...node.querySelectorAll("[data-summary-contact]:checked")].map((n)=>Number(n.dataset.summaryContact)),weekdays:[...node.querySelectorAll("[data-summary-day]:checked")].map((n)=>Number(n.dataset.summaryDay)),send_time:node.elements.time.value,day_offset:Number(node.elements.offset.value),active:node.elements.active.checked,note:form.note || null};
        busy=true;render();
        try{if(editing)await api.patch(`${base}/${editing}`,form);else await api.post(base,form);await loadRows();editing=null;form=fresh();error="";}catch(err){error=errText(err);}finally{busy=false;render();}
      };
    };
    dialog.addEventListener("close",()=>{dialog.remove();if(summaryDialog===dialog)summaryDialog=null;});
    try{await loadRows();}catch(e){error=errText(e);}render();
  }

  function scheduleForm(f, contactOptions) {
    return `<form class="ex-card" id="ex-form"><h4>${f.id ? "Изменить расписание" : "Новое расписание"}</h4>
      <div class="ex-row">
        ${field("Кого спрашивать", `<select id="ex-f-contact">${contactOptions(f.contact_id, "— выберите —")}</select>`, "wide")}
        ${field("Время отправки (МСК)", `<input type="time" id="ex-f-time" value="${esc(f.send_time)}">`)}
        ${field("Спрашиваем за", `<select id="ex-f-offset"><option value="0" ${f.day_offset === 0 ? "selected" : ""}>сегодняшний день</option><option value="-1" ${f.day_offset === -1 ? "selected" : ""}>вчерашний день</option></select>`)}
      </div>
      <div class="ex-sec"><div class="ex-cap">Дни недели, когда бот пишет</div>
        <div class="ex-days">${DAYS.map(([n, t]) => `<label class="ex-day"><input type="checkbox" data-wd="${n}" ${f.weekdays.includes(n) ? "checked" : ""}> ${t}</label>`).join("")}
          <button type="button" class="hc-link" data-days="1,2,3,4,5">Пн–Пт</button><button type="button" class="hc-link" data-days="1,2,3,4,5,6,7">Ежедневно</button></div></div>
      <div class="ex-sec"><div class="ex-cap">Напоминание ответственному</div>
        <div class="ex-opt">${check("ex-f-remind-on", "Напомнить, если не ответил, в", !!f.remind_time)}
          <input type="time" id="ex-f-remind" value="${esc(f.remind_time || "11:30")}" aria-label="Время напоминания"></div>
        </div>
      <div class="ex-sec"><div class="ex-row">${field("Примечание", `<input type="text" id="ex-f-note" maxlength="300" value="${esc(f.note || "")}">`, "wide")}
        <div class="ex-opt">${check("ex-f-active", "Расписание действует", f.active)}</div></div></div>
      <div class="ex-actions"><button type="submit" class="hc-btn primary">${f.id ? "Сохранить" : "Добавить"}</button><button type="button" class="hc-btn" id="ex-f-cancel">Отмена</button></div>
      <p class="hc-msg ${esc(f.kind || "")}" id="ex-f-msg" role="alert">${esc(f.msg || "")}</p></form>`;
  }

  function wireSchedules() {
    pane.querySelector("#ex-new")?.addEventListener("click", () => {
      st.sendForm = null; st.form = { id: null, contact_id: "", weekdays: [1, 2, 3, 4, 5], send_time: "10:30", day_offset: 0, remind_time: "11:30", summary_time: "", summary_contact_id: "", active: true, note: "" };
      paintSchedules(); pane.querySelector("#ex-f-contact")?.focus();
    });
    pane.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const s = st.schedules.find((x) => x.id === Number(b.dataset.edit)); st.sendForm = null;
      st.form = { id: s.id, contact_id: s.contact_id, weekdays: [...s.weekdays], send_time: s.send_time, day_offset: s.day_offset, remind_time: s.remind_time || "", summary_time: s.summary_time || "", summary_contact_id: s.summary_contact_id || "", active: s.active, note: s.note || "" };
      paintSchedules(); pane.querySelector("#ex-f-contact")?.focus();
    }));
    pane.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const s = st.schedules.find((x) => x.id === Number(b.dataset.del));
      if (!(await ctx.confirm(`Удалить расписание «${s.contact_name}, ${s.send_time}»? Отправленные запросы и внесённая численность останутся.`, { danger: true }))) return;
      await guard(async () => { await api.delete(`/objects/${ctx.objectId}/express/schedules/${s.id}`); await load("schedules"); paintSchedules(); }, "Расписание удалено.");
    }));
    pane.querySelector("#ex-f-cancel")?.addEventListener("click", () => { st.form = null; paintSchedules(); });
    // Время напоминания доступно, когда включён соответствующий флажок.
    const bindToggle = (flag, ...controls) => {
      const sync = () => controls.forEach((c) => { const n = pane.querySelector(c); if (n) n.disabled = !pane.querySelector(flag).checked; });
      pane.querySelector(flag)?.addEventListener("change", sync); if (pane.querySelector(flag)) sync();
    };
    bindToggle("#ex-f-remind-on", "#ex-f-remind");
    pane.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => {
      const set = b.dataset.days.split(",").map(Number);
      pane.querySelectorAll("[data-wd]").forEach((c) => { c.checked = set.includes(Number(c.dataset.wd)); });
    }));
    pane.querySelector("#ex-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = st.form, note = pane.querySelector("#ex-f-msg");
      const body = {
        contact_id: Number(pane.querySelector("#ex-f-contact").value), send_time: pane.querySelector("#ex-f-time").value, day_offset: Number(pane.querySelector("#ex-f-offset").value),
        weekdays: [...pane.querySelectorAll("[data-wd]")].filter((c) => c.checked).map((c) => Number(c.dataset.wd)),
        remind_time: pane.querySelector("#ex-f-remind-on").checked ? pane.querySelector("#ex-f-remind").value : null,
        active: pane.querySelector("#ex-f-active").checked, note: pane.querySelector("#ex-f-note").value || null,
      };
      if (!body.contact_id) { f.msg = "Выберите контакт"; f.kind = "bad"; note.textContent = f.msg; note.className = "hc-msg bad"; return; }
      if (st.busy) return;
      st.busy = true;
      try {
        if (f.id) await api.patch(`/objects/${ctx.objectId}/express/schedules/${f.id}`, body); else await api.post(`/objects/${ctx.objectId}/express/schedules`, body);
        st.form = null; await load("schedules"); st.busy = false; paintSchedules(); setMsg("Расписание сохранено.", "ok");
      } catch (err) { f.msg = errText(err); f.kind = "bad"; note.textContent = f.msg; note.className = "hc-msg bad"; }
      finally { st.busy = false; }
    });
    pane.querySelector("#ex-send-open")?.addEventListener("click", () => { st.form = null; st.sendForm = { contact_id: "", date: todayIso() }; paintSchedules(); });
    pane.querySelector("#ex-s-cancel")?.addEventListener("click", () => { st.sendForm = null; paintSchedules(); });
    pane.querySelector("#ex-send-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const contact = Number(pane.querySelector("#ex-s-contact").value), date = pane.querySelector("#ex-s-date").value;
      if (!contact) { setMsg("Выберите, кого спросить", "bad"); return; }
      await guard(async () => {
        const r = await api.post(`/objects/${ctx.objectId}/express/send-now`, { contact_id: contact, date });
        st.sendForm = null; st.requests = null; paintSchedules();
        setMsg(r.status === "sent" ? "Запрос отправлен контакту." : `Запрос не доставлен: ${r.error || "нет связи с eXpress"}. Он повторится автоматически.`, r.status === "sent" ? "ok" : "warn");
      });
    });
  }

  // =====================================================================  ЗАПРОСЫ
  function paintRequests() {
    pane.innerHTML = `<div class="hc-bar"><strong>Запросы за 14 дней</strong><span class="hc-muted">что бот отправил и что ответили</span><button type="button" class="hc-btn" id="ex-refresh">Обновить</button></div>${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>За день</th><th>Контакт</th><th>Состояние</th><th>Отправлен</th><th class="num">Рабочие за день</th><th class="num">ИТР за день</th><th class="num">Механизаторы за день</th><th>Примечание</th></tr></thead><tbody>${
        st.requests.length ? st.requests.map((r) => { const [t, k] = STATUS[r.status] || [r.status, ""];
          return `<tr><td>${esc(fmtDate(r.work_date))}</td><td>${esc(r.contact_name)}${r.manual ? ' <span class="hc-badge">вручную</span>' : ""}</td>
            <td><span class="hc-badge ${k}">${esc(t)}</span></td><td>${esc(fmtMoment(r.sent_at))}${r.reminded_at ? '<br><span class="hc-muted">напоминали</span>' : ""}</td>
            <td class="num">${r.workers}</td><td class="num">${r.itr}</td><td class="num">${r.mech ?? 0}</td><td>${r.last_error ? `<span class="hc-muted" title="Попыток: ${r.attempts}">${esc(r.last_error)}</span>` : ""}</td></tr>`; }).join("")
        : `<tr><td colspan="7" class="hc-muted">Запросов за последние 14 дней не было.</td></tr>`}</tbody></table></div>
      <p class="ex-hint">«Рабочие», «ИТР» и «Механизаторы» — итог за день по всему объекту (вносит не только этот контакт). Подробности — на вкладке «Ввод численности» и в «Все данные» (источник «бот»).</p>`;
    pane.querySelector("#ex-refresh").addEventListener("click", async () => { st.requests = null; paint(); });
  }

  // =====================================================================  КОНТАКТЫ
  // Выданный код показывается ОДИН раз: на сервере хранится только его хэш. Пока панель открыта, код можно скопировать и передать человеку.
  function codeCard(k) {
    return `<div class="ex-card" role="status"><h4>Код привязки для «${esc(k.name)}»<small>действует ${k.hours} ч, до ${esc(fmtMoment(k.expires))} (МСК), один раз</small></h4>
      <div class="ex-row"><code style="font-size:1.5rem;letter-spacing:0.12em;font-weight:700">${esc(k.code)}</code>
        <button type="button" class="hc-btn" data-code-copy>Скопировать</button><button type="button" class="hc-btn" data-code-close>Скрыть</button></div>
      <p class="ex-hint">Передайте код человеку (например, по телефону или в SMS). Он открывает ${botName()} в eXpress и отправляет сообщение <b>/start ${esc(k.code)}</b> (можно и просто код). После этого бот может писать ему по расписанию. Код показан один раз: если потерян, выдайте новый.</p></div>`;
  }

  function contactState(c) {
    if (!c.active) return '<span class="hc-badge">отключён</span>';
    if (c.bound) return '<span class="hc-badge ok">писал боту — можно слать</span>';
    if (c.code_active) return `<span class="hc-badge warn" title="Человек отправляет боту /start КОД">ждёт привязки по коду до ${esc(fmtMoment(c.code_expires))}</span>`;
    if (c.recognized) return '<span class="hc-badge warn">найден в eXpress, ждём /start</span>';
    return '<span class="hc-badge warn">ждём первого сообщения боту</span>';
  }

  function paintContacts() {
    const f = st.contactForm;
    if (f && st.individuals === null) { load("individuals").then((ok) => ok && paintContacts()); pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    pane.innerHTML = `${botCallout()}
      <div class="hc-bar"><strong>Контакты бота</strong><span class="hc-muted">только физлица из справочника; общий список для всех объектов</span>
        ${ctx.canWrite ? `<button type="button" class="hc-btn primary" id="ex-c-new">Добавить контакт</button>` : ""}<button type="button" class="hc-btn" id="ex-c-refresh">Обновить</button></div>
      <div class="hc-callout">Чтобы бот мог писать человеку, тот должен <strong>один раз открыть ${botName()} в eXpress и отправить /start</strong>. Бот опознает его по доменному логину (или по e-mail, если нажать «Найти в eXpress»). Если у человека нет ни доменного логина, ни e-mail в eXpress (внешний пользователь), нажмите <strong>«Код привязки»</strong>: он отправляет боту <code>/start КОД</code>.</div>
      ${f ? `<form class="ex-card" id="ex-c-form"><h4>${f.id ? "Изменить контакт" : "Новый контакт"}</h4>
        <div class="ex-row">
          ${field("Физлицо из справочника", `<select id="ex-c-ind" required><option value="">— выберите физлицо —</option>${(st.individuals || []).map((i) => `<option value="${i.id}" ${String(f.individual_id) === String(i.id) ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select>`, "wide")}</div>
        <p class="ex-hint">Контакт выбирается только из справочника физлиц: по физлицу бот находит строки (подрядчик + вид работ), где человек назначен ответственным. Нет человека в списке — сначала добавьте его в «Справочники → Физлица».</p>
        <div class="ex-sec"><div class="ex-cap">Как найти человека в eXpress</div><div class="ex-row">
          ${field("E-mail в eXpress", `<input type="text" id="ex-c-email" maxlength="200" value="${esc(f.email)}">`)}
          ${field("Доменный логин", `<input type="text" id="ex-c-login" maxlength="100" value="${esc(f.ad_login)}" placeholder="ivanov">`)}
          ${field("Телефон (справочно)", `<input type="text" id="ex-c-phone" maxlength="30" value="${esc(f.phone)}" placeholder="+7 900 000-00-00">`)}</div>
          <p class="ex-hint">Телефон нужен, чтобы позвонить и передать код привязки. По нему бот человека не опознаёт: eXpress номер боту не присылает.</p></div>
        <div class="ex-sec"><div class="ex-opt">${check("ex-c-active", "Контакт действует", f.active)}</div></div>
        <div class="ex-actions"><button type="submit" class="hc-btn primary">${f.id ? "Сохранить" : "Добавить"}</button><button type="button" class="hc-btn" id="ex-c-cancel">Отмена</button></div>
        <p class="hc-msg ${esc(f.kind || "")}" id="ex-c-msg" role="alert">${esc(f.msg || "")}</p></form>` : ""}
      ${st.codeShown ? codeCard(st.codeShown) : ""}
      ${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Контакт</th><th>E-mail</th><th>Логин</th><th>Телефон</th><th>Связь с eXpress</th><th class="num">Расписаний</th><th></th></tr></thead><tbody>${
        st.contacts.length ? st.contacts.map((c) => `<tr${c.active ? "" : ' class="hc-muted"'}><td>${esc(c.name)}${c.individual_id ? "" : ' <span class="hc-badge warn" title="Контакт заведён не из справочника физлиц. Откройте «Изменить» и выберите физлицо, иначе бот не знает, за какие строки его спрашивать.">не из справочника</span>'}</td>
          <td>${esc(c.email || "—")}</td><td>${esc(c.ad_login || "—")}</td><td style="white-space:nowrap">${esc(c.phone || "—")}</td><td>${contactState(c)}</td><td class="num">${c.schedules ?? 0}</td>
          <td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-c-edit="${c.id}">Изменить</button> ${c.email && !c.recognized ? `<button type="button" class="hc-btn mini" data-c-look="${c.id}" title="Найти этого человека в eXpress по e-mail">Найти в eXpress</button> ` : ""}${c.active ? `<button type="button" class="hc-btn mini" data-c-code="${c.id}" title="Одноразовый код: человек отправляет боту /start КОД">Код привязки</button> ` : ""}` : ""}${ctx.canAdmin ? `<button type="button" class="hc-btn danger mini" data-c-del="${c.id}">Удалить</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="7" class="hc-muted">Контактов нет.</td></tr>`}</tbody></table></div>`;
    pane.querySelector("#ex-c-refresh")?.addEventListener("click", () => { st.contacts = null; paint(); });
    pane.querySelector("#ex-c-new")?.addEventListener("click", () => { st.contactForm = { id: null, individual_id: "", name: "", email: "", ad_login: "", phone: "", active: true }; paintContacts(); pane.querySelector("#ex-c-ind")?.focus(); });
    pane.querySelectorAll("[data-c-edit]").forEach((b) => b.addEventListener("click", () => {
      const c = st.contacts.find((x) => x.id === Number(b.dataset.cEdit));
      st.contactForm = { id: c.id, individual_id: c.individual_id || "", name: c.name, email: c.email || "", ad_login: c.ad_login || "", phone: c.phone || "", active: c.active }; paintContacts();
    }));
    pane.querySelectorAll("[data-c-code]").forEach((b) => b.addEventListener("click", () => guard(async () => {
      const c = st.contacts.find((x) => x.id === Number(b.dataset.cCode));
      const r = await api.post(`/express/contacts/${c.id}/bind-code`, {});
      st.codeShown = { name: c.name, code: r.code, expires: r.expires, hours: r.hours };
      await load("contacts"); paintContacts();
    })));
    pane.querySelector("[data-code-close]")?.addEventListener("click", () => { st.codeShown = null; paintContacts(); });
    pane.querySelector("[data-code-copy]")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(st.codeShown.code); setMsg("Код скопирован.", "ok"); } catch (e) { setMsg("Не удалось скопировать: выделите код и скопируйте вручную.", "warn"); }
    });
    pane.querySelectorAll("[data-c-look]").forEach((b) => b.addEventListener("click", () => guard(async () => {
      const r = await api.post(`/express/contacts/${b.dataset.cLook}/lookup`, {}); await load("contacts"); paintContacts();
      setMsg(`Найден в eXpress: ${r.express_name || r.name}. Теперь ему достаточно отправить боту /start.`, "ok");
    })));
    pane.querySelectorAll("[data-c-del]").forEach((b) => b.addEventListener("click", async () => {
      const c = st.contacts.find((x) => x.id === Number(b.dataset.cDel));
      if (!(await ctx.confirm(`Удалить контакт «${c.name}»? Его расписания (${c.schedules ?? 0}) и запросы тоже удалятся; внесённая им численность останется.`, { danger: true }))) return;
      await guard(async () => { await api.delete(`/express/contacts/${c.id}`); st.contacts = null; st.schedules = null; st.requests = null; paint(); }, "Контакт удалён.");
    }));
    pane.querySelector("#ex-c-cancel")?.addEventListener("click", () => { st.contactForm = null; paintContacts(); });
    pane.querySelector("#ex-c-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = st.contactForm, note = pane.querySelector("#ex-c-msg");
      const body = { individual_id: pane.querySelector("#ex-c-ind").value ? Number(pane.querySelector("#ex-c-ind").value) : null,
        email: pane.querySelector("#ex-c-email").value || null, ad_login: pane.querySelector("#ex-c-login").value || null, phone: pane.querySelector("#ex-c-phone").value || null, active: pane.querySelector("#ex-c-active").checked };
      if (st.busy) return;
      st.busy = true;
      try {
        if (form.id) await api.patch(`/express/contacts/${form.id}`, body); else await api.post("/express/contacts", body);
        st.contactForm = null; await load("contacts"); st.schedules = null; st.busy = false; paintContacts(); setMsg("Контакт сохранён.", "ok");
      } catch (err) { Object.assign(form, { ...body, individual_id: body.individual_id ?? "", email: body.email || "", ad_login: body.ad_login || "", phone: body.phone || "", msg: errText(err), kind: "bad" }); note.textContent = form.msg; note.className = "hc-msg bad"; }
      finally { st.busy = false; }
    });
  }

  // =====================================================================  ПОДКЛЮЧЕНИЕ (администратор)
  function paintConnection() {
    const c = st.config;
    pane.innerHTML = `<div class="hc-bar"><strong>Подключение к eXpress</strong><span class="hc-muted">один бот на весь сервис; ключ хранится не в базе, а в файле рядом с ней</span></div>
      <div class="hc-callout">Адрес бота для регистрации в eXpress (CTS обращается по нему на <code>/command</code>, <code>/status</code>, <code>/notification/callback</code>):
        <strong>${esc(location.origin)}</strong>. Для тестового и боевого серверов адреса разные — бот регистрируется отдельно на каждом.</div>
      <form class="ex-card" id="ex-conn"><h4>Сервер и бот</h4>
        <div class="ex-row">${field("Адрес сервера eXpress (CTS)", `<input type="text" id="ex-k-url" value="${esc(c.cts_url)}" placeholder="https://cts.example.ru">`, "wide")}</div>
        <div class="ex-sec"><div class="ex-row">
          ${field("Идентификатор бота (UUID)", `<input type="text" id="ex-k-id" value="${esc(c.bot_id)}">`, "wide")}
          ${field("Имя бота", `<input type="text" id="ex-k-name" value="${esc(c.bot_name)}" maxlength="80" placeholder="pm_bot">`)}</div></div>
        <div class="ex-sec"><div class="ex-cap">Режим работы</div>
          <div class="ex-opt-text">${check("ex-k-on", "Бот включён", c.enabled)}<p class="ex-hint">расписания срабатывают, входящие сообщения обрабатываются</p></div>
          <div class="ex-opt-text" style="margin-top:.5rem">${check("ex-k-tls", "Проверять сертификат сервера eXpress", c.verify_tls)}<p class="ex-hint">выключайте, только если сертификат выдан внутренним удостоверяющим центром, которого нет на сервере</p></div></div>
        <div class="ex-actions"><button type="submit" class="hc-btn primary">Сохранить</button><button type="button" class="hc-btn" id="ex-k-test">Проверить связь</button></div></form>
      <form class="ex-card" id="ex-key"><h4>Ключ бота <span class="hc-badge ${c.secret_configured ? "ok" : "warn"}">${c.secret_configured ? "задан" : "не задан"}</span></h4>
        <div class="ex-row">${field("Секретный ключ", `<input type="password" id="ex-key-in" autocomplete="off" placeholder="${c.secret_configured ? "задан — введите новый, чтобы заменить" : "не задан"}">`, "wide")}</div>
        <div class="ex-actions"><button type="submit" class="hc-btn primary">Сохранить ключ</button>${c.secret_configured ? `<button type="button" class="hc-btn danger" id="ex-key-del">Удалить ключ</button>` : ""}</div></form>
      ${msgLine()}`;
    // Ключ и подключение — две формы на одной странице: после сохранения ключа поля подключения, ещё не сохранённые, пропадать не должны
    const captureConn = () => Object.assign(st.config, { cts_url: pane.querySelector("#ex-k-url").value, bot_id: pane.querySelector("#ex-k-id").value,
      bot_name: pane.querySelector("#ex-k-name").value, verify_tls: pane.querySelector("#ex-k-tls").checked, enabled: pane.querySelector("#ex-k-on").checked });
    pane.querySelector("#ex-conn").addEventListener("submit", (e) => {
      e.preventDefault();
      guard(async () => {
        st.config = await api.put("/express/config", { enabled: pane.querySelector("#ex-k-on").checked, cts_url: pane.querySelector("#ex-k-url").value, bot_id: pane.querySelector("#ex-k-id").value,
          bot_name: pane.querySelector("#ex-k-name").value, verify_tls: pane.querySelector("#ex-k-tls").checked });
        st.status = null; paintConnection();
      }, "Подключение сохранено.");
    });
    // «Проверить связь» берёт сохранённое на сервере, поэтому сначала сохраняем то, что введено в полях (и ключ, если его только что набрали)
    pane.querySelector("#ex-k-test").addEventListener("click", () => guard(async () => {
      const keyInput = pane.querySelector("#ex-key-in");
      if (keyInput.value.trim()) { await api.put("/express/key", { key: keyInput.value }); keyInput.value = ""; st.config.secret_configured = true; }
      st.config = await api.put("/express/config", { enabled: pane.querySelector("#ex-k-on").checked, cts_url: pane.querySelector("#ex-k-url").value, bot_id: pane.querySelector("#ex-k-id").value,
        bot_name: pane.querySelector("#ex-k-name").value, verify_tls: pane.querySelector("#ex-k-tls").checked });
      st.status = null; paintConnection();
      try { const r = await api.post("/express/test", {}); setMsg(`Подключение сохранено. Связь есть: сервер ${r.cts_url} принял бота (авторизация: ${r.auth === "v2" ? "JWT v2" : "токен v1"}).`, "ok"); }
      catch (e) { setMsg(`Подключение сохранено. ${errText(e)}`, "bad"); }
    }));
    pane.querySelector("#ex-key").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = pane.querySelector("#ex-key-in");
      if (!input.value.trim()) { setMsg("Введите ключ", "bad"); return; }
      guard(async () => { await api.put("/express/key", { key: input.value }); input.value = ""; captureConn(); st.config.secret_configured = true; st.status = null; paintConnection(); }, "Ключ сохранён. Он хранится только в файле на сервере и больше нигде не показывается.");
    });
    pane.querySelector("#ex-key-del")?.addEventListener("click", async () => {
      if (!(await ctx.confirm("Удалить ключ бота? Бот будет выключен и перестанет отвечать, пока ключ не введут снова.", { danger: true }))) return;
      guard(async () => { await api.delete("/express/key"); captureConn(); Object.assign(st.config, { secret_configured: false, enabled: false }); st.status = null; paintConnection(); }, "Ключ удалён, бот выключен.");
    });
  }

  // =====================================================================  ПЕРЕПИСКА ПО ОБЪЕКТУ
  // Только записи запросов ЭТОГО объекта: что бот отправил контактам и что они ответили. Служебное и другие объекты сюда не попадают.
  const dayText = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
  const dirMark = (d) => (d === "out" ? "→ бот" : d === "in" ? "← контакт" : "·");
  const resultCell = (r) => (r.ok ? '<span class="hc-badge ok">ок</span>' : `<span class="hc-badge bad" title="${esc(r.error || "")}">ошибка</span> <span class="hc-muted">${esc(r.error || "")}</span>`);
  function paintChat() {
    const C = st.chat;
    pane.innerHTML = `<div class="hc-bar ex-filters"><strong>Переписка бота по этому объекту</strong><span class="hc-muted">за 14 дней, ${C.items.length} записей</span>
      ${field("Контакт", `<select id="ex-c-contact"><option value="">все контакты</option>${C.contacts.map((c) => `<option value="${c.id}" ${String(st.chatContact) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`)}
      <button type="button" class="hc-btn" id="ex-c-refresh">Обновить</button></div>${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Когда</th><th>За день</th><th>Контакт</th><th>Кто</th><th>Текст</th><th>Результат</th></tr></thead><tbody>${
        C.items.length ? C.items.map((r) => `<tr><td class="hc-num">${esc(fmtMoment(r.at))}</td><td class="hc-num">${esc(dayText(r.work_date))}</td><td>${esc(r.contact_name || "—")}</td><td>${dirMark(r.direction)}</td>
          <td style="white-space:pre-wrap">${esc(r.text || "")}</td><td>${resultCell(r)}</td></tr>`).join("")
        : `<tr><td colspan="6" class="hc-muted">Переписки по этому объекту нет.</td></tr>`}</tbody></table></div>
      <p class="ex-hint">Здесь только обмен по запросам этого объекта. Весь обмен по людям и объектам — у администратора, «Администрирование → Бот eXpress → Журнал обмена».</p>`;
    pane.querySelector("#ex-c-refresh").addEventListener("click", () => { st.chat = null; paint(); });
    pane.querySelector("#ex-c-contact").addEventListener("change", (e) => { st.chatContact = e.target.value; st.chat = null; paint(); });
  }

  // =====================================================================  ЖУРНАЛ ОБМЕНА (администратор)
  // Весь обмен в разрезе людей и объектов: отбор по контакту и по объекту; объект записи — объект её запроса
  function paintLog() {
    const L = st.log, F = L.facets || { contacts: [], objects: [] };
    const opts = (items, sel, all) => `<option value="">${all}</option>${items.map((x) => `<option value="${x.id}" ${String(sel) === String(x.id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}`;
    pane.innerHTML = `<div class="hc-bar ex-filters"><strong>Журнал обмена с eXpress</strong><span class="hc-muted">последние ${L.items.length} из ${L.total}</span>
      ${field("Человек", `<select id="ex-l-contact">${opts(F.contacts, st.logContact, "все люди")}</select>`)}
      ${field("Объект", `<select id="ex-l-object">${opts(F.objects, st.logObject, "все объекты")}</select>`)}
      ${check("ex-l-err", "только ошибки", st.logErrors)}<button type="button" class="hc-btn" id="ex-l-refresh">Обновить</button></div>${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Когда</th><th></th><th>Что</th><th>Человек</th><th>Объект</th><th>За день</th><th>Текст</th><th>Результат</th></tr></thead><tbody>${
        L.items.length ? L.items.map((r) => `<tr><td class="hc-num">${esc(fmtMoment(r.at))}</td><td>${r.direction === "out" ? "→" : r.direction === "in" ? "←" : "·"}</td><td>${esc(r.kind || "")}</td>
          <td>${esc(r.contact_name || "—")}</td><td>${esc(r.object_name || "—")}</td><td class="hc-num">${esc(dayText(r.work_date))}</td><td style="white-space:pre-wrap">${esc(r.text || "")}</td><td>${resultCell(r)}</td></tr>`).join("")
        : `<tr><td colspan="8" class="hc-muted">Записей нет.</td></tr>`}</tbody></table></div>
      <p class="ex-hint">Записи старше 90 дней удаляются автоматически. Незнакомые отправители бота видны здесь строкой «отправитель не в списке контактов» — по их логину можно завести контакт. Служебные записи (проверка связи, чужие отправители) и записи, сделанные до 2026-10-28 у входящих сообщений, объекта не имеют.</p>`;
    pane.querySelector("#ex-l-refresh").addEventListener("click", () => { st.log = null; paint(); });
    pane.querySelector("#ex-l-err").addEventListener("change", (e) => { st.logErrors = e.target.checked; st.log = null; paint(); });
    pane.querySelector("#ex-l-contact").addEventListener("change", (e) => { st.logContact = e.target.value; st.log = null; paint(); });
    pane.querySelector("#ex-l-object").addEventListener("change", (e) => { st.logObject = e.target.value; st.log = null; paint(); });
  }

  paint();
  return { destroy() { summaryDialog?.remove(); dead = true; el.innerHTML = ""; } };
}
