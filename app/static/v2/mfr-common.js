// Общие части «Учёта по блокам» и рабочего места МФР в V2: разбор ошибок, даты, модальное окно, запись с честным исходом.
// Те же API и права, что у V1 (раздел `work_progress`); каждая запись идёт через `api.js` и шлюз `write-gate.js`.
import { ApiError } from "./api.js";
import { esc } from "./screen-view.js";

export { esc };
export const errText = (e) => (e instanceof ApiError ? e.detail : String(e?.message || e));
// Исход неизвестен: ответа нет или сервер упал ПОСЛЕ приёма запроса. Автоповтора нет — сначала сверка чтением.
export const unknownOutcome = (e) => e instanceof ApiError && !e.blockedByPolicy && (e.status === 0 || e.status >= 500);
// Конфликт устаревших данных: сервер ничего не менял (409 с `conflict: true` и перечнем).
export const isConflict = (e) => e instanceof ApiError && e.status === 409 && e.rawDetail && typeof e.rawDetail === "object" && e.rawDetail.conflict === true;
export const conflictItems = (e) => (isConflict(e) && Array.isArray(e.rawDetail.items) ? e.rawDetail.items : []);

export const fmtDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}.${m[1]}` : ""; };
export const shortDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); return m ? `${m[3]}.${m[2]}` : "—"; };
export const fmtMoment = (v) => {
  if (!v) return "";
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");  // сервер отдаёт UTC без пояса
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
};
export const todayIso = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
export const isRealDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
export const isPercent = (v) => Number.isInteger(v) && v >= 0 && v <= 100;

export const DEADLINE = {
  on_track: "в графике", behind: "отстаёт", overdue: "просрочена", not_started_on_time: "не начата в срок", no_dates: "без сроков",
};
export const WORK_STATUS = { plan: "не начата", in_progress: "в работе", done: "выполнена" };

// Права раздела «Учёт по блокам» на объекте: `rights` — ответ /me/permissions?object_id= (как в main.js).
export function canAccounting(rights, level) {
  if (!rights) return false;
  if ((rights.not_applicable || []).includes("work_progress")) return false;
  if (rights.system_admin) return true;
  const l = rights.features?.work_progress || "none";
  return level === "read" ? l === "read" || l === "write" : l === "write";
}

// ------------------------------------------------------------------ модальное окно
// Одно окно на экран: содержимое рисует вызывающий код. Закрытие крестиком/Esc/подложкой идёт через `onRequestClose`
// (сторож несохранённого): вернул false — остаёмся. Фокус возвращается на прежний элемент.
// Реестр открытых окон: экран спрашивает, есть ли в них несохранённое (смена объекта, уход с экрана), и просит сторожа каждого окна.
const OPEN_MODALS = new Set();
export const anyModalDirty = () => [...OPEN_MODALS].some((m) => m.dirty?.());
export async function guardModals() {
  for (const m of [...OPEN_MODALS]) { if (m.dirty?.() && m.guard && !(await m.guard())) return false; }
  return true;
}
export function closeAllModals() { for (const m of [...OPEN_MODALS]) m.close(); }

export function openModal({ title, wide = false, onRequestClose }) {
  const prev = document.activeElement;
  const back = document.createElement("div");
  back.className = "mfr-modal-back";
  back.innerHTML = `<div class="mfr-modal${wide ? " mfr-modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="mfr-modal-head"><h3>${esc(title)}</h3><button type="button" class="v2-btn" data-mclose aria-label="Закрыть окно">Закрыть</button></div>
    <div class="mfr-modal-body"></div></div>`;
  const box = back.querySelector(".mfr-modal");
  let closed = false;
  const api = {
    body: back.querySelector(".mfr-modal-body"),
    setTitle: (t) => { back.querySelector("h3").textContent = t; box.setAttribute("aria-label", t); },
    get closed() { return closed; },
    close(force = true) { if (closed) return; closed = true; OPEN_MODALS.delete(api); document.removeEventListener("keydown", onKey, true); back.remove(); if (prev && document.contains(prev)) prev.focus?.(); },
  };
  OPEN_MODALS.add(api);
  async function request() { if (closed) return; if (onRequestClose && (await onRequestClose()) === false) return; api.close(); }
  function onKey(e) {
    if (closed) return;
    // выше лежит диалог подтверждения V2 — Esc и Tab принадлежат ему
    if (document.querySelector(".v2-dialog-backdrop")) return;
    if (e.key === "Escape") { e.preventDefault(); request(); return; }
    if (e.key === "Tab") {
      const items = [...box.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  }
  back.addEventListener("mousedown", (e) => { if (e.target === back) request(); });
  back.querySelector("[data-mclose]").addEventListener("click", request);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  box.tabIndex = -1; box.focus({ preventScroll: true });   // фокус — в окно (читалки объявят диалог); Tab дальше идёт по содержимому
  api.requestClose = request;
  return api;
}

// ------------------------------------------------------------------ запись с честным исходом
// `send` — сама запись; `verify` — сверка чтением при неизвестном исходе: вернуть "applied" | "not_applied" | "unknown".
// Возврат: {ok, outcome, error}: outcome — "saved" | "confirmed" (ответа не было, сервер подтвердил) | "rejected" | "conflict" | "not_applied" | "unknown".
export async function settle(send, verify) {
  try {
    const data = await send();
    return { ok: true, outcome: "saved", data };
  } catch (e) {
    if (isConflict(e)) return { ok: false, outcome: "conflict", error: e };
    if (!unknownOutcome(e)) return { ok: false, outcome: "rejected", error: e };
    let v = "unknown";
    try { v = verify ? await verify() : "unknown"; } catch (e2) { v = "unknown"; }
    if (v === "applied") return { ok: true, outcome: "confirmed", error: e };
    return { ok: false, outcome: v === "not_applied" ? "not_applied" : "unknown", error: e };
  }
}

export function conflictText(e, noun = "данные") {
  const items = conflictItems(e);
  const n = items.length;
  return `${e.detail}${n ? ` (расхождений: ${n})` : ""}`.replace(/\s+$/, "") + (n ? "" : ` Обновите ${noun} и повторите.`);
}

export const OUTCOME_TEXT = {
  confirmed: "Ответ не получен, но сервер подтвердил: изменение сохранено.",
  not_applied: "Ответ не получен, изменение на сервере не найдено. Ввод сохранён — проверьте связь и повторите вручную.",
  unknown: "Ответ не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите данные и проверьте.",
};
