// «Массовая правка через Excel» в V2: выгрузка → правка в Excel → сверка → применение отмеченного. Три режима V1 — «Реквизиты», «История статусов»,
// «Контрактация» — и четвёртый, отдельный и красный, как в V1: «⚠ Перенос базы» — замена базы целиком снимком другого сервера (2026-09-28).
// Он встраивает тот же модуль, что экран «Перенос базы целиком» (db-transfer.js), и виден только при праве на перенос базы.
//
// Семантика — как в V1 (те же эндпоинты `POST /elements/bulk-edit/{export,analyze,apply}`):
//  * выгрузка — чтение (право «Массовая правка: чтение»), сверка и применение — изменение;
//  * сверка НИЧЕГО не пишет: она возвращает расхождения, применяется ровно то, что человек отметил флажками (файл заново не читается);
//  * применение — одна транзакция под блокировкой записи, копия базы перед ней; правка, не прошедшая проверку при применении, попадает в
//    «пропущено» с причиной (явный частичный режим V1), остальные применяются; откат всего — только при отказе стража остатка контракта.
// Сверх V1 (V2): перед применением сверка перечитывается из того же файла — если с момента показа что-то изменилось (другой пользователь,
// другой запрос), применение не выполняется («устаревшая сверка»), человеку показывается новая таблица.
import { showConfirmDialog } from "./dialogs.js";
import { isRealDate } from "./card-edit.js";
import { filterSnapshotFor, describeFilterSnapshot } from "./scheme-filter-snapshot.js";
import { mountDbTransfer } from "./db-transfer.js";
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, mountTemplates, makeStatus, unknownOutcomeHtml, verifyOutcome, saveBlob,
  factsHtml, valueText, applyIndeterminate,
} from "./exchange-common.js";

const MODES = {
  fields: {
    label: "Реквизиты", tpl: "bulk_edit", journal: "element_bulk_edit", what: "массовая правка реквизитов",
    intro: "Выгрузите снимок реквизитов элементов, поправьте в Excel и загрузите обратно. Система покажет расхождения — применится только то, что вы отметите флажками. История статусов в этот файл не входит — для неё переключитесь в режим «История статусов».",
    consequence: "Изменятся реквизиты изделий (тип, подтип, марка, отметка, этаж, адрес, даты, комментарий, контракт). Назначение контракта запланированному изделию добавит ему статус «Контрактация».",
  },
  statuses: {
    label: "История статусов", tpl: "bulk_edit_statuses", journal: "status_bulk_edit", what: "массовая правка истории статусов",
    intro: "Лист «История статусов» — строка на каждую запись истории: статус, момент установки, кто изменил, комментарий. Правятся четыре колонки: «Статус», «Дата и время установки», «Кто изменил», «Комментарий». Строка с пустым «№ записи» и заполненным UID элемента — новая запись. Удалить запись файлом нельзя (это делается в карточке элемента), пустая ячейка означает «не трогать». Порядок статусов проверяется: если дата более позднего статуса раньше предыдущего, строка отклоняется.",
    consequence: "Изменятся записи истории статусов; текущие статусы и фактические даты изделий пересчитаются по истории.",
  },
  contracting: {
    label: "Контрактация", tpl: "bulk_edit_contracting", journal: "contracting_bulk_edit", what: "массовая правка контрактации",
    intro: "Лист «Контрактация» — реестр: строка на каждую позицию контракта, рядом реквизиты её владельцев — контракта, спецификации, договора и контрагента. Правится всё, кроме наименования контракта. Строка с пустым «№ позиции» и заполненным «№ контракта» — новая позиция этого контракта; новые контракты, спецификации, договоры и контрагенты этим файлом не заводятся — для них есть «Импорт контрактации из XLS». Удалить позицию файлом нельзя, пустая ячейка означает «не трогать».",
    consequence: "Изменятся позиции контрактов и реквизиты их спецификаций, договоров и контрагентов.",
  },
};

export function mountBulkEdit(el, ctx) {
  const { screen, groupTitle, api, objectId, objects, rights } = ctx;
  const canWrite = !!(rights?.system_admin || rights?.features?.bulk_edit === "write");
  const canTransfer = !!(rights?.system_admin || ["read", "write"].includes(rights?.features?.db_transfer));
  let transfer = null; // смонтированный модуль переноса базы (режим «Перенос базы»)
  let dead = false, busy = false;
  let mode = "fields";
  let analysis = null, file = null, checked = new Set(), contractingDate = "";
  const objectById = new Map((objects || []).map((o) => [o.id, o]));
  const obj = objectById.get(objectId) || null;

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: null,
    body: `<div class="v2-bk-modes"><div class="v2-seg" role="group" aria-label="Режим правки" id="bk-modes">${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="${k === mode}">${esc(m.label)}</button>`).join("")}</div>${canTransfer ? `<button type="button" class="v2-bk-transfer-mode" id="bk-transfer-mode" aria-pressed="false" data-tooltip="Полная замена базы снимком другого сервера">⚠ Перенос базы</button>` : ""}</div>
      <div id="bk-transfer" hidden></div>
      <div id="bk-excel">
      <div class="v2-steps" id="bk-steps">
        <section class="v2-step" id="bk-step-1">
          <h4 class="v2-step-title"><span class="v2-step-num">1</span>Выгрузить снимок</h4>
          <div class="v2-step-controls"><button type="button" class="v2-btn v2-btn-soft" id="bk-export">Выгрузить в Excel</button></div>
          <div id="bk-scope"></div>
        </section>
        ${canWrite ? `<section class="v2-step v2-step-file" id="bk-step-2">
          <h4 class="v2-step-title"><span class="v2-step-num">2</span>Выбрать правленый файл</h4>
          <div class="v2-step-controls"><input type="file" id="bk-file" accept=".xlsx" aria-label="Правленый файл .xlsx"></div>
        </section>
        <section class="v2-step" id="bk-step-3">
          <h4 class="v2-step-title"><span class="v2-step-num">3</span>Сверить с базой</h4>
          <div class="v2-step-controls"><button type="button" class="v2-btn v2-btn-soft" id="bk-analyze" disabled>Сверить с базой</button></div>
          <div class="v2-step-hint" id="bk-analyze-hint">Сначала выберите файл. Ничего не изменит — только покажет расхождения.</div>
        </section>` : `<section class="v2-step" id="bk-step-ro" role="note">
          <h4 class="v2-step-title">Только выгрузка</h4>
          <div class="v2-step-hint">Загрузка правленого файла требует уровня «Изменение» по разделу «Массовая правка через Excel». Обратитесь к администратору сервиса.</div>
        </section>`}
      </div>
      <div id="bk-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="bk-intro-box"><p class="v2-muted" id="bk-intro"></p><div id="bk-tpl" class="v2-ex-tplbox"></div></div>
      <div id="bk-rejected"></div>
      <div id="bk-chips" class="v2-ex-chips"></div>
      <div id="bk-table"></div>
      <div id="bk-result"></div>
      ${canWrite ? `<div class="v2-bar v2-ex-stickybar v2-bk-foot" id="bk-applybar">
        <div class="v2-bk-foot-info"><span class="v2-muted" id="bk-summary"></span>
          <label class="v2-wire-field" id="bk-datebox" hidden><span>Дата статуса «Контрактация» для запланированных элементов</span><input type="date" id="bk-date"></label></div>
        <button type="button" class="v2-btn v2-primary" id="bk-apply" disabled>Применить отмеченное</button>
      </div>` : ""}
      </div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#bk-status"));

  // ---- режим и вспомогательные тексты
  let exported = false;
  // Пошаговость как в V1: шаг, до которого ещё не дошли, приглушён и его кнопка недоступна; текущий шаг обведён.
  // 1 — выгрузка (всегда доступна), 2 — выбор файла, 3 — сверка (после выбора файла); после сверки ждёт применение внизу.
  function updateSteps() {
    const hasFile = !!$("#bk-file")?.files?.length;
    const hasAnalysis = !!analysis;
    const current = hasAnalysis ? 0 : hasFile ? 3 : exported ? 2 : 1;
    [1, 2, 3].forEach((n) => {
      const card = $(`#bk-step-${n}`); if (!card) return;
      card.classList.toggle("v2-step-current", current === n);
      card.classList.toggle("v2-step-pending", n === 3 && !hasFile && !hasAnalysis);
    });
    const btn = $("#bk-analyze");
    if (btn) btn.disabled = busy || !hasFile;
    const hint = $("#bk-analyze-hint");
    if (hint) hint.textContent = hasFile ? "Ничего не изменит — только покажет расхождения." : "Сначала выберите файл. Ничего не изменит — только покажет расхождения.";
  }
  function renderMode() {
    $("#bk-intro").textContent = MODES[mode].intro;
    el.querySelectorAll("#bk-modes [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    const scope = $("#bk-scope");
    if (mode === "contracting") {
      scope.innerHTML = `<p class="v2-step-hint">Все позиции всех контрактов — одним файлом.</p>`;
    } else {
      const filter = obj ? filterSnapshotFor(obj.id) : null;
      const filterNote = obj ? describeFilterSnapshot(obj.id).text : "Сначала выберите объект в шапке.";
      scope.innerHTML = `<div class="v2-step-scope" role="radiogroup" aria-label="Что выгрузить">
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="all" checked> Все элементы всех объектов</label>
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="object" ${obj ? "" : "disabled"}> Только выбранный объект${obj ? `: ${esc(obj.name)}` : " (выберите объект в шапке)"}</label>
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="filter" ${filter ? "" : "disabled"}> По последнему отбору схемы</label>
        <div class="v2-step-hint">${esc(filterNote)} Это сохранённый снимок отбора, а не живая синхронизация.</div></div>`;
    }
    mountTemplates($("#bk-tpl"), api, [MODES[mode].tpl], () => dead);
    updateSteps();
  }
  function resetAnalysis() {
    analysis = null; file = null; checked = new Set(); contractingDate = "";
    $("#bk-rejected").innerHTML = ""; $("#bk-chips").innerHTML = ""; $("#bk-table").innerHTML = ""; $("#bk-result").innerHTML = "";
    $("#bk-intro-box").hidden = false;
    const f = $("#bk-file"); if (f) f.value = "";
    updateFoot(); updateSteps();
  }
  // Нижняя панель: сводка отмеченного, дата статуса «Контрактация» (только когда она нужна) и «Применить отмеченное».
  function updateFoot() {
    const ch = analysis?.changes || [];
    const sum = $("#bk-summary"); if (sum) sum.textContent = ch.length ? `Отмечено ${checked.size} из ${ch.length} правок` : "";
    const box = $("#bk-datebox"); if (box) box.hidden = !ch.some((c, i) => checked.has(i) && c.needs_contracting);
    const ap = $("#bk-apply"); if (ap) ap.disabled = busy || checked.size === 0;
  }
  const dirty = () => !!analysis && analysis.changes.length > 0;

  // Режим «Перенос базы»: скрывает шаги Excel и монтирует модуль переноса; уход из режима убирает принятый, но не
  // применённый снимок из очереди (guardLeave модуля), как при уходе с отдельного экрана.
  async function leaveTransfer() {
    if (!transfer) return true;
    if (!(await transfer.guardLeave())) return false;
    transfer.destroy(); transfer = null;
    $("#bk-transfer").innerHTML = ""; $("#bk-transfer").hidden = true; $("#bk-excel").hidden = false;
    $("#bk-transfer-mode")?.setAttribute("aria-pressed", "false");
    return true;
  }
  $("#bk-transfer-mode")?.addEventListener("click", async () => {
    if (busy || transfer) return;
    if (dirty() && !(await showConfirmDialog("Сверка не применена — при смене режима её результат будет потерян. Сменить режим?", { confirmLabel: "Сменить режим", cancelLabel: "Остаться" }))) return;
    resetAnalysis(); status.set("");
    $("#bk-excel").hidden = true; $("#bk-transfer").hidden = false;
    el.querySelectorAll("#bk-modes [data-mode]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    $("#bk-transfer-mode").setAttribute("aria-pressed", "true");
    transfer = mountDbTransfer($("#bk-transfer"), { ...ctx, embedded: true });
  });

  el.querySelector("#bk-modes").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || busy) return;
    if (transfer) { if (!(await leaveTransfer())) return; if (b.dataset.mode === mode) { renderMode(); return; } }
    else if (b.dataset.mode === mode) return;
    if (dirty() && !(await showConfirmDialog("Сверка не применена — при смене режима её результат будет потерян. Сменить режим?", { confirmLabel: "Сменить режим", cancelLabel: "Остаться" }))) return;
    mode = b.dataset.mode; resetAnalysis(); status.set(""); renderMode();
  });

  // ---- выгрузка снимка (чтение)
  let exporting = false;
  $("#bk-export").addEventListener("click", async () => {
    if (exporting || busy) return;
    exporting = true; $("#bk-export").disabled = true; status.set("Готовим файл…", "busy");
    try {
      const body = { mode };
      const scope = el.querySelector('input[name="bk-scope"]:checked')?.value;
      if (mode !== "contracting" && scope === "object" && obj) body.object_id = obj.id;
      if (mode !== "contracting" && scope === "filter") {
        const snapshot = obj && filterSnapshotFor(obj.id);
        if (!snapshot) throw new Error("Отбор схемы больше не доступен для выбранного объекта. Откройте рабочее место и задайте отбор заново.");
        if (!snapshot.elementIds.length) throw new Error("В отборе схемы нет элементов для выгрузки.");
        body.element_ids = snapshot.elementIds;
      }
      const { blob, filename } = await api.fetchFile("/elements/bulk-edit/export", { method: "POST", body });
      if (dead) return;
      saveBlob(blob, filename || "zhbi_elements.xlsx");
      exported = true; updateSteps();
      status.set(`Файл «${filename || "zhbi_elements.xlsx"}» выгружен (${fmtSize(blob.size)}). Поправьте его в Excel и загрузите обратно.`, "ok");
    } catch (err) { if (!dead) status.set(`Не удалось выгрузить: ${errText(err)}`, "bad"); }
    finally { exporting = false; if (!dead) $("#bk-export").disabled = false; }
  });

  // ---- сверка
  const rowKey = (x) => (x.row_id !== undefined && x.row_id !== null ? x.row_id : `e${x.element_id}`);
  function rowLabel(c) {
    const v = (analysis.elements.find((r) => rowKey(r) === rowKey(c)) || {}).values || {};
    const item = `${c.element_type || v.element_type || ""} ${c.mark || v.mark || ""}`.trim() || c.uid || "";
    if (mode === "contracting") return `${esc(v.contract_name || `контракт №${c.contract_id ?? ""}`)}<br><span class="v2-muted">${esc(item)}</span>`;
    if (mode === "statuses") return `${esc(item)}<br><span class="v2-muted">${esc(v.status || "")} · ${esc(valueText(v.changed_at))}</span>`;
    return `${esc(item)}<br><span class="v2-muted">${esc(v.object_name || "")}${c.uid ? ` · ${esc(String(c.uid).slice(0, 8))}` : ""}</span>`;
  }
  // Таблица подтверждения — как в V1: те же колонки, что в Excel, а у каждого правленого поля сразу за исходным значением —
  // парная колонка «→ станет» с флажком; флажок есть и у строки, и у колонки, и общий.
  const RENDER_LIMIT = 800;
  const rowId = (x) => String(rowKey(x));
  function renderAnalysis() {
    const ch = analysis?.changes || [];
    const box = $("#bk-table");
    $("#bk-intro-box").hidden = ch.length > 0;
    if (!ch.length) { box.innerHTML = ""; $("#bk-chips").innerHTML = ""; updateFoot(); updateSteps(); return; }
    const byRow = new Map(), changedCols = new Set();
    ch.forEach((c, i) => { changedCols.add(c.column); const k = rowId(c); if (!byRow.has(k)) byRow.set(k, new Map()); byRow.get(k).set(c.column, i); });
    const columns = [];
    (analysis.columns || []).forEach((col) => { columns.push({ ...col, kind: "value" }); if (changedCols.has(col.key)) columns.push({ ...col, kind: "new" }); });
    const inColumn = (key) => ch.map((c, i) => (c.column === key ? i : -1)).filter((i) => i >= 0);
    const allOn = checked.size === ch.length, someOn = !allOn && checked.size > 0;
    const head = columns.map((col) => {
      if (col.kind !== "new") return `<th>${esc(col.label)}</th>`;
      const idx = inColumn(col.key), on = idx.length > 0 && idx.every((i) => checked.has(i)), some = !on && idx.some((i) => checked.has(i));
      return `<th class="v2-bk-new"><label><input type="checkbox" data-col="${esc(col.key)}" aria-label="Отметить все правки колонки «${esc(col.label)}»" ${on ? "checked" : ""} ${some ? 'data-indet="1"' : ""}> → станет (${idx.length})</label></th>`;
    }).join("");
    const rows = (analysis.elements || []).filter((r) => byRow.has(rowId(r)));
    const shown = rows.slice(0, RENDER_LIMIT);
    const body = shown.map((row) => {
      const marks = byRow.get(rowId(row));
      const rowOn = [...marks.values()].every((i) => checked.has(i));
      const cells = columns.map((col) => {
        const idx = marks.get(col.key);
        if (col.kind === "new") {
          if (idx === undefined) return `<td class="v2-bk-new"></td>`;
          const c = ch[idx];
          return `<td class="v2-bk-new v2-bk-changed"><label><input type="checkbox" data-i="${idx}" ${checked.has(idx) ? "checked" : ""}> ${esc(valueText(c.now))}</label>${c.needs_contracting ? `<div class="v2-ex-warn">+ статус «Контрактация»</div>` : ""}${c.warning ? `<div class="v2-ex-warn">⚠ ${esc(c.warning)}</div>` : ""}</td>`;
        }
        return `<td class="${idx !== undefined ? "v2-bk-was" : ""}">${esc(valueText(row.values?.[col.key]))}</td>`;
      }).join("");
      return `<tr data-row="${esc(rowId(row))}"><td><input type="checkbox" data-row-all="${esc(rowId(row))}" aria-label="Отметить все правки этой строки" ${rowOn ? "checked" : ""}></td>${cells}</tr>`;
    }).join("");
    const keepTop = box.firstElementChild?.scrollTop || 0, keepLeft = box.firstElementChild?.scrollLeft || 0;
    box.innerHTML = `<div class="v2-ex-changes v2-bk-wrap"><table class="v2-bk-tbl"><thead><tr><th><input type="checkbox" data-all aria-label="Отметить все правки" ${allOn ? "checked" : ""} ${someOn ? 'data-indet="1"' : ""}></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${rows.length > shown.length ? `<p class="v2-muted">В таблице показаны первые ${shown.length} строк из ${rows.length} — применятся все отмеченные, включая непоказанные.</p>` : ""}`;
    applyIndeterminate(box);
    if (box.firstElementChild) { box.firstElementChild.scrollTop = keepTop; box.firstElementChild.scrollLeft = keepLeft; }
    // Переключатели по полю: одним движением отметить/снять все правки поля (сотни правок по одной снимать нельзя)
    renderChips();
    updateFoot(); updateSteps();
  }
  function renderChips() {
    const ch = analysis?.changes || [];
    const counts = new Map();
    ch.forEach((c, i) => { const e = counts.get(c.field_label) || { n: 0, on: 0 }; e.n++; if (checked.has(i)) e.on++; counts.set(c.field_label, e); });
    $("#bk-chips").innerHTML = [...counts].map(([label, e]) => `<label class="v2-ex-chip"><input type="checkbox" data-field="${esc(label)}" ${e.on === e.n ? "checked" : ""}> ${esc(label)} (${e.n})</label>`).join("");
  }
  // Флажки заголовка («все» и «→ станет» по колонке) пересчитываются от текущих отметок, не перерисовывая таблицу.
  function syncHeaderChecks() {
    const ch = analysis?.changes || [];
    const set = (cb, idx) => { const on = idx.length > 0 && idx.every((i) => checked.has(i)); cb.checked = on; cb.indeterminate = !on && idx.some((i) => checked.has(i)); };
    const all = $("#bk-table [data-all]"); if (all) set(all, ch.map((_, i) => i));
    $("#bk-table").querySelectorAll("[data-col]").forEach((cb) => set(cb, ch.map((c, i) => (c.column === cb.dataset.col ? i : -1)).filter((i) => i >= 0)));
  }
  // Одна отметка в ячейке не перерисовывает таблицу (до 800 строк): обновляются сводка, переключатели по полю и флажок строки.
  $("#bk-table").addEventListener("change", (e) => {
    const t = e.target, ch = analysis?.changes || [];
    if (!analysis) return;
    if (t.matches("[data-i]")) {
      const i = Number(t.dataset.i); if (t.checked) checked.add(i); else checked.delete(i);
      const tr = t.closest("tr"), rowCb = tr?.querySelector("[data-row-all]");
      if (rowCb) rowCb.checked = [...tr.querySelectorAll("[data-i]")].every((x) => x.checked);
      syncHeaderChecks(); renderChips(); updateFoot();
    } else if (t.matches("[data-all]")) {
      checked = t.checked ? new Set(ch.map((_, i) => i)) : new Set(); renderAnalysis();
    } else if (t.matches("[data-col]")) {
      ch.forEach((c, i) => { if (c.column === t.dataset.col) { if (t.checked) checked.add(i); else checked.delete(i); } }); renderAnalysis();
    } else if (t.matches("[data-row-all]")) {
      const key = t.dataset.rowAll;
      ch.forEach((c, i) => { if (rowId(c) === key) { if (t.checked) checked.add(i); else checked.delete(i); } }); renderAnalysis();
    }
  });
  $("#bk-chips").addEventListener("change", (e) => {
    const label = e.target.dataset?.field; if (label === undefined || !analysis) return;
    analysis.changes.forEach((c, i) => { if (c.field_label === label) { if (e.target.checked) checked.add(i); else checked.delete(i); } });
    renderAnalysis();
  });
  $("#bk-date")?.addEventListener("input", (e) => { contractingDate = e.target.value; });
  $("#bk-file")?.addEventListener("change", () => { updateSteps(); });

  const rejectedHtml = (rej) => (rej?.length ? `<div class="v2-callout v2-callout-bad"><strong>Не может быть применено (${rej.length}):</strong><ul class="v2-ex-list">${rej.slice(0, 100).map((r) => `<li>стр. ${esc(r.line)}: ${esc(r.reason)}${r.element_type || r.mark ? ` — ${esc(`${r.element_type || ""} ${r.mark || ""}`.trim())}` : ""}</li>`).join("")}${rej.length > 100 ? `<li class="v2-muted">…и ещё ${rej.length - 100}</li>` : ""}</ul></div>` : "");

  async function analyzeFile(f, m) {
    const fd = new FormData(); fd.append("file", f, f.name); fd.append("mode", m);
    return api.upload("/elements/bulk-edit/analyze", fd);
  }
  function showAnalysis(data, f) {
    analysis = data; file = f; checked = new Set(data.changes.map((_, i) => i));
    const what = mode === "contracting" ? "строках файла" : "элементов";
    status.set(`Прочитано строк: ${data.rows_read}. Расхождений: ${data.changes.length} ${mode === "contracting" ? `в ${data.elements_touched} ${what}` : `у ${data.elements_touched} ${what}`}.`, "ok");
    $("#bk-rejected").innerHTML = rejectedHtml(data.rejected);
    renderAnalysis();
  }

  $("#bk-analyze")?.addEventListener("click", async () => {
    if (busy) return;
    const f = $("#bk-file").files[0];
    const problem = checkFile(f, { ext: ["xlsx"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; updateSteps(); updateFoot(); status.set("Сверяем файл с базой…", "busy"); $("#bk-result").innerHTML = "";
    try {
      const data = await analyzeFile(f, mode);
      if (dead) return;
      showAnalysis(data, f);
    } catch (err) {
      if (dead) return;
      analysis = null; renderAnalysis(); $("#bk-rejected").innerHTML = "";
      status.set(`Сверка не удалась: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) { updateSteps(); updateFoot(); } }
  });

  // ---- применение
  const resultHtml = (r) => {
    let facts;
    if (r.lines_inserted !== undefined) facts = [["Позиций добавлено", r.lines_inserted], ["Позиций изменено", r.lines_updated], ["Записей контрактации обновлено", r.entities_updated]];
    else facts = [["Элементов обновлено", r.elements_updated], ["Записей истории добавлено", r.records_inserted ?? ""], ["Записей истории изменено", r.records_updated ?? ""]];
    const skipped = r.skipped || [];
    return factsHtml(facts) + (skipped.length ? `<div class="v2-callout v2-callout-bad"><strong>Пропущено при применении (${skipped.length}):</strong> остальные правки применены.<ul class="v2-ex-list">${skipped.slice(0, 50).map((s) => `<li>${esc(s.reason || JSON.stringify(s))}</li>`).join("")}${skipped.length > 50 ? `<li class="v2-muted">…и ещё ${skipped.length - 50}</li>` : ""}</ul></div>` : "");
  };

  $("#bk-apply")?.addEventListener("click", async () => {
    if (busy || !analysis) return;
    const idx = [...checked].sort((a, b) => a - b);
    if (!idx.length) return;
    const selected = idx.map((i) => analysis.changes[i]);
    const needs = selected.filter((c) => c.needs_contracting).length;
    if (needs && !contractingDate) { status.set("Укажите дату статуса «Контрактация» — часть отмеченных элементов сейчас «Запланирован», и назначение контракта добавит им статус.", "bad"); return; }
    if (needs && !isRealDate(contractingDate)) { status.set("Дата статуса «Контрактация» — не существующая дата.", "bad"); return; }
    busy = true; updateSteps(); updateFoot();
    let sentAt = null;
    try {
      const m = MODES[mode];
      const ok = await showConfirmDialog(`Применить ${selected.length} изменений (режим «${m.label}»)?\n\n${m.consequence}${needs ? `\nИз них ${needs} добавят изделию статус «Контрактация» на ${contractingDate}.` : ""}\n\nПеред применением сервер сохранит копию базы. Правки, не прошедшие проверку при применении, будут пропущены и перечислены; остальные применяются одной операцией.`,
        { confirmLabel: "Применить", multiline: true });
      if (!ok || dead) { if (!dead) status.set("Применение отменено — ничего не изменено.", ""); return; }
      status.set("Проверяем, что сверка не устарела…", "busy");
      let fresh;
      try { fresh = await analyzeFile(file, mode); } catch (err) { status.set(`Не удалось перепроверить сверку: ${errText(err)}. Ничего не применено.`, "bad"); return; }
      if (dead) return;
      const freshSet = new Set(fresh.changes.map((c) => JSON.stringify(c)));
      const stale = selected.filter((c) => !freshSet.has(JSON.stringify(c)));
      if (stale.length) {
        showAnalysis(fresh, file);
        status.set(`Сверка устарела: данные изменились после сверки (${stale.length} отмеченных правок больше не совпадают с базой). Ничего не применено — проверьте обновлённую таблицу и примените снова.`, "bad");
        return;
      }
      status.set("Применяем…", "busy");
      sentAt = Date.now();
      const body = { changes: selected, mode };
      if (mode === "fields" && contractingDate && needs) body.contracting_date = contractingDate;
      const res = await api.post("/elements/bulk-edit/apply", body);
      if (dead) return;
      const skippedN = (res.skipped || []).length;
      status.set(`Готово.${res.lines_inserted !== undefined ? ` Позиций добавлено: ${res.lines_inserted}, изменено: ${res.lines_updated}.` : ` Обновлено элементов: ${res.elements_updated}.`}${skippedN ? ` Пропущено: ${skippedN}.` : ""}`, "ok");
      $("#bk-result").innerHTML = resultHtml(res);
      analysis = null; file = null; checked = new Set();
      $("#bk-table").innerHTML = ""; $("#bk-chips").innerHTML = ""; $("#bk-rejected").innerHTML = ""; $("#bk-intro-box").hidden = false;
      const f = $("#bk-file"); if (f) f.value = "";
      exported = false;
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) status.set(errText(err), "bad");
      else if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml(MODES[mode].what), "bad");
        const box = $("#bk-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: MODES[mode].journal, entityId: null, sinceMs: sentAt || Date.now(), what: MODES[mode].what }));
      } else status.set(`Не удалось применить: ${errText(err)}. Отмеченное осталось на месте.`, "bad");
    } finally { busy = false; if (!dead) { updateSteps(); updateFoot(); } }
  });

  renderMode();
  return {
    hasUnsavedChanges: dirty,
    async guardLeave() {
      if (transfer) return transfer.guardLeave();
      return !dirty() || (await showConfirmDialog("Сверка массовой правки не применена — результат сверки будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" }));
    },
    destroy() { dead = true; transfer?.destroy(); },
  };
}
