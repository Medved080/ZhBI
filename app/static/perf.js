// Встроенные замеры производительности — сторона браузера (2026-10-23). Серверная часть — app/perf_core.py, API — app/perf.py,
// экран и окно-«бегущая строка» — app/static/perf-panel.js.
//
// Классический скрипт без зависимостей: подключается и в V1 (`/`), и в V2 (`/v2`), и — потому что кадр схемы V2 строится из страницы V1 —
// в кадре. Даёт глобальный объект `window.zhbiPerf`.
//
// Пока администратор замеры НЕ включил, скрипт не делает почти ничего: раз в ~20 секунд спрашивает у сервера `GET /perf/state`
// (только в верхнем окне и только после входа — `zhbiPerf.configure()`), ни наблюдателей, ни перехвата запросов нет. Когда сбор включён:
//   * каждый запрос fetch: ожидание ответа, скачивание, размер, серверное время (из заголовка Server-Timing), статус — через Resource Timing;
//     к запросам добавляется заголовок `x-perf-id`, по нему строка браузера связывается со строкой сервера;
//   * долгие кадры (Long Animation Frames: какие скрипты заняли основной поток) или долгие задачи (запасной вариант);
//   * медленные нажатия и клавиши (Event Timing, от 100 мс): задержка до обработки, обработка, отрисовка;
//   * загрузка страницы, показатели компьютера (ядра, память, экран, сеть), память вкладки раз в 15 секунд;
//   * отрезки, расставленные в коде вручную: `zhbiPerf.start("название")` → вызвать результат по окончании, `zhbiPerf.span("название", fn)`.
// Замеры копятся в памяти и уходят пачкой раз в 5 секунд (`POST /perf/samples`) — отдельный запрос на каждый замер исказил бы то, что мерим.
// Предметных данных (марки, названия, значения полей) в замеры не попадает: операции — маршруты и подписи элементов интерфейса.
//
// Кадр схемы не пишет на сервер (см. app.js, EMBED_SCENE): свои замеры он отдаёт верхнему окну прямым вызовом `parent.zhbiPerf.ingest()`
// — оба документа одного происхождения и оба наши; это односторонняя передача чисел и коротких подписей, команд кадру она не даёт.
(() => {
  "use strict";
  if (window.zhbiPerf) return;

  let top = true;
  let parentPerf = null;
  try { if (window.parent !== window && window.parent.zhbiPerf) { top = false; parentPerf = window.parent.zhbiPerf; } } catch (e) { top = true; }

  const POLL_MS = 20000;
  const FLUSH_MS = 5000;
  const MEM_MS = 15000;
  const LOAF_MIN = 100;
  const EVENT_MIN = 100;
  const MAX_BUF = 3000;
  const OVERLAY_KEY = "zhbi.perf.overlay";
  const STATE_KEY = "zhbi.perf.state";
  let box = null;        // окно «бегущая строка» (создаётся при первой необходимости)
  let boxTimer = null;
  const overlayWanted = () => { try { return localStorage.getItem(OVERLAY_KEY) === "1"; } catch (e) { return false; } };
  const BACKGROUND = /^\S+ \/(changes|app-build|activity|me\/ui-state|admin\/disk-space|admin\/server-status)\b/;

  const S = { run: null, until: 0, canControl: false, buf: [], overlay: [], active: false, pageSent: false };
  const clientId = (() => { try { return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join(""); } catch (e) { return String(Math.random()).slice(2, 14); } })();
  const origin = () => (performance.timeOrigin || (Date.now() - performance.now()));
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  // у документа из srcdoc (кадр схемы V2) `location.origin` равен "null": свой origin он наследует от оболочки и отдаёт его как `window.origin`
  const ORIGIN = window.origin && window.origin !== "null" ? window.origin : location.origin;
  let seq = 0;
  let observers = [];
  let memTimer = null;
  let pending = [];      // запросы, ушедшие с заголовком x-perf-id: [{url, method, id, t0}]
  let currentObject = null;

  const norm = (p) => String(p).replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:id");
  const trim = (s, n) => String(s == null ? "" : s).slice(0, n);

  // ---------------------------------------------------------------- запись замера
  function record(kind, op, ms, details, objectId) {
    if (!S.run) return;
    const row = { kind, op: trim(op, 160), ms: Math.max(0, Math.round(ms * 10) / 10), wall: origin() + performance.now(), details: details || null,
      object_id: Number.isInteger(objectId) ? objectId : (Number.isInteger(currentObject) ? currentObject : null) };
    if (!top) { try { parentPerf.ingest([row]); } catch (e) { /* верхнее окно закрыто */ } return; }
    ingest([row]);
  }

  // Принять готовые строки (своё окно или кадр схемы). Метка времени — стенные часы этой машины: нужна только чтобы вычислить «сколько
  // назад», при отправке сравнивается с теми же часами.
  function ingest(rows) {
    if (!S.run || !Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r.op !== "string" || typeof r.kind !== "string" || !Number.isFinite(r.ms)) continue;
      S.buf.push({ kind: r.kind, op: trim(r.op, 160), ms: r.ms, wall: Number(r.wall) || Date.now(), details: r.details || null,
        object_id: Number.isInteger(r.object_id) ? r.object_id : null });
      if (r.kind !== "memory" && r.kind !== "device") pushOverlay(r);
    }
    if (S.buf.length > MAX_BUF) S.buf.splice(0, S.buf.length - MAX_BUF);
  }

  function start(op, kind, details) {
    const t0 = performance.now();
    return (extra) => { const d = performance.now() - t0; record(kind || "span", op, d, extra ? Object.assign({}, details || {}, extra) : details); return d; };
  }
  function span(op, fn, kind) {
    const end = start(op, kind);
    try { const r = fn(); if (r && typeof r.then === "function") return r.finally(() => end()); end(); return r; } catch (e) { end({ error: 1 }); throw e; }
  }

  // ---------------------------------------------------------------- запросы fetch
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (!S.run) return nativeFetch(input, init);
      try {
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        const url = new URL(isReq ? input.url : String(input), document.baseURI);
        if (url.origin !== ORIGIN || url.pathname.startsWith("/perf/")) return nativeFetch(input, init);
        const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
        const id = `${clientId}.${++seq}`;
        pending.push({ url: url.href, method, id, t0: performance.now() });
        if (pending.length > 400) pending.splice(0, pending.length - 200);
        const headers = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
        headers.set("x-perf-id", id);
        if (isReq && !(init && init.headers)) return nativeFetch(new Request(input, { headers }), init);
        return nativeFetch(input, Object.assign({}, init, { headers }));
      } catch (e) { return nativeFetch(input, init); }
    };
  }

  function onResource(e) {
    if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest") return;
    let path;
    try { path = new URL(e.name).pathname; } catch (x) { return; }
    if (path.startsWith("/perf/")) return;
    let hit = -1;
    for (let i = 0; i < pending.length; i++) { if (pending[i].url === e.name && Math.abs(pending[i].t0 - e.startTime) < 40) { hit = i; break; } }
    const p = hit >= 0 ? pending.splice(hit, 1)[0] : null;
    const st = (e.serverTiming || []).find((x) => x.name === "app");
    const op = `${p ? p.method : "?"} ${norm(path)}`;
    record("fetch", op, e.responseEnd - e.startTime, {
      status: e.responseStatus || null, queue_ms: r1(e.requestStart - e.startTime), wait_ms: r1(e.responseStart - e.requestStart),
      dl_ms: r1(e.responseEnd - e.responseStart), bytes: e.encodedBodySize || 0, raw_bytes: e.decodedBodySize || 0,
      server_ms: st ? r1(st.duration) : null, req: p ? p.id : null,
    });
  }
  const r1 = (v) => Math.round(v * 10) / 10;

  // ---------------------------------------------------------------- долгие кадры, нажатия, страница
  function describe(el) {
    // Элемент, на котором сработало нажатие, к моменту записи замера часто уже убран перерисовкой (нажал кнопку — панель перестроилась):
    // у такой записи цели нет. Честная подпись лучше «?».
    if (!el || el.nodeType !== 1) return "элемент убран при перерисовке";
    for (let i = 0, n = el; n && n.nodeType === 1 && i < 4; i++, n = n.parentElement) {
      const a = n.id || n.getAttribute("data-act") || n.getAttribute("data-tab") || n.getAttribute("data-view") || n.getAttribute("data-key")
        || n.getAttribute("aria-label") || n.getAttribute("title") || n.getAttribute("name");
      if (a) return `${n.tagName.toLowerCase()}[${trim(a, 40)}]`;
    }
    return el && el.tagName ? el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + trim(el.className.split(/\s+/)[0], 24) : "") : "?";
  }
  function observe(type, cb, opts) {
    try {
      if (!(window.PerformanceObserver && PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes(type))) return false;
      const o = new PerformanceObserver((l) => { try { l.getEntries().forEach(cb); } catch (e) { /* замер не должен ломать страницу */ } });
      o.observe(Object.assign({ type, buffered: false }, opts || {}));
      observers.push(o);
      return true;
    } catch (e) { return false; }
  }
  function attach() {
    if (S.active) return;
    S.active = true;
    observe("resource", onResource);
    const loaf = observe("long-animation-frame", (e) => {
      if (e.duration < LOAF_MIN) return;
      const scripts = (e.scripts || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 3).map((s) => ({
        src: trim(String(s.sourceURL || "").replace(/^.*\/static\//, ""), 60), fn: trim(s.sourceFunctionName || s.invoker, 50), ms: r1(s.duration), kind: s.invokerType }));
      record("frame", "Долгий кадр", e.duration, { blocking_ms: r1(e.blockingDuration || 0), render_ms: r1((e.startTime + e.duration) - (e.renderStart || (e.startTime + e.duration))),
        style_ms: r1((e.startTime + e.duration) - (e.styleAndLayoutStart || (e.startTime + e.duration))), scripts });
    });
    if (!loaf) observe("longtask", (e) => record("longtask", "Долгая задача", e.duration, { src: trim((e.attribution && e.attribution[0] && e.attribution[0].containerType) || "", 20) }));
    observe("event", (e) => {
      if (!e.interactionId) return;
      const proc = e.processingEnd - e.processingStart;
      record("event", `${e.name}: ${describe(e.target)}`, e.duration, { delay_ms: r1(e.processingStart - e.startTime), proc_ms: r1(proc), present_ms: r1(e.duration - (e.processingEnd - e.startTime)) });
    }, { durationThreshold: EVENT_MIN });
    if (top) {
      memTimer = setInterval(memorySample, MEM_MS);
      memorySample();
      sendDevice();
      sendPage();
    }
  }
  function detach() {
    S.active = false;
    observers.forEach((o) => { try { o.disconnect(); } catch (e) { /* уже отключён */ } });
    observers = [];
    clearInterval(memTimer);
    memTimer = null;
    pending = [];
  }
  function memorySample() {
    const m = performance.memory;
    if (m) record("memory", "Память вкладки", 0, { heap_mb: Math.round(m.usedJSHeapSize / 1048576), total_mb: Math.round(m.totalJSHeapSize / 1048576), limit_mb: Math.round(m.jsHeapSizeLimit / 1048576) });
  }
  function sendDevice() {
    const c = navigator.connection || {};
    const ua = navigator.userAgentData;
    record("device", "Компьютер", 0, {
      cores: navigator.hardwareConcurrency || null, mem_gb: navigator.deviceMemory || null,
      browser: ua ? trim((ua.brands || []).filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(", "), 80) : trim(navigator.userAgent, 80),
      os: trim(ua ? ua.platform : navigator.platform, 30), screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`,
      window: `${innerWidth}x${innerHeight}`, net: c.effectiveType || null, rtt_ms: c.rtt != null ? c.rtt : null, down_mbps: c.downlink != null ? c.downlink : null,
    });
  }
  function sendPage() {
    if (S.pageSent || performance.now() > 180000) return;
    S.pageSent = true;
    const nav = performance.getEntriesByType("navigation")[0];
    if (!nav) return;
    const res = performance.getEntriesByType("resource");
    const sum = (re) => res.filter((r) => re.test(r.initiatorType)).reduce((a, r) => a + (r.encodedBodySize || 0), 0);
    const fcp = (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime;
    record("page", `Загрузка страницы ${location.pathname}`, nav.loadEventEnd > 0 ? nav.loadEventEnd : nav.domContentLoadedEventEnd, {
      ttfb_ms: r1(nav.responseStart), dom_ms: r1(nav.domContentLoadedEventEnd), fcp_ms: fcp ? r1(fcp) : null,
      scripts_kb: Math.round(sum(/^(script|link)$/) / 1024), nav_kb: Math.round((nav.encodedBodySize || 0) / 1024) });
  }

  // ---------------------------------------------------------------- состояние сбора и отправка
  function setState(st) {
    const wasOn = !!S.run;
    S.run = st && st.on ? st.run_id : null;
    S.until = st && st.until ? st.until : 0;
    S.canControl = !!(st && st.can_control);
    if (top) { try { if (S.run) sessionStorage.setItem(STATE_KEY, JSON.stringify({ run_id: S.run, until: S.until, can_control: S.canControl })); else sessionStorage.removeItem(STATE_KEY); } catch (e) { /* хранилище недоступно */ } }
    if (S.run && !wasOn) attach();
    if (!S.run && wasOn) { detach(); S.buf.length = 0; }
    paintOverlay();
    for (const f of listeners) { try { f(publicState()); } catch (e) { /* слушатель не должен ломать остальных */ } }
  }
  const publicState = () => ({ on: !!S.run, run_id: S.run, until: S.until, can_control: S.canControl });
  const listeners = new Set();

  async function poll() {
    if (!top || !nativeFetch || document.hidden) return;
    try {
      const r = await nativeFetch("/perf/state", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return;
      setState(await r.json());
    } catch (e) { /* сеть моргнула — следующий опрос */ }
  }

  function takeBatch() {
    if (!S.buf.length || !S.run) return null;
    const now = Date.now();
    const rows = S.buf.splice(0, 300);
    return { run_id: S.run, client_id: clientId, samples: rows.map((r) => ({ kind: r.kind, op: r.op, ms: r.ms, ago: Math.max(0, now - r.wall), details: r.details, object_id: r.object_id })) };
  }
  async function flush() {
    if (!top || !nativeFetch) return;
    const body = takeBatch();
    if (!body) return;
    try {
      const r = await nativeFetch("/perf/samples", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      if (r.ok) { const d = await r.json(); if (d && d.on === false) setState({ on: false }); }
    } catch (e) { /* пачка потеряна — замеры не стоят того, чтобы копить при недоступном сервере */ }
  }
  // ---------------------------------------------------------------- окно «бегущая строка» (10 последних операций, только у администратора)
  function pushOverlay(r) {
    if (!top || !S.canControl || !overlayWanted() || BACKGROUND.test(r.op)) return;
    if (r.kind === "fetch" && /^\S+ \/perf\//.test(r.op)) return;
    S.overlay.push({ t: new Date(), op: r.op, ms: r.ms, kind: r.kind, server: r.details && r.details.server_ms });
    if (S.overlay.length > 10) S.overlay.shift();
    if (!boxTimer) boxTimer = setTimeout(() => { boxTimer = null; paintOverlay(); }, 250);
  }
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const color = (ms) => (ms < 100 ? "#7bd88f" : ms < 500 ? "#e7d16a" : ms < 1500 ? "#f0a35a" : "#ff6b6b");
  const KIND_MARK = { fetch: "сеть", frame: "кадр", longtask: "задача", event: "ввод", screen: "экран", scene: "схема", page: "стр.", span: "код" };
  function paintOverlay() {
    const show = top && S.run && S.canControl && overlayWanted() && document.body;
    if (!show) { if (box) { box.remove(); box = null; } return; }
    if (!box) {
      box = document.createElement("div");
      box.id = "zhbi-perf-overlay";
      box.setAttribute("style", "position:fixed;right:10px;bottom:36px;width:440px;max-width:calc(100vw - 20px);z-index:2147483000;background:rgba(14,17,22,.62);"
        + "color:#e9eef5;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;padding:6px 9px 7px;border-radius:9px;pointer-events:none;"
        + "-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);box-shadow:0 2px 10px rgba(0,0,0,.25)");
      document.body.appendChild(box);
    }
    const rows = S.overlay.slice();
    const left = S.until ? Math.max(0, Math.round((S.until * 1000 - Date.now()) / 60000)) : null;
    box.innerHTML = `<div style="display:flex;justify-content:space-between;opacity:.75;margin-bottom:3px"><span>● замеры${left != null ? ` · ещё ${left} мин` : ""}</span>`
      + `<span style="pointer-events:auto;cursor:pointer" data-perf-close title="Скрыть окно">✕</span></div>`
      + rows.map((r) => `<div style="display:flex;gap:6px;white-space:nowrap"><span style="opacity:.55">${pad(r.t.getHours())}:${pad(r.t.getMinutes())}:${pad(r.t.getSeconds())}</span>`
        + `<span style="opacity:.55;width:34px">${esc(KIND_MARK[r.kind] || r.kind)}</span>`
        + `<span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(r.op)}</span>`
        + `<span style="color:${color(r.ms)};text-align:right;min-width:78px">${Math.round(r.ms).toLocaleString("ru-RU")} мс${r.server != null ? `<span style="opacity:.6"> (с ${Math.round(r.server)})</span>` : ""}</span></div>`).join("")
      + (rows.length ? "" : `<div style="opacity:.6">ждём операций…</div>`);
    const x = box.querySelector("[data-perf-close]");
    if (x) x.onclick = () => setOverlay(false);
  }
  function setOverlay(on) {
    try { localStorage.setItem(OVERLAY_KEY, on ? "1" : "0"); } catch (e) { /* хранилище недоступно */ }
    if (!on) S.overlay.length = 0;
    paintOverlay();
    for (const f of listeners) { try { f(publicState()); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------- запуск (после всех объявлений: setState рисует окно)
  if (top) {
    // Перезагрузка страницы посреди сбора: прежнее состояние берётся из sessionStorage сразу, не дожидаясь первого ответа сервера, —
    // иначе запросы первых секунд (самые тяжёлые, при загрузке) остались бы без метода и связи со строкой сервера. Опрос его подтвердит или снимет.
    try {
      const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
      if (saved && saved.run_id && saved.until * 1000 > Date.now()) setState({ on: true, run_id: saved.run_id, until: saved.until, can_control: !!saved.can_control });
    } catch (e) { /* нет сохранённого состояния */ }
    setInterval(flush, FLUSH_MS);
    window.addEventListener("pagehide", () => {
      const body = takeBatch();
      if (body && navigator.sendBeacon) { try { navigator.sendBeacon("/perf/samples", new Blob([JSON.stringify(body)], { type: "application/json" })); } catch (e) { /* уходим */ } }
    });
  } else {
    // Кадр схемы: состояние берёт у верхнего окна (оно одно спрашивает сервер)
    setInterval(() => { try { const s = parentPerf.state(); if ((s.on ? s.run_id : null) !== S.run) setState(s); } catch (e) { /* верхнее окно закрыто */ } }, 2000);
    try { setState(parentPerf.state()); } catch (e) { /* первый вызов не удался — повторит таймер */ }
  }

  // ---------------------------------------------------------------- публичный объект
  window.zhbiPerf = {
    // Верхнее окно зовёт после входа в систему: запускает опрос состояния сбора
    configure() { if (!top || S.polling) return; S.polling = true; poll(); setInterval(poll, POLL_MS); },
    // Экран управления сообщает новое состояние сразу, не ждёт очередного опроса
    setState, poll,
    state: publicState, run: () => S.run, onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    record, start, span, ingest,
    setObject(id) { currentObject = Number.isInteger(id) ? id : null; },
    setOverlay, overlayOn: overlayWanted, clientId,
  };
})();
