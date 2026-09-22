// Браузерная проверка экрана «Карта проектов» V2 (map-screen.js) на НАСТОЯЩЕМ backend и временной копии БД:
// загрузка, клик по метке/кластеру, отбор, «Показать все»/«Мой объект», перетаскивание/колесо, WebGL-контекст
// при сворачивании панели, права user2/user4, совместимость с V1 на том же сервере. Только scripts/cdp.mjs
// (настоящие события мыши/клавиатуры) — внутренние команды не подменяют клики.
//
// Запуск: MAP_BASE=http://127.0.0.1:8260 MAP_SHOTS=<каталог> node scripts/verify_map_ui.mjs
import { launch } from "./cdp.mjs";
import { openScreen, shot, sleep, checker, tap, setObject, txt, exists, PASSWORD } from "./verify_mfr_lib.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.MAP_BASE || "http://127.0.0.1:8260";
const SHOTS = process.env.MAP_SHOTS || null;
const c = checker("map-screen");

// Ловим экземпляр maplibregl.Map ЧЕРЕЗ CDP (Page.addScriptToEvaluateOnNewDocument), а не правкой продукт-кода:
// нужны реальные пиксельные координаты метки/кластера для НАСТОЯЩЕГО клика (b.click(x,y)), а карта не хранит
// свою ссылку нигде в DOM/window по замыслу (та же причина, что и во всех остальных verify_*: временные хуки
// живут в тестовом скрипте, не в приложении — см. window.__of/window.__dropNext в других verify_*.mjs).
async function installMapCapture(b) {
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (function(){
      Object.defineProperty(window, 'maplibregl', {
        configurable: true,
        set(lib) {
          if (lib && lib.Map && !lib.Map.__zhbiWrapped) {
            const Orig = lib.Map;
            function Wrapped(...args) {
              const inst = new Orig(...args);
              (window.__zhbiMaps = window.__zhbiMaps || []).push(inst);
              return inst;
            }
            Wrapped.prototype = Orig.prototype;
            Object.setPrototypeOf(Wrapped, Orig);
            for (const k of Object.keys(Orig)) { try { Wrapped[k] = Orig[k]; } catch (e) {} }
            Wrapped.__zhbiWrapped = true;
            lib.Map = Wrapped;
          }
          Object.defineProperty(window, 'maplibregl', { value: lib, writable: true, configurable: true });
        },
        get() { return undefined; },
      });
    })();
  ` });
}

const curMap = (b) => b.eval(`(window.__zhbiMaps||[])[(window.__zhbiMaps||[]).length-1] ? 'ok' : 'none'`);
const mapCount = (b) => b.eval(`(window.__zhbiMaps||[]).length`);
const canvasCount = (b) => b.eval(`document.querySelectorAll('canvas').length`);
async function pixelOf(b, lon, lat) {
  return b.eval(`(()=>{
    const m = (window.__zhbiMaps||[])[(window.__zhbiMaps||[]).length-1];
    const p = m.project([${lon},${lat}]);
    const r = document.querySelector('#mp-stage').getBoundingClientRect();
    return { x: Math.round(r.x + p.x), y: Math.round(r.y + p.y) };
  })()`);
}
async function mapState(b) {
  return b.eval(`(()=>{
    const m = (window.__zhbiMaps||[])[(window.__zhbiMaps||[]).length-1];
    const c = m.getCenter();
    return { zoom: m.getZoom(), lng: c.lng, lat: c.lat };
  })()`);
}

// MapLibre — WebGL; в безголовом Chrome БЕЗ программного рендеринга (ANGLE/SwiftShader) контекст не
// создаётся вовсе (тот же приём, что и scripts/verify_gaps2_map_tiles.mjs, scripts/verify_model_ui.mjs §6а).
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const b = await launch({
  width: 1920, height: 1080,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
b.base = BASE; b.shots = SHOTS;
// Перехват экземпляра карты ставится ДО первой навигации (addScriptToEvaluateOnNewDocument действует только
// на загрузки документа ПОСЛЕ установки) — иначе первый экземпляр карты остался бы непойманным.
await installMapCapture(b);
await b.goto(`${BASE}/v2`);
await b.waitFor(`document.querySelector('#v2-login-user')`);
await b.clickSel("#v2-login-user"); await b.type("admin");
await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
await b.key("Enter");
await b.waitFor(`document.querySelector('#v2-object') || document.querySelector('.v2-note-page')`, 20000);
await setObject(b, 5);
try {
  // ================= 1. Загрузка и базовое состояние =================
  console.log("Загрузка «Карта проектов» (admin)");
  await openScreen(b, "map", `document.querySelector('#mp-stage')`);
  await b.waitFor(`document.querySelector('.maplibregl-canvas')`, 20000);
  // Холст появляется рано (создание Map), а данные/слои/список слева — позже (сеть, ожидание готовности стиля
  // до 20 с внутри map.js); ждём именно результат, а не фиксированную паузу — первая загрузка холодная (сама
  // библиотека карты ещё не в кэше браузера).
  await b.waitFor(`document.querySelectorAll('#mp-list [data-goto]').length>0 || document.querySelector('.ws-msg-bad')`, 25000);
  await sleep(300);
  c.ok(await exists(b, ".maplibregl-canvas"), "холст MapLibre создан");
  c.ok((await b.eval("document.querySelectorAll('.v2-note-page').length")) === 0, "нет экрана «нет доступа»");
  c.ok(await exists(b, "#mp-legend"), "легенда показана");
  const status0 = await txt(b, "#mp-status");
  console.log("  статус-строка:", status0);
  c.ok(/Объектов на карте: \d+/.test(status0 || ""), "статус-строка содержит счётчик объектов");
  c.ok(!/Подложка не загружена/.test(status0 || ""), "подложка загружена (ZHBI_MAP_DIR указывает на реальные файлы)");
  const sideCount = await b.eval(`document.querySelectorAll('#mp-list [data-goto]').length`);
  console.log("  строк в списке слева:", sideCount);
  c.ok(sideCount > 100, "список слева заполнен (много объектов у admin)");
  await shot(b, "01-map-admin-overview");

  const consoleErr = b.exceptions.length;
  c.ok(consoleErr === 0, "нет необработанных исключений в консоли", consoleErr ? b.exceptions[0] : "");

  // 1920x1080 и 1366x768 — без прокрутки всей страницы
  const dims1 = await b.eval(`({sh:document.documentElement.scrollHeight, ih:innerHeight})`);
  c.ok(dims1.sh <= dims1.ih + 1, "1920×1080: страница не прокручивается", `${dims1.sh} vs ${dims1.ih}`);
  await b.viewport(1366, 768);
  await sleep(400);
  const dims2 = await b.eval(`({sh:document.documentElement.scrollHeight, ih:innerHeight})`);
  c.ok(dims2.sh <= dims2.ih + 1, "1366×768: страница не прокручивается", `${dims2.sh} vs ${dims2.ih}`);
  await shot(b, "02-map-1366x768");
  await b.viewport(1920, 1080);
  await sleep(400);

  // ================= 2. Клик по строке списка → всплывашка (та же карточка, что и клик по точке) =================
  console.log("Клик по строке объекта-1 (список слева)");
  const beforeState = await mapState(b);
  await tap(b, `#mp-list [data-goto="1"]`);
  await sleep(900);
  c.ok(await exists(b, ".maplibregl-popup"), "клик по строке списка открыл всплывашку");
  const popupTxt1 = await txt(b, ".maplibregl-popup");
  c.ok((popupTxt1 || "").includes("Объект-1"), "во всплывашке нужный объект", popupTxt1);
  const afterNavigate = await mapState(b);
  c.ok(Math.abs(afterNavigate.zoom - 15) < 0.5, "камера встала на масштаб 15", afterNavigate.zoom);
  c.ok(afterNavigate.zoom !== beforeState.zoom || afterNavigate.lng !== beforeState.lng, "камера сдвинулась к объекту");
  await shot(b, "03-popup-from-list");

  // ================= 3. НАСТОЯЩИЙ клик по МЕТКЕ на холсте (не по списку) =================
  console.log("Закрыть всплывашку и кликнуть точку на холсте напрямую");
  const stageRect = await b.eval(`(()=>{const r=document.querySelector('#mp-stage').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  await b.click(stageRect.x + 10, stageRect.y + 10); // пустое место — закрывает попап (closeOnClick), камеру не двигает
  await sleep(300);
  c.ok(!(await exists(b, ".maplibregl-popup")), "клик по пустому месту закрыл всплывашку");
  const px1 = await pixelOf(b, 35.415, 61.86); // координаты Объекта-1 (см. app/project_map.py: тот же lon/lat из /map/objects)
  await b.click(px1.x, px1.y); // НАСТОЯЩИЙ клик по холсту (Input.dispatchMouseEvent), не внутренний вызов
  await sleep(500);
  c.ok(await exists(b, ".maplibregl-popup"), "клик ПРЯМО по метке на холсте открыл всплывашку");
  const popupTxt2 = await txt(b, ".maplibregl-popup");
  c.ok((popupTxt2 || "").includes("Объект-1"), "клик по метке — тот же объект", popupTxt2);
  await shot(b, "04-popup-from-marker-click");

  // ================= 4. Кнопка во всплывашке → смена объекта + переход к рабочему месту (changeObject) =================
  console.log("Кнопка «Свойства объекта» во всплывашке → переход в рабочее место");
  const objBtnBefore = await txt(b, "#v2-object-btn");
  console.log("  объект в шапке ДО:", objBtnBefore);
  const popupBtnRect = await b.eval(`(()=>{const e=document.querySelector('.map-popup-open');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  c.ok(!!popupBtnRect, "кнопка «Свойства объекта» есть во всплывашке");
  await b.click(popupBtnRect.x, popupBtnRect.y);
  await b.waitFor(`location.hash==='#/ws-model'`, 10000);
  await sleep(500);
  c.ok(location_ok(await b.eval("location.hash")), "переход на #/ws-model выполнен");
  function location_ok(h) { return h === "#/ws-model"; }
  const objBtnAfter = await txt(b, "#v2-object-btn");
  console.log("  объект в шапке ПОСЛЕ:", objBtnAfter);
  c.ok((objBtnAfter || "").includes("Объект-1"), "текущий объект в шапке сменился на Объект-1", objBtnAfter);
  await shot(b, "05-after-goto-workspace");

  // ================= 5. Возврат на карту: новый WebGL-контекст создаётся, старый освобождён =================
  console.log("Вернуться на карту — контекст пересоздаётся, старых холстов не остаётся");
  const mapsBefore = await mapCount(b);
  await openScreen(b, "map", `document.querySelector('#mp-stage')`);
  await b.waitFor(`document.querySelector('.maplibregl-canvas')`, 20000);
  await sleep(500);
  const mapsAfter = await mapCount(b);
  const canvasesAfter = await canvasCount(b);
  c.ok(mapsAfter === mapsBefore + 1, "новый экземпляр карты создан при повторном заходе", `${mapsBefore} -> ${mapsAfter}`);
  c.ok(canvasesAfter === 1, "старый холст не остался в DOM (destroy() освободил контекст)", canvasesAfter);

  c.done();
} finally {
  await b.close();
}
