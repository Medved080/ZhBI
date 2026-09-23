// Экран V2 «только чтение»: таблица данных из существующего GET-эндпоинта (справочники, списки, журналы).
// Описание секций — в screens.json (`read.sections`): endpoint, колонки, поиск, постраничность. Никаких
// изменяющих запросов здесь нет: правка остаётся в текущем интерфейсе, ссылка на неё — в плашке экрана.
//
// Состояния: загрузка, ошибка (текст сервера + «Повторить»), пусто, «нужен объект». Ответ, пришедший после
// смены вкладки, объекта или ухода с экрана, отбрасывается (счётчик запросов) и чужую таблицу не перерисовывает.
import { ApiError } from "./api.js";
import { statusChip } from "./registry.js";
import { esc, linkList } from "./screen-view.js";
import { REPORT_RENDERERS, REPORT_INIT, bindReport, colDataType } from "./reports.js";
import { mountBlockWorkForm } from "./block-work-form.js";
import { printHtml } from "./print.js";
import { showInfoDialog } from "./dialogs.js";
import { filterSnapshotFor, describeFilterSnapshot, consumeFilteredReportOpen } from "./scheme-filter-snapshot.js";

const RENDER_LIMIT = 500;

function pick(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? "");
}
function fmtDateTime(v) {
  if (!v) return "";
  const s = String(v);
  // Сервер отдаёт время журнала в UTC без указания пояса — трактуем как UTC и показываем по местным часам.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" });
}
function fmtSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} ГБ`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} МБ`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} КБ`;
  return `${n} Б`;
}
export function formatCell(col, row, data) {
  let v = pick(row, col.key);
  const dict = col.mapFrom ? pick(data, col.mapFrom) : col.map;
  if (dict && v != null && dict[v] !== undefined) v = dict[v];
  switch (col.fmt) {
    case "size": return fmtSize(v);
    // итог обучения: «лучший из всего, попыток N»; нет попыток — прочерк (как в V1: trainingScoreText)
    case "score": return v && v.attempts ? `${v.best} из ${v.total}, попыток ${v.attempts}` : "—";
    case "date": return fmtDate(v);
    case "datetime": return fmtDateTime(v);
    case "bool": return v === true || v === 1 ? "да" : v === false || v === 0 ? "нет" : "";
    case "list": return Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    default: return v == null ? "" : String(v);
  }
}

function cellHtml(col, row, data) {
  const text = formatCell(col, row, data);
  if (col.fmt === "color" && text) return `<span class="v2-swatch" style="background:${esc(text)}" aria-hidden="true"></span> ${esc(text)}`;
  return esc(text);
}

// Запись (один объект ответа): список «поле — значение» и вложенные таблицы.
function paintRecord(sec, data) {
  const fields = (sec.fields || []).map((f) => {
    const text = formatCell(f, data ?? {}, data);
    return `<dt>${esc(f.title)}</dt><dd>${f.fmt === "color" && text ? cellHtml(f, data, data) : esc(text) || `<span class="v2-muted">не задано</span>`}</dd>`;
  }).join("");
  const tables = (sec.tables || []).map((t) => {
    const rows = pick(data, t.rowsPath);
    const list = Array.isArray(rows) ? rows : [];
    return `<h3 class="v2-report-h">${esc(t.title)}</h3>` + (list.length
      ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${t.columns.map((c) => `<th data-col-type="${colDataType(c)}">${esc(c.title)}</th>`).join("")}</tr></thead>
         <tbody>${list.slice(0, RENDER_LIMIT).map((r) => `<tr>${t.columns.map((c) => `<td data-col-type="${colDataType(c)}">${cellHtml(c, r, data)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : `<p class="v2-muted">${esc(t.empty || "Записей нет.")}</p>`);
  }).join("");
  return `${fields ? `<dl class="v2-facts">${fields}</dl>` : ""}${tables}`;
}

// Инструкция («Обучение»): блоки по группам, раскрывающиеся; только текст абзацев (без разметки), поиск по заголовкам и тексту
function paintGuide(data, search) {
  const q = String(search || "").trim().toLowerCase();
  const blocks = (data?.blocks || []).filter((b) => !q || `${b.section} ${b.title} ${(b.paragraphs || []).join(" ")}`.toLowerCase().includes(q));
  const groups = data?.group_order || [...new Set((data?.blocks || []).map((b) => b.group))];
  const html = groups.map((g) => {
    const items = blocks.filter((b) => b.group === g);
    if (!items.length) return "";
    return `<h3 class="v2-report-h">${esc(g)} <span class="v2-muted">· ${items.length}</span></h3>
      ${data.group_captions?.[g] ? `<p class="v2-muted">${esc(data.group_captions[g])}</p>` : ""}
      ${items.map((b) => `<details class="v2-wire"><summary>${esc(b.section)} › ${esc(b.title)}</summary><div class="v2-wire-body">${(b.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join("")}</div></details>`).join("")}`;
  }).join("");
  return `<p class="v2-muted" role="status">Блоков инструкции: ${blocks.length} из ${(data?.blocks || []).length}. Вопросов теста: ${esc(data?.questions_total ?? "?")}.</p>${html || `<p class="v2-muted">Ничего не найдено по запросу «${esc(search)}».</p>`}`;
}

// Печать отчёта (mfr2, перенос из V1: `document.getElementById("report-print").addEventListener("click", () => window.print())`) —
// системное окно печати браузера, содержимое — снимок текущей таблицы отчёта.
function printReportTable(title) {
  const src = document.querySelector("#rd-report");
  if (!src) return;
  printHtml(`<h2>${esc(title)}</h2>${src.innerHTML}`);
}

// localStorage может быть недоступен (приватный режим, запрет сайта) — тогда настройка живёт только до ухода с экрана.
function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* не критично */ } }

// Уровни группировки (перенос createGroupChooser из V1): из сохранённого берутся только порядок и флажки, состав
// уровней — из описания экрана, иначе новый уровень не появился бы у тех, у кого настройка уже сохранена. Формат
// сохранения — V1: [{key, on}] в порядке показа.
function loadGroups(c) {
  const fallback = () => c.groups.map((g) => ({ ...g, on: (c.defaultOn || []).includes(g.key) }));
  try {
    const saved = JSON.parse((c.remember && lsGet(c.remember)) || "null");
    if (!Array.isArray(saved)) return fallback();
    const byKey = new Map(saved.map((item, i) => [item.key, { i, on: !!item.on }]));
    const out = c.groups.map((g) => ({ ...g, on: byKey.has(g.key) ? byKey.get(g.key).on : false }));
    out.sort((a, b) => (byKey.get(a.key)?.i ?? 99) - (byKey.get(b.key)?.i ?? 99));
    return out.some((g) => g.on) ? out : fallback();
  } catch (e) { return fallback(); }
}

function errorText(err) {
  if (err instanceof ApiError) {
    const d = err.detail;
    return typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg || JSON.stringify(x)).join("; ") : `Ошибка ${err.status}`;
  }
  return String(err?.message || err);
}

export function mountReadScreen(el, { screen, structure, objectId, api, groupTitle, rights, go, switchObject, hasObject }) {
  el.className = "v2-page";
  const sections = screen.read.sections;
  let dead = false;
  let active = 0;
  let editor = null; // открытая карточка строки (правка запланированной работы)
  let deliveryCellsBound = false; // обработчики разбора ячейки «Графика поставки» уже на #rd-body (см. paintReport)
  const canEditRows = (sec) => !!sec.rowEdit && (!!rights?.system_admin || rights?.features?.[sec.rowEdit.feature] === "write");
  // Отчёт с правкой ячейки прямо в таблице (mfr2: «Учёт по блокам: статусы») — право записи берётся из своего раздела
  // (`writeFeature`, обычно "work_progress"), НЕ из права на сам отчёт (`report_block_status`) — так же, как в V1.
  const canWriteReport = (sec) => !!sec.writeFeature && (!!rights?.system_admin || rights?.features?.[sec.writeFeature] === "write");
  async function closeEditor() { if (editor) { if (!(await editor.guard())) return false; editor.destroy(); editor = null; } return true; }
  const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  // Границы дня: журнал хранит время в UTC, а человек выбирает дни по местным часам (та же функция, что в V1).
  const boundUtc = (dateStr, end) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
    if (!m) return dateStr || null;
    const d = end ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
  };
  const st = sections.map((sec) => ({ status: "idle", rows: [], total: null, error: "", seq: 0, search: "", offset: 0, data: null, params: {},
    rs: sec.report === "blockstatus" ? { all: true } : {}, acking: false, ackMsg: "", filterOn: false }));

  sections.forEach((sec, i) => (sec.controls || []).forEach((c) => { if (c.default === "today") st[i].params[c.param] = todayIso(); }));
  // При переходе из «Моей работы» к изделию схема заменяет весь экран отчёта.
  // Держим выбранный период в этой вкладке браузера и отдельно для каждого объекта.
  const myworkPeriodKey = objectId == null ? null : `v2.myworkPeriod.${objectId}`;
  const saveMyworkPeriod = (s) => {
    if (!myworkPeriodKey) return;
    try { sessionStorage.setItem(myworkPeriodKey, JSON.stringify({ date_from: s.params.date_from, date_to: s.params.date_to })); } catch (e) { /* недоступное хранилище не мешает отчёту */ }
  };
  sections.forEach((sec, i) => {
    if (sec.report !== "mywork" || !myworkPeriodKey) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(myworkPeriodKey) || "null");
      for (const key of ["date_from", "date_to"]) if (/^\d{4}-\d{2}-\d{2}$/.test(saved?.[key] || "")) st[i].params[key] = saved[key];
    } catch (e) { /* повреждённый снимок — период по умолчанию */ }
  });
  // «Учитывать текущий фильтр схемы» (перенос V1: reportUseFilter) — у «Статуса комплектации» включена по
  // умолчанию (см. schemeFilterDefault в screens.json), у остальных — выключена, пока человек сам не включит.
  sections.forEach((sec, i) => { if (sec.schemeFilterDefault) st[i].filterOn = true; });
  const openedFromWorkspace = consumeFilteredReportOpen(screen.id, objectId);
  if (openedFromWorkspace) {
    sections.forEach((sec, i) => {
      if (sec.schemeFilter) st[i].filterOn = true;
      if (sec.report === "dynamics" && /^\d{4}-\d{2}-\d{2}$/.test(openedFromWorkspace.reportDate || ""))
        st[i].params.report_date = openedFromWorkspace.reportDate;
    });
  }
  // Запоминаемые настройки отчёта (`remember` — ключ localStorage; reports2: вид и уровни группировки «Статуса
  // комплектации»). Ключи и формат — ТЕ ЖЕ, что у V1 (zhbi_completion_view, zhbi_completion_pivot_groups):
  // это настройка «как я привык смотреть» одного человека в одном браузере, и V1 с V2 не должны спорить о ней.
  sections.forEach((sec, i) => (sec.controls || []).forEach((c) => {
    if (c.type === "select" && c.remember) {
      const saved = lsGet(c.remember);
      if (saved != null && (c.options || []).some((o) => String(o[c.valueKey]) === saved)) st[i].params[c.param] = saved;
    }
    if (c.type === "groups") {
      st[i].groups = st[i].groups || {};
      st[i].groups[c.param] = loadGroups(c);
      st[i].params[c.param] = st[i].groups[c.param].filter((g) => g.on).map((g) => g.key);
    }
  }));
  // Параметры, которые отчёт выбирает ДО первого запроса (сохранённая группировка «Графика работ по блокам» — reports-work.js)
  sections.forEach((sec, i) => { if (sec.kind === "report") REPORT_INIT[sec.report]?.(st[i].params); });

  // Табличные экраны (отчёты, справочники, реестры, журналы) занимают всю доступную ширину рабочей области —
  // карточка записи («record») и инструкция («guide») читаются лучше при ограниченной ширине формы, как обычные
  // формы V2 (задание «tables», п.1). Ширина остатка после левой навигации уже даёт раскладка .v2-body (flex).
  const wide = sections.some((sec) => sec.kind !== "record" && sec.kind !== "guide");
  el.innerHTML = `
    <div class="v2-container v2-screen${wide ? " v2-container--wide" : ""}">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head">
        <h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}
      </div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note">
        <strong>Просмотр в новом интерфейсе.</strong> ${esc(screen.read.note || "Изменение данных этого экрана пока выполняется в текущем интерфейсе.")}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div>
      </div>
      ${sections.length > 1 ? `<div class="v2-wire-tabs v2-read-tabs" role="tablist">${sections.map((s, i) =>
        `<button type="button" role="tab" class="v2-read-tab" data-tab="${i}" aria-selected="${i === 0}">${esc(s.title)}</button>`).join("")}</div>` : ""}
      <div class="v2-bar v2-read-bar">
        <input type="search" id="rd-search" class="v2-search" placeholder="Поиск по таблице" aria-label="Поиск по таблице">
        <span class="v2-muted" id="rd-count" role="status" aria-live="polite"></span>
        <button type="button" class="v2-btn" id="rd-refresh">Обновить</button>
      </div>
      <div id="rd-editor"></div>
      <div id="rd-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const searchInput = $("#rd-search");
  const refreshBtn = $("#rd-refresh");

  function urlFor(sec, s) {
    const p = new URLSearchParams(sec.query || {});
    // объект в пути (`/objects/{object}/…`) — подставляется в адрес; иначе параметром запроса
    const inPath = sec.endpoint.includes("{object}");
    if (sec.object && !inPath) p.set("object_id", String(objectId));
    if (sec.paging) { p.set("limit", String(sec.paging.limit)); p.set("offset", String(s.offset)); }
    if (sec.serverSearch && s.search.trim()) p.set(sec.serverSearch, s.search.trim());
    const q = p.toString();
    const base = sec.endpoint.replace("{object}", String(objectId));
    return base + (q ? (base.includes("?") ? "&" : "?") + q : "");
  }

  // Действующее значение параметра отчёта: выбор человека, иначе значение секции по умолчанию (`body`).
  const effParam = (sec, s, p) => s.params[p] ?? sec.body?.[p];
  // Условие показа (`showWhen`/`searchWhen`: {параметр: значение}) — reports2: шкала, шаг и группировка «Статуса
  // комплектации» существуют только в виде «сводная таблица», как в V1 (updateCompletionControls).
  const whenMatches = (sec, s, when) => !when || Object.entries(when).every(([p, v]) => String(effParam(sec, s, p)) === String(v));

  function reportBody(sec, s) {
    const body = { object_id: objectId, source_file: null, ...(sec.body || {}), ...s.params };
    // Параметры скрытых настроек в запрос не идут (V1 шлёт шкалу/шаг/группировку только в виде «сводная»): иначе
    // выбор, сделанный в одном виде, молча ехал бы в запрос другого.
    for (const c of sec.controls || []) if (!whenMatches(sec, s, c.showWhen)) delete body[c.param];
    if (sec.derive === "activity-bounds") {
      body.at_from = boundUtc(body.date_from, false); body.at_to = boundUtc(body.date_to, true);
      body.tz_offset_minutes = new Date().getTimezoneOffset();
    }
    // «Учитывать текущий фильтр схемы» (перенос V1) — снимок ПЕРЕЧИТЫВАЕТСЯ здесь, при каждой сборке запроса,
    // а не кэшируется в состоянии секции: устаревший или снятый в рабочем месте отбор не должен молча повиснуть
    // в отчёте. Снимок для ДРУГОГО объекта не подходит (filterSnapshotFor сверяет objectId) — тогда фильтр просто
    // не применяется, как если бы галочка была снята (см. предупреждение рядом с галочкой, paintReport).
    if (sec.schemeFilter && s.filterOn) {
      const snap = filterSnapshotFor(objectId);
      if (snap) body.element_ids = snap.elementIds;
    }
    return body;
  }

  // Выгрузка отчёта в файл: тот же запрос, что у отчёта на экране (файл показывает то, что на экране)
  async function exportReport(sec, s, ext) {
    if (s.exporting) return;
    s.exporting = true; paintExportState(true);
    const status = el.querySelector("#rd-export-status");
    if (status) status.textContent = `Формируется файл ${ext.toUpperCase()}…`;
    try {
      const blob = await api.download(`${sec.endpoint}.${ext}`, reportBody(sec, s));
      if (dead) return;
      // Приписка к имени файла от выбранного значения настройки (`fileSuffix` у варианта; V1 reportFileName: сводная
      // и перечень — разные файлы одного отчёта, одноимённые перезаписывали бы друг друга в папке загрузок).
      const suffix = (sec.controls || []).filter((c) => c.type === "select" && whenMatches(sec, s, c.showWhen))
        .map((c) => (c.options || []).find((o) => String(o[c.valueKey]) === String(effParam(sec, s, c.param)))?.fileSuffix || "").join("");
      const name = `${screen.title}${suffix}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (status) status.textContent = `Файл «${name}» сформирован (${Math.max(1, Math.round(blob.size / 1024))} КБ).`;
    } catch (err) {
      if (status && !dead) status.textContent = `Не удалось выгрузить: ${errorText(err)}`;
    } finally { s.exporting = false; if (!dead) paintExportState(false); }
  }
  function paintExportState(busy) { el.querySelectorAll("[data-export]").forEach((b) => { b.disabled = busy; }); }

  async function load(i) {
    const sec = sections[i];
    const s = st[i];
    if (sec.object && !objectId) { s.status = "no-object"; s.rows = []; paint(); return; }
    const seq = ++s.seq;
    if (!s.acking) s.ackMsg = ""; // прежнее сообщение об отметке не должно соседствовать с новыми данными
    s.status = "loading"; s.error = "";
    paint();
    try {
      const data = sec.kind === "report"
        ? await api.readPost(sec.endpoint, reportBody(sec, s))
        : await api.get(urlFor(sec, s));
      if (dead || seq !== s.seq) return; // запоздавший ответ: вкладку/объект уже сменили
      s.data = data;
      if (sec.kind === "report") {
        s.rs = { search: s.rs.search || "", ...(sec.report === "blockstatus" ? { all: s.rs.all ?? true } : {}) }; s.status = "ok";
        // «Пользователь» (report-mywork): список — GET /objects/{id}/activity-users, отдельно от тела отчёта; грузится
        // один раз на объект, не блокирует показ самого отчёта.
        if ((sec.controls || []).some((c) => c.type === "users") && objectId && s.userObjectId !== objectId) {
          s.userObjectId = objectId;
          api.get(`/objects/${objectId}/activity-users`).then((u) => {
            if (dead || s.userObjectId !== objectId) return;
            s.userOptions = u.users || []; s.canChooseUsers = !!u.can_choose;
            if (i === active) paint();
          }).catch(() => { /* список выбора не критичен — отчёт уже показан для «себя» по умолчанию сервера */ });
        }
        if (i === active) paint();
        return;
      }
      let rows = sec.rowsPath ? pick(data, sec.rowsPath) : data;
      if (sec.asEntries && rows && typeof rows === "object") rows = Object.entries(rows).map(([key, value]) => ({ key, value }));
      s.rows = Array.isArray(rows) ? rows : [];
      s.total = sec.totalPath ? pick(data, sec.totalPath) : null;
      s.status = "ok";
    } catch (err) {
      if (dead || seq !== s.seq) return;
      s.status = "error"; s.error = errorText(err);
    }
    if (i === active) paint();
  }

  // «Ознакомился» (секция с `ack`): личная отметка «прочитано» — версию подставляет сервер, тело запроса пустое. Кнопка
  // видна, пока в списке есть непрочитанные записи; успех — только после повторного чтения списка.
  function ackBarHtml(sec, s) {
    if (!sec.ack) return "";
    const unseen = s.rows.filter((r) => pick(r, sec.ack.flag)).length;
    const msg = s.ackMsg ? `<span class="v2-muted" id="rd-ack-status" role="status" aria-live="polite">${esc(s.ackMsg)}</span>` : `<span id="rd-ack-status" role="status" aria-live="polite"></span>`;
    return `<div class="v2-bar v2-ack-bar">${unseen ? `<button type="button" class="v2-btn v2-primary" id="rd-ack" ${s.acking ? "disabled" : ""}>${esc(sec.ack.label)} (${unseen})</button>` : ""}${msg}</div>`;
  }
  async function ackSection(i) {
    const sec = sections[i], s = st[i];
    if (!sec.ack || s.acking) return;
    s.acking = true; s.ackMsg = "Отмечаем…"; paint();
    const unseenNow = () => s.rows.filter((r) => pick(r, sec.ack.flag)).length;
    let known = true; // исход известен (ответ получен)
    try { await api.post(sec.ack.path); } catch (err) {
      if (err instanceof ApiError && err.status > 0 && err.status < 500) { s.ackMsg = `Не удалось отметить: ${errorText(err)}`; s.acking = false; paint(); return; }
      known = false; // сеть/5xx — исход неизвестен: повторно не отправляем, сначала читаем
    }
    await load(i);
    if (dead) return;
    s.acking = false;
    if (s.status !== "ok") s.ackMsg = "Отметка отправлена, но перечитать список не удалось — нажмите «Обновить».";
    else if (unseenNow() === 0) s.ackMsg = known ? "Отмечено: непрочитанных записей нет (подтверждено чтением)." : "Сервер отметил записи, хотя ответ не дошёл.";
    else s.ackMsg = known ? "Сервер вернул непрочитанные записи — проверьте." : "Отметка не подтверждена — повторите вручную.";
    paint();
  }

  function paint() {
    if (dead) return;
    const sec = sections[active];
    const s = st[active];
    const body = $("#rd-body");
    searchInput.hidden = sec.kind === "record" || (sec.kind === "report" && (!sec.search || !whenMatches(sec, s, sec.searchWhen)));
    $("#rd-count").hidden = sec.kind === "record" || sec.kind === "report" || sec.kind === "guide";
    refreshBtn.disabled = s.status === "loading" || s.acking;
    $("#rd-count").textContent = "";
    if (s.status === "idle" || s.status === "loading") { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (s.status === "no-object") { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — данные этого экрана относятся к объекту.</p>`; return; }
    if (s.status === "error") {
      // У отчёта настройки остаются на экране и при ошибке (reports2): отказ сервера бывает из-за самих настроек
      // («слишком много колонок — укрупните шаг» у сводной), и без них человеку нечем было бы его исправить —
      // «Повторить» повторял бы тот же отказ. В V1 настройки тоже не пропадают (ошибка — в строке состояния).
      const bar = sec.kind === "report" ? controlBarHtml(sec, s) : "";
      body.innerHTML = `${bar}<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(s.error)}${s.ackMsg ? ` ${esc(s.ackMsg)}` : ""}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="rd-retry">Повторить</button></div></div>`;
      $("#rd-retry").addEventListener("click", () => load(active));
      if (bar) bindControlBar(sec, s, body);
      return;
    }
    if (sec.kind === "record") { body.innerHTML = paintRecord(sec, s.data); return; }
    if (sec.kind === "report") { paintReport(sec, s, body); return; }
    if (sec.kind === "guide") { body.innerHTML = paintGuide(s.data, s.search); return; }
    const q = sec.serverSearch ? "" : s.search.trim().toLowerCase();
    const keys = sec.search || sec.columns.map((c) => c.key);
    const rows = q ? s.rows.filter((r) => keys.some((k) => String(pick(r, k) ?? "").toLowerCase().includes(q))) : s.rows;
    const shown = rows.slice(0, RENDER_LIMIT);
    const total = s.total ?? s.rows.length;
    $("#rd-count").textContent = `${sec.serverSearch && s.search.trim() ? `Найдено на сервере: ${total}` : q ? `Найдено ${rows.length} из ${s.rows.length}` : `Записей: ${total}`}${s.total != null && s.rows.length < s.total ? ` (загружено ${s.rows.length})` : ""}`;
    if (!rows.length) {
      body.innerHTML = `${ackBarHtml(sec, s)}<p class="v2-muted">${q || (sec.serverSearch && s.search.trim()) ? `Ничего не найдено по запросу «${esc(s.search)}».` : esc(sec.empty || "Записей нет.")}</p>`;
      $("#rd-ack")?.addEventListener("click", () => ackSection(active));
      return;
    }
    body.innerHTML = `${ackBarHtml(sec, s)}${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${RENDER_LIMIT} из ${rows.length} — уточните поиск.</p>` : ""}
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${sec.columns.map((c) => `<th data-col-type="${colDataType(c)}">${esc(c.title)}</th>`).join("")}${canEditRows(sec) ? "<th></th>" : ""}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${sec.columns.map((c) => `<td data-col-type="${colDataType(c)}">${cellHtml(c, r, s.data)}</td>`).join("")}${canEditRows(sec) ? `<td><button type="button" class="v2-btn" data-row-edit="${esc(r.id)}" aria-label="Открыть карточку работы ${esc(r["код"] ?? r.id)}">Сроки</button></td>` : ""}</tr>`).join("")}</tbody></table></div>
      ${sec.paging ? `<div class="v2-bar"><button type="button" class="v2-btn" id="rd-prev" ${s.offset <= 0 ? "disabled" : ""}>← Назад</button>
        <button type="button" class="v2-btn" id="rd-next" ${s.total != null && s.offset + s.rows.length >= s.total ? "disabled" : ""}>Дальше →</button></div>` : ""}`;
    $("#rd-ack")?.addEventListener("click", () => ackSection(active));
    body.querySelectorAll("[data-row-edit]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await closeEditor())) return;
      const host = $("#rd-editor");
      editor = mountBlockWorkForm(host, { api, objectId, id: b.dataset.rowEdit, canWrite: canEditRows(sec), onSaved: () => load(active), onClose: () => closeEditor() });
      host.scrollIntoView?.({ block: "nearest" });
    }));
    if (sec.paging) {
      $("#rd-prev")?.addEventListener("click", () => { s.offset = Math.max(0, s.offset - sec.paging.limit); load(active); });
      $("#rd-next")?.addEventListener("click", () => { s.offset += sec.paging.limit; load(active); });
    }
  }

  // Панель настроек отчёта (параметры + «Учитывать текущий фильтр схемы») — отдельно от тела отчёта: она же
  // рисуется и в состоянии ошибки (см. paint), чтобы отказ из-за настроек можно было исправить ими же.
  function controlBarHtml(sec, s) {
    const controls = (sec.controls || []).filter((c) => whenMatches(sec, s, c.showWhen)).map((c) => {
      const cur = s.params[c.param] ?? "";
      if (c.type === "users") {
        // «Пользователь» (report-mywork): «Я» (по умолчанию сервера) — «Все» (если есть право «Чужие действия») — поимённо.
        if (!s.canChooseUsers) return "";   // обычному пользователю выбирать не из чего — форма как у V1 в этом случае
        const val = s.userChoice ?? "";
        const names = (s.userOptions || []).map((u) => `<option value="${u.id}" ${String(u.id) === val ? "selected" : ""}>${esc(u.display_name)}</option>`).join("");
        return `<label class="v2-wire-field"><span>${esc(c.label)}</span><select data-user-select="1"><option value="" ${val === "" ? "selected" : ""}>Я</option><option value="__all__" ${val === "__all__" ? "selected" : ""}>Все</option>${names}</select></label>`;
      }
      if (c.type === "select") {
        const opts = c.options || pick(s.data, c.optionsFrom) || [];   // options — фиксированный набор из реестра экранов (шаг, масштаб)
        const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? sec.body?.[c.param] ?? c.default ?? "";
        return `<label class="v2-wire-field"><span>${esc(c.label)}</span><select data-param="${esc(c.param)}">${opts.map((o) => `<option value="${esc(o[c.valueKey])}" ${String(o[c.valueKey]) === String(val) ? "selected" : ""}>${esc(o[c.labelKey])}</option>`).join("")}</select></label>`;
      }
      // Уровни группировки (перенос createGroupChooser V1: фишка = галочка «включён» + стрелки порядка): порядок слева
      // направо = сверху вниз в иерархии строк. Последний включённый уровень снять нельзя — ноль уровней сервер молча
      // заменил бы группировкой по умолчанию, и снятая галочка вернулась бы сама (как в V1).
      if (c.type === "groups") {
        const list = s.groups?.[c.param] || [];
        return `<div class="v2-wire-field v2-group-field"><span>${esc(c.label)}</span><div class="v2-group-chips" data-groups="${esc(c.param)}" role="group" aria-label="${esc(c.label)}">${list.map((g, i) =>
          `<span class="v2-group-chip${g.on ? " on" : ""}"><label><input type="checkbox" data-group-toggle="${esc(g.key)}" ${g.on ? "checked" : ""}> ${esc(g.label)}</label><button type="button" class="v2-group-move" data-group-move="${esc(g.key)}" data-dir="-1" title="Левее (выше в иерархии)" aria-label="${esc(g.label)}: выше в иерархии" ${i === 0 ? "disabled" : ""}>◀</button><button type="button" class="v2-group-move" data-group-move="${esc(g.key)}" data-dir="1" title="Правее (ниже в иерархии)" aria-label="${esc(g.label)}: ниже в иерархии" ${i === list.length - 1 ? "disabled" : ""}>▶</button></span>`).join("")}</div>
          <span class="v2-muted" data-groups-msg="${esc(c.param)}" role="status" aria-live="polite">${esc(s.groupsMsg || "")}</span></div>`;
      }
      // Кнопка сброса набора параметров в null (перенос «весь срок» у «Динамики», V1: dynRange = {from:null,to:null}) —
      // общий механизм, а не завязанный на конкретный отчёт: любой отчёт с периодом может перечислить свои параметры в `resets`.
      if (c.type === "button") {
        return `<button type="button" class="v2-btn" data-reset="${esc((c.resets || []).join(","))}">${esc(c.label)}</button>`;
      }
      const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? "";
      return `<label class="v2-wire-field"><span>${esc(c.label)}</span><input type="date" data-param="${esc(c.param)}" value="${esc(val)}"></label>`;
    }).join("");
    // «Учитывать текущий фильтр схемы» (перенос V1) — снимок отбора, ПОСЛЕДНИЙ раз сделанного в рабочем месте
    // «Модель»/«Прораб» (см. scheme-filter-snapshot.js): не живая синхронизация (рабочее место — отдельный
    // экран, его кадр со схемой закрывается при уходе), поэтому рядом ВСЕГДА написано, чей это отбор, на какой
    // объект и когда — состояние не протекает скрыто, а снимок для чужого объекта не подставляется никогда.
    let filterBar = "";
    if (sec.schemeFilter) {
      const desc = describeFilterSnapshot(objectId);
      // Показанное состояние галочки — s.filterOn (память выбора на ЭТОМ объекте) И доступность снимка разом:
      // отмеченная, но недоступная галочка читалась бы как «фильтр применён», а он не применяется НИКОГДА, если
      // снимок относится к другому объекту (см. reportBody выше) — s.filterOn при этом не сбрасываем, чтобы
      // выбор вернулся сам, если человек снова окажется на своём объекте.
      filterBar = `<div class="v2-wire-row v2-report-controls"><label class="v2-wire-check"><input type="checkbox" id="rd-use-filter" ${s.filterOn && desc.available ? "checked" : ""} ${desc.available ? "" : "disabled"}> Учитывать текущий фильтр схемы</label>
        <span class="v2-muted" id="rd-filter-note">${esc(desc.text)}</span></div>`;
    }
    return `${controls ? `<div class="v2-wire-row v2-report-controls">${controls}</div>` : ""}${filterBar}`;
  }

  function bindControlBar(sec, s, bodyEl) {
    bodyEl.querySelector("#rd-use-filter")?.addEventListener("change", (e) => { s.filterOn = e.target.checked; load(active); });
    bodyEl.querySelector("[data-user-select]")?.addEventListener("change", (e) => {
      const v = e.target.value;
      s.userChoice = v;
      s.params.all_users = v === "__all__";
      s.params.user_ids = v && v !== "__all__" ? [Number(v)] : null;
      load(active);
    });
    bodyEl.querySelectorAll("[data-param]").forEach((inp) => inp.addEventListener("change", () => {
      if (!inp.value) return; // пустая дата — прежнее значение, а не запрос без даты
      s.params[inp.dataset.param] = inp.type === "date" ? inp.value : Number(inp.value) || inp.value;
      if (sec.report === "mywork" && (inp.dataset.param === "date_from" || inp.dataset.param === "date_to")) saveMyworkPeriod(s);
      const c = (sec.controls || []).find((x) => x.param === inp.dataset.param);
      if (c?.remember) lsSet(c.remember, String(s.params[c.param]));
      load(active);
    }));
    bodyEl.querySelectorAll("[data-reset]").forEach((btn) => btn.addEventListener("click", () => {
      for (const p of btn.dataset.reset.split(",").filter(Boolean)) s.params[p] = null;
      load(active);
    }));
    bodyEl.querySelectorAll("[data-groups]").forEach((box) => {
      const param = box.dataset.groups;
      const c = (sec.controls || []).find((x) => x.param === param);
      const list = s.groups[param];
      const commit = () => {
        s.params[param] = list.filter((g) => g.on).map((g) => g.key);
        if (c?.remember) lsSet(c.remember, JSON.stringify(list.map((g) => ({ key: g.key, on: g.on }))));
        s.groupsMsg = "";
        load(active);
      };
      box.querySelectorAll("[data-group-move]").forEach((b) => b.addEventListener("click", () => {
        const i = list.findIndex((g) => g.key === b.dataset.groupMove);
        const j = i + Number(b.dataset.dir);
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        commit();
      }));
      box.querySelectorAll("[data-group-toggle]").forEach((cb) => cb.addEventListener("change", () => {
        const g = list.find((x) => x.key === cb.dataset.groupToggle);
        if (!g) return;
        if (g.on && list.filter((x) => x.on).length === 1) {
          cb.checked = true;
          s.groupsMsg = "Хотя бы один уровень группировки должен остаться";
          const msg = bodyEl.querySelector(`[data-groups-msg="${CSS.escape(param)}"]`);
          if (msg) msg.textContent = s.groupsMsg;
          return;
        }
        g.on = cb.checked;
        commit();
      }));
    });
  }

  function paintReport(sec, s, bodyEl) {
    const render = REPORT_RENDERERS[sec.report];
    // ctx отчёта: правка ячейки, перезапрос с новыми параметрами (setParams), переходы к другим экранам и смена объекта (аудит рабочих мест)
    const ctx = { api, objectId, canWrite: canWriteReport(sec), data: s.data, rights, go, switchObject, hasObject,
      canNotes: !!rights?.system_admin || rights?.features?.report_notes === "write",
      setParams: (p) => { Object.assign(s.params, p); load(active); } };
    // Печать доступна у отчёта по умолчанию (перенос кнопки «Печать» V1) — секция может явно отключить (`printable: false`),
    // если для нужд её вёрстки печать ещё не проверена (mfr2, exchange2, 2026-09-22).
    const printBtn = sec.printable === false ? "" : `<button type="button" class="v2-btn" id="rd-print">Печать</button>`;
    const helpBtn = sec.helpKey ? `<button type="button" class="v2-btn" id="rd-help">Справка</button>` : "";
    const exportsBar = `<div class="v2-bar v2-export-bar">${printBtn}${(sec.exports || []).map((x) => `<button type="button" class="v2-btn" data-export="${x}">Выгрузить в ${x.toUpperCase()}</button>`).join("")}${helpBtn}<span class="v2-muted" id="rd-export-status" role="status" aria-live="polite"></span></div>`;
    bodyEl.innerHTML = `${controlBarHtml(sec, s)}${exportsBar}<div id="rd-report">${render(s.data, s.rs, ctx)}</div>`;
    bindControlBar(sec, s, bodyEl);
    bodyEl.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => exportReport(sec, s, b.dataset.export)));
    bodyEl.querySelector("#rd-print")?.addEventListener("click", () => printReportTable(screen.title));
    bodyEl.querySelector("#rd-help")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const help = await api.get(`/report-help/${encodeURIComponent(sec.helpKey)}`);
        const body = (help.sections || []).map(([heading, paragraphs]) => `${heading}:\n${(paragraphs || []).join("\n")}`).join("\n\n");
        await showInfoDialog(`${help.title || sec.title}\n\n${body || "Справка для этого отчёта не заполнена."}`);
      } catch (err) {
        await showInfoDialog(`Не удалось получить справку: ${errorText(err)}`);
      } finally { btn.disabled = false; }
    });
    // «График поставки»: разбор ячейки по маркам (POST /reports/delivery-schedule/cell) — делегирование на постоянный
    // контейнер (таблица перерисовывается при сворачивании строк), тот же приём, что у наведения в V1. Вешается ОДИН раз
    // на экран (reports2): прежде каждый показ отчёта добавлял ещё пару обработчиков на тот же #rd-body, и после смены шага
    // один щелчок по ячейке слал два запроса разбора и открывал два окна. Состояние (s, параметры) читается в момент щелчка.
    if (sec.report === "delivery" && !deliveryCellsBound) {
      deliveryCellsBound = true;
      bodyEl.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-gkeys]")) { e.preventDefault(); e.target.click(); }
      });
      bodyEl.addEventListener("click", async (e) => {
        const cell = e.target.closest("[data-gkeys]");
        if (!cell) return;
        const gkeys = JSON.parse(cell.dataset.gkeys);
        const column = cell.dataset.col;
        cell.setAttribute("aria-busy", "true");
        try {
          // разбор ячейки требует ТЕ ЖЕ даты/шаг, что уже построили показанный отчёт — сервер их не подставляет сам
          // (в отличие от самого отчёта): берём применённые сервером значения (s.data), если человек их не менял (s.params).
          const cellBody = { ...reportBody(sec, s), date_from: s.params.date_from ?? s.data?.date_from, date_to: s.params.date_to ?? s.data?.date_to, step: s.params.step ?? s.data?.step, path: gkeys, column };
          const detail = await api.readPost(`${sec.endpoint}/cell`, cellBody);
          const rows = (detail.marks || []).map((r) => {
            const src = (r.sources || []).map((so) => `${so.where}: ${so.count}${so.urgent ? " (спешно — свой срок не позже этой даты)" : ""}`).join("; ");
            return `${r.mark}: нужно ${r.need}, план ${r.plan}, факт ${r.fact}${r.deficit ? `, НЕ ПЕРЕКРЫТО ${r.deficit} (всего к дате нужно ${r.total_need})` : ""}${src ? `\n  можно взять: ${src}` : (r.deficit ? "\n  взять негде — нет доставленных, не смонтированных изделий этой марки" : "")}`;
          });
          await showInfoDialog(`Разбор ячейки «${detail.column_label || column}» по маркам\n\n${rows.length ? rows.join("\n\n") : "По этой ячейке нечего показать."}`);
        } catch (err) {
          await showInfoDialog(`Не удалось разобрать ячейку: ${errorText(err)}`);
        } finally { cell.removeAttribute("aria-busy"); }
      });
    }
    const repaint = (focusPath) => {
      ctx.data = s.data;
      bodyEl.querySelector("#rd-report").innerHTML = render(s.data, s.rs, ctx);
      bindReport(sec.report, bodyEl, s.rs, repaint, ctx);
      if (focusPath) bodyEl.querySelector(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    };
    bindReport(sec.report, bodyEl, s.rs, repaint, ctx);
  }

  el.querySelectorAll(".v2-read-tab").forEach((b) => b.addEventListener("click", async () => {
    if (!(await closeEditor())) return;
    active = Number(b.dataset.tab);
    el.querySelectorAll(".v2-read-tab").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    searchInput.value = st[active].search;
    if (st[active].status === "idle" || st[active].status === "error") load(active); else paint();
  }));
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    const i = active;
    st[i].search = searchInput.value;
    if (sections[i].serverSearch) {
      // поиск на сервере: перезагрузка с первой страницы после паузы в наборе (одна загрузка, а не по букве)
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st[i].offset = 0; if (!dead && i === active) load(i); }, 350);
    } else if (sections[i].kind === "report" && st[i].status === "ok") {
      st[i].rs.search = searchInput.value; st[i].rs.page = 0;
      const box = el.querySelector("#rd-report");
      if (box) { box.innerHTML = REPORT_RENDERERS[sections[i].report](st[i].data, st[i].rs); bindReport(sections[i].report, el.querySelector("#rd-body"), st[i].rs, () => paintReport(sections[i], st[i], $("#rd-body"))); }
    } else if (st[i].status === "ok") paint();
  });
  refreshBtn.addEventListener("click", () => load(active));
  load(0);
  return { hasUnsavedChanges: () => !!editor?.dirty(), guardLeave: async () => (editor ? editor.guard() : true), destroy() { dead = true; clearTimeout(searchTimer); editor?.destroy(); } };
}
