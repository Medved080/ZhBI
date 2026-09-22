// Страница «Начало» V2: пометки разделов считаются по статусу реестра (а не по типу реализации) — ни один раздел,
// который V2 строит сам, не помечен «в V1»; подсказка «в V2 · не всё» называет, чего не хватает.
// Запуск: node scripts/shell_verify/home_chips.mjs   (порт 8214, копия /Users/max/zhbi-tool/data/zhbi.anon.db)
import { readFileSync } from "node:fs";
import { startServer, stopServer, openBrowser, login, check, summary, sleep } from "./lib.mjs";

const PORT = 8214, DIR = `/tmp/zhbi_home_chips`;
const reg = JSON.parse(readFileSync(new URL("../../app/static/v2/screens.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(reg.screens.map((s) => [s.id, s]));

await startServer(PORT, DIR, "/Users/max/zhbi-tool/data/zhbi.anon.db");
try {
  for (const user of ["admin", "user4"]) {
    const b = await openBrowser(1920, 1080);   // свой браузер на пользователя: cookie сеанса HttpOnly, из страницы не сбросить
    await login(b, `http://127.0.0.1:${PORT}`, user);
    await b.eval(`location.hash = "#/"`);
    await b.waitFor(`document.querySelectorAll('[data-screen-link]').length > 0`);
    await sleep(300);
    const rows = await b.eval(`[...document.querySelectorAll('.v2-card-list li')].map((li) => ({
      id: li.querySelector('[data-screen-link]').dataset.screenLink,
      chip: li.querySelector('.v2-chip')?.textContent.trim(), title: li.querySelector('.v2-chip')?.title || "" }))`);
    const v1 = rows.filter((r) => r.chip === "в V1");
    check(`${user}: ни один раздел, построенный V2, не помечен «в V1»`, v1.length === 0, JSON.stringify(v1.map((r) => r.id)));
    const wrong = rows.filter((r) => (byId[r.id].status === 5) !== (r.chip === "в V2"));
    check(`${user}: «в V2» ровно у разделов со статусом 5 (${rows.filter((r) => r.chip === "в V2").length} из ${rows.length})`, wrong.length === 0, JSON.stringify(wrong));
    const partial = rows.filter((r) => r.chip === "в V2 · не всё");
    check(`${user}: у «в V2 · не всё» подсказка называет статус (${partial.length} разделов)`, partial.every((r) => r.title.length > 10), JSON.stringify(partial.filter((r) => r.title.length <= 10)));
    for (const id of ["ws-model", "map", "contracts", "supplier-change", "schedule"]) {
      const r = rows.find((x) => x.id === id);
      if (r) check(`${user}: «${byId[id].title}» — «${r.chip}»`, r.chip !== "в V1");
    }
    const intro = await b.eval(`document.querySelector('.v2-home-title + p').textContent.replace(/\\s+/g, " ")`);
    check(`${user}: вводный текст с честными числами`, /в новом интерфейсе работают \d+, из них полностью — \d+/.test(intro), intro);
    check(`${user}: нет ошибок JavaScript`, b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
    await b.close();
  }
} finally { await stopServer(); }
process.exit(summary() ? 1 : 0);
