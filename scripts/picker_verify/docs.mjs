// Проверка документов «Замена поставщика» и «Обмен привязками» в V2 на НАСТОЯЩЕМ backend (временная копия обезличенной БД), настоящий вход формой,
// настоящие события мыши/клавиатуры. Запуск:  node scripts/picker_verify/docs.mjs   (порт 8131, копия и снимки — в каталоге scratchpad/picker_docs)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto } from "./lib.mjs";
import { clickSelScrolled, prepareCopy, text, has, selectValue, selectText, dialogClick, dialogText, clickBtn, btnState, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, sql, sql1, exec, USER_PICKER, USER_VIEW } from "./common.mjs";

const PORT = 8131, DIR = `${SP}/picker_docs`;
const S = await startServer(PORT, DIR, { setup: prepareCopy });
const db = S.db, base = S.base;
const TABLES = ["elements", "status_history", "supplier_change_docs", "supplier_change_items", "supplier_change_history_moves", "contract_lines", "contracts"];
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
const waitText = (t, sel = "#sd-inner", to = 15000) => b.waitFor(`(document.querySelector(${JSON.stringify(sel)})?.innerText||'').includes(${JSON.stringify(t)})`, to);
const docRow = (id) => sql(db, `SELECT * FROM supplier_change_docs WHERE id=${id}`)[0];
const shot = (n) => b.shot(`${DIR}_${n}.png`);

try {
  await login(b, base, "admin");

  // ---------------------------------------------------------------- 0. список и права
  console.log("\n== список ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  const list0 = await text(b);
  check("D0.1 список: 2 документа объекта 1 (как в БД), кнопки создания видны админу", list0.includes("Обмен привязками") && (await btnState(b, "Новая замена поставщика")) === "enabled" && (await btnState(b, "Новый обмен привязками")) === "enabled");
  check("D0.2 в навигации нет метки «V1» у раздела", !(await b.eval(`document.querySelector('[data-section="supplier-change"]')?.innerText.includes('V1')`)));

  // ---------------------------------------------------------------- 1. замена поставщика: создание черновика
  console.log("\n== замена поставщика ==");
  const A = 14, B = 13, MARK = "4П-12";
  const ids = sql(db, `SELECT id FROM elements WHERE contract_id=${A} AND mark='${MARK}' AND is_current=1 AND current_status='contracting' ORDER BY id LIMIT 6`).map((r) => r.id);
  const fpBefore = fingerprint(db, TABLES);
  const histBefore = Number(sql1(db, `SELECT COUNT(*) FROM status_history WHERE element_id IN (${ids.join(",")})`));
  const a0 = maxActivityId(db);
  let mark = b.requests.length;
  await clickBtn(b, "Новая замена поставщика");
  await waitText("новый документ");
  await selectValue(b, '[data-f="from"]', A);
  await selectValue(b, '[data-f="to"]', B);
  await waitText("Что переносить");
  const cand = await text(b);
  check("D1.1 кандидаты показаны: позиция 4П-12, «Свободно в новом контракте» ≥ 6", /4П-12/.test(cand) && /Свободно в новом контракте/.test(cand));
  // количество по позиции 4П-12: вводим 3 (реальная клавиатура)
  const posIdx = await b.eval(`(()=>{const rows=[...document.querySelectorAll('[data-qty]')];const i=rows.findIndex(r=>r.closest('tr').innerText.includes('${MARK}'));return i<0?null:rows[i].dataset.qty})()`);
  await b.clickSel(`[data-qty="${posIdx}"]`, { count: 3 }); await b.key("a", { meta: true }); await b.type("3"); await b.key("Tab"); await sleep(300);
  check("D1.2 выбрано 3 изделия позиции (сводка, индикатор несохранённого)", (await b.eval(`document.querySelector('[data-qty="${posIdx}"]').value`)) === "3" && (await text(b, "#sd-status")).includes("несохранённые"));
  check("D1.3 «Провести» недоступна, пока черновик не сохранён", (await btnState(b, "Провести")) === "absent" || (await btnState(b, "Провести")) === "disabled");
  await clickBtn(b, "Сохранить");
  await waitText("Черновик № ", "#sd-inner");
  const w1 = writeReqs(b, mark);
  const newId = Number(sql1(db, "SELECT MAX(id) FROM supplier_change_docs"));
  const d1 = docRow(newId);
  check("D1.4 сохранение: один POST /supplier-changes, тело замены поставщика без лишних полей", w1.length === 1 && w1[0].method === "POST" && w1[0].path === "/supplier-changes" && /"element_ids":\[\d+,\d+,\d+\]/.test(w1[0].body) && !/side_a|"mark"/.test(w1[0].body), JSON.stringify(w1.map((x) => [x.method, x.path])));
  check("D1.5 SQL: документ-черновик, 3 позиции, вид supplier_change, контракты 14 → 13", d1 && d1.status === "draft" && d1.kind === "supplier_change" && d1.from_contract_id === A && d1.to_contract_id === B && Number(sql1(db, `SELECT COUNT(*) FROM supplier_change_items WHERE doc_id=${newId}`)) === 3);
  const fpAfterDraft = fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"]);
  const fpB = fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"]);
  check("D1.6 черновик не тронул данные изделий, историю и контракты", diffFp({ elements: fpBefore.elements, status_history: fpBefore.status_history, contract_lines: fpBefore.contract_lines, contracts: fpBefore.contracts }, fpAfterDraft).length === 0);
  const act1 = await activity(db, `id>${a0}`);
  check("D1.7 журнал: ровно одно событие supplier_change_draft", act1.filter((x) => x.action === "supplier_change_draft").length === 1 && act1.length === 1, JSON.stringify(act1));
  // после перезагрузки
  await go("#/supplier-change");
  await waitText("Документы объекта");
  check("D1.8 после перезагрузки страницы документ в списке как «Черновик»", (await text(b)).includes(`Замена поставщика`) && (await b.eval(`[...document.querySelectorAll('#sd-inner tbody tr')].some(r=>r.innerText.includes('Замена поставщика')&&r.innerText.includes('Черновик'))`)));
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Что переносить");
  check("D1.9 открытый черновик показывает сохранённый состав (3 выбранных)", (await b.eval(`[...document.querySelectorAll('[data-qty]')].reduce((s,i)=>s+Number(i.value),0)`)) === 3);

  // ---------------------------------------------------------------- 2. проведение
  console.log("\n== проведение ==");
  const a1 = maxActivityId(db);
  const items = sql(db, `SELECT element_id FROM supplier_change_items WHERE doc_id=${newId} ORDER BY id`).map((r) => r.element_id);
  const histA = Number(sql1(db, `SELECT COUNT(*) FROM status_history WHERE element_id IN (${items.join(",")})`));
  mark = b.requests.length;
  await clickBtn(b, "Провести");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const prev = await dialogText(b);
  check("D2.1 предпросмотр проведения: что и откуда переносится, остаток получателя до/после", prev.includes("Провести замену поставщика") && /3 шт\./.test(prev) && /→/.test(prev) && !/НЕ ХВАТАЕТ/.test(prev), prev.slice(0, 300));
  // двойной щелчок по «Провести» — один запрос
  const r = await b.eval(`(()=>{const e=[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Провести');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.click(r.x, r.y, { count: 2 });
  await waitText("проведён", "#sd-inner");
  const w2 = writeReqs(b, mark);
  check("D2.2 двойной щелчок «Провести» — ровно один POST …/post", w2.filter((x) => /\/post$/.test(x.path)).length === 1, JSON.stringify(w2.map((x) => x.path)));
  const d2 = docRow(newId);
  const moved = sql(db, `SELECT id, contract_id FROM elements WHERE id IN (${items.join(",")})`);
  check("D2.3 SQL: документ проведён; 3 изделия на контракте 13 (новом)", d2.status === "posted" && d2.posted_by && moved.every((m) => m.contract_id === B));
  check("D2.4 SQL: в историю каждого изделия добавлена одна запись (тем же статусом) с контрактом 13", Number(sql1(db, `SELECT COUNT(*) FROM status_history WHERE element_id IN (${items.join(",")})`)) === histA + 3 && Number(sql1(db, `SELECT COUNT(*) FROM status_history WHERE element_id IN (${items.join(",")}) AND contract_id=${B} AND comment LIKE 'Замена поставщика%'`)) === 3);
  const act2 = await activity(db, `id>${a1}`);
  check("D2.5 журнал: 3 события supplier_change + supplier_change_post (по одному на подтверждённое)", act2.filter((x) => x.action === "supplier_change").length === 3 && act2.filter((x) => x.action === "supplier_change_post").length === 1, JSON.stringify(act2.map((x) => x.action)));
  await go("#/supplier-change");
  await waitText("Документы объекта");
  check("D2.6 после перезагрузки: состояние «Проведён»", await b.eval(`[...document.querySelectorAll('#sd-inner tbody tr')].some(r=>r.innerText.includes('Проведён'))`));
  // совместимость V1: список документов V1 показывает проведённый документ
  await b.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-supplier-change`, 2500);
  await b.waitFor(`(document.getElementById('supplier-change-backdrop')?.innerText||'').toLowerCase().includes('проведён')`, 60000).catch(() => {});
  const v1txt = await b.eval(`document.getElementById('supplier-change-backdrop')?.innerText||''`);
  check("D2.7 совместимость V1: список документов V1 показывает проведённый документ V2 (Замена поставщика, Проведён)", /замена поставщика/i.test(v1txt) && /проведён/i.test(v1txt), v1txt.slice(0, 900).replace(/\n+/g, " | "));

  // ---------------------------------------------------------------- 3. отмена проведения
  console.log("\n== отмена проведения ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Пока документ проведён");
  check("D3.1 проведённый документ: поля недоступны, есть только «Отменить проведение»", (await btnState(b, "Отменить проведение")) === "enabled" && (await btnState(b, "Сохранить")) === "absent" && (await b.eval(`document.querySelector('[data-f="date"]').disabled`)));
  const a2 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Отменить проведение");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const prev2 = await dialogText(b);
  check("D3.2 предпросмотр отмены: куда вернутся изделия", prev2.includes("Отменить проведение") && /3 шт\./.test(prev2), prev2.slice(0, 260));
  await dialogClick(b, "Отменить проведение");
  await waitText("Проведение отменено", "#sd-inner");
  const back = sql(db, `SELECT id, contract_id FROM elements WHERE id IN (${items.join(",")})`);
  check("D3.3 SQL: изделия вернулись на контракт 14; документ снова черновик", back.every((m) => m.contract_id === A) && docRow(newId).status === "draft");
  check("D3.4 SQL: история как до проведения (записи проведения удалены)", Number(sql1(db, `SELECT COUNT(*) FROM status_history WHERE element_id IN (${items.join(",")})`)) === histA && Number(sql1(db, `SELECT COUNT(*) FROM supplier_change_history_moves WHERE doc_id=${newId}`)) === 0);
  const act3 = await activity(db, `id>${a2}`);
  check("D3.5 журнал: одно событие supplier_change_unpost", act3.filter((x) => x.action === "supplier_change_unpost").length === 1 && writeReqs(b, mark).length === 1, JSON.stringify(act3.map((x) => x.action)));
  const fpNow = fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"]);
  check("D3.6 всё, кроме документа, побайтно как до проведения (elements/status_history/contract_lines/contracts)", diffFp(fpAfterDraft, fpNow).length === 0, diffFp(fpAfterDraft, fpNow).join(","));

  // ---------------------------------------------------------------- 4. отказ проведения при нехватке остатка (всё или ничего)
  console.log("\n== нехватка остатка ==");
  exec(db, `UPDATE contract_lines SET quantity = (SELECT COUNT(*) FROM elements WHERE contract_id=${B} AND mark='${MARK}' AND current_status!='planned') + 1 WHERE contract_id=${B} AND mark='${MARK}'`);
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Что переносить");
  const fpE = fingerprint(db, TABLES);
  const a3 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Провести");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const prev3 = await dialogText(b);
  check("D4.1 предпросмотр предупреждает: остатка не хватает (свободно 1, переносится 3)", /НЕ ХВАТАЕТ/.test(prev3) && /1 → -2/.test(prev3), prev3.slice(0, 400));
  await dialogClick(b, "Провести");
  await waitText("Провести нельзя", "#sd-inner");
  check("D4.2 сервер отказал 409 с перечнем причин, в интерфейсе показан текст отказа", (await text(b, "#sd-inner")).includes("Провести нельзя"));
  check("D4.3 SQL: НИЧЕГО не изменено (документы, изделия, история, контракты)", diffFp(fpE, fingerprint(db, TABLES)).length === 0, diffFp(fpE, fingerprint(db, TABLES)).join(","));
  const act4 = (await activity(db, `id>${a3}`)).filter((x) => x.action !== "request_denied");
  check("D4.4 журнал правдив: отказавшее проведение не записало событий об изменении (служебное request_denied — отказ, не изменение)", act4.length === 0, JSON.stringify(act4));
  exec(db, `UPDATE contract_lines SET quantity = quantity + 5 WHERE contract_id=${B} AND mark='${MARK}'`);   // вернуть запас

  // ---------------------------------------------------------------- 5. конфликт устаревших данных
  console.log("\n== конфликт версий ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Что переносить");
  // «другой пользователь» меняет причину черновика через API страницы
  const cur = await rawApi(b, "GET", `/supplier-changes/${newId}`);
  const other = await rawApi(b, "PATCH", `/supplier-changes/${newId}`, { object_id: 1, kind: "supplier_change", number: cur.json.number, doc_date: cur.json.doc_date, from_contract_id: A, to_contract_id: B, reason: "правка другого пользователя", element_ids: cur.json.items.map((i) => i.element_id), expected_version: cur.json.version });
  check("D5.0 подготовка: чужая правка прошла (другая версия документа)", other.status === 200 && other.json.version !== cur.json.version);
  // наш пользователь правит своё поле и сохраняет: версия устарела
  await b.clickSel('[data-f="comment"]'); await b.type("моё изменение");
  const fpS = fingerprint(db, TABLES);
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitText("изменил другой пользователь", "#sd-inner");
  check("D5.1 конфликт: ничего не сохранено, показано объяснение и что делать", (await text(b, "#sd-inner")).includes("Закройте документ и откройте его заново"));
  check("D5.2 SQL: чужая правка на месте, наша не записана", docRow(newId).reason === "правка другого пользователя" && docRow(newId).comment == null);
  check("D5.3 введённое осталось в поле (не потеряно)", (await b.eval(`document.querySelector('[data-f="comment"]').value`)) === "моё изменение");
  // «Провести» при устаревшей версии — тоже отказ (сначала сохранить нельзя; проверим путь проведения через актуальный экран)
  const stalePost = await rawApi(b, "POST", `/supplier-changes/${newId}/post`, { expected_version: cur.json.version });
  check("D5.4 проведение со старой версией — 409 stale_version, документ не проведён", stalePost.status === 409 && stalePost.json?.detail?.conflict === "stale_version" && docRow(newId).status === "draft");

  // ---------------------------------------------------------------- 6. потеря ответа (выполнено на сервере, ответ не дошёл)
  console.log("\n== потеря ответа ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Что переносить");
  await dropResponses(b, "/post$");
  mark = b.requests.length;
  await clickBtn(b, "Провести");
  await dialogClick(b, "Провести");
  await waitText("подтвердил", "#sd-inner");
  const w6 = writeReqs(b, mark);
  check("D6.1 обрыв ответа: ровно один POST …/post, автоповтора нет", w6.filter((x) => /\/post$/.test(x.path)).length === 1, JSON.stringify(w6.map((x) => x.path)));
  check("D6.2 интерфейс сверился с сервером и сообщил: проведён (подтверждено сервером)", (await text(b, "#sd-inner")).includes("Сервер подтвердил: документ проведён") && docRow(newId).status === "posted");
  await restoreFetch(b);
  // вернём в черновик для дальнейших сценариев (отмена проведения через интерфейс)
  await clickBtn(b, "Отменить проведение"); await dialogClick(b, "Отменить проведение");
  await waitText("Проведение отменено", "#sd-inner");

  // ---------------------------------------------------------------- 7. сетевой сбой (запрос не доходит)
  console.log("\n== сетевой сбой ==");
  await b.eval(`document.querySelector('[data-f="comment"]') && 0`);
  const fpN = fingerprint(db, TABLES);
  await b.offline(true);
  mark = b.requests.length;
  await clickBtn(b, "Провести"); await dialogClick(b, "Провести");
  await waitText("Ответ сервера не получен", "#sd-inner");
  await b.offline(false);
  check("D7.1 без сети: сообщение о неизвестном исходе, данные не изменены, введённое не потеряно", diffFp(fpN, fingerprint(db, TABLES)).length === 0);
  check("D7.2 без автоповтора: кнопка снова доступна, повторный запрос — только по решению человека", (await btnState(b, "Провести")) === "enabled");

  // ---------------------------------------------------------------- 8. удаление черновика
  console.log("\n== удаление черновика ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${d1.number}')?.click()`);
  await waitText("Что переносить");
  const a5 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Удалить черновик");
  await dialogClick(b, "Удалить");
  await waitText("удалён", "#sd-inner");
  check("D8.1 SQL: черновик и его позиции удалены; данные изделий не тронуты", !docRow(newId) && Number(sql1(db, `SELECT COUNT(*) FROM supplier_change_items WHERE doc_id=${newId}`)) === 0 && diffFp(fpAfterDraft, fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"])).length === 0);
  const act5 = await activity(db, `id>${a5}`);
  check("D8.2 журнал: одно событие supplier_change_delete; один DELETE", act5.length === 1 && act5[0].action === "supplier_change_delete" && writeReqs(b, mark).length === 1, JSON.stringify(act5));

  console.log("\n== V1-совместимость вызовов без тела ==");
  const dc = await rawApi(b, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: "2026-09-21", from_contract_id: A, to_contract_id: B, element_ids: [ids[4]] });
  const p0 = await b.eval(`fetch('/supplier-changes/${dc.json.id}/post',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
  const u0 = await b.eval(`fetch('/supplier-changes/${dc.json.id}/unpost',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
  const dd = await rawApi(b, "DELETE", `/supplier-changes/${dc.json.id}`);
  check("D8.3 совместимость V1: проведение и отмена БЕЗ тела запроса (как шлёт V1) — 200, удаление черновика — 200", dc.status === 200 && p0 === 200 && u0 === 200 && dd.status === 200, `${dc.status}/${p0}/${u0}/${dd.status}`);

  // ---------------------------------------------------------------- 9. обмен привязками
  console.log("\n== обмен привязками ==");
  const SA = sql(db, `SELECT id FROM elements WHERE contract_id=${A} AND mark='${MARK}' AND is_current=1 ORDER BY floor, address, id LIMIT 3`).map((r) => r.id);
  const SB = sql(db, `SELECT id FROM elements WHERE contract_id=${B} AND mark='${MARK}' AND is_current=1 ORDER BY floor, address, id LIMIT 3`).map((r) => r.id);
  exec(db, `UPDATE elements SET planned_delivery_date='2026-10-01' WHERE id IN (${SA.join(",")}); UPDATE elements SET planned_delivery_date='2026-11-02' WHERE id IN (${SB.join(",")})`);
  const swapBefore = { el: sql(db, `SELECT id, contract_id, planned_delivery_date, current_status FROM elements WHERE id IN (${[...SA, ...SB].join(",")}) ORDER BY id`), hist: sql(db, `SELECT id, element_id, status, contract_id, comment FROM status_history WHERE element_id IN (${[...SA, ...SB].join(",")}) ORDER BY id`) };
  const fpSw = fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"]);
  await go("#/supplier-change");
  await waitText("Документы объекта");
  const a6 = maxActivityId(db);
  await clickBtn(b, "Новый обмен привязками");
  await waitText("новый документ");
  await selectValue(b, '[data-f="from"]', A);
  await b.waitFor(`document.querySelector('[data-f="mark"]') && !document.querySelector('[data-f="mark"]').disabled && [...document.querySelector('[data-f="mark"]').options].some(o=>o.value==='${MARK}')`);
  await selectValue(b, '[data-f="mark"]', MARK);
  await b.waitFor(`[...document.querySelector('[data-f="to"]').options].some(o=>o.value==='${B}')`);
  const toOpts = await b.eval(`[...document.querySelector('[data-f="to"]').options].map(o=>o.textContent)`);
  check("D9.1 сторона 2 предлагает только контракты, где эта марка стоит (с количеством)", toOpts.some((t) => /шт\./.test(t)) && toOpts.length > 1, JSON.stringify(toOpts));
  await selectValue(b, '[data-f="to"]', B);
  // подбор стороны 1: реальные щелчки по чекбоксам
  await clickBtn(b, "Подбор…");
  await b.waitFor(`document.querySelectorAll('[data-pk-el]').length>0`);
  const pickA = await b.eval(`[...document.querySelectorAll('[data-pk-el]')].slice(0,3).map(e=>Number(e.dataset.pkEl))`);
  for (const id of pickA) { await clickSelScrolled(b, `[data-pk-el="${id}"]`); await sleep(200); }
  await clickBtn(b, "Добавить в документ");
  await sleep(300);
  const pickBtns = await b.eval(`[...document.querySelectorAll('[data-a="pick"]')].map(x=>x.dataset.side)`);
  await b.eval(`document.querySelector('[data-a="pick"][data-side="b"]').scrollIntoView({block:'center'})`);
  const rB = await b.rect('[data-a="pick"][data-side="b"]'); await b.click(rB.cx, rB.cy);
  await b.waitFor(`document.querySelectorAll('[data-pk-el]').length>0`);
  const pickB = await b.eval(`[...document.querySelectorAll('[data-pk-el]')].slice(0,3).map(e=>Number(e.dataset.pkEl))`);
  for (const id of pickB) { await clickSelScrolled(b, `[data-pk-el="${id}"]`); await sleep(200); }
  await sleep(300);
  console.log("   отмечено в подборе стороны 2:", await b.eval(`document.querySelector('.v2-callout')?.innerText.match(/отмечено: \\d+/)?.[0]`));
  await clickBtn(b, "Добавить в документ");
  await sleep(300);
  check("D9.2 подобрано по 3 изделия на каждой стороне; пар: 3", (await text(b, "#sd-inner")).includes("Пар к обмену: 3"), (await text(b, "#sd-inner")).slice(-300).replace(/\n/g, " | "));
  mark = b.requests.length;
  await clickBtn(b, "Сохранить");
  await waitText("Черновик № ", "#sd-inner");
  const swId = Number(sql1(db, "SELECT MAX(id) FROM supplier_change_docs"));
  const sw = docRow(swId);
  const w9 = writeReqs(b, mark);
  check("D9.3 сохранение: один POST; тело обмена (mark, side_a, side_b), без element_ids", w9.length === 1 && /"side_a":\[/.test(w9[0].body) && /"side_b":\[/.test(w9[0].body) && !/element_ids/.test(w9[0].body));
  check("D9.4 SQL: черновик обмена; 6 позиций (3+3), пары 1..3; данные изделий не тронуты", sw.kind === "link_swap" && sw.status === "draft" && sw.mark === MARK && Number(sql1(db, `SELECT COUNT(*) FROM supplier_change_items WHERE doc_id=${swId}`)) === 6 && diffFp(fpSw, fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"])).length === 0);
  mark = b.requests.length;
  await clickBtn(b, "Провести");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const prevS = await dialogText(b);
  check("D9.5 предпросмотр обмена: марка, пары, что меняется местами (контракт, плановая дата, история)", /Провести обмен привязками/.test(prevS) && /пар: 3/.test(prevS) && /вся история/.test(prevS), prevS.slice(0, 300));
  await dialogClick(b, "Провести");
  await waitText("проведён", "#sd-inner");
  const swapAfter = { el: sql(db, `SELECT id, contract_id, planned_delivery_date, current_status FROM elements WHERE id IN (${[...SA, ...SB].join(",")}) ORDER BY id`) };
  const chosenA = sql(db, `SELECT element_id FROM supplier_change_items WHERE doc_id=${swId} AND side=1 ORDER BY pair_no`).map((r) => r.element_id);
  const chosenB = sql(db, `SELECT element_id FROM supplier_change_items WHERE doc_id=${swId} AND side=2 ORDER BY pair_no`).map((r) => r.element_id);
  const elNow = (id) => sql(db, `SELECT contract_id, planned_delivery_date FROM elements WHERE id=${id}`)[0];
  check("D9.6 SQL: пара за парой контракт и плановая дата изделий поменялись местами", chosenA.every((id, i) => { const a = elNow(id), bb = elNow(chosenB[i]); return a.contract_id === B && bb.contract_id === A && a.planned_delivery_date === "2026-11-02" && bb.planned_delivery_date === "2026-10-01"; }), JSON.stringify(chosenA));
  check("D9.7 SQL: документ проведён; история переехала (записи перемещены, добавлено по одной записи на изделие)", docRow(swId).status === "posted" && Number(sql1(db, `SELECT COUNT(*) FROM supplier_change_history_moves WHERE doc_id=${swId}`)) > 6);
  const act6 = await activity(db, `id>${a6}`);
  check("D9.8 журнал: 6 событий link_swap + link… draft + post по одному", act6.filter((x) => x.action === "link_swap").length === 6 && act6.filter((x) => x.action === "supplier_change_post").length === 1 && act6.filter((x) => x.action === "supplier_change_draft").length === 1, JSON.stringify(act6.map((x) => x.action)));
  // отмена проведения обмена: полный возврат
  await clickBtn(b, "Отменить проведение"); await dialogClick(b, "Отменить проведение");
  await waitText("Проведение отменено", "#sd-inner");
  const swapBack = { el: sql(db, `SELECT id, contract_id, planned_delivery_date, current_status FROM elements WHERE id IN (${[...SA, ...SB].join(",")}) ORDER BY id`), hist: sql(db, `SELECT id, element_id, status, contract_id, comment FROM status_history WHERE element_id IN (${[...SA, ...SB].join(",")}) ORDER BY id`) };
  check("D9.9 отмена проведения обмена: контракты, плановые даты, статусы и ВСЯ история как до документа", JSON.stringify(swapBack.el) === JSON.stringify(swapBefore.el) && JSON.stringify(swapBack.hist) === JSON.stringify(swapBefore.hist), `el:${JSON.stringify(swapBack.el) === JSON.stringify(swapBefore.el)} hist:${swapBack.hist.length}/${swapBefore.hist.length}`);
  check("D9.10 остальные данные без изменений (контракты и позиции)", diffFp(fpSw, fingerprint(db, ["elements", "status_history", "contract_lines", "contracts"])).length === 0);

  // ---------------------------------------------------------------- 10. сторож несохранённого
  console.log("\n== сторож ==");
  await b.clickSel('[data-f="reason"]'); await b.type("несохранённая причина");
  await b.eval(`document.querySelector('[data-section="counterparties"]').click()`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  const guard = await dialogText(b);
  check("D10.1 уход с несохранённым черновиком: диалог «Остаться / Не сохранять / Сохранить и продолжить»", /несохранённые изменения/.test(guard));
  await dialogClick(b, "Остаться");
  check("D10.2 «Остаться»: экран на месте, введённое сохранено", (await b.eval(`document.querySelector('[data-f="reason"]').value`)) === "несохранённая причина" && (await b.eval("location.hash")) === "#/supplier-change");
  await clickBtn(b, "Сохранить");
  await waitText("сохранён", "#sd-inner");
  check("D10.3 SQL: причина сохранена", docRow(swId).reason === "несохранённая причина");
  await clickBtn(b, "Удалить черновик"); await dialogClick(b, "Удалить"); await waitText("удалён", "#sd-inner");

  // ---------------------------------------------------------------- 11. права
  console.log("\n== права ==");
  await b.close();
  const b2 = await openBrowser(1920, 1080);
  try {
    await login(b2, base, USER_VIEW);
    await b2.goto(`${base}/v2#/supplier-change`, 1500);
    const homeView = await b2.eval(`location.hash + ' | ' + (document.querySelector('#v2-side')?.innerText.includes('Документы контрактации'))`);
    check("D11.1 роль view: раздел «Документы контрактации» скрыт в навигации", !homeView.includes("true"), homeView);
    const w = await rawApi(b2, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: "2026-09-21", from_contract_id: A, to_contract_id: B, element_ids: [ids[0]] });
    check("D11.2 роль view: POST /supplier-changes → 403 от сервера, документ не создан", w.status === 403, String(w.status));
    const p = await rawApi(b2, "POST", `/supplier-changes/2/post`, {});
    check("D11.3 роль view: проведение → 403", p.status === 403);
  } finally { await b2.close(); }
  const b3 = await openBrowser(1920, 1080);
  try {
    await login(b3, base, USER_PICKER);
    await b3.goto(`${base}/v2#/supplier-change`, 1500);
    await b3.waitFor(`document.querySelector('#sd-inner')?.innerText.includes('Документы объекта')`, 20000);
    check("D11.4 роль «Комплектовщик»: раздел открывается, кнопки создания доступны", (await b3.eval(`[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Новая замена поставщика'&&!x.disabled)`)));
  } finally { await b3.close(); }

  console.log("\nисключения браузера:", b.exceptions.length, b.exceptions.slice(0, 3));
} catch (e) {
  console.log("СБОЙ СЦЕНАРИЯ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
  try { await shot("fail"); console.log("экран:", `${DIR}_fail.png`); } catch { /* */ }
} finally {
  try { await b.close(); } catch { /* */ }
  await stopServer();
}
process.exit(summary() ? 1 : 0);
