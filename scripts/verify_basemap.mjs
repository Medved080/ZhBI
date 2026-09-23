// Проверка подложки карты (разбор 2026-09-22, Docs/v2-progress/basemap.md) на НАСТОЯЩЕМ backend
// (scripts/real_auth_server.py, временная копия БД) в безголовом Chrome с настоящими событиями мыши/колеса
// (scripts/cdp.mjs). WebGL — программный (SwiftShader), как в scripts/verify_map_ui.mjs.
//
//   BASEMAP_BASE=http://127.0.0.1:8330 BASEMAP_SHOTS=<каталог> node scripts/verify_basemap.mjs scenario <метка>
//     фиксированные виды (страна, регион, граница детального покрытия, Москва, Казань): какой файл виден
//     сверху в сетке 5×5 точек экрана, есть ли растр OSM в стиле (смешение), сколько тайлов подложки
//     воркер MapLibre вернул ПУСТЫМИ и почему, внешние запросы; снимок каждого вида. Годится для любой
//     версии map.js (id слоёв не важны: источник узнаётся по адресу файла).
//   BASEMAP_BASE=... node scripts/verify_basemap.mjs accept
//     приёмка на сервере, где доступны ОБА режима (файлы + «Карта из интернета»): переключатель, жесты
//     колесом/перетаскиванием через границу покрытия, перезагрузка и повторное открытие, ширина левой
//     навигации V2, V1 «Карта проектов», мини-карты «Проекты и объекты» V1 и V2, 1920×1080 и 1366×768,
//     офлайн-режим при полностью закрытом интернете (Chrome резолвит только 127.0.0.1).
//   BASEMAP_NO_INTERNET=1 BASEMAP_BASE=... node scripts/verify_basemap.mjs scenario offline-check
//     те же 12 обзорных видов без внешних DNS-запросов; режим карты остаётся «С сервера».
//
// Объекты стенда: копия БД с обнулёнными координатами и тремя синтетическими точками (Москва — внутри
// детального файла, Тула — на его южной границе, Казань — только обзорный файл); см. basemap.md.
import { launch } from "./cdp.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASEMAP_BASE || "http://127.0.0.1:8330";
const SHOTS = process.env.BASEMAP_SHOTS || null;
const PASSWORD = process.env.BASEMAP_PASSWORD || "Test-Pass-1234!";
const [MODE = "accept", TAG = "run"] = process.argv.slice(2);
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(`${SHOTS}/${TAG}`, { recursive: true });

// Перехват ЧЕРЕЗ CDP, не правкой продукта: экземпляры карты (для координат и проб) и итог каждой загрузки
// тайла в воркере (Actor.sendAsync «LT»/«RT»): «ok», «NULL» (тайл тихо пуст) или ошибка с причиной.
const HOOK = `(function(){
  window.__bm = { maps: [], loads: [], errors: [] };
  Object.defineProperty(window, 'maplibregl', { configurable: true,
    set(lib) {
      if (lib && lib.Map && !lib.Map.__bm) {
        const O = lib.Map;
        function W(...a) {
          const m = new O(...a); window.__bm.maps.push(m);
          m.on('error', (e) => window.__bm.errors.push(String(e && e.error && (e.error.message || e.error)) + ' @' + (e && e.sourceId || '')));
          try { const AP = Object.getPrototypeOf(m.style.dispatcher.actors[0]);
            if (!AP.__bm) { AP.__bm = true; const os = AP.sendAsync;
              AP.sendAsync = function(msg, ac) { const p = os.call(this, msg, ac);
                if (msg && (msg.type === 'LT' || msg.type === 'RT') && msg.data && msg.data.tileID && msg.data.type === 'vector') {
                  const c = msg.data.tileID.canonical, k = msg.data.source + ' ' + c.z + '/' + c.x + '/' + c.y;
                  p.then((r) => window.__bm.loads.push({ k, ok: !!r }), (e) => window.__bm.loads.push({ k, ok: false, why: String(e && e.message || e) }));
                }
                return p; }; } } catch (e) { window.__bm.hookError = String(e); }
          return m; }
        W.prototype = O.prototype; Object.setPrototypeOf(W, O);
        for (const k of Object.keys(O)) { try { W[k] = O[k]; } catch (e) {} }
        W.__bm = true; lib.Map = W;
      }
      Object.defineProperty(window, 'maplibregl', { value: lib, writable: true, configurable: true });
    }, get() { return undefined; } });
})();`;

async function browser({ width = 1920, height = 1080, noInternet = false } = {}) {
  const args = [...GL];
  // «Интернета нет»: любое имя, кроме 127.0.0.1, не резолвится — внешние запросы падают, не уходя в сеть.
  if (noInternet) args.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
  const b = await launch({ width, height, args });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  return b;
}

async function login(b, user = "admin") {
  await b.goto(`${BASE}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type(user);
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object') || document.querySelector('.v2-note-page')`, 20000);
}

const lastMap = `window.__bm.maps[window.__bm.maps.length-1]`;
async function waitMapReady(b, timeout = 45000) {
  await b.waitFor(`window.__bm.maps.length && ${lastMap}.isStyleLoaded()`, timeout);
}
async function settle(b, timeout = 45000) {
  await sleep(300);
  await b.waitFor(`(()=>{const m=${lastMap}; return m.loaded() && m.areTilesLoaded();})()`, timeout).catch(() => {});
  await sleep(600);
}
async function openV2Map(b) {
  await b.eval(`location.hash='#/map'`);
  await waitMapReady(b);
  await b.waitFor(`document.querySelectorAll('#mp-list [data-goto]').length>0`, 20000);
  await settle(b);
}

// Что нарисовано сверху в сетке 5×5 точек холста: файл подложки (по адресу его источника) или «—».
async function probe(b, grid = 5) {
  return b.eval(`(()=>{const m=${lastMap}; const st=m.getStyle(); const src={};
    for (const [id,s] of Object.entries(st.sources)) src[id] = s.type==='raster' ? 'osm' : s.url ? (s.url.match(/basemap-([a-z0-9_-]+)\\.pmtiles/)||[])[1] || id : id;
    const raster = Object.values(st.sources).some((s)=>s.type==='raster');
    const cv=m.getCanvas(), W=cv.clientWidth, H=cv.clientHeight, rows=[];
    for (let j=0;j<${grid};j++){ const row=[]; for (let i=0;i<${grid};i++){
      const f=m.queryRenderedFeatures([W*(i+.5)/${grid}, H*(j+.5)/${grid}]).find((x)=>x.layer.type==='fill' && (x.sourceLayer==='earth'||x.sourceLayer==='water'));
      row.push(f ? src[f.source] : '—'); } rows.push(row); }
    return {zoom:+m.getZoom().toFixed(2), raster, rows};})()`);
}
async function takeLoads(b) {
  const loads = await b.eval(`window.__bm.loads.splice(0)`);
  const bad = loads.filter((l) => !l.ok);
  return { n: loads.length, bad, why: [...new Set(bad.map((l) => (l.why || "пустой ответ воркера").replace(/.*glyphs\//, "глифы ")))] };
}
const external = (b) => b.requests.filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(BASE) && !/^https?:\/\/127\.0\.0\.1/.test(r.url));
const shot = async (b, name) => { if (SHOTS) await b.shot(`${SHOTS}/${TAG}/${name}.png`); };

// ------------------------------------------------------------------ сценарии А–Г (любая версия map.js)
const VIEWS = [
  ["01-страна-z3", [60, 58], 3], ["02-регион-z6", [37.6, 55.5], 6], ["03-регион-z7", [37.6, 55.5], 7],
  ["04-граница-юг-z9", [37.6, 54.25], 9], ["05-граница-юг-z11", [37.6, 54.2], 11], ["06-тула-z14", [37.6175, 54.2], 14],
  ["07-москва-z10", [37.62, 55.75], 10], ["08-москва-z12", [37.62, 55.75], 12], ["09-москва-z15", [37.62, 55.75], 15],
  ["10-снт-z12", [37.53, 55.38], 12], ["11-граница-запад-z12", [35.1, 55.5], 12], ["12-казань-z10", [49.11, 55.8], 10],
];
async function scenario() {
  const b = await browser({ width: 1600, height: 1000, noInternet: process.env.BASEMAP_NO_INTERNET === "1" });
  try {
    await login(b);
    await openV2Map(b);
    await takeLoads(b);
    const cfg = await b.eval(`fetch('/map/config').then(r=>r.json()).then(c=>({online:c.online, files:c.basemaps.map(x=>x.name)}))`);
    console.log(`сценарий ${TAG}: online=${cfg.online}, файлы=${cfg.files.join(",") || "нет"}, слои: ${await b.eval(`${lastMap}.getStyle().layers.length`)}`);
    let всегоПустых = 0, всегоДыр = 0, смешение = 0;
    for (const [name, center, zoom] of VIEWS) {
      await b.eval(`${lastMap}.jumpTo({center:${JSON.stringify(center)}, zoom:${zoom}}), 1`);
      await settle(b);
      const p = await probe(b);
      const l = await takeLoads(b);
      await shot(b, name);
      const клетки = p.rows.flat();
      const видно = [...new Set(клетки)].join("+");
      const дыр = клетки.filter((x) => x === "—").length;
      if (p.raster && клетки.some((x) => x !== "—")) смешение++;
      всегоПустых += l.bad.length; всегоДыр += дыр;
      console.log(`  ${name}: сверху ${видно}${p.raster ? " (+растр OSM в стиле)" : ""}; клеток без суши/воды ${дыр}/25; тайлов подложки ${l.n}, пустых ${l.bad.length}${l.why.length ? " — " + l.why.join("; ") : ""}`);
      if (process.env.BASEMAP_GRID) p.rows.forEach((r) => console.log("      " + r.join(" ")));
    }
    const ext = external(b);
    console.log(`  ИТОГ ${TAG}: пустых тайлов ${всегоПустых}, клеток без суши/воды ${всегоДыр}, видов со смешением растра и векторной подложки ${смешение}/${VIEWS.length}, внешних запросов ${ext.length}${ext.length ? " (" + [...new Set(ext.map((r) => new URL(r.url).host))].join(",") + ")" : ""}, ошибок карты ${(await b.eval("window.__bm.errors.length"))}, исключений ${b.exceptions.length}`);
  } finally { await b.close(); }
}

// ------------------------------------------------------------------ приёмка итоговой версии
const results = [];
const ok = (cond, label, extra = "") => { results.push(!!cond); console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${extra !== "" ? " — " + extra : ""}`); return !!cond; };
const warnShown = (b, sel = "") => b.eval(`[...document.querySelectorAll('${sel} .zhbi-basemap-warn')].some((x) => x.offsetParent !== null)`);
const pressed = (b, sel = "") => b.eval(`[...document.querySelectorAll('${sel} .zhbi-basemap-ctrl button[aria-pressed="true"]')].map(x=>x.dataset.basemap).join(',')`);
const sourcesKind = (b) => b.eval(`(()=>{const s=${lastMap}.getStyle().sources; return Object.entries(s).filter(([id])=>id.startsWith('подложка-')).map(([id,v])=>v.type).join(',')})()`);
async function mapRect(b, sel) { return b.rect(sel); }

async function checkView(b, label, { expectTop = null } = {}) {
  await settle(b);
  const p = await probe(b);
  const l = await takeLoads(b);
  const клетки = p.rows.flat();
  ok(l.bad.length === 0, `${label}: все тайлы подложки разобраны`, `${l.n} загрузок, пустых ${l.bad.length}${l.why.length ? " (" + l.why.join("; ") + ")" : ""}`);
  if (!p.raster) ok(!клетки.includes("—"), `${label}: нет клеток без суши/воды`, [...new Set(клетки)].join("+"));
  if (expectTop) ok(expectTop(p.rows), `${label}: сверху ожидаемый файл`, p.rows.map((r) => r.join("")).join(" | "));
  return p;
}

async function accept() {
  // ---------- V2 «Карта проектов», 1920×1080
  const b = await browser();
  try {
    console.log("V2 «Карта проектов»: режим по умолчанию и переключатель");
    await login(b);
    await b.eval(`localStorage.removeItem('zhbi.map.basemap'), 1`);
    await openV2Map(b);
    const cfg = await b.eval(`fetch('/map/config').then(r=>r.json())`);
    ok(cfg.online && cfg.basemaps.length >= 2, "стенд: включена карта из интернета и лежат оба файла", `online=${cfg.online}, файлов ${cfg.basemaps.length}`);
    ok((await pressed(b)) === "offline", "по умолчанию — «С сервера», если есть локальные файлы", await pressed(b));
    ok((await sourcesKind(b)) === "vector,vector", "по умолчанию в стиле только локальные векторные файлы", await sourcesKind(b));
    await shot(b, "a01-v2-offline-default");

    const nBeforeOnline = b.requests.length;
    await b.clickSel('.zhbi-basemap-ctrl button[data-basemap="online"]');
    await settle(b);
    ok((await pressed(b)) === "online", "явный выбор «Из интернета» переключил режим", await pressed(b));
    ok((await sourcesKind(b)) === "raster", "в режиме «Из интернета» в стиле только растр, векторных файлов нет", await sourcesKind(b));
    ok(b.requests.slice(nBeforeOnline).filter((r) => /\/map\/tiles\//.test(r.url)).length === 0,
      "в режиме «Из интернета» к файлам подложки не обращались");
    await shot(b, "a02-v2-online");

    const nReq = b.requests.length;
    await b.clickSel('.zhbi-basemap-ctrl button[data-basemap="offline"]');   // настоящий щелчок
    await settle(b);
    ok((await pressed(b)) === "offline", "щелчок «С сервера» переключил режим, кнопка отмечена", await pressed(b));
    ok((await sourcesKind(b)) === "vector,vector", "в режиме «С сервера» — только векторные файлы, растра нет", await sourcesKind(b));
    ok((await b.eval(`${lastMap}.getLayer('объекты-точки') && ${lastMap}.getLayer('кластеры') ? 1 : 0`)) === 1, "точки и кластеры объектов остались поверх подложки");
    const layerOrder = await b.eval(`${lastMap}.getStyle().layers.map(l=>l.id)`);
    ok(layerOrder.indexOf("кластеры") > Math.max(...layerOrder.map((id, i) => (id.startsWith("подложка-") ? i : -1))), "все слои подложки лежат ниже слоёв объектов");
    ok(b.requests.slice(nReq).filter((r) => /openstreetmap/.test(r.url)).length === 0, "после переключения в OSM не ходили");
    ok((await b.eval(`localStorage.getItem('zhbi.map.basemap')`)) === "offline", "выбор запомнен в localStorage");
    ok(!(await warnShown(b)), "при работающем интернете пометки «нет связи» нет");
    await shot(b, "a03-v2-offline");

    console.log("Колесо и перетаскивание через южную границу детального файла (Тула)");
    const st = await mapRect(b, "#mp-stage");
    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    await b.eval(`${lastMap}.jumpTo({center:[37.6175,54.2], zoom:8}), 1`);
    await checkView(b, "z8 у Тулы", { expectTop: (rows) => rows.flat().every((x) => x === "ru") });
    for (let i = 0; i < 6; i++) { await b.wheel(cx, cy, -500); await sleep(450); }   // настоящее колесо
    const z1 = await b.eval(`${lastMap}.getZoom()`);
    ok(z1 > 9.5, "колесо приблизило карту", z1.toFixed(2));
    await checkView(b, `z${z1.toFixed(1)} на границе`, {
      expectTop: (rows) => rows[0].every((x) => x === "msk") && rows.flat().every((x) => x === "msk" || x === "ru"),
    });
    await shot(b, "a03-border-zoomed");
    await b.drag(cx, cy, cx, cy - 350);   // настоящее перетаскивание — на юг, за границу покрытия
    const g = await checkView(b, "после перетаскивания на юг", { expectTop: (rows) => rows.flat().every((x) => x === "msk" || x === "ru") });
    ok(g.rows[4].some((x) => x === "ru"), "за границей покрытия — обзорный файл, а не пустота", g.rows[4].join(""));
    await shot(b, "a04-border-dragged");
    for (let i = 0; i < 6; i++) { await b.wheel(cx, cy, 500); await sleep(450); }
    await checkView(b, `отдаление до z${(await b.eval(`${lastMap}.getZoom()`)).toFixed(1)}`);

    console.log("Москва крупно и Казань (только обзорный файл)");
    await b.eval(`${lastMap}.jumpTo({center:[37.62,55.75], zoom:13}), 1`);
    await checkView(b, "Москва z13", { expectTop: (rows) => rows.flat().every((x) => x === "msk") });
    await b.wheel(cx, cy, -500); await sleep(600);
    await checkView(b, "Москва после колеса", { expectTop: (rows) => rows.flat().every((x) => x === "msk") });
    await shot(b, "a05-moscow");
    await b.eval(`${lastMap}.jumpTo({center:[49.11,55.8], zoom:11}), 1`);
    await checkView(b, "Казань z11", { expectTop: (rows) => rows.flat().every((x) => x === "ru") });
    await shot(b, "a06-kazan");

    console.log("Ширина левой навигации V2 и списка — холст подстраивается, карта не пересоздаётся");
    const maps0 = await b.eval(`window.__bm.maps.length`);
    const w0 = await b.eval(`${lastMap}.getCanvas().clientWidth`);
    await b.clickSel("#v2-shellnav-menu"); await sleep(500);
    await b.clickSel("#v2-shellnav-pin"); await sleep(700);
    const w1 = await b.eval(`${lastMap}.getCanvas().clientWidth`);
    const stW = await b.eval(`document.querySelector('#mp-stage').clientWidth`);
    ok(Math.abs(w1 - stW) <= 1, "после закрепления навигации холст = ширине области карты", `${w0} → ${w1} (область ${stW})`);
    await checkView(b, "после смены ширины навигации");
    await b.clickSel("#v2-shellnav-pin"); await sleep(700);
    const rz = await mapRect(b, "#mp-resize");
    await b.drag(rz.cx, rz.cy, rz.cx + 90, rz.cy); await sleep(500);
    ok(Math.abs((await b.eval(`${lastMap}.getCanvas().clientWidth`)) - (await b.eval(`document.querySelector('#mp-stage').clientWidth`))) <= 1, "после перетаскивания ручки списка холст = ширине области");
    ok((await b.eval(`window.__bm.maps.length`)) === maps0, "карта не пересоздавалась", `${maps0} → ${await b.eval(`window.__bm.maps.length`)}`);
    await checkView(b, "после перетаскивания ручки списка");

    console.log("1366×768 и 1920×1080: страница не прокручивается, переключатель не наезжает на кнопки масштаба");
    for (const [w, h] of [[1366, 768], [1920, 1080]]) {
      await b.viewport(w, h); await sleep(700);
      const d = await b.eval(`({sh:document.documentElement.scrollHeight, ih:innerHeight, sw:document.documentElement.scrollWidth, iw:innerWidth})`);
      ok(d.sh <= d.ih + 1 && d.sw <= d.iw + 1, `${w}×${h}: без прокрутки страницы`, JSON.stringify(d));
      const sw = await mapRect(b, "#mp-stage .zhbi-basemap-ctrl"), nav = await mapRect(b, "#mp-stage .maplibregl-ctrl-top-right"), stg = await mapRect(b, "#mp-stage");
      ok(sw && sw.x >= stg.x && sw.x + sw.w <= stg.x + stg.w && sw.x + sw.w < nav.x, `${w}×${h}: переключатель внутри карты и левее кнопок масштаба`);
      await checkView(b, `${w}×${h}`);
      await shot(b, `a07-${w}x${h}`);
    }

    console.log("Перезагрузка и повторное открытие: режим сохраняется, карта строится заново корректно");
    await b.goto(`${BASE}/v2`);
    await openV2Map(b);
    ok((await pressed(b)) === "offline", "после перезагрузки страницы выбран запомненный режим", await pressed(b));
    await checkView(b, "после перезагрузки");
    await b.eval(`location.hash='#/home'`); await sleep(800);
    ok((await b.eval(`document.querySelectorAll('canvas.maplibregl-canvas').length`)) === 0, "уход с экрана карты освободил холст");
    await openV2Map(b);
    ok((await b.eval(`document.querySelectorAll('canvas.maplibregl-canvas').length`)) === 1, "повторное открытие — один холст");
    await checkView(b, "повторное открытие");
    await b.clickSel('.zhbi-basemap-ctrl button[data-basemap="online"]'); await settle(b);
    ok((await sourcesKind(b)) === "raster" && (await pressed(b)) === "online", "обратное переключение «Из интернета» — снова только растр");

    console.log("V2 «Проекты и объекты»: мини-карта пина");
    await b.clickSel('.zhbi-basemap-ctrl button[data-basemap="offline"]'); await settle(b);
    await b.eval(`location.hash='#/projects-objects'`);
    await b.waitFor(`[...document.querySelectorAll('[data-project]')].some(x=>x.textContent.includes('ТЕСТ подложки'))`, 20000);
    const pid = await b.eval(`[...document.querySelectorAll('[data-project]')].find(x=>x.textContent.includes('ТЕСТ подложки')).dataset.project`);
    await b.eval(`document.querySelector('[data-project="${pid}"]').scrollIntoView({block:'center'}), 1`); await sleep(200);
    await b.clickSel(`[data-project="${pid}"]`);
    const oid = await b.waitFor(`[...document.querySelectorAll('[data-object]')].find(x=>x.textContent.includes('ТЕСТ-Москва-центр'))?.dataset.object`, 15000);
    await b.eval(`document.querySelector('[data-object="${oid}"]').scrollIntoView({block:'center'}), 1`); await sleep(200);
    await b.clickSel(`[data-object="${oid}"]`);
    await b.waitFor(`document.querySelector('#po-pin-map .maplibregl-canvas') && ${lastMap}.getContainer().closest('#po-pin-map') && ${lastMap}.isStyleLoaded()`, 30000);
    ok((await pressed(b, "#po-pin-map")) === "offline", "мини-карта V2 открылась в запомненном режиме «С сервера»");
    await checkView(b, "мини-карта V2 (Москва z15)", { expectTop: (rows) => rows.flat().every((x) => x === "msk") });
    await shot(b, "a08-v2-pin");

    console.log("V1 «Карта проектов» и мини-карта в «Проекты и объекты» — тот же map.js");
    await b.goto(`${BASE}/`);
    await b.waitFor(`document.querySelector('#btn-toolbar-map')`, 20000);
    await sleep(800);
    await b.clickSel("#btn-toolbar-map");
    await b.waitFor(`${lastMap} && ${lastMap}.getContainer().closest('#map-canvas') && ${lastMap}.isStyleLoaded()`, 30000);
    await b.waitFor(`document.querySelectorAll('#map-side .map-side-item').length>0`, 20000);
    ok((await pressed(b, "#map-canvas")) === "offline", "V1: карта открылась в режиме, выбранном в V2 (общий выбор)");
    await checkView(b, "V1 обзор");
    const v1 = await mapRect(b, "#map-canvas");
    await b.eval(`${lastMap}.jumpTo({center:[37.6,54.25], zoom:9}), 1`); await settle(b);
    for (let i = 0; i < 4; i++) { await b.wheel(v1.cx, v1.cy, -500); await sleep(450); }
    await b.drag(v1.cx, v1.cy, v1.cx - 200, v1.cy - 150);
    await checkView(b, "V1 после колеса и перетаскивания у границы", { expectTop: (rows) => rows.flat().every((x) => x === "msk" || x === "ru") });
    await shot(b, "a09-v1-map");
    await b.clickSel('#map-canvas .zhbi-basemap-ctrl button[data-basemap="online"]'); await settle(b);
    ok((await sourcesKind(b)) === "raster", "V1: переключение на «Из интернета» — только растр");
    await b.clickSel('#map-canvas .zhbi-basemap-ctrl button[data-basemap="offline"]'); await settle(b);
    ok((await sourcesKind(b)) === "vector,vector", "V1: обратно «С сервера» — только файлы");
    await b.clickSel("#map-close"); await sleep(400);
    await b.clickSel("#btn-toolbar-map");
    await b.waitFor(`${lastMap}.getContainer().closest('#map-canvas') && ${lastMap}.isStyleLoaded()`, 30000);
    await b.waitFor(`document.querySelectorAll('#map-side .map-side-item').length>0`, 20000);
    ok((await b.eval(`document.querySelectorAll('#map-canvas canvas.maplibregl-canvas').length`)) === 1, "V1: повторное открытие — один холст");
    await checkView(b, "V1 повторное открытие");
    // Мини-карта V1: строка списка → всплывашка → «Свойства объекта» (настоящие щелчки)
    await b.eval(`[...document.querySelectorAll('#map-side .map-side-item')].find(x=>x.textContent.includes('ТЕСТ-Тула'))?.scrollIntoView({block:'center'})`);
    const item = await b.eval(`(()=>{const e=[...document.querySelectorAll('#map-side .map-side-item')].find(x=>x.textContent.includes('ТЕСТ-Тула')); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await b.click(item.x, item.y);
    await b.waitFor(`document.querySelector('.maplibregl-popup .map-popup-open')`, 10000);
    await b.waitFor(`!${lastMap}.isMoving()`, 10000); await sleep(300);   // всплывашка едет вместе с полётом камеры
    await b.clickSel(".maplibregl-popup .map-popup-open");
    await b.waitFor(`document.querySelector('#catalog-pin-map .maplibregl-canvas') && ${lastMap}.getContainer().closest('#catalog-pin-map') && ${lastMap}.isStyleLoaded()`, 30000);
    ok((await pressed(b, "#catalog-pin-map")) === "offline", "V1: мини-карта пина в режиме «С сервера»");
    await checkView(b, "V1 мини-карта (Тула z15, граница покрытия)");
    await shot(b, "a10-v1-pin");
    ok(!(await warnShown(b)), "V1: пометки «нет связи» нет (интернет есть)");
    ok(b.exceptions.length === 0, "нет необработанных исключений на странице", b.exceptions.slice(0, 2).join(" | "));
  } finally { await b.close(); }

  // ---------- интернета нет вовсе
  console.log("Интернета нет (резолвится только 127.0.0.1)");
  const c = await browser({ noInternet: true });
  try {
    await login(c);
    await c.eval(`localStorage.setItem('zhbi.map.basemap','offline'), 1`);
    await openV2Map(c);
    ok((await sourcesKind(c)) === "vector,vector", "офлайн-режим: только файлы с сервера");
    const st = await mapRect(c, "#mp-stage");
    await c.eval(`${lastMap}.jumpTo({center:[37.62,55.75], zoom:11}), 1`);
    for (let i = 0; i < 4; i++) { await c.wheel(st.x + st.w / 2, st.y + st.h / 2, -500); await sleep(450); }
    await checkView(c, "без интернета, Москва после колеса", { expectTop: (rows) => rows.flat().every((x) => x === "msk") });
    await shot(c, "a11-no-internet-offline");
    ok(external(c).length === 0, "офлайн-режим не сделал НИ ОДНОГО внешнего запроса", external(c).map((r) => r.url).slice(0, 2).join(" "));
    await c.clickSel('.zhbi-basemap-ctrl button[data-basemap="online"]');
    await sleep(3000);
    ok((await pressed(c)) === "online" && (await sourcesKind(c)) === "raster", "выбран «Из интернета» — режим НЕ переключился сам обратно");
    ok(await warnShown(c), "при недоступном интернете переключатель говорит «нет связи»");
    await shot(c, "a12-no-internet-online");
    await c.clickSel('.zhbi-basemap-ctrl button[data-basemap="offline"]'); await settle(c);
    ok(!(await warnShown(c)), "вернулись «С сервера» — пометка снята");
    await checkView(c, "без интернета, снова «С сервера»");
  } finally { await c.close(); }

  const bad = results.filter((x) => !x).length;
  console.log(`\nприёмка подложки: ${results.length - bad} ok / ${bad} FAIL`);
  process.exitCode = bad ? 1 : 0;
}

if (MODE === "scenario") await scenario();
else await accept();
