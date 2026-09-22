// «Видимость подписей и дат» — настройка ОБЪЕКТА (по типу элемента): показывать ли подпись марки на схеме и
// её допстроку (код контрагента + плановая дата поставки). Те же API, что у V1 (`GET/PUT /label-visibility`,
// `GET/PUT /label-dates-visibility`), но у V1 нет отдельной формы для них: переключатель в боковой панели
// схемы («Подписи») меняет видимость только в ЭТОЙ вкладке браузера и пропадает при перезагрузке (осознанно,
// см. app/static/app.js). Здесь — тот же смысл, но СОХРАНЯЕМАЯ настройка по умолчанию для объекта: не
// подменяет сеансовый переключатель схемы (он остаётся как был), а задаёт, с чего он стартует.
//
// Барьер: список типов приходит с сервера (типы, у которых уже есть строка в label_visibility — появляются
// сами при первой загрузке чертежа; нового типа тут не завести); сохраняются только изменённые строки, обе
// настройки — отдельными запросами (не блокируют друг друга); «Даты» недоступны для типа, у которого подписи
// выключены (та же иерархия, что в сайдбаре схемы); успех — после повторного чтения; неизвестный исход не
// повторяется, а проверяется чтением.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";
import { showUnsavedDialog } from "./dialogs.js";

const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
const unknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

export function mountVisibilityEdit(el, { screen, structure, objectId, api, groupTitle, rights }) {
  const spec = screen.visibility || { feature: "label_visibility" };
  el.className = "v2-page";
  const canWrite = !!rights?.system_admin || rights?.features?.[spec.feature] === "write";
  let dead = false, seq = 0;
  // base: {тип: {visible, dates}}; draft: {тип: {visible?, dates?}} — только изменённые поля
  const st = { types: null, base: {}, draft: {}, error: "", busyVisible: false, busyDates: false, status: "" };
  const path = (endpoint) => `${endpoint}?object_id=${objectId}`;

  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>${canWrite ? "Настройка по умолчанию для объекта." : "Просмотр."}</strong>
        Показывать ли подпись марки на схеме и её допстроку (код контрагента, плановая дата) — по типу элемента. Переключатель «Подписи» в боковой панели схемы меняет видимость только в открытой вкладке и не сохраняется — здесь задаётся то, с чего он стартует.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="vi-body"></div>
      <p id="vi-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { st.status = t; const n = $("#vi-status"); if (n) n.textContent = t; };

  function valueOf(type, field) { return st.draft[type]?.[field] ?? st.base[type]?.[field] ?? false; }
  function setValue(type, field, v) { (st.draft[type] ||= {})[field] = v; if (st.draft[type][field] === st.base[type]?.[field]) delete st.draft[type][field]; if (!Object.keys(st.draft[type]).length) delete st.draft[type]; }
  function changed(field) { return Object.entries(st.draft).filter(([, d]) => field in d).map(([type, d]) => [type, d[field]]); }
  function dirty() { return changed("visible").length > 0 || changed("dates").length > 0; }

  function paint() {
    if (dead) return;
    const box = $("#vi-body");
    if (!objectId) { box.innerHTML = `<p class="v2-muted">Выберите объект в шапке — настройка своя у каждого объекта.</p>`; return; }
    if (!st.types) {
      box.innerHTML = st.error ? `<div class="v2-callout v2-callout-bad" role="alert"><strong>Не удалось загрузить настройку.</strong> ${esc(st.error)}
        <div class="v2-callout-actions"><button type="button" class="v2-btn" id="vi-retry">Повторить</button></div></div>` : `<p class="v2-muted" role="status">Загрузка…</p>`;
      $("#vi-retry")?.addEventListener("click", load);
      return;
    }
    if (!st.types.length) { box.innerHTML = `<p class="v2-muted">Типов элементов пока нет — они появятся при загрузке чертежа.</p>`; return; }
    const cv = changed("visible"), cd = changed("dates");
    box.innerHTML = `<div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Тип элемента</th><th>Подпись марки</th><th>Даты в допстроке</th></tr></thead><tbody>
      ${st.types.map((type) => {
        const visible = valueOf(type, "visible"), dates = valueOf(type, "dates");
        return `<tr><td>${esc(type)}</td>
          <td><label class="v2-role-check"><input type="checkbox" data-vis="${esc(type)}" ${visible ? "checked" : ""} ${canWrite ? "" : "disabled"}><span>показывать${st.draft[type]?.visible !== undefined ? " <span class=\"v2-chip\">изменено</span>" : ""}</span></label></td>
          <td><label class="v2-role-check"><input type="checkbox" data-dates="${esc(type)}" ${dates ? "checked" : ""} ${canWrite && visible ? "" : "disabled"}><span>показывать${st.draft[type]?.dates !== undefined ? " <span class=\"v2-chip\">изменено</span>" : ""}</span></label></td>
        </tr>`;
      }).join("")}
    </tbody></table></div>
    ${canWrite ? `<div class="v2-inline" style="margin-top:10px">
      <button type="button" class="v2-btn v2-primary" id="vi-save" ${dirty() ? "" : "disabled"}>Сохранить (${cv.length + cd.length})</button>
      <button type="button" class="v2-btn" id="vi-revert" ${dirty() ? "" : "disabled"}>Отменить правку</button>
      <button type="button" class="v2-btn" id="vi-refresh">Обновить</button></div>` : ""}`;
    box.querySelectorAll("[data-vis]").forEach((c) => c.addEventListener("change", () => {
      const type = c.dataset.vis;
      setValue(type, "visible", c.checked);
      if (!c.checked) setValue(type, "dates", false); // тот же каскад, что в сайдбаре схемы: выключение марки выключает и её даты
      paint();
    }));
    box.querySelectorAll("[data-dates]").forEach((c) => c.addEventListener("change", () => { setValue(c.dataset.dates, "dates", c.checked); paint(); }));
    $("#vi-save")?.addEventListener("click", save);
    $("#vi-revert")?.addEventListener("click", () => { st.draft = {}; setStatus(""); paint(); });
    $("#vi-refresh")?.addEventListener("click", () => { if (dirty()) setStatus("Сначала сохраните или отмените правку."); else load(); });
  }

  async function load() {
    if (!objectId) { paint(); return; }
    const my = ++seq;
    try {
      const [visible, dates] = await Promise.all([api.get(path("/label-visibility")), api.get(path("/label-dates-visibility"))]);
      if (dead || my !== seq) return;
      const types = [...new Set([...Object.keys(visible), ...Object.keys(dates)])].sort((a, b) => a.localeCompare(b, "ru"));
      st.types = types;
      st.base = Object.fromEntries(types.map((t) => [t, { visible: visible[t] !== false, dates: dates[t] !== false }]));
      st.error = "";
    } catch (e) {
      if (dead || my !== seq) return;
      st.types = null; st.error = errText(e);
    }
    paint();
  }

  async function save() {
    if (st.busyVisible || st.busyDates) return;
    const cv = Object.fromEntries(changed("visible")), cd = Object.fromEntries(changed("dates"));
    if (!Object.keys(cv).length && !Object.keys(cd).length) return;
    st.busyVisible = true; st.busyDates = true; paint(); setStatus("Сохранение…");
    const jobs = [];
    if (Object.keys(cv).length) jobs.push(["/label-visibility", cv, "visible"]);
    if (Object.keys(cd).length) jobs.push(["/label-dates-visibility", cd, "dates"]);
    let allOk = true, lastErr = null;
    for (const [endpoint, body, field] of jobs) {
      try { await api.put(path(endpoint), body); }
      catch (e) {
        allOk = false; lastErr = e;
        if (!unknownOutcome(e)) { for (const t of Object.keys(body)) delete st.draft[t]?.[field]; } // 4xx: эта часть не применилась — можно повторить остальные
      }
    }
    try {
      const [visible, dates] = await Promise.all([api.get(path("/label-visibility")), api.get(path("/label-dates-visibility"))]);
      st.base = Object.fromEntries(st.types.map((t) => [t, { visible: visible[t] !== false, dates: dates[t] !== false }]));
      // Правка, совпавшая с тем, что теперь хранит сервер, больше не правка (иначе после успешного сохранения экран оставался
      // «изменённым» и уход с него спрашивал о несохранённом). Не применившееся (неизвестный исход, сервер не записал) — остаётся.
      for (const t of Object.keys(st.draft)) {
        for (const f of Object.keys(st.draft[t])) { if (st.draft[t][f] === st.base[t]?.[f]) delete st.draft[t][f]; }
        if (!Object.keys(st.draft[t]).length) delete st.draft[t];
      }
      setStatus(allOk ? `Сохранено: ${Object.keys(cv).length + Object.keys(cd).length}.` : `Сохранено частично; не применилось: ${errText(lastErr)}.`);
    } catch (e) { setStatus(allOk ? "Сохранено, но перечитать не удалось — нажмите «Обновить»." : `Неизвестно, применена ли часть правок (${errText(lastErr)}). Обновите список.`); }
    st.busyVisible = false; st.busyDates = false; paint();
  }

  paint(); load();
  return {
    hasUnsavedChanges: () => dirty(),
    async guardLeave() {
      if (!dirty()) return true;
      const c = await showUnsavedDialog("Видимость подписей изменена, но не сохранена. Что сделать?");
      if (c === "cancel") return false;
      if (c === "discard") return true;
      await save();
      return !dirty();
    },
    destroy() { dead = true; },
  };
}
