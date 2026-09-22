// Экран «Загрузить из FBX» (external-models) — внешние 3D-модели объекта (благоустройство, фасад). В V1 это интерфейс
// размещения и калибровки в 3D (3 тыс. строк JS, Three.js-сцена); сюда перенесено то, что не требует сцены: список,
// загрузка (с тем же клиентским разбором FBX, что в V1 — определяет anchor/габарит/оси, без него сервер не примет файл),
// удаление, перецентровка и правка размещения ЧИСЛОВЫМИ полями (смещение/поворот/масштаб) со сверкой ожидаемой версии
// записи (оптимистичная блокировка, как у карточек ЗР). Собственно 3D-просмотр и визуальная калибровка — только в V1.
//
// «Совместить автоматически» (фасад, 2026-09-22) — ИСКЛЮЧЕНИЕ из «сюда перенесено то, что не требует сцены»: сама
// математика auto-align.js (Docs/fbx-auto-placement-claude-prompt.md) сцены НЕ требует — чистая функция от отрезков
// стен (fbxSegments/objectSegments), уже написанная, проверенная синтетикой и аудитом на реальных объектах для V1
// (git log: ef3cc54…4718d70). Здесь она переиспользуется КАК ЕСТЬ (тот же модуль, та же формула контракта размещения
// в coordinates.js — «НЕ пересчитывай/не выводи её заново в другом месте»): файл модели скачивается заново
// (`GET .../content`, тот же файл, что при загрузке), разбирается тем же fbx.js, что и при upload, отрезки стен
// объекта — GET /objects/{id}/external-models/geometry-features (backend уже готов, не менялся). Результат
// показывается текстом (без предпросмотра на сцене — её здесь нет) и пишется ОДНИМ PATCH вместе с
// auto_placement_status/auto_placement_diagnostics (тот же контракт, что готовил backend, PatchIn), чтобы не было
// состояния «размещение уже применено, а статус попытки ещё старый».
import { showConfirmDialog, showChoices } from "./dialogs.js";
import { esc, errText, isUnknownOutcome, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml } from "./exchange-common.js";

const KIND_LABEL = { ground: "Благоустройство", facade: "Фасад" };

function fmt(n, digits = 1) { return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, "") : "—"; }

async function loadThreeAndFbx() {
  const [THREE, { FBXLoader }, fbxMod] = await Promise.all([
    import("three"),
    import("/static/vendor/three/examples/jsm/loaders/FBXLoader.js"),
    import("/static/external-models/fbx.js"),
  ]);
  return { THREE, FBXLoader, ...fbxMod };
}

async function parseFbxFile(file, kind) {
  const { THREE, FBXLoader, loadExternalModelFbx } = await loadThreeAndFbx();
  const arrayBuffer = await file.arrayBuffer();
  const result = await loadExternalModelFbx({ arrayBuffer, THREE, FBXLoader, kind });
  result.dispose(); // геометрия/текстуры разобранной модели здесь не показываются (нет сцены) — сразу освобождаем память
  return result;
}

export function mountExternalModels(el, ctx) {
  const { screen, groupTitle, api, objectId, object } = ctx;
  let dead = false, busy = false, models = [];

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Внешние 3D-модели объекта (благоустройство, фасад). Видны как слой в 3D ЖБИ и «Модели МФР» — переключатель «Благоустройство» там же, во вкладке «Вид». «Совместить автоматически» (у фасада) считает положение по геометрии стен и показывает результат текстом — без предпросмотра на сцене, она только в текущем интерфейсе (V1), там же — визуальная калибровка перетаскиванием.",
    body: `<div id="em-list"><p class="v2-muted" role="status">Загрузка…</p></div>
      <div id="em-list-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <details class="v2-collapsible" id="em-upload-details" style="margin-top:14px"><summary>Загрузить FBX</summary>
        <form id="em-form" autocomplete="off" novalidate>
          <label class="v2-wire-field v2-field-wide"><span>Файл .fbx</span><input type="file" id="em-file" accept=".fbx"></label>
          <label class="v2-wire-field"><span>Вид</span><select id="em-kind"><option value="ground">Благоустройство</option><option value="facade">Фасад</option></select></label>
          <label class="v2-wire-field v2-field-wide"><span>Название</span><input type="text" id="em-name" maxlength="255" placeholder="Благоустройство"></label>
          <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="em-go">Загрузить</button></div>
        </form>
        <div id="em-upload-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      </details>`,
  });
  const $ = (s) => el.querySelector(s);
  const uploadStatus = makeStatus($("#em-upload-status"));
  const listStatus = makeStatus($("#em-list-status"));

  function modelRowHtml(m) {
    return `<tr data-model="${m.id}">
      <td>${esc(m.name)}</td><td>${esc(KIND_LABEL[m.kind] || m.kind)}</td>
      <td>${(m.size_bytes / 1024 / 1024).toFixed(1)} МБ</td>
      <td>смещ. ${fmt(m.offset_mm.x)}/${fmt(m.offset_mm.y)}/${fmt(m.offset_mm.z)} мм · поворот ${fmt(m.rotation_deg)}° · масшт. ${fmt(m.scale.x, 3)}/${fmt(m.scale.y, 3)}/${fmt(m.scale.z, 3)}</td>
      <td class="v2-bar"><button type="button" class="v2-btn" data-edit="${m.id}">Изменить размещение</button>${m.kind === "facade" ? `<button type="button" class="v2-btn" data-auto-align="${m.id}">Совместить автоматически</button>` : ""}<button type="button" class="v2-btn" data-recenter="${m.id}">Перецентровать</button><button type="button" class="v2-btn v2-danger" data-delete="${m.id}">Удалить</button></td>
    </tr>${m._editing ? `<tr data-edit-row="${m.id}"><td colspan="5">${editFormHtml(m)}</td></tr>` : ""}`;
  }

  function editFormHtml(m) {
    return `<form class="v2-wire-field-row" data-edit-form="${m.id}" autocomplete="off" novalidate style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end">
      <label class="v2-wire-field"><span>Название</span><input type="text" name="name" value="${esc(m.name)}" maxlength="255"></label>
      <label class="v2-wire-field"><span>Смещение X, мм</span><input type="number" name="offset_x_mm" value="${m.offset_mm.x}" step="1"></label>
      <label class="v2-wire-field"><span>Смещение Y, мм</span><input type="number" name="offset_y_mm" value="${m.offset_mm.y}" step="1"></label>
      <label class="v2-wire-field"><span>Смещение Z, мм</span><input type="number" name="offset_z_mm" value="${m.offset_mm.z}" step="1"></label>
      <label class="v2-wire-field"><span>Поворот, °</span><input type="number" name="rotation_deg" value="${m.rotation_deg}" step="0.1"></label>
      <label class="v2-wire-field"><span>Масштаб X</span><input type="number" name="scale_x" value="${m.scale.x}" step="0.001" min="0.001" max="100"></label>
      <label class="v2-wire-field"><span>Масштаб Y</span><input type="number" name="scale_y" value="${m.scale.y}" step="0.001" min="0.001" max="100"></label>
      <label class="v2-wire-field"><span>Масштаб Z</span><input type="number" name="scale_z" value="${m.scale.z}" step="0.001" min="0.001" max="100"></label>
      <div class="v2-bar"><button type="submit" class="v2-btn v2-primary">Сохранить</button><button type="button" class="v2-btn" data-cancel-edit="${m.id}">Отмена</button></div>
      <p class="v2-ex-status" data-edit-status role="status" aria-live="polite"></p>
    </form>`;
  }

  function render() {
    const box = $("#em-list");
    if (!models.length) { box.innerHTML = `<p class="v2-muted">У объекта нет загруженных 3D-моделей.</p>`; return; }
    box.innerHTML = `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Название</th><th>Вид</th><th>Размер</th><th>Размещение</th><th></th></tr></thead>
      <tbody>${models.map(modelRowHtml).join("")}</tbody></table></div>`;
  }

  async function loadList() {
    try {
      const d = await api.get(`/objects/${objectId}/external-models`);
      if (dead) return;
      models = (d.models || []).map((m) => ({ ...m, _editing: false }));
      render();
    } catch (err) {
      if (dead) return;
      $("#em-list").innerHTML = `<div class="v2-callout v2-callout-bad" role="alert">Не удалось прочитать список моделей: ${esc(errText(err))}</div>`;
    }
  }

  el.addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const cancelBtn = e.target.closest("[data-cancel-edit]");
    const recenterBtn = e.target.closest("[data-recenter]");
    const deleteBtn = e.target.closest("[data-delete]");
    const autoAlignBtn = e.target.closest("[data-auto-align]");
    if (editBtn) { const id = Number(editBtn.dataset.edit); models = models.map((m) => ({ ...m, _editing: m.id === id })); render(); }
    else if (cancelBtn) { const id = Number(cancelBtn.dataset.cancelEdit); models = models.map((m) => ({ ...m, _editing: false })); render(); }
    else if (recenterBtn) { await recenter(Number(recenterBtn.dataset.recenter)); }
    else if (deleteBtn) { await removeModel(Number(deleteBtn.dataset.delete)); }
    else if (autoAlignBtn) { await runAutoAlign(Number(autoAlignBtn.dataset.autoAlign)); }
  });

  // ---- «Совместить автоматически» (фасад): математика — app/static/external-models/auto-align.js, без своей 3D-сцены.
  const fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  const fmtDeg = (x) => `${Number(x).toFixed(1)}°`;
  const fmtMm = (x) => `${Math.round(x)} мм`;
  async function fetchModelArrayBuffer(id) {
    const res = await fetch(`/objects/${objectId}/external-models/${id}/content`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`не удалось скачать файл модели (код ${res.status})`);
    return res.arrayBuffer();
  }
  function candidatePlacement(candidateToPlacement, candidate, sourceAnchorMm, m) {
    const placement = candidateToPlacement(candidate, [sourceAnchorMm[0], sourceAnchorMm[1]], [m.object_anchor_mm.x, m.object_anchor_mm.y]);
    return { placement, coverage: candidate.coverage, rms: candidate.rmsResidualMm };
  }
  const summaryLine = (s) => `покрытие ${fmtPct(s.coverage)}, невязка ${fmtMm(s.rms)}, поворот ${fmtDeg(s.placement.rotationDeg)}, смещение X/Y ${fmtMm(s.placement.offsetXMm)}/${fmtMm(s.placement.offsetYMm)} мм`;
  // status — код backend (ALLOWED_AUTO_PLACEMENT_STATUS): "insufficient" пишется БЕЗ placement (попытка не удалась,
  // прежнее размещение не трогаем — только фиксируем в auto_placement_status, что попытка была и почему не вышла).
  async function saveAutoAlign(m, placement, status, diagnostics) {
    listStatus.set("Сохраняю…", "busy");
    const body = {
      auto_placement_status: status, auto_placement_diagnostics: diagnostics || {},
      expected_revision: m.revision,
    };
    if (placement) Object.assign(body, { offset_x_mm: placement.offsetXMm, offset_y_mm: placement.offsetYMm, rotation_deg: placement.rotationDeg });
    try {
      const res = await api.patch(`/objects/${objectId}/external-models/${m.id}`, body);
      if (dead) return true;
      models = models.map((x) => (x.id === m.id ? { ...res, _editing: false } : x));
      render();
      const statusText = { confident: "совмещена автоматически (уверенно)", ambiguous: "совмещена автоматически (выбран один из вариантов)", low_confidence: "совмещена автоматически (приблизительно, нужна проверка)", insufficient: "статус автосовмещения сохранён — размещение не изменено" };
      listStatus.set(`«${res.name}»: ${statusText[status] || "статус автосовмещения сохранён"}.`, status === "insufficient" ? "" : "ok");
      return true;
    } catch (err) {
      if (dead) return false;
      if (err.blockedByPolicy) { listStatus.set(errText(err), "bad"); return false; }
      if (err.status === 409) { await loadList(); listStatus.set("Модель изменена в другом месте — список обновлён, повторите.", "bad"); }
      else listStatus.set(`Не удалось сохранить размещение: ${errText(err)}`, "bad");
      return false;
    }
  }
  async function runAutoAlign(id) {
    if (busy) return;
    const m = models.find((x) => x.id === id);
    if (!m) return;
    busy = true; listStatus.set("Скачиваю и разбираю файл модели…", "busy");
    let mods, parsed;
    try {
      const [buf, loaded] = await Promise.all([fetchModelArrayBuffer(id), loadThreeAndFbx()]);
      mods = loaded;
      parsed = await mods.loadExternalModelFbx({ arrayBuffer: buf, THREE: mods.THREE, FBXLoader: mods.FBXLoader, kind: "facade" });
    } catch (err) {
      if (!dead) listStatus.set(`Не удалось разобрать файл модели: ${err.message || err}`, "bad");
      busy = false; return;
    }
    try {
      listStatus.set("Ищу совпадение с геометрией здания…", "busy");
      const { extractWallSegmentsFromGroup, autoAlignFacade, candidateToPlacement } = await import("/static/external-models/auto-align.js");
      const fbxSegments = extractWallSegmentsFromGroup(mods.THREE, parsed.group, parsed.sourceAnchorMm);
      parsed.dispose();
      const objData = await api.get(`/objects/${objectId}/external-models/geometry-features`);
      if (dead) return;
      if (objData.source === "none" || !objData.segments.length) {
        listStatus.set("У объекта нет геометрии стен (модель Revit не загружена, или в ней нет категории «Стены») — автосовмещение невозможно, нужна ручная калибровка в текущем интерфейсе (V1).", "bad");
        return;
      }
      const result = await autoAlignFacade({ fbxSegments, objectSegments: objData.segments });
      if (dead) return;
      const toPlacement = (c) => candidatePlacement(candidateToPlacement, c, parsed.sourceAnchorMm, m);
      if (result.status === "insufficient_geometry") {
        const saved = await saveAutoAlign(m, null, "insufficient", result.diagnostics);
        if (saved && !dead) listStatus.set(`Автосовмещение не выполнено: ${result.reason}`, "bad");
        return;
      }
      if (result.status === "confident" || result.status === "low_confidence") {
        const s = toPlacement(result.candidates[0]);
        const head = result.status === "confident" ? `Совместить фасад «${m.name}» автоматически?` : `${result.reason}`;
        const msg = `${head}\n\n${summaryLine(s)}.\n\nТекущее размещение (смещение ${fmtMm(m.offset_mm.x)}/${fmtMm(m.offset_mm.y)} мм, поворот ${fmtDeg(m.rotation_deg)}) будет заменено.`;
        const ok = await showConfirmDialog(msg, { confirmLabel: result.status === "confident" ? "Совместить" : "Применить приблизительно", multiline: true });
        if (!ok) { if (!dead) listStatus.set("Автосовмещение отменено — прежнее размещение не изменено.", ""); return; }
        await saveAutoAlign(m, s.placement, result.status === "confident" ? "confident" : "low_confidence", result.diagnostics);
        return;
      }
      // ambiguous — несколько существенно разных положений, выбор за человеком (без предпросмотра на сцене — её здесь нет)
      const summaries = result.candidates.map(toPlacement);
      const choices = [{ key: "cancel", label: "Отмена", focus: true },
        ...summaries.map((s, i) => ({ key: String(i), label: `Вариант ${i + 1}: покрытие ${fmtPct(s.coverage)}, поворот ${fmtDeg(s.placement.rotationDeg)}` }))];
      const msg = `${result.reason}\n\n${summaries.map((s, i) => `Вариант ${i + 1}: ${summaryLine(s)}.`).join("\n")}`;
      const picked = await showChoices(msg, choices, { label: "Автосовмещение — несколько вариантов", multiline: true });
      if (picked === "cancel") { if (!dead) listStatus.set("Автосовмещение отменено — прежнее размещение не изменено.", ""); return; }
      await saveAutoAlign(m, summaries[Number(picked)].placement, "ambiguous", result.diagnostics);
    } catch (err) {
      if (!dead) listStatus.set(`Не удалось выполнить автосовмещение: ${err.message || err}`, "bad");
    } finally { busy = false; }
  }

  el.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-edit-form]");
    if (!form) return;
    e.preventDefault();
    await saveEdit(Number(form.dataset.editForm), form);
  });

  async function recenter(id) {
    if (busy) return;
    const m = models.find((x) => x.id === id);
    if (!m) return;
    busy = true; listStatus.set("Перецентровываем…", "busy");
    try {
      const res = await api.post(`/objects/${objectId}/external-models/${id}/recenter`, { expected_revision: m.revision });
      if (dead) return;
      models = models.map((x) => (x.id === id ? { ...res, _editing: false } : x));
      render();
      listStatus.set(`«${res.name}» перецентрована.`, "ok");
    } catch (err) {
      if (dead) return;
      if (err.status === 409) { await loadList(); listStatus.set("Модель изменена в другом месте — список обновлён, попробуйте снова.", "bad"); }
      else listStatus.set(`Не удалось перецентровать: ${errText(err)}`, "bad");
    } finally { busy = false; }
  }

  async function removeModel(id) {
    if (busy) return;
    const m = models.find((x) => x.id === id);
    if (!m) return;
    const ok = await showConfirmDialog(`Удалить модель «${m.name}»?\n\nЭто необратимо — файл и настройки размещения будут удалены.`, { confirmLabel: "Удалить", danger: true, multiline: true });
    if (!ok) return;
    busy = true; listStatus.set("Удаляем…", "busy");
    try {
      await api.delete(`/objects/${objectId}/external-models/${id}`);
      if (dead) return;
      models = models.filter((x) => x.id !== id);
      render();
      listStatus.set(`«${m.name}» удалена.`, "ok");
    } catch (err) {
      if (dead) return;
      listStatus.set(`Не удалось удалить: ${errText(err)}`, "bad");
    } finally { busy = false; }
  }

  async function saveEdit(id, form) {
    const m = models.find((x) => x.id === id);
    if (!m) return;
    const statusEl = form.querySelector("[data-edit-status]");
    const fd = new FormData(form);
    const body = {
      name: String(fd.get("name") || "").trim() || undefined,
      offset_x_mm: Number(fd.get("offset_x_mm")), offset_y_mm: Number(fd.get("offset_y_mm")), offset_z_mm: Number(fd.get("offset_z_mm")),
      rotation_deg: Number(fd.get("rotation_deg")),
      scale_x: Number(fd.get("scale_x")), scale_y: Number(fd.get("scale_y")), scale_z: Number(fd.get("scale_z")),
      expected_revision: m.revision,
    };
    for (const k of ["offset_x_mm", "offset_y_mm", "offset_z_mm", "rotation_deg", "scale_x", "scale_y", "scale_z"]) {
      if (!Number.isFinite(body[k])) { statusEl.textContent = "Все поля должны быть числами."; statusEl.className = "v2-ex-status v2-ex-bad"; return; }
    }
    form.querySelectorAll("button, input").forEach((n) => (n.disabled = true));
    statusEl.textContent = "Сохраняем…"; statusEl.className = "v2-ex-status v2-ex-busy";
    try {
      const res = await api.patch(`/objects/${objectId}/external-models/${id}`, body);
      if (dead) return;
      models = models.map((x) => (x.id === id ? { ...res, _editing: false } : x));
      render();
    } catch (err) {
      if (dead) return;
      form.querySelectorAll("button, input").forEach((n) => (n.disabled = false));
      if (err.status === 409) { statusEl.textContent = "Модель изменена в другом месте — обновите список и повторите."; statusEl.className = "v2-ex-status v2-ex-bad"; }
      else { statusEl.textContent = `Не удалось сохранить: ${errText(err)}`; statusEl.className = "v2-ex-status v2-ex-bad"; }
    }
  }

  async function upload() {
    if (busy) return;
    const file = $("#em-file").files[0];
    if (!file) { uploadStatus.set("Сначала выберите файл .fbx", "bad"); return; }
    if (!/\.fbx$/i.test(file.name)) { uploadStatus.set(`Нужен файл .fbx — выбран «${file.name}»`, "bad"); return; }
    busy = true; $("#em-go").disabled = true;
    const kind = $("#em-kind").value;
    try {
      uploadStatus.set("Разбираю файл (геометрия, оси, единицы)…", "busy");
      let parsed;
      try {
        parsed = await parseFbxFile(file, kind);
      } catch (parseErr) {
        uploadStatus.set(`Файл не распознан: ${parseErr.message || parseErr}`, "bad");
        return;
      }
      if (dead) return;
      const meta = {
        name: $("#em-name").value.trim() || undefined, kind,
        source_anchor_mm: { x: parsed.sourceAnchorMm[0], y: parsed.sourceAnchorMm[1], z: parsed.sourceAnchorMm[2] },
        bbox_size_mm: parsed.bboxSizeMm, mesh_count: parsed.meshCount, triangle_count: parsed.triangleCount,
        texture_count: parsed.textureCount, warnings: parsed.warnings,
      };
      const ok = await showConfirmDialog(`Загрузить модель «${meta.name || (kind === "facade" ? "Фасад" : "Благоустройство")}» (${(file.size / 1024 / 1024).toFixed(1)} МБ, мешей ${parsed.meshCount}, треугольников ${parsed.triangleCount})?${parsed.warnings.length ? `\n\nЗамечания: ${parsed.warnings.join("; ")}` : ""}`, { confirmLabel: "Загрузить", multiline: true });
      if (!ok || dead) { if (!dead) uploadStatus.set("Загрузка отменена.", ""); return; }
      uploadStatus.set("Отправляю на сервер…", "busy");
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("meta", JSON.stringify(meta));
      const res = await api.upload(`/objects/${objectId}/external-models`, fd);
      if (dead) return;
      uploadStatus.set(`Готово: «${res.name}» загружена.`, "ok");
      models = [...models, { ...res, _editing: false }];
      render();
      $("#em-file").value = ""; $("#em-name").value = "";
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) { uploadStatus.set(errText(err), "bad"); return; }
      if (isUnknownOutcome(err)) {
        uploadStatus.html(unknownOutcomeHtml("загрузка 3D-модели"), "bad");
        const box = $("#em-upload-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "external_model_upload", entityId: objectId, sinceMs: Date.now(), what: "загрузка 3D-модели" }));
      } else uploadStatus.set(`Не удалось загрузить: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#em-go").disabled = false; }
  }

  $("#em-form").addEventListener("submit", (e) => { e.preventDefault(); upload(); });
  loadList();

  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    destroy() { dead = true; },
  };
}
