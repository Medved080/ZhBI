// Плоская «Шахматка» (2026-09-14, Docs/design/chess-flat) — самостоятельный
// плоский экран поверх существующей 2D/3D «Шахматки»: развёртка здания по
// этажам и секциям для просмотра, массового ввода факта и печати бланка
// обхода. Открывается кнопкой «Плоская шахматка →» в «Модели МФР»
// (app/static/app.js, вкладка «Вид»), полноэкранным оверлеем (z-index
// поверх статус-бара приложения — сообщения показываются своим баннером,
// не showToast, см. вызывающий код).
//
// Внешний вид — ТОЧНО по согласованному макету (Docs/design/chess-flat/
// mockup.html, CLAUDE-PROMPT.md): разметка, классы и переменные CSS отсюда
// скопированы почти дословно, композиция и состояния не переосмыслены.
// Демонстрационные данные и панель настройки дизайна (Tweak) из макета сюда
// не перенесены — данные настоящие (app/chess_flat.py), запись настоящая
// (POST .../blocks/chess-flat-batch), печать — реальный системный диалог
// (window.print()).
//
// Зависимости из app.js — явно в openChessFlat(deps, ...), константы
// верхнего уровня обычного скрипта на window не попадают (см. комментарий
// у вызова, app/static/app.js, и тот же приём в app/static/address.js).

let deps = null;
let root = null;          // #chess-flat — сам экран (innerHTML пересобирается целиком на каждый render())
let backdrop = null;      // #chess-flat-backdrop — полноэкранная подложка
let mounted = false;

const RANGE_SIZE = 3;     // столько уровней в одном диапазоне подробного ввода — как в макете

const state = {
  objectId: null,
  trackCode: null,
  objectName: "",
  tracks: [],              // [{код, название}]
  loading: false,
  loadError: "",
  layout: null,            // ответ GET .../chess-flat-layout: {ops, sections, levels, blocks}
  mergedLevels: null,      // уровни, сведённые по номеру этажа (mergeLevelsByFloor) — сверху вниз
  blockIndex: null,        // Map("secId|levelId" -> block)
  opsById: null,           // Map(opId -> {id,name})
  ranges: [],              // [{title, levels:[level,...]}]
  rangeIndex: 0,
  autoPickRange: true,     // при следующей загрузке выбрать диапазон САМИМ (см. pickBestRangeIndex)
  date: todayLocal(),
  snapshotAt: todayLocal(),// когда в последний раз обновлялись текущие значения (для печати)
  tab: "input",            // "input" | "print"
  draft: {},               // `${trackCode}|${blockId}|${opId}` -> строка ввода
  overviewOpen: false,
  reviewing: false,
  reviewItems: null,       // снимок для проверки — [{blockId, opId, current, value, blockLabel, opName}]
  idempotencyKey: null,
  committing: false,
  successMessage: "",
  conflictNotice: false,
  printScope: "all",       // "all" | "range"
  printFrom: 0,            // индекс в ascLevels() — нижняя граница диапазона печати
  printTo: 0,              // индекс в ascLevels() — верхняя граница диапазона печати
  printFormat: "A4",       // "A4" | "A3"
  printPage: 0,
  printBlankId: "",
};

// ------------------------------------------------------------- утилиты

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso || iso.length < 10) return iso || "";
  return iso.slice(0, 10).split("-").reverse().join(".");
}

function esc(v) {
  return deps.escapeHtml(String(v === undefined || v === null ? "" : v));
}

function plural(n, forms) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function fmtFloor(n) {
  const s = String(n);
  return s.startsWith("-") ? "−" + s.slice(1) : s;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function isValidPercent(v) {
  return /^\d{1,3}$/.test(v) && Number(v) <= 100;
}

function draftKey(trackCode, blockId, opId) {
  return `${trackCode}|${blockId}|${opId}`;
}

function makeIdempotencyKey() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-` +
         `${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// Короткий код бланка — печатное удостоверение листа, не право доступа
// (§8 задания: «связывает бумагу с контекстом, но не даёт лишних прав»).
function makeBlankId() {
  const bytes = window.crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((b) => b.toString(36)).join("").toUpperCase();
}

// ------------------------------------------------------------- геометрия/раскладка

function levelFloorLabel(level) {
  return level.floor !== null && level.floor !== undefined ? fmtFloor(level.floor) : truncate(level.name, 10);
}

// Слово(-а) под номером этажа в гутере. Для объединённой строки (см.
// mergeLevelsByFloor) — короткие описания ЧЕРЕЗ «/» (живой запрос
// пользователя 2026-09-14: «выход на кровлю/10-й этаж», имя — из
// system-имени уровня, не зашитый список секций/этажей); для обычной —
// просто «этаж».
function levelWord(row) {
  if (row.levels && row.levels.length > 1) {
    return row.levels.map((l) => shortLevelDescriptor(l) || "этаж").join(" / ");
  }
  return row.floor !== null && row.floor !== undefined ? "этаж" : (row.kind || "уровень");
}

// Уточнение из имени уровня в скобках («9 этаж (секция 1, техническое
// пространство)» → «Техническое пространство») — null, если в имени нет
// такого уточнения (обычный «Этаж 9»). Источник — реальное имя уровня
// объекта (`object_levels.name`), которое дала загрузка модели/PDF, а не
// зашитый список секций.
function shortLevelDescriptor(level) {
  const m = level.name && level.name.match(/\(([^)]*)\)\s*$/);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : null;
}

function shortLevelName(level) {
  return shortLevelDescriptor(level) ||
    (level.floor !== null && level.floor !== undefined ? `${fmtFloor(level.floor)} этаж` : truncate(level.name || "", 20));
}

// Разные секции у одного и того же НОМЕРА этажа физически бывают разными
// строками `object_levels` (техническое пространство/выход на кровлю
// одной секции стоят на своей отметке, с отдельным id — см.
// app/blocks.py::_level_key) — раздельными строками матрицы это
// дублировало бы один и тот же этаж (живой отчёт пользователя
// 2026-09-14: «9 этаж» дважды подряд). Сводим все уровни с одинаковым
// `floor` в ОДНУ строку — `blockAt` ниже перебирает все исходные id
// группы, находя блок нужной секции среди них.
function mergeLevelsByFloor(levels) {
  const groups = [];
  let current = null;
  for (const level of levels) {
    const sameFloor = current && level.floor !== null && level.floor !== undefined &&
      current.floor === level.floor;
    if (sameFloor) current.levels.push(level);
    else { current = { floor: level.floor, levels: [level] }; groups.push(current); }
  }
  return groups.map((g) => {
    if (g.levels.length === 1) {
      const l = g.levels[0];
      return { id: l.id, floor: l.floor, name: l.name, kind: l.kind, levels: g.levels };
    }
    // Уровень с уточнением в скобках («выход на кровлю», «техническое
    // пространство») — первым в группе, обычный — следом; так порядок
    // соответствует примеру задания («выход на кровлю/10-й этаж»).
    const ordered = g.levels.slice().sort((a, b) =>
      (shortLevelDescriptor(a) ? 0 : 1) - (shortLevelDescriptor(b) ? 0 : 1));
    return {
      id: "row-" + ordered.map((l) => l.id).join("-"),
      floor: g.floor,
      name: ordered.map(shortLevelName).join(" / "),
      kind: ordered[0].kind,
      levels: ordered,
    };
  });
}

// Принимает и «сырой» уровень (id — число), и объединённую строку
// (levels — массив исходных уровней группы) — перебирает все исходные id,
// пока не найдёт блок этой секции.
function blockAt(sectionId, row) {
  if (!row) return undefined;
  const ids = row.levels ? row.levels.map((l) => l.id) : [row.id];
  for (const id of ids) {
    const b = state.blockIndex.get(`${sectionId}|${id}`);
    if (b) return b;
  }
  return undefined;
}

function rowLevelIds(row) {
  return row.levels ? row.levels.map((l) => l.id) : [row.id];
}

// Уровни снизу вверх — для печати (§8 задания, живой запрос пользователя
// 2026-09-14: бланк обхода читается по ходу подъёма по зданию, лист 1 —
// нижние этажи). Экранная матрица (`state.mergedLevels`) — наоборот,
// сверху вниз, как силуэт здания; печать использует свой порядок, не
// трогая экранный.
function ascLevels() {
  return state.mergedLevels ? state.mergedLevels.slice().reverse() : [];
}

function blockTitle(section, level) {
  const phrase = level.floor !== null && level.floor !== undefined
    ? `эт. ${fmtFloor(level.floor)}` : truncate(level.name, 26);
  return `${section.code} · ${phrase}`;
}

// Диапазоны подробного ввода — по RANGE_SIZE уровней подряд, сверху вниз
// (state.layout.levels уже в этом порядке, см. app/chess_flat.py::layout).
// Разбиение чисто позиционное (не завязано на конкретные номера этажей
// демо-макета) — работает для любого набора уровней объекта.
function buildRanges(levels) {
  const ranges = [];
  for (let i = 0; i < levels.length; i += RANGE_SIZE) {
    const chunk = levels.slice(i, i + RANGE_SIZE);
    ranges.push({ levels: chunk, title: rangeTitle(chunk) });
  }
  // «Все этажи» — последним пунктом (живой запрос пользователя
  // 2026-09-14): весь список уровней разом, а не по 3. Не добавляем, если
  // здание и так уместилось в один-единственный диапазон — второй пункт
  // с тем же содержимым только сбивал бы с толку.
  if (levels.length > RANGE_SIZE) {
    ranges.push({ levels, title: "Все этажи", isAll: true });
  }
  return ranges;
}

// Диапазон по умолчанию при открытии доски/объекта — НЕ всегда первый
// (самый верх здания): технические уровни и кровля там часто вообще не
// настроены под ЗР, и человек первым делом видит сплошные «—» — читается
// как «сломано», хотя ниже по зданию данные есть (живой отчёт пользователя
// 2026-09-14). Берём диапазон с максимумом ПРИМЕНИМЫХ ячеек (есть строка в
// percents хоть у одной операции хоть одного блока); при равенстве — самый
// верхний из них (порядок диапазонов не меняем, только стартовый выбор).
function pickBestRangeIndex() {
  let best = 0, bestScore = -1;
  state.ranges.forEach((range, i) => {
    if (range.isAll) return; // «Все этажи» содержит всё остальное разом — не подходит на роль умолчания
    const levelIds = new Set(range.levels.flatMap(rowLevelIds));
    let score = 0;
    for (const b of state.layout.blocks) {
      if (!levelIds.has(b.level_id)) continue;
      score += Object.keys(b.percents).length;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

function rangeTitle(chunk) {
  const floors = chunk.map((l) => l.floor).filter((f) => f !== null && f !== undefined);
  if (floors.length === chunk.length) {
    if (chunk.length === 1) return `Этаж ${fmtFloor(floors[0])}`;
    const label = floors.length > 1 && floors[0] !== floors[floors.length - 1]
      ? `Этажи ${fmtFloor(floors[0])}–${fmtFloor(floors[floors.length - 1])}`
      : `Этаж ${fmtFloor(floors[0])}`;
    return floors.some((f) => f <= 0) ? `Низ здания · ${floors.map(fmtFloor).join(" / ")}` : label;
  }
  return chunk.map((l) => levelFloorLabel(l) + (l.floor !== null && l.floor !== undefined ? "" : "")).join(" / ");
}

function sectionsForLevels(levels) {
  const levelIds = new Set(levels.flatMap(rowLevelIds));
  const present = new Set();
  for (const b of state.layout.blocks) if (levelIds.has(b.level_id)) present.add(b.section_id);
  return state.layout.sections.filter((s) => present.has(s.id));
}

// ------------------------------------------------------------- загрузка данных

async function loadTracks() {
  try {
    const data = await deps.api(`/objects/${state.objectId}/blocks/planning-tracks`);
    state.tracks = data.tracks || [];
  } catch (e) {
    state.tracks = [];
  }
  if (!state.trackCode || !state.tracks.some((t) => t["код"] === state.trackCode)) {
    state.trackCode = state.tracks.length ? state.tracks[0]["код"] : null;
  }
}

async function loadLayout() {
  if (!state.trackCode) { state.layout = null; return; }
  state.loading = true;
  state.loadError = "";
  render();
  try {
    const data = await deps.api(
      `/objects/${state.objectId}/blocks/chess-flat-layout?track_code=${encodeURIComponent(state.trackCode)}`);
    state.layout = data;
    state.objectName = data.object_name || "";
    state.blockIndex = new Map(data.blocks.map((b) => [`${b.section_id}|${b.level_id}`, b]));
    state.opsById = new Map(data.ops.map((o) => [o.id, o]));
    state.mergedLevels = mergeLevelsByFloor(data.levels);
    state.ranges = buildRanges(state.mergedLevels);
    if (state.autoPickRange) {
      state.rangeIndex = pickBestRangeIndex();
      state.autoPickRange = false;
    } else if (state.rangeIndex >= state.ranges.length) {
      state.rangeIndex = 0;
    }
    if (state.printTo >= state.mergedLevels.length || state.printTo === 0) {
      state.printFrom = 0;
      state.printTo = state.mergedLevels.length - 1;
    }
    state.snapshotAt = todayLocal();
  } catch (e) {
    state.layout = null;
    state.loadError = e.message || "Не удалось загрузить данные.";
  } finally {
    state.loading = false;
    render();
  }
}

// ------------------------------------------------------------- черновик/проверка

function activeEntries() {
  const prefix = state.trackCode + "|";
  return Object.entries(state.draft).filter(([k, v]) => k.startsWith(prefix) && v !== "");
}

function closeReview() {
  state.reviewing = false;
  state.reviewItems = null;
  state.idempotencyKey = null;
  state.conflictNotice = false;
}

function buildReview() {
  const entries = activeEntries();
  if (!entries.length || entries.some(([, v]) => !isValidPercent(v))) return;
  const items = entries.map(([key, value]) => {
    const [, blockIdStr, opIdStr] = key.split("|");
    const blockId = Number(blockIdStr), opId = Number(opIdStr);
    const block = state.layout.blocks.find((b) => b.id === blockId);
    const current = Number((block && block.percents[String(opId)]) ?? 0);
    const sec = state.layout.sections.find((s) => s.id === block.section_id);
    const lvl = state.layout.levels.find((l) => l.id === block.level_id);
    return {
      blockId, opId, current, value: Number(value),
      blockLabel: sec && lvl ? blockTitle(sec, lvl) : `Блок ${blockId}`,
      opName: (state.opsById.get(opId) || {}).name || String(opId),
    };
  });
  state.reviewItems = items;
  state.idempotencyKey = makeIdempotencyKey();
  state.reviewing = true;
  state.conflictNotice = false;
  render();
}

async function doCommit() {
  if (state.committing || !state.reviewItems) return;
  state.committing = true;
  render();
  try {
    const items = state.reviewItems.map((it) => ({
      block_id: it.blockId, work_type_id: it.opId, percent: it.value, expected_percent: it.current,
    }));
    const result = await deps.api(`/objects/${state.objectId}/blocks/chess-flat-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report_date: state.date, track_code: state.trackCode,
        idempotency_key: state.idempotencyKey, items,
      }),
    });
    for (const it of state.reviewItems) delete state.draft[draftKey(state.trackCode, it.blockId, it.opId)];
    state.successMessage = `Записано: ${result.items_count} ${plural(result.items_count, ["значение", "значения", "значений"])} · ` +
      `${result.blocks_count} ${plural(result.blocks_count, ["блок", "блока", "блоков"])} на ${fmtDate(result.report_date)}`;
    closeReview();
    await loadLayout();
  } catch (e) {
    const conflict = tryParseConflict(e.message);
    if (conflict) {
      state.loadError = "";
      await refreshLayoutSilently();
      // buildReview() сбрасывает conflictNotice (обычный вызов «Проверить и
      // записать» не должен унаследовать баннер предыдущего конфликта) —
      // выставляем флаг ПОСЛЕ, иначе он тут же стирался бы этим же вызовом.
      buildReview();
      state.conflictNotice = true;
      render();
    } else {
      state.loadError = e.message || "Не удалось записать факт.";
    }
  } finally {
    state.committing = false;
    render();
  }
}

async function refreshLayoutSilently() {
  try {
    const data = await deps.api(
      `/objects/${state.objectId}/blocks/chess-flat-layout?track_code=${encodeURIComponent(state.trackCode)}`);
    state.layout = data;
    state.blockIndex = new Map(data.blocks.map((b) => [`${b.section_id}|${b.level_id}`, b]));
    state.snapshotAt = todayLocal();
  } catch (e) {
    // Тихая попытка — итоговую ошибку человек уже увидит в баннере конфликта.
  }
}

function tryParseConflict(message) {
  try {
    const parsed = JSON.parse(message);
    if (parsed && parsed.conflict) return parsed;
  } catch (e) { /* не JSON — обычная текстовая ошибка */ }
  return null;
}

// ------------------------------------------------------------- печать

// px на 1мм В ЭТОМ рендере (масштаб экрана/ОС не всегда 96dpi) — общий
// делитель для перевода реальных px-измерений бумаги в физические мм.
let mmToPxCache = null;
function pxPerMm() {
  if (mmToPxCache) return mmToPxCache;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:100mm;width:0;pointer-events:none";
  document.body.appendChild(probe);
  mmToPxCache = probe.getBoundingClientRect().height / 100;
  probe.remove();
  return mmToPxCache || 3.78;
}

// Скрытый (visibility:hidden, НЕ display:none — иначе браузер не посчитает
// раскладку) узел для измерения фактической высоты бумаги — потомок
// #chess-flat, иначе на него не подействуют правила «.paper».
function ensureMeasureEl() {
  let el = document.getElementById("cf-paper-measure");
  if (!el && root) {
    el = document.createElement("div");
    el.id = "cf-paper-measure";
    el.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none";
    root.appendChild(el);
  }
  return el;
}

// Сколько уровней от levels[start] влезает на один физический лист.
// НЕ аналитическая формула «строка = 6мм» (была неверна с самого начала
// задания: имя операции печатается полностью и переносится на несколько
// строк — живой запрос пользователя 2026-09-14 — и высота строки перестала
// быть константой). Вместо расчёта — измерение РЕАЛЬНОГО рендера в скрытом
// узле того же класса и ширины, что печатная бумага: добавляем уровни по
// одному, пока фактическая высота не упрётся в высоту листа. Дороже
// аналитики, зато не может разойтись с тем, что реально уйдёт на печать.
function measureLevelsFit(levels, start, sections, format) {
  const el = ensureMeasureEl();
  if (!el) return 1;
  el.className = "paper" + (format === "A3" ? " a3" : "");
  // «.paper» держит min-height:297/420мм для ЭКРАННОГО превью (лист
  // выглядит листом даже с одной строкой) — при измерении это давало бы
  // scrollHeight ВСЕГДА не меньше высоты листа, и уже первый уровень
  // ложно казался бы «не влезающим». Инлайн-стиль побеждает класс по
  // специфичности и снимает именно эту нижнюю границу.
  el.style.minHeight = "0";
  const maxHeightPx = (format === "A3" ? 420 : 297) * pxPerMm();
  let count = 1;
  for (let n = 1; n <= levels.length - start; n++) {
    el.innerHTML = paperHtml({ levels: levels.slice(start, start + n), sections }, 0, 1);
    if (el.scrollHeight > maxHeightPx && n > 1) break;
    count = n;
    if (el.scrollHeight > maxHeightPx) break; // не влез даже один уровень целиком — берём как есть, меньше 1 нельзя
  }
  return count;
}

function printCapacitySections(format) {
  const paperWidthMM = format === "A3" ? 297 : 210;
  const usable = paperWidthMM - 12 - 8; // поля 6+6мм, колонка этажа 8мм
  // Три графы на секцию (имя операции печатается ПОЛНОСТЬЮ, живой запрос
  // пользователя 2026-09-14, не сливается с процентом в одной тесной
  // ячейке): ~30мм под имя (переносится на 2 строки, если не влезает,
  // высота листа не фиксирована) + 14мм «в системе» + 16мм «новый факт»
  // под рукописную запись.
  return Math.max(1, Math.floor(usable / 60));
}

function computePrintPages() {
  if (!state.layout) return [];
  const asc = ascLevels();
  const levels = state.printScope === "all" ? asc : asc.slice(state.printFrom, state.printTo + 1);
  const sectionCap = printCapacitySections(state.printFormat);

  const levelIds = new Set(levels.flatMap(rowLevelIds));
  const presentSectionIds = new Set();
  for (const b of state.layout.blocks) if (levelIds.has(b.level_id)) presentSectionIds.add(b.section_id);
  const sectionsAll = state.layout.sections.filter((s) => presentSectionIds.has(s.id));

  const sectionChunks = [];
  for (let i = 0; i < sectionsAll.length; i += sectionCap) sectionChunks.push(sectionsAll.slice(i, i + sectionCap));
  if (!sectionChunks.length) sectionChunks.push([]);

  const pages = [];
  for (const sc of sectionChunks) {
    // Секция, отсутствующая на ВСЕХ уровнях именно этой группы секций, не
    // резервирует пустую колонку (§8 задания) — состав уровней и колонок
    // считается заново для каждой группы секций отдельно.
    const scLevels = levels.filter((l) => sc.some((s) => blockAt(s.id, l)));
    if (!scLevels.length) continue;
    let i = 0;
    while (i < scLevels.length) {
      const n = measureLevelsFit(scLevels, i, sc, state.printFormat);
      const pageLevels = scLevels.slice(i, i + n);
      const present = sc.filter((s) => pageLevels.some((l) => blockAt(s.id, l)));
      pages.push({ levels: pageLevels, sections: present });
      i += n;
    }
  }
  return pages.length ? pages : [{ levels, sections: sectionsAll }];
}

function boardName() {
  const t = state.tracks.find((x) => x["код"] === state.trackCode);
  return t ? t["название"] : "";
}

// Операции этажа, применимые ХОТЯ БЫ у одного печатаемого блока (живой
// запрос пользователя 2026-09-14: неприменимая операция не должна быть
// строкой вовсе — как и на экране, но здесь строка ОБЩАЯ на весь этаж
// сразу, «rowspan» адреса этажа не даёт увести её по блокам независимо;
// компромисс — убираем только те операции, что не нужны НИ ОДНОМУ из
// показанных на листе блоков этого этажа, а там, где применимо лишь к
// части секций, у остальных в этой же строке просто пусто).
function usedOpsForLevel(level, sections) {
  return state.layout.ops.filter((op) => sections.some((s) => {
    const block = blockAt(s.id, level);
    return block && Object.prototype.hasOwnProperty.call(block.percents, String(op.id));
  }));
}

function paperHtml(page, index, total) {
  const sections = page.sections;
  let rows = "";
  for (const level of page.levels) {
    const usedOps = usedOpsForLevel(level, sections);
    if (!usedOps.length) {
      rows += `<tr class="floor-start"><th class="paper-floor">${esc(levelFloorLabel(level))}</th>` +
        sections.map(() => `<td colspan="3" class="paper-absent"></td>`).join("") + `</tr>`;
      continue;
    }
    usedOps.forEach((op, oi) => {
      rows += `<tr class="${oi === 0 ? "floor-start" : ""}">`;
      if (oi === 0) rows += `<th class="paper-floor" rowspan="${usedOps.length}">${esc(levelFloorLabel(level))}</th>`;
      for (const section of sections) {
        const block = blockAt(section.id, level);
        const has = block && Object.prototype.hasOwnProperty.call(block.percents, String(op.id));
        if (!has) { rows += `<td colspan="3" class="paper-absent"></td>`; continue; }
        const pct = block.percents[String(op.id)];
        // Три отдельные графы (живой запрос пользователя 2026-09-14: имя
        // операции печаталось полностью, текущий факт — отдельной графой,
        // а не слитно с именем в одной тесной ячейке, где длинное имя
        // обрезало и имя, и процент разом).
        rows += `<td class="paper-op-name">${esc(op.name)}</td>` +
                `<td class="paper-current-pct">${pct}%</td>` +
                `<td class="paper-new"></td>`;
      }
      rows += `</tr>`;
    });
  }
  const rangeLabel = page.levels.length
    ? `${levelFloorLabel(page.levels[0])}…${levelFloorLabel(page.levels[page.levels.length - 1])}`
    : "—";
  return `
    <header class="sheet-head">
      <div><strong>Шахматка · ${esc(boardName())}</strong><span>Дата факта: <b>${esc(fmtDate(state.date))}</b></span></div>
      <div><span>${esc(state.objectName)} · уровни ${esc(rangeLabel)}</span><span>Ответственный: __________________</span></div>
      <div><span>Снимок системы: ${esc(fmtDate(state.snapshotAt))} · итоговый процент 0–100</span><span>${esc(state.printFormat)} · книжная</span></div>
    </header>
    <table class="paper-matrix" aria-label="Бланк обхода по этажам и секциям">
      <colgroup><col style="width:8mm">${sections.map(() => "<col><col style=\"width:14mm\"><col style=\"width:16mm\">").join("")}</colgroup>
      <thead>
        <tr><th rowspan="2">Эт.</th>${sections.map((s) => `<th colspan="3">${esc(s.name || s.code)}</th>`).join("")}</tr>
        <tr>${sections.map(() => "<th>Операция</th><th>В системе, %</th><th>Новый факт, %</th>").join("")}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <footer class="sheet-foot">
      <div>Пусто — без записи; 0 — нулевой факт.</div>
      <div><span>Подпись: ______________________</span><span>Бланк ${esc(state.printBlankId)} · Лист ${index + 1} из ${total}</span></div>
    </footer>`;
}

function doPrintAction() {
  if (!state.layout) return;
  const pages = computePrintPages();
  const stack = root.querySelector("#cf-paper-print");
  stack.innerHTML = pages.map((p, i) =>
    `<div class="paper${state.printFormat === "A3" ? " a3" : ""}">${paperHtml(p, i, pages.length)}</div>`).join("");
  window.print();
}

// ------------------------------------------------------------- мини-схема здания

function overviewSvg() {
  const D = state.layout;
  const rows = state.mergedLevels;
  const sectionsUsed = D.sections.filter((s) => D.blocks.some((b) => b.section_id === s.id));
  const rowH = Math.max(3, Math.min(8, 260 / Math.max(1, rows.length)));
  const colW = 15;
  const width = 24 + sectionsUsed.length * colW;
  const height = rows.length * rowH + 4;
  const selectedIds = new Set((state.ranges[state.rangeIndex] || { levels: [] }).levels.flatMap(rowLevelIds));
  let svg = "";
  rows.forEach((row, i) => {
    const y = i * rowH;
    if (rowH >= 5) svg += `<text x="1" y="${y + rowH - 1}">${esc(levelFloorLabel(row))}</text>`;
    const selected = rowLevelIds(row).some((id) => selectedIds.has(id));
    sectionsUsed.forEach((s, ci) => {
      if (!blockAt(s.id, row)) return;
      const x = 24 + ci * colW;
      svg += `<rect x="${x}" y="${y}" width="${colW - 2}" height="${Math.max(1, rowH - 1)}" ` +
             `class="${selected ? "selected" : ""}"/>`;
    });
  });
  return { svg, width: Math.max(width, 40), height: Math.max(height, 20) };
}

// ------------------------------------------------------------- сборка HTML

function gridHtml(range) {
  const sections = sectionsForLevels(range.levels);
  let html = `<div class="grid-corner"></div>` + sections.map((s) => `<div class="section-head">${esc(s.name || s.code)}</div>`).join("");
  for (const level of range.levels) {
    html += `<div class="floor-label">${esc(levelFloorLabel(level))}<span>${esc(levelWord(level))}</span></div>`;
    for (const section of sections) html += blockCardHtml(section, level);
  }
  return { html, count: sections.length };
}

function blockCardHtml(section, level) {
  const block = blockAt(section.id, level);
  // Пустая область без подписи (живой запрос пользователя 2026-09-14) —
  // рамка `.empty-block` сама по себе уже отличает «секции здесь нет» от
  // ошибки рендера, текст поверх неё был лишним.
  if (!block) return `<div class="empty-block"></div>`;
  const title = blockTitle(section, level);
  // Строка операции, не применимой к ЭТОМУ блоку, на экране не
  // показывается вовсе (живой запрос пользователя 2026-09-14: «если не
  // применяется, то этой строке вообще не должно быть при выбранной
  // шахматке») — в отличие от бланка обхода, где общая сетка строк на
  // листе обязательна (rowspan этажа на всю доску сразу), карточка блока
  // на экране самостоятельна, ничья высота ни от чего не зависит.
  const applicableOps = state.layout.ops.filter(
    (op) => Object.prototype.hasOwnProperty.call(block.percents, String(op.id)));
  const body = applicableOps.length
    ? `<div class="column-heads"><span>В системе</span><span>Новое, %</span></div>` +
      applicableOps.map((op) => opRowHtml(block, title, op)).join("")
    : `<div class="empty-block" style="border:0;min-height:60px">Операции доски не настроены для этого блока</div>`;
  return `<article class="block">` +
    `<div class="block-title"><span>${esc(title)}</span><span class="block-id">Б${block.id}</span></div>` +
    body + `</article>`;
}

function opRowHtml(block, blockTitleText, op) {
  const key = draftKey(state.trackCode, block.id, op.id);
  const has = Object.prototype.hasOwnProperty.call(block.percents, String(op.id));
  const pct = has ? block.percents[String(op.id)] : null;
  const na = !has;
  const v = state.draft[key] ?? "";
  const filled = v !== "";
  const invalid = filled && !isValidPercent(v);
  const statusClass = na ? "" : pct === 100 ? "done" : pct > 0 ? "work" : "";
  const label = `${blockTitleText}, ${op.name}, новый процент`;
  const disabled = na || state.reviewing;
  return `<div class="op">` +
    `<div class="current ${statusClass}"><span>${esc(op.name)}</span><span class="pct">${na ? "—" : pct + "%"}</span></div>` +
    `<label class="entry">` +
    `<input inputmode="numeric" autocomplete="off" data-key="${esc(key)}" data-na="${na ? 1 : 0}" ` +
    `aria-label="${esc(label)}" ${disabled ? "disabled" : ""} placeholder="${na ? "—" : "···"}" ` +
    `value="${esc(v)}" class="${filled ? "filled" : ""}" ${invalid ? 'aria-invalid="true"' : ""}>` +
    `<span class="muted small">${na ? "" : "%"}</span></label></div>`;
}

function reviewHtml() {
  if (!state.reviewing || !state.reviewItems) return "";
  const rows = state.reviewItems.map((it) => {
    const flags = [];
    if (it.value < it.current) flags.push(" · уменьшение");
    else if (it.value === it.current) flags.push(" · повторный факт");
    return `<tr><td>${esc(it.blockLabel)}</td><td>${esc(it.opName)}</td><td>${it.current}%</td>` +
      `<td><strong>${it.value}%</strong>${flags.join("")}</td></tr>`;
  }).join("");
  const distinctBlocks = new Set(state.reviewItems.map((it) => it.blockId)).size;
  const conflictBanner = state.conflictNotice
    ? `<div class="error" style="padding:0 0 10px">Часть значений на сервере изменилась с момента ввода — сверьте таблицу ниже (обновлена) и подтвердите ещё раз.</div>`
    : "";
  return `<div class="review" id="cf-review" aria-labelledby="cf-review-title">` +
    `<div class="row between"><h2 id="cf-review-title">Проверка перед записью</h2>` +
    `<button class="button ghost" id="cf-back" type="button" ${state.committing ? "disabled" : ""}>Вернуться к вводу</button></div>` +
    conflictBanner +
    `<p class="small muted">Дата факта: ${esc(fmtDate(state.date))} · ${state.reviewItems.length} ` +
    `${plural(state.reviewItems.length, ["значение", "значения", "значений"])} · ${distinctBlocks} ` +
    `${plural(distinctBlocks, ["блок", "блока", "блоков"])} · новые отчёты по затронутым блокам</p>` +
    `<div class="grid-scroll"><table><thead><tr><th>Блок</th><th>Операция</th><th>В системе</th><th>Новый факт</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>` +
    `<div class="row between"><span class="small muted">Будут записаны только заполненные ячейки.</span>` +
    `<button class="button primary" id="cf-commit" type="button" ${state.committing ? "disabled" : ""}>` +
    `${state.committing ? "Записываем…" : "Подтвердить запись"}</button></div></div>`;
}

function inputPanelHtml() {
  if (state.loading) return `<div class="workspace"><p class="muted">Загрузка…</p></div>`;
  if (state.loadError && !state.layout) {
    return `<div class="workspace"><p class="error" style="padding:0">${esc(state.loadError)}</p></div>`;
  }
  if (!state.tracks.length) {
    return `<div class="workspace"><p class="muted">Нет ни одной доски «Шахматка», запланированной хотя бы для одного блока — сначала задайте состав работ блокам (карточка блока → «Настройки»).</p></div>`;
  }
  if (!state.layout) return `<div class="workspace"><p class="muted">Загрузка…</p></div>`;

  const range = state.ranges[state.rangeIndex] || { levels: [] };
  const { svg, width, height } = overviewSvg();
  const { html: grid, count } = gridHtml(range);
  const entries = activeEntries();
  const bad = entries.filter(([, v]) => !isValidPercent(v));
  const distinctBlocks = new Set(entries.map(([k]) => k.split("|")[1])).size;
  const summary = state.successMessage || (!entries.length ? "Нет новых значений" :
    `К записи: ${entries.length} ${plural(entries.length, ["значение", "значения", "значений"])} · ` +
    `${distinctBlocks} ${plural(distinctBlocks, ["блок", "блока", "блоков"])}`);
  const sub = entries.length
    ? `Дата факта: ${fmtDate(state.date)} · Включая ввод на других этажах`
    : "Пустая ячейка — без записи. 0 — факт нулевого выполнения.";

  return `
    <div class="workspace">
      <aside class="navigator">
        <label>Этажи<select id="cf-ranges" aria-label="Диапазон этажей">
          ${state.ranges.map((r, i) => `<option value="${i}" ${i === state.rangeIndex ? "selected" : ""}>${esc(r.title)}</option>`).join("")}
        </select></label>
        <details id="cf-overview-details" ${state.overviewOpen ? "open" : ""}>
          <summary>Схема здания</summary>
          <svg id="cf-overview" class="overview" viewBox="0 0 ${width} ${height}" role="img"
               aria-label="Развёртка здания с выбранными этажами">${svg}</svg>
        </details>
      </aside>
      <main>
        <div class="board-head">
          <div><h2 id="cf-range-title">${esc(range.title || "")}</h2>
            <div class="small muted">Каждая строка — операция. Справа — итоговый процент.</div></div>
          <span class="small muted">${state.layout.ops.length} ${plural(state.layout.ops.length, ["операция", "операции", "операций"])} на блок</span>
        </div>
        <div class="grid-scroll" role="region" aria-label="Плоская Шахматка">
          <!-- Потолок колонки 380px — не "1fr" (живой отчёт пользователя
               2026-09-14): при нескольких секциях и широком экране "1fr"
               растягивал каждый блок на сотни лишних пикселей, разводя
               название операции и поле ввода по разным краям карточки.
               С потолком лишняя ширина просто остаётся пустой справа от
               сетки — половины блока «В системе»/«Новое, %» стоят рядом. -->
          <div id="cf-grid" class="grid" style="grid-template-columns:44px repeat(${Math.max(count, 1)},minmax(240px,380px))">${grid}</div>
        </div>
        <div class="legend">
          <span><i class="dot"></i>0% · не начато</span>
          <span><i class="dot work"></i>1–99% · в работе</span>
          <span><i class="dot done"></i>100% · выполнено</span>
          <span>— · не применяется</span>
        </div>
      </main>
    </div>
    ${reviewHtml()}
    <footer class="footer">
      <div><div class="foot-status" aria-live="polite">${esc(summary)}</div>
        <div class="status-sub">${esc(sub)}</div></div>
      <div class="row">
        <button id="cf-clear" class="button ghost" type="button" ${state.reviewing || !entries.length ? "disabled" : ""}>Очистить ввод</button>
        <button id="cf-check" class="button primary" type="button" ${state.reviewing || !entries.length || bad.length ? "disabled" : ""}>Проверить и записать</button>
      </div>
    </footer>`;
}

function printRangePickerHtml() {
  const asc = ascLevels();
  const opts = (selected) => asc.map((l, i) =>
    `<option value="${i}" ${i === selected ? "selected" : ""}>${esc(levelFloorLabel(l))} ${esc(levelWord(l))}</option>`
  ).join("");
  return `<label class="field">С<select id="cf-print-from">${opts(state.printFrom)}</select></label>` +
         `<label class="field">По<select id="cf-print-to">${opts(state.printTo)}</select></label>`;
}

function printPanelHtml() {
  if (!state.layout) return `<div class="print-settings"><p class="muted">Сначала выберите доску на вкладке «Ввод данных».</p></div>`;
  const pages = computePrintPages();
  if (state.printPage >= pages.length) state.printPage = Math.max(0, pages.length - 1);
  const page = pages[state.printPage] || { levels: [], sections: [] };
  const totalLevels = pages.reduce((n, p) => n + p.levels.length, 0);
  return `
    <div class="print-settings">
      <label class="field">Печатать<select id="cf-scope">
        <option value="all" ${state.printScope === "all" ? "selected" : ""}>Всё здание</option>
        <option value="range" ${state.printScope === "range" ? "selected" : ""}>Диапазон этажей</option>
      </select></label>
      ${state.printScope === "range" ? printRangePickerHtml() : ""}
      <label class="field">Лист<select id="cf-format">
        <option value="A4" ${state.printFormat === "A4" ? "selected" : ""}>A4 · книжная</option>
        <option value="A3" ${state.printFormat === "A3" ? "selected" : ""}>A3 · книжная</option>
      </select></label>
      <div class="print-pagination">
        <button id="cf-prev" class="button" type="button" aria-label="Предыдущая страница" ${state.printPage === 0 ? "disabled" : ""}>←</button>
        <span class="small muted">Лист ${pages.length ? state.printPage + 1 : 0} из ${pages.length} · ${page.levels.length} уровней</span>
        <button id="cf-next" class="button" type="button" aria-label="Следующая страница" ${state.printPage >= pages.length - 1 ? "disabled" : ""}>→</button>
      </div>
      <button class="button primary" id="cf-print-action" type="button" ${pages.length ? "" : "disabled"}>Печатать бланк</button>
    </div>
    <div class="paper-wrap"><div class="paper ${state.printFormat === "A3" ? "a3" : ""}" id="cf-paper-preview">
      ${pages.length ? paperHtml(page, state.printPage, pages.length) : "<p class=\"muted\">Для выбранной доски нет ни одного блока с операциями.</p>"}
    </div></div>
    <div id="cf-paper-print"></div>
    <div class="notice" id="cf-print-hint">Число уровней на листе считается по фактической высоте текста (имя
      операции не обрезается) — новые значения всегда пустые. Печатается
      ${totalLevels} ${plural(totalLevels, ["уровень", "уровня", "уровней"])} на
      ${pages.length} ${plural(pages.length, ["листе", "листах", "листах"])}.</div>`;
}

function render() {
  if (!root) return;
  const dateVal = state.date;
  const past = dateVal < todayLocal(), future = dateVal > todayLocal();
  const dateNotice = past
    ? "Выбрана прошлая дата. Слева остаётся текущий статус в системе; новый факт будет записан в историю на выбранную дату."
    : future ? "Выбрана будущая дата. Перед записью проверьте дату факта." : "";

  root.innerHTML = `
    <header class="top">
      <div class="row between crumb">
        <span>ЖБИ / Модель МФР / Учёт по блокам</span>
        <button type="button" class="button ghost" id="chess-flat-close" aria-label="Закрыть плоскую Шахматку">✕ Закрыть</button>
      </div>
      <div class="row between">
        <div class="row"><h1>Шахматка</h1><span class="view-label">Плоский вид</span></div>
        <span class="muted small">${esc(state.objectName)}</span>
      </div>
    </header>
    <div class="toolbar">
      <label class="field">Доска<select id="cf-board" ${state.reviewing ? "disabled" : ""}>
        ${state.tracks.map((t) => `<option value="${esc(t["код"])}" ${t["код"] === state.trackCode ? "selected" : ""}>${esc(t["название"])}</option>`).join("")}
      </select></label>
      <label class="field">Дата фиксации факта<div class="date-controls">
        <input id="cf-date" type="date" aria-label="Дата фиксации факта" value="${esc(state.date)}" ${state.reviewing ? "disabled" : ""}>
        <button class="button ghost" id="cf-today" type="button" ${state.reviewing ? "disabled" : ""}>Сегодня</button>
      </div></label>
    </div>
    <div class="tabs" role="tablist" aria-label="Режим Шахматки">
      <button id="cf-input-tab" class="tab" role="tab" aria-selected="${state.tab === "input"}">Ввод данных</button>
      <button id="cf-print-tab" class="tab" role="tab" aria-selected="${state.tab === "print"}">Бланк обхода</button>
    </div>
    <div class="notice" id="cf-date-notice" ${dateNotice ? "" : "hidden"}>${esc(dateNotice)}</div>
    <div id="cf-error" class="error" role="alert" ${state.loadError && state.layout ? "" : "hidden"}>${esc(state.loadError)}</div>
    ${state.tab === "input" ? `<section id="cf-input-panel" role="tabpanel">${inputPanelHtml()}</section>`
                             : `<section id="cf-print-panel" role="tabpanel">${printPanelHtml()}</section>`}
  `;
}

// ------------------------------------------------------------- события

function onRootClick(e) {
  if (e.target.closest("#chess-flat-close")) { hide(); return; }
  if (e.target.closest("#cf-today")) { state.date = todayLocal(); onDateChanged(); return; }
  if (e.target.closest("#cf-clear")) {
    for (const k of Object.keys(state.draft)) if (k.startsWith(state.trackCode + "|")) delete state.draft[k];
    state.successMessage = "";
    closeReview();
    render();
    return;
  }
  if (e.target.closest("#cf-check")) { buildReview(); return; }
  if (e.target.closest("#cf-back")) { closeReview(); render(); return; }
  if (e.target.closest("#cf-commit")) { doCommit(); return; }
  if (e.target.closest("#cf-input-tab")) { switchTab("input"); return; }
  if (e.target.closest("#cf-print-tab")) { switchTab("print"); return; }
  if (e.target.closest("#cf-prev")) { state.printPage = Math.max(0, state.printPage - 1); render(); return; }
  if (e.target.closest("#cf-next")) { state.printPage += 1; render(); return; }
  if (e.target.closest("#cf-print-action")) { doPrintAction(); return; }
}

function onRootChange(e) {
  if (e.target.id === "cf-board") {
    state.trackCode = e.target.value;
    state.successMessage = "";
    closeReview();
    state.autoPickRange = true;
    state.printPage = 0;
    loadLayout();
    return;
  }
  if (e.target.id === "cf-date") {
    state.date = e.target.value || todayLocal();
    onDateChanged();
    return;
  }
  if (e.target.id === "cf-ranges") {
    state.rangeIndex = Number(e.target.value) || 0;
    closeReview();
    render();
    return;
  }
  if (e.target.id === "cf-scope") { state.printScope = e.target.value; state.printPage = 0; state.printBlankId = makeBlankId(); render(); return; }
  if (e.target.id === "cf-format") { state.printFormat = e.target.value; state.printPage = 0; state.printBlankId = makeBlankId(); render(); return; }
  if (e.target.id === "cf-print-from") {
    state.printFrom = Number(e.target.value) || 0;
    if (state.printFrom > state.printTo) state.printTo = state.printFrom;
    state.printPage = 0; state.printBlankId = makeBlankId(); render(); return;
  }
  if (e.target.id === "cf-print-to") {
    state.printTo = Number(e.target.value) || 0;
    if (state.printTo < state.printFrom) state.printFrom = state.printTo;
    state.printPage = 0; state.printBlankId = makeBlankId(); render(); return;
  }
}

function onDateChanged() {
  state.successMessage = "";
  closeReview();
  render();
}

function onRootInput(e) {
  const el = e.target;
  if (!el.matches(".entry input")) return;
  const value = el.value.trim();
  if (value === "") delete state.draft[el.dataset.key];
  else state.draft[el.dataset.key] = value;
  state.successMessage = "";
  el.classList.toggle("filled", value !== "");
  if (value !== "" && !isValidPercent(value)) el.setAttribute("aria-invalid", "true");
  else el.removeAttribute("aria-invalid");
  updateFooterLight();
}

function updateFooterLight() {
  // Лёгкое обновление счётчика/кнопок БЕЗ перестройки грида — полный
  // render() на каждое нажатие клавиши сбросил бы фокус поля (см. тот же
  // приём в mockup.html, root.addEventListener('input', ...)).
  const entries = activeEntries();
  const bad = entries.filter(([, v]) => !isValidPercent(v));
  const distinctBlocks = new Set(entries.map(([k]) => k.split("|")[1])).size;
  const checkBtn = root.querySelector("#cf-check");
  const clearBtn = root.querySelector("#cf-clear");
  if (checkBtn) checkBtn.disabled = state.reviewing || !entries.length || bad.length > 0;
  if (clearBtn) clearBtn.disabled = state.reviewing || !entries.length;
  const summaryEl = root.querySelector(".foot-status");
  const subEl = root.querySelector(".status-sub");
  if (summaryEl) {
    summaryEl.textContent = !entries.length ? "Нет новых значений" :
      `К записи: ${entries.length} ${plural(entries.length, ["значение", "значения", "значений"])} · ` +
      `${distinctBlocks} ${plural(distinctBlocks, ["блок", "блока", "блоков"])}`;
  }
  if (subEl) {
    subEl.textContent = entries.length
      ? `Дата факта: ${fmtDate(state.date)} · Включая ввод на других этажах`
      : "Пустая ячейка — без записи. 0 — факт нулевого выполнения.";
  }
  const errEl = root.querySelector("#cf-error");
  if (errEl && !state.loadError) {
    const msg = bad.length ? "Введите целое число от 0 до 100. Исправьте отмеченные ячейки." : "";
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }
}

function onRootKeydown(e) {
  if (e.key === "Enter" && e.target.matches(".entry input")) {
    e.preventDefault();
    const inputs = [...root.querySelectorAll(".entry input:not(:disabled)")];
    const i = inputs.indexOf(e.target);
    if (inputs.length) inputs[(i + 1) % inputs.length].focus();
  }
}

function onRootToggle(e) {
  if (e.target && e.target.id === "cf-overview-details") state.overviewOpen = e.target.open;
}

function switchTab(tab) {
  closeReview();
  state.tab = tab;
  if (tab === "print" && !state.printBlankId) state.printBlankId = makeBlankId();
  render();
}

function hasUnsavedDraft() {
  return Object.keys(state.draft).some((k) => state.draft[k] !== "");
}

function onBeforeUnload(e) {
  if (backdrop && backdrop.style.display !== "none" && hasUnsavedDraft()) {
    e.preventDefault();
    e.returnValue = "";
  }
}

function onKeydownGlobal(e) {
  if (e.key === "Escape" && backdrop && backdrop.style.display !== "none" && !state.committing) hide();
}

// ------------------------------------------------------------- монтирование/показ

function hide() {
  backdrop.style.display = "none";
}

function show() {
  backdrop.style.display = "flex";
}

function ensureMounted() {
  if (mounted) return;
  injectStyles();
  const host = document.getElementById("chess-flat-overlay-root");
  host.innerHTML = `<div id="chess-flat-backdrop" style="display:none"><div id="chess-flat"></div></div>`;
  backdrop = document.getElementById("chess-flat-backdrop");
  root = document.getElementById("chess-flat");
  root.addEventListener("click", onRootClick);
  root.addEventListener("change", onRootChange);
  root.addEventListener("input", onRootInput);
  root.addEventListener("keydown", onRootKeydown);
  root.addEventListener("toggle", onRootToggle, true);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("keydown", onKeydownGlobal);
  mounted = true;
}

export function openChessFlat(dependencies, objectId, trackCode) {
  deps = dependencies;
  ensureMounted();
  const sameObject = state.objectId === objectId;
  state.objectId = objectId;
  if (trackCode && !sameObject) state.trackCode = trackCode;
  else if (trackCode && !state.trackCode) state.trackCode = trackCode;
  if (!sameObject) {
    state.layout = null;
    state.ranges = [];
    state.rangeIndex = 0;
    // Новый объект (в т.ч. самое первое открытие) — подбираем диапазон
    // заново; тот же объект, повторно открытый оверлей — сохраняем
    // выбор человека, а не сбрасываем его на каждый показ экрана.
    state.autoPickRange = true;
  }
  state.tab = "input";
  state.date = todayLocal();
  closeReview();
  state.successMessage = "";
  state.loadError = "";
  show();
  render();
  loadTracks().then(loadLayout);
}

// ------------------------------------------------------------- стили (точная копия макета)

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

// Имена классов в макете общие («.tabs», «.row», «.button», …) — у самого
// приложения (app/static/index.html) есть СВОИ глобальные, ничем не
// скопированные правила под теми же именами (например «.tabs» — общий
// компонент вкладок сайдбара, с margin:-16px и position:sticky под свой
// контекст). Наш «#chess-flat .tabs{…}» побеждает их по специфичности
// ТОЛЬКО для свойств, которые сам явно задаёт — а margin/position он не
// трогал, и чужие значения просачивались, сдвигая и накладывая друг на
// друга шапку/вкладки (живой отчёт пользователя 2026-09-14, воспроизвелось
// только на широком экране, где боевая верстка отличалась от макета).
// `#chess-flat *{margin:0;position:static;border-radius:0;box-shadow:none}`
// ниже — щит от этого класса ошибок целиком: обнуляет протекающие
// настройки у ВСЕХ потомков разом (border-radius — тот же случай: у
// глобального «.tab» приложения он под собственную «pill»-кнопку, 999px,
// и с ним подчёркивание активной вкладки рисовалось не прямой линией, а
// дугой — живой отчёт пользователя 2026-09-14, «вместо линии подчёркивания
// какая-то скобка»), а нужные ненулевые значения (margin у `.review`,
// position у `.paper`, border-radius у `.button`/`.view-label`) каждое
// правило переопределяет явно и всё равно побеждает — оно specificity
// выше (id+класс против id+звёздочки). Не убирать даже если визуально
// «лишнее»: без него это наложение вернётся при первом же
// совпадении имени класса.
const CSS_TEXT = `
#chess-flat-backdrop{position:fixed;inset:0;z-index:500;background:light-dark(#f2f4f7,#14161a);overflow-x:hidden;overflow-y:auto;flex-direction:column}
#chess-flat{--cf-bg:light-dark(#f2f4f7,#14161a);--cf-paper:light-dark(#fff,#1e2126);--cf-soft:light-dark(#f7f8fa,#262a30);--cf-line:light-dark(#dde1e6,#424750);--cf-ink:light-dark(#1a1d21,#e8eaed);--cf-muted:light-dark(#626b78,#abb2be);--cf-blue:light-dark(#1353d6,#8bb4ff);--cf-bluefill:light-dark(#edf3ff,#223957);--cf-done:light-dark(#e9f5ee,#203b2d);--cf-donetext:light-dark(#267547,#9edcb4);--cf-work:light-dark(#fff3dc,#44371f);--cf-worktext:light-dark(#815507,#f0cc87);color-scheme:light dark;background:var(--cf-bg);color:var(--cf-ink);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100%;min-width:0;width:100%;display:flex;flex-direction:column}
#chess-flat *{box-sizing:border-box;margin:0;position:static;border-radius:0;box-shadow:none}#chess-flat button,#chess-flat input,#chess-flat select{font:inherit;color:inherit}#chess-flat button{cursor:pointer}#chess-flat button:disabled{cursor:default;opacity:.45}#chess-flat [hidden]{display:none!important}#chess-flat h1,#chess-flat h2,#chess-flat p{margin:0}#chess-flat h1{font-size:20px;font-weight:500;letter-spacing:-.5px}#chess-flat h2{font-size:15px;font-weight:500}#chess-flat .muted{color:var(--cf-muted)}#chess-flat .small{font-size:12px}#chess-flat .top{padding:8px 12px;background:var(--cf-paper);border-bottom:1px solid var(--cf-line)}#chess-flat .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0}#chess-flat .between{justify-content:space-between}#chess-flat .crumb{font-size:12px;color:var(--cf-muted);margin-bottom:3px}#chess-flat .view-label{padding:5px 9px;background:var(--cf-bluefill);color:var(--cf-blue);border-radius:5px;font-size:12px}#chess-flat .button{border:1px solid var(--cf-line);background:var(--cf-paper);padding:6px 10px;border-radius:7px;white-space:nowrap}#chess-flat .button.primary{background:var(--cf-blue);color:light-dark(#fff,#102039);border-color:var(--cf-blue)}#chess-flat .button.ghost{background:transparent;border-color:transparent}#chess-flat .button:hover:not(:disabled){filter:brightness(.96)}#chess-flat .toolbar{background:var(--cf-paper);padding:8px 12px;display:flex;align-items:end;gap:14px;flex-wrap:nowrap;border-bottom:1px solid var(--cf-line)}#chess-flat .toolbar label.field{flex:0 0 auto}#chess-flat .toolbar-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#chess-flat label.field{display:grid;gap:5px;font-size:12px;color:var(--cf-muted)}#chess-flat select,#chess-flat input[type=date]{height:36px;border:1px solid var(--cf-line);background:var(--cf-paper);border-radius:6px;padding:6px 9px;color:var(--cf-ink)}#chess-flat .date-controls{display:flex;gap:4px}#chess-flat .tabs{display:flex;border-bottom:1px solid var(--cf-line);background:var(--cf-paper);padding:0 12px;gap:24px}#chess-flat .tab{background:none;border:0;border-bottom:3px solid transparent;padding:7px 0;color:var(--cf-muted)}#chess-flat .tab[aria-selected=true]{border-bottom-color:var(--cf-blue);color:var(--cf-blue);font-weight:500}
#chess-flat .workspace{display:block;padding:10px 12px}#chess-flat .navigator{border:0;padding:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:9px}
#chess-flat .navigator label{display:flex;align-items:center;gap:8px;font-size:12px}#chess-flat .navigator select{height:30px;padding:3px 7px}
#chess-flat .navigator details{font-size:12px;color:var(--cf-muted)}#chess-flat .navigator details[open]{width:100%}#chess-flat .navigator summary{cursor:pointer}
#chess-flat .overview{width:120px;height:256px;margin:5px 0;display:block}#chess-flat .overview rect{fill:var(--cf-paper);stroke:var(--cf-line);stroke-width:1}#chess-flat .overview rect.selected{fill:var(--cf-bluefill);stroke:var(--cf-blue)}#chess-flat .overview text{fill:var(--cf-muted);font:9px sans-serif}
#chess-flat .board-head{margin-bottom:6px;display:flex;justify-content:space-between;gap:10px;align-items:start;flex-wrap:wrap}/* overflow-x:auto с overflow-y:visible не работает — спецификация CSS
   сама принудительно вычисляет overflow-y как auto, если overflow-x не
   visible («UA-computed value», обойти нельзя). Раз оба всё равно auto —
   даём этому явную и полезную роль: «.grid-scroll» сам становится
   ограниченной по высоте прокручиваемой областью (а не только
   горизонтально), и «position:sticky» у «.section-head» внутри неё
   работает относительно НЕЁ (ближайший скролл-контейнер), а не страницы
   целиком — без этой явной высоты sticky был бы приклеен к контейнеру,
   который сам целиком уезжает вместе со страницей, и подписи секций
   пропадали бы за пределами экрана при скролле (живой запрос
   пользователя 2026-09-14). */
#chess-flat .grid-scroll{overflow:auto;max-height:calc(100vh - 300px);max-width:100%}#chess-flat .grid{min-width:640px;display:grid;gap:4px}
#chess-flat .section-head{font-size:13px;font-weight:500;padding:4px 0 6px;position:sticky;top:0;background:var(--cf-bg);z-index:2}#chess-flat .grid-corner{position:sticky;top:0;background:var(--cf-bg);z-index:2}#chess-flat .floor-label{padding-top:7px;text-align:center;font-size:16px;font-weight:500;color:var(--cf-muted)}#chess-flat .floor-label span{display:block;font-size:10px;font-weight:400}
#chess-flat .block{background:var(--cf-paper);border:1px solid var(--cf-line);border-radius:3px;overflow:hidden}#chess-flat .block-title{display:flex;justify-content:space-between;padding:3px 8px;font-size:12px;background:var(--cf-soft);font-weight:500;gap:5px}#chess-flat .block-id{color:var(--cf-muted);font-weight:400}
#chess-flat .column-heads,#chess-flat .op{display:grid;grid-template-columns:1fr 1fr}#chess-flat .column-heads{color:var(--cf-muted);font-size:11px;border-top:1px solid var(--cf-line);border-bottom:1px solid var(--cf-line)}#chess-flat .column-heads span{padding:5px 10px}#chess-flat .column-heads span+span{border-left:1px solid var(--cf-line)}#chess-flat .op+.op{border-top:1px solid var(--cf-line)}
#chess-flat .current{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:3px 8px;font-size:12px;background:var(--cf-soft)}#chess-flat .current.work{background:var(--cf-work)}#chess-flat .current.done{background:var(--cf-done)}#chess-flat .pct{font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
#chess-flat .entry{border-left:1px solid var(--cf-line);padding:2px 7px;display:flex;align-items:center;gap:5px}#chess-flat .entry input{width:100%;min-width:0;height:24px;border:1px solid var(--cf-line);background:var(--cf-paper);border-radius:3px;padding:2px 6px;font-variant-numeric:tabular-nums;text-align:right}#chess-flat .entry input:focus{outline:2px solid var(--cf-blue);outline-offset:1px}#chess-flat .entry input.filled{border-color:var(--cf-blue);background:var(--cf-bluefill)}#chess-flat .entry input[aria-invalid=true]{border-color:light-dark(#bc352e,#ff988f);outline:1px solid light-dark(#bc352e,#ff988f)}#chess-flat .entry input:disabled{background:var(--cf-soft)}
#chess-flat .empty-block{border:1px dashed var(--cf-line);border-radius:3px;min-height:112px;display:flex;align-items:center;justify-content:center;color:var(--cf-muted);font-size:12px;text-align:center;padding:10px}
#chess-flat .legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--cf-muted);padding:7px 0 0}#chess-flat .legend span{display:flex;align-items:center;gap:5px}#chess-flat .dot{width:9px;height:9px;border:1px solid var(--cf-line);border-radius:2px;background:var(--cf-soft)}#chess-flat .dot.work{background:var(--cf-work)}#chess-flat .dot.done{background:var(--cf-done)}
#chess-flat .footer{padding:9px 12px;border-top:1px solid var(--cf-line);background:var(--cf-paper);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}#chess-flat .foot-status{font-weight:500}#chess-flat .status-sub{margin-top:3px;color:var(--cf-muted);font-size:12px}
#chess-flat .notice{color:var(--cf-blue);background:var(--cf-bluefill);padding:9px 12px;margin:0 12px 12px;border-radius:6px;font-size:12px}#chess-flat .error{color:light-dark(#bc352e,#ff988f);padding:0 12px 12px;font-size:12px}
#chess-flat .review{background:var(--cf-paper);padding:12px;margin:10px 12px;border:1px solid var(--cf-blue);border-radius:9px}#chess-flat .review table{border-collapse:collapse;width:100%;font-size:13px;margin:15px 0}#chess-flat .review th,#chess-flat .review td{text-align:left;padding:9px;border-bottom:1px solid var(--cf-line)}#chess-flat .review th{font-weight:500;color:var(--cf-muted);font-size:12px}
#chess-flat .print-settings{padding:9px 12px;display:flex;gap:10px;align-items:end;flex-wrap:wrap}#chess-flat .paper-wrap{padding:0 12px 8px;overflow:auto}
#chess-flat .paper{width:210mm;min-width:210mm;min-height:297mm;padding:6mm;margin:0 auto;border:0;box-shadow:0 0 0 1px #b9bdc3;color:#171717;background:#fff;line-height:1.15;font-size:9pt}
#chess-flat .paper.a3{width:297mm;min-width:297mm;min-height:420mm}
#chess-flat .sheet-head{height:12mm;font:9pt/1.1 Arial,sans-serif}#chess-flat .sheet-head>div{display:flex;align-items:center;justify-content:space-between;gap:3mm;height:3.7mm;white-space:nowrap}#chess-flat .sheet-head strong{font-size:11pt;font-weight:500}
#chess-flat .paper-matrix{border-collapse:collapse;width:100%;table-layout:fixed;font:9pt/1.1 Arial,sans-serif;color:#171717}
#chess-flat .paper-matrix th,#chess-flat .paper-matrix td{border:.2mm solid #777;padding:0 1mm;overflow:hidden;font-weight:400}
#chess-flat .paper-matrix thead th{height:4.5mm;white-space:normal;overflow:visible;line-height:1.05;background:#f2f2f2;text-align:center}
#chess-flat .paper-matrix tbody tr{height:6mm}#chess-flat .paper-matrix td{height:6mm}
#chess-flat .paper-matrix .paper-floor{vertical-align:middle;text-align:center;font-weight:500;font-size:10pt}
#chess-flat .paper-matrix .floor-start>*{border-top:.4mm solid #333}
#chess-flat .paper-matrix td.paper-op-name{white-space:normal;overflow:visible;word-break:break-word;vertical-align:middle;line-height:1.15}
#chess-flat .paper-current-pct{text-align:center;font-weight:500;vertical-align:middle;white-space:nowrap}
#chess-flat .paper-new{text-align:center}#chess-flat .paper-absent{background:#fafafa}
#chess-flat .sheet-foot{height:8mm;padding-top:1mm;font:9pt/1.15 Arial,sans-serif}#chess-flat .sheet-foot>div{display:flex;justify-content:space-between;gap:2mm;white-space:nowrap;margin-bottom:.5mm}
#chess-flat .print-pagination{display:flex;gap:8px;align-items:center;flex-wrap:wrap}#chess-flat .print-pagination button{padding:5px 9px}
#chess-flat #cf-paper-print{display:none}
@media(max-width:800px){#chess-flat .navigator{align-items:start}#chess-flat .navigator label{flex-wrap:wrap}#chess-flat .navigator .overview{display:block}#chess-flat .toolbar{align-items:end}#chess-flat .sheet-head>div,#chess-flat .sheet-foot>div{flex-wrap:nowrap}#chess-flat .review{margin:10px;padding:10px}#chess-flat .review table{min-width:520px}}
@media(pointer:coarse){#chess-flat button,#chess-flat input,#chess-flat select{min-height:40px}#chess-flat .entry input{font-size:16px}}
@media print{
  body *{visibility:hidden}
  #chess-flat-backdrop,#chess-flat-backdrop *{visibility:visible}
  #chess-flat-backdrop{position:absolute;inset:0;background:#fff;overflow:visible;display:block}
  #chess-flat{border:0;border-radius:0;min-height:0}
  #chess-flat .top,#chess-flat .toolbar,#chess-flat .tabs,#chess-flat .print-settings,#chess-flat .notice,#chess-flat .footer,#chess-flat .review{display:none!important}
  #chess-flat #cf-paper-preview{display:none!important}
  #chess-flat #cf-paper-print{display:block!important}
  #chess-flat .paper-wrap{padding:0;overflow:visible}
  #chess-flat .paper,#chess-flat .paper.a3{width:auto;min-width:0;min-height:0;padding:0;margin:0;border:0;box-shadow:none;break-after:page}
  #chess-flat .paper:last-child{break-after:auto}
  #chess-flat .paper-matrix tbody tr{break-inside:avoid}
  #chess-flat .paper-matrix thead{display:table-header-group}
}
`;
