// «Права пользователей» — сводка доступа всех пользователей (ТОЛЬКО ЧТЕНИЕ): кому какая роль выдана и на каком уровне
// («Все проекты» / проект / объект). Источники те же, что у V1: `GET /users`, `GET /users/access-matrix`, `GET /projects`,
// `GET /projects-tree`. Выдача и отзыв доступа — в «Пользователи и доступ» (там барьер записи), правка ячеек и ролей — в V1:
// это высокорисковая административная операция, в V2 не включена. Записей экран не делает.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const SYSTEM_ROLE = { admin: "Администратор сервиса", user: "Пользователь", view: "Наблюдатель" };

export function mountAccessView(el, { screen, structure, objectId, api, groupTitle }) {
  el.className = "v2-page";
  let dead = false, seq = 0;
  const st = { data: null, error: "", search: "", onlyWithoutAccess: false };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Сводка доступа — только просмотр.</strong> «Все проекты» действует на всё, роль проекта перекрывает её внутри проекта, роль объекта — внутри объекта; пустой доступ значит «не задан».
        Выдать или отозвать доступ можно в разделе «Пользователи и доступ», править роли ячейками — в текущем интерфейсе.
        <div class="v2-callout-actions"><a class="v2-btn" href="#/users-access">Пользователи и доступ</a>${linkList(screen, structure, objectId)}</div></div>
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

  async function load() {
    const my = ++seq;
    st.error = ""; st.data = null; paint();
    try {
      const [users, matrix, projects, tree] = await Promise.all([api.get("/users"), api.get("/users/access-matrix"), api.get("/projects"), api.get("/projects-tree")]);
      if (dead || my !== seq) return; // запоздавший ответ не подменяет более новый
      const catalog = { projects: new Map(projects.map((p) => [p.id, p.name])), objects: new Map() };
      for (const p of tree.projects || []) for (const o of p.objects || []) catalog.objects.set(o.id, o.name);
      st.data = { users, grants: matrix.grants || {}, labels: matrix.role_labels || {}, catalog };
    } catch (e) {
      if (dead || my !== seq) return;
      st.error = errText(e);
    }
    paint();
  }

  $("#av-search").addEventListener("input", (e) => { st.search = e.target.value; paint(); });
  $("#av-none").addEventListener("change", (e) => { st.onlyWithoutAccess = e.target.checked; paint(); });
  $("#av-refresh").addEventListener("click", load);
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}
