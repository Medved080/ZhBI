import { openBrowser, login, SP, sleep, startServer, stopServer } from "./lib.mjs";
const S = await startServer(8130, `${SP}/picker_work`);
const b = await openBrowser(1920, 1080);
try {
  await login(b, S.base, process.argv[2] || "admin");
  for (const hash of ["#/supplier-change", "#/counterparties"]) {
    await b.goto(`${S.base}/v2${hash}`, 1500);
    console.log(hash, "=>", (await b.eval("document.querySelector('#v2-content')?.innerText.slice(0,500)")).replace(/\n+/g, " | "));
    await b.shot(`${SP}/picker_work/${hash.slice(2)}.png`);
  }
  console.log("exceptions", b.exceptions, "console errors", b.consoleLog.filter((c) => c.type === "error").slice(0, 5));
} finally { await b.close(); await stopServer(); }
