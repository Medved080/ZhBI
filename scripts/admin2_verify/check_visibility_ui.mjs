import { session, sql, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "label-visibility");
await b.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b.sleep(700);

const hasTable = await b.eval(`!!document.querySelector('.v2-read-tbl')`);
ok("таблица типов отобразилась", hasTable);

const before = sql(DB, "select visible from label_visibility where object_id=1 and element_type='Колонна'")[0];
ok("«Колонна» сейчас выключена (visible=0)", before && before.visible === 0);

// включить подпись «Колонна»
const cb = await b.eval(`(() => { const el = document.querySelector('[data-vis="Колонна"]'); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`);
ok("нашли чекбокс «Колонна»", !!cb);
if (cb) {
  await b.click(cb.x, cb.y);
  await b.sleep(200);
  await click(b, "#vi-save");
  await b.sleep(700);
  const after = sql(DB, "select visible from label_visibility where object_id=1 and element_type='Колонна'")[0];
  ok("SQL: «Колонна» включена (visible=1)", after && after.visible === 1);

  // вернуть обратно
  const cb2 = await b.rect('[data-vis="Колонна"]');
  await b.click(cb2.cx, cb2.cy);
  await click(b, "#vi-save");
  await b.sleep(700);
  const restored = sql(DB, "select visible from label_visibility where object_id=1 and element_type='Колонна'")[0];
  ok("SQL: «Колонна» возвращена в выключенное состояние", restored && restored.visible === 0);
}

const b4 = await session(BASE, "user4");
await openSection(b4, "label-visibility");
await b4.eval(`document.querySelector('#v2-object').value = '1'; document.querySelector('#v2-object').dispatchEvent(new Event('change'))`);
await b4.sleep(700);
const disabledCb = await b4.eval(`document.querySelector('[data-vis="Колонна"]')?.disabled`);
ok("user4 (view) видит поля отключёнными", disabledCb === true);

await b.close(); await b4.close();
process.exit(summary());
