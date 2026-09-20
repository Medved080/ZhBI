// Тонкая обёртка над fetch — тот же backend, та же cookie-сессия
// (zhbi_session), что и у V1. Никакой отдельной авторизации и никакой
// копии бизнес-логики: только перенос JSON туда и обратно.

export class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : "Ошибка запроса");
    this.status = status;
    this.detail = detail;
  }
}

// Счётчик запросов НЕ на чтение — нужен, чтобы переключатель версии знал,
// идёт ли прямо сейчас запись: скрыть результат операции переходом в V1
// посреди сохранения хуже, чем на секунду заблокировать кнопку перехода.
let pendingWrites = 0;
const writeListeners = new Set();
function notifyPendingWrites() { for (const fn of writeListeners) fn(pendingWrites); }

async function request(method, path, body) {
  const isWrite = method !== "GET";
  // FormData (загрузка файла) уходит как есть: Content-Type с boundary
  // браузер выставляет сам, ручной JSON-заголовок его бы сломал.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (isWrite) { pendingWrites++; notifyPendingWrites(); }
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !isForm ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
    });
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
  hasPendingWrites: () => pendingWrites > 0,
  onPendingWritesChange(fn) { writeListeners.add(fn); return () => writeListeners.delete(fn); },
};
