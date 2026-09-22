// Ограниченные роли для служебных экранов без собственной проверки ролей: «Перенос базы целиком», «Префиксы марок».
// Сервер отказывает в записи (403), экран у роли без права не открывается (как пункт меню V1); у admin — операции префиксов живым
// прогоном: добавление, замена типа с подтверждением, удаление по плану (SQL до/после). Настоящий backend, вход формой.
//   node scripts/audit_set/check_roles_misc.mjs <копия БД> <порт>
import { session, sql, ok, summary, go, click, fill, DB, BASE, as, onBail, setObject } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
// ---- перенос базы: 403 на все записи, экрана нет
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  ok(`${who}: POST /admin/db-transfer/export → 403`, (await c.post("/admin/db-transfer/export")).status === 403);
  ok(`${who}: POST /admin/db-transfer/apply → 403`, (await c.post("/admin/db-transfer/apply", { token: "x", confirm: "x" })).status === 403);
  ok(`${who}: GET /admin/db-transfer/current → 403`, (await c.get("/admin/db-transfer/current")).status === 403);
  const b = await session(BASE, who); await go(b, "db-transfer");
  ok(`${who}: экрана «Перенос базы целиком» нет`, await b.eval("location.hash==='#/' && !document.querySelector('#dt-export')"));
  await b.close();
}

// ---- префиксы марок: admin — полный цикл, user2/user4 — 403 и экрана нет
const P = "QAAUD";
onBail(async () => { const { execFileSync } = await import("node:child_process"); execFileSync("sqlite3", [DB, `delete from mark_type_prefixes where prefix='${P}'`]); });
const n0 = q1("select count(*) n from mark_type_prefixes").n;
const b = await session(BASE, "admin");
await setObject(b, 1);
await go(b, "mark-prefixes");
await b.waitFor("!!document.querySelector('#v2-content input')", 20000);
const types = await b.eval("[...document.querySelectorAll('#pe-type option')].map(o=>o.value).filter(Boolean)");
const [T1, T2] = types;
await fill(b, "#pe-prefix", P);
await b.eval(`(()=>{const s=document.querySelector('#pe-type');s.value=${JSON.stringify(T1)};s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await click(b, "#pe-add-btn"); await b.sleep(1200);
ok(`admin: префикс ${P} → «${T1}» добавлен (SQL)`, q1(`select element_type t from mark_type_prefixes where prefix='${P}'`)?.t === T1);
// тот же префикс с другим типом — замена только после подтверждения (V1 молча перезаписывал)
await fill(b, "#pe-prefix", P);
await b.eval(`(()=>{const s=document.querySelector('#pe-type');s.value=${JSON.stringify(T2)};s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await click(b, "#pe-add-btn");
await b.waitFor("!!document.querySelector('.v2-dialog [data-choice=\"confirm\"]')", 10000).catch(async () => { console.log("   типы:", types, "статус:", await b.eval("document.querySelector('#pe-status').textContent"), "значение:", await b.eval("document.querySelector('#pe-prefix').value + '|' + document.querySelector('#pe-type').value")); throw new Error("нет подтверждения замены"); });
ok("замена типа — только после подтверждения (до него SQL прежний)", q1(`select element_type t from mark_type_prefixes where prefix='${P}'`).t === T1);
await click(b, '.v2-dialog [data-choice="confirm"]'); await b.sleep(1200);
ok(`admin: тип префикса заменён на «${T2}» (SQL)`, q1(`select element_type t from mark_type_prefixes where prefix='${P}'`)?.t === T2);
await click(b, `[data-act="delete"][data-prefix="${P}"]`);
await b.waitFor("!!document.querySelector('.v2-dialog [data-choice=\"confirm\"]')", 10000);
await click(b, '.v2-dialog [data-choice="confirm"]'); await b.sleep(1200);
ok("admin: префикс удалён по плану (SQL), справочник вернулся к исходному", !q1(`select count(*) n from mark_type_prefixes where prefix='${P}'`).n && q1("select count(*) n from mark_type_prefixes").n === n0);
ok("журнал: mark_prefix_set и удаление справочника", q1("select count(*) n from activity_log where action='mark_prefix_set' and at > datetime('now','-3 minutes')").n >= 2);
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  ok(`${who}: POST /mark-type-prefixes → 403`, (await c.post("/mark-type-prefixes", { prefix: P, element_type: "Колонна" })).status === 403);
  const bb = await session(BASE, who); await setObject(bb, 1); await go(bb, "mark-prefixes");
  ok(`${who}: экрана «Префиксы марок» нет (V1: пункт меню по праву записи)`, await bb.eval("location.hash==='#/'"));
  await bb.close();
}
ok("префиксы не изменились после отказов", q1("select count(*) n from mark_type_prefixes").n === n0);
process.exit(summary());
