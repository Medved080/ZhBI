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
// Сознательно НЕ перенесено (см. отчёт по этапу): полный редактор контракта
// (позиции спецификации, переопределение производительности на контракте) —
// это отдельная большая форма (#contract-edit-backdrop в V1), не входящая
// в эту группу; контракты здесь показаны как сводка "тема, позиций/изделий"
// со ссылкой "Открыть в V1". Список объектов при заведении договора не
// фильтруется по мелкому признаку (doc_supplier_change/doc_link_swap —
// сам список в V1 отфильтрован НЕ тем же признаком, что реально проверяет
// сервер, см. отчёт) — показаны все объекты, реальную проверку в любом
// случае делает сервер (assert_object_feature "agreements","write").
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
function emptyContracting() {
  return { loaded: false, loadError: null, agreements: [], specsByAgreement: new Map(), contractsBySpec: new Map() };
}

export function mountCounterparties(container, ctx) {
  const { api } = ctx;

  const state = {
    list: [], loaded: false, loadError: null,
    page: "list", // "list" | "edit"
    editingId: null, tab: "main",
    draft: null, dirty: false,
    objects: [], objectsLoaded: false,
    contracting: emptyContracting(),
    expandedAgreements: new Set(),
    expandedSpecs: new Set(),
    newAgreementForm: null,        // {number, date, objectId, error, saving} | null (форма скрыта)
    agreementDrafts: new Map(),    // id -> {number, date, objectId, error, saving}
    newSpecForms: new Map(),       // agreementId -> {number, date, error, saving}
    specDrafts: new Map(),         // id -> {number, date, error, saving}
    status_msg: "",
  };

  function setCardFieldsDisabled(disabled) {
    body.querySelectorAll("#cp-main-fields input, #cp-main-fields textarea, #cp-capacity input").forEach((el) => { el.disabled = disabled; });
  }

  // ---------- сбор незавершённых черновиков вкладки "Контрактация" +
  // главных полей — единая точка для "действительно разрушающих"
  // переходов (задача 2). Переключение вкладок карточки и раскрытие
  // <details> сюда НЕ ходят вовсе — они ничего не разрушают. ----------

  function findAgreement(id) { return state.contracting.agreements.find((a) => a.id === id); }
  function findSpecAndAgreementId(id) {
    for (const [agreementId, specs] of state.contracting.specsByAgreement) {
      const s = specs.find((x) => x.id === id);
      if (s) return { spec: s, agreementId };
    }
    return { spec: null, agreementId: null };
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

  container.innerHTML = `
    <div class="v2-page-head"><div class="v2-container">
      <h2>Контрагенты</h2>
    </div></div>
    <div id="cp-body" class="v2-scroll"><div id="cp-inner" class="v2-container"></div></div>
    <footer class="v2-foot"><div class="v2-container">
      <span id="cp-status" class="v2-muted"></span><div class="v2-foot-actions" id="cp-foot-actions"></div>
    </div></footer>
  `;
  const body = container.querySelector("#cp-inner");
  const status = container.querySelector("#cp-status");
  const footActions = container.querySelector("#cp-foot-actions");

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

  async function ensureObjects() {
    if (state.objectsLoaded) return;
    try { state.objects = await api.get("/objects"); } catch (e) { state.objects = []; }
    state.objectsLoaded = true;
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

  async function ensureContractingLoaded(force) {
    if (state.contracting.loaded && !force) return true;
    await ensureObjects();
    try {
      const agreements = await api.get(`/agreements?counterparty_id=${state.editingId}`);
      let contracts = [];
      try { contracts = await api.get("/contracts"); } catch (e) { contracts = []; }
      const contractsBySpec = new Map();
      for (const c of contracts) {
        if (!contractsBySpec.has(c.specification_id)) contractsBySpec.set(c.specification_id, []);
        contractsBySpec.get(c.specification_id).push(c);
      }
      const specsByAgreement = new Map();
      for (const a of agreements) {
        try { specsByAgreement.set(a.id, await api.get(`/specifications?agreement_id=${a.id}`)); }
        catch (e) { specsByAgreement.set(a.id, []); }
      }
      state.contracting = { loaded: true, loadError: null, agreements, specsByAgreement, contractsBySpec };
      return true;
    } catch (err) {
      state.contracting.loadError = err?.detail || err?.message || "Не удалось загрузить договоры";
      return false;
    }
  }

  // ---------- Черновик нового договора ----------

  async function submitNewAgreement() {
    const draft = state.newAgreementForm;
    if (!draft) return;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер договора"; throw { message: draft.error }; }
    if (!draft.objectId) { draft.error = "Выберите объект, на который заключён договор"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
    try {
      const created = await api.post("/agreements", {
        counterparty_id: state.editingId, number: snapshot.number.trim(),
        object_id: Number(snapshot.objectId), agreement_date: snapshot.date || null,
      });
      state.contracting.agreements.push(created);
      state.contracting.specsByAgreement.set(created.id, []);
      const cur = state.newAgreementForm;
      const stillSame = cur === draft && cur.number === snapshot.number && cur.date === snapshot.date && cur.objectId === snapshot.objectId;
      if (stillSame) state.newAgreementForm = null; else cur.saving = false;
    } catch (err) {
      draft.saving = false;
      draft.error = err?.detail || err?.message || "Не удалось добавить договор";
      throw err;
    }
  }

  // ---------- Черновик правки существующего договора ----------

  async function saveAgreementDraft(id) {
    const draft = state.agreementDrafts.get(id);
    if (!draft) return;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер договора"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
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
      if (stillSame) state.agreementDrafts.delete(id); else cur.saving = false;
    } catch (err) {
      draft.saving = false;
      draft.error = err?.detail || err?.message || "Не удалось сохранить договор";
      throw err;
    }
  }

  // ---------- Черновик новой спецификации (под конкретным договором) ----------

  async function submitNewSpec(agreementId) {
    const draft = state.newSpecForms.get(agreementId);
    if (!draft) return;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер спецификации"; throw { message: draft.error }; }
    const snapshot = { ...draft };
    draft.saving = true;
    try {
      const created = await api.post("/specifications", {
        agreement_id: agreementId, number: snapshot.number.trim(), specification_date: snapshot.date || null,
      });
      if (!state.contracting.specsByAgreement.has(agreementId)) state.contracting.specsByAgreement.set(agreementId, []);
      state.contracting.specsByAgreement.get(agreementId).push(created);
      const cur = state.newSpecForms.get(agreementId);
      const stillSame = cur && cur.number === snapshot.number && cur.date === snapshot.date;
      if (stillSame) state.newSpecForms.delete(agreementId); else cur.saving = false;
    } catch (err) {
      draft.saving = false;
      draft.error = err?.detail || err?.message || "Не удалось добавить спецификацию";
      throw err;
    }
  }

  // ---------- Черновик правки существующей спецификации ----------

  async function saveSpecDraft(id) {
    const draft = state.specDrafts.get(id);
    if (!draft) return;
    draft.error = "";
    if (!draft.number.trim()) { draft.error = "Укажите номер спецификации"; throw { message: draft.error }; }
    const { agreementId } = findSpecAndAgreementId(id);
    const snapshot = { ...draft };
    draft.saving = true;
    try {
      const updated = await api.patch(`/specifications/${id}`, {
        agreement_id: agreementId, number: snapshot.number.trim(), specification_date: snapshot.date || null,
      });
      const specs = state.contracting.specsByAgreement.get(agreementId) || [];
      const idx = specs.findIndex((s) => s.id === id);
      if (idx !== -1) specs[idx] = updated;
      const cur = state.specDrafts.get(id);
      const stillSame = cur && cur.number === snapshot.number && cur.date === snapshot.date;
      if (stillSame) state.specDrafts.delete(id); else cur.saving = false;
    } catch (err) {
      draft.saving = false;
      draft.error = err?.detail || err?.message || "Не удалось сохранить спецификацию";
      throw err;
    }
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
    if (!state.contracting.loaded) {
      el.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
      const ok = await ensureContractingLoaded();
      if (!ok) {
        el.innerHTML = `<p class="v2-note">${escapeHtml(state.contracting.loadError)} ${btn("Повторить", 'id="cp-contracting-retry"')}</p>`;
        el.querySelector("#cp-contracting-retry").addEventListener("click", renderContractingTab);
        return;
      }
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

  function buildContractingHtml() {
    const { agreements, specsByAgreement, contractsBySpec } = state.contracting;
    const newForm = state.newAgreementForm;
    return `
      <div class="v2-inline" style="margin-bottom:12px">${newForm ? "" : btn("+ Договор", 'id="cp-new-agreement-toggle"')}</div>
      ${newForm ? `
      <div id="cp-new-agreement-form" class="v2-inline">
        <select id="cp-new-agreement-object" ${newForm.saving ? "disabled" : ""}>
          <option value="">— выберите объект —</option>
          ${state.objects.map((o) => `<option value="${o.id}" ${String(newForm.objectId) === String(o.id) ? "selected" : ""}>${escapeHtml(objectLabel(o.id))}</option>`).join("")}
        </select>
        <input id="cp-new-agreement-number" placeholder="номер договора" value="${escapeHtml(newForm.number)}" ${newForm.saving ? "disabled" : ""}>
        <input id="cp-new-agreement-date" type="date" value="${escapeHtml(newForm.date)}" ${newForm.saving ? "disabled" : ""}>
        ${btn("Добавить", 'id="cp-add-agreement"', true)}${btn("Отмена", 'id="cp-new-agreement-cancel"')}
        <span class="v2-auth-error" id="cp-agreement-error">${escapeHtml(newForm.error || "")}</span>
      </div>` : ""}
      <div id="cp-agreements-list">
        ${!agreements.length ? '<p class="v2-note">нет договоров</p>' : agreements.map((a) => {
          const av = agreementFieldValues(a);
          const specs = specsByAgreement.get(a.id) || [];
          const newSpecForm = state.newSpecForms.get(a.id);
          return `
          <details class="v2-agreement" data-agreement="${a.id}" ${state.expandedAgreements.has(a.id) ? "open" : ""}>
            <summary>Договор <strong>${escapeHtml(a.number)}</strong> ${fmtDate(a.agreement_date)} — ${escapeHtml(objectLabel(a.object_id))}${av.dirty ? " · не сохранено" : ""}
              ${trashIconHtml(`data-del-agreement="${a.id}"`, "Удалить договор")}</summary>
            <div class="v2-inline" style="margin:10px 0">
              <input data-a-number="${a.id}" value="${escapeHtml(av.number)}" placeholder="номер" ${av.saving ? "disabled" : ""}>
              <input data-a-date="${a.id}" type="date" value="${escapeHtml(av.date)}" ${av.saving ? "disabled" : ""}>
              <select data-a-object="${a.id}" ${av.saving ? "disabled" : ""}><option value="">— выберите объект —</option>
                ${state.objects.map((o) => `<option value="${o.id}" ${String(av.objectId) === String(o.id) ? "selected" : ""}>${escapeHtml(objectLabel(o.id))}</option>`).join("")}</select>
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
            ${!specs.length ? '<p class="v2-note">нет спецификаций</p>' : specs.map((s) => {
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
                ${contracts.length ? contracts.map((c) => `
                  <div class="v2-perm"><div>Контракт ${c.theme ? `«${escapeHtml(c.theme)}»` : "без темы"}
                    <small>${c.lines?.length ? `позиций: ${c.lines.length}, всего изделий: ${c.lines.reduce((s2, l) => s2 + (l.quantity || 0), 0)}` : "без позиций"}</small></div>
                    <a class="v2-link" href="/?ui=v1">Открыть в V1</a></div>`).join("") : '<p class="v2-note">контрактов нет</p>'}
              </details>`;
            }).join("")}
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
      await confirmAndDelete("agreement", id, async () => {
        const idx = state.contracting.agreements.findIndex((a) => a.id === id);
        if (idx !== -1) state.contracting.agreements.splice(idx, 1);
        // Каскад — как на сервере (удаление договора уносит с собой его
        // спецификации): чистим ВСЕ дочерние черновики/раскрытия, иначе
        // осиротевший черновик спецификации остался бы висеть в
        // collectDirtyParts() и требовал бы сохранить то, чего больше нет.
        for (const s of state.contracting.specsByAgreement.get(id) || []) {
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
      state.newSpecForms.delete(Number(b.dataset.specCancel));
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
      const { agreementId } = findSpecAndAgreementId(id);
      await confirmAndDelete("specification", id, async () => {
        const specs = state.contracting.specsByAgreement.get(agreementId) || [];
        const idx = specs.findIndex((s) => s.id === id);
        if (idx !== -1) specs.splice(idx, 1);
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
