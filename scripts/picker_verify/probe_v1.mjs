import { startServer, stopServer, openBrowser, login, SP, sleep, hardGoto } from "./lib.mjs";
import { prepareCopy } from "./common.mjs";
const S = await startServer(8132, `${SP}/picker_probe`, { setup: prepareCopy });
const b = await openBrowser(1920, 1080);
try {
  await login(b, S.base, "admin");
  await hardGoto(b, `${S.base}/?ui=v1&object_id=1&open=menu&item=menu-supplier-change`, 3500);
  await sleep(25000);
  console.log(await b.eval(`(()=>{const m=document.getElementById('supplier-change-backdrop');return JSON.stringify({open:m?.classList.contains('open'),disp:getComputedStyle(m).display,len:m?.innerText.length,txt:m?.innerText.slice(0,600)})})()`));
  await b.shot(`${SP}/picker_probe/v1.png`);
} finally { await b.close(); await stopServer(); }
