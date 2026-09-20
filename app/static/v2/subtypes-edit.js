// «Типы и подтипы элементов»: подтипы выбранного в шапке объекта — добавить, удалить неиспользуемый. Те же API и права, что у V1
// (`POST /allowed-subtypes`, удаление — общий `/dictionaries/subtype/…` с планом последствий). Марки типов остаются в V1.
// Барьер: объект из контекста (смена объекта проходит сторож несохранённого), повтор существующего подтипа не отправляется
// (сервер молча проигнорировал бы его как «успех»), подтип с изделиями здесь не удаляется (нужна замена — V1), одна запись
// за раз, ввод не теряется при ошибке, успех — после повторного чтения, неизвестный исход не повторяется.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

export function mountSubtypesEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.subtypes;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false, busy = false, seq = 0;
  const st = { data: null, error: "", inputs: {} }; // inputs: {тип: введённый подтип}
  const path = `${spec.endpoint}?object_id=${objectId}`;
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Правка подтипов в новом интерфейсе." : "Просмотр подтипов."}</strong>
        ${canWrite ? "Справочник подтипов — свой у каждого объекта. Подтип с изделиями здесь не удаляется (нужна замена — в текущем интерфейсе); марки типов — тоже там." : "У вас нет права изменять справочник подтипов."}
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="sb-body"></div><p id="sb-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#sb-status"); if (n) n.textContent = t; };
  const dirty = () => Object.values(st.inputs).some((v) => String(v).trim() !== "");
  const lock = () => el.querySelectorAll("#sb-body button, #sb-body input").forEach((c) => { c.disabled = busy; });

  function paint() {
    if (dead) return;
    const body = $("#sb-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — справочник подтипов свой у каждого объекта.</p>`; return; }
    if (!st.data) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить подтипы.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="sb-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#sb-retry")?.addEventListener("click", load);
      return;
    }
    body.innerHTML = Object.entries(st.data).map(([type, subs]) => `<section class="v2-card" style="margin-bottom:12px" data-type="${esc(type)}">
      <h3 class="v2-report-h">${esc(type)} <span class="v2-muted">· подтипов: ${subs.length}</span></h3>
      ${subs.length ? `<ul class="v2-card-list">${subs.map((s) => `<li><span>${esc(s)}</span>${canWrite ? `<button type="button" class="v2-btn v2-danger" data-del="${esc(s)}" data-type="${esc(type)}" aria-label="Удалить подтип ${esc(s)} у типа ${esc(type)}">Удалить</button>` : ""}</li>`).join("")}</ul>` : `<p class="v2-muted">Подтипов нет.</p>`}
      ${canWrite ? `<div class="v2-bar"><input type="text" class="v2-search" data-add-input="${esc(type)}" placeholder="новый подтип" aria-label="Новый подтип для типа ${esc(type)}" value="${esc(st.inputs[type] || "")}" maxlength="120">
        <button type="button" class="v2-btn v2-primary" data-add="${esc(type)}">Добавить</button></div>` : ""}</section>`).join("");
    lock();
  }
  async function load() {
    if (!objectId) { paint(); return false; }
    const my = ++seq;
    try {
      const data = await api.get(path);
      if (dead || my !== seq) return false;
      st.data = data; st.error = ""; paint(); return true;
    } catch (e) {
      if (dead || my !== seq) return false;
      if (!st.data) { st.error = errText(e); paint(); } else setStatus(`Список не обновился: ${errText(e)}`);
      return false;
    }
  }
  async function write(fn) { if (busy) return; busy = true; lock(); try { await fn(); } finally { busy = false; lock(); } }

  async function add(type) {
    const subtype = String(st.inputs[type] || "").trim();
    if (!subtype) { setStatus("Введите название подтипа."); el.querySelector(`[data-add-input="${CSS.escape(type)}"]`)?.focus(); return; }
    if ((st.data[type] || []).some((x) => x.toLowerCase() === subtype.toLowerCase())) { setStatus(`Подтип «${subtype}» у типа «${type}» уже есть.`); return; }
    await write(async () => {
      setStatus("Сохранение…");
      try {
        await api.post(spec.endpoint, { object_id: objectId, element_type: type, subtype });
        st.inputs[type] = "";
        const ok = await load();
        setStatus(ok && (st.data[type] || []).includes(subtype) ? `Добавлено: «${subtype}» (тип «${type}»).` : ok ? "Сервер не вернул добавленный подтип — проверьте список." : "Добавлено, но список обновить не удалось — обновите страницу.");
      } catch (e) {
        if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && (st.data[type] || []).includes(subtype) ? `Сервер сохранил «${subtype}», хотя ответ не дошёл.` : ok ? `Подтип не добавлен: ${errText(e)}` : `Неизвестно, добавлен ли подтип (${errText(e)}). Обновите страницу.`); }
        else setStatus(errText(e));
        el.querySelector(`[data-add-input="${CSS.escape(type)}"]`)?.focus();
      }
    });
  }
  async function del(type, subtype) {
    await write(async () => {
      setStatus("Проверяем, где подтип используется…");
      const key = `${objectId}|${type}|${subtype}`;
      let plan;
      try { plan = (await api.get(`/dictionaries/subtype/${encodeURIComponent(key)}/delete-plan`)).plan; }
      catch (e) { setStatus(`Не удалось получить план удаления: ${errText(e)}`); return; }
      setStatus("");
      if (plan.blockers?.length || plan.needs_replacement || (plan.refs || []).some((r) => r.count > 0)) {
        await showInfoDialog(`Подтип «${subtype}» используется: ${(plan.refs || []).map((r) => `${r.label} — ${r.count}`).join("; ") || "другими данными"}.\nУдаление с заменой выполняется в текущем интерфейсе — здесь оно недоступно, чтобы изделия не остались с несуществующим подтипом.`);
        return;
      }
      if (!(await showConfirmDialog(`Удалить подтип «${subtype}» у типа «${type}»? Изделий с ним нет.`, { confirmLabel: "Удалить", danger: true }))) return;
      try {
        await api.post(`/dictionaries/subtype/${encodeURIComponent(key)}/delete`, { replacements: {}, mode: "replace" });
        const ok = await load();
        setStatus(ok && !(st.data[type] || []).includes(subtype) ? `Удалено: «${subtype}».` : ok ? "Сервер вернул подтип после удаления — проверьте." : "Удалено, но список обновить не удалось — обновите страницу.");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { await load(); setStatus("Подтип уже удалён — список обновлён."); }
        else if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && !(st.data[type] || []).includes(subtype) ? "Подтип удалён, хотя ответ не дошёл." : `Неизвестно, удалён ли подтип (${errText(e)}). Проверьте список.`); }
        else setStatus(errText(e));
      }
    });
  }
  el.addEventListener("input", (e) => { const t = e.target.dataset?.addInput; if (t !== undefined) st.inputs[t] = e.target.value; });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || busy) return;
    if (b.dataset.add !== undefined) add(b.dataset.add);
    else if (b.dataset.del !== undefined) { if (dirty()) { setStatus("Сначала добавьте или очистите введённый подтип."); return; } del(b.dataset.type, b.dataset.del); }
  });
  paint(); load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const c = await showUnsavedDialog("Введён подтип, но не добавлен. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      for (const [type, v] of Object.entries(st.inputs)) if (String(v).trim()) await add(type);
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
