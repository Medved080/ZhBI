// V2: «Контракты» — список контрактов выбранного объекта (GET /contracts?object_id=…) с поиском и переходом к работе с контрактом,
// плюс «Контракт по умолчанию по типу изделия» ВЫБРАННОГО в шапке объекта (тот же раздел формы, что в V1).
// Создание и правка контракта (тема, позиции и количество, инциденты, нормативы, архив, удаление с переносом изделий, плановая дата поставки)
// выполняются в карточке контрагента — там реализованы все проверки (версия записи, страж покрытия, отказ без изменений). Отсюда — «Открыть»
// (карточка контрагента → «Контрактация» → контракт) и «Добавить контракт» (выбор контрагент → договор → спецификация → форма нового контракта).
//
// «Контракт по умолчанию» — замена карты ЦЕЛИКОМ (app/contracts.py, PUT /contracts/default-map?expected_version=…), не построчный upsert, как у
// V1: отпечаток текущей карты, которую видел человек, считается ЗДЕСЬ же (тот же алгоритм, что `app.record_version.digest` — SHA-1 канонического
// JSON, 16 hex) и сверяется сервером под блокировкой записи перед заменой — конфликт вместо тихой перезаписи чужого выбора.
import { esc } from "./screen-view.js";
import { ApiError } from "./api.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";

const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };

// Тот же отпечаток, что `app.record_version.digest()`: json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")) → sha1 → 16 hex.
// JSON.stringify без indent уже даёт компактную форму без пробелов и не экранирует не-ASCII — совпадает с ensure_ascii=False.
async function digest16(map) {
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  const buf = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function mountContractsList(container, { screen, objectId, api, rights, go }) {
  let dead = false;
  const canWrite = !!rights?.system_admin || rights?.features?.contracts === "write";
  const canDM = !!rights?.system_admin || (rights?.features || {}).default_contracts === "write";
  const canReadDM = canDM || (rights?.features || {}).default_contracts === "read";
  const S = { loaded: false, error: "", items: [], q: "", archived: false, add: null };
  const DM = { loaded: false, error: "", map: {}, version: null, draft: {}, status: "" };
  container.className = "v2-page v2-app";
  container.innerHTML = `<div class="v2-page-head"><div class="v2-container"><h2>${esc(screen.title)}</h2></div></div>
    <div class="v2-scroll"><div id="cl-inner" class="v2-container"></div></div>`;
  const inner = container.querySelector("#cl-inner");

  async function load() {
    S.error = "";
    try { S.items = objectId ? await api.get(`/contracts?object_id=${objectId}`) : []; S.loaded = true; } catch (err) { S.error = err instanceof ApiError ? err.detail : "Не удалось загрузить контракты"; }
    if (objectId && canReadDM) await loadDefaultMap();
    paint();
  }

  // ------------------------------------------------ контракт по умолчанию (объект из шапки)
  function dmTypes() {
    const types = new Set(Object.keys(DM.map));
    for (const c of S.items) if (!c.is_archived) for (const l of c.lines || []) if (l.element_type) types.add(l.element_type);
    return [...types].sort((a, b) => a.localeCompare(b, "ru"));
  }
  function dmContractsFor(type, selected) {
    return S.items.filter((c) => c.counterparty_id != null && (!c.is_archived || c.id === selected) && (c.lines || []).some((l) => l.element_type === type));
  }
  async function loadDefaultMap() {
    DM.error = "";
    try {
      DM.map = await api.get(`/contracts/default-map?object_id=${objectId}`);
      DM.version = await digest16(DM.map);
      DM.draft = { ...DM.map };
      DM.loaded = true;
    } catch (err) { DM.error = err instanceof ApiError ? err.detail : "Не удалось загрузить контракт по умолчанию"; }
  }
  function dmDirty() {
    const types = dmTypes();
    return types.some((t) => (DM.draft[t] ?? null) !== (DM.map[t] ?? null));
  }
  function dmLabel(id) { const c = S.items.find((x) => x.id === id); return c ? c.name : `#${id}`; }
  async function saveDefaultMap() {
    const types = dmTypes();
    const changes = types.filter((t) => (DM.draft[t] ?? null) !== (DM.map[t] ?? null));
    if (!changes.length) return;
    const text = changes.map((t) => `${t}: ${DM.draft[t] ? dmLabel(DM.draft[t]) : "— не задан —"} (было: ${DM.map[t] ? dmLabel(DM.map[t]) : "— не задан —"})`).join("\n");
    if (!(await showConfirmDialog(`Заменить карту контрактов по умолчанию — изменится:\n${text}`, { confirmLabel: "Сохранить", multiline: true }))) return;
    DM.status = "Сохранение…"; paint();
    const body = {}; for (const t of types) body[t] = DM.draft[t] ?? null;
    try {
      const d = await api.put(`/contracts/default-map?object_id=${objectId}&expected_version=${DM.version}`, body);
      DM.map = d; DM.draft = { ...d }; DM.version = await digest16(d); DM.status = "Сохранено.";
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        const before = DM.version;
        await loadDefaultMap();
        DM.status = `Ответ сервера не получен — исход неизвестен. ${DM.version === before ? "Карта не изменилась — сохранение, похоже, не применилось." : "Карта изменилась — сохранение, похоже, применилось."} Правки, сделанные здесь, потеряны, карта перечитана.`;
      } else if (err instanceof ApiError && err.status === 409) {
        DM.status = `${err.detail} Карта перечитана — правки, сделанные здесь, потеряны.`;
        await loadDefaultMap();
      } else { DM.status = err?.detail || "Не удалось сохранить"; }
    }
    paint();
  }
  function defaultMapHtml() {
    if (!objectId) return "";
    if (!canReadDM) return "";
    if (DM.error && !DM.loaded) return `<div class="v2-bar" style="margin-top:24px"><h3>Контракт по умолчанию по типу изделия</h3></div><p class="v2-note">${esc(DM.error)} <button type="button" class="v2-btn" data-a="dm-retry">Повторить</button></p>`;
    if (!DM.loaded) return `<div class="v2-bar" style="margin-top:24px"><h3>Контракт по умолчанию по типу изделия</h3></div><p class="v2-muted">Загрузка…</p>`;
    const types = dmTypes();
    return `<div class="v2-bar" style="margin-top:24px"><h3>Контракт по умолчанию по типу изделия</h3></div>
      <p class="v2-muted">Подставляется изделию автоматически при первом уходе со статуса «Запланирован», если у изделия ещё нет своего контракта.</p>
      ${types.length ? `<table class="v2-table"><thead><tr><th>Тип изделия</th><th>Контракт по умолчанию</th></tr></thead><tbody>
        ${types.map((t) => `<tr><td>${esc(t)}</td><td><select data-dm-type="${esc(t)}" ${canDM ? "" : "disabled"} aria-label="Контракт по умолчанию: ${esc(t)}">
          <option value="">— не задан —</option>${dmContractsFor(t, DM.draft[t]).map((c) => `<option value="${c.id}" ${DM.draft[t] === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select></td></tr>`).join("")}</tbody></table>` : `<p class="v2-muted">Нет типов изделий с контрактами на этом объекте.</p>`}
      ${canDM ? `<div class="v2-inline" style="margin-top:8px"><button type="button" class="v2-btn v2-primary" data-a="dm-save" ${dmDirty() ? "" : "disabled"}>Сохранить</button><span class="v2-muted">${esc(DM.status)}</span></div>` : ""}`;
  }
  const open = (cp, contract, newSpec) => {
    try { sessionStorage.setItem("v2.cp.deeplink", JSON.stringify({ cp, contract: contract || null, newSpec: newSpec || null })); } catch (e) { /* без ссылки откроется список контрагентов */ }
    go("counterparties");
  };
  async function loadAdd(kind, id) {
    const a = S.add;
    try {
      if (kind === "cp") { a.agreements = []; a.specs = []; a.agreement = ""; a.spec = ""; a.cp = id; if (id) a.agreements = await api.get(`/agreements?counterparty_id=${id}&object_id=${objectId}`); }
      else if (kind === "agreement") { a.specs = []; a.spec = ""; a.agreement = id; if (id) a.specs = await api.get(`/specifications?agreement_id=${id}`); }
      a.error = "";
    } catch (err) { a.error = err instanceof ApiError ? err.detail : "Не удалось загрузить список"; }
    paint();
  }
  function paint() {
    if (dead) return;
    if (S.error && !S.loaded) { inner.innerHTML = `<p class="v2-note">${esc(S.error)} <button type="button" class="v2-btn" data-a="retry">Повторить</button></p>`; bind(); return; }
    if (!S.loaded) { inner.innerHTML = `<p class="v2-muted">Загрузка…</p>`; return; }
    const q = S.q.trim().toLowerCase();
    const rows = S.items.filter((c) => (S.archived || !c.is_archived) && (!q || [c.counterparty_short_name, c.agreement_number, c.specification_number, c.theme, c.name].some((v) => String(v || "").toLowerCase().includes(q))));
    const a = S.add;
    inner.innerHTML = `<div class="v2-bar"><h3>Контракты</h3>${canWrite ? `<button type="button" class="v2-btn v2-primary" data-a="add" ${a ? "disabled" : ""}>Добавить контракт</button>` : ""}</div>
      ${a ? `<div class="v2-callout" role="group" aria-label="Новый контракт"><strong>Новый контракт — под какой спецификацией</strong>
        <div class="v2-inline" style="margin-top:8px">
          <select data-add="cp" aria-label="Контрагент"><option value="">— контрагент —</option>${(a.cps || []).map((c) => `<option value="${c.id}" ${String(a.cp) === String(c.id) ? "selected" : ""}>${esc(c.short_name)}</option>`).join("")}</select>
          <select data-add="agreement" aria-label="Договор" ${a.agreements?.length ? "" : "disabled"}><option value="">— договор —</option>${(a.agreements || []).map((g) => `<option value="${g.id}" ${String(a.agreement) === String(g.id) ? "selected" : ""}>${esc(g.number)} ${ruDate(g.agreement_date)}</option>`).join("")}</select>
          <select data-add="spec" aria-label="Спецификация" ${a.specs?.length ? "" : "disabled"}><option value="">— спецификация —</option>${(a.specs || []).map((s) => `<option value="${s.id}" ${String(a.spec) === String(s.id) ? "selected" : ""}>${esc(s.number)} ${ruDate(s.specification_date)}</option>`).join("")}</select>
          <button type="button" class="v2-btn v2-primary" data-a="add-go" ${a.spec ? "" : "disabled"}>Создать контракт</button><button type="button" class="v2-btn" data-a="add-cancel">Отмена</button></div>
        ${a.error ? `<p class="v2-auth-error" role="alert">${esc(a.error)}</p>` : ""}
        <p class="v2-muted">Договор и спецификацию заводят в карточке контрагента («Контрактация»). Позиции, количество и остальное заполняются в форме контракта.</p></div>` : ""}
      <div class="v2-inline" style="margin:8px 0"><input type="search" data-q placeholder="Поиск: контрагент, договор, спецификация, тема" aria-label="Поиск по контрактам" value="${esc(S.q)}" style="min-width:340px"><label class="v2-inline"><input type="checkbox" data-arch ${S.archived ? "checked" : ""}> показывать архивные</label><span class="v2-muted">Найдено: ${rows.length} из ${S.items.length}</span></div>
      ${rows.length ? `<table class="v2-table"><thead><tr><th>Контрагент</th><th>Договор</th><th>Спецификация</th><th>Тема</th><th>Позиций</th><th>Привязано изделий</th><th>Архивный</th><th></th></tr></thead><tbody>
        ${rows.slice(0, 500).map((c) => `<tr><td>${esc(c.counterparty_short_name)}</td><td>${esc(c.agreement_number)} ${ruDate(c.agreement_date)}</td><td>${esc(c.specification_number)} ${ruDate(c.specification_date)}</td><td>${esc(c.theme || "")}</td><td>${c.lines?.length ?? 0}</td><td>${c.linked_elements ?? 0}</td><td>${c.is_archived ? "да" : "нет"}</td><td><button type="button" class="v2-btn" data-open="${c.id}" data-cp="${c.counterparty_id}">Открыть</button></td></tr>`).join("")}</tbody></table>${rows.length > 500 ? `<p class="v2-muted">Показаны первые 500 — уточните поиск.</p>` : ""}` : `<p class="v2-note">Контрактов не найдено.</p>`}
      ${defaultMapHtml()}`;
    bind();
  }
  function bind() {
    inner.querySelector('[data-a="retry"]')?.addEventListener("click", load);
    inner.querySelector('[data-a="dm-retry"]')?.addEventListener("click", async () => { await loadDefaultMap(); paint(); });
    inner.querySelector('[data-a="dm-save"]')?.addEventListener("click", saveDefaultMap);
    inner.querySelectorAll("[data-dm-type]").forEach((sel) => sel.addEventListener("change", (e) => { DM.draft[e.target.dataset.dmType] = e.target.value ? Number(e.target.value) : null; paint(); }));
    inner.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => open(Number(b.dataset.cp), Number(b.dataset.open))));
    const q = inner.querySelector("[data-q]");
    q?.addEventListener("input", () => { S.q = q.value; const pos = q.selectionStart; paint(); const n = inner.querySelector("[data-q]"); n?.focus(); try { n?.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } });
    inner.querySelector("[data-arch]")?.addEventListener("change", (e) => { S.archived = e.target.checked; paint(); });
    inner.querySelector('[data-a="add"]')?.addEventListener("click", async () => {
      S.add = { cps: [], agreements: [], specs: [], cp: "", agreement: "", spec: "", error: "" }; paint();
      try { S.add.cps = await api.get("/counterparties"); } catch (err) { S.add.error = err instanceof ApiError ? err.detail : "Не удалось загрузить контрагентов"; }
      paint();
    });
    inner.querySelector('[data-a="add-cancel"]')?.addEventListener("click", () => { S.add = null; paint(); });
    inner.querySelector('[data-add="cp"]')?.addEventListener("change", (e) => loadAdd("cp", e.target.value));
    inner.querySelector('[data-add="agreement"]')?.addEventListener("change", (e) => loadAdd("agreement", e.target.value));
    inner.querySelector('[data-add="spec"]')?.addEventListener("change", (e) => { S.add.spec = e.target.value; paint(); });
    inner.querySelector('[data-a="add-go"]')?.addEventListener("click", () => { const a = S.add; if (a?.cp && a.spec) open(Number(a.cp), null, Number(a.spec)); });
  }
  load();
  return {
    hasUnsavedChanges: () => DM.loaded && dmDirty(),
    guardLeave: async () => {
      if (!DM.loaded || !dmDirty()) return true;
      const choice = await showUnsavedDialog("Есть несохранённые изменения в карте контрактов по умолчанию.");
      if (choice === "cancel") return false;
      if (choice === "save") { await saveDefaultMap(); return !dmDirty(); }
      DM.draft = { ...DM.map };   // discard
      return true;
    },
    destroy: () => { dead = true; },
  };
}
