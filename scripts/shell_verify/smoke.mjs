// Быстрый ручной прогон при разработке (не итоговый набор проверок) — открыть /v2, войти, посмотреть на консоль
// и структуру навигации. Запуск: node scripts/shell_verify/smoke.mjs <порт>
import { openBrowser, login, sleep } from "./lib.mjs";

const port = process.argv[2] || 8210;
const base = `http://127.0.0.1:${port}`;
const b = await openBrowser(1920, 1080);
try {
  await login(b, base, "admin");
  await sleep(500);
  console.log("errors:", b.exceptions);
  const info = await b.eval(`(() => {
    const side = document.querySelector('#v2-side');
    return {
      mode: side?.dataset.mode,
      objBtnText: document.querySelector('#v2-object-btn')?.innerText,
      headTitle: document.querySelector('.v2-head-title')?.innerText,
      stripBtns: [...document.querySelectorAll('.v2-shellnav-strip button')].map(b=>b.getAttribute('aria-label')||b.dataset.tooltip),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await b.shot("data/shell_check/smoke1.png");
} finally {
  await b.close();
}
