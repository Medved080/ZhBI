// В V1 используется тот же редактор редакций, что и в V2: один путь записи.
import { mountCraneZoneEditor } from "./v2/crane-zone-editor.js";

let active = null;

function jsonRequest(apiRequest, path, method = "GET", body) {
  const options = method === "GET" ? undefined : {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  return apiRequest(path, options);
}

export function openCraneZoneV1({ objectId, apiRequest, canEdit, onPublished, initialCategory }) {
  if (active) return;
  if (!objectId) throw new Error("Сначала выберите объект в шапке");
  const backdrop = document.createElement("div");
  backdrop.className = "cz-v1-backdrop";
  backdrop.innerHTML = `<section class="cz-v1-modal" role="dialog" aria-modal="true" aria-label="Редакции зон кранов и стоянок">
    <header class="cz-v1-head"><strong>Редакции зон кранов и стоянок</strong><button type="button" class="v2-btn" id="cz-v1-close">Закрыть</button></header>
    <div class="cz-v1-editor"></div>
  </section>`;
  document.body.appendChild(backdrop);
  const api = {
    get: (path) => jsonRequest(apiRequest, path),
    post: (path, body) => jsonRequest(apiRequest, path, "POST", body),
    patch: (path, body) => jsonRequest(apiRequest, path, "PATCH", body),
    readPost: (path, body) => jsonRequest(apiRequest, path, "POST", body),
  };
  const editor = mountCraneZoneEditor(backdrop.querySelector(".cz-v1-editor"), {
    objectId, api, canEdit, onPublished, initialCategory,
  });
  active = { backdrop, editor };
  async function close() {
    if (!active || active.backdrop !== backdrop || !(await editor.guardLeave())) return;
    editor.destroy();
    backdrop.remove();
    document.removeEventListener("keydown", onKeydown);
    active = null;
  }
  function onKeydown(event) {
    if (event.key === "Escape" && !document.querySelector(".v2-dialog-backdrop")) {
      event.preventDefault();
      close();
    }
  }
  backdrop.querySelector("#cz-v1-close").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  document.addEventListener("keydown", onKeydown);
  backdrop.querySelector("#cz-v1-close").focus();
}
