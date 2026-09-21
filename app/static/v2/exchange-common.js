// Общие части экранов «Обмен данными» V2: импорт и выгрузка файлов, сверка и применение.
//
// Что здесь. Каркас страницы, проверка файла ДО отправки (расширение, пустой, лимит сервера), блок «Требования к файлу» и образец из
// `/import-templates` (те же описания форматов, что в V1), вывод результата, сообщение о НЕИЗВЕСТНОМ исходе с проверкой по журналу и
// таблица расхождений с флажками. Никакой бизнес-логики: все разборы, сверки и записи делает сервер; клиент только показывает присланное.
//
// Правила, общие для всех операций (Docs/v2-progress/exchange.md):
//  * файл принимается тем же способом, что в V1: multipart `POST`, через `api.upload` (шлюз записи проверяет форму запроса);
//  * пока идёт операция (подтверждение + запрос), повторное нажатие игнорируется — уходит ОДИН запрос;
//  * сбой сети или оборванный ответ = неизвестный исход: автоповтора нет, человеку предлагается сверка по журналу сервера;
//  * ошибка сервера показывается его же текстом, введённое (файл, выбранные значения) остаётся на месте.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";
import { STATUS_LABEL } from "./registry.js";

export { esc };

export const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));

// Ответ сервера не получен (обрыв, нет сети) или оборван прокси (502/504): что произошло на сервере, неизвестно.
export const isUnknownOutcome = (e) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 504);

// Лимит сервера на размер загружаемого файла (app/upload_limits.py, ZHBI_MAX_UPLOAD_MB): клиент отказывает раньше, чем отправит.
export const MAX_UPLOAD_MB = 200;

export function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

// Проверка выбранного файла до отправки. Возвращает текст проблемы или null. Сервер проверяет то же самое ещё раз (он не доверяет клиенту).
export function checkFile(file, { ext }) {
  if (!file) return "Сначала выберите файл";
  const e = (file.name.split(".").pop() || "").toLowerCase();
  if (!ext.includes(e)) return `Нужен файл ${ext.map((x) => "." + x).join(" или ")} — выбран «${file.name}»`;
  if (file.size === 0) return `Файл «${file.name}» пуст`;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `Файл «${file.name}» больше ${MAX_UPLOAD_MB} МБ — сервер такой не примет`;
  return null;
}

export function pageFrame({ screen, groupTitle, summary, body }) {
  return `<div class="v2-container v2-screen v2-ex">
    <div class="v2-crumbs"><a href="#/" class="v2-link">Начало</a> › ${esc(groupTitle)}</div>
    <div class="v2-screen-head"><h2>${esc(screen.title)}</h2>
      <span class="v2-chip v2-chip-${screen.status >= 4 ? "ok" : "warn"}" title="Статус реализации в реестре охвата">${esc(STATUS_LABEL[screen.status] || "")}</span></div>
    <p class="v2-muted">${summary ?? esc(screen.summary || "")}</p>
    ${body}
  </div>`;
}

// ---- «Требования к файлу» и образец (описания форматов — с сервера, как в V1) ----
let templatesPromise = null;
export function loadTemplates(api) {
  if (!templatesPromise) {
    templatesPromise = api.get("/import-templates").then((d) => new Map((d.templates || []).map((t) => [t.key, t]))).catch(() => { templatesPromise = null; return new Map(); });
  }
  return templatesPromise;
}

function templateColumns(cols) {
  return `<h4>Колонки (заголовки — в первой строке)</h4><div class="v2-read-table"><table class="v2-read-tbl"><thead><tr><th>Колонка</th><th>Формат данных</th><th>Пример</th></tr></thead><tbody>
    ${cols.map((c) => `<tr><td>${esc(c.name)}${c.required ? "" : `<br><span class="v2-muted">необязательна</span>`}</td><td>${esc(c.format)}</td><td>${esc(c.example)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

export function templateBlockHtml(tpl) {
  const parts = [(tpl.intro || []).map((p) => `<p>${esc(p)}</p>`).join("")];
  if (tpl.sheet) parts.push(`<p><b>Лист:</b> ${esc(tpl.sheet)}</p>`);
  if (tpl.columns?.length) parts.push(templateColumns(tpl.columns));
  for (const s of tpl.sections || []) parts.push(`<h4>${esc(s.title)}</h4><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
  if (tpl.notes?.length) parts.push(`<h4>Важно</h4><ul>${tpl.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
  return `<details class="v2-collapsible v2-ex-tpl"><summary>Требования к файлу: ${esc(tpl.title)} (${esc(tpl.file_ext)})</summary><div class="v2-ex-tpl-body">${parts.join("")}</div></details>
    <div class="v2-ex-sample"><button type="button" class="v2-btn" data-sample="${esc(tpl.key)}">Скачать образец ${esc(tpl.file_ext)} (5 строк)</button>
      <span class="v2-muted">В образце — демонстрационные данные. Он нужен как шаблон для заполнения; загружать сам образец в рабочую базу не следует.</span></div>`;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Вставляет блоки требований в контейнер и вешает скачивание образца. Отсутствие описаний (нет связи) не мешает работе формы.
export async function mountTemplates(holder, api, keys, isDead) {
  const byKey = await loadTemplates(api);
  if (isDead?.() || !holder.isConnected) return;
  holder.innerHTML = keys.map((k) => (byKey.has(k) ? templateBlockHtml(byKey.get(k)) : "")).join("");
  holder.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sample]");
    if (!b || b.disabled) return;
    const label = b.textContent; b.disabled = true; b.textContent = "Готовится…";
    try {
      const { blob, filename } = await api.fetchFile(`/import-templates/${encodeURIComponent(b.dataset.sample)}/sample`);
      saveBlob(blob, filename || `obrazec_${b.dataset.sample}`);
    } catch (err) {
      const note = holder.querySelector(".v2-ex-sample-err") || holder.appendChild(Object.assign(document.createElement("p"), { className: "v2-ex-sample-err v2-bad-text", role: "alert" }));
      note.textContent = `Не удалось скачать образец: ${errText(err)}`;
    } finally { b.disabled = false; b.textContent = label; }
  });
}

// ---- строка состояния операции ----
export function makeStatus(el) {
  return {
    set(text, kind = "") { // kind: "" | "ok" | "bad" | "busy"
      el.className = `v2-ex-status${kind ? " v2-ex-" + kind : ""}`;
      el.setAttribute("role", kind === "bad" ? "alert" : "status");
      el.textContent = text;
    },
    html(h, kind = "") { el.className = `v2-ex-status${kind ? " v2-ex-" + kind : ""}`; el.setAttribute("role", kind === "bad" ? "alert" : "status"); el.innerHTML = h; },
  };
}

// ---- неизвестный исход: сверка по журналу сервера ----
// Журнал читает только тот, у кого есть право «Журнал действий»; у остальных сверка предлагается другим способом (текст `fallback`).
export async function journalEvents(api, { action, entityId, sinceMs }) {
  const q = new URLSearchParams({ action, limit: "5" });
  if (entityId) q.set("entity_id", String(entityId));
  const day = new Date(sinceMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
  q.set("date_from", day);
  const d = await api.get(`/activity?${q}`);
  const rows = (d.rows || []).map((r) => ({ at: r.at, who: r.user_name, what: r.new_value || r.old_value || "" }));
  // Журнал хранит время в UTC ("ГГГГ-ММ-ДД ЧЧ:ММ:СС.ммм")
  const after = rows.filter((r) => Date.parse(String(r.at).replace(" ", "T") + "Z") >= sinceMs - 2000);
  return { rows, after };
}

export function unknownOutcomeHtml(what) {
  return `<strong>Результат неизвестен.</strong> Ответ сервера не получен: ${esc(what)} мог быть выполнен, а мог и нет. Автоматически запрос не повторяется —
    сначала сверьтесь с сервером. <div class="v2-callout-actions"><button type="button" class="v2-btn v2-primary" data-verify>Проверить по журналу сервера</button></div>
    <div class="v2-ex-verify" data-verify-out role="status" aria-live="polite"></div>`;
}

export async function verifyOutcome(api, box, { action, entityId, sinceMs, what }) {
  const out = box.querySelector("[data-verify-out]");
  out.textContent = "Читаем журнал сервера…";
  try {
    const { rows, after } = await journalEvents(api, { action, entityId, sinceMs });
    if (after.length) {
      out.innerHTML = `<p><strong>Операция выполнена:</strong> в журнале есть событие после отправки.</p><ul>${after.map((r) => `<li>${esc(String(r.at).slice(0, 19))} — ${esc(r.who || "")}: ${esc(r.what)}</li>`).join("")}</ul>
        <p class="v2-muted">Повторно файл отправлять не нужно.</p>`;
    } else {
      out.innerHTML = `<p><strong>События после отправки в журнале нет</strong> — скорее всего, загрузка не выполнена, и её можно повторить.</p>
        ${rows.length ? `<p class="v2-muted">Последнее событие такого рода: ${esc(String(rows[0].at).slice(0, 19))} — ${esc(rows[0].what)}</p>` : ""}`;
    }
  } catch (e) {
    out.innerHTML = e instanceof ApiError && e.status === 403
      ? `Журнал действий вам недоступен — сверить автоматически нельзя. Проверьте результат в соответствующем разделе или попросите администратора посмотреть журнал (${esc(what)}).`
      : `Не удалось прочитать журнал: ${esc(errText(e))}. Проверьте результат в соответствующем разделе.`;
  }
}

// ---- список объектов и выбор объекта ----
export function objectOptions(objects, selectedId, { withKind = false } = {}) {
  return (objects || []).map((o) => `<option value="${o.id}" ${o.id === selectedId ? "selected" : ""}>${esc(o.project_name || "")}${o.project_name ? " · " : ""}${esc(o.name)}${withKind && o.kind ? ` (${o.kind === "mfr" ? "МФР" : "ЖБИ"})` : ""}</option>`).join("");
}

// ---- вывод значений ----
export const dateRu = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v ?? ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}` : String(v ?? "");
};
export const valueText = (v) => (v === null || v === undefined || v === "" ? "—" : /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(String(v)) ? dateRu(v) : String(v));

export function factsHtml(pairs) {
  const rows = pairs.filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  return rows.length ? `<dl class="v2-facts v2-ex-facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>` : "";
}

export function listHtml(title, items, { cap = 10 } = {}) {
  if (!items?.length) return "";
  const shown = items.slice(0, cap);
  return `<p class="v2-ex-list-title"><strong>${esc(title)} (${items.length}):</strong></p><ul class="v2-ex-list">${shown.map((x) => `<li>${esc(x)}</li>`).join("")}${items.length > shown.length ? `<li class="v2-muted">…и ещё ${items.length - shown.length}</li>` : ""}</ul>`;
}

// ---- таблица расхождений (сверка → отметка флажками → применение) ----
// rows: [{i, key, cells: [html...]}]; checked — Set индексов правок; onToggle(i, on); onToggleAll(on). Таблица показывает не больше `cap` строк,
// но применяются ВСЕ отмеченные (об этом сказано в сводке под таблицей).
export function changesTableHtml({ head, rows, checkedSet, cap = 800 }) {
  const shown = rows.slice(0, cap);
  const allOn = rows.length > 0 && rows.every((r) => checkedSet.has(r.i));
  const some = !allOn && rows.some((r) => checkedSet.has(r.i));
  return `<div class="v2-read-table v2-ex-changes"><table class="v2-read-tbl"><thead><tr>
    <th><input type="checkbox" data-all aria-label="Отметить все правки" ${allOn ? "checked" : ""} ${some ? 'data-indet="1"' : ""}></th>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr class="${checkedSet.has(r.i) ? "" : "v2-ex-off"}"><td><input type="checkbox" data-i="${r.i}" aria-label="Применить правку ${r.i + 1}" ${checkedSet.has(r.i) ? "checked" : ""}></td>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${rows.length > shown.length ? `<p class="v2-muted">В таблице показаны первые ${shown.length} строк из ${rows.length} — применятся все отмеченные, включая непоказанные.</p>` : ""}`;
}

// Промежуточное состояние общего флажка (отмечена часть) — вызывается после каждой перерисовки таблицы.
export function applyIndeterminate(root) { root.querySelectorAll("[data-indet]").forEach((n) => { n.indeterminate = true; }); }

// Обработчик вешается ОДИН раз на постоянный контейнер (содержимое перерисовывается, контейнер остаётся).
export function wireChangesTable(root, { onToggle, onToggleAll }) {
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-i]")) onToggle(Number(t.dataset.i), t.checked);
    else if (t.matches("[data-all]")) onToggleAll(t.checked);
  });
}
