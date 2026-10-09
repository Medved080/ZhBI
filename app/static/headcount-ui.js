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
  { key: "objects", title: "По объектам", levels: ["smu", "object", "section", "work"] },
  { key: "contractors", title: "По подрядчикам", levels: ["contractor", "object", "work"] },
  { key: "works", title: "По работам", levels: ["section", "work", "contractor"] },
];
const LEVEL_TITLES = { smu: "Подразделение", object: "Объект", section: "Раздел", work: "Вид работ", contractor: "Подрядчик" };

export function mountHeadcount(el, ctx) {
  ensureCss();
  const { api } = ctx;
  let dead = false;
  const st = {
    tab: "input", works: null, contractors: null, loadError: "",
    date: todayIso(), day: null, dayError: "", added: [], changed: new Map(), saving: false, msg: "", msgKind: "", history: null,
    contractorForm: null,
    rep: { preset: "objects", scope: "object", asOf: "", asOfUser: false, from: "", to: "", data: null, loading: false, error: "", toggled: new Set() },
    data: { mode: "records", scope: "object", from: "", to: "", contractor: "", workId: null, source: "", late: false, offset: 0, limit: 100, res: null, loading: false, error: "" },
    adm: { codResult: "", analysis: null, mapping: {}, result: "", busy: false, error: "" },
  };
  const tabs = [["input", "Ввод численности"], ["contractors", "Подрядчики"], ["report", "Отчёт"], ["data", "Все данные"]];
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

  function paint() {
    if (dead) return;
    el.querySelectorAll("[data-tab]").forEach((b) => { const on = b.dataset.tab === st.tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    if (st.loadError) { pane.innerHTML = `<div class="hc-callout bad" role="alert"><strong>Не удалось загрузить данные.</strong> ${esc(st.loadError)} <button type="button" class="hc-btn" id="hc-retry">Повторить</button></div>`; pane.querySelector("#hc-retry").addEventListener("click", () => { st.loadError = ""; loadRefs(); }); return; }
    if (st.tab !== "admin" && (st.contractors === null || st.works === null)) { pane.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    ({ input: paintInput, contractors: paintContractors, report: paintReport, data: paintData, admin: paintAdmin })[st.tab]();
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
      <div class="hc-scroll"><table class="hc-tbl"><thead><tr><th>Подрядчик</th><th>Вид работ</th><th class="num">Человек</th><th>Внесено</th><th></th></tr></thead><tbody id="hc-rows"></tbody>
        <tfoot><tr><td colspan="2">Всего за день</td><td class="num" id="hc-total"></td><td colspan="2"></td></tr></tfoot></table></div>
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

  function paintRows() {
    const rows = st.day?.rows || [];
    const body = pane.querySelector("#hc-rows");
    const flags = (r) => [
      r.late ? `<span class="hc-badge bad" title="Первое внесение позже срока">просрочено${r.overdue_minutes ? " на " + fmtOverdue(r.overdue_minutes) : ""}</span>` : "",
      r.inn_status === "unverified" ? `<span class="hc-badge warn">ИНН не проверен</span>` : "",
      r.source === "import" ? `<span class="hc-badge">из SharePoint</span>` : "",
    ].join(" ");
    body.innerHTML = rows.length || st.added.length ? [
      ...rows.map((r) => `<tr data-id="${r.id}" class="${st.changed.has(r.id) ? "dirty" : ""}"><td>${esc(r.contractor)}</td><td><span class="hc-code">${esc(r.work_code)}</span> ${esc(r.work_name)}</td>
        <td class="num">${ctx.canWrite ? `<input type="number" min="1" max="100000" step="1" class="hc-num" data-edit="${r.id}" value="${st.changed.has(r.id) ? esc(st.changed.get(r.id)) : r.workers}" aria-label="Человек: ${esc(r.contractor)}, ${esc(r.work_name)}">` : r.workers}</td>
        <td class="hc-small">${esc(fmtMoment(r.entered_at))}${r.entered_by ? " · " + esc(r.entered_by) : ""} ${flags(r)}${r.changes ? ` <button type="button" class="hc-link" data-hist="${r.id}">правок: ${r.changes}</button>` : ` <button type="button" class="hc-link" data-hist="${r.id}">история</button>`}</td>
        <td>${ctx.canWrite ? `<button type="button" class="hc-btn danger mini" data-del="${r.id}" aria-label="Удалить строку">✕</button>` : ""}</td></tr>`),
      ...st.added.map((a, i) => `<tr class="added"><td>${esc(contractorLabel(a.contractor_id))}</td><td>${esc(workLabel(a.codifier_id))}</td><td class="num">${esc(a.workers)}</td><td class="hc-small"><span class="hc-badge">не сохранено</span></td>
        <td><button type="button" class="hc-btn mini" data-unadd="${i}" aria-label="Убрать строку из карточки">✕</button></td></tr>`),
    ].join("") : `<tr><td colspan="5" class="hc-muted">За этот день численность не внесена.</td></tr>`;
    const total = rows.reduce((s, r) => s + (st.changed.has(r.id) ? Number(st.changed.get(r.id)) || 0 : r.workers), 0) + st.added.reduce((s, a) => s + a.workers, 0);
    pane.querySelector("#hc-total").textContent = total || "";
    body.querySelectorAll("[data-edit]").forEach((i) => i.addEventListener("input", () => {
      const id = Number(i.dataset.edit), row = rows.find((r) => r.id === id), v = i.value;
      if (String(row.workers) === v || v === "") st.changed.delete(id); else st.changed.set(id, v);
      i.closest("tr").classList.toggle("dirty", st.changed.has(id));
      paintDirty();
    }));
    body.querySelectorAll("[data-unadd]").forEach((b) => b.addEventListener("click", () => { st.added.splice(Number(b.dataset.unadd), 1); paintRows(); paintDirty(); }));
    body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeRow(Number(b.dataset.del))));
    body.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => showHistory(rows.find((r) => r.id === Number(b.dataset.hist)))));
  }

  function paintDirty() {
    const n = pane.querySelector("#hc-dirty"); if (!n) return;
    const bad = [...st.changed.values()].some((v) => !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100000));
    n.textContent = bad ? "Число рабочих — целое от 1 до 100 000" : hasChanges() ? `К сохранению: изменено ${st.changed.size}, добавлено ${st.added.length}` : "";
    n.className = `hc-muted ${bad ? "bad" : ""}`;
    const b = pane.querySelector("#hc-save"); if (b) b.disabled = st.saving || bad || !hasChanges();
  }

  // ---- строка добавления: подрядчик + вид работ + число ----
  function paintAdd() {
    const box = pane.querySelector("#hc-add");
    if (!st.contractors.length) { box.innerHTML = `<p class="hc-muted">Сначала добавьте подрядчиков объекта на вкладке «Подрядчики».</p>`; return; }
    box.innerHTML = `<div class="hc-addrow"><label>Подрядчик<select id="hc-a-ctr">${st.contractors.map((c) => `<option value="${c.id}">${esc(c.display)}</option>`).join("")}</select></label>
      <label class="hc-grow">Вид работ<div class="hc-picker" id="hc-a-work"></div></label>
      <label>Человек<input type="number" min="1" max="100000" step="1" id="hc-a-num" class="hc-num"></label>
      <button type="button" class="hc-btn" id="hc-a-go">Добавить в карточку</button></div><p class="hc-msg bad" id="hc-a-err" role="alert"></p>`;
    const picker = workPicker(box.querySelector("#hc-a-work"), st.works);
    const err = box.querySelector("#hc-a-err");
    const add = () => {
      const contractor_id = Number(box.querySelector("#hc-a-ctr").value), codifier_id = picker.value(), workers = Number(box.querySelector("#hc-a-num").value);
      err.textContent = "";
      if (!codifier_id) { err.textContent = "Выберите вид работ"; return; }
      if (!Number.isInteger(workers) || workers < 1 || workers > 100000) { err.textContent = "Число рабочих — целое от 1 до 100 000"; return; }
      if ((st.day?.rows || []).some((r) => r.contractor_id === contractor_id && r.codifier_id === codifier_id) || st.added.some((a) => a.contractor_id === contractor_id && a.codifier_id === codifier_id)) {
        err.textContent = "Карточка содержит дубликат численности, сохранение невозможно: по этому подрядчику и виду работ за день строка уже есть — измените число в ней."; return;
      }
      st.added.push({ contractor_id, codifier_id, workers });
      box.querySelector("#hc-a-num").value = ""; picker.clear(); paintRows(); paintDirty();
    };
    box.querySelector("#hc-a-go").addEventListener("click", add);
    box.querySelector("#hc-a-num").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  }

  async function save() {
    if (st.saving || !hasChanges()) return;
    const rows = [
      ...(st.day?.rows || []).filter((r) => st.changed.has(r.id)).map((r) => ({ contractor_id: r.contractor_id, codifier_id: r.codifier_id, workers: Number(st.changed.get(r.id)) })),
      ...st.added,
    ];
    st.saving = true; paintDirty(); setMsg("Сохранение…");
    try {
      const res = await api.put(`/objects/${ctx.objectId}/headcount/records`, { date: st.date, rows });
      st.day = res; st.added = []; st.changed = new Map(); st.history = null;
      st.msg = `Сохранено: добавлено ${res.created}, изменено ${res.changed}${res.late ? ". Внесено позже срока — записи отмечены как просроченные." : "."}`; st.msgKind = res.late ? "warn" : "ok";
    } catch (e) { st.msg = errText(e); st.msgKind = "bad"; }   // введённое остаётся на месте
    st.saving = false;
    if (!dead && st.tab === "input") paintInput();
  }

  async function removeRow(id) {
    const r = st.day.rows.find((x) => x.id === id);
    if (!(await ctx.confirm(`Удалить строку?\n\n${r.contractor}\n${r.work_code} ${r.work_name}\nЧеловек: ${r.workers}\n\nЗначение останется в истории изменений.`, { danger: true }))) return;
    try { await api.delete(`/objects/${ctx.objectId}/headcount/records/${id}`); st.changed.delete(id); await loadDay(); setMsg("Строка удалена.", "ok"); }
    catch (e) { setMsg(errText(e), "bad"); }
  }

  async function copyPrevious() {
    try {
      const prev = await api.get(`/objects/${ctx.objectId}/headcount/day?date=${addDays(st.date, -1)}`);
      const have = new Set([...(st.day?.rows || []).map((r) => `${r.contractor_id}:${r.codifier_id}`), ...st.added.map((a) => `${a.contractor_id}:${a.codifier_id}`)]);
      const fresh = (prev.rows || []).filter((r) => !have.has(`${r.contractor_id}:${r.codifier_id}`));
      fresh.forEach((r) => st.added.push({ contractor_id: r.contractor_id, codifier_id: r.codifier_id, workers: r.workers }));
      paintRows(); paintDirty();
      setMsg(fresh.length ? `Добавлено строк из предыдущего дня: ${fresh.length}. Проверьте числа и сохраните.` : "За предыдущий день нечего добавить.", fresh.length ? "ok" : "");
    } catch (e) { setMsg(errText(e), "bad"); }
  }

  async function showHistory(row) {
    const box = pane.querySelector("#hc-history");
    box.innerHTML = `<p class="hc-muted">Загрузка истории…</p>`;
    try {
      const d = await api.get(`/objects/${ctx.objectId}/headcount/history?date_from=${row.date}&date_to=${row.date}&contractor_id=${row.contractor_id}&codifier_id=${row.codifier_id}`);
      box.innerHTML = `<h4>История: ${esc(row.contractor)} · ${esc(row.work_code)} · ${esc(fmtDate(row.date))}</h4><table class="hc-tbl"><thead><tr><th>Когда</th><th>Кто</th><th class="num">Было</th><th class="num">Стало</th><th>Источник</th></tr></thead><tbody>${
        d.history.map((h) => `<tr><td>${esc(fmtMoment(h.changed_at))}</td><td>${esc(h.changed_by || "—")}</td><td class="num">${h.old ?? "—"}</td><td class="num">${h.new ?? "удалено"}</td><td>${h.source === "import" ? "загрузка из SharePoint" : h.source === "bot" ? "бот" : "форма"}</td></tr>`).join("")}</tbody></table>`;
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
      <div class="hc-bar hc-wrap">
        <div class="hc-seg" role="group" aria-label="Срез">${PRESETS.map((p) => `<button type="button" class="hc-btn ${r.preset === p.key ? "on" : ""}" data-preset="${p.key}">${esc(p.title)}</button>`).join("")}</div>
        <label>На день<input type="date" id="hc-r-asof" value="${esc(r.asOf)}" title="Пусто — последний день с данными"></label>
        <label>Период с<input type="date" id="hc-r-from" value="${esc(r.from)}"></label>
        <label>по<input type="date" id="hc-r-to" value="${esc(r.to)}"></label>
        <label>Объекты<select id="hc-r-scope"><option value="object" ${r.scope === "object" ? "selected" : ""}>Только этот объект</option><option value="all" ${r.scope === "all" ? "selected" : ""}>Все доступные мне</option></select></label>
        <button type="button" class="hc-btn" id="hc-r-go">Обновить</button>
        ${ctx.download ? `<button type="button" class="hc-btn" id="hc-r-xlsx">Выгрузить в Excel</button>` : ""}
      </div>
      <p class="hc-muted hc-small">Среднее — сумма человек-дней за окно, делённая на число дней окна, в которые в выборке есть данные. Плана и отклонений пока нет.</p>
      <div id="hc-r-body"></div>`;
    pane.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { r.preset = b.dataset.preset; r.toggled = new Set(); loadReport(); }));
    ["asof", "from", "to"].forEach((k) => pane.querySelector(`#hc-r-${k}`).addEventListener("change", (e) => { r[{ asof: "asOf", from: "from", to: "to" }[k]] = e.target.value; if (k === "asof") r.asOfUser = !!e.target.value; }));
    pane.querySelector("#hc-r-scope").addEventListener("change", (e) => { r.scope = e.target.value; loadReport(); });
    pane.querySelector("#hc-r-go").addEventListener("click", loadReport);
    pane.querySelector("#hc-r-xlsx")?.addEventListener("click", async () => {
      try { await ctx.download(`/headcount/report.xlsx?${reportQuery()}`, "Численность_отчёт.xlsx"); } catch (e) { r.error = errText(e); paintReportBody(); }
    });
    if (r.data || r.error || r.loading) paintReportBody(); else loadReport();
  }

  function reportQuery() {
    const r = st.rep, preset = PRESETS.find((p) => p.key === r.preset);
    const q = new URLSearchParams({ levels: preset.levels.join(",") });
    if (r.asOfUser && r.asOf) q.set("as_of", r.asOf);   // не задана человеком — сервер берёт последний день с данными
    if (r.from && r.to) { q.set("date_from", r.from); q.set("date_to", r.to); }
    if (r.scope === "object") q.set("object_ids", String(ctx.objectId));
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
      const leaf = n.children.size === 0, open = (n.depth < 1) !== r.toggled.has(n.path);   // по умолчанию раскрыт только верхний уровень
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
    if (d.scope === "object") q.set("object_ids", String(ctx.objectId));
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
    const d = st.data, all = d.scope === "all";
    pane.innerHTML = `
      <div class="hc-bar hc-wrap">
        <div class="hc-seg" role="group" aria-label="Что показывать"><button type="button" class="hc-btn ${d.mode === "records" ? "on" : ""}" data-mode="records">Записи</button><button type="button" class="hc-btn ${d.mode === "history" ? "on" : ""}" data-mode="history">История изменений</button></div>
        <label>Объекты<select id="hc-d-scope"><option value="object" ${!all ? "selected" : ""}>Только этот объект</option><option value="all" ${all ? "selected" : ""}>Все доступные мне</option></select></label>
        <label>День с<input type="date" id="hc-d-from" value="${esc(d.from)}"></label>
        <label>по<input type="date" id="hc-d-to" value="${esc(d.to)}"></label>
        <label>Подрядчик (название или ИНН)<input type="text" id="hc-d-ctr" value="${esc(d.contractor)}" placeholder="часть названия или ИНН"></label>
        <label class="hc-grow">Вид работ (код и всё, что под ним)<div class="hc-picker" id="hc-d-work"></div></label>
        <label>Источник<select id="hc-d-src"><option value="">любой</option><option value="form" ${d.source === "form" ? "selected" : ""}>форма</option><option value="import" ${d.source === "import" ? "selected" : ""}>загрузка из SharePoint</option></select></label>
        ${d.mode === "records" ? `<label class="hc-check"><input type="checkbox" id="hc-d-late" ${d.late ? "checked" : ""}> только просроченные</label>` : ""}
        <button type="button" class="hc-btn primary" id="hc-d-go">Показать</button>
        ${ctx.download ? `<button type="button" class="hc-btn" id="hc-d-xlsx">Выгрузить в Excel</button>` : ""}
      </div>
      <div id="hc-d-body"></div>`;
    const picker = workPicker(pane.querySelector("#hc-d-work"), st.works);
    if (d.workId) picker.set(d.workId);
    const read = () => {
      d.scope = pane.querySelector("#hc-d-scope").value; d.from = pane.querySelector("#hc-d-from").value; d.to = pane.querySelector("#hc-d-to").value;
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
    const d = st.data, box = pane.querySelector("#hc-d-body"), all = d.scope === "all";
    if (!box) return;
    if (d.loading) { box.innerHTML = `<p class="hc-muted" role="status">Загрузка…</p>`; return; }
    if (d.error) { box.innerHTML = `<div class="hc-callout bad" role="alert">${esc(d.error)}</div>`; return; }
    const r = d.res;
    if (!r || !r.total) {
      const filtered = !!(d.from || d.to || d.contractor.trim() || d.workId || d.source || d.late);
      const more = d.mode === "records" && !all && !filtered && r && r.all_total;
      box.innerHTML = `<p class="hc-muted">По выбранным условиям данных нет.</p>${more ? `<div class="hc-callout warn">По этому объекту записей нет, а по всем доступным вам объектам их ${r.all_total.toLocaleString("ru-RU")}. <button type="button" class="hc-btn" id="hc-d-all">Показать по всем объектам</button></div>` : ""}`;
      box.querySelector("#hc-d-all")?.addEventListener("click", () => { d.scope = "all"; d.offset = 0; d.res = null; paintData(); });
      return;
    }
    const from = r.offset + 1, to = r.offset + r.items.length;
    const sourceText = (x) => (x === "import" ? "загрузка из SharePoint" : x === "bot" ? "бот" : "форма");
    const head = `<div class="hc-bar"><span><strong>${from.toLocaleString("ru-RU")}–${to.toLocaleString("ru-RU")}</strong> из ${r.total.toLocaleString("ru-RU")}</span>
      ${d.mode === "records" ? `<span class="hc-muted">человек-дней в выборке: <strong>${r.sum_workers.toLocaleString("ru-RU")}</strong></span>` : ""}
      <button type="button" class="hc-btn mini" id="hc-d-prev" ${r.offset <= 0 ? "disabled" : ""}>◀ Назад</button><button type="button" class="hc-btn mini" id="hc-d-next" ${to >= r.total ? "disabled" : ""}>Вперёд ▶</button></div>`;
    const objCol = (name) => (all ? `<td>${esc(name)}</td>` : "");
    const rows = d.mode === "records" ? r.items.map((i) => `<tr><td>${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}${i.inn_status === "unverified" ? ` <span class="hc-badge warn">ИНН не проверен</span>` : ""}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.workers}</td>
        <td class="hc-small">Внесено: ${esc(fmtMoment(i.entered_at))}${i.entered_by ? " · " + esc(i.entered_by) : ""}<br>${i.late ? `<span class="hc-badge bad">просрочено${i.overdue_minutes ? " на " + fmtOverdue(i.overdue_minutes) : ""}</span> ` : ""}<span class="hc-badge">${esc(sourceText(i.source))}</span>${i.changes ? `<br>Изменено: ${esc(fmtMoment(i.updated_at))}${i.updated_by ? " · " + esc(i.updated_by) : ""} <span class="hc-badge">правок: ${i.changes}</span>` : ""}</td></tr>`).join("")
      : r.items.map((i) => `<tr><td class="hc-small">${esc(fmtMoment(i.changed_at))}<br>${esc(i.changed_by || "—")} <span class="hc-badge">${esc(sourceText(i.source))}</span></td><td>${esc(fmtDate(i.date))}</td>${objCol(i.object)}<td>${esc(i.contractor)}</td>
        <td><span class="hc-code">${esc(i.work_code)}</span> ${esc(i.work_name)}</td><td class="num">${i.old ?? "—"} → ${i.new ?? "удалено"}</td></tr>`).join("");
    const heads = d.mode === "records"
      ? ["День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Человек", "Кто и когда"]
      : ["Когда и кто изменил", "День", ...(all ? ["Объект"] : []), "Подрядчик", "Вид работ", "Было → стало"];
    box.innerHTML = `${head}<div class="hc-scroll"><table class="hc-tbl"><thead><tr>${heads.map((h) => `<th class="${h === "Человек" || h === "Было → стало" ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
    box.querySelector("#hc-d-prev").addEventListener("click", () => { d.offset = Math.max(0, d.offset - d.limit); loadData(); });
    box.querySelector("#hc-d-next").addEventListener("click", () => { d.offset += d.limit; loadData(); });
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
      <p class="hc-muted">Объектов 1С в файле: ${an.objects.length}; сопоставлено: <b id="hc-mapped">${mapped}</b>. Несопоставленные не загружаются.</p>
      <div class="hc-scroll hc-maptbl"><table class="hc-tbl"><thead><tr><th>Объект 1С</th><th class="num">Строк</th><th>Период</th><th>Объект в системе</th></tr></thead><tbody>${an.objects.map((g) => `<tr>
        <td>${esc(g.name_1c || "—")}<div class="hc-small hc-muted">${esc(g.guid)}</div></td><td class="num">${g.rows.toLocaleString("ru-RU")}</td><td class="hc-small">${fmtDate(g.date_from)} — ${fmtDate(g.date_to)}</td>
        <td><select data-guid="${esc(g.guid)}"><option value="">— не загружать —</option>${an.candidates.map((o) => `<option value="${o.id}" ${a.mapping[g.guid] === o.id ? "selected" : ""} ${o.guid_1c && o.guid_1c !== g.guid ? "disabled" : ""}>${esc(o.name)}${o.guid_1c && o.guid_1c !== g.guid ? " (уже привязан к другому GUID)" : ""}</option>`).join("")}</select>${g.match ? `<span class="hc-badge">${g.match === "guid" ? "по GUID" : "по названию"}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="hc-bar"><button type="button" class="hc-btn" id="hc-his-dry" ${a.busy ? "disabled" : ""}>Проверить загрузку без записи</button><button type="button" class="hc-btn primary" id="hc-his-go" ${a.busy || !mapped ? "disabled" : ""}>Загрузить</button></div>`;
    box.querySelectorAll("[data-guid]").forEach((s) => s.addEventListener("change", () => {
      a.mapping[s.dataset.guid] = s.value ? Number(s.value) : null;
      const used = new Map(); let dup = false;
      for (const [g, o] of Object.entries(a.mapping)) if (o) { if (used.has(o)) dup = true; used.set(o, g); }
      pane.querySelector("#hc-mapped").textContent = Object.values(a.mapping).filter(Boolean).length;
      s.setCustomValidity(dup ? "Один объект выбран для двух GUID" : ""); if (dup) s.reportValidity();
    }));
    const run = async (dry) => {
      a.busy = true; a.error = ""; paintAdmin();
      try {
        const fd = new FormData(); fd.append("file", a.file); fd.append("mapping", JSON.stringify(a.mapping)); fd.append("dry_run", dry ? "true" : "false");
        const r = await ctx.upload("/headcount/import/apply", fd);
        a.result = `${dry ? "Проверка, ничего не записано — получилось бы: " : "Загружено: "}записей создано ${r.records_created}, обновлено ${r.records_updated}, без изменений ${r.records_unchanged}, оставлено как внесено в системе ${r.kept_form_records}; строк истории ${r.history_rows}; новых подрядчиков ${r.contractors_created}${Object.keys(r.skipped).length ? "; пропущено: " + Object.entries(r.skipped).map(([x, n]) => `${x} — ${n}`).join(", ") : ""}.`;
        if (!dry) { st.day = null; st.contractors = null; loadRefs(); }
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
function workPicker(box, works) {
  let chosen = null;
  box.innerHTML = `<input type="text" class="hc-pick-in" placeholder="Код или название вида работ" autocomplete="off" role="combobox" aria-expanded="false"><ul class="hc-pick-list" role="listbox" hidden></ul>`;
  const input = box.querySelector("input"), list = box.querySelector("ul");
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const hit = (q ? works.filter((w) => `${w.code} ${w.name}`.toLowerCase().includes(q)) : works).slice(0, 60);
    list.innerHTML = hit.length ? hit.map((w) => `<li role="option" data-id="${w.id}"><span class="hc-code">${esc(w.code)}</span> ${esc(w.name)}</li>`).join("") : `<li class="hc-muted">Ничего не найдено</li>`;
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    // список поверх всех прокруток (окно V1 и страница V2 обрезают абсолютно позиционированное): позиция по полю, вниз или вверх
    const r = input.getBoundingClientRect(), below = window.innerHeight - r.bottom - 8, above = r.top - 8;
    const up = below < 180 && above > below, room = Math.max(120, Math.min(300, up ? above : below));
    Object.assign(list.style, { position: "fixed", left: `${r.left}px`, width: `${r.width}px`, maxHeight: `${room}px`,
      top: up ? "auto" : `${r.bottom + 2}px`, bottom: up ? `${window.innerHeight - r.top + 2}px` : "auto" });
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  input.addEventListener("input", () => { chosen = null; render(); });
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && !list.hidden) { const f = list.querySelector("[data-id]"); if (f && !chosen) { e.preventDefault(); pick(f); } } });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("[data-id]"); if (li) { e.preventDefault(); pick(li); } });
  const pick = (li) => { chosen = Number(li.dataset.id); const w = works.find((x) => x.id === chosen); input.value = `${w.code} ${w.name}`; close(); };
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) close(); });
  window.addEventListener("scroll", (e) => { if (!list.hidden && !list.contains(e.target)) close(); }, true);
  return { value: () => chosen, clear: () => { chosen = null; input.value = ""; close(); },
    set: (id) => { const w = works.find((x) => x.id === id); if (w) { chosen = id; input.value = `${w.code} ${w.name}`; } } };
}
