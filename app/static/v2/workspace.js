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
import { showUnsavedDialog, showConfirmDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";
import { createPickerPanels } from "./picker-panels.js";
import { verifyAllocationBatch, verdictText } from "./alloc-verify.js";
import { createElementOps } from "./element-ops.js";
import { anyModalDirty, guardModals } from "./mfr-common.js";
import { writeFilterSnapshot, queueFilteredReportOpen } from "./scheme-filter-snapshot.js";
import { createWorkspaceMiniReports } from "./workspace-mini-reports.js";
import { takeLocate } from "./locate-handoff.js";

const PROTO = "zhbi-scene/1";
const VIEWS = [["2d", "2D"], ["3d", "3D"], ["3d-light", "3D лёгкий"]];
const TABS = [["props", "Свойства"], ["status", "Статус"], ["filters", "Фильтры"], ["view", "Вид"]];
// У прораба фильтры — постоянная панель слева (как в V1), поэтому в правой панели вкладки «Фильтры» нет.
const TABS_FOREMAN = TABS.filter(([k]) => k !== "filters");
// МФР: свойства блока/элемента модели Revit, фильтры (этажи, секции, категории) и вид (слои, 2D/3D)
const VIEWS_MFR = [["2d", "2D"], ["3d", "3D"]];
const TABS_MFR = [["props", "Свойства"], ["filters", "Фильтры"], ["view", "Вид"]];
// Комплектовщик: срезы отбора, показатели, контракты (свой отбор, независимый от фильтров «Модели»), свойства выбранного элемента, вид
// «Статус» — сводка статусов по изделиям среза (V1: вкладка «Статус» правой панели есть и у АРМ комплектовщика)
const TABS_PICKER = [["pick", "Отбор"], ["metrics", "Показатели"], ["contracts", "Контракты"], ["alloc", "Распределение"], ["props", "Свойства"], ["status", "Статус"], ["view", "Вид"]];
const FRAME_TIMEOUT_MS = 45000;

const fmtDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ? String(v) : "—"); };
const fmtDateTime = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : fmtDate(v); };
const readNum = (k, d) => { try { const v = Number(sessionStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch (e) { return d; } };
const writeSess = (k, v) => { try { sessionStorage.setItem(k, String(v)); } catch (e) { /* хранилище недоступно — не критично */ } };
const readSess = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };

export function mountWorkspace(el, { screen, objectId, api, groupTitle, ws = "model" }) {
  el.className = "v2-page v2-app v2-ws";
  const foreman = ws === "foreman";
  const mfr = ws === "mfr";
  const picker = ws === "picker";
  const views = mfr ? VIEWS_MFR : VIEWS;
  const tabs = mfr ? TABS_MFR : picker ? TABS_PICKER : foreman ? TABS_FOREMAN : TABS;
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
  let tab = ws === "picker" ? "pick" : "props";
  let pk = null;                // модель отбора комплектовщика (срезы, показатели, контракты)
  const al = { loaded: false, loading: false, loadError: "", contracts: [], supplier: "", contractId: null, lineKey: null, cand: null, candAsked: false, busy: false, error: "", done: "", warn: "" };
  let onlyRemainder = false;    // «только с остатком» — вид списка контрактов, отбор схемы не меняет
  let panelHidden = false;
  let panelW = readNum(ws === "picker" ? "v2.ws.panelW.picker" : "v2.ws.panelW", ws === "picker" ? 430 : 340);
  const detail = { id: null, data: null, error: "", seq: 0 };
  // Операции над изделиями (смена статуса одного и пачки, плановая дата, контракт, комментарий, история, реквизиты) — модуль element-ops.js.
  // Здесь только связка: снимок сцены, права, перерисовка панели, команды кадру.
  const ops = createElementOps({
    api, send: (c, a) => send(c, a), getScene: () => sc, getObjectId: () => curObject, statusLabel: (k) => stLabel(k), statusColor: (k) => sw(k),
    repaint: () => paintPanel(), reloadDetail: (id) => loadDetail(id), isDead: () => dead, getDetail: (id) => (detail.id === id ? detail.data : null),
    // групповые операции есть и у комплектовщика (как панель группового выделения V1); Ctrl + щелчок там только убирает из рамки (мост его не расширяет)
    groupOps: true, ctrlAdds: !picker,
  });
  let canStatus = null;         // null — права ещё не получены; true/false — можно ли менять статусы на объекте (распределение комплектовщика)
  const openGroups = new Set(["status", "pk:elementType"]);
  const openItems = new Set();
  const groupSearch = new Map();
  let frameKey = 0;
  // МФР: панель работ блока (ЗР, факт, сроки, отбор, шахматка, динамика) — отдельный модуль mfr-block-panel.js
  // (модуль подгружается при открытии рабочего места МФР, а не при старте V2)
  let mbp = null;
  if (mfr) import("./mfr-block-panel.js").then((m) => { if (dead) return; mbp = m.createMfrBlockPanel({ api, send, repaint: () => paintPanel(), getObjectId: () => curObject }); if (sc) mbp.onScene(sc); paintAll(); }).catch(() => { notice = "Панель работ блока не загрузилась"; paintStatus(); });
  const panelHtml = (name, ...args) => (mbp ? mbp[name](...args) : `<p class="v2-muted ws-pad">Загрузка панели работ…</p>`);

  el.innerHTML = `
    <div class="ws-top">
      <div class="ws-title"><strong>${esc(WS_TITLE)}</strong><span class="ws-crumb" id="ws-crumb"></span></div>
      <div class="ws-seg" role="group" aria-label="Режим схемы" id="ws-modes">${views.map(([k, t]) => `<button type="button" data-view="${k}" aria-pressed="false">${t}</button>`).join("")}</div>
      ${mfr ? "" : `<div class="ws-search"><input type="search" id="ws-q" placeholder="Найти марку или адрес" aria-label="Найти элемент по марке или адресу" autocomplete="off" maxlength="60"><div class="ws-found" id="ws-found" role="listbox" hidden></div></div>`}
      <span class="ws-spacer"></span>
      <button type="button" class="ws-ibtn" id="ws-nav" title="Показать или скрыть общую навигацию" aria-pressed="true">☰ Навигация</button>
      <button type="button" class="ws-ibtn" id="ws-panel-toggle" title="Свернуть или показать правую панель" aria-pressed="true">Панель ▸</button>
    </div>
    ${foreman ? `<div class="ws-strip" id="ws-strip" role="status" aria-label="Показатели по показанным элементам"></div>` : ""}
    <div class="ws-main">
      ${foreman ? `<aside class="ws-left" id="ws-left" aria-label="Фильтры"><div class="ws-left-head">Отбор элементов</div><div class="ws-panel-body" id="ws-left-body"></div></aside>` : ""}
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
        <div class="ws-tabs" role="tablist">${tabs.map(([k, t]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="false">${t}</button>`).join("")}</div>
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
  const mini = mfr ? null : createWorkspaceMiniReports({
    api, getObjectId: () => curObject, repaint: () => { if (tab === "status") paintPanel(); },
    requestIds: () => send("getReportIds"),
    openFull: (kind, ids) => {
      if (!ids?.length || !["status", "dynamics"].includes(kind)) return;
      const screenId = `report-${kind}`;
      writeFilterSnapshot({ objectId: curObject, ws, elementIds: ids, shown: ids.length,
        total: sc?.total || ids.length, excluded: ids.length < (sc?.total || ids.length), capturedAt: Date.now() });
      queueFilteredReportOpen(screenId, curObject);
      location.hash = `#/${screenId}`;
    },
  });
  let reportSignature = "";

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
      if (tab === "status" && sc?.loaded && m.model.groups.length) send("getReportIds");
      // Снимок «текущего фильтра схемы» для отчётов V2 (charts, scheme-filter-snapshot.js) — запрашивается ТОЛЬКО
      // здесь, когда сам отбор поменялся (не на каждый тик состояния), и только там, где есть эта модель фильтра
      // (у МФР и комплектовщика — другой, с другим смыслом; их «фильтр схемы» отчётами не используется). Пустые
      // группы — кадр ещё грузит элементы (getFilters уходит сразу по "ready", раньше самой загрузки схемы) —
      // такой снимок не запрашиваем: он лёг бы в sessionStorage нулями раньше настоящего и его перекрыл бы только
      // следующий отклик sendFilters на СТОРОНЕ V1 (он приходит, но лишний пустой снимок между ними вводит в
      // заблуждение, если отчёт откроют именно в эту секунду).
      if (!mfr && !picker && m.model.groups.length) send("getFilteredIds");
    } else if (m.evt === "filtered-ids" && Array.isArray(m.ids)) {
      // sc.loaded — сцена ДЕЙСТВИТЕЛЬНО показывает данные (не «идёт загрузка»): тот же счётчик total, что видит
      // человек на панели, а не промежуточный ноль.
      if (sc?.loaded) writeFilterSnapshot({ objectId: curObject, ws, elementIds: m.ids, shown: sc.shown, total: sc.total, excluded: sc.excluded, capturedAt: Date.now() });
    } else if (m.evt === "picker" && m.model && Array.isArray(m.model.slicers)) {
      pk = m.model;
      if (al.loaded && contractIdsKey() !== al.idsKey) al.loaded = false;   // сцена догрузилась и состав контрактов объекта изменился — перечитать, а не показывать «нет контрактов»
      paintPanel();
      if (tab === "status" && sc?.loaded) send("getReportIds");
    } else if (m.evt === "report-ids" && Array.isArray(m.ids)) {
      mini?.receive(m.ids, m.objectId);
    } else if (m.evt === "contracts" && Array.isArray(m.items)) {
      ops.setContracts(m.objectId, m.items);
    } else if (m.evt === "candidates" && Array.isArray(m.items)) {
      al.cand = { elementType: m.elementType, mark: m.mark, items: m.items }; al.candAsked = true; paintPanel();
    } else if (m.evt === "search-result" && Array.isArray(m.items)) {
      if (qInput && m.text === qInput.value) paintFound(m);
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
    ready = false; sc = null; filters = null; pk = null; notice = "";
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
    // Схема прораба — та же схема ЖБИ (его постоянную панель отбора рисует оболочка), поэтому кадр открывается как «Модель»
    if (ws === "mfr" || ws === "picker") p.set("ws", ws);
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

  // МФР: без отбора план показывает ВСЕ этажи разом (блоки накладываются друг на друга) — это не стартовый вид. При первом открытии
  // объекта выбирается первый этаж; «все этажи» остаются явным режимом (сбросом отбора) и подписаны в шапке.
  const mfrAutoLevel = new Set();
  function mfrStartView(s) {
    const m = s.mfr;
    if (!mfr || !s.loaded || !m?.hasData || !m.levels?.length || mfrAutoLevel.has(s.objectId)) return;
    mfrAutoLevel.add(s.objectId);
    if (m.levels.some((l) => l.on)) return;
    const first = m.levels.find((l) => /^1 этаж/.test(l.label)) || m.levels.find((l) => l.count > 0 && !/^без /.test(l.label));
    if (first) send("mfrPick", { kind: "level", id: first.id });
  }
  function onScene(s) {
    const prevSel = selKey(sc);
    sc = s;
    mbp?.onScene(s);
    mfrStartView(s);
    if (frame) frame.style.visibility = (s.loaded || s.loading) && !s.error ? "visible" : "hidden";
    // «Показать на схеме» из отчёта «Моя работа» (locate-handoff.js): выделить изделие и навести кадр, когда схема загружена
    if (!mfr && s.loaded) { const want = takeLocate(curObject); if (want) { send("select", { id: want }); send("locate", { id: want }); } }
    if (selKey(s) !== prevSel) loadDetail(selKey(s));
    paintAll();
    if (!mfr && tab === "status" && s.loaded) {
      const signature = `${s.objectId}:${s.shown}:${s.excluded}:${JSON.stringify(s.statusCounts || [])}`;
      if (signature !== reportSignature) { reportSignature = signature; mini.refresh(); }
    }
  }

  // Ключ выбора: у ЖБИ — id элемента, у МФР — «вид:id» (элемент или блок модели)
  function selKey(s) {
    if (!s) return null;
    if (mfr) return s.mfr?.selected ? `${s.mfr.selected.kind}:${s.mfr.selected.id}` : null;
    return s.selectedId ?? null;
  }
  function detailUrl(id) {
    if (!mfr) return `/elements/${id}`;
    const [kind, n] = String(id).split(":");
    const obj = sc?.objectId ?? curObject;
    return kind === "element" ? `/revit-plan/element?object_id=${obj}&element_id=${n}` : `/objects/${obj}/blocks/${n}/card`;
  }
  async function loadDetail(id) {
    detail.id = id; detail.data = null; detail.error = "";
    const seq = ++detail.seq;
    if (id === null) return;
    try {
      const d = await api.get(detailUrl(id));
      if (dead || seq !== detail.seq || detail.id !== id) return; // запоздавший ответ прежнего выбора не подменяет текущий
      detail.data = d;
    } catch (e) {
      if (dead || seq !== detail.seq) return;
      detail.error = e instanceof ApiError ? String(e.detail) : "Не удалось загрузить карточку";
    }
    paintPanel();
  }

  // ------------------------------------------------------------ отрисовка
  function paintAll() { if (dead) return; paintTop(); paintOverlay(); paintPanel(); paintStatus(); paintStrip(); }

  // Показатели прораба: статусы показанных элементов и доля смонтированных/принятых (по тому же составу, что на схеме).
  let stripRetry = null;
  function paintStrip() {
    const strip = $("#ws-strip");
    if (!strip) return;
    if (!sc || !sc.loaded) { strip.textContent = ""; return; }
    const counts = new Map(sc.statusCounts || []);
    const order = sc.statusOrder?.length ? sc.statusOrder : Array.from(counts.keys());
    const shown = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    if (shown !== sc.shown) {                 // снимок собран между этапами загрузки: не выдаём неверный ноль, просим свежий снимок
      strip.textContent = "Считаем показатели…";
      if (!stripRetry) { stripRetry = setTimeout(() => { stripRetry = null; send("getFilters"); }, 400); }
      return;
    }
    const done = (counts.get("installed") || 0) + (counts.get("accepted") || 0);
    strip.innerHTML = `<span class="ws-kpi"><b>${shown}</b> элементов${sc.excluded ? ` из ${sc.total}` : ""}</span>`
      + `<span class="ws-kpi" title="Доля смонтированных и принятых среди показанных"><b>${shown ? Math.round((done / shown) * 100) : 0}%</b> смонтировано и принято</span>`
      + order.filter((k) => counts.get(k)).map((k) => `<span class="ws-chip"><i class="ws-sw" style="background:${esc(sw(k))}"></i>${esc(stLabel(k))}: <b>${counts.get(k)}</b></span>`).join("");
  }

  function paintTop() {
    const crumb = $("#ws-crumb");
    let name = sc?.objectName ? `${sc.projectName ? sc.projectName + " · " : ""}${sc.objectName}` : "";
    if (mfr && sc?.mfr?.hasData) {
      const on = (arr) => (arr || []).filter((x) => x.on).map((x) => x.label);
      const lv = on(sc.mfr.levels), sec = on(sc.mfr.sections);
      name += ` · ${lv.length ? "этаж: " + (lv.length > 3 ? `${lv.length} выбрано` : lv.join(", ")) : "все этажи (блоки разных этажей накладываются)"} · ${sec.length ? "секции: " + sec.join(", ") : "все секции"}`;
    }
    crumb.textContent = name;
    crumb.title = name;
    for (const b of el.querySelectorAll("#ws-modes button")) b.setAttribute("aria-pressed", String(sc?.view === b.dataset.view));
  }

  function paintOverlay() {
    const o = $("#ws-overlay");
    let html = "";
    if (sc?.error) {
      html = `<div class="ws-msg ws-msg-bad" role="alert"><strong>Схему не удалось показать.</strong><p>${esc(sc.error)}</p><button type="button" class="v2-btn v2-primary" data-act="retry">Повторить</button></div>`;
    } else if (sc && sc.loaded && !sc.loading && sc.hasDrawing === false) {
      html = mfr
        ? `<div class="ws-msg"><strong>У объекта нет загруженной модели.</strong><p>Загрузите выгрузку Revit в разделе «Обмен данными» текущего интерфейса.</p></div>`
        : `<div class="ws-msg"><strong>У объекта нет загруженного чертежа.</strong><p>Схему показать нечем: загрузите чертёж в разделе «Обмен данными» текущего интерфейса.</p></div>`;
    } else if (sc && sc.loaded && !sc.loading && sc.total === 0 && !(mfr && sc.mfr?.blocks)) {
      html = mfr
        ? `<div class="ws-msg"><strong>По выбранному отбору элементов нет.</strong><p>${sc.mfr?.filtersActive ? "Снимите часть фильтров на вкладке «Фильтры»." : "Модель загружена, но элементов в ней нет."}</p>${sc.mfr?.filtersActive ? `<button type="button" class="v2-btn v2-primary" data-act="reset-filters">Сбросить отбор</button>` : ""}</div>`
        : `<div class="ws-msg"><strong>В схеме нет элементов.</strong><p>У выбранного объекта чертёж загружен, но элементов в нём нет.</p></div>`;
    } else if (!sc || sc.loading || !sc.loaded) {
      html = `<div class="ws-msg ws-msg-load"><span class="ws-spin" aria-hidden="true"></span> Загрузка схемы…</div>`;
    }
    o.innerHTML = html;
    o.hidden = !html;
    o.querySelector('[data-act="retry"]')?.addEventListener("click", () => startFrame());
    o.querySelector('[data-act="reset-filters"]')?.addEventListener("click", () => send("resetFilters"));
  }

  const sw = (status) => sc?.statusColors?.[status] || "#999";
  const stLabel = (status) => sc?.statusLabels?.[status] || status || "—";

  function paintPanel() {
    if (dead) return;
    for (const b of el.querySelectorAll(".ws-tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    const body = $("#ws-panel-body");
    const keepScroll = body.scrollTop;
    const restoreFocus = ops.captureFocus(body);     // фокус и курсор переживают перерисовку (снимки сцены приходят часто)
    if (!tabs.some(([k]) => k === tab)) tab = "props";
    body.innerHTML = tab === "props" ? (mfr ? mfrPropsHtml() : propsHtml()) : tab === "status" ? statusHtml() : tab === "filters" ? (mfr ? mfrFiltersHtml() : filtersHtml())
      : tab === "alloc" ? allocHtml() : tab === "pick" ? pickHtml() : tab === "metrics" ? metricsHtml() : tab === "contracts" ? contractsHtml() : viewHtml();
    body.scrollTop = keepScroll;
    bindPanel(body);
    restoreFocus();
    const left = $("#ws-left-body");
    if (left) { const ks = left.scrollTop; left.innerHTML = filtersHtml(); left.scrollTop = ks; bindPanel(left); }
  }

  function row(k, v) { return v === null || v === undefined || v === "" ? "" : `<div class="ws-kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`; }

  function propsHtml() { return ops.bannerHtml() + propsInner(); }
  function propsInner() {
    if (!sc || !sc.loaded) return `<p class="v2-muted ws-pad">Схема загружается…</p>`;
    if (sc.multi && sc.multi.count > 1) return ops.groupHtml();   // групповое выделение: сводка и групповые операции
    const e = sc.selected;
    if (!e) {
      return `<div class="ws-pad ws-empty"><h3 class="ws-h">Ничего не выбрано</h3>
        <p class="v2-muted">Нажмите на элемент схемы, чтобы увидеть его свойства. Shift + перетаскивание — выбор рамкой.</p>
        <dl class="ws-dl">${row("Показано на схеме", `${sc.shown} из ${sc.total}`)}${row("Активных фильтров", sc.excluded ? String(sc.excluded) : "нет")}</dl></div>`;
    }
    return ops.cardHtml(e, { detail: detail.id === e.id ? detail.data : null, detailError: detail.id === e.id ? detail.error : "" });
  }

  function statusHtml() {
    if (!sc || !sc.loaded) return `<p class="v2-muted ws-pad">Схема загружается…</p>`;
    return mini.html();
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



  // ---- комплектовщик: распределение изделий одной позиции на контракт (поставщик → контракт → марка → изделия → подтверждение)
  // Числа контракта — с сервера (`GET /contracts`: план, факт, повреждено, остаток по позициям). Запись — ОДНА серверная операция на всю пачку:
  // `POST /contracts/{id}/allocations` (под блокировкой записи сервер проверяет права, остаток и то, что изделия всё ещё без контракта и в том же статусе;
  // «Запланирован» → «Контрактация», остальные статусы сохраняются; всё или ничего). Пачка не сужается молча: неподходящее выделение не отправляется.
  const nrm = (x) => String(x ?? "").trim().toLowerCase();
  const lineKey = (l) => `${l.element_type}|${l.mark ?? ""}`;
  const sameLine = (i, l) => nrm(i.element_type) === nrm(l.element_type) && nrm(i.mark) === nrm(l.mark);
  const allocProbe = () => checkWrite("POST", "/contracts/1/allocations", { object_id: 1, element_type: "x", mark: null, items: [{ element_id: 1, expected_status: "planned" }] });
  function allocEnabled() { return !!canStatus && allocProbe().allowed; }
  function objectContractIds() { return new Set((pk?.contracts || []).flatMap((g) => g.rows.map((r) => r.id))); }
  const contractIdsKey = () => Array.from(objectContractIds()).sort((a, b) => a - b).join(",");
  async function loadAlloc() {
    if (al.loading) return;
    al.loading = true; al.loadError = ""; paintPanel();
    const obj = curObject;
    try {
      const list = await api.get("/contracts");
      if (dead || obj !== curObject) return;
      const ids = objectContractIds();
      al.contracts = list.filter((c) => ids.has(c.id) && !c.is_archived);
      al.idsKey = contractIdsKey();
      al.loaded = true;
    } catch (e) {
      if (dead || obj !== curObject) return;
      al.loadError = e instanceof ApiError ? e.detail : "Не удалось загрузить контракты";
    } finally {
      al.loading = false;
      if (al.loaded && contractIdsKey() !== al.idsKey) al.loaded = false;   // состав контрактов сцены изменился, пока шла загрузка
      if (!dead) paintPanel();
    }
  }
  const suppliers = () => Array.from(new Set(al.contracts.map((c) => c.counterparty_short_name))).sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
  const cLabel = (c) => [c.agreement_number, c.specification_number, c.theme].filter(Boolean).join(" · ") || c.name;
  const curContract = () => al.contracts.find((c) => c.id === al.contractId) || null;
  const curLine = () => curContract()?.lines.find((l) => lineKey(l) === al.lineKey) || null;
  // Выделение на схеме → что можно распределить: изделия ЭТОЙ позиции без контракта (любой статус). Остальное — причины, из-за которых пачка не уйдёт.
  function allocPlan() {
    const line = curLine();
    const sel = sc?.multiItems || [];
    const ok = [], bad = new Map();
    const why = (t) => bad.set(t, (bad.get(t) || 0) + 1);
    for (const i of sel) {
      if (!line || !sameLine(i, line)) why("другой позиции (тип или марка)");
      else if (i.contract_id != null) why("уже с контрактом");
      else ok.push(i);
    }
    const planned = ok.filter((i) => i.current_status === "planned").length;
    return { line, ok, bad: Array.from(bad), badN: sel.length - ok.length, total: sel.length, planned, kept: ok.length - planned,
      over: line ? ok.length > Math.max(line.remaining, 0) : false };
  }
  function candList() {
    const line = curLine();
    if (!line || !al.cand || nrm(al.cand.elementType) !== nrm(line.element_type) || nrm(al.cand.mark) !== nrm(line.mark)) return null;
    const free = al.cand.items.filter(([, , c]) => c == null).sort((a, b) => (a[1] === "planned" ? 0 : 1) - (b[1] === "planned" ? 0 : 1) || a[0] - b[0]);
    const planned = free.filter(([, st]) => st === "planned").length;
    return { free, planned, kept: free.length - planned, linked: al.cand.items.length - free.length };
  }
  const v1Link = () => `/?ui=v1&object_id=${encodeURIComponent(sc?.objectId ?? curObject)}&ws=picker`;
  const REASONS = { contract_assigned: "уже получили контракт (его назначил другой пользователь)", status_changed: "изменили статус", other_position: "относятся к другой позиции",
    other_object: "относятся к другому объекту", not_current: "не входят в актуальный чертёж", partly_applied: "уже частично распределены на этот контракт", duplicate: "повторяются в пачке", not_found: "не найдены" };
  function conflictText(err) {
    const d = err.rawDetail;
    if (!d || typeof d !== "object" || !Array.isArray(d.conflicts)) return err.detail;
    const by = new Map();
    for (const c of d.conflicts) by.set(c.reason, (by.get(c.reason) || 0) + 1);
    return `${d.message} Изделий: ${Array.from(by, ([r, n]) => `${n} ${REASONS[r] || r}`).join("; ")}.`;
  }
  function allocHtml() {
    if (!pk) return pkLoading();
    if (canStatus === null) return `<p class="v2-muted ws-pad">Проверка прав…</p>`;
    if (!canStatus) return `<p class="v2-muted ws-pad">Распределение недоступно: нет права изменять статусы изделий на этом объекте.</p>`;
    if (!al.loaded) {
      if (!al.loading && !al.loadError) queueMicrotask(loadAlloc);
      return al.loadError ? `<div class="ws-pad"><p class="ws-err" role="alert">${esc(al.loadError)}</p><button type="button" class="v2-btn" data-al="reload">Повторить</button></div>` : `<p class="v2-muted ws-pad">Загрузка контрактов…</p>`;
    }
    const sup = suppliers();
    if (!sup.length) return `<p class="v2-muted ws-pad">У объекта нет действующих контрактов, на которые можно распределять.</p>`;
    const c = curContract(), plan = allocPlan(), cand = candList();
    if (plan.line && !cand && sc?.loaded && !al.candAsked) { al.candAsked = true; queueMicrotask(() => send("pickerCandidates", { elementType: plan.line.element_type, mark: plan.line.mark ?? null })); }
    const en = allocEnabled();
    const step = (n, t, body) => `<section class="ws-al-step"><h4><span class="ws-al-n">${n}</span> ${t}</h4>${body}</section>`;
    const cols = `<div class="ws-pkcols ws-pkcols-c"><span></span><em>всего, шт.</em><em>распред.</em><em>доступно</em></div>`;
    const contractsOf = al.contracts.filter((x) => x.counterparty_short_name === al.supplier);
    let html = `<div class="ws-pad">`;
    html += step(1, "Поставщик", `<select data-al="supplier" aria-label="Поставщик" ${al.busy ? "disabled" : ""}><option value="">— выберите —</option>${sup.map((n) => `<option value="${esc(n)}" ${al.supplier === n ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`);
    if (al.supplier) {
      html += step(2, "Договор · спецификация · контракт", cols + contractsOf.map((x) => {
        const tot = x.lines.reduce((a, l) => a + (l.quantity || 0), 0), fact = x.lines.reduce((a, l) => a + (l.fact || 0), 0), rem = x.lines.reduce((a, l) => a + Math.max(l.remaining || 0, 0), 0);
        return `<button type="button" class="ws-crow ws-cnest${x.id === al.contractId ? " on" : ""}" data-al-c="${x.id}" aria-pressed="${x.id === al.contractId}" title="${esc(x.name)}" ${al.busy ? "disabled" : ""}><span>${esc(cLabel(x))}</span><em title="Всего по контракту, шт.">${nf(tot)}</em><em title="Уже распределено, шт.">${nf(fact)}</em><em title="Доступно к распределению, шт.">${nf(rem)}</em></button>`;
      }).join(""));
    }
    if (c) {
      html += step(3, "Марка (позиция контракта)", c.lines.length ? cols + c.lines.map((l) => {
        const k = lineKey(l), on = k === al.lineKey, rem = Math.max(l.remaining || 0, 0);
        return `<button type="button" class="ws-crow ws-cnest${on ? " on" : ""}${rem ? "" : " ws-dim"}" data-al-l="${esc(k)}" aria-pressed="${on}" ${al.busy ? "disabled" : ""}><span>${esc(l.element_type)} · ${esc(l.mark || "без марки")}</span><em>${nf(l.quantity)}</em><em>${nf(l.fact)}${l.damaged ? ` (+${nf(l.damaged)} брак)` : ""}</em><em class="${l.exceeded ? "ws-neg" : rem ? "ws-pos" : ""}">${nf(rem)}</em></button>`;
      }).join("") : `<p class="v2-muted">В контракте нет позиций.</p>`);
    }
    if (plan.line) {
      const rem = Math.max(plan.line.remaining, 0);
      html += step(4, "Изделия на схеме", `<p class="ws-fnote">Изделий этой позиции без контракта: ${cand ? `<b>${nf(cand.free.length)}</b>. Из них «Запланирован» — <b>${nf(cand.planned)}</b> (станут «Контрактация»); в других статусах — <b>${nf(cand.kept)}</b> (статус сохранится, назначится контракт)${cand.linked ? `; уже с контрактом — ${nf(cand.linked)}` : ""}` : "считаем…"}. Доступно по позиции: <b>${nf(rem)}</b> шт.</p>
        <div class="ws-actions"><button type="button" class="v2-btn" data-al="pick" ${!cand || !cand.free.length || !rem || al.busy ? "disabled" : ""}>Выбрать ${cand ? nf(Math.min(rem, cand.free.length)) : ""} на схеме</button><button type="button" class="v2-btn" data-al="clear" ${plan.total && !al.busy ? "" : "disabled"}>Снять выделение</button></div>
        <p class="v2-muted ws-fnote">Или выделите изделия на схеме сами: Shift + перетаскивание (рамкой). Выделено: <b>${nf(plan.total)}</b>; подходят: <b>${nf(plan.ok.length)}</b>.</p>
        ${plan.bad.length ? `<ul class="ws-list ws-al-bad">${plan.bad.map(([t, n]) => `<li><span>Не распределяются: ${esc(t)}</span><b>${nf(n)}</b></li>`).join("")}</ul>
          <p class="ws-err" role="alert">В выделении ${nf(plan.badN)} изд., которые нельзя распределить этой операцией. Пачка не отправляется, пока они выделены: выделение молча не сужается.</p>
          ${plan.ok.length ? `<div class="ws-actions"><button type="button" class="v2-btn" data-al="keep">Оставить только подходящие (${nf(plan.ok.length)})</button></div>` : ""}` : ""}
        ${plan.over ? `<p class="ws-err" role="alert">Подходящих изделий больше доступного остатка (${nf(plan.ok.length)} > ${nf(rem)}). Уменьшите выбор.</p>` : ""}`);
      html += step(5, "Подтверждение", `<dl class="ws-dl">${row("Поставщик", al.supplier)}${row("Контракт", c.name)}${row("Позиция", `${plan.line.element_type}, ${plan.line.mark || "без марки"}`)}${row("Будет распределено", `${nf(plan.ok.length)} шт.`)}${row("Доступно по позиции", `${nf(rem)} → ${nf(rem - plan.ok.length)} шт.`)}${row("Статусы", `«Запланирован» → «Контрактация»: ${nf(plan.planned)} шт.; остальные сохраняются: ${nf(plan.kept)} шт.`)}</dl>
        <p class="v2-muted ws-fnote">Всё или ничего: сервер применяет пачку целиком и проверяет остаток под блокировкой. Если изделия за это время изменились, пачка не применится, придёт перечень расхождений. Историю статусов и прочие поля операция не переписывает.</p>
        <div class="ws-actions"><button type="button" class="v2-btn v2-primary" data-al="submit" ${plan.ok.length && !plan.badN && !plan.over && !al.busy && en ? "" : "disabled"}>${al.busy ? "Сохранение…" : `Распределить ${plan.ok.length ? nf(plan.ok.length) + " шт." : ""}`}</button></div>
        ${en ? "" : `<p class="ws-warnbox" role="status">Распределение в новом интерфейсе отключено: ${esc(allocProbe().message || "операция не разрешена")} Выполните его в текущем интерфейсе — <a href="${esc(v1Link())}">открыть с этим объектом</a>.</p>`}`);
    }
    if (al.error) html += `<p class="ws-err" role="alert">${esc(al.error)}</p>`;
    if (al.warn) html += `<p class="ws-warnbox" role="status">${esc(al.warn)}</p>`;
    if (al.done) html += `<p class="ws-ok" role="status">${esc(al.done)}</p>`;
    return html + `</div>`;
  }

  const elemDelta = (u) => ({ id: u.id, current_status: u.current_status, contract_id: u.contract_id ?? null, counterparty_code: u.counterparty_code ?? null,
    planned_delivery_date: u.planned_delivery_date ?? null, actual_delivery_date: u.actual_delivery_date ?? null, project_delivery_date: u.project_delivery_date ?? null,
    project_smr_start_date: u.project_smr_start_date ?? null });
  async function allocSubmit() {
    const plan = allocPlan(), c = curContract();
    if (al.busy || !c || !plan.line || !plan.ok.length || plan.badN || plan.over || !allocEnabled()) return;
    const rem = Math.max(plan.line.remaining, 0);
    const msg = [`Распределить изделия на контракт?`, ``, `Поставщик: ${al.supplier}`, `Контракт: ${c.name}`, `Позиция: ${plan.line.element_type}, ${plan.line.mark || "без марки"}`,
      `Изделий: ${plan.ok.length} шт.`, `Доступно по позиции: ${rem} → ${rem - plan.ok.length} шт.`,
      `Статусы: «Запланирован» → «Контрактация» — ${plan.planned} шт.; остальные сохраняются — ${plan.kept} шт.`, ``, `Пачка применяется целиком либо не применяется. Другие изделия, поля и контракты не меняются.`].join("\n");
    if (!(await showConfirmDialog(msg, { confirmLabel: "Распределить", multiline: true }))) return;
    if (dead || al.busy) return;
    const ids = plan.ok.map((i) => i.id);
    const body = { object_id: sc?.objectId ?? curObject, element_type: plan.line.element_type, mark: plan.line.mark ?? null,
      items: plan.ok.map((i) => ({ element_id: i.id, expected_status: i.current_status })) };
    al.busy = true; al.error = ""; al.done = ""; al.warn = ""; paintPanel();
    const after = (applied) => {                       // обновление схемы и остатков по ответу/состоянию сервера
      if (applied.length) send("applyElements", { items: applied.map(elemDelta) });
      send("clearSelection");
      al.loaded = false; al.cand = null; al.candAsked = false;
      loadAlloc();
    };
    try {
      const res = await api.post(`/contracts/${c.id}/allocations`, body);
      const applied = res?.applied || [], already = res?.already || [];
      if (res?.already_applied) {
        al.done = `Уже распределено: ${already.length} шт. — сервер подтвердил состояние, повторная запись не выполнялась и остаток второй раз не расходовался.`;
      } else {
        al.done = `Распределено: ${applied.length} шт. на «${c.name}» (по ответу сервера): «Контрактация» — ${plan.planned} шт., статус сохранён — ${plan.kept} шт. Остаток по позиции: ${res?.position?.remaining ?? "—"} шт.`;
        if (applied.length !== ids.length) al.warn = `Сервер подтвердил ${applied.length} из ${ids.length} изделий — проверьте историю.`;
      }
      after([...applied, ...already]);
    } catch (err) {
      if (err instanceof ApiError && !err.blockedByPolicy && (err.status === 0 || err.status >= 500)) {
        // исход неизвестен: повторно НЕ отправляем; сверяем КАЖДОЕ изделие пачки одним чтением (alloc-verify.js) и не выдаём
        // текущее состояние за подтверждённый результат запроса
        try {
          const v = await verifyAllocationBatch(api, body.items, c.id);
          const r = verdictText(v, c.name);
          if (v.kind === "state_matches") { al.warn = r.text; send("reload"); after([]); }
          else if (v.kind === "not_applied") al.error = r.text;                    // выбор и ввод сохранены: решение о повторе — за человеком
          else { al.error = r.text; send("reload"); send("clearSelection"); al.cand = null; al.candAsked = false; al.loaded = false; loadAlloc(); }
        } catch (e2) { al.error = "Ответ не получен, и проверить состояние пачки не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и проверьте остатки контракта."; }
      } else if (err instanceof ApiError && err.status === 409 && err.rawDetail && typeof err.rawDetail === "object") {
        al.error = conflictText(err);                   // расхождения: ничего не применено; схема перечитывается, чтобы показать актуальное
        send("reload"); send("clearSelection"); al.cand = null; al.candAsked = false; al.loaded = false; loadAlloc();
      } else al.error = err instanceof ApiError ? err.detail : "Не удалось распределить";   // выбор и введённое остаются
    } finally { al.busy = false; if (!dead) paintPanel(); }
  }

  // ---- МФР: свойства выбранного блока/элемента модели, отбор по этажам, секциям и категориям
  const SKIP_CARD = new Set(["параметры", "id", "доли по секциям", "геометрия", "статусы_работ"]);
  const cardRows = (d) => Object.entries(d).filter(([k, v]) => !SKIP_CARD.has(k) && v !== null && v !== "" && v !== false && typeof v !== "object")
    .map(([k, v]) => row(k, String(v))).join("");
  function mfrPropsHtml() {
    if (!sc || !sc.loaded || !sc.mfr) return `<p class="v2-muted ws-pad">Модель загружается…</p>`;
    const m = sc.mfr;
    const sel = m.selected;
    if (!sel) {
      return `<div class="ws-pad ws-empty"><h3 class="ws-h">Ничего не выбрано</h3>
        <p class="v2-muted">Нажмите на элемент или блок на плане. Ctrl (⌘) + щелчок добавляет блок к выбору.</p>
        <dl class="ws-dl">${row("Элементов на плане", m.elements)}${row("Блоков", m.blocks || "")}${row("Отбор", m.filtersActive ? "задан" : "не задан")}</dl>${mbp ? mbp.blocksListHtml(m) : ""}</div>`;
    }
    const key = `${sel.kind}:${sel.id}`;
    const d = detail.id === key ? detail.data : null;
    const names = m.selectedBlocks.length > 1 ? (() => { const L = mbp?.labels?.() || {}; return m.selectedBlocks.map((id) => L[id] || `блок ${id}`).join(", "); })() : "";
    const many = m.selectedBlocks.length > 1 ? `<p class="v2-muted">Выбрано блоков: ${m.selectedBlocks.length} — ${esc(names)}. «Состав работ» и «Сроки» применятся ко всем выбранным; ниже — сведения о последнем выбранном.</p>` : "";
    const actions = `<div class="ws-actions"><button type="button" class="v2-btn" data-act="clear-all">Снять выбор</button></div>`;
    if (detail.id === key && detail.error) return `<div class="ws-pad"><h3 class="ws-h">${sel.kind === "block" ? "Блок" : "Элемент"}</h3><p class="v2-muted">${esc(detail.error)}</p>${actions}</div>`;
    if (!d) return `<div class="ws-pad"><h3 class="ws-h">${sel.kind === "block" ? "Блок" : "Элемент"}</h3><p class="v2-muted">Загрузка…</p>${actions}</div>`;
    if (sel.kind === "block") {
      const g = d["геометрия"] || {}, st = d["статусы_работ"] || {};
      const boxes = g.boxes || [];
      const dim = g.ok && boxes.length ? `${Math.round(Math.max(...boxes.map((b) => b.x1)) - Math.min(...boxes.map((b) => b.x0)))}×${Math.round(Math.max(...boxes.map((b) => b.y1)) - Math.min(...boxes.map((b) => b.y0)))}×${Math.round(g.z1 - g.z0)} мм${boxes.length > 1 ? ` (${boxes.length} прямоугольника, общий охват)` : ""}${g.approx_height ? " (высота приблизительно — соседний этаж не даёт точной)" : ""}` : `недоступна: ${g.reason || "не определена"}`;
      return `<div class="ws-pad"><div class="ws-card-head"><div class="ws-mark">${esc([d["секция"], d["этаж"]].filter(Boolean).join(" · ") || "Блок")}</div><div class="ws-type">Блок модели</div></div>${many}${actions}
        <h4>Состав</h4><dl class="ws-dl">${row("Элементов модели", d["элементов"])}${row("Помещений", d["помещений"])}${row("Габарит", dim)}</dl>
        <h4>Виды работ</h4>${st["всего"] ? `<dl class="ws-dl">${row("План", st["план"])}${row("В работе", st["в_работе"])}${row("Выполнено", st["выполнено"])}${row("Всего", st["всего"])}</dl>` : `<p class="v2-muted">Видов работ, адресуемых на блок, не заведено.</p>`}
        ${panelHtml("blockHtml", Number(sel.id), (m.selectedBlocks || []).map(Number))}</div>`;
    }
    const params = Object.entries(d["параметры"] || {});
    const shares = d["доли по секциям"] || [];
    return `<div class="ws-pad"><div class="ws-card-head"><div class="ws-mark">${esc(d["имя"] || d["название"] || d["категория"] || "Элемент модели")}</div><div class="ws-type">Элемент модели Revit</div></div>${actions}
      <h4>Свойства</h4><dl class="ws-dl">${cardRows(d)}</dl>
      ${shares.length ? `<h4>Доли по секциям</h4><dl class="ws-dl">${shares.map((x) => row(x["код"], x["доля"] != null ? `${x["доля"]}%` : "—")).join("")}</dl>` : ""}
      ${params.length ? `<h4>Параметры Revit</h4><dl class="ws-dl">${params.map(([k, v]) => row(k, String(v))).join("")}</dl>` : ""}</div>`;
  }

  function pills(items, kind) {
    return `<div class="ws-pills">${items.map((it) => `<button type="button" class="ws-pill" data-mpick="${kind}" data-id="${esc(it.id)}" aria-pressed="${it.on}" title="${esc(it.title || it.label)}">${esc(it.label)}${it.warn ? " ⚠" : ""} <em>${it.count}</em></button>`).join("")}</div>`;
  }
  function mfrFiltersHtml() {
    if (!sc || !sc.loaded || !sc.mfr) return `<p class="v2-muted ws-pad">Модель загружается…</p>`;
    const m = sc.mfr;
    const head = `<div class="ws-fhead"><span>Элементов: ${m.elements}</span><button type="button" class="v2-btn" data-act="reset-filters" ${m.filtersActive || mbp?.anyActive?.() ? "" : "disabled"}>Сбросить все</button></div>`;
    const sec = (id, title, body, note) => `<section class="ws-fgroup"><button type="button" class="ws-fh" data-group="${id}" aria-expanded="${!closedGroups.has(id)}"><span>${closedGroups.has(id) ? "▸" : "▾"} ${esc(title)}</span></button>${closedGroups.has(id) ? "" : `<div class="ws-fbody">${note ? `<p class="v2-muted ws-fnote">${esc(note)}</p>` : ""}${body}</div>`}</section>`;
    return head
      + sec("levels", "Этаж", m.levels.length ? pills(m.levels, "level") : `<p class="v2-muted">Нет данных</p>`, "Ничего не выбрано — показаны все этажи.")
      + sec("sections", "Секция", m.sections.length ? pills(m.sections, "section") : `<p class="v2-muted">Нет данных</p>`, "Ничего не выбрано — показаны все секции.")
      + sec("categories", "Категории элементов", m.categories.length
        // цвет категории на плане — легенда V1 (revit-plan-legend); при выключенном слое «Элементы» категории недоступны (как V1)
        ? (m.categories.some((c) => c.disabled) ? `<p class="v2-muted ws-fnote">Слой «Элементы» выключен (вкладка «Вид») — отбор категорий не действует.</p>` : "")
          + m.categories.map((c) => `<label class="ws-check${c.disabled ? " ws-dim" : ""}"><input type="checkbox" data-mcat="${esc(c.category)}" ${c.on ? "checked" : ""} ${c.disabled ? "disabled" : ""}> <span>${c.color ? `<i class="ws-sw" style="background:${esc(c.color)}"></i>` : ""}${esc(c.label)}</span><em>${c.count}</em></label>`).join("")
          + `<p class="v2-muted ws-fnote">Пунктиром на плане — габаритный контур.</p>`
        : `<p class="v2-muted">Нет данных</p>`)
      + (mbp ? mbp.filtersHtml() : "");
  }
  const closedGroups = new Set();

  // ---- комплектовщик: срезы отбора со счётчиками (модель / контракт / Δ), плитки показателей, контракты с остатками
  const nf = (n) => Number(n).toLocaleString("ru-RU");
  const pkLoading = () => `<p class="v2-muted ws-pad">${sc?.error ? "Схема не загружена" : "Загрузка…"}</p>`;
  // Панели «Отбор» и «Контракты» (срезы «модель / контракт / Δ», остатки, разворот по маркам) — picker-panels.js; здесь только связка с состоянием
  const panels = createPickerPanels({ esc, nf, send, sw, loadingHtml: pkLoading, getPk: () => pk,
    ui: { openGroups, closedGroups, groupSearch, repaint: () => paintPanel(), onlyRemainder: () => onlyRemainder, total: () => sc?.total ?? 0 } });
  function pickHtml() { return panels.pickHtml(); }
  function metricsHtml() {
    if (!pk) return pkLoading();
    return `<div class="ws-pad"><p class="v2-muted">Числа считаются по элементам выбранного среза. Плитку можно нажать — на схеме и в срезах останутся только подходящие элементы.</p>
      <div class="ws-tiles">${pk.metrics.map((m) => {
        const color = m.status ? sw(m.status) : null;
        const val = m.value === null ? "—" : nf(m.value);
        const sub = m.key === "contracted" && m.value !== null ? `модель: ${nf(m.base)} · ${m.value >= m.base ? "покрыто" : "дефицит " + nf(m.base - m.value)}` : m.share !== null && m.share !== undefined ? `${m.share}% среза` : "";
        const tag = m.clickable ? "button" : "div";
        const tip = `${m.reason || m.hint || ""}${m.skippedNoMark ? `. Не учтено позиций без марки: ${m.skippedNoMark}` : ""}`;   // как подсказка плитки V1
        return `<${tag} ${m.clickable ? `type="button" data-pkm="${esc(m.key)}" aria-pressed="${m.on}"` : ""} class="ws-tile${m.on ? " on" : ""}" title="${esc(tip)}" ${color ? `style="border-left-color:${esc(color)}"` : ""}><span class="ws-tile-t">${esc(m.title)}</span><b class="ws-tile-v">${esc(val)}</b><span class="ws-tile-s">${esc(m.value === null ? (m.reason || "") : sub)}</span></${tag}>`;
      }).join("")}</div></div>`;
  }
  function contractsHtml() { return panels.contractsHtml(); }

  function viewHtml() {
    const zones = sc?.zones || [];
    return `<div class="ws-pad"><h3 class="ws-h">Режим схемы</h3>
      <div class="ws-seg ws-seg-wide" role="group" aria-label="Режим схемы">${views.map(([k, t]) => `<button type="button" data-view="${k}" aria-pressed="${sc?.view === k}">${t}</button>`).join("")}</div>
      <p class="v2-muted">${mfr ? "2D — план по этажам; 3D — модель здания." : "2D — плоская схема; 3D — модель; 3D лёгкий — упрощённая модель для слабых компьютеров."}</p>
      ${mbp ? mbp.viewHtml() : ""}
      ${mfr && sc?.mfr?.layers?.length ? `<h4>Слои</h4>${sc.mfr.layers.map((l) => `<label class="ws-check"><input type="checkbox" data-mlayer="${esc(l.key)}" ${l.on ? "checked" : ""} ${l.disabled ? "disabled" : ""}> <span>${esc(l.label)}</span></label>`).join("")}` : ""}
      ${zones.length ? `<h4>Зоны на схеме</h4>${zones.map((z) => `<label class="ws-check"><input type="checkbox" data-zone="${esc(z.category)}" ${z.on ? "checked" : ""}> <span>${esc(z.category === "Кран" ? "Краны" : "Захватки")}</span></label>`).join("")}` : ""}
      ${!mfr && sc?.labels?.length ? `<h4>Подписи</h4>${sc.labels.map((l) => `<label class="ws-check"><input type="checkbox" data-label-type="${esc(l.type)}" ${l.on ? "checked" : ""}> <span>${esc(l.type)}</span></label>${l.dates === null ? "" : `<label class="ws-check ws-check-sub"><input type="checkbox" data-label-dates="${esc(l.type)}" ${l.dates ? "checked" : ""} ${l.on ? "" : "disabled"}> <span>Даты</span></label>`}`).join("")}<p class="v2-muted">Как в V1: действует до перезагрузки схемы; с чего начинать — «Видимость подписей» в настройках.</p>` : ""}
      ${!mfr && sc?.external ? `<h4>Внешние 3D-модели (в 3D)</h4>${[["models", "Благоустройство"], ["facades", "Фасады из FBX"]].map(([k, t]) => `<label class="ws-check"><input type="checkbox" data-ext="${k}" ${sc.external[k] ? "checked" : ""}> <span>${t}</span></label>`).join("")}<p class="v2-muted">Если модели объекта загружены. Действует до перезагрузки схемы, как в V1.</p>` : ""}
      <h4>Масштаб</h4><div class="ws-actions"><button type="button" class="v2-btn" data-tool="fit">Вписать в экран</button></div></div>`;
  }

  function bindPanel(body) {
    if (tab === "status") mini?.bind(body);
    body.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.act;
      if (a === "clear-all") send("clearSelection");
      else if (a === "locate" && sc?.selected) send("locate", { id: sc.selected.id });
      else if (a === "reset-filters") { if (mfr) mbp?.resetAll?.(); send("resetFilters"); }
    }));
    body.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => tool(b.dataset.tool)));
    body.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => send("setView", { mode: b.dataset.view })));
    body.querySelectorAll("input[data-pk]").forEach((c) => c.addEventListener("change", () => { let v; try { v = JSON.parse(c.dataset.v); } catch (e) { return; } send("pickerToggle", { key: c.dataset.pk, value: v }); }));
    body.querySelectorAll("[data-pkgroup]").forEach((b) => b.addEventListener("click", () => { const g = b.dataset.pkgroup; if (openGroups.has(g)) { openGroups.delete(g); closedGroups.add(g); } else { openGroups.add(g); closedGroups.delete(g); } paintPanel(); }));
    body.querySelectorAll("[data-pk-clear]").forEach((b) => b.addEventListener("click", () => send("pickerClear", { key: b.dataset.pkClear || null })));
    body.querySelectorAll("[data-pkm]").forEach((b) => b.addEventListener("click", () => send("pickerMetric", { key: b.dataset.pkm, on: b.getAttribute("aria-pressed") !== "true" })));
    body.querySelectorAll("[data-pkc]").forEach((b) => b.addEventListener("click", () => send("pickerToggle", { key: "contract", value: Number(b.dataset.pkc) })));
    body.querySelectorAll("[data-pkgrp]").forEach((b) => b.addEventListener("click", () => send("pickerSet", { key: "contract", values: b.dataset.pkgrp.split(",").map(Number), on: b.dataset.on === "1" })));
    body.querySelectorAll("[data-pkn]").forEach((b) => b.addEventListener("click", () => send("pickerToggle", { key: "contract", value: pk?.noneValue ?? "__none__" })));
    body.querySelectorAll("[data-pkhl]").forEach((b) => b.addEventListener("click", () => send("pickerHighlight", { on: b.getAttribute("aria-pressed") !== "true" })));
    body.querySelectorAll("[data-pkrem]").forEach((b) => b.addEventListener("click", () => { onlyRemainder = !onlyRemainder; paintPanel(); }));
    panels.bind(body);
    ops.bind(body);
    mbp?.bind(body, { selectedBlocks: () => (sc?.mfr?.selectedBlocks || []).map(Number) });
    body.querySelectorAll("[data-al]").forEach((b) => b.addEventListener(b.tagName === "SELECT" ? "change" : "click", () => {
      const a = b.dataset.al;
      if (a === "supplier") { al.supplier = b.value; al.contractId = null; al.lineKey = null; al.cand = null; al.candAsked = false; al.error = ""; al.done = ""; paintPanel(); }
      else if (a === "reload") { al.loadError = ""; loadAlloc(); }
      else if (a === "clear") send("clearSelection");
      else if (a === "keep") send("pickerSelectIds", { ids: allocPlan().ok.map((i) => i.id) });
      else if (a === "pick") { const cand = candList(), line = curLine(); if (cand && line) send("pickerSelectIds", { ids: cand.free.slice(0, Math.max(line.remaining, 0)).map(([id]) => id) }); }
      else if (a === "submit") allocSubmit();
    }));
    body.querySelectorAll("[data-al-c]").forEach((b) => b.addEventListener("click", () => { al.contractId = Number(b.dataset.alC); al.lineKey = null; al.cand = null; al.candAsked = false; al.error = ""; al.done = ""; paintPanel(); }));
    body.querySelectorAll("[data-al-l]").forEach((b) => b.addEventListener("click", () => {
      al.lineKey = b.dataset.alL; al.error = ""; al.done = ""; al.cand = null; al.candAsked = true;
      const l = curLine(); if (l) send("pickerCandidates", { elementType: l.element_type, mark: l.mark ?? null });
      paintPanel();
    }));
    body.querySelectorAll("[data-mpick]").forEach((b) => b.addEventListener("click", () => send("mfrPick", { kind: b.dataset.mpick, id: b.dataset.id })));
    body.querySelectorAll("[data-mcat]").forEach((c) => c.addEventListener("change", () => send("mfrCategory", { category: c.dataset.mcat, on: c.checked })));
    body.querySelectorAll("[data-mlayer]").forEach((c) => c.addEventListener("change", () => send("mfrLayer", { layer: c.dataset.mlayer, on: c.checked })));
    body.querySelectorAll("[data-zone]").forEach((c) => c.addEventListener("change", () => send("setZoneVisible", { category: c.dataset.zone, on: c.checked })));
    body.querySelectorAll("[data-ext]").forEach((c) => c.addEventListener("change", () => send("setExternalVisible", { kind: c.dataset.ext, on: c.checked })));
    body.querySelectorAll("[data-label-type]").forEach((c) => c.addEventListener("change", () => send("setLabelVisible", { type: c.dataset.labelType, part: "label", on: c.checked })));
    body.querySelectorAll("[data-label-dates]").forEach((c) => c.addEventListener("change", () => send("setLabelVisible", { type: c.dataset.labelDates, part: "dates", on: c.checked })));
    body.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
      const g = b.dataset.group;
      if (mfr) closedGroups.has(g) ? closedGroups.delete(g) : closedGroups.add(g);
      else openGroups.has(g) ? openGroups.delete(g) : openGroups.add(g);
      paintPanel();
    }));
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

  // Что человеку реально доступно на этом рабочем месте (а не постоянное «только просмотр»)
  function capabilities() {
    const c = [];
    if (!mfr && canStatus) c.push("смена статуса");
    if (!mfr && ops.rights.plannedDate) c.push("плановая дата");
    if (!mfr && ops.rights.comment) c.push("комментарии");
    if (picker && allocEnabled()) c.push("распределение по контрактам");
    if (mfr && mbp?.canWrite()) c.push("факт, состав работ, сроки блока");
    return c;
  }
  function capsChip() {
    const c = capabilities();
    return c.length
      ? `<span class="ws-cap-chip" title="Операции, доступные вам на этом рабочем месте; остальное — в текущем интерфейсе">можно: ${esc(c.join(", "))}</span>`
      : `<span class="ws-ro-chip" title="Изменения выполняются в текущем интерфейсе">только просмотр</span>`;
  }

  // МФР: шахматка, динамика и отбор работ блока — в строке состояния (их ведёт mfr-block-panel.js)
  function mfrStatusExtra() {
    const x = mbp?.summary(); if (!x) return "";
    return (x.chess ? `<span>Шахматка: ${esc(x.chess)}, ${x.mode === "deadline" ? "по срокам" : "по выполнению"}</span>` : "")
      + (x.dyn ? `<span>Динамика факта: ${esc(x.dyn.from || "с начала")} — ${esc(x.dyn.to || "по сегодня")}</span>` : "") + (x.filter ? `<span>Отбор работ задан</span>` : "");
  }
  function paintStatus() {
    const s = $("#ws-status");
    if (!sc || !sc.loaded) { s.textContent = sc?.error ? "Схема не загружена" : "Загрузка схемы…"; return; }
    if (mfr) {
      if (!sc.mfr) { s.textContent = "Загрузка модели…"; return; }
      const m = sc.mfr;
      const n = m.selectedBlocks?.length || 0;
      const selT = n > 1 ? `Выбрано блоков: ${n}` : m.selected ? (m.selected.kind === "block" ? "Выбран блок" : "Выбран элемент") : "Ничего не выбрано";
      s.innerHTML = `<span>Элементов <b>${m.elements}</b>${m.blocks ? `, блоков <b>${m.blocks}</b>` : ""}${m.truncated ? ` <b class="ws-warn">— список обрезан, сузьте отбор</b>` : ""}</span><span>${esc(selT)}</span><span>${m.filtersActive ? "Отбор задан" : "Отбор не задан"}</span><span>Режим: ${esc((views.find((v) => v[0] === sc.view) || [])[1] || "")}</span>${m.status && !/^Показано \d+ элементов$/.test(m.status) ? `<span class="ws-notice" title="${esc(m.status)}">${esc(m.status)}</span>` : ""}${mfrStatusExtra()}${capsChip()}${notice ? `<span class="ws-notice" title="${esc(notice)}">${esc(notice)}</span>` : ""}`;
      return;
    }
    const sel = sc.multi?.count > 1 ? `Выбрано: ${sc.multi.count}` : sc.selected ? `Выбран: ${sc.selected.mark || sc.selected.element_type}` : "Ничего не выбрано";
    s.innerHTML = `<span>Показано <b>${sc.shown}</b> из <b>${sc.total}</b></span><span>${esc(sel)}</span><span>${sc.excluded ? (picker ? `Отбор задан: выбрано ${sc.excluded}` : `Фильтры активны: снято ${sc.excluded}`) : (picker ? "Отбор не задан" : "Фильтры не заданы")}</span><span>Режим: ${esc((views.find((v) => v[0] === sc.view) || [])[1] || "")}</span>${capsChip()}${notice ? `<span class="ws-notice" title="${esc(notice)}">${esc(notice)}</span>` : ""}`;
  }

  // ---- поиск по марке/адресу (среди показанных на схеме элементов)
  const qInput = $("#ws-q"), found = $("#ws-found");
  let qTimer = null;
  function paintFound(m) {
    if (!m.text.trim()) { found.hidden = true; found.innerHTML = ""; return; }
    found.hidden = false;
    found.innerHTML = m.items.length
      ? m.items.map((it) => `<button type="button" role="option" data-id="${it.id}"><i class="ws-sw" style="background:${esc(sw(it.status))}"></i><b>${esc(it.mark || "—")}</b> <span>${esc(it.type || "")}</span><small>${esc(it.address || "")}</small></button>`).join("")
        + (m.total > m.items.length ? `<div class="ws-found-more">Показаны первые ${m.items.length} из ${m.total}. Уточните запрос.</div>` : "")
      : `<div class="ws-found-more">Ничего не найдено среди показанных на схеме элементов.</div>`;
  }
  if (qInput) {
    qInput.addEventListener("input", () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => send("search", { text: qInput.value }), 250);
      if (!qInput.value.trim()) { found.hidden = true; found.innerHTML = ""; }
    });
    qInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { qInput.value = ""; found.hidden = true; }
      else if (e.key === "Enter") { const b = found.querySelector("button[data-id]"); if (b) { b.click(); e.preventDefault(); } }
    });
    found.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-id]"); if (!b) return;
      const id = Number(b.dataset.id);
      send("select", { id }); send("locate", { id });
      found.hidden = true;
    });
  }
  document.addEventListener("pointerdown", onDocDown, true);
  function onDocDown(e) { if (found && !found.hidden && !e.target.closest(".ws-search")) found.hidden = true; }

  // ------------------------------------------------------------ управление
  $("#ws-modes").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) send("setView", { mode: b.dataset.view }); });
  el.querySelector(".ws-tools").addEventListener("click", (e) => { const b = e.target.closest("[data-tool]"); if (b) tool(b.dataset.tool); });
  el.querySelector(".ws-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; paintPanel(); if (tab === "status" && sc?.loaded) mini?.refresh(); } });

  // Глобальная навигация сворачивается: на узком экране схеме нужна вся ширина, поэтому там по умолчанию свёрнута.
  const shellSide = () => document.getElementById("v2-side");
  const navWasHidden = shellSide()?.hidden === true;
  const navBtn = $("#ws-nav");
  function setNav(hidden, remember = false) {
    const side = shellSide(); if (!side) return;
    side.hidden = hidden; navBtn.setAttribute("aria-pressed", String(!hidden));
    if (remember) writeSess("v2.ws.navHidden", hidden ? "1" : "0");   // запоминается только выбор человека, а не умолчание по ширине
    setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
  }
  navBtn.addEventListener("click", () => { const side = shellSide(); if (side) setNav(!side.hidden, true); });
  setNav((readSess("v2.ws.navHidden") ?? (window.innerWidth < 1500 ? "1" : "0")) === "1");
  $("#ws-panel-toggle").addEventListener("click", () => {
    panelHidden = !panelHidden;
    panel.hidden = panelHidden; $("#ws-resize").hidden = panelHidden;
    $("#ws-panel-toggle").setAttribute("aria-pressed", String(!panelHidden));
    setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
  });

  // ширина правой панели: мышью и стрелками
  function setW(w) { panelW = Math.max(260, Math.min(640, Math.round(w))); panel.style.width = panelW + "px"; writeSess(picker ? "v2.ws.panelW.picker" : "v2.ws.panelW", panelW); }
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

  // Права на смену статусов считаются по объекту (как в V1): не получилось узнать — формы нет, а не открываем лишнее
  async function loadStatusRights() {
    if (mfr) { canStatus = false; return; }
    ops.reset();
    const obj = curObject;
    try {
      const r = await api.get(`/me/permissions?object_id=${obj}`);
      if (dead || obj !== curObject) return;
      canStatus = !!r.system_admin || (r.features?.status === "write" && !(r.not_applicable || []).includes("status"));
      ops.setRights(r);
    } catch (e) { if (dead || obj !== curObject) return; canStatus = false; ops.rightsFailed(); }
    paintPanel(); paintStatus();
  }
  loadStatusRights();

  startFrame();

  return {
    // Введённое в форме смены статуса, но не отправленное — несохранённое; идущий запрос уйти не даёт (шлюз оболочки блокирует переходы)
    hasUnsavedChanges: () => anyModalDirty() || ops.hasUnsaved(),
    guardLeave: async () => {
      if (!(await guardModals())) return false;   // окна МФР (факт, ЗР, состав работ) с несохранённым вводом
      return ops.guardLeave();
    },
    // Смена объекта в шапке V2: тот же кадр получает команду (кадр сам сбрасывает несовместимую выборку и фильтры,
    // запоздавший ответ прежнего объекта не применяется — мост обрабатывает только последнюю команду).
    onObjectChange(id) {
      if (dead || !id || id === curObject) return true;
      curObject = id; ops.reset(); mbp?.reset(); mini?.clear(); reportSignature = ""; canStatus = null; Object.assign(al, { loaded: false, loading: false, loadError: "", contracts: [], supplier: "", contractId: null, lineKey: null, cand: null, candAsked: false, busy: false, error: "", done: "", warn: "" }); loadStatusRights(); detail.id = null; detail.data = null; filters = null; sc = sc ? { ...sc, loaded: false, loading: true, selected: null, multi: null, mfr: sc.mfr ? { ...sc.mfr, selected: null, selectedBlocks: [] } : sc.mfr } : sc;
      paintAll(); send("setObject", { objectId: id });
      return true;
    },
    destroy() {
      dead = true; window.removeEventListener("message", onMessage); document.removeEventListener("pointerdown", onDocDown, true);
      clearTimeout(qTimer); clearTimeout(stripRetry); stopFrame(); queue.length = 0; mbp?.destroy();
      const side = shellSide(); if (side) side.hidden = navWasHidden;
    },
  };
}
