import { clk, open, screen, setFile, text, reload, mkxlsx, TAG, EX, SP, snap, sql, maxid, journal, chk, summary, posts } from "./hx.mjs";
import { execFileSync } from "node:child_process";
const PYX = "python3";
execFileSync("bash", ["-c", `cp ${EX}/d1/plan_v2.dxf ${EX}/d1/plan_${TAG}.dxf && cp ${EX}/d2/plan_v2.dxf ${EX}/d2/plan_${TAG}.dxf`]);
const P1 = EX + `/d1/plan_${TAG}.dxf`, P2 = EX + `/d2/plan_${TAG}.dxf`, PNAME = `plan_${TAG}.dxf`;
const b = await open("admin");
const dlg = () => b.eval(`(()=>{const d=document.querySelector('.v2-dialog');return d?d.innerText:null})()`);
const confirmDlg = async () => { await b.waitFor(`document.querySelector('.v2-dialog')`, 5000); const t = await dlg(); await b.clickSel('[data-choice="confirm"]'); return t; };
const st = () => text(b, "#dr-status");
const sel = (v) => b.eval(`(()=>{const s=document.querySelector('#dr-object');s.value=${JSON.stringify(String(v))};s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()`);
// свежий объект под чертёж
const OH = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"];
const NAME = `Тест-В2 чертёж браузер ${TAG}`;
mkxlsx("dr_obj.xlsx", OH, [[NAME, null, null, null, null, "Активный", null, null, null, null]], "Объекты на карте");
console.log(execFileSync(PYX, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE="http://127.0.0.1:8150"
s=requests.Session(); s.post(BASE+"/login",json={"domain_login":"admin","password":"Test-Pass-1234!"})
a=s.post(BASE+"/objects-import/analyze",files={"file":("f.xlsx",open("${EX}/dr_obj.xlsx","rb").read())}).json()
print(s.post(BASE+"/objects-import/apply",json={"changes":a["changes"]}).text[:60])
`], { encoding: "utf8" }).trim());
const OID = sql(`select id from objects where name='${NAME}'`)[0].id;
await reload(b, "#/upload-drawing");
await sel(OID);
console.log("== клиентская проверка файла");
await b.clickSel("#dr-analyze"); await b.sleep(300);
chk((await st()).includes("Сначала выберите файл"), "без файла: " + (await st()));
await setFile(b, "#dr-file", EX + "/note.txt"); await b.clickSel("#dr-analyze"); await b.sleep(300);
chk((await st()).includes(".dxf"), "не dxf: " + (await st()));
await setFile(b, "#dr-file", EX + "/empty.xlsx"); await b.clickSel("#dr-analyze"); await b.sleep(300);
chk((await st()).includes(".dxf"), "чужое расширение отклонено");
chk(posts(b, "/import-dxf").length === 0, "клиентские отказы — ни одного запроса");
console.log("== серверный отказ (битый DXF): ввод остаётся");
execFileSync("bash", ["-c", `printf 'junk' > ${EX}/junk.dxf`]);
await setFile(b, "#dr-file", EX + "/junk.dxf"); await b.clickSel("#dr-analyze");
await b.waitFor(`document.querySelector('#dr-status').className.includes('bad')`, 20000);
chk((await st()).includes("Разбор не удался") && (await st()).includes("DXF"), "422 текстом сервера: " + (await st()));
chk(await b.eval(`document.querySelector('#dr-file').files.length===1 && !document.querySelector('#dr-analyze').disabled`), "файл выбран, кнопка доступна");
console.log("== разбор → сводка → применение (первая загрузка)");
const s0 = snap();
await setFile(b, "#dr-file", P1);
await b.eval(`window.__f = window.fetch; window.fetch = async (...a) => { if (String(a[0]).includes('import-dxf/analyze')) await new Promise(r => setTimeout(r, 2500)); return window.__f(...a); }`);
await b.clickSel("#dr-analyze"); await b.sleep(1800);
chk(/Прошло \d+ с/.test(await st()), "во время разбора показано время: " + (await st()));
chk(await b.eval(`document.querySelector('#dr-analyze').disabled`), "кнопка разбора заблокирована на время разбора");
await b.waitFor(`document.querySelector('#dr-review .v2-callout')`, 30000);
chk((await st()).includes("В базу пока ничего не записано"), "разбор готов: " + (await st()).slice(0, 90));
const rv = await text(b, "#dr-review");
chk(rv.includes("новых элементов") && rv.includes("Новых подтипов у объекта: 5") && rv.includes(NAME), "сводка: новые элементы, подтипы, объект");
await b.shot(SP + "/exchange_work/s_drawing_review.png");
chk(JSON.stringify(snap()) === JSON.stringify(s0), "разбор ничего не записал (снимок БД)");
chk(sql(`select count(*) n from elements where object_id=${OID}`)[0].n === 0, "изделий объекта в БД нет до применения");
const j0 = maxid();
await clk(b, "#dr-apply"); const c1 = await confirmDlg();
chk(c1.includes("копию базы") && c1.includes("не является одной транзакцией") && c1.includes(NAME), "подтверждение: копия, этапность, объект");
await b.waitFor(`document.querySelector('#dr-status').className.includes('ok') && document.querySelector('#dr-status').innerText.includes('Готово')`, 60000);
chk(posts(b, "/import-dxf/apply").length === 1, "один запрос применения");
chk((await text(b, "#dr-result")).includes("Всего элементов"), "результат: " + (await text(b, "#dr-result")).replace(/\n/g, " ").slice(0, 100));
chk(sql(`select count(*) n from elements where object_id=${OID} and is_current=1`)[0].n === 5, "в БД 5 изделий");
await b.sleep(1800);
chk(journal("import_dxf", j0).length === 1, "журнал: одно событие import_dxf");
console.log("== повторная загрузка с изменениями: марки, зоны, решения");
await reload(b, "#/upload-drawing");
await sel(OID);
await setFile(b, "#dr-file", P2); await b.clickSel("#dr-analyze");
await b.waitFor(`document.querySelector('#dr-review .v2-callout')`, 60000);
const rv2 = await text(b, "#dr-review");
chk(rv2.includes("сменилась марка") && rv2.includes("сопоставлено по handle"), "сводка: сопоставлено по handle, сменилась марка");
chk(rv2.includes("Изменилась геометрия зон"), "сводка: изменилась геометрия зон");
chk(await b.eval(`document.querySelector('#dr-accept-marks').checked`), "«принять смену марок» отмечено по умолчанию");
chk(!(await b.eval(`[...document.querySelectorAll('input[data-newzone]')].some(c=>c.checked)`)), "«создать новую зону» по умолчанию снято (зона правится)");
await b.shot(SP + "/exchange_work/s_drawing_review2.png");
// снять принятие марок → марки останутся прежними
await clk(b, "#dr-accept-marks");
await clk(b, "#dr-apply"); const c2 = await confirmDlg();
chk(c2.includes("НЕ будет принята"), "подтверждение: смена марок НЕ принимается");
await b.waitFor(`document.querySelector('#dr-status').className.includes('ok') || document.querySelector('#dr-status').className.includes('bad')`, 60000);
console.log("СТАТУС:", (await st()).slice(0, 300));
chk(sql(`select count(*) n from elements where object_id=${OID} and mark='1Кв1.1'`)[0].n === 1 && sql(`select count(*) n from elements where object_id=${OID} and mark='1Кв1.9'`)[0].n === 0, "в БД марки остались прежними (1Кв1.1)");
chk((await text(b, "#dr-result")).includes("Оставлено прежних марок"), "результат сообщает об оставленных марках");
// теперь с принятием
await reload(b, "#/upload-drawing");
await sel(OID);
await setFile(b, "#dr-file", P2); await b.clickSel("#dr-analyze");
await b.waitFor(`document.querySelector('#dr-review .v2-callout')`, 60000);
await clk(b, "#dr-apply"); const c3 = await confirmDlg();
chk(c3.includes("будет принята"), "подтверждение: смена марок принимается");
await b.waitFor(`document.querySelector('#dr-status').innerText.includes('Готово')`, 60000);
chk(sql(`select count(*) n from elements where object_id=${OID} and mark='1Кв1.9'`)[0].n === 1, "в БД марка изменена: 1Кв1.9");
console.log("== устаревший токен разбора");
await reload(b, "#/upload-drawing");
await sel(OID);
await setFile(b, "#dr-file", P1); await b.clickSel("#dr-analyze");
await b.waitFor(`document.querySelector('#dr-review .v2-callout')`, 60000);
// три новых разбора у другого пользователя вытесняют токен из памяти сервера
execFileSync(PYX, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE="http://127.0.0.1:8150"
s=requests.Session(); s.post(BASE+"/login",json={"domain_login":"user3","password":"Test-Pass-1234!"})
f=open("${EX}/d1/plan_v2.dxf","rb").read()
for i in range(3): s.post(BASE+"/import-dxf/analyze",files={"file":("x%d.dxf"%i,f)},data={"object_id":"${OID}"})
`]);
const s1 = snap();
await clk(b, "#dr-apply"); await confirmDlg();
await b.waitFor(`document.querySelector('#dr-status').className.includes('bad')`, 30000);
chk((await st()).includes("недоступен") && (await st()).includes("заново"), "устаревший токен: " + (await st()).slice(0, 130));
chk(JSON.stringify(snap()) === JSON.stringify(s1), "БД не изменена");
console.log("== двойной щелчок и неизвестный исход применения");
await reload(b, "#/upload-drawing");
await sel(OID);
await setFile(b, "#dr-file", P2); await b.clickSel("#dr-analyze");
await b.waitFor(`document.querySelector('#dr-review .v2-callout')`, 60000);
await b.eval(`window.__f = window.fetch; window.fetch = async (...a) => { const r = await window.__f(...a); if (String(a[0]).includes('import-dxf/apply')) throw new TypeError('Failed to fetch'); return r; }`);
const nAp = posts(b, "/import-dxf/apply").length, j2 = maxid();
await clk(b, "#dr-apply"); await confirmDlg();
await b.waitFor(`document.querySelector('#dr-status [data-verify]')`, 60000);
await b.sleep(1500);
chk(posts(b, "/import-dxf/apply").length === nAp + 1, "без автоповтора: один запрос применения");
await b.clickSel('#dr-status [data-verify]');
await b.waitFor(`document.querySelector('[data-verify-out]').innerText.includes('выполнена')`, 10000);
chk(true, "сверка по журналу нашла событие import_dxf");
console.log("== после перезагрузки страницы и в V1");
await reload(b, "#/upload-drawing");
chk(await b.eval(`[...document.querySelectorAll('#v2-object option')].some(o=>o.textContent.includes(${JSON.stringify(NAME)}) && /· 5/.test(o.textContent))`), "в шапке V2 у объекта 5 элементов");
await b.goto("http://127.0.0.1:8150/?ui=v1"); await b.sleep(3500);
chk(await b.eval(`state.projects.some(p=>p.objects.some(o=>o.name===${JSON.stringify(NAME)} && o.source_file===${JSON.stringify(PNAME)}))`), "V1 видит объект с чертежом plan_ТЕГ.dxf");
chk(!b.exceptions.length, "исключений нет: " + JSON.stringify(b.exceptions.slice(0, 2)));
summary();
await b.close();
