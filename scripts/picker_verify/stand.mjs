// Прогон наборов стенда V2 (scripts/v2_tests, фейковый backend) в безголовом Chrome:
//   node scripts/picker_verify/stand.mjs <порт> <наборы> [--gate all] [--static КАТАЛОГ] [--only id,id] [--minutes N]
import { spawn } from "node:child_process";
import { launch } from "../cdp.mjs";
const argv = process.argv.slice(2);
const [port, suites] = argv;
const rest = argv.slice(2);
const take = (flag) => { const i = rest.indexOf(flag); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
const only = take("--only") || "", minutes = Number(take("--minutes") || 12);
const srv = spawn("python3", [new URL("../v2_test_server.py", import.meta.url).pathname, port, ...rest], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const b = await launch({ width: 1920, height: 1080 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  b.send("Page.navigate", { url: `http://127.0.0.1:${port}/tests/run.html?suite=${suites}${only ? `&only=${only}` : ""}` }).catch(() => {});
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < minutes * 60000) {
    await sleep(5000);
    try { await b.send("Page.handleJavaScriptDialog", { accept: true }); } catch { /* диалога нет */ }
    try { done = await Promise.race([b.eval("window.__done===true"), sleep(4000).then(() => "hang")]); } catch { done = false; }
    if (done === true) break;
  }
  const rows = await Promise.race([b.eval(`[...document.querySelectorAll('#tbl tbody tr')].map(r=>[r.children[0]?.innerText.trim().split(' ')[0], r.children[2]?.innerText.trim(), r.children[3]?.innerText.trim().slice(0,200)])`), sleep(5000).then(() => [])]);
  const bad = rows.filter((r) => r[1] === "FAIL"), gated = rows.filter((r) => r[1] === "GATE");
  console.log(`${done === true ? "завершено" : "НЕ ЗАВЕРШЕНО за " + minutes + " мин"}: строк ${rows.length}, PASS ${rows.filter((r) => r[1] === "PASS").length}, FAIL ${bad.length}, шлюз ${gated.length}`);
  for (const r of bad) console.log("FAIL", r[0], r[2].replace(/\n/g, " | "));
} finally { await b.close(); srv.kill(); }
