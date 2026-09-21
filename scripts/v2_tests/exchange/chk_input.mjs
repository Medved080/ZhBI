import { clk, open, screen, text, reload, mkxlsx, TAG, EX, SP, snap, sql, maxid, journal, chk, summary, posts, ROOT } from "./hx.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync, copyFileSync, rmSync, mkdirSync } from "node:fs";
const IN = ROOT + "/Input";
mkdirSync(IN, { recursive: true });
const PYX = "python3";
const files = [];
const put = (n, from) => { copyFileSync(from, IN + "/" + n); files.push(IN + "/" + n); };
const b = await open("admin");
try {
  const OH = ["Наименование ОС", "Адрес", "СМУ", "Директор СМУ", "ДП / РП", "Статус ОС", "Широта", "Долгота", "Фото/Видео", "Старт СМР"];
  const NAME = `Тест-В2 папка браузер ${TAG}`;
  mkxlsx("in_obj.xlsx", OH, [[NAME, null, null, null, null, "Активный", null, null, null, null]], "Объекты на карте");
  execFileSync(PYX, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE="http://127.0.0.1:8150"
s=requests.Session(); s.post(BASE+"/login",json={"domain_login":"admin","password":"Test-Pass-1234!"})
a=s.post(BASE+"/objects-import/analyze",files={"file":("f.xlsx",open("${EX}/in_obj.xlsx","rb").read())}).json()
s.post(BASE+"/objects-import/apply",json={"changes":a["changes"]})
`]);
  const OID = sql(`select id from objects where name='${NAME}'`)[0].id;
  console.log("== пустая папка");
  await reload(b, "#/import-input");
  chk((await text(b, "#in-list")).includes("Папка Input/ пуста"), "пустая папка: " + (await text(b, "#in-list")));
  chk(await b.eval(`document.querySelector('#in-go').disabled`), "кнопка «Загрузить» недоступна при пустой папке");
  console.log("== список и запуск");
  put(`in_${TAG}.dxf`, EX + "/sample_dxf.dxf");
  writeFileSync(IN + `/broken_${TAG}.dxf`, "junk"); files.push(IN + `/broken_${TAG}.dxf`);
  await clk(b, "#in-refresh"); await b.sleep(800);
  chk((await text(b, "#in-list")).includes(`in_${TAG}.dxf`) && (await text(b, "#in-list")).includes("будет перезаписана"), "список файлов и предупреждение о перезаписи");
  await b.eval(`(()=>{const s=document.querySelector('#in-object');s.value=${JSON.stringify(String(OID))};s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const s0 = snap();
  await clk(b, "#in-go");
  await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
  const dlg = await text(b, ".v2-dialog");
  chk(dlg.includes("Чертежей: 2") && dlg.includes(NAME) && dlg.includes("копию базы") && dlg.includes("ошибка одного файла"), "подтверждение: файлы, объект, копия, построчный итог");
  await b.eval(`window.__f=window.fetch; window.fetch=async(...a)=>{ if(String(a[0]).includes('admin/import-input')) await new Promise(r=>setTimeout(r,1500)); return window.__f(...a);}`);
  await b.clickSel('[data-choice="confirm"]');
  await b.sleep(400);
  chk(await b.eval(`document.querySelector('#in-go').disabled`), "во время загрузки кнопка заблокирована");
  await clk(b, "#in-go"); await b.key("Enter");
  await b.waitFor(`document.querySelector('#in-status').innerText.includes('Готово')`, 90000);
  chk(posts(b, "/admin/import-input").length === 1, "один запрос загрузки");
  const rep = await text(b, "#in-report");
  chk(rep.includes(`in_${TAG}.dxf`) && rep.includes("ОШИБКА"), "построчный отчёт: чертёж загружен, битый — ошибка");
  chk(await b.eval(`!!document.querySelector('#in-report .v2-bad-text')`), "строка с ошибкой выделена");
  chk(sql(`select count(*) n from elements where source_file='in_${TAG}.dxf'`)[0].n === 5, "в БД 5 изделий");
  chk(JSON.stringify(snap()) !== JSON.stringify(s0), "данные изменились");
  await b.sleep(1800);
  chk(journal("import_input", 0).length >= 1, "журнал: import_input");
  console.log("== неизвестный исход");
  await reload(b, "#/import-input");
  await b.eval(`document.querySelector('#in-object').value=${JSON.stringify(String(OID))}`);
  await b.eval(`(()=>{const o=window.fetch; window.fetch=async(...a)=>{const r=await o(...a); if(String(a[0]).includes('admin/import-input')) throw new TypeError('Failed to fetch'); return r;}})()`);
  const n0 = posts(b, "/admin/import-input").length;
  await clk(b, "#in-go"); await b.waitFor(`document.querySelector('.v2-dialog')`, 5000); await b.clickSel('[data-choice="confirm"]');
  await b.waitFor(`document.querySelector('#in-status [data-verify]')`, 90000);
  await b.sleep(1500);
  chk(posts(b, "/admin/import-input").length === n0 + 1, "без автоповтора: один запрос");
  await b.clickSel('#in-status [data-verify]');
  await b.waitFor(`document.querySelector('[data-verify-out]').innerText.includes('выполнена')`, 10000);
  chk(true, "сверка по журналу нашла загрузку");
  chk(!b.exceptions.length, "исключений нет: " + JSON.stringify(b.exceptions.slice(0, 2)));
} finally { for (const f of files) { try { rmSync(f); } catch {} } }
summary();
await b.close();
