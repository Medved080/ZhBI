// «Зоны»: удаление зоны крана по плану последствий на настоящем backend (КОПИЯ БД, объект 2): замена крана и подчинённой стоянки,
// перевод изделий на замену, SQL до/после, журнал; 403 у user2/user4. Необратимо — только на временной копии.
//   node scripts/audit_set/check_zone_delete.mjs <копия БД> <порт>
import { session, sql, ok, summary, go, click, DB, BASE, setObject, as } from "./lib.mjs";

const q1 = (s) => sql(DB, s)[0];
// объект с двумя и более кранами (при повторном прогоне на той же копии объект 2 уже без второго крана — берётся следующий)
const OBJ = q1("select object_id o from zones where category='Кран' and object_id in (1,2) group by object_id having count(*)>=2 order by object_id desc limit 1").o;
const crane = q1(`select id from zones where object_id=${OBJ} and category='Кран' order by id limit 1`).id;
const repl = q1(`select id from zones where object_id=${OBJ} and category='Кран' and id<>${crane} order by id limit 1`).id;
const nCr = q1(`select count(*) n from elements where zone_crane_id=${crane}`).n, nCr2 = q1(`select count(*) n from elements where zone_crane_id=${repl}`).n;
const nStAll = q1(`select count(*) n from elements where object_id=${OBJ} and zone_stance_id is not null`).n;
const j0 = q1("select count(*) n from activity_log where action in ('dictionary_delete','dictionary_merge')").n;
for (const who of ["user2", "user4"]) {
  const r = await (await as(who)).post(`/dictionaries/zone/${crane}/delete`, { replacements: { [`zone:${crane}`]: String(repl) }, mode: "merge" });
  ok(`${who}: удаление зоны → 403`, r.status === 403, String(r.status));
}
ok("после отказов зона на месте", q1(`select count(*) n from zones where id=${crane}`).n === 1);

const b = await session(BASE, "admin");
await setObject(b, OBJ);
await go(b, "zones");
await click(b, '[data-cat="Кран"]');
await b.waitFor(`!!document.querySelector('[data-del="${crane}"]')`, 20000);
await click(b, `[data-del="${crane}"]`);
await b.waitFor("document.querySelectorAll('[data-dp-sel]').length>=1", 20000);
const pick = async (i, value) => {
  await b.waitFor(`(()=>{const s=document.querySelectorAll('[data-dp-sel]')[${i}];return !!s && !s.disabled && [...s.options].some(o=>o.value===${JSON.stringify(value)})})()`, 15000);
  await b.eval(`(()=>{const s=document.querySelectorAll('[data-dp-sel]')[${i}];s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await b.sleep(400);
};
ok("план: у крана есть стоянки — предложен перенос (по умолчанию, как в V1) или замена каждой", await b.eval(`!!document.querySelector('input[name=dp-mode][value=merge]:checked') && /Изделия/.test(document.querySelector('.v2-dialog').innerText)`));
const others = sql(DB, `select id from zones where object_id=${OBJ} and category='Кран' and id<>${crane} order by id`).map((r) => String(r.id)).join();
ok("в замене — только другие краны того же объекта (кандидаты сервера)", (await b.eval(`[...document.querySelectorAll('[data-dp-sel]')[0].options].filter(o=>o.value).map(o=>o.value).sort().join()`)) === others);
await pick(0, String(repl));
await b.waitFor(`!document.querySelector('[data-dp="ok"]').disabled`, 10000);
await click(b, '[data-dp="ok"]');
await b.waitFor(`!document.querySelector('.v2-dialog-backdrop')`, 60000);
await b.sleep(800);
ok("SQL: кран удалён", q1(`select count(*) n from zones where id=${crane}`).n === 0);
ok("SQL: изделия крана переведены на замену", q1(`select count(*) n from elements where zone_crane_id=${repl}`).n === nCr + nCr2 && q1(`select count(*) n from elements where zone_crane_id=${crane}`).n === 0);
ok("SQL: стоянки перенесены к замене (висячих ссылок нет)", q1(`select count(*) n from elements e where e.object_id=${OBJ} and e.zone_stance_id is not null and not exists (select 1 from zones z where z.id=e.zone_stance_id)`).n === 0
  && q1(`select count(*) n from zones where object_id=${OBJ} and category='Стоянка' and (parent_zone_id is null or parent_zone_id=${crane})`).n === 0
  && q1(`select count(*) n from elements where object_id=${OBJ} and zone_stance_id is not null`).n === nStAll);
ok("журнал: одно событие удаления (перенос стоянок — dictionary_merge)", q1("select count(*) n from activity_log where action in ('dictionary_delete','dictionary_merge')").n === j0 + 1);
ok("список обновлён, сообщение «Зона удалена.»", await b.eval(`!document.querySelector('[data-del="${crane}"]') && /Зона удалена/.test(document.body.innerText)`));
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
process.exit(summary());
