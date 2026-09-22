// «Заполнить пустые "Объект" и "Проект"» (временная обработка, app/fill_scope.py): дообъектное наследие
// (иерархия «Проект → Объект» вводилась поэтапно) — часть записей осталась без объекта/проекта и видна
// только администратору сервиса. Та же форма, что в V1: предпросмотр (`GET /admin/fill-empty-scope`, ничего
// не пишет), выбор проекта и объекта, отмеченные справочники, применение ОДНОЙ транзакцией
// (`POST /admin/fill-empty-scope/apply`).
//
// Барьер: подтверждение вводом слова (сильнее, чем window.confirm в V1) с числом затронутых записей и
// названием объекта/проекта в тексте — обратной кнопки «снять объект» нет; предпросмотр перечитывается
// ПЕРЕД показом отчёта о применении, чтобы новое состояние было видно рядом с тем, что произошло; неизвестный
// исход не повторяется — состояние перечитывается тем же предпросмотром.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { askTyped } from "./admin-common.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);
const plural = (n, one, few, many) => { const с = Math.abs(n) % 100, е = с % 10; if (с > 10 && с < 20) return many; if (е > 1 && е < 5) return few; return е === 1 ? one : many; };

export function mountFillScopeEdit(el, { screen, structure, objectId, api, rights, groupTitle }) {
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin; // системный админ — как require_system_admin на сервере
  let dead = false, busy = false;
  const st = { targets: null, sampleLimit: 10, error: "", checked: new Set(), projects: [], objects: [], projectId: null, objectId: null, status: "" };

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout v2-callout-bad" role="note"><strong>Временная обработка, необратима через интерфейс.</strong>
        Иерархия «Проект → Объект» вводилась поэтапно, часть записей заведена до появления у них этого поля. Запись без объекта не видна ни в одном справочнике объекта и доступна только администратору сервиса. Когда таких записей не останется, обработку следует убрать — новые записи без объекта система заводить не даёт.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      ${canWrite ? `<div class="v2-fields" style="max-width:640px">
        <label class="v2-field">Проект<select id="fs-project"></select></label>
        <label class="v2-field">Объект<select id="fs-object"></select></label>
      </div>` : ""}
      <div id="fs-body"></div>
      <div class="v2-inline" style="margin-top:12px">${canWrite ? `<button type="button" class="v2-btn v2-primary" id="fs-apply" disabled>Заполнить…</button>` : ""}</div>
      <p class="v2-muted" id="fs-status" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { st.status = t; const n = $("#fs-status"); if (n) n.textContent = t; };

  function paintBody() {
    const box = $("#fs-body");
    if (!st.targets) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось получить сводку.</strong> ${esc(st.error)}<div class="v2-callout-actions"><button type="button" class="v2-btn" id="fs-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#fs-retry")?.addEventListener("click", loadTargets);
      return;
    }
    const anyEmpty = st.targets.some((t) => t.empty);
    if (!anyEmpty) { box.innerHTML = `<p class="v2-muted">Пустых полей «Объект» и «Проект» не найдено — заполнять нечего. Это и есть то состояние, в котором обработку следует убрать.</p>`; return; }
    box.innerHTML = st.targets.map((t) => {
      const off = !t.empty;
      return `<label class="v2-card" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;${off ? "opacity:.55" : ""}">
        <input type="checkbox" data-fill-key="${esc(t.key)}" style="margin-top:3px" ${off || !canWrite ? "disabled" : ""} ${!off && st.checked.has(t.key) ? "checked" : ""}>
        <span><b>${esc(t.title)}</b> — поле «${t.field === "project" ? "Проект" : "Объект"}» (<code>${esc(t.table)}.${esc(t.column)}</code>):
          ${off ? "пустых записей нет" : `<b>${t.empty}</b> ${plural(t.empty, "запись", "записи", "записей")} без значения`}
          <div class="v2-muted" style="margin-top:4px">${esc(t.note)}</div>
          ${t.samples.length ? `<div class="v2-muted" style="margin-top:4px">Например: ${t.samples.map((s) => esc(s.label)).join("; ")}${t.empty > st.sampleLimit ? ` … и ещё ${t.empty - st.sampleLimit}` : ""}.</div>` : ""}
        </span></label>`;
    }).join("");
    box.querySelectorAll("[data-fill-key]").forEach((cb) => cb.addEventListener("change", () => { if (cb.checked) st.checked.add(cb.dataset.fillKey); else st.checked.delete(cb.dataset.fillKey); syncApplyBtn(); }));
  }
  function syncApplyBtn() { const b = $("#fs-apply"); if (b) b.disabled = busy || st.checked.size === 0; }

  async function loadTargets() {
    try { const d = await api.get("/admin/fill-empty-scope"); if (dead) return; st.targets = d.targets; st.sampleLimit = d.sample_limit; st.error = ""; for (const t of d.targets) if (t.default_on && t.empty) st.checked.add(t.key); }
    catch (e) { if (dead) return; st.targets = null; st.error = errText(e); }
    paintBody(); syncApplyBtn();
  }

  async function loadScope() {
    if (!canWrite) return;
    const [projects, objects] = await Promise.all([api.get("/projects"), api.get("/objects")]);
    if (dead) return;
    st.projects = projects; st.objects = objects;
    const projSel = $("#fs-project"), objSel = $("#fs-object");
    projSel.innerHTML = projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    if (objectId) { const own = objects.find((o) => o.id === objectId); if (own) projSel.value = String(own.project_id); }
    const fillObjects = () => {
      const pid = Number(projSel.value);
      const own = objects.filter((o) => o.project_id === pid);
      objSel.innerHTML = own.length ? own.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("") : `<option value="">— в проекте нет объектов —</option>`;
      if (objectId && own.some((o) => o.id === objectId)) objSel.value = String(objectId);
    };
    fillObjects();
    projSel.addEventListener("change", fillObjects);
  }

  async function apply() {
    if (busy || !st.checked.size) return;
    const keys = [...st.checked];
    const chosen = st.targets.filter((t) => keys.includes(t.key));
    const total = chosen.reduce((s, t) => s + t.empty, 0);
    const projSel = $("#fs-project"), objSel = $("#fs-object");
    const projName = projSel.options[projSel.selectedIndex]?.text || "—";
    const objName = objSel.options[objSel.selectedIndex]?.text || "—";
    const msg = `Заполнить у ${total} ${plural(total, "записи", "записей", "записей")} (${chosen.map((t) => t.title).join(", ")}) объект «${objName}» и проект «${projName}»?\n\nДействие необратимо через интерфейс.`;
    if (!(await askTyped(msg, "ЗАПОЛНИТЬ", { confirmLabel: "Заполнить", inputLabel: "Для подтверждения введите слово" }))) return;
    busy = true; syncApplyBtn(); setStatus("Заполняем…");
    const body = { project_id: Number(projSel.value) || null, object_id: Number(objSel.value) || null, keys };
    try {
      const r = await api.post("/admin/fill-empty-scope/apply", body);
      st.checked.clear();
      await loadTargets();
      const lines = r.results.map((res) => {
        const extra = (res.extra || []).length ? ` (${res.extra.join("; ")})` : "";
        const skipped = res.skipped ? ` Пропущено ${res.skipped}: ${res.reasons.join(" ")}` : "";
        return `${res.title}: заполнено ${res.filled}${extra}.${skipped}`;
      });
      setStatus(`Готово. Всего заполнено: ${r.total_filled}. ${lines.join(" ")}`);
    } catch (e) {
      if (unknownOutcome(e)) { await loadTargets(); setStatus(`Неизвестно, выполнено ли заполнение (${errText(e)}). Проверьте сводку — пустых записей стало меньше, если сервер успел.`); }
      else setStatus(errText(e));
    }
    busy = false; syncApplyBtn();
  }

  $("#fs-apply")?.addEventListener("click", apply);
  paintBody();
  loadTargets();
  loadScope();
  return { hasUnsavedChanges: () => false, guardLeave: async () => !busy, destroy() { dead = true; } };
}
