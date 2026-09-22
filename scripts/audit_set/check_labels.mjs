// Рабочее место «Модель» V2, вкладка «Вид»: сеансовые «Подписи» по типу изделия и их допстрока «Даты» — перенос окна V1
// «Настройки → Вид → Подписи». Команда моста setLabelVisible нажимает те же флажки V1 в кадре — работают обработчики V1
// (каскад «тип → даты», прореживание по коллизиям). Настоящий backend, вход формой, настоящие щелчки; запросов записи нет.
//   node scripts/audit_set/check_labels.mjs <копия БД> <порт>
import { session, ok, summary, go, click, BASE, setObject, frameEval, waitScene, overflowX } from "./lib.mjs";

// видимые (не скрытые переключателем) подписи и наклейки изделий типа T в кадре — по собственным картам V1 (подписи вне кадра
// отсоединены от DOM, поиск по документу их не нашёл бы)
const shownOf = (t) => `(() => { const T = ${JSON.stringify(t)}; let n = 0;
  for (const m of [state.labelById, state.subLabelById, state.stickerById]) for (const [id, node] of m) { const e = state.byId.get(id);
    if (e && e.element_type === T && node.style.display !== "none") n++; } return n; })()`;

for (const user of ["admin", "user4"]) {
  const b = await session(BASE, user);
  try {
    await setObject(b, 1);
    await go(b, "ws-model"); await waitScene(b);
    await click(b, '[data-tab="view"]'); await b.sleep(500);
    const v2Types = await b.eval(`[...document.querySelectorAll('input[data-label-type]')].map((c) => c.dataset.labelType)`);
    const v1Types = await frameEval(b, `[...document.querySelectorAll('#label-toggles input[data-type]')].map((c) => c.dataset.type)`);
    ok(`${user}: вкладка «Вид» — раздел «Подписи», типы те же, что в окне V1 (${v2Types.length})`, v2Types.length > 0 && JSON.stringify(v2Types) === JSON.stringify(v1Types), JSON.stringify(v2Types));
    // Исходное состояние задаёт настройка «Видимость подписей» (на копии — выключены); флажки V2 обязаны его показывать
    const v1State = await frameEval(b, `Object.fromEntries([...document.querySelectorAll('#label-toggles input[data-type]')].map((c) => [c.dataset.type, c.checked]))`);
    const v2State = await b.eval(`Object.fromEntries([...document.querySelectorAll('input[data-label-type]')].map((c) => [c.dataset.labelType, c.checked]))`);
    ok(`${user}: исходные флажки V2 = флажкам окна V1`, JSON.stringify(v1State) === JSON.stringify(v2State), JSON.stringify(v2State));
    const T = v2Types.find((t) => /Колонна|Ригель|Плита/.test(t)) || v2Types[0];
    const initial = v2State[T];
    const writesFrom = b.requests.length;
    const sel = `input[data-label-type=${JSON.stringify(T)}]`, selD = `input[data-label-dates=${JSON.stringify(T)}]`;
    const isOn = () => frameEval(b, `state.labelVisibility[${JSON.stringify(T)}] !== false`);

    // если тип выключен — включить (подписи должны появиться), потом выключить (пропасть); если включён — наоборот
    if (!initial) { await click(b, sel); await b.sleep(900); }
    ok(`${user}: «${T}» включён — наклейки/подписи типа на схеме не скрыты`, (await isOn()) && (await frameEval(b, shownOf(T))) > 0);
    ok(`${user}: «Даты» типа включены и доступны (каскад V1)`, await b.eval(`(() => { const d = document.querySelector(${JSON.stringify(selD)}); return !d || (d.checked && !d.disabled); })()`));
    await click(b, sel); await b.sleep(700);
    ok(`${user}: «${T}» снят — подписи этого типа на схеме скрыты`, !(await isOn()) && (await frameEval(b, shownOf(T))) === 0);
    ok(`${user}: «Даты» типа сняты и недоступны (каскад V1)`, await b.eval(`(() => { const d = document.querySelector(${JSON.stringify(selD)}); return !d || (!d.checked && d.disabled); })()`));
    await click(b, sel); await b.sleep(900);
    const hasDates = await b.eval(`!!document.querySelector(${JSON.stringify(selD)})`);
    if (hasDates) {
      await click(b, selD); await b.sleep(700);
      ok(`${user}: сняты только «Даты» — подпись типа осталась, допстрока выключена`, (await frameEval(b, `state.labelVisibility[${JSON.stringify(T)}] !== false && state.labelDatesVisibility[${JSON.stringify(T)}] === false`)) === true);
      await click(b, selD); await b.sleep(500);
    }
    if (!initial) { await click(b, sel); await b.sleep(500); }
    ok(`${user}: возвращено исходное состояние`, (await isOn()) === initial);

    const writes = b.requests.slice(writesFrom).filter((r) => r.method !== "GET" && !/\/me\/last-object|v2-shell-prefs/.test(r.url));
    ok(`${user}: ни одного запроса записи на сервер (сеансовая настройка)`, writes.length === 0, JSON.stringify(writes.map((r) => [r.method, r.url])));
    await b.viewport(1366, 768); await b.sleep(400);
    ok(`${user}: 1366×768 — без горизонтальной прокрутки`, (await overflowX(b)) <= 1);
    await b.viewport(1920, 1080);
    ok(`${user}: нет ошибок JavaScript`, b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
  } finally { await b.close(); }
}
process.exit(summary() ? 1 : 0);
