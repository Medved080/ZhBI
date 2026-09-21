// Отчёты «График поставки» и «График контрактации и поставки» в V2 (только чтение; в V1 оба помечены «в разработке» — пометка и предупреждения
// сервера показываются). Данные — те же ответы `POST /reports/delivery-schedule` и `POST /reports/contracting-schedule`, что у V1; расчётов здесь нет.
import { esc } from "./screen-view.js";

const num = (v) => (v == null ? "" : typeof v === "number" ? v.toLocaleString("ru-RU") : String(v));

// ---- «График поставки»: дерево «группировка → контракт → тип», в ячейке «потребность / план / факт»; розовым — потребность не перекрыта
function deliveryCell(v, gap, cls = "") {
  if (!v || (!v[0] && !v[1] && !v[2])) return `<td class="num ${cls}"></td>`;
  return `<td class="num ${cls} ${gap ? "v2-ds-gap" : ""}" title="потребность ${v[0]} / план ${v[1]} / факт ${v[2]}">${v[0] || 0}/${v[1] || 0}/${v[2] || 0}</td>`;
}

function deliveryRows(nodes, path, columns, collapsed, out) {
  for (const n of nodes) {
    const p = path ? `${path}/${n.label}` : n.label;
    const kids = n.children && n.children.length;
    const isCollapsed = collapsed.has(p);
    out.push(`<tr class="lvl-${n.level}"><td style="padding-left:${12 + n.level * 16}px">
      ${kids ? `<button type="button" class="v2-tree-toggle" data-path="${esc(p)}" aria-expanded="${!isCollapsed}" aria-label="${isCollapsed ? "Развернуть" : "Свернуть"} ${esc(n.label)}">${isCollapsed ? "▸" : "▾"}</button>` : `<span class="v2-tree-toggle-gap"></span>`}${esc(n.label)}</td>
      ${columns.map((c) => deliveryCell(n.values?.[c.key], (n.gaps || {})[c.key])).join("")}${deliveryCell(n.total, n.gap_total, "v2-ds-sum")}</tr>`);
    if (kids && !isCollapsed) deliveryRows(n.children, p, columns, collapsed, out);
  }
}

export function deliveryDefaultCollapsed(data) {
  const s = new Set();
  const walk = (n, path) => { const p = path ? `${path}/${n.label}` : n.label; if (n.children?.length) { if (n.level >= 1) s.add(p); n.children.forEach((c) => walk(c, p)); } };
  (data?.rows || []).forEach((r) => walk(r, ""));
  return s;
}

function deliveryReport(data, state) {
  if (!data?.columns) return `<p class="v2-muted">Нет данных.</p>`;
  const collapsed = state.collapsed || (state.collapsed = deliveryDefaultCollapsed(data));
  const cols = data.columns;
  const out = [];
  deliveryRows(data.rows || [], "", cols, collapsed, out);
  const t = data.total || {};
  const legend = (data.scales || []).map((s) => `${esc(s.label.toLowerCase())} — ${esc(s.hint)}`).join(" · ");
  return `${data.in_development_note ? `<div class="v2-callout v2-callout-bad" role="note"><strong>Отчёт в разработке.</strong> ${esc(data.in_development_note)}</div>` : ""}
    <p class="v2-muted">${esc(data.subtitle || "")}</p>
    <p class="v2-muted">В ячейке: потребность / план / факт (${legend}). <span class="v2-ds-gap-legend">Розовым</span> — потребность не перекрыта (всего ${num(t.gap_total || 0)} изд.).</p>
    ${data.warning ? `<div class="v2-callout" role="note">${esc(data.warning)}</div>` : ""}
    <div class="v2-read-table v2-ds-wrap"><table class="v2-read-tbl v2-tree-tbl v2-ds-tbl"><thead><tr><th>${esc(data.root_label || "")}</th>
      ${cols.map((c) => `<th class="num" ${c.title ? `title="${esc(c.title)}"` : ""}>${esc(c.label)}</th>`).join("")}<th class="num">${esc(data.total_label || "Итого")}</th></tr></thead>
      <tbody>${out.join("")}<tr class="lvl-total"><td><strong>${esc(t.label || "Итого")}</strong></td>${cols.map((c) => deliveryCell(t.values?.[c.key], (t.gaps || {})[c.key])).join("")}${deliveryCell(t.total, t.gap_total, "v2-ds-sum")}</tr></tbody></table></div>`;
}

// ---- «График контрактации и поставки»: по маркам — потребность, законтрактовано, дефицит и приращения по периодам
const CS_SERIES = [["need", "потребность"], ["contracted", "контракт"], ["planned", "план"], ["fact", "факт"]];
function periodCell(deltas, i) {
  const parts = CS_SERIES.map(([k]) => (deltas?.[k]?.[String(i)] ? `${deltas[k][String(i)]}` : "")).map((x, j) => (x ? `<span class="v2-cs-s${j}" title="${CS_SERIES[j][1]}">${x}</span>` : ""));
  return `<td class="num">${parts.filter(Boolean).join(" ")}</td>`;
}

function contractingReport(data, state) {
  if (!data || !data.rows?.length) return `<p class="v2-muted">Нет изделий с маркой — отчёту нечего показывать.</p>`;
  const rows = state.onlyDeficit ? data.rows.filter((r) => r.deficit > 0) : data.rows;
  const cap = state.cap || 200;
  const shown = rows.slice(0, cap);
  const expanded = state.expanded || (state.expanded = new Set());
  const P = data.periods || [];
  const t = data.totals || {};
  const key = (r) => `${r.element_type}|${r.mark}`;
  const body = shown.map((r) => {
    const open = expanded.has(key(r));
    return `<tr><td>${esc(r.element_type || "—")}</td><td><button type="button" class="v2-tree-toggle" data-cs="${esc(key(r))}" aria-expanded="${open}" aria-label="${open ? "Свернуть" : "Развернуть"} ${esc(r.mark)}">${open ? "▾" : "▸"}</button>${esc(r.mark)}${r.children?.length ? ` <span class="v2-muted">(${r.children.length})</span>` : ""}</td>
      <td class="num">${num(r.need)}</td><td class="num">${num(r.contracted)}</td><td class="num ${r.deficit > 0 ? "v2-bad-text" : ""}">${num(r.deficit)}</td>${P.map((_, i) => periodCell(r.deltas, i)).join("")}</tr>
      ${open ? (r.children?.length ? r.children.map((c) => `<tr class="v2-cs-child"><td></td><td>${esc(c.counterparty || "—")}</td><td class="v2-muted">${esc(c.agreement || "")}${c.agreement_date ? ` от ${esc(c.agreement_date)}` : ""}</td><td class="num">${num(c.contracted)}</td><td class="v2-muted">${esc(c.specification || "")}${c.specification_date ? ` от ${esc(c.specification_date)}` : ""}</td>${P.map((_, i) => periodCell(c.deltas, i)).join("")}</tr>`).join("") : `<tr class="v2-cs-child"><td></td><td colspan="${4 + P.length}" class="v2-muted">контрактов по этой марке нет</td></tr>`) : ""}`;
  }).join("");
  return `${data.in_development ? `<div class="v2-callout v2-callout-bad" role="note"><strong>Отчёт в разработке.</strong> Данные могут быть неполными; использовать для принятия решений нельзя.</div>` : ""}
    <p class="v2-muted" role="status">${esc(data.scale_label || "")}. Марок: ${rows.length}${state.onlyDeficit ? ` с дефицитом (всего ${data.rows.length})` : ""}. Итого: потребность ${num(t.need)}, законтрактовано ${num(t.contracted)}, дефицит ${num(t.deficit)}.
      В колонках периодов: <span class="v2-cs-s0">потребность</span> · <span class="v2-cs-s1">контракт</span> · <span class="v2-cs-s2">план</span> · <span class="v2-cs-s3">факт</span> — приращения за период.</p>
    ${data.warning ? `<div class="v2-callout" role="note">${esc(data.warning)}</div>` : ""}
    <label class="v2-wire-check"><input type="checkbox" id="cs-deficit" ${state.onlyDeficit ? "checked" : ""}> Только марки с дефицитом</label>
    <div class="v2-read-table v2-ds-wrap"><table class="v2-read-tbl v2-cs-tbl"><thead><tr><th>Тип</th><th>Марка</th><th class="num">Потребность</th><th class="num">Законтрактовано</th><th class="num">Дефицит</th>${P.map((p) => `<th class="num">${esc(p.label)}</th>`).join("")}</tr></thead>
      <tbody>${body}<tr class="lvl-total"><td colspan="2"><strong>Итого по объекту</strong></td><td class="num"><strong>${num(t.need)}</strong></td><td class="num"><strong>${num(t.contracted)}</strong></td><td class="num"><strong>${num(t.deficit)}</strong></td>${P.map((_, i) => periodCell(t.deltas, i)).join("")}</tr></tbody></table></div>
    ${rows.length > shown.length ? `<div class="v2-bar"><span class="v2-muted">Показаны первые ${shown.length} из ${rows.length}.</span><button type="button" class="v2-btn" id="cs-more">Показать ещё</button></div>` : ""}`;
}

export const EXCHANGE_REPORT_RENDERERS = { delivery: deliveryReport, contracting: contractingReport };

// Взаимодействие: сворачивание строк, отбор по дефициту, «показать ещё». `repaint` перерисовывает отчёт.
export function bindExchangeReport(name, root, state, repaint) {
  if (name === "delivery") {
    root.querySelectorAll(".v2-tree-toggle").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.path;
      if (state.collapsed.has(p)) state.collapsed.delete(p); else state.collapsed.add(p);
      repaint(p);
    }));
  } else if (name === "contracting") {
    root.querySelector("#cs-deficit")?.addEventListener("change", (e) => { state.onlyDeficit = e.target.checked; state.cap = 200; repaint(); });
    root.querySelector("#cs-more")?.addEventListener("click", () => { state.cap = (state.cap || 200) + 200; repaint(); });
    root.querySelectorAll("[data-cs]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.cs;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      repaint();
    }));
  }
}
