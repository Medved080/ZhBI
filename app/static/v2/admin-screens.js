// Экраны области «администрирование» (impl: "admin:<имя>"): смена своего пароля, сводка «Мой доступ» и др. Один вход для оболочки (main.js),
// внутри — диспетчер по имени. Каждый экран возвращает {hasUnsavedChanges, guardLeave, destroy}.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { mountPasswordForm } from "./password-form.js";

export const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

/** Общий каркас экрана: хлебные крошки, заголовок, статус реализации, пояснение. Возвращает узел содержимого. */
export function frame(el, screen, groupTitle) {
  el.className = "v2-page";
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div id="as-body"></div>
    </div>`;
  return el.querySelector("#as-body");
}

// ---------------------------------------------------------------- «Сменить пароль»
function mountPassword(el, { screen, groupTitle, user, api }) {
  const body = frame(el, screen, groupTitle);
  body.innerHTML = `<div class="v2-callout" role="note"><strong>Смена собственного пароля.</strong> Пароль вводите вы сами; администратор его не видит. После смены остальные ваши сеансы на других устройствах завершаются, этот остаётся.</div>
    <div class="v2-auth-card" style="margin:16px 0;max-width:420px"><div id="as-pw"></div></div>`;
  const form = mountPasswordForm(body.querySelector("#as-pw"), { api, user, forced: false });
  return { hasUnsavedChanges: () => !!form.hasInput?.(), guardLeave: async () => true, destroy() { form.destroy(); } };
}

// ---------------------------------------------------------------- «Мой доступ» (сводка проектов и объектов, доступных вошедшему)
function mountMyAccess(el, { screen, groupTitle, api }) {
  const body = frame(el, screen, groupTitle);
  let dead = false, seq = 0;
  const st = { data: null, error: "", q: "" };
  body.innerHTML = `<div class="v2-bar"><input type="search" id="ma-search" class="v2-search" placeholder="Поиск проекта или объекта" aria-label="Поиск проекта или объекта">
    <span id="ma-count" class="v2-muted" role="status" aria-live="polite"></span><button type="button" class="v2-btn" id="ma-refresh">Обновить</button></div><div id="ma-body"></div>`;
  const $ = (s) => body.querySelector(s);
  function paint() {
    if (dead) return;
    const box = $("#ma-body");
    if (!st.data) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить сводку.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="ma-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#ma-retry")?.addEventListener("click", load);
      return;
    }
    const d = st.data, q = st.q.trim().toLowerCase();
    $("#ma-count").textContent = `Проектов: ${d.totals.projects} · объектов: ${d.totals.objects}`;
    const head = d.system_admin ? `<div class="v2-callout" role="note"><strong>Полный доступ.</strong> Вы — администратор сервиса: доступны все проекты и объекты, роли на объектах вам не выдаются.</div>` : (d.all_projects_roles.length ? `<div class="v2-callout" role="note"><strong>Роли на «Все проекты»:</strong> ${esc(d.all_projects_roles.map((r) => r.name).join(", "))} (действуют на все текущие и будущие проекты).</div>` : "");
    const projects = d.projects.map((p) => ({ ...p, objects: p.objects.filter((o) => !q || o.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) })).filter((p) => !q || p.objects.length || p.name.toLowerCase().includes(q));
    box.innerHTML = head + (projects.length ? projects.map((p) => `<section class="v2-result"><h4>${esc(p.name)} <span class="v2-tag">${p.objects.length} из ${p.objects_total} объектов</span></h4>
      ${p.project_roles.length ? `<small>Роли на проекте: ${esc(p.project_roles.map((r) => r.name).join(", "))} (действуют и на будущие объекты).</small>` : ""}
      ${p.objects.length ? `<table class="v2-read-tbl"><thead><tr><th>Объект</th><th>Тип учёта</th><th>Статус</th><th>Роли и откуда они</th></tr></thead><tbody>${p.objects.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.kind === "mfr" ? "МФР" : "ЖБИ"}</td><td>${esc(({ perspective: "Перспективный", active: "В работе", suspended: "Приостановлен", completed: "Завершён", archived: "Архивный" })[o.status] || o.status)}</td>
        <td>${d.system_admin ? "весь доступ" : o.roles.map((r) => `${esc(r.name)} <span class="v2-muted">(${esc(r.sources.join(" и "))})</span>`).join("<br>")}</td></tr>`).join("")}</tbody></table>` : `<p class="v2-note">${q ? "Нет объектов по запросу." : "Объектов в проекте пока нет; роль проекта распространится на будущие."}</p>`}</section>`).join("")
      : `<p class="v2-note">${q ? `Ничего не найдено по запросу «${esc(st.q.trim())}».` : "Вам пока не выдан доступ ни к одному проекту или объекту. Обратитесь к администратору."}</p>`);
  }
  async function load() {
    const my = ++seq;
    try { const data = await api.get("/me/access-summary"); if (dead || my !== seq) return; st.data = data; st.error = ""; }
    catch (e) { if (dead || my !== seq) return; if (!st.data) st.error = errText(e); }
    paint();
  }
  $("#ma-search").addEventListener("input", (e) => { st.q = e.target.value; paint(); });
  $("#ma-refresh").addEventListener("click", load);
  load();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

const SCREENS = {
  "admin:password": mountPassword,
  "admin:my-access": mountMyAccess,
};

export function hasAdminScreen(impl) { return Object.prototype.hasOwnProperty.call(SCREENS, impl); }
export function mountAdminScreen(el, ctx) { return SCREENS[ctx.screen.impl](el, ctx); }
