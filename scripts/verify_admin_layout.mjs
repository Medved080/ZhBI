// Замер раскладки экранов области «admin» на настоящем сервере (1920×1080 и 1366×768): страница не должна прокручиваться и переполняться по горизонтали.
// Запуск: node scripts/verify_admin_layout.mjs <каталог_для_скриншотов> [порт]
import { session, openSection, text, click } from "/Users/max/zhbi-w-admin/scripts/verify_admin_lib.mjs";
import { mkdirSync } from "node:fs";
const dir = process.argv[2]; mkdirSync(dir, { recursive: true });
const SCREENS = ["users-access", "access-matrix", "sessions", "my-access", "change-password", "projects-objects", "dict-individuals", "backups", "reset-history", "ldap", "map-admin", "activity", "changelog", "db-status", "admin-guide", "training", "training-history"];
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const b = await session(`http://127.0.0.1:${process.argv[3] || 8141}`, "admin", { width: w, height: h });
  for (const id of SCREENS) {
    await openSection(b, id);
    await b.sleep(1800);
    const m = await b.eval(`(()=>{const se=document.scrollingElement; const c=document.querySelector('#v2-content'); const body=document.body; return {pageScroll: se.scrollHeight - innerHeight, contentOverflowX: c ? c.scrollWidth - c.clientWidth : -1, docOverflowX: se.scrollWidth - innerWidth}})()`);
    console.log(`${w}x${h} ${id.padEnd(20)} страница прокручивается на ${m.pageScroll}px; горизонтально: контент ${m.contentOverflowX}, документ ${m.docOverflowX}`);
    await b.shot(`${dir}/${id}-${w}.png`);
  }
  await b.close();
}
