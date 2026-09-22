// «Типы и подтипы элементов»: подтипы И марки выбранного в шапке объекта — тот же комбинированный экран, что в V1
// (`subtypes-backdrop`: «Подтипы» и «Марки» одной формой на тип элемента). Те же API и права, что у V1:
// подтипы — `POST /allowed-subtypes`, удаление — общий `/dictionaries/subtype/…` с планом последствий;
// марки — `POST /marks`, `PATCH /marks/{id}` (переименование ведёт за собой ТЕКСТ марки везде, где он лежит
// копией — у изделий и в позициях контрактов; сервер делает это одной операцией), удаление — общий
// `/dictionaries/mark/…` с планом последствий.
//
// Барьер: объект из контекста (смена объекта проходит сторож несохранённого), повтор существующего подтипа/марки
// не отправляется (сервер молча проигнорировал бы его как «успех»), подтип/марка с изделиями удаляются только с заменой
// (план последствий с выбором записи-замены — тот же поток, что у справочников контрактации и в V1);
// переименование марки — ТОЛЬКО после показа числа затронутых изделий и позиций контрактов (уже в ответе списка)
// и подтверждения человеком: сервер двигает текст молча, и без этого шага решение принято не глядя; одна запись
// за раз, ввод не теряется при ошибке, успех — после повторного чтения, неизвестный исход не повторяется.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showConfirmDialog, showInfoDialog, showUnsavedDialog } from "./dialogs.js";
import { runDeleteFlow } from "./delete-plan.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

export function mountSubtypesEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.subtypes;
  const markSpec = screen.marks;
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  const canWriteMarks = markSpec && (!!rights?.system_admin || rights?.features?.[markSpec.feature] === "write");
  let dead = false, busy = false, seq = 0;
  // subtypes: {тип: [подтип...]}; marks: {тип: [{id, name, object_id, element_type, elements_count, contract_lines_count}]}
  const st = { data: null, marks: null, error: "", inputs: {}, markInputs: {}, markEdits: {} }; // inputs/markInputs: {тип: введённый текст}; markEdits: {id: введённое название}
  const path = `${spec.endpoint}?object_id=${objectId}`;
  const markPath = markSpec ? `${markSpec.endpoint}?object_id=${objectId}` : null;
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite || canWriteMarks ? "Правка в новом интерфейсе." : "Просмотр."}</strong>
        Подтипы и марки — свои у каждого объекта, наполняются сами при загрузке чертежа. Запись с изделиями здесь не удаляется без замены — план последствий откроет выбор записи-замены.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="sb-body"></div><p id="sb-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#sb-status"); if (n) n.textContent = t; };
  const dirty = () => Object.values(st.inputs).some((v) => String(v).trim() !== "") || Object.values(st.markInputs).some((v) => String(v).trim() !== "");
  const lock = () => el.querySelectorAll("#sb-body button, #sb-body input").forEach((c) => { c.disabled = busy; });

  function marksOfType(type) { return (st.marks?.[type]) || []; }

  function paint() {
    if (dead) return;
    const body = $("#sb-body");
    if (!objectId) { body.innerHTML = `<p class="v2-muted">Выберите объект в шапке — справочники свои у каждого объекта.</p>`; return; }
    if (!st.data) {
      body.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить справочники.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="sb-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#sb-retry")?.addEventListener("click", load);
      return;
    }
    body.innerHTML = Object.entries(st.data).map(([type, subs]) => `<section class="v2-card" style="margin-bottom:12px" data-type="${esc(type)}">
      <h3 class="v2-report-h">${esc(type)} <span class="v2-muted">· подтипов: ${subs.length}</span></h3>
      ${subs.length ? `<ul class="v2-card-list">${subs.map((s) => `<li><span>${esc(s)}</span>${canWrite ? `<button type="button" class="v2-btn v2-danger" data-del="${esc(s)}" data-type="${esc(type)}" aria-label="Удалить подтип ${esc(s)} у типа ${esc(type)}">Удалить</button>` : ""}</li>`).join("")}</ul>` : `<p class="v2-muted">Подтипов нет.</p>`}
      ${canWrite ? `<div class="v2-bar"><input type="text" class="v2-search" data-add-input="${esc(type)}" placeholder="новый подтип" aria-label="Новый подтип для типа ${esc(type)}" value="${esc(st.inputs[type] || "")}" maxlength="120">
        <button type="button" class="v2-btn v2-primary" data-add="${esc(type)}">Добавить</button></div>` : ""}
      ${markSpec ? paintMarksPart(type) : ""}</section>`).join("");
    lock();
  }

  function paintMarksPart(type) {
    const marks = marksOfType(type);
    return `<div class="v2-card" style="margin-top:10px;background:transparent;border:none;padding:0">
      <h4 style="margin:0 0 6px">Марки <span class="v2-muted">· ${marks.length}</span></h4>
      ${marks.length ? `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Марка</th><th class="num">Изделий</th><th class="num">Позиций контрактов</th>${canWriteMarks ? "<th></th>" : ""}</tr></thead><tbody>
        ${marks.map((m) => `<tr data-mark-id="${m.id}"><td>${canWriteMarks
          ? `<input type="text" class="v2-search" data-mark-input="${m.id}" value="${esc(st.markEdits[m.id] ?? m.name)}" aria-label="Название марки ${esc(m.name)}" maxlength="200">`
          : esc(m.name)}</td><td class="num">${m.elements_count}</td><td class="num">${m.contract_lines_count}</td>
          ${canWriteMarks ? `<td><button type="button" class="v2-btn v2-danger" data-del-mark="${m.id}" aria-label="Удалить марку ${esc(m.name)}">Удалить</button></td>` : ""}</tr>`).join("")}
      </tbody></table></div>` : `<p class="v2-muted">Марок нет.</p>`}
      ${canWriteMarks ? `<div class="v2-bar" style="margin-top:6px"><input type="text" class="v2-search" data-add-mark="${esc(type)}" placeholder="новая марка" aria-label="Новая марка для типа ${esc(type)}" value="${esc(st.markInputs[type] || "")}" maxlength="200">
        <button type="button" class="v2-btn v2-primary" data-add-mark-btn="${esc(type)}">Добавить</button></div>` : ""}
    </div>`;
  }

  async function load() {
    if (!objectId) { paint(); return false; }
    const my = ++seq;
    try {
      const [subtypes, marks] = await Promise.all([
        api.get(path),
        markSpec ? api.get(markPath) : Promise.resolve(null),
      ]);
      if (dead || my !== seq) return false;
      st.data = subtypes; st.error = "";
      if (markSpec) {
        const byType = {};
        for (const m of marks) (byType[m.element_type] ||= []).push(m);
        for (const list of Object.values(byType)) list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
        st.marks = byType;
      }
      paint();
      return true;
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
  // Удаление подтипа, как в V1 (openDictDelete): неиспользуемый — подтверждение с названием; используемый изделиями — общий поток
  // плана последствий (delete-plan.js) с выбором подтипа-замены того же типа: ссылки изделий переносит сервер в той же транзакции,
  // что и удаление, план перечитывается перед отправкой.
  async function del(type, subtype) {
    await write(async () => {
      setStatus("Проверяем, где подтип используется…");
      const key = `${objectId}|${type}|${subtype}`;
      let plan;
      try { plan = await api.get(`/dictionaries/subtype/${encodeURIComponent(key)}/delete-plan`); }
      catch (e) { setStatus(`Не удалось получить план удаления: ${errText(e)}`); return; }
      setStatus("");
      const used = plan.plan.needs_replacement || (plan.plan.refs || []).some((r) => r.count > 0);
      if (used || plan.blockers?.length) {
        const result = await runDeleteFlow({ api, kind: "subtype", id: encodeURIComponent(key) });
        if (result === "cancelled") return;
        const ok = await load();
        const gone = ok && !(st.data[type] || []).includes(subtype);
        if (result === "deleted") setStatus(gone ? `Удалено: «${subtype}», изделия переведены на замену.` : ok ? "Сервер вернул подтип после удаления — проверьте." : "Удалено, но список обновить не удалось — обновите страницу.");
        else if (result === "exists") setStatus(`Подтип «${subtype}» остался на месте (ответ сервера не дошёл) — повторите удаление вручную.`);
        else if (result === "unknown") setStatus(gone ? "Подтип удалён, хотя ответ не дошёл." : `Неизвестно, удалён ли подтип «${subtype}» — проверьте список.`);
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

  // ---- марки ----
  async function addMark(type) {
    const name = String(st.markInputs[type] || "").trim();
    if (!name) { setStatus("Введите название марки."); el.querySelector(`[data-add-mark="${CSS.escape(type)}"]`)?.focus(); return; }
    if (marksOfType(type).some((m) => m.name === name)) { setStatus(`Марка «${name}» у типа «${type}» уже есть.`); return; }
    await write(async () => {
      setStatus("Сохранение…");
      try {
        await api.post(markSpec.endpoint, { object_id: objectId, element_type: type, name });
        delete st.markInputs[type];
        const ok = await load();
        setStatus(ok && marksOfType(type).some((m) => m.name === name) ? `Добавлено: «${name}» (тип «${type}»).` : ok ? "Сервер не вернул добавленную марку — проверьте список." : "Добавлено, но список обновить не удалось — обновите страницу.");
      } catch (e) {
        if (unknownOutcome(e)) { const ok = await load(); setStatus(ok && marksOfType(type).some((m) => m.name === name) ? `Сервер сохранил «${name}», хотя ответ не дошёл.` : ok ? `Марка не добавлена: ${errText(e)}` : `Неизвестно, добавлена ли марка (${errText(e)}). Обновите страницу.`); }
        else setStatus(errText(e));
        el.querySelector(`[data-add-mark="${CSS.escape(type)}"]`)?.focus();
      }
    });
  }

  // Переименование марки: сервер двигает ТЕКСТ вместе со ссылкой у изделий и в позициях контрактов —
  // решение принимается не глядя быть не должно, поэтому ДО отправки показывается план последствий
  // (числа уже известны из списка) и требуется подтверждение.
  async function renameMark(mark, name) {
    if (!name) { setStatus("Название марки не может быть пустым."); delete st.markEdits[mark.id]; paint(); return; }
    if (name === mark.name) { delete st.markEdits[mark.id]; return; }
    const затронет = [];
    if (mark.elements_count) затронет.push(`изделий: ${mark.elements_count}`);
    if (mark.contract_lines_count) затронет.push(`позиций контрактов: ${mark.contract_lines_count}`);
    const msg = `Переименовать марку «${mark.name}» в «${name}»?`
      + (затронет.length ? ` Текст марки будет заменён везде, где он лежит копией: ${затронет.join(", ")}.` : " Изделий и позиций контрактов с этой маркой сейчас нет.");
    if (!(await showConfirmDialog(msg, { confirmLabel: "Переименовать" }))) { delete st.markEdits[mark.id]; paint(); return; }
    await write(async () => {
      setStatus("Сохранение…");
      try {
        await api.patch(`${markSpec.endpoint}/${mark.id}`, { object_id: mark.object_id, element_type: mark.element_type, name });
        delete st.markEdits[mark.id];
        const ok = await load();
        setStatus(ok ? `Переименовано: «${mark.name}» → «${name}».` : "Переименовано, но список обновить не удалось — обновите страницу.");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { await load(); setStatus("Марка уже удалена другим пользователем — список обновлён."); }
        else if (unknownOutcome(e)) {
          const ok = await load();
          const now = ok && marksOfType(mark.element_type).find((m) => m.id === mark.id);
          setStatus(now && now.name === name ? `Сервер сохранил новое название «${name}», хотя ответ не дошёл.` : `Неизвестно, применено ли переименование (${errText(e)}). Проверьте список.`);
          if (now && now.name === name) delete st.markEdits[mark.id];
        } else { setStatus(errText(e)); }
        paint();
      }
    });
  }

  async function delMark(mark) {
    await write(async () => {
      const result = await runDeleteFlow({ api, kind: "mark", id: mark.id });
      if (result === "deleted") { const ok = await load(); setStatus(ok ? `Удалено: «${mark.name}».` : "Удалено, но список обновить не удалось — обновите страницу."); }
      else if (result === "exists") setStatus(`Марка «${mark.name}» осталась на месте (ответ сервера не дошёл) — повторите удаление вручную.`);
      else if (result === "unknown") setStatus(`Неизвестно, удалена ли марка «${mark.name}» — проверьте список.`);
    });
  }

  el.addEventListener("input", (e) => {
    const t = e.target.dataset?.addInput; if (t !== undefined) st.inputs[t] = e.target.value;
    const tm = e.target.dataset?.addMark; if (tm !== undefined) st.markInputs[tm] = e.target.value;
    const mi = e.target.dataset?.markInput; if (mi !== undefined) st.markEdits[Number(mi)] = e.target.value;
  });
  el.addEventListener("focusout", (e) => {
    const mi = e.target.dataset?.markInput;
    if (mi === undefined || busy) return;
    const id = Number(mi);
    const mark = Object.values(st.marks || {}).flat().find((m) => m.id === id);
    if (!mark) return;
    const name = String(e.target.value || "").trim();
    renameMark(mark, name);
  });
  el.addEventListener("keydown", (e) => {
    if (e.target.dataset?.markInput !== undefined && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || busy) return;
    if (b.dataset.add !== undefined) add(b.dataset.add);
    else if (b.dataset.del !== undefined) { if (dirty()) { setStatus("Сначала добавьте или очистите введённый подтип/марку."); return; } del(b.dataset.type, b.dataset.del); }
    else if (b.dataset.addMarkBtn !== undefined) addMark(b.dataset.addMarkBtn);
    else if (b.dataset.delMark !== undefined) {
      if (dirty()) { setStatus("Сначала добавьте или очистите введённый подтип/марку."); return; }
      const id = Number(b.dataset.delMark);
      const mark = Object.values(st.marks || {}).flat().find((m) => m.id === id);
      if (mark) delMark(mark);
    }
  });
  paint(); load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const c = await showUnsavedDialog("Введён подтип или марка, но не добавлены. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      for (const [type, v] of Object.entries(st.inputs)) if (String(v).trim()) await add(type);
      for (const [type, v] of Object.entries(st.markInputs)) if (String(v).trim()) await addMark(type);
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
