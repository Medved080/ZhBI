import { session, sql, ok, summary, openSection, click, reload } from "../verify_admin_lib.mjs";

const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "zones");
await b.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b.sleep(900);

const hasTabs = await b.eval(`document.querySelectorAll('[data-cat]').length`);
ok("три вкладки категорий", hasTabs === 3);

const zoneRow = sql(DB, "select id, name from zones where category='Захватка' and is_current=1 order by id limit 1")[0];
ok("нашли захватку в базе", !!zoneRow);

// открыть правку первой зоны в списке
await b.eval(`document.querySelector('[data-open]')?.scrollIntoView({block:'center'})`);
await click(b, '[data-open]');
await b.sleep(900);

const inEditor = await b.eval(`!!document.querySelector('#ze-name')`);
ok("редактор зоны открылся", inEditor);

if (inEditor) {
  const nameField = await b.rect('#ze-name');
  await b.click(nameField.cx, nameField.cy, { count: 3 });
  await b.type("QAUI-ZONE");
  await b.sleep(200);
  const svgHasPolygon = await b.eval(`!!document.querySelector('#ze-preview polygon')`);
  ok("предпросмотр рисует полигон", svgHasPolygon);

  await click(b, '#ze-save');
  await b.sleep(11000);

  const backAtList = await b.eval(`!!document.querySelector('[data-cat]')`);
  ok("после сохранения вернулись к списку", backAtList);

  const row = sql(DB, `select name from zones where id=${zoneRow.id}`)[0];
  ok("SQL: имя зоны сохранено", row && row.name === "QAUI-ZONE");

  const hasUndo = await b.eval(`!!document.querySelector('#ze-undo')`);
  ok("кнопка отмены последней правки появилась", hasUndo);

  if (hasUndo) {
    await click(b, '#ze-undo');
    await b.sleep(300);
    const confirmVisible = await b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
    ok("диалог подтверждения отката появился", confirmVisible);
    if (confirmVisible) { await click(b, '.v2-dialog [data-choice="confirm"]'); await b.sleep(900); }
    const row2 = sql(DB, `select name from zones where id=${zoneRow.id}`)[0];
    ok("SQL: имя зоны откатилось", row2 && row2.name === zoneRow.name);
  }
}

// user4 не должен видеть кнопку правки/удаления
const b4 = await session(BASE, "user4");
await openSection(b4, "zones");
await b4.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b4.sleep(900);
const hasOpenBtn = await b4.eval(`!!document.querySelector('[data-open]')`);
ok("user4 (view) не видит кнопку правки зоны", !hasOpenBtn);

await b.close(); await b4.close();
process.exit(summary());
