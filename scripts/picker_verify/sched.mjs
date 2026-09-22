// График СМР в V2 на настоящем backend (копия БД, вход формой, реальные события): версии (просмотр, удаление, базовую — только
// администратор), исходные данные расчёта (сохранение целиком, конфликт версии, обрыв ответа, разбор файла обработки в форму — не пишет),
// расчёт (предпросмотр без записи → подтверждение атомарно с отпечатком исходных данных; конфликт устаревших исходных данных; повтор
// безопасен), диаграмма Ганта (дерево, уровни, версия, выгрузка XLSX/PDF), права view / «Комплектовщик», совместимость V1.
// Запуск: node scripts/picker_verify/sched.mjs (порт 8181)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { startServer, stopServer, openBrowser, login, check, summary, sleep, fingerprint, diffFp, SP, hardGoto } from "./lib.mjs";
import { prepareCopy, USER_PICKER, USER_VIEW, text, clickBtn, btnState, activity, maxActivityId, writeReqs, rawApi, dropResponses, restoreFetch, sql, sql1, exec } from "./common.mjs";

const SC_TABLES = ["schedule_versions", "schedule_version_dates", "schedule_work_kinds", "schedule_flow"];

const prep = (db) => {
  prepareCopy(db);
  // базовая версия синтетическая (в исходных данных объекта 1 её нет — только две актуализации) — для проверки «удаляет только администратор»
  exec(db, `INSERT INTO schedule_versions (object_id, kind, title, source_file, origin, note) VALUES (1,'baseline','QA-Базовый',NULL,'import','тест sched.mjs');`);
  const vid = Number(sql1(db, `SELECT id FROM schedule_versions WHERE title='QA-Базовый'`));
  const eid = Number(sql1(db, `SELECT id FROM elements WHERE object_id=1 AND is_current=1 LIMIT 1`));
  exec(db, `INSERT INTO schedule_version_dates (version_id, element_id, smr_start_date, smr_end_date) VALUES (${vid}, ${eid}, '2026-09-01', '2026-09-05');`);
};
const S = await startServer(8181, `${SP}/picker_sched`, { setup: prep });
const db = S.db, base = S.base;
const b = await openBrowser(1920, 1080);
const go = async (hash) => { await hardGoto(b, `${base}/v2${hash}`, 1200); await b.waitFor(`!!document.querySelector('.v2-head')`, 20000); await sleep(500); };
const inner = () => text(b, "#sc-inner");
const waitIn = (t, to = 15000) => b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes(${JSON.stringify(t)})`, to);
const tab = async (name) => { await b.eval(`document.querySelector('[data-sc-tab="${name}"]')?.click()`); await sleep(400); };
const one = (q) => Number(sql1(db, q));
// Индекс строки вида работ (data-kind) по типу и подтипу — таблица сортирована natural_key, не по id; полагаться на «первую строку» нельзя.
const kindIndex = (type, subtype) => b.eval(`(()=>{const rows=document.querySelectorAll('#sc-inner table')[0]?.querySelectorAll('tbody tr')||[];for(const tr of rows){const tds=tr.querySelectorAll('td');if(tds[0]?.textContent.trim().startsWith(${JSON.stringify(type)})&&tds[1]?.textContent.trim()===${JSON.stringify(subtype)}){return Number(tr.querySelector('input[data-field="rate_per_day"]')?.dataset.kind)}}return -1})()`);

// фикстура файла обработки заказчика (лист hide: Элемент/Темп/Порядок монтажа; лист 03_Flow: Кран/Стоянка/Этаж/Порядок)
const FIX = `${SP}/sched_fixture.xlsx`;
execFileSync(process.env.PY || `${new URL("../../.venv/bin/python", import.meta.url).pathname}`, ["-c", `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active; ws.title = "hide"
ws.append(["Элемент", "Темп", "Порядок монтажа"])
ws.append(["Колонна нижняя", 9.5, 1])          # строка уже есть в модели — обновит темп существующей
ws.append(["Панелей лифтовой шахты до отм. +15.000", 3, 99])  # вид работ из закрытого списка, но не заведён на этом объекте — добавится с пометкой
ws2 = wb.create_sheet("03_Flow")
ws2.append(["Кран", "Стоянка", "Этаж", "Порядок"])
ws2.append(["Кран 1", "Стоянка 01", 1, 42])     # реальный фронт — обновит порядок
ws2.append(["Кран 9", "Стоянка 09", 9, 7])      # фронта нет в модели — добавится с пометкой
wb.save(${JSON.stringify(FIX)})
`]);

try {
  await login(b, base, "admin");

  console.log("\n== версии: просмотр ==");
  await go("#/schedule");
  check("SC-V1 форма открывается на «Визуализация»", await b.eval(`document.querySelector('[data-sc-tab="gantt"]')?.getAttribute('aria-selected')`) === "true");
  await tab("versions");
  await waitIn("Актуализация");
  const nVer = one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1");
  const rowsShown = await b.eval(`document.querySelectorAll('#sc-inner tbody tr').length`);
  check("SC-V2 список версий: строк столько же, сколько в БД", rowsShown === nVer, `${rowsShown} vs ${nVer}`);

  console.log("\n== версии: удаление базовой — только администратор ==");
  const baseId = one(`SELECT id FROM schedule_versions WHERE title='QA-Базовый'`);
  // право есть (admin), но UI просит подтверждение
  await b.eval(`document.querySelector('[data-del-v="${baseId}"]')?.scrollIntoView()`);
  const mark0 = b.requests.length;
  await b.eval(`document.querySelector('[data-del-v="${baseId}"]')?.click()`);
  await b.waitFor(`!!document.querySelector('.v2-dialog')`);
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.trim()==='Удалить').click()`);
  await sleep(700);
  check("SC-V3 администратор удаляет базовую версию: SQL", one(`SELECT COUNT(*) FROM schedule_versions WHERE id=${baseId}`) === 0);
  check("SC-V4 журнал schedule_version_delete", (await activity(db, `action='schedule_version_delete'`)).length === 1);

  console.log("\n== версии: права view/«Комплектовщик» ==");
  let r = await rawApi(b, "GET", `/schedule-versions?object_id=1`);
  check("SC-V5 admin: GET версий 200", r.status === 200);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_VIEW);
  r = await rawApi(b, "GET", `/schedule-versions?object_id=1`);
  check("SC-V6 view: чтение версий доступно (READ ниже CONTRACT)", r.status === 200);
  const otherVerId = one(`SELECT id FROM schedule_versions WHERE object_id=1 LIMIT 1`);
  r = await rawApi(b, "DELETE", `/schedule-versions/${otherVerId}`);
  check("SC-V7 view: удаление версии — 403, ничего не изменено", r.status === 403 && one(`SELECT COUNT(*) FROM schedule_versions WHERE id=${otherVerId}`) === 1);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, "admin");

  console.log("\n== исходные данные: просмотр ==");
  await go("#/schedule"); await tab("inputs");
  await waitIn("Виды работ");
  const nKinds = one("SELECT COUNT(*) FROM schedule_work_kinds WHERE object_id=1");
  const kindsShown = await b.eval(`document.querySelectorAll('input[data-kind][data-field="rate_per_day"]').length`);
  check("SC-I1 виды работ: строк столько же, сколько в БД", kindsShown === nKinds);

  console.log("\n== исходные данные: правка и сохранение ==");
  const VER_TABLES = ["schedule_versions", "schedule_version_dates"];
  const fpBefore = fingerprint(db, VER_TABLES);
  const idxNizh = await kindIndex("Колонна", "нижняя");
  await b.eval(`(()=>{const i=document.querySelector('input[data-kind="${idxNizh}"][data-field="rate_per_day"]');i.value='12.5';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const a0 = maxActivityId(db);
  let mark = b.requests.length;
  await clickBtn(b, "Сохранить исходные данные");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Сохранено')`, 10000);
  const w1 = writeReqs(b, mark);
  check("SC-I2 сохранение: один PUT /schedule-calc/inputs с expected_version", w1.length === 1 && w1[0].path === "/schedule-calc/inputs" && /"expected_version":"[0-9a-f]{16}"/.test(w1[0].body));
  check("SC-I3 SQL: темп «Колонна/нижняя» обновлён", Math.abs(Number(sql1(db, `SELECT rate_per_day FROM schedule_work_kinds WHERE object_id=1 AND element_type='Колонна' AND subtype='нижняя'`)) - 12.5) < 1e-9);
  check("SC-I4 журнал schedule_inputs_save", (await activity(db, `id>${a0} AND action='schedule_inputs_save'`)).length === 1);
  // schedule_flow ПЕРЕЗАПИСЫВАЕТСЯ целиком при КАЖДОМ сохранении исходных данных (DELETE+INSERT, новые id) — это поведение формы («целиком, а не
  // построчно»), не побочный эффект; «нет побочных изменений» проверяется по НЕсвязанным таблицам — версиям графика.
  check("SC-I5 версии графика не затронуты сохранением исходных данных", diffFp(fpBefore, fingerprint(db, VER_TABLES)).length === 0, JSON.stringify(diffFp(fpBefore, fingerprint(db, VER_TABLES))));

  console.log("\n== исходные данные: конфликт версии ==");
  await go("#/schedule"); await tab("inputs"); await waitIn("Виды работ");
  // «другой пользователь» правит темп прямо в БД, пока форма уже открыта
  exec(db, `UPDATE schedule_work_kinds SET rate_per_day=99 WHERE object_id=1 AND element_type='Колонна' AND subtype='нижняя'`);
  const idxVerh = await kindIndex("Колонна", "верхняя");
  await b.eval(`(()=>{const i=document.querySelector('input[data-kind="${idxVerh}"][data-field="rate_per_day"]');i.value='3.3';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const before99 = one(`SELECT COUNT(*) FROM schedule_work_kinds WHERE object_id=1 AND rate_per_day=99`);
  await clickBtn(b, "Сохранить исходные данные");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('изменил другой пользователь')`, 10000);
  check("SC-I6 конфликт версии: сообщение показано, значение «чужой» правки НЕ затёрто", before99 === 1 && one(`SELECT COUNT(*) FROM schedule_work_kinds WHERE object_id=1 AND rate_per_day=99`) === 1);
  await waitIn("Виды работ");   // форма перечитывает данные сама

  console.log("\n== исходные данные: обрыв ответа (неизвестный исход) ==");
  await go("#/schedule"); await tab("inputs"); await waitIn("Виды работ");
  await dropResponses(b, "/schedule-calc/inputs$");
  const idxNizh2 = await kindIndex("Колонна", "нижняя");
  await b.eval(`(()=>{const i=document.querySelector('input[data-kind="${idxNizh2}"][data-field="order_no"]');i.value='77';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickBtn(b, "Сохранить исходные данные");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('исход неизвестен')`, 10000);
  await sleep(400);
  check("SC-I7 обрыв ответа: «исход неизвестен», запрос реально выполнился на сервере (SQL применил правку)", one(`SELECT order_no FROM schedule_work_kinds WHERE object_id=1 AND element_type='Колонна' AND subtype='нижняя'`) === 77);
  await restoreFetch(b);

  console.log("\n== исходные данные: разбор файла обработки (не пишет) ==");
  await go("#/schedule"); await tab("inputs"); await waitIn("Виды работ");
  const fpParse = fingerprint(db, SC_TABLES);
  const doc = await b.send("DOM.getDocument", {});
  const inp = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#sc-parse-file" });
  await b.send("DOM.setFileInputFiles", { nodeId: inp.nodeId, files: [FIX] });
  await clickBtn(b, "Прочитать файл");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Прочитано')`, 10000);
  check("SC-I8 разбор файла: сводка о листах и обновлённых/добавленных строках", (await inner()).includes("«hide»") && (await inner()).includes("«03_Flow»"));
  check("SC-I9 разбор файла НИЧЕГО не пишет в базу (SQL до/после)", diffFp(fpParse, fingerprint(db, SC_TABLES)).length === 0);
  const idxNizh3 = await kindIndex("Колонна", "нижняя");
  const rateShown = await b.eval(`Number(document.querySelector('input[data-kind="${idxNizh3}"][data-field="rate_per_day"]')?.value)`);
  check("SC-I10 значение из файла ПОДСТАВЛЕНО в форму (не сохранено)", Math.abs(rateShown - 9.5) < 1e-9, `idx=${idxNizh3} value=${rateShown}`);
  const addedRow = await b.eval(`(()=>{const els=[...document.querySelectorAll('#sc-inner td')];return els.some(e=>e.textContent.includes('нет в модели'))})()`);
  check("SC-I11 строка из файла без модели помечена «нет в модели»", addedRow);
  await clickBtn(b, "Сохранить исходные данные");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Сохранено')`, 10000);
  const i12rate = Number(sql1(db, `SELECT rate_per_day FROM schedule_work_kinds WHERE object_id=1 AND element_type='Колонна' AND subtype='нижняя'`));
  const i12new = one(`SELECT COUNT(*) FROM schedule_work_kinds WHERE object_id=1 AND element_type='Панель' AND subtype='ЛифтоваяШахта'`);
  const i12flow = one(`SELECT COUNT(*) FROM schedule_flow WHERE object_id=1 AND crane_name='Кран 9' AND stance_name='Стоянка 09'`);
  check("SC-I12 после «Сохранить»: подставленные из файла значения записаны", Math.abs(i12rate - 9.5) < 1e-9 && i12new === 1 && i12flow === 1,
    `rate=${i12rate} newKind=${i12new} newFlow=${i12flow} status=${JSON.stringify(await inner())}`.slice(0, 400));

  console.log("\n== расчёт: предпросмотр без записи ==");
  await go("#/schedule"); await tab("calc"); await waitIn("Считает даты");
  await b.eval(`(()=>{const i=document.querySelector('#sc-calc-date');i.value='2026-10-01';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const fpCalc = fingerprint(db, SC_TABLES);
  mark = b.requests.length;
  await clickBtn(b, "Рассчитать");
  try {
    await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Предпросмотр')`, 15000);
  } catch (e) {
    console.log("ДИАГНОСТИКА расчёта:", JSON.stringify(await inner()).slice(0, 800));
    console.log("запросы:", JSON.stringify(writeReqs(b, mark)).slice(0, 800));
    throw e;
  }
  const wPrev = writeReqs(b, mark);
  check("SC-C1 предпросмотр: один POST /schedule-calc с save:false", wPrev.length === 1 && wPrev[0].path === "/schedule-calc" && /"save":false/.test(wPrev[0].body));
  check("SC-C2 предпросмотр НИЧЕГО не пишет (SQL до/после)", diffFp(fpCalc, fingerprint(db, SC_TABLES)).length === 0);
  check("SC-C3 сводка показывает фронты и изделия", /Фронтов: \d+/.test(await inner()) && /Изделий: \d+/.test(await inner()));

  console.log("\n== расчёт: подтверждение атомарно, с отпечатком исходных данных ==");
  const a1 = maxActivityId(db);
  mark = b.requests.length;
  await clickBtn(b, "Подтвердить и сохранить версию");
  await b.waitFor(`!!document.querySelector('#sc-inner').innerText.includes('Название')`, 15000);   // вернулись на вкладку «Версии»
  const wConf = writeReqs(b, mark);
  check("SC-C4 подтверждение: один POST /schedule-calc с save:true и expected_inputs_version", wConf.length === 1 && /"save":true/.test(wConf[0].body) && /"expected_inputs_version":"[0-9a-f]{16}"/.test(wConf[0].body));
  check("SC-C5 SQL: новая версия «current», origin=calc, дата начала 2026-10-01", one(`SELECT COUNT(*) FROM schedule_versions WHERE object_id=1 AND kind='current' AND origin='calc' AND date(loaded_at)=date('now')`) >= 1
    && sql1(db, `SELECT MIN(smr_start_date) FROM schedule_version_dates WHERE version_id=(SELECT id FROM schedule_versions ORDER BY id DESC LIMIT 1)`) === "2026-10-01");
  check("SC-C6 журнал schedule_calc", (await activity(db, `id>${a1} AND action='schedule_calc'`)).length === 1);

  console.log("\n== расчёт: конфликт устаревших исходных данных (никто не пишет, предпросмотр пересчитан) ==");
  await go("#/schedule"); await tab("calc"); await waitIn("Считает даты");
  await b.eval(`(()=>{const i=document.querySelector('#sc-calc-date');i.value='2026-11-01';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickBtn(b, "Рассчитать");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Предпросмотр')`, 15000);
  // «другой пользователь» меняет исходные данные ПОСЛЕ предпросмотра
  exec(db, `UPDATE schedule_work_kinds SET rate_per_day=1.1 WHERE object_id=1 AND id=(SELECT id FROM schedule_work_kinds WHERE object_id=1 ORDER BY id LIMIT 1)`);
  const nBefore = one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1");
  mark = b.requests.length;
  await clickBtn(b, "Подтвердить и сохранить версию");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Пересчитываю по текущим')`, 15000);
  await sleep(600);
  check("SC-C7 конфликт: версия НЕ создана (сервер отказал под блокировкой до записи)", one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1") === nBefore);
  const wConf2 = writeReqs(b, mark).filter((x) => x.path === "/schedule-calc");
  check("SC-C8 конфликт: неудавшееся подтверждение (save:true) и следом — новый предпросмотр (save:false), запись НЕ повторяется молча (save:true ровно один раз)",
    wConf2.filter((x) => /"save":true/.test(x.body)).length === 1 && wConf2.some((x) => /"save":false/.test(x.body)), JSON.stringify(wConf2));

  console.log("\n== расчёт: повтор безопасен (двойное подтверждение — не две версии) ==");
  await go("#/schedule"); await tab("calc"); await waitIn("Считает даты");
  await b.eval(`(()=>{const i=document.querySelector('#sc-calc-date');i.value='2026-12-01';i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await clickBtn(b, "Рассчитать");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('Предпросмотр')`, 15000);
  const before2 = one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1");
  // двойной щелчок по подтверждению — кнопка блокируется ДО первого await (S.calc.busy=true, disabled)
  const rc = await b.eval(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Подтвердить и сохранить версию');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.click(rc.x, rc.y, { count: 2 });
  await sleep(1500);
  check("SC-C9 двойной щелчок «Подтвердить»: версий стало РОВНО на одну больше", one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1") === before2 + 1);

  console.log("\n== расчёт: права view/«Комплектовщик» ==");
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_VIEW);
  r = await rawApi(b, "POST", "/schedule-calc", { object_id: 1, start_date: "2026-09-01", skip_installed: true, save: false });
  check("SC-C10 view: расчёт (даже предпросмотр) — 403", r.status === 403);
  r = await rawApi(b, "PUT", "/schedule-calc/inputs", { object_id: 1, work_kinds: [], flow: [] });
  check("SC-C11 view: сохранение исходных данных — 403, ничего не изменено", r.status === 403 && one("SELECT COUNT(*) FROM schedule_work_kinds WHERE object_id=1") > 0);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, USER_PICKER);
  r = await rawApi(b, "POST", "/schedule-calc", { object_id: 1, start_date: "2026-09-01", skip_installed: true, save: false });
  check("SC-C12 «Комплектовщик»: предпросмотр доступен (200)", r.status === 200);
  await b.eval(`fetch('/logout',{method:'POST',credentials:'same-origin'})`);
  await login(b, base, "admin");

  console.log("\n== диаграмма Ганта ==");
  await go("#/schedule"); await tab("gantt");
  await b.waitFor(`(document.querySelector('#sc-inner')?.innerText||'').includes('На диаграмме')`, 15000);
  check("SC-G1 диаграмма построена, строки есть", (await b.eval(`document.querySelectorAll('.v2-gantt-row').length`)) > 0);
  const rowsFull = await b.eval(`document.querySelectorAll('.v2-gantt-row').length`);
  await b.eval(`document.querySelector('[data-gantt-level="1"]')?.click()`);
  await sleep(300);
  const rowsCranes = await b.eval(`document.querySelectorAll('.v2-gantt-row').length`);
  check("SC-G2 уровень «Краны»: строк меньше, чем при полном раскрытии", rowsCranes > 0 && rowsCranes < rowsFull);
  await b.eval(`document.querySelector('[data-gantt-level="4"]')?.click()`);
  await sleep(300);
  check("SC-G3 уровень «Тип + подтип»: снова полное дерево", (await b.eval(`document.querySelectorAll('.v2-gantt-row').length`)) === rowsFull);

  console.log("\n== выгрузка XLSX/PDF: открытием файла ==");
  // Cookie сессии HttpOnly — curl её не видит; файл забирается НАСТОЯЩИМ fetch() СТРАНИЦЫ (та же сессия), содержимое возвращается base64.
  for (const [kind, magic] of [["xlsx", "PK"], ["pdf", "%PDF"]]) {
    const out = `${SP}/sched_gantt.${kind}`;
    const b64 = await b.eval(`fetch('/schedule-versions/gantt.${kind}?object_id=1',{credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const buf=await r.arrayBuffer();let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s)})`);
    writeFileSync(out, Buffer.from(b64, "base64"));
    const head = readFileSync(out).subarray(0, 8).toString("latin1");
    check(`SC-G${kind === "xlsx" ? 4 : 5}a выгрузка .${kind}: файл начинается корректной сигнатурой`, head.startsWith(magic), head);
  }
  // Открытие содержимого: xlsx читается openpyxl (строки узла из дерева), pdf — сигнатура %%EOF в конце (не обрезан).
  const xlsxCheck = execFileSync(process.env.PY || `${new URL("../../.venv/bin/python", import.meta.url).pathname}`, ["-c", `
import openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(`${SP}/sched_gantt.xlsx`)})
ws = wb.active
print(ws.max_row, ws.cell(1,1).value)
`]).toString("utf-8").trim();
  check("SC-G4b .xlsx открывается openpyxl, есть строки дерева", /^\d+/.test(xlsxCheck) && Number(xlsxCheck.split(" ")[0]) > 5, xlsxCheck);
  const pdfTail = readFileSync(`${SP}/sched_gantt.pdf`).subarray(-16).toString("latin1");
  check("SC-G5b .pdf не обрезан (есть %%EOF в конце)", pdfTail.includes("%%EOF"), pdfTail);

  console.log("\n== совместимость V1: те же эндпоинты без новых полей продолжают работать как раньше ==");
  // PUT /schedule-calc/inputs БЕЗ expected_version (как шлёт V1) — сохраняет, не требуя отпечатка
  r = await rawApi(b, "PUT", "/schedule-calc/inputs", {
    object_id: 1,
    work_kinds: sql(db, "SELECT element_type, subtype, rate_per_day, order_no FROM schedule_work_kinds WHERE object_id=1"),
    flow: sql(db, "SELECT crane_name, stance_name, floor, order_no FROM schedule_flow WHERE object_id=1"),
  });
  check("SC-V1C V1-совместимость: PUT /schedule-calc/inputs без expected_version — 200 (как раньше)", r.status === 200);
  // POST /schedule-calc БЕЗ save (V1 не шлёт это поле) — по умолчанию true, как раньше
  const nBefore3 = one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1");
  r = await rawApi(b, "POST", "/schedule-calc", { object_id: 1, start_date: "2027-01-01", skip_installed: true });
  check("SC-V2C V1-совместимость: POST /schedule-calc без save/expected_inputs_version — считает и сохраняет как раньше", r.status === 200 && one("SELECT COUNT(*) FROM schedule_versions WHERE object_id=1") === nBefore3 + 1);

} finally {
  await b.close();
  await stopServer();
}

process.exit(summary());
