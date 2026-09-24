// Проверка навигации зон V2 и понятного добавления стоянки на ВРЕМЕННОЙ копии обезличенной БД.
// Публикацию не вызывает; рабочий сервер 8000 и его данные не меняет.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, check, summary, noPageScroll } from "./audit_work/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-zone-tabs-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  for (const [width, height] of [[1366, 768], [1920, 1080]]) {
    browser = await session(base, "admin", { objectId: 1, width, height });
    await openScreen(browser, "zones", "!!document.querySelector('[data-cat=Захватка]')");
    const before = await browser.rect(".ze-tabs");
    const pageBefore = await browser.rect(".v2-screen");
    await tap(browser, '[data-cat="Кран"]');
    await browser.waitFor("!!document.querySelector('#cz-canvas')");
    const crane = await browser.rect(".ze-tabs");
    const pageCrane = await browser.rect(".v2-screen");
    check(`${width}: вкладки и ширина формы неподвижны при переходе к кранам`,
      Math.abs(before.y - crane.y) <= 1 && Math.abs(pageBefore.x - pageCrane.x) <= 1 && Math.abs(pageBefore.w - pageCrane.w) <= 1,
      `${JSON.stringify({ before, crane, pageBefore, pageCrane })}`);
    check(`${width}: зона крана названа отдельно`, await browser.eval("document.querySelector('.cz-toolbar strong')?.textContent === 'Зоны кранов'"));
    check(`${width}: в зонах кранов нет стоянок и команды их добавления`, await browser.eval("!document.querySelector('.cz-tree-item.cz-stand') && !document.querySelector('#cz-add-stand') && document.querySelector('.cz-prop-head span')?.textContent === 'Кран'"));
    if (process.env.ZONES_SHOTS) await browser.shot(join(process.env.ZONES_SHOTS, `cranes-${width}.png`));
    await tap(browser, '[data-cat="Стоянка"]');
    await browser.waitFor("document.querySelector('.cz-toolbar strong')?.textContent === 'Стоянки кранов'");
    const stand = await browser.rect(".ze-tabs");
    const pageStand = await browser.rect(".v2-screen");
    check(`${width}: вкладки и ширина формы неподвижны при переходе к стоянкам`,
      Math.abs(before.y - stand.y) <= 1 && Math.abs(pageBefore.x - pageStand.x) <= 1 && Math.abs(pageBefore.w - pageStand.w) <= 1);
    check(`${width}: объяснены вложенность и действие`, await browser.eval("document.querySelector('#ze-context')?.textContent.includes('внутри выбранного крана') && document.querySelector('.cz-tree-intro')?.textContent.includes('Выберите кран')"));
    check(`${width}: стоянки видны только в своём разделе`, await browser.eval("!!document.querySelector('.cz-tree-item.cz-stand') && !document.querySelector('#cz-add-crane') && document.querySelector('.cz-prop-head span')?.textContent === 'Стоянка'"));
    const add = await browser.rect("#cz-add-stand");
    check(`${width}: добавление стоянки видно без прокрутки`, !!add && add.y >= 0 && add.y + add.h <= height && await browser.eval("!document.querySelector('#cz-add-stand').disabled"));
    check(`${width}: нет прокрутки страницы`, await noPageScroll(browser));
    if (process.env.ZONES_SHOTS) await browser.shot(join(process.env.ZONES_SHOTS, `stands-${width}.png`));
    if (width === 1366) {
      const craneIds = await browser.eval("[...document.querySelectorAll('.cz-tree-item:not(.cz-stand)')].map((el) => el.dataset.zoneId)");
      check("для проверки доступны несколько кранов", craneIds.length > 1);
      await tap(browser, `.cz-tree-item[data-zone-id="${craneIds[1]}"]`);
      const from = browser.requests.length;
      await tap(browser, "#cz-add-stand");
      await browser.waitFor("document.querySelector('#cz-name')?.value.startsWith('Стоянка ') && !document.querySelector('#cz-save')?.disabled", 20000);
      check("Стоянка добавлена в новый черновик и выбрана для редактирования", await browser.eval("document.querySelector('.cz-prop-head span')?.textContent === 'Стоянка' && document.querySelector('#cz-status')?.textContent.includes('добавлена в черновик')"));
      check("новая стоянка принадлежит выбранному крану", await browser.eval(`document.querySelector('#cz-parent')?.value === '${craneIds[1]}'`));
      const writes = browser.requests.slice(from).filter((r) => ["POST", "PATCH", "PUT", "DELETE"].includes(r.method));
      check("до сохранения ушёл лишь запрос на создание черновика", writes.length === 1 && /\/crane-zone-versions\/drafts$/.test(writes[0].url), JSON.stringify(writes.map((r) => `${r.method} ${r.url} ${r.status}`)));
      await tap(browser, "#cz-save");
      await browser.waitFor("document.querySelector('#cz-status')?.textContent.includes('сохранён') || document.querySelector('#cz-status')?.textContent.includes('вне зоны')", 20000);
      check("новая стоянка сохраняется в черновике", await browser.eval("document.querySelector('#cz-status')?.textContent.includes('сохранён')"), await browser.eval("document.querySelector('#cz-status')?.textContent"));
    }
    await browser.close(); browser = null;
  }
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await browser.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-zones-crane`, 1000);
  await browser.waitFor("document.querySelector('.cz-v1-modal .cz-root') && document.querySelector('.cz-v1-modal .cz-tree-item')", 30000);
  check("V1: раздел кранов показывает только краны", await browser.eval("document.querySelector('.cz-v1-head strong')?.textContent === 'Зоны кранов' && !document.querySelector('.cz-v1-modal .cz-stand') && !document.querySelector('.cz-v1-modal #cz-add-stand')"));
  await browser.goto(`${base}/?ui=v1&object_id=1&open=menu&item=menu-zones-stance`, 1000);
  await browser.waitFor("document.querySelector('.cz-v1-modal .cz-stand')", 30000);
  check("V1: стоянки открываются отдельно", await browser.eval("document.querySelector('.cz-v1-head strong')?.textContent === 'Стоянки кранов' && !!document.querySelector('.cz-v1-modal #cz-add-stand')"));
  await browser.close(); browser = null;
  if (summary("Зоны V2") !== 0) process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
}
