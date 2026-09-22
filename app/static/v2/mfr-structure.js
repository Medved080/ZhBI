// «Блоки» — вкладка экрана «Учёт по блокам» (mfr2, перенос из V1): секции, этажи, блоки (клетки матрицы секция×этаж) — создание,
// правка, удаление; геометрия блока набором прямоугольников с предпросмотром на плане; «Обновить принадлежность». Права и API — те
// же, что у V1 (`app/blocks.py`, раздел «blocks», запись). Без модального окна (V1 — модалка «Учёт по блокам»): содержимое прямо в
// теле вкладки, внутренняя прокрутка.
//
// Барьер безопасности данных:
//  * удаление секции/этажа/блока — сначала сервер (без `force`), при 409 показывается ТОЧНЫЙ план (что удалится каскадом — блоки со
//    сроками/фактом, что потеряет привязку — элементы модели/помещения), подтверждение, повтор с `?force=true`; неиспользуемая
//    запись удаляется без вопросов (терять нечего);
//  * привязка секции к осям (Docs/TZ.md «Геометрия блока») — выпадающий список осей объекта (как в V1, а не текстовое поле): выбор
//    оси уходит тем же PATCH, что и подпись секции; сервер требует ОБЕ оси сразу или ни одной (`app/blocks.py::_set_section_axes`) —
//    если выбрана только одна, PATCH вернёт понятную ошибку, вторая ось сохранится следующим выбором (та же гонка, что и в V1: там
//    два select'а тоже шлют PATCH независимо друг от друга при каждом `change`);
//  * геометрия блока — полный набор прямоугольников разом (форма всегда шлёт весь список, как V1); правится ДВУМЯ синхронными
//    способами (перетаскивание мышью за угол/ребро/целиком — SVG-редактор по образцу V1, и числовые поля x0/x1/y0/y1) — оба меняют
//    один и тот же рабочий набор `g.boxes`; во время жеста граница СВОЕГО прямоугольника не может пересечь чужой того же этажа
//    (клиентский клампинг, идентичный V1 `blkGeoClampEdgeValue`/`blkGeoClampMove`) — сервер и после сохранения только предупреждает
//    (мягкая проверка), но на этапе правки конфликт виден сразу, а не молча; соседние блоки того же этажа рисуются для сверки, но
//    НЕ перетаскиваются — правятся только через свою же карточку;
//  * неизвестный исход (обрыв/5xx) не повторяется — список перечитывается, ответ по факту.
import { esc, errText, unknownOutcome } from "./mfr-common.js";
import { showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const LEVEL_KIND_LABEL = { "этаж": "этаж", "подземный": "подземный этаж", "кровля": "кровля" };

// Запас от «прилипания» на стыке из-за float — тот же порог, что в V1 (BLK_GEO_EPS).
const GEO_EPS = 1;

export function mountStructureTab(host, { api, objectId, canWrite, onChanged }) {
  let dead = false;
  const st = {
    loading: true, error: "",
    sections: [], levels: [], blocks: [], grids: [], gridsLoaded: false,   // grids — метки осей объекта, для привязки секции (пусто у PDF-only/без Revit-осей)
    status: "", statusBad: false,
    recalcBusy: false, recalcReport: "",
    addSec: { code: "", name: "" },
    addLvl: { kind: "этаж", floor: "", name: "", elevation: "", sectionCodes: new Set() },
    geo: null,   // {blockId, sectionCode, levelId, levelName, boxes, others, floorMode, loading, error, warnings, dirty}
    busy: false,
  };
  let geoDrag = null;   // {kind:"move"|"edge"|"corner", boxIndex, edge?, corner?, startSvg, orig, bounds} — во время жеста, вне st (не часть отрисовки)
  const $ = (s) => host.querySelector(s);
  const setStatus = (t, bad = false) => { st.status = t; st.statusBad = bad; const n = $("#st-status"); if (n) { n.textContent = t; n.style.color = bad ? "var(--bad)" : "var(--good)"; } };

  // silent — фоновая перезагрузка после записи (afterWrite): без плашки «Загрузка…», которая на секунду стирала ВЕСЬ бланк
  // (включая открытую геометрию блока и кнопку «Сохранить») — реального разрыва данных не было (сервер уже принял запись), но
  // клик/жест, начатый в этот момент, попадал в пустоту (элемента ещё нет); первичная загрузка и кнопка «Повторить» — как раньше.
  async function load(silent = false) {
    st.error = "";
    if (!silent) { st.loading = true; paint(); }
    try {
      // Метки осей — из ТЯЖЁЛОГО эндпоинта (`revit_plan.filters` считает агрегаты по всей модели объекта, не только оси); сами
      // оси меняются ТОЛЬКО загрузкой новой выгрузки Revit, а не правкой секций/блоков — грузим один раз за монтирование вкладки,
      // а не на КАЖДЫЙ afterWrite (иначе на серии быстрых сохранений подряд запрос копится в очереди позади других и держит
      // `st.busy`/кнопку «Сохранить» заблокированной дольше, чем длится сама запись — живой баг, пойман 09-22 при проверке).
      const reqs = [api.get(`/objects/${objectId}/sections`), api.get(`/objects/${objectId}/levels`), api.get(`/objects/${objectId}/blocks`)];
      if (!st.gridsLoaded) reqs.push(api.get(`/revit-plan/filters?object_id=${objectId}`).catch(() => null));
      const [sections, levels, blocks, filters] = await Promise.all(reqs);
      if (dead) return;
      st.sections = sections; st.levels = levels; st.blocks = blocks; st.loading = false;
      // У PDF-only объекта или выгрузки без сохранённых осей список пуст, как в V1 (loadBlkSectionsLevels) — тогда столбцы
      // привязки просто не показываются.
      if (!st.gridsLoaded) { st.grids = (filters && filters.grids) || []; st.gridsLoaded = true; }
    } catch (e) { if (dead) return; st.loading = false; st.error = errText(e); }
    paint();
  }

  async function afterWrite() { await load(true); onChanged?.(); }

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
  // PATCH шлёт все три поля разом (`app/blocks.py::update_section` перезаписывает их все при каждом вызове), поэтому читаем
  // значения ЖИВЬЁМ из DOM строки (как V1: `fromSel.value`/`toSel.value`/`nameInput.value` в `renderBlkSections`), а не из
  // закэшированного объекта секции — три поля правятся ТРЕМЯ независимыми обработчиками `change`, и без этого второй select
  // отправлял бы PATCH со СТАРЫМ значением первого. По той же причине ошибка сервера («нужны обе оси сразу») НЕ перечитывает
  // список — форма перезагрузилась бы и стёрла только что выбранную первую ось раньше, чем пользователь дойдёт до второй
  // (живой баг этого переноса, пойман при проверке — до правки вторая ось никогда не сохранялась выбором по одной).
  async function saveSection(s) {
    const row = $(`[data-sec-row="${s.id}"]`);
    const nameInput = row?.querySelector("[data-sec-name]");
    const fromSel = row?.querySelector('[data-axis-field="from"]');
    const toSel = row?.querySelector('[data-axis-field="to"]');
    const trimmed = (nameInput ? nameInput.value : s.name || "").trim();
    if (!trimmed) { setStatus("Подпись секции не может быть пустой", true); paint(); return; }
    const axis_from = fromSel ? (fromSel.value || null) : (s.axis_from || null);
    const axis_to = toSel ? (toSel.value || null) : (s.axis_to || null);
    try {
      await api.patch(`/objects/${objectId}/sections/${s.id}`, { name: trimmed, axis_from, axis_to });
      setStatus(`Секция «${s.code}» сохранена`);
      await afterWrite();
    } catch (e) { setStatus(`Секция «${s.code}»: ${errText(e)}`, true); }
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
      if (st.geo?.blockId === b.id) { geoDrag = null; st.geo = null; }
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
    if (!all.length) return { minX: 0, minY: 0, w: 10000, h: 10000, strokeW: 40, handleR: 60 };
    const margin = 1500;
    const minX = Math.min(...all.map((b) => b.x0)) - margin, maxX = Math.max(...all.map((b) => b.x1)) + margin;
    const minY = Math.min(...all.map((b) => b.y0)) - margin, maxY = Math.max(...all.map((b) => b.y1)) + margin;
    const w = maxX - minX, h = maxY - minY, scale = Math.max(w, h);
    // Ручки/обводка — долей охвата, не в фиксированных пикселях (та же формула, что в V1 blkGeoBounds): на площадке в десятки тысяч
    // мм фиксированные значения были бы невидимы.
    return { minX, minY, w, h, strokeW: Math.max(scale / 300, 30), handleR: Math.max(scale / 90, 60) };
  }
  function geoSvg(g) {
    const { minX, minY, w, h, strokeW, handleR } = geoBounds(g);
    const toSvgY = (y) => h - (y - minY);
    const fontSize = Math.max(w, h) / 55;
    const others = g.others.flatMap((o) => o.boxes.map((b) => `
      <rect x="${b.x0 - minX}" y="${toSvgY(b.y1)}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="var(--muted)" fill-opacity="0.18" stroke="var(--muted)" stroke-opacity="0.6" stroke-width="${strokeW}"/>
      <text x="${b.x0 - minX + fontSize * 0.3}" y="${toSvgY(b.y1) + fontSize}" font-size="${fontSize}" fill="var(--muted)">${esc(o.секция)}</text>`).join(""));
    // Обзор этажа (floorMode) — только показ, ручек перетаскивания нет: владельца-блока для сохранения там не выбрано (как в V1).
    const barLen = handleR * 2.4, barThick = handleR * 1.1;
    const mine = g.floorMode ? "" : g.boxes.map((b, i) => {
      const x = b.x0 - minX, y = toSvgY(b.y1), rw = b.x1 - b.x0, rh = b.y1 - b.y0;
      const corners = [["tl", x, y], ["tr", x + rw, y], ["bl", x, y + rh], ["br", x + rw, y + rh]];
      // Ручки на РЁБРАХ (перекладина посередине стороны, тянет только эту границу) — перенос из V1 (см. bindBlkGeoDrag).
      const edges = [
        { edge: "n", cx: x + rw / 2, cy: y, bw: barLen, bh: barThick },
        { edge: "s", cx: x + rw / 2, cy: y + rh, bw: barLen, bh: barThick },
        { edge: "w", cx: x, cy: y + rh / 2, bw: barThick, bh: barLen },
        { edge: "e", cx: x + rw, cy: y + rh / 2, bw: barThick, bh: barLen },
      ].map(({ edge, cx, cy, bw, bh }) => `<rect class="mfr-geo-edge" data-box-i="${i}" data-edge="${edge}" x="${cx - bw / 2}" y="${cy - bh / 2}" width="${bw}" height="${bh}" rx="${Math.min(bw, bh) / 2}"/>`).join("");
      return `<rect class="mfr-geo-box" data-box-i="${i}" x="${x}" y="${y}" width="${rw}" height="${rh}" fill="var(--accent)" fill-opacity="0.3" stroke="var(--accent)" stroke-width="${strokeW}"/>
        ${edges}
        ${corners.map(([c, cx, cy]) => `<circle class="mfr-geo-handle" data-box-i="${i}" data-corner="${c}" cx="${cx}" cy="${cy}" r="${handleR}"/>`).join("")}`;
    }).join("");
    // Подсказка «упирается в границу» — ВНУТРИ SVG (текстовый узел, а не отдельный DOM-блок под канвасом): не участвует в layout
    // документа, появление/исчезание во время pointermove не дёргает картинку (та же причина, что в V1 renderBlkGeoEditor).
    return `<svg id="mfr-geo-svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:220px;background:var(--surface);border:1px solid var(--line);border-radius:8px;touch-action:none" preserveAspectRatio="xMidYMid meet">${others}${mine}
      <text id="mfr-geo-hint" x="${fontSize * 0.5}" y="${fontSize * 1.4}" font-size="${fontSize * 1.3}" font-weight="bold" fill="var(--bad)" style="display:none"></text></svg>`;
  }

  // -------- Живой запрет на пересечение с соседней секцией во время перетаскивания (перенос из V1: blkGeoClampEdgeValue/blkGeoClampMove) --------
  function geoFlatOthers(g) { return g.others.flatMap((o) => o.boxes.map((b) => ({ ...b, секция: o.секция }))); }
  // `ref` — коробка ДО этого шага драга (все четыре границы); порог берётся из ЕЁ ЖЕ двигаемой границы, иначе сосед, уже
  // легально перекрывающий блок в его текущей ширине (мягкая проверка сервера), ошибочно считался бы преградой.
  function geoClampEdgeValue(ref, edge, value, others) {
    let bound = null, blockedBy = null;
    for (const o of others) {
      const across = (edge === "x0" || edge === "x1")
        ? ref.y0 < o.y1 - GEO_EPS && o.y0 < ref.y1 - GEO_EPS
        : ref.x0 < o.x1 - GEO_EPS && o.x0 < ref.x1 - GEO_EPS;
      if (!across) continue;
      if (edge === "x1" && o.x0 >= ref.x1 - GEO_EPS && (bound === null || o.x0 < bound)) { bound = o.x0; blockedBy = o.секция; }
      else if (edge === "x0" && o.x1 <= ref.x0 + GEO_EPS && (bound === null || o.x1 > bound)) { bound = o.x1; blockedBy = o.секция; }
      else if (edge === "y1" && o.y0 >= ref.y1 - GEO_EPS && (bound === null || o.y0 < bound)) { bound = o.y0; blockedBy = o.секция; }
      else if (edge === "y0" && o.y1 <= ref.y0 + GEO_EPS && (bound === null || o.y1 > bound)) { bound = o.y1; blockedBy = o.секция; }
    }
    if (bound === null) return { value, blocked: null };
    const grows = edge === "x1" || edge === "y1";
    if (grows ? value > bound : value < bound) return { value: bound, blocked: blockedBy };
    return { value, blocked: null };
  }
  // Перенос всего прямоугольника — оси клампятся по очереди (сначала X по несдвинутому Y, потом Y по уже сдвинутому X).
  function geoClampMove(orig, dxWorld, dyWorld, others) {
    let dxMin = -Infinity, dxMax = Infinity, blockedX = null;
    for (const o of others) {
      if (!(orig.y0 < o.y1 - GEO_EPS && o.y0 < orig.y1 - GEO_EPS)) continue;
      if (o.x0 >= orig.x1 && o.x0 - orig.x1 < dxMax) { dxMax = o.x0 - orig.x1; blockedX = o.секция; }
      if (o.x1 <= orig.x0 && o.x1 - orig.x0 > dxMin) { dxMin = o.x1 - orig.x0; blockedX = o.секция; }
    }
    const dx = Math.min(Math.max(dxWorld, dxMin), dxMax);
    const shiftedX0 = orig.x0 + dx, shiftedX1 = orig.x1 + dx;
    let dyMin = -Infinity, dyMax = Infinity, blockedY = null;
    for (const o of others) {
      if (!(shiftedX0 < o.x1 - GEO_EPS && o.x0 < shiftedX1 - GEO_EPS)) continue;
      if (o.y0 >= orig.y1 && o.y0 - orig.y1 < dyMax) { dyMax = o.y0 - orig.y1; blockedY = o.секция; }
      if (o.y1 <= orig.y0 && o.y1 - orig.y0 > dyMin) { dyMin = o.y1 - orig.y0; blockedY = o.секция; }
    }
    const dy = Math.min(Math.max(dyWorld, dyMin), dyMax);
    return { dx, dy, blocked: (dx !== dxWorld ? blockedX : null) || (dy !== dyWorld ? blockedY : null) };
  }
  function geoSvgPoint(svg, evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  // Полный paintGeo() пересчитывает охват (geoBounds) из ТЕКУЩИХ прямоугольников — вызванный на каждый pointermove, он сдвинул бы
  // viewBox/CTM, а startSvg (снят один раз на pointerdown, в СТАРОЙ системе координат) перестал бы соответствовать курсору.
  // Поэтому во время жеста охват ЗАМОРОЖЕН (geoDrag.bounds), обновляются только атрибуты нужных SVG-узлов и числовые поля;
  // полный перерисовка — только по pointerup (перенос приёма из V1 bindBlkGeoDrag, тот же живой баг однажды пойман там).
  function onGeoPointerMove(e) {
    if (!geoDrag) return;
    const svg = $("#mfr-geo-svg");
    const g = st.geo;
    if (!svg || !g || !g.boxes[geoDrag.boxIndex]) { geoDrag = null; return; }
    const p = geoSvgPoint(svg, e);
    const dxWorld = p.x - geoDrag.startSvg.x;
    const dyWorld = -(p.y - geoDrag.startSvg.y);   // SVG вниз = мир вниз по Y (см. toSvgY)
    const box = g.boxes[geoDrag.boxIndex], orig = geoDrag.orig;
    const others = geoFlatOthers(g);
    let blocked = null;
    if (geoDrag.kind === "move") {
      const r = geoClampMove(orig, dxWorld, dyWorld, others);
      box.x0 = orig.x0 + r.dx; box.x1 = orig.x1 + r.dx; box.y0 = orig.y0 + r.dy; box.y1 = orig.y1 + r.dy;
      blocked = r.blocked;
    } else if (geoDrag.kind === "edge") {
      const fixed = { x0: orig.x0, x1: orig.x1, y0: orig.y0, y1: orig.y1 };
      if (geoDrag.edge === "w") { const r = geoClampEdgeValue(fixed, "x0", orig.x0 + dxWorld, others); box.x0 = r.value; blocked = r.blocked; }
      else if (geoDrag.edge === "e") { const r = geoClampEdgeValue(fixed, "x1", orig.x1 + dxWorld, others); box.x1 = r.value; blocked = r.blocked; }
      else if (geoDrag.edge === "n") { const r = geoClampEdgeValue(fixed, "y1", orig.y1 + dyWorld, others); box.y1 = r.value; blocked = r.blocked; }
      else if (geoDrag.edge === "s") { const r = geoClampEdgeValue(fixed, "y0", orig.y0 + dyWorld, others); box.y0 = r.value; blocked = r.blocked; }
    } else {
      // Угол двигает ДВЕ границы разом, обе клампятся по ОДНОМУ и тому же замороженному `orig` (не по текущему `box`) — иначе
      // X-шаг и Y-шаг попеременно читают состояние друг у друга с разных кадров (тот же живой баг, что был в V1: дрожь у угла).
      const west = geoDrag.corner.includes("l"), north = geoDrag.corner === "tl" || geoDrag.corner === "tr";
      const refBox = { x0: orig.x0, x1: orig.x1, y0: orig.y0, y1: orig.y1 };
      if (west) { const r = geoClampEdgeValue(refBox, "x0", orig.x0 + dxWorld, others); box.x0 = r.value; blocked = blocked || r.blocked; }
      else { const r = geoClampEdgeValue(refBox, "x1", orig.x1 + dxWorld, others); box.x1 = r.value; blocked = blocked || r.blocked; }
      if (north) { const r = geoClampEdgeValue(refBox, "y1", orig.y1 + dyWorld, others); box.y1 = r.value; blocked = blocked || r.blocked; }
      else { const r = geoClampEdgeValue(refBox, "y0", orig.y0 + dyWorld, others); box.y0 = r.value; blocked = blocked || r.blocked; }
    }
    if (box.x1 - box.x0 < 50) box.x1 = box.x0 + 50;   // запасной пол — вырожденный прямоугольник хуже, чем временный крошечный
    if (box.y1 - box.y0 < 50) box.y1 = box.y0 + 50;
    g.dirty = true;
    updateBoxVisual(geoDrag.boxIndex, geoDrag.bounds, blocked);
  }
  function onGeoPointerUp() {
    if (!geoDrag) return;
    geoDrag = null;
    const hint = $("#mfr-geo-hint"); if (hint) hint.style.display = "none";
    paintGeo();   // один раз, начисто — пересчитать охват под итог
  }
  function updateBoxVisual(i, bounds, blocked) {
    const g = st.geo; if (!g) return;
    const b = g.boxes[i]; if (!b) return;
    const { minX, minY, h } = bounds;
    const toSvgY = (y) => h - (y - minY);
    const x = b.x0 - minX, y = toSvgY(b.y1), rw = b.x1 - b.x0, rh = b.y1 - b.y0;
    const rect = $(`.mfr-geo-box[data-box-i="${i}"]`);
    if (rect) { rect.setAttribute("x", x); rect.setAttribute("y", y); rect.setAttribute("width", rw); rect.setAttribute("height", rh); rect.classList.toggle("mfr-geo-box-blocked", !!blocked); }
    const hint = $("#mfr-geo-hint");
    if (hint) { hint.style.display = blocked ? "" : "none"; if (blocked) hint.textContent = `Упирается в границу секции «${blocked}»`; }
    const corners = { tl: [x, y], tr: [x + rw, y], bl: [x, y + rh], br: [x + rw, y + rh] };
    for (const [c, [cx, cy]] of Object.entries(corners)) { const handle = $(`.mfr-geo-handle[data-box-i="${i}"][data-corner="${c}"]`); if (handle) { handle.setAttribute("cx", cx); handle.setAttribute("cy", cy); } }
    const edgeMid = { n: [x + rw / 2, y], s: [x + rw / 2, y + rh], w: [x, y + rh / 2], e: [x + rw, y + rh / 2] };
    for (const [edge, [cx, cy]] of Object.entries(edgeMid)) {
      const bar = $(`.mfr-geo-edge[data-box-i="${i}"][data-edge="${edge}"]`);
      if (bar) { const bw = Number(bar.getAttribute("width")), bh = Number(bar.getAttribute("height")); bar.setAttribute("x", cx - bw / 2); bar.setAttribute("y", cy - bh / 2); }
    }
    host.querySelectorAll(`[data-box-i="${i}"][data-field]`).forEach((inp) => { inp.value = Math.round(b[inp.dataset.field]); });
  }
  function bindGeoDrag(g) {
    const svg = $("#mfr-geo-svg");
    if (!svg || g.floorMode || !canWrite) return;
    svg.querySelectorAll(".mfr-geo-handle, .mfr-geo-box, .mfr-geo-edge").forEach((el) => el.addEventListener("pointerdown", (e) => {
      if (st.busy) return;
      e.preventDefault();
      const i = Number(el.dataset.boxI);
      const p = geoSvgPoint(svg, e);
      const bounds = geoBounds(g);
      const orig = { ...g.boxes[i] };
      if (el.classList.contains("mfr-geo-handle")) geoDrag = { kind: "corner", boxIndex: i, corner: el.dataset.corner, startSvg: p, orig, bounds };
      else if (el.classList.contains("mfr-geo-edge")) geoDrag = { kind: "edge", boxIndex: i, edge: el.dataset.edge, startSvg: p, orig, bounds };
      else geoDrag = { kind: "move", boxIndex: i, startSvg: p, orig, bounds };
      svg.setPointerCapture(e.pointerId);
    }));
  }
  async function openGeometry(b) {
    const sec = st.sections.find((s) => s.id === b.section_id);
    geoDrag = null;   // смена карточки блока обрывает начатый жест (индексы boxes принадлежали прежней геометрии)
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
    geoDrag = null;
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

  function axisSelectHtml(field, secId, selected) {
    const options = ['<option value="">—</option>'].concat(
      st.grids.map((g2) => `<option value="${esc(g2.label)}" ${g2.label === selected ? "selected" : ""}>${esc(g2.label)}</option>`),
    ).join("");
    return `<select class="mfr-inline" data-sec-axis="${secId}" data-axis-field="${field}" ${st.busy ? "disabled" : ""}>${options}</select>`;
  }
  function sectionsTable() {
    if (!st.sections.length) return `<p class="v2-muted">Секций ещё нет.</p>`;
    const withAxis = st.grids.length > 0;   // осей у объекта нет (PDF-only / выгрузка без сохранённых осей) — столбцы не показываем, как в V1
    return `<table class="v2-read-tbl"><thead><tr><th>Код</th><th>Подпись</th>${withAxis ? "<th>Ось от</th><th>Ось до</th>" : ""}${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
      ${st.sections.map((s) => `<tr data-sec-row="${s.id}"><td>${esc(s.code)}</td>
        <td>${canWrite ? `<input type="text" class="mfr-inline" data-sec-name="${s.id}" value="${esc(s.name || "")}" ${st.busy ? "disabled" : ""}>` : esc(s.name || "")}</td>
        ${withAxis ? (canWrite
          ? `<td>${axisSelectHtml("from", s.id, s.axis_from)}</td><td>${axisSelectHtml("to", s.id, s.axis_to)}</td>`
          : `<td>${esc(s.axis_from || "—")}</td><td>${esc(s.axis_to || "—")}</td>`) : ""}
        ${canWrite ? `<td><button type="button" class="v2-link-btn" data-sec-del="${s.id}" ${st.busy ? "disabled" : ""}>удалить</button></td>` : ""}</tr>`).join("")}
      </tbody></table>
      ${withAxis ? "" : `<p class="v2-muted mfr-hint">Осей у объекта нет — привязка границ секции недоступна, пока не загружена выгрузка Revit с осями.</p>`}`;
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
    box.querySelector("#st-geo-close")?.addEventListener("click", () => { geoDrag = null; st.geo = null; paintGeo(); });
    if (!g.floorMode) {
      // Числовое поле — АЛЬТЕРНАТИВНЫЙ способ ввода ТОГО ЖЕ значения, что и перетаскивание: тот же клампинг по соседям (перенос
      // V1 blkGeoClampEdgeValue), то же предупреждение, если значение подрезано на границе соседней секции.
      box.querySelectorAll("[data-box-i][data-field]").forEach((inp) => inp.addEventListener("change", () => {
        const i = Number(inp.dataset.boxI), field = inp.dataset.field, v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        const bx = g.boxes[i];
        const r = geoClampEdgeValue({ x0: bx.x0, x1: bx.x1, y0: bx.y0, y1: bx.y1 }, field, v, geoFlatOthers(g));
        bx[field] = r.value; g.dirty = true;
        g.warnings = r.blocked ? `Упирается в границу секции «${r.blocked}» — значение подрезано, области не должны пересекаться.` : g.warnings;
        paintGeo();
      }));
      box.querySelectorAll("[data-box-remove]").forEach((btn) => btn.addEventListener("click", () => { g.boxes.splice(Number(btn.dataset.boxRemove), 1); g.dirty = true; paintGeo(); }));
      box.querySelector("#st-geo-add")?.addEventListener("click", () => {
        const { minX, minY, w, h } = geoBounds(g); const size = Math.min(w, h) * 0.2 || 3000;
        g.boxes.push({ x0: minX + w * 0.4, x1: minX + w * 0.4 + size, y0: minY + h * 0.4, y1: minY + h * 0.4 + size }); g.dirty = true; paintGeo();
      });
      box.querySelector("#st-geo-reset")?.addEventListener("click", () => { g.boxes = []; g.dirty = true; paintGeo(); });
      box.querySelector("#st-geo-save")?.addEventListener("click", saveGeometry);
      bindGeoDrag(g);
    }
  }
  function bindStatic() {
    $("#st-sec-code")?.addEventListener("input", (e) => { st.addSec.code = e.target.value; });
    $("#st-sec-name")?.addEventListener("input", (e) => { st.addSec.name = e.target.value; });
    $("#st-sec-add")?.addEventListener("click", addSection);
    host.querySelectorAll("[data-sec-name]").forEach((inp) => inp.addEventListener("change", () => {
      const s = st.sections.find((x) => x.id === Number(inp.dataset.secName)); if (s) saveSection(s);
    }));
    // Привязка секции к осям — выпадающий список (как в V1): выбор уходит тем же PATCH, что подпись; оба select'а независимы —
    // если выбрана только одна ось, сервер вернёт «нужны обе оси сразу — или ни одной», вторая ось сохранится следующим выбором
    // (saveSection читает ОБА select'а из DOM в момент вызова, поэтому порядок выбора и промежуточная ошибка не мешают друг другу).
    host.querySelectorAll("[data-sec-axis]").forEach((sel) => sel.addEventListener("change", () => {
      const s = st.sections.find((x) => x.id === Number(sel.dataset.secAxis)); if (s) saveSection(s);
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

  // Слушатели жеста — на window (курсор при перетаскивании уходит за пределы SVG), а не на самом узле, который каждый paintGeo()
  // пересоздаёт: один раз на монтирование, снимаются в destroy(), не копятся при повторном открытии геометрии/паке экрана.
  window.addEventListener("pointermove", onGeoPointerMove);
  window.addEventListener("pointerup", onGeoPointerUp);

  load();
  return {
    refresh: load,
    destroy() {
      dead = true;
      window.removeEventListener("pointermove", onGeoPointerMove);
      window.removeEventListener("pointerup", onGeoPointerUp);
    },
  };
}
