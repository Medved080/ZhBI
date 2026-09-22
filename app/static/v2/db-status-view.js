// «Состояние БД» — перенос окна V1 (db-status-backdrop + db-table-backdrop, app.js renderDbStatus/loadDbTable) целиком:
// сводка о файле базы; КРАСНАЯ плашка расхождения описания структуры с реальной схемой (app/db_schema_doc.py — после миграции
// поле забыли описать; сборка SQLite без dbstat); таблицы по областям (порядок легенды схемы), внутри области — по объёму
// (данные + индексы) с полоской-гистограммой; раскрытие таблицы — описания полей (ключ, тип, назначение; «есть в базе, не
// описано», «описано, но в базе нет») и связи «Ссылается на»; просмотр строк — подписи назначения колонок, заметка о скрытых
// колонках, выбор размера страницы 50/100/200/500. Поиск по таблицам — дополнение V2.
// Оба запроса — ЧТЕНИЕ (`GET /admin/db-status`, `GET /admin/db-status/tables/{table}`), шлюз записи не участвует. Секретные
// колонки маскирует сервер.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
// Ноль осмыслен (пустая таблица — 0 Б), «неизвестно» (сборка без dbstat) — прочерк; как formatDbSize в V1
const fmtSize = (n) => { if (n === null || n === undefined) return "—"; const v = Number(n); if (v >= 1048576) return `${(v / 1048576).toFixed(2)} МБ`; if (v >= 1024) return `${(v / 1024).toFixed(1)} КБ`; return `${v} Б`; };
const LIMITS = [50, 100, 200, 500];
const vol = (t) => (t.bytes || 0) + (t.index_bytes || 0);

export function mountDbStatusView(el, { screen, structure, objectId, api, groupTitle }) {
  el.className = "v2-page";
  let dead = false, seq = 0;
  // view: null (список) | {table, rows, columns, total, offset, limit, error}
  const st = { data: null, error: "", q: "", open: new Set(), view: null, limit: 50 };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Только просмотр.</strong> Структура базы, объём таблиц, описания полей и содержимое таблиц (секретные колонки скрыты сервером). Изменить данные отсюда нельзя — как и в текущем интерфейсе.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="db-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  async function loadList() {
    const my = ++seq;
    try {
      const data = await api.get("/admin/db-status");
      if (dead || my !== seq) return;
      st.data = data; st.error = "";
    } catch (e) { if (dead || my !== seq) return; st.data = null; st.error = errText(e); }
    paint();
  }

  function summaryHtml(d) {
    const b = d.database;
    const rows = d.tables.reduce((s, t) => s + (Number(t.rows) || 0), 0);
    const fact = (k, v) => `<dt class="v2-muted">${esc(k)}</dt><dd style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace">${v}</dd>`;
    return `<dl id="db-summary" style="display:grid;grid-template-columns:auto 1fr;gap:3px 14px;margin:8px 0;font-size:13px">
      ${fact("Файл базы", esc(b.path))}${fact("Размер файла", esc(fmtSize(b.file_bytes)))}
      ${fact("Страниц", `${esc(b.page_count)} × ${esc(b.page_size)} Б, свободно ${esc(fmtSize(b.free_bytes))}`)}
      ${fact("Всего записей", rows.toLocaleString("ru-RU"))}${fact("Таблиц", `${d.tables.length}, связей ${(d.relations || []).length}`)}
      ${fact("SQLite", esc(b.sqlite_version))}</dl>`;
  }
  // Расхождение описания с реальной схемой — не украшение: так видно, что после миграции поле забыли описать (как в V1).
  function driftHtml(d) {
    const warn = [...(d.drift || [])];
    if (!d.database.sizes_available) warn.push("Эта сборка SQLite без dbstat — объём по таблицам не показан (оценка по длине значений не учла бы индексы и служебные страницы и разошлась бы с размером файла в разы).");
    if (!warn.length) return "";
    return `<div class="v2-callout v2-callout-bad" role="alert" id="db-drift"><strong>Описание структуры отстало от базы:</strong>
      <ul style="margin:4px 0 0;padding-left:18px">${warn.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
      <p class="v2-muted" style="margin:6px 0 0">Дописать поле вместе с его назначением — <code>app/db_schema_doc.py</code>, затем пересобрать схему <code>python3 scripts/gen_db_schema_drawio.py</code>.</p></div>`;
  }
  function tableHtml(t, max, d) {
    const rel = (d.relations || []).filter((r) => r.child === t.name).map((r) => `${r.child_field} → ${r.parent}.${r.parent_field} (${r.note})`);
    const open = st.open.has(t.name);
    const caption = String(t.caption || "").replace(`${t.name} — `, "");
    const pct = Math.round((100 * vol(t)) / max);
    return `<div class="v2-dbs-table" data-table="${esc(t.name)}" style="border:1px solid var(--line);border-left:4px solid ${esc(t.stroke || "var(--line)")};border-radius:6px;margin:0 0 6px">
      <div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto auto auto;gap:12px;align-items:center;padding:6px 10px">
        <button type="button" class="v2-link" data-toggle="${esc(t.name)}" aria-expanded="${open}" style="text-align:left;min-width:0">
          <strong>${esc(t.name)}</strong> <span class="v2-muted">${esc(caption)}</span>${t.described ? "" : ` <span class="v2-chip" style="color:var(--bad);border-color:var(--bad)">не описана</span>`}</button>
        <span class="num v2-muted" style="font-size:12px">${Number(t.rows).toLocaleString("ru-RU")} зап.</span>
        <span class="num v2-muted" style="font-size:12px">${esc(fmtSize(t.bytes))}${t.index_bytes ? ` + ${esc(fmtSize(t.index_bytes))} индексы` : ""}</span>
        <span aria-hidden="true" style="width:90px;height:6px;border-radius:3px;background:var(--surface);overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:var(--accent)"></span></span>
        <button type="button" class="v2-btn" data-open="${esc(t.name)}">Содержимое…</button>
      </div>
      ${open ? `<div class="v2-dbs-fields" style="border-top:1px dashed var(--line);padding:6px 10px 8px;font-size:12px">
        ${(t.fields || []).map((f) => `<div style="display:grid;grid-template-columns:190px 90px 1fr;gap:8px;padding:2px 0">
          <div>${f.key ? `<strong>${esc(String(f.key).replace(",", "+"))}</strong> ` : ""}<code>${esc(f.name)}</code></div>
          <div class="v2-muted" style="font-family:ui-monospace,Menlo,Consolas,monospace">${esc(f.type)}</div>
          <div${f.undocumented ? ' style="color:var(--bad)"' : ""}>${f.undocumented ? "есть в базе, назначение не описано" : esc(f.purpose)}${f.in_db ? "" : ' <span style="color:var(--bad)">— описано, но в базе такого поля нет</span>'}</div></div>`).join("")}
        ${rel.length ? `<div class="v2-muted" style="margin-top:6px">Ссылается на: ${esc(rel.join("; "))}</div>` : ""}</div>` : ""}
    </div>`;
  }

  function paintList() {
    const box = $("#db-body");
    const d = st.data;
    if (!d) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить состояние базы.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="db-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#db-retry")?.addEventListener("click", loadList);
      return;
    }
    const q = st.q.trim().toLowerCase();
    const shown = d.tables.filter((t) => !q || `${t.name} ${t.domain} ${t.caption}`.toLowerCase().includes(q));
    const max = Math.max(...d.tables.map(vol), 1);
    // Порядок областей — как в легенде схемы; область вне легенды — в конце; внутри — по объёму (данные + индексы)
    const groups = (d.domains || []).map((title) => ({ title, tables: [] }));
    for (const t of shown) { let g = groups.find((x) => x.title === t.domain); if (!g) groups.push(g = { title: t.domain, tables: [] }); g.tables.push(t); }
    box.innerHTML = summaryHtml(d) + driftHtml(d) + `
      <div class="v2-bar"><input type="search" id="db-search" class="v2-search" placeholder="Поиск таблицы" aria-label="Поиск таблицы" value="${esc(st.q)}">
        <span class="v2-muted" role="status" aria-live="polite">Найдено ${shown.length} из ${d.tables.length}</span>
        <button type="button" class="v2-btn" id="db-refresh">Обновить</button>
        <span class="v2-muted">Щелчок по названию — описания полей и связи.</span></div>
      ${groups.filter((g) => g.tables.length).map((g) => `<section class="v2-dbs-group"><h3 class="v2-report-h" style="margin:14px 0 6px">${esc(g.title)}</h3>
        ${g.tables.sort((a, b) => vol(b) - vol(a)).map((t) => tableHtml(t, max, d)).join("")}</section>`).join("") || `<p class="v2-muted">Ничего не найдено.</p>`}`;
    $("#db-search").addEventListener("input", (e) => { const pos = e.target.selectionStart; st.q = e.target.value; paintList(); const n = $("#db-search"); n.focus(); n.setSelectionRange(pos, pos); });
    $("#db-refresh").addEventListener("click", loadList);
    box.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.toggle; st.open.has(n) ? st.open.delete(n) : st.open.add(n); paintList();
      $(`[data-toggle="${CSS.escape(n)}"]`)?.focus();
    }));
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openTable(b.dataset.open)));
  }

  async function openTable(table, offset = 0) {
    st.view = { table, rows: null, columns: [], total: 0, offset, limit: st.limit, error: "" };
    paint();
    const my = ++seq;
    try {
      const data = await api.get(`/admin/db-status/tables/${encodeURIComponent(table)}?limit=${st.limit}&offset=${offset}`);
      if (dead || my !== seq || !st.view || st.view.table !== table) return;
      st.view = { table, rows: data.rows, columns: data.columns, total: data.total, offset: data.offset, limit: st.limit, error: "" };
    } catch (e) {
      if (dead || my !== seq || !st.view || st.view.table !== table) return;
      st.view.error = errText(e);
    }
    paint();
  }

  function paintTable() {
    const v = st.view;
    const box = $("#db-body");
    const head = `<div class="v2-bar"><button type="button" class="v2-btn" id="db-back">← К списку таблиц</button><strong>Таблица ${esc(v.table)}</strong>
      <label class="v2-muted">Строк на странице <select id="db-limit" aria-label="Строк на странице">${LIMITS.map((n) => `<option value="${n}" ${n === st.limit ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>`;
    if (v.error) { box.innerHTML = head + `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить строки.</strong> ${esc(v.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="db-retry2">Повторить</button></div></div>`; bindTable(); $("#db-retry2")?.addEventListener("click", () => openTable(v.table, v.offset)); return; }
    if (!v.rows) { box.innerHTML = head + `<p class="v2-muted" role="status">Загрузка…</p>`; bindTable(); return; }
    const masked = v.columns.filter((c) => c.masked).map((c) => c.name);
    const from = v.total ? v.offset + 1 : 0;
    box.innerHTML = head + `<p class="v2-muted" id="db-table-note">${masked.length ? `Значения скрыты: ${esc(masked.join(", "))} — это материал для входа под чужой учётной записью.` : "Только просмотр: изменить данные отсюда нельзя."}</p>
      ${v.rows.length ? `<div class="v2-read-table" style="max-width:100%;overflow-x:auto"><table class="v2-read-tbl" style="white-space:nowrap"><thead><tr>${v.columns.map((c) => `<th>${esc(c.name)}${c.pk ? " 🔑" : ""}${c.purpose ? `<small style="display:block;font-weight:400;white-space:normal;max-width:220px" class="v2-muted">${esc(c.purpose)}</small>` : ""}</th>`).join("")}</tr></thead><tbody>
        ${v.rows.map((row) => `<tr>${row.map((cell) => `<td>${cell.v == null ? `<span class="v2-muted"><i>NULL</i></span>` : esc(cell.v) + (cell.full_len ? `<span class="v2-muted"> … всего ${esc(cell.full_len)} симв.</span>` : "")}</td>`).join("")}</tr>`).join("")}
      </tbody></table></div>` : `<p class="v2-muted">Таблица пуста.</p>`}
      <div class="v2-bar"><button type="button" class="v2-btn" id="db-prev" ${v.offset <= 0 ? "disabled" : ""}>← Назад</button>
        <span class="v2-muted" id="db-range">${from}–${v.offset + v.rows.length} из ${Number(v.total).toLocaleString("ru-RU")}</span>
        <button type="button" class="v2-btn" id="db-next" ${v.offset + v.limit >= v.total ? "disabled" : ""}>Вперёд →</button></div>`;
    bindTable();
  }
  function bindTable() {
    const v = st.view;
    $("#db-back").addEventListener("click", backToList);
    $("#db-limit")?.addEventListener("change", (e) => { st.limit = Number(e.target.value); openTable(v.table, 0); });
    $("#db-prev")?.addEventListener("click", () => openTable(v.table, Math.max(0, v.offset - v.limit)));
    $("#db-next")?.addEventListener("click", () => openTable(v.table, v.offset + v.limit));
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
