// «Внешний вид»: личные настройки пользователя из ОДНОГО модального окна V1 (menu-view-backdrop, «Настройки → Внешний вид»):
// цветовая гамма (`PATCH /users/{id}/ui-theme`), минимальный размер подписей на схеме (`PATCH /users/{id}/min-label-px`),
// начальный ракурс 3D (`PATCH /users/{id}/view3d`). Настройки личные: на данные и на других пользователей не влияют, но
// реально видны в рабочем месте «Модель: схема 2D/3D» V2 — та же сцена V1 в кадре читает те же поля пользователя.
// Тени 3D и направление солнца — настройка ЭТОГО КОМПЬЮТЕРА, как в V1: те же ключи localStorage (`zhbi_shadows_3d`,
// `zhbi_sun_3d_mode`), их читает сцена V1 при загрузке — и в текущем интерфейсе, и в кадре рабочего места V2 (тот же origin).
// Меню «Действия» V1 (вид меню и личный порядок пунктов, menu_prefs) не переносится — решение пользователя: его аналог в V2 —
// левая навигация со своим порядком и избранным (shell-nav.js, shell-prefs.js). Внешние 3D-модели (благоустройство, фасады)
// включаются на вкладке «Вид» рабочего места — там, где открыта сцена (в V1 эти флажки тоже действуют только до перезагрузки).
// Барьер: одна запись за раз; успех — после ответа сервера и повторного чтения `/me` (показывается то, что хранит сервер);
// границы значений (4–40 px; подъём камеры 1–89°, поворот замыкается по кругу) проверяет сервер, здесь — только числовой ввод.
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { statusChip } from "./registry.js";

const MIN_LABEL_PX_MIN = 4, MIN_LABEL_PX_MAX = 40;
const SHADOWS_KEY = "zhbi_shadows_3d", SUN_KEY = "zhbi_sun_3d_mode";   // те же ключи, что у V1 (app.js: SHADOWS_3D_KEY, SUN_3D_MODE_KEY)
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const VIEW3D_PITCH_MIN = 1, VIEW3D_PITCH_MAX = 89;

const SKINS = [
  { id: "gos", name: "Базовый", swatch: ["#FAFCFF", "#EDF2FE", "#0D4CD3"] },
  { id: "msu", name: "МСУ-1", swatch: ["#FBF7F7", "#F6E6E6", "#A31212"] },
  { id: "graphite", name: "Графит", swatch: ["#14161A", "#23272E", "#7AA2F7"] },
  { id: "indigo", name: "Индиго", swatch: ["#10121F", "#202441", "#8B9DFF"] },
  { id: "neon", name: "Неон", swatch: ["#0B0A12", "#2A2247", "#FCEE0A"] },
  { id: "emerald", name: "Изумруд", swatch: ["#F6FBF8", "#E1F1E9", "#0E8A5F"] },
  { id: "sand", name: "Песок", swatch: ["#FAF7F2", "#F6E9D6", "#B4690E"] },
];
const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

export function mountAppearanceEdit(el, { screen, structure, objectId, api, user, applyTheme, groupTitle }) {
  el.className = "v2-page";
  let dead = false, busy = false, labelBusy = false, viewBusy = false;
  let current = user.ui_theme || "gos";
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        ${statusChip(screen)}</div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Личные настройки.</strong> Гамма, порог подписей и ракурс 3D сохраняются за вами и переезжают на другой компьютер; тени и солнце в 3D — настройка этого компьютера (браузера). На данные и на других пользователей не влияют. Порядок и избранное разделов настраиваются в самой левой навигации (вместо меню «Действия» текущего интерфейса); показ внешних 3D-моделей — на вкладке «Вид» рабочего места.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <h3 class="v2-report-h">Цветовая гамма</h3>
      <div id="ap-body" class="v2-cards" role="group" aria-label="Цветовая гамма"></div>
      <p id="ap-status" class="v2-muted" role="status" aria-live="polite"></p>
      <h3 class="v2-report-h">Подписи и 3D</h3>
      <div class="v2-fields" style="max-width:520px">
        <label class="v2-field">Минимальный размер подписей на схеме, px (${MIN_LABEL_PX_MIN}–${MIN_LABEL_PX_MAX})
          <input type="number" id="ap-minlabel" min="${MIN_LABEL_PX_MIN}" max="${MIN_LABEL_PX_MAX}" step="1" value="${user.min_label_px ?? 12}"></label>
        <div></div>
        <label class="v2-field">Подъём камеры 3D, ° (${VIEW3D_PITCH_MIN}–${VIEW3D_PITCH_MAX})
          <input type="number" id="ap-pitch" min="${VIEW3D_PITCH_MIN}" max="${VIEW3D_PITCH_MAX}" step="1" value="${user.view3d_pitch_deg ?? 55}"></label>
        <label class="v2-field">Поворот камеры 3D, °
          <input type="number" id="ap-yaw" step="1" value="${user.view3d_yaw_deg ?? 0}"></label>
      </div>
      <div class="v2-inline" style="margin-top:8px">
        <button type="button" class="v2-btn v2-primary" id="ap-minlabel-save">Сохранить порог подписей</button>
        <button type="button" class="v2-btn v2-primary" id="ap-view3d-save">Сохранить ракурс 3D</button>
      </div>
      <p id="ap-view-status" class="v2-muted" role="status" aria-live="polite"></p>
      <h3 class="v2-report-h">Тени и солнце в 3D</h3>
      <label class="v2-role-check"><input type="checkbox" id="ap-shadows" ${lsGet(SHADOWS_KEY) === "1" ? "checked" : ""}><span>Солнце и тени — силуэт здания на земле и затенение элементов друг другом</span></label>
      <p class="v2-muted">В режиме «3D лёгкий» тени не включаются: он рассчитан на слабые компьютеры и удалённый рабочий стол.</p>
      <fieldset style="border:0;padding:0;margin:8px 0 0"><legend class="v2-muted">Направление солнца</legend>
        <label class="v2-role-check"><input type="radio" name="ap-sun" value="model" ${lsGet(SUN_KEY) === "camera" ? "" : "checked"}><span>Относительно модели — солнце стоит над стройкой, при вращении тень остаётся на своей стороне здания</span></label>
        <label class="v2-role-check"><input type="radio" name="ap-sun" value="camera" ${lsGet(SUN_KEY) === "camera" ? "checked" : ""}><span>Относительно камеры — освещённая сторона всегда обращена к смотрящему (с тенями дороже: карта теней пересчитывается при вращении)</span></label>
      </fieldset>
      <p class="v2-muted">Настройка этого компьютера: хранится в браузере и не меняется у других пользователей. Применяется при открытии схемы рабочего места (и в текущем интерфейсе на этом компьютере). По умолчанию — без теней, солнце относительно модели.</p>
      <p id="ap-light-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#ap-status"); if (n) n.textContent = t; };
  const setViewStatus = (t) => { const n = $("#ap-view-status"); if (n) n.textContent = t; };
  function paint() {
    if (dead) return;
    $("#ap-body").innerHTML = SKINS.map((s) => `<button type="button" class="v2-card v2-skin" data-skin="${s.id}" aria-pressed="${s.id === current}" ${busy ? "disabled" : ""}>
      <strong>${esc(s.name)}</strong> ${s.id === current ? `<span class="v2-chip v2-chip-ok">выбрана</span>` : ""}
      <span class="v2-skin-swatch">${s.swatch.map((c) => `<span style="background:${c}"></span>`).join("")}</span></button>`).join("");
    $("#ap-minlabel").disabled = labelBusy;
    $("#ap-minlabel-save").disabled = labelBusy;
    $("#ap-pitch").disabled = viewBusy; $("#ap-yaw").disabled = viewBusy; $("#ap-view3d-save").disabled = viewBusy;
  }
  const nameOf = (id) => SKINS.find((s) => s.id === id)?.name || id;
  // Общий объект user и тема окна обновляются по повторному чтению даже после ухода с экрана: гамма уже сохранена на сервере.
  function adopt(me) {
    user.ui_theme = me.ui_theme; user.min_label_px = me.min_label_px; user.view3d_pitch_deg = me.view3d_pitch_deg; user.view3d_yaw_deg = me.view3d_yaw_deg;
    applyTheme?.(me.ui_theme); if (!dead) current = me.ui_theme || "gos";
  }
  async function choose(id) {
    if (busy || id === current) return;
    busy = true; paint(); setStatus("Сохранение…");
    let known = true; // ответ на запись получен
    try {
      await api.patch(`/users/${user.id}/ui-theme`, { ui_theme: id });
    } catch (e) {
      if (e instanceof ApiError && e.status > 0 && e.status < 500) { // отказ сервера: записи не было
        busy = false; if (!dead) { setStatus(`Не удалось сохранить: ${errText(e)}`); paint(); }
        return;
      }
      known = false; // сеть/5xx — исход неизвестен: повторно не отправляем, сначала читаем
    }
    try {
      const me = await api.get("/me");
      adopt(me);
      const ok = (me.ui_theme || "gos") === id;
      if (!dead) setStatus(ok ? (known ? `Гамма «${nameOf(id)}» сохранена и подтверждена чтением.` : "Сервер сохранил гамму, хотя ответ не дошёл.")
        : known ? "Сервер вернул другую гамму — проверьте." : `Изменение не подтверждено. Выбор остался прежним — повторите вручную.`);
    } catch (e) {
      if (!dead) setStatus(known ? "Гамма отправлена, но перечитать не удалось — обновите страницу и проверьте." : `Неизвестно, сохранена ли гамма (${errText(e)}). Обновите страницу и проверьте.`);
    } finally { busy = false; if (!dead) paint(); }
  }
  async function saveMinLabel() {
    if (labelBusy) return;
    const value = Number($("#ap-minlabel").value);
    if (!Number.isFinite(value)) { setViewStatus("Порог задаётся числом."); return; }
    labelBusy = true; paint(); setViewStatus("Сохранение порога подписей…");
    let known = true;
    try { await api.patch(`/users/${user.id}/min-label-px`, { min_label_px: value }); }
    catch (e) {
      if (e instanceof ApiError && e.status > 0 && e.status < 500) { labelBusy = false; if (!dead) { setViewStatus(`Не удалось сохранить: ${errText(e)}`); paint(); } return; }
      known = false;
    }
    try {
      const me = await api.get("/me"); adopt(me);
      $("#ap-minlabel").value = me.min_label_px;
      setViewStatus(known ? "Порог подписей сохранён и подтверждён чтением." : (me.min_label_px === value ? "Сервер сохранил порог, хотя ответ не дошёл." : "Изменение не подтверждено — проверьте значение."));
    } catch (e) { setViewStatus(known ? "Сохранено, но перечитать не удалось — обновите страницу." : `Неизвестно, сохранено ли (${errText(e)}).`); }
    finally { labelBusy = false; if (!dead) paint(); }
  }
  async function saveView3d() {
    if (viewBusy) return;
    const pitch = Number($("#ap-pitch").value), yaw = Number($("#ap-yaw").value);
    if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) { setViewStatus("Углы задаются числами."); return; }
    viewBusy = true; paint(); setViewStatus("Сохранение ракурса…");
    let known = true;
    try { await api.patch(`/users/${user.id}/view3d`, { view3d_pitch_deg: pitch, view3d_yaw_deg: yaw }); }
    catch (e) {
      if (e instanceof ApiError && e.status > 0 && e.status < 500) { viewBusy = false; if (!dead) { setViewStatus(`Не удалось сохранить: ${errText(e)}`); paint(); } return; }
      known = false;
    }
    try {
      const me = await api.get("/me"); adopt(me);
      $("#ap-pitch").value = me.view3d_pitch_deg; $("#ap-yaw").value = me.view3d_yaw_deg;
      setViewStatus(known ? "Ракурс сохранён и подтверждён чтением (поворот сервер приводит к диапазону ±180°)." : "Сервер сохранил ракурс, хотя ответ не дошёл.");
    } catch (e) { setViewStatus(known ? "Сохранено, но перечитать не удалось — обновите страницу." : `Неизвестно, сохранено ли (${errText(e)}).`); }
    finally { viewBusy = false; if (!dead) paint(); }
  }
  // Тени и солнце: записываются сразу при переключении (как в V1), без запроса к серверу.
  el.addEventListener("change", (e) => {
    const n = $("#ap-light-status");
    if (e.target.id === "ap-shadows") {
      const ok = lsSet(SHADOWS_KEY, e.target.checked ? "1" : "0");
      if (n) n.textContent = ok ? (e.target.checked ? "Тени включены на этом компьютере." : "Тени выключены на этом компьютере.") : "Браузер не дал сохранить настройку (хранилище недоступно).";
    } else if (e.target.name === "ap-sun" && e.target.checked) {
      const ok = lsSet(SUN_KEY, e.target.value === "camera" ? "camera" : "model");
      if (n) n.textContent = ok ? `Солнце — относительно ${e.target.value === "camera" ? "камеры" : "модели"}.` : "Браузер не дал сохранить настройку (хранилище недоступно).";
    }
  });
  el.addEventListener("click", (e) => {
    // Только карточки выбора гаммы: оболочка ставит data-skin и на <html> (main.js applyThemeFamily) — без ограничения #ap-body
    // любой щелчок находил <html> и выходил, и «Сохранить порог подписей»/«Сохранить ракурс 3D» молча не срабатывали.
    const b = e.target.closest("#ap-body [data-skin]"); if (b) { choose(b.dataset.skin); return; }
    if (e.target.id === "ap-minlabel-save") saveMinLabel();
    else if (e.target.id === "ap-view3d-save") saveView3d();
  });
  paint();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}
