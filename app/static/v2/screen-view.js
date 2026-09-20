// Общие экраны оболочки V2: начальная страница и каркас экрана, ещё не перенесённого в V2.
//
// Каркас строится из статической разметки соответствующей формы V1 (scripts/inventory_v1_ui.py):
// заголовки, вкладки, поля, таблицы (заголовки колонок), кнопки. Динамическое содержимое V1 (строки таблиц,
// варианты списков) в разметке не видно и НЕ выдумывается. Все элементы каркаса неактивны, а над ним прямым
// текстом сказано: функция работает только в текущем интерфейсе, здесь показан состав экрана — так что
// ложного успеха и непроверенных запросов нет. Данные не показываются вовсе (демо-режима нет).
import { STATUS_LABEL, v1Href } from "./registry.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const RISK_TEXT = {
  read: "только чтение",
  edit: "правка данных",
  bulk: "массовые операции",
  import: "импорт и загрузка файлов",
  admin: "администрирование, права доступа",
  destructive: "необратимое удаление",
};

const BLOCKED_HINT = "Пока доступно только в текущем интерфейсе";

function wireBlock(b) {
  switch (b.t) {
    case "h": return `<div class="v2-wire-h">${esc(b.text)}</div>`;
    case "tabs": return `<div class="v2-wire-tabs" aria-label="Вкладки в V1">${b.items.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;
    case "hint": return `<p class="v2-wire-hint">${esc(b.text)}</p>`;
    case "check": return `<label class="v2-wire-check"><input type="checkbox" disabled> ${esc(b.text)}</label>`;
    case "radio": return `<label class="v2-wire-check"><input type="radio" disabled> ${esc(b.text)}</label>`;
    case "btn": return `<button type="button" class="v2-btn ${b.kind === "primary" ? "v2-primary" : b.kind === "danger" ? "v2-danger" : ""}" disabled title="${BLOCKED_HINT}">${esc(b.text)}</button>`;
    case "field": {
      const kind = b.kind === "select" ? `<select disabled><option>—</option></select>`
        : b.kind === "textarea" ? `<textarea disabled rows="2" placeholder="${esc(b.ph)}"></textarea>`
        : `<input type="${["date", "number", "password", "time", "datetime-local", "color", "file"].includes(b.kind) ? esc(b.kind) : "text"}" disabled placeholder="${esc(b.ph)}">`;
      return `<label class="v2-wire-field"><span>${esc(b.label || "Поле")}</span>${kind}</label>`;
    }
    case "table": {
      const cols = b.cols || [];
      return `<div class="v2-wire-table"><table><thead><tr>${cols.length ? cols.map((c) => `<th>${esc(c)}</th>`).join("") : "<th>Колонки строятся в V1 динамически</th>"}</tr></thead>
        <tbody><tr><td colspan="${Math.max(cols.length, 1)}" class="v2-muted">Строки не загружаются: чтение этого экрана в V2 не подключено.</td></tr></tbody></table></div>`;
    }
    default: return "";
  }
}

// Подряд идущие поля/флажки/кнопки складываются в сетку, чтобы каркас читался как форма, а не как колонка.
function wireBlocks(blocks) {
  let out = "";
  let group = "";
  const flush = () => { if (group) { out += `<div class="v2-wire-row">${group}</div>`; group = ""; } };
  for (const b of blocks) {
    if (["field", "check", "radio", "btn"].includes(b.t)) group += wireBlock(b);
    else { flush(); out += wireBlock(b); }
  }
  flush();
  return out || `<p class="v2-wire-hint">Состав формы строится в V1 динамически — в статической разметке его нет.</p>`;
}

export function linkList(screen, structure, objectId) {
  const items = [];
  const menus = (structure?.menu || []).filter((m) => !m.danger);
  if (menus.length) {
    for (const m of menus) {
      const href = v1Href({ ...screen, ws: screen.ws, view: screen.view }, { menu: [m] }, objectId);
      items.push(`<a class="v2-btn v2-primary v2-link-btn" href="${esc(href)}" data-v1-link="${esc(m.id)}">Открыть в текущем интерфейсе${menus.length > 1 ? `: ${esc(m.label)}` : ""} →</a>`);
    }
  } else {
    items.push(`<a class="v2-btn v2-primary v2-link-btn" href="${esc(v1Href(screen, structure, objectId))}" data-v1-link="main">Открыть в текущем интерфейсе →</a>`);
  }
  return items.join(" ");
}

export function mountScreenView(el, { screen, structure, objectId, rights, groupTitle }) {
  el.className = "v2-page";
  const modals = structure?.modals || [];
  const showModals = screen.skeleton === undefined ? modals : modals.filter((m) => screen.skeleton.includes(m.id));
  const regions = (structure?.regions || []).filter((r) => r.structure?.length);
  const menuPath = (structure?.menu || []).map((m) => ["Действия", ...m.path, m.label].join(" › "));
  const toolbar = (structure?.toolbar || []).map((t) => `«${esc(t.text || t.id)}»`);
  const feats = [...(structure?.menu_features || []), ...(screen.feature || [])]
    .map(([names, kind]) => `${(Array.isArray(names) ? names : [names]).join(" / ")}: ${kind === "read" ? "чтение" : "изменение"}`);
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head">
        <h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-${screen.status >= 4 ? "ok" : "warn"}" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span>
      </div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note">
        <strong>Эта функция пока работает только в текущем интерфейсе.</strong>
        Здесь показан состав экрана по его форме в V1 — данные не загружаются, кнопки неактивны, ничего не сохраняется.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div>
      </div>
      <dl class="v2-facts">
        <dt>Где в текущем интерфейсе</dt><dd>${[...menuPath.map(esc), ...toolbar.map((t) => `Панель: ${t}`)].join("<br>") || "—"}</dd>
        <dt>Права</dt><dd>${feats.length ? esc(feats.join("; ")) : "без ограничения по разделам"}</dd>
        <dt>Что можно изменить</dt><dd>${esc(RISK_TEXT[screen.risk] || screen.risk)}${screen.ops ? ` — ${esc(screen.ops)}` : ""}</dd>
      </dl>
      ${showModals.length ? `<h3 class="v2-wire-title">Состав экрана в V1</h3>
        ${showModals.map((m, i) => `<details class="v2-wire" ${i === 0 ? "open" : ""}>
          <summary>${esc(m.title || m.id)}${m.tabs?.length ? ` <span class="v2-muted">· вкладки: ${esc(m.tabs.join(", "))}</span>` : ""}</summary>
          <div class="v2-wire-body" aria-disabled="true">${wireBlocks(m.structure || [])}</div></details>`).join("")}` : ""}
      ${screen.wire?.length ? `<h3 class="v2-wire-title">Состав экрана в V1</h3>
        <details class="v2-wire" open><summary>Описание функции <span class="v2-muted">· источник: ${esc(screen.wire_src || "описание функции")}</span></summary>
          <div class="v2-wire-body" aria-disabled="true">${wireBlocks(screen.wire)}</div></details>` : ""}
      ${structure?.dynamic?.length ? `<details class="v2-wire"><summary>Содержимое, которое V1 строит скриптом <span class="v2-muted">· извлечено из шаблонов, может быть неполным</span></summary>
          <div class="v2-wire-body" aria-disabled="true">${wireBlocks(structure.dynamic)}</div></details>` : ""}
      ${regions.length ? `<h3 class="v2-wire-title">Области рабочего места в V1</h3>
        ${regions.map((r) => `<details class="v2-wire"><summary>${esc(r.id)}</summary><div class="v2-wire-body" aria-disabled="true">${wireBlocks(r.structure)}</div></details>`).join("")}` : ""}
    </div>`;
  return { hasUnsavedChanges: () => false, guardLeave: async () => true };
}

export function mountHome(el, { registry, allowed, hiddenCount, go }) {
  el.className = "v2-page";
  const groups = registry.groups.filter((g) => g.id !== "home");
  const cards = groups.map((g) => {
    const items = registry.screens.filter((s) => s.group === g.id && allowed(s));
    if (!items.length) return "";
    return `<section class="v2-card">
      <h3>${esc(g.title)} <span class="v2-muted">· ${items.length}</span></h3>
      <ul class="v2-card-list">${items.map((s) => `<li><a class="v2-link" href="#/${esc(s.id)}" data-screen-link="${esc(s.id)}">${esc(s.title)}</a>
        ${s.impl.startsWith("module:") ? `<span class="v2-chip v2-chip-ok" title="${esc(STATUS_LABEL[s.status])}">в V2</span>` : s.impl.endsWith("-edit") ? `<span class="v2-chip v2-chip-ok" title="Правится в новом интерфейсе">правка</span>` : s.impl === "read" ? `<span class="v2-chip" title="Просмотр в новом интерфейсе, изменение — в текущем">просмотр</span>` : `<span class="v2-chip" title="Функции работают в текущем интерфейсе">в V1</span>`}</li>`).join("")}</ul>
    </section>`;
  }).join("");
  const total = registry.screens.filter((s) => allowed(s)).length;
  const inV2 = registry.screens.filter((s) => allowed(s) && s.impl.startsWith("module:")).length;
  el.innerHTML = `<div class="v2-container">
    <h2 class="v2-home-title">Новый интерфейс · предварительная версия</h2>
    <p class="v2-muted">Все разделы сервиса доступны отсюда. Разделы с пометкой «в V2» работают в новом интерфейсе;
      остальные показывают состав экрана и открывают нужную форму в текущем интерфейсе (пометка «в V1»).
      Доступно вам: ${total} разделов, из них в новом интерфейсе — ${inV2}.${hiddenCount ? ` Скрыто по правам: ${hiddenCount}.` : ""}</p>
    <div class="v2-cards">${cards}</div>
  </div>`;
  el.querySelectorAll("[data-screen-link]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); go(a.dataset.screenLink);
  }));
  return { hasUnsavedChanges: () => false, guardLeave: async () => true };
}
