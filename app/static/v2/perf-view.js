// «Замеры производительности» (2026-10-23): рамка V2 вокруг общего с V1 модуля app/static/perf-panel.js (классический скрипт, глобальный
// `window.zhbiPerfPanel`, подключён в index.html). Запросы идут через api.js, то есть через шлюз записи (записи `perf.*`).
import { frame } from "./admin-common.js";
import { showConfirmDialog } from "./dialogs.js";

export function mountPerfView(el, { screen, api, groupTitle }) {
  const body = frame(el, screen, groupTitle);
  if (!window.zhbiPerfPanel) {
    body.innerHTML = `<p class="v2-muted">Модуль замеров не загрузился — обновите страницу.</p>`;
    return { hasUnsavedChanges: () => false, guardLeave: async () => true, destroy() {} };
  }
  const request = (method, path, data) => (method === "GET" ? api.get(path) : api.post(path, data));
  const confirm = (text) => showConfirmDialog(text, { confirmLabel: "Очистить", danger: true });
  return window.zhbiPerfPanel.mount(body, { request, confirm });
}
