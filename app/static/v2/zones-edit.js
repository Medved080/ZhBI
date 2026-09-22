// «Зоны: захватки, краны, стоянки» — список по трём категориям (как в V1: три вкладки одной формы) и правка
// зоны (номер, наименование, кран-владелец, геометрия ярусов). Те же API и права, что у V1:
// список — `GET /zones` (чтение всем, у кого есть доступ к объекту), правка — `PATCH /zones/{id}`
// (право «Зоны: захватки, краны, стоянки» на объекте, как у администратора объекта), геометрия для
// предпросмотра — `GET /zones/{id}/geometry` (габариты объекта, сетка осей, соседние зоны той же категории,
// полигоны крана-владельца), откат последней правки — `POST /zones/{id}/undo`. Удаление записи справочника —
// ОТДЕЛЬНОЕ право «Удаление записей справочников с заменой ссылок» (администратор сервиса, не объекта — как
// в V1: удаление крана уносит его стоянки и перевешивает изделия).
//
// Барьер: пересчёт привязки элементов к зонам сервер выполняет САМ при сохранении (решение З11) — интерфейс
// только показывает число затронутых изделий из ответа; правка контура короче трёх точек, нулевой площади или
// самопересекающегося отклоняется сервером до записи (400, форма остаётся заполненной); одна запись за раз;
// «Отменить последнюю правку» — в рамках этой вкладки браузера, как в V1 (снимки хранит сервер, откат
// возможен и позже через ту же кнопку после повторного открытия зоны, но кнопка «видит» только последнюю
// правку текущего сеанса); неизвестный исход не повторяется — состояние перечитывается.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";
import { runDeleteFlow } from "./delete-plan.js";
import { createZonePreview3d } from "./zone-preview-3d.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const CATS = [
  ["Захватка", "Захватки"],
  ["Кран", "Зоны кранов"],
  ["Стоянка", "Стоянки кранов"],
];

function pointsWord(n) {
  const mod100 = n % 100, mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "точек";
  if (mod10 === 1) return "точка";
  if (mod10 >= 2 && mod10 <= 4) return "точки";
  return "точек";
}
function levelsText(levels) {
  if (!levels.length) return "нет ярусов";
  return levels.map((l) => `${l.elevation_mm == null ? "без отметки" : `+${l.elevation_mm}`} (${l.points} ${pointsWord(l.points)})`).join(", ");
}

export function mountZonesEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.zones || { endpoint: "/zones" };
  el.className = "v2-page";
  const canEdit = !!rights?.system_admin || rights?.features?.zones === "write";
  const canDelete = !!rights?.system_admin || rights?.features?.dict_delete === "write";
  let dead = false, busy = false, seq = 0;
  // 3D-предпросмотр (как в V1: переключатель 2D/3D у предпросмотра). Контроллер живёт, пока открыта форма одной зоны:
  // камера ставится один раз на открытие формы, холст переносится при перерисовке формы; при закрытии — освобождается WebGL.
  let previewMode = "2d", p3d = null;
  const drop3d = () => { p3d?.dispose(); p3d = null; };
  const st = { category: "Захватка", includeRetired: false, rows: null, error: "", q: "", editing: null, lastEdit: null, notice: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canEdit ? "Правка зон в новом интерфейсе." : "Просмотр зон."}</strong>
        Захватка — самостоятельное деление объекта; зона крана — рабочая зона крана; стоянка подчинена зоне крана. Пересчёт привязки изделий к зонам выполняется сервером автоматически при сохранении.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ze-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  function dirty() {
    const ed = st.editing;
    if (!ed || !ed.loaded) return false;
    if (ed.number !== ed.base.number || ed.name !== ed.base.name || ed.parentZoneId !== ed.base.parentZoneId) return true;
    return JSON.stringify(ed.levels) !== JSON.stringify(ed.base.levels);
  }

  // ---------------------------------------------------------------- список
  function paintList() {
    const box = $("#ze-body");
    const tabs = `<div class="v2-wire-tabs v2-read-tabs" role="tablist">${CATS.map(([c, label]) => `<button type="button" role="tab" class="v2-read-tab" aria-selected="${st.category === c}" data-cat="${esc(c)}">${esc(label)}</button>`).join("")}</div>`;
    if (!objectId) { box.innerHTML = tabs + `<p class="v2-muted">Выберите объект в шапке — справочник зон свой у каждого объекта.</p>`; wireTabs(); return; }
    if (!st.rows) {
      box.innerHTML = tabs + (st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить зоны.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ze-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`);
      wireTabs(); $("#ze-retry")?.addEventListener("click", loadList);
      return;
    }
    const q = st.q.trim().toLowerCase();
    const rows = st.rows.filter((r) => !q || `${r.name || ""} ${r.parent_name || ""}`.toLowerCase().includes(q));
    box.innerHTML = tabs + `
      <div class="v2-bar"><input type="search" id="ze-search" class="v2-search" placeholder="Поиск" aria-label="Поиск" value="${esc(st.q)}">
        <label class="v2-role-check"><input type="checkbox" id="ze-retired" ${st.includeRetired ? "checked" : ""}><span>Показывать зоны, которых нет в актуальном чертеже</span></label>
        <span class="v2-muted" id="ze-count" role="status" aria-live="polite">${esc(st.notice || `Найдено ${rows.length} из ${st.rows.length}`)}</span>
        <button type="button" class="v2-btn" id="ze-refresh">Обновить</button>
        ${st.lastEdit ? `<button type="button" class="v2-btn" id="ze-undo">Отменить последнюю правку (зона «${esc(st.lastEdit.name)}»)</button>` : ""}</div>
      ${rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>№</th><th>Название</th>${st.category === "Стоянка" ? "<th>Кран</th>" : ""}<th>Ярусы</th><th class="num">Изделий</th><th>В чертеже</th>${canEdit || canDelete ? "<th></th>" : ""}</tr></thead><tbody>
        ${rows.map((r) => `<tr${r.is_current ? "" : ' class="v2-muted"'}>
          <td>${r.number ?? "—"}</td>
          <td>${canEdit ? `<button type="button" class="v2-link" data-open="${r.id}">${esc(r.name || "без наименования")}</button>` : esc(r.name || "без наименования")}${r.is_current ? "" : " (нет в чертеже)"}</td>
          ${st.category === "Стоянка" ? `<td>${esc(r.parent_name || "не определён")}</td>` : ""}
          <td>${esc(levelsText(r.levels || []))}</td><td class="num">${r.elements}</td><td>${r.is_current ? "да" : "нет"}</td>
          ${canEdit || canDelete ? `<td>${canEdit ? `<button type="button" class="v2-btn" data-open="${r.id}">Править</button>` : ""} ${canDelete ? `<button type="button" class="v2-btn v2-danger" data-del="${r.id}" aria-label="Удалить зону ${esc(r.name || "")}">Удалить</button>` : ""}</td>` : ""}
        </tr>`).join("")}</tbody></table></div>` : `<p class="v2-muted">${q ? "Ничего не найдено по запросу." : `Зон категории «${esc(st.category)}» нет.`}</p>`}`;
    wireTabs();
    $("#ze-search")?.addEventListener("input", (e) => { st.q = e.target.value; st.notice = ""; paintList(); const n = $("#ze-search"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
    $("#ze-retired")?.addEventListener("change", (e) => { st.includeRetired = e.target.checked; st.notice = ""; loadList(); });
    $("#ze-refresh")?.addEventListener("click", () => { st.notice = ""; loadList(); });
    $("#ze-undo")?.addEventListener("click", undoLast);
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openEditor(Number(b.dataset.open))));
    box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteZone(Number(b.dataset.del))));
  }
  function wireTabs() {
    el.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      if (busy) return;
      if (st.category === b.dataset.cat) return;
      st.category = b.dataset.cat; st.rows = null; st.q = ""; st.notice = ""; loadList();
    }));
  }

  async function loadList() {
    if (!objectId) { paint(); return; }
    const my = ++seq;
    const q = new URLSearchParams({ category: st.category, include_retired: String(st.includeRetired) });
    try {
      const data = await api.get(`${spec.endpoint}?${q}`);
      if (dead || my !== seq) return;
      st.rows = data; st.error = "";
    } catch (e) {
      if (dead || my !== seq) return;
      st.rows = null; st.error = errText(e);
    }
    paint();
  }

  // ---------------------------------------------------------------- редактор
  function toDraftLevels(levels) {
    return levels.map((l) => ({ id: l.id, elevation_mm: l.elevation_mm, outline: l.outline.map((p) => [Math.round(p[0]), Math.round(p[1])]) }));
  }
  async function openEditor(zoneId) {
    drop3d(); previewMode = "2d";   // как в V1: каждое открытие формы — с 2D и заново выставленной камерой 3D
    st.editing = { zoneId, loaded: false, error: "", busy: false, activeLevel: 0, activePoint: null };
    paint();
    try {
      const data = await api.get(`/zones/${zoneId}/geometry`);
      if (dead || !st.editing || st.editing.zoneId !== zoneId) return;
      const levels = toDraftLevels(data.levels);
      const base = { number: data.zone.number ?? null, name: data.zone.name ?? "", parentZoneId: data.zone.parent_zone_id ?? null, levels: JSON.parse(JSON.stringify(levels)) };
      st.editing = {
        zoneId, loaded: true, error: "", busy: false, activeLevel: 0, activePoint: null,
        category: data.zone.category, context: data.context, cranes: data.cranes,
        number: base.number, name: base.name, parentZoneId: base.parentZoneId, levels, base,
        status: "",
      };
      paint();
    } catch (e) {
      if (dead || !st.editing || st.editing.zoneId !== zoneId) return;
      st.editing.loaded = false; st.editing.error = errText(e);
      paint();
    }
  }
  function closeEditor() { drop3d(); st.editing = null; paint(); }

  function paintEditor() {
    const ed = st.editing;
    const box = $("#ze-body");
    if (!ed.loaded) {
      box.innerHTML = ed.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось открыть зону.</strong> ${esc(ed.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ze-back">К списку</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#ze-back")?.addEventListener("click", closeEditor);
      return;
    }
    const isStance = ed.category === "Стоянка";
    box.innerHTML = `
      <div class="v2-bar"><button type="button" class="v2-btn" id="ze-back" ${ed.busy ? "disabled" : ""}>← К списку</button>
        <strong>${esc(ed.category)}${ed.name ? " — " + esc(ed.name) : ""}</strong></div>
      <div class="v2-fields" style="margin-top:10px">
        <label class="v2-field">Номер<input type="number" id="ze-number" value="${ed.number ?? ""}" ${ed.busy ? "disabled" : ""}></label>
        <label class="v2-field">Наименование<input type="text" id="ze-name" value="${esc(ed.name)}" maxlength="200" ${ed.busy ? "disabled" : ""}></label>
        ${isStance ? `<label class="v2-field">Кран-владелец<select id="ze-crane" ${ed.busy ? "disabled" : ""}><option value="">не определён</option>${ed.cranes.map((c) => `<option value="${c.id}" ${String(ed.parentZoneId) === String(c.id) ? "selected" : ""}>${esc(c.name || "Кран " + c.number)}</option>`).join("")}</select></label>` : ""}
      </div>
      <!-- Предпросмотр прилипает к верху прокрутки (как в V1: при длинном списке ярусов и точек картинка не уезжает) -->
      <div class="v2-inline" style="margin-top:12px;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <h4 style="margin:0 0 6px">Ярусы</h4>
          <div id="ze-levels"></div>
          <button type="button" class="v2-btn" id="ze-add-level" ${ed.busy ? "disabled" : ""}>+ Ярус</button>
        </div>
        <div style="width:400px;flex:none;position:sticky;top:0;align-self:flex-start;background:var(--bg)">
          <div class="v2-inline" style="margin:0 0 6px;align-items:center"><h4 style="margin:0">Предпросмотр</h4><span style="flex:1"></span>
            <span role="group" aria-label="Вид предпросмотра" class="v2-inline" style="gap:4px">${[["2d", "2D"], ["3d", "3D"]].map(([m, t]) => `<button type="button" class="v2-btn${previewMode === m ? " v2-primary" : ""}" data-pmode="${m}" aria-pressed="${previewMode === m}">${t}</button>`).join("")}</span></div>
          <svg id="ze-preview" viewBox="0 0 400 300" style="width:100%;border:1px solid var(--v2-border,#3332);background:var(--v2-surface,transparent)${previewMode === "3d" ? ";display:none" : ""}"></svg>
          <div id="ze-preview3d" style="width:400px;height:300px;border:1px solid var(--line);background:var(--surface)${previewMode === "3d" ? "" : ";display:none"}"></div>
          <p class="v2-muted" id="ze-preview-hint" style="font-size:12px"></p>
        </div>
      </div>
      <div class="v2-inline" style="margin-top:12px">
        <button type="button" class="v2-btn v2-primary" id="ze-save" ${ed.busy ? "disabled" : ""}>Сохранить</button>
        <button type="button" class="v2-btn" id="ze-cancel" ${ed.busy ? "disabled" : ""}>Отменить правку</button>
      </div>
      <p class="v2-muted" id="ze-status" role="status" aria-live="polite">${esc(ed.status || "")}</p>`;
    $("#ze-back").addEventListener("click", async () => { if (!(await guardEditorLeave())) return; closeEditor(); });
    $("#ze-number").addEventListener("input", (e) => { ed.number = e.target.value === "" ? null : Number(e.target.value); });
    $("#ze-name").addEventListener("input", (e) => { ed.name = e.target.value; });
    $("#ze-crane")?.addEventListener("change", (e) => { ed.parentZoneId = e.target.value ? Number(e.target.value) : null; });
    $("#ze-save").addEventListener("click", saveEditor);
    $("#ze-cancel").addEventListener("click", async () => {
      if (!dirty()) return;
      if (!(await showConfirmDialog("Отменить правку зоны? Введённое будет отброшено.", { confirmLabel: "Отменить правку" }))) return;
      Object.assign(ed, { number: ed.base.number, name: ed.base.name, parentZoneId: ed.base.parentZoneId, levels: JSON.parse(JSON.stringify(ed.base.levels)) });
      paint();
    });
    $("#ze-add-level").addEventListener("click", () => {
      const src = ed.levels[ed.levels.length - 1];
      ed.levels.push({ id: null, elevation_mm: src ? (src.elevation_mm ?? 0) + 1000 : 0, outline: src ? src.outline.map((p) => [p[0], p[1]]) : [[0, 0], [1000, 0], [1000, 1000]] });
      ed.activeLevel = ed.levels.length - 1;
      paint();
    });
    el.querySelectorAll("[data-pmode]").forEach((b) => b.addEventListener("click", () => setPreviewMode(b.dataset.pmode)));
    paintLevels();
    paintPreview();
  }

  function preview3dData() {
    const ed = st.editing;
    return { bbox: ed.context.bbox, siblings: ed.context.siblings, parent: ed.context.parent, levels: ed.levels, activeLevel: ed.activeLevel, activePoint: ed.activePoint };
  }
  function note3d(host) { const i = p3d?.info(); if (host && i) host.dataset.info = JSON.stringify(i); }
  async function setPreviewMode(mode) {
    if (mode === previewMode || !st.editing?.loaded) return;
    previewMode = mode;
    paint();   // перерисовка формы: кнопки, видимость SVG и контейнера 3D; сам холст 3D строит paintPreview
  }
  async function paint3d() {
    const host = $("#ze-preview3d");
    if (!host || !st.editing?.loaded) return;
    if (!p3d) p3d = createZonePreview3d();
    const mine = p3d;
    try {
      const shown = await mine.show(host, preview3dData());
      if (dead || mine !== p3d) return;
      if (shown) note3d(host);
    } catch (e) {
      if (dead || mine !== p3d) return;
      host.textContent = `3D-предпросмотр не загрузился: ${errText(e)}`;
    }
  }

  function paintLevels() {
    const ed = st.editing;
    const box = $("#ze-levels");
    box.innerHTML = ed.levels.map((level, li) => `
      <div style="border:1px solid var(--v2-border,#3332);border-radius:6px;padding:8px;margin-bottom:8px${li === ed.activeLevel ? ";outline:2px solid var(--v2-accent,#2471a3)" : ""}">
        <div class="v2-inline"><label class="v2-field" style="margin:0">Отметка, мм<input type="number" data-elev="${li}" value="${level.elevation_mm ?? ""}" style="width:110px" ${ed.busy ? "disabled" : ""}></label>
          <button type="button" class="v2-btn" data-del-level="${li}" ${ed.levels.length === 1 || ed.busy ? "disabled" : ""}>Удалить ярус</button></div>
        <table style="width:100%;font-size:12px;margin-top:6px"><thead><tr><th style="width:24px"></th><th>X, мм</th><th>Y, мм</th><th></th></tr></thead><tbody>
          ${level.outline.map((p, pi) => `<tr><td class="v2-muted">${pi + 1}</td>
            <td><input type="number" step="1" data-pt="${li}:${pi}:0" value="${p[0]}" style="width:100%" ${ed.busy ? "disabled" : ""}></td>
            <td><input type="number" step="1" data-pt="${li}:${pi}:1" value="${p[1]}" style="width:100%" ${ed.busy ? "disabled" : ""}></td>
            <td><button type="button" class="v2-btn" data-del-pt="${li}:${pi}" ${level.outline.length <= 3 || ed.busy ? "disabled" : ""}>✕</button></td></tr>`).join("")}
        </tbody></table>
        <button type="button" class="v2-btn" data-add-pt="${li}" style="margin-top:6px" ${ed.busy ? "disabled" : ""}>+ Точка</button>
      </div>`).join("");
    box.querySelectorAll("input[data-pt]").forEach((inp) => {
      const [li, pi, ax] = inp.dataset.pt.split(":").map(Number);
      inp.addEventListener("input", () => { const v = Number(inp.value); if (!Number.isFinite(v)) return; st.editing.levels[li].outline[pi][ax] = v; st.editing.activeLevel = li; st.editing.activePoint = pi; paintPreview(); });
      inp.addEventListener("focus", () => { st.editing.activeLevel = li; st.editing.activePoint = pi; paintPreview(); });
    });
    box.querySelectorAll("input[data-elev]").forEach((inp) => inp.addEventListener("input", () => { const li = Number(inp.dataset.elev); st.editing.levels[li].elevation_mm = inp.value === "" ? null : Number(inp.value); if (previewMode === "3d") paintPreview(); }));
    box.querySelectorAll("[data-del-pt]").forEach((b) => b.addEventListener("click", () => { const [li, pi] = b.dataset.delPt.split(":").map(Number); st.editing.levels[li].outline.splice(pi, 1); paintLevels(); paintPreview(); }));
    box.querySelectorAll("[data-add-pt]").forEach((b) => b.addEventListener("click", () => {
      const li = Number(b.dataset.addPt), outline = st.editing.levels[li].outline, last = outline[outline.length - 1], first = outline[0];
      outline.push([(last[0] + first[0]) / 2, (last[1] + first[1]) / 2]);
      paintLevels(); paintPreview();
    }));
    box.querySelectorAll("[data-del-level]").forEach((b) => b.addEventListener("click", () => { st.editing.levels.splice(Number(b.dataset.delLevel), 1); if (st.editing.activeLevel >= st.editing.levels.length) st.editing.activeLevel = st.editing.levels.length - 1; paintLevels(); paintPreview(); }));
  }

  function paintPreview() {
    const ed = st.editing;
    if (previewMode === "3d") {
      const level = ed.levels[ed.activeLevel];
      const hint = $("#ze-preview-hint");
      if (hint) hint.textContent = `Ярус ${ed.activeLevel + 1}${level && level.elevation_mm != null ? ` (отм. +${level.elevation_mm})` : " (без отметки)"}. Объём яруса — от его отметки до следующего; красным — кран-владелец, серым — соседние зоны той же категории. Вращение — перетаскивание мышью, масштаб — колесо.`;
      paint3d();
      return;
    }
    const svg = $("#ze-preview");
    if (!svg) return;
    const bbox = ed.context.bbox;
    if (!bbox) { svg.innerHTML = ""; return; }
    let [minX, minY, maxX, maxY] = bbox;
    for (const level of ed.levels) for (const p of level.outline) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.03 || 10;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const W = 400, H = 300;
    const scale = Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
    const offX = (W - (maxX - minX) * scale) / 2, offY = (H - (maxY - minY) * scale) / 2;
    const sx = (x) => offX + (x - minX) * scale, sy = (y) => H - offY - (y - minY) * scale;
    const poly = (outline, attrs) => `<polygon points="${outline.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")}" ${attrs}/>`;
    const parts = [`<rect x="0" y="0" width="${W}" height="${H}" fill="none"/>`];
    for (const axis of ed.context.axes || []) {
      parts.push(axis.kind === "numeric"
        ? `<line x1="${sx(axis.coord).toFixed(1)}" y1="0" x2="${sx(axis.coord).toFixed(1)}" y2="${H}" stroke="currentColor" stroke-width="0.5" opacity="0.35"/>`
        : `<line x1="0" y1="${sy(axis.coord).toFixed(1)}" x2="${W}" y2="${sy(axis.coord).toFixed(1)}" stroke="currentColor" stroke-width="0.5" opacity="0.35"/>`);
    }
    for (const sib of ed.context.siblings || []) parts.push(poly(sib.outline, 'fill="#888" fill-opacity="0.06" stroke="#888" stroke-opacity="0.3" stroke-width="0.7"'));
    for (const level of ed.context.parent || []) parts.push(poly(level.outline, 'fill="none" stroke="#c0392b" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="4 3"'));
    ed.levels.forEach((level, li) => {
      const active = li === ed.activeLevel;
      parts.push(poly(level.outline, `fill="#2471a3" fill-opacity="${active ? 0.22 : 0.08}" stroke="#2471a3" stroke-opacity="${active ? 1 : 0.4}" stroke-width="${active ? 1.6 : 1}"`));
      if (active) {
        const cx0 = level.outline.reduce((a, p) => a + sx(p[0]), 0) / level.outline.length;
        const cy0 = level.outline.reduce((a, p) => a + sy(p[1]), 0) / level.outline.length;
        level.outline.forEach((p, pi) => {
          const cur = pi === ed.activePoint, cx = sx(p[0]), cy = sy(p[1]);
          parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${cur ? 4 : 2.5}" fill="${cur ? "#d68910" : "#2471a3"}"/>`);
          const dx = cx - cx0, dy = cy - cy0, len = Math.hypot(dx, dy) || 1;
          parts.push(`<text x="${(cx + (dx / len) * 9).toFixed(1)}" y="${(cy + (dy / len) * 9 + 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="${cur ? "#d68910" : "#2471a3"}" font-weight="${cur ? "700" : "400"}">${pi + 1}</text>`);
        });
      }
    });
    svg.innerHTML = parts.join("");
    const level = ed.levels[ed.activeLevel];
    $("#ze-preview-hint").textContent = `Ярус ${ed.activeLevel + 1}${level && level.elevation_mm != null ? ` (отм. +${level.elevation_mm})` : " (без отметки)"}. Пунктиром — кран-владелец, бледным — соседние зоны той же категории.`;
  }

  async function saveEditor() {
    const ed = st.editing;
    if (ed.busy) return;
    for (const level of ed.levels) {
      if (level.outline.length < 3) { ed.status = "У каждого яруса должно быть хотя бы три точки."; paint(); return; }
    }
    ed.busy = true; ed.status = "Сохранение…"; paint();
    const body = { number: ed.number, name: ed.name || null, parent_zone_id: ed.category === "Стоянка" ? ed.parentZoneId : null, levels: ed.levels.map((l) => ({ id: l.id, elevation_mm: l.elevation_mm, outline: l.outline })) };
    try {
      const r = await api.patch(`/zones/${ed.zoneId}`, body);
      st.lastEdit = { zoneId: ed.zoneId, name: r.name || ed.name };
      drop3d();
      st.editing = null;
      await loadList();
      setStatusAfterList(r.recalc_refused
        ? `Зона сохранена, но привязка не пересчитана: ${r.recalc_refused}`
        : `Зона сохранена. Пересчитана привязка ${r.recalculated} ${r.recalculated === 1 ? "элемента" : "элементов"}.`);
    } catch (e) {
      ed.busy = false;
      ed.status = errText(e);
      paint();
    }
  }
  // Итог операции — на месте счётчика списка и в состоянии экрана: переживает перерисовку (раньше сообщение об удалении стиралось
  // перерисовкой сразу после показа); снимается следующим действием со списком (вкладка, поиск, обновление).
  function setStatusAfterList(text) {
    st.notice = text;
    const n = $("#ze-count");
    if (n) n.textContent = text;
  }

  async function guardEditorLeave() {
    if (!dirty()) return true;
    const c = await showUnsavedDialog("В правке зоны есть несохранённые изменения. Что сделать?");
    if (c === "cancel") return false;
    if (c === "discard") return true;
    await saveEditor();
    return !st.editing;
  }

  async function undoLast() {
    if (!st.lastEdit || busy) return;
    if (!(await showConfirmDialog("Отменить последнюю правку зоны? Вернутся и координаты точек, и привязка изделий.", { confirmLabel: "Отменить правку" }))) return;
    busy = true; paint();
    try {
      const r = await api.post(`/zones/${st.lastEdit.zoneId}/undo`);
      st.lastEdit = null;
      await loadList();
      setStatusAfterList(`Правка отменена: ярусов ${r.levels}, привязок восстановлено ${r.elements}.`);
    } catch (e) {
      busy = false;
      await loadList();
      setStatusAfterList(errText(e));
    }
    busy = false;
  }

  async function deleteZone(zoneId) {
    if (busy) return;
    busy = true;
    try {
      const result = await runDeleteFlow({ api, kind: "zone", id: zoneId });
      if (result === "deleted") { await loadList(); setStatusAfterList("Зона удалена."); }
      else if (result === "exists") { await loadList(); setStatusAfterList("Зона осталась на месте (ответ сервера не дошёл) — повторите удаление вручную."); }
      else if (result === "unknown") { await loadList(); setStatusAfterList("Неизвестно, удалена ли зона — проверьте список."); }
    } finally { busy = false; if (!st.editing) paint(); }
  }

  function paint() {
    if (dead) return;
    if (st.editing) paintEditor(); else paintList();
  }

  paint();
  loadList();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() { return guardEditorLeave(); },
    destroy() { dead = true; drop3d(); },
  };
}
