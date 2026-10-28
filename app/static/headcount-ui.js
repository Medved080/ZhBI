// Учёт численности персонала по объектам — общий экран для V1 и V2 (2026-10-09, Docs/headcount.md).
//
// ОДИН модуль на оба интерфейса (в отличие от большинства экранов, у которых V1 и V2 — две реализации): логика ввода, подрядчиков,
// отчётов и загрузки у них не различается, а расхождение двух копий — самый частый источник «в V2 не так, как в V1». Различается только
// обвязка: окно (V1 — модалка, V2 — страница) и транспорт. Транспорт и подтверждение передаются ЯВНО (обычный скрипт V1 не делится
// глобалями с модулем): ctx = { api, objectId, objectName, canWrite, canAdmin, confirm, upload }.
//   api.get/put/post/patch/delete(path, body) — как у V2; в V1 это тонкая обёртка над `api()` app.js;
//   upload(path, FormData) — multipart POST (загрузка файлов);
//   download(urlWithQuery, имяФайла) — скачать файл GET-запросом (необязателен: без него кнопка «Выгрузить в Excel» не показывается);
//   confirm(text, { danger }) → Promise<boolean>.
// Сервер (app/headcount.py, app/headcount_import.py) считает ВСЁ: срок и просрочку, ключи, историю, отчёт. Клиент только показывает.

const CSS_URL = "/static/headcount.css";
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => (e && typeof e.detail === "string" && e.detail) || (e && e.message) || String(e);
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoOf(new Date());
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return isoOf(d); };
const fmtDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const weekday = (iso) => WEEKDAYS[new Date(`${iso}T12:00:00`).getDay()];
const fmtMoment = (s) => {
  if (!s) return "";
  const d = new Date(String(s).replace(" ", "T") + (String(s).includes("T") && /[zZ+]/.test(String(s)) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
// «Рабочие», «ИТР» и «Механизаторы» — целые от 0 до 100 000, вместе не меньше 1 («Итого» = их сумма, на сервере не хранится)
const NOTE_MAX = 20;   // длина примечания к виду работ подрядчика (как app/headcount.py: NOTE_MAX)
const HC_MAX = 100000;
const isCount = (v) => /^\d+$/.test(String(v).trim()) && Number(v) <= HC_MAX;
const pairProblem = (w, i, m) => (!isCount(w) || !isCount(i) || !isCount(m) ? `Рабочие, ИТР и механизаторы — целые числа от 0 до ${HC_MAX.toLocaleString("ru-RU")}`
  : Number(w) + Number(i) + Number(m) < 1 ? "Рабочие, ИТР и механизаторы вместе — не меньше 1" : "");
const fmtNum = (n) => (n == null ? "" : Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 }));
const fmtOverdue = (min) => (min >= 1440 ? `${Math.floor(min / 1440)} дн.` : min >= 60 ? `${Math.floor(min / 60)} ч` : `${min} мин`);
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function ensureCss() {
  if (document.querySelector("link[data-hc-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = CSS_URL; l.setAttribute("data-hc-css", "1");
  document.head.appendChild(l);
}

// Готовые срезы отчёта: порядок уровней вложенности (сервер: smu, object, section, work, contractor).
const PRESETS = [
  { key: "objects", title: "По объектам", levels: ["object", "section", "work"] },
  { key: "contractors", title: "По подрядчикам", levels: ["contractor", "object", "work"] },
  { key: "works", title: "По работам", levels: ["section", "work", "contractor"] },
];
const LEVEL_TITLES = { smu: "Подразделение", object: "Объект", section: "Раздел", work: "Вид работ", contractor: "Подрядчик" };

export function mountHeadcount(el, ctx) {
  ensureCss();
  const { api } = ctx;
  let dead = false;
  const st = {
    tab: ctx.startTab || "input", works: null, contractors: null, loadError: "", cod: null, codErr: "", codQ: "", codSec: "",
    date: todayIso(), day: null, dayError: "", added: [], changed: new Map(), saving: false, msg: "", msgKind: "", history: null,
    ctrAdd: null, facets: null, openWorks: new Set(), individuals: null, defaultResp: {},
    rep: { preset: "objects", obj: null, staff: "total", bySmu: false, asOf: "", asOfUser: false, from: "", to: "", data: null, loading: false, error: "", toggled: new Set() },
    data: { mode: "records", obj: null, from: "", to: "", contractor: "", workId: null, source: "", late: false, offset: 0, limit: 100, res: null, loading: false, error: "" },
    adm: { codResult: "", analysis: null, mapping: {}, result: "", busy: false, error: "" },
  };
  const tabs = [["input", "Ввод численности"], ["contractors", "Подрядчики"], ["report", "Отчёт"], ["data", "Все данные"], ["codifier", "Виды работ"]];
  if (ctx.canAdmin) tabs.push(["admin", "Загрузка данных"]);
  // Бот eXpress (2026-10-23, Docs/express-bot.md): права — разделы `express_bot` (расписания, контакты) и `express_admin` (подключение, журнал)
  if (ctx.express && ctx.express.read) tabs.push(["express", "Бот eXpress"]);

  el.classList.add("hc-root");
  el.innerHTML = `<div class="hc-tabs" role="tablist" aria-label="Разделы учёта численности">${tabs.map(([k, t]) =>
    `<button type="button" role="tab" class="hc-tab" data-tab="${k}">${esc(t)}</button>`).join("")}</div><div class="hc-pane" id="hc-pane"></div>`;
  const pane = el.querySelector("#hc-pane");
  el.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    if (st.tab === "express" && b.dataset.tab !== "express" && st.expressView) { st.expressView.destroy(); st.expressView = null; }
    st.tab = b.dataset.tab; paint();
  }));

  const setMsg = (t, kind = "") => { st.msg = t; st.msgKind = kind; const n = pane.querySelector("#hc-msg"); if (n) { n.textContent = t; n.className = `hc-msg ${kind}`; } };
  const hasChanges = () => st.added.length > 0 || st.changed.size > 0;

  // ---- справочники: подрядчики объекта и кодификатор ----
  async function loadRefs() {
    try {
      const [c, w] = await Promise.all([api.get(`/objects/${ctx.objectId}/headcount/contractors`), api.get(`/objects/${ctx.objectId}/headcount/codifier`)]);
      if (dead) return;
      st.contractors = c.contractors || []; st.works = w.works || []; st.loadError = "";
    } catch (e) { if (dead) return; st.loadError = errText(e); }
    paint();
  }

  // объекты, по которым в системе есть численность (собираются сервером из фактических записей)
  async function loadFacets() {
    if (st.facets) return st.facets;
    try { st.facets = (await api.get("/headcount/facets")).objects || []; } catch (e) { st.facets = []; }
    // выбор по умолчанию: текущий объект, если по нему есть данные, иначе все объекты с данными
    const mine = st.facets.some((o) => o.id === ctx.objectId) ? String(ctx.objectId) : "all";
    if (st.rep.obj === null) st.rep.obj = mine;
    if (st.data.obj === null) st.data.obj = mine;
    return st.facets;
  }
  const objectOptions = (selected) => `<option value="all" ${selected === "all" ? "selected" : ""}>Все объекты с данными (${(st.facets || []).length})</option>${(st.facets || []).map((o) =>
    `<option value="${o.id}" ${String(o.id) === String(selected) ? "selected" : ""}>${esc(o.name)} — ${o.records.toLocaleString("ru-RU")}</option>`).join("")}`;

  function paint() {
    if (dead) return;
    el.querySelectorAll("[data-tab]").forEach((b) => { const on = b.dataset.tab === st.tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    if (st.loadError) { pane.innerHTML = `<div class="hc-callout bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(st.loadError)} <button type="button" class="hc-btn" id="hc-retry">Повторить</button></div>`; pane.querySelector("#hc-retry").addEventListener("click", () => { st.loadError = ""; loadRefs(); }); return; }
    if (st.tab !== "admin" && st.tab !== "express" && (st.contractors === null || st.works === null)) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    if ((st.tab === "report" || st.tab === "data") && !st.facets) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; loadFacets().then(() => !dead && paint()); return; }
    ({ input: paintInput, contractors: paintContractors, report: paintReport, data: paintData, codifier: paintCodifier, admin: paintAdmin, express: paintExpress })[st.tab]();
  }

  // =====================================================================  БОТ eXPRESS
  // Вкладка — отдельный ES-модуль (express-ui.js), грузится при первом открытии. Пока вкладка открыта, paint() может вызываться
  // повторно (догрузились справочники) — готовый экран не пересобираем, иначе он сбросит несохранённую форму.
  function paintExpress() {
    if (st.expressView && pane.querySelector("#hc-express")) return;
    pane.innerHTML = `<div id="hc-express"><p class="hc-muted" role="status">Загрузка…</p></div>`;
    import("/static/express-ui.js").then((m) => {
      if (dead || st.tab !== "express") return;
      const host = pane.querySelector("#hc-express");
      if (!host) return;
      st.expressView?.destroy();
      st.expressView = m.mountExpress(host, { api, objectId: ctx.objectId, canWrite: !!ctx.express?.write, canAdmin: !!ctx.express?.admin, confirm: ctx.confirm,
        sub: st.expressSub, onSub: (k) => { st.expressSub = k; } });
    }).catch((e) => { pane.innerHTML = `<div class="hc-callout bad" role="alert">Не удалось открыть экран бота: ${esc(errText(e))}</div>`; });
  }

  // =====================================================================  ВВОД
  async function loadDay() {
    st.dayError = "";
    try { st.day = await api.get(`/objects/${ctx.objectId}/headcount/day?date=${st.date}`); }
    catch (e) { st.day = null; st.dayError = errText(e); }
    if (!dead && st.tab === "input") paint();
  }

  function paintInput() {
    if (!st.day && !st.dayError) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; loadDay(); return; }
    const d = st.day;
    const due = d ? new Date(d.deadline) : null;
    const dueText = due ? `${fmtDate(isoOf(due))} ${pad(due.getHours())}:${pad(due.getMinutes())}` : "";
    const future = st.date > todayIso();
    pane.innerHTML = `
      <div class="hc-bar">
        <button type="button" class="hc-btn" id="hc-prev" aria-label="Предыдущий день">◀</button>
        <input type="date" id="hc-date" value="${esc(st.date)}" max="${esc(todayIso())}" aria-label="День">
        <button type="button" class="hc-btn" id="hc-next" aria-label="Следующий день" ${st.date >= todayIso() ? "disabled" : ""}>▶</button>
        <span class="hc-muted">${esc(weekday(st.date))}</span>
        ${d ? `<span class="hc-deadline ${d.overdue_now ? "over" : ""}">Срок внесения: до ${esc(dueText)} (МСК)${d.overdue_now ? " — прошёл, запись будет отмечена как просроченная" : ""}</span>` : ""}
      </div>
      ${st.dayError ? `<div class="hc-callout bad" role="alert">${esc(st.dayError)}</div>` : ""}
      <p id="hc-msg" class="hc-msg ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>
      ${d && !d.rows.length && d.last_date && d.last_date !== st.date ? `<div class="hc-callout">За этот день данных нет. Последний день с данными по объекту — <button type="button" class="hc-link" id="hc-lastday">${esc(fmtDate(d.last_date))}</button>.</div>` : ""}
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Подрядчик</th><th>Вид работ</th><th class="num">Рабочие</th><th class="num">ИТР</th><th class="num">Механизаторы</th><th class="num">Итого</th><th>Внесено</th><th></th></tr></thead><tbody id="hc-rows"></tbody>
        <tfoot><tr><td colspan="2">Всего за день</td><td class="num" id="hc-total-w"></td><td class="num" id="hc-total-i"></td><td class="num" id="hc-total-m"></td><td class="num" id="hc-total"></td><td colspan="2"></td></tr></tfoot></table></div>
      ${ctx.canWrite && !future ? `<div class="hc-add" id="hc-add"></div>
        <div class="hc-bar"><button type="button" class="hc-btn primary" id="hc-save">Сохранить</button><button type="button" class="hc-btn" id="hc-copy" title="Добавить в карточку строки выбранного дня, которых за этот день ещё нет">Заполнить как на</button><input type="date" id="hc-copy-date" value="${esc(st.copyFrom || addDays(st.date, -1))}" max="${esc(todayIso())}" aria-label="День, по которому заполнить"><span class="hc-muted" id="hc-dirty"></span></div>` : (ctx.canWrite ? "" : `<p class="hc-muted">Только просмотр: у вас нет права вносить численность на этом объекте.</p>`)}
      <div id="hc-history"></div>`;
    pane.querySelector("#hc-prev").addEventListener("click", () => gotoDay(addDays(st.date, -1)));
    pane.querySelector("#hc-next").addEventListener("click", () => gotoDay(addDays(st.date, 1)));
    pane.querySelector("#hc-date").addEventListener("change", (e) => e.target.value && gotoDay(e.target.value));
    pane.querySelector("#hc-lastday")?.addEventListener("click", () => gotoDay(d.last_date));
    paintRows();
    if (ctx.canWrite && !future) {
      paintAdd();
      pane.querySelector("#hc-save").addEventListener("click", save);
      pane.querySelector("#hc-copy-date").addEventListener("change", (e) => { st.copyFrom = e.target.value; });
      pane.querySelector("#hc-copy").addEventListener("click", copyFromDay);
      paintDirty();
    }
    paintHistory();
  }

  async function gotoDay(iso) {
    if (hasChanges() && !(await ctx.confirm("Есть несохранённые строки. Перейти на другой день без сохранения?", { danger: true }))) { paintInput(); return; }
    st.date = iso; st.copyFrom = null; st.day = null; st.added = []; st.changed = new Map(); st.history = null; setMsg("");
    paint();
  }

  const contractorLabel = (id) => st.contractors.find((c) => c.id === id)?.display || "—";
  const workLabel = (id) => { const w = st.works.find((x) => x.id === id); return w ? `${w.code} ${w.name}` : "—"; };

  // Значения строки на экране: введённое человеком (до сохранения) или то, что в БД
  const rowVals = (r) => { const c = st.changed.get(r.id); return c ? { w: c.workers, i: c.itr, m: c.mech } : { w: String(r.workers), i: String(r.itr ?? 0), m: String(r.mech ?? 0) }; };
  const FIELD_TITLES = { workers: "Рабочие", itr: "ИТР", mech: "Механизаторы" };
  const numOf = (v) => (isCount(v) ? Number(v) : 0);
  const effIds = (r) => { const c = st.changed.get(r.id) || {}; return { ctr: c.contractor_id ?? r.contractor_id, work: c.codifier_id ?? r.codifier_id }; };
  // Занята ли пара «подрядчик + вид работ» другой строкой карточки (внесённой — с учётом её ещё не сохранённой правки, или добавленной)
  const pairTaken = (ctr, work, skip) => (st.day?.rows || []).some((r) => !(skip.kind === "saved" && skip.ref === r.id) && effIds(r).ctr === ctr && effIds(r).work === work)
    || st.added.some((a, i) => !(skip.kind === "added" && skip.ref === i) && a.contractor_id === ctr && a.codifier_id === work);

  function paintRows() {
    const rows = st.day?.rows || [];
    const body = pane.querySelector("#hc-rows");
    const flags = (r) => [
      r.late ? `<span class="hc-badge bad" title="Первое внесение позже срока">просрочено${r.overdue_minutes ? " на " + fmtOverdue(r.overdue_minutes) : ""}</span>` : "",
      r.inn_status === "unverified" ? `<span class="hc-badge warn">ИНН не проверен</span>` : "",
      r.source === "import" ? `<span class="hc-badge">из SharePoint</span>` : "",
    ].join(" ");
    const field = (r, f, v) => ctx.canWrite
      ? `<input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-edit="${r.id}" data-f="${f}" value="${esc(v)}" aria-label="${FIELD_TITLES[f]}: ${esc(r.contractor)}, ${esc(r.work_name)}">`
      : esc(v);
    // Подрядчик и вид работ в строке — кнопки-ячейки: щелчок открывает форму выбора (справочник), выбранное подставляется в эту же строку.
    const cellPick = (kind, ref, type, inner) => ctx.canWrite
      ? `<button type="button" class="hc-cell-pick" data-pick="${type}" data-kind="${kind}" data-ref="${ref}" title="Изменить: выбрать из справочника">${inner}<span class="hc-cell-ed" aria-hidden="true">✎</span></button>` : inner;
    const workHtml = (id) => { const w = st.works.find((x) => x.id === id); return w ? `<span class="hc-code">${esc(w.code)}</span> ${esc(w.name)}` : "—"; };
    body.innerHTML = rows.length || st.added.length ? [
      ...rows.map((r) => { const v = rowVals(r), e = effIds(r); return `<tr data-id="${r.id}" class="${st.changed.has(r.id) ? "dirty" : ""}"><td>${cellPick("saved", r.id, "ctr", esc(contractorLabel(e.ctr)))}</td><td>${cellPick("saved", r.id, "work", workHtml(e.work))}</td>
        <td class="num">${field(r, "workers", v.w)}</td><td class="num">${field(r, "itr", v.i)}</td><td class="num">${field(r, "mech", v.m)}</td><td class="num"><strong data-rowtotal="${r.id}">${numOf(v.w) + numOf(v.i) + numOf(v.m)}</strong></td>
        <td class="hc-small">${esc(fmtMoment(r.entered_at))}${r.entered_by ? " · " + esc(r.entered_by) : ""} ${flags(r)}${r.changes ? ` <button type="button" class="hc-link" data-hist="${r.id}">правок: ${r.changes}</button>` : ` <button type="button" class="hc-link" data-hist="${r.id}">история</button>`}</td>
        <td class="nw">${ctx.canWrite ? `<button type="button" class="hc-btn danger mini" data-del="${r.id}" title="Удалить строку" aria-label="Удалить строку">✕</button>` : ""}</td></tr>`; }),
      ...st.added.map((a, i) => `<tr class="added"><td>${cellPick("added", i, "ctr", esc(contractorLabel(a.contractor_id)))}</td><td>${cellPick("added", i, "work", workHtml(a.codifier_id))}</td><td class="num"><input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-add-edit="${i}" data-f="workers" value="${esc(a.workers)}" aria-label="Рабочие (строка ещё не сохранена)"></td><td class="num"><input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-add-edit="${i}" data-f="itr" value="${esc(a.itr)}" aria-label="ИТР (строка ещё не сохранена)"></td><td class="num"><input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-add-edit="${i}" data-f="mech" value="${esc(a.mech ?? 0)}" aria-label="Механизаторы (строка ещё не сохранена)"></td><td class="num"><strong data-add-total="${i}">${a.workers + a.itr + (a.mech ?? 0)}</strong></td><td class="hc-small"><span class="hc-badge">не сохранено</span></td>
        <td class="nw"><button type="button" class="hc-btn mini" data-unadd="${i}" title="Убрать строку из карточки" aria-label="Убрать строку из карточки">✕</button></td></tr>`),
    ].join("") : `<tr><td colspan="8" class="hc-muted">За этот день численность не внесена.</td></tr>`;
    paintTotals();
    body.querySelectorAll("[data-edit]").forEach((i) => i.addEventListener("input", () => {
      const id = Number(i.dataset.edit), row = rows.find((r) => r.id === id), tr = i.closest("tr");
      const w = tr.querySelector('[data-f="workers"]').value, it = tr.querySelector('[data-f="itr"]').value, mc = tr.querySelector('[data-f="mech"]').value;
      const prev = st.changed.get(id) || {}, moved = prev.contractor_id != null || prev.codifier_id != null;
      if (w === String(row.workers) && it === String(row.itr ?? 0) && mc === String(row.mech ?? 0) && !moved) st.changed.delete(id); else st.changed.set(id, { ...prev, workers: w, itr: it, mech: mc });
      tr.classList.toggle("dirty", st.changed.has(id));
      tr.querySelector("[data-rowtotal]").textContent = numOf(w) + numOf(it) + numOf(mc);
      paintTotals(); paintDirty();
    }));
    body.querySelectorAll("[data-add-edit]").forEach((i) => i.addEventListener("input", () => {   // числа добавленной (ещё не сохранённой) строки правятся прямо в таблице
      const idx = Number(i.dataset.addEdit), tr = i.closest("tr"), a = st.added[idx];
      const w = tr.querySelector('[data-f="workers"]').value, it = tr.querySelector('[data-f="itr"]').value, mc = tr.querySelector('[data-f="mech"]').value;
      if (isCount(w) && isCount(it) && isCount(mc)) { a.workers = Number(w); a.itr = Number(it); a.mech = Number(mc); }
      tr.querySelector("[data-add-total]").textContent = numOf(w) + numOf(it) + numOf(mc);
      i.classList.toggle("bad", !isCount(w) || !isCount(it) || !isCount(mc));
      paintTotals(); paintDirty();
    }));
    body.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => pickForRow(b.dataset.kind, Number(b.dataset.ref), b.dataset.pick)));
    body.querySelectorAll("[data-unadd]").forEach((b) => b.addEventListener("click", () => { st.added.splice(Number(b.dataset.unadd), 1); paintRows(); paintDirty(); }));
    body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeRow(Number(b.dataset.del))));
    body.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => showHistory(rows.find((r) => r.id === Number(b.dataset.hist)))));
  }

  // Смена подрядчика / вида работ в строке: форма выбора, результат подставляется в эту же строку. Внесённая строка при сохранении переезжает на новый
  // ключ (в истории — удаление на старом и создание на новом, «внесено когда/кем» и просрочка сохраняются). Занятая другой строкой пара — отказ.
  function pickForRow(kind, ref, type) {
    const saved = kind === "saved", row = saved ? st.day.rows.find((r) => r.id === ref) : st.added[ref];
    if (!row) return;
    const cur = saved ? effIds(row) : { ctr: row.contractor_id, work: row.codifier_id };
    openPickDialog({
      ...(type === "ctr" ? CTR_CFG : WORK_CFG), items: type === "ctr" ? st.contractors : st.works, selectedId: type === "ctr" ? cur.ctr : cur.work,
      onPick: (item) => {
        const ctr = type === "ctr" ? item.id : cur.ctr, work = type === "work" ? item.id : cur.work;
        if (pairTaken(ctr, work, { kind, ref })) { setMsg("За этот день такая строка (подрядчик + вид работ) уже есть — выберите другую пару или правьте числа в имеющейся.", "bad"); return; }
        if (saved) {
          const prev = st.changed.get(row.id) || { workers: String(row.workers), itr: String(row.itr ?? 0), mech: String(row.mech ?? 0) }, next = { ...prev };
          if (ctr === row.contractor_id) delete next.contractor_id; else next.contractor_id = ctr;
          if (work === row.codifier_id) delete next.codifier_id; else next.codifier_id = work;
          if (next.contractor_id == null && next.codifier_id == null && next.workers === String(row.workers) && next.itr === String(row.itr ?? 0) && next.mech === String(row.mech ?? 0)) st.changed.delete(row.id);
          else st.changed.set(row.id, next);
        } else { row.contractor_id = ctr; row.codifier_id = work; }
        setMsg("");
        paintRows(); paintDirty();
      },
    });
  }

  // Итоги дня под таблицей — с учётом ещё не сохранённых правок и добавленных строк
  function paintTotals() {
    const rows = st.day?.rows || [];
    const tw = rows.reduce((n, r) => n + numOf(rowVals(r).w), 0) + st.added.reduce((n, a) => n + a.workers, 0);
    const ti = rows.reduce((n, r) => n + numOf(rowVals(r).i), 0) + st.added.reduce((n, a) => n + a.itr, 0);
    const set = (id, v) => { const n = pane.querySelector(id); if (n) n.textContent = v || ""; };
    const tm = rows.reduce((n, r) => n + numOf(rowVals(r).m), 0) + st.added.reduce((n, a) => n + (a.mech ?? 0), 0);
    set("#hc-total-w", tw); set("#hc-total-i", ti); set("#hc-total-m", tm); set("#hc-total", tw + ti + tm);
  }

  function paintDirty() {
    const n = pane.querySelector("#hc-dirty"); if (!n) return;
    const problem = [...st.changed.values()].map((c) => pairProblem(c.workers, c.itr, c.mech)).find(Boolean) || "";
    n.textContent = problem || (hasChanges() ? `К сохранению: изменено ${st.changed.size}, добавлено ${st.added.length}` : "");
    n.className = `hc-muted ${problem ? "bad" : ""}`;
    const b = pane.querySelector("#hc-save"); if (b) b.disabled = st.saving || !!problem || !hasChanges();
  }

  // ---- строка добавления: подрядчик + вид работ + число ----
  function paintAdd() {
    const box = pane.querySelector("#hc-add");
    if (!st.contractors.length) { box.innerHTML = `<p class="hc-muted">Сначала добавьте подрядчиков объекта на вкладке «Подрядчики».</p>`; return; }
    box.innerHTML = `<div class="hc-addrow"><label class="hc-ctr-f">Подрядчик<div class="hc-picker" id="hc-a-ctr"></div></label>
      <label class="hc-grow">Вид работ<div class="hc-picker" id="hc-a-work"></div></label>
      <label>Рабочие<input type="number" min="0" max="${HC_MAX}" step="1" id="hc-a-w" class="hc-num"></label>
      <label>ИТР<input type="number" min="0" max="${HC_MAX}" step="1" id="hc-a-i" class="hc-num"></label>
      <label>Механизаторы<input type="number" min="0" max="${HC_MAX}" step="1" id="hc-a-m" class="hc-num"></label>
      <label>Итого<input type="text" id="hc-a-sum" class="hc-num hc-total-in" value="0" readonly tabindex="-1" aria-label="Итого: рабочие плюс ИТР плюс механизаторы"></label>
      <button type="button" class="hc-btn" id="hc-a-go">Добавить в карточку</button></div><p class="hc-msg bad" id="hc-a-err" role="alert"></p>`;
    const picker = workPickerL1(box.querySelector("#hc-a-work"), st.works);
    const ctrPicker = contractorPicker(box.querySelector("#hc-a-ctr"), st.contractors);
    // подрядчик, с которым вносили последнюю строку, остаётся выбранным (за день вносят по несколько видов работ одного подрядчика)
    if (st.lastCtr && st.contractors.some((c) => c.id === st.lastCtr)) ctrPicker.set(st.lastCtr); else if (st.contractors.length === 1) ctrPicker.set(st.contractors[0].id);
    const err = box.querySelector("#hc-a-err");
    const wIn = box.querySelector("#hc-a-w"), iIn = box.querySelector("#hc-a-i"), mIn = box.querySelector("#hc-a-m"), sum = box.querySelector("#hc-a-sum");
    const val = (el) => (el.value.trim() === "" ? "0" : el.value);   // пустое поле — 0: вносят чаще что-то одно
    const upd = () => { sum.value = numOf(val(wIn)) + numOf(val(iIn)) + numOf(val(mIn)); };
    wIn.addEventListener("input", upd); iIn.addEventListener("input", upd); mIn.addEventListener("input", upd);
    const add = () => {
      const contractor_id = ctrPicker.value(), codifier_id = picker.value();
      err.textContent = "";
      if (!contractor_id) { err.textContent = "Выберите подрядчика"; return; }
      if (!codifier_id) { err.textContent = "Выберите вид работ"; return; }
      const problem = pairProblem(val(wIn), val(iIn), val(mIn));
      if (problem) { err.textContent = problem; return; }
      if (pairTaken(contractor_id, codifier_id, { kind: "none", ref: -1 })) {
        err.textContent = "Карточка содержит дубликат численности, сохранение невозможно: по этому подрядчику и виду работ за день строка уже есть — измените её в таблице.";
        return;
      }
      st.lastCtr = contractor_id;
      st.added.push({ contractor_id, codifier_id, workers: Number(val(wIn)), itr: Number(val(iIn)), mech: Number(val(mIn)) });
      wIn.value = ""; iIn.value = ""; mIn.value = ""; upd(); picker.clear(); paintRows(); paintDirty();
    };
    box.querySelector("#hc-a-go").addEventListener("click", add);
    for (const el of [wIn, iIn, mIn]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  }

  async function save() {
    if (st.saving || !hasChanges()) return;
    const rows = [
      ...(st.day?.rows || []).filter((r) => st.changed.has(r.id)).map((r) => {
        const c = st.changed.get(r.id), e = effIds(r), row = { contractor_id: e.ctr, codifier_id: e.work, workers: Number(c.workers), itr: Number(c.itr), mech: Number(c.mech ?? 0) };
        if (e.ctr !== r.contractor_id || e.work !== r.codifier_id) row.move_from = r.id;   // сменили ключ записи: она переезжает
        return row;
      }),
      ...st.added,
    ];
    st.saving = true; paintDirty(); setMsg("Сохранение…");
    try {
      const res = await api.put(`/objects/${ctx.objectId}/headcount/records`, { date: st.date, rows });
      st.day = res; st.added = []; st.changed = new Map(); st.history = null; st.facets = null;
      st.msg = `Сохранено: добавлено ${res.created}, изменено ${res.changed}${res.moved ? `, перенесено на другого подрядчика / вид работ ${res.moved}` : ""}${res.late ? ". Внесено позже срока — записи отмечены как просроченные." : "."}`; st.msgKind = res.late ? "warn" : "ok";
    } catch (e) { st.msg = errText(e); st.msgKind = "bad"; }   // введённое остаётся на месте
    st.saving = false;
    if (!dead && st.tab === "input") paintInput();
  }

  async function removeRow(id) {
    const r = st.day.rows.find((x) => x.id === id);
    if (!(await ctx.confirm(`Удалить строку?\n\n${r.contractor}\n${r.work_code} ${r.work_name}\nРабочие: ${r.workers}, ИТР: ${r.itr ?? 0}, механизаторы: ${r.mech ?? 0}, итого: ${r.total ?? r.workers}\n\nЗначение останется в истории изменений.`, { danger: true }))) return;
    try { await api.delete(`/objects/${ctx.objectId}/headcount/records/${id}`); st.changed.delete(id); await loadDay(); setMsg("Строка удалена.", "ok"); }
    catch (e) { setMsg(errText(e), "bad"); }
  }

  // Заполнить как на выбранный день (по умолчанию — вчера, то есть день перед открытым): добавляет строки, которых за этот день ещё нет
  async function copyFromDay() {
    const from = pane.querySelector("#hc-copy-date")?.value || addDays(st.date, -1);
    if (from === st.date) { setMsg("Выберите другой день: этот день заполняется самим собой.", "bad"); return; }
    try {
      const prev = await api.get(`/objects/${ctx.objectId}/headcount/day?date=${from}`);
      const have = new Set([...(st.day?.rows || []).map((r) => `${r.contractor_id}:${r.codifier_id}`), ...st.added.map((a) => `${a.contractor_id}:${a.codifier_id}`)]);
      const fresh = (prev.rows || []).filter((r) => !have.has(`${r.contractor_id}:${r.codifier_id}`));
      fresh.forEach((r) => st.added.push({ contractor_id: r.contractor_id, codifier_id: r.codifier_id, workers: r.workers, itr: r.itr ?? 0, mech: r.mech ?? 0 }));
      paintRows(); paintDirty();
      const when = from.split("-").reverse().join(".");
      setMsg(fresh.length ? `Добавлено строк из ${when}: ${fresh.length}. Проверьте числа и сохраните.` : `За ${when} нечего добавить: данных нет или все строки уже есть.`, fresh.length ? "ok" : "");
    } catch (e) { setMsg(errText(e), "bad"); }
  }

  async function showHistory(row) {
    const box = pane.querySelector("#hc-history");
    box.innerHTML = `<p class="hc-muted">Загрузка истории…</p>`;
    try {
      const d = await api.get(`/objects/${ctx.objectId}/headcount/history?date_from=${row.date}&date_to=${row.date}&contractor_id=${row.contractor_id}&codifier_id=${row.codifier_id}`);
      box.innerHTML = `<h4>История: ${esc(row.contractor)} · ${esc(row.work_code)} · ${esc(fmtDate(row.date))}</h4><table class="hc-tbl"><thead><tr><th>Когда</th><th>Кто</th><th class="num">Рабочие было</th><th class="num">Рабочие стало</th><th class="num">ИТР было</th><th class="num">ИТР стало</th><th class="num">Механизаторы было</th><th class="num">Механизаторы стало</th><th>Источник</th></tr></thead><tbody>${
        d.history.map((h) => `<tr><td>${esc(fmtMoment(h.changed_at))}</td><td>${esc(h.changed_by || "—")}</td><td class="num">${h.old ?? "—"}</td><td class="num">${h.new ?? "удалено"}</td><td class="num">${h.old_itr ?? "—"}</td><td class="num">${h.new_itr ?? (h.new == null ? "удалено" : "—")}</td><td class="num">${h.old_mech ?? "—"}</td><td class="num">${h.new_mech ?? (h.new == null ? "удалено" : "—")}</td><td>${h.source === "import" ? "загрузка из SharePoint" : h.source === "bot" ? "бот" : "форма"}</td></tr>`).join("")}</tbody></table>`;
      box.scrollIntoView({ block: "nearest" });
    } catch (e) { box.innerHTML = `<div class="hc-callout bad" role="alert">${esc(errText(e))}</div>`; }
  }
  const paintHistory = () => {};

  // =====================================================================  ПОДРЯДЧИКИ
  // Подрядчик объекта — ссылка на контрагента ЕДИНОГО справочника (2026-10-26): его добавляют поиском по общему справочнику (ИНН или
  // название), нового контрагента заводят отсюда же (право на «Справочник контрагентов» проверяет сервер). Название и ИНН подрядчика
  // берутся из справочника и правятся только в нём: кнопка «Редактировать» открывает карточку контрагента (ctx.openCounterparty — её
  // даёт оболочка V1/V2; после сохранения V1 шлёт событие «zhbi:counterparty-saved», и список подрядчиков перечитывается).
  function paintContractors() {
    pane.innerHTML = `
      <div class="hc-bar"><strong>Подрядчики объекта</strong><span class="hc-muted">выбираются из общего справочника контрагентов; название и ИНН правятся там же — кнопкой «Редактировать»</span>${ctx.canWrite && !st.ctrAdd ? `<button type="button" class="hc-btn primary" id="hc-c-new">Добавить подрядчика</button>` : ""}</div>
      <div id="hc-ca"></div>
      <p id="hc-msg" class="hc-msg ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Подрядчик</th><th>ИНН</th><th>Справочник контрагентов</th><th>Виды работ</th><th class="num">Записей</th><th></th></tr></thead><tbody>${
        st.contractors.length ? [...st.contractors].sort((a, b) => (a.display || "").localeCompare(b.display || "", "ru")).map((c) => `<tr><td>${esc(c.name || "—")}</td>
          <td>${esc(c.inn || "—")} ${c.inn_note ? `<span class="hc-badge warn" title="В ИНН не 10 и не 12 цифр">${esc(c.inn_note)}</span>` : ""}</td>
          <td>${c.counterparty_id ? "в справочнике" : `<span class="hc-badge warn">не связан</span> <span class="hc-muted">выберите контрагента</span>`}</td>
          <td class="nw"><button type="button" class="hc-btn mini" data-works="${c.id}" aria-expanded="${st.openWorks.has(c.id)}" title="Перечень видов работ подрядчика и ответственные">${st.openWorks.has(c.id) ? "▾" : "▸"} Виды работ: ${(c.works || []).length}${(c.works || []).some((w) => !w.responsible_id) ? ` <span class="hc-badge warn" title="Есть виды работ без ответственного">!</span>` : ""}</button></td><td class="num">${c.records}</td>
          <td class="nw">${ctx.canWrite ? `${c.counterparty_id ? `<button type="button" class="hc-btn mini" data-edit-cp="${c.counterparty_id}" ${ctx.openCounterparty && ctx.canEditCounterparty ? "" : "disabled"} title="${ctx.openCounterparty && ctx.canEditCounterparty ? "Открыть карточку контрагента в общем справочнике: название, ИНН и реквизиты" : "Название и ИНН правятся в «Справочнике контрагентов» — для этого нужно право на этот раздел"}">Редактировать</button> ` : ""}<button type="button" class="hc-btn mini" data-replace="${c.id}" title="Привязать подрядчика к другому контрагенту справочника">${c.counterparty_id ? "Заменить контрагента" : "Выбрать контрагента"}</button> <button type="button" class="hc-btn danger mini" data-del="${c.id}">Удалить</button>` : ""}</td></tr>${st.openWorks.has(c.id) ? worksRow(c) : ""}`).join("")
        : `<tr><td colspan="6" class="hc-muted">Подрядчиков нет. Добавьте из справочника контрагентов или загрузите историю численности.</td></tr>`}</tbody></table></div>`;
    wireWorks();
    pane.querySelector("#hc-c-new")?.addEventListener("click", () => { openCtrAdd(null); });
    pane.querySelectorAll("[data-replace]").forEach((b) => b.addEventListener("click", () => openCtrAdd(Number(b.dataset.replace))));
    pane.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => delContractor(Number(b.dataset.del))));
    pane.querySelectorAll("[data-edit-cp]").forEach((b) => b.addEventListener("click", () => ctx.openCounterparty?.(Number(b.dataset.editCp))));
    if (st.ctrAdd) paintCtrAdd();
  }

  // ---- виды работ подрядчика и ответственные (2026-10-26) ----
  // Перечень видов работ подрядчика на объекте и ответственный за каждую пару «подрядчик + вид работ» (физлицо из справочника). Бот eXpress спрашивает
  // контакт только по тем парам, где ответственный — его физлицо. Перечень не ограничивает ввод численности: это справочная привязка людей к строкам.
  async function loadIndividuals() {
    if (st.individuals) return;
    try { st.individuals = ((await api.get("/individuals")) || []).slice().sort((a, b) => a.name.localeCompare(b.name, "ru")); }
    catch (e) { st.individuals = []; setMsg(`Справочник физлиц не загрузился: ${errText(e)}`, "bad"); }
  }
  const respOptions = (selectedId) => `<option value="">— не назначен —</option>${(st.individuals || []).map((i) => `<option value="${i.id}" ${i.id === selectedId ? "selected" : ""}>${esc(i.name)}</option>`).join("")}`;
  function worksRow(c) {
    const works = c.works || [];
    return `<tr class="hc-works-row"><td colspan="6">
      <div class="hc-works">
        <table class="hc-tbl"><thead><tr><th>Вид работ</th><th>Ответственный (физлицо из справочника)</th><th>Примечание</th><th></th></tr></thead><tbody>${works.length ? works.map((w) => `<tr>
          <td><span class="hc-code">${esc(w.code)}</span> ${esc(w.name)}${w.retired ? ' <span class="hc-badge warn">выведен из действия</span>' : ""}</td>
          <td>${ctx.canWrite ? `<select data-resp="${c.id}:${w.id}" aria-label="Ответственный: ${esc(w.name)}">${respOptions(w.responsible_id)}</select>` : esc(w.responsible || "— не назначен —")}</td>
          <td>${ctx.canWrite ? `<input type="text" class="hc-note" data-note="${c.id}:${w.id}" value="${esc(w.note || "")}" maxlength="${NOTE_MAX}" placeholder="до ${NOTE_MAX} символов" autocomplete="off" aria-label="Примечание: ${esc(w.name)}" title="Бот eXpress добавит примечание в скобках к названию вида работ">` : esc(w.note || "")}</td>
          <td class="nw">${ctx.canWrite ? `<button type="button" class="hc-btn danger mini" data-work-del="${c.id}:${w.id}" title="Убрать вид работ у подрядчика" aria-label="Убрать вид работ">✕</button>` : ""}</td></tr>`).join("")
          : `<tr><td colspan="4" class="hc-muted">Видов работ пока нет.${ctx.canWrite ? " Добавьте их и назначьте ответственных — бот спросит каждого только по его строкам." : ""}</td></tr>`}</tbody></table>
        ${ctx.canWrite ? `<div class="hc-bar"><button type="button" class="hc-btn" data-work-add="${c.id}">Добавить вид работ</button>
          <label class="hc-check-inline">ответственный для нового: <select data-resp-default="${c.id}">${respOptions(st.defaultResp[c.id] ?? null)}</select></label></div>` : ""}
      </div></td></tr>`;
  }
  function wireWorks() {
    pane.querySelectorAll("[data-works]").forEach((b) => b.addEventListener("click", async () => {
      const id = Number(b.dataset.works);
      if (st.openWorks.has(id)) st.openWorks.delete(id); else { st.openWorks.add(id); await loadIndividuals(); }
      if (!dead) paintContractors();
    }));
    pane.querySelectorAll("[data-resp]").forEach((sel) => sel.addEventListener("change", async () => {
      const [cid, wid] = sel.dataset.resp.split(":").map(Number);
      try {
        await api.patch(`/objects/${ctx.objectId}/headcount/contractors/${cid}/works/${wid}`, { responsible_id: sel.value ? Number(sel.value) : null });
        setMsg(sel.value ? "Ответственный назначен." : "Ответственный снят.", "ok");
      } catch (e) { setMsg(errText(e), "bad"); }
      await reloadContractors();
    }));
    pane.querySelectorAll("[data-note]").forEach((inp) => inp.addEventListener("change", async () => {
      const [cid, wid] = inp.dataset.note.split(":").map(Number);
      try {
        await api.patch(`/objects/${ctx.objectId}/headcount/contractors/${cid}/works/${wid}`, { note: inp.value.trim() || null });
        setMsg(inp.value.trim() ? "Примечание сохранено." : "Примечание убрано.", "ok");
      } catch (e) { setMsg(errText(e), "bad"); }
      await reloadContractors();
    }));
    pane.querySelectorAll("[data-resp-default]").forEach((sel) => sel.addEventListener("change", () => { st.defaultResp[Number(sel.dataset.respDefault)] = sel.value ? Number(sel.value) : null; }));
    pane.querySelectorAll("[data-work-del]").forEach((b) => b.addEventListener("click", async () => {
      const [cid, wid] = b.dataset.workDel.split(":").map(Number);
      const w = (st.contractors.find((c) => c.id === cid)?.works || []).find((x) => x.id === wid);
      if (!(await ctx.confirm(`Убрать у подрядчика вид работ «${w ? w.name : ""}»? Внесённая ранее численность останется, бот перестанет спрашивать по этой строке.`, { danger: true }))) return;
      try { await api.delete(`/objects/${ctx.objectId}/headcount/contractors/${cid}/works/${wid}`); setMsg("Вид работ убран.", "ok"); } catch (e) { setMsg(errText(e), "bad"); }
      await reloadContractors();
    }));
    pane.querySelectorAll("[data-work-add]").forEach((b) => b.addEventListener("click", () => {
      const cid = Number(b.dataset.workAdd), have = new Set((st.contractors.find((c) => c.id === cid)?.works || []).map((w) => w.codifier_id));
      openPickDialog({
        ...WORK_CFG_L1, items: st.works.filter((w) => w.level === 1 && !have.has(w.id) && !w.retired_at).map((w) => ({ ...w, parent_id: null, has_children: false })), selectedId: null,
        onPick: async (item) => {
          try {
            await api.post(`/objects/${ctx.objectId}/headcount/contractors/${cid}/works`, { codifier_id: item.id, responsible_id: st.defaultResp[cid] ?? null });
            setMsg(`Добавлено: ${item.code} ${item.name}.`, "ok");
          } catch (e) { setMsg(errText(e), "bad"); }
          await reloadContractors();
        },
      });
    }));
  }

  let ctrTimer = 0;
  function openCtrAdd(replaceId) {
    st.ctrAdd = { replaceId, q: "", items: [], total: 0, canCreate: null, loaded: false, msg: "", kind: "", newForm: null };
    st.msg = ""; paintContractors();
    pane.querySelector("#hc-ca-q")?.focus();
    searchCtr();
  }
  function closeCtrAdd() { clearTimeout(ctrTimer); st.ctrAdd = null; paintContractors(); }

  async function searchCtr() {
    const a = st.ctrAdd; if (!a) return;
    const q = a.q;
    try {
      const r = await api.get(`/objects/${ctx.objectId}/headcount/counterparty-search?q=${encodeURIComponent(q)}`);
      if (dead || st.ctrAdd !== a || a.q !== q) return;
      Object.assign(a, { items: r.items || [], total: r.total || 0, canCreate: !!r.can_create, loaded: true });
      if (a.kind === "bad" && a.msg === a.searchErr) { a.msg = ""; a.kind = ""; }
    } catch (e) { if (dead || st.ctrAdd !== a) return; a.msg = a.searchErr = errText(e); a.kind = "bad"; }
    paintCtrAddMsg(); paintCtrRows(); paintCtrNew();
  }

  function paintCtrAddMsg() { const n = pane.querySelector("#hc-ca-msg"), a = st.ctrAdd; if (n && a) { n.textContent = a.msg; n.className = `hc-msg ${a.kind || ""}`; } }

  function paintCtrAdd() {
    const box = pane.querySelector("#hc-ca"), a = st.ctrAdd;
    if (!box || !a) return;
    const target = a.replaceId != null ? st.contractors.find((x) => x.id === a.replaceId) : null;
    box.innerHTML = `<div class="hc-form hc-ca"><strong style="flex-basis:100%">${target ? `Заменить контрагента у подрядчика «${esc(target.display)}»` : "Добавить подрядчика из общего справочника контрагентов"}</strong>
      <label class="hc-grow">Поиск по ИНН или названию<input type="text" id="hc-ca-q" value="${esc(a.q)}" maxlength="100" autocomplete="off" placeholder="ИНН или часть названия"></label>
      ${target ? "" : `<button type="button" class="hc-btn" id="hc-ca-mk" title="Если нужного контрагента нет в справочнике">Завести нового контрагента</button>`}
      <button type="button" class="hc-btn" id="hc-ca-close">Закрыть</button>
      <div id="hc-ca-new" style="flex-basis:100%"></div>
      <p class="hc-msg ${esc(a.kind || "")}" id="hc-ca-msg" role="alert" style="flex-basis:100%">${esc(a.msg || "")}</p>
      <div class="hc-scroll" style="flex-basis:100%"><table class="hc-tbl"><thead><tr><th>Контрагент</th><th>ИНН</th><th></th></tr></thead><tbody id="hc-ca-rows"></tbody></table></div></div>`;
    box.querySelector("#hc-ca-q").addEventListener("input", (e) => { a.q = e.target.value; clearTimeout(ctrTimer); ctrTimer = setTimeout(searchCtr, 250); });
    box.querySelector("#hc-ca-close").addEventListener("click", closeCtrAdd);
    box.querySelector("#hc-ca-mk")?.addEventListener("click", () => {
      const q = a.q.trim();
      a.newForm = { name: /\d/.test(q) && !/[^\d\s]/.test(q) ? "" : q, inn: /^[\d\s]+$/.test(q) ? q.replace(/\s+/g, "") : "", msg: "" };
      paintCtrNew(); box.querySelector("#hc-ca-nm")?.focus();
    });
    paintCtrRows(); paintCtrNew();
  }

  function paintCtrRows() {
    const a = st.ctrAdd, body = pane.querySelector("#hc-ca-rows");
    if (!a || !body) return;
    const replacing = a.replaceId != null;
    body.innerHTML = !a.loaded ? `<tr><td colspan="3" class="hc-muted">Загрузка…</td></tr>`
      : a.items.length ? a.items.map((c) => `<tr><td>${esc(c.name)}${c.full_name ? `<div class="hc-muted hc-small">${esc(c.full_name)}</div>` : ""}</td>
          <td>${c.inn ? esc(c.inn) : '<span class="hc-muted">нет</span>'}${c.inn_status === "unverified" ? ` <span class="hc-badge warn">ИНН не проверен</span>` : ""}</td>
          <td class="nw">${c.added && !(replacing && c.added === a.replaceId) ? `<span class="hc-muted">уже в списке объекта</span>` : (c.added ? `<span class="hc-muted">уже выбран</span>` : `<button type="button" class="hc-btn mini primary" data-cp="${c.id}">${replacing ? "Выбрать" : "Добавить"}</button>`)}</td></tr>`).join("")
          + (a.total > a.items.length ? `<tr><td colspan="3" class="hc-muted hc-small">Показаны первые ${a.items.length} из ${a.total} — уточните запрос.</td></tr>` : "")
      : `<tr><td colspan="3" class="hc-muted">В справочнике ничего не нашлось${replacing ? "" : ". Можно завести нового контрагента"}.</td></tr>`;
    body.querySelectorAll("[data-cp]").forEach((b) => b.addEventListener("click", () => pickCounterparty(Number(b.dataset.cp), b)));
  }

  async function pickCounterparty(cpId, btn) {
    const a = st.ctrAdd; if (!a) return;
    if (btn) btn.disabled = true;
    try {
      if (a.replaceId != null) {
        const c = st.contractors.find((x) => x.id === a.replaceId);
        if (c && c.records && !(await ctx.confirm(`У подрядчика «${c.display}» есть записи численности (${c.records}). После замены они будут относиться к выбранному контрагенту. Продолжить?`, { danger: true }))) { if (btn) btn.disabled = false; return; }
        const r = await api.patch(`/objects/${ctx.objectId}/headcount/contractors/${a.replaceId}`, { counterparty_id: cpId });
        st.ctrAdd = null; await reloadContractors(); setMsg(`Контрагент заменён: ${r.display}.`, "ok");
      } else {
        const r = await api.post(`/objects/${ctx.objectId}/headcount/contractors`, { counterparty_id: cpId });
        st.ctrAdd = null; await reloadContractors(); setMsg(`Подрядчик добавлен: ${r.display}${r.inn_note ? " — " + r.inn_note : ""}.`, r.inn_note ? "warn" : "ok");
      }
    } catch (e) { if (btn) btn.disabled = false; a.msg = errText(e); a.kind = "bad"; paintCtrAddMsg(); }
  }

  function paintCtrNew() {
    const a = st.ctrAdd, box = pane.querySelector("#hc-ca-new");
    if (!a || !box) return;
    const f = a.newForm;
    if (!f) { box.innerHTML = ""; return; }
    if (a.canCreate === false) {
      box.innerHTML = `<div class="hc-callout warn" role="alert">Заводить контрагентов в общем справочнике может пользователь с правом на раздел «Справочник контрагентов» (Контрактация). Обратитесь к такому пользователю: он добавит контрагента, и вы выберете его из списка выше.</div>`;
      return;
    }
    box.innerHTML = `<div class="hc-form"><strong style="flex-basis:100%">Новый контрагент в общем справочнике</strong>
      <label>ИНН<input type="text" id="hc-ca-ni" value="${esc(f.inn)}" maxlength="20" inputmode="numeric" autocomplete="off"></label>
      <button type="button" class="hc-btn" id="hc-ca-eg" title="Подставить название из ЕГРЮЛ ФНС по ИНН (наружу уходит только ИНН)">Найти в ЕГРЮЛ</button>
      <label>Название<input type="text" id="hc-ca-nm" value="${esc(f.name)}" maxlength="300" autocomplete="off"></label>
      <button type="button" class="hc-btn primary" id="hc-ca-nok">Создать и добавить на объект</button><button type="button" class="hc-btn" id="hc-ca-ncl">Отмена</button>
      <p class="hc-muted hc-small" style="flex-basis:100%">Контрагент появится в «Справочнике контрагентов» для всех объектов; остальные реквизиты (КПП, адрес, контакты) дополните там.</p>
      <p class="hc-msg ${f.msg ? "bad" : ""}" id="hc-ca-nmsg" role="alert" style="flex-basis:100%">${esc(f.msg || "")}</p></div>`;
    box.querySelector("#hc-ca-ncl").addEventListener("click", () => { a.newForm = null; paintCtrNew(); });
    box.querySelector("#hc-ca-eg").addEventListener("click", async (ev) => {
      const note = box.querySelector("#hc-ca-nmsg");
      ev.target.disabled = true; note.className = "hc-msg"; note.textContent = "Запрашиваю ЕГРЮЛ…";
      try {
        const { lookupRequisites } = await import("/static/egrul-ui.js");
        const r = await lookupRequisites((p) => api.get(p), box.querySelector("#hc-ca-ni").value);
        if (r.found) { box.querySelector("#hc-ca-nm").value = r.requisites.short_name || r.requisites.full_name || ""; note.textContent = "Название подставлено из ЕГРЮЛ — проверьте и создайте контрагента."; }
        else note.textContent = "В ЕГРЮЛ по этому ИНН ничего не найдено.";
      } catch (e) { note.className = "hc-msg bad"; note.textContent = errText(e); }
      ev.target.disabled = false;
    });
    box.querySelector("#hc-ca-nok").addEventListener("click", async (ev) => {
      f.name = box.querySelector("#hc-ca-nm").value.trim(); f.inn = box.querySelector("#hc-ca-ni").value.trim();
      const note = box.querySelector("#hc-ca-nmsg");
      if (!f.name) { f.msg = "Укажите название контрагента"; note.textContent = f.msg; note.className = "hc-msg bad"; return; }
      ev.target.disabled = true;
      try {
        const r = await api.post(`/objects/${ctx.objectId}/headcount/contractors`, { create_counterparty: true, name: f.name, inn: f.inn || null });
        st.ctrAdd = null; await reloadContractors(); setMsg(`Контрагент заведён в справочнике и добавлен на объект: ${r.display}${r.inn_note ? " — " + r.inn_note : ""}.`, r.inn_note ? "warn" : "ok");
      } catch (e) { ev.target.disabled = false; f.msg = errText(e); note.textContent = f.msg; note.className = "hc-msg bad"; }
    });
  }

  async function reloadContractors() {
    try { st.contractors = (await api.get(`/objects/${ctx.objectId}/headcount/contractors`)).contractors || []; } catch (e) { setMsg(errText(e), "bad"); }
    if (!dead) paint();
  }
  async function delContractor(id) {
    const c = st.contractors.find((x) => x.id === id);
    if (!(await ctx.confirm(`Удалить подрядчика «${c.display}» из списка объекта?`, { danger: true }))) return;
    try { await api.delete(`/objects/${ctx.objectId}/headcount/contractors/${id}`); await reloadContractors(); setMsg("Подрядчик удалён.", "ok"); }
    catch (e) { setMsg(errText(e), "bad"); }
  }

  // =====================================================================  ОТЧЁТ
  function paintReport() {
    const r = st.rep;
    pane.innerHTML = `
      <div class="hc-filters">
        <div class="hc-seg" role="group" aria-label="Срез">${PRESETS.map((p) => `<button type="button" class="hc-btn ${r.preset === p.key ? "on" : ""}" data-preset="${p.key}">${esc(p.title)}</button>`).join("")}</div>
        ${r.preset === "objects" ? `<label class="hc-check"><input type="checkbox" id="hc-r-smu" ${r.bySmu ? "checked" : ""}> сгруппировать по подразделениям</label>` : ""}
        <span class="hc-spacer"></span>
        <button type="button" class="hc-btn" id="hc-r-open">Развернуть всё</button><button type="button" class="hc-btn" id="hc-r-close">Свернуть</button>
      </div>
      <div class="hc-filters">
        <label class="hc-f-obj">Объект<select id="hc-r-obj">${objectOptions(r.obj)}</select></label>
        <label>Показатель<select id="hc-r-staff" title="Итого — рабочие, ИТР и механизаторы вместе"><option value="total" ${r.staff === "total" ? "selected" : ""}>Итого</option><option value="workers" ${r.staff === "workers" ? "selected" : ""}>Рабочие</option><option value="itr" ${r.staff === "itr" ? "selected" : ""}>ИТР</option><option value="mech" ${r.staff === "mech" ? "selected" : ""}>Механизаторы</option></select></label>
        <label>На день<input type="date" id="hc-r-asof" value="${esc(r.asOf)}" title="Пусто — последний день с данными"></label>
        <label>Период с<input type="date" id="hc-r-from" value="${esc(r.from)}"></label>
        <label>по<input type="date" id="hc-r-to" value="${esc(r.to)}"></label>
        <button type="button" class="hc-btn primary" id="hc-r-go">Обновить</button>
        ${ctx.download ? `<button type="button" class="hc-btn" id="hc-r-xlsx" title="Выгрузить отчёт в Excel">В Excel</button>` : ""}
      </div>
      <p class="hc-muted hc-small">Показатель «Итого» — рабочие, ИТР и механизаторы вместе; «Рабочие», «ИТР» и «Механизаторы» показывают одно слагаемое. Среднее — сумма человек-дней за окно, делённая на число дней окна, в которые в выборке есть данные. Плана и отклонений пока нет.</p>
      <div id="hc-r-body"></div>`;
    pane.querySelector("#hc-r-obj").addEventListener("change", (e) => { r.obj = e.target.value; loadReport(); });
    pane.querySelector("#hc-r-staff").addEventListener("change", (e) => { r.staff = e.target.value; loadReport(); });
    pane.querySelector("#hc-r-smu")?.addEventListener("change", (e) => { r.bySmu = e.target.checked; r.toggled = new Set(); loadReport(); });
    pane.querySelector("#hc-r-open").addEventListener("click", () => { r.expand = "all"; r.toggled = new Set(); paintReportBody(); });
    pane.querySelector("#hc-r-close").addEventListener("click", () => { r.expand = null; r.toggled = new Set(); paintReportBody(); });
    pane.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { r.preset = b.dataset.preset; r.toggled = new Set(); r.expand = null; r.data = null; paintReport(); }));
    ["asof", "from", "to"].forEach((k) => pane.querySelector(`#hc-r-${k}`).addEventListener("change", (e) => { r[{ asof: "asOf", from: "from", to: "to" }[k]] = e.target.value; if (k === "asof") r.asOfUser = !!e.target.value; }));
    pane.querySelector("#hc-r-go").addEventListener("click", loadReport);
    pane.querySelector("#hc-r-xlsx")?.addEventListener("click", async () => {
      try { await ctx.download(`/headcount/report.xlsx?${reportQuery()}`, "Численность_отчёт.xlsx"); } catch (e) { r.error = errText(e); paintReportBody(); }
    });
    if (r.data || r.error || r.loading) paintReportBody(); else loadReport();
  }

  function reportQuery() {
    const r = st.rep, preset = PRESETS.find((p) => p.key === r.preset);
    const levels = (r.preset === "objects" && r.bySmu ? ["smu", ...preset.levels] : preset.levels).join(",");
    const q = new URLSearchParams({ levels });
    if (r.asOfUser && r.asOf) q.set("as_of", r.asOf);   // не задана человеком — сервер берёт последний день с данными
    if (r.from && r.to) { q.set("date_from", r.from); q.set("date_to", r.to); }
    if (r.obj && r.obj !== "all") q.set("object_ids", r.obj);
    if (r.staff && r.staff !== "total") q.set("staff", r.staff);
    return q.toString();
  }

  async function loadReport() {
    const r = st.rep;
    r.loading = true; r.error = ""; paintReportBody();
    try { r.data = await api.get(`/headcount/report?${reportQuery()}`); if (!r.asOfUser) r.asOf = r.data.as_of || ""; } catch (e) { r.error = errText(e); r.data = null; }
    r.loading = false;
    if (!dead && st.tab === "report") paintReportBody();
  }

  function buildTree(rows, levels) {
    const root = { children: new Map(), sums: {} };
    const add = (node, row) => { for (const k of ["fact_day", "week_avg", "month_avg", "period_sum", "period_avg"]) if (row[k] != null) node.sums[k] = (node.sums[k] || 0) + row[k]; };
    for (const row of rows) {
      let node = root, path = "";
      levels.forEach((lv, i) => {
        const cell = row[lv]; path += `/${lv}:${cell.key}`;
        if (!node.children.has(path)) node.children.set(path, { path, label: cell.label, level: lv, depth: i, children: new Map(), sums: {} });
        node = node.children.get(path); add(node, row);
      });
    }
    return root;
  }

  function paintReportBody() {
    const box = pane.querySelector("#hc-r-body"), r = st.rep;
    if (!box) return;
    if (r.loading) { box.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    if (r.error) { box.innerHTML = `<div class="hc-callout bad" role="alert">${esc(r.error)}</div>`; return; }
    const d = r.data;
    const asofInput = pane.querySelector("#hc-r-asof");
    if (asofInput && !r.asOfUser && r.asOf) asofInput.value = r.asOf;   // день, который выбрал сервер
    if (!d || !d.rows.length) { box.innerHTML = `<p class="hc-muted">Данных за выбранное окно нет.</p>`; return; }
    const hasPeriod = d.total.period_sum != null;
    const tree = buildTree(d.rows, d.levels);
    const lines = [];
    const walk = (node) => [...node.children.values()].sort((a, b) => (b.sums.month_avg || 0) - (a.sums.month_avg || 0) || a.label.localeCompare(b.label, "ru")).forEach((n) => {
      const leaf = n.children.size === 0, open = (r.expand === "all") !== r.toggled.has(n.path);   // по умолчанию всё свёрнуто: на верхнем уровне видны ВСЕ строки, раскрывают по клику или кнопкой   // по умолчанию раскрыт только верхний уровень
      lines.push(`<tr class="d${Math.min(n.depth, 3)}" data-path="${esc(n.path)}"><td style="padding-left:${8 + n.depth * 18}px">${leaf ? `<span class="hc-leaf"></span>` : `<button type="button" class="hc-tog" data-tog="${esc(n.path)}" aria-expanded="${open}">${open ? "▾" : "▸"}</button>`}${esc(n.label)}</td>
        <td class="num">${fmtNum(n.sums.fact_day)}</td><td class="num">${fmtNum(n.sums.week_avg)}</td><td class="num">${fmtNum(n.sums.month_avg)}</td>${hasPeriod ? `<td class="num">${fmtNum(n.sums.period_sum)}</td><td class="num">${fmtNum(n.sums.period_avg)}</td>` : ""}</tr>`);
      if (!leaf && open) walk(n);
    });
    walk(tree);
    const max = Math.max(1, ...d.months.map((m) => m.avg));
    box.innerHTML = `<div class="hc-scroll"><table class="hc-tbl hc-rep"><thead><tr><th>${esc(d.levels.map((l) => LEVEL_TITLES[l]).join(" → "))}</th><th class="num">Факт на ${esc(fmtDate(d.as_of))}</th><th class="num">Среднее за неделю</th><th class="num">Среднее за месяц</th>${hasPeriod ? `<th class="num">Человек-дней за период</th><th class="num">Среднее за период</th>` : ""}</tr></thead>
      <tbody>${lines.join("")}</tbody><tfoot><tr><td>Итого${d.objects > 1 ? ` (объектов: ${d.objects})` : ""}</td><td class="num">${fmtNum(d.total.fact_day)}</td><td class="num">${fmtNum(d.total.week_avg)}</td><td class="num">${fmtNum(d.total.month_avg)}</td>${hasPeriod ? `<td class="num">${fmtNum(d.total.period_sum)}</td><td class="num">${fmtNum(d.total.period_avg)}</td>` : ""}</tr></tfoot></table></div>
      ${d.months.length ? `<h4>Среднесуточная численность по месяцам</h4><div class="hc-chart" role="img" aria-label="Среднесуточная численность по месяцам">${d.months.map((m) => `<div class="hc-col" title="${esc(m.month)}: ${fmtNum(m.avg)} чел. (дней с данными: ${m.days})"><span class="hc-val">${fmtNum(m.avg)}</span><span class="hc-bar-v" style="height:${Math.max(2, Math.round(m.avg / max * 100))}%"></span><span class="hc-lab">${MONTHS[Number(m.month.slice(5)) - 1]}</span></div>`).join("")}</div>` : ""}`;
    box.querySelectorAll("[data-tog]").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.tog;
      if (r.toggled.has(p)) r.toggled.delete(p); else r.toggled.add(p);
      paintReportBody();
    }));
  }

  // =====================================================================  ВСЕ ДАННЫЕ (просмотр внесённого и загруженного)
  function dataQuery(extra = {}) {
    const d = st.data, q = new URLSearchParams();
    if (d.obj && d.obj !== "all") q.set("object_ids", d.obj);
    if (d.from) q.set("date_from", d.from);
    if (d.to) q.set("date_to", d.to);
    if (d.contractor.trim()) q.set("contractor_q", d.contractor.trim());
    const work = d.workId && st.works.find((w) => w.id === d.workId);
    if (work) q.set("work_code", work.code);
    if (d.source) q.set("source", d.source);
    if (d.late && d.mode === "records") q.set("late", "true");
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    return q.toString();
  }

  function paintData() {
    const d = st.data, all = !d.obj || d.obj === "all";
    pane.innerHTML = `
      <div class="hc-filters">
        <div class="hc-seg" role="group" aria-label="Что показывать"><button type="button" class="hc-btn ${d.mode === "records" ? "on" : ""}" data-mode="records">Записи</button><button type="button" class="hc-btn ${d.mode === "history" ? "on" : ""}" data-mode="history">История изменений</button></div>
        <label class="hc-f-obj">Объект<select id="hc-d-obj">${objectOptions(d.obj)}</select></label>
        <label>День с<input type="date" id="hc-d-from" value="${esc(d.from)}"></label>
        <label>по<input type="date" id="hc-d-to" value="${esc(d.to)}"></label>
        ${d.mode === "records" ? `<label class="hc-check"><input type="checkbox" id="hc-d-late" ${d.late ? "checked" : ""}> только просроченные</label>` : ""}
      </div>
      <div class="hc-filters">
        <label class="hc-f-ctr">Подрядчик (название или ИНН)<input type="text" id="hc-d-ctr" value="${esc(d.contractor)}" placeholder="часть названия или ИНН"></label>
        <label class="hc-grow">Вид работ (код и всё, что под ним)<div class="hc-picker" id="hc-d-work"></div></label>
        <label>Источник<select id="hc-d-src"><option value="">любой</option><option value="form" ${d.source === "form" ? "selected" : ""}>форма</option><option value="import" ${d.source === "import" ? "selected" : ""}>из SharePoint</option></select></label>
        <button type="button" class="hc-btn primary" id="hc-d-go">Показать</button>
        ${ctx.download ? `<button type="button" class="hc-btn" id="hc-d-xlsx" title="Выгрузить весь отбор в Excel">В Excel</button>` : ""}
      </div>
      <div id="hc-d-body"></div>`;
    const picker = workPicker(pane.querySelector("#hc-d-work"), st.works);
    if (d.workId) picker.set(d.workId);
    const read = () => {
      d.obj = pane.querySelector("#hc-d-obj").value; d.from = pane.querySelector("#hc-d-from").value; d.to = pane.querySelector("#hc-d-to").value;
      d.contractor = pane.querySelector("#hc-d-ctr").value; d.source = pane.querySelector("#hc-d-src").value;
      d.late = !!pane.querySelector("#hc-d-late")?.checked; d.workId = picker.value();
    };
    pane.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { read(); d.mode = b.dataset.mode; d.offset = 0; d.res = null; paintData(); }));
    pane.querySelector("#hc-d-go").addEventListener("click", () => { read(); d.offset = 0; loadData(); });
    pane.querySelector("#hc-d-ctr").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); read(); d.offset = 0; loadData(); } });
    pane.querySelector("#hc-d-xlsx")?.addEventListener("click", async () => {
      read();
      try { await ctx.download(`/headcount/${d.mode === "records" ? "records" : "history-log"}.xlsx?${dataQuery()}`, d.mode === "records" ? "Численность_записи.xlsx" : "Численность_журнал_изменений.xlsx"); }
      catch (e) { d.error = errText(e); paintDataBody(); }
    });
    if (d.res || d.error || d.loading) paintDataBody(); else loadData();
  }

  async function loadData() {
    const d = st.data;
    d.loading = true; d.error = ""; paintDataBody();
    try { d.res = await api.get(`/headcount/${d.mode === "records" ? "records" : "history-log"}?${dataQuery({ limit: d.limit, offset: d.offset })}`); }
    catch (e) { d.error = errText(e); d.res = null; }
    d.loading = false;
    if (!dead && st.tab === "data") paintDataBody();
  }

  function paintDataBody() {
    const d = st.data, box = pane.querySelector("#hc-d-body"), all = !d.obj || d.obj === "all";
    if (!box) return;
    if (d.loading) { box.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    if (d.error) { box.innerHTML = `<div class="hc-callout bad" role="alert">${esc(d.error)}</div>`; return; }
    const r = d.res;
    if (!r || !r.total) {
      const filtered = !!(d.from || d.to || d.contractor.trim() || d.workId || d.source || d.late);
      const more = d.mode === "records" && !all && !filtered && r && r.all_total;
      box.innerHTML = `<p class="hc-muted">По выбранным условиям данных нет.</p>${more ? `<div class="hc-callout warn">По этому объекту записей нет, а по всем доступным вам объектам их ${r.all_total.toLocaleString("ru-RU")}. <button type="button" class="hc-btn" id="hc-d-all">Показать по всем объектам</button></div>` : ""}`;
      box.querySelector("#hc-d-all")?.addEventListener("click", () => { d.obj = "all"; d.offset = 0; d.res = null; paintData(); });
      return;
    }
    const from = r.offset + 1, to = r.offset + r.items.length;
    const sourceText = (x) => (x === "import" ? "загрузка из SharePoint" : x === "bot" ? "бот" : "форма");
    const head = `<div class="hc-bar"><span><strong>${from.toLocaleString("ru-RU")}–${to.toLocaleString("ru-RU")}</strong> из ${r.total.toLocaleString("ru-RU")}</span>
      ${d.mode === "records" ? `<span class="hc-muted">человек-дней в выборке: итого <strong>${(r.sum_total ?? r.sum_workers).toLocaleString("ru-RU")}</strong> (рабочие ${r.sum_workers.toLocaleString("ru-RU")}, ИТР ${(r.sum_itr ?? 0).toLocaleString("ru-RU")}, механизаторы ${(r.sum_mech ?? 0).toLocaleString("ru-RU")})</span>` : ""}
      <button type="button" class="hc-btn mini" id="hc-d-prev" ${r.offset <= 0 ? "disabled" : ""}>◀ Назад</button><button type="button" class="hc-btn mini" id="hc-d-next" ${to >= r.total ? "disabled" : ""}>Вперёд ▶</button></div>`;
    const objCol = (name) => (all ? `<td>${esc(name)}</td>` : "");
    const rows = d.mode === "records" ? r.items.map((i) => `<tr><td class="nw">${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}${i.inn_status === "unverified" ? ` <span class="hc-badge warn">ИНН не проверен</span>` : ""}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.workers}</td><td class="num">${i.itr ?? 0}</td><td class="num">${i.mech ?? 0}</td><td class="num"><strong>${i.total ?? i.workers}</strong></td>
        <td class="hc-small"><span class="nw">${esc(fmtMoment(i.entered_at))}</span>${i.entered_by ? " · " + esc(i.entered_by) : ""}<br>${i.late ? `<span class="hc-badge bad">просрочено${i.overdue_minutes ? " на " + fmtOverdue(i.overdue_minutes) : ""}</span> ` : ""}<span class="hc-badge">${esc(sourceText(i.source))}</span>${i.changes ? ` <span class="hc-badge" title="Последняя правка: ${esc(fmtMoment(i.updated_at))}${i.updated_by ? " · " + esc(i.updated_by) : ""}">правок: ${i.changes}</span>` : ""}</td></tr>`).join("")
      : r.items.map((i) => `<tr><td class="hc-small"><span class="nw">${esc(fmtMoment(i.changed_at))}</span><br>${esc(i.changed_by || "—")} <span class="hc-badge">${esc(sourceText(i.source))}</span></td><td class="nw">${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.old ?? "—"} → ${i.new ?? "удалено"}</td><td class="num">${i.old_itr ?? "—"} → ${i.new_itr ?? (i.new == null ? "удалено" : "—")}</td><td class="num">${i.old_mech ?? "—"} → ${i.new_mech ?? (i.new == null ? "удалено" : "—")}</td></tr>`).join("");
    const heads = d.mode === "records"
      ? ["День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Рабочие", "ИТР", "Механизаторы", "Итого", "Внесено (кто и когда)"]
      : ["Когда и кто изменил", "День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Рабочие: было → стало", "ИТР: было → стало", "Механизаторы: было → стало"];
    box.innerHTML = `${head}<div class="hc-scroll"><table class="hc-tbl"><thead><tr>${heads.map((h) => `<th class="${["Рабочие", "ИТР", "Механизаторы", "Итого", "Рабочие: было → стало", "ИТР: было → стало", "Механизаторы: было → стало"].includes(h) ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
    box.querySelector("#hc-d-prev").addEventListener("click", () => { d.offset = Math.max(0, d.offset - d.limit); loadData(); });
    box.querySelector("#hc-d-next").addEventListener("click", () => { d.offset += d.limit; loadData(); });
  }

  // =====================================================================  ВИДЫ РАБОТ (справочник-кодификатор целиком)
  async function loadCodifier() {
    st.codErr = "";
    try { st.cod = (await api.get(`/objects/${ctx.objectId}/headcount/codifier?full=true`)).works || []; }
    catch (e) { st.cod = []; st.codErr = errText(e); }
    if (!dead && st.tab === "codifier") paintCodifier();
  }

  function paintCodifier() {
    if (st.cod === null) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; loadCodifier(); return; }
    const all = st.cod, sections = new Set(all.map((w) => w.section_name || "Без раздела"));
    const retired = all.filter((w) => w.retired_at).length, used = all.filter((w) => w.records).length;
    pane.innerHTML = `
      <div class="hc-filters">
        <p class="hc-muted hc-small" style="margin:0;flex:1 1 320px">Общий справочник видов работ (кодификатор): один на все объекты, ${all.length.toLocaleString("ru-RU")} позиций в ${sections.size} разделах${used ? `, использовано в численности: ${used}` : ""}${retired ? `, выведено из действия: ${retired}` : ""}.
          ${ctx.canAdmin ? "Обновляется загрузкой файла «Справочник по видам работ»." : "Загружает и обновляет справочник администратор сервиса."}</p>
        ${ctx.canAdmin ? `<button type="button" class="hc-btn" id="hc-c-load">Загрузить / обновить из Excel…</button>` : ""}
      </div>
      ${st.codErr ? `<div class="hc-callout bad" role="alert">${esc(st.codErr)}</div>` : ""}
      ${all.length ? `<div id="hc-c-table"></div>` : `<div class="hc-callout warn">Справочник пуст. ${ctx.canAdmin ? "Загрузите файл «Справочник по видам работ» на вкладке «Загрузка данных»." : "Попросите администратора сервиса загрузить его."}</div>`}`;
    if (all.length) pickTable(pane.querySelector("#hc-c-table"), {
      items: all, tree: true, treeColumn: "name",
      columns: [
        { key: "name", title: "Вид работ", filter: true, text: (w) => w.name, html: (w) => esc(w.name) },
        { key: "code", title: "Код", filter: true, cls: "nw", text: (w) => w.code, html: (w) => `<span class="hc-code">${esc(w.code)}</span>` },
        { key: "unit", title: "Ед.", cls: "nw", text: (w) => w.unit || "", html: (w) => esc(w.unit || "") },
        { key: "records", title: "Записей численности", cls: "num", text: (w) => String(w.records || ""), html: (w) => (w.records ? w.records.toLocaleString("ru-RU") : "") },
        { key: "state", title: "", cls: "nw", text: (w) => (w.retired_at ? "выведен" : ""), html: (w) => (w.retired_at ? `<span class="hc-badge warn">выведен из действия</span>` : "") },
      ],
      rowClass: (w) => (w.retired_at ? "retired" : ""),
    });
    pane.querySelector("#hc-c-load")?.addEventListener("click", () => { st.tab = "admin"; paint(); });
  }

  // =====================================================================  ЗАГРУЗКА ДАННЫХ (администратор сервиса)
  function paintAdmin() {
    const a = st.adm;
    pane.innerHTML = `
      <h4>1. Кодификатор видов работ</h4>
      <p class="hc-muted hc-small">Файл «Справочник по видам работ (PBI).xlsx», лист «РаботыНаименовКодифМСУ». Добавляет и обновляет записи; коды, которых нет в файле, остаются.</p>
      <div class="hc-bar"><input type="file" id="hc-cod-file" accept=".xlsx"><button type="button" class="hc-btn" id="hc-cod-dry" ${a.busy ? "disabled" : ""}>Проверить без записи</button><button type="button" class="hc-btn primary" id="hc-cod-go" ${a.busy ? "disabled" : ""}>Загрузить</button></div>
      <p class="hc-msg" id="hc-cod-res" role="status">${esc(a.codResult)}</p>
      <h4>2. Выгрузка факта численности из SharePoint</h4>
      <p class="hc-muted hc-small">Файл «Выгрузка факт численности ….xlsx». Сначала разбор без записи, затем — сопоставление объектов 1С с объектами системы (вручную при первой загрузке), затем загрузка. Повторная загрузка того же файла ничего не меняет, правки из формы не затираются.</p>
      <div class="hc-bar"><input type="file" id="hc-his-file" accept=".xlsx"><button type="button" class="hc-btn" id="hc-his-an" ${a.busy ? "disabled" : ""}>Разобрать файл</button></div>
      <div id="hc-his-body"></div>
      ${a.error ? `<div class="hc-callout bad" role="alert">${esc(a.error)}</div>` : ""}`;
    const fileOf = (id) => pane.querySelector(id).files[0] || null;
    const upload = async (path, file, extra = {}) => {
      const fd = new FormData(); fd.append("file", file);
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      return ctx.upload(path, fd);
    };
    const codRun = async (dry) => {
      const f = fileOf("#hc-cod-file"); if (!f) { a.codResult = "Сначала выберите файл"; paintAdmin(); return; }
      a.busy = true; a.error = ""; paintAdmin();
      try { const r = await upload("/headcount/codifier/import", f, { dry_run: dry ? "true" : "false" });
        a.codResult = `${dry ? "Проверка (ничего не записано): " : "Загружено: "}в файле ${r.rows}, новых ${r.created}, изменено ${r.updated}, без изменений ${r.unchanged}${r.absent_in_file ? `, в справочнике есть, в файле нет: ${r.absent_in_file}` : ""}.`;
        if (!dry) { st.cod = null; st.works = null; loadRefs(); }   // справочник изменился: форма ввода и вкладка «Виды работ» перечитают его
      } catch (e) { a.error = errText(e); a.codResult = ""; }
      a.busy = false; paintAdmin();
    };
    pane.querySelector("#hc-cod-dry").addEventListener("click", () => codRun(true));
    pane.querySelector("#hc-cod-go").addEventListener("click", () => codRun(false));
    pane.querySelector("#hc-his-an").addEventListener("click", async () => {
      const f = fileOf("#hc-his-file"); if (!f) { a.error = "Сначала выберите файл выгрузки"; paintAdmin(); return; }
      a.busy = true; a.error = ""; a.result = ""; a.file = f; paintAdmin();
      try { a.analysis = await upload("/headcount/import/analyze", f); a.mapping = Object.fromEntries(a.analysis.objects.map((g) => [g.guid, g.object_id])); }
      catch (e) { a.error = errText(e); a.analysis = null; }
      a.busy = false; paintAdmin();
    });
    paintAnalysis();
  }

  function paintAnalysis() {
    const a = st.adm, box = pane.querySelector("#hc-his-body"), an = a.analysis;
    if (!box) return;
    if (!an) { box.innerHTML = a.result ? `<div class="hc-callout ok" role="status">${esc(a.result)}</div>` : ""; return; }
    const k = an.contractors;
    const warn = [
      an.unknown_codes.length ? `Кодов нет в кодификаторе: ${an.unknown_codes.map((u) => `${u.code} (${u.rows})`).join(", ")} — загрузите кодификатор, иначе эти строки будут пропущены.` : "",
      Object.keys(an.bad_rows).length ? `Строк с браком: ${Object.entries(an.bad_rows).map(([r, n]) => `${r} — ${n}`).join("; ")}.` : "",
      k.name_in_inn_field ? `В колонке ИНН вместо числа записано название организации: подрядчиков ${k.name_in_inn_field} (загрузятся как подрядчики без ИНН).` : "",
      k.unverified ? `ИНН не из 10/12 цифр: подрядчиков ${k.unverified} (загрузятся как есть, с пометкой «ИНН не проверен»).` : "",
    ].filter(Boolean);
    const mapped = Object.values(a.mapping).filter(Boolean).length;
    box.innerHTML = `${a.result ? `<div class="hc-callout ok" role="status">${esc(a.result)}</div>` : ""}
      <div class="hc-sum"><div><b>${an.rows_valid.toLocaleString("ru-RU")}</b> строк</div><div><b>${fmtDate(an.date_from)} — ${fmtDate(an.date_to)}</b> (${an.days} дн.)</div><div><b>${an.keys.toLocaleString("ru-RU")}</b> записей после сворачивания</div>
        <div><b>${an.duplicate_keys}</b> повторов ключа (с разными числами: ${an.conflicting_keys})</div><div><b>${k.total}</b> подрядчиков</div><div><b>${an.weekend_rows.toLocaleString("ru-RU")}</b> строк за выходные</div></div>
      ${warn.map((w) => `<div class="hc-callout warn">${esc(w)}</div>`).join("")}
      <p class="hc-muted">Объектов 1С в файле: ${an.objects.length}; сопоставлено: <b id="hc-mapped">${mapped}</b>, не сопоставлено: <b id="hc-unmapped">${an.objects.length - mapped}</b>. Несопоставленные не загружаются; они показаны первыми, под названием — похожие объекты системы.
        <label class="hc-check-inline"><input type="checkbox" id="hc-only-un" ${a.onlyUnmapped ? "checked" : ""}> только несопоставленные</label></p>
      <div class="hc-scroll hc-maptbl"><table class="hc-tbl"><thead><tr><th>Объект 1С</th><th class="num">Строк</th><th>Период</th><th>Объект в системе</th></tr></thead><tbody>${[...an.objects].sort((x, y) => (a.mapping[x.guid] ? 1 : 0) - (a.mapping[y.guid] ? 1 : 0)).filter((g) => !a.onlyUnmapped || !a.mapping[g.guid]).map((g) => `<tr class="${a.mapping[g.guid] ? "" : "unmapped"}">
        <td>${esc(g.name_1c || "—")}<div class="hc-small hc-muted">${esc(g.guid)}</div></td><td class="num">${g.rows.toLocaleString("ru-RU")}</td><td class="hc-small">${fmtDate(g.date_from)} — ${fmtDate(g.date_to)}</td>
        <td><select data-guid="${esc(g.guid)}"><option value="">— не загружать —</option>${an.candidates.map((o) => `<option value="${o.id}" ${a.mapping[g.guid] === o.id ? "selected" : ""} ${o.guid_1c && o.guid_1c !== g.guid ? "disabled" : ""}>${esc(o.name)}${o.guid_1c && o.guid_1c !== g.guid ? " (уже привязан к другому GUID)" : ""}</option>`).join("")}</select>${g.match ? `<span class="hc-badge">${g.match === "guid" ? "по GUID" : "по названию"}</span>` : ""}${!a.mapping[g.guid] && g.suggest && g.suggest.length ? `<div class="hc-suggest hc-small">Похоже: ${g.suggest.map((x) => `<button type="button" class="hc-link" data-pick="${esc(g.guid)}" data-obj="${x.id}" title="Сходство ${Math.round(x.score * 100)}%">${esc(x.name)}</button>`).join(" · ")}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="hc-bar"><button type="button" class="hc-btn" id="hc-his-dry" ${a.busy ? "disabled" : ""}>Проверить загрузку без записи</button><button type="button" class="hc-btn primary" id="hc-his-go" ${a.busy || !mapped ? "disabled" : ""}>Загрузить</button></div>`;
    box.querySelectorAll("[data-guid]").forEach((s) => s.addEventListener("change", () => {
      a.mapping[s.dataset.guid] = s.value ? Number(s.value) : null;
      const used = new Map(); let dup = false;
      for (const [g, o] of Object.entries(a.mapping)) if (o) { if (used.has(o)) dup = true; used.set(o, g); }
      const n = Object.values(a.mapping).filter(Boolean).length;
      pane.querySelector("#hc-mapped").textContent = n; pane.querySelector("#hc-unmapped").textContent = an.objects.length - n;
      s.setCustomValidity(dup ? "Один объект выбран для двух GUID" : ""); if (dup) s.reportValidity();
      s.closest("tr").classList.toggle("unmapped", !a.mapping[s.dataset.guid]);
    }));
    box.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
      const sel = box.querySelector(`select[data-guid="${b.dataset.pick}"]`);
      sel.value = b.dataset.obj; sel.dispatchEvent(new Event("change", { bubbles: true }));   // выбор человека, как если бы он выбрал сам
      b.closest(".hc-suggest")?.remove();
    }));
    box.querySelector("#hc-only-un")?.addEventListener("change", (e) => { a.onlyUnmapped = e.target.checked; paintAnalysis(); });
    const run = async (dry) => {
      a.busy = true; a.error = ""; paintAdmin();
      try {
        const fd = new FormData(); fd.append("file", a.file); fd.append("mapping", JSON.stringify(a.mapping)); fd.append("dry_run", dry ? "true" : "false");
        const r = await ctx.upload("/headcount/import/apply", fd);
        a.result = `${dry ? "Проверка, ничего не записано — получилось бы: " : "Загружено: "}записей создано ${r.records_created}, обновлено ${r.records_updated}, без изменений ${r.records_unchanged}, оставлено как внесено в системе ${r.kept_form_records}; строк истории ${r.history_rows}; новых подрядчиков ${r.contractors_created}${r.counterparties_created ? `, из них заведено новых контрагентов в общем справочнике: ${r.counterparties_created}` : ""}${Object.keys(r.skipped).length ? "; пропущено: " + Object.entries(r.skipped).map(([x, n]) => `${x} — ${n}`).join(", ") : ""}.`;
        if (!dry) { st.day = null; st.contractors = null; st.facets = null; loadRefs(); }
      } catch (e) { a.error = errText(e); }
      a.busy = false; paintAdmin();
    };
    box.querySelector("#hc-his-dry").addEventListener("click", () => run(true));
    box.querySelector("#hc-his-go").addEventListener("click", async () => {
      if (await ctx.confirm(`Загрузить численность из файла (объектов: ${mapped}) в систему?\n\nПеред загрузкой проверьте результат кнопкой «Проверить загрузку без записи».`)) run(false);
    });
  }

  const onCounterpartySaved = () => { if (!dead && st.contractors !== null) reloadContractors(); };
  document.addEventListener("zhbi:counterparty-saved", onCounterpartySaved);
  loadRefs();
  return {
    hasUnsavedChanges: () => hasChanges(),
    destroy() { dead = true; document.removeEventListener("zhbi:counterparty-saved", onCounterpartySaved); st.expressView?.destroy(); el.innerHTML = ""; el.classList.remove("hc-root"); },
  };
}

// Выбор вида работ из кодификатора: поле поиска по коду и названию + список совпадений (593 строки — обычный select неудобен).
// Таблица со сворачиваемыми группами и поиском по колонкам (общая для всплывающей формы выбора и для вкладки «Виды работ»).
// cfg: items; columns [{key, title, text(item) — по чему искать, html(item) — как показать, filter — есть ли поле поиска, cls}];
// group(item) — необязательный заголовок группы (элементы одной группы идут подряд; по умолчанию группы свёрнуты);
// onPick(item) — по щелчку на строке; selectedId — выделенная строка; rowClass(item).
function pickTable(host, cfg) {
  const cols = cfg.columns, filters = {}, open = new Set();
  const byId = new Map(cfg.items.map((x) => [x.id, x]));
  const ancestors = (x) => { const a = []; let q = byId.get(x.parent_id); while (q) { a.push(q); q = byId.get(q.parent_id); } return a; };
  if (cfg.tree && cfg.selectedId != null) { const sel = byId.get(cfg.selectedId); if (sel) ancestors(sel).forEach((a) => open.add(a.id)); }   // путь к выбранной позиции раскрыт
  if (cfg.selectedId != null && cfg.group) { const sel = cfg.items.find((x) => x.id === cfg.selectedId); if (sel) open.add(cfg.group(sel)); }   // группа выбранной позиции раскрыта
  host.innerHTML = `<div class="hc-pt-bar">${cfg.group || cfg.tree ? `<button type="button" class="hc-btn mini" data-act="open">Развернуть все</button><button type="button" class="hc-btn mini" data-act="close">Свернуть все</button>` : ""}<span class="hc-muted hc-small" data-role="count"></span></div>
    <div class="hc-scroll hc-pt-scroll"><table class="hc-tbl hc-pt"><thead><tr>${cols.map((c) => `<th class="${c.cls || ""}">${esc(c.title)}</th>`).join("")}</tr>
      <tr class="hc-pt-filters">${cols.map((c) => `<th>${c.filter ? `<input type="text" data-f="${c.key}" placeholder="Поиск" autocomplete="off" aria-label="Поиск по колонке «${esc(c.title)}»">` : ""}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`;
  const body = host.querySelector("tbody"), count = host.querySelector('[data-role="count"]');
  const norm = (v) => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
  const active = () => Object.values(filters).some((v) => norm(v));
  const treeRender = () => {
    const list = cfg.items.filter((x) => cols.every((c) => !c.filter || !norm(filters[c.key]) || norm(c.text(x)).includes(norm(filters[c.key]))));
    const searching = active();
    let visible;
    if (searching) { const keep = new Set(); for (const x of list) { keep.add(x.id); ancestors(x).forEach((a) => keep.add(a.id)); } visible = cfg.items.filter((x) => keep.has(x.id)); }   // найденное и путь к нему
    else visible = cfg.items.filter((x) => ancestors(x).every((a) => open.has(a.id)));
    const hit = new Set(list.map((x) => x.id));
    body.innerHTML = visible.map((x) => {
      const isOpen = searching || open.has(x.id);
      const cells = cols.map((c) => {
        const inner = c.html(x);
        if (c.key !== cfg.treeColumn) return `<td class="${c.cls || ""}">${inner}</td>`;
        const caret = x.has_children ? `<button type="button" class="hc-tree-btn" data-tg="${x.id}" aria-expanded="${isOpen}" aria-label="${isOpen ? "Свернуть" : "Развернуть"}">${isOpen ? "▾" : "▸"}</button>` : `<span class="hc-tree-gap"></span>`;
        return `<td class="${c.cls || ""}"><span class="hc-tree-cell" style="padding-left:${(x.level - 1) * 22}px">${caret}<span>${inner}</span></span></td>`;
      }).join("");
      return `<tr class="hc-pt-row l${Math.min(x.level, 4)} ${cfg.onPick ? "pick" : ""} ${x.id === cfg.selectedId ? "sel" : ""} ${searching && !hit.has(x.id) ? "ctx" : ""} ${cfg.rowClass ? cfg.rowClass(x) : ""}" data-id="${x.id}" data-level="${x.level}" tabindex="0">${cells}</tr>`;
    }).join("") || `<tr><td colspan="${cols.length}" class="hc-muted">Ничего не найдено.</td></tr>`;
    const levels = Math.max(0, ...cfg.items.map((x) => x.level || 1));
    count.textContent = `Показано: ${list.length.toLocaleString("ru-RU")} из ${cfg.items.length.toLocaleString("ru-RU")}, уровней: ${levels}`;
    host._visible = list;
  };
  const render = () => {
    if (cfg.tree) { treeRender(); return; }
    const list = cfg.items.filter((x) => cols.every((c) => !c.filter || !norm(filters[c.key]) || norm(c.text(x)).includes(norm(filters[c.key]))));
    const groups = new Map();
    for (const x of list) { const g = cfg.group ? cfg.group(x) : ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
    const forced = active();   // идёт поиск — группы с совпадениями раскрыты
    body.innerHTML = [...groups].map(([g, rows]) => {
      const isOpen = !cfg.group || forced || open.has(g);
      const head = cfg.group ? `<tr class="hc-pt-grp" data-g="${esc(g)}" tabindex="0" aria-expanded="${isOpen}"><td colspan="${cols.length}"><span class="hc-pt-caret">${isOpen ? "▾" : "▸"}</span> ${esc(g)} <span class="hc-muted hc-small">(${rows.length})</span></td></tr>` : "";
      const items = isOpen ? rows.map((x) => `<tr class="hc-pt-row ${cfg.onPick ? "pick" : ""} ${x.id === cfg.selectedId ? "sel" : ""} ${cfg.rowClass ? cfg.rowClass(x) : ""}" data-id="${x.id}" ${cfg.onPick ? 'tabindex="0"' : ""}>${cols.map((c) => `<td class="${c.cls || ""}">${c.html(x)}</td>`).join("")}</tr>`).join("") : "";
      return head + items;
    }).join("") || `<tr><td colspan="${cols.length}" class="hc-muted">Ничего не найдено.</td></tr>`;
    count.textContent = `Показано: ${list.length.toLocaleString("ru-RU")} из ${cfg.items.length.toLocaleString("ru-RU")}${cfg.group ? `, групп: ${groups.size}` : ""}`;
    host._visible = list;
  };
  host.addEventListener("input", (e) => { const f = e.target.closest("[data-f]"); if (f) { filters[f.dataset.f] = f.value; render(); } });
  host.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "open") cfg.items.forEach((x) => { if (cfg.tree) { if (x.has_children) open.add(x.id); } else open.add(cfg.group(x)); }); else open.clear();
      render(); return;
    }
    const tg = e.target.closest("[data-tg]");
    if (tg) { const id = Number(tg.dataset.tg); if (open.has(id)) open.delete(id); else open.add(id); render(); return; }
    const grp = e.target.closest(".hc-pt-grp");
    if (grp) { const g = grp.dataset.g; if (open.has(g)) open.delete(g); else open.add(g); render(); return; }
    const row = e.target.closest(".hc-pt-row");
    if (!row) return;
    const item = byId.get(Number(row.dataset.id));
    if (cfg.onPick) cfg.onPick(item);
    else if (cfg.tree && item?.has_children) { if (open.has(item.id)) open.delete(item.id); else open.add(item.id); render(); }   // без выбора щелчок по строке сворачивает/разворачивает
  });
  host.addEventListener("keydown", (e) => {
    const t = e.target;
    if ((e.key === "Enter" || e.key === " ") && t.matches?.(".hc-pt-grp, .hc-pt-row")) { e.preventDefault(); t.click(); return; }
    if (e.key === "Enter" && t.matches?.("[data-f]") && cfg.onPick && host._visible?.length) { e.preventDefault(); cfg.onPick(host._visible[0]); }   // Enter в поиске — первая найденная
  });
  render();
  return { focus: () => host.querySelector("[data-f]")?.focus() };
}

// Всплывающее окно поверх страницы. Окон может быть несколько (форма правки строки → выбор подрядчика), Esc закрывает только верхнее.
// Закрывается Esc, «Отмена»/«✕», щелчком вне окна. cfg: title, hint, footHtml (кнопки слева от «Отмена»), narrow.
const dlgStack = [];
function openDialog(cfg) {
  const opener = document.activeElement;
  const back = document.createElement("div");
  back.className = "hc-dlg-back hc-root";
  back.innerHTML = `<div class="hc-dlg ${cfg.narrow ? "narrow" : ""}" role="dialog" aria-modal="true" aria-label="${esc(cfg.title)}">
    <div class="hc-dlg-head"><h3>${esc(cfg.title)}</h3><button type="button" class="hc-btn mini" data-close aria-label="Закрыть">✕</button></div>
    ${cfg.hint ? `<p class="hc-muted hc-small hc-dlg-hint">${esc(cfg.hint)}</p>` : ""}
    <div class="hc-dlg-body"></div>
    <div class="hc-dlg-foot">${cfg.footHtml || ""}<span class="hc-spacer"></span><button type="button" class="hc-btn" data-close>Отмена</button></div></div>`;
  document.body.appendChild(back);
  const api = { back, body: back.querySelector(".hc-dlg-body"), foot: back.querySelector(".hc-dlg-foot"), close };
  function close() {
    const i = dlgStack.indexOf(api); if (i >= 0) dlgStack.splice(i, 1);
    document.removeEventListener("keydown", onKey, true); back.remove();
    try { opener?.focus?.(); } catch (e) { /* фокус не обязателен */ }
  }
  function onKey(e) { if (e.key === "Escape" && dlgStack[dlgStack.length - 1] === api) { e.stopPropagation(); e.preventDefault(); close(); } }
  dlgStack.push(api);
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("mousedown", (e) => { if (e.target === back && dlgStack[dlgStack.length - 1] === api) close(); });
  back.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  return api;
}

// Всплывающая форма выбора: таблица (pickTable) в окне поверх страницы; выбор — щелчком по строке.
function openPickDialog(cfg) {
  const dlg = openDialog({ ...cfg, footHtml: cfg.onClear && cfg.selectedId != null ? `<button type="button" class="hc-btn" data-clear>Очистить выбор</button>` : "" });
  dlg.foot.addEventListener("click", (e) => { if (e.target.closest("[data-clear]")) { cfg.onClear(); dlg.close(); } });
  const table = pickTable(dlg.body, { ...cfg, onPick: (item) => { cfg.onPick(item); dlg.close(); } });
  table.focus();
  return dlg;
}

// Поле выбора: показывает выбранное значение (длинное название переносится на следующую строку, а не обрезается), кнопка «Выбрать…» и щелчок
// по полю открывают всплывающую форму со справочником; «✕» сбрасывает выбор.
function pickField(box, items, cfg) {
  let chosen = null;
  box.innerHTML = `<div class="hc-pickbox"><div class="hc-pick-inwrap"><div class="hc-pick-in hc-pick-show" tabindex="0" role="button" aria-haspopup="dialog"><span class="hc-pick-ph">${esc(cfg.placeholder)}</span></div>
    <button type="button" class="hc-pick-x" title="Сбросить выбор" aria-label="Сбросить выбор" hidden>✕</button></div><button type="button" class="hc-btn hc-pick-open">Выбрать…</button></div>`;
  const input = box.querySelector(".hc-pick-show"), xBtn = box.querySelector(".hc-pick-x"), openBtn = box.querySelector(".hc-pick-open");
  const find = (id) => items.find((x) => x.id === id);
  const paintValue = () => { const x = chosen && find(chosen); input.innerHTML = x ? esc(cfg.label(x)) : `<span class="hc-pick-ph">${esc(cfg.placeholder)}</span>`; xBtn.hidden = !chosen; };
  const emit = () => box.dispatchEvent(new Event("change", { bubbles: true }));
  const open = () => openPickDialog({
    ...cfg, items, selectedId: chosen,
    onPick: (item) => { chosen = item.id; paintValue(); emit(); },
    onClear: () => { chosen = null; paintValue(); emit(); },
  });
  input.addEventListener("click", open);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); } });
  openBtn.addEventListener("click", open);
  xBtn.addEventListener("click", () => { chosen = null; paintValue(); emit(); });
  return { value: () => chosen, clear: () => { chosen = null; paintValue(); },
    set: (id) => { if (find(id)) { chosen = id; paintValue(); } } };
}

// Настройки форм выбора. Вид работ: сначала «Вид работ» (с отступом по уровню дерева), затем «Код». Подрядчик: наименование, ИНН, контрагент.
const WORK_CFG = {
  placeholder: "Вид работ не выбран", title: "Выбор вида работ из справочника",
  hint: "Справочник — дерево до последнего уровня (разделы свёрнуты): стрелка раскрывает ветку, щелчок по строке выбирает позицию любого уровня. Поиск — по названию и по коду отдельно.",
  label: (w) => `${w.code} ${w.name}`, tree: true, treeColumn: "name",
  columns: [
    { key: "name", title: "Вид работ", filter: true, text: (w) => w.name, html: (w) => esc(w.name) },
    { key: "code", title: "Код", filter: true, cls: "nw", text: (w) => w.code, html: (w) => `<span class="hc-code">${esc(w.code)}</span>` },
    { key: "unit", title: "Ед.", cls: "nw", text: (w) => w.unit || "", html: (w) => esc(w.unit || "") },
  ],
};
// Подрядчику назначаются только виды работ ПЕРВОГО уровня (разделы кодификатора, решение 2026-10-27): ветвей нет, список плоский
const WORK_CFG_L1 = { ...WORK_CFG, title: "Выбор вида работ (первый уровень)", hint: "Подрядчику назначаются виды работ первого уровня кодификатора (разделы). Поиск — по названию и по коду отдельно." };
const CTR_CFG = {
  placeholder: "Подрядчик не выбран", title: "Выбор подрядчика", hint: "Подрядчики объекта — контрагенты общего справочника. Поиск — в полях под заголовками колонок (название, ИНН). Щёлкните строку, чтобы выбрать.",
  label: (c) => c.display,
  columns: [
    { key: "name", title: "Наименование", filter: true, text: (c) => c.name || "", html: (c) => esc(c.name || "—") },
    { key: "inn", title: "ИНН", filter: true, cls: "nw", text: (c) => c.inn || "", html: (c) => `${c.inn ? esc(c.inn) : '<span class="hc-muted">нет</span>'}${c.inn_note ? ` <span class="hc-badge warn">${esc(c.inn_note)}</span>` : ""}` },
  ],
};
const workPicker = (box, works) => pickField(box, works, WORK_CFG);
// Как на вкладке «Подрядчики»: плоский список видов работ первого уровня (2026-10-28)
const workPickerL1 = (box, works) => pickField(box, works.filter((w) => w.level === 1 && !w.retired_at).map((w) => ({ ...w, parent_id: null, has_children: false })), WORK_CFG_L1);
const contractorPicker = (box, contractors) => pickField(box, contractors, CTR_CFG);
