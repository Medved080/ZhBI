// «Состояние БД»: перенос окна V1 целиком — сводка о файле, красная плашка расхождения описания со схемой, области и порядок
// по объёму, описания полей и связи, просмотр строк с подписями колонок, заметкой о скрытых колонках и выбором размера страницы.
// Настоящий backend, вход формой, настоящие щелчки. Роли: user2/user4 — 403 и экрана нет (как пункт меню V1).
//   node scripts/audit_set/check_db_status.mjs <копия БД> <порт>
import { session, ok, summary, go, click, BASE, SHOTS, as, overflowX } from "./lib.mjs";

const a = await as("admin");
const api = (await a.get("/admin/db-status")).data;
const b = await session(BASE, "admin");
await go(b, "db-status");
await b.waitFor("!!document.querySelector('#db-summary')", 30000);
const sum = await b.eval("document.querySelector('#db-summary').innerText");
ok("сводка: файл, размер, страницы, записи, таблицы и связи, SQLite", /Файл базы/.test(sum) && /Размер файла/.test(sum) && /Страниц/.test(sum) && new RegExp(`${api.tables.length}, связей ${api.relations.length}`).test(sum) && sum.includes(api.database.sqlite_version), sum.replace(/\n/g, " ").slice(0, 200));
const drift = await b.eval("(document.querySelector('#db-drift')||{}).innerText||''");
ok(`красная плашка расхождения (${api.drift.length} пунктов от сервера)`, api.drift.length ? api.drift.every((x) => drift.includes(x)) : !drift, drift.slice(0, 160));
const order = await b.eval("[...document.querySelectorAll('.v2-dbs-group')].map(g=>[g.querySelector('h3').textContent,[...g.querySelectorAll('[data-table]')].map(t=>t.dataset.table)])");
const vol = (n) => { const t = api.tables.find((x) => x.name === n); return (t.bytes || 0) + (t.index_bytes || 0); };
ok("области — в порядке легенды схемы", JSON.stringify(order.map((g) => g[0]).filter((x) => api.domains.includes(x))) === JSON.stringify(api.domains.filter((dm) => order.some((g) => g[0] === dm))));
ok("внутри области таблицы по убыванию объёма (данные + индексы)", order.every(([, ts]) => ts.every((n, i) => i === 0 || vol(ts[i - 1]) >= vol(n))));
ok("все таблицы показаны", order.reduce((s, g) => s + g[1].length, 0) === api.tables.length);
// раскрытие таблицы: поля и связи
const withRel = api.relations[0].child;
await click(b, `[data-toggle="${withRel}"]`); await b.sleep(300);
const fields = await b.eval(`document.querySelector('[data-table="${withRel}"] .v2-dbs-fields')?.innerText||''`);
const t0 = api.tables.find((t) => t.name === withRel);
ok(`описания полей «${withRel}» и «Ссылается на»`, t0.fields.every((f) => fields.includes(f.name)) && /Ссылается на/.test(fields), fields.slice(0, 120).replace(/\n/g, " "));
const undoc = api.tables.find((t) => t.fields.some((f) => f.undocumented));
if (undoc) {
  await click(b, `[data-toggle="${undoc.name}"]`); await b.sleep(300);
  ok(`неописанное поле помечено («${undoc.name}»)`, (await b.eval(`document.querySelector('[data-table="${undoc.name}"] .v2-dbs-fields').innerText`)).includes("есть в базе, назначение не описано"));
}
if (SHOTS) await b.shot(`${SHOTS}/db-status-1920.png`);
await b.viewport(1366, 768); await b.sleep(300);
ok("1366×768: без горизонтальной прокрутки страницы", (await overflowX(b)) <= 1);
if (SHOTS) await b.shot(`${SHOTS}/db-status-1366.png`);
await b.viewport(1920, 1080);
// содержимое: users — маскировка, подписи колонок, размер страницы
await click(b, '[data-open="users"]');
await b.waitFor("!!document.querySelector('#db-range')", 20000);
ok("просмотр строк: заметка о скрытых колонках", /Значения скрыты/.test(await b.eval("document.querySelector('#db-table-note').textContent")));
ok("подписи назначения под заголовками колонок", await b.eval("[...document.querySelectorAll('thead th small')].length > 3"));
const r50 = await b.eval("document.querySelectorAll('tbody tr').length");
const total = (await a.get("/admin/db-status/tables/users?limit=1&offset=0")).data.total;
ok("по умолчанию 50 строк на странице (как в V1)", r50 === Math.min(50, total), `${r50} из ${total}`);
await b.eval("(()=>{const s=document.querySelector('#db-limit');s.value='200';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
await b.waitFor("document.querySelector('#db-limit') && document.querySelector('#db-limit').value==='200' && !!document.querySelector('#db-range')", 20000);
await b.sleep(400);
ok("выбор 200 строк на странице", (await b.eval("document.querySelectorAll('tbody tr').length")) === Math.min(200, total) && b.requests.some((r) => /tables\/users\?limit=200&offset=0/.test(r.url)));
if (total > 200) { await click(b, "#db-next"); await b.sleep(900); ok("«Вперёд →» — следующая страница", b.requests.some((r) => /limit=200&offset=200/.test(r.url))); }
const hidden = await b.eval("[...document.querySelectorAll('tbody td')].some(td=>/[0-9a-f]{40,}/.test(td.textContent))");
ok("секретные значения не показаны (хэши паролей)", !hidden);
ok("записи на сервер не отправлялись", !b.requests.some((r) => r.method !== "GET" && !/\/login/.test(r.url)));
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
// роли: V1 пункт меню — раздел backups (чтение), сервер — db_status (чтение); у user2/user4 нет ни того, ни другого
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  ok(`${who}: GET /admin/db-status → 403`, (await c.get("/admin/db-status")).status === 403);
  const bb = await session(BASE, who);
  await go(bb, "db-status");
  ok(`${who}: экрана нет (переход на «Начало»)`, await bb.eval("location.hash==='#/' && !document.querySelector('#db-summary')"));
  await bb.close();
}
process.exit(summary());
