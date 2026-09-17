// Точка входа V2. Логин-гейт → шапка с возвратом в V1 → пилотный раздел
// «Пользователи и доступ». Другие разделы сюда сознательно не перенесены
// (см. Docs/OPEN.md) — открываются в текущем интерфейсе.
import { api, ApiError } from "./api.js";
import { renderLogin, renderChangePassword } from "./login.js";
import { mountUsersAccess } from "./users-access.js";

const root = document.getElementById("v2-root");

// Тёмные гаммы V1 (index.html, :root[data-skin="..."]) — geometрия и
// типографика у всех тем общие, различаются только токены; полный перенос
// каждой темы в V2 не сделан (см. отчёт), но светлая/тёмная СЕМЬЯ выбранной
// пользователем гаммы уважается вместо слепого следования системной теме
// браузера — иначе тёмную "Индиго"/"Графит"/"Неон" V2 показывал бы светлой
// заставкой, а светлые — наоборот, будь у ОС другая настройка.
const DARK_SKINS = new Set(["graphite", "indigo", "neon"]);
function applyThemeFamily(uiTheme) {
  try { document.documentElement.style.colorScheme = DARK_SKINS.has(uiTheme) ? "dark" : "light"; }
  catch (e) { /* доступ к documentElement.style не должен ронять загрузку */ }
}

let activeModule = null; // {hasUnsavedChanges, guardLeave} текущего смонтированного раздела

function setBackToV1() {
  // Постоянный сброс (не только переход): «Действия ▾» в V1 не должно
  // немедленно вернуть сюда же по cookie-предпочтению.
  location.href = "/?ui=v1";
}

async function onBackClick() {
  if (api.hasPendingWrites()) return; // кнопка и так задизейблена — вторая защита на всякий случай
  if (activeModule && !(await activeModule.guardLeave())) return;
  setBackToV1();
}

window.addEventListener("beforeunload", (e) => {
  if (activeModule && activeModule.hasUnsavedChanges()) {
    // Стандартное предупреждение браузера — текстом управлять нельзя (и не
    // обещаем это), возвращаемое значение только включает диалог.
    e.preventDefault();
    e.returnValue = "";
  }
});

async function boot() {
  let me;
  try {
    me = await api.get("/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      root.classList.remove("v2-loading");
      await renderLogin(root, { api, onSuccess: (user) => afterLogin(user) });
      return;
    }
    renderFatal(err);
    return;
  }
  afterLogin(me);
}

async function afterLogin(user) {
  applyThemeFamily(user.ui_theme);
  if (user.must_change_password) {
    root.classList.remove("v2-loading");
    await renderChangePassword(root, { api, onSuccess: (u) => afterLogin(u) });
    return;
  }
  let permissions;
  try {
    permissions = await api.get("/me/permissions");
  } catch (err) {
    renderFatal(err);
    return;
  }
  renderShell(user, permissions);
}

function renderFatal(err) {
  root.classList.remove("v2-loading");
  root.innerHTML = `<div class="v2-note-page">
    <h3>Не удалось загрузить интерфейс</h3>
    <p class="v2-muted">${escapeHtml(err instanceof ApiError ? String(err.detail) : String(err))}</p>
    <p><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
  </div>`;
}

function renderShell(user, permissions) {
  root.classList.remove("v2-loading");
  const isSystemAdmin = !!permissions.system_admin;
  const perms = {
    isSystemAdmin,
    users: permissions.features?.users || "none",
    roles: permissions.features?.roles || "none",
  };
  const canReadUsers = isSystemAdmin || perms.users !== "none";
  const canReadRoles = isSystemAdmin || perms.roles !== "none";
  // Список ролей (ключ+имя) для подписей в "Доступе к объектам" и
  // "Проверке доступа" — часть ЛЮБОГО ответа /me/permissions, не требует
  // отдельного гранта "roles" (в отличие от GET /roles).
  const roleList = permissions.roles || [];

  root.innerHTML = `
    <header class="v2-head">
      <div class="v2-head-title">
        <strong>ЖБИ</strong>
        <span class="v2-badge">Новый интерфейс · Предварительная версия</span>
      </div>
      <div class="v2-head-right">
        <span class="v2-user-name">${escapeHtml(user.display_name)}</span>
        <button type="button" class="v2-back" id="v2-back-btn" title="">← Текущий интерфейс</button>
      </div>
    </header>
    <main class="v2-page" id="v2-content"></main>
  `;
  const backBtn = document.getElementById("v2-back-btn");
  backBtn.addEventListener("click", onBackClick);
  api.onPendingWritesChange((n) => {
    backBtn.disabled = n > 0;
    backBtn.title = n > 0 ? "Дождитесь завершения сохранения" : "";
  });

  const content = document.getElementById("v2-content");
  if (!canReadUsers && !canReadRoles) {
    content.innerHTML = `<div class="v2-note-page">
      <h3>Раздел «Пользователи и доступ» недоступен</h3>
      <p class="v2-muted">Пока в предпросмотре есть только этот раздел — остальные открываются в текущем интерфейсе.</p>
      <p><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
    </div>`;
    return;
  }
  activeModule = mountUsersAccess(content, { api, user, perms, canReadUsers, canReadRoles, roleList });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
