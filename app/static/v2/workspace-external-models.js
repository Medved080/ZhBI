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

// «Загрузить из FBX» в меню — это окно ПОВЕРХ сцены (как в V1: диалог открывается над уже построенной схемой). Экран меню и рабочее
// место — разные экраны V2, поэтому запрос «открой окно» передаётся рабочему месту через sessionStorage (приём locate-handoff.js):
// одноразовый, живёт 5 минут, относится к одному объекту; рабочее место забирает его, когда схема загрузилась (workspace.js).
const OPEN_KEY = "v2.openFbxRequest";
const OPEN_TTL_MS = 5 * 60 * 1000;
export function requestOpenFbx(objectId) {
  try { sessionStorage.setItem(OPEN_KEY, JSON.stringify({ objectId: Number(objectId), at: Date.now() })); } catch (e) { /* хранилище недоступно — окно откроют кнопкой во вкладке «Вид» */ }
}
export function takeOpenFbx(objectId) {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem(OPEN_KEY) || "null"); } catch (e) { r = null; }
  if (!r) return false;
  if (Date.now() - (r.at || 0) > OPEN_TTL_MS) { try { sessionStorage.removeItem(OPEN_KEY); } catch (e) { /* */ } return false; }
  if (r.objectId !== Number(objectId)) return false;
  try { sessionStorage.removeItem(OPEN_KEY); } catch (e) { /* */ }
  return true;
}

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

// Управление окном, как у окон V1 (тот же набор: перетащить за заголовок, потянуть за угол, развернуть на весь экран, закрыть):
// до первого жеста окно стоит по центру и размером по содержимому, потом переводится в явное положение.
function setupWindowControls(win) {
  const head = win.querySelector("[data-em-drag]");
  const handle = win.querySelector("[data-em-resize]");
  const maxBtn = win.querySelector("[data-em-max]");
  const ensureFixed = () => {
    if (win.style.position === "fixed") return;
    const r = win.getBoundingClientRect();
    win.style.position = "fixed"; win.style.left = `${r.left}px`; win.style.top = `${r.top}px`; win.style.margin = "0";
  };
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || win.classList.contains("is-max")) return;
    ensureFixed();
    const sx = e.clientX, sy = e.clientY, left = parseFloat(win.style.left) || 0, top = parseFloat(win.style.top) || 0;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { win.style.left = `${left + ev.clientX - sx}px`; win.style.top = `${Math.max(0, top + ev.clientY - sy)}px`; };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up); head.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  handle.addEventListener("pointerdown", (e) => {
    if (win.classList.contains("is-max")) return;
    ensureFixed();
    const rect = win.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    win.style.width = `${rect.width}px`; win.style.height = `${rect.height}px`; win.style.maxWidth = "95vw"; win.style.maxHeight = "95vh";
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => { win.style.width = `${Math.max(480, rect.width + ev.clientX - sx)}px`; win.style.height = `${Math.max(260, rect.height + ev.clientY - sy)}px`; };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
    e.preventDefault(); e.stopPropagation();
  });
  let saved = null;
  maxBtn.addEventListener("click", () => {
    if (win.classList.toggle("is-max")) {
      saved = { position: win.style.position, left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height, maxWidth: win.style.maxWidth, maxHeight: win.style.maxHeight, margin: win.style.margin };
      maxBtn.title = "Свернуть из полного экрана"; maxBtn.setAttribute("aria-label", maxBtn.title);
    } else {
      Object.assign(win.style, saved || { position: "", left: "", top: "", width: "", height: "", maxWidth: "", maxHeight: "", margin: "" });
      maxBtn.title = "На весь экран"; maxBtn.setAttribute("aria-label", maxBtn.title);
    }
  });
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
      <div class="v2-em-head" data-em-drag title="Окно можно перетаскивать за заголовок"><h3>Загрузка из FBX</h3>
        <span class="v2-em-winbtns">
          <button type="button" class="v2-em-winbtn" data-em-max title="На весь экран" aria-label="На весь экран">⛶</button>
          <button type="button" class="v2-em-winbtn" data-em-x title="Закрыть" aria-label="Закрыть">✕</button>
        </span></div>
      <p class="v2-muted" style="margin:0 0 10px">Модель принадлежит текущему объекту. Виден слой в его 3D ЖБИ и «Модели МФР» — переключатель «Благоустройство» там же, во вкладке «Вид».${switched ? " Схема переключена в 3D: на ней настраивается положение." : ""}</p>
      <div class="v2-em-scroll" data-em-host></div>
      <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-em-close>Закрыть</button></div>
      <div class="v2-em-resize" data-em-resize title="Изменить размер (потянуть)"></div></div>`;
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
      // поверх открыт другой диалог (подтверждение, предпросмотр файла) — он обработает Esc сам
      if (document.querySelector(".v2-dialog-backdrop:not(.v2-em-backdrop), .emfp-backdrop")) return;
      e.preventDefault(); close();
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.querySelector("[data-em-close]").addEventListener("click", () => close());
    backdrop.querySelector("[data-em-x]").addEventListener("click", () => close());
    setupWindowControls(backdrop.querySelector(".v2-em-dialog"));
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
