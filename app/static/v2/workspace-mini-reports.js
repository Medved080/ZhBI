// Мини-отчёты вкладки «Статус» рабочих мест ЖБИ. Числа берутся из тех же
// серверных отчётов, что и полноразмерные экраны; клиент только компонует их.
import { esc } from "./screen-view.js";
import { buildDynamicsChartSvg, defaultCollapsed, REPORT_RENDERERS } from "./reports.js";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v) => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v).toLocaleString("ru-RU") : "—";
const signed = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}`;

export function createWorkspaceMiniReports({ api, getObjectId, repaint, requestIds, openFull }) {
  let ids = null, key = "", seq = 0, loading = false;
  let date = today();
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
    return `<section class="ws-mini-section"><div class="ws-mini-head"><button type="button" data-mini-toggle="${kind}" aria-expanded="${expanded.has(kind)}">${expanded.has(kind) ? "▾" : "▸"} ${title}</button>${full ? `<button type="button" class="ws-mini-full" data-mini-full="${kind}" title="Открыть полный отчёт с тем же отбором" aria-label="Открыть полный отчёт «${title}»">⤢</button>` : ""}</div>
      ${expanded.has(kind) ? `<div class="ws-mini-content">${loading ? `<p class="v2-muted">Построение…</p>` : errors[kind] ? `<p class="ws-mini-error">${esc(errors[kind])}</p>` : contents}</div>` : ""}</section>`;
  }

  function statusHtml() {
    const d = data.status;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    if (!tree.collapsed) tree.collapsed = defaultCollapsed(d);
    return `<p class="v2-muted">Всего изделий: ${num(d.total?.values?.total ?? ids?.length)}</p>
      <div class="ws-mini-table">${REPORT_RENDERERS.status(d, tree)}</div>`;
  }

  function deviationHtml() {
    const d = data.deviation;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    if (!d.version_id) return `<p class="v2-muted">Актуализированный график ещё не загружен.</p>`;
    if (!d.elements) return `<p class="v2-muted">В текущем отборе нет изделий из этой версии графика.</p>`;
    const rows = [["Начало СМР", d.start], ["Завершение", d.end], ...((d.by_zakhvatka || []).length > 1
      ? d.by_zakhvatka.map((z) => [z.label, z.end]) : [])];
    return `<p class="v2-muted">${esc(d.version_title || "Последняя актуализация")} · изделий ${num(d.elements)}</p>
      <div class="ws-mini-table"><table><thead><tr><th></th><th>сред.</th><th>макс.</th><th>отстаёт</th></tr></thead><tbody>${rows.map(([label, b]) => `<tr><th>${esc(label)}</th><td>${signed(b?.avg)}</td><td>${signed(b?.max)}</td><td>${b ? num(b.late) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function dynBlock(title, b) {
    if (!b) return "";
    return `<div class="ws-mini-kpi"><strong>${title}</strong><span>${num(b.cumulative?.fact)} из ${num(b.total)} · ${num(b.percent)}%</span>
      <small>План ${num(b.cumulative?.plan)} · отклонение ${signed(b.cumulative?.deviation)}</small></div>`;
  }

  function dynamicsHtml() {
    const d = data.dynamics;
    if (!d) return `<p class="v2-muted">Нет данных.</p>`;
    return `<label class="ws-mini-date">На дату <input type="date" data-mini-date value="${esc(d.report_date || date)}"></label>
      <div class="ws-mini-chart">${buildDynamicsChartSvg(d, 300, 175)}</div>
      ${dynBlock("Монтаж ЖБИ", d.montage)}${dynBlock("Поставка ЖБИ", d.delivery)}`;
  }

  function html() {
    if (ids === null) return `<div class="ws-pad"><h3 class="ws-h">Отчёты по текущему отбору</h3><p class="v2-muted">Получаем состав показанных изделий…</p></div>`;
    if (!ids.length) return `<div class="ws-pad"><h3 class="ws-h">Отчёты по текущему отбору</h3><p class="v2-muted">В текущем отборе нет изделий.</p></div>`;
    const reportTotal = data.status?.total?.values?.total;
    const scopeNote = Number.isInteger(reportTotal) && reportTotal !== ids.length
      ? `<p class="v2-muted ws-mini-scope">Отчёты учитывают ${num(reportTotal)} изделий актуального чертежа из ${num(ids.length)} показанных в срезе.</p>` : "";
    return `<div class="ws-pad ws-mini"><div class="ws-mini-intro"><div><h3 class="ws-h">Отчёты по текущему отбору</h3><p class="v2-muted">${num(ids.length)} изделий на схеме</p></div><button type="button" class="v2-btn" data-mini-refresh ${loading ? "disabled" : ""}>Обновить</button></div>
      ${scopeNote}
      ${section("status", "Статус монтажа", statusHtml(), true)}
      ${section("deviation", "Отклонение от графика", deviationHtml())}
      ${section("dynamics", "Динамика", dynamicsHtml(), true)}</div>`;
  }

  function bind(root) {
    root.querySelectorAll("[data-mini-toggle]").forEach((b) => b.addEventListener("click", () => {
      const kind = b.dataset.miniToggle;
      expanded.has(kind) ? expanded.delete(kind) : expanded.add(kind);
      repaint();
    }));
    root.querySelectorAll("[data-mini-full]").forEach((b) => b.addEventListener("click", () => openFull(b.dataset.miniFull, ids)));
    root.querySelector("[data-mini-refresh]")?.addEventListener("click", () => { requestIds(); load(); });
    root.querySelector("[data-mini-date]")?.addEventListener("change", (e) => { date = e.target.value || today(); load(); });
    root.querySelectorAll(".v2-tree-toggle").forEach((b) => b.addEventListener("click", () => {
      const path = b.dataset.path;
      tree.collapsed.has(path) ? tree.collapsed.delete(path) : tree.collapsed.add(path);
      repaint();
    }));
  }

  return { clear, receive, html, bind, refresh: () => { requestIds(); if (ids !== null) load(); } };
}
