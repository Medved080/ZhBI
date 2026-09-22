// Редакторы объектных карточек: «Карточка объекта» (`/settings/project-card`) и «События, задачи, вопросы»
// (`/settings/report-notes`, редакции на дату). Те же API и права, что у V1 (`app/settings.py`).
//
// Барьер безопасности данных (Docs/v2-interface-coverage.md):
//  * PUT карточки заменяет её ЦЕЛИКОМ (поля, которых нет в теле, обнуляются моделью) — поэтому в тело идут ВСЕ поля
//    последнего чтения, а правится только то, что менял человек (V1 шлёт четыре поля и стирает три списка);
//  * перед записью сервер перечитывается: если запись изменили после загрузки экрана, перезапись — только по явному
//    подтверждению (последний писатель выигрывает, но не молча);
//  * объект берётся из контекста экрана (смена объекта в шапке проходит сторож несохранённого);
//  * одна запись за раз, ввод не теряется при ошибке, успех — после ответа сервера и повторного чтения,
//    неизвестный исход (сеть/5xx) не повторяется, а проверяется чтением;
//  * даты проверяются как настоящие календарные (сервер их не проверяет и принял бы «2026-13-45»);
//  * редакция заметок на уже занятую дату не перезаписывается молча; удаление — с показом содержимого и подтверждением.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const isUnknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

// Настоящая дата ГГГГ-ММ-ДД (месяц и день существуют в календаре)
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const linesToList = (v) => String(v).split("\n").map((s) => s.trim()).filter(Boolean);
const dateRu = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? ""); };

function shell(el, { screen, structure, objectId, groupTitle, canWrite, okNote, roNote }) {
  el.className = "v2-page";
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Правка в новом интерфейсе." : "Просмотр."}</strong> ${esc(canWrite ? okNote : roNote)}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ce-body"></div>
      <p id="ce-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  return { $: (s) => el.querySelector(s), setStatus(t) { const n = el.querySelector("#ce-status"); if (n) n.textContent = t; } };
}

// ============================= Карточка объекта =============================
export function mountProjectCardEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.card;
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  const ui = shell(el, { screen, structure, objectId, groupTitle, canWrite,
    okNote: "Значения относятся к выбранному в шапке объекту и попадают в отчёт «Динамика». Ключевые события, задачи и вопросы ведутся отдельно («События, задачи, вопросы»).",
    roNote: "У вас нет права изменять карточку объекта." });
  const path = `${spec.endpoint}?object_id=${objectId}`;
  let dead = false;
  // server — последнее подтверждённое чтение (все поля); draft — правка человека
  const st = { server: null, draft: null, busy: false, error: "", seq: 0 };

  const draftOf = (c) => ({ title: c.title || "", montage: c.montage_deadline || "", delivery: c.delivery_deadline || "",
    milestones: (c.milestones || []).map((m) => ({ ...m, label: m.label ?? "", date: m.date ?? "" })) });
  const fp = (d) => JSON.stringify([d.title.trim(), d.montage, d.delivery, d.milestones.map((m) => [String(m.label).trim(), m.date])]);
  const dirty = () => st.server !== null && fp(st.draft) !== fp(draftOf(st.server));

  function problems() {
    const out = [];
    if (st.draft.montage && !isRealDate(st.draft.montage)) out.push("«Окончание монтажа» — не существующая дата");
    if (st.draft.delivery && !isRealDate(st.draft.delivery)) out.push("«Окончание поставки» — не существующая дата");
    st.draft.milestones.forEach((m, i) => { if (!isRealDate(m.date)) out.push(`Веха ${i + 1}${String(m.label).trim() ? ` «${String(m.label).trim()}»` : ""}: нужна дата ГГГГ-ММ-ДД`); });
    return out;
  }
  function bodyFrom(server, d) {
    // Все поля последнего чтения + правки: нетронутые списки не обнуляются.
    return { ...server, title: d.title.trim(), montage_deadline: d.montage || null, delivery_deadline: d.delivery || null,
      milestones: d.milestones.map((m) => ({ ...m, label: String(m.label).trim(), date: m.date })),
      key_events: server.key_events || [], key_tasks: server.key_tasks || [], open_questions: server.open_questions || [] };
  }

  function paint() {
    if (dead) return;
    const body = ui.$("#ce-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — карточка относится к объекту.</p>`; return; }
    if (st.server === null) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить карточку.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="pc-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      ui.$("#pc-retry")?.addEventListener("click", load);
      return;
    }
    const d = st.draft, dis = canWrite ? "" : "disabled";
    body.innerHTML = `<form id="pc-form" autocomplete="off">
      <label class="v2-wire-field v2-field-wide"><span>Наименование</span><textarea id="pc-title" rows="3" ${dis}>${esc(d.title)}</textarea></label>
      <div class="v2-wire-row">
        <label class="v2-wire-field"><span>Окончание монтажа изделий</span><input type="date" id="pc-montage" value="${esc(d.montage)}" ${dis}></label>
        <label class="v2-wire-field"><span>Окончание поставки изделий</span><input type="date" id="pc-delivery" value="${esc(d.delivery)}" ${dis}></label></div>
      <h3 class="v2-report-h">Вехи на графике</h3>
      ${d.milestones.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Название</th><th>Дата</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
        ${d.milestones.map((m, i) => `<tr><td><input type="text" data-ms="label" data-i="${i}" value="${esc(m.label)}" aria-label="Название вехи ${i + 1}" ${dis}></td>
          <td><input type="date" data-ms="date" data-i="${i}" value="${esc(m.date)}" aria-label="Дата вехи ${i + 1}" ${dis}></td>
          ${canWrite ? `<td><button type="button" class="v2-btn" data-ms-del="${i}" aria-label="Удалить веху ${i + 1}">Удалить</button></td>` : ""}</tr>`).join("")}</tbody></table></div>` : `<p class="v2-muted">Вех нет.</p>`}
      ${canWrite ? `<div class="v2-bar"><button type="button" class="v2-btn" id="pc-add">+ Веха</button>
        <button type="submit" class="v2-btn v2-primary" id="pc-save">Сохранить</button>
        <button type="button" class="v2-btn" id="pc-revert">Отменить правку</button>
        <button type="button" class="v2-btn" id="pc-refresh">Обновить</button></div>` : ""}
      <p class="v2-muted">Ключевые события, задачи и открытые вопросы — отдельный экран «События, задачи, вопросы»; при сохранении карточки они не меняются.</p></form>`;
    wire(); lock();
  }
  function wire() {
    const q = (s) => ui.$(s);
    q("#pc-title")?.addEventListener("input", (e) => { st.draft.title = e.target.value; sync(); });
    q("#pc-montage")?.addEventListener("input", (e) => { st.draft.montage = e.target.value; sync(); });
    q("#pc-delivery")?.addEventListener("input", (e) => { st.draft.delivery = e.target.value; sync(); });
    el.querySelectorAll("[data-ms]").forEach((inp) => inp.addEventListener("input", () => { st.draft.milestones[Number(inp.dataset.i)][inp.dataset.ms] = inp.value; sync(); }));
    el.querySelectorAll("[data-ms-del]").forEach((b) => b.addEventListener("click", () => { if (st.busy) return; st.draft.milestones.splice(Number(b.dataset.msDel), 1); paint(); }));
    q("#pc-add")?.addEventListener("click", () => { if (st.busy) return; st.draft.milestones.push({ label: "", date: "" }); paint(); el.querySelector(`[data-ms=label][data-i="${st.draft.milestones.length - 1}"]`)?.focus(); });
    q("#pc-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    q("#pc-revert")?.addEventListener("click", () => { if (!st.busy) { st.draft = draftOf(st.server); paint(); } });
    q("#pc-refresh")?.addEventListener("click", () => { if (st.busy) return; if (dirty()) ui.setStatus("Сначала сохраните или отмените правку."); else load(); });
  }
  function sync() { const s = ui.$("#pc-save"), r = ui.$("#pc-revert"); if (s) s.disabled = st.busy || !dirty(); if (r) r.disabled = st.busy || !dirty(); }
  function lock() { el.querySelectorAll("#pc-form input, #pc-form textarea, #pc-form button").forEach((c) => { if (canWrite) c.disabled = st.busy; }); if (!st.busy) sync(); }

  async function load() {
    if (!objectId) { paint(); return; }
    const seq = ++st.seq;
    try {
      const c = await api.get(path);
      if (dead || seq !== st.seq) return;
      st.server = c; st.draft = draftOf(c); st.error = "";
    } catch (e) {
      if (dead || seq !== st.seq) return;
      if (st.server === null) st.error = errText(e); else ui.setStatus(`Карточка не обновилась: ${errText(e)}`);
    }
    paint();
  }

  async function save() {
    if (st.busy || !dirty()) return;
    const bad = problems();
    if (bad.length) { ui.setStatus(`Сохранить нельзя: ${bad.join("; ")}.`); return; }
    st.busy = true; lock(); ui.setStatus("Проверяем, не изменили ли карточку другие…");
    const sentDraft = JSON.parse(JSON.stringify(st.draft));
    try {
      // 1) свежее чтение: карточку могли изменить после загрузки экрана
      let fresh;
      try { fresh = await api.get(path); } catch (e) { ui.setStatus(`Не удалось проверить актуальность карточки: ${errText(e)}. Запись не отправлена.`); return; }
      if (fp(draftOf(fresh)) !== fp(draftOf(st.server)) || JSON.stringify([fresh.key_events, fresh.key_tasks, fresh.open_questions]) !== JSON.stringify([st.server.key_events, st.server.key_tasks, st.server.open_questions])) {
        st.busy = false; lock();
        const ok = await showConfirmDialog("Карточку изменили после того, как вы её открыли. Перезаписать вашими правками (чужие изменения в полях карточки будут потеряны)?", { confirmLabel: "Перезаписать", danger: true });
        if (!ok) { ui.setStatus("Запись отменена. Нажмите «Обновить», чтобы увидеть актуальную карточку (ваши правки при этом будут сброшены)."); return; }
        st.busy = true; lock();
      }
      // 2) запись целой карточки: поля последнего чтения + правки
      const payload = bodyFrom(fresh, sentDraft);
      ui.setStatus("Сохранение…");
      try {
        await api.put(path, payload);
      } catch (e) {
        if (isUnknownOutcome(e)) {
          try {
            const now = await api.get(path);
            if (fp(draftOf(now)) === fp(sentDraft)) { st.server = now; st.draft = draftOf(now); ui.setStatus("Сервер сохранил карточку, хотя ответ не дошёл."); }
            else ui.setStatus(`Изменения не подтверждены (${errText(e)}). Проверьте карточку и повторите вручную.`);
          } catch (e2) { ui.setStatus(`Неизвестно, сохранена ли карточка (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
        } else ui.setStatus(errText(e)); // 4xx: введённое остаётся
        return;
      }
      // 3) повторное чтение подтверждает записанное
      try {
        const again = await api.get(path);
        if (dead) return;
        const same = fp(draftOf(again)) === fp(sentDraft);
        st.server = again; st.draft = draftOf(again);
        ui.setStatus(same ? "Сохранено и подтверждено чтением." : "Сервер вернул карточку, отличающуюся от отправленной — проверьте значения.");
      } catch (e) { ui.setStatus("Сохранено, но перечитать не удалось — нажмите «Обновить»."); st.server = { ...fresh, ...payload }; }
    } finally { st.busy = false; if (!dead) paint(); }
  }

  paint(); load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const c = await showUnsavedDialog("Карточка объекта изменена, но не сохранена. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}

// ======================= События, задачи, вопросы (редакции) =======================
const NOTE_FIELDS = [["key_events", "Ключевые события (по одному в строке)"], ["key_tasks", "Ключевые задачи (по одной в строке)"], ["open_questions", "Открытые вопросы (по одному в строке)"]];

// Подстановка отчётной даты из «Динамики» (одноразовая, только для своего объекта)
function takeNotesPrefill(objectId) {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem("v2.notesPrefill") || "null"); sessionStorage.removeItem("v2.notesPrefill"); } catch (e) { r = null; }
  return r && r.objectId === objectId && /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") ? r.date : null;
}

export function mountReportNotesEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.notes;
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  const ui = shell(el, { screen, structure, objectId, groupTitle, canWrite,
    okNote: "Отчёт «Динамика» на дату показывает последнюю редакцию, дата которой не позже отчётной. Редакция на занятую дату не перезаписывается молча.",
    roNote: "У вас нет права изменять заметки отчётов." });
  const path = `${spec.endpoint}?object_id=${objectId}`;
  let dead = false;
  // revisions — последнее подтверждённое чтение; sel — дата открытой редакции (null — новая); draft — форма.
  // Как в V1: новая редакция — на сегодняшнюю дату; при открытии экрана выбрана самая свежая редакция (с ней работают чаще всего);
  // дата, переданная кнопкой «✎ Изменить» отчёта «Динамика» (reports-work.js, одноразовый ключ sessionStorage «v2.notesPrefill»,
  // только для своего объекта — takeNotesPrefill), открывает её редакцию или новую на эту дату (V1: openReportNotes(дата отчёта)).
  const todayIso = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const emptyDraft = (date) => ({ date, events: "", tasks: "", questions: "" });
  let prefill = takeNotesPrefill(objectId);
  if (!isRealDate(prefill)) prefill = null;
  const st = { revisions: null, sel: null, newDate: prefill || todayIso(), draft: emptyDraft(prefill || todayIso()), busy: false, error: "", seq: 0, first: true };
  const rev = (date) => st.revisions?.find((r) => r.effective_date === date);
  const draftOfRev = (r) => ({ date: r.effective_date, events: (r.key_events || []).join("\n"), tasks: (r.key_tasks || []).join("\n"), questions: (r.open_questions || []).join("\n") });
  const listsOf = (d) => [linesToList(d.events), linesToList(d.tasks), linesToList(d.questions)];
  const dirty = () => {
    if (st.revisions === null) return false;
    if (st.sel === null) return st.draft.date !== st.newDate || st.draft.events.trim() !== "" || st.draft.tasks.trim() !== "" || st.draft.questions.trim() !== "";
    const r = rev(st.sel);
    return !!r && JSON.stringify(listsOf(st.draft)) !== JSON.stringify([r.key_events || [], r.key_tasks || [], r.open_questions || []]);
  };

  function paint() {
    if (dead) return;
    const body = ui.$("#ce-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — заметки относятся к объекту.</p>`; return; }
    if (st.revisions === null) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить заметки.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="rn-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      ui.$("#rn-retry")?.addEventListener("click", load);
      return;
    }
    const dis = canWrite ? "" : "disabled";
    const isNew = st.sel === null;
    body.innerHTML = `<div class="v2-cols">
      <aside class="v2-rn-list"><div class="v2-bar"><strong>Редакции</strong>${canWrite ? `<button type="button" class="v2-btn" id="rn-new">+ Новая редакция</button>` : ""}</div>
        ${st.revisions.length ? `<ul class="v2-card-list">${st.revisions.map((r) => `<li><button type="button" class="v2-btn ${st.sel === r.effective_date ? "v2-primary" : ""}" data-rev="${esc(r.effective_date)}" aria-pressed="${st.sel === r.effective_date}">${esc(dateRu(r.effective_date))}</button>
          <span class="v2-muted">пунктов: ${(r.key_events || []).length + (r.key_tasks || []).length + (r.open_questions || []).length}${r.updated_by ? ` · ${esc(r.updated_by)}` : ""}</span></li>`).join("")}</ul>` : `<p class="v2-muted">Редакций нет.</p>`}</aside>
      <section><form id="rn-form" autocomplete="off">
        <label class="v2-wire-field"><span>Действует с даты</span><input type="date" id="rn-date" value="${esc(st.draft.date)}" ${isNew && canWrite ? "" : "disabled"}></label>
        ${!isNew ? `<p class="v2-muted">Дата существующей редакции не меняется: чтобы сдвинуть её, заведите новую и удалите эту.</p>` : ""}
        ${NOTE_FIELDS.map(([k, label], i) => `<label class="v2-wire-field v2-field-wide"><span>${esc(label)}</span><textarea data-nf="${["events", "tasks", "questions"][i]}" rows="4" ${dis}>${esc(st.draft[["events", "tasks", "questions"][i]])}</textarea></label>`).join("")}
        ${canWrite ? `<div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="rn-save">Сохранить</button>
          ${!isNew ? `<button type="button" class="v2-btn v2-danger" id="rn-delete">Удалить редакцию</button>` : ""}
          <button type="button" class="v2-btn" id="rn-refresh">Обновить</button></div>` : ""}</form></section></div>`;
    wire(); lock();
  }
  function wire() {
    ui.$("#rn-new")?.addEventListener("click", () => switchTo(null));
    el.querySelectorAll("[data-rev]").forEach((b) => b.addEventListener("click", () => switchTo(b.dataset.rev)));
    ui.$("#rn-date")?.addEventListener("input", (e) => { st.draft.date = e.target.value; sync(); });
    el.querySelectorAll("[data-nf]").forEach((t) => t.addEventListener("input", () => { st.draft[t.dataset.nf] = t.value; sync(); }));
    ui.$("#rn-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    ui.$("#rn-delete")?.addEventListener("click", requestDelete);
    ui.$("#rn-refresh")?.addEventListener("click", () => { if (st.busy) return; if (dirty()) ui.setStatus("Сначала сохраните или отмените правку."); else load(); });
  }
  function sync() { const s = ui.$("#rn-save"); if (s && !st.busy) s.disabled = !dirty(); }
  function lock() {
    el.querySelectorAll("#rn-form input, #rn-form textarea, #rn-form button, .v2-rn-list button").forEach((c) => {
      const listBtn = !!c.dataset.rev || c.id === "rn-new";
      c.disabled = st.busy || (c.id === "rn-date" && (st.sel !== null || !canWrite)) || (!canWrite && !listBtn && c.id !== "rn-refresh");
    });
    if (!st.busy) sync();
  }

  async function guarded() {
    if (!dirty()) return true;
    const c = await showUnsavedDialog("Редакция изменена, но не сохранена. Что сделать?");
    if (c === "cancel") return false;
    if (c === "discard") return true;
    await save();
    return !dirty();
  }
  async function switchTo(date) {
    if (st.busy) return;
    if (date === st.sel && date !== null) return;
    if (!(await guarded())) return;
    st.sel = date;
    if (date === null) st.newDate = todayIso();
    st.draft = date === null ? emptyDraft(st.newDate) : draftOfRev(rev(date));
    ui.setStatus(""); paint();
  }

  async function load(keepSel = true) {
    if (!objectId) { paint(); return; }
    const seq = ++st.seq;
    try {
      const data = await api.get(path);
      if (dead || seq !== st.seq) return false;
      st.revisions = data.revisions || []; st.error = "";
      if (st.first) {
        st.first = false;
        if (st.sel === null && !dirty()) {
          const want = prefill && rev(prefill) ? prefill : !prefill && st.revisions[0] ? st.revisions[0].effective_date : null;
          if (want) { st.sel = want; st.draft = draftOfRev(rev(want)); }
        }
      } else if (keepSel && st.sel !== null && !rev(st.sel)) { st.sel = null; st.newDate = todayIso(); st.draft = emptyDraft(st.newDate); ui.setStatus("Открытой редакции больше нет (её удалили) — форма очищена."); }
      else if (st.sel !== null && !dirty()) st.draft = draftOfRev(rev(st.sel));
      paint(); return true;
    } catch (e) {
      if (dead || seq !== st.seq) return false;
      if (st.revisions === null) st.error = errText(e); else ui.setStatus(`Список не обновился: ${errText(e)}`);
      paint(); return false;
    }
  }

  async function save() {
    if (st.busy) return;
    const isNew = st.sel === null;
    const date = isNew ? st.draft.date : st.sel;
    if (!isRealDate(date)) { ui.setStatus(isNew ? "Укажите существующую дату, с которой действует редакция." : "У редакции некорректная дата."); ui.$("#rn-date")?.focus(); return; }
    if (isNew && rev(date)) { ui.setStatus(`Редакция на ${dateRu(date)} уже есть — откройте её из списка (молча перезаписывать не будем).`); return; }
    const sent = listsOf(st.draft);
    const baseline = isNew ? null : rev(date);
    st.busy = true; lock(); ui.setStatus("Сохранение…");
    try {
      // актуальность: с момента открытия редакцию могли изменить/создать/удалить
      let fresh;
      try { fresh = (await api.get(path)).revisions || []; } catch (e) { ui.setStatus(`Не удалось проверить актуальность: ${errText(e)}. Запись не отправлена.`); return; }
      const cur = fresh.find((r) => r.effective_date === date);
      const changed = isNew ? !!cur : (!cur || cur.updated_at !== baseline.updated_at);
      if (changed) {
        st.busy = false; lock();
        const ok = await showConfirmDialog(isNew ? `Пока вы вводили, на ${dateRu(date)} появилась редакция. Перезаписать её вашей?` : cur ? "Эту редакцию изменили после того, как вы её открыли. Перезаписать вашими правками?" : "Эту редакцию удалили после того, как вы её открыли. Создать заново с вашим текстом?", { confirmLabel: "Перезаписать", danger: true });
        if (!ok) { ui.setStatus("Запись отменена."); return; }
        st.busy = true; lock();
      }
      try {
        await api.put(path, { effective_date: date, key_events: sent[0], key_tasks: sent[1], open_questions: sent[2] });
      } catch (e) {
        if (isUnknownOutcome(e)) {
          try {
            const now = (await api.get(path)).revisions || []; st.revisions = now;
            const r = now.find((x) => x.effective_date === date);
            if (r && JSON.stringify([r.key_events, r.key_tasks, r.open_questions]) === JSON.stringify(sent)) { st.sel = date; st.draft = draftOfRev(r); ui.setStatus("Сервер сохранил редакцию, хотя ответ не дошёл."); }
            else ui.setStatus(`Изменения не подтверждены (${errText(e)}). Проверьте список и повторите вручную.`);
          } catch (e2) { ui.setStatus(`Неизвестно, сохранена ли редакция (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
        } else ui.setStatus(errText(e));
        return;
      }
      try {
        const again = (await api.get(path)).revisions || [];
        st.revisions = again; st.sel = date;
        const r = again.find((x) => x.effective_date === date);
        const same = !!r && JSON.stringify([r.key_events, r.key_tasks, r.open_questions]) === JSON.stringify(sent);
        st.draft = r ? draftOfRev(r) : st.draft;
        ui.setStatus(same ? `Сохранено и подтверждено чтением: редакция на ${dateRu(date)}.` : "Сервер вернул редакцию, отличающуюся от отправленной — проверьте текст.");
      } catch (e) { ui.setStatus("Сохранено, но перечитать не удалось — нажмите «Обновить»."); st.sel = date; }
    } finally { st.busy = false; if (!dead) paint(); }
  }

  async function requestDelete() {
    if (st.busy || st.sel === null) return;
    const date = st.sel, r = rev(date);
    if (dirty()) { ui.setStatus("Сначала сохраните или отмените правку этой редакции."); return; }
    const counts = r ? `${(r.key_events || []).length} событий, ${(r.key_tasks || []).length} задач, ${(r.open_questions || []).length} вопросов` : "";
    if (!(await showConfirmDialog(`Удалить редакцию от ${dateRu(date)} (${counts})? Отчёты на даты после неё вернутся к предыдущей редакции. Действие необратимо.`, { confirmLabel: "Удалить", danger: true }))) return;
    st.busy = true; lock(); ui.setStatus("Удаление…");
    try {
      try { await api.delete(`${spec.endpoint}/${encodeURIComponent(date)}?object_id=${objectId}`); }
      catch (e) {
        if (e instanceof ApiError && e.status === 404) { /* уже нет — цель достигнута */ }
        else if (isUnknownOutcome(e)) {
          try { st.revisions = (await api.get(path)).revisions || []; } catch (e2) { /* ниже — по факту */ }
          if (st.revisions?.some((x) => x.effective_date === date)) { ui.setStatus(`Неизвестно, удалена ли редакция (${errText(e)}). Проверьте список.`); return; }
        } else { ui.setStatus(errText(e)); return; }
      }
      st.sel = null; st.newDate = todayIso(); st.draft = emptyDraft(st.newDate);
      st.busy = false;
      const ok = await load(false);
      ui.setStatus(ok && !rev(date) ? `Редакция от ${dateRu(date)} удалена.` : ok ? "Сервер вернул редакцию после удаления — проверьте." : `Удалено, но список обновить не удалось — нажмите «Обновить».`);
    } finally { st.busy = false; if (!dead) paint(); }
  }

  paint(); load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() { return guarded(); },
    destroy() { dead = true; },
  };
}
