// Браузерная проверка экрана «Загрузить из PDF» (pdf-import) — детальный разбор (фоновая задача с прогрессом),
// «только фасады» (синхронно) и отладочная очистка справочников. Настоящий backend, настоящие клики.
import { execFileSync } from "node:child_process";
import { open, screen, setFile, text, reload, clk, EX, SP, sql, maxid, journal, chk, summary } from "./hx.mjs";

const OBJ = 3; // объект МФР копии без данных раздела PDF (есть только АР/КР из Revit — не пересекается)
const small = EX + "/small.pdf";
const noRooms = EX + "/no_rooms.pdf";

const b = await open("admin");
// «pdf_import» помечен not_applicable у объектов не-МФР (screenAllowed скрывает раздел даже админу) — сперва выбрать
// объект МФР в ШАПКЕ (как chk_revit.mjs), только потом открыть экран.
const setHeaderObj = async (v) => { await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value=${JSON.stringify(String(v))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1200); };
await setHeaderObj(OBJ);
await screen(b, "pdf-import");
const st = () => text(b, "#pf-status");
const dialog = () => b.eval(`(()=>{const d=document.querySelector('.v2-dialog');return d?d.innerText:null})()`);
const setObj = async (v) => b.eval(`(()=>{const s=document.querySelector('#pf-object');s.value=${JSON.stringify(String(v))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await setObj(OBJ);

console.log("== клиентская проверка (без файла)");
await clk(b, "#pf-go"); await b.sleep(300);
chk((await st()).includes("выберите файл"), "без файла: " + (await st()));

console.log("== файл без слоя помещений: фоновая задача завершается ошибкой понятным текстом");
await setFile(b, "#pf-file", noRooms);
await clk(b, "#pf-go");
await b.waitFor(`document.querySelector('#pf-status').className.includes('bad')`, 30000);
chk(/помещени/i.test(await st()), "no_rooms: ошибка текстом сервера — " + (await st()));

console.log("== полный разбор: прогресс, сводка, применение");
await setFile(b, "#pf-file", small);
await clk(b, "#pf-go");
await b.waitFor(`document.querySelector('#pf-progress').style.display !== 'none'`, 5000);
chk(true, "полоса прогресса показана во время фонового разбора");
await b.waitFor(`document.querySelector('#pf-review').innerText.length > 0`, 40000);
const rev1 = await text(b, "#pf-review");
chk(/Помещени/i.test(rev1) && /Новых помещений/i.test(rev1), "сводка показана: " + rev1.replace(/\n/g, " ").slice(0, 200));
chk(await b.eval(`!!document.querySelector('#pf-apply')`), "кнопка «Применить» есть");

const j0 = maxid();
await clk(b, "#pf-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg1 = await dialog();
chk(/Применить помещения/i.test(dlg1), "диалог подтверждения называет последствия: " + dlg1.slice(0, 160));
await b.shot(SP + "/exchange_work/s_pdf_confirm.png");
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#pf-status').className.includes('ok')`, 20000);
chk((await st()).includes("помещений"), "применение: результат показан — " + (await st()));
await b.shot(SP + "/exchange_work/s_pdf_result.png");
chk(sql(`select count(*) n from revit_elements where object_id=${OBJ} and section_code='PDF' and category='Помещение' and is_current=1`)[0].n > 0, "в БД появились текущие помещения раздела PDF");
const ev1 = journal("import_pdf", j0);
chk(ev1.length === 1, `в журнале одно событие import_pdf (найдено ${ev1.length})`);

console.log("== после перезагрузки страницы сводка не висит, данные на месте, V1 открывается");
await reload(b, "#/pdf-import"); await setHeaderObj(OBJ);
chk((await b.eval(`document.querySelector('#pf-review').innerHTML`)) === "", "после перезагрузки — сводка пуста (применённое не висит)");
await b.goto(`http://127.0.0.1:${process.env.V2_EX_PORT || 8150}/?ui=v1`);
await b.sleep(2500);
chk(!b.exceptions.length, "V1 открылся без исключений после операции V2");

console.log("== «только фасады»: разбор синхронный, применение");
await reload(b, "#/pdf-import"); await setHeaderObj(OBJ);
await setObj(OBJ);
await b.eval(`document.querySelector('input[name="pf-mode"][value="facade"]').click()`);
await setFile(b, "#pf-file", small);
const j1 = maxid();
await clk(b, "#pf-go");
await b.waitFor(`document.querySelector('#pf-review').innerText.length > 0`, 15000);
const rev2 = await text(b, "#pf-review");
chk(/Блоков в файле/i.test(rev2), "сводка «только фасады» показана: " + rev2.replace(/\n/g, " ").slice(0, 160));
await clk(b, "#pf-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg2 = await dialog();
chk(/макет блоков/i.test(dlg2), "диалог «только фасады» называет последствия: " + dlg2.slice(0, 160));
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#pf-status').className.includes('ok')`, 15000);
chk((await st()).includes("блоков"), "применение «только фасады»: результат показан — " + (await st()));
const ev2 = journal("import_pdf_facade", j1);
chk(ev2.length === 1, `в журнале одно событие import_pdf_facade (найдено ${ev2.length})`);

console.log("== отладочная очистка справочников: подтверждение, результат");
await reload(b, "#/pdf-import"); await setHeaderObj(OBJ);
await setObj(OBJ);
await b.eval(`document.querySelector('#pf-clear-details').open = true`);
await clk(b, "#pf-clear-elements");
const j2 = maxid();
await clk(b, "#pf-clear-go");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg3 = await dialog();
chk(/необратимо/i.test(dlg3), "диалог очистки предупреждает о необратимости: " + dlg3.slice(0, 160));
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#pf-clear-status').innerText.includes('Готово') || document.querySelector('#pf-clear-status').innerText.includes('Не удалось')`, 15000);
chk((await text(b, "#pf-clear-status")).includes("Готово"), "очистка: результат показан — " + (await text(b, "#pf-clear-status")));
chk(sql(`select count(*) n from revit_elements where object_id=${OBJ} and section_code='PDF' and category='Помещение' and is_current=1`)[0].n === 0, "в БД не осталось текущих помещений раздела PDF");
await b.sleep(1800); // очередь журнала пишется пачками раз в секунду
chk(journal("clear_import_data", j2).length === 1, "в журнале одно событие clear_import_data");

console.log("== права: user2/user4 получают 403 при настоящей попытке разбора");
const PY = process.env.V2_EX_PY || ".venv/bin/python";
for (const user of ["user2", "user4"]) {
  const out = execFileSync(PY, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE = "http://127.0.0.1:${process.env.V2_EX_PORT || 8150}"
s = requests.Session(); s.post(BASE + "/login", json={"domain_login": "${user}", "password": "Test-Pass-1234!"})
with open("${small}", "rb") as f:
    r = s.post(BASE + "/import-pdf/analyze/start", files={"file": ("small.pdf", f, "application/pdf")}, data={"object_id": "${OBJ}"})
print(r.status_code)
`], { encoding: "utf8" }).trim();
  chk(out === "403", `${user}: настоящий запрос POST /import-pdf/analyze/start → 403 (получен ${out})`);
}

summary();
await b.close();
