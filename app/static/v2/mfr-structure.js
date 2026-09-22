// «Блоки» — вкладка экрана «Учёт по блокам» (mfr2, перенос из V1): секции, этажи, блоки (клетки матрицы секция×этаж) — создание,
// правка, удаление; геометрия блока набором прямоугольников с предпросмотром на плане; «Обновить принадлежность». Права и API — те
// же, что у V1 (`app/blocks.py`, раздел «blocks», запись). Без модального окна (V1 — модалка «Учёт по блокам»): содержимое прямо в
// теле вкладки, внутренняя прокрутка.
//
// Барьер безопасности данных:
//  * удаление секции/этажа/блока — сначала сервер (без `force`), при 409 показывается ТОЧНЫЙ план (что удалится каскадом — блоки со
//    сроками/фактом, что потеряет привязку — элементы модели/помещения), подтверждение, повтор с `?force=true`; неиспользуемая
//    запись удаляется без вопросов (терять нечего);
//  * привязка секции к осям (Docs/TZ.md «Геометрия блока») в V2 НЕ редактируется — переименование пересылает ось как есть, иначе PATCH
//    стёр бы уже заданную привязку (`app/blocks.py::update_section` перезаписывает обе оси при каждом вызове);
//  * геометрия блока — полный набор прямоугольников разом (форма всегда шлёт весь список, как V1); предупреждение о пересечении с
//    соседней секцией от сервера не блокирует сохранение (мягкая проверка, как в V1);
//  * неизвестный исход (обрыв/5xx) не повторяется — список перечитывается, ответ по факту.
import { esc, errText, unknownOutcome } from "./mfr-common.js";
import { showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const LEVEL_KIND_LABEL = { "этаж": "этаж", "подземный": "подземный этаж", "кровля": "кровля" };

export function mountStructureTab(host, { api, objectId, canWrite, onChanged }) {
  let dead = false;
  const st = {
    loading: true, error: "",
    sections: [], levels: [], blocks: [],
    status: "", statusBad: false,
    recalcBusy: false, recalcReport: "",
    addSec: { code: "", name: "" },
    addLvl: { kind: "этаж", floor: "", name: "", elevation: "", sectionCodes: new Set() },
    geo: null,   // {blockId, sectionCode, levelId, levelName, boxes, others, floorMode, loading, error, warnings, dirty}
    busy: false,
  };
  const $ = (s) => host.querySelector(s);
  const setStatus = (t, bad = false) => { st.status = t; st.statusBad = bad; const n = $("#st-status"); if (n) { n.textContent = t; n.style.color = bad ? "var(--bad)" : "var(--good)"; } };

  async function load() {
    st.loading = true; st.error = ""; paint();
    try {
      const [sections, levels, blocks] = await Promise.all([
        api.get(`/objects/${objectId}/sections`), api.get(`/objects/${objectId}/levels`), api.get(`/objects/${objectId}/blocks`),
      ]);
      if (dead) return;
      st.sections = sections; st.levels = levels; st.blocks = blocks; st.loading = false;
    } catch (e) { if (dead) return; st.loading = false; st.error = errText(e); }
    paint();
  }

  async function afterWrite() { await load(); onChanged?.(); }

  // ---- удаление по плану последствий (409 UsageWarning -> подтверждение -> force=true) ----
  async function deleteWithPlan(basePath, whatLabel) {
    try { await api.delete(basePath); return "deleted"; }
    catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.rawDetail && typeof err.rawDetail === "object" && err.rawDetail.message) {
        const ok = await showConfirmDialog(`${err.rawDetail.message}\n\nПродолжить?`, { confirmLabel: "Удалить", danger: true, multiline: true });
        if (!ok) return "cancelled";
        try { await api.delete(`${basePath}?force=true`); return "deleted"; }
        catch (err2) { return reportDeleteFailure(err2, whatLabel); }
      }
      return reportDeleteFailure(err, whatLabel);
    }
  }
  async function reportDeleteFailure(err, whatLabel) {
    if (err instanceof ApiError && err.status === 404) { await load(); return "deleted"; }  // уже удалено кем-то другим
    if (unknownOutcome(err)) { await showInfoDialog(`Ответ сервера не получен — неизвестно, удалён ли ${whatLabel}. Список сейчас перечитан.`); await load(); return "unknown"; }
    throw err;
  }

  // ---------------------------------------------------------------- секции
  async function addSection() {
    const code = st.addSec.code.trim();
    if (!code) return;
    st.busy = true; paint();
    try {
      await api.post(`/objects/${objectId}/sections`, { code, name: st.addSec.name.trim() || null });
      st.addSec = { code: "", name: "" };
      setStatus(`Секция «${code}» добавлена`);
      await afterWrite();
    } catch (e) { setStatus(errText(e), true); }
    st.busy = false; paint();
  }
  async function saveSection(s, name) {
    const trimmed = name.trim();
    if (!trimmed) { setStatus("Подпись секции не может быть пустой", true); paint(); return; }
    try {
      await api.patch(`/objects/${objectId}/sections/${s.id}`, { name: trimmed, axis_from: s.axis_from, axis_to: s.axis_to });
      setStatus(`Секция «${s.code}» сохранена`);
      await afterWrite();
    } catch (e) { setStatus(`Секция «${s.code}»: ${errText(e)}`, true); await load(); }
  }
  async function deleteSection(s) {
    const r = await deleteWithPlan(`/objects/${objectId}/sections/${s.id}`, "секция");
    if (r === "deleted") { setStatus(`Секция «${s.code}» удалена`); await afterWrite(); }
    else paint();
  }

  // ----------------------------------------------------------------- этажи
  async function addLevel() {
    const a = st.addLvl;
    const body = { kind: a.kind, name: a.name.trim() || null, elevation_mm: a.elevation !== "" ? Number(a.elevation) : null, section_codes: [] };
    if (a.kind === "кровля") {
      body.section_codes = [...a.sectionCodes];
      if (!body.section_codes.length) { setStatus("Отметьте хотя бы одну секцию для кровли", true); paint(); return; }
      body.floor = null;
    } else {
      if (a.floor === "" || !Number.isFinite(Number(a.floor))) { setStatus("Укажите номер этажа", true); paint(); return; }
      body.floor = Math.trunc(Number(a.floor));
    }
    st.busy = true; paint();
    try {
      await api.post(`/objects/${objectId}/levels`, body);
      st.addLvl = { kind: "этаж", floor: "", name: "", elevation: "", sectionCodes: new Set() };
      setStatus("Этаж добавлен");
      await afterWrite();
    } catch (e) { setStatus(errText(e), true); }
    st.busy = false; paint();
  }
  async function saveLevel(l, field, raw) {
    if (field !== "name" && raw !== "" && !Number.isFinite(Number(raw))) { setStatus(`Этаж «${l.name || l.key}»: нужно число, мм`, true); paint(); return; }
    if (field !== "name" && raw === "") { await load(); return; }   // пустое поле не пишем — как в V1
    const body = { [field]: field === "name" ? raw.trim() : Number(raw) };
    try {
      await api.patch(`/objects/${objectId}/levels/${l.id}`, body);
      setStatus(`Этаж «${l.name || l.key}» сохранён`);
      await afterWrite();
    } catch (e) { setStatus(`Этаж «${l.name || l.key}»: ${errText(e)}`, true); await load(); }
  }
  async function deleteLevel(l) {
    const r = await deleteWithPlan(`/objects/${objectId}/levels/${l.id}`, "этаж");
    if (r === "deleted") { setStatus(`Этаж «${l.name || l.key}» удалён`); await afterWrite(); }
    else paint();
  }

  // ---------------------------------------------------------------- блоки (матрица)
  const blockAt = (secId, lvlId) => st.blocks.find((b) => b.section_id === secId && b.level_id === lvlId);
  async function toggleCell(sec, lvl) {
    if (blockAt(sec.id, lvl.id)) return;  // занятую клетку не создаём повторно — открывает геометрию
    try {
      await api.post(`/objects/${objectId}/blocks`, { section_id: sec.id, level_id: lvl.id });
      setStatus(`Блок «${sec.code} · ${lvl.name || lvl.key}» создан`);
      await afterWrite();
    } catch (e) { setStatus(errText(e), true); paint(); }
  }
  async function deleteBlock(b) {
    const r = await deleteWithPlan(`/objects/${objectId}/blocks/${b.id}`, "блок");
    if (r === "deleted") {
      if (st.geo?.blockId === b.id) st.geo = null;
      setStatus(`Блок «${b.section_code} · ${b.level_name || b.floor}» удалён`);
      await afterWrite();
    } else paint();
  }
  async function recalcMembership() {
    st.recalcBusy = true; st.recalcReport = "Считаю…"; paint();
    try {
      const r = await api.post(`/objects/${objectId}/blocks/recalc-membership`);
      const lines = [
        `Этажей назначено: ${r.этажей_назначено} (без этажа осталось: ${r.этажей_осталось})`,
        `Секций назначено: ${r.секций_назначено} (без секции осталось: ${r.секций_осталось})`,
      ];
      if (r.конфликтов) lines.push(`Расхождений параметра модели с геометрией: ${r.конфликтов}`);
      if (r.перебито_у_параметра) lines.push(`Из них перебито у параметра модели геометрией блока: ${r.перебито_у_параметра}`);
      if (r.без_геометрии?.length) lines.push(`Без геометрии, в пересчёте не участвуют: ${r.без_геометрии.join(", ")}`);
      st.recalcReport = lines.join("\n");
      await afterWrite();
    } catch (e) { st.recalcReport = `Не удалось пересчитать: ${errText(e)}`; }
    st.recalcBusy = false; paint();
  }

  // ---------------------------------------------------------------- геометрия блока
  function geoBounds(g) {
    const all = [...g.boxes, ...g.others.flatMap((o) => o.boxes)];
    if (!all.length) return { minX: 0, minY: 0, w: 10000, h: 10000, strokeW: 40 };
    const margin = 1500;
    const minX = Math.min(...all.map((b) => b.x0)) - margin, maxX = Math.max(...all.map((b) => b.x1)) + margin;
    const minY = Math.min(...all.map((b) => b.y0)) - margin, maxY = Math.max(...all.map((b) => b.y1)) + margin;
    const w = maxX - minX, h = maxY - minY, scale = Math.max(w, h);
    return { minX, minY, w, h, strokeW: Math.max(scale / 300, 30) };
  }
  function geoSvg(g) {
    const { minX, minY, w, h, strokeW } = geoBounds(g);
    const toSvgY = (y) => h - (y - minY);
    const fontSize = Math.max(w, h) / 55;
    const others = g.others.flatMap((o) => o.boxes.map((b) => `
      <rect x="${b.x0 - minX}" y="${toSvgY(b.y1)}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="var(--muted)" fill-opacity="0.18" stroke="var(--muted)" stroke-opacity="0.6" stroke-width="${strokeW}"/>
      <text x="${b.x0 - minX + fontSize * 0.3}" y="${toSvgY(b.y1) + fontSize}" font-size="${fontSize}" fill="var(--muted)">${esc(o.секция)}</text>`).join(""));
    const mine = g.boxes.map((b) => `<rect x="${b.x0 - minX}" y="${toSvgY(b.y1)}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="var(--accent)" fill-opacity="0.3" stroke="var(--accent)" stroke-width="${strokeW}"/>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:220px;background:var(--surface);border:1px solid var(--line);border-radius:8px" preserveAspectRatio="xMidYMid meet">${others}${mine}</svg>`;
  }
  async function openGeometry(b) {
    const sec = st.sections.find((s) => s.id === b.section_id);
    st.geo = { blockId: b.id, sectionCode: sec?.code || b.section_code, levelId: b.level_id, levelName: b.level_name || (b.floor + " этаж"), floorMode: false, loading: true, error: "", warnings: "", dirty: false, boxes: [], others: [] };
    paint();
    try {
      const [boxes, geometry] = await Promise.all([
        api.get(`/objects/${objectId}/blocks/${b.id}/boxes`), api.get(`/objects/${objectId}/blocks/geometry?level_id=${b.level_id}`),
      ]);
      if (dead || st.geo?.blockId !== b.id) return;
      st.geo.boxes = boxes.map((x) => ({ x0: x.x0, x1: x.x1, y0: x.y0, y1: x.y1 }));
      if (!st.geo.boxes.length) { const mine = geometry.find((g) => g.id === b.id); if (mine?.ok) st.geo.boxes = mine.boxes.map((x) => ({ ...x })); }
      st.geo.others = geometry.filter((g) => g.id !== b.id && g.ok).map((g) => ({ секция: g["секция"], boxes: g.boxes }));
      st.geo.loading = false;
    } catch (e) { if (dead || st.geo?.blockId !== b.id) return; st.geo.loading = false; st.geo.error = errText(e); }
    paint();
  }
  async function openFloorView(l) {
    st.geo = { blockId: null, sectionCode: "", levelId: l.id, levelName: l.name || l.key, floorMode: true, loading: true, error: "", warnings: "", dirty: false, boxes: [], others: [] };
    paint();
    try {
      const geometry = await api.get(`/objects/${objectId}/blocks/geometry?level_id=${l.id}`);
      if (dead || st.geo?.levelId !== l.id || !st.geo.floorMode) return;
      st.geo.others = geometry.filter((g) => g.ok).map((g) => ({ секция: g["секция"], boxes: g.boxes }));
      st.geo.loading = false;
    } catch (e) { if (dead || st.geo?.levelId !== l.id) return; st.geo.loading = false; st.geo.error = errText(e); }
    paint();
  }
  async function saveGeometry() {
    const g = st.geo;
    for (const b of g.boxes) { if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) { g.warnings = "x1 должен быть больше x0, y1 — больше y0"; paintGeo(); return; } }
    st.busy = true; paintGeo();
    try {
      const res = await api.put(`/objects/${objectId}/blocks/${g.blockId}/boxes`, { boxes: g.boxes });
      g.warnings = (res.warnings || []).length ? res.warnings.join("; ") : "Геометрия сохранена.";
      g.dirty = false;
      await afterWrite();
      const still = st.geo; if (still) { still.warnings = g.warnings; }
    } catch (e) { g.warnings = errText(e); }
    st.busy = false; paint();
  }

  // ------------------------------------------------------------------ отрисовка
  function paint() {
    if (dead) return;
    if (st.loading) { host.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    if (st.error) { host.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="st-retry">Повторить</button></div></div>`; $("#st-retry").addEventListener("click", load); return; }
    const grids = 0; // привязка к осям не редактируется в V2 — колонки осей не показываем
    host.innerHTML = `
      <p class="v2-muted mfr-hint">Этаж — общая запись объекта (как в модели Revit); кровля — исключение, у каждой секции своя. Блоки — НЕ декартово произведение секций и этажей: отмечайте клетки матрицы явно.</p>
      <p id="st-status" class="mfr-status" role="status" aria-live="polite" style="color:${st.statusBad ? "var(--bad)" : "var(--good)"}">${esc(st.status)}</p>
      <div class="mfr-struct-cols">
        <section aria-label="Секции"><h4>Секции</h4>
          ${canWrite ? `<div class="v2-bar"><input type="text" id="st-sec-code" class="v2-search" placeholder="С01 / Секция 1 / 1" value="${esc(st.addSec.code)}" style="max-width:140px" ${st.busy ? "disabled" : ""}>
            <input type="text" id="st-sec-name" class="v2-search" placeholder="Подпись (необязательно)" value="${esc(st.addSec.name)}" ${st.busy ? "disabled" : ""}>
            <button type="button" class="v2-btn v2-primary" id="st-sec-add" ${st.busy ? "disabled" : ""}>Добавить</button></div>` : ""}
          <div class="mfr-scroll" style="max-height:220px">${sectionsTable()}</div>
        </section>
        <section aria-label="Этажи"><h4>Этажи</h4>
          ${canWrite ? `<div class="v2-bar" style="flex-wrap:wrap">
            <select id="st-lvl-kind" ${st.busy ? "disabled" : ""}>${Object.entries(LEVEL_KIND_LABEL).map(([k, t]) => `<option value="${k}" ${st.addLvl.kind === k ? "selected" : ""}>${t}</option>`).join("")}</select>
            ${st.addLvl.kind === "кровля"
              ? `<span>${st.sections.map((s) => `<label class="mfr-chk"><input type="checkbox" data-roof-sec="${s.code}" ${st.addLvl.sectionCodes.has(s.code) ? "checked" : ""}> ${esc(s.code)}</label>`).join("") || `<span class="v2-muted">сначала заведите секцию</span>`}</span>`
              : `<input type="number" id="st-lvl-floor" placeholder="номер" value="${esc(st.addLvl.floor)}" style="max-width:90px" ${st.busy ? "disabled" : ""}>`}
            <input type="text" id="st-lvl-name" class="v2-search" placeholder="Подпись (необязательно)" value="${esc(st.addLvl.name)}" style="max-width:180px" ${st.busy ? "disabled" : ""}>
            <input type="number" id="st-lvl-elev" placeholder="отметка, мм" value="${esc(st.addLvl.elevation)}" style="max-width:120px" ${st.busy ? "disabled" : ""}>
            <button type="button" class="v2-btn v2-primary" id="st-lvl-add" ${st.busy ? "disabled" : ""}>Добавить</button></div>` : ""}
          <div class="mfr-scroll" style="max-height:220px">${levelsTable()}</div>
        </section>
      </div>
      ${canWrite ? `<div class="v2-bar" style="margin-top:10px"><button type="button" class="v2-btn" id="st-recalc" ${st.recalcBusy ? "disabled" : ""}>Обновить принадлежность</button>
        <span class="v2-muted" style="white-space:pre-line">${esc(st.recalcReport)}</span></div>` : ""}
      <h4 style="margin-top:14px">Блоки — матрица секция × этаж</h4>
      <div class="mfr-scroll">${matrixTable()}</div>
      <div id="st-geo"></div>`;
    bindStatic();
    paintGeo();
  }

  function sectionsTable() {
    if (!st.sections.length) return `<p class="v2-muted">Секций ещё нет.</p>`;
    return `<table class="v2-read-tbl"><thead><tr><th>Код</th><th>Подпись</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
      ${st.sections.map((s) => `<tr data-sec-row="${s.id}"><td>${esc(s.code)}</td>
        <td>${canWrite ? `<input type="text" class="mfr-inline" data-sec-name="${s.id}" value="${esc(s.name || "")}" ${st.busy ? "disabled" : ""}>` : esc(s.name || "")}</td>
        ${canWrite ? `<td><button type="button" class="v2-link-btn" data-sec-del="${s.id}" ${st.busy ? "disabled" : ""}>удалить</button></td>` : ""}</tr>`).join("")}
      </tbody></table>`;
  }
  function levelsTable() {
    if (!st.levels.length) return `<p class="v2-muted">Этажей ещё нет.</p>`;
    return `<table class="v2-read-tbl"><thead><tr><th>Этаж</th><th>Вид</th><th class="num">Отметка, мм</th><th class="num">Высота, мм</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
      ${st.levels.map((l) => `<tr data-lvl-row="${l.id}"><td>${canWrite ? `<input type="text" class="mfr-inline" data-lvl-field="name" value="${esc(l.name || l.key)}" ${st.busy ? "disabled" : ""}>` : esc(l.name || l.key)}</td>
        <td>${esc(LEVEL_KIND_LABEL[l.kind] || l.kind)}</td>
        <td class="num">${canWrite ? `<input type="number" class="mfr-inline num" data-lvl-field="elevation_mm" value="${l.elevation_mm != null ? l.elevation_mm : ""}" placeholder="—" ${st.busy ? "disabled" : ""}>` : esc(l.elevation_mm ?? "—")}</td>
        <td class="num">${canWrite ? `<input type="number" class="mfr-inline num" data-lvl-field="height_mm" value="${l.height_mm != null ? l.height_mm : ""}" placeholder="по соседям" ${st.busy ? "disabled" : ""}>` : esc(l.height_mm ?? "—")}</td>
        ${canWrite ? `<td><button type="button" class="v2-link-btn" data-lvl-del="${l.id}" ${st.busy ? "disabled" : ""}>удалить</button></td>` : ""}</tr>`).join("")}
      </tbody></table>`;
  }
  function matrixTable() {
    if (!st.sections.length || !st.levels.length) return `<p class="v2-muted">Сначала заведите секции и этажи.</p>`;
    const rows = st.levels.map((l) => `<tr><th class="mfr-struct-rowname" data-lvl-view="${l.id}" title="Показать все блоки этажа">${esc(l.name || l.key)}</th>
      ${st.sections.map((s) => {
        const b = blockAt(s.id, l.id);
        return `<td class="mfr-struct-cell${b ? " on" : ""}" data-sec="${s.id}" data-lvl="${l.id}" ${b ? `data-block-id="${b.id}"` : ""}>
          ${b ? `<button type="button" class="v2-link-btn" data-geo-open="${b.id}" title="Геометрия блока">✎</button>${canWrite ? `<button type="button" class="v2-link-btn" data-block-del="${b.id}" title="Удалить блок">✕</button>` : ""}` : (canWrite ? `<button type="button" class="v2-link-btn" data-cell-toggle data-sec="${s.id}" data-lvl="${l.id}">+</button>` : "—")}
        </td>`;
      }).join("")}</tr>`).join("");
    return `<table id="mfr-struct-matrix"><thead><tr><th>Этаж \\ Секция</th>${st.sections.map((s) => `<th>${esc(s.code)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  function paintGeo() {
    const box = $("#st-geo");
    if (!box) return;
    const g = st.geo;
    if (!g) { box.innerHTML = ""; return; }
    if (g.loading) { box.innerHTML = `<div class="mfr-struct-geo"><p class="v2-muted" role="status">Загрузка геометрии…</p></div>`; return; }
    if (g.error) { box.innerHTML = `<div class="mfr-struct-geo"><div class="v2-callout v2-callout-bad" role="alert">${esc(g.error)}</div></div>`; return; }
    box.innerHTML = `<div class="mfr-struct-geo">
      <div class="v2-bar" style="justify-content:space-between"><h4 style="margin:0">${g.floorMode ? `Блоки этажа: ${esc(g.levelName)}` : `Геометрия блока: ${esc(g.sectionCode)} · ${esc(g.levelName)}`}</h4><button type="button" class="v2-btn" id="st-geo-close">Закрыть</button></div>
      ${geoSvg(g)}
      ${g.floorMode ? `<p class="v2-muted mfr-hint">Показаны все занятые блоки этого этажа. Для правки геометрии одного блока закройте окно и нажмите «✎» у нужной клетки.</p>` : `
        <div id="st-geo-boxes">${g.boxes.map((b, i) => `<div class="mfr-struct-boxrow" data-box-i="${i}">
          ${["x0", "x1", "y0", "y1"].map((k) => `<input type="number" class="mfr-inline num" data-box-i="${i}" data-field="${k}" value="${Math.round(b[k])}" ${!canWrite || st.busy ? "disabled" : ""}>`).join("")}
          ${canWrite ? `<button type="button" class="v2-link-btn" data-box-remove="${i}" ${st.busy ? "disabled" : ""}>удалить</button>` : ""}
        </div>`).join("") || `<p class="v2-muted">Прямоугольников нет — блок считается по осям секции.</p>`}</div>
        ${canWrite ? `<div class="v2-bar"><button type="button" class="v2-btn" id="st-geo-add" ${st.busy ? "disabled" : ""}>Добавить прямоугольник</button>
          <button type="button" class="v2-btn" id="st-geo-reset" ${st.busy ? "disabled" : ""}>По осям (сбросить)</button>
          <button type="button" class="v2-btn v2-primary" id="st-geo-save" ${st.busy ? "disabled" : ""}>Сохранить</button></div>` : ""}
        <p class="mfr-status ${g.warnings && /^x1|Упирается|Не удалось/.test(g.warnings) ? "bad" : "ok"}" role="status">${esc(g.warnings)}</p>`}
      </div>`;
    box.querySelector("#st-geo-close")?.addEventListener("click", () => { st.geo = null; paintGeo(); });
    if (!g.floorMode) {
      box.querySelectorAll("[data-box-i]").forEach((inp) => inp.addEventListener("change", () => {
        const i = Number(inp.dataset.boxI), field = inp.dataset.field, v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        g.boxes[i][field] = v; g.dirty = true; paintGeo();
      }));
      box.querySelectorAll("[data-box-remove]").forEach((btn) => btn.addEventListener("click", () => { g.boxes.splice(Number(btn.dataset.boxRemove), 1); g.dirty = true; paintGeo(); }));
      box.querySelector("#st-geo-add")?.addEventListener("click", () => {
        const { minX, minY, w, h } = geoBounds(g); const size = Math.min(w, h) * 0.2 || 3000;
        g.boxes.push({ x0: minX + w * 0.4, x1: minX + w * 0.4 + size, y0: minY + h * 0.4, y1: minY + h * 0.4 + size }); g.dirty = true; paintGeo();
      });
      box.querySelector("#st-geo-reset")?.addEventListener("click", () => { g.boxes = []; g.dirty = true; paintGeo(); });
      box.querySelector("#st-geo-save")?.addEventListener("click", saveGeometry);
    }
  }
  function bindStatic() {
    $("#st-sec-code")?.addEventListener("input", (e) => { st.addSec.code = e.target.value; });
    $("#st-sec-name")?.addEventListener("input", (e) => { st.addSec.name = e.target.value; });
    $("#st-sec-add")?.addEventListener("click", addSection);
    host.querySelectorAll("[data-sec-name]").forEach((inp) => inp.addEventListener("change", () => {
      const s = st.sections.find((x) => x.id === Number(inp.dataset.secName)); if (s) saveSection(s, inp.value);
    }));
    host.querySelectorAll("[data-sec-del]").forEach((btn) => btn.addEventListener("click", () => {
      const s = st.sections.find((x) => x.id === Number(btn.dataset.secDel)); if (s) deleteSection(s);
    }));
    $("#st-lvl-kind")?.addEventListener("change", (e) => { st.addLvl.kind = e.target.value; paint(); });
    $("#st-lvl-floor")?.addEventListener("input", (e) => { st.addLvl.floor = e.target.value; });
    $("#st-lvl-name")?.addEventListener("input", (e) => { st.addLvl.name = e.target.value; });
    $("#st-lvl-elev")?.addEventListener("input", (e) => { st.addLvl.elevation = e.target.value; });
    $("#st-lvl-add")?.addEventListener("click", addLevel);
    host.querySelectorAll("[data-roof-sec]").forEach((c) => c.addEventListener("change", (e) => { e.target.checked ? st.addLvl.sectionCodes.add(c.dataset.roofSec) : st.addLvl.sectionCodes.delete(c.dataset.roofSec); }));
    host.querySelectorAll("[data-lvl-field]").forEach((inp) => inp.addEventListener("change", () => {
      const l = st.levels.find((x) => x.id === Number(inp.closest("[data-lvl-row]").dataset.lvlRow)); if (l) saveLevel(l, inp.dataset.lvlField, inp.value);
    }));
    host.querySelectorAll("[data-lvl-del]").forEach((btn) => btn.addEventListener("click", () => {
      const l = st.levels.find((x) => x.id === Number(btn.dataset.lvlDel)); if (l) deleteLevel(l);
    }));
    $("#st-recalc")?.addEventListener("click", recalcMembership);
    host.querySelectorAll("[data-cell-toggle]").forEach((btn) => btn.addEventListener("click", () => {
      const s = st.sections.find((x) => x.id === Number(btn.dataset.sec)), l = st.levels.find((x) => x.id === Number(btn.dataset.lvl));
      if (s && l) toggleCell(s, l);
    }));
    host.querySelectorAll("[data-geo-open]").forEach((btn) => btn.addEventListener("click", () => {
      const b = st.blocks.find((x) => x.id === Number(btn.dataset.geoOpen)); if (b) openGeometry(b);
    }));
    host.querySelectorAll("[data-block-del]").forEach((btn) => btn.addEventListener("click", () => {
      const b = st.blocks.find((x) => x.id === Number(btn.dataset.blockDel)); if (b) deleteBlock(b);
    }));
    host.querySelectorAll("[data-lvl-view]").forEach((th) => th.addEventListener("click", () => {
      const l = st.levels.find((x) => x.id === Number(th.dataset.lvlView)); if (l) openFloorView(l);
    }));
  }

  load();
  return {
    refresh: load,
    destroy() { dead = true; },
  };
}
