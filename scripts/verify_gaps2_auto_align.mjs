// Проверка пункта 7 задания gaps2: «Совместить автоматически» для фасада (app/static/v2/exchange-external-models.js) —
// живой прогон реальной плутовки: вход, объект БЕЗ геометрии стен (Revit) → загрузка синтетического .fbx как «Фасад» →
// клик «Совместить автоматически» → полная цепочка (скачивание файла с сервера, разбор THREE/FBXLoader, извлечение
// стеновых сегментов, запрос маршрута `/objects/{object_id}/external-models/geometry-features`, попытка auto-align)
// должна дойти до конца и корректно сообщить «нет геометрии стен» — а НЕ упасть по ошибке импорта/парсинга где-то
// на середине. Отдельно — прямой HTTP:
// PATCH с auto_placement_status/auto_placement_diagnostics (новые поля шлюза) проходит, лишнее поле отклоняется,
// 403 у роли view.
import { launch } from "./cdp.mjs";
import { execFileSync } from "node:child_process";

const base = process.argv[2] || "http://127.0.0.1:8250";
const objectId = Number(process.argv[3] || 1); // объект БЕЗ revit_elements (см. подготовку сессии)
const PASSWORD = "Test-Pass-1234!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fbxPath = process.argv[4] || "/private/tmp/claude-501/-Users-max-zhbi-tool/788b45dd-b72e-49d3-ba64-2491a0ac0e5a/scratchpad/test-facade.fbx";

(async () => {
  const b = await launch({ width: 1600, height: 1000 });
  await b.goto(`${base}/v2`);
  await b.waitFor(`document.querySelector('#v2-login-user')`);
  await b.clickSel("#v2-login-user"); await b.type("admin");
  await b.clickSel("#v2-login-pass"); await b.type(PASSWORD);
  await b.key("Enter");
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  await sleep(600);
  await b.eval(`(()=>{const s=document.querySelector('#v2-object'); s.value=String(${objectId}); s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(600);
  await b.eval(`location.hash='#/external-models'`);
  await b.waitFor(`location.hash==='#/external-models'`, 10000);
  await sleep(800);

  // --- загрузка синтетического FBX как «Фасад» ---
  // Форма загрузки — под свёрнутым <details>«Загрузить FBX» по умолчанию: сначала раскрыть, иначе кнопка «Загрузить»
  // физически не на экране (клик по вычисленным координатам ничего не находит, событие click не долетает).
  const detailsOpen = await b.eval(`document.querySelector('#em-upload-details')?.open`);
  if (!detailsOpen) { await b.clickSel("#em-upload-details summary"); await sleep(200); }
  // Chrome DevTools Protocol: файл во input[type=file] через DOM.setFileInputFiles
  const nodeId = await b.eval(`document.querySelector('#em-file') ? 1 : 0`);
  console.log("поле выбора файла найдено:", !!nodeId);
  await b.send("DOM.enable", {});
  const docRes = await b.send("DOM.getDocument", {});
  const fileInput = await b.send("DOM.querySelector", { nodeId: docRes.root.nodeId, selector: "#em-file" });
  await b.send("DOM.setFileInputFiles", { files: [fbxPath], nodeId: fileInput.nodeId });
  await b.eval(`document.querySelector('#em-kind').value='facade'; document.querySelector('#em-kind').dispatchEvent(new Event('change',{bubbles:true}));`);
  await b.eval(`document.querySelector('#em-name').value='Тестовый фасад gaps2';`);
  await b.clickSel("#em-go");
  // Разбор синтетического (без текстур) FBX ждёт до 20с запасного таймаута LoadingManager.onLoad — тот же приём,
  // что и в scripts/v2_tests/exchange/chk_external_models.mjs (см. её комментарий), не баг.
  let confirmShown = false;
  for (let i = 0; i < 26 && !confirmShown; i++) { await sleep(1000); confirmShown = await b.eval(`!!document.querySelector('[data-choice="confirm"]')`); }
  console.log("диалог подтверждения показан:", confirmShown);
  if (confirmShown) { await b.clickSel('[data-choice="confirm"]'); await sleep(1500); }
  const uploadMsg = await b.eval(`document.querySelector('#em-upload-status')?.textContent || ""`);
  console.log("статус загрузки:", uploadMsg);

  await sleep(500);
  const rowFound = await b.eval(`!!document.querySelector('[data-auto-align]')`);
  console.log("кнопка «Совместить автоматически» найдена после загрузки:", rowFound);
  if (!rowFound) { console.log("ПРОВАЛ: модель не появилась в списке или кнопки нет"); await b.close(); process.exit(1); }

  // --- «Совместить автоматически» ---
  await b.clickSel("[data-auto-align]");
  // Тот же запасной 20с-таймаут разбора (повторный парсинг скачанного файла) + сам поиск (обычно быстрый, но
  // дать время) — ждём результат опросом, а не фиксированной паузой.
  let listMsg = "";
  for (let i = 0; i < 28; i++) {
    await sleep(1000);
    listMsg = await b.eval(`document.querySelector('#em-list-status')?.textContent || ""`);
    if (listMsg && listMsg !== "Скачиваю и разбираю файл модели…" && listMsg !== "Ищу совпадение с геометрией здания…") break;
  }
  console.log("статус после клика «Совместить автоматически»:", listMsg);
  console.log("exceptions:", b.exceptions.slice(-5));
  const netErr = b.requests.filter((r) => /external-models/.test(r.url) && r.status && r.status >= 400);
  console.log("сетевые ошибки external-models:", netErr.map((r) => `${r.method} ${r.url.replace(base,"")} -> ${r.status}`));

  const ok = /нет геометрии стен/.test(listMsg) && !b.exceptions.length;
  console.log(ok ? "ИТОГ (браузер): цепочка дошла до конца и корректно сообщила об отсутствии геометрии" : "ИТОГ (браузер): расхождение — см. выше");
  await b.close();

  // --- прямой HTTP: PATCH новых полей, 403, отказ на лишнее поле (шлюз проверяется тем, что страница его пропустила выше; здесь — backend) ---
  const login = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "admin", password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie");
  const list = await (await fetch(`${base}/objects/${objectId}/external-models`, { headers: { Cookie: cookie || "" } })).json();
  const model = (list.models || []).find((m) => m.name === "Тестовый фасад gaps2");
  console.log("модель для прямого HTTP-теста найдена:", !!model, model && model.id);
  if (model) {
    const patchOk = await fetch(`${base}/objects/${objectId}/external-models/${model.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie || "" },
      body: JSON.stringify({ offset_x_mm: 1234.5, offset_y_mm: -678.9, rotation_deg: 12.3, auto_placement_status: "confident", auto_placement_diagnostics: { timingMs: 42, note: "прямой HTTP-тест" }, expected_revision: model.revision }),
    });
    console.log("прямой PATCH с auto_placement_status:", patchOk.status);
    const after = await patchOk.json();
    console.log("сохранённый auto_placement_status:", after.auto_placement_status, "| offset:", after.offset_mm, "| rotation:", after.rotation_deg);

    const badStatus = await fetch(`${base}/objects/${objectId}/external-models/${model.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie || "" },
      body: JSON.stringify({ auto_placement_status: "not-a-real-status", expected_revision: after.revision }),
    });
    console.log("PATCH с недопустимым auto_placement_status (ждём 422):", badStatus.status);

    const login4 = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: "user4", password: PASSWORD }) });
    const cookie4 = login4.headers.get("set-cookie");
    const forbidden = await fetch(`${base}/objects/${objectId}/external-models/${model.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie4 || "" },
      body: JSON.stringify({ auto_placement_status: "confident", auto_placement_diagnostics: {}, expected_revision: after.revision }),
    });
    console.log("PATCH под user4 (роль view, ждём 403):", forbidden.status, (await forbidden.text()).slice(0, 150));

    // уборка тестовой модели
    const del = await fetch(`${base}/objects/${objectId}/external-models/${model.id}`, { method: "DELETE", headers: { Cookie: cookie || "" } });
    console.log("удаление тестовой модели:", del.status);
  }
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
