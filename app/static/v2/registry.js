// Реестр экранов V2: группы, экраны, структура форм V1 и правила доступа.
// Источники — `screens.json` (курируемый) и `screen-structure.json` (генерируется
// scripts/gen_v2_coverage.py из разметки V1). Модуль сам ничего не пишет и не
// обращается к API данных.

async function fetchJson(url) {
  const r = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadRegistry() {
  const [reg, structure] = await Promise.all([
    fetchJson("/static/v2/screens.json"),
    fetchJson("/static/v2/screen-structure.json"),
  ]);
  const byId = new Map(reg.screens.map((s) => [s.id, s]));
  return { groups: reg.groups, screens: reg.screens, structure, byId };
}

// Уровень «write» включает чтение (лестница, как в V1: can()).
function levelOk(level, kind) {
  return kind === "read" ? level === "read" || level === "write" : level === "write";
}

// Доступность экрана по правам ТЕКУЩЕГО объекта. Повторяет правила V1: раздел, которого на объекте нет по
// его типу (not_applicable), не показывается даже администратору; администратор сервиса видит остальное;
// пункт с несколькими разделами виден, если открыт хотя бы один. Экран без ограничений (нет data-feature) — всем.
export function screenAllowed(screen, structure, rights) {
  const need = [...(structure?.menu_features || []), ...(screen.feature || [])];
  if (!need.length) return true;
  const notApplicable = new Set(rights?.not_applicable || []);
  const features = rights?.features || {};
  return need.some(([names, kind]) => (Array.isArray(names) ? names : [names]).some((n) => {
    if (notApplicable.has(n)) return false;
    if (rights?.system_admin) return true;
    return levelOk(features[n] || "none", kind || "write");
  }));
}

// Ссылка в V1 с контекстом: объект, рабочее место, пункт меню «Действия». Разбирает V1 в applyStartupDeepLink()
// (app/static/app.js): параметры одноразовые, права V1 проверяет сам.
export function v1Href(screen, structure, objectId) {
  const p = new URLSearchParams({ ui: "v1" });
  if (objectId) p.set("object_id", String(objectId));
  if (screen.ws) p.set("ws", screen.ws);
  if (screen.view) p.set("view", screen.view);
  const menuItem = structure?.menu?.find((m) => !m.danger);
  if (menuItem) { p.set("open", "menu"); p.set("item", menuItem.id); }
  return "/?" + p.toString();
}

export const STATUS_LABEL = {
  1: "не начат",
  2: "каркас (визуально готов)",
  3: "чтение подключено",
  4: "операции подключены, проверка не завершена",
  5: "рабочий и проверенный",
  6: "заблокирован",
};
