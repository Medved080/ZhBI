// Карточка запланированной работы (ЗР) объекта МФР: базовый срок, актуализированный срок (прогноз, версии), примечание, документы факта
// и построчная история правок факта. Те же API и права, что у V1 (`PATCH /objects/{id}/block-works/{bw}`, раздел `work_progress`).
// Барьеры безопасности данных:
//  * в PATCH идут ТОЛЬКО поля своей группы плюс отпечаток работы `expected_rev` (сервер различает «не пришло» и null: лишнее поле стёрло бы
//    дату) — три независимые кнопки «Сохранить», как у V1;
//  * отпечаток проверяет СЕРВЕР под блокировкой записи: работу изменили после открытия — 409, ничего не менялось, ввод остаётся, версию
//    сервера можно загрузить явно (раньше проверка шла в браузере отдельным чтением — между чтением и записью оставалось окно);
//  * даты — настоящие календарные, конец не раньше начала; ввод не теряется при ошибке;
//  * успех — после ответа сервера и повторного чтения; неизвестный исход не повторяется автоматически (сверка чтением);
//  * ПРОГНОЗ пишется новой версией (версии копятся и не отменяются) — это сказано в подписи кнопки и в подтверждении;
//  * снятая с плана работа только читается (правку сервер тоже отклоняет).
import { esc, errText, fmtDate, fmtMoment, shortDate, isRealDate, settle, conflictText, OUTCOME_TEXT, DEADLINE, WORK_STATUS } from "./mfr-common.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";
import { checkWrite } from "./write-gate.js";

const GROUPS = {
  plan: { fields: ["plan_start", "plan_end"], label: "Базовый срок" },
  forecast: { fields: ["forecast_start", "forecast_end"], label: "Прогноз" },
  note: { fields: ["note"], label: "Примечание" },
};

export function mountBlockWorkForm(host, { api, objectId, id, canWrite, onSaved, onClose, onOpenFact }) {
  const path = `/objects/${objectId}/block-works/${id}`;
  let dead = false, busy = false, seq = 0;
  const st = { work: null, draft: {}, error: "", status: "", statusKind: "", conflict: false };
  const val = (w, f) => (w?.[f] == null ? "" : String(w[f]));
  const draftOf = (w) => Object.fromEntries(Object.values(GROUPS).flatMap((g) => g.fields).map((f) => [f, val(w, f)]));
  const groupDirty = (g) => st.work && GROUPS[g].fields.some((f) => (st.draft[f] ?? "") !== val(st.work, f));
  const dirty = () => !!st.work && Object.keys(GROUPS).some(groupDirty);
  const setStatus = (t, kind = "") => { st.status = t; st.statusKind = kind; const n = host.querySelector("#bw-status"); if (n) { n.textContent = t; n.className = `mfr-status ${kind}`; } };
  const retired = () => !!st.work?.retired_at;

  // Политика шлюза (write-gate.js): какие группы полей можно сохранять в этом интерфейсе.
  const groupOfField = (f) => Object.keys(GROUPS).find((g) => GROUPS[g].fields.includes(f));
  const groupOpen = (g) => checkWrite("PATCH", `/objects/${objectId}/block-works/0`, { ...Object.fromEntries(GROUPS[g].fields.map((f) => [f, null])), expected_rev: "x" }).allowed;

  function paint() {
    if (dead) return;
    if (!st.work) {
      host.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить работу.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="bw-retry">Повторить</button> <button type="button" class="v2-btn" id="bw-close">Закрыть</button></div></div>` : `<p class="v2-muted" role="status">Загрузка работы…</p>`;
      host.querySelector("#bw-retry")?.addEventListener("click", load);
      host.querySelector("#bw-close")?.addEventListener("click", () => onClose?.());
      return;
    }
    const w = st.work, editable = canWrite && !retired();
    const disOf = (f) => (editable && groupOpen(groupOfField(f)) ? "" : "disabled");
    const dfield = (f, label) => `<label class="v2-wire-field"><span>${label}</span><input type="date" data-f="${f}" value="${esc(st.draft[f] ?? "")}" ${disOf(f)}></label>`;
    const versions = (w.versions || []).map((v) => `<li>${esc(fmtMoment(v.created_at))}: ${esc(shortDate(v.forecast_start))}–${esc(shortDate(v.forecast_end))}${v.created_by ? ` · ${esc(v.created_by)}` : ""}${v.note ? ` · ${esc(v.note)}` : ""}</li>`).join("");
    const docs = (w["документы_факта"] || []).map((d) => `<li>${esc(fmtDate(d.report_date))} — ${d.percent == null ? "—" : esc(d.percent) + " %"}${d.updated_by || d.created_by ? ` · ${esc(d.updated_by || d.created_by)}` : ""}
      ${onOpenFact ? `<button type="button" class="v2-btn mfr-mini" data-doc="${d.id}">Открыть документ</button>` : ""}</li>`).join("");
    const edits = (w["история_правок"] || []).map((h) => `<li>${esc(fmtMoment(h["момент"]))}: ${esc(h["было"])}% → ${esc(h["стало"])}%${h["пользователь"] ? ` · ${esc(h["пользователь"])}` : ""}</li>`).join("");
    host.innerHTML = `<section class="v2-card mfr-zr" aria-label="Запланированная работа">
      <div class="v2-bar"><h3 class="v2-report-h">${esc(w["код"] || "")} · ${esc(w["название"] || "")}</h3><button type="button" class="v2-btn" id="bw-close">Закрыть</button></div>
      <p class="v2-muted">${esc(w["путь"] || "")}</p>
      <p class="v2-muted">Секция ${esc(w.section_code ?? "")}, этаж ${esc(w.level_floor ?? "")} · готовность ${esc(w.percent ?? 0)} % (${esc(WORK_STATUS[w.status] || w.status || "")}) · <span class="mfr-dl mfr-dl-${esc(w.deadline)}">${esc(w.deadline_label || DEADLINE[w.deadline] || "")}</span>${retired() ? ` · <strong>работа снята с плана ${esc(fmtMoment(w.retired_at))} — только просмотр</strong>` : ""}</p>
      <div class="v2-wire-row">${dfield("plan_start", "Базовый срок: начало")}${dfield("plan_end", "Базовый срок: конец")}
        ${editable && groupOpen("plan") ? `<button type="button" class="v2-btn" data-save="plan" ${groupDirty("plan") ? "" : "disabled"}>Сохранить базовый срок</button>` : ""}</div>
      <div class="v2-wire-row">${dfield("forecast_start", "Прогноз: начало")}${dfield("forecast_end", "Прогноз: конец")}
        ${editable && groupOpen("forecast") ? `<button type="button" class="v2-btn" data-save="forecast" ${groupDirty("forecast") ? "" : "disabled"}>Сохранить новую версию прогноза</button>` : ""}</div>
      ${versions ? `<details class="mfr-fold"><summary>Версии прогноза (${(w.versions || []).length}) — копятся и не отменяются</summary><ul class="mfr-list">${versions}</ul></details>` : `<p class="v2-muted">Версий прогноза ещё нет.</p>`}
      <label class="v2-wire-field v2-field-wide"><span>Примечание</span><textarea data-f="note" rows="2" ${disOf("note")}>${esc(st.draft.note ?? "")}</textarea></label>
      ${editable && groupOpen("note") ? `<div class="v2-bar"><button type="button" class="v2-btn" data-save="note" ${groupDirty("note") ? "" : "disabled"}>Сохранить примечание</button></div>` : ""}
      <details class="mfr-fold"><summary>Документы факта (${(w["документы_факта"] || []).length})</summary>${docs ? `<ul class="mfr-list">${docs}</ul>` : `<p class="v2-muted">Документов факта ещё не было.</p>`}</details>
      ${edits ? `<details class="mfr-fold"><summary>История правок факта (${(w["история_правок"] || []).length})</summary><ul class="mfr-list">${edits}</ul></details>` : ""}
      <p class="v2-muted">Заведена: ${esc(fmtMoment(w.created_at) || "—")}${w.created_by ? ` · ${esc(w.created_by)}` : ""}${w.updated_by ? ` · изменена: ${esc(fmtMoment(w.updated_at))}, ${esc(w.updated_by)}` : ""}</p>
      <p id="bw-status" class="mfr-status ${esc(st.statusKind)}" role="status" aria-live="polite">${esc(st.status)}</p>
      ${st.conflict ? `<button type="button" class="v2-btn" id="bw-reload">Загрузить актуальные значения (ввод будет сброшен)</button>` : ""}</section>`;
    host.querySelectorAll("[data-f]").forEach((i) => i.addEventListener("input", () => { st.draft[i.dataset.f] = i.value; sync(); }));
    host.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => save(b.dataset.save)));
    host.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => onOpenFact?.(st.work.block_id, Number(b.dataset.doc), [st.work.work_type_id])));
    host.querySelector("#bw-close").addEventListener("click", () => onClose?.());
    host.querySelector("#bw-reload")?.addEventListener("click", () => { st.conflict = false; st.status = ""; load(true); });
    lock();
  }
  const sync = () => host.querySelectorAll("[data-save]").forEach((b) => { b.disabled = busy || !groupDirty(b.dataset.save); });
  const lock = () => {
    host.querySelectorAll("[data-f], [data-save], #bw-close, [data-doc]").forEach((c) => {
      if (c.id === "bw-close") c.disabled = busy;
      else if (c.dataset.save) c.disabled = busy || !groupDirty(c.dataset.save);
      else if (c.dataset.doc) c.disabled = busy;
      else c.disabled = busy || !canWrite || retired() || !groupOpen(groupOfField(c.dataset.f));
    });
  };

  async function load(resetDraft = true) {
    const my = ++seq;
    try {
      const w = await api.get(path);
      if (dead || my !== seq) return;
      st.work = w; if (resetDraft) st.draft = draftOf(w); st.error = "";
    } catch (e) { if (dead || my !== seq) return; if (!st.work) st.error = errText(e); else setStatus(`Работа не обновилась: ${errText(e)}`, "bad"); }
    paint();
  }

  function problems(g) {
    const out = [], d = st.draft;
    const chk = (f, label) => { if (d[f] && !isRealDate(d[f])) out.push(`«${label}» — не существующая дата`); };
    if (g === "plan") { chk("plan_start", "начало"); chk("plan_end", "конец"); if (d.plan_start && d.plan_end && d.plan_start > d.plan_end) out.push("конец раньше начала"); }
    if (g === "forecast") { chk("forecast_start", "начало прогноза"); chk("forecast_end", "конец прогноза"); if (d.forecast_start && d.forecast_end && d.forecast_start > d.forecast_end) out.push("конец прогноза раньше начала"); }
    return out;
  }
  const eq = (w, fields, sent) => fields.every((f) => (f === "note" ? String(w?.[f] ?? "") === String(sent[f] ?? "") : val(w, f) === (sent[f] ?? "")));

  async function save(g) {
    if (busy || !groupDirty(g)) return;
    const bad = problems(g);
    if (bad.length) { setStatus(`Сохранить нельзя: ${bad.join("; ")}.`, "bad"); return; }
    const fields = GROUPS[g].fields;
    const sent = Object.fromEntries(fields.map((f) => [f, g === "note" ? st.draft[f] : (st.draft[f] || null)]));
    if (g === "forecast") {
      const ok = await showConfirmDialog(`Сохранить новую версию прогноза ${sent.forecast_start ? fmtDate(sent.forecast_start) : "—"} – ${sent.forecast_end ? fmtDate(sent.forecast_end) : "—"}?\n\nВерсии прогноза копятся и не отменяются: эту версию нельзя будет удалить, только добавить следующую.`,
        { confirmLabel: "Сохранить версию", multiline: true });
      if (!ok) return;
    }
    busy = true; lock(); setStatus("Сохранение…");
    const res = await settle(() => api.patch(path, { ...sent, expected_rev: st.work.rev }), async () => {
      const now = await api.get(path);
      if (eq(now, fields, sent)) return "applied";
      return now.rev === st.work.rev ? "not_applied" : "unknown";
    });
    busy = false;
    if (dead) return;
    if (res.ok) {
      try {
        const again = await api.get(path);
        const same = eq(again, fields, sent);
        st.work = again; st.draft = { ...st.draft, ...Object.fromEntries(fields.map((f) => [f, val(again, f)])) };
        paint();
        setStatus(res.outcome === "confirmed" ? OUTCOME_TEXT.confirmed : same ? `${GROUPS[g].label}: сохранено и подтверждено чтением.` : "Сервер вернул значения, отличающиеся от отправленных — проверьте.", same ? "ok" : "bad");
      } catch (e) { paint(); setStatus("Сохранено, но перечитать не удалось — закройте и откройте работу заново.", "bad"); }
      onSaved?.();
      return;
    }
    if (res.outcome === "conflict") { st.conflict = true; paint(); setStatus(`${conflictText(res.error, "работу")} Ваш ввод сохранён в форме.`, "bad"); return; }
    paint();
    setStatus(res.outcome === "rejected" ? errText(res.error) : OUTCOME_TEXT[res.outcome], "bad");
  }

  paint(); load();
  return {
    dirty,
    async guard() {
      if (busy) return false;
      if (!dirty()) return true;
      const c = await showUnsavedDialog("В карточке работы есть несохранённые правки. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      for (const g of Object.keys(GROUPS)) if (groupDirty(g)) await save(g);
      return !dirty();
    },
    reload: () => load(false),
    destroy() { dead = true; host.innerHTML = ""; },
  };
}
