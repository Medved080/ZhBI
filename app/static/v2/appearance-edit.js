// «Внешний вид»: личная цветовая гамма пользователя (`PATCH /users/{id}/ui-theme`, как в V1). Настройка личная: на данные и на
// других пользователей не влияет. V2 применяет к себе семейство гаммы (светлая/тёмная); полная палитра гаммы в V2 не перенесена,
// а параметры 3D-сцены (ракурс, тени, подписи, меню «Действия») остаются в V1.
// Барьер: одна запись за раз; успех — после ответа сервера и повторного чтения `/me` (показывается то, что хранит сервер).
import { ApiError } from "./api.js";
import { esc, linkList } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

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
  let dead = false, busy = false;
  let current = user.ui_theme || "gos";
  el.innerHTML = `
    <div class="v2-container v2-screen">
      <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
      <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
        <span class="v2-chip v2-chip-warn" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
      <p class="v2-muted">${esc(screen.summary || "")}</p>
      <div class="v2-callout" role="note"><strong>Цветовая гамма — личная настройка.</strong> Сохраняется за вами и переезжает на другой компьютер; на данные и на других пользователей не влияет. В новом интерфейсе применяется светлая или тёмная схема выбранной гаммы; параметры 3D-сцены и меню «Действия» — в текущем интерфейсе.
        <div class="v2-callout-actions">${linkList(screen, structure, objectId)}</div></div>
      <div id="ap-body" class="v2-cards" role="group" aria-label="Цветовая гамма"></div>
      <p id="ap-status" class="v2-muted" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const setStatus = (t) => { const n = $("#ap-status"); if (n) n.textContent = t; };
  function paint() {
    if (dead) return;
    $("#ap-body").innerHTML = SKINS.map((s) => `<button type="button" class="v2-card v2-skin" data-skin="${s.id}" aria-pressed="${s.id === current}" ${busy ? "disabled" : ""}>
      <strong>${esc(s.name)}</strong> ${s.id === current ? `<span class="v2-chip v2-chip-ok">выбрана</span>` : ""}
      <span class="v2-skin-swatch">${s.swatch.map((c) => `<span style="background:${c}"></span>`).join("")}</span></button>`).join("");
  }
  async function choose(id) {
    if (busy || id === current) return;
    busy = true; paint(); setStatus("Сохранение…");
    try {
      await api.patch(`/users/${user.id}/ui-theme`, { ui_theme: id });
      const me = await api.get("/me");
      if (dead) return;
      current = me.ui_theme || "gos"; user.ui_theme = me.ui_theme;
      applyTheme?.(me.ui_theme);
      setStatus(current === id ? `Гамма «${SKINS.find((s) => s.id === id).name}» сохранена и подтверждена чтением.` : "Сервер вернул другую гамму — проверьте.");
    } catch (e) {
      if (!dead) setStatus(`Не удалось сохранить: ${errText(e)}`);
    } finally { busy = false; paint(); }
  }
  el.addEventListener("click", (e) => { const b = e.target.closest("[data-skin]"); if (b) choose(b.dataset.skin); });
  paint();
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { dead = true; } };
}
