// Вложения изделия в карточке экрана «Операции над элементами» (модель ЖБИ, АРМ прораба) — перенос из V1 (app.js: renderAttachments,
// вызывается из showCard). Тот же набор маршрутов, что и у вложений проекта/объекта (app/static/v2/projects-objects.js: mountAttachments) —
// /attachments, /attachments/{id}/download, DELETE /attachments/{id} — но самостоятельная реализация: карточка изделия перерисовывается
// на каждый выбор (element-ops.js:cardHtml), и общий цикл рендера/подписки нельзя развязать с чужим модулем без импорта из него.
// Права — по объекту изделия, разделы «attachments» (читать/приложить) и «attachments_delete» (удалить); считает и передаёт вызывающая
// сторона (element-ops.js:R), здесь только отрисовка и запросы.
import { esc } from "./screen-view.js";
import { ApiError } from "./api.js";
import { showConfirmDialog } from "./dialogs.js";
import { trashIconHtml } from "./icons.js";

const ATTACHMENT_ICON = "📎";
const formatSize = (bytes) => (bytes < 1024 ? `${bytes} Б` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`);

async function downloadAttachment(id, name) {
  const res = await fetch(`/attachments/${id}/download`, { credentials: "same-origin" });
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return true;
}

/** Состояние блока вложений ОДНОГО изделия: {loaded, error, items, busy}. Создаётся вызывающей стороной (по одному на карточку — element-ops.js:F). */
export function attachState() { return { loaded: false, loading: false, error: "", items: [], busy: false, uploadStatus: "" }; }

/** Разметка блока (внутри карточки изделия). st — attachState(); {canUpload, canDelete}. */
export function attachmentsHtml(st, { canUpload, canDelete }) {
  if (!st.loaded) return `<p class="v2-muted">${st.loading ? "Загрузка…" : ""}</p>`;
  if (st.error) return `<p class="v2-muted">Не удалось загрузить список: ${esc(st.error)}</p>`;
  const rows = st.items.length ? st.items.map((a) => `<div class="v2-attach-row">
      <button type="button" class="v2-link" data-ea="dl" data-id="${a.id}" data-name="${esc(a.filename)}" title="Скачать">${ATTACHMENT_ICON} ${esc(a.filename)}</button>
      <span class="v2-muted v2-attach-meta">${esc(formatSize(a.size))}${a.description ? " · " + esc(a.description) : ""} · ${esc(a.uploaded_by || "—")}, ${esc((a.uploaded_at || "").slice(0, 16))}</span>
      ${canDelete ? trashIconHtml(`data-ea="del" data-id="${a.id}"`, `Удалить вложение ${a.filename}`) : ""}
    </div>`).join("") : `<p class="v2-muted">Файлов нет.</p>`;
  return `<div class="eo-attach">${rows}${canUpload ? `
      <div class="v2-inline" style="margin-top:8px">
        <input type="file" id="eo-attach-file" aria-label="Файлы для вложения" multiple ${st.busy ? "disabled" : ""}>
        <input type="text" id="eo-attach-desc" aria-label="Описание вложения" placeholder="описание (необязательно)" maxlength="500" ${st.busy ? "disabled" : ""}>
        <button type="button" class="v2-btn" id="eo-attach-add" ${st.busy ? "disabled" : ""}>${st.busy ? "Загрузка…" : "Приложить"}</button>
      </div>
      <div class="v2-muted" id="eo-attach-status" style="margin-top:6px">${esc(st.uploadStatus)}</div>` : ""}</div>`;
}

/** Первая загрузка списка (id — изделие). repaint зовётся после смены st. */
export async function loadAttachments(api, st, elementId, repaint) {
  st.loading = true; st.error = ""; repaint();
  try {
    const d = await api.get(`/attachments?entity_type=element&entity_id=${elementId}`);
    st.items = d.attachments; st.loaded = true;
  } catch (err) { st.error = err instanceof ApiError ? err.detail : (err.message || "нет связи"); st.loaded = true; }
  finally { st.loading = false; repaint(); }
}

/** Обработчики блока — вызывается из bind(body) карточки. */
export function bindAttachments(body, api, st, elementId, { canDelete }, repaint) {
  body.querySelectorAll('[data-ea="dl"]').forEach((b) => b.addEventListener("click", async () => {
    if (!(await downloadAttachment(b.dataset.id, b.dataset.name))) { st.error = "Не удалось скачать файл"; repaint(); }
  }));
  if (canDelete) body.querySelectorAll('[data-ea="del"]').forEach((b) => b.addEventListener("click", async () => {
    if (st.busy) return;
    const id = Number(b.dataset.id);
    const name = st.items.find((a) => a.id === id)?.filename || "";
    const ok = await showConfirmDialog(`Удалить вложение «${name}»? Восстановить его будет нечем.`, { confirmLabel: "Удалить", danger: true });
    if (!ok) return;
    st.busy = true; repaint();
    try {
      const d = await api.delete(`/attachments/${id}`);
      st.items = d.attachments;
    } catch (err) {
      // Сверка с сервером: при обрыве связи или ошибке удаление могло состояться — повторно ничего не отправляем, список читается заново.
      try { const d2 = await api.get(`/attachments?entity_type=element&entity_id=${elementId}`); st.items = d2.attachments; }
      catch (e2) { /* список оставлен как был — ошибка ниже всё равно показана */ }
      st.error = err instanceof ApiError ? err.detail : "Не удалось удалить вложение";
    } finally { st.busy = false; repaint(); }
  }));
  const addBtn = body.querySelector("#eo-attach-add");
  if (addBtn) addBtn.addEventListener("click", async () => {
    if (st.busy) return;
    const fileInput = body.querySelector("#eo-attach-file");
    if (!fileInput.files.length) { st.uploadStatus = "Выберите файл."; repaint(); return; }
    const desc = body.querySelector("#eo-attach-desc")?.value.trim() || "";
    st.busy = true; st.uploadStatus = ""; repaint();
    let latest = st.items;
    try {
      // По одному файлу за запрос (как в V1): отказ на N-м не теряет уже загруженные раньше.
      for (const file of fileInput.files) {
        st.uploadStatus = `Загрузка: ${file.name}…`; repaint();
        const fd = new FormData();
        fd.append("entity_type", "element"); fd.append("entity_id", String(elementId)); fd.append("description", desc); fd.append("file", file);
        latest = (await api.upload("/attachments", fd)).attachments;
      }
      st.items = latest; st.uploadStatus = "";
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : (err.message || "");
      // Сверяемся с сервером: часть файлов могла загрузиться до сбоя. Повторно ничего не отправляем.
      try { const d2 = await api.get(`/attachments?entity_type=element&entity_id=${elementId}`); st.items = d2.attachments; st.uploadStatus = `Не удалось: ${msg} Список показывает то, что реально есть на сервере.`; }
      catch (e2) { st.uploadStatus = "Не удалось: " + msg; }
    } finally { st.busy = false; repaint(); }
  });
}
