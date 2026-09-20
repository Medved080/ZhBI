// Точка входа тестового стенда: подменяет fetch фейковым бэкендом и только
// потом загружает НАСТОЯЩИЙ main.js V2. Параметры адреса:
//   ?session=0        — нет сессии (экран входа)
//   ?perm=<профиль>   — профиль прав (admin по умолчанию), см. PROFILES
import { installFakeBackend } from "/tests/fake-backend.js";

// Профили прав для сценариев «пользователь без доступа», «только чтение».
const PROFILES = {
  readonly: { system_admin: false, features: { users: "read", roles: "read", projects: "read", counterparties: "read", dict_delete: "none" } },
  none: { system_admin: false, features: {} },
  writer: { system_admin: false, features: { users: "write", roles: "write", projects: "write", counterparties: "write", dict_delete: "none" } },
  deleter: { system_admin: false, features: { users: "write", roles: "write", projects: "write", counterparties: "write", dict_delete: "write" } },
};

const params = new URLSearchParams(location.search);
const ctl = installFakeBackend();
window.__fake = ctl;

if (params.get("session") === "0") ctl.setSession(false);
const profile = PROFILES[params.get("perm")];
if (profile) ctl.setPermissions(profile);

// ?failNext={"pattern":"GET /me/permissions","status":500,"detail":"сбой"} —
// отказ ДО загрузки V2 (для сценариев вроде «права не загрузились»).
const failNext = params.get("failNext");
if (failNext) { const { pattern, ...o } = JSON.parse(failNext); ctl.failNext(pattern, o); }

// ?scene=<id> — довести экран до именованного состояния (scenes.js) для снимков.
const sceneId = params.get("scene");
let scene = null;
if (sceneId) {
  const { SCENES } = await import("/tests/scenes.js");
  scene = SCENES[sceneId];
  if (!scene) throw new Error(`Нет сцены «${sceneId}»`);
  scene.pre?.(ctl);
}

await import("/static/v2/main.js");
if (scene) {
  const { makeApp } = await import("/tests/helpers.js");
  try { await scene.open(makeApp(window, document, ctl)); }
  catch (e) { document.documentElement.dataset.sceneError = String(e && e.message || e); }
  document.documentElement.dataset.scene = "ready";
}
document.documentElement.dataset.harness = "ready";
