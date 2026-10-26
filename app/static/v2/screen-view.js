// Общие экраны оболочки V2: начальная страница и каркас экрана, ещё не перенесённого в V2.
//
// Каркас строится из статической разметки соответствующей формы V1 (scripts/inventory_v1_ui.py):
// заголовки, вкладки, поля, таблицы (заголовки колонок), кнопки. Динамическое содержимое V1 (строки таблиц,
// варианты списков) в разметке не видно и НЕ выдумывается. Все элементы каркаса неактивны, а над ним прямым
// текстом сказано: функция работает только в интерфейсе V1, здесь показан состав экрана — так что
// ложного успеха и непроверенных запросов нет. Данные не показываются вовсе (демо-режима нет).
import { STATUS_LABEL, v1Href, statusChip } from "./registry.js";
import { GROUPINGS, homeCards, effectiveLayout } from "./home-groups.js";
import { showConfirmDialog } from "./dialogs.js";

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

const BLOCKED_HINT = "Пока доступно только в интерфейсе V1";

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

// Ссылка «Открыть в интерфейсе V1» нужна, только когда функции в V2 нет или она отключена: у перенесённых разделов
// (статус реестра 4+, реализация не «v1») её нет (2026-10-21, запрос пользователя). `force` — места, где V1 остаётся
// единственным путём: каркас неперенесённого раздела и пояснение об отключённых в V2 операциях.
export function linkList(screen, structure, objectId, { force = false } = {}) {
  if (!force && !inV1Only(screen)) return "";
  const items = [];
  const menus = (structure?.menu || []).filter((m) => !m.danger);
  if (menus.length) {
    for (const m of menus) {
      const href = v1Href({ ...screen, ws: screen.ws, view: screen.view }, { menu: [m] }, objectId);
      items.push(`<a class="v2-btn v2-primary v2-link-btn" href="${esc(href)}" data-v1-link="${esc(m.id)}">Открыть в интерфейсе V1${menus.length > 1 ? `: ${esc(m.label)}` : ""} →</a>`);
    }
  } else {
    items.push(`<a class="v2-btn v2-primary v2-link-btn" href="${esc(v1Href(screen, structure, objectId))}" data-v1-link="main">Открыть в интерфейсе V1 →</a>`);
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
        ${statusChip(screen)}
      </div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note">
        <strong>Эта функция пока работает только в интерфейсе V1.</strong>
        Здесь показан состав экрана по его форме в V1 — данные не загружаются, кнопки неактивны, ничего не сохраняется.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId, { force: true })}</div>
      </div>
      <dl class="v2-facts">
        <dt>Где в интерфейсе V1</dt><dd>${[...menuPath.map(esc), ...toolbar.map((t) => `Панель: ${t}`)].join("<br>") || "—"}</dd>
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

// Раздел, который V2 не строит сам, а показывает описанием с переходом в V1 (`mountScreenView`), — только такие помечаются «в V1».
const inV1Only = (s) => s.impl === "v1" || (s.status || 0) <= 2;

// Пометка — по статусу реестра, а не по типу реализации: прежняя проверка по префиксу `impl` помечала «в V1» два десятка разделов,
// давно работающих в V2 (рабочие места, карта, контракты, документы контрактации, график СМР, служебные экраны).
function homeChip(s) {
  if (inV1Only(s)) return `<span class="v2-chip" title="Функции раздела пока работают в интерфейсе V1">в V1</span>`;
  return "";   // статусные плашки «в V2 / не всё / заблокирован» убраны (2026-09-30)
}

function ruPlural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  return n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? few : many;
}

export function mountHome(el, { registry, allowed, hiddenByType = 0, hiddenByRights = 0, go, prefsStore, api = null, isAdmin = false }) {
  el.className = "v2-page";
  const allowedItems = registry.screens.filter((s) => s.listed !== false && allowed(s));
  const listed = registry.screens.filter((s) => s.listed !== false && s.group !== "home");
  const titleOf = new Map(listed.map((s) => [s.id, s.title]));
  let grouping = prefsStore?.getHomeGrouping() ?? "kind";   // личная настройка, хранится на сервере (shell-prefs.js)
  // Раскладка «по процессам» общая для всех и хранится на сервере (app/home_layout.py); править её может только администратор.
  let savedLayout = null;
  let draft = null, draftBase = "";   // правка в режиме «Настройка»: { cards: [{ id, title, items }] }
  let busy = false, note = "";
  const canEdit = !!(isAdmin && api);
  const cardsHtml = () => homeCards(grouping, registry.groups, allowedItems, effectiveLayout(savedLayout, registry.groups, listed)).map((c) => `<section class="v2-card">
      <h3>${esc(c.title)} <span class="v2-muted">· ${c.items.length}</span></h3>
      <ul class="v2-card-list">${c.items.map((s, i) => `${c.labels.has(i) ? `<li class="v2-card-kind">${esc(c.labels.get(i))}</li>` : ""}<li><a class="v2-link" href="#/${esc(s.id)}" data-screen-link="${esc(s.id)}">${esc(s.title)}</a>
        ${homeChip(s)}</li>`).join("")}</ul>
    </section>`).join("");
  // Режим «Настройка»: те же блоки, но с перетаскиванием пунктов (мышью) и кнопками ▲▼ (с клавиатуры), названием блока в поле,
  // удалением пустого блока и добавлением нового. Показываются ВСЕ разделы реестра — и те, что скрыты правами или типом объекта.
  const availableIds = new Set(allowedItems.map((s) => s.id));
  const editHtml = () => draft.cards.map((c, ci) => `<section class="v2-card v2-card-edit" data-card="${esc(c.id)}">
      <h3><input class="v2-card-title" data-card-title="${ci}" value="${esc(c.title)}" maxlength="80" aria-label="Название блока"> <span class="v2-muted">· ${c.items.length}</span>
        ${c.items.length ? "" : `<button type="button" class="v2-btn v2-card-del" data-card-del="${ci}">Удалить блок</button>`}</h3>
      <ul class="v2-card-list v2-card-drop" data-drop="${ci}">${c.items.length ? c.items.map((id, ii) => `<li draggable="true" data-item="${esc(id)}" class="${availableIds.has(id) ? "" : "v2-card-off"}"
          title="${availableIds.has(id) ? "" : "Сейчас скрыт по правам или типу объекта — у пользователей его видно по их правам"}">
          <span class="v2-grip" aria-hidden="true">⠿</span><span class="v2-card-name">${esc(titleOf.get(id) || id)}</span>
          <span class="v2-card-move"><button type="button" class="v2-btn" data-move="${ci}:${ii}:-1" aria-label="Выше">▲</button><button type="button" class="v2-btn" data-move="${ci}:${ii}:1" aria-label="Ниже">▼</button></span></li>`).join("")
        : `<li class="v2-card-empty">Блок пуст — перетащите сюда раздел</li>`}</ul></section>`).join("");
  const mine = registry.screens.filter((s) => allowed(s) && s.group !== "home" && s.listed !== false);
  const inV2 = mine.filter((s) => !inV1Only(s)).length;
  const full = mine.filter((s) => !inV1Only(s) && s.status === 5).length;
  el.innerHTML = `<div class="v2-container">
    <div class="v2-home-head">
      <h2 class="v2-home-title">Действия</h2>
      <div class="v2-home-grouping"><span class="v2-muted">Группировка</span>
        <div class="v2-seg" role="group" aria-label="Группировка разделов">${GROUPINGS.map((g) => `<button type="button" data-grouping="${g.id}" aria-pressed="${g.id === grouping}">${g.label}</button>`).join("")}</div>
        ${canEdit ? `<button type="button" class="v2-btn" id="home-edit" hidden title="Только для администратора: блоки, их состав и порядок — общие для всех">Настройка</button>` : ""}
      </div>
    </div>
    <div class="v2-home-editbar" id="home-editbar" hidden></div>
    <p class="v2-muted" id="home-lead">Все разделы сервиса — здесь и в левой навигации. Доступно вам: ${mine.length} ${ruPlural(mine.length, "раздел", "раздела", "разделов")}.${hiddenByRights ? ` Скрыто по правам: ${hiddenByRights}.` : ""}${hiddenByType ? ` Не относятся к типу текущего объекта: ${hiddenByType}.` : ""}</p>
    <div class="v2-cards"></div>
  </div>`;
  const cardsEl = el.querySelector(".v2-cards");
  const editBtn = el.querySelector("#home-edit");
  const barEl = el.querySelector("#home-editbar");
  const leadEl = el.querySelector("#home-lead");
  const dirty = () => !!draft && JSON.stringify(draft) !== draftBase;
  const wireCards = () => cardsEl.querySelectorAll("[data-screen-link]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); go(a.dataset.screenLink);
  }));
  const drawBar = () => {
    barEl.hidden = !draft;
    leadEl.hidden = !!draft;
    if (!draft) return;
    barEl.innerHTML = `<span class="v2-muted">Настройка страницы: перетаскивайте разделы между блоками и внутри блока (или кнопками ▲▼), переименовывайте блоки. Раскладка общая для всех пользователей.</span>
      <div class="v2-inline"><button type="button" class="v2-btn" id="home-add">+ Блок</button>
        <button type="button" class="v2-btn" id="home-reset" ${busy ? "disabled" : ""}>Вернуть исходную</button>
        <button type="button" class="v2-btn" id="home-cancel" ${busy ? "disabled" : ""}>Отмена</button>
        <button type="button" class="v2-btn v2-primary" id="home-save" ${busy || !dirty() ? "disabled" : ""}>Сохранить</button></div>
      <span class="v2-muted" id="home-note" role="status" aria-live="polite">${esc(note)}</span>`;
    barEl.querySelector("#home-add").addEventListener("click", () => {
      draft.cards.push({ id: "c-" + Date.now().toString(36), title: "Новый блок", items: [] });
      drawCards();
      const last = cardsEl.querySelector(".v2-card-edit:last-child .v2-card-title");
      last?.focus(); last?.select();
    });
    barEl.querySelector("#home-cancel").addEventListener("click", () => leaveEdit());
    barEl.querySelector("#home-save").addEventListener("click", () => saveDraft());
    barEl.querySelector("#home-reset").addEventListener("click", () => resetLayout());
  };
  const moveItem = (from, to) => {   // from: {ci, ii}; to: {ci, ii} — позиция вставки в целевой блок ПОСЛЕ изъятия
    const [id] = draft.cards[from.ci].items.splice(from.ii, 1);
    draft.cards[to.ci].items.splice(Math.max(0, Math.min(to.ii, draft.cards[to.ci].items.length)), 0, id);
    drawCards();
  };
  const wireEdit = () => {
    cardsEl.querySelectorAll("[data-card-title]").forEach((inp) => inp.addEventListener("input", () => {
      draft.cards[Number(inp.dataset.cardTitle)].title = inp.value;
      barEl.querySelector("#home-save").disabled = busy || !dirty();
    }));
    cardsEl.querySelectorAll("[data-card-del]").forEach((b) => b.addEventListener("click", () => {
      draft.cards.splice(Number(b.dataset.cardDel), 1);
      drawCards();
    }));
    cardsEl.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => {
      const [ci, ii, d] = b.dataset.move.split(":").map(Number);
      const cards = draft.cards;
      if (d < 0 && ii === 0) {   // выше первого — в конец предыдущего блока
        if (ci > 0) moveItem({ ci, ii }, { ci: ci - 1, ii: cards[ci - 1].items.length });
      } else if (d > 0 && ii === cards[ci].items.length - 1) {   // ниже последнего — в начало следующего
        if (ci < cards.length - 1) moveItem({ ci, ii }, { ci: ci + 1, ii: 0 });
      } else moveItem({ ci, ii }, { ci, ii: ii + d });
    }));
    // Перетаскивание мышью: пункт кладётся перед тем, над кем отпущен (по верхней/нижней половине), или в конец блока.
    let drag = null;
    const clearMarks = () => cardsEl.querySelectorAll(".v2-drop-before, .v2-drop-after, .v2-drop-end").forEach((x) => x.classList.remove("v2-drop-before", "v2-drop-after", "v2-drop-end"));
    cardsEl.querySelectorAll("li[draggable]").forEach((li) => {
      const ul = li.parentElement, ci = Number(ul.dataset.drop), ii = [...ul.children].indexOf(li);
      li.addEventListener("dragstart", (e) => { drag = { ci, ii }; li.classList.add("v2-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", li.dataset.item); });
      li.addEventListener("dragend", () => { drag = null; li.classList.remove("v2-dragging"); clearMarks(); });
      li.addEventListener("dragover", (e) => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        clearMarks(); li.classList.add(after ? "v2-drop-after" : "v2-drop-before");
      });
      li.addEventListener("drop", (e) => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        let target = ii + (after ? 1 : 0);
        if (drag.ci === ci && drag.ii < target) target -= 1;   // индекс сдвигается из-за изъятия
        const from = drag; drag = null; moveItem(from, { ci, ii: target });
      });
    });
    cardsEl.querySelectorAll("ul[data-drop]").forEach((ul) => {
      ul.addEventListener("dragover", (e) => { if (!drag) return; e.preventDefault(); clearMarks(); ul.classList.add("v2-drop-end"); });
      ul.addEventListener("drop", (e) => {
        if (!drag) return;
        e.preventDefault();
        const ci = Number(ul.dataset.drop), from = drag; drag = null;
        moveItem(from, { ci, ii: draft.cards[ci].items.length - (from.ci === ci ? 1 : 0) });
      });
    });
  };
  const drawCards = () => {
    if (draft) { cardsEl.innerHTML = editHtml(); wireEdit(); drawBar(); return; }
    cardsEl.innerHTML = cardsHtml(); wireCards();
  };
  const syncMode = () => {
    if (editBtn) editBtn.hidden = grouping !== "process" || !!draft;
    drawBar();
  };
  const enterEdit = () => {
    draft = { cards: effectiveLayout(savedLayout, registry.groups, listed).cards.map((c) => ({ id: c.id, title: c.title, items: [...c.items] })) };
    draftBase = JSON.stringify(draft); note = "";
    syncMode(); drawCards();
  };
  const leaveEdit = async () => {
    if (dirty() && !(await showConfirmDialog("Изменения раскладки не сохранены. Выйти без сохранения?", { confirmLabel: "Выйти без сохранения", danger: true }))) return;
    draft = null; note = ""; syncMode(); drawCards();
  };
  const saveDraft = async () => {
    const titles = draft.cards.map((c) => c.title.trim());
    if (titles.some((t) => !t)) { note = "У каждого блока должно быть название."; drawBar(); return; }
    busy = true; note = "Сохраняю…"; drawBar();
    try {
      const r = await api.put("/home-layout", { cards: draft.cards.map((c, i) => ({ id: c.id, title: titles[i], items: c.items })) });
      savedLayout = r.layout; draft = null; note = "";
    } catch (err) { note = err?.detail || err?.message || "Не удалось сохранить"; }
    busy = false; syncMode(); drawCards();
  };
  const resetLayout = async () => {
    if (!(await showConfirmDialog("Вернуть исходную раскладку? Блоки и порядок, настроенные администратором, будут потеряны — у всех пользователей.", { confirmLabel: "Вернуть исходную", danger: true }))) return;
    busy = true; drawBar();
    try { await api.delete("/home-layout"); savedLayout = null; draft = null; note = ""; }
    catch (err) { note = err?.detail || err?.message || "Не удалось сбросить"; }
    busy = false; syncMode(); drawCards();
  };
  syncMode(); drawCards();
  editBtn?.addEventListener("click", enterEdit);
  el.querySelectorAll("[data-grouping]").forEach((b) => b.addEventListener("click", async () => {
    if (draft && b.dataset.grouping !== "process") { if (dirty() && !(await showConfirmDialog("Изменения раскладки не сохранены. Выйти без сохранения?", { confirmLabel: "Выйти без сохранения", danger: true }))) return; draft = null; }
    grouping = b.dataset.grouping;
    prefsStore?.setHomeGrouping(grouping);
    el.querySelectorAll("[data-grouping]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    syncMode(); drawCards();
  }));
  // Сохранённую раскладку подтягиваем отдельно, не задерживая страницу: до ответа показана исходная.
  if (api) api.get("/home-layout").then((r) => { savedLayout = r?.layout || null; if (!draft) drawCards(); }).catch(() => { /* без раскладки остаётся исходная */ });
  return {
    hasUnsavedChanges: () => dirty(),
    guardLeave: async () => !dirty() || showConfirmDialog("Изменения раскладки страницы «Действия» не сохранены. Уйти без сохранения?", { confirmLabel: "Уйти без сохранения", danger: true }),
  };
}
