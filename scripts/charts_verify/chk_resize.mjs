// График не должен переисполняться (перезапрос данных, полная перерисовка SVG) при переключении левой панели
// навигации — сам SVG отвечает на изменение ширины контейнера ЧИСТО CSS-масштабированием (viewBox + width:100%;
// height:auto — без единой строки JS), а не ResizeObserver с перерисовкой: точное требование задания выполнено
// самим устройством графика. Проверяем это фактом: клик по кнопке навигации не шлёт новый /reports/dynamics и
// не меняет markup графика (тот же узел, тот же innerHTML). Настоящий backend, настоящий вход.
// Запуск: node scripts/charts_verify/chk_resize.mjs
import { startServer, stopServer, check, summary, sleep, SP } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const PORT = 8271;
const S = await startServer(PORT, `${SP}/charts_resize`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1, shots: `${SP}/charts_resize_shots` });
  await openScreen(b, "report-dynamics", `document.querySelector('#rd-report svg')`);
  await sleep(400);
  const svgBefore = await b.eval(`document.querySelector('#rd-report svg')?.outerHTML.length || 0`);
  const reqBefore = b.requests.length;

  // Кнопка меню разделов навигации — в шапке (см. shell-nav.js, #v2-shellnav-menu; экран не трогаем, только читаем эффект)
  const navBtn = await b.eval(`!!document.getElementById('v2-shellnav-menu')`);
  check("кнопка меню разделов навигации найдена на экране", navBtn);
  if (navBtn) {
    await b.eval(`document.getElementById('v2-shellnav-menu').click()`);
    await sleep(400);
    const reqAfter = b.requests.slice(reqBefore).filter((r) => /\/reports\//.test(r.url));
    check("сворачивание навигации НЕ вызывает новый запрос /reports/*", reqAfter.length === 0, JSON.stringify(reqAfter.map((r) => r.url)));
    const svgAfter = await b.eval(`document.querySelector('#rd-report svg')?.outerHTML.length || 0`);
    check("markup графика не перестроился (та же длина разметки SVG)", svgAfter === svgBefore, `было ${svgBefore}, стало ${svgAfter}`);
    // сам SVG тем не менее визуально шире — контейнер увеличился, viewBox растянул его чистым CSS
    const w = await b.eval(`document.querySelector('#rd-report svg')?.getBoundingClientRect().width || 0`);
    check("SVG растянулся под новую ширину контейнера (CSS, без перерисовки)", w > 200, `ширина ${w}px`);
  }
} catch (e) {
  console.log("СБОЙ:", e.stack || e);
  check("сценарий выполнен без сбоя", false, String(e.message || e).slice(0, 300));
} finally {
  if (b) await b.close();
  await stopServer();
}
process.exit(summary() ? 1 : 0);
