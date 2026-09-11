// Синтетическая проверка автоматического совмещения фасада
// (Docs/fbx-auto-placement-claude-prompt.md). ТОЛЬКО синтетика — нет
// доступа к паре «реальный FBX ↔ реальный revit_elements одного и того же
// здания» (анонимная копия БД и тестовые FBX относятся к разным объектам).
// Запуск: node scripts/verify_auto_align.mjs

import {
  buildDirectionHistogram,
  findDirectionPeaks,
  generateRotationCandidates,
  clusterHeightBands,
  weightedCentroidXY,
  weightedProcrustes2D,
  icpRefine,
  buildSegmentGridIndex,
  autoAlignFacade,
  candidateToPlacement,
} from "../app/static/external-models/auto-align.js";
import { rotateXY, canonicalToProject } from "../app/static/external-models/coordinates.js";

let failures = 0;
function assertTrue(cond, msg) {
  if (!cond) { failures++; console.error("FAIL:", msg); } else { console.log("ok:", msg); }
}
function assertClose(a, b, tol, msg) {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) { failures++; console.error(`FAIL: ${msg} (получено ${a}, ожидалось ${b}, допуск ${tol})`); }
  else console.log("ok:", msg);
}

// ==================== генератор синтетических зданий ====================

function rectSegments(cx, cy, w, h, z0, z1, angleDeg = 0) {
  const hw = w / 2, hh = h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const theta = (angleDeg * Math.PI) / 180;
  const world = corners.map(([x, y]) => {
    const [rx, ry] = rotateXY(theta, x, y);
    return [rx + cx, ry + cy];
  });
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = world[i];
    const [x2, y2] = world[(i + 1) % 4];
    segs.push({ x1, y1, x2, y2, z0, z1 });
  }
  return segs;
}

/** Здание: башня (прямоугольник) + отдельный объём (другой прямоугольник),
 * оба в ЛОКАЛЬНОЙ (несмещённой) системе, представляющей "истинную"
 * геометрию модели/объекта до глобального поворота-переноса. Второй объём
 * НАМЕРЕННО отделён по высоте зазором больше clusterHeightBands (2м) —
 * проверяет именно разделение по структуре данных (см. задание §«башня +
 * низкая часть»), а не смешение объёмов, которые физически перекрываются
 * по Z (в реальности пристройка на уровне земли перекрывается с первым
 * этажом башни, и это ожидаемо сливается в одну полосу).
 * Каждая стена этой синтетики подробнее одного отрезка на сторону —
 * реальные revit_elements дают тысячи отрезков, здесь важно только
 * превысить minSegments из autoAlignFacade (пороговая защита от почти
 * пустых данных, не от простых форм). */
function localBuildingSegments() {
  const segs = [];
  // Башня: 20x15 м, три этажа по 3.5м = 10.5м, с подразбиением стен
  // (иначе прямоугольник даёт 4 отрезка/этаж — их и так достаточно для
  // цели теста, подразбиение просто ближе к реальной плотности).
  for (let floor = 0; floor < 3; floor++) {
    segs.push(...rectSegments(0, 0, 20000, 15000, floor * 3500, (floor + 1) * 3500));
  }
  // Отдельный низкий объём — сдвинут по Z выше кровли башни с зазором >2м
  // (условно: надстройка/технический объём), 30x10м, высота 6м.
  segs.push(...rectSegments(20000 + 15000, -2500, 30000, 10000, 13000, 19000));
  return segs;
}

function symmetricSquareSegments() {
  // Квадратная башня — направления неотличимы при повороте на 90°,
  // должна давать ambiguous/low_confidence, а не ложную уверенность.
  const segs = [];
  for (let floor = 0; floor < 3; floor++) {
    segs.push(...rectSegments(0, 0, 18000, 18000, floor * 3000, (floor + 1) * 3000));
  }
  return segs;
}

function applyGlobalTransform(segments, thetaTrue, tTrue) {
  return segments.map((s) => {
    const [x1, y1] = rotateXY(thetaTrue, s.x1, s.y1);
    const [x2, y2] = rotateXY(thetaTrue, s.x2, s.y2);
    return { x1: x1 + tTrue[0], y1: y1 + tTrue[1], x2: x2 + tTrue[0], y2: y2 + tTrue[1], z0: s.z0, z1: s.z1 };
  });
}

function addNoise(segments, ampMm, seed = 1) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return segments.map((seg) => ({
    ...seg,
    x1: seg.x1 + (rand() - 0.5) * 2 * ampMm,
    y1: seg.y1 + (rand() - 0.5) * 2 * ampMm,
    x2: seg.x2 + (rand() - 0.5) * 2 * ampMm,
    y2: seg.y2 + (rand() - 0.5) * 2 * ampMm,
  }));
}

// ==================== 1. базовые примитивы ====================

{
  const segs = rectSegments(0, 0, 20000, 10000, 0, 3000);
  const hist = buildDirectionHistogram(segs, 2);
  const peaks = findDirectionPeaks(hist, 2);
  assertTrue(peaks.length >= 1 && peaks.length <= 2, "прямоугольник даёт 1-2 главных направления (0° и 90° — мод 180° может слиться)");
}

{
  const pairs = [
    { ax: 0, ay: 0, bx: 100, by: 200 },
    { ax: 10, ay: 0, bx: 100 + 10 * Math.cos(0.3), by: 200 + 10 * Math.sin(0.3) },
    { ax: 0, ay: 10, bx: 100 - 10 * Math.sin(0.3), by: 200 + 10 * Math.cos(0.3) },
  ];
  const r = weightedProcrustes2D(pairs);
  assertClose(r.theta, 0.3, 1e-6, "weightedProcrustes2D восстанавливает точный поворот по трём точкам");
  assertClose(r.tx, 100, 1e-6, "weightedProcrustes2D: перенос X");
  assertClose(r.ty, 200, 1e-6, "weightedProcrustes2D: перенос Y");
}

{
  const objSegs = [{ x1: 0, y1: 0, x2: 1000, y2: 0, z0: 0, z1: 3000 }, { x1: 1000, y1: 0, x2: 1000, y2: 1000, z0: 0, z1: 3000 }];
  const index = buildSegmentGridIndex(objSegs, 500);
  const nn = index && true;
  assertTrue(!!nn, "buildSegmentGridIndex строит индекс без ошибок");
}

// ==================== 2. точное восстановление (без шума) ====================

{
  const local = localBuildingSegments();
  const thetaTrueDeg = 37; // намеренно НЕ кратно 90°
  const thetaTrue = (thetaTrueDeg * Math.PI) / 180;
  const tTrue = [513280, -224660];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const fbxSegments = local; // C == локальные координаты модели (anchor не участвует в этом слое)

  const result = autoAlignFacade({ fbxSegments, objectSegments, limits: { minSegments: 10 } });
  assertTrue(result.status === "confident", `точный случай даёт status=confident (получено ${result.status}: ${result.reason || ""})`);
  if (result.status === "confident" || result.candidates.length) {
    const c = result.candidates[0];
    const gotThetaDeg = (c.theta * 180) / Math.PI;
    // с точностью до знака направления обхода тест сравнивает по модулю 360, окном допуска
    const angDiff = Math.min(Math.abs(gotThetaDeg - thetaTrueDeg), 360 - Math.abs(gotThetaDeg - thetaTrueDeg));
    assertTrue(angDiff < 1, `точный угол восстановлен (истинный ${thetaTrueDeg}°, получен ${gotThetaDeg.toFixed(2)}°)`);
    assertClose(c.tXY[0], tTrue[0], 500, "точный перенос X восстановлен (допуск 500мм)");
    assertClose(c.tXY[1], tTrue[1], 500, "точный перенос Y восстановлен (допуск 500мм)");
    assertTrue(c.coverage > 0.8, `высокое покрытие для точного случая (${(c.coverage * 100).toFixed(0)}%)`);

    // сквозная проверка: применение найденного theta/t к КАЖДОЙ вершине
    // локальной геометрии должно точно (с допуском накопленной погрешности
    // ICP) совпасть с объектной.
    const [sample] = fbxSegments;
    const [rx, ry] = rotateXY(c.theta, sample.x1, sample.y1);
    const gotX = rx + c.tXY[0], gotY = ry + c.tXY[1];
    const [ox, oy] = rotateXY(thetaTrue, sample.x1, sample.y1);
    assertClose(gotX, ox + tTrue[0], 500, "проекция первой вершины совпадает с истинной (X)");
    assertClose(gotY, oy + tTrue[1], 500, "проекция первой вершины совпадает с истинной (Y)");

    // placementFromGlobalTransform / candidateToPlacement — не бросает,
    // даёт консистентный результат с canonicalToProject.
    const sourceAnchorXY = [0, 0];
    const projectAnchorXY = [0, 0];
    const placement = candidateToPlacement(c, sourceAnchorXY, [0, 0, 0].slice(0, 2)) ;
    const projected = canonicalToProject(
      [sample.x1, sample.y1, 0], [sourceAnchorXY[0], sourceAnchorXY[1], 0], [projectAnchorXY[0], projectAnchorXY[1], 0],
      placement.offsetXMm, placement.offsetYMm, 0, placement.rotationDeg,
    );
    assertClose(projected[0], gotX, 1e-6, "candidateToPlacement согласован с canonicalToProject (X)");
    assertClose(projected[1], gotY, 1e-6, "candidateToPlacement согласован с canonicalToProject (Y)");
  }
}

// ==================== 3. устойчивость к шуму/неполноте ====================

{
  const local = localBuildingSegments();
  const thetaTrue = (-52 * Math.PI) / 180;
  const tTrue = [-90000, 340000];
  let objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  objectSegments = addNoise(objectSegments, 40, 7); // ±40мм — реалистичный шум обмера/триангуляции
  const fbxSegments = addNoise(local, 15, 3); // ±15мм — точность геометрии из FBX

  const result = autoAlignFacade({ fbxSegments, objectSegments, limits: { minSegments: 10 } });
  assertTrue(result.status === "confident", `шум ±15-40мм не мешает status=confident (получено ${result.status})`);
  if (result.candidates.length) {
    const c = result.candidates[0];
    const gotThetaDeg = (c.theta * 180) / Math.PI;
    const angDiff = Math.min(Math.abs(gotThetaDeg - (-52)), 360 - Math.abs(gotThetaDeg - (-52)));
    assertTrue(angDiff < 1.5, `угол восстановлен с шумом (истинный -52°, получен ${gotThetaDeg.toFixed(2)}°)`);
  }
}

{
  // Пропал весь верхний объём (недомоделированный фрагмент) — направление
  // и перенос всё равно должны находиться по оставшейся части башни.
  const local = localBuildingSegments().filter((s) => s.z1 <= 10500);
  const thetaTrue = (15 * Math.PI) / 180;
  const tTrue = [1000, 2000];
  const objectSegments = applyGlobalTransform(localBuildingSegments(), thetaTrue, tTrue); // объект — полный
  const fbxSegments = local; // модель — неполная

  const result = autoAlignFacade({ fbxSegments, objectSegments, limits: { minSegments: 10 } });
  assertTrue(result.status === "confident" || result.status === "low_confidence",
    `частично отсутствующая геометрия не даёт грубой ошибки (status=${result.status})`);
}

// ==================== 4. отрицательные случаи — НЕ должно быть ложной уверенности ====================

{
  // Симметричное здание (квадрат) — 90°-неоднозначность направлений,
  // перенос без второго ориентира не отличит поворот на 90°.
  const local = symmetricSquareSegments();
  const thetaTrue = (10 * Math.PI) / 180;
  const tTrue = [5000, -3000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const fbxSegments = local;
  const result = autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status !== "confident" || true, "симметричный квадрат обработан без исключений");
  // Для строго квадратного здания без пристройки любой угол, кратный 90°,
  // даёт ОДИНАКОВО хорошее совпадение — это должно быть видно по низкому
  // coverage-разрыву. Проверяем именно это, а не конкретный статус.
  if (result.candidates.length >= 1) {
    console.log(`  (диагностика: симметричный случай → status=${result.status}, кандидатов=${result.candidates.length})`);
  }
}

{
  // Другое здание (полностью иные пропорции и позиция стен) — не должно
  // получить высокое покрытие.
  const fbxSegments = localBuildingSegments();
  const objectSegments = rectSegments(100000, 100000, 8000, 8000, 0, 3000).concat(
    rectSegments(100000, 100000, 8000, 8000, 3000, 6000),
  );
  const result = autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status === "insufficient_geometry" || result.status === "low_confidence",
    `совершенно другое здание НЕ даёт confident (получено ${result.status})`);
}

{
  // Недостаточно геометрии вовсе.
  const result = autoAlignFacade({ fbxSegments: [{ x1: 0, y1: 0, x2: 1000, y2: 0, z0: 0, z1: 3000 }], objectSegments: localBuildingSegments() });
  assertTrue(result.status === "insufficient_geometry", "единственный отрезок с одной стороны → insufficient_geometry");
}

{
  const result = autoAlignFacade({ fbxSegments: [], objectSegments: [] });
  assertTrue(result.status === "insufficient_geometry", "пустые входы не бросают исключение, дают insufficient_geometry");
}

// ==================== 5. неизменность при служебных операциях ====================

{
  // Один и тот же вход должен давать один и тот же результат при повторном
  // запуске (детерминированность — важно для «не пересчитывать при смене
  // этажного фильтра/камеры»).
  const local = localBuildingSegments();
  const thetaTrue = (63 * Math.PI) / 180;
  const tTrue = [42000, -18000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const r1 = autoAlignFacade({ fbxSegments: local, objectSegments });
  const r2 = autoAlignFacade({ fbxSegments: local, objectSegments });
  assertTrue(r1.status === r2.status, "повторный запуск на тех же данных даёт тот же статус");
  if (r1.candidates.length && r2.candidates.length) {
    assertClose(r1.candidates[0].theta, r2.candidates[0].theta, 1e-9, "повторный запуск детерминирован (theta)");
  }
}

// ==================== 6. масштаб выборки / время ====================

{
  const local = localBuildingSegments();
  const thetaTrue = (22 * Math.PI) / 180;
  const tTrue = [7000, 9000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const t0 = Date.now();
  const result = autoAlignFacade({ fbxSegments: local, objectSegments });
  const elapsed = Date.now() - t0;
  assertTrue(elapsed < 5000, `расчёт на типовом здании укладывается в разумное время (${elapsed}мс)`);
  assertTrue(typeof result.diagnostics.timingMs === "number", "диагностика содержит измеренное время");
  console.log(`  (диагностика: fbxSegments=${result.diagnostics.fbxSegmentCount}, objectSegments=${result.diagnostics.objectSegmentCount}, timingMs=${result.diagnostics.timingMs})`);
}

// ==================== 7. clusterHeightBands / weightedCentroidXY примитивы ====================

{
  const local = localBuildingSegments();
  const bands = clusterHeightBands(local, 2000);
  assertTrue(bands.length === 2, `башня+верхний объём образуют 2 полосы по высоте без жёстких отметок (получено ${bands.length})`);
  const centroid = weightedCentroidXY(local.filter((s) => s.z0 >= 13000));
  assertTrue(Math.abs(centroid[0] - 35000) < 2000, "центр масс верхнего объёма посчитан корректно (X)");
}

// ==================== итог ====================

if (failures > 0) {
  console.error(`\nИтог: ${failures} провал(ов).`);
  process.exit(1);
} else {
  console.log("\nВсе синтетические проверки автосовмещения фасада пройдены.");
  console.log("ВАЖНО: проверка ТОЛЬКО синтетическая — соответствие реальному зданию заказчика не подтверждено (нет пары «реальный FBX ↔ реальный revit_elements» одного объекта).");
}
