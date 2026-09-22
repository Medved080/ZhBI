// Окна «Учёта по блокам» V2, общие для экрана «Учёт по блокам», «Журнала факта» и рабочего места МФР:
// документ факта, карточка ЗР, состав работ блоков (с предпросмотром), групповая правка сроков (с предпросмотром).
// Права и API — как у V1 (раздел `work_progress`); каждая запись идёт через `api.js` и шлюз `write-gate.js`.
import { esc, errText, fmtDate, shortDate, openModal, settle, isConflict, conflictText, OUTCOME_TEXT, DEADLINE } from "./mfr-common.js";
import { mountFactForm } from "./fact-form.js";
import { mountBlockWorkForm } from "./block-work-form.js";
import { mountWorkTypeTree } from "./mfr-tree.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";

// ---------------------------------------------------------------- документ факта
export function openFactDialog({ api, objectId, blockId, blockLabel, reportId = null, date = null, highlight = [], canWrite, onChanged, onClosed }) {
  let form = null;
  const m = openModal({ title: `Факт · ${blockLabel}`, wide: true, onRequestClose: async () => (form ? form.guard() : true) });
  form = mountFactForm(m.body, { api, objectId, blockId, blockLabel, reportId, date, highlight, canWrite, onChanged, onClose: () => m.requestClose() });
  m.dirty = () => !!form?.dirty(); m.guard = () => form.guard();
  const close = m.close;
  m.close = () => { form?.destroy(); close(); onClosed?.(); };
  return m;
}

// ---------------------------------------------------------------- карточка ЗР
export function openZrDialog({ api, objectId, id, canWrite, onSaved, onClosed, blockLabels = {} }) {
  let form = null, m = null;
  m = openModal({ title: "Запланированная работа", wide: true, onRequestClose: async () => (form ? form.guard() : true) });
  form = mountBlockWorkForm(m.body, {
    api, objectId, id, canWrite, onSaved,
    onClose: () => m.requestClose(),
    // «Открыть документ»: карточка закрывается (форма факта — отдельное окно), после закрытия факта список работ перечитывается
    onOpenFact: async (blockId, reportId, highlight) => {
      if (form && !(await form.guard())) return;
      m.close();
      openFactDialog({ api, objectId, blockId, blockLabel: blockLabels[blockId] || `блок ${blockId}`, reportId, highlight, canWrite, onChanged: onSaved });
    },
  });
  m.dirty = () => !!form?.dirty(); m.guard = () => form.guard();
  const close = m.close;
  m.close = () => { form?.destroy(); close(); onClosed?.(); };
  return m;
}

// ---------------------------------------------------------------- состав работ блоков (ЗР) с предпросмотром
// blocks: [{id, label}]. Один блок — `PUT …/blocks/{id}/work-types-settings`, несколько — `PUT …/blocks/work-types-settings` (одна транзакция).
export function openSettingsDialog({ api, objectId, blocks, canWrite, onSaved, onClosed }) {
  const ids = blocks.map((b) => b.id);
  const group = ids.length > 1;
  let tree = null, busy = false, dead = false;
  const st = { data: null, error: "", preview: null, status: "", kind: "", initial: new Set(), conflict: false };
  const m = openModal({
    title: group ? `Состав работ · блоков: ${ids.length}` : `Состав работ · ${blocks[0].label}`, wide: true,
    onRequestClose: async () => {
      if (busy) return false;
      if (!canWrite || !tree || !changed()) return true;
      const c = await showUnsavedDialog("Состав работ изменён, но не сохранён. Что сделать?");
      if (c === "cancel") return false;
      return c === "discard";   // «сохранить и продолжить» здесь отдельный шаг с предпросмотром — закрытие не сохраняет молча
    },
  });
  const chosen = () => (tree ? new Set(tree.selected()) : new Set(st.initial));
  const changed = () => { const a = chosen(), b = st.initial; return a.size !== b.size || [...a].some((x) => !b.has(x)); };
  m.dirty = () => canWrite && !!tree && !dead && changed();
  m.guard = async () => { const c = await showUnsavedDialog("Состав работ изменён, но не сохранён. Что сделать?"); return c === "discard"; };
  const setStatus = (t, kind = "") => { st.status = t; st.kind = kind; const n = m.body.querySelector("#ss-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };

  async function load() {
    st.error = ""; st.preview = null; st.conflict = false; paint();
    try {
      st.data = group ? await api.get(`/objects/${objectId}/blocks/work-types-settings?block_ids=${ids.join(",")}`)
        : await api.get(`/objects/${objectId}/blocks/${ids[0]}/work-types-settings`);
      st.initial = new Set(group ? st.data.selected_all : st.data.selected);
      tree = null;   // дерево строится заново из состава сервера
    } catch (e) { st.error = errText(e); }
    if (dead) return;
    paint();
  }

  function paint() {
    if (dead) return;
    if (st.error && !st.data) { m.body.innerHTML = `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить состав работ.</strong> ${esc(st.error)} <button type="button" class="v2-btn" id="ss-retry">Повторить</button></div>`; m.body.querySelector("#ss-retry").addEventListener("click", load); return; }
    if (!st.data) { m.body.innerHTML = `<p class="v2-muted" role="status">Загрузка…</p>`; return; }
    const d = st.data;
    const partial = group ? new Set(d.selected_some) : new Set();
    m.body.innerHTML = `<div class="mfr-set">
      <p class="v2-muted">${group ? `Один список для ${ids.length} блоков. Отмечено — у всех выбранных; промежуточное состояние — только у части (при сохранении снимется у всех, если не отметить).` : "Виды работ, которые идут на этом блоке. Снятие работы, по которой уже есть сроки или факт, — «мягкое»: строка сохраняется, история не теряется."}</p>
      <div class="v2-bar"><button type="button" class="v2-btn" id="ss-all" ${canWrite && !busy ? "" : "disabled"}>Отметить всё</button><button type="button" class="v2-btn" id="ss-none" ${canWrite && !busy ? "" : "disabled"}>Снять всё</button>
        <span class="v2-muted" id="ss-count"></span></div>
      <div class="mfr-set-tree" id="ss-tree"></div>
      <div id="ss-preview">${st.preview ? previewHtml() : ""}</div>
      <p id="ss-status" class="mfr-status ${esc(st.kind)}" role="status" aria-live="polite">${esc(st.status)}</p>
      <div class="v2-bar mfr-actions">${canWrite ? (st.preview ? `<button type="button" class="v2-btn v2-primary" id="ss-apply" ${busy ? "disabled" : ""}>Применить</button><button type="button" class="v2-btn" id="ss-back" ${busy ? "disabled" : ""}>Назад к выбору</button>`
        : `<button type="button" class="v2-btn v2-primary" id="ss-preview-btn" ${busy || !changed() ? "disabled" : ""}>Проверить изменения</button>`) : `<span class="v2-muted">Только просмотр (нет права на изменение)</span>`}
        ${st.conflict ? `<button type="button" class="v2-btn" id="ss-reload">Обновить состав с сервера</button>` : ""}</div></div>`;
    tree = mountWorkTypeTree(m.body.querySelector("#ss-tree"), d.options, chosen(), { partial, disabled: !canWrite || !!st.preview || busy, onChange: () => { count(); const b = m.body.querySelector("#ss-preview-btn"); if (b) b.disabled = !changed(); } });
    if (st.preview) tree.setDisabled(true);
    count();
    bind();
  }
  const count = () => { const n = m.body.querySelector("#ss-count"); if (n && tree) n.textContent = `Отмечено видов работ: ${tree.selected().length}`; };

  function previewHtml() {
    const p = st.preview, t = p.totals;
    const risky = p.blocks.flatMap((b) => b.soft.map((s) => `${b.label}: ${s.name}`));
    const hard = p.blocks.flatMap((b) => b.hard.map((s) => `${b.label}: ${s.name}`));
    return `<div class="v2-callout" role="note"><strong>Что изменится</strong>
      <ul class="mfr-list"><li>Добавится работ: <b>${t.add}</b>${t.reactivate ? `, вернётся из снятых: <b>${t.reactivate}</b>` : ""}</li>
      <li>Снимется «мягко» (есть сроки или факт — строка и история сохраняются): <b>${t.soft}</b></li>
      <li>Будет удалено (пустая работа без сроков и факта): <b>${t.hard}</b></li></ul>
      ${risky.length ? `<details class="mfr-fold" open><summary>Мягко снимаются</summary><ul class="mfr-list">${risky.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join("")}${risky.length > 40 ? `<li class="v2-muted">… и ещё ${risky.length - 40}</li>` : ""}</ul></details>` : ""}
      ${hard.length ? `<details class="mfr-fold"><summary>Удаляются</summary><ul class="mfr-list">${hard.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join("")}${hard.length > 40 ? `<li class="v2-muted">… и ещё ${hard.length - 40}</li>` : ""}</ul></details>` : ""}
      ${p.ignored.length ? `<p class="mfr-status bad">Не входят в перечень работ блока и будут проигнорированы: ${p.ignored.length}</p>` : ""}
      ${group ? `<p class="v2-muted">Блоков: ${p.blocks.length}. Все блоки сохраняются одной операцией: при отказе не изменится ни один.</p>` : ""}</div>`;
  }

  function bind() {
    m.body.querySelector("#ss-all")?.addEventListener("click", () => { tree.selectAll(true); const b = m.body.querySelector("#ss-preview-btn"); if (b) b.disabled = !changed(); count(); });
    m.body.querySelector("#ss-none")?.addEventListener("click", () => { tree.selectAll(false); const b = m.body.querySelector("#ss-preview-btn"); if (b) b.disabled = !changed(); count(); });
    m.body.querySelector("#ss-preview-btn")?.addEventListener("click", doPreview);
    m.body.querySelector("#ss-back")?.addEventListener("click", () => { st.preview = null; st.status = ""; paint(); });
    m.body.querySelector("#ss-apply")?.addEventListener("click", doApply);
    m.body.querySelector("#ss-reload")?.addEventListener("click", load);
  }

  async function doPreview() {
    if (busy || !changed()) return;
    busy = true; setStatus("Считаем последствия…");
    try {
      st.preview = await api.readPost(`/objects/${objectId}/blocks/work-types-settings/preview`, { block_ids: ids, work_type_ids: tree.selected() });
      st.status = ""; st.kind = "";
      st.picked = new Set(tree.selected());
    } catch (e) { busy = false; setStatus(`Не удалось получить предпросмотр: ${errText(e)}`, "bad"); return; }
    busy = false; paint();
  }

  async function doApply() {
    if (busy || !st.preview) return;
    const p = st.preview;
    if (p.totals.hard > 0) {
      const ok = await showConfirmDialog(`Будет удалено пустых работ: ${p.totals.hard}. Это необратимо (у них нет ни сроков, ни факта). Продолжить?`, { confirmLabel: "Применить", danger: true });
      if (!ok) return;
    }
    busy = true; paint(); setStatus("Сохранение…");
    const work_type_ids = [...st.picked];
    const res = await settle(() => (group
      ? api.put(`/objects/${objectId}/blocks/work-types-settings`, { block_ids: ids, work_type_ids, expected: p.expected })
      : api.put(`/objects/${objectId}/blocks/${ids[0]}/work-types-settings`, { work_type_ids, expected: p.expected[String(ids[0])] })), async () => {
      // неизвестный исход: сверка — состав каждого блока должен стать выбранным (с учётом отфильтрованных сервером)
      const opts = new Set(st.data.options.map((o) => o.id));
      const want = new Set(work_type_ids.filter((x) => opts.has(x)));
      const cur = group ? await api.get(`/objects/${objectId}/blocks/work-types-settings?block_ids=${ids.join(",")}`) : await api.get(`/objects/${objectId}/blocks/${ids[0]}/work-types-settings`);
      const sel = new Set(group ? cur.selected_all : cur.selected);
      const some = group ? cur.selected_some.length : 0;
      const same = sel.size === want.size && [...want].every((x) => sel.has(x)) && some === 0;
      return same ? "applied" : (JSON.stringify([...sel].sort()) === JSON.stringify([...st.initial].sort()) ? "not_applied" : "unknown");
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      try { await load(); setStatus(res.outcome === "confirmed" ? OUTCOME_TEXT.confirmed : "Состав работ сохранён и подтверждён чтением.", "ok"); }
      catch (e) { setStatus("Сохранено, но перечитать не удалось.", "bad"); }
      onSaved?.();
      return;
    }
    if (res.outcome === "conflict") { st.conflict = true; st.preview = null; paint(); setStatus(`${conflictText(res.error, "состав")} Нажмите «Обновить состав с сервера» и повторите.`, "bad"); return; }
    paint();
    setStatus(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
  }

  const close = m.close;
  m.close = () => { dead = true; close(); onClosed?.(); };
  load();
  return m;
}

// ---------------------------------------------------------------- групповая правка сроков (с предпросмотром)
// items — выбранные ЗР [{id, …}]; правило то же, что у V1: сдвиг плана/прогноза на N дней или «прогноз = план» (только у не начатых).
export function openBulkDatesDialog({ api, objectId, items, canWrite, onDone, onClosed }) {
  const ids = items.map((i) => i.id);
  let busy = false, dead = false;
  // Таблица работ «по строкам» (V1: block-works-dates-table, правка дат каждой строки): текущие сроки и признак каждой ЗР; правка строки —
  // карточкой ЗР (openZrDialog: план и новая версия прогноза с отпечатком работы, как в панели блока), после неё список перечитывается.
  let list = items.slice();
  const blockIds = [...new Set(items.map((i) => i.block_id).filter(Boolean))];
  async function reloadList() {
    try { list = (await api.get(`/objects/${objectId}/block-works?block_ids=${blockIds.join(",")}`)).items || []; } catch (e) { /* остаётся прежний список */ }
    if (!dead && !st.preview) paint();
  }
  const rowsHtml = () => !list.length ? `<p class="v2-muted">У отобранных блоков нет ни одной ЗР.</p>`
    : `<h4 class="mfr-rows-h">Сроки по строкам</h4><div class="v2-read-table mfr-bulk-tbl"><table class="v2-read-tbl"><thead><tr><th>Секция · этаж</th><th>Операция</th><th>План</th><th>Прогноз</th><th>Признак</th><th></th></tr></thead><tbody>${list.map((w) => `<tr>
      <td>${esc(w.section_code ?? "")} · ${esc(w.level_floor ?? "")}</td><td>${esc(w["название"] || w["путь"] || "")}</td>
      <td class="mfr-nowrap">${esc(shortDate(w.plan_start))}–${esc(shortDate(w.plan_end))}</td><td class="mfr-nowrap">${esc(shortDate(w.forecast_start))}–${esc(shortDate(w.forecast_end))}</td>
      <td>${esc(w.deadline_label || "")}</td><td><button type="button" class="v2-btn" data-bd-row="${w.id}" ${busy ? "disabled" : ""}>${canWrite ? "Изменить…" : "Открыть…"}</button></td></tr>`).join("")}</tbody></table></div>`;
  const st = { op: "shift", field: "plan", days: "", preview: null, status: "", kind: "" };
  const m = openModal({ title: `Групповая правка сроков · работ: ${ids.length}`, wide: true, onRequestClose: async () => !busy });
  const setStatus = (t, kind = "") => { st.status = t; st.kind = kind; const n = m.body.querySelector("#bd-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };
  const body = () => ({ block_work_ids: ids, op: st.op, ...(st.op === "shift" ? { field: st.field, days: Number(st.days) } : {}) });
  const validInput = () => st.op !== "shift" || (Number.isInteger(Number(st.days)) && Number(st.days) !== 0 && st.days !== "" && Math.abs(Number(st.days)) <= 3650);

  function paint() {
    if (dead) return;
    const p = st.preview;
    m.body.innerHTML = `<div class="mfr-bulk">
      <div class="v2-wire-row">
        <label class="v2-wire-field"><span>Операция</span><select id="bd-op" ${busy || p ? "disabled" : ""}><option value="shift" ${st.op === "shift" ? "selected" : ""}>Сдвинуть сроки на N дней</option><option value="forecast_equals_plan" ${st.op === "forecast_equals_plan" ? "selected" : ""}>Прогноз = план (только у не начатых)</option></select></label>
        ${st.op === "shift" ? `<label class="v2-wire-field"><span>Что сдвигать</span><select id="bd-field" ${busy || p ? "disabled" : ""}><option value="plan" ${st.field === "plan" ? "selected" : ""}>Базовый срок (план)</option><option value="forecast" ${st.field === "forecast" ? "selected" : ""}>Прогноз (новая версия)</option></select></label>
        <label class="v2-wire-field"><span>Дней (− назад, + вперёд)</span><input type="number" id="bd-days" step="1" value="${esc(st.days)}" ${busy || p ? "disabled" : ""}></label>` : ""}
        ${!p ? `<button type="button" class="v2-btn v2-primary" id="bd-preview" ${busy || !validInput() ? "disabled" : ""}>Предпросмотр</button>` : ""}</div>
      <div id="bd-pv">${p ? previewHtml(p) : `<p class="v2-muted">Выбрано работ: ${ids.length}. Групповая правка — сначала предпросмотр: изменения записываются только после него. Правка отдельной работы — кнопкой в её строке ниже.</p>`}</div>
      <p id="bd-status" class="mfr-status ${esc(st.kind)}" role="status" aria-live="polite">${esc(st.status)}</p>
      ${p ? `<div class="v2-bar mfr-actions"><button type="button" class="v2-btn v2-primary" id="bd-apply" ${busy || !p.will_change || !canWrite || p.items.some((i) => i.blocked) ? "disabled" : ""}>Применить: ${p.will_change} из ${p.requested}</button><button type="button" class="v2-btn" id="bd-back" ${busy ? "disabled" : ""}>Назад</button></div>` : ""}${p ? "" : rowsHtml()}</div>`;
    m.body.querySelector("#bd-op")?.addEventListener("change", (e) => { st.op = e.target.value; paint(); });
    m.body.querySelector("#bd-field")?.addEventListener("change", (e) => { st.field = e.target.value; });
    m.body.querySelector("#bd-days")?.addEventListener("input", (e) => { st.days = e.target.value; const b = m.body.querySelector("#bd-preview"); if (b) b.disabled = !validInput(); });
    m.body.querySelector("#bd-preview")?.addEventListener("click", doPreview);
    m.body.querySelector("#bd-back")?.addEventListener("click", () => { st.preview = null; st.status = ""; paint(); });
    m.body.querySelector("#bd-apply")?.addEventListener("click", doApply);
    m.body.querySelectorAll("[data-bd-row]").forEach((btn) => btn.addEventListener("click", () => {
      if (busy) return;
      openZrDialog({ api, objectId, id: Number(btn.dataset.bdRow), canWrite, onSaved: () => { reloadList(); onDone?.(); } });
    }));
  }
  function previewHtml(p) {
    const rows = p.items.slice(0, 300).map((i) => {
      const key = st.op === "shift" ? st.field : "forecast";
      const bef = i.reason === "not_found" ? "не найдена" : `${shortDate(i[key + "_start"])}–${shortDate(i[key + "_end"])}`;
      const aft = i.will_change ? `${shortDate(i.after[key + "_start"])}–${shortDate(i.after[key + "_end"])}` : "—";
      return `<tr class="${i.will_change ? "" : "mfr-dim"}"><td>${esc(i.section_code ?? "")} · ${esc(i.level_floor ?? "")}</td><td>${esc(i.name || "")}</td><td>${esc(bef)}</td><td>${esc(aft)}</td><td>${i.will_change ? "изменится" : esc(i.reason || "")}</td></tr>`;
    }).join("");
    const blocked = p.items.filter((i) => i.blocked).length;
    return `${blocked ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Применить нельзя.</strong> У ${blocked} работ сдвиг выводит дату за допустимые границы — исключите их из набора (операция применяется целиком или не применяется вовсе).</div>` : ""}${p.note ? `<div class="v2-callout" role="note"><strong>${esc(p.note)}.</strong> Новая версия прогноза добавляется, старая остаётся в истории.</div>` : ""}
      <p><b>Изменится: ${p.will_change} из ${p.requested}</b>${p.requested - p.will_change ? ` · без изменений: ${p.requested - p.will_change}` : ""}</p>
      <div class="v2-read-table mfr-bulk-tbl"><table class="v2-read-tbl"><thead><tr><th>Секция · этаж</th><th>Работа</th><th>Сейчас</th><th>Станет</th><th>Итог</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${p.items.length > 300 ? `<p class="v2-muted">Показаны первые 300 из ${p.items.length}; применяется ко всем.</p>` : ""}`;
  }
  async function doPreview() {
    if (busy || !validInput()) return;
    busy = true; setStatus("Считаем последствия…");
    try { st.preview = await api.readPost(`/objects/${objectId}/block-works/bulk-preview`, body()); st.status = ""; st.kind = ""; }
    catch (e) { busy = false; setStatus(`Не удалось получить предпросмотр: ${errText(e)}`, "bad"); return; }
    busy = false; paint();
  }
  async function doApply() {
    if (busy || !st.preview || !st.preview.will_change) return;
    const p = st.preview;
    const forecast = st.op === "forecast_equals_plan" || st.field === "forecast";
    if (forecast) {
      const ok = await showConfirmDialog(`Будет записана новая версия прогноза у ${p.will_change} работ.\n\nВерсии прогноза копятся и не отменяются: эти версии нельзя будет удалить.`, { confirmLabel: "Применить", multiline: true });
      if (!ok) return;
    }
    busy = true; paint(); setStatus("Применяется одной операцией…");
    const res = await settle(() => api.put(`/objects/${objectId}/block-works/bulk`, { ...body(), expected: p.expected }), async () => {
      // неизвестный исход: сверка — у всех «изменится» работ значения стали расчётными
      const cur = await api.get(`/objects/${objectId}/block-works?block_ids=${[...new Set(p.items.map((i) => i.block_id).filter(Boolean))].join(",")}`);
      const byId = new Map(cur.items.map((w) => [w.id, w]));
      const willIds = p.items.filter((i) => i.will_change);
      const done = willIds.filter((i) => Object.entries(i.after).every(([k, v]) => (byId.get(i.id)?.[k] ?? null) === v)).length;
      if (done === willIds.length) return "applied";
      return done === 0 ? "not_applied" : "unknown";
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      st.preview = null; paint();
      setStatus(res.outcome === "confirmed" ? OUTCOME_TEXT.confirmed : `Применено: изменено ${res.data?.changed ?? "?"} из ${res.data?.requested ?? ids.length} (ответ сервера).`, "ok");
      onDone?.();
      reloadList();
      return;
    }
    if (res.outcome === "conflict") { st.preview = null; paint(); setStatus(`${conflictText(res.error, "список")} Ничего не изменено — сделайте предпросмотр заново.`, "bad"); onDone?.(); return; }
    paint();
    setStatus(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
  }
  const close = m.close;
  m.close = () => { dead = true; close(); onClosed?.(); };
  paint();
  return m;
}
