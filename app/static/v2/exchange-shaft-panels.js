// Экран «Панели облицовки шахты» (shaft-panels) — разбор DXF конкретного профиля (ГП1/ГП2, оси 5–7/Е–Ж, app/shaft_panels/),
// сводка (панели по маркам, замечания к чертежу — каждое подтверждается флажком), применение по токену. Двухфазно, как чертёж
// DXF: analyze ничего не пишет, apply — одна транзакция (app/shaft_panels/storage.py). Токен принадлежит только тому, кто его
// получил (сервер проверяет user_id), поэтому явная отмена (DELETE /shaft-panels/pending/{token}) — при смене файла/объекта/
// толщины и при уходе с экрана: иначе занятое место в очереди токенов (лимит 8) держится 15 минут впустую.
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml, listHtml, objectOptions,
} from "./exchange-common.js";

export function mountShaftPanels(el, ctx) {
  const { screen, groupTitle, api, objects, objectId } = ctx;
  const zhbiObjects = (objects || []).filter((o) => o.kind !== "mfr"); // профиль работает только с объектами ЖБИ (app/shaft_panels/storage.analyze)
  let dead = false, busy = false, token = null, data = null, currentObjectId = zhbiObjects.some((o) => o.id === objectId) ? objectId : null;

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Выберите один DWG фасада СМ1 или DXF шахт ГП1/ГП2.",
    body: `<form id="sp-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Объект (ЖБИ)</span>
          <select id="sp-object" aria-label="Объект">${zhbiObjects.some((o) => o.id === currentObjectId) ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(zhbiObjects, currentObjectId)}</select></label>
        <label class="v2-wire-field v2-field-wide"><span>Файл развёртки (DWG или DXF)</span><input type="file" id="sp-file" accept=".dwg,.dxf"></label>
        <label class="v2-wire-field v2-field-wide"><span>Толщина панели, мм (по паспорту изделия)</span><input type="number" id="sp-thickness" min="1" max="500" step="0.1" placeholder="по проекту"></label>
        <div id="sp-offset-field" hidden><label class="v2-wire-field v2-field-wide"><span>Отступ внутренней грани наружу, мм</span>
          <input type="number" id="sp-offset" step="any" value="0"></label>
          <p class="v2-muted v2-ex-hint">От оси фасада. На косом участке — от линии центров колонн 36–38.</p></div>
        <p class="v2-muted v2-ex-hint" id="sp-section-hint">Для добавления в модель укажите толщину панели.</p>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="sp-analyze">Распознать</button><button type="button" class="v2-btn" id="sp-cancel">Отменить анализ</button></div>
      </form>
      <div id="sp-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="sp-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#sp-status"));
  function setBusy(value) {
    busy = value;
    $("#sp-form").querySelectorAll("input, select, button").forEach((field) => { field.disabled = value; });
  }

  async function cancelToken() {
    if (!token) return;
    const t = token; token = null;
    data = null;
    $("#sp-result")?.replaceChildren();
    try { await api.delete(`/shaft-panels/pending/${encodeURIComponent(t)}`); } catch (e) { /* истёк сам по TTL — не страшно */ }
  }

  function panelsTableHtml(panels) {
    const shown = panels.slice(0, 500);
    return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Марка</th><th>Фасад / сторона шахты</th><th>Ш × В, мм</th><th>Расположение</th></tr></thead><tbody>
      ${shown.map((p) => `<tr><td>${esc(p.mark)}</td><td>${p.shaft ? esc(p.shaft) + "/" : ""}${esc(p.face)}</td><td>${esc(p.width_mm)} × ${esc(p.height_mm)}</td><td>${esc(p.address)}</td></tr>`).join("")}
      </tbody></table></div>${panels.length > shown.length ? `<p class="v2-muted">Показаны первые ${shown.length} из ${panels.length}.</p>` : ""}`;
  }

  function render() {
    const box = $("#sp-result");
    if (!data) { box.innerHTML = ""; return; }
    const d = data.drawing;
    const parts = [factsHtml([["Панелей", d.panels.length], ["Марок", Object.keys(d.counts?.by_mark || {}).length], ["Сетка осей", data.grid_source]])];
    if (d.scope) {
      const section = d.section_layers_mm ? d.section_layers_mm.join(" + ") + " = " : "";
      parts.push(factsHtml([["Толщина панели", section + d.thickness_mm + " мм"]]));
    }
    parts.push(panelsTableHtml(d.panels));
    if (d.warnings.length) {
      parts.push(`<div class="v2-callout" role="note"><p><strong>Замечания к чертежу — подтвердите каждое:</strong></p>
        ${d.warnings.map((w) => `<label class="v2-wire-check"><input type="checkbox" data-warning="${esc(w.code)}"> ${esc(w.message)}</label>`).join("")}</div>`);
    }
    if (data.analysis) {
      const a = data.analysis;
      parts.push(factsHtml([["Добавить", a.counts.new], ["Обновить", a.counts.updated], ["Без изменений", a.counts.unchanged], ["Отсутствуют в новой версии", a.counts.missing]]));
      if (a.conflicts.length) parts.push(listHtml("Конфликты (применение недоступно, пока не разрешены в штатном редакторе)", a.conflicts.map((c) => `Элемент ${c.id}: ${c.reason}`)));
      parts.push(`<label class="v2-wire-check"><input type="checkbox" id="sp-retire"> Снять актуальность отсутствующих панелей (только эта развёртка)</label>`);
      parts.push(`<div class="v2-bar"><button type="button" class="v2-btn v2-primary" id="sp-apply" ${a.conflicts.length ? "disabled" : ""}>Добавить панели в объект</button></div>`);
    } else {
      parts.push(`<div class="v2-callout" role="note">Панели распознаны без записи объёмов. Укажите толщину панели и нажмите «Распознать» ещё раз, чтобы получить сводку для применения.</div>`);
    }
    box.innerHTML = parts.join("");
    box.querySelector("#sp-apply")?.addEventListener("click", apply);
  }

  async function analyze() {
    if (busy) return;
    const oid = Number($("#sp-object").value) || null;
    const file = $("#sp-file").files[0];
    const thicknessRaw = $("#sp-thickness").value;
    const thickness = Number(thicknessRaw);
    let problem = !oid ? "Сначала выберите объект" : checkFile(file, { ext: ["dxf", "dwg"] });
    if (!problem && thicknessRaw && (!Number.isFinite(thickness) || thickness <= 0)) problem = "Толщина должна быть положительным числом";
    if (!problem && !isFacade() && thickness > 500) problem = "Толщина панели шахты не должна превышать 500 мм";
    if (problem) { status.set(problem, "bad"); return; }
    setBusy(true); status.set("Распознавание…", "busy");
    try {
      await cancelToken();
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("object_id", String(oid));
      if (isFacade()) fd.append("facade_offset_mm", $("#sp-offset").value || "0");
      if (thicknessRaw) fd.append("thickness_mm", thicknessRaw);
      const res = await api.upload("/shaft-panels/analyze", fd);
      if (dead) { try { await api.delete(`/shaft-panels/pending/${encodeURIComponent(res.token)}`); } catch (e) {} return; }
      token = res.token; data = res; currentObjectId = oid;
      status.set(data.analysis ? "Панели распознаны — проверьте сводку перед применением." : "Панели распознаны без объёмов. Укажите толщину и повторите анализ.", "ok");
      render();
    } catch (err) {
      if (dead) return;
      status.set(`Не удалось распознать: ${errText(err)}`, "bad");
    } finally { if (!dead) setBusy(false); }
  }

  async function apply() {
    if (busy || !token || !data?.analysis) return;
    const checks = [...el.querySelectorAll("[data-warning]")];
    if (checks.some((c) => !c.checked)) { status.set("Подтвердите все замечания к чертежу флажками.", "bad"); return; }
    if (data.analysis.conflicts.length) return;
    setBusy(true); $("#sp-result").querySelectorAll("button, input").forEach((n) => (n.disabled = true));
    let sentAt = null;
    try {
      const retireMissing = !!$("#sp-retire")?.checked;
      const c = data.analysis.counts;
      const ok = await showConfirmDialog(
        `Добавить панели этой развёртки в объект?\n\nДобавить: ${c.new}; обновить: ${c.updated}; без изменений: ${c.unchanged}${retireMissing ? `; снять актуальность: ${c.missing}` : ""}.\nПеред применением сервер сохранит копию базы; применение выполняется одной операцией.`,
        { confirmLabel: "Применить", multiline: true },
      );
      if (!ok || dead) { if (!dead) status.set("Применение отменено — ничего не изменено.", ""); return; }
      status.set("Применяем…", "busy");
      sentAt = Date.now();
      const res = await api.post("/shaft-panels/apply", { token, acknowledged_warnings: checks.map((c2) => c2.dataset.warning), retire_missing: retireMissing });
      if (dead) return;
      status.set(`Готово. Добавлено ${res.new}, обновлено ${res.updated}${res.retired ? `, снята актуальность у ${res.retired}` : ""}.`, "ok");
      $("#sp-result").innerHTML = factsHtml([["Добавлено", res.new], ["Обновлено", res.updated], ["Без изменений", res.unchanged], ["Снята актуальность", res.retired || 0]]);
      token = null; data = null;
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) { status.set(errText(err), "bad"); return; }
      if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml("применение панелей развёртки"), "bad");
        const box = $("#sp-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "import_dxf", entityId: currentObjectId, sinceMs: sentAt || Date.now(), what: "применение панелей развёртки" }));
        token = null; // потерянный ответ: токен либо уже применён (второй раз сервер откажет), либо истёк — новый анализ безопаснее повторной попытки тем же токеном
      } else status.set(`Не удалось применить: ${errText(err)}`, "bad");
    } finally { if (!dead) { setBusy(false); if (data) render(); } }
  }

  $("#sp-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#sp-cancel").addEventListener("click", async () => { if (busy) return; await cancelToken(); status.set("Анализ отменён.", ""); });
  const isFacade = () => /\.dwg$/i.test($("#sp-file").files[0]?.name || "");
  let facadeSelected = false;
  $("#sp-file").addEventListener("change", () => {
    if (isFacade() !== facadeSelected) $("#sp-thickness").value = isFacade() ? "440" : "";
    facadeSelected = isFacade();
    $("#sp-section-hint").textContent = facadeSelected ? "По разрезу 2–2 слои панели составляют 100, 150 и 190 мм." : "Для добавления в модель укажите толщину панели.";
    $("#sp-offset-field").hidden = !isFacade();
    $("#sp-thickness").max = isFacade() ? "" : "500";
  });
  for (const id of ["#sp-file", "#sp-thickness", "#sp-offset", "#sp-object"]) {
    $(id).addEventListener("change", async () => { if (busy || !token) return; await cancelToken(); status.set("Параметры изменились — повторите анализ.", ""); });
  }

  return {
    hasUnsavedChanges: () => !!data?.analysis,
    async guardLeave() {
      if (!data?.analysis) return true;
      const leave = await showConfirmDialog("Сводка загрузки панелей не применена — результат будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" });
      if (leave) await cancelToken();
      return leave;
    },
    destroy() { dead = true; cancelToken().catch(() => {}); },
  };
}
