// Проверка пункта 5 задания gaps2: GET /map/tiles/{name} числился «только переход в V1» в матрице, хотя реально
// уже вызывается из V2 — «Проекты и объекты» (app/static/v2/projects-objects.js) подключает ТОТ ЖЕ ES-модуль V1
// (`/static/map.js`), что классификатор адресов, и строит мини-карту с пином (`createPinMap`) на каждое открытие
// карточки проекта/объекта. MapLibre запрашивает файл подложки протоколом `pmtiles://`, URL которого приходит с
// сервера строкой (`GET /map/config` → `basemaps()[].url`), а не литералом в исходнике V2 — статический разбор
// матрицы такое не видит (тот же класс пропуска, что markSpec.endpoint/sec.endpoint — см. gen_v2_operations.py).
//
// ВАЖНО: MapLibre требует WebGL — в безголовом Chrome БЕЗ программного рендеринга контекст не создаётся, и до
// сетевого запроса тайлов дело не доходит (в DOM остаётся текст «Карта недоступна: …WebGL…»). Поэтому здесь
// запускается Chrome с флагами программного WebGL (ANGLE/SwiftShader) — без них ложно выглядело бы «не работает».
//
// Нужен файл подложки на диске сервера (`ZHBI_MAP_DIR`, по умолчанию `data/map/*.pmtiles`) — сам по себе он не
// содержит ничего о заказчике (карта России из OpenStreetMap/Protomaps), в этом worktree его нет (data/ вне git),
// поэтому сервер запускается с `ZHBI_MAP_DIR=/Users/max/zhbi-tool/data/map` (чтение чужого каталога разрешено
// правилами исполнителя — «Читать /Users/max/zhbi-tool можно, ПИСАТЬ туда нельзя»).
import { launch } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:8250";
const projectId = process.argv[3] || "1";
const PASSWORD = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await launch({
    width: 1600, height: 1000,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type("admin");
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  await sleep(600);
  await b.eval(`location.hash='#/projects-objects'`);
  await b.waitFor(`location.hash==='#/projects-objects'`, 10000);
  await sleep(1200);
  const rowFound = await b.eval(`!!document.querySelector('[data-project="${projectId}"]')`);
  console.log(`строка проекта ${projectId} найдена:`, rowFound);
  if (!rowFound) { console.log("ПРОВАЛ: нет такого проекта в дереве, укажите существующий id вторым аргументом"); await b.close(); process.exit(1); }
  await b.clickSel(`[data-project="${projectId}"]`);
  await sleep(2500);
  const mapNote = await b.eval(`document.querySelector('#po-pin-map .v2-note')?.textContent || null`);
  console.log("текст ошибки карты (null — рендер прошёл):", mapNote);
  const canvasFound = await b.eval(`!!document.querySelector('#po-pin-map canvas')`);
  console.log("canvas MapLibre создан:", canvasFound);
  const reqs = b.requests.filter((r) => /\/map\/(config|tiles\/)/.test(r.url));
  console.log("запросы к /map/config и /map/tiles/*:", reqs.map((r) => `${r.method} ${r.url.replace(base, "")} -> ${r.status}`));
  const configOk = reqs.some((r) => r.url.includes("/map/config") && r.status === 200);
  const tilesOk = reqs.some((r) => /\/map\/tiles\/.+\.pmtiles/.test(r.url) && (r.status === 206 || r.status === 200));
  const ok = configOk && tilesOk && canvasFound && !mapNote;
  console.log(ok ? "ИТОГ: ПОДТВЕРЖДЕНО — V2 уже вызывает /map/tiles/{name} через переиспользованный map.js" : "ИТОГ: НЕ подтверждено");
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
