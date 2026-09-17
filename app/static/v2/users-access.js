// Пилот V2: «Пользователи и доступ» — три вкладки макета
// (users-access-concept.html), но на реальных данных через реальные
// эндпоинты app/users.py, app/roles.py, app/rights_matrix.py. Модуль сам
// не считает права и не хранит копию бизнес-правил — только показывает
// то, что вернул сервер, и шлёт туда же изменения.
//
// Доработка 2026-09-17 (df4da55 → живая проверка): единый диалог
// несохранённого с клавиатурой и фокус-ловушкой, черновик тронут во ВСЕХ
// формах пилота (не только карточка/доступ/роли), раздельные чтения
// users/roles (роль-имена — из /me/permissions, не из /roles), разделение
// ошибки записи и ошибки последующего обновления экрана, единая
// центрированная колонка заголовка/вкладок/содержимого/подвала, поиск
// объекта в «Проверке доступа» вместо плоского списка.

const ROLE_LABELS = { user: "Пользователь", view: "Просмотр", admin: "Администратор" };
const LEVELS = ["none", "read", "write"];
const LEVEL_LABELS = { none: "Нет", read: "Чтение", write: "Изменение" };
const ACCESS_ALL = "all";

function ruPlural(n, один, немного, много) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return один;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return немного;
  return много;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function mountUsersAccess(container, ctx) {
  const { api, user: currentUser, perms, canReadUsers, canReadRoles, roleList } = ctx;
  const canWriteUsers = perms.isSystemAdmin || perms.users === "write";
  const canWriteRoles = perms.isSystemAdmin || perms.roles === "write";
  // Задать пароль — НЕ через раздел "users": сервер проверяет системную
  // роль admin или "себе самому" (app/users.py set_password), это другая
  // ось прав, и приравнивать её к canWriteUsers значило бы либо запереть
  // администратора без гранта "users", либо разрешить лишнее.
  function canSetPassword(u) { return currentUser.role === "admin" || currentUser.id === u.id; }
  // Имена ролей для сводки/редактора доступа и для «Проверки» берутся из
  // /me/permissions (roleList, есть у ЛЮБОГО вошедшего) — не из /roles
  // (требует грант "roles", которого у "users"-администратора может не
  // быть). Так вкладки "Пользователи"/"Проверка доступа" не зависят от
  // "roles" вовсе — ровно то независимое чтение, которого не хватало.
  function roleName(key) { return (roleList || []).find((r) => r.key === key)?.name || key; }

  const state = {
    page: canReadUsers ? "users" : "roles",   // users | edit | roles | check
    users: null,
    roles: null,              // GET /roles (roles+features+sections+level_labels) — только вкладка "Роли"
    tree: null,                // GET /projects-tree → projects[] (с объектами)
    catalog: null,              // /projects (ВСЕ проекты, включая без объектов) + объекты из tree
    accessMatrix: null,         // GET /users/access-matrix — гранты всех разом, для колонки "Доступ"
    query: "",
    selectedUserId: null,
    editTab: "profile",
    cardDraft: null,            // рабочая копия полей карточки (профиль + вход)
    cardDirty: false,
    pendingPassword: null,      // {password, mustChange} — введено, но не отправлено "Задать пароль"
    access: null,               // {system_admin, grants:[...]} рабочая копия для редактора
    accessDirty: false,
    accessView: "summary",      // "summary" | {edit:"all"|"p:<id>"|"o:<pid>:<oid>"}
    accessAllAreas: false,      // "Показать все" (иначе только доступные)
    accessSearch: "",
    rolesUi: { selected: null },
    rolesDraft: new Map(),      // "roleKey|featureKey" -> level, до явного сохранения
    rolesSaving: false,
    rolesBusy: false,           // идёт reorder/rename/delete — блокирует повтор
    check: { userId: null, objectId: null, objectQuery: "", pickerOpen: false },
    status: "",
    retryRefresh: null,         // задать, когда запись прошла, а последующее чтение — нет
  };

  // ---------- данные (общий кэш на время жизни модуля) ----------

  async function ensureUsers(force) {
    if (!state.users || force) state.users = await api.get("/users");
    return state.users;
  }
  async function ensureRoles(force) {
    if (!state.roles || force) state.roles = await api.get("/roles");
    return state.roles;
  }
  async function ensureTree(force) {
    if (!state.tree || force) state.tree = (await api.get("/projects-tree")).projects;
    return state.tree;
  }
  // Каталог для сводки доступа — ВСЕ проекты, включая без единого объекта
  // (/projects-tree такие прячет, см. app/db.py projects_tree): тот же
  // приём, что и в V1 (accessCatalog в app.js), иначе проект с прямым
  // грантом, но без объектов, пропадал бы из сводки.
  async function ensureCatalog() {
    if (state.catalog) return state.catalog;
    const [all, tree] = await Promise.all([api.get("/projects"), ensureTree()]);
    const withObjects = new Map(tree.map((p) => [p.id, p]));
    state.catalog = all.map((p) => ({
      id: p.id, name: p.name,
      objects: (withObjects.get(p.id)?.objects || []).map((o) => ({ id: o.id, name: o.name })),
    }));
    return state.catalog;
  }
  async function ensureAccessMatrix(force) {
    if (!state.accessMatrix || force) state.accessMatrix = await api.get("/users/access-matrix");
    return state.accessMatrix;
  }

  // Запись прошла, но последующее чтение для обновления экрана — нет:
  // это НЕ провал операции, а отдельная, более мягкая проблема ("Запись
  // выполнена, обновление экрана не удалось"). Возвращает true/false, при
  // false — сохраняет саму функцию в state.retryRefresh, чтобы предложить
  // повторить именно ЧТЕНИЕ, а не записывающую операцию заново.
  async function tryRefresh(fn) {
    try { await fn(); state.retryRefresh = null; return true; }
    catch (err) { state.retryRefresh = fn; return false; }
  }

  // ---------- свод доступа — та же арифметика, что в V1 (app.js:
  // accessMapFromGrants/buildAccessSummary/accessRolesText), применённая к
  // тем же данным сервера. Не альтернативный расчёт — перенос текстом. ----------

  function accessMapFromGrants(grants) {
    const map = new Map();
    for (const g of grants || []) {
      const key = g.project_id == null ? ACCESS_ALL
        : g.object_id == null ? `p:${g.project_id}` : `o:${g.project_id}:${g.object_id}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(g.role);
    }
    return map;
  }

  function accessRolesText(roleSet) {
    return [...roleSet].map(roleName).join(", ") || "—";
  }

  function buildAccessSummary(accessMap, catalog) {
    const rolesAt = (key) => accessMap.get(key) || new Set();
    const allRoles = rolesAt(ACCESS_ALL);
    let projectsCount = 0, objectsCount = 0;
    const projects = catalog.map((p) => {
      const projRoles = rolesAt(`p:${p.id}`);
      const objects = p.objects.map((o) => {
        const direct = rolesAt(`o:${p.id}:${o.id}`);
        const effective = new Set([...allRoles, ...projRoles, ...direct]);
        return { id: o.id, name: o.name, direct, effective, accessible: effective.size > 0 };
      });
      const accessibleObjects = objects.filter((o) => o.accessible);
      const hasProjectGrant = projRoles.size > 0;
      const counted = accessibleObjects.length > 0 || hasProjectGrant;
      if (counted) { projectsCount++; objectsCount += accessibleObjects.length; }
      return { id: p.id, name: p.name, projRoles, objects,
                accessibleCount: accessibleObjects.length, totalCount: objects.length,
                hasProjectGrant, counted };
    });
    return { allRoles, projects, projectsCount, objectsCount };
  }

  function accessSummaryLabel(u, summary) {
    if (u.role === "admin") return "Полный доступ";
    if (summary.allRoles.size) return "Все проекты";
    if (summary.projectsCount) {
      return `${summary.projectsCount} ${ruPlural(summary.projectsCount, "проект", "проекта", "проектов")} · `
        + `${summary.objectsCount} ${ruPlural(summary.objectsCount, "объект", "объекта", "объектов")}`;
    }
    return "Нет доступа";
  }

  function objectSourcesLine(allRoles, projRoles, directRoles) {
    const roles = new Set([...allRoles, ...projRoles, ...directRoles]);
    if (!roles.size) return "";
    return [...roles].map((r) => {
      const from = [];
      if (allRoles.has(r)) from.push("от всех проектов");
      if (projRoles.has(r)) from.push("от проекта");
      if (directRoles.has(r)) from.push("напрямую");
      return `${roleName(r)} ${from.join(" и ")}`;
    }).join("; ");
  }

  // ---------- сторож несохранённого — один активный слот: экраны в этом
  // пилоте показываются по одному, второй незафиксированной формы рядом
  // одновременно быть не может (переход в другую всегда идёт через этот
  // же сторож). Используется и для внутренних переходов, и для кнопки
  // "Текущий интерфейс" в шапке (guardLeave), и для beforeunload. ----------

  let currentDirty = null; // {message, save: async()=>void (throws при ошибке), discard: ()=>void}
  function setDirty(info) { currentDirty = info; }
  function clearDirtyState() { currentDirty = null; }
  // Черновик разрешений (state.rolesDraft) переживает переключение ролей и
  // не зависит от currentDirty — но если о нём забыть тут, закрытие вкладки
  // или "Текущий интерфейс" молча стёрли бы несохранённые ячейки.
  function hasUnsavedChanges() { return !!currentDirty || state.rolesDraft.size > 0; }

  // Форма переименования/создания роли отслеживается ОТДЕЛЬНО от
  // currentDirty (issue 2.1, обнаружено при живой проверке): клик по
  // сегменту черновика прав, пока форма открыта, вызывает markRolesDraftDirty
  // → setDirty(), который просто ЗАМЕНЯЕТ currentDirty на черновик и стирает
  // из него сведения о форме. При следующем переключении роли
  // requestLeaveRoleView() видел только неблокирующий черновик и пропускал
  // переход без единого предупреждения — правка в поле переименования
  // терялась молча. roleFormDirty — самостоятельный слот именно для формы,
  // который черновик не может перезаписать.
  let roleFormDirty = null;
  function clearRoleFormDirty() {
    if (currentDirty === roleFormDirty) clearDirtyState();
    roleFormDirty = null;
  }

  // Диалог — один экземпляр разом: повторный вызов, пока первый ещё не
  // закрыт (двойной клик, гонка обработчиков), возвращает ТУ ЖЕ обещание,
  // а не открывает второй поверх первого.
  let openDialogPromise = null;

  function showUnsavedDialog(message) {
    if (openDialogPromise) return openDialogPromise;
    openDialogPromise = new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "v2-dialog-backdrop";
      backdrop.innerHTML = `
        <div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="Несохранённые изменения">
          <p>${escapeHtml(message)}</p>
          <div class="v2-dialog-actions">
            <button type="button" class="v2-btn" data-choice="cancel">Остаться</button>
            <button type="button" class="v2-btn" data-choice="discard">Не сохранять</button>
            <button type="button" class="v2-btn v2-primary" data-choice="save">Сохранить и продолжить</button>
          </div>
        </div>`;
      const dialog = backdrop.querySelector(".v2-dialog");

      function close(choice) {
        document.removeEventListener("keydown", onKeydown, true);
        if (backdrop.isConnected) document.body.removeChild(backdrop);
        openDialogPromise = null;
        if (previouslyFocused && document.contains(previouslyFocused) && previouslyFocused.focus) {
          previouslyFocused.focus();
        }
        resolve(choice);
      }
      function onKeydown(e) {
        if (e.key === "Escape") { e.preventDefault(); close("cancel"); return; }
        if (e.key === "Tab") {
          const items = [...dialog.querySelectorAll("button")];
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      backdrop.addEventListener("click", (e) => {
        const choice = e.target.closest("[data-choice]")?.dataset.choice;
        if (choice) close(choice);
        else if (e.target === backdrop) close("cancel");
      });
      document.addEventListener("keydown", onKeydown, true);
      document.body.appendChild(backdrop);
      // Начальный фокус — на "Остаться": уход из формы отменой действия по
      // умолчанию безопаснее, чем случайное сохранение недописанного ввода
      // клавишей Enter.
      dialog.querySelector('[data-choice="cancel"]').focus();
    });
    return openDialogPromise;
  }

  // Общая логика диалога для ЛЮБОГО {message, save, discard} — вынесена,
  // чтобы requestLeaveRoleView() могла прогнать её для roleFormDirty, не
  // трогая currentDirty (который к этому моменту может уже указывать на
  // черновик разрешений, а не на форму).
  async function resolveDirty(info) {
    const choice = await showUnsavedDialog(info.message);
    if (choice === "cancel") return false;
    if (choice === "discard") { info.discard?.(); return true; }
    try {
      await info.save();
      return true;
    } catch (err) {
      state.status = err?.detail || err?.message || "Не удалось сохранить";
      status.textContent = state.status;
      return false;
    }
  }

  async function requestLeave() {
    if (!currentDirty) return true;
    const ok = await resolveDirty(currentDirty);
    if (ok) clearDirtyState();
    return ok;
  }

  function btn(label, attr = "", primary = false) {
    return `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" ${attr}>${label}</button>`;
  }

  // Один переход разом: клик по вкладке/записи/списку, пока уже идёт
  // проверка "можно ли уйти" (диалог ждёт ответа), не должен запускать
  // ВТОРОЙ, параллельный переход — иначе оба, получив один и тот же
  // ответ "да" от общего диалога, независимо меняют state.page и рисуют
  // свою вкладку, и итог зависит от того, чей render() дорисовался
  // последним (нашлось при проверке двойных кликов).
  let navGuardBusy = false;
  async function withNavGuard(fn) {
    if (navGuardBusy) return;
    // Issue 2.2 (медленная сеть): пока идёт ЛЮБАЯ запись (роли, профиль,
    // доступ — api.js считает их все разом), смена вкладки/записи/роли не
    // должна выполняться — иначе результат операции легко потерять из
    // вида или, для черновика, потерять сами правки (см. правку
    // saveRolesDraftOrThrow ниже — снимок, а не поголовная очистка).
    if (api.hasPendingWrites()) return;
    navGuardBusy = true;
    try { await fn(); } finally { navGuardBusy = false; }
  }

  // ---------- каркас: заголовок раздела, вкладки, тело и подвал — общая
  // центрированная колонка (.v2-container, max-width 1120px), одинаковая
  // во всех четырёх зонах, чтобы левый/правый край совпадали (issue —
  // раньше заголовок/вкладки стояли в 24px от края, содержимое — в ~400px,
  // поскольку выравнивался только .v2-workspace внутри .v2-scroll). ----------

  container.classList.add("v2-app");
  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container"><h2>Пользователи и доступ</h2></div></div>
    <nav class="v2-nav" aria-label="Разделы"><div class="v2-container">
      <button data-page="users" aria-pressed="true" ${canReadUsers ? "" : "hidden"}>Пользователи</button>
      <button data-page="roles" aria-pressed="false" ${canReadRoles ? "" : "hidden"}>Роли</button>
      <button data-page="check" aria-pressed="false" ${canReadUsers ? "" : "hidden"}>Проверка доступа</button>
    </div></nav>
    <div id="ua-body" class="v2-scroll"><div id="ua-inner" class="v2-container"></div></div>
    <footer class="v2-foot"><div class="v2-container">
      <span id="ua-status" class="v2-muted"></span><div class="v2-foot-actions" id="ua-foot-actions"></div>
    </div></footer>
  `;
  const nav = container.querySelector(".v2-nav");
  const body = container.querySelector("#ua-inner");
  const status = container.querySelector("#ua-status");
  const footActions = container.querySelector("#ua-foot-actions");

  async function goto(page) {
    if (page === state.page) return;
    await withNavGuard(async () => {
      if (!(await requestLeave())) return;
      state.page = page;
      state.status = "";
      state.retryRefresh = null;
      await render();
    });
  }

  nav.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (b) goto(b.dataset.page);
  });

  function renderStatusRetry() {
    status.textContent = state.status;
    const old = footActions.parentElement.querySelector("#ua-status-retry");
    if (old) old.remove();
    if (state.retryRefresh) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.id = "ua-status-retry";
      retryBtn.className = "v2-link";
      retryBtn.style.marginLeft = "8px";
      retryBtn.textContent = "Обновить";
      retryBtn.addEventListener("click", async () => {
        const fn = state.retryRefresh;
        const ok = await tryRefresh(fn);
        state.status = ok ? "Обновлено" : state.status;
        await render();
      });
      status.after(retryBtn);
    }
  }

  async function render() {
    // Защита от прямого попадания на недоступную вкладку (например,
    // предыдущее состояние осталось от другого набора прав).
    if (state.page === "users" && !canReadUsers) state.page = canReadRoles ? "roles" : "users";
    if (state.page === "roles" && !canReadRoles) state.page = canReadUsers ? "users" : "roles";
    if (state.page === "check" && !canReadUsers) state.page = canReadRoles ? "roles" : "users";
    nav.querySelectorAll("button[data-page]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.page === (state.page === "edit" ? "users" : state.page))));
    footActions.innerHTML = "";
    renderStatusRetry();
    try {
      if (state.page === "users") await renderUsers();
      else if (state.page === "edit") await renderEdit();
      else if (state.page === "roles") await renderRoles();
      else if (state.page === "check") await renderCheck();
    } catch (err) {
      body.innerHTML = `<p class="v2-note"></p>`;
      body.querySelector("p").textContent = err.detail || err.message || String(err);
    }
  }

  // ---------- Пользователи ----------

  function userRows() {
    const q = state.query.toLowerCase();
    const rows = state.users.filter((u) =>
      !q || `${u.display_name} ${u.domain_login} ${u.department || ""}`.toLowerCase().includes(q));
    if (!rows.length) return `<tr><td colspan="5">Пользователи не найдены</td></tr>`;
    const catalog = state.catalog, matrix = state.accessMatrix;
    return rows.map((u) => {
      let accessCell = "—";
      if (catalog && matrix) {
        const summary = buildAccessSummary(accessMapFromGrants(matrix.grants[String(u.id)]), catalog);
        accessCell = `<button type="button" class="v2-link" data-open-access="${u.id}">${escapeHtml(accessSummaryLabel(u, summary))}</button>`;
      }
      return `
      <tr>
        <td><div class="v2-person">
          <span class="v2-avatar">${escapeHtml(initials(u))}</span>
          <div><button class="v2-link" data-user="${u.id}">${escapeHtml(u.display_name)}</button>
          <small>${escapeHtml([u.position, u.department].filter(Boolean).join(" · ") || "—")}</small></div>
        </div></td>
        <td>${escapeHtml(u.domain_login)}<small>${u.auth_method === "domain" ? "Домен" : (u.has_password ? "Пароль сервиса" : "Пароль не задан")}</small></td>
        <td><span class="v2-tag">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span></td>
        <td>${accessCell}</td>
        <td class="v2-row-action"><button class="v2-link" data-user="${u.id}">Открыть</button></td>
      </tr>`;
    }).join("");
  }

  function initials(u) {
    return `${(u.last_name || "?")[0] || ""}${(u.first_name || "")[0] || ""}`.toUpperCase();
  }

  async function renderUsers() {
    await ensureUsers();
    // Колонка "Доступ" — не обязательна для показа списка: если каталог
    // недоступен (сеть/права), список всё равно открывается, просто без неё.
    try { await Promise.all([ensureCatalog(), ensureAccessMatrix()]); } catch (e) { /* см. accessCell="—" */ }
    body.innerHTML = `
      <div class="v2-bar"><h3>Пользователи <small>${state.users.length} учётных записей</small></h3>
        ${canWriteUsers ? btn("Добавить пользователя", 'data-new', true) : ""}</div>
      <div class="v2-bar"><input class="v2-search" id="ua-search" placeholder="Имя, логин или подразделение" value="${escapeHtml(state.query)}"></div>
      <table class="v2-table"><thead><tr><th>Пользователь</th><th>Учётная запись</th><th>Системная роль</th><th>Доступ</th><th></th></tr></thead>
      <tbody id="ua-rows">${userRows()}</tbody></table>
      <div id="ua-new-user"></div>
    `;
    body.querySelector("#ua-search").addEventListener("input", (e) => {
      state.query = e.target.value;
      body.querySelector("#ua-rows").innerHTML = userRows();
    });
    // Делегирование НА ПОСТОЯННЫЙ контейнер таблицы: поиск заменяет только
    // innerHTML #ua-rows, но обработчик выше него и переживает замену строк
    // — до правки обработчики вешались на сами <tr> и терялись при вводе.
    body.querySelector(".v2-table").addEventListener("click", (e) => {
      const openAccess = e.target.closest("[data-open-access]");
      if (openAccess) { openUser(Number(openAccess.dataset.openAccess), "access"); return; }
      const openUserBtn = e.target.closest("[data-user]");
      if (openUserBtn) openUser(Number(openUserBtn.dataset.user));
    });
    const newBtn = body.querySelector("[data-new]");
    if (newBtn) newBtn.addEventListener("click", async () => {
      if (!(await requestLeave())) return;
      renderNewUserForm();
    });
  }

  function markNewUserDirty(el) {
    setDirty({
      message: "В форме нового пользователя есть введённые данные.",
      save: () => submitNewUser(el),
      discard: () => { el.innerHTML = ""; },
    });
    status.textContent = "Есть несохранённые изменения";
  }

  async function submitNewUser(el) {
    const errorEl = el.querySelector("#nu-error");
    errorEl.textContent = "";
    const last_name = el.querySelector("#nu-last").value.trim();
    const domain_login = el.querySelector("#nu-login").value.trim();
    if (!last_name || !domain_login) {
      errorEl.textContent = "Заполните фамилию и логин";
      throw new Error("Заполните фамилию и логин");
    }
    const created = await api.post("/users", {
      last_name, first_name: el.querySelector("#nu-first").value.trim(),
      domain_login, role: el.querySelector("#nu-role").value,
    });
    // Только что созданного пользователя добавляем в кэш НАПРЯМУЮ (сервер
    // уже вернул его целиком) — не полагаемся на перечитку списка: тогда
    // открыть карточку можно, даже если ensureUsers(true) ниже не удастся.
    state.users = state.users ? [...state.users, created] : [created];
    clearDirtyState();
    await tryRefresh(() => ensureAccessMatrix(true));
    await openUser(created.id);
  }

  function renderNewUserForm() {
    const el = body.querySelector("#ua-new-user");
    el.innerHTML = `
      <div class="v2-result">
        <h4>Новый пользователь</h4>
        <div class="v2-fields">
          <label class="v2-field">Фамилия<input id="nu-last" required></label>
          <label class="v2-field">Имя<input id="nu-first"></label>
          <label class="v2-field">Логин<input id="nu-login" required></label>
          <label class="v2-field">Системная роль
            <select id="nu-role">
              <option value="user" selected>Пользователь</option>
              <option value="view">Просмотр</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
        </div>
        <p class="v2-note">По умолчанию — обычный пользователь, без административных полномочий. Роль «Администратор» назначается явным выбором.</p>
        <div class="v2-auth-error" id="nu-error"></div>
        <div class="v2-inline" style="margin-top:12px">${btn("Создать", 'id="nu-submit"', true)}${btn("Отмена", 'id="nu-cancel"')}</div>
      </div>`;
    el.querySelectorAll("input, select").forEach((f) => {
      f.addEventListener(f.tagName === "SELECT" ? "change" : "input", () => markNewUserDirty(el));
    });
    el.querySelector("#nu-cancel").addEventListener("click", () => {
      // Сама кнопка уже означает "не сохранять" — переспрашивать тем же
      // диалогом было бы вторым подтверждением одного и того же намерения.
      clearDirtyState();
      el.innerHTML = "";
    });
    el.querySelector("#nu-submit").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await submitNewUser(el);
      } catch (err) {
        el.querySelector("#nu-error").textContent = err.detail || err.message || "Не удалось создать пользователя";
      } finally {
        button.disabled = false;
      }
    });
  }

  async function openUser(id, tab) {
    await withNavGuard(async () => {
      if (!(await requestLeave())) return;
      state.selectedUserId = id;
      state.editTab = tab || "profile";
      state.access = null;
      state.accessDirty = false;
      state.accessView = "summary";
      state.pendingPassword = null;
      state.page = "edit";
      initCardDraft();
      await render();
    });
  }

  // ---------- Карточка пользователя ----------

  function currentUserBeingEdited() { return state.users.find((u) => u.id === state.selectedUserId); }

  function initCardDraft() {
    const u = currentUserBeingEdited();
    if (!u) return;
    state.cardDraft = {
      last_name: u.last_name, first_name: u.first_name || "", patronymic: u.patronymic || "",
      position: u.position || "", department: u.department || "", role: u.role,
      domain_login: u.domain_login, auth_method: u.auth_method || "local",
      // Точка исправления регрессии df4da55: сохранение профиля больше не
      // подставляет false вместо действующего значения — черновик стартует
      // с ТЕКУЩИМ значением, и пока его никто не тронул, PATCH шлёт его же.
      must_change_password: !!u.must_change_password,
    };
    state.cardDirty = false;
  }

  function trackCardDirtyState() {
    setDirty({
      message: "В карточке пользователя есть несохранённые изменения.",
      save: saveCardAndPasswordOrThrow,
      discard: () => { initCardDraft(); state.pendingPassword = null; },
    });
  }

  function markCardDirty() {
    const wasTracked = state.cardDirty || !!state.pendingPassword;
    state.cardDirty = true;
    trackCardDirtyState();
    status.textContent = "Есть несохранённые изменения";
    // Кнопки в футере должны появиться с первого же нажатия, а не только
    // на следующей полной перерисовке — иначе "Сохранить" не видно, пока
    // не переключишь вкладку и не вернёшься.
    if (!wasTracked) renderCardFooter();
  }

  // Issue 2.3 (найдено при живой проверке): ввод в поле "Новый пароль" —
  // независимый черновик state.pendingPassword, а НЕ полей карточки. Если
  // отмечать его через markCardDirty(), state.cardDirty остаётся true даже
  // после того, как отдельная кнопка "Задать пароль" уже подтверждённо
  // сохранила пароль — её обработчик снимает слежение только при
  // !state.cardDirty. Итог: успешная установка пароля БЕЗ единой правки
  // полей профиля всё равно давала ложное "есть несохранённые изменения"
  // при попытке уйти со вкладки. markPendingPasswordDirty() делает то же
  // самое (диалог, статус, футер), не трогая cardDirty.
  function markPendingPasswordDirty() {
    const wasTracked = state.cardDirty || !!state.pendingPassword;
    trackCardDirtyState();
    status.textContent = "Есть несохранённые изменения";
    if (!wasTracked) renderCardFooter();
  }

  // Общее сохранение вкладок "Профиль"/"Вход и безопасность": обычная
  // правка полей (PATCH) и/или незавершённый ввод пароля (POST
  // set-password) — ОДНИМ действием диалога "Сохранить и продолжить",
  // чтобы смена должности не могла тихо отменить недописанный временный
  // пароль и наоборот (оба поля живут на одной вкладке одновременно).
  async function saveCardAndPasswordOrThrow() {
    const u = currentUserBeingEdited();
    if (state.cardDirty) {
      // Issue 2.2 — снимок значений на момент отправки: PATCH уходит с
      // ЭТИМИ значениями; если поля правились дальше, пока запрос был в
      // пути (в окне между стартом запроса и дизейблом полей, или если
      // дизейбл почему-то не сработал), сверяем черновик СЕЙЧАС со
      // снимком и снимаем cardDirty, только если ничего не изменилось.
      const snapshot = { ...state.cardDraft };
      const updated = await api.patch(`/users/${u.id}`, {
        last_name: snapshot.last_name.trim(), first_name: snapshot.first_name.trim(),
        patronymic: snapshot.patronymic.trim() || null, position: snapshot.position.trim() || null,
        department: snapshot.department.trim() || null, domain_login: snapshot.domain_login.trim(),
        role: snapshot.role, auth_method: snapshot.auth_method, must_change_password: snapshot.must_change_password,
      });
      Object.assign(u, updated);
      const stillMatchesSnapshot = Object.keys(snapshot).every((k) => snapshot[k] === state.cardDraft[k]);
      if (stillMatchesSnapshot) state.cardDirty = false;
    }
    if (state.pendingPassword) {
      // Та же защита: если поле пароля успели тронуть заново, пока шёл
      // запрос, state.pendingPassword — уже ДРУГОЙ объект (trackPending
      // создаёт новый при каждом input), и по ссылке это видно без
      // глубокого сравнения.
      const sentPassword = state.pendingPassword;
      const updated = await api.post(`/users/${u.id}/set-password`, {
        password: sentPassword.password,
        must_change_password: sentPassword.mustChange,
      });
      // Issue 2.3: ОТВЕТ set-password — источник истины для
      // must_change_password сразу, без ожидания отдельного GET
      // (который дальше — лучший эффорт, не единственный способ узнать
      // актуальное состояние).
      Object.assign(u, updated);
      if (state.pendingPassword === sentPassword) state.pendingPassword = null;
      syncMustChangeFromServer();
      await tryRefresh(() => ensureUsers(true));
    }
    if (!state.cardDirty && !state.pendingPassword) clearDirtyState();
    else trackCardDirtyState(); // новая правка пришла во время записи — сторож остаётся активным
    const ok = await tryRefresh(() => ensureAccessMatrix(true));
    state.status = !ok ? "Изменения сохранены, но не удалось обновить отображение."
      : (state.cardDirty || state.pendingPassword) ? "Сохранено. Есть новые несохранённые изменения."
      : "Сохранено";
  }

  function setCardFieldsDisabled(disabled) {
    body.querySelectorAll("#ua-edit-panel input, #ua-edit-panel select").forEach((el) => { el.disabled = disabled; });
  }

  // Точка исправления: "Задать пароль" решает must_change_password СВОИМ
  // отдельным флагом (может отличаться от того, что стоит в черновике
  // профиля/входа) — после успешной установки пароля черновик подтягивает
  // это ОДНО подтверждённое сервером поле, не трогая остальные
  // несохранённые поля карточки (не откатывает то, что ещё не сохранено).
  function syncMustChangeFromServer() {
    const fresh = currentUserBeingEdited();
    if (fresh && state.cardDraft) state.cardDraft.must_change_password = !!fresh.must_change_password;
  }

  async function renderEdit() {
    await ensureUsers();
    const u = currentUserBeingEdited();
    if (!u) { state.page = "users"; return render(); }
    if (!state.cardDraft) initCardDraft();
    body.innerHTML = `
      <div class="v2-bar"><div><button class="v2-link" data-back>← Все пользователи</button>
        <h3 style="margin-top:8px">${escapeHtml(u.display_name)}</h3></div>
        <span class="v2-tag">${u.auth_method === "domain" ? "Домен" : "Пароль сервиса"}</span></div>
      <div class="v2-cols">
        <aside class="v2-side">
          ${[["profile", "Профиль"], ["access", "Доступ к объектам"], ["security", "Вход и безопасность"]]
            .map(([k, n]) => `<button data-tab="${k}" aria-pressed="${state.editTab === k}">${n}</button>`).join("")}
        </aside>
        <section id="ua-edit-panel"></section>
      </div>`;
    body.querySelector("[data-back]").addEventListener("click", () => goto("users"));
    body.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.tab === state.editTab) return;
      await withNavGuard(async () => {
        if (!(await requestLeave())) return;
        state.editTab = b.dataset.tab;
        await render();
      });
    }));
    const panel = body.querySelector("#ua-edit-panel");
    if (state.editTab === "profile") renderProfile(panel, u);
    else if (state.editTab === "security") renderSecurity(panel, u);
    else await renderAccess(panel, u);
    if ((state.editTab === "profile" || state.editTab === "security") && canWriteUsers) {
      renderCardFooter();
    }
  }

  function renderCardFooter() {
    if (!state.cardDirty && !state.pendingPassword) return;
    footActions.innerHTML = `${btn("Отменить", 'id="card-cancel"')}${btn("Сохранить", 'id="card-save"', true)}`;
    status.textContent = "Есть несохранённые изменения";
    const cancelBtn = footActions.querySelector("#card-cancel");
    const saveBtn = footActions.querySelector("#card-save");
    cancelBtn.addEventListener("click", async () => {
      initCardDraft();
      state.pendingPassword = null;
      clearDirtyState();
      await render();
    });
    saveBtn.addEventListener("click", async () => {
      if (saveBtn.disabled) return; // защита от повторного клика, пока идёт запись
      saveBtn.disabled = true; cancelBtn.disabled = true;
      // Issue 2.2: поля дизейблятся сразу, не дожидаясь перерисовки —
      // иначе правку успевали внести в промежутке между стартом запроса
      // и следующим render().
      setCardFieldsDisabled(true);
      try {
        await saveCardAndPasswordOrThrow();
        await render();
      } catch (err) {
        state.status = err.detail || "Не удалось сохранить";
        status.textContent = state.status;
        saveBtn.disabled = false; cancelBtn.disabled = false;
        setCardFieldsDisabled(false);
      }
    });
  }

  function renderProfile(panel, u) {
    const d = state.cardDraft;
    panel.innerHTML = `
      <h4>Основные сведения</h4>
      <div class="v2-fields">
        <label class="v2-field">Фамилия<input id="pf-last" value="${escapeHtml(d.last_name)}" ${canWriteUsers ? "" : "disabled"}></label>
        <label class="v2-field">Имя<input id="pf-first" value="${escapeHtml(d.first_name)}" ${canWriteUsers ? "" : "disabled"}></label>
        <label class="v2-field">Отчество<input id="pf-patr" value="${escapeHtml(d.patronymic)}" placeholder="Не указано" ${canWriteUsers ? "" : "disabled"}></label>
        <label class="v2-field">Должность<input id="pf-pos" value="${escapeHtml(d.position)}" ${canWriteUsers ? "" : "disabled"}></label>
        <label class="v2-field v2-span">Подразделение<input id="pf-dept" value="${escapeHtml(d.department)}" ${canWriteUsers ? "" : "disabled"}></label>
        <label class="v2-field v2-span">Системная роль
          <select id="pf-role" ${canWriteUsers ? "" : "disabled"}>${Object.entries(ROLE_LABELS)
            .map(([v, l]) => `<option value="${v}" ${d.role === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
      </div>
      <p class="v2-note">Системная роль — только про ведение сервиса. Права на стройках — вкладка «Доступ к объектам».</p>
      <div class="v2-auth-error" id="pf-error"></div>
    `;
    if (!canWriteUsers) return;
    const bind = (id, field) => panel.querySelector(id).addEventListener("input", (e) => {
      d[field] = e.target.value; markCardDirty();
    });
    bind("#pf-last", "last_name"); bind("#pf-first", "first_name"); bind("#pf-patr", "patronymic");
    bind("#pf-pos", "position"); bind("#pf-dept", "department");
    panel.querySelector("#pf-role").addEventListener("change", (e) => { d.role = e.target.value; markCardDirty(); });
  }

  function renderSecurity(panel, u) {
    const d = state.cardDraft;
    const canSetPw = canSetPassword(u);
    panel.innerHTML = `
      <h4>Способ входа</h4>
      <div class="v2-fields">
        <label class="v2-field">Способ входа
          <select id="sec-auth-method" ${canWriteUsers ? "" : "disabled"}>
            <option value="local" ${d.auth_method === "local" ? "selected" : ""}>Пароль сервиса</option>
            <option value="domain" ${d.auth_method === "domain" ? "selected" : ""}>Доменная учётная запись</option>
          </select>
        </label>
        <label class="v2-field">Логин<input id="sec-login" value="${escapeHtml(d.domain_login)}" ${canWriteUsers ? "" : "disabled"}></label>
      </div>
      <label class="v2-role-check" id="sec-must-row" ${d.auth_method === "domain" ? "hidden" : ""}>
        <input type="checkbox" id="sec-must" ${d.must_change_password ? "checked" : ""} ${canWriteUsers ? "" : "disabled"}>
        <span>Требовать смену пароля при следующем входе</span>
      </label>
      <div class="v2-auth-error" id="pf-error"></div>
      ${canSetPw && d.auth_method !== "domain" ? `
        <div class="v2-result">
          <h4>Задать пароль</h4>
          <div class="v2-fields">
            <label class="v2-field">Новый пароль<input id="sec-pass" type="password" value="${escapeHtml(state.pendingPassword?.password || "")}"></label>
          </div>
          <label class="v2-role-check"><input type="checkbox" id="sec-pw-must" ${state.pendingPassword ? (state.pendingPassword.mustChange ? "checked" : "") : "checked"}><span>Потребовать смену при следующем входе</span></label>
          <div class="v2-auth-error" id="sec-error"></div>
          ${btn("Задать пароль", 'id="sec-save"', true)}
        </div>
      ` : ""}
      <div class="v2-result">
        <h4>Диагностика и доступ к аккаунту</h4>
        <p class="v2-muted">Поиск в домене, список сеансов и вход «от имени пользователя» — доступны в текущем интерфейсе, в этот пилот пока не перенесены.</p>
        <a class="v2-link" href="#" data-v1-link>Открыть в текущем интерфейсе →</a>
      </div>
    `;
    panel.querySelector("[data-v1-link]").addEventListener("click", async (e) => {
      e.preventDefault();
      // Та же блокировка, что у кнопки шапки: переход в V1 не должен
      // скрыть результат записи, которая ещё выполняется.
      if (api.hasPendingWrites()) return;
      if (!(await requestLeave())) return;
      location.href = "/?ui=v1";
    });
    if (canWriteUsers) {
      panel.querySelector("#sec-auth-method").addEventListener("change", (e) => {
        d.auth_method = e.target.value;
        markCardDirty();
        renderSecurity(panel, u); // способ входа меняет видимость полей ниже
      });
      panel.querySelector("#sec-login").addEventListener("input", (e) => { d.domain_login = e.target.value; markCardDirty(); });
      const mustEl = panel.querySelector("#sec-must");
      if (mustEl) mustEl.addEventListener("change", (e) => { d.must_change_password = e.target.checked; markCardDirty(); });
    }
    const passEl = panel.querySelector("#sec-pass");
    if (passEl) {
      const trackPending = () => {
        const password = panel.querySelector("#sec-pass").value;
        const mustChange = panel.querySelector("#sec-pw-must").checked;
        state.pendingPassword = password ? { password, mustChange } : null;
        if (state.pendingPassword) markPendingPasswordDirty();
        else if (!state.cardDirty) {
          // Поле очистили руками — снимаем и слежение, и кнопки подвала,
          // иначе "Сохранить"/"Отменить" остаются висеть без дела.
          clearDirtyState();
          footActions.innerHTML = "";
          status.textContent = "";
        }
      };
      passEl.addEventListener("input", trackPending);
      panel.querySelector("#sec-pw-must").addEventListener("change", trackPending);
    }
    const saveBtn = panel.querySelector("#sec-save");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      const errorEl = panel.querySelector("#sec-error");
      errorEl.textContent = "";
      saveBtn.disabled = true;
      const passField = panel.querySelector("#sec-pass");
      const mustField = panel.querySelector("#sec-pw-must");
      // Issue 2.2 — снимок + немедленный дизейбл: то же самое поле
      // остаётся видимым и не должно принять новый ввод, пока это
      // значение ещё в пути на сервер.
      const sentPassword = passField.value, sentMust = mustField.checked;
      passField.disabled = true; mustField.disabled = true;
      try {
        const updated = await api.post(`/users/${u.id}/set-password`, {
          password: sentPassword,
          must_change_password: sentMust,
        });
        // Issue 2.3: ответ set-password сам по себе — актуальные
        // подтверждённые настройки, не только повод дождаться GET.
        Object.assign(u, updated);
        syncMustChangeFromServer();
        // Очищаем состояние, только если поле не поменяли, пока запрос
        // был в пути (сверка со снимком, а не слепой clear()).
        if (passField.value === sentPassword && mustField.checked === sentMust) {
          state.pendingPassword = null;
          if (!state.cardDirty) { clearDirtyState(); footActions.innerHTML = ""; }
        }
        state.status = "Пароль обновлён";
        await tryRefresh(() => ensureUsers(true));
        renderStatusRetry();
        // Перерисовать панель: "Требовать смену пароля" в блоке "Способ
        // входа" — ДРУГОЙ чекбокс, чем тот, что был только что отправлен
        // здесь, и обязан отразить подтверждённое сервером значение, а не
        // то, что было в черновике до этого действия.
        renderSecurity(panel, u);
      } catch (err) {
        errorEl.textContent = err.detail || "Не удалось задать пароль";
        passField.disabled = false; mustField.disabled = false;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ---------- Доступ к объектам: сводка (без перебора объектов) + точечное редактирование ----------

  function grantsAt(key) {
    if (key === ACCESS_ALL) return state.access.grants.filter((g) => g.project_id == null && g.object_id == null);
    if (key.startsWith("p:")) {
      const pid = Number(key.slice(2));
      return state.access.grants.filter((g) => g.project_id === pid && g.object_id == null);
    }
    const [, pid, oid] = key.split(":").map((x, i) => (i === 0 ? x : Number(x)));
    return state.access.grants.filter((g) => g.object_id === oid);
  }

  function inheritedRolesAt(key) {
    if (key === ACCESS_ALL) return [];
    const all = [...grantsAt(ACCESS_ALL)].map((g) => g.role);
    if (key.startsWith("p:")) return all;
    const pid = Number(key.split(":")[1]);
    return [...all, ...grantsAt(`p:${pid}`).map((g) => g.role)];
  }

  function areaLabel(key, catalog) {
    if (key === ACCESS_ALL) return "Все проекты";
    if (key.startsWith("p:")) return catalog.find((p) => p.id === Number(key.slice(2)))?.name || key;
    const [, pid, oid] = key.split(":").map((x, i) => (i === 0 ? x : Number(x)));
    const p = catalog.find((x) => x.id === pid);
    return `${p?.name || pid} / ${p?.objects.find((o) => o.id === oid)?.name || oid}`;
  }

  async function loadAccessFor(u) {
    if (!state.access || state.access._userId !== u.id) {
      const data = await api.get(`/users/${u.id}/access`);
      state.access = {
        system_admin: data.system_admin,
        grants: data.grants.map((g) => ({ project_id: g.project_id, object_id: g.object_id, role: g.role })),
        _userId: u.id,
      };
      state.accessDirty = false;
      state.accessView = "summary";
    }
  }

  function markAccessDirty() {
    state.accessDirty = true;
    setDirty({
      message: "В назначениях доступа есть несохранённые изменения.",
      save: saveAccessOrThrow,
      discard: () => { state.access = null; },
    });
  }

  async function saveAccessOrThrow() {
    const u = currentUserBeingEdited();
    // Issue 2.2 — снимок отправленных грантов: сверяем его с
    // state.access.grants ПОСЛЕ ответа сервера и обнуляем рабочую копию,
    // только если ничего не изменилось за время запроса (чекбоксы и так
    // дизейблены на это время — см. вызывающий код, — но сверка остаётся
    // подстраховкой, а не единственной защитой).
    const snapshot = JSON.stringify(state.access.grants);
    await api.put(`/users/${u.id}/access`, { grants: state.access.grants });
    if (JSON.stringify(state.access.grants) === snapshot) {
      state.accessDirty = false;
      state.access = null;
      clearDirtyState();
    } else {
      markAccessDirty();
    }
    const ok = await tryRefresh(() => ensureAccessMatrix(true));
    state.status = !ok ? "Доступ сохранён, но не удалось обновить отображение."
      : state.access ? "Сохранено. Есть новые несохранённые изменения."
      : "Доступ сохранён";
  }

  async function renderAccess(panel, u) {
    // Каталог — не роли: список ролей для чекбоксов берётся из
    // /me/permissions (roleName/roleList), доступного независимо от
    // гранта "roles" (см. комментарий у roleName выше).
    await ensureCatalog();
    await loadAccessFor(u);
    if (state.access.system_admin) {
      panel.innerHTML = `<h4>Полный доступ ко всему сервису</h4>
        <p class="v2-note">Администратор сервиса имеет доступ ко всем текущим и будущим проектам и объектам. Назначения ролей его не ограничивают.</p>`;
      return;
    }
    const catalog = state.catalog;
    if (state.accessView === "summary") renderAccessSummary(panel, catalog);
    else renderAccessAreaEditor(panel, catalog, state.accessView.edit);
    if (canWriteUsers) {
      footActions.innerHTML = `${btn("Отменить", 'id="ua-access-cancel"')}${btn("Сохранить изменения", 'id="ua-access-save"', true)}`;
      footActions.querySelector("#ua-access-save").disabled = !state.accessDirty;
      footActions.querySelector("#ua-access-cancel").disabled = !state.accessDirty;
      if (state.accessDirty) status.textContent = "Есть несохранённые изменения";
      const accessSaveBtn = footActions.querySelector("#ua-access-save");
      const accessCancelBtn = footActions.querySelector("#ua-access-cancel");
      accessSaveBtn.addEventListener("click", async () => {
        if (accessSaveBtn.disabled) return;
        accessSaveBtn.disabled = true; accessCancelBtn.disabled = true;
        // Issue 2.2: чекбоксы дизейблятся сразу, не дожидаясь перерисовки.
        panel.querySelectorAll("[data-grant-role]").forEach((cb) => { cb.disabled = true; });
        try {
          await saveAccessOrThrow();
          await render();
        } catch (err) {
          state.status = err.detail || "Не удалось сохранить доступ";
          status.textContent = state.status;
          accessSaveBtn.disabled = false; accessCancelBtn.disabled = false;
          panel.querySelectorAll("[data-grant-role]").forEach((cb) => { cb.disabled = !canWriteUsers; });
        }
      });
      accessCancelBtn.addEventListener("click", async () => {
        if (accessCancelBtn.disabled) return;
        state.access = null; state.accessDirty = false; clearDirtyState(); await render();
      });
    }
  }

  function renderAccessSummary(panel, catalog) {
    const summary = buildAccessSummary(accessMapFromGrants(state.access.grants), catalog);
    const q = state.accessSearch.trim().toLowerCase();
    let html = `<div class="v2-bar">
      <input class="v2-search" id="ua-access-search" placeholder="Поиск проекта или объекта" value="${escapeHtml(state.accessSearch)}">
      ${btn(state.accessAllAreas ? "Только доступные" : "Показать все", 'id="ua-access-all-areas"')}
    </div>`;
    if (summary.allRoles.size) {
      html += `<div class="v2-note"><strong>Все текущие и будущие проекты</strong><br>`
        + `${accessRolesText(summary.allRoles)} · назначено на «Все проекты» `
        + `<button type="button" class="v2-link" data-edit-area="${ACCESS_ALL}" ${canWriteUsers ? "" : "disabled"}>Изменить</button></div>`;
    } else if (state.accessAllAreas) {
      html += `<p><button type="button" class="v2-link" data-edit-area="${ACCESS_ALL}" ${canWriteUsers ? "" : "disabled"}>Назначить роли на все проекты</button></p>`;
    }
    let shown = 0;
    for (const p of summary.projects) {
      if (!state.accessAllAreas && !p.counted) continue;
      const projectMatches = !q || p.name.toLowerCase().includes(q);
      const matchingObjects = p.objects.filter((o) => !q || o.name.toLowerCase().includes(q));
      if (q && !projectMatches && !matchingObjects.length) continue;
      const objectsToShow = q ? (projectMatches ? p.objects : matchingObjects)
        : (state.accessAllAreas ? p.objects : p.objects.filter((o) => o.accessible));
      if (!state.accessAllAreas && !objectsToShow.length && !p.hasProjectGrant) continue;
      shown++;
      html += `<section class="v2-result"><div class="v2-bar">
        <div><h4>${escapeHtml(p.name)} <span class="v2-tag">${p.accessibleCount} из ${p.totalCount} объектов</span></h4>
        ${p.hasProjectGrant ? `<small>На проекте: ${accessRolesText(p.projRoles)}. Доступны будущие объекты.</small>` : ""}</div>
        <button type="button" class="v2-link" data-edit-area="p:${p.id}" ${canWriteUsers ? "" : "disabled"}>${p.hasProjectGrant ? "Изменить роли проекта" : "Назначить на проект"}</button>
      </div>`;
      if (!objectsToShow.length) html += `<p class="v2-note">Объектов пока нет; доступ распространится на будущие.</p>`;
      for (const o of objectsToShow) {
        const sources = objectSourcesLine(summary.allRoles, p.projRoles, o.direct);
        html += `<div class="v2-perm"><div><strong>${escapeHtml(o.name)}</strong>${sources ? `<small>${escapeHtml(sources)}</small>` : ""}</div>
          <div class="v2-inline"><span class="v2-tag">${o.accessible ? escapeHtml(accessRolesText(o.effective)) : "Нет доступа"}</span>
          <button type="button" class="v2-link" data-edit-area="o:${p.id}:${o.id}" ${canWriteUsers ? "" : "disabled"}>${o.accessible ? "Изменить" : "Выдать"}</button></div></div>`;
      }
      html += `</section>`;
    }
    if (!shown && !summary.allRoles.size) {
      html += `<p class="v2-note">Нет доступа к проектам. Нажмите «Показать все», чтобы назначить роли.</p>`;
    }
    panel.innerHTML = html;
    const search = panel.querySelector("#ua-access-search");
    search.addEventListener("input", (e) => { state.accessSearch = e.target.value; renderAccessSummary(panel, catalog); });
    panel.querySelector("#ua-access-all-areas").addEventListener("click", () => {
      state.accessAllAreas = !state.accessAllAreas; renderAccessSummary(panel, catalog);
    });
    if (canWriteUsers) {
      panel.querySelectorAll("[data-edit-area]").forEach((b) => b.addEventListener("click", () => {
        state.accessView = { edit: b.dataset.editArea };
        renderAccessAreaEditor(panel, catalog, b.dataset.editArea);
      }));
    }
  }

  function renderAccessAreaEditor(panel, catalog, key) {
    const direct = grantsAt(key).map((g) => g.role);
    const inherited = inheritedRolesAt(key);
    const futureNote = key === ACCESS_ALL ? "Назначение распространяется на все текущие и будущие проекты."
      : key.startsWith("p:") ? "Назначение распространяется на текущие и будущие объекты этого проекта." : "";
    panel.innerHTML = `
      <button type="button" class="v2-link" data-back-summary>← Сводка доступа</button>
      <h4>${escapeHtml(areaLabel(key, catalog))}</h4>
      <small>Прямые назначения на этом уровне</small>
      ${(roleList || []).map((r) => `
        <label class="v2-role-check"><input type="checkbox" data-grant-role="${r.key}" ${direct.includes(r.key) ? "checked" : ""} ${canWriteUsers ? "" : "disabled"}><span>${escapeHtml(r.name)}</span></label>
      `).join("")}
      ${inherited.length ? `<p class="v2-note">Действует независимо от отмеченного выше (унаследовано): ${escapeHtml(accessRolesText(new Set(inherited)))}. Роли складываются — снять их можно только там, где они выданы.</p>` : ""}
      ${futureNote ? `<p class="v2-note">${futureNote}</p>` : ""}
    `;
    panel.querySelector("[data-back-summary]").addEventListener("click", () => {
      state.accessView = "summary";
      renderAccessSummary(panel, catalog);
    });
    panel.querySelectorAll("[data-grant-role]").forEach((cb) => cb.addEventListener("change", () => {
      const role = cb.dataset.grantRole;
      let project_id = null, object_id = null;
      if (key.startsWith("p:")) project_id = Number(key.slice(2));
      else if (key.startsWith("o:")) { const [, pid, oid] = key.split(":"); project_id = Number(pid); object_id = Number(oid); }
      const idx = state.access.grants.findIndex((g) => g.project_id === project_id && g.object_id === object_id && g.role === role);
      if (cb.checked && idx === -1) state.access.grants.push({ project_id, object_id, role });
      else if (!cb.checked && idx !== -1) state.access.grants.splice(idx, 1);
      markAccessDirty();
      status.textContent = "Есть несохранённые изменения";
      footActions.querySelector("#ua-access-save")?.removeAttribute("disabled");
      footActions.querySelector("#ua-access-cancel")?.removeAttribute("disabled");
      renderAccessAreaEditor(panel, catalog, key);
    }));
  }

  // ---------- Роли: черновик разрешений (как в V1), явное сохранение ----------

  function rolesCellKey(roleKey, featureKey) { return `${roleKey}|${featureKey}`; }
  function rolesLevel(roleKey, featureKey) {
    if (state.rolesDraft.has(rolesCellKey(roleKey, featureKey))) return state.rolesDraft.get(rolesCellKey(roleKey, featureKey));
    return state.roles.features.find((f) => f.key === featureKey)?.levels[roleKey] || "none";
  }

  function markRolesDraftDirty() {
    setDirty({
      message: `В матрице разрешений не сохранено ячеек: ${state.rolesDraft.size}.`,
      save: saveRolesDraftOrThrow,
      discard: () => { state.rolesDraft.clear(); },
      // Черновик — состояние МОДУЛЯ (Map), а не разметки конкретной роли:
      // выбор другой роли, создание/переименование/удаление и порядок его
      // не стирают и не показывают частично — незачем спрашивать при
      // переключении. Спрашивать нужно только там, где данные ДЕЙСТВИТЕЛЬНО
      // исчезнут — форма переименования/создания привязана к разметке,
      // которую эти переходы перерисовывают.
      blocksRoleSwitch: false,
    });
  }

  // Тот же сторож, что requestLeave(), но не мешает переключению ролей и
  // соседним действиям на вкладке "Роли", если единственное несохранённое
  // — общий черновик разрешений (issue 2.1: форма переименования исчезала
  // без предупреждения при выборе другой роли, а на СЛЕДУЮЩЕЙ вкладке
  // всплывало предупреждение об уже не существующей форме). Форму проверяем
  // через roleFormDirty, а НЕ currentDirty: клик по сегменту черновика, пока
  // форма открыта, замещает currentDirty черновиком — сама форма при этом
  // остаётся дирти и без roleFormDirty потерялась бы без предупреждения.
  async function requestLeaveRoleView() {
    if (roleFormDirty) {
      const info = roleFormDirty;
      const ok = await resolveDirty(info);
      if (ok) clearRoleFormDirty();
      return ok;
    }
    if (currentDirty && currentDirty.blocksRoleSwitch === false) return true;
    return requestLeave();
  }

  async function saveRolesDraftOrThrow() {
    if (!state.rolesDraft.size) return;
    // Issue 2.2 — снимок на момент отправки, а не постоянная ссылка на
    // state.rolesDraft: сегменты дизейблятся сразу (см. вызывающий код),
    // но если правка всё же прошла (например, с клавиатуры), снимаем из
    // черновика только то, что реально отправили и С ТЕМ ЖЕ значением —
    // более новая правка той же ячейки останется явно несохранённой, а не
    // потеряется молча под общим clear().
    const snapshot = new Map(state.rolesDraft);
    const items = [...snapshot].map(([key, level]) => {
      const [role_key, feature_key] = key.split("|");
      return { role_key, feature_key, level };
    });
    await api.put("/roles/features", { items });
    for (const [key, level] of snapshot) {
      if (state.rolesDraft.get(key) === level) state.rolesDraft.delete(key);
    }
    if (state.rolesDraft.size) {
      // Новые правки появились, пока запрос был в пути — черновик и
      // сторож остаются активными на них.
      markRolesDraftDirty();
    } else {
      clearDirtyState();
    }
    const ok = await tryRefresh(() => ensureRoles(true));
    state.status = !ok ? "Разрешения сохранены, но не удалось обновить отображение."
      : state.rolesDraft.size ? `Сохранено. Есть новые несохранённые ячейки: ${state.rolesDraft.size}.`
      : "Разрешения сохранены";
  }

  function setRolesSegmentsDisabled(disabled) {
    body.querySelectorAll("[data-perm]").forEach((b) => { b.disabled = disabled || !canWriteRoles; });
  }

  async function renderRoles() {
    await ensureRoles();
    const ui = state.rolesUi;
    if ((ui.selected === null || !state.roles.roles.some((r) => r.key === ui.selected)) && state.roles.roles.length) {
      ui.selected = state.roles.roles[0].key;
    }
    const role = state.roles.roles.find((r) => r.key === ui.selected);
    body.innerHTML = `
      <div class="v2-bar"><div><h3>Роли на объектах</h3><small>Независимые наборы разрешений — складываются, не заменяют друг друга</small></div>
        ${canWriteRoles ? btn("Создать роль", 'id="role-new"', false) : ""}</div>
      <div id="role-new-form"></div>
      ${state.roles.roles.length ? `<div class="v2-cols">
        <aside class="v2-side">
          ${state.roles.roles.map((r, i) => `
            <div class="v2-role-row">
              ${canWriteRoles ? `<span class="v2-reorder">
                <button type="button" data-role-up="${r.key}" ${i === 0 || state.rolesBusy ? "disabled" : ""} aria-label="Выше">▲</button>
                <button type="button" data-role-down="${r.key}" ${i === state.roles.roles.length - 1 || state.rolesBusy ? "disabled" : ""} aria-label="Ниже">▼</button>
              </span>` : ""}
              <button data-role="${r.key}" aria-pressed="${r.key === ui.selected}">${escapeHtml(r.name)}<small>${r.granted} назначений</small></button>
            </div>`).join("")}
        </aside>
        <section id="role-editor"></section>
      </div>` : `<p class="v2-note">Ролей пока нет — создайте первую кнопкой выше.</p>`}
    `;
    if (canWriteRoles) body.querySelector("#role-new").addEventListener("click", () => withNavGuard(async () => {
      if (!(await requestLeaveRoleView())) return;
      renderRoleCreateForm();
    }));
    body.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", () => withNavGuard(async () => {
      if (b.dataset.role === ui.selected) return;
      if (!(await requestLeaveRoleView())) return;
      ui.selected = b.dataset.role;
      renderRoles();
    })));
    body.querySelectorAll("[data-role-up],[data-role-down]").forEach((b) => b.addEventListener("click", () => withNavGuard(async () => {
      if (!(await requestLeaveRoleView())) return;
      const key = b.dataset.roleUp || b.dataset.roleDown;
      await reorderRole(key, !!b.dataset.roleUp);
    })));
    if (role) renderRoleEditor(body.querySelector("#role-editor"), role);
    // Issue 2.1: renderRoles() вызывается напрямую (не через render()), сама
    // статус-строку не сбрасывает — без else тут текст "Есть несохранённые
    // изменения" от отказанной (discard) формы переименования/создания
    // остался бы висеть после перехода на другую роль.
    if (state.rolesDraft.size) renderRolesFooter(); else { footActions.innerHTML = ""; status.textContent = ""; }
  }

  function renderRolesFooter() {
    footActions.innerHTML = `${btn("Отменить изменения", 'id="roles-cancel"')}${btn("Сохранить изменения", 'id="roles-save"', true)}`;
    status.textContent = `Не сохранено ячеек: ${state.rolesDraft.size}`;
    const saveBtn = footActions.querySelector("#roles-save");
    const cancelBtn = footActions.querySelector("#roles-cancel");
    saveBtn.disabled = state.rolesSaving;
    cancelBtn.disabled = state.rolesSaving;
    saveBtn.addEventListener("click", async () => {
      // Защита от повторной отправки — двойной клик не шлёт второй PUT,
      // пока первый не завершился.
      if (state.rolesSaving) return;
      state.rolesSaving = true;
      saveBtn.disabled = true; cancelBtn.disabled = true;
      // Issue 2.2: сегменты дизейблятся СРАЗУ, в уже отрисованном DOM, а
      // не только на следующей перерисовке — иначе клик по сегменту в
      // окне между стартом запроса и render() всё ещё регистрируется.
      setRolesSegmentsDisabled(true);
      try {
        await saveRolesDraftOrThrow();
        // Флаг снимаем ДО перерисовки: render() строит сегменты с
        // disabled="!canWriteRoles || rolesSaving" — переставленный ПОСЛЕ
        // render() флаг оставлял их задизейбленными до следующего
        // случайного перерендера (issue из код-ревью).
        state.rolesSaving = false;
        await render();
      } catch (err) {
        // Черновик остаётся — ошибка не должна выглядеть как потеря правок.
        state.status = err.detail || "Не удалось сохранить разрешения";
        state.rolesSaving = false;
        status.textContent = state.status;
        saveBtn.disabled = false; cancelBtn.disabled = false;
        setRolesSegmentsDisabled(false);
      }
    });
    cancelBtn.addEventListener("click", async () => {
      state.rolesDraft.clear();
      clearDirtyState();
      await render();
    });
  }

  function markRoleFormDirty(el, formMessage, submitFn) {
    const info = {
      message: formMessage,
      save: () => submitFn(),
      discard: () => { el.innerHTML = ""; },
    };
    roleFormDirty = info;
    setDirty(info);
    status.textContent = "Есть несохранённые изменения";
  }

  function renderRoleCreateForm() {
    const el = body.querySelector("#role-new-form");
    async function submit() {
      const name = el.querySelector("#role-new-name").value.trim();
      const errorEl = el.querySelector("#role-new-error");
      errorEl.textContent = "";
      if (!name) { errorEl.textContent = "Введите название"; throw new Error("Введите название"); }
      const created = await api.post("/roles", { name });
      clearRoleFormDirty();
      await tryRefresh(() => ensureRoles(true));
      state.rolesUi.selected = created.key;
      el.innerHTML = "";
      await render();
    }
    el.innerHTML = `<div class="v2-inline" style="margin-bottom:14px">
      <input id="role-new-name" placeholder="Название роли">
      ${btn("Создать", 'id="role-new-submit"', true)}${btn("Отмена", 'id="role-new-cancel"')}
      <span class="v2-auth-error" id="role-new-error"></span></div>`;
    el.querySelector("#role-new-name").addEventListener("input", () =>
      markRoleFormDirty(el, "В форме новой роли есть введённые данные.", submit));
    el.querySelector("#role-new-cancel").addEventListener("click", () => {
      clearRoleFormDirty();
      el.innerHTML = "";
    });
    el.querySelector("#role-new-submit").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await submit(); } catch (err) {
        el.querySelector("#role-new-error").textContent = err.detail || err.message || "Не удалось создать роль";
      } finally { button.disabled = false; }
    });
  }

  async function reorderRole(key, up) {
    if (state.rolesBusy) return;
    const order = state.roles.roles.map((r) => r.key);
    const i = order.indexOf(key);
    const j = up ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    state.rolesBusy = true;
    try {
      await api.put("/roles/order", { keys: order });
      // Порядок не меняет состав ролей/разделов, но черновик мог ссылаться
      // на роль, чья карточка сейчас перерисуется — сбрасываем на всякий
      // случай тем же приёмом, что и после переименования/удаления в V1.
      const ok = await tryRefresh(() => ensureRoles(true));
      state.status = ok ? "" : "Порядок сохранён, но не удалось обновить отображение.";
    } catch (err) {
      state.status = err.detail || "Не удалось изменить порядок";
    }
    // Флаг снимаем ДО render(): иначе кнопки ▲▼ рисуются disabled и
    // остаются такими до следующего перерендера (та же ошибка, что и у
    // rolesSaving выше).
    state.rolesBusy = false;
    await render();
  }

  function renderRoleEditor(el, role) {
    const sections = new Map();
    for (const f of state.roles.features) {
      if (f.fixed) continue; // "своё" роли не подчиняется — как и в правке ячеек на сервере
      if (!sections.has(f.section)) sections.set(f.section, []);
      sections.get(f.section).push(f);
    }
    el.innerHTML = `
      <div class="v2-bar"><h3>${escapeHtml(role.name)}</h3>
        ${canWriteRoles ? `<div class="v2-inline">${btn("Переименовать", 'id="role-rename"', false)}${btn("Удалить", 'id="role-delete"', false)}</div>` : ""}</div>
      <div id="role-rename-form"></div>
      <small>Нет — разрешение не добавляется этой ролью. Другие роли могут давать доступ.</small>
      ${[...sections.entries()].map(([section, feats]) => `
        <div class="v2-group">${escapeHtml(section)}</div>
        ${feats.map((f) => {
          const level = rolesLevel(role.key, f.key);
          const dirty = state.rolesDraft.has(rolesCellKey(role.key, f.key));
          return `
          <div class="v2-perm${dirty ? " v2-perm-dirty" : ""}">
            <div>${escapeHtml(f.title)}<small>${escapeHtml(f.scope_label || "")}</small></div>
            <div class="v2-seg" aria-label="${escapeHtml(f.title)}">
              ${LEVELS.map((lv) => `<button data-perm="${f.key}" data-level="${lv}" aria-pressed="${level === lv}" ${canWriteRoles && !state.rolesSaving ? "" : "disabled"}>${LEVEL_LABELS[lv]}</button>`).join("")}
            </div>
          </div>`;
        }).join("")}
      `).join("")}
      <p class="v2-note">Изменения роли затронут всех, кому она назначена (сейчас — ${role.granted}).</p>
    `;
    if (canWriteRoles) {
      el.querySelector("#role-delete").addEventListener("click", () => withNavGuard(async () => {
        if (!(await requestLeaveRoleView())) return;
        deleteRole(role);
      }));
      el.querySelector("#role-rename").addEventListener("click", () => withNavGuard(async () => {
        if (!(await requestLeaveRoleView())) return;
        renderRoleRenameForm(el, role);
      }));
      el.querySelectorAll("[data-perm]").forEach((b) => b.addEventListener("click", () => {
        const featureKey = b.dataset.perm, level = b.dataset.level;
        const key = rolesCellKey(role.key, featureKey);
        const original = state.roles.features.find((f) => f.key === featureKey)?.levels[role.key] || "none";
        // Вернули как было — правка снимается, а не остаётся "изменением в
        // ноль": счётчик несохранённого должен показывать реальную разницу.
        if (level === original) state.rolesDraft.delete(key);
        else state.rolesDraft.set(key, level);
        if (state.rolesDraft.size) markRolesDraftDirty(); else clearDirtyState();
        // Точечное обновление ряда, а НЕ renderRoleEditor(el, role) целиком
        // (issue 2.1): полная перерисовка стирала бы открытую тут же форму
        // переименования той же роли, а currentDirty оставался бы указывать
        // на уже не существующую разметку — предупреждение всплывало бы
        // только на СЛЕДУЮЩЕМ переходе, про форму, которой уже нет.
        const row = b.closest(".v2-perm");
        row.classList.toggle("v2-perm-dirty", state.rolesDraft.has(key));
        row.querySelectorAll("[data-perm]").forEach((seg) =>
          seg.setAttribute("aria-pressed", String(seg.dataset.level === level)));
        if (state.rolesDraft.size) renderRolesFooter(); else { footActions.innerHTML = ""; status.textContent = ""; }
      }));
    }
  }

  function renderRoleRenameForm(el, role) {
    const host = el.querySelector("#role-rename-form");
    async function submit() {
      const name = host.querySelector("#role-rename-name").value.trim();
      const errorEl = host.querySelector("#role-rename-error");
      errorEl.textContent = "";
      if (!name) { errorEl.textContent = "Введите название"; throw new Error("Введите название"); }
      await api.patch(`/roles/${role.key}`, { name });
      clearRoleFormDirty();
      await tryRefresh(() => ensureRoles(true));
      host.innerHTML = "";
      await render();
    }
    host.innerHTML = `<div class="v2-inline" style="margin-bottom:14px">
      <input id="role-rename-name" value="${escapeHtml(role.name)}">
      ${btn("Сохранить", 'id="role-rename-submit"', true)}${btn("Отмена", 'id="role-rename-cancel"')}
      <span class="v2-auth-error" id="role-rename-error"></span></div>`;
    host.querySelector("#role-rename-name").addEventListener("input", () =>
      markRoleFormDirty(host, "Переименование роли не сохранено.", submit));
    host.querySelector("#role-rename-cancel").addEventListener("click", () => {
      clearRoleFormDirty();
      host.innerHTML = "";
    });
    host.querySelector("#role-rename-submit").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await submit(); } catch (err) {
        host.querySelector("#role-rename-error").textContent = err.detail || err.message || "Не удалось переименовать";
      } finally { button.disabled = false; }
    });
  }

  async function deleteRole(role) {
    if (state.rolesBusy) return;
    let plan;
    try { plan = await api.get(`/roles/${role.key}/delete-plan`); }
    catch (err) { state.status = err.detail || "Не удалось получить сведения об удалении"; return render(); }
    const msg = `Удалить роль «${role.name}»? Будет снята у пользователей: ${plan.users}, `
      + `настроенных разрешений в матрице: ${plan.permissions}, выданных грантов: ${plan.granted}.`;
    if (!confirm(msg)) return;
    state.rolesBusy = true;
    // Запись — отдельно от последующего обновления экрана: если сама
    // операция не прошла, это единственная настоящая ошибка ниже.
    try {
      await api.delete(`/roles/${role.key}`);
    } catch (err) {
      state.status = err.detail || "Не удалось удалить роль";
      state.rolesBusy = false;
      await render();
      return;
    }
    // Стираем из черновика только ячейки САМОЙ удалённой роли — они больше
    // ни к чему не относятся; черновик по ДРУГИМ, ещё существующим ролям
    // должен пережить удаление, а не пропасть заодно.
    for (const key of [...state.rolesDraft.keys()]) {
      if (key.startsWith(`${role.key}|`)) state.rolesDraft.delete(key);
    }
    if (state.rolesDraft.size) markRolesDraftDirty(); else clearDirtyState();
    state.access = null; // редактор доступа мог кэшировать её грант
    let refreshOk = await tryRefresh(() => ensureRoles(true));
    // Матрица доступа нужна только колонке "Доступ" в списке пользователей
    // (раздел "users") — если её не видно, даже не пытаемся: не даём
    // не относящейся к делу 403 выглядеть как провал удаления роли.
    if (canReadUsers) refreshOk = (await tryRefresh(() => ensureAccessMatrix(true))) && refreshOk;
    state.rolesUi.selected = state.roles?.roles?.[0]?.key ?? null;
    const deletedNote = plan.granted ? `Роль удалена, снято выдач: ${plan.granted}` : "Роль удалена";
    state.status = refreshOk ? deletedNote : `${deletedNote}, но не удалось обновить отображение.`;
    state.rolesBusy = false;
    await render();
  }

  // ---------- Проверка доступа ----------

  function selectedObjectLabel(tree) {
    if (state.check.objectId == null) return "— объект не выбран —";
    for (const p of tree) {
      const o = p.objects.find((x) => x.id === state.check.objectId);
      if (o) return `${p.name} / ${o.name}`;
    }
    return "— объект не выбран —";
  }

  // Поиск с клавиатуры вместо плоского списка на сотни объектов: кнопка
  // открывает панель с полем поиска и списком "Проект → Объект", кнопки
  // внутри — обычные (Tab/Enter работают сами по себе), плюс стрелки
  // вверх/вниз и Escape. Смысл поля не меняется — тот же state.check.objectId,
  // включая null = "объект не выбран".
  function renderObjectPicker(container, tree) {
    container.innerHTML = `
      <div class="v2-combobox" id="chk-combobox">
        <button type="button" class="v2-combobox-toggle" id="chk-toggle" aria-haspopup="listbox" aria-expanded="false">
          <span id="chk-toggle-label"></span>
        </button>
        <div class="v2-combobox-panel" id="chk-panel" hidden>
          <input type="text" id="chk-object-search" class="v2-search" placeholder="Поиск проекта или объекта" autocomplete="off">
          <div class="v2-combobox-list" id="chk-list" role="listbox" aria-label="Объекты"></div>
        </div>
      </div>`;
    const toggle = container.querySelector("#chk-toggle");
    const label = container.querySelector("#chk-toggle-label");
    const panel = container.querySelector("#chk-panel");
    const search = container.querySelector("#chk-object-search");
    const list = container.querySelector("#chk-list");

    function renderList() {
      const q = state.check.objectQuery.trim().toLowerCase();
      let html = `<button type="button" class="v2-combobox-option" data-object-id="" role="option">— Объект не выбран —</button>`;
      for (const p of tree) {
        const projectMatches = !q || p.name.toLowerCase().includes(q);
        const objects = p.objects.filter((o) => projectMatches || o.name.toLowerCase().includes(q));
        if (!objects.length) continue;
        html += `<div class="v2-combobox-group">${escapeHtml(p.name)}</div>`;
        for (const o of objects) {
          html += `<button type="button" class="v2-combobox-option" data-object-id="${o.id}" role="option" aria-selected="${state.check.objectId === o.id}">${escapeHtml(o.name)}</button>`;
        }
      }
      list.innerHTML = html;
    }

    function open() {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      state.check.pickerOpen = true;
      renderList();
      search.value = state.check.objectQuery;
      search.focus();
      document.addEventListener("click", onOutsideClick, true);
    }
    function close() {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      state.check.pickerOpen = false;
      document.removeEventListener("click", onOutsideClick, true);
    }
    function onOutsideClick(e) {
      if (!container.contains(e.target)) close();
    }
    toggle.addEventListener("click", () => { if (panel.hidden) open(); else close(); });
    search.addEventListener("input", (e) => { state.check.objectQuery = e.target.value; renderList(); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); toggle.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector(".v2-combobox-option")?.focus(); }
    });
    list.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll(".v2-combobox-option")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (i <= 0 ? items[items.length - 1] : items[i - 1])?.focus(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); toggle.focus(); }
    });
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-object-id]");
      if (!b) return;
      state.check.objectId = b.dataset.objectId ? Number(b.dataset.objectId) : null;
      close();
      label.textContent = selectedObjectLabel(tree);
      toggle.focus();
      loadCheck();
    });
    label.textContent = selectedObjectLabel(tree);
  }

  async function renderCheck() {
    await ensureUsers();
    const tree = await ensureTree();
    if (state.check.userId === null && state.users.length) state.check.userId = state.users[0].id;
    body.innerHTML = `
      <div class="v2-bar"><div><h3>Проверка доступа</h3><small>Итоговые разрешения и откуда они получены</small></div></div>
      <div class="v2-fields">
        <label class="v2-field">Пользователь
          <select id="chk-user">${state.users.map((u) => `<option value="${u.id}" ${state.check.userId === u.id ? "selected" : ""}>${escapeHtml(u.display_name)}</option>`).join("")}</select>
        </label>
        <label class="v2-field">Объект<span id="chk-object-holder"></span></label>
      </div>
      <div id="chk-result"></div>
    `;
    renderObjectPicker(body.querySelector("#chk-object-holder"), tree);
    body.querySelector("#chk-user").addEventListener("change", (e) => { state.check.userId = Number(e.target.value); loadCheck(); });
    await loadCheck();
  }

  async function loadCheck() {
    const el = body.querySelector("#chk-result");
    if (!el) return;
    el.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
    const qs = state.check.objectId ? `?object_id=${state.check.objectId}` : "";
    let data;
    try { data = await api.get(`/users/${state.check.userId}/rights-matrix${qs}`); }
    catch (err) { el.innerHTML = `<p class="v2-note"></p>`; el.querySelector("p").textContent = err.detail || "Не удалось получить права"; return; }
    if (data.system_admin) {
      el.innerHTML = `<p class="v2-note">Полный доступ: администратор сервиса. Назначения на объектах его не ограничивают.</p>`;
      return;
    }
    const rolesLine = data.object_roles.length ? `Роли на объекте: ${data.object_roles.join(", ")}` : "Прямых ролей на объекте нет";
    el.innerHTML = `
      <p class="v2-note">${data.object_kind_label ? escapeHtml(data.object_kind_label) + ". " : ""}${escapeHtml(rolesLine)}</p>
      ${data.features.filter((f) => !f.not_applicable).map((f) => `
        <div class="v2-perm">
          <div>${escapeHtml(f.title)}<small>${(f.from_roles || []).map((s) => `Роль «${escapeHtml(s.role)}»${s.source ? " → " + escapeHtml(s.source) : ""}`).join(" · ") || "—"}</small></div>
          <span class="v2-tag">${escapeHtml(LEVEL_LABELS[f.level] || f.level)}</span>
        </div>`).join("")}
    `;
  }

  render();
  return { hasUnsavedChanges, guardLeave: requestLeave };
}
