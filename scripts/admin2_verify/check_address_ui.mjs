import { session, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const KLADR_FILE = process.argv[2];

const b = await session(BASE, "admin");
await openSection(b, "address-classifier");
await b.sleep(900);

const hasStatus = await b.eval(`document.getElementById('ac-body')?.innerText.includes('Каталог файлов')`);
ok("состояние классификатора показано", hasStatus);

// загрузка KLADR.DBF через настоящий input[type=file]
await b.send("DOM.enable", {});
const doc = await b.send("DOM.getDocument", { depth: -1, pierce: true });
const { nodeId } = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#ac-file" });
await b.send("DOM.setFileInputFiles", { files: [KLADR_FILE], nodeId });
await b.eval(`document.querySelector('#ac-file').dispatchEvent(new Event('change', {bubbles:true}))`);
await click(b, "#ac-upload");
await b.sleep(1200);

const statusText = await b.eval(`document.getElementById('ac-status')?.innerText`);
console.log("upload status:", statusText);
ok("файл загружен (сообщение)", /загружен/i.test(statusText || ""));

const filesListed = await b.eval(`document.getElementById('ac-body')?.innerText.includes('KLADR.DBF')`);
ok("KLADR.DBF появился в списке файлов", filesListed);

await b.sleep(800);
const regionsText = await b.eval(`document.getElementById('ac-regions')?.innerText`);
console.log("regions:", regionsText);
ok("регион «Тестовая» показан", /Тестовая/.test(regionsText || ""));

const checkbox = await b.eval(`!!document.querySelector('[data-region]')`);
ok("нашли чекбокс региона", checkbox);
if (checkbox) {
  const already = await b.eval(`document.querySelector('[data-region]').checked`);
  if (!already) {
    const r = await b.rect("[data-region]");
    await b.click(r.cx, r.cy);
    await b.sleep(200);
  }
  const loadEnabled = await b.eval(`!document.getElementById('ac-load').disabled`);
  ok("кнопка «Загрузить отмеченные» стала доступна", loadEnabled);
  await click(b, "#ac-load");
  // опрос прогресса — ждём завершения (регион крошечный, доли секунды)
  let done = false;
  for (let i = 0; i < 20; i++) {
    await b.sleep(400);
    const s = await b.eval(`document.getElementById('ac-status')?.innerText`);
    if (/Готово/.test(s || "")) { done = true; break; }
  }
  ok("загрузка региона завершилась («Готово»)", done);
  const loadedText = await b.eval(`document.getElementById('ac-body')?.innerText`);
  ok("состояние показывает загруженный регион «Тестовая»", /Тестовая/.test(loadedText || "") && /Загруженные регионы|Регион/.test(loadedText || ""));
}

// user4 (view) не должен видеть форму загрузки
const b4 = await session(BASE, "user4");
await openSection(b4, "address-classifier");
await b4.sleep(700);
const hasUploadBtn4 = await b4.eval(`!!document.getElementById('ac-upload')`);
ok("user4 (view) не видит форму загрузки (нет права address_load write)", !hasUploadBtn4);

await b.close(); await b4.close();
process.exit(summary());
