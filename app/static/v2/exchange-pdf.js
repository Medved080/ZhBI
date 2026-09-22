// Экран «Загрузить из PDF» (pdf-import) — тот же жёсткий профиль чертежей, что и в V1 (app/pdf_rooms.py, app/pdf_import.py,
// app/pdf_facade_import.py): «Полный разбор» (фоновая задача с прогрессом — сама тяжёлая часть, ~30с на реальном комплекте, не
// умещается в один запрос) и «Только фасады» (синхронно, секунды — макет блоков без начинки). Обе ветки — двухфазные: разбор
// (в БД не пишет) → сводка → применение по токену. Плюс отладочный инструмент очистки справочников (тот же, что у Revit).
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml, listHtml, objectOptions,
} from "./exchange-common.js";

const MFR_KIND = "mfr"; // помещения/блоки из PDF пишутся в revit_elements объекта МФР (та же модель, что у Revit-выгрузки)

export function mountPdfImport(el, ctx) {
  const { screen, groupTitle, api, objects, objectId, rights } = ctx;
  const mfrObjects = (objects || []).filter((o) => o.kind === MFR_KIND);
  let dead = false, busy = false, pending = null, pendingMode = "full", currentObjectId = mfrObjects.some((o) => o.id === objectId) ? objectId : (mfrObjects[0]?.id ?? null);

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Комплект чертежей жёстко привязан к одному объекту (имена слоёв и разбивка листов на этажи — соглашение конкретного архитектора). Даёт контуры и площади помещений; стен с толщиной, проёмов и номеров квартир — не даёт.",
    body: `<form id="pf-form" autocomplete="off" novalidate>
        <fieldset class="v2-fieldset"><legend>Что разобрать</legend>
          <label class="v2-wire-check"><input type="radio" name="pf-mode" value="full" checked> Полный разбор — помещения, стены, окна</label>
          <label class="v2-wire-check"><input type="radio" name="pf-mode" value="facade"> Только фасады — макет блоков без начинки</label>
          <p class="v2-muted v2-ex-hint">Только фасады: блок «этаж×секция» строится по ступенчатому силуэту на фасадных чертежах (высота + ширина/глубина), без разбора помещений/стен — быстрее, но внутри блока ничего не будет, кроме габарита.</p>
        </fieldset>
        <label class="v2-wire-field v2-field-wide"><span>Объект (МФР)</span>
          <select id="pf-object" aria-label="Объект">${mfrObjects.some((o) => o.id === currentObjectId) ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(mfrObjects, currentObjectId)}</select></label>
        <label class="v2-wire-field v2-field-wide"><span>Файл .pdf</span><input type="file" id="pf-file" accept=".pdf"></label>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="pf-go">Разобрать</button></div>
      </form>
      <div id="pf-progress" style="display:none; margin-top:10px"><div style="height:8px; border-radius:4px; background:var(--muted-bg, #e5e7eb); overflow:hidden"><div id="pf-progress-bar" style="height:100%; width:0%; background:var(--accent, #1353d6); transition:width .3s"></div></div></div>
      <div id="pf-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="pf-review"></div>
      <details class="v2-collapsible" id="pf-clear-details" style="margin-top:14px">
        <summary>Очистить справочники объекта перед загрузкой (отладка)</summary>
        <div class="v2-callout v2-callout-bad" role="note">Стирает отмеченное СРАЗУ, без сводки для проверки. Перед стиранием сервер снимает резервную копию.</div>
        <label class="v2-wire-check"><input type="checkbox" id="pf-clear-elements"> Помещения из PDF на этом объекте</label>
        <label class="v2-wire-check"><input type="checkbox" id="pf-clear-structure"> Секции и этажи объекта</label>
        <p class="v2-muted v2-ex-hint">Общие с «Учётом по блокам»: удаление каскадом сотрёт и блоки, и проставленные по ним статусы работ.</p>
        <label class="v2-wire-check"><input type="checkbox" id="pf-clear-work"> Виды работ и статусы блоков</label>
        <div class="v2-bar"><button type="button" class="v2-btn v2-danger" id="pf-clear-go">Очистить отмеченное</button></div>
        <div id="pf-clear-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      </details>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#pf-status"));
  const mode = () => el.querySelector('input[name="pf-mode"]:checked').value;

  function setProgress(fraction) {
    const wrap = $("#pf-progress");
    if (fraction === null) { wrap.style.display = "none"; return; }
    wrap.style.display = ""; $("#pf-progress-bar").style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  async function pollJob(jobId) {
    for (;;) {
      if (dead) throw new Error("страница закрыта");
      const body = await api.get(`/import-pdf/analyze/progress/${jobId}`);
      if (body.status === "done") return body.result;
      if (body.total) {
        const stageBase = body.stage === "Разбираю стены и перекрытия" ? 0.5 : (body.stage === "Снимаю картинки планов" ? 1 : 0);
        setProgress(stageBase + (body.total ? (body.page / body.total) * (body.stage === "Снимаю картинки планов" ? 0 : 0.5) : 0));
        status.set(`${body.stage}: лист №${body.page_number ?? "?"} (${body.page} из ${body.total})…`, "busy");
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  function renderFullReview(data) {
    const floors = Object.keys(data.by_floor || {});
    const rows = floors.map((f) => `<tr><td>${esc(f)}</td><td>${data.by_floor[f]["помещений"]}</td><td>${data.by_floor[f]["с площадью"]}</td></tr>`).join("");
    return `${factsHtml([
        ["Объект", data.object_name], ["Помещений в файле", data.total_rooms], ["Стен/перегородок", data.total_walls],
        ["Окон", data.total_windows], ["Плит перекрытия", data.total_slabs],
      ])}
      ${listHtml("Предупреждения", data.warnings)}
      <h4>Что изменится</h4>${factsHtml([["Новых помещений", data.new], ["Без изменений", data.unchanged], ["Исчезло из чертежа (будет списано)", data.retiring || 0]])}
      <h4>По этажам</h4><div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Этаж</th><th>Помещений</th><th>С площадью</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function renderFacadeReview(data) {
    const floors = Object.keys(data.by_floor || {});
    const rows = floors.map((f) => {
      const sections = data.by_floor[f];
      const dims = Object.entries(sections).map(([code, s]) => `${esc(code)}: ${s["ширина_мм"]}×${s["глубина_мм"]}мм`).join(", ");
      return `<tr><td>${esc(f)}</td><td>${dims}</td></tr>`;
    }).join("");
    return `${factsHtml([["Объект", data.object_name], ["Блоков в файле", data.total_blocks], ["Этажей", data.total_floors]])}
      <div class="v2-callout" role="note">Только габарит блока (ширина×глубина) — без помещений, стен и окон. Секции и этажи заводятся, если их ещё нет; уже существующий блок получит эту геометрию поверх прежней.</div>
      <h4>По этажам</h4><div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Этаж</th><th>Секции — ширина×глубина</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function analyze() {
    if (busy) return;
    const oid = Number($("#pf-object").value) || null;
    const file = $("#pf-file").files[0];
    const problem = !oid ? "Сначала выберите объект" : checkFile(file, { ext: ["pdf"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#pf-go").disabled = true; $("#pf-review").innerHTML = ""; pending = null;
    const facade = mode() === "facade";
    try {
      const fd = new FormData();
      fd.append("file", file, file.name); fd.append("object_id", String(oid));
      if (facade) {
        status.set("Разбираю фасады…", "busy"); setProgress(null);
        const res = await api.upload("/import-pdf-facade/analyze", fd);
        if (dead) return;
        pending = res; pendingMode = "facade"; currentObjectId = oid;
        status.set("Разбор готов — проверьте сводку.", "ok");
        $("#pf-review").innerHTML = renderFacadeReview(res) + applyBarHtml();
        wireApplyBar();
        return;
      }
      status.set("Отправляю файл…", "busy"); setProgress(0);
      const start = await api.upload("/import-pdf/analyze/start", fd);
      if (dead) return;
      status.set("Разбираю чертёж…", "busy");
      const res = await pollJob(start.job_id);
      if (dead) return;
      setProgress(1);
      pending = res; pendingMode = "full"; currentObjectId = oid;
      status.set("Разбор готов — проверьте сводку.", "ok");
      $("#pf-review").innerHTML = renderFullReview(res) + applyBarHtml();
      wireApplyBar();
    } catch (err) {
      if (dead) return;
      setProgress(null);
      status.set(`Не удалось разобрать: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#pf-go").disabled = false; }
  }

  function applyBarHtml() {
    return `<div class="v2-bar v2-ex-stickybar"><button type="button" class="v2-btn v2-primary" id="pf-apply">Применить</button><button type="button" class="v2-btn" id="pf-discard">Отменить</button></div>`;
  }
  function wireApplyBar() {
    $("#pf-apply")?.addEventListener("click", apply);
    $("#pf-discard")?.addEventListener("click", () => { pending = null; $("#pf-review").innerHTML = ""; status.set("Сверка отменена — ничего не изменено.", ""); });
  }

  async function apply() {
    if (busy || !pending) return;
    busy = true; el.querySelectorAll("#pf-review button").forEach((b) => (b.disabled = true));
    let sentAt = null;
    const facade = pendingMode === "facade";
    try {
      const msg = facade
        ? `Применить макет блоков (${pending.total_blocks} блоков на ${pending.total_floors} этажах) в объект «${pending.object_name}»?\n\nПеред применением сервер сохранит копию базы.`
        : `Применить помещения из PDF (новых ${pending.new}, без изменений ${pending.unchanged}${pending.retiring ? `, будет списано ${pending.retiring}` : ""}) в объект «${pending.object_name}»?\n\nПеред применением сервер сохранит копию базы.`;
      const ok = await showConfirmDialog(msg, { confirmLabel: "Применить", multiline: true });
      if (!ok || dead) { if (!dead) { status.set("Применение отменено — ничего не изменено.", ""); el.querySelectorAll("#pf-review button").forEach((b) => (b.disabled = false)); } return; }
      status.set("Применяем…", "busy");
      sentAt = Date.now();
      const res = await api.post(facade ? "/import-pdf-facade/apply" : "/import-pdf/apply", { token: pending.token });
      if (dead) return;
      const text = facade
        ? `Готово: блоков ${res.blocks_written} на ${res.floors} этажах, секций ${res.sections}.`
        : `Готово: помещений ${res.rooms_written}, стен/перегородок ${res.walls_written}, окон ${res.windows_written}, плит ${res.slabs_written}, списано ${res.retired}.`;
      status.set(text, "ok");
      $("#pf-review").innerHTML = facade
        ? factsHtml([["Блоков", res.blocks_written], ["Этажей", res.floors], ["Секций", res.sections]])
        : factsHtml([["Помещений", res.rooms_written], ["Стен/перегородок", res.walls_written], ["Окон", res.windows_written], ["Плит", res.slabs_written], ["Списано", res.retired]]);
      pending = null; setProgress(null);
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) { status.set(errText(err), "bad"); return; }
      if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml(facade ? "применение блоков из PDF" : "применение помещений из PDF"), "bad");
        const box = $("#pf-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: facade ? "import_pdf_facade" : "import_pdf", entityId: currentObjectId, sinceMs: sentAt || Date.now(), what: "применение из PDF" }));
      } else status.set(`Не удалось применить: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) el.querySelectorAll("#pf-review button").forEach((b) => (b.disabled = false)); }
  }

  async function runClear() {
    const oid = currentObjectId || Number($("#pf-object").value) || null;
    if (!oid) { $("#pf-clear-status").textContent = "Сначала выберите объект."; return; }
    const body = { source: "pdf", elements: $("#pf-clear-elements").checked, structure: $("#pf-clear-structure").checked, work: $("#pf-clear-work").checked };
    if (!(body.elements || body.structure || body.work)) { $("#pf-clear-status").textContent = "Отметьте хотя бы одну группу для очистки."; return; }
    const what = [body.elements && "помещения из PDF", body.structure && "секции и этажи", body.work && "виды работ и статусы блоков"].filter(Boolean).join(", ");
    const ok = await showConfirmDialog(`Очистить у объекта: ${what}?\n\nЭто необратимо через интерфейс (кроме восстановления из резервной копии, которую сервер снимет перед очисткой). Сводки «что изменится» здесь нет — стирается сразу.`, { confirmLabel: "Очистить", danger: true, multiline: true });
    if (!ok) return;
    const btn = $("#pf-clear-go"); btn.disabled = true;
    $("#pf-clear-status").textContent = "Очищаем…";
    try {
      const res = await api.post(`/objects/${oid}/clear-import-data`, body);
      $("#pf-clear-status").textContent = `Готово: ${Object.entries(res.counts || {}).map(([k, v]) => `${k} — ${v}`).join(", ") || "нечего было чистить"}.`;
    } catch (err) {
      $("#pf-clear-status").textContent = err.blockedByPolicy ? errText(err) : `Не удалось очистить: ${errText(err)}`;
    } finally { btn.disabled = false; }
  }

  $("#pf-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#pf-clear-go").addEventListener("click", runClear);

  return {
    hasUnsavedChanges: () => !!pending,
    async guardLeave() { return !pending || (await showConfirmDialog("Сверка из PDF не применена — результат будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; },
  };
}
