// «События, задачи, вопросы»: поведение V1 — при открытии выбрана самая свежая редакция, в списке «пунктов: N · автор», новая —
// на сегодняшнюю дату; дата из отчёта (ключ sessionStorage v2.reportNotes.date) открывает новую редакцию на эту дату; создание,
// правка, удаление с подтверждением; сторож несохранённого; 403 у user2/user4. Настоящий backend, вход формой, настоящий ввод.
//   node scripts/audit_set/check_report_notes.mjs <копия БД> <порт>
import { session, sql, sqlExec, ok, summary, go, click, fill, DB, BASE, setObject, as, onBail, overflowX } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
const revs = sql(DB, "select effective_date d, key_events e, key_tasks t, open_questions q from report_notes where object_id=1 order by effective_date desc");
const FREE = "2026-09-17";
onBail(async () => sqlExec(DB, `delete from report_notes where object_id=1 and effective_date in ('${FREE}')`));
const today = (() => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

const b = await session(BASE, "admin");
await setObject(b, 1);
await go(b, "report-notes");
await b.waitFor("!!document.querySelector('[data-rev]')", 20000);
ok("при открытии выбрана самая свежая редакция (как в V1)", await b.eval(`document.querySelector('[data-rev="${revs[0].d}"]').getAttribute('aria-pressed')==='true' && document.querySelector('#rn-date').value==='${revs[0].d}'`));
const n0 = JSON.parse(revs[0].e).length + JSON.parse(revs[0].t).length + JSON.parse(revs[0].q).length;
ok(`в списке число пунктов редакции (пунктов: ${n0})`, await b.eval(`document.querySelector('[data-rev="${revs[0].d}"]').closest('li').innerText.includes('пунктов: ${n0}')`));
ok("дата существующей редакции не меняется (поле закрыто, объяснение есть)", await b.eval(`document.querySelector('#rn-date').disabled && /заведите новую и удалите эту/.test(document.body.innerText)`));
await click(b, "#rn-new"); await b.sleep(300);
ok("новая редакция — на сегодняшнюю дату (как в V1)", (await b.eval("document.querySelector('#rn-date').value")) === today);
// нетронутая новая форма не «изменена»: уход без вопроса
await go(b, "home");
ok("нетронутая новая форма не держит уход (нет вопроса о несохранённом)", await b.eval("location.hash==='#/' && !document.querySelector('.v2-dialog-backdrop')"));
// дата из отчёта
await b.eval(`sessionStorage.setItem('v2.reportNotes.date','${FREE}')`);
await go(b, "report-notes");
await b.waitFor("!!document.querySelector('#rn-date')", 20000); await b.sleep(400);
ok("дата из отчёта: открыта новая редакция на эту дату", await b.eval(`document.querySelector('#rn-date').value==='${FREE}' && !document.querySelector('#rn-date').disabled && !document.querySelector('[aria-pressed="true"][data-rev]')`));
ok("ключ передачи даты одноразовый", (await b.eval("sessionStorage.getItem('v2.reportNotes.date')")) === null);
// создание: настоящий ввод текста
await fill(b, 'textarea[data-nf="events"]', "QA-событие 1");
await fill(b, 'textarea[data-nf="tasks"]', "QA-задача 1");
await click(b, "#rn-save");
await b.waitFor(`/подтверждено чтением/.test(document.body.innerText)`, 20000);
const saved = sql(DB, `select key_events e, key_tasks t from report_notes where object_id=1 and effective_date='${FREE}'`)[0];
ok("SQL: редакция на дату отчёта создана", saved && JSON.parse(saved.e)[0] === "QA-событие 1" && JSON.parse(saved.t)[0] === "QA-задача 1");
ok("журнал: report_notes", q1(`select count(*) n from activity_log where action='report_notes' and at > datetime('now','-2 minutes')`).n >= 1);
// сторож несохранённого
await fill(b, 'textarea[data-nf="questions"]', "QA-вопрос");
await b.eval("location.hash='#/'"); await b.sleep(600);
ok("изменённая форма: вопрос о несохранённом при уходе", await b.eval("!!document.querySelector('.v2-dialog-backdrop')"));
await click(b, '.v2-dialog [data-choice="cancel"]'); await b.sleep(300);
ok("«Остаться» — экран и ввод на месте", await b.eval(`location.hash==='#/report-notes' && document.querySelector('textarea[data-nf="questions"]').value==='QA-вопрос'`));
// удаление с подтверждением (сначала отменить правку — вернуть текст)
await fill(b, 'textarea[data-nf="questions"]', "");
await click(b, "#rn-delete");
await b.waitFor("!!document.querySelector('.v2-dialog [data-choice=\"confirm\"]')", 10000);
await click(b, '.v2-dialog [data-choice="confirm"]');
await b.waitFor(`/удалена/.test(document.body.innerText)`, 20000);
ok("SQL: редакция удалена, прочие на месте", q1(`select count(*) n from report_notes where object_id=1`).n === revs.length && !q1(`select count(*) n from report_notes where object_id=1 and effective_date='${FREE}'`).n);
for (const [w, h] of [[1920, 1080], [1366, 768]]) { await b.viewport(w, h); await b.sleep(200); ok(`${w}: без горизонтальной прокрутки`, (await overflowX(b)) <= 1); }
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
// роли: запись — у администратора объекта (report_notes write); user2 (роль user) и user4 (view) — чтение, 403 на запись
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  ok(`${who}: чтение редакций 200`, (await c.get("/settings/report-notes?object_id=1")).status === 200);
  ok(`${who}: PUT → 403`, (await c.put("/settings/report-notes?object_id=1", { effective_date: FREE, key_events: ["x"], key_tasks: [], open_questions: [] })).status === 403);
  ok(`${who}: DELETE → 403`, (await c.del(`/settings/report-notes/${revs[0].d}?object_id=1`)).status === 403);
}
ok("после отказов редакции не изменились (SQL)", q1(`select count(*) n from report_notes where object_id=1`).n === revs.length);
process.exit(summary());
