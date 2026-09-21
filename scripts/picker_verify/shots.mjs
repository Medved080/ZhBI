import { startServer, stopServer, openBrowser, login, SP, sleep, hardGoto } from "./lib.mjs";
import { prepareCp, clickBtn, clickSelScrolled } from "./common.mjs";
const S = await startServer(8132, `${SP}/picker_shots`, { setup: prepareCp });
const b = await openBrowser(1920, 1080);
try {
  await login(b, S.base, "admin");
  await hardGoto(b, `${S.base}/v2#/ws-picker`, 1500);
  await b.waitFor(`(document.querySelector('#ws-panel-body')?.innerText||'').includes('В срезе')`, 90000);
  await sleep(1500);
  await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()==='Контракты')?.click()`); await sleep(500);
  await clickSelScrolled(b, '[data-pk-exp="13"]'); await sleep(500);
  await b.shot(`${SP}/picker_shots/ws-contracts.png`);
  await b.eval(`[...document.querySelectorAll('.ws-tabs [data-tab]')].find(x=>x.textContent.trim()==='Отбор')?.click()`); await sleep(500);
  await b.shot(`${SP}/picker_shots/ws-pick.png`);
} finally { await b.close(); await stopServer(); }
