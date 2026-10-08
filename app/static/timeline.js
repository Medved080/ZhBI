// «Срез состояния модели» и воспроизведение динамики на схеме 2D/3D (2026-10-08, запрос пользователя).
//
// Два режима просмотра:
//   • «Актуальный» — статусы на конец ТЕКУЩЕГО дня (записи истории с будущей датой не учитываются);
//   • «Хронологический» — произвольный момент (срез): вводом даты/времени или движком на ленте времени внизу схемы;
//     кнопка «Пуск» проигрывает выбранный период (по умолчанию весь) за 10 секунд.
// Плюс «подсветка отставания» (в обоих режимах): изделия, которые к моменту среза ДОЛЖНЫ быть уже смонтированы (по
// окончанию СМР) или доставлены (по началу СМР) по исходному или по прогнозному графику, а по факту ещё нет, рисуются косой
// штриховкой: тонкие линии — цвет статуса «Смонтирован» (или «Доставлен»), широкие полосы — фактический статус изделия.
//
// Как устроено, чтобы воспроизведение шло без рывков:
//   1. вся история статусов объекта приходит ОДНИМ бинарным массивом (GET /objects/{id}/status-timeline, app/status_timeline.py)
//      и дальше считается в браузере — бинарным поиском по записям изделия; к базе во время показа никто не обращается;
//   2. на каждом кадре статус пересчитывается у всех изделий (это несколько миллисекунд), но перекрашиваются ТОЛЬКО те, у кого
//      он изменился с прошлого кадра;
//   3. тяжёлое (легенда со счётчиками, пересчёт отбора по статусу) выполняется не чаще нескольких раз в секунду.
//
// Реализация — перекраска поля `current_status` изделий НА ВРЕМЯ показа среза (исходные значения хранятся в `server` и
// возвращаются при выходе в «Актуальный»): так срез автоматически согласован с легендой, отбором по статусу, подсказками и
// карточками. Пока открыт срез в прошлом, смена статусов с экрана отключена (guardEdit) — иначе правка писалась бы «в прошлое».
// Классический скрипт: делит глобальную область с app.js (state, styleShape, colorFor, …), наружу — только window.zhbiTimeline.
(function () {
  "use strict";
  if (window.zhbiTimeline) return;

  const EPOCH_MS = Date.UTC(2020, 0, 1);
  const DAY = 86400;
  const PLAY_MS = 10000;            // период воспроизводится за 10 секунд независимо от длины
  const HATCH_PX = 10;              // период штриховки на экране, px
  const THIN_SHARE = 0.28;          // доля тонкой линии в периоде штриховки
  const HATCH_STRIPE_3D_MM = 500;   // период штриховки в 3D, мм

  const tl = {
    mode: "actual",                 // actual | chrono
    data: null,                     // разобранный ответ сервера
    loadingFor: null,               // объект, для которого идёт загрузка
    loadedFor: null,
    cursor: null,                   // срез, секунды от 2020-01-01 «по стенным часам»
    range: { from: null, to: null },
    tMin: null, tMax: null,
    playing: false,
    server: new Map(),              // id -> исходный current_status изделий, чей статус сейчас перекрашен
    hatchMont: "off",               // off | plan | forecast — «должно быть смонтировано»
    hatchDeliv: "off",              // off | plan | forecast — «должно быть доставлено»
    flags: new Map(),               // id -> "installed" | "delivered" — у изделий со штриховкой
    ghosts: new Set(),              // id изделий «без статуса» (Запланирован) в хронологическом режиме — рисуются на 50% прозрачности
    map: null,                      // сопоставление с state.elements (см. rebuildMapping)
    light: 0,                       // таймер лёгкого обновления
    buildMs: 0,                     // длительность последней пересборки 3D при воспроизведении
    builtSig: null,                 // подпись набора изделий, с которым собрана 3D-сцена при воспроизведении
    bar: null,
  };

  // ------------------------------------------------------------------ время
  const nowSec = () => {
    const d = new Date();
    return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - EPOCH_MS) / 1000);
  };
  const endOfToday = () => { const n = nowSec(); return n - (n % DAY) + DAY - 1; };
  const dayStart = (s) => s - (((s % DAY) + DAY) % DAY);
  const toDate = (s) => new Date(EPOCH_MS + s * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const toInput = (s) => { const d = toDate(s); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fromInput = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || "");
    return m ? Math.floor((Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - EPOCH_MS) / 1000) : null;
  };
  const fmtRu = (s) => { const d = toDate(s); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtDayRu = (s) => { const d = toDate(s); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; };
  // «2026-09-30» (или с временем) → секунды начала суток; нет даты — -1
  const dateSec = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
    return m ? Math.floor((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH_MS) / 1000) : -1;
  };

  // ------------------------------------------------------------------ данные
  function b64(text, Type) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Type === Uint8Array ? bytes : new Type(bytes.buffer);
  }

  function decode(json) {
    const d = {
      statuses: json.statuses, n: json.n, m: json.m,
      ids: b64(json.ids, Int32Array), off: b64(json.off, Int32Array), ts: b64(json.ts, Int32Array), st: b64(json.st, Uint8Array),
      tMin: json.t_min, tMax: json.t_max,
    };
    d.index = new Map();
    for (let k = 0; k < d.n; k++) d.index.set(d.ids[k], k);
    d.code = d.statuses;
    d.planned = d.statuses.indexOf("planned");
    d.codeIdx = Object.fromEntries(d.statuses.map((c, i) => [c, i]));
    return d;
  }

  // Статус изделия k на момент T (индекс в d.statuses). До первой записи — «Запланирован».
  function statusIdxAt(d, k, T) {
    let lo = d.off[k], hi = d.off[k + 1] - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (d.ts[mid] <= T) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? d.planned : d.st[best];
  }

  // Сопоставление state.elements с массивами (позиция → k, плановые/прогнозные даты в секундах, текущий статус индексом).
  function rebuildMapping() {
    const d = tl.data, els = state.elements, n = els.length;
    const map = {
      n, k: new Int32Array(n).fill(-1), shown: new Uint8Array(n),
      montPlan: new Int32Array(n), montFc: new Int32Array(n), delPlan: new Int32Array(n), delFc: new Int32Array(n),
      flag: new Uint8Array(n), ghost: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const e = els[i];
      if (d) { const k = d.index.get(e.id); if (k !== undefined) map.k[i] = k; }
      // окончание СМР — к концу суток этой даты; начало СМР — с начала суток
      const mp = dateSec(e.project_delivery_date), mf = dateSec(e.forecast_smr_end_date);
      map.montPlan[i] = mp < 0 ? -1 : mp + DAY - 1;
      map.montFc[i] = mf < 0 ? -1 : mf + DAY - 1;
      map.delPlan[i] = dateSec(e.project_smr_start_date);
      map.delFc[i] = dateSec(e.forecast_smr_start_date);
    }
    tl.map = map;
  }

  async function loadData(objectId) {
    if (!objectId || tl.loadingFor === objectId) return;
    tl.loadingFor = objectId;
    setBusy("Загрузка истории статусов…");
    try {
      const json = await api(`/objects/${objectId}/status-timeline`);
      if (objectId !== state.objectId) return;
      tl.data = decode(json);
      tl.loadedFor = objectId;
      const today = endOfToday();
      tl.tMin = tl.data.tMin !== null ? dayStart(tl.data.tMin) : today - 30 * DAY;
      tl.tMax = Math.max(today, tl.data.tMax || 0);
      // границы интервала по умолчанию — весь период; прежний интервал сохраняем, если он внутри нового
      if (tl.range.from === null || tl.range.from < tl.tMin || tl.range.to > tl.tMax) tl.range = { from: tl.tMin, to: today };
      rebuildMapping();
      setBusy("");
      applyCursor(true);
      paintBar();
    } catch (e) {
      setBusy("История статусов недоступна: " + e.message);
    } finally {
      if (tl.loadingFor === objectId) tl.loadingFor = null;
    }
  }

  // ------------------------------------------------------------------ применение среза
  function currentCursor() { return tl.mode === "actual" ? endOfToday() : (tl.cursor ?? endOfToday()); }

  function restyle(el) {
    const shape = state.shapeById.get(el.id);
    if (shape) styleShape(shape, el);
  }

  // Пересчитать статусы и штриховку на момент cursor. Перекрашиваются только изменившиеся изделия.
  function applyCursor(force) {
    if (!state.elements.length) return;
    if (!tl.map || tl.map.n !== state.elements.length) rebuildMapping();
    const d = tl.data, map = tl.map, els = state.elements, T = currentCursor();
    const chrono = tl.mode === "chrono";
    const wantMont = tl.hatchMont, wantDeliv = tl.hatchDeliv;
    const instIdx = d ? d.codeIdx.installed : 5, delIdx = d ? d.codeIdx.delivered : 4;
    let changed = 0;
    const dirty = [];
    for (let i = 0; i < map.n; i++) {
      const el = els[i];
      let target = el.current_status;
      if (d) {
        const k = map.k[i];
        if (chrono) {
          target = d.statuses[k < 0 ? d.planned : statusIdxAt(d, k, T)];
        } else if (k >= 0 && d.ts[d.off[k + 1] - 1] > T) {
          target = d.statuses[statusIdxAt(d, k, T)];            // есть записи «из будущего» — статус на конец сегодняшнего дня
        } else if (tl.server.has(el.id)) {
          target = tl.server.get(el.id);                          // записей из будущего нет — исходный статус
        }
      }
      let touched = false;
      if (target !== el.current_status) {
        if (!tl.server.has(el.id)) tl.server.set(el.id, el.current_status);
        el.current_status = target;
        if (tl.server.get(el.id) === target) tl.server.delete(el.id);
        touched = true;
        changed++;
      }
      // штриховка отставания
      let f = 0;
      const sIdx = d ? d.codeIdx[el.current_status] : -1;
      if (sIdx !== undefined && sIdx >= 0) {
        if (wantMont !== "off") {
          const due = wantMont === "plan" ? map.montPlan[i] : map.montFc[i];
          if (due >= 0 && due <= T && sIdx < instIdx) f = 1;
        }
        if (!f && wantDeliv !== "off") {
          const due = wantDeliv === "plan" ? map.delPlan[i] : map.delFc[i];
          if (due >= 0 && due <= T && sIdx < delIdx) f = 2;
        }
      }
      // прозрачность изделий без статуса — только в хронологическом режиме
      const g = chrono && el.current_status === "planned" ? 1 : 0;
      if (g !== map.ghost[i]) { map.ghost[i] = g; if (g) tl.ghosts.add(el.id); else tl.ghosts.delete(el.id); touched = true; }
      if (f !== map.flag[i]) { map.flag[i] = f; if (f) tl.flags.set(el.id, f === 1 ? "installed" : "delivered"); else tl.flags.delete(el.id); touched = true; }
      if (touched) dirty.push(el);
    }
    if (force || dirty.length) {
      for (const el of dirty) restyle(el);
      if (typeof requestRender3D === "function") requestRender3D();
      scheduleLight(dirty.length || force);
    }
    return changed;
  }

  // Подпись набора изделий, прошедших отбор: по ней при воспроизведении решаем, нужна ли пересборка 3D.
  function visibleSignature() {
    let count = 0, sum = 0;
    for (const el of state.elements) if (passesPlacementFilters(el)) { count++; sum = (sum + el.id * 2654435761) % 4294967296; }
    return count + ":" + sum;
  }

  // Тяжёлое обновление — не чаще четырёх раз в секунду: легенда со счётчиками и отбор по статусу.
  // Отбор по статусу зависит от перекрашенного current_status, поэтому 3D пересобирается и во время воспроизведения —
  // но только когда набор видимых изделий реально изменился, и не чаще, чем втрое дольше самой пересборки.
  function scheduleLight(need) {
    if (!need || tl.light) return;
    const delay = tl.playing ? Math.max(250, 3 * (tl.buildMs || 0)) : 250;
    tl.light = setTimeout(() => {
      tl.light = 0;
      try {
        renderLegend();
        if (!state.placementFilters.status.size) return;
        if (!tl.playing) { applyPlacementFilters(true); return; }
        const sig = visibleSignature();
        if (sig === tl.builtSig) { applyPlacementFilters(false); return; }
        const t0 = performance.now();
        applyPlacementFilters(true);
        tl.buildMs = performance.now() - t0;
        tl.builtSig = sig;
      } catch (e) { /* не критично */ }
    }, delay);
  }

  // ------------------------------------------------------------------ штриховка 2D
  function defs() {
    const svg = document.getElementById("svg-root");
    let d = document.getElementById("tl-defs");
    if (!d) { d = document.createElementNS("http://www.w3.org/2000/svg", "defs"); d.id = "tl-defs"; svg.insertBefore(d, svg.firstChild); }
    return d;
  }
  function patternId(status, kind) { return `tlh-${status}-${kind}`; }
  function unitsPerPx() {
    const st = document.getElementById("stage");
    const v = state.view;
    if (!st || !v || !st.clientWidth || !st.clientHeight) return 100;
    return 1 / Math.min(st.clientWidth / v.w, st.clientHeight / v.h);
  }
  function fillPattern(pat, status, kind, size) {
    const bg = colorFor(status), line = colorFor(kind);
    pat.setAttribute("width", size); pat.setAttribute("height", size);
    const [r1, r2] = pat.querySelectorAll("rect");
    r1.setAttribute("width", size); r1.setAttribute("height", size); r1.setAttribute("fill", bg);
    r2.setAttribute("width", size * THIN_SHARE); r2.setAttribute("height", size); r2.setAttribute("fill", line);
  }
  function ensurePattern(status, kind) {
    const id = patternId(status, kind);
    let pat = document.getElementById(id);
    if (!pat) {
      const NS = "http://www.w3.org/2000/svg";
      pat = document.createElementNS(NS, "pattern");
      pat.id = id;
      pat.setAttribute("patternUnits", "userSpaceOnUse");
      pat.setAttribute("patternTransform", "rotate(45)");
      pat.dataset.status = status; pat.dataset.kind = kind;
      pat.appendChild(document.createElementNS(NS, "rect"));
      pat.appendChild(document.createElementNS(NS, "rect"));
      defs().appendChild(pat);
      fillPattern(pat, status, kind, HATCH_PX * unitsPerPx());
    }
    return id;
  }
  // Период штриховки — в пикселях ЭКРАНА, а не в мировых единицах: иначе при зуме линии вырастали бы вместе со схемой.
  function onZoom() {
    const d = document.getElementById("tl-defs");
    if (!d || !d.firstChild) return;
    const size = HATCH_PX * unitsPerPx();
    for (const pat of d.children) fillPattern(pat, pat.dataset.status, pat.dataset.kind, size);
  }

  // заливка 2D-фигуры изделия: узор или null (обычный цвет статуса)
  function hatchFill(element) {
    const kind = tl.flags.get(element.id);
    return kind ? `url(#${ensurePattern(element.current_status, kind)})` : null;
  }

  // Штриховка для 3D: цвет тонких линий изделия (или null) — читается app.js при перекраске вершин
  // «без статуса» (Запланирован) в хронологии — рисуется на 50% прозрачности (2D: fill-opacity, 3D: второй полупрозрачный меш)
  const isGhost = (element) => !!element && tl.ghosts.has(element.id);

  function hatchColor3D(element) {
    const kind = tl.flags.get(element.id);
    return kind ? colorFor(kind) : null;
  }

  // ------------------------------------------------------------------ воспроизведение
  let raf = 0, playT0 = 0, playFrom = 0, playTo = 0;
  function setCursor(T, fromPlay) {
    T = Math.max(tl.tMin ?? T, Math.min(tl.tMax ?? T, Math.round(T)));
    tl.cursor = T;
    if (tl.mode !== "chrono") tl.mode = "chrono";
    applyCursor(false);
    paintCursor(!fromPlay);
  }
  function play() {
    if (!tl.data) return;
    if (tl.mode !== "chrono") setMode("chrono");
    const from = tl.range.from, to = tl.range.to;
    if (!(to > from)) return;
    let start = tl.cursor;
    if (start === null || start < from || start >= to - 1) start = from;
    playFrom = start; playTo = to;
    // скорость постоянна: весь выбранный период — за 10 секунд, остаток — пропорционально
    playT0 = performance.now();
    tl.speed = (to - from) / PLAY_MS;           // секунд истории в мс
    tl.playing = true;
    tl.builtSig = null;
    paintBar();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    if (!tl.playing) return;
    const T = playFrom + (now - playT0) * tl.speed;
    if (T >= playTo) { setCursor(playTo, true); stop(); return; }
    setCursor(T, true);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!tl.playing && !raf) return;
    tl.playing = false;
    cancelAnimationFrame(raf); raf = 0;
    paintBar();
    scheduleLight(true);
    if (state.view3d.active && state.placementFilters.status.size) applyPlacementFilters(true);
  }
  // для проверок: сделать один «кадр» воспроизведения на заданный момент времени кадра
  function _step(now) { frame(now); }

  function setMode(mode) {
    if (mode === tl.mode) return;
    stop();
    tl.mode = mode;
    if (mode === "chrono") { tl.cursor = tl.cursor ?? endOfToday(); }
    applyCursor(true);
    paintBar();
  }

  // ------------------------------------------------------------------ интерфейс
  const CSS = `
  #timeline-bar { flex: 0 0 auto; border-top: 1px solid var(--color-border); background: var(--color-surface); padding: 6px 12px 8px; font-size: 12px; user-select: none; }
  #timeline-bar .tl-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #timeline-bar .tl-sep { width: 1px; align-self: stretch; background: var(--color-border); }
  #timeline-bar label { display: inline-flex; align-items: center; gap: 4px; }
  #timeline-bar select, #timeline-bar input[type=datetime-local] { font-size: 12px; padding: 2px 4px; }
  #timeline-bar .tl-seg { display: inline-flex; border: 1px solid var(--color-border); border-radius: 6px; overflow: hidden; }
  #timeline-bar .tl-seg button { border: 0; background: transparent; padding: 3px 10px; cursor: pointer; font-size: 12px; color: inherit; }
  #timeline-bar .tl-seg button.active { background: var(--color-primary, #1f4fd8); color: #fff; }
  #timeline-bar .tl-play { min-width: 74px; }
  #timeline-bar .tl-track-wrap { position: relative; height: 38px; margin: 8px 6px 0; touch-action: none; }
  #timeline-bar .tl-track { position: absolute; left: 0; right: 0; top: 10px; height: 18px; border-radius: 4px; background: var(--color-surface-2, #eef2f7); border: 1px solid var(--color-border); cursor: pointer; overflow: hidden; }
  #timeline-bar canvas.tl-hist { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
  #timeline-bar .tl-sel { position: absolute; top: 0; bottom: 0; background: rgba(31,79,216,.16); border-left: 2px solid #1f4fd8; border-right: 2px solid #1f4fd8; pointer-events: none; }
  #timeline-bar .tl-cursor { position: absolute; top: 2px; width: 0; height: 34px; border-left: 2px solid #d9480f; pointer-events: none; }
  #timeline-bar .tl-cursor::before { content: ""; position: absolute; left: -6px; top: -2px; border: 5px solid transparent; border-top: 7px solid #d9480f; }
  #timeline-bar .tl-handle { position: absolute; top: 0; width: 14px; height: 12px; margin-left: -7px; cursor: ew-resize; background: #1f4fd8; clip-path: polygon(0 0, 100% 0, 50% 100%); }
  #timeline-bar .tl-ends { display: flex; justify-content: space-between; color: var(--color-text-muted); font-size: 11px; margin: 0 6px; }
  #timeline-bar .tl-msg { color: var(--color-text-muted); }
  #timeline-bar.tl-actual .tl-chrono-only { display: none; }
  #timeline-bar .tl-banner { color: #d9480f; font-weight: 600; }
  `;

  function build() {
    if (tl.bar) return tl.bar;
    const area = document.getElementById("stage-area");
    if (!area) return null;
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    const bar = document.createElement("div");
    bar.id = "timeline-bar";
    bar.className = "tl-actual";
    bar.innerHTML = `
      <div class="tl-row">
        <div class="tl-seg" role="group" aria-label="Режим просмотра">
          <button type="button" data-mode="actual" title="Статусы на конец текущего дня">Актуальный</button>
          <button type="button" data-mode="chrono" title="Состояние на произвольный момент и воспроизведение динамики">Хронологический</button>
        </div>
        <span class="tl-chrono-only tl-sep"></span>
        <button type="button" class="btn btn-sm btn-primary tl-play tl-chrono-only" data-act="play" title="Проиграть выбранный период за 10 секунд">▶ Пуск</button>
        <label class="tl-chrono-only">Срез <input type="datetime-local" data-act="cursor-input"></label>
        <button type="button" class="btn btn-sm btn-secondary tl-chrono-only" data-act="now" title="Конец текущего дня">Сегодня</button>
        <span class="tl-chrono-only tl-sep"></span>
        <span class="tl-chrono-only" data-role="interval"></span>
        <button type="button" class="btn btn-sm btn-secondary tl-chrono-only" data-act="range-all" title="Проигрывать весь период">весь период</button>
        <span class="tl-msg" data-role="msg"></span>
      </div>
      <div class="tl-chrono-only">
        <div class="tl-track-wrap" data-role="wrap" tabindex="0" aria-label="Лента времени: срез и интервал воспроизведения">
          <div class="tl-track" data-role="track"><canvas class="tl-hist" data-role="hist"></canvas><div class="tl-sel" data-role="sel"></div></div>
          <div class="tl-handle" data-role="h-from" title="Начало интервала воспроизведения"></div>
          <div class="tl-handle" data-role="h-to" title="Конец интервала воспроизведения"></div>
          <div class="tl-cursor" data-role="cursor"></div>
        </div>
        <div class="tl-ends"><span data-role="end-from"></span><span data-role="end-to"></span></div>
      </div>`;
    const status = document.getElementById("statusbar");
    area.insertBefore(bar, status || null);
    tl.bar = bar;
    bindBar(bar);
    buildHatchPanel();
    return bar;
  }

  // «Подсветка отставания от графика» — в правой панели «Вид» (V1; в V2 те же два выбора рисует оболочка и шлёт setHatch).
  // Приоритет: если изделие должно быть и смонтировано, и доставлено (и подсветка включена у обоих), побеждает просрочка монтажа;
  // если монтаж не просрочен, а просрочена доставка — штриховка цветом статуса «Доставлен».
  const HATCH_OPTIONS = '<option value="off">не выделять</option><option value="plan">по исходному графику</option><option value="forecast">по прогнозу</option>';
  function buildHatchPanel() {
    const host = document.getElementById("tab-view");
    if (!host || document.getElementById("tl-hatch-panel")) return;
    const box = document.createElement("div");
    box.id = "tl-hatch-panel";
    box.style.cssText = "margin-top:16px";
    box.innerHTML = `<h4>Подсветка отставания от графика</h4>
      <p class="hint-text" style="margin:0 0 8px">К дате среза (в актуальном режиме — к концу сегодняшнего дня) изделия, у которых срок наступил, а статуса ещё нет, рисуются косой штриховкой: тонкие линии — цвет статуса «Смонтирован» или «Доставлен», широкие полосы — фактический статус.</p>
      <label style="display:block; margin-bottom:6px" title="По окончанию СМР: к моменту среза изделие должно быть смонтировано, а фактически ещё нет">Должны быть смонтированы<br>
        <select data-hatch="mont" style="width:100%">${HATCH_OPTIONS}</select></label>
      <label style="display:block" title="По началу СМР: к моменту среза изделие должно быть доставлено, а фактически ещё нет">Должны быть доставлены<br>
        <select data-hatch="deliv" style="width:100%">${HATCH_OPTIONS}</select></label>
      <p class="hint-text" style="margin:8px 0 0">Если изделие должно быть и доставлено, и смонтировано, приоритет у просрочки монтажа; если монтаж не просрочен, а просрочена доставка — штриховка цветом статуса «Доставлен».</p>`;
    host.appendChild(box);
    for (const sel of box.querySelectorAll("select")) sel.addEventListener("change", () => setHatch(sel.dataset.hatch, sel.value));
  }
  function paintHatchControls() {
    for (const sel of document.querySelectorAll("#tl-hatch-panel select")) sel.value = sel.dataset.hatch === "mont" ? tl.hatchMont : tl.hatchDeliv;
  }
  const listeners = [];
  function setHatch(which, value) {
    if (!["off", "plan", "forecast"].includes(value)) return;
    if (which === "mont") tl.hatchMont = value; else if (which === "deliv") tl.hatchDeliv = value; else return;
    if (tl.data) applyCursor(true);
    paintHatchControls();
    for (const fn of listeners) { try { fn(); } catch (e) { /* подписчик не должен ломать показ */ } }
  }

  const q = (role) => tl.bar && tl.bar.querySelector(`[data-role="${role}"]`);
  const frac = (T) => (tl.tMax > tl.tMin ? (T - tl.tMin) / (tl.tMax - tl.tMin) : 0);
  const secAt = (clientX) => {
    const r = q("track").getBoundingClientRect();
    return tl.tMin + Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * (tl.tMax - tl.tMin);
  };

  function bindBar(bar) {
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.mode) setMode(b.dataset.mode);
      else if (b.dataset.act === "play") { tl.playing ? stop() : play(); }
      else if (b.dataset.act === "now") setCursor(endOfToday());
      else if (b.dataset.act === "range-all") { tl.range = { from: tl.tMin, to: endOfToday() }; paintBar(); }
    });
    bar.querySelector('[data-act="cursor-input"]').addEventListener("change", (e) => {
      const s = fromInput(e.target.value);
      if (s !== null) { stop(); setCursor(s); }
    });

    // перетаскивание: по ленте — срез; по ручкам — границы интервала
    let drag = null;
    const wrap = q("wrap");
    wrap.addEventListener("pointerdown", (e) => {
      if (!tl.data) return;
      const role = e.target.dataset && e.target.dataset.role;
      drag = role === "h-from" ? "from" : role === "h-to" ? "to" : "cursor";
      wrap.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e) => {
      if (!drag) return;
      const s = secAt(e.clientX);
      if (drag === "cursor") { if (tl.playing) stop(); setCursor(s); }
      else if (drag === "from") { tl.range.from = Math.min(Math.round(s / 60) * 60, tl.range.to - DAY / 24); paintBar(); }
      else { tl.range.to = Math.max(Math.round(s / 60) * 60, tl.range.from + DAY / 24); paintBar(); }
    };
    wrap.addEventListener("pointermove", move);
    const end = () => { drag = null; };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    wrap.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? DAY / 24 : DAY;
      if (e.key === "ArrowLeft") { e.preventDefault(); setCursor(currentCursor() - step); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setCursor(currentCursor() + step); }
      else if (e.key === " ") { e.preventDefault(); tl.playing ? stop() : play(); }
    });
    window.addEventListener("resize", () => paintHist());
  }

  function setBusy(text) { tl.busyText = text; paintMsg(); }

  function paintHist() {
    const cv = q("hist");
    if (!cv || !tl.data) return;
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = cv.getContext("2d");
    const buckets = Math.max(20, Math.floor(r.width / 3));
    const counts = new Uint32Array(buckets);
    const d = tl.data, span = tl.tMax - tl.tMin || 1;
    let max = 1;
    for (let i = 0; i < d.m; i++) {
      const b = Math.min(buckets - 1, Math.max(0, Math.floor(((d.ts[i] - tl.tMin) / span) * buckets)));
      if (++counts[b] > max) max = counts[b];
    }
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "rgba(100,116,139,.55)";
    const bw = cv.width / buckets;
    for (let b = 0; b < buckets; b++) {
      if (!counts[b]) continue;
      const h = Math.max(2 * dpr, Math.sqrt(counts[b] / max) * cv.height);   // корень — чтобы редкие события не терялись рядом с пиками
      ctx.fillRect(b * bw, cv.height - h, Math.max(1, bw - 1), h);
    }
  }

  function paintCursor(updateInput) {
    if (!tl.bar) return;
    const T = currentCursor();
    const c = q("cursor");
    if (c) c.style.left = (frac(T) * 100) + "%";
    if (updateInput) { const inp = tl.bar.querySelector('[data-act="cursor-input"]'); if (inp && document.activeElement !== inp) inp.value = toInput(T); }
    else if (!paintCursor.t || performance.now() - paintCursor.t > 200) {
      paintCursor.t = performance.now();
      const inp = tl.bar.querySelector('[data-act="cursor-input"]'); if (inp) inp.value = toInput(T);
    }
  }

  function paintBar() {
    if (!tl.bar) return;
    const chrono = tl.mode === "chrono";
    tl.bar.classList.toggle("tl-actual", !chrono);
    for (const b of tl.bar.querySelectorAll(".tl-seg button")) b.classList.toggle("active", b.dataset.mode === tl.mode);
    const play = tl.bar.querySelector('[data-act="play"]');
    if (play) play.textContent = tl.playing ? "⏸ Пауза" : "▶ Пуск";
    paintHatchControls();
    if (tl.tMin !== null) {
      q("end-from").textContent = fmtDayRu(tl.tMin);
      q("end-to").textContent = fmtDayRu(tl.tMax);
      const sel = q("sel");
      sel.style.left = (frac(tl.range.from) * 100) + "%";
      sel.style.width = Math.max(0, (frac(tl.range.to) - frac(tl.range.from)) * 100) + "%";
      q("h-from").style.left = (frac(tl.range.from) * 100) + "%";
      q("h-to").style.left = (frac(tl.range.to) * 100) + "%";
      q("interval").textContent = `Интервал: ${fmtDayRu(tl.range.from)} — ${fmtDayRu(tl.range.to)}`;
    }
    paintCursor(true);
    paintHist();
    paintMsg();
  }

  // Строка состояния ленты: загрузка/ошибка важнее подсказки о режиме
  function paintMsg() {
    const msg = q("msg");
    if (!msg) return;
    const chrono = tl.mode === "chrono";
    if (tl.busyText) { msg.textContent = tl.busyText; msg.classList.remove("tl-banner"); return; }
    msg.classList.toggle("tl-banner", chrono && !!tl.data);
    msg.textContent = chrono && tl.data ? "Просмотр состояния на дату: смена статусов отключена" : "";
  }

  // ------------------------------------------------------------------ связь с приложением
  function setVisible(on) { const b = build(); if (b) b.style.display = on ? "" : "none"; }

  function onPlanLoaded() {
    const bar = build();
    if (!bar) return;
    // новый объект — прежний срез/интервал не имеют смысла
    if (tl.loadedFor !== null && tl.loadedFor !== state.objectId) {
      stop(); tl.data = null; tl.loadedFor = null; tl.server.clear(); tl.flags.clear(); tl.ghosts.clear(); tl.range = { from: null, to: null };
      tl.mode = "actual"; tl.cursor = null;
    }
    tl.server.clear();                    // state.elements заменён целиком — перекрашивать нечего, исходные статусы пришли с сервера
    tl.flags.clear();
    tl.ghosts.clear();
    rebuildMapping();
    loadData(state.objectId);             // фоном: историю статусов могли дополнить
    if (tl.data) applyCursor(true);
    paintBar();
  }

  // Изменение изделия другим пользователем (опрос /changes): исходный статус теперь новый; срез пересчитывается по свежей истории
  function onDelta(fresh) {
    if (tl.server.has(fresh.id) && "current_status" in fresh) tl.server.set(fresh.id, fresh.current_status);
    if (tl.loadedFor !== null) { tl.loadedFor = null; setTimeout(() => loadData(state.objectId), 300); }
  }

  function guardEdit() {
    if (tl.mode !== "chrono") return false;
    if (typeof showToast === "function") showToast("Открыт срез на дату: чтобы менять статусы, вернитесь в режим «Актуальный»", "warning");
    return true;
  }

  const snapshot = () => ({ hatchMont: tl.hatchMont, hatchDeliv: tl.hatchDeliv });
  function restore(saved) {
    if (!saved || typeof saved !== "object") return;
    if (["off", "plan", "forecast"].includes(saved.hatchMont)) tl.hatchMont = saved.hatchMont;
    if (["off", "plan", "forecast"].includes(saved.hatchDeliv)) tl.hatchDeliv = saved.hatchDeliv;
    if (tl.data) applyCursor(true);
    paintBar();
  }

  window.zhbiTimeline = {
    onPlanLoaded, onDelta, onZoom, setVisible, hatchFill, hatchColor3D, isGhost, guardEdit, snapshot, restore,
    isChrono: () => tl.mode === "chrono",
    setHatch, getHatch: () => ({ mont: tl.hatchMont, deliv: tl.hatchDeliv }), onChange: (fn) => listeners.push(fn),
    _state: tl, _step, _apply: applyCursor, _setCursor: setCursor, _play: play, _stop: stop, _setMode: setMode,
    stripe3D: HATCH_STRIPE_3D_MM,
  };
})();
