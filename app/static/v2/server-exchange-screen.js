// Экран «Обмен данными с другим сервером» нового интерфейса (2026-10-08): рамка V2 вокруг общего с V1 модуля
// app/static/server-exchange.js. Запросы идут через api.js, то есть через шлюз записи (write-gate.js, записи `dx.*`).
import { mountServerExchange } from "../server-exchange.js";
import { statusChip } from "./registry.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountServerExchangeScreen(el, { screen, api, rights, groupTitle }) {
  el.className = "v2-page";
  el.innerHTML = `<div class="v2-container v2-screen">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>${statusChip(screen)}</div>
    <div id="sx-host"></div></div>`;
  const canWrite = !!rights?.system_admin || rights?.features?.db_transfer === "write";
  const request = (method, path, body) => {
    if (method === "GET") return api.get(path);
    if (method === "DELETE") return api.delete(path);
    return api.post(path, body);
  };
  return mountServerExchange(el.querySelector("#sx-host"), { request, canWrite });
}
