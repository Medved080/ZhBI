// Редактор одной числовой настройки объекта (сейчас — «Порог опоздания поставки», `/settings/info-plate`).
// Тот же API и права, что у V1 (`app/settings.py`, раздел `info_plate`); здесь только экран.
// Барьер безопасности данных — как в dict-edit.js: объект берётся из контекста экрана (смена объекта в шапке
// сначала проходит сторож несохранённого), одна запись за раз, ввод не теряется при ошибке, успех — только после
// ответа сервера и повторного чтения, неизвестный исход не повторяется автоматически.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

export function mountSettingEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.setting;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false;
  const st = { loaded: null, draft: "", busy: false, error: "", status: "", seq: 0 };
  const path = `${spec.endpoint}?object_id=${objectId}`;

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Настройка правится в новом интерфейсе." : "Просмотр настройки."}</strong>
        ${canWrite ? "Значение относится к выбранному в шапке объекту." : "У вас нет права изменять эту настройку."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="se-body"></div>
      <p id="se-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
  const setStatus = (t) => { st.status = t; const n = $("#se-status"); if (n) n.textContent = t; };
  const parsed = () => (/^\d+$/.test(st.draft.trim()) ? Number(st.draft.trim()) : null);
  const dirty = () => st.loaded !== null && st.draft.trim() !== String(st.loaded);

  function paint() {
    if (dead) return;
    const body = $("#se-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — настройка относится к объекту.</p>`; return; }
    if (st.loaded === null) {
      body.innerHTML = st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить настройку.</strong> ${esc(st.error)}
           <div class="v2-callout-actions"><button type="button" class="v2-btn" id="se-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#se-retry")?.addEventListener("click", load);
      return;
    }
    body.innerHTML = `<form id="se-form" class="v2-wire-row" autocomplete="off">
      <label class="v2-wire-field"><span>${esc(spec.label)}</span>
        <input type="number" id="se-input" min="0" step="1" value="${esc(st.draft)}" ${canWrite ? "" : "disabled"} aria-describedby="se-hint"></label>
      ${canWrite ? `<button type="submit" class="v2-btn v2-primary" id="se-save" ${dirty() ? "" : "disabled"}>Сохранить</button>
        <button type="button" class="v2-btn" id="se-revert" ${dirty() ? "" : "disabled"}>Отменить правку</button>` : ""}
      <button type="button" class="v2-btn" id="se-refresh">Обновить</button></form>
      <p id="se-hint" class="v2-muted">${esc(spec.hint || "")}</p>`;
    $("#se-input")?.addEventListener("input", (e) => { st.draft = e.target.value; sync(); });
    $("#se-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    $("#se-revert")?.addEventListener("click", () => { st.draft = String(st.loaded); paint(); });
    $("#se-refresh").addEventListener("click", () => { if (!st.busy && !dirty()) load(); else if (dirty()) setStatus("Сначала сохраните или отмените правку."); });
    lock();
  }
  function sync() { const s = $("#se-save"), r = $("#se-revert"); if (s) s.disabled = st.busy || !dirty(); if (r) r.disabled = st.busy || !dirty(); }
  function lock() { el.querySelectorAll("#se-form input, #se-form button").forEach((c) => { c.disabled = st.busy || (c.id === "se-input" && !canWrite); }); if (!st.busy) sync(); }

  async function load() {
    if (!objectId) { paint(); return; }
    const seq = ++st.seq;
    try {
      const data = await api.get(path);
      if (dead || seq !== st.seq) return;
      st.loaded = Number(data[spec.field]); st.draft = String(st.loaded); st.error = "";
    } catch (e) {
      if (dead || seq !== st.seq) return;
      if (st.loaded === null) st.error = errText(e); else setStatus(`Значение не обновилось: ${errText(e)}`);
    }
    paint();
  }

  async function save() {
    if (st.busy) return;
    const value = parsed();
    if (value === null) { setStatus("Введите целое число не меньше нуля."); $("#se-input")?.focus(); return; }
    st.busy = true; lock(); setStatus("Сохранение…");
    try {
      const saved = await api.put(path, { [spec.field]: value });
      st.loaded = Number(saved[spec.field]); st.draft = String(st.loaded);
      setStatus(`Сохранено: ${st.loaded}.`);
      st.busy = false; paint();
      // повторное чтение — подтверждение того, что сервер действительно хранит значение
      const seq = ++st.seq;
      try {
        const again = await api.get(path);
        if (!dead && seq === st.seq) { st.loaded = Number(again[spec.field]); st.draft = String(st.loaded); setStatus(`Сохранено и подтверждено чтением: ${st.loaded}.`); paint(); }
      } catch (e) { if (!dead) setStatus(`Сохранено: ${st.loaded}, но перечитать не удалось — нажмите «Обновить».`); }
    } catch (e) {
      st.busy = false;
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        // исход неизвестен — не повторяем: читаем и сообщаем по факту
        try {
          const now = await api.get(path);
          const v = Number(now[spec.field]);
          if (v === value) { st.loaded = v; st.draft = String(v); setStatus(`Сервер сохранил значение ${v}, хотя ответ не дошёл.`); }
          else setStatus(`Значение не изменено (на сервере ${v}): ${errText(e)}`);
        } catch (e2) { setStatus(`Неизвестно, сохранено ли значение (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
      } else setStatus(errText(e)); // 400/403: введённое остаётся в поле
      paint();
      $("#se-input")?.focus();
    }
  }

  paint();
  load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Настройка изменена, но не сохранена. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
