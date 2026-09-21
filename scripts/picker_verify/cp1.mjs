// Контрагенты в V2 на настоящем backend (копия БД, вход формой, реальные события): создание и правка карточки, нормативы производительности,
// конфликт устаревших данных (отмена / поверх / показать актуальные), двойной щелчок, потеря ответа, обрыв сети, права (view, «Комплектовщик»),
// журнал, совместимость V1. Запуск: node scripts/picker_verify/cp1.mjs  (порт 8135)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto, typeInto } from "./lib.mjs";
import { prepareCp, CP_TABLES, text, clickBtn, btnState, dialogClick, dialogText, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, clickSelScrolled, setInput, sql, sql1, exec } from "./common.mjs";

const S = await startServer(8135, `${SP}/picker_cp1`, { setup: prepareCp });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
const inner = () => text(b, "#cp-inner");
const st = () => text(b, "#cp-status");
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#cp-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const waitSt = (t, to = 15000) => b.waitFor(`(document.querySelector('#cp-status')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const openCard = async (short) => {
  await go("#/counterparties"); await waitIn("Добавить контрагента");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes(${JSON.stringify(short)}))?.click()`);
  await b.waitFor(`!!document.querySelector('#cpf-short')`);
  await sleep(300);
};
const cpRow = (short) => sql(db, `SELECT * FROM counterparties WHERE short_name=${JSON.stringify(short).replace(/"/g, "'")}`)[0];

try {
  await login(b, base, "admin");
  console.log("\n== создание ==");
  await go("#/counterparties");
  await waitIn("Добавить контрагента");
  const total0 = Number(sql1(db, "SELECT COUNT(*) FROM counterparties"));
  await b.clickSel("#cp-add");
  await b.waitFor(`!!document.querySelector('#cpf-short')`);
  // валидация: пустые наименования — запрос не уходит
  let mark = b.requests.length;
  await b.clickSel("#cpf-code"); await b.type("ТЕСТ1");
  await clickBtn(b, "Сохранить");
  await waitSt("Укажите полное и краткое наименование");
  check("C1.1 пустые наименования: сообщение, ни одного запроса записи", writeReqs(b, mark).length === 0);
  await typeInto(b, "#cpf-short", "QA-Создан");
  await typeInto(b, "#cpf-full", "ООО «QA-Создан»");
  await typeInto(b, "#cpf-inn", "7700000099");
  await typeInto(b, "#cpf-contact-phone", "+7 900 000-00-99");
  const a0 = maxActivityId(db);
  mark = b.requests.length;
  const r = await b.rect("#cp-save");
  await b.click(r.cx, r.cy, { count: 2 });                      // двойной щелчок
  await waitSt("Добавлено");
  const w = writeReqs(b, mark);
  check("C1.2 двойной щелчок «Сохранить»: ровно один POST /counterparties", w.length === 1 && w[0].method === "POST" && w[0].path === "/counterparties", JSON.stringify(w.map((x) => [x.method, x.path])));
  const created = cpRow("QA-Создан");
  check("C1.3 SQL: запись создана с введёнными полями (код задан), одна", created && created.full_name === "ООО «QA-Создан»" && created.inn === "7700000099" && created.contact_phone === "+7 900 000-00-99" && created.code === "ТЕСТ1" && Number(sql1(db, "SELECT COUNT(*) FROM counterparties")) === total0 + 1, JSON.stringify(created));
  const act = await activity(db, `id>${a0}`);
  check("C1.4 журнал: одно событие counterparty_create", act.length === 1 && act[0].action === "counterparty_create", JSON.stringify(act));
  await go("#/counterparties");
  await waitIn("QA-Создан");
  check("C1.5 после перезагрузки страницы контрагент в списке", (await inner()).includes("QA-Создан"));

  console.log("\n== правка и нормативы ==");
  const id1 = created.id;
  await openCard("QA-Создан");
  await typeInto(b, "#cpf-contact-phone", "+7 900 111-11-11");
  const a1 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitSt("Сохранено");
  const w2 = writeReqs(b, mark);
  check("C2.1 правка: один PATCH с expected_version (версия записи, которую видел человек)", w2.length === 1 && w2[0].method === "PATCH" && w2[0].path === `/counterparties/${id1}` && /"expected_version":"[0-9a-f]{16}"/.test(w2[0].body), JSON.stringify(w2.map((x) => [x.method, x.path, (x.body || "").slice(-60)])));
  check("C2.2 SQL: телефон изменён, остальное прежнее", cpRow("QA-Создан").contact_phone === "+7 900 111-11-11" && cpRow("QA-Создан").inn === "7700000099");
  const act2 = await activity(db, `id>${a1}`);
  check("C2.3 журнал: одно событие counterparty_update", act2.length === 1 && act2[0].action === "counterparty_update", JSON.stringify(act2));
  // нормативы
  await b.eval(`document.querySelector('[data-tab="other"]').click()`);
  await sleep(400);
  await b.clickSel("#cp-cap-new-type"); await b.type("Колонна");
  await b.clickSel("#cp-cap-add-row");
  await sleep(300);
  await b.eval(`document.querySelector('[data-cap-per-day="0"]').scrollIntoView({block:'center'})`);
  await b.clickSel('[data-cap-per-day="0"]', { count: 3 }); await b.type("5.5");
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitSt("Сохранено");
  check("C2.4 SQL: норматив производительности записан (Колонна 5,5 шт./день)", Number(sql1(db, `SELECT per_day FROM counterparty_capacity WHERE counterparty_id=${id1} AND element_type='Колонна'`)) === 5.5);
  // возврат к «ничего не менялось»: «Сохранить» недоступна без правок
  check("C2.5 без правок кнопка «Сохранить» отсутствует (нет пустых записей в журнал)", (await btnState(b, "Сохранить")) === "absent");

  console.log("\n== конфликт устаревших данных ==");
  await openCard("QA-Создан");
  const cur = await rawApi(b, "GET", "/counterparties");
  const mine = cur.json.find((c) => c.id === id1);
  // «другой пользователь» меняет телефон (через API страницы)
  const other = await rawApi(b, "PATCH", `/counterparties/${id1}`, { full_name: mine.full_name, short_name: mine.short_name, inn: mine.inn, kpp: null, ogrn: null, legal_address: null, contact_person: null, contact_phone: "+7 999 чужой", code: mine.code, capacity: mine.capacity, expected_version: mine.version });
  check("C3.0 подготовка: чужая правка прошла", other.status === 200 && other.json.contact_phone === "+7 999 чужой");
  await typeInto(b, "#cpf-kpp", "770001001");
  mark = b.requests.length;
  const fpC = fingerprint(db, CP_TABLES);
  await clickBtn(b, "Сохранить");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const dlg = await dialogText(b);
  check("C3.1 сервер отказал 409: диалог конфликта (Отмена / Показать актуальные / Сохранить поверх)", dlg.includes("изменил другой пользователь") && dlg.includes("Показать актуальные данные") && dlg.includes("Сохранить поверх"), dlg.slice(0, 200));
  await dialogClick(b, "Отмена (оставить мой ввод)");
  await sleep(500);
  check("C3.2 «Отмена»: ничего не записано (SQL — чужая правка на месте), введённое КПП осталось в поле", diffFp(fpC, fingerprint(db, CP_TABLES)).length === 0 && cpRow("QA-Создан").contact_phone === "+7 999 чужой" && (await b.eval(`document.querySelector('#cpf-kpp').value`)) === "770001001");
  // «Сохранить поверх»
  await clickBtn(b, "Сохранить");
  await dialogClick(b, "Сохранить поверх");
  await waitSt("Сохранено");
  const over = cpRow("QA-Создан");
  check("C3.3 «Сохранить поверх»: записаны значения формы (КПП мой, телефон — тот, что был в форме, чужая правка перезаписана осознанно)", over.kpp === "770001001" && over.contact_phone === "+7 900 111-11-11", JSON.stringify(over));
  // «Показать актуальные»
  await openCard("QA-Создан");
  const cur2 = (await rawApi(b, "GET", "/counterparties")).json.find((c) => c.id === id1);
  await rawApi(b, "PATCH", `/counterparties/${id1}`, { full_name: cur2.full_name, short_name: cur2.short_name, inn: cur2.inn, kpp: cur2.kpp, ogrn: null, legal_address: "чужой адрес", contact_person: null, contact_phone: cur2.contact_phone, code: cur2.code, capacity: cur2.capacity, expected_version: cur2.version });
  await typeInto(b, "#cpf-ogrn", "1027700000099");
  await clickBtn(b, "Сохранить");
  await dialogClick(b, "Показать актуальные данные");
  await sleep(600);
  check("C3.4 «Показать актуальные»: форма показывает чужую правку (адрес), мой ввод сброшен, ОГРН не записан", (await b.eval(`document.querySelector('#cpf-address').value`)) === "чужой адрес" && (await b.eval(`document.querySelector('#cpf-ogrn').value`)) === "" && cpRow("QA-Создан").ogrn == null);

  console.log("\n== потеря ответа и обрыв сети ==");
  await openCard("QA-Создан");
  await typeInto(b, "#cpf-contact-person", "Иванов И.И.");
  await dropResponses(b, "/counterparties/");
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitSt("Сохранено", 20000).catch(() => {});
  await sleep(800);
  const w3 = writeReqs(b, mark);
  check("C4.1 потеря ответа при правке: ровно один PATCH (автоповтора нет)", w3.filter((x) => x.method === "PATCH").length === 1, JSON.stringify(w3.map((x) => x.method)));
  check("C4.2 сервер применил, интерфейс сверился и подтвердил: контактное лицо в БД и в форме, ошибки нет", cpRow("QA-Создан").contact_person === "Иванов И.И." && (await st()).includes("Сохранено") && !(await inner()).includes("Нет связи"), await st());
  await restoreFetch(b);
  // обрыв сети до отправки
  await typeInto(b, "#cpf-contact-person", "Петров П.П.");
  const fpN = fingerprint(db, CP_TABLES);
  await b.offline(true);
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitSt("Не удалось определить результат", 8000).catch(() => {});
  await sleep(500);
  const stOff = await st();
  await b.offline(false);
  check("C4.3 без сети: понятное сообщение, данные не изменены, введённое сохранено, кнопка снова доступна", diffFp(fpN, fingerprint(db, CP_TABLES)).length === 0 && (await b.eval(`document.querySelector('#cpf-contact-person').value`)) === "Петров П.П." && (await btnState(b, "Сохранить")) === "enabled", stOff);
  // потеря ответа при СОЗДАНИИ: дубль не создаётся
  await go("#/counterparties");
  await waitIn("Добавить контрагента");
  const n0 = Number(sql1(db, "SELECT COUNT(*) FROM counterparties WHERE short_name='QA-Потеря'"));
  await b.clickSel("#cp-add"); await b.waitFor(`!!document.querySelector('#cpf-short')`);
  await typeInto(b, "#cpf-short", "QA-Потеря"); await typeInto(b, "#cpf-full", "ООО «QA-Потеря»");
  await dropResponses(b, "/counterparties$");
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await sleep(2500);
  check("C4.4 потеря ответа при создании: один POST, запись в БД одна (не дубль), интерфейс подтвердил создание", writeReqs(b, mark).filter((x) => x.method === "POST").length === 1 && Number(sql1(db, "SELECT COUNT(*) FROM counterparties WHERE short_name='QA-Потеря'")) === n0 + 1 && !(await st()).includes("Нет связи"), await st());
  await restoreFetch(b);

  console.log("\n== совместимость V1 ==");
  await hardGoto(b, `${base}/?ui=v1&object_id=1&open=menu&item=menu-counterparties`, 3500);
  await b.waitFor(`(document.getElementById('counterparties-backdrop')?.innerText||'').includes('QA-Создан')`, 90000).catch(() => {});
  const v1t = await b.eval(`document.getElementById('counterparties-backdrop')?.innerText||''`);
  check("V1.1 совместимость: справочник контрагентов V1 показывает контрагента, созданного и правленного в V2", v1t.includes("QA-Создан"), v1t.slice(0, 200).replace(/\n+/g, " | "));

  console.log("\n== права ==");
  const rV = await b.eval(`(async()=>{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({domain_login:'user4',password:'Test-Pass-1234!'})});return r.status})()`);
  await go("#/counterparties");
  await sleep(800);
  const navHas = await b.eval(`!!document.querySelector('[data-section="counterparties"]')`);
  const p1 = await rawApi(b, "POST", "/counterparties", { full_name: "x", short_name: "x" });
  const p2 = await rawApi(b, "PATCH", `/counterparties/${id1}`, { full_name: "x", short_name: "x" });
  check("C5.1 роль view: раздела нет в навигации; POST и PATCH контрагентов — 403 от сервера, БД не изменена", rV === 200 && !navHas && p1.status === 403 && p2.status === 403 && cpRow("QA-Создан").full_name === "ООО «QA-Создан»", `${rV} nav=${navHas} ${p1.status} ${p2.status}`);
  await rawApi(b, "POST", "/logout");
  await b.close();
  const b2 = await openBrowser(1920, 1080);
  try {
    await login(b2, base, "user2");
    await b2.goto(`${base}/v2#/counterparties`, 1500);
    await b2.waitFor(`document.querySelector('#cp-inner')?.innerText.includes('Добавить контрагента')`, 20000);
    check("C5.2 роль «Комплектовщик»: раздел открывается, «Добавить контрагента» доступна", true);
    const trash = await b2.eval(`document.querySelectorAll('[data-del]').length`);
    check("C5.3 у «Комплектовщика» нет права удаления справочника (dict_delete): значков удаления нет", trash === 0, String(trash));
    // ограничение до «только чтение» по контрагентам: серверные права меняются на копии, интерфейс и сервер отказывают
    exec(db, `UPDATE role_features SET level='read' WHERE role_key='contract' AND feature_key='counterparties'`);
    const pr = await b2.eval(`fetch('/counterparties',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({full_name:'y',short_name:'y'})}).then(r=>r.status)`);
    check("C5.4 «Комплектовщик» с правом counterparties=read: POST /counterparties — 403 от сервера", pr === 403, String(pr));
    exec(db, `UPDATE role_features SET level='write' WHERE role_key='contract' AND feature_key='counterparties'`);
  } finally { await b2.close(); }

  console.log("\nисключения браузера:", b.exceptions.length);
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_cp1/fail.png`); } catch { /* */ }
} finally {
  try { await b.close(); } catch { /* */ }
  await stopServer();
}
process.exit(summary() ? 1 : 0);
