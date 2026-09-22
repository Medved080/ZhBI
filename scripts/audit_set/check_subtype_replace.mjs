// «Типы, подтипы и марки»: удаление ИСПОЛЬЗУЕМОГО подтипа с заменой (перенос V1 openDictDelete → в V2 был отказ).
// Подготовка на КОПИИ БД: два синтетических подтипа QA-A/QA-B у «Ригель» объекта 1, трём изделиям временно ставится QA-A.
// Настоящий backend, вход формой, настоящие щелчки (выбор в <select> замены — значение + change: открытый список безголовому браузеру недоступен).
//   node scripts/audit_set/check_subtype_replace.mjs <копия БД> <порт>
import { session, sql, sqlExec, ok, summary, go, click, DB, BASE, SHOTS, setObject, as, onBail, overflowX } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
const T = "Ригель", A = "QA-A-замена", B = "QA-B-замена";
const els = sql(DB, `select id, subtype from elements where object_id=1 and element_type='${T}' order by id limit 3`);
const ids = els.map((e) => e.id).join(",");
const restore = () => {
  for (const e of els) sqlExec(DB, `update elements set subtype=${e.subtype === null ? "NULL" : `'${e.subtype.replace(/'/g, "''")}'`} where id=${e.id}`);
  sqlExec(DB, `delete from allowed_subtypes where object_id=1 and element_type='${T}' and subtype in ('${A}','${B}')`);
};
onBail(async () => restore());
sqlExec(DB, `insert or ignore into allowed_subtypes(object_id, element_type, subtype) values (1,'${T}','${A}'),(1,'${T}','${B}')`);
sqlExec(DB, `update elements set subtype='${A}' where id in (${ids})`);
const journal0 = q1("select count(*) n from activity_log where action='dictionary_delete'").n;
const totalRig = q1(`select count(*) n from elements where object_id=1 and element_type='${T}'`).n;

// Ограниченные роли: сервер не даёт удалить (dict_delete — только администратор сервиса), как и V1
const key = encodeURIComponent(`1|${T}|${A}`);
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  const r = await c.post(`/dictionaries/subtype/${key}/delete`, { replacements: { [`1|${T}|${A}`]: `1|${T}|${B}` }, mode: "replace" });
  ok(`${who}: удаление подтипа → 403`, r.status === 403, String(r.status));
}
ok("после отказов подтип и изделия на месте (SQL)", q1(`select count(*) n from elements where id in (${ids}) and subtype='${A}'`).n === 3);

const b = await session(BASE, "admin");
await setObject(b, 1);
await go(b, "subtypes");
const delSel = `[data-del="${A}"][data-type="${T}"]`;
await b.waitFor(`!!document.querySelector(${JSON.stringify(delSel)})`, 20000);
await click(b, delSel);
await b.waitFor("!!document.querySelector('[data-dp-sel]')", 20000);
ok("используемый подтип: окно плана с выбором замены (а не отказ)", await b.eval(`/Изделия/.test(document.querySelector('.v2-dialog').innerText) && document.querySelector('[data-dp=\"ok\"]').disabled`));
if (SHOTS) await b.shot(`${SHOTS}/subtype-replace-dialog.png`);
// отмена ничего не пишет
await click(b, '[data-dp="cancel"]'); await b.sleep(400);
ok("отмена: SQL без изменений", q1(`select count(*) n from elements where id in (${ids}) and subtype='${A}'`).n === 3 && q1(`select count(*) n from allowed_subtypes where object_id=1 and subtype='${A}'`).n === 1);
// повтор: выбор замены B и подтверждение (двойной щелчок — один запрос)
await click(b, delSel);
await b.waitFor("!!document.querySelector('[data-dp-sel] option[value]:not([value=\"\"])')", 20000);
const optKey = `1|${T}|${B}`;
await b.eval(`(()=>{const s=document.querySelector('[data-dp-sel]');s.value=${JSON.stringify(optKey)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await b.waitFor(`!document.querySelector('[data-dp="ok"]').disabled`, 10000);
const reqBefore = b.requests.length;
const r = await b.rect('[data-dp="ok"]');
await b.click(r.cx, r.cy, { count: 2 });
await b.waitFor(`!document.querySelector('.v2-dialog-backdrop')`, 30000);
await b.sleep(600);
const posts = b.requests.slice(reqBefore).filter((x) => x.method === "POST" && /\/dictionaries\/subtype\//.test(x.url));
ok("двойной щелчок — один запрос удаления", posts.length === 1, `${posts.length}`);
ok("тело запроса: замена на QA-B, режим replace", posts[0] && JSON.stringify(JSON.parse(posts[0].body)) === JSON.stringify({ replacements: { [`subtype:1|${T}|${A}`]: optKey }, mode: "replace" }), posts[0]?.body);
ok("SQL: изделия перенесены на QA-B, QA-A удалён", q1(`select count(*) n from elements where id in (${ids}) and subtype='${B}'`).n === 3 && q1(`select count(*) n from allowed_subtypes where object_id=1 and subtype='${A}'`).n === 0);
ok("SQL: прочие изделия типа не затронуты", q1(`select count(*) n from elements where object_id=1 and element_type='${T}'`).n === totalRig && q1(`select count(*) n from elements where object_id=1 and element_type='${T}' and subtype='${B}'`).n === 3);
ok("журнал: одно событие удаления справочника", q1("select count(*) n from activity_log where action='dictionary_delete'").n === journal0 + 1);
ok("экран: сообщение об удалении и подтипа в списке нет", await b.eval(`/Удалено: «${A}»/.test(document.body.innerText) && !document.querySelector(${JSON.stringify(delSel)})`));
// неиспользуемый B (после возврата изделий) — простое подтверждение
for (const e of els) sqlExec(DB, `update elements set subtype=${e.subtype === null ? "NULL" : `'${e.subtype.replace(/'/g, "''")}'`} where id=${e.id}`);
await b.eval("location.reload()"); await b.sleep(2500);
await b.waitFor(`!!document.querySelector('[data-del="${B}"]')`, 20000);
await click(b, `[data-del="${B}"][data-type="${T}"]`);
await b.waitFor("!!document.querySelector('.v2-dialog [data-choice=\"confirm\"]')", 20000);
await click(b, '.v2-dialog [data-choice="confirm"]');
await b.sleep(1500);
ok("неиспользуемый подтип удалён после подтверждения (SQL)", q1(`select count(*) n from allowed_subtypes where object_id=1 and subtype='${B}'`).n === 0);
ok("изделия возвращены к исходным подтипам (SQL)", els.every((e) => q1(`select subtype s from elements where id=${e.id}`).s === e.subtype));
for (const [w, h] of [[1920, 1080], [1366, 768]]) { await b.viewport(w, h); await b.sleep(200); ok(`${w}: без горизонтальной прокрутки`, (await overflowX(b)) <= 1); }
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
await b.close();
restore();
process.exit(summary());
