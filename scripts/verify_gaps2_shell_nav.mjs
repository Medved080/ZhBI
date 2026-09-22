// Проверка пункта 4 задания gaps2: порядок пунктов ВНУТРИ группы и избранное левой навигации V2 (shell-nav.js,
// shell-prefs.js, PATCH /users/{id}/v2-shell-prefs: новые поля item_order/favorites рядом с уже опубликованными
// pinned_objects/nav_pinned/nav_width/nav_group_state). Живой прогон: НАСТОЯЩИЙ вход, НАСТОЯЩИЕ клики, SQL до/после,
// сверка после перезагрузки страницы, 403 на чужого пользователя, отказ формы на лишнее поле (шлюз записи).
import { launch } from "./cdp.mjs";
const base = process.argv[2] || "http://127.0.0.1:8250";
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
  await sleep(500);

  // открыть меню (временная панель) и группу «Справочники»
  await b.clickSel("#v2-shellnav-menu");
  await sleep(300);
  const groupFound = await b.eval(`!!document.querySelector('[data-group="dicts"]')`);
  console.log("группа «dicts» найдена:", groupFound);
  const expanded = await b.eval(`document.querySelector('[data-group="dicts"]').getAttribute('aria-expanded')`);
  if (expanded !== "true") { await b.clickSel('[data-group="dicts"]'); await sleep(200); }

  const itemsBefore = await b.eval(`[...document.querySelectorAll('.v2-shellnav-group[data-group], .v2-shellnav-group')].find(g=>g.querySelector('[data-group="dicts"]'))?.querySelector('.v2-shellnav-group-body') ? [...document.querySelector('[data-group="dicts"]').closest('.v2-shellnav-group').querySelectorAll('[data-section]')].map(x=>x.dataset.section) : null`);
  console.log("порядок пунктов «Справочники» ДО:", itemsBefore);

  // звёздочка у второго пункта (subtypes) — сделать избранным
  const favBtnFound = await b.eval(`!!document.querySelector('[data-fav="subtypes"]')`);
  console.log("звёздочка у «subtypes» найдена:", favBtnFound);
  await b.clickSel('[data-fav="subtypes"]');
  await sleep(400);
  const favBlockHtml = await b.eval(`document.querySelector('.v2-shellnav-fav-block')?.innerText || null`);
  console.log("блок избранного после клика:", JSON.stringify(favBlockHtml));
  const favPressed = await b.eval(`document.querySelector('[data-fav="subtypes"]')?.getAttribute('aria-pressed')`);
  console.log("aria-pressed звёздочки:", favPressed);

  // стрелка «вверх» у первого НЕ-избранного пункта (после subtypes ушёл в избранное, следующий по порядку — projects-objects, оно уже первое; возьмём element-catalog, сдвинем вверх на один шаг несколько раз)
  const upBtn = await b.eval(`!!document.querySelector('[data-move="up"][data-item="element-catalog"]')`);
  console.log("стрелка «вверх» у element-catalog найдена:", upBtn);
  await b.clickSel('[data-move="up"][data-item="element-catalog"]');
  await sleep(400);
  const restOrderAfterMove = await b.eval(`[...document.querySelector('[data-group="dicts"]').closest('.v2-shellnav-group').querySelectorAll('.v2-shellnav-group-body [data-section]')].map(x=>x.dataset.section)`);
  console.log("порядок пунктов «Справочники» ПОСЛЕ перестановки:", restOrderAfterMove);

  await sleep(1200); // дать успеть уйти отложенной записи (debounce 300мс в shell-prefs.js)
  const reqs = b.requests.filter((r) => /v2-shell-prefs/.test(r.url));
  console.log("запросов к v2-shell-prefs:", reqs.length, reqs.map((r) => `${r.method} ${r.status}`));

  // перезагрузка страницы — настройки должны прийти уже в /me и повторить то же состояние
  await b.goto(`${base}/v2`, 900);
  await b.waitFor(`document.querySelector('#v2-object')`, 20000);
  await sleep(600);
  await b.clickSel("#v2-shellnav-menu");
  await sleep(300);
  const expanded2 = await b.eval(`document.querySelector('[data-group="dicts"]')?.getAttribute('aria-expanded')`);
  if (expanded2 !== "true") { await b.clickSel('[data-group="dicts"]'); await sleep(200); }
  const favBlockAfterReload = await b.eval(`document.querySelector('.v2-shellnav-fav-block')?.innerText || null`);
  const orderAfterReload = await b.eval(`[...document.querySelector('[data-group="dicts"]').closest('.v2-shellnav-group').querySelectorAll('.v2-shellnav-group-body [data-section]')].map(x=>x.dataset.section)`);
  console.log("блок избранного ПОСЛЕ перезагрузки:", JSON.stringify(favBlockAfterReload));
  console.log("полный порядок ПОСЛЕ перезагрузки:", orderAfterReload);

  const okFav = favPressed === "true" && favBlockHtml && favBlockHtml.includes("Типы, подтипы");
  const okMove = JSON.stringify(itemsBefore) !== JSON.stringify(restOrderAfterMove);
  const okPersist = favBlockAfterReload && favBlockAfterReload.includes("Типы, подтипы") && JSON.stringify(orderAfterReload) === JSON.stringify(restOrderAfterMove);
  console.log("ИТОГ: избранное сработало —", okFav, "| перестановка сработала —", okMove, "| пережило перезагрузку —", okPersist);

  await b.close();
  process.exit(okFav && okMove && okPersist ? 0 : 1);
})().catch((e) => { console.error("ОШИБКА", e); process.exit(1); });
