// Цельный редактор редакции кранов и стоянок: дерево → схема → свойства.
// Все изменения до публикации живут только в локальном/серверном черновике.
import { esc } from "./screen-view.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const errText = (e) => String(e?.detail || e?.message || e);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function mountCraneZoneEditor(root, { objectId, api, canEdit }) {
  const prefix = `/objects/${objectId}/crane-zone-versions`;
  let dead = false, busy = false, drawing = false;
  let versions = [], drafts = [], draft = null, scene = [], selectedZone = null;
  let selectedElements = new Set(), dirty = false, preview = null, message = "";
  let effectiveDate = today();
  let view = null, drag = null, activeLevel = 0;
  const $ = (s) => root.querySelector(s);

  function currentVersion() { return versions.find((v) => v.activated_at) || versions[0]; }
  function zones() { return draft?.zones || currentVersion()?.zones || []; }
  function zoneById(id) { return zones().find((z) => z.id === id); }
  function selected() { return zoneById(selectedZone); }
  function markDirty() { dirty = true; preview = null; message = ""; draw(); updateStatus(); }

  function status(text) { message = text; updateStatus(); }
  function updateStatus() {
    const node = $("#cz-status");
    if (node) node.textContent = message || (dirty ? "Есть несохранённые изменения" : draft ? "Черновик сохранён" : "Просмотр действующей редакции");
    const save = $("#cz-save");
    if (save) save.disabled = !canEdit || !draft || !dirty || busy;
    const publish = $("#cz-publish");
    if (publish) publish.disabled = !canEdit || !draft || dirty || !preview || busy;
  }

  function treeHtml() {
    const all = zones(), cranes = all.filter((z) => z.category === "Кран");
    return cranes.map((crane) => {
      const stands = all.filter((z) => z.category === "Стоянка" && z.parent_zone_id === crane.id);
      const count = scene.filter((e) => e.zone_crane_id === crane.id).length;
      return `<div class="cz-crane"><button type="button" class="cz-tree-item ${selectedZone === crane.id ? "active" : ""}" data-zone-id="${crane.id}"><span class="cz-tree-icon">▣</span><span>${esc(crane.name)}</span><b>${count}</b></button>
        ${stands.map((stand) => `<button type="button" class="cz-tree-item cz-stand ${selectedZone === stand.id ? "active" : ""}" data-zone-id="${stand.id}"><span class="cz-tree-icon">⌞</span><span>${esc(stand.name)}</span><b>${scene.filter((e) => e.zone_stance_id === stand.id).length}</b></button>`).join("")}</div>`;
    }).join("") || `<p class="v2-muted">Кранов пока нет.</p>`;
  }

  function propertyHtml() {
    const z = selected();
    if (!z) return `<div class="cz-empty">Выберите кран или стоянку в дереве либо на схеме.</div>`;
    const level = z.levels[activeLevel] || z.levels[0];
    const can = canEdit && !!draft;
    return `<div class="cz-prop-head"><span>${z.category}</span><strong>${esc(z.name)}</strong></div>
      <label>Номер<input id="cz-number" type="number" min="1" step="1" value="${z.number}" ${can ? "" : "disabled"}></label>
      <label>Название<input id="cz-name" type="text" maxlength="200" value="${esc(z.name)}" ${can ? "" : "disabled"}></label>
      ${z.category === "Стоянка" ? `<label>Кран<select id="cz-parent" ${can ? "" : "disabled"}>${zones().filter((v) => v.category === "Кран").map((c) => `<option value="${c.id}" ${z.parent_zone_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : ""}
      <div class="cz-subtitle">Ярусы и контуры</div>
      <div class="cz-levels">${z.levels.map((l, i) => `<button type="button" class="cz-level ${i === activeLevel ? "active" : ""}" data-level="${i}">${l.elevation_mm == null ? "Без отметки" : `+${l.elevation_mm} мм`} · ${l.outline.length} точек</button>`).join("")}</div>
      ${can ? `<button type="button" class="v2-btn" id="cz-add-level">Добавить ярус</button>` : ""}
      ${level ? `<label>Отметка, мм<input id="cz-elevation" type="number" step="1" value="${level.elevation_mm ?? ""}" placeholder="Без отметки" ${can ? "" : "disabled"}></label>
        <p class="cz-hint">Точки контура можно перетаскивать на схеме. Двойной щелчок по ребру добавляет точку.</p>
        <div class="cz-point-list">${level.outline.map((p, i) => `<span>${i + 1}. ${Math.round(p[0])}; ${Math.round(p[1])}</span>`).join("")}</div>` : ""}
      <div class="cz-subtitle">Выбрано изделий: ${selectedElements.size}</div>
      ${can ? `<div class="cz-actions"><button type="button" class="v2-btn" id="cz-assign" ${selectedElements.size ? "" : "disabled"}>Назначить выбранные сюда</button><button type="button" class="v2-btn" id="cz-clear" ${selectedElements.size ? "" : "disabled"}>Без зоны</button></div>` : ""}
      <p class="cz-hint">Shift + протяжка на схеме выделяет группу изделий. Обычный щелчок выбирает одно изделие.</p>`;
  }

  function render() {
    if (dead) return;
    root.className = "cz-root";
    const version = currentVersion();
    root.innerHTML = `<div class="cz-toolbar"><strong>Зоны кранов</strong><span class="cz-revision">${version ? `Редакция №${version.revision_no}${version.effective_date ? ` · с ${esc(version.effective_date)}` : " · исходная"}` : "Нет редакции"}</span>
      <select id="cz-draft-select" aria-label="Черновик"><option value="">Действующая редакция</option>${drafts.map((d) => `<option value="${d.id}" ${draft?.id === d.id ? "selected" : ""}>Черновик №${d.id} · ${esc(d.author_name || "импорт")} · ${esc(d.updated_at)}</option>`).join("")}</select>
      ${canEdit ? `<button type="button" class="v2-btn" id="cz-new">Новый черновик</button><button type="button" class="v2-btn" id="cz-save">Сохранить черновик</button><button type="button" class="v2-btn v2-primary" id="cz-publish">Опубликовать</button>` : ""}</div>
      <div class="cz-body"><aside class="cz-tree"><div class="cz-title">Краны и стоянки</div>${treeHtml()}${canEdit && draft ? `<div class="cz-tree-add"><button type="button" class="v2-btn" id="cz-add-crane">+ Кран</button><button type="button" class="v2-btn" id="cz-add-stand">+ Стоянка</button></div>` : ""}</aside>
      <div class="cz-map"><div class="cz-map-bar"><span>Схема · ${scene.length} изделий</span><span>${selectedElements.size ? `Выделено ${selectedElements.size}` : "Щелчок — выбор; Shift + протяжка — группа"}</span><button type="button" id="cz-fit" class="v2-btn">Вписать</button></div><canvas id="cz-canvas" aria-label="Схема зон кранов и изделий"></canvas><div class="cz-map-foot" id="cz-status" role="status"></div></div>
      <aside class="cz-properties"><div class="cz-title">Свойства</div>${propertyHtml()}</aside></div>
      ${draft ? `<div class="cz-bottom"><label>Причина изменения<input id="cz-note" type="text" maxlength="2000" value="${esc(draft.note || "")}" placeholder="Обязательно перед публикацией" ${canEdit ? "" : "disabled"}></label><label>Действует с<input id="cz-date" type="date" value="${effectiveDate}" min="${today()}" ${canEdit ? "" : "disabled"}></label><button type="button" class="v2-btn" id="cz-preview">Предпросмотр</button><span id="cz-preview-result">${preview ? `Изделий: ${preview.total}; смена крана: ${preview.counts.crane || 0}, стоянки: ${preview.counts.stance || 0}; требуют проверки: ${preview.counts.needs_review || 0}` : ""}</span></div>` : ""}`;
    bind();
    updateStatus();
    requestAnimationFrame(() => { if (!dead) draw(); });
  }

  function bounds() {
    const pts = [];
    for (const z of zones()) for (const l of z.levels) pts.push(...l.outline);
    for (const e of scene) if (Number.isFinite(e.x) && Number.isFinite(e.y)) pts.push([e.x, e.y]);
    if (!pts.length) return { x: 0, y: 0, w: 100, h: 100 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  function fit() {
    const canvas = $("#cz-canvas"); if (!canvas) return;
    const b = bounds(), w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
    view = { x: b.x, y: b.y, scale: Math.min(w / (b.w * 1.18), h / (b.h * 1.18)) };
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
    drawing = true;
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8fafb"; ctx.fillRect(0, 0, w, h);
    for (const z of zones()) for (const [li, level] of z.levels.entries()) {
      if (!level.outline?.length) continue;
      ctx.beginPath(); level.outline.forEach((p, i) => { const [sx, sy] = toScreen(p[0], p[1], canvas); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.closePath();
      const active = z.id === selectedZone && li === activeLevel;
      ctx.fillStyle = z.category === "Кран" ? "rgba(44,137,83,.08)" : "rgba(42,105,176,.08)"; ctx.fill();
      ctx.strokeStyle = active ? "#f07830" : z.category === "Кран" ? "#2c8953" : "#4682b4";
      ctx.lineWidth = active ? 2.7 : z.category === "Кран" ? 1.5 : 1; ctx.stroke();
      if (active && draft && canEdit) for (const p of level.outline) { const [sx, sy] = toScreen(p[0], p[1], canvas); ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fillStyle = "#f07830"; ctx.fill(); }
    }
    for (const e of scene) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      const [x, y] = toScreen(e.x, e.y, canvas);
      if (x < -5 || x > w + 5 || y < -5 || y > h + 5) continue;
      const active = selectedElements.has(e.id);
      ctx.beginPath(); ctx.arc(x, y, active ? 4.5 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#ef6b33" : "rgba(43,65,84,.55)"; ctx.fill();
    }
    if (drag?.kind === "box") { ctx.strokeStyle = "#ef6b33"; ctx.setLineDash([5, 4]); ctx.strokeRect(drag.x, drag.y, drag.lastX - drag.x, drag.lastY - drag.y); ctx.setLineDash([]); }
    drawing = false;
  }

  function pointer(event) { const rect = event.currentTarget.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; }
  function nearestVertex(x, y, canvas) {
    const z = selected(); if (!draft || !canEdit || !z) return null;
    const level = z.levels[activeLevel]; if (!level) return null;
    for (let i = 0; i < level.outline.length; i++) { const p = toScreen(...level.outline[i], canvas); if (Math.hypot(p[0] - x, p[1] - y) <= 8) return i; }
    return null;
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
    const candidates = zones().filter((z) => z.levels.some((l) => inside(l.outline, wx, wy)));
    return candidates.sort((a, b) => (a.category === "Стоянка" ? -1 : 1) - (b.category === "Стоянка" ? -1 : 1))[0];
  }
  function onDown(e) {
    const canvas = e.currentTarget, [x, y] = pointer(e);
    const vertex = nearestVertex(x, y, canvas);
    drag = vertex != null ? { kind: "vertex", index: vertex, x, y } : e.shiftKey ? { kind: "box", x, y, lastX: x, lastY: y } : { kind: "pan", x, y, lastX: x, lastY: y, moved: false };
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!drag) return;
    const canvas = e.currentTarget, [x, y] = pointer(e);
    if (drag.kind === "vertex") {
      const level = selected()?.levels[activeLevel]; if (!level) return;
      level.outline[drag.index] = toWorld(x, y, canvas).map(Math.round); markDirty();
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
    } else if (move.kind === "vertex") render();
    drag = null;
  }
  function onDoubleClick(e) {
    const z = selected(), level = z?.levels[activeLevel]; if (!draft || !canEdit || !level) return;
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
    $("#cz-draft-select")?.addEventListener("change", async (e) => { if (dirty && !(await guardLeave())) { e.target.value = draft?.id || ""; return; } await loadDraft(e.target.value ? Number(e.target.value) : null); });
    $("#cz-new")?.addEventListener("click", createDraft);
    $("#cz-save")?.addEventListener("click", save);
    $("#cz-publish")?.addEventListener("click", publish);
    $("#cz-preview")?.addEventListener("click", loadPreview);
    $("#cz-fit")?.addEventListener("click", fit);
    root.querySelectorAll("[data-zone-id]").forEach((b) => b.addEventListener("click", () => { selectedZone = Number(b.dataset.zoneId); activeLevel = 0; render(); }));
    root.querySelectorAll("[data-level]").forEach((b) => b.addEventListener("click", () => { activeLevel = Number(b.dataset.level); render(); }));
    $("#cz-number")?.addEventListener("change", (e) => { selected().number = Number(e.target.value); markDirty(); render(); });
    $("#cz-name")?.addEventListener("change", (e) => { selected().name = e.target.value; markDirty(); render(); });
    $("#cz-parent")?.addEventListener("change", (e) => { selected().parent_zone_id = Number(e.target.value); markDirty(); render(); });
    $("#cz-elevation")?.addEventListener("change", (e) => { selected().levels[activeLevel].elevation_mm = e.target.value === "" ? null : Number(e.target.value); markDirty(); render(); });
    $("#cz-note")?.addEventListener("input", (e) => { draft.note = e.target.value; markDirty(); });
    $("#cz-date")?.addEventListener("change", (e) => { effectiveDate = e.target.value; });
    $("#cz-add-crane")?.addEventListener("click", () => addZone("Кран"));
    $("#cz-add-stand")?.addEventListener("click", () => addZone("Стоянка"));
    $("#cz-add-level")?.addEventListener("click", addLevel);
    $("#cz-assign")?.addEventListener("click", () => assign(false));
    $("#cz-clear")?.addEventListener("click", () => assign(true));
    const canvas = $("#cz-canvas");
    canvas?.addEventListener("pointerdown", onDown); canvas?.addEventListener("pointermove", onMove); canvas?.addEventListener("pointerup", onUp);
    canvas?.addEventListener("dblclick", onDoubleClick);
    canvas?.addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = pointer(e), before = toWorld(x, y, canvas); view.scale = Math.max(0.0001, Math.min(view.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 100)); const after = toWorld(x, y, canvas); view.x += before[0] - after[0]; view.y += before[1] - after[1]; draw(); }, { passive: false });
  }
  function addZone(category) {
    const all = zones(), id = Math.min(0, ...all.map((z) => z.id)) - 1;
    const parent = category === "Стоянка" ? (selected()?.category === "Кран" ? selectedZone : selected()?.parent_zone_id ?? all.find((z) => z.category === "Кран")?.id) : null;
    if (category === "Стоянка" && !parent) return status("Сначала выберите кран для стоянки");
    const b = bounds(), size = Math.max(10, Math.min(b.w, b.h) / 8), x = b.x, y = b.y;
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
    if (busy || !canEdit || (dirty && !(await guardLeave()))) return;
    busy = true; updateStatus();
    try { const r = await api.post(`${prefix}/drafts`); await refresh(); await loadDraft(r.draft_id); status("Создан черновик. Рабочие зоны не изменены."); }
    catch (e) { status(errText(e)); } finally { busy = false; updateStatus(); }
  }
  async function loadDraft(id) {
    try { draft = id ? await api.get(`${prefix}/drafts/${id}`) : null; dirty = false; preview = null; selectedZone = zones()[0]?.id ?? null; activeLevel = 0; view = null; render(); }
    catch (e) { status(errText(e)); }
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
    try { const r = await api.post(`${prefix}/drafts/${draft.id}/publish`, { edit_token: draft.edit_token, effective_date: date }); draft = null; dirty = false; preview = null; await refresh(); status(r.activated ? "Редакция опубликована и действует." : `Редакция опубликована; вступит в силу ${date}.`); }
    catch (e) { status(`${errText(e)} Состояние перечитайте перед повтором.`); await refresh(); } finally { busy = false; updateStatus(); }
  }
  async function refresh() {
    const [v, d, s] = await Promise.all([api.get(prefix), api.get(`${prefix}/drafts`), api.get(`${prefix}/scene`)]);
    versions = v; drafts = d; scene = s.elements || [];
    const current = currentVersion();
    if (current) current.zones = (await api.get(`${prefix}/${current.id}`)).zones;
    if (draft && !drafts.some((item) => item.id === draft.id)) draft = null;
    selectedZone = selectedZone && zoneById(selectedZone) ? selectedZone : zones()[0]?.id ?? null;
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
  return { hasUnsavedChanges: () => dirty, guardLeave, destroy() { dead = true; } };
}
