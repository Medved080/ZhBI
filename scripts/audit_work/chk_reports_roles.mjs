// Аудит «рабочие места и отчёты»: «Показать на схеме» из «Моей работы» (настоящий щелчок → рабочее место «Модель» выделяет
// изделие и наводит кадр; изделие другого объекта — со сменой объекта), ограниченные роли (user4 — «просмотр», user2 — «user»)
// и раскладка 1366×768. Настоящий backend на копии БД, настоящий вход формой V2. Запуск: node scripts/audit_work/chk_reports_roles.mjs (порт 8372)
import { startServer, stopServer, check, summary, sleep, SP, session, setObject, openScreen, tap, choose, exec, sql1, writes } from "./lib.mjs";

const PORT = 8372;
const S = await startServer(PORT, `${SP}/aw_roles`, {
  setup(db) {
    // user4 («просмотр») — ещё и на проекте 2 (объекты МФР), чтобы проверить отчёты учёта по блокам под ограниченной ролью
    exec(db, `INSERT INTO user_access (user_id, project_id, object_id, role) SELECT id, 2, NULL, 'view' FROM users WHERE domain_login='user4'`);
  },
});
const frameDoc = `document.querySelector('iframe.ws-frame')?.contentDocument`;
// выбор сцены виден оболочке V2 так же, как человеку: карточка изделия (GET /elements/{id}) и марка в панели
const cardOf = (b, id, from) => b.requests.slice(from).some((r) => new URL(r.url).pathname === `/elements/${id}` && r.status === 200);
let b;
try {
  // ---------------- A. admin: «Показать на схеме» из «Моей работы»
  b = await session(S.base, "admin", { objectId: 1 });
  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  const setDate = async (param, v) => { await b.eval(`(()=>{const i=document.querySelector('input[data-param=${param}]'); i.value='${v}'; i.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(900); };
  await setDate("date_from", "2026-08-11"); await setDate("date_to", "2026-08-11");
  await b.waitFor(`document.querySelector('[data-user-select]')`, 10000);
  await choose(b, "[data-user-select]", "__all__");
  await b.waitFor(`document.querySelector('#mw-table .rw-locate')`, 15000);
  const target = await b.eval(`(()=>{const x=document.querySelector('#mw-table .rw-locate'); return { id: Number(x.dataset.el), obj: Number(x.dataset.obj), text: x.textContent }; })()`);
  const mark = sql1(S.db, `SELECT mark FROM elements WHERE id=${target.id}`);
  const n0 = b.requests.length;
  await tap(b, "#mw-table .rw-locate");
  await b.waitFor(`location.hash==='#/ws-model'`, 15000);
  for (let i = 0; i < 600 && !cardOf(b, target.id, n0); i++) await sleep(150);
  await b.waitFor(`document.querySelector('.ws-mark')`, 30000);
  await sleep(1500);
  const loc = await b.eval(`(()=>{const d=${frameDoc}; return { located: d ? d.querySelectorAll('.located').length : -1, mark: document.querySelector('.ws-mark')?.textContent || null }; })()`);
  check("моя работа → «Модель»: выделено то же изделие (карточка V2 запросила GET /elements/{id} строки)", cardOf(b, target.id, n0), JSON.stringify(target));
  check("моя работа → «Модель»: изделие обведено как «найденное» (как V1 markLocated) и карточка V2 показывает марку", loc.located === 1 && loc.mark === mark, JSON.stringify(loc) + " SQL " + mark);
  // POST /plan-data — чтение схемы кадром (данные большие, поэтому POST), не запись
  check("переход к изделию ничего не записывает", writes(b, n0).filter((r) => !/last-object|\/plan-data$/.test(r.url)).length === 0, JSON.stringify(writes(b, n0).map((r) => r.url)));
  await b.eval(`history.back()`);
  await b.waitFor(`location.hash==='#/report-mywork' && document.querySelector('#rd-report')`, 20000);
  check("назад из рабочего места — снова «Моя работа»", true);

  // изделие ДРУГОГО объекта: отчёт открыт на объекте 2, строка про изделие объекта 1 → смена объекта и переход
  await setObject(b, 2);
  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  await setDate("date_from", "2026-08-11"); await setDate("date_to", "2026-08-11");
  await b.waitFor(`document.querySelector('[data-user-select]')`, 10000);
  await choose(b, "[data-user-select]", "__all__");
  await b.waitFor(`document.querySelector('#mw-table .rw-locate[data-obj="1"]')`, 15000);
  const other = await b.eval(`(()=>{const x=document.querySelector('#mw-table .rw-locate[data-obj="1"]'); return { id: Number(x.dataset.el), note: x.closest('td').innerText }; })()`);
  check("строка про изделие другого объекта помечена названием объекта", /Объект-1/.test(other.note), other.note);
  const n1 = b.requests.length;
  await tap(b, '#mw-table .rw-locate[data-obj="1"]');
  await b.waitFor(`location.hash==='#/ws-model'`, 15000);
  for (let i = 0; i < 600 && !cardOf(b, other.id, n1); i++) await sleep(150);
  check("изделие другого объекта: объект в шапке сменён на 1 и изделие выделено", (await b.eval(`document.querySelector('#v2-object').value`)) === "1" && cardOf(b, other.id, n1), String(await b.eval(`document.querySelector('#v2-object').value`)));
  check("исключений JavaScript нет (admin)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close(); b = null;

  // ---------------- B. user4 («просмотр»), объект 1, 1366×768
  b = await session(S.base, "user4", { objectId: 1, width: 1366, height: 768 });
  for (const [id, wait] of [["report-analytics", ".rw-an-table"], ["report-dynamics", ".rw-dyn-tbl"], ["report-mywork", "#rd-report p[role=status]"], ["report-status", ".lvl-total"]]) {
    await openScreen(b, id, `document.querySelector('${wait}')`, 60000);
    await sleep(500);
    const lay = await b.eval(`({ w: document.documentElement.scrollWidth, iw: innerWidth })`);
    check(`user4 1366×768: «${id}» открывается, без горизонтальной прокрутки страницы`, lay.w <= lay.iw + 1, JSON.stringify(lay));
  }
  await openScreen(b, "report-dynamics", `document.querySelector('.rw-dyn-tbl')`);
  check("user4: в «Динамике» нет «✎ Изменить» (право «События, задачи, вопросы» — только чтение)", (await b.eval(`document.querySelectorAll('[data-dyn-edit]').length`)) === 0);
  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  await sleep(1200);
  check("user4: в «Моей работе» нет выбора пользователя (нет права «Чужие действия»)", (await b.eval(`!document.querySelector('[data-user-select]')`)));
  // user4 на МФР-объекте (доступ выдан в копии): матрица только для чтения, запись — 403 от сервера
  await setObject(b, 4);
  await openScreen(b, "report-block-status", `document.querySelector('.v2-matrix') || document.querySelector('.v2-callout-bad') || document.querySelector('.v2-page p.v2-muted')`, 60000);
  await sleep(800);
  const hashBs = await b.eval(`location.hash`);
  if (hashBs === "#/report-block-status") {
    const ro = await b.eval(`({ inputs: document.querySelectorAll('.v2-matrix-input').length, cycles: document.querySelectorAll('.v2-matrix-cycle').length, note: /только просмотр/.test(document.querySelector('#rd-report').innerText) })`);
    check("user4 (МФР): «Учёт по блокам: статусы» — без полей и кнопок правки, «только просмотр»", ro.inputs === 0 && ro.cycles === 0 && ro.note, JSON.stringify(ro));
    await choose(b, "#bs-mode", "deviation");
    check("user4: переключатель «Показывать» работает и без права записи", (await b.eval(`document.querySelector('#bs-mode').value`)) === "deviation");
  } else check("user4 (МФР): экран «Учёт по блокам: статусы» доступен роли «просмотр»", false, hashBs);
  const st403 = await b.eval(`fetch('/objects/4/blocks/1548/work-progress-cell',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({work_type_id:1,percent:5,report_date:'2026-09-22'})}).then(r=>r.status)`);
  check("user4: запись ячейки отклонена сервером (403)", st403 === 403, String(st403));
  await openScreen(b, "report-block-schedule", `document.querySelector('#bsch-table')`, 60000);
  const layS = await b.eval(`({ w: document.documentElement.scrollWidth, iw: innerWidth })`);
  check("user4 (МФР) 1366×768: «График работ по блокам» открывается без горизонтальной прокрутки страницы", layS.w <= layS.iw + 1, JSON.stringify(layS));
  // «Линейный трек» по матрице прав выдан только администратору сервиса: пункт виден (как в V1), сервер отказывает, текст отказа показан
  await openScreen(b, "report-linear-track", `document.querySelector('#rd-report table') || document.querySelector('.v2-callout-bad')`, 60000);
  const lin = await b.eval(`document.querySelector('.v2-callout-bad')?.innerText || ''`);
  check("user4: «Линейный трек» — отказ сервера показан текстом (как строка состояния V1)", /требует роли/.test(lin), lin.slice(0, 160));
  check("user4: изменяющих запросов за сценарий нет (кроме пробной записи 403)", writes(b).filter((r) => !/\/login$|last-object|work-progress-cell|\/plan-data$/.test(r.url)).length === 0, JSON.stringify(writes(b).map((r) => r.url)));
  check("исключений JavaScript нет (user4)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
  await b.close(); b = null;

  // ---------------- C. user2 («user», объект 1): «Моя работа» — только свои действия, без выбора пользователя
  b = await session(S.base, "user2", { objectId: 1, width: 1920, height: 1080 });
  await openScreen(b, "report-mywork", `document.querySelector('#rd-report p[role=status]')`);
  await sleep(1200);
  const u2 = await b.eval(`({ sel: !!document.querySelector('[data-user-select]'), status: document.querySelector('#rd-report p[role=status]').innerText })`);
  check("user2: «Моя работа» без выбора пользователя, подпись — свои действия", !u2.sel && /Фамилия2/.test(u2.status), JSON.stringify(u2));
  check("исключений JavaScript нет (user2)", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary("«Показать на схеме», роли, 1366") ? 1 : 0);
