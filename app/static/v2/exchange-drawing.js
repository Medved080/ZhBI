// «Загрузить чертёж» (DXF) в V2: разбор → сводка расхождений → решения человека → применение. Те же эндпоинты, что у V1:
// `POST /import-dxf/analyze` (файл + объект; в БД ничего не пишет) и `POST /import-dxf/apply` (токен разбора + решения).
//
// Семантика V1, которая сохранена:
//  * перед применением человек видит, что изменится: сколько изделий сопоставлено (по handle и по геометрии), новых, исчезнувших, со сменой
//    марки/реквизитов/привязки к зонам, расхождения с ручными правками и геометрии зон, новые подтипы, изделия без марки;
//  * по умолчанию смена марок ПРИНИМАЕТСЯ (галочку можно снять), ручные правки СОХРАНЯЮТСЯ (перезаполнить из чертежа — только по отметке),
//    зоны с изменённой геометрией по умолчанию правятся, а не создаются заново;
//  * применение — копия базы, затем этапы: подтипы объекта → изделия → сетка осей → зоны и привязки. Это НЕ одна транзакция (как в V1): сбой
//    посреди загрузки оставляет записанными уже завершённые этапы — человеку об этом сказано в подтверждении; восстановление — из копии базы.
// Токен разбора хранится в памяти сервера (последние три): при перезапуске сервера или трёх новых разборах применить старый нельзя —
// показывается ответ сервера и предлагается разобрать заново. Повторное применение того же токена сервер не принимает.
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, objectOptions, factsHtml,
} from "./exchange-common.js";

const FIELD_LABELS = { mark: "Марка", element_type: "Тип", subtype: "Подтип", elevation_mm: "Отметка", floor: "Этаж" };
const dash = (v) => (v === null || v === undefined ? "—" : String(v));
const changesText = (changes) => Object.entries(changes || {}).map(([f, p]) => `${FIELD_LABELS[f] || f}: ${dash(p[0])} → ${dash(p[1])}`).join("; ");

function countLine(label, value, danger) {
  return value ? `<div class="${danger ? "v2-bad-text" : ""}"><b>${value}</b> — ${esc(label)}</div>` : "";
}

function detailSection(title, rows, total, limit, render, open = false) {
  if (!total) return "";
  return `<details class="v2-collapsible" ${open ? "open" : ""}><summary><b>${esc(title)}: ${total}</b></summary>
    ${total > rows.length ? `<p class="v2-muted">Показаны первые ${rows.length} из ${total}.</p>` : ""}
    <div class="v2-ex-details">${rows.map(render).join("")}</div></details>`;
}

// Время обработки: чертёж на десятки МБ разбирается минуту и дольше — человек видит, что процесс идёт, и сколько.
function startTimer(status, text) {
  const t0 = Date.now();
  const tick = () => status.set(`${text} Прошло ${Math.round((Date.now() - t0) / 1000)} с.`, "busy");
  tick();
  const h = setInterval(tick, 1000);
  return () => { clearInterval(h); return Math.round((Date.now() - t0) / 1000); };
}

export function mountDrawingUpload(el, ctx) {
  const { screen, groupTitle, api, objects, objectId } = ctx;
  let dead = false, busy = false;
  let analysis = null;        // ответ analyze (с токеном)
  let stopTimer = null;
  const objectById = new Map((objects || []).map((o) => [o.id, o]));

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: null,
    body: `<p class="v2-muted">Загрузка чертежа объекта в формате DXF в два шага. Сначала — разбор и сводка изменений (в базу ничего не пишется), затем — применение того, что вы увидели.</p>
      <ol class="v2-ex-steps"><li>Выберите объект и файл .dxf и нажмите «Разобрать чертёж».</li><li>Проверьте сводку: что сопоставлено, что новое, что исчезло, что изменится.</li><li>Примите решения по расхождениям и примените.</li></ol>
      <form id="dr-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Объект</span>
          <select id="dr-object" aria-label="Объект">${objectById.has(objectId) ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(objects, objectId)}</select></label>
        <p class="v2-muted v2-ex-hint">Объект выбирается явно: чертёж заменяет геометрию и привязки изделий ЭТОГО объекта. Подставлен объект из шапки.</p>
        <label class="v2-wire-field v2-field-wide"><span>Файл чертежа (.dxf)</span><input type="file" id="dr-file" accept=".dxf"></label>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="dr-analyze">Разобрать чертёж</button></div>
      </form>
      <div id="dr-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="dr-review"></div>
      <div id="dr-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#dr-status"));

  // ---- сводка расхождений (как в V1)
  function renderReview() {
    const box = $("#dr-review");
    if (!analysis) { box.innerHTML = ""; return; }
    const a = analysis, c = a.counts || {}, d = a.details || {};
    const conflicts = c.mark_change_contract_conflicts || 0;
    const lim = a.detail_limit;
    box.innerHTML = `<div class="v2-callout" role="region" aria-label="Сводка изменений">
      <p>Объект: <b>${esc(a.object_name || "—")}</b>. Новый чертёж: <b>${esc(a.source_file)}</b>${a.previous_source_file ? `, прежний: ${esc(a.previous_source_file)}` : ", прежнего чертежа не было"}.</p>
      <div class="v2-ex-counts">
        ${countLine("сопоставлено по handle (тот же элемент чертежа)", c.matched_by_handle)}
        ${countLine("сопоставлено по геометрии (элемент перерисован)", c.matched_by_geometry)}
        ${countLine("новых элементов", c.new)}
        ${countLine("исчезло из чертежа (статусы и история сохранятся)", c.retired, c.retired_with_progress > 0)}
        ${countLine("из них с начатой работой (не «Запланирован»)", c.retired_with_progress, true)}
        ${countLine("сменилась марка", c.mark_changed, conflicts > 0)}
        ${countLine("из них перестают соответствовать позиции своего контракта", conflicts, true)}
        ${countLine("изменились другие реквизиты (отметка, подтип, этаж)", (c.attribute_changed || 0) - (c.mark_changed || 0))}
        ${countLine("сменится привязка к зонам (захватка, кран, стоянка)", c.zone_binding_changes, c.zone_binding_changes_with_progress > 0)}
        ${countLine("из них с начатой работой", c.zone_binding_changes_with_progress, true)}
      </div>
      ${c.mark_changed ? `<label class="v2-wire-check"><input type="checkbox" id="dr-accept-marks" checked> Принять смену марок из чертежа. Если снять — марки останутся прежними, остальная геометрия обновится в любом случае.</label>` : ""}
      ${(a.by_mark_source || {}).unresolved ? `<p class="v2-bad-text"><b>${a.by_mark_source.unresolved}</b> изделий без марки — в чертеже для них не нашлось подписи. Такое изделие загрузится, но не свяжется с позицией контракта: привязка идёт по паре «тип + марка».</p>` : ""}
      ${c.zone_conflicts ? `<details class="v2-collapsible" open><summary><b>Изменилась геометрия зон: ${c.zone_conflicts}</b></summary>
        <p class="v2-muted">Зоны опознаны по номеру, но контуры в чертеже другие. Обновить существующую запись справочника или создать новую?</p>
        <div class="v2-ex-details">${(d.zone_conflicts || []).map((z) => `<div><label class="v2-wire-check"><input type="checkbox" data-newzone="${z.zone_id}"> <span><b>${esc(z.category)} ${esc(z.name || "№" + (z.number ?? "—"))}</b> — создать новую запись вместо правки</span></label>
          <div class="v2-muted v2-ex-indent">${(z.levels || []).map((l) => l.kind === "изменён"
            ? `ярус ${l.elevation_mm === null ? "без отметки" : "+" + l.elevation_mm}: контур изменён${l.centroid_shift_mm ? `, сдвиг центра ${l.centroid_shift_mm} мм` : ""}${l.area_change_pct ? `, площадь на ${l.area_change_pct}%` : ""}${l.points_before !== l.points_after ? `, точек ${l.points_before} → ${l.points_after}` : ""}`
            : `ярус ${l.elevation_mm === null ? "без отметки" : "+" + l.elevation_mm}: ${esc(l.kind)}`).join("; ")}</div></div>`).join("")}</div></details>` : ""}
      ${c.zones_new ? `<p class="v2-muted">Новых зон в чертеже: ${c.zones_new} — будут добавлены в справочники.</p>` : ""}
      ${c.subtypes_new ? `<details class="v2-collapsible" open><summary><b>Новых подтипов у объекта: ${c.subtypes_new}</b></summary>
        <p class="v2-muted">Справочник подтипов свой у каждого объекта и пополняется загрузкой. Проверьте список — похожие написания рядом обычно означают опечатку в имени слоя чертежа.</p>
        <div class="v2-ex-details">${(d.subtypes_new || []).map((s) => `<div>${esc(s.element_type)} · <b>${esc(s.subtype)}</b></div>`).join("")}</div></details>` : ""}
      ${c.manual_conflicts ? `<details class="v2-collapsible" open><summary><b>Расходятся с ручной правкой: ${c.manual_conflicts}</b></summary>
        <p class="v2-muted">Эти поля правились вручную в справочнике элементов. По умолчанию сохраняются ручные значения; отметьте, что перезаполнить из чертежа.</p>
        <div class="v2-ex-details">${(d.manual_conflicts || []).map((row) => `<div><b>${esc(`${row.element_type || ""} ${row.mark || "без марки"}`)}</b>
          ${Object.entries(row.changes).map(([f, p]) => `<label class="v2-wire-check v2-ex-inline"><input type="checkbox" data-refill="${row.element_id}:${esc(f)}"> <span>${esc(FIELD_LABELS[f] || f)}: ${esc(dash(p[0]))} → ${esc(dash(p[1]))}</span></label>`).join("")}</div>`).join("")}</div>
        <label class="v2-wire-check"><input type="checkbox" id="dr-refill-all"> Перезаполнить из чертежа все правленные руками поля</label></details>` : ""}
      ${detailSection("Смена марки", d.mark_changes || [], c.mark_changed, lim, (r) => `<div>${esc(r.element_type)} ${esc(changesText(r.changes))}${r.contract_conflict ? ` <span class="v2-bad-text">— не соответствует позиции контракта</span>` : ""}${r.current_status !== "planned" ? ` <span class="v2-muted">(статус: ${esc(r.current_status)})</span>` : ""}</div>`)}
      ${detailSection("Исчезли из чертежа", d.retired || [], c.retired, lim, (r) => `<div>${esc(`${r.element_type} ${r.mark || "без марки"}`)} <span class="v2-muted">(handle ${esc(r.dxf_handle)}, статус ${esc(r.current_status)})</span></div>`)}
      ${detailSection("Новые элементы", d.new || [], c.new, lim, (r) => `<div>${esc(r.element_type)} ${esc(r.mark || "без марки")} <span class="v2-muted">(отм. ${r.elevation_mm === null ? "—" : esc(String(r.elevation_mm))})</span></div>`)}
      ${detailSection("Изменились реквизиты", d.attribute_changes || [], (c.attribute_changed || 0) - (c.mark_changed || 0), lim, (r) => `<div>${esc(r.element_type)} ${esc(changesText(r.changes))}</div>`)}
      ${detailSection("Сменится привязка к зонам", d.zone_binding_changes || [], c.zone_binding_changes, lim, (r) => `<div>${esc(`${r.element_type} ${r.mark || "без марки"}`)} ${Object.entries(r.changes || {}).map(([k, p]) => `<span class="v2-muted">${esc(k)}:</span> ${esc(p[0] || "нет")} → <b>${esc(p[1] || "нет")}</b>`).join("; ")}${r.current_status !== "planned" ? ` <span class="v2-bad-text">(работа начата: ${esc(r.current_status)})</span>` : ""}</div>`, c.zone_binding_changes_with_progress > 0)}
      <div class="v2-bar v2-ex-stickybar"><button type="button" class="v2-btn v2-primary" id="dr-apply">Применить</button><button type="button" class="v2-btn" id="dr-cancel">Отменить разбор</button></div>
    </div>`;
    $("#dr-refill-all")?.addEventListener("change", (e) => box.querySelectorAll("input[data-refill]").forEach((cb) => { cb.checked = e.target.checked; }));
    $("#dr-apply").addEventListener("click", apply);
    $("#dr-cancel").addEventListener("click", () => { analysis = null; renderReview(); status.set("Разбор отменён — данные не изменены.", ""); });
  }

  // ---- разбор
  async function analyze() {
    if (busy) return;
    const objectValue = Number($("#dr-object").value) || null;
    const file = $("#dr-file").files[0];
    const problem = (!objectValue ? "Сначала выберите объект" : null) || checkFile(file, { ext: ["dxf"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#dr-analyze").disabled = true; $("#dr-result").innerHTML = ""; analysis = null; renderReview();
    stopTimer = startTimer(status, "Разбор чертежа… это может занять до минуты для больших файлов.");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("object_id", String(objectValue));
      const data = await api.upload("/import-dxf/analyze", fd);
      if (dead) return;
      const sec = stopTimer(); stopTimer = null;
      analysis = data;
      status.set(`Разбор готов за ${sec} с — проверьте сводку изменений. В базу пока ничего не записано.`, "ok");
      renderReview();
      $("#dr-review").scrollIntoView?.({ block: "nearest" });
    } catch (err) {
      if (dead) return;
      stopTimer?.(); stopTimer = null;
      status.set(`Разбор не удался: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#dr-analyze").disabled = false; }
  }

  const collectRefill = () => {
    const out = {};
    $("#dr-review").querySelectorAll("input[data-refill]:checked").forEach((cb) => {
      const [id, field] = cb.dataset.refill.split(":");
      (out[id] = out[id] || []).push(field);
    });
    return out;
  };

  // ---- применение
  async function apply() {
    if (busy || !analysis) return;
    busy = true; $("#dr-apply").disabled = true; $("#dr-cancel").disabled = true; $("#dr-analyze").disabled = true;
    let sentAt = null;
    const a = analysis, c = a.counts || {};
    try {
      const accept = $("#dr-accept-marks") ? $("#dr-accept-marks").checked : true;
      const refill = collectRefill();
      const newZones = [...$("#dr-review").querySelectorAll("input[data-newzone]:checked")].map((cb) => Number(cb.dataset.newzone));
      const ok = await showConfirmDialog(
        `Применить чертёж «${a.source_file}» к объекту «${a.object_name}»?\n\nГеометрия изделий объекта будет обновлена: сопоставлено ${(c.matched_by_handle || 0) + (c.matched_by_geometry || 0)}, новых ${c.new || 0}, исчезнет из чертежа ${c.retired || 0} (их статусы и история сохранятся).`
        + `${c.mark_changed ? `\nСмена марок: ${accept ? "будет принята" : "НЕ будет принята — марки останутся прежними"} (${c.mark_changed}).` : ""}`
        + `${Object.keys(refill).length ? `\nИз чертежа перезаполнятся ручные поля у ${Object.keys(refill).length} изделий.` : ""}`
        + `${newZones.length ? `\nНовых записей зон вместо правки: ${newZones.length}.` : ""}`
        + `\n\nПеред применением сервер сохранит копию базы. Загрузка идёт этапами (подтипы → изделия → оси → зоны) и, как в текущем интерфейсе, не является одной транзакцией: при сбое посреди загрузки завершённые этапы останутся записанными — тогда восстановите базу из копии.`,
        { confirmLabel: "Применить чертёж", multiline: true });
      if (!ok || dead) { if (!dead) status.set("Применение отменено — данные не изменены.", ""); return; }
      stopTimer = startTimer(status, "Применение чертежа… не закрывайте страницу.");
      sentAt = Date.now();
      const res = await api.post("/import-dxf/apply", {
        token: a.token, accept_mark_changes: accept, keep_mark_element_ids: [], refill_manual_fields: refill, create_new_zone_ids: newZones,
      });
      if (dead) return;
      const sec = stopTimer(); stopTimer = null;
      analysis = null; renderReview();
      const marks = Object.entries(res.by_mark_source || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      const axes = Object.entries(res.by_axis_status || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
      status.set(`Готово за ${sec} с: ${res.total} элементов (новых: ${res.inserted}, обновлено: ${res.updated}${res.retired ? `, исчезло: ${res.retired}` : ""}${res.marks_kept ? `, оставлено прежних марок: ${res.marks_kept}` : ""}${res.manual_kept ? `, сохранено ручных полей: ${res.manual_kept}` : ""}).`, "ok");
      $("#dr-result").innerHTML = factsHtml([
        ["Чертёж", esc(res.source_file)], ["Всего элементов", res.total], ["Новых", res.inserted], ["Обновлено", res.updated], ["Исчезло из чертежа", res.retired || ""],
        ["Сопоставлено по handle / по геометрии", `${res.matched_by_handle} / ${res.matched_by_geometry}`], ["Оставлено прежних марок", res.marks_kept || ""], ["Сохранено ручных полей", res.manual_kept || ""],
        ["Марки", esc(marks)], ["Адресация по осям", esc(axes)], ["Оси", `${res.axis_grid?.numeric ?? 0} числовых, ${res.axis_grid?.letter ?? 0} буквенных`],
        ["Зоны", res.zones ? `${res.zones.total ?? 0}` : ""],
      ]) + `<p class="v2-muted">Новый чертёж виден на схеме объекта («Модель: схема 2D/3D») и в текущем интерфейсе.</p>`;
    } catch (err) {
      if (dead) return;
      stopTimer?.(); stopTimer = null;
      if (err.blockedByPolicy) status.set(errText(err), "bad");
      else if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml("применение чертежа"), "bad");
        const box = $("#dr-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "import_dxf", entityId: a.object_id, sinceMs: sentAt || Date.now(), what: "применение чертежа" }));
      } else status.set(`Не выполнено: ${errText(err)}${/токен|устар|разбор/i.test(errText(err)) ? " Разберите чертёж заново." : ""}`, "bad");
    } finally {
      busy = false;
      if (!dead) { $("#dr-analyze").disabled = false; $("#dr-apply")?.removeAttribute("disabled"); $("#dr-cancel")?.removeAttribute("disabled"); }
    }
  }

  $("#dr-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  return {
    hasUnsavedChanges: () => !!analysis,
    async guardLeave() { return !analysis || (await showConfirmDialog("Разбор чертежа не применён — результат разбора будет потерян (в базу ничего не записано). Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; stopTimer?.(); },
  };
}
