import { session, sql, ok, summary, openSection, text, click, reload } from "../verify_admin_lib.mjs";

const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "subtypes");
await b.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b.sleep(700);

// добавить марку к первому типу, у которого есть секция
const beforeCount = sql(DB, "select count(*) n from marks where object_id=1 and name='QAUI-1'")[0].n;
ok("марки QAUI-1 нет до теста", beforeCount === 0);

const typed = await b.eval(`(() => { const el = document.querySelector('[data-add-mark]'); if (!el) return null; el.scrollIntoView({block:'center'}); return el.dataset.addMark; })()`);
ok("нашли поле добавления марки", !!typed);

await b.eval(`document.querySelector('[data-add-mark]').focus()`);
await b.type("QAUI-1");
await click(b, `[data-add-mark-btn="${typed}"]`);
await b.sleep(700);

const created = sql(DB, "select id,name from marks where object_id=1 and name='QAUI-1'");
ok("SQL: марка QAUI-1 создана", created.length === 1);
const markId = created[0] ? created[0].id : null;

// переименование через инлайн-поле: правка значения, blur => confirm dialog => подтверждение
if (markId) {
  await b.eval(`document.querySelector('[data-mark-input="${markId}"]').scrollIntoView({block:'center'})`);
  const r = await b.rect(`[data-mark-input="${markId}"]`);
  await b.click(r.cx, r.cy, { count: 3 });
  await b.type("QAUI-2");
  await b.eval(`document.querySelector('[data-mark-input="${markId}"]').blur()`);
  await b.sleep(400);
  const dialogVisible = await b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
  ok("диалог подтверждения переименования появился", dialogVisible);
  if (dialogVisible) {
    await click(b, '.v2-dialog [data-choice="confirm"]');
    await b.sleep(700);
  }
  const renamed = sql(DB, `select name from marks where id=${markId}`);
  ok("SQL: марка переименована в QAUI-2", renamed[0] && renamed[0].name === "QAUI-2");

  // удаление
  await b.eval(`document.querySelector('[data-del-mark="${markId}"]').scrollIntoView({block:'center'})`);
  await click(b, `[data-del-mark="${markId}"]`);
  await b.sleep(500);
  const confirmVisible = await b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
  ok("диалог удаления появился", confirmVisible);
  if (confirmVisible) {
    const btns = await b.eval(`[...document.querySelectorAll('.v2-dialog button')].map(x=>x.textContent)`);
    console.log("кнопки диалога:", btns);
    await click(b, '.v2-dialog [data-choice="confirm"]');
    await b.sleep(700);
  }
  const goneRow = sql(DB, `select 1 x from marks where id=${markId}`);
  ok("SQL: марка удалена", goneRow.length === 0);
}

// user4 (view) — не должен видеть форму добавления марки/подтипа
const b4 = await session(BASE, "user4");
await openSection(b4, "subtypes");
await b4.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b4.sleep(700);
const hasAddMark = await b4.eval(`!!document.querySelector('[data-add-mark]')`);
ok("user4 (view) не видит форму добавления марки", !hasAddMark);

await b.close(); await b4.close();
process.exit(summary());
