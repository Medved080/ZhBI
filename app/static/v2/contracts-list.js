// V2: «Контракты» — список контрактов всех доступных объектов (GET /contracts) с поиском и переходом к работе с контрактом.
// Создание и правка контракта (тема, позиции и количество, инциденты, нормативы, архив, удаление с переносом изделий, плановая дата поставки)
// выполняются в карточке контрагента — там реализованы все проверки (версия записи, страж покрытия, отказ без изменений). Отсюда — «Открыть»
// (карточка контрагента → «Контрактация» → контракт) и «Добавить контракт» (выбор контрагент → договор → спецификация → форма нового контракта).
// Сам список ничего не изменяет.
import { esc } from "./screen-view.js";
import { ApiError } from "./api.js";

const ruDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };

export function mountContractsList(container, { screen, api, rights, go }) {
  let dead = false;
  const canWrite = !!rights?.system_admin || rights?.features?.contracts === "write";
  const S = { loaded: false, error: "", items: [], q: "", archived: false, add: null };
  container.className = "v2-page v2-app";
  container.innerHTML = `<div class="v2-page-head"><div class="v2-container"><h2>${esc(screen.title)}</h2></div></div>
    <div class="v2-scroll"><div id="cl-inner" class="v2-container"></div></div>`;
  const inner = container.querySelector("#cl-inner");

  async function load() {
    S.error = "";
    try { S.items = await api.get("/contracts"); S.loaded = true; } catch (err) { S.error = err instanceof ApiError ? err.detail : "Не удалось загрузить контракты"; }
    paint();
  }
  const open = (cp, contract, newSpec) => {
    try { sessionStorage.setItem("v2.cp.deeplink", JSON.stringify({ cp, contract: contract || null, newSpec: newSpec || null })); } catch (e) { /* без ссылки откроется список контрагентов */ }
    go("counterparties");
  };
  async function loadAdd(kind, id) {
    const a = S.add;
    try {
      if (kind === "cp") { a.agreements = []; a.specs = []; a.agreement = ""; a.spec = ""; a.cp = id; if (id) a.agreements = await api.get(`/agreements?counterparty_id=${id}`); }
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
        ${rows.slice(0, 500).map((c) => `<tr><td>${esc(c.counterparty_short_name)}</td><td>${esc(c.agreement_number)} ${ruDate(c.agreement_date)}</td><td>${esc(c.specification_number)} ${ruDate(c.specification_date)}</td><td>${esc(c.theme || "")}</td><td>${c.lines?.length ?? 0}</td><td>${c.linked_elements ?? 0}</td><td>${c.is_archived ? "да" : "нет"}</td><td><button type="button" class="v2-btn" data-open="${c.id}" data-cp="${c.counterparty_id}">Открыть</button></td></tr>`).join("")}</tbody></table>${rows.length > 500 ? `<p class="v2-muted">Показаны первые 500 — уточните поиск.</p>` : ""}` : `<p class="v2-note">Контрактов не найдено.</p>`}`;
    bind();
  }
  function bind() {
    inner.querySelector('[data-a="retry"]')?.addEventListener("click", load);
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
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy: () => { dead = true; } };
}
