// V2: «Проекты и объекты» — дерево проект→объект слева, карточка справа.
// Те же эндпоинты, что у V1 (app/main.py: /projects, /objects, /smu,
// /individuals, /dictionaries/*), тот же уровень доступа: раздел целиком,
// включая чтение, открыт только при "projects":"write" — как в V1
// (index.html data-feature-kind="write" у пункта меню), отдельного
// read-only режима у этого экрана нет и в оригинале.
//
// Классификатор адресов и мини-карта (раздел 6, задача функционального
// паритета) — те же самые ES-модули V1 (app/static/address.js,
// app/static/map.js), подключены динамическим import() тем же приёмом,
// что и в app.js: они не читают DOM/глобали V1, зависимости передаются
// явно через init({api, geocode}). Никакой копии бизнес-логики адреса или
// геокодирования здесь нет — только своя разметка вокруг тех же виджетов.
//
// Вложения и превью объекта — те же /attachments, /objects/{id}/avatar, что
// и renderAttachments в V1 (app.js:7712); права на них выводятся из
// ВЛАДЕЛЬЦА (app/attachments.py._guard) отдельно от общего доступа к
// разделу — проект правит только администратор сервиса, объект — по роли
// именно на нём (attachPermsFor).
//
// Сознательно НЕ перенесён (см. отчёт по этапу): полный редактор контракта
// (позиции, инциденты, производительность) — остаётся доступным в V1 через
// "Открыть в V1".
import { resolveDirty as sharedResolveDirty, showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { trashIconHtml } from "./icons.js";

// Кэш загруженных модулей — на уровне файла, а не mountProjectsObjects(): при
// повторном монтировании раздела (уход на другую вкладку V2 и возврат) не
// нужно заново дёргать dynamic import, HTTP-кэш браузера тут не спасает от
// повторного .init().
let addressModule = null;
let mapModule = null;

function ensureAddressWidget(api) {
  if (!addressModule) {
    addressModule = import("/static/address.js").then((m) => {
      m.init({
        api: (path) => api.get(path),
        // Геокодер — через map.js, тем же приёмом, что и в app.js: адресный
        // виджет не тянет тяжёлый MapLibre сам, только знает URL Nominatim.
        geocode: async (query) => (await ensureMapModule(api)).geocodeAddress(query),
      });
      return m;
    });
  }
  return addressModule;
}

function ensureMapModule(api) {
  if (!mapModule) {
    mapModule = import("/static/map.js").then((m) => {
      m.init({ api: (path) => api.get(path) });
      return m;
    });
  }
  return mapModule;
}

// Та же логика, что в address.js (собратьЗапросГеокодера, приватная функция
// модуля) — геокодеру нужны ЧИСТЫЕ имена частей адреса, а не отформатированная
// строка с сокращениями («г Москва» Nominatim однажды прочитал как «гора
// Москва» и вернул точку в Красноярском крае). V1 (app.js:
// geocodeQueryFromAddress) идёт на то же небольшое дублирование ради этого —
// извлекать приватную функцию ради общего вызова значило бы менять публичный
// контракт address.js без надобности.
function geocodeQueryFromAddress(addr) {
  const части = addr && addr.address_parts;
  if (!части) return (addr && addr.address) || null;
  const пункт = части.settlement || части.city || части.area || части.region || null;
  if (!пункт || !пункт.name) return null;
  const запрос = { city: пункт.name, country: "Россия" };
  if (части.region && части.region.name && части.region !== пункт) запрос.state = части.region.name;
  if (части.street && части.street.name) {
    const дом = части.house && части.house.name;
    запрос.street = дом ? `${части.street.name} ${дом}` : части.street.name;
  }
  return запрос;
}

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
    // Координаты уже стоят (сохранены) или тронуты руками/пином — тогда
    // автоопределение по адресу их больше не перезаписывает (initDraft).
    coordsLocked: false,
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
      // Ошибка сохранения из диалога ухода показывается СРАЗУ в строке
      // статуса: вызывающие (selectNode, «Открыть в V1», смена раздела) при
      // отказе просто выходят без перерисовки, и текст, отложенный в
      // state.status_msg, пользователь бы не увидел вовсе. Переход отменён,
      // черновик и кнопки «Отменить/Сохранить» остаются, повтор возможен.
      status.textContent = err?.detail || err?.message || "Не удалось сохранить";
    });
  }
  async function requestLeave() {
    if (!currentDirty) return true;
    const ok = await resolveDirty(currentDirty);
    if (ok) clearDirtyState();
    return ok;
  }

  let navGuardBusy = false;
  const NAV_BUSY_TEXT = "Идёт загрузка — переход станет доступен после ответа сервера";
  async function withNavGuard(fn) {
    if (api.hasPendingWrites()) return; // причина уже показана в шапке (main.js)
    if (navGuardBusy) { status.textContent = NAV_BUSY_TEXT; return; }
    navGuardBusy = true;
    try { await fn(); } finally {
      navGuardBusy = false;
      if (status.textContent === NAV_BUSY_TEXT) status.textContent = "";
    }
  }

  // Живая мини-карта формы — держим ссылку, чтобы уничтожить её ПЕРЕД
  // следующей отрисовкой формы (renderForm полностью перестраивает разметку)
  // и при уходе с раздела целиком (см. destroy() в конце файла): каждая
  // карта держит свой graphics-контекст, браузер выдаёт их считанные
  // десятки — без явного remove() новые карты через некоторое количество
  // перерисовок просто перестают строиться, молча, без ошибки.
  let pinMap = null;
  function destroyPinMap() {
    if (pinMap) { try { pinMap.карта.remove(); } catch (e) { /* контекст уже мог быть потерян */ } pinMap = null; }
  }

  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container">
      <h2>Проекты и объекты</h2>
      <p class="v2-muted">Проект — группа объектов одной площадки. Все свойства, справочники и контракты живут внутри объекта; сроки СМР сводятся из объектов.</p>
    </div></div>
    <div id="po-body" class="v2-scroll"><div id="po-inner" class="v2-container"></div></div>
    <footer class="v2-foot"><div class="v2-container">
      <span id="po-status" class="v2-muted" role="status" aria-live="polite"></span><div class="v2-foot-actions" id="po-foot-actions"></div>
    </div></footer>
  `;
  // Закреплённый подвал и прокрутка только внутри #po-body держатся на классе
  // v2-app контейнера. Раздел ставит его сам: раньше он появлялся здесь лишь
  // как «утечка» после захода в «Пользователи и доступ», и вид зависел от
  // порядка посещения разделов. main.js сбрасывает класс при каждой смене.
  container.classList.add("v2-app");
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

  // Общие для проекта и объекта поля адреса (AddressFields в app/models.py) —
  // отдельной функцией, чтобы не повторять пять полей в четырёх местах.
  function addressFieldsOf(rec) {
    return {
      address: rec?.address || "", address_code: rec?.address_code || null,
      address_source: rec?.address_source || null, address_region: rec?.address_region || null,
      address_parts: rec?.address_parts || null, postal_code: rec?.postal_code || null,
      address_note: rec?.address_note || "", lat: rec?.lat ?? "", lon: rec?.lon ?? "",
    };
  }

  function initDraft() {
    const rec = selectedRecord();
    if (state.selected?.type === "project") {
      state.draft = rec
        ? { name: rec.name, status: rec.status || "active", description: rec.description || "", ...addressFieldsOf(rec) }
        : { name: "", status: "active", description: "", ...addressFieldsOf(null) };
    } else {
      state.draft = rec
        ? { name: rec.name, status: rec.status || "active", project_id: rec.project_id,
            kind: rec.kind || "zhbi", description: rec.description || "",
            smu_id: rec.smu_id ?? "", smu_director_id: rec.smu_director_id ?? "", responsible_id: rec.responsible_id ?? "",
            smr_start_reported: rec.smr_start_reported || "", media_url: rec.media_url || "", ...addressFieldsOf(rec) }
        : { name: "", status: "active", project_id: state.newObjectProjectId || (state.projects[0]?.id ?? ""),
            kind: "zhbi", description: "", smu_id: "", smu_director_id: "", responsible_id: "",
            smr_start_reported: "", media_url: "", ...addressFieldsOf(null) };
    }
    // У уже сохранённой записи с координатами автопозиционирование по адресу
    // не трогает точку — вдруг она уточнена руками именно там, где нужно
    // (тот же приём, что и в V1: catalog.coordsLocked). Новая или ещё без
    // координат запись остаётся разблокированной.
    state.coordsLocked = !!(rec && rec.lat !== null && rec.lat !== undefined);
    state.dirty = false;
    state.draftBaseline = draftFingerprint(state.draft);
    clearDirtyState();
  }

  // «Несохранённое» — это РАЗЛИЧИЕ между формой и подтверждённой записью, а не факт, что в поле что-то набирали:
  // вернули значение руками — сторож и подвал снимаются. Числа и строки сравниваются одинаково (select даёт строку).
  function draftFingerprint(d) {
    return JSON.stringify(d, (k, v) => (v === null || v === undefined ? "" : (typeof v === "object" ? v : String(v))));
  }

  function markDirty() {
    if (draftFingerprint(state.draft) === state.draftBaseline) {
      if (state.dirty) { state.dirty = false; clearDirtyState(); renderFooter(); }
      return;
    }
    state.dirty = true;
    setDirty({
      message: "В карточке есть несохранённые изменения.",
      save: saveOrThrow,
      discard: () => { initDraft(); },
    });
    renderFooter();
  }

  function renderFooter() {
    // Без несохранённых изменений подвал пуст и статус «Есть несохранённые
    // изменения» не остаётся висеть (например, после «Не сохранять»); текст
    // результата операции («Сохранено.») render() ставит уже после этого.
    if (!state.dirty) { footActions.innerHTML = ""; status.textContent = ""; return; }
    footActions.innerHTML = `${btn("Отменить", 'id="po-cancel"')}${btn("Сохранить", 'id="po-save"', true)}`;
    status.textContent = "Есть несохранённые изменения";
    footActions.querySelector("#po-cancel").addEventListener("click", async () => {
      initDraft();
      status.textContent = "";
      // renderFooter() — иначе "Отменить"/"Сохранить" остаются висеть в
      // подвале после отмены (initDraft уже сбросил state.dirty в false):
      // повторный клик по "Сохранить" отправил бы PATCH без единой реальной
      // правки, а вид формы врал бы о несохранённых изменениях (найдено
      // живой проверкой при разделе 6 — тот же класс бага, что и в
      // counterparties.js/renderFooter).
      renderFooter();
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
        if (err && err.status === 409 && /Ничего не сохранено/.test(err.detail || "")) {
          // Запись изменил кто-то другой: молча не перезаписываем; человек сам выбирает перечитать актуальное (его правки при этом отбрасываются).
          const reload = document.createElement("button");
          reload.type = "button"; reload.id = "po-stale-reload"; reload.className = "v2-btn";
          reload.textContent = "Перечитать актуальные данные (мои правки будут отброшены)";
          footActions.prepend(reload);
          reload.addEventListener("click", async () => {
            reload.disabled = true;
            await refreshListsBestEffort();
            initDraft();
            state.status_msg = "Данные перечитаны.";
            await render();
          });
        }
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
      address: (snapshot.address || "").trim() || null, address_note: (snapshot.address_note || "").trim() || null,
      address_code: snapshot.address_code || null, address_source: snapshot.address_source || null,
      address_region: snapshot.address_region || null, address_parts: snapshot.address_parts || null,
      postal_code: snapshot.postal_code || null,
      lat: snapshot.lat === "" || snapshot.lat === null ? null : Number(snapshot.lat),
      lon: snapshot.lon === "" || snapshot.lon === null ? null : Number(snapshot.lon) };
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
    if (!wasNew) {
      // Версия записи, которую форма видела при открытии: изменил кто-то другой — сервер откажет 409 («Ничего не сохранено»).
      body.expected_version = selectedRecord()?.version;
    }
    let saved;
    try {
      saved = wasNew ? await api.post(path, body) : await api.patch(`${path}/${state.selected.id}`, body);
    } catch (err) {
      if (!(err && (err.status === 0 || err.status >= 500))) throw err;
      // Исход неизвестен (обрыв связи, 5xx): повторно НЕ отправляем — читаем справочник и сверяем с тем, что отправляли.
      let found = null, read = false;
      try {
        const r = await fetchAllLists(); read = true;
        state.projects = r.projects; state.objects = r.objects; state.smuList = r.smuList; state.individualsList = r.individualsList;
        const list = type === "project" ? r.projects : r.objects;
        const norm = (v) => (v === undefined || v === null || v === "" ? null : String(v));
        const cmp = ["name", "status", "description", "address", "address_note", "kind", "project_id", "smu_id", "smu_director_id", "responsible_id", "smr_start_reported", "media_url"];
        found = wasNew
          ? list.find((r0) => r0.name === body.name && (type === "project" || String(r0.project_id) === String(body.project_id)))
          : list.find((r0) => r0.id === state.selected.id && cmp.every((k) => !(k in body) || norm(r0[k]) === norm(body[k])));
      } catch (e) { /* нет связи — сверить нечем */ }
      if (!found) {
        throw Object.assign(new Error(err.detail), { status: err.status, detail: read
          ? `${err.detail} На сервере ${wasNew ? "запись не найдена" : "правка не найдена"} — можно нажать «Сохранить» ещё раз.`
          : `${err.detail} Неизвестно, ${wasNew ? "создана ли запись" : "сохранена ли правка"}: проверьте связь и обновите данные.` });
      }
      saved = found;
      state.unknownOutcomeNote = wasNew ? "Сервер создал запись, хотя ответ не дошёл." : "Сервер сохранил изменения, хотя ответ не дошёл.";
    }
    // Задача 4: подтверждение — из ОТВЕТА записи (полный Project/ObjectOut),
    // без ожидания отдельного GET. Список — точечно: заменяем/добавляем ТУ
    // ЖЕ запись, поэтому даже при отказе фонового обновления агрегатов
    // ниже форма и дерево уже показывают подтверждённые, не старые данные.
    const list = type === "project" ? state.projects : state.objects;
    const idx = list.findIndex((r) => r.id === saved.id);
    if (idx === -1) list.push(saved); else list[idx] = saved;
    state.selected = { type, id: saved.id };
    // Новый/сохранённый объект должен быть виден в дереве: родительский проект раскрывается, иначе выбранная строка скрыта.
    if (type === "object" && saved.project_id != null) state.expanded.add(saved.project_id);
    state.isNew = false;
    state.dirty = false;
    clearDirtyState();
    const ok = await refreshListsBestEffort();
    state.status_msg = !ok ? "Сохранено, но обновить данные не удалось." : (state.unknownOutcomeNote || (wasNew ? "Добавлено." : "Сохранено."));
    state.unknownOutcomeNote = "";
    // Форма показывает то, что подтвердил сервер. Поля, изменённые ПОСЛЕ отправки (поле технически можно
    // изменить, пока идёт запрос: автозаполнение, IME), не затираем — они остаются несохранёнными.
    const draftNow = state.draft;
    initDraft();
    if (JSON.stringify(draftNow) !== JSON.stringify(snapshot)) {
      for (const key of Object.keys(draftNow)) {
        if (JSON.stringify(draftNow[key]) !== JSON.stringify(snapshot[key])) state.draft[key] = draftNow[key];
      }
      state.dirty = true;
      setDirty({ message: "В карточке есть несохранённые изменения.", save: saveOrThrow, discard: () => { initDraft(); } });
      state.status_msg = "";
    }
  }

  function renderTree() {
    const rows = [];
    const filterActive = !!(state.query || (state.status && state.status !== "active") || state.smu || state.responsible);
    for (const p of state.projects) {
      const objs = objectsOf(p.id);
      // СМУ и ответственный — реквизиты ОБЪЕКТА (у проекта их нет): при таком фильтре проект остаётся в дереве
      // только вместе с подошедшими объектами, а не как пустая «оболочка» (иначе фильтр ничего не сужает).
      const objectOnlyFilter = !!(state.smu || state.responsible);
      const projectMatches = !objectOnlyFilter && matches(p, p.name);
      const matchingObjects = objs.filter((o) => matches(o, p.name));
      if (!projectMatches && !matchingObjects.length) continue;
      const expanded = filterActive || state.expanded.has(p.id);
      const sel = state.selected?.type === "project" && state.selected.id === p.id;
      rows.push(`<div class="v2-tree-row">
        <button type="button" class="v2-tree-node v2-tree-project${sel ? " v2-tree-selected" : ""}" data-project="${p.id}">
          <span class="v2-tree-chevron">${expanded ? "▼" : "▶"}</span>
          <span class="v2-status-dot" data-dot="${p.status || "active"}"></span>
          <span class="v2-tree-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <span class="v2-tree-count">${p.objects_count} · ${p.elements_count}</span>
        </button></div>`);
      if (expanded) {
        const toShow = state.query || state.smu || state.responsible || (state.status && state.status !== "active") ? matchingObjects : objs;
        for (const o of toShow) {
          const oSel = state.selected?.type === "object" && state.selected.id === o.id;
          rows.push(`<div class="v2-tree-row">
            <button type="button" class="v2-tree-node v2-tree-object${oSel ? " v2-tree-selected" : ""}" data-object="${o.id}">
              <span class="v2-status-dot" data-dot="${o.status || "active"}"></span>
              <span class="v2-tree-name" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</span>
              <span class="v2-tree-count">${o.elements_current || "пусто"}</span>
            </button></div>`);
        }
      }
    }
    if (!rows.length) {
      // Пустой результат ФИЛЬТРА (поиск, статус, СМУ, ответственный) — это «ничего не найдено», а не «данных нет».
      body.querySelector("#po-tree").innerHTML = `<p class="v2-note">${filterActive ? "Ничего не найдено." : "Здесь пока пусто — заведите проект кнопкой ниже."}</p>`;
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
    // Форма перестраивается целиком на каждый выбор записи/сохранение/отмену —
    // старую карту нужно уничтожить ДО этого, а не полагаться на то, что
    // innerHTML сам вычистит её WebGL-контекст (см. destroyPinMap выше).
    destroyPinMap();
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
      <div id="po-address"></div>
      <div class="v2-coords-row">
        ${fieldRow("Широта", `<input id="pf-lat" type="number" step="0.000001" value="${escapeHtml(d.lat)}">`)}
        ${fieldRow("Долгота", `<input id="pf-lon" type="number" step="0.000001" value="${escapeHtml(d.lon)}">`)}
        ${btn("Определить заново", 'id="po-coords-refresh"')}
      </div>
      <div class="hint-text" id="po-coords-status"></div>
      <div id="po-pin-map" class="v2-pin-map"></div>
      ${!state.isNew ? `
      <div class="v2-group">Фото и вложения</div>
      <div id="po-avatar"></div>
      <div id="po-attachments"><p class="v2-muted">Загрузка…</p></div>` : `
      <p class="v2-muted" style="margin:12px 0 0">Вложения станут доступны после первого сохранения.</p>`}
    `;
    // Значение попадает в черновик и на input, и на change: раньше на input
    // только ставился признак «изменено», а сам черновик обновлялся лишь при
    // уходе фокуса — форма могла считаться изменённой при устаревшем черновике.
    const FIELD_KEYS = { "pf-name": "name", "pf-status": "status", "pf-project": "project_id", "pf-kind": "kind",
      "pf-smu": "smu_id", "pf-smu-director": "smu_director_id", "pf-responsible": "responsible_id",
      "pf-smr-start": "smr_start_reported", "pf-media": "media_url", "pf-description": "description",
      "pf-lat": "lat", "pf-lon": "lon" };
    const syncDraftField = (elm) => { const key = FIELD_KEYS[elm.id]; if (key) state.draft[key] = elm.value; };
    el.querySelectorAll("input, select, textarea").forEach((elm) => elm.addEventListener("input", () => { syncDraftField(elm); markDirty(); }));
    el.querySelectorAll("input, select").forEach((elm) => elm.addEventListener("change", () => syncDraftField(elm)));
    if (el.querySelector("#po-open-v1")) {
      el.querySelector("#po-open-v1").addEventListener("click", async () => {
        if (!(await requestLeave())) return;
        location.href = `/?ui=v1&object_id=${state.selected.id}`;
      });
    }
    if (el.querySelector("#po-delete")) {
      el.querySelector("#po-delete").addEventListener("click", () => withNavGuard(() => requestDelete(type, state.selected.id)));
    }
    mountAddressAndMap(el, d);
    if (!state.isNew) mountAttachments(el, type, state.selected.id);
  }

  // Классификатор адресов + мини-карта (раздел 6). Тот же приём, что и в
  // V1 renderCatalogForm: применённые координаты (от геокодера или от
  // "Определить заново") пишутся сразу в оба места — числовые поля формы и
  // пин на карте, а pinMap читается в МОМЕНТ ВЫЗОВА (не при объявлении):
  // карта строится асинхронно и к первому автогеокодированию может быть ещё
  // не готова, тогда координаты просто ждут её в полях.
  function mountAddressAndMap(el, d) {
    const latInput = () => el.querySelector("#pf-lat");
    const lonInput = () => el.querySelector("#pf-lon");
    const coordsStatus = el.querySelector("#po-coords-status");
    function setCoordsStatus(text, warn) {
      if (!coordsStatus.isConnected) return; // форма могла успеть перерисоваться заново
      coordsStatus.textContent = text || "";
      coordsStatus.classList.toggle("address-warn", !!warn);
    }
    setCoordsStatus(d.lat !== "" && d.lat !== null ? "Координаты заданы." : "Без координат запись не попадёт на карту проектов.", false);

    function applyFoundCoords(lat, lon) {
      if (!el.isConnected) return; // ответ геокодера пришёл уже после ухода с формы
      const li = latInput(), lo = lonInput();
      if (li) li.value = String(lat);
      if (lo) lo.value = String(lon);
      state.draft.lat = lat; state.draft.lon = lon;
      if (pinMap) pinMap.показать(lat, lon);
      markDirty();
      setCoordsStatus("Найдены автоматически по адресу.", false);
    }

    el.querySelector("#po-coords-refresh")?.addEventListener("click", async () => {
      state.coordsLocked = false;
      setCoordsStatus("Ищем координаты…", false);
      try {
        const m = await ensureMapModule(api);
        const query = geocodeQueryFromAddress(state.draft);
        const found = query ? await m.geocodeAddress(query) : null;
        if (found) applyFoundCoords(found.lat, found.lon);
        else setCoordsStatus("Не найдено. Проверьте адрес или укажите точку на карте ниже, когда правка пина будет включена.", true);
      } catch (e) {
        setCoordsStatus("Не удалось определить координаты: " + (e.message || ""), true);
      }
    });
    [latInput(), lonInput()].forEach((input) => input?.addEventListener("change", () => {
      state.coordsLocked = true;
      const lat = parseFloat(latInput().value), lon = parseFloat(lonInput().value);
      if (!isNaN(lat) && !isNaN(lon)) {
        if (pinMap) pinMap.показать(lat, lon);
        setCoordsStatus("Указаны вручную.", false);
      }
    }));

    const pinContainer = el.querySelector("#po-pin-map");
    ensureMapModule(api).then((m) => m.createPinMap(pinContainer, {
      lat: d.lat === "" ? null : d.lat, lon: d.lon === "" ? null : d.lon,
      // Правка кликом/перетаскиванием пина остаётся выключенной, как и в V1
      // (живой запрос 2026-09-08: случайный клик по карте при просмотре
      // двигал точку) — координаты задаются через адрес или полями руками.
      canEdit: false,
      onMove: () => {},
    })).then((pin) => {
      if (!pinContainer.isConnected) { try { pin.карта.remove(); } catch (e) {} return; } // форма уже сменилась
      pinMap = pin;
    }).catch((e) => {
      pinContainer.innerHTML = `<div class="v2-note">Карта недоступна: ${escapeHtml(e.message || "")}</div>`;
    });

    const addrContainer = el.querySelector("#po-address");
    ensureAddressWidget(api).then((m) => m.mountAddressWidget(addrContainer, {
      value: { address: d.address, address_code: d.address_code, address_source: d.address_source,
        address_region: d.address_region, address_parts: d.address_parts, postal_code: d.postal_code,
        address_note: d.address_note },
      canEdit: true,
      onChange: (values) => {
        Object.assign(state.draft, values);
        markDirty();
      },
      onGeocode: (lat, lon) => {
        if (state.coordsLocked) return; // координаты уже стоят или тронуты вручную
        applyFoundCoords(lat, lon);
      },
    })).catch((e) => {
      // Виджет не загрузился — форма обязана остаться рабочей: обычное поле
      // без подсказок и без разбора по классификатору.
      addrContainer.innerHTML = `<label class="v2-field v2-span">Адрес<input id="pf-address-fallback" value="${escapeHtml(d.address)}" placeholder="Населённый пункт, улица, дом"></label>
        <label class="v2-field v2-span">Уточнение<input id="pf-address-note-fallback" value="${escapeHtml(d.address_note)}"></label>`;
      addrContainer.querySelector("#pf-address-fallback")?.addEventListener("input", (ev) => { state.draft.address = ev.target.value; markDirty(); });
      addrContainer.querySelector("#pf-address-note-fallback")?.addEventListener("input", (ev) => { state.draft.address_note = ev.target.value; markDirty(); });
    });
  }

  // Права на вложения — по их ВЛАДЕЛЬЦУ (app/attachments.py: _guard), а не по
  // общему уровню раздела: у проекта их ведёт ТОЛЬКО администратор сервиса
  // ("проекты — его епархия"), у объекта — по роли ИМЕННО НА НЁМ (feature
  // attachments/attachments_delete), которая может отличаться от системной
  // роли (например, у прораба). Для объекта запрашиваем /me/permissions
  // ?object_id=... — тот же эндпоинт и тот же расчёт, что сервер потом
  // применит к самим POST/DELETE, вместо копирования canOn() на клиенте.
  async function attachPermsFor(type, id) {
    if (type === "project") {
      return { canUpload: ctx.perms.isSystemAdmin, canDelete: ctx.perms.isSystemAdmin };
    }
    if (ctx.perms.isSystemAdmin) return { canUpload: true, canDelete: true };
    try {
      const perms = await api.get(`/me/permissions?object_id=${id}`);
      return {
        canUpload: perms.features?.attachments === "write",
        canDelete: perms.features?.attachments_delete === "write",
      };
    } catch (e) {
      return { canUpload: false, canDelete: false };
    }
  }

  const ATTACHMENT_ICON = "📎";
  const AVATAR_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1048576).toFixed(1)} МБ`;
  }
  async function downloadAttachment(id, name) {
    const res = await fetch(`/attachments/${id}/download`, { credentials: "same-origin" });
    if (!res.ok) { state.status_msg = "Не удалось скачать файл"; await render(); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // Вложения объекта/проекта (раздел 6) — тот же список эндпоинтов
  // (/attachments, /attachments/{id}/download, /objects/{id}/avatar), что и
  // renderAttachments в V1 (app.js:7712), но без системных confirm()/alert():
  // ошибки остаются в статус-строке карточки, удаление — через
  // showConfirmDialog, крестик — через общую иконку icons.js.
  async function mountAttachments(el, type, id) {
    const listEl = el.querySelector("#po-attachments");
    const avatarEl = el.querySelector("#po-avatar");
    if (!listEl) return;
    const { canUpload, canDelete } = await attachPermsFor(type, id);
    if (!listEl.isConnected) return; // форма уже сменилась, пока считались права

    const rec = type === "object" ? state.objects.find((r) => r.id === id) : null;
    function renderAvatar() {
      if (!avatarEl || type !== "object") return;
      if (rec && rec.has_avatar) {
        avatarEl.innerHTML = `<img src="/objects/${id}/avatar?t=${Date.now()}" alt="" class="v2-avatar-preview">`;
      } else {
        avatarEl.innerHTML = "";
      }
    }
    renderAvatar();

    function paint(list) {
      if (!listEl.isConnected) return;
      const rows = list.length ? list.map((a) => {
        const canPreview = type === "object" && canUpload && AVATAR_MIME_TYPES.includes(a.content_type);
        const isPreview = rec && rec.avatar_attachment_id === a.id;
        const previewBtn = canPreview
          ? (isPreview
            ? `<button type="button" class="v2-link" data-avatar-unset="${a.id}" title="Убрать как превью объекта">★ превью</button>`
            : `<button type="button" class="v2-link" data-avatar-set="${a.id}" title="Сделать превью объекта">☆ превью</button>`)
          : "";
        return `<div class="v2-attach-row">
          <button type="button" class="v2-link" data-download="${a.id}" data-name="${escapeHtml(a.filename)}" title="Скачать">${ATTACHMENT_ICON} ${escapeHtml(a.filename)}</button>
          <span class="v2-muted v2-attach-meta">${formatFileSize(a.size)}${a.description ? " · " + escapeHtml(a.description) : ""}
            · ${escapeHtml(a.uploaded_by || "—")}, ${escapeHtml((a.uploaded_at || "").slice(0, 16))}</span>
          ${previewBtn}
          ${canDelete ? trashIconHtml(`data-del="${a.id}"`, `Удалить вложение ${a.filename}`) : ""}
        </div>`;
      }).join("") : `<p class="v2-muted">Файлов нет.</p>`;
      listEl.innerHTML = rows + (canUpload ? `
        <div class="v2-inline" style="margin-top:10px">
          <input type="file" id="po-attach-file" aria-label="Файлы для вложения" multiple>
          <input type="text" id="po-attach-desc" aria-label="Описание вложения" placeholder="описание (необязательно)">
          ${btn("Приложить", 'id="po-attach-add"')}
        </div>
        <div class="v2-muted" id="po-attach-status" style="margin-top:6px"></div>` : "");

      listEl.querySelectorAll("[data-download]").forEach((b) => b.addEventListener("click", () =>
        downloadAttachment(b.dataset.download, b.dataset.name)));
      listEl.querySelectorAll("[data-avatar-set],[data-avatar-unset]").forEach((b) => b.addEventListener("click", async () => {
        const newId = b.dataset.avatarSet ? Number(b.dataset.avatarSet) : null;
        b.disabled = true;
        try {
          await api.put(`/objects/${id}/avatar`, { attachment_id: newId });
          if (rec) { rec.avatar_attachment_id = newId; rec.has_avatar = !!newId; }
          renderAvatar();
          paint(list);
        } catch (err) {
          b.disabled = false;
          state.status_msg = err?.detail || err?.message || "Не удалось назначить превью";
          await render();
        }
      }));
      listEl.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        if (b.disabled) return;
        const attId = Number(b.dataset.del);
        // Блокировка ДО диалога: второй клик по той же кнопке (или по кнопке
        // соседнего вложения) не должен открыть ещё одно подтверждение и
        // отправить второй DELETE по тому же id, пока первый в пути.
        listEl.querySelectorAll("[data-del]").forEach((x) => { x.disabled = true; });
        const unlockDeleteButtons = () => listEl.querySelectorAll("[data-del]").forEach((x) => { x.disabled = false; });
        const confirmed = await showConfirmDialog("Удалить вложение? Восстановить его будет нечем.", { confirmLabel: "Удалить", danger: true });
        if (!confirmed) { unlockDeleteButtons(); return; }
        try {
          const d = await api.delete(`/attachments/${attId}`);
          if (rec && rec.avatar_attachment_id === attId) { rec.avatar_attachment_id = null; rec.has_avatar = false; renderAvatar(); }
          paint(d.attachments);
        } catch (err) {
          unlockDeleteButtons();
          state.status_msg = err?.detail || err?.message || "Не удалось удалить вложение";
          await render();
        }
      }));
      const addBtn = listEl.querySelector("#po-attach-add");
      if (addBtn) addBtn.addEventListener("click", async () => {
        const fileInput = listEl.querySelector("#po-attach-file");
        const statusEl = listEl.querySelector("#po-attach-status");
        if (!fileInput.files.length) { statusEl.textContent = "Выберите файл."; return; }
        addBtn.disabled = true;
        let latest = list;
        try {
          // По одному файлу за запрос — при отказе на N-м уже загруженные
          // раньше не теряются вместе со всей пачкой (тот же приём, что и в
          // renderAttachments V1).
          for (const file of fileInput.files) {
            statusEl.textContent = `Загрузка: ${file.name}…`;
            const fd = new FormData();
            fd.append("entity_type", type);
            fd.append("entity_id", String(id));
            fd.append("description", listEl.querySelector("#po-attach-desc").value.trim());
            fd.append("file", file);
            // Через api.upload, а не сырой fetch: тогда идущая закачка видна
            // счётчику записей и блокирует смену раздела/уход в V1 наравне
            // с остальными записями.
            latest = (await api.upload("/attachments", fd)).attachments;
          }
          paint(latest);
        } catch (err) {
          addBtn.disabled = false;
          const msg = err?.detail || err?.message || "";
          // Сверяемся с сервером: часть файлов могла загрузиться до сбоя, а при обрыве ответа — и сам сбойный. Повторно ничего не отправляем.
          try {
            const d = await api.get(`/attachments?entity_type=${encodeURIComponent(type)}&entity_id=${id}`);
            paint(d.attachments);
            const st2 = listEl.querySelector("#po-attach-status");
            if (st2) st2.textContent = `Не удалось: ${msg} Список показывает то, что реально есть на сервере.`;
          } catch (e2) { if (statusEl.isConnected) statusEl.textContent = "Не удалось: " + msg; }
        }
      });
    }

    try {
      const d = await api.get(`/attachments?entity_type=${encodeURIComponent(type)}&entity_id=${id}`);
      paint(d.attachments);
    } catch (err) {
      if (listEl.isConnected) listEl.innerHTML = `<p class="v2-muted">Не удалось загрузить список: ${escapeHtml(err?.detail || err?.message || "")}</p>`;
    }
  }

  // Подтверждение ВВОДОМ названия — для необратимого удаления проекта или объекта: диалог перечисляет последствия, кнопка «Удалить»
  // доступна только после точного ввода названия (случайный Enter или двойной клик ничего не удалят).
  function askTypedConfirm(message, name) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "v2-dialog-backdrop";
      backdrop.innerHTML = `<div class="v2-dialog" role="alertdialog" aria-modal="true" aria-label="Подтверждение удаления">
        <p style="white-space:pre-line">${escapeHtml(message)}</p>
        <label class="v2-field">Для подтверждения введите название: <b>${escapeHtml(name)}</b><input id="po-typed" autocomplete="off" aria-label="Название для подтверждения"></label>
        <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-choice="cancel">Отмена</button>
          <button type="button" class="v2-btn v2-danger" data-choice="confirm" disabled>Удалить</button></div></div>`;
      const input = backdrop.querySelector("#po-typed"), okBtn = backdrop.querySelector('[data-choice="confirm"]');
      function close(v) {
        document.removeEventListener("keydown", onKey, true);
        if (backdrop.isConnected) document.body.removeChild(backdrop);
        if (previouslyFocused && document.contains(previouslyFocused) && previouslyFocused.focus) previouslyFocused.focus();
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
        else if (e.key === "Enter" && e.target === input) { e.preventDefault(); if (!okBtn.disabled) close(true); }
        else if (e.key === "Tab") {
          const items = [...backdrop.querySelectorAll("input, button:not([disabled])")];
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      input.addEventListener("input", () => { okBtn.disabled = input.value.trim() !== name.trim(); });
      backdrop.addEventListener("click", (e) => {
        const c = e.target.closest("[data-choice]")?.dataset.choice;
        if (c === "confirm" && !okBtn.disabled) close(true); else if (c === "cancel" || e.target === backdrop) close(false);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      input.focus();
    });
  }

  // Удаление проекта/объекта: сначала ПЛАН последствий с сервера (что мешает, что удалится вместе), потом подтверждение вводом названия,
  // затем одна серверная операция (проверка → удаление в одной транзакции, при отказе ничего не меняется).
  async function requestDelete(type, id) {
    let planResp;
    try { planResp = await api.get(`/dictionaries/${type}/${id}/delete-plan`); }
    catch (err) {
      state.status_msg = err?.status === 404 ? "Запись уже удалена — список обновлён." : (err?.detail || err?.message || "Не удалось получить сведения об удалении");
      if (err?.status === 404) await refreshListsBestEffort();
      await render();
      return;
    }
    if (planResp.blockers && planResp.blockers.length) {
      await showInfoDialog(`Удалить нельзя. Мешает:\n${planResp.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}\n\nСначала уберите эти данные: удалить можно только пустую запись.`);
      return;
    }
    const rec = type === "project" ? state.projects.find((r) => r.id === id) : state.objects.find((r) => r.id === id);
    const cascade = (planResp.plan?.cascade || []).map((c) => `${c.label} — ${c.count}`);
    let attachN = 0;
    try { attachN = (await api.get(`/attachments?entity_type=${encodeURIComponent(type)}&entity_id=${id}`)).attachments.length; } catch (e) { /* вторично: сервер всё равно удалит вложения вместе с записью */ }
    if (attachN) cascade.push(`Вложения (файлы удаляются с диска) — ${attachN}`);
    const label = type === "project" ? "проект" : "объект";
    const message = `Удалить ${label} «${rec?.name || planResp.plan?.label || ""}»? Это необратимо.\n\n`
      + (cascade.length ? `Вместе с ним будет удалено:\n${cascade.map((c) => "• " + c).join("\n")}` : `За записью ничего не стоит; вместе с ней ничего не удаляется.`);
    const typed = rec?.name || planResp.plan?.label || "";
    if (!(await askTypedConfirm(message, typed))) return;
    // Пока идёт запрос — поля этой же формы блокируются: иначе правка, сделанная за то время, что подтверждение уже отправлено, а ответ ещё
    // не пришёл, потерялась бы молча вместе с безусловным сбросом state.draft ниже (задача 3 — конфликтующие действия на время записи).
    setFormFieldsDisabled(true);
    const finishGone = async (note) => {
      const list = type === "project" ? state.projects : state.objects;
      const idx = list.findIndex((r) => r.id === id);
      if (idx !== -1) list.splice(idx, 1);
      if (state.selected?.type === type && state.selected.id === id) { state.selected = null; state.draft = null; }
      const ok = await refreshListsBestEffort();
      state.status_msg = !ok ? `${note} Обновить данные не удалось.` : note;
      await render();
    };
    try {
      // "replace" — модель по умолчанию (app/dict_delete.py DeleteIn.mode). У проекта и объекта поддерева на перенос нет.
      await api.post(`/dictionaries/${type}/${id}/delete`, { replacements: {}, mode: "replace" });
      await finishGone(`${label[0].toUpperCase()}${label.slice(1)} удалён.`);
    } catch (err) {
      if (err?.status === 404) { await finishGone("Запись уже удалена — список обновлён."); return; }
      if (err && (err.status === 0 || err.status >= 500)) {
        // Исход неизвестен: повторно не отправляем; читаем справочник и говорим по факту.
        let gone = false, read = false;
        try { const r = await fetchAllLists(); read = true; gone = !(type === "project" ? r.projects : r.objects).some((x) => x.id === id); } catch (e) { /* нет связи */ }
        if (gone) { await finishGone(`Сервер удалил ${label}, хотя ответ не дошёл.`); return; }
        state.status_msg = read ? `${err.detail} Запись на сервере осталась — можно повторить удаление.` : `${err.detail} Неизвестно, удалена ли запись: проверьте связь и обновите данные.`;
      } else {
        state.status_msg = err?.detail || err?.message || "Не удалось удалить";
        if (err?.status === 409) await refreshListsBestEffort();   // за записью появились данные — покажем актуальное
      }
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
          <input id="po-search" aria-label="Поиск проекта или объекта" placeholder="Название или адрес" value="${escapeHtml(state.query)}">
          <select id="po-status-filter" aria-label="Фильтр по статусу">
            ${[["active", "В работе"], ["perspective", "Перспективный"], ["suspended", "Приостановлен"], ["completed", "Завершён"], ["archived", "Архивный"], ["", "Все"]]
              .map(([v, l]) => `<option value="${v}" ${state.status === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <select id="po-smu-filter" aria-label="Фильтр по СМУ"></select>
          <select id="po-responsible-filter" aria-label="Фильтр по ответственному"></select>
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

  // Вызывается main.js ПЕРЕД тем, как заменить content.innerHTML при уходе
  // на другой раздел V2 — иначе живая мини-карта осталась бы держать свой
  // graphics-контекст, а её DOM-узел просто исчез бы вместе с остальной
  // разметкой раздела.
  function destroy() { destroyPinMap(); }

  return { hasUnsavedChanges, guardLeave: requestLeave, destroy };
}
