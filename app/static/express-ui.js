// Бот eXpress — вкладка «Бот eXpress» общего экрана численности для V1 и V2 (2026-10-23, Docs/express-bot.md).
//
// Бот по расписанию пишет выбранному контакту в eXpress и спрашивает численность по объекту; ответ попадает в систему с источником «бот».
// Модуль ОБЩИЙ с V1/V2 (как headcount-ui.js, чьи стили и классы `hc-*` он использует) и грузится лениво из вкладки. Транспорт и права
// передаются явно: ctx = { api, objectId, canWrite, canAdmin, confirm, sub, onSub }.
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
const SUBS = [["schedules", "Расписания"], ["requests", "Запросы и ответы"], ["contacts", "Контакты"]];
const SUBS_ADMIN = [["connection", "Подключение"], ["log", "Журнал обмена"]];

export function mountExpress(el, ctx) {
  const { api } = ctx;
  let dead = false;
  const subs = SUBS.concat(ctx.canAdmin ? SUBS_ADMIN : []);
  const st = {
    sub: subs.some(([k]) => k === ctx.sub) ? ctx.sub : "schedules", status: null, schedules: null, requests: null, contacts: null, individuals: null,
    form: null, contactForm: null, sendForm: null, config: null, log: null, logErrors: false, msg: "", msgKind: "", busy: false,
  };
  el.innerHTML = `<div class="hc-bar" role="tablist" aria-label="Разделы бота eXpress">${subs.map(([k, t]) => `<button type="button" class="hc-btn" data-sub="${k}">${esc(t)}</button>`).join("")}</div><div id="ex-pane"></div>`;
  const pane = el.querySelector("#ex-pane");
  el.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () => { st.sub = b.dataset.sub; st.msg = ""; ctx.onSub?.(st.sub); paint(); }));
  const setMsg = (t, kind = "") => { st.msg = t; st.msgKind = kind; const n = pane.querySelector("#ex-msg"); if (n) { n.textContent = t; n.className = `hc-msg ${kind}`; } };
  const msgLine = () => `<p id="ex-msg" class="hc-msg ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>`;
  const guard = async (fn, okText) => {
    if (st.busy) return;
    st.busy = true;
    try { const r = await fn(); if (okText) setMsg(okText, "ok"); return r; }
    catch (e) { setMsg(errText(e), "bad"); }
    finally { st.busy = false; }
  };

  async function load(what) {
    try {
      if (what === "status" || what === "all") st.status = await api.get("/express/status");
      if (what === "schedules" || what === "all") st.schedules = await api.get(`/objects/${ctx.objectId}/express/schedules`);
      if (what === "requests" || what === "all") st.requests = await api.get(`/objects/${ctx.objectId}/express/requests?days=14`);
      if (what === "contacts" || what === "all") st.contacts = await api.get("/express/contacts");
      if (what === "individuals") st.individuals = await api.get("/individuals");
      if (what === "config") st.config = await api.get("/express/config");
      if (what === "log") st.log = await api.get(`/express/log?limit=100${st.logErrors ? "&only_errors=true" : ""}`);
    } catch (e) { if (!dead) { pane.innerHTML = `<div class="hc-callout bad" role="alert">${esc(errText(e))}</div>`; } return false; }
    return !dead;
  }

  function paint() {
    if (dead) return;
    el.querySelectorAll("[data-sub]").forEach((b) => { const on = b.dataset.sub === st.sub; b.classList.toggle("primary", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const need = { schedules: ["status", "schedules", "contacts"], requests: ["requests"], contacts: ["status", "contacts"], connection: ["config"], log: ["log"] }[st.sub];
    const missing = need.find((k) => st[k] === null);
    if (missing) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; load(missing).then((ok) => ok && paint()); return; }
    ({ schedules: paintSchedules, requests: paintRequests, contacts: paintContacts, connection: paintConnection, log: paintLog })[st.sub]();
  }

  const botCallout = () => {
    const s = st.status;
    if (!s) return "";
    if (s.active) return "";
    return `<div class="hc-callout warn" role="status"><strong>Бот выключен или не настроен</strong> — запросы по расписанию не уходят. ${ctx.canAdmin ? "Включите его на вкладке «Подключение»." : "Обратитесь к администратору сервиса."}</div>`;
  };
  const botName = () => esc(st.status?.bot_name || "бота");

  // =====================================================================  РАСПИСАНИЯ
  function paintSchedules() {
    const f = st.form, sf = st.sendForm;
    const activeContacts = st.contacts.filter((c) => c.active);
    const contactOptions = (sel, emptyLabel) => `${emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : ""}${activeContacts.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}`;
    pane.innerHTML = `${botCallout()}
      <div class="hc-bar"><strong>Расписания опроса</strong><span class="hc-muted">кого и когда бот спрашивает о численности по этому объекту</span>
        ${ctx.canWrite ? `<button type="button" class="hc-btn primary" id="ex-new">Добавить расписание</button><button type="button" class="hc-btn" id="ex-send-open">Спросить сейчас</button>` : ""}</div>
      ${sf ? `<form class="hc-form" id="ex-send-form"><label>Кого спросить<select id="ex-s-contact">${contactOptions(sf.contact_id, "— выберите —")}</select></label>
        <label>За какой день<input type="date" id="ex-s-date" value="${esc(sf.date)}" max="${esc(todayIso())}"></label>
        <button type="submit" class="hc-btn primary">Отправить</button><button type="button" class="hc-btn" id="ex-s-cancel">Отмена</button></form>` : ""}
      ${f ? scheduleForm(f, contactOptions) : ""}
      ${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Контакт</th><th>Дни</th><th>Отправка</th><th>Спрашиваем за</th><th>Напоминание</th><th>Сводка</th><th>Следующий запуск</th><th></th></tr></thead><tbody>${
        st.schedules.length ? st.schedules.map((s) => `<tr${s.active ? "" : ' class="hc-muted"'}>
          <td>${esc(s.contact_name)}${s.contact_bound ? "" : ` <span class="hc-badge warn" title="Контакт ещё не писал боту: пока он не отправит боту /start, писать ему некуда">не писал боту</span>`}</td>
          <td style="white-space:nowrap">${daysText(s.weekdays)}</td><td class="hc-num">${esc(s.send_time)}</td>
          <td>${s.day_offset === 0 ? "сегодня" : "вчера"}</td><td class="hc-num">${esc(s.remind_time || "—")}</td>
          <td>${s.summary_time ? `${esc(s.summary_time)} → ${esc(s.summary_contact_name || "—")}` : "—"}</td>
          <td>${s.active ? esc(fmtMoment(s.next_run) || "—") : '<span class="hc-badge">приостановлено</span>'}</td>
          <td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-edit="${s.id}">Изменить</button> <button type="button" class="hc-btn danger mini" data-del="${s.id}">Удалить</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="8" class="hc-muted">Расписаний нет. Добавьте контакт на вкладке «Контакты» и заведите расписание.</td></tr>`}</tbody></table></div>
      <p class="hc-muted">Время — московское. Срок внесения численности по приказу — до 11:00. Ответ контакта попадает в «Ввод численности» с источником «бот».</p>`;
    wireSchedules();
  }

  function scheduleForm(f, contactOptions) {
    return `<form class="hc-form" id="ex-form"><div class="hc-form-grid">
      <label>Кого спрашивать<select id="ex-f-contact">${contactOptions(f.contact_id, "— выберите —")}</select></label>
      <label>Время отправки (МСК)<input type="time" id="ex-f-time" value="${esc(f.send_time)}"></label>
      <label>Спрашиваем за<select id="ex-f-offset"><option value="0" ${f.day_offset === 0 ? "selected" : ""}>сегодняшний день</option><option value="-1" ${f.day_offset === -1 ? "selected" : ""}>вчерашний день</option></select></label>
      <div class="hc-span2"><span class="hc-muted">Дни недели, когда бот пишет</span><br>${DAYS.map(([n, t]) => `<label class="hc-check-inline"><input type="checkbox" data-wd="${n}" ${f.weekdays.includes(n) ? "checked" : ""}> ${t}</label>`).join(" ")}</div>
      <label class="hc-check-inline"><input type="checkbox" id="ex-f-remind-on" ${f.remind_time ? "checked" : ""}> Напомнить, если не ответил, в <input type="time" id="ex-f-remind" value="${esc(f.remind_time || "11:30")}"></label>
      <label class="hc-check-inline"><input type="checkbox" id="ex-f-sum-on" ${f.summary_time ? "checked" : ""}> Отправить сводку в <input type="time" id="ex-f-sum" value="${esc(f.summary_time || "12:30")}"></label>
      <label>Кому сводка<select id="ex-f-sum-contact">${contactOptions(f.summary_contact_id, "— выберите —")}</select></label>
      <label class="hc-check-inline"><input type="checkbox" id="ex-f-active" ${f.active ? "checked" : ""}> Расписание действует</label>
      <label class="hc-span2">Примечание<input type="text" id="ex-f-note" maxlength="300" value="${esc(f.note || "")}"></label></div>
      <button type="submit" class="hc-btn primary">${f.id ? "Сохранить" : "Добавить"}</button><button type="button" class="hc-btn" id="ex-f-cancel">Отмена</button>
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
    pane.querySelector("#ex-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = st.form, note = pane.querySelector("#ex-f-msg");
      const body = {
        contact_id: Number(pane.querySelector("#ex-f-contact").value), send_time: pane.querySelector("#ex-f-time").value, day_offset: Number(pane.querySelector("#ex-f-offset").value),
        weekdays: [...pane.querySelectorAll("[data-wd]")].filter((c) => c.checked).map((c) => Number(c.dataset.wd)),
        remind_time: pane.querySelector("#ex-f-remind-on").checked ? pane.querySelector("#ex-f-remind").value : null,
        summary_time: pane.querySelector("#ex-f-sum-on").checked ? pane.querySelector("#ex-f-sum").value : null,
        summary_contact_id: pane.querySelector("#ex-f-sum-contact").value ? Number(pane.querySelector("#ex-f-sum-contact").value) : null,
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
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>За день</th><th>Контакт</th><th>Состояние</th><th>Отправлен</th><th class="num">Рабочие за день</th><th class="num">ИТР за день</th><th>Примечание</th></tr></thead><tbody>${
        st.requests.length ? st.requests.map((r) => { const [t, k] = STATUS[r.status] || [r.status, ""];
          return `<tr><td>${esc(fmtDate(r.work_date))}</td><td>${esc(r.contact_name)}${r.manual ? ' <span class="hc-badge">вручную</span>' : ""}</td>
            <td><span class="hc-badge ${k}">${esc(t)}</span></td><td>${esc(fmtMoment(r.sent_at))}${r.reminded_at ? '<br><span class="hc-muted">напоминали</span>' : ""}</td>
            <td class="num">${r.workers}</td><td class="num">${r.itr}</td><td>${r.last_error ? `<span class="hc-muted" title="Попыток: ${r.attempts}">${esc(r.last_error)}</span>` : ""}</td></tr>`; }).join("")
        : `<tr><td colspan="7" class="hc-muted">Запросов за последние 14 дней не было.</td></tr>`}</tbody></table></div>
      <p class="hc-muted">«Рабочие» и «ИТР» — итог за день по всему объекту (вносит не только этот контакт). Подробности — на вкладке «Ввод численности» и в «Все данные» (источник «бот»).</p>`;
    pane.querySelector("#ex-refresh").addEventListener("click", async () => { st.requests = null; paint(); });
  }

  // =====================================================================  КОНТАКТЫ
  function contactState(c) {
    if (!c.active) return '<span class="hc-badge">отключён</span>';
    if (c.bound) return '<span class="hc-badge ok">писал боту — можно слать</span>';
    if (c.recognized) return '<span class="hc-badge warn">найден в eXpress, ждём /start</span>';
    return '<span class="hc-badge warn">ждём первого сообщения боту</span>';
  }

  function paintContacts() {
    const f = st.contactForm;
    if (f && st.individuals === null) { load("individuals").then((ok) => ok && paintContacts()); pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    pane.innerHTML = `${botCallout()}
      <div class="hc-bar"><strong>Контакты бота</strong><span class="hc-muted">физлицо из справочника или произвольный человек; общий список для всех объектов</span>
        ${ctx.canWrite ? `<button type="button" class="hc-btn primary" id="ex-c-new">Добавить контакт</button>` : ""}</div>
      <div class="hc-callout">Чтобы бот мог писать человеку, тот должен <strong>один раз открыть ${botName()} в eXpress и отправить /start</strong>. Бот опознает его по доменному логину (или по e-mail, если нажать «Найти в eXpress»).</div>
      ${f ? `<form class="hc-form" id="ex-c-form"><div class="hc-form-grid">
        <label>Физлицо из справочника<select id="ex-c-ind"><option value="">— произвольный контакт —</option>${(st.individuals || []).map((i) => `<option value="${i.id}" ${String(f.individual_id) === String(i.id) ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></label>
        <label>Имя (ФИО)<input type="text" id="ex-c-name" maxlength="200" value="${esc(f.name)}" placeholder="если выбрано физлицо — можно не заполнять"></label>
        <label>E-mail в eXpress<input type="text" id="ex-c-email" maxlength="200" value="${esc(f.email)}"></label>
        <label>Доменный логин<input type="text" id="ex-c-login" maxlength="100" value="${esc(f.ad_login)}" placeholder="ivanov"></label>
        <label class="hc-check-inline"><input type="checkbox" id="ex-c-active" ${f.active ? "checked" : ""}> Контакт действует</label></div>
        <button type="submit" class="hc-btn primary">${f.id ? "Сохранить" : "Добавить"}</button><button type="button" class="hc-btn" id="ex-c-cancel">Отмена</button>
        <p class="hc-msg ${esc(f.kind || "")}" id="ex-c-msg" role="alert">${esc(f.msg || "")}</p></form>` : ""}
      ${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Контакт</th><th>E-mail</th><th>Логин</th><th>Связь с eXpress</th><th class="num">Расписаний</th><th></th></tr></thead><tbody>${
        st.contacts.length ? st.contacts.map((c) => `<tr${c.active ? "" : ' class="hc-muted"'}><td>${esc(c.name)}${c.individual_id ? "" : ' <span class="hc-badge">произвольный</span>'}</td>
          <td>${esc(c.email || "—")}</td><td>${esc(c.ad_login || "—")}</td><td>${contactState(c)}</td><td class="num">${c.schedules ?? 0}</td>
          <td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-c-edit="${c.id}">Изменить</button> ${c.email && !c.recognized ? `<button type="button" class="hc-btn mini" data-c-look="${c.id}" title="Найти этого человека в eXpress по e-mail">Найти в eXpress</button> ` : ""}` : ""}${ctx.canAdmin ? `<button type="button" class="hc-btn danger mini" data-c-del="${c.id}">Удалить</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="6" class="hc-muted">Контактов нет.</td></tr>`}</tbody></table></div>`;
    pane.querySelector("#ex-c-new")?.addEventListener("click", () => { st.contactForm = { id: null, individual_id: "", name: "", email: "", ad_login: "", active: true }; paintContacts(); pane.querySelector("#ex-c-ind")?.focus(); });
    pane.querySelectorAll("[data-c-edit]").forEach((b) => b.addEventListener("click", () => {
      const c = st.contacts.find((x) => x.id === Number(b.dataset.cEdit));
      st.contactForm = { id: c.id, individual_id: c.individual_id || "", name: c.name, email: c.email || "", ad_login: c.ad_login || "", active: c.active }; paintContacts();
    }));
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
    pane.querySelector("#ex-c-ind")?.addEventListener("change", (e) => {
      const i = (st.individuals || []).find((x) => String(x.id) === e.target.value), name = pane.querySelector("#ex-c-name");
      if (i && !name.value.trim()) name.value = i.name;
    });
    pane.querySelector("#ex-c-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = st.contactForm, note = pane.querySelector("#ex-c-msg");
      const body = { individual_id: pane.querySelector("#ex-c-ind").value ? Number(pane.querySelector("#ex-c-ind").value) : null, name: pane.querySelector("#ex-c-name").value || null,
        email: pane.querySelector("#ex-c-email").value || null, ad_login: pane.querySelector("#ex-c-login").value || null, active: pane.querySelector("#ex-c-active").checked };
      if (st.busy) return;
      st.busy = true;
      try {
        if (form.id) await api.patch(`/express/contacts/${form.id}`, body); else await api.post("/express/contacts", body);
        st.contactForm = null; await load("contacts"); st.schedules = null; st.busy = false; paintContacts(); setMsg("Контакт сохранён.", "ok");
      } catch (err) { Object.assign(form, { ...body, individual_id: body.individual_id ?? "", name: body.name || "", email: body.email || "", ad_login: body.ad_login || "", msg: errText(err), kind: "bad" }); note.textContent = form.msg; note.className = "hc-msg bad"; }
      finally { st.busy = false; }
    });
  }

  // =====================================================================  ПОДКЛЮЧЕНИЕ (администратор)
  function paintConnection() {
    const c = st.config;
    pane.innerHTML = `<div class="hc-bar"><strong>Подключение к eXpress</strong><span class="hc-muted">один бот на весь сервис; ключ хранится не в базе, а в файле рядом с ней</span></div>
      <div class="hc-callout">Адрес бота для регистрации в eXpress (CTS обращается по нему на <code>/command</code>, <code>/status</code>, <code>/notification/callback</code>):
        <strong>${esc(location.origin)}</strong>. Для тестового и боевого серверов адреса разные — бот регистрируется отдельно на каждом.</div>
      <form class="hc-form" id="ex-conn"><div class="hc-form-grid">
        <label class="hc-span2">Адрес сервера eXpress (CTS)<input type="text" id="ex-k-url" value="${esc(c.cts_url)}" placeholder="https://cts.example.ru"></label>
        <label>Идентификатор бота (UUID)<input type="text" id="ex-k-id" value="${esc(c.bot_id)}"></label>
        <label>Имя бота<input type="text" id="ex-k-name" value="${esc(c.bot_name)}" maxlength="80" placeholder="pm_bot"></label>
        <label class="hc-check-inline"><input type="checkbox" id="ex-k-tls" ${c.verify_tls ? "checked" : ""}> Проверять сертификат сервера eXpress</label>
        <label class="hc-check-inline"><input type="checkbox" id="ex-k-on" ${c.enabled ? "checked" : ""}> Бот включён (расписания работают, входящие обрабатываются)</label></div>
        <button type="submit" class="hc-btn primary">Сохранить</button><button type="button" class="hc-btn" id="ex-k-test">Проверить связь</button></form>
      <form class="hc-form" id="ex-key"><label>Ключ бота (секрет)<input type="password" id="ex-key-in" autocomplete="off" placeholder="${c.secret_configured ? "задан — введите новый, чтобы заменить" : "не задан"}"></label>
        <button type="submit" class="hc-btn primary">Сохранить ключ</button>${c.secret_configured ? `<button type="button" class="hc-btn danger" id="ex-key-del">Удалить ключ</button>` : ""}
        <span class="hc-badge ${c.secret_configured ? "ok" : "warn"}">${c.secret_configured ? "ключ задан" : "ключа нет"}</span></form>
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
    pane.querySelector("#ex-k-test").addEventListener("click", () => guard(async () => { const r = await api.post("/express/test", {}); setMsg(`Связь есть: сервер ${r.cts_url} выдал токен боту.`, "ok"); }));
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

  // =====================================================================  ЖУРНАЛ ОБМЕНА (администратор)
  function paintLog() {
    const L = st.log;
    pane.innerHTML = `<div class="hc-bar"><strong>Журнал обмена с eXpress</strong><span class="hc-muted">последние ${L.items.length} из ${L.total}</span>
      <label class="hc-check-inline"><input type="checkbox" id="ex-l-err" ${st.logErrors ? "checked" : ""}> только ошибки</label><button type="button" class="hc-btn" id="ex-l-refresh">Обновить</button></div>${msgLine()}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Когда</th><th></th><th>Что</th><th>Контакт</th><th>Текст</th><th>Результат</th></tr></thead><tbody>${
        L.items.length ? L.items.map((r) => `<tr><td class="hc-num">${esc(fmtMoment(r.at))}</td><td>${r.direction === "out" ? "→" : r.direction === "in" ? "←" : "·"}</td><td>${esc(r.kind || "")}</td>
          <td>${esc(r.contact_name || "—")}</td><td>${esc(r.text || "")}</td><td>${r.ok ? '<span class="hc-badge ok">ок</span>' : `<span class="hc-badge bad" title="${esc(r.error || "")}">ошибка</span> <span class="hc-muted">${esc(r.error || "")}</span>`}</td></tr>`).join("")
        : `<tr><td colspan="6" class="hc-muted">Записей нет.</td></tr>`}</tbody></table></div>
      <p class="hc-muted">Записи старше 90 дней удаляются автоматически. Незнакомые отправители бота видны здесь строкой «отправитель не в списке контактов» — по их логину можно завести контакт.</p>`;
    pane.querySelector("#ex-l-refresh").addEventListener("click", () => { st.log = null; paint(); });
    pane.querySelector("#ex-l-err").addEventListener("change", (e) => { st.logErrors = e.target.checked; st.log = null; paint(); });
  }

  paint();
  return { destroy() { dead = true; el.innerHTML = ""; } };
}
