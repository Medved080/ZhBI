// Тонкая обёртка над fetch — тот же backend, та же cookie-сессия
// (zhbi_session), что и у V1. Никакой отдельной авторизации и никакой
// копии бизнес-логики: только перенос JSON туда и обратно.

// Коды ошибок проверки FastAPI/Pydantic → по-русски; остальные показываются
// собственным текстом сервера (msg).
const FIELD_ERRORS = {
  missing: "обязательное поле",
  string_too_short: "слишком короткое значение",
  string_too_long: "слишком длинное значение",
  int_parsing: "нужно целое число",
  float_parsing: "нужно число",
  bool_parsing: "нужно значение да/нет",
  date_from_datetime_parsing: "неверная дата",
  date_parsing: "неверная дата",
};

function fallbackText(status) {
  if (status === 0) return "Нет связи с сервером. Проверьте подключение и повторите.";
  if (status === 401) return "Сессия истекла. Войдите снова.";
  if (status === 403) return "Недостаточно прав для этого действия.";
  if (status === 404) return "Запись не найдена — возможно, её уже удалили.";
  if (status === 409) return "Конфликт данных: запись изменилась или уже существует.";
  if (status === 422) return "Проверьте введённые данные.";
  if (status >= 500) return `Ошибка сервера (${status}). Повторите позже.`;
  return "Ошибка запроса";
}

// detail бывает строкой, списком ошибок проверки (422), объектом или HTML
// прокси. В сообщение пользователю всегда должна попадать читаемая строка —
// иначе экран показывал «[object Object]».
function describeDetail(detail, status) {
  if (typeof detail === "string") {
    const t = detail.trim();
    if (!t) return fallbackText(status);
    if (t.startsWith("<")) return fallbackText(status); // HTML прокси/страница ошибки — не показываем разметку
    // Длинный обычный текст (например, 409 стража покрытия контрактов) — это
    // объяснение сервера, оно показывается целиком; режем только заведомо огромное.
    return t.length > 1000 ? t.slice(0, 1000) + "…" : t;
  }
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      if (typeof d === "string") return d;
      const loc = Array.isArray(d?.loc) ? d.loc.filter((x) => !["body", "query", "path"].includes(x)) : [];
      const what = FIELD_ERRORS[d?.type] || d?.msg || "неверное значение";
      return loc.length ? `${loc.join(".")}: ${what}` : what;
    }).filter(Boolean);
    return parts.length ? `Проверьте данные — ${parts.join("; ")}` : fallbackText(status);
  }
  if (detail && typeof detail === "object") {
    if (typeof detail.message === "string" && detail.message.trim()) return detail.message;
    if (typeof detail.detail === "string" && detail.detail.trim()) return detail.detail;
  }
  return fallbackText(status);
}

import { checkWrite, announceBlocked } from "./write-gate.js";

export class ApiError extends Error {
  constructor(status, detail) {
    const text = describeDetail(detail, status);
    super(text);
    this.status = status;
    this.rawDetail = detail;
    this.detail = text;
  }
}

// Счётчик запросов НЕ на чтение — нужен, чтобы переключатель версии знал,
// идёт ли прямо сейчас запись: скрыть результат операции переходом в V1
// посреди сохранения хуже, чем на секунду заблокировать кнопку перехода.
let pendingWrites = 0;
const writeListeners = new Set();
function notifyPendingWrites() { for (const fn of writeListeners) fn(pendingWrites); }

async function request(method, path, body, { read = false } = {}) {
  // read: POST-запрос, который ТОЛЬКО читает (отчёты V1 берут параметры отбора телом запроса). Он не считается
  // записью: не блокирует переходы и не показывает «идёт сохранение».
  const isWrite = method !== "GET" && !read;
  // FormData (загрузка файла) уходит как есть: Content-Type с boundary
  // браузер выставляет сам, ручной JSON-заголовок его бы сломал.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (isWrite) {
    // Ограниченный выпуск: изменяющий запрос, не разрешённый политикой `write-gate.js`, НЕ уходит на сервер вообще
    // (ни fetch, ни счётчик записей). Отказ — обычный ApiError 4xx: модули показывают его текст и оставляют ввод на месте,
    // а не «повторяют» и не проверяют чтением, как при неизвестном исходе.
    // Форма загрузки (FormData) тоже проверяется шлюзом: строка политики видит поля и файл (`check(body, путь)`).
    const verdict = checkWrite(method, path, body);
    if (!verdict.allowed) {
      announceBlocked(verdict, method, path);
      const err = new ApiError(403, verdict.message);
      err.blockedByPolicy = true;
      throw err;
    }
    pendingWrites++; notifyPendingWrites();
  }
  try {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body !== undefined && !isForm ? { "Content-Type": "application/json" } : undefined,
        body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
      });
    } catch (netErr) {
      // Сетевой сбой (нет связи, обрыв) — тот же ApiError с понятным текстом,
      // а не английское «Failed to fetch» из браузера; status 0 = ответа нет.
      throw new ApiError(0, null);
    }
    if (res.status === 204) return null;
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!res.ok) {
      const detail = data && typeof data === "object" && "detail" in data ? data.detail : data;
      throw new ApiError(res.status, detail || res.statusText);
    }
    return data;
  } finally {
    if (isWrite) { pendingWrites--; notifyPendingWrites(); }
  }
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {}),
  put: (path, body) => request("PUT", path, body ?? {}),
  delete: (path) => request("DELETE", path),
  upload: (path, formData) => request("POST", path, formData),
  // Выгрузка в файл (blob). Это чтение: допустимы только `/reports/<имя>.xlsx|pdf` (POST), `/export.xlsx` (POST) и
  // `/export.pdf?…` (GET); в счётчик записей не входит.
  async download(path, body, { method = "POST" } = {}) {
    const okPath = /^\/reports\/[a-z0-9-]+\.(xlsx|pdf)$/.test(path) || path === "/export.xlsx" || /^\/export\.pdf(\?|$)/.test(path)
      || /^\/objects\/\d+\/block-works\/bulk-edit\/export$/.test(path)                       // выгрузка ЗР в Excel для правки (учёт по блокам)
      || /^\/objects\/\d+\/blocks\/chess-flat-export\.(xlsx|pdf)$/.test(path)                // бланк обхода плоской шахматки
      || /^\/schedule-versions\/gantt\.(xlsx|pdf)(\?|$)/.test(path);                        // диаграмма Ганта графика СМР
    if (!okPath || (method !== "POST" && method !== "GET")) throw new Error(`download: «${path}» — не выгрузка`);
    let res;
    try {
      res = await fetch(path, method === "GET" ? { method, credentials: "same-origin" }
        : { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    } catch (netErr) { throw new ApiError(0, null); }
    if (!res.ok) {
      let detail = null;
      try { const j = await res.json(); detail = j && typeof j === "object" && "detail" in j ? j.detail : j; } catch (e) { /* не JSON */ }
      throw new ApiError(res.status, detail || res.statusText);
    }
    return res.blob();
  },
  // Выгрузка файла обмена данными (образец формата, файл массовой правки, экспорт настроек): только перечисленные пути. Возвращает
  // {blob, filename}. Это ЧТЕНИЕ (шлюз записи не участвует), но допустимы лишь заранее известные адреса — произвольный путь отказ.
  async fetchFile(path, { method = "GET", body } = {}) {
    const p = String(path).split("?")[0];
    const ok = (method === "GET" && (/^\/import-templates\/[a-z_]+\/sample$/.test(p) || p === "/settings/export"))
      || (method === "POST" && (p === "/elements/bulk-edit/export"));
    if (!ok) throw new Error(`fetchFile: «${path}» — не выгрузка файла`);
    let res;
    try {
      res = await fetch(path, method === "GET" ? { method, credentials: "same-origin" }
        : { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    } catch (netErr) { throw new ApiError(0, null); }
    if (!res.ok) {
      let detail = null;
      try { const j = await res.json(); detail = j && typeof j === "object" && "detail" in j ? j.detail : j; } catch (e) { /* не JSON */ }
      throw new ApiError(res.status, detail || res.statusText);
    }
    const cd = res.headers.get("Content-Disposition") || "";
    let filename = null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { filename = decodeURIComponent(star[1]); } catch (e) { filename = star[1]; } }
    else { const plain = /filename="([^"]+)"/i.exec(cd); if (plain) filename = plain[1]; }
    return { blob: await res.blob(), filename };
  },
  // Чтение POST-запросом. Допустимы только отчёты (`/reports/…`) — остальное это запись и должно идти через post().
  readPost: (path, body) => {
    // отчёты и предпросмотры учёта по блокам (`…/bulk-preview`, `…/work-types-settings/preview` — считают последствия и ничего не пишут)
    if (!/^\/reports\/[a-z0-9-]+$/.test(path) && !/^\/objects\/\d+\/(block-works\/bulk-preview|blocks\/work-types-settings\/preview)$/.test(path)) throw new Error(`readPost: «${path}» не отчёт и не предпросмотр — это запись, используйте post()`);
    return request("POST", path, body ?? {}, { read: true });
  },
  hasPendingWrites: () => pendingWrites > 0,
  onPendingWritesChange(fn) { writeListeners.add(fn); return () => writeListeners.delete(fn); },
};
