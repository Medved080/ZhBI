// Выбор объекта в шапке (п.1 задания) — настоящий backend, копия БД (prep_shell_case.py: 324 объекта, 3 с
// данными, «двойники» с почти одинаковыми именами в разных проектах, длинное название, архивные объект/проект).
// Запуск: node scripts/shell_verify/picker1.mjs   (порт 8211)
import { startServer, stopServer, openBrowser, login, check, summary, sleep, sql, sql1, hardGoto } from "./lib.mjs";

const PORT = 8211;
const DIR = "data/shell_check/srv_picker1";
const SOURCE = "data/shell_check/case.db";
const S = await startServer(PORT, DIR, SOURCE);
const b = await openBrowser(1920, 1080);
const openPicker = async () => { await b.clickSel("#v2-object-btn"); await b.waitFor(`!!document.querySelector('#v2-objpick-list')`, 8000); await sleep(250); };
const closePicker = async () => { await b.key("Escape"); await sleep(150); };
const pickState = () => b.eval(`(() => {
  const rows = [...document.querySelectorAll('.v2-objpick-row')].map(r => ({
    id: Number(r.dataset.rowId), text: r.querySelector('.v2-tree-name')?.textContent.trim(),
    active: r.classList.contains('active'), pinned: r.querySelector('.v2-objpick-pin')?.getAttribute('aria-pressed') === 'true',
  }));
  return {
    total: document.querySelector('#v2-objpick-total')?.textContent,
    sectionTitles: [...document.querySelectorAll('.v2-objpick-section-title')].map(x => x.textContent.trim()),
    rows,
  };
})()`);

try {
  await login(b, S.base, "admin");

  console.log("\n== структура: закреплённых нет, есть «С данными» и «Без модели» ==");
  await openPicker();
  let st = await pickState();
  check("P1.1 без закреплений раздел «Закреплённые» не показан", !st.sectionTitles.some((t) => t.includes("Закреплённые")), JSON.stringify(st.sectionTitles));
  check("P1.2 есть раздел «С данными»", st.sectionTitles.some((t) => t.includes("С данными")));
  check("P1.3 «Без модели» свёрнут по умолчанию (строк объектов почти нет)", st.rows.length < 20, `rows=${st.rows.length}`);
  const archivedShown = st.rows.some((r) => r.text?.includes("Архивный"));
  check("P1.4 архивные по умолчанию скрыты", !archivedShown);
  check("P1.5 счётчик «N из 324» без архивных (322)", st.total === "322 из 324", st.total);

  console.log("\n== поиск находит и в свёрнутом разделе «Без модели» ==");
  // "Тест-050" — часть НАЗВАНИЯ ПРОЕКТА (Objект называется "Объект-Т050"); совпадение по проекту — то самое
  // "ищет по всем полям" (project.name входит в ключ поиска), строка при этом свёрнутого раздела не входит в
  // "первые N по умолчанию" — то есть найдена именно ПОИСКОМ, а не оказалась видна просто так.
  await b.clickSel("#v2-objpick-search"); await b.type("Тест-050");
  await sleep(250);
  st = await pickState();
  check("P2.1 поиск раскрывает совпадение в «Без модели» по имени ПРОЕКТА без явного разворачивания", st.rows.some((r) => r.text?.includes("Объект-Т050")), JSON.stringify(st.rows.map((r) => r.text)));
  await b.eval(`(() => { const s = document.querySelector('#v2-objpick-search'); s.value=''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(200);

  console.log("\n== пустой результат поиска ==");
  await b.clickSel("#v2-objpick-search"); await b.type("несуществующий текст запроса zzz999");
  await sleep(250);
  const emptyMsg = await b.eval(`document.querySelector('.v2-objpick-empty')?.textContent || ''`);
  check("P3.1 пустой результат — понятное сообщение", emptyMsg.includes("Ничего не найдено"), emptyMsg);
  await b.eval(`(() => { const s = document.querySelector('#v2-objpick-search'); s.value=''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(200);

  console.log("\n== «двойники»: почти одинаковые названия в РАЗНЫХ проектах различаются по id, не по тексту ==");
  // objects.name UNIQUE в схеме — буквальных дублей имени не бывает (см. пояснение в prep_shell_case.py);
  // проверяем ближайший реальный случай: клик по строке ведёт РОВНО на тот id, что в data-object-id, а не на
  // первую подходящую по префиксу строку.
  await b.clickSel("#v2-objpick-search"); await b.type("Корпус 1 (двойник");
  await sleep(250);
  st = await pickState();
  const twins = st.rows.filter((r) => r.text?.includes("Корпус 1 (двойник"));
  check("P4.1 все 4 «двойника» найдены как РАЗНЫЕ строки", twins.length === 4 && new Set(twins.map((t) => t.id)).size === 4, JSON.stringify(twins));
  const target = twins.find((t) => t.text.includes("двойник 3"));
  await b.eval(`document.querySelector('[data-object-id="${target.id}"]')?.click()`);
  await sleep(400);
  const after = await b.eval(`document.querySelector('#v2-object-btn')?.title`);
  check("P4.2 выбран ИМЕННО «двойник 3» (по id, не по совпавшему префиксу)", after?.includes("двойник 3"), after);
  const lastObj = sql1(S.db, "SELECT last_object_id FROM users WHERE domain_login='admin'");
  check("P4.3 users.last_object_id обновлён на выбранный id", Number(lastObj) === target.id, `${lastObj} vs ${target.id}`);

  console.log("\n== длинное название: колонка количества не ломается, полный текст — в title ==");
  await openPicker();
  await b.clickSel("#v2-objpick-search"); await b.type("очень длинным названием");
  await sleep(250);
  const longRow = await b.eval(`(() => {
    const btn = [...document.querySelectorAll('.v2-objpick-item')].find(x => x.title.includes('очень длинным названием'));
    if (!btn) return null;
    const nameEl = btn.querySelector('.v2-tree-name'), countEl = btn.querySelector('.v2-tree-count');
    return { nameWidth: nameEl.getBoundingClientRect().width, rowWidth: btn.getBoundingClientRect().width,
             countWidth: countEl.getBoundingClientRect().width, fullTitle: btn.title, visibleText: nameEl.textContent };
  })()`);
  check("P5.1 длинная строка найдена", !!longRow, JSON.stringify(longRow));
  if (longRow) {
    check("P5.2 полное название доступно в title (без выбора)", longRow.fullTitle.length > longRow.visibleText.length, longRow.fullTitle.length + " vs " + longRow.visibleText.length);
    check("P5.3 колонка количества не расползлась (узкая, не растянута текстом)", longRow.countWidth < 80, longRow.countWidth);
    check("P5.4 строка не шире окна пикера (обрезание работает)", longRow.rowWidth < 620, longRow.rowWidth);
  }

  console.log("\n== закрепление: 3 объекта, показываются СВЕРХУ и НЕ дублируются в «С данными»/«Без модели» ==");
  await b.eval(`(() => { const s = document.querySelector('#v2-objpick-search'); s.value=''; s.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(200);
  st = await pickState();
  const toPin = st.rows.slice(0, 3).map((r) => r.id);
  for (const id of toPin) { await b.eval(`document.querySelector('[data-pin-id="${id}"]')?.click()`); await sleep(200); }
  st = await pickState();
  check("P6.1 раздел «Закреплённые» появился", st.sectionTitles.some((t) => t.includes("Закреплённые")));
  const pinnedRows = st.rows.filter((r) => toPin.includes(r.id));
  check("P6.2 все 3 закреплённых объекта видны РОВНО по одному разу (не задвоены)", toPin.every((id) => st.rows.filter((r) => r.id === id).length === 1), JSON.stringify(st.rows.filter((r) => toPin.includes(r.id))));
  await sleep(600); // отложенное сохранение (shell-prefs.js:: debounce 300мс на клик) — дождаться перед чтением SQL
  const prefsRow = sql1(S.db, "SELECT recent_objects FROM users WHERE domain_login='admin'");
  const prefs = JSON.parse(prefsRow || "{}");
  check("P6.3 SQL: users.recent_objects содержит все 3 id", toPin.every((id) => (prefs.pinned_objects || []).includes(id)), prefsRow);

  console.log("\n== перезагрузка страницы: закрепления сохраняются ==");
  await hardGoto(b, `${S.base}/v2`);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await sleep(400);
  await openPicker();
  st = await pickState();
  check("P7.1 после перезагрузки «Закреплённые» на месте (3 объекта)", st.sectionTitles.some((t) => t.includes("Закреплённые")) && toPin.every((id) => st.rows.some((r) => r.id === id)));

  console.log("\n== открепление возвращает объект в обычный раздел, без падения ==");
  await b.eval(`document.querySelector('[data-pin-id="${toPin[0]}"]')?.click()`);
  await sleep(250);
  st = await pickState();
  check("P8.1 откреплённый пропал из «Закреплённые», остался в общем списке", st.rows.some((r) => r.id === toPin[0]));
  console.log("errors so far:", b.exceptions);

  console.log("\n== закреплённый объект удалён из дерева — не падаем, тихо не показываем ==");
  // Закрепляем объект, затем «удаляем» его из дерева на копии БД (перепривязка на другой проект — эмулирует
  // «стал недоступен»): следующее открытие окна не должно падать, объект просто не появляется как закреплённый.
  const ghostId = st.rows.find((r) => !toPin.includes(r.id) && r.id !== toPin[0])?.id;
  await b.eval(`document.querySelector('[data-pin-id="${ghostId}"]')?.click()`);
  await sleep(250);
  await closePicker();
  // объект удаляем прямо в копии БД (учебный сценарий «стал недоступен»), затем идём другим путём — перезагрузка
  const { execFileSync } = await import("node:child_process");
  execFileSync("sqlite3", [S.db, `DELETE FROM objects WHERE id=${ghostId}`]);
  await hardGoto(b, `${S.base}/v2`);
  await b.waitFor(`!!document.querySelector('.v2-head')`, 15000);
  await sleep(400);
  await openPicker();
  const noCrash = await b.eval(`!!document.querySelector('#v2-objpick-list')`);
  check("P9.1 окно открывается без падения, когда закреплённый объект исчез", noCrash);
  st = await pickState();
  check("P9.2 исчезнувший объект не показан как закреплённый", !st.rows.some((r) => r.id === ghostId));
  check("P9.3 в консоли нет новых исключений", b.exceptions.length === 0, JSON.stringify(b.exceptions));

  console.log("\n== архивные: чекбокс показывает архивный объект и архивный проект ==");
  await closePicker(); await openPicker();
  await b.clickSel("#v2-objpick-arch");
  await sleep(250);
  st = await pickState();
  check("P10.1 с чекбоксом видны архивные строки", st.rows.some((r) => r.text?.includes("Архивный")));

  console.log("\n== клавиатура: стрелки перемещают выделение, Enter выбирает ==");
  await b.clickSel("#v2-objpick-arch"); // снять архивные обратно
  await sleep(200);
  await b.clickSel("#v2-objpick-search"); await b.type("Объект-1");
  await sleep(250);
  await b.key("ArrowDown");
  await b.key("Enter");
  await sleep(400);
  const afterKb = await b.eval(`document.querySelector('#v2-object-btn')?.title`);
  check("P11.1 Enter по клавиатурному выделению выбрал объект и закрыл окно", afterKb?.includes("Объект-1"), afterKb);
  check("P11.2 окно закрылось", !(await b.eval(`!!document.querySelector('#v2-objpick-list')`)));

  console.log("\n== Esc закрывает без выбора, фокус возвращается на кнопку ==");
  await openPicker();
  await b.key("Escape");
  await sleep(250);
  const focusBack = await b.eval(`document.activeElement?.id`);
  check("P12.1 Esc закрывает окно", !(await b.eval(`!!document.querySelector('#v2-objpick-list')`)));
  check("P12.2 фокус вернулся на кнопку выбора объекта", focusBack === "v2-object-btn", focusBack);

  console.log("\n== клик вне окна закрывает его ==");
  await openPicker();
  await b.click(10, 10);
  await sleep(250);
  check("P13.1 клик вне закрывает окно", !(await b.eval(`!!document.querySelector('#v2-objpick-list')`)));

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
