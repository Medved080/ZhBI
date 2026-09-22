// Плашка статуса у заголовка экрана V2 (registry.js statusChip): «рабочий и проверенный» — зелёная (v2-chip-ok), остальные —
// предупреждение. Обход ВСЕХ экранов, доступных администратору, по хешу: у каждого экрана с плашкой класс соответствует статусу
// реестра, подпись — STATUS_LABEL; ни на одном экране нет ошибок JavaScript при монтировании (проверка механической замены в
// 29 модулях). Запуск: node scripts/shell_verify/status_chip.mjs   (порт 8216, копия /Users/max/zhbi-tool/data/zhbi.anon.db)
import { readFileSync } from "node:fs";
import { startServer, stopServer, openBrowser, login, check, summary, sleep } from "./lib.mjs";

const reg = JSON.parse(readFileSync(new URL("../../app/static/v2/screens.json", import.meta.url), "utf8"));
const LABEL = { 3: "чтение подключено", 4: "операции подключены, проверка не завершена", 5: "рабочий и проверенный" };
await startServer(8216, "/tmp/zhbi_status_chip", "/Users/max/zhbi-tool/data/zhbi.anon.db");
const b = await openBrowser(1920, 1080);
try {
  await login(b, "http://127.0.0.1:8216", "admin");
  let withChip = 0, green = 0, bad = [], errs = [];
  for (const s of reg.screens.filter((x) => x.group !== "home")) {
    const exBefore = b.exceptions.length;
    await b.eval(`location.hash = "#/${s.id}"`);
    await sleep(900);
    const r = await b.eval(`(() => { if (location.hash !== "#/${s.id}") return { skipped: true };
      const c = document.querySelector('#v2-content .v2-chip[title="Статус реализации в реестре охвата"]');
      return c ? { ok: c.classList.contains('v2-chip-ok'), warn: c.classList.contains('v2-chip-warn'), text: c.textContent.trim() } : { none: true }; })()`);
    if (b.exceptions.length > exBefore) errs.push(`${s.id}: ${b.exceptions.slice(exBefore).join(" | ").slice(0, 200)}`);
    if (r.skipped || r.none) continue;
    withChip++; if (r.ok) green++;
    const want5 = s.status === 5;
    if (r.ok !== want5 || r.warn === want5 || (LABEL[s.status] && r.text !== LABEL[s.status])) bad.push(`${s.id} (статус ${s.status}): ${JSON.stringify(r)}`);
  }
  check(`плашка у ${withChip} экранов; зелёная ровно у статуса 5 (${green}), подпись — из реестра`, withChip > 20 && bad.length === 0, bad.slice(0, 5).join("; "));
  check("ни на одном экране нет ошибок JavaScript при открытии", errs.length === 0, errs.slice(0, 3).join("; "));
  await b.eval(`location.hash = "#/appearance"`); await sleep(900);
  check("«Внешний вид» (статус 4) — плашка-предупреждение", await b.eval(`document.querySelector('#v2-content .v2-chip[title="Статус реализации в реестре охвата"]')?.classList.contains('v2-chip-warn') === true`));
} finally { await b.close(); await stopServer(); }
process.exit(summary() ? 1 : 0);
