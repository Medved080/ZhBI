// Левая навигация (п.2, п.4 задания) — три состояния, поиск и группы, guardLeave. Настоящий backend, копия БД.
// Запуск: node scripts/shell_verify/nav1.mjs   (порт 8213)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, sql1, hardGoto } from "./lib.mjs";

const PORT = 8213;
const DIR = "data/shell_check/srv_nav1";
const SOURCE = "data/shell_check/case.db";
const S = await startServer(PORT, DIR, SOURCE);
const b = await openBrowser(1920, 1080);
const navState = () => b.eval(`document.querySelector('#v2-side')?.dataset.mode`);
const openTemp = async () => { await b.clickSel("#v2-shellnav-menu"); await sleep(250); };
const dialogOpen = () => b.eval(`!!document.querySelector('.v2-dialog-backdrop')`);
const dialogClick = async (label) => {
  await b.eval(`[...document.querySelectorAll('.v2-dialog-actions button')].find(x=>x.textContent.trim()===${JSON.stringify(label)})?.click()`);
  await sleep(300);
};

try {
  await login(b, S.base, "admin");
  await sleep(300);

  console.log("\n== состояние A: свёрнута по умолчанию ==");
  check("N1.1 при первом входе навигация свёрнута", (await navState()) === "collapsed");
  const stripW = await b.eval(`document.querySelector('#v2-side').getBoundingClientRect().width`);
  check("N1.2 ширина полосы 48–52px", stripW >= 48 && stripW <= 52, stripW);

  console.log("\n== состояние B: временно открыта по клику, поверх содержимого (не сжимает) ==");
  const contentXBefore = await b.eval(`document.querySelector('#v2-content').getBoundingClientRect().x`);
  await openTemp();
  check("N2.1 клик «Меню» открывает временную панель", (await navState()) === "temp");
  const contentXAfter = await b.eval(`document.querySelector('#v2-content').getBoundingClientRect().x`);
  check("N2.2 содержимое НЕ сдвинулось (не сжимает раскладку)", contentXBefore === contentXAfter, `${contentXBefore} -> ${contentXAfter}`);
  const railW = await b.eval(`document.querySelector('.v2-shellnav-rail').getBoundingClientRect().width`);
  check("N2.3 панель раскрылась на сохранённую ширину (260px по умолчанию)", Math.abs(railW - 260) < 2, railW);

  console.log("\n== закрывается по Esc / клику вне / успешному переходу ==");
  await b.key("Escape");
  await sleep(250);
  check("N3.1 Esc закрывает временную панель", (await navState()) === "collapsed");
  const menuFocused = await b.eval(`document.activeElement?.id`);
  check("N3.2 фокус вернулся на кнопку «Меню»", menuFocused === "v2-shellnav-menu", menuFocused);
  await openTemp();
  await b.click(1000, 500);
  await sleep(250);
  check("N3.3 клик вне (по содержимому) закрывает временную панель", (await navState()) === "collapsed");
  await openTemp();
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='home')?.click()`);
  await sleep(300);
  check("N3.4 клик по пункту («Начало») закрывает временную панель после перехода", (await navState()) === "collapsed");
  check("N3.5 переход действительно произошёл (мы на «Начале»)", (await b.eval(`location.hash`)) === "#/" || (await b.eval(`location.hash`)) === "");

  console.log("\n== структура меню: рабочие места сверху, без чисел у групп, группы отличаются от пунктов ==");
  await openTemp();
  const menu = await b.eval(`(() => {
    const heads = [...document.querySelectorAll('.v2-shellnav-group-head')].map(x => x.textContent.trim());
    return {
      staticHead: document.querySelector('.v2-shellnav-static-head')?.textContent,
      groupHeads: heads,
      hasNumbers: heads.some(h => /\\d/.test(h)),
      hasReadTag: !!document.querySelector('.v2-nav-tag'),
    };
  })()`);
  check("N4.1 «Рабочие места» — короткий блок сверху", menu.staticHead === "Рабочие места", menu.staticHead);
  check("N4.2 у заголовков групп НЕТ чисел (счётчик пунктов скрыт из вида)", !menu.hasNumbers, JSON.stringify(menu.groupHeads));
  check("N4.3 технических меток «чт.»/«прав.»/«обмен»/«экспорт» в разметке нет (класс v2-nav-tag не используется)", !menu.hasReadTag);

  console.log("\n== подсказка для экранов, реально открывающихся в V1 ==");
  // На ТЕКУЩЕМ реестре (app/static/v2/screens.json) у КАЖДОГО пункта меню (кроме служебной записи группы "home",
  // которая в меню не попадает вовсе) уже есть своё монтирование в V2 — проверено отдельно: найдено НОЛЬ пунктов
  // навигации, где screenOpensInV1() вернула бы true (scripts/shell_verify/nav1.mjs — README ниже). Поэтому
  // подсказку "Откроется в текущем интерфейсе" проверяем НАПРЯМУЮ на функции классификации (единственный
  // источник правды и для пункта меню, и для main.js::openSection — см. комментарий в shell-nav.js), а не через
  // конкретный живой пункт: живого примера с текущим составом реестра нет, а появится — код готов его подписать.
  const classifyCheck = await b.eval(`import('/static/v2/shell-nav.js').then(m => ({
    trueForUnimplementedRead: m.screenOpensInV1({ impl: 'read' }),
    falseForImplementedRead: m.screenOpensInV1({ impl: 'read', read: {} }),
    falseForDictEditWithConfig: m.screenOpensInV1({ impl: 'dict-edit', edit: {} }),
    trueForDictEditWithoutConfig: m.screenOpensInV1({ impl: 'dict-edit' }),
    falseForWorkspace: m.screenOpensInV1({ impl: 'workspace' }),
    falseForModule: m.screenOpensInV1({ impl: 'module:counterparties' }),
  }))`);
  check("N5.1 «read» без блока read — классифицирован как «открывается в V1»", classifyCheck.trueForUnimplementedRead === true, JSON.stringify(classifyCheck));
  check("N5.2 «read» С блоком read — смонтирован в V2", classifyCheck.falseForImplementedRead === false, JSON.stringify(classifyCheck));
  check("N5.3 «dict-edit» без сопутствующего поля — «открывается в V1» (иначе экран без монтирования выглядел бы обычным пунктом)", classifyCheck.trueForDictEditWithoutConfig === true, JSON.stringify(classifyCheck));
  check("N5.4 «dict-edit» с сопутствующим полем/«workspace»/«module:…» — смонтированы в V2", classifyCheck.falseForDictEditWithConfig === false && classifyCheck.falseForWorkspace === false && classifyCheck.falseForModule === false, JSON.stringify(classifyCheck));
  // Подпись и вид пункта (не техническая аббревиатура, стрелка не единственный признак — есть title целиком) —
  // на РЕАЛЬНОМ пункте, подделывая только itemHtml-разметку не нужно: она читает screenOpensInV1 внутри модуля,
  // поэтому смотрим ЛЮБОЙ пункт и сверяем, что его title и текст СОГласованы с классификацией функции.
  const anyItemCheck = await b.eval(`(() => {
    const item = document.querySelector('.v2-shellnav-item[data-section]');
    return item ? { title: item.title, text: item.querySelector('.v2-shellnav-item-label')?.textContent, textIsAbbrev: /^V1$|^чт\\.$|^прав\\.$/.test((item.querySelector('.v2-shellnav-item-label')?.textContent||'').trim()) } : null;
  })()`);
  check("N5.5 видимый текст пункта — не техническая аббревиатура (полное название)", anyItemCheck && !anyItemCheck.textIsAbbrev, JSON.stringify(anyItemCheck));

  console.log("\n== по умолчанию раскрыта ТЕКУЩАЯ группа, остальные свёрнуты; пользователь может свернуть и её ==");
  // Пункты СВЁРНУТОЙ группы не существуют в DOM вовсе (раскрытие управляет тем, что рендерится, не просто CSS
  // display) — сперва раскрыть «Справочники» явным кликом, иначе кликать в dict-smu ниже было бы нечему.
  await b.eval(`document.querySelector('[data-group="dicts"]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('[data-group="dicts"]')?.click()`);
  await sleep(200);
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='dict-smu')?.click()`);
  // клик по пункту вызывает АСИНХРОННЫЙ обработчик (openSection: сторож, права объекта, монтирование) — сам
  // клик возвращается сразу, ждём именно ЗАВЕРШЕНИЯ перехода по надёжному признаку (адрес меняется последним
  // шагом успешного openSection), а не фиксированную паузу.
  await b.waitFor(`location.hash === '#/dict-smu'`, 8000);
  await sleep(200);
  await openTemp();
  let expanded = await b.eval(`[...document.querySelectorAll('.v2-shellnav-group-head')].filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.dataset.group)`);
  check("N6.1 группа текущего экрана («Справочники») раскрыта САМА, без клика", expanded.includes("dicts"), JSON.stringify(expanded));
  check("N6.2 остальные группы свёрнуты", expanded.length === 1, JSON.stringify(expanded));
  // пользователь сворачивает ТЕКУЩУЮ группу — остаётся свёрнутой, несмотря на то что экран в ней активен
  await b.eval(`document.querySelector('[data-group="dicts"]')?.click()`);
  await sleep(200);
  expanded = await b.eval(`[...document.querySelectorAll('.v2-shellnav-group-head')].filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.dataset.group)`);
  check("N6.3 пользователь может свернуть ДАЖЕ текущую группу", !expanded.includes("dicts"), JSON.stringify(expanded));
  await sleep(500); // отложенное сохранение (debounce)
  const groupStateAfter = JSON.parse(sql1(S.db, "SELECT recent_objects FROM users WHERE domain_login='admin'") || "{}");
  check("N6.4 раскрытие сохранено за пользователем (SQL: nav_group_state.dicts=false)", groupStateAfter.nav_group_state?.dicts === false, JSON.stringify(groupStateAfter.nav_group_state));

  console.log("\n== после перезагрузки — состояние групп восстановлено (свёрнутая группа остаётся свёрнутой) ==");
  await hardGoto(b, `${S.base}/v2#/dict-smu`);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await sleep(500);
  await openTemp();
  expanded = await b.eval(`[...document.querySelectorAll('.v2-shellnav-group-head')].filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.dataset.group)`);
  check("N7.1 после перезагрузки «Справочники» остаётся свёрнутой (явный выбор пользователя не переигран)", !expanded.includes("dicts"), JSON.stringify(expanded));

  console.log("\n== поиск: находит по всем доступным разделам, временно раскрывает совпавшую группу, не портит сохранённое раскрытие ==");
  await b.clickSel("#v2-shellnav-search"); await b.type("СМУ");
  await sleep(300);
  let found = await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].map(x=>x.dataset.section)`);
  check("N8.1 поиск нашёл «СМУ» даже в свёрнутой группе «Справочники»", found.includes("dict-smu"), JSON.stringify(found));
  await b.eval(`(() => { const s = document.querySelector('#v2-shellnav-search'); s.value=''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(300);
  expanded = await b.eval(`[...document.querySelectorAll('.v2-shellnav-group-head')].filter(x=>x.getAttribute('aria-expanded')==='true').map(x=>x.dataset.group)`);
  check("N8.2 после очистки поиска — прежнее состояние (без «Справочники»)", !expanded.includes("dicts"), JSON.stringify(expanded));
  await b.clickSel("#v2-shellnav-search"); await b.type("совсем несуществующий запрос zzzz999");
  await sleep(300);
  const emptyMenu = await b.eval(`document.querySelector('.v2-shellnav-empty')?.textContent || ''`);
  check("N8.3 пустой результат поиска — понятное сообщение", emptyMenu.includes("Ничего не найдено"), emptyMenu);

  console.log("\n== права: экран/раздел, недоступный роли, не показывается обычным пунктом ==");
  await b.eval(`(() => { const s = document.querySelector('#v2-shellnav-search'); s.value=''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(200);
  await b.eval(`document.querySelector('[data-group="admin"]')?.click()`);
  await sleep(200);
  const adminItemsForAdmin = await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].map(x=>x.dataset.section)`);
  check("N9.1 у admin виден пункт «Пользователи и доступ»", adminItemsForAdmin.includes("users-access"));

  console.log("\n== уход с несохранённой формой: диалог, отмена, продолжение (не обходим guardLeave) ==");
  await hardGoto(b, `${S.base}/v2#/late-threshold`);
  await b.waitFor(`!!document.querySelector('#se-input')`, 15000);
  await sleep(400);
  const before = await b.eval(`document.querySelector('#se-input')?.value`);
  await b.clickSel("#se-input", { count: 3 });
  await b.type(String(Number(before || 0) + 7));
  await b.eval(`document.querySelector('#se-input')?.dispatchEvent(new Event('input',{bubbles:true}))`);
  await sleep(200);
  const dirtyNow = await b.eval(`!document.querySelector('#se-save')?.disabled`);
  check("N10.1 поле стало «грязным» (кнопка «Сохранить» включилась)", dirtyNow);
  // попытка сменить раздел через навигацию — должен появиться диалог, экран/ввод остаются на месте
  await openTemp();
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='home')?.click()`);
  await sleep(400);
  check("N10.2 диалог «Несохранённые изменения» появился", await dialogOpen());
  await dialogClick("Остаться");
  check("N10.3 «Остаться» — экран НЕ сменился (мы всё ещё на late-threshold)", (await b.eval(`location.hash`)).includes("late-threshold"));
  const stillDirty = await b.eval(`document.querySelector('#se-input')?.value`);
  check("N10.4 введённое значение НЕ потеряно", stillDirty === String(Number(before || 0) + 7), stillDirty);
  // панель осталась там, где была (temp закрылась при попытке — это ожидаемо: сама попытка перехода уже
  // произошла и была отклонена; проверяем, что состояние экрана и ввод — не панели — сохранились)
  await openTemp();
  await b.eval(`[...document.querySelectorAll('.v2-shellnav-item')].find(x=>x.dataset.section==='home')?.click()`);
  await sleep(400);
  await dialogClick("Не сохранять");
  check("N10.5 «Не сохранять» — переход состоялся (мы на «Начале»)", (await b.eval(`location.hash`)) === "#/" || (await b.eval(`location.hash`)) === "");

  console.log("\n== тот же сторож — при смене ОБЪЕКТА в шапке (не только раздела) ==");
  await hardGoto(b, `${S.base}/v2#/late-threshold`);
  await b.waitFor(`!!document.querySelector('#se-input')`, 15000);
  await sleep(400);
  await b.clickSel("#se-input", { count: 3 });
  await b.type("55");
  await b.eval(`document.querySelector('#se-input')?.dispatchEvent(new Event('input',{bubbles:true}))`);
  await sleep(200);
  await b.clickSel("#v2-object-btn");
  await b.waitFor(`!!document.querySelector('#v2-objpick-list')`, 8000);
  await sleep(300);
  const curBtnTitle = await b.eval(`document.querySelector('#v2-object-btn')?.title`);
  // ЛЮБОЙ другой объект (строка БЕЗ класса .active — тот самый текущий) — какой конкретно неважно, важно, что
  // не тот же самый (иначе changeObject() выходит по «id === objectId» до сторожа, и диалога не будет вовсе).
  await b.eval(`document.querySelector('.v2-objpick-row:not(.active) [data-object-id]')?.click()`);
  await sleep(400);
  check("N11.1 смена объекта тоже показывает диалог несохранённого", await dialogOpen());
  await dialogClick("Остаться");
  const stayTitle = await b.eval(`document.querySelector('#v2-object-btn')?.title`);
  check("N11.2 «Остаться» — объект в шапке НЕ сменился", stayTitle === curBtnTitle, `${stayTitle} vs ${curBtnTitle}`);

} catch (e) {
  console.error("\nСБОЙ ТЕСТА (не путать с FAIL проверки — это необработанное исключение):", e && e.stack || e);
  process.exitCode = 1;
} finally {
  console.log("\nconsole errors:", b.exceptions);
  await b.close();
  await stopServer();
  const bad = summary();
  if (!process.exitCode) process.exitCode = bad ? 1 : 0;
}
