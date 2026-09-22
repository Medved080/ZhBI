// Передача «покажи изделие на схеме» с экрана без схемы (отчёт «Моя работа») на рабочее место со схемой («Модель»).
// Экран отчёта и рабочее место — разные экраны V2 (кадр со схемой при уходе закрывается), поэтому запрос кладётся в
// sessionStorage и забирается рабочим местом, когда его сцена ДЕЙСТВИТЕЛЬНО загрузилась (workspace.js, onScene). Запрос
// одноразовый, живёт 5 минут и относится к одному объекту: запрос для другого объекта не исполняется никогда.
const KEY = "v2.locateRequest";
const TTL_MS = 5 * 60 * 1000;

export function requestLocate({ objectId, elementId }) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ objectId: Number(objectId), elementId: Number(elementId), at: Date.now() })); } catch (e) { /* хранилище недоступно — показ не сработает, отчёт остаётся */ }
}

// Забрать запрос для объекта `objectId` (и удалить его); null — запроса нет, он устарел или относится к другому объекту.
export function takeLocate(objectId) {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { r = null; }
  if (!r || !Number.isInteger(r.elementId)) return null;
  if (Date.now() - (r.at || 0) > TTL_MS) { try { sessionStorage.removeItem(KEY); } catch (e) { /* */ } return null; }
  if (r.objectId !== Number(objectId)) return null;
  try { sessionStorage.removeItem(KEY); } catch (e) { /* */ }
  return r.elementId;
}
