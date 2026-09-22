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
import { mountBlockWorkForm } from "./block-work-form.js";
import { printHtml } from "./print.js";
import { showInfoDialog } from "./dialogs.js";

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

// Печать отчёта (mfr2, перенос из V1: `document.getElementById("report-print").addEventListener("click", () => window.print())`) —
// системное окно печати браузера, содержимое — снимок текущей таблицы отчёта.
function printReportTable(title) {
  const src = document.querySelector("#rd-report");
  if (!src) return;
  printHtml(`<h2>${esc(title)}</h2>${src.innerHTML}`);
}

function errorText(err) {
  if (err instanceof ApiError) {
    const d = err.detail;
    return typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg || JSON.stringify(x)).join("; ") : `Ошибка ${err.status}`;
  }
  return String(err?.message || err);
}

export function mountReadScreen(el, { screen, structure, objectId, api, groupTitle, rights }) {
  el.className = "v2-page";
  const sections = screen.read.sections;
  let dead = false;
  let active = 0;
  let editor = null; // открытая карточка строки (правка запланированной работы)
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
  const st = sections.map(() => ({ status: "idle", rows: [], total: null, error: "", seq: 0, search: "", offset: 0, data: null, params: {}, rs: {}, acking: false, ackMsg: "" }));

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
        s.rs = { search: s.rs.search || "" }; s.status = "ok";
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
    searchInput.hidden = sec.kind === "record" || (sec.kind === "report" && !sec.search);
    $("#rd-count").hidden = sec.kind === "record" || sec.kind === "report" || sec.kind === "guide";
    refreshBtn.disabled = s.status === "loading" || s.acking;
    $("#rd-count").textContent = "";
    if (s.status === "idle" || s.status === "loading") { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (s.status === "no-object") { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — данные этого экрана относятся к объекту.</p>`; return; }
    if (s.status === "error") {
      body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(s.error)}${s.ackMsg ? ` ${esc(s.ackMsg)}` : ""}
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
      body.innerHTML = `${ackBarHtml(sec, s)}<p class="v2-muted">${q || (sec.serverSearch && s.search.trim()) ? `Ничего не найдено по запросу «${esc(s.search)}».` : esc(sec.empty || "Записей нет.")}</p>`;
      $("#rd-ack")?.addEventListener("click", () => ackSection(active));
      return;
    }
    body.innerHTML = `${ackBarHtml(sec, s)}${rows.length > shown.length ? `<p class="v2-muted">Показаны первые ${RENDER_LIMIT} из ${rows.length} — уточните поиск.</p>` : ""}
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr>${sec.columns.map((c) => `<th>${esc(c.title)}</th>`).join("")}${canEditRows(sec) ? "<th></th>" : ""}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${sec.columns.map((c) => `<td>${cellHtml(c, r, s.data)}</td>`).join("")}${canEditRows(sec) ? `<td><button type="button" class="v2-btn" data-row-edit="${esc(r.id)}" aria-label="Открыть карточку работы ${esc(r["код"] ?? r.id)}">Сроки</button></td>` : ""}</tr>`).join("")}</tbody></table></div>
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

  function paintReport(sec, s, bodyEl) {
    const controls = (sec.controls || []).map((c) => {
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
        const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? c.default ?? "";
        return `<label class="v2-wire-field"><span>${esc(c.label)}</span><select data-param="${esc(c.param)}">${opts.map((o) => `<option value="${esc(o[c.valueKey])}" ${String(o[c.valueKey]) === String(val) ? "selected" : ""}>${esc(o[c.labelKey])}</option>`).join("")}</select></label>`;
      }
      const val = cur !== "" ? cur : pick(s.data, c.currentFrom || "") ?? "";
      return `<label class="v2-wire-field"><span>${esc(c.label)}</span><input type="date" data-param="${esc(c.param)}" value="${esc(val)}"></label>`;
    }).join("");
    const render = REPORT_RENDERERS[sec.report];
    const ctx = { api, objectId, canWrite: canWriteReport(sec), data: s.data };
    // Печать доступна у отчёта по умолчанию (перенос кнопки «Печать» V1) — секция может явно отключить (`printable: false`),
    // если для нужд её вёрстки печать ещё не проверена (mfr2, exchange2, 2026-09-22).
    const printBtn = sec.printable === false ? "" : `<button type="button" class="v2-btn" id="rd-print">Печать</button>`;
    const helpBtn = sec.helpKey ? `<button type="button" class="v2-btn" id="rd-help">Справка</button>` : "";
    const exportsBar = `<div class="v2-bar v2-export-bar">${printBtn}${(sec.exports || []).map((x) => `<button type="button" class="v2-btn" data-export="${x}">Выгрузить в ${x.toUpperCase()}</button>`).join("")}${helpBtn}<span class="v2-muted" id="rd-export-status" role="status" aria-live="polite"></span></div>`;
    bodyEl.innerHTML = `${controls ? `<div class="v2-wire-row v2-report-controls">${controls}</div>` : ""}${exportsBar}<div id="rd-report">${render(s.data, s.rs, ctx)}</div>`;
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
    bodyEl.querySelector("[data-user-select]")?.addEventListener("change", (e) => {
      const v = e.target.value;
      s.userChoice = v;
      s.params.all_users = v === "__all__";
      s.params.user_ids = v && v !== "__all__" ? [Number(v)] : null;
      load(active);
    });
    // «График поставки»: разбор ячейки по маркам (POST /reports/delivery-schedule/cell) — делегирование на постоянный
    // контейнер (таблица перерисовывается при сворачивании строк), тот же приём, что у наведения в V1.
    if (sec.report === "delivery") {
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
    bodyEl.querySelectorAll("[data-param]").forEach((inp) => inp.addEventListener("change", () => {
      if (!inp.value) return; // пустая дата — прежнее значение, а не запрос без даты
      s.params[inp.dataset.param] = inp.type === "date" ? inp.value : Number(inp.value) || inp.value;
      load(active);
    }));
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
