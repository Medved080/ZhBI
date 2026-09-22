// «Контракт по умолчанию по типу изделия» в V2 на настоящем backend (копия БД, вход формой, реальные события): показ разницы перед
// сохранением, замена карты ЦЕЛИКОМ (типа нет в форме — default снимается), конфликт версии, обрыв ответа, права view/«Комплектовщик»,
// отказ на контракт чужого объекта, совместимость V1 (PUT без expected_version — прежний точечный upsert). Запуск: node scripts/picker_verify/defmap.mjs (порт 8182)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto, path as urlPath } from "./lib.mjs";
import { prepareCopy, USER_PICKER, USER_VIEW, text, clickBtn, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, sql, sql1, exec } from "./common.mjs";

const DM_TABLES = ["default_contracts"];

const prep = (db) => {
  prepareCopy(db);
  // контракт на ДРУГОМ объекте — для проверки отказа при попытке назначить его по умолчанию на объект 1
  exec(db, `INSERT INTO agreements (counterparty_id, number, agreement_date, object_id) VALUES (1,'QA-ОБЪЕКТ2','2026-09-01',2);`);
  exec(db, `INSERT INTO specifications (agreement_id, number) VALUES ((SELECT id FROM agreements WHERE number='QA-ОБЪЕКТ2'),'QA-С2О');`);
  exec(db, `INSERT INTO contracts (specification_id, theme) VALUES ((SELECT id FROM specifications WHERE number='QA-С2О'),'QA-чужой-объект');`);
};
const S = await startServer(8182, `${SP}/picker_defmap`, { setup: prep });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(500); };
const inner = () => text(b, "#cl-inner");
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#cl-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const one = (q) => Number(sql1(db, q));
const otherContractId = one(`SELECT id FROM contracts WHERE theme='QA-чужой-объект'`);

try {
  await login(b, base, "admin");

  console.log("\n== показ текущей карты ==");
  await go("#/contracts");
  await waitIn("Контракт по умолчанию по типу изделия");
  // На копии оба типа объекта 1 уже заведены в default_contracts, но БЕЗ выбранного контракта (contract_id=NULL) — оба «не заданы».
  check("DM1 карта: «Колонна» — «не задан» (в БД строка есть, contract_id=NULL)", (await b.eval(`document.querySelector('select[data-dm-type="Колонна"]')?.value`)) === "");
  check("DM2 тип без default показывает «— не задан —»", (await b.eval(`document.querySelector('select[data-dm-type="Ригель"]')?.value`)) === "");
  check("DM3 кнопка «Сохранить» выключена, пока нет правок", await b.eval(`document.querySelector('[data-a="dm-save"]')?.disabled`) === true);

  console.log("\n== показ разницы и сохранение ==");
  await b.eval(`(()=>{const s=document.querySelector('select[data-dm-type="Колонна"]');s.value='3';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  check("DM4 после правки кнопка «Сохранить» включена", await b.eval(`document.querySelector('[data-a="dm-save"]')?.disabled`) === false);
  const a0 = maxActivityId(db);
  let mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 8000);
  const dlgText = await b.eval(`document.querySelector('.v2-dialog')?.innerText`);
  check("DM5 диалог показывает, что именно изменится (тип, было/будет)", dlgText.includes("Колонна") && /было:/.test(dlgText));
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Сохранить').click()`);
  await b.waitFor(`(document.querySelector('#cl-inner')?.innerText||'').includes('Сохранено')`, 10000);
  const w1 = writeReqs(b, mark);
  const w1FullPath = b.requests.slice(mark).filter((x) => x.method === "PUT").map((x) => urlPath(x.url));
  check("DM6 сохранение: один PUT /contracts/default-map с expected_version в адресе", w1.length === 1 && w1FullPath.length === 1 && /^\/contracts\/default-map\?object_id=1&expected_version=[0-9a-f]{16}$/.test(w1FullPath[0]),
    JSON.stringify({ w1, w1FullPath }));
  check("DM7 SQL: default контракт «Колонна» сменился на 3", one(`SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Колонна'`) === 3);
  check("DM8 журнал default_contracts", (await activity(db, `id>${a0} AND action='default_contracts'`)).length === 1);

  console.log("\n== замена целиком: тип, оставленный «не задан», получает NULL (форма всегда шлёт ВСЕ известные типы) ==");
  check("DM9 SQL: у «Ригель» (не трогали) контракт остался NULL — не удалён и не тронут", one(`SELECT COUNT(*) FROM default_contracts WHERE object_id=1 AND element_type='Ригель' AND contract_id IS NULL`) === 1);
  console.log("== …а тип, которого НЕТ во входящей карте вовсе, замена целиком УДАЛЯЕТ (прямой HTTP — вне текущей формы, где типы всегда все известны) ==");
  const evNow = await b.eval(`fetch('/contracts/default-map?object_id=1').then(r=>r.json()).then(async m=>{const s=JSON.stringify(Object.fromEntries(Object.keys(m).sort().map(k=>[k,m[k]])));const buf=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(s));return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16)})`);
  const rDropType = await rawApi(b, "PUT", `/contracts/default-map?object_id=1&expected_version=${evNow}`, { "Колонна": 3 });   // «Ригель» не упомянут вовсе
  check("DM9B замена целиком без упоминания типа: строка «Ригель» удалена", rDropType.status === 200 && one(`SELECT COUNT(*) FROM default_contracts WHERE object_id=1 AND element_type='Ригель'`) === 0, JSON.stringify(rDropType));
  // восстановить строку «Ригель» (NULL) для дальнейших сценариев
  exec(db, `INSERT INTO default_contracts (object_id, element_type, contract_id) VALUES (1, 'Ригель', NULL)`);

  console.log("\n== конфликт версии ==");
  await go("#/contracts"); await waitIn("Контракт по умолчанию по типу изделия");
  exec(db, `UPDATE default_contracts SET contract_id=6 WHERE object_id=1 AND element_type='Колонна'`);   // «другой пользователь»
  await b.eval(`(()=>{const s=document.querySelector('select[data-dm-type="Колонна"]');s.value='9';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickBtn(b, "Сохранить");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 8000);
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Сохранить').click()`);
  await b.waitFor(`(document.querySelector('#cl-inner')?.innerText||'').includes('изменил другой пользователь')`, 10000);
  check("DM10 конфликт версии: «чужая» правка не затёрта", one(`SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Колонна'`) === 6);
  await waitIn("Контракт по умолчанию");   // перечитала карту

  console.log("\n== обрыв ответа (неизвестный исход) ==");
  await go("#/contracts"); await waitIn("Контракт по умолчанию по типу изделия");
  await dropResponses(b, "/contracts/default-map");
  await b.eval(`(()=>{const s=document.querySelector('select[data-dm-type="Колонна"]');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickBtn(b, "Сохранить");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`, 8000);
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Сохранить').click()`);
  await b.waitFor(`(document.querySelector('#cl-inner')?.innerText||'').includes('исход неизвестен')`, 10000);
  await sleep(400);
  check("DM11 обрыв ответа: «исход неизвестен», запрос реально выполнился (default снят → NULL)", sql1(db, `SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Колонна'`) === null);
  await restoreFetch(b);

  console.log("\n== отказ: контракт чужого объекта ==");
  const fp0 = fingerprint(db, DM_TABLES);
  let r = await rawApi(b, "PUT", `/contracts/default-map?object_id=1&expected_version=${await b.eval(`fetch('/contracts/default-map?object_id=1').then(r=>r.json()).then(async m=>{const s=JSON.stringify(Object.fromEntries(Object.keys(m).sort().map(k=>[k,m[k]])));const buf=await crypto.subtle.digest('SHA-1',new TextEncoder().encode(s));return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16)})`)}`, { "Панель": otherContractId });
  check("DEFM-12 контракт чужого объекта: 400, ничего не изменено", r.status === 400 && diffFp(fp0, fingerprint(db, DM_TABLES)).length === 0, JSON.stringify(r));

  console.log("\n== права view/«Комплектовщик» ==");
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_VIEW);
  r = await rawApi(b, "GET", "/contracts/default-map?object_id=1");
  check("DM13 view: чтение доступно (READ ниже CONTRACT)", r.status === 200);
  const beforeView = sql1(db, `SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Колонна'`);
  r = await rawApi(b, "PUT", "/contracts/default-map?object_id=1", { "Колонна": 3 });
  check("DM14 view: запись — 403, ничего не изменено", r.status === 403 && sql1(db, `SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Колонна'`) === beforeView, JSON.stringify(r));
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_PICKER);
  r = await rawApi(b, "GET", "/contracts/default-map?object_id=1");
  check("DM15 «Комплектовщик»: чтение доступно", r.status === 200);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, "admin");

  console.log("\n== совместимость V1: PUT без expected_version — прежний точечный upsert ==");
  const before = sql(db, `SELECT element_type, contract_id FROM default_contracts WHERE object_id=1 AND element_type != 'Ригель' ORDER BY element_type`);
  r = await rawApi(b, "PUT", "/contracts/default-map?object_id=1", { "Ригель": 5 });
  const afterV1 = sql(db, `SELECT element_type, contract_id FROM default_contracts WHERE object_id=1 AND element_type != 'Ригель' ORDER BY element_type`);
  check("DM16 V1-путь: 200, добавлена ТОЛЬКО одна строка, остальные типы не тронуты (upsert, не замена)", r.status === 200
    && one(`SELECT contract_id FROM default_contracts WHERE object_id=1 AND element_type='Ригель'`) === 5
    && JSON.stringify(afterV1) === JSON.stringify(before), JSON.stringify({ r, before, afterV1 }));

} finally {
  await b.close();
  await stopServer();
}

process.exit(summary());
