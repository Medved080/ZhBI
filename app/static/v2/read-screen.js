// Экран V2 «только чтение»: таблица данных из существующего GET-эндпоинта (справочники, списки, журналы).
// Описание секций — в screens.json (`read.sections`): endpoint, колонки, поиск, постраничность. Никаких
// изменяющих запросов здесь нет: правка остаётся в текущем интерфейсе, ссылка на неё — в плашке экрана.
//
// Состояния: загрузка, ошибка (текст сервера + «Повторить»), пусто, «нужен объект». Ответ, пришедший после
// смены вкладки, объекта или ухода с экрана, отбрасывается (счётчик запросов) и чужую таблицу не перерисовывает.
import { ApiError } from "./api.js";
import { STATUS_LABEL } from "./registry.js";
import { esc, linkList } from "./screen-view.js";
import { REPORT_RENDERERS, bindReport } from "./reports.js";

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
      ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${t.columns.map((c) => `<th>${esc(c.title)}</th>`).join("")}</tr></thead>
         <tbody>${list.slice(0, RENDER_LIMIT).map((r) => `<tr>${t.columns.map((c) => `<td>${cellHtml(c, r, data)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
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

function errorText(err) {
  if (err instanceof ApiError) {
    const d = err.detail;
    return typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg || JSON.stringify(x)).join("; ") : `Ошибка ${err.status}`;
  }
  return String(err?.message || err);
}

export function mountReadScreen(el, { screen, structure, objectId, api, groupTitle }) {
  el.className = "v2-page";
  const sections = screen.read.sections;
  let dead = false;
  let active = 0;
  const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  // Границы дня: журнал хранит время в UTC, а человек выбирает дни по местным часам (та же функция, что в V1).
  const boundUtc = (dateStr, end) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
    if (!m) return dateStr || null;
    const d = end ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
  };
  const st = sections.map(() => ({ status: "idle", rows: [], total: null, error: "", seq: 0, search: "", offset: 0, data: null, params: {}, rs: {} }));

  sections.forEach((sec, i) => (sec.controls || []).forEach((c) => { if (c.default === "today") st[i].params[c.param] = todayIso(); }));

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head">
        <h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span>
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

  function reportBody(sec, s) {
    const body = { object_id: objectId, source_file: null, ...(sec.body || {}), ...s.params };
    if (sec.derive === "activity-bounds") {
      body.at_from = boundUtc(body.date_from, false); body.at_to = boundUtc(body.date_to, true);
      body.tz_offset_minutes = new Date().getTimezoneOffset();
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${screen.title}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (status) status.textContent = `Файл «${screen.title}.${ext}» сформирован (${Math.max(1, Math.round(blob.size / 1024))} КБ).`;
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
    s.status = "loading"; s.error = "";
    paint();
    try {
      const data = sec.kind === "report"
        ? await api.readPost(sec.endpoint, reportBody(sec, s))
        : await api.get(urlFor(sec, s));
      if (dead || seq !== s.seq) return; // запоздавший ответ: вкладку/объект уже сменили
      s.data = data;
      if (sec.kind === "report") { s.rs = { search: s.rs.search || "" }; s.status = "ok"; if (i === active) paint(); return; }
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

  function paint() {
    if (dead) return;
    const sec = sections[active];
    const s = st[active];
    const body = $("#rd-body");
    searchInput.hidden = sec.kind === "record" || (sec.kind === "report" && !sec.search);
    $("#rd-count").hidden = sec.kind === "record" || sec.kind === "report" || sec.kind === "guide";
    refreshBtn.disabled = s.status === "loading";
    $("#rd-count").textContent = "";
    if (s.status === "idle" || s.status === "loading") { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (s.status === "no-object") { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — данные этого экрана относятся к объекту.</p>`; return; }
    if (s.status === "error") {
      body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(s.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="rd-retry">Повторить</button></div></div>`;
      $("#rd-retry").addEventListener("click", () => load(active));
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
      body.innerHTML = `<p class="v2-muted">${q || (sec.serverSearch && s.search.trim()) ? `Ничего не найдено по запросу «${esc(s.search)}».` : esc(sec.empty || "Записей нет.")}</p>`;
      return;
    }
    body.innerHTML = `${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${RENDER_LIMIT} из ${rows.length} — уточните поиск.</p>` : ""}
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${sec.columns.map((c) => `<th>${esc(c.title)}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${sec.columns.map((c) => `<td>${cellHtml(c, r, s.data)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${sec.paging ? `<div class="v2-bar"><button type="button" class="v2-btn" id="rd-prev" ${s.offset <= 0 ? "disabled" : ""}>← Назад</button>
        <button type="button" class="v2-btn" id="rd-next" ${s.total != null && s.offset + s.rows.length >= s.total ? "disabled" : ""}>Дальше →</button></div>` : ""}`;
    if (sec.paging) {
      $("#rd-prev")?.addEventListener("click", () => { s.offset = Math.max(0, s.offset - sec.paging.limit); load(active); });
      $("#rd-next")?.addEventListener("click", () => { s.offset += sec.paging.limit; load(active); });
    }
  }

  function paintReport(sec, s, bodyEl) {
    const controls = (sec.controls || []).map((c) => {
      const cur = s.params[c.param] ?? "";
      if (c.type === "select") {
        const opts = pick(s.data, c.optionsFrom) || [];
        const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? "";
        return `<label class="v2-wire-field"><span>${esc(c.label)}</span><select data-param="${esc(c.param)}">${opts.map((o) => `<option value="${esc(o[c.valueKey])}" ${String(o[c.valueKey]) === String(val) ? "selected" : ""}>${esc(o[c.labelKey])}</option>`).join("")}</select></label>`;
      }
      const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? "";
      return `<label class="v2-wire-field"><span>${esc(c.label)}</span><input type="date" data-param="${esc(c.param)}" value="${esc(val)}"></label>`;
    }).join("");
    const render = REPORT_RENDERERS[sec.report];
    const exportsBar = (sec.exports || []).length ? `<div class="v2-bar v2-export-bar">${sec.exports.map((x) => `<button type="button" class="v2-btn" data-export="${x}">Выгрузить в ${x.toUpperCase()}</button>`).join("")}<span class="v2-muted" id="rd-export-status" role="status" aria-live="polite"></span></div>` : "";
    bodyEl.innerHTML = `${controls ? `<div class="v2-wire-row v2-report-controls">${controls}</div>` : ""}${exportsBar}<div id="rd-report">${render(s.data, s.rs)}</div>`;
    bodyEl.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => exportReport(sec, s, b.dataset.export)));
    const repaint = (focusPath) => {
      bodyEl.querySelector("#rd-report").innerHTML = render(s.data, s.rs);
      bindReport(sec.report, bodyEl, s.rs, repaint);
      if (focusPath) bodyEl.querySelector(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
    };
    bindReport(sec.report, bodyEl, s.rs, repaint);
    bodyEl.querySelectorAll("[data-param]").forEach((inp) => inp.addEventListener("change", () => {
      if (!inp.value) return; // пустая дата — прежнее значение, а не запрос без даты
      s.params[inp.dataset.param] = inp.type === "date" ? inp.value : Number(inp.value) || inp.value;
      load(active);
    }));
  }

  el.querySelectorAll(".v2-read-tab").forEach((b) => b.addEventListener("click", () => {
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
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; clearTimeout(searchTimer); } };
}
