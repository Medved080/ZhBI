// Удаление контрагента / договора / спецификации / контракта по плану последствий в V2 (настоящий backend, копия БД, вход формой, реальные события):
// предпросмотр, отмена, каскад пустого дерева, выбор замен по иерархии владельцев, отказ стража с откатом и без изменений, успешный перенос изделий и истории,
// двойной щелчок, устаревший план, потеря ответа, права; плюс проверки шлюза (режим «свёртка» и прочее отключено). Запуск: node scripts/picker_verify/cp3.mjs (порт 8137)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto } from "./lib.mjs";
import { prepareCp, CP_TABLES, text, clickBtn, dialogClick, dialogText, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, clickSelScrolled, selectValue, sql, sql1, exec } from "./common.mjs";
import { checkWrite } from "../../app/static/v2/write-gate.js";

const prep = (db) => {
  prepareCp(db);
  const one = (q) => Number(sql1(db, q));
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Пустой»','QA-Пустой','QAP1'),('ООО «QA-Пустой2»','QA-Пустой2','QAP2'),('ООО «QA-Дерево»','QA-Дерево','QADR'),('ООО «QA-Старый2»','QA-Старый2','QAOLD2');`);
  const cp = (n) => one(`SELECT id FROM counterparties WHERE short_name='${n}'`);
  // «Дерево»: договор → спецификация → контракт с позицией, изделий нет
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (${cp("QA-Дерево")},'QA-ДД','2026-09-01',1),(${cp("QA-Старый2")},'QA-Д5','2026-09-05',1);`);
  const ag = (n) => one(`SELECT id FROM agreements WHERE number='${n}'`);
  exec(db, `INSERT INTO specifications (agreement_id, number) VALUES (${ag("QA-ДД")},'QA-СД'),(${ag("QA-Д5")},'QA-С5');`);
  const sp = (n) => one(`SELECT id FROM specifications WHERE number='${n}'`);
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES (${sp("QA-СД")},'QA-дерево'),(${sp("QA-С5")},'QA-старый2');`);
  const co = (t) => one(`SELECT id FROM contracts WHERE theme='${t}'`);
  exec(db, `INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (${co("QA-дерево")},'Ригель','3Р19',3),(${co("QA-старый2")},'Ригель','3Р19',5);`);
  const els = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL AND current_status='planned' AND mark='3Р19' ORDER BY id LIMIT 3 OFFSET 20").map((r) => r.id);
  exec(db, `UPDATE elements SET contract_id=${co("QA-старый2")}, current_status='contracting' WHERE id IN (${els.join(",")});`);
  for (const id of els) exec(db, `INSERT INTO status_history (element_id, status, changed_by, contract_id, comment) VALUES (${id}, 'contracting', 'тест', ${co("QA-старый2")}, 'QA2');`);
  // контракт для удаления с переносом в спецификации QA-С2 (2 изделия)
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES (${sp("QA-С2")},'QA-удаляемый');`);
  exec(db, `INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (${co("QA-удаляемый")},'Ригель','3Р19',5);`);
  const els2 = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL AND current_status='planned' AND mark='3Р19' ORDER BY id LIMIT 2 OFFSET 40").map((r) => r.id);
  exec(db, `UPDATE elements SET contract_id=${co("QA-удаляемый")}, current_status='contracting' WHERE id IN (${els2.join(",")});`);
  for (const id of els2) exec(db, `INSERT INTO status_history (element_id, status, changed_by, contract_id, comment) VALUES (${id}, 'contracting', 'тест', ${co("QA-удаляемый")}, 'QA3');`);
};
const S = await startServer(8137, `${SP}/picker_cp3`, { setup: prep });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#cp-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const one = (q) => Number(sql1(db, q));
const cpId = (n) => one(`SELECT id FROM counterparties WHERE short_name='${n}'`);
const trash = async (short) => { await b.eval(`(()=>{const row=[...document.querySelectorAll('#cp-list .v2-perm')].find(x=>x.innerText.includes(${JSON.stringify(short)}));row.querySelector('[data-del]').scrollIntoView({block:'center'})})()`); const id = cpId(short); await clickSelScrolled(b, `[data-del="${id}"]`); };
const listPage = async () => { await go("#/counterparties"); await waitIn("Добавить контрагента"); };

try {
  await login(b, base, "admin");

  console.log("\n== удаление без ссылок ==");
  await listPage();
  const idP = cpId("QA-Пустой");
  let mark = b.requests.length;
  await trash("QA-Пустой");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const t1 = await dialogText(b);
  check("D1.1 предпросмотр: подтверждение «Удалить контрагента?»", t1.includes("Удалить контрагента"), t1.slice(0, 200));
  await dialogClick(b, "Отмена");
  await sleep(300);
  check("D1.2 «Отмена»: ни одного запроса записи, запись на месте", writeReqs(b, mark).length === 0 && one(`SELECT COUNT(*) FROM counterparties WHERE id=${idP}`) === 1);
  const a0 = maxActivityId(db);
  await trash("QA-Пустой");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const rC = await b.eval(`(()=>{const e=[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Удалить');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  mark = b.requests.length;
  await b.click(rC.x, rC.y, { count: 2 });                            // двойной щелчок по подтверждению
  await sleep(1500);
  const w1 = writeReqs(b, mark);
  check("D1.3 двойной щелчок «Удалить»: один POST …/counterparty/ID/delete, тело {replacements:{}, mode:replace}", w1.length === 1 && w1[0].path === `/dictionaries/counterparty/${idP}/delete` && /"mode":"replace"/.test(w1[0].body), JSON.stringify(w1.map((x) => [x.path, x.body])));
  check("D1.4 SQL: запись удалена; журнал dictionary_delete один", one(`SELECT COUNT(*) FROM counterparties WHERE id=${idP}`) === 0 && (await activity(db, `id>${a0}`)).filter((x) => x.action === "dictionary_delete").length === 1);
  await listPage();
  check("D1.5 после перезагрузки записи нет в списке", !(await text(b, "#cp-inner")).includes("QA-Пустой»") && !/QA-Пустой(?!2)/.test(await text(b, "#cp-inner")));

  console.log("\n== каскад без ссылок ==");
  const idT = cpId("QA-Дерево");
  await trash("QA-Дерево");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const t2 = await dialogText(b);
  check("D2.1 предпросмотр перечисляет, что уйдёт вместе: договор, спецификация, контракт, позиции", /Договор: 1/.test(t2) && /Спецификация: 1/.test(t2) && /Контракт: 1/.test(t2) && /Позиции контракта: 1/.test(t2), t2.slice(0, 260));
  const fpTree = fingerprint(db, ["elements", "status_history", "default_contracts"]);
  await dialogClick(b, "Удалить");
  await sleep(1500);
  check("D2.2 SQL: контрагент, договор, спецификация, контракт и позиции удалены; остальные таблицы не тронуты", one(`SELECT COUNT(*) FROM agreements WHERE number='QA-ДД'`) === 0 && one(`SELECT COUNT(*) FROM contracts WHERE theme='QA-дерево'`) === 0 && one(`SELECT COUNT(*) FROM contract_lines WHERE contract_id NOT IN (SELECT id FROM contracts)`) === 0 && diffFp(fpTree, fingerprint(db, ["elements", "status_history", "default_contracts"])).length === 0 && one("SELECT COUNT(*) FROM elements WHERE contract_id IS NOT NULL AND contract_id NOT IN (SELECT id FROM contracts)") === 0);

  console.log("\n== удаление со ссылками: выбор замен ==");
  await listPage();
  const oldId = cpId("QA-Старый"), newId = cpId("QA-Новый");
  const oldAg = one("SELECT id FROM agreements WHERE number='QA-Д1'"), oldSp = one("SELECT id FROM specifications WHERE number='QA-С1'"), oldCo = one("SELECT id FROM contracts WHERE theme='QA-старый'");
  const newAg2 = one("SELECT id FROM agreements WHERE number='QA-Д2'"), newAg3 = one("SELECT id FROM agreements WHERE number='QA-Д3'");
  const newSp2 = one("SELECT id FROM specifications WHERE number='QA-С2'"), newSp4 = one("SELECT id FROM specifications WHERE number='QA-С4'");
  const newCoGood = one("SELECT id FROM contracts WHERE theme='QA-новый'"), newCoBad = one("SELECT id FROM contracts WHERE theme='QA-плохой'");
  const elsOld = sql(db, `SELECT id FROM elements WHERE contract_id=${oldCo}`).map((r) => r.id);
  const histBefore = one(`SELECT COUNT(*) FROM status_history WHERE contract_id=${oldCo}`);
  await trash("QA-Старый");
  await b.waitFor(`!!document.querySelector('[data-dp-sel]')`, 15000);
  const dlg = await dialogText(b).catch(() => "");
  const dpTxt = await b.eval(`document.querySelector('.v2-dialog')?.innerText`);
  check("D3.1 диалог замен: перечислены запись и подчинённые (договор, спецификация, контракт) со ссылками (изделия, история)", /Контрагент/.test(dpTxt) && /Договор/.test(dpTxt) && /Спецификация/.test(dpTxt) && /Контракт/.test(dpTxt) && /Изделия: 3/.test(dpTxt), dpTxt.slice(0, 400));
  check("D3.2 «Подтвердить» недоступна, пока не выбраны все замены", await b.eval(`document.querySelector('[data-dp="ok"]').disabled`));
  // неверная цепочка: контракт-замена без позиции под марку
  await selectValue(b, `[data-dp-sel="counterparty:${oldId}"]`, newId);
  await b.waitFor(`!!document.querySelector('[data-dp-sel="agreement:${oldAg}"]')`);
  const agOpts = await b.eval(`[...document.querySelector('[data-dp-sel="agreement:${oldAg}"]').options].map(o=>o.textContent)`);
  check("D3.3 иерархия владельцев: договор-замена предлагается только из договоров выбранного контрагента-замены (Д2, Д3)", agOpts.some((t) => t.includes("QA-Д2")) && agOpts.some((t) => t.includes("QA-Д3")) && !agOpts.some((t) => t.includes("QA-Д1") || t.includes("QA-Д5")), JSON.stringify(agOpts));
  await selectValue(b, `[data-dp-sel="agreement:${oldAg}"]`, newAg3);
  await b.waitFor(`!!document.querySelector('[data-dp-sel="specification:${oldSp}"]')`);
  await selectValue(b, `[data-dp-sel="specification:${oldSp}"]`, newSp4);
  await b.waitFor(`!!document.querySelector('[data-dp-sel="contract:${oldCo}"]')`);
  await selectValue(b, `[data-dp-sel="contract:${oldCo}"]`, newCoBad);
  await sleep(200);
  const fpBad = fingerprint(db, CP_TABLES);
  const aBad = maxActivityId(db);
  mark = b.requests.length;
  await clickSelScrolled(b, '[data-dp="ok"]');
  await b.waitFor(`(document.querySelector('#dp-error')?.innerText||'').length>10`, 15000);
  const errT = await text(b, "#dp-error");
  check("D3.4 замена без позиции под марку: сервер отказал (страж покрытия), текст причины в окне, окно осталось открытым", /без позиции|нет позиции|позици/i.test(errT) && (await b.eval(`!!document.querySelector('[data-dp="ok"]')`)), errT.slice(0, 250));
  check("D3.5 SQL: ничего не изменено (полный откат: изделия, история, справочники, контракты)", diffFp(fpBad, fingerprint(db, CP_TABLES)).length === 0);
  check("D3.6 журнал: отказавшее удаление не записало событий об изменении", (await activity(db, `id>${aBad}`)).filter((x) => x.action !== "request_denied").length === 0);
  check("D3.7 выбор в окне сохранён после отказа (можно поправить и подтвердить снова)", (await b.eval(`document.querySelector('[data-dp-sel="contract:${oldCo}"]').value`)) === String(newCoBad));
  // правильная цепочка
  await selectValue(b, `[data-dp-sel="agreement:${oldAg}"]`, newAg2);
  await b.waitFor(`document.querySelector('[data-dp-sel="specification:${oldSp}"]') && document.querySelector('[data-dp-sel="specification:${oldSp}"]').value===''`, 10000);
  await selectValue(b, `[data-dp-sel="specification:${oldSp}"]`, newSp2);
  await b.waitFor(`document.querySelector('[data-dp-sel="contract:${oldCo}"]')`);
  await selectValue(b, `[data-dp-sel="contract:${oldCo}"]`, newCoGood);
  await sleep(200);
  const a1 = maxActivityId(db);
  mark = b.requests.length;
  const rOk = await b.rect('[data-dp="ok"]');
  await b.click(rOk.cx, rOk.cy, { count: 2 });                        // двойной щелчок
  await b.waitFor(`!document.querySelector('.v2-dialog-backdrop')`, 20000);
  await sleep(600);
  const w2 = writeReqs(b, mark);
  check("D3.8 двойной щелчок «Подтвердить»: один POST /dictionaries/counterparty/ID/delete с картой замен по всем четырём уровням", w2.length === 1 && w2[0].path === `/dictionaries/counterparty/${oldId}/delete` && Object.keys(JSON.parse(w2[0].body).replacements).length === 4, JSON.stringify(w2.map((x) => x.body)));
  check("D3.9 SQL: контрагент, его договор, спецификация, контракт и позиции удалены", one(`SELECT COUNT(*) FROM counterparties WHERE id=${oldId}`) === 0 && one(`SELECT COUNT(*) FROM agreements WHERE id=${oldAg}`) === 0 && one(`SELECT COUNT(*) FROM specifications WHERE id=${oldSp}`) === 0 && one(`SELECT COUNT(*) FROM contracts WHERE id=${oldCo}`) === 0);
  check("D3.10 SQL: 3 изделия и записи их истории (контракт снимка) перенесены на контракт-замену; изделий без контракта нет", elsOld.every((id) => one(`SELECT contract_id FROM elements WHERE id=${id}`) === newCoGood) && one(`SELECT COUNT(*) FROM status_history WHERE contract_id=${newCoGood} AND comment='QA'`) === histBefore);
  check("D3.11 журнал: одно событие dictionary_delete", (await activity(db, `id>${a1}`)).filter((x) => x.action === "dictionary_delete").length === 1);
  await listPage();
  check("D3.12 после перезагрузки контрагента нет в списке", !(await text(b, "#cp-inner")).includes("QA-Старый»") && !/QA-Старый(?!2)/.test(await text(b, "#cp-inner")));

  console.log("\n== устаревший план ==");
  const old2 = cpId("QA-Старый2");
  await trash("QA-Старый2");
  await b.waitFor(`!!document.querySelector('[data-dp-sel]')`, 15000);
  await selectValue(b, `[data-dp-sel="counterparty:${old2}"]`, newId);
  const ag5 = one("SELECT id FROM agreements WHERE number='QA-Д5'"), sp5 = one("SELECT id FROM specifications WHERE number='QA-С5'"), co5 = one("SELECT id FROM contracts WHERE theme='QA-старый2'");
  await b.waitFor(`!!document.querySelector('[data-dp-sel="agreement:${ag5}"]')`);
  await selectValue(b, `[data-dp-sel="agreement:${ag5}"]`, newAg2);
  await b.waitFor(`document.querySelector('[data-dp-sel="specification:${sp5}"]')`);
  await selectValue(b, `[data-dp-sel="specification:${sp5}"]`, newSp2);
  await b.waitFor(`document.querySelector('[data-dp-sel="contract:${co5}"]')`);
  await selectValue(b, `[data-dp-sel="contract:${co5}"]`, newCoGood);
  // другой пользователь добавляет договор контрагенту, пока окно открыто
  const other = await rawApi(b, "POST", "/agreements", { counterparty_id: old2, number: "QA-Д6-чужой", object_id: 1 });
  const fpSt = fingerprint(db, CP_TABLES);
  mark = b.requests.length;
  await clickSelScrolled(b, '[data-dp="ok"]');
  await b.waitFor(`(document.querySelector('.v2-dialog')?.innerText||'').includes('состав удаляемого изменился')`, 15000);
  check("D4.1 план изменился, пока выбирали замены: удаление НЕ выполнено, показано объяснение; ни одного DELETE-запроса", other.status === 200 && writeReqs(b, mark).length === 0 && diffFp(fpSt, fingerprint(db, CP_TABLES)).length === 0);
  await dialogClick(b, "Понятно");

  console.log("\n== потеря ответа ==");
  await listPage();
  const idP2 = cpId("QA-Пустой2");
  await trash("QA-Пустой2");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  await dropResponses(b, "/delete$");
  mark = b.requests.length;
  await dialogClick(b, "Удалить");
  await sleep(2500);
  check("D5.1 потеря ответа: один POST, запись удалена на сервере, интерфейс сверился (записи нет — «удалён»), автоповтора нет", writeReqs(b, mark).length === 1 && one(`SELECT COUNT(*) FROM counterparties WHERE id=${idP2}`) === 0 && !(await text(b, "#cp-inner")).includes("QA-Пустой2"), String(writeReqs(b, mark).length));
  await restoreFetch(b);

  console.log("\n== контракт: удаление с переносом ==");
  await listPage();
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(x=>x.innerText.includes('QA-Новый'))?.click()`);
  await b.waitFor(`!!document.querySelector('#cpf-short')`);
  await b.eval(`document.querySelector('[data-tab="contracting"]').click()`);
  await waitIn("+ Договор");
  await b.eval(`(()=>{for(const sel of ['[data-agreement="${newAg2}"]','[data-spec="${newSp2}"]']){const d=document.querySelector(sel);if(d&&!d.open)d.querySelector('summary').click()}})()`);
  const delCo = one("SELECT id FROM contracts WHERE theme='QA-удаляемый'");
  await b.eval(`(()=>{const d=document.querySelector('[data-contract="${delCo}"]');if(d&&!d.open)d.querySelector('summary').click()})()`);
  await sleep(300);
  await b.eval(`document.querySelector('[data-c-open="edit:${delCo}"]').scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-c-open="edit:${delCo}"]`);
  await b.waitFor(`!!document.querySelector('#ctr-delete')`, 15000).catch(async () => { await b.eval(`document.querySelector('#ctr-requisites-details summary')?.click()`); await sleep(300); });
  await b.eval(`(()=>{const d=[...document.querySelectorAll('details')].find(x=>x.querySelector('summary')?.innerText.includes('Действия'));if(d&&!d.open)d.querySelector('summary').click()})()`);
  await clickSelScrolled(b, "#ctr-delete");
  await b.waitFor(`!!document.querySelector('#ctr-replacement-select')`, 15000);
  check("D6.1 контракт с привязанными изделиями: выбор контракта той же спецификации на перенос (пикер замены)", (await b.eval(`[...document.querySelector('#ctr-replacement-select').options].map(o=>o.textContent).join('|')`)).includes("QA-новый"));
  const elsDel = sql(db, `SELECT id FROM elements WHERE contract_id=${delCo}`).map((r) => r.id);
  const a2 = maxActivityId(db);
  mark = b.requests.length;
  const rR = await b.rect("#ctr-replacement-confirm");
  await b.click(rR.cx, rR.cy, { count: 2 });
  await sleep(2500);
  const w3 = writeReqs(b, mark);
  check("D6.2 двойной щелчок: один POST …/contract/ID/delete; изделия перенесены на выбранный контракт, контракт удалён", w3.length === 1 && one(`SELECT COUNT(*) FROM contracts WHERE id=${delCo}`) === 0 && elsDel.every((id) => one(`SELECT contract_id FROM elements WHERE id=${id}`) === newCoGood), JSON.stringify(w3.map((x) => x.path)));
  check("D6.3 журнал: одно событие dictionary_delete", (await activity(db, `id>${a2}`)).filter((x) => x.action === "dictionary_delete").length === 1);

  console.log("\n== права ==");
  await rawApi(b, "POST", "/logout");
  await b.close();
  const b2 = await openBrowser(1920, 1080);
  try {
    await login(b2, base, "user2");
    const p = await b2.eval(`fetch('/dictionaries/counterparty/${cpId("QA-Новый")}/delete',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({replacements:{},mode:'replace'})}).then(r=>r.status)`);
    check("D7.1 роль «Комплектовщик» (нет права dict_delete): удаление записи справочника — 403 от сервера, запись на месте", p === 403 && one("SELECT COUNT(*) FROM counterparties WHERE short_name='QA-Новый'") === 1, String(p));
  } finally { await b2.close(); }

  console.log("\n== шлюз записи (проверка формы и отключённые операции) ==");
  const ok = (m, p, body) => checkWrite(m, p, body).allowed;
  check("G1 разрешено только удаление по замене; режим «свёртка» (merge) шлюз не пускает", ok("POST", "/dictionaries/contract/5/delete", { replacements: {}, mode: "replace" }) && !ok("POST", "/dictionaries/counterparty/5/delete", { replacements: {}, mode: "merge" }));
  check("G2 неверный ключ замены и лишние поля в теле удаления — отказ до сети", !ok("POST", "/dictionaries/contract/5/delete", { replacements: { "zone:1": "2" }, mode: "replace" }) && !ok("POST", "/dictionaries/contract/5/delete", { replacements: {}, mode: "replace", x: 1 }));
  check("G3 прочее в этой области отключено: назначение контракта изделию, групповая плановая дата, контракт по умолчанию", !ok("PATCH", "/elements/5/contract", { contract_id: 1 }) && !ok("PATCH", "/elements/bulk-planned-delivery-date", { items: [] }) && !ok("PUT", "/contracts/default-map", {}));
  check("G4 неверная форма тела контракта (дубль позиции, дробное количество, лишние поля) — сообщение с причиной", checkWrite("POST", "/contracts", { specification_id: 1, lines: [{ element_type: "А", mark: "Б", quantity: 1 }, { element_type: "а", mark: "б", quantity: 2 }] }).message.includes("повторяется") && !ok("POST", "/contracts", { specification_id: 1, lines: [{ element_type: "А", mark: null, quantity: 1.5 }] }) && !ok("POST", "/contracts", { specification_id: 1, lines: [{ element_type: "А", mark: null, quantity: 1 }], hack: 1 }));
  check("G5 плановая дата: только дата ГГГГ-ММ-ДД или null, только это поле", ok("PATCH", "/elements/5/planned-delivery-date", { planned_delivery_date: "2026-12-01" }) && ok("PATCH", "/elements/5/planned-delivery-date", { planned_delivery_date: null }) && !ok("PATCH", "/elements/5/planned-delivery-date", { planned_delivery_date: "2026-02-30" }) && !ok("PATCH", "/elements/5/planned-delivery-date", { planned_delivery_date: "2026-12-01", comment: "x" }));
  check("G6 документы контрактации: обмен требует марку, замена — нет сторон обмена; проведение — только версия", ok("POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: "2026-09-21", from_contract_id: 1, to_contract_id: 2, element_ids: [1] }) && !ok("POST", "/supplier-changes", { object_id: 1, kind: "link_swap", doc_date: "2026-09-21", from_contract_id: 1, to_contract_id: 2, side_a: [1], side_b: [2] }) && ok("POST", "/supplier-changes/3/post", { expected_version: "ab" }) && !ok("POST", "/supplier-changes/3/post", { force: true }));
  console.log("\nисключения браузера:", b.exceptions.length);
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await b.shot(`${SP}/picker_cp3_fail.png`); } catch { /* */ }
} finally {
  try { await b.close(); } catch { /* */ }
  await stopServer();
}
process.exit(summary() ? 1 : 0);
