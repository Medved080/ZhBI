// Снимок «текущего фильтра схемы» — перенос флажка V1 «Учитывать текущий фильтр схемы» (app.js: reportUseFilter,
// state.elements.filter(passesPlacementFilters).map(e => e.id)) в V2, где отчёты и рабочее место «Модель» — РАЗНЫЕ
// экраны (в V1 всё это один документ, фильтр живёт в общей переменной state; здесь схема рисуется движком V1
// внутри кадра workspace.js, и когда человек уходит с рабочего места на экран отчёта, кадр со схемой уничтожается
// вместе со своим состоянием).
//
// Устройство: рабочее место (workspace.js, ws === "model" | "foreman" — там фильтр размещения,
// у комплектовщика свой отбор) при КАЖДОЙ смене модели фильтра просит у кадра актуальный
// список id (команда getFilteredIds моста, app/static/embed-bridge.js) и кладёт СНИМОК сюда — в sessionStorage,
// а не в общий модуль состояния: разные вкладки/окна одного человека не должны путать чужой отбор (сеанс браузера,
// не устройство). Отчёт читает снимок и СВЕРЯЕТ его объект с объектом отчёта — снимок другого объекта не
// применяется НИКОГДА, даже молча не «почти подходит».
const KEY = "v2.schemeFilterSnapshot";

// payload: { objectId, ws: "model"|"foreman"|"picker", elementIds: number[], shown, total, excluded, capturedAt }
export function writeFilterSnapshot(payload) {
  try { sessionStorage.setItem(KEY, JSON.stringify(payload)); } catch (e) { /* хранилище недоступно — не критично, отчёт покажет «отбор недоступен» */ }
}

export function readFilterSnapshot() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d.objectId !== "number" || !Array.isArray(d.elementIds)) return null;
    return d;
  } catch (e) { return null; }
}

// Снимок ПРИМЕНИМ к отчёту, только если он про ТОТ ЖЕ объект — иначе это отбор другого объекта, молча его не
// подставляем (задание: «не смешивай данные разных объектов», «не применяй скрытый устаревший фильтр»).
export function filterSnapshotFor(objectId) {
  const s = readFilterSnapshot();
  return s && s.objectId === objectId ? s : null;
}

const wsLabel = { model: "«Модель»", foreman: "«Прораб»", picker: "«АРМ комплектовщика»" };

// Однократный переход кнопкой ⤢ из мини-отчёта: полноразмерный экран
// открывается сразу с тем же отбором. Другой экран или объект флаг не съест.
const OPEN_KEY = "v2.filteredReportOpen";
export function queueFilteredReportOpen(screenId, objectId) {
  try { sessionStorage.setItem(OPEN_KEY, JSON.stringify({ screenId, objectId, at: Date.now() })); } catch (e) { /* хранилище недоступно */ }
}
export function consumeFilteredReportOpen(screenId, objectId) {
  try {
    const raw = sessionStorage.getItem(OPEN_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (Date.now() - d.at > 60000) { sessionStorage.removeItem(OPEN_KEY); return false; }
    if (d.screenId !== screenId || d.objectId !== objectId) return false;
    sessionStorage.removeItem(OPEN_KEY);
    return true;
  } catch (e) { return false; }
}
function timeText(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Текст для пользователя рядом с галочкой — какой именно отбор применится, чтобы состояние не протекало скрыто.
export function describeFilterSnapshot(objectId) {
  const raw = readFilterSnapshot();
  if (!raw) return { available: false, text: "Отбор ещё не задавался в этом сеансе — откройте рабочее место «Модель» и настройте фильтры, затем вернитесь сюда." };
  if (raw.objectId !== objectId) return { available: false, text: "Есть отбор для другого объекта — он не относится к текущему объекту и не применяется." };
  if (!raw.excluded) return { available: true, allShown: true, text: `Рабочее место ${wsLabel[raw.ws] || raw.ws} (${timeText(raw.capturedAt)}): фильтр не сужен, показаны все ${raw.total} элементов — отбор ничего не изменит.` };
  return { available: true, allShown: false, text: `Рабочее место ${wsLabel[raw.ws] || raw.ws} (${timeText(raw.capturedAt)}): показано ${raw.shown} из ${raw.total} элементов.` };
}
