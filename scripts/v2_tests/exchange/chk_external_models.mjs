// Браузерная проверка экрана «Загрузить из FBX» (external-models) — список, правка размещения, перецентровка, удаление.
// Тестовая запись заводится напрямую в копии БД (как в scripts/verify_exchange.py, section_external_models) — GET/PATCH/
// recenter/DELETE не читают файл с диска (delete_file() не падает на отсутствие файла).
import { execFileSync } from "node:child_process";
import { open, screen, text, reload, clk, setFile, EX, SP, sql, maxid, journal, chk, summary } from "./hx.mjs";

const OBJ = 1;
const PY = process.env.V2_EX_PY || ".venv/bin/python";
const DB = `${process.env.V2_EX_WORK || (SP)}/exchange_work/work.db`;

function seed(name) {
  return execFileSync(PY, ["-W", "ignore", "-c", `
import sqlite3
c = sqlite3.connect("${DB}", timeout=30)
c.execute("INSERT INTO object_external_models (object_id, name, kind, original_name, stored_name, sha256, size_bytes, "
    "format_version, placement_mode, metadata_json, source_anchor_x_mm, source_anchor_y_mm, source_anchor_z_mm, "
    "object_anchor_x_mm, object_anchor_y_mm, centering_revision, offset_x_mm, offset_y_mm, offset_z_mm, "
    "rotation_deg, scale_x, scale_y, scale_z, revision) VALUES "
    "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (${OBJ}, "${name}", "ground", "seed.fbx", "seed-browser-${name}.fbx", "0"*64, 1000, 7400,
     "unreferenced", "{}", 0.0, 0.0, 0.0, 0.0, 0.0, "seed-rev", 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1))
c.commit()
print(c.execute("SELECT id FROM object_external_models WHERE stored_name=?", ("seed-browser-${name}.fbx",)).fetchone()[0])
c.close()
`], { encoding: "utf8" }).trim();
}

const b = await open("admin");
await screen(b, "external-models");
await b.eval(`document.querySelector('#em-upload-details').open = true`);

console.log("== загрузка FBX: настоящий разбор клиентом (Three.js/FBXLoader), диалог называет геометрию, применение");
await setFile(b, "#em-file", EX + "/bad_axis.fbx");
await b.eval(`document.querySelector('#em-name').value = 'Неподдержанные оси'`);
await clk(b, "#em-go");
// клиентский разбор (app/static/external-models/fbx-global-settings.js — та же проверка профиля осей, что и на сервере)
// отклоняет файл ДО диалога подтверждения и ДО сети — запрос на сервер не уходит вовсе.
await b.waitFor(`document.querySelector('#em-upload-status').className.includes('bad')`, 15000);
chk(/не распознан/i.test(await text(b, "#em-upload-status")) && /профил|ос[ьи]/i.test(await text(b, "#em-upload-status")),
  "неподдержанный профиль осей отклонён клиентским разбором (та же проверка, что на сервере), текст показан: " + (await text(b, "#em-upload-status")));
chk(!(await b.eval(`!!document.querySelector('.v2-dialog')`)), "диалог подтверждения не открывался — отказ до сети");

await setFile(b, "#em-file", EX + "/ok.fbx");
await b.eval(`document.querySelector('#em-kind').value = 'ground'; document.querySelector('#em-name').value = 'Загрузка браузером'`);
const j0up = maxid();
await clk(b, "#em-go");
// разбор ждёт до 20с таймаута загрузки текстур (app/static/external-models/fbx.js, DEFAULT_LIMITS.textureTimeoutMs) — у синтетического
// меша без текстур LoadingManager.onLoad никогда не срабатывает сам, ждём именно запасной таймаут (то же самое поведение у V1).
await b.waitFor(`document.querySelector('.v2-dialog')`, 25000);
const uploadDlg = await b.eval(`document.querySelector('.v2-dialog').innerText`);
chk(/мешей 1/.test(uploadDlg) && /треугольников 1/.test(uploadDlg), "диалог называет РЕАЛЬНО разобранную геометрию (1 меш, 1 треугольник): " + uploadDlg.slice(0, 200));
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`document.querySelector('#em-upload-status').className.includes('ok')`, 15000);
chk((await text(b, "#em-upload-status")).includes("загружена"), "загрузка: результат показан — " + (await text(b, "#em-upload-status")));
await b.waitFor(`document.querySelector('#em-list').innerText.includes('Загрузка браузером')`, 5000);
chk(true, "новая модель появилась в списке без перезагрузки страницы");
const uploaded = sql(`select id, kind, size_bytes from object_external_models where name='Загрузка браузером'`)[0];
chk(uploaded && uploaded.kind === "ground" && uploaded.size_bytes > 0, `в БД запись создана: ${JSON.stringify(uploaded)}`);
const evUp = journal("external_model_upload", j0up);
chk(evUp.length === 1, `журнал: одно событие external_model_upload (найдено ${evUp.length})`);

const modelId = Number(seed("БраузерТест"));
await reload(b, "#/external-models");
await b.waitFor(`document.querySelector('#em-list').innerText.includes('БраузерТест')`, 10000);
chk(true, "список показывает заведённую модель");

console.log("== правка размещения: числовые поля, сверка версии, сохранение");
await clk(b, `[data-edit="${modelId}"]`);
await b.waitFor(`document.querySelector('[data-edit-form="${modelId}"]')`, 5000);
const setField = async (name, value) => b.eval(`(()=>{const f=document.querySelector('[data-edit-form="${modelId}"]');const el=f.querySelector('[name="${name}"]');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await setField("offset_x_mm", "200");
await setField("rotation_deg", "30");
await setField("name", "Изменённая модель");
const j0 = maxid();
await clk(b, `[data-edit-form="${modelId}"] button[type=submit]`);
await b.waitFor(`document.querySelector('#em-list').innerText.includes('смещ. 200')`, 8000);
const listText = await text(b, "#em-list");
chk(listText.includes("Изменённая модель") && listText.includes("30"), "правка применена и видна в списке: " + listText.replace(/\n/g, " ").slice(0, 200));
chk(sql(`select offset_x_mm, rotation_deg, name from object_external_models where id=${modelId}`)[0].name === "Изменённая модель", "в БД название обновлено");
const ev1 = journal("external_model_update", j0);
chk(ev1.length === 1, `журнал: одно событие external_model_update (найдено ${ev1.length})`);

console.log("== перецентровка");
const j1 = maxid();
await clk(b, `[data-recenter="${modelId}"]`);
await b.waitFor(`document.querySelector('#em-list-status').innerText.includes('перецентрован')`, 8000);
chk(sql(`select offset_x_mm, offset_y_mm from object_external_models where id=${modelId}`)[0].offset_x_mm === 0, "в БД смещение сброшено перецентровкой");
const ev2 = journal("external_model_recenter", j1);
chk(ev2.length === 1, `журнал: одно событие external_model_recenter (найдено ${ev2.length})`);

console.log("== после перезагрузки страницы правки на месте, видно в V1");
await reload(b, "#/external-models");
await b.waitFor(`document.querySelector('#em-list').innerText.includes('Изменённая модель')`, 10000);
chk(true, "после перезагрузки — модель с новым названием на месте");
await b.goto(`http://127.0.0.1:${process.env.V2_EX_PORT || 8150}/?ui=v1`);
await b.sleep(2500);
chk(!b.exceptions.length, "V1 открылся без исключений после операции V2");

console.log("== удаление: подтверждение, результат");
await reload(b, "#/external-models");
await b.waitFor(`document.querySelector('#em-list').innerText.includes('Изменённая модель')`, 10000);
await clk(b, `[data-delete="${modelId}"]`);
await b.waitFor(`document.querySelector('.v2-dialog')`, 5000);
const dlg = await b.eval(`document.querySelector('.v2-dialog').innerText`);
chk(/необратимо/i.test(dlg), "диалог удаления предупреждает о необратимости: " + dlg.slice(0, 160));
await clk(b, '[data-choice="confirm"]');
await b.waitFor(`!document.querySelector('#em-list').innerText.includes('Изменённая модель')`, 8000);
chk(sql(`select count(*) n from object_external_models where id=${modelId}`)[0].n === 0, "в БД модель удалена");

console.log("== права: user2/user4 получают 403 при настоящей попытке правки");
const modelId2 = Number(seed("ДляПроверкиПрав"));
for (const user of ["user2", "user4"]) {
  const out = execFileSync(PY, ["-W", "ignore", "-c", `
import warnings; warnings.filterwarnings("ignore")
import requests
BASE = "http://127.0.0.1:${process.env.V2_EX_PORT || 8150}"
s = requests.Session(); s.post(BASE + "/login", json={"domain_login": "${user}", "password": "Test-Pass-1234!"})
r = s.patch(BASE + "/objects/${OBJ}/external-models/${modelId2}", json={"expected_revision": 1, "offset_x_mm": 1})
print(r.status_code)
`], { encoding: "utf8" }).trim();
  chk(out === "403", `${user}: настоящий запрос PATCH /objects/${OBJ}/external-models/${modelId2} → 403 (получен ${out})`);
}

summary();
await b.close();
