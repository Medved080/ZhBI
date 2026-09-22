// «Адресный классификатор»: два независимых флага «дома», как в V1 (распаковка/скачивание — «С домами»; загрузка регионов в базу —
// «Загружать дома в базу»). Синтетический мини-классификатор scripts/admin2_verify/kladr_synth (2 региона). Настоящий backend,
// вход формой, настоящий выбор файла (DOM.setFileInputFiles) и щелчки. Файлы data/kladr и data/addr.db этого каталога удаляются.
//   node scripts/audit_set/check_address.mjs <копия БД> <порт>
import { session, ok, summary, go, click, BASE, as, onBail } from "./lib.mjs";
import { rmSync, existsSync } from "node:fs";

const hadKladr = existsSync("data/kladr"), hadAddr = existsSync("data/addr.db");
const cleanup = () => { if (!hadKladr) rmSync("data/kladr", { recursive: true, force: true }); if (!hadAddr) { for (const f of ["data/addr.db", "data/addr.db-wal", "data/addr.db-shm"]) rmSync(f, { force: true }); } };
onBail(async () => cleanup());

const b = await session(BASE, "admin");
await go(b, "address-classifier");
await b.waitFor("!!document.querySelector('#ac-file')", 20000);
ok("два флага: «С домами» и «Загружать дома в базу», оба включены по умолчанию (как в V1)", await b.eval("document.querySelector('#ac-houses').checked && document.querySelector('#ac-load-houses').checked"));
const { root } = await b.send("DOM.getDocument", { depth: 0 });
for (const f of ["KLADR.DBF", "SOCRBASE.DBF"]) {
  const { nodeId } = await b.send("DOM.querySelector", { nodeId: (await b.send("DOM.getDocument", { depth: 0 })).root.nodeId, selector: "#ac-file" });
  await b.send("DOM.setFileInputFiles", { nodeId, files: [`${process.cwd()}/scripts/admin2_verify/kladr_synth/${f}`] });
  await b.eval("document.querySelector('#ac-file').dispatchEvent(new Event('change',{bubbles:true}))");
  await click(b, "#ac-upload");
  await b.waitFor(`/загружен/i.test(document.querySelector('#ac-status')?.innerText||'')`, 20000);
  await b.sleep(500);
}
void root;
await b.waitFor("!!document.querySelector('[data-region]')", 20000);
// «Загружать дома в базу» — снять; «С домами» остаётся включённым
await click(b, "#ac-load-houses");
ok("флаги независимы: «С домами» включён, «Загружать дома» снят", await b.eval("document.querySelector('#ac-houses').checked && !document.querySelector('#ac-load-houses').checked"));
const r = await b.rect("[data-region]"); await b.click(r.cx, r.cy); await b.sleep(200);
const n0 = b.requests.length;
const lb = await b.rect("#ac-load"); await b.click(lb.cx, lb.cy, { count: 2 });
let done = false;
for (let i = 0; i < 40 && !done; i++) { await b.sleep(400); done = /Готово/.test(await b.eval("document.querySelector('#ac-status')?.innerText||''")); }
const loads = b.requests.slice(n0).filter((x) => x.method === "POST" && /\/address\/load$/.test(x.url));
ok("двойной щелчок «Загрузить отмеченные» — один запрос", loads.length === 1, String(loads.length));
ok("тело загрузки: houses=false (флаг «Загружать дома в базу»)", loads[0] && JSON.parse(loads[0].body).houses === false, loads[0]?.body);
ok("загрузка региона завершилась («Готово»)", done);
// ограниченная роль: запись в классификатор — 403 (address_load — только администратор сервиса)
const u4 = await as("user4"), u2 = await as("user2");
ok("user4: POST /address/load → 403", (await u4.post("/address/load", { regions: ["01"], houses: false })).status === 403);
ok("user2: POST /address/load → 403", (await u2.post("/address/load", { regions: ["01"], houses: false })).status === 403);
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 200));
await b.close();
cleanup();
ok("служебные файлы классификатора удалены", hadKladr || !existsSync("data/kladr"));
process.exit(summary());
