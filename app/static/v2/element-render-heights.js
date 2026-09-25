// Правила высот изделий взяты из основной 3D-схемы app/static/app.js.
// Проверка полного совпадения: scripts/verify_crane_zone_model_parity.mjs.
function computeColumnLevels(allElements) {
  const set = new Set();
  for (const e of allElements) {
    if (e.element_type === "Колонна" && e.elevation_mm !== null && e.elevation_mm !== undefined) set.add(e.elevation_mm);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// Площадь и периметр контура по формуле шнурков — устойчиво к повороту
// элемента на плане, в отличие от габаритного прямоугольника (bounding
// box), который на повёрнутом прямоугольнике завышает обе стороны.
// Контур ригеля/плиты/панели считаем прямоугольником (или близко к
// нему): тогда из площади S и полупериметра P=(a+b) обе стороны —
// корни уравнения a*b=S, a+b=P. Возвращаем МЕНЬШИЙ корень — это и есть
// ширина сечения (заказчик подтвердил: сечение квадратное, высота
// экструзии = эта ширина, см. Docs/backlog.md).
function crossSectionWidth(outline) {
  if (!outline || outline.length < 3) return null;
  let area2 = 0, perimeter = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % n];
    area2 += x1 * y2 - x2 * y1;
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  const area = Math.abs(area2) / 2;
  if (area === 0) return null;
  const halfPerimeter = perimeter / 2;
  const disc = halfPerimeter * halfPerimeter - 4 * area;
  if (disc < 0) return Math.sqrt(area); // не должно случаться для прямоугольника — запасной вариант
  const width = (halfPerimeter - Math.sqrt(disc)) / 2;
  return width > 0 ? width : Math.sqrt(area);
}

const DEFAULT_EXTRUSION_HEIGHT = 3000; // мм — запасной вариант, если высоту иначе не определить

// Фиксированная толщина плиты перекрытия (заказчик подтвердил, см.
// Docs/backlog.md, "Новый файл — плиты перекрытия") — весь тип "Плита
// перекрытия" целиком, а не только конкретный подтип/отметка; НЕ
// распространяется на тип "Плита" (генерик, отдельный от "Плита
// перекрытия", пока не встречался в реальных данных) — тот при появлении
// продолжит считаться по допущению "квадратное сечение" ниже.
const FLOOR_SLAB_THICKNESS_MM = 300;

// Верхняя отметка, до которой должен доходить САМЫЙ ВЕРХНИЙ ярус колонн —
// отметка ближайшей ПЛИТЫ ПЕРЕКРЫТИЯ выше него, если такая есть (напр.
// локальная кровля техпомещения без своего яруса колонн — см. новый файл
// 260720, Docs/backlog.md, "Новый файл 260720"), иначе запасной вариант,
// как и раньше — высота последнего межъярусного шага.
function computeTopColumnCeiling(levels, allElements) {
  if (!levels.length) return null;
  const topLevel = levels[levels.length - 1];
  let ceiling = null;
  for (const e of allElements) {
    if (e.element_type === "Плита перекрытия" && e.elevation_mm != null && e.elevation_mm > topLevel) {
      if (ceiling === null || e.elevation_mm < ceiling) ceiling = e.elevation_mm;
    }
  }
  if (ceiling !== null) return ceiling;
  const lastGap = levels.length > 1 ? topLevel - levels[levels.length - 2] : DEFAULT_EXTRUSION_HEIGHT;
  return topLevel + lastGap;
}

// - Колонна — до потолка, найденного НАД НЕЙ САМОЙ (см. computeColumnTops,
//   columnTops): ближайшая колонна выше в той же точке плана, иначе
//   ближайшая плита/ригель выше над этой точкой, иначе шаг этажа снизу.
//   Глобальные ярусы (levels) остались ЗАПАСНЫМ вариантом — на случай,
//   когда над колонной в модели нет вообще ничего.
// - Плита перекрытия — фиксированная толщина (см. FLOOR_SLAB_THICKNESS_MM).
// - Панель облицовки шахты — РЕАЛЬНАЯ высота изделия из DXF (elements.height_mm,
//   см. app.shaft_panels): контур в плане не даёт высоты, "квадратное сечение"
//   ниже дало бы толщину в 60-150 мм вместо метра с лишним.
// - Ригель/Плита/Панель — квадратное сечение, высота = ширина контура.
function elementExtrusionHeight(element, levels, columnTops, allElements) {
  if (element.element_type === "Панель облицовки шахты") {
    if (!Number.isFinite(element.height_mm) || element.height_mm <= 0) {
      throw new Error(`У панели ${element.id} отсутствует высота из DXF`);
    }
    return element.height_mm;
  }
  if (element.element_type === "Колонна") {
    const top = columnTops && columnTops.get(element.id);
    if (top !== undefined && top > element.elevation_mm) return top - element.elevation_mm;
    // Запасной вариант — прежнее правило по глобальным ярусам. Сюда
    // попадает колонна, над которой в модели ПУСТО: ни колонны, ни плиты,
    // ни ригеля, ни колонны под ней (по ним считается computeColumnTops).
    const idx = levels.indexOf(element.elevation_mm);
    if (idx !== -1 && idx < levels.length - 1) return levels[idx + 1] - levels[idx];
    if (idx === levels.length - 1) {
      const ceiling = computeTopColumnCeiling(levels, allElements);
      if (ceiling !== null && ceiling > element.elevation_mm) return ceiling - element.elevation_mm;
    }
    if (idx > 0) return levels[idx] - levels[idx - 1];
    return DEFAULT_EXTRUSION_HEIGHT;
  }
  if (element.element_type === "Плита перекрытия") {
    return FLOOR_SLAB_THICKNESS_MM;
  }
  return crossSectionWidth(element.outline) || DEFAULT_EXTRUSION_HEIGHT;
}


function footprintLongAxisAngle(outline) {
  let bestLen = -1, bestDx = 1, bestDy = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % n];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len > bestLen) { bestLen = len; bestDx = dx; bestDy = dy; }
  }
  return Math.atan2(bestDy, bestDx);
}

// Ширина/длина контура — тот же подход (прямоугольник по площади и
// периметру), что и crossSectionWidth выше, но возвращает ОБА корня
// (crossSectionWidth — только меньший).
function footprintDimensions(outline) {
  let area2 = 0, perimeter = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i], [x2, y2] = outline[(i + 1) % n];
    area2 += x1 * y2 - x2 * y1;
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  const area = Math.abs(area2) / 2;
  if (area === 0) return null;
  const halfPerimeter = perimeter / 2;
  const disc = halfPerimeter * halfPerimeter - 4 * area;
  if (disc < 0) { const s = Math.sqrt(area); return { width: s, length: s }; }
  const width = (halfPerimeter - Math.sqrt(disc)) / 2;
  return { width, length: halfPerimeter - width };
}


function footprintCentroid(outline) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// Толерантность привязки конца ригеля к ближайшей колонне верхнего
// яруса — по факту на реальных данных (260723_Чертежи для WEB.dxf,
// 34 ригеля/68 концов на отметке 39200) максимальное расстояние конец-
// ригеля-до-центра-опорной-колонны около 1000мм (адресация со
// смещением от оси — offset_x_mm/offset_y_mm — сдвигает колонну
// относительно "чистой" точки сетки), проверено live-скриптом на живой
// БД (см. Docs/backlog.md).
const COLUMN_BEAM_END_MATCH_TOLERANCE_MM = 1000;

// ---------- потолок колонны: считается ПО МЕСТУ (2026-08-21) ----------
//
// Раньше высота колонны бралась по ГЛОБАЛЬНОМУ списку ярусов
// (computeColumnLevels): «до следующей отметки колонн, какая есть в
// модели». На здании из секций РАЗНОЙ высоты это выдавливало колонну
// низкой секции до отметки, которая существует только в высокой части, —
// колонны торчали над своей кровлей на этаж и больше (живой репорт
// 2026-08-21 по объекту АБК: 12 этажей, 24 отметки, секции разной
// высоты). Список ярусов один на всю модель, а этажность — нет.
//
// Теперь потолок ищется НАД САМОЙ КОЛОННОЙ, в порядке убывания
// надёжности:
//   1) ближайшая колонна ВЫШЕ в той же точке плана — колонны стоят
//      стопкой, и низ следующей и есть верх этой;
//   2) её нет — перекрытие или ригель выше НАД ЭТОЙ ТОЧКОЙ, но не выше
//      следующего яруса колонн: колонна последняя в своей секции, и
//      несёт всё, что над ней есть, до начала чужого пролёта. Берётся
//      САМОЕ ВЕРХНЕЕ такое перекрытие, а не ближайшее: колонна проходит
//      СКВОЗЬ перекрытия (у АБК «средняя» идёт сквозь два — стык колонн
//      примерно двумя метрами выше пола), и ближайшее оборвало бы её на
//      середине собственного пролёта. У самого верхнего яруса границы
//      нет и правило другое — ближайшее перекрытие сверху (подробности
//      у шага 2 в коде);
//   3) нет и их — оценка этажа: меньшее из своего пролёта снизу и
//      медианного шага перекрытий модели (см. typicalDeckStep).
// Порядок важен: колонна ищется ПЕРВОЙ. Иначе ригель-парапет на
// промежуточной отметке (в реальных данных +5200 между ярусами колонн 0
// и +8050) обрезал бы колонну, которая на самом деле идёт до следующего
// этажа — ровно та ошибка, от которой список ярусов и защищал.
//
// Отдельным правилом сверху остаётся ригель, ОПИРАЮЩИЙСЯ КОНЦОМ на
// колонну выше найденного потолка (локальная кровля техпомещения над
// основной крышей): такой ригель колонну ВЫТЯГИВАЕТ. Колонна, которая
// просто оказалась под серединой его пролёта, высоту не меняет — ригель
// на неё не опирается (живой запрос пользователя). Только «Ригель»: по
// условию заказчика плита перекрытия лежит на ригеле, а не на колонне.
//
// Возвращает Map(id колонны -> отметка верха). Колонны, для которой не
// нашлось ничего, в карте нет — она достаётся запасному правилу по
// глобальным ярусам (см. elementExtrusionHeight).

// Сторона клетки пространственного индекса. Не «покрупнее для скорости»:
// поиск смотрит клетку и восемь соседних, поэтому сторона обязана быть
// НЕ МЕНЬШЕ допуска привязки (1000 мм) — иначе сосед в допуске окажется
// через клетку и потеряется.
const COLUMN_GRID_CELL_MM = 3000;

// Запас на габарит при проверке «перекрытие над этой точкой». Центр
// крайней колонны ряда лежит НЕ внутри плиты, а чуть снаружи: плита
// кончается по грани ригеля, под которым стоит колонна (на реальных
// данных — 200 мм, у ригеля 270 мм). Точное попадание в контур такую
// колонну теряло бы, поэтому запас есть, но он МАЛЕНЬКИЙ — порядка
// половины сечения колонны. Метровый запас, стоявший здесь сначала,
// цеплял чужое: колонны +27720 в 900 мм от края кровли машинного
// отделения +39300 «несли» её и торчали на четыре метра над своей
// крышей (живой репорт 2026-08-21, изделия 39597 и 39598).
const DECK_OVER_COLUMN_TOLERANCE_MM = 400;
const BEAM_OVER_COLUMN_TOLERANCE_MM = 500;

// Насколько ниже типичного должен оказаться стык яруса, чтобы ярус
// считался СТОЙКАМИ на перекрытии, а не продолжением колонн снизу. На
// реальных данных разрыв огромен — 520 мм против 1920, — так что метр
// разводит эти случаи с запасом в обе стороны.
const COLUMN_SPLICE_SPREAD_MM = 1000;

// Насколько глубоко под низом колонны искать перекрытие, от которого
// считается высота стыка. Больше этажа заглядывать незачем: перекрытия
// глубже — это чужие этажи, а не пол под этой колонной.
const COLUMN_DECK_BELOW_LOOKUP_MM = 4000;

function _gridCell(x, y) {
  return `${Math.floor(x / COLUMN_GRID_CELL_MM)}:${Math.floor(y / COLUMN_GRID_CELL_MM)}`;
}

// Клетки, которые задевает прямоугольник. Плита размером с этаж накрыла
// бы тысячи клеток — такие (шире BIG_DECK_CELLS клеток по любой стороне)
// в индекс не кладутся вовсе, а просматриваются отдельным списком: их
// единицы, а раздувание индекса стоило бы дороже перебора.
const BIG_DECK_CELLS = 24;

function _cellsOfBox(box) {
  const x0 = Math.floor(box.minX / COLUMN_GRID_CELL_MM), x1 = Math.floor(box.maxX / COLUMN_GRID_CELL_MM);
  const y0 = Math.floor(box.minY / COLUMN_GRID_CELL_MM), y1 = Math.floor(box.maxY / COLUMN_GRID_CELL_MM);
  if (x1 - x0 > BIG_DECK_CELLS || y1 - y0 > BIG_DECK_CELLS) return null;
  const cells = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push(`${x}:${y}`);
  return cells;
}

function _outlineBox(outline, pad) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

// «Этаж этого дома» — медиана расстояний между соседними отметками
// перекрытий модели. Медиана, а не среднее: пара мелких служебных
// площадок между этажами (у АБК их четыре на 2599 плит) утянула бы
// среднее вниз, а медиану — нет.
function typicalDeckStep(allElements) {
  const set = new Set();
  for (const e of allElements) {
    if (e.element_type !== "Плита перекрытия") continue;
    if (e.elevation_mm === null || e.elevation_mm === undefined) continue;
    set.add(e.elevation_mm);
  }
  const elevations = Array.from(set).sort((a, b) => a - b);
  if (elevations.length < 2) return null;
  const steps = [];
  for (let i = 1; i < elevations.length; i++) steps.push(elevations[i] - elevations[i - 1]);
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

function computeColumnTops(allElements, levels) {
  const tops = new Map();

  // ---- колонны с их точкой на плане, разложенные по клеткам ----
  const columns = [];
  const columnsByCell = new Map();
  for (const e of allElements) {
    if (e.element_type !== "Колонна") continue;
    if (e.elevation_mm === null || e.elevation_mm === undefined) continue;
    if (!e.outline || e.outline.length < 3) continue;
    const [cx, cy] = footprintCentroid(e.outline);
    const col = { id: e.id, elev: e.elevation_mm, cx, cy };
    columns.push(col);
    const key = _gridCell(cx, cy);
    const bucket = columnsByCell.get(key);
    if (bucket) bucket.push(col); else columnsByCell.set(key, [col]);
  }
  if (!columns.length) return tops;

  function neighbourColumns(col) {
    const out = [];
    const gx = Math.floor(col.cx / COLUMN_GRID_CELL_MM), gy = Math.floor(col.cy / COLUMN_GRID_CELL_MM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = columnsByCell.get(`${gx + dx}:${gy + dy}`);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === col) continue;
          if (Math.hypot(other.cx - col.cx, other.cy - col.cy) <= COLUMN_BEAM_END_MATCH_TOLERANCE_MM) out.push(other);
        }
      }
    }
    return out;
  }

  // ---- индекс перекрытий: нужен и шагу 1 (проверка «стоит на
  //      перекрытии»), и шагу 2 ----
  //
  // Ярус колонн — НЕ этаж: у реального здания (АБК) колонна «средняя»
  // идёт от +7020 до +16920 СКВОЗЬ два перекрытия (+10050 и +15000) —
  // стык колонн стоит примерно двумя метрами выше пола. Поэтому взять
  // просто ближайшее перекрытие сверху нельзя: колонна оборвалась бы на
  // середине своего пролёта, а этаж над ней остался бы без колонн.
  //
  // Верхнюю границу пролёта задаёт СЛЕДУЮЩИЙ ярус колонн: колонна не
  // может подняться выше отметки, с которой начинается колонна над ней.
  // Внутри этой границы берём САМОЕ ВЕРХНЕЕ перекрытие над точкой — оно
  // и есть последнее, что эта колонна несёт.
  //
  // У САМОГО ВЕРХНЕГО яруса модели такой границы нет, и там правило
  // другое — ближайшее перекрытие сверху: выше него колонну поднимает
  // только ригель, опирающийся на неё концом (локальная кровля
  // техпомещения, см. ниже). Иначе колонна под серединой такой кровли
  // пробила бы основную крышу, а это ровно то, что заказчик отдельно
  // запретил.
  const deckByCell = new Map();
  const bigDecks = [];
  for (const e of allElements) {
    if (e.element_type !== "Плита перекрытия" && e.element_type !== "Ригель") continue;
    if (e.elevation_mm === null || e.elevation_mm === undefined) continue;
    if (!e.outline || e.outline.length < 3) continue;
    const pad = e.element_type === "Ригель" ? BEAM_OVER_COLUMN_TOLERANCE_MM : DECK_OVER_COLUMN_TOLERANCE_MM;
    const deck = Object.assign({ elev: e.elevation_mm }, _outlineBox(e.outline, pad));
    const cells = _cellsOfBox(deck);
    if (cells === null) { bigDecks.push(deck); continue; }
    for (const key of cells) {
      const bucket = deckByCell.get(key);
      if (bucket) bucket.push(deck); else deckByCell.set(key, [deck]);
    }
  }

  // ---- ярусы-СТОЙКИ: низ лежит на перекрытии, а не на стыке ----
  //
  // Сборный стык колонн у этого заказчика стоит примерно на одной и той
  // же высоте над полом — это видно прямо в данных: у АБК 7020 = 5010 +
  // 2010, 16920 = 15000 + 1920, 27720 = 25800 + 1920. А ярус +39520
  // (машинное отделение) начинается в 520 мм над своими ригелями +39000,
  // то есть СТОИТ на них: это не продолжение колонны снизу, а отдельная
  // стойка на кровле. Колонна под такой стойкой кончается на том, что
  // несёт сама, и тянуться к её низу не должна.
  //
  // Решение принимается на ЯРУС целиком, по медиане, а не на каждую
  // колонну: в чертеже попадаются одиночные ригели на промежуточных
  // отметках (у АБК их по три штуки на +6180, +16230, +26880), и
  // поколонная проверка от них шаталась бы.
  function deckBelow(col) {
    let best = null;
    const consider = (deck) => {
      if (deck.elev > col.elev || deck.elev < col.elev - COLUMN_DECK_BELOW_LOOKUP_MM) return;
      if (col.cx < deck.minX || col.cx > deck.maxX || col.cy < deck.minY || col.cy > deck.maxY) return;
      if (best === null || deck.elev > best) best = deck.elev;
    };
    const bucket = deckByCell.get(_gridCell(col.cx, col.cy));
    if (bucket) for (const deck of bucket) consider(deck);
    for (const deck of bigDecks) consider(deck);
    return best;
  }

  const median = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const offsetsByTier = new Map();
  for (const col of columns) {
    const deck = deckBelow(col);
    if (deck === null) continue;
    const bucket = offsetsByTier.get(col.elev);
    if (bucket) bucket.push(col.elev - deck); else offsetsByTier.set(col.elev, [col.elev - deck]);
  }
  const tierOffset = new Map();
  for (const [tier, offsets] of offsetsByTier) tierOffset.set(tier, median(offsets));
  const standaloneTiers = new Set();
  if (tierOffset.size) {
    const typical = median(Array.from(tierOffset.values()));
    for (const [tier, offset] of tierOffset) {
      if (offset < typical - COLUMN_SPLICE_SPREAD_MM) standaloneTiers.add(tier);
    }
  }

  // ---- 1) колонна выше в той же точке ----
  const noColumnAbove = [];
  for (const col of columns) {
    let aboveCol = null, below = null;
    for (const other of neighbourColumns(col)) {
      if (other.elev > col.elev) { if (aboveCol === null || other.elev < aboveCol.elev) aboveCol = other; }
      else if (other.elev < col.elev) { if (below === null || other.elev > below) below = other.elev; }
    }
    col.below = below;
    const above = aboveCol ? aboveCol.elev : null;
    if (above !== null && !standaloneTiers.has(above)) {
      tops.set(col.id, above);
    } else {
      // Верх колонны определяют перекрытия над ней; выше низа чужой
      // стойки она в любом случае не поднимается.
      col.spanLimit = above;
      col.openTop = true;   // только такую колонну вправе поднять ригель
      noColumnAbove.push(col);
    }
  }
  if (!noColumnAbove.length) return tops;

  // ---- 2) перекрытие или ригель выше над этой точкой ----
  //
  // limit — верх пролёта (следующий ярус колонн либо низ чужой стойки);
  // null у верхнего яруса.
  // С границей берём самое верхнее перекрытие под ней, без границы —
  // ближайшее сверху.
  function deckAbove(col, limit) {
    let best = null;
    const consider = (deck) => {
      if (deck.elev <= col.elev) return;
      if (limit !== null && deck.elev > limit) return;
      if (col.cx < deck.minX || col.cx > deck.maxX || col.cy < deck.minY || col.cy > deck.maxY) return;
      if (best === null || (limit !== null ? deck.elev > best : deck.elev < best)) best = deck.elev;
    };
    const bucket = deckByCell.get(_gridCell(col.cx, col.cy));
    if (bucket) for (const deck of bucket) consider(deck);
    for (const deck of bigDecks) consider(deck);
    return best;
  }

  const stillOpen = [];
  for (const col of noColumnAbove) {
    const idx = levels.indexOf(col.elev);
    let limit = (idx !== -1 && idx < levels.length - 1) ? levels[idx + 1] : null;
    if (col.spanLimit !== undefined && col.spanLimit !== null) {
      limit = (limit === null) ? col.spanLimit : Math.min(limit, col.spanLimit);
    }
    const deck = deckAbove(col, limit);
    if (deck !== null) tops.set(col.id, deck);
    else stillOpen.push(col);
  }

  // ---- 3) оценка этажа: меньшее из своего пролёта снизу и типичного
  //         шага перекрытий по модели ----
  //
  // Над колонной в модели пусто (колонны машинного отделения АБК: стоят
  // на кровле +39300, своей крыши в чертеже нет). Один свой пролёт снизу
  // тут врёт: у той же колонны он двухэтажный (11 800 мм), и она встала
  // бы одиннадцатиметровой свечой над крышей. Медианный шаг перекрытий —
  // это «этаж этого дома»; меньшее из двух и берём, чтобы ошибаться в
  // сторону «не торчит».
  if (stillOpen.length) {
    const typical = typicalDeckStep(allElements);
    for (const col of stillOpen) {
      const own = (col.below !== null && col.below < col.elev) ? col.elev - col.below : null;
      const step = (own !== null && typical !== null) ? Math.min(own, typical) : (own !== null ? own : typical);
      if (step !== null && step > 0) tops.set(col.id, col.elev + step);
    }
  }

  // ---- ригель, опирающийся концом на колонну выше её потолка ----
  //
  // Кандидаты — колонны САМОГО ВЕРХНЕГО яруса, у которых сверху нет
  // колонны. Ярусом ниже такому ригелю взяться неоткуда: над колонной
  // непромежуточного яруса начинается следующая колонна, и «локальная
  // кровля» там — чужая. На реальных данных без этого ограничения
  // ригель на +25800 поднимал до себя колонну яруса +7020, у которой
  // просто не нашлось соседа сверху в допуске.
  const topLevelForBeams = levels.length ? levels[levels.length - 1] : null;
  const beamCandidates = noColumnAbove.filter(col => col.elev === topLevelForBeams);
  for (const col of beamCandidates) col.beamCandidate = true;
  if (beamCandidates.length) {
    for (const beam of allElements) {
      if (beam.element_type !== "Ригель") continue;
      if (beam.elevation_mm === null || beam.elevation_mm === undefined) continue;
      if (!beam.outline || beam.outline.length < 3) continue;
      const dims = footprintDimensions(beam.outline);
      if (!dims) continue;
      const angle = footprintLongAxisAngle(beam.outline);
      const [bcx, bcy] = footprintCentroid(beam.outline);
      const halfLen = dims.length / 2;
      const dx = Math.cos(angle) * halfLen, dy = Math.sin(angle) * halfLen;
      for (const [ex, ey] of [[bcx + dx, bcy + dy], [bcx - dx, bcy - dy]]) {
        let best = null;
        const gx = Math.floor(ex / COLUMN_GRID_CELL_MM), gy = Math.floor(ey / COLUMN_GRID_CELL_MM);
        for (let cx = -1; cx <= 1; cx++) {
          for (let cy = -1; cy <= 1; cy++) {
            const bucket = columnsByCell.get(`${gx + cx}:${gy + cy}`);
            if (!bucket) continue;
            for (const col of bucket) {
              if (!col.beamCandidate) continue;               // не верхний ярус либо верх задан колонной сверху
              if (col.elev >= beam.elevation_mm) continue;   // ригель не выше колонны — не он её накрывает
              if (tops.has(col.id) && tops.get(col.id) >= beam.elevation_mm) continue;
              const d = Math.hypot(col.cx - ex, col.cy - ey);
              if (!best || d < best.d) best = { d, col };
            }
          }
        }
        if (best && best.d <= COLUMN_BEAM_END_MATCH_TOLERANCE_MM) {
          tops.set(best.col.id, beam.elevation_mm);
        }
      }
    }
  }

  return tops;
}


export function computeElementRenderHeights(allElements) {
  const levels = computeColumnLevels(allElements);
  const tops = computeColumnTops(allElements, levels);
  const result = new Map();
  for (const element of allElements) {
    if (element.outline?.length >= 3) result.set(element.id, elementExtrusionHeight(element, levels, tops, allElements));
  }
  return result;
}
