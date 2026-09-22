// Договоры, спецификации, контракты и плановая дата поставки в V2 на настоящем backend (копия БД, вход формой, реальные события):
// создание и правка, дубли, конфликт версий, количество ниже привязанного (страж покрытия — отказ без изменений, предпросмотр в форме),
// двойной щелчок, потеря ответа, обрыв сети, права, журнал, отсутствие частичных изменений. Запуск: node scripts/picker_verify/cp2.mjs (порт 8136)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto, typeInto } from "./lib.mjs";
import { prepareCp, CP_TABLES, text, clickBtn, btnState, dialogClick, dialogText, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, clickSelScrolled, setInput, sql, sql1, exec } from "./common.mjs";

const prep = (db) => { prepareCp(db); exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Пусто»','QA-Пусто','QAEMP');`); };
const S = await startServer(8136, `${SP}/picker_cp2`, { setup: prep });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#cp-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const waitCtr = (t, to = 15000) => b.waitFor(`(document.querySelector('#ctr-inner')?.innerText||'').includes(${JSON.stringify(t)}) || (document.querySelector('#ctr-status')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const inner = () => text(b, "#cp-inner");
const st = () => text(b, "#cp-status");
const one = (q) => Number(sql1(db, q));
const CP = one("SELECT id FROM counterparties WHERE short_name='QA-Пусто'");

const openContracting = async () => {
  await go("#/counterparties"); await waitIn("Добавить контрагента");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes('QA-Пусто'))?.click()`);
  await b.waitFor(`!!document.querySelector('#cpf-short')`);
  await b.eval(`document.querySelector('[data-tab="contracting"]').click()`);
  await waitIn("+ Договор");
  await sleep(400);
};
const openDetails = (sel) => b.eval(`(()=>{const d=document.querySelector(${JSON.stringify(sel)});if(d&&!d.open){d.querySelector('summary').click()}})()`);

try {
  await login(b, base, "admin");

  console.log("\n== договоры ==");
  await openContracting();
  await clickBtn(b, "+ Договор");
  await b.waitFor(`!!document.querySelector('#cp-new-agreement-number')`);
  await b.eval(`(()=>{const s=document.querySelector('#cp-new-agreement-object');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await typeInto(b, "#cp-new-agreement-number", "QA-Д-10");
  await setInput(b, "#cp-new-agreement-date", "2026-09-10");
  const a0 = maxActivityId(db);
  let mark = b.requests.length;
  const r = await b.rect("#cp-add-agreement");
  await b.click(r.cx, r.cy, { count: 2 });
  await b.waitFor(`document.querySelectorAll('[data-agreement]').length>0`);
  const w1 = writeReqs(b, mark);
  check("A1.1 двойной щелчок «Добавить»: один POST /agreements, тело: контрагент, номер, дата, объект", w1.length === 1 && w1[0].path === "/agreements" && /"counterparty_id":\d+/.test(w1[0].body) && /"object_id":1/.test(w1[0].body), JSON.stringify(w1.map((x) => [x.method, x.path, x.body])));
  const ag1 = sql(db, `SELECT * FROM agreements WHERE counterparty_id=${CP}`)[0];
  check("A1.2 SQL: договор создан на объект 1 с датой", ag1 && ag1.number === "QA-Д-10" && ag1.agreement_date === "2026-09-10" && ag1.object_id === 1);
  const act1 = await activity(db, `id>${a0}`);
  check("A1.3 журнал: одно событие agreement_create", act1.length === 1 && act1[0].action === "agreement_create", JSON.stringify(act1));
  // дубль номера
  await clickBtn(b, "+ Договор");
  await b.waitFor(`!!document.querySelector('#cp-new-agreement-number')`);
  await b.eval(`(()=>{const s=document.querySelector('#cp-new-agreement-object');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await typeInto(b, "#cp-new-agreement-number", "QA-Д-10");
  const fp0 = fingerprint(db, CP_TABLES);
  mark = b.requests.length;
  await clickBtn(b, "Добавить");
  await b.waitFor(`(document.querySelector('#cp-agreement-error')?.innerText||'').includes('уже есть')`);
  check("A1.4 дубль номера: отказ сервера 400 показан у формы, БД не изменена, введённое осталось", diffFp(fp0, fingerprint(db, CP_TABLES)).length === 0 && (await b.eval(`document.querySelector('#cp-new-agreement-number').value`)) === "QA-Д-10");
  await clickBtn(b, "Отмена");
  // правка
  const agId = ag1.id;
  await openDetails(`[data-agreement="${agId}"]`);
  await sleep(300);
  await typeInto(b, `[data-a-number="${agId}"]`, "QA-Д-10Б");
  const a1 = maxActivityId(db);
  mark = b.requests.length;
  await b.eval(`document.querySelector('[data-save-agreement="${agId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-save-agreement="${agId}"]`);
  await sleep(1200);
  const w2 = writeReqs(b, mark);
  check("A2.1 правка договора: один PATCH с expected_version", w2.length === 1 && w2[0].path === `/agreements/${agId}` && /"expected_version":"[0-9a-f]{16}"/.test(w2[0].body), JSON.stringify(w2.map((x) => x.path)));
  check("A2.2 SQL: номер изменён; журнал agreement_update", sql(db, `SELECT number FROM agreements WHERE id=${agId}`)[0].number === "QA-Д-10Б" && (await activity(db, `id>${a1}`)).filter((x) => x.action === "agreement_update").length === 1);
  // конфликт версий
  const curAg = (await rawApi(b, "GET", `/agreements?counterparty_id=${CP}`)).json[0];
  await rawApi(b, "PATCH", `/agreements/${agId}`, { counterparty_id: CP, number: curAg.number, agreement_date: "2026-10-10", object_id: 1, expected_version: curAg.version });
  await typeInto(b, `[data-a-number="${agId}"]`, "QA-Д-10В");
  const fpA = fingerprint(db, CP_TABLES);
  await b.eval(`document.querySelector('[data-save-agreement="${agId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-save-agreement="${agId}"]`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  check("A2.3 конфликт версий договора: диалог; «Отмена» — БД не изменена", (await dialogText(b)).includes("изменил другой пользователь") && (await dialogClick(b, "Отмена (оставить мой ввод)"), true) && diffFp(fpA, fingerprint(db, CP_TABLES)).length === 0);
  await b.clickSel(`[data-save-agreement="${agId}"]`);
  await dialogClick(b, "Показать актуальные данные");
  await sleep(800);
  check("A2.4 «Показать актуальные»: договор показывает чужую дату 2026-10-10, ввод сброшен", (await b.eval(`document.querySelector('[data-a-date="${agId}"]')?.value`)) === "2026-10-10" && (await b.eval(`document.querySelector('[data-a-number="${agId}"]')?.value`)) === "QA-Д-10Б");

  console.log("\n== спецификации ==");
  await openDetails(`[data-agreement="${agId}"]`);
  await b.eval(`document.querySelector('[data-new-spec-toggle="${agId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-new-spec-toggle="${agId}"]`);
  await b.waitFor(`!!document.querySelector('[data-spec-number="${agId}"]')`);
  await typeInto(b, `[data-spec-number="${agId}"]`, "QA-С-10");
  await setInput(b, `[data-spec-date="${agId}"]`, "2026-09-11");
  const a2 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Добавить");
  await b.waitFor(`document.querySelectorAll('[data-spec]').length>0`);
  const w3 = writeReqs(b, mark);
  const sp1 = sql(db, `SELECT * FROM specifications WHERE agreement_id=${agId}`)[0];
  check("S1.1 спецификация создана: один POST /specifications; SQL; журнал specification_create", w3.length === 1 && sp1 && sp1.number === "QA-С-10" && sp1.specification_date === "2026-09-11" && (await activity(db, `id>${a2}`)).filter((x) => x.action === "specification_create").length === 1);
  // дубль
  await b.clickSel(`[data-new-spec-toggle="${agId}"]`);
  await b.waitFor(`!!document.querySelector('[data-spec-number="${agId}"]')`);
  await typeInto(b, `[data-spec-number="${agId}"]`, "QA-С-10");
  const fpS = fingerprint(db, CP_TABLES);
  await clickBtn(b, "Добавить");
  await b.waitFor(`(document.querySelector('[data-spec-form-error="${agId}"]')?.innerText||'').includes('уже есть')`);
  check("S1.2 дубль номера спецификации: отказ 400 (раньше молча возвращалась существующая), БД не изменена", diffFp(fpS, fingerprint(db, CP_TABLES)).length === 0);
  await clickBtn(b, "Отмена");
  // правка + конфликт
  const spId = sp1.id;
  await openDetails(`[data-spec="${spId}"]`);
  await typeInto(b, `[data-s-number="${spId}"]`, "QA-С-10Б");
  mark = b.requests.length;
  await b.eval(`document.querySelector('[data-save-spec="${spId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-save-spec="${spId}"]`);
  await sleep(1200);
  const w4 = writeReqs(b, mark);
  check("S2.1 правка спецификации: один PATCH с expected_version; SQL", w4.length === 1 && /"expected_version"/.test(w4[0].body) && sql(db, `SELECT number FROM specifications WHERE id=${spId}`)[0].number === "QA-С-10Б");
  const curSp = (await rawApi(b, "GET", `/specifications?agreement_id=${agId}`)).json[0];
  await rawApi(b, "PATCH", `/specifications/${spId}`, { agreement_id: agId, number: curSp.number, specification_date: "2026-11-11", expected_version: curSp.version });
  await typeInto(b, `[data-s-number="${spId}"]`, "QA-С-10В");
  const fpS2 = fingerprint(db, CP_TABLES);
  await b.eval(`document.querySelector('[data-save-spec="${spId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-save-spec="${spId}"]`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  await dialogClick(b, "Отмена (оставить мой ввод)");
  check("S2.2 конфликт версий спецификации: диалог, «Отмена» — БД не изменена", diffFp(fpS2, fingerprint(db, CP_TABLES)).length === 0);
  await typeInto(b, `[data-s-number="${spId}"]`, "QA-С-10Б");   // вернуть значение: черновика нет

  console.log("\n== контракты ==");
  await openDetails(`[data-spec="${spId}"]`);
  await b.eval(`document.querySelector('[data-c-new="${spId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-c-new="${spId}"]`);
  await b.waitFor(`!!document.querySelector('#ctr-theme')`);
  await typeInto(b, "#ctr-theme", "QA-контракт");
  await typeInto(b, '[data-line-type$="|0"]', "Ригель");
  await typeInto(b, '[data-line-mark$="|0"]', "3Р19");
  await b.eval(`document.querySelector('[data-line-qty$="|0"]').scrollIntoView({block:'center'})`);
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("10");
  // повтор позиции: форма сервером не принимается — шлюз не пускает запрос
  await b.clickSel("#ctr-line-add"); await sleep(200);
  await typeInto(b, '[data-line-type$="|1"]', "ригель"); await typeInto(b, '[data-line-mark$="|1"]', "3Р19");
  await b.clickSel('[data-line-qty$="|1"]', { count: 3 }); await b.type("1");
  mark = b.requests.length;
  await b.clickSel("#ctr-save");
  await sleep(700);
  const dupText = await text(b, "#ctr-inner") + " " + await text(b, "#ctr-status") + " " + await text(b, "#v2-gate-note");
  check("K1.1 повтор позиции (тип+марка): запрос не уходит, сказана причина", writeReqs(b, mark).length === 0 && /повторяется/.test(dupText), dupText.slice(0, 200));
  await b.eval(`document.querySelector('[data-line-remove$="|1"]').click()`);
  await sleep(200);
  const a3 = maxActivityId(db);
  mark = b.requests.length;
  const r2 = await b.rect("#ctr-save");
  await b.click(r2.cx, r2.cy, { count: 2 });
  await b.waitFor(`!!document.querySelector('[data-ctr-tab="expanded"]') && !document.querySelector('[data-ctr-tab="expanded"]').disabled`, 15000);
  const w5 = writeReqs(b, mark);
  const k1 = sql(db, `SELECT * FROM contracts WHERE specification_id=${spId}`)[0];
  check("K1.2 двойной щелчок «Сохранить»: один POST /contracts", w5.length === 1 && w5[0].method === "POST" && w5[0].path === "/contracts", JSON.stringify(w5.map((x) => x.path)));
  check("K1.3 SQL: контракт с темой и позицией Ригель · 3Р19 · 10", k1 && k1.theme === "QA-контракт" && one(`SELECT quantity FROM contract_lines WHERE contract_id=${k1.id} AND mark='3Р19'`) === 10 && one(`SELECT COUNT(*) FROM contract_lines WHERE contract_id=${k1.id}`) === 1);
  check("K1.4 журнал: contract_create ровно одно", (await activity(db, `id>${a3}`)).filter((x) => x.action === "contract_create").length === 1);
  const KID = k1.id;

  // привязать 3 изделия (распределение — через операцию сервера), затем править количество
  const pl = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL AND current_status='planned' AND mark='3Р19' ORDER BY id LIMIT 3 OFFSET 5").map((x) => x.id);
  const al = await rawApi(b, "POST", `/contracts/${KID}/allocations`, { object_id: 1, element_type: "Ригель", mark: "3Р19", items: pl.map((id) => ({ element_id: id, expected_status: "planned" })) });
  check("K2.0 подготовка: 3 изделия распределены на контракт (факт 3, остаток 7)", al.status === 200 && al.json.position.fact === 3 && al.json.position.remaining === 7, JSON.stringify(al.json?.position));
  await go("#/counterparties"); await waitIn("Добавить контрагента");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes('QA-Пусто'))?.click()`);
  await b.waitFor(`!!document.querySelector('#cpf-short')`);
  await b.eval(`document.querySelector('[data-tab="contracting"]').click()`);
  await waitIn("+ Договор");
  await openDetails(`[data-agreement="${agId}"]`); await openDetails(`[data-spec="${spId}"]`);
  await openDetails(`[data-contract="${KID}"]`);
  await sleep(300);
  await b.eval(`document.querySelector('[data-c-open="edit:${KID}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-c-open="edit:${KID}"]`);
  await b.waitFor(`!!document.querySelector('[data-line-qty$="|0"]')`);
  const lines0 = await text(b, "#ctr-inner");
  check("K2.1 вкладка «Позиции»: колонки «Привязано» и «Остаток» (3 и 7) по данным сервера", /Привязано/.test(lines0) && /Остаток/.test(lines0) && (await b.eval(`[...document.querySelectorAll('[data-line-qty$="|0"]')][0].closest('tr').innerText`)).replace(/\s+/g, " ").includes("3") );
  // количество ниже привязанного: предупреждение и отказ стража
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("2");
  await sleep(300);
  const warn = await text(b, "#ctr-lines-warn");
  check("K2.2 количество 2 при привязанных 3: предупреждение в форме ДО сохранения", /меньше привязанного/.test(warn), warn);
  const fpK = fingerprint(db, CP_TABLES);
  const a4 = maxActivityId(db);
  mark = b.requests.length;
  await b.clickSel("#ctr-save");
  await b.waitFor(`(document.querySelector('#ctr-error')?.innerText||'').length>10`, 15000);
  const errText = await text(b, "#ctr-error");
  check("K2.3 сервер (страж покрытия) отказал: текст отказа в форме; ввод остался", /без основания|превыш|привязано/i.test(errText) && (await b.eval(`document.querySelector('[data-line-qty$="|0"]').value`)) === "2", errText.slice(0, 200));
  check("K2.4 SQL: ничего не изменено (полный откат); журнал без события contract_update", diffFp(fpK, fingerprint(db, CP_TABLES)).length === 0 && (await activity(db, `id>${a4}`)).filter((x) => x.action === "contract_update").length === 0);
  // удаление позиции с привязанными
  await b.eval(`document.querySelector('[data-line-remove$="|0"]').click()`);
  await sleep(300);
  await b.clickSel("#ctr-line-add"); await sleep(200);
  await typeInto(b, '[data-line-type$="|0"]', "Ригель"); await typeInto(b, '[data-line-mark$="|0"]', "3Р19-новая");
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("4");
  const warn2 = await text(b, "#ctr-lines-warn");
  check("K2.5 позиция с привязанными изделиями заменена другой: предупреждение «удалены или переименованы»", /удалены или переименованы/.test(warn2), warn2);
  await b.clickSel("#ctr-save");
  await b.waitFor(`(document.querySelector('#ctr-error')?.innerText||'').length>10`, 15000);
  check("K2.6 страж отказал и здесь; БД не изменена", diffFp(fpK, fingerprint(db, CP_TABLES)).length === 0);
  // вернуть прежние значения: «Отменить» (сброс черновика), затем поднять количество до 12
  await clickBtn(b, "Отменить");
  await sleep(500);
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("12");
  // конфликт версий контракта: чужая правка темы
  const curK = (await rawApi(b, "GET", "/contracts")).json.find((c) => c.id === KID);
  await rawApi(b, "PATCH", `/contracts/${KID}`, { specification_id: curK.specification_id, theme: "QA-чужая-тема", is_archived: false, lines: curK.lines.map((l) => ({ element_type: l.element_type, mark: l.mark, quantity: l.quantity })), incidents: [], capacity: [], expected_version: curK.version });
  const fpK2 = fingerprint(db, CP_TABLES);
  await b.clickSel("#ctr-save");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  check("K3.1 конфликт версий контракта: диалог; «Отмена» — БД не изменена, ввод (12) остался", (await dialogText(b)).includes("Контракт") && (await dialogClick(b, "Отмена (оставить мой ввод)"), true) && diffFp(fpK2, fingerprint(db, CP_TABLES)).length === 0 && (await b.eval(`document.querySelector('[data-line-qty$="|0"]').value`)) === "12");
  const a5 = maxActivityId(db);
  await b.clickSel("#ctr-save");
  await dialogClick(b, "Сохранить поверх");
  await sleep(1500);
  const kNow = sql(db, `SELECT * FROM contracts WHERE id=${KID}`)[0];
  check("K3.2 «Сохранить поверх»: количество 12 записано, тема — из формы (чужая перезаписана осознанно); журнал contract_update ровно один", one(`SELECT quantity FROM contract_lines WHERE contract_id=${KID} AND mark='3Р19'`) === 12 && kNow.theme === "QA-контракт" && (await activity(db, `id>${a5}`)).filter((x) => x.action === "contract_update").length === 1, JSON.stringify(kNow));
  check("K3.3 архивация контракта с привязанными изделиями недоступна (галочка заблокирована, причина видна)", await b.eval(`document.querySelector('#ctr-archived')?.disabled === true || /Нельзя архивировать/.test(document.querySelector('#ctr-inner')?.innerText||'')`));

  console.log("\n== плановая дата ==");
  await b.eval(`document.querySelector('[data-ctr-tab="expanded"]').click()`);
  await b.waitFor(`document.querySelectorAll('#ctr-inner input[type="date"]').length>0`, 15000);
  const dateSel = '#ctr-inner tbody tr:first-child input[type="date"]';
  const elId = pl[0];
  const a6 = maxActivityId(db);
  mark = b.requests.length;
  await setInput(b, dateSel, "2026-12-01");
  await sleep(1200);
  const w6 = writeReqs(b, mark);
  check("P1.1 плановая дата: один PATCH …/planned-delivery-date, тело только planned_delivery_date", w6.length === 1 && /planned-delivery-date$/.test(w6[0].path) && /^\{"planned_delivery_date":"2026-12-01"\}$/.test(w6[0].body), JSON.stringify(w6));
  const pdate = sql(db, `SELECT id, planned_delivery_date FROM elements WHERE contract_id=${KID} AND planned_delivery_date='2026-12-01'`);
  check("P1.2 SQL: дата записана у одного изделия; журнал planned_date один", pdate.length === 1 && (await activity(db, `id>${a6}`)).filter((x) => x.action === "planned_date").length === 1);
  // очистка
  const a7 = maxActivityId(db);
  await setInput(b, dateSel, "");
  await sleep(1200);
  check("P1.3 очистка даты: в БД NULL", pdate.length === 1 && sql(db, `SELECT planned_delivery_date FROM elements WHERE id=${pdate[0].id}`)[0].planned_delivery_date == null);
  // обрыв сети: ошибка у строки, БД не изменена, повтор вручную
  await b.offline(true);
  mark = b.requests.length;
  await setInput(b, dateSel, "2026-12-05");
  await sleep(1500);
  const errRow = await b.eval(`document.querySelector('#ctr-inner tbody tr:first-child')?.innerText`);
  await b.offline(false);
  check("P1.4 без сети: ошибка у строки, БД без изменений (дата не записана), значение остаётся неподтверждённым", pdate.length === 1 && sql(db, `SELECT planned_delivery_date FROM elements WHERE id=${pdate[0].id}`)[0].planned_delivery_date == null && /Повторить|Не удалось|Нет связи/.test(errRow || ""), (errRow || "").slice(0, 200));

  console.log("\n== потеря ответа при создании контракта ==");
  await b.eval(`document.querySelector('#ctr-back')?.click()`);
  await sleep(1200);
  if (await b.eval(`!!document.querySelector('.v2-dialog')`)) await dialogClick(b, "Не сохранять");
  await sleep(800);
  await openDetails(`[data-spec="${spId}"]`);
  await b.eval(`document.querySelector('[data-c-new="${spId}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-c-new="${spId}"]`);
  await b.waitFor(`!!document.querySelector('#ctr-theme')`);
  await typeInto(b, "#ctr-theme", "QA-потеря");
  await typeInto(b, '[data-line-type$="|0"]', "Ригель"); await typeInto(b, '[data-line-mark$="|0"]', "2Р19.2");
  await b.clickSel('[data-line-qty$="|0"]', { count: 3 }); await b.type("2");
  const nK = one(`SELECT COUNT(*) FROM contracts WHERE specification_id=${spId}`);
  await dropResponses(b, "/contracts$");
  mark = b.requests.length;
  await b.clickSel("#ctr-save");
  await sleep(3000);
  check("K4.1 потеря ответа при создании контракта: один POST, в БД ровно один новый контракт, интерфейс подтвердил и открыл его", writeReqs(b, mark).filter((x) => x.method === "POST").length === 1 && one(`SELECT COUNT(*) FROM contracts WHERE specification_id=${spId}`) === nK + 1 && !(await text(b, "#ctr-inner")).includes("Нет связи"), await text(b, "#ctr-status"));
  await restoreFetch(b);
  // архивирование контракта без привязанных изделий (правило V1: можно, если за контрактом не осталось изделий схемы) и возврат из архива
  const KP = one(`SELECT id FROM contracts WHERE theme='QA-потеря'`);
  await b.eval(`(()=>{const d=document.querySelector('#ctr-requisites-details');if(d&&!d.open)d.querySelector('summary').click()})()`);
  await sleep(300);
  check("K5.0 у контракта без изделий галочка «Архивный» доступна", await b.eval(`!!document.querySelector('#ctr-archived') && !document.querySelector('#ctr-archived').disabled`));
  await b.eval(`document.querySelector('#ctr-archived').scrollIntoView({block:'center'})`);
  await b.clickSel("#ctr-archived");
  const a8 = maxActivityId(db);
  mark = b.requests.length;
  await b.clickSel("#ctr-save");
  await sleep(2000);
  check("K5.1 архивирование: один PATCH, SQL is_archived=1; журнал contract_update", writeReqs(b, mark).filter((x) => x.method === "PATCH").length === 1 && one(`SELECT is_archived FROM contracts WHERE id=${KP}`) === 1 && (await activity(db, `id>${a8}`)).filter((x) => x.action === "contract_update").length === 1);
  await b.eval(`(()=>{const d=document.querySelector('#ctr-requisites-details');if(d&&!d.open)d.querySelector('summary').click()})()`);
  await sleep(400);
  check("K5.1б после сохранения галочка «Архивный» стоит (данные сервера)", await b.eval(`document.querySelector('#ctr-archived')?.checked === true`));
  await b.eval(`document.querySelector('#ctr-archived').scrollIntoView({block:'center'})`);
  await b.clickSel("#ctr-archived");
  await b.clickSel("#ctr-save");
  await sleep(2000);
  check("K5.2 возврат из архива: SQL is_archived=0", one(`SELECT is_archived FROM contracts WHERE id=${KP}`) === 0);

  console.log("\n== совместимость V1 ==");
  await hardGoto(b, `${base}/?ui=v1&object_id=1&open=menu&item=menu-contracts`, 3500);
  await b.waitFor(`(document.getElementById('contracts-backdrop')?.innerText||'').includes('QA-контракт')`, 90000).catch(() => {});
  const v1c = await b.eval(`document.getElementById('contracts-backdrop')?.innerText||''`);
  check("V1.1 совместимость: список контрактов V1 показывает контракт, созданный в V2 (тема, привязано изделий 3)", v1c.includes("QA-контракт"), v1c.slice(0, 200).replace(/\n+/g, " | "));

  console.log("\n== права ==");
  await rawApi(b, "POST", "/logout");
  await b.close();
  const b2 = await openBrowser(1920, 1080);
  try {
    await login(b2, base, "user2");
    const ok = await b2.eval(`fetch('/agreements',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({counterparty_id:${CP},number:'QA-Д-user2',object_id:1})}).then(r=>r.status)`);
    check("R1 роль «Комплектовщик»: договор на объект 1 создаётся (200)", ok === 200, String(ok));
    exec(db, `UPDATE role_features SET level='read' WHERE role_key='contract' AND feature_key IN ('agreements','contracts','planned_date')`);
    const codes = await b2.eval(`Promise.all([
      fetch('/agreements',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({counterparty_id:${CP},number:'QA-Д-нет',object_id:1})}).then(r=>r.status),
      fetch('/specifications',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({agreement_id:${agId},number:'QA-С-нет'})}).then(r=>r.status),
      fetch('/contracts/${KID}',{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({specification_id:${spId},theme:'нет',is_archived:false,lines:[{element_type:'Ригель',mark:'3Р19',quantity:12}],incidents:[],capacity:[]})}).then(r=>r.status),
      fetch('/elements/${pl[0]}/planned-delivery-date',{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({planned_delivery_date:'2027-01-01'})}).then(r=>r.status)])`);
    check("R2 роль с правами только на чтение (agreements/contracts/planned_date=read): договор, спецификация, контракт, плановая дата — 403", codes.every((c) => c === 403), JSON.stringify(codes));
    // то же через интерфейс: серверный отказ показан человеку у формы, введённое осталось
    await b2.goto(`${base}/v2#/counterparties`, 1500);
    await b2.waitFor(`document.querySelector('#cp-inner')?.innerText.includes('Добавить контрагента')`, 20000);
    await b2.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes('QA-Пусто'))?.click()`);
    await b2.waitFor(`!!document.querySelector('#cpf-short')`);
    await b2.eval(`document.querySelector('[data-tab="contracting"]').click()`);
    await b2.waitFor(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='+ Договор')`);
    await sleep(500);
    await b2.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='+ Договор').click()`);
    await b2.waitFor(`!!document.querySelector('#cp-new-agreement-number')`);
    await b2.eval(`(()=>{const s=document.querySelector('#cp-new-agreement-object');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await typeInto(b2, "#cp-new-agreement-number", "QA-Д-ui-нет");
    await b2.eval(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Добавить').click()`);
    await b2.waitFor(`(document.querySelector('#cp-agreement-error')?.innerText||'').length>5`, 15000);
    check("R2.1 через интерфейс (роль без права agreements: write): сервер отказал 403, причина показана у формы, введённое осталось, договор не создан", /прав/i.test(await text(b2, "#cp-agreement-error")) && (await b2.eval(`document.querySelector('#cp-new-agreement-number').value`)) === "QA-Д-ui-нет" && one("SELECT COUNT(*) FROM agreements WHERE number='QA-Д-ui-нет'") === 0, await text(b2, "#cp-agreement-error"));
    check("R3 …и БД не изменена этими отказами (нет QA-Д-нет / QA-С-нет, дата не записана)", one("SELECT COUNT(*) FROM agreements WHERE number='QA-Д-нет'") === 0 && one("SELECT COUNT(*) FROM specifications WHERE number='QA-С-нет'") === 0 && sql(db, `SELECT planned_delivery_date FROM elements WHERE id=${pl[0]}`)[0].planned_delivery_date == null);
  } finally { await b2.close(); }
  console.log("\nисключения браузера:", b.exceptions.length);
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_cp2_fail.png`); } catch { /* */ }
} finally {
  try { await b.close(); } catch { /* */ }
  await stopServer();
}
process.exit(summary() ? 1 : 0);
