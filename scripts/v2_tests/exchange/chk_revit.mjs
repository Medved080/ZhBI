import { clk, open, screen, setFile, text, reload, TAG, EX, SP, snap, sql, maxid, journal, chk, summary, posts } from "./hx.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const PYX = "python3";
// пакеты этого прогона с уникальными uid
const pk = (section, n, tag, date = "2026-09-21") => JSON.stringify({ "формат": "zhbi-revit-package", "версия_схемы": 1, "выгрузка": { "раздел": section, "модель": "synthetic", "дата": date, "единицы": "мм", "координаты": "общие" },
  "уровни": [{ "имя": "С01-02_1_этаж_основной_0.000", "отметка": 0 }], "элементы": Array.from({ length: n }, (_, i) => ({ uid: `br${TAG}-${tag}-${section}-${i}`, id: 1 + i, "категория": "Стены", "семейство": "Стена", "типоразмер": "Стена_200", "марка": `М${i}`, "уровень": "С01-02_1_этаж_основной_0.000", "отметка_низа": 0, "высота": 3000, "точка": [i * 1000, 0, 0], "контур": [[i * 1000, 0], [i * 1000 + 800, 0], [i * 1000 + 800, 200], [i * 1000, 200]], "MCY_Секция": "С01" })), "помещения": [], "оси": [] });
writeFileSync(EX + "/rv_a_kr.json", pk("КР", 3, "a")); writeFileSync(EX + "/rv_a_ar.json", pk("АР", 2, "a")); writeFileSync(EX + "/rv_a_kr2.json", pk("КР", 3, "b"));
const NAME = `Тест-В2 МФР браузер ${TAG}`;
const out = execFileSync(PYX, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE="http://127.0.0.1:8150"
s=requests.Session(); s.post(BASE+"/login",json={"domain_login":"admin","password":"Test-Pass-1234!"})
pr=s.get(BASE+"/projects-tree").json()["projects"]
pid=next(p["id"] for p in pr if any(o["kind"]=="mfr" for o in p["objects"]))
print(s.post(BASE+"/objects",json={"name":"${NAME}","project_id":pid,"kind":"mfr"}).json()["id"])
`], { encoding: "utf8" }).trim();
const OID = Number(out.split("\n").pop());
const b = await open("admin");
const confirmDlg = async () => { await b.waitFor(`document.querySelector('.v2-dialog')`, 5000); const t = await text(b, ".v2-dialog"); await b.clickSel('[data-choice="confirm"]'); return t; };
const st = () => text(b, "#rv-status");
await reload(b, "#/");
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value=${JSON.stringify(String(OID))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1500);
await screen(b, "revit-import");
await b.eval(`(()=>{const s=document.querySelector('#rv-object');s.value=${JSON.stringify(String(OID))};s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
console.log("== выбор пакетов");
await clk(b, "#rv-analyze"); await b.sleep(300);
chk((await st()).includes("хотя бы один пакет"), "без пакетов: " + (await st()));
await setFile(b, "#rv-file", EX + "/rv_a_kr.json"); await setFile(b, "#rv-file", EX + "/rv_a_ar.json");
chk((await text(b, "#rv-list")).includes("rv_a_kr.json") && (await text(b, "#rv-list")).includes("rv_a_ar.json"), "пакеты накапливаются: " + (await text(b, "#rv-list")).replace(/\n/g, " "));
await setFile(b, "#rv-file", EX + "/rv_a_kr2.json");
await clk(b, "#rv-analyze"); await b.waitFor(`document.querySelector('#rv-status').className.includes('bad')`, 20000);
chk((await st()).includes("несколько пакетов одного раздела"), "два пакета одного раздела: 422 текстом сервера — " + (await st()).slice(0, 100));
await clk(b, '#rv-list [data-drop="2"]');
chk(!(await text(b, "#rv-list")).includes("rv_a_kr2.json"), "«убрать» удалил пакет из списка");
console.log("== разбор → сводка → применение");
const s0 = snap();
await clk(b, "#rv-analyze"); await b.waitFor(`document.querySelector('#rv-review .v2-callout')`, 30000);
const rv = await text(b, "#rv-review");
chk(rv.includes("новых элементов") && rv.includes("Что приехало") && rv.includes("КР") && rv.includes("АР"), "сводка: разделы и новые элементы");
chk(await b.eval(`!!document.querySelector('#rv-review svg')`), "план контуров построен");
await b.shot(SP + "/exchange_work/s_revit_review.png");
chk(JSON.stringify(snap()) === JSON.stringify(s0) && sql(`select count(*) n from revit_elements where object_id=${OID}`)[0].n === 0, "разбор ничего не записал");
const j0 = maxid();
await b.eval(`window.__f=window.fetch; window.fetch=async(...a)=>{ if(String(a[0]).includes('import-revit/apply')) await new Promise(r=>setTimeout(r,1500)); return window.__f(...a);}`);
await clk(b, "#rv-apply"); const c1 = await confirmDlg();
chk(c1.includes(NAME) && c1.includes("копию базы") && c1.includes("не является одной транзакцией"), "подтверждение: объект, копия, этапность");
await b.sleep(400);
chk(await b.eval(`document.querySelector('#rv-apply').disabled`), "во время применения кнопка заблокирована");
await b.waitFor(`document.querySelector('#rv-status').innerText.includes('Готово')`, 60000);
chk(posts(b, "/import-revit/apply").length === 1, "один запрос применения");
chk(sql(`select count(*) n from revit_elements where object_id=${OID} and is_current=1`)[0].n === 5, "в БД 5 элементов модели");
chk((await text(b, "#rv-result")).includes("Элементов записано"), "результат показан");
await b.sleep(1800);
chk(journal("import_revit", j0).length === 1, "журнал: одно событие import_revit");
console.log("== повторная выгрузка КР меньше на элемент: списание, потерянный ответ");
writeFileSync(EX + "/rv_a_kr_small.json", pk("КР", 2, "a"));
await reload(b, "#/");
await b.eval(`(()=>{const s=document.querySelector('#v2-object');s.value=${JSON.stringify(String(OID))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await b.sleep(1500);
await screen(b, "revit-import");
await setFile(b, "#rv-file", EX + "/rv_a_kr_small.json"); await clk(b, "#rv-analyze"); await b.waitFor(`document.querySelector('#rv-review .v2-callout')`, 30000);
chk((await text(b, "#rv-review")).includes("исчезло из модели — будут списаны"), "сводка предупреждает о списании");
await b.eval(`(()=>{const o=window.fetch; window.fetch=async(...a)=>{const r=await o(...a); if(String(a[0]).includes('import-revit/apply')) throw new TypeError('Failed to fetch'); return r;}})()`);
const nAp = posts(b, "/import-revit/apply").length;
await clk(b, "#rv-apply"); await confirmDlg();
await b.waitFor(`document.querySelector('#rv-status [data-verify]')`, 30000); await b.sleep(1500);
chk(posts(b, "/import-revit/apply").length === nAp + 1, "без автоповтора");
await b.clickSel('#rv-status [data-verify]'); await b.waitFor(`document.querySelector('[data-verify-out]').innerText.includes('выполнена')`, 10000);
chk(sql(`select count(*) n from revit_elements where object_id=${OID} and is_current=1 and section_code='КР'`)[0].n === 2, "списание в БД: в КР осталось 2 текущих");
chk(sql(`select count(*) n from revit_elements where object_id=${OID} and is_current=1 and section_code='АР'`)[0].n === 2, "АР не затронут");
console.log("== после перезагрузки и в V1");
await reload(b, "#/"); await b.goto("http://127.0.0.1:8150/?ui=v1"); await b.sleep(3500);
chk(!b.exceptions.length, "V1 открывается без исключений; исключений V2 нет");
summary(); await b.close();
