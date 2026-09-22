// Отчёты V2, сверенные с V1 по сценарию (аудит «рабочие места и отчёты», 2026-09-22): «Аналитическая справка»,
// «Динамика поставки и монтажа», «Моя работа», «Учёт по блокам: статусы», «График работ по блокам», «Линейный трек».
// Вёрстка — перенос функций app.js (renderAnalyticsReport, renderDynamicsReport, renderMyWorkReport,
// renderBlockStatusReport, renderBlockScheduleReport, renderLinearTrackReport) на компоненты V2. Данные — те же ответы
// POST /reports/*, что у V1: чисел здесь не считаем, только показываем присланное. Графики — общие функции reports.js.
import { esc } from "./screen-view.js";
import { showInfoDialog } from "./dialogs.js";
import { buildDynamicsChartSvg, anChartHtml, forecastCoverageHtml, finishVerdictHtml } from "./reports.js";
import { requestLocate } from "./locate-handoff.js";

// стили модуля — отдельным файлом (общий styles.css не трогаем)
(() => {
  if (typeof document === "undefined" || document.querySelector("link[data-rw-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/reports-work.css"; l.setAttribute("data-rw-css", "1");
  document.head.appendChild(l);
})();

const num = (v) => (v == null ? "" : typeof v === "number" ? v.toLocaleString("ru-RU") : String(v));
const dateRu = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? ""); };
// «дд.мм» — как bwShortDate в V1 (сроки работ по блокам)
const shortDate = (v) => { if (!v) return "—"; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? `${m[3]}.${m[2]}` : String(v); };
const devLabel = (d) => (d == null ? "" : d === 0 ? "±0 дн" : `${d > 0 ? "+" : ""}${d} дн`);

// Выбор показа, который в V1 живёт до закрытия страницы (глобальные переменные app.js), а не до следующего запроса отчёта:
// смена даты перезапрашивает отчёт, но режим «Показывать»/«Только с дефицитом» не сбрасывает.
const UI = { anOnlyDeficit: true, bsMode: "percent" };

// ==================== «Аналитическая справка» (перенос renderAnalyticsReport) ====================
const AN_ALARM = new Set(["deficit", "no_contract", "missing"]);
function anCell(row, col) {
  const v = row[col.key];
  if (col.kind === "verdict") { const x = v || {}; return `<td><span class="rw-pill rw-pill-${esc(x.code || "")}">${esc(x.label || "")}</span></td>`; }
  if (col.kind === "date") return `<td data-col-type="date">${v ? esc(dateRu(v)) : "—"}</td>`;
  // у начатых этапов число отрицательное — «минус 41 день до старта» читается как ребус (как в V1)
  if (col.key === "days_left") return `<td class="num" data-col-type="num">${v == null ? "" : v <= 0 ? `идёт ${-v} дн.` : esc(num(v))}</td>`;
  if (col.kind === "num") return `<td class="num${AN_ALARM.has(col.key) && v > 0 ? " rw-bad" : ""}" data-col-type="num">${v == null ? "" : esc(num(v))}</td>`;
  return `<td>${v == null ? "—" : esc(String(v))}</td>`;
}
function anTable(block, rows, totalLabel) {
  if (!rows.length) return `<p class="v2-muted">Нет данных.</p>`;
  const head = block.columns.map((c) => `<th data-col-type="${c.kind === "num" ? "num" : c.kind === "date" ? "date" : "text"}">${esc(c.label)}</th>`).join("");
  const body = rows.map((r) => `<tr>${block.columns.map((c) => anCell(r, c)).join("")}</tr>`).join("");
  const total = block.total && totalLabel
    ? `<tr class="lvl-total"><td><strong>${esc(totalLabel)}</strong></td>${block.columns.slice(1).map((c) => `<td class="num" data-col-type="num"><strong>${c.key in block.total ? esc(num(block.total[c.key])) : ""}</strong></td>`).join("")}</tr>`
    : "";
  return `<div class="v2-read-table"><table class="v2-read-tbl v2-tree-tbl rw-an-table"><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table></div>`;
}
const NOTE_BLOCKS = [["key_events", "Ключевые события"], ["key_tasks", "Ключевые задачи"], ["open_questions", "Открытые вопросы"]];
function analyticsReport(data) {
  const tiles = (data.tiles || []).map((t) => `<div class="v2-tile rw-tile-${esc(t.tone || "")}"><div class="v2-tile-value">${esc(t.value)}</div><div>${esc(t.label)}</div>${t.hint ? `<div class="v2-muted">${esc(t.hint)}</div>` : ""}</div>`).join("");
  const concl = (data.conclusions || []).length
    ? `<ul class="rw-concl">${data.conclusions.map((c) => `<li class="rw-sev-${esc(c.severity)}">${esc(c.text)}</li>`).join("")}</ul>`
    : `<p class="v2-muted">Замечаний нет.</p>`;
  // «События, задачи, вопросы» — те же, что в ежедневном отчёте; своего хранилища у справки нет (как в V1)
  const notes = data.notes || {};
  const blocks = NOTE_BLOCKS.filter(([k]) => (notes[k] || []).length)
    .map(([k, title]) => `<h4 class="rw-h4">${esc(title)}</h4><ul>${notes[k].map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`).join("");
  const notesHtml = blocks ? `<div class="rw-notes">${blocks}<p class="v2-muted">Ведутся в разделе «События, задачи, вопросы»${notes.effective_date ? `; редакция от ${esc(dateRu(notes.effective_date))}` : ""}.</p></div>` : "";
  const st = data.stages || { rows: [], columns: [] };
  const stagesRows = UI.anOnlyDeficit ? st.rows.filter((r) => r.deficit > 0) : st.rows;
  const hidden = st.rows.length - stagesRows.length;
  const t = st.total || {};
  const statusLine = `Горизонт до ${dateRu(data.horizon_end)}: потребность ${num(t.need)}, ${t.deficit > 0 ? `не законтрактовано ${num(t.deficit)}` : "контрактация закрыта"}. Всего по объекту: ${num(data.progress?.total?.percent)} % контрактации.`;
  const gaps = data.capacity_gaps || [];
  return `<p class="v2-muted" role="status">${esc(data.object_name || "")} · на ${esc(dateRu(data.report_date))} · ${esc(statusLine)}</p>
    <label class="v2-wire-check"><input type="checkbox" id="an-only-deficit" ${UI.anOnlyDeficit ? "checked" : ""}> Только позиции с дефицитом</label>
    ${tiles ? `<div class="v2-tiles">${tiles}</div>` : ""}
    <h3 class="v2-report-h">0. Резюме</h3>${concl}${notesHtml}
    <h3 class="v2-report-h">1.1. Обеспечение ближайших этапов СМР</h3>
    <p class="v2-muted">Этапы «кран + стоянка + этаж», где СМР уже идёт или начнётся до ${esc(dateRu(data.horizon_end))}. Зачёт контрактов — по маркам; колонка «по типу» справочная.${hidden ? ` Закрытых позиций скрыто: ${hidden}.` : ""}</p>
    ${anTable(st, stagesRows, "Итого по горизонту")}
    <h3 class="v2-report-h">1.2. Общий прогресс контрактации</h3>
    <p class="v2-muted">«Не в зачёт» — выкуплено по маркам, которых потребность не просит; «привязано к изделиям» — по скольким изделиям контракт реально назначен.</p>
    ${data.progress ? anTable(data.progress, data.progress.rows || [], "Итого") : ""}
    <h3 class="v2-report-h">2.1. Фронт работ по стоянкам</h3>
    <p class="v2-muted">Ярус не начинают, пока не смонтирован предыдущий, поэтому показаны текущий незакрытый ярус каждой стоянки и следующий за ним. «На площадке» — заполнена фактическая дата поставки.</p>
    ${data.front ? anTable(data.front, data.front.rows || []) : ""}
    <h3 class="v2-report-h">2.2. Чего не хватает на критическом пути</h3>
    ${data.critical?.truncated ? `<p class="v2-muted">Показано ${esc(num(data.critical.rows.length))} строк, ещё ${esc(num(data.critical.truncated))} не показаны — полный перечень в выгрузке XLSX.</p>` : ""}
    ${data.critical ? anTable(data.critical, data.critical.rows || []) : ""}
    <h3 class="v2-report-h">2.3. Динамика обеспечения</h3>
    ${anChartHtml(data.dynamics)}
    ${data.disclaimer ? `<p class="v2-muted">${esc(data.disclaimer)}</p>` : ""}
    ${gaps.length ? `<p class="v2-muted">Производительность не задана: ${gaps.slice(0, 6).map((g) => `${esc(g.counterparty || "дефицит без контракта")} — ${esc(g.element_type || "тип не определён")} (${esc(num(g.elements))} шт.)`).join("; ")}${gaps.length > 6 ? ` и ещё ${gaps.length - 6}` : ""}. Заполняется в карточке контрагента, закладка «Производительность».</p>` : ""}`;
}

// ==================== «Динамика поставки и монтажа» (перенос renderDynamicsReport) ====================
// Ежедневный отчёт: шапка с объектом, блоки «события/задачи/вопросы» (редакция на дату), график, вывод словами о сроке,
// две таблицы «Статус монтажа/поставки ЖБИ» (накопительно и за день). Недельная таблица — дополнительно (не вместо графика).
function dynList(cls, title, items, canEdit) {
  const body = items && items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="v2-muted">не заполнено</p>`;
  // Кнопка правки прямо в блоке (как ✎ в V1): открывает раздел «События, задачи, вопросы» на отчётную дату
  return `<div class="rw-dyn-box rw-dyn-${cls}"><h4 class="rw-h4">${esc(title)}${canEdit ? ` <button type="button" class="v2-btn rw-mini" data-dyn-edit="1" aria-label="Изменить: ${esc(title)}">✎ Изменить</button>` : ""}</h4>${body}</div>`;
}
function dynBlockTable(caption, block, date, note) {
  if (!block) return "";
  const dev = (v) => `<td class="num${v < 0 ? " rw-bad" : ""}" data-col-type="num">${v > 0 ? "+" + num(v) : esc(num(v))}</td>`;
  const c = block.cumulative || {}, d = block.day || {};
  return `<div class="v2-read-table rw-dyn-tbl"><table class="v2-read-tbl"><caption>${esc(caption)}</caption>
    <thead><tr><th rowspan="2">Всего в проекте</th><th colspan="3">Накопительно</th><th colspan="3">На ${esc(dateRu(date))}</th><th rowspan="2">%</th></tr>
    <tr><th>План</th><th>Факт</th><th>Отклонение</th><th>План</th><th>Факт</th><th>Отклонение</th></tr></thead>
    <tbody><tr><td class="num" data-col-type="num">${esc(num(block.total))}</td><td class="num" data-col-type="num">${esc(num(c.plan))}</td><td class="num" data-col-type="num">${esc(num(c.fact))}</td>${dev(c.deviation)}
      <td class="num" data-col-type="num">${esc(num(d.plan))}</td><td class="num" data-col-type="num">${esc(num(d.fact))}</td>${dev(d.deviation)}<td class="num" data-col-type="num">${esc(num(block.percent))}%</td></tr></tbody></table></div>
    ${note ? `<p class="v2-muted">${esc(note)}</p>` : ""}`;
}
function tableHtml(columns, rows) {
  return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${columns.map((c) => `<th data-col-type="${c.kind === "num" ? "num" : "text"}">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td${c.kind === "num" ? ' class="num" data-col-type="num"' : ""}>${esc(c.kind === "num" ? num(r[c.key]) : r[c.key] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function dynamicsReport(data, state, ctx) {
  const card = data.card || {};
  const canEdit = !!ctx?.canNotes;
  const labels = data.series_labels || {};
  const order = data.series_order || Object.keys(data.series || {});
  const weeks = data.weeks || [];
  const cols = [{ key: "week", label: "Неделя с" }, ...order.map((k) => ({ key: k, label: labels[k] || k, kind: "num" }))];
  const rows = weeks.map((w, i) => Object.fromEntries([["week", dateRu(w)], ...order.map((k) => [k, (data.series?.[k] || [])[i]])]));
  // Предупреждение о неполноте плана — план по части изделий внешне неотличим от полного и молча вводит в заблуждение.
  const cov = data.plan_coverage;
  const warns = [];
  if (cov && cov.smr < cov.total) warns.push(`план СМР задан у ${cov.smr} изделий из ${cov.total}`);
  if (cov && cov.delivery < cov.total) warns.push(`план поставки — у ${cov.delivery} из ${cov.total}`);
  return `<div class="rw-dyn-head"><h3 class="v2-report-h">Ежедневный отчёт за ${esc(dateRu(data.report_date))}</h3>
      <div class="v2-muted">${esc(data.subtitle || "")}</div><div><strong>${esc(card.title || "— объект не заполнен —")}</strong></div></div>
    <p class="v2-muted rw-center">${card.notes_effective_date ? `События, задачи и вопросы — редакция от ${esc(dateRu(card.notes_effective_date))}` : "События, задачи и вопросы на эту дату не заполнены"}</p>
    ${warns.length ? `<div class="v2-callout v2-callout-bad" role="alert">Внимание: ${esc(warns.join("; "))}. Кривая плана неполная.</div>` : ""}
    ${forecastCoverageHtml(data)}
    ${data.forecast_version_id ? "" : `<p class="v2-muted">Кривой прогноза нет: по объекту не загружен ни один актуализированный график. Загрузить — «Обмен данными → Импорт графика MS Project», вид «Актуализированный»; посчитать самой системой — «Документы → График СМР → Расчёт».</p>`}
    <div class="rw-dyn-boxes">${dynList("events", "Ключевые события", card.key_events, canEdit)}${dynList("tasks", "Ключевые задачи", card.key_tasks, canEdit)}</div>
    <div class="v2-chart-wrap">${buildDynamicsChartSvg(data)}</div>
    ${finishVerdictHtml(data)}
    <div class="rw-dyn-bottom"><div class="rw-dyn-tables">
      ${dynBlockTable("Статус монтажа ЖБИ", data.montage, data.report_date, card.montage_deadline ? `* окончание монтажа изделий ${dateRu(card.montage_deadline)}` : "")}
      ${dynBlockTable("Статус поставки ЖБИ", data.delivery, data.report_date, card.delivery_deadline ? `** окончание поставки изделий ${dateRu(card.delivery_deadline)}` : "")}
    </div><div class="rw-dyn-q">${dynList("questions", "Открытые вопросы", card.open_questions, canEdit)}</div></div>
    <h3 class="v2-report-h">Значения по неделям</h3>
    ${rows.length ? tableHtml(cols, rows) : `<p class="v2-muted">Данных по неделям нет.</p>`}`;
}

// ==================== «Моя работа» (перенос renderMyWorkReport) ====================
const timeNoMs = (v) => {
  const t = String(v ?? "");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" });
};
function myworkReport(data, state, ctx) {
  const who = (data.users || []).map((u) => u.display_name).join(", ") || "Все пользователи";
  const chips = (data.by_action || []).map((i) => `<span class="v2-chip rw-chip">${esc(i.title)} <b>${esc(num(i.count))}</b></span>`).join("");
  const rows = (data.rows || []).map((r) => {
    // Переход к изделию на схеме — только у ЖИВОГО изделия: у события про контракт или проект показывать нечего, а изделие,
    // исчезнувшее из чертежа при переимпорте (is_current = 0), показать негде (как в V1).
    const el = r.element;
    const locatable = !!(el && el.is_current);
    const addr = el ? [el.address, el.floor != null ? `${el.floor} этаж` : null].filter(Boolean).join(" · ") : "";
    const other = el && ctx?.objectId != null && el.object_id !== ctx.objectId ? ` <span class="v2-muted">(${esc(el.object_name || "другой объект")})</span>` : "";
    const itemText = r.item || "";
    const item = locatable
      ? `<button type="button" class="v2-link rw-locate" data-el="${el.id}" data-obj="${el.object_id ?? ""}" title="Показать на схеме">${esc(itemText || `изделие #${el.id}`)}</button>`
      : itemText ? esc(itemText) : r.entity_type ? `<span class="v2-muted">${esc(r.entity_type)} #${esc(r.entity_id ?? "")}</span>` : "";
    return `<tr${locatable ? ` class="rw-locatable"` : ""}><td class="rw-nowrap">${esc(timeNoMs(r.at))}</td><td>${esc(r.user_name || "")}</td><td>${esc(r.action_title)}</td>
      <td>${item}${other}${addr ? `<br><span class="v2-muted">${esc(addr)}</span>` : ""}</td><td>${esc(r.old_text)}</td><td>${esc(r.new_text)}</td></tr>`;
  }).join("");
  return `<p class="v2-muted" role="status">${esc(who)} · событий за период: ${esc(num(data.total))} · ${esc(dateRu(data.date_from))} — ${esc(dateRu(data.date_to))}</p>
    ${chips ? `<div class="rw-chips">${chips}</div>` : ""}
    ${rows ? `<div class="v2-read-table"><table class="v2-read-tbl" id="mw-table"><thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Изделие / объект</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="v2-muted">За выбранный период изменений нет.</p>`}
    ${data.truncated ? `<p class="v2-muted">Показаны первые ${esc(num(data.shown))} событий из ${esc(num(data.total))} — сузьте период, чтобы увидеть остальные.</p>` : ""}`;
}
// «Показать на схеме» (V1: locateElementOnPlan): изделие другого объекта — сначала переключаем объект (схема показывает
// один объект), затем рабочее место «Модель» выделяет изделие и наводит на него кадр (locate-handoff.js → workspace.js).
async function locateOnScheme(ctx, elementId, objId) {
  const target = objId ?? ctx.objectId;
  if (target !== ctx.objectId) {
    if (ctx.hasObject && !ctx.hasObject(target)) { await showInfoDialog("Изделие относится к другому объекту, недоступному вам."); return; }
    if (!ctx.switchObject || !(await ctx.switchObject(target))) return;
  }
  requestLocate({ objectId: target, elementId });
  if (ctx.go) ctx.go("ws-model"); else location.hash = "#/ws-model";
}

// ==================== «Линейный трек» (перенос renderLinearTrackReport) ====================
function linearTrackReport(data) {
  if (!data.count) return `<p class="v2-muted">Справочник видов работ пуст — сначала загрузите WBS («Учёт по блокам»).</p>`;
  const rows = (data.rows || []).map((r) => `<tr><td>${r.row_kind === "веха" ? `<span class="v2-muted">[веха] </span>` : ""}${esc((r.wbs || []).filter(Boolean).join(" / "))}</td>
    <td class="rw-nowrap">${esc(r.code || "")}</td><td>${esc(r.unit || "")}</td><td>${esc(r.track_name || "—")}</td><td>${esc(r.note || "")}</td></tr>`).join("");
  return `<p class="v2-muted" role="status">Позиций: ${esc(num(data.count))}</p>
    <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>WBS</th><th>Код</th><th>Ед. изм.</th><th>Трек планирования</th><th>Примечание</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="v2-muted">Без прогресса и сроков — учёт по этим позициям будет отдельной доработкой.</p>`;
}

// ==================== «График работ по блокам» (перенос renderBlockScheduleReport + группировка) ====================
// Состав уровней и ключ хранения — те же, что у V1 (app.js: BSCH_ALL_GROUPS, BSCH_GROUPS_KEY «zhbi_block_schedule_groups»):
// порядок и флаги — настройка «как я привык смотреть», общая для V1 и V2 в одном браузере.
const BSCH_KEY = "zhbi_block_schedule_groups";
const BSCH_ALL = [{ key: "track", label: "Трек" }, { key: "wbs_section", label: "Раздел WBS" }, { key: "operation", label: "Операция" }, { key: "section", label: "Секция" }, { key: "floor", label: "Этаж" }];
const BSCH_DEFAULT = BSCH_ALL.map((g) => g.key);
function bschLoad() {
  const fallback = () => BSCH_ALL.map((g) => ({ ...g, on: BSCH_DEFAULT.includes(g.key) }));
  try {
    const saved = JSON.parse(localStorage.getItem(BSCH_KEY) || "null");
    if (!Array.isArray(saved)) return fallback();
    const byKey = new Map(saved.map((it, i) => [it.key, { i, on: !!it.on }]));
    const out = BSCH_ALL.map((g) => ({ ...g, on: byKey.has(g.key) ? byKey.get(g.key).on : false }));
    out.sort((a, b) => (byKey.get(a.key)?.i ?? 99) - (byKey.get(b.key)?.i ?? 99));
    return out.some((g) => g.on) ? out : fallback();
  } catch (e) { return fallback(); }
}
function bschSave(groups) { try { localStorage.setItem(BSCH_KEY, JSON.stringify(groups.map((g) => ({ key: g.key, on: g.on })))); } catch (e) { /* хранилище недоступно — выбор живёт до ухода с экрана */ } }
const bschSelected = (groups) => groups.filter((g) => g.on).map((g) => g.key);
let bschGroups = null;
function bschChooserHtml() {
  const groups = bschGroups || (bschGroups = bschLoad());
  return `<div class="rw-chips" role="group" aria-label="Группировка строк"><span class="v2-muted">Группировка:</span>${groups.map((g, i) => `<span class="rw-gchip ${g.on ? "on" : "off"}">
    <label><input type="checkbox" data-bsg-toggle="${g.key}" ${g.on ? "checked" : ""}> ${esc(g.label)}</label>
    <button type="button" class="rw-gmove" data-bsg-move="${g.key}" data-dir="-1" aria-label="${esc(g.label)}: левее (выше в иерархии)" ${i === 0 ? "disabled" : ""}>◀</button>
    <button type="button" class="rw-gmove" data-bsg-move="${g.key}" data-dir="1" aria-label="${esc(g.label)}: правее (ниже в иерархии)" ${i === groups.length - 1 ? "disabled" : ""}>▶</button></span>`).join("")}
    <span class="v2-muted" id="bsg-msg" role="status" aria-live="polite"></span></div>`;
}
const bschAgg = (a) => `всего ${a?.всего ?? 0} · выполнено ${a?.доля_выполненных == null ? "—" : `${a.доля_выполненных}%`} · среднее отклонение ${a?.среднее_отклонение == null ? "—" : `${a.среднее_отклонение > 0 ? "+" : ""}${a.среднее_отклонение} дн`} · отстают ${a?.отстают ?? 0}`;
function bschRange(rows) {
  let min = null, max = null;
  const see = (d) => { if (!d) return; if (!min || d < min) min = d; if (!max || d > max) max = d; };
  (function walk(nodes) { for (const n of nodes) { for (const r of n.rows || []) { see(r.plan_start); see(r.plan_end); see(r.forecast_start); see(r.forecast_end); } walk(n.children || []); } })(rows);
  return { min, max };
}
function bschBar(start, end, { min, max }) {
  if ((!start && !end) || !min) return null;
  const s = start || end, e = end || start;
  const span = (new Date(max) - new Date(min)) || 1;
  const left = Math.max(0, ((new Date(s) - new Date(min)) / span) * 100);
  const width = Math.max(0.6, ((new Date(e) - new Date(s)) / span) * 100);
  return `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`;
}
function bschRows(nodes, depth, range, view) {
  return nodes.map((n) => {
    const pad = 8 + depth * 16;
    const head = `<tr class="rw-bsch-group"><td style="padding-left:${pad}px" colspan="7"><strong>${esc(n.label)}</strong> <span class="v2-muted">${esc(bschAgg(n.agg))}</span></td></tr>`;
    const rows = (n.rows || []).map((r) => {
      const name = `<td style="padding-left:${pad + 16}px">${esc(r["название"] || "")}</td>`;
      if (view === "gantt") {
        const plan = bschBar(r.plan_start, r.plan_end, range), fc = bschBar(r.forecast_start, r.forecast_end, range);
        return `<tr>${name}<td colspan="5" class="rw-gantt-cell"><div class="rw-gantt-track">
          ${plan ? `<div class="rw-gantt-bar rw-gantt-plan" style="${plan}" title="План: ${shortDate(r.plan_start)}–${shortDate(r.plan_end)}"></div>` : ""}
          ${fc ? `<div class="rw-gantt-bar rw-gantt-forecast" style="${fc}" title="Прогноз: ${shortDate(r.forecast_start)}–${shortDate(r.forecast_end)}"></div>` : ""}</div></td>
          <td class="num rw-dl-${esc(r.deadline)}">${esc(num(r.percent))}%</td></tr>`;
      }
      return `<tr>${name}<td class="rw-nowrap">${shortDate(r.plan_start)}–${shortDate(r.plan_end)}</td><td class="rw-nowrap">${shortDate(r.forecast_start)}–${shortDate(r.forecast_end)}</td>
        <td class="num">${esc(num(r.percent))}%</td><td class="rw-nowrap rw-dl-${esc(r.deadline)}">${r.deviation_end == null ? "—" : esc(devLabel(r.deviation_end))}</td>
        <td class="rw-dl-${esc(r.deadline)}">${esc(r.deadline_label || "")}</td><td>${esc(r["ответственный"] || "")}</td></tr>`;
    }).join("");
    return head + rows + bschRows(n.children || [], depth + 1, range, view);
  }).join("");
}
function blockScheduleReport(data) {
  const chooser = bschChooserHtml();
  if (!data.elements) return `${chooser}<p class="v2-muted">Запланированных работ ещё нет — «Настройки» в панели блока.</p>`;
  const range = bschRange(data.rows || []);
  const head = data.view === "gantt"
    ? `<tr><th>Операция</th><th colspan="5">План / прогноз${range.min ? ` <span class="v2-muted">(${esc(dateRu(range.min))} — ${esc(dateRu(range.max))})</span>` : ""}</th><th>%</th></tr>`
    : `<tr><th>Операция</th><th>План</th><th>Прогноз</th><th>%</th><th>Откл., дн</th><th>Признак</th><th>Ответственный</th></tr>`;
  return `${chooser}<p class="v2-muted" role="status">Запланированных работ: ${esc(num(data.elements))} · на ${esc(dateRu(data.today))}${data.view === "gantt" ? ` · <span class="rw-legend rw-gantt-plan"></span> план <span class="rw-legend rw-gantt-forecast"></span> прогноз` : ""}</p>
    <div class="v2-read-table"><table class="v2-read-tbl rw-bsch" id="bsch-table"><thead>${head}</thead>
    <tbody>${bschRows(data.rows || [], 0, range, data.view)}<tr class="lvl-total rw-bsch-total"><td colspan="7"><strong>Итого:</strong> ${esc(bschAgg(data.total))}</td></tr></tbody></table></div>`;
}
// Первый запрос уходит уже с выбранной человеком группировкой (без лишнего запроса с группировкой по умолчанию)
function initBlockSchedule(params) {
  bschGroups = bschLoad();
  params.group_by = bschSelected(bschGroups);
  if (!params.view) params.view = "table";
}
function bindBlockSchedule(root, ctx) {
  const msg = (t) => { const n = root.querySelector("#bsg-msg"); if (n) n.textContent = t; };
  const apply = () => { bschSave(bschGroups); ctx?.setParams?.({ group_by: bschSelected(bschGroups) }); };
  root.querySelectorAll("[data-bsg-toggle]").forEach((c) => c.addEventListener("change", () => {
    const g = bschGroups.find((x) => x.key === c.dataset.bsgToggle);
    if (!g) return;
    // ноль уровней — одна строка «Итого», и сервер молча вернул бы группировку по умолчанию: последнюю не снимаем (как в V1)
    if (g.on && bschGroups.filter((x) => x.on).length === 1) { c.checked = true; msg("Хотя бы один уровень группировки должен остаться"); return; }
    g.on = c.checked; apply();
  }));
  root.querySelectorAll("[data-bsg-move]").forEach((b) => b.addEventListener("click", () => {
    const i = bschGroups.findIndex((x) => x.key === b.dataset.bsgMove), j = i + Number(b.dataset.dir);
    if (i < 0 || j < 0 || j >= bschGroups.length) return;
    [bschGroups[i], bschGroups[j]] = [bschGroups[j], bschGroups[i]];
    apply();
  }));
}

// ==================== «Учёт по блокам: статусы» (перенос renderBlockStatusReport) ====================
// Матрица «операция WBS × блок (секция/этаж) / секция целиком / объект». «Показывать» — те же ячейки «эт/сек»/«кв.эт/сек»,
// другая величина (процент/план/прогноз/отклонение, как в V1); правка ячейки — только в режиме «процент». Правка:
// «эт/сек» — число (PUT .../blocks/{id}/work-progress-cell на дату отчёта), «сек»/«компл» — клик крутит План → В работе →
// Выполнено → План (PUT /work-progress/cell). Доступна только при праве «Учёт по блокам: изменение» (work_progress).
const BW_STATUS = { plan: "план", in_progress: "в работе", done: "выполнено" };
const BS_MODES = [["percent", "процент"], ["plan", "план"], ["forecast", "прогноз"], ["deviation", "отклонение"]];
function bsFlatten(nodes, depth, out) { for (const n of nodes) { out.push({ n, depth }); if (n.children?.length) bsFlatten(n.children, depth + 1, out); } return out; }
function blockStatusReport(data, state, ctx) {
  const blocks = data.blocks || [];
  const modeSel = `<label class="v2-wire-field rw-inline"><span>Показывать</span><select id="bs-mode">${BS_MODES.map(([v, l]) => `<option value="${v}" ${UI.bsMode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
  if (!(data.tree || []).length) return `${modeSel}<p class="v2-muted">Справочник видов работ ещё не загружен (Учёт по блокам → Виды работ).</p>`;
  if (!blocks.length && !(data.sections || []).length) return `${modeSel}<p class="v2-muted">Блоков ещё нет (Учёт по блокам → Блоки).</p>`;
  const all = bsFlatten(data.tree, 0, []);
  const leaves = all.filter(({ n }) => n.row_kind !== "узел" && !n.children?.length);
  const withData = leaves.filter(({ n }) => n.cells && Object.keys(n.cells).length);
  // По умолчанию — только операции с данными (V2); «Показать все» — всё дерево с узлами, как в V1
  const rows = state.all ? all : withData;
  const groups = [];
  for (const b of blocks) { const g = groups[groups.length - 1]; if (g && g.code === b.section_code) g.n++; else groups.push({ code: b.section_code, n: 1 }); }
  const sectionCols = (data.sections || []).map((s) => ({ id: s.id, label: `${s.code} целиком` }));
  const canEdit = !!ctx?.canWrite;
  const mode = UI.bsMode;
  const blockCell = (l, b) => {
    const c = l.cells?.[String(b.id)];
    if (!l.addressable || (l.unit !== "эт/сек" && l.unit !== "кв.эт/сек")) return `<td class="v2-matrix-off"></td>`;
    if (!c) return `<td class="v2-matrix-off" title="Операция не выбрана для этого блока — «Настройки» в панели блока">·</td>`;
    const expect = c.expected_percent != null ? `есть ${c.percent}%, по плану должно быть ${c.expected_percent}%` : `${BW_STATUS[c.status] || c.status || ""}${c.deadline_label ? `, ${c.deadline_label}` : ""}`;
    if (mode === "plan") return `<td class="v2-matrix-${esc(c.status)} rw-nowrap" title="${esc(expect)}">${shortDate(c.plan_start)}–${shortDate(c.plan_end)}</td>`;
    if (mode === "forecast") return `<td class="v2-matrix-${esc(c.status)} rw-nowrap" title="${esc(expect)}">${shortDate(c.forecast_start)}–${shortDate(c.forecast_end)}</td>`;
    if (mode === "deviation") return `<td class="v2-matrix-${esc(c.status)} rw-nowrap rw-dl-${esc(c.deadline)}" title="${esc(expect)}">${c.deviation_end == null ? "—" : esc(devLabel(c.deviation_end))}</td>`;
    if (!canEdit) return `<td class="num v2-matrix-${esc(c.status)}"><span title="${esc(expect)}">${esc(num(c.percent))}</span></td>`;
    return `<td class="num v2-matrix-${esc(c.status)}"><input type="number" class="v2-matrix-input" min="0" max="100" step="1" value="${esc(c.percent)}" data-wt="${l.id}" data-block="${b.id}" aria-label="Процент: ${esc(l.name)}, ${esc(b.section_code)} ${esc(b.level_name ?? b.level_floor ?? "")}"></td>`;
  };
  // «сек»/«компл»: колонка «Объект» кликабельна ТОЛЬКО у строк «компл», колонка секции — ТОЛЬКО у строк «сек»
  const cycleCell = (l, key, label, expectUnit) => {
    if (!l.addressable || l.unit !== expectUnit) return `<td class="v2-matrix-off"></td>`;
    const status = l.cells?.[key] || "plan";
    if (!canEdit) return `<td class="v2-matrix-${esc(status)}">${esc(BW_STATUS[status] || status)}</td>`;
    return `<td class="v2-matrix-${esc(status)}"><button type="button" class="v2-matrix-cycle" data-wt="${l.id}" data-sec="${key === "объект" ? "" : key}" aria-label="${esc(label)}: ${esc(BW_STATUS[status])} — щелчок переключит статус">${esc(BW_STATUS[status])}</button></td>`;
  };
  const nodeRow = (n, depth) => `<tr class="rw-node"><td></td><td style="padding-left:${8 + depth * 16}px"><strong>${esc(n.name || "(без названия)")}</strong></td>${blocks.map(() => "<td></td>").join("")}${sectionCols.map(() => "<td></td>").join("")}<td></td></tr>`;
  const leafRow = (l, depth) => `<tr><td>${esc(l.code || "")}</td><td style="padding-left:${8 + depth * 16}px">${esc(l.name || "(без названия)")}</td>${blocks.map((b) => blockCell(l, b)).join("")}${sectionCols.map((s) => cycleCell(l, String(s.id), s.label, "сек")).join("")}${cycleCell(l, "объект", "Объект", "компл")}</tr>`;
  const body = rows.map(({ n, depth }) => (n.row_kind === "узел" || n.children?.length ? nodeRow(n, depth) : leafRow(n, state.all ? depth : 0))).join("");
  return `<div class="v2-wire-row v2-report-controls">${modeSel}<label class="v2-wire-check"><input type="checkbox" id="bs-all" ${state.all ? "checked" : ""}> Показать все операции WBS с разделами (по умолчанию — только операции с данными)</label></div>
    <p class="v2-muted" role="status">Блоков: ${blocks.length}, секций: ${(data.sections || []).length} · операций WBS: ${leaves.length}, с данными: ${withData.length} · на ${esc(dateRu(data.report_date))}${canEdit ? (mode === "percent" ? "" : " · правка процента — в режиме «процент»") : " · только просмотр"}</p>
    <p id="bs-cell-msg" class="v2-muted" role="status" aria-live="polite">${esc(state.cellMsg || "")}</p>
    ${rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl v2-matrix"><thead>
      <tr><th rowspan="2">Код</th><th rowspan="2">Работа</th>${groups.map((g) => `<th colspan="${g.n}">${esc(g.code)}</th>`).join("")}${sectionCols.map((s) => `<th rowspan="2">${esc(s.label)}</th>`).join("")}<th rowspan="2">Объект</th></tr>
      <tr>${blocks.map((b) => `<th title="${esc(b.level_name)}">${esc(String(b.level_name ?? "").slice(0, 12))}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table></div>` : `<p class="v2-muted">Операций с данными нет — «Показать все операции WBS».</p>`}`;
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

export const WORK_REPORT_RENDERERS = { analytics: analyticsReport, dynamics: dynamicsReport, mywork: myworkReport, linear: linearTrackReport, blocksched: blockScheduleReport, blockstatus: blockStatusReport };
// Подготовка параметров ДО первого запроса (read-screen.js): группировка «Графика работ по блокам» из сохранённого выбора
export const REPORT_INIT = { blocksched: initBlockSchedule };

export function bindWorkReport(name, root, state, repaint, ctx) {
  if (name === "analytics") {
    root.querySelector("#an-only-deficit")?.addEventListener("change", (e) => { UI.anOnlyDeficit = e.target.checked; repaint(); });
  }
  if (name === "dynamics") {
    root.querySelectorAll("[data-dyn-edit]").forEach((b) => b.addEventListener("click", () => {
      // Раздел «События, задачи, вопросы» откроется на отчётной дате (как ✎ в V1: нет редакции на эту дату — новая с этой датой)
      try { sessionStorage.setItem("v2.notesPrefill", JSON.stringify({ objectId: ctx?.objectId, date: ctx?.data?.report_date || null })); } catch (e) { /* без подстановки даты */ }
      if (ctx?.go) ctx.go("report-notes"); else location.hash = "#/report-notes";
    }));
  }
  if (name === "mywork") {
    const table = root.querySelector("#mw-table");
    table?.addEventListener("click", (e) => {
      const btn = e.target.closest(".rw-locate") || e.target.closest("tr.rw-locatable")?.querySelector(".rw-locate");
      if (!btn || !ctx) return;
      e.preventDefault();
      locateOnScheme(ctx, Number(btn.dataset.el), btn.dataset.obj ? Number(btn.dataset.obj) : null);
    });
  }
  if (name === "blocksched") bindBlockSchedule(root, ctx);
  if (name === "blockstatus") {
    root.querySelector("#bs-all")?.addEventListener("change", (e) => { state.all = e.target.checked; repaint(); });
    root.querySelector("#bs-mode")?.addEventListener("change", (e) => { UI.bsMode = e.target.value; repaint(); });
    // процент правится полем только в режиме «процент»; «сек»/«компл» — кликом в любом режиме (как в V1)
    if (ctx?.canWrite) bindBlockStatusEdits(root, state, repaint, ctx);
  }
}
