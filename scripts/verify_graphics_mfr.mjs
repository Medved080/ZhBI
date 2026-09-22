// Браузерная проверка МФР-части области «graphics» (V2) на НАСТОЯЩЕМ backend и временной копии БД (объект 4): привязка секции к
// осям выпадающим списком (mfr-structure.js) и мышиное перетаскивание геометрии блока (SVG-редактор, перенос из V1). Только
// scripts/cdp.mjs (настоящие события мыши и клавиатуры — Input.dispatchMouseEvent), никаких внутренних команд выбора.
//
// Запуск: GR_BASE=http://127.0.0.1:8280 GR_DB=/tmp/zhbi_graphics_copy/work.db GR_SHOTS=/tmp/gr_shots node scripts/verify_graphics_mfr.mjs
import { execFileSync } from "node:child_process";
import { session, openScreen, shot, sleep, checker, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.GR_BASE || "http://127.0.0.1:8280";
const DB = process.env.GR_DB;
const SHOTS = process.env.GR_SHOTS || null;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
// Запись в КОПИЮ БД для подготовки неполных ролей (см. регламент — «неполные роли готовь SQL в копии»): у user2/user4
// (`real_auth_server.py`) по умолчанию доступ только к объекту 1, а секции/блоки/геометрия есть только на объекте 4 —
// без явного доступа переключение объекта в шапке молча не находит объект 4 в списке, и проверка прав виснет на ожидании
// хэша, который никогда не проставляется.
const sqlw = (q) => execFileSync("sqlite3", [DB, `PRAGMA busy_timeout=5000; ${q}`], { encoding: "utf8" });
const c = checker("graphics-mfr");

async function setSelect(b, sel, value) {
  await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(String(value))}; e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function setVal(b, sel, v) {
  await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

// ============================================================== 1. МФР: ось секции выпадающим списком + drag геометрии блока (object 4, admin)
{
  const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
  try {
    console.log("== Блоки: привязка секции к осям — выпадающий список ==");
    await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
    await tap(b, '.v2-read-tab[data-tab="blocks"]');
    await b.waitFor(`document.querySelector('#st-sec-add')`);
    const secParking = one("SELECT id, axis_from, axis_to FROM object_sections WHERE object_id=4 AND code='Паркинг'");
    c.ok(secParking && secParking.axis_from === null && secParking.axis_to === null, "секция «Паркинг» исходно без осей (подготовка)");
    c.ok(await b.eval(`document.querySelector('[data-sec-axis="${secParking.id}"][data-axis-field="from"]')?.tagName`) === "SELECT", "привязка секции — SELECT, а не текстовое поле");

    // одна ось без второй — сервер отклоняет, БД не меняется (частичной записи нет)
    await setSelect(b, `[data-sec-axis="${secParking.id}"][data-axis-field="from"]`, "1с1");
    await b.waitFor(`/обе оси/.test(document.querySelector('#st-status')?.textContent || '')`, 8000).catch(() => {});
    await sleep(300);
    let secNow = one(`SELECT axis_from, axis_to FROM object_sections WHERE id=${secParking.id}`);
    c.ok(secNow.axis_from === null && secNow.axis_to === null, "выбор ТОЛЬКО «от» — сервер отклонил, БД не изменилась (без частичной записи)");
    await shot(b, "g-axis-one-side-error");

    // вторая ось — сохраняется
    await setSelect(b, `[data-sec-axis="${secParking.id}"][data-axis-field="to"]`, "15с1");
    await b.waitFor(`/сохранена/.test(document.querySelector('#st-status')?.textContent || '')`, 8000);
    secNow = one(`SELECT axis_from, axis_to FROM object_sections WHERE id=${secParking.id}`);
    c.ok(secNow.axis_from === "1с1" && secNow.axis_to === "15с1", "обе оси выбраны выпадающим списком — сохранены в БД (SQL)");
    await shot(b, "g-axis-saved");

    // перезагрузка — значение отображается тем же выбором в select. Пауза перед goto — статус «сохранена» показывается ДО
    // await afterWrite() (см. saveSection в mfr-structure.js), поэтому сразу после текста ещё может быть в полёте hasPendingWrites()
    // (шлюз beforeunload) — реальный пользователь тоже не перезагружает страницу в тот же миг, а настоящая навигация под CDP
    // без паузы иногда попадает на native-диалог beforeunload и виснет (Page.navigate без ответа, пойман 09-22).
    await sleep(500);
    await b.goto(`${BASE}/v2`); await b.waitFor(`document.querySelector('#v2-object')`, 20000);
    await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
    await tap(b, '.v2-read-tab[data-tab="blocks"]');
    await b.waitFor(`document.querySelector('#st-sec-add')`);
    const afterReload = await b.eval(`document.querySelector('[data-sec-axis="${secParking.id}"][data-axis-field="from"]')?.value`);
    c.ok(afterReload === "1с1", "после перезагрузки страницы select показывает сохранённое значение оси");

    console.log("== Геометрия блока: мышиное перетаскивание (перенос V1) ==");
    const blkA = one("SELECT id FROM blocks WHERE object_id=4 AND level_id=735 AND section_id=83");  // С01 (1552)
    const blkB = one("SELECT id FROM blocks WHERE object_id=4 AND level_id=735 AND section_id=84");  // С02 (1553), сосед вплотную
    await tap(b, `[data-geo-open="${blkA.id}"]`);
    await b.waitFor(`document.querySelector('#mfr-geo-svg')`, 10000);
    c.ok(await b.eval(`document.querySelectorAll('#mfr-geo-svg .mfr-geo-handle').length>0 && document.querySelectorAll('#mfr-geo-svg .mfr-geo-edge').length>0`), "редактор геометрии: ручки угла и рёбер отрисованы в SVG");
    // SVG уезжает ниже сгиба страницы (матрица + вкладки выше) — getBoundingClientRect() отдаёт корректные координаты и вне
    // видимой области, а Input.dispatchMouseEvent работает ТОЛЬКО в границах текущего окна: без скролла клики мимо экрана
    // молча ничего не находят (elementFromPoint тоже возвращает null) — жест не долетает ни до одного элемента.
    const scrollGeo = async () => { await b.eval(`document.getElementById('mfr-geo-svg').scrollIntoView({block:'center'})`); await sleep(200); };
    await scrollGeo();
    await shot(b, "g-geo-open");

    const before = one(`SELECT x0,x1,y0,y1 FROM block_boxes WHERE block_id=${blkA.id}`);
    const eastEdgeSel = `.mfr-geo-edge[data-box-i="0"][data-edge="e"]`;
    let r = await b.rect(eastEdgeSel);
    c.ok(!!r, "ручка восточного ребра найдена на экране (координаты)");
    console.log(`  восточное ребро на экране: x=${r.cx.toFixed(1)} y=${r.cy.toFixed(1)}`);
    // Настоящее перетаскивание мышью (Input.dispatchMouseEvent) — тянем восточное ребро блока С01 ВПРАВО, к границе соседней
    // секции С02 (боксы УЖЕ соприкасаются в БД) — по клампу граница дальше вправо не должна уйти. Жест разбит на отдельные
    // низкоуровневые события (а не одним вызовом b.drag), чтобы ПОСРЕДИ движения — до mouseReleased — прочитать живую подсказку
    // в SVG: одним b.drag() это увидеть нельзя (управление возвращается скрипту только после mouseup, когда paintGeo() уже
    // перерисовал и скрыл подсказку).
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx, y: r.cy, modifiers: 0, button: "none" });
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.cx, y: r.cy, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx + 60, y: r.cy, button: "left", buttons: 1, modifiers: 0 });
    await sleep(80);
    const hintShown = await b.eval(`(()=>{const h=document.getElementById('mfr-geo-hint'); return h && h.style.display!=='none' ? h.textContent : null;})()`);
    await shot(b, "g-geo-drag-blocked");
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx + 120, y: r.cy, button: "left", buttons: 1, modifiers: 0 });
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.cx + 120, y: r.cy, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
    c.ok(hintShown && hintShown.includes("С02"), `во время жеста (ДО отпускания кнопки мыши) показан живой упор в границу соседней секции: «${hintShown}»`);
    await tap(b, "#st-geo-save");
    await b.waitFor(`/Геометрия сохранена|Упирается/.test(document.querySelector('.mfr-struct-geo p.mfr-status')?.textContent || '')`, 8000).catch(() => {});
    await sleep(300);
    const afterBlocked = one(`SELECT x0,x1,y0,y1 FROM block_boxes WHERE block_id=${blkA.id}`);
    c.ok(Math.abs(afterBlocked.x1 - before.x1) < 1, `настоящее перетаскивание мышью ВПРАВО НЕ сдвинуло границу за соседа (x1 было ${before.x1.toFixed(1)}, стало ${afterBlocked.x1.toFixed(1)})`);
    const neighborBox = one(`SELECT x0 FROM block_boxes WHERE block_id=${blkB.id}`);
    c.ok(Math.abs(afterBlocked.x1 - neighborBox.x0) < 1, "геометрия СОСЕДНЕГО блока (С02) не изменилась побочно");

    // Свободное направление — запад, там соседей нет: настоящее перетаскивание должно реально сдвинуть границу.
    await scrollGeo();
    const westEdgeSel = `.mfr-geo-edge[data-box-i="0"][data-edge="w"]`;
    r = await b.rect(westEdgeSel);
    console.log(`  западное ребро на экране: x=${r.cx.toFixed(1)} y=${r.cy.toFixed(1)}`);
    await b.drag(r.cx, r.cy, r.cx - 100, r.cy, { steps: 10 });
    await sleep(150);
    await shot(b, "g-geo-drag-free");
    await tap(b, "#st-geo-save");
    await b.waitFor(`/Геометрия сохранена/.test(document.querySelector('.mfr-struct-geo p.mfr-status')?.textContent || '')`, 8000);
    const afterFree = one(`SELECT x0,x1,y0,y1 FROM block_boxes WHERE block_id=${blkA.id}`);
    const movedBy = before.x0 - afterFree.x0;
    c.ok(movedBy > 500, `настоящее перетаскивание мышью ВЛЕВО реально сдвинуло границу x0 (было ${before.x0.toFixed(1)}, стало ${afterFree.x0.toFixed(1)}, сдвиг ${movedBy.toFixed(1)} мм) — координаты СОВПАДАЮТ с направлением жеста мыши`);

    // числовое поле — альтернативный способ ввода ТОГО ЖЕ значения (не убран). Правим x0 (запад — свободное направление, как и
    // в drag-тесте выше: у блока «Рампа» есть сосед по y1 — она стоит НАД С01, — а по x0 на этом уровне соседей нет).
    const numSel = `[data-box-i="0"][data-field="x0"]`;
    c.ok(await b.eval(`!!document.querySelector(${JSON.stringify(numSel)})`), "числовое поле рядом с перетаскиванием осталось (альтернативный ввод)");
    const beforeNum = one(`SELECT x0 FROM block_boxes WHERE block_id=${blkA.id}`);
    // Статус «Геометрия сохранена.» уже висит с прошлого сохранения (запад) — ждать ЕГО текст бессмысленно, он не меняется от
    // нового сохранения с тем же итогом; считаем именно НОВЫЙ PUT (число запросов до/после), иначе проверка «зелёная» и без
    // повторной записи. Кнопка ненадолго блокируется собственным фоновым afterWrite() прошлого сохранения — короткое ожидание
    // перед кликом штатно, само сохранение больше не пропадает (грузы осей больше не дублируются на каждую запись, см. load()).
    const putsBefore = b.requests.filter((x) => x.method === "PUT").length;
    await setVal(b, numSel, String(Math.round(beforeNum.x0) - 777));
    await b.waitFor(`document.getElementById('st-geo-save') && !document.getElementById('st-geo-save').disabled`, 8000);
    await tap(b, "#st-geo-save");
    for (let i = 0; i < 40 && b.requests.filter((x) => x.method === "PUT" && x.status !== undefined).length <= putsBefore; i++) await sleep(200);
    c.ok(b.requests.filter((x) => x.method === "PUT" && x.status !== undefined).length > putsBefore, "клик «Сохранить» после правки числового поля реально отправил НОВЫЙ PUT (не переиспользовал старый статус)");
    const afterNum = one(`SELECT x0 FROM block_boxes WHERE block_id=${blkA.id}`);
    c.ok(Math.abs(afterNum.x0 - (beforeNum.x0 - 777)) < 1, "числовое поле по-прежнему меняет ТУ ЖЕ геометрию (SQL)");

    // перезагрузка страницы — сохранённая геометрия (после drag) видна снова; та же пауза перед goto, см. комментарий выше
    await sleep(500);
    await b.goto(`${BASE}/v2`); await b.waitFor(`document.querySelector('#v2-object')`, 20000);
    await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
    await tap(b, '.v2-read-tab[data-tab="blocks"]');
    await b.waitFor(`document.querySelector('#st-sec-add')`);
    await tap(b, `[data-geo-open="${blkA.id}"]`);
    await b.waitFor(`document.querySelector('#mfr-geo-svg')`, 10000);
    const reloadedX0 = await b.eval(`Number(document.querySelector('[data-box-i="0"][data-field="x0"]')?.value)`);
    c.ok(Math.abs(reloadedX0 - Math.round(afterNum.x0)) <= 1, "после перезагрузки страницы результат перетаскивания виден снова (успех переживает reload)");
  } finally { await b.close(); }
}

// ============================================================== 2. МФР: роль user2 (read) и user4 (view) — нет записи (object 4)
// Подготовка: по умолчанию (real_auth_server.py) у user2/user4 доступ только к объекту 1, где нет секций/блоков — без явного
// доступа к объекту 4 переключатель объекта в шапке не находит его в своём списке. project_id объекта 4 — из самой копии,
// а не захардкожен, чтобы не разойтись с исходником при пересборке копии.
{
  const projId = one("SELECT project_id FROM objects WHERE id=4").project_id;
  const user2Id = one("SELECT id FROM users WHERE domain_login='user2'").id;
  const user4Id = one("SELECT id FROM users WHERE domain_login='user4'").id;
  sqlw(`INSERT OR IGNORE INTO user_access (user_id, project_id, object_id, role) VALUES (${user2Id}, ${projId}, 4, 'user');`);
  sqlw(`INSERT OR IGNORE INTO user_access (user_id, project_id, object_id, role) VALUES (${user4Id}, ${projId}, 4, 'view');`);
}
for (const [user, label] of [["user2", "user2 (роль «user»)"], ["user4", "user4 (роль «view»)"]]) {
  const b = await session({ base: BASE, user, objectId: 4, shots: SHOTS });
  try {
    console.log(`== Блоки: права ${label} ==`);
    await openScreen(b, "blocks", `document.querySelectorAll('.v2-read-tab').length>0`);
    await tap(b, '.v2-read-tab[data-tab="blocks"]');
    await b.waitFor(`document.querySelector('.mfr-struct-cols')`);
    c.ok(!(await b.eval(`!!document.querySelector('#st-sec-add')`)), `${label}: кнопка «Добавить» секцию не отрисована (интерфейс read-only)`);
    c.ok((await b.eval(`document.querySelector('[data-sec-axis]')`)) === null, `${label}: привязка осей показана текстом, не select'ом`);
    const secParking = one("SELECT id FROM object_sections WHERE object_id=4 AND code='Паркинг'");
    const resp = await b.eval(`fetch('/objects/4/sections/${secParking.id}', {method:'PATCH', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({name:'Паркинг', axis_from:'1с1', axis_to:'15с1'})}).then(r=>r.status)`);
    c.ok(resp === 403, `${label}: прямой PATCH секции — сервер отвечает 403 (${resp})`);
    const blkA = one("SELECT id FROM blocks WHERE object_id=4 AND level_id=735 AND section_id=83");
    const respGeo = await b.eval(`fetch('/objects/4/blocks/${blkA.id}/boxes', {method:'PUT', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({boxes:[{x0:0,x1:1000,y0:0,y1:1000}]})}).then(r=>r.status)`);
    c.ok(respGeo === 403, `${label}: прямой PUT геометрии блока — сервер отвечает 403 (${respGeo})`);
  } finally { await b.close(); }
}

process.exit(c.done() > 0 ? 1 : 0);
