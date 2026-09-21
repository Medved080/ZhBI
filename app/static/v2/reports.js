// Отображение отчётов V2 (только чтение). Данные — те же ответы `POST /reports/*`, что и у V1: никаких расчётов
// здесь нет, только вёрстка присланного. Печать, выгрузка в XLSX/PDF и графики V1 в V2 пока не перенесены.
import { esc } from "./screen-view.js";
import { EXCHANGE_REPORT_RENDERERS, bindExchangeReport } from "./reports-exchange.js";

const num = (v) => (v == null ? "" : typeof v === "number" ? v.toLocaleString("ru-RU") : String(v));
const dateRu = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? "");
};

function cellByKind(col, row) {
  const v = row[col.key];
  if (v == null || v === "") return "";
  if (col.kind === "num") return esc(num(v));
  if (col.kind === "date") return esc(dateRu(v));
  if (col.kind === "status") return `<span class="v2-swatch" style="background:${esc(row.status_color || "#ccc")}" aria-hidden="true"></span> ${esc(v)}`;
  return esc(v);
}

function tableHtml(columns, rows, { cap = 500 } = {}) {
  const shown = rows.slice(0, cap);
  return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${columns.map((c) => `<td${c.kind === "num" ? ' class="num"' : ""}>${cellByKind(c, r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${shown.length} из ${rows.length}.</p>` : ""}`;
}

// ---- «Статус монтажа»: дерево захватка → этаж → тип с итогом. Свёрнуто всё, кроме первой захватки (как в V1).
export function defaultCollapsed(data) {
  const collapsed = new Set();
  (data?.rows || []).forEach((row, i) => {
    if (i > 0) collapsed.add(row.label);
    else (row.children || []).forEach((f, j) => { if (j > 0) collapsed.add(`${row.label}/${f.label}`); });
  });
  return collapsed;
}

function treeRows(nodes, path, columns, collapsed, out) {
  for (const n of nodes) {
    const p = path ? `${path}/${n.label}` : n.label;
    const hasKids = n.children && n.children.length;
    const isCollapsed = collapsed.has(p);
    out.push(`<tr class="lvl-${n.level}"><td style="padding-left:${12 + n.level * 18}px">
      ${hasKids ? `<button type="button" class="v2-tree-toggle" data-path="${esc(p)}" aria-expanded="${!isCollapsed}" aria-label="${isCollapsed ? "Развернуть" : "Свернуть"} ${esc(n.label)}">${isCollapsed ? "▸" : "▾"}</button>` : `<span class="v2-tree-toggle-gap"></span>`}${esc(n.label)}</td>
      ${columns.map((c) => `<td class="num">${esc(num(n.values?.[c.key]))}</td>`).join("")}</tr>`);
    if (hasKids && !isCollapsed) treeRows(n.children, p, columns, collapsed, out);
  }
}

function statusReport(data, state) {
  const collapsed = state.collapsed || (state.collapsed = defaultCollapsed(data));
  const out = [];
  treeRows(data.rows || [], "", data.columns || [], collapsed, out);
  const total = data.total;
  return `<div class="v2-read-table"><table class="v2-read-tbl v2-tree-tbl"><thead><tr><th>${esc(data.root_label || "")}</th>${(data.columns || []).map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${out.join("")}${total ? `<tr class="lvl-total"><td><strong>${esc(total.label)}</strong></td>${(data.columns || []).map((c) => `<td class="num"><strong>${esc(num(total.values?.[c.key]))}</strong></td>`).join("")}</tr>` : ""}</tbody></table></div>`;
}

// ---- «Статус комплектации» (перечень): плоская таблица, поиск и страницы на клиенте.
const PAGE = 200;
function completionReport(data, state) {
  const q = (state.search || "").trim().toLowerCase();
  const rows = q ? data.rows.filter((r) => Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))) : data.rows;
  const offset = Math.min(state.page || 0, Math.max(0, Math.ceil(rows.length / PAGE) - 1)) * PAGE;
  const pageRows = rows.slice(offset, offset + PAGE);
  const cols = data.columns.filter((c) => c.key !== "guid");
  return `${data.warning ? `<div class="v2-callout" role="note">${esc(data.warning)}</div>` : ""}
    <p class="v2-muted" role="status">${q ? `Найдено ${rows.length} из ${data.rows.length}` : `Позиций: ${data.rows.length}`}${data.total ? ` · ${esc(data.total.label)}: ${esc(num(data.total.count))} шт.` : ""}${rows.length ? ` · строки ${offset + 1}–${offset + pageRows.length}` : ""}</p>
    ${rows.length ? tableHtml(cols, pageRows, { cap: PAGE }) : `<p class="v2-muted">${q ? `Ничего не найдено по запросу «${esc(state.search)}».` : "Позиций нет."}</p>`}
    ${rows.length > PAGE ? `<div class="v2-bar"><button type="button" class="v2-btn" data-page="prev" ${offset <= 0 ? "disabled" : ""}>← Назад</button>
      <button type="button" class="v2-btn" data-page="next" ${offset + PAGE >= rows.length ? "disabled" : ""}>Дальше →</button></div>` : ""}`;
}

// ---- «Аналитическая справка»
const SEVERITY = { critical: "критично", warning: "внимание", info: "к сведению" };
const ANALYTICS_TABLES = [["stages", "Этапы СМР"], ["progress", "Ход по типам изделий"], ["front", "Фронт работ"], ["critical", "Критический путь поставки"]];
function analyticsReport(data) {
  const tiles = (data.tiles || []).map((t) => `<div class="v2-tile"><div class="v2-tile-value">${esc(t.value)}</div><div>${esc(t.label)}</div><div class="v2-muted">${esc(t.hint || "")}</div></div>`).join("");
  const concl = (data.conclusions || []).map((c) => `<li><span class="v2-chip v2-sev-${esc(c.severity)}">${esc(SEVERITY[c.severity] || c.severity)}</span> ${esc(c.text)}</li>`).join("");
  const tables = ANALYTICS_TABLES.map(([k, title]) => {
    const t = data[k];
    if (!t?.columns) return "";
    return `<h3 class="v2-report-h">${esc(title)}</h3>${(t.rows || []).length ? tableHtml(t.columns, t.rows) : `<p class="v2-muted">Нет данных.</p>`}`;
  }).join("");
  const gaps = data.capacity_gaps || [];
  return `<p class="v2-muted">${esc(data.object_name || "")} · на ${esc(dateRu(data.report_date))}, горизонт до ${esc(dateRu(data.horizon_end))}</p>
    ${data.disclaimer ? `<p class="v2-muted">${esc(data.disclaimer)}</p>` : ""}
    <div class="v2-tiles">${tiles}</div>
    <h3 class="v2-report-h">Выводы</h3>${concl ? `<ul class="v2-conclusions">${concl}</ul>` : `<p class="v2-muted">Выводов нет.</p>`}
    ${tables}
    ${gaps.length ? `<h3 class="v2-report-h">Не задана производительность завода</h3>${tableHtml([{ key: "counterparty", label: "Завод" }, { key: "element_type", label: "Тип изделия" }, { key: "elements", label: "Изделий", kind: "num" }], gaps)}` : ""}`;
}

// ---- «Динамика поставки и монтажа»: сводные числа и недельная таблица (график V1 в V2 не перенесён)
function dynamicsReport(data) {
  const labels = data.series_labels || {};
  const order = data.series_order || Object.keys(data.series || {});
  const weeks = data.weeks || [];
  const summary = (title, s) => s ? `<div class="v2-tile"><div class="v2-muted">${esc(title)}</div>
    <div>Всего: <strong>${esc(num(s.total))}</strong></div>
    <div>Нарастающим итогом: план ${esc(num(s.cumulative?.plan))}, факт ${esc(num(s.cumulative?.fact))}, отклонение ${esc(num(s.cumulative?.deviation))}</div>
    <div>За день: план ${esc(num(s.day?.plan))}, факт ${esc(num(s.day?.fact))}</div>
    ${s.percent != null ? `<div>Выполнено: ${esc(num(s.percent))} %</div>` : ""}</div>` : "";
  const cols = [{ key: "week", label: "Неделя с" }, ...order.map((k) => ({ key: k, label: labels[k] || k, kind: "num" }))];
  const rows = weeks.map((w, i) => Object.fromEntries([["week", dateRu(w)], ...order.map((k) => [k, (data.series?.[k] || [])[i]])]));
  const fin = data.finish;
  return `<p class="v2-muted">${esc(data.subtitle || "")} на ${esc(dateRu(data.report_date))}</p>
    <div class="v2-tiles">${summary("Монтаж", data.montage)}${summary("Поставка", data.delivery)}</div>
    ${fin?.montage ? `<p>Окончание монтажа: план ${esc(dateRu(fin.montage.plan))}${fin.montage.forecast ? `, прогноз ${esc(dateRu(fin.montage.forecast))} (${esc(num(fin.montage.deviation_days))} дн.)` : ""}.</p>` : ""}
    <h3 class="v2-report-h">Динамика по неделям</h3><p class="v2-muted">Значения по неделям таблицей; график V1 в новом интерфейсе пока не перенесён.</p>
    ${rows.length ? tableHtml(cols, rows, { cap: 200 }) : `<p class="v2-muted">Данных по неделям нет.</p>`}`;
}

// ---- «Моя работа»: что человек изменил за период (события журнала)
const timeNoMs = (v) => {
  const t = String(v ?? "");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" });
};
function myworkReport(data) {
  const rows = (data.rows || []).map((r) => ({ ...r, at_text: timeNoMs(r.at) }));
  const summary = (data.by_action || []).map((i) => `<li>${esc(i.title)}: <strong>${esc(num(i.count))}</strong></li>`).join("");
  return `<p class="v2-muted" role="status">Событий: ${esc(num(data.total))}${data.truncated ? ` (показаны ${esc(num(data.shown))} — сузьте период)` : ""} · период ${esc(dateRu(data.date_from))} — ${esc(dateRu(data.date_to))}</p>
    ${summary ? `<h3 class="v2-report-h">Сводка по действиям</h3><ul class="v2-summary-list">${summary}</ul>` : ""}
    <h3 class="v2-report-h">События</h3>
    ${rows.length ? tableHtml([{ key: "at_text", label: "Время" }, { key: "user_name", label: "Пользователь" }, { key: "action_title", label: "Действие" }, { key: "item", label: "Что" }, { key: "old_text", label: "Было" }, { key: "new_text", label: "Стало" }], rows, { cap: 300 }) : `<p class="v2-muted">За период событий нет.</p>`}`;
}

// ---- «Линейный трек»: список позиций WBS объекта без привязки к блоку (только просмотр)
function linearTrackReport(data) {
  const rows = (data.rows || []).map((r) => ({ ...r, wbs_text: (r.wbs || []).join(" › "), track_text: r.track_name || r.track_code || "" }));
  return `<p class="v2-muted" role="status">Позиций: ${esc(num(data.count ?? rows.length))}</p>
    ${rows.length ? tableHtml([{ key: "code", label: "Код" }, { key: "row_kind", label: "Вид строки" }, { key: "wbs_text", label: "Путь в WBS" }, { key: "unit", label: "Ед." }, { key: "track_text", label: "Трек" }], rows, { cap: 400 }) : `<p class="v2-muted">Позиций нет.</p>`}`;
}

// ---- «График работ по блокам» (вид «таблица»): группы → запланированные работы с планом, прогнозом и отклонением
const BW_STATUS = { plan: "план", in_progress: "в работе", done: "выполнено" };
const BW_COLS = [{ key: "код", label: "Код" }, { key: "название", label: "Работа" }, { key: "section_code", label: "Секция" }, { key: "level_floor", label: "Этаж" },
  { key: "plan_start", label: "План: начало", kind: "date" }, { key: "plan_end", label: "План: конец", kind: "date" },
  { key: "forecast_start", label: "Прогноз: начало", kind: "date" }, { key: "forecast_end", label: "Прогноз: конец", kind: "date" },
  { key: "deadline_label", label: "Сроки" }, { key: "percent", label: "%", kind: "num" }, { key: "status_text", label: "Статус" }];
function bsGroup(g) {
  const rows = (g.rows || []).map((r) => ({ ...r, status_text: BW_STATUS[r.status] || r.status || "" }));
  const kids = (g.children || []).map(bsGroup).join("");
  return `<h3 class="v2-report-h">${esc(g.label)} <span class="v2-muted">· работ: ${rows.length}</span></h3>${rows.length ? tableHtml(BW_COLS, rows, { cap: 300 }) : ""}${kids}`;
}
function blockScheduleReport(data) {
  const t = data.total || {};
  const pct = (v) => (v == null ? "—" : `${esc(num(Math.round(v * 1000) / 10))} %`);
  return `<p class="v2-muted" role="status">Всего работ: ${esc(num(t["всего"]))} · выполнено: ${esc(num(t["выполнено"]))} (${pct(t["доля_выполненных"])}) · отстают: ${esc(num(t["отстают"]))} · среднее отклонение: ${t["среднее_отклонение"] == null ? "—" : esc(num(t["среднее_отклонение"]))} · на ${esc(dateRu(data.today))}</p>
    ${(data.rows || []).length ? (data.rows || []).map(bsGroup).join("") : `<p class="v2-muted">Запланированных работ нет.</p>`}`;
}


// ---- «Учёт по блокам: статусы»: матрица «операция WBS × блок (секция/этаж)» с процентом на дату
function blockStatusReport(data, state) {
  const blocks = data.blocks || [];
  const leaves = [];
  const walk = (n) => { if (n.children?.length) n.children.forEach(walk); else leaves.push(n); };
  (data.tree || []).forEach(walk);
  const rows = state.all ? leaves : leaves.filter((l) => l.cells && Object.keys(l.cells).length);
  // шапка: секции (colspan) и уровни; блоки уже отсортированы сервером по секции и этажу
  const groups = [];
  for (const b of blocks) { const g = groups[groups.length - 1]; if (g && g.code === b.section_code) g.n++; else groups.push({ code: b.section_code, n: 1 }); }
  const cell = (c) => {
    if (c == null) return "";
    if (typeof c === "string") return esc(BW_STATUS[c] || c);
    const label = `${BW_STATUS[c.status] || c.status || ""}${c.deadline_label ? `, ${c.deadline_label}` : ""}`;
    return `<span title="${esc(label)}">${esc(num(c.percent))}</span>`;
  };
  const shown = rows.slice(0, 400);
  return `<p class="v2-muted" role="status">Блоков: ${blocks.length} · операций WBS: ${leaves.length}, с данными: ${leaves.filter((l) => l.cells && Object.keys(l.cells).length).length} · на ${esc(dateRu(data.report_date))}</p>
    <label class="v2-wire-check"><input type="checkbox" id="bs-all" ${state.all ? "checked" : ""}> Показать все операции WBS (по умолчанию — только с данными)</label>
    ${rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl v2-matrix"><thead>
      <tr><th rowspan="2">Код</th><th rowspan="2">Работа</th><th rowspan="2">Объект</th>${groups.map((g) => `<th colspan="${g.n}">${esc(g.code)}</th>`).join("")}</tr>
      <tr>${blocks.map((b) => `<th title="${esc(b.level_name)}">${esc(String(b.level_name).slice(0, 12))}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((l) => `<tr><td>${esc(l.code || "")}</td><td>${esc(l.name)}</td><td class="num">${cell(l.cells?.["объект"])}</td>${blocks.map((b) => `<td class="num">${cell(l.cells?.[String(b.id)])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${shown.length} из ${rows.length}.</p>` : ""}` : `<p class="v2-muted">Операций с данными нет.</p>`}`;
}

export const REPORT_RENDERERS = { status: statusReport, completion: completionReport, analytics: analyticsReport, dynamics: dynamicsReport, mywork: myworkReport, linear: linearTrackReport, blocksched: blockScheduleReport, blockstatus: blockStatusReport, ...EXCHANGE_REPORT_RENDERERS };

// Взаимодействие: сворачивание узлов дерева, страницы перечня. Возвращает true, если надо перерисовать.
export function bindReport(name, root, state, repaint) {
  bindExchangeReport(name, root, state, repaint);   // «График поставки» и «График контрактации и поставки» (reports-exchange.js)
  if (name === "status") {
    root.querySelectorAll(".v2-tree-toggle").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.path;
      if (state.collapsed.has(p)) state.collapsed.delete(p); else state.collapsed.add(p);
      repaint(p);
    }));
  }
  if (name === "blockstatus") {
    root.querySelector("#bs-all")?.addEventListener("change", (e) => { state.all = e.target.checked; repaint(); });
  }
  if (name === "completion") {
    root.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
      state.page = Math.max(0, (state.page || 0) + (b.dataset.page === "next" ? 1 : -1));
      repaint();
    }));
  }
}
