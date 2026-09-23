// Мини-отчёты вкладки «Статус» рабочих мест ЖБИ. Числа берутся из тех же
// серверных отчётов, что и полноразмерные экраны; клиент только компонует их.
import { esc } from "./screen-view.js";
import { buildDynamicsChartSvg, defaultCollapsed, dynamicsChartLegendHtml } from "./reports.js";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v) => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ru-RU") : "—";
const signed = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}`;
const dateRu = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || ""); return m ? `${m[3]}.${m[2]}.${m[1]}` : v || ""; };
const DYN_MODE_SERIES = {
  montage: ["plan_smr", "fact_montage", "forecast_montage"],
  delivery: ["plan_delivery", "fact_delivery", "forecast_delivery"],
  both: ["plan_smr", "fact_montage", "forecast_montage", "plan_delivery", "fact_delivery", "forecast_delivery"],
};
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createWorkspaceMiniReports({ api, getObjectId, repaint, requestIds, openFull }) {
  let ids = null, key = "", seq = 0, loading = false;
  let date = today();
  let mode = "both", range = { from: null, to: null };
  let data = {}, errors = {};
  let tree = { collapsed: null };
  const expanded = new Set(["status", "deviation", "dynamics"]);

  function clear() {
    ++seq; ids = null; key = ""; data = {}; errors = {}; loading = false;
    tree = { collapsed: null };
    repaint();
  }

  function receive(nextIds, objectId) {
    if (objectId !== getObjectId() || !Array.isArray(nextIds)) return;
    const clean = nextIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    const nextKey = `${objectId}:${clean.join(",")}`;
    if (nextKey === key) return;
    ids = clean; key = nextKey; tree = { collapsed: null };
    load();
  }

  async function load() {
    const my = ++seq, objectId = getObjectId(), selected = ids;
    data = {}; errors = {}; loading = !!selected?.length;
    repaint();
    // Пустой список нельзя отправлять как element_ids: []: для отчётов это
    // значит «без сужения», то есть они показали бы ВЕСЬ объект вместо нуля.
    if (!selected?.length) { loading = false; repaint(); return; }
    const base = { object_id: objectId, element_ids: selected };
    const jobs = [
      ["status", "/reports/status", base],
      ["deviation", "/schedule-versions/deviation", base],
      ["dynamics", "/reports/dynamics", { ...base, report_date: date }],
    ];
    const answers = await Promise.allSettled(jobs.map(([, path, body]) => api.readPost(path, body)));
    if (my !== seq || objectId !== getObjectId()) return;
    answers.forEach((answer, i) => {
      const kind = jobs[i][0];
      if (answer.status === "fulfilled") data[kind] = answer.value;
      else errors[kind] = answer.reason?.status === 403 ? "Нет права читать этот отчёт." : (answer.reason?.detail || answer.reason?.message || "Не удалось построить отчёт.");
    });
    loading = false;
    repaint();
  }

  function section(kind, title, contents, full = false) {
    return `<section class="ws-mini-section side-report"><div class="side-section-head"><h3>${title}</h3>${full ? `<button type="button" class="side-report-open" data-mini-full="${kind}" title="Открыть полный отчёт" aria-label="Открыть полный отчёт «${title}»">⤢</button>` : ""}<button type="button" class="filter-expand-btn" data-mini-toggle="${kind}" aria-expanded="${expanded.has(kind)}" title="Свернуть/развернуть">${expanded.has(kind) ? "▾" : "▸"}</button></div>
      ${expanded.has(kind) ? `<div class="ws-mini-content">${loading ? `<p class="v2-muted">Построение…</p>` : errors[kind] ? `<p class="ws-mini-error">${esc(errors[kind])}</p>` : contents}</div>` : ""}</section>`;
  }

  function statusHtml() {
    const d = data.status;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    if (!tree.collapsed) tree.collapsed = defaultCollapsed(d);
    if (!d.rows?.length) return `<p class="v2-muted">Нет данных.</p>`;
    const columns = d.columns || [];
    const row = (n, path) => {
      const children = n.children || [], closed = tree.collapsed.has(path);
      return `<tr class="lvl-${n.level}"><td style="padding-left:${8 + n.level * 8}px"><button type="button" class="report-toggle${children.length ? "" : " empty"}" data-mini-tree="${esc(path)}" aria-expanded="${!closed}">${closed ? "▸" : "▾"}</button>${esc(n.label)}</td>${columns.map((c) => `<td class="num">${n.values?.[c.key] || ""}</td>`).join("")}</tr>`
        + (closed ? "" : children.map((ch) => row(ch, `${path}/${ch.label}`)).join(""));
    };
    const total = d.total || { label: "Итого", values: {} };
    return `<div class="hint-text side-status-line">Всего изделий: ${total.values?.total ?? ids?.length}</div>
      <div class="legend-table-wrap ws-mini-table"><table class="side-table side-tree"><thead><tr><th>${esc(d.root_label || "")}</th>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
      ${d.rows.map((r) => row(r, r.label)).join("")}<tr class="total"><td>${esc(total.label)}</td>${columns.map((c) => `<td class="num">${total.values?.[c.key] || ""}</td>`).join("")}</tr></tbody></table></div>`;
  }

  function deviationHtml() {
    const d = data.deviation;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    if (!d.version_id) return `<p class="v2-muted">Актуализированный график ещё не загружен — сравнивать не с чем.</p>`;
    if (!d.elements) return `<p class="v2-muted">В текущем отборе нет изделий из этой версии графика.</p>`;
    const row = (label, b) => !b ? `<tr><td>${esc(label)}</td><td colspan="3" class="hint-text">нет дат</td></tr>`
      : `<tr><td>${esc(label)}</td><td class="${b.avg > 0 ? "dev-late" : b.avg < 0 ? "dev-early" : "dev-ok"}">${signed(b.avg)}</td><td class="${b.max > 0 ? "dev-late" : b.max < 0 ? "dev-early" : "dev-ok"}">${signed(b.max)}</td><td>${b.late}</td></tr>`;
    return `<div class="hint-text">${esc(d.version_title || "последняя актуализация")} · изделий в сравнении: ${d.elements}</div>
      <table class="side-table side-dyn"><tr><th></th><th title="Среднее отклонение, дней">сред.</th><th title="Наибольшее отклонение, дней">макс.</th><th title="Сколько изделий отстаёт">отстаёт</th></tr>${row("Начало СМР", d.start)}${row("Завершение", d.end)}</table>
      ${(d.by_zakhvatka || []).length > 1 ? `<table class="side-table side-dyn" style="margin-top:6px"><tr><th>Захватка</th><th>сред.</th><th>макс.</th><th>отстаёт</th></tr>${d.by_zakhvatka.map((z) => row(z.label, z.end)).join("")}</table>` : ""}`;
  }

  function dynBlock(title, b, reportDate) {
    if (!b) return "";
    const dev = (v) => `<td class="${v < 0 ? "dyn-neg" : ""}">${signed(v)}</td>`;
    return `<div class="side-dyn-block"><h4>${esc(title)}<b>${b.percent}% (${b.cumulative.fact} из ${b.total})</b></h4>
      <table class="side-table side-dyn"><tr><th></th><th>План</th><th>Факт</th><th>Откл.</th></tr>
      <tr><td>Итого</td><td>${b.cumulative.plan}</td><td>${b.cumulative.fact}</td>${dev(b.cumulative.deviation)}</tr>
      <tr><td>${esc(dateRu(reportDate))}</td><td>${b.day.plan}</td><td>${b.day.fact}</td>${dev(b.day.deviation)}</tr></table></div>`;
  }

  function noteBox(title, items) {
    return `<details><summary>${esc(title)}${items?.length ? ` (${items.length})` : ""}</summary>${items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="dyn-empty">не заполнено</div>`}</details>`;
  }

  function chartWindow(d) {
    const from = range.from ? mondayOf(range.from) : null, to = range.to ? mondayOf(range.to) : null;
    const keep = (d.weeks || []).map((_, i) => i).filter((i) => (!from || d.weeks[i] >= from) && (!to || d.weeks[i] <= to));
    const pick = (arr) => keep.map((i) => arr[i]);
    return { ...d, weeks: pick(d.weeks || []),
      series: Object.fromEntries(Object.entries(d.series || {}).map(([k, v]) => [k, pick(v)])),
      series_order: DYN_MODE_SERIES[mode] || DYN_MODE_SERIES.both };
  }

  function dynamicsHtml() {
    const d = data.dynamics;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    const first = d.weeks?.[0] || "", last = d.weeks?.at(-1) || "";
    const windowed = chartWindow(d), cov = d.plan_coverage || {}, warns = [];
    if (cov.smr < cov.total) warns.push(`СМР — у ${cov.smr} из ${cov.total}`);
    if (cov.delivery < cov.total) warns.push(`поставка — у ${cov.delivery} из ${cov.total}`);
    return `<div class="side-report-controls"><label>Показывать <select data-mini-mode><option value="both" ${mode === "both" ? "selected" : ""}>поставку и монтаж</option><option value="delivery" ${mode === "delivery" ? "selected" : ""}>только поставку</option><option value="montage" ${mode === "montage" ? "selected" : ""}>только монтаж</option></select></label>
      <label>На дату <input type="date" data-mini-date value="${esc(d.report_date || date)}"></label>
      <label>Период <input type="date" data-mini-from min="${esc(first)}" max="${esc(last)}" value="${esc(range.from || first)}"><span>—</span><input type="date" data-mini-to min="${esc(first)}" max="${esc(last)}" value="${esc(range.to || last)}"></label>
      <button type="button" class="link-btn" data-mini-range-reset ${range.from || range.to ? "" : "hidden"}>весь проект</button></div>
      <div class="side-chart">${windowed.weeks.length ? buildDynamicsChartSvg(windowed, 280, 150, { compact: true }) : `<div class="hint-text">В выбранном периоде нет ни одной недели</div>`}</div>
      ${dynamicsChartLegendHtml(windowed)}
      ${warns.length ? `<div class="side-dyn-warn">План задан не у всех изделий (${esc(warns.join("; "))}) — кривая плана неполная.</div>` : ""}
      ${dynBlock("Монтаж ЖБИ", d.montage, d.report_date)}${dynBlock("Поставка ЖБИ", d.delivery, d.report_date)}
      <div class="side-dyn-notes">${noteBox("Ключевые события", d.card?.key_events)}${noteBox("Ключевые задачи", d.card?.key_tasks)}${noteBox("Открытые вопросы", d.card?.open_questions)}</div>`;
  }

  function html() {
    if (ids === null) return `<div class="ws-pad"><p class="v2-muted">Получаем состав показанных изделий…</p></div>`;
    if (!ids.length) return `<div class="ws-pad"><p class="v2-muted">В текущем отборе нет изделий.</p></div>`;
    const reportTotal = data.status?.total?.values?.total;
    const scopeNote = Number.isInteger(reportTotal) && reportTotal !== ids.length
      ? `<p class="v2-muted ws-mini-scope">Отчёты учитывают ${num(reportTotal)} изделий актуального чертежа из ${num(ids.length)} показанных в срезе.</p>` : "";
    return `<div class="ws-pad ws-mini">${scopeNote}
      ${section("status", "Статус монтажа", statusHtml(), true)}
      ${section("deviation", "Отклонение от базового графика", deviationHtml())}
      ${section("dynamics", "Отчёт о динамике поставки и монтажа", dynamicsHtml(), true)}</div>`;
  }

  function bind(root) {
    root.querySelectorAll("[data-mini-toggle]").forEach((b) => b.addEventListener("click", () => {
      const kind = b.dataset.miniToggle;
      expanded.has(kind) ? expanded.delete(kind) : expanded.add(kind);
      repaint();
    }));
    root.querySelectorAll("[data-mini-full]").forEach((b) => b.addEventListener("click", () => openFull(b.dataset.miniFull, ids, data.dynamics?.report_date || date)));
    root.querySelector("[data-mini-date]")?.addEventListener("change", (e) => { date = e.target.value || today(); load(); });
    root.querySelector("[data-mini-mode]")?.addEventListener("change", (e) => { mode = e.target.value; repaint(); });
    root.querySelector("[data-mini-from]")?.addEventListener("change", (e) => { range.from = e.target.value || null; repaint(); });
    root.querySelector("[data-mini-to]")?.addEventListener("change", (e) => { range.to = e.target.value || null; repaint(); });
    root.querySelector("[data-mini-range-reset]")?.addEventListener("click", () => { range = { from: null, to: null }; repaint(); });
    root.querySelectorAll("[data-mini-tree]").forEach((b) => b.addEventListener("click", () => {
      const path = b.dataset.miniTree;
      tree.collapsed.has(path) ? tree.collapsed.delete(path) : tree.collapsed.add(path);
      repaint();
    }));
  }

  return { clear, receive, html, bind, refresh: () => { requestIds(); if (ids !== null) load(); } };
}
