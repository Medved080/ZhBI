import { session, sql, ok, summary, openSection, click } from "../verify_admin_lib.mjs";
const PORT = process.argv[3] || 8190;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.argv[2];
const ZIP = process.argv[4];

const beforeElements = sql(DB, "select count(*) n from elements")[0].n;
const beforeUsers = sql(DB, "select count(*) n from users")[0].n;

const b = await session(BASE, "admin");
await openSection(b, "db-transfer");
await b.sleep(900);

const currentText = await b.eval(`document.getElementById('dt-current')?.innerText`);
console.log("current panel:", currentText);
ok("панель «Сейчас в этой базе» заполнена", /Сервер/.test(currentText || ""));

const hasExportBtn = await b.eval(`!!document.getElementById('dt-export')`);
ok("кнопка «Выгрузить снимок» есть", hasExportBtn);

// подставить файл в input через CDP (настоящее файловое диалоговое API браузера)
await b.send("DOM.enable", {});
const doc = await b.send("DOM.getDocument", { depth: -1, pierce: true });
const { nodeId } = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#dt-file" });
await b.send("DOM.setFileInputFiles", { files: [ZIP], nodeId });
await b.eval(`document.querySelector('#dt-file').dispatchEvent(new Event('change', {bubbles:true}))`);
await b.sleep(200);

await click(b, "#dt-stage");
await b.sleep(1500);

const compareVisible = await b.eval(`!!document.querySelector('#dt-compare table')`);
ok("таблица сверки появилась", compareVisible);
const compareText = await b.eval(`document.getElementById('dt-compare')?.innerText`);
console.log("compare (первые 400 симв.):", (compareText || "").slice(0, 400));

const confirmEnabled = await b.eval(`!document.getElementById('dt-confirm').disabled`);
ok("поле кодового слова стало доступно", confirmEnabled);

// кодовое слово сервера — "080" (app/db_transfer.py CONFIRM_WORD); вводим его в поле формы
await b.eval(`document.getElementById('dt-confirm').scrollIntoView({block:"center"})`);
await b.sleep(150);
const cf = await b.rect("#dt-confirm");
await b.click(cf.cx, cf.cy);
await b.type("080");
await b.sleep(200);

const applyEnabled = await b.eval(`!document.getElementById('dt-apply').disabled`);
ok("кнопка «Заменить базу целиком» стала доступна", applyEnabled);

await click(b, "#dt-apply");
await b.sleep(500);
const dialogVisible = await b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
ok("диалог подтверждения появился", dialogVisible);
if (dialogVisible) {
  const input = await b.rect("#ty-input");
  await b.click(input.cx, input.cy);
  await b.type("ЗАМЕНИТЬ");
  await click(b, '[data-choice="confirm"]');
}
let statusText = "";
for (let i = 0; i < 20; i++) {
  await b.sleep(300);
  statusText = await b.eval(`document.getElementById('dt-status')?.innerText || ''`).catch(() => "");
  if (/База заменена|Замена не выполнена/.test(statusText)) break;
}
console.log("apply status:", statusText);
ok("статус сообщает о замене базы", /База заменена/.test(statusText || ""));
ok("статус упоминает служебную копию", /Копия прежнего состояния/.test(statusText || ""));

const afterElements = sql(DB, "select count(*) n from elements")[0].n;
const afterUsers = sql(DB, "select count(*) n from users")[0].n;
ok("SQL: число изделий после замены совпало с исходным (снимок своей же базы)", afterElements === beforeElements);
ok("SQL: число пользователей совпало", afterUsers === beforeUsers);

const backupRow = sql(DB, "select 1 x from app_settings limit 1"); // просто проверка, что таблицы читаемы
ok("SQL: база после замены читаема", backupRow !== undefined);

await b.close();
process.exit(summary());
