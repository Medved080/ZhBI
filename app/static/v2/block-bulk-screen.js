// «Массовая правка ЗР через Excel (МФР)» в V2: выгрузка запланированных работ (ЗР) объекта в Excel → правка в файле → загрузка → СВЕРКА с базой
// (ничего не пишет; расхождения и отклонённые строки показаны) → флажками отмечается, что применять → применение «всё или ничего».
// Те же API и права, что у V1 (`/objects/{id}/block-works/bulk-edit/{export,analyze}`, раздел `work_progress`, «Изменение»);
// применение — строгий вариант `…/apply-strict` (см. app/block_ops.py): под блокировкой записи сверяется, что значения «было» не изменились
// после сверки файла (иначе 409 и ничего не записано), любая ошибка внутри откатывает ВСЁ (V1 применял по одной ЗР и возвращал «пропущено»).
// Опасная операция: применение идёт только после окна подтверждения с числом изменений по полям и предупреждением о версиях прогноза
// (они копятся и не отменяются) и о документах факта; двойной клик — один запрос; неизвестный исход — без автоповтора, сверка повторной
// сверкой того же файла (после применения расхождений быть не должно).
import { esc, errText, fmtDate, canAccounting, todayIso, settle, conflictItems, isConflict, OUTCOME_TEXT } from "./mfr-common.js";
import { STATUS_LABEL } from "./registry.js";
import { showConfirmDialog } from "./dialogs.js";

const FIELD_ORDER = ["percent", "plan_start", "plan_end", "forecast_start", "forecast_end"];
const valText = (f, v) => (v === null || v === undefined || v === "" ? "—" : /_(start|end)$/.test(f) ? fmtDate(v) : f === "percent" ? `${v}%` : String(v));

export function mountBlockBulkScreen(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page v2-app mfr-scr";
  const canWrite = canAccounting(rights, "write");
  let dead = false, busy = false;
  const st = { file: null, data: null, checked: new Set(), fieldOff: new Set(), msg: "", kind: "", stale: false, applied: null };

  el.innerHTML = `
    <div class="mfr-head">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2><span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span>
        <span class="mfr-cap ${canWrite ? "on" : ""}">${canWrite ? "можно: сверка и применение" : "нет права на изменение"}</span></div>
      <ol class="mfr-steps v2-muted"><li>Выгрузите ЗР в Excel.</li><li>Поправьте в файле сроки (план, прогноз) и прогресс с датой фиксации; колонки с UID и справочные не меняйте.</li><li>Загрузите файл — экран покажет расхождения с базой, ничего не записывая.</li><li>Отметьте флажками, что применить.</li></ol>
      <div class="v2-bar">
        <button type="button" class="v2-btn" id="bb-export" ${canWrite ? "" : "disabled"}>Выгрузить ЗР в Excel</button>
        <label class="v2-wire-field mfr-file"><span>Файл Excel (.xlsx)</span><input type="file" id="bb-file" accept=".xlsx" ${canWrite ? "" : "disabled"}></label>
        <button type="button" class="v2-btn v2-primary" id="bb-analyze" ${canWrite ? "" : "disabled"}>Сверить с базой</button></div>
      <p id="bb-status" class="mfr-status" role="status" aria-live="polite"></p>
    </div>
    <div class="mfr-body" id="bb-body"></div>`;
  const $ = (s) => el.querySelector(s);
  const setMsg = (t, kind = "") => { st.msg = t; st.kind = kind; const n = $("#bb-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };
  const lock = (v) => { busy = v; el.querySelectorAll("button, input").forEach((c) => { if (v) c.disabled = true; }); if (!v) { $("#bb-export").disabled = !canWrite; $("#bb-analyze").disabled = !canWrite; $("#bb-file").disabled = !canWrite; paintBody(); } };

  $("#bb-export").addEventListener("click", async () => {
    if (busy) return;
    lock(true); setMsg("Готовим файл…");
    try {
      const blob = await api.download(`/objects/${objectId}/block-works/bulk-edit/export`, {});
      if (dead) return;
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = `mfr_block_works_${todayIso()}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg(`Файл выгружен (${Math.max(1, Math.round(blob.size / 1024))} КБ). Поправьте его в Excel и загрузите обратно.`, "ok");
    } catch (e) { setMsg(`Не удалось выгрузить: ${errText(e)}`, "bad"); }
    lock(false);
  });

  async function analyze(keepMsg = false) {
    const file = $("#bb-file").files[0] || st.file;
    if (!file) { setMsg("Сначала выберите файл .xlsx", "bad"); return null; }
    st.file = file;
    const fd = new FormData(); fd.append("file", file);
    const data = await api.upload(`/objects/${objectId}/block-works/bulk-edit/analyze`, fd);
    return data;
  }
  $("#bb-analyze").addEventListener("click", async () => {
    if (busy) return;
    lock(true); setMsg("Сверяем файл с базой…"); st.applied = null;
    try {
      const data = await analyze();
      if (dead) return;
      if (data) {
        st.data = data; st.checked = new Set(data.changes.map((_, i) => i)); st.fieldOff = new Set(); st.stale = false;
        setMsg(`Прочитано строк: ${data.rows_read}. Расхождений: ${data.changes.length} у ${data.block_works_touched} ЗР.${data.rejected.length ? ` Не может быть применено: ${data.rejected.length}.` : ""} В базе ничего не изменено.`, data.changes.length ? "ok" : "");
      }
    } catch (e) { setMsg(`Не удалось сверить: ${errText(e)}`, "bad"); }
    lock(false);
  });

  const rowsById = () => new Map((st.data?.block_works || []).map((r) => [r.bw_id, r.values]));
  const rowTitle = (v) => { if (!v) return ""; const wbs = [v.wbs5, v.wbs4, v.wbs3, v.wbs2].find(Boolean); return `${v.section_code ?? ""} · ${v.level_floor ?? ""} — ${wbs || ""}`; };
  const visible = () => (st.data ? st.data.changes.map((c, i) => [c, i]).filter(([c]) => !st.fieldOff.has(c.field)) : []);
  const chosen = () => visible().filter(([, i]) => st.checked.has(i)).map(([c]) => c);

  function paintBody() {
    if (dead) return;
    const body = $("#bb-body");
    const d = st.data;
    if (!d) { body.innerHTML = `${st.applied ? `<div class="v2-callout" role="status"><strong>Применено.</strong> ${esc(st.applied)}</div>` : ""}<p class="v2-muted">Загрузите файл — здесь появятся расхождения с базой.</p>`; return; }
    const names = rowsById();
    const fieldCounts = new Map(); for (const c of d.changes) fieldCounts.set(c.field, (fieldCounts.get(c.field) || 0) + 1);
    const vis = visible();
    const sel = chosen();
    const fnames = Object.fromEntries((d.columns || []).map((c) => [c.key, c.label]));
    body.innerHTML = `<div class="mfr-bb">
      ${st.stale ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Данные изменились после сверки.</strong> Применить эту сверку уже нельзя — загрузите файл и сверьте заново.</div>` : ""}
      ${st.applied ? `<div class="v2-callout" role="status"><strong>Применено.</strong> ${esc(st.applied)}</div>` : ""}
      ${d.rejected.length ? `<details class="mfr-fold" open><summary>Не может быть применено (${d.rejected.length})</summary><ul class="mfr-list">${d.rejected.slice(0, 100).map((r) => `<li>Строка ${esc(r.line)}${r.bw_id ? ` (UID ${esc(r.bw_id)})` : ""}: ${esc(r.reason)}</li>`).join("")}${d.rejected.length > 100 ? `<li class="v2-muted">… и ещё ${d.rejected.length - 100}</li>` : ""}</ul></details>` : ""}
      <div class="v2-bar"><span class="v2-muted">Поля:</span>${FIELD_ORDER.filter((f) => fieldCounts.has(f)).map((f) => `<label class="mfr-chk"><input type="checkbox" data-field="${f}" ${st.fieldOff.has(f) ? "" : "checked"}> ${esc(fnames[f] || f)} <em>${fieldCounts.get(f)}</em></label>`).join("")}
        <button type="button" class="v2-btn" id="bb-all">Отметить все</button><button type="button" class="v2-btn" id="bb-none">Снять все</button>
        <span class="mfr-spacer"></span><span class="v2-muted">отмечено: ${sel.length} из ${vis.length}</span>
        ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="bb-apply" ${sel.length && !busy && !st.stale ? "" : "disabled"}>Применить отмеченное (${sel.length})</button>` : ""}</div>
      <div class="mfr-scroll mfr-tblwrap">${vis.length ? `<table class="v2-read-tbl mfr-tbl"><thead><tr><th></th><th>ЗР (секция · этаж — работа)</th><th>Поле</th><th>Было</th><th>Станет</th><th>Строка файла</th></tr></thead><tbody>
        ${vis.slice(0, 1000).map(([c, i]) => `<tr><td><input type="checkbox" data-c="${i}" ${st.checked.has(i) ? "checked" : ""} aria-label="Применить изменение"></td><td>${esc(rowTitle(names.get(c.bw_id)))}</td><td>${esc(c.field_label || fnames[c.field] || c.field)}${c.field === "percent" && c.report_date ? `<br><span class="v2-muted">дата фиксации ${esc(fmtDate(c.report_date))}</span>` : ""}</td><td>${esc(valText(c.field, c.was))}</td><td><b>${esc(valText(c.field, c.now))}</b></td><td>${esc(c.line)}</td></tr>`).join("")}</tbody></table>`
        : `<p class="v2-muted">${d.changes.length ? "Все поля отключены фильтром." : "Файл совпадает с базой — применять нечего."}</p>`}</div>
      ${vis.length > 1000 ? `<p class="v2-muted">Показаны первые 1000 из ${vis.length}; применяются все отмеченные.</p>` : ""}</div>`;
    body.querySelectorAll("[data-field]").forEach((c) => c.addEventListener("change", () => { c.checked ? st.fieldOff.delete(c.dataset.field) : st.fieldOff.add(c.dataset.field); paintBody(); }));
    body.querySelectorAll("[data-c]").forEach((c) => c.addEventListener("change", () => { const i = Number(c.dataset.c); c.checked ? st.checked.add(i) : st.checked.delete(i); paintBody(); }));
    $("#bb-all")?.addEventListener("click", () => { for (const [, i] of visible()) st.checked.add(i); paintBody(); });
    $("#bb-none")?.addEventListener("click", () => { for (const [, i] of visible()) st.checked.delete(i); paintBody(); });
    $("#bb-apply")?.addEventListener("click", apply);
  }

  async function apply() {
    if (busy || !canWrite || st.stale) return;
    const sel = chosen();
    if (!sel.length) return;
    const byField = {}; for (const c of sel) byField[c.field] = (byField[c.field] || 0) + 1;
    const works = new Set(sel.map((c) => c.bw_id)).size;
    const facts = sel.filter((c) => c.field === "percent");
    const fc = sel.filter((c) => c.field.startsWith("forecast_"));
    const lines = [`Будет применено изменений: ${sel.length} у ${works} ЗР — одной операцией, «всё или ничего».`, "", ...FIELD_ORDER.filter((f) => byField[f]).map((f) => `• ${(st.data.columns.find((c) => c.key === f) || {}).label || f}: ${byField[f]}`)];
    if (facts.length) lines.push("", `Документов факта будет создано: ${new Set(facts.map((c) => `${c.block_id}|${c.report_date}`)).size} (по паре блок × дата).`);
    if (fc.length) lines.push("", "Версии прогноза копятся и не отменяются: новые версии нельзя будет удалить.");
    lines.push("", "Перед применением сервер снимет копию базы; если что-то изменилось после сверки — не будет записано ничего.");
    const ok = await showConfirmDialog(lines.join("\n"), { confirmLabel: "Применить", multiline: true });
    if (!ok) return;
    lock(true); setMsg("Применяется одной операцией…");
    const res = await settle(() => api.post(`/objects/${objectId}/block-works/bulk-edit/apply-strict`, { changes: sel }), async () => {
      // сверка: повторная сверка того же файла — после применения расхождений быть не должно
      const again = await analyze(true);
      if (!again) return "unknown";
      const left = new Set(again.changes.map((c) => `${c.bw_id}|${c.field}|${c.now}`));
      const stillPending = sel.filter((c) => left.has(`${c.bw_id}|${c.field}|${c.now}`)).length;
      return stillPending === 0 ? "applied" : stillPending === sel.length ? "not_applied" : "unknown";
    });
    if (dead) return;
    if (res.ok) {
      st.applied = res.outcome === "confirmed" ? "Ответ не получен, но повторная сверка файла подтвердила: изменения применены." : `Обновлено ЗР: ${res.data?.block_works_updated ?? "?"}, создано документов факта: ${res.data?.fact_reports_created ?? "?"} (ответ сервера).`;
      st.data = null; st.checked = new Set();
      setMsg("Готово. Чтобы проверить результат, загрузите файл и сверьте заново — расхождений быть не должно.", "ok");
    } else if (res.outcome === "conflict") {
      st.stale = true; const n = conflictItems(res.error).length;
      setMsg(`${res.error.detail}${n ? ` Расхождений: ${n}.` : ""}`, "bad");
    } else setMsg(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
    lock(false);
  }

  paintBody();
  return { hasUnsavedChanges: () => false, guardLeave: async () => !busy, destroy() { dead = true; } };
}
