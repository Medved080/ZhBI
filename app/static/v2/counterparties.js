// V2: «Контрагенты» (список) и «Контрагент» (карточка, три вкладки) — те
// же эндпоинты, что у V1 (app/counterparties.py: /counterparties,
// /agreements, /specifications, /contracts, /dictionaries/*). Раздел,
// включая чтение, открыт только при "counterparties":"write" — как в V1
// (index.html data-feature-kind="write" у пункта меню).
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
import { resolveDirty as sharedResolveDirty } from "./dialogs.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(s) {
  if (!s) return "без даты";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `от ${m[3]}.${m[2]}.${m[1]}` : s;
}

export function mountCounterparties(container, ctx) {
  const { api } = ctx;

  const state = {
    list: [], loaded: false, loadError: null,
    page: "list", // "list" | "edit"
    editingId: null, tab: "main",
    draft: null, dirty: false,
    objects: [], objectsLoaded: false,
    agreements: null, contractsBySpec: new Map(),
    status_msg: "",
  };

  let currentDirty = null;
  function setDirty(info) { currentDirty = info; }
  function clearDirtyState() { currentDirty = null; }
  function hasUnsavedChanges() { return !!currentDirty; }
  async function resolveDirty(info) {
    return sharedResolveDirty(info, (err) => { state.status_msg = err?.detail || err?.message || "Не удалось сохранить"; });
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

  function markDirty(message, save, discard) {
    state.dirty = true;
    setDirty({ message, save, discard });
    renderFooter();
  }

  function renderFooter() {
    if (state.page !== "edit" || !state.dirty) { footActions.innerHTML = ""; return; }
    footActions.innerHTML = `${btn("Отменить", 'id="cp-cancel"')}${btn("Сохранить", 'id="cp-save"', true)}`;
    status.textContent = "Есть несохранённые изменения";
    footActions.querySelector("#cp-cancel").addEventListener("click", async () => {
      initDraft();
      status.textContent = "";
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
      } catch (err) {
        status.textContent = err?.detail || err?.message || "Не удалось сохранить";
        saveBtn.disabled = false; cancelBtn.disabled = false;
        setCardFieldsDisabled(false);
      }
    });
  }

  function setCardFieldsDisabled(disabled) {
    body.querySelectorAll("#cp-main-fields input, #cp-main-fields textarea, #cp-capacity input").forEach((el) => { el.disabled = disabled; });
  }

  function initDraft() {
    const cp = state.editingId ? state.list.find((c) => c.id === state.editingId) : null;
    state.draft = cp
      ? { full_name: cp.full_name, short_name: cp.short_name, inn: cp.inn || "", kpp: cp.kpp || "", ogrn: cp.ogrn || "",
          legal_address: cp.legal_address || "", contact_person: cp.contact_person || "", contact_phone: cp.contact_phone || "",
          code: cp.code || "", capacity: (cp.capacity || []).map((c) => ({ ...c })) }
      : { full_name: "", short_name: "", inn: "", kpp: "", ogrn: "", legal_address: "", contact_person: "", contact_phone: "", code: "", capacity: [] };
    state.dirty = false;
    clearDirtyState();
  }

  async function saveMain() {
    const d = state.draft;
    if (!d.full_name.trim() || !d.short_name.trim()) throw { message: "Укажите полное и краткое наименование" };
    const body = {
      full_name: d.full_name.trim(), short_name: d.short_name.trim(),
      inn: d.inn.trim() || null, kpp: d.kpp.trim() || null, ogrn: d.ogrn.trim() || null,
      legal_address: d.legal_address.trim() || null, contact_person: d.contact_person.trim() || null,
      contact_phone: d.contact_phone.trim() || null, code: d.code.trim() || null,
      capacity: d.capacity.filter((c) => Number.isFinite(c.per_day) && c.per_day > 0),
    };
    const saved = state.editingId ? await api.patch(`/counterparties/${state.editingId}`, body) : await api.post("/counterparties", body);
    state.editingId = saved.id;
    const ok = await ensureLoaded(true);
    state.dirty = false;
    clearDirtyState();
    state.status_msg = !ok ? "Сохранено, но не удалось обновить список." : "Сохранено.";
    initDraft();
  }

  function fieldRow(label, id, value, extra = "") {
    return `<label class="v2-field">${label}<input id="${id}" value="${escapeHtml(value)}" ${extra}></label>`;
  }

  async function openCard(id) {
    await withNavGuard(async () => {
      if (!(await requestLeave())) return;
      state.page = "edit"; state.editingId = id; state.tab = "main";
      state.agreements = null; state.contractsBySpec = new Map();
      initDraft();
      state.status_msg = "";
      await render();
    });
  }

  async function backToList() {
    await withNavGuard(async () => {
      if (!(await requestLeave())) return;
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
          <div data-open="${cp.id}" style="cursor:pointer"><strong>${escapeHtml(cp.short_name)}</strong>
            <small>${escapeHtml(cp.full_name)}${cp.inn ? ` · ИНН ${escapeHtml(cp.inn)}` : ""}${cp.code ? ` · код ${escapeHtml(cp.code)}` : ""}</small></div>
          ${canDelete ? `<button type="button" class="v2-link" data-del="${cp.id}" title="Удалить контрагента">🗑</button>` : ""}
        </div>`).join("");
      listEl.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openCard(Number(el.dataset.open))));
      listEl.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmAndDelete("counterparty", el.dataset.del, () => ensureLoaded(true).then(render));
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
      markDirty("В карточке контрагента есть несохранённые изменения.", saveMain, () => { initDraft(); });
    }));
  }

  function objectLabel(id) {
    const o = state.objects.find((x) => x.id === id);
    return o ? `${o.project_name ? o.project_name + " · " : ""}${o.name}` : (id ? `объект №${id}` : "объект не указан");
  }

  async function renderContractingTab() {
    const el = body.querySelector("#cp-tab-body");
    if (!state.editingId) {
      el.innerHTML = `<p class="v2-note">Договоры заводятся после сохранения контрагента — заполните «Основное» и нажмите «Сохранить».</p>`;
      return;
    }
    el.innerHTML = `<p class="v2-muted">Загрузка…</p>`;
    await ensureObjects();
    let agreements, contracts;
    try { agreements = await api.get(`/agreements?counterparty_id=${state.editingId}`); }
    catch (err) { el.innerHTML = `<p class="v2-note">${escapeHtml(err?.detail || err?.message || "Не удалось загрузить договоры")}</p>`; return; }
    try { contracts = await api.get("/contracts"); } catch (err) { contracts = []; }
    const contractsBySpec = new Map();
    for (const c of contracts) {
      if (!contractsBySpec.has(c.specification_id)) contractsBySpec.set(c.specification_id, []);
      contractsBySpec.get(c.specification_id).push(c);
    }
    const specsByAgreement = new Map();
    for (const a of agreements) {
      try { specsByAgreement.set(a.id, await api.get(`/specifications?agreement_id=${a.id}`)); }
      catch (err) { specsByAgreement.set(a.id, []); }
    }
    el.innerHTML = `
      <div class="v2-inline" style="margin-bottom:12px">${btn("+ Договор", 'id="cp-new-agreement-toggle"')}</div>
      <div id="cp-new-agreement-form" style="display:none" class="v2-inline">
        <select id="cp-new-agreement-object"><option value="">— выберите объект —</option>
          ${state.objects.map((o) => `<option value="${o.id}">${escapeHtml(objectLabel(o.id))}</option>`).join("")}</select>
        <input id="cp-new-agreement-number" placeholder="номер договора">
        <input id="cp-new-agreement-date" type="date">
        ${btn("Добавить", 'id="cp-add-agreement"', true)}${btn("Отмена", 'id="cp-new-agreement-cancel"')}
        <span class="v2-auth-error" id="cp-agreement-error"></span>
      </div>
      <div id="cp-agreements-list">
        ${!agreements.length ? '<p class="v2-note">нет договоров</p>' : agreements.map((a) => `
          <details class="v2-agreement" data-agreement="${a.id}">
            <summary>Договор <strong>${escapeHtml(a.number)}</strong> ${fmtDate(a.agreement_date)} — ${escapeHtml(objectLabel(a.object_id))}
              ${btn("🗑", `data-del-agreement="${a.id}"`)}</summary>
            <div class="v2-inline" style="margin:10px 0">
              <input data-a-number="${a.id}" value="${escapeHtml(a.number)}" placeholder="номер">
              <input data-a-date="${a.id}" type="date" value="${escapeHtml(a.agreement_date || "")}">
              <select data-a-object="${a.id}"><option value="">— выберите объект —</option>
                ${state.objects.map((o) => `<option value="${o.id}" ${o.id === a.object_id ? "selected" : ""}>${escapeHtml(objectLabel(o.id))}</option>`).join("")}</select>
              ${btn("Сохранить", `data-save-agreement="${a.id}"`, true)}
              <span class="v2-auth-error" data-a-error="${a.id}"></span>
            </div>
            <div class="v2-inline" style="margin-bottom:8px">${btn("+ Спецификация", `data-new-spec-toggle="${a.id}"`)}</div>
            <div data-new-spec-form="${a.id}" style="display:none" class="v2-inline">
              <input data-spec-number="${a.id}" placeholder="номер"><input data-spec-date="${a.id}" type="date">
              ${btn("Добавить", `data-add-spec="${a.id}"`, true)}${btn("Отмена", `data-spec-cancel="${a.id}"`)}
            </div>
            ${(specsByAgreement.get(a.id) || []).length ? (specsByAgreement.get(a.id) || []).map((s) => `
              <details class="v2-agreement v2-agreement-nested" data-spec="${s.id}">
                <summary>Спецификация <strong>${escapeHtml(s.number)}</strong> ${fmtDate(s.specification_date)}
                  ${btn("🗑", `data-del-spec="${s.id}"`)}</summary>
                <div class="v2-inline" style="margin:10px 0">
                  <input data-s-number="${s.id}" value="${escapeHtml(s.number)}" placeholder="номер">
                  <input data-s-date="${s.id}" type="date" value="${escapeHtml(s.specification_date || "")}">
                  ${btn("Сохранить", `data-save-spec="${s.id}"`, true)}
                </div>
                ${(contractsBySpec.get(s.id) || []).length ? (contractsBySpec.get(s.id) || []).map((c) => `
                  <div class="v2-perm"><div>Контракт ${c.theme ? `«${escapeHtml(c.theme)}»` : "без темы"}
                    <small>${c.lines?.length ? `позиций: ${c.lines.length}, всего изделий: ${c.lines.reduce((s2, l) => s2 + (l.quantity || 0), 0)}` : "без позиций"}</small></div>
                    <a class="v2-link" href="/?ui=v1">Открыть в V1</a></div>`).join("") : '<p class="v2-note">контрактов нет</p>'}
              </details>`).join("") : '<p class="v2-note">нет спецификаций</p>'}
          </details>`).join("")}
      </div>
    `;
    wireContractingHandlers(el);
  }

  function wireContractingHandlers(el) {
    const toggleBtn = el.querySelector("#cp-new-agreement-toggle");
    const form = el.querySelector("#cp-new-agreement-form");
    if (toggleBtn) toggleBtn.addEventListener("click", () => { form.style.display = ""; toggleBtn.style.display = "none"; el.querySelector("#cp-new-agreement-number").focus(); });
    el.querySelector("#cp-new-agreement-cancel")?.addEventListener("click", () => {
      form.style.display = "none"; toggleBtn.style.display = "";
      el.querySelector("#cp-new-agreement-number").value = ""; el.querySelector("#cp-agreement-error").textContent = "";
    });
    el.querySelector("#cp-add-agreement")?.addEventListener("click", async () => {
      const number = el.querySelector("#cp-new-agreement-number").value.trim();
      const object_id = el.querySelector("#cp-new-agreement-object").value;
      const errorEl = el.querySelector("#cp-agreement-error");
      if (!number) { errorEl.textContent = "Укажите номер договора"; return; }
      if (!object_id) { errorEl.textContent = "Выберите объект, на который заключён договор"; return; }
      try {
        await api.post("/agreements", { counterparty_id: state.editingId, number, object_id: Number(object_id),
          agreement_date: el.querySelector("#cp-new-agreement-date").value || null });
        await renderContractingTab();
      } catch (err) { errorEl.textContent = err?.detail || err?.message || "Не удалось добавить договор"; }
    });
    el.querySelectorAll("[data-del-agreement]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); confirmAndDelete("agreement", b.dataset.delAgreement, renderContractingTab);
    }));
    el.querySelectorAll("[data-save-agreement]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.saveAgreement;
      const number = el.querySelector(`[data-a-number="${id}"]`).value.trim();
      const object_id = el.querySelector(`[data-a-object="${id}"]`).value;
      const errorEl = el.querySelector(`[data-a-error="${id}"]`);
      if (!number) { errorEl.textContent = "Укажите номер договора"; return; }
      try {
        await api.patch(`/agreements/${id}`, { counterparty_id: state.editingId, number,
          object_id: object_id ? Number(object_id) : null, agreement_date: el.querySelector(`[data-a-date="${id}"]`).value || null });
        await renderContractingTab();
      } catch (err) { errorEl.textContent = err?.detail || err?.message || "Не удалось сохранить"; }
    }));
    el.querySelectorAll("[data-new-spec-toggle]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.newSpecToggle;
      el.querySelector(`[data-new-spec-form="${id}"]`).style.display = ""; b.style.display = "none";
    }));
    el.querySelectorAll("[data-spec-cancel]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.specCancel;
      el.querySelector(`[data-new-spec-form="${id}"]`).style.display = "none";
      el.querySelector(`[data-new-spec-toggle="${id}"]`).style.display = "";
    }));
    el.querySelectorAll("[data-add-spec]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.addSpec;
      const number = el.querySelector(`[data-spec-number="${id}"]`).value.trim();
      if (!number) return;
      try {
        await api.post("/specifications", { agreement_id: Number(id), number, specification_date: el.querySelector(`[data-spec-date="${id}"]`).value || null });
        await renderContractingTab();
      } catch (err) { /* тихо, как в V1 */ }
    }));
    el.querySelectorAll("[data-del-spec]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); confirmAndDelete("specification", b.dataset.delSpec, renderContractingTab);
    }));
    el.querySelectorAll("[data-save-spec]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.saveSpec;
      const number = el.querySelector(`[data-s-number="${id}"]`).value.trim();
      if (!number) return;
      try {
        await api.patch(`/specifications/${id}`, { agreement_id: findAgreementIdForSpec(id), number, specification_date: el.querySelector(`[data-s-date="${id}"]`).value || null });
        await renderContractingTab();
      } catch (err) { /* тихо, как в V1 */ }
    }));
  }

  function findAgreementIdForSpec(specId) {
    const details = body.querySelector(`[data-spec="${specId}"]`);
    const parent = details?.closest("[data-agreement]");
    return parent ? Number(parent.dataset.agreement) : null;
  }

  // Как и в V1 (openDictDelete) — сначала delete-plan, отказ при найденных
  // зависимостях, и только потом сам POST .../delete. Разница с V1: там
  // это отдельный модальный диалог с полным деревом, здесь — то же
  // решение через confirm()/alert(), т.к. согласование внутри вложенных
  // <details> договора/спецификации не даёт места для встроенного блока
  // (как у "Проекты и объекты" — см. showDeletePlan там).
  async function confirmAndDelete(kind, id, onDone) {
    const label = kind === "counterparty" ? "контрагента" : kind === "agreement" ? "договор" : "спецификацию";
    let plan;
    try { plan = await api.get(`/dictionaries/${kind}/${id}/delete-plan`); }
    catch (err) { alert(err?.detail || err?.message || "Не удалось получить сведения об удалении"); return; }
    if (plan.blockers && plan.blockers.length) {
      alert(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
      return;
    }
    if (!confirm(`Удалить ${label}?`)) return;
    try {
      await api.post(`/dictionaries/${kind}/${id}/delete`, { replacements: {}, mode: "replace" });
      await onDone();
    } catch (err) { alert(err?.detail || err?.message || "Не удалось удалить"); }
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
      markDirty("В карточке контрагента есть несохранённые изменения.", saveMain, () => { initDraft(); });
    }));
    el.querySelectorAll("[data-cap-comment]").forEach((inp) => inp.addEventListener("input", () => {
      state.draft.capacity[Number(inp.dataset.capComment)].comment = inp.value;
      markDirty("В карточке контрагента есть несохранённые изменения.", saveMain, () => { initDraft(); });
    }));
    el.querySelector("#cp-cap-add-row").addEventListener("click", () => {
      const type = el.querySelector("#cp-cap-new-type").value.trim();
      if (!type) return;
      state.draft.capacity.push({ element_type: type, per_day: 0, comment: "" });
      markDirty("В карточке контрагента есть несохранённые изменения.", saveMain, () => { initDraft(); });
      renderCapacityTab();
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
    if (state.status_msg) { status.textContent = state.status_msg; state.status_msg = ""; } else if (state.page === "list") status.textContent = "";
  }

  render();

  return { hasUnsavedChanges, guardLeave: requestLeave };
}
