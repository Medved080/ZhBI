// «Учёт по блокам» в V2: блоки объекта со счётчиками запланированных работ (ЗР), работы выбранных блоков с отбором по видам работ,
// статусу, сроку и периоду; карточка ЗР (срок, прогноз, примечание), «Факт», «Состав работ», групповая правка сроков.
// Права и API — как у V1 (`blocks: read` для списка блоков, `work_progress` для работ и факта). Список блоков и работ читается всегда;
// изменяющие кнопки видны только при праве «Учёт по блокам: изменение» на объекте. Каждая запись — через `api.js` и шлюз `write-gate.js`.
import { ApiError } from "./api.js";
import { esc, errText, shortDate, canAccounting, DEADLINE, WORK_STATUS } from "./mfr-common.js";
import { STATUS_LABEL } from "./registry.js";
import { linkList } from "./screen-view.js";
import { openFactDialog, openZrDialog, openSettingsDialog, openBulkDatesDialog } from "./mfr-dialogs.js";

// «Период по плану/прогнозу»: ЗР входит, если её интервал пересекается с выбранным периодом; без дат — не входит (как у V1)
export function periodIntersects(start, end, from, to) {
  if (!start && !end) return false;
  const s = start || end, e = end || start;
  if (from && e < from) return false;
  if (to && s > to) return false;
  return true;
}

export function zrPasses(it, f) {
  if (f.tracks.size && !f.tracks.has(it.track_code)) return false;
  if (f.statuses.size && !f.statuses.has(it.status)) return false;
  if (f.deadlines.size && !f.deadlines.has(it.deadline)) return false;
  if (f.period.on && !periodIntersects(it[`${f.period.field}_start`], it[`${f.period.field}_end`], f.period.from || null, f.period.to || null)) return false;
  const q = f.q.trim().toLowerCase();
  if (q && !`${it["название"] || ""} ${it["код"] || ""} ${it["путь"] || ""}`.toLowerCase().includes(q)) return false;
  return true;
}
export const newFilter = () => ({ tracks: new Set(), statuses: new Set(), deadlines: new Set(), period: { on: false, field: "plan", from: "", to: "" }, q: "" });
export const filterActive = (f) => !!(f.tracks.size || f.statuses.size || f.deadlines.size || f.period.on || f.q.trim());

export function mountBlocksScreen(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page v2-app mfr-scr";
  let dead = false, seq = 0, tab = "works";
  const canWrite = canAccounting(rights, "write");
  const st = {
    blocks: [], counts: null, tracks: [], workTypes: null, loadError: "", loading: true,
    sel: new Set(), anchor: null, search: "", items: [], itemsLoading: false, itemsError: "", filter: newFilter(), picked: new Set(),
  };
  const blockLabel = (b) => `${b.section_code} · ${b.level_name || (b.floor + " этаж")}`;
  const labels = () => Object.fromEntries(st.blocks.map((b) => [b.id, blockLabel(b)]));

  el.innerHTML = `
    <div class="mfr-head">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span>
        <span class="mfr-cap ${canWrite ? "on" : ""}" id="bs-cap"></span></div>
      <div class="v2-wire-tabs v2-read-tabs" role="tablist">${[["works", "Запланированные работы"], ["blocks", "Блоки"], ["types", "Виды работ"]].map(([k, t]) =>
        `<button type="button" role="tab" class="v2-read-tab" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join("")}
        <a class="v2-link mfr-tab-link" href="#/fact-journal">Журнал факта →</a></div>
    </div>
    <div class="mfr-body" id="bs-body"></div>`;
  const $ = (s) => el.querySelector(s);
  $("#bs-cap").textContent = canWrite ? "можно: факт, состав работ, сроки, прогноз" : "только просмотр";

  // ------------------------------------------------------------------ данные
  async function loadBase() {
    const my = ++seq;
    st.loading = true; st.loadError = ""; paint();
    try {
      const [blocks, tracks] = await Promise.all([api.get(`/objects/${objectId}/blocks`), api.get(`/objects/${objectId}/planning-tracks`).catch(() => ({ tracks: [] }))]);
      if (dead || my !== seq) return;
      st.blocks = blocks; st.tracks = tracks.tracks || [];
    } catch (e) { if (dead || my !== seq) return; st.loadError = errText(e); st.loading = false; paint(); return; }
    st.loading = false; paint();
    loadCounts(my);
    if (st.sel.size) loadItems();
  }
  // Счётчики ЗР — ОДНИМ агрегированным запросом; три состояния: ещё грузятся (…), ошибка (?), число (в т.ч. 0)
  async function loadCounts(my = seq) {
    st.counts = null; paintBlocks();
    try { const c = await api.get(`/objects/${objectId}/block-works/active-counts`); if (dead || my !== seq) return; st.counts = c.counts || {}; }
    catch (e) { if (dead || my !== seq) return; st.counts = "error"; }
    paintBlocks();
  }
  async function loadItems() {
    const my = ++itemsSeq;
    const ids = [...st.sel];
    if (!ids.length) { st.items = []; paintWorks(); return; }
    st.itemsLoading = true; st.itemsError = ""; paintWorks();
    try {
      const d = await api.get(`/objects/${objectId}/block-works?block_ids=${ids.join(",")}`);
      if (dead || my !== itemsSeq) return;            // запоздавший ответ прежнего выбора не подменяет текущий
      st.items = d.items || [];
      st.picked = new Set([...st.picked].filter((id) => st.items.some((i) => i.id === id)));
    } catch (e) { if (dead || my !== itemsSeq) return; st.itemsError = errText(e); st.items = []; }
    st.itemsLoading = false; paintWorks();
  }
  let itemsSeq = 0;
  const refreshAfterWrite = () => { loadCounts(); loadItems(); };

  // ------------------------------------------------------------------ отрисовка
  function paint() {
    if (dead) return;
    const body = $("#bs-body");
    for (const b of el.querySelectorAll(".v2-read-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    if (st.loading) { body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (st.loadError) { body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить блоки.</strong> ${esc(st.loadError)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="bs-retry">Повторить</button></div></div>`; $("#bs-retry").addEventListener("click", loadBase); return; }
    if (tab === "blocks") { paintBlocksTab(body); return; }
    if (tab === "types") { paintTypesTab(body); return; }
    body.innerHTML = `<div class="mfr-two">
      <aside class="mfr-left" aria-label="Блоки объекта">
        <div class="v2-bar"><input type="search" id="bs-search" class="v2-search" placeholder="Найти секцию или этаж" aria-label="Найти блок" value="${esc(st.search)}"><span class="v2-muted" id="bs-sel"></span></div>
        <div class="mfr-scroll" id="bs-blocks"></div>
        <p class="v2-muted mfr-hint">Щелчок — выбрать блок; Ctrl/⌘ + щелчок — добавить или снять; Shift + щелчок — диапазон.</p>
      </aside>
      <section class="mfr-right" aria-label="Запланированные работы"><div id="bs-works"></div></section></div>`;
    $("#bs-search").addEventListener("input", (e) => { st.search = e.target.value; paintBlocks(); });
    paintBlocks(); paintWorks();
  }

  function countBadge(id) {
    if (st.counts === null) return `<span class="mfr-count loading" title="Считаем">…</span>`;
    if (st.counts === "error") return `<span class="mfr-count error" title="Не удалось получить количество">?</span>`;
    return `<span class="mfr-count" title="Запланированных работ у блока">${st.counts[id] || 0}</span>`;
  }
  const visibleBlocks = () => {
    const q = st.search.trim().toLowerCase();
    return q ? st.blocks.filter((b) => `${b.section_code} ${b.level_name || b.floor}`.toLowerCase().includes(q)) : st.blocks;
  };
  function paintBlocks() {
    const box = $("#bs-blocks");
    if (!box || tab !== "works") return;
    const list = visibleBlocks();
    if (!st.blocks.length) { box.innerHTML = `<p class="v2-muted">Блоков ещё нет: их заводят на вкладке «Блоки» текущего интерфейса.</p>`; return; }
    if (!list.length) { box.innerHTML = `<p class="v2-muted">Ничего не найдено по запросу «${esc(st.search)}».</p>`; return; }
    const bySection = new Map();
    for (const b of list) { const k = b.section_code || "—"; if (!bySection.has(k)) bySection.set(k, []); bySection.get(k).push(b); }
    box.innerHTML = [...bySection].map(([code, bs]) => {
      const all = bs.every((b) => st.sel.has(b.id)), some = bs.some((b) => st.sel.has(b.id));
      return `<div class="mfr-sec"><label class="mfr-sec-head"><input type="checkbox" data-sec="${esc(code)}" ${all ? "checked" : ""} ${some && !all ? 'data-mixed="1"' : ""} aria-label="Выбрать все блоки секции ${esc(code)}"> <b>${esc(code)}</b></label>
        ${bs.map((b) => `<button type="button" class="mfr-blk${st.sel.has(b.id) ? " on" : ""}" data-b="${b.id}" aria-pressed="${st.sel.has(b.id)}"><span>${esc(b.level_name || b.floor + " этаж")}</span>${countBadge(b.id)}</button>`).join("")}</div>`;
    }).join("");
    box.querySelectorAll("input[data-mixed]").forEach((c) => { c.indeterminate = true; });
    $("#bs-sel").textContent = st.sel.size ? `выбрано: ${st.sel.size}` : "";
    box.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", (e) => pickBlock(Number(b.dataset.b), e)));
    box.querySelectorAll("[data-sec]").forEach((c) => c.addEventListener("change", () => {
      const ids = bySection.get(c.dataset.sec).map((b) => b.id);
      for (const id of ids) c.checked ? st.sel.add(id) : st.sel.delete(id);
      st.anchor = null; paintBlocks(); loadItems();
    }));
  }
  function pickBlock(id, e) {
    const order = visibleBlocks().map((b) => b.id);
    if (e.shiftKey && st.anchor != null && order.includes(st.anchor)) {
      const a = order.indexOf(st.anchor), z = order.indexOf(id);
      for (const x of order.slice(Math.min(a, z), Math.max(a, z) + 1)) st.sel.add(x);
    } else if (e.ctrlKey || e.metaKey) {
      st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id); st.anchor = id;
    } else { st.sel = new Set([id]); st.anchor = id; }
    paintBlocks(); loadItems();
  }

  function filterBar() {
    const f = st.filter;
    const chip = (kind, val, label) => `<label class="mfr-chk"><input type="checkbox" data-f="${kind}" value="${esc(val)}" ${f[kind].has(val) ? "checked" : ""}> ${esc(label)}</label>`;
    return `<div class="mfr-filters" role="group" aria-label="Отбор работ">
      <input type="search" id="bf-q" class="v2-search" placeholder="Найти работу" aria-label="Найти работу" value="${esc(f.q)}">
      <details class="mfr-dd"><summary>Вид работ${f.tracks.size ? ` · ${f.tracks.size}` : ""}</summary><div class="mfr-dd-body">${st.tracks.length ? st.tracks.map((t) => chip("tracks", t["код"], t["название"])).join("") : `<span class="v2-muted">Досок нет</span>`}</div></details>
      <details class="mfr-dd"><summary>Статус${f.statuses.size ? ` · ${f.statuses.size}` : ""}</summary><div class="mfr-dd-body">${Object.entries(WORK_STATUS).map(([k, t]) => chip("statuses", k, t)).join("")}</div></details>
      <details class="mfr-dd"><summary>Срок${f.deadlines.size ? ` · ${f.deadlines.size}` : ""}</summary><div class="mfr-dd-body">${Object.entries(DEADLINE).map(([k, t]) => chip("deadlines", k, t)).join("")}</div></details>
      <details class="mfr-dd"><summary>Период${f.period.on ? " · задан" : ""}</summary><div class="mfr-dd-body">
        <label class="mfr-chk"><input type="checkbox" id="bf-pon" ${f.period.on ? "checked" : ""}> отбирать по периоду</label>
        <label>по <select id="bf-pfield"><option value="plan" ${f.period.field === "plan" ? "selected" : ""}>плану</option><option value="forecast" ${f.period.field === "forecast" ? "selected" : ""}>прогнозу</option></select></label>
        <label>с <input type="date" id="bf-pfrom" value="${esc(f.period.from)}"></label><label>по <input type="date" id="bf-pto" value="${esc(f.period.to)}"></label></div></details>
      <button type="button" class="v2-btn" id="bf-reset" ${filterActive(f) ? "" : "disabled"}>Сбросить отбор</button></div>`;
  }

  function paintWorks() {
    const box = $("#bs-works");
    if (!box || tab !== "works") return;
    const selBlocks = st.blocks.filter((b) => st.sel.has(b.id));
    if (!selBlocks.length) { box.innerHTML = `<div class="mfr-empty"><h3>Выберите блок слева</h3><p class="v2-muted">Показываются запланированные работы выбранных блоков; у блока справа от названия — число активных работ.</p></div>`; return; }
    const shown = st.items.filter((i) => zrPasses(i, st.filter));
    const multi = selBlocks.length > 1;
    const one = selBlocks.length === 1 ? selBlocks[0] : null;
    const pickedItems = st.items.filter((i) => st.picked.has(i.id));
    box.innerHTML = `<div class="mfr-works-head">
        <div><h3>${one ? esc(blockLabel(one)) : `Блоков: ${selBlocks.length}`}</h3><span class="v2-muted">работ: ${st.items.length}${filterActive(st.filter) ? `, показано ${shown.length}` : ""}</span></div>
        <div class="mfr-actions">
          ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="bs-fact" ${one ? "" : "disabled"} title="${one ? "Документы факта выбранного блока" : "Факт вводится по одному блоку"}">Факт</button>
          <button type="button" class="v2-btn" id="bs-settings" title="Какие виды работ идут на выбранных блоках">Состав работ${multi ? ` (${selBlocks.length})` : ""}</button>
          <button type="button" class="v2-btn" id="bs-bulk" ${pickedItems.length ? "" : "disabled"} title="${pickedItems.length ? "Сдвиг сроков или «прогноз = план» с предпросмотром" : "Отметьте работы флажками в таблице"}">Сроки: групповая правка${pickedItems.length ? ` (${pickedItems.length})` : ""}</button>` : ""}
          <button type="button" class="v2-btn" id="bs-journal" title="Журнал факта с отбором по выбранным блокам">В журнал факта</button></div></div>
      ${filterBar()}
      <div class="mfr-scroll mfr-tblwrap" id="bs-tbl">${worksTable(shown, multi)}</div>`;
    bindWorks(shown);
  }
  function worksTable(shown, multi) {
    if (st.itemsLoading) return `<p class="v2-muted" role="status">Загрузка работ…</p>`;
    if (st.itemsError) return `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить работы.</strong> ${esc(st.itemsError)} <button type="button" class="v2-btn" id="bs-items-retry">Повторить</button></div>`;
    if (!st.items.length) return `<p class="v2-muted">У выбранных блоков нет ни одной запланированной работы${canWrite ? ' — «Состав работ» добавит их' : ""}.</p>`;
    if (!shown.length) return `<p class="v2-muted">По выбранному отбору работ нет. <button type="button" class="v2-link-btn" id="bf-reset2">Сбросить отбор</button></p>`;
    const allPicked = shown.length && shown.every((i) => st.picked.has(i.id));
    return `<table class="v2-read-tbl mfr-tbl"><thead><tr>${canWrite ? `<th><input type="checkbox" id="bs-pick-all" ${allPicked ? "checked" : ""} aria-label="Отметить все показанные работы"></th>` : ""}${multi ? "<th>Блок</th>" : ""}<th>Работа</th><th>План</th><th>Прогноз</th><th class="num">%</th><th>Срок</th></tr></thead>
      <tbody>${shown.map((i) => `<tr data-bw="${i.id}" tabindex="0" class="mfr-row" aria-label="Открыть карточку работы ${esc(i["название"] || "")}">${canWrite ? `<td><input type="checkbox" data-pick="${i.id}" ${st.picked.has(i.id) ? "checked" : ""} aria-label="Отметить работу"></td>` : ""}
        ${multi ? `<td>${esc(i.section_code)} · ${esc(i.level_floor)}</td>` : ""}<td title="${esc(i["путь"] || "")}">${esc(i["название"] || "")}<br><span class="v2-muted">${esc(i["код"] || "")}</span></td>
        <td>${esc(shortDate(i.plan_start))}–${esc(shortDate(i.plan_end))}</td><td>${esc(shortDate(i.forecast_start))}–${esc(shortDate(i.forecast_end))}</td><td class="num">${esc(i.percent)}%</td>
        <td><span class="mfr-dl mfr-dl-${esc(i.deadline)}">${esc(i.deadline_label || "")}</span></td></tr>`).join("")}</tbody></table>`;
  }

  function bindWorks(shown) {
    const f = st.filter, box = $("#bs-works");
    const repaintTable = () => { paintWorks(); };
    box.querySelector("#bf-q")?.addEventListener("input", (e) => { f.q = e.target.value; const pos = e.target.selectionStart; paintWorks(); const n = $("#bf-q"); n.focus(); n.setSelectionRange(pos, pos); });
    box.querySelectorAll("input[data-f]").forEach((c) => c.addEventListener("change", () => { const s = f[c.dataset.f]; c.checked ? s.add(c.value) : s.delete(c.value); keepOpen(); }));
    box.querySelector("#bf-pon")?.addEventListener("change", (e) => { f.period.on = e.target.checked; keepOpen(); });
    box.querySelector("#bf-pfield")?.addEventListener("change", (e) => { f.period.field = e.target.value; keepOpen(); });
    box.querySelector("#bf-pfrom")?.addEventListener("change", (e) => { f.period.from = e.target.value; keepOpen(); });
    box.querySelector("#bf-pto")?.addEventListener("change", (e) => { f.period.to = e.target.value; keepOpen(); });
    const reset = () => { st.filter = newFilter(); paintWorks(); };
    box.querySelector("#bf-reset")?.addEventListener("click", reset);
    box.querySelector("#bf-reset2")?.addEventListener("click", reset);
    box.querySelector("#bs-items-retry")?.addEventListener("click", loadItems);
    function keepOpen() { const open = [...box.querySelectorAll("details.mfr-dd")].map((d) => d.open); repaintTable(); [...$("#bs-works").querySelectorAll("details.mfr-dd")].forEach((d, i) => { d.open = !!open[i]; }); }
    const sel = st.blocks.filter((b) => st.sel.has(b.id));
    box.querySelector("#bs-fact")?.addEventListener("click", () => { const b = sel[0]; openFactDialog({ api, objectId, blockId: b.id, blockLabel: blockLabel(b), canWrite, onChanged: refreshAfterWrite }); });
    box.querySelector("#bs-settings")?.addEventListener("click", () => openSettingsDialog({ api, objectId, blocks: sel.map((b) => ({ id: b.id, label: blockLabel(b) })), canWrite, onSaved: refreshAfterWrite }));
    box.querySelector("#bs-bulk")?.addEventListener("click", () => openBulkDatesDialog({ api, objectId, items: st.items.filter((i) => st.picked.has(i.id)), canWrite, onDone: () => { loadItems(); } }));
    box.querySelector("#bs-journal")?.addEventListener("click", () => {
      try { sessionStorage.setItem("v2.factJournal.preset", JSON.stringify({ objectId, sections: [...new Set(sel.map((b) => b.section_id))], levels: [...new Set(sel.map((b) => b.level_id))] })); } catch (e) { /* передача отбора необязательна */ }
      location.hash = "#/fact-journal";
    });
    box.querySelector("#bs-pick-all")?.addEventListener("change", (e) => { for (const i of shown) e.target.checked ? st.picked.add(i.id) : st.picked.delete(i.id); paintWorks(); });
    box.querySelectorAll("[data-pick]").forEach((c) => { c.addEventListener("click", (e) => e.stopPropagation()); c.addEventListener("change", () => { const id = Number(c.dataset.pick); c.checked ? st.picked.add(id) : st.picked.delete(id); paintWorks(); }); });
    const openRow = (tr) => openZrDialog({ api, objectId, id: Number(tr.dataset.bw), canWrite, onSaved: refreshAfterWrite, blockLabels: labels() });
    box.querySelectorAll("tr[data-bw]").forEach((tr) => { tr.addEventListener("click", () => openRow(tr)); tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(tr); } }); });
  }

  // ------------------------------------------------------------------ вкладки «Блоки» и «Виды работ» (только чтение)
  function paintBlocksTab(body) {
    const q = st.search.trim().toLowerCase();
    const rows = st.blocks.filter((b) => !q || `${b.section_code} ${b.level_name || b.floor}`.toLowerCase().includes(q));
    body.innerHTML = `<div class="v2-bar"><input type="search" id="bt-q" class="v2-search" placeholder="Поиск по секции и этажу" aria-label="Поиск по таблице" value="${esc(st.search)}"><span class="v2-muted">Блоков: ${rows.length} из ${st.blocks.length}</span></div>
      <div class="mfr-scroll"><table class="v2-read-tbl"><thead><tr><th>Секция</th><th>Этаж / уровень</th><th>Этаж №</th><th>Вид</th><th class="num">Работ</th></tr></thead>
      <tbody>${rows.map((b) => `<tr><td>${esc(b.section_code)}</td><td>${esc(b.level_name || "")}</td><td>${esc(b.floor ?? "")}</td><td>${esc(b.kind || "")}</td><td class="num">${st.counts && st.counts !== "error" ? esc(st.counts[b.id] || 0) : st.counts === "error" ? "?" : "…"}</td></tr>`).join("") || `<tr><td colspan="5" class="v2-muted">Блоков нет.</td></tr>`}</tbody></table></div>
      <p class="v2-muted mfr-hint">Секции, этажи, блоки и геометрия блоков заводятся и правятся в текущем интерфейсе.</p>`;
    $("#bt-q").addEventListener("input", (e) => { st.search = e.target.value; const pos = e.target.selectionStart; paintBlocksTab(body); const n = $("#bt-q"); n.focus(); n.setSelectionRange(pos, pos); });
    if (st.counts === null) loadCounts();
  }
  async function paintTypesTab(body) {
    body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`;
    const my = ++seq;
    try {
      if (!st.workTypes) st.workTypes = (await api.get(`/objects/${objectId}/block-work-types`)).options || [];
    } catch (e) { if (dead || my !== seq) return; body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить виды работ.</strong> ${esc(errText(e))} <button type="button" class="v2-btn" id="ty-retry">Повторить</button></div>`; $("#ty-retry").addEventListener("click", () => paintTypesTab(body)); return; }
    if (dead || my !== seq || tab !== "types") return;
    const q = st.search.trim().toLowerCase();
    const rows = st.workTypes.filter((o) => !q || `${o.code} ${o.name} ${o.path}`.toLowerCase().includes(q));
    body.innerHTML = `<div class="v2-bar"><input type="search" id="ty-q" class="v2-search" placeholder="Поиск по видам работ" aria-label="Поиск по таблице" value="${esc(st.search)}"><span class="v2-muted">Видов работ: ${rows.length} из ${st.workTypes.length}</span></div>
      <div class="mfr-scroll"><table class="v2-read-tbl"><thead><tr><th>Код</th><th>Название</th><th>Трек</th><th>Путь в WBS</th></tr></thead><tbody>${rows.slice(0, 500).map((o) => `<tr><td>${esc(o.code || "")}</td><td>${esc(o.name)}</td><td>${esc(o.planning_track_code || "")}</td><td>${esc(o.path)}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length > 500 ? `<p class="v2-muted">Показаны первые 500 — уточните поиск.</p>` : ""}<p class="v2-muted mfr-hint">Справочник видов работ загружается и правится в текущем интерфейсе.</p>`;
    $("#ty-q").addEventListener("input", (e) => { st.search = e.target.value; const pos = e.target.selectionStart; paintTypesTab(body).then(() => { const n = $("#ty-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); });
  }

  el.querySelectorAll(".v2-read-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; st.search = ""; paint(); }));
  loadBase();
  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    destroy() { dead = true; document.querySelectorAll(".mfr-modal-back").forEach((n) => n.remove()); },
  };
}
