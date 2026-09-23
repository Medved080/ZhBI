// «Массовая правка через Excel» в V2: выгрузка → правка в Excel → сверка → применение отмеченного. Три режима V1 — «Реквизиты», «История статусов»,
// «Контрактация» (четвёртый режим V1 «Перенос базы» — замена базы целиком — остаётся только в текущем интерфейсе).
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
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, mountTemplates, makeStatus, unknownOutcomeHtml, verifyOutcome, saveBlob,
  factsHtml, valueText, changesTableHtml, wireChangesTable, applyIndeterminate,
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
  let dead = false, busy = false;
  let mode = "fields";
  let analysis = null, file = null, checked = new Set(), contractingDate = "";
  const objectById = new Map((objects || []).map((o) => [o.id, o]));
  const obj = objectById.get(objectId) || null;

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: null,
    body: `<div class="v2-seg" role="group" aria-label="Режим правки" id="bk-modes">${Object.entries(MODES).map(([k, m]) => `<button type="button" data-mode="${k}" aria-pressed="${k === mode}">${esc(m.label)}</button>`).join("")}</div>
      <p class="v2-muted" id="bk-intro"></p>
      <div class="v2-callout" role="note">Перенос базы целиком (замена базы снимком другого сервера) — критическая операция, в новом интерфейсе не выполняется: она остаётся в текущем интерфейсе («Массовая правка через Excel → Перенос базы»).</div>
      <h3 class="v2-report-h">1. Выгрузить снимок</h3>
      <div id="bk-scope"></div>
      <div class="v2-bar"><button type="button" class="v2-btn" id="bk-export">Выгрузить в Excel</button></div>
      ${canWrite ? `<h3 class="v2-report-h">2. Выбрать правленый файл и сверить с базой</h3>
        <form id="bk-form" autocomplete="off" novalidate>
          <label class="v2-wire-field v2-field-wide"><span>Файл .xlsx</span><input type="file" id="bk-file" accept=".xlsx"></label>
          <div class="v2-bar"><button type="submit" class="v2-btn" id="bk-analyze">Сверить с базой</button><span class="v2-muted">Ничего не изменит — только покажет расхождения.</span></div>
        </form>` : `<div class="v2-callout v2-callout-bad" role="note"><strong>Только выгрузка.</strong> Загрузка правленого файла требует уровня «Изменение» по разделу «Массовая правка через Excel». Обратитесь к администратору сервиса.</div>`}
      <div id="bk-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="bk-rejected"></div>
      <div id="bk-chips" class="v2-ex-chips"></div>
      <div id="bk-table"></div>
      <div id="bk-summary" class="v2-muted"></div>
      <div class="v2-bar v2-ex-stickybar" id="bk-applybar" hidden>
        <label class="v2-wire-field" id="bk-datebox" hidden><span>Дата статуса «Контрактация» для запланированных элементов</span><input type="date" id="bk-date"></label>
        <button type="button" class="v2-btn v2-primary" id="bk-apply">Применить отмеченное</button>
      </div>
      <div id="bk-result"></div>
      <div id="bk-tpl" class="v2-ex-tplbox"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#bk-status"));

  // ---- режим и вспомогательные тексты
  function renderMode() {
    $("#bk-intro").textContent = MODES[mode].intro;
    el.querySelectorAll("#bk-modes [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    const scope = $("#bk-scope");
    if (mode === "contracting") {
      scope.innerHTML = `<p class="v2-muted">Все позиции всех контрактов — одним файлом.</p>`;
    } else {
      const filter = obj ? filterSnapshotFor(obj.id) : null;
      const filterNote = obj ? describeFilterSnapshot(obj.id).text : "Сначала выберите объект в шапке.";
      scope.innerHTML = `<fieldset class="v2-fieldset"><legend>Что выгрузить</legend>
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="all" checked> Все элементы всех объектов</label>
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="object" ${obj ? "" : "disabled"}> Только выбранный объект${obj ? `: ${esc(obj.name)}` : " (выберите объект в шапке)"}</label>
        <label class="v2-wire-check"><input type="radio" name="bk-scope" value="filter" ${filter ? "" : "disabled"}> По последнему отбору схемы выбранного объекта</label>
        <span class="v2-muted">${esc(filterNote)} Это сохранённый снимок отбора, а не живая синхронизация.</span></fieldset>`;
    }
    mountTemplates($("#bk-tpl"), api, [MODES[mode].tpl], () => dead);
  }
  function resetAnalysis() {
    analysis = null; file = null; checked = new Set(); contractingDate = "";
    $("#bk-rejected").innerHTML = ""; $("#bk-chips").innerHTML = ""; $("#bk-table").innerHTML = ""; $("#bk-summary").textContent = ""; $("#bk-applybar").hidden = true; $("#bk-result").innerHTML = "";
    const f = $("#bk-file"); if (f) f.value = "";
  }
  const dirty = () => !!analysis && analysis.changes.length > 0;

  el.querySelector("#bk-modes").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || busy || b.dataset.mode === mode) return;
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
  function renderAnalysis() {
    const ch = analysis?.changes || [];
    const box = $("#bk-table");
    if (!ch.length) { box.innerHTML = ""; $("#bk-chips").innerHTML = ""; $("#bk-summary").textContent = ""; $("#bk-applybar").hidden = true; return; }
    const rows = ch.map((c, i) => ({
      i, cells: [String(c.line ?? ""), rowLabel(c), esc(c.field_label), esc(valueText(c.was)),
        `${esc(valueText(c.now))}${c.needs_contracting ? `<div class="v2-ex-warn">+ статус «Контрактация»</div>` : ""}${c.warning ? `<div class="v2-ex-warn">⚠ ${esc(c.warning)}</div>` : ""}`],
    }));
    box.innerHTML = changesTableHtml({ head: ["Стр.", mode === "contracting" ? "Позиция" : mode === "statuses" ? "Запись истории" : "Элемент", "Поле", "Было", "Станет"], rows, checkedSet: checked });
    applyIndeterminate(box);
    // Переключатели по полю: одним движением отметить/снять все правки поля (сотни правок по одной снимать нельзя)
    const counts = new Map();
    ch.forEach((c, i) => { const e = counts.get(c.field_label) || { n: 0, on: 0 }; e.n++; if (checked.has(i)) e.on++; counts.set(c.field_label, e); });
    $("#bk-chips").innerHTML = [...counts].map(([label, e]) => `<label class="v2-ex-chip"><input type="checkbox" data-field="${esc(label)}" ${e.on === e.n ? "checked" : ""}> ${esc(label)} (${e.n})</label>`).join("");
    $("#bk-summary").textContent = `Отмечено ${checked.size} из ${ch.length} правок`;
    const needs = ch.some((c, i) => checked.has(i) && c.needs_contracting);
    $("#bk-datebox").hidden = !needs;
    $("#bk-applybar").hidden = false;
    $("#bk-apply").disabled = busy || checked.size === 0;
  }
  wireChangesTable($("#bk-table"), {
    onToggle: (i, on) => { if (on) checked.add(i); else checked.delete(i); renderAnalysis(); },
    onToggleAll: (on) => { checked = on ? new Set(analysis.changes.map((_, i) => i)) : new Set(); renderAnalysis(); },
  });
  $("#bk-chips").addEventListener("change", (e) => {
    const label = e.target.dataset?.field; if (label === undefined || !analysis) return;
    analysis.changes.forEach((c, i) => { if (c.field_label === label) { if (e.target.checked) checked.add(i); else checked.delete(i); } });
    renderAnalysis();
  });
  $("#bk-date")?.addEventListener("input", (e) => { contractingDate = e.target.value; });

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

  $("#bk-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const f = $("#bk-file").files[0];
    const problem = checkFile(f, { ext: ["xlsx"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#bk-analyze").disabled = true; status.set("Сверяем файл с базой…", "busy"); $("#bk-result").innerHTML = "";
    try {
      const data = await analyzeFile(f, mode);
      if (dead) return;
      showAnalysis(data, f);
    } catch (err) {
      if (dead) return;
      analysis = null; renderAnalysis(); $("#bk-rejected").innerHTML = "";
      status.set(`Сверка не удалась: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) { $("#bk-analyze").disabled = false; $("#bk-apply").disabled = !analysis || checked.size === 0; } }
  });

  // ---- применение
  const resultHtml = (r) => {
    let facts;
    if (r.lines_inserted !== undefined) facts = [["Позиций добавлено", r.lines_inserted], ["Позиций изменено", r.lines_updated], ["Записей контрактации обновлено", r.entities_updated]];
    else facts = [["Элементов обновлено", r.elements_updated], ["Записей истории добавлено", r.records_inserted ?? ""], ["Записей истории изменено", r.records_updated ?? ""]];
    const skipped = r.skipped || [];
    return factsHtml(facts) + (skipped.length ? `<div class="v2-callout v2-callout-bad"><strong>Пропущено при применении (${skipped.length}):</strong> остальные правки применены.<ul class="v2-ex-list">${skipped.slice(0, 50).map((s) => `<li>${esc(s.reason || JSON.stringify(s))}</li>`).join("")}${skipped.length > 50 ? `<li class="v2-muted">…и ещё ${skipped.length - 50}</li>` : ""}</ul></div>` : "");
  };

  $("#bk-apply").addEventListener("click", async () => {
    if (busy || !analysis) return;
    const idx = [...checked].sort((a, b) => a - b);
    if (!idx.length) return;
    const selected = idx.map((i) => analysis.changes[i]);
    const needs = selected.filter((c) => c.needs_contracting).length;
    if (needs && !contractingDate) { status.set("Укажите дату статуса «Контрактация» — часть отмеченных элементов сейчас «Запланирован», и назначение контракта добавит им статус.", "bad"); return; }
    if (needs && !isRealDate(contractingDate)) { status.set("Дата статуса «Контрактация» — не существующая дата.", "bad"); return; }
    busy = true; $("#bk-apply").disabled = true; $("#bk-analyze") && ($("#bk-analyze").disabled = true);
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
      $("#bk-table").innerHTML = ""; $("#bk-chips").innerHTML = ""; $("#bk-summary").textContent = ""; $("#bk-applybar").hidden = true; $("#bk-rejected").innerHTML = "";
      const f = $("#bk-file"); if (f) f.value = "";
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) status.set(errText(err), "bad");
      else if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml(MODES[mode].what), "bad");
        const box = $("#bk-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: MODES[mode].journal, entityId: null, sinceMs: sentAt || Date.now(), what: MODES[mode].what }));
      } else status.set(`Не удалось применить: ${errText(err)}. Отмеченное осталось на месте.`, "bad");
    } finally { busy = false; if (!dead) { $("#bk-analyze") && ($("#bk-analyze").disabled = false); if (analysis) $("#bk-apply").disabled = checked.size === 0; } }
  });

  renderMode();
  return {
    hasUnsavedChanges: dirty,
    async guardLeave() { return !dirty() || (await showConfirmDialog("Сверка массовой правки не применена — результат сверки будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; },
  };
}
