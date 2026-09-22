// Проверка пункта 1 задания gaps2: мини-карта расположения изделия в карточке (app/static/v2/element-ops.js) —
// маршрут `/elements/{element_id}/context` (backend готов, не менялся), SVG-виджет — новый. Живой прогон: НАСТОЯЩИЙ вход,
// НАСТОЯЩИЙ клик по изделию на схеме рабочего места «Модель», проверка что запрос к /elements/{id}/context ушёл,
// вернул 200 и SVG отрисовался с осями/зонами/меткой изделия (не текст «Нет геометрии для показа»).
import { launch } from "./cdp.mjs";

const base = process.argv[2] || "http://127.0.0.1:8250";
const objectId = Number(process.argv[3] || 1);   // объект 1 — ЖБИ (не МФР): нужна реальная схема/график по обычному объекту
const PASSWORD = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await launch({ width: 1600, height: 1000 });
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type("admin");
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  // Опции скрытого select#v2-object подгружаются асинхронно (после /projects-tree) — дожидаемся нужной, иначе
  // .value=... молча не находит совпадения и объект не меняется (найдено 2026-09-22 при проверке).
  await b.waitFor(`[...document.querySelectorAll('#v2-object option')].some(o=>o.value==='${objectId}')`, 15000);
  await sleep(500);
  await b.eval(`(()=>{const s=document.querySelector('#v2-object'); s.value=String(${objectId}); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(600);
  await b.eval(`location.hash='#/ws-model'`);
  await b.waitFor(`location.hash==='#/ws-model'`, 10000);
  await sleep(2500); // сцена V1 в кадре грузит план — дать время на первую отрисовку

  // выбрать любое изделие на схеме (клик по первому попавшемуся элементу 2D-плана внутри кадра встроенной сцены)
  const picked = await b.eval(`
    (() => {
      const frame = document.querySelector('.ws-frame');
      if (!frame || !frame.contentDocument) return "нет доступа к содержимому кадра (другой origin?)";
      const svgEl = frame.contentDocument.querySelector('#plan-svg [data-el-id], #plan-svg [data-id]');
      return svgEl ? "нашли элемент" : "элемент на плане не найден";
    })()
  `);
  console.log("поиск элемента на плане внутри кадра:", picked);

  // Кадр — отдельный документ (embed=scene), настоящий клик мышью по видимой точке кадра надёжнее, чем DOM-инспекция через contentDocument
  const frameRect = await b.rect(".ws-frame");
  console.log("рамка кадра:", frameRect);
  // Клик по центру области схемы — там почти наверняка что-то есть на densely-заполненном плане объекта с элементами
  await b.click(frameRect.cx, frameRect.cy);
  await sleep(1000);

  const cardText = await b.eval(`document.querySelector('.ws-panel, #v2-side')?.innerText?.slice(0,50) || ""`);
  console.log("панель справа (проверка что что-то выбралось):", JSON.stringify(cardText));

  const reqs = b.requests.filter((r) => /\/elements\/\d+\/context/.test(r.url));
  console.log("запросов к /elements/{id}/context:", reqs.length, reqs.map((r) => `${r.method} ${r.url.split("?")[0]} -> ${r.status}`));

  const svgFound = await b.eval(`!!document.querySelector('.eo-mm-svg')`);
  console.log("SVG мини-карты в DOM:", svgFound);
  const svgContent = await b.eval(`document.querySelector('.eo-mm-svg')?.innerHTML?.length || 0`);
  console.log("длина содержимого SVG (0 — пусто):", svgContent);
  const hint = await b.eval(`document.querySelector('.eo-mm-hint')?.textContent || ""`);
  console.log("подпись под картой (какая зона):", JSON.stringify(hint));

  const ok = reqs.length > 0 && reqs.every((r) => r.status === 200) && svgFound && svgContent > 50;
  console.log(ok ? "ИТОГ: РАБОТАЕТ — запрос ушёл, SVG отрисован" : "ИТОГ: НЕ подтверждено — см. диагностику выше");
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
