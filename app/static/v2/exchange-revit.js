// «Загрузить из Revit» в V2: пакеты выгрузки разделов (.zhbi.json.gz / .json) → разбор → сводка → применение. Те же эндпоинты, что у V1:
// `POST /import-revit/analyze` (пакеты + объект; в БД ничего не пишет) и `POST /import-revit/apply` (токен разбора).
//
// Семантика V1: объект выбирается ЯВНО (имена моделей меняются между выдачами, угадывать объект нельзя); «исчезло из модели» считается строго
// внутри раздела пакета; сводка показывает, что приехало, что изменится, что появится в справочниках, качество данных и план контуров
// (серым — что уже в объекте, цветом — новое). Применение идёт этапами (справочники → элементы → секции по геометрии), как в V1, после
// копии базы; токен применяется один раз. Отладочная очистка справочников объекта («Стереть безвозвратно» в форме V1) в V2 не переносится.
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, fmtSize, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, objectOptions, factsHtml, MAX_UPLOAD_MB,
} from "./exchange-common.js";

const MAX_FILES = 12;

function countLine(label, value, danger) {
  return value ? `<div class="${danger ? "v2-bad-text" : ""}"><b>${value}</b> — ${esc(label)}</div>` : "";
}

// План контуров одной строкой path на группу (полторы тысячи отдельных <polygon> тормозят раскладку).
function previewSvg(preview) {
  const boxes = [preview?.incoming?.bbox, preview?.existing?.bbox].filter(Boolean);
  if (!boxes.length) return "";
  const minX = Math.min(...boxes.map((b) => b[0])), minY = Math.min(...boxes.map((b) => b[1]));
  const maxX = Math.max(...boxes.map((b) => b[2])), maxY = Math.max(...boxes.map((b) => b[3]));
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const path = (outlines) => outlines.map((o) => "M" + o.map((p) => `${(p[0] - minX).toFixed(0)} ${(maxY - p[1]).toFixed(0)}`).join("L") + "Z").join("");
  const was = preview.existing.outlines.length ? `<path d="${path(preview.existing.outlines)}" fill="none" stroke="var(--muted)" stroke-width="${w / 500}" opacity="0.55"/>` : "";
  const now = `<path d="${path(preview.incoming.outlines)}" fill="none" stroke="var(--accent)" stroke-width="${w / 350}"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" class="v2-ex-preview" role="img" aria-label="План контуров: серым — что уже в объекте, цветом — новое">${was}${now}</svg>`;
}

export function mountRevitImport(el, ctx) {
  const { screen, groupTitle, api, objects, objectId } = ctx;
  let dead = false, busy = false;
  let picked = [];            // накопленные пакеты (каждый новый выбор в диалоге браузера заменил бы прежний)
  let analysis = null;
  const objectById = new Map((objects || []).map((o) => [o.id, o]));

  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle, summary: "Загрузка пакетов выгрузки из Revit (по одному пакету на раздел проекта) в выбранный объект: разбор, сводка, применение.",
    body: `<form id="rv-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Объект</span>
          <select id="rv-object" aria-label="Объект">${objectById.has(objectId) ? "" : `<option value="" selected>— выберите объект —</option>`}${objectOptions(objects, objectId, { withKind: true })}</select></label>
        <p class="v2-muted v2-ex-hint">Объект выбирается явно: имена моделей меняются между выдачами, и угадывать объект по ним нельзя.</p>
        <label class="v2-wire-field v2-field-wide"><span>Пакеты выгрузки (.zhbi.json.gz или .json) — можно добавлять по одному</span><input type="file" id="rv-file" accept=".gz,.json" multiple></label>
        <div id="rv-list" class="v2-ex-filelist"></div>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="rv-analyze">Разобрать пакеты</button></div>
      </form>
      <div id="rv-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="rv-review"></div>
      <div id="rv-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#rv-status"));

  function renderList() {
    $("#rv-list").innerHTML = picked.length
      ? picked.map((f, i) => `<div>• ${esc(f.name)} <span class="v2-muted">${fmtSize(f.size)}</span> <button type="button" class="v2-link-btn" data-drop="${i}" aria-label="Убрать ${esc(f.name)}">убрать</button></div>`).join("")
      : `<span class="v2-muted">Пакеты не выбраны</span>`;
  }
  renderList();
  $("#rv-file").addEventListener("change", (e) => {
    for (const f of Array.from(e.target.files || [])) if (!picked.some((x) => x.name === f.name && x.size === f.size)) picked.push(f);
    e.target.value = "";
    renderList();
  });
  $("#rv-list").addEventListener("click", (e) => { const b = e.target.closest("[data-drop]"); if (b && !busy) { picked.splice(Number(b.dataset.drop), 1); renderList(); } });

  function problem() {
    if (!Number($("#rv-object").value)) return "Сначала выберите объект";
    if (!picked.length) return "Сначала выберите хотя бы один пакет";
    if (picked.length > MAX_FILES) return `Не больше ${MAX_FILES} пакетов за раз`;
    for (const f of picked) {
      if (!/\.(gz|json)$/i.test(f.name)) return `«${f.name}»: нужен файл .gz или .json`;
      if (f.size === 0) return `Файл «${f.name}» пуст`;
      if (f.size > MAX_UPLOAD_MB * 1024 * 1024) return `Файл «${f.name}» больше ${MAX_UPLOAD_MB} МБ — сервер такой не примет`;
    }
    return null;
  }

  function renderReview() {
    const box = $("#rv-review");
    if (!analysis) { box.innerHTML = ""; return; }
    const a = analysis, c = a.elements?.counts || {}, sec = a.sections || {}, lv = a.levels || {};
    const pk = (a.packages || []).map((p) => `<tr><td>${esc(p["раздел"] || "")}</td><td>${esc(p["модель"] || "")}</td><td>${esc(p["дата"] || "")}</td><td class="num">${p["элементов"]}</td><td class="num">${p["помещений"]}</td></tr>`).join("");
    box.innerHTML = `<div class="v2-callout" role="region" aria-label="Сводка изменений">
      <p>Объект «${esc(a.object_name)}» · разделов ${(a.packages || []).length}${(a.known_sections || []).length ? ` · уже загружено: ${a.known_sections.map((k) => `${esc(k["раздел"])} (${k["элементов"]} эл.)`).join(", ")}` : ""}</p>
      ${(a.warnings || []).length ? `<div class="v2-callout v2-callout-bad"><b>Предупреждения</b>${a.warnings.map((w) => `<div>• ${esc(w)}</div>`).join("")}</div>` : ""}
      <h4>Что приехало</h4>
      <div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Раздел</th><th>Модель</th><th>Выгружено</th><th class="num">Элементов</th><th class="num">Помещений</th></tr></thead><tbody>${pk}</tbody></table></div>
      <h4>Что изменится</h4>
      ${countLine("новых элементов", c["новых"])}${countLine("изменившихся", c["изменённых"])}${countLine("без изменений", c["без изменений"])}
      ${countLine("исчезло из модели — будут списаны", c["исчезло из модели"], true)}${countLine("помещений", c["помещений"])}${countLine("квартир", c["квартир"])}
      <h4>Справочники</h4>
      ${countLine("новых секций: " + (sec["new"] || []).join(", "), (sec["new"] || []).length)}${countLine("новых этажей", (lv["new"] || []).length)}
      ${(lv["elevation_gaps"] || []).map((g) => `<div class="v2-bad-text">• ${esc(g["этаж"])}: разброс отметок ${g["разброс_мм"]} мм — отметке верить нельзя</div>`).join("")}
      <h4>Качество данных</h4>
      ${c["без секции"] ? `<div><b>${c["без секции"]}</b> — элементов без секции в модели; большинству она определится по геометрии при применении, остаток будет назван в итоге</div>` : ""}
      ${c["контур габаритный"] ? `<div><b>${c["контур габаритный"]}</b> — контур габаритный, а не настоящий. У дверей, окон и откосов это норма: они плоские вставки в стену</div>` : ""}
      <h4>План контуров</h4>
      <p class="v2-muted">Серым — то, что уже в объекте, цветом — новое. Разделы обязаны стоять в общих координатах: если новое лежит в стороне от старого, выгрузка сделана не в тех координатах, и применять её нельзя.</p>
      ${previewSvg(a.elements?.preview)}
      <div class="v2-bar v2-ex-stickybar"><button type="button" class="v2-btn v2-primary" id="rv-apply">Применить</button><button type="button" class="v2-btn" id="rv-cancel">Отменить разбор</button></div>
    </div>`;
    $("#rv-apply").addEventListener("click", apply);
    $("#rv-cancel").addEventListener("click", () => { analysis = null; renderReview(); status.set("Разбор отменён — данные не изменены.", ""); });
  }

  async function analyze() {
    if (busy) return;
    const p = problem();
    if (p) { status.set(p, "bad"); return; }
    busy = true; $("#rv-analyze").disabled = true; $("#rv-result").innerHTML = ""; analysis = null; renderReview();
    status.set("Разбор пакетов… на большой модели это может занять до минуты.", "busy");
    try {
      const fd = new FormData();
      fd.append("object_id", String(Number($("#rv-object").value)));
      for (const f of picked) fd.append("files", f, f.name);
      const data = await api.upload("/import-revit/analyze", fd);
      if (dead) return;
      analysis = data;
      status.set("Разбор готов — проверьте сводку. В базу пока ничего не записано.", "ok");
      renderReview();
    } catch (err) {
      if (dead) return;
      status.set(`Разбор не удался: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#rv-analyze").disabled = false; }
  }

  async function apply() {
    if (busy || !analysis) return;
    busy = true; $("#rv-apply").disabled = true; $("#rv-cancel").disabled = true; $("#rv-analyze").disabled = true;
    let sentAt = null;
    const a = analysis, c = a.elements?.counts || {};
    try {
      const ok = await showConfirmDialog(
        `Применить выгрузку Revit (${(a.packages || []).map((p) => p["раздел"]).join(", ")}) к объекту «${a.object_name}»?\n\nНовых элементов: ${c["новых"] || 0}, изменившихся: ${c["изменённых"] || 0}, будет списано как исчезнувших из модели: ${c["исчезло из модели"] || 0} (только внутри разделов пакетов).`
        + `\n\nПеред применением сервер сохранит копию базы. Применение идёт этапами (справочники → элементы → секции по геометрии) и, как в текущем интерфейсе, не является одной транзакцией: при сбое посреди загрузки завершённые этапы останутся — тогда восстановите базу из копии.`,
        { confirmLabel: "Применить выгрузку", multiline: true, danger: !!c["исчезло из модели"] });
      if (!ok || dead) { if (!dead) status.set("Применение отменено — данные не изменены.", ""); return; }
      status.set("Применение… не закрывайте страницу.", "busy");
      sentAt = Date.now();
      const res = await api.post("/import-revit/apply", { token: a.token });
      if (dead) return;
      analysis = null; renderReview(); picked = []; renderList();
      status.set(`Готово: элементов ${res.elements}, помещений ${res.rooms}, квартир ${res.flats}, списано ${res.retired}.`, "ok");
      $("#rv-result").innerHTML = factsHtml([
        ["Элементов записано", res.elements], ["Помещений", res.rooms], ["Квартир", res.flats], ["Списано (исчезло из модели)", res.retired || ""],
        ["Секций добавлено", res.sections_added || ""], ["Этажей добавлено", res.levels_added || ""],
        ["Секция определена по геометрии", res.sections_by_geometry || ""], ["Без секции осталось", res.sections_unknown || ""],
        ["Секция из модели не совпала с расположением (оставлена как в модели)", res.sections_conflicting || ""],
      ]) + `<p class="v2-muted">Модель объекта видна в рабочем месте «Модель МФР».</p>`;
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) status.set(errText(err), "bad");
      else if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml("применение выгрузки Revit"), "bad");
        const box = $("#rv-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "import_revit", entityId: a.object_id, sinceMs: sentAt || Date.now(), what: "применение выгрузки Revit" }));
      } else status.set(`Не выполнено: ${errText(err)}${/недоступен|устарел/i.test(errText(err)) ? " Разберите пакеты заново." : ""}`, "bad");
    } finally {
      busy = false;
      if (!dead) { $("#rv-analyze").disabled = false; $("#rv-apply")?.removeAttribute("disabled"); $("#rv-cancel")?.removeAttribute("disabled"); }
    }
  }

  $("#rv-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  return {
    hasUnsavedChanges: () => !!analysis,
    async guardLeave() { return !analysis || (await showConfirmDialog("Разбор пакетов не применён — результат разбора будет потерян (в базу ничего не записано). Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; },
  };
}
