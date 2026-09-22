// Выбор объекта в шапке V2 (2026-09-22, задача «shell»): кнопка текущего объекта открывает окно выбора —
// поиск, «Закреплённые» сверху, затем «С данными», ниже свёрнутая по умолчанию «Без модели», иерархия
// проект → объект. Группировка и сортировка — ТО ЖЕ правило, что в V1 (app/static/app.js, renderObjectSwitchList:
// сначала проекты, где есть хоть один объект с загруженными элементами, — повторено здесь один в один, только
// разметка и стили свои, V2); архивные объекты — то же правило видимости V1 (objectSwitchArchived/objectSwitchVisible).
//
// Модуль не решает САМ, можно ли сменить объект (несохранённые данные активного раздела) — это делает вызывающий
// код (main.js::changeObject, тот же сторож, что у смены раздела): picker вызывает onSelect(id) и закрывается,
// только если тот вернул true; вернул false (отказ «Остаться») — окно остаётся открытым на месте, ничего не потеряно.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STATUS_LABEL = { active: "в работе", perspective: "перспективный", suspended: "приостановлен", completed: "завершён", archived: "архив" };
const ARCHIVED_KEY = "zhbi.v2.objectPicker.archived";
function readArchivedPref() { try { return localStorage.getItem(ARCHIVED_KEY) === "1"; } catch (e) { return false; } }
function writeArchivedPref(v) { try { localStorage.setItem(ARCHIVED_KEY, v ? "1" : "0"); } catch (e) { /* приватный режим — переживёт только сеанс */ } }

let openInstance = null; // один экземпляр на приложение — второй вызов при открытом первом просто фокусирует его

/** @param {{tree:{projects:Array}, objectId:number|null, prefsStore, onSelect:(id:number)=>Promise<boolean>, triggerEl:HTMLElement}} opts */
export function openObjectPicker(opts) {
  if (openInstance) { openInstance.el.querySelector("#v2-objpick-search")?.focus(); return; }
  const { tree, prefsStore, onSelect, triggerEl } = opts;
  let objectId = opts.objectId;

  // Плоский индекс проект+объект — ВКЛЮЧАЯ архивные (видимость решает чекбокс, а не сам индекс); строится один
  // раз на открытие окна, не на каждое нажатие клавиши.
  const index = [];
  for (const project of tree.projects || []) {
    for (const object of project.objects || []) {
      index.push({ project, object, key: [object.name, project.name, object.address, project.address].filter(Boolean).join(" ").toLowerCase() });
    }
  }
  const byId = new Map(index.map((r) => [r.object.id, r]));

  // Закреплённые, которых в дереве больше нет (объект удалён/стал недоступен), тихо выпадают из списка сами —
  // и сообщаются хранилищу настроек, чтобы не таскать их в JSON бесконечно (см. shell-prefs.js::prunePinned).
  prefsStore.prunePinned(new Set(index.map((r) => r.object.id)));

  let query = "";
  let showArchived = readArchivedPref();
  let expandedProjects = new Set();     // сеансовое — какие МНОГООБЪЕКТНЫЕ проекты раскрыты
  let emptySectionOpen = false;         // «Без модели» — свёрнута по умолчанию (п.1 задания)
  let kbIndex = -1;

  // ТОЛЬКО правило видимости архивных (objectSwitchVisible из V1) — поиск НЕ здесь: render() ниже сам
  // нормализует запрос (trim+toLowerCase) в `q` и фильтрует по нему отдельно; дублирование здесь по
  // НЕнормализованному `query` теряло совпадения при другом регистре введённого текста (найдено проверкой).
  function visible(row) {
    const objStatus = row.object.status || "active";
    const projStatus = row.project.status || "active";
    return showArchived || (objStatus !== "archived" && projStatus !== "archived");
  }

  const backdrop = document.createElement("div");
  backdrop.className = "v2-dialog-backdrop";
  backdrop.innerHTML = `
    <div class="v2-dialog v2-objpick" role="dialog" aria-modal="true" aria-label="Выбор объекта">
      <div class="v2-objpick-head">
        <input type="search" id="v2-objpick-search" class="v2-search" placeholder="Название объекта, проекта или адрес" aria-label="Поиск объекта" autocomplete="off">
        <label class="v2-objpick-archived"><input type="checkbox" id="v2-objpick-arch"> Показывать архивные</label>
      </div>
      <div class="v2-objpick-list" id="v2-objpick-list" role="listbox" aria-label="Объекты"></div>
      <div class="v2-objpick-foot">
        <span class="v2-muted" id="v2-objpick-total"></span>
        <button type="button" class="v2-btn" id="v2-objpick-close">Закрыть</button>
      </div>
    </div>`;
  const dialog = backdrop.querySelector(".v2-objpick");
  const search = backdrop.querySelector("#v2-objpick-search");
  const archCb = backdrop.querySelector("#v2-objpick-arch");
  const list = backdrop.querySelector("#v2-objpick-list");
  const total = backdrop.querySelector("#v2-objpick-total");
  archCb.checked = showArchived;

  function rowHtml(row, { showProject = false, pinned = false } = {}) {
    const o = row.object, p = row.project;
    const status = o.status || "active";
    const full = showProject ? `${p.name} · ${o.name}` : o.name;
    const isPinned = prefsStore.isPinnedObject(o.id);
    return `<div class="v2-objpick-row${o.id === objectId ? " active" : ""}" data-row-id="${o.id}">
      <button type="button" class="v2-objpick-item" data-object-id="${o.id}" role="option" aria-selected="${o.id === objectId}"
              title="${esc(`${p.name} · ${o.name}${o.address ? " — " + o.address : ""}`)}">
        <span class="v2-objpick-check" aria-hidden="true">${o.id === objectId ? "✓" : ""}</span>
        <span class="v2-status-dot" data-dot="${esc(status)}" title="${esc(STATUS_LABEL[status] || status)}"></span>
        <span class="v2-tree-name">${esc(full)}</span>
        ${status !== "active" ? `<span class="v2-objpick-badge">${esc(STATUS_LABEL[status] || status)}</span>` : ""}
        <span class="v2-tree-count">${o.elements ? o.elements : "пусто"}</span>
      </button>
      <button type="button" class="v2-objpick-pin" data-pin-id="${o.id}" aria-pressed="${isPinned}"
              title="${isPinned ? "Открепить объект" : "Закрепить объект"}" aria-label="${isPinned ? "Открепить объект" : "Закрепить объект"}">${isPinned ? "★" : "☆"}</button>
    </div>`;
  }

  function projectGroupHtml(rows) {
    // Один объект в проекте — без сворачиваемого заголовка (то же упрощение, что в V1: название проекта на
    // реальных данных обычно совпадает с названием единственного объекта внутри).
    if (rows.length === 1) return rowHtml(rows[0]);
    const project = rows[0].project;
    // Правило V1 (renderObjectSwitchList): раскрыт при поиске, если пользователь сам раскрыл раньше, ИЛИ если
    // ТЕКУЩИЙ объект внутри этого проекта — иначе открыв окно выбора, человек первым делом видел бы свой же
    // текущий проект свёрнутым.
    const open = !!query || expandedProjects.has(project.id) || rows.some((r) => r.object.id === objectId);
    return `<div class="v2-objpick-project">
      <button type="button" class="v2-objpick-project-head" data-toggle-project="${project.id}" aria-expanded="${open}">
        <span class="v2-tree-chevron" aria-hidden="true">${open ? "▾" : "▸"}</span>
        <span class="v2-tree-name">${esc(project.name)}${project.address ? ` <span class="v2-muted">· ${esc(project.address)}</span>` : ""}</span>
        <span class="v2-tree-count">${rows.length}</span>
      </button>
      ${open ? rows.map((r) => rowHtml(r)).join("") : ""}
    </div>`;
  }

  function render() {
    const q = query.trim().toLowerCase();
    const visRows = index.filter((r) => visible(r) && (!q || r.key.includes(q)));
    const pinnedIds = new Set(prefsStore.get().pinnedObjects);
    const pinnedRows = visRows.filter((r) => pinnedIds.has(r.object.id))
      .sort((a, b) => prefsStore.get().pinnedObjects.indexOf(a.object.id) - prefsStore.get().pinnedObjects.indexOf(b.object.id));
    const restRows = visRows.filter((r) => !pinnedIds.has(r.object.id));

    // Группы по проектам — «С данными» / «Без модели», порядок и критерий ОДИН В ОДИН с V1 (см. шапку файла).
    const byProject = [];
    for (const project of tree.projects || []) {
      const rows = restRows.filter((r) => r.project === project);
      if (!rows.length) continue;
      byProject.push({ project, rows, hasData: rows.some((r) => (r.object.elements || 0) > 0) });
    }
    const withData = byProject.filter((g) => g.hasData);
    const withoutData = byProject.filter((g) => !g.hasData);

    let html = "";
    if (pinnedRows.length) {
      html += `<div class="v2-objpick-section-title">Закреплённые</div>`;
      html += pinnedRows.map((r) => rowHtml(r, { showProject: true, pinned: true })).join("");
    }
    if (withData.length) {
      html += `<div class="v2-objpick-section-title">С данными</div>`;
      html += withData.map((g) => projectGroupHtml(g.rows)).join("");
    }
    if (withoutData.length) {
      // Текущий объект внутри «Без модели» (открыли окно, стоя на пустом объекте) — та же логика, что у
      // авторазворачивания проекта чуть выше: свой текущий объект не должен прятаться за лишним кликом.
      const openEmpty = !!q || emptySectionOpen || withoutData.some((g) => g.rows.some((r) => r.object.id === objectId));
      html += `<button type="button" class="v2-objpick-section-title v2-objpick-section-toggle" id="v2-objpick-empty-toggle" aria-expanded="${openEmpty}">
        <span class="v2-tree-chevron" aria-hidden="true">${openEmpty ? "▾" : "▸"}</span>Без модели <span class="v2-muted">· ${withoutData.reduce((n, g) => n + g.rows.length, 0)}</span>
      </button>`;
      if (openEmpty) html += withoutData.map((g) => projectGroupHtml(g.rows)).join("");
    }
    if (!visRows.length) {
      html = `<p class="v2-muted v2-objpick-empty">${q ? "Ничего не найдено." + (showArchived ? "" : " Возможно, объект в архиве.") : "Объектов пока нет."}</p>`;
    }
    list.innerHTML = html;
    total.textContent = visRows.length ? `${visRows.length} из ${index.length}` : "";
    kbIndex = -1;
    bindListEvents();
  }

  function items() { return [...list.querySelectorAll(".v2-objpick-item")]; }
  function moveKb(step) {
    const its = items();
    if (!its.length) return;
    its.forEach((b) => b.classList.remove("kb-focus"));
    kbIndex = kbIndex < 0 ? (step > 0 ? 0 : its.length - 1) : (kbIndex + step + its.length) % its.length;
    const target = its[kbIndex];
    target.classList.add("kb-focus");
    target.scrollIntoView({ block: "nearest" });
  }

  async function pick(id) {
    const ok = await onSelect(id);
    if (ok) { objectId = id; close(); }
    else render(); // отказ («Остаться») — окно и весь ввод в нём (поиск, раскрытые группы) остаются как были
  }

  function bindListEvents() {
    list.querySelectorAll("[data-toggle-project]").forEach((b) => b.addEventListener("click", () => {
      const id = Number(b.dataset.toggleProject);
      if (expandedProjects.has(id)) expandedProjects.delete(id); else expandedProjects.add(id);
      render();
    }));
    list.querySelector("#v2-objpick-empty-toggle")?.addEventListener("click", () => { emptySectionOpen = !emptySectionOpen; render(); });
    list.querySelectorAll("[data-object-id]").forEach((b) => b.addEventListener("click", () => pick(Number(b.dataset.objectId))));
    list.querySelectorAll("[data-pin-id]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      prefsStore.togglePinnedObject(Number(b.dataset.pinId));
      render();
    }));
  }

  search.addEventListener("input", () => { query = search.value; render(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveKb(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveKb(-1); }
    else if (e.key === "Enter") { e.preventDefault(); const its = items(); const b = its[kbIndex] || its[0]; if (b) pick(Number(b.dataset.objectId)); }
  });
  archCb.addEventListener("change", () => { showArchived = archCb.checked; writeArchivedPref(showArchived); render(); });
  backdrop.querySelector("#v2-objpick-close").addEventListener("click", () => close());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      const focusables = [...dialog.querySelectorAll("input, button")].filter((n) => !n.disabled && n.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener("keydown", onKeydown, true);

  const previouslyFocused = document.activeElement;
  function close() {
    document.removeEventListener("keydown", onKeydown, true);
    if (backdrop.isConnected) document.body.removeChild(backdrop);
    openInstance = null;
    const back = triggerEl && document.contains(triggerEl) ? triggerEl : previouslyFocused;
    if (back && document.contains(back) && back.focus) back.focus();
  }

  document.body.appendChild(backdrop);
  render();
  search.focus();
  openInstance = { el: backdrop, close };
}
