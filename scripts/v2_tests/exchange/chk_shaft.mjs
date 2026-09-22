// Браузерная проверка экрана «Панели облицовки шахты» (shaft-panels) — настоящий backend, настоящие клики.
import { execFileSync } from "node:child_process";
import { open, screen, setFile, text, reload, clk, EX, SP, sql, maxid, journal, chk, summary, posts } from "./hx.mjs";

const PY = process.env.V2_EX_PY || ".venv/bin/python";
const ROOT = "/Users/max/zhbi-w-exchange2";
function gen(variant, name) {
  const out = EX + "/" + name;
  execFileSync(PY, [ROOT + "/scripts/gen_synthetic_shaft_dxf.py", out, "--variant", variant], { encoding: "utf8" });
  return out;
}
const okDxf = gen("ok", "sp_ok.dxf");
const noAxes = gen("no_axes", "sp_no_axes.dxf");

const OBJ = 1; // объект копии с зарегистрированной сеткой осей 5/7/Е/Ж (реальные оси анонимной копии, Docs/v2-progress/exchange2.md)
const b = await open("admin");
await screen(b, "shaft-panels");
const st = () => text(b, "#sp-status");
const dialog = () => b.eval(`(()=>{const d=document.querySelector('.v2-dialog');return d?d.innerText:null})()`);
const setObj = async (v) => b.eval(`(()=>{const s=document.querySelector('#sp-object');s.value=${JSON.stringify(String(v))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);

console.log("== клиентская проверка (объект уже выбран из шапки; без файла)");
await setObj(OBJ);
await clk(b, "#sp-analyze"); await b.sleep(300);
chk((await st()).length > 0 && !(await st()).includes("Распозн"), "без файла: " + (await st()));

console.log("== отказ профиля: чертёж без осей — понятный текст сервера");
await setFile(b, "#sp-file", noAxes);
await clk(b, "#sp-analyze");
await b.waitFor(`document.querySelector('#sp-status').className.includes('bad')`, 15000);
chk(/ос[ьи]/i.test(await st()), "нет осей: показано текстом сервера — " + (await st()));

console.log("== разбор без толщины: панели видны, применение недоступно");
await setFile(b, "#sp-file", okDxf);
await clk(b, "#sp-analyze");
await b.waitFor(`document.querySelector('#sp-result').innerText.length > 0`, 15000);
const r1 = await text(b, "#sp-result");
chk(r1.includes("ПП") && /14/.test(r1), "панели показаны (14 шт., марки ПП*): " + r1.replace(/\n/g, " ").slice(0, 200));
chk(!(await b.eval(`!!document.querySelector('#sp-apply')`)), "без толщины: кнопки «Применить» нет");
chk((await b.eval(`document.querySelectorAll('[data-warning]').length`)) >= 1, "замечания к чертежу показаны флажками");

console.log("== разбор с толщиной: сводка для применения");
await setFile(b, "#sp-file", okDxf); // повторный выбор того же файла — гарантирует событие change даже если input не менялся визуально
await b.eval(`document.querySelector('#sp-thickness').value='300'; document.querySelector('#sp-thickness').dispatchEvent(new Event('input',{bubbles:true}))`);
await clk(b, "#sp-analyze");
await b.waitFor(`document.querySelector('#sp-apply')`, 15000);
const r2 = await text(b, "#sp-result");
chk(r2.includes("Добавить") && /14/.test(r2), "сводка для применения показана: " + r2.replace(/\n/g, " ").slice(0, 200));
chk(await b.eval(`document.querySelector('#sp-apply').disabled`) === false, "«Применить» не заблокирована конфликтами");

console.log("== применение без подтверждения замечаний — клиент не даёт отправить с неотмеченными флажками");
await clk(b, "#sp-apply"); await b.sleep(400);
chk((await st()).includes("Подтвердите"), "без подтверждения замечаний: " + (await st()));
chk(!(await b.eval(`!!document.querySelector('.v2-dialog')`)), "диалог подтверждения не открылся без отмеченных замечаний");

console.log("== применение: подтверждение всех замечаний → диалог → успех");
await b.eval(`document.querySelectorAll('[data-warning]').forEach(n=>{n.checked=true})`);
const j0 = maxid();
await clk(b, "#sp-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg = await dialog();
chk(dlg.includes("Добавить") && dlg.includes("14"), "диалог подтверждения называет последствия: " + dlg.slice(0, 160));
await b.shot(SP + "/exchange_work/s_shaft_confirm.png");
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#sp-status').className.includes('ok')`, 20000);
chk((await st()).includes("Добавлено 14"), "применение: результат показан — " + (await st()));
await b.shot(SP + "/exchange_work/s_shaft_result.png");
chk(sql(`select count(*) n from elements where object_id=${OBJ} and element_type='Панель облицовки шахты' and is_current=1 and mark like 'ПП%'`)[0].n >= 14, "в БД не меньше 14 текущих панелей");
const ev = journal("import_dxf", j0);
chk(ev.length === 1, `в журнале одно событие import_dxf (найдено ${ev.length})`);
const detailsRow = sql(`select details from activity_log where id=${ev[0]?.id}`)[0];
chk(detailsRow && JSON.parse(detailsRow.details || "{}").kind === "shaft_panels", `событие несёт kind=shaft_panels: ${detailsRow?.details}`);

console.log("== после перезагрузки страницы форма пуста (нет незавершённой сводки), данные на месте и видны в V1");
await reload(b, "#/shaft-panels");
chk((await b.eval(`document.querySelector('#sp-result').innerHTML`)) === "", "после перезагрузки — форма без сводки (применённое не висит)");
await b.goto(`http://127.0.0.1:${process.env.V2_EX_PORT || 8150}/?ui=v1`);
await b.sleep(2500);
chk(!b.exceptions.length, "V1 открылся без исключений после операции V2");

console.log("== отмена незавершённого анализа");
await reload(b, "#/shaft-panels");
await setObj(OBJ);
await setFile(b, "#sp-file", okDxf);
await b.eval(`document.querySelector('#sp-thickness').value='300'; document.querySelector('#sp-thickness').dispatchEvent(new Event('input',{bubbles:true}))`);
await clk(b, "#sp-analyze");
await b.waitFor(`document.querySelector('#sp-apply')`, 15000);
await clk(b, "#sp-cancel");
await b.sleep(300);
chk((await st()).includes("отменён"), "отмена анализа показана текстом: " + (await st()));
chk((await b.eval(`document.querySelector('#sp-result').innerHTML`)) === "", "после отмены — сводка убрана");

console.log("== права: user2/user4 получают 403 от сервера при настоящей попытке разбора");
for (const user of ["user2", "user4"]) {
  const out = execFileSync(PY, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE = "http://127.0.0.1:${process.env.V2_EX_PORT || 8150}"
s = requests.Session(); s.post(BASE + "/login", json={"domain_login": "${user}", "password": "Test-Pass-1234!"})
with open("${okDxf}", "rb") as f:
    r = s.post(BASE + "/shaft-panels/analyze", files={"file": ("ok.dxf", f, "application/dxf")}, data={"object_id": "${OBJ}"})
print(r.status_code)
`], { encoding: "utf8" }).trim();
  chk(out === "403", `${user}: настоящий запрос POST /shaft-panels/analyze → 403 (получен ${out})`);
}

summary();
await b.close();
