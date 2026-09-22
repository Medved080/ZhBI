// Редактор списка цветов («Цвета зон» объекта, «Цвета статусов»): выбор цвета у каждой строки, сохранение ТОЛЬКО
// изменённых строк (PUT в обоих случаях — upsert, отсутствующие в теле записи не трогаются). Те же API и права, что у
// V1 (`app/main.py`: `/zone-colors`, `/status-colors`); здесь только экран.
// Барьер безопасности данных — как в setting-edit.js: объект из контекста экрана (смена объекта проходит сторож
// несохранённого), одна запись за раз, ввод не теряется при ошибке, успех — после ответа сервера и повторного чтения,
// неизвестный исход не повторяется автоматически, а проверяется чтением.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function mountColorEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.color;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false;
  // rows: [{key, label, color}] — то, что сохранено на сервере; draft: {key: color} — текущий ввод
  const st = { rows: null, draft: {}, busy: false, error: "", seq: 0 };
  const path = spec.object ? `${spec.endpoint}?object_id=${objectId}` : spec.endpoint;

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Цвета правятся в новом интерфейсе." : "Просмотр цветов."}</strong>
        ${esc(spec.scopeNote || "")} ${canWrite ? "Сохраняются только изменённые строки." : "У вас нет права изменять эти цвета."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ce-body"></div>
      <p id="ce-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
  const setStatus = (t) => { const n = $("#ce-status"); if (n) n.textContent = t; };
  const changed = () => (st.rows || []).filter((r) => (st.draft[r.key] || r.color).toLowerCase() !== r.color.toLowerCase());
  const dirty = () => changed().length > 0;

  function normalize(data) {
    if (spec.mode === "status") {
      return Object.entries(data).map(([key, color]) => ({ key, label: spec.labels?.[key] || key, color }));
    }
    return (Array.isArray(data) ? data : []).map((r) => ({ key: r.name, label: r.name, color: r.color }));
  }

  function paint() {
    if (dead) return;
    const body = $("#ce-body");
    if (spec.object && !objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — цвета относятся к объекту.</p>`; return; }
    if (st.rows === null) {
      body.innerHTML = st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить цвета.</strong> ${esc(st.error)}
           <div class="v2-callout-actions"><button type="button" class="v2-btn" id="ce-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#ce-retry")?.addEventListener("click", load);
      return;
    }
    if (!st.rows.length) { body.innerHTML = `<p class="v2-muted">${esc(spec.empty || "Записей нет.")}</p>`; return; }
    body.innerHTML = `<form id="ce-form" autocomplete="off">
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>${esc(spec.columnTitle || "Название")}</th><th>Цвет</th></tr></thead><tbody>
        ${st.rows.map((r) => `<tr><td>${esc(r.label)}${(st.draft[r.key] || r.color).toLowerCase() !== r.color.toLowerCase() ? ' <span class="v2-chip">изменено</span>' : ""}</td>
          <td><input type="color" data-key="${esc(r.key)}" value="${esc(st.draft[r.key] || r.color)}" aria-label="Цвет: ${esc(r.label)}" ${canWrite ? "" : "disabled"}>
            <code>${esc(st.draft[r.key] || r.color)}</code></td></tr>`).join("")}
      </tbody></table></div>
      ${canWrite ? `<div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="ce-save" ${dirty() ? "" : "disabled"}>Сохранить (${changed().length})</button>
        <button type="button" class="v2-btn" id="ce-revert" ${dirty() ? "" : "disabled"}>Отменить правку</button>
        <button type="button" class="v2-btn" id="ce-refresh">Обновить</button></div>` : ""}</form>`;
    body.querySelectorAll("input[type=color]").forEach((inp) => inp.addEventListener("input", () => {
      st.draft[inp.dataset.key] = inp.value; paint();
      body.querySelector(`input[data-key="${CSS.escape(inp.dataset.key)}"]`)?.focus();
    }));
    $("#ce-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    $("#ce-revert")?.addEventListener("click", () => { st.draft = {}; paint(); });
    $("#ce-refresh")?.addEventListener("click", () => { if (dirty()) setStatus("Сначала сохраните или отмените правку."); else if (!st.busy) load(); });
    lock();
  }
  function lock() { el.querySelectorAll("#ce-form input, #ce-form button").forEach((c) => { c.disabled = st.busy || (c.type === "color" && !canWrite); }); if (!st.busy) { const s = $("#ce-save"), r = $("#ce-revert"); if (s) s.disabled = !dirty(); if (r) r.disabled = !dirty(); } }

  async function load() {
    if (spec.object && !objectId) { paint(); return; }
    const seq = ++st.seq;
    try {
      const data = await api.get(path);
      if (dead || seq !== st.seq) return;
      st.rows = normalize(data); st.draft = {}; st.error = "";
    } catch (e) {
      if (dead || seq !== st.seq) return;
      if (st.rows === null) st.error = errText(e); else setStatus(`Цвета не обновились: ${errText(e)}`);
    }
    paint();
  }

  async function save() {
    if (st.busy) return;
    const items = changed();
    if (!items.length) return;
    const bad = items.find((r) => !HEX.test(st.draft[r.key]));
    if (bad) { setStatus(`Некорректный цвет у «${bad.label}».`); return; }
    const sent = Object.fromEntries(items.map((r) => [r.key, st.draft[r.key].toLowerCase()]));
    const payload = spec.mode === "status" ? sent : items.map((r) => ({ name: r.key, color: sent[r.key] }));
    st.busy = true; lock(); setStatus("Сохранение…");
    const confirmRead = async () => {
      const seq = ++st.seq;
      const again = normalize(await api.get(path));
      if (dead || seq !== st.seq) return null;
      return again;
    };
    try {
      await api.put(path, payload);
      st.busy = false;
      try {
        const again = await confirmRead();
        if (again) {
          const map = Object.fromEntries(again.map((r) => [r.key, r.color.toLowerCase()]));
          const mismatch = Object.keys(sent).filter((k) => map[k] !== sent[k]);
          st.rows = again; st.draft = {};
          setStatus(mismatch.length ? `Сервер вернул другие цвета для: ${mismatch.join(", ")}.` : `Сохранено и подтверждено чтением: ${items.length} шт.`);
        }
      } catch (e) { setStatus("Сохранено, но перечитать не удалось — нажмите «Обновить»."); }
      paint();
    } catch (e) {
      st.busy = false;
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        try {
          const again = await confirmRead();
          const map = Object.fromEntries((again || []).map((r) => [r.key, r.color.toLowerCase()]));
          const applied = Object.keys(sent).filter((k) => map[k] === sent[k]);
          if (again && applied.length === Object.keys(sent).length) { st.rows = again; st.draft = {}; setStatus("Сервер сохранил цвета, хотя ответ не дошёл."); }
          else setStatus(`Изменения не подтверждены (${errText(e)}). Проверьте список и повторите вручную.`);
        } catch (e2) { setStatus(`Неизвестно, сохранены ли цвета (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
      } else setStatus(errText(e)); // 4xx: введённое остаётся
      paint();
    }
  }

  paint();
  load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Цвета изменены, но не сохранены. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
