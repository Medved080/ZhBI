// Общие иконки V2 — та же разметка, что и у соответствующей иконки в V1
// (app/static/app.js: trashButtonHtml), чтобы не заводить новый визуальный
// язык (issue из ТЗ: "не придумывай новый визуальный стиль", "замени
// emoji-корзины единообразными иконками из уже используемого набора").
// V2 не подключает app.js — переиспользуется только сама разметка SVG,
// без какого-либо общего кода/состояния с V1.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function trashIconHtml(attrs = "", title = "Удалить") {
  const t = escapeHtml(title);
  return `<button type="button" class="v2-icon-btn" ${attrs} title="${t}" aria-label="${t}">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16">
      <path d="M2.5 4h11M6.5 4V2.6h3V4M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4"/>
      <path d="M6.6 6.6v5M9.4 6.6v5"/>
    </svg>
  </button>`;
}
