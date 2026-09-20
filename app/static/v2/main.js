// Точка входа V2. Логин-гейт → шапка с возвратом в V1 → переключатель
// разделов. Раздел «Пользователи и доступ» — пилот (df4da55); «Проекты и
// объекты» и «Контрагенты» — следующая перенесённая группа (см. отчёт).
// Остальные разделы сюда сознательно не перенесены (см. Docs/OPEN.md) —
// открываются в текущем интерфейсе.
import { api, ApiError } from "./api.js";
import { renderLogin, renderChangePassword } from "./login.js";
import { mountUsersAccess } from "./users-access.js";
import { mountProjectsObjects } from "./projects-objects.js";
import { mountCounterparties } from "./counterparties.js";
import { keepFocus } from "./focus.js";

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

// Один переход за раз: пока идёт guardLeave (диалог «Несохранённые
// изменения», возможное сохранение) и монтирование нового раздела, вторые и
// третьи клики по вкладкам разделов и по «← Текущий интерфейс» игнорируются.
let navBusy = false;

function setBackToV1() {
  // Постоянный сброс (не только переход): «Действия ▾» в V1 не должно
  // немедленно вернуть сюда же по cookie-предпочтению.
  location.href = "/?ui=v1";
}

async function onBackClick() {
  if (navBusy || api.hasPendingWrites()) return; // кнопка и так задизейблена — вторая защита на всякий случай
  navBusy = true;
  try {
    if (activeModule && !(await activeModule.guardLeave())) return;
    setBackToV1();
  } finally { navBusy = false; }
}

window.addEventListener("beforeunload", (e) => {
  // Незавершённая запись тоже требует предупреждения: закрытие страницы
  // посреди сохранения оставило бы пользователя без ответа сервера.
  if ((activeModule && activeModule.hasUnsavedChanges()) || api.hasPendingWrites()) {
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
    // "Проекты и объекты" в V1 целиком, включая чтение, гейтится write'ом
    // (index.html: data-feature-kind="write" у пункта меню) — отдельного
    // read-only режима у этого экрана в оригинале нет, поэтому в V2 раздел
    // тоже открывается только при уровне "write".
    projects: permissions.features?.projects || "none",
    dictDelete: permissions.features?.dict_delete || "none",
    // "Контрагенты" — тот же самый паттерн: write-гейт на весь раздел
    // (index.html: data-feature-kind="write" у пункта меню), read-only
    // режима у экрана в V1 нет.
    counterparties: permissions.features?.counterparties || "none",
  };
  const canReadUsers = isSystemAdmin || perms.users !== "none";
  const canReadRoles = isSystemAdmin || perms.roles !== "none";
  const canOpenProjects = isSystemAdmin || perms.projects === "write";
  const canOpenCounterparties = isSystemAdmin || perms.counterparties === "write";
  // Список ролей (ключ+имя) для подписей в "Доступе к объектам" и
  // "Проверке доступа" — часть ЛЮБОГО ответа /me/permissions, не требует
  // отдельного гранта "roles" (в отличие от GET /roles).
  const roleList = permissions.roles || [];

  const sections = [
    {
      key: "users-access", title: "Пользователи и доступ", available: canReadUsers || canReadRoles,
      mount: (el) => mountUsersAccess(el, { api, user, perms, canReadUsers, canReadRoles, roleList }),
    },
    {
      key: "projects-objects", title: "Проекты и объекты", available: canOpenProjects,
      mount: (el) => mountProjectsObjects(el, { api, user, perms }),
    },
    {
      key: "counterparties", title: "Контрагенты", available: canOpenCounterparties,
      mount: (el) => mountCounterparties(el, { api, user, perms }),
    },
  ];
  const availableSections = sections.filter((s) => s.available);

  root.innerHTML = `
    <header class="v2-head">
      <div class="v2-head-title">
        <strong>ЖБИ</strong>
        <span class="v2-badge">Новый интерфейс · Предварительная версия</span>
      </div>
      <div class="v2-head-right">
        <span class="v2-nav-note" id="v2-nav-note" role="status" aria-live="polite"></span>
        <span class="v2-user-name">${escapeHtml(user.display_name)}</span>
        <button type="button" class="v2-back" id="v2-back-btn" title="">← Текущий интерфейс</button>
      </div>
    </header>
    ${availableSections.length > 1 ? `<nav class="v2-nav" aria-label="Разделы"><div class="v2-container">
      ${availableSections.map((s) => `<button type="button" data-section="${s.key}" aria-pressed="false">${escapeHtml(s.title)}</button>`).join("")}
    </div></nav>` : ""}
    <main class="v2-page" id="v2-content"></main>
  `;
  const backBtn = document.getElementById("v2-back-btn");
  backBtn.addEventListener("click", onBackClick);
  // Пока идёт любая запись (сохранение, удаление, загрузка файла) переходы
  // между разделами и в V1 недоступны, а причина написана рядом с вкладками —
  // не только в подсказке заблокированной кнопки. Снимается и после успеха,
  // и после ошибки: счётчик записей опускается в finally самого запроса.
  const WAIT_TEXT = "Идёт сохранение — переход временно недоступен";
  api.onPendingWritesChange((n) => {
    backBtn.disabled = n > 0;
    backBtn.title = n > 0 ? "Дождитесь завершения сохранения" : "";
    document.querySelectorAll(".v2-nav [data-section]").forEach((b) => { b.disabled = n > 0; });
    const note = document.getElementById("v2-nav-note");
    if (note) note.textContent = n > 0 ? WAIT_TEXT : "";
  });

  const content = document.getElementById("v2-content");
  if (!availableSections.length) {
    content.innerHTML = `<div class="v2-note-page">
      <h3>Нет доступных разделов предпросмотра</h3>
      <p class="v2-muted">Пока в предпросмотре есть «Пользователи и доступ», «Проекты и объекты» и «Контрагенты» — остальные открываются в текущем интерфейсе.</p>
      <p><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
    </div>`;
    return;
  }

  // Общий хранитель фокуса на контейнере раздела: перерисовка области через
  // innerHTML не должна сбрасывать фокус клавиатуры на <body>.
  const focusKeeper = keepFocus(content);
  const navButtons = [...document.querySelectorAll(".v2-nav [data-section]")];
  async function openSection(key) {
    if (navBusy || api.hasPendingWrites()) return;
    navBusy = true;
    try {
      if (activeModule && !(await activeModule.guardLeave())) return;
      // guardLeave мог сохранять данные и сам начать/закончить запись; если
      // после него запись всё ещё идёт (например, второй поток), не уходим.
      if (api.hasPendingWrites()) return;
      // destroy() — необязательный хук раздела (сейчас есть только у
      // "Проекты и объекты", у него живая мини-карта MapLibre со своим
      // graphics-контекстом): content.innerHTML ниже уничтожит её DOM-узел,
      // но не сам контекст — без явного remove() внутри destroy() браузер
      // рано или поздно перестанет строить новые карты вовсе.
      activeModule?.destroy?.();
      focusKeeper.reset();
      content.innerHTML = "";
      // Оформление раздела не должно зависеть от порядка посещения: классы,
      // которые раздел мог повесить на общий контейнер, сбрасываются здесь.
      content.className = "v2-page";
      navButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.section === key)));
      const section = availableSections.find((s) => s.key === key);
      activeModule = section.mount(content);
    } finally { navBusy = false; }
  }
  navButtons.forEach((b) => b.addEventListener("click", () => openSection(b.dataset.section)));
  openSection(availableSections[0].key);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
