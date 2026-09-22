// «Состояние БД»: список таблиц (как в V1) и просмотр строк одной таблицы (V1: db-table-backdrop, открывается
// щелчком по строке списка). Оба запроса — ЧТЕНИЕ (`GET /admin/db-status`, `GET /admin/db-status/tables/{table}`),
// шлюз записи не участвует. Секретные колонки сервер уже маскирует (MASK вместо значения) — здесь их не различать
// дополнительно, только показать как пришло.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const fmtSize = (n) => { const v = Number(n); if (!Number.isFinite(v)) return "?"; if (v >= 1 << 30) return `${(v / (1 << 30)).toFixed(1)} ГБ`; if (v >= 1 << 20) return `${(v / (1 << 20)).toFixed(1)} МБ`; if (v >= 1 << 10) return `${Math.round(v / (1 << 10))} КБ`; return `${v} Б`; };
const PAGE = 100;

export function mountDbStatusView(el, { screen, structure, objectId, api, groupTitle }) {
  el.className = "v2-page";
  let dead = false, seq = 0;
  const st = { tables: null, error: "", q: "", view: null }; // view: null (список) | {table, rows, columns, total, offset, error}

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Просмотр в новом интерфейсе.</strong> Список таблиц и просмотр их строк (секретные колонки замаскированы сервером). Изменение данных — в текущем интерфейсе.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="db-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  async function loadList() {
    const my = ++seq;
    try {
      const data = await api.get("/admin/db-status");
      if (dead || my !== seq) return;
      st.tables = data.tables; st.error = "";
    } catch (e) { if (dead || my !== seq) return; st.tables = null; st.error = errText(e); }
    paint();
  }

  function paintList() {
    const box = $("#db-body");
    if (!st.tables) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить список таблиц.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="db-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#db-retry")?.addEventListener("click", loadList);
      return;
    }
    const q = st.q.trim().toLowerCase();
    const rows = st.tables.filter((t) => !q || `${t.name} ${t.domain} ${t.caption}`.toLowerCase().includes(q));
    box.innerHTML = `<div class="v2-bar"><input type="search" id="db-search" class="v2-search" placeholder="Поиск таблицы" aria-label="Поиск таблицы" value="${esc(st.q)}">
        <span class="v2-muted" role="status" aria-live="polite">Найдено ${rows.length} из ${st.tables.length}</span>
        <button type="button" class="v2-btn" id="db-refresh">Обновить</button></div>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Таблица</th><th>Область</th><th class="num">Строк</th><th class="num">Размер</th><th>Описана</th></tr></thead><tbody>
        ${rows.map((t) => `<tr><td><button type="button" class="v2-link" data-open="${esc(t.name)}">${esc(t.name)}</button>${t.caption && t.caption !== t.name ? ` <span class="v2-muted">— ${esc(t.caption)}</span>` : ""}</td>
          <td>${esc(t.domain)}</td><td class="num">${Number(t.rows).toLocaleString("ru-RU")}</td><td class="num">${t.bytes != null ? esc(fmtSize(t.bytes)) : "—"}</td><td>${t.described ? "да" : "нет"}</td></tr>`).join("")}
      </tbody></table></div>`;
    $("#db-search").addEventListener("input", (e) => { st.q = e.target.value; paintList(); });
    $("#db-refresh").addEventListener("click", loadList);
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openTable(b.dataset.open)));
  }

  async function openTable(table, offset = 0) {
    st.view = { table, rows: null, columns: [], total: 0, offset, error: "" };
    paint();
    const my = ++seq;
    try {
      const data = await api.get(`/admin/db-status/tables/${encodeURIComponent(table)}?limit=${PAGE}&offset=${offset}`);
      if (dead || my !== seq || !st.view || st.view.table !== table) return;
      st.view = { table, rows: data.rows, columns: data.columns, total: data.total, offset: data.offset, error: "" };
    } catch (e) {
      if (dead || my !== seq || !st.view || st.view.table !== table) return;
      st.view.error = errText(e);
    }
    paint();
  }

  function paintTable() {
    const v = st.view;
    const box = $("#db-body");
    box.innerHTML = `<div class="v2-bar"><button type="button" class="v2-btn" id="db-back">← К списку таблиц</button><strong>${esc(v.table)}</strong></div>`;
    if (v.error) { box.innerHTML += `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить строки.</strong> ${esc(v.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="db-retry2">Повторить</button></div></div>`; $("#db-back").addEventListener("click", backToList); $("#db-retry2")?.addEventListener("click", () => openTable(v.table, v.offset)); return; }
    if (!v.rows) { box.innerHTML += `<p class="v2-muted" role="status">Загрузка…</p>`; $("#db-back").addEventListener("click", backToList); return; }
    box.innerHTML += `<p class="v2-muted">Строк ${v.total.toLocaleString("ru-RU")}, показаны ${v.offset + 1}–${v.offset + v.rows.length}.</p>
      <div class="v2-read-table" style="max-width:100%;overflow-x:auto"><table class="v2-read-tbl"><thead><tr>${v.columns.map((c) => `<th title="${esc(c.purpose || "")}">${esc(c.name)}${c.pk ? " 🔑" : ""}</th>`).join("")}</tr></thead><tbody>
        ${v.rows.map((row) => `<tr>${row.map((cell, i) => `<td>${cell.v == null ? `<span class="v2-muted">NULL</span>` : esc(cell.v) + (cell.full_len ? `<span class="v2-muted"> …(${cell.full_len})</span>` : "")}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div>
      <div class="v2-bar"><button type="button" class="v2-btn" id="db-prev" ${v.offset <= 0 ? "disabled" : ""}>← Назад</button>
        <button type="button" class="v2-btn" id="db-next" ${v.offset + v.rows.length >= v.total ? "disabled" : ""}>Дальше →</button></div>`;
    $("#db-back").addEventListener("click", backToList);
    $("#db-prev")?.addEventListener("click", () => openTable(v.table, Math.max(0, v.offset - PAGE)));
    $("#db-next")?.addEventListener("click", () => openTable(v.table, v.offset + PAGE));
  }
  function backToList() { st.view = null; paint(); }

  function paint() {
    if (dead) return;
    if (st.view) paintTable(); else paintList();
  }

  paint();
  loadList();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}
