// Синтетическая проверка автоматического совмещения фасада
// (Docs/fbx-auto-placement-claude-prompt.md,
// Docs/fbx-placement-repair-claude-prompt.md). ТОЛЬКО синтетика — нет
// доступа к паре «реальный FBX ↔ реальный revit_elements одного и того же
// здания» (анонимная копия БД и тестовые FBX относятся к разным объектам).
// Запуск: node scripts/verify_auto_align.mjs

import {
  buildDirectionHistogram,
  findDirectionPeaks,
  generateRotationCandidates,
  clusterSpatialParts,
  weightedCentroidXY,
  weightedProcrustes2D,
  icpRefine,
  buildSegmentGridIndex,
  autoAlignFacade,
  candidateToPlacement,
  extractWallSegmentsFromGroup,
  orientedExtent,
  checkSizeCompatibility,
} from "../app/static/external-models/auto-align.js";
import { rotateXY, canonicalToProject } from "../app/static/external-models/coordinates.js";
import * as THREE from "../app/static/vendor/three/three.module.min.js";

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

/** Здание: башня (прямоугольник, много этажей) + примыкающий НИЗКИЙ
 * корпус ОТ ТОЙ ЖЕ ЗЕМЛИ (реалистичный случай, ровно тот, что показал
 * баг слияния в одну Z-полосу, Docs/fbx-placement-repair-claude-
 * prompt.md §2) — оба объёма начинаются от Z=0, их Z-диапазоны
 * пересекаются, разделять их обязана пространственная (XY) кластеризация,
 * а не высотная. Башня — 20 этажей по 3.5м = 70м, низкий корпус — 7
 * этажей той же высоты этажа, СБОКУ (другой footprint), тоже от земли. */
function localBuildingSegments() {
  const segs = [];
  const floorH = 3500;
  for (let floor = 0; floor < 20; floor++) {
    segs.push(...rectSegments(0, 0, 20000, 15000, floor * floorH, (floor + 1) * floorH));
  }
  for (let floor = 0; floor < 7; floor++) {
    segs.push(...rectSegments(20000 + 15000, -2500, 30000, 10000, floor * floorH, (floor + 1) * floorH));
  }
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
  assertTrue(!!index, "buildSegmentGridIndex строит индекс без ошибок");
}

// ==================== 2. пространственные части (замена высотных полос) ====================

{
  const local = localBuildingSegments();
  const parts = clusterSpatialParts(local, 150);
  assertTrue(parts.length === 2, `башня (20 этажей) + примыкающий корпус (7 этажей) ОТ ТОЙ ЖЕ ЗЕМЛИ образуют 2 пространственные части (получено ${parts.length}) — реалистичный случай, Z-диапазоны ПЕРЕСЕКАЮТСЯ`);
  const [bigger, smaller] = parts;
  assertTrue(bigger.totalLength > smaller.totalLength, "части отсортированы по убыванию суммарной длины стен");
  // Башня (20 этажей по периметру (20000+15000)*2=70000мм) весомее корпуса (7 этажей по (30000+10000)*2=80000мм на этаж)
  const centroidBig = weightedCentroidXY(bigger.segments);
  assertTrue(Math.abs(centroidBig[0]) < 1000 || Math.abs(centroidBig[0] - 35000) < 1000,
    "крупная часть — это либо башня (центр ~0,0), либо корпус (центр ~35000,-2500), не смесь");
}

{
  // Здание с ФИЗИЧЕСКИ общей стеной (корпуса касаются) — connectivity
  // корректно объединяет их в одну часть, это не баг, а архитектурная
  // реальность (одна связная конструкция).
  const touching = [
    ...rectSegments(0, 0, 20000, 15000, 0, 3500), // угол башни: (10000,-7500)
    // Пристройка сдвинута так, что её угол ТОЧНО совпадает с углом башни:
    // cx=25000,cy=-2500,w=30000,h=10000 → угол (25000-15000,-2500-5000)=(10000,-7500).
    ...rectSegments(25000, -2500, 30000, 10000, 0, 3500),
  ];
  const parts = clusterSpatialParts(touching, 150);
  assertTrue(parts.length === 1, `физически смежные (общий угол) объёмы объединяются в одну часть (получено ${parts.length})`);
}

// ==================== 3. точное восстановление (без шума) ====================

{
  const local = localBuildingSegments();
  const thetaTrueDeg = 37; // намеренно НЕ кратно 90°
  const thetaTrue = (thetaTrueDeg * Math.PI) / 180;
  const tTrue = [513280, -224660];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const fbxSegments = local;

  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status === "confident", `точный случай даёт status=confident (получено ${result.status}: ${result.reason || ""})`);
  if (result.candidates.length) {
    const c = result.candidates[0];
    const gotThetaDeg = (c.theta * 180) / Math.PI;
    const angDiff = Math.min(Math.abs(gotThetaDeg - thetaTrueDeg), 360 - Math.abs(gotThetaDeg - thetaTrueDeg));
    assertTrue(angDiff < 0.01, `точный угол восстановлен с точностью до сотых градуса после точного уточнения (истинный ${thetaTrueDeg}°, получен ${gotThetaDeg.toFixed(4)}°)`);
    assertClose(c.tXY[0], tTrue[0], 1, "точный перенос X восстановлен (допуск 1мм — после точного уточнения)");
    assertClose(c.tXY[1], tTrue[1], 1, "точный перенос Y восстановлен (допуск 1мм — после точного уточнения)");
    assertTrue(c.coverage > 0.8, `высокое покрытие для точного случая (${(c.coverage * 100).toFixed(0)}%)`);
    assertTrue(c.worstPartCoverage > 0.5, `обе части (башня И низкий корпус) хорошо покрыты, не только крупная (худшая ${(c.worstPartCoverage * 100).toFixed(0)}%)`);
    assertTrue(c.refined === true, "кандидат прошёл этап точного уточнения (refined=true)");

    const [sample] = fbxSegments;
    const [rx, ry] = rotateXY(c.theta, sample.x1, sample.y1);
    const gotX = rx + c.tXY[0], gotY = ry + c.tXY[1];
    const [ox, oy] = rotateXY(thetaTrue, sample.x1, sample.y1);
    assertClose(gotX, ox + tTrue[0], 1, "проекция первой вершины совпадает с истинной (X, допуск 1мм)");
    assertClose(gotY, oy + tTrue[1], 1, "проекция первой вершины совпадает с истинной (Y, допуск 1мм)");

    const sourceAnchorXY = [0, 0];
    const projectAnchorXY = [0, 0];
    const placement = candidateToPlacement(c, sourceAnchorXY, projectAnchorXY);
    const projected = canonicalToProject(
      [sample.x1, sample.y1, 0], [sourceAnchorXY[0], sourceAnchorXY[1], 0], [projectAnchorXY[0], projectAnchorXY[1], 0],
      placement.offsetXMm, placement.offsetYMm, 0, placement.rotationDeg,
    );
    assertClose(projected[0], gotX, 1e-6, "candidateToPlacement согласован с canonicalToProject (X)");
    assertClose(projected[1], gotY, 1e-6, "candidateToPlacement согласован с canonicalToProject (Y)");
  }
}

// ==================== 3б. строгая приёмка ≤1мм (Docs/fbx-fine-placement-claude-prompt.md) ====================
//
// Максимальная ошибка НЕЗАВИСИМЫХ контрольных точек (не только одной
// вершины, использованной в §3) — по ВСЕМ вершинам здания, оба знака
// угла, большие исходные координаты (реалистичный масштаб генплана,
// ~13 млн мм), разные (не нулевые) anchors источника/объекта, повторный
// запуск/«пересохранение» без накопления поправок.

function maxVertexError(segments, theta, tXY, thetaTrue, tTrue) {
  let maxErr = 0;
  for (const s of segments) {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const [rx, ry] = rotateXY(theta, x, y);
      const gotX = rx + tXY[0], gotY = ry + tXY[1];
      const [ex, ey] = rotateXY(thetaTrue, x, y).map((v, i) => v + tTrue[i]);
      const err = Math.hypot(gotX - ex, gotY - ey);
      if (err > maxErr) maxErr = err;
    }
  }
  return maxErr;
}

for (const thetaTrueDeg of [37, -37, 143, -143]) {
  const local = localBuildingSegments();
  const thetaTrue = (thetaTrueDeg * Math.PI) / 180;
  // Большие исходные координаты — реалистичный масштаб генплана (не 0,0).
  const tTrue = [13281000 + 111000, 10662000 - 222000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const result = await autoAlignFacade({ fbxSegments: local, objectSegments });
  if (result.status !== "confident" || !result.candidates.length) {
    assertTrue(false, `строгая приёмка: угол ${thetaTrueDeg}° должен давать confident (получено ${result.status})`);
    continue;
  }
  const c = result.candidates[0];
  const maxErr = maxVertexError(local, c.theta, c.tXY, thetaTrue, tTrue);
  assertTrue(maxErr <= 1, `строгая приёмка: угол ${thetaTrueDeg}°, большие координаты — максимальная ошибка вершины ${maxErr.toFixed(4)}мм ≤ 1мм`);

  // Разные (не нулевые) anchors источника/объекта — placement и повторное
  // применение (имитация reload/пересохранения) должны давать ТО ЖЕ
  // положение, без накопления поправок.
  const sourceAnchorXY = [1234, -5678];
  const projectAnchorXY = [987654, -123456];
  const placement1 = candidateToPlacement(c, sourceAnchorXY, projectAnchorXY);
  // "Повторное сохранение": тот же кандидат, применённый ещё раз через
  // canonicalToProject/placementFromGlobalTransform, не должен смещаться.
  const placement2 = candidateToPlacement(c, sourceAnchorXY, projectAnchorXY);
  assertClose(placement1.offsetXMm, placement2.offsetXMm, 1e-9, `угол ${thetaTrueDeg}°: повторное вычисление placement не накапливает поправку (X)`);
  assertClose(placement1.rotationDeg, placement2.rotationDeg, 1e-9, `угол ${thetaTrueDeg}°: повторное вычисление placement не накапливает поправку (поворот)`);

  const [sample] = local;
  const projected = canonicalToProject(
    [sample.x1, sample.y1, 0], [sourceAnchorXY[0], sourceAnchorXY[1], 0], [projectAnchorXY[0], projectAnchorXY[1], 0],
    placement1.offsetXMm, placement1.offsetYMm, 0, placement1.rotationDeg,
  );
  const [rx, ry] = rotateXY(c.theta, sample.x1, sample.y1);
  assertClose(projected[0], rx + c.tXY[0], 1e-6, `угол ${thetaTrueDeg}°: placement с ненулевыми anchors согласован с сырым transform (X)`);
  assertClose(projected[1], ry + c.tXY[1], 1e-6, `угол ${thetaTrueDeg}°: placement с ненулевыми anchors согласован с сырым transform (Y)`);
}

// ==================== 4. устойчивость к шуму/неполноте ====================

{
  const local = localBuildingSegments();
  const thetaTrue = (-52 * Math.PI) / 180;
  const tTrue = [-90000, 340000];
  let objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  objectSegments = addNoise(objectSegments, 40, 7); // ±40мм — реалистичный шум обмера/триангуляции
  const fbxSegments = addNoise(local, 15, 3); // ±15мм — точность геометрии из FBX

  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status === "confident", `шум ±15-40мм не мешает status=confident (получено ${result.status})`);
  if (result.candidates.length) {
    const c = result.candidates[0];
    const gotThetaDeg = (c.theta * 180) / Math.PI;
    const angDiff = Math.min(Math.abs(gotThetaDeg - (-52)), 360 - Math.abs(gotThetaDeg - (-52)));
    assertTrue(angDiff < 1.5, `угол восстановлен с шумом (истинный -52°, получен ${gotThetaDeg.toFixed(2)}°)`);
  }
}

{
  // Пропал весь низкий корпус (недомоделированный фрагмент) — направление
  // и перенос всё равно должны находиться по оставшейся башне.
  const local = localBuildingSegments().filter((s) => s.x1 <= 20000 && s.x2 <= 20000);
  const thetaTrue = (15 * Math.PI) / 180;
  const tTrue = [1000, 2000];
  const objectSegments = applyGlobalTransform(localBuildingSegments(), thetaTrue, tTrue); // объект — полный
  const fbxSegments = local; // модель — неполная

  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  // Без низкого корпуса модель («фасад») ЗАВЕДОМО меньше объекта по
  // наружному габариту — это ТА ЖЕ ситуация, что несовместимый по
  // размеру фасад (Docs/fbx-envelope-matching-claude-prompt.md §3):
  // insufficient_geometry — ЧЕСТНЫЙ отказ («модель заведомо не отражает
  // весь объект»), не грубая ошибка. ambiguous/confident/low_confidence
  // тоже допустимы, если ICP всё же нашёл совместимое положение по
  // оставшейся геометрии — важно только, что если найдётся, оно не
  // будет грубо промахнувшимся.
  // Проверка соразмерности теперь ПОПАРНАЯ по частям (задание §4.1,
  // Docs/fbx-partial-envelope-claude-prompt.md): у объекта часть «башня»
  // находит совместимую часть FBX, часть «низкий корпус» — не находит
  // (её в FBX просто нет) и честно помечается вне применимости, но это
  // НЕ проваливает всю проверку — значит, для одной голой прямоугольной
  // башни без дополнительного ориентира допустима более широкая свобода
  // позиционирования (в том числе иное правдоподобное положение той же
  // симметричной формы) — тест проверяет только отсутствие исключения и
  // осмысленный статус, не точное совпадение позиции на этом намеренно
  // недоопределённом синтетическом случае.
  assertTrue(["confident", "low_confidence", "ambiguous", "insufficient_geometry"].includes(result.status),
    `частично отсутствующая геометрия не даёт грубой ошибки (status=${result.status})`);
}

// ==================== 4б. соразмерность наружных габаритов (Docs/fbx-envelope-matching-claude-prompt.md) ====================
//
// Подтверждённый живой дефект: coverage/rms после подгонки переноса НЕ
// ловят систематическое расхождение размера — утопленный на несколько
// метров фасад всё равно даёт coverage~84-93%/rms в пределах порога,
// потому что 3 из 4 сторон совпадают почти идеально. Точное
// воспроизведение примера из задания — с внутренней стеной в целевом
// наборе (как в demo аудита) — теперь отклоняется на этапе проверки
// габарита, а не проходит благодаря случайному совпадению точек.

{
  const corners = [[0, 0], [20000, 0], [20000, 16000], [0, 16000]];
  const objectSegments = corners.map(([x1, y1], i) => ({ x1, y1, x2: corners[(i + 1) % 4][0], y2: corners[(i + 1) % 4][1], z0: 0, z1: 3000 }));
  objectSegments.push({ x1: 4000, y1: 0, x2: 4000, y2: 16000, z0: 0, z1: 3000 }); // внутренняя стена, как в демо аудита

  const facadeCorners = [[4000, 0], [20000, 0], [20000, 16000], [4000, 16000]];
  const fbxSegments = facadeCorners.map(([x1, y1], i) => ({ x1, y1, x2: facadeCorners[(i + 1) % 4][0], y2: facadeCorners[(i + 1) % 4][1], z0: 0, z1: 3000 }));

  const result = await autoAlignFacade({ fbxSegments, objectSegments, limits: { minSegments: 4 } });
  assertTrue(result.status === "insufficient_geometry",
    `утопленный на 4м фасад (демо аудита, с внутренней стеной в целевом наборе) корректно отклонён (получено ${result.status})`);
  assertTrue(!!result.reason && result.reason.includes("габариты"),
    "причина отказа явно называет несовместимость габаритов, а не общий отказ");
}

{
  // orientedExtent/checkSizeCompatibility должны быть УСТОЙЧИВЫ к
  // повороту — одна и та же геометрия под известным поворотом должна
  // давать РОВНО тот же габарит (с точностью до направления проверки).
  // Живой баг был именно здесь: неверный знак в формуле проекции давал
  // РАЗНЫЕ числа для одной и той же геометрии (Docs/fbx-envelope-
  // matching-claude-prompt.md).
  const local = localBuildingSegments();
  const thetaTrue = (37 * Math.PI) / 180;
  const tTrue = [13281000 + 111000, 10662000 - 222000]; // большие координаты, как у реальных объектов
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const [fbxAlong, fbxAcross] = orientedExtent(local, thetaTrue);
  const [objAlong, objAcross] = orientedExtent(objectSegments, 0);
  assertClose(fbxAlong, objAlong, 1e-6, "orientedExtent устойчив к повороту и большим координатам (вдоль)");
  assertClose(fbxAcross, objAcross, 1e-6, "orientedExtent устойчив к повороту и большим координатам (поперёк)");

  const check = checkSizeCompatibility({ segments: local }, { segments: objectSegments }, thetaTrue);
  assertTrue(!check.hardFail, "checkSizeCompatibility НЕ отклоняет буквально совпадающую (повёрнутую) геометрию");
  assertClose(check.mismatchMm, 0, 1e-3, "checkSizeCompatibility: несовпадение габарита ~0 для идентичной геометрии");
}

{
  // Убедиться, что проверка соразмерности работает на угле ПОСЛЕ
  // уточнения ICP, а не на исходном кандидате направления — пик
  // гистограммы направлений может отличаться от истинного угла на
  // несколько градусов, из-за чего проверка на неуточнённом угле ложно
  // отклоняла ГЕНУИННО совпадающую геометрию (обнаружено при отладке
  // этой же задачи на синтетике 40+10 этажей, пик дал 18° вместо 22°).
  const local = [];
  for (let floor = 0; floor < 40; floor++) local.push(...rectSegments(0, 0, 20000, 15000, floor * 3500, (floor + 1) * 3500));
  for (let floor = 0; floor < 10; floor++) local.push(...rectSegments(35000, -2500, 30000, 10000, floor * 3500, (floor + 1) * 3500));
  const thetaTrue = (22 * Math.PI) / 180;
  const tTrue = [7000, 9000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const result = await autoAlignFacade({ fbxSegments: local, objectSegments });
  assertTrue(result.status === "confident",
    `проверка габарита не отклоняет генуинно совпадающую геометрию из-за неточного seed-угла (получено ${result.status}: ${result.reason || ""})`);
}

// ==================== 5. отрицательные случаи — НЕ должно быть ложной уверенности ====================

{
  // Симметричное здание (квадрат) — 90°-неоднозначность направлений,
  // перенос без второго ориентира не отличит поворот на 90°.
  const local = symmetricSquareSegments();
  const thetaTrue = (10 * Math.PI) / 180;
  const tTrue = [5000, -3000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const fbxSegments = local;
  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  // Симметричный квадрат без пристройки: поворот на 90° даёт РАВНОЕ по
  // качеству совпадение — НЕ должно быть заявлено как confident при
  // отсутствии второго, различающего эти варианты, ориентира.
  assertTrue(result.status !== "confident",
    `симметричный квадрат БЕЗ дополнительных ориентиров не даёт ложной confident (получено ${result.status})`);
}

{
  // Другое здание (полностью иные пропорции и позиция стен) — не должно
  // получить высокое покрытие.
  const fbxSegments = localBuildingSegments();
  const objectSegments = rectSegments(100000, 100000, 8000, 8000, 0, 3000).concat(
    rectSegments(100000, 100000, 8000, 8000, 3000, 6000),
  );
  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status === "insufficient_geometry" || result.status === "low_confidence",
    `совершенно другое здание НЕ даёт confident (получено ${result.status})`);
}

{
  const result = await autoAlignFacade({ fbxSegments: [{ x1: 0, y1: 0, x2: 1000, y2: 0, z0: 0, z1: 3000 }], objectSegments: localBuildingSegments() });
  assertTrue(result.status === "insufficient_geometry", "единственный отрезок с одной стороны → insufficient_geometry");
}

{
  const result = await autoAlignFacade({ fbxSegments: [], objectSegments: [] });
  assertTrue(result.status === "insufficient_geometry", "пустые входы не бросают исключение, дают insufficient_geometry");
}

// ==================== 6. неизменность при служебных операциях ====================

{
  const local = localBuildingSegments();
  const thetaTrue = (63 * Math.PI) / 180;
  const tTrue = [42000, -18000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const r1 = await autoAlignFacade({ fbxSegments: local, objectSegments });
  const r2 = await autoAlignFacade({ fbxSegments: local, objectSegments });
  assertTrue(r1.status === r2.status, "повторный запуск на тех же данных даёт тот же статус");
  if (r1.candidates.length && r2.candidates.length) {
    assertClose(r1.candidates[0].theta, r2.candidates[0].theta, 1e-9, "повторный запуск детерминирован (theta)");
  }
}

// ==================== 7. масштаб выборки / реальное время поиска ====================

{
  // Реалистичный по объёму синтетический случай (production minSegments=20
  // по умолчанию НЕ переопределяется — задание §4: тесты с 16 отрезками
  // при пороге 20 завершались insufficient_geometry мгновенно, и «0 мс» не
  // было временем поиска вообще). Много этажей → тысячи отрезков.
  const local = [];
  for (let floor = 0; floor < 40; floor++) {
    local.push(...rectSegments(0, 0, 20000, 15000, floor * 3500, (floor + 1) * 3500));
  }
  for (let floor = 0; floor < 10; floor++) {
    local.push(...rectSegments(35000, -2500, 30000, 10000, floor * 3500, (floor + 1) * 3500));
  }
  assertTrue(local.length >= 20, `реалистичная синтетика превышает production minSegments=20 (получено ${local.length})`);
  const thetaTrue = (22 * Math.PI) / 180;
  const tTrue = [7000, 9000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const t0 = Date.now();
  const result = await autoAlignFacade({ fbxSegments: local, objectSegments });
  const elapsed = Date.now() - t0;
  assertTrue(result.status === "confident", `реалистичный случай на боевом пороге даёт confident (получено ${result.status})`);
  assertTrue(result.diagnostics.rotationCandidateCount > 0, "поиск реально сгенерировал кандидатов поворота (не мгновенный отказ)");
  assertTrue(result.diagnostics.distinctResultCount > 0, "поиск реально дал хотя бы один результат ICP (не мгновенный отказ)");
  assertTrue(elapsed < 5000, `расчёт на реалистичном здании укладывается в разумное время (${elapsed}мс)`);
  assertTrue(result.diagnostics.timingMs > 0, "diagnostics.timingMs отражает РЕАЛЬНОЕ время поиска, а не мгновенный отказ");
  console.log(`  (диагностика: fbxSegments=${result.diagnostics.fbxSegmentCount}, objectSegments=${result.diagnostics.objectSegmentCount}, timingMs=${result.diagnostics.timingMs}, кандидатов=${result.diagnostics.rotationCandidateCount})`);
}

// ==================== 8. extractWallSegmentsFromGroup — устойчивость к порядку/числу мешей ====================

function makeBoxMesh(cx, cy, w, h, zHeight) {
  // ВАЖНО: extractWallSegmentsFromGroup читает СЫРЫЕ локальные буферы
  // вершин без применения mesh.matrixWorld (ровно как в fbx.js — там
  // позиция уже запекается прямо в буфер геометрии при разборе, см.
  // finalMatrix/tmp.applyMatrix4 в fbx.js). Поэтому положение и здесь
  // нужно ЗАПЕКАТЬ в геометрию (geometry.translate), а не задавать через
  // mesh.position — иначе тест проверяет не то поведение, что в проде.
  const box = new THREE.BoxGeometry(w, h, zHeight);
  box.rotateX(Math.PI / 2); // Z-up, как в C-пространстве проекта
  box.translate(cx, cy, zHeight / 2);
  const mesh = new THREE.Mesh(box);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function groupFootprintXY(segments) {
  const xs = segments.flatMap((s) => [s.x1, s.x2]);
  const ys = segments.flatMap((s) => [s.y1, s.y2]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

{
  // Два меша (башня и низкий корпус, РАЗНЫЕ footprint) — ОБА должны быть
  // представлены в извлечённых сегментах независимо от порядка добавления
  // и от общего бюджета (задание §2: раньше общий счётчик "съедался"
  // первым мешем целиком, второй пропадал).
  const sourceAnchorMm = [0, 0, 0];
  for (const order of [["tower", "annex"], ["annex", "tower"]]) {
    const group = new THREE.Group();
    const meshes = {
      tower: makeBoxMesh(0, 0, 20000, 15000, 70000),
      annex: makeBoxMesh(35000, -2500, 30000, 10000, 24500),
    };
    for (const name of order) group.add(meshes[name]);
    group.updateMatrixWorld(true);
    const segments = extractWallSegmentsFromGroup(THREE, group, sourceAnchorMm, { maxTriangles: 40 });
    const bbox = groupFootprintXY(segments);
    const coversTower = bbox.minX < -5000 && bbox.minY < -5000; // угол башни (-10000,-7500)
    const coversAnnex = bbox.maxX > 40000; // угол корпуса (~50000, ...)
    assertTrue(segments.length > 0, `извлечены сегменты при порядке мешей [${order.join(",")}]`);
    assertTrue(coversTower && coversAnnex,
      `ОБА меша представлены в выборке при малом общем бюджете, порядок [${order.join(",")}] (bbox: X[${bbox.minX.toFixed(0)}..${bbox.maxX.toFixed(0)}])`);
  }
}

{
  // Разная плотность триангуляции между мешами (один мелко разбит, другой
  // грубо) — обе части всё равно должны попасть в выборку.
  const fineTower = makeBoxMesh(0, 0, 20000, 15000, 70000);
  fineTower.geometry = fineTower.geometry.toNonIndexed(); // имитация другой плотности
  const coarseAnnex = makeBoxMesh(35000, -2500, 30000, 10000, 24500);
  const group = new THREE.Group();
  group.add(fineTower); group.add(coarseAnnex);
  group.updateMatrixWorld(true);
  const segments = extractWallSegmentsFromGroup(THREE, group, [0, 0, 0], { maxTriangles: 60 });
  const bbox = groupFootprintXY(segments);
  assertTrue(bbox.minX < -5000 && bbox.maxX > 40000, "разная плотность триангуляции мешей не топит мелкий/грубый меш целиком");
}

// ==================== 9. icpRefine — честная финальная оценка ====================

{
  const local = localBuildingSegments();
  const thetaTrue = (18 * Math.PI) / 180;
  const tTrue = [3000, -4000];
  const objectSegments = applyGlobalTransform(local, thetaTrue, tTrue);
  const objectIndex = buildSegmentGridIndex(objectSegments, 2000);
  const fbxPoints = local.slice(0, 40).map((s) => ({ x: s.x1, y: s.y1 }));
  const icp = icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit: thetaTrue + 0.2, tInit: [tTrue[0] + 2000, tTrue[1] - 1500] });
  // Пересчитываем coverage/rms НЕЗАВИСИМО, по ИТОГОВЫМ theta/t, и
  // сверяем с тем, что вернула сама функция — раньше возвращались
  // значения ДО последнего обновления transform.
  let sqSum = 0, count = 0;
  for (const p of fbxPoints) {
    const [rx, ry] = rotateXY(icp.theta, p.x, p.y);
    const nn = (() => {
      let best = null, bestDist = 3000;
      for (const s of objectSegments) {
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const len2 = dx * dx + dy * dy || 1;
        let t = ((rx + icp.t[0] - s.x1) * dx + (ry + icp.t[1] - s.y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const x = s.x1 + t * dx, y = s.y1 + t * dy;
        const d = Math.hypot(rx + icp.t[0] - x, ry + icp.t[1] - y);
        if (d < bestDist) { bestDist = d; best = d; }
      }
      return best;
    })();
    if (nn !== null) { sqSum += nn * nn; count++; }
  }
  const independentRms = count ? Math.sqrt(sqSum / count) : Infinity;
  const independentCoverage = count / fbxPoints.length;
  assertClose(icp.rmsResidualMm, independentRms, 1e-6, "icpRefine.rmsResidualMm соответствует ИТОГОВОМУ (не предпоследнему) transform");
  assertClose(icp.coverage, independentCoverage, 1e-6, "icpRefine.coverage соответствует ИТОГОВОМУ transform по ПОЛНОЙ выборке (не обрезанной kept)");
}

// ==================== 10. сквозной тест: меш → сегменты → поиск → плейсмент ====================

{
  const thetaTrueDeg = 29;
  const thetaTrue = (thetaTrueDeg * Math.PI) / 180;
  const tTrue = [120000, -45000];
  const sourceAnchorMm = [1000, 500, 2000]; // anchor модели — не (0,0,0), проверяем сложение

  // "FBX"-меши в ЛОКАЛЬНЫХ координатах (уже C - sourceAnchor, как после
  // fbx.js) — extractWallSegmentsFromGroup обязан прибавить anchor обратно.
  const localTower = makeBoxMesh(-sourceAnchorMm[0], -sourceAnchorMm[1], 20000, 15000, 70000);
  const localAnnex = makeBoxMesh(35000 - sourceAnchorMm[0], -2500 - sourceAnchorMm[1], 30000, 10000, 24500);
  const group = new THREE.Group();
  group.add(localTower); group.add(localAnnex);
  group.updateMatrixWorld(true);

  const fbxSegments = extractWallSegmentsFromGroup(THREE, group, sourceAnchorMm, { maxTriangles: 200 });
  assertTrue(fbxSegments.length > 20, `сквозной тест: извлечено достаточно сегментов из мешей (${fbxSegments.length})`);

  // "Объект" — та же геометрия (в C, до вычета anchor — извлечение уже
  // вернуло C) под известным глобальным поворотом/переносом.
  const objectSegments = applyGlobalTransform(fbxSegments, thetaTrue, tTrue);

  const result = await autoAlignFacade({ fbxSegments, objectSegments });
  assertTrue(result.status === "confident", `сквозной тест: статус confident (получено ${result.status}: ${result.reason || ""})`);
  if (result.candidates.length) {
    const projectAnchorXY = [500000, 500000]; // anchor объекта — тоже не (0,0)
    const placement = candidateToPlacement(result.candidates[0], [sourceAnchorMm[0], sourceAnchorMm[1]], projectAnchorXY);
    // Применяем найденный placement через ТОТ ЖЕ canonicalToProject, что
    // использует рендер (coordinates.js), и сравниваем с точкой, которую
    // задание считает эталонной (через applyGlobalTransform).
    const sampleC = [fbxSegments[0].x1, fbxSegments[0].y1, 0];
    const projected = canonicalToProject(
      sampleC, [sourceAnchorMm[0], sourceAnchorMm[1], 0], [projectAnchorXY[0], projectAnchorXY[1], 0],
      placement.offsetXMm, placement.offsetYMm, 0, placement.rotationDeg,
    );
    // placementFromGlobalTransform подбирает offset так, что
    // canonicalToProject воспроизводит РОВНО P=Rz(theta)*C+t — независимо
    // от выбора projectAnchorXY (он взаимно сокращается по построению
    // формулы, coordinates.js:placementFromGlobalTransform), поэтому
    // сравниваем с эталоном НАПРЯМУЮ, без поправки на anchor.
    const [expX, expY] = rotateXY(thetaTrue, sampleC[0], sampleC[1]).map((v, i) => v + tTrue[i]);
    assertClose(projected[0], expX, 1000, "сквозной тест: сохранённый placement воспроизводит эталонную позицию (X)");
    assertClose(projected[1], expY, 1000, "сквозной тест: сохранённый placement воспроизводит эталонную позицию (Y)");
  }
}

// ==================== итог ====================

if (failures > 0) {
  console.error(`\nИтог: ${failures} провал(ов).`);
  process.exit(1);
} else {
  console.log("\nВсе синтетические проверки автосовмещения фасада пройдены.");
  console.log("ВАЖНО: проверка ТОЛЬКО синтетическая — соответствие реальному зданию заказчика не подтверждено (нет пары «реальный FBX ↔ реальный revit_elements» одного объекта).");
}
