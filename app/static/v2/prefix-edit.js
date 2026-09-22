// Редактор справочника «Префиксы марок»: префикс → тип элемента (эвристика импорта чертежей). Тот же API и права,
// что у V1 (`app/counterparties.py`: `/mark-type-prefixes`, удаление — общий `/dictionaries/mark_prefix/…`).
// Особенность API: POST — upsert, то есть повторный префикс МОЛЧА заменил бы тип; здесь замена существующего
// префикса выполняется только после явного подтверждения. Барьер безопасности данных — как в dict-edit.js.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";

export function mountPrefixEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.prefix;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false;
  const st = { rows: null, types: [], error: "", seq: 0, busy: false, addPrefix: "", addType: "", status: "", search: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Правка справочника в новом интерфейсе." : "Просмотр справочника."}</strong>
        ${canWrite ? "Префикс определяет тип элемента по марке при импорте чертежа. Повторный префикс заменяет прежний тип — только после подтверждения." : "У вас нет права изменять этот справочник."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      ${canWrite ? `<form id="pe-add" class="v2-bar" autocomplete="off">
        <input type="text" id="pe-prefix" class="v2-search" placeholder="Префикс" aria-label="Префикс" maxlength="50">
        <select id="pe-type" aria-label="Тип элемента"></select>
        <button type="submit" class="v2-btn v2-primary" id="pe-add-btn">Добавить</button></form>` : ""}
      <div class="v2-bar v2-read-bar"><input type="search" id="pe-search" class="v2-search" placeholder="Поиск" aria-label="Поиск">
        <span class="v2-muted" id="pe-count" role="status" aria-live="polite"></span><button type="button" class="v2-btn" id="pe-refresh">Обновить</button></div>
      <p id="pe-status" class="v2-muted" role="status" aria-live="polite"></p>
      <div id="pe-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
  const setStatus = (t) => { st.status = t; const n = $("#pe-status"); if (n) n.textContent = t; };
  const dirty = () => st.addPrefix.trim() !== "";
  const lock = () => el.querySelectorAll("#pe-add input, #pe-add select, #pe-add button, #pe-refresh, #pe-body button").forEach((c) => { c.disabled = st.busy; });

  function fillTypes() {
    const sel = $("#pe-type");
    if (!sel) return;
    const types = [...new Set([...st.types, ...(st.rows || []).map((r) => r.element_type)])].sort((a, b) => a.localeCompare(b, "ru"));
    sel.innerHTML = types.map((t) => `<option value="${esc(t)}" ${t === st.addType ? "selected" : ""}>${esc(t)}</option>`).join("");
    if (!st.addType && types.length) st.addType = types[0];
    sel.value = st.addType;
  }

  function paint() {
    if (dead) return;
    const body = $("#pe-body");
    if (st.rows === null) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить справочник.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="pe-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#pe-retry")?.addEventListener("click", load);
      return;
    }
    fillTypes();
    const q = st.search.trim().toLowerCase();
    const rows = q ? st.rows.filter((r) => `${r.prefix} ${r.element_type}`.toLowerCase().includes(q)) : st.rows;
    $("#pe-count").textContent = q ? `Найдено ${rows.length} из ${st.rows.length}` : `Записей: ${st.rows.length}`;
    if (!rows.length) { body.innerHTML = `<p class="v2-muted">${q ? `Ничего не найдено по запросу «${esc(st.search)}».` : "Префиксов нет."}</p>`; return; }
    body.innerHTML = `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Префикс</th><th>Тип элемента</th>${canWrite ? "<th>Действия</th>" : ""}</tr></thead><tbody>
      ${rows.map((r) => `<tr data-prefix="${esc(r.prefix)}"><td>${esc(r.prefix)}</td><td>${esc(r.element_type)}</td>${canWrite ? `<td>
        <button type="button" class="v2-btn" data-act="edit" data-prefix="${esc(r.prefix)}" aria-label="Изменить тип для ${esc(r.prefix)}">Изменить тип</button>
        <button type="button" class="v2-btn v2-danger" data-act="delete" data-prefix="${esc(r.prefix)}" aria-label="Удалить ${esc(r.prefix)}">Удалить</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
    lock();
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const [rows, vis] = await Promise.all([
        api.get(spec.endpoint),
        objectId ? api.get(`/label-visibility?object_id=${objectId}`).catch(() => ({})) : Promise.resolve({}),
      ]);
      if (dead || seq !== st.seq) return false;
      st.rows = rows; st.types = Object.keys(vis || {}); st.error = ""; paint(); return true;
    } catch (e) {
      if (dead || seq !== st.seq) return false;
      if (st.rows === null) { st.error = errText(e); paint(); } else setStatus(`Список не обновился: ${errText(e)}`);
      return false;
    }
  }
  async function write(fn) { if (st.busy) return; st.busy = true; lock(); try { await fn(); } finally { st.busy = false; lock(); } }

  async function submitAdd() {
    const prefix = st.addPrefix.trim(), type = st.addType;
    if (!prefix) { setStatus("Введите префикс."); $("#pe-prefix")?.focus(); return; }
    if (!type) { setStatus("Выберите тип элемента."); return; }
    const existing = st.rows.find((r) => r.prefix === prefix);
    if (existing && existing.element_type === type) { setStatus(`Префикс «${prefix}» уже задан для типа «${type}».`); return; }
    if (existing && !(await showConfirmDialog(`Префикс «${prefix}» уже задан для типа «${existing.element_type}». Заменить на «${type}»? Это изменит определение типа при следующих импортах.`, { confirmLabel: "Заменить" }))) return;
    await write(async () => {
      setStatus("Сохранение…");
      try {
        const saved = await api.post(spec.endpoint, { prefix, element_type: type });
        st.addPrefix = ""; $("#pe-prefix").value = "";
        const ok = await load();
        setStatus(ok ? `${existing ? "Изменено" : "Добавлено"}: ${saved.prefix} → ${saved.element_type}.` : `Сохранено: ${saved.prefix} → ${saved.element_type}, но список обновить не удалось — нажмите «Обновить».`);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
          const ok = await load();
          const now = ok && st.rows.find((r) => r.prefix === prefix);
          setStatus(now && now.element_type === type ? `Сервер сохранил «${prefix} → ${type}», хотя ответ не дошёл.` : ok ? `Запись не сохранена: ${errText(e)}` : `Неизвестно, сохранена ли запись (${errText(e)}). Обновите список.`);
        } else setStatus(errText(e));
        $("#pe-prefix")?.focus();
      }
    });
  }

  async function requestDelete(prefix) {
    const rec = st.rows.find((r) => r.prefix === prefix);
    if (!rec) return;
    await write(async () => {
      setStatus("Проверяем, где запись используется…");
      let plan;
      try { plan = (await api.get(`/dictionaries/mark_prefix/${encodeURIComponent(prefix)}/delete-plan`)).plan; }
      catch (e) { setStatus(`Не удалось получить план удаления: ${errText(e)}`); return; }
      setStatus("");
      if (plan.blockers?.length || plan.needs_replacement || (plan.refs || []).some((r) => r.count > 0)) {
        await showInfoDialog(`Удалить «${prefix}» здесь нельзя: запись используется. Удаление с заменой — в текущем интерфейсе.`); return;
      }
      if (!(await showConfirmDialog(`Удалить префикс «${prefix} → ${rec.element_type}»?`, { confirmLabel: "Удалить", danger: true }))) return;
      try {
        await api.post(`/dictionaries/mark_prefix/${encodeURIComponent(prefix)}/delete`, { replacements: {}, mode: "replace" });
        const ok = await load();
        setStatus(ok ? `Удалено: «${prefix}».` : `Удалено: «${prefix}», но список обновить не удалось — нажмите «Обновить».`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { await load(); setStatus("Запись уже удалена — список обновлён."); }
        else if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
          const ok = await load();
          setStatus(ok && !st.rows.some((r) => r.prefix === prefix) ? `Запись «${prefix}» удалена, хотя ответ не дошёл.` : `Неизвестно, удалена ли запись (${errText(e)}). Проверьте список.`);
        } else setStatus(errText(e));
      }
    });
  }

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || st.busy) return;
    if (b.dataset.act === "delete") { if (dirty()) { setStatus("Сначала сохраните или очистите введённый префикс."); return; } requestDelete(b.dataset.prefix); }
    else if (b.dataset.act === "edit") {
      const rec = st.rows.find((r) => r.prefix === b.dataset.prefix);
      if (rec) { st.addPrefix = rec.prefix; st.addType = rec.element_type; $("#pe-prefix").value = rec.prefix; fillTypes(); $("#pe-type").focus(); setStatus(`Выберите новый тип для «${rec.prefix}» и нажмите «Добавить».`); }
    }
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "pe-prefix") st.addPrefix = e.target.value;
    else if (e.target.id === "pe-type") st.addType = e.target.value;
    else if (e.target.id === "pe-search") { st.search = e.target.value; paint(); }
  });
  $("#pe-add")?.addEventListener("submit", (e) => { e.preventDefault(); if (!st.busy && st.rows) submitAdd(); });
  $("#pe-refresh").addEventListener("click", () => { if (!st.busy) load(); });
  load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Введён префикс, но не добавлен. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await submitAdd();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
