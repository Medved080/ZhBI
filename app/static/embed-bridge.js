// Мост «сцена ↔ оболочка V2» (режим ?embed=scene, см. начало app.js). Классический скрипт: делит глобальную лексическую область с
// app.js (state, selectElement, setViewMode, …), поэтому НЕ копирует логику движка, а вызывает его функции.
//
// Протокол `zhbi-scene/1` (postMessage, только тот же origin, только между кадром и его родителем):
//   кадр → родитель:  { proto, evt: "ready" }                       — мост установлен (родитель может слать команды);
//                     { proto, evt: "state", state: {...} }         — снимок: объект, режим 2D/3D, загрузка, ошибка, счётчики, выбор;
//                     { proto, evt: "filters", model: {...} }       — модель фильтров (группы → значения → включено/доступно/число);
//                     { proto, evt: "filtered-ids", ids, objectId } — id элементов, прошедших текущий фильтр схемы (charts: снимок для отчётов V2);
//                     { proto, evt: "search-result", text, total, items } — результат поиска по марке/адресу;
//                     { proto, evt: "notice", message }             — сообщение движка (то, что V1 показал бы в строке состояния);
//                     { proto, evt: "cmd-error", cmd, message }     — команда отклонена (неверные параметры/состояние).
//   родитель → кадр:  { proto, cmd, args } — команды из БЕЛОГО СПИСКА ниже; параметры проверяются по типам, HTML и код не принимаются.
//   setObject{objectId} · setView{mode:"2d"|"3d"|"3d-light"} · fit · zoom{factor} · select{id|null} · locate{id} · clearSelection ·
//   setFilter{changes:[{key,values,on}]} · resetFilters · setZoneVisible{category,on} · setExternalVisible{kind:"models"|"facades",on} · setLabelVisible{type,part:"label"|"dates",on} · search{text} · getFilters · getFilteredIds · refreshElement{id} · reload; МФР (ws=mfr): mfrPick{kind,id} · mfrCategory{category,on} · mfrLayer{layer,on} · mfrReset · mfrSelect{kind,id,additive}; комплектовщик (ws=picker): pickerToggle{key,value} · pickerSet{key,values,on} · pickerClear{key|null} · pickerMetric{key,on} · pickerHighlight{on} · pickerCandidates{elementType,mark} · pickerSelectIds{ids} · applyElements{items}; события picker{model}, candidates{items}
//   операции над изделиями (все рабочие места ЖБИ): getContracts (ответ — событие contracts{objectId,items}) · applyElements{items} (ЖБИ, кроме комплектовщика: у него свой) · patchComment{id,comment};
//   в 2D (не МФР, не комплектовщик) Ctrl/⌘ + щелчок по изделию добавляет его к выбору или убирает из выбора.
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
  // Легенда «Статус по элементам» (V1 renderLegend): статус × тип по показанным элементам; типы — по алфавиту, как в V1
  function statusByTypeShown() {
    const m = new Map(), types = new Set();
    for (const e of state.elements) {
      if (!passesPlacementFilters(e)) continue;
      types.add(e.element_type);
      if (!m.has(e.current_status)) m.set(e.current_status, new Map());
      const byType = m.get(e.current_status);
      byType.set(e.element_type, (byType.get(e.element_type) || 0) + 1);
    }
    return { types: Array.from(types).sort((a, b) => String(a).localeCompare(String(b), "ru")),
      rows: Array.from(m, ([status, byType]) => [status, Array.from(byType)]) };
  }
  function snapshot() {
    const base = snapshotBase();
    if (PICKER) return { ...base, excluded: pickerSelCount() };
    if (!MFR) return base;
    const m = mfrSnapshot();
    return { ...base, mfr: m, hasDrawing: m.hasModel, view: m.mode, loading: !m.hasData && !mfrError, loaded: m.hasData && !mfrError, error: mfrError,
      total: m.elements, shown: m.elements, selected: null, selectedId: null, multi: null, multiIds: [], excluded: m.filtersActive,
      statusCounts: [], zones: [] };
  }
  function snapshotBase() {
    const cur = (typeof currentObject === "function") ? currentObject() : null;
    const multi = Array.from(state.multiSelectedIds);
    const present = new Set(state.zones.map((z) => z.category));
    return {
      selected: state.selectedId === null ? null : elementInfo(state.byId.get(state.selectedId)),
      multi: multi.length ? multiSummary(multi) : null,
      statusCounts: statusCountsShown(),
      statusByType: statusByTypeShown(),
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
      // состав выделения рамкой (для проверки перед распределением): только скаляры, не больше 3000 элементов
      multiItems: state.multiSelectedIds.size <= 3000 ? Array.from(state.multiSelectedIds).map((id) => {
        const e = state.byId.get(id);
        return e ? { id, mark: e.mark ?? null, element_type: e.element_type, current_status: e.current_status, contract_id: e.contract_id ?? null,
          planned_delivery_date: e.planned_delivery_date ?? null } : null;
      }).filter(Boolean) : null,
      excluded: excludedCount(),
      // Внешние 3D-модели объекта в сцене ЖБИ (флажки окна V1 «Внешний вид»: благоустройство, фасады из FBX)
      external: { models: extChecked("zhbi-show-external-models"), facades: extChecked("zhbi-show-external-facades") },
      // Сеансовые «Подписи» (окно V1 «Настройки → Вид»): по типу изделия — показ подписи и её допстроки «Даты»
      labels: labelToggles(),
    };
  }
  function extChecked(id) { const c = document.getElementById(id); return c ? c.checked : true; }
  function labelToggles() {
    return Array.from(document.querySelectorAll("#label-toggles input[data-type]")).map((c) => {
      const d = document.querySelector(`#label-toggles input[data-dates-type="${CSS.escape(c.dataset.type)}"]`);
      return { type: c.dataset.type, on: c.checked, dates: d ? d.checked : null };
    });
  }

  let stateTimer = null;
  function scheduleState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; post({ evt: "state", state: snapshot() }); }, 40);
  }


  // ---------------- рабочее место МФР (ws=mfr): модель Revit — план 2D/3D, этажи, секции, категории, блоки ----------------
  // Логику отбора и выбора ведёт движок V1 (revitPlanState, обработчики кликов); мост читает его состояние и вызывает те же обработчики.
  const MFR = EMBED_QUERY.get("ws") === "mfr";
  let mfrError = null;
  const byId = (i) => document.getElementById(i);
  const MFR_LAYERS = { elements: "mfr-show-elements", blocks: "mfr-show-blocks", axes: "mfr-show-axes", facades: "mfr-show-facades",
    externalFacades: "mfr-show-external-facades", plans: "mfr-show-plans", externalModels: "mfr-show-external-models" };
  const num = (t) => Number(String(t || "").replace(/\s/g, "")) || 0;
  function mfrPickList(boxId, kind) {
    return Array.from(byId(boxId)?.querySelectorAll(`.revit-pick[data-kind="${kind}"]`) || []).map((el) => {
      const span = el.querySelector("span");
      const label = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
      return { id: el.dataset.id, label: label || el.dataset.id, count: span ? num(span.textContent) : 0, on: el.classList.contains("revit-pick-on"),
        title: el.title || "", warn: el.textContent.includes("⚠") };
    });
  }
  function mfrSnapshot() {
    const st = revitPlanState;
    const hasData = !!st.data && st.objectId === state.objectId;
    const cats = Array.from(document.querySelectorAll("#mfr-elements-categories input[data-mfr-category]")).map((cb) => {
      const sp = cb.parentElement.querySelector("span");
      // disabled — «Элементы» выключены (V1 syncMfrElementCategoriesDisabled); color — цвет категории на плане (легенда V1 revit-plan-legend)
      const color = typeof revitFill === "function" ? revitFill(cb.dataset.mfrCategory) : null;
      return { category: cb.dataset.mfrCategory, label: cb.dataset.mfrCategory || "(без категории)", count: sp ? num(sp.textContent) : 0, on: cb.checked, disabled: cb.disabled, color: /^#[0-9a-fA-F]{3,8}$|^rgb|^hsl/.test(String(color || "")) ? String(color) : null };
    });
    const layers = Object.entries(MFR_LAYERS).map(([key, id]) => {
      const cb = byId(id);
      return cb ? { key, on: cb.checked, disabled: cb.disabled, label: cb.parentElement.textContent.replace(/\s+/g, " ").trim() } : null;
    }).filter(Boolean);
    const sel = st.selected ? { kind: st.selected.kind, id: st.selected.id } : null;
    return {
      hasData, hasModel: !/ещё не загружались/.test(byId("revit-plan-head")?.textContent || ""), head: (byId("revit-plan-head")?.textContent || "").trim(), status: (byId("revit-plan-status")?.textContent || "").trim(),
      truncated: !!(st.data && st.data.truncated),
      elements: hasData && st.data.elements ? st.data.elements.length : 0,
      blocks: hasData ? (st.blocksData || []).filter((b) => b.ok).length : 0,
      levels: mfrPickList("revit-plan-levels", "level"), sections: mfrPickList("revit-plan-sections", "section"), categories: cats, layers,
      selected: sel, selectedBlocks: Array.from(st.selectedBlocks || []),
      filtersActive: (st.levels?.size || 0) + (st.sections?.size || 0) + (st.categories?.size || 0),
      mode: (document.querySelector("#mfr-view-switch .view-mode-btn.active")?.dataset.mfrMode) || "2d",
      // шахматка (раскраска блоков по доске) и динамика факта за период: состояние ведёт движок, мост его отдаёт (панель МФР в V2)
      chess: { tracks: (typeof mfrChessTracks !== "undefined" ? mfrChessTracks : []).map((t) => ({ code: t["код"], name: t["название"] })),
        track: typeof mfrChessTrackCode !== "undefined" ? mfrChessTrackCode : null, mode: typeof mfrChessMode !== "undefined" ? mfrChessMode : "progress",
        deadlineColors: typeof MFR_CHESS_DEADLINE_HEX !== "undefined" ? { ...MFR_CHESS_DEADLINE_HEX } : {} },
      dynamics: typeof mfrDynamics !== "undefined" ? { active: !!mfrDynamics.active, from: mfrDynamics.from || null, to: mfrDynamics.to || null, blocks: typeof mfrDynamicsBlocks !== "undefined" ? mfrDynamicsBlocks.size : 0 } : { active: false, from: null, to: null, blocks: 0 },
    };
  }


  // ---------------- рабочее место комплектовщика (ws=picker): срезы, показатели, контракты ----------------
  // Отбор ведёт движок (state.picker.sel/metrics + pickerElementPasses, он же режет схему); мост считает те же числа теми же функциями.
  const PICKER = EMBED_QUERY.get("ws") === "picker";
  const PICKER_KEYS = () => PICKER_SLICERS.map((d) => d.key);
  function pickerModel() {
    const P = state.picker;
    const base = state.elements.filter((e) => pickerElementPasses(e, "__metric__"));
    const slicers = PICKER_SLICERS.filter((d) => d.key !== "contract").map((def) => {
      const counts = new Map();
      for (const e of state.elements) {
        const v = def.valueFn(e);
        if (!counts.has(v)) counts.set(v, 0);
        if (pickerElementPasses(e, def.key)) counts.set(v, counts.get(v) + 1);
      }
      const sel = P.sel[def.key];
      const values = Array.from(new Set([...counts.keys(), ...sel]));
      values.sort(placementComparator(def.labelFor, { compareRaw: !!def.compareRaw }));
      const cs = pickerContractedFor(def.key, null) !== null;
      return {
        key: def.key, title: def.title, selected: sel.size, contractedShown: cs,
        rows: values.map((v) => {
          const count = counts.get(v) || 0;
          const contracted = cs ? (pickerContractedFor(def.key, v) || 0) : null;
          return { v, label: def.labelFor(v), count, contracted, on: sel.has(v), available: count > 0 || sel.has(v) };
        }),
      };
    });
    const metrics = PICKER_METRICS.map((m) => {
      if (m.key === "contracted") {
        const c = pickerContracted();
        return { key: m.key, title: m.title, hint: m.hint, status: m.status || null, value: c.value, reason: c.reason || null,
          skippedNoMark: c.skippedNoMark || 0, base: base.length, clickable: false, on: false };
      }
      const count = m.test ? base.filter(m.test).length : base.length;
      return { key: m.key, title: m.title, hint: m.hint, status: m.status || null, value: count, base: base.length,
        share: m.test && base.length ? Math.round((count / base.length) * 100) : null, clickable: !!m.test, on: P.metrics.has(m.key) };
    });
    // Контракты: «всего» — из позиций контракта, «привязано» — по элементам, прошедшим ОСТАЛЬНЫЕ срезы (как в панели V1)
    const sel = P.sel.contract;
    const totals = pickerContractTotals();
    const linked = new Map(); const keysSlice = new Set();
    let unlinked = 0;
    for (const e of state.elements) {
      if (!pickerElementPasses(e, "contract")) continue;
      const mk = markKey(e.mark), tk = typeKey(e.element_type);
      if (mk) keysSlice.add(mk);
      if (tk) keysSlice.add(tk);
      if (!e.contract_id) { unlinked++; continue; }
      linked.set(e.contract_id, (linked.get(e.contract_id) || 0) + 1);
    }
    const lineKeys = new Map();
    for (const line of state.contractLineTotals) {
      if (!lineKeys.has(line.contract_id)) lineKeys.set(line.contract_id, new Set());
      const k = pickerLineKey(line);
      if (k) lineKeys.get(line.contract_id).add(k);
    }
    const inSlice = (id) => {
      if (sel.has(id) || (linked.get(id) || 0) > 0) return true;
      const ks = lineKeys.get(id);
      if (!ks || !ks.size) return false;
      for (const k of ks) if (keysSlice.has(k)) return true;
      return false;
    };
    const groups = new Map();
    for (const c of activeContracts()) {
      const key = c.counterparty_short_name || placementNoneLabel("supplier");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    // Позиции контрактов по маркам (разворот контракта, как в V1: buildContractMarkRows) и марки изделий без контракта (buildNoContractMarkRows).
    // Привязано по позиции — по изделиям, прошедшим остальные срезы, БЕЗ отбора по контракту/марке/типу (РАЗВОРОТ_БЕЗ): разворот обязан оставаться
    // полным, чтобы к отбору можно было добавить вторую марку. «Чужие» марки (привязаны мимо спецификации) — по ВСЕМ изделиям контракта.
    const posLinked = new Map();      // contract_id -> Map(ключ позиции -> число)
    const orphanBy = new Map();       // contract_id -> Map(ключ -> {mark, element_type, count})
    const noneMarks = new Map();      // подпись -> {label, mark, type, n}
    for (const e of state.elements) {
      const passesExp = pickerElementPasses(e, РАЗВОРОТ_БЕЗ);
      if (!e.contract_id) {
        if (!passesExp) continue;
        const label = e.mark || `${e.element_type || "тип не определён"} · без марки`;
        if (!noneMarks.has(label)) noneMarks.set(label, { label, mark: e.mark || null, type: e.element_type || null, n: 0 });
        noneMarks.get(label).n += 1;
        continue;
      }
      const ks = lineKeys.get(e.contract_id) || new Set();
      const mk = markKey(e.mark), tk = typeKey(e.element_type);
      const fb = mk || tk;
      if (fb && !ks.has(fb)) {
        if (!orphanBy.has(e.contract_id)) orphanBy.set(e.contract_id, new Map());
        const m = orphanBy.get(e.contract_id);
        if (m.has(fb)) m.get(fb).count += 1; else m.set(fb, { mark: e.mark, element_type: e.element_type, count: 1 });
      }
      if (passesExp) {
        const key = ks.has(mk) ? mk : (ks.has(tk) ? tk : mk);
        if (key) { if (!posLinked.has(e.contract_id)) posLinked.set(e.contract_id, new Map()); const m = posLinked.get(e.contract_id); m.set(key, (m.get(key) || 0) + 1); }
      }
    }
    const linesOf = (c) => {
      const lines = state.contractLineTotals.filter((l) => l.contract_id === c.id);
      const lp = posLinked.get(c.id) || new Map();
      const rows = lines.map((l) => {
        const key = pickerLineKey(l) || PLACEMENT_NONE, total = l.quantity || 0, lk = lp.get(key) || 0;
        return { label: l.mark || `${l.element_type || "тип не определён"} · без марки`, mark: l.mark || null, type: l.element_type || null, total, linked: lk, remainder: total - lk,
          orphan: false, over: total - lk < 0, on: l.mark ? P.sel.mark.has(l.mark) : P.sel.elementType.has(l.element_type) };
      });
      for (const [, o] of orphanBy.get(c.id) || []) {
        rows.push({ label: o.mark || `${o.element_type || "тип не определён"} · без марки`, mark: o.mark || null, type: o.element_type || null, total: null, linked: o.count, remainder: null,
          orphan: true, over: true, on: o.mark ? P.sel.mark.has(o.mark) : P.sel.elementType.has(o.element_type) });
      }
      rows.sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true }));
      return rows;
    };
    const contracts = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "ru", { numeric: true })).map((name) => {
      const list = groups.get(name).slice().sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
      const rows = list.map((c) => {
        const total = totals.get(c.id) || 0, lk = linked.get(c.id) || 0;
        return { id: c.id, label: [c.agreement_number, c.specification_number, c.theme].filter(Boolean).join(" · ") || c.name, name: c.name,
          total, linked: lk, remainder: total - lk, inSlice: inSlice(c.id), on: sel.has(c.id), over: contractHasOverflow(c.id), lines: linesOf(c) };
      });
      return { name, rows, total: rows.reduce((a, r) => a + r.total, 0), linked: rows.reduce((a, r) => a + r.linked, 0),
        inSlice: rows.some((r) => r.inSlice), over: rows.some((r) => r.over) };
    });
    // Срез сужен свойством изделия — «привязано» и «остаток» считаются внутри среза, «всего» остаётся документальным (V1: оговорка в шапке области)
    const narrowed = PICKER_SLICERS.some((d) => d.key !== "contract" && P.sel[d.key].size) || P.metrics.size > 0;
    return {
      slicers, metrics, contracts, unlinked, unlinkedOn: sel.has(PLACEMENT_NONE), contractSelected: sel.size,
      selectionActive: pickerSelectionActive(), base: base.length,
      highlightUnlinked: !!P.highlightUnlinked, noneValue: PLACEMENT_NONE,
      highlightCount: state.pendingLinkIds ? state.pendingLinkIds.size : 0, narrowed, positionSelected: P.sel.mark.size + P.sel.elementType.size, metricsSelected: P.metrics.size,
      noneMarks: Array.from(noneMarks.values()).sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true }))
        .map((m) => ({ ...m, on: m.mark ? P.sel.mark.has(m.mark) : P.sel.elementType.has(m.type) })),
    };
  }
  const pickerSelCount = () => PICKER_SLICERS.reduce((n, d) => n + state.picker.sel[d.key].size, 0) + state.picker.metrics.size;
  let pickerTimer = null;
  function sendPicker() {
    if (!PICKER || pickerTimer) return;
    pickerTimer = setTimeout(() => {
      pickerTimer = null;
      try { post({ evt: "picker", model: pickerModel() }); } catch (e) { post({ evt: "cmd-error", cmd: "picker", message: String((e && e.message) || e) }); }
    }, 90);
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
      scheduleState(); sendFilters(); sendPicker();
    }
  });
  if (MFR) {
    // Карточку элемента/блока рисует панель V2 (читает те же GET-ы), поэтому в кадре сами карточки не строятся: только выбор и подсветка
    globalThis.showRevitCard = async function (id) {
      revitPlanState.selected = { kind: "element", id: Number(id) }; mfrHighlightSelection(); scheduleState();
    };
    globalThis.renderBlockCard = async function (id) {
      revitPlanState.selected = { kind: "block", id: Number(id) }; updateBlockGroupUi(); mfrHighlightSelection(); scheduleState();
    };
    wrap("revitPlanStatus", (orig) => function (text, isError) { mfrError = isError ? String(text) : null; scheduleState(); return orig.apply(this, arguments); });
    wrap("loadRevitPlanElements", (orig) => async function () { try { return await orig.apply(this, arguments); } finally { scheduleState(); } });
    wrap("clearBlockSelection", (orig) => function () { const r = orig.apply(this, arguments); scheduleState(); return r; });
    wrap("applyMfrMode", (orig) => function () { const r = orig.apply(this, arguments); scheduleState(); return r; });
  }
  wrap("applyPlacementFilters", (orig) => function () { const r = orig.apply(this, arguments); scheduleState(); sendPicker(); return r; });
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
    let sig = state.objectId + "|" + state.elements.length + "|" + state.selectedId + "|" + state.multiSelectedIds.size + "|"
      + Array.from(state.multiSelectedIds).slice(0, 40).join(",");
    if (PICKER) sig += "|p|" + pickerSelCount();
    if (MFR) {
      const st = revitPlanState;
      sig += "|m|" + st.objectId + "|" + (st.data ? st.data.elements.length : -1) + "|" + (st.selected ? st.selected.kind + st.selected.id : "") + "|"
        + Array.from(st.selectedBlocks || []).join(",") + "|" + st.levels.size + "|" + st.sections.size + "|" + st.categories.size;
    }
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
      // как locateElementOnPlan в V1: жёлтая обводка поверх выделения и предупреждение, если изделие скрыто фильтром
      if (typeof markLocated === "function") markLocated(el.id);
      if (state.view3d.active) focus3DOnElement(el); else focus2DOnElement(el);
      if (typeof passesPlacementFilters === "function" && !passesPlacementFilters(el)) showToast("Изделие скрыто текущим фильтром рабочей области", "warning");
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
    // Показ внешних 3D-моделей объекта (благоустройство / фасады из FBX) — те же флажки документа V1 и их обработчики
    // (как в V1: действует на эту загрузку схемы, не сохраняется).
    setExternalVisible(a) {
      if (!["models", "facades"].includes(a.kind) || typeof a.on !== "boolean") throw new Error("параметры внешней модели");
      const c = document.getElementById(a.kind === "models" ? "zhbi-show-external-models" : "zhbi-show-external-facades");
      if (!c) throw new Error("нет переключателя внешней модели");
      if (c.checked !== a.on) { c.checked = a.on; c.dispatchEvent(new Event("change")); }
      scheduleState();
    },
    // Сеансовые «Подписи» по типу изделия и их допстрока «Даты» — те же флажки окна V1 и их обработчики (каскад «тип → даты»,
    // прореживание по коллизиям); как в V1, действует до перезагрузки схемы и не сохраняется.
    setLabelVisible(a) {
      if (typeof a.type !== "string" || a.type.length > 120 || !["label", "dates"].includes(a.part) || typeof a.on !== "boolean") throw new Error("параметры подписи");
      const attr = a.part === "label" ? "data-type" : "data-dates-type";
      const c = document.querySelector(`#label-toggles input[${attr}="${CSS.escape(a.type)}"]`);
      if (!c) throw new Error("нет такого типа подписи");
      if (c.disabled) throw new Error("«Даты» недоступны, пока подпись типа скрыта");
      if (c.checked !== a.on) { c.checked = a.on; c.dispatchEvent(new Event("change")); }
      scheduleState();
    },
    // Поиск по марке/адресу среди ПОКАЗАННЫХ на схеме элементов (те, что убрал фильтр, не ищутся); ответ — событие search-result
    search(a) {
      if (typeof a.text !== "string" || a.text.length > 60) throw new Error("text");
      const q = a.text.trim().toLowerCase();
      const items = []; let total = 0;
      if (q) {
        for (const e of state.elements) {
          if (!passesPlacementFilters(e)) continue;
          if (!(String(e.mark || "").toLowerCase().includes(q) || String(e.address || "").toLowerCase().includes(q))) continue;
          total++;
          if (items.length < 30) items.push({ id: e.id, mark: e.mark, type: e.element_type, status: e.current_status, address: e.address });
        }
      }
      post({ evt: "search-result", text: a.text, total, items });
    },
    getFilters() { sendFilters(); scheduleState(); },
    // Список id элементов, прошедших ТЕКУЩИЙ фильтр схемы (charts, 2026-09-22) — снимок для отчётов V2
    // («Учитывать текущий фильтр схемы», как в V1: state.elements.filter(passesPlacementFilters).map(e => e.id)).
    // Оболочка запрашивает это ТОЛЬКО когда меняется сама модель фильтра (после evt:"filters"), не на каждый тик
    // состояния — список из тысяч чисел не стоит гонять чаще, чем меняется отбор. Предел 20000 — заведомо больше
    // числа элементов на любом объекте этого сервиса, только защита от неожиданно огромного ответа.
    getFilteredIds() {
      const ids = [];
      for (const e of state.elements) { if (passesPlacementFilters(e)) { ids.push(e.id); if (ids.length >= 20000) break; } }
      post({ evt: "filtered-ids", ids, objectId: state.objectId });
    },
    // Мини-отчёты вкладки «Статус» считают только изделия, показанные в
    // текущем рабочем месте. У комплектовщика своя модель среза, поэтому
    // passesPlacementFilters здесь дал бы неверные числа.
    getReportIds() {
      if (MFR) throw new Error("отчёты ЖБИ недоступны в рабочем месте МФР");
      const ids = [];
      for (const e of state.elements) {
        if (PICKER ? pickerElementPasses(e, "__metric__") : passesPlacementFilters(e)) {
          ids.push(e.id);
          if (ids.length >= 20000) break;
        }
      }
      post({ evt: "report-ids", ids, objectId: state.objectId });
    },
    // После записи, выполненной оболочкой V2: заново читает ОДИН элемент с сервера (GET) и применяет его штатным
    // точечным обновлением V1 (заливка 2D/3D, счётчики, фильтры). Показывается то, что подтвердил сервер, а не то, что ввёл человек.
    async refreshElement(a) {
      if (!isInt(a.id)) throw new Error("id");
      const r = await fetch(`/elements/${a.id}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("не удалось прочитать элемент (" + r.status + ")");
      const fresh = await r.json();
      const changed = applyElementDelta(fresh);
      if (changed) { renderLegend(); applyPlacementFilters(); }
      scheduleState(); sendFilters();
      post({ evt: "refreshed", id: a.id, changed });
    },
    async reload() { await loadPlan(true); },
  };

  // Команды операций над изделиями (модель ЖБИ, АРМ прораба; те же безопасны и для комплектовщика): кадр по-прежнему только читает,
  // изменения выполняет оболочка через шлюз записи, а здесь лишь применяется то, что подтвердил сервер.
  const COMMANDS_EL = {
    // Контракты выбранного объекта (то, что движок получил вместе со схемой): только скаляры, для выбора контракта в оболочке
    getContracts() {
      const items = (state.contracts || []).filter((c) => c && isInt(c.id)).slice(0, 2000).map((c) => {
        const o = {};
        for (const k of ["id", "name", "theme", "specification_id", "specification_number", "specification_date", "agreement_id", "agreement_number",
          "agreement_date", "counterparty_id", "counterparty_short_name", "counterparty_code"]) {
          const v = c[k]; if (v === null || typeof v === "string" || typeof v === "number") o[k] = v;
        }
        o.is_archived = !!c.is_archived;
        return o;
      });
      post({ evt: "contracts", objectId: state.objectId, items });
    },
    // Применить к схеме то, что подтвердил сервер (ответ операции): известные скалярные поля статуса/контракта/дат и комментарий
    applyElements(a) {
      if (!Array.isArray(a.items) || a.items.length > 3000) throw new Error("items");
      let changed = 0;
      for (const it of a.items) {
        if (!it || !isInt(it.id)) throw new Error("item");
        const fresh = { id: it.id };
        for (const f of DELTA_FIELDS) {
          if (!(f in it)) continue;
          const v = it[f];
          if (!(v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) throw new Error("поле " + f);
          fresh[f] = v;
        }
        if (applyElementDelta(fresh)) changed++;
      }
      if (changed) { clearContractPositionsCache(); renderLegend(); applyPlacementFilters(); }
      scheduleState(); sendFilters();
      post({ evt: "refreshed", changed });
    },
    // Комментарий изделия после подтверждённой сервером записи (в наборе полей дельты его нет)
    patchComment(a) {
      if (!isInt(a.id) || !(a.comment === null || (typeof a.comment === "string" && a.comment.length <= 2000))) throw new Error("параметры");
      const e = state.byId.get(a.id);
      if (!e) throw new Error("элемента нет на схеме");
      e.comment = a.comment;
      scheduleState();
    },
  };
  if (!MFR) Object.assign(COMMANDS, COMMANDS_EL);

  // Ctrl/⌘ + щелчок по изделию на плане (2D): добавляет его к выделению или убирает из него (V1 умел только убирать, и только из рамки).
  // Перехват на этапе захвата: обработчик V1 на том же узле после этого не вызывается. Рабочее место комплектовщика не затрагивается.
  if (!MFR && !PICKER) {
    const root = document.getElementById("svg-root");
    if (root) root.addEventListener("click", (e) => {
      if (!(e.ctrlKey || e.metaKey) || (typeof dragMoved !== "undefined" && dragMoved)) return;
      const shape = e.target.closest && e.target.closest(".element-shape");
      if (!shape) return;
      const el = state.byId.get(Number(shape.getAttribute("data-id")));
      if (!el) return;
      e.stopImmediatePropagation();
      const ids = new Set(state.multiSelectedIds);
      if (ids.size === 0 && state.selectedId !== null && state.selectedId !== el.id) ids.add(state.selectedId);   // уже выбранное одиночно — часть группы
      if (ids.has(el.id)) ids.delete(el.id); else ids.add(el.id);
      setMultiSelection(ids);
      scheduleState();
    }, true);
  }

  // Команды МФР. Обращения к элементам — только по фиксированным идентификаторам и проверенным значениям.
  const isIds = (x) => typeof x === "string" && /^\d+(,\d+)*$/.test(x);
  if (MFR) Object.assign(COMMANDS, {
    setView(a) {
      if (!["2d", "3d"].includes(a.mode)) throw new Error("mode");
      const b = document.querySelector(`#mfr-view-switch [data-mfr-mode="${a.mode}"]`);
      if (!b) throw new Error("режим недоступен");
      b.click();
    },
    fit() { (viewMode2() === "3d" ? byId("mfr-3d-zoom-reset") : byId("revit-plan-fit")).click(); scheduleState(); },
    zoom(a) {
      const f = Number(a.factor);
      if (!(f > 0.1 && f < 10)) throw new Error("factor");
      if (viewMode2() === "3d") {
        if (!mfr3d.camera || !mfr3d.controls) return;
        const off = mfr3d.camera.position.clone().sub(mfr3d.controls.target).multiplyScalar(f);
        mfr3d.camera.position.copy(mfr3d.controls.target).add(off);
        mfr3d.controls.update();
      } else {
        const v = revitPlanState.view;
        if (!v || !revitPlanState.applyView) return;
        const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
        v.w *= f; v.h *= f; v.x = cx - v.w / 2; v.y = cy - v.h / 2;
        revitPlanState.applyView();
      }
    },
    mfrPick(a) {
      if (!["level", "section"].includes(a.kind) || !isIds(a.id)) throw new Error("параметры");
      const box = byId(a.kind === "level" ? "revit-plan-levels" : "revit-plan-sections");
      const el = Array.from(box?.querySelectorAll(".revit-pick") || []).find((x) => x.dataset.kind === a.kind && x.dataset.id === a.id);
      if (!el) throw new Error("значения нет в списке");
      el.click();
    },
    mfrCategory(a) {
      if (typeof a.category !== "string" || a.category.length > 200 || typeof a.on !== "boolean") throw new Error("параметры");
      const cb = Array.from(document.querySelectorAll("#mfr-elements-categories input[data-mfr-category]")).find((x) => x.dataset.mfrCategory === a.category);
      if (!cb) throw new Error("категории нет в списке");
      if (cb.checked !== a.on) { cb.checked = a.on; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    },
    mfrLayer(a) {
      if (!Object.prototype.hasOwnProperty.call(MFR_LAYERS, a.layer) || typeof a.on !== "boolean") throw new Error("параметры");
      const cb = byId(MFR_LAYERS[a.layer]);
      if (!cb) throw new Error("слоя нет");
      if (cb.checked !== a.on) { cb.checked = a.on; cb.dispatchEvent(new Event("change", { bubbles: true })); }
      scheduleState();
    },
    mfrReset() { byId("mfr-reset-all-filters").click(); },
    // Шахматка: раскраска плана по доске (группе видов работ одного трека) — {track: код доски | null, mode: "progress" | "deadline"}
    async mfrChess(a) {
      if (!(a.track === null || (typeof a.track === "string" && a.track.length <= 40)) || !["progress", "deadline"].includes(a.mode)) throw new Error("параметры");
      if (a.track !== null && !mfrChessTracks.some((t) => t["код"] === a.track)) throw new Error("доски нет в списке");
      const radio = document.querySelector(`input[name="mfr-chess-mode"][value="${a.mode}"]`);
      if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
      if (a.track !== mfrChessTrackCode || a.refresh === true) await selectMfrChessTrack(a.track);
      else if (a.track) { renderMfrChessLegend(); }
      scheduleState();
    },
    // Динамика факта за период: подсветка блоков, где факт менялся в периоде — {on, from, to} (пустые даты — «за весь период»)
    async mfrDynamics(a) {
      const okDate = (d) => d === null || d === "" || (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (typeof a.on !== "boolean" || !okDate(a.from ?? null) || !okDate(a.to ?? null)) throw new Error("параметры");
      mfrDynamics.active = a.on; mfrDynamics.from = a.from || null; mfrDynamics.to = a.to || null;
      await reloadMfrDynamics();
      scheduleState();
    },
    mfrSelect(a) {
      if (!["element", "block"].includes(a.kind) || !isInt(a.id)) throw new Error("параметры");
      return a.kind === "element" ? showRevitCard(a.id) : showBlockCard(a.id, a.additive === true);
    },
    clearSelection() { revitPlanState.selectedBlocks.clear(); revitPlanState.selected = null; updateBlockGroupUi(); mfrHighlightSelection(); scheduleState(); },
    locate() { /* в модели МФР показ на плане не поддержан: элемент виден на плане и подсвечен */ },
    resetFilters() { byId("mfr-reset-all-filters").click(); },
    getFilters() { scheduleState(); },
    search() { post({ evt: "search-result", text: "", total: 0, items: [] }); },
  });
  if (PICKER) Object.assign(COMMANDS, {
    pickerToggle(a) {
      if (!PICKER_KEYS().includes(a.key) || !isVal(a.value)) throw new Error("параметры");
      const set = state.picker.sel[a.key];
      if (set.has(a.value)) set.delete(a.value); else set.add(a.value);
      onPickerChange();
    },
    pickerSet(a) {
      if (!PICKER_KEYS().includes(a.key) || !Array.isArray(a.values) || a.values.length > 500 || !a.values.every(isVal) || typeof a.on !== "boolean") throw new Error("параметры");
      const set = state.picker.sel[a.key];
      for (const v of a.values) { if (a.on) set.add(v); else set.delete(v); }
      onPickerChange();
    },
    pickerClear(a) {
      if (a.key === null || a.key === undefined) { for (const k of PICKER_KEYS()) state.picker.sel[k].clear(); state.picker.metrics.clear(); }
      else if (PICKER_KEYS().includes(a.key)) state.picker.sel[a.key].clear();
      else throw new Error("key");
      onPickerChange();
    },
    pickerMetric(a) {
      if (!PICKER_METRICS.some((m) => m.key === a.key && m.test) || typeof a.on !== "boolean") throw new Error("параметры");
      if (a.on) state.picker.metrics.add(a.key); else state.picker.metrics.delete(a.key);
      onPickerChange();
    },
    pickerHighlight(a) {
      if (typeof a.on !== "boolean") throw new Error("on");
      state.picker.highlightUnlinked = a.on;
      onPickerChange();
    },
    // Кандидаты на распределение: изделия ОДНОЙ позиции (тип + марка) объекта — их id и текущий статус/контракт (всё остальное не отдаётся)
    pickerCandidates(a) {
      if (typeof a.elementType !== "string" || a.elementType.length > 200 || !(a.mark === null || (typeof a.mark === "string" && a.mark.length <= 200))) throw new Error("параметры");
      const key = markKey(a.mark), tk = typeKey(a.elementType);
      const items = [];
      for (const e of state.elements) {
        if (typeKey(e.element_type) !== tk || markKey(e.mark) !== key) continue;
        items.push([e.id, e.current_status, e.contract_id ?? null]);
        if (items.length >= 5000) break;
      }
      post({ evt: "candidates", elementType: a.elementType, mark: a.mark, items });
    },
    pickerSelectIds(a) {
      if (!Array.isArray(a.ids) || a.ids.length > 3000 || !a.ids.every(isInt)) throw new Error("ids");
      setMultiSelection(new Set(a.ids.filter((id) => state.byId.has(id))));
      scheduleState();
    },
    // Применить к схеме то, что подтвердил сервер (ответ PATCH): только известные скалярные поля, только существующие на схеме изделия
    applyElements(a) {
      if (!Array.isArray(a.items) || a.items.length > 3000) throw new Error("items");
      let changed = 0;
      for (const it of a.items) {
        if (!it || !isInt(it.id)) throw new Error("item");
        const fresh = { id: it.id };
        for (const f of DELTA_FIELDS) {
          if (!(f in it)) continue;
          const v = it[f];
          if (!(v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) throw new Error("поле " + f);
          fresh[f] = v;
        }
        if (applyElementDelta(fresh)) changed++;
      }
      if (changed) { clearContractPositionsCache(); renderLegend(); applyPlacementFilters(); }
      scheduleState(); sendFilters(); sendPicker();
      post({ evt: "refreshed", changed });
    },
    resetFilters() { for (const k of PICKER_KEYS()) state.picker.sel[k].clear(); state.picker.metrics.clear(); onPickerChange(); },
    getFilters() { sendPicker(); scheduleState(); },
  });
  function viewMode2() { return (document.querySelector("#mfr-view-switch .view-mode-btn.active")?.dataset.mfrMode) || "2d"; }

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
  if (loadedOnce) { sendFilters(); sendPicker(); }
})();
