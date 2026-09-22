// Редактор простого справочника «название» (СМУ, физлица): добавить, переименовать, удалить неиспользуемую запись.
// Те же API и права, что у V1 (`app/reference_catalogs.py`, `app/dict_delete.py`); здесь только экран.
//
// Барьер безопасности данных (Docs/v2-interface-coverage.md, «Барьер»):
//  * id записи берётся из строки, на которой начали правку, а не из положения в таблице;
//  * пока идёт запись, все управляющие элементы заблокированы — второй клик и конфликтующая операция невозможны;
//  * несохранённый ввод защищён сторожем перехода (общий диалог V2), при ошибке ввод остаётся в поле;
//  * успех показывается только после ответа сервера и повторного чтения справочника; имя берётся из ответа
//    сервера (он обрезает пробелы);
//  * неизвестный исход (сеть/5xx) НЕ повторяется автоматически: справочник перечитывается и по факту говорится,
//    появилась ли запись; дубль не создаётся;
//  * удаление: сначала план последствий с сервера; если на запись ссылаются другие данные, удалить можно ТОЛЬКО с заменой: человек выбирает
//    другую запись из списка кандидатов сервера, ссылки переводятся на неё и запись удаляется одной серверной операцией (проверка → перевод →
//    удаление в одной транзакции, при отказе ничего не меняется); тихого каскада и обнуления ссылок нет.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";

const collator = new Intl.Collator("ru", { sensitivity: "base" });

export function mountDictEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.edit;
  el.className = "v2-page";
  // политика ограниченного выпуска (write-gate.js): у справочников без разрешённой записи — только просмотр
  const gateOpen = checkWrite("POST", spec.endpoint, { name: "x" }).allowed;
  const canWrite = gateOpen && (!!rights?.system_admin || rights?.features?.[spec.feature] === "write");
  let dead = false;
  const state = { rows: null, error: "", loadSeq: 0, busy: false, editId: null, editText: "", addText: "", status: "", search: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Правка справочника в новом интерфейсе." : "Просмотр справочника."}</strong>
        ${canWrite ? esc(`Можно добавить, переименовать и удалить запись. Если на запись ссылаются объекты, при удалении нужно выбрать другую запись — ссылки будут переведены на неё.`) : (gateOpen ? "У вас нет права изменять этот справочник." : "Изменение этого справочника в экспериментальном интерфейсе отключено — выполняйте его в текущем интерфейсе.")}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      ${canWrite ? `<form id="de-add" class="v2-bar" autocomplete="off">
        <input type="text" id="de-add-input" class="v2-search" placeholder="${esc(spec.addPlaceholder || "Название")}" aria-label="${esc(spec.addPlaceholder || "Название")}" maxlength="200">
        <button type="submit" class="v2-btn v2-primary" id="de-add-btn">Добавить</button></form>` : ""}
      <div class="v2-bar v2-read-bar">
        <input type="search" id="de-search" class="v2-search" placeholder="Поиск" aria-label="Поиск">
        <span class="v2-muted" id="de-count" role="status" aria-live="polite"></span>
        <button type="button" class="v2-btn" id="de-refresh">Обновить</button>
      </div>
      <p id="de-status" class="v2-muted" role="status" aria-live="polite"></p>
      <div id="de-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  const setStatus = (t) => { state.status = t; const n = $("#de-status"); if (n) n.textContent = t; };
  const errText = (err) => (err instanceof ApiError ? err.detail : String(err?.message || err));

  function hasUnsaved() {
    const editing = state.editId != null && state.rows?.find((r) => r.id === state.editId);
    return state.addText.trim() !== "" || (!!editing && state.editText.trim() !== editing.name.trim());
  }

  function lockControls() {
    el.querySelectorAll("#de-add-input, #de-add-btn, #de-refresh, #de-body button, #de-body input").forEach((c) => { c.disabled = state.busy; });
  }

  function paint() {
    if (dead) return;
    const body = $("#de-body");
    if (state.rows === null) { body.innerHTML = state.error
      ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить справочник.</strong> ${esc(state.error)}
         <div class="v2-callout-actions"><button type="button" class="v2-btn" id="de-retry">Повторить</button></div></div>`
      : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#de-retry")?.addEventListener("click", () => load());
      return;
    }
    const q = state.search.trim().toLowerCase();
    const rows = q ? state.rows.filter((r) => r.name.toLowerCase().includes(q)) : state.rows;
    $("#de-count").textContent = q ? `Найдено ${rows.length} из ${state.rows.length}` : `Записей: ${state.rows.length}`;
    if (!rows.length) { body.innerHTML = `<p class="v2-muted">${q ? `Ничего не найдено по запросу «${esc(state.search)}».` : esc(spec.empty || "Записей нет.")}</p>`; return; }
    body.innerHTML = `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>№</th><th>${esc(spec.columnTitle || "Название")}</th>${canWrite ? "<th>Действия</th>" : ""}</tr></thead><tbody>
      ${rows.map((r) => `<tr data-id="${r.id}"><td>${r.id}</td><td>${state.editId === r.id
        ? `<input type="text" class="v2-search" id="de-edit-input" value="${esc(state.editText)}" aria-label="Новое название" maxlength="200">`
        : esc(r.name)}</td>
        ${canWrite ? `<td>${state.editId === r.id
          ? `<button type="button" class="v2-btn v2-primary" data-act="save" data-id="${r.id}">Сохранить</button> <button type="button" class="v2-btn" data-act="cancel" data-id="${r.id}">Отмена</button>`
          : `<button type="button" class="v2-btn" data-act="rename" data-id="${r.id}" aria-label="Переименовать ${esc(r.name)}">Переименовать</button> <button type="button" class="v2-btn v2-danger" data-act="delete" data-id="${r.id}" aria-label="Удалить ${esc(r.name)}">Удалить</button>`}</td>` : ""}</tr>`).join("")}
      </tbody></table></div>`;
    lockControls();
  }

  async function load() {
    const seq = ++state.loadSeq;
    if (state.rows === null) paint();
    try {
      const data = await api.get(spec.endpoint);
      if (dead || seq !== state.loadSeq) return false; // запоздавший ответ
      state.rows = [...data]; // порядок — серверный (по названию без учёта регистра), как в V1
      state.error = "";
      paint();
      return true;
    } catch (err) {
      if (dead || seq !== state.loadSeq) return false;
      if (state.rows === null) { state.error = errText(err); paint(); }
      else setStatus(`Список не обновился: ${errText(err)}`);
      return false;
    }
  }

  // Одна запись за раз; на время записи блокируется всё, что могло бы конфликтовать.
  async function write(fn) {
    if (state.busy) return null;
    state.busy = true; lockControls();
    try { return await fn(); } finally { state.busy = false; lockControls(); }
  }

  async function submitAdd() {
    const name = state.addText.trim();
    if (!name) { setStatus("Введите название."); $("#de-add-input")?.focus(); return; }
    const before = new Set(state.rows.map((r) => r.id));
    await write(async () => {
      setStatus("Сохранение…");
      try {
        const saved = await api.post(spec.endpoint, { name });
        state.addText = ""; $("#de-add-input").value = "";
        const ok = await load();
        setStatus(ok ? `Добавлено: «${saved.name}».` : `Добавлено: «${saved.name}», но список обновить не удалось — нажмите «Обновить».`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
          // исход неизвестен — не повторяем, а проверяем чтением
          const ok = await load();
          const found = ok && state.rows.find((r) => !before.has(r.id) && collator.compare(r.name, name) === 0);
          setStatus(found ? `Сервер сохранил запись «${found.name}», хотя ответ не дошёл.` : ok ? `Запись не создана: ${errText(err)}` : `Неизвестно, создана ли запись (${errText(err)}). Обновите список и проверьте.`);
        } else setStatus(errText(err)); // 400/409/403: ввод остаётся в поле
        $("#de-add-input")?.focus();
      }
    });
  }

  async function submitRename() {
    const id = state.editId;
    const rec = state.rows.find((r) => r.id === id);
    const name = state.editText.trim();
    if (!rec) return;
    if (!name) { setStatus("Название не может быть пустым."); $("#de-edit-input")?.focus(); return; }
    if (name === rec.name.trim()) { state.editId = null; paint(); return; }
    await write(async () => {
      setStatus("Сохранение…");
      try {
        const saved = await api.patch(`${spec.endpoint}/${id}`, { name });
        state.editId = null;
        const ok = await load();
        setStatus(ok ? `Переименовано: «${saved.name}».` : `Переименовано: «${saved.name}», но список обновить не удалось — нажмите «Обновить».`);
        el.querySelector(`[data-act="rename"][data-id="${id}"]`)?.focus();
      } catch (err) {
        if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
          const ok = await load();
          const now = ok && state.rows.find((r) => r.id === id);
          setStatus(now && collator.compare(now.name, name) === 0 ? `Сервер сохранил новое название «${now.name}», хотя ответ не дошёл.` : `Неизвестно, применено ли переименование (${errText(err)}). Проверьте список.`);
          if (now && collator.compare(now.name, name) === 0) state.editId = null;
        } else if (err instanceof ApiError && err.status === 404) {
          state.editId = null; await load(); setStatus("Запись уже удалена другим пользователем — список обновлён.");
        } else setStatus(errText(err));
        paint();
        $("#de-edit-input")?.focus();
      }
    });
  }

  async function requestDelete(id) {
    const rec = state.rows.find((r) => r.id === id);
    if (!rec) return;
    await write(async () => {
      setStatus("Проверяем, где запись используется…");
      let plan;
      try { plan = (await api.get(`/dictionaries/${spec.dictKind}/${id}/delete-plan`)).plan; }
      catch (err) { setStatus(`Не удалось получить план удаления: ${errText(err)}`); return; }
      setStatus("");
      if (plan.blockers?.length) { await showInfoDialog(`Удалить «${rec.name}» нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner || ""}${b.owner ? ": " : ""}${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`); return; }
      let replacementKey = null;
      const refs = (plan.refs || []).filter((r) => r.count > 0);
      if (plan.needs_replacement || refs.length) {
        // На запись ссылаются другие данные: удалить можно только с заменой на другую запись справочника.
        let cands = [];
        try { cands = await api.get(`/dictionaries/${spec.dictKind}/candidates?key=${encodeURIComponent(plan.key)}`); }
        catch (err) { setStatus(`Не удалось получить список замен: ${errText(err)}`); return; }
        if (!cands.length) { await showInfoDialog(`«${rec.name}» используется: ${refs.map((r) => `${r.label} — ${r.count}`).join("; ") || "другими данными"}.\nЗаменить нечем: в справочнике нет другой записи. Заведите её и повторите удаление.`); return; }
        replacementKey = await askReplacement(rec.name, refs, cands);
        if (!replacementKey) return;
      } else if (!(await showConfirmDialog(`Удалить «${rec.name}»? Запись нигде не используется.`, { confirmLabel: "Удалить", danger: true }))) return;
      const replName = replacementKey ? cands_label(replacementKey) : "";
      try {
        const r = await api.post(`/dictionaries/${spec.dictKind}/${id}/delete`, replacementKey ? { replacements: { [`${plan.kind}:${plan.key}`]: replacementKey }, mode: "replace" } : { replacements: {}, mode: "replace" });
        const ok = await load();
        const moved = (r?.moved || []).flatMap((m) => (m.moved || []).map((x) => `${x.label}: ${x.count}`)).join("; ");
        const base = replacementKey ? `Удалено: «${rec.name}»; ссылки переведены на «${replName}»${moved ? ` (${moved})` : ""}.` : `Удалено: «${rec.name}».`;
        setStatus(ok ? base : `${base} Список обновить не удалось — нажмите «Обновить».`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) { await load(); setStatus("Запись уже удалена — список обновлён."); }
        else if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
          const ok = await load();
          setStatus(ok && !state.rows.some((r) => r.id === id) ? `Запись «${rec.name}» удалена, хотя ответ не дошёл.` : `Неизвестно, удалена ли запись (${errText(err)}). Проверьте список.`);
        } else { setStatus(errText(err)); if (err instanceof ApiError && err.status === 409) await load(); }
      }
    });
  }

  let candidateLabels = new Map();
  const cands_label = (key) => candidateLabels.get(String(key)) || String(key);
  // Выбор замены: диалог со списком кандидатов сервера; «Заменить и удалить» доступно только после выбора.
  function askReplacement(name, refs, cands) {
    candidateLabels = new Map(cands.map((c) => [String(c.key), c.label]));
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "v2-dialog-backdrop";
      backdrop.innerHTML = `<div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="Удаление с заменой">
        <p style="white-space:pre-line">${esc(`«${name}» используется:\n${refs.map((r) => `• ${r.label} — ${r.count}`).join("\n")}\n\nВыберите запись, на которую будут переведены эти ссылки. Затем «${name}» будет удалена. Это необратимо.`)}</p>
        <label class="v2-field">Заменить на<select id="de-repl"><option value="">— выберите —</option>${cands.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join("")}</select></label>
        <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-choice="cancel">Отмена</button>
          <button type="button" class="v2-btn v2-danger" data-choice="confirm" disabled>Заменить и удалить</button></div></div>`;
      const sel = backdrop.querySelector("#de-repl"), okBtn = backdrop.querySelector('[data-choice="confirm"]');
      const close = (v) => { document.removeEventListener("keydown", onKey, true); if (backdrop.isConnected) document.body.removeChild(backdrop); if (previouslyFocused?.focus && document.contains(previouslyFocused)) previouslyFocused.focus(); resolve(v); };
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Tab") {
          const items = [...backdrop.querySelectorAll("select, button:not([disabled])")], first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      sel.addEventListener("change", () => { okBtn.disabled = !sel.value; });
      backdrop.addEventListener("click", (e) => {
        const c = e.target.closest("[data-choice]")?.dataset.choice;
        if (c === "confirm" && sel.value) close(sel.value); else if (c === "cancel" || e.target === backdrop) close(null);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      sel.focus();
    });
  }

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || state.busy) return;
    const id = Number(b.dataset.id);
    if (b.dataset.act === "rename") {
      if (state.editId != null && state.editId !== id && hasUnsaved()) { setStatus("Сначала сохраните или отмените правку другой записи."); return; }
      const rec = state.rows.find((r) => r.id === id);
      state.editId = id; state.editText = rec.name; paint();
      $("#de-edit-input")?.focus();
    } else if (b.dataset.act === "cancel") { state.editId = null; state.editText = ""; paint(); el.querySelector(`[data-act="rename"][data-id="${id}"]`)?.focus(); }
    else if (b.dataset.act === "save") submitRename();
    else if (b.dataset.act === "delete") {
      if (hasUnsaved()) { setStatus("Сначала сохраните или отмените несохранённый ввод."); return; }
      requestDelete(id);
    }
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "de-add-input") state.addText = e.target.value;
    else if (e.target.id === "de-edit-input") state.editText = e.target.value;
    else if (e.target.id === "de-search") { state.search = e.target.value; paint(); }
  });
  el.addEventListener("keydown", (e) => {
    if (e.target.id === "de-edit-input") {
      if (e.key === "Enter") { e.preventDefault(); if (!state.busy) submitRename(); }
      else if (e.key === "Escape") { state.editId = null; paint(); }
    }
  });
  $("#de-add")?.addEventListener("submit", (e) => { e.preventDefault(); if (!state.busy && state.rows) submitAdd(); });
  $("#de-refresh").addEventListener("click", () => { if (!state.busy) load(); });
  load();

  return {
    hasUnsavedChanges: () => hasUnsaved(),
    async guardLeave() {
      if (!hasUnsaved()) return true;
      const choice = await showUnsavedDialog("В справочнике есть несохранённый ввод. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      // «Сохранить и продолжить»
      if (state.addText.trim()) await submitAdd(); else await submitRename();
      return !hasUnsaved();
    },
    destroy() { dead = true; },
  };
}
