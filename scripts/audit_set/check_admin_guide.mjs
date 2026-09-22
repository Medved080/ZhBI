// «Памятка администратора»: разделы и команды, копирование команды, скачивание .md с сообщением об итоге (как в V1 — успех и
// отказ), «Копировать всю памятку»; роли: user2/user4 — 403 и экрана нет (V1: пункт меню только администратору), user3 (admin) — есть.
//   node scripts/audit_set/check_admin_guide.mjs <копия БД> <порт>
import { session, ok, summary, go, click, BASE, as, overflowX } from "./lib.mjs";

const b = await session(BASE, "admin");
await b.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
await go(b, "admin-guide");
await b.waitFor("!!document.querySelector('#ag-download') && document.body.innerText.length > 500", 20000);
const guide = (await (await as("admin")).get("/admin-guide")).data;
ok("памятка показана (разделы с сервера)", await b.eval(`document.body.innerText.includes(${JSON.stringify(String(guide.sections?.[0]?.title || guide[0]?.title || "").slice(0, 30))})`));
await click(b, "#ag-download");
await b.waitFor(`/сохранена|Не удалось/.test(document.querySelector('#ag-status').textContent)`, 10000);
ok("скачивание: «Памятка сохранена в загрузки»", /сохранена в загрузки/.test(await b.eval("document.querySelector('#ag-status').textContent")));
await b.offline(true);
await click(b, "#ag-download");
await b.waitFor(`/Не удалось скачать/.test(document.querySelector('#ag-status').textContent)`, 10000).catch(() => {});
ok("обрыв связи: «Не удалось скачать памятку: …» (раньше ошибка молча терялась)", /Не удалось скачать памятку/.test(await b.eval("document.querySelector('#ag-status').textContent")));
await b.offline(false);
await click(b, "#ag-copy-all"); await b.sleep(500);
ok("«Копировать всю памятку» — итог показан на кнопке", /Скопировано|Буфер обмена недоступен/.test(await b.eval("document.querySelector('#ag-copy-all').textContent")));
for (const [w, h] of [[1920, 1080], [1366, 768]]) { await b.viewport(w, h); await b.sleep(200); ok(`${w}: без горизонтальной прокрутки`, (await overflowX(b)) <= 1); }
ok("записей на сервер нет", !b.requests.some((r) => r.method !== "GET" && !/\/login/.test(r.url)));
await b.close();
for (const who of ["user2", "user4"]) {
  const c = await as(who);
  ok(`${who}: GET /admin-guide → 403`, (await c.get("/admin-guide")).status === 403);
  const bb = await session(BASE, who); await go(bb, "admin-guide");
  ok(`${who}: экрана нет (переход на «Начало»)`, await bb.eval("location.hash==='#/' && !document.querySelector('#ag-download')"));
  await bb.close();
}
const b3 = await session(BASE, "user3"); await go(b3, "admin-guide");
ok("user3 (второй администратор): экран открыт", await b3.waitFor("!!document.querySelector('#ag-download')", 15000).then(() => true, () => false));
await b3.close();
process.exit(summary());
