// Карточка запланированной работы (ЗР) объекта МФР: правка базового срока, актуализированного срока (прогноз) и примечания.
// Те же API и права, что у V1 (`PATCH /objects/{id}/block-works/{bw}`, раздел `work_progress`, `app/block_works.py`).
// Барьер безопасности данных:
//  * в PATCH идут ТОЛЬКО поля своей группы (сервер различает «не пришло» и null: лишнее поле стёрло бы дату) — как у V1,
//    три независимые кнопки «Сохранить»;
//  * перед записью работа перечитывается: если её изменили после открытия (updated_at / сроки), перезапись — по подтверждению;
//  * даты — настоящие календарные, конец не раньше начала; ввод не теряется при ошибке;
//  * успех — после ответа сервера и повторного чтения; неизвестный исход не повторяется автоматически;
//  * ПРОГНОЗ пишется новой версией (накопление, отменить нельзя) — это сказано в подписи кнопки.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { showConfirmDialog, showUnsavedDialog } from "./dialogs.js";
import { isRealDate } from "./card-edit.js";
import { checkWrite } from "./write-gate.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const GROUPS = {
  plan: { fields: ["plan_start", "plan_end"], label: "Базовый срок" },
  forecast: { fields: ["forecast_start", "forecast_end"], label: "Прогноз" },
  note: { fields: ["note"], label: "Примечание" },
};

export function mountBlockWorkForm(host, { api, objectId, id, canWrite, onSaved, onClose }) {
  const path = `/objects/${objectId}/block-works/${id}`;
  let dead = false, busy = false, seq = 0;
  const st = { work: null, draft: {}, error: "", status: "" };
  const val = (w, f) => (w?.[f] == null ? "" : String(w[f]));
  const draftOf = (w) => Object.fromEntries(Object.values(GROUPS).flatMap((g) => g.fields).map((f) => [f, val(w, f)]));
  const groupDirty = (g) => st.work && GROUPS[g].fields.some((f) => (st.draft[f] ?? "") !== val(st.work, f));
  const dirty = () => !!st.work && Object.keys(GROUPS).some(groupDirty);
  const setStatus = (t) => { st.status = t; const n = host.querySelector("#bw-status"); if (n) n.textContent = t; };
  const retired = () => !!st.work?.retired_at;

  // Политика ограниченного выпуска (write-gate.js): какие группы полей можно сохранять в этом интерфейсе.
  const groupOfField = (f) => Object.keys(GROUPS).find((g) => GROUPS[g].fields.includes(f));
  const groupOpen = (g) => checkWrite("PATCH", `/objects/${objectId}/block-works/0`, Object.fromEntries(GROUPS[g].fields.map((f) => [f, null]))).allowed;

  function paint() {
    if (dead) return;
    if (!st.work) {
      host.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить работу.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="bw-retry">Повторить</button> <button type="button" class="v2-btn" id="bw-close">Закрыть</button></div></div>` : `<p class="v2-muted" role="status">Загрузка работы…</p>`;
      host.querySelector("#bw-retry")?.addEventListener("click", load);
      host.querySelector("#bw-close")?.addEventListener("click", () => onClose());
      return;
    }
    const w = st.work, dis = canWrite && !retired() ? "" : "disabled";
    const disOf = (f) => (canWrite && !retired() && groupOpen(groupOfField(f)) ? "" : "disabled");
    const dfield = (f, label) => `<label class="v2-wire-field"><span>${label}</span><input type="date" data-f="${f}" value="${esc(st.draft[f] ?? "")}" ${disOf(f)}></label>`;
    host.innerHTML = `<section class="v2-card" aria-label="Запланированная работа">
      <div class="v2-bar"><h3 class="v2-report-h">${esc(w["код"] || "")} · ${esc(w["название"] || "")}</h3><button type="button" class="v2-btn" id="bw-close">Закрыть</button></div>
      <p class="v2-muted">Секция ${esc(w.section_code ?? "")}, этаж ${esc(w.level_floor ?? "")} · готовность ${esc(w.percent ?? 0)} % · ${esc(w.deadline_label ?? "")}${retired() ? " · <strong>работа снята — правка недоступна</strong>" : ""}</p>
      <div class="v2-wire-row">${dfield("plan_start", "Базовый срок: начало")}${dfield("plan_end", "Базовый срок: конец")}
        ${canWrite && !retired() ? `<button type="button" class="v2-btn" data-save="plan" ${groupDirty("plan") ? "" : "disabled"}>Сохранить базовый срок</button>` : ""}</div>
      <div class="v2-wire-row">${dfield("forecast_start", "Прогноз: начало")}${dfield("forecast_end", "Прогноз: конец")}
        ${canWrite && !retired() && groupOpen("forecast") ? `<button type="button" class="v2-btn" data-save="forecast" ${groupDirty("forecast") ? "" : "disabled"}>Сохранить новую версию прогноза</button>` : ""}</div>
      <label class="v2-wire-field v2-field-wide"><span>Примечание</span><textarea data-f="note" rows="2" ${disOf("note")}>${esc(st.draft.note ?? "")}</textarea></label>
      ${canWrite && !retired() && groupOpen("note") ? `<div class="v2-bar"><button type="button" class="v2-btn" data-save="note" ${groupDirty("note") ? "" : "disabled"}>Сохранить примечание</button></div>` : ""}
      ${groupOpen("forecast") && groupOpen("note") ? "" : `<p class="v2-muted">Версия прогноза и примечание в экспериментальном интерфейсе отключены — выполняйте их в текущем интерфейсе.</p>`}
      <p id="bw-status" class="v2-muted" role="status" aria-live="polite">${esc(st.status)}</p></section>`;
    host.querySelectorAll("[data-f]").forEach((i) => i.addEventListener("input", () => { st.draft[i.dataset.f] = i.value; sync(); }));
    host.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => save(b.dataset.save)));
    host.querySelector("#bw-close").addEventListener("click", () => onClose());
    lock();
  }
  const sync = () => host.querySelectorAll("[data-save]").forEach((b) => { b.disabled = busy || !groupDirty(b.dataset.save); });
  const lock = () => { host.querySelectorAll("[data-f], [data-save], #bw-close").forEach((c) => { if (c.id === "bw-close") c.disabled = busy; else if (c.dataset.save) c.disabled = busy || !groupDirty(c.dataset.save); else c.disabled = busy || !canWrite || retired() || !groupOpen(groupOfField(c.dataset.f)); }); };

  async function load() {
    const my = ++seq;
    try {
      const w = await api.get(path);
      if (dead || my !== seq) return;
      st.work = w; st.draft = draftOf(w); st.error = "";
    } catch (e) { if (dead || my !== seq) return; if (!st.work) st.error = errText(e); else setStatus(`Работа не обновилась: ${errText(e)}`); }
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
    if (bad.length) { setStatus(`Сохранить нельзя: ${bad.join("; ")}.`); return; }
    const fields = GROUPS[g].fields;
    const sent = Object.fromEntries(fields.map((f) => [f, g === "note" ? st.draft[f] : (st.draft[f] || null)]));
    busy = true; lock(); setStatus("Проверяем, не изменили ли работу другие…");
    try {
      let fresh;
      try { fresh = await api.get(path); } catch (e) { setStatus(`Не удалось проверить актуальность: ${errText(e)}. Запись не отправлена.`); return; }
      const moved = fresh.updated_at !== st.work.updated_at || fields.some((f) => val(fresh, f) !== val(st.work, f));
      if (moved) {
        busy = false; lock();
        const ok = await showConfirmDialog(`«${GROUPS[g].label}»: работу изменили после того, как вы её открыли. Записать ваши значения поверх?`, { confirmLabel: "Записать", danger: true });
        if (!ok) { setStatus("Запись отменена. Нажмите «Закрыть» и откройте работу заново, чтобы увидеть актуальные значения."); return; }
        busy = true; lock();
      }
      setStatus("Сохранение…");
      try { await api.patch(path, sent); }
      catch (e) {
        if (unknownOutcome(e)) {
          try { const now = await api.get(path); if (eq(now, fields, sent)) { st.work = now; st.draft = draftOf(now); setStatus("Сервер сохранил значения, хотя ответ не дошёл."); onSaved?.(); } else setStatus(`Изменения не подтверждены (${errText(e)}). Проверьте работу и повторите вручную.`); }
          catch (e2) { setStatus(`Неизвестно, сохранено ли (${errText(e)}). Закройте и откройте работу заново.`); }
        } else setStatus(errText(e));
        return;
      }
      try {
        const again = await api.get(path);
        if (dead) return;
        const same = eq(again, fields, sent);
        st.work = again; st.draft = { ...st.draft, ...draftOf(again) };
        setStatus(same ? `${GROUPS[g].label}: сохранено и подтверждено чтением.` : "Сервер вернул значения, отличающиеся от отправленных — проверьте.");
        onSaved?.();
      } catch (e) { setStatus("Сохранено, но перечитать не удалось — закройте и откройте работу заново."); onSaved?.(); }
    } finally { busy = false; if (!dead) paint(); }
  }

  paint(); load();
  return {
    dirty,
    async guard() {
      if (!dirty()) return true;
      const c = await showUnsavedDialog("В карточке работы есть несохранённые правки. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      for (const g of Object.keys(GROUPS)) if (groupDirty(g)) await save(g);
      return !dirty();
    },
    destroy() { dead = true; host.innerHTML = ""; },
  };
}
