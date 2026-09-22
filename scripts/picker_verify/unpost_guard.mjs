// Проверка стража остатка при ОТМЕНЕ проведения «Замены поставщика» (app/supplier_change.py unpost_supplier_change,
// дефект найден и исправлен 2026-09-22): полный пользовательский сценарий — провести замену поставщика → занять
// освободившийся остаток «прежнего» контракта ДРУГОЙ операцией (распределением) → попытаться отменить первую замену →
// ожидать отказ 409, ничего не изменилось. НАСТОЯЩИЙ backend (scripts/real_auth_server.py), временная копия обезличенной
// БД, настоящий вход формой V2, настоящие события мыши/клавиатуры (scripts/cdp.mjs) для финальной проверки экрана.
// Запуск:  node scripts/picker_verify/unpost_guard.mjs   (порт 8241, копия и снимки — в каталоге scratchpad/picker_unpost_guard)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto } from "./lib.mjs";
import { clickBtn, btnState, dialogClick, dialogText, activity, maxActivityId, writeReqs, rawApi, sql, sql1, exec, text } from "./common.mjs";

const PORT = 8241, DIR = `${SP}/picker_unpost_guard`;

// Контракты и позиция — та же проверенная пара, что в docs.mjs (контракт 14 → 13, марка «4П-12», на копии заведомо
// хватает свободных изделий). Количество на КАЖДОМ контракте задаётся ПОВЕРХ уже привязанного факта (а не абсолютным
// числом): в накопленных данных на контрактах уже может быть что-то привязано под эту же (тип, марка), и абсолютная
// цифра создавала бы фиктивное превышение остатка с самого начала, не относящееся к проверяемому сценарию (см. тот же
// приём в scripts/verify_contract_guard_concurrency.py, сценарий S14).
const A = 14, B = 13, TYPE = "Плита перекрытия", MARK = "4П-12";

function setupGuard(dbPath) {
  const factA = Number(sql1(dbPath, `SELECT COUNT(*) FROM elements WHERE contract_id=${A} AND element_type='${TYPE}' AND mark='${MARK}' AND current_status!='planned'`));
  const factB = Number(sql1(dbPath, `SELECT COUNT(*) FROM elements WHERE contract_id=${B} AND element_type='${TYPE}' AND mark='${MARK}' AND current_status!='planned'`));
  exec(dbPath, `UPDATE contract_lines SET quantity=${factA + 2} WHERE contract_id=${A} AND element_type='${TYPE}' AND mark='${MARK}'`);
  exec(dbPath, `UPDATE contract_lines SET quantity=${factB + 2} WHERE contract_id=${B} AND element_type='${TYPE}' AND mark='${MARK}'`);
  const free = sql(dbPath, `SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND element_type='${TYPE}' AND mark='${MARK}' AND contract_id IS NULL AND current_status='planned' ORDER BY id LIMIT 4`).map((r) => r.id);
  if (free.length < 4) throw new Error("в копии не нашлось 4 свободных изделий позиции для сценария");
  const [e0, e1, e2] = free;
  // A: +2 новых привязки поверх факта — полностью занят (0 свободных мест из добавленных qty).
  // B: +1 новая привязка поверх факта, quantity выросло на 2 — остаётся ровно 1 свободное место (его займёт проведение).
  for (const [e, cid] of [[e0, A], [e1, A], [e2, B]]) {
    exec(dbPath, `UPDATE elements SET contract_id=${cid}, current_status='contracting' WHERE id=${e}`);
    exec(dbPath, `INSERT INTO status_history (element_id, status, changed_by, contract_id) VALUES (${e}, 'contracting', 'тест', ${cid})`);
  }
}

const S = await startServer(PORT, DIR, { setup: setupGuard });
const db = S.db, base = S.base;
const TABLES = ["elements", "status_history", "supplier_change_docs", "supplier_change_items", "supplier_change_history_moves", "contract_lines", "contracts"];
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(600); };
const waitText = (t, sel = "#sd-inner", to = 15000) => b.waitFor(`(document.querySelector(${JSON.stringify(sel)})?.innerText||'').includes(${JSON.stringify(t)})`, to);

try {
  await login(b, base, "admin");

  // e0/e1 привязаны к A, e2 — к B (setupGuard) — находим ИМЕННО их по служебной пометке в истории (changed_by='тест'),
  // а не по общему списку привязанных: на A/B под эту (тип, марка) мог быть привязан и НЕ наш, накопленный факт.
  const e0e1 = sql(db, `SELECT DISTINCT e.id FROM elements e JOIN status_history h ON h.element_id=e.id AND h.changed_by='тест' WHERE e.contract_id=${A} AND e.element_type='${TYPE}' AND e.mark='${MARK}' ORDER BY e.id`).map((r) => r.id);
  const e2list = sql(db, `SELECT DISTINCT e.id FROM elements e JOIN status_history h ON h.element_id=e.id AND h.changed_by='тест' WHERE e.contract_id=${B} AND e.element_type='${TYPE}' AND e.mark='${MARK}' ORDER BY e.id`).map((r) => r.id);
  const e0id = e0e1[0], e1id = e0e1[1], e2id = e2list[0];
  const e3id = Number(sql1(db, `SELECT id FROM elements WHERE object_id=1 AND is_current=1 AND element_type='${TYPE}' AND mark='${MARK}' AND contract_id IS NULL AND current_status='planned' ORDER BY id LIMIT 1`));

  console.log(`\n== подготовка: A=${A} (изделия ${e0id},${e1id}), B=${B} (изделие ${e2id}), конкурент=${e3id} ==`);

  // ---------------------------------------------------------------- 1. провести замену поставщика A → B (изделие e0id)
  const created = await rawApi(b, "POST", "/supplier-changes", { object_id: 1, kind: "supplier_change", doc_date: "2026-09-22", from_contract_id: A, to_contract_id: B, element_ids: [e0id] });
  check("U1.1 черновик создан", created.status === 200 && created.json.status === "draft", JSON.stringify(created));
  const docId = created.json.id;
  const posted = await rawApi(b, "POST", `/supplier-changes/${docId}/post`, {});
  check("U1.2 замена поставщика проведена: изделие переехало A → B, в A освободилось 1 место", posted.status === 200 && Number(sql1(db, `SELECT contract_id FROM elements WHERE id=${e0id}`)) === B);
  const factAafterPost = Number(sql1(db, `SELECT COUNT(*) FROM elements WHERE contract_id=${A} AND element_type='${TYPE}' AND mark='${MARK}' AND current_status!='planned'`));
  const qtyA = Number(sql1(db, `SELECT quantity FROM contract_lines WHERE contract_id=${A} AND element_type='${TYPE}' AND mark='${MARK}'`));
  check("U1.3 в A ровно 1 свободное место", qtyA - factAafterPost === 1, `qty=${qtyA} факт=${factAafterPost}`);

  // ---------------------------------------------------------------- 2. другая операция занимает освободившееся место в A (распределение)
  const alloc = await rawApi(b, "POST", `/contracts/${A}/allocations`, { object_id: 1, element_type: TYPE, mark: MARK, items: [{ element_id: e3id, expected_status: "planned" }] });
  check("U2.1 распределение заняло свободное место в A (реальная конкурирующая операция)", alloc.status === 200 && Number(sql1(db, `SELECT contract_id FROM elements WHERE id=${e3id}`)) === A, JSON.stringify(alloc).slice(0, 200));
  check("U2.2 A теперь полностью занят (0 свободных мест)", Number(sql1(db, `SELECT COUNT(*) FROM elements WHERE contract_id=${A} AND element_type='${TYPE}' AND mark='${MARK}' AND current_status!='planned'`)) === qtyA);

  // ---------------------------------------------------------------- 3. попытка отменить проведение первой замены — сценарий пользователя
  console.log("\n== отмена проведения при занятом остатке (ожидается отказ) ==");
  await go("#/supplier-change");
  await waitText("Документы объекта");
  const docNumber = created.json.number;
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${docNumber}')?.click()`);
  await waitText("Пока документ проведён");
  check("U3.1 экран: документ открыт как проведённый, доступна «Отменить проведение»", (await btnState(b, "Отменить проведение")) === "enabled");
  const fpBefore = fingerprint(db, TABLES);
  const a0 = maxActivityId(db);
  const mark0 = b.requests.length;
  await clickBtn(b, "Отменить проведение");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  await dialogClick(b, "Отменить проведение");
  await waitText("Отмена проведения оставила бы изделия без позиции в контракте", "#sd-inner", 15000);
  const errText = await text(b, "#sd-inner");
  check("U3.2 сервер отказал 409, в интерфейсе показан понятный текст отказа (страж остатка, не техническая ошибка)", errText.includes("Отмена проведения оставила бы изделия без позиции в контракте") && /4П-12/.test(errText), errText.slice(0, 400));

  // ---------------------------------------------------------------- 4. документ остаётся проведённым, ничего не изменилось
  await go("#/supplier-change");
  await waitText("Документы объекта");
  const docPosted = await b.eval(`[...document.querySelectorAll('#sd-inner tbody tr')].some(r=>r.innerText.includes(${JSON.stringify(docNumber)})&&r.innerText.includes('Проведён'))`);
  check("U4.1 экран: документ остался в статусе «Проведён» (после отказа и после перезагрузки списка)", docPosted);
  check("U4.2 SQL: документ проведён, изделие-объект замены осталось на B", sql1(db, `SELECT status FROM supplier_change_docs WHERE id=${docId}`) === "posted" && Number(sql1(db, `SELECT contract_id FROM elements WHERE id=${e0id}`)) === B);
  check("U4.3 SQL: побайтно ничего не изменилось (elements/status_history/supplier_change_*/contract_lines/contracts)", diffFp(fpBefore, fingerprint(db, TABLES)).length === 0, diffFp(fpBefore, fingerprint(db, TABLES)).join(","));
  const actAfter = await activity(db, `id>${a0}`);
  check("U4.4 журнал правдив: НЕТ события supplier_change_unpost (отказ — не изменение; допустимо служебное request_denied)", actAfter.filter((x) => x.action === "supplier_change_unpost").length === 0, JSON.stringify(actAfter.map((x) => x.action)));
  check("U4.5 ровно один запрос отмены ушёл на сервер (без автоповтора)", writeReqs(b, mark0, /\/unpost$/).length === 1, JSON.stringify(writeReqs(b, mark0)));

  // ---------------------------------------------------------------- 5. контрольная проверка: ОБЫЧНАЯ (допустимая) отмена по-прежнему работает
  console.log("\n== контроль: обычная отмена проведения (остаток свободен) продолжает работать ==");
  // освобождаем место в A: снимаем конкурента e3id — тогда отмена обязана пройти
  exec(db, `UPDATE elements SET contract_id=NULL, current_status='planned' WHERE id=${e3id}`);
  exec(db, `DELETE FROM status_history WHERE element_id=${e3id} AND comment IS NULL AND status='contracting'`);
  await go("#/supplier-change");
  await waitText("Документы объекта");
  await b.eval(`[...document.querySelectorAll('[data-open]')].find(a=>a.innerText.trim()==='${docNumber}')?.click()`);
  await waitText("Пока документ проведён");
  const a1 = maxActivityId(db);
  const mark1 = b.requests.length;
  await clickBtn(b, "Отменить проведение");
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  await dialogClick(b, "Отменить проведение");
  await waitText("Проведение отменено", "#sd-inner", 15000);
  check("U5.1 обычная отмена проходит: изделие вернулось в A, документ снова черновик", Number(sql1(db, `SELECT contract_id FROM elements WHERE id=${e0id}`)) === A && sql1(db, `SELECT status FROM supplier_change_docs WHERE id=${docId}`) === "draft");
  const act5 = await activity(db, `id>${a1}`);
  check("U5.2 журнал: ровно одно событие supplier_change_unpost", act5.filter((x) => x.action === "supplier_change_unpost").length === 1, JSON.stringify(act5.map((x) => x.action)));
  check("U5.3 ровно один запрос отмены ушёл на сервер", writeReqs(b, mark1, /\/unpost$/).length === 1);

  console.log("\nисключения браузера:", b.exceptions?.length || 0, JSON.stringify(b.exceptions || []).slice(0, 300));
} catch (e) {
  console.error("ОШИБКА СЦЕНАРИЯ:", e && e.stack || e);
  check("сценарий не упал исключением", false, String(e));
} finally {
  const bad = summary();
  await stopServer();
  process.exit(bad ? 1 : 0);
}
