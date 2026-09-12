// Раздел «Загрузка из FBX» (внешняя 3D-модель объекта, Действия → Обмен
// данными): список, загрузка, ручной сдвиг X/Y/Z и поворот (численно —
// метры/градусы, перевод на границе поля), настройка положения мышью в
// уже открытой 3D-сцене объекта — МФР или ЖБИ, какая сейчас построена
// (deps.beginPlacement — диспетчер живёт в app.js, у него есть доступ к
// обеим сценам/слоям; здесь только UI-обвязка: одна кнопка «Настроить
// положение» на оба действия — обычное перетаскивание сдвигает модель,
// перетаскивание с зажатой Control поворачивает её вокруг центра), точная
// калибровка по двум парам точек (deps.beginCalibration — та же схема
// диспетчера, модуль `calibrate.js`, Docs/fbx-placement-claude-prompt.md),
// перенос уже откалиброванной привязки на другую модель того же объекта,
// сохранение на сервере, «Сцентрировать с объектом», удаление. Зависимости
// — явные аргументы, чтения глобалей нет (кроме DOM внутри переданного
// контейнера).
//
// «Сцентрировать» в этой панели сразу шлёт POST .../recenter (реальное
// сохранение с проверкой revision), а не считает черновой anchor локально
// по GET bounds, как в задании §8 для диалога с drag — тут отдельного
// диалога с drag нет, и промежуточный черновик разбирать не с чем.
// Настройка мышью работает, только если у объекта уже открыт его 3D
// («Модель» → 3D, МФР или ЖБИ) — иначе deps.beginPlacement честно
// отказывает с понятной причиной, а не подставляет фиктивные координаты.

// Вид модели влияет на anchor по Z при разборе (см. fbx.js) и подписи в
// UI — новый значимый выбор, не просто ярлык (живой запрос пользователя
// 2026-09-11, второй FBX-файл того же объекта — фасад здания).
const KIND_LABELS = { ground: "Благоустройство", facade: "Фасад" };

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
function parseRuNumber(value) {
  const num = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

// Поле сдвига/поворота со стрелками шага (живой запрос пользователя,
// 2026-09-13: «стрелочки вверх-вниз, чтобы можно было пошагово сдвигать»).
// `field` — ключ черновика (offsetXM/offsetYM/offsetZM/rotationDeg),
// `step` — шаг в тех же единицах, что и значение (метры для сдвига,
// градусы для поворота); один и тот же HTML используется и в самой
// карточке, и в плавающей панели поверх 3D (см. openFloatingNumbers) —
// оба места слушает один и тот же делегированный обработчик
// (wireNumFields), поэтому разметка идентична.
function numFieldHtml(modelId, cssClass, field, step, value) {
  return `<span class="em-num-wrap">
    <input type="text" class="${cssClass} em-num-input" data-model-id="${modelId}" data-field="${field}" data-step="${step}" value="${value}"/>
    <span class="em-num-steppers">
      <button type="button" class="em-num-step" data-model-id="${modelId}" data-field="${field}" data-step="${step}" data-dir="1" tabindex="-1" title="+${step}">▲</button>
      <button type="button" class="em-num-step" data-model-id="${modelId}" data-field="${field}" data-step="${step}" data-dir="-1" tabindex="-1" title="−${step}">▼</button>
    </span>
  </span>`;
}

const AUTO_STATUS_LABELS = {
  confident: "выполнено автоматически",
  ambiguous: "неоднозначно — выберите вариант",
  low_confidence: "найдено приблизительно — проверьте",
  insufficient: "недоступно",
};

export function renderExternalModelsPanel(container, deps) {
  const { objectId, canEdit, api, escapeHtml, showToast, onChanged, beginPlacement, beginCalibration, previewPlacement } = deps;
  let models = [];
  const drafts = new Map(); // modelId -> {offsetXM, offsetYM, rotationDeg, name}
  let activeGesture = null; // {modelId, stop()} — не больше одного разом
  let activeCalibration = null; // {modelId, stop()} — тоже не больше одного и не одновременно с activeGesture

  function draftFor(model) {
    if (!drafts.has(model.id)) {
      drafts.set(model.id, {
        offsetXM: mmToM(model.offset_mm.x),
        offsetYM: mmToM(model.offset_mm.y),
        offsetZM: mmToM(model.offset_mm.z),
        rotationDeg: model.rotation_deg,
        name: model.name,
        // Заполняются ТОЛЬКО кнопкой «Совместить автоматически» — «Сохранить»
        // отправит их вместе со сдвигом/поворотом в ОДНОМ PATCH (см. wire());
        // ручное перетаскивание/калибровка их не трогают и не сбрасывают.
        pendingAutoPlacementStatus: undefined,
        pendingAutoPlacementDiagnostics: undefined,
        ambiguousCandidates: undefined, // [{offsetXMm,offsetYMm,rotationDeg,coverage,rmsResidualMm}] — только при status=ambiguous
      });
    }
    return drafts.get(model.id);
  }

  // Автоматическое совмещение фасада (Docs/fbx-auto-placement-claude-
  // prompt.md, исправления Docs/fbx-placement-repair-claude-prompt.md §1)
  // — общая для авто-триггера при загрузке и для кнопки «Совместить
  // автоматически» логика: тянет геометрию стен объекта, извлекает
  // стеновые грани из УЖЕ разобранной группы FBX и считает
  // предполагаемую привязку. НИЧЕГО не пишет сама — только считает и
  // возвращает (включая ВСЕХ кандидатов, не только лучшего — при
  // ambiguous вызывающий код должен дать выбрать вариант, не просто
  // молча остановиться на первом).
  //
  // Anchor объекта (B) берётся из УЖЕ СОХРАНЁННОГО `model.object_anchor_mm`,
  // а НЕ свежим запросом `/bounds` — раньше расчёт вёлся относительно
  // СВЕЖЕГО anchor, а PATCH сохранял только offset/rotation, оставляя
  // хранимый object_anchor_mm модели прежним; если геометрия объекта
  // менялась между загрузкой модели и повторным запуском автосовмещения
  // (кнопка на уже загруженном фасаде), офсет считался относительно ОДНОГО
  // B, а рендер (layer.js) применяет его к ДРУГОМУ — итоговое положение
  // расходилось с посчитанным. Используя anchor самой модели, результат
  // всегда согласован с тем, как рендерится ЭТА модель.
  async function computeAutoAlignment(model, THREE, group, sourceAnchorMm) {
    const featuresRes = await api(`/objects/${objectId}/external-models/geometry-features`);
    if (featuresRes.source !== "revit" || !featuresRes.segments.length) {
      return { applicable: false, reason: "У объекта нет модели МФР со стенами (Revit) — сопоставлять не с чем." };
    }
    const { ensureExternalModelsLoaded } = await import("/static/external-models/app-bridge.js");
    const { extractWallSegmentsFromGroup, autoAlignFacade, candidateToPlacement } = await ensureExternalModelsLoaded();
    const fbxSegments = extractWallSegmentsFromGroup(THREE, group, sourceAnchorMm);
    const result = await autoAlignFacade({ fbxSegments, objectSegments: featuresRes.segments });
    const statusMap = { insufficient_geometry: "insufficient", ambiguous: "ambiguous", low_confidence: "low_confidence", confident: "confident" };
    const sourceAnchorXY = [sourceAnchorMm[0], sourceAnchorMm[1]];
    const projectAnchorXY = [model.object_anchor_mm.x, model.object_anchor_mm.y];
    const candidates = result.candidates.map((c) => {
      const p = candidateToPlacement(c, sourceAnchorXY, projectAnchorXY);
      return { offsetXMm: p.offsetXMm, offsetYMm: p.offsetYMm, rotationDeg: p.rotationDeg, coverage: c.coverage, rmsResidualMm: c.rmsResidualMm };
    });
    return {
      applicable: true, status: result.status, dbStatus: statusMap[result.status],
      reason: result.reason, diagnostics: result.diagnostics,
      placement: candidates[0] || null, candidates,
    };
  }

  // Живой предпросмотр (живой запрос пользователя, 2026-09-13: «при
  // изменении цифры в форме сразу меняй в 3D модели») — вызывается на
  // КАЖДОЕ изменение поля сдвига/поворота (ввод, стрелка шага), а не
  // только по «Настроить положение»/«Совместить...». Невалидный текущий
  // ввод (например, пустая строка на середине набора числа) просто не
  // даёт предпросмотра в этот момент — не откатывает и не подставляет 0,
  // ждёт следующего валидного изменения. Без открытой сцены (МФР или
  // ЖБИ) `previewPlacement` сама ничего не делает (см. app.js) — здесь
  // намеренно не проверяем это заранее, лишняя проверка синхронизировалась
  // бы с той же логикой в двух местах.
  function previewDraft(model, d) {
    if (!previewPlacement) return;
    const offsetXMm = mToMm(d.offsetXM);
    const offsetYMm = mToMm(d.offsetYM);
    const rotationDeg = parseRuNumber(d.rotationDeg);
    if (offsetXMm === null || offsetYMm === null || rotationDeg === null) return;
    previewPlacement(model, { offsetXMm, offsetYMm, rotationDeg });
  }

  // Поле сдвига/поворота меняется в ДВУХ местах — сама карточка (container)
  // и плавающая панель поверх 3D (см. openFloatingNumbers, живой запрос
  // «не закрывая форму, вращать 3D» — панель СКРЫВАЕТ форму, а не
  // дублирует её одновременно, поэтому это не «два источника правды», а
  // единственный обработчик для того DOM-дерева, что сейчас видимо.
  // Разметка (numFieldHtml) в обоих местах одна и та же.
  function applyNumFieldChange(el) {
    const id = Number(el.dataset.modelId);
    const model = models.find((m) => m.id === id);
    if (!model) return;
    const d = draftFor(model);
    d[el.dataset.field] = el.value;
    const card = container.querySelector(`.form-card[data-model-id="${id}"]`);
    if (card) {
      const dirty = isDirty(model);
      card.querySelector(".em-cancel").disabled = !dirty;
      card.querySelector(".em-save").disabled = !dirty;
    }
    previewDraft(model, d);
  }

  function wireNumFields(root) {
    root.addEventListener("input", (e) => {
      const el = e.target.closest(".em-num-input");
      if (el) applyNumFieldChange(el);
    });
    root.addEventListener("click", (e) => {
      const btn = e.target.closest(".em-num-step");
      if (!btn) return;
      const input = root.querySelector(`.em-num-input[data-model-id="${btn.dataset.modelId}"][data-field="${btn.dataset.field}"]`);
      if (!input) return;
      const stepStr = btn.dataset.step;
      const step = Number(stepStr) * Number(btn.dataset.dir);
      const current = parseRuNumber(input.value) ?? 0;
      // Округление до точности шага — иначе бинарная арифметика с плавающей
      // точкой копит «0.30000000000000004» через десяток кликов подряд.
      const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
      input.value = String(Number((current + step).toFixed(decimals)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // Плавающая панель поверх 3D (живой запрос пользователя, 2026-09-13:
  // «разреши, не закрывая форму редактирования, вращать 3D модель, чтобы
  // смотреть как происходит наложение фасада и конструктива») — тот же
  // принцип «скрыть диалог, показать лёгкую панель», что у «Настроить
  // положение»/«Совместить по точкам» (startExternalModelPlacementOnPlane,
  // app.js), но БЕЗ жеста мышью по canvas и БЕЗ отключения OrbitControls:
  // мышь целиком свободна для вращения/приближения камеры, числа меняются
  // только вводом или стрелками шага. Один и тот же `deps.previewPlacement`
  // просто переставляет группу в уже открытой сцене — своей 3D-логики
  // здесь нет и не нужно.
  let floatingNumbersPanel = null; // {modelId, el} | null

  function closeFloatingNumbers() {
    if (!floatingNumbersPanel) return;
    floatingNumbersPanel.el.remove();
    floatingNumbersPanel = null;
    window.removeEventListener("keydown", onFloatingNumbersKeyDown);
    document.getElementById("external-models-backdrop")?.classList.add("open");
    render();
  }

  function onFloatingNumbersKeyDown(e) {
    if (e.key === "Escape") closeFloatingNumbers();
  }

  function openFloatingNumbers(model) {
    if (floatingNumbersPanel) closeFloatingNumbers();
    const d = draftFor(model);
    document.getElementById("external-models-backdrop")?.classList.remove("open");
    const field = (labelText, cssClass, key, step, value) => `
      <label style="display:flex; flex-direction:column; gap:2px; color:#fff; font:12px sans-serif">
        <span style="opacity:.8">${labelText}</span>
        ${numFieldHtml(model.id, cssClass, key, step, value)}
      </label>`;
    const panel = document.createElement("div");
    panel.style.cssText = "position:fixed; top:16px; left:50%; transform:translateX(-50%); "
      + "z-index:1000; background:rgba(20,24,32,.92); padding:12px 16px; border-radius:8px; "
      + "display:flex; align-items:flex-end; gap:14px; box-shadow:0 4px 16px rgba(0,0,0,.35)";
    panel.innerHTML = field("Сдвиг X, м", "em-offset-x", "offsetXM", "0.01", d.offsetXM)
      + field("Сдвиг Y, м", "em-offset-y", "offsetYM", "0.01", d.offsetYM)
      + field("Сдвиг Z, м", "em-offset-z", "offsetZM", "0.01", d.offsetZM)
      + field("Поворот, °", "em-rotation", "rotationDeg", "0.1", d.rotationDeg)
      + `<div style="display:flex; flex-direction:column; gap:2px; color:#fff; font:12px sans-serif">
          <span style="opacity:.8">&nbsp;</span>
          <button type="button" class="btn btn-sm btn-primary" id="em-floating-done">Готово</button>
        </div>`;
    document.body.appendChild(panel);
    wireNumFields(panel);
    panel.querySelector("#em-floating-done").addEventListener("click", closeFloatingNumbers);
    window.addEventListener("keydown", onFloatingNumbersKeyDown);
    floatingNumbersPanel = { modelId: model.id, el: panel };
  }

  function isDirty(model) {
    const d = draftFor(model);
    return d.offsetXM !== mmToM(model.offset_mm.x) || d.offsetYM !== mmToM(model.offset_mm.y)
      || d.offsetZM !== mmToM(model.offset_mm.z)
      || Number(d.rotationDeg) !== Number(model.rotation_deg) || d.name !== model.name;
  }

  function modelCardHtml(model) {
    const d = draftFor(model);
    const bbox = model.metadata && model.metadata.bbox_size_mm;
    const dirty = isDirty(model);
    return `
      <div class="form-card" data-model-id="${model.id}">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px">
          <h4 style="margin:0">${escapeHtml(model.name)} <span class="hint-text">(${KIND_LABELS[model.kind] || model.kind})</span></h4>
          <span class="hint-text">${model.placement_mode === "unreferenced" ? "Привязка не подтверждена" : model.placement_mode}</span>
        </div>
        <div class="hint-text">
          Файл: ${escapeHtml(model.original_name)}, ${(model.size_bytes / (1024 * 1024)).toFixed(1)} МБ
          ${bbox ? `· габарит ${(bbox.x / 1000).toFixed(1)}×${(bbox.y / 1000).toFixed(1)}×${(bbox.z / 1000).toFixed(1)} м` : ""}
        </div>
        ${model.auto_placement_status ? `<div class="hint-text" style="margin-top:2px">
          Автосовмещение: ${AUTO_STATUS_LABELS[model.auto_placement_status] || model.auto_placement_status}
          ${model.auto_placement_json?.reason ? ` — ${escapeHtml(model.auto_placement_json.reason)}` : ""}
          ${dirty ? " (черновик изменён вручную — этот статус относится к ранее сохранённому положению, не к черновику)" : ""}
        </div>` : ""}
        ${canEdit ? `
        <div class="row" style="margin-top:8px">
          <div><label class="field">Сдвиг X, м</label>
            ${numFieldHtml(model.id, "em-offset-x", "offsetXM", "0.01", d.offsetXM)}</div>
          <div><label class="field">Сдвиг Y, м</label>
            ${numFieldHtml(model.id, "em-offset-y", "offsetYM", "0.01", d.offsetYM)}</div>
          <div><label class="field" title="0 = нижняя точка габарита модели на отметке 0 объекта — чисто техническая точка, НЕ уровень земли/пола (его нельзя вычислить из одного габарита: дерево или антенна задерут верх, а не покажут землю). Для привязки к реальной высоте — числом здесь, либо «Перенести эту привязку на» с уже откалиброванного по высоте файла той же сцены. Положительное — вверх.">Сдвиг Z, м</label>
            ${numFieldHtml(model.id, "em-offset-z", "offsetZM", "0.01", d.offsetZM)}</div>
          <div><label class="field" title="По часовой стрелке при виде на план сверху, вокруг центра модели">Поворот, °</label>
            ${numFieldHtml(model.id, "em-rotation", "rotationDeg", "0.1", d.rotationDeg)}</div>
        </div>
        ${previewPlacement ? `<div style="margin-top:4px">
          <button type="button" class="btn btn-sm btn-secondary em-float-numbers" data-model-id="${model.id}"
            title="Свернуть это окно и настраивать числа поверх 3D-сцены — камеру при этом можно свободно вращать и приближать мышью, форма не закрывается, только уходит с глаз до «Готово»"
            >⤢ Настраивать поверх 3D</button>
        </div>` : ""}
        ${d.ambiguousCandidates && d.ambiguousCandidates.length ? `
        <div class="hint-text" style="margin-top:6px">Автосовмещение неоднозначно — несколько вариантов дали похожее качество.
          Выберите вариант (покажется в 3D, если он открыт), проверьте и нажмите «Сохранить»:</div>
        <div class="row" style="gap:6px; flex-wrap:wrap; margin-top:4px">
          ${d.ambiguousCandidates.map((c, i) => `<button type="button" class="btn btn-sm btn-secondary em-auto-candidate"
            data-model-id="${model.id}" data-candidate-index="${i}"
            >Вариант ${i + 1} (покрытие ${(c.coverage * 100).toFixed(0)}%, невязка ${c.rmsResidualMm.toFixed(0)} мм)</button>`).join("")}
        </div>` : ""}
        ${beginPlacement && activeGesture?.modelId === model.id ? `<div class="hint-text">
          Диалог скрыт — мышью сдвиг, с зажатой Control поворот. Управляйте плавающей панелью
          поверх 3D («Готово»/«Отмена») или клавишей Esc.</div>` : ""}
        ${beginCalibration && activeCalibration?.modelId === model.id ? `<div class="hint-text">
          Диалог скрыт — укажите точки A/B сначала на FBX-файле, потом на конструктиве объекта,
          плавающей панелью поверх 3D. Esc — отменить всё.</div>` : ""}
        <div class="actions" style="margin-top:8px">
          ${beginPlacement ? `<button type="button" class="btn btn-sm ${activeGesture?.modelId === model.id ? "btn-primary" : "btn-secondary"} em-placement"
            data-model-id="${model.id}" ${(activeGesture && activeGesture.modelId !== model.id) || activeCalibration ? "disabled" : ""}
            title="Мышью — сдвиг, с зажатой Control — поворот вокруг центра"
            >${activeGesture?.modelId === model.id ? "Настройка…" : "Настроить положение"}</button>` : ""}
          ${beginCalibration ? `<button type="button" class="btn btn-sm ${activeCalibration?.modelId === model.id ? "btn-primary" : "btn-secondary"} em-calibrate"
            data-model-id="${model.id}" ${(activeCalibration && activeCalibration.modelId !== model.id) || activeGesture ? "disabled" : ""}
            title="Указать 2 общие точки на FBX-файле и на уже имеющемся конструктиве объекта — поворот и сдвиг посчитаются точно"
            >${activeCalibration?.modelId === model.id ? "Идёт калибровка…" : "Совместить по точкам"}</button>` : ""}
          ${model.kind === "facade" ? `<button type="button" class="btn btn-sm btn-secondary em-auto-align"
            data-model-id="${model.id}" ${activeGesture || activeCalibration ? "disabled" : ""}
            title="Найти поворот и сдвиг автоматически по контурам стен модели МФР объекта (нужна загруженная модель МФР со стенами); результат — в черновик, сохранение отдельной кнопкой"
            >Совместить автоматически</button>` : ""}
          <button type="button" class="btn btn-sm btn-secondary em-recenter" data-model-id="${model.id}">Сцентрировать с объектом</button>
          <button type="button" class="btn btn-sm btn-secondary em-cancel" data-model-id="${model.id}" ${dirty ? "" : "disabled"}>Отмена</button>
          <button type="button" class="btn btn-sm btn-primary em-save" data-model-id="${model.id}" ${dirty ? "" : "disabled"}>Сохранить</button>
          ${trashButtonHtmlFallback(model.id)}
        </div>
        ${models.length > 1 ? `
        <div class="row" style="margin-top:8px; align-items:flex-end; gap:8px">
          <div style="flex:1"><label class="field" title="Переносит уже подтверждённый поворот и сдвиг ЭТОЙ модели на другую — только если оба файла заведомо из одного и того же источника координат (Docs/DECISIONS.md)">Перенести эту привязку на</label>
            <select class="em-transfer-target" data-model-id="${model.id}">
              <option value="">— выберите модель —</option>
              ${models.filter((m) => m.id !== model.id).map((m) => `<option value="${m.id}">${escapeHtml(m.name)} (${KIND_LABELS[m.kind] || m.kind})</option>`).join("")}
            </select>
          </div>
          <button type="button" class="btn btn-sm btn-secondary em-transfer-apply" data-model-id="${model.id}">Перенести</button>
        </div>` : ""}` : ""}
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
        <div class="row" style="gap:16px; margin-bottom:8px">
          <label><input type="radio" name="em-upload-kind" value="ground" checked/> Благоустройство</label>
          <label><input type="radio" name="em-upload-kind" value="facade"/> Фасад</label>
        </div>
        <input type="file" id="em-upload-file" accept=".fbx"/>
        <div class="hint-text" id="em-upload-status"></div>
      </div>` : ""}
    `;
    wire();
  }

  function wire() {
    wireNumFields(container);

    container.querySelectorAll(".em-float-numbers").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      if (model) openFloatingNumbers(model);
    }));

    container.querySelectorAll(".em-cancel").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      drafts.delete(id);
      // Если «Совместить автоматически»/выбор варианта уже подвинули
      // живую 3D-группу предпросмотром — откатить её на СОХРАНЁННОЕ
      // положение, а не оставлять картинку рассинхронизированной с
      // отменённым черновиком.
      if (model && previewPlacement) {
        previewPlacement(model, { offsetXMm: model.offset_mm.x, offsetYMm: model.offset_mm.y, rotationDeg: model.rotation_deg });
      }
      render();
    }));

    container.querySelectorAll(".em-save").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      const offsetXMm = mToMm(d.offsetXM);
      const offsetYMm = mToMm(d.offsetYM);
      const offsetZMm = mToMm(d.offsetZM);
      const rotationDegNormalized = String(d.rotationDeg).trim().replace(",", ".");
      const rotationDeg = Number(rotationDegNormalized);
      if (offsetXMm === null || offsetYMm === null || offsetZMm === null) {
        showToast("Сдвиг должен быть числом", "error");
        return;
      }
      if (!Number.isFinite(rotationDeg)) {
        showToast("Поворот должен быть числом", "error");
        return;
      }
      btn.disabled = true;
      try {
        const body = {
          offset_x_mm: offsetXMm, offset_y_mm: offsetYMm, offset_z_mm: offsetZMm, rotation_deg: rotationDeg,
          expected_revision: model.revision,
        };
        // Результат «Совместить автоматически» пишется В ТОМ ЖЕ PATCH, что
        // и сдвиг/поворот (не отдельным запросом) — не должно быть
        // промежутка, где смещение уже применено, а статус попытки ещё
        // старый (Docs/fbx-auto-placement-claude-prompt.md).
        if (d.pendingAutoPlacementStatus !== undefined) {
          body.auto_placement_status = d.pendingAutoPlacementStatus;
          body.auto_placement_diagnostics = d.pendingAutoPlacementDiagnostics || {};
        }
        const updated = await api(`/objects/${objectId}/external-models/${id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

    container.querySelectorAll(".em-placement").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      if (activeGesture && activeGesture.modelId === id) {
        activeGesture.stop(); // повторный клик — досрочная отмена (пока диалог виден, до скрытия)
        return;
      }
      if (activeGesture) return; // один жест разом
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      // Жест должен продолжать ТЕКУЩИЙ черновик (числовые поля могли уже
      // отличаться от сохранённого model.offset_mm/rotation_deg — Docs/
      // fbx-placement-claude-prompt.md §5), а не откатывать к сохранённому
      // значению на сервере. Невалидный/пустой ввод в поле — откат к
      // сохранённому как единственному надёжному числу.
      const draftOffsetXMm = mToMm(d.offsetXM);
      const draftOffsetYMm = mToMm(d.offsetYM);
      const draftRotationDeg = Number(String(d.rotationDeg).trim().replace(",", "."));
      const modelForGesture = {
        ...model,
        offset_mm: {
          ...model.offset_mm,
          x: draftOffsetXMm !== null ? draftOffsetXMm : model.offset_mm.x,
          y: draftOffsetYMm !== null ? draftOffsetYMm : model.offset_mm.y,
        },
        rotation_deg: Number.isFinite(draftRotationDeg) ? draftRotationDeg : model.rotation_deg,
      };
      // Снимок черновика ДО жеста — onPreview будет менять d прямо во время
      // перетаскивания; «Отмена»/Esc обязаны откатить черновик к этому
      // снимку, а не только визуально откатить группу в 3D (§5).
      const draftSnapshot = { offsetXM: d.offsetXM, offsetYM: d.offsetYM, rotationDeg: d.rotationDeg };
      const result = beginPlacement(modelForGesture, {
        onPreview: (xMm, yMm, rotationDeg) => {
          d.offsetXM = mmToM(xMm);
          d.offsetYM = mmToM(yMm);
          d.rotationDeg = rotationDeg; // полная точность — округление только при отображении (§5)
        },
        onDone: (xMm, yMm, rotationDeg) => {
          d.offsetXM = mmToM(xMm);
          d.offsetYM = mmToM(yMm);
          d.rotationDeg = rotationDeg;
          activeGesture = null;
          render();
        },
        onCancel: () => {
          d.offsetXM = draftSnapshot.offsetXM;
          d.offsetYM = draftSnapshot.offsetYM;
          d.rotationDeg = draftSnapshot.rotationDeg;
          activeGesture = null;
          render();
        },
      });
      if (!result.ok) {
        showToast(result.reason || "Настройка положения сейчас недоступна", "error");
        return;
      }
      activeGesture = { modelId: id, stop: result.stop };
      render();
    }));

    container.querySelectorAll(".em-calibrate").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      if (activeCalibration && activeCalibration.modelId === id) {
        activeCalibration.stop(); // повторный клик — досрочная отмена
        return;
      }
      if (activeCalibration || activeGesture) return; // один режим разом
      const model = models.find((m) => m.id === id);
      // Калибровка сама двигает/крутит группу по мере выбора точек — своя
      // точка отсчёта, черновик драг-жеста здесь ни при чём. Результат
      // применяется ТОЛЬКО в draft (§5 задания: до «Сохранить» ничего не
      // пишем), пользователь подтверждает обычной кнопкой «Сохранить».
      const d = draftFor(model);
      const result = beginCalibration(model, {
        onApply: ({ offsetXMm, offsetYMm, rotationDeg }) => {
          d.offsetXM = mmToM(offsetXMm);
          d.offsetYM = mmToM(offsetYMm);
          d.rotationDeg = rotationDeg;
          activeCalibration = null;
          showToast("Привязка рассчитана — проверьте черновик и нажмите «Сохранить»", "info");
          render();
        },
        onCancel: () => {
          activeCalibration = null;
          render();
        },
      });
      if (!result.ok) {
        showToast(result.reason || "Совмещение по точкам сейчас недоступно", "error");
        return;
      }
      activeCalibration = { modelId: id, stop: result.stop };
      render();
    }));

    container.querySelectorAll(".em-auto-align").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      btn.disabled = true;
      btn.textContent = "Ищу совмещение…";
      try {
        const { ensureExternalModelsLoaded } = await import("/static/external-models/app-bridge.js");
        const { THREE, FBXLoader, loadExternalModelFbx } = await ensureExternalModelsLoaded();
        // Для уже сохранённой модели группа THREE в памяти не хранится
        // (панель настроек не рисует свою 3D-сцену) — файл скачивается
        // повторно и разбирается заново, тем же путём, что при загрузке;
        // предпросмотр (если 3D объекта уже открыт где-то ещё) идёт через
        // deps.previewPlacement, а не эту временную группу.
        const res = await fetch(`/objects/${objectId}/external-models/${id}/content`);
        if (!res.ok) throw new Error("Не удалось скачать содержимое модели для расчёта");
        const arrayBuffer = await res.arrayBuffer();
        const parsed = await loadExternalModelFbx({ arrayBuffer, THREE, FBXLoader, kind: "facade" });
        let outcome;
        try {
          outcome = await computeAutoAlignment(model, THREE, parsed.group, parsed.sourceAnchorMm);
        } finally {
          parsed.dispose();
        }
        if (!outcome.applicable) {
          showToast(outcome.reason, "error");
          return;
        }
        d.pendingAutoPlacementStatus = outcome.dbStatus;
        d.pendingAutoPlacementDiagnostics = { ...outcome.diagnostics, reason: outcome.reason };
        d.ambiguousCandidates = outcome.status === "ambiguous" ? outcome.candidates : undefined;
        if (outcome.status === "confident" || outcome.status === "low_confidence") {
          d.offsetXM = mmToM(outcome.placement.offsetXMm);
          d.offsetYM = mmToM(outcome.placement.offsetYMm);
          d.rotationDeg = outcome.placement.rotationDeg;
          if (previewPlacement) previewPlacement(model, outcome.placement);
          showToast(
            outcome.status === "confident"
              ? "Совмещено автоматически — проверьте черновик (и 3D, если открыт) и нажмите «Сохранить»"
              : `Найдено приблизительное совмещение (${outcome.reason || "невысокая уверенность"}) — обязательно проверьте перед сохранением`,
            "info",
          );
        } else if (outcome.status === "ambiguous") {
          showToast(`Найдено несколько вариантов совмещения (${outcome.reason}) — выберите вариант ниже`, "info");
        } else {
          showToast(`Автоматическое совмещение не удалось: ${outcome.reason}`, "error");
        }
        render();
      } catch (e) {
        showToast(e.message || "Не удалось выполнить автоматическое совмещение", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Совместить автоматически";
      }
    }));

    container.querySelectorAll(".em-auto-candidate").forEach((btn) => btn.addEventListener("click", () => {
      const id = Number(btn.dataset.modelId);
      const idx = Number(btn.dataset.candidateIndex);
      const model = models.find((m) => m.id === id);
      const d = draftFor(model);
      const c = d.ambiguousCandidates && d.ambiguousCandidates[idx];
      if (!c) return;
      d.offsetXM = mmToM(c.offsetXMm);
      d.offsetYM = mmToM(c.offsetYMm);
      d.rotationDeg = c.rotationDeg;
      if (previewPlacement) previewPlacement(model, c);
      showToast(`Вариант ${idx + 1} — в черновике и в 3D (если открыт). Проверьте и нажмите «Сохранить».`, "info");
      render();
    }));

    container.querySelectorAll(".em-transfer-apply").forEach((btn) => btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.modelId);
      const card = container.querySelector(`.form-card[data-model-id="${id}"]`);
      const targetId = Number(card.querySelector(".em-transfer-target").value);
      if (!targetId) { showToast("Выберите модель, на которую перенести привязку", "error"); return; }
      const sourceModel = models.find((m) => m.id === id);
      const targetModel = models.find((m) => m.id === targetId);
      if (!confirm(
        `Перенести привязку «${sourceModel.name}» на «${targetModel.name}»? ` +
        `Это осмысленно ТОЛЬКО если оба FBX-файла заведомо из одного и того же источника координат ` +
        `(например, один и тот же экспорт сцены). Текущий черновик «${targetModel.name}» будет заменён — ` +
        `сохранение всё ещё отдельным нажатием «Сохранить».`)) return;
      const { computeTransferToModel } = await import("/static/external-models/app-bridge.js").then((m) => m.ensureExternalModelsLoaded());
      const { offsetXMm, offsetYMm, offsetZMm, rotationDeg } = computeTransferToModel(sourceModel, targetModel);
      const d = draftFor(targetModel);
      d.offsetXM = mmToM(offsetXMm);
      d.offsetYM = mmToM(offsetYMm);
      d.offsetZM = mmToM(offsetZMm);
      d.rotationDeg = rotationDeg;
      showToast(`Привязка перенесена на «${targetModel.name}» — проверьте черновик и нажмите «Сохранить»`, "info");
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
        const kind = container.querySelector('input[name="em-upload-kind"]:checked')?.value || "ground";
        statusEl.textContent = "Разбор файла в браузере…";
        try {
          const { ensureExternalModelsLoaded } = await import("/static/external-models/app-bridge.js");
          const { THREE, FBXLoader, loadExternalModelFbx } = await ensureExternalModelsLoaded();
          const buf = await file.arrayBuffer();
          const parsed = await loadExternalModelFbx({ arrayBuffer: buf, THREE, FBXLoader, kind });
          statusEl.textContent = `Разобрано: ${parsed.meshCount} меш(ей), ${parsed.triangleCount} треугольников, ` +
            `${parsed.textureCount} текстур. Загрузка на сервер…`;
          const meta = {
            name: file.name.replace(/\.fbx$/i, "") || KIND_LABELS[kind] || "Благоустройство",
            kind,
            source_anchor_mm: { x: parsed.sourceAnchorMm[0], y: parsed.sourceAnchorMm[1], z: parsed.sourceAnchorMm[2] },
            bbox_size_mm: parsed.bboxSizeMm,
            mesh_count: parsed.meshCount,
            triangle_count: parsed.triangleCount,
            texture_count: parsed.textureCount,
            warnings: parsed.warnings,
          };
          const form = new FormData();
          form.append("file", file);
          form.append("meta", JSON.stringify(meta));
          let created = await api(`/objects/${objectId}/external-models`, { method: "POST", body: form });

          // Автосовмещение — ТОЛЬКО для фасада, сразу после загрузки, по
          // ЕЩЁ РАЗОБРАННОЙ группе (не заново скачивать) — благоустройство
          // в поиске ориентации фасада не участвует (см. auto-align.js).
          //
          // Автоматически ПРИМЕНЯЕТСЯ (пишется offset/rotation сразу) —
          // ТОЛЬКО status=confident. Остальные исходы (включая
          // low_confidence) кладутся В ЧЕРНОВИК на явное подтверждение
          // «Сохранить» — задание §1: «слабый кандидат показывать в
          // предпросмотре, не записывать как подтверждённую привязку».
          // Причина попытки ВСЕГДА пишется через PATCH (даже когда
          // геометрии для сравнения нет вовсе) — раньше `!outcome.
          // applicable` тихо игнорировался, и человек не видел, что
          // автосовмещение вообще не пыталось сработать.
          if (kind === "facade") {
            statusEl.textContent = "Модель загружена. Поиск автоматического совмещения по контурам стен объекта…";
            try {
              const outcome = await computeAutoAlignment(created, THREE, parsed.group, parsed.sourceAnchorMm);
              const dbStatus = outcome.applicable ? outcome.dbStatus : "insufficient";
              const reason = outcome.applicable ? outcome.reason : outcome.reason;
              const patchBody = {
                auto_placement_status: dbStatus,
                auto_placement_diagnostics: { ...(outcome.diagnostics || {}), reason },
                expected_revision: created.revision,
              };
              if (dbStatus === "confident" && outcome.placement) {
                patchBody.offset_x_mm = outcome.placement.offsetXMm;
                patchBody.offset_y_mm = outcome.placement.offsetYMm;
                patchBody.rotation_deg = outcome.placement.rotationDeg;
              }
              created = await api(`/objects/${objectId}/external-models/${created.id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patchBody),
              });
              if (dbStatus === "confident") {
                showToast("Фасад совмещён автоматически по контурам стен объекта — проверьте результат", "info");
              } else if (dbStatus === "low_confidence") {
                const d = draftFor(created);
                d.offsetXM = mmToM(outcome.placement.offsetXMm);
                d.offsetYM = mmToM(outcome.placement.offsetYMm);
                d.rotationDeg = outcome.placement.rotationDeg;
                showToast(`Совмещение найдено приблизительно (${reason}) — проверьте черновик и нажмите «Сохранить»`, "warning");
              } else if (dbStatus === "ambiguous") {
                const d = draftFor(created);
                d.ambiguousCandidates = outcome.candidates;
                showToast(`Найдено несколько вариантов совмещения (${reason}) — выберите вариант в карточке модели`, "warning");
              } else {
                showToast(`Автоматическое совмещение не выполнено: ${reason}. Используйте «Совместить по точкам» или кнопку «Совместить автоматически» после уточнения модели МФР.`, "warning");
              }
            } catch (alignError) {
              // Ошибка автосовмещения НЕ должна маскировать успешную
              // загрузку самой модели — она уже есть на сервере как есть.
              showToast(`Модель загружена, но автосовмещение не удалось: ${alignError.message || alignError}`, "warning");
            }
          }

          parsed.dispose();
          models = [...models, created];
          statusEl.textContent = "";
          if (kind !== "facade") showToast("Модель загружена", "info");
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
