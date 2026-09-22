// «Заполнить пустые Объект и Проект» (временная): предпросмотр не пишет; серверная валидация (нет целей, объект чужого проекта);
// подтверждение словом; обрыв связи — «неизвестно», без автоповтора, ничего не записано; успех — SQL и журнал, повторное чтение;
// двойной щелчок — один запрос; 403 у user2/user4. Подготовка на КОПИИ: у двух договоров объекта 1 object_id временно NULL
// (после проверки возвращается как было).
//   node scripts/audit_set/check_fill_scope.mjs <копия БД> <порт>
import { session, sql, sqlExec, ok, summary, go, click, fill, DB, BASE, setObject, as, onBail } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
const ags = sql(DB, "select id, object_id from agreements where object_id=1 order by id limit 2");
const ids = ags.map((a) => a.id).join(",");
const restore = () => sqlExec(DB, `update agreements set object_id=1 where id in (${ids})`);
onBail(async () => restore());
sqlExec(DB, `update agreements set object_id=NULL where id in (${ids})`);
const j0 = q1("select count(*) n from activity_log where action='fill_empty_scope'").n;
const a = await as("admin");

// серверная валидация (ничего не пишет)
ok("400: не выбрано ни одного справочника", (await a.post("/admin/fill-empty-scope/apply", { project_id: 1, object_id: 1, keys: [] })).status === 400);
const otherProj = q1("select id from projects where id<>1 limit 1").id;
ok("400: объект другого проекта", (await a.post("/admin/fill-empty-scope/apply", { project_id: otherProj, object_id: 1, keys: ["agreements"] })).status === 400);
for (const who of ["user2", "user4"]) ok(`${who}: apply → 403`, (await (await as(who)).post("/admin/fill-empty-scope/apply", { project_id: 1, object_id: 1, keys: ["agreements"] })).status === 403);
ok("после отказов договоры по-прежнему пустые (SQL)", q1(`select count(*) n from agreements where id in (${ids}) and object_id is null`).n === 2);

const b = await session(BASE, "admin");
await setObject(b, 1);
await go(b, "fill-scope");
await b.waitFor("!!document.querySelector('[data-fill-key=\"agreements\"]')", 20000);
ok("предпросмотр: договоров без объекта — 2", /2/.test(await b.eval(`document.querySelector('[data-fill-key="agreements"]').closest('label,div,li,tr').innerText`)));
ok("предпросмотр ничего не пишет", q1(`select count(*) n from agreements where id in (${ids}) and object_id is null`).n === 2);
// только договоры
for (const k of await b.eval("[...document.querySelectorAll('[data-fill-key]:checked')].map(c=>c.dataset.fillKey)")) if (k !== "agreements") await click(b, `[data-fill-key="${k}"]`);
if (!(await b.eval(`document.querySelector('[data-fill-key="agreements"]').checked`))) await click(b, '[data-fill-key="agreements"]');
ok("выбран объект 1 и его проект", await b.eval("document.querySelector('#fs-object').value==='1'"));
// обрыв связи на отправке
await click(b, "#fs-apply");
await b.waitFor("!!document.querySelector('#ty-input')", 10000);
await fill(b, "#ty-input", "ЗАПОЛНИТ");
ok("неверное слово — кнопка подтверждения закрыта", await b.eval(`document.querySelector('.v2-dialog [data-choice="confirm"]').disabled`));
await fill(b, "#ty-input", "ЗАПОЛНИТЬ");
await b.offline(true);
const n0 = b.requests.length;
await click(b, '.v2-dialog [data-choice="confirm"]');
await b.waitFor(`/Неизвестно, выполнено ли/.test(document.querySelector('#fs-status').textContent)`, 15000);
await b.sleep(800);
ok("обрыв связи: «неизвестно», без автоповтора (1 попытка записи)", b.requests.slice(n0).filter((r) => r.method === "POST" && /apply/.test(r.url)).length === 1);
ok("обрыв связи: ничего не записано (SQL)", q1(`select count(*) n from agreements where id in (${ids}) and object_id is null`).n === 2);
await b.offline(false);
// успех: двойной щелчок по подтверждению — один запрос
await b.eval("location.reload()"); await b.sleep(2500);
await b.waitFor("!!document.querySelector('[data-fill-key=\"agreements\"]')", 20000);
for (const k of await b.eval("[...document.querySelectorAll('[data-fill-key]:checked')].map(c=>c.dataset.fillKey)")) if (k !== "agreements") await click(b, `[data-fill-key="${k}"]`);
if (!(await b.eval(`document.querySelector('[data-fill-key="agreements"]').checked`))) await click(b, '[data-fill-key="agreements"]');
await click(b, "#fs-apply");
await b.waitFor("!!document.querySelector('#ty-input')", 10000);
await fill(b, "#ty-input", "ЗАПОЛНИТЬ");
const n1 = b.requests.length;
const r = await b.rect('.v2-dialog [data-choice="confirm"]'); await b.click(r.cx, r.cy, { count: 2 });
await b.waitFor(`/Готово/.test(document.querySelector('#fs-status').textContent)`, 20000);
ok("двойной щелчок — один запрос заполнения", b.requests.slice(n1).filter((x) => x.method === "POST" && /apply/.test(x.url)).length === 1);
ok("SQL: договоры получили объект 1", q1(`select count(*) n from agreements where id in (${ids}) and object_id=1`).n === 2);
ok("журнал: одно событие fill_empty_scope", q1("select count(*) n from activity_log where action='fill_empty_scope'").n === j0 + 1);
ok("сводка перечитана: пустых договоров 0", /Всего заполнено: 2/.test(await b.eval("document.querySelector('#fs-status').textContent")));
// устаревший предпросмотр: пока человек подтверждает, те же записи заполнил другой администратор → честный итог «заполнено 0»
sqlExec(DB, `update agreements set object_id=NULL where id in (${ids})`);
await b.eval("location.reload()"); await b.sleep(2500);
await b.waitFor("!!document.querySelector('[data-fill-key=\"agreements\"]')", 20000);
for (const k of await b.eval("[...document.querySelectorAll('[data-fill-key]:checked')].map(c=>c.dataset.fillKey)")) if (k !== "agreements") await click(b, `[data-fill-key="${k}"]`);
if (!(await b.eval(`document.querySelector('[data-fill-key="agreements"]').checked`))) await click(b, '[data-fill-key="agreements"]');
await click(b, "#fs-apply");
await b.waitFor("!!document.querySelector('#ty-input')", 10000);
await fill(b, "#ty-input", "ЗАПОЛНИТЬ");
const other = await as("user3");   // второй администратор сервиса
ok("другой администратор заполнил те же записи", (await other.post("/admin/fill-empty-scope/apply", { project_id: 1, object_id: 1, keys: ["agreements"] })).status === 200);
await click(b, '.v2-dialog [data-choice="confirm"]');
await b.waitFor(`/Готово/.test(document.querySelector('#fs-status').textContent)`, 20000);
ok("устаревший предпросмотр: итог по факту — «Всего заполнено: 0», данные не тронуты повторно", /Всего заполнено: 0/.test(await b.eval("document.querySelector('#fs-status').textContent")) && q1(`select count(*) n from agreements where id in (${ids}) and object_id=1`).n === 2);
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
restore();
const b4 = await session(BASE, "user4"); await go(b4, "fill-scope");
ok("user4: экрана нет (V1 — пункт только администратору)", await b4.eval("location.hash==='#/' && !document.querySelector('#fs-apply')"));
await b4.close();
process.exit(summary());
