// Экран «Загрузить из FBX» (external-models) — внешние 3D-модели объекта (благоустройство, фасад). В V1 это интерфейс
// размещения и калибровки в 3D (3 тыс. строк JS, Three.js-сцена); сюда перенесено то, что не требует сцены: список,
// загрузка (с тем же клиентским разбором FBX, что в V1 — определяет anchor/габарит/оси, без него сервер не примет файл),
// удаление, перецентровка и правка размещения ЧИСЛОВЫМИ полями (смещение/поворот/масштаб) со сверкой ожидаемой версии
// записи (оптимистичная блокировка, как у карточек ЗР). Собственно 3D-просмотр и визуальная калибровка — только в V1.
import { showConfirmDialog } from "./dialogs.js";
import { esc, errText, isUnknownOutcome, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml } from "./exchange-common.js";

const KIND_LABEL = { ground: "Благоустройство", facade: "Фасад" };

function fmt(n, digits = 1) { return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, "") : "—"; }

async function parseFbxFile(file, kind) {
  const [THREE, { FBXLoader }, { loadExternalModelFbx }] = await Promise.all([
    import("three"),
    import("/static/vendor/three/examples/jsm/loaders/FBXLoader.js"),
    import("/static/external-models/fbx.js"),
  ]);
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
    summary: "Внешние 3D-модели объекта (благоустройство, фасад). Видны как слой в 3D ЖБИ и «Модели МФР» — переключатель «Благоустройство» там же, во вкладке «Вид». Визуальная калибровка на сцене и автосовмещение фасада — в текущем интерфейсе (V1).",
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
      <td class="v2-bar"><button type="button" class="v2-btn" data-edit="${m.id}">Изменить размещение</button><button type="button" class="v2-btn" data-recenter="${m.id}">Перецентровать</button><button type="button" class="v2-btn v2-danger" data-delete="${m.id}">Удалить</button></td>
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
    if (editBtn) { const id = Number(editBtn.dataset.edit); models = models.map((m) => ({ ...m, _editing: m.id === id })); render(); }
    else if (cancelBtn) { const id = Number(cancelBtn.dataset.cancelEdit); models = models.map((m) => ({ ...m, _editing: false })); render(); }
    else if (recenterBtn) { await recenter(Number(recenterBtn.dataset.recenter)); }
    else if (deleteBtn) { await removeModel(Number(deleteBtn.dataset.delete)); }
  });

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
