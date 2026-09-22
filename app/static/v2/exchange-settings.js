// Экран «Экспорт/импорт настроек» (settings-io) — вынесен из exchange-import.js: единственная загрузка обмена данными, где файл
// несёт не данные объекта, а копию учётных записей сервиса (хэши и соли паролей ВСЕХ пользователей, роли, цвета статусов, видимость
// подписей). V1 применяет файл одним запросом без предпросмотра; V2 добавляет то, чего у V1 нет (Docs/v2-progress/exchange.md,
// решение пользователя): сверку «что изменится» ДО применения, явное подтверждение «файл = копия учётных записей» и перечитывание
// сверки (через `digest`) непосредственно перед применением — сервер сам отказывает устаревшей сверке (см. app/settings_import.py).
import { showConfirmDialog } from "./dialogs.js";
import {
  esc, errText, isUnknownOutcome, checkFile, fmtSize, pageFrame, makeStatus, unknownOutcomeHtml, verifyOutcome, factsHtml, listHtml, saveBlob,
} from "./exchange-common.js";

function userRow(u) {
  if (u.kind === "create") {
    return `<li><b>+ ${esc(u.name)}</b> (${esc(u.login)}) — новый пользователь, роль «${esc(u.role)}»${u.auth_method === "domain" ? ", доменный вход" : ""}${u.password_set ? ", пароль из файла" : ", без пароля"}</li>`;
  }
  return `<li><b>${esc(u.name)}</b> (${esc(u.login)}) — ${u.changes.map(esc).join("; ")}</li>`;
}

function diffHtml(a) {
  if (!a.has_changes) {
    return `<div class="v2-callout" role="note">Изменений нет: всё, что есть в файле, уже совпадает с базой этого сервера${a.skipped_objects.length ? " (кроме пропущенных объектов ниже)" : ""}.</div>`
      + (a.skipped_objects.length ? listHtml("Объекты файла, которых нет на этом сервере (видимость подписей для них пропущена)", a.skipped_objects) : "");
  }
  const parts = [];
  if (a.users.length) parts.push(`<p class="v2-ex-list-title"><strong>Пользователи (${a.users.length} из ${a.total_users_in_file} в файле):</strong></p><ul class="v2-ex-list">${a.users.map(userRow).join("")}</ul>`);
  if (a.status_colors.length) parts.push(`<p class="v2-ex-list-title"><strong>Цвета статусов (${a.status_colors.length}):</strong></p><ul class="v2-ex-list">${a.status_colors.map((c) => `<li>${esc(c.status)}: ${esc(c.was || "—")} → <b>${esc(c.now)}</b></li>`).join("")}</ul>`);
  if (a.label_visibility_changes) parts.push(`<p>Видимость подписей: правок — <b>${a.label_visibility_changes}</b>.</p>`);
  if (a.skipped_objects.length) parts.push(listHtml("Объекты файла, которых нет на этом сервере (видимость подписей для них пропущена)", a.skipped_objects));
  return parts.join("");
}

export function mountSettingsIo(el, ctx) {
  const { screen, groupTitle, api } = ctx;
  let dead = false, busy = false, analysis = null, file = null;
  el.className = "v2-page";
  el.innerHTML = pageFrame({
    screen, groupTitle,
    summary: "Пользователи, цвета статусов, видимость подписей по типам — для переноса на другой сервер или резервной копии.",
    body: `<div class="v2-callout v2-callout-bad" role="note">Файл выгрузки содержит хэши и соли паролей ВСЕХ пользователей сервиса — обращайтесь с ним как с резервной копией учётных
        записей, не как с обычными настройками. Загрузка заменяет пользователей и их роли на этом сервере.</div>
      <div class="v2-bar"><button type="button" class="v2-btn" id="st-export">Скачать текущие настройки (.json)</button></div>
      <form id="st-form" autocomplete="off" novalidate>
        <label class="v2-wire-field v2-field-wide"><span>Файл .json (выгрузка настроек)</span><input type="file" id="st-file" accept=".json"></label>
        <div class="v2-bar"><button type="submit" class="v2-btn v2-primary" id="st-analyze">Сверить с базой</button></div>
      </form>
      <div id="st-status" class="v2-ex-status" role="status" aria-live="polite"></div>
      <div id="st-diff"></div>
      <div id="st-confirm" hidden>
        <label class="v2-wire-check"><input type="checkbox" id="st-ack"> Понимаю: файл — копия учётных записей; применение заменит пароли и роли перечисленных пользователей на этом сервере.</label>
        <div class="v2-bar v2-ex-stickybar"><button type="button" class="v2-btn v2-primary" id="st-apply" disabled>Применить</button></div>
      </div>
      <div id="st-result"></div>`,
  });
  const $ = (s) => el.querySelector(s);
  const status = makeStatus($("#st-status"));

  $("#st-export").addEventListener("click", async () => {
    const b = $("#st-export"); const label = b.textContent; b.disabled = true; b.textContent = "Готовится…";
    try {
      const { blob, filename } = await api.fetchFile("/settings/export");
      saveBlob(blob, filename || "zhbi_settings.json");
    } catch (err) { status.set(`Не удалось скачать настройки: ${errText(err)}`, "bad"); }
    finally { b.disabled = false; b.textContent = label; }
  });

  function resetAfterApply() {
    analysis = null; file = null;
    $("#st-diff").innerHTML = ""; $("#st-confirm").hidden = true; $("#st-ack").checked = false; $("#st-apply").disabled = true;
  }

  async function analyze() {
    if (busy) return;
    const f = $("#st-file").files[0];
    const problem = checkFile(f, { ext: ["json"] });
    if (problem) { status.set(problem, "bad"); return; }
    busy = true; $("#st-analyze").disabled = true; status.set("Сверяем файл с базой…", "busy");
    $("#st-result").innerHTML = ""; resetAfterApply();
    try {
      const fd = new FormData(); fd.append("file", f, f.name);
      const a = await api.upload("/settings/import/analyze", fd);
      if (dead) return;
      analysis = a; file = f;
      status.set(a.has_changes ? "Сверка готова — проверьте, что изменится, ниже." : "Сверка готова — изменений нет.", "ok");
      $("#st-diff").innerHTML = diffHtml(a);
      $("#st-confirm").hidden = false;
      $("#st-ack").checked = false;
      $("#st-apply").disabled = true;   // остаётся заблокированной, пока человек явно не отметит чекбокс подтверждения (даже если есть что применять)
    } catch (err) {
      if (dead) return;
      status.set(`Сверка не удалась: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) $("#st-analyze").disabled = false; }
  }

  el.addEventListener("change", (e) => {
    if (e.target.id === "st-ack") $("#st-apply").disabled = !e.target.checked || !analysis?.has_changes;
  });

  async function apply() {
    if (busy || !analysis || !file) return;
    if (!$("#st-ack").checked) return;
    busy = true; $("#st-apply").disabled = true; $("#st-analyze").disabled = true;
    let sentAt = null;
    try {
      const ok = await showConfirmDialog(
        `Применить настройки из файла «${file.name}» (${fmtSize(file.size)})?\n\nЭто заменит перечисленных пользователей (включая пароли и роли), цвета статусов и видимость подписей на этом сервере. Перед применением сервер сохранит копию базы; при любом сбое ничего не изменится.`,
        { confirmLabel: "Применить", danger: true, multiline: true },
      );
      if (!ok || dead) { if (!dead) status.set("Применение отменено — ничего не изменено.", ""); return; }
      status.set("Применяем…", "busy");
      $("#st-result").innerHTML = "";
      sentAt = Date.now();
      const fd = new FormData(); fd.append("file", file, file.name); fd.append("digest", analysis.digest);
      const res = await api.upload("/settings/import/apply", fd);
      if (dead) return;
      const пропущено = (res.skipped_objects || []).length ? ` Пропущены объекты, которых нет на этом сервере: ${res.skipped_objects.join(", ")}.` : "";
      status.set(`Готово: пользователей ${res.users_upserted}, цветов ${res.status_colors}, настроек подписей ${res.label_visibility}, настроек дат ${res.label_dates_visibility}.${пропущено}`, "ok");
      $("#st-result").innerHTML = factsHtml([
        ["Пользователей обработано", res.users_upserted], ["Цветов статусов", res.status_colors],
        ["Видимость подписей", res.label_visibility], ["Видимость дат", res.label_dates_visibility],
      ]);
      resetAfterApply();
      $("#st-file").value = "";
    } catch (err) {
      if (dead) return;
      if (err.blockedByPolicy) { status.set(errText(err), "bad"); return; }
      if (err instanceof Error && err.status === 409) {
        status.set(`${errText(err)} Сверьте файл заново.`, "bad");
        resetAfterApply();
        return;
      }
      if (isUnknownOutcome(err)) {
        status.html(unknownOutcomeHtml("применение настроек"), "bad");
        const box = $("#st-status");
        box.querySelector("[data-verify]")?.addEventListener("click", () => verifyOutcome(api, box, { action: "settings_import", entityId: null, sinceMs: sentAt || Date.now(), what: "применение настроек" }));
      } else status.set(`Не выполнено: ${errText(err)}`, "bad");
    } finally { busy = false; if (!dead) { $("#st-analyze").disabled = false; if (analysis) $("#st-apply").disabled = !$("#st-ack").checked; } }
  }

  $("#st-form").addEventListener("submit", (e) => { e.preventDefault(); analyze(); });
  $("#st-confirm").addEventListener("click", (e) => { if (e.target.id === "st-apply") apply(); });

  return {
    hasUnsavedChanges: () => !!analysis?.has_changes,
    async guardLeave() { return !analysis?.has_changes || (await showConfirmDialog("Сверка настроек не применена — результат сверки будет потерян. Уйти?", { confirmLabel: "Уйти", cancelLabel: "Остаться" })); },
    destroy() { dead = true; },
  };
}
