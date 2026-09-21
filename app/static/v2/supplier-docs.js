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
import { showUnsavedDialog, showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const ruMoment = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : ruDate(v); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const STATUS = { planned: "Запланирован", contracting: "Контрактация", in_production: "В производстве", shipped: "Отгружен", delivered: "Доставлен", installed: "Смонтирован", accepted: "Принят" };
const KIND_TITLE = { supplier_change: "Замена поставщика", link_swap: "Обмен привязками" };
const KIND_FEATURE = { supplier_change: "doc_supplier_change", link_swap: "doc_link_swap" };
const isStale = (err) => err instanceof ApiError && err.status === 409 && err.rawDetail && typeof err.rawDetail === "object" && err.rawDetail.conflict === "stale_version";

export function mountSupplierDocs(container, { screen, objectId, api, rights, groupTitle }) {
  let dead = false;
  const can = (kind) => !!rights?.system_admin || (rights?.features || {})[KIND_FEATURE[kind]] === "write";
  const canAny = can("supplier_change") || can("link_swap");

  const S = {
    view: "list",                       // "list" | "doc"
    list: { loaded: false, error: "", items: [] },
    refs: { loaded: false, error: "", contracts: [] },
    f: null,                            // форма открытого документа
    busy: false,                        // идёт запись — все действия документа заблокированы (ставится ДО первого await)
    message: "",                        // итог последней операции (строка статуса)
    listNote: "",
  };

  container.className = "v2-page v2-app";
  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container"><h2>${esc(screen.title)}</h2></div></div>
    <div id="sd-body" class="v2-scroll"><div id="sd-inner" class="v2-container"></div></div>
    <footer class="v2-foot"><div class="v2-container"><span id="sd-status" class="v2-muted" role="status" aria-live="polite"></span><div class="v2-foot-actions" id="sd-foot"></div></div></footer>`;
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
      picker: null,                     // {side, all, floor, sel:Set, error, loading}
      posted: null, saved: null, error: "" };
  }
  function fingerprint(x) {
    return JSON.stringify([x.number.trim(), x.date, x.reason.trim(), x.comment.trim(), String(x.from), String(x.to), x.kind === "link_swap" ? x.mark : "",
      x.kind === "supplier_change" ? [...x.chosen.keys()].sort((a, b) => a - b) : [x.sideA.map((e) => e.id), x.sideB.map((e) => e.id)]]);
  }
  const isDirty = () => S.view === "doc" && !!f() && f().status === "draft" && fingerprint(f()) !== f().saved;
  function fromDoc(d) {
    const x = blankForm(d.kind);
    Object.assign(x, { id: d.id, status: d.status, version: d.version, number: d.number, date: d.doc_date, reason: d.reason || "", comment: d.comment || "",
      from: String(d.from_contract_id), to: String(d.to_contract_id), mark: d.mark || "", posted: d.status === "posted" ? { by: d.posted_by, at: d.posted_at } : null, head: d });
    const info = (i) => ({ id: i.element_id, type: i.element_type, mark: i.mark, address: i.address, floor: i.floor, status: i.current_status });
    if (d.kind === "supplier_change") for (const i of d.items) x.chosen.set(i.element_id, info(i));
    else { x.sideA = d.items.filter((i) => i.side === 1).map(info); x.sideB = d.items.filter((i) => i.side === 2).map(info); }
    x.saved = fingerprint(x);
    return x;
  }

  async function openDoc(id) {
    if (S.busy) return;
    S.busy = true; paint();
    try {
      if (!S.refs.loaded) await loadRefs();
      const d = await api.get(`/supplier-changes/${id}`);
      S.f = fromDoc(d); S.view = "doc"; S.message = "";
      S.busy = false;
      paint();
      await loadFormData(true);
    } catch (err) { S.listNote = err?.detail || "Не удалось открыть документ"; S.busy = false; await backToList(true); }
    S.busy = false; paint();
  }
  async function newDoc(kind) {
    if (S.busy || !can(kind)) return;
    if (!S.refs.loaded) { S.busy = true; paint(); await loadRefs(); S.busy = false; }
    S.f = blankForm(kind); S.f.saved = fingerprint(S.f); S.view = "doc"; S.message = ""; paint();
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
    const x = f(); if (!x || x.status === "posted") return;
    if (x.kind === "supplier_change") await loadCandidates(); else await loadMarks(initial);
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
    try { x.marks = (await api.get(`/supplier-changes/contract-marks?object_id=${objectId}&contract_id=${x.from}`)).marks; }
    catch (err) { x.marksError = err?.detail || "Не удалось загрузить марки контракта"; }
    if (f() !== x) return;
    if (x.mark) await loadSideB(); else paint();
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
    if (x.kind === "supplier_change") b.element_ids = [...x.chosen.keys()];
    else { b.mark = x.mark; b.side_a = x.sideA.map((e) => e.id); b.side_b = x.sideB.map((e) => e.id); }
    if (x.id && x.version) b.expected_version = x.version;
    return b;
  }
  function validate(x) {
    if (!x.date) return "Укажите дату документа";
    if (!x.from || !x.to) return x.kind === "link_swap" ? "Выберите контракты обеих сторон" : "Выберите текущий и новый контракты";
    if (x.from === x.to) return "Контракты совпадают — выберите разные";
    if (x.kind === "link_swap" && !x.mark) return "Выберите марку обмена";
    return "";
  }
  // Итог неизвестного исхода: состояние перечитывается с сервера, ничего не отправляется повторно
  const unknownText = "Ответ сервера не получен. Ничего не отправлено повторно — ниже показано, что сервер видит сейчас.";

  async function saveDraft() {
    const x = f(); if (!x || S.busy || x.status !== "draft") return false;
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
    const x = f(); if (!x || !x.id || S.busy || x.status !== "draft") return;
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
    const x = f(); if (!x || !x.id || S.busy) return;
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
      S.message = undo ? `Проведение отменено: ${d.elements ?? ""} изд. возвращены в состояние до документа. Документ снова черновик.` : `Документ № ${d.number} проведён: ${d.moved ?? d.pairs ?? ""} ${d.pairs != null ? "пар" : "изд."} перенесено. Отмена — кнопкой «Отменить проведение».`;
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
    const x = f(); if (!x || S.busy) return;
    const contract = side === "a" ? x.from : x.to;
    if (!contract || !x.mark) return;
    x.picker = { side, all: [], floor: "", sel: new Set(), error: "", loading: true }; paint();
    try {
      const r = await api.get(`/supplier-changes/swap-elements?object_id=${objectId}&contract_id=${contract}&mark=${encodeURIComponent(x.mark)}`);
      if (f() === x && x.picker) { x.picker.all = r.elements.map((e) => ({ id: e.id, type: e.element_type, mark: e.mark, address: e.address, floor: e.floor, status: e.current_status, planned: e.planned_delivery_date })); x.picker.floors = r.floors; x.picker.loading = false; }
    } catch (err) { if (f() === x && x.picker) { x.picker.loading = false; x.picker.error = err?.detail || "Не удалось загрузить изделия"; } }
    if (f() === x) paint();
  }

  // ------------------------------------------------------------ отрисовка
  function listHtml() {
    if (S.list.error && !S.list.loaded) return `<p class="v2-note">${esc(S.list.error)} <button type="button" class="v2-btn" data-a="reload-list">Повторить</button></p>`;
    if (!S.list.loaded) return `<p class="v2-muted">Загрузка…</p>`;
    const rows = S.list.items;
    return `<div class="v2-bar"><h3>Документы объекта</h3><div class="v2-inline">
        ${can("supplier_change") ? `<button type="button" class="v2-btn v2-primary" data-a="new-supplier_change" ${S.busy ? "disabled" : ""}>Новая замена поставщика</button>` : ""}
        ${can("link_swap") ? `<button type="button" class="v2-btn v2-primary" data-a="new-link_swap" ${S.busy ? "disabled" : ""}>Новый обмен привязками</button>` : ""}
      </div></div>
      ${S.listNote ? `<p class="v2-ok" role="status">${esc(S.listNote)}</p>` : ""}
      ${S.list.error ? `<p class="v2-auth-error" role="alert">${esc(S.list.error)}</p>` : ""}
      <p class="v2-muted">«Замена поставщика» переводит непоставленные изделия одного контракта на другой; «Обмен привязками» меняет местами изделия одной марки между двумя контрактами. Документ — черновик, пока его не проведут.</p>
      ${rows.length ? `<table class="v2-table"><thead><tr><th>№</th><th>Дата</th><th>Вид</th><th>Состояние</th><th>Марка</th><th>Из контракта</th><th>В контракт</th><th>Изделий</th><th>Создал</th></tr></thead><tbody>
        ${rows.map((d) => `<tr><td><button type="button" class="v2-link" data-open="${d.id}">${esc(d.number)}</button></td><td>${ruDate(d.doc_date)}</td><td>${esc(d.kind_title)}</td><td>${esc(d.status_title)}</td><td>${esc(d.mark || "—")}</td><td>${esc(d.from_contract_name)}</td><td>${esc(d.to_contract_name)}</td><td>${d.items}</td><td>${esc(d.created_by || "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="v2-note">Документов пока нет.</p>`}`;
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

  function swapHtml(x) {
    const ro = x.status === "posted";
    const sideBox = (sideKey, title, list, other) => `<div><h4>${title}: ${list.length} шт.</h4>${list.length ? list.map((e, i) => `<div class="v2-inline" style="margin:2px 0"><span class="v2-tag">${i + 1}</span><span title="${esc(elLabel(e))}">${esc(elLabel(e))}</span>${i >= other.length ? ' <small class="v2-auth-error">без пары</small>' : ""}${ro ? "" : `<button type="button" class="v2-btn" data-a="mv" data-side="${sideKey}" data-i="${i}" data-d="-1" ${S.busy ? "disabled" : ""} aria-label="Выше">↑</button><button type="button" class="v2-btn" data-a="mv" data-side="${sideKey}" data-i="${i}" data-d="1" ${S.busy ? "disabled" : ""} aria-label="Ниже">↓</button><button type="button" class="v2-btn" data-a="rm" data-side="${sideKey}" data-i="${i}" ${S.busy ? "disabled" : ""} aria-label="Убрать">✕</button>`}</div>`).join("") : `<p class="v2-muted">пусто${ro ? "" : " — нажмите «Подбор…»"}</p>`}
      ${ro ? "" : `<button type="button" class="v2-btn" data-a="pick" data-side="${sideKey}" ${S.busy || !x.mark || !(sideKey === "a" ? x.from : x.to) ? "disabled" : ""}>Подбор…</button>`}</div>`;
    const pk = x.picker;
    const pickerHtml = !pk ? "" : `<div class="v2-callout" role="group" aria-label="Подбор изделий">
      <strong>Подбор изделий стороны ${pk.side === "a" ? "1" : "2"}</strong>
      ${pk.loading ? `<p class="v2-muted">Загрузка…</p>` : pk.error ? `<p class="v2-auth-error" role="alert">${esc(pk.error)}</p>` : (() => {
        const taken = new Set([...x.sideA, ...x.sideB].map((e) => e.id));
        const shown = pk.all.filter((e) => !taken.has(e.id) && (pk.floor === "" || String(e.floor ?? "") === pk.floor));
        return `<div class="v2-inline"><label>Этаж <select data-pk-floor aria-label="Этаж"><option value="">все</option>${(pk.floors || []).map((fl) => `<option value="${esc(fl)}" ${pk.floor === String(fl) ? "selected" : ""}>${esc(fl)}</option>`).join("")}</select></label>
          <button type="button" class="v2-btn" data-a="pk-all">Отметить все показанные</button><span class="v2-muted">Показано: ${shown.length}, отмечено: ${pk.sel.size}</span></div>
          <div style="max-height:260px;overflow:auto">${shown.map((e) => `<label class="v2-role-check" style="padding:3px 0"><input type="checkbox" data-pk-el="${e.id}" ${pk.sel.has(e.id) ? "checked" : ""}><span>${esc(elLabel(e))}${e.planned ? ` · план ${ruDate(e.planned)}` : ""}</span></label>`).join("") || '<p class="v2-muted">Нет подходящих изделий (уже выбраны или не на этом контракте).</p>'}</div>`;
      })()}
      <div class="v2-inline" style="margin-top:8px"><button type="button" class="v2-btn v2-primary" data-a="pk-apply" ${pk.sel.size ? "" : "disabled"}>Добавить в документ</button><button type="button" class="v2-btn" data-a="pk-cancel">Отмена</button></div></div>`;
    const pairs = Math.min(x.sideA.length, x.sideB.length), equal = x.sideA.length === x.sideB.length && x.sideA.length > 0;
    return `<div class="v2-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">${sideBox("a", "Сторона 1", x.sideA, x.sideB)}${sideBox("b", "Сторона 2", x.sideB, x.sideA)}</div>${pickerHtml}
      <p class="${equal ? "v2-muted" : "v2-auth-error"}">${equal ? `Пар к обмену: ${pairs}` : `Сторона 1: ${x.sideA.length} шт., сторона 2: ${x.sideB.length} шт.${x.sideA.length || x.sideB.length ? " — количества не совпадают, провести нельзя" : ""}`}</p>`;
  }

  function docHtml() {
    const x = f(); if (!x) return "";
    const ro = x.status === "posted";
    const swap = x.kind === "link_swap";
    const dis = ro || S.busy ? "disabled" : "";
    const onlyB = swap ? new Set([...x.sideBCounts.keys()]) : null;
    return `<div class="v2-bar"><h3>${esc(KIND_TITLE[x.kind])} — ${x.id ? `№ ${esc(x.number)} от ${ruDate(x.date)}` : "новый документ"} <span class="v2-tag">${x.id ? (ro ? "Проведён" : "Черновик") : "Черновик (не сохранён)"}</span></h3><button type="button" class="v2-btn" data-a="back" ${S.busy ? "disabled" : ""}>← К списку</button></div>
      <p class="v2-muted">${ro ? `Проведён: ${esc(x.posted?.by || "—")}${x.posted?.at ? " · " + ruMoment(x.posted.at) : ""}. Пока документ проведён, его состав не правится — сначала отмените проведение.` : "Черновик данные изделий не меняет — изменения вносит кнопка «Провести»."}</p>
      <div class="v2-fields" style="max-width:none">
        <label class="v2-field">Дата документа<input type="date" data-f="date" value="${esc(x.date)}" ${dis}></label>
        <label class="v2-field">Номер (пусто — выдаст сервер)<input data-f="number" value="${esc(x.number)}" maxlength="30" ${dis} placeholder="авто"></label>
        <label class="v2-field">${swap ? "Контракт стороны 1" : "Текущий поставщик (контракт)"}<select data-f="from" ${dis}>${contractOptions(x.from)}${x.from && !contractById(x.from) ? `<option value="${esc(x.from)}" selected>${esc(x.head?.from_contract_name || "контракт " + x.from)}</option>` : ""}</select></label>
        ${swap ? `<label class="v2-field">Марка обмена<select data-f="mark" ${dis || (!x.from ? "disabled" : "")}><option value="">${x.from ? "— выберите марку —" : "— сначала контракт стороны 1 —"}</option>${x.marks.map((m) => `<option value="${esc(m.mark)}" ${m.mark === x.mark ? "selected" : ""}>${esc(m.mark)} · ${esc(m.element_type || "—")} · ${m.count} шт.</option>`).join("")}${x.mark && !x.marks.some((m) => m.mark === x.mark) ? `<option value="${esc(x.mark)}" selected>${esc(x.mark)}</option>` : ""}</select>${x.marksError ? `<small class="v2-auth-error">${esc(x.marksError)}</small>` : ""}</label>` : ""}
        <label class="v2-field">${swap ? "Контракт стороны 2 (только с этой маркой)" : "Новый поставщик (контракт)"}<select data-f="to" ${dis || (swap && (!x.from || !x.mark) ? "disabled" : "")}>${contractOptions(x.to, swap && !ro ? onlyB : null)}${x.to && !contractById(x.to) ? `<option value="${esc(x.to)}" selected>${esc(x.head?.to_contract_name || "контракт " + x.to)}</option>` : ""}</select>${x.sideBError ? `<small class="v2-auth-error">${esc(x.sideBError)}</small>` : ""}${swap && x.from && x.mark && !x.sideBCounts.size && !x.sideBError ? `<small class="v2-muted">Марка «${esc(x.mark)}» больше нигде на объекте к контрактам не привязана.</small>` : ""}</label>
        <label class="v2-field v2-span">Причина<input data-f="reason" value="${esc(x.reason)}" ${dis} maxlength="300"></label>
        <label class="v2-field v2-span">Комментарий<input data-f="comment" value="${esc(x.comment)}" ${dis} maxlength="600"></label>
      </div>
      <div style="margin-top:16px">${swap ? swapHtml(x) : positionsHtml(x, false)}</div>
      ${x.error ? `<p class="v2-auth-error" role="alert" style="margin-top:12px">${esc(x.error)}</p>` : ""}
      ${S.message ? `<p class="v2-ok" role="status" style="margin-top:12px">${esc(S.message)}</p>` : ""}`;
  }

  function footHtml() {
    if (S.view !== "doc" || !f()) return "";
    const x = f(), busy = S.busy, dirty = isDirty(), writable = can(x.kind);
    if (!writable) return `<span class="v2-muted">Нет права изменять документы этого вида на объекте.</span>`;
    const b = (label, act, primary, extra = "") => `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" data-a="${act}" ${busy || extra ? "disabled" : ""}>${label}</button>`;
    if (x.status === "posted") return b("Отменить проведение", "unpost", false);
    const swapPairsOk = x.kind !== "link_swap" || (x.sideA.length === x.sideB.length && x.sideA.length > 0);
    const supplierOk = x.kind !== "supplier_change" || x.chosen.size > 0;
    return [x.id ? b("Удалить черновик", "delete", false) : "", b(busy ? "Сохранение…" : "Сохранить", "save", true, dirty ? "" : "1"),
      x.id ? b("Провести", "post", false, dirty || !swapPairsOk || !supplierOk ? "1" : "") : ""].join("");
  }

  function paint() {
    if (dead) return;
    const active = document.activeElement;
    const keep = active && inner.contains(active) ? { sel: active.getAttribute("data-f") ? `[data-f="${active.getAttribute("data-f")}"]` : null, pos: active.selectionStart } : null;
    inner.innerHTML = S.view === "list" ? listHtml() : docHtml();
    foot.innerHTML = footHtml();
    const dirty = isDirty();
    statusEl.textContent = S.busy ? "Выполняется запись — дождитесь ответа сервера…" : (dirty ? "Есть несохранённые изменения" : "");
    bind();
    if (keep?.sel) { const el = inner.querySelector(keep.sel); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) { /* не текстовое поле */ } } }
  }

  function bind() {
    const x = f();
    for (const el of container.querySelectorAll("[data-a]")) el.addEventListener("click", () => onAction(el.dataset.a, el.dataset));
    for (const el of inner.querySelectorAll("[data-open]")) el.addEventListener("click", () => openDoc(Number(el.dataset.open)));
    if (!x) return;
    for (const el of inner.querySelectorAll("[data-f]")) el.addEventListener(el.tagName === "SELECT" || el.type === "date" ? "change" : "input", async () => {
      const k = el.dataset.f;
      if (k === "date" || k === "number" || k === "reason" || k === "comment") { x[k] = el.value; x.error = ""; paintFoot(); return; }
      x[k] = el.value; x.error = ""; S.message = "";
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
      inner.querySelector("[data-pk-floor]")?.addEventListener("change", (e) => { pk.floor = e.target.value; paint(); });
      for (const el of inner.querySelectorAll("[data-pk-el]")) el.addEventListener("change", () => { const id = Number(el.dataset.pkEl); if (el.checked) pk.sel.add(id); else pk.sel.delete(id); paint(); });
    }
  }
  function paintFoot() { foot.innerHTML = footHtml(); bindFoot(); statusEl.textContent = isDirty() ? "Есть несохранённые изменения" : ""; }
  function bindFoot() { for (const el of foot.querySelectorAll("[data-a]")) el.addEventListener("click", () => onAction(el.dataset.a, el.dataset)); }

  function onAction(a, d) {
    const x = f();
    if (a === "reload-list") { S.list.error = ""; loadList().then(paint); return; }
    if (a === "new-supplier_change" || a === "new-link_swap") { newDoc(a.slice(4)); return; }
    if (a === "back") { backToList(false); return; }
    if (!x) return;
    if (a === "save") saveDraft();
    else if (a === "post") postOrUnpost(false);
    else if (a === "unpost") postOrUnpost(true);
    else if (a === "delete") deleteDraft();
    else if (a === "reload-cand") loadCandidates();
    else if (a === "toggle-pos") { x.openPos = x.openPos || new Set(); const i = Number(d.pi); if (x.openPos.has(i)) x.openPos.delete(i); else x.openPos.add(i); paint(); }
    else if (a === "pick") openPicker(d.side);
    else if (a === "pk-cancel") { x.picker = null; paint(); }
    else if (a === "pk-all" && x.picker) { const taken = new Set([...x.sideA, ...x.sideB].map((e) => e.id)); for (const e of x.picker.all) if (!taken.has(e.id) && (x.picker.floor === "" || String(e.floor ?? "") === x.picker.floor)) x.picker.sel.add(e.id); paint(); }
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
    await Promise.all([loadList(), loadRefs()]);
    S.busy = false; paint();
  })();

  return {
    hasUnsavedChanges: () => isDirty() || S.busy,
    guardLeave: async () => { if (S.busy) { await showInfoDialog("Идёт запись — дождитесь ответа сервера."); return false; } return guardLeave(); },
    destroy: () => { dead = true; },
  };
}
