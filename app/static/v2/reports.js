// Отображение отчётов V2 (только чтение). Данные — те же ответы `POST /reports/*`, что и у V1: никаких расчётов
// здесь нет, только вёрстка присланного. Выгрузка в XLSX/PDF и печать — в read-screen.js; графики (SVG, свой код,
// без сторонней библиотеки — перенос из V1: app.js buildDynamicsChartSvg/anChartHtml) — здесь же, у «Динамики» и
// «Аналитической справки», единственных двух отчётов V1 с графиком.
import { esc } from "./screen-view.js";
import { EXCHANGE_REPORT_RENDERERS, bindExchangeReport } from "./reports-exchange.js";
import { registerChartHover, ensureChartHoverListener } from "./chart-hover.js";
import { WORK_REPORT_RENDERERS, REPORT_INIT, bindWorkReport } from "./reports-work.js";

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
export function buildDynamicsChartSvg(data, width = 1000, height = 330, opts = {}) {
  const compact = !!opts.compact;
  const weeks = data.weeks || [];
  if (!weeks.length) return `<p class="v2-muted">Нет данных для графика.</p>`;
  const L = compact ? 30 : 52, R = compact ? 6 : 18, B = compact ? 30 : 64;
  // null в ряду — «за отчётной датой факта нет»: такие точки не рисуются, кривая факта обрывается на отчётной дате.
  const seriesPoints = (key) => (data.series?.[key] || []).map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined);
  const ряды = dynSeriesFor(data).filter((k) => seriesPoints(k).some((p) => p.v > 0));
  const maxY = niceMax(Math.max(1, ...ряды.flatMap((k) => seriesPoints(k).map((p) => p.v))));
  const x = (i) => L + (weeks.length === 1 ? 0 : (i * (width - L - R)) / (weeks.length - 1));

  const layout = compact ? { placed: [], shelves: 0 } : layoutChartMarks(data, weeks, x, width);
  const T = compact ? 8 : 46 + Math.max(0, layout.shelves - 2) * 15;
  const y = (v) => height - B - (v / maxY) * (height - T - B);

  const parts = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`];

  const gridLines = compact ? 4 : 5;
  for (let i = 0; i <= gridLines; i++) {
    const v = (maxY * i) / gridLines, yy = y(v);
    parts.push(`<line x1="${L}" y1="${yy}" x2="${width - R}" y2="${yy}" stroke="#E5E8EC" stroke-width="1"/>`);
    parts.push(`<text x="${L - (compact ? 4 : 8)}" y="${yy + 3}" font-size="${compact ? 8 : 11}" fill="#8A94A0" text-anchor="end">${Math.round(v)}</text>`);
  }
  const step = compact ? Math.max(1, Math.ceil(weeks.length / 5)) : weeks.length > 18 ? 2 : 1;
  const labelY = height - B + (compact ? 12 : 16);
  weeks.forEach((w, i) => {
    if (i % step) return;
    parts.push(`<text x="${x(i)}" y="${labelY}" font-size="${compact ? 8 : 10}" fill="#8A94A0" text-anchor="end" transform="rotate(-45 ${x(i)} ${labelY})">${esc(shortDate(w))}</text>`);
  });

  for (const key of ряды) {
    const points = seriesPoints(key);
    if (!points.some((p) => p.v > 0)) continue;
    const d = points.map((p, n) => `${n ? "L" : "M"} ${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
    const dash = DYN_DASHDOT.has(key) ? ' stroke-dasharray="10 3 2 3"' : DYN_DASHED.has(key) ? ' stroke-dasharray="7 4"' : "";
    parts.push(`<path d="${d}" fill="none" stroke="${DYN_COLORS[key]}" stroke-width="2.2" stroke-linejoin="round"${dash}/>`);
  }

  if (compact) {
    const reportWeek = mondayOf(data.report_date);
    if (reportWeek >= weeks[0] && reportWeek <= weeks[weeks.length - 1]) {
      let index = 0;
      weeks.forEach((w, i) => { if (w <= data.report_date.slice(0, 10)) index = i; });
      const px = x(index);
      parts.push(`<line x1="${px}" y1="${T}" x2="${px}" y2="${height - B}" stroke="#C0392B" stroke-width="1" stroke-dasharray="3 3"/>`);
    }
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
  for (const key of compact ? [] : ряды) {
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

// Узкая панель V1 выносит легенду за пределы SVG: подписи шести рядов
// невозможно уместить внутри графика шириной 280 px.
export function dynamicsChartLegendHtml(data) {
  const drawn = (key) => (data.series?.[key] || []).some((v) => v !== null && v > 0);
  return `<div class="side-chart-legend">${dynSeriesFor(data).filter(drawn).map((key) =>
    `<span><i style="background:${DYN_COLORS[key]};color:${DYN_COLORS[key]}"${DYN_DASHED.has(key) ? ' class="dashed"' : DYN_DASHDOT.has(key) ? ' class="dashdot"' : ""}></i>${esc(data.series_labels?.[key] || key)}</span>`
  ).join("")}</div>`;
}

// Прогноз охватывает не все изделия — кривая, не дорастающая до полного объёма, читается как остановка работ,
// а означает другое: в прогнозе кончились изделия (нет привязки к крану/стоянке/этажу, уже смонтировано).
export function forecastCoverageHtml(data) {
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
export function finishVerdictHtml(data) {
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
export function anChartHtml(dyn) {
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
  if (col.key === "guid") return "code";   // идентификатор: моноширинно и приглушённо, как V1 .cmp-guid
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

// ---- «Статус комплектации», вид «сводная таблица» (reports2, перенос renderCompletionPivot из V1): дерево уровней
// группировки против календаря выбранной даты, в ячейке — количество изделий. Всё считает СЕРВЕР
// (app/report_pivot.py, тот же `POST /reports/completion` с view=pivot, что у V1) — здесь только вёрстка. Ноль не
// рисуется (на календаре из десятков колонок нули — шум), свёрнуто всё, кроме первой ветки (как в V1).
function completionPivotReport(data, state) {
  const t = data.total || {};
  if (!t.total) return `<p class="v2-muted" role="status">Изделий: 0</p><p class="v2-muted">Под текущий отбор не попало ни одного изделия.</p>`;
  const collapsed = state.collapsed || (state.collapsed = defaultCollapsed(data));
  const cols = data.columns || [];
  const colCls = (c) => (c.kind === "edge" ? "v2-cmp-edge" : c.weekend ? "v2-cmp-weekend" : "");
  const cell = (v, cls = "") => `<td class="num ${cls}">${v ? esc(num(v)) : ""}</td>`;
  const out = [];
  const walk = (n, path) => {
    const kids = n.children && n.children.length;
    const isCollapsed = collapsed.has(path);
    out.push(`<tr class="lvl-${n.level}"><td style="padding-left:${12 + n.level * 16}px" title="${esc(n.label)}">
      ${kids ? `<button type="button" class="v2-tree-toggle" data-path="${esc(path)}" aria-expanded="${!isCollapsed}" aria-label="${isCollapsed ? "Развернуть" : "Свернуть"} ${esc(n.label)}">${isCollapsed ? "▸" : "▾"}</button>` : `<span class="v2-tree-toggle-gap"></span>`}${esc(n.label)}</td>
      ${cols.map((c) => cell(n.values?.[c.key], colCls(c))).join("")}${cell(n.total, "v2-cmp-sum")}</tr>`);
    if (kids && !isCollapsed) n.children.forEach((ch) => walk(ch, `${path}/${ch.label}`));
  };
  (data.rows || []).forEach((r) => walk(r, r.label));
  return `<p class="v2-muted" role="status">Изделий: ${esc(num(t.total))}</p>
    <p class="v2-muted">${esc(data.subtitle || "")}</p>
    ${data.warning ? `<div class="v2-callout" role="note">${esc(data.warning)}</div>` : ""}
    <div class="v2-read-table v2-ds-wrap"><table class="v2-read-tbl v2-tree-tbl v2-ds-tbl v2-cmp-pivot"><thead><tr><th>${esc(data.root_label || "")}</th>
      ${cols.map((c) => `<th class="num ${colCls(c)}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.label)}</th>`).join("")}<th class="num v2-cmp-sum">${esc(data.total_label || "Итого")}</th></tr></thead>
      <tbody>${out.join("")}<tr class="lvl-total"><td><strong>${esc(t.label || "Итого")}</strong></td>${cols.map((c) => cell(t.values?.[c.key], colCls(c))).join("")}${cell(t.total, "v2-cmp-sum")}</tr></tbody></table></div>`;
}

// ---- «Статус комплектации» (перечень): плоская таблица, поиск и страницы на клиенте.
// Какой вид рисовать, решает ПРИШЕДШИЙ отчёт (V1 renderCompletionView), а не выбор в форме: между запросом и
// ответом вид могли переключить, и разметка спорила бы с числами.
const PAGE = 200;
function completionReport(data, state) {
  if (data?.view === "pivot") return completionPivotReport(data, state);
  const q = (state.search || "").trim().toLowerCase();
  const rows = q ? data.rows.filter((r) => Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))) : data.rows;
  const offset = Math.min(state.page || 0, Math.max(0, Math.ceil(rows.length / PAGE) - 1)) * PAGE;
  const pageRows = rows.slice(offset, offset + PAGE);
  const cols = data.columns;   // все колонки сервера, как V1 renderCompletionReport (включая GUID)
  return `${data.warning ? `<div class="v2-callout" role="note">${esc(data.warning)}</div>` : ""}
    <p class="v2-muted" role="status">${q ? `Найдено ${rows.length} из ${data.rows.length}` : `Позиций: ${data.rows.length}`}${data.total ? ` · ${esc(data.total.label)}: ${esc(num(data.total.count))} шт.` : ""}${rows.length ? ` · строки ${offset + 1}–${offset + pageRows.length}` : ""}</p>
    ${rows.length ? tableHtml(cols, pageRows, { cap: PAGE }) : `<p class="v2-muted">${q ? `Ничего не найдено по запросу «${esc(state.search)}».` : "Позиций нет."}</p>`}
    ${rows.length > PAGE ? `<div class="v2-bar"><button type="button" class="v2-btn" data-page="prev" ${offset <= 0 ? "disabled" : ""}>← Назад</button>
      <button type="button" class="v2-btn" data-page="next" ${offset + PAGE >= rows.length ? "disabled" : ""}>Дальше →</button></div>` : ""}`;
}

// Отчёты, сверенные с V1 по сценарию (аудит «рабочие места и отчёты»), — в reports-work.js; здесь только сборка общего реестра.
export const REPORT_RENDERERS = { status: statusReport, completion: completionReport, ...WORK_REPORT_RENDERERS, ...EXCHANGE_REPORT_RENDERERS };
export { REPORT_INIT };

// Взаимодействие: сворачивание узлов дерева, страницы перечня. `ctx` — {api, objectId, canWrite, data, rights, params, setParams, go,
// switchObject, hasObject} (read-screen.js): правка ячейки прямо в таблице, перезапрос с новыми параметрами, переходы.
export function bindReport(name, root, state, repaint, ctx) {
  bindExchangeReport(name, root, state, repaint);   // «График поставки» и «График контрактации и поставки» (reports-exchange.js)
  bindWorkReport(name, root, state, repaint, ctx);  // отчёты reports-work.js
  if (name === "status") {
    root.querySelectorAll(".v2-tree-toggle").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.path;
      if (state.collapsed.has(p)) state.collapsed.delete(p); else state.collapsed.add(p);
      repaint(p);
    }));
  }
  if (name === "completion") {
    root.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => {
      state.page = Math.max(0, (state.page || 0) + (b.dataset.page === "next" ? 1 : -1));
      repaint();
    }));
    // сводная таблица: свернуть/развернуть уровень (только перерисовка, без запроса — как в V1)
    root.querySelectorAll("#rd-report .v2-tree-toggle[data-path]").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.path;
      if (state.collapsed.has(p)) state.collapsed.delete(p); else state.collapsed.add(p);
      repaint(p);
    }));
  }
}
