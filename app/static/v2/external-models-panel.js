// Панель «Внешние 3D-модели объекта» (FBX) в V2 — ВСЯ функциональность V1 «Действия → Обмен данными → Загрузить из FBX».
//
// Логику не копируем: панель — тот же общий модуль, что у V1 (`/static/external-models/settings.js`: карточки моделей, черновик
// положения, автосовмещение, перенос привязки, загрузка с разбором в браузере), а раскладка карточек — прежняя (две колонки
// «Положение» / «Подобрать положение», форма загрузки внизу). Вид — V2: классы разметки перекрашены токенами V2 в
// `external-models.css`, диалоги — общие диалоги V2, запись — через `api.js` оболочки и его шлюз записи (`write-gate.js`).
//
// Инструменты на сцене (мышью сдвинуть/повернуть, «Совместить по точкам», «⤢ Настраивать поверх 3D», предпросмотр, оси) требуют
// 3D-сцены. Её рисует движок V1 в кадре рабочего места (workspace.js), поэтому передаётся `scene` — адаптер, который говорит с
// кадром по мосту (embed-bridge.js, команды ext*). Без `scene` (страница «Загрузить из FBX» в обмене данными) кнопок сцены в
// карточках нет — как в V1 без открытой сцены; остальное работает так же.
import { esc, makeStatus, errText, isUnknownOutcome, unknownOutcomeHtml, verifyOutcome } from "./exchange-common.js";
import { showConfirmDialog } from "./dialogs.js";

// api V1 (`api(url, {method, headers, body})` → JSON, исключение с текстом) поверх api.js V2 (шлюз записи, понятные тексты ошибок).
function v1Api(api) {
  return async function request(url, opts = {}) {
    const method = String(opts.method || "GET").toUpperCase();
    if (method === "GET") return api.get(url);
    if (typeof FormData !== "undefined" && opts.body instanceof FormData) return api.upload(url, opts.body);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method === "POST") return api.post(url, body);
    if (method === "PATCH") return api.patch(url, body);
    if (method === "PUT") return api.put(url, body);
    if (method === "DELETE") return api.delete(url);
    throw new Error(`внешние модели: метод ${method} не поддержан`);
  };
}

/**
 * @param {HTMLElement} el — куда монтировать (содержимое заменяется)
 * @param {object} o
 * @param {object} o.api — api.js V2
 * @param {number} o.objectId
 * @param {boolean} [o.canEdit=true]
 * @param {object|null} [o.scene] — адаптер сцены {beginPlacement, beginCalibration, previewPlacement, showGizmo, hideGizmo}
 * @param {(on:boolean)=>void} [o.setHostVisible] — спрятать/вернуть окно на время режимов поверх 3D
 * @param {(dirty:boolean)=>void} [o.onDirtyChange]
 * @param {()=>void} [o.onChanged] — модели на сервере изменились (сцене нужно перечитать слой)
 * @returns {{reload:Function,isDirty:Function,isToolActive:Function,stopTools:Function,destroy:Function}}
 */
// Стили панели подключаются самой панелью: страница V2 из кэша браузера (index.html без заголовков кэша) может быть старой
// и не знать про external-models.css — тогда панель выглядела бы голой разметкой (замечание 2026-10-09).
function ensureCss() {
  if (document.querySelector('link[href*="/static/v2/external-models.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = "/static/v2/external-models.css";
  document.head.appendChild(link);
}

export function mountExternalModelsPanel(el, o) {
  ensureCss();
  const { api, objectId, canEdit = true, scene = null } = o;
  el.classList.add("v2-em-wrap");
  el.innerHTML = `<div class="v2-ex-status" role="status" aria-live="polite" data-em-status></div><div class="v2-em" data-em-body><p class="v2-muted">Загрузка…</p></div>`;
  const statusEl = el.querySelector("[data-em-status]");
  const body = el.querySelector("[data-em-body]");
  const status = makeStatus(statusEl);
  let dead = false;
  let handle = null;

  // Сообщения общего модуля (в V1 это строка состояния под окном) — здесь строка над карточками, не перекрытая ничем
  const showToast = (message, kind = "info") => {
    if (dead) return;
    status.set(String(message), kind === "error" ? "bad" : kind === "info" ? "ok" : "");
  };

  const deps = {
    objectId, canEdit,
    api: v1Api(api),
    escapeHtml: esc,
    showToast,
    onChanged: () => { if (!dead && o.onChanged) o.onChanged(); },
    setHostVisible: (on) => { if (o.setHostVisible) o.setHostVisible(on); },
    onDirtyChange: (dirty) => { if (o.onDirtyChange) o.onDirtyChange(dirty); },
    confirm: (text, opts = {}) => showConfirmDialog(text, { multiline: true, ...opts }),
    // Подтверждение загрузки — общее с V1 окно предпросмотра содержимого файла (external-models/file-preview.js): deps.confirmUpload не задаём
    // Обрыв связи посреди отправки: файл мог дойти, мог нет — автоматически не повторяем, предлагаем сверку по журналу
    onUploadError: (e) => {
      if (!isUnknownOutcome(e)) return;
      status.html(unknownOutcomeHtml("загрузка 3D-модели"), "bad");
      statusEl.querySelector("[data-verify]")?.addEventListener("click", () =>
        verifyOutcome(api, statusEl, { action: "external_model_upload", entityId: objectId, sinceMs: Date.now(), what: "загрузка 3D-модели" }));
    },
  };
  if (scene) Object.assign(deps, scene);

  import("/static/external-models/settings.js").then(({ renderExternalModelsPanel }) => {
    if (dead) return;
    handle = renderExternalModelsPanel(body, deps);
  }).catch((err) => {
    if (!dead) status.set(`Не удалось открыть панель моделей: ${errText(err)}`, "bad");
  });

  return {
    reload: () => handle?.reload(),
    isDirty: () => Boolean(handle?.isDirty()),
    isToolActive: () => Boolean(handle?.isToolActive()),
    stopTools: () => handle?.stopTools(),
    destroy() { dead = true; handle?.stopTools(); },
  };
}
