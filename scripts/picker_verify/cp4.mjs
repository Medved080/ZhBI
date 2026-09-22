// Свёртка дублей справочника контрактации (режим «merge» удаления — подчинённые переезжают к другой записи целиком, а не заменяются
// по отдельности) в V2 на настоящем backend (копия БД, вход формой, реальные события): перенос подчинённых, слияние одноимённых,
// сохранность привязок изделий (contract_id не меняется — переезжает только владелец), выбор режима в диалоге, конфликт устаревшего
// плана, права view/«Комплектовщик». Запуск: node scripts/picker_verify/cp4.mjs (порт 8183)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto } from "./lib.mjs";
import { prepareCopy, USER_PICKER, USER_VIEW, text, dialogText, activity, maxActivityId, writeReqs, rawApi, clickSelScrolled, sql, sql1, exec } from "./common.mjs";

const CP_TABLES = ["counterparties", "agreements", "specifications", "contracts", "contract_lines"];

const prep = (db) => {
  prepareCopy(db);
  // last_insert_rowid() бесполезен здесь: каждый exec() — ОТДЕЛЬНЫЙ процесс sqlite3 (своё соединение, свой счётчик).
  // Вместо этого — поиск по уникальному бизнес-ключу сразу после вставки (тот же приём, что в prepareCp).
  const idOf = (table, whereCol, whereVal) => Number(sql1(db, `SELECT id FROM ${table} WHERE ${whereCol}='${whereVal}'`));
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Дубль-А»','QA-Дубль-А','QADA'),('ООО «QA-Дубль-Б»','QA-Дубль-Б','QADB')`);
  const cpA = idOf("counterparties", "short_name", "QA-Дубль-А"), cpB = idOf("counterparties", "short_name", "QA-Дубль-Б");
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES
    (${cpA},'Д-СОВП','2026-09-01',1),(${cpB},'Д-СОВП','2026-09-02',1),(${cpA},'Д-ОТД','2026-09-03',1)`);
  const a1 = Number(sql1(db, `SELECT id FROM agreements WHERE counterparty_id=${cpA} AND number='Д-СОВП'`));
  const s1 = (() => { exec(db, `INSERT INTO specifications (agreement_id, number) VALUES (${a1},'С-1')`); return idOf("specifications", "number", "С-1"); })();
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES (${s1},'QA-conA')`);
  const conA = idOf("contracts", "theme", "QA-conA");
  exec(db, `INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (${conA}, 'Ригель', NULL, 5)`);
  const els = sql(db, "SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND contract_id IS NULL AND current_status='planned' AND element_type='Ригель' ORDER BY id LIMIT 2").map((r) => r.id);
  exec(db, `UPDATE elements SET contract_id=${conA}, current_status='contracting' WHERE id IN (${els.join(",")})`);
  for (const id of els) exec(db, `INSERT INTO status_history (element_id, status, changed_by, contract_id, comment) VALUES (${id}, 'contracting', 'тест', ${conA}, 'cp4')`);

  // отдельная пара для теста уровня «спецификация» (без сопутствующего слияния договоров)
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-СпецВладелец»','QA-СпецВладелец','QASV')`);
  const cpC = idOf("counterparties", "short_name", "QA-СпецВладелец");
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (${cpC},'Д-СПЕЦ','2026-09-04',1)`);
  const ac = idOf("agreements", "number", "Д-СПЕЦ");
  exec(db, `INSERT INTO specifications (agreement_id, number) VALUES (${ac},'С-Src'),(${ac},'С-Dst')`);
  const sSrc = idOf("specifications", "number", "С-Src");
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES (${sSrc},'QA-conSrc')`);
  const conSrc = idOf("contracts", "theme", "QA-conSrc");
  exec(db, `INSERT INTO contract_lines (contract_id, element_type, mark, quantity) VALUES (${conSrc}, 'Ригель', NULL, 2)`);
};
const S = await startServer(8183, `${SP}/picker_cp4`, { setup: prep });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(500); };
const inner = () => text(b, "#cp-inner");
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#cp-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const one = (q) => Number(sql1(db, q));
const cpId = (n) => one(`SELECT id FROM counterparties WHERE short_name='${n}'`);
const listPage = async () => { await go("#/counterparties"); await waitIn("Добавить контрагента"); };
const trash = async (short) => { const id = cpId(short); await b.eval(`[...document.querySelectorAll('#cp-list .v2-perm')].find(x=>x.innerText.includes(${JSON.stringify(short)}))?.querySelector('[data-del]')?.scrollIntoView({block:'center'})`); await clickSelScrolled(b, `[data-del="${id}"]`); };

try {
  await login(b, base, "admin");

  console.log("\n== свёртка контрагента: диалог, выбор режима по умолчанию — перенос ==");
  await listPage();
  const idA = cpId("QA-Дубль-А"), idB = cpId("QA-Дубль-Б");
  await trash("QA-Дубль-А");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 8000);
  let t = await dialogText(b);
  check("M1 диалог предлагает выбор режима (перенести / заменить по отдельности)", t.includes("Перенести") && t.includes("Заменить каждую запись по отдельности"));
  check("M2 режим по умолчанию — «merge» (радиокнопка отмечена)", await b.eval(`document.querySelector('input[name="dp-mode"][value="merge"]')?.checked`) === true);
  check("M3 в режиме merge дерево показывает ТОЛЬКО корень", (await b.eval(`document.querySelectorAll('#dp-tree > div').length`)) === 1);
  await b.waitFor(`!!document.querySelector('[data-dp-sel]')`, 8000);
  await b.eval(`(()=>{const s=document.querySelector('[data-dp-sel]');const o=[...s.options].find(o=>o.textContent.includes('QA-Дубль-Б'));s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(300);

  const fp0 = fingerprint(db, CP_TABLES);
  const a0 = maxActivityId(db);
  let mark = b.requests.length;
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Подтвердить перенос и удалить')?.click()`);
  await sleep(1200);
  const w1 = writeReqs(b, mark);
  check("M4 один POST .../counterparty/ID/delete, mode:merge, одна замена (сам контрагент)", w1.length === 1 && w1[0].path === `/dictionaries/counterparty/${idA}/delete` && /"mode":"merge"/.test(w1[0].body) && new RegExp(`"counterparty:${idA}":"${idB}"`).test(w1[0].body));
  check("M5 SQL: контрагент А удалён, Б остался", one(`SELECT COUNT(*) FROM counterparties WHERE id=${idA}`) === 0 && one(`SELECT COUNT(*) FROM counterparties WHERE id=${idB}`) === 1);
  check("M6 SQL: договор «Д-СОВП» слит (у Б остался один, не два)", one(`SELECT COUNT(*) FROM agreements WHERE counterparty_id=${idB} AND number='Д-СОВП'`) === 1);
  check("M7 SQL: спецификация «С-1» переехала под договор Б («Д-СОВП»)", one(`SELECT COUNT(*) FROM specifications WHERE number='С-1' AND agreement_id=(SELECT id FROM agreements WHERE counterparty_id=${idB} AND number='Д-СОВП')`) === 1);
  check("M8 SQL: договор «Д-ОТД» переехал к Б (перенос без слияния — номера разные)", one(`SELECT COUNT(*) FROM agreements WHERE counterparty_id=${idB} AND number='Д-ОТД'`) === 1);
  const conA = one(`SELECT id FROM contracts WHERE theme='QA-conA'`);
  check("M9 SQL: контракт QA-conA НЕ пересоздан (тот же id), позиции и изделия не тронуты", conA > 0
    && one(`SELECT COUNT(*) FROM contract_lines WHERE contract_id=${conA}`) === 1
    && one(`SELECT COUNT(*) FROM elements WHERE contract_id=${conA}`) === 2
    && one(`SELECT COUNT(*) FROM status_history WHERE contract_id=${conA}`) === 2);
  const act = await activity(db, `id>${a0}`);
  check("M10 журнал dictionary_merge (не dictionary_delete)", act.some((x) => x.action === "dictionary_merge") && !act.some((x) => x.action === "dictionary_delete"));

  console.log("\n== свёртка спецификации: контракты переезжают к другой спецификации (прямой HTTP — тот же обработчик, что и у кнопки в карточке) ==");
  const idSrc = one(`SELECT id FROM specifications WHERE number='С-Src'`);
  const idDst = one(`SELECT id FROM specifications WHERE number='С-Dst'`);
  const rSpec = await rawApi(b, "POST", `/dictionaries/specification/${idSrc}/delete`, { replacements: { [`specification:${idSrc}`]: String(idDst) }, mode: "merge" });
  check("M11 свёртка спецификации: 200, «С-Src» удалена, контракт переехал под «С-Dst» (тот же id, позиции целы)", rSpec.status === 200
    && one(`SELECT COUNT(*) FROM specifications WHERE id=${idSrc}`) === 0
    && one(`SELECT COUNT(*) FROM contracts WHERE theme='QA-conSrc' AND specification_id=${idDst}`) === 1
    && one(`SELECT COUNT(*) FROM contract_lines cl JOIN contracts co ON co.id=cl.contract_id WHERE co.theme='QA-conSrc'`) === 1, JSON.stringify(rSpec));

  console.log("\n== устаревший план (свёртка): состав изменился между открытием и подтверждением — отказ без изменений ==");
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Тройка1»','QA-Тройка1','QAT1')`);
  exec(db, `INSERT INTO counterparties (full_name, short_name, code) VALUES ('ООО «QA-Тройка2»','QA-Тройка2','QAT2')`);
  const cpT1 = one(`SELECT id FROM counterparties WHERE short_name='QA-Тройка1'`);
  const cpT2 = one(`SELECT id FROM counterparties WHERE short_name='QA-Тройка2'`);
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (${cpT1},'Д-У1','2026-09-05',1)`);
  await listPage();
  await trash("QA-Тройка1");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 8000);
  await b.waitFor(`!!document.querySelector('[data-dp-sel]')`, 8000);
  await b.eval(`(()=>{const s=document.querySelector('[data-dp-sel]');const o=[...s.options].find(o=>o.textContent.includes('QA-Тройка2'));s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await sleep(200);
  // план меняется ПОСЛЕ того, как форма его показала: добавляется ещё один договор
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (${cpT1},'Д-У2','2026-09-06',1)`);
  const fpStale = fingerprint(db, CP_TABLES);
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Подтвердить перенос и удалить')?.click()`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 10000);
  const stale = await b.eval(`document.querySelector('.v2-dialog')?.innerText`);
  check("M12 устаревший план: сообщение о том, что состав изменился, БД не тронута", /изменился/.test(stale) && diffFp(fpStale, fingerprint(db, CP_TABLES)).length === 0);

  // закрыть информационный диалог M12 («Понятно»)
  await b.eval(`document.querySelector('.v2-dialog button')?.click()`);
  await sleep(300);

  console.log("\n== права view/«Комплектовщик» ==");
  let r;
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_VIEW);
  const fpV = fingerprint(db, CP_TABLES);
  r = await rawApi(b, "POST", `/dictionaries/counterparty/${cpId("QA-Тройка1")}/delete`, { replacements: { [`counterparty:${cpId("QA-Тройка1")}`]: String(cpT2) }, mode: "merge" });
  check("M13 view: свёртка — 403, ничего не изменено", r.status === 403 && diffFp(fpV, fingerprint(db, CP_TABLES)).length === 0);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_PICKER);
  // dict_delete — право администратора СЕРВИСА (`require_service_feature`, не выдаётся ролям объекта): «Комплектовщику» здесь, как и в V1, отказ.
  r = await rawApi(b, "GET", `/dictionaries/counterparty/${cpId("QA-Тройка1")}/delete-plan`);
  check("M14 «Комплектовщик»: удаление/свёртка справочника — не его право, 403 (как в V1)", r.status === 403, JSON.stringify(r));
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);

} finally {
  await b.close();
  await stopServer();
}

process.exit(summary());
