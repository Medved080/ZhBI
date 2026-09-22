// Браузерная проверка SVG мини-схемы подбора изделий документа «Обмен привязками» (supplier-docs.js, перенос V1 scd-picker-svg)
// на НАСТОЯЩЕМ backend и временной копии БД (объект 1). Только scripts/cdp.mjs (настоящие события мыши/клавиатуры —
// Input.dispatchMouseEvent), никаких внутренних команд выбора.
//
// Запуск: GR_BASE=http://127.0.0.1:8280 GR_DB=/tmp/zhbi_graphics_copy/work.db GR_SHOTS=/tmp/gr_shots node scripts/verify_graphics_picker.mjs
import { session, shot, sleep, checker, tap } from "./verify_mfr_lib.mjs";

const BASE = process.env.GR_BASE || "http://127.0.0.1:8280";
const SHOTS = process.env.GR_SHOTS || null;
const c = checker("graphics-picker");

async function setSelect(b, sel, value) {
  await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(String(value))}; e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

// ============================================================== 3. Документы контрактации: SVG мини-схема подбора (object 1, admin)
{
  const b = await session({ base: BASE, user: "admin", objectId: 1, shots: SHOTS });
  const go = async () => { await b.eval(`location.hash='#/supplier-change'`); await b.waitFor(`location.hash==='#/supplier-change'`); await b.waitFor(`document.querySelector('#sd-inner')?.innerText.includes('Документы')`, 15000); await sleep(300); };
  try {
    console.log("== Документы контрактации: SVG мини-схема подбора ==");
    await go();
    await tap(b, '[data-a="new-link_swap"]');
    await b.waitFor(`document.querySelector('#sd-inner')?.innerText.includes('новый документ')`);
    await setSelect(b, '[data-f="from"]', 13);
    await b.waitFor(`document.querySelector('[data-f="mark"] option[value="4П-12"]')`, 8000);
    await setSelect(b, '[data-f="mark"]', "4П-12");
    await b.waitFor(`document.querySelector('[data-f="to"] option[value="14"]')`, 8000).catch(() => {});
    await setSelect(b, '[data-f="to"]', 14);
    await sleep(300);
    await tap(b, '[data-a="pick"][data-side="a"]');
    await b.waitFor(`document.querySelector('#sd-pick-svg')`, 10000);
    await b.eval(`document.getElementById('sd-pick-svg').scrollIntoView({block:'center'})`); await sleep(200);
    await shot(b, "g-picker-open");
    const shapesCount = await b.eval(`document.querySelectorAll('#sd-pick-svg .sd-pick-shape').length`);
    c.ok(shapesCount > 0, `мини-схема отрисована: ${shapesCount} фигур изделий марки «4П-12»`);
    c.ok(await b.eval(`document.querySelectorAll('#sd-pick-svg circle').length>0`), "фон (остальные изделия того же типа) нарисован точками");

    // Настоящий клик мышью по фигуре — переключает отметку, список синхронно отражает выбор
    const svgRect = await b.rect("#sd-pick-svg");
    const firstShapeAttr = await b.eval(`(()=>{const s=document.querySelector('#sd-pick-svg .sd-pick-shape'); const r=s.getBoundingClientRect(); return {id:Number(s.dataset.el), cx:r.x+r.width/2, cy:r.y+r.height/2};})()`);
    await b.click(firstShapeAttr.cx, firstShapeAttr.cy);
    await sleep(250);
    let checkboxState = await b.eval(`document.querySelector('[data-pk-el="${firstShapeAttr.id}"]')?.checked`);
    c.ok(checkboxState === true, "НАСТОЯЩИЙ клик мышью по фигуре схемы — отметил изделие; список-чекбокс синхронно показал выбор");
    let shapeClass = await b.eval(`document.querySelector('#sd-pick-svg .sd-pick-shape[data-el="${firstShapeAttr.id}"]')?.classList.contains('chosen')`);
    c.ok(shapeClass === true, "маркер на схеме получил класс «chosen» после клика");

    // повторный клик по той же точке — снимает отметку (переключатель)
    await b.click(firstShapeAttr.cx, firstShapeAttr.cy);
    await sleep(250);
    checkboxState = await b.eval(`document.querySelector('[data-pk-el="${firstShapeAttr.id}"]')?.checked`);
    c.ok(checkboxState === false, "повторный клик по той же фигуре снимает отметку");

    // Настоящая рамка (протяжка мышью, Input.dispatchMouseEvent) — добавляет все фигуры внутри
    const beforeSel = await b.eval(`document.querySelectorAll('#sd-pick-svg .sd-pick-shape.chosen').length`);
    await b.drag(svgRect.x + 5, svgRect.y + 5, svgRect.x + svgRect.w - 5, svgRect.y + svgRect.h - 5, { steps: 14 });
    await sleep(300);
    const afterSel = await b.eval(`document.querySelectorAll('#sd-pick-svg .sd-pick-shape.chosen').length`);
    c.ok(afterSel > beforeSel, `настоящая рамка мышью (протяжка через весь холст) добавила отметки: было ${beforeSel}, стало ${afterSel}`);
    const checkedInList = await b.eval(`document.querySelectorAll('[data-pk-el]:checked').length`);
    c.ok(checkedInList === afterSel, "список-чекбоксы отражают РОВНО те же изделия, что отмечены на схеме (синхронизация)");
    await shot(b, "g-picker-band-selected");

    // Колесо — масштаб (реальное событие), панорама Shift+перетаскивание — viewBox меняется
    const vbBefore = await b.eval(`document.getElementById('sd-pick-svg').getAttribute('viewBox')`);
    await b.wheel(svgRect.cx, svgRect.cy, -300);
    await sleep(150);
    const vbAfterZoom = await b.eval(`document.getElementById('sd-pick-svg').getAttribute('viewBox')`);
    c.ok(vbAfterZoom !== vbBefore, `настоящее колесо мыши изменило масштаб (viewBox: «${vbBefore}» → «${vbAfterZoom}»)`);
    await b.drag(svgRect.cx, svgRect.cy, svgRect.cx + 60, svgRect.cy + 40, { shift: true, steps: 8 });
    await sleep(150);
    const vbAfterPan = await b.eval(`document.getElementById('sd-pick-svg').getAttribute('viewBox')`);
    c.ok(vbAfterPan !== vbAfterZoom, `настоящее Shift+перетаскивание мышью панорамирует схему (viewBox изменился)`);
    await shot(b, "g-picker-panned-zoomed");

    // Список тоже работает (дополнительный способ не убран) — «Отметить все показанные»
    await tap(b, '[data-a="pk-all"]');
    await sleep(200);
    const allChecked = await b.eval(`document.querySelectorAll('[data-pk-el]').length === document.querySelectorAll('[data-pk-el]:checked').length`);
    c.ok(allChecked, "список: «Отметить все показанные» по-прежнему работает (второй способ рядом со схемой)");

    await tap(b, '[data-a="pk-apply"]');
    await sleep(200);
    c.ok(!(await b.eval(`!!document.querySelector('.v2-callout[aria-label="Подбор изделий"]')`)), "«Добавить в документ» закрыл окно подбора");
  } finally { await b.close(); }
}

// ============================================================== 4. Документы контрактации: права user2/user4 (object 1)
// У обоих ролей (`view`/`user`) `doc_supplier_change`/`doc_link_swap` — «read» (`/me/permissions`). До 2026-09-22 экран открывался
// только при «write» (перенос правила пункта меню V1) и оба РЕДИРЕКТИЛИСЬ; по решению пользователя «нужен просмотр» экран открыт
// при «read» в режиме «только просмотр» (screens.json feature, supplier-docs.js; Docs/v2-progress/docsview.md). Проверяем новое
// поведение: экран открыт, кнопок создания нет, подбор (и мини-схема) недоступен, прямая запись отклоняется СЕРВЕРОМ. Подробный
// сценарий просмотра (документы обоих видов в обоих состояниях, SQL до/после, смешанные права) — scripts/verify_docsview.mjs.
for (const [user, label] of [["user2", "user2 (роль «user»)"], ["user4", "user4 (роль «view»)"]]) {
  const b = await session({ base: BASE, user, objectId: 1, shots: SHOTS });
  try {
    console.log(`== Документы контрактации: права ${label} ==`);
    await b.eval(`location.hash='#/supplier-change'`);
    await b.waitFor(`(document.querySelector('#sd-inner')?.innerText||'').includes('Документы объекта')`, 15000).catch(() => {});
    await sleep(500);
    const hashAfter = await b.eval(`location.hash`);
    c.ok(hashAfter === "#/supplier-change" && await b.eval(`!!document.querySelector('[data-readonly-note]') && !document.querySelector('[data-a^="new-"]')`), `${label}: экран открыт в режиме «только просмотр» — пояснение есть, кнопок создания нет (хэш: «${hashAfter}»)`);
    await tap(b, '[data-open]');                                        // настоящий щелчок по номеру документа
    await b.waitFor(`!!document.querySelector('[data-readonly-tag]')`, 15000).catch(() => {});
    c.ok(await b.eval(`!!document.querySelector('[data-readonly-tag]') && !document.querySelector('[data-a="pick"]') && !document.querySelector('#sd-pick-svg')`), `${label}: документ открыт «только просмотр», «Подбор…» и мини-схемы нет — выбор изменить нечем`);
    const resp = await b.eval(`fetch('/supplier-changes', {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({object_id:1, kind:'link_swap', doc_date:'2026-09-22', from_contract_id:13, to_contract_id:14, mark:'4П-12', side_a:[], side_b:[]})}).then(r=>r.status)`);
    c.ok(resp === 403, `${label}: прямой POST документа — сервер отвечает 403 (${resp})`);
  } finally { await b.close(); }
}

process.exit(c.done() > 0 ? 1 : 0);
