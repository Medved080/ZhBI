// «Массовая правка через Excel» в V2: четвёртый режим «⚠ Перенос базы», как в V1 (2026-09-28). Временная копия обезличенной
// БД; снимок для сверки — архив build_archive с той же копии (путь в BULK_TRANSFER_ZIP). Замена базы НЕ выполняется:
// проверяются вид режима, сверка снимка, доступность кодового слова и снятие снимка из очереди при уходе из режима.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, session, openScreen, tap, check, summary, sleep } from "./audit_work/lib.mjs";

const ZIP = process.env.BULK_TRANSFER_ZIP;
if (!ZIP) throw new Error("Укажите BULK_TRANSFER_ZIP — архив снимка базы");
const work = mkdtempSync(join(tmpdir(), "bulk-transfer-"));
let browser;
try {
  const { base } = await startServer(8378, work);
  browser = await session(base, "admin", { objectId: 1, width: 1366, height: 768 });
  await openScreen(browser, "bulk-edit", "!!document.querySelector('#bk-modes')");
  check("Кнопка режима «⚠ Перенос базы» рядом с режимами правки", await browser.eval(
    "document.querySelector('#bk-transfer-mode')?.textContent === '⚠ Перенос базы' && !document.querySelector('#bk-modes #bk-transfer-mode')"));
  check("Прежняя отсылка в интерфейс V1 убрана", await browser.eval("!document.body.innerText.includes('в интерфейсе V2 не выполняется')"));
  await tap(browser, "#bk-transfer-mode");
  await browser.waitFor("/Сервер/.test(document.querySelector('#dt-current')?.innerText || '')", 15000);
  check("Режим показывает три шага и состояние этой базы, шаги Excel скрыты", await browser.eval(`(() => {
    const t = document.querySelector('#bk-transfer');
    return !t.hidden && document.querySelector('#bk-excel').hidden && t.querySelectorAll('section h3').length === 4
      && !!t.querySelector('#dt-export') && !t.querySelector('.v2-crumbs') && t.innerText.includes('На боевом сервере загружать снимок нельзя');
  })()`));
  check("Кнопка режима выделена", await browser.eval("document.querySelector('#bk-transfer-mode').getAttribute('aria-pressed') === 'true'"));
  // Сверка снимка: файл подставляется через DevTools, как настоящий выбор файла.
  await browser.send("DOM.enable", {});
  const doc = await browser.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await browser.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#dt-file" });
  await browser.send("DOM.setFileInputFiles", { files: [ZIP], nodeId });
  await browser.eval("document.querySelector('#dt-file').dispatchEvent(new Event('change', { bubbles: true }))");
  await tap(browser, "#dt-stage");
  await browser.waitFor("!!document.querySelector('#dt-compare table')", 120000);
  check("Сверка снимка показывает таблицу «сейчас / приедет»", await browser.eval("document.querySelector('#dt-compare').innerText.includes('Приедет из снимка')"));
  check("После сверки доступно поле кодового слова, замена — только после ввода", await browser.eval(
    "!document.querySelector('#dt-confirm').disabled && document.querySelector('#dt-apply').disabled"));
  // Уход в «Реквизиты»: снимок убирается из очереди, шаги Excel возвращаются.
  const forgetBefore = browser.requests.filter((r) => /\/admin\/db-transfer\/forget$/.test(r.url)).length;
  await tap(browser, '#bk-modes [data-mode="fields"]');
  await browser.waitFor("!document.querySelector('#bk-excel').hidden", 10000);
  await sleep(500);
  check("Переход в «Реквизиты» убирает снимок из очереди и возвращает шаги Excel", browser.requests.filter((r) => /\/admin\/db-transfer\/forget$/.test(r.url)).length === forgetBefore + 1
    && await browser.eval("document.querySelector('#bk-transfer').hidden && document.querySelector('#bk-transfer-mode').getAttribute('aria-pressed') === 'false' && document.querySelector('#bk-modes [data-mode=fields]').getAttribute('aria-pressed') === 'true'"));
  check("Замена базы не вызывалась", !browser.requests.some((r) => /\/admin\/db-transfer\/apply$/.test(r.url)));
  if (process.env.BULK_SHOT) { await tap(browser, "#bk-transfer-mode"); await browser.waitFor("/Сервер/.test(document.querySelector('#dt-current')?.innerText || '')", 15000); await browser.shot(process.env.BULK_SHOT); }
  check("Нет ошибок JavaScript", browser.exceptions.length === 0, browser.exceptions.join("\n"));
} finally {
  await browser?.close();
  await stopServer();
}
process.exitCode = summary("Перенос базы в массовой правке V2") ? 1 : 0;
