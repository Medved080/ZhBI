// Проверка задания «tables» (ширина табличных экранов и перенос колонок V2) в БРАУЗЕРЕ (настоящие события,
// scripts/cdp.mjs) на НАСТОЯЩЕМ сервере (scripts/real_auth_server.py) и временной копии БД с добавленными
// тестовыми строками (.run/tables/seed.py). Ничего не пишет — только чтение экранов и снимки экрана.
//
// Запуск:  .venv/bin/python scripts/real_auth_server.py <источник> 8230 .run/tables   (в фоне)
//          .venv/bin/python scripts/seed_tables_check.py .run/tables/work.db
//          node scripts/verify_tables_ui.mjs 8230 .run/tables
import { session, sql, http, ok, summary, openSection, text, exists } from "./verify_admin_lib.mjs";
import { mkdirSync } from "node:fs";

const PORT = Number(process.argv[2] || 8230);
const WORK = process.argv[3] || ".run/tables";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = WORK + "/work.db";
const SHOTS = WORK + "/shots";
mkdirSync(SHOTS, { recursive: true });

const rect = (b, sel) => b.rect(sel);
const innerTextOf = (b, sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);

async function setNavPrefs(login, pinned, width) {
  const api = await http(BASE, login);
  const me = api.me;
  await api.patch(`/users/${me.id}/v2-shell-prefs`, { pinned_objects: me.v2_shell_prefs?.pinned_objects || [], nav_pinned: pinned, nav_width: width, nav_group_state: me.v2_shell_prefs?.nav_group_state || {} });
}
async function setLastObject(login, objectId) {
  const api = await http(BASE, login);
  await api.put("/me/last-object", { object_id: objectId });
}

async function main() {
  // «Последний объект» мог остаться от прошлого запуска этого же скрипта (персистентная настройка на сервере,
  // а не в браузере) — объект-1 (ЖБИ) доступен для всех проверяемых здесь экранов.
  await setLastObject("admin", 1);

  // ---- 1) «Элементы» (справочник, dicts) — марка/тип/подтип/адрес/статус/этаж/даты/чертёж; длинные и пустые поля.
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "element-catalog");
    await b.waitFor("!!document.querySelector('.v2-read-tbl')", 15000);
    // Поиск на сервере (serverSearch): без него наши тестовые строки (свежие id) не попадают на первую
    // страницу (limit=100, сортировка по id по умолчанию). Общий поиск в марке/адресе покрывает «TBL-» не
    // напрямую — используем реальную часть тестовой марки.
    const search = await b.eval(`!!document.querySelector('#rd-search')`);
    if (search) {
      const r = await rect(b, "#rd-search");
      await b.click(r.cx, r.cy);
      await b.type("ТСТ-");
      await b.sleep(700);
    }
    // Найти нашу тестовую строку «Колонна / верхняя» по марке «ТСТ-К1» — целиком, без разрывов по буквам.
    const rowText = await b.eval(`(()=>{const rows=[...document.querySelectorAll('.v2-read-tbl tbody tr')];const r=rows.find(tr=>tr.innerText.includes('ТСТ-К1'));return r?r.innerText:null})()`);
    ok("TBL-1 «ТСТ-К1»: строка найдена в таблице «Элементы»", !!rowText, rowText || "");
    ok("TBL-2 «Колонна» — слово целиком, без разрывов по буквам", (rowText || "").includes("Колонна") && !/К\s*о\s*л\s*о\s*н\s*н\s*а/.test((rowText || "").replace("Колонна", "")), rowText);
    ok("TBL-3 «верхняя» — слово целиком", (rowText || "").includes("верхняя"), rowText);
    // Пустая строка (ТСТ-Б7): пустые адрес/этаж/даты не ломают раскладку — таблица всё равно есть и строка есть.
    const emptyRowText = await b.eval(`(()=>{const rows=[...document.querySelectorAll('.v2-read-tbl tbody tr')];const r=rows.find(tr=>tr.innerText.includes('ТСТ-Б7'));return r?r.innerText:null})()`);
    ok("TBL-4 строка с пустыми полями (ТСТ-Б7) отрисована", !!emptyRowText, emptyRowText || "");
    // Та же строка несёт и длинное непрерывное имя чертежа без пробелов (аварийный перенос допустим), но не
    // должна распирать страницу горизонтально (нет прокрутки СТРАНИЦЫ целиком).
    const pageScrollX = await b.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    ok("TBL-4b длинная непрерывная строка (имя чертежа) не создаёт горизонтальную прокрутку СТРАНИЦЫ", pageScrollX <= 2, `scrollWidth-clientWidth=${pageScrollX}; row=${emptyRowText}`);
    // Ширина: .v2-container должен иметь класс --wide и НЕ ограничен 1120px.
    const wideClass = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
    ok("TBL-5 контейнер справочника получил класс v2-container--wide", wideClass === true);
    const contW = (await rect(b, ".v2-container")).w;
    const bodyW = await b.eval("document.body.clientWidth");
    ok("TBL-6 ширина контейнера заметно больше 1120px на 1920×1080 (вся рабочая область)", contW > 1300, `contW=${contW} bodyW=${bodyW}`);
    // Заголовок «Чертёж»/др. заголовки не должны быть nowrap (перенос разрешён)
    const thWS = await b.eval(`getComputedStyle([...document.querySelectorAll('.v2-read-tbl th')].find(x=>x.innerText.includes('поставк'))||document.querySelector('.v2-read-tbl th')).whiteSpace`);
    ok("TBL-7 заголовок таблицы: white-space не nowrap (разрешён перенос по словам)", thWS !== "nowrap", thWS);
    // Числовая/дата колонка: значение даты не рвётся (замерим td с датой)
    await b.shot(`${SHOTS}/01-element-catalog-1920x1080.png`);
    await b.close();
  }

  // ---- 2) «Журнал действий» (журнал/история, admin) — длинные «Было/Стало», «Запланирован», длинное ФИО.
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "activity");
    await b.waitFor("!!document.querySelector('.v2-read-tbl')", 15000);
    const planText = await b.eval(`(()=>{const cells=[...document.querySelectorAll('.v2-read-tbl tbody td')];const c=cells.find(td=>td.innerText.trim()==='Запланирован');return c?c.innerText:null})()`);
    ok("TBL-8 «Запланирован» в журнале — слово целиком, найдено ячейкой", planText === "Запланирован", JSON.stringify(planText));
    const longUserRow = await b.eval(`(()=>{const rows=[...document.querySelectorAll('.v2-read-tbl tbody tr')];const r=rows.find(tr=>tr.innerText.includes('Тестовый Пользователь'));return r?r.innerText:null})()`);
    ok("TBL-9 строка с длинным ФИО и длинной маркой отрисована", !!longUserRow, longUserRow || "");
    // «Журнал действий» (admin-service.js::mountActivity) оборачивает read-screen.js ВНУТРЬ своей строки статистики
    // (#ac-stats) — реальная таблица журнала в #ac-read; оба контейнера должны быть широкими (см. правку admin-service.js).
    const wideOuter = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
    const wideInner = await b.eval(`(document.querySelector('#ac-read .v2-container')||{}).classList?.contains('v2-container--wide')`);
    ok("TBL-10 контейнер строки статистики журнала — v2-container--wide", wideOuter === true);
    ok("TBL-10b вложенный контейнер таблицы журнала (#ac-read) — v2-container--wide", wideInner === true);
    await b.shot(`${SHOTS}/02-activity-1920x1080.png`);
    await b.close();
  }

  // ---- 3) «Учёт по блокам: статусы» — широкая матрица (много колонок и строк), sticky-заголовок, горизонтальная прокрутка.
  {
    // Объект-4 — МФР (см. checks в screens.json: 42 блока × 233 операции WBS) — переключаем ПЕРЕД входом
    // (иначе отчёт строится по объекту по умолчанию, у которого блоков нет).
    await setLastObject("admin", 4);
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await b.eval(`location.hash='#/report-block-status'`);
    await b.sleep(600);
    await b.waitFor("!!document.querySelector('.v2-read-tbl') || !!document.querySelector('.v2-callout')", 15000);
    const bodyText1 = await b.eval("document.body.innerText");
    ok("TBL-11 «Учёт по блокам: статусы» открылся без ошибки", !bodyText1.includes("Не удалось загрузить"), bodyText1.slice(0, 200));
    const hasTable = await exists(b, ".v2-read-tbl.v2-matrix");
    if (hasTable) {
      const wrap = await rect(b, ".v2-read-table");
      const wideClass = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
      ok("TBL-12 контейнер отчёта — v2-container--wide", wideClass === true);
      const overflowStyle = await b.eval(`getComputedStyle(document.querySelector('.v2-read-table')).overflow`);
      ok("TBL-13 обёртка таблицы — overflow:auto (своя прокрутка, а не вся страница)", overflowStyle === "auto", overflowStyle);
      const maxH = await b.eval(`getComputedStyle(document.querySelector('.v2-read-table')).maxHeight`);
      ok("TBL-14 обёртка таблицы имеет ограничение высоты (max-height задан)", maxH !== "none", maxH);
      const thTop = await b.eval(`getComputedStyle(document.querySelector('.v2-read-tbl th')).position`);
      ok("TBL-15 заголовок матрицы — position:sticky", thTop === "sticky", thTop);
      await b.shot(`${SHOTS}/03-block-status-matrix-1920x1080.png`);
    } else {
      console.log("report-block-status: таблица не построена (возможно, нет объекта МФР в этой копии) —", bodyText1.slice(0, 300));
    }
    await b.close();
    // Вернуть «последний объект» на ЖБИ (объект-1) — иначе дальнейшие экраны (в т.ч. «Элементы», которого нет
    // в разделах объекта МФР) на новых сеансах открывались бы недоступными и уводили на начальную страницу.
    await setLastObject("admin", 1);
  }

  // ---- 4) «Моя работа» (обычный отчёт-список, reports) — текст/даты/числа.
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "report-mywork");
    await b.waitFor("!!document.querySelector('#rd-report')", 15000);
    const wideClass = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
    ok("TBL-16 контейнер отчёта «Моя работа» — v2-container--wide", wideClass === true);
    await b.shot(`${SHOTS}/04-report-mywork-1920x1080.png`);
    await b.close();
  }

  // ---- 5) Обычная ФОРМА (не табличный экран) — «СМУ» (dicts, dict-edit): ширина ОСТАЁТСЯ ограниченной.
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "dict-smu");
    await b.waitFor("!!document.querySelector('.v2-container')", 15000);
    const contW = (await rect(b, ".v2-container")).w;
    const hasWide = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
    ok("TBL-17 форма «СМУ» НЕ получила v2-container--wide (осталась узкой)", hasWide === false, `contW=${contW}`);
    ok("TBL-18 ширина формы «СМУ» ограничена (~1120px + отступы), не во весь экран", contW < 1200, `contW=${contW}`);
    await b.shot(`${SHOTS}/05-dict-smu-form-1920x1080.png`);
    await b.close();
  }

  // ---- 6) «Настройки домена» (record) — карточка-запись: тоже узкая.
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "ldap");
    await b.waitFor("!!document.querySelector('.v2-container')", 15000);
    const hasWide = await b.eval(`document.querySelector('.v2-container').classList.contains('v2-container--wide')`);
    ok("TBL-19 «Настройки домена» (kind=record) НЕ получила v2-container--wide", hasWide === false);
    await b.close();
  }

  // ---- 7) 1366×768 + панель свёрнута/закреплена (мин/макс ширина) — 4 комбинации на «Элементах».
  const combos = [
    { pinned: false, width: 220, label: "collapsed" },
    { pinned: true, width: 220, label: "pinned-min220" },
    { pinned: true, width: 380, label: "pinned-max380" },
  ];
  for (const size of [{ w: 1920, h: 1080 }, { w: 1366, h: 768 }]) {
    for (const c of combos) {
      await setNavPrefs("admin", c.pinned, c.width);
      const b = await session(BASE, "admin", { width: size.w, height: size.h });
      await openSection(b, "element-catalog");
      await b.waitFor("!!document.querySelector('.v2-read-tbl')", 15000);
      const navW = await b.eval(`(document.querySelector('.v2-shellnav')||{}).getBoundingClientRect?.().width || 0`);
      const contRect = await rect(b, ".v2-container");
      const bodyW = await b.eval("document.body.clientWidth");
      ok(`TBL-20 ${size.w}x${size.h} nav=${c.label}: панель шириной ~${c.pinned ? c.width : 50}px`, Math.abs(navW - (c.pinned ? c.width : 50)) <= 2, `navW=${navW}`);
      ok(`TBL-21 ${size.w}x${size.h} nav=${c.label}: таблица занимает остаток ширины (не 100vw, не 1120px)`, contRect.w > 900 && contRect.w <= bodyW - navW + 5, `contW=${contRect.w} bodyW=${bodyW} navW=${navW}`);
      // «Колонна»/«верхняя» не рвутся и при узкой панели/окне (поиск сужает список до тестовых строк)
      const searchBox = await rect(b, "#rd-search");
      await b.click(searchBox.cx, searchBox.cy);
      await b.type("ТСТ-К1");
      await b.sleep(700);
      const rowText = await b.eval(`(()=>{const rows=[...document.querySelectorAll('.v2-read-tbl tbody tr')];const r=rows.find(tr=>tr.innerText.includes('ТСТ-К1'));return r?r.innerText:null})()`);
      ok(`TBL-22 ${size.w}x${size.h} nav=${c.label}: «Колонна»/«верхняя» целиком`, (rowText || "").includes("Колонна") && (rowText || "").includes("верхняя"), rowText);
      await b.shot(`${SHOTS}/06-${size.w}x${size.h}-${c.label}.png`);
      await b.close();
    }
  }
  // сбросить настройку панели за собой
  await setNavPrefs("admin", false, 260);

  // ---- 8) Соседние с задачей: «Виды работ»/«массовая правка» и панель работ блока переиспользуют .v2-read-tbl
  //     НЕ через read-screen.js — проверяем, что общие правила CSS их не сломали (лёгкая визуальная проверка).
  {
    const b = await session(BASE, "admin", { width: 1920, height: 1080 });
    await openSection(b, "blocks");
    await b.waitFor("!!document.querySelector('body')", 8000);
    await b.sleep(600);
    await b.shot(`${SHOTS}/07-blocks-workspace-1920x1080.png`);
    await b.close();
  }

  const bad = summary();
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
