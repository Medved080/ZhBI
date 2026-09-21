// Рабочее место со схемой внутри V2 (модель ЖБИ; та же основа — для остальных рабочих мест).
//
// Сцену (2D SVG / 3D / выбор / фильтры) рисует движок V1 — его нельзя вынуть из документа V1 без переписывания app.js (глобальный DOM),
// поэтому он подключён в кадре в специальном режиме `?embed=scene`: в кадре ТОЛЬКО сцена (без шапки, меню, панелей), а всё остальное —
// шапка рабочего места, инструменты, правая панель, строка состояния — делает эта оболочка. Связь — узкий мост `postMessage`
// (`/static/embed-bridge.js`, протокол `zhbi-scene/1`): источник и origin проверяются в обе стороны, принимаются только команды из белого
// списка с проверенными параметрами, никакого HTML и кода. Кадр работает только на чтение (движок отсекает любые изменяющие запросы),
// изменяющие операции — только через `api.js` оболочки и его шлюз записи (`write-gate.js`).
//
// Единый источник состояния: объект (`objectId`) хранит оболочка (шапка V2); кадр получает его командой и подтверждает в снимке.
// Выбор, фильтры и режим 2D/3D живут в движке (это его модель) — оболочка их отображает и меняет командами, своей копии не ведёт.
// Уход с рабочего места: слушатель снимается, кадр обнуляется и удаляется — вместе с документом освобождаются WebGL-контексты и таймеры.
import { esc } from "./screen-view.js";
import { ApiError } from "./api.js";

const PROTO = "zhbi-scene/1";
const VIEWS = [["2d", "2D"], ["3d", "3D"], ["3d-light", "3D лёгкий"]];
const TABS = [["props", "Свойства"], ["status", "Статус"], ["filters", "Фильтры"], ["view", "Вид"]];
const FRAME_TIMEOUT_MS = 45000;

const fmtDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const fmtDateTime = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : fmtDate(v); };
const readNum = (k, d) => { try { const v = Number(sessionStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch (e) { return d; } };
const writeSess = (k, v) => { try { sessionStorage.setItem(k, String(v)); } catch (e) { /* хранилище недоступно — не критично */ } };

export function mountWorkspace(el, { screen, objectId, api, groupTitle, ws = "model" }) {
  el.className = "v2-page v2-app v2-ws";
  const WS_TITLE = screen.title;
  let dead = false;
  let curObject = objectId;
  let frame = null;
  let ready = false;
  let timeoutId = null;
  const queue = [];
  let sc = null;               // последний снимок сцены из кадра
  let filters = null;          // модель фильтров
  let notice = "";             // последнее сообщение движка
  let tab = "props";
  let panelHidden = false;
  let panelW = readNum("v2.ws.panelW", 340);
  const detail = { id: null, data: null, error: "", seq: 0 };
  const openGroups = new Set(["status"]);
  const openItems = new Set();
  const groupSearch = new Map();
  let frameKey = 0;

  el.innerHTML = `
    <div class="ws-top">
      <div class="ws-title"><strong>${esc(WS_TITLE)}</strong><span class="ws-crumb" id="ws-crumb"></span></div>
      <div class="ws-seg" role="group" aria-label="Режим схемы" id="ws-modes">${VIEWS.map(([k, t]) => `<button type="button" data-view="${k}" aria-pressed="false">${t}</button>`).join("")}</div>
      <span class="ws-spacer"></span>
      <button type="button" class="ws-ibtn" id="ws-nav" title="Свернуть или показать общую навигацию" aria-pressed="false">☰ Навигация</button>
      <button type="button" class="ws-ibtn" id="ws-panel-toggle" title="Свернуть или показать правую панель" aria-pressed="true">Панель ▸</button>
    </div>
    <div class="ws-main">
      <div class="ws-stage" id="ws-stage">
        <div class="ws-tools" role="toolbar" aria-label="Инструменты схемы">
          <button type="button" data-tool="fit" title="Вписать схему в экран" aria-label="Вписать схему в экран">⤢</button>
          <button type="button" data-tool="in" title="Приблизить" aria-label="Приблизить">＋</button>
          <button type="button" data-tool="out" title="Отдалить" aria-label="Отдалить">－</button>
          <button type="button" data-tool="clear" title="Снять выбор" aria-label="Снять выбор">✕</button>
        </div>
        <div class="ws-overlay" id="ws-overlay" role="status" aria-live="polite"></div>
      </div>
      <div class="ws-resize" id="ws-resize" role="separator" aria-orientation="vertical" aria-label="Ширина правой панели" tabindex="0"></div>
      <aside class="ws-panel" id="ws-panel" aria-label="Панель рабочего места">
        <div class="ws-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="false">${t}</button>`).join("")}</div>
        <div class="ws-panel-body" id="ws-panel-body"></div>
      </aside>
    </div>
    <div class="ws-status" id="ws-status" role="status" aria-live="polite"></div>`;

  const $ = (s) => el.querySelector(s);
  const stage = $("#ws-stage");
  const panel = $("#ws-panel");

  // ------------------------------------------------------------ связь с кадром
  function send(cmd, args = {}) {
    if (dead) return;
    const msg = { proto: PROTO, cmd, args };
    if (!ready || !frame?.contentWindow) { queue.push(msg); return; }
    frame.contentWindow.postMessage(msg, location.origin);
  }

  function onMessage(e) {
    // принимаем только сообщения от НАШЕГО кадра и с нашего origin
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.proto !== PROTO || typeof m.evt !== "string") return;
    if (m.evt === "ready") {
      ready = true; clearTimeout(timeoutId);
      for (const q of queue.splice(0)) frame.contentWindow.postMessage(q, location.origin);
      send("getFilters");
    } else if (m.evt === "state" && m.state && typeof m.state === "object") {
      onScene(m.state);
    } else if (m.evt === "filters" && m.model && Array.isArray(m.model.groups)) {
      filters = m.model; paintPanel();
    } else if (m.evt === "notice") {
      notice = String(m.message || "").slice(0, 300); paintStatus();
    } else if (m.evt === "cmd-error") {
      notice = `Команда «${String(m.cmd).slice(0, 30)}» отклонена: ${String(m.message).slice(0, 200)}`; paintStatus();
    }
  }
  window.addEventListener("message", onMessage);

  // Документ сцены — та же страница V1 (`/`), но кадр строится из srcdoc, а не по адресу: сервер запрещает показывать свои
  // страницы в чужих кадрах (X-Frame-Options/frame-ancestors) и заголовки менять нельзя. Кадр из srcdoc наследует origin
  // и CSP оболочки; параметры режима сцены (объект) лежат в атрибуте <iframe>, движок V1 читает их оттуда (app.js, EMBED_QUERY).
  async function fetchScenePage() {
    const r = await fetch("/", { credentials: "same-origin", cache: "no-cache" });
    if (!r.ok) throw new Error(`страница схемы недоступна (${r.status})`);
    const t = await r.text();
    if (!/<html[\s>]/i.test(t) || !/\/static\/app\.js/.test(t)) throw new Error("сервер вернул не страницу схемы");
    return t.replace(/<head>/i, '<head><base href="/">');
  }

  async function startFrame() {
    if (dead) return;
    stopFrame();
    ready = false; sc = null; filters = null; notice = "";
    const key = ++frameKey;
    paintAll();
    let html;
    try { html = await fetchScenePage(); } catch (e) {
      if (dead || key !== frameKey) return;
      sc = { error: `Не удалось загрузить схему: ${e.message || e}`, timeout: false }; paintAll(); return;
    }
    if (dead || key !== frameKey) return; // за время загрузки страницы объект/раздел сменились
    frame = document.createElement("iframe");
    frame.className = "ws-frame";
    frame.title = `Схема: ${WS_TITLE}`;
    frame.style.visibility = "hidden";
    const p = new URLSearchParams({ embed: "scene", object_id: String(curObject) });
    if (ws !== "model") p.set("ws", ws);
    frame.setAttribute("data-zhbi-scene", p.toString());
    frame.srcdoc = html;
    stage.prepend(frame);
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (!dead && key === frameKey && !ready) { sc = { error: "Схема не загрузилась вовремя. Проверьте связь и повторите.", timeout: true }; paintAll(); }
    }, FRAME_TIMEOUT_MS);
  }
  function stopFrame() {
    clearTimeout(timeoutId);
    if (frame) { try { frame.srcdoc = ""; } catch (e) { /* ignore */ } frame.remove(); frame = null; }
    ready = false;
  }

  function onScene(s) {
    const prevSel = sc?.selectedId ?? null;
    sc = s;
    if (frame) frame.style.visibility = (s.loaded || s.loading) && !s.error ? "visible" : "hidden";
    if ((s.selectedId ?? null) !== prevSel) loadDetail(s.selectedId ?? null);
    paintAll();
  }

  async function loadDetail(id) {
    detail.id = id; detail.data = null; detail.error = "";
    const seq = ++detail.seq;
    if (id === null) return;
    try {
      const d = await api.get(`/elements/${id}`);
      if (dead || seq !== detail.seq || detail.id !== id) return; // запоздавший ответ прежнего выбора не подменяет текущий
      detail.data = d;
    } catch (e) {
      if (dead || seq !== detail.seq) return;
      detail.error = e instanceof ApiError ? String(e.detail) : "Не удалось загрузить историю элемента";
    }
    paintPanel();
  }

  // ------------------------------------------------------------ отрисовка
  function paintAll() { if (dead) return; paintTop(); paintOverlay(); paintPanel(); paintStatus(); }

  function paintTop() {
    const crumb = $("#ws-crumb");
    const name = sc?.objectName ? `${sc.projectName ? sc.projectName + " · " : ""}${sc.objectName}` : "";
    crumb.textContent = name;
    for (const b of el.querySelectorAll("#ws-modes button")) b.setAttribute("aria-pressed", String(sc?.view === b.dataset.view));
  }

  function paintOverlay() {
    const o = $("#ws-overlay");
    let html = "";
    if (sc?.error) {
      html = `<div class="ws-msg ws-msg-bad" role="alert"><strong>Схему не удалось показать.</strong><p>${esc(sc.error)}</p><button type="button" class="v2-btn v2-primary" data-act="retry">Повторить</button></div>`;
    } else if (sc && sc.loaded && !sc.loading && sc.hasDrawing === false) {
      html = `<div class="ws-msg"><strong>У объекта нет загруженного чертежа.</strong><p>Схему показать нечем: загрузите чертёж в разделе «Обмен данными» текущего интерфейса.</p></div>`;
    } else if (sc && sc.loaded && !sc.loading && sc.total === 0) {
      html = `<div class="ws-msg"><strong>В схеме нет элементов.</strong><p>У выбранного объекта чертёж загружен, но элементов в нём нет.</p></div>`;
    } else if (!sc || sc.loading || !sc.loaded) {
      html = `<div class="ws-msg ws-msg-load"><span class="ws-spin" aria-hidden="true"></span> Загрузка схемы…</div>`;
    }
    o.innerHTML = html;
    o.hidden = !html;
    o.querySelector('[data-act="retry"]')?.addEventListener("click", () => startFrame());
  }

  const sw = (status) => sc?.statusColors?.[status] || "#999";
  const stLabel = (status) => sc?.statusLabels?.[status] || status || "—";

  function paintPanel() {
    if (dead) return;
    for (const b of el.querySelectorAll(".ws-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    const body = $("#ws-panel-body");
    const keepScroll = body.scrollTop;
    body.innerHTML = tab === "props" ? propsHtml() : tab === "status" ? statusHtml() : tab === "filters" ? filtersHtml() : viewHtml();
    body.scrollTop = keepScroll;
    bindPanel(body);
  }

  function row(k, v) { return v === null || v === undefined || v === "" ? "" : `<div class="ws-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`; }

  function propsHtml() {
    if (!sc || !sc.loaded) return `<p class="v2-muted ws-pad">Схема загружается…</p>`;
    if (sc.multi && sc.multi.count > 1) {
      const m = sc.multi;
      return `<div class="ws-pad"><h3 class="ws-h">Выбрано элементов: ${m.count}</h3>
        <p class="v2-muted">Показаны сведения по всей выборке. Групповые изменения статуса выполняются в текущем интерфейсе.</p>
        <h4>По типам</h4><ul class="ws-list">${m.byType.sort((a, b) => b[1] - a[1]).map(([t, n]) => `<li><span>${esc(t)}</span><b>${n}</b></li>`).join("")}</ul>
        <h4>По статусам</h4><ul class="ws-list">${m.byStatus.sort((a, b) => b[1] - a[1]).map(([s, n]) => `<li><span><i class="ws-sw" style="background:${esc(sw(s))}"></i>${esc(stLabel(s))}</span><b>${n}</b></li>`).join("")}</ul>
        <button type="button" class="v2-btn" data-act="clear-all">Снять выбор</button></div>`;
    }
    const e = sc.selected;
    if (!e) {
      return `<div class="ws-pad ws-empty"><h3 class="ws-h">Ничего не выбрано</h3>
        <p class="v2-muted">Нажмите на элемент схемы, чтобы увидеть его свойства. Shift + перетаскивание — выбор рамкой.</p>
        <dl class="ws-dl">${row("Показано на схеме", `${sc.shown} из ${sc.total}`)}${row("Активных фильтров", sc.excluded ? String(sc.excluded) : "нет")}</dl></div>`;
    }
    const d = detail.id === e.id ? detail.data : null;
    const z = e.zones || {};
    const hist = d?.history || [];
    return `<div class="ws-pad"><div class="ws-card-head">
        <div class="ws-mark">${esc(e.mark || "—")}</div>
        <div class="ws-type">${esc(e.element_type)}${e.subtype ? ` <span class="v2-muted">· ${esc(e.subtype)}</span>` : ""}</div>
        <div class="ws-chip"><i class="ws-sw" style="background:${esc(sw(e.current_status))}"></i>${esc(stLabel(e.current_status))}</div></div>
      <div class="ws-actions"><button type="button" class="v2-btn" data-act="locate">Показать на схеме</button><button type="button" class="v2-btn" data-act="clear-all">Снять выбор</button></div>
      <h4>Размещение</h4><dl class="ws-dl">${row("Адрес по осям", e.address)}${row("Этаж", e.floor)}${row("Отметка, мм", e.elevation_mm)}${row("Захватка", z.zakhvatka)}${row("Кран", z.crane)}${row("Стоянка", z.stance)}</dl>
      <h4>Контрактация</h4><dl class="ws-dl">${e.contract_id ? `${row("Контрагент", e.supplier)}${row("Контракт", e.contractName)}` : row("Контракт", "не назначен")}</dl>
      <h4>Даты</h4><dl class="ws-dl">${row("Начало СМР", fmtDate(e.project_smr_start_date))}${row("Плановая поставка", fmtDate(e.planned_delivery_date))}${row("Фактическая поставка", fmtDate(e.actual_delivery_date))}${row("Завершение СМР", fmtDate(e.project_delivery_date))}</dl>
      ${e.comment ? `<h4>Комментарий</h4><p class="ws-comment">${esc(e.comment)}</p>` : ""}
      <h4>История статусов</h4>${detail.error ? `<p class="v2-muted">${esc(detail.error)}</p>` : !d ? `<p class="v2-muted">Загрузка…</p>` : hist.length ? `<ul class="ws-hist">${hist.map((h) => `<li><i class="ws-sw" style="background:${esc(sw(h.status))}"></i><span>${esc(stLabel(h.status))}</span><small>${esc(fmtDateTime(h.changed_at))}${h.changed_by ? " · " + esc(h.changed_by) : ""}</small></li>`).join("")}</ul>` : `<p class="v2-muted">Изменений статуса нет.</p>`}
      <p class="v2-muted ws-ro">Изменение статуса и дат выполняется в текущем интерфейсе.</p></div>`;
  }

  function statusHtml() {
    if (!sc || !sc.loaded) return `<p class="v2-muted ws-pad">Схема загружается…</p>`;
    const counts = new Map(sc.statusCounts || []);
    const order = sc.statusOrder?.length ? sc.statusOrder : Array.from(counts.keys());
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    return `<div class="ws-pad"><h3 class="ws-h">Статусы на схеме</h3>
      <p class="v2-muted">Считаются по показанным элементам: ${total} из ${sc.total}.</p>
      <ul class="ws-list">${order.map((s) => `<li><span><i class="ws-sw" style="background:${esc(sw(s))}"></i>${esc(stLabel(s))}</span><b>${counts.get(s) || 0}</b></li>`).join("")}</ul></div>`;
  }

  // ---- фильтры
  function itemHtml(g, it, branchKey) {
    const key = branchKey || g.key;
    const dis = it.enabled ? "" : " ws-dim";
    return `<label class="ws-check${dis}"><input type="checkbox" data-g="${esc(g.id)}" data-key="${esc(key)}" data-v="${esc(JSON.stringify(it.v))}" ${it.on ? "checked" : ""}> <span>${esc(it.label)}</span><em>${it.count}</em></label>`;
  }
  function filtersHtml() {
    if (!filters) return `<p class="v2-muted ws-pad">${sc?.loaded === false ? "Схема загружается…" : "Загрузка фильтров…"}</p>`;
    if (!filters.groups.length) return `<p class="v2-muted ws-pad">Нет данных для фильтрации.</p>`;
    const head = `<div class="ws-fhead"><span>${sc ? `Показано ${sc.shown} из ${sc.total}` : ""}</span><button type="button" class="v2-btn" data-act="reset-filters" ${sc?.excluded ? "" : "disabled"}>Сбросить все</button></div>`;
    return head + filters.groups.map((g) => {
      const excluded = g.items.reduce((n, it) => n + (it.on ? 0 : 1) + (it.branches ? Object.values(it.branches).reduce((m, arr) => m + arr.filter((x) => !x.on).length, 0) : 0), 0);
      const open = openGroups.has(g.id);
      const q = (groupSearch.get(g.id) || "").toLowerCase();
      const many = g.items.length > 12;
      const items = g.items.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.branches && Object.values(it.branches).some((arr) => arr.some((x) => x.label.toLowerCase().includes(q)))));
      const body = !open ? "" : `<div class="ws-fbody">${many ? `<input type="search" class="ws-fsearch" data-search="${esc(g.id)}" placeholder="Найти…" value="${esc(groupSearch.get(g.id) || "")}" aria-label="Найти в группе «${esc(g.title)}»">` : ""}
        <div class="ws-factions"><button type="button" data-all="${esc(g.id)}" data-on="1">Все</button><button type="button" data-all="${esc(g.id)}" data-on="0">Ничего</button></div>
        ${items.map((it) => {
          if (g.kind !== "tree") return itemHtml(g, it);
          const id = `${g.id}::${JSON.stringify(it.v)}`;
          const exp = openItems.has(id) || !!q;
          const kids = it.branches ? Object.entries(it.branches) : [];
          const nKids = kids.reduce((n, [, arr]) => n + arr.length, 0);
          return `<div class="ws-tree"><div class="ws-tree-row">${nKids ? `<button type="button" class="ws-exp" data-exp="${esc(id)}" aria-expanded="${exp}" aria-label="Развернуть «${esc(it.label)}»">${exp ? "▾" : "▸"}</button>` : `<span class="ws-exp"></span>`}${itemHtml(g, it)}</div>
            ${exp ? kids.map(([bk, arr]) => `<div class="ws-branch"><div class="ws-btitle">${esc(g.branchTitles?.[bk] || bk)}</div>${arr.filter((x) => !q || x.label.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)).map((x) => itemHtml(g, x, bk)).join("")}</div>`).join("") : ""}</div>`;
        }).join("")}</div>`;
      return `<section class="ws-fgroup"><button type="button" class="ws-fh" data-group="${esc(g.id)}" aria-expanded="${open}"><span>${open ? "▾" : "▸"} ${esc(g.title)}</span>${excluded ? `<b class="ws-badge">снято: ${excluded}</b>` : ""}</button>${body}</section>`;
    }).join("");
  }

  function viewHtml() {
    const zones = sc?.zones || [];
    return `<div class="ws-pad"><h3 class="ws-h">Режим схемы</h3>
      <div class="ws-seg ws-seg-wide" role="group" aria-label="Режим схемы">${VIEWS.map(([k, t]) => `<button type="button" data-view="${k}" aria-pressed="${sc?.view === k}">${t}</button>`).join("")}</div>
      <p class="v2-muted">2D — плоская схема; 3D — модель; 3D лёгкий — упрощённая модель для слабых компьютеров.</p>
      ${zones.length ? `<h4>Зоны на схеме</h4>${zones.map((z) => `<label class="ws-check"><input type="checkbox" data-zone="${esc(z.category)}" ${z.on ? "checked" : ""}> <span>${esc(z.category === "Кран" ? "Краны" : "Захватки")}</span></label>`).join("")}` : ""}
      <h4>Масштаб</h4><div class="ws-actions"><button type="button" class="v2-btn" data-tool="fit">Вписать в экран</button></div></div>`;
  }

  function bindPanel(body) {
    body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.act;
      if (a === "clear-all") send("clearSelection");
      else if (a === "locate" && sc?.selected) send("locate", { id: sc.selected.id });
      else if (a === "reset-filters") send("resetFilters");
    }));
    body.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => tool(b.dataset.tool)));
    body.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => send("setView", { mode: b.dataset.view })));
    body.querySelectorAll("[data-zone]").forEach((c) => c.addEventListener("change", () => send("setZoneVisible", { category: c.dataset.zone, on: c.checked })));
    body.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => { const g = b.dataset.group; openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g); paintPanel(); }));
    body.querySelectorAll("[data-exp]").forEach((b) => b.addEventListener("click", () => { const g = b.dataset.exp; openItems.has(g) ? openItems.delete(g) : openItems.add(g); paintPanel(); }));
    body.querySelectorAll("[data-search]").forEach((i) => i.addEventListener("input", () => {
      groupSearch.set(i.dataset.search, i.value); const pos = i.selectionStart; paintPanel();
      const n = el.querySelector(`[data-search="${CSS.escape(i.dataset.search)}"]`); if (n) { n.focus(); n.setSelectionRange(pos, pos); }
    }));
    body.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => bulkGroup(b.dataset.all, b.dataset.on === "1")));
    body.querySelectorAll("input[data-key]").forEach((c) => c.addEventListener("change", () => toggleItem(c)));
  }

  // Переключение значения фильтра. У родителя дерева (тип, кран, контрагент) переключаются и его дочерние значения — как в V1.
  function toggleItem(c) {
    if (!filters) return;
    const g = filters.groups.find((x) => x.id === c.dataset.g);
    if (!g) return;
    const key = c.dataset.key; let v; try { v = JSON.parse(c.dataset.v); } catch (e) { return; }
    const on = c.checked;
    const changes = [{ key, values: [v], on }];
    if (g.kind === "tree" && key === g.key) {
      const it = g.items.find((x) => JSON.stringify(x.v) === c.dataset.v);
      for (const [bk, arr] of Object.entries(it?.branches || {})) if (arr.length) changes.push({ key: bk, values: arr.map((x) => x.v), on });
    }
    send("setFilter", { changes });
  }
  function bulkGroup(gid, on) {
    const g = filters?.groups.find((x) => x.id === gid);
    if (!g) return;
    const byKey = new Map();
    const add = (k, v) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(v); };
    for (const it of g.items) { add(g.key, it.v); for (const [bk, arr] of Object.entries(it.branches || {})) for (const x of arr) add(bk, x.v); }
    send("setFilter", { changes: Array.from(byKey, ([key, values]) => ({ key, values, on })) });
  }

  function tool(t) {
    if (t === "fit") send("fit");
    else if (t === "in") send("zoom", { factor: 1 / 1.3 });
    else if (t === "out") send("zoom", { factor: 1.3 });
    else if (t === "clear") send("clearSelection");
  }

  function paintStatus() {
    const s = $("#ws-status");
    if (!sc || !sc.loaded) { s.textContent = sc?.error ? "Схема не загружена" : "Загрузка схемы…"; return; }
    const sel = sc.multi?.count > 1 ? `Выбрано: ${sc.multi.count}` : sc.selected ? `Выбран: ${sc.selected.mark || sc.selected.element_type}` : "Ничего не выбрано";
    s.innerHTML = `<span>Показано <b>${sc.shown}</b> из <b>${sc.total}</b></span><span>${esc(sel)}</span><span>${sc.excluded ? `Фильтры активны: снято ${sc.excluded}` : "Фильтры не заданы"}</span><span>Режим: ${esc((VIEWS.find((v) => v[0] === sc.view) || [])[1] || "")}</span><span class="ws-ro-chip" title="Изменения выполняются в текущем интерфейсе">только просмотр</span>${notice ? `<span class="ws-notice" title="${esc(notice)}">${esc(notice)}</span>` : ""}`;
  }

  // ------------------------------------------------------------ управление
  $("#ws-modes").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) send("setView", { mode: b.dataset.view }); });
  el.querySelector(".ws-tools").addEventListener("click", (e) => { const b = e.target.closest("[data-tool]"); if (b) tool(b.dataset.tool); });
  el.querySelector(".ws-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; paintPanel(); } });

  const shellSide = () => document.getElementById("v2-side");
  const navWasHidden = shellSide()?.hidden === true;
  $("#ws-nav").addEventListener("click", () => {
    const side = shellSide(); if (!side) return;
    side.hidden = !side.hidden;
    $("#ws-nav").setAttribute("aria-pressed", String(side.hidden));
    setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
  });
  $("#ws-panel-toggle").addEventListener("click", () => {
    panelHidden = !panelHidden;
    panel.hidden = panelHidden; $("#ws-resize").hidden = panelHidden;
    $("#ws-panel-toggle").setAttribute("aria-pressed", String(!panelHidden));
    setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
  });

  // ширина правой панели: мышью и стрелками
  function setW(w) { panelW = Math.max(260, Math.min(640, Math.round(w))); panel.style.width = panelW + "px"; writeSess("v2.ws.panelW", panelW); }
  setW(panelW);
  const rz = $("#ws-resize");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId);
    if (frame) frame.style.pointerEvents = "none"; // пока тянем разделитель, кадр не должен перехватывать движение
    const move = (ev) => setW(el.getBoundingClientRect().right - ev.clientX);
    const up = () => { rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); if (frame) frame.style.pointerEvents = ""; };
    rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up);
  });
  rz.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { setW(panelW + 20); e.preventDefault(); } else if (e.key === "ArrowRight") { setW(panelW - 20); e.preventDefault(); } });

  startFrame();

  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    // Смена объекта в шапке V2: тот же кадр получает команду (кадр сам сбрасывает несовместимую выборку и фильтры,
    // запоздавший ответ прежнего объекта не применяется — мост обрабатывает только последнюю команду).
    onObjectChange(id) {
      if (dead || !id || id === curObject) return true;
      curObject = id; detail.id = null; detail.data = null; filters = null; sc = sc ? { ...sc, loaded: false, loading: true, selected: null, multi: null } : sc;
      paintAll(); send("setObject", { objectId: id });
      return true;
    },
    destroy() {
      dead = true; window.removeEventListener("message", onMessage); stopFrame(); queue.length = 0;
      const side = shellSide(); if (side) side.hidden = navWasHidden;
    },
  };
}
