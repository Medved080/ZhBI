// Мост «сцена ↔ оболочка V2» (режим ?embed=scene, см. начало app.js). Классический скрипт: делит глобальную лексическую область с
// app.js (state, selectElement, setViewMode, …), поэтому НЕ копирует логику движка, а вызывает его функции.
//
// Протокол `zhbi-scene/1` (postMessage, только тот же origin, только между кадром и его родителем):
//   кадр → родитель:  { proto, evt: "ready" }                       — мост установлен (родитель может слать команды);
//                     { proto, evt: "state", state: {...} }         — снимок: объект, режим 2D/3D, загрузка, ошибка, счётчики, выбор;
//                     { proto, evt: "filters", model: {...} }       — модель фильтров (группы → значения → включено/доступно/число);
//                     { proto, evt: "notice", message }             — сообщение движка (то, что V1 показал бы в строке состояния);
//                     { proto, evt: "cmd-error", cmd, message }     — команда отклонена (неверные параметры/состояние).
//   родитель → кадр:  { proto, cmd, args } — команды из БЕЛОГО СПИСКА ниже; параметры проверяются по типам, HTML и код не принимаются.
//   setObject{objectId} · setView{mode:"2d"|"3d"|"3d-light"} · fit · zoom{factor} · select{id|null} · locate{id} · clearSelection ·
//   setFilter{changes:[{key,values,on}]} · resetFilters · setZoneVisible{category,on} · getFilters · reload
// Сообщения не из родительского окна и не с нашего origin молча игнорируются. Кадр НИЧЕГО не пишет на сервер (см. app.js).
(() => {
  "use strict";
  const PROTO = "zhbi-scene/1";
  // у документа из srcdoc `location.origin` равен "null", а собственный origin (унаследованный от оболочки) даёт `window.origin`
  const ORIGIN = window.origin && window.origin !== "null" ? window.origin : location.origin;
  const parentWin = window.parent;
  if (parentWin === window) return;

  const post = (msg) => { try { parentWin.postMessage({ proto: PROTO, ...msg }, ORIGIN); } catch (e) { /* родитель ушёл */ } };

  // ---------------- состояние, которое не хранит движок ----------------
  let loading = false;
  let loadError = null;
  let loadedOnce = false;
  let objectBusy = false;
  let pendingObject = null;

  const filterKeys = () => Object.keys(state.placementFilters);
  const viewMode = () => (state.view3d.active ? (state.lowSpec ? "3d-light" : "3d") : "2d");

  function shownCount() {
    let n = 0;
    for (const e of state.elements) if (passesPlacementFilters(e)) n++;
    return n;
  }
  function excludedCount() {
    let n = 0;
    for (const k of filterKeys()) n += state.placementFilters[k].size;
    return n;
  }

  // Поля выбранного элемента для панели V2 — только скаляры (строки/числа/даты), ровно те, что движок показывает в своей карточке.
  const ELEMENT_FIELDS = ["id", "element_type", "subtype", "mark", "address", "layer", "current_status", "floor", "elevation_mm", "source_file",
    "planned_delivery_date", "actual_delivery_date", "project_smr_start_date", "project_delivery_date", "contract_id", "comment", "x", "y", "object_id"];
  function elementInfo(e) {
    if (!e) return null;
    const out = {};
    for (const k of ELEMENT_FIELDS) { const v = e[k]; if (v === null || typeof v === "string" || typeof v === "number") out[k] = v; }
    const c = e.contract_id ? state.contracts.find((x) => x.id === e.contract_id) : null;
    out.contractName = c ? (c.name || null) : null;
    out.supplier = c ? (c.counterparty_short_name || null) : null;
    out.zones = {
      zakhvatka: e.zone_zakhvatka_id ? zoneNameById(e.zone_zakhvatka_id) : null,
      crane: e.zone_crane_id ? zoneNameById(e.zone_crane_id) : null,
      stance: e.zone_stance_id ? zoneNameById(e.zone_stance_id) : null,
    };
    return out;
  }
  function multiSummary(ids) {
    const byType = new Map(), byStatus = new Map();
    let n = 0;
    for (const id of ids) {
      const e = state.byId.get(id); if (!e) continue;
      n++;
      byType.set(e.element_type, (byType.get(e.element_type) || 0) + 1);
      byStatus.set(e.current_status, (byStatus.get(e.current_status) || 0) + 1);
    }
    return { count: n, byType: Array.from(byType), byStatus: Array.from(byStatus) };
  }
  function statusCountsShown() {
    const m = new Map();
    for (const e of state.elements) if (passesPlacementFilters(e)) m.set(e.current_status, (m.get(e.current_status) || 0) + 1);
    return Array.from(m);
  }
  function snapshot() {
    const cur = (typeof currentObject === "function") ? currentObject() : null;
    const multi = Array.from(state.multiSelectedIds);
    const present = new Set(state.zones.map((z) => z.category));
    return {
      selected: state.selectedId === null ? null : elementInfo(state.byId.get(state.selectedId)),
      multi: multi.length ? multiSummary(multi) : null,
      statusCounts: statusCountsShown(),
      statusLabels: state.statusLabels,
      statusColors: state.statusColors,
      statusOrder: state.statusOrder,
      zones: ["Захватка", "Кран"].filter((c) => present.has(c)).map((c) => ({ category: c, on: state.zoneVisibility[c] !== false })),
      objectId: state.objectId,
      objectName: cur && cur.object ? cur.object.name : null,
      projectName: cur && cur.project ? cur.project.name : null,
      hasDrawing: !!(cur && cur.object && cur.object.source_file),
      view: viewMode(),
      loading,
      loaded: loadedOnce && !loadError,
      error: loadError,
      total: state.elements.length,
      shown: state.elements.length ? shownCount() : 0,
      selectedId: state.selectedId,
      multiIds: Array.from(state.multiSelectedIds),
      excluded: excludedCount(),
    };
  }

  let stateTimer = null;
  function scheduleState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; post({ evt: "state", state: snapshot() }); }, 40);
  }

  // ---------------- перехват событий движка (обёртки, поведение движка не меняется) ----------------
  const wrap = (name, make) => {
    const orig = globalThis[name];
    if (typeof orig !== "function") return;
    globalThis[name] = make(orig);
  };

  wrap("setStageLoading", (orig) => function (on, text) { loading = !!on; scheduleState(); return orig.apply(this, arguments); });
  wrap("loadPlanInner", (orig) => async function () {
    loadError = null;
    try {
      const r = await orig.apply(this, arguments);
      loadedOnce = true;
      return r;
    } catch (e) {
      loadError = String((e && e.message) || e) || "Не удалось загрузить схему";
      throw e;
    } finally {
      scheduleState(); sendFilters();
    }
  });
  wrap("applyPlacementFilters", (orig) => function () { const r = orig.apply(this, arguments); scheduleState(); return r; });
  wrap("setViewMode", (orig) => async function () { try { return await orig.apply(this, arguments); } finally { scheduleState(); } });
  wrap("showToast", (orig) => function (message, kind) {
    try { post({ evt: "notice", message: String(message), kind: String(kind || "warning") }); } catch (e) { /* не критично */ }
    return orig.apply(this, arguments);
  });

  // Выбор на схеме меняется из десятков мест движка (клик, рамка, отчёт) — дешевле сверять подпись, чем перехватывать каждое.
  let lastSig = "";
  setInterval(() => {
    // мост может подключиться уже ПОСЛЕ начала первой загрузки: доводим состояние по фактическому наличию схемы
    if (state.elements.length && !loadedOnce) { loadedOnce = true; loading = false; sendFilters(); }
    const sig = state.objectId + "|" + state.elements.length + "|" + state.selectedId + "|" + state.multiSelectedIds.size + "|"
      + Array.from(state.multiSelectedIds).slice(0, 40).join(",");
    if (sig !== lastSig) { lastSig = sig; scheduleState(); }
  }, 150);

  // ---------------- модель фильтров (из тех же функций, что строят форму фильтров V1) ----------------
  function countsFor(key) {
    const def = PLACEMENT_FILTER_DEFS.find((d) => d.key === key);
    const m = new Map();
    for (const e of state.elements) { const v = def.valueFn(e); m.set(v, (m.get(v) || 0) + 1); }
    return m;
  }
  const mkItem = (key, v, label, counts) => ({
    v, label, on: !state.placementFilters[key].has(v), enabled: isValueEnabled(key, v), count: counts.get(v) || 0,
  });

  function flatGroup(key, title, labelFor, opts) {
    const counts = countsFor(key);
    const vals = Array.from(allValuesFor(key));
    if (key === "status") {
      const order = state.statusOrder || [];
      vals.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    } else vals.sort(placementComparator(labelFor, opts || {}));
    return { id: key, title, kind: "flat", key, items: vals.map((v) => mkItem(key, v, labelFor(v), counts)) };
  }

  function craneGroup() {
    const craneValues = allValuesFor("crane");
    const stanceValues = allValuesFor("stance");
    const byCrane = new Map();
    for (const sv of stanceValues) {
      if (sv === PLACEMENT_NONE) continue;
      const cv = craneIdForStanceId(sv);
      if (!byCrane.has(cv)) byCrane.set(cv, []);
      byCrane.get(cv).push(sv);
    }
    const heads = Array.from(new Set([...craneValues, ...byCrane.keys()])).sort(placementComparator(zoneLabelFor));
    const cCounts = countsFor("crane"), sCounts = countsFor("stance");
    const items = heads.map((h) => {
      const kids = (byCrane.get(h) || []).slice().sort(placementComparator(stanceLabelFor));
      return { ...mkItem("crane", h, zoneLabelFor(h), cCounts), branches: { stance: kids.map((k) => mkItem("stance", k, stanceLabelFor(k), sCounts)) } };
    });
    return { id: "craneStance", title: "Кран / стоянка", kind: "tree", key: "crane", branchTitles: { stance: "Стоянки" }, items };
  }

  function typeGroup() {
    const typeValues = allValuesFor("elementType");
    const subs = new Map(), marks = new Map();
    for (const e of state.elements) {
      if (!subs.has(e.element_type)) subs.set(e.element_type, new Set());
      subs.get(e.element_type).add(subtypeFilterValue(e));
      if (!marks.has(e.element_type)) marks.set(e.element_type, new Set());
      marks.get(e.element_type).add(markFilterValue(e));
    }
    const heads = Array.from(new Set([...typeValues, ...subs.keys(), ...marks.keys()])).sort(placementComparator((v) => v));
    const tC = countsFor("elementType"), sC = countsFor("subtype"), mC = countsFor("mark");
    const items = heads.map((h) => {
      const st = Array.from(subs.get(h) || []).sort(placementComparator(subtypeLabelFor));
      const mk = Array.from(marks.get(h) || []).sort(placementComparator(markLabelFor));
      return {
        ...mkItem("elementType", h, h, tC),
        branches: { subtype: st.map((v) => mkItem("subtype", v, subtypeLabelFor(v), sC)), mark: mk.map((v) => mkItem("mark", v, markLabelFor(v), mC)) },
      };
    });
    return { id: "elementType", title: "Тип элемента", kind: "tree", key: "elementType", branchTitles: { subtype: "Подтипы", mark: "Марки" }, items };
  }

  function supplierGroup() {
    const supplierValues = allValuesFor("supplier");
    const contractValues = allValuesFor("contract");
    const bySupplier = new Map();
    for (const cv of contractValues) {
      if (cv === PLACEMENT_NONE) continue;
      const c = state.contracts.find((x) => x.id === cv);
      const sv = c ? c.counterparty_short_name : PLACEMENT_NONE;
      if (!bySupplier.has(sv)) bySupplier.set(sv, []);
      bySupplier.get(sv).push(cv);
    }
    const heads = Array.from(new Set([...supplierValues, ...bySupplier.keys()])).sort(placementComparator(supplierLabelFor));
    const sC = countsFor("supplier"), cC = countsFor("contract");
    const items = heads.map((h) => {
      const kids = (bySupplier.get(h) || []).slice().sort(placementComparator(contractLabelFor));
      return { ...mkItem("supplier", h, supplierLabelFor(h), sC), branches: { contract: kids.map((k) => mkItem("contract", k, contractLabelFor(k), cC)) } };
    });
    const groups = [{ id: "supplier", title: "Контрагент / контракт", kind: "tree", key: "supplier", branchTitles: { contract: "Контракты" }, items }];
    if (contractValues.has(PLACEMENT_NONE)) {
      groups.push({ id: "noContract", title: "Без контракта", kind: "flat", key: "contract", items: [mkItem("contract", PLACEMENT_NONE, "элементы без контракта", cC)] });
    }
    return groups;
  }

  function filterModel() {
    if (!state.elements.length) return { groups: [] };
    return {
      groups: [
        flatGroup("zakhvatka", "Захватка", zoneLabelFor),
        craneGroup(),
        flatGroup("floor", "Этаж", floorLabelFor, { compareRaw: true }),
        flatGroup("elevation", "Отметка (высота)", elevationLabelFor, { compareRaw: true }),
        typeGroup(),
        flatGroup("status", "Статус", statusLabelFor),
        ...supplierGroup(),
      ],
      statusColors: state.statusColors,
    };
  }
  let filtersTimer = null;
  function sendFilters() {
    if (filtersTimer) return;
    filtersTimer = setTimeout(() => { filtersTimer = null; try { post({ evt: "filters", model: filterModel() }); } catch (e) { post({ evt: "cmd-error", cmd: "getFilters", message: String(e.message || e) }); } }, 60);
  }

  // ---------------- команды (белый список; параметры проверяются) ----------------
  const isInt = (x) => Number.isInteger(x) && x > 0 && x < 2 ** 31;
  const isVal = (x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x));

  async function setObject(id) {
    if (objectBusy) { pendingObject = id; return; }
    objectBusy = true;
    try { await switchObject(id); } finally {
      objectBusy = false; scheduleState(); sendFilters();
      // запоздавший запрос на смену объекта: применяем только ПОСЛЕДНИЙ
      if (pendingObject !== null) { const next = pendingObject; pendingObject = null; if (next !== state.objectId) await setObject(next); }
    }
  }

  const COMMANDS = {
    setObject(a) {
      if (!isInt(a.objectId)) throw new Error("objectId");
      const known = state.projects.flatMap((p) => p.objects || []).some((o) => o.id === a.objectId);
      if (!known) throw new Error("объект недоступен");
      return setObject(a.objectId);
    },
    setView(a) {
      if (!["2d", "3d", "3d-light"].includes(a.mode)) throw new Error("mode");
      return setViewMode(a.mode);
    },
    fit() {
      if (state.view3d.active) fit3DCameraToData();
      else if (state.initialView) setView({ ...state.initialView });
      if (typeof requestRender3D === "function") requestRender3D();
      scheduleState();
    },
    zoom(a) {
      const f = Number(a.factor);
      if (!(f > 0.1 && f < 10)) throw new Error("factor");
      if (state.view3d.active) {
        const v3 = state.view3d;
        if (!v3.camera || !v3.controls) return;
        const off = v3.camera.position.clone().sub(v3.controls.target).multiplyScalar(f);
        v3.camera.position.copy(v3.controls.target).add(off);
        v3.controls.update();
        if (typeof requestRender3D === "function") requestRender3D();
      } else if (state.view) {
        const v = state.view, cx = v.x + v.w / 2, cy = v.y + v.h / 2, w = v.w * f, h = v.h * f;
        setView({ x: cx - w / 2, y: cy - h / 2, w, h });
      }
    },
    select(a) {
      if (a.id === null) { clearSelection(); return; }
      if (!isInt(a.id)) throw new Error("id");
      const el = state.byId.get(a.id);
      if (!el) throw new Error("элемента нет на схеме");
      selectElement(el);
      scheduleState();
    },
    locate(a) {
      if (!isInt(a.id)) throw new Error("id");
      const el = state.byId.get(a.id);
      if (!el) throw new Error("элемента нет на схеме");
      if (state.view3d.active) focus3DOnElement(el); else focus2DOnElement(el);
    },
    clearSelection() { clearSelection(); clearMultiSelection(); scheduleState(); },
    setFilter(a) {
      if (!Array.isArray(a.changes) || a.changes.length > 50) throw new Error("changes");
      const keys = filterKeys();
      for (const ch of a.changes) {
        if (!ch || !keys.includes(ch.key) || !Array.isArray(ch.values) || ch.values.length > 6000 || typeof ch.on !== "boolean" || !ch.values.every(isVal)) throw new Error("параметры фильтра");
      }
      for (const ch of a.changes) {
        const set = state.placementFilters[ch.key];
        for (const v of ch.values) { if (ch.on) set.delete(v); else set.add(v); }
      }
      onPlacementFilterChange();
      scheduleState(); sendFilters();
    },
    resetFilters() {
      for (const k of filterKeys()) state.placementFilters[k].clear();
      if (typeof resetAllDateFilters === "function") resetAllDateFilters();
      if (typeof resetChangeFilter === "function") resetChangeFilter();
      onPlacementFilterChange();
      scheduleState(); sendFilters();
    },
    setZoneVisible(a) {
      if (!["Захватка", "Кран"].includes(a.category) || typeof a.on !== "boolean") throw new Error("параметры зоны");
      state.zoneVisibility[a.category] = a.on;
      renderZones();
      if (typeof apply3DZoneVisibility === "function") apply3DZoneVisibility();
      scheduleState();
    },
    getFilters() { sendFilters(); scheduleState(); },
    async reload() { await loadPlan(true); },
  };

  window.addEventListener("message", (e) => {
    if (e.source !== parentWin || e.origin !== ORIGIN) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.proto !== PROTO || typeof m.cmd !== "string") return;
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, m.cmd)) { post({ evt: "cmd-error", cmd: m.cmd, message: "неизвестная команда" }); return; }
    const args = m.args && typeof m.args === "object" ? m.args : {};
    try {
      Promise.resolve(COMMANDS[m.cmd](args)).catch((err) => post({ evt: "cmd-error", cmd: m.cmd, message: String((err && err.message) || err) }));
    } catch (err) {
      post({ evt: "cmd-error", cmd: m.cmd, message: String((err && err.message) || err) });
    }
  });

  { const box = document.getElementById("stage-loading"); loading = !!box && box.style.display !== "none"; }
  loadedOnce = state.elements.length > 0;
  post({ evt: "ready" });
  scheduleState();
  if (loadedOnce) sendFilters();
})();
