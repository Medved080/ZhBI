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
    if (t.length > 300 || t.startsWith("<")) return fallbackText(status);
    return t;
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

async function request(method, path, body) {
  const isWrite = method !== "GET";
  // FormData (загрузка файла) уходит как есть: Content-Type с boundary
  // браузер выставляет сам, ручной JSON-заголовок его бы сломал.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (isWrite) { pendingWrites++; notifyPendingWrites(); }
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
  hasPendingWrites: () => pendingWrites > 0,
  onPendingWritesChange(fn) { writeListeners.add(fn); return () => writeListeners.delete(fn); },
};
