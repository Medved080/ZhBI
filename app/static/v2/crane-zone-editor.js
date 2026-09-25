// Цельный редактор редакции кранов и стоянок: дерево → схема → свойства.
// Все изменения до публикации живут только в локальном/серверном черновике.
import { esc } from "./screen-view.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";
import { displacedEdgeEndpoints, nearestEdgeIndex } from "./zone-edge-geometry.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const errText = (e) => String(e?.detail || e?.message || e);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const WHEEL_SENSITIVITY = 0.00065;
const BUTTON_ZOOM_STEP = 1.1;

export function mountCraneZoneEditor(root, { objectId, api, canEdit, onPublished, initialCategory = "Кран" }) {
  const standFocus = initialCategory === "Стоянка";
  const prefix = `/objects/${objectId}/crane-zone-versions`;
  let dead = false, busy = false, drawing = false, selectMode = false;
  let versions = [], drafts = [], draft = null, scene = [], currentScene = [], selectedZone = null;
  let selectedVersionId = null;
  let selectedElements = new Set(), dirty = false, preview = null, message = "";
  let effectiveDate = today();
  let view = null, fitScale = null, viewWidth = 0, viewHeight = 0;
  let drag = null, hoverEdge = null, activeLevel = 0;
  let canvasResizeObserver = null;
  const $ = (s) => root.querySelector(s);

  function currentVersion() { return versions.find((v) => v.activated_at) || versions[0]; }
  function displayVersion() { return versions.find((v) => v.id === selectedVersionId) || currentVersion(); }
  function zones() { return draft?.zones || displayVersion()?.zones || []; }
  function visibleZones() { return standFocus ? zones() : zones().filter((z) => z.category === "Кран"); }
  function firstZoneId() { return zones().find((z) => z.category === initialCategory)?.id ?? zones()[0]?.id ?? null; }
  function zoneById(id) { return zones().find((z) => z.id === id); }
  function selected() { return zoneById(selectedZone); }
  function parentCrane() { const z = selected(); return z?.category === "Кран" ? z : zoneById(z?.parent_zone_id); }
  function markDirty() { dirty = true; preview = null; message = ""; draw(); updateStatus(); }

  function status(text) { message = text; updateStatus(); }
  function updateStatus() {
    const node = $("#cz-status");
    if (node) node.textContent = message || (dirty ? "Есть несохранённые изменения" : draft ? "Черновик сохранён" : selectedVersionId ? "Просмотр сохранённой редакции · координаты изделий текущие" : "Просмотр действующей редакции");
    const save = $("#cz-save");
    if (save) save.disabled = !canEdit || !draft || !dirty || busy;
    const publish = $("#cz-publish");
    if (publish) publish.disabled = !canEdit || !draft || dirty || !preview || busy;
  }

  function treeHtml() {
    const all = zones(), cranes = all.filter((z) => z.category === "Кран");
    return cranes.map((crane) => {
      const stands = standFocus ? all.filter((z) => z.category === "Стоянка" && z.parent_zone_id === crane.id) : [];
      const count = scene.filter((e) => e.zone_crane_id === crane.id).length;
      return `<div class="cz-crane"><button type="button" class="cz-tree-item ${selectedZone === crane.id ? "active" : ""}" data-zone-id="${crane.id}" aria-label="Кран ${esc(crane.name)}, ${standFocus ? `${stands.length} стоянок` : `${count} изделий`}"><span class="cz-tree-icon">▣</span><span>${esc(crane.name)}</span><b>${standFocus ? `${stands.length} ст.` : count}</b></button>
        ${stands.map((stand) => `<button type="button" class="cz-tree-item cz-stand ${selectedZone === stand.id ? "active" : ""}" data-zone-id="${stand.id}"><span class="cz-tree-icon">⌞</span><span>${esc(stand.name)}</span><b>${scene.filter((e) => e.zone_stance_id === stand.id).length}</b></button>`).join("")}
        ${standFocus && !stands.length ? `<p class="cz-parent-hint">Стоянок у этого крана пока нет.</p>` : ""}</div>`;
    }).join("") || `<p class="v2-muted">Кранов пока нет.</p>`;
  }

  function propertyHtml() {
    const z = selected();
    if (!z) return `<div class="cz-empty">Выберите ${standFocus ? "кран или стоянку" : "кран"} в списке либо на схеме.</div>`;
    if (standFocus && z.category === "Кран") return `<div class="cz-prop-head"><span>Кран-владелец</span><strong>${esc(z.name)}</strong></div><p class="cz-hint">Кран выбран для новой стоянки. Его номер и контур редактируются на вкладке «Зоны кранов».</p>`;
    const level = z.levels[activeLevel] || z.levels[0];
    const can = canEdit && !!draft;
    return `<div class="cz-prop-head"><span>${z.category}</span><strong>${esc(z.name)}</strong>${z.category === "Стоянка" ? `<small>В составе крана «${esc(zoneById(z.parent_zone_id)?.name || "не выбран")}»</small>` : standFocus ? `<small>Выбран родитель стоянки. Добавить её можно кнопкой слева.</small>` : ""}</div>
      <label>Номер<input id="cz-number" type="number" min="1" step="1" value="${z.number}" ${can ? "" : "disabled"}></label>
      <label>Название<input id="cz-name" type="text" maxlength="200" value="${esc(z.name)}" ${can ? "" : "disabled"}></label>
      ${z.category === "Стоянка" ? `<label>Кран<select id="cz-parent" ${can ? "" : "disabled"}>${zones().filter((v) => v.category === "Кран").map((c) => `<option value="${c.id}" ${z.parent_zone_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : ""}
      <div class="cz-subtitle">Ярусы и контуры</div>
      <div class="cz-levels">${z.levels.map((l, i) => `<button type="button" class="cz-level ${i === activeLevel ? "active" : ""}" data-level="${i}">${l.elevation_mm == null ? "Без отметки" : `+${l.elevation_mm} мм`} · ${l.outline.length} точек</button>`).join("")}</div>
      ${can ? `<button type="button" class="v2-btn" id="cz-add-level">Добавить ярус</button>` : ""}
      ${level ? `<label>Отметка, мм<input id="cz-elevation" type="number" step="1" value="${level.elevation_mm ?? ""}" placeholder="Без отметки" ${can ? "" : "disabled"}></label>
        <p class="cz-hint">Тяните вершину для её перемещения или середину ребра, чтобы сдвинуть его параллельно себе. Двойной щелчок по ребру добавляет точку.</p>
        <div class="cz-point-list">${level.outline.map((p, i) => `<span>${i + 1}. ${Number(p[0].toFixed(1))}; ${Number(p[1].toFixed(1))}</span>`).join("")}</div>` : ""}
      <div class="cz-subtitle">Выбрано изделий: ${selectedElements.size}</div>
      ${can ? `<div class="cz-actions"><button type="button" class="v2-btn" id="cz-assign" ${selectedElements.size ? "" : "disabled"}>Назначить выбранные сюда</button><button type="button" class="v2-btn" id="cz-clear" ${selectedElements.size ? "" : "disabled"}>Без зоны</button></div>` : ""}
      <p class="cz-hint">Shift + протяжка на схеме выделяет группу изделий. Обычный щелчок выбирает одно изделие.</p>`;
  }

  function render() {
    if (dead) return;
    root.className = "cz-root";
    const version = displayVersion();
    const parent = parentCrane();
    const primaryAdd = standFocus ? `<button type="button" class="v2-btn v2-primary" id="cz-add-stand" ${parent ? "" : "disabled"}>${draft ? "+ Добавить стоянку" : "Создать черновик и добавить стоянку"}</button>` : `<button type="button" class="v2-btn v2-primary" id="cz-add-crane">${draft ? "+ Добавить кран" : "Создать черновик и добавить кран"}</button>`;
    root.innerHTML = `<div class="cz-toolbar"><strong>${standFocus ? "Стоянки кранов" : "Зоны кранов"}</strong><span class="cz-revision">${version ? `Редакция №${version.revision_no}${version.effective_date ? ` · с ${esc(version.effective_date)}` : " · исходная"}` : "Нет редакции"}</span>
      <select id="cz-version-select" aria-label="История редакций"><option value="">Действующая редакция</option>${versions.map((v) => `<option value="${v.id}" ${selectedVersionId === v.id ? "selected" : ""}>№${v.revision_no} · ${v.effective_date || `исходная с ${v.known_from}`}${v.activated_at ? "" : " · ожидает"}</option>`).join("")}</select>
      <select id="cz-draft-select" aria-label="Черновик"><option value="">Действующая редакция</option>${drafts.map((d) => `<option value="${d.id}" ${draft?.id === d.id ? "selected" : ""}>Черновик №${d.id} · ${esc(d.author_name || "импорт")} · ${esc(d.updated_at)}</option>`).join("")}</select>
      ${canEdit ? `<button type="button" class="v2-btn" id="cz-new">Новый черновик</button><button type="button" class="v2-btn" id="cz-save">Сохранить черновик</button><button type="button" class="v2-btn v2-primary" id="cz-publish">Опубликовать</button>` : ""}</div>
      ${selectedVersionId ? `<div class="cz-history-note">Редакция №${version.revision_no} · ${esc(version.author_name || "система")} · ${esc(version.note || "Причина не указана")} · ${version.activated_at ? "действовала с указанной даты" : "ожидает вступления в силу"}. Координаты изделий показаны по текущей схеме.</div>` : ""}
      <div class="cz-body"><aside class="cz-tree"><div class="cz-tree-head"><div class="cz-title">${standFocus ? "Стоянки по кранам" : "Краны"}</div><p class="cz-tree-intro">${standFocus ? "Выберите кран — он станет владельцем новой стоянки. Выбор существующей стоянки тоже сохранит её кран." : "Здесь показаны только зоны кранов. Для стоянок откройте соседнюю вкладку."}</p>${canEdit ? `<div class="cz-tree-add">${primaryAdd}</div><div class="cz-parent-hint">${standFocus ? parent ? `Выбранный кран: ${esc(parent.name)}.` : "Сначала создайте кран на вкладке «Зоны кранов»." : ""} ${draft ? "Изменения пока только в черновике." : "Черновик создаётся при добавлении; рабочие зоны не меняются до публикации."}</div>` : ""}</div>${treeHtml()}</aside>
      <div class="cz-map"><div class="cz-map-bar"><span>${standFocus ? "Схема стоянок" : "Схема зон кранов"} · ${scene.length} изделий</span><span>${selectedVersionId ? "Назначения выбранной редакции; координаты изделий текущие" : selectedElements.size ? `Выделено ${selectedElements.size}` : "Щелчок — выбор; Shift + протяжка — группа"}</span><button type="button" id="cz-select-mode" class="v2-btn ${selectMode ? "cz-mode-active" : ""}" aria-pressed="${selectMode}">Выделить рамкой</button></div><canvas id="cz-canvas" aria-label="${standFocus ? "Схема стоянок" : "Схема зон кранов"} и изделий"></canvas><div class="cz-zoom-controls" role="group" aria-label="Масштаб схемы"><button type="button" id="cz-zoom-out" title="Уменьшить масштаб" aria-label="Уменьшить масштаб" disabled>−</button><output id="cz-zoom-value" aria-label="Текущий масштаб">100%</output><button type="button" id="cz-zoom-in" title="Увеличить масштаб" aria-label="Увеличить масштаб">+</button><button type="button" id="cz-fit" title="Вписать всю схему, масштаб 100%" aria-label="Вписать всю схему">⟲</button></div><div class="cz-map-foot" id="cz-status" role="status"></div></div>
      <aside class="cz-properties"><div class="cz-title">Свойства</div>${propertyHtml()}</aside></div>
      ${draft ? `<div class="cz-bottom"><label>Причина изменения<input id="cz-note" type="text" maxlength="2000" value="${esc(draft.note || "")}" placeholder="Обязательно перед публикацией" ${canEdit ? "" : "disabled"}></label><label>Действует с<input id="cz-date" type="date" value="${effectiveDate}" min="${today()}" ${canEdit ? "" : "disabled"}></label><button type="button" class="v2-btn" id="cz-preview">Предпросмотр</button><span id="cz-preview-result">${preview ? `Изделий: ${preview.total}; смена крана: ${preview.counts.crane || 0}, стоянки: ${preview.counts.stance || 0}; требуют проверки: ${preview.counts.needs_review || 0}` : ""}</span></div>` : ""}`;
    bind();
    updateStatus();
    requestAnimationFrame(() => { if (!dead) draw(); });
  }

  function bounds() {
    const pts = [];
    for (const z of visibleZones()) for (const l of z.levels) pts.push(...l.outline);
    for (const e of scene) if (Number.isFinite(e.x) && Number.isFinite(e.y)) pts.push([e.x, e.y]);
    if (!pts.length) return { x: 0, y: 0, w: 100, h: 100 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  function fittedScale(w, h) { const b = bounds(); return Math.min(w / (b.w * 1.18), h / (b.h * 1.18)); }
  function updateZoomControls() {
    const value = $("#cz-zoom-value");
    if (value) value.textContent = view && fitScale ? `${Math.max(100, Math.round(view.scale / fitScale * 100))}%` : "100%";
    const out = $("#cz-zoom-out");
    if (out) out.disabled = !view || !fitScale || view.scale <= fitScale * (1 + 1e-8);
    const zoomIn = $("#cz-zoom-in");
    if (zoomIn) zoomIn.disabled = !!view && view.scale >= (fitScale || 0) * 100 * (1 - 1e-8);
  }
  function fit() {
    const canvas = $("#cz-canvas"); if (!canvas) return;
    const b = bounds(), w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
    fitScale = fittedScale(w, h);
    viewWidth = w; viewHeight = h;
    view = { x: b.x, y: b.y, scale: fitScale };
    draw();
  }
  function zoom(factor, x, y, canvas) {
    if (!view) fit();
    if (!view || !fitScale) return;
    const next = Math.max(fitScale, Math.min(fitScale * 100, view.scale * factor));
    if (Math.abs(next - view.scale) < 1e-12) return;
    const before = toWorld(x, y, canvas);
    view.scale = next;
    const after = toWorld(x, y, canvas);
    view.x += before[0] - after[0]; view.y += before[1] - after[1];
    draw();
  }
  function toScreen(x, y, canvas) { return [(x - view.x) * view.scale + canvas.clientWidth / 2, (view.y - y) * view.scale + canvas.clientHeight / 2]; }
  function toWorld(x, y, canvas) { return [(x - canvas.clientWidth / 2) / view.scale + view.x, view.y - (y - canvas.clientHeight / 2) / view.scale]; }
  function draw() {
    if (drawing || dead) return;
    const canvas = $("#cz-canvas"); if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    if (!view) { fit(); return; }
    if (w !== viewWidth || h !== viewHeight) {
      const ratio = view.scale / fitScale;
      fitScale = fittedScale(w, h);
      view.scale = Math.min(fitScale * 100, Math.max(fitScale, fitScale * ratio));
      viewWidth = w; viewHeight = h;
    }
    updateZoomControls();
    drawing = true;
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8fafb"; ctx.fillRect(0, 0, w, h);
    let activeOutline = null;
    for (const z of visibleZones()) for (const [li, level] of z.levels.entries()) {
      if (!level.outline?.length) continue;
      ctx.beginPath(); level.outline.forEach((p, i) => { const [sx, sy] = toScreen(p[0], p[1], canvas); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.closePath();
      const active = z.id === selectedZone && li === activeLevel && (!standFocus || z.category === "Стоянка");
      ctx.fillStyle = z.category === "Кран" ? "rgba(44,137,83,.08)" : "rgba(42,105,176,.08)"; ctx.fill();
      ctx.strokeStyle = active ? "#f07830" : z.category === "Кран" ? "#2c8953" : "#4682b4";
      ctx.lineWidth = active ? 2.7 : z.category === "Кран" ? 1.5 : 1; ctx.stroke();
      if (active && draft && canEdit) activeOutline = level.outline;
    }
    for (const e of scene) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      const [x, y] = toScreen(e.x, e.y, canvas);
      if (x < -5 || x > w + 5 || y < -5 || y > h + 5) continue;
      const active = selectedElements.has(e.id);
      ctx.beginPath(); ctx.arc(x, y, active ? 4.5 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#ef6b33" : "rgba(43,65,84,.55)"; ctx.fill();
    }
    // Ручки поверх изделий: на плотной схеме маркеры не должны закрывать
    // место захвата ребра или вершины.
    if (activeOutline) {
      const highlighted = drag?.kind === "edge" ? drag.index : hoverEdge;
      if (highlighted != null) {
        const a = toScreen(...activeOutline[highlighted], canvas);
        const b = toScreen(...activeOutline[(highlighted + 1) % activeOutline.length], canvas);
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.strokeStyle = "#d65b16"; ctx.lineWidth = 4; ctx.stroke();
      }
      for (let i = 0; i < activeOutline.length; i++) {
        const p = activeOutline[i], next = activeOutline[(i + 1) % activeOutline.length];
        const [sx, sy] = toScreen(p[0], p[1], canvas);
        const [nx, ny] = toScreen(next[0], next[1], canvas);
        if (Math.hypot(nx - sx, ny - sy) >= 22) {
          ctx.save(); ctx.translate((sx + nx) / 2, (sy + ny) / 2); ctx.rotate(Math.atan2(ny - sy, nx - sx));
          ctx.fillStyle = i === highlighted ? "#d65b16" : "#fff";
          ctx.strokeStyle = "#d65b16"; ctx.lineWidth = 1.5;
          ctx.fillRect(-6, -3.5, 12, 7); ctx.strokeRect(-6, -3.5, 12, 7); ctx.restore();
        }
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fillStyle = "#f07830"; ctx.fill();
      }
    }
    if (drag?.kind === "box") { ctx.strokeStyle = "#ef6b33"; ctx.setLineDash([5, 4]); ctx.strokeRect(drag.x, drag.y, drag.lastX - drag.x, drag.lastY - drag.y); ctx.setLineDash([]); }
    drawing = false;
  }

  function pointer(event) { const rect = event.currentTarget.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; }
  function nearestVertex(x, y, canvas) {
    const z = selected(); if (!draft || !canEdit || !z || (standFocus && z.category !== "Стоянка")) return null;
    const level = z.levels[activeLevel]; if (!level) return null;
    for (let i = 0; i < level.outline.length; i++) { const p = toScreen(...level.outline[i], canvas); if (Math.hypot(p[0] - x, p[1] - y) <= 8) return i; }
    return null;
  }
  function nearestEdge(x, y, canvas) {
    const z = selected(); if (!draft || !canEdit || !z || (standFocus && z.category !== "Стоянка")) return null;
    const level = z.levels[activeLevel]; if (!level) return null;
    return nearestEdgeIndex(level.outline, x, y, (point) => toScreen(...point, canvas));
  }
  function nearestElement(x, y, canvas) {
    let found = null, distance = 9;
    for (const e of scene) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      const p = toScreen(e.x, e.y, canvas), d = Math.hypot(p[0] - x, p[1] - y);
      if (d < distance) { found = e; distance = d; }
    }
    return found;
  }
  function inside(poly, x, y) {
    let result = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (((a[1] > y) !== (b[1] > y)) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  }
  function chooseZone(x, y, canvas) {
    const [wx, wy] = toWorld(x, y, canvas);
    const candidates = visibleZones().filter((z) => z.levels.some((l) => inside(l.outline, wx, wy)));
    return candidates.sort((a, b) => (a.category === "Стоянка" ? -1 : 1) - (b.category === "Стоянка" ? -1 : 1))[0];
  }
  function onDown(e) {
    const canvas = e.currentTarget, [x, y] = pointer(e);
    if (e.shiftKey || selectMode) drag = { kind: "box", x, y, lastX: x, lastY: y };
    else {
      const vertex = nearestVertex(x, y, canvas);
      const edge = vertex == null ? nearestEdge(x, y, canvas) : null;
      if (vertex != null) drag = { kind: "vertex", index: vertex, x, y };
      else if (edge != null) drag = { kind: "edge", index: edge, start: toWorld(x, y, canvas), outline: clone(selected().levels[activeLevel].outline), wasDirty: dirty, wasPreview: preview, moved: false };
      else drag = { kind: "pan", x, y, lastX: x, lastY: y, moved: false };
    }
    hoverEdge = drag.kind === "edge" ? drag.index : null;
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    const canvas = e.currentTarget, [x, y] = pointer(e);
    if (!drag) {
      const edge = !selectMode && nearestVertex(x, y, canvas) == null ? nearestEdge(x, y, canvas) : null;
      canvas.style.cursor = selectMode ? "crosshair" : edge != null ? "grab" : nearestVertex(x, y, canvas) != null ? "move" : "crosshair";
      if (hoverEdge !== edge) { hoverEdge = edge; draw(); }
      return;
    }
    if (drag.kind === "vertex") {
      const level = selected()?.levels[activeLevel]; if (!level) return;
      level.outline[drag.index] = toWorld(x, y, canvas).map(Math.round); markDirty();
    } else if (drag.kind === "edge") {
      const level = selected()?.levels[activeLevel]; if (!level) return;
      const world = toWorld(x, y, canvas);
      const endpoints = displacedEdgeEndpoints(drag.outline, drag.index, world[0] - drag.start[0], world[1] - drag.start[1]);
      if (!endpoints) return;
      const nextIndex = (drag.index + 1) % level.outline.length;
      if (level.outline[drag.index][0] !== endpoints[0][0] || level.outline[drag.index][1] !== endpoints[0][1]) {
        level.outline[drag.index] = endpoints[0]; level.outline[nextIndex] = endpoints[1]; drag.moved = true; markDirty();
      }
    } else if (drag.kind === "box") { drag.lastX = x; drag.lastY = y; draw(); }
    else { if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true; view.x -= (x - drag.lastX) / view.scale; view.y += (y - drag.lastY) / view.scale; drag.lastX = x; drag.lastY = y; draw(); }
  }
  function onUp(e) {
    if (!drag) return;
    const canvas = e.currentTarget, [x, y] = pointer(e), move = drag;
    if (move.kind === "box") {
      const x0 = Math.min(move.x, x), x1 = Math.max(move.x, x), y0 = Math.min(move.y, y), y1 = Math.max(move.y, y);
      selectedElements = new Set(scene.filter((item) => { const p = toScreen(item.x, item.y, canvas); return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1; }).map((item) => item.id));
      render();
    } else if (move.kind === "pan" && !move.moved) {
      const element = nearestElement(x, y, canvas), zone = element ? null : chooseZone(x, y, canvas);
      if (element) selectedElements = new Set([element.id]);
      else if (zone) { selectedZone = zone.id; activeLevel = 0; }
      render();
    } else if (move.kind === "vertex" || move.kind === "edge") render();
    drag = null;
  }
  function onCancel() {
    if (drag?.kind === "edge" && drag.moved) {
      const level = selected()?.levels[activeLevel];
      if (level) level.outline = drag.outline;
      dirty = drag.wasDirty; preview = drag.wasPreview;
    }
    drag = null; hoverEdge = null; render();
  }
  function onDoubleClick(e) {
    const z = selected(), level = z?.levels[activeLevel]; if (!draft || !canEdit || !level || (standFocus && z.category !== "Стоянка")) return;
    const canvas = e.currentTarget, [x, y] = pointer(e), p = toWorld(x, y, canvas);
    let best = -1, dist = 12;
    for (let i = 0; i < level.outline.length; i++) {
      const a = toScreen(...level.outline[i], canvas), b = toScreen(...level.outline[(i + 1) % level.outline.length], canvas);
      const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
      if (d < dist) { dist = d; best = i; }
    }
    if (best >= 0) { level.outline.splice(best + 1, 0, p.map(Math.round)); markDirty(); render(); }
  }
  function bind() {
    $("#cz-version-select")?.addEventListener("change", async (e) => { if (dirty && !(await guardLeave())) { e.target.value = selectedVersionId || ""; return; } await loadVersion(e.target.value ? Number(e.target.value) : null); });
    $("#cz-draft-select")?.addEventListener("change", async (e) => { if (dirty && !(await guardLeave())) { e.target.value = draft?.id || ""; return; } await loadDraft(e.target.value ? Number(e.target.value) : null); });
    $("#cz-new")?.addEventListener("click", createDraft);
    $("#cz-save")?.addEventListener("click", save);
    $("#cz-publish")?.addEventListener("click", publish);
    $("#cz-preview")?.addEventListener("click", loadPreview);
    $("#cz-fit")?.addEventListener("click", fit);
    $("#cz-zoom-in")?.addEventListener("click", () => { const canvas = $("#cz-canvas"); zoom(BUTTON_ZOOM_STEP, canvas.clientWidth / 2, canvas.clientHeight / 2, canvas); });
    $("#cz-zoom-out")?.addEventListener("click", () => { const canvas = $("#cz-canvas"); zoom(1 / BUTTON_ZOOM_STEP, canvas.clientWidth / 2, canvas.clientHeight / 2, canvas); });
    $("#cz-select-mode")?.addEventListener("click", () => { selectMode = !selectMode; render(); });
    root.querySelectorAll("[data-zone-id]").forEach((b) => b.addEventListener("click", () => { selectedZone = Number(b.dataset.zoneId); activeLevel = 0; render(); }));
    root.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => { activeLevel = Number(b.dataset.level); render(); }));
    $("#cz-number")?.addEventListener("change", (e) => { selected().number = Number(e.target.value); markDirty(); render(); });
    $("#cz-name")?.addEventListener("change", (e) => { selected().name = e.target.value; markDirty(); render(); });
    $("#cz-parent")?.addEventListener("change", (e) => { selected().parent_zone_id = Number(e.target.value); markDirty(); render(); });
    $("#cz-elevation")?.addEventListener("change", (e) => { selected().levels[activeLevel].elevation_mm = e.target.value === "" ? null : Number(e.target.value); markDirty(); render(); });
    $("#cz-note")?.addEventListener("input", (e) => { draft.note = e.target.value; markDirty(); });
    $("#cz-date")?.addEventListener("change", (e) => { effectiveDate = e.target.value; });
    $("#cz-add-crane")?.addEventListener("click", () => startAddingZone("Кран"));
    $("#cz-add-stand")?.addEventListener("click", () => startAddingZone("Стоянка"));
    $("#cz-add-level")?.addEventListener("click", addLevel);
    $("#cz-assign")?.addEventListener("click", () => assign(false));
    $("#cz-clear")?.addEventListener("click", () => assign(true));
    const canvas = $("#cz-canvas");
    canvasResizeObserver?.disconnect();
    if (canvas && typeof ResizeObserver === "function") {
      canvasResizeObserver = new ResizeObserver(() => { if (!dead) draw(); });
      canvasResizeObserver.observe(canvas);
    }
    canvas?.addEventListener("pointerdown", onDown); canvas?.addEventListener("pointermove", onMove); canvas?.addEventListener("pointerup", onUp); canvas?.addEventListener("pointercancel", onCancel);
    canvas?.addEventListener("pointerleave", () => { if (!drag && hoverEdge != null) { hoverEdge = null; draw(); } });
    canvas?.addEventListener("dblclick", onDoubleClick);
    canvas?.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x, y] = pointer(e);
      const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1);
      zoom(Math.exp(-Math.max(-180, Math.min(180, pixels)) * WHEEL_SENSITIVITY), x, y, canvas);
    }, { passive: false });
  }
  async function startAddingZone(category) {
    if (!canEdit || busy) return;
    const parentId = category === "Стоянка" ? parentCrane()?.id : null;
    if (category === "Стоянка" && parentId == null) return status("Сначала выберите кран для новой стоянки.");
    if (!draft) {
      if (!(await createDraft())) return;
      if (parentId != null && zoneById(parentId)) selectedZone = parentId;
    }
    addZone(category);
    status(`Новая ${category === "Стоянка" ? "стоянка" : "зона крана"} добавлена в черновик. Задайте название и контур, затем сохраните черновик и проверьте предпросмотр.`);
  }
  function addZone(category) {
    const all = zones(), id = Math.min(0, ...all.map((z) => z.id)) - 1;
    const parent = category === "Стоянка" ? (selected()?.category === "Кран" ? selectedZone : selected()?.parent_zone_id ?? all.find((z) => z.category === "Кран")?.id) : null;
    if (category === "Стоянка" && !parent) return status("Сначала выберите кран для стоянки");
    // Стартовый контур стоянки появляется возле выбранного крана, а не в центре всего объекта.
    const parentPoints = category === "Стоянка" ? zoneById(parent)?.levels?.[0]?.outline || [] : [];
    const xs = parentPoints.map((p) => p[0]), ys = parentPoints.map((p) => p[1]);
    const b = parentPoints.length ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2,
      w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) } : bounds();
    const size = Math.max(10, Math.min(b.w, b.h) / 8), x = b.x, y = b.y;
    const number = Math.max(0, ...all.filter((z) => z.category === category && z.parent_zone_id === parent).map((z) => z.number)) + 1;
    all.push({ id, category, number, name: `${category} ${number}`, parent_zone_id: parent,
      levels: [{ elevation_mm: category === "Кран" ? null : 0, outline: [[x - size, y - size], [x + size, y - size], [x + size, y + size], [x - size, y + size]].map((p) => p.map(Math.round)) }] });
    selectedZone = id; activeLevel = 0; markDirty(); render();
  }
  function addLevel() { const z = selected(); if (!z) return; const last = z.levels[z.levels.length - 1]; z.levels.push({ elevation_mm: last.elevation_mm == null ? 0 : last.elevation_mm + 3000, outline: clone(last.outline) }); activeLevel = z.levels.length - 1; markDirty(); render(); }
  function assign(clear) {
    if (!draft || !selectedElements.size) return;
    const z = selected(), crane = clear ? null : z?.category === "Кран" ? z.id : z?.parent_zone_id;
    const stance = clear ? null : z?.category === "Стоянка" ? z.id : null;
    if (!clear && !z) return;
    for (const id of selectedElements) draft.overrides[String(id)] = { crane_zone_id: crane, stance_zone_id: stance };
    markDirty(); status(`${selectedElements.size} изделий подготовлено к ${clear ? "снятию назначения" : "назначению"}. Сохраните черновик и проверьте предпросмотр.`);
  }
  async function createDraft() {
    if (busy || !canEdit || (dirty && !(await guardLeave()))) return false;
    busy = true; updateStatus();
    try { const r = await api.post(`${prefix}/drafts`); await refresh(); await loadDraft(r.draft_id); status("Создан черновик. Рабочие зоны не изменены."); return true; }
    catch (e) { status(errText(e)); return false; } finally { busy = false; updateStatus(); }
  }
  async function loadDraft(id) {
    try { draft = id ? await api.get(`${prefix}/drafts/${id}`) : null; selectedVersionId = null; scene = currentScene; selectedElements.clear(); dirty = false; preview = null; selectedZone = firstZoneId(); activeLevel = 0; view = null; message = ""; render(); }
    catch (e) { status(errText(e)); }
  }
  async function loadVersion(id) {
    if (id && !versions.some((v) => v.id === id)) return status("Редакция не найдена");
    try {
      if (id) {
        const [detail, image] = await Promise.all([
          api.get(`${prefix}/${id}`), api.get(`${prefix}/scene?version_id=${id}`),
        ]);
        versions.find((v) => v.id === id).zones = detail.zones;
        scene = image.elements || [];
      } else scene = currentScene;
      selectedVersionId = id; draft = null; dirty = false; preview = null;
      selectedElements.clear(); selectedZone = firstZoneId();
      activeLevel = 0; view = null; message = ""; render();
    } catch (e) { status(errText(e)); }
  }
  async function save() {
    if (!draft || !dirty || busy) return false;
    busy = true; updateStatus();
    try { const r = await api.patch(`${prefix}/drafts/${draft.id}`, { edit_token: draft.edit_token, zones: draft.zones, overrides: draft.overrides, note: draft.note || "" }); draft.edit_token = r.edit_token; dirty = false; status("Черновик сохранён; действующая редакция не изменилась."); return true; }
    catch (e) { status(errText(e)); return false; } finally { busy = false; updateStatus(); }
  }
  async function loadPreview() {
    if (!draft || busy) return;
    if (dirty && !(await save())) return;
    busy = true; updateStatus();
    try { preview = await api.readPost(`${prefix}/drafts/${draft.id}/preview`); render(); status("Предпросмотр рассчитан сервером без записи."); }
    catch (e) { status(errText(e)); } finally { busy = false; updateStatus(); }
  }
  async function publish() {
    if (!draft || dirty || busy || !canEdit) return;
    if (!draft.note?.trim()) return status("Укажите причину изменения и сохраните черновик.");
    if (!preview) return status("Сначала выполните предпросмотр.");
    const date = effectiveDate;
    if (!date) return status("Укажите дату действия.");
    if (!(await showConfirmDialog(`Опубликовать всю редакцию кранов и стоянок с ${date}? Изменится привязка ${preview.counts.crane || 0} изделий по крану и ${preview.counts.stance || 0} по стоянке.`, { confirmLabel: "Опубликовать редакцию" }))) return;
    busy = true; updateStatus();
    try { const r = await api.post(`${prefix}/drafts/${draft.id}/publish`, { edit_token: draft.edit_token, effective_date: date }); draft = null; dirty = false; preview = null; await refresh(); status(r.activated ? "Редакция опубликована и действует." : `Редакция опубликована; вступит в силу ${date}.`); onPublished?.(r); }
    catch (e) { status(`${errText(e)} Состояние перечитайте перед повтором.`); await refresh(); } finally { busy = false; updateStatus(); }
  }
  async function refresh() {
    const [v, d, s] = await Promise.all([api.get(prefix), api.get(`${prefix}/drafts`), api.get(`${prefix}/scene`)]);
    versions = v; drafts = d; currentScene = s.elements || []; scene = currentScene;
    const current = currentVersion();
    if (current) current.zones = (await api.get(`${prefix}/${current.id}`)).zones;
    if (selectedVersionId) {
      const selected = versions.find((row) => row.id === selectedVersionId);
      if (selected) {
        selected.zones = (await api.get(`${prefix}/${selected.id}`)).zones;
        scene = (await api.get(`${prefix}/scene?version_id=${selected.id}`)).elements || [];
      } else selectedVersionId = null;
    }
    if (draft && !drafts.some((item) => item.id === draft.id)) draft = null;
    selectedZone = selectedZone && zoneById(selectedZone) ? selectedZone : firstZoneId();
    view = null; render();
  }
  async function guardLeave() {
    if (!dirty) return true;
    const answer = await showUnsavedDialog("В редакции крановых зон есть несохранённые изменения. Что сделать?");
    if (answer === "cancel") return false;
    if (answer === "discard") { dirty = false; return true; }
    return save();
  }
  root.innerHTML = `<p class="v2-muted">Загрузка редакций и схемы…</p>`;
  refresh().then(async () => { if (!dead && drafts.length) await loadDraft(drafts[0].id); }).catch((e) => { root.innerHTML = `<div class="v2-callout v2-callout-bad">${esc(errText(e))}</div>`; });
  return { hasUnsavedChanges: () => dirty, guardLeave, destroy() { dead = true; canvasResizeObserver?.disconnect(); } };
}
