import { session, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[2] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const b = await session(BASE, "admin");
await openSection(b, "db-status");
await b.sleep(700);
const hasTable = await b.eval(`!!document.querySelector('.v2-read-tbl')`);
ok("список таблиц отображён", hasTable);
const openBtn = await b.eval(`!!document.querySelector('[data-open="elements"]')`);
ok("есть кнопка открытия таблицы elements", openBtn);
if (openBtn) {
  await click(b, '[data-open="elements"]');
  await b.sleep(700);
  const hasRows = await b.eval(`document.querySelectorAll('.v2-read-tbl tbody tr').length`);
  ok("строки таблицы elements отображены", hasRows > 0);
  const hasNext = await b.eval(`!!document.querySelector('#db-next')`);
  ok("кнопка пагинации есть", hasNext);
  if (hasNext) {
    await click(b, '#db-next');
    await b.sleep(500);
    const rows2 = await b.eval(`document.querySelectorAll('.v2-read-tbl tbody tr').length`);
    ok("после «Дальше» строки показаны", rows2 > 0);
  }
  await click(b, '#db-back');
  await b.sleep(400);
  const backAtList = await b.eval(`!!document.querySelector('#db-search')`);
  ok("вернулись к списку таблиц", backAtList);
}
await b.close();
process.exit(summary());
