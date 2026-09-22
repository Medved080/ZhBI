// Отображение отчётов V2 (только чтение). Данные — те же ответы `POST /reports/*`, что и у V1: никаких расчётов
// здесь нет, только вёрстка присланного. Выгрузка в XLSX/PDF и печать — в read-screen.js; графики (SVG, свой код,
// без сторонней библиотеки — перенос из V1: app.js buildDynamicsChartSvg/anChartHtml) — здесь же, у «Динамики» и
// «Аналитической справки», единственных двух отчётов V1 с графиком.
import { esc } from "./screen-view.js";
import { EXCHANGE_REPORT_RENDERERS, bindExchangeReport } from "./reports-exchange.js";
import { registerChartHover, ensureChartHoverListener } from "./chart-hover.js";

ensureChartHoverListener();

const num = (v) => (v == null ? "" : typeof v === "number" ? v.toLocaleString("ru-RU") : String(v));
const dateRu = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? "");
};
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };

// ==================== графики (перенос из V1, app.js) ====================
//
// Пары «план — факт» одного цвета, различаются штрихом (план — пунктир): на графике из четырёх кривых видно,
// что синие — про монтаж, а оранжевые — про поставку. Те же цвета и штрихи в PDF (app/reports.py, DYN_SERIES_COLORS).
const DYN_COLORS = { plan_smr: "#4A86C8", fact_montage: "#8C99A6", forecast_montage: "#8C99A6", plan_delivery: "#C2571A", fact_delivery: "#E8703A", forecast_delivery: "#E8703A" };
const DYN_DASHED = new Set(["plan_smr", "plan_delivery"]);
const DYN_DASHDOT = new Set(["forecast_montage", "forecast_delivery"]);
const dynSeriesFor = (data) => data.series_order || ["plan_smr", "fact_montage", "forecast_montage", "plan_delivery", "fact_delivery", "forecast_delivery"];

function niceMax(value) {
  if (value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / (pow / 2)) * (pow / 2);
}
const CHART_MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return `${String(d.getDate()).padStart(2, "0")} ${CHART_MONTHS[d.getMonth()]}`;
}
// Понедельник недели даты — сетка графика построена по неделям (см. _week_start на сервере).
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ширина подписи — НАСТОЯЩИМ измерителем (canvas), а не числом знаков: оценка по числу знаков занижает
// ширину кириллицы, и подписи налезают друг на друга (живая проверка V1, 2026-08-14).
let measureCtx = null;
function measureText(text, font = "10.5px system-ui, sans-serif") {
  if (measureCtx === null) { try { measureCtx = document.createElement("canvas").getContext("2d"); } catch (e) { measureCtx = false; } }
  if (!measureCtx) return text.length * 6.2;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// Вехи графика (отчётная дата, контрольные даты объекта, отсечки прогноза) и их раскладка по «полкам»: каждая
// получает первую свободную полку — ту, где справа от занятого места хватает ширины (перенос layoutChartMarks).
function layoutChartMarks(data, weeks, x, width) {
  const weekIndex = (iso) => { const target = iso.slice(0, 10); let best = 0; weeks.forEach((w, i) => { if (w <= target) best = i; }); return best; };
  const inWindow = (iso) => { const w = mondayOf(iso); return w >= weeks[0] && w <= weeks[weeks.length - 1]; };
  const ряды = dynSeriesFor(data);
  const отсечки = [];
  for (const [ключ, подпись] of [["montage", "монтажа"], ["delivery", "поставки"]]) {
    const f = (data.finish || {})[ключ];
    if (!f || !f.forecast || !ряды.includes(`forecast_${ключ}`)) continue;
    const общий = ряды.includes("forecast_montage") && ряды.includes("forecast_delivery");
    отсечки.push({ label: общий ? `Прогноз завершения ${подпись}` : "Прогноз завершения", date: f.forecast });
  }
  const marks = [{ label: "Отчётная дата", date: data.report_date }]
    .concat((data.card?.milestones || []).filter((m) => m && m.date))
    .concat(отсечки)
    .filter((m) => inWindow(m.date));
  const GAP = 8;
  const shelves = [];
  const placed = marks.map((m) => {
    const i = weekIndex(m.date);
    const px = x(i);
    const text = m.date === data.report_date && !m.label.includes("Захват") ? m.label : `${m.label} ${dateRu(m.date)}`;
    const w = measureText(text);
    const anchor = px > width * 0.75 ? "end" : (px < width * 0.2 ? "start" : "middle");
    const left = anchor === "end" ? px - w : anchor === "start" ? px : px - w / 2;
    let shelf = shelves.findIndex((edge) => left > edge + GAP);
    if (shelf === -1) shelf = shelves.length;
    shelves[shelf] = left + w;
    return { m, i, px, text, anchor, shelf };
  });
  return { placed, shelves: shelves.length };
}

// График «Динамики»: план/факт/прогноз по неделям, легенда, вехи (отчётная дата, контрольные даты, завершение
// по прогнозу), подсказка по точке — registerChartHover (chart-hover.js), тот же механизм, что у «Аналитической
// справки». Перенос buildDynamicsChartSvg (app.js) почти без изменений — только источники esc/dateRu свои.
function buildDynamicsChartSvg(data, width = 1000, height = 330) {
  const weeks = data.weeks || [];
  if (!weeks.length) return `<p class="v2-muted">Нет данных для графика.</p>`;
  const L = 52, R = 18, B = 64;
  // null в ряду — «за отчётной датой факта нет»: такие точки не рисуются, кривая факта обрывается на отчётной дате.
  const seriesPoints = (key) => (data.series?.[key] || []).map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined);
  const ряды = dynSeriesFor(data).filter((k) => seriesPoints(k).some((p) => p.v > 0));
  const maxY = niceMax(Math.max(1, ...ряды.flatMap((k) => seriesPoints(k).map((p) => p.v))));
  const x = (i) => L + (weeks.length === 1 ? 0 : (i * (width - L - R)) / (weeks.length - 1));

  const layout = layoutChartMarks(data, weeks, x, width);
  const T = 46 + Math.max(0, layout.shelves - 2) * 15;
  const y = (v) => height - B - (v / maxY) * (height - T - B);

  const parts = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`];

  for (let i = 0; i <= 5; i++) {
    const v = (maxY * i) / 5, yy = y(v);
    parts.push(`<line x1="${L}" y1="${yy}" x2="${width - R}" y2="${yy}" stroke="#E5E8EC" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${yy + 3}" font-size="11" fill="#8A94A0" text-anchor="end">${Math.round(v)}</text>`);
  }
  const step = weeks.length > 18 ? 2 : 1;
  const labelY = height - B + 16;
  weeks.forEach((w, i) => {
    if (i % step) return;
    parts.push(`<text x="${x(i)}" y="${labelY}" font-size="10" fill="#8A94A0" text-anchor="end" transform="rotate(-45 ${x(i)} ${labelY})">${esc(shortDate(w))}</text>`);
  });

  for (const key of ряды) {
    const points = seriesPoints(key);
    if (!points.some((p) => p.v > 0)) continue;
    const d = points.map((p, n) => `${n ? "L" : "M"} ${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
    const dash = DYN_DASHDOT.has(key) ? ' stroke-dasharray="10 3 2 3"' : DYN_DASHED.has(key) ? ' stroke-dasharray="7 4"' : "";
    parts.push(`<path d="${d}" fill="none" stroke="${DYN_COLORS[key]}" stroke-width="2.2" stroke-linejoin="round"${dash}/>`);
  }

  layout.placed.forEach(({ m, i, px, text, anchor, shelf }) => {
    const plan = (data.series?.plan_smr || [])[i] || 0;
    const py = y(plan);
    const topY = 16 + shelf * 15;
    if (topY + 6 < py - 6) {
      parts.push(`<line x1="${px}" y1="${topY + 6}" x2="${px}" y2="${py - 6}" stroke="#C0392B" stroke-width="1.4"/>`);
      parts.push(`<path d="M ${px - 4} ${py - 10} L ${px} ${py - 2} L ${px + 4} ${py - 10} Z" fill="#C0392B"/>`);
    }
    parts.push(`<text x="${px}" y="${topY}" font-size="10.5" fill="#C0392B" text-anchor="${anchor}">${esc(text)}</text>`);
  });

  let lx = L;
  for (const key of ряды) {
    const dash = DYN_DASHDOT.has(key) ? ' stroke-dasharray="10 3 2 3"' : DYN_DASHED.has(key) ? ' stroke-dasharray="7 4"' : "";
    const label = data.series_labels?.[key] || key;
    parts.push(`<line x1="${lx}" y1="${height - 10}" x2="${lx + 22}" y2="${height - 10}" stroke="${DYN_COLORS[key]}" stroke-width="2.6"${dash}/>`);
    parts.push(`<text x="${lx + 28}" y="${height - 6}" font-size="11" fill="#4A5460">${esc(label)}</text>`);
    lx += 34 + label.length * 6.2;
  }
  parts.push("</svg>");
  return registerChartHover(parts.join(""), {
    L, R, T, B, width, height, maxY, weeks,
    xLabel: (w) => `Неделя с ${dateRu(w)}`,
    unit: "изд.",
    series: ряды.map((key) => ({ key, label: data.series_labels?.[key] || key, color: DYN_COLORS[key], values: data.series?.[key] || [] })),
  });
}

// Прогноз охватывает не все изделия — кривая, не дорастающая до полного объёма, читается как остановка работ,
// а означает другое: в прогнозе кончились изделия (нет привязки к крану/стоянке/этажу, уже смонтировано).
function forecastCoverageHtml(data) {
  const c = data.forecast_coverage;
  if (!data.forecast_version_id || !c || !c.total || c.elements >= c.total) return "";
  const причины = [];
  if (c.installed) причины.push(`${c.installed} уже смонтировано`);
  if (c.unbound) причины.push(`${c.unbound} без привязки к крану, стоянке или этажу`);
  if (c.other) причины.push(`${c.other} не попало в расчёт по другим причинам`);
  return `<div class="v2-callout" role="note">Прогноз охватывает ${c.elements} изделий из ${c.total}${причины.length ? ` (${esc(причины.join(", "))})` : ""}: на этом числе кривая прогноза обрывается.</div>`;
}

// Когда закончим по прогнозу и насколько это расходится с плановым сроком — словами, под графиком (перенос
// finishVerdictHtml). Пишется только когда есть прогноз: без загруженной/посчитанной актуализации графика
// говорить «идём с опережением» не из чего.
function finishVerdictHtml(data) {
  const f = data.finish || {};
  const ряды = dynSeriesFor(data);
  const rows = [];
  for (const [ключ, что] of [["montage", "Монтаж"], ["delivery", "Поставка"]]) {
    const b = f[ключ];
    if (!b || !b.forecast || !ряды.includes(`forecast_${ключ}`)) continue;
    const срок = b.plan ? `плановый срок ${dateRu(b.plan)}` : "плановый срок не задан";
    let оценка = "";
    if (b.deviation_days !== null && b.deviation_days !== undefined) {
      const d = b.deviation_days;
      const слово = plural(Math.abs(d), "день", "дня", "дней");
      оценка = d > 0 ? ` — опоздание на ${d} ${слово}` : d < 0 ? ` — опережение на ${Math.abs(d)} ${слово}` : " — день в день";
    }
    rows.push(`<div><b>${esc(что)}:</b> завершение по прогнозу ${esc(dateRu(b.forecast))}, ${esc(срок)}${esc(оценка)}${b.plan ? ` <span class="v2-muted">(${esc(b.plan_source)})</span>` : ""}</div>`);
  }
  return rows.length ? `<div class="v2-callout" role="note">${rows.join("")}</div>` : "";
}

// График «Аналитической справки»: четыре накопительные кривые (потребность/законтрактовано/поставлено/смонтировано);
// свой график, а не общий с «Динамикой» — другой набор рядов и шкала. Перенос anChartHtml (app.js).
function anChartHtml(dyn) {
  if (!dyn || !dyn.weeks?.length) return `<p class="v2-muted">Нет данных для графика.</p>`;
  const W = 900, H = 200, L = 46, R = 20, T = 14, B = 26;
  const ряды = [
    { key: "need", label: "Потребность", color: "#9aa0a6", dash: "5 4" },
    { key: "contracted", label: "Законтрактовано", color: "#3b82f6" },
    { key: "delivered", label: "Поставлено", color: "#8b5cf6" },
    { key: "installed", label: "Смонтировано", color: "#1e7e34" },
  ];
  const максимум = Math.max(1, ...ряды.flatMap((р) => dyn.series[р.key] || []));
  const X = (i) => L + ((W - L - R) * (dyn.weeks.length > 1 ? i / (dyn.weeks.length - 1) : 0));
  const Y = (v) => H - B - (H - T - B) * (v / максимум);
  const линии = ряды.map((р) => {
    const точки = (dyn.series[р.key] || []).map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    return `<polyline fill="none" stroke="${р.color}" stroke-width="2"${р.dash ? ` stroke-dasharray="${р.dash}"` : ""} points="${точки}"/>`;
  }).join("");
  const сегодня = dyn.today_index === null || dyn.today_index === undefined ? "" : `<line x1="${X(dyn.today_index).toFixed(1)}" y1="${T}" x2="${X(dyn.today_index).toFixed(1)}" y2="${H - B}" stroke="#c0392b" stroke-width="1.5" stroke-dasharray="4 3"/>
     <text x="${(X(dyn.today_index) + 4).toFixed(1)}" y="${T + 10}" font-size="11" fill="#c0392b">дата справки</text>`;
  const шаг = Math.max(1, Math.ceil(dyn.weeks.length / 8));
  const подписи = dyn.weeks.map((w, i) => (i % шаг ? "" : `<text x="${X(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="#6b7280" text-anchor="middle">${esc(dateRu(w).slice(0, 5))}</text>`)).join("");
  const легенда = ряды.map((р) => `<span style="color:${р.color}"><b>—</b> ${esc(р.label)}</span>`).join(" · ");
  const svg = registerChartHover(`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`, {
    L, R, T, B, width: W, height: H, maxY: максимум, weeks: dyn.weeks,
    xLabel: (w) => `Неделя с ${dateRu(w)}`,
    unit: "изд.",
    series: ряды.map((р) => ({ key: р.key, label: р.label, color: р.color, values: dyn.series[р.key] || [] })),
  });
  return `<div class="v2-chart-wrap">${svg}
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#e6e9ee"/>
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#e6e9ee"/>
      <text x="4" y="${T + 8}" font-size="10" fill="#6b7280">${максимум}</text>
      <text x="4" y="${H - B}" font-size="10" fill="#6b7280">0</text>
      ${линии}${сегодня}${подписи}
    </svg><p class="v2-muted">${легенда}. Накопительным итогом по неделям.</p></div>`;
}

// Тип колонки для общих правил ширины/переноса (`.v2-read-tbl [data-col-type]` в styles.css) — ОБЩИЙ механизм
// для ЛЮБОЙ таблицы общего компонента (отчёты здесь и списки read-screen.js), не завязан на позицию колонки
// конкретного отчёта. `kind` — поле колонок отчётов (reports.js), `fmt` — колонок read-screen.js (screens.json);
// заголовок колонки «Марка» — признак минимальной ширины (задание «tables», п.2).
export function colDataType(col) {
  if (col.kind === "num" || col.fmt === "size" || col.fmt === "score") return "num";
  if (col.kind === "date" || col.fmt === "date" || col.fmt === "datetime") return "date";
  if (col.kind === "status" || col.fmt === "color") return "status";
  if (col.fmt === "bool") return "bool";
  if (/^марка$/i.test(col.label || col.title || "")) return "mark";
  return "text";
}

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
  return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${columns.map((c) => `<th data-col-type="${colDataType(c)}">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${columns.map((c) => `<td data-col-type="${colDataType(c)}"${c.kind === "num" ? ' class="num"' : ""}>${cellByKind(c, r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
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
      ${columns.map((c) => `<td class="num" data-col-type="num">${esc(num(n.values?.[c.key]))}</td>`).join("")}</tr>`);
    if (hasKids && !isCollapsed) treeRows(n.children, p, columns, collapsed, out);
  }
}

function statusReport(data, state) {
  const collapsed = state.collapsed || (state.collapsed = defaultCollapsed(data));
  const out = [];
  treeRows(data.rows || [], "", data.columns || [], collapsed, out);
  const total = data.total;
  return `<div class="v2-read-table"><table class="v2-read-tbl v2-tree-tbl"><thead><tr><th>${esc(data.root_label || "")}</th>${(data.columns || []).map((c) => `<th class="num" data-col-type="num">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${out.join("")}${total ? `<tr class="lvl-total"><td><strong>${esc(total.label)}</strong></td>${(data.columns || []).map((c) => `<td class="num" data-col-type="num"><strong>${esc(num(total.values?.[c.key]))}</strong></td>`).join("")}</tr>` : ""}</tbody></table></div>`;
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
    <h3 class="v2-report-h">2.3. Динамика обеспечения</h3>
    ${anChartHtml(data.dynamics)}
    ${gaps.length ? `<h3 class="v2-report-h">Не задана производительность завода</h3>${tableHtml([{ key: "counterparty", label: "Завод" }, { key: "element_type", label: "Тип изделия" }, { key: "elements", label: "Изделий", kind: "num" }], gaps)}` : ""}`;
}

// ---- «Динамика поставки и монтажа»: график (план/факт/прогноз по неделям, вехи, подсказка по точке — как в V1),
// сводные числа, вывод словами о сроке завершения и недельная таблица ДОПОЛНИТЕЛЬНО (не вместо графика).
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
  // Предупреждение о неполноте плана — план по части изделий внешне неотличим от полного и молча вводит в заблуждение.
  const cov = data.plan_coverage;
  const warns = [];
  if (cov && cov.smr < cov.total) warns.push(`план СМР задан у ${cov.smr} изделий из ${cov.total}`);
  if (cov && cov.delivery < cov.total) warns.push(`план поставки — у ${cov.delivery} из ${cov.total}`);
  return `<p class="v2-muted">${esc(data.subtitle || "")} на ${esc(dateRu(data.report_date))}</p>
    <div class="v2-tiles">${summary("Монтаж", data.montage)}${summary("Поставка", data.delivery)}</div>
    ${warns.length ? `<div class="v2-callout v2-callout-bad" role="alert">Внимание: ${esc(warns.join("; "))}. Кривая плана неполная.</div>` : ""}
    ${forecastCoverageHtml(data)}
    ${data.forecast_version_id ? "" : `<p class="v2-muted">Кривой прогноза нет: по объекту не загружен ни один актуализированный график. Загрузить — «Обмен данными → Импорт графика MS Project», вид «Актуализированный»; посчитать самой системой — «Документы → График СМР → Расчёт».</p>`}
    <div class="v2-chart-wrap">${buildDynamicsChartSvg(data)}</div>
    ${finishVerdictHtml(data)}
    <h3 class="v2-report-h">Значения по неделям</h3>
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


// ---- «Учёт по блокам: статусы»: матрица «операция WBS × блок (секция/этаж)/секция целиком/объект» с процентом или статусом на дату.
// Правка ячейки (mfr2, перенос из V1): «эт/сек» — число (PUT .../blocks/{id}/work-progress-cell, попадает в документ факта на дату,
// тот же механизм, что «Факт» в панели блока); «сек»/«компл» — клик крутит План → В работе → Выполнено → План
// (PUT /work-progress/cell). Доступно только при праве «Учёт по блокам: изменение» (work_progress); правами отчёта самого по себе
// (report_block_status) запись не даётся — так же, как в V1.
function bsColumns(data) {
  const blocks = data.blocks || [];
  const groups = [];
  for (const b of blocks) { const g = groups[groups.length - 1]; if (g && g.code === b.section_code) g.n++; else groups.push({ code: b.section_code, n: 1 }); }
  const sectionCols = (data.sections || []).map((s) => ({ kind: "section", id: s.id, label: `${s.code} целиком` }));
  return { groups, sectionCols };
}
function blockStatusReport(data, state, ctx) {
  const blocks = data.blocks || [];
  const leaves = [];
  const walk = (n) => { if (n.children?.length) n.children.forEach(walk); else leaves.push(n); };
  (data.tree || []).forEach(walk);
  const rows = state.all ? leaves : leaves.filter((l) => l.cells && Object.keys(l.cells).length);
  const { groups, sectionCols } = bsColumns(data);
  const canEdit = !!ctx?.canWrite;
  const cellRead = (c) => {
    if (c == null) return "";
    if (typeof c === "string") return esc(BW_STATUS[c] || c);
    const label = `${BW_STATUS[c.status] || c.status || ""}${c.deadline_label ? `, ${c.deadline_label}` : ""}`;
    return `<span title="${esc(label)}">${esc(num(c.percent))}</span>`;
  };
  // «эт/сек»: числовое поле, значение сохраняется по blur/Enter — как у процента в форме факта.
  const blockCell = (l, b) => {
    const c = l.cells?.[String(b.id)];
    if (!l.addressable || (l.unit !== "эт/сек" && l.unit !== "кв.эт/сек")) return `<td class="v2-matrix-off"></td>`;
    if (!c) return `<td class="v2-matrix-off" title="Операция не выбрана для этого блока">·</td>`;
    if (!canEdit) return `<td class="num v2-matrix-${esc(c.status)}">${cellRead(c)}</td>`;
    return `<td class="num v2-matrix-${esc(c.status)}"><input type="number" class="v2-matrix-input" min="0" max="100" step="1" value="${esc(c.percent)}" data-wt="${l.id}" data-block="${b.id}" aria-label="Процент: ${esc(l.name)}, ${esc(b.section_code)} ${esc(b.level_floor ?? b.level_name ?? "")}"></td>`;
  };
  // «сек»/«компл»: статус, клик крутит план → в работе → выполнено → план.
  // `expectUnit` — колонка «Объект» кликабельна ТОЛЬКО у строк «компл» (объект целиком), колонка секции — ТОЛЬКО у строк «сек»
  // (секция целиком): у обеих единиц `work_progress.matrix` кладёт в `cells` значение на КАЖДУЙ ключ своей колонки (со статусом
  // «план» по умолчанию), поэтому проверка одного `l.unit` без проверки, та ли это колонка, включала кнопку не в той графе.
  const cycleCell = (l, key, label, expectUnit) => {
    if (!l.addressable || l.unit !== expectUnit) return `<td class="v2-matrix-off"></td>`;
    const status = l.cells?.[key] || "plan";
    if (!canEdit) return `<td class="v2-matrix-${esc(status)}">${cellRead(status)}</td>`;
    return `<td class="v2-matrix-${esc(status)}"><button type="button" class="v2-matrix-cycle" data-wt="${l.id}" data-sec="${key === "объект" ? "" : key}" aria-label="${esc(label)}: ${esc(BW_STATUS[status])} — щелчок переключит статус">${esc(BW_STATUS[status])}</button></td>`;
  };
  const shown = rows.slice(0, 400);
  return `<p class="v2-muted" role="status">Блоков: ${blocks.length} · операций WBS: ${leaves.length}, с данными: ${leaves.filter((l) => l.cells && Object.keys(l.cells).length).length} · на ${esc(dateRu(data.report_date))}${canEdit ? "" : " · только просмотр"}</p>
    <label class="v2-wire-check"><input type="checkbox" id="bs-all" ${state.all ? "checked" : ""}> Показать все операции WBS (по умолчанию — только с данными)</label>
    <p id="bs-cell-msg" class="v2-muted" role="status" aria-live="polite">${esc(state.cellMsg || "")}</p>
    ${rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl v2-matrix"><thead>
      <tr><th rowspan="2">Код</th><th rowspan="2">Работа</th>${groups.map((g) => `<th colspan="${g.n}">${esc(g.code)}</th>`).join("")}${sectionCols.map((s) => `<th rowspan="2">${esc(s.label)}</th>`).join("")}<th rowspan="2">Объект</th></tr>
      <tr>${blocks.map((b) => `<th title="${esc(b.level_name)}">${esc(String(b.level_name).slice(0, 12))}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((l) => `<tr><td>${esc(l.code || "")}</td><td>${esc(l.name)}</td>${blocks.map((b) => blockCell(l, b)).join("")}${sectionCols.map((s) => cycleCell(l, String(s.id), s.label, "сек")).join("")}${cycleCell(l, "объект", "Объект", "компл")}</tr>`).join("")}</tbody></table></div>
      ${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${shown.length} из ${rows.length}.</p>` : ""}` : `<p class="v2-muted">Операций с данными нет.</p>`}`;
}

export const REPORT_RENDERERS = { status: statusReport, completion: completionReport, analytics: analyticsReport, dynamics: dynamicsReport, mywork: myworkReport, linear: linearTrackReport, blocksched: blockScheduleReport, blockstatus: blockStatusReport, ...EXCHANGE_REPORT_RENDERERS };

// Взаимодействие: сворачивание узлов дерева, страницы перечня. Возвращает true, если надо перерисовать. `ctx` (mfr2) — {api, objectId,
// canWrite, data} для отчётов с правкой ячейки прямо в таблице (только «blockstatus» сейчас).
export function bindReport(name, root, state, repaint, ctx) {
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
    if (ctx?.canWrite) bindBlockStatusEdits(root, state, repaint, ctx);
  }
  if (name === "completion") {
    root.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
      state.page = Math.max(0, (state.page || 0) + (b.dataset.page === "next" ? 1 : -1));
      repaint();
    }));
  }
}

function bsCellMsg(state, root, text) { state.cellMsg = text; const n = root.querySelector("#bs-cell-msg"); if (n) n.textContent = text; }
function bindBlockStatusEdits(root, state, repaint, { api, objectId, data }) {
  root.querySelectorAll(".v2-matrix-input").forEach((inp) => {
    const commit = async () => {
      const percent = Math.max(0, Math.min(100, Math.round(Number(inp.value) || 0)));
      inp.value = percent;
      const wt = Number(inp.dataset.wt), block = Number(inp.dataset.block);
      inp.disabled = true;
      try {
        await api.put(`/objects/${objectId}/blocks/${block}/work-progress-cell`, { work_type_id: wt, percent, report_date: data.report_date });
        bsCellMsg(state, root, "");
        repaint();
      } catch (err) {
        bsCellMsg(state, root, `Не удалось сохранить: ${err?.detail || err?.message || ""}`);
        inp.disabled = false;
      }
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("click", (e) => e.stopPropagation());
  });
  root.querySelectorAll(".v2-matrix-cycle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const wt = Number(btn.dataset.wt), secRaw = btn.dataset.sec;
      const sectionId = secRaw ? Number(secRaw) : null;
      const cur = btn.parentElement.className.match(/v2-matrix-(\w+)/)?.[1] || "plan";
      const next = cur === "plan" ? "in_progress" : cur === "in_progress" ? "done" : null;
      btn.disabled = true;
      try {
        await api.put(`/objects/${objectId}/work-progress/cell`, { work_type_id: wt, block_id: null, section_id: sectionId, status: next });
        bsCellMsg(state, root, "");
        repaint();
      } catch (err) {
        bsCellMsg(state, root, `Не удалось сохранить: ${err?.detail || err?.message || ""}`);
        btn.disabled = false;
      }
    });
  });
}
