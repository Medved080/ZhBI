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
// «Рабочие» и «ИТР» — целые от 0 до 100 000, вместе не меньше 1 («Итого» = их сумма, на сервере не хранится)
const HC_MAX = 100000;
const isCount = (v) => /^\d+$/.test(String(v).trim()) && Number(v) <= HC_MAX;
const pairProblem = (w, i) => (!isCount(w) || !isCount(i) ? `Рабочие и ИТР — целые числа от 0 до ${HC_MAX.toLocaleString("ru-RU")}`
  : Number(w) + Number(i) < 1 ? "Рабочие и ИТР вместе — не меньше 1" : "");
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
    contractorForm: null, facets: null,
    rep: { preset: "objects", obj: null, staff: "total", bySmu: false, asOf: "", asOfUser: false, from: "", to: "", data: null, loading: false, error: "", toggled: new Set() },
    data: { mode: "records", obj: null, from: "", to: "", contractor: "", workId: null, source: "", late: false, offset: 0, limit: 100, res: null, loading: false, error: "" },
    adm: { codResult: "", analysis: null, mapping: {}, result: "", busy: false, error: "" },
  };
  const tabs = [["input", "Ввод численности"], ["contractors", "Подрядчики"], ["report", "Отчёт"], ["data", "Все данные"], ["codifier", "Виды работ"]];
  if (ctx.canAdmin) tabs.push(["admin", "Загрузка данных"]);

  el.classList.add("hc-root");
  el.innerHTML = `<div class="hc-tabs" role="tablist" aria-label="Разделы учёта численности">${tabs.map(([k, t]) =>
    `<button type="button" role="tab" class="hc-tab" data-tab="${k}">${esc(t)}</button>`).join("")}</div><div class="hc-pane" id="hc-pane"></div>`;
  const pane = el.querySelector("#hc-pane");
  el.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { st.tab = b.dataset.tab; paint(); }));

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
    if (st.tab !== "admin" && (st.contractors === null || st.works === null)) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    if ((st.tab === "report" || st.tab === "data") && !st.facets) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; loadFacets().then(() => !dead && paint()); return; }
    ({ input: paintInput, contractors: paintContractors, report: paintReport, data: paintData, codifier: paintCodifier, admin: paintAdmin })[st.tab]();
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
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Подрядчик</th><th>Вид работ</th><th class="num">Рабочие</th><th class="num">ИТР</th><th class="num">Итого</th><th>Внесено</th><th></th></tr></thead><tbody id="hc-rows"></tbody>
        <tfoot><tr><td colspan="2">Всего за день</td><td class="num" id="hc-total-w"></td><td class="num" id="hc-total-i"></td><td class="num" id="hc-total"></td><td colspan="2"></td></tr></tfoot></table></div>
      ${ctx.canWrite && !future ? `<div class="hc-add" id="hc-add"></div>
        <div class="hc-bar"><button type="button" class="hc-btn primary" id="hc-save">Сохранить</button><button type="button" class="hc-btn" id="hc-copy" title="Добавить в карточку строки предыдущего дня, которых за этот день ещё нет">Заполнить как за предыдущий день</button><span class="hc-muted" id="hc-dirty"></span></div>` : (ctx.canWrite ? "" : `<p class="hc-muted">Только просмотр: у вас нет права вносить численность на этом объекте.</p>`)}
      <div id="hc-history"></div>`;
    pane.querySelector("#hc-prev").addEventListener("click", () => gotoDay(addDays(st.date, -1)));
    pane.querySelector("#hc-next").addEventListener("click", () => gotoDay(addDays(st.date, 1)));
    pane.querySelector("#hc-date").addEventListener("change", (e) => e.target.value && gotoDay(e.target.value));
    pane.querySelector("#hc-lastday")?.addEventListener("click", () => gotoDay(d.last_date));
    paintRows();
    if (ctx.canWrite && !future) {
      paintAdd();
      pane.querySelector("#hc-save").addEventListener("click", save);
      pane.querySelector("#hc-copy").addEventListener("click", copyPrevious);
      paintDirty();
    }
    paintHistory();
  }

  async function gotoDay(iso) {
    if (hasChanges() && !(await ctx.confirm("Есть несохранённые строки. Перейти на другой день без сохранения?", { danger: true }))) { paintInput(); return; }
    st.date = iso; st.day = null; st.added = []; st.changed = new Map(); st.history = null; setMsg("");
    paint();
  }

  const contractorLabel = (id) => st.contractors.find((c) => c.id === id)?.display || "—";
  const workLabel = (id) => { const w = st.works.find((x) => x.id === id); return w ? `${w.code} ${w.name}` : "—"; };

  // Значения строки на экране: введённое человеком (до сохранения) или то, что в БД
  const rowVals = (r) => { const c = st.changed.get(r.id); return c ? { w: c.workers, i: c.itr } : { w: String(r.workers), i: String(r.itr ?? 0) }; };
  const numOf = (v) => (isCount(v) ? Number(v) : 0);

  function paintRows() {
    const rows = st.day?.rows || [];
    const body = pane.querySelector("#hc-rows");
    const flags = (r) => [
      r.late ? `<span class="hc-badge bad" title="Первое внесение позже срока">просрочено${r.overdue_minutes ? " на " + fmtOverdue(r.overdue_minutes) : ""}</span>` : "",
      r.inn_status === "unverified" ? `<span class="hc-badge warn">ИНН не проверен</span>` : "",
      r.source === "import" ? `<span class="hc-badge">из SharePoint</span>` : "",
    ].join(" ");
    const field = (r, f, v) => ctx.canWrite
      ? `<input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-edit="${r.id}" data-f="${f}" value="${esc(v)}" aria-label="${f === "workers" ? "Рабочие" : "ИТР"}: ${esc(r.contractor)}, ${esc(r.work_name)}">`
      : esc(v);
    body.innerHTML = rows.length || st.added.length ? [
      ...rows.map((r) => { const v = rowVals(r); return `<tr data-id="${r.id}" class="${st.changed.has(r.id) ? "dirty" : ""}"><td>${esc(r.contractor)}</td><td><span class="hc-code">${esc(r.work_code)}</span> ${esc(r.work_name)}</td>
        <td class="num">${field(r, "workers", v.w)}</td><td class="num">${field(r, "itr", v.i)}</td><td class="num"><strong data-rowtotal="${r.id}">${numOf(v.w) + numOf(v.i)}</strong></td>
        <td class="hc-small">${esc(fmtMoment(r.entered_at))}${r.entered_by ? " · " + esc(r.entered_by) : ""} ${flags(r)}${r.changes ? ` <button type="button" class="hc-link" data-hist="${r.id}">правок: ${r.changes}</button>` : ` <button type="button" class="hc-link" data-hist="${r.id}">история</button>`}</td>
        <td class="nw">${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-edit-row="saved:${r.id}" title="Изменить строку" aria-label="Изменить строку">✎</button> <button type="button" class="hc-btn danger mini" data-del="${r.id}" title="Удалить строку" aria-label="Удалить строку">✕</button>` : ""}</td></tr>`; }),
      ...st.added.map((a, i) => `<tr class="added"><td>${esc(contractorLabel(a.contractor_id))}</td><td>${esc(workLabel(a.codifier_id))}</td><td class="num"><input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-add-edit="${i}" data-f="workers" value="${esc(a.workers)}" aria-label="Рабочие (строка ещё не сохранена)"></td><td class="num"><input type="number" min="0" max="${HC_MAX}" step="1" class="hc-num" data-add-edit="${i}" data-f="itr" value="${esc(a.itr)}" aria-label="ИТР (строка ещё не сохранена)"></td><td class="num"><strong data-add-total="${i}">${a.workers + a.itr}</strong></td><td class="hc-small"><span class="hc-badge">не сохранено</span></td>
        <td class="nw"><button type="button" class="hc-btn mini" data-edit-row="added:${i}" title="Изменить строку" aria-label="Изменить строку">✎</button> <button type="button" class="hc-btn mini" data-unadd="${i}" title="Убрать строку из карточки" aria-label="Убрать строку из карточки">✕</button></td></tr>`),
    ].join("") : `<tr><td colspan="7" class="hc-muted">За этот день численность не внесена.</td></tr>`;
    paintTotals();
    body.querySelectorAll("[data-edit]").forEach((i) => i.addEventListener("input", () => {
      const id = Number(i.dataset.edit), row = rows.find((r) => r.id === id), tr = i.closest("tr");
      const w = tr.querySelector('[data-f="workers"]').value, it = tr.querySelector('[data-f="itr"]').value;
      if (w === String(row.workers) && it === String(row.itr ?? 0)) st.changed.delete(id); else st.changed.set(id, { workers: w, itr: it });
      tr.classList.toggle("dirty", st.changed.has(id));
      tr.querySelector("[data-rowtotal]").textContent = numOf(w) + numOf(it);
      paintTotals(); paintDirty();
    }));
    body.querySelectorAll("[data-add-edit]").forEach((i) => i.addEventListener("input", () => {   // числа добавленной (ещё не сохранённой) строки правятся прямо в таблице
      const idx = Number(i.dataset.addEdit), tr = i.closest("tr"), a = st.added[idx];
      const w = tr.querySelector('[data-f="workers"]').value, it = tr.querySelector('[data-f="itr"]').value;
      if (isCount(w) && isCount(it)) { a.workers = Number(w); a.itr = Number(it); }
      tr.querySelector("[data-add-total]").textContent = numOf(w) + numOf(it);
      i.classList.toggle("bad", !isCount(w) || !isCount(it));
      paintTotals(); paintDirty();
    }));
    body.querySelectorAll("[data-edit-row]").forEach((b) => b.addEventListener("click", () => { const [kind, ref] = b.dataset.editRow.split(":"); editRow(kind, Number(ref)); }));
    body.querySelectorAll("[data-unadd]").forEach((b) => b.addEventListener("click", () => { st.added.splice(Number(b.dataset.unadd), 1); paintRows(); paintDirty(); }));
    body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeRow(Number(b.dataset.del))));
    body.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => showHistory(rows.find((r) => r.id === Number(b.dataset.hist)))));
  }

  // Окно правки строки. Добавленная (ещё не сохранённая) строка: можно сменить подрядчика, вид работ и числа. Внесённая: числа (подрядчик и вид работ —
  // часть ключа записи, их не меняют: удалить строку и добавить новую).
  function editRow(kind, ref) {
    const isAdded = kind === "added", rec = isAdded ? null : st.day.rows.find((r) => r.id === ref), a = isAdded ? st.added[ref] : null;
    if (!isAdded && !rec) return;
    const init = isAdded ? { contractor_id: a.contractor_id, codifier_id: a.codifier_id, workers: String(a.workers), itr: String(a.itr) }
      : { contractor_id: rec.contractor_id, codifier_id: rec.codifier_id, workers: rowVals(rec).w, itr: rowVals(rec).i };
    const dlg = openDialog({ title: isAdded ? "Строка карточки (не сохранена)" : "Изменение численности", narrow: true,
      hint: isAdded ? "Измените любое поле и нажмите «Применить к карточке»; в базу строка попадёт после «Сохранить»." : "Подрядчика и вид работ у внесённой строки изменить нельзя — удалите строку и добавьте новую. Числа правятся и сохраняются кнопкой «Сохранить».",
      footHtml: `<button type="button" class="hc-btn primary" data-apply>${isAdded ? "Применить к карточке" : "Применить"}</button>` });
    dlg.body.innerHTML = `<div class="hc-form-grid">
      <label class="hc-span2">Подрядчик${isAdded ? `<div id="re-ctr"></div>` : `<input type="text" readonly value="${esc(contractorLabel(init.contractor_id))}">`}</label>
      <label class="hc-span2">Вид работ${isAdded ? `<div id="re-work"></div>` : `<input type="text" readonly value="${esc(workLabel(init.codifier_id))}">`}</label>
      <label>Рабочие<input type="number" min="0" max="${HC_MAX}" step="1" id="re-w" class="hc-num" value="${esc(init.workers)}"></label>
      <label>ИТР<input type="number" min="0" max="${HC_MAX}" step="1" id="re-i" class="hc-num" value="${esc(init.itr)}"></label>
      <label>Итого<input type="text" id="re-sum" class="hc-num hc-total-in" readonly tabindex="-1" value="${numOf(init.workers) + numOf(init.itr)}"></label></div>
      <p class="hc-msg bad" id="re-err" role="alert"></p>`;
    const q = (sel) => dlg.body.querySelector(sel);
    const ctrP = isAdded ? contractorPicker(q("#re-ctr"), st.contractors) : null, workP = isAdded ? workPicker(q("#re-work"), st.works) : null;
    if (isAdded) { ctrP.set(init.contractor_id); workP.set(init.codifier_id); }
    const upd = () => { q("#re-sum").value = numOf(q("#re-w").value) + numOf(q("#re-i").value); };
    q("#re-w").addEventListener("input", upd); q("#re-i").addEventListener("input", upd);
    const apply = () => {
      const w = q("#re-w").value.trim() === "" ? "0" : q("#re-w").value, it = q("#re-i").value.trim() === "" ? "0" : q("#re-i").value, err = q("#re-err");
      const problem = pairProblem(w, it);
      if (problem) { err.textContent = problem; return; }
      if (isAdded) {
        const contractor_id = ctrP.value(), codifier_id = workP.value();
        if (!contractor_id) { err.textContent = "Выберите подрядчика"; return; }
        if (!codifier_id) { err.textContent = "Выберите вид работ"; return; }
        const clash = (st.day?.rows || []).some((r) => r.contractor_id === contractor_id && r.codifier_id === codifier_id) || st.added.some((x, k) => k !== ref && x.contractor_id === contractor_id && x.codifier_id === codifier_id);
        if (clash) { err.textContent = "Карточка содержит дубликат численности, сохранение невозможно: по этому подрядчику и виду работ за день строка уже есть."; return; }
        st.added[ref] = { contractor_id, codifier_id, workers: Number(w), itr: Number(it) };
      } else if (w === String(rec.workers) && it === String(rec.itr ?? 0)) st.changed.delete(rec.id); else st.changed.set(rec.id, { workers: w, itr: it });
      dlg.close(); paintRows(); paintDirty();
    };
    dlg.foot.addEventListener("click", (e) => { if (e.target.closest("[data-apply]")) apply(); });
    dlg.body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input[type=number]")) { e.preventDefault(); apply(); } });
    (q("#re-w")).focus();
  }

  // Итоги дня под таблицей — с учётом ещё не сохранённых правок и добавленных строк
  function paintTotals() {
    const rows = st.day?.rows || [];
    const tw = rows.reduce((n, r) => n + numOf(rowVals(r).w), 0) + st.added.reduce((n, a) => n + a.workers, 0);
    const ti = rows.reduce((n, r) => n + numOf(rowVals(r).i), 0) + st.added.reduce((n, a) => n + a.itr, 0);
    const set = (id, v) => { const n = pane.querySelector(id); if (n) n.textContent = v || ""; };
    set("#hc-total-w", tw); set("#hc-total-i", ti); set("#hc-total", tw + ti);
  }

  function paintDirty() {
    const n = pane.querySelector("#hc-dirty"); if (!n) return;
    const problem = [...st.changed.values()].map((c) => pairProblem(c.workers, c.itr)).find(Boolean) || "";
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
      <label>Итого<input type="text" id="hc-a-sum" class="hc-num hc-total-in" value="0" readonly tabindex="-1" aria-label="Итого: рабочие плюс ИТР"></label>
      <button type="button" class="hc-btn" id="hc-a-go">Добавить в карточку</button></div><p class="hc-msg bad" id="hc-a-err" role="alert"></p>`;
    const picker = workPicker(box.querySelector("#hc-a-work"), st.works);
    const ctrPicker = contractorPicker(box.querySelector("#hc-a-ctr"), st.contractors);
    // подрядчик, с которым вносили последнюю строку, остаётся выбранным (за день вносят по несколько видов работ одного подрядчика)
    if (st.lastCtr && st.contractors.some((c) => c.id === st.lastCtr)) ctrPicker.set(st.lastCtr); else if (st.contractors.length === 1) ctrPicker.set(st.contractors[0].id);
    const err = box.querySelector("#hc-a-err");
    const wIn = box.querySelector("#hc-a-w"), iIn = box.querySelector("#hc-a-i"), sum = box.querySelector("#hc-a-sum");
    const val = (el) => (el.value.trim() === "" ? "0" : el.value);   // пустое поле — 0: вносят чаще что-то одно
    const upd = () => { sum.value = numOf(val(wIn)) + numOf(val(iIn)); };
    wIn.addEventListener("input", upd); iIn.addEventListener("input", upd);
    const add = () => {
      const contractor_id = ctrPicker.value(), codifier_id = picker.value();
      err.textContent = "";
      if (!contractor_id) { err.textContent = "Выберите подрядчика"; return; }
      if (!codifier_id) { err.textContent = "Выберите вид работ"; return; }
      const problem = pairProblem(val(wIn), val(iIn));
      if (problem) { err.textContent = problem; return; }
      if ((st.day?.rows || []).some((r) => r.contractor_id === contractor_id && r.codifier_id === codifier_id) || st.added.some((a) => a.contractor_id === contractor_id && a.codifier_id === codifier_id)) {
        err.textContent = "Карточка содержит дубликат численности, сохранение невозможно: по этому подрядчику и виду работ за день строка уже есть — измените её в таблице.";
        return;
      }
      st.lastCtr = contractor_id;
      st.added.push({ contractor_id, codifier_id, workers: Number(val(wIn)), itr: Number(val(iIn)) });
      wIn.value = ""; iIn.value = ""; upd(); picker.clear(); paintRows(); paintDirty();
    };
    box.querySelector("#hc-a-go").addEventListener("click", add);
    for (const el of [wIn, iIn]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  }

  async function save() {
    if (st.saving || !hasChanges()) return;
    const rows = [
      ...(st.day?.rows || []).filter((r) => st.changed.has(r.id)).map((r) => ({ contractor_id: r.contractor_id, codifier_id: r.codifier_id, workers: Number(st.changed.get(r.id).workers), itr: Number(st.changed.get(r.id).itr) })),
      ...st.added,
    ];
    st.saving = true; paintDirty(); setMsg("Сохранение…");
    try {
      const res = await api.put(`/objects/${ctx.objectId}/headcount/records`, { date: st.date, rows });
      st.day = res; st.added = []; st.changed = new Map(); st.history = null; st.facets = null;
      st.msg = `Сохранено: добавлено ${res.created}, изменено ${res.changed}${res.late ? ". Внесено позже срока — записи отмечены как просроченные." : "."}`; st.msgKind = res.late ? "warn" : "ok";
    } catch (e) { st.msg = errText(e); st.msgKind = "bad"; }   // введённое остаётся на месте
    st.saving = false;
    if (!dead && st.tab === "input") paintInput();
  }

  async function removeRow(id) {
    const r = st.day.rows.find((x) => x.id === id);
    if (!(await ctx.confirm(`Удалить строку?\n\n${r.contractor}\n${r.work_code} ${r.work_name}\nРабочие: ${r.workers}, ИТР: ${r.itr ?? 0}, итого: ${r.total ?? r.workers}\n\nЗначение останется в истории изменений.`, { danger: true }))) return;
    try { await api.delete(`/objects/${ctx.objectId}/headcount/records/${id}`); st.changed.delete(id); await loadDay(); setMsg("Строка удалена.", "ok"); }
    catch (e) { setMsg(errText(e), "bad"); }
  }

  async function copyPrevious() {
    try {
      const prev = await api.get(`/objects/${ctx.objectId}/headcount/day?date=${addDays(st.date, -1)}`);
      const have = new Set([...(st.day?.rows || []).map((r) => `${r.contractor_id}:${r.codifier_id}`), ...st.added.map((a) => `${a.contractor_id}:${a.codifier_id}`)]);
      const fresh = (prev.rows || []).filter((r) => !have.has(`${r.contractor_id}:${r.codifier_id}`));
      fresh.forEach((r) => st.added.push({ contractor_id: r.contractor_id, codifier_id: r.codifier_id, workers: r.workers, itr: r.itr ?? 0 }));
      paintRows(); paintDirty();
      setMsg(fresh.length ? `Добавлено строк из предыдущего дня: ${fresh.length}. Проверьте числа и сохраните.` : "За предыдущий день нечего добавить.", fresh.length ? "ok" : "");
    } catch (e) { setMsg(errText(e), "bad"); }
  }

  async function showHistory(row) {
    const box = pane.querySelector("#hc-history");
    box.innerHTML = `<p class="hc-muted">Загрузка истории…</p>`;
    try {
      const d = await api.get(`/objects/${ctx.objectId}/headcount/history?date_from=${row.date}&date_to=${row.date}&contractor_id=${row.contractor_id}&codifier_id=${row.codifier_id}`);
      box.innerHTML = `<h4>История: ${esc(row.contractor)} · ${esc(row.work_code)} · ${esc(fmtDate(row.date))}</h4><table class="hc-tbl"><thead><tr><th>Когда</th><th>Кто</th><th class="num">Рабочие было</th><th class="num">Рабочие стало</th><th class="num">ИТР было</th><th class="num">ИТР стало</th><th>Источник</th></tr></thead><tbody>${
        d.history.map((h) => `<tr><td>${esc(fmtMoment(h.changed_at))}</td><td>${esc(h.changed_by || "—")}</td><td class="num">${h.old ?? "—"}</td><td class="num">${h.new ?? "удалено"}</td><td class="num">${h.old_itr ?? "—"}</td><td class="num">${h.new_itr ?? (h.new == null ? "удалено" : "—")}</td><td>${h.source === "import" ? "загрузка из SharePoint" : h.source === "bot" ? "бот" : "форма"}</td></tr>`).join("")}</tbody></table>`;
      box.scrollIntoView({ block: "nearest" });
    } catch (e) { box.innerHTML = `<div class="hc-callout bad" role="alert">${esc(errText(e))}</div>`; }
  }
  const paintHistory = () => {};

  // =====================================================================  ПОДРЯДЧИКИ
  function paintContractors() {
    const f = st.contractorForm;
    pane.innerHTML = `
      <div class="hc-bar"><strong>Подрядчики объекта</strong><span class="hc-muted">пул, из которого выбирают при вводе численности</span>${ctx.canWrite ? `<button type="button" class="hc-btn primary" id="hc-c-new">Добавить подрядчика</button>` : ""}</div>
      ${f ? `<form class="hc-form" id="hc-c-form"><label>Название<input type="text" id="hc-c-name" value="${esc(f.name)}" maxlength="300"></label>
        <label>ИНН<input type="text" id="hc-c-inn" value="${esc(f.inn)}" maxlength="20" inputmode="numeric"></label>
        <button type="submit" class="hc-btn primary">${f.id ? "Сохранить" : "Добавить"}</button><button type="button" class="hc-btn" id="hc-c-cancel">Отмена</button>
        <p class="hc-msg ${esc(f.kind || "")}" id="hc-c-msg" role="alert">${esc(f.msg || "")}</p></form>` : ""}
      <p id="hc-msg" class="hc-msg ${esc(st.msgKind)}" role="status" aria-live="polite">${esc(st.msg)}</p>
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Подрядчик</th><th>ИНН</th><th>Контрагент в справочнике</th><th class="num">Записей</th><th></th></tr></thead><tbody>${
        st.contractors.length ? [...st.contractors].sort((a, b) => (a.display || "").localeCompare(b.display || "", "ru")).map((c) => `<tr><td>${esc(c.name || c.counterparty_name || "—")}</td>
          <td>${esc(c.inn || "—")} ${c.inn_note ? `<span class="hc-badge warn" title="В ИНН не 10 и не 12 цифр">${esc(c.inn_note)}</span>` : ""}</td>
          <td>${c.counterparty_id ? esc(c.counterparty_name || "") : `<span class="hc-muted">не связан${c.inn ? "" : " — укажите ИНН"}</span>`}</td><td class="num">${c.records}</td>
          <td>${ctx.canWrite ? `<button type="button" class="hc-btn mini" data-edit="${c.id}">Изменить</button> <button type="button" class="hc-btn danger mini" data-del="${c.id}">Удалить</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="5" class="hc-muted">Подрядчиков нет. Добавьте вручную или загрузите историю численности.</td></tr>`}</tbody></table></div>`;
    pane.querySelector("#hc-c-new")?.addEventListener("click", () => { st.contractorForm = { id: null, name: "", inn: "" }; paintContractors(); pane.querySelector("#hc-c-name")?.focus(); });
    pane.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const c = st.contractors.find((x) => x.id === Number(b.dataset.edit)); st.contractorForm = { id: c.id, name: c.name || "", inn: c.inn || "" }; paintContractors(); pane.querySelector("#hc-c-name")?.focus();
    }));
    pane.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => delContractor(Number(b.dataset.del))));
    pane.querySelector("#hc-c-cancel")?.addEventListener("click", () => { st.contractorForm = null; paintContractors(); });
    pane.querySelector("#hc-c-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = st.contractorForm, name = pane.querySelector("#hc-c-name").value, inn = pane.querySelector("#hc-c-inn").value;
      Object.assign(form, { name, inn });
      const note = pane.querySelector("#hc-c-msg");
      try {
        const body = { name: name || null, inn: inn || null };
        const r = form.id ? await api.patch(`/objects/${ctx.objectId}/headcount/contractors/${form.id}`, body) : await api.post(`/objects/${ctx.objectId}/headcount/contractors`, body);
        st.contractorForm = null; await reloadContractors(); setMsg(`Сохранено: ${r.display}${r.inn_note ? " — " + r.inn_note : ""}.`, r.inn_note ? "warn" : "ok");
      } catch (err) { form.msg = errText(err); form.kind = "bad"; if (note) { note.textContent = form.msg; note.className = "hc-msg bad"; } }
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
        <label>Показатель<select id="hc-r-staff" title="Итого — рабочие и ИТР вместе"><option value="total" ${r.staff === "total" ? "selected" : ""}>Итого</option><option value="workers" ${r.staff === "workers" ? "selected" : ""}>Рабочие</option><option value="itr" ${r.staff === "itr" ? "selected" : ""}>ИТР</option></select></label>
        <label>На день<input type="date" id="hc-r-asof" value="${esc(r.asOf)}" title="Пусто — последний день с данными"></label>
        <label>Период с<input type="date" id="hc-r-from" value="${esc(r.from)}"></label>
        <label>по<input type="date" id="hc-r-to" value="${esc(r.to)}"></label>
        <button type="button" class="hc-btn primary" id="hc-r-go">Обновить</button>
        ${ctx.download ? `<button type="button" class="hc-btn" id="hc-r-xlsx" title="Выгрузить отчёт в Excel">В Excel</button>` : ""}
      </div>
      <p class="hc-muted hc-small">Показатель «Итого» — рабочие и ИТР вместе; «Рабочие» и «ИТР» показывают одно слагаемое. Среднее — сумма человек-дней за окно, делённая на число дней окна, в которые в выборке есть данные. Плана и отклонений пока нет.</p>
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
      ${d.mode === "records" ? `<span class="hc-muted">человек-дней в выборке: итого <strong>${(r.sum_total ?? r.sum_workers).toLocaleString("ru-RU")}</strong> (рабочие ${r.sum_workers.toLocaleString("ru-RU")}, ИТР ${(r.sum_itr ?? 0).toLocaleString("ru-RU")})</span>` : ""}
      <button type="button" class="hc-btn mini" id="hc-d-prev" ${r.offset <= 0 ? "disabled" : ""}>◀ Назад</button><button type="button" class="hc-btn mini" id="hc-d-next" ${to >= r.total ? "disabled" : ""}>Вперёд ▶</button></div>`;
    const objCol = (name) => (all ? `<td>${esc(name)}</td>` : "");
    const rows = d.mode === "records" ? r.items.map((i) => `<tr><td class="nw">${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}${i.inn_status === "unverified" ? ` <span class="hc-badge warn">ИНН не проверен</span>` : ""}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.workers}</td><td class="num">${i.itr ?? 0}</td><td class="num"><strong>${i.total ?? i.workers}</strong></td>
        <td class="hc-small"><span class="nw">${esc(fmtMoment(i.entered_at))}</span>${i.entered_by ? " · " + esc(i.entered_by) : ""}<br>${i.late ? `<span class="hc-badge bad">просрочено${i.overdue_minutes ? " на " + fmtOverdue(i.overdue_minutes) : ""}</span> ` : ""}<span class="hc-badge">${esc(sourceText(i.source))}</span>${i.changes ? ` <span class="hc-badge" title="Последняя правка: ${esc(fmtMoment(i.updated_at))}${i.updated_by ? " · " + esc(i.updated_by) : ""}">правок: ${i.changes}</span>` : ""}</td></tr>`).join("")
      : r.items.map((i) => `<tr><td class="hc-small"><span class="nw">${esc(fmtMoment(i.changed_at))}</span><br>${esc(i.changed_by || "—")} <span class="hc-badge">${esc(sourceText(i.source))}</span></td><td class="nw">${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.old ?? "—"} → ${i.new ?? "удалено"}</td><td class="num">${i.old_itr ?? "—"} → ${i.new_itr ?? (i.new == null ? "удалено" : "—")}</td></tr>`).join("");
    const heads = d.mode === "records"
      ? ["День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Рабочие", "ИТР", "Итого", "Внесено (кто и когда)"]
      : ["Когда и кто изменил", "День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Рабочие: было → стало", "ИТР: было → стало"];
    box.innerHTML = `${head}<div class="hc-scroll"><table class="hc-tbl"><thead><tr>${heads.map((h) => `<th class="${["Рабочие", "ИТР", "Итого", "Рабочие: было → стало", "ИТР: было → стало"].includes(h) ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
        { key: "code", title: "Код", filter: true, cls: "nw", text: (w) => w.code, html: (w) => `<span class="hc-code">${esc(w.code)}</span>` },
        { key: "name", title: "Вид работ", filter: true, text: (w) => w.name, html: (w) => esc(w.name) },
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
        a.result = `${dry ? "Проверка, ничего не записано — получилось бы: " : "Загружено: "}записей создано ${r.records_created}, обновлено ${r.records_updated}, без изменений ${r.records_unchanged}, оставлено как внесено в системе ${r.kept_form_records}; строк истории ${r.history_rows}; новых подрядчиков ${r.contractors_created}${Object.keys(r.skipped).length ? "; пропущено: " + Object.entries(r.skipped).map(([x, n]) => `${x} — ${n}`).join(", ") : ""}.`;
        if (!dry) { st.day = null; st.contractors = null; st.facets = null; loadRefs(); }
      } catch (e) { a.error = errText(e); }
      a.busy = false; paintAdmin();
    };
    box.querySelector("#hc-his-dry").addEventListener("click", () => run(true));
    box.querySelector("#hc-his-go").addEventListener("click", async () => {
      if (await ctx.confirm(`Загрузить численность из файла (объектов: ${mapped}) в систему?\n\nПеред загрузкой проверьте результат кнопкой «Проверить загрузку без записи».`)) run(false);
    });
  }

  loadRefs();
  return {
    hasUnsavedChanges: () => hasChanges(),
    destroy() { dead = true; el.innerHTML = ""; el.classList.remove("hc-root"); },
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

// Поле выбора: показывает выбранное значение, кнопка «Выбрать…» (и щелчок по полю) открывает всплывающую форму со справочником.
function pickField(box, items, cfg) {
  let chosen = null;
  box.innerHTML = `<div class="hc-pickbox"><div class="hc-pick-inwrap"><input type="text" class="hc-pick-in" readonly placeholder="${esc(cfg.placeholder)}" aria-haspopup="dialog">
    <button type="button" class="hc-pick-x" title="Сбросить выбор" aria-label="Сбросить выбор" hidden>✕</button></div><button type="button" class="hc-btn hc-pick-open">Выбрать…</button></div>`;
  const input = box.querySelector("input"), xBtn = box.querySelector(".hc-pick-x"), openBtn = box.querySelector(".hc-pick-open");
  const find = (id) => items.find((x) => x.id === id);
  const show = () => { xBtn.hidden = !chosen; };
  const open = () => openPickDialog({
    title: cfg.title, hint: cfg.hint, items, columns: cfg.columns, group: cfg.group, tree: cfg.tree, treeColumn: cfg.treeColumn, selectedId: chosen,
    onPick: (item) => { chosen = item.id; input.value = cfg.label(item); show(); box.dispatchEvent(new Event("change", { bubbles: true })); },
    onClear: () => { chosen = null; input.value = ""; show(); box.dispatchEvent(new Event("change", { bubbles: true })); },
  });
  input.addEventListener("click", open);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); } });
  openBtn.addEventListener("click", open);
  xBtn.addEventListener("click", () => { chosen = null; input.value = ""; show(); box.dispatchEvent(new Event("change", { bubbles: true })); });
  return { value: () => chosen, clear: () => { chosen = null; input.value = ""; show(); },
    set: (id) => { const x = find(id); if (x) { chosen = id; input.value = cfg.label(x); show(); } } };
}

// Вид работ — из кодификатора; разделы свёрнуты, поиск отдельно по коду и по названию.
function workPicker(box, works) {
  return pickField(box, works, {
    placeholder: "Вид работ не выбран", title: "Выбор вида работ из справочника", hint: "Справочник — дерево до последнего уровня (разделы свёрнуты): стрелка раскрывает ветку, щелчок по строке выбирает позицию любого уровня. Поиск — по коду и по названию отдельно.",
    label: (w) => `${w.code} ${w.name}`, tree: true, treeColumn: "name",
    columns: [
      { key: "code", title: "Код", filter: true, cls: "nw", text: (w) => w.code, html: (w) => `<span class="hc-code">${esc(w.code)}</span>` },
      { key: "name", title: "Вид работ", filter: true, text: (w) => w.name, html: (w) => esc(w.name) },
      { key: "unit", title: "Ед.", cls: "nw", text: (w) => w.unit || "", html: (w) => esc(w.unit || "") },
    ],
  });
}

// Подрядчик объекта — таблица подрядчиков, поиск отдельно по названию, ИНН и контрагенту.
function contractorPicker(box, contractors) {
  return pickField(box, contractors, {
    placeholder: "Подрядчик не выбран", title: "Выбор подрядчика", hint: "Поиск — в полях под заголовками колонок (название, ИНН, контрагент). Щёлкните строку, чтобы выбрать.",
    label: (c) => c.display,
    columns: [
      { key: "name", title: "Наименование", filter: true, text: (c) => `${c.name || ""} ${c.counterparty_name || ""}`, html: (c) => esc(c.name || c.counterparty_name || "—") },
      { key: "inn", title: "ИНН", filter: true, cls: "nw", text: (c) => c.inn || "", html: (c) => `${c.inn ? esc(c.inn) : '<span class="hc-muted">нет</span>'}${c.inn_note ? ` <span class="hc-badge warn">${esc(c.inn_note)}</span>` : ""}` },
      { key: "cp", title: "Контрагент в справочнике", filter: true, text: (c) => c.counterparty_name || "", html: (c) => (c.counterparty_id ? esc(c.counterparty_name || "") : '<span class="hc-muted">не связан</span>') },
    ],
  });
}
