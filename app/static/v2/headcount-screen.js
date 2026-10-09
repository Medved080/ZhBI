// «Численность персонала» в V2: ввод по подрядчикам и видам работ, подрядчики объекта, отчёты факта и (администратору сервиса)
// загрузка данных. Экран ОБЩИЙ с V1 — `app/static/headcount-ui.js` (логика и разметка одни; здесь только оболочка страницы и
// транспорт V2: запись идёт через шлюз `write-gate.js` — строки `hc.*` в его таблице). Права и срок считает сервер (app/headcount.py).
import { mountHeadcount } from "../headcount-ui.js";
import { showConfirmDialog } from "./dialogs.js";
import { statusChip } from "./registry.js";
import { saveBlob } from "./exchange-common.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountHeadcountScreen(el, { screen, objectId, api, rights, groupTitle }) {
  el.className = "v2-page v2-app";
  const admin = !!rights?.system_admin;
  const canWrite = admin || rights?.features?.headcount === "write";
  el.innerHTML = `<div class="v2-container v2-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}
      <span class="v2-muted">${canWrite ? "можно вносить и править численность" : "только просмотр"}</span></div>
    <p class="v2-muted">${esc(screen.summary || "")}</p>
    <div id="hc-host"></div></div>`;
  // Страница V2 — flex-колонка со «сжимающимся по содержимому» контейнером: таблица с minimum-шириной раздувала его шире экрана
  // телефона. Нулевая внутренняя ширина корня (contain) оставляет ширину за страницей, а таблицы прокручиваются внутри себя.
  el.querySelector("#hc-host").style.contain = "inline-size";
  const view = mountHeadcount(el.querySelector("#hc-host"), {
    api, upload: (path, form) => api.upload(path, form), objectId,
    download: async (url) => saveBlob(await api.download(url, undefined, { method: "GET" }), "Численность.xlsx"), canWrite, canAdmin: admin,
    confirm: (text, { danger = false } = {}) => showConfirmDialog(text, { confirmLabel: danger ? "Да, продолжить" : "Продолжить", danger, multiline: true }),
  });
  return {
    hasUnsavedChanges: () => view.hasUnsavedChanges(),
    guardLeave: async () => !view.hasUnsavedChanges() || await showConfirmDialog("В карточке есть несохранённые строки. Уйти без сохранения?", { confirmLabel: "Уйти", danger: true }),
    destroy() { view.destroy(); },
  };
}
