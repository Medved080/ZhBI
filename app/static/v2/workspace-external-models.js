// Внешние 3D-модели (FBX) на рабочем месте со сценой: окно «Загрузка из FBX» с инструментами на сцене.
//
// Окно — та же панель, что у V1 и у страницы «Загрузить из FBX» (external-models-panel.js), но здесь у неё есть сцена: кадр движка V1
// (workspace.js). Всё, что требует сцены (сдвиг/поворот мышью, «Совместить по точкам», предпросмотр чисел, оси X/Y/Z, перечитывание
// слоя после сохранения), делается командами моста `ext*` (embed-bridge.js), а кадр отвечает событиями `ext-op`. Кадр ничего не пишет
// на сервер: числа результата возвращаются сюда, в черновик карточки, а «Сохранить» — обычный PATCH через api.js оболочки.
//
// На время режимов поверх 3D окно прячется (hidden), а не закрывается — черновик остаётся; плавающая панель «Готово/Отмена»
// режима рисуется самим кадром поверх сцены, Esc здесь снимает режим тоже.
import { showConfirmDialog } from "./dialogs.js";
import { mountExternalModelsPanel } from "./external-models-panel.js";

const START_TIMEOUT_MS = 8000;

// В кадр уходит только то, что нужно сцене (кадр собирает модель заново и проверяет числа)
function pack(m) {
  return {
    id: m.id, object_id: m.object_id, kind: m.kind, rotation_deg: Number(m.rotation_deg),
    offset_mm: { x: Number(m.offset_mm.x), y: Number(m.offset_mm.y), z: Number(m.offset_mm.z) },
    scale: { x: Number(m.scale?.x ?? 1), y: Number(m.scale?.y ?? 1), z: Number(m.scale?.z ?? 1) },
    source_anchor_mm: { x: Number(m.source_anchor_mm.x), y: Number(m.source_anchor_mm.y), z: Number(m.source_anchor_mm.z) },
    object_anchor_mm: { x: Number(m.object_anchor_mm.x), y: Number(m.object_anchor_mm.y) },
    metadata: m.metadata?.bbox_size_mm ? { bbox_size_mm: m.metadata.bbox_size_mm } : {},
  };
}

export function createWorkspaceExternalModels({ api, send, getObjectId, getScene, mfr }) {
  let dlg = null;        // {backdrop, panel, onKey}
  let op = null;         // {name, cb, resolve, timer} — режим на сцене, ждущий ответа/завершения
  let dirty = false;

  const sceneReady = () => { const s = getScene(); return !!(s && s.loaded && s.view && s.view !== "2d"); };
  const notReady = () => {
    const s = getScene();
    if (!s || !s.loaded) return "Схема ещё не загружена — дождитесь её и повторите.";
    return "Включите 3D (вкладка «Вид» → «Режим схемы») и дождитесь, пока модели на сцене разберутся.";
  };

  // Движок V1 сам прячет «своё» окно настроек на время режима поверх 3D; в кадре вместо него заглушка, поэтому окно V2
  // прячем и возвращаем здесь: режим начался — окно уходит, режим закончился (готово/отмена/ошибка) — возвращается.
  const setDialogHidden = (h) => { if (dlg) dlg.backdrop.hidden = h; };
  function finishOp() { if (op) { clearTimeout(op.timer); op = null; } setDialogHidden(false); }

  function startOp(name, cmd, model, cb) {
    if (op) return Promise.resolve({ ok: false, reason: "Уже идёт другой режим настройки — завершите его." });
    if (!sceneReady()) return Promise.resolve({ ok: false, reason: notReady() });
    return new Promise((resolve) => {
      op = { name, cb, resolve, started: false, timer: setTimeout(() => {
        if (op && !op.started) { const r = op.resolve; finishOp(); r({ ok: false, reason: "Сцена не ответила — повторите." }); }
      }, START_TIMEOUT_MS) };
      send(cmd, { model: pack(model) });
    });
  }

  // События кадра: {evt:"ext-op", op, phase, …}
  function onEvent(m) {
    if (m.evt !== "ext-op" || !op || m.op !== op.name) return;
    const cur = op;
    switch (m.phase) {
      case "started":
        cur.started = true; clearTimeout(cur.timer);
        setDialogHidden(true);
        cur.resolve({ ok: true, stop: () => send("extStop") });
        break;
      case "error": { const r = cur.resolve; finishOp(); r({ ok: false, reason: String(m.reason || "режим недоступен") }); break; }
      case "preview": cur.cb.onPreview?.(m.x, m.y, m.rot); break;
      case "done": finishOp(); cur.cb.onDone?.(m.x, m.y, m.rot); break;
      case "apply": finishOp(); cur.cb.onApply?.({ offsetXMm: m.offsetXMm, offsetYMm: m.offsetYMm, rotationDeg: m.rotationDeg }); break;
      case "cancel": finishOp(); cur.cb.onCancel?.(); break;
      default: break;
    }
  }

  const scene = {
    beginPlacement: (model, cb) => startOp("placement", "extPlacementStart", model, cb),
    beginCalibration: (model, cb) => startOp("calibration", "extCalibrationStart", model, cb),
    previewPlacement(model, o) {
      if (!sceneReady()) return;
      const ov = { offsetXMm: o.offsetXMm, offsetYMm: o.offsetYMm, rotationDeg: o.rotationDeg };
      for (const k of ["offsetZMm", "scaleX", "scaleY", "scaleZ"]) if (o[k] !== undefined && o[k] !== null) ov[k] = o[k];
      if (!Object.values(ov).every((v) => typeof v === "number" && Number.isFinite(v))) return;
      send("extPreview", { model: pack(model), override: ov });
    },
    showGizmo(model) { if (sceneReady()) send("extGizmo", { on: true, model: pack(model) }); },
    hideGizmo() { if (sceneReady()) send("extGizmo", { on: false }); },
  };

  function refreshScene() { send("extRefresh", { objectId: getObjectId() }); }

  async function close(force = false) {
    if (!dlg) return true;
    if (!force && dlg.panel.isDirty()) {
      const ok = await showConfirmDialog("В карточке модели есть несохранённые изменения положения. Закрыть окно без сохранения?", { confirmLabel: "Закрыть без сохранения", multiline: true });
      if (!ok) return false;
    }
    const d = dlg;
    dlg = null;
    document.removeEventListener("keydown", d.onKey, true);
    d.panel.destroy();            // снимает активный режим на сцене
    d.backdrop.remove();
    dirty = false;
    if (op) { send("extStop"); finishOp(); }
    send("extGizmo", { on: false });
    refreshScene();               // предпросмотр отброшенного черновика не должен оставаться на сцене
    return true;
  }

  async function open() {
    if (dlg) { dlg.backdrop.hidden = false; return; }
    // Инструментам нужна 3D-сцена: если схема в 2D, переключаем сами (план остаётся доступным обычным переключателем «Режим схемы»)
    const s = getScene();
    const switched = !!(s && s.loaded && s.view === "2d");
    if (switched) send("setView", { mode: "3d" });
    const objectId = getObjectId();
    let canEdit = false;
    try {
      const r = await api.get(`/me/permissions?object_id=${objectId}`);
      canEdit = !!r.system_admin || r.features?.external_models === "write";
    } catch (e) { canEdit = false; }
    if (dlg) return;
    const backdrop = document.createElement("div");
    backdrop.className = "v2-dialog-backdrop v2-em-backdrop";
    backdrop.innerHTML = `<div class="v2-dialog v2-em-dialog" role="dialog" aria-modal="true" aria-label="Загрузка из FBX">
      <div class="v2-em-head"><h3>Загрузка из FBX</h3></div>
      <p class="v2-muted" style="margin:0 0 10px">Модель принадлежит текущему объекту. Виден слой в его 3D (во вкладке «Вид» — переключатели «Благоустройство» / «Фасады из FBX»). Мышью, по точкам и с предпросмотром модель настраивается на сцене за этим окном${switched ? " — схема переключена в 3D" : ""}.</p>
      <div class="v2-em-scroll" data-em-host></div>
      <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-em-close>Закрыть</button></div></div>`;
    document.body.appendChild(backdrop);
    const panel = mountExternalModelsPanel(backdrop.querySelector("[data-em-host]"), {
      api, objectId, canEdit, scene,
      setHostVisible: (on) => { backdrop.hidden = !on; },
      onDirtyChange: (v) => { dirty = v; },
      onChanged: refreshScene,
    });
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (op || backdrop.hidden) { send("extStop"); e.preventDefault(); return; }   // Esc снимает режим на сцене
      if (document.querySelector(".v2-dialog-backdrop:not(.v2-em-backdrop)")) return;  // поверх открыт другой диалог — он обработает Esc сам
      e.preventDefault(); close();
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.querySelector("[data-em-close]").addEventListener("click", () => close());
    dlg = { backdrop, panel, onKey };
  }

  return {
    onEvent,
    open,
    close,
    isOpen: () => !!dlg,
    isDirty: () => dirty || !!dlg?.panel.isDirty(),
    // Блок «Вид»: кнопка открытия окна
    buttonHtml: () => `<div class="ws-actions"><button type="button" class="v2-btn" data-ext-open>Загрузка и настройка моделей (FBX)…</button></div>`,
    bind(body) { body.querySelectorAll("[data-ext-open]").forEach((b) => b.addEventListener("click", () => open())); },
    destroy() { if (dlg) close(true); finishOp(); },
  };
}
