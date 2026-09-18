// V2: «Контрагенты» (список) и «Контрагент» (карточка, три вкладки) — те
// же эндпоинты, что у V1 (app/counterparties.py: /counterparties,
// /agreements, /specifications, /contracts, /dictionaries/*). Раздел,
// включая чтение, открыт только при "counterparties":"write" — как в V1
// (index.html data-feature-kind="write" у пункта меню).
//
// Доработка 2026-09-19 (живая проверка после первого переноса):
// — Черновики вкладки "Контрактация" (новый/редактируемый договор,
//   новая/редактируемая спецификация) переехали из DOM в состояние модуля
//   (state.newAgreementForm/agreementDrafts/newSpecForms/specDrafts).
//   Раньше полная перерисовка (после ЛЮБОЙ мутации, переключения вкладки,
//   даже просто раскрытия соседнего договора) стирала введённый, но ещё
//   не сохранённый номер/дату/объект без единого предупреждения —
//   agreements/specs/contracts кэшируются в state.contracting и
//   ПЕРЕЗАГРУЖАЮТСЯ только при открытии другого контрагента, а не при
//   каждом рендере; переключение самих вкладок карточки не запрашивает
//   сеть вовсе и ничего не стирает.
// — Действительно разрушающие черновик переходы (другой контрагент,
//   закрытие карточки, другой раздел шапки V2) собирают ВСЕ незавершённые
//   черновики разом (collectDirtyParts) и показывают общий диалог
//   "Сохранить"/"Не сохранять"/"Остаться"; сохранение одного черновика не
//   трогает остальные — каждый хранится и сохраняется независимо.
// — Пустые catch у создания/сохранения спецификации убраны — ошибка
//   показывается рядом с конкретной формой, ввод сохраняется, повторная
//   отправка блокируется на время запроса и разблокируется после ошибки.
// — Мутации (главные поля, договор, спецификация, удаление) подтверждают
//   свой результат ОТВЕТОМ самой записи и точечно обновляют локальный
//   кэш — вместо повторного GET списка/дерева после каждой записи. Это не
//   "заглушка от отказа чтения", а устранение самой причины: раз ответ
//   мутации уже содержит всё нужное, отдельного чтения для подтверждения
//   не требуется, и его отказ не может отбросить экран к старым данным.
// — Системные alert()/confirm() заменены общими диалогами V2
//   (showConfirmDialog/showInfoDialog, dialogs.js) с фокус-ловушкой и
//   Escape; эмодзи-корзины — общей SVG-иконкой (icons.js, то же
//   изображение, что в V1); кликабельный <div> в списке — кнопкой.
//
// Полный редактор контракта (2026-09-18, раздел 6): создание и правка под
// своей спецификацией — тема, позиции (тип+марка+количество), инциденты
// повреждений, переопределение производительности. Тот же /contracts
// (ContractIn/ContractOut, app/contracts.py), что и у V1
// (#contract-edit-backdrop, openContractEdit в app.js); наименование
// по-прежнему генерируется сервером, здесь только то же превью-дублирование
// формулы, что и в V1.
//
// Список объектов при заведении договора не фильтруется по мелкому признаку
// (doc_supplier_change/doc_link_swap — сам список в V1 отфильтрован НЕ тем
// же признаком, что реально проверяет сервер, см. отчёт) — показаны все
// объекты, реальную проверку в любом случае делает сервер
// (assert_object_feature "agreements","write").
//
// Доработка 2026-09-18/19 (по результатам проверки коммита c379658,
// четыре пункта):
// 1. Защита от повторной отправки (submitNewAgreement/submitNewSpec/
//    submitNewContract, saveAgreementDraft/saveSpecDraft/saveContractDraft):
//    промис в draft._inFlight — повторный вызов (двойной клик, либо диалог
//    "несохранённые изменения", вызывающий ту же функцию) получает ТОТ ЖЕ
//    промис, а не новый запрос. Блокировка (draft.saving=true,
//    setControlsDisabled/setButtonSaving) выставляется синхронно, ДО первого
//    await — второй клик в том же тике её уже видит. На время записи
//    запрещены отмена/удаление редактируемой сущности; ошибка возвращает
//    форму в редактируемое состояние с сохранённым вводом; успех сверяет
//    состояние черновика со снимком на момент отправки (stillSame) и не
//    затирает более новый ввод, если пользователь успел его изменить, пока
//    запрос был в пути.
// 2. Раздельное отслеживание загрузки (emptyContracting/emptySpecsEntry,
//    ensureObjects): у agreements/contracts/у каждой спецификации свой
//    {loaded, error} — ошибка GET показывается как ошибка ИМЕННО этого
//    куска (с кнопкой "Повторить" через retryPiece), а не как "пусто", и не
//    гасит уже загруженные соседние данные. Кусок, однажды упавший,
//    повторно САМ не запрашивается (needsInitialContractingLoad) — только
//    по нажатию "Повторить", иначе постоянно падающий эндпоинт долбился бы
//    на каждой перерисовке.
// 3. Отдельное рабочее пространство контракта (state.page === "contract",
//    openContractWorkspace/renderContractWorkspace): своя шапка (тема,
//    хлебная крошка "Контрагент / Договор / Спецификация", кнопка назад),
//    вкладки "Позиции"/"Развёрнуто"/"Инциденты"/"Производительность" со
//    своей прокручиваемой областью (.v2-scroll) и фиксированный подвал
//    (индикатор изменений, "Отменить"/"Сохранить") — тот же приём модуля
//    контейнера "v2-app", что и в users-access.js; исправляет живой баг:
//    кнопка "Сохранить" контракта с 19 позициями была на ~2163px, вне
//    видимой области на 1920×900 и 1366×768.
// 4. Три операции доведены до паритета с V1 (было — "делай это в V1"):
//    а) вкладка "Развёрнуто" — тот же список привязанных элементов схемы
//       и правка плановой даты, что у V1, с тем же чтением прав через
//       GET /me/permissions (planned_date=="write"/system_admin);
//    б) договор/спецификация контракта — редактируемые select'ы
//       (contractAgreementOptionsHtml/contractSpecOptionsHtml), место
//       открытия формы задаёт значение по умолчанию, но не убирает
//       возможность сменить; смена не сохраняется до нажатия "Сохранить"
//       (draft.specificationId — как любое другое поле черновика);
//    в) удаление контракта с переносом (requestDeleteContract/
//       confirmContractReplacement) — тот же delete-plan/candidates/
//       {replacements:{"contract:{id}":"{key}"}, mode:"replace"}, что у
//       V1, с явным выбором замены и подтверждением; при отсутствии
//       валидной замены — понятное объяснение вместо пустого списка.
import { showUnsavedDialog, showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { trashIconHtml } from "./icons.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(s) {
  if (!s) return "без даты";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `от ${m[3]}.${m[2]}.${m[1]}` : s;
}
// Раздел 2: договоры/спецификации/контракты читаются НЕЗАВИСИМО друг от
// друга и от объектов — отказ одного не должен превращать успешно
// прочитанные соседние данные в такую же пустоту и не должен становиться
// закэшированным "загружено: пусто" навсегда. У каждого куска — СВОЙ флаг
// успеха (Loaded) и СВОЙ текст последней ошибки (Error, если она была,
// даже после успеха предыдущей попытки успех её не стирает молча — стирает
// только следующий успех). specsByAgreement — Map agreementId -> { specs,
// loaded, error }: у каждого договора спецификации читаются отдельным
// запросом и отдельно повторяются, не задевая спецификации других
// договоров.
function emptySpecsEntry() { return { specs: [], loaded: false, error: null }; }
function emptyContracting() {
  return {
    agreements: [], agreementsLoaded: false, agreementsError: null,
    contractsBySpec: new Map(), contractsLoaded: false, contractsError: null,
    specsByAgreement: new Map(),
  };
}

export function mountCounterparties(container, ctx) {
  const { api } = ctx;

  const state = {
    list: [], loaded: false, loadError: null,
    page: "list", // "list" | "edit"
    editingId: null, tab: "main",
    draft: null, dirty: false,
    objects: [], objectsLoaded: false, objectsError: null,
    contracting: emptyContracting(),
    expandedAgreements: new Set(),
    expandedSpecs: new Set(),
    newAgreementForm: null,        // {number, date, objectId, error, saving} | null (форма скрыта)
    agreementDrafts: new Map(),    // id -> {number, date, objectId, error, saving}
    newSpecForms: new Map(),       // agreementId -> {number, date, error, saving}
    specDrafts: new Map(),         // id -> {number, date, error, saving}
    // Полный редактор контракта (раздел 6): specificationId -> черновик
    // создания; contractId -> черновик правки уже существующего. Раскрытие
    // <details> контракта само по себе черновик НЕ создаёт (см.
    // contractFieldValues) — иначе разворачивание списка помечало бы
    // карточку "не сохранено" без единой правки.
    newContractForms: new Map(),
    contractDrafts: new Map(),
    expandedContracts: new Set(),
    // Раздел 3: рабочее пространство контракта — отдельная "страница"
    // (state.page === "contract"), не третий уровень вложенных <details>.
    // contractKey — "new:{specId}" | "edit:{contractId}" | null.
    contractKey: null,
    contractTab: "lines", // "lines" | "expanded" | "incidents" | "capacity"
    contractExpandedCache: new Map(), // contractId -> {loaded, error, rows, canEdit}
    contractDeleteReplacement: null,  // {id, candidates, selectedKey, consequences, error, saving, onSuccess} | null
    status_msg: "",
  };

  function setCardFieldsDisabled(disabled) {
    body.querySelectorAll("#cp-main-fields input, #cp-main-fields textarea, #cp-capacity input").forEach((el) => { el.disabled = disabled; });
  }

  // ---------- защита от повторной отправки (задача 1) ----------
  //
  // Блокировка ставится СИНХРОННО, ДО первого await, тем же вызовом, что
  // выставляет draft.saving — из самой функции сохранения, а не из
  // обработчика кнопки: так блокировка применяется одинаково независимо от
  // того, кто позвал save() — клик по кнопке или диалог "Несохранённые
  // изменения" (requestLeave → resolveDirty → part.save()). Полей у
  // конкретной формы немного, поэтому простые CSS-селекторы по data-*
  // атрибуту записи, без отдельного реестра узлов.
  function setControlsDisabled(selector, disabled) {
    body.querySelectorAll(selector).forEach((el) => { el.disabled = disabled; });
  }
  function setButtonSaving(selector, saving) {
    const el = body.querySelector(selector);
    if (!el) return;
    if (saving) { if (el.dataset.idleLabel === undefined) el.dataset.idleLabel = el.textContent; el.textContent = "Сохранение…"; }
    else if (el.dataset.idleLabel !== undefined) { el.textContent = el.dataset.idleLabel; delete el.dataset.idleLabel; }
  }

  // ---------- сбор незавершённых черновиков вкладки "Контрактация" +
  // главных полей — единая точка для "действительно разрушающих"
  // переходов (задача 2). Переключение вкладок карточки и раскрытие
  // <details> сюда НЕ ходят вовсе — они ничего не разрушают. ----------

  function findAgreement(id) { return state.contracting.agreements.find((a) => a.id === id); }
  function findSpecAndAgreementId(id) {
    for (const [agreementId, entry] of state.contracting.specsByAgreement) {
      const s = (entry.specs || []).find((x) => x.id === id);
      if (s) return { spec: s, agreementId };
    }
    return { spec: null, agreementId: null };
  }
  function findContract(id) {
    for (const list of state.contracting.contractsBySpec.values()) {
      const c = list.find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  }

  function collectDirtyParts() {
    const parts = [];
    if (state.dirty) parts.push({ label: "карточка контрагента", save: saveMain, discard: () => initDraft() });
    if (state.newAgreementForm) parts.push({ label: "новый договор", save: submitNewAgreement, discard: () => { state.newAgreementForm = null; } });
    for (const id of state.agreementDrafts.keys()) {
      const a = findAgreement(id);
      parts.push({ label: `договор «${a ? a.number : id}»`, save: () => saveAgreementDraft(id), discard: () => { state.agreementDrafts.delete(id); } });
    }
    for (const agreementId of state.newSpecForms.keys()) {
      parts.push({ label: "новая спецификация", save: () => submitNewSpec(agreementId), discard: () => { state.newSpecForms.delete(agreementId); } });
    }
    for (const id of state.specDrafts.keys()) {
      const { spec } = findSpecAndAgreementId(id);
      parts.push({ label: `спецификация «${spec ? spec.number : id}»`, save: () => saveSpecDraft(id), discard: () => { state.specDrafts.delete(id); } });
    }
    for (const specId of state.newContractForms.keys()) {
      parts.push({ label: "новый контракт", save: () => submitNewContract(specId), discard: () => { state.newContractForms.delete(specId); } });
    }
    for (const [id, draft] of state.contractDrafts) {
      if (!isContractDraftDirty(draft)) continue;
      const c = findContract(id);
      parts.push({ label: `контракт ${c && c.theme ? `«${c.theme}»` : `№${id}`}`, save: () => saveContractDraft(id), discard: () => { state.contractDrafts.delete(id); } });
    }
    return parts;
  }

  function hasUnsavedChanges() { return collectDirtyParts().length > 0; }

  async function requestLeave() {
    const parts = collectDirtyParts();
    if (!parts.length) return true;
    const message = parts.length === 1
      ? `В карточке контрагента есть несохранённые изменения: ${parts[0].label}.`
      : `В карточке контрагента есть несохранённые изменения (${parts.length}): ${parts.map((p) => p.label).join(", ")}.`;
    const choice = await showUnsavedDialog(message);
    if (choice === "cancel") return false;
    if (choice === "discard") { parts.forEach((p) => p.discard()); return true; }
    let anyFailed = false;
    for (const part of parts) {
      try { await part.save(); }
      catch (err) { anyFailed = true; }
    }
    if (anyFailed) {
      state.status_msg = "Не всё удалось сохранить — ошибки показаны в форме. Откройте вкладку «Контрактация», чтобы их увидеть.";
      // requestLeave() дёргают три разных вызывающих (openCard, backToList,
      // переключатель разделов в main.js) — ждать, что КАЖДЫЙ из них сам
      // перерисует экран при неудаче, ненадёжно (main.js про статус-строку
      // этого модуля вообще не знает). Рендерим сразу здесь: сообщение
      // должно быть видно немедленно, а не при случайном следующем
      // render() от несвязанного действия (живой сценарий, где нашли).
      await render();
      return false;
    }
    return true;
  }

  let navGuardBusy = false;
  async function withNavGuard(fn) {
    if (navGuardBusy || api.hasPendingWrites()) return;
    navGuardBusy = true;
    try { await fn(); } finally { navGuardBusy = false; }
  }

  // Раздел 3: у карточки контрагента и у рабочего пространства контракта —
  // РАЗНАЯ разметка контейнера (у контракта своя закреплённая шапка/вкладки/
  // подвал, .v2-app — тот же приём, что уже применён в users-access.js).
  // container переиспользуется на весь модуль, поэтому его innerHTML
  // пересобирается заново при переходе между "оболочками", а не один раз
  // при монтировании — отсюда body/status/footActions стали let, а не
  // const. currentShell — какая разметка сейчас фактически в DOM, чтобы не
  // пересобирать её на каждый render() без надобности (это стёрло бы фокус
  // и открытые <select>).
  let body, status, footActions;
  let currentShell = null; // "card" | "contract" | null
  function ensureCardShell() {
    if (currentShell === "card") return;
    container.classList.remove("v2-app");
    container.innerHTML = `
      <div class="v2-page-head"><div class="v2-container">
        <h2>Контрагенты</h2>
      </div></div>
      <div id="cp-body" class="v2-scroll"><div id="cp-inner" class="v2-container"></div></div>
      <footer class="v2-foot"><div class="v2-container">
        <span id="cp-status" class="v2-muted"></span><div class="v2-foot-actions" id="cp-foot-actions"></div>
      </div></footer>
    `;
    body = container.querySelector("#cp-inner");
    status = container.querySelector("#cp-status");
    footActions = container.querySelector("#cp-foot-actions");
    currentShell = "card";
  }
  ensureCardShell();

  function btn(label, attr = "", primary = false) {
    return `<button type="button" class="v2-btn ${primary ? "v2-primary" : ""}" ${attr}>${label}</button>`;
  }

  async function ensureLoaded(force) {
    if (state.loaded && !force) return true;
    try {
      state.list = await api.get("/counterparties");
      state.loaded = true; state.loadError = null;
      return true;
    } catch (err) {
      state.loadError = err?.detail || err?.message || "Не удалось загрузить список";
      return false;
    }
  }

  // Раздел 2: отказ чтения — НЕ то же самое, что "объектов нет". Раньше
  // catch подменял результат пустым массивом и НАВСЕГДА помечал
  // objectsLoaded=true — форма договора молча показывала пустой список
  // объектов вместо ошибки, и вернуть его можно было только перезагрузкой
  // всей страницы. Теперь objectsLoaded становится true ТОЛЬКО при
  // успехе; objectsError — текст последней ошибки, читаемый формами для
  // показа "Повторить" рядом с селектом объекта, а не вместо него.
  async function ensureObjects(force) {
    if (state.objectsLoaded && !force) return true;
    try {
      state.objects = await api.get("/objects");
      state.objectsLoaded = true;
      state.objectsError = null;
      return true;
    } catch (err) {
      state.objectsError = err?.detail || err?.message || "Не удалось загрузить список объектов";
      return false;
    }
  }

  function renderFooter() {
    const parts = collectDirtyParts();
    if (state.page !== "edit" || !parts.length) {
      footActions.innerHTML = "";
      // Без этого старый текст ("Не сохранено: ...") оставался бы висеть
      // после того, как ПОСЛЕДНИЙ черновик сохранён/отменён и свежего
      // state.status_msg на подходе нет (render() перезапишет этой же
      // строкой сразу следом, если status_msg всё-таки есть).
      status.textContent = "";
      return;
    }
    // Кнопки "Отменить"/"Сохранить" в подвале относятся ТОЛЬКО к главным
    // полям (у остальных черновиков — своя кнопка "Сохранить" рядом с
    // полями); подвал в любом случае показывает, что несохранённое ЕСТЬ —
    // иначе взгляд на подвал не расскажет о черновике на другой вкладке.
    if (state.dirty) {
      footActions.innerHTML = `${btn("Отменить", 'id="cp-cancel"')}${btn("Сохранить", 'id="cp-save"', true)}`;
      footActions.querySelector("#cp-cancel").addEventListener("click", async () => {
        initDraft();
        await renderCard();
        renderFooter();
      });
      footActions.querySelector("#cp-save").addEventListener("click", async () => {
        const saveBtn = footActions.querySelector("#cp-save"), cancelBtn = footActions.querySelector("#cp-cancel");
        saveBtn.disabled = true; cancelBtn.disabled = true;
        setCardFieldsDisabled(true);
        try {
          await saveMain();
          await renderCard();
          renderFooter();
          // saveMain() кладёт "Сохранено."/"Добавлено." в state.status_msg,
          // но следующий полный render() может случиться намного позже
          // (например, только при уходе с карточки) — без немедленного
          // показа тут сообщение "зависало" бы и всплывало у СЛЕДУЮЩЕГО,
          // не связанного с этим действием render() (найдено живой
          // проверкой: "Добавлено." от создания контрагента вылезло много
          // позже, при уходе с карточки после правки договора).
          if (state.status_msg) { status.textContent = state.status_msg; state.status_msg = ""; }
        } catch (err) {
          // renderCard() из шаблона renderMainTab()/renderCapacityTab() —
          // поля там без атрибута disabled, так что пересоздание само
          // возвращает им доступность; state.draft при ошибке не менялся,
          // ввод не теряется. Ошибку показываем ПОСЛЕ renderFooter(),
          // иначе её тут же перекроет общее "Не сохранено: ..." (задача 3
          // — "понятная ошибка", а не молчаливый откат к пустой форме).
          await renderCard();
          renderFooter();
          status.textContent = err?.detail || err?.message || "Не удалось сохранить";
        }
      });
    } else {
      footActions.innerHTML = "";
    }
    status.textContent = parts.length === 1 ? `Не сохранено: ${parts[0].label}.` : `Не сохранено (${parts.length}): ${parts.map((p) => p.label).join(", ")}.`;
  }

  function initDraft() {
    const cp = state.editingId ? state.list.find((c) => c.id === state.editingId) : null;
    state.draft = cp
      ? { full_name: cp.full_name, short_name: cp.short_name, inn: cp.inn || "", kpp: cp.kpp || "", ogrn: cp.ogrn || "",
          legal_address: cp.legal_address || "", contact_person: cp.contact_person || "", contact_phone: cp.contact_phone || "",
          code: cp.code || "", capacity: (cp.capacity || []).map((c) => ({ ...c })) }
      : { full_name: "", short_name: "", inn: "", kpp: "", ogrn: "", legal_address: "", contact_person: "", contact_phone: "", code: "", capacity: [] };
    state.dirty = false;
  }

  async function saveMain() {
    const d = state.draft;
    if (!d.full_name.trim() || !d.short_name.trim()) throw { message: "Укажите полное и краткое наименование" };
    const snapshotJson = JSON.stringify(d);
    const snapshot = JSON.parse(snapshotJson);
    const body = {
      full_name: snapshot.full_name.trim(), short_name: snapshot.short_name.trim(),
      inn: snapshot.inn.trim() || null, kpp: snapshot.kpp.trim() || null, ogrn: snapshot.ogrn.trim() || null,
      legal_address: snapshot.legal_address.trim() || null, contact_person: snapshot.contact_person.trim() || null,
      contact_phone: snapshot.contact_phone.trim() || null, code: snapshot.code.trim() || null,
      capacity: snapshot.capacity.filter((c) => Number.isFinite(c.per_day) && c.per_day > 0),
    };
    const wasNew = !state.editingId;
    const saved = wasNew ? await api.post("/counterparties", body) : await api.patch(`/counterparties/${state.editingId}`, body);
    // Задача 4: подтверждение — из ОТВЕТА записи (полный CounterpartyOut),
    // без повторного GET /counterparties. Точечно заменяем/добавляем
    // ровно эту запись в локальном списке.
    const idx = state.list.findIndex((c) => c.id === saved.id);
    if (idx === -1) state.list.push(saved); else state.list[idx] = saved;
    state.editingId = saved.id;
    // Сверка со снимком (задача 3 — "медленная сеть"): если поля успели
    // измениться, пока шёл запрос, снимаем "грязно" только если текущее
    // состояние всё ещё совпадает с тем, что было отправлено.
    if (JSON.stringify(state.draft) === snapshotJson) state.dirty = false;
    state.status_msg = wasNew ? "Добавлено." : "Сохранено.";
  }

  function fieldRow(label, id, value, extra = "") {
    return `<label class="v2-field">${label}<input id="${id}" value="${escapeHtml(value)}" ${extra}></label>`;
  }

  async function openCard(id) {
    await withNavGuard(async () => {
      // requestLeave() при неудачном совмещённом сохранении кладёт причину
      // в state.status_msg и возвращает false — без render() здесь оно
      // осталось бы невидимым до следующего, не связанного с этим
      // действием полного рендера (та же находка, что и у "Сохранить" в
      // подвале).
      if (!(await requestLeave())) { await render(); return; }
      state.page = "edit"; state.editingId = id; state.tab = "main";
      state.contracting = emptyContracting();
      state.expandedAgreements = new Set(); state.expandedSpecs = new Set();
      state.newAgreementForm = null; state.agreementDrafts = new Map();
      state.newSpecForms = new Map(); state.specDrafts = new Map();
      state.newContractForms = new Map(); state.contractDrafts = new Map();
      state.expandedContracts = new Set(); state.contractExpandedCache = new Map();
      state.contractKey = null; state.contractDeleteReplacement = null;
      initDraft();
      state.status_msg = "";
      await render();
    });
  }

  async function backToList() {
    await withNavGuard(async () => {
      if (!(await requestLeave())) { await render(); return; }
      state.page = "list";
      await render();
    });
  }

  function renderList() {
    body.innerHTML = `
      <div class="v2-bar"><h3>Контрагенты</h3>${btn("Добавить контрагента", 'id="cp-add"', true)}</div>
      <div id="cp-list"></div>
    `;
    const listEl = body.querySelector("#cp-list");
    const canDelete = ctx.perms.isSystemAdmin || ctx.perms.dictDelete === "write";
    if (!state.list.length) {
      listEl.innerHTML = `<p class="v2-note">Контрагентов пока нет.</p>`;
    } else {
      listEl.innerHTML = state.list.map((cp) => `
        <div class="v2-perm">
          <button type="button" class="v2-link" data-open="${cp.id}" style="text-align:left"><strong>${escapeHtml(cp.short_name)}</strong>
            <small>${escapeHtml(cp.full_name)}${cp.inn ? ` · ИНН ${escapeHtml(cp.inn)}` : ""}${cp.code ? ` · код ${escapeHtml(cp.code)}` : ""}</small></button>
          ${canDelete ? trashIconHtml(`data-del="${cp.id}"`, "Удалить контрагента") : ""}
        </div>`).join("");
      listEl.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openCard(Number(el.dataset.open))));
      listEl.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(el.dataset.del);
        confirmAndDelete("counterparty", id, () => {
          const idx = state.list.findIndex((c) => c.id === id);
          if (idx !== -1) state.list.splice(idx, 1);
          state.status_msg = "Контрагент удалён.";
          render();
        });
      }));
    }
    body.querySelector("#cp-add").addEventListener("click", () => openCard(null));
  }

  function renderMainTab() {
    const el = body.querySelector("#cp-tab-body");
    const d = state.draft;
    el.innerHTML = `
      <div id="cp-main-fields">
        <div class="v2-fields">
          ${fieldRow("Код", "cpf-code", d.code, 'maxlength="10" title="Допстрока подписи изделия на схеме, до 10 символов"')}
          ${fieldRow("Краткое наименование", "cpf-short", d.short_name)}
        </div>
        <div class="v2-fields" style="margin-top:12px">
          <label class="v2-field v2-span">Полное наименование<input id="cpf-full" value="${escapeHtml(d.full_name)}"></label>
        </div>
        <div class="v2-fields" style="margin-top:12px">
          ${fieldRow("ИНН", "cpf-inn", d.inn, 'maxlength="12" inputmode="numeric" title="10 знаков у юрлица, 12 у ИП"')}
          ${fieldRow("КПП", "cpf-kpp", d.kpp, 'maxlength="9" inputmode="numeric" title="9 знаков"')}
          ${fieldRow("ОГРН", "cpf-ogrn", d.ogrn, 'maxlength="15" inputmode="numeric" title="13 знаков у юрлица, 15 у ИП (ОГРНИП)"')}
        </div>
        <div class="v2-group">Адреса</div>
        <div class="v2-fields"><label class="v2-field v2-span">Юридический адрес<input id="cpf-address" value="${escapeHtml(d.legal_address)}"></label></div>
        <div class="v2-group">Контакты</div>
        <div class="v2-fields">
          ${fieldRow("Контактное лицо", "cpf-contact-person", d.contact_person)}
          ${fieldRow("Контактный телефон", "cpf-contact-phone", d.contact_phone)}
        </div>
      </div>
      <div class="v2-auth-error" id="cpf-error"></div>
    `;
    el.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
      const key = { "cpf-code": "code", "cpf-short": "short_name", "cpf-full": "full_name", "cpf-inn": "inn",
        "cpf-kpp": "kpp", "cpf-ogrn": "ogrn", "cpf-address": "legal_address",
        "cpf-contact-person": "contact_person", "cpf-contact-phone": "contact_phone" }[inp.id];
      state.draft[key] = inp.value;
      state.dirty = true;
      renderFooter();
    }));
  }

  function objectLabel(id) {
    const o = state.objects.find((x) => x.id === id);
    return o ? `${o.project_name ? o.project_name + " · " : ""}${o.name}` : (id ? `объект №${id}` : "объект не указан");
  }

  // Раздел 2 — независимые чтения. Раньше ЛЮБОЙ отказ GET /contracts или
  // GET /specifications?agreement_id=... тихо подменялся пустым массивом
  // (`catch (e) { contracts = []; }`), а вся связка целиком помечалась
  // loaded:true — «Контрактов нет» показывалось и тогда, когда контракты
  // на самом деле просто не удалось прочитать, и починить это можно было
  // только полной перезагрузкой вкладки (force всё равно повторял бы ту
  // же одну общую попытку). Теперь у списка договоров, списка контрактов и
  // спецификаций КАЖДОГО договора — свой флаг успеха и свой текст
  // последней ошибки; отказ одного не трогает уже успешно прочитанные
  // соседние данные и не стирает то, что было показано раньше (см.
  // loadSpecsFor — при ошибке entry.specs не перезаписывается).
  async function loadAgreementsList() {
    try {
      state.contracting.agreements = await api.get(`/agreements?counterparty_id=${state.editingId}`);
      state.contracting.agreementsLoaded = true;
      state.contracting.agreementsError = null;
      return true;
    } catch (err) {
      state.contracting.agreementsError = err?.detail || err?.message || "Не удалось загрузить договоры";
      return false;
    }
  }
  async function loadContractsList() {
    try {
      const contracts = await api.get("/contracts");
      const bySpec = new Map();
      for (const c of contracts) {
        if (!bySpec.has(c.specification_id)) bySpec.set(c.specification_id, []);
        bySpec.get(c.specification_id).push(c);
      }
      state.contracting.contractsBySpec = bySpec;
      state.contracting.contractsLoaded = true;
      state.contracting.contractsError = null;
      return true;
    } catch (err) {
      state.contracting.contractsError = err?.detail || err?.message || "Не удалось загрузить контракты";
      return false;
    }
  }
  async function loadSpecsFor(agreementId) {
    const entry = state.contracting.specsByAgreement.get(agreementId) || emptySpecsEntry();
    try {
      entry.specs = await api.get(`/specifications?agreement_id=${agreementId}`);
      entry.loaded = true;
      entry.error = null;
    } catch (err) {
      // entry.specs НЕ трогаем — если раньше уже загружались, старые
      // строки остаются на экране рядом с пометкой ошибки и кнопкой
      // "Повторить", а не пропадают в пользу пустоты.
      entry.error = err?.detail || err?.message || "Не удалось загрузить спецификации";
    }
    state.contracting.specsByAgreement.set(agreementId, entry);
    return !entry.error;
  }
  // Кто ещё ни разу не пытался прочитаться (ни успеха, ни ошибки) — только
  // такие куски читаются САМИ, при первом открытии вкладки. Кусок, уже
  // провалившийся однажды, сам себя больше не повторяет (не долбит сервер
  // тем же отказавшим запросом при каждом переключении на вкладку) — ждёт
  // явного клика "Повторить" (см. retryPiece).
  function needsInitialContractingLoad() {
    if (!state.contracting.agreementsLoaded && !state.contracting.agreementsError) return true;
    if (!state.contracting.contractsLoaded && !state.contracting.contractsError) return true;
    if (!state.objectsLoaded && !state.objectsError) return true;
    return state.contracting.agreements.some((a) => !state.contracting.specsByAgreement.get(a.id));
  }
  async function ensureContractingLoaded(force) {
    const tasks = [];
    if (force || (!state.objectsLoaded && !state.objectsError)) tasks.push(ensureObjects(force));
    if (force || (!state.contracting.agreementsLoaded && !state.contracting.agreementsError)) tasks.push(loadAgreementsList());
    if (force || (!state.contracting.contractsLoaded && !state.contracting.contractsError)) tasks.push(loadContractsList());
    await Promise.all(tasks);
    // Спецификации — уже ПОСЛЕ того, как известен актуальный список
    // договоров (agreements мог обновиться строкой выше).
    const specTasks = state.contracting.agreements
      .filter((a) => force || !state.contracting.specsByAgreement.get(a.id))
      .map((a) => loadSpecsFor(a.id));
    await Promise.all(specTasks);
  }
  // Повторить РОВНО тот кусок, который отказал — не всю связку разом:
  // общий "Повторить" на всю вкладку заново дёргал бы уже успешно
  // прочитанные договоры и все спецификации целиком, включая те, что
  // ни разу не отказывали.
  async function retryPiece(kind, agreementId) {
    if (kind === "objects") await ensureObjects(true);
    else if (kind === "agreements") await loadAgreementsList();
    else if (kind === "contracts") await loadContractsList();
    else if (kind === "specs") await loadSpecsFor(agreementId);
    await renderContractingTab();
    renderFooter();
  }

  // ---------- Черновик нового договора ----------
  //
  // draft._inFlight — общее на ВСЕ 6 функций сохранения (договор/
  // спецификация/контракт × новый/правка) обещание текущей записи.
  // Устанавливается СИНХРОННО, вместе с draft.saving и блокировкой полей,
  // ДО первого await — повторный вызов (второй клик, диалог выхода,
  // сработавший тем же кликом) получает ТО ЖЕ обещание вместо второго
  // POST/PATCH (задача 1, приёмка «двойной клик — ровно один запрос»).
  // Форма/кнопка/удаление блокируются здесь же, а не в обработчике клика —
  // тогда блокировка одинаково работает и для диалога "Несохранённые
  // изменения" (requestLeave → resolveDirty → part.save()), который эту
  // функцию вызывает напрямую, в обход кнопки.
  async function submitNewAgreement() {
    const draft = state.newAgreementForm;
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер договора"; throw { message: draft.error }; }
    if (!draft.objectId) { draft.error = "Выберите объект, на который заключён договор"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
    setControlsDisabled("#cp-new-agreement-object, #cp-new-agreement-number, #cp-new-agreement-date, #cp-add-agreement, #cp-new-agreement-cancel", true);
    setButtonSaving("#cp-add-agreement", true);
    draft._inFlight = (async () => {
      try {
        const created = await api.post("/agreements", {
          counterparty_id: state.editingId, number: snapshot.number.trim(),
          object_id: Number(snapshot.objectId), agreement_date: snapshot.date || null,
        });
        state.contracting.agreements.push(created);
        // Новый договор ЗАВЕДОМО без спецификаций — это подтверждённое
        // "пусто", а не "ещё не прочитано": loaded:true сразу, без
        // отдельного (и заведомо лишнего) запроса за пустым списком.
        state.contracting.specsByAgreement.set(created.id, { specs: [], loaded: true, error: null });
        const cur = state.newAgreementForm;
        const stillSame = cur === draft && cur.number === snapshot.number && cur.date === snapshot.date && cur.objectId === snapshot.objectId;
        if (stillSame) { state.newAgreementForm = null; }
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        if (state.newAgreementForm === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось добавить договор";
          delete draft._inFlight;
        }
        throw err;
      }
    })();
    return draft._inFlight;
  }

  // ---------- Черновик правки существующего договора ----------

  async function saveAgreementDraft(id) {
    const draft = state.agreementDrafts.get(id);
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер договора"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
    setControlsDisabled(`[data-a-number="${id}"], [data-a-date="${id}"], [data-a-object="${id}"], [data-save-agreement="${id}"], [data-del-agreement="${id}"]`, true);
    setButtonSaving(`[data-save-agreement="${id}"]`, true);
    draft._inFlight = (async () => {
      try {
        const updated = await api.patch(`/agreements/${id}`, {
          counterparty_id: state.editingId, number: snapshot.number.trim(),
          object_id: snapshot.objectId ? Number(snapshot.objectId) : null,
          agreement_date: snapshot.date || null,
        });
        const idx = state.contracting.agreements.findIndex((a) => a.id === id);
        if (idx !== -1) state.contracting.agreements[idx] = updated;
        const cur = state.agreementDrafts.get(id);
        const stillSame = cur && cur.number === snapshot.number && cur.date === snapshot.date && cur.objectId === snapshot.objectId;
        if (stillSame) state.agreementDrafts.delete(id);
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        const cur = state.agreementDrafts.get(id);
        if (cur === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось сохранить договор";
          delete draft._inFlight;
        }
        throw err;
      }
    })();
    return draft._inFlight;
  }

  // ---------- Черновик новой спецификации (под конкретным договором) ----------

  async function submitNewSpec(agreementId) {
    const draft = state.newSpecForms.get(agreementId);
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер спецификации"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
    setControlsDisabled(`[data-spec-number="${agreementId}"], [data-spec-date="${agreementId}"], [data-add-spec="${agreementId}"], [data-spec-cancel="${agreementId}"]`, true);
    setButtonSaving(`[data-add-spec="${agreementId}"]`, true);
    draft._inFlight = (async () => {
      try {
        const created = await api.post("/specifications", {
          agreement_id: agreementId, number: snapshot.number.trim(), specification_date: snapshot.date || null,
        });
        if (!state.contracting.specsByAgreement.has(agreementId)) state.contracting.specsByAgreement.set(agreementId, emptySpecsEntry());
        const entry = state.contracting.specsByAgreement.get(agreementId);
        entry.specs.push(created);
        entry.loaded = true;
        const cur = state.newSpecForms.get(agreementId);
        const stillSame = cur && cur.number === snapshot.number && cur.date === snapshot.date;
        if (stillSame) state.newSpecForms.delete(agreementId);
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        const cur = state.newSpecForms.get(agreementId);
        if (cur === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось добавить спецификацию";
          delete draft._inFlight;
        }
        throw err;
      }
    })();
    return draft._inFlight;
  }

  // ---------- Черновик правки существующей спецификации ----------

  async function saveSpecDraft(id) {
    const draft = state.specDrafts.get(id);
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер спецификации"; throw { message: draft.error }; }
    const { agreementId } = findSpecAndAgreementId(id);
    const snapshot = { ...draft };
    draft.saving = true;
    setControlsDisabled(`[data-s-number="${id}"], [data-s-date="${id}"], [data-save-spec="${id}"], [data-del-spec="${id}"]`, true);
    setButtonSaving(`[data-save-spec="${id}"]`, true);
    draft._inFlight = (async () => {
      try {
        const updated = await api.patch(`/specifications/${id}`, {
          agreement_id: agreementId, number: snapshot.number.trim(), specification_date: snapshot.date || null,
        });
        const specs = state.contracting.specsByAgreement.get(agreementId)?.specs || [];
        const idx = specs.findIndex((s) => s.id === id);
        if (idx !== -1) specs[idx] = updated;
        const cur = state.specDrafts.get(id);
        const stillSame = cur && cur.number === snapshot.number && cur.date === snapshot.date;
        if (stillSame) state.specDrafts.delete(id);
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        const cur = state.specDrafts.get(id);
        if (cur === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось сохранить спецификацию";
          delete draft._inFlight;
        }
        throw err;
      }
    })();
    return draft._inFlight;
  }

  // ---------- Удаление — общий диалог V2 вместо confirm()/alert(),
  // точечная чистка кэша при подтверждённом сервером успехе (задача 4) ----------

  async function confirmAndDelete(kind, id, onSuccess) {
    let plan;
    try { plan = await api.get(`/dictionaries/${kind}/${id}/delete-plan`); }
    catch (err) { await showInfoDialog(err?.detail || err?.message || "Не удалось получить сведения об удалении"); return; }
    if (plan.blockers && plan.blockers.length) {
      await showInfoDialog(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
      return;
    }
    const label = kind === "counterparty" ? "контрагента" : kind === "agreement" ? "договор" : "спецификацию";
    const confirmed = await showConfirmDialog(`Удалить ${label}?`, { confirmLabel: "Удалить" });
    if (!confirmed) return;
    try {
      await api.post(`/dictionaries/${kind}/${id}/delete`, { replacements: {}, mode: "replace" });
      await onSuccess();
    } catch (err) {
      await showInfoDialog(err?.detail || err?.message || "Не удалось удалить");
    }
  }

  async function renderContractingTab() {
    const el = body.querySelector("#cp-tab-body");
    if (!state.editingId) {
      el.innerHTML = `<p class="v2-note">Договоры заводятся после сохранения контрагента — заполните «Основное» и нажмите «Сохранить».</p>`;
      return;
    }
    // Список договоров — единственное, без чего вкладку вообще нечем
    // рисовать. Контракты/спецификации/объекты могли не прочитаться —
    // это НЕ повод держать всю вкладку на "Загрузка…"; buildContractingHtml
    // сама показывает ошибку и "Повторить" рядом с тем местом, которое не
    // прочиталось (объект в селекте, спецификации конкретного договора,
    // список контрактов конкретной спецификации), а не вместо всей формы.
    if (needsInitialContractingLoad()) {
      el.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
      await ensureContractingLoaded();
    }
    if (!state.contracting.agreementsLoaded) {
      el.innerHTML = `<p class="v2-note">${escapeHtml(state.contracting.agreementsError || "Не удалось загрузить договоры")} ${btn("Повторить", 'id="cp-contracting-retry"')}</p>`;
      el.querySelector("#cp-contracting-retry").addEventListener("click", () => retryPiece("agreements"));
      return;
    }
    el.innerHTML = buildContractingHtml();
    wireContractingHandlers(el);
  }

  function agreementFieldValues(a) {
    const d = state.agreementDrafts.get(a.id);
    return d ? { number: d.number, date: d.date, objectId: d.objectId, error: d.error, saving: d.saving, dirty: true }
      : { number: a.number, date: a.agreement_date || "", objectId: a.object_id ?? "", error: "", saving: false, dirty: false };
  }
  function specFieldValues(s) {
    const d = state.specDrafts.get(s.id);
    return d ? { number: d.number, date: d.date, error: d.error, saving: d.saving, dirty: true }
      : { number: s.number, date: s.specification_date || "", error: "", saving: false, dirty: false };
  }

  // ---------- Полный редактор контракта (раздел 6) ----------
  //
  // Тот же контракт (/contracts, ContractIn/ContractOut, app/contracts.py),
  // что и в V1 (#contract-edit-backdrop, openContractEdit в app.js) — здесь
  // нет отдельной модалки: контракт заводится и правится ПРЯМО под своей
  // спецификацией (в V2 нет "текущего объекта" тулбара, из-за которого V1
  // открывает контракт глобальной формой со свободным каскадом
  // Контрагент→Договор→Спецификация; спецификация уже известна из места, где
  // открыта форма — своя бизнес-логика не изобреталась, изменилась только
  // точка входа). Сознательно не перенесена вкладка "Развёрнуто" (элементы
  // схемы, привязанные к контракту, с правкой плановой даты) — V2 нигде не
  // показывает схему/изделия, переносить только эту таблицу ради одной
  // формы значило бы тащить отдельный кусок функциональности не по разделу.
  //
  // Наименование контракта генерируется СЕРВЕРОМ (build_contract_name,
  // app/contracts.py) — buildContractNamePreview ниже дублирует ровно эту
  // формулу для живого превью до сохранения, тем же приёмом, что и в V1
  // (updateContractNamePreview): авторитетное имя всегда приходит в ответе
  // мутации.
  function ruDateFromIso(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
  }
  function documentLabel(number, dateIso) {
    const d = ruDateFromIso(dateIso);
    return d ? `${number} от ${d}` : number;
  }
  function buildContractNamePreview(agreement, spec, theme) {
    const cp = state.list.find((x) => x.id === state.editingId);
    if (!cp || !agreement || !spec) return "";
    let name = `${cp.short_name}/${documentLabel(agreement.number, agreement.agreement_date)}/${documentLabel(spec.number, spec.specification_date)}`;
    if (theme && theme.trim()) name += ` (${theme.trim()})`;
    return name;
  }

  // Архивный контракт (правило сервера, app/contracts.py _guard_archivable):
  // ставить можно только там, где не осталось привязанных изделий; снимать
  // можно всегда. Проверяем по СОХРАНЁННОМУ contract.is_archived, а не по
  // текущей галочке черновика — тот же расчёт, что updateArchiveHint в V1.
  function contractArchiveHint(contract) {
    const linked = (contract && contract.linked_elements) || 0;
    const blocks = linked > 0 && !contract.is_archived;
    return {
      blocks,
      text: blocks
        ? `Перевести в архив нельзя: к контракту привязано изделий — ${linked}. Сначала переназначьте их на другой контракт или снимите привязку в текущем интерфейсе.`
        : "Архивный контракт не предлагается при смене статуса и не участвует в отчётах и дашбордах; в справочнике и в истории статусов он остаётся.",
    };
  }

  function contractFieldsFromSaved(c) {
    return {
      specificationId: c.specification_id,
      theme: c.theme || "", isArchived: !!c.is_archived,
      lines: (c.lines || []).map((l) => ({ elementType: l.element_type || "", mark: l.mark || "", quantity: l.quantity != null ? String(l.quantity) : "" })),
      incidents: (c.incidents || []).map((i) => ({
        elementType: i.element_type || "", quantity: i.quantity != null ? String(i.quantity) : "",
        incidentDate: (i.incident_date || "").slice(0, 10), description: i.description || "",
      })),
      capacity: (c.capacity || []).map((cc) => ({ elementType: cc.element_type, perDay: cc.per_day != null ? String(cc.per_day) : "" })),
    };
  }
  function contractDraftFieldsJson(d) {
    return JSON.stringify({ specificationId: d.specificationId, theme: d.theme, isArchived: d.isArchived, lines: d.lines, incidents: d.incidents, capacity: d.capacity });
  }
  function isContractDraftDirty(draft) {
    return draft._original !== undefined && contractDraftFieldsJson(draft) !== draft._original;
  }
  // Черновик создаётся ЛЕНИВО — при первой правке любого поля, не при
  // раскрытии панели контракта: до этого момента форма читает значения
  // прямо из сохранённого контракта (см. contractFieldValues).
  function ensureContractDraft(id) {
    if (!state.contractDrafts.has(id)) {
      const fields = contractFieldsFromSaved(findContract(id) || {});
      state.contractDrafts.set(id, { ...fields, _original: JSON.stringify(fields), error: "", saving: false });
    }
    return state.contractDrafts.get(id);
  }
  function contractFieldValues(c) {
    const d = state.contractDrafts.get(c.id);
    if (d) return { specificationId: d.specificationId, theme: d.theme, isArchived: d.isArchived, lines: d.lines, incidents: d.incidents, capacity: d.capacity, error: d.error, saving: d.saving, dirty: isContractDraftDirty(d) };
    return { ...contractFieldsFromSaved(c), error: "", saving: false, dirty: false };
  }
  // specificationId — начальная спецификация (место, где нажали "+
  // Контракт"); задача 4Б — её МОЖНО сменить прямо в рабочем пространстве
  // (см. requisites-селекты договор/спецификация), ключ Map'ы при этом не
  // меняется — это только адрес черновика в состоянии модуля, а не то, на
  // какую спецификацию он в итоге сохранится (см. submitNewContract).
  function emptyContractDraft(specificationId) {
    return { specificationId, theme: "", isArchived: false, lines: [{ elementType: "", mark: "", quantity: "" }], incidents: [], capacity: [], error: "", saving: false };
  }
  function contractDraftForKey(key) {
    return key.startsWith("new:") ? state.newContractForms.get(Number(key.slice(4))) : ensureContractDraft(Number(key.slice(5)));
  }
  // Только ЧТЕНИЕ, черновик не создаёт (в отличие от contractDraftForKey) —
  // для мест, где спецификация нужна просто чтобы показать текущий путь
  // (хлебные крошки, превью имени), а раскрытие/рендер не должны сами по
  // себе заводить черновик.
  function currentSpecIdForKey(key) {
    if (key.startsWith("new:")) {
      const specIdFromKey = Number(key.slice(4));
      const draft = state.newContractForms.get(specIdFromKey);
      return draft ? draft.specificationId : specIdFromKey;
    }
    const id = Number(key.slice(5));
    const draft = state.contractDrafts.get(id);
    if (draft) return draft.specificationId;
    const c = findContract(id);
    return c ? c.specification_id : null;
  }
  function parseRowKey(v) {
    const idx = v.lastIndexOf("|");
    return { key: v.slice(0, idx), i: Number(v.slice(idx + 1)) };
  }
  function capacityBaseFor(elementType) {
    const cp = state.list.find((x) => x.id === state.editingId);
    const row = (cp && cp.capacity || []).find((c) => c.element_type === elementType);
    return row ? row.per_day : "не задана";
  }

  function buildContractBody(draft) {
    const lines = draft.lines
      .map((l) => ({ element_type: (l.elementType || "").trim() || null, mark: (l.mark || "").trim() || null, quantity: Number(l.quantity) || 0 }))
      .filter((l) => l.element_type || l.mark);
    const incidents = draft.incidents
      .map((i) => ({ element_type: (i.elementType || "").trim(), quantity: Number(i.quantity) || 0, incident_date: i.incidentDate, description: (i.description || "").trim() || null }))
      .filter((i) => i.element_type && i.incidentDate);
    const capacity = draft.capacity
      .map((c) => ({ element_type: c.elementType, per_day: Number(c.perDay), comment: null }))
      .filter((c) => c.element_type && Number.isFinite(c.per_day) && c.per_day > 0);
    return { specification_id: draft.specificationId, theme: (draft.theme || "").trim() || null, is_archived: !!draft.isArchived, lines, incidents, capacity };
  }

  function pushContractToCache(c) {
    if (!state.contracting.contractsBySpec.has(c.specification_id)) state.contracting.contractsBySpec.set(c.specification_id, []);
    state.contracting.contractsBySpec.get(c.specification_id).push(c);
  }
  function removeContractFromCache(id, specificationId) {
    const list = state.contracting.contractsBySpec.get(specificationId);
    if (!list) return;
    const idx = list.findIndex((x) => x.id === id);
    if (idx !== -1) list.splice(idx, 1);
  }

  async function submitNewContract(mapKey) {
    const draft = state.newContractForms.get(mapKey);
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    if (!draft.specificationId) { draft.error = "Выберите спецификацию"; throw { message: draft.error }; }
    const body = buildContractBody(draft);
    if (!body.lines.length) { draft.error = "Добавьте хотя бы одну позицию (тип элемента или марка)"; throw { message: draft.error }; }
    const snapshot = contractDraftFieldsJson(draft);
    draft.saving = true;
    lockContractWorkspace(true);
    draft._inFlight = (async () => {
      try {
        const created = await api.post("/contracts", body);
        pushContractToCache(created);
        const cur = state.newContractForms.get(mapKey);
        const stillSame = cur === draft && contractDraftFieldsJson(cur) === snapshot;
        if (stillSame) { state.newContractForms.delete(mapKey); state.contractKey = `edit:${created.id}`; }
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        const cur = state.newContractForms.get(mapKey);
        if (cur === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось добавить контракт";
          delete draft._inFlight;
        }
        throw err;
      } finally {
        lockContractWorkspace(false);
      }
    })();
    return draft._inFlight;
  }

  async function saveContractDraft(id) {
    const draft = state.contractDrafts.get(id);
    if (!draft) return;
    if (draft._inFlight) return draft._inFlight;
    draft.error = "";
    const before = findContract(id);
    const previousSpecId = before ? before.specification_id : draft.specificationId;
    if (!draft.specificationId) { draft.error = "Выберите спецификацию"; throw { message: draft.error }; }
    const body = buildContractBody(draft);
    if (!body.lines.length) { draft.error = "Добавьте хотя бы одну позицию (тип элемента или марка)"; throw { message: draft.error }; }
    const snapshot = contractDraftFieldsJson(draft);
    draft.saving = true;
    lockContractWorkspace(true);
    draft._inFlight = (async () => {
      try {
        const updated = await api.patch(`/contracts/${id}`, body);
        // Переназначение на другую спецификацию (задача 4Б) двигает запись
        // между списками кэша — иначе она осталась бы висеть под старой
        // спецификацией ВТОРОЙ копией, пока не перечитается с сервера.
        // Убираем из старого места безусловно (и когда спецификация не
        // менялась — это то же самое, что заменить запись на месте).
        removeContractFromCache(id, previousSpecId);
        pushContractToCache(updated);
        const cur = state.contractDrafts.get(id);
        const stillSame = cur && contractDraftFieldsJson(cur) === snapshot;
        if (stillSame) state.contractDrafts.delete(id);
        else if (cur) { cur.saving = false; delete cur._inFlight; }
      } catch (err) {
        const cur = state.contractDrafts.get(id);
        if (cur === draft) {
          draft.saving = false;
          draft.error = err?.detail || err?.message || "Не удалось сохранить контракт";
          delete draft._inFlight;
        }
        throw err;
      } finally {
        lockContractWorkspace(false);
      }
    })();
    return draft._inFlight;
  }

  // Удаление контракта — отдельно от общего confirmAndDelete: контракт
  // единственный из перенесённых видов, у которого delete-plan умеет
  // "needs_replacement" (изделия схемы, привязанные к контракту, нужно
  // сперва перенести на другой контракт той же спецификации — см.
  // app/dict_delete.py _contract_candidates/_contract_repoint). Выбор
  // замены — отдельная форма, которой в V2 пока нет; честно объясняем
  // ограничение и отправляем в текущий интерфейс, а не притворяемся, что
  // умеем то, чего не умеем.
  async function confirmAndDeleteContract(id, onSuccess) {
    let plan;
    try { plan = await api.get(`/dictionaries/contract/${id}/delete-plan`); }
    catch (err) { await showInfoDialog(err?.detail || err?.message || "Не удалось получить сведения об удалении"); return; }
    if (plan.blockers && plan.blockers.length) {
      await showInfoDialog(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
      return;
    }
    if (plan.plan && plan.plan.needs_replacement) {
      await showInfoDialog("К контракту привязаны изделия схемы. Перенос привязки на другой контракт этой спецификации пока доступен только в текущем интерфейсе (Контракты → удаление) — удалите контракт там, затем список здесь обновится.");
      return;
    }
    const confirmed = await showConfirmDialog("Удалить контракт?", { confirmLabel: "Удалить" });
    if (!confirmed) return;
    try {
      await api.post(`/dictionaries/contract/${id}/delete`, { replacements: {}, mode: "replace" });
      await onSuccess();
    } catch (err) {
      await showInfoDialog(err?.detail || err?.message || "Не удалось удалить");
    }
  }

  // Раздел 3: постоянные заголовки столбцов (не placeholder вместо
  // подписи) — обычные <table class="v2-table"> вместо строк-<div>, тем же
  // визуальным языком, что и остальные таблицы V2.
  function contractLineRowHtml(key, i, l, saving) {
    return `<tr>
      <td><input data-line-type="${key}|${i}" placeholder="например, Колонна" value="${escapeHtml(l.elementType)}" ${saving ? "disabled" : ""}></td>
      <td><input data-line-mark="${key}|${i}" placeholder="необязательно" value="${escapeHtml(l.mark)}" ${saving ? "disabled" : ""}></td>
      <td><input data-line-qty="${key}|${i}" type="number" min="0" value="${escapeHtml(l.quantity)}" ${saving ? "disabled" : ""} style="width:90px"></td>
      <td>${trashIconHtml(`data-line-remove="${key}|${i}"`, "Убрать позицию")}</td>
    </tr>`;
  }
  function contractIncidentRowHtml(key, i, inc, saving) {
    return `<tr>
      <td><input data-inc-date="${key}|${i}" type="date" value="${escapeHtml(inc.incidentDate)}" ${saving ? "disabled" : ""}></td>
      <td><input data-inc-type="${key}|${i}" placeholder="тип элемента" value="${escapeHtml(inc.elementType)}" ${saving ? "disabled" : ""}></td>
      <td><input data-inc-qty="${key}|${i}" type="number" min="0" value="${escapeHtml(inc.quantity)}" ${saving ? "disabled" : ""} style="width:90px"></td>
      <td><input data-inc-desc="${key}|${i}" placeholder="описание" value="${escapeHtml(inc.description)}" ${saving ? "disabled" : ""}></td>
      <td>${trashIconHtml(`data-inc-remove="${key}|${i}"`, "Убрать инцидент")}</td>
    </tr>`;
  }
  function contractCapacityRowHtml(key, i, c, saving) {
    return `<tr>
      <td>${escapeHtml(c.elementType)}</td>
      <td><input data-cap-per-day="${key}|${i}" type="number" min="0" step="0.1" value="${escapeHtml(c.perDay)}" ${saving ? "disabled" : ""} style="width:90px"></td>
      <td class="v2-muted">${escapeHtml(capacityBaseFor(c.elementType))}</td>
      <td>${trashIconHtml(`data-cap-remove="${key}|${i}"`, "Убрать переопределение")}</td>
    </tr>`;
  }

  // Селект объекта в форме договора — тем же приёмом, что и остальные
  // куски: отказ чтения объектов показывается РЯДОМ с селектом ("Повторить"
  // читает только /objects), а не молчаливым пустым списком опций.
  function objectSelectHtml(attr, selectedId, disabled) {
    return `<select ${attr} ${disabled ? "disabled" : ""}><option value="">— выберите объект —</option>
      ${state.objects.map((o) => `<option value="${o.id}" ${String(selectedId) === String(o.id) ? "selected" : ""}>${escapeHtml(objectLabel(o.id))}</option>`).join("")}
      </select>
      ${state.objectsError ? `<span class="v2-auth-error">${escapeHtml(state.objectsError)} ${btn("Повторить", 'data-objects-retry="1"')}</span>` : ""}`;
  }

  function buildContractingHtml() {
    const { agreements, specsByAgreement, contractsBySpec } = state.contracting;
    const newForm = state.newAgreementForm;
    return `
      ${state.contracting.contractsError ? `<p class="v2-note">Контракты: ${escapeHtml(state.contracting.contractsError)}${state.contracting.contractsLoaded ? " (показаны прежние данные)" : ""} ${btn("Повторить", 'id="cp-contracts-retry"')}</p>` : ""}
      <div class="v2-inline" style="margin-bottom:12px">${newForm ? "" : btn("+ Договор", 'id="cp-new-agreement-toggle"')}</div>
      ${newForm ? `
      <div id="cp-new-agreement-form" class="v2-inline">
        ${objectSelectHtml('id="cp-new-agreement-object"', newForm.objectId, newForm.saving)}
        <input id="cp-new-agreement-number" placeholder="номер договора" value="${escapeHtml(newForm.number)}" ${newForm.saving ? "disabled" : ""}>
        <input id="cp-new-agreement-date" type="date" value="${escapeHtml(newForm.date)}" ${newForm.saving ? "disabled" : ""}>
        ${btn("Добавить", 'id="cp-add-agreement"', true)}${btn("Отмена", 'id="cp-new-agreement-cancel"')}
        <span class="v2-auth-error" id="cp-agreement-error">${escapeHtml(newForm.error || "")}</span>
      </div>` : ""}
      <div id="cp-agreements-list">
        ${!agreements.length ? '<p class="v2-note">нет договоров</p>' : agreements.map((a) => {
          const av = agreementFieldValues(a);
          const specsEntry = specsByAgreement.get(a.id) || emptySpecsEntry();
          const specs = specsEntry.specs || [];
          const newSpecForm = state.newSpecForms.get(a.id);
          return `
          <details class="v2-agreement" data-agreement="${a.id}" ${state.expandedAgreements.has(a.id) ? "open" : ""}>
            <summary>Договор <strong>${escapeHtml(a.number)}</strong> ${fmtDate(a.agreement_date)} — ${escapeHtml(objectLabel(a.object_id))}${av.dirty ? " · не сохранено" : ""}
              ${trashIconHtml(`data-del-agreement="${a.id}"`, "Удалить договор")}</summary>
            <div class="v2-inline" style="margin:10px 0">
              <input data-a-number="${a.id}" value="${escapeHtml(av.number)}" placeholder="номер" ${av.saving ? "disabled" : ""}>
              <input data-a-date="${a.id}" type="date" value="${escapeHtml(av.date)}" ${av.saving ? "disabled" : ""}>
              ${objectSelectHtml(`data-a-object="${a.id}"`, av.objectId, av.saving)}
              ${btn("Сохранить", `data-save-agreement="${a.id}"`, true)}
              <span class="v2-auth-error" data-a-error="${a.id}">${escapeHtml(av.error || "")}</span>
            </div>
            <div class="v2-inline" style="margin-bottom:8px">${newSpecForm ? "" : btn("+ Спецификация", `data-new-spec-toggle="${a.id}"`)}</div>
            ${newSpecForm ? `
            <div data-new-spec-form="${a.id}" class="v2-inline">
              <input data-spec-number="${a.id}" placeholder="номер" value="${escapeHtml(newSpecForm.number)}" ${newSpecForm.saving ? "disabled" : ""}>
              <input data-spec-date="${a.id}" type="date" value="${escapeHtml(newSpecForm.date)}" ${newSpecForm.saving ? "disabled" : ""}>
              ${btn("Добавить", `data-add-spec="${a.id}"`, true)}${btn("Отмена", `data-spec-cancel="${a.id}"`)}
              <span class="v2-auth-error" data-spec-form-error="${a.id}">${escapeHtml(newSpecForm.error || "")}</span>
            </div>` : ""}
            ${specsEntry.error ? `<p class="v2-note">${escapeHtml(specsEntry.error)}${specsEntry.loaded ? " (показаны прежние данные)" : ""} ${btn("Повторить", `data-specs-retry="${a.id}"`)}</p>` : ""}
            ${specs.length ? specs.map((s) => {
              const sv = specFieldValues(s);
              const contracts = contractsBySpec.get(s.id) || [];
              return `
              <details class="v2-agreement v2-agreement-nested" data-spec="${s.id}" ${state.expandedSpecs.has(s.id) ? "open" : ""}>
                <summary>Спецификация <strong>${escapeHtml(s.number)}</strong> ${fmtDate(s.specification_date)}${sv.dirty ? " · не сохранено" : ""}
                  ${trashIconHtml(`data-del-spec="${s.id}"`, "Удалить спецификацию")}</summary>
                <div class="v2-inline" style="margin:10px 0">
                  <input data-s-number="${s.id}" value="${escapeHtml(sv.number)}" placeholder="номер" ${sv.saving ? "disabled" : ""}>
                  <input data-s-date="${s.id}" type="date" value="${escapeHtml(sv.date)}" ${sv.saving ? "disabled" : ""}>
                  ${btn("Сохранить", `data-save-spec="${s.id}"`, true)}
                  <span class="v2-auth-error" data-s-error="${s.id}">${escapeHtml(sv.error || "")}</span>
                </div>
                ${state.newContractForms.has(s.id)
                  ? `<p class="v2-note">Есть неотправленный новый контракт — <button type="button" class="v2-link" data-c-open="new:${s.id}">продолжить</button></p>`
                  : `<div class="v2-inline" style="margin-bottom:8px">${btn("+ Контракт", `data-c-new="${s.id}"`)}</div>`}
                ${contracts.length ? contracts.map((c) => {
                  const cv = contractFieldValues(c);
                  return `
                  <details class="v2-agreement v2-agreement-nested" data-contract="${c.id}" ${state.expandedContracts.has(c.id) ? "open" : ""}>
                    <summary>Контракт ${c.theme ? `«${escapeHtml(c.theme)}»` : "без темы"}
                      <small>${c.lines?.length ? `позиций: ${c.lines.length}, всего изделий: ${c.lines.reduce((s2, l) => s2 + (l.quantity || 0), 0)}` : "без позиций"}</small>${cv.dirty ? " · не сохранено" : ""}</summary>
                    <p class="v2-muted" style="margin:8px 0"><button type="button" class="v2-link" data-c-open="edit:${c.id}">Открыть контракт →</button></p>
                  </details>`;
                }).join("") : (state.contracting.contractsLoaded && !state.contracting.contractsError
                    ? '<p class="v2-note">контрактов нет</p>'
                    : '<p class="v2-muted">Список контрактов не обновлён — см. сообщение выше.</p>')}
              </details>`;
            }).join("") : (specsEntry.loaded && !specsEntry.error ? '<p class="v2-note">нет спецификаций</p>' : "")}
          </details>`;
        }).join("")}
      </div>
    `;
  }

  function wireContractingHandlers(el) {
    el.querySelector("#cp-new-agreement-toggle")?.addEventListener("click", () => {
      state.newAgreementForm = { number: "", date: "", objectId: "", error: "", saving: false };
      renderContractingTab();
    });
    el.querySelector("#cp-new-agreement-cancel")?.addEventListener("click", () => {
      // Кнопка и так задизейблена на время записи (setControlsDisabled в
      // submitNewAgreement), проверка здесь — подстраховка на случай гонки
      // между событием клика и синхронной блокировкой.
      if (state.newAgreementForm?.saving) return;
      state.newAgreementForm = null;
      renderContractingTab();
    });
    el.querySelector("#cp-new-agreement-number")?.addEventListener("input", (e) => { state.newAgreementForm.number = e.target.value; renderFooter(); });
    el.querySelector("#cp-new-agreement-date")?.addEventListener("input", (e) => { state.newAgreementForm.date = e.target.value; renderFooter(); });
    el.querySelector("#cp-new-agreement-object")?.addEventListener("change", (e) => { state.newAgreementForm.objectId = e.target.value; renderFooter(); });
    el.querySelector("#cp-add-agreement")?.addEventListener("click", async () => {
      try { await submitNewAgreement(); } catch (err) { /* ошибка уже в newAgreementForm.error */ }
      await renderContractingTab();
      renderFooter();
    });

    el.querySelectorAll("[data-del-agreement]").forEach((b) => b.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.delAgreement);
      if (state.agreementDrafts.get(id)?.saving) return; // тот же случай, подстраховка
      await confirmAndDelete("agreement", id, async () => {
        const idx = state.contracting.agreements.findIndex((a) => a.id === id);
        if (idx !== -1) state.contracting.agreements.splice(idx, 1);
        // Каскад — как на сервере (удаление договора уносит с собой его
        // спецификации, а с ними — их контракты): чистим ВСЕ дочерние
        // черновики/раскрытия на обоих уровнях, иначе осиротевший
        // черновик спецификации ИЛИ контракта остался бы висеть в
        // collectDirtyParts() и требовал бы сохранить то, чего больше нет.
        for (const s of (state.contracting.specsByAgreement.get(id)?.specs || [])) {
          for (const c of (state.contracting.contractsBySpec.get(s.id) || [])) {
            state.contractDrafts.delete(c.id);
            state.expandedContracts.delete(c.id);
          }
          state.newContractForms.delete(s.id);
          state.contracting.contractsBySpec.delete(s.id);
          state.specDrafts.delete(s.id);
          state.expandedSpecs.delete(s.id);
        }
        state.contracting.specsByAgreement.delete(id);
        state.agreementDrafts.delete(id);
        state.newSpecForms.delete(id);
        state.expandedAgreements.delete(id);
        await renderContractingTab();
        renderFooter();
      });
    }));
    el.querySelectorAll("[data-a-number]").forEach((inp) => inp.addEventListener("input", () => {
      const id = Number(inp.dataset.aNumber);
      const draft = ensureAgreementDraft(id);
      draft.number = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-a-date]").forEach((inp) => inp.addEventListener("input", () => {
      const id = Number(inp.dataset.aDate);
      const draft = ensureAgreementDraft(id);
      draft.date = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-a-object]").forEach((sel) => sel.addEventListener("change", () => {
      const id = Number(sel.dataset.aObject);
      const draft = ensureAgreementDraft(id);
      draft.objectId = sel.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-save-agreement]").forEach((b) => b.addEventListener("click", async () => {
      const id = Number(b.dataset.saveAgreement);
      try { await saveAgreementDraft(id); } catch (err) { /* ошибка уже в draft.error */ }
      await renderContractingTab();
      renderFooter();
    }));

    el.querySelectorAll("[data-new-spec-toggle]").forEach((b) => b.addEventListener("click", () => {
      const id = Number(b.dataset.newSpecToggle);
      state.newSpecForms.set(id, { number: "", date: "", error: "", saving: false });
      renderContractingTab();
    }));
    el.querySelectorAll("[data-spec-cancel]").forEach((b) => b.addEventListener("click", () => {
      const id = Number(b.dataset.specCancel);
      if (state.newSpecForms.get(id)?.saving) return;
      state.newSpecForms.delete(id);
      renderContractingTab();
    }));
    el.querySelectorAll("[data-spec-number]").forEach((inp) => inp.addEventListener("input", () => {
      state.newSpecForms.get(Number(inp.dataset.specNumber)).number = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-spec-date]").forEach((inp) => inp.addEventListener("input", () => {
      state.newSpecForms.get(Number(inp.dataset.specDate)).date = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-add-spec]").forEach((b) => b.addEventListener("click", async () => {
      const agreementId = Number(b.dataset.addSpec);
      try { await submitNewSpec(agreementId); } catch (err) { /* ошибка уже в форме */ }
      await renderContractingTab();
      renderFooter();
    }));
    el.querySelectorAll("[data-del-spec]").forEach((b) => b.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = Number(b.dataset.delSpec);
      if (state.specDrafts.get(id)?.saving) return;
      const { agreementId } = findSpecAndAgreementId(id);
      await confirmAndDelete("specification", id, async () => {
        const entry = state.contracting.specsByAgreement.get(agreementId);
        if (entry) {
          const idx = entry.specs.findIndex((s) => s.id === id);
          if (idx !== -1) entry.specs.splice(idx, 1);
        }
        for (const c of (state.contracting.contractsBySpec.get(id) || [])) {
          state.contractDrafts.delete(c.id);
          state.expandedContracts.delete(c.id);
        }
        state.newContractForms.delete(id);
        state.contracting.contractsBySpec.delete(id);
        state.specDrafts.delete(id);
        state.expandedSpecs.delete(id);
        await renderContractingTab();
        renderFooter();
      });
    }));
    el.querySelectorAll("[data-s-number]").forEach((inp) => inp.addEventListener("input", () => {
      const id = Number(inp.dataset.sNumber);
      ensureSpecDraft(id).number = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-s-date]").forEach((inp) => inp.addEventListener("input", () => {
      const id = Number(inp.dataset.sDate);
      ensureSpecDraft(id).date = inp.value;
      renderFooter();
    }));
    el.querySelectorAll("[data-save-spec]").forEach((b) => b.addEventListener("click", async () => {
      const id = Number(b.dataset.saveSpec);
      try { await saveSpecDraft(id); } catch (err) { /* ошибка уже в draft.error */ }
      await renderContractingTab();
      renderFooter();
    }));

    // Раскрытие/сворачивание переживает перерисовку (задача 2 — "раскрытие
    // списка не должно уничтожать ввод"): состояние держим в Set, а не
    // полагаемся на DOM-атрибут open, который каждый renderContractingTab
    // пересоздаёт заново.
    el.querySelectorAll("details[data-agreement]").forEach((d) => d.addEventListener("toggle", () => {
      const id = Number(d.dataset.agreement);
      if (d.open) state.expandedAgreements.add(id); else state.expandedAgreements.delete(id);
    }));
    el.querySelectorAll("details[data-spec]").forEach((d) => d.addEventListener("toggle", () => {
      const id = Number(d.dataset.spec);
      if (d.open) state.expandedSpecs.add(id); else state.expandedSpecs.delete(id);
    }));
    el.querySelectorAll("details[data-contract]").forEach((d) => d.addEventListener("toggle", () => {
      const id = Number(d.dataset.contract);
      // Само раскрытие черновика НЕ создаёт (см. contractFieldValues) —
      // только запоминает, что панель открыта, той же схемой, что и у
      // договора/спецификации выше.
      if (d.open) state.expandedContracts.add(id); else state.expandedContracts.delete(id);
    }));

    // ---------- Переход в рабочее пространство контракта (раздел 3) ----------
    // Создание и правка контракта больше не разворачиваются здесь же (в
    // третьем уровне вложенных <details> — то самое, из-за чего кнопка
    // "Сохранить" контракта из 19 позиций уезжала на ~2163px вниз, за
    // пределы экрана и на 1920×900, и на 1366×768). Вместо этого — переход
    // в отдельное рабочее пространство (openContractWorkspace), своя
    // закреплённая шапка/вкладки/подвал, общее содержимое для ЛЮБОГО
    // способа сюда попасть.
    el.querySelectorAll("[data-c-open]").forEach((b) => b.addEventListener("click", () => openContractWorkspace(b.dataset.cOpen)));
    el.querySelectorAll("[data-c-new]").forEach((b) => b.addEventListener("click", () => {
      const specId = Number(b.dataset.cNew);
      if (!state.newContractForms.has(specId)) state.newContractForms.set(specId, emptyContractDraft(specId));
      openContractWorkspace(`new:${specId}`);
    }));
    el.querySelectorAll("[data-specs-retry]").forEach((b) => b.addEventListener("click", () => retryPiece("specs", Number(b.dataset.specsRetry))));
    el.querySelector("#cp-contracts-retry")?.addEventListener("click", () => retryPiece("contracts"));
    el.querySelectorAll("[data-objects-retry]").forEach((b) => b.addEventListener("click", () => retryPiece("objects")));
  }

  // ============================================================
  // Раздел 3 и 4 — рабочее пространство контракта.
  //
  // Отдельная "страница" внутри модуля (state.page === "contract"),
  // не третий уровень вложенных <details> под спецификацией: карточка с
  // 19 позициями раньше отправляла кнопку "Сохранить" примерно на 2163px
  // вниз по странице — на 1920×900 и на 1366×768 она была далеко за
  // пределами экрана. Здесь — своя закреплённая шапка (путь + реквизиты),
  // вкладки (Позиции/Развёрнуто/Инциденты/Производительность) и
  // закреплённый подвал; прокручивается только содержимое активной
  // вкладки (тот же .v2-app приём, что и в users-access.js).
  //
  // Черновик — ОДИН на контракт (contractDraftForKey), общий для ВСЕХ
  // вкладок: переключение между ними не создаёт отдельных копий состояния.
  // ============================================================

  function lockContractWorkspace(locked) {
    if (currentShell !== "contract") return;
    container.querySelectorAll("#ctr-requisites input, #ctr-requisites select, #ctr-requisites button, #ctr-inner input, #ctr-inner button, #ctr-foot-actions button, .v2-nav button")
      .forEach((el) => { el.disabled = locked; });
  }

  async function requestLeaveContract() {
    const key = state.contractKey;
    if (!key) return true;
    const isNew = key.startsWith("new:");
    const id = isNew ? Number(key.slice(4)) : Number(key.slice(5));
    const draft = isNew ? state.newContractForms.get(id) : state.contractDrafts.get(id);
    if (!draft) return true;
    const dirty = isNew || isContractDraftDirty(draft);
    if (!dirty) return true;
    const c = isNew ? null : findContract(id);
    const label = isNew ? "новый контракт" : (c && c.theme ? `контракт «${c.theme}»` : "контракт");
    const choice = await showUnsavedDialog(`В контракте есть несохранённые изменения: ${label}.`);
    if (choice === "cancel") return false;
    if (choice === "discard") {
      if (isNew) state.newContractForms.delete(id); else state.contractDrafts.delete(id);
      return true;
    }
    try {
      if (isNew) await submitNewContract(id); else await saveContractDraft(id);
      return true;
    } catch (err) {
      return false; // ошибка уже в draft.error, форма остаётся открытой (см. вызывающий renderContractFooter)
    }
  }

  async function openContractWorkspace(key) {
    await withNavGuard(async () => {
      state.contractKey = key;
      state.contractTab = "lines";
      state.contractDeleteReplacement = null;
      state.page = "contract";
      await render();
    });
  }

  async function closeContractWorkspace() {
    await withNavGuard(async () => {
      if (!(await requestLeaveContract())) { await render(); return; }
      state.contractKey = null;
      state.contractDeleteReplacement = null;
      state.page = "edit";
      await render();
    });
  }
  // После успешного удаления (обычного или с переносом привязки) — контракта
  // больше нет, оставаться в его рабочем пространстве нечем; в отличие от
  // closeContractWorkspace() пропускает requestLeaveContract() — спрашивать
  // "сохранить несохранённое" у только что удалённой записи бессмысленно.
  async function closeContractWorkspaceAfterDelete() {
    state.contractKey = null;
    state.contractDeleteReplacement = null;
    state.page = "edit";
    await render();
  }

  function contractAgreementOptionsHtml(selectedAgreementId) {
    return state.contracting.agreements.map((a) =>
      `<option value="${a.id}" ${String(selectedAgreementId) === String(a.id) ? "selected" : ""}>${escapeHtml(a.number)} ${fmtDate(a.agreement_date)}</option>`).join("");
  }
  function contractSpecOptionsHtml(agreementId, selectedSpecId) {
    const entry = state.contracting.specsByAgreement.get(agreementId);
    const specs = entry ? entry.specs : [];
    return specs.map((s) =>
      `<option value="${s.id}" ${String(selectedSpecId) === String(s.id) ? "selected" : ""}>${escapeHtml(s.number)} ${fmtDate(s.specification_date)}</option>`).join("");
  }

  // ---------- удаление контракта, включая перенос привязанных изделий
  // (задача 4В) ----------
  async function requestDeleteContract(id, onSuccess) {
    let plan;
    try { plan = await api.get(`/dictionaries/contract/${id}/delete-plan`); }
    catch (err) { await showInfoDialog(err?.detail || err?.message || "Не удалось получить сведения об удалении"); return; }
    if (plan.blockers && plan.blockers.length) {
      await showInfoDialog(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
      return;
    }
    const cascadeParts = (plan.plan?.cascade || []).map((c) => `${c.label}: ${c.count}`);
    const consequences = cascadeParts.length ? `Вместе с контрактом удалятся: ${cascadeParts.join(", ")}.` : "";
    if (plan.plan && plan.plan.needs_replacement) {
      // К контракту привязаны изделия схемы — сервер не даст удалить его
      // без замены (app/dict_delete.py _contract_candidates/_contract_repoint).
      // Кандидаты — другие контракты ТОЙ ЖЕ спецификации; выбор — прямо
      // здесь, а не отправкой в V1 (задача 4В: "не считай сообщение
      // 'сделайте это в V1' завершением переноса").
      let candidates = [];
      try { candidates = await api.get(`/dictionaries/contract/candidates?key=${id}`); }
      catch (err) { await showInfoDialog(err?.detail || err?.message || "Не удалось получить список контрактов на замену"); return; }
      if (!candidates.length) {
        await showInfoDialog(`К контракту привязаны изделия схемы, а заменить контракт нечем — под этой спецификацией нет другого контракта. ${consequences} Заведите контракт-замену по этой же спецификации или перенесите привязку изделий в текущем интерфейсе.`);
        return;
      }
      state.contractDeleteReplacement = { id, candidates, selectedKey: candidates[0].key, consequences, error: "", saving: false, onSuccess };
      renderContractRequisites();
      return;
    }
    const confirmed = await showConfirmDialog(`Удалить контракт?${consequences ? " " + consequences : ""}`, { confirmLabel: "Удалить" });
    if (!confirmed) return;
    try {
      await api.post(`/dictionaries/contract/${id}/delete`, { replacements: {}, mode: "replace" });
      await onSuccess();
    } catch (err) {
      await showInfoDialog(err?.detail || err?.message || "Не удалось удалить");
    }
  }

  async function confirmContractReplacement() {
    const rep = state.contractDeleteReplacement;
    if (!rep || rep.saving) return;
    rep.saving = true; rep.error = "";
    renderContractRequisites();
    try {
      await api.post(`/dictionaries/contract/${rep.id}/delete`, {
        replacements: { [`contract:${rep.id}`]: String(rep.selectedKey) }, mode: "replace",
      });
      const onSuccess = rep.onSuccess;
      state.contractDeleteReplacement = null;
      await onSuccess();
    } catch (err) {
      rep.saving = false;
      rep.error = err?.detail || err?.message || "Не удалось удалить";
      renderContractRequisites();
    }
  }

  function renderReplacementPickerHtml(rep) {
    return `
      <div class="v2-note" style="margin-top:10px">
        <p>К контракту привязаны изделия схемы. ${escapeHtml(rep.consequences)} Выберите контракт этой же спецификации, на который перенести их привязку:</p>
        <div class="v2-inline">
          <select id="ctr-replacement-select" ${rep.saving ? "disabled" : ""}>
            ${rep.candidates.map((c) => `<option value="${escapeHtml(c.key)}" ${String(rep.selectedKey) === String(c.key) ? "selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
          ${btn(rep.saving ? "Перенос…" : "Подтвердить перенос и удалить", 'id="ctr-replacement-confirm"', true)}
          ${btn("Отмена", 'id="ctr-replacement-cancel"')}
        </div>
        <div class="v2-auth-error" id="ctr-replacement-error">${escapeHtml(rep.error || "")}</div>
      </div>`;
  }

  // ---------- реквизиты (шапка): тема, превью имени, договор/спецификация
  // (задача 4Б — переназначение), архивность, удаление ----------
  function renderContractRequisites() {
    const key = state.contractKey;
    const isNew = key.startsWith("new:");
    const id = isNew ? null : Number(key.slice(5));
    const draft = contractDraftForKey(key);
    const contract = isNew ? null : findContract(id);
    const { spec: curSpec, agreementId: curAgreementId } = findSpecAndAgreementId(draft.specificationId);
    const namePreview = buildContractNamePreview(findAgreement(curAgreementId), curSpec, draft.theme) || "—";
    const archiveInfo = !isNew ? contractArchiveHint(contract) : null;
    const rep = state.contractDeleteReplacement && state.contractDeleteReplacement.id === id ? state.contractDeleteReplacement : null;

    const el = container.querySelector("#ctr-requisites");
    el.innerHTML = `
      <div class="v2-fields">
        <label class="v2-field v2-span">Тема<input id="ctr-theme" value="${escapeHtml(draft.theme)}" placeholder="необязательно" ${draft.saving ? "disabled" : ""}></label>
      </div>
      <p class="v2-muted" id="ctr-preview">${escapeHtml(namePreview)}</p>
      <div class="v2-fields">
        <label class="v2-field">Договор<select id="ctr-agreement" ${draft.saving ? "disabled" : ""}>${contractAgreementOptionsHtml(curAgreementId)}</select></label>
        <label class="v2-field">Спецификация<select id="ctr-spec" ${draft.saving ? "disabled" : ""}>${contractSpecOptionsHtml(curAgreementId, draft.specificationId)}</select></label>
      </div>
      ${!isNew ? `
      <label class="v2-inline" style="margin-top:8px">
        <input type="checkbox" id="ctr-archived" ${draft.isArchived ? "checked" : ""} ${(archiveInfo.blocks || draft.saving) ? "disabled" : ""}> Архивный
      </label>
      <p class="v2-muted">${escapeHtml(archiveInfo.text)}</p>
      <div class="v2-inline" style="margin:8px 0">${btn("Удалить контракт", 'id="ctr-delete"')}</div>` : ""}
      <div class="v2-auth-error" id="ctr-error">${escapeHtml(draft.error || "")}</div>
      ${rep ? renderReplacementPickerHtml(rep) : ""}
    `;

    el.querySelector("#ctr-theme").addEventListener("input", (e) => {
      draft.theme = e.target.value;
      updateContractPreview();
      renderContractFooter();
    });
    el.querySelector("#ctr-agreement").addEventListener("change", (e) => {
      const newAgreementId = Number(e.target.value);
      const entry = state.contracting.specsByAgreement.get(newAgreementId);
      const firstSpec = entry && entry.specs[0];
      draft.specificationId = firstSpec ? firstSpec.id : null;
      renderContractRequisites(); // спецификация зависит от договора — правка структурная
      renderContractFooter();
    });
    el.querySelector("#ctr-spec").addEventListener("change", (e) => {
      draft.specificationId = Number(e.target.value);
      updateContractPreview();
      renderContractFooter();
    });
    el.querySelector("#ctr-archived")?.addEventListener("change", (e) => {
      draft.isArchived = e.target.checked;
      renderContractFooter();
    });
    el.querySelector("#ctr-delete")?.addEventListener("click", () => {
      if (draft.saving) return;
      requestDeleteContract(id, async () => {
        state.contractDrafts.delete(id);
        state.expandedContracts.delete(id);
        removeContractFromCache(id, contract.specification_id);
        await closeContractWorkspaceAfterDelete();
      });
    });
    el.querySelector("#ctr-replacement-select")?.addEventListener("change", (e) => {
      state.contractDeleteReplacement.selectedKey = e.target.value;
    });
    // confirmContractReplacement сама вызывает сохранённый в
    // state.contractDeleteReplacement.onSuccess при успехе.
    el.querySelector("#ctr-replacement-confirm")?.addEventListener("click", () => confirmContractReplacement());
    el.querySelector("#ctr-replacement-cancel")?.addEventListener("click", () => {
      state.contractDeleteReplacement = null;
      renderContractRequisites();
    });
  }

  function updateContractPreview() {
    const key = state.contractKey;
    const draft = contractDraftForKey(key);
    const { spec, agreementId } = findSpecAndAgreementId(draft.specificationId);
    const preview = container.querySelector("#ctr-preview");
    if (preview) preview.textContent = buildContractNamePreview(findAgreement(agreementId), spec, draft.theme) || "—";
  }

  // ---------- вкладка "Позиции" ----------
  function renderContractLinesTab(key, draft) {
    body.innerHTML = `
      <table class="v2-table">
        <thead><tr><th>Тип элемента</th><th>Марка</th><th>Количество</th><th></th></tr></thead>
        <tbody>${draft.lines.map((l, i) => contractLineRowHtml(key, i, l, draft.saving)).join("")}</tbody>
      </table>
      <div style="margin-top:10px">${btn("+ строка", 'id="ctr-line-add"')}</div>
    `;
    body.querySelectorAll("[data-line-type]").forEach((inp) => inp.addEventListener("input", () => {
      draft.lines[parseRowKey(inp.dataset.lineType).i].elementType = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-line-mark]").forEach((inp) => inp.addEventListener("input", () => {
      draft.lines[parseRowKey(inp.dataset.lineMark).i].mark = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-line-qty]").forEach((inp) => inp.addEventListener("input", () => {
      draft.lines[parseRowKey(inp.dataset.lineQty).i].quantity = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-line-remove]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      draft.lines.splice(parseRowKey(b.dataset.lineRemove).i, 1);
      renderContractLinesTab(key, draft);
      renderContractFooter();
    }));
    body.querySelector("#ctr-line-add").addEventListener("click", () => {
      draft.lines.push({ elementType: "", mark: "", quantity: "" });
      renderContractLinesTab(key, draft);
      renderContractFooter();
    });
  }

  // ---------- вкладка "Инциденты" ----------
  function renderContractIncidentsTab(key, draft) {
    body.innerHTML = `
      <table class="v2-table">
        <thead><tr><th>Дата</th><th>Тип элемента</th><th>Количество</th><th>Описание</th><th></th></tr></thead>
        <tbody>${draft.incidents.length ? draft.incidents.map((inc, i) => contractIncidentRowHtml(key, i, inc, draft.saving)).join("")
          : '<tr><td colspan="5" class="v2-note">инцидентов нет</td></tr>'}</tbody>
      </table>
      <div style="margin-top:10px">${btn("+ инцидент", 'id="ctr-inc-add"')}</div>
    `;
    body.querySelectorAll("[data-inc-date]").forEach((inp) => inp.addEventListener("input", () => {
      draft.incidents[parseRowKey(inp.dataset.incDate).i].incidentDate = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-inc-type]").forEach((inp) => inp.addEventListener("input", () => {
      draft.incidents[parseRowKey(inp.dataset.incType).i].elementType = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-inc-qty]").forEach((inp) => inp.addEventListener("input", () => {
      draft.incidents[parseRowKey(inp.dataset.incQty).i].quantity = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-inc-desc]").forEach((inp) => inp.addEventListener("input", () => {
      draft.incidents[parseRowKey(inp.dataset.incDesc).i].description = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-inc-remove]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      draft.incidents.splice(parseRowKey(b.dataset.incRemove).i, 1);
      renderContractIncidentsTab(key, draft);
      renderContractFooter();
    }));
    body.querySelector("#ctr-inc-add").addEventListener("click", () => {
      draft.incidents.push({ elementType: "", quantity: "", incidentDate: "", description: "" });
      renderContractIncidentsTab(key, draft);
      renderContractFooter();
    });
  }

  // ---------- вкладка "Производительность" ----------
  function renderContractCapacityTab(key, draft) {
    body.innerHTML = `
      <p class="v2-muted">Пусто — считается по нормативу контрагента (вкладка «Прочее» карточки контрагента).</p>
      <table class="v2-table">
        <thead><tr><th>Тип элемента</th><th>шт./день на этот контракт</th><th>От контрагента</th><th></th></tr></thead>
        <tbody>${draft.capacity.length ? draft.capacity.map((c, i) => contractCapacityRowHtml(key, i, c, draft.saving)).join("")
          : '<tr><td colspan="4" class="v2-note">переопределений нет</td></tr>'}</tbody>
      </table>
      <div class="v2-inline" style="margin-top:10px">
        <input id="ctr-cap-new-type" placeholder="тип элемента" ${draft.saving ? "disabled" : ""}>
        ${btn("+ строка", 'id="ctr-cap-add"')}
      </div>
    `;
    body.querySelectorAll("[data-cap-per-day]").forEach((inp) => inp.addEventListener("input", () => {
      draft.capacity[parseRowKey(inp.dataset.capPerDay).i].perDay = inp.value;
      renderContractFooter();
    }));
    body.querySelectorAll("[data-cap-remove]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      draft.capacity.splice(parseRowKey(b.dataset.capRemove).i, 1);
      renderContractCapacityTab(key, draft);
      renderContractFooter();
    }));
    body.querySelector("#ctr-cap-add").addEventListener("click", () => {
      const typeInput = body.querySelector("#ctr-cap-new-type");
      const type = (typeInput.value || "").trim();
      if (!type) return;
      draft.capacity.push({ elementType: type, perDay: "" });
      renderContractCapacityTab(key, draft);
      renderContractFooter();
    });
  }

  // ---------- вкладка "Развёрнуто" (задача 4А) ----------
  //
  // Тот же /contracts/{id}/elements и /elements/{id}/planned-delivery-date,
  // что и в V1 (renderContractExpandedView, app.js) — те же права (у чтения
  // элементов контракта — тот же порог, что у самого контракта, у правки
  // плановой даты — отдельная фича "planned_date", проверяется здесь через
  // /me/permissions?object_id=... тем же приёмом, что уже применён для
  // вложений в projects-objects.js, вместо копирования расчёта на клиенте).
  // Метки статусов — зеркало app/models.py STATUS_LABELS_RU: V2 не тянет
  // тяжёлый /plan-data ради семи подписей (тот же приём, что и
  // AVATAR_MIME_TYPES в projects-objects.js).
  const CONTRACT_STATUS_LABELS = {
    planned: "Запланирован", contracting: "Контрактация", in_production: "В производстве",
    shipped: "Отгружен", delivered: "Доставлен", installed: "Смонтирован", accepted: "Принят",
  };

  async function renderContractExpandedTab(id) {
    body.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
    let entry = state.contractExpandedCache.get(id);
    if (!entry || (!entry.loaded && !entry.error)) {
      entry = entry || { loaded: false, error: null, rows: [], canEdit: false };
      try {
        const rows = await api.get(`/contracts/${id}/elements`);
        const c = findContract(id);
        const { agreementId } = c ? findSpecAndAgreementId(c.specification_id) : { agreementId: null };
        const agreement = agreementId != null ? findAgreement(agreementId) : null;
        let canEdit = ctx.perms.isSystemAdmin;
        if (!canEdit && agreement?.object_id) {
          try {
            const perms = await api.get(`/me/permissions?object_id=${agreement.object_id}`);
            canEdit = !!perms.system_admin || perms.features?.planned_date === "write";
          } catch (e) { canEdit = false; }
        }
        entry = { loaded: true, error: null, rows, canEdit };
      } catch (err) {
        entry = { loaded: false, error: err?.detail || err?.message || "Не удалось загрузить элементы", rows: [], canEdit: false };
      }
      state.contractExpandedCache.set(id, entry);
    }
    // Пока шёл запрос, пользователь мог уйти со страницы/вкладки/контракта —
    // тогда результату уже некуда рисоваться.
    if (state.page !== "contract" || state.contractKey !== `edit:${id}` || state.contractTab !== "expanded") return;
    renderContractExpandedTabContent(id);
  }

  function renderContractExpandedTabContent(id) {
    const entry = state.contractExpandedCache.get(id);
    if (!entry) return;
    if (entry.error) {
      body.innerHTML = `<p class="v2-note">${escapeHtml(entry.error)} ${btn("Повторить", 'id="ctr-expanded-retry"')}</p>`;
      body.querySelector("#ctr-expanded-retry").addEventListener("click", () => {
        state.contractExpandedCache.delete(id);
        renderContractExpandedTab(id);
      });
      return;
    }
    const contract = findContract(id);
    const remainingLines = (contract?.lines || []).filter((l) => l.remaining > 0);
    const rowsHtml = entry.rows.map((r) => `
      <tr>
        <td>№${r.id}${r.mark ? " · " + escapeHtml(r.mark) : ""}</td>
        <td>${escapeHtml(r.element_type || "—")}</td>
        <td>${escapeHtml(r.mark || "—")}</td>
        <td>${escapeHtml(CONTRACT_STATUS_LABELS[r.current_status] || r.current_status)}</td>
        <td>${r.project_delivery_date ? escapeHtml(r.project_delivery_date) : "—"}</td>
        <td><input type="date" data-elem-planned="${r.id}" value="${r.planned_delivery_date || ""}" ${entry.canEdit ? "" : "disabled"}></td>
        <td>${r.actual_delivery_date ? escapeHtml(r.actual_delivery_date) : "—"}</td>
      </tr>`).join("");
    const remainingHtml = remainingLines.map((l) => `
      <tr class="v2-muted">
        <td>—</td><td>${escapeHtml(l.element_type || "тип не определён")}</td><td>${escapeHtml(l.mark || "—")}</td>
        <td colspan="4">без привязки к элементу схемы · остаток ${l.remaining} шт.</td>
      </tr>`).join("");
    body.innerHTML = `
      <p class="v2-muted">Сначала — элементы схемы, уже привязанные к контракту (плановую дату можно проставить прямо здесь), затем — незаполненные позиции контракта (ещё без привязки). Саму привязку элемента к контракту меняют в текущем интерфейсе (2D/3D схема).</p>
      ${!entry.canEdit ? '<p class="v2-note">Плановая дата недоступна для правки — нет прав на этом объекте.</p>' : ""}
      <table class="v2-table">
        <thead><tr><th>Элемент схемы</th><th>Тип</th><th>Марка</th><th>Статус</th><th>Завершение СМР</th><th>Плановая дата</th><th>Фактическая дата</th></tr></thead>
        <tbody>${(rowsHtml + remainingHtml) || '<tr><td colspan="7" class="v2-note">нет элементов</td></tr>'}</tbody>
      </table>
      <div class="v2-auth-error" id="ctr-expanded-error"></div>
    `;
    body.querySelectorAll("[data-elem-planned]").forEach((inp) => inp.addEventListener("change", async () => {
      const elementId = Number(inp.dataset.elemPlanned);
      const errorEl = body.querySelector("#ctr-expanded-error");
      const value = inp.value;
      inp.disabled = true;
      try {
        await api.patch(`/elements/${elementId}/planned-delivery-date`, { planned_delivery_date: value || null });
        if (errorEl) errorEl.textContent = "";
        const row = entry.rows.find((r) => r.id === elementId);
        if (row) row.planned_delivery_date = value || null;
      } catch (err) {
        if (errorEl) errorEl.textContent = "Не удалось сохранить дату: " + (err?.detail || err?.message || "");
      } finally {
        inp.disabled = false;
      }
    }));
  }

  // ---------- сборка вкладок и подвала ----------
  function renderContractTabBody() {
    const key = state.contractKey;
    const isNew = key.startsWith("new:");
    const id = isNew ? null : Number(key.slice(5));
    const draft = contractDraftForKey(key);
    if (state.contractTab === "lines") renderContractLinesTab(key, draft);
    else if (state.contractTab === "incidents") renderContractIncidentsTab(key, draft);
    else if (state.contractTab === "capacity") renderContractCapacityTab(key, draft);
    else if (state.contractTab === "expanded" && !isNew) renderContractExpandedTab(id);
  }

  function wireContractTabsNav() {
    container.querySelectorAll("[data-ctr-tab]").forEach((b) => b.addEventListener("click", () => {
      if (b.disabled) return;
      const tab = b.dataset.ctrTab;
      if (tab === state.contractTab) return;
      state.contractTab = tab;
      container.querySelectorAll("[data-ctr-tab]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.ctrTab === tab)));
      renderContractTabBody();
    }));
  }

  function renderContractFooter() {
    const key = state.contractKey;
    const isNew = key.startsWith("new:");
    const id = isNew ? Number(key.slice(4)) : Number(key.slice(5));
    const draft = contractDraftForKey(key);
    const dirty = isNew || isContractDraftDirty(draft);
    footActions.innerHTML = `${btn("Отменить", 'id="ctr-cancel"')}${btn(draft.saving ? "Сохранение…" : "Сохранить", 'id="ctr-save"', true)}`;
    const saveBtn = footActions.querySelector("#ctr-save");
    const cancelBtn = footActions.querySelector("#ctr-cancel");
    saveBtn.disabled = draft.saving;
    cancelBtn.disabled = draft.saving;
    saveBtn.addEventListener("click", async () => {
      try {
        if (isNew) await submitNewContract(id); else await saveContractDraft(id);
        if (!state.contractKey) return; // рабочее пространство успели закрыть, пока шло сохранение
        await renderContractWorkspace();
        status.textContent = "Сохранено.";
      } catch (err) {
        renderContractRequisites();
        renderContractFooter();
      }
    });
    cancelBtn.addEventListener("click", async () => {
      if (draft.saving) return;
      if (isNew) {
        if (!(await showConfirmDialog("Отменить новый контракт? Введённые данные будут потеряны.", { confirmLabel: "Отменить" }))) return;
        state.newContractForms.delete(id);
        await closeContractWorkspaceAfterDelete();
      } else {
        state.contractDrafts.delete(id);
        await renderContractWorkspace();
      }
    });
    status.textContent = dirty ? "Есть несохранённые изменения" : "";
  }

  async function renderContractWorkspace() {
    const key = state.contractKey;
    const isNew = key.startsWith("new:");
    const id = isNew ? null : Number(key.slice(5));
    const draft = contractDraftForKey(key);
    const contract = isNew ? null : findContract(id);
    const cp = state.list.find((x) => x.id === state.editingId);

    container.classList.add("v2-app");
    container.innerHTML = `
      <div class="v2-page-head"><div class="v2-container">
        <button type="button" class="v2-link" id="ctr-back">← ${escapeHtml(cp?.short_name || "Контрагент")} · Контрактация</button>
        <h2>${isNew ? "Новый контракт" : (contract?.theme ? `Контракт «${escapeHtml(contract.theme)}»` : `Контракт №${id}`)}</h2>
      </div></div>
      <div class="v2-container" id="ctr-requisites"></div>
      <nav class="v2-nav" aria-label="Разделы контракта"><div class="v2-container">
        ${[["lines", "Позиции"], ["expanded", "Развёрнуто"], ["incidents", "Инциденты"], ["capacity", "Производительность"]].map(([k, l]) =>
          `<button type="button" data-ctr-tab="${k}" aria-pressed="${state.contractTab === k}" ${k === "expanded" && isNew ? 'disabled title="Сначала сохраните контракт"' : ""}>${l}</button>`).join("")}
      </div></nav>
      <div id="ctr-body" class="v2-scroll"><div id="ctr-inner" class="v2-container"></div></div>
      <footer class="v2-foot"><div class="v2-container">
        <span id="ctr-status" class="v2-muted"></span><div class="v2-foot-actions" id="ctr-foot-actions"></div>
      </div></footer>
    `;
    body = container.querySelector("#ctr-inner");
    status = container.querySelector("#ctr-status");
    footActions = container.querySelector("#ctr-foot-actions");
    currentShell = "contract";

    container.querySelector("#ctr-back").addEventListener("click", closeContractWorkspace);
    renderContractRequisites();
    renderContractTabBody();
    wireContractTabsNav();
    renderContractFooter();
  }

  function ensureAgreementDraft(id) {
    if (!state.agreementDrafts.has(id)) {
      const a = findAgreement(id);
      state.agreementDrafts.set(id, { number: a.number, date: a.agreement_date || "", objectId: a.object_id ?? "", error: "", saving: false });
    }
    return state.agreementDrafts.get(id);
  }
  function ensureSpecDraft(id) {
    if (!state.specDrafts.has(id)) {
      const { spec } = findSpecAndAgreementId(id);
      state.specDrafts.set(id, { number: spec.number, date: spec.specification_date || "", error: "", saving: false });
    }
    return state.specDrafts.get(id);
  }

  function renderCapacityTab() {
    const el = body.querySelector("#cp-tab-body");
    el.innerHTML = `
      <p class="v2-muted">Сколько изделий завод выпускает в календарный день. Пустое поле — норматива нет. В конкретном контракте значение можно переопределить.</p>
      <table class="v2-table" id="cp-capacity"><thead><tr><th>Тип элемента</th><th>шт./день</th><th>Комментарий</th></tr></thead><tbody>
        ${state.draft.capacity.map((c, i) => `<tr>
          <td>${escapeHtml(c.element_type)}</td>
          <td><input data-cap-per-day="${i}" type="number" min="0" step="0.1" value="${c.per_day ?? ""}" style="width:90px"></td>
          <td><input data-cap-comment="${i}" value="${escapeHtml(c.comment || "")}"></td>
        </tr>`).join("")}
      </tbody></table>
      <div class="v2-inline" style="margin-top:12px">
        <input id="cp-cap-new-type" placeholder="Тип элемента">
        ${btn("+ Строка", 'id="cp-cap-add-row"')}
      </div>
    `;
    if (!state.draft.capacity.length) el.querySelector("#cp-capacity tbody").innerHTML = `<tr><td colspan="3" class="v2-note">Строк пока нет</td></tr>`;
    el.querySelectorAll("[data-cap-per-day]").forEach((inp) => inp.addEventListener("input", () => {
      state.draft.capacity[Number(inp.dataset.capPerDay)].per_day = Number(inp.value);
      state.dirty = true;
      renderFooter();
    }));
    el.querySelectorAll("[data-cap-comment]").forEach((inp) => inp.addEventListener("input", () => {
      state.draft.capacity[Number(inp.dataset.capComment)].comment = inp.value;
      state.dirty = true;
      renderFooter();
    }));
    el.querySelector("#cp-cap-add-row").addEventListener("click", () => {
      const type = el.querySelector("#cp-cap-new-type").value.trim();
      if (!type) return;
      state.draft.capacity.push({ element_type: type, per_day: 0, comment: "" });
      state.dirty = true;
      renderCapacityTab();
      renderFooter();
    });
  }

  async function renderCard() {
    const cp = state.editingId ? state.list.find((c) => c.id === state.editingId) : null;
    const title = state.editingId ? (state.draft.short_name || cp?.short_name || "Контрагент без наименования") : "Новый контрагент";
    body.innerHTML = `
      <button type="button" class="v2-link" id="cp-back">← Все контрагенты</button>
      <h3 style="margin-top:8px">${escapeHtml(title)}</h3>
      <nav class="v2-nav" aria-label="Вкладки"><div style="display:flex;gap:20px">
        ${[["main", "Основное"], ["contracting", "Контрактация"], ["other", "Прочее"]].map(([k, l]) =>
          `<button type="button" data-tab="${k}" aria-pressed="${state.tab === k}">${l}</button>`).join("")}
      </div></nav>
      <div id="cp-tab-body" style="padding-top:16px"></div>
    `;
    body.querySelector("#cp-back").addEventListener("click", backToList);
    // Переключение вкладок карточки НЕ спрашивает про несохранённое и НЕ
    // ходит в сеть: все черновики (главные поля, договоры, спецификации)
    // живут в state, а не в DOM — вкладка просто перерисовывается из
    // текущего состояния (задача 2).
    body.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.tab === state.tab) return;
      state.tab = b.dataset.tab;
      await renderCard();
    }));
    if (state.tab === "main") renderMainTab();
    else if (state.tab === "contracting") await renderContractingTab();
    else renderCapacityTab();
  }

  async function render() {
    if (state.page === "contract") {
      // Своя "оболочка" (см. ensureCardShell/renderContractWorkspace) —
      // список/карточка контрагента сюда не подмешиваются.
      await renderContractWorkspace();
      return;
    }
    ensureCardShell();
    if (!state.loaded) {
      const ok = await ensureLoaded();
      if (!ok) {
        body.innerHTML = `<p class="v2-note">${escapeHtml(state.loadError)} ${btn("Повторить", 'id="cp-retry"')}</p>`;
        body.querySelector("#cp-retry")?.addEventListener("click", render);
        return;
      }
    }
    if (state.page === "list") renderList();
    else await renderCard();
    renderFooter();
    // Разовое сообщение об успехе/ошибке операции важнее постоянного "не
    // сохранено" — перекрывает его, если есть; renderFooter() выше уже
    // корректно очистила статус, если не сохранённого нет вовсе.
    if (state.status_msg) { status.textContent = state.status_msg; state.status_msg = ""; }
  }

  render();

  return { hasUnsavedChanges, guardLeave: requestLeave };
}
