// «Форма маркеров»: форма маркера по паре (слой, тип элемента). Те же API и права, что у V1 (`GET /layer-type-combinations`,
// `PUT /element-shapes`, раздел `dict_element_shapes`); здесь только экран. Настройка СИСТЕМНАЯ (не по объекту): пара
// (слой, тип) одинакова для всех чертежей, где она встречается.
// Барьер безопасности данных: в PUT идут ТОЛЬКО изменённые пары (V1 шлёт все строки разом), пара определяется строкой
// таблицы, а не позицией; одна запись за раз; ввод не теряется при ошибке; успех — после повторного чтения и сверки;
// неизвестный исход (сеть/5xx) не повторяется, а проверяется чтением; сторож несохранённого.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

const SHAPES = [["circle", "круг"], ["square", "квадрат"], ["triangle", "треугольник"], ["diamond", "ромб"], ["hexagon", "шестиугольник"], ["outline", "как в оригинале (контур)"]];
const SHAPE_IDS = SHAPES.map((s) => s[0]);
const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const keyOf = (r) => JSON.stringify([r.layer, r.element_type]);

export function mountShapeEdit(el, { screen, structure, objectId, api, rights, groupTitle }) {
  const spec = screen.shape;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false;
  // rows — сохранённое на сервере [{layer, element_type, shape}]; draft — {ключ пары: форма} только для изменённых
  const st = { rows: null, draft: {}, busy: false, error: "", seq: 0, search: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Форма правится в новом интерфейсе." : "Просмотр форм маркеров."}</strong>
        Настройка общая для всех объектов: пара «слой / тип элемента» рисуется одной и той же фигурой на любом чертеже.
        ${canWrite ? "Сохраняются только изменённые пары." : "У вас нет права изменять эту настройку."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div class="v2-wire-row"><label class="v2-wire-field"><span>Поиск по слою или типу</span><input type="search" id="se2-search" autocomplete="off"></label></div>
      <p id="se2-count" class="v2-muted" aria-live="polite"></p>
      <div id="se2-body"></div>
      <p id="se2-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#se2-status"); if (n) n.textContent = t; };
  const cur = (r) => st.draft[keyOf(r)] || r.shape;
  const changed = () => (st.rows || []).filter((r) => cur(r) !== r.shape);
  const dirty = () => changed().length > 0;

  function paint() {
    if (dead) return;
    const body = $("#se2-body");
    if (st.rows === null) {
      body.innerHTML = st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить формы.</strong> ${esc(st.error)}
           <div class="v2-callout-actions"><button type="button" class="v2-btn" id="se2-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#se2-retry")?.addEventListener("click", load);
      $("#se2-count").textContent = "";
      return;
    }
    if (!st.rows.length) { body.innerHTML = `<p class="v2-muted">Нет данных — загрузите чертёж.</p>`; $("#se2-count").textContent = ""; return; }
    const q = st.search.trim().toLowerCase();
    const rows = q ? st.rows.filter((r) => `${r.layer} ${r.element_type}`.toLowerCase().includes(q)) : st.rows;
    $("#se2-count").textContent = q ? `Найдено ${rows.length} из ${st.rows.length}` : `Пар: ${st.rows.length}`;
    body.innerHTML = `<form id="se2-form" autocomplete="off">
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Слой</th><th>Тип элемента</th><th>Форма</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.layer)}</td><td>${esc(r.element_type)}${cur(r) !== r.shape ? ' <span class="v2-chip">изменено</span>' : ""}</td>
          <td><select data-key="${esc(keyOf(r))}" aria-label="Форма: ${esc(r.layer)} / ${esc(r.element_type)}" ${canWrite ? "" : "disabled"}>
            ${SHAPES.map(([id, name]) => `<option value="${id}" ${cur(r) === id ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table></div>
      ${canWrite ? `<div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="se2-save">Сохранить (${changed().length})</button>
        <button type="button" class="v2-btn" id="se2-revert">Отменить правку</button>
        <button type="button" class="v2-btn" id="se2-refresh">Обновить</button></div>` : ""}</form>`;
    body.querySelectorAll("select[data-key]").forEach((sel) => sel.addEventListener("change", () => {
      const row = st.rows.find((r) => keyOf(r) === sel.dataset.key);
      if (!row) return;
      if (sel.value === row.shape) delete st.draft[sel.dataset.key]; else st.draft[sel.dataset.key] = sel.value;
      paint();
      body.querySelector(`select[data-key="${CSS.escape(sel.dataset.key)}"]`)?.focus();
    }));
    $("#se2-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
    $("#se2-revert")?.addEventListener("click", () => { st.draft = {}; setStatus(""); paint(); });
    $("#se2-refresh")?.addEventListener("click", () => { if (dirty()) setStatus("Сначала сохраните или отмените правку."); else if (!st.busy) load(); });
    lock();
  }
  function lock() {
    el.querySelectorAll("#se2-form select, #se2-form button").forEach((c) => { c.disabled = st.busy || (c.tagName === "SELECT" && !canWrite); });
    if (!st.busy) { const s = $("#se2-save"), r = $("#se2-revert"); if (s) s.disabled = !dirty(); if (r) r.disabled = !dirty(); }
  }

  async function load() {
    const seq = ++st.seq;
    try {
      const data = await api.get(spec.endpoint);
      if (dead || seq !== st.seq) return;
      st.rows = Array.isArray(data) ? data : []; st.draft = {}; st.error = "";
    } catch (e) {
      if (dead || seq !== st.seq) return;
      if (st.rows === null) st.error = errText(e); else setStatus(`Формы не обновились: ${errText(e)}`);
    }
    paint();
  }

  async function save() {
    if (st.busy || !canWrite) return;
    const items = changed();
    if (!items.length) return;
    if (items.some((r) => !SHAPE_IDS.includes(cur(r)))) { setStatus("Неизвестная форма."); return; }
    const sent = items.map((r) => ({ layer: r.layer, element_type: r.element_type, shape: cur(r) }));
    st.busy = true; lock(); setStatus("Сохранение…");
    const confirmRead = async () => {
      const seq = ++st.seq;
      const again = await api.get(spec.endpoint);
      if (dead || seq !== st.seq) return null;
      return Array.isArray(again) ? again : [];
    };
    const applied = (again) => sent.filter((x) => again.some((r) => r.layer === x.layer && r.element_type === x.element_type && r.shape === x.shape)).length;
    try {
      await api.put(spec.put, sent);
      st.busy = false;
      try {
        const again = await confirmRead();
        if (again) {
          st.rows = again; st.draft = {};
          setStatus(applied(again) === sent.length ? `Сохранено и подтверждено чтением: ${sent.length} шт.` : "Сервер вернул другие формы для части пар — проверьте список.");
        }
      } catch { setStatus("Сохранено, но перечитать не удалось — нажмите «Обновить»."); }
      paint();
    } catch (e) {
      st.busy = false;
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        try {
          const again = await confirmRead();
          if (again && applied(again) === sent.length) { st.rows = again; st.draft = {}; setStatus("Сервер сохранил формы, хотя ответ не дошёл."); }
          else if (again) setStatus(`Изменения не подтверждены (${errText(e)}). Проверьте список и повторите вручную.`);
        } catch { setStatus(`Неизвестно, сохранены ли формы (${errText(e)}). Нажмите «Обновить» и проверьте.`); }
      } else setStatus(`Не удалось сохранить: ${errText(e)}`); // 4xx: введённое остаётся
      paint();
    }
  }

  $("#se2-search").addEventListener("input", (e) => { st.search = e.target.value; paint(); });
  paint();
  load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const choice = await showUnsavedDialog("Формы маркеров изменены, но не сохранены. Что сделать?");
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
