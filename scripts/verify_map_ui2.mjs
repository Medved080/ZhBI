// Браузерная проверка экрана «Карта проектов» V2 (map-screen.js), часть 2: кластер, отбор, «Показать
// все»/«Мой объект», перетаскивание/колесо, контекст WebGL при сворачивании/закреплении левой навигации и при
// перетаскивании ручки между списком и картой, права user2/user4. Только scripts/cdp.mjs (настоящие события).
//
// Запуск: MAP_BASE=http://127.0.0.1:8260 MAP_SHOTS=<каталог> node scripts/verify_map_ui2.mjs
import { launch } from "./cdp.mjs";
import { sleep, checker, tap, setObject, txt, exists, PASSWORD } from "./verify_mfr_lib.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.MAP_BASE || "http://127.0.0.1:8260";
const SHOTS = process.env.MAP_SHOTS || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const c = checker("map-screen-2");

async function installMapCapture(b) {
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (function(){
      Object.defineProperty(window, 'maplibregl', {
        configurable: true,
        set(lib) {
          if (lib && lib.Map && !lib.Map.__zhbiWrapped) {
            const Orig = lib.Map;
            function Wrapped(...args) { const inst = new Orig(...args); (window.__zhbiMaps = window.__zhbiMaps || []).push(inst); return inst; }
            Wrapped.prototype = Orig.prototype; Object.setPrototypeOf(Wrapped, Orig);
            for (const k of Object.keys(Orig)) { try { Wrapped[k] = Orig[k]; } catch (e) {} }
            Wrapped.__zhbiWrapped = true; lib.Map = Wrapped;
          }
          Object.defineProperty(window, 'maplibregl', { value: lib, writable: true, configurable: true });
        },
        get() { return undefined; },
      });
    })();
  ` });
}
const lastMap = (b) => `(window.__zhbiMaps||[])[(window.__zhbiMaps||[]).length-1]`;
async function mapState(b) { return b.eval(`(()=>{const m=${lastMap(b)};const c=m.getCenter();return{zoom:m.getZoom(),lng:c.lng,lat:c.lat}})()`); }
async function pixelOf(b, lon, lat) {
  return b.eval(`(()=>{const m=${lastMap(b)};const p=m.project([${lon},${lat}]);const r=document.querySelector('#mp-stage').getBoundingClientRect();return{x:Math.round(r.x+p.x),y:Math.round(r.y+p.y)}})()`);
}
const canvasCount = (b) => b.eval(`document.querySelectorAll('canvas').length`);
const mapCount = (b) => b.eval(`(window.__zhbiMaps||[]).length`);

async function login(b, user, objectId) {
  await b.goto(`${BASE}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type(user);
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object') || document.querySelector('.v2-note-page')`, 20000);
  if (objectId) await setObject(b, objectId);
}
async function waitMapReady(b) {
  await b.waitFor(`document.querySelector('.maplibregl-canvas')`, 20000);
  await b.waitFor(`document.querySelectorAll('#mp-list [data-goto]').length>0 || document.querySelector('.ws-msg-bad') || document.querySelector('.mp-side-empty')`, 25000);
  await sleep(300);
}
async function openMap(b) {
  await b.eval(`location.hash='#/map'`);
  await b.waitFor(`location.hash==='#/map'`);
  await waitMapReady(b);
}
// Смена текущего объекта шапкой, ПОКА экран «Карта» открыт, — тем же путём, что changeObject() в main.js:
// у не-рабочего-места это форсирует полную перерисовку ТЕКУЩЕГО экрана (новый экземпляр карты), поэтому после
// выбора ждём готовности заново — тем же условием, что и при первом заходе на экран.
async function setObjectOnMap(b, id) {
  await setObject(b, id);
  await waitMapReady(b);
}

const b = await launch({
  width: 1920, height: 1080,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
b.base = BASE; b.shots = SHOTS;
await installMapCapture(b);
try {
  // ================= admin: кластер, отбор, показать все / мой объект, drag/wheel =================
  await login(b, "admin", 5);
  await openMap(b);

  console.log("Клик по кластеру → приближение");
  await tap(b, "#mp-fit");
  await sleep(700);
  const zBefore = (await mapState(b)).zoom;
  const clusterFeature = await b.eval(`(()=>{const m=${lastMap(b)};const fs=m.queryRenderedFeatures(undefined,{layers:['кластеры']});if(!fs.length)return null;return fs[0].geometry.coordinates;})()`);
  c.ok(!!clusterFeature, "на общем виде есть хотя бы один кластер");
  if (clusterFeature) {
    const px = await pixelOf(b, clusterFeature[0], clusterFeature[1]);
    await b.click(px.x, px.y);
    await sleep(900);
    const zAfter = (await mapState(b)).zoom;
    c.ok(zAfter > zBefore, "клик по кластеру приблизил карту", `${zBefore} -> ${zAfter}`);
  }
  await shot(b, "06-cluster-zoom");

  console.log("Отбор: поиск текстом");
  await tap(b, "#mp-fit");
  await sleep(500);
  const rowsBefore = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  await b.clickSel("#mp-q"); await b.type("Объект-1");
  await sleep(400);
  const rowsAfterSearch = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  c.ok(rowsAfterSearch > 0 && rowsAfterSearch < rowsBefore, "поиск сузил список слева", `${rowsBefore} -> ${rowsAfterSearch}`);
  const srcCountAfterSearch = await b.eval(`${lastMap(b)}.getSource('объекты')._data.features.length`);
  c.ok(srcCountAfterSearch === rowsAfterSearch, "отбор применился и к самой карте (тот же источник точек)", srcCountAfterSearch);
  await b.eval(`document.querySelector('#mp-q').value=''; document.querySelector('#mp-q').dispatchEvent(new Event('input',{bubbles:true}))`);
  await sleep(400);

  console.log("Отбор: по статусу и по признаку загрузки модели");
  await b.eval(`(()=>{const s=document.querySelector('#mp-status-filter');s.value='completed';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  const rowsCompleted = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  c.ok(rowsCompleted > 0 && rowsCompleted < rowsBefore, "отбор по статусу «Завершён» сузил список", rowsCompleted);
  await b.eval(`(()=>{const s=document.querySelector('#mp-status-filter');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(200);
  await b.eval(`(()=>{const s=document.querySelector('#mp-tracked');s.value='no';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  const rowsNoModel = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  await b.eval(`(()=>{const s=document.querySelector('#mp-tracked');s.value='yes';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);
  const rowsModel = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  c.ok(rowsNoModel + rowsModel === rowsBefore && rowsModel > 0 && rowsNoModel > 0, "отбор «ведётся учёт»/«только в справочнике» дополняют друг друга до полного числа", `${rowsModel} + ${rowsNoModel} = ${rowsBefore}`);
  await b.eval(`(()=>{const s=document.querySelector('#mp-tracked');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(300);

  console.log("«Показать все» и «Мой объект»");
  // Навести — тем же приёмом, что и клик по строке списка (навести(id) даёт ГАРАНТИРОВАННЫЙ zoom:15, в
  // отличие от простого клика по метке — тот только открывает всплывашку, камеру не двигает, см. map.js).
  await tap(b, `#mp-list [data-goto="1"]`);
  await sleep(700);
  const zoomedIn = (await mapState(b)).zoom;
  c.ok(Math.abs(zoomedIn - 15) < 0.5, "наведение на объект дало масштаб 15 (для контраста с «Показать все»)", zoomedIn);
  await tap(b, "#mp-fit");
  await sleep(700);
  const zoomedOut = (await mapState(b)).zoom;
  c.ok(zoomedOut < zoomedIn - 1, "«Показать все» отдалило камеру от масштаба одной точки", `${zoomedIn} -> ${zoomedOut}`);
  // Объект-2 (проект-1) — без своих и без проектных координат (проверено SQL, app/project_map.py: оба lat NULL):
  // надёжный кандидат для проверки «текущий объект не показан на карте», не завязанный на порядок предыдущих шагов.
  await setObjectOnMap(b, 2);
  await tap(b, "#mp-current");
  await sleep(700);
  const st = await txt(b, "#mp-status");
  c.ok((st || "").includes("нет координат"), "«Мой объект» для объекта без координат — понятный текст (Объект-2)", st);
  await setObjectOnMap(b, 1);
  // Каждое построение карты само вызывает показатьВсе() (см. map.js: renderProjectMap), а смена объекта на
  // экране «Карта» форсирует ПОЛНЫЙ remount (main.js: changeObject) — сразу после waitMapReady камера ещё может
  // доигрывать этот автоматический общий вид; ждём результата клика опросом, а не фиксированной паузой.
  await sleep(300);
  await tap(b, "#mp-current");
  const centered = await b.waitFor(
    `(()=>{const m=${lastMap(b)};const c=m.getCenter();return (Math.abs(c.lng-35.415)<0.01&&Math.abs(c.lat-61.86)<0.01)?JSON.stringify({zoom:m.getZoom(),lng:c.lng,lat:c.lat}):false;})()`,
    6000,
  ).then((s) => JSON.parse(s)).catch(() => mapState(b));
  c.ok(Math.abs(centered.lng - 35.415) < 0.01 && Math.abs(centered.lat - 61.86) < 0.01, "«Мой объект» центрирует карту на текущем объекте (Объект-1)", JSON.stringify(centered));
  await shot(b, "07-my-object-centered");

  console.log("Перетаскивание (drag) и колесо (wheel) — реальные жесты");
  const stageRect = await b.eval(`(()=>{const r=document.querySelector('#mp-stage').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  const cx = stageRect.x + stageRect.w / 2, cy = stageRect.y + stageRect.h / 2;
  const beforeDrag = await mapState(b);
  await b.drag(cx, cy, cx - 220, cy - 140);
  await sleep(700);
  const afterDrag = await mapState(b);
  c.ok(afterDrag.lng !== beforeDrag.lng || afterDrag.lat !== beforeDrag.lat, "перетаскивание сдвинуло карту", JSON.stringify({ beforeDrag, afterDrag }));
  await sleep(500); // дать анимации перетаскивания полностью осесть — иначе колесо иногда «гасится» ещё идущим ease
  const beforeWheel = await mapState(b);
  await b.wheel(cx, cy, -400);
  await sleep(1200);
  const afterWheel = await mapState(b);
  c.ok(afterWheel.zoom !== beforeWheel.zoom, "колесо изменило масштаб", `${beforeWheel.zoom} -> ${afterWheel.zoom}`);

  // ================= контекст WebGL: сворачивание/закрепление левой навигации, ручка списка =================
  console.log("Контекст WebGL не пересоздаётся при работе с левой навигацией и шириной списка");
  const mapsBefore = await mapCount(b);
  const canvasesBefore = await canvasCount(b);
  await tap(b, "#v2-shellnav-menu");
  await sleep(500);
  await tap(b, "#v2-shellnav-pin");
  await sleep(500);
  await tap(b, "#v2-shellnav-pin"); // снять закрепление обратно
  await sleep(500);
  const panelRect = await b.eval(`(()=>{const r=document.querySelector('#mp-resize').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.drag(panelRect.x, panelRect.y, panelRect.x + 80, panelRect.y);
  await sleep(400);
  const mapsAfter = await mapCount(b);
  const canvasesAfter = await canvasCount(b);
  c.ok(mapsAfter === mapsBefore, "сворачивание/закрепление панели и перетаскивание ручки НЕ создали новый экземпляр карты", `${mapsBefore} -> ${mapsAfter}`);
  c.ok(canvasesAfter === canvasesBefore, "число WebGL-холстов не изменилось", `${canvasesBefore} -> ${canvasesAfter}`);
  await shot(b, "08-after-panel-resize");

  // ================= роли: user2 (project 1) и user4 (view, project 1) =================
  console.log("\nВход user2 (доступ к проекту-1: объект-1 с координатами, объект-2 без)");
  const b2 = await launch({ width: 1920, height: 1080, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  b2.base = BASE; b2.shots = SHOTS;
  await installMapCapture(b2);
  await login(b2, "user2", null);
  await openMap(b2);
  const rows2 = await b2.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  const status2 = await txt(b2, "#mp-status");
  console.log("  строк:", rows2, "статус:", status2);
  c.ok(rows2 === 1, "user2 видит на карте ровно один объект (доступ ограничен проектом-1)", rows2);
  c.ok(/Без координат: 1/.test(status2 || ""), "user2: «без координат» = 1 (Объект-2 того же проекта)", status2);
  const noCoordsHtml2 = await b2.eval(`(()=>{document.querySelector('.mp-nocoords')?.setAttribute('open','');return document.querySelector('.mp-nocoords')?.innerText || ''})()`);
  c.ok(/Объект-2/.test(noCoordsHtml2), "список «без координат» называет Объект-2 по имени, а не молчит", noCoordsHtml2);
  await shot(b2, "09-user2-scope");
  await b2.close();

  console.log("\nВход user4 (роль view, доступ к проекту-1)");
  const b4 = await launch({ width: 1920, height: 1080, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  b4.base = BASE; b4.shots = SHOTS;
  await installMapCapture(b4);
  await login(b4, "user4", null);
  await openMap(b4);
  const rows4 = await b4.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  c.ok(rows4 === 1, "user4 (view) видит тот же ограниченный набор — раздел «Отчёты» доступен и view-роли", rows4);
  // клик по метке и переход в рабочее место — доступен и view-роли (карта не требует прав записи)
  const px2 = await pixelOf(b4, 35.415, 61.86);
  await b4.click(px2.x, px2.y);
  await sleep(500);
  const btnRect4 = await b4.eval(`(()=>{const e=document.querySelector('.map-popup-open');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  c.ok(!!btnRect4, "user4 тоже видит карточку объекта по клику на метку");
  if (btnRect4) {
    await b4.click(btnRect4.x, btnRect4.y);
    await b4.waitFor(`location.hash==='#/ws-model'`, 10000).catch(() => {});
    await sleep(500);
    c.ok((await b4.eval("location.hash")) === "#/ws-model", "user4: переход в рабочее место сработал (роль view имеет доступ на чтение)");
  }
  await shot(b4, "10-user4-goto-workspace");
  await b4.close();

  c.done();
} finally {
  await b.close();
}

async function shot(bb, name) { if (bb.shots) await bb.shot(`${bb.shots}/${name}.png`); }
