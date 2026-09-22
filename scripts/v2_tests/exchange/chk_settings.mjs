// Браузерная проверка экрана «Экспорт/импорт настроек» (settings-io) — настоящий backend, настоящие клики.
import fs from "node:fs";
import { open, screen, setFile, text, reload, clk, EX, SP, dbq, snap, sql, maxid, journal, chk, summary, posts } from "./hx.mjs";

const TAG = String(Date.now()).slice(-6);
const LOGIN = "v2brw" + TAG;

function mkjson(name, obj) {
  const p = EX + "/" + name;
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

const colors = JSON.parse(dbq("sql", "select status,color from status_colors"));
const byStatus = Object.fromEntries(colors.map((r) => [r.status, r.color]));
const someStatus = Object.keys(byStatus)[0];
const newColor = byStatus[someStatus] === "#00ff00" ? "#00ff01" : "#00ff00";

const good = mkjson("settings_good.json", {
  users: [{ domain_login: LOGIN, last_name: "Браузер", first_name: "V2", role: "view", auth_method: "local" }],
  status_colors: { ...byStatus, [someStatus]: newColor },
  label_visibility: {}, label_dates_visibility: {},
});
const bad = mkjson("settings_bad.json", [1, 2, 3]); // JSON-массив вместо объекта — parse_payload() отклоняет («не похож на выгрузку настроек»)
// Отдельные пользователи файла на каждый следующий сценарий: `good` применяется целиком в первом сценарии,
// повторная его отправка дальше по сценарию не даст расхождений (has_changes=false) — новый логин гарантирует правку.
const good2 = mkjson("settings_good2.json", {
  users: [{ domain_login: LOGIN + "b", last_name: "Браузер2", first_name: "V2", role: "view", auth_method: "local" }],
  status_colors: {}, label_visibility: {}, label_dates_visibility: {},
});
const good3 = mkjson("settings_good3.json", {
  users: [{ domain_login: LOGIN + "c", last_name: "Браузер3", first_name: "V2", role: "view", auth_method: "local" }],
  status_colors: {}, label_visibility: {}, label_dates_visibility: {},
});

const b = await open("admin");
await screen(b, "settings-io");
const st = () => text(b, "#st-status");
const dialog = () => b.eval(`(()=>{const d=document.querySelector('.v2-dialog');return d?d.innerText:null})()`);

console.log("== скачивание текущих настроек: запрос уходит, ошибок нет");
await clk(b, "#st-export");
await b.sleep(800);
chk(!b.exceptions.length, "скачивание настроек прошло без исключений в консоли");

console.log("== сверка: битый файл — отказ сервера, текстом");
await setFile(b, "#st-file", bad);
await clk(b, "#st-analyze");
await b.waitFor(`document.querySelector('#st-status').className.includes('bad')`, 8000);
chk((await st()).length > 0, "битый файл: сообщение об ошибке показано — " + (await st()));
chk(await b.eval(`document.querySelector('#st-confirm').hidden`), "битый файл: блок подтверждения скрыт");

console.log("== сверка: показывает расхождения, применение недоступно без явного подтверждения");
await setFile(b, "#st-file", good);
await clk(b, "#st-analyze");
await b.waitFor(`document.querySelector('#st-diff').innerText.length > 0`, 8000);
const diff = await text(b, "#st-diff");
chk(diff.includes(LOGIN), "сверка показывает нового пользователя: " + diff.slice(0, 200));
chk(diff.includes(someStatus), "сверка показывает изменённый цвет статуса");
chk(!diff.includes("password_hash") && !/[0-9a-f]{40,}/.test(diff), "сверка не показывает хэш пароля");
chk(await b.eval(`document.querySelector('#st-apply').disabled`), "«Применить» заблокирована, пока не отмечен чекбокс подтверждения");

console.log("== чекбокс подтверждения включает кнопку; диалог называет последствия");
await clk(b, "#st-ack");
chk(!(await b.eval(`document.querySelector('#st-apply').disabled`)), "«Применить» доступна после отметки чекбокса");
const j0 = maxid();
await clk(b, "#st-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg = await dialog();
chk(dlg.includes("settings_good.json") && /парол|рол/i.test(dlg), "диалог подтверждения называет файл и последствия (пароли/роли): " + dlg.slice(0, 200));
await b.shot(SP + "/exchange_work/s_settings_confirm.png");

console.log("== применение: успех, результат виден, после перезагрузки данные на месте");
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#st-status').className.includes('ok')`, 15000);
chk((await st()).includes("пользователей"), "применение: сообщение о результате — " + (await st()));
chk((await text(b, "#st-result")).includes("Пользователей обработано"), "применение: итоговая сводка показана");
await b.shot(SP + "/exchange_work/s_settings_result.png");
chk(sql(`select role, password_hash from users where domain_login='${LOGIN}'`)[0]?.role === "view", "в БД создан пользователь с ролью view");
const ev = journal("settings_import", j0);
chk(ev.length === 1, `в журнале одно событие settings_import (найдено ${ev.length})`);
chk(await b.eval(`document.querySelector('#st-confirm').hidden`), "после применения блок подтверждения снова скрыт (сброшен)");

console.log("== после перезагрузки страницы результат сохраняется, и виден в V1");
await reload(b, "#/settings-io");
chk(sql(`select 1 from users where domain_login='${LOGIN}'`).length === 1, "пользователь остался в БД после перезагрузки страницы");
await b.goto(`http://127.0.0.1:${process.env.V2_EX_PORT || 8150}/?ui=v1`);
await b.sleep(2500);
chk(!b.exceptions.length, "V1 открылся без исключений после операции V2");

console.log("== устаревшая сверка: база меняется между сверкой и применением");
await reload(b, "#/settings-io");
await setFile(b, "#st-file", good2);
await clk(b, "#st-analyze");
await b.waitFor(`document.querySelector('#st-diff').innerText.length > 0`, 8000);
// база меняется НАСТОЯЩИМ запросом второго администратора (user3), не подменой БД — как будто он успел применить своё
const otherStatus = Object.keys(byStatus).find((s) => s !== someStatus);
const otherColor = "#" + (Number(TAG) % 0xffffff).toString(16).padStart(6, "0"); // от запуска к запуску другой — иначе повтор ничего не меняет (идемпотентно)
const otherPayload = { users: [], status_colors: { [otherStatus]: otherColor }, label_visibility: {}, label_dates_visibility: {} };
const c2 = await import("node:child_process");
console.log("apply другого администратора:", c2.execFileSync(process.env.V2_EX_PY || ".venv/bin/python", ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests, json
BASE = "http://127.0.0.1:${process.env.V2_EX_PORT || 8150}"
s = requests.Session(); s.post(BASE + "/login", json={"domain_login": "user3", "password": "Test-Pass-1234!"})
body = ${JSON.stringify(JSON.stringify(otherPayload))}
r1 = s.post(BASE + "/settings/import/analyze", files={"file": ("o.json", body, "application/json")})
r2 = s.post(BASE + "/settings/import/apply", files={"file": ("o.json", body, "application/json")}, data={"digest": r1.json()["digest"]})
print(r1.status_code, r2.status_code, r2.text[:120])
`], { encoding: "utf8" }).trim());
await clk(b, "#st-ack");
await clk(b, "#st-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#st-status').className.includes('bad')`, 15000);
chk(/устар/i.test(await st()), "устаревшая сверка показана текстом: " + (await st()));
chk(await b.eval(`document.querySelector('#st-confirm').hidden`), "устаревшая сверка: форма сброшена — повторная сверка обязательна");
chk(sql(`select 1 from users where domain_login='${LOGIN}b'`).length === 0, "устаревшая сверка: пользователь НЕ создан (применение отказано)");

console.log("== неизвестный исход: ответ потерян");
await reload(b, "#/settings-io");
await b.eval(`(()=>{const orig=window.fetch; window.__n=0; window.fetch=async(...a)=>{const r=await orig(...a); if(String(a[0]).includes('/settings/import/apply')){window.__n++; throw new TypeError('Failed to fetch');} return r;}})()`);
await setFile(b, "#st-file", good3);
await clk(b, "#st-analyze");
await b.waitFor(`document.querySelector('#st-diff').innerText.length > 0`, 8000);
await clk(b, "#st-ack");
await clk(b, "#st-apply");
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#st-status [data-verify]')`, 15000);
chk((await st()).includes("неизвестен"), "показано «Результат неизвестен»");
chk(await b.eval("window.__n") === 1, "запрос не повторялся автоматически");
await b.sleep(1500);
chk(sql(`select 1 from users where domain_login='${LOGIN}c'`).length === 1, "неизвестный исход: запрос НА САМОМ ДЕЛЕ выполнен (пользователь создан в БД)");
await clk(b, "#st-status [data-verify]");
await b.waitFor(`document.querySelector('[data-verify-out]').innerText.includes('выполнена')`, 8000);
chk((await text(b, "[data-verify-out]")).includes("выполнена"), "сверка по журналу подтверждает выполнение: " + (await text(b, "[data-verify-out]")).replace(/\n/g, " ").slice(0, 160));

console.log("== права: user2/user4 получают 403 от сервера при попытке отправить форму");
for (const user of ["user2", "user4"]) {
  const b2 = await open(user);
  await screen(b2, "settings-io");
  const denied = await b2.eval(`fetch('/settings/export',{credentials:'same-origin'}).then(r=>r.status)`);
  chk(denied === 403, `${user}: GET /settings/export → 403 (получен ${denied})`);
  await b2.close();
}

summary();
await b.close();
