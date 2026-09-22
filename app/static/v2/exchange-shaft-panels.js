// Экран «Панели облицовки шахты» (shaft-panels) — разбор DXF конкретного профиля (ГП1/ГП2, оси 5–7/Е–Ж, app/shaft_panels/),
// сводка (панели по маркам, замечания к чертежу — каждое подтверждается флажком), применение по токену. Двухфазно, как чертёж
// DXF: analyze ничего не пишет, apply — одна транзакция (app/shaft_panels/storage.py). Токен принадлежит только тому, кто его
// получил (сервер проверяет user_id), поэтому явная отмена (DELETE /shaft-panels/pending/{token}) — при смене файла/объекта/
// толщины и при уходе с экрана: иначе занятое место в очереди токенов (лимит 8) держится 15 минут впустую.
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml, listHtml, objectOptions,
} from "./exchange-common.js";

export function mountShaftPanels(el, ctx) {
  const { screen, groupTitle, api, objects, objectId } = ctx;
  const zhbiObjects = (objects || []).filter((o) => o.kind !== "mfr"); // профиль работает только с объектами ЖБИ (app/shaft_panels/storage.analyze)
  let dead = false, busy = false, token = null, data = null, currentObjectId = zhbiObjects.some((o) => o.id === objectId) ? objectId : null;

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Развёртки ГП1/ГП2 (профиль конкретного комплекта чертежей): распознавание панелей по осям 5–7/Е–Ж выбранного объекта, сводка, применение.",
    body: `<form id="sp-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Объект (ЖБИ)</span>
          <select id="sp-object" aria-label="Объект">${zhbiObjects.some((o) => o.id === currentObjectId) ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(zhbiObjects, currentObjectId)}</select></label>
        <label class="v2-wire-field v2-field-wide"><span>Файл чертежа (DXF)</span><input type="file" id="sp-file" accept=".dxf"></label>
        <label class="v2-wire-field"><span>Толщина панели, мм (по паспорту изделия)</span><input type="number" id="sp-thickness" min="1" max="500" step="0.1" placeholder="необязательно"></label>
        <p class="v2-muted v2-ex-hint">Без толщины доступно только распознавание лицевых поверхностей (панели видны в таблице), но объёмы и применение — только с толщиной.</p>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="sp-analyze">Распознать</button><button type="button" class="v2-btn" id="sp-cancel">Отменить анализ</button></div>
      </form>
      <div id="sp-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="sp-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#sp-status"));

  async function cancelToken(silent) {
    if (!token) return;
    const t = token; token = null;
    try { await api.delete(`/shaft-panels/pending/${encodeURIComponent(t)}`); } catch (e) { /* истёк сам по TTL — не страшно */ }
    if (!silent) { data = null; $("#sp-result").innerHTML = ""; }
  }

  function panelsTableHtml(panels) {
    const shown = panels.slice(0, 500);
    return `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Марка</th><th>Шахта / сторона</th><th>Ш × В, мм</th><th>Расположение</th></tr></thead><tbody>
      ${shown.map((p) => `<tr><td>${esc(p.mark)}</td><td>${esc(p.shaft)}/${esc(p.face)}</td><td>${esc(p.width_mm)} × ${esc(p.height_mm)}</td><td>${esc(p.address)}</td></tr>`).join("")}
      </tbody></table></div>${panels.length > shown.length ? `<p class="v2-muted">Показаны первые ${shown.length} из ${panels.length}.</p>` : ""}`;
  }

  function render() {
    const box = $("#sp-result");
    if (!data) { box.innerHTML = ""; return; }
    const d = data.drawing;
    const parts = [factsHtml([["Панелей", d.panels.length], ["Марок", Object.keys(d.counts?.by_mark || {}).length], ["Сетка осей", data.grid_source]])];
    parts.push(panelsTableHtml(d.panels));
    if (d.warnings.length) {
      parts.push(`<div class="v2-callout" role="note"><p><strong>Замечания к чертежу — подтвердите каждое:</strong></p>
        ${d.warnings.map((w) => `<label class="v2-wire-check"><input type="checkbox" data-warning="${esc(w.code)}"> ${esc(w.message)}</label>`).join("")}</div>`);
    }
    if (data.analysis) {
      const a = data.analysis;
      parts.push(factsHtml([["Добавить", a.counts.new], ["Обновить", a.counts.updated], ["Без изменений", a.counts.unchanged], ["Отсутствуют в новой версии", a.counts.missing]]));
      if (a.conflicts.length) parts.push(listHtml("Конфликты (применение недоступно, пока не разрешены в штатном редакторе)", a.conflicts.map((c) => `Элемент ${c.id}: ${c.reason}`)));
      parts.push(`<label class="v2-wire-check"><input type="checkbox" id="sp-retire"> Снять актуальность отсутствующих панелей (только область ГП1/ГП2; история сохраняется)</label>`);
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
    const problem = !oid ? "Сначала выберите объект" : checkFile(file, { ext: ["dxf"] })
      || (thicknessRaw && (!(Number(thicknessRaw) > 0) || Number(thicknessRaw) > 500) ? "Толщина должна быть больше 0 и не больше 500 мм" : null);
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#sp-analyze").disabled = true; status.set("Распознавание…", "busy");
    try {
      await cancelToken(true);
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("object_id", String(oid));
      if (thicknessRaw) fd.append("thickness_mm", thicknessRaw);
      const res = await api.upload("/shaft-panels/analyze", fd);
      if (dead) { try { await api.delete(`/shaft-panels/pending/${encodeURIComponent(res.token)}`); } catch (e) {} return; }
      token = res.token; data = res; currentObjectId = oid;
      status.set(data.analysis ? "Панели распознаны — проверьте сводку перед применением." : "Панели распознаны без объёмов. Укажите толщину и повторите анализ.", "ok");
      render();
    } catch (err) {
      if (dead) return;
      status.set(`Не удалось распознать: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#sp-analyze").disabled = false; }
  }

  async function apply() {
    if (busy || !token || !data?.analysis) return;
    const checks = [...el.querySelectorAll("[data-warning]")];
    if (checks.some((c) => !c.checked)) { status.set("Подтвердите все замечания к чертежу флажками.", "bad"); return; }
    if (data.analysis.conflicts.length) return;
    busy = true; $("#sp-result").querySelectorAll("button, input").forEach((n) => (n.disabled = true));
    let sentAt = null;
    try {
      const retireMissing = !!$("#sp-retire")?.checked;
      const c = data.analysis.counts;
      const ok = await showConfirmDialog(
        `Добавить панели облицовки шахты в объект?\n\nДобавить: ${c.new}; обновить: ${c.updated}; без изменений: ${c.unchanged}${retireMissing ? `; снять актуальность: ${c.missing}` : ""}.\nПеред применением сервер сохранит копию базы; применение выполняется одной операцией.`,
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
        status.html(unknownOutcomeHtml("применение панелей облицовки шахты"), "bad");
        const box = $("#sp-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "import_dxf", entityId: currentObjectId, sinceMs: sentAt || Date.now(), what: "применение панелей облицовки шахты" }));
        token = null; // потерянный ответ: токен либо уже применён (второй раз сервер откажет), либо истёк — новый анализ безопаснее повторной попытки тем же токеном
      } else status.set(`Не удалось применить: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) render(); }
  }

  $("#sp-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#sp-cancel").addEventListener("click", async () => { if (busy) return; await cancelToken(); status.set("Анализ отменён.", ""); });
  for (const id of ["#sp-file", "#sp-thickness", "#sp-object"]) {
    $(id).addEventListener("change", async () => { if (busy || !token) return; await cancelToken(); status.set("Параметры изменились — повторите анализ.", ""); });
  }

  return {
    hasUnsavedChanges: () => !!data?.analysis,
    async guardLeave() {
      if (!data?.analysis) return true;
      const leave = await showConfirmDialog("Сводка панелей облицовки шахты не применена — результат будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" });
      if (leave) await cancelToken(true);
      return leave;
    },
    destroy() { dead = true; cancelToken(true).catch(() => {}); },
  };
}
