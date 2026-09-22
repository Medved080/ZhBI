// Аудит «рабочие места и отчёты»: справочник «Элементы» в V2 (element-catalog.js) против V1 (renderElementCatalog/renderEcDetail/
// openElementForm). Настоящий backend на копии БД, настоящий вход формой V2, настоящие щелчки и ввод (scripts/cdp.mjs); числа
// отбора сверены с SQL и с самим V1 на том же сервере; запись (смена статуса, удаление записи истории) — SQL до/после, журнал,
// двойная отправка, обрыв связи, 403 под ограниченной ролью. Запуск: node scripts/audit_work/chk_catalog.mjs (порт 8375)
import { startServer, stopServer, check, summary, sleep, SP, session, openScreen, tap, choose, exec, sql, sql1, writes, openV1 } from "./lib.mjs";

const PORT = 8375;
const S = await startServer(PORT, `${SP}/aw_catalog`, {
  setup(db) {
    // неполная роль в КОПИИ: «просмотр» получает «Элементы: изменение», но теряет «Статусы» — справочник открыт, смена статуса нет
    exec(db, `INSERT OR REPLACE INTO role_features (role_key, feature_key, level) VALUES ('view', 'element_fields', 'write'); DELETE FROM role_features WHERE role_key='view' AND feature_key='status';`);
  },
});
const summaryText = (b) => b.eval(`document.querySelector('#ec-summary').textContent`);
const found = async (b) => Number(((await summaryText(b)).match(/Найдено (\d+)/) || [])[1]);
const waitLoaded = (b) => b.waitFor(`/Найдено \\d+/.test(document.querySelector('#ec-summary').textContent)`, 30000);
const ecReq = (b, from) => b.requests.slice(from).filter((r) => new URL(r.url).pathname === "/element-catalog").map((r) => Object.fromEntries(new URL(r.url).searchParams));
const ALL = "e.object_id IS NOT NULL AND e.is_current = 1";
let b;
try {
  b = await session(S.base, "admin", { objectId: 1 });
  await b.eval(`sessionStorage.removeItem('v2.elementCatalog')`);
  await openScreen(b, "element-catalog", `document.querySelectorAll('#ec-table tbody tr').length > 0`);
  await waitLoaded(b);
  const total = sql1(S.db, `SELECT COUNT(*) FROM elements e WHERE ${ALL}`);
  check("справочник: «Найдено» = SQL (все текущие изделия доступных объектов)", (await found(b)) === total, `${await found(b)} / SQL ${total}`);
  check("справочник: 20 колонок по умолчанию (как V1 без служебных), страница 200 строк", (await b.eval(`document.querySelectorAll('#ec-table thead tr:first-child th').length`)) === 20 && (await b.eval(`document.querySelectorAll('#ec-table tbody tr').length`)) === 200);

  // сортировка щелчком по заголовку
  let n = b.requests.length;
  await tap(b, '.ec-sort[data-sort="mark"]'); await waitLoaded(b); await sleep(300);
  await tap(b, '.ec-sort[data-sort="mark"]'); await waitLoaded(b); await sleep(300);
  const sorts = ecReq(b, n).map((q) => `${q.sort}:${q.direction}`);
  check("сортировка по «Марка»: ▲ затем ▼ (запросы sort=mark asc/desc)", sorts.join(",") === "mark:asc,mark:desc" && /Марка ▼/.test(await b.eval(`document.querySelector('.ec-sort[data-sort="mark"]').textContent`)), sorts.join(","));

  // отбор выпадающим списком
  await choose(b, 'select[data-filter="current_status"]', "installed"); await waitLoaded(b);
  const inst = sql1(S.db, `SELECT COUNT(*) FROM elements e WHERE ${ALL} AND e.current_status='installed'`);
  check("отбор «Статус = Смонтирован» = SQL", (await found(b)) === inst, `${await found(b)} / ${inst}`);
  // подстрока — настоящим вводом с клавиатуры
  await tap(b, 'input[data-textfilter="address"]'); await b.type("3-5");
  await b.waitFor(`/Найдено \\d+/.test(document.querySelector('#ec-summary').textContent) && document.activeElement?.dataset?.textfilter === 'address'`, 20000); await sleep(1200);
  const instAddr = sql1(S.db, `SELECT COUNT(*) FROM elements e WHERE ${ALL} AND e.current_status='installed' AND e.address LIKE '%3-5%'`);
  check("отбор подстрокой «Адрес» (ввод с клавиатуры, фокус сохраняется) = SQL", (await found(b)) === instAddr, `${await found(b)} / ${instAddr}`);
  await choose(b, 'select[data-fill="planned_delivery_date"]', "__none__"); await waitLoaded(b);
  const instAddrNoPd = sql1(S.db, `SELECT COUNT(*) FROM elements e WHERE ${ALL} AND e.current_status='installed' AND e.address LIKE '%3-5%' AND (e.planned_delivery_date IS NULL OR e.planned_delivery_date='')`);
  check("«План. поставка: Не заполнено» = SQL", (await found(b)) === instAddrNoPd, `${await found(b)} / ${instAddrNoPd}`);
  const v2Filtered = await found(b);
  await tap(b, "#ec-reset"); await waitLoaded(b); await sleep(300);
  check("«Сбросить отбор» возвращает всё", (await found(b)) === total);
  // поиск по марке или адресу
  await tap(b, "#ec-search"); await b.type("4Кв3"); await sleep(1200); await waitLoaded(b);
  const q = sql1(S.db, `SELECT COUNT(*) FROM elements e WHERE ${ALL} AND (e.mark LIKE '%4Кв3%' OR e.address LIKE '%4Кв3%')`);
  check("поиск «4Кв3» по марке или адресу = SQL", (await found(b)) === q, `${await found(b)} / ${q}`);
  await tap(b, "#ec-reset"); await waitLoaded(b);
  // служебные поля и страницы
  await tap(b, "#ec-extra"); await waitLoaded(b); await sleep(300);
  check("«Показывать служебные поля» — 42 колонки (как V1)", (await b.eval(`document.querySelectorAll('#ec-table thead tr:first-child th').length`)) === 42);
  n = b.requests.length;
  await tap(b, "#ec-next"); await waitLoaded(b);
  check("«Вперёд →» — вторая страница (offset=200)", ecReq(b, n).at(-1)?.offset === "200" && /201–400/.test(await summaryText(b)), await summaryText(b));
  await tap(b, "#ec-prev"); await waitLoaded(b);

  // ---------------- запись из карточки: смена статуса изделия (delivered → installed)
  const E = sql(S.db, `SELECT id, mark, object_id FROM elements e WHERE ${ALL} AND e.object_id=1 AND e.current_status='delivered' ORDER BY e.id LIMIT 1`)[0];
  const hist0 = sql1(S.db, `SELECT COUNT(*) FROM status_history WHERE element_id=${E.id}`);
  const act0 = sql1(S.db, `SELECT COUNT(*) FROM activity_log`);
  await tap(b, 'input[data-textfilter="id"]'); await b.type(String(E.id)); await sleep(1300); await waitLoaded(b);
  await b.waitFor(`document.querySelector('#ec-table tbody tr[data-id="${E.id}"]')`, 20000);
  await tap(b, `#ec-table tbody tr[data-id="${E.id}"] td:nth-child(2)`);
  await b.waitFor(`document.querySelector('#ec-card .ws-mark') && document.querySelector('#ec-card #ws-sform select[name=status]')`, 30000);
  check("щелчок по строке — карточка изделия (марка из SQL)", (await b.eval(`document.querySelector('#ec-card .ws-mark').textContent`)) === E.mark, E.mark);
  await choose(b, '#ec-card #ws-sform select[name=status]', "installed");
  n = b.requests.length;
  // двойной щелчок по «Сохранить статус»: запрос один (кнопка недоступна, пока идёт запрос)
  const sbtn = await b.rect('#ec-card #ws-sform button[type=submit]');
  await b.click(sbtn.cx, sbtn.cy, { count: 2 });
  try { await b.waitFor(`document.querySelector('.v2-dialog [data-choice="confirm"]')`, 4000); await tap(b, '.v2-dialog [data-choice="confirm"]'); } catch { /* подтверждение не требуется */ }
  await b.waitFor(`document.querySelector('#ec-card .ws-ok') || document.querySelector('#ec-card .ws-err')`, 30000);
  await sleep(1500);
  const sb = b.requests.slice(n).filter((r) => r.url.endsWith("/element-ops/status-batch")).map((r) => JSON.parse(r.body).mode);
  check("смена статуса: предпросмотр и одна запись (без повторной отправки при двойном щелчке)", sb.join(",") === "preview,apply", sb.join(","));
  check("смена статуса: SQL — «Смонтирован», +1 запись истории", sql1(S.db, `SELECT current_status FROM elements WHERE id=${E.id}`) === "installed" && sql1(S.db, `SELECT COUNT(*) FROM status_history WHERE element_id=${E.id}`) === hist0 + 1);
  check("смена статуса: событие в журнале действий", sql1(S.db, `SELECT COUNT(*) FROM activity_log`) > act0);
  await b.waitFor(`/Смонтирован/.test(document.querySelector('#ec-table tbody tr[data-id="${E.id}"]')?.innerText || '')`, 15000);
  check("смена статуса: строка справочника перечитана (статус «Смонтирован»)", true);
  // результат после перезагрузки страницы: отбор, строка и карточка восстановлены
  await b.goto(`${S.base}/v2#/element-catalog`, 1500);
  await b.waitFor(`document.querySelector('#ec-card .ws-mark') && /Найдено \\d+/.test(document.querySelector('#ec-summary').textContent)`, 40000);
  const after = await b.eval(`({ filter: document.querySelector('input[data-textfilter="id"]')?.value, active: document.querySelector('#ec-table tr.ec-active')?.dataset.id, chip: document.querySelector('#ec-card .ws-chip')?.textContent })`);
  check("после перезагрузки: отбор, выбранная строка и карточка восстановлены, статус «Смонтирован»", after.filter === String(E.id) && after.active === String(E.id) && /Смонтирован/.test(after.chip), JSON.stringify(after));

  // удаление последней записи истории (с подтверждением) — статус пересчитан по оставшимся
  n = b.requests.length;
  await b.waitFor(`document.querySelectorAll('#ec-card [data-eo="h-del"]').length > 0`, 15000);
  const lastH = sql1(S.db, `SELECT id FROM status_history WHERE element_id=${E.id} ORDER BY changed_at DESC, id DESC LIMIT 1`);
  await tap(b, `#ec-card [data-eo="h-del"][data-id="${lastH}"]`);
  await b.waitFor(`document.querySelector('.v2-dialog [data-choice="confirm"]')`, 8000);
  await tap(b, '.v2-dialog [data-choice="confirm"]');
  await b.waitFor(`/Доставлен/.test(document.querySelector('#ec-card .ws-chip')?.textContent || '')`, 20000);
  check("удаление записи истории: SQL — записи нет, статус снова «Доставлен»", sql1(S.db, `SELECT COUNT(*) FROM status_history WHERE id=${lastH}`) === 0 && sql1(S.db, `SELECT current_status FROM elements WHERE id=${E.id}`) === "delivered");

  // конфликт устаревших данных: изделие изменили в обход открытой карточки — сервер отказывает (ожидаемый статус), запись не идёт
  exec(S.db, `UPDATE elements SET current_status='installed' WHERE id=${E.id}`);
  await choose(b, '#ec-card #ws-sform select[name=status]', "accepted");
  n = b.requests.length;
  await tap(b, '#ec-card #ws-sform button[type=submit]');
  await b.waitFor(`document.querySelector('#ec-card .ws-err')`, 20000);
  const conf = b.requests.slice(n).filter((r) => r.url.endsWith("/element-ops/status-batch")).map((r) => `${JSON.parse(r.body).mode}:${r.status}`);
  check("конфликт: изменённое в обход изделие — отказ сервера, «Принят» не записан", sql1(S.db, `SELECT current_status FROM elements WHERE id=${E.id}`) === "installed" && !conf.some((x) => x.startsWith("apply:200")), `${conf.join(",")}; ${await b.eval(`document.querySelector('#ec-card .ws-err').textContent`)}`);
  exec(S.db, `UPDATE elements SET current_status='delivered' WHERE id=${E.id}`);
  await b.goto(`${S.base}/v2#/element-catalog`, 1500);
  await b.waitFor(`document.querySelector('#ec-card #ws-sform select[name=status]') && /Доставлен/.test(document.querySelector('#ec-card .ws-chip')?.textContent || '')`, 40000);

  // обрыв связи: запрос не дошёл — повторно не отправляется, ввод остаётся, сообщение
  await choose(b, '#ec-card #ws-sform select[name=status]', "installed");
  await b.offline(true);
  n = b.requests.length;
  await tap(b, '#ec-card #ws-sform button[type=submit]');
  await b.waitFor(`document.querySelector('#ec-card .ws-err')`, 20000);
  await sleep(1500);
  const offReq = b.requests.slice(n).filter((r) => r.url.endsWith("/element-ops/status-batch")).length;
  await b.offline(false);
  check("обрыв связи: один запрос без автоповтора, ошибка показана, в БД без изменений", offReq === 1 && sql1(S.db, `SELECT current_status FROM elements WHERE id=${E.id}`) === "delivered", `запросов ${offReq}; ${await b.eval(`document.querySelector('#ec-card .ws-err').textContent`)}`);
  await choose(b, '#ec-card #ws-sform select[name=status]', "");

  // двойной щелчок по строке — форма реквизитов
  const cell = await b.rect(`#ec-table tbody tr[data-id="${E.id}"] td:nth-child(2)`);
  await b.click(cell.cx, cell.cy, { count: 2 });
  await b.waitFor(`[...document.querySelectorAll('input,select')].some(x=>x.closest('[role=dialog],.eo-modal,.v2-dialog')) `, 15000);
  const form = await b.eval(`(()=>{const m=document.querySelector('[role=dialog]') || document.querySelector('.eo-modal'); return m ? m.innerText.slice(0,120) : ''})()`);
  check("двойной щелчок по строке — форма реквизитов изделия (как V1)", /Марка|Тип|Реквизит/i.test(form), form.replace(/\n/g, " | "));
  await b.key("Escape"); await sleep(500);
  try { await b.eval(`document.querySelector('[role=dialog] [data-close], .eo-modal [data-close], [role=dialog] button[value=cancel]')?.click()`); } catch { /* */ }
  await sleep(300);

  // «Показать на схеме» → «Модель», изделие выделено; «Назад» — справочник с тем же отбором
  n = b.requests.length;
  await tap(b, '#ec-card [data-act="locate"]');
  await b.waitFor(`location.hash==='#/ws-model'`, 15000);
  for (let i = 0; i < 600 && !b.requests.slice(n).some((r) => new URL(r.url).pathname === `/elements/${E.id}` && r.status === 200 && !/element-catalog/.test(r.url)); i++) await sleep(150);
  await b.waitFor(`document.querySelector('.ws-mark')?.textContent === ${JSON.stringify(E.mark)}`, 60000);
  check("«Показать на схеме»: «Модель» выделила то же изделие", true);
  await b.eval(`history.back()`);
  await b.waitFor(`location.hash==='#/element-catalog' && document.querySelector('#ec-table tr.ec-active')`, 30000);
  check("«Назад» — справочник с тем же отбором и выбранной строкой", (await b.eval(`document.querySelector('#ec-table tr.ec-active')?.dataset.id`)) === String(E.id));
  check("исключений JavaScript нет (admin)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));

  // ---------------- V1 на том же сервере: тот же отбор — то же число
  await openV1(b, S.base, null);
  await b.eval(`(async()=>{ document.getElementById('element-catalog-backdrop').classList.add('open'); ecState.filters={current_status:'installed', address:'3-5', planned_delivery_date:'__none__'}; ecState.offset=0; await renderElementCatalog(); })()`);
  await b.waitFor(`/Найдено \\d+/.test(document.getElementById('ec-summary').textContent)`, 30000);
  const v1n = Number(((await b.eval(`document.getElementById('ec-summary').textContent`)).match(/Найдено (\d+)/) || [])[1]);
  check("V1 = V2: тот же отбор (статус + адрес + «не заполнено») — то же «Найдено»", v1n === v2Filtered, `V1 ${v1n} / V2 ${v2Filtered}`);
  check("V1 работает: исключений нет", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close(); b = null;

  // ---------------- неполная роль (user4: «Элементы: изменение», без «Статусов») и 1366×768
  b = await session(S.base, "user4", { objectId: 1, width: 1366, height: 768 });
  await b.eval(`sessionStorage.removeItem('v2.elementCatalog')`);
  await openScreen(b, "element-catalog", `document.querySelectorAll('#ec-table tbody tr').length > 0`);
  await waitLoaded(b);
  const lay = await b.eval(`({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight })`);
  check("1366×768: страница не прокручивается, таблица и карточка — внутри своих областей", lay.w <= lay.iw + 1 && lay.h <= lay.ih + 1, JSON.stringify(lay));
  await tap(b, "#ec-table tbody tr:first-child td:nth-child(2)");
  await b.waitFor(`document.querySelector('#ec-card .ws-mark')`, 30000); await sleep(1200);
  const ro = await b.eval(`({ noStatus: /Смена статуса недоступна/.test(document.querySelector('#ec-card').innerText), del: document.querySelectorAll('#ec-card [data-eo="h-del"]').length, form: !!document.querySelector('#ec-card [data-eo="ef-open"]') })`);
  check("user4 (без «Статусов», история — чтение): формы статуса и удаления истории нет, «Форма элемента…» есть", ro.noStatus && ro.del === 0 && ro.form, JSON.stringify(ro));
  const st403 = await b.eval(`fetch('/element-ops/status-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'preview',object_id:1,status:'installed',items:[{element_id:${E.id},expected_status:'delivered',expected_contract_id:null}]})}).then(r=>r.status)`);
  check("user4: смена статуса отклонена сервером (403)", st403 === 403, String(st403));
  check("исключений JavaScript нет (user4)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close(); b = null;
  // user2 (роль «user», «Элементы» — только чтение): раздела нет, как пункта меню V1 (право «Элементы: изменение»)
  b = await session(S.base, "user2", { objectId: 1 });
  await b.eval(`location.hash='#/element-catalog'`); await sleep(2500);
  check("user2 (без «Элементы: изменение»): раздел недоступен, как пункт меню V1", (await b.eval(`location.hash`)) !== "#/element-catalog" || !(await b.eval(`!!document.querySelector('#ec-table')`)), await b.eval(`location.hash`));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("Справочник «Элементы» V2") ? 1 : 0);
