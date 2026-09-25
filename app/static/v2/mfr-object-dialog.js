// План и факт по объекту для операций МФР, которые не имеют блочной единицы.
import { esc, errText, openModal, todayIso, isRealDate, unknownOutcome } from "./mfr-common.js";
import { mountWorkTypeTree } from "./mfr-tree.js";
import { showUnsavedDialog } from "./dialogs.js";

export function openObjectWorkDialog({ api, objectId, canWrite, onChanged, initialTab = "settings" }) {
  let data = null, tree = null, tab = initialTab, workId = null, report = null;
  let busy = false, dirty = false, status = "";
  const m = openModal({ title: "Работы объекта · МФР", wide: true, onRequestClose: guard });
  m.dirty = () => dirty; m.guard = guard;
  async function guard() {
    if (!dirty) return true;
    const choice = await showUnsavedDialog("Есть несохранённые изменения. Сохранить перед выходом?");
    if (choice === "discard") return true;
    if (choice === "save") { await save(tab); return !dirty; }
    return false;
  }
  async function load() {
    try {
      data = await api.get(`/objects/${objectId}/object-works`);
      workId = data.works.some((w) => w.id === workId) ? workId : data.works[0]?.id || null;
      dirty = false; status = ""; paint();
    } catch (e) { m.body.innerHTML = `<p class="v2-muted" role="alert">${esc(errText(e))}</p>`; }
  }
  const currentWork = () => data?.works.find((w) => w.id === workId);
  async function switchTab(next) { if (busy || !(await guard())) return; tab = next; dirty = false; report = null; status = ""; paint(); }
  function paint() {
    if (!data || m.closed) return;
    const dis = canWrite && !busy ? "" : "disabled";
    const tabs = [["settings", "Состав работ"], ["dates", "План и сроки"], ["fact", "Факт"]];
    let body = "";
    if (tab === "settings") {
      body = `<p class="v2-muted">Здесь выбираются только операции с единицей измерения, не относящейся к блоку. Блочные работы остаются в карточках блоков.</p>
        <div id="mow-tree"></div>${canWrite ? `<button type="button" class="v2-btn v2-primary" id="mow-settings-save" ${busy ? "disabled" : ""}>Сохранить состав</button>` : ""}`;
    } else if (tab === "dates") {
      const w = currentWork();
      body = data.works.length ? `<label class="v2-wire-field"><span>Работа</span><select id="mow-work">${data.works.map((item) => `<option value="${item.id}" ${item.id === workId ? "selected" : ""}>${esc(item.path)} · ${esc(item.unit)}</option>`).join("")}</select></label>
        <div class="v2-bar"><label class="v2-wire-field"><span>План: начало</span><input type="date" id="mow-plan-start" value="${esc(w?.plan_start || "")}" ${dis}></label>
        <label class="v2-wire-field"><span>План: окончание</span><input type="date" id="mow-plan-end" value="${esc(w?.plan_end || "")}" ${dis}></label></div>
        <div class="v2-bar"><label class="v2-wire-field"><span>Прогноз: начало</span><input type="date" id="mow-forecast-start" value="${esc(w?.forecast_start || "")}" ${dis}></label>
        <label class="v2-wire-field"><span>Прогноз: окончание</span><input type="date" id="mow-forecast-end" value="${esc(w?.forecast_end || "")}" ${dis}></label></div>
        <label class="v2-wire-field"><span>Примечание</span><textarea id="mow-note" maxlength="4000" ${dis}>${esc(w?.note || "")}</textarea></label>
        ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="mow-dates-save" ${busy ? "disabled" : ""}>Сохранить сроки</button>` : ""}` : `<p class="v2-muted">Сначала выберите работы в разделе «Состав работ».</p>`;
    } else {
      const items = report?.items || Object.fromEntries(data.works.map((w) => [w.id, w.percent || 0]));
      body = data.works.length ? `<div class="v2-bar"><label class="v2-wire-field"><span>Документ</span><select id="mow-report"><option value="">Новый документ</option>${data.reports.map((r) => `<option value="${r.id}" ${report?.id === r.id ? "selected" : ""}>${esc(r.report_date)} · №${r.id}</option>`).join("")}</select></label>
        <label class="v2-wire-field"><span>Дата факта</span><input type="date" id="mow-report-date" value="${esc(report?.report_date || todayIso())}" ${dis}></label></div>
        <div class="mfr-fact-rows">${data.works.map((w) => `<label class="mfr-fact-row"><span class="mfr-fact-name">${esc(w.path)} · ${esc(w.unit)}</span><input type="number" min="0" max="100" step="1" data-mow-percent="${w.id}" value="${esc(items[w.id] ?? 0)}" ${dis} aria-label="Процент: ${esc(w.name)}"><span>%</span></label>`).join("")}</div>
        ${canWrite ? `<button type="button" class="v2-btn v2-primary" id="mow-fact-save" ${busy ? "disabled" : ""}>${report ? "Сохранить исправление" : "Создать документ"}</button>` : ""}` : `<p class="v2-muted">Сначала выберите работы в разделе «Состав работ».</p>`;
    }
    m.body.innerHTML = `<div class="v2-bar">${tabs.map(([key, name]) => `<button type="button" class="v2-btn ${tab === key ? "v2-primary" : ""}" data-mow-tab="${key}">${name}</button>`).join("")}</div>${body}<p class="mfr-status" role="status" aria-live="polite">${esc(status)}</p>`;
    if (tab === "settings") {
      tree = mountWorkTypeTree(m.body.querySelector("#mow-tree"), data.options,
        data.works.map((w) => w.work_type_id), { disabled: !canWrite || busy, onChange: () => { dirty = true; } });
    }
    bind();
  }
  function bind() {
    m.body.querySelectorAll("[data-mow-tab]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.mowTab)));
    m.body.querySelector("#mow-work")?.addEventListener("change", async (e) => {
      const next = Number(e.target.value); if (!(await guard())) { e.target.value = workId; return; }
      workId = next; dirty = false; paint();
    });
    m.body.querySelector("#mow-report")?.addEventListener("change", async (e) => {
      if (!(await guard())) { e.target.value = report?.id || ""; return; }
      dirty = false;
      try { report = e.target.value ? await api.get(`/objects/${objectId}/object-fact-reports/${Number(e.target.value)}`) : null; paint(); }
      catch (error) { status = errText(error); paint(); }
    });
    m.body.querySelectorAll("input, textarea").forEach((field) => field.addEventListener("input", () => { dirty = true; }));
    m.body.querySelector("#mow-settings-save")?.addEventListener("click", () => save("settings"));
    m.body.querySelector("#mow-dates-save")?.addEventListener("click", () => save("dates"));
    m.body.querySelector("#mow-fact-save")?.addEventListener("click", () => save("fact"));
  }
  async function save(kind) {
    if (busy || !canWrite) return;
    let send;
    if (kind === "settings") {
      send = () => api.put(`/objects/${objectId}/object-works/settings`, { work_type_ids: tree.selected(), expected_rev: data.rev });
    } else if (kind === "dates") {
      const values = Object.fromEntries(["plan_start", "plan_end", "forecast_start", "forecast_end"].map((key) => [key, m.body.querySelector(`#mow-${key.replaceAll("_", "-")}`).value || null]));
      if (Object.values(values).some((v) => v && !isRealDate(v))) { status = "Проверьте даты"; paint(); return; }
      values.note = m.body.querySelector("#mow-note").value;
      values.expected_rev = currentWork().rev;
      send = () => api.patch(`/objects/${objectId}/object-works/${workId}`, values);
    } else {
      const date = m.body.querySelector("#mow-report-date").value;
      const values = Object.fromEntries([...m.body.querySelectorAll("[data-mow-percent]")].map((el) => [Number(el.dataset.mowPercent), Number(el.value)]));
      if (!isRealDate(date) || Object.values(values).some((n) => !Number.isInteger(n) || n < 0 || n > 100)) {
        status = "Проверьте дату и проценты (0–100)";
        const line = m.body.querySelector(".mfr-status"); if (line) line.textContent = status;
        return;
      }
      const body = { report_date: date, items: values };
      if (report) body.expected_rev = report.rev;
      send = () => report ? api.put(`/objects/${objectId}/object-fact-reports/${report.id}`, body)
        : api.post(`/objects/${objectId}/object-fact-reports`, body);
    }
    busy = true;
    m.body.querySelectorAll("button, input, textarea, select").forEach((node) => { node.disabled = true; });
    try {
      const saved = await send();
      if (kind === "fact") report = await api.get(`/objects/${objectId}/object-fact-reports/${report?.id || saved.id}`);
      await load(); onChanged?.(); status = "Сохранено"; paint();
    } catch (e) {
      status = unknownOutcome(e) ? "Ответ сервера не получен. Автоповтора нет; проверьте результат в списке документов. Ввод сохранён в форме." : errText(e);
      m.body.querySelectorAll("button, input, textarea, select").forEach((node) => { node.disabled = false; });
      const line = m.body.querySelector(".mfr-status"); if (line) line.textContent = status;
    } finally { busy = false; }
  }
  m.body.innerHTML = `<p class="v2-muted" role="status">Загрузка работ объекта…</p>`;
  load();
  return m;
}
