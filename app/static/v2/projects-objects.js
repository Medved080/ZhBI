// V2: «Проекты и объекты» — дерево проект→объект слева, карточка справа.
// Те же эндпоинты, что у V1 (app/main.py: /projects, /objects, /smu,
// /individuals, /dictionaries/*), тот же уровень доступа: раздел целиком,
// включая чтение, открыт только при "projects":"write" — как в V1
// (index.html data-feature-kind="write" у пункта меню), отдельного
// read-only режима у этого экрана нет и в оригинале.
//
// Сознательно НЕ перенесено (см. отчёт по этапу): классификатор КЛАДР,
// автоопределение координат по адресу и мини-карта выбора точки —
// адрес и координаты здесь простые текстовые/числовые поля, без привязки
// к справочнику. Также не перенесены загрузка фото объекта и блок
// вложений. Всё это остаётся доступным в V1 через "Открыть в V1".
import { resolveDirty as sharedResolveDirty, showConfirmDialog, showInfoDialog } from "./dialogs.js";

const STATUS_LABELS = {
  perspective: "Перспективный", active: "В работе", suspended: "Приостановлен",
  completed: "Завершён", archived: "Архивный",
};
const STATUS_ORDER = ["active", "perspective", "suspended", "completed", "archived"];
const KIND_LABELS = { zhbi: "ЖБИ — изделия по чертежу", mfr: "МФР — блоки из модели" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function mountProjectsObjects(container, ctx) {
  const { api } = ctx;

  const state = {
    projects: [], objects: [], smuList: [], individualsList: [],
    loaded: false, loadError: null,
    selected: null, // {type:"project"|"object", id:number|null}
    expanded: new Set(),
    query: "", status: "active", smu: "", responsible: "",
    draft: null, dirty: false, isNew: false,
    status_msg: "", busy: false,
    // Задача 4 (2026-09-19): после мутации данные подтверждаются ОТВЕТОМ
    // самой записи (точечная вставка/замена в projects/objects), а не
    // повторным GET списков — GET нужен только чтобы подтянуть агрегаты,
    // которые клиент точно посчитать не может (objects_count/
    // elements_count). pendingListRefresh — функция ЭТОГО best-effort
    // обновления, если оно не удалось, чтобы кнопка "Повторить" читала
    // ровно то же самое, а не что-то заново придуманное.
    pendingListRefresh: null,
  };

  let currentDirty = null;
  function setDirty(info) { currentDirty = info; }
  function clearDirtyState() { currentDirty = null; }
  function hasUnsavedChanges() { return !!currentDirty; }
  async function resolveDirty(info) {
    return sharedResolveDirty(info, (err) => {
      state.status_msg = err?.detail || err?.message || "Не удалось сохранить";
    });
  }
  async function requestLeave() {
    if (!currentDirty) return true;
    const ok = await resolveDirty(currentDirty);
    if (ok) clearDirtyState();
    return ok;
  }

  let navGuardBusy = false;
  async function withNavGuard(fn) {
    if (navGuardBusy || api.hasPendingWrites()) return;
    navGuardBusy = true;
    try { await fn(); } finally { navGuardBusy = false; }
  }

  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container">
      <h2>Проекты и объекты</h2>
      <p class="v2-muted">Проект — группа объектов одной площадки. Все свойства, справочники и контракты живут внутри объекта; сроки СМР сводятся из объектов.</p>
    </div></div>
    <div id="po-body" class="v2-scroll"><div id="po-inner" class="v2-container"></div></div>
    <footer class="v2-foot"><div class="v2-container">
      <span id="po-status" class="v2-muted"></span><div class="v2-foot-actions" id="po-foot-actions"></div>
    </div></footer>
  `;
  const body = container.querySelector("#po-inner");
  const status = container.querySelector("#po-status");
  const footActions = container.querySelector("#po-foot-actions");

  function btn(label, attr = "", primary = false) {
    return `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" ${attr}>${label}</button>`;
  }

  async function fetchAllLists() {
    const [projects, objects, smuList, individualsList] = await Promise.all([
      api.get("/projects"), api.get("/objects"), api.get("/smu"), api.get("/individuals"),
    ]);
    return { projects, objects, smuList, individualsList };
  }

  async function ensureLoaded(force) {
    if (state.loaded && !force) return true;
    try {
      const r = await fetchAllLists();
      state.projects = r.projects; state.objects = r.objects;
      state.smuList = r.smuList; state.individualsList = r.individualsList;
      state.loaded = true; state.loadError = null;
      return true;
    } catch (err) {
      state.loadError = err?.detail || err?.message || "Не удалось загрузить данные";
      return false;
    }
  }

  // Best-effort обновление после мутации — НЕ источник подтверждения
  // сохранённых значений (тот приходит из ответа самой записи, задача 4),
  // а обновление агрегатов (objects_count/elements_count), которые нельзя
  // посчитать на клиенте. Сервер к этому моменту уже видел мутацию —
  // успешный ответ здесь не может "откатить" только что подтверждённые
  // значения, а неудача сюда не относится и не трогает то, что уже
  // подтверждено ответом записи.
  async function refreshListsBestEffort() {
    try {
      const r = await fetchAllLists();
      state.projects = r.projects; state.objects = r.objects;
      state.smuList = r.smuList; state.individualsList = r.individualsList;
      state.pendingListRefresh = null;
      return true;
    } catch (err) {
      state.pendingListRefresh = refreshListsBestEffort;
      return false;
    }
  }

  function objectsOf(projectId) { return state.objects.filter((o) => o.project_id === projectId); }

  function matches(rec, projectName) {
    if (state.status && rec.status !== state.status && !(state.status === "active" && !rec.status)) return false;
    if (rec.smu_id !== undefined) {
      if (state.smu && String(rec.smu_id || "") !== state.smu) return false;
      if (state.responsible && String(rec.responsible_id || "") !== state.responsible) return false;
    }
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [rec.name, rec.address, projectName].filter(Boolean).some((s) => String(s).toLowerCase().includes(q));
  }

  function selectedRecord() {
    if (!state.selected || state.selected.id == null) return null;
    const list = state.selected.type === "project" ? state.projects : state.objects;
    return list.find((r) => r.id === state.selected.id) || null;
  }

  async function selectNode(type, id, extra) {
    await withNavGuard(async () => {
      if (!(await requestLeave())) return;
      state.selected = { type, id };
      state.isNew = id == null;
      if (extra?.projectId) state.newObjectProjectId = extra.projectId;
      initDraft();
      state.status_msg = "";
      await render();
    });
  }

  function initDraft() {
    const rec = selectedRecord();
    if (state.selected?.type === "project") {
      state.draft = rec
        ? { name: rec.name, status: rec.status || "active", description: rec.description || "",
            address: rec.address || "", address_note: rec.address_note || "", lat: rec.lat ?? "", lon: rec.lon ?? "" }
        : { name: "", status: "active", description: "", address: "", address_note: "", lat: "", lon: "" };
    } else {
      state.draft = rec
        ? { name: rec.name, status: rec.status || "active", project_id: rec.project_id,
            kind: rec.kind || "zhbi", description: rec.description || "",
            smu_id: rec.smu_id ?? "", smu_director_id: rec.smu_director_id ?? "", responsible_id: rec.responsible_id ?? "",
            smr_start_reported: rec.smr_start_reported || "", media_url: rec.media_url || "",
            address: rec.address || "", address_note: rec.address_note || "", lat: rec.lat ?? "", lon: rec.lon ?? "" }
        : { name: "", status: "active", project_id: state.newObjectProjectId || (state.projects[0]?.id ?? ""),
            kind: "zhbi", description: "", smu_id: "", smu_director_id: "", responsible_id: "",
            smr_start_reported: "", media_url: "", address: "", address_note: "", lat: "", lon: "" };
    }
    state.dirty = false;
    clearDirtyState();
  }

  function markDirty() {
    state.dirty = true;
    setDirty({
      message: "В карточке есть несохранённые изменения.",
      save: saveOrThrow,
      discard: () => { initDraft(); },
    });
    renderFooter();
  }

  function renderFooter() {
    if (!state.dirty) { footActions.innerHTML = ""; return; }
    footActions.innerHTML = `${btn("Отменить", 'id="po-cancel"')}${btn("Сохранить", 'id="po-save"', true)}`;
    status.textContent = "Есть несохранённые изменения";
    footActions.querySelector("#po-cancel").addEventListener("click", async () => {
      initDraft();
      status.textContent = "";
      await renderForm();
    });
    footActions.querySelector("#po-save").addEventListener("click", async () => {
      const saveBtn = footActions.querySelector("#po-save");
      const cancelBtn = footActions.querySelector("#po-cancel");
      saveBtn.disabled = true; cancelBtn.disabled = true;
      setFormFieldsDisabled(true);
      try {
        await saveOrThrow();
        await render();
      } catch (err) {
        status.textContent = err?.detail || err?.message || "Не удалось сохранить";
        saveBtn.disabled = false; cancelBtn.disabled = false;
        setFormFieldsDisabled(false);
      }
    });
  }

  function setFormFieldsDisabled(disabled) {
    body.querySelectorAll("#po-form input, #po-form select, #po-form textarea").forEach((el) => { el.disabled = disabled; });
  }

  // Задача 4: запись подтверждена (см. saveOrThrow/удаление), а фоновое
  // обновление агрегатов — нет. Кнопка повторяет ТОЛЬКО чтение
  // (refreshListsBestEffort), никогда не переотправляет запись.
  function renderListRefreshRetry() {
    const old = footActions.parentElement.querySelector("#po-status-retry");
    if (old) old.remove();
    if (!state.pendingListRefresh) return;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.id = "po-status-retry";
    retryBtn.className = "v2-link";
    retryBtn.style.marginLeft = "8px";
    retryBtn.textContent = "Повторить обновление";
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      const ok = await state.pendingListRefresh();
      state.status_msg = ok ? "Обновлено." : "Обновить данные снова не удалось.";
      await render();
    });
    status.after(retryBtn);
  }

  async function saveOrThrow() {
    const type = state.selected.type;
    const wasNew = state.isNew;
    const snapshot = { ...state.draft };
    if (!snapshot.name || !snapshot.name.trim()) throw { message: "Укажите наименование" };
    const body = { name: snapshot.name.trim(), status: snapshot.status, description: snapshot.description.trim() || null,
      address: snapshot.address.trim() || null, address_note: snapshot.address_note.trim() || null,
      lat: snapshot.lat === "" ? null : Number(snapshot.lat), lon: snapshot.lon === "" ? null : Number(snapshot.lon) };
    if (type === "object") {
      Object.assign(body, {
        project_id: snapshot.project_id ? Number(snapshot.project_id) : null,
        kind: snapshot.kind, smu_id: snapshot.smu_id === "" ? null : Number(snapshot.smu_id),
        smu_director_id: snapshot.smu_director_id === "" ? null : Number(snapshot.smu_director_id),
        responsible_id: snapshot.responsible_id === "" ? null : Number(snapshot.responsible_id),
        smr_start_reported: snapshot.smr_start_reported || null, media_url: snapshot.media_url.trim() || null,
      });
    }
    const path = type === "project" ? "/projects" : "/objects";
    const saved = wasNew ? await api.post(path, body) : await api.patch(`${path}/${state.selected.id}`, body);
    // Задача 4: подтверждение — из ОТВЕТА записи (полный Project/ObjectOut),
    // без ожидания отдельного GET. Список — точечно: заменяем/добавляем ТУ
    // ЖЕ запись, поэтому даже при отказе фонового обновления агрегатов
    // ниже форма и дерево уже показывают подтверждённые, не старые данные.
    const list = type === "project" ? state.projects : state.objects;
    const idx = list.findIndex((r) => r.id === saved.id);
    if (idx === -1) list.push(saved); else list[idx] = saved;
    state.selected = { type, id: saved.id };
    state.isNew = false;
    state.dirty = false;
    clearDirtyState();
    const ok = await refreshListsBestEffort();
    state.status_msg = !ok ? "Сохранено, но обновить данные не удалось." : (wasNew ? "Добавлено." : "Сохранено.");
    initDraft();
  }

  function renderTree() {
    const rows = [];
    for (const p of state.projects) {
      const objs = objectsOf(p.id);
      const projectMatches = matches(p, p.name);
      const matchingObjects = objs.filter((o) => matches(o, p.name));
      const filterActive = !!(state.query || (state.status && state.status !== "active") || state.smu || state.responsible);
      if (!projectMatches && !matchingObjects.length) continue;
      const expanded = filterActive || state.expanded.has(p.id);
      const sel = state.selected?.type === "project" && state.selected.id === p.id;
      rows.push(`<div class="v2-tree-row">
        <button type="button" class="v2-tree-node v2-tree-project${sel ? " v2-tree-selected" : ""}" data-project="${p.id}">
          <span class="v2-tree-chevron">${expanded ? "▼" : "▶"}</span>
          <span class="v2-status-dot" data-dot="${p.status || "active"}"></span>
          <span class="v2-tree-name">${escapeHtml(p.name)}</span>
          <span class="v2-tree-count">${p.objects_count} · ${p.elements_count}</span>
        </button></div>`);
      if (expanded) {
        const toShow = state.query || state.smu || state.responsible || (state.status && state.status !== "active") ? matchingObjects : objs;
        for (const o of toShow) {
          const oSel = state.selected?.type === "object" && state.selected.id === o.id;
          rows.push(`<div class="v2-tree-row">
            <button type="button" class="v2-tree-node v2-tree-object${oSel ? " v2-tree-selected" : ""}" data-object="${o.id}">
              <span class="v2-status-dot" data-dot="${o.status || "active"}"></span>
              <span class="v2-tree-name">${escapeHtml(o.name)}</span>
              <span class="v2-tree-count">${o.elements_current || "пусто"}</span>
            </button></div>`);
        }
      }
    }
    if (!rows.length) {
      body.querySelector("#po-tree").innerHTML = `<p class="v2-note">${state.query ? "Ничего не найдено." : "Здесь пока пусто — заведите проект кнопкой ниже."}</p>`;
    } else {
      body.querySelector("#po-tree").innerHTML = rows.join("");
    }
    body.querySelectorAll("[data-project]").forEach((b) => b.addEventListener("click", () => {
      const id = Number(b.dataset.project);
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      if (state.selected?.type === "project" && state.selected.id === id) { renderTree(); return; }
      selectNode("project", id);
    }));
    body.querySelectorAll("[data-object]").forEach((b) => b.addEventListener("click", () => {
      selectNode("object", Number(b.dataset.object));
    }));
  }

  function fieldRow(label, inputHtml) {
    return `<label class="v2-field">${label}${inputHtml}</label>`;
  }

  function statusSelect(id, value, disabled) {
    return `<select id="${id}" ${disabled ? "disabled" : ""}>${STATUS_ORDER.map((s) =>
      `<option value="${s}" ${value === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}</select>`;
  }

  function refSelect(id, list, value, disabled, placeholder) {
    return `<select id="${id}" ${disabled ? "disabled" : ""}>
      <option value="">${placeholder}</option>
      ${list.map((r) => `<option value="${r.id}" ${String(value) === String(r.id) ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}
    </select>`;
  }

  async function renderForm() {
    const el = body.querySelector("#po-form");
    if (!state.selected) {
      el.innerHTML = `<p class="v2-note">Выберите проект или объект слева, чтобы посмотреть и поправить реквизиты.</p>`;
      return;
    }
    const type = state.selected.type;
    const d = state.draft;
    const canDelete = !state.isNew && (ctx.perms.isSystemAdmin || ctx.perms.dictDelete === "write");
    const title = state.isNew ? (type === "project" ? "Новый проект" : "Новый объект") : d.name;
    el.innerHTML = `
      <div class="v2-bar"><h3>${escapeHtml(title || (type === "project" ? "Проект" : "Объект"))}</h3>
        <div class="v2-inline">
          ${!state.isNew && type === "object" ? btn("Открыть в V1", 'id="po-open-v1"') : ""}
          ${canDelete ? btn("Удалить", 'id="po-delete"') : ""}
        </div></div>
      <div class="v2-group">Реквизиты</div>
      <div class="v2-fields">
        ${fieldRow("Наименование", `<input id="pf-name" value="${escapeHtml(d.name)}">`)}
        ${fieldRow("Статус", statusSelect("pf-status", d.status, false))}
        ${type === "object" ? fieldRow("Проект", refSelect("pf-project", state.projects, d.project_id, false, "— выберите проект —")) : ""}
        ${type === "object" ? fieldRow("Тип учёта", `<select id="pf-kind">${Object.entries(KIND_LABELS).map(([k, l]) =>
          `<option value="${k}" ${d.kind === k ? "selected" : ""}>${l}</option>`).join("")}</select>`) : ""}
        <label class="v2-field v2-span">Описание<textarea id="pf-description" rows="2">${escapeHtml(d.description)}</textarea></label>
      </div>
      ${type === "object" ? `
      <div class="v2-group">Реквизиты заказчика</div>
      <div class="v2-fields">
        ${fieldRow("СМУ", refSelect("pf-smu", state.smuList, d.smu_id, false, "— не выбрано —"))}
        ${fieldRow("Директор СМУ", refSelect("pf-smu-director", state.individualsList, d.smu_director_id, false, "— не выбрано —"))}
        ${fieldRow("Ответственный (ДП/РП)", refSelect("pf-responsible", state.individualsList, d.responsible_id, false, "— не выбрано —"))}
        ${fieldRow("Старт СМР", `<input id="pf-smr-start" type="date" value="${escapeHtml(d.smr_start_reported)}">`)}
        <label class="v2-field v2-span">Ссылка на фото/видео<input id="pf-media" value="${escapeHtml(d.media_url)}" placeholder="папка на Яндекс.Диске и т.п. — сервер её не скачивает"></label>
      </div>` : ""}
      <div class="v2-group">Адрес и координаты</div>
      <p class="v2-muted" style="margin:0 0 12px">Классификатор адресов, автоопределение координат и мини-карта пока доступны только в текущем интерфейсе — здесь адрес и координаты редактируются простыми полями.</p>
      <div class="v2-fields">
        <label class="v2-field v2-span">Адрес<input id="pf-address" value="${escapeHtml(d.address)}" placeholder="Населённый пункт, улица, дом"></label>
        <label class="v2-field v2-span">Уточнение<input id="pf-address-note" value="${escapeHtml(d.address_note)}" placeholder="Корпус, строение, участок, ориентир"></label>
        ${fieldRow("Широта", `<input id="pf-lat" type="number" step="0.000001" value="${escapeHtml(d.lat)}">`)}
        ${fieldRow("Долгота", `<input id="pf-lon" type="number" step="0.000001" value="${escapeHtml(d.lon)}">`)}
      </div>
      <div class="v2-auth-error" id="pf-error"></div>
    `;
    el.querySelectorAll("input, select, textarea").forEach((elm) => elm.addEventListener("input", markDirty));
    el.querySelectorAll("input, select").forEach((elm) => elm.addEventListener("change", () => {
      const key = { "pf-name": "name", "pf-status": "status", "pf-project": "project_id", "pf-kind": "kind",
        "pf-smu": "smu_id", "pf-smu-director": "smu_director_id", "pf-responsible": "responsible_id",
        "pf-smr-start": "smr_start_reported", "pf-media": "media_url", "pf-address": "address",
        "pf-address-note": "address_note", "pf-lat": "lat", "pf-lon": "lon" }[elm.id];
      if (key) state.draft[key] = elm.value;
    }));
    el.querySelector("#pf-description")?.addEventListener("input", (e) => { state.draft.description = e.target.value; });
    if (el.querySelector("#po-open-v1")) {
      el.querySelector("#po-open-v1").addEventListener("click", async () => {
        if (!(await requestLeave())) return;
        location.href = `/?ui=v1&object_id=${state.selected.id}`;
      });
    }
    if (el.querySelector("#po-delete")) {
      el.querySelector("#po-delete").addEventListener("click", () => withNavGuard(() => requestDelete(type, state.selected.id)));
    }
  }

  // Общий диалог V2 вместо системного confirm()/alert() и вместо
  // встроенного в форму блока (задача 7 — один и тот же визуальный язык
  // подтверждения, что и в "Контрагентах", где вложенность <details> не
  // оставляет места для инлайн-блока).
  async function requestDelete(type, id) {
    let plan;
    try { plan = await api.get(`/dictionaries/${type}/${id}/delete-plan`); }
    catch (err) {
      state.status_msg = err?.detail || err?.message || "Не удалось получить сведения об удалении";
      await render();
      return;
    }
    if (plan.blockers && plan.blockers.length) {
      await showInfoDialog(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
      return;
    }
    const rec = type === "project" ? state.projects.find((r) => r.id === id) : state.objects.find((r) => r.id === id);
    const confirmed = await showConfirmDialog(`Удалить «${rec?.name || ""}»?`, { confirmLabel: "Удалить" });
    if (!confirmed) return;
    // Пока идёт запрос — поля этой же формы блокируются: иначе правка,
    // сделанная за то время, что подтверждение уже отправлено, а ответ ещё
    // не пришёл, потерялась бы молча вместе с безусловным сбросом
    // state.draft ниже (задача 3 — конфликтующие действия на время записи).
    setFormFieldsDisabled(true);
    try {
      // "replace" — модель по умолчанию (app/dict_delete.py DeleteIn.mode).
      // "merge" годится только записям с поддеревом на перенос ("adopt" в
      // реестре видов); ни у проекта, ни у объекта такого поддерева нет —
      // сервер отвечает 400 на merge даже когда переносить нечего.
      await api.post(`/dictionaries/${type}/${id}/delete`, { replacements: {}, mode: "replace" });
      // Успех подтверждён сервером — убираем запись из локальных списков
      // точечно, без ожидания повторного GET (задача 4).
      const list = type === "project" ? state.projects : state.objects;
      const idx = list.findIndex((r) => r.id === id);
      if (idx !== -1) list.splice(idx, 1);
      if (state.selected?.type === type && state.selected.id === id) { state.selected = null; state.draft = null; }
      const ok = await refreshListsBestEffort();
      const label = type === "project" ? "Проект" : "Объект";
      state.status_msg = !ok ? `${label} удалён, но обновить данные не удалось.` : `${label} удалён.`;
      await render();
    } catch (err) {
      state.status_msg = err?.detail || err?.message || "Не удалось удалить";
      setFormFieldsDisabled(false);
      await render();
    }
  }

  function populateFilterOptions() {
    const smuSel = body.querySelector("#po-smu-filter");
    const respSel = body.querySelector("#po-responsible-filter");
    if (!smuSel) return;
    const usedSmu = new Map(), usedResp = new Map();
    for (const o of state.objects) {
      if (o.smu_id != null) usedSmu.set(o.smu_id, o.smu_name || String(o.smu_id));
      if (o.responsible_id != null) usedResp.set(o.responsible_id, o.responsible_name || String(o.responsible_id));
    }
    smuSel.innerHTML = `<option value="">СМУ — все</option>` + [...usedSmu].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
    respSel.innerHTML = `<option value="">Ответственный — все</option>` + [...usedResp].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
    smuSel.value = state.smu; respSel.value = state.responsible;
  }

  async function render() {
    if (!state.loaded) {
      const ok = await ensureLoaded();
      if (!ok) {
        body.innerHTML = `<p class="v2-note">${escapeHtml(state.loadError)} ${btn("Повторить", 'id="po-retry"')}</p>`;
        body.querySelector("#po-retry")?.addEventListener("click", render);
        return;
      }
    }
    body.innerHTML = `
      <div class="v2-cols">
        <aside class="v2-side v2-tree-pane">
          <input id="po-search" placeholder="Найти по названию или адресу" value="${escapeHtml(state.query)}">
          <select id="po-status-filter">
            ${[["active", "В работе"], ["perspective", "Перспективный"], ["suspended", "Приостановлен"], ["completed", "Завершён"], ["archived", "Архивный"], ["", "Все"]]
              .map(([v, l]) => `<option value="${v}" ${state.status === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <select id="po-smu-filter"></select>
          <select id="po-responsible-filter"></select>
          <div id="po-tree" class="v2-tree"></div>
          <div class="v2-tree-foot">${btn("+ Проект", 'id="po-add-project"')}${btn("+ Объект", 'id="po-add-object"')}</div>
        </aside>
        <section id="po-form"></section>
      </div>`;
    populateFilterOptions();
    renderTree();
    await renderForm();
    renderFooter();
    if (state.status_msg) { status.textContent = state.status_msg; state.status_msg = ""; }
    renderListRefreshRetry();
    body.querySelector("#po-search").addEventListener("input", (e) => {
      clearTimeout(body._searchTimer);
      const value = e.target.value;
      body._searchTimer = setTimeout(() => { state.query = value.trim().toLowerCase(); renderTree(); }, 150);
    });
    body.querySelector("#po-status-filter").addEventListener("change", (e) => { state.status = e.target.value; renderTree(); });
    body.querySelector("#po-smu-filter").addEventListener("change", (e) => { state.smu = e.target.value; renderTree(); });
    body.querySelector("#po-responsible-filter").addEventListener("change", (e) => { state.responsible = e.target.value; renderTree(); });
    body.querySelector("#po-add-project").addEventListener("click", () => selectNode("project", null));
    body.querySelector("#po-add-object").addEventListener("click", () => {
      const projectId = state.selected?.type === "project" ? state.selected.id
        : state.selected?.type === "object" ? selectedRecord()?.project_id : null;
      selectNode("object", null, { projectId });
    });
  }

  render();

  return { hasUnsavedChanges, guardLeave: requestLeave };
}
