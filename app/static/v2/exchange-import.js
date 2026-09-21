// Загрузка файлов Excel в V2: контрактация, график MS Project, история статусов, восстановление статусов, справочник объектов.
//
// Семантика — как в V1 (те же эндпоинты, тот же multipart, те же права и проверки сервера):
//  * «контрактация», «график», «история», «восстановление» — одна загрузка без предпросмотра (в V1 его нет); ПЕРЕД отправкой человек
//    подтверждает последствия (какой файл, в какой объект, что изменится), сервер делает копию базы и применяет одной транзакцией;
//  * «справочник объектов» — сверка (ничего не пишет) → отметка флажками → применение отмеченного; перед применением сверка перечитывается,
//    и если что-то изменилось с момента показа, применение не выполняется (устаревшая сверка).
// Общая логика запуска одна на все загрузки (`runUpload`): один запрос за раз, подтверждение, обработка отказа и неизвестного исхода.
import { api as sharedApi } from "./api.js";
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, mountTemplates, makeStatus, unknownOutcomeHtml, verifyOutcome,
  objectOptions, factsHtml, listHtml, valueText, changesTableHtml, wireChangesTable, applyIndeterminate,
} from "./exchange-common.js";

// ---------------------------------------------------------------- общий каркас одной загрузки
function mountUploadOp(el, ctx, cfg) {
  const { screen, groupTitle, api, objects, objectId } = ctx;
  let dead = false, busy = false;
  const objectById = new Map((objects || []).map((o) => [o.id, o]));
  const hasObject = cfg.controls.some((c) => c.type === "object");

  const controlHtml = (c) => {
    if (c.type === "object") {
      const known = objectById.has(objectId);
      return `<label class="v2-wire-field v2-field-wide"><span>${esc(c.label || "Объект")}</span>
        <select id="ex-object" aria-label="${esc(c.label || "Объект")}">${known ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(objects, objectId)}</select></label>
        ${c.hint ? `<p class="v2-muted v2-ex-hint">${c.hint}</p>` : ""}`;
    }
    if (c.type === "select") {
      return `<label class="v2-wire-field v2-field-wide"><span>${esc(c.label)}</span><select id="ex-${c.id}" aria-label="${esc(c.label)}">${c.options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select></label>
        <p class="v2-muted v2-ex-hint" id="ex-${c.id}-hint"></p>`;
    }
    if (c.type === "radio") {
      return `<fieldset class="v2-fieldset"><legend>${esc(c.label)}</legend>${c.options.map(([v, t], i) => `<label class="v2-wire-check"><input type="radio" name="ex-${c.id}" value="${esc(v)}" ${i === 0 ? "checked" : ""}> ${esc(t)}</label>`).join("")}</fieldset>`;
    }
    return "";
  };

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: cfg.summary,
    body: `${cfg.callout ? `<div class="v2-callout ${cfg.calloutBad ? "v2-callout-bad" : ""}" role="note">${cfg.callout}</div>` : ""}
      <form id="ex-form" autocomplete="off" novalidate>
        ${cfg.controls.map(controlHtml).join("")}
        <p id="ex-source" class="v2-muted" hidden></p>
        <label class="v2-wire-field v2-field-wide"><span>${esc(cfg.fileLabel)}</span><input type="file" id="ex-file" accept="${cfg.ext.map((x) => "." + x).join(",")}"></label>
        <div id="ex-tpl" class="v2-ex-tplbox"></div>
        <div class="v2-bar"><button type="submit" class="v2-btn ${cfg.danger ? "v2-danger" : "v2-primary"}" id="ex-go">${esc(cfg.submitLabel)}</button></div>
      </form>
      <div id="ex-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="ex-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#ex-status"));
  mountTemplates($("#ex-tpl"), api, cfg.templates, () => dead);

  const values = () => {
    const v = {};
    for (const c of cfg.controls) {
      if (c.type === "object") { v.objectId = Number($("#ex-object").value) || null; v.object = objectById.get(v.objectId) || null; }
      else if (c.type === "select") v[c.id] = $(`#ex-${c.id}`).value;
      else if (c.type === "radio") v[c.id] = el.querySelector(`input[name="ex-${c.id}"]:checked`)?.value;
    }
    return v;
  };
  const refresh = () => {
    const v = values();
    for (const c of cfg.controls) if (c.type === "select" && c.hintFor) { const h = $(`#ex-${c.id}-hint`); if (h) h.textContent = c.hintFor(v[c.id]); }
    if (cfg.source) {
      const src = $("#ex-source");
      const name = v.object?.source_file;
      src.hidden = false;
      src.innerHTML = !v.objectId ? "Выберите объект." : name ? `Чертёж объекта: <strong>${esc(name)}</strong>` : `<span class="v2-bad-text">У объекта нет загруженного чертежа — загрузка истории невозможна (сначала загрузите чертёж).</span>`;
    }
  };
  $("#ex-form").addEventListener("input", refresh);
  refresh();

  async function submit() {
    if (busy) return;                       // повторное нажатие (двойной щелчок, Enter) во время подтверждения и запроса не создаёт второй запрос
    const v = values();
    const file = $("#ex-file").files[0];
    const problem = (hasObject && !v.objectId ? "Сначала выберите объект" : null) || (cfg.source && hasObject && !v.object?.source_file ? "У выбранного объекта нет загруженного чертежа" : null)
      || checkFile(file, { ext: cfg.ext }) || cfg.validate?.(v, file);
    if (problem) { status.set(problem, "bad"); $("#ex-result").innerHTML = ""; return; }
    busy = true; $("#ex-go").disabled = true;
    let sentAt = null;
    try {
      const c = cfg.confirm(v, file);
      if (!(await showConfirmDialog(c.message, { confirmLabel: c.label || cfg.submitLabel, danger: !!c.danger, multiline: true }))) { status.set("Загрузка отменена — файл не отправлялся.", ""); return; }
      if (dead) return;
      const fd = new FormData();
      fd.append("file", file, file.name);
      for (const [k, val] of Object.entries(cfg.fields(v))) fd.append(k, String(val));
      status.set("Загрузка и обработка файла… Не закрывайте страницу.", "busy");
      $("#ex-result").innerHTML = "";
      sentAt = Date.now();
      const res = await api.upload(cfg.path(v), fd);
      if (dead) return;
      status.set(cfg.doneText ? cfg.doneText(res, v) : "Готово.", "ok");
      $("#ex-result").innerHTML = cfg.result(res, v, file);
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) { status.set(errText(err), "bad"); return; }
      if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml(cfg.what), "bad");
        const box = $("#ex-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: cfg.journalAction, entityId: cfg.journalEntity?.(v), sinceMs: sentAt || Date.now(), what: cfg.what }), { once: false });
      } else status.set(`Не выполнено: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#ex-go")?.removeAttribute("disabled"); }
  }
  $("#ex-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}

// ---------------------------------------------------------------- конфигурации загрузок
const objName = (v) => (v.object ? `«${v.object.project_name ? v.object.project_name + " · " : ""}${v.object.name}»` : "");

const contractingCfg = (ctx) => ({
  ext: ["xlsx"], fileLabel: "Файл .xlsx (лист «Контрактация»)", submitLabel: "Импортировать", what: "импорт контрактации", templates: ["contracting"],
  summary: "Создаёт или находит контрагентов, договоры, спецификации и контракты с позициями по файлу. Файл разбирается на сервере; при любой ошибке ничего не записывается.",
  controls: [{ type: "object", label: "Объект контракта", hint: "Объект выбирается явно: файл контрактации приходит от снабжения и может относиться к соседнему зданию. Подставлен объект из шапки." }],
  path: (v) => `/import-contracting-xlsx?object_id=${encodeURIComponent(v.objectId)}`,
  fields: () => ({}),
  journalAction: "import_contracting", journalEntity: (v) => v.objectId,
  confirm: (v, f) => ({
    message: `Загрузить контрактацию из файла «${f.name}» (${fmtSize(f.size)}) в объект ${objName(v)}?\n\nБудут созданы или найдены контрагенты, договоры, спецификации и контракты; количества позиций пересчитываются по файлу — повторная загрузка того же файла результат не меняет.\nПеред загрузкой сервер сохранит копию базы. Загрузка выполняется одной операцией: при ошибке ничего не изменится.`,
    label: "Загрузить",
  }),
  doneText: (r) => `Готово: строк обработано ${r.rows_processed}, контрактов затронуто ${r.contracts_touched}, позиций создано ${r.lines_inserted}, обновлено ${r.lines_updated}.`,
  result: (r) => factsHtml([
    ["Строк обработано", r.rows_processed], ["Неполных строк пропущено", r.incomplete_rows_skipped || ""], ["Контрактов затронуто", r.contracts_touched],
    ["Позиций создано", r.lines_inserted], ["Позиций обновлено", r.lines_updated], ["Марок заведено в справочник", r.marks_created || ""],
    ["Договоров привязано к объекту", r.agreements_object_filled || ""],
  ]) + (r.foreign_agreement_rows ? `<div class="v2-callout v2-callout-bad">Пропущено строк: ${r.foreign_agreement_rows} — договор принадлежит другому объекту (номер договора нельзя переиспользовать на другом объекте).
      ${listHtml("Договоры", r.foreign_agreements || [], { cap: 5 })}</div>` : "")
    + listHtml("Тип не определён для марок", r.unresolved_type_marks || []) + listHtml("Предупреждения по датам", r.date_warnings || [])
    + `<p class="v2-muted">Результат виден в разделе «Контракты» и в справочнике контрагентов (в том числе в текущем интерфейсе).</p>`,
});

const scheduleCfg = () => ({
  ext: ["xlsx"], fileLabel: "Файл .xlsx (лист графика)", submitLabel: "Импортировать", what: "импорт графика", templates: ["schedule"],
  summary: "Сопоставляется с изделиями по блоку «Захватка / Кран / Стоянка / Этаж / Вид работ».",
  controls: [
    { type: "object", label: "Объект", hint: "Объект выбирается явно: без него даты могли бы уехать в чужое здание. Подставлен объект из шапки." },
    { type: "select", id: "kind", label: "Вид графика", options: [["baseline", "Базовый (директивные даты изделий)"], ["current", "Актуализированный (прогноз, новая версия)"]],
      hintFor: (k) => (k === "baseline"
        ? "Директивные сроки: проставятся в сами изделия (начало и завершение СМР) и заменят прежний базовый график объекта. Даты, правленные вручную, останутся как есть."
        : "Прогноз: сохранится отдельной версией и попадёт в отклонение от базового графика. Даты изделий не меняются, предыдущие версии остаются.") },
  ],
  path: () => "/import-schedule-xlsx",
  fields: (v) => ({ object_id: v.objectId, kind: v.kind }),
  journalAction: "import_schedule", journalEntity: (v) => v.objectId,
  confirm: (v, f) => ({
    message: v.kind === "baseline"
      ? `Загрузить БАЗОВЫЙ график из файла «${f.name}» (${fmtSize(f.size)}) в объект ${objName(v)}?\n\nДирективные даты начала и завершения СМР проставятся в изделия объекта и заменят прежний базовый график. Даты, правленные вручную, останутся как есть.\nПеред загрузкой сервер сохранит копию базы; загрузка выполняется одной операцией.`
      : `Загрузить АКТУАЛИЗИРОВАННЫЙ график (прогноз) из файла «${f.name}» (${fmtSize(f.size)}) в объект ${objName(v)}?\n\nПрогноз сохранится новой версией; даты изделий не меняются. Повторная загрузка добавит ещё одну версию (предыдущие остаются).\nПеред загрузкой сервер сохранит копию базы.`,
    label: "Загрузить",
  }),
  doneText: (r) => (r.kind === "baseline"
    ? `Готово: строк обработано ${r.rows_processed}, пропущено ${r.rows_skipped}, изделий обновлено ${r.elements_updated}.`
    : `Готово: строк обработано ${r.rows_processed}, пропущено ${r.rows_skipped}, изделий в новой версии прогноза ${r.elements_in_version}.`),
  result: (r) => {
    const kept = Object.values(r.manual_kept || {}).reduce((a, b) => a + b, 0);
    return factsHtml([["Вид графика", r.kind === "baseline" ? "базовый" : "актуализированный"], ["Строк обработано", r.rows_processed], ["Строк пропущено", r.rows_skipped || ""],
      r.kind === "baseline" ? ["Изделий обновлено", r.elements_updated] : ["Изделий в новой версии прогноза", r.elements_in_version],
      ["Оставлено без изменений (даты правлены вручную)", kept || ""], ["Версия графика", r.version_id ?? ""]])
      + listHtml("Блоков без совпадений", r.unmatched_blocks || []) + listHtml("Пропущенные строки", (r.skipped_rows || []).map((s) => (typeof s === "string" ? s : JSON.stringify(s))));
  },
});

const HIST_MODES = [
  ["sync", "Скорректировать даты (обновить дату существующей записи, новые события добавить)"],
  ["merge", "Дополнить (только добавлять; пропускать дубли: тот же статус в ту же дату)"],
  ["replace", "Заменить (удалить текущую историю сопоставленных элементов)"],
];
const histResult = (r) => factsHtml([
  ["Сопоставлено элементов", r.matched_elements], ["Добавлено записей", r.inserted], ["Исправлено записей", r.updated || ""], ["Пропущено дублей", r.skipped_duplicate || ""],
  ["Не найдено в этой БД", r.unmatched_elements || ""], ["«Запланирован» сдвинуто в начало истории", r.planned_shifted || ""],
  ["Событий в системе, которых нет в файле (не удалены)", r.unpaired_existing || ""], ["Реквизиты контракта", r.contract_columns || ""],
]) + (r.invalid_dates ? `<div class="v2-callout v2-callout-bad">Строк с нераспознанной датой (пропущены): ${r.invalid_dates}.${listHtml("Примеры", r.invalid_date_examples || [], { cap: 5 })}</div>` : "")
  + listHtml("Контракты", r.contract_object_warnings || [], { cap: 3 }) + listHtml("Примеры handle без совпадения", r.unmatched_handles || []);

const historyCfg = () => ({
  ext: ["xlsx"], fileLabel: "Файл .xlsx (лист «История статусов»)", submitLabel: "Импортировать", what: "импорт истории статусов", templates: ["history"], source: true,
  summary: "Загрузка истории статусов элементов чертежа объекта из ранее сделанной выгрузки.",
  callout: "Запись «Запланирован», созданную импортом чертежа, импорт сам сдвинет раньше самого раннего события элемента — иначе проставленная задним числом дата поставки или монтажа оказалась бы раньше неё и статус откатился бы в «Запланирован».",
  controls: [{ type: "object", label: "Объект (чертёж — текущий чертёж объекта)" }, { type: "radio", id: "mode", label: "Режим", options: HIST_MODES }],
  path: () => "/import-history-xlsx",
  fields: (v) => ({ source_file: v.object.source_file, mode: v.mode }),
  journalAction: "import_history", journalEntity: () => null,
  confirm: (v, f) => ({
    message: `Импортировать историю статусов из файла «${f.name}» (${fmtSize(f.size)}) в чертёж «${v.object.source_file}» (объект ${objName(v)})?\n\nРежим: ${HIST_MODES.find((m) => m[0] === v.mode)[1]}.`
      + (v.mode === "replace" ? "\n\nВНИМАНИЕ: текущая история статусов всех элементов, найденных в файле, будет УДАЛЕНА и создана заново по файлу. Отменить это нельзя — только восстановить копию базы." : "")
      + "\nПеред загрузкой сервер сохранит копию базы; загрузка выполняется одной операцией: при ошибке ничего не изменится.",
    label: v.mode === "replace" ? "Заменить историю" : "Импортировать", danger: v.mode === "replace",
  }),
  doneText: (r) => `Готово: сопоставлено элементов ${r.matched_elements}, исправлено записей ${r.updated}, добавлено ${r.inserted}, пропущено дублей ${r.skipped_duplicate}, не найдено в этой БД ${r.unmatched_elements}.`,
  result: histResult,
});

const restoreCfg = () => ({
  ext: ["xlsx"], fileLabel: "Файл .xlsx (выгрузка статусов)", submitLabel: "Восстановить", what: "восстановление статусов", templates: ["history"], source: true, danger: true,
  summary: "Для случая, когда история статусов была потеряна (например, после аварийной пересборки БД): принимает выгрузку «Статус на дату» или «История статусов». Для КАЖДОГО найденного в файле элемента история пересоздаётся по файлу (режим «Заменить»).",
  callout: "Обычное «Дополнить» здесь не сработает: у только что пересозданных элементов уже есть свежая запись «Запланирован» с сегодняшней датой, она новее восстанавливаемых дат и победила бы как последняя. Поэтому режим один — «Заменить».",
  controls: [{ type: "object", label: "Объект (чертёж — текущий чертёж объекта)" }],
  path: () => "/import-history-xlsx",
  fields: (v) => ({ source_file: v.object.source_file, mode: "replace" }),
  journalAction: "import_history", journalEntity: () => null,
  confirm: (v, f) => ({
    message: `Восстановить статусы из файла «${f.name}» (${fmtSize(f.size)}) для чертежа «${v.object.source_file}» (объект ${objName(v)})?\n\nВНИМАНИЕ: текущая история статусов всех элементов, найденных в файле, будет УДАЛЕНА и создана заново по файлу. Отменить это нельзя — только восстановить копию базы.\nПеред загрузкой сервер сохранит копию базы; при ошибке ничего не изменится.`,
    label: "Восстановить статусы", danger: true,
  }),
  doneText: (r) => `Готово: сопоставлено элементов ${r.matched_elements}, восстановлено записей ${r.inserted}, не найдено в этой БД ${r.unmatched_elements}.`,
  result: histResult,
});

// ---------------------------------------------------------------- справочник объектов: сверка → флажки → применение
const OBJECTS_FIELD_LABELS = {
  address: "Адрес", address_region: "Регион (по адресу)", smu_id: "СМУ", smu_director_id: "Директор СМУ", responsible_id: "Ответственный (ДП/РП)",
  status: "Статус", lat: "Широта", lon: "Долгота", media_url: "Ссылка на фото/видео", smr_start_reported: "Старт СМР", postal_code: "Почтовый индекс",
};
const OBJECTS_HIDDEN = new Set(["address_code", "address_source", "address_parts"]);
const CATALOG_STATUS = { active: "В работе", perspective: "Перспективный", suspended: "Приостановлен", completed: "Завершён", archived: "Архивный" };
const objValue = (field, v) => (v === null || v === undefined || v === "" ? "—" : field === "status" ? (CATALOG_STATUS[v] || v) : String(v));
const objFieldsSummary = (fields) => {
  const rows = Object.entries(fields || {}).filter(([k]) => !OBJECTS_HIDDEN.has(k));
  return rows.length ? rows.map(([k, v]) => `${OBJECTS_FIELD_LABELS[k] || k}: ${objValue(k, v)}`).join("; ") : "(без дополнительных полей)";
};

function mountObjectsImport(el, ctx) {
  const { screen, groupTitle, api } = ctx;
  let dead = false, busy = false;
  let analysis = null, file = null, checked = new Set();
  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: null,
    body: `<p class="v2-muted">Файл реестра заказчика (лист «Объекты на карте»): строка — один объект, сопоставление по <b>наименованию</b>. Новое наименование заведёт объект (и проект с тем же названием — «один объект = один проект»); совпавшее с уже внесённым — покажет расхождения.
        Ничего не применяется, пока вы не отметите нужное флажками и не нажмёте «Применить отмеченное». Ссылка на фото/видео сохраняется текстом — сервер её не скачивает.</p>
      <form id="ex-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Файл .xlsx (лист «Объекты на карте»)</span><input type="file" id="ex-file" accept=".xlsx"></label>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="ex-analyze">Сверить с базой</button></div>
      </form>
      <div id="ex-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="ex-issues"></div>
      <div id="ex-table"></div>
      <div id="ex-summary" class="v2-muted"></div>
      <div class="v2-bar v2-ex-stickybar" id="ex-applybar" hidden><button type="button" class="v2-btn v2-primary" id="ex-apply">Применить отмеченное</button></div>
      <div id="ex-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#ex-status"));

  function renderTable() {
    const box = $("#ex-table");
    if (!analysis || !analysis.changes.length) { box.innerHTML = ""; $("#ex-summary").textContent = ""; $("#ex-applybar").hidden = true; return; }
    const rows = analysis.changes.map((c, i) => ({
      i, cells: c.kind === "create"
        ? [`<b>+ ${esc(c.key)}</b>`, "Новый объект и проект", "—", esc(objFieldsSummary(c.fields))]
        : [esc(c.key), esc(c.field_label), esc(objValue(c.field, c.was)), esc(objValue(c.field, c.now))],
    }));
    box.innerHTML = changesTableHtml({ head: ["Объект", "Поле", "Было", "Станет"], rows, checkedSet: checked });
    applyIndeterminate(box);
    $("#ex-summary").textContent = `Отмечено ${checked.size} из ${analysis.changes.length} правок`;
    $("#ex-apply").disabled = busy || checked.size === 0;
    $("#ex-applybar").hidden = false;
  }
  wireChangesTable($("#ex-table"), {
    onToggle: (i, on) => { if (on) checked.add(i); else checked.delete(i); renderTable(); },
    onToggleAll: (on) => { checked = on ? new Set(analysis.changes.map((_, i) => i)) : new Set(); renderTable(); },
  });

  const issues = (title, items, fmt) => (items?.length ? `<p class="v2-ex-list-title"><strong>${esc(title)} (${items.length}):</strong></p><ul class="v2-ex-list">${items.slice(0, 50).map((x) => `<li>${esc(fmt(x))}</li>`).join("")}${items.length > 50 ? `<li class="v2-muted">…и ещё ${items.length - 50}</li>` : ""}</ul>` : "");
  const fmtIssue = (x) => `стр. ${x.line}${x.name ? ` («${x.name}»)` : ""}: ${x.reason}`;

  async function runAnalyze(f) {
    const fd = new FormData(); fd.append("file", f, f.name);
    return api.upload("/objects-import/analyze", fd);
  }

  async function analyze() {
    if (busy) return;
    const f = $("#ex-file").files[0];
    const problem = checkFile(f, { ext: ["xlsx"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#ex-analyze").disabled = true; status.set("Сверяем файл с базой…", "busy");
    $("#ex-result").innerHTML = "";
    try {
      const data = await runAnalyze(f);
      if (dead) return;
      analysis = data; file = f; checked = new Set(data.changes.map((_, i) => i));
      status.set(`Прочитано строк: ${data.rows_read}. Новых объектов: ${data.objects_new}, правок у существующих: ${data.objects_updated}.`, "ok");
      $("#ex-issues").innerHTML = issues("Предупреждения, не блокируют применение", data.warnings, fmtIssue) + issues("Не может быть применено", data.rejected, fmtIssue);
      renderTable();
    } catch (err) {
      if (dead) return;
      analysis = null; $("#ex-issues").innerHTML = ""; renderTable();
      status.set(`Сверка не удалась: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) { $("#ex-analyze").disabled = false; $("#ex-apply").disabled = !analysis || checked.size === 0; } }
  }

  async function apply() {
    if (busy || !analysis) return;
    const selectedIdx = [...checked].sort((a, b) => a - b);
    if (!selectedIdx.length) return;
    busy = true; $("#ex-apply").disabled = true; $("#ex-analyze").disabled = true;
    let sentAt = null;
    try {
      const creates = selectedIdx.filter((i) => analysis.changes[i].kind === "create").length;
      const ok = await showConfirmDialog(`Применить ${selectedIdx.length} изменений к справочнику объектов (новых объектов: ${creates})?\n\nБудут созданы объекты и проекты и изменены реквизиты существующих объектов. Перед применением сервер сохранит копию базы; применение выполняется одной операцией.`,
        { confirmLabel: "Применить", multiline: true });
      if (!ok || dead) { if (!dead) status.set("Применение отменено — ничего не изменено.", ""); return; }
      // Сверка перечитывается: если с момента показа справочник или файл дали другой результат, применять устаревшее нельзя.
      status.set("Проверяем, что сверка не устарела…", "busy");
      let fresh;
      try { fresh = await runAnalyze(file); } catch (err) { status.set(`Не удалось перепроверить сверку: ${errText(err)}. Ничего не применено.`, "bad"); return; }
      if (dead) return;
      const key = (c) => JSON.stringify(c);
      const freshSet = new Set(fresh.changes.map(key));
      const stale = selectedIdx.filter((i) => !freshSet.has(key(analysis.changes[i])));
      if (stale.length) {
        analysis = fresh; checked = new Set(fresh.changes.map((_, i) => i));
        $("#ex-issues").innerHTML = issues("Предупреждения, не блокируют применение", fresh.warnings, fmtIssue) + issues("Не может быть применено", fresh.rejected, fmtIssue);
        renderTable();
        status.set(`Сверка устарела: справочник изменился после сверки (${stale.length} отмеченных правок больше не совпадают с базой). Ничего не применено — проверьте обновлённую таблицу и примените снова.`, "bad");
        return;
      }
      status.set("Применяем…", "busy");
      sentAt = Date.now();
      const res = await api.post("/objects-import/apply", { changes: selectedIdx.map((i) => analysis.changes[i]) });
      if (dead) return;
      let text = `Готово: создано объектов ${res.created}, обновлено ${res.updated}.`;
      if ((res.skipped || []).length) text += ` Пропущено: ${res.skipped.length}.`;
      status.set(text, "ok");
      $("#ex-result").innerHTML = factsHtml([["Создано объектов", res.created], ["Обновлено объектов", res.updated]])
        + issues("Пропущено при применении", res.skipped, (s) => `${s.name ? `«${s.name}»: ` : ""}${s.reason}`)
        + `<p class="v2-muted">Новые объекты видны в шапке после обновления страницы и в разделе «Проекты и объекты».</p>`;
      analysis = null; file = null; checked = new Set(); renderTable(); $("#ex-issues").innerHTML = "";
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) status.set(errText(err), "bad");
      else if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml("применение справочника объектов"), "bad");
        const box = $("#ex-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "object_import", entityId: null, sinceMs: sentAt || Date.now(), what: "применение справочника объектов" }));
      } else status.set(`Не удалось применить: ${errText(err)}. Отмеченное осталось на месте.`, "bad");
    } finally { busy = false; if (!dead) { $("#ex-analyze")?.removeAttribute("disabled"); if (analysis) $("#ex-apply").disabled = checked.size === 0; } }
  }

  $("#ex-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#ex-apply").addEventListener("click", apply);
  return {
    hasUnsavedChanges: () => !!analysis && analysis.changes.length > 0,
    async guardLeave() { return !analysis || !analysis.changes.length || (await showConfirmDialog("Сверка справочника объектов не применена — результат сверки будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; },
  };
}

// ---------------------------------------------------------------- вход
export const IMPORT_OPS = {
  "contracting-import": (el, ctx) => mountUploadOp(el, ctx, contractingCfg(ctx)),
  "schedule-import": (el, ctx) => mountUploadOp(el, ctx, scheduleCfg(ctx)),
  "history-import": (el, ctx) => mountUploadOp(el, ctx, historyCfg(ctx)),
  "status-restore": (el, ctx) => mountUploadOp(el, ctx, restoreCfg(ctx)),
  "objects-import": mountObjectsImport,
};
export { valueText };
