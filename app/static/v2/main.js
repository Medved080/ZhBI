// Точка входа V2. Логин-гейт → шапка (объект, возврат в V1) → левая навигация по ВСЕМ разделам сервиса
// (реестр `screens.json`, Docs/v2-interface-coverage.md). Перенесены целиком «Пользователи и доступ», «Проекты и
// объекты» и «Контрагенты»; остальные экраны показывают состав формы V1 и открывают её в текущем интерфейсе
// с контекстом объекта (screen-view.js), пока их операции не подключены.
import { api, ApiError } from "./api.js";
import { renderLogin, renderChangePassword } from "./login.js";
import { mountUsersAccess } from "./users-access.js";
import { mountProjectsObjects } from "./projects-objects.js";
import { mountCounterparties } from "./counterparties.js";
import { keepFocus } from "./focus.js";
import { loadRegistry, screenAllowed } from "./registry.js";
import { mountScreenView, mountHome } from "./screen-view.js";
import { mountReadScreen } from "./read-screen.js";
import { mountDictEdit } from "./dict-edit.js";
import { mountSettingEdit } from "./setting-edit.js";
import { mountColorEdit } from "./color-edit.js";
import { mountPrefixEdit } from "./prefix-edit.js";
import { mountProjectCardEdit, mountReportNotesEdit } from "./card-edit.js";
import { mountExportForm } from "./export-form.js";
import { mountSessionsEdit } from "./sessions-edit.js";
import { mountSubtypesEdit } from "./subtypes-edit.js";

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
  await renderShell(user, permissions);
}

function renderFatal(err) {
  root.classList.remove("v2-loading");
  root.innerHTML = `<div class="v2-note-page">
    <h3>Не удалось загрузить интерфейс</h3>
    <p class="v2-muted">${escapeHtml(err instanceof ApiError ? String(err.detail) : String(err))}</p>
    <p><a class="v2-link" href="/?ui=v1">← Открыть текущий интерфейс</a></p>
  </div>`;
}

// Модульные экраны (перенесены целиком) → их монтирование. Остальные экраны реестра показывают каркас
// с переходом в V1 (screen-view.js).
const MODULES = {
  "users-access": (el, ctx) => mountUsersAccess(el, ctx),
  "projects-objects": (el, ctx) => mountProjectsObjects(el, ctx),
  "counterparties": (el, ctx) => mountCounterparties(el, ctx),
};

function readSession(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
function writeSession(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* приватный режим */ } }

async function renderShell(user, permissions) {
  let registry;
  try {
    registry = await loadRegistry();
  } catch (err) {
    renderFatal(err);
    return;
  }
  // Дерево проектов — контекст «Объект» шапки. Его отсутствие не мешает работе разделов, не зависящих от объекта.
  let tree = { projects: [], last_object_id: null, failed: false };
  try {
    const t = await api.get("/projects-tree");
    tree = { projects: t.projects || [], last_object_id: t.last_object_id ?? null, failed: false };
  } catch (err) {
    tree.failed = true;
  }
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
    // режима у экрана в оригинале нет.
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
  const moduleAvailable = {
    "users-access": canReadUsers || canReadRoles,
    "projects-objects": canOpenProjects,
    "counterparties": canOpenCounterparties,
  };
  const moduleCtx = { api, user, perms, canReadUsers, canReadRoles, roleList };

  // ---- контекст «Объект»: права считаются по показываемому объекту (как в V1, can()), поэтому при смене
  // объекта пересчитываются и доступные экраны. На сервер выбор НЕ пишется (V1 запоминает его в /me/last-object —
  // здесь это привело бы к побочному изменению предпочтения пользователя при простом просмотре).
  const activeObjects = tree.projects.flatMap((p) => (p.objects || []).map((o) => ({ ...o, project_name: p.name })))
    .filter((o) => (o.status || "active") !== "archived");
  const remembered = Number(readSession("v2.objectId")) || null;
  const pick = (id) => activeObjects.find((o) => o.id === id);
  let objectId = (pick(remembered) || pick(tree.last_object_id) || activeObjects.find((o) => o.elements > 0) || activeObjects[0] || {}).id ?? null;
  let rights = permissions;
  async function loadRights() {
    if (!objectId) { rights = permissions; return true; }
    try {
      rights = await api.get(`/me/permissions?object_id=${objectId}`);
      return true;
    } catch (err) {
      rights = permissions; // не смогли узнать — остаёмся на правах без объекта, а не открываем лишнее
      return false;
    }
  }
  let rightsOk = await loadRights();

  const screenOf = (key) => registry.byId.get(key);
  const isModule = (s) => s.impl.startsWith("module:");
  const allowedScreen = (s) => isModule(s)
    ? !!moduleAvailable[s.id]
    : screenAllowed(s, registry.structure[s.id], rights);
  const groupTitle = (id) => registry.groups.find((g) => g.id === id)?.title || "";

  const objectOptions = tree.projects.map((p) => {
    const objs = (p.objects || []).filter((o) => (o.status || "active") !== "archived");
    if (!objs.length) return "";
    return `<optgroup label="${escapeHtml(p.name)}">${objs.map((o) =>
      `<option value="${o.id}" ${o.id === objectId ? "selected" : ""}>${escapeHtml(o.name)}${o.elements ? ` · ${o.elements}` : " · пусто"}</option>`).join("")}</optgroup>`;
  }).join("");

  root.innerHTML = `
    <header class="v2-head">
      <div class="v2-head-title">
        <strong>ЖБИ</strong>
        <span class="v2-badge">Новый интерфейс · Предварительная версия</span>
      </div>
      <div class="v2-head-right">
        <label class="v2-ctx" title="Права и переходы в текущий интерфейс считаются по выбранному объекту">Объект
          <select id="v2-object" ${activeObjects.length ? "" : "disabled"} aria-label="Объект">
            ${activeObjects.length ? objectOptions : `<option>${tree.failed ? "Не удалось загрузить" : "Нет объектов"}</option>`}
          </select>
        </label>
        <span class="v2-nav-note" id="v2-nav-note" role="status" aria-live="polite"></span>
        <span class="v2-user-name">${escapeHtml(user.display_name)}</span>
        <button type="button" class="v2-back" id="v2-back-btn" title="">← Текущий интерфейс</button>
      </div>
    </header>
    <div class="v2-body">
      <nav class="v2-nav v2-shellnav" aria-label="Разделы" id="v2-side"></nav>
      <main class="v2-page" id="v2-content"></main>
    </div>
  `;
  const backBtn = document.getElementById("v2-back-btn");
  backBtn.addEventListener("click", onBackClick);
  const objectSelect = document.getElementById("v2-object");
  const content = document.getElementById("v2-content");
  const side = document.getElementById("v2-side");

  // ---- левая навигация: поиск + группы (сворачиваются) + экраны
  const collapsed = new Set((readSession("v2.navCollapsed") || "").split(",").filter(Boolean));
  let currentKey = null;
  let searchText = "";
  function renderNav() {
    const q = searchText.trim().toLowerCase();
    const groups = registry.groups.filter((g) => g.id !== "home").map((g) => {
      const items = registry.screens.filter((s) => s.group === g.id && allowedScreen(s)
        && (!q || s.title.toLowerCase().includes(q)));
      return { g, items };
    }).filter((x) => x.items.length);
    side.innerHTML = `
      <input type="search" id="v2-nav-search" class="v2-nav-search" placeholder="Найти раздел" aria-label="Найти раздел" value="${escapeHtml(searchText)}">
      <button type="button" data-section="home" class="v2-nav-home" aria-pressed="${currentKey === "home"}">Начало</button>
      ${groups.map(({ g, items }) => {
        const open = q || !collapsed.has(g.id) || items.some((s) => s.id === currentKey);
        return `<div class="v2-nav-group">
          <button type="button" class="v2-nav-group-head" data-group="${g.id}" aria-expanded="${open}">${escapeHtml(g.title)} <span class="v2-muted">${items.length}</span></button>
          ${open ? items.map((s) => `<button type="button" data-section="${s.id}" aria-pressed="${s.id === currentKey}">
            ${escapeHtml(s.title)}${isModule(s) ? "" : s.impl === "export-form" ? ` <span class="v2-nav-tag" title="Выгрузка файла в новом интерфейсе">экспорт</span>` : s.impl.endsWith("-edit") ? ` <span class="v2-nav-tag" title="Справочник правится в новом интерфейсе; удаление с заменой — в текущем">прав.</span>` : s.impl === "read" ? ` <span class="v2-nav-tag" title="Просмотр в новом интерфейсе; изменение — в текущем">чт.</span>` : ` <span class="v2-nav-tag" title="Функции работают в текущем интерфейсе">V1</span>`}</button>`).join("") : ""}
        </div>`;
      }).join("") || `<p class="v2-muted v2-nav-empty">Ничего не найдено по запросу.</p>`}`;
    const search = document.getElementById("v2-nav-search");
    search.addEventListener("input", () => {
      searchText = search.value;
      const pos = search.selectionStart;
      renderNav();
      const s2 = document.getElementById("v2-nav-search");
      s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) { /* type=search */ }
    });
    side.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.group;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      writeSession("v2.navCollapsed", [...collapsed].join(","));
      renderNav();
      side.querySelector(`[data-group="${id}"]`)?.focus();
    }));
    side.querySelectorAll("[data-section]").forEach((b) => b.addEventListener("click", () => openSection(b.dataset.section)));
    syncPending(api.pendingWritesCount?.() ?? (api.hasPendingWrites() ? 1 : 0));
  }
  // Пока идёт любая запись (сохранение, удаление, загрузка файла) переходы
  // между разделами и в V1 недоступны, а причина написана в шапке — не только в
  // подсказке заблокированной кнопки. Снимается и после успеха, и после ошибки:
  // счётчик записей опускается в finally самого запроса.
  const WAIT_TEXT = "Идёт сохранение — переход временно недоступен";
  function syncPending(n) {
    backBtn.disabled = n > 0;
    backBtn.title = n > 0 ? "Дождитесь завершения сохранения" : "";
    objectSelect.disabled = n > 0 || !activeObjects.length;
    side.querySelectorAll("[data-section], [data-group]").forEach((b) => { if (b.dataset.section) b.disabled = n > 0; });
    const note = document.getElementById("v2-nav-note");
    if (note) note.textContent = n > 0 ? WAIT_TEXT : "";
  }
  api.onPendingWritesChange(syncPending);

  // Общий хранитель фокуса на контейнере раздела: перерисовка области через
  // innerHTML не должна сбрасывать фокус клавиатуры на <body>.
  const focusKeeper = keepFocus(content);

  async function openSection(key, opts = {}) {
    if (navBusy || api.hasPendingWrites()) { if (opts.fromHash) restoreHash(); return; }
    navBusy = true;
    try {
      const target = key === "home" ? null : screenOf(key);
      if (key !== "home" && (!target || !allowedScreen(target))) {
        // Экрана нет или он недоступен роли на этом объекте — на начальную страницу, а не пустое место.
        key = "home";
        content.dataset.note = "unavailable";
      }
      if (key === currentKey && !opts.force) { if (opts.fromHash) restoreHash(); return; }
      if (activeModule && !opts.guarded && !(await activeModule.guardLeave())) { if (opts.fromHash) restoreHash(); return; }
      // guardLeave мог сохранять данные и сам начать/закончить запись; если
      // после него запись всё ещё идёт (например, второй поток), не уходим.
      if (api.hasPendingWrites()) { if (opts.fromHash) restoreHash(); return; }
      // destroy() — необязательный хук раздела (у "Проекты и объекты" живая
      // мини-карта MapLibre со своим graphics-контекстом): content.innerHTML ниже
      // уничтожит её DOM-узел, но не сам контекст — без явного remove() браузер
      // рано или поздно перестанет строить новые карты вовсе.
      activeModule?.destroy?.();
      focusKeeper.reset();
      content.innerHTML = "";
      // Оформление раздела не должно зависеть от порядка посещения: классы,
      // которые раздел мог повесить на общий контейнер, сбрасываются здесь.
      content.className = "v2-page";
      currentKey = key;
      const wanted = key === "home" ? "#/" : `#/${key}`;
      if (location.hash !== wanted && !(key === "home" && (location.hash === "" || location.hash === "#"))) {
        history.pushState(null, "", wanted);
      }
      renderNav();
      if (key === "home") {
        document.title = "ЖБИ — новый интерфейс";
        const hidden = registry.screens.filter((s) => !allowedScreen(s)).length;
        activeModule = mountHome(content, { registry, allowed: allowedScreen, hiddenCount: hidden, go: (k) => openSection(k) });
      } else if (isModule(target)) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = MODULES[target.id](content, moduleCtx);
      } else if (target.impl === "subtypes-edit" && target.subtypes) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSubtypesEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "sessions-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSessionsEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "export-form" && target.export) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountExportForm(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, groupTitle: groupTitle(target.group),
          object: activeObjects.find((o) => o.id === objectId) || null,
        });
      } else if (target.impl === "card-edit" && target.card) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountProjectCardEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "notes-edit" && target.notes) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountReportNotesEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "prefix-edit" && target.prefix) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountPrefixEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "color-edit" && target.color) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountColorEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "setting-edit" && target.setting) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSettingEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "dict-edit" && target.edit) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountDictEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "read" && target.read) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountReadScreen(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, groupTitle: groupTitle(target.group),
        });
      } else {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountScreenView(content, {
          screen: target, structure: registry.structure[target.id], objectId, rights, groupTitle: groupTitle(target.group),
        });
      }
    } finally { navBusy = false; }
  }
  function restoreHash() {
    // Переход отклонён (несохранённое, идёт запись): адрес должен снова показывать открытый экран.
    const wanted = currentKey === "home" || !currentKey ? "#/" : `#/${currentKey}`;
    if (location.hash !== wanted) history.pushState(null, "", wanted);
  }
  const routeFromHash = () => /^#\/([\w-]+)/.exec(location.hash)?.[1] || "home";
  window.addEventListener("hashchange", () => { const k = routeFromHash(); if (k !== currentKey) openSection(k, { fromHash: true }); });
  window.addEventListener("popstate", () => { const k = routeFromHash(); if (k !== currentKey) openSection(k, { fromHash: true }); });

  objectSelect.addEventListener("change", async () => {
    const id = Number(objectSelect.value) || null;
    if (!id || id === objectId) return;
    // Экран может держать несохранённую правку ЭТОГО объекта: перед сменой — тот же сторож, что при уходе с экрана.
    // Отказ («Остаться») возвращает выбор в шапке на прежний объект, чтобы шапка и экран не расходились.
    if (navBusy) { objectSelect.value = String(objectId); return; }
    if (activeModule?.hasUnsavedChanges?.()) {
      navBusy = true;
      let stay = false;
      try { stay = !(await activeModule.guardLeave()); } finally { navBusy = false; }
      if (stay) { objectSelect.value = String(objectId); return; }
    }
    objectId = id;
    writeSession("v2.objectId", String(id));
    rightsOk = await loadRights();
    const note = document.getElementById("v2-nav-note");
    if (note && !rightsOk) note.textContent = "Права объекта не удалось получить — показаны права без объекта";
    renderNav();
    // Экран, недоступный на новом объекте (или перерисовка каркаса с новой ссылкой в V1), обновляется.
    const cur = currentKey === "home" ? null : screenOf(currentKey);
    if (cur && !isModule(cur)) openSection(currentKey, { force: true, guarded: true });
    else if (currentKey === "home") openSection("home", { force: true, guarded: true });
  });

  renderNav();
  openSection(routeFromHash());
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
