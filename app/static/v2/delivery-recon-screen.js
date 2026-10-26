// «Сверка поставки по договорам» в V2: оболочка страницы вокруг общего экрана V1/V2 (app/static/delivery-recon-ui.js).
// Чтение — тем же POST /reports/delivery-recon, что у V1; выгрузка — .xlsx с тремя листами (по вкладкам).
import { mountDeliveryRecon } from "../delivery-recon-ui.js";
import { statusChip } from "./registry.js";
import { saveBlob } from "./exchange-common.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountDeliveryReconScreen(el, { screen, objectId, api, groupTitle }) {
  el.className = "v2-page";
  el.innerHTML = `<div class="v2-container v2-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}</div>
    <p class="v2-muted">${esc(screen.summary || "")}</p>
    <div id="dr-host"></div></div>`;
  el.querySelector("#dr-host").style.contain = "inline-size";
  const view = mountDeliveryRecon(el.querySelector("#dr-host"), {
    objectId,
    read: (path, body) => api.readPost(path, body),
    get: (path) => api.get(path),
    download: async (path, body, fileName) => saveBlob(await api.download(path, body), fileName),
  });
  return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() { view.destroy(); } };
}
