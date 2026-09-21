import { openBrowser, login, SP, sleep } from "./lib.mjs";
const base = "http://127.0.0.1:8130";
const b = await openBrowser(1920, 1080);
await login(b, base, process.argv[2] || "admin");
await b.goto(`${base}/v2#/counterparties`, 1500);
console.log(await b.eval("document.querySelector('#v2-content')?.innerText.slice(0,600)"));
await b.shot(`${SP}/picker_work/cp.png`);
console.log("exceptions", b.exceptions);
await b.close();
