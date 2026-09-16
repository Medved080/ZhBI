// Пилот V2: «Пользователи и доступ» — три вкладки макета
// (users-access-concept.html), но на реальных данных через реальные
// эндпоинты app/users.py, app/roles.py, app/rights_matrix.py. Модуль сам
// не считает права и не хранит копию бизнес-правил — только показывает
// то, что вернул сервер, и шлёт туда же изменения.

const ROLE_LABELS = { admin: "Администратор", user: "Пользователь", view: "Просмотр" };
const LEVELS = ["none", "read", "write"];

export function mountUsersAccess(container, ctx) {
  const { api, canWrite } = ctx;

  const state = {
    page: "users",          // users | edit | roles | check
    users: null,
    roles: null,            // GET /roles (roles+features+sections+level_labels)
    tree: null,             // GET /projects-tree → projects[]
    query: "",
    selectedUserId: null,
    editTab: "profile",
    access: null,           // {system_admin, grants:[...]} рабочая копия для редактора
    accessDirty: false,
    selectedNode: null,     // "all" | "p<id>" | "o<projectId>-<objectId>"
    rolesUi: { selected: null },
    check: { userId: null, objectId: null, data: null },
    status: "",
  };

  async function ensureUsers(force) {
    if (!state.users || force) state.users = await api.get("/users");
    return state.users;
  }
  async function ensureRoles(force) {
    if (!state.roles || force) state.roles = await api.get("/roles");
    return state.roles;
  }
  async function ensureTree() {
    if (!state.tree) state.tree = (await api.get("/projects-tree")).projects;
    return state.tree;
  }

  function confirmDiscard(msg) {
    if (!state.accessDirty) return true;
    return confirm(msg || "Есть несохранённые изменения доступа. Продолжить без сохранения?");
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function btn(label, attr = "", primary = false) {
    return `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" ${attr}>${label}</button>`;
  }

  // ---------- каркас ----------

  container.classList.add("v2-app");
  container.innerHTML = `
    <nav class="v2-nav" aria-label="Разделы">
      <button data-page="users" aria-pressed="true">Пользователи</button>
      <button data-page="roles" aria-pressed="false">Роли</button>
      <button data-page="check" aria-pressed="false">Проверка доступа</button>
    </nav>
    <div id="ua-body" class="v2-scroll"></div>
    <footer class="v2-foot"><span id="ua-status" class="v2-muted"></span><div class="v2-foot-actions" id="ua-foot-actions"></div></footer>
  `;
  const nav = container.querySelector(".v2-nav");
  const body = container.querySelector("#ua-body");
  const status = container.querySelector("#ua-status");
  const footActions = container.querySelector("#ua-foot-actions");

  async function goto(page) {
    if (page !== state.page && state.page === "edit" && state.editTab === "access" && !confirmDiscard()) return;
    state.page = page;
    state.status = "";
    await render();
  }

  nav.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (b) goto(b.dataset.page);
  });

  async function render() {
    nav.querySelectorAll("button[data-page]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.page === (state.page === "edit" ? "users" : state.page))));
    footActions.innerHTML = "";
    status.textContent = state.status;
    try {
      if (state.page === "users") await renderUsers();
      else if (state.page === "edit") await renderEdit();
      else if (state.page === "roles") await renderRoles();
      else if (state.page === "check") await renderCheck();
    } catch (err) {
      body.innerHTML = `<p class="v2-note">${escapeHtml(err.detail || err.message || err)}</p>`;
    }
  }

  // ---------- Пользователи ----------

  function userRows() {
    const q = state.query.toLowerCase();
    const rows = state.users.filter((u) =>
      !q || `${u.display_name} ${u.domain_login} ${u.department || ""}`.toLowerCase().includes(q));
    if (!rows.length) return `<tr><td colspan="4">Пользователи не найдены</td></tr>`;
    return rows.map((u) => `
      <tr>
        <td><div class="v2-person">
          <span class="v2-avatar">${escapeHtml(initials(u))}</span>
          <div><button class="v2-link" data-user="${u.id}">${escapeHtml(u.display_name)}</button>
          <small>${escapeHtml([u.position, u.department].filter(Boolean).join(" · ") || "—")}</small></div>
        </div></td>
        <td>${escapeHtml(u.domain_login)}<small>${u.auth_method === "domain" ? "Домен" : (u.has_password ? "Пароль сервиса" : "Пароль не задан")}</small></td>
        <td><span class="v2-tag">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span></td>
        <td class="v2-row-action"><button class="v2-link" data-user="${u.id}">Открыть</button></td>
      </tr>`).join("");
  }

  function initials(u) {
    return `${(u.last_name || "?")[0] || ""}${(u.first_name || "")[0] || ""}`.toUpperCase();
  }

  async function renderUsers() {
    await ensureUsers();
    body.innerHTML = `
      <div class="v2-bar"><h3>Пользователи <small>${state.users.length} учётных записей</small></h3>
        ${canWrite ? btn("Добавить пользователя", 'data-new', true) : ""}</div>
      <div class="v2-bar"><input class="v2-search" id="ua-search" placeholder="Имя, логин или подразделение" value="${escapeHtml(state.query)}"></div>
      <table class="v2-table"><thead><tr><th>Пользователь</th><th>Учётная запись</th><th>Системная роль</th><th></th></tr></thead>
      <tbody id="ua-rows">${userRows()}</tbody></table>
      <div id="ua-new-user"></div>
    `;
    body.querySelector("#ua-search").addEventListener("input", (e) => {
      state.query = e.target.value;
      body.querySelector("#ua-rows").innerHTML = userRows();
    });
    body.querySelectorAll("[data-user]").forEach((el) => el.addEventListener("click", () => openUser(Number(el.dataset.user))));
    const newBtn = body.querySelector("[data-new]");
    if (newBtn) newBtn.addEventListener("click", () => renderNewUserForm());
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
            <select id="nu-role">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          </label>
        </div>
        <div class="v2-auth-error" id="nu-error"></div>
        <div class="v2-inline" style="margin-top:12px">${btn("Создать", 'id="nu-submit"', true)}${btn("Отмена", 'id="nu-cancel"')}</div>
      </div>`;
    el.querySelector("#nu-cancel").addEventListener("click", () => { el.innerHTML = ""; });
    el.querySelector("#nu-submit").addEventListener("click", async () => {
      const errorEl = el.querySelector("#nu-error");
      errorEl.textContent = "";
      const last_name = el.querySelector("#nu-last").value.trim();
      const domain_login = el.querySelector("#nu-login").value.trim();
      if (!last_name || !domain_login) { errorEl.textContent = "Заполните фамилию и логин"; return; }
      try {
        const created = await api.post("/users", {
          last_name, first_name: el.querySelector("#nu-first").value.trim(),
          domain_login, role: el.querySelector("#nu-role").value,
        });
        await ensureUsers(true);
        openUser(created.id);
      } catch (err) {
        errorEl.textContent = err.detail || "Не удалось создать пользователя";
      }
    });
  }

  async function openUser(id) {
    state.selectedUserId = id;
    state.editTab = "profile";
    state.access = null;
    state.accessDirty = false;
    state.page = "edit";
    await render();
  }

  // ---------- Карточка пользователя ----------

  function currentUser() { return state.users.find((u) => u.id === state.selectedUserId); }

  async function renderEdit() {
    await ensureUsers();
    const u = currentUser();
    if (!u) { state.page = "users"; return render(); }
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
    body.querySelector("[data-back]").addEventListener("click", () => { if (confirmDiscard()) goto("users"); });
    body.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", async () => {
      if (state.editTab === "access" && b.dataset.tab !== "access" && !confirmDiscard()) return;
      state.editTab = b.dataset.tab;
      await render();
    }));
    const panel = body.querySelector("#ua-edit-panel");
    if (state.editTab === "profile") renderProfile(panel, u);
    else if (state.editTab === "security") renderSecurity(panel, u);
    else await renderAccess(panel, u);
  }

  function renderProfile(panel, u) {
    panel.innerHTML = `
      <h4>Основные сведения</h4>
      <div class="v2-fields">
        <label class="v2-field">Фамилия<input id="pf-last" value="${escapeHtml(u.last_name)}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field">Имя<input id="pf-first" value="${escapeHtml(u.first_name || "")}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field">Отчество<input id="pf-patr" value="${escapeHtml(u.patronymic || "")}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field">Должность<input id="pf-pos" value="${escapeHtml(u.position || "")}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field v2-span">Подразделение<input id="pf-dept" value="${escapeHtml(u.department || "")}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field">Логин<input id="pf-login" value="${escapeHtml(u.domain_login)}" ${canWrite ? "" : "disabled"}></label>
        <label class="v2-field">Системная роль
          <select id="pf-role" ${canWrite ? "" : "disabled"}>${Object.entries(ROLE_LABELS)
            .map(([v, l]) => `<option value="${v}" ${u.role === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </label>
      </div>
      <p class="v2-note">Системная роль и роли на объектах — разные настройки (вкладка «Доступ к объектам»).</p>
      <div class="v2-auth-error" id="pf-error"></div>
      ${canWrite ? btn("Сохранить", 'id="pf-save"', true) : ""}
    `;
    if (!canWrite) return;
    panel.querySelector("#pf-save").addEventListener("click", async () => {
      const errorEl = panel.querySelector("#pf-error");
      errorEl.textContent = "";
      try {
        const updated = await api.patch(`/users/${u.id}`, {
          last_name: panel.querySelector("#pf-last").value.trim(),
          first_name: panel.querySelector("#pf-first").value.trim(),
          patronymic: panel.querySelector("#pf-patr").value.trim() || null,
          position: panel.querySelector("#pf-pos").value.trim() || null,
          department: panel.querySelector("#pf-dept").value.trim() || null,
          domain_login: panel.querySelector("#pf-login").value.trim(),
          role: panel.querySelector("#pf-role").value,
          auth_method: u.auth_method,
        });
        Object.assign(u, updated);
        state.status = "Сохранено";
        await render();
      } catch (err) {
        errorEl.textContent = err.detail || "Не удалось сохранить";
      }
    });
  }

  function renderSecurity(panel, u) {
    panel.innerHTML = `
      <h4>Способ входа</h4>
      <p class="v2-muted">${u.auth_method === "domain" ? "Доменная учётная запись — паролем управляет домен." : (u.has_password ? "Пароль сервиса задан." : "Пароль не задан — вход запрещён.")}</p>
      ${canWrite && u.auth_method !== "domain" ? `
        <div class="v2-fields">
          <label class="v2-field">Новый пароль<input id="sec-pass" type="password"></label>
        </div>
        <label class="v2-role-check"><input type="checkbox" id="sec-must" checked><span>Потребовать смену при следующем входе</span></label>
        <div class="v2-auth-error" id="sec-error"></div>
        ${btn("Задать пароль", 'id="sec-save"', true)}
      ` : ""}
    `;
    const saveBtn = panel.querySelector("#sec-save");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      const errorEl = panel.querySelector("#sec-error");
      errorEl.textContent = "";
      try {
        await api.post(`/users/${u.id}/set-password`, {
          password: panel.querySelector("#sec-pass").value,
          must_change_password: panel.querySelector("#sec-must").checked,
        });
        state.status = "Пароль обновлён";
        panel.querySelector("#sec-pass").value = "";
      } catch (err) {
        errorEl.textContent = err.detail || "Не удалось задать пароль";
      }
    });
  }

  // ---------- Доступ к объектам ----------

  function grantsAt(key) {
    if (key === "all") return state.access.grants.filter((g) => g.project_id == null && g.object_id == null);
    if (key.startsWith("p")) {
      const pid = Number(key.slice(1));
      return state.access.grants.filter((g) => g.project_id === pid && g.object_id == null);
    }
    const [, pid, oid] = key.match(/^o(\d+)-(\d+)$/).map(Number);
    return state.access.grants.filter((g) => g.object_id === oid);
  }

  function inheritedRoles(key) {
    if (key === "all") return [];
    const all = grantsAt("all").map((g) => g.role);
    if (key.startsWith("p")) return all;
    const pid = Number(key.match(/^o(\d+)-/)[1]);
    return [...all, ...grantsAt("p" + pid).map((g) => g.role)];
  }

  function effectiveRoles(project, obj) {
    const all = grantsAt("all").map((g) => g.role);
    const proj = grantsAt("p" + project.id).map((g) => g.role);
    const own = state.access.grants.filter((g) => g.object_id === obj.id).map((g) => g.role);
    return [...new Set([...all, ...proj, ...own])];
  }

  function roleNameList(keys) {
    if (!keys.length) return "Нет назначений";
    const byKey = Object.fromEntries((state.roles?.roles || []).map((r) => [r.key, r.name]));
    return keys.map((k) => byKey[k] || k).join(" + ");
  }

  async function renderAccess(panel, u) {
    await ensureRoles();
    if (!state.access || state.access._userId !== u.id) {
      const data = await api.get(`/users/${u.id}/access`);
      state.access = { ...data, grants: data.grants.map((g) => ({ project_id: g.project_id, object_id: g.object_id, role: g.role })), _userId: u.id };
      state.accessDirty = false;
      state.selectedNode = "all";
    }
    if (state.access.system_admin) {
      panel.innerHTML = `<h4>Полный доступ ко всему сервису</h4>
        <p class="v2-note">Администратор сервиса имеет доступ ко всем текущим и будущим проектам и объектам. Назначения ролей его не ограничивают.</p>`;
      return;
    }
    const tree = await ensureTree();
    const key = state.selectedNode || "all";
    panel.innerHTML = `
      <div class="v2-tree">
        <div class="v2-tree-list">
          <button data-node="all" aria-pressed="${key === "all"}">Все проекты<small>${roleNameList(grantsAt("all").map((g) => g.role))}</small></button>
          ${tree.map((p) => `
            <div>
              <button data-node="p${p.id}" aria-pressed="${key === "p" + p.id}">${escapeHtml(p.name)}<small>${roleNameList(grantsAt("p" + p.id).map((g) => g.role))}</small></button>
              <div class="v2-indent">
                ${p.objects.map((o) => `<button data-node="o${p.id}-${o.id}" aria-pressed="${key === "o" + p.id + "-" + o.id}">${escapeHtml(o.name)}<small>${roleNameList(effectiveRoles(p, o))}</small></button>`).join("")}
              </div>
            </div>`).join("")}
        </div>
        <div id="ua-node-editor"></div>
      </div>
    `;
    panel.querySelectorAll("[data-node]").forEach((b) => b.addEventListener("click", () => {
      state.selectedNode = b.dataset.node;
      renderAccess(panel, u);
    }));
    renderNodeEditor(panel.querySelector("#ua-node-editor"), key, tree);
    // Кнопки — в общем закреплённом футере, а не под деревом: список
    // проектов бывает длинным (сотни строк), и кнопка внизу панели
    // прокручивалась бы вместе с ним, а не оставалась под рукой.
    if (canWrite) {
      footActions.innerHTML = `${btn("Отменить", 'id="ua-access-cancel"')}${btn("Сохранить изменения", 'id="ua-access-save"', true)}`;
      status.textContent = state.accessDirty ? "Есть несохранённые изменения" : "";
      footActions.querySelector("#ua-access-save").addEventListener("click", async () => {
        try {
          await api.put(`/users/${u.id}/access`, { grants: state.access.grants });
          state.accessDirty = false;
          state.status = "Доступ сохранён";
          state.access = null;
          await render();
        } catch (err) {
          state.status = err.detail || "Не удалось сохранить доступ";
          await render();
        }
      });
      footActions.querySelector("#ua-access-cancel").addEventListener("click", async () => {
        state.access = null; state.accessDirty = false; await render();
      });
    }
  }

  function nodeLabel(key, tree) {
    if (key === "all") return "Все проекты";
    if (key.startsWith("p")) return tree.find((p) => p.id === Number(key.slice(1)))?.name || key;
    const [, pid, oid] = key.match(/^o(\d+)-(\d+)$/).map(Number);
    const p = tree.find((x) => x.id === pid);
    const o = p?.objects.find((x) => x.id === oid);
    return `${p?.name || pid} / ${o?.name || oid}`;
  }

  function renderNodeEditor(el, key, tree) {
    const direct = grantsAt(key).map((g) => g.role);
    const inherited = inheritedRoles(key);
    el.innerHTML = `
      <h4>${escapeHtml(nodeLabel(key, tree))}</h4>
      <small>Прямые назначения в выбранной области</small>
      ${(state.roles.roles || []).map((r) => `
        <label class="v2-role-check"><input type="checkbox" data-grant-role="${r.key}" ${direct.includes(r.key) ? "checked" : ""} ${canWrite ? "" : "disabled"}><span>${escapeHtml(r.name)}</span></label>
      `).join("")}
      <p class="v2-note">${inherited.length ? "Унаследовано: " + roleNameList([...new Set(inherited)]) + ". Прямые назначения складываются с унаследованными." : "Унаследованных ролей нет."}</p>
    `;
    el.querySelectorAll("[data-grant-role]").forEach((cb) => cb.addEventListener("change", () => {
      const role = cb.dataset.grantRole;
      let project_id = null, object_id = null;
      if (key.startsWith("p")) project_id = Number(key.slice(1));
      else if (key.startsWith("o")) {
        const m = key.match(/^o(\d+)-(\d+)$/);
        project_id = Number(m[1]); object_id = Number(m[2]);
      }
      const idx = state.access.grants.findIndex((g) => g.project_id === project_id && g.object_id === object_id && g.role === role);
      if (cb.checked && idx === -1) state.access.grants.push({ project_id, object_id, role });
      else if (!cb.checked && idx !== -1) state.access.grants.splice(idx, 1);
      state.accessDirty = true;
      status.textContent = "Есть несохранённые изменения";
      renderNodeEditor(el, key, tree);
      // обновить подписи в дереве без полной перерисовки формы недоступно —
      // достаточно перерисовать панель целиком при следующем открытии узла
    }));
  }

  // ---------- Роли ----------

  async function renderRoles() {
    await ensureRoles();
    const ui = state.rolesUi;
    if (ui.selected === null && state.roles.roles.length) ui.selected = state.roles.roles[0].key;
    const role = state.roles.roles.find((r) => r.key === ui.selected);
    body.innerHTML = `
      <div class="v2-bar"><div><h3>Роли на объектах</h3><small>Независимые наборы разрешений — складываются, не заменяют друг друга</small></div>
        ${canWrite ? btn("Создать роль", 'id="role-new"') : ""}</div>
      <div id="role-new-form"></div>
      <div class="v2-cols">
        <aside class="v2-side">
          ${state.roles.roles.map((r) => `<button data-role="${r.key}" aria-pressed="${r.key === ui.selected}">${escapeHtml(r.name)}<small>${r.granted} назначений</small></button>`).join("")}
        </aside>
        <section id="role-editor"></section>
      </div>`;
    if (canWrite) body.querySelector("#role-new").addEventListener("click", () => renderRoleCreateForm());
    body.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", () => {
      ui.selected = b.dataset.role; renderRoles();
    }));
    if (role) renderRoleEditor(body.querySelector("#role-editor"), role);
  }

  function renderRoleCreateForm() {
    const el = body.querySelector("#role-new-form");
    el.innerHTML = `<div class="v2-inline" style="margin-bottom:14px">
      <input id="role-new-name" placeholder="Название роли">
      ${btn("Создать", 'id="role-new-submit"', true)}${btn("Отмена", 'id="role-new-cancel"')}
      <span class="v2-auth-error" id="role-new-error"></span></div>`;
    el.querySelector("#role-new-cancel").addEventListener("click", () => { el.innerHTML = ""; });
    el.querySelector("#role-new-submit").addEventListener("click", async () => {
      const name = el.querySelector("#role-new-name").value.trim();
      const errorEl = el.querySelector("#role-new-error");
      if (!name) { errorEl.textContent = "Введите название"; return; }
      try {
        const created = await api.post("/roles", { name });
        await ensureRoles(true);
        state.rolesUi.selected = created.key;
        el.innerHTML = "";
        await render();
      } catch (err) { errorEl.textContent = err.detail || "Не удалось создать роль"; }
    });
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
        ${canWrite ? `<div class="v2-inline">${btn("Переименовать", 'id="role-rename"')}${btn("Удалить", 'id="role-delete"')}</div>` : ""}</div>
      <div id="role-rename-form"></div>
      <small>Нет — разрешение не добавляется этой ролью. Другие роли могут давать доступ.</small>
      ${[...sections.entries()].map(([section, feats]) => `
        <div class="v2-group">${escapeHtml(section)}</div>
        ${feats.map((f) => `
          <div class="v2-perm">
            <div>${escapeHtml(f.title)}<small>${escapeHtml(f.scope_label || "")}</small></div>
            <div class="v2-seg" aria-label="${escapeHtml(f.title)}">
              ${LEVELS.map((lv) => `<button data-perm="${f.key}" data-level="${lv}" aria-pressed="${(f.levels[role.key] || "none") === lv}" ${canWrite ? "" : "disabled"}>${state.roles.level_labels[lv]}</button>`).join("")}
            </div>
          </div>`).join("")}
      `).join("")}
      <p class="v2-note">Изменения роли затронут всех, кому она назначена (сейчас — ${role.granted}).</p>
    `;
    if (canWrite) {
      el.querySelector("#role-delete").addEventListener("click", () => deleteRole(role));
      el.querySelector("#role-rename").addEventListener("click", () => renderRoleRenameForm(el, role));
      el.querySelectorAll("[data-perm]").forEach((b) => b.addEventListener("click", async () => {
        const feature_key = b.dataset.perm, level = b.dataset.level;
        try {
          await api.put("/roles/features", { items: [{ role_key: role.key, feature_key, level }] });
          await ensureRoles(true);
          const fresh = state.roles.roles.find((r) => r.key === role.key);
          renderRoleEditor(el, fresh);
        } catch (err) { state.status = err.detail || "Не удалось сохранить разрешение"; status.textContent = state.status; }
      }));
    }
  }

  function renderRoleRenameForm(el, role) {
    const host = el.querySelector("#role-rename-form");
    host.innerHTML = `<div class="v2-inline" style="margin-bottom:14px">
      <input id="role-rename-name" value="${escapeHtml(role.name)}">
      ${btn("Сохранить", 'id="role-rename-submit"', true)}${btn("Отмена", 'id="role-rename-cancel"')}
      <span class="v2-auth-error" id="role-rename-error"></span></div>`;
    host.querySelector("#role-rename-cancel").addEventListener("click", () => { host.innerHTML = ""; });
    host.querySelector("#role-rename-submit").addEventListener("click", async () => {
      const name = host.querySelector("#role-rename-name").value.trim();
      const errorEl = host.querySelector("#role-rename-error");
      if (!name) { errorEl.textContent = "Введите название"; return; }
      try {
        await api.patch(`/roles/${role.key}`, { name });
        await ensureRoles(true);
        await render();
      } catch (err) { errorEl.textContent = err.detail || "Не удалось переименовать"; }
    });
  }

  async function deleteRole(role) {
    let plan;
    try { plan = await api.get(`/roles/${role.key}/delete-plan`); }
    catch (err) { state.status = err.detail || "Не удалось получить сведения об удалении"; return render(); }
    const msg = `Удалить роль «${role.name}»? Будет снята у пользователей: ${plan.users}, `
      + `настроенных разрешений в матрице: ${plan.permissions}, выданных грантов: ${plan.granted}.`;
    if (!confirm(msg)) return;
    try {
      await api.delete(`/roles/${role.key}`);
      state.rolesUi.selected = null;
      await render();
    } catch (err) { state.status = err.detail || "Не удалось удалить роль"; await render(); }
  }

  // ---------- Проверка доступа ----------

  async function renderCheck() {
    await ensureUsers();
    await ensureRoles();
    const tree = await ensureTree();
    if (state.check.userId === null && state.users.length) state.check.userId = state.users[0].id;
    body.innerHTML = `
      <div class="v2-bar"><div><h3>Проверка доступа</h3><small>Итоговые разрешения и откуда они получены</small></div></div>
      <div class="v2-fields">
        <label class="v2-field">Пользователь
          <select id="chk-user">${state.users.map((u) => `<option value="${u.id}" ${state.check.userId === u.id ? "selected" : ""}>${escapeHtml(u.display_name)}</option>`).join("")}</select>
        </label>
        <label class="v2-field">Объект
          <select id="chk-object"><option value="">— не выбран —</option>
            ${tree.map((p) => p.objects.map((o) => `<option value="${o.id}" ${state.check.objectId === o.id ? "selected" : ""}>${escapeHtml(p.name)} / ${escapeHtml(o.name)}</option>`).join("")).join("")}
          </select>
        </label>
      </div>
      <div id="chk-result"></div>
    `;
    body.querySelector("#chk-user").addEventListener("change", (e) => { state.check.userId = Number(e.target.value); loadCheck(); });
    body.querySelector("#chk-object").addEventListener("change", (e) => { state.check.objectId = e.target.value ? Number(e.target.value) : null; loadCheck(); });
    await loadCheck();
  }

  async function loadCheck() {
    const el = body.querySelector("#chk-result");
    if (!el) return;
    el.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
    const qs = state.check.objectId ? `?object_id=${state.check.objectId}` : "";
    let data;
    try { data = await api.get(`/users/${state.check.userId}/rights-matrix${qs}`); }
    catch (err) { el.innerHTML = `<p class="v2-note">${escapeHtml(err.detail || "Не удалось получить права")}</p>`; return; }
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
          <span class="v2-tag">${escapeHtml(state.roles?.level_labels?.[f.level] || f.level)}</span>
        </div>`).join("")}
    `;
  }

  render();
}
