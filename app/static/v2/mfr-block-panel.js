// Панель блока в рабочем месте «Модель МФР» (V2): запланированные работы (ЗР) выбранного блока с процентом, сроками и признаком срока,
// кнопки «Факт», «Состав работ», «Сроки»; отбор работ по видам, статусу, сроку и периоду; «Динамика факта за период» и «Шахматка»
// (раскраска плана по доске) — эти два режима ведёт движок схемы в кадре, панель управляет ими командами моста `zhbi-scene/1`
// (`mfrChess`, `mfrDynamics`). Список блоков со счётчиками ЗР показан ДО выбора блока: число работ видно, не открывая блок.
// Права и API — как у V1 (`blocks: read`, `work_progress`); запись — только через окна `mfr-dialogs.js` и шлюз `write-gate.js`.
import { esc, errText, shortDate, canAccounting, closeAllModals, DEADLINE, WORK_STATUS } from "./mfr-common.js";
import { openFactDialog, openZrDialog, openSettingsDialog, openBulkDatesDialog } from "./mfr-dialogs.js";
import { openObjectWorkDialog } from "./mfr-object-dialog.js";
import { newFilter, filterActive, periodIntersects } from "./blocks-screen.js";

const devLabel = (d) => (d == null ? "" : d === 0 ? "±0 дн" : `${d > 0 ? "+" : ""}${d} дн`);

export function createMfrBlockPanel({ api, send, repaint, getObjectId }) {
  let dead = false;
  const st = {
    objectId: null, rights: null, blocks: null, blocksErr: "", counts: null, objectWorks: null, objectWorksError: "", objectWorksLoading: false,
    progress: new Map(),            // blockId -> {loading, error, data, key}
    filter: newFilter(), chess: { tracks: [], track: null, mode: "progress", deadlineColors: {} }, dyn: { on: false, from: "", to: "" }, dynSnap: { blocks: 0 },
    open: new Set(["works", "status", "deadline", "period", "dynamics"]),   // как в V1: все группы развёрнуты, сворачиваются человеком
  };
  const canWrite = () => canAccounting(st.rights, "write");
  const labelOf = (b) => `${b.section_code} · ${b.level_name || b.floor + " этаж"}`;
  const labelsMap = () => Object.fromEntries((st.blocks || []).map((b) => [b.id, labelOf(b)]));

  // ---------------------------------------------------------------- данные
  let baseBusy = false;
  async function ensureBase() {
    const obj = getObjectId();
    if (baseBusy || (st.objectId === obj && st.blocks)) return;
    if (st.objectId !== obj) { st.objectId = obj; st.rights = null; st.blocks = null; st.counts = null; st.objectWorks = null; st.objectWorksError = ""; st.objectWorksLoading = false; st.progress.clear(); st.filter = newFilter(); st.dyn = { on: false, from: "", to: "" }; }
    if (!obj) return;
    baseBusy = true;
    try {
      try { st.rights = await api.get(`/me/permissions?object_id=${obj}`); } catch (e) { st.rights = null; }
      try { st.blocks = await api.get(`/objects/${obj}/blocks`); st.blocksErr = ""; } catch (e) { st.blocks = []; st.blocksErr = errText(e); }
      await loadCounts();
      loadObjectWorks();
    } finally { baseBusy = false; }
    if (!dead && obj === st.objectId) repaint();
  }
  async function loadCounts() {
    st.counts = null;
    const obj = st.objectId;
    try { const c = await api.get(`/objects/${obj}/block-works/active-counts`); if (obj === st.objectId) st.counts = c.counts || {}; }
    catch (e) { if (obj === st.objectId) st.counts = "error"; }
  }
  async function loadObjectWorks(force = false) {
    if (!st.objectId || st.objectWorksLoading || (st.objectWorks && !force)) return;
    const obj = st.objectId; st.objectWorksLoading = true;
    try {
      const data = await api.get(`/objects/${obj}/object-works`);
      if (st.objectId === obj) { st.objectWorks = data; st.objectWorksError = ""; }
    } catch (e) { if (st.objectId === obj) st.objectWorksError = errText(e); }
    finally { if (st.objectId === obj) { st.objectWorksLoading = false; repaint(); } }
  }
  async function loadProgress(blockId, force = false) {
    const obj = st.objectId;
    const dq = st.dyn.on ? `?date_from=${encodeURIComponent(st.dyn.from || "")}&date_to=${encodeURIComponent(st.dyn.to || "")}` : "";
    const key = `${obj}|${blockId}|${dq}`;
    const cur = st.progress.get(blockId);
    if (!force && cur && cur.key === key) return;
    const entry = { loading: true, error: "", data: cur?.data || null, key };
    st.progress.set(blockId, entry);
    try {
      const d = await api.get(`/objects/${obj}/blocks/${blockId}/progress${dq}`);
      if (dead || st.progress.get(blockId) !== entry) return;   // запоздавший ответ прежнего выбора/режима не подменяет текущий
      entry.data = d; entry.error = "";
    } catch (e) { if (dead || st.progress.get(blockId) !== entry) return; entry.error = errText(e); entry.data = null; }
    entry.loading = false; repaint();
  }
  // после записи: перечитать панель и (если включены) шахматку и динамику в кадре — раскраска плана зависит от факта
  function refreshAll(blockId) {
    loadCounts().then(() => repaint());
    for (const id of new Set([blockId, ...st.progress.keys()].filter(Boolean))) if (st.progress.has(id)) loadProgress(id, true);
    if (st.chess.track) send("mfrChess", { track: st.chess.track, mode: st.chess.mode, refresh: true });
    if (st.dyn.on) send("mfrDynamics", { on: true, from: st.dyn.from || null, to: st.dyn.to || null });
  }

  // ---------------------------------------------------------------- отбор дерева
  function filterTree(nodes) {
    const f = st.filter, out = [];
    for (const n of nodes || []) {
      if (n.row_kind === "узел") { const kids = filterTree(n.children); if (kids.length) out.push({ ...n, children: kids }); continue; }
      if (f.tracks.size && !f.tracks.has(n.planning_track_code)) continue;
      const status = n.status_to || n.status;
      if (f.statuses.size && !f.statuses.has(status)) continue;
      if (n.percent_from === undefined) {        // «сроки»/«период» — только в обычном режиме (в динамике сервер их не подмешивает)
        if (f.deadlines.size && !f.deadlines.has(n.deadline)) continue;
        if (f.period.on && !periodIntersects(n[`${f.period.field}_start`], n[`${f.period.field}_end`], f.period.from || null, f.period.to || null)) continue;
      }
      out.push(n);
    }
    return out;
  }
  const leaves = (nodes, acc = []) => { for (const n of nodes || []) { if (n.row_kind === "узел") leaves(n.children, acc); else acc.push(n); } return acc; };

  function treeHtml(nodes, depth = 0) {
    return nodes.map((n) => {
      const pad = depth * 10;
      if (n.row_kind === "узел") return `<div class="mfr-wp-node" style="padding-left:${pad}px">${esc(n.name)}</div>${treeHtml(n.children, depth + 1)}`;
      const dyn = n.percent_from !== undefined;
      const pct = dyn ? n.percent_to : (n.percent || 0);
      const bar = `<div class="mfr-wp-bar" role="img" aria-label="Выполнено ${pct}%"><i style="width:${pct}%"></i>${dyn ? `<b style="left:${n.percent_from}%"></b>` : ""}</div>`;
      const meta = dyn ? `<span>${n.percent_from}% → ${n.percent_to}%</span>`
        : `<span>${pct}%</span><span>план ${esc(shortDate(n.plan_start))}–${esc(shortDate(n.plan_end))}</span><span>прогноз ${esc(shortDate(n.forecast_start))}–${esc(shortDate(n.forecast_end))}</span><span class="mfr-dl mfr-dl-${esc(n.deadline)}">${esc(n.deadline_label || "")}${n.deviation_end != null ? ` (${esc(devLabel(n.deviation_end))})` : ""}</span>`;
      return `<div class="mfr-wp-op" style="padding-left:${pad}px" ${n.block_work_id ? `data-bw="${n.block_work_id}" tabindex="0" role="button" aria-label="Открыть карточку работы ${esc(n.name)}"` : ""}><div class="mfr-wp-name">${esc(n.name)}</div>${bar}<div class="mfr-wp-meta">${meta}</div></div>`;
    }).join("");
  }

  // ---------------------------------------------------------------- HTML для панели «Свойства»
  function blockHtml(blockId, selectedIds) {
    ensureBase();
    const e = st.progress.get(blockId);
    if (!e) loadProgress(blockId);
    const many = (selectedIds || []).length > 1;
    const w = canWrite();
    let body;
    if (!e || (e.loading && !e.data)) body = `<p class="v2-muted" role="status">Загрузка работ…</p>`;
    else if (e.error) body = `<p class="v2-muted" role="alert">${esc(e.error)}</p><button type="button" class="v2-btn" data-mbp="retry" data-id="${blockId}">Повторить</button>`;
    else {
      const d = e.data, all = leaves(d.tree), shown = filterTree(d.tree), sum = d["сроки"];
      body = `${sum && sum.zr_count ? `<div class="mfr-wp-sum">План: ${esc(shortDate(sum.plan_start))}–${esc(shortDate(sum.plan_end))} · Прогноз: ${esc(shortDate(sum.forecast_start))}–${esc(shortDate(sum.forecast_end))} · Средний процент: ${esc(sum.percent ?? 0)}%</div>` : ""}
        ${st.dyn.on ? `<div class="mfr-wp-sum">Динамика факта за период ${st.dyn.from ? "с " + esc(st.dyn.from) : "с начала"} ${st.dyn.to ? "по " + esc(st.dyn.to) : "по настоящее время"}: полоса — «стало», риска — «было».</div>` : ""}
        ${!all.length ? `<p class="v2-muted">Работ не выбрано${w ? " — кнопка «Состав работ»" : ""}.</p>` : shown.length ? `<div class="mfr-wp-tree">${treeHtml(shown)}</div>` : `<p class="v2-muted">Ничего не подходит под отбор. <button type="button" class="v2-link-btn" data-mbp="reset-filter">Сбросить отбор</button></p>`}`;
    }
    const n = st.counts && st.counts !== "error" ? (st.counts[blockId] || 0) : st.counts === "error" ? "?" : "…";
    return `<div class="mfr-wp"><h4>Запланированные работы <span class="mfr-count" title="Активных ЗР у блока">${esc(n)}</span></h4>
      ${many ? `<p class="v2-muted">Выбрано блоков: ${selectedIds.length}. «Состав работ» и «Сроки» применяются ко всем выбранным.</p>` : ""}
      <div class="mfr-wp-acts">${w ? `<button type="button" class="v2-btn v2-primary" data-mbp="fact" data-id="${blockId}" ${many ? 'disabled title="Факт вводится по одному блоку"' : ""}>Факт</button>
        <button type="button" class="v2-btn" data-mbp="settings">Состав работ${many ? ` (${selectedIds.length})` : ""}</button>
        <button type="button" class="v2-btn" data-mbp="dates">Сроки</button>` : `<span class="v2-muted">Только просмотр (нет права на изменение)</span>`}</div>
      ${body}</div>`;
  }

  function objectHtml() {
    ensureBase();
      if (!st.objectWorks && !st.objectWorksLoading) loadObjectWorks();
      if (st.objectWorksError) return `<p class="v2-muted" role="alert">Работы объекта недоступны: ${esc(st.objectWorksError)}</p>`;
      if (!st.objectWorks) return `<p class="v2-muted" role="status">Загрузка работ объекта…</p>`;
      const works = st.objectWorks.works || [];
      return `<section class="mfr-wp"><h4>Работы всего объекта <span class="mfr-count" title="Операции с единицей измерения вне блока">${works.length}</span></h4>
        <p class="v2-muted">Блок не выбран — показан план/факт текущего объекта. Состав работ блока здесь не меняется.</p>
        <div class="mfr-wp-acts"><button type="button" class="v2-btn" data-mbp="object-settings">Состав работ</button>
          <button type="button" class="v2-btn" data-mbp="object-dates">План и сроки</button>
          <button type="button" class="v2-btn v2-primary" data-mbp="object-fact">Факт</button></div>
        ${works.length ? `<div class="mfr-wp-tree">${works.map((w) => `<div class="mfr-wp-op"><div class="mfr-wp-name">${esc(w.path)} <span class="v2-muted">· ${esc(w.unit)}</span></div><div class="mfr-wp-bar" role="img" aria-label="Выполнено ${esc(w.percent)}%"><i style="width:${esc(w.percent)}%"></i></div><div class="mfr-wp-meta"><span>${esc(w.percent)}%</span><span>план ${esc(shortDate(w.plan_start))}–${esc(shortDate(w.plan_end))}</span><span>прогноз ${esc(shortDate(w.forecast_start))}–${esc(shortDate(w.forecast_end))}</span></div></div>`).join("")}</div>` : `<p class="v2-muted">Работы объекта не выбраны. Откройте «Состав работ».</p>`}</section>`;
  }

  // Пустой выбор: план/факт всего объекта и блоки текущего отбора со счётчиками ЗР.
  function blocksListHtml(m) {
    ensureBase();
    const objectSection = objectHtml();
    if (st.blocks === null) return objectSection + `<p class="v2-muted">Загрузка блоков…</p>`;
    if (st.blocksErr) return objectSection + `<p class="v2-muted">Список блоков недоступен: ${esc(st.blocksErr)}</p>`;
    const onIds = (arr) => new Set((arr || []).filter((x) => x.on).map((x) => String(x.id)));
    const lv = onIds(m?.levels), sc = onIds(m?.sections);
    const list = st.blocks.filter((b) => (!lv.size || lv.has(String(b.level_id))) && (!sc.size || sc.has(String(b.section_id))));
    if (!list.length) return objectSection + `<p class="v2-muted">В выбранных этажах и секциях блоков нет.</p>`;
    const cnt = (id) => (st.counts === null ? "…" : st.counts === "error" ? "?" : st.counts[id] || 0);
    return `${objectSection}<h4>Блоки${lv.size || sc.size ? " выбранных этажей и секций" : ""} · ${list.length}</h4><p class="v2-muted">Справа — число активных ЗР. Щелчок выбирает блок на плане.</p>
      <div class="mfr-wp-blocks">${list.slice(0, 300).map((b) => `<button type="button" class="mfr-blk" data-mbp="pick" data-id="${b.id}"><span>${esc(labelOf(b))}</span><span class="mfr-count${st.counts === "error" ? " error" : ""}">${esc(cnt(b.id))}</span></button>`).join("")}</div>
      ${list.length > 300 ? `<p class="v2-muted">Показаны первые 300 — сузьте отбор.</p>` : ""}`;
  }

  // ---------------------------------------------------------------- HTML для панели «Фильтры»
  function filtersHtml() {
    ensureBase();
    const f = st.filter;
    const chk = (kind, val, label) => `<label class="ws-check"><input type="checkbox" data-mbp-f="${kind}" value="${esc(val)}" ${f[kind].has(val) ? "checked" : ""}> <span>${esc(label)}</span></label>`;
    const sec = (id, title, body, note) => `<section class="ws-fgroup"><button type="button" class="ws-fh" data-mbp="toggle" data-id="${id}" aria-expanded="${st.open.has(id)}"><span>${st.open.has(id) ? "▾" : "▸"} ${esc(title)}</span></button>${st.open.has(id) ? `<div class="ws-fbody">${note ? `<p class="v2-muted ws-fnote">${esc(note)}</p>` : ""}${body}</div>` : ""}</section>`;
    const tracks = st.chess.tracks;
    return `<div class="mfr-wp"><div class="ws-fhead"><span>Работы блока</span><button type="button" class="v2-btn" data-mbp="reset-filter" ${filterActive(f) ? "" : "disabled"}>Сбросить отбор работ</button></div>
      ${sec("works", "Виды работ", tracks.length ? tracks.map((t) => chk("tracks", t.code, t.name)).join("") : `<p class="v2-muted">Досок нет</p>`, "Сужает работы в карточке блока по доске (треку планирования); план не перекрашивает. Ничего не отмечено — без отбора.")}
      ${sec("status", "Статус выполнения", Object.entries(WORK_STATUS).map(([k, t]) => chk("statuses", k, t)).join(""))}
      ${sec("deadline", "Сроки", Object.entries(DEADLINE).map(([k, t]) => chk("deadlines", k, t)).join(""))}
      ${sec("period", "Период по плану", `<label class="ws-check"><input type="checkbox" data-mbp-p="on" ${f.period.on ? "checked" : ""}> <span>отбирать по периоду</span></label>
        <label class="ws-check"><span>по</span> <select data-mbp-p="field"><option value="plan" ${f.period.field === "plan" ? "selected" : ""}>плану</option><option value="forecast" ${f.period.field === "forecast" ? "selected" : ""}>прогнозу</option></select></label>
        <label class="ws-check"><span>с</span> <input type="date" data-mbp-p="from" value="${esc(f.period.from)}"></label><label class="ws-check"><span>по</span> <input type="date" data-mbp-p="to" value="${esc(f.period.to)}"></label>`,
        "ЗР, чей план (или прогноз) пересекается с периодом. Без дат у работы — в отбор не входит.")}
      ${sec("dynamics", "Динамика факта за период", `<label class="ws-check"><input type="checkbox" data-mbp-d="on" ${st.dyn.on ? "checked" : ""}> <span>показывать изменения факта</span></label>
        ${st.dyn.on ? `<label class="ws-check"><span>с</span> <input type="date" data-mbp-d="from" value="${esc(st.dyn.from)}"></label><label class="ws-check"><span>по</span> <input type="date" data-mbp-d="to" value="${esc(st.dyn.to)}"></label>
        <p class="v2-muted ws-fnote">Пустые даты — «за весь период». Подсвечено блоков: ${esc(st.dynSnap.blocks)}.</p>` : ""}`,
        "Подсвечивает на плане блоки, где факт менялся в периоде (сравнение снимков на границах периода).")}</div>`;
  }

  // ---------------------------------------------------------------- HTML для панели «Вид»
  function viewHtml() {
    ensureBase();
    const c = st.chess;
    const cur = c.tracks.find((t) => t.code === c.track);
    const dl = c.deadlineColors || {};
    const legend = c.track ? (c.mode === "deadline"
      ? Object.entries(DEADLINE).map(([k, t]) => `<span class="mfr-lg"><i style="background:${esc(dl[k] || "#999")}"></i>${esc(t)}</span>`).join("")
      : `<span class="mfr-lg"><i style="background:var(--muted)"></i>не начата</span><span class="mfr-lg"><i style="background:#E8A33D"></i>в работе</span><span class="mfr-lg"><i style="background:#3FA76A"></i>выполнена</span>`) : "";
    return `<div class="ws-pad mfr-wp"><h4>Шахматка</h4>
      <p class="v2-muted">Раскраска блоков плана по доске — группе видов работ одного трека: цвет — среднее по её работам, подпись на блоке — по строке на работу.</p>
      <div class="ws-fbody"><label class="ws-check"><span>Доска</span> <select data-mbp-c="track"><option value="">— выключено —</option>${c.tracks.map((t) => `<option value="${esc(t.code)}" ${t.code === c.track ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
      <div class="ws-check" role="group" aria-label="Режим раскраски"><label><input type="radio" name="mbp-mode" data-mbp-c="mode" value="progress" ${c.mode === "progress" ? "checked" : ""}> по выполнению</label> <label><input type="radio" name="mbp-mode" data-mbp-c="mode" value="deadline" ${c.mode === "deadline" ? "checked" : ""}> по срокам</label></div>
      ${cur ? `<div class="mfr-lgs">${legend}</div>` : ""}</div>
      <p class="v2-muted ws-fnote">Плоская развёртка здания и пакетный ввод факта — <a class="v2-link" href="#/chess-flat">«Плоская шахматка»</a>.</p></div>`;
  }

  // ---------------------------------------------------------------- события
  function bind(root, ctx) {
    root.querySelectorAll("[data-mbp]").forEach((b) => {
      const a = b.dataset.mbp, id = Number(b.dataset.id);
      const handler = () => {
        const sel = ctx?.selectedBlocks?.() || [];
        const many = sel.length ? sel : [id];
        if (a === "retry") loadProgress(id, true);
        else if (a === "pick") send("mfrSelect", { kind: "block", id, additive: false });
        else if (a === "toggle") { st.open.has(b.dataset.id) ? st.open.delete(b.dataset.id) : st.open.add(b.dataset.id); repaint(); }
        else if (a === "reset-filter") { st.filter = newFilter(); repaint(); }
        else if (a === "fact") openFactDialog({ api, objectId: st.objectId, blockId: id, blockLabel: labelsMap()[id] || `блок ${id}`, canWrite: canWrite(), onChanged: () => refreshAll(id) });
        else if (a.startsWith("object-")) openObjectWorkDialog({ api, objectId: st.objectId, canWrite: canWrite(),
          initialTab: a.slice(7), onChanged: () => loadObjectWorks(true) });
        else if (a === "settings") openSettingsDialog({ api, objectId: st.objectId, blocks: many.map((i) => ({ id: i, label: labelsMap()[i] || `блок ${i}` })), canWrite: canWrite(), onSaved: () => refreshAll(id) });
        else if (a === "dates") openDates(many);
      };
      b.addEventListener("click", handler);
    });
    root.querySelectorAll("[data-bw]").forEach((row) => {
      const open = () => openZrDialog({ api, objectId: st.objectId, id: Number(row.dataset.bw), canWrite: canWrite(), blockLabels: labelsMap(), onSaved: () => refreshAll(null) });
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    root.querySelectorAll("[data-mbp-f]").forEach((c) => c.addEventListener("change", () => { const s = st.filter[c.dataset.mbpF]; c.checked ? s.add(c.value) : s.delete(c.value); repaint(); }));
    root.querySelectorAll("[data-mbp-p]").forEach((c) => c.addEventListener("change", () => {
      const k = c.dataset.mbpP; st.filter.period[k] = k === "on" ? c.checked : c.value; repaint();
    }));
    root.querySelectorAll("[data-mbp-d]").forEach((c) => c.addEventListener("change", () => {
      const k = c.dataset.mbpD; st.dyn[k] = k === "on" ? c.checked : c.value;
      send("mfrDynamics", { on: st.dyn.on, from: st.dyn.from || null, to: st.dyn.to || null });
      for (const id of st.progress.keys()) loadProgress(id, true);
      repaint();
    }));
    root.querySelectorAll("[data-mbp-c]").forEach((c) => c.addEventListener("change", () => {
      if (c.dataset.mbpC === "track") st.chess.track = c.value || null; else if (c.checked) st.chess.mode = c.value;
      send("mfrChess", { track: st.chess.track, mode: st.chess.mode });
      repaint();
    }));
  }
  async function openDates(blockIds) {
    try {
      const d = await api.get(`/objects/${st.objectId}/block-works?block_ids=${blockIds.join(",")}`);
      openBulkDatesDialog({ api, objectId: st.objectId, items: d.items || [], canWrite: canWrite(), onDone: () => refreshAll(blockIds[0]) });
    } catch (e) { alert_(errText(e)); }
  }
  const alert_ = (t) => { import("./dialogs.js").then((m) => m.showInfoDialog(`Не удалось получить работы блоков: ${t}`)); };

  return {
    blockHtml, objectHtml, blocksListHtml, filtersHtml, viewHtml, bind,
    canWrite,
    // снимок сцены → состояние шахматки и динамики движка (источник истины — кадр)
    onScene(s) {
      const m = s?.mfr; if (!m) return;
      if (m.chess) st.chess = { tracks: m.chess.tracks || [], track: m.chess.track ?? null, mode: m.chess.mode || "progress", deadlineColors: m.chess.deadlineColors || {} };
      if (m.dynamics) { st.dyn.on = !!m.dynamics.active; st.dynSnap = { blocks: m.dynamics.blocks || 0 }; if (!st.dyn.on) { /* даты остаются в полях */ } }
    },
    summary() { return { chess: st.chess.tracks.find((t) => t.code === st.chess.track)?.name || null, mode: st.chess.mode, dyn: st.dyn.on ? { ...st.dyn } : null, filter: filterActive(st.filter) }; },
    reset() { st.objectId = null; st.blocks = null; st.rights = null; st.objectWorks = null; st.objectWorksError = ""; st.progress.clear(); ensureBase(); },
    // «Сбросить все» (V1: mfr-reset-all-filters) — вместе с этажами/секциями/категориями сбрасывает отбор работ и выключает динамику факта
    resetAll() {
      st.filter = newFilter();
      if (st.dyn.on) { st.dyn = { on: false, from: "", to: "" }; send("mfrDynamics", { on: false, from: null, to: null }); for (const id of st.progress.keys()) loadProgress(id, true); }
      repaint();
    },
    anyActive() { return filterActive(st.filter) || st.dyn.on; },
    // подписи блоков «секция · этаж» (для перечня выделенных блоков — как полоса группы V1 updateBlockGroupUi)
    labels() { return labelsMap(); },
    destroy() { dead = true; closeAllModals(); },
  };
}
