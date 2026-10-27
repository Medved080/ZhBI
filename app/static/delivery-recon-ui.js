// Отчёт «Сверка поставки по договорам» — общий экран V1 и V2 (2026-10-26; сервер: app/report_delivery_recon.py).
//
// Три вкладки — «Спецификация договора», «Факт поставки», «План поставки» — и отбор по контрагенту, договору и спецификации.
// Данные считает сервер; здесь только вёрстка присланного и кнопка «Выгрузить в Excel» (те же три вкладки листами одного файла).
// Зависимости передаются явно (глобалей у ES-модуля нет): транспорт и скачивание живут в каждой оболочке по-своему.
//
//   mountDeliveryRecon(host, { objectId, read(path, body) → Promise<json>, get(path) → Promise<json>,
//                              download(path, body, fileName) → Promise<void> })

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? ""); };
const SHOWN_ROWS = 500;   // экран не строит тысячи строк; полный состав — в Excel

const STYLE = `
.dr-root { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dr-filters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
.dr-filters label { display: flex; flex-direction: column; gap: 2px; font-size: 0.75rem; opacity: .8; min-width: 180px; }
.dr-filters select { font-size: 0.8125rem; padding: 5px 6px; }
.dr-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(128,128,128,.35); flex-wrap: wrap; }
.dr-tab { border: 1px solid transparent; border-bottom: 0; background: none; padding: 6px 12px; cursor: pointer; font: inherit; border-radius: 6px 6px 0 0; }
.dr-tab[aria-selected="true"] { border-color: rgba(128,128,128,.35); background: rgba(128,128,128,.12); font-weight: 600; }
.dr-note { font-size: 0.8125rem; opacity: .75; margin: 0; }
.dr-warn { font-size: 0.8125rem; color: #8a5a00; margin: 0; }
.dr-scroll { overflow: auto; max-height: 62vh; border: 1px solid rgba(128,128,128,.3); border-radius: 6px; }
.dr-table { border-collapse: collapse; width: 100%; font-size: 0.8125rem; }
.dr-table th, .dr-table td { padding: 4px 8px; border-bottom: 1px solid rgba(128,128,128,.2); white-space: nowrap; }
.dr-table th { position: sticky; top: 0; background: var(--surface, #eef2f7); text-align: left; font-weight: 600; z-index: 1; }
.dr-table td.num, .dr-table th.num { text-align: right; }
.dr-table td.date { text-align: center; }
.dr-table tfoot td { font-weight: 600; position: sticky; bottom: 0; background: var(--surface, #eef2f7); }
.dr-status { font-size: 0.8125rem; opacity: .8; }
.dr-head { display: flex; flex-direction: column; gap: 2px; font-size: 0.8125rem; max-height: 9.5rem; overflow: auto; }
.dr-head-row { display: flex; align-items: flex-start; gap: 10px; }
.dr-head-date { min-width: 6.5rem; padding: 1px 8px; text-align: center; background: #ffff00; color: #1a1d21; font-weight: 600; border-radius: 3px; }
.dr-head-date:empty::before { content: "не задан"; font-weight: 400; opacity: .7; }
.dr-overdue { color: #c0392b; font-weight: 600; }
`;

export function mountDeliveryRecon(host, { objectId, read, get, download }) {
  if (!document.getElementById("dr-style")) {
    const st = document.createElement("style");
    st.id = "dr-style"; st.textContent = STYLE;
    document.head.appendChild(st);
  }
  const state = { options: [], cp: "", ag: "", sp: "", tab: "spec", report: null, busy: false, error: "" };
  let dead = false;

  host.innerHTML = `<div class="dr-root">
    <div class="dr-filters">
      <label>Контрагент<select data-f="cp" aria-label="Контрагент"></select></label>
      <label>Договор<select data-f="ag" aria-label="Договор"></select></label>
      <label>Спецификация<select data-f="sp" aria-label="Спецификация"></select></label>
      <button type="button" class="btn btn-secondary v2-btn" data-act="xlsx">Выгрузить в Excel</button>
      <span class="dr-status" role="status" aria-live="polite"></span>
    </div>
    <p class="dr-warn" hidden></p>
    <div class="dr-tabs" role="tablist"></div>
    <p class="dr-note" hidden></p>
    <div class="dr-head" hidden></div>
    <div class="dr-scroll"><table class="dr-table"></table></div>
  </div>`;
  const $ = (sel) => host.querySelector(sel);
  const statusEl = $(".dr-status");

  const body = () => ({
    object_id: objectId,
    counterparty_id: state.cp ? Number(state.cp) : null,
    agreement_id: state.ag ? Number(state.ag) : null,
    specification_id: state.sp ? Number(state.sp) : null,
  });

  function fillFilters() {
    const cps = state.options;
    const cur = cps.find((c) => String(c.id) === state.cp);
    const ags = (cur ? cur.agreements : cps.flatMap((c) => c.agreements));
    const curAg = ags.find((a) => String(a.id) === state.ag);
    const sps = (curAg ? curAg.specifications : ags.flatMap((a) => a.specifications));
    const opt = (list, value, all) => `<option value="">${all}</option>` + list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("");
    $('[data-f="cp"]').innerHTML = opt(cps.map((c) => [c.id, c.name]), state.cp, "Все контрагенты");
    $('[data-f="ag"]').innerHTML = opt(ags.map((a) => [a.id, a.label]), state.ag, "Все договоры");
    $('[data-f="sp"]').innerHTML = opt(sps.map((s) => [s.id, s.label]), state.sp, "Все спецификации");
  }

  function drawTable() {
    const r = state.report;
    const tabsEl = $(".dr-tabs");
    if (!r) { $(".dr-table").innerHTML = ""; tabsEl.innerHTML = ""; return; }
    tabsEl.innerHTML = r.tabs.map((t) => `<button type="button" class="dr-tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === state.tab}">${esc(t.title)} <span class="dr-status">${t.rows.length}</span></button>`).join("");
    const tab = r.tabs.find((t) => t.id === state.tab) || r.tabs[0];
    const note = $(".dr-note");
    note.hidden = !tab.note; note.textContent = tab.note || "";
    // Аналитика над таблицей (у «Спецификации договора» — срок окончания поставки: атрибут спецификации, не колонка).
    const headEl = $(".dr-head");
    headEl.hidden = !(tab.header && tab.header.length);
    headEl.innerHTML = (tab.header || []).map((h) => `<div class="dr-head-row"><span class="dr-head-date">${esc(ruDate(h.value))}</span><span>${esc(h.label)}</span></div>`).join("");
    const warn = $(".dr-warn");
    warn.hidden = !r.warning; warn.textContent = r.warning || "";
    const cls = (c) => (c.kind === "num" ? "num" : c.kind === "date" ? "date" : "");
    const cell = (c, row) => {
      const v = row[c.key];
      if (v === null || v === undefined || v === "") return "";
      if (c.key === "status" && v === "Просрочено") return `<span class="dr-overdue">${esc(v)}</span>`;
      return c.kind === "date" ? ruDate(v) : c.kind === "num" ? Number(v).toLocaleString("ru-RU") : esc(v);
    };
    const shown = tab.rows.slice(0, SHOWN_ROWS);
    const totalCells = tab.columns.map((c, i) => {
      if (i === 0) return `<td>${esc(tab.total.label)}${"count" in tab.total ? `: ${tab.total.count.toLocaleString("ru-RU")}` : ""}</td>`;
      return `<td class="${cls(c)}">${c.key in tab.total ? Number(tab.total[c.key]).toLocaleString("ru-RU") : ""}</td>`;
    }).join("");
    $(".dr-table").innerHTML = `<thead><tr>${tab.columns.map((c) => `<th class="${cls(c)}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((row) => `<tr>${tab.columns.map((c) => `<td class="${cls(c)}">${cell(c, row)}</td>`).join("")}</tr>`).join("")
        || `<tr><td colspan="${tab.columns.length}" class="dr-status">Нет данных по выбранным условиям</td></tr>`}</tbody>
      <tfoot><tr>${totalCells}</tr></tfoot>`;
    if (tab.rows.length > SHOWN_ROWS) {
      statusEl.textContent = `Показаны первые ${SHOWN_ROWS} из ${tab.rows.length} строк вкладки — полный состав в Excel.`;
    } else if (!state.busy) statusEl.textContent = "";
    tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; drawTable(); }));
  }

  async function load() {
    state.busy = true; statusEl.textContent = "Считаю…";
    try {
      const r = await read("/reports/delivery-recon", body());
      if (dead) return;
      state.report = r; state.error = ""; statusEl.textContent = "";
    } catch (err) {
      if (dead) return;
      state.report = null; statusEl.textContent = err?.detail || err?.message || "Не удалось построить отчёт";
    }
    state.busy = false;
    drawTable();
  }

  host.addEventListener("change", (e) => {
    const f = e.target?.dataset?.f;
    if (!f) return;
    state[f] = e.target.value;
    // Выбор вышестоящего сбрасывает нижестоящие, если они ему больше не принадлежат.
    if (f === "cp") { state.ag = ""; state.sp = ""; }
    if (f === "ag") state.sp = "";
    fillFilters(); load();
  });
  $('[data-act="xlsx"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true; statusEl.textContent = "Готовлю файл…";
    try { await download("/reports/delivery-recon.xlsx", body(), "Сверка поставки по договорам.xlsx"); statusEl.textContent = ""; }
    catch (err) { statusEl.textContent = err?.detail || err?.message || "Не удалось выгрузить"; }
    btn.disabled = false;
  });

  (async () => {
    try {
      const o = await get(`/reports/delivery-recon/options?object_id=${encodeURIComponent(objectId)}`);
      if (dead) return;
      state.options = o.counterparties || [];
    } catch (err) { /* без списков фильтры просто «Все» */ }
    fillFilters(); load();
  })();

  return { hasUnsavedChanges: () => false, destroy() { dead = true; host.innerHTML = ""; } };
}
