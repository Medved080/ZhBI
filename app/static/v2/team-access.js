// V2: «Права по проектной команде» (2026-10-05, протокол «Развитие WEB 4Q26», B2; бэкенд — app/team_access.py).
//
// Что это. Роль в проектной команде объекта (директор проекта, ПТО, снабжение и т. д.) может давать человеку права на этом объекте.
// Экран делает две вещи:
//  1. «Соответствие ролей» — какие системные роли (из «Прав пользователей») получает каждая роль команды. По умолчанию пусто:
//     пока администратор не отметил, никаких прав не выдаётся. Сохранение выдаёт и снимает права СРАЗУ (так решено).
//  2. «Люди команд и учётные записи» — кто назначен в командах, с какой учётной записью сопоставлен (автоматически по «Фамилия И. О.»,
//     вручную или не сопоставлен) и сколько прав выдано по команде. Неоднозначное сопоставление (двое Петровых П.) права НЕ даёт,
//     пока администратор не выберет учётную запись.
// Сам экран ничего не считает — показывает ответ сервера и шлёт ему изменения; запись одна за раз, ввод не теряется при ошибке.
import { ApiError } from "./api.js";
import { showConfirmDialog } from "./dialogs.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HOW = { link: "привязано вручную", auto: "найдено автоматически", ambiguous: "несколько кандидатов — права не выданы", missing: "учётной записи не найдено", none: "не сопоставлять" };
const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

export function mountTeamAccess(container, { api, perms }) {
  let dead = false;
  const canWrite = !!perms?.isSystemAdmin || perms?.users === "write";
  const S = { data: null, error: "", busy: false, note: "", draft: null };   // draft — несохранённое соответствие: {роль команды: Set(системные роли)}

  container.className = "v2-page";
  container.innerHTML = `<div class="v2-container v2-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › Администрирование</div>
    <div class="v2-screen-head"><h2>Права по проектной команде</h2></div>
    <p class="v2-muted">Назначили человека на роль в команде объекта — ему на этом объекте открываются рабочие места, положенные такой роли. Роли и разделы задаются в «Правах пользователей»; здесь — какая роль команды какие системные роли даёт.</p>
    <div id="ta-body"><p class="v2-muted">Загрузка…</p></div></div>`;
  const body = container.querySelector("#ta-body");

  async function load() {
    S.error = "";
    try { S.data = await api.get("/team-access"); S.draft = null; }
    catch (e) { S.error = errText(e); }
    paint();
  }
  const draft = () => S.draft || (S.draft = Object.fromEntries(S.data.team_roles.map((r) => [r.key, new Set(S.data.mapping[r.key] || [])])));
  const dirty = () => {
    if (!S.draft || !S.data) return false;
    return S.data.team_roles.some((r) => {
      const a = [...S.draft[r.key]].sort().join(), b = [...(S.data.mapping[r.key] || [])].sort().join();
      return a !== b;
    });
  };

  function mappingHtml() {
    const d = S.data, cur = draft();
    return `<h3>Соответствие ролей</h3>
      <p class="v2-muted">Отметьте, какие системные роли получает человек с ролью команды на своём объекте. Пустая строка — роль команды прав не даёт. ${d.system_roles.length ? "" : "Системных ролей нет."}</p>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Роль в команде</th>${d.system_roles.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr></thead><tbody>
      ${d.team_roles.map((t) => `<tr><td>${esc(t.label)}</td>${d.system_roles.map((r) => `<td style="text-align:center"><input type="checkbox" data-map="${esc(t.key)}|${esc(r.key)}" ${cur[t.key].has(r.key) ? "checked" : ""} ${canWrite && !S.busy ? "" : "disabled"} aria-label="${esc(t.label)} → ${esc(r.name)}"></td>`).join("")}</tr>`).join("")}
      </tbody></table></div>
      ${canWrite ? `<div class="v2-bar"><button type="button" class="v2-btn v2-primary" data-a="save-map" ${dirty() && !S.busy ? "" : "disabled"}>Сохранить соответствие</button>
        <span class="v2-muted">${dirty() ? "Есть несохранённые изменения. Сохранение выдаст и снимет права сразу." : ""}</span></div>` : ""}`;
  }

  function peopleHtml() {
    const d = S.data;
    if (!d.people.length) return `<h3>Люди команд и учётные записи</h3><p class="v2-note">В проектных командах пока никого нет: назначьте людей в «Проекты и объекты» или загрузите «Справочник ОС WEB».</p>`;
    const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(label)}</option>`;
    return `<h3>Люди команд и учётные записи</h3>
      <p class="v2-muted">Автоматически человек сопоставляется с учётной записью только при единственном совпадении по фамилии и инициалам. Если кандидатов несколько или нет ни одного, права не выдаются — выберите учётную запись вручную.</p>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Человек (справочник физлиц)</th><th>Роли на объектах</th><th>Учётная запись</th><th>Прав по команде</th></tr></thead><tbody>
      ${d.people.map((p) => {
        const a = p.account, mode = a.how === "link" ? `u:${a.user_id}` : a.how === "none" ? "none" : "auto";
        return `<tr><td>${esc(p.name)}</td>
          <td>${p.assignments.map((x) => `${esc(x.object_name)}: <b>${esc(x.team_role_label)}</b>`).join("<br>")}</td>
          <td><div>${a.user_name ? esc(a.user_name) : "—"} <span class="v2-muted">(${esc(HOW[a.how] || a.how)})</span></div>
            ${canWrite ? `<select data-link="${p.individual_id}" ${S.busy ? "disabled" : ""} aria-label="Учётная запись для ${esc(p.name)}">
              ${opt("auto", "— автоматически по ФИО —", mode === "auto")}${opt("none", "— не сопоставлять —", mode === "none")}
              ${d.users.map((u) => opt(`u:${u.id}`, `${u.name} (${u.login})`, mode === `u:${u.id}`)).join("")}</select>` : ""}</td>
          <td style="text-align:center">${p.team_grants}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function paint() {
    if (dead) return;
    if (S.error && !S.data) { body.innerHTML = `<p class="v2-auth-error" role="alert">${esc(S.error)} <button type="button" class="v2-btn" data-a="reload">Повторить</button></p>`; bind(); return; }
    if (!S.data) return;
    body.innerHTML = `${S.note ? `<p class="v2-ok" role="status">${esc(S.note)}</p>` : ""}${S.error ? `<p class="v2-auth-error" role="alert">${esc(S.error)}</p>` : ""}${mappingHtml()}<div style="margin-top:24px">${peopleHtml()}</div>`;
    bind();
  }

  async function run(op) {
    if (S.busy) return;
    S.busy = true; S.error = ""; S.note = ""; paint();
    try { await op(); }
    catch (e) { S.error = errText(e); }
    S.busy = false;
    if (S.error) { paint(); return; }
    await load();
  }

  function bind() {
    for (const el of body.querySelectorAll("[data-map]")) el.addEventListener("change", () => {
      const [t, r] = el.dataset.map.split("|");
      if (el.checked) draft()[t].add(r); else draft()[t].delete(r);
      paint();
    });
    body.querySelector('[data-a="reload"]')?.addEventListener("click", load);
    body.querySelector('[data-a="save-map"]')?.addEventListener("click", async () => {
      if (!(await showConfirmDialog("Сохранить соответствие? Права по проектной команде будут выданы и сняты сразу, у всех объектов.", { confirmLabel: "Сохранить" }))) return;
      run(async () => {
        const mapping = Object.fromEntries(Object.entries(draft()).map(([t, set]) => [t, [...set]]));
        const r = await api.put("/team-access/mapping", { mapping });
        S.note = `Соответствие сохранено. Выдано прав: ${r.granted}, снято: ${r.revoked}.`;
      });
    });
    for (const sel of body.querySelectorAll("[data-link]")) sel.addEventListener("change", () => {
      const v = sel.value, id = sel.dataset.link;
      run(async () => {
        const r = await api.put(`/team-access/links/${id}`, v === "auto" ? { mode: "auto" } : v === "none" ? { mode: "none" } : { mode: "user", user_id: Number(v.slice(2)) });
        S.note = `Привязка сохранена. Выдано прав: ${r.granted}, снято: ${r.revoked}.`;
      });
    });
  }

  load();
  return {
    hasUnsavedChanges: () => dirty() || S.busy,
    guardLeave: async () => !dirty() || showConfirmDialog("В соответствии ролей есть несохранённые изменения. Уйти без сохранения?", { confirmLabel: "Уйти", danger: true }),
    destroy: () => { dead = true; },
  };
}
