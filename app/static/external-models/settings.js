// Раздел «Внешние 3D-модели» объекта (Действия → Обмен данными): список,
// загрузка, ручной сдвиг X/Y и поворот (численно — метры/градусы, перевод
// на границе поля), перетаскивание мышью в открытой 3D-сцене МФР
// (deps.beginDrag — контроллер живёт в app.js, у него есть доступ к
// текущей сцене/слою; здесь только UI-обвязка), сохранение на сервере,
// «Сцентрировать с объектом», удаление. Зависимости — явные аргументы,
// чтения глобалей нет (кроме DOM внутри переданного контейнера).
//
// «Сцентрировать» в этой панели сразу шлёт POST .../recenter (реальное
// сохранение с проверкой revision), а не считает черновой anchor локально
// по GET bounds, как в задании §8 для диалога с drag — тут отдельного
// диалога с drag нет, и промежуточный черновик разбирать не с чем.
// Перетаскивание работает, только если у объекта уже открыт 3D МФР
// («Модель» → 3D) — иначе deps.beginDrag честно отказывает с понятной
// причиной, а не подставляет фиктивные координаты.

function mmToM(mm) {
  return mm / 1000;
}
function mToMm(value) {
  // Русская запятая — обычный ввод в этом интерфейсе (см. другие числовые
  // поля проекта); нормализуем на границе, как остальные.
  const normalized = String(value).trim().replace(",", ".");
  const num = Number(normalized);
  return Number.isFinite(num) ? Math.round(num * 1000) : null;
}

export function renderExternalModelsPanel(container, deps) {
  const { objectId, canEdit, api, escapeHtml, showToast, onChanged, beginDrag } = deps;
  let models = [];
  const drafts = new Map(); // modelId -> {offsetXM, offsetYM, rotationDeg, name}
  let activeDrag = null; // {modelId, stop()} — не больше одного перетаскивания разом

  function draftFor(model) {
    if (!drafts.has(model.id)) {
      drafts.set(model.id, {
        offsetXM: mmToM(model.offset_mm.x),
        offsetYM: mmToM(model.offset_mm.y),
        rotationDeg: model.rotation_deg,
        name: model.name,
      });
    }
    return drafts.get(model.id);
  }

  function isDirty(model) {
    const d = draftFor(model);
    return d.offsetXM !== mmToM(model.offset_mm.x) || d.offsetYM !== mmToM(model.offset_mm.y)
      || Number(d.rotationDeg) !== Number(model.rotation_deg) || d.name !== model.name;
  }

  function modelCardHtml(model) {
    const d = draftFor(model);
    const bbox = model.metadata && model.metadata.bbox_size_mm;
    const dirty = isDirty(model);
    return `
      <div class="form-card" data-model-id="${model.id}">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px">
          <h4 style="margin:0">${escapeHtml(model.name)}</h4>
          <span class="hint-text">${model.placement_mode === "unreferenced" ? "Привязка не подтверждена" : model.placement_mode}</span>
        </div>
        <div class="hint-text">
          Файл: ${escapeHtml(model.original_name)}, ${(model.size_bytes / (1024 * 1024)).toFixed(1)} МБ
          ${bbox ? `· габарит ${(bbox.x / 1000).toFixed(1)}×${(bbox.y / 1000).toFixed(1)}×${(bbox.z / 1000).toFixed(1)} м` : ""}
        </div>
        ${canEdit ? `
        <div class="row" style="margin-top:8px">
          <div><label class="field">Сдвиг X, м</label>
            <input type="text" class="em-offset-x" data-model-id="${model.id}" value="${d.offsetXM}"/></div>
          <div><label class="field">Сдвиг Y, м</label>
            <input type="text" class="em-offset-y" data-model-id="${model.id}" value="${d.offsetYM}"/></div>
          <div><label class="field" title="По часовой стрелке при виде на план сверху, вокруг центра модели">Поворот, °</label>
            <input type="text" class="em-rotation" data-model-id="${model.id}" value="${d.rotationDeg}"/></div>
        </div>
        ${beginDrag ? `<div class="hint-text" id="em-drag-hint-${model.id}" ${activeDrag?.modelId === model.id ? "" : "hidden"}>
          Тащите модель мышью в открытой 3D-сцене МФР. Esc или отпустить кнопку мыши вне модели — отмена.</div>` : ""}
        <div class="actions" style="margin-top:8px">
          ${beginDrag ? `<button type="button" class="btn btn-sm ${activeDrag?.modelId === model.id ? "btn-primary" : "btn-secondary"} em-drag"
            data-model-id="${model.id}">${activeDrag?.modelId === model.id ? "Перемещение… (Esc — отмена)" : "Переместить мышью"}</button>` : ""}
          <button type="button" class="btn btn-sm btn-secondary em-recenter" data-model-id="${model.id}">Сцентрировать с объектом</button>
          <button type="button" class="btn btn-sm btn-secondary em-cancel" data-model-id="${model.id}" ${dirty ? "" : "disabled"}>Отмена</button>
          <button type="button" class="btn btn-sm btn-primary em-save" data-model-id="${model.id}" ${dirty ? "" : "disabled"}>Сохранить</button>
          ${trashButtonHtmlFallback(model.id)}
        </div>` : ""}
      </div>`;
  }

  function trashButtonHtmlFallback(modelId) {
    return `<button type="button" class="btn btn-sm btn-danger em-delete" data-model-id="${modelId}" style="margin-left:auto">Удалить</button>`;
  }

  function render() {
    container.innerHTML = `
      ${models.map(modelCardHtml).join("") || '<div class="hint-text">Внешних 3D-моделей пока нет.</div>'}
      ${canEdit ? `
      <div class="form-card">
        <h4>Загрузить модель</h4>
        <input type="file" id="em-upload-file" accept=".fbx"/>
        <div class="hint-text" id="em-upload-status"></div>
      </div>` : ""}
    `;
    wire();
  }

  function wire() {
    container.querySelectorAll(".em-offset-x, .em-offset-y, .em-rotation").forEach((el) => {
      el.addEventListener("input", () => {
        const id = Number(el.dataset.modelId);
        const model = models.find((m) => m.id === id);
        if (!model) return;
        const d = draftFor(model);
        if (el.classList.contains("em-offset-x")) d.offsetXM = el.value;
        else if (el.classList.contains("em-offset-y")) d.offsetYM = el.value;
        else d.rotationDeg = el.value;
        const card = container.querySelector(`.form-card[data-model-id="${id}"]`);
        const dirty = isDirty(model);
        card.querySelector(".em-cancel").disabled = !dirty;
        card.querySelector(".em-save").disabled = !dirty;
      });
    });

    container.querySelectorAll(".em-cancel").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      drafts.delete(id);
      render();
    }));

    container.querySelectorAll(".em-save").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      const offsetXMm = mToMm(d.offsetXM);
      const offsetYMm = mToMm(d.offsetYM);
      const rotationDegNormalized = String(d.rotationDeg).trim().replace(",", ".");
      const rotationDeg = Number(rotationDegNormalized);
      if (offsetXMm === null || offsetYMm === null) {
        showToast("Сдвиг должен быть числом", "error");
        return;
      }
      if (!Number.isFinite(rotationDeg)) {
        showToast("Поворот должен быть числом", "error");
        return;
      }
      btn.disabled = true;
      try {
        const updated = await api(`/objects/${objectId}/external-models/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset_x_mm: offsetXMm, offset_y_mm: offsetYMm, rotation_deg: rotationDeg,
            expected_revision: model.revision,
          }),
        });
        models = models.map((m) => (m.id === id ? updated : m));
        drafts.delete(id);
        showToast("Положение модели сохранено", "info");
        render();
        onChanged && onChanged();
      } catch (e) {
        showToast(e.message || "Не удалось сохранить", "error");
        await reload();
      } finally {
        btn.disabled = false;
      }
    }));

    container.querySelectorAll(".em-drag").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      if (activeDrag && activeDrag.modelId === id) {
        activeDrag.stop(); // повторный клик по «Перемещение…» — досрочная отмена
        return;
      }
      if (activeDrag) return; // одно перетаскивание разом
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      const result = beginDrag(model, {
        onPreviewOffsetMm: (xMm, yMm) => {
          const card = container.querySelector(`.form-card[data-model-id="${id}"]`);
          if (!card) return;
          d.offsetXM = mmToM(xMm);
          d.offsetYM = mmToM(yMm);
          card.querySelector(".em-offset-x").value = d.offsetXM;
          card.querySelector(".em-offset-y").value = d.offsetYM;
        },
        onDone: (xMm, yMm) => {
          d.offsetXM = mmToM(xMm);
          d.offsetYM = mmToM(yMm);
          activeDrag = null;
          render();
        },
        onCancel: () => {
          activeDrag = null;
          render();
        },
      });
      if (!result.ok) {
        showToast(result.reason || "Перетаскивание сейчас недоступно", "error");
        return;
      }
      activeDrag = { modelId: id, stop: result.stop };
      render();
    }));

    container.querySelectorAll(".em-recenter").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      btn.disabled = true;
      try {
        const updated = await api(`/objects/${objectId}/external-models/${id}/recenter`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_revision: model.revision }),
        });
        models = models.map((m) => (m.id === id ? updated : m));
        drafts.delete(id);
        showToast("Модель отцентрирована по объекту", "info");
        render();
        onChanged && onChanged();
      } catch (e) {
        showToast(e.message || "Не удалось отцентрировать", "error");
        await reload();
      } finally {
        btn.disabled = false;
      }
    }));

    container.querySelectorAll(".em-delete").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      if (!confirm(`Удалить модель «${model.name}»? Действие необратимо.`)) return;
      btn.disabled = true;
      try {
        await api(`/objects/${objectId}/external-models/${id}`, { method: "DELETE" });
        drafts.delete(id);
        showToast("Модель удалена", "info");
        await reload();
        onChanged && onChanged();
      } catch (e) {
        showToast(e.message || "Не удалось удалить", "error");
        btn.disabled = false;
      }
    }));

    const fileInput = container.querySelector("#em-upload-file");
    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const statusEl = container.querySelector("#em-upload-status");
        statusEl.textContent = "Разбор файла в браузере…";
        try {
          const { ensureExternalModelsLoaded } = await import("/static/external-models/app-bridge.js");
          const { THREE, FBXLoader, loadExternalModelFbx } = await ensureExternalModelsLoaded();
          const buf = await file.arrayBuffer();
          const parsed = await loadExternalModelFbx({ arrayBuffer: buf, THREE, FBXLoader });
          statusEl.textContent = `Разобрано: ${parsed.meshCount} меш(ей), ${parsed.triangleCount} треугольников, ` +
            `${parsed.textureCount} текстур. Загрузка на сервер…`;
          const meta = {
            name: file.name.replace(/\.fbx$/i, "") || "Благоустройство",
            kind: "ground",
            source_anchor_mm: { x: parsed.sourceAnchorMm[0], y: parsed.sourceAnchorMm[1], z: parsed.sourceAnchorMm[2] },
            bbox_size_mm: parsed.bboxSizeMm,
            mesh_count: parsed.meshCount,
            triangle_count: parsed.triangleCount,
            texture_count: parsed.textureCount,
            warnings: parsed.warnings,
          };
          parsed.dispose(); // предпросмотр этой панели не показывается в 3D — только числа; ресурсы не нужны
          const form = new FormData();
          form.append("file", file);
          form.append("meta", JSON.stringify(meta));
          const created = await api(`/objects/${objectId}/external-models`, { method: "POST", body: form });
          models = [...models, created];
          drafts.delete(created.id);
          statusEl.textContent = "";
          showToast("Модель загружена", "info");
          render();
          onChanged && onChanged();
        } catch (e) {
          statusEl.textContent = "";
          showToast(e.message || "Не удалось загрузить модель", "error");
        } finally {
          fileInput.value = "";
        }
      });
    }
  }

  async function reload() {
    const res = await api(`/objects/${objectId}/external-models`);
    models = res.models;
    drafts.clear();
    render();
  }

  reload();
  return { reload };
}
