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

// Небольшой набор ГЕНЕРИЧЕСКИХ значков (2026-09-22, оболочка V2 — свёрнутая
// левая навигация и выбор объекта в шапке): тот же стиль, что у иконки
// корзины выше (viewBox 0 0 16 16, обводка currentColor 1.4). Не привязаны к
// конкретному разделу — новый экран без записи в ICON_PATHS получает
// значок "group" (нейтральные квадраты), а не падает и не остаётся пустым.
const ICON_PATHS = {
  // Гамбургер (кнопка «Меню» свёрнутой навигации)
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  // Лупа (кнопка «Найти раздел»)
  search: '<circle cx="6.8" cy="6.8" r="4.1"/><path d="M9.9 9.9 13.3 13.3"/>',
  // Домик («Начало»)
  home: '<path d="M2.5 7.4 8 3l5.5 4.4"/><path d="M4 6.3V13h8V6.3"/><path d="M6.4 13V9.6h3.2V13"/>',
  // Булавка (закрепление объекта/группы) — контурная
  pin: '<path d="M6.2 2.5h3.6l.4 3.4 2 2.4-.4 1.1H4.2l-.4-1.1 2-2.4z"/><path d="M8 9.4V13.5"/>',
  // Куб (рабочее место «Модель: схема 2D/3D»)
  cube: '<path d="M8 2.6 13 5.3v5.4L8 13.4 3 10.7V5.3z"/><path d="M3 5.3 8 8l5-2.7"/><path d="M8 8v5.4"/>',
  // Стопка этажей (рабочие места МФР/учёта по блокам)
  layers: '<path d="M8 2.6 13.3 5.3 8 8 2.7 5.3z"/><path d="m3 7.6 5 2.6 5-2.6"/><path d="m3 10 5 2.6 5-2.6"/>',
  // Список с галочками (АРМ комплектовщика)
  checklist: '<path d="M3 4.4h8.5M3 8h8.5M3 11.6h5.5"/><path d="m11.6 10.2 1 1 2-2.2"/>',
  // Каска (АРМ прораба)
  hardhat: '<path d="M3 11.2a5 4 0 0 1 10 0z"/><path d="M2.4 11.2h11.2"/><path d="M8 5.4V2.6"/>',
  // Сетка (плоская шахматка)
  grid: '<rect x="2.6" y="2.6" width="4.6" height="4.6"/><rect x="8.8" y="2.6" width="4.6" height="4.6"/><rect x="2.6" y="8.8" width="4.6" height="4.6"/><rect x="8.8" y="8.8" width="4.6" height="4.6"/>',
  // Метка на карте (карта проектов)
  map: '<path d="M8 13.4S3.4 9 3.4 6a4.6 4.6 0 1 1 9.2 0c0 3-4.6 7.4-4.6 7.4z"/><circle cx="8" cy="6" r="1.7"/>',
  // Нейтральный значок по умолчанию — квадраты (раздел без своего значка)
  group: '<rect x="2.6" y="2.6" width="4" height="4" rx=".6"/><rect x="9.4" y="2.6" width="4" height="4" rx=".6"/><rect x="2.6" y="9.4" width="4" height="4" rx=".6"/><rect x="9.4" y="9.4" width="4" height="4" rx=".6"/>',
};

/** Голый <svg> значка (без обёртки-кнопки — вызывающий код сам решает, куда его вставить). */
export function svgIcon(name, { size = 16 } = {}) {
  const body = ICON_PATHS[name] || ICON_PATHS.group;
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="${size}" height="${size}">${body}</svg>`;
}

/** Булавка ЗАЛИТЫМ цветом (нажатое состояние «закреплено» — отличимо от контурной без обводки другого цвета). */
export function pinFilledSvg({ size = 16 } = {}) {
  return `<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.3"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="${size}" height="${size}">${ICON_PATHS.pin}</svg>`;
}
