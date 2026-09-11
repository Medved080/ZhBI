// Автоматическое совмещение фасада (Docs/fbx-auto-placement-claude-
// prompt.md) — чистая геометрия, без THREE/DOM (тестируется напрямую, см.
// scripts/verify_auto_align.mjs), кроме `extractWallSegmentsFromGroup`
// (нужен THREE.Vector3, передаётся аргументом).
//
// Сегмент — {x1,y1,x2,y2,z0,z1} в мм, СВОЁ пространство координат у
// каждой стороны: у объекта — абсолютные P (app/object_geometry_features.py,
// категория «Стены»), у FBX — канонические C (fbx.js, до вычитания
// source_anchor — см. extractWallSegmentsFromGroup ниже, добавляет anchor
// обратно к запечённым локальным вершинам).
//
// Метод — направления → перенос по крупным частям (срезы по высоте) →
// уточнение ICP из нескольких кандидатов, см. §«Алгоритм» задания.
// Три параметра в плане (угол, X, Y); масштаб фиксирован, отражение
// запрещено; Z НЕ трогается автоматикой (см. итоговую orchestrator-
// функцию — offset_z_mm в результат не входит вовсе).

import { rotateXY, placementFromGlobalTransform } from "./coordinates.js";

// ==================== направления ====================

/** Гистограмма направлений (мод 180° — линии неориентированы), взвешенная
 * длиной отрезка. binDeg — ширина корзины в градусах. */
export function buildDirectionHistogram(segments, binDeg = 2) {
  const nBins = Math.round(180 / binDeg);
  const hist = new Array(nBins).fill(0);
  for (const s of segments) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    angle = ((angle % 180) + 180) % 180;
    const bin = Math.min(nBins - 1, Math.floor(angle / binDeg));
    hist[bin] += len;
  }
  return hist;
}

function angularDist180(a, b) {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}
function angularDist360(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** Локальные максимумы сглаженной гистограммы (круговой сдвиг по мод
 * nBins) выше относительного порога — кандидаты «главных направлений
 * стен». Близкие пики (< mergeDeg) схлопываются в сильнейший — иначе один
 * физический угол давал бы 2-3 кандидата подряд из соседних корзин. */
export function findDirectionPeaks(hist, binDeg = 2, opts = {}) {
  const smoothRadius = opts.smoothRadius ?? 2;
  const minRelWeight = opts.minRelWeight ?? 0.08;
  // На реальных данных (не идеальном синтетическом прямоугольнике) одна и
  // та же стена нередко даёт плоский "плато"-максимум гистограммы шириной
  // 10-16° (см. живую проверку на объекте_id=4, 2026-09-11: пики 45°/53° —
  // одна и та же стена, а не два разных направления) — слишком узкий порог
  // слияния плодит для неё несколько кандидатов поворота вместо одного и
  // создаёт ЛОЖНУЮ неоднозначность там, где её нет. Настоящие независимые
  // направления стен обычно разнесены гораздо шире (>20°).
  const mergeDeg = opts.mergeDeg ?? 15;
  const maxPeaks = opts.maxPeaks ?? 4;
  const n = hist.length;
  const smoothed = hist.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let d = -smoothRadius; d <= smoothRadius; d++) { sum += hist[(i + d + n) % n]; cnt++; }
    return sum / cnt;
  });
  const total = smoothed.reduce((a, b) => a + b, 0) || 1;
  const raw = [];
  for (let i = 0; i < n; i++) {
    const v = smoothed[i];
    if (v >= smoothed[(i - 1 + n) % n] && v >= smoothed[(i + 1) % n] && v / total >= minRelWeight) {
      raw.push({ angleDeg: i * binDeg + binDeg / 2, weight: v });
    }
  }
  raw.sort((a, b) => b.weight - a.weight);
  const merged = [];
  for (const p of raw) {
    if (merged.some((m) => angularDist180(m.angleDeg, p.angleDeg) < mergeDeg)) continue;
    merged.push(p);
    if (merged.length >= maxPeaks) break;
  }
  return merged;
}

/** Кандидаты поворота (в градусах, конвенция rotation_deg проекта) из
 * всех пар пиков «направление FBX ↔ направление объекта» — оба варианта
 * (delta и delta+180°), т.к. направление линии неориентировано и не
 * определяет знак поворота само по себе; перенос/ICP ниже отсеют
 * неверный (см. задание, «не ограничивайся ... 90/180°»). */
export function generateRotationCandidates(fbxPeaks, objectPeaks, maxCandidates = 8) {
  const candidates = [];
  for (const fp of fbxPeaks) {
    for (const op of objectPeaks) {
      let delta = (op.angleDeg - fp.angleDeg) % 180;
      if (delta < 0) delta += 180;
      for (const extra of [0, 180]) {
        const thetaDeg = ((delta + extra + 180) % 360) - 180;
        if (candidates.some((c) => angularDist360(c.thetaDeg, thetaDeg) < 3)) continue;
        candidates.push({ thetaDeg, theta: (thetaDeg * Math.PI) / 180, weight: fp.weight * op.weight });
      }
    }
  }
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, maxCandidates);
}

// ==================== срезы по высоте ====================

/** Группирует отрезки в полосы по высоте — интервалы (z0,z1) объединяются,
 * если пересекаются или расстояние между ними меньше gapMm (структура
 * данных задаёт границы, не фиксированные отметки этого здания — задание
 * §«перенос»). Возвращает полосы, отсортированные по СУММАРНОЙ длине стен
 * (крупные части — надёжнее для направления/переноса) и отдельно поле
 * zMax — по нему можно выбрать «верхнюю» полосу как источник самого
 * надёжного, ничем не перекрытого признака (верх башни). */
export function clusterHeightBands(segments, gapMm = 2000) {
  if (!segments.length) return [];
  const withRange = segments.map((s) => ({ ...s, zMin: Math.min(s.z0, s.z1), zMax: Math.max(s.z0, s.z1) }));
  withRange.sort((a, b) => a.zMin - b.zMin);
  const bands = [];
  let cur = { zMin: withRange[0].zMin, zMax: withRange[0].zMax, segments: [withRange[0]] };
  for (let i = 1; i < withRange.length; i++) {
    const s = withRange[i];
    if (s.zMin <= cur.zMax + gapMm) {
      cur.segments.push(s);
      cur.zMax = Math.max(cur.zMax, s.zMax);
    } else {
      bands.push(cur);
      cur = { zMin: s.zMin, zMax: s.zMax, segments: [s] };
    }
  }
  bands.push(cur);
  for (const b of bands) {
    b.totalLength = b.segments.reduce((s, e) => s + Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 0);
  }
  return bands;
}

/** Взвешенный (длиной отрезка) центр масс середин отрезков в плане. */
export function weightedCentroidXY(segments) {
  let sx = 0, sy = 0, sw = 0;
  for (const s of segments) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    sx += ((s.x1 + s.x2) / 2) * len;
    sy += ((s.y1 + s.y2) / 2) * len;
    sw += len;
  }
  return sw > 0 ? [sx / sw, sy / sw] : [0, 0];
}

/** Начальный перенос для кандидата поворота theta — по ЦЕНТРУ МАСС
 * "верхней" полосы каждой стороны (верх башни — часть, гарантированно не
 * смешанная с пристройкой, если та ниже, см. задание: «сочетание высокой
 * башни и низкой части — полезный признак»). Если полос всего одна с
 * каждой стороны, это просто общий центр масс. */
export function initialTranslationForRotation(theta, fbxBands, objectBands) {
  if (!fbxBands.length || !objectBands.length) return null;
  const fbxTop = fbxBands.reduce((a, b) => (b.zMax > a.zMax ? b : a));
  const objTop = objectBands.reduce((a, b) => (b.zMax > a.zMax ? b : a));
  const [fx, fy] = weightedCentroidXY(fbxTop.segments);
  const [rx, ry] = rotateXY(theta, fx, fy);
  const [ox, oy] = weightedCentroidXY(objTop.segments);
  return [ox - rx, oy - ry];
}

// ==================== выборка точек и ближайший поиск ====================

/** Равномерная выборка точек ВДОЛЬ отрезков — не все вершины (задание:
 * разная плотность триангуляции/внутренние стены исказили бы результат).
 * Точки распределяются МЕЖДУ полосами ПОРОВНУ (до maxPerBand на полосу),
 * а не пропорционально их длине — иначе крупная башня забьёт выборку и
 * низкая часть перестанет на что-либо влиять (задание: «хорошее
 * совпадение... башни не должно скрывать промах по низкой части»). */
export function sampleBandsToPoints(bands, maxPerBand = 300, stepMm = 300) {
  const points = [];
  for (const band of bands) {
    const bandPoints = [];
    for (const s of band.segments) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 1e-6) continue;
      const steps = Math.max(1, Math.round(len / stepMm));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        bandPoints.push({ x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t, band });
      }
    }
    if (bandPoints.length <= maxPerBand) {
      points.push(...bandPoints);
    } else {
      const stride = bandPoints.length / maxPerBand;
      for (let i = 0; i < maxPerBand; i++) points.push(bandPoints[Math.floor(i * stride)]);
    }
  }
  return points;
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = x1 + t * dx, y = y1 + t * dy;
  return { distance: Math.hypot(px - x, py - y), x, y };
}

/** Равномерная сетка-индекс отрезков по bbox — приближённый поиск
 * ближайшего БЕЗ полного перебора (задание: не считать все пары точек
 * "в лоб" — эффективно и на тысячах отрезков). */
export function buildSegmentGridIndex(segments, cellSize) {
  const grid = new Map();
  const key = (cx, cy) => cx + "," + cy;
  segments.forEach((s, i) => {
    const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2);
    const cx0 = Math.floor(minX / cellSize), cx1 = Math.floor(maxX / cellSize);
    const cy0 = Math.floor(minY / cellSize), cy1 = Math.floor(maxY / cellSize);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return { grid, cellSize, key };
}

export function nearestOnIndexedSegments(px, py, segments, index, maxDist) {
  const { grid, cellSize, key } = index;
  const cx = Math.floor(px / cellSize), cy = Math.floor(py / cellSize);
  let best = null;
  let bestDist = maxDist;
  const ringMax = Math.ceil(maxDist / cellSize) + 1;
  const seen = new Set();
  let foundAtRing = -1;
  for (let ring = 0; ring <= ringMax; ring++) {
    if (foundAtRing >= 0 && ring > foundAtRing + 1) break; // ещё одно кольцо про запас и стоп
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const idxs = grid.get(key(cx + dx, cy + dy));
        if (!idxs) continue;
        for (const i of idxs) {
          if (seen.has(i)) continue;
          seen.add(i);
          const seg = segments[i];
          const r = pointToSegmentDistance(px, py, seg.x1, seg.y1, seg.x2, seg.y2);
          if (r.distance < bestDist) { bestDist = r.distance; best = { distance: r.distance, x: r.x, y: r.y }; }
        }
      }
    }
    if (best && foundAtRing < 0) foundAtRing = ring;
  }
  return best;
}

// ==================== 2D Procrustes (поворот+перенос, без масштаба/отражения) ====================

/** Оптимальные (theta, t), минимизирующие sum w*(Rz(theta)*a + t - b)^2 —
 * замкнутая форма для 2D без отражения (частный случай Кабша/Хорна):
 * та же формула atan2(cross,dot), что в calibrateByPointPair, но по СУММЕ
 * центрированных пар, не по одной паре векторов — обобщение на N точек. */
export function weightedProcrustes2D(pairs) {
  let sax = 0, say = 0, sbx = 0, sby = 0, sw = 0;
  for (const p of pairs) {
    const w = p.w ?? 1;
    sax += p.ax * w; say += p.ay * w; sbx += p.bx * w; sby += p.by * w; sw += w;
  }
  if (sw <= 0) return null;
  const ax0 = sax / sw, ay0 = say / sw, bx0 = sbx / sw, by0 = sby / sw;
  let cross = 0, dot = 0;
  for (const p of pairs) {
    const w = p.w ?? 1;
    const axp = p.ax - ax0, ayp = p.ay - ay0;
    const bxp = p.bx - bx0, byp = p.by - by0;
    cross += w * (axp * byp - ayp * bxp);
    dot += w * (axp * bxp + ayp * byp);
  }
  const theta = Math.atan2(cross, dot);
  const [rx, ry] = rotateXY(theta, ax0, ay0);
  return { theta, tx: bx0 - rx, ty: by0 - ry };
}

// ==================== ICP-уточнение ====================

/**
 * Уточняет (theta,t) итерационным ближайшим соответствием точка→отрезок,
 * с отсечением худших по невязке пар (устойчивость к выбросам/неполному
 * перекрытию, задание §«Уточнение»). Каждая итерация решает ГЛОБАЛЬНО
 * оптимальный (theta,t) для ТЕКУЩИХ соответствий (weightedProcrustes2D по
 * исходным fbx-точкам и их текущим ближайшим объект-точкам) — не
 * накопление малых поправок, а честная переоценка на каждом шаге.
 */
export function icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit, tInit, opts = {} }) {
  const maxIters = opts.maxIters ?? 12;
  const maxDist = opts.maxDist ?? 3000;
  const trimFrac = opts.trimFrac ?? 0.2;
  const convergeTol = opts.convergeTol ?? 1e-4;
  let theta = thetaInit;
  let t = [tInit[0], tInit[1]];
  let lastRms = Infinity;
  let lastPairsCount = 0;
  for (let iter = 0; iter < maxIters; iter++) {
    const matches = [];
    for (const p of fbxPoints) {
      const [rx, ry] = rotateXY(theta, p.x, p.y);
      const tx = rx + t[0], ty = ry + t[1];
      const nn = nearestOnIndexedSegments(tx, ty, objectSegments, objectIndex, maxDist);
      if (nn) matches.push({ ax: p.x, ay: p.y, bx: nn.x, by: nn.y, dist: nn.distance, band: p.band });
    }
    if (matches.length < 3) return { theta, t, converged: false, coverage: 0, rmsResidualMm: Infinity, inlierCount: 0 };
    matches.sort((a, b) => a.dist - b.dist);
    const keepCount = Math.max(3, Math.ceil(matches.length * (1 - trimFrac)));
    const kept = matches.slice(0, keepCount);
    const solved = weightedProcrustes2D(kept.map((m) => ({ ax: m.ax, ay: m.ay, bx: m.bx, by: m.by, w: 1 })));
    if (!solved) break;
    theta = solved.theta; t = [solved.tx, solved.ty];
    const rms = Math.sqrt(kept.reduce((s, m) => s + m.dist * m.dist, 0) / kept.length);
    lastPairsCount = matches.length;
    if (Math.abs(rms - lastRms) < convergeTol) { lastRms = rms; break; }
    lastRms = rms;
  }
  return {
    theta, t, converged: true,
    coverage: fbxPoints.length > 0 ? lastPairsCount / fbxPoints.length : 0,
    rmsResidualMm: lastRms,
    inlierCount: lastPairsCount,
  };
}

// ==================== оценка кандидата и решение ====================

/** Оценка ОТДЕЛЬНО по каждой полосе (этаж/срез) — задание прямо требует
 * не давать хорошему совпадению плотной башни маскировать промах по
 * низкой части. */
function perBandScores(theta, t, fbxBands, objectSegments, objectIndex, maxDist) {
  return fbxBands.map((band) => {
    const points = sampleBandsToPoints([band], 200, 300);
    let matched = 0, sqSum = 0;
    for (const p of points) {
      const [rx, ry] = rotateXY(theta, p.x, p.y);
      const nn = nearestOnIndexedSegments(rx + t[0], ry + t[1], objectSegments, objectIndex, maxDist);
      if (nn) { matched++; sqSum += nn.distance * nn.distance; }
    }
    return {
      zMin: band.zMin, zMax: band.zMax,
      coverage: points.length ? matched / points.length : 0,
      rmsResidualMm: matched ? Math.sqrt(sqSum / matched) : null,
      pointCount: points.length,
    };
  });
}

/**
 * Полный поиск: направления → кандидаты поворота → начальный перенос по
 * верхней полосе → ICP-уточнение из КАЖДОГО кандидата (не только из
 * одного — задание: локальная оптимизация из единственного положения не
 * заменяет поиск исходного разворота) → оценка → решение.
 *
 * Возвращает { status, candidates, diagnostics }, НИКОГДА не бросает —
 * при недостатке данных status='insufficient_geometry' с объяснением.
 * Масштаб не меняется (Rz — чистый поворот), отражение невозможно
 * (Procrustes без отражения). Z не участвует и не возвращается — задание
 * требует доказанного вертикального соответствия отдельно, здесь его нет.
 */
export function autoAlignFacade({ fbxSegments, objectSegments, limits = {} }) {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const minSegments = limits.minSegments ?? 20;
  if (!fbxSegments || fbxSegments.length < minSegments || !objectSegments || objectSegments.length < minSegments) {
    return {
      status: "insufficient_geometry",
      candidates: [],
      reason: `Недостаточно геометрии для сопоставления (модель: ${fbxSegments?.length || 0} отрезков, `
        + `объект: ${objectSegments?.length || 0}, нужно не меньше ${minSegments} с каждой стороны).`,
      diagnostics: { timingMs: 0, fbxSegmentCount: fbxSegments?.length || 0, objectSegmentCount: objectSegments?.length || 0 },
    };
  }

  const binDeg = limits.binDeg ?? 2;
  const fbxHist = buildDirectionHistogram(fbxSegments, binDeg);
  const objHist = buildDirectionHistogram(objectSegments, binDeg);
  const fbxPeaks = findDirectionPeaks(fbxHist, binDeg);
  const objPeaks = findDirectionPeaks(objHist, binDeg);
  if (!fbxPeaks.length || !objPeaks.length) {
    return {
      status: "insufficient_geometry", candidates: [],
      reason: "Не удалось выделить устойчивые направления стен (геометрия слишком хаотична или это не прямоугольная сетка стен).",
      diagnostics: {
        timingMs: Math.round(((typeof performance !== "undefined" ? performance : Date).now()) - t0),
        fbxSegmentCount: fbxSegments.length, objectSegmentCount: objectSegments.length,
      },
    };
  }

  const rotationCandidates = generateRotationCandidates(fbxPeaks, objPeaks, limits.maxRotationCandidates ?? 8);
  const fbxBands = clusterHeightBands(fbxSegments, limits.bandGapMm ?? 2000);
  const objectBands = clusterHeightBands(objectSegments, limits.bandGapMm ?? 2000);
  const fbxPoints = sampleBandsToPoints(fbxBands, limits.maxPointsPerBand ?? 250, limits.sampleStepMm ?? 300);
  const objectIndex = buildSegmentGridIndex(objectSegments, limits.gridCellMm ?? 2000);
  const maxDist = limits.icpMaxDistMm ?? 3000;

  const results = [];
  for (const rc of rotationCandidates) {
    const tInit = initialTranslationForRotation(rc.theta, fbxBands, objectBands);
    if (!tInit) continue;
    const icp = icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit: rc.theta, tInit, opts: {
      maxIters: limits.icpMaxIters ?? 12, maxDist, trimFrac: limits.icpTrimFrac ?? 0.2,
    } });
    const perBand = perBandScores(icp.theta, icp.t, fbxBands, objectSegments, objectIndex, maxDist);
    const worstBandCoverage = perBand.length ? Math.min(...perBand.map((b) => b.coverage)) : 0;
    results.push({
      thetaDeg0: rc.thetaDeg, theta: icp.theta, t: icp.t,
      coverage: icp.coverage, rmsResidualMm: icp.rmsResidualMm, worstBandCoverage, perBand,
    });
  }
  results.sort((a, b) => (b.coverage - a.coverage) || (a.rmsResidualMm - b.rmsResidualMm));

  const timingMs = Math.round(((typeof performance !== "undefined" ? performance : Date).now()) - t0);
  const diagnostics = {
    timingMs, fbxSegmentCount: fbxSegments.length, objectSegmentCount: objectSegments.length,
    fbxPeaks, objPeaks, rotationCandidateCount: rotationCandidates.length,
    fbxBandCount: fbxBands.length, objectBandCount: objectBands.length, fbxSampleCount: fbxPoints.length,
  };

  if (!results.length) {
    return { status: "insufficient_geometry", candidates: [], reason: "Не нашлось ни одного пригодного кандидата переноса.", diagnostics };
  }

  const toCandidateOut = (r) => ({
    thetaDeg0: r.thetaDeg0, theta: r.theta, tXY: r.t,
    coverage: r.coverage, rmsResidualMm: r.rmsResidualMm, worstBandCoverage: r.worstBandCoverage, perBand: r.perBand,
  });

  const best = results[0];
  const second = results[1];

  // Пороги — явные, проверены на синтетике (scripts/verify_auto_align.mjs):
  // правильный кандидат на чистых синтетических данных даёт coverage
  // ~0.9+ и rms в единицы-десятки мм; неверный/симметричный случай —
  // coverage существенно ниже или отрыв от второго кандидата мал.
  const COVERAGE_CONFIDENT = limits.coverageConfident ?? 0.55;
  const COVERAGE_PER_BAND_MIN = limits.coveragePerBandMin ?? 0.35;
  const RMS_CONFIDENT_MM = limits.rmsConfidentMm ?? 800;
  const AMBIGUITY_GAP = limits.ambiguityGap ?? 0.15;

  const bestGood = best.coverage >= COVERAGE_CONFIDENT
    && best.worstBandCoverage >= COVERAGE_PER_BAND_MIN
    && best.rmsResidualMm <= RMS_CONFIDENT_MM;
  const gapToSecond = second ? best.coverage - second.coverage : 1;
  const unambiguous = !second || gapToSecond >= AMBIGUITY_GAP || angularDist360(
    (best.theta * 180) / Math.PI, (second.theta * 180) / Math.PI,
  ) < 5; // второй кандидат — по сути тот же угол (сошлись из разных пиков) — не считается неоднозначностью

  if (bestGood && unambiguous) {
    return { status: "confident", candidates: [toCandidateOut(best)], reason: null, diagnostics };
  }
  if (bestGood && !unambiguous) {
    return {
      status: "ambiguous",
      candidates: results.slice(0, limits.maxAmbiguousCandidates ?? 3).map(toCandidateOut),
      reason: `Найдено несколько существенно разных положений с похожим качеством (лучшее покрытие ${(best.coverage * 100).toFixed(0)}%, `
        + `следующее ${(second.coverage * 100).toFixed(0)}%) — нужно подтверждение человеком.`,
      diagnostics,
    };
  }
  if (best.coverage < (limits.coverageInsufficient ?? 0.2)) {
    return {
      status: "insufficient_geometry", candidates: [toCandidateOut(best)],
      reason: `Даже лучший кандидат покрывает только ${(best.coverage * 100).toFixed(0)}% выборки — геометрия объекта и фасада, `
        + `похоже, не совпадают (другое здание, другой масштаб, либо структурная модель слишком грубая).`,
      diagnostics,
    };
  }
  return {
    status: "low_confidence",
    candidates: [toCandidateOut(best)],
    reason: `Лучший найденный вариант не дотягивает до порога уверенности (покрытие ${(best.coverage * 100).toFixed(0)}%, `
      + `невязка ${best.rmsResidualMm.toFixed(0)} мм, худшая полоса ${(best.worstBandCoverage * 100).toFixed(0)}%) — `
      + `сохранено как приблизительное, нужна проверка/ручная калибровка.`,
    diagnostics,
  };
}

/** Готовое {rotationDeg, offsetXMm, offsetYMm} для СОХРАНЕНИЯ — берёт
 * ЛУЧШЕГО кандидата результата (candidates[0]) и anchors модели/объекта. */
export function candidateToPlacement(candidate, sourceAnchorXY, projectAnchorXY) {
  return placementFromGlobalTransform(candidate.theta, candidate.tXY, sourceAnchorXY, projectAnchorXY);
}

// ==================== извлечение стеновых поверхностей из FBX (THREE.js) ====================

/**
 * Извлекает «стеновые» (преимущественно вертикальные) треугольники из уже
 * РАЗОБРАННОЙ группы `loadExternalModelFbx` (fbx.js) — геометрия там
 * запечена как C - sourceAnchor (см. fbx.js), поэтому sourceAnchorMm
 * прибавляется обратно, чтобы получить именно C, как того требует задание
 * («до применения пользовательского положения»). Наклон отбирается по
 * НОРМАЛИ грани (|normal.z| мал ⇒ грань смотрит вбок, не вверх/вниз) — общий
 * признак, работающий без готовых категорий, которых у FBX-геометрии нет
 * (в отличие от revit_elements.category='Стены' на стороне объекта).
 * `maxTriangles` — предохранитель по объёму выборки (задание: ограничить
 * размер выборки и число итераций).
 */
export function extractWallSegmentsFromGroup(THREE, group, sourceAnchorMm, opts = {}) {
  const maxTriangles = opts.maxTriangles ?? 20000;
  const normalZMax = opts.normalZMax ?? 0.35;
  const segments = [];
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  let triangleBudget = maxTriangles;

  group.traverse((obj) => {
    if (!obj.isMesh || triangleBudget <= 0) return;
    const geom = obj.geometry;
    const pos = geom?.attributes?.position;
    if (!pos) return;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const stride = Math.max(1, Math.floor(triCount / Math.max(1, triangleBudget)));
    for (let tri = 0; tri < triCount && triangleBudget > 0; tri += stride) {
      const i0 = index ? index.getX(tri * 3) : tri * 3;
      const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
      va.fromBufferAttribute(pos, i0); vb.fromBufferAttribute(pos, i1); vc.fromBufferAttribute(pos, i2);
      ab.subVectors(vb, va); ac.subVectors(vc, va);
      normal.crossVectors(ab, ac).normalize();
      if (Math.abs(normal.z) > normalZMax) continue; // не вертикальная грань (пол/потолок/скат) — не стена
      triangleBudget--;
      const pts = [va, vb, vc];
      for (let e = 0; e < 3; e++) {
        const p1 = pts[e], p2 = pts[(e + 1) % 3];
        const x1 = p1.x + sourceAnchorMm[0], y1 = p1.y + sourceAnchorMm[1];
        const x2 = p2.x + sourceAnchorMm[0], y2 = p2.y + sourceAnchorMm[1];
        const z1 = p1.z + sourceAnchorMm[2], z2 = p2.z + sourceAnchorMm[2];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 30) continue; // короткие рёбра окон/декора — шум для направления/переноса
        segments.push({ x1, y1, x2, y2, z0: Math.min(z1, z2), z1: Math.max(z1, z2) });
      }
    }
  });
  return segments;
}
