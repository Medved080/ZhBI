// Точка входа V2. Логин-гейт → шапка с возвратом в V1 → пилотный раздел
// «Пользователи и доступ». Другие разделы сюда сознательно не перенесены
// (см. Docs/OPEN.md) — открываются в текущем интерфейсе.
import { api, ApiError } from "./api.js";
import { renderLogin, renderChangePassword } from "./login.js";
import { mountUsersAccess } from "./users-access.js";

const root = document.getElementById("v2-root");

function setBackToV1() {
  // Постоянный сброс (не только переход): «Действия ▾» в V1 не должно
  // немедленно вернуть сюда же по cookie-предпочтению.
  location.href = "/?ui=v1";
}

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
  const usersLevel = permissions.features?.users || "none";
  root.innerHTML = `
    <header class="v2-head">
      <div class="v2-head-title">
        <strong>ЖБИ</strong>
        <span class="v2-badge">Новый интерфейс · Предварительная версия</span>
      </div>
      <div class="v2-head-right">
        <span class="v2-user-name">${escapeHtml(user.display_name)}</span>
        <button type="button" class="v2-back" id="v2-back-btn">← Текущий интерфейс</button>
      </div>
    </header>
    <main class="v2-page" id="v2-content"></main>
  `;
  document.getElementById("v2-back-btn").addEventListener("click", setBackToV1);

  const content = document.getElementById("v2-content");
  if (usersLevel === "none" && !permissions.system_admin) {
    content.innerHTML = `<div class="v2-note-page">
      <h3>Раздел «Пользователи и доступ» недоступен</h3>
      <p class="v2-muted">Пока в предпросмотре есть только этот раздел — остальные открываются в текущем интерфейсе.</p>
      <p><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
    </div>`;
    return;
  }
  mountUsersAccess(content, { api, user, permissions, canWrite: usersLevel === "write" || permissions.system_admin });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

boot();
