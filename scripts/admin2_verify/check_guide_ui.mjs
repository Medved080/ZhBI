import { session, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[2] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const b = await session(BASE, "admin");
await openSection(b, "admin-guide");
await b.sleep(700);
const hasFacts = await b.eval(`!!document.querySelector('.v2-facts')`);
ok("факты о сервере показаны", hasFacts);
const hasCopyBtn = await b.eval(`!!document.querySelector('[data-copy]')`);
ok("есть кнопка «Копировать»", hasCopyBtn);
if (hasCopyBtn) {
  await click(b, '[data-copy]');
  await b.sleep(300);
  const txt = await b.eval(`document.querySelector('[data-copy]').textContent`);
  ok("кнопка сменила текст на «Скопировано» или «Не вышло»", /Скопировано|Не вышло/.test(txt));
}
const before = b.requests.length;
await click(b, '#ag-download');
await b.sleep(500);
const dlReq = b.requests.slice(before).find(r => r.url.includes('admin-guide.md'));
ok("запрос за .md отправлен", !!dlReq);
await b.close();
process.exit(summary());
