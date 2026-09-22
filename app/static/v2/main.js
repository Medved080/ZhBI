// Точка входа V2. Логин-гейт → шапка (объект, возврат в V1) → левая навигация по ВСЕМ разделам сервиса
// (реестр `screens.json`, Docs/v2-interface-coverage.md). Перенесены целиком «Пользователи и доступ», «Проекты и
// объекты» и «Контрагенты»; остальные экраны показывают состав формы V1 и открывают её в текущем интерфейсе
// с контекстом объекта (screen-view.js), пока их операции не подключены.
import { api, ApiError, getImpersonationToken, setImpersonationToken } from "./api.js";
import { showInfoDialog } from "./dialogs.js";
import { renderLogin, renderChangePassword } from "./login.js";
import { mountUsersAccess } from "./users-access.js";
import { mountProjectsObjects } from "./projects-objects.js";
import { mountCounterparties } from "./counterparties.js";
import { keepFocus } from "./focus.js";
import { loadRegistry, screenAllowed } from "./registry.js";
import { mountScreenView, mountHome, linkList } from "./screen-view.js";
import { mountReadScreen } from "./read-screen.js";
import { mountWorkspace } from "./workspace.js";
import { mountSupplierDocs } from "./supplier-docs.js";
import { mountContractsList } from "./contracts-list.js";
import { mountSchedule } from "./schedule.js";
import { mountDictEdit } from "./dict-edit.js";
import { mountSettingEdit } from "./setting-edit.js";
import { mountColorEdit } from "./color-edit.js";
import { mountPrefixEdit } from "./prefix-edit.js";
import { mountProjectCardEdit, mountReportNotesEdit } from "./card-edit.js";
import { mountExportForm } from "./export-form.js";
import { mountExchange, hasExchangeOp } from "./exchange.js";
import { mountSessionsEdit } from "./sessions-edit.js";
import { mountSubtypesEdit } from "./subtypes-edit.js";
import { mountZonesEdit } from "./zones-edit.js";
import { mountVisibilityEdit } from "./visibility-edit.js";
import { mountDbStatusView } from "./db-status-view.js";
import { mountAdminGuideView } from "./admin-guide-view.js";
import { mountFillScopeEdit } from "./fill-scope-edit.js";
import { mountDbTransfer } from "./db-transfer.js";
import { mountAddressClassifier } from "./address-classifier.js";
import { mountAppearanceEdit } from "./appearance-edit.js";
import { mountLabelColorEdit } from "./label-color-edit.js";
import { mountRevitColorsEdit } from "./revit-colors-edit.js";
import { mountAccessView } from "./access-view.js";
import { hasAdminScreen, mountAdminScreen } from "./admin-screens.js";
import { startStatusLog } from "./statuslog.js";
import { mountShapeEdit } from "./shape-edit.js";
import { EXPERIMENTAL_NOTICE, BLOCKED_EVENT, disabledForScreen } from "./write-gate.js";
import { createShellPrefsStore } from "./shell-prefs.js";
import { mountShellNav } from "./shell-nav.js";
import { openObjectPicker } from "./shell-object-picker.js";

const root = document.getElementById("v2-root");

// Стиль предупреждения о нехватке места (см. warnAboutDiskSpace ниже) — отдельным файлом: styles.css общий,
// правит параллельно другой исполнитель («tables»), тем же приёмом, что element-ops.css/shell-nav.css у своих модулей.
(() => {
  if (document.querySelector("link[data-disk-note-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/disk-note.css"; l.setAttribute("data-disk-note-css", "1");
  document.head.appendChild(l);
})();

// Стиль полосы режима «Зайти под пользователем» — тем же приёмом (own файл, не styles.css).
(() => {
  if (document.querySelector("link[data-impersonation-bar-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = "/static/v2/impersonation-bar.css"; l.setAttribute("data-impersonation-bar-css", "1");
  document.head.appendChild(l);
})();

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

// Контекст для перехода обратно в V1: выбранный в шапке объект и (если открыто рабочее место со схемой) само рабочее место.
// V1 разбирает их при запуске (applyStartupDeepLink) и сам проверяет права: недоступное рабочее место он не открывает.
const switchCtx = { objectId: null, ws: null };

function setBackToV1() {
  // Постоянный сброс (не только переход): «Действия ▾» в V1 не должно
  // немедленно вернуть сюда же по cookie-предпочтению.
  const p = new URLSearchParams({ ui: "v1" });
  if (switchCtx.objectId) p.set("object_id", String(switchCtx.objectId));
  if (switchCtx.ws) p.set("ws", switchCtx.ws);
  location.href = "/?" + p;
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
    await renderChangePassword(root, { api, user, onSuccess: (u) => afterLogin(u) });
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
// Экраны области «МФР / учёт по блокам» (рабочие модули с записью через шлюз): impl экрана → монтирование
// (модули грузятся при первом открытии экрана, а не при старте: холодный запуск V2 не тяжелеет)
const MFR_SCREENS = {
  "blocks-edit": () => import("./blocks-screen.js").then((m) => m.mountBlocksScreen),
  "fact-journal-edit": () => import("./fact-journal-screen.js").then((m) => m.mountFactJournalScreen),
  "chess-flat-edit": () => import("./chess-flat-screen.js").then((m) => m.mountChessFlatScreen),
  "block-bulk-edit": () => import("./block-bulk-screen.js").then((m) => m.mountBlockBulkScreen),
};

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
  // Переход из V1 («Новый интерфейс — экспериментальный») несёт текущий объект: `/v2?object_id=N`. Параметр разовый —
  // стирается из адреса; объект берётся только из списка доступных пользователю (как и остальные источники выбора).
  const fromV1 = Number(new URLSearchParams(location.search).get("object_id")) || null;
  if (fromV1) { try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) { /* адрес не критичен */ } }
  const pick = (id) => activeObjects.find((o) => o.id === id);
  let objectId = (pick(fromV1) || pick(remembered) || pick(tree.last_object_id) || activeObjects.find((o) => o.elements > 0) || activeObjects[0] || {}).id ?? null;
  switchCtx.objectId = objectId;
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

  // Настройки оболочки — закреплённые объекты и левая навигация (shell-prefs.js): читаются из уже загруженного
  // /me (user.v2_shell_prefs), лишнего запроса не требуют.
  const prefsStore = createShellPrefsStore({ api, user });

  root.innerHTML = `
    <!-- Полоса режима «Зайти под пользователем» (2026-09-22). Первым элементом и на всю ширину — та же
         причина, что у V1 (app/static/index.html): вкладка обязана выглядеть как чужая, и спутать её со своей
         нельзя. Показывается только когда /me вернул impersonated_by (см. applyImpersonationBar ниже). -->
    <div class="v2-impersonation-bar" id="v2-impersonation-bar" hidden>
      <span id="v2-impersonation-text"></span>
      <button type="button" class="v2-btn" id="v2-impersonation-exit">Вернуться к своей учётной записи</button>
    </div>
    <header class="v2-head">
      <div class="v2-head-title">
        <strong>ЖБИ</strong>
        <span class="v2-head-section" id="v2-head-section"></span>
        <span class="v2-badge">Новый интерфейс — экспериментальный</span>
        <span class="v2-build" id="v2-build" hidden></span>
      </div>
      <div class="v2-head-right">
        <button type="button" class="v2-objbtn" id="v2-object-btn" aria-haspopup="dialog"
                title="Права и переходы в текущем интерфейсе считаются по выбранному объекту"></button>
        <!-- Скрытый совместимый хук (НЕ часть видимого интерфейса, aria-hidden, вне табуляции): пока выбор объекта
             был единственным select#v2-object, несколько браузерных проверок ДРУГИХ областей (обмен, МФР,
             ЖБИ-линии — scripts/v2_tests/exchange/*.mjs, scripts/verify_mfr_lib.mjs, scripts/verify_lines_ui.mjs)
             переключают объект напрямую через него (устанавливают .value и шлют событие change), а не через
             шапку человеком. Задача — заменить select на кнопку с окном выбора; переписывать проверки других,
             отдельно принимаемых областей — не эта задача и рискует конфликтом с параллельной работой над ними
             (BRIEF). Тот же changeObject() и тот же список активных объектов — гонки эти же самые данные
             показывать ДВАЖДЫ по-разному не может. Обнаружить руками: элемент нельзя не заметить в DOM, но
             display:none и отсутствие визуального следа исключают путаницу с настоящим полем выбора. -->
        <select id="v2-object" class="v2-hide" aria-hidden="true" tabindex="-1"></select>
        <span class="v2-nav-note" id="v2-nav-note" role="status" aria-live="polite"></span>
        <span class="v2-user-name">${escapeHtml(user.display_name)}</span>
        <button type="button" class="v2-back" id="v2-logout-btn" title="Завершить свой сеанс и вернуться на экран входа">Выйти</button>
        <button type="button" class="v2-back" id="v2-back-btn" title="">← Текущий интерфейс</button>
      </div>
    </header>
    <div class="v2-exp-banner" id="v2-exp-banner" role="note">
      <span id="v2-exp-text">${escapeHtml(EXPERIMENTAL_NOTICE)}.</span>
      <a href="/?ui=v1" id="v2-banner-back">Вернуться в текущий интерфейс</a>
    </div>
    <div class="v2-gate-note" id="v2-gate-note" role="status" aria-live="polite" hidden></div>
    <div class="v2-disk-note" id="v2-disk-note" role="status" aria-live="polite" hidden>
      <span id="v2-disk-note-text"></span>
      <button type="button" id="v2-disk-note-x" aria-label="Скрыть предупреждение">✕</button>
    </div>
    <div class="v2-body">
      <div id="v2-side"></div>
      <main class="v2-page" id="v2-content"></main>
    </div>
  `;
  // Индикатор версии сборки: метка кода, который сейчас отдаёт сервер (файл пишется при публикации, scripts/stamp_v2_build.py)
  fetch("/static/v2/build.json", { credentials: "same-origin", cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((b) => {
    const el = document.getElementById("v2-build");
    if (!el || !b || !b.commit) return;
    el.textContent = `сборка ${String(b.commit).slice(0, 7)}`;
    el.title = `Сборка нового интерфейса: код ${b.commit}${b.built ? `, опубликовано ${b.built}` : ""}`;
    el.hidden = false;
  }).catch(() => { /* индикатор вторичен */ });
  const backBtn = document.getElementById("v2-back-btn");
  backBtn.addEventListener("click", onBackClick);
  // «Выйти»: как в V1 — POST /logout (сервер гасит сеанс и cookie), затем экран входа. Несохранённое защищает тот же сторож, что и переход.
  const logoutBtn = document.getElementById("v2-logout-btn");
  logoutBtn.addEventListener("click", async () => {
    if (navBusy || api.hasPendingWrites()) return;
    navBusy = true;
    try {
      if (activeModule && !(await activeModule.guardLeave())) return;
      logoutBtn.disabled = true;
      try { await api.post("/logout", {}); } catch (err) { /* сеанс мог уже истечь — выход всё равно выполняется */ }
      activeModule = null;
      location.hash = "";
      location.reload();
    } finally { navBusy = false; }
  });
  document.getElementById("v2-banner-back").addEventListener("click", (e) => { e.preventDefault(); onBackClick(); });
  const gateNote = document.getElementById("v2-gate-note");
  // Предупреждение о нехватке места (перенос п.6 задания, V1: warnAboutDiskSpace) — фоновый запрос ОДИН раз за
  // загрузку оболочки (renderShell вызывается ровно один раз на вход/восстановление сеанса — см. afterLogin),
  // молча гаснет при отказе (не должен мешать входу), спрашивается только у тех, кому виден раздел копий.
  // Дальше держится, пока не закрыли крестиком (или не перезагрузили страницу) — повторного показа на переход
  // между экранами НЕТ (та же причина, что у V1: одна строка состояния, не вытеснять её на каждый клик).
  const diskNote = document.getElementById("v2-disk-note");
  document.getElementById("v2-disk-note-x").addEventListener("click", () => { diskNote.hidden = true; });
  function warnAboutDiskSpace() {
    if (!isSystemAdmin && !["read", "write"].includes(permissions.features?.backups)) return;
    api.get("/admin/disk-space").then((disk) => {
      if (!disk || !disk.message) return;
      document.getElementById("v2-disk-note-text").textContent = disk.message;
      diskNote.classList.toggle("v2-disk-note-critical", disk.level === "critical");
      diskNote.hidden = false;
    }).catch(() => { /* фоновое уведомление — тихий отказ, не должен мешать работе */ });
  }
  warnAboutDiskSpace();

  // Полоса режима «Зайти под пользователем» (2026-09-22): признак приходит С СЕРВЕРА (/me), а не берётся из
  // наличия токена в sessionStorage — та же причина, что у V1 (app/static/app.js: applyImpersonationBar):
  // токен мог протухнуть (режим живёт часы, IMPERSONATION_TTL_HOURS), и тогда вкладка молча стала бы обычной
  // вкладкой администратора; полоса, нарисованная по локальному признаку, врала бы ровно там, где цена вранья
  // максимальна. Кнопка выхода переиспользует существующий маршрут завершения режима: POST /logout с
  // заголовком «от имени» (его подставляет обёртка fetch в api.js) гасит ТОЛЬКО отладочный сеанс, не трогая
  // cookie-сеанс администратора (app/auth.py: logout).
  const impBar = document.getElementById("v2-impersonation-bar");
  function applyImpersonationBar() {
    const active = !!user.impersonated_by;
    impBar.hidden = !active;
    if (!active) {
      if (getImpersonationToken()) {
        setImpersonationToken(null);
        showInfoDialog("Режим «от имени» истёк — вкладка снова работает от вашего имени.");
      }
      return;
    }
    document.getElementById("v2-impersonation-text").textContent =
      `Режим отладки: вы (${user.impersonated_by}) работаете от имени пользователя «${user.display_name}». `
      + "Все изменения записываются в журнал на ваше имя.";
  }
  applyImpersonationBar();
  document.getElementById("v2-impersonation-exit").addEventListener("click", async () => {
    if (navBusy || api.hasPendingWrites()) return;
    navBusy = true;
    try {
      if (activeModule && !(await activeModule.guardLeave())) return;
      try { await api.post("/logout", {}); } catch (err) { /* отладочный сеанс мог уже истечь — выходим всё равно */ }
      setImpersonationToken(null);
      activeModule = null;
      location.hash = "";
      location.reload();
    } finally { navBusy = false; }
  });

  const objectBtn = document.getElementById("v2-object-btn");
  const headSection = document.getElementById("v2-head-section");
  const content = document.getElementById("v2-content");
  const side = document.getElementById("v2-side");

  let currentKey = null;

  // ---- выбор объекта в шапке: кнопка + окно выбора (shell-object-picker.js). Текст кнопки — статус-точка и
  // «Проект · Объект», полное название — в title (длинные названия не должны раздувать шапку).
  function objectLabelParts(id) {
    const o = activeObjects.find((x) => x.id === id);
    if (!o) return null;
    const proj = tree.projects.find((p) => (p.objects || []).some((x) => x.id === o.id));
    return { status: o.status || "active", text: `${proj ? proj.name + " · " : ""}${o.name}` };
  }
  function updateObjectButton() {
    const parts = objectLabelParts(objectId);
    const text = parts ? parts.text : (tree.failed ? "Не удалось загрузить" : (activeObjects.length ? "Объект не выбран" : "Нет объектов"));
    objectBtn.innerHTML = `${parts ? `<span class="v2-status-dot" data-dot="${escapeHtml(parts.status)}" aria-hidden="true"></span>` : ""}<span class="v2-objbtn-text">${escapeHtml(text)}</span>`;
    objectBtn.title = text;
    // Кнопку не блокируем из-за отсутствия АКТИВНЫХ объектов — в окне выбора есть архивные (то же правило
    // видимости, что в V1), их выбор тоже должен быть доступен, если в дереве вообще есть проекты.
    objectBtn.disabled = !tree.projects.length;
  }
  // Скрытый select-хук (см. комментарий в разметке выше) — тот же список и тот же текст опций, что раньше
  // строил объектOptions видимого <select>, чтобы проверки других областей, читающие текст опции
  // ("Название · N"), не начали молча ошибаться.
  const legacySelect = document.getElementById("v2-object");
  function syncLegacySelect() {
    legacySelect.innerHTML = tree.projects.map((p) => {
      const objs = (p.objects || []).filter((o) => (o.status || "active") !== "archived");
      if (!objs.length) return "";
      return `<optgroup label="${escapeHtml(p.name)}">${objs.map((o) =>
        `<option value="${o.id}">${escapeHtml(o.name)}${o.elements ? ` · ${o.elements}` : " · пусто"}</option>`).join("")}</optgroup>`;
    }).join("");
    legacySelect.value = objectId != null ? String(objectId) : "";
    legacySelect.disabled = !activeObjects.length;
  }
  syncLegacySelect();
  updateObjectButton();
  objectBtn.addEventListener("click", () => {
    if (navBusy || api.hasPendingWrites()) return;
    openObjectPicker({ tree, objectId, prefsStore, onSelect: changeObject, triggerEl: objectBtn });
  });
  legacySelect.addEventListener("change", async () => {
    const id = Number(legacySelect.value) || null;
    const ok = await changeObject(id);
    if (!ok) legacySelect.value = objectId != null ? String(objectId) : ""; // отказ («Остаться») — вернуть прежнее значение, как раньше делал видимый select
  });

  // Смена объекта: тот же сторож несохранённых данных, что и у перехода между разделами (тот же activeModule).
  // Возвращает true, если объект сменился (или уже был тем же — picker закрывается и в этом случае), false —
  // отказ «Остаться»: окно выбора остаётся открытым, ничего не потеряно.
  async function changeObject(id) {
    if (!id || id === objectId) return true;
    if (navBusy) return false;
    if (activeModule?.hasUnsavedChanges?.()) {
      navBusy = true;
      let stay = false;
      try { stay = !(await activeModule.guardLeave()); } finally { navBusy = false; }
      if (stay) return false;
    }
    objectId = id;
    switchCtx.objectId = id;
    writeSession("v2.objectId", String(id));
    // «Последний объект — за пользователем», ТЕМ ЖЕ эндпоинтом, что уже использует V1 (не дублируем в
    // v2-shell-prefs). Не блокирует переключение и не роняет его при отказе — это удобство, а не условие перехода.
    api.put("/me/last-object", { object_id: id }).catch((e) => { /* не критично — при следующем входе просто не подхватится */ });
    rightsOk = await loadRights();
    updateObjectButton();
    legacySelect.value = String(id); // список опций не меняется при простой смене объекта — только значение
    const note = document.getElementById("v2-nav-note");
    if (note) note.textContent = rightsOk ? "" : "Права объекта не удалось получить — показаны права без объекта";
    shellNav.render();
    // Экран, недоступный на новом объекте (или перерисовка каркаса с новой ссылкой в V1), обновляется.
    const cur = currentKey === "home" ? null : screenOf(currentKey);
    // Рабочее место со схемой остаётся смонтированным и сам переключает сцену на новый объект (без пересоздания кадра),
    // если экран доступен на новом объекте; иначе — обычный путь (экран недоступен → начальная страница).
    if (cur && cur.impl === "workspace" && allowedScreen(cur) && activeModule?.onObjectChange?.(objectId)) { updateGateNote(cur); return true; }
    // Рабочее место другого типа учёта (ЖБИ ↔ МФР) на новом объекте не применяется — открываем парное, а не начальную страницу.
    if (cur && cur.impl === "workspace" && !allowedScreen(cur)) {
      const twin = registry.screens.find((x) => x.impl === "workspace" && x.id !== cur.id && allowedScreen(x)
        && (cur.ws === "mfr" ? x.ws === "model" : x.ws === "mfr"));
      if (twin) { openSection(twin.id, { force: true, guarded: true }); return true; }
    }
    if (cur && !isModule(cur)) openSection(currentKey, { force: true, guarded: true });
    else if (currentKey === "home") openSection("home", { force: true, guarded: true });
    return true;
  }

  // ---- левая навигация: три состояния (свёрнута/временно открыта/закреплена), поиск, группы — shell-nav.js.
  // onOpen зовёт openSection ниже (объявлена как function-декларация — доступна и до текстового объявления).
  const shellNav = mountShellNav(side, {
    registry, allowedScreen, prefsStore,
    getCurrentKey: () => currentKey,
    onOpen: (key) => openSection(key),
  });
  // Пока идёт любая запись (сохранение, удаление, загрузка файла) переходы
  // между разделами и в V1 недоступны, а причина написана в шапке — не только в
  // подсказке заблокированной кнопки. Снимается и после успеха, и после ошибки:
  // счётчик записей опускается в finally самого запроса.
  const WAIT_TEXT = "Идёт сохранение — переход временно недоступен";
  function syncPending(n) {
    backBtn.disabled = n > 0;
    backBtn.title = n > 0 ? "Дождитесь завершения сохранения" : "";
    objectBtn.disabled = n > 0 || !tree.projects.length;
    legacySelect.disabled = n > 0 || !activeObjects.length;
    shellNav.setBusy(n > 0);
    const note = document.getElementById("v2-nav-note");
    if (note) note.textContent = n > 0 ? WAIT_TEXT : "";
  }
  api.onPendingWritesChange(syncPending);

  // Общий хранитель фокуса на контейнере раздела: перерисовка области через
  // innerHTML не должна сбрасывать фокус клавиатуры на <body>.
  const focusKeeper = keepFocus(content);

  // Возвращает true, когда переход СОСТОЯЛСЯ (включая «уже там были» — key === currentKey без force) — левая
  // навигация (shell-nav.js) читает это, чтобы закрыть временно открытую панель ТОЛЬКО после настоящего перехода,
  // а не после отказа guardLeave/занятости записью (тогда экран и панель остаются как были, п.1/2 задания).
  async function openSection(key, opts = {}) {
    if (navBusy || api.hasPendingWrites()) { if (opts.fromHash) restoreHash(); return false; }
    navBusy = true;
    try {
      const target = key === "home" ? null : screenOf(key);
      if (key !== "home" && (!target || !allowedScreen(target))) {
        // Экрана нет или он недоступен роли на этом объекте — на начальную страницу, а не пустое место.
        key = "home";
        content.dataset.note = "unavailable";
      }
      if (key === currentKey && !opts.force) { if (opts.fromHash) restoreHash(); return true; }
      if (activeModule && !opts.guarded && !(await activeModule.guardLeave())) { if (opts.fromHash) restoreHash(); return false; }
      // guardLeave мог сохранять данные и сам начать/закончить запись; если
      // после него запись всё ещё идёт (например, второй поток), не уходим.
      if (api.hasPendingWrites()) { if (opts.fromHash) restoreHash(); return false; }
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
      root.classList.toggle("v2-ws-mode", !!target && target.impl === "workspace");
      currentKey = key;
      switchCtx.ws = target?.ws && target.impl === "workspace" ? target.ws : null;
      const wanted = key === "home" ? "#/" : `#/${key}`;
      if (location.hash !== wanted && !(key === "home" && (location.hash === "" || location.hash === "#"))) {
        history.pushState(null, "", wanted);
      }
      shellNav.render();
      // «Текущее рабочее место подписано в шапке» (п.2 задания) — видно и когда меню свёрнуто/спрятано.
      // Для рабочих мест (v2-ws-mode) дублировать незачем: своя подпись уже есть в ws-top (workspace.js).
      headSection.textContent = key === "home" ? "" : (target ? target.title : "");
      if (key === "home") {
        document.title = "ЖБИ — новый интерфейс";
        const hidden = registry.screens.filter((s) => !allowedScreen(s)).length;
        activeModule = mountHome(content, { registry, allowed: allowedScreen, hiddenCount: hidden, go: (k) => openSection(k) });
      } else if (isModule(target)) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = MODULES[target.id](content, moduleCtx);
      } else if (hasAdminScreen(target.adminExtra || target.impl)) {
        // Экраны области «администрирование» (admin-screens.js): смена своего пароля, «Мой доступ», служебные разделы.
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountAdminScreen(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, user, rights, perms, groupTitle: groupTitle(target.group),
        }, target.adminExtra || target.impl);
      } else if (target.impl === "appearance-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountAppearanceEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, user, applyTheme: applyThemeFamily, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "revit-colors-edit" && target.revit) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountRevitColorsEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "access-view") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountAccessView(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "shape-edit" && target.shape) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountShapeEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "label-color-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountLabelColorEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, user, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "subtypes-edit" && target.subtypes) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSubtypesEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "zones-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountZonesEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "visibility-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountVisibilityEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "db-status-view") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountDbStatusView(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "admin-guide-view") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountAdminGuideView(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "fill-scope-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountFillScopeEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "db-transfer") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountDbTransfer(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "address-classifier") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountAddressClassifier(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "sessions-edit") {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSessionsEdit(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, user, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "exchange" && hasExchangeOp(target.exchange)) {
        // Импорт/экспорт файлов и связанные операции обмена данными (exchange*.js)
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountExchange(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, user, rights, objects: activeObjects, groupTitle: groupTitle(target.group),
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
      } else if (target.impl === "workspace") {
        // Рабочее место со схемой: сцена V1 в кадре только для чтения + собственные панели V2 (workspace.js).
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountWorkspace(content, {
          screen: target, objectId, api, groupTitle: groupTitle(target.group), ws: target.ws || "model",
        });
      } else if (target.impl === "contracts-list") {
        // Контракты: список и переход к работе с контрактом в карточке контрагента (там же создание и правка)
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountContractsList(content, { screen: target, objectId, api, rights, go: (k) => openSection(k) });
      } else if (target.impl === "supplier-docs") {
        // Документы контрактации (замена поставщика, обмен привязками): права и данные — по выбранному объекту
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSupplierDocs(content, { screen: target, objectId, api, rights, groupTitle: groupTitle(target.group) });
      } else if (target.impl === "schedule") {
        // График СМР: версии, исходные данные расчёта, расчёт с предпросмотром, диаграмма Ганта
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountSchedule(content, { screen: target, objectId, api, rights, groupTitle: groupTitle(target.group) });
      } else if (MFR_SCREENS[target.impl]) {
        document.title = `${target.title} — ЖБИ`;
        const mountMfr = await MFR_SCREENS[target.impl]();
        activeModule = mountMfr(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else if (target.impl === "read" && target.read) {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountReadScreen(content, {
          screen: target, structure: registry.structure[target.id], objectId, api, rights, groupTitle: groupTitle(target.group),
        });
      } else {
        document.title = `${target.title} — ЖБИ`;
        activeModule = mountScreenView(content, {
          screen: target, structure: registry.structure[target.id], objectId, rights, groupTitle: groupTitle(target.group),
        });
      }
      updateGateNote(key === "home" ? null : target);
      return true;
    } finally { navBusy = false; }
  }
  // Пояснение об отключённых операциях экрана (ограниченный выпуск): что именно не работает в экспериментальном
  // интерфейсе и куда идти. Сама защита — в `api.js` (write-gate.js), это только видимый текст.
  function updateGateNote(target, hit) {
    const off = target ? disabledForScreen(target.id) : [];
    if (!off.length && !hit) { gateNote.hidden = true; gateNote.innerHTML = ""; return; }
    const link = target ? linkList(target, registry.structure[target.id], objectId) : "";
    gateNote.innerHTML = (hit ? `<strong>Не выполнено:</strong> ${escapeHtml(hit)} ` : "")
      + (off.length ? `<strong>В этом разделе отключено в экспериментальном интерфейсе:</strong> ${off.map((r) => escapeHtml(r.action)).join("; ")}. Просмотр доступен. ` : "")
      + link;
    gateNote.hidden = false;
  }
  // Отказ шлюза записи (api.js → write-gate.js): показываем причину над содержимым, даже если модуль сам её не вывел.
  window.addEventListener(BLOCKED_EVENT, (e) => updateGateNote(currentKey && currentKey !== "home" ? screenOf(currentKey) : null, e.detail?.message));
  function restoreHash() {
    // Переход отклонён (несохранённое, идёт запись): адрес должен снова показывать открытый экран.
    const wanted = currentKey === "home" || !currentKey ? "#/" : `#/${currentKey}`;
    if (location.hash !== wanted) history.pushState(null, "", wanted);
  }
  const routeFromHash = () => /^#\/([\w-]+)/.exec(location.hash)?.[1] || "home";
  window.addEventListener("hashchange", () => { const k = routeFromHash(); if (k !== currentKey) openSection(k, { fromHash: true }); });
  window.addEventListener("popstate", () => { const k = routeFromHash(); if (k !== currentKey) openSection(k, { fromHash: true }); });

  startStatusLog();   // лента «Сообщения за сеанс» (раздел «Обучение и справка»)
  openSection(routeFromHash());
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
