// V2: «Документы контрактации» — «Замена поставщика» и «Обмен привязками» (backend: app/supplier_change.py, те же эндпоинты, что у V1).
//
// Что это и чем НЕ является. Оба документа — ПЕРЕПРИВЯЗКА КОНТРАКТА у уже привязанных изделий:
//  * «Замена поставщика» переводит НЕпоставленные изделия (статус ниже «Отгружен») одного контракта на другой в пределах объекта, по выбранным
//    изделиям и в пределах свободного количества нового контракта; запись в историю — тем же статусом, причина и документ в комментарии;
//  * «Обмен привязками» — попарный обмен изделий ОДНОЙ марки между двумя контрактами: контракт, плановая дата и ВСЯ история статусов.
//  «Планируемого поставщика» в модели данных нет (Docs/v2-workspaces.md §9в): изделию без контракта менять нечего — его привязывает
//  «Распределение» в АРМ комплектовщика. Документ сюда не подменяет ни то, ни другое.
//
// Жизненный цикл: черновик (данные изделий НЕ трогает; правится, удаляется) → «Провести» (переносит всё разом, всё или ничего; остаток проверяет страж
// contract_guard «до/после») → «Отменить проведение» (возвращает привязки, плановые даты обмена и историю). Проведённый документ не правится и не удаляется.
//
// Защита операций: блокировка на время запроса ДО первого await (двойной щелчок — один запрос); правка/проведение/отмена уходят с
// `expected_version` (версия документа, которую видел человек; при расхождении сервер отвечает 409 без изменений); неизвестный исход (обрыв связи)
// НЕ повторяется — состояние перечитывается с сервера; выход из несохранённого черновика — сторож «Остаться / Не сохранять / Сохранить».
//
// Режим «только просмотр» (2026-09-22, решение пользователя «нужен просмотр»). Экран открывается при праве «Чтение» на любой из двух
// разделов (screens.json, поле feature), а не только при «Изменении», как пункт меню V1. Документ вида, который человеку не дано
// изменять, открывается так же, как проведённый: поля заблокированы, состав — таблицей/сторонами, без кнопок создания, правки, удаления,
// подбора, проведения и отмены. Справочные запросы формы (/refs, /candidates, /contract-marks, /mark-contracts, /swap-elements) сервер
// отдаёт только при «Изменении» — это материал для ПРАВКИ; просмотру хватает самого документа (GET /supplier-changes/{id}: названия
// контрактов в шапке, состав с адресами и статусами), поэтому читателю они не запрашиваются вовсе. Изменяющие запросы по-прежнему
// проверяет сервер (403) — здесь только не показываются кнопки, которые он всё равно отклонил бы.
import { showUnsavedDialog, showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const ruMoment = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : ruDate(v); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const STATUS = { planned: "Запланирован", contracting: "Контрактация", in_production: "В производстве", shipped: "Отгружен", delivered: "Доставлен", installed: "Смонтирован", accepted: "Принят" };
const KIND_TITLE = { supplier_change: "Замена поставщика", link_swap: "Обмен привязками", date_rebalance: "Балансировка поставки" };
// Балансировка поставки (2026-10-05, A4) — тот же раздел прав, что у обмена привязками: сервер (app/supplier_change.py KIND_FEATURES).
const KIND_FEATURE = { supplier_change: "doc_supplier_change", link_swap: "doc_link_swap", date_rebalance: "doc_link_swap" };
const single = (kind) => kind === "supplier_change" || kind === "date_rebalance";   // состав — один список изделий (chosen), а не две стороны
const isStale = (err) => err instanceof ApiError && err.status === 409 && err.rawDetail && typeof err.rawDetail === "object" && err.rawDetail.conflict === "stale_version";

// ---------------------------------------------------------------- подбор изделий на мини-схеме (перенос из V1 scd-picker-svg)
// Самостоятельный упрощённый SVG-рендер (НЕ общая сцена Three.js/2D рабочего места — тот же принцип, что у V1): координаты и контур
// приходит ГОТОВЫМИ с сервера (`/supplier-changes/swap-elements`), здесь только показ, клик и рамка. Список рядом — второй способ
// того же выбора: оба читают и пишут ОДИН Set `pk.sel`, поэтому синхронизированы «бесплатно», без отдельного моста состояния.
const PICK_MIN_PX = 7;   // экранный минимум маркера, мм в мировых единицах пересчитывается по масштабу — во что можно попасть курсором/рамкой
function pickCentroid(e) {
  // Точка попадания контурного изделия — среднее вершин (не площадной центроид, как в V1 footprintCentroid: для клика и проверки
  // «внутри рамки» разница на практике не видна, а без него потребовалась бы отдельная площадная формула).
  if (e.outline && e.outline.length >= 3) {
    let sx = 0, sy = 0; for (const [px, py] of e.outline) { sx += px; sy += py; }
    return [sx / e.outline.length, sy / e.outline.length];
  }
  return [e.x, e.y];
}
function pickBBox(elements, context) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (px, py) => { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; };
  for (const e of context) take(e.x, e.y);
  for (const e of elements) { if (e.outline && e.outline.length >= 3) for (const [px, py] of e.outline) take(px, py); else take(e.x, e.y); }
  if (!Number.isFinite(minX)) return null;
  const pad = Math.max(maxX - minX, maxY - minY) * 0.05 || 1000;
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}
// Показанные — марка/контракт минус уже попавшие в документ, отфильтрованные по этажу; ОДИН и тот же список даёт и список-чекбоксы,
// и маркеры схемы — расхождения между ними исключены самой формой кода, а не отдельной сверкой.
function pickerShown(x, pk) {
  const taken = new Set([...x.sideA, ...x.sideB].map((e) => e.id));
  return pk.all.filter((e) => !taken.has(e.id) && (pk.floor === "" || String(e.floor ?? "") === pk.floor));
}

export function mountSupplierDocs(container, { screen, objectId, api, rights, groupTitle }) {
  let dead = false;
  const can = (kind) => !!rights?.system_admin || (rights?.features || {})[KIND_FEATURE[kind]] === "write";
  // Просмотр: «Чтение» или «Изменение» (изменение включает просмотр, app/features.py)
  const canRead = (kind) => !!rights?.system_admin || ["read", "write"].includes((rights?.features || {})[KIND_FEATURE[kind]]);
  const canAny = can("supplier_change") || can("link_swap") || can("date_rebalance");
  // Документ только для просмотра: проведён (его состав не правит никто) или изменять документы этого вида человеку не дано
  const readOnly = (x) => !x || x.status === "posted" || !can(x.kind);

  const S = {
    view: "list",                       // "list" | "doc"
    tab: null,                          // закладка списка по виду документа: supplier_change | link_swap | date_rebalance
    list: { loaded: false, error: "", items: [] },
    refs: { loaded: false, error: "", contracts: [] },
    rbCands: null,                      // кандидаты на балансировку: [{contract_id, counterparty, changed, late, marks:[{mark,count,changed,late}]}]
    colors: {},                         // status -> цвет маркера мини-схемы (GET /status-colors, то же читает «Состояние БД»); не критично — без него нейтральный серый
    f: null,                            // форма открытого документа
    busy: false,                        // идёт запись — все действия документа заблокированы (ставится ДО первого await)
    message: "",                        // итог последней операции (строка статуса)
    listNote: "",
  };

  container.className = "v2-page v2-app";
  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container v2-container--wide"><h2>${esc(screen.title)}</h2></div></div>
    <div id="sd-body" class="v2-scroll"><div id="sd-inner" class="v2-container v2-container--wide"></div></div>
    <footer class="v2-foot"><div class="v2-container v2-container--wide"><span id="sd-status" class="v2-muted" role="status" aria-live="polite"></span><div class="v2-foot-actions" id="sd-foot"></div></div></footer>`;
  container.querySelector(".v2-foot").hidden = true;
  const inner = container.querySelector("#sd-inner"), statusEl = container.querySelector("#sd-status"), foot = container.querySelector("#sd-foot");

  // ------------------------------------------------------------ данные
  async function loadList() {
    S.list.error = "";
    try { S.list.items = await api.get(`/supplier-changes?object_id=${objectId}`); S.list.loaded = true; }
    catch (err) { S.list.error = err?.detail || "Не удалось загрузить документы"; }
  }
  async function loadRefs() {
    S.refs.error = "";
    try { S.refs.contracts = (await api.get(`/supplier-changes/refs?object_id=${objectId}`)).contracts; S.refs.loaded = true; }
    catch (err) { S.refs.error = err?.detail || "Не удалось загрузить контракты объекта"; }
  }
  async function loadColors() { try { S.colors = await api.get("/status-colors"); } catch (err) { /* мини-схема тогда рисует нейтральным цветом — не критично для подбора */ } }
  // Балансировка поставки: предлагаются только контракты и марки, по которым есть что балансировать (расчёт изменит хотя бы одну
  // плановую дату), с числом таких изделий (2026-10-06, запрос пользователя). Тот же расчёт, что при проведении, — на сервере.
  async function loadRbCands() {
    try { const r = await api.get(`/supplier-changes/rebalance-candidates?object_id=${objectId}`); S.rbCands = r.contracts; S.rbPool = r.pool; }
    catch (err) { S.rbCands = []; S.rbPool = null; S.refs.error = err?.detail || "Не удалось получить контракты для балансировки"; }
  }
  const RB_ALL = "*";   // значение выбора «Все контракты» / «Все марки»
  const rbCandOf = (contractId) => (S.rbCands || []).find((c) => String(c.contract_id) === String(contractId)) || null;
  // Марки выбранного охвата. «Все контракты»: сумма по контрактам (каждый отдельно) или, при общем пуле, свой расчёт сервера.
  function rbMarksOf(contractId, pool) {
    if (String(contractId) !== RB_ALL) return rbCandOf(contractId)?.marks || [];
    if (pool) return S.rbPool?.marks || [];
    const m = new Map();
    for (const c of S.rbCands || []) for (const k of c.marks) {
      const a = m.get(k.mark.toLowerCase()) || { mark: k.mark, count: 0, changed: 0, late: 0 };
      a.count += k.count; a.changed += k.changed; a.late += k.late; m.set(k.mark.toLowerCase(), a);
    }
    return [...m.values()].sort((a, b) => a.mark.localeCompare(b.mark, "ru"));
  }
  const rbSum = (list, key) => list.reduce((n, m) => n + m[key], 0);
  const contractById = (id) => S.refs.contracts.find((c) => String(c.id) === String(id)) || null;
  const selectable = () => S.refs.contracts.filter((c) => !c.is_archived);
  const contractLabel = (c) => `${c.agreement_number}${c.agreement_date ? " от " + ruDate(c.agreement_date) : ""} / ${c.specification_number}${c.specification_date ? " от " + ruDate(c.specification_date) : ""}`;
  function contractOptions(selected, only = null) {
    const groups = new Map();
    for (const c of selectable()) { if (only && !only.has(c.id)) continue; if (!groups.has(c.counterparty_short_name)) groups.set(c.counterparty_short_name, []); groups.get(c.counterparty_short_name).push(c); }
    return `<option value="">— выберите —</option>` + [...groups].map(([cp, list]) => `<optgroup label="${esc(cp)}">${list.map((c) => `<option value="${c.id}" ${String(selected) === String(c.id) ? "selected" : ""}>${esc(contractLabel(c))}${only && f().sideBCounts?.get(c.id) ? ` · ${f().sideBCounts.get(c.id).count} шт.` : ""}${c.name.includes("(") ? " " + esc(c.name.slice(c.name.lastIndexOf("("))) : ""}</option>`).join("")}</optgroup>`).join("");
  }
  const f = () => S.f;

  // ------------------------------------------------------------ форма документа
  function blankForm(kind) {
    return { id: null, kind, status: "draft", version: null, number: "", date: today(), reason: "", comment: "", from: "", to: "", mark: "",
      chosen: new Map(),                // замена: elementId -> {type, mark, address, status}
      cand: null, candError: "", candLoading: false,       // ответ /candidates
      sideA: [], sideB: [],             // обмен: массивы изделий (порядок = пары)
      marks: [], marksError: "", sideBCounts: new Map(), sideBError: "",
      rb: null, rbError: "", rbLoading: false,             // балансировка: ответ /rebalance-preview
      pool: false, rbOpen: new Set(), rbMode: null,        // балансировка: общий пул дат; свёрнутые/развёрнутые группы таблицы
      picker: null,                     // {side, all, floor, sel:Set, error, loading}
      posted: null, saved: null, error: "" };
  }
  function fingerprint(x) {
    return JSON.stringify([x.number.trim(), x.date, x.reason.trim(), x.comment.trim(), String(x.from), String(x.to), x.kind !== "supplier_change" ? x.mark : "", x.kind === "date_rebalance" ? !!x.pool : "",
      single(x.kind) ? [...x.chosen.keys()].sort((a, b) => a - b) : [x.sideA.map((e) => e.id), x.sideB.map((e) => e.id)]]);
  }
  const isDirty = () => S.view === "doc" && !!f() && !readOnly(f()) && fingerprint(f()) !== f().saved;
  function fromDoc(d) {
    const x = blankForm(d.kind);
    Object.assign(x, { id: d.id, status: d.status, version: d.version, number: d.number, date: d.doc_date, reason: d.reason || "", comment: d.comment || "",
      from: d.all_contracts ? RB_ALL : String(d.from_contract_id), to: String(d.to_contract_id), mark: d.all_marks ? RB_ALL : (d.mark || ""),
      pool: !!d.pool, posted: d.status === "posted" ? { by: d.posted_by, at: d.posted_at } : null, head: d });
    const info = (i) => ({ id: i.element_id, type: i.element_type, mark: i.mark, address: i.address, floor: i.floor, status: i.current_status });
    x.items = d.items;
    if (single(d.kind)) for (const i of d.items) x.chosen.set(i.element_id, info(i));
    else { x.sideA = d.items.filter((i) => i.side === 1).map(info); x.sideB = d.items.filter((i) => i.side === 2).map(info); }
    x.saved = fingerprint(x);
    return x;
  }

  async function openDoc(id) {
    if (S.busy) return;
    S.busy = true; paint();
    try {
      // контракты объекта нужны только правке (сервер отдаёт их при «Изменении»); просмотр берёт названия из шапки документа
      if (!S.refs.loaded && canAny) await loadRefs();
      const d = await api.get(`/supplier-changes/${id}`);
      if (d.kind === "date_rebalance" && canAny) await loadRbCands();
      S.f = fromDoc(d); S.view = "doc"; S.message = ""; S.tab = d.kind;
      S.busy = false;
      paint();
      await loadFormData(true);
    } catch (err) { S.listNote = err?.detail || "Не удалось открыть документ"; S.busy = false; await backToList(true); }
    S.busy = false; paint();
  }
  async function newDoc(kind) {
    if (S.busy || !can(kind)) return;
    if (!S.refs.loaded) { S.busy = true; paint(); await loadRefs(); S.busy = false; }
    if (kind === "date_rebalance") { S.busy = true; paint(); await loadRbCands(); S.busy = false; }
    S.f = blankForm(kind); S.f.saved = fingerprint(S.f); S.view = "doc"; S.message = ""; S.tab = kind; paint();
  }
  async function backToList(force) {
    if (S.busy) return false;
    if (!force && isDirty() && !(await guardLeave())) return false;
    S.view = "list"; S.f = null; S.message = "";
    S.busy = true; paint();
    await loadList(); S.busy = false; paint();
    return true;
  }

  // Данные, зависящие от выбора контрактов: кандидаты (замена) или марки/стороны (обмен)
  async function loadFormData(initial) {
    const x = f(); if (!x || readOnly(x)) return;
    if (x.kind === "supplier_change") await loadCandidates(); else await loadMarks(initial);   // у балансировки loadMarks дочитывает предпросмотр
  }
  async function loadCandidates() {
    const x = f(); x.cand = null; x.candError = "";
    if (!x.from || !x.to || x.from === x.to) { paint(); return; }
    x.candLoading = true; paint();
    try {
      const r = await api.get(`/supplier-changes/candidates?object_id=${objectId}&from_contract_id=${x.from}&to_contract_id=${x.to}`);
      if (f() === x) x.cand = r;
    } catch (err) { if (f() === x) x.candError = err?.detail || "Не удалось загрузить изделия контракта"; }
    if (f() === x) { x.candLoading = false; paint(); }
  }
  async function loadMarks(initial) {
    const x = f(); x.marks = []; x.marksError = ""; x.sideBCounts = new Map(); x.sideBError = "";
    if (!x.from) { paint(); return; }
    if (x.kind === "date_rebalance") x.marks = rbMarksOf(x.from, x.pool);   // только марки, где балансировка что-то изменит
    else try { x.marks = (await api.get(`/supplier-changes/contract-marks?object_id=${objectId}&contract_id=${x.from}`)).marks; }
    catch (err) { x.marksError = err?.detail || "Не удалось загрузить марки контракта"; }
    if (f() !== x) return;
    if (x.mark) await (x.kind === "date_rebalance" ? loadRebalance(initial) : loadSideB()); else paint();
  }
  // Балансировка: предпросмотр «было → стало». Состав НОВОГО документа — все подходящие изделия контракта и марки; у сохранённого
  // черновика при первом открытии — его собственный состав (doc_id), чтобы не подменять то, что человек сохранил.
  async function loadRebalance(initial) {
    const x = f(); x.rb = null; x.rbError = "";
    if (!x.from || !x.mark) { paint(); return; }
    x.rbLoading = true; paint();
    try {
      const h = x.head, allC = x.from === RB_ALL, allM = x.mark === RB_ALL;
      const own = initial && x.id && h && !!h.all_contracts === allC && (allC || String(h.from_contract_id) === String(x.from))
        && !!h.all_marks === allM && (allM || h.mark === x.mark) && !!h.pool === !!x.pool;
      const q = `object_id=${objectId}${allC ? "" : `&contract_id=${x.from}`}${allM ? "" : `&mark=${encodeURIComponent(x.mark)}`}${allC && x.pool ? "&pool=true" : ""}${own ? `&doc_id=${x.id}` : ""}`;
      const r = await api.get(`/supplier-changes/rebalance-preview?${q}`);
      if (f() === x) {
        x.rb = r;
        if (!own) { x.chosen.clear(); for (const i of r.items) x.chosen.set(i.element_id, { id: i.element_id, mark: i.mark, address: i.address, floor: i.floor, status: i.status }); }
      }
    } catch (err) { if (f() === x) x.rbError = err?.detail || "Не удалось рассчитать балансировку"; }
    if (f() === x) { x.rbLoading = false; paint(); }
  }
  async function loadSideB() {
    const x = f(); x.sideBCounts = new Map(); x.sideBError = "";
    if (!x.from || !x.mark) { paint(); return; }
    try {
      const r = await api.get(`/supplier-changes/mark-contracts?object_id=${objectId}&mark=${encodeURIComponent(x.mark)}&exclude_contract_id=${x.from}`);
      if (f() === x) for (const c of r.contracts) x.sideBCounts.set(c.contract_id, c);
    } catch (err) { if (f() === x) x.sideBError = err?.detail || "Не удалось загрузить контракты с этой маркой"; }
    if (f() === x) paint();
  }

  // ------------------------------------------------------------ запись
  function bodyFor(x) {
    const b = { object_id: objectId, kind: x.kind, number: x.number.trim() || null, doc_date: x.date, from_contract_id: Number(x.from), to_contract_id: Number(x.to),
      reason: x.reason.trim() || null, comment: x.comment.trim() || null };
    if (x.kind === "date_rebalance") {
      b.element_ids = [...x.chosen.keys()];
      b.all_contracts = x.from === RB_ALL; b.all_marks = x.mark === RB_ALL; b.pool = b.all_contracts && !!x.pool;
      b.mark = b.all_marks ? null : x.mark;
      b.from_contract_id = b.all_contracts ? 0 : Number(x.from);   // «все контракты»: контракт-представитель выберет сервер
      b.to_contract_id = b.from_contract_id;
    }
    else if (x.kind === "supplier_change") b.element_ids = [...x.chosen.keys()];
    else { b.mark = x.mark; b.side_a = x.sideA.map((e) => e.id); b.side_b = x.sideB.map((e) => e.id); }
    if (x.id && x.version) b.expected_version = x.version;
    return b;
  }
  function validate(x) {
    if (!x.date) return "Укажите дату документа";
    if (x.kind === "date_rebalance") { if (!x.from) return "Выберите контракт"; if (!x.mark) return "Выберите марку"; return x.chosen.size ? "" : "Нет изделий для балансировки"; }
    if (!x.from || !x.to) return x.kind === "link_swap" ? "Выберите контракты обеих сторон" : "Выберите текущий и новый контракты";
    if (x.from === x.to) return "Контракты совпадают — выберите разные";
    if (x.kind === "link_swap" && !x.mark) return "Выберите марку обмена";
    return "";
  }
  // Итог неизвестного исхода: состояние перечитывается с сервера, ничего не отправляется повторно
  const unknownText = "Ответ сервера не получен. Ничего не отправлено повторно — ниже показано, что сервер видит сейчас.";

  async function saveDraft() {
    const x = f(); if (!x || S.busy || readOnly(x)) return false;
    const problem = validate(x); if (problem) { x.error = problem; paint(); return false; }
    S.busy = true; x.error = ""; S.message = ""; paint();
    const snapshot = fingerprint(x);
    const wasNew = !x.id;
    try {
      const d = wasNew ? await api.post("/supplier-changes", bodyFor(x)) : await api.patch(`/supplier-changes/${x.id}`, bodyFor(x));
      const nf = fromDoc(d);
      // введённое после отправки (пока шёл запрос) не затираем: интерфейс на время записи заблокирован, поэтому это защитная ветка
      if (f() === x && fingerprint(x) === snapshot) { S.f = nf; loadFormDataSoon(); }
      S.message = wasNew ? `Черновик № ${d.number} создан. Данные изделий не тронуты — они изменятся при проведении.` : `Черновик № ${d.number} сохранён. Данные изделий не тронуты.`;
      S.busy = false; paint(); return true;
    } catch (err) {
      S.busy = false;
      if (err instanceof ApiError && err.status === 0) {
        x.error = unknownText + (wasNew ? " Проверьте список документов: черновик мог быть создан." : "");
        if (!wasNew) { try { const d = await api.get(`/supplier-changes/${x.id}`); x.error += ` На сервере: ${d.status_title}, изделий: ${d.items.length}, версия ${d.version === x.version ? "не изменилась — сохранение не применено" : "изменилась — сохранение могло примениться; закройте и откройте документ"}.`; } catch (e) { x.error += " Проверить состояние не удалось."; } }
      } else if (isStale(err)) x.error = `${err.detail} Закройте документ и откройте его заново — актуальная версия будет загружена; ваши правки будут потеряны.`;
      else x.error = err?.detail || "Не удалось сохранить";
      paint(); return false;
    }
  }
  function loadFormDataSoon() { queueMicrotask(() => { if (!dead) loadFormData(true); }); }

  async function deleteDraft() {
    const x = f(); if (!x || !x.id || S.busy || readOnly(x)) return;
    if (!(await showConfirmDialog(`Удалить черновик № ${x.number}? Данные изделий он не менял — удаляется только документ.`, { confirmLabel: "Удалить", danger: true }))) return;
    if (S.busy || f() !== x) return;
    S.busy = true; x.error = ""; paint();
    try { await api.delete(`/supplier-changes/${x.id}`); S.busy = false; S.f = null; S.view = "list"; S.listNote = `Черновик № ${x.number} удалён.`; await loadList(); paint(); }
    catch (err) {
      S.busy = false;
      if (err instanceof ApiError && err.status === 0) {
        try { await api.get(`/supplier-changes/${x.id}`); x.error = `${unknownText} Документ на месте — удаление не выполнено.`; }
        catch (e2) { if (e2 instanceof ApiError && e2.status === 404) { S.f = null; S.view = "list"; S.listNote = `Черновик № ${x.number} удалён (подтверждено сервером; ответ не пришёл).`; await loadList(); paint(); return; } x.error = unknownText; }
      } else x.error = err?.detail || "Не удалось удалить";
      paint();
    }
  }

  // Что изменится при проведении / отмене — читается с сервера непосредственно перед подтверждением
  async function postPreview(x, undo) {
    const d = x.head;
    if (x.kind === "date_rebalance") {
      const c = contractById(x.from), sm = x.rb?.summary;
      return undo
        ? `Отменить проведение балансировки № ${x.number}?\nИзделиям (${x.chosen.size} шт.) вернутся плановые даты поставки, какими они были до документа. Контракт, статус и история не менялись.`
        : `Провести балансировку поставки № ${x.number}?\n${x.mark === RB_ALL ? "Все марки" : `Марка «${x.mark}»`}, ${x.from === RB_ALL ? `все контракты (${x.pool ? "общий пул дат между контрактами" : "каждый контракт отдельно"})` : `контракт «${c ? contractLabel(c) : "—"}»`}, изделий: ${x.chosen.size}.\nНабор согласованных плановых дат поставщика не меняется: изделия одной марки меняются МЕСТАМИ парами: плановая дата, контракт и вся история статусов уходят к партнёру (текущий статус и фактическая дата пересчитываются), остальные изделия не затрагиваются.${sm ? `\nПросрочка (плановая позже требуемой) по расчёту сейчас: изделий ${sm.late_before} → ${sm.late_after}, максимум ${sm.max_delay_before} → ${sm.max_delay_after} дн.; обмен пройдут ${sm.pairs} пар (${sm.pairs * 2} изд. из ${sm.count}).` : ""}\nПроведение пересчитывает раскладку по данным на момент проведения. Отмена — кнопкой «Отменить проведение».`;
    }
    if (x.kind === "link_swap") {
      const pairs = Math.min(x.sideA.length, x.sideB.length);
      const a = contractById(x.from), b = contractById(x.to);
      return undo
        ? `Отменить проведение обмена № ${x.number}?\nПар: ${pairs}. Контракты, плановые даты и ВСЯ история статусов вернутся изделиям, как были до документа; записи истории, созданные проведением, будут удалены.`
        : `Провести обмен привязками № ${x.number}?\nМарка «${x.mark}», пар: ${pairs}. Изделия стороны 1 (${a ? contractLabel(a) : "—"}) и стороны 2 (${b ? contractLabel(b) : "—"}) поменяются местами: контракт, плановая дата и вся история статусов.\nОтменяется действием «Отменить проведение».`;
    }
    const byPos = new Map();
    const ids = [...x.chosen.values()];
    for (const e of ids) { const k = `${e.type || "—"} · ${e.mark || "—"}`; byPos.set(k, (byPos.get(k) || 0) + 1); }
    const oldC = contractById(x.from), newC = contractById(x.to);
    // получатель: при проведении — новый контракт, при отмене — прежний (изделия сейчас на новом)
    const dest = undo ? x.from : x.to, src = undo ? x.to : x.from;
    let avail = null;
    try {
      const r = await api.get(`/supplier-changes/candidates?object_id=${objectId}&from_contract_id=${src}&to_contract_id=${dest}`);
      avail = new Map(r.positions.map((p) => [`${p.element_type || "—"} · ${p.mark || "—"}`, p.available_in_new]));
    } catch (e) { /* без остатка сервер всё равно проверит при проведении */ }
    const lines = [...byPos].map(([k, n]) => { const av = avail?.get(k); return `  • ${k}: ${n} шт.${av != null ? ` (свободно в контракте-получателе: ${av} → ${av - n})` : ""}${av != null && n > av ? " — НЕ ХВАТАЕТ" : ""}`; });
    const over = avail && [...byPos].some(([k, n]) => avail.get(k) != null && n > avail.get(k));
    const head = undo
      ? `Отменить проведение замены поставщика № ${x.number}?\nИзделия (${ids.length} шт.) вернутся с «${newC ? contractLabel(newC) : "нового"}» на «${oldC ? contractLabel(oldC) : "прежний"}» контракт; записи истории, созданные проведением, будут удалены.`
      : `Провести замену поставщика № ${x.number}?\nИзделия (${ids.length} шт.) перейдут с «${oldC ? contractLabel(oldC) : "—"}» на «${newC ? contractLabel(newC) : "—"}»; в историю каждого изделия добавится запись тем же статусом.`;
    return `${head}\n${lines.join("\n")}${over ? `\n\nВНИМАНИЕ: остатка контракта-получателя не хватает по позициям выше. ${undo ? "Отмена проведения вернёт изделий больше, чем предусмотрено спецификацией прежнего контракта." : "Сервер откажет в проведении, ничего не изменив."}` : ""}`;
  }

  async function postOrUnpost(undo) {
    const x = f(); if (!x || !x.id || S.busy || !can(x.kind)) return;
    if (!undo && isDirty()) { x.error = "Сначала сохраните изменения — проводится то, что сохранено."; paint(); return; }
    S.busy = true; paint();                                 // блокировка ДО первого await
    let text;
    try { text = await postPreview(x, undo); } catch (e) { S.busy = false; paint(); return; }
    S.busy = false; paint();
    if (!(await showConfirmDialog(text, { confirmLabel: undo ? "Отменить проведение" : "Провести", danger: undo, multiline: true }))) return;
    if (S.busy || f() !== x) return;
    S.busy = true; x.error = ""; S.message = ""; paint();
    const path = `/supplier-changes/${x.id}/${undo ? "unpost" : "post"}`;
    try {
      const d = await api.post(path, x.version ? { expected_version: x.version } : {});
      S.f = fromDoc(d);
      S.message = undo ? `Проведение отменено: ${d.elements ?? ""} изд. возвращены в состояние до документа (плановые даты, статусы и история — как были). Документ снова черновик.` : `Документ № ${d.number} проведён: ${x.kind === "date_rebalance" ? `поменялись местами ${d.pairs} пар (${d.moved} изд.): плановые даты, контракты и статусы перешли к партнёрам по паре.` : `${d.moved ?? d.pairs ?? ""} ${d.pairs != null ? "пар" : "изд."} перенесено.`} Отмена — кнопкой «Отменить проведение».`;
      S.busy = false; paint(); loadFormDataSoon();
    } catch (err) {
      S.busy = false;
      if (err instanceof ApiError && err.status === 0) {
        // неизвестный исход: повтор НЕ отправляется, факт читается с сервера
        try {
          const d = await api.get(`/supplier-changes/${x.id}`);
          const done = undo ? d.status === "draft" : d.status === "posted";
          S.f = fromDoc(d);
          S.f.error = done ? `${unknownText} Сервер подтвердил: ${undo ? "проведение отменено" : "документ проведён"}.` : `${unknownText} Сервер: операция НЕ выполнена (документ «${d.status_title}»). Повторите только сознательно.`;
          S.message = done ? (undo ? "Проведение отменено (подтверждено сервером)." : "Документ проведён (подтверждено сервером).") : "";
          paint(); loadFormDataSoon(); return;
        } catch (e2) { x.error = `${unknownText} Проверить состояние не удалось — обновите страницу.`; paint(); return; }
      }
      if (isStale(err)) x.error = `${err.detail} Документ изменился — закройте его и откройте заново; ничего не выполнено.`;
      else x.error = err?.detail || "Операция не выполнена";
      paint();
    }
  }

  // ------------------------------------------------------------ подбор изделий
  const elLabel = (e) => [e.mark || "—", e.address || `№${e.id}`, e.floor != null ? `этаж ${e.floor}` : null, STATUS[e.status || e.current_status] || e.status || e.current_status].filter(Boolean).join(" · ");
  async function openPicker(side) {
    const x = f(); if (!x || S.busy || readOnly(x)) return;
    const contract = side === "a" ? x.from : x.to;
    if (!contract || !x.mark) return;
    // view/base — охват мини-схемы (мировые координаты); context — фон (остальные изделия того же типа, точкой) — оба заполняются
    // из ТОГО ЖЕ ответа, что и список, вторым проходом не грузятся.
    x.picker = { side, all: [], floor: "", sel: new Set(), error: "", loading: true, floors: [], context: [], view: null, base: null }; paint();
    try {
      const r = await api.get(`/supplier-changes/swap-elements?object_id=${objectId}&contract_id=${contract}&mark=${encodeURIComponent(x.mark)}`);
      if (f() === x && x.picker) {
        x.picker.all = r.elements.map((e) => ({ id: e.id, type: e.element_type, mark: e.mark, address: e.address, floor: e.floor, status: e.current_status, planned: e.planned_delivery_date, x: e.x, y: e.y, outline: e.outline }));
        x.picker.floors = r.floors; x.picker.context = r.context || []; x.picker.loading = false;
      }
    } catch (err) { if (f() === x && x.picker) { x.picker.loading = false; x.picker.error = err?.detail || "Не удалось загрузить изделия"; } }
    if (f() === x) paint();
  }
  // Рендер SVG-подложки мини-схемы (строка — как geoSvg в mfr-structure.js): охват считается из ПОКАЗАННЫХ изделий и фона на
  // текущем этаже; вид (`pk.view`) переживает перерисовку — панорамирование и масштаб меняют его напрямую, минуя paint().
  function pickerSvgHtml(x, pk) {
    const shown = pickerShown(x, pk);
    const context = (pk.context || []).filter((e) => pk.floor === "" || String(e.floor ?? "") === pk.floor);
    const box = pickBBox(shown, context);
    if (!box) return `<p class="v2-muted">На этом этаже изделий выбранной марки нет.</p>`;
    pk.base = box;
    if (!pk.view) pk.view = { ...box };
    else if (pk.view.w > box.w || pk.view.h > box.h) pk.view = { ...box };
    const view = pk.view;
    // Точный мировой-на-пиксель масштаб доступен только у уже вставленного в DOM узла (getScreenCTM); здесь — оценка по ширине
    // панели (мини-схема занимает примерно половину формы), достаточная для того, чтобы маркер не превращался в невидимую точку.
    const wpp = view.w / 640;
    const minR = PICK_MIN_PX * wpp, dotR = 1.5 * wpp;
    const ctxDots = context.map((e) => `<circle cx="${e.x}" cy="${-e.y}" r="${dotR}" fill="var(--muted)" opacity="0.5"/>`).join("");
    const shapes = shown.map((e) => {
      const chosen = pk.sel.has(e.id);
      const color = S.colors[e.status] || "#999";
      const title = `<title>${esc(elLabel(e))}</title>`;
      if (e.outline && e.outline.length >= 3) {
        const xs = e.outline.map((p) => p[0]);
        if (Math.max(...xs) - Math.min(...xs) >= minR * 2) {
          const pts = e.outline.map(([px, py]) => `${px},${-py}`).join(" ");
          return `<polygon points="${pts}" class="sd-pick-shape${chosen ? " chosen" : ""}" data-el="${e.id}" fill="${esc(color)}" fill-opacity="${chosen ? 0.9 : 0.55}" stroke="${chosen ? "var(--accent)" : "#333"}" stroke-width="${chosen ? 2 : 1}" vector-effect="non-scaling-stroke">${title}</polygon>`;
        }
      }
      const [cx, cy] = pickCentroid(e);
      return `<circle cx="${cx}" cy="${-cy}" r="${Math.max(minR, view.w / 220)}" class="sd-pick-shape${chosen ? " chosen" : ""}" data-el="${e.id}" fill="${esc(color)}" fill-opacity="${chosen ? 0.9 : 0.55}" stroke="${chosen ? "var(--accent)" : "#333"}" stroke-width="${chosen ? 2 : 1}" vector-effect="non-scaling-stroke">${title}</circle>`;
    }).join("");
    const vb = `${view.x} ${-(view.y + view.h)} ${view.w} ${view.h}`;
    return `<div id="sd-pick-stage" style="position:relative">
      <svg id="sd-pick-svg" viewBox="${vb}" style="width:100%;height:280px;background:var(--surface);border:1px solid var(--line);border-radius:8px;touch-action:none;cursor:crosshair;display:block" preserveAspectRatio="xMidYMid meet">${ctxDots}${shapes}</svg>
      <div id="sd-pick-band" style="position:absolute;display:none;border:1px dashed var(--accent);background:color-mix(in srgb, var(--accent) 18%, transparent);pointer-events:none"></div>
    </div>
    <p class="v2-muted" style="margin:4px 0">Клик — отметить/снять ближайшее; протяжка рамкой — добавить всё внутри; Shift+перетаскивание — панорама; колесо — масштаб.</p>`;
  }
  // Панорама/масштаб — прямая правка `pk.view` и атрибута viewBox БЕЗ полной перерисовки формы (тот же приём, что у перетаскивания
  // геометрии блока в mfr-structure.js): полный paint() на каждый pointermove/wheel тормозил бы форму целиком ради одной схемы.
  // Клик и рамка исход РЕДКИЙ (конец жеста) — там полный paint() ожидаем, он же синхронизирует список изделий.
  function bindPickerSvg(x, pk) {
    const svg = inner.querySelector("#sd-pick-svg"), stage = inner.querySelector("#sd-pick-stage"), band = inner.querySelector("#sd-pick-band");
    if (!svg || !stage) return;
    const toWorld = (clientX, clientY) => {
      const ctm = svg.getScreenCTM(); if (!ctm) return null;
      const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
      const sp = p.matrixTransform(ctm.inverse());
      return { x: sp.x, y: -sp.y };
    };
    const worldPerPx = () => { const ctm = svg.getScreenCTM(); return ctm && ctm.a ? 1 / Math.abs(ctm.a) : (pk.view ? pk.view.w / 640 : 1); };
    let panOn = false, bandOn = false, panX = 0, panY = 0, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
    svg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (e.shiftKey) { panOn = true; panX = e.clientX; panY = e.clientY; } else { bandOn = true; bx0 = bx1 = e.clientX; by0 = by1 = e.clientY; }
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (panOn && pk.view) {
        const wpp = worldPerPx();
        pk.view.x -= (e.clientX - panX) * wpp; pk.view.y += (e.clientY - panY) * wpp;
        panX = e.clientX; panY = e.clientY;
        svg.setAttribute("viewBox", `${pk.view.x} ${-(pk.view.y + pk.view.h)} ${pk.view.w} ${pk.view.h}`);
        return;
      }
      if (!bandOn) return;
      bx1 = e.clientX; by1 = e.clientY;
      const r = stage.getBoundingClientRect();
      band.style.display = "block";
      band.style.left = (Math.min(bx0, bx1) - r.left) + "px"; band.style.top = (Math.min(by0, by1) - r.top) + "px";
      band.style.width = Math.abs(bx1 - bx0) + "px"; band.style.height = Math.abs(by1 - by0) + "px";
    });
    svg.addEventListener("pointerup", (e) => {
      if (panOn) { panOn = false; return; }
      if (!bandOn) return;
      bandOn = false; band.style.display = "none";
      const dist = Math.hypot(bx1 - bx0, by1 - by0);
      if (dist < 4) {
        const w = toWorld(bx0, by0); if (!w) return;
        const thresh = 14 * worldPerPx();
        let best = null, bestD = Infinity;
        for (const el of pickerShown(x, pk)) { const [px, py] = pickCentroid(el); const d = Math.hypot(px - w.x, py - w.y); if (d < bestD) { bestD = d; best = el; } }
        if (best && bestD <= thresh) { if (pk.sel.has(best.id)) pk.sel.delete(best.id); else pk.sel.add(best.id); paint(); }
        return;
      }
      const a = toWorld(bx0, by0), b = toWorld(bx1, by1); if (!a || !b) return;
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      // Рамка ДОБАВЛЯЕТ к уже отмеченному (перенос из V1) — собрать выборку из нескольких участков иначе было бы нечем; снять всё — крестиком у строки списка.
      for (const el of pickerShown(x, pk)) { const [px, py] = pickCentroid(el); if (px >= minX && px <= maxX && py >= minY && py <= maxY) pk.sel.add(el.id); }
      paint();
    });
    svg.addEventListener("wheel", (e) => {
      if (!pk.view || !pk.base) return;
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY); if (!w) return;
      const step = e.deltaY < 0 ? 1 / 1.2 : 1.2;
      const newW = Math.min(pk.base.w, Math.max(pk.base.w / 60, pk.view.w * step));
      const k = newW / pk.view.w;
      pk.view = { x: w.x - (w.x - pk.view.x) * k, y: w.y - (w.y - pk.view.y) * k, w: newW, h: pk.view.h * k };
      svg.setAttribute("viewBox", `${pk.view.x} ${-(pk.view.y + pk.view.h)} ${pk.view.w} ${pk.view.h}`);
    }, { passive: false });
  }

  // ------------------------------------------------------------ отрисовка
  // Три вида документов — три закладки (2026-10-06, запрос пользователя): в каждой свой список, своя кнопка создания и свои колонки.
  const DOC_KINDS = ["supplier_change", "link_swap", "date_rebalance"];
  const TAB_INFO = {
    supplier_change: { new: "Новая замена поставщика", note: "Переводит НЕпоставленные изделия одного контракта на другой (статус ниже «Отгружен», в пределах свободного количества нового контракта)." },
    link_swap: { new: "Новый обмен привязками", note: "Меняет местами изделия ОДНОЙ марки между двумя контрактами: контракт, плановую дату и всю историю статусов — когда привязку перепутали." },
    date_rebalance: { new: "Новая балансировка поставки", note: "Меняет местами изделия одной марки (не смонтированные, включая отгруженные и доставленные): плановая дата, контракт и статус уходят партнёру по паре, чтобы убрать просрочку относительно требуемых дат." },
  };
  const TAB_COLUMNS = {
    supplier_change: [["Текущий поставщик (контрагент)", (d) => d.from_counterparty || "—"], ["Из контракта", (d) => d.from_contract_name],
      ["Новый поставщик (контрагент)", (d) => d.to_counterparty || "—"], ["В контракт", (d) => d.to_contract_name]],
    link_swap: [["Марка", (d) => d.mark || "—"], ["Контракт стороны 1", (d) => d.from_contract_name], ["Контракт стороны 2", (d) => d.to_contract_name]],
    date_rebalance: [["Марка", (d) => d.all_marks ? "Все марки" : (d.mark || "—")], ["Контракт (поставщик)", (d) => d.all_contracts ? `Все контракты${d.pool ? " (общий пул)" : ""}` : d.from_contract_name]],
  };
  function listHtml() {
    if (S.list.error && !S.list.loaded) return `<p class="v2-note">${esc(S.list.error)} <button type="button" class="v2-btn" data-a="reload-list">Повторить</button></p>`;
    if (!S.list.loaded) return `<p class="v2-muted">Загрузка…</p>`;
    // Только виды, которые человеку дано смотреть: сервер отдаёт список при «Чтении» хотя бы одного из разделов, а открыть
    // документ разрешает по разделу ЕГО вида — без отбора строка чужого вида вела бы в отказ 403.
    const kinds = DOC_KINDS.filter(canRead);
    if (!kinds.length) return `<p class="v2-note">Нет права просмотра документов контрактации.</p>`;
    if (!S.tab || !kinds.includes(S.tab)) S.tab = kinds[0];
    const tab = S.tab, info = TAB_INFO[tab], cols = TAB_COLUMNS[tab];
    const rows = S.list.items.filter((d) => d.kind === tab);
    const count = (k) => S.list.items.filter((d) => d.kind === k).length;
    return `<div class="v2-doc-tabs" role="tablist" aria-label="Виды документов">${kinds.map((k) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${esc(KIND_TITLE[k])} <span class="v2-muted">· ${count(k)}</span></button>`).join("")}</div>
      <div class="v2-bar"><h3>${esc(KIND_TITLE[tab])}</h3><div class="v2-inline">
        ${can(tab) ? `<button type="button" class="v2-btn v2-primary" data-a="new-${tab}" ${S.busy ? "disabled" : ""}>${esc(info.new)}</button>` : ""}
      </div></div>
      ${S.listNote ? `<p class="v2-ok" role="status">${esc(S.listNote)}</p>` : ""}
      ${S.list.error ? `<p class="v2-auth-error" role="alert">${esc(S.list.error)}</p>` : ""}
      <p class="v2-muted">${esc(info.note)} Документ — черновик, пока его не проведут.</p>
      ${canAny ? "" : `<p class="v2-note" data-readonly-note>Только просмотр: на этом объекте у вас нет права изменять документы контрактации — создание, правка, подбор, проведение и отмена проведения недоступны.</p>`}
      ${rows.length ? `<table class="v2-table"><thead><tr><th>№</th><th>Дата</th><th>Состояние</th>${cols.map(([h]) => `<th>${esc(h)}</th>`).join("")}<th>Изделий</th><th>Создал</th></tr></thead><tbody>
        ${rows.map((d) => `<tr><td><button type="button" class="v2-link" data-open="${d.id}">${esc(d.number)}</button></td><td>${ruDate(d.doc_date)}</td><td>${esc(d.status_title)}</td>${cols.map(([, f]) => `<td>${esc(f(d))}</td>`).join("")}<td>${d.items}</td><td>${esc(d.created_by || "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="v2-note">Документов этого вида пока нет.</p>`}`;
  }

  function positionsHtml(x, ro) {
    if (x.status === "posted" || ro) {
      return `<h4>Изделия документа (${x.chosen.size})</h4>${x.chosen.size ? `<table class="v2-table"><thead><tr><th>Тип</th><th>Марка</th><th>Адрес</th><th>Статус сейчас</th></tr></thead><tbody>${[...x.chosen.values()].map((e) => `<tr><td>${esc(e.type || "—")}</td><td>${esc(e.mark || "—")}</td><td>${esc(e.address || `№${e.id}`)}</td><td>${esc(STATUS[e.status] || e.status || "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="v2-note">пусто</p>`}`;
    }
    if (!x.from || !x.to) return `<p class="v2-muted">Выберите текущий и новый контракты — ниже появится, что можно перенести.</p>`;
    if (x.from === x.to) return `<p class="v2-muted">Текущий и новый контракты совпадают.</p>`;
    if (x.candLoading) return `<p class="v2-muted">Загрузка…</p>`;
    if (x.candError) return `<p class="v2-auth-error" role="alert">${esc(x.candError)} <button type="button" class="v2-btn" data-a="reload-cand">Повторить</button></p>`;
    if (!x.cand) return "";
    const chosenIn = (p) => p.elements.filter((e) => x.chosen.has(e.id)).length;
    const blocked = x.cand.blocked || [];
    return `<h4>Что переносить</h4>
      ${x.cand.positions.length ? `<table class="v2-table"><thead><tr><th>Тип</th><th>Марка</th><th>Не поставлено</th><th>Свободно в новом контракте</th><th>Выбрано</th><th></th></tr></thead><tbody>
        ${x.cand.positions.map((p, pi) => { const cap = Math.min(p.elements.length, p.available_in_new), open = x.openPos?.has(pi); const n = chosenIn(p);
          return `<tr ${cap ? "" : 'class="v2-muted"'}><td>${esc(p.element_type || "—")}</td><td>${esc(p.mark || "—")}</td><td>${p.elements.length}</td><td>${p.available_in_new}</td>
            <td><input type="number" min="0" max="${cap}" step="1" value="${n}" data-qty="${pi}" aria-label="Сколько перенести: ${esc(p.element_type || "")} ${esc(p.mark || "")}" style="width:80px" ${cap && !S.busy ? "" : "disabled"}></td>
            <td><button type="button" class="v2-btn" data-a="toggle-pos" data-pi="${pi}">${open ? "Скрыть" : "Изделия…"}</button></td></tr>
            ${open ? `<tr><td colspan="6"><div style="max-height:220px;overflow:auto">${p.elements.map((e) => `<label class="v2-role-check" style="padding:4px 0"><input type="checkbox" data-el="${e.id}" data-pi="${pi}" ${x.chosen.has(e.id) ? "checked" : ""} ${cap && !S.busy ? "" : "disabled"}><span>${esc(elLabel({ ...e, status: e.current_status }))}</span></label>`).join("")}</div></td></tr>` : ""}`; }).join("")}</tbody></table>`
        : `<p class="v2-note">На текущем контракте нет изделий, доступных к переносу: либо ничего не привязано, либо всё уже поставлено на площадку.</p>`}
      ${blocked.length ? `<p class="v2-muted"><b>Не переносится: ${blocked.reduce((s, b) => s + b.count, 0)} шт.</b> — статус «${esc(x.cand.blocked_from_label)}» и выше, изделия уже поставлены на площадку: ${blocked.map((b) => `${esc(b.element_type || "—")} · ${esc(b.mark || "—")} — ${b.count}`).join("; ")}.</p>` : ""}`;
  }

  function swapHtml(x, ro) {
    const sideBox = (sideKey, title, list, other) => `<div><h4>${title}: ${list.length} шт.</h4>${list.length ? list.map((e, i) => `<div class="v2-inline" style="margin:2px 0"><span class="v2-tag">${i + 1}</span><span title="${esc(elLabel(e))}">${esc(elLabel(e))}</span>${i >= other.length ? ' <small class="v2-auth-error">без пары</small>' : ""}${ro ? "" : `<button type="button" class="v2-btn" data-a="mv" data-side="${sideKey}" data-i="${i}" data-d="-1" ${S.busy ? "disabled" : ""} aria-label="Выше">↑</button><button type="button" class="v2-btn" data-a="mv" data-side="${sideKey}" data-i="${i}" data-d="1" ${S.busy ? "disabled" : ""} aria-label="Ниже">↓</button><button type="button" class="v2-btn" data-a="rm" data-side="${sideKey}" data-i="${i}" ${S.busy ? "disabled" : ""} aria-label="Убрать">✕</button>`}</div>`).join("") : `<p class="v2-muted">пусто${ro ? "" : " — нажмите «Подбор…»"}</p>`}
      ${ro ? "" : `<button type="button" class="v2-btn" data-a="pick" data-side="${sideKey}" ${S.busy || !x.mark || !(sideKey === "a" ? x.from : x.to) ? "disabled" : ""}>Подбор…</button>`}</div>`;
    const pk = ro ? null : x.picker;    // только для просмотра подбор не показывается вовсе — выбор менять нечем и некому
    // Мини-схема слева, список — рядом справа (перенос из V1 scd-picker: клик/рамка по фигурам и список — два способа ОДНОГО
    // выбора, синхронизированные тем, что оба читают и пишут `pk.sel`). Список остаётся ДОПОЛНИТЕЛЬНЫМ способом — не убран.
    const pickerHtml = !pk ? "" : `<div class="v2-callout" role="group" aria-label="Подбор изделий">
      <strong>Подбор изделий стороны ${pk.side === "a" ? "1" : "2"}</strong>
      ${pk.loading ? `<p class="v2-muted">Загрузка…</p>` : pk.error ? `<p class="v2-auth-error" role="alert">${esc(pk.error)}</p>` : (() => {
        const shown = pickerShown(x, pk);
        return `<div class="v2-inline"><label>Этаж <select data-pk-floor aria-label="Этаж"><option value="">все</option>${(pk.floors || []).map((fl) => `<option value="${esc(fl)}" ${pk.floor === String(fl) ? "selected" : ""}>${esc(fl)}</option>`).join("")}</select></label>
          <button type="button" class="v2-btn" data-a="pk-all">Отметить все показанные</button><span class="v2-muted">Показано: ${shown.length}, отмечено: ${pk.sel.size}</span></div>
          <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px;align-items:start;margin-top:6px">
            <div>${pickerSvgHtml(x, pk)}</div>
            <div style="max-height:320px;overflow:auto">${shown.map((e) => `<label class="v2-role-check" style="padding:3px 0"><input type="checkbox" data-pk-el="${e.id}" ${pk.sel.has(e.id) ? "checked" : ""}><span>${esc(elLabel(e))}${e.planned ? ` · план ${ruDate(e.planned)}` : ""}</span></label>`).join("") || '<p class="v2-muted">Нет подходящих изделий (уже выбраны или не на этом контракте).</p>'}</div>
          </div>`;
      })()}
      <div class="v2-inline" style="margin-top:8px"><button type="button" class="v2-btn v2-primary" data-a="pk-apply" ${pk.sel.size ? "" : "disabled"}>Добавить в документ</button><button type="button" class="v2-btn" data-a="pk-cancel">Отмена</button></div></div>`;
    const pairs = Math.min(x.sideA.length, x.sideB.length), equal = x.sideA.length === x.sideB.length && x.sideA.length > 0;
    return `<div class="v2-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">${sideBox("a", "Сторона 1", x.sideA, x.sideB)}${sideBox("b", "Сторона 2", x.sideB, x.sideA)}</div>${pickerHtml}
      <p class="${equal ? "v2-muted" : "v2-auth-error"}">${equal ? `Пар к обмену: ${pairs}` : `Сторона 1: ${x.sideA.length} шт., сторона 2: ${x.sideB.length} шт.${x.sideA.length || x.sideB.length ? " — количества не совпадают, провести нельзя" : ""}`}</p>`;
  }

  // Табличная часть балансировки — ПАРЫ изделий, поменявшихся местами (2026-10-06): в строке видно, с кем изделие обменялось статусом и
  // плановой датой. Пары сгруппированы: поставщик → контракт → марка (по ведущему изделию пары), группы сворачиваются; уровень, на котором
  // у документа одно значение, не показывается; без уровней — плоская таблица. Изделия без обмена скрыты, пока не включена галочка.
  const isPairRow = (i) => !!(i.partner_id || i.pair_no);
  function rbGrouped(x, allRows, head, rowHtml, summary) {
    const rows = allRows.filter((i) => isPairRow(i) || x.rbAll === true);   // без обмена — только по галочке
    if (!rows.length) return `<p class="v2-muted">Пар нет.</p>`;
    const norm = (v) => String(v ?? "—").trim() || "—";
    const levels = [["counterparty", "Поставщик"], ["contract_name", "Контракт"], ["mark", "Марка"]]
      .filter(([k]) => new Set(rows.map((i) => norm(i[k]).toLowerCase())).size > 1);
    const table = (list) => `<table class="v2-table"><thead><tr>${head}</tr></thead><tbody>${list.map(rowHtml).join("")}</tbody></table>`;
    if (!levels.length) return `<div style="max-height:520px;overflow:auto">${table(rows)}</div>`;
    const isOpen = (key, depth) => {
      const def = x.rbMode === "all" ? true : x.rbMode === "none" ? false : depth < levels.length - 1;
      return x.rbOpen.has(key) ? !def : def;
    };
    function level(list, depth, path) {
      if (depth === levels.length) return `<div class="v2-rb-body">${table(list)}</div>`;
      const [field, title] = levels[depth], groups = new Map();
      for (const i of list) { const k = norm(i[field]); if (!groups.has(k.toLowerCase())) groups.set(k.toLowerCase(), { name: k, list: [] }); groups.get(k.toLowerCase()).list.push(i); }
      return [...groups].map(([lk, g]) => {
        const key = `${path}/${lk}`, open = isOpen(key, depth);
        return `<div class="v2-rb-grp v2-rb-d${depth}"><button type="button" class="v2-rb-toggle" data-a="rb-toggle" data-k="${esc(key)}" data-d="${depth}" aria-expanded="${open}"><span aria-hidden="true">${open ? "▾" : "▸"}</span> <small>${title}</small> <b>${esc(g.name)}</b></button><span class="v2-rb-cells">${summary(g.list).map(([k, v]) => `<span class="v2-rb-m"><small>${k}</small>${v}</span>`).join("")}</span></div>${open ? `<div class="v2-rb-sub">${level(g.list, depth + 1, key)}</div>` : ""}`;
      }).join("");
    }
    return `<div class="v2-rb-tools"><button type="button" class="v2-btn" data-a="rb-expand" data-m="all">Развернуть всё</button><button type="button" class="v2-btn" data-a="rb-expand" data-m="none">Свернуть всё</button></div>${level(rows, 0, "")}`;
  }
  const stLabel = (c) => STATUS[c] || c || "—";
  const moved = (a, b) => a === b ? esc(a) : `${esc(a)} → <b>${esc(b)}</b>`;

  function rebalanceHtml(x, ro) {
    if (x.status === "posted" || ro) {
      const items = x.items || [], byPair = new Map();
      for (const i of items) if (i.pair_no && i.side === 2) byPair.set(i.pair_no, i);
      const rows = items.filter((i) => !i.pair_no || i.side === 1).sort((p, q) => (p.pair_no ?? 1e9) - (q.pair_no ?? 1e9));
      const head = `<th>№</th><th>Изделие</th><th>Статус</th><th>Плановая дата</th><th></th><th>Поменялось местами с</th><th>Статус</th><th>Плановая дата</th>`;
      const cell = (i) => `<td>${esc(i.address || "№" + i.element_id)}<br><small class="v2-muted">этаж ${esc(i.floor ?? "—")}${i.contract_name ? " · " + esc(i.contract_name) : ""}</small></td><td>${moved(stLabel(i.status_at_move || i.current_status), stLabel(i.current_status))}</td><td>${moved(i.prev_plan ? ruDate(i.prev_plan) : "—", i.plan_now ? ruDate(i.plan_now) : "—")}</td>`;
      const row = (i) => { const q = i.pair_no ? byPair.get(i.pair_no) : null; return `<tr><td>${i.pair_no ?? "—"}</td>${cell(i)}<td>${q ? "⇄" : ""}</td>${q ? cell(q) : `<td colspan="3" class="v2-muted">без обмена</td>`}</tr>`; };
      const sum = (l) => [["пар", l.filter((i) => i.pair_no).length]];
      const без = rows.filter((i) => !i.pair_no).length;
      return `<h4>Изделия документа (${items.length})</h4>${items.length ? `${без ? `<label class="v2-role-check"><input type="checkbox" data-a="rb-singles" ${x.rbAll === true ? "checked" : ""}><span>Показывать и изделия без обмена (${без})</span></label>` : ""}${rbGrouped(x, rows, head, row, sum)}` : ""}${x.status === "posted" ? "" : `<p class="v2-muted">Пары, статусы и колонка «было» заполняются при проведении.</p>`}`;
    }
    if (!x.from) return `<p class="v2-muted">Выберите контракт (поставщика) и марку — или «Все контракты» / «Все марки» — ниже появится, какие изделия поменяются местами.</p>`;
    if (!x.mark) return `<p class="v2-muted">Выберите марку или «Все марки».</p>`;
    if (x.rbLoading) return `<p class="v2-muted">Расчёт…</p>`;
    if (x.rbError) return `<p class="v2-auth-error" role="alert">${esc(x.rbError)} <button type="button" class="v2-btn" data-a="reload-rb">Повторить</button></p>`;
    if (!x.rb) return "";
    const sm = x.rb.summary, items = x.rb.items;
    if (!items.length) return `<p class="v2-note">Подходящих изделий нет: нужны изделия на контракте, ещё не смонтированные (в том числе отгруженные и доставленные), с плановой датой поставки и такие, у которых обмен местами убирает просрочку.</p>`;
    const dl = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}`;
    const byId = new Map(items.map((i) => [i.element_id, i]));
    const rows = items.filter((i) => i.lead || !i.partner_id);
    const single = rows.filter((i) => !i.partner_id).length;
    const head = `<th>№</th><th>Изделие</th><th>Статус</th><th>Плановая дата</th><th>Откл., дн.</th><th></th><th>Поменяется местами с</th><th>Статус</th><th>Плановая дата</th><th>Откл., дн.</th><th>Опоздание сокращено</th>`;
    const cell = (i, other) => `<td>${esc(i.address || "№" + i.element_id)}<br><small class="v2-muted">этаж ${esc(i.floor ?? "—")}${other && other.contract_name !== i.contract_name ? " · " + esc(i.contract_name) : ""}</small></td><td>${moved(stLabel(i.status), stLabel(i.status_new))}</td><td>${moved(ruDate(i.plan_old), ruDate(i.plan_new))}</td><td>${moved(dl(i.delay_old), dl(i.delay_new))}</td>`;
    const row = (a) => { const q = a.partner_id ? byId.get(a.partner_id) : null;
      return `<tr style="${q ? "font-weight:600" : ""}"><td>${a.pair_no ?? "—"}</td>${cell(a, null)}<td>${q ? "⇄" : ""}</td>${q ? cell(q, a) + `<td class="v2-rb-gain">${gainHtml(lateDays(a, q, "delay_old") - lateDays(a, q, "delay_new"))}</td>` : `<td colspan="5" class="v2-muted">без обмена</td>`}</tr>`; };
    // Опоздание = плановая дата позже требуемой; «сокращено» — на сколько дней оно уменьшилось у обоих изделий пары
    const late = (i, k) => Math.max(0, i?.[k] ?? 0);
    const lateDays = (a, q, k) => late(a, k) + late(q, k);
    const gainHtml = (d) => d > 0 ? `<b class="v2-good">−${d} дн.</b>` : d < 0 ? `<b class="v2-bad">+${-d} дн.</b>` : `<span class="v2-muted">0</span>`;
    const gsum = (l) => { const pr = l.filter((i) => i.partner_id), all = l.flatMap((i) => i.partner_id ? [i, byId.get(i.partner_id)] : [i]);
      const dB = all.reduce((n, i) => n + late(i, "delay_old"), 0), dA = all.reduce((n, i) => n + late(i, "delay_new"), 0);
      return [["пар", pr.length], ["просрочено изд.", `${all.filter((i) => i.delay_old > 0).length} → ${all.filter((i) => i.delay_new > 0).length}`],
        ["опоздание, дн.", `${dB} → ${dA}`], ["сокращено", gainHtml(dB - dA)]]; };
    const tile = (k, v, sub = "") => `<div class="v2-rb-tile"><small>${k}</small><b>${v}</b>${sub ? `<span class="v2-muted">${sub}</span>` : ""}</div>`;
    const saved = sm.late_days_before - sm.late_days_after;
    return `<h4>Что изменится</h4>
      <div class="v2-rb-tiles">${tile("Пар к обмену", sm.pairs, `${sm.pairs * 2} из ${sm.count} изд.`)}${tile("Просрочено изделий", `${sm.late_before} → ${sm.late_after}`, `−${sm.late_before - sm.late_after}`)}${tile("Суммарное опоздание", `${sm.late_days_before} → ${sm.late_days_after} дн.`, "сумма по изделиям")}${tile("Опоздание сокращено", `<span class="v2-good">−${saved} дн.</span>`, saved > 0 && sm.late_days_before ? `на ${Math.round(saved * 100 / sm.late_days_before)} %` : "")}${tile("Максимальное опоздание", `${sm.max_delay_before} → ${sm.max_delay_after} дн.`)}</div>
      <p class="v2-muted">Изделия меняются местами: плановая дата, контракт и вся история статусов уходят к партнёру, текущий статус пересчитывается.${sm.without_need ? ` У ${sm.without_need} изд. нет требуемой даты (нет в актуализации графика) — они могут быть только партнёром.` : ""}</p>
      <label class="v2-role-check"><input type="checkbox" data-a="rb-only" ${x.rbAll !== true ? "checked" : ""}><span>Показывать только изделия, поменявшиеся местами (скрыто без обмена: ${sm.count - sm.pairs * 2})</span></label>
      ${rbGrouped(x, rows, head, row, gsum)}`;
  }

  function docHtml() {
    const x = f(); if (!x) return "";
    const posted = x.status === "posted";
    const viewOnly = !can(x.kind);       // нет права изменять документы этого вида — только просмотр
    const ro = posted || viewOnly;
    const swap = x.kind === "link_swap";
    const rb = x.kind === "date_rebalance";
    const dis = ro || S.busy ? "disabled" : "";
    const onlyB = swap ? new Set([...x.sideBCounts.keys()]) : null;
    // Только просмотр: выбор контракта и марки показывается одной строкой — тем, что записано в документе (контракты объекта
    // читателю не запрашиваются, см. шапку файла). Пишущему — прежние списки.
    const fixed = (value, label) => `<option value="${esc(value)}" selected>${esc(label)}</option>`;
    const rbOpts = () => {
      const groups = new Map();
      for (const c of S.rbCands || []) { if (!groups.has(c.counterparty)) groups.set(c.counterparty, []); groups.get(c.counterparty).push(c); }
      const main = (c) => { const k = contractById(c.contract_id); return k ? contractLabel(k) : c.name; };
      const label = (c) => `${main(c)} — к балансировке: ${c.changed} изд.${c.late ? `, просрочено ${c.late}` : ""}`;
      const cs = S.rbCands || [];
      return `<option value="">${groups.size ? "— выберите —" : "— нет контрактов, по которым есть что балансировать —"}</option>`
        + `<option value="${RB_ALL}" data-main="Все контракты" data-c="${rbSum(cs, "changed")}|${rbSum(cs, "late")}" ${x.from === RB_ALL ? "selected" : ""}>Все контракты — к балансировке: ${rbSum(cs, "changed")} изд.${rbSum(cs, "late") ? `, просрочено ${rbSum(cs, "late")}` : ""}</option>`
        + [...groups].map(([cp, list]) => `<optgroup label="${esc(cp)}">${list.map((c) => `<option value="${c.contract_id}" data-main="${esc(main(c))}" data-c="${c.changed}|${c.late}" ${String(x.from) === String(c.contract_id) ? "selected" : ""}>${esc(label(c))}</option>`).join("")}</optgroup>`).join("")
        + (x.from && x.from !== RB_ALL && !rbCandOf(x.from) ? fixed(x.from, (x.head?.from_contract_name || contractById(x.from)?.agreement_number || "контракт " + x.from) + " — балансировать уже нечего") : "");
    };
    const fromOpts = x.kind === "date_rebalance" && !viewOnly ? rbOpts() : viewOnly ? fixed(x.from, x.from === RB_ALL ? "Все контракты" : (x.head?.from_contract_name || "контракт " + x.from))
      : `${contractOptions(x.from)}${x.from && !contractById(x.from) ? fixed(x.from, x.head?.from_contract_name || "контракт " + x.from) : ""}`;
    const toOpts = viewOnly ? fixed(x.to, x.head?.to_contract_name || "контракт " + x.to)
      : `${contractOptions(x.to, swap && !ro ? onlyB : null)}${x.to && !contractById(x.to) ? fixed(x.to, x.head?.to_contract_name || "контракт " + x.to) : ""}`;
    const rbMarkOpts = () => {
      const marks = rbMarksOf(x.from, x.pool);
      return `<option value="">${x.from ? (marks.length ? "— выберите марку —" : "— нет марок для балансировки —") : "— сначала контракт —"}</option>`
        + (x.from ? `<option value="${RB_ALL}" data-main="Все марки" data-c="${rbSum(marks, "changed")}|${rbSum(marks, "count")}|${rbSum(marks, "late")}" ${x.mark === RB_ALL ? "selected" : ""}>Все марки · к балансировке: ${rbSum(marks, "changed")} из ${rbSum(marks, "count")} изд.${rbSum(marks, "late") ? `, просрочено ${rbSum(marks, "late")}` : ""}</option>` : "")
        + marks.map((m) => `<option value="${esc(m.mark)}" data-main="${esc(m.mark)}" data-c="${m.changed}|${m.count}|${m.late}" ${m.mark === x.mark ? "selected" : ""}>${esc(m.mark)} · к балансировке: ${m.changed} из ${m.count} изд.${m.late ? `, просрочено ${m.late}` : ""}</option>`).join("")
        + (x.mark && x.mark !== RB_ALL && !marks.some((m) => m.mark === x.mark) ? fixed(x.mark, `${x.mark} — балансировать уже нечего`) : "");
    };
    const markOpts = x.kind === "date_rebalance" && !viewOnly ? rbMarkOpts() : viewOnly ? fixed(x.mark, x.mark === RB_ALL ? "Все марки" : (x.mark || "—"))
      : `<option value="">${x.from ? "— выберите марку —" : "— сначала контракт стороны 1 —"}</option>${x.marks.map((m) => `<option value="${esc(m.mark)}" ${m.mark === x.mark ? "selected" : ""}>${esc(m.mark)} · ${esc(m.element_type || "—")} · ${m.count} шт.</option>`).join("")}${x.mark && !x.marks.some((m) => m.mark === x.mark) ? fixed(x.mark, x.mark) : ""}`;
    const note = posted
      ? `Проведён: ${esc(x.posted?.by || "—")}${x.posted?.at ? " · " + ruMoment(x.posted.at) : ""}. Пока документ проведён, его состав не правится${viewOnly ? "." : " — сначала отмените проведение."}`
      : (viewOnly ? "Черновик: данные изделий он не менял — изменения вносит проведение." : "Черновик данные изделий не меняет — изменения вносит кнопка «Провести».");
    return `<div class="v2-bar v2-doc-head"><h3>${esc(KIND_TITLE[x.kind])} — ${x.id ? `№ ${esc(x.number)} от ${ruDate(x.date)}` : "новый документ"} <span class="v2-tag">${x.id ? (posted ? "Проведён" : "Черновик") : "Черновик (не сохранён)"}</span>${viewOnly ? ` <span class="v2-tag" data-readonly-tag>Только просмотр</span>` : ""}</h3><div class="v2-foot-actions v2-doc-actions" id="sd-head-actions"><span class="v2-muted" id="sd-head-status" role="status"></span>${footHtml()}<button type="button" class="v2-btn" data-a="back" ${S.busy ? "disabled" : ""}>← К списку</button></div></div>
      <p class="v2-muted">${note}</p>
      <div class="v2-fields" style="max-width:none; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))">
        <label class="v2-field">Дата документа<input type="date" data-f="date" value="${esc(x.date)}" ${dis}></label>
        <label class="v2-field">Номер (пусто — выдаст сервер)<input data-f="number" value="${esc(x.number)}" maxlength="30" ${dis} placeholder="авто"></label>
        <label class="v2-field">${swap ? "Контракт стороны 1" : rb ? "Контракт (поставщик)" : "Текущий поставщик (контракт)"}<select data-f="from" ${dis}${x.kind === "date_rebalance" && !viewOnly ? ' data-cs-heads="К балансировке, изд.|Просрочено"' : ""}>${fromOpts}</select></label>
        ${swap || rb ? `<label class="v2-field">${rb ? "Марка" : "Марка обмена"}<select data-f="mark" ${dis || (!x.from ? "disabled" : "")}${x.kind === "date_rebalance" && !viewOnly ? ' data-cs-heads="К балансировке|Всего|Просрочено"' : ""}>${markOpts}</select>${x.marksError ? `<small class="v2-auth-error">${esc(x.marksError)}</small>` : ""}</label>` : ""}
        ${rb && x.from === RB_ALL ? `<label class="v2-role-check v2-span"><input type="checkbox" data-a="rb-pool" ${x.pool ? "checked" : ""} ${dis}><span>Общий пул дат: изделия одной марки делят плановые даты разных контрактов (даты переходят между контрактами; контракт изделия не меняется). Без галочки каждый контракт балансируется отдельно.</span></label>` : ""}
        ${rb ? "" : `<label class="v2-field">${swap ? "Контракт стороны 2 (только с этой маркой)" : "Новый поставщик (контракт)"}<select data-f="to" ${dis || (swap && (!x.from || !x.mark) ? "disabled" : "")}>${toOpts}</select>${x.sideBError ? `<small class="v2-auth-error">${esc(x.sideBError)}</small>` : ""}${swap && !ro && x.from && x.mark && !x.sideBCounts.size && !x.sideBError ? `<small class="v2-muted">Марка «${esc(x.mark)}» больше нигде на объекте к контрактам не привязана.</small>` : ""}</label>`}
        <label class="v2-field v2-span">Причина<input data-f="reason" value="${esc(x.reason)}" ${dis} maxlength="300"></label>
        <label class="v2-field v2-span">Комментарий<input data-f="comment" value="${esc(x.comment)}" ${dis} maxlength="600"></label>
      </div>
      <div style="margin-top:16px">${swap ? swapHtml(x, ro) : rb ? rebalanceHtml(x, ro) : positionsHtml(x, ro)}</div>
      ${x.error ? `<p class="v2-auth-error" role="alert" style="margin-top:12px">${esc(x.error)}</p>` : ""}
      ${S.message ? `<p class="v2-ok" role="status" style="margin-top:12px">${esc(S.message)}</p>` : ""}`;
  }

  function footHtml() {
    if (S.view !== "doc" || !f()) return "";
    const x = f(), busy = S.busy, dirty = isDirty(), writable = can(x.kind);
    if (!writable) return `<span class="v2-muted" data-readonly-foot>Только просмотр: нет права изменять документы этого вида на объекте.</span>`;
    const b = (label, act, primary, extra = "") => `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" data-a="${act}" ${busy || extra ? "disabled" : ""}>${label}</button>`;
    if (x.status === "posted") return b("Отменить проведение", "unpost", false);
    const swapPairsOk = x.kind !== "link_swap" || (x.sideA.length === x.sideB.length && x.sideA.length > 0);
    const supplierOk = !single(x.kind) || x.chosen.size > 0;
    return [x.id ? b("Удалить черновик", "delete", false) : "", b(busy ? "Сохранение…" : "Сохранить", "save", true, dirty ? "" : "1"),
      x.id ? b("Провести", "post", true, dirty || !swapPairsOk || !supplierOk ? "1" : "") : ""].join("");
  }

  function paint() {
    if (dead) return;
    const active = document.activeElement;
    const keep = active && inner.contains(active) ? { sel: active.getAttribute("data-f") ? `[data-f="${active.getAttribute("data-f")}"]` : null, pos: active.selectionStart } : null;
    inner.innerHTML = S.view === "list" ? listHtml() : docHtml();
    foot.innerHTML = "";   // кнопки управления документом — в его шапке (docHtml), нижняя панель скрыта
    const dirty = isDirty();
    setStatusText(S.busy ? "Выполняется запись — дождитесь ответа сервера…" : (dirty ? "Есть несохранённые изменения" : ""));
    bind();
    if (keep?.sel) { const el = inner.querySelector(keep.sel); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) { /* не текстовое поле */ } } }
  }

  function bind() {
    const x = f();
    for (const el of container.querySelectorAll("[data-a]")) el.addEventListener("click", () => onAction(el.dataset.a, el.dataset));
    for (const el of inner.querySelectorAll("[data-open]")) el.addEventListener("click", () => openDoc(Number(el.dataset.open)));
    // Выбор контракта и марки балансировки — списком с колонками (числа выровнены вправо), общий модуль column-select.js
    const colSelects = inner.querySelectorAll("select[data-cs-heads]");
    if (colSelects.length) import("/static/column-select.js").then((m) => { m.closeColumnSelectPopup(); colSelects.forEach((sel) => { if (sel.isConnected) m.attachColumnSelect(sel); }); });
    for (const el of inner.querySelectorAll("[data-tab]")) el.addEventListener("click", () => { S.tab = el.dataset.tab; S.listNote = ""; paint(); });
    if (!x) return;
    for (const el of inner.querySelectorAll("[data-f]")) el.addEventListener(el.tagName === "SELECT" || el.type === "date" ? "change" : "input", async () => {
      const k = el.dataset.f;
      if (k === "date" || k === "number" || k === "reason" || k === "comment") { x[k] = el.value; x.error = ""; paintFoot(); return; }
      x[k] = el.value; x.error = ""; S.message = "";
      if (x.kind === "date_rebalance" && (k === "from" || k === "mark")) {
        x.chosen.clear(); x.rb = null; x.picker = null;
        if (k === "from") { x.mark = ""; await loadMarks(false); } else await loadRebalance(false);
        paint(); return;
      }
      if (k === "from") {
        if (x.kind === "supplier_change") { x.chosen.clear(); await loadCandidates(); }
        else { x.mark = ""; x.to = ""; x.sideA = []; x.sideB = []; x.picker = null; await loadMarks(false); }
      } else if (k === "to") {
        if (x.kind === "supplier_change") { x.chosen.clear(); await loadCandidates(); }
        else { x.sideB = []; x.picker = null; paint(); }
      } else if (k === "mark") { x.to = ""; x.sideA = []; x.sideB = []; x.picker = null; await loadSideB(); }
      paint();
    });
    for (const el of inner.querySelectorAll("[data-qty]")) el.addEventListener("change", () => {
      const p = x.cand.positions[Number(el.dataset.qty)];
      const cap = Math.min(p.elements.length, p.available_in_new), n = Math.max(0, Math.min(cap, Math.floor(Number(el.value) || 0)));
      for (const e of p.elements) x.chosen.delete(e.id);
      for (const e of p.elements.slice(0, n)) x.chosen.set(e.id, { id: e.id, type: e.element_type, mark: e.mark, address: e.address, status: e.current_status });
      x.error = ""; paint();
    });
    for (const el of inner.querySelectorAll("input[data-el]")) el.addEventListener("change", () => {
      const p = x.cand.positions[Number(el.dataset.pi)], e = p.elements.find((q) => q.id === Number(el.dataset.el));
      const cap = Math.min(p.elements.length, p.available_in_new);
      if (el.checked) {
        if (p.elements.filter((q) => x.chosen.has(q.id)).length >= cap) { el.checked = false; x.error = `Позиция «${p.element_type || "—"} / ${p.mark || "—"}»: в новом контракте свободно ${p.available_in_new} шт.`; paint(); return; }
        x.chosen.set(e.id, { id: e.id, type: e.element_type, mark: e.mark, address: e.address, status: e.current_status });
      } else x.chosen.delete(e.id);
      x.error = ""; paint();
    });
    const pk = x.picker;
    if (pk) {
      // Смена этажа — новый охват мини-схемы, вид сбрасывается на весь этаж (как в V1: scdRenderPicker(false) не сохраняет масштаб).
      inner.querySelector("[data-pk-floor]")?.addEventListener("change", (e) => { pk.floor = e.target.value; pk.view = null; paint(); });
      for (const el of inner.querySelectorAll("[data-pk-el]")) el.addEventListener("change", () => { const id = Number(el.dataset.pkEl); if (el.checked) pk.sel.add(id); else pk.sel.delete(id); paint(); });
      bindPickerSvg(x, pk);
    }
  }
  // Кнопки управления документом (сохранить, провести, удалить) стоят в шапке документа (2026-10-06, запрос пользователя); при вводе
  // в поля шапки обновляется только их состояние, без перерисовки формы.
  function setStatusText(text) {
    const head = inner.querySelector("#sd-head-status");
    if (head) { head.textContent = text; statusEl.textContent = ""; } else statusEl.textContent = text;
  }
  function paintFoot() {
    const box = inner.querySelector("#sd-head-actions");
    if (box) {
      const status = box.querySelector("#sd-head-status")?.textContent || "";
      box.innerHTML = `<span class="v2-muted" id="sd-head-status" role="status"></span>${footHtml()}<button type="button" class="v2-btn" data-a="back" ${S.busy ? "disabled" : ""}>← К списку</button>`;
      for (const el of box.querySelectorAll("[data-a]")) el.addEventListener("click", () => onAction(el.dataset.a, el.dataset));
    }
    setStatusText(isDirty() ? "Есть несохранённые изменения" : "");
  }

  function onAction(a, d) {
    const x = f();
    if (a === "reload-list") { S.list.error = ""; loadList().then(paint); return; }
    if (a === "new-supplier_change" || a === "new-link_swap" || a === "new-date_rebalance") { newDoc(a.slice(4)); return; }
    if (a === "back") { backToList(false); return; }
    if (!x) return;
    // Документ вида, который изменять не дано: кнопок записи и подбора нет в разметке, но и прочие пути к ним закрыты здесь
    if (!can(x.kind) && a !== "toggle-pos" && a !== "rb-toggle" && a !== "rb-expand" && a !== "rb-singles") return;
    if (a === "save") saveDraft();
    else if (a === "post") postOrUnpost(false);
    else if (a === "unpost") postOrUnpost(true);
    else if (a === "delete") deleteDraft();
    else if (a === "reload-cand") loadCandidates();
    else if (a === "reload-rb") loadRebalance(false);
    else if (a === "rb-only") { x.rbAll = !x.rbAll; paint(); }
    else if (a === "rb-singles") { x.rbAll = !x.rbAll; paint(); }
    else if (a === "rb-toggle") { if (x.rbOpen.has(d.k)) x.rbOpen.delete(d.k); else x.rbOpen.add(d.k); paint(); }
    else if (a === "rb-expand") { x.rbMode = d.m; x.rbOpen.clear(); paint(); }
    else if (a === "rb-pool") {
      x.pool = !x.pool; x.chosen.clear(); x.rb = null; x.error = "";
      const marks = rbMarksOf(x.from, x.pool);
      if (x.mark && x.mark !== RB_ALL && !marks.some((m) => m.mark === x.mark)) x.mark = "";
      loadMarks(false);
    }
    else if (a === "toggle-pos") { x.openPos = x.openPos || new Set(); const i = Number(d.pi); if (x.openPos.has(i)) x.openPos.delete(i); else x.openPos.add(i); paint(); }
    else if (a === "pick") openPicker(d.side);
    else if (a === "pk-cancel") { x.picker = null; paint(); }
    else if (a === "pk-all" && x.picker) { for (const e of pickerShown(x, x.picker)) x.picker.sel.add(e.id); paint(); }
    else if (a === "pk-apply" && x.picker) {
      const list = x.picker.side === "a" ? x.sideA : x.sideB;
      for (const e of x.picker.all) if (x.picker.sel.has(e.id)) list.push(e);
      x.picker = null; x.error = ""; paint();
    } else if (a === "mv" || a === "rm") {
      const list = d.side === "a" ? x.sideA : x.sideB, i = Number(d.i);
      if (a === "rm") list.splice(i, 1);
      else { const j = i + Number(d.d); if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]]; }
      x.error = ""; paint();
    }
  }

  // ------------------------------------------------------------ жизненный цикл модуля
  async function guardLeave() {
    if (S.busy) return false;
    if (!isDirty()) return true;
    const choice = await showUnsavedDialog(`В документе есть несохранённые изменения.`);
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    return await saveDraft();
  }
  (async () => {
    S.busy = true; paint();
    // контракты объекта и цвета мини-схемы нужны только правке и подбору — читателю их не запрашиваем (сервер отдал бы 403 на /refs)
    await Promise.all([loadList(), canAny ? loadRefs() : null, canAny ? loadColors() : null]);
    S.busy = false; paint();
  })();

  return {
    hasUnsavedChanges: () => isDirty() || S.busy,
    guardLeave: async () => { if (S.busy) { await showInfoDialog("Идёт запись — дождитесь ответа сервера."); return false; } return guardLeave(); },
    destroy: () => { dead = true; },
  };
}
