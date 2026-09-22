// Смена объекта в шапке при медленной фоновой записи «последнего объекта» (PUT /me/last-object): открытый раздел обязан
// перерисоваться под новый объект, а не остаться с данными прежнего под шапкой нового (дефект найден 2026-09-22: счётчик
// «идёт запись» учитывал фоновую запись настройки, и openSection молча отказывался перерисовать раздел).
// Медленная сеть моделируется задержкой ответа именно на этот запрос; объект выбирается настоящими щелчками в окне выбора.
// Запуск: node scripts/shell_verify/object_switch_race.mjs   (порт 8215, копия /Users/max/zhbi-tool/data/zhbi.anon.db)
import { startServer, stopServer, openBrowser, login, check, summary, sleep } from "./lib.mjs";

const PORT = 8215, DIR = "/tmp/zhbi_object_switch_race", DELAY = 3500;
const body = (r) => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };

async function pickObject(b, id) {
  await b.clickSel("#v2-object-btn");
  await b.waitFor(`!!document.querySelector('#v2-objpick-list')`, 8000);
  await sleep(250);
  await b.eval(`document.querySelector('[data-object-id="${id}"]')?.scrollIntoView({block:'center'})`);
  await b.clickSel(`[data-object-id="${id}"]`);
}
const headerObject = (b) => b.eval(`document.getElementById('v2-object-btn')?.textContent || ''`);

// Сценарии: отчёт (POST /reports/status с object_id в теле) и «Контракты» (GET карты контрактов с object_id в адресе).
const SCENARIOS = [
  { screen: "report-status", re: /\/reports\/status$/, objOf: (r) => body(r).object_id },
  { screen: "contracts", re: /\/contracts\/default-map\?/, objOf: (r) => Number(new URL(r.url).searchParams.get("object_id")) },
];

await startServer(PORT, DIR, "/Users/max/zhbi-tool/data/zhbi.anon.db");
try {
  for (const sc of SCENARIOS) {
    const b = await openBrowser(1920, 1080);
    try {
      await login(b, `http://127.0.0.1:${PORT}`, "admin");
      if (!/Объект-1\b/.test(await headerObject(b))) { await pickObject(b, 1); await sleep(1500); }
      await b.eval(`location.hash = "#/${sc.screen}"`);
      for (let i = 0; i < 200 && !b.requests.some((r) => sc.re.test(r.url) && r.status !== undefined && sc.objOf(r) === 1); i++) await sleep(100);
      check(`${sc.screen}: раздел загружен под объект 1`, b.requests.some((r) => sc.re.test(r.url) && sc.objOf(r) === 1));
      await sleep(500);
      // медленная сеть: ответ на фоновую запись «последнего объекта» приходит через DELAY мс
      await b.eval(`(() => { const f = window.fetch; window.fetch = (u, o) => /\\/me\\/last-object$/.test(String(u))
        ? new Promise((r) => setTimeout(r, ${DELAY})).then(() => f(u, o)) : f(u, o); })()`);
      const from = b.requests.length;
      await pickObject(b, 2);
      let reloaded = null;
      for (let i = 0; i < 100 && !reloaded; i++) { await sleep(100); reloaded = b.requests.slice(from).find((r) => sc.re.test(r.url) && r.status !== undefined && sc.objOf(r) === 2); }
      check(`${sc.screen}: шапка показывает объект 2`, /Объект-2\b/.test(await headerObject(b)), await headerObject(b));
      check(`${sc.screen}: раздел перезапросил данные под объект 2, не дожидаясь фоновой записи`, !!reloaded,
        JSON.stringify(b.requests.slice(from).map((r) => [r.method, r.url.replace(/^https?:\/\/[^/]+/, ""), r.status])));
      const stale = b.requests.slice(from).filter((r) => sc.re.test(r.url) && sc.objOf(r) === 1);
      check(`${sc.screen}: после смены объекта запросов под прежний объект нет`, stale.length === 0);
      await sleep(DELAY);
      const once = b.requests.slice(from).filter((r) => sc.re.test(r.url) && sc.objOf(r) === 2).length;
      check(`${sc.screen}: раздел перерисован один раз (без повторной перерисовки после фоновой записи)`, once === 1, `запросов: ${once}`);
      check(`${sc.screen}: нет ошибок JavaScript`, b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
    } finally { await b.close(); }
  }
} finally { await stopServer(); }
process.exit(summary() ? 1 : 0);
