// Производственная программа в деньгах — общий экран для V1 и V2 (2026-10-23, Docs/pp-money.md).
//
// ОДИН модуль на оба интерфейса (как `headcount-ui.js`): отрисовка диаграммы Ганта и жесты перенесены из прототипа «ПП 2026–2027», весь расчёт —
// в `core.js` (там же проверка «логика сохранена»). Транспорт и подтверждение передаются ЯВНО: ctx = { api, upload, download, canWrite, canAdmin, confirm }.
//   api.get/put/post/delete(path, body) — как у V2; в V1 это тонкая обёртка над `api()` app.js;
//   upload(path, FormData) — multipart POST (загрузка выгрузки);
//   download(path, body, имяФайла) — POST с JSON-телом, ответ сохраняется файлом;
//   confirm(text, { danger }) → Promise<boolean>.
// Правки сроков ОБЩИЕ: сохраняются на сервере сразу после жеста (перетаскивание, ввод дат) и видны всем, у кого есть раздел. Без права
// «Изменение» жесты и поля дат отключены. Сервер (app/pp.py) хранит данные и права; считает браузер.
import {
  createModel, DAY, FAMILY_NAMES, MONTHS_ABBR, MONTHS_RU, daysOf, daysToSerial, dFromDays, familyOf, fmtD, fmtM, fmtMParts, isoD, norm,
  serialToDays, shiftMonth, snapDays,
} from "./core.js";

const CSS_URL = "/static/pp/pp.css";
const LS = "pp-ui-v1";
const LEFT_W = 546, RIGHT_W = 150, ROW_H = 28, GRP_H = 30, BAR_H = 14, INSET = 38, YEAR_W = LEFT_W * 0.35;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errText = (e) => (e && typeof e.detail === "string" && e.detail) || (e && e.message) || String(e);
const byRu = (a, b) => String(a).localeCompare(String(b), "ru");

function ensureCss() {
  if (document.querySelector("link[data-pp-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = CSS_URL; l.setAttribute("data-pp-css", "1");
  document.head.appendChild(l);
}

export function mountPp(el, ctx) {
  ensureCss();
  const { api } = ctx;
  const canWrite = !!ctx.canWrite;
  const canAdmin = !!ctx.canAdmin;
  let dead = false;

  const model = createModel();
  let meta = { dataset: null, objects: [], groups: [], edits_count: 0 };
  let editInfo = new Map();            // ключ работы → {by, at} последней общей правки
  let saved = new Map();               // ключ работы → {s, e}: что сейчас лежит на сервере
  let byCW = new Map();                // «код\0название» → ключ работы в модели
  let metaByCode = new Map();
  const S = { div: "all", grp: "all", obj: "all", snap: "week", depth: 1, collapsed: new Set(), expanded: new Set() };
  let drag = null, lastAx = null, curDayW = 4, raf = 0, saving = Promise.resolve(), loadError = "";

  /* ===== разметка ===== */
  el.innerHTML = `<div class="pp-root${canWrite ? "" : " readonly"}">
    <div class="pp-meta" data-r="meta"></div>
    <div class="pp-controls">
      <label>СМУ / подразделение <select data-r="div"></select></label>
      <label>Группа <select data-r="grp"></select></label>
      <label>Объект <select data-r="obj"></select></label>
      <label>Поиск объекта <span class="pp-srchwrap"><input data-r="search" type="text" placeholder="код или название…" autocomplete="off" spellcheck="false"><div class="pp-srchlist" data-r="srchlist"></div></span></label>
      <label>Прилипание <select data-r="snap"><option value="day">День</option><option value="week">Неделя</option><option value="month">Месяц</option></select></label>
      <span class="pp-lvlbtns">Структура
        <button class="pp-btn pp-lvl" data-lvl="1" title="Только название объекта">1 ур.</button>
        <button class="pp-btn pp-lvl" data-lvl="2" title="Объект + задачи 1-го уровня">2 ур.</button>
        <button class="pp-btn pp-lvl" data-lvl="3" title="+ задачи 2-го уровня">3 ур.</button>
        <button class="pp-btn pp-lvl" data-lvl="4" title="Все уровни">4 ур.</button>
      </span>
      <div class="pp-actions">
        <button class="pp-btn" data-act="groups" title="Общие группы объектов для просмотра">Группы…</button>
        ${canWrite ? '<button class="pp-btn" data-act="reset" title="Сбросить общие правки сроков по показанным объектам">Сбросить правки</button>' : ""}
        <button class="pp-btn" data-act="refresh" title="Перечитать общие правки с сервера">Обновить</button>
        <button class="pp-btn" data-act="export" title="Выгрузить показанные объекты с правками в Excel">Выгрузить Excel</button>
        ${canAdmin ? '<button class="pp-btn" data-act="import" title="Загрузить новую выгрузку «ДД.ММ.ГГГГ.xlsx»">Загрузить выгрузку…</button>' : ""}
      </div>
    </div>
    <div data-r="panel"></div>
    <div class="pp-scroll" data-r="scroll"><div class="pp-inner" data-r="inner">
      <div class="pp-axis" data-r="axis"></div>
      <div class="pp-body"><div class="pp-left" data-r="left"></div><svg class="pp-svg" data-r="svg" role="img" aria-label="Диаграмма Ганта производственной программы"></svg><div class="pp-right" data-r="right"></div></div>
    </div></div>
    <div class="pp-foot" data-r="foot"></div>
    <div class="pp-legend" data-r="legend"></div>
    <details class="pp-nodates" data-r="nodates"></details>
  </div>`;
  const root = el.querySelector(".pp-root");
  const R = (name) => root.querySelector(`[data-r="${name}"]`);
  const scroll = R("scroll"), svg = R("svg"), leftEl = R("left"), rightEl = R("right"), axisEl = R("axis"), footEl = R("foot"), panel = R("panel");

  /* окна, которые живут в <body> (position: fixed не должен зависеть от прокрутки и преобразований родителей) */
  const tip = document.createElement("div"); tip.className = "pp-tip";
  const popup = document.createElement("div"); popup.className = "pp-popup";
  popup.innerHTML = `<div class="pp-title">Сроки работы</div>
    <div class="pp-row"><label>Начало</label><input type="date" data-p="s"></div>
    <div class="pp-row"><label>Окончание</label><input type="date" data-p="e"></div>
    <div class="pp-btns"><button class="pp-btn" data-p="m-">−1 мес</button><button class="pp-btn" data-p="m+">+1 мес</button><span style="flex:1"></span>
      <button class="pp-btn" data-p="cancel">Отмена</button><button class="pp-btn pp-primary" data-p="ok">ОК</button></div>`;
  const toastEl = document.createElement("div"); toastEl.className = "pp-toast";
  document.body.append(tip, popup, toastEl);
  let toastTimer = 0;
  const toast = (msg) => { toastEl.textContent = msg; toastEl.style.opacity = "1"; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 3200); };

  /* ===== личные удобства (только в этом браузере) ===== */
  function saveUi() {
    try { localStorage.setItem(LS, JSON.stringify({ div: S.div, grp: S.grp, obj: S.obj, snap: S.snap, depth: S.depth, collapsed: [...S.collapsed], expanded: [...S.expanded] })); } catch (e) { /* нет хранилища — не страшно */ }
  }
  function loadUi() {
    try {
      const o = JSON.parse(localStorage.getItem(LS) || "null");
      if (!o) return;
      for (const k of ["div", "grp", "obj", "snap"]) if (typeof o[k] === "string") S[k] = o[k];
      if (Number.isInteger(o.depth) && o.depth >= 0 && o.depth <= 3) S.depth = o.depth;
      S.collapsed = new Set(o.collapsed || []); S.expanded = new Set(o.expanded || []);
    } catch (e) { /* испорченное значение игнорируем */ }
  }

  /* ===== загрузка ===== */
  async function loadAll() {
    loadError = "";
    try {
      const [m, data, ed] = await Promise.all([api.get("/pp/meta"), api.get("/pp/data"), api.get("/pp/edits")]);
      if (dead) return;
      meta = m;
      metaByCode = new Map(meta.objects.map((o) => [o.code, o]));
      model.load(data);
      byCW = new Map();
      for (const [key, rec] of model.wByKey) byCW.set(rec.o.code + "\u0000" + rec.w.work, key);
      applyServerEdits(ed.edits);
    } catch (e) { loadError = errText(e); }
  }
  function applyServerEdits(list) {
    const entries = [];
    editInfo = new Map();
    for (const r of list) {
      const key = byCW.get(r.code + "\u0000" + r.work);
      if (!key) continue;
      entries.push([key, { s: serialToDays(r.s), e: serialToDays(r.e) }]);
      editInfo.set(key, { by: r.by, at: r.at });
    }
    model.setEdits(entries);
    saved = new Map(entries.map(([k, v]) => [k, { ...v }]));
  }
  async function reloadEdits() {
    try { applyServerEdits((await api.get("/pp/edits")).edits); meta.edits_count = saved.size; } catch (e) { toast(errText(e)); }
    renderAll();
  }
  async function reloadMeta() { meta = await api.get("/pp/meta"); metaByCode = new Map(meta.objects.map((o) => [o.code, o])); }

  /* ===== сохранение общих правок ===== */
  function recOf(key) { const r = model.wByKey.get(key); return r ? { code: r.o.code, work: r.w.work } : null; }
  function persist() {
    saving = saving.then(async () => {
      const cur = model.edits;
      const set = [], del = [];
      for (const [k, v] of cur) {
        const sv = saved.get(k);
        const rec = recOf(k);
        if (rec && (!sv || sv.s !== v.s || sv.e !== v.e)) set.push({ ...rec, s: daysToSerial(v.s), e: daysToSerial(v.e) });
      }
      for (const k of saved.keys()) { if (!cur.has(k)) { const rec = recOf(k); if (rec) del.push(rec); } }
      if (!set.length && !del.length) return;
      try {
        await api.put("/pp/edits", { set, delete: del });
        saved = new Map([...cur].map(([k, v]) => [k, { ...v }]));
        toast(`Правки сохранены${set.length ? `: ${set.length}` : ""}`);
        await reloadEdits();      // подтянуть автора и время, а заодно чужие правки
      } catch (e) {
        toast("Правки не сохранены: " + errText(e));
        await reloadEdits();      // вернуть то, что на сервере
      }
    });
    return saving;
  }

  /* ===== выборка ===== */
  function selectedList() {
    let codes = null;
    if (S.grp !== "all") {
      const g = meta.groups.find((x) => String(x.id) === S.grp);
      const idToCode = new Map(meta.objects.map((o) => [o.id, o.code]));
      codes = new Set((g ? g.ids : []).map((i) => idToCode.get(i)).filter(Boolean));
    }
    if (S.obj !== "all") codes = codes ? new Set(codes.has(S.obj) ? [S.obj] : []) : new Set([S.obj]);
    return model.selectObjects({ division: S.div, codes });
  }
  function populateFilters() {
    const divs = [...new Set(model.objects.map((o) => o.division))].sort(byRu);
    if (S.div !== "all" && !divs.includes(S.div)) S.div = "all";
    R("div").innerHTML = '<option value="all">Все подразделения</option>' + divs.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    R("div").value = S.div;
    if (S.grp !== "all" && !meta.groups.some((g) => String(g.id) === S.grp)) S.grp = "all";
    R("grp").innerHTML = '<option value="all">Все объекты</option>' + meta.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.ids.length})</option>`).join("");
    R("grp").value = S.grp;
    populateObjects();
    R("snap").value = S.snap;
  }
  function populateObjects() {
    const sel = R("obj");
    let codes = null;
    const base = S.obj; S.obj = "all";
    const list = selectedList();
    S.obj = base;
    codes = new Set(list.map((o) => o.code));
    const byDiv = new Map();
    for (const o of list) { if (!byDiv.has(o.division)) byDiv.set(o.division, []); byDiv.get(o.division).push(o); }
    let h = '<option value="all">Все объекты</option>';
    for (const [d, arr] of [...byDiv].sort((a, b) => byRu(a[0], b[0]))) {
      h += `<optgroup label="${esc(d)}">` + arr.sort((a, b) => byRu(a.name, b.name)).map((o) => `<option value="${esc(o.code)}">${esc(o.name)}</option>`).join("") + "</optgroup>";
    }
    sel.innerHTML = h;
    if (S.obj !== "all" && codes.has(S.obj)) sel.value = S.obj; else { sel.value = "all"; S.obj = "all"; }
  }

  /* ===== шкала ===== */
  function computeAxis(list) {
    const avail = Math.max(300, scroll.clientWidth - LEFT_W - RIGHT_W - 24);
    const T0D = model.startDay;
    const segs0 = model.buildSegments(model.maxEnd(list));
    const monthSegs = segs0.filter((s) => s.type === "m");
    const yearSegs = segs0.filter((s) => s.type === "y");
    const monthDays = monthSegs[monthSegs.length - 1].next / DAY - T0D;
    let monthW = avail - INSET - yearSegs.length * YEAR_W;
    if (yearSegs.length && monthW < 300) monthW = 300;   // минимум для читаемости, дальше — горизонтальная прокрутка
    if (monthW < 60) monthW = 60;
    const dayW = monthW / monthDays;
    const segs = segs0;
    let x = INSET;
    for (const sg of segs) {
      const days = (sg.next - sg.t) / DAY;
      sg.x1 = x;
      sg.w = sg.type === "m" ? days * dayW : YEAR_W;
      x += sg.w;
      sg.x2 = x;
    }
    const axisW = x;
    const axisEnd = segs[segs.length - 1].next / DAY - 1;
    const xOf = (dn) => {
      if (dn <= T0D) return INSET;
      for (const sg of segs) {
        const a = sg.t / DAY, b = sg.next / DAY;
        if (dn < b) return sg.x1 + ((dn - a) / (b - a)) * sg.w;
      }
      return axisW;
    };
    const dayAt = (xp) => {
      if (xp <= INSET) return T0D;
      for (const sg of segs) if (xp < sg.x2) { const a = sg.t / DAY, b = sg.next / DAY; return a + ((xp - sg.x1) / sg.w) * (b - a); }
      return axisEnd;
    };
    return { dayW, axisW, segs, axisEnd, xOf, dayAt };
  }

  /* ===== отрисовка ===== */
  function requestRender() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (!dead) renderAll(); }); }
  function renderAll() {
    if (!meta.dataset || loadError) { renderEmpty(); return; }
    model.refreshDerived();
    const list = selectedList();
    const view = model.computeView(list, { depth: S.depth, collapsed: S.collapsed, expanded: S.expanded });
    const ax = computeAxis(list);
    lastAx = ax; curDayW = ax.dayW;
    renderMeta();
    renderGantt(view, ax);
    renderFoot(list, ax);
    renderNoDates();
    for (const b of root.querySelectorAll("[data-lvl]")) b.classList.toggle("on", +b.dataset.lvl === S.depth + 1);
  }
  function renderEmpty() {
    axisEl.innerHTML = ""; leftEl.innerHTML = ""; rightEl.innerHTML = ""; svg.innerHTML = ""; footEl.innerHTML = ""; R("legend").innerHTML = ""; R("nodates").innerHTML = "";
    svg.setAttribute("width", 0);
    scroll.querySelector(".pp-empty")?.remove();
    const msg = loadError ? `Не удалось загрузить данные: ${esc(loadError)}`
      : `Данные производственной программы ещё не загружены.${canAdmin ? " Нажмите «Загрузить выгрузку…» и выберите файл «ДД.ММ.ГГГГ.xlsx»." : " Загрузку выполняет администратор сервиса."}`;
    scroll.insertAdjacentHTML("afterbegin", `<div class="pp-empty">${msg}</div>`);
    renderMeta();
  }
  function renderMeta() {
    scroll.querySelector(".pp-empty")?.remove();
    const d = meta.dataset;
    R("meta").textContent = d
      ? `Данные: ${d.source_file}, загружены ${String(d.loaded_at).slice(0, 16).replace("T", " ")}${d.loaded_by ? " (" + d.loaded_by + ")" : ""} · объектов ${meta.objects.length}, из них не в сервисе ${meta.objects.filter((o) => !o.in_service).length} · общих правок сроков: ${saved.size}${canWrite ? "" : " · просмотр: правки сроков недоступны"}`
      : "";
  }
  function renderGantt(view, ax) {
    const rows = view.rows;
    let y = 0;
    const pos = [];
    for (const r of rows) { pos.push({ r, y }); y += r.type === "o" ? GRP_H : ROW_H; }
    const totalH = y + 8;
    const W = ax.axisW;
    let ah = '<div class="corner"><span class="ch ch-name" title="Наименование работ">Виды работ</span><span class="ch ch-date">Начало</span><span class="ch ch-date">Окончание</span></div>';
    const ys = [...new Set(ax.segs.map((sg) => sg.y))].sort((a, b) => a - b);
    for (const yr of ys) {
      const ySegs = ax.segs.filter((sg) => sg.y === yr);
      const mid = LEFT_W + ax.xOf((ySegs[0].t + ySegs[ySegs.length - 1].next) / 2 / DAY);
      ah += `<span class="ylab" style="left:${mid}px">${yr}</span>`;
    }
    for (const sg of ax.segs) {
      if (sg.type !== "m") continue;
      ah += `<span class="mlab" style="left:${LEFT_W + ax.xOf((sg.t + sg.next) / 2 / DAY)}px">${MONTHS_ABBR[sg.m]}</span>`;
    }
    ah += '<div class="corner-r" title="Остаток с учётом распределения по нижним уровням">Остаток</div>';
    axisEl.innerHTML = ah;
    /* левая колонка */
    let lh = "";
    for (const p of pos) {
      const r = p.r;
      if (r.type === "o") {
        const o = r.o, okey = model.objKeyOf(o), span = model.objDates(o);
        const isOpen = !S.collapsed.has(okey) && (S.depth > 0 || S.expanded.has(okey));
        const tri = (o.top || []).length ? `<span class="tri" title="${isOpen ? "Свернуть" : "Раскрыть"}">${isOpen ? "▾" : "▸"}</span>` : '<span class="tri"></span>';
        const pm = metaByCode.get(o.code);
        const badge = pm && !pm.in_service ? '<span class="pp-badge" title="Объекта с таким названием нет в сервисе">не в сервисе</span>' : "";
        lh += `<div class="pp-lrow grp" data-key="${esc(okey)}" data-obj="1" data-depth="-1" style="height:${GRP_H}px" title="${esc(o.code + " · " + o.name + " — " + o.division)}. Срок объекта рассчитывается по работам">${tri}<span class="gn">${esc(o.name)}${badge}</span><span class="od">${span ? fmtD(dFromDays(span.s)) : "—"}</span><span class="od">${span ? fmtD(dFromDays(span.e)) : "—"}</span></div>`;
      } else {
        const w = r.w, d = model.effDates(w);
        const isOpen = !S.collapsed.has(w.key) && (r.depth + 1 < S.depth || S.expanded.has(w.key));
        const tri = w.children.length ? `<span class="tri" title="${isOpen ? "Свернуть" : "Раскрыть"}">${isOpen ? "▾" : "▸"}</span>` : '<span class="tri"></span>';
        const t = w.children.length ? "Изменить дату (сдвинет все нижние работы)" : "Изменить дату";
        const dis = canWrite ? "" : " disabled";
        const inputs = `<input type="date" class="di" data-which="s" value="${isoD(dFromDays(d.s))}" title="${t}"${dis}><input type="date" class="di" data-which="e" value="${isoD(dFromDays(d.e))}" title="${t}"${dis}>`;
        lh += `<div class="pp-lrow work${r.depth > 0 ? " ch" : ""}${model.edits.has(w.key) ? " edited" : ""}" data-key="${esc(w.key)}" data-depth="${r.depth}" style="height:${ROW_H}px;padding-left:${6 + (r.depth + 1) * 16}px">${tri}<span class="wn" title="${esc(w.work)}">${esc(w.work)}</span>${inputs}</div>`;
      }
    }
    lh += '<div class="pp-gsp"></div>';
    leftEl.innerHTML = lh;
    /* правая колонка */
    let rh = "", totR = 0;
    for (const p of pos) {
      const r = p.r;
      if (r.type === "o") {
        const v = model.objTotal(r.o);
        totR += v;   // итог считается один раз — по объекту, работы не задваивают
        rh += `<div class="pp-rrow" style="height:${GRP_H}px" title="Остаток по объекту: ${esc(fmtM(v))}">${esc(fmtM(v))}</div>`;
      } else {
        const rv = model.effTotal(r.w);
        rh += `<div class="pp-rrow${r.depth === 0 ? "" : " rch"}" style="height:${ROW_H}px" title="Остаток (с учётом нижних уровней): ${esc(fmtM(rv))}">${esc(fmtM(rv))}</div>`;
      }
    }
    rh += `<div class="pp-ltot"><span>Итого</span><span class="lv">${esc(fmtM(totR))}</span></div>`;
    rightEl.innerHTML = rh;
    /* диаграмма */
    let s = "<g>";
    for (const sg of ax.segs) s += `<line class="${sg.type === "y" || sg.m === 0 ? "gyear" : "gmonth"}" x1="${ax.xOf(sg.t / DAY)}" y1="0" x2="${ax.xOf(sg.t / DAY)}" y2="${totalH}"></line>`;
    s += `<line class="edge" x1="${W - 1}" y1="0" x2="${W - 1}" y2="${totalH}"></line>`;
    for (const p of pos) s += `<line class="grow" x1="0" y1="${p.y}" x2="${W}" y2="${p.y}"></line>`;
    s += "</g>";
    for (const p of pos) {
      const r = p.r;
      if (r.type === "o") {
        const span = model.objDates(r.o);
        if (!span) continue;
        let x1 = Math.max(1, ax.xOf(span.s)), x2 = Math.min(W - 1, ax.xOf(span.e));
        if (x2 - x1 < 4) x2 = Math.min(W - 1, x1 + 4);
        s += `<g class="grpbar"><rect x="${x1}" y="${p.y + 11}" width="${x2 - x1}" height="8" rx="4"></rect></g>`;
      } else {
        const w = r.w, d = model.effDates(w);
        let x1 = ax.xOf(d.s), x2 = ax.xOf(d.e);
        const clL = x1 < 1, clR = x2 > W - 1;
        x1 = Math.max(1, x1); x2 = Math.min(W - 1, x2);
        if (x2 - x1 < 4) x2 = Math.min(W - 1, x1 + 4);
        const isChild = r.depth > 0;
        const total = model.effTotal(w);
        const lbl = total ? fmtM(total) : "";
        const nm = w.money == null && !w.children.length ? " nomoney" : "";
        const bh = isChild ? 8 : BAR_H, by = p.y + (isChild ? 10 : 7);
        s += `<g class="barrow f${familyOf(w.work)}${nm}${isChild ? " childbar" : ""}${model.edits.has(w.key) ? " edited" : ""}" data-key="${esc(w.key)}">` +
          `<rect class="bar" x="${x1}" y="${by}" width="${x2 - x1}" height="${bh}" rx="4"></rect>` +
          `<rect class="handle hl" x="${x1 - 4}" y="${p.y + 4}" width="8" height="20"></rect><rect class="handle hr" x="${x2 - 4}" y="${p.y + 4}" width="8" height="20"></rect>` +
          (x2 - x1 > 70 && lbl ? `<text class="blab" x="${x2 + 6}" y="${p.y + 17}">${esc(lbl)}</text>` : "") +
          (clR ? `<text class="clipmark" x="${W - 12}" y="${p.y + 16}">›</text>` : "") +
          (clL ? `<text class="clipmark" x="6" y="${p.y + 16}">‹</text>` : "") + "</g>";
      }
    }
    svg.setAttribute("width", W); svg.setAttribute("height", totalH);
    svg.innerHTML = s;
    R("inner").style.width = LEFT_W + W + RIGHT_W + "px";
  }
  function renderFoot(list, ax) {
    const sums = model.footSums(list, ax.segs);
    const total = sums.reduce((a, b) => a + b, 0);
    let cells = "";
    for (let i = 0; i < ax.segs.length; i++) {
      const sg = ax.segs[i];
      const wpx = Math.max(2, sg.w - (i === 0 ? 1 : 0));
      const name = sg.type === "m" ? MONTHS_ABBR[sg.m] : String(sg.y);
      const title = sg.type === "m" ? MONTHS_RU[sg.m] + " " + sg.y : sg.y + " год";
      const parts = fmtMParts(sums[i]);
      cells += `<div class="fcell" style="width:${wpx}px" title="${title}: ${esc(fmtM(sums[i]))}"><span class="fname">${name}</span><span class="fsum">${esc(parts.num)}</span><span class="funit">${esc(parts.unit)}</span></div>`;
    }
    footEl.innerHTML = `<div class="fleft">Суммы за месяц</div><div class="fclip"><div class="fcells" data-r="fcells">${cells}</div></div><div class="fright" title="Итого по шкале">Итого: ${esc(fmtM(total))}</div>`;
    if (scroll.scrollLeft) R("fcells").style.transform = "translateX(-" + scroll.scrollLeft + "px)";
  }
  function renderNoDates() {
    const box = R("nodates");
    const nd = model.noDates, nr = model.noDateRows;
    const cnt = nd.length + nr.length;
    if (!cnt) { box.innerHTML = ""; return; }
    const rows = nd.slice(0, 400).map((m) => `<tr><td>${esc(m.d)}</td><td>${esc(m.o)}</td><td>${esc(m.w)}</td><td class="num">${esc(fmtM(m.p))}</td><td class="num">${esc(fmtM(m.dn))}</td><td class="num">${esc(fmtM(m.r))}</td></tr>`).join("");
    const more = nd.length > 400 ? `<tr><td colspan="6">… и ещё ${nd.length - 400} строк</td></tr>` : "";
    box.innerHTML = `<summary>Работы с деньгами, но без сроков: ${nd.length}${nr.length ? `; работ без дат: ${nr.length}` : ""}</summary>` +
      `<div style="max-height:300px;overflow:auto"><table><thead><tr><th>Подразделение</th><th>Объект</th><th>Работа</th><th class="num">Договорная цена</th><th class="num">Выполнено</th><th class="num">Остаток</th></tr></thead><tbody>${rows}${more}</tbody></table></div>`;
  }
  function renderLegend() {
    let h = "";
    for (let f = 1; f <= 8; f++) h += `<span class="it"><span class="sw f${f}"></span>${FAMILY_NAMES[f]}</span>`;
    R("legend").innerHTML = h;
  }

  /* ===== подсказка ===== */
  function tipHtml(o, w) {
    const d = model.effDates(w);
    const dur = d.e - d.s + 1;
    const e0 = model.edits.get(w.key);
    const preS = e0 ? e0.s : w.s0;
    const started = preS < model.startDay;
    const total = model.effTotal(w), own = model.ownMoney(w), extra = w.extra || 0;
    const mh = w.money != null || w.children.length || extra > 0
      ? `<div class="row"><span>Остаток</span><span><b>${esc(fmtM(total))}</b></span></div>` +
        (extra > 0 ? `<div class="row"><span>в т. ч. от родителя</span><span>${esc(fmtM(extra))}</span></div>` : "") +
        (own > 0 ? `<div class="row"><span>Собственный остаток</span><span>${esc(fmtM(own))}</span></div>` : "") +
        (w.money ? `<div class="row"><span>Договорная цена</span><span>${esc(fmtM(w.money.p))}</span></div>` : "") +
        (w.children.length ? `<div class="row"><span>Дочерних задач</span><span>${w.children.length}</span></div>` : "")
      : '<div class="row"><span>Деньги</span><span>нет данных в выгрузке</span></div>';
    const info = editInfo.get(w.key);
    const hint = !canWrite ? "Просмотр: правка сроков требует права «Изменение»"
      : w.children.length ? "Срок складывается из нижних работ • правка сдвигает все нижние" : "Тяните за середину/края полосы • двойной клик — ввод дат";
    return `<div class="t1">${esc(w.work)}</div>` +
      `<div class="row"><span>Объект</span><span>${esc(o.name)}</span></div>` +
      `<div class="row"><span>Подразделение</span><span>${esc(o.division)}</span></div>` +
      (w.parentKey ? `<div class="row"><span>В составе</span><span>${esc(model.wByKey.get(w.parentKey).w.work)}</span></div>` : "") +
      `<div class="row"><span>Срок</span><span>${fmtD(dFromDays(d.s))} – ${fmtD(dFromDays(d.e))} (${dur} дн.)</span></div>` +
      `<div class="row"><span>Источник срока</span><span>${model.dateSource(w)}</span></div>` +
      (info && model.edits.has(w.key) ? `<div class="row"><span>Правка</span><span>${esc(info.by || "—")}, ${esc(String(info.at || "").slice(0, 16))}</span></div>` : "") +
      (started && !w.parentKey && !w.children.length ? `<div class="row"><span>Начата ${fmtD(dFromDays(preS))}</span><span>остаток распределяется с ${fmtD(dFromDays(model.startDay))}</span></div>` : "") +
      mh + `<div class="hint">${hint}</div>`;
  }
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.style.display = "block";
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let lx = x + 14, ly = y + 14;
    if (lx + w > innerWidth - 8) lx = x - w - 14;
    if (ly + h > innerHeight - 8) ly = y - h - 14;
    tip.style.left = lx + "px"; tip.style.top = ly + "px";
  }
  const hideTip = () => { tip.style.display = "none"; };

  /* ===== жесты ===== */
  function onPointerDown(e) {
    if (!canWrite) return;
    const g = e.target.closest("g");
    if (!g || !g.classList.contains("barrow")) return;
    e.preventDefault();
    const rec = model.wByKey.get(g.dataset.key);
    if (!rec) return;
    const rect = g.querySelector(".bar");
    const x1 = +rect.getAttribute("x"), x2 = x1 + +rect.getAttribute("width");
    const svgX = e.clientX - svg.getBoundingClientRect().left;
    const cur = model.effDates(rec.w);
    let mode = "move";
    if (svgX - x1 < 10) mode = "rs"; else if (x2 - svgX < 10) mode = "re";
    drag = { key: g.dataset.key, mode, startX: e.clientX, x0: svgX, day0: lastAx ? lastAx.dayAt(svgX) : cur.s, s: cur.s, e: cur.e, s0: cur.s, e0: cur.e, hasCh: rec.w.children.length > 0 };
    if (drag.hasCh) model.setPreview(drag);
    hideTip();
    root.classList.add("dragging"); root.dataset.dragmode = mode;
  }
  function onPointerMove(e) {
    if (drag) {
      const svgX = e.clientX - svg.getBoundingClientRect().left;
      const dx = lastAx ? lastAx.dayAt(svgX) - drag.day0 : (e.clientX - drag.startX) / curDayW;
      // dx накопительный, поэтому считаем от исходных s0/e0, а не от текущего предпросмотра (иначе смещение удваивалось бы)
      let s = drag.s0, ee = drag.e0;
      if (drag.mode === "move") { const dd = snapDays(dx, S.snap); s = drag.s0 + dd; ee = drag.e0 + dd; }
      else if (drag.mode === "rs") { s = snapDays(drag.s0 + dx, S.snap); if (s >= ee) s = ee - 1; }
      else { ee = snapDays(drag.e0 + dx, S.snap); if (ee <= s) ee = s + 1; }
      if (drag.hasCh) { drag.s = s; drag.e = ee; } else model.setLeafEdit(drag.key, s, ee);
      requestRender();
      return;
    }
    const g = e.target.closest && e.target.closest("g");
    if (g && g.classList.contains("barrow") && svg.contains(g)) {
      const rec = model.wByKey.get(g.dataset.key);
      if (rec) { showTip(tipHtml(rec.o, rec.w), e.clientX, e.clientY); return; }
    }
    hideTip();
  }
  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    model.setPreview(null);
    if (d.hasCh) model.applyEdit(d.key, d.s, d.e, { s: d.s0, e: d.e0 });
    root.classList.remove("dragging"); delete root.dataset.dragmode;
    renderAll();
    persist();
  }
  svg.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("dblclick", (e) => {
    const g = e.target.closest(".barrow");
    if (!g || !canWrite) { popup.style.display = "none"; return; }
    const rec = model.wByKey.get(g.dataset.key);
    if (!rec) return;
    const d = model.effDates(rec.w);
    popup.querySelector('[data-p="s"]').value = isoD(dFromDays(d.s));
    popup.querySelector('[data-p="e"]').value = isoD(dFromDays(d.e));
    popup.dataset.key = g.dataset.key;
    popup.style.left = Math.min(e.clientX, innerWidth - 260) + "px";
    popup.style.top = Math.min(e.clientY, innerHeight - 170) + "px";
    popup.style.display = "block";
  });
  const popDays = () => [daysOf(new Date(popup.querySelector('[data-p="s"]').value + "T00:00:00Z")), daysOf(new Date(popup.querySelector('[data-p="e"]').value + "T00:00:00Z"))];
  popup.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-p]");
    if (!b || b.tagName !== "BUTTON") return;
    const act = b.dataset.p;
    if (act === "cancel") { popup.style.display = "none"; return; }
    const [s, e] = popDays();
    if (act === "m-" || act === "m+") {
      if (isNaN(s) || isNaN(e)) return;
      const delta = act === "m+" ? 1 : -1;
      popup.querySelector('[data-p="s"]').value = isoD(dFromDays(shiftMonth(s, delta)));
      popup.querySelector('[data-p="e"]').value = isoD(dFromDays(shiftMonth(e, delta)));
      return;
    }
    if (isNaN(s) || isNaN(e) || e < s) { toast("Проверьте даты: окончание раньше начала"); return; }
    model.applyEdit(popup.dataset.key, s, e);
    popup.style.display = "none";
    renderAll(); persist();
  });
  leftEl.addEventListener("change", (e) => {
    if (!e.target.classList.contains("di") || !canWrite) return;
    const key = e.target.closest(".pp-lrow").dataset.key;
    const rec = model.wByKey.get(key);
    if (!rec || !e.target.value) return;
    const dd = daysOf(new Date(e.target.value + "T00:00:00Z"));
    const cur = model.effDates(rec.w);
    let s = cur.s, ee = cur.e;
    if (e.target.dataset.which === "s") { s = dd; if (s >= ee) s = ee - 1; } else { ee = dd; if (ee <= s) ee = s + 1; }
    model.applyEdit(key, s, ee);
    renderAll(); persist();
  });
  leftEl.addEventListener("click", (e) => {
    const tri = e.target.closest(".pp-lrow .tri");
    if (!tri) return;
    const rowEl = tri.closest(".pp-lrow"), key = rowEl.dataset.key;
    if (rowEl.dataset.obj === "1") {
      const isOpen = !S.collapsed.has(key) && (S.depth > 0 || S.expanded.has(key));
      if (isOpen) { S.collapsed.add(key); S.expanded.delete(key); } else { S.collapsed.delete(key); if (S.depth === 0) S.expanded.add(key); else S.expanded.delete(key); }
    } else {
      const depth = +rowEl.dataset.depth || 0;
      const isOpen = !S.collapsed.has(key) && (depth + 1 < S.depth || S.expanded.has(key));
      if (isOpen) { S.collapsed.add(key); S.expanded.delete(key); } else { S.collapsed.delete(key); if (depth + 1 >= S.depth) S.expanded.add(key); else S.expanded.delete(key); }
    }
    renderAll(); saveUi();
  });
  scroll.addEventListener("scroll", () => { const fc = R("fcells"); if (fc) fc.style.transform = "translateX(-" + scroll.scrollLeft + "px)"; });
  const onResize = () => requestRender();
  window.addEventListener("resize", onResize);

  /* ===== фильтры, поиск, уровни ===== */
  R("div").addEventListener("change", (e) => { S.div = e.target.value; populateObjects(); renderAll(); saveUi(); });
  R("grp").addEventListener("change", (e) => { S.grp = e.target.value; populateObjects(); renderAll(); saveUi(); });
  R("obj").addEventListener("change", (e) => { S.obj = e.target.value; renderAll(); saveUi(); });
  R("snap").addEventListener("change", (e) => { S.snap = e.target.value; saveUi(); });
  root.querySelectorAll("[data-lvl]").forEach((b) => b.addEventListener("click", () => { S.depth = +b.dataset.lvl - 1; S.collapsed.clear(); S.expanded.clear(); renderAll(); saveUi(); }));
  const sBox = R("search"), sList = R("srchlist");
  let sItems = [], sSel = -1;
  function sRender() {
    const words = norm(sBox.value).split(" ").filter(Boolean);
    sItems = [];
    if (words.length) for (const o of model.objects) { if (words.every((w) => norm(o.code + " " + o.name + " " + o.division).includes(w))) { sItems.push(o); if (sItems.length >= 12) break; } }
    sSel = sItems.length ? 0 : -1;
    if (!sItems.length) { sList.style.display = "none"; sList.innerHTML = ""; return; }
    sList.innerHTML = sItems.map((o, i) => `<div class="pp-si${i === sSel ? " on" : ""}" data-code="${esc(o.code)}" data-i="${i}"><span class="sc">${esc(o.code)}</span><span class="sn">${esc(o.name)}</span><span class="sd">${esc(o.division)}</span></div>`).join("");
    sList.style.display = "block";
  }
  function sMark() { for (const c of sList.children) c.classList.toggle("on", +c.dataset.i === sSel); sList.children[sSel]?.scrollIntoView?.({ block: "nearest" }); }
  function sPick(code) {
    sList.style.display = "none";
    S.div = "all"; S.grp = "all"; S.obj = code;
    populateFilters(); R("obj").value = code;
    renderAll(); saveUi();
  }
  sBox.addEventListener("input", sRender);
  sBox.addEventListener("focus", () => { if (sBox.value.trim()) sRender(); });
  sBox.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { sList.style.display = "none"; return; }
    if (!sItems.length || sList.style.display === "none") return;
    if (e.key === "ArrowDown") { e.preventDefault(); sSel = Math.min(sItems.length - 1, sSel + 1); sMark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sSel = Math.max(0, sSel - 1); sMark(); }
    else if (e.key === "Enter") { e.preventDefault(); if (sSel >= 0) sPick(sItems[sSel].code); }
  });
  sList.addEventListener("mousedown", (e) => { const it = e.target.closest(".pp-si"); if (it) { e.preventDefault(); sPick(it.dataset.code); } });
  const onDocDown = (e) => { if (!e.target.closest || !e.target.closest(".pp-srchwrap")) sList.style.display = "none"; if (!popup.contains(e.target) && !e.target.closest?.(".pp-svg")) popup.style.display = "none"; };
  document.addEventListener("mousedown", onDocDown);

  /* ===== действия ===== */
  const visibleCodes = () => selectedList().map((o) => o.code);
  async function doReset() {
    const codes = visibleCodes();
    const withEdits = codes.filter((c) => [...model.edits.keys()].some((k) => model.wByKey.get(k)?.o.code === c));
    if (!withEdits.length) { toast("По показанным объектам общих правок нет"); return; }
    const ok = await ctx.confirm(`Сбросить общие правки сроков по показанным объектам (${withEdits.length})? Правки общие — они пропадут у всех пользователей.`, { danger: true });
    if (!ok) return;
    try {
      const q = S.obj === "all" && S.grp === "all" && S.div === "all" ? "" : "?codes=" + encodeURIComponent(withEdits.join(","));
      await api.delete("/pp/edits" + q);
      toast("Правки сброшены");
    } catch (e) { toast(errText(e)); }
    await reloadEdits();
  }
  async function doExport() {
    const codes = visibleCodes();
    if (!codes.length) { toast("Нечего выгружать: ничего не показано"); return; }
    try {
      const tables = model.exportTables(codes);
      await ctx.download("/pp/export", tables, `ПП_правки_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast(`Excel выгружен: ${tables.schedule.length} строк сроков, ${tables.money.length} строк денег`);
    } catch (e) { toast(errText(e)); }
  }

  /* ----- группы объектов ----- */
  function openGroups() {
    if (panel.dataset.kind === "groups") { panel.innerHTML = ""; panel.dataset.kind = ""; return; }
    panel.dataset.kind = "groups";
    const gs = { id: S.grp !== "all" ? S.grp : "new", name: "", ids: new Set(), q: "" };
    const load = () => {
      const g = meta.groups.find((x) => String(x.id) === gs.id);
      gs.name = g ? g.name : "";
      gs.ids = new Set(g ? g.ids : []);
    };
    load();
    const render = () => {
      const opts = '<option value="new">— новая группа —</option>' + meta.groups.map((g) => `<option value="${g.id}"${String(g.id) === gs.id ? " selected" : ""}>${esc(g.name)}</option>`).join("");
      panel.innerHTML = `<div class="pp-panel"><h4>Группы объектов (общие)</h4>
        <div class="row"><label>Группа <select data-g="pick">${opts}</select></label>
          <label>Название <input type="text" data-g="name" maxlength="100" value="${esc(gs.name)}"${canWrite ? "" : " disabled"}></label>
          <label>Фильтр <input type="text" data-g="q" placeholder="код, название, подразделение" value="${esc(gs.q)}"></label></div>
        <div class="pp-checklist" data-g="list"></div>
        <div class="row"><span class="pp-muted" data-g="cnt"></span>
          ${canWrite ? '<button class="pp-btn" data-g="all">Отметить показанные</button><button class="pp-btn" data-g="none">Снять показанные</button>' : ""}
          <span style="flex:1"></span>
          ${canWrite ? '<button class="pp-btn pp-primary" data-g="save">Сохранить</button>' : ""}
          ${canWrite && gs.id !== "new" ? '<button class="pp-btn pp-danger" data-g="del">Удалить группу</button>' : ""}
          <button class="pp-btn" data-g="close">Закрыть</button></div></div>`;
      renderList();
    };
    const shown = () => { const w = norm(gs.q).split(" ").filter(Boolean); return meta.objects.filter((o) => w.every((x) => norm(o.code + " " + o.name + " " + o.unit).includes(x))); };
    const renderList = () => {
      const list = shown();
      panel.querySelector('[data-g="list"]').innerHTML = list.map((o) => `<label><input type="checkbox" data-id="${o.id}"${gs.ids.has(o.id) ? " checked" : ""}${canWrite ? "" : " disabled"}><span class="sc">${esc(o.code)}</span><span>${esc(o.name)}</span><span class="sd">${esc(o.unit)}${o.in_service ? "" : " · не в сервисе"}</span></label>`).join("") || '<div class="pp-empty">Ничего не найдено</div>';
      panel.querySelector('[data-g="cnt"]').textContent = `В группе: ${gs.ids.size}, показано: ${list.length}`;
    };
    render();
    panel.onchange = (e) => {
      const t = e.target;
      if (t.dataset.g === "pick") { gs.id = t.value; gs.q = ""; load(); render(); }
      else if (t.dataset.id) { const id = +t.dataset.id; if (t.checked) gs.ids.add(id); else gs.ids.delete(id); renderList(); }
    };
    panel.oninput = (e) => {
      if (e.target.dataset.g === "name") gs.name = e.target.value;
      else if (e.target.dataset.g === "q") { gs.q = e.target.value; renderList(); }
    };
    panel.onclick = async (e) => {
      const b = e.target.closest("button[data-g]");
      if (!b) return;
      const act = b.dataset.g;
      if (act === "close") { panel.innerHTML = ""; panel.dataset.kind = ""; return; }
      if (act === "all") { for (const o of shown()) gs.ids.add(o.id); renderList(); return; }
      if (act === "none") { for (const o of shown()) gs.ids.delete(o.id); renderList(); return; }
      try {
        if (act === "save") {
          const body = { name: gs.name, ids: [...gs.ids] };
          const r = gs.id === "new" ? await api.post("/pp/groups", body) : await api.put(`/pp/groups/${gs.id}`, body);
          gs.id = String(r.id);
          await reloadMeta();
          S.grp = gs.id; S.obj = "all";
          populateFilters(); renderAll(); saveUi(); render();
          toast("Группа сохранена");
        } else if (act === "del") {
          if (!(await ctx.confirm(`Удалить группу «${gs.name}»? Группа общая — она пропадёт у всех.`, { danger: true }))) return;
          await api.delete(`/pp/groups/${gs.id}`);
          await reloadMeta();
          if (S.grp === gs.id) S.grp = "all";
          gs.id = "new"; load(); populateFilters(); renderAll(); saveUi(); render();
          toast("Группа удалена");
        }
      } catch (err) { toast(errText(err)); }
    };
  }

  /* ----- загрузка выгрузки (администратор сервиса) ----- */
  function openImport() {
    if (panel.dataset.kind === "import") { panel.innerHTML = ""; panel.dataset.kind = ""; return; }
    panel.dataset.kind = "import";
    panel.innerHTML = `<div class="pp-panel"><h4>Загрузка выгрузки производственной программы</h4>
      <p class="pp-hint">Файл «ДД.ММ.ГГГГ.xlsx» с листами «Ввод» и «Лист6». Загрузка заменяет работы и деньги целиком; объекты (по коду проекта), общие правки сроков и группы сохраняются. Перед загрузкой снимается копия базы.</p>
      <div class="row"><input type="file" data-i="file" accept=".xlsx"><button class="pp-btn" data-i="analyze">Разобрать</button><button class="pp-btn" data-i="close">Закрыть</button></div>
      <div data-i="out"></div></div>`;
    const file = () => panel.querySelector('[data-i="file"]').files[0];
    const out = panel.querySelector('[data-i="out"]');
    const form = () => { const fd = new FormData(); fd.append("file", file()); return fd; };
    const table = (r) => {
      const rows = [
        ["Объектов в файле", r.objects], ["Строк сроков", r.schedule_rows], ["Строк денег", r.money_rows], ["Остаток, всего", fmtM(r.rest_total)],
        ["Новых объектов", r.objects_new], ["Исчезнет объектов", r.objects_removed], ["Пропадёт общих правок", r.edits_dropped],
        ["Пропадёт участий в группах", r.group_members_dropped], ["Совпало по названию с объектами сервиса", `${r.objects_in_service} из ${r.objects}`],
        ["Слито дублей работ из разных блоков", r.merged_duplicates], ["Деньги кодов, которых нет в «Ввод» (отброшены)", r.codes_money_only],
      ];
      const warn = (r.objects_removed || r.edits_dropped || r.group_members_dropped);
      return `<table class="pp-report">${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</table>` +
        (warn ? '<p class="pp-warn">Часть объектов, правок или участий в группах исчезнет — проверьте цифры выше.</p>' : "") +
        (r.current ? `<p class="pp-hint">Сейчас загружено: ${esc(r.current.source_file)} (${esc(String(r.current.loaded_at).slice(0, 16))}). Будет заменено.</p>` : "") +
        '<div class="row"><button class="pp-btn pp-primary" data-i="apply">Загрузить</button><button class="pp-btn" data-i="dry">Проверить без записи</button></div>';
    };
    panel.onclick = async (e) => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      const act = b.dataset.i;
      if (act === "close") { panel.innerHTML = ""; panel.dataset.kind = ""; return; }
      if (!file()) { toast("Выберите файл .xlsx"); return; }
      b.disabled = true;
      try {
        if (act === "analyze") {
          out.innerHTML = '<p class="pp-muted">Разбираю файл…</p>';
          out.innerHTML = table(await ctx.upload("/pp/import/analyze", form()));
        } else {
          const dry = act === "dry";
          if (!dry && !(await ctx.confirm("Заменить данные производственной программы содержимым файла? Перед загрузкой будет снята копия базы.", { danger: true }))) return;
          out.insertAdjacentHTML("afterbegin", '<p class="pp-muted">' + (dry ? "Проверяю без записи…" : "Загружаю…") + "</p>");
          const fd = form(); fd.append("dry_run", dry ? "true" : "false");
          const r = await ctx.upload("/pp/import/apply", fd);
          if (dry) { out.innerHTML = '<p class="pp-hint">Проверка без записи: ошибок нет, в базу ничего не записано.</p>' + table(r); }
          else { toast(`Загружено: ${r.objects} объектов, ${r.schedule_rows} строк сроков, ${r.money_rows} строк денег`); await fullReload(); panel.innerHTML = ""; panel.dataset.kind = ""; }
        }
      } catch (err) { out.innerHTML = `<p class="pp-warn">${esc(errText(err))}</p>`; }
      finally { b.disabled = false; }
    };
  }

  root.querySelector('[data-act="groups"]').addEventListener("click", openGroups);
  root.querySelector('[data-act="reset"]')?.addEventListener("click", doReset);
  root.querySelector('[data-act="refresh"]').addEventListener("click", async () => { await reloadEdits(); toast("Правки обновлены"); });
  root.querySelector('[data-act="export"]').addEventListener("click", doExport);
  root.querySelector('[data-act="import"]')?.addEventListener("click", openImport);

  async function fullReload() {
    await loadAll();
    populateFilters();
    renderAll();
  }

  /* ===== старт ===== */
  loadUi();
  renderLegend();
  fullReload().then(() => { if (!dead && !meta.dataset && canAdmin && !loadError) openImport(); });

  return {
    hasUnsavedChanges: () => false,           // правки уходят на сервер сразу после жеста
    reload: fullReload,
    destroy() {
      dead = true;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDocDown);
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(toastTimer);
      tip.remove(); popup.remove(); toastEl.remove();
    },
  };
}
