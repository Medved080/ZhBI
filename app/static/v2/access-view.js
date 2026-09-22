// «Права пользователей» — сводка доступа всех пользователей и ГРУППОВАЯ выдача/снятие доступа (2026-09-21).
// Источники те же, что у V1: `GET /users`, `GET /users/access-matrix`, `GET /projects`, `GET /projects-tree`.
// Групповая правка — `POST /users/access-bulk` (app/admin_ops.py): сначала предпросмотр (`dry_run`, ничего не пишется), затем применение
// ВСЕ изменения или НИ ОДНОГО; если доступ кого-то из выбранных изменили после загрузки экрана — отказ 409 без записи. Правка одного
// человека — в «Пользователи и доступ».
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";
import { showConfirmDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const SYSTEM_ROLE = { admin: "Администратор сервиса", user: "Пользователь", view: "Наблюдатель" };

export function mountAccessView(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const canBulk = checkWrite("POST", "/users/access-bulk", { changes: [{}] }).allowed && (!!rights?.system_admin || rights?.features?.users === "write");
  el.className = "v2-page";
  let dead = false, seq = 0;
  const st = { data: null, error: "", search: "", onlyWithoutAccess: false };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Сводка доступа${canBulk ? " и групповая выдача" : " — только просмотр"}.</strong> Роли на «Все проекты», проекте и объекте складываются; пустой доступ значит «не задан».
        ${canBulk ? "Ниже можно выдать или снять роли сразу нескольким людям: сначала предпросмотр последствий, затем применение — все изменения или ни одного. " : ""}Доступ одного человека — в разделе «Пользователи и доступ».
        <div class="v2-callout-actions"><a class="v2-btn" href="#/users-access">Пользователи и доступ</a>${linkList(screen, structure, objectId)}</div></div>
      ${canBulk ? `<section class="v2-result" id="av-bulk" aria-label="Групповая выдача доступа"></section>` : ""}
      <div class="v2-wire-row"><label class="v2-wire-field"><span>Поиск по пользователю</span><input type="search" id="av-search" autocomplete="off"></label>
        <label class="v2-wire-check"><input type="checkbox" id="av-none"> Только без выданного доступа</label>
        <button type="button" class="v2-btn" id="av-refresh">Обновить</button></div>
      <p id="av-count" class="v2-muted" aria-live="polite"></p>
      <div id="av-body"></div>
    </div>`;
  const $ = (s) => el.querySelector(s);

  function grantsText(list, catalog, labels, isAdmin) {
    if (!list.length) return isAdmin ? "" : `<span class="v2-muted">не задан</span>`;
    const projName = (id) => catalog.projects.get(id) || `проект ${id}`;
    const objName = (id) => catalog.objects.get(id) || `объект ${id}`;
    const byLevel = new Map();
    for (const g of list) {
      const where = g.project_id == null ? "Все проекты" : g.object_id == null ? `Проект «${projName(g.project_id)}»` : `Объект «${objName(g.object_id)}»`;
      if (!byLevel.has(where)) byLevel.set(where, []);
      byLevel.get(where).push(labels[g.role] || g.role);
    }
    return [...byLevel].map(([where, roles]) => `<div><strong>${esc(where)}:</strong> ${esc(roles.sort().join(", "))}</div>`).join("");
  }

  function paint() {
    if (dead) return;
    const body = $("#av-body");
    if (!st.data) {
      body.innerHTML = st.error
        ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить сводку.</strong> ${esc(st.error)}
           <div class="v2-callout-actions"><button type="button" class="v2-btn" id="av-retry">Повторить</button></div></div>`
        : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#av-retry")?.addEventListener("click", load);
      $("#av-count").textContent = "";
      return;
    }
    const { users, grants, labels, catalog } = st.data;
    const q = st.search.trim().toLowerCase();
    // администратор сервиса проходит проверки в обход ролей: явных грантов у него может не быть, но «без доступа» он не бывает
    const rows = users.filter((u) => {
      const has = u.role === "admin" || (grants[String(u.id)] || []).length > 0;
      if (st.onlyWithoutAccess && has) return false;
      return !q || `${u.display_name} ${u.domain_login} ${u.position || ""}`.toLowerCase().includes(q);
    });
    $("#av-count").textContent = `Пользователей: ${rows.length} из ${users.length}`;
    body.innerHTML = rows.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Пользователь</th><th>Системная роль</th><th>Выданный доступ</th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td>${esc(u.display_name)}<div class="v2-muted">${esc(u.domain_login)}${u.position ? " · " + esc(u.position) : ""}</div></td>
        <td>${esc(SYSTEM_ROLE[u.role] || u.role)}</td><td>${u.role === "admin" ? `<div><strong>Полный доступ:</strong> администратор сервиса</div>` : ""}${grantsText(grants[String(u.id)] || [], catalog, labels, u.role === "admin")}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="v2-muted">Нет пользователей по этому условию.</p>`;
  }

  async function load(quiet) {
    const my = ++seq;
    if (!quiet) { st.error = ""; st.data = null; paint(); }
    let okRead = false;
    try {
      const [users, matrix, projects, tree] = await Promise.all([api.get("/users"), api.get("/users/access-matrix"), api.get("/projects"), api.get("/projects-tree")]);
      if (dead || my !== seq) return false; // запоздавший ответ не подменяет более новый
      const catalog = { projects: new Map(projects.map((p) => [p.id, p.name])), objects: new Map(), objectsByProject: new Map() };
      for (const p of tree.projects || []) for (const o of p.objects || []) { catalog.objects.set(o.id, o.name); if (!catalog.objectsByProject.has(p.id)) catalog.objectsByProject.set(p.id, new Map()); catalog.objectsByProject.get(p.id).set(o.id, o.name); }
      st.data = { users, grants: matrix.grants || {}, labels: matrix.role_labels || {}, roleList: matrix.roles || [], catalog };
      okRead = true;
    } catch (e) {
      if (dead || my !== seq) return false;
      if (!quiet || !st.data) st.error = errText(e);
    }
    paint(); paintBulk();
    return okRead;
  }

  // ------------------------------------------------------------------ групповая выдача / снятие
  const bulk = { action: "grant", area: "all", projectId: "", objectId: "", roles: new Set(), sysRole: "user", picked: new Set(), q: "", preview: null, busy: false, msg: "" };
  const KEY = (p, o, r) => `${p ?? ""}|${o ?? ""}|${r}`;
  function areaOk() { return bulk.area === "all" || (bulk.area === "project" && bulk.projectId) || (bulk.area === "object" && bulk.projectId && bulk.objectId); }
  function areaLabel() {
    if (bulk.area === "all") return "все проекты";
    const p = st.data.catalog.projects.get(Number(bulk.projectId));
    if (bulk.area === "project") return `проект «${p}»`;
    return `объект «${st.data.catalog.objects.get(Number(bulk.objectId))}» (проект «${p}»)`;
  }
  function targetTriples() {
    const p = bulk.area === "all" ? null : Number(bulk.projectId), o = bulk.area === "object" ? Number(bulk.objectId) : null;
    return [...bulk.roles].map((r) => ({ project_id: p, object_id: o, role: r }));
  }
  // Изменения по выбранным людям: новые наборы грантов (или системная роль) + то, что экран видел при загрузке (для проверки «устарело»).
  function buildChanges() {
    const out = [];
    for (const uid of bulk.picked) {
      const user = st.data.users.find((u) => u.id === uid);
      const cur = (st.data.grants[String(uid)] || []).map((g) => ({ project_id: g.project_id, object_id: g.object_id, role: g.role }));
      if (bulk.action === "sysrole") { out.push({ user_id: uid, role: bulk.sysRole, expected_role: user.role }); continue; }
      const have = new Set(cur.map((g) => KEY(g.project_id, g.object_id, g.role)));
      const t = targetTriples();
      let next;
      if (bulk.action === "grant") next = [...cur, ...t.filter((g) => !have.has(KEY(g.project_id, g.object_id, g.role)))];
      else { const drop = new Set(t.map((g) => KEY(g.project_id, g.object_id, g.role))); next = cur.filter((g) => !drop.has(KEY(g.project_id, g.object_id, g.role))); }
      out.push({ user_id: uid, grants: next, expected_grants: cur });
    }
    return out;
  }
  function bulkReady() {
    if (!bulk.picked.size) return "Отметьте хотя бы одного пользователя.";
    if (bulk.action === "sysrole") return "";
    if (!bulk.roles.size) return "Отметьте хотя бы одну роль.";
    if (!areaOk()) return "Выберите проект или объект.";
    return "";
  }
  function paintBulk() {
    const host = $("#av-bulk");
    if (!host || dead || !st.data) return;
    const d = st.data;
    const q = bulk.q.trim().toLowerCase();
    const people = d.users.filter((u) => !q || `${u.display_name} ${u.domain_login}`.toLowerCase().includes(q));
    const objectsOfProject = [...d.catalog.objectsByProject.get(Number(bulk.projectId)) || []];
    const problem = bulkReady();
    host.innerHTML = `<h3>Групповая выдача и снятие доступа</h3>
      <div class="v2-wire-row" role="radiogroup" aria-label="Действие">
        ${[["grant", "Выдать роли"], ["revoke", "Снять роли"], ["sysrole", "Задать системную роль"]].map(([k, l]) => `<label class="v2-wire-check"><input type="radio" name="bk-action" value="${k}" ${bulk.action === k ? "checked" : ""}> ${l}</label>`).join("")}
      </div>
      ${bulk.action === "sysrole" ? `<div class="v2-wire-row"><label class="v2-wire-field"><span>Системная роль</span><select id="bk-sysrole">${Object.entries(SYSTEM_ROLE).map(([k, l]) => `<option value="${k}" ${bulk.sysRole === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label></div>
        <p class="v2-note">Системная роль — про ведение сервиса, не про стройки. Снять роль администратора с самого себя нельзя.</p>` : `
      <div class="v2-wire-row">
        <label class="v2-wire-field"><span>Область</span><select id="bk-area"><option value="all" ${bulk.area === "all" ? "selected" : ""}>Все проекты</option><option value="project" ${bulk.area === "project" ? "selected" : ""}>Проект</option><option value="object" ${bulk.area === "object" ? "selected" : ""}>Объект</option></select></label>
        ${bulk.area !== "all" ? `<label class="v2-wire-field"><span>Проект</span><select id="bk-project"><option value="">— выберите —</option>${[...d.catalog.projects].map(([id, n]) => `<option value="${id}" ${String(bulk.projectId) === String(id) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
        ${bulk.area === "object" ? `<label class="v2-wire-field"><span>Объект</span><select id="bk-object"><option value="">— выберите —</option>${objectsOfProject.map(([id, n]) => `<option value="${id}" ${String(bulk.objectId) === String(id) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="v2-wire-row" role="group" aria-label="Роли">${(d.roleList || []).map((r) => `<label class="v2-wire-check"><input type="checkbox" data-bk-role="${esc(r.key)}" ${bulk.roles.has(r.key) ? "checked" : ""}> ${esc(r.name)}</label>`).join("")}</div>
      ${bulk.action === "revoke" ? `<p class="v2-note">Снимаются только роли, выданные ИМЕННО на этом уровне. Роли, унаследованные от «Всех проектов» или проекта, остаются — их снимают там, где выданы.</p>` : ""}`}
      <div class="v2-bar"><input type="search" id="bk-search" class="v2-search" placeholder="Найти пользователя" aria-label="Найти пользователя" value="${esc(bulk.q)}">
        <span class="v2-muted">Выбрано: ${bulk.picked.size} из ${d.users.length}</span>
        <button type="button" class="v2-btn" id="bk-pick-shown">Выбрать всех найденных</button><button type="button" class="v2-btn" id="bk-pick-none" ${bulk.picked.size ? "" : "disabled"}>Снять выбор</button></div>
      <div class="v2-bulk-people">${people.map((u) => `<label class="v2-wire-check"><input type="checkbox" data-bk-user="${u.id}" ${bulk.picked.has(u.id) ? "checked" : ""}> ${esc(u.display_name)} <span class="v2-muted">${esc(u.domain_login)} · ${esc(SYSTEM_ROLE[u.role] || u.role)}</span></label>`).join("") || `<p class="v2-muted">Никого не найдено.</p>`}</div>
      <div class="v2-inline" style="margin-top:10px"><button type="button" class="v2-btn v2-primary" id="bk-preview" ${bulk.busy || problem ? "disabled" : ""}>Предпросмотр последствий</button>
        <span class="v2-muted" id="bk-problem">${esc(problem)}</span></div>
      <div id="bk-preview-box" aria-live="polite"></div>
      <p class="v2-muted" role="status" aria-live="polite" id="bk-msg">${esc(bulk.msg)}</p>`;
    paintPreview();
  }
  function paintPreview() {
    const box = $("#bk-preview-box");
    if (!box) return;
    const pv = bulk.preview;
    if (!pv) { box.innerHTML = ""; return; }
    if (!pv.changed) { box.innerHTML = `<div class="v2-callout" role="note"><strong>Менять нечего.</strong> У выбранных людей всё уже так, как указано.</div>`; return; }
    box.innerHTML = `<div class="v2-callout" role="note"><strong>Предпросмотр: ${bulk.action === "grant" ? "будет выдано" : bulk.action === "revoke" ? "будет снято" : "будет изменено"}.</strong>
      Затронуто людей: ${pv.changed}; выдаётся назначений: ${pv.added}; снимается: ${pv.removed}; системных ролей меняется: ${pv.roles_changed}. Пока вы не нажали «Применить», ничего не записано.</div>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Пользователь</th><th>Системная роль</th><th>Будет выдано</th><th>Будет снято</th></tr></thead><tbody>
      ${pv.users.map((r) => `<tr><td>${esc(r.user)}</td><td>${r.role_to ? `${esc(SYSTEM_ROLE[r.role_from] || r.role_from)} → <strong>${esc(SYSTEM_ROLE[r.role_to] || r.role_to)}</strong>` : "—"}</td><td>${r.added.map(esc).join("<br>") || "—"}</td><td>${r.removed.map(esc).join("<br>") || "—"}</td></tr>`).join("")}</tbody></table></div>
      <div class="v2-inline" style="margin-top:10px"><button type="button" class="v2-btn v2-danger" id="bk-apply" ${bulk.busy ? "disabled" : ""}>Применить (${pv.changed})</button><button type="button" class="v2-btn" id="bk-discard" ${bulk.busy ? "disabled" : ""}>Отмена</button></div>`;
  }
  async function bulkPreview() {
    if (bulk.busy || bulkReady()) return;
    bulk.busy = true; bulk.msg = "Считаем последствия…"; paintBulk();
    try {
      bulk.changes = buildChanges();
      bulk.preview = await api.post("/users/access-bulk", { changes: bulk.changes, dry_run: true });
      bulk.msg = "";
    } catch (e) { bulk.preview = null; bulk.msg = errText(e); if (e instanceof ApiError && e.status === 409) await load(); }
    bulk.busy = false; paintBulk();
  }
  async function bulkApply() {
    if (bulk.busy || !bulk.preview?.changed) return;
    const pv = bulk.preview;
    const what = bulk.action === "sysrole" ? `системная роль будет изменена у ${pv.roles_changed}` : `будет выдано ${pv.added}, снято ${pv.removed}`;
    if (!(await showConfirmDialog(`Применить групповую правку доступа? Затронуто людей: ${pv.changed}; ${what}${bulk.action === "sysrole" ? "" : `; область: ${areaLabel()}`}. Все изменения применяются вместе или не применяются вовсе.`, { confirmLabel: `Применить (${pv.changed})`, danger: true }))) return;
    bulk.busy = true; bulk.msg = "Применяем…"; paintBulk();
    const sentChanges = bulk.changes;
    try {
      const r = await api.post("/users/access-bulk", { changes: sentChanges });
      bulk.msg = `Применено: людей ${r.changed}, выдано ${r.added}, снято ${r.removed}, системных ролей ${r.roles_changed}.`;
      bulk.preview = null; bulk.picked.clear();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        // Исход неизвестен: повторно НЕ отправляем; читаем данные и проверяем, совпало ли состояние с задуманным.
        const ok = await load(true);
        const same = ok && sentChanges.every((c) => (c.grants ? sameGrants(st.data.grants[String(c.user_id)] || [], c.grants) : true) && (c.role ? st.data.users.find((u) => u.id === c.user_id)?.role === c.role : true));
        bulk.msg = same ? "Сервер применил правку, хотя ответ не дошёл." : `Неизвестно, применена ли правка (${errText(e)}). Данные перечитаны — проверьте таблицу ниже.`;
        if (same) { bulk.preview = null; bulk.picked.clear(); }
      } else {
        bulk.msg = errText(e);
        if (e instanceof ApiError && e.status === 409) { bulk.preview = null; await load(true); bulk.msg = `${errText(e)}`; }
      }
    }
    bulk.busy = false;
    if (bulk.preview === null && !bulk.msg.startsWith("Неизвестно")) await load(true);
    paintBulk();
  }
  const sameGrants = (a, b) => { const k = (g) => KEY(g.project_id, g.object_id, g.role); const A = new Set(a.map(k)), B = new Set(b.map(k)); return A.size === B.size && [...A].every((x) => B.has(x)); };
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (!t.closest("#av-bulk")) return;
    if (t.name === "bk-action") { bulk.action = t.value; bulk.preview = null; bulk.msg = ""; paintBulk(); return; }
    if (t.id === "bk-sysrole") { bulk.sysRole = t.value; bulk.preview = null; paintBulk(); return; }
    if (t.id === "bk-area") { bulk.area = t.value; bulk.preview = null; if (bulk.area === "all") { bulk.projectId = ""; bulk.objectId = ""; } paintBulk(); return; }
    if (t.id === "bk-project") { bulk.projectId = t.value; bulk.objectId = ""; bulk.preview = null; paintBulk(); return; }
    if (t.id === "bk-object") { bulk.objectId = t.value; bulk.preview = null; paintBulk(); return; }
    if (t.dataset.bkRole) { if (t.checked) bulk.roles.add(t.dataset.bkRole); else bulk.roles.delete(t.dataset.bkRole); bulk.preview = null; paintBulk(); return; }
    if (t.dataset.bkUser) { const id = Number(t.dataset.bkUser); if (t.checked) bulk.picked.add(id); else bulk.picked.delete(id); bulk.preview = null; paintBulk(); }
  });
  el.addEventListener("input", (e) => {
    if (e.target.id !== "bk-search") return;
    const pos = e.target.selectionStart; bulk.q = e.target.value; paintBulk();
    const s2 = $("#bk-search"); s2?.focus(); try { s2.setSelectionRange(pos, pos); } catch (x) { /* type=search */ }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("#av-bulk button");
    if (!b) return;
    if (b.id === "bk-preview") bulkPreview();
    else if (b.id === "bk-apply") bulkApply();
    else if (b.id === "bk-discard") { bulk.preview = null; bulk.msg = ""; paintBulk(); }
    else if (b.id === "bk-pick-none") { bulk.picked.clear(); bulk.preview = null; paintBulk(); }
    else if (b.id === "bk-pick-shown") {
      const q = bulk.q.trim().toLowerCase();
      for (const u of st.data.users) if (!q || `${u.display_name} ${u.domain_login}`.toLowerCase().includes(q)) bulk.picked.add(u.id);
      bulk.preview = null; paintBulk();
    }
  });

  $("#av-search").addEventListener("input", (e) => { st.search = e.target.value; paint(); });
  $("#av-none").addEventListener("change", (e) => { st.onlyWithoutAccess = e.target.checked; paint(); });
  $("#av-refresh").addEventListener("click", () => load());
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}
