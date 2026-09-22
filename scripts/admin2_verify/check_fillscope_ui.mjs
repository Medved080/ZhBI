import { session, sql, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "fill-scope");
await b.sleep(900);

const hasCheckbox = await b.eval(`!!document.querySelector('[data-fill-key="agreements"]')`);
ok("нашли чекбокс «Договоры»", hasCheckbox);

// объект 1 выбрать вручную
await b.eval(`document.querySelector('#fs-object').value = '1'; `);
const cb = await b.rect('[data-fill-key="agreements"]');
if (!(await b.eval(`document.querySelector('[data-fill-key="agreements"]').checked`))) {
  await b.click(cb.cx, cb.cy);
}
await b.sleep(200);
await click(b, '#fs-apply');
await b.sleep(500);
const dialogVisible = await b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
ok("диалог подтверждения словом появился", dialogVisible);
if (dialogVisible) {
  const input = await b.rect('#ty-input');
  await b.click(input.cx, input.cy);
  await b.type("ЗАПОЛНИТЬ");
  await click(b, '[data-choice="confirm"]');
  await b.sleep(900);
}
const row = sql(DB, "select object_id from agreements where number='QA-FS-TEST-1'")[0];
ok("SQL: object_id у тестового договора заполнен объектом 1", row && row.object_id === 1);

const status = await b.eval(`document.getElementById('fs-status')?.innerText`);
console.log("status:", status);
ok("статус сообщает «Готово»", /Готово/.test(status || ""));

// user4 не должен видеть форму (нет системных прав)
const b4 = await session(BASE, "user4");
await openSection(b4, "fill-scope");
await b4.sleep(700);
const hasApplyBtn4 = await b4.eval(`!!document.getElementById('fs-apply')`);
ok("user4 (view) не видит кнопку «Заполнить»", !hasApplyBtn4);

await b.close(); await b4.close();
process.exit(summary());
