// Классификатор видов работ в V2 (2026-10-27): рамка V2 вокруг общего с V1 модуля app/static/work-classifier.js.
// Запросы идут через api.js, то есть через шлюз записи (write-gate.js, записи `wcl.*`).
import { esc, canAccounting } from "./mfr-common.js";

// Модуль V1 ждёт функцию вида `api(path, fetch-опции)`; V2 ходит через методы api.get/post/put/delete/upload.
export function classifierRequest(api) {
  return (path, opts = {}) => {
    const method = String(opts.method || "GET").toUpperCase();
    if (method === "GET") return api.get(path);
    if (method === "DELETE") return api.delete(path);
    if (opts.body instanceof FormData) return api.upload(path, opts.body);
    const body = opts.body ? JSON.parse(opts.body) : {};
    return method === "PUT" ? api.put(path, body) : api.post(path, body);
  };
}

let moduleCache = null;
const loadModule = () => (moduleCache ||= import("../work-classifier.js"));

export function mountWorkClassifierScreen(el, { screen, api, rights, groupTitle }) {
  el.className = "v2-page";
  el.innerHTML = `<div class="v2-container v2-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2></div>
    <div id="wcl-host"></div></div>`;
  const canWrite = !!rights?.system_admin || rights?.features?.dict_work_classifier === "write";
  let dead = false;
  loadModule().then((mod) => {
    if (!dead) mod.openWorkClassifier({ api: classifierRequest(api), canWrite, container: el.querySelector("#wcl-host") });
  });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

// Окна объекта («Учёт по блокам → Виды работ»): набор позиций из классификатора и соответствие категорий модели.
export async function openObjectPicker({ api, objectId, rights, onSaved }) {
  const mod = await loadModule();
  mod.openWorkStructurePicker({ api: classifierRequest(api), objectId, canWrite: canAccounting(rights, "write"), onSaved });
}
export async function openObjectCategoryMap({ api, objectId, rights, onSaved }) {
  const mod = await loadModule();
  mod.openCategoryMap({ api: classifierRequest(api), objectId, canWrite: canAccounting(rights, "write"), onSaved });
}
