// «Внешний вид»: тени и солнце в 3D (перенос V1: localStorage zhbi_shadows_3d / zhbi_sun_3d_mode — настройка компьютера), применение на схеме
// рабочего места V2 и в V1 на том же браузере; показ внешних 3D-моделей (благоустройство/фасады) на вкладке «Вид» рабочего места;
// гамма — V2 светлая/тёмная, сцена в кадре — полная палитра V1. Настоящий backend, вход формой, настоящие щелчки.
//   node scripts/audit_set/check_appearance.mjs <копия БД> <порт>
import { session, sql, ok, summary, go, click, DB, BASE, SHOTS, setObject, frameEval, waitScene, as, overflowX, onBail, clickText } from "./lib.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const q1 = (s) => sql(DB, s)[0];
const admin = q1("select id, ui_theme from users where domain_login='admin'");
const b = await session(BASE, "admin");
await setObject(b, 1);

// ---- 1. Тени и солнце: настоящие щелчки по флажку и переключателю
await go(b, "appearance");
await b.waitFor("!!document.querySelector('#ap-shadows')");
ok("исходно: теней нет, солнце — относительно модели (как по умолчанию в V1)", await b.eval(`!document.querySelector('#ap-shadows').checked && document.querySelector('input[name=ap-sun][value=model]').checked`));
await click(b, "#ap-shadows");
await click(b, "input[name=ap-sun][value=camera]");
await b.sleep(200);
const ls = await b.eval(`[localStorage.getItem('zhbi_shadows_3d'), localStorage.getItem('zhbi_sun_3d_mode')]`);
ok("запись в браузер под ключами V1", ls[0] === "1" && ls[1] === "camera", JSON.stringify(ls));
ok("никаких запросов записи на сервер (настройка компьютера)", !b.requests.some((r) => r.method !== "GET" && /\/users\//.test(r.url)));
ok("после перезахода на экран — значения на месте", await (async () => { await go(b, "home"); await go(b, "appearance"); await b.waitFor("!!document.querySelector('#ap-shadows')"); return b.eval(`document.querySelector('#ap-shadows').checked && document.querySelector('input[name=ap-sun][value=camera]').checked`); })());
for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  await b.viewport(w, h); await b.sleep(300);
  ok(`${w}×${h}: экран «Внешний вид» без горизонтальной прокрутки`, (await overflowX(b)) <= 1);
  if (SHOTS) { await b.eval("document.querySelector('#ap-shadows').scrollIntoView({block:'center'})"); await b.shot(`${SHOTS}/appearance-${w}.png`); }
}
await b.viewport(1920, 1080);

// ---- 2. Схема рабочего места V2: сцена читает те же ключи; в 3D тени включены, солнце — от камеры
await go(b, "ws-model");
await waitScene(b);
ok("кадр V2: state.shadows3d / sun3dMode из настройки", JSON.stringify(await frameEval(b, "[state.shadows3d, state.sun3dMode]")) === JSON.stringify([true, "camera"]));
await click(b, '#ws-modes [data-view="3d"]');
await b.waitFor(`(async()=>true)()`);
for (let i = 0; i < 60; i++) { if (await frameEval(b, "!!(state.view3d.active && state.view3d.renderer)")) break; await b.sleep(500); }
await b.sleep(1500);
const sh = await frameEval(b, "({map: state.view3d.renderer.shadowMap.enabled, cast: !!(state.view3d.sunLight && state.view3d.sunLight.castShadow), enabled: shadows3DEnabled()})");
ok("3D в V2: карта теней включена, солнце отбрасывает тень", sh.map === true && sh.cast === true, JSON.stringify(sh));
if (SHOTS) await b.shot(`${SHOTS}/appearance-3d-shadows.png`);
await click(b, '#ws-modes [data-view="3d-light"]'); await b.sleep(2500);
ok("«3D лёгкий»: тени не включаются (как в V1)", (await frameEval(b, "shadows3DEnabled()")) === false);

// ---- 3. V1 на том же браузере видит ту же настройку (общий ключ — совместимость)
await b.goto(BASE + "/?ui=v1", 1500);
await b.waitFor("typeof document.getElementById('menu-view-mode')==='object' && !!document.getElementById('menu-view-mode')", 30000);
await b.eval("document.getElementById('menu-view-mode').click()"); await b.sleep(400);
ok("V1 «Внешний вид»: флажок теней и «от камеры» отмечены той же настройкой", await b.eval(`document.getElementById('shadows-3d').checked && document.querySelector('input[name=sun-3d-mode][value=camera]').checked`));
// вернуть как было — из V1 (его же обработчиком), затем проверить в V2
await b.eval(`(()=>{const c=document.getElementById('shadows-3d');c.checked=false;c.dispatchEvent(new Event('change'));const r=document.querySelector('input[name=sun-3d-mode][value=model]');r.checked=true;r.dispatchEvent(new Event('change'))})()`);
await b.goto(BASE + "/v2#/appearance", 1500);
await b.waitFor("!!document.querySelector('#ap-shadows')", 20000);
ok("изменение из V1 видно в V2 (исходные значения возвращены)", await b.eval(`!document.querySelector('#ap-shadows').checked && document.querySelector('input[name=ap-sun][value=model]').checked && localStorage.getItem('zhbi_shadows_3d')==='0'`));

// ---- 4. Гамма: V2 — светлая/тёмная семья, сцена в кадре — полная палитра V1 выбранной гаммы
await click(b, '[data-skin="graphite"]');
await b.waitFor(`/подтвержд/.test(document.querySelector('#ap-status').textContent)`, 15000);
ok("гамма «Графит»: SQL ui_theme", q1(`select ui_theme t from users where id=${admin.id}`).t === "graphite");
ok("V2: тёмная схема (color-scheme)", await b.eval("document.documentElement.style.colorScheme === 'dark'"));
await go(b, "ws-model"); await waitScene(b);
ok("кадр V2: полная палитра гаммы V1 (data-skin=graphite)", (await frameEval(b, "document.documentElement.getAttribute('data-skin')")) === "graphite");
const a = await as("admin");
const rt = await a.patch(`/users/${admin.id}/ui-theme`, { ui_theme: admin.ui_theme });
ok("гамма возвращена к исходной", rt.status === 200 && q1(`select ui_theme t from users where id=${admin.id}`).t === admin.ui_theme);

// ---- 5. Внешние 3D-модели: загрузка синтетической FBX на объект 1 (экран V2 «Загрузить из FBX»), флажки на вкладке «Вид»
const dir = mkdtempSync(join(tmpdir(), "audit-fbx-"));
const fbx = join(dir, "ground.fbx");
execFileSync(".venv/bin/python", ["scripts/gen_synthetic_fbx.py", fbx], { stdio: "ignore" });
const before = q1("select count(*) n from object_external_models where object_id=1").n;
let modelId = null;
const cleanup = async () => { if (modelId) { await a.del(`/objects/1/external-models/${modelId}`); modelId = null; } rmSync(dir, { recursive: true, force: true }); };
onBail(cleanup);
await go(b, "external-models");
await b.waitFor("!!document.querySelector('#em-file')", 20000);
await b.eval("document.querySelector('#em-upload-details').open = true");
const { root } = await b.send("DOM.getDocument", { depth: 0 });
const { nodeId } = await b.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#em-file" });
await b.send("DOM.setFileInputFiles", { nodeId, files: [fbx] });
await click(b, "#em-go");
await b.waitFor("!!document.querySelector('.v2-dialog [data-choice=\"confirm\"]')", 20000);
await click(b, '.v2-dialog [data-choice="confirm"]');
await b.waitFor(`/Готово/.test(document.querySelector('#em-upload-status').textContent)`, 30000);
modelId = q1("select max(id) id from object_external_models where object_id=1").id;
ok("модель благоустройства загружена (SQL)", q1("select count(*) n from object_external_models where object_id=1").n === before + 1);
await go(b, "ws-model"); await waitScene(b);
await click(b, '#ws-modes [data-view="3d"]');
for (let i = 0; i < 60; i++) { if (await frameEval(b, "!!(zhbiExternalModels.layer && zhbiExternalModels.layer.getAllGroups().length)")) break; await b.sleep(500); }
ok("3D V2: модель благоустройства в сцене и видима", JSON.stringify(await frameEval(b, "zhbiExternalModels.layer.getAllGroups().map(g=>g.visible)")) === "[true]");
await click(b, '[data-tab="view"]'); await b.sleep(400);
ok("вкладка «Вид»: флажки «Благоустройство» и «Фасады из FBX»", await b.eval(`!!document.querySelector('input[data-ext=models]') && !!document.querySelector('input[data-ext=facades]') && document.querySelector('input[data-ext=models]').checked`));
await click(b, "input[data-ext=models]"); await b.sleep(800);
ok("снятие флажка скрывает модель в сцене (обработчик V1)", JSON.stringify(await frameEval(b, "[document.getElementById('zhbi-show-external-models').checked, ...zhbiExternalModels.layer.getAllGroups().map(g=>g.visible)]")) === "[false,false]");
ok("флажок в панели V2 отражает состояние сцены", await b.eval("!document.querySelector('input[data-ext=models]').checked"));
if (SHOTS) await b.shot(`${SHOTS}/appearance-ext-off.png`);
await click(b, "input[data-ext=models]"); await b.sleep(800);
ok("повторное включение показывает модель", JSON.stringify(await frameEval(b, "zhbiExternalModels.layer.getAllGroups().map(g=>g.visible)")) === "[true]");
ok("без ошибок страницы", b.exceptions.length === 0, b.exceptions.join(" | ").slice(0, 300));
await cleanup();
ok("загруженная для проверки модель удалена (SQL)", q1("select count(*) n from object_external_models where object_id=1").n === before);
await b.close();

// ---- 6. Ограниченная роль: личные настройки — только себе (сервер), user4 видит экран и меняет только своё
const u4 = await as("user4");
const me4 = q1("select id, ui_theme from users where domain_login='user4'");
ok("user4: гамма СЕБЕ — 200", (await u4.patch(`/users/${me4.id}/ui-theme`, { ui_theme: "sand" })).status === 200);
ok("user4: гамма ДРУГОМУ — 403", (await u4.patch(`/users/${admin.id}/ui-theme`, { ui_theme: "sand" })).status === 403);
ok("user4: ракурс ДРУГОМУ — 403", (await u4.patch(`/users/${admin.id}/view3d`, { view3d_pitch_deg: 40, view3d_yaw_deg: 0 })).status === 403);
ok("user4: порог подписей ДРУГОМУ — 403", (await u4.patch(`/users/${admin.id}/min-label-px`, { min_label_px: 14 })).status === 403);
await u4.patch(`/users/${me4.id}/ui-theme`, { ui_theme: me4.ui_theme });
ok("user4: гамма возвращена", q1(`select ui_theme t from users where id=${me4.id}`).t === me4.ui_theme);
const b4 = await session(BASE, "user4");
await go(b4, "appearance");
ok("user4: экран «Внешний вид» открыт (личная настройка, как пункт меню V1 без права)", await b4.eval("!!document.querySelector('#ap-shadows') && location.hash==='#/appearance'"));
await b4.close();
process.exit(summary());
