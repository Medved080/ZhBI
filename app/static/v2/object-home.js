// V2: «Карточка объекта» — заглавная страница объекта (2026-10-06, запрос пользователя после протокола «Развитие WEB 4Q26»).
//
// Открывается при каждом выборе объекта в переключателе шапки (main.js: changeObject(id, { card: true })) и при переходе на объект с карты проектов;
// показывает паспорт объекта на весь экран: слева — реквизиты, проектная команда и показатели учёта, справа — карта с отметкой места расположения.
// Отсюда переходят в рабочие места и отчёты.
//
// С 2026-10-20 это единая форма объекта (отрисовка — object-card.js): тем, кто может открывать «Проекты и объекты», в ней же доступна правка —
// кнопка «Изменить реквизиты» переключает карточку в форму-редактор того раздела (projects-objects.js в режиме одного объекта, без дерева).
// Остальным остаётся чтение.
import { renderObjectCard } from "./object-card.js";
import { mountProjectsObjects } from "./projects-objects.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountObjectHome(el, ctx) {
  const { api, objectId, go, isAllowed } = ctx;
  // Право править = право открыть раздел «Проекты и объекты»: редактор тот же, ничего не дублируется.
  if (isAllowed?.("projects-objects")) return mountProjectsObjects(el, { ...ctx, only: objectId });

  let dead = false, card = null;
  el.className = "v2-page v2-app";   // без собственной прокрутки: страница по высоте равна рабочей области
  el.innerHTML = `<div class="oh-page"><p class="v2-muted">Загрузка…</p></div>`;
  const page = el.querySelector(".oh-page");

  (async () => {
    try {
      const list = await api.get("/objects");
      if (dead) return;
      const o = list.find((x) => x.id === objectId);
      if (!o) { page.innerHTML = `<p class="v2-note">Объект недоступен или не найден.</p>`; return; }
      card = renderObjectCard(page, o, { api, go, isAllowed });
    } catch (e) {
      if (!dead) page.innerHTML = `<p class="v2-auth-error" role="alert">Не удалось загрузить объект: ${esc(e?.detail || e?.message || e)}</p>`;
    }
  })();

  return {
    hasUnsavedChanges: () => false,
    guardLeave: async () => true,
    destroy: () => { dead = true; card?.destroy(); card = null; },
  };
}
