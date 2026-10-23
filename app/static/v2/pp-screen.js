// «Производственная программа» в V2: сроки работ и остаток денег по объектам и группам (2026-10-23, Docs/pp-money.md).
// Экран ОБЩИЙ с V1 — `app/static/pp/pp-ui.js` (разметка, жесты и расчёт одни; здесь только оболочка страницы и транспорт V2: запись идёт через
// шлюз `write-gate.js` — строки `pp.*` в его таблице). Права и данные проверяет сервер (app/pp.py).
import { mountPp } from "../pp/pp-ui.js";
import { showConfirmDialog } from "./dialogs.js";
import { statusChip } from "./registry.js";
import { saveBlob } from "./exchange-common.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountPpScreen(el, { screen, api, rights, groupTitle }) {
  el.className = "v2-page";
  const admin = !!rights?.system_admin;
  const canWrite = admin || rights?.features?.pp === "write";
  const canAdmin = admin || rights?.features?.pp_admin === "write";
  el.innerHTML = `<div class="v2-container v2-screen" style="max-width:none">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}
      <span class="v2-muted">${canWrite ? "можно менять общие сроки и группы" : "только просмотр"}</span></div>
    <p class="v2-muted">${esc(screen.summary || "")}</p>
    <div id="pp-host"></div></div>`;
  // Широкая диаграмма прокручивается внутри себя, страница не должна раздуваться (как у «Численности»).
  el.querySelector("#pp-host").style.contain = "inline-size";
  const view = mountPp(el.querySelector("#pp-host"), {
    api, upload: (path, form) => api.upload(path, form), canWrite, canAdmin,
    download: async (path, body, filename) => saveBlob(await api.download(path, body), filename || "ПП.xlsx"),
    confirm: (text, { danger = false } = {}) => showConfirmDialog(text, { confirmLabel: danger ? "Да, продолжить" : "Продолжить", danger, multiline: true }),
  });
  return {
    hasUnsavedChanges: () => view.hasUnsavedChanges(),
    guardLeave: async () => true,
    destroy() { view.destroy(); },
  };
}
