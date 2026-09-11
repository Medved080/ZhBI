// Автоматическое совмещение фасада (Docs/fbx-auto-placement-claude-
// prompt.md, исправления — Docs/fbx-placement-repair-claude-prompt.md) —
// чистая геометрия, без THREE/DOM (тестируется напрямую, см.
// scripts/verify_auto_align.mjs), кроме `extractWallSegmentsFromGroup`
// (нужен THREE.Vector3, передаётся аргументом).
//
// Сегмент — {x1,y1,x2,y2,z0,z1} в мм, СВОЁ пространство координат у
// каждой стороны: у объекта — абсолютные P (app/object_geometry_features.py,
// категория «Стены»), у FBX — канонические C (fbx.js, до вычитания
// source_anchor — см. extractWallSegmentsFromGroup ниже, добавляет anchor
// обратно к запечённым локальным вершинам). Абсолютные значения Z у
// объекта и у FBX — РАЗНЫЕ системы координат (P vs C), сравнивать их
// напрямую нельзя; высота используется только ВНУТРИ одной стороны — для
// разделения объёмов (`clusterSpatialParts`), не для сопоставления по
// абсолютной отметке.
//
// Метод — направления → несколько кандидатов переноса (по каждой крупной
// пространственной части здания + по общему центру масс) → ICP-уточнение
// каждого → дедупликация по полному положению → оценка → решение. Три
// параметра в плане (угол, X, Y); масштаб фиксирован, отражение запрещено;
// Z НЕ трогается автоматикой (offset_z_mm в результат не входит вовсе).

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
 * физический угол давал бы 2-3 кандидата подряд из соседних корзин (живая
 * проверка на реальном здании 2026-09-11: плато шириной 10-16° давало два
 * пика вместо одного). */
export function findDirectionPeaks(hist, binDeg = 2, opts = {}) {
  const smoothRadius = opts.smoothRadius ?? 2;
  const minRelWeight = opts.minRelWeight ?? 0.08;
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

// ==================== пространственные части ====================

/** Простейшая структура union-find по индексам отрезков. */
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Разбивает отрезки на пространственные части — связные компоненты по
 * СОВПАДАЮЩИМ/БЛИЗКИМ КОНЦАМ в плане (XY), Z игнорируется полностью.
 * Заменяет прежний `clusterHeightBands` (Docs/fbx-placement-repair-
 * claude-prompt.md §2): группировка по пересечению Z-интервалов
 * транзитивно схлопывала БАШНЮ И ПРИМЫКАЮЩИЙ НИЗКИЙ КОРПУС в одну полосу,
 * если оба стоят от земли (Z-диапазоны пересекаются у самого основания) —
 * подтверждено на синтетике (20 этажей + 7 этажей от земли → 1 полоса) и
 * на реальных объектах анонимной копии (fbxBandCount=objectBandCount=1).
 *
 * Связность по концам в ПЛАНЕ, без Z, устойчива к этой ошибке: у здания с
 * одинаковым в плане прямоугольным контуром на каждом этаже все этажи
 * делят ОДНИ И ТЕ ЖЕ угловые точки (X,Y) — они естественно объединяются в
 * одну часть («башня» целиком, все этажи), а пристройка с ДРУГИМ контуром
 * в плане (другие X,Y) образует отдельную часть — ЕСЛИ она не имеет общей
 * стены с башней; если имеет (реально пристроена) — объединение в одну
 * часть корректно отражает физическую связность.
 *
 * `xyGapMm` — допуск связности. Проверка — расстояние КОНЦА одного
 * отрезка до БЛИЖАЙШЕЙ ТОЧКИ ДРУГОГО ОТРЕЗКА (не только его концов) —
 * иначе Т-образные примыкания (конец одной стены упирается в СЕРЕДИНУ
 * другой — обычное дело в реальных данных Revit, откуда пришёл первый,
 * слишком строгий вариант «только конец-к-концу»: на реальной геометрии
 * анонимной копии он раздробил здание на 200+ частей вместо 2-3 и
 * алгоритм считался 38 секунд — Docs/fbx-placement-repair-claude-prompt.md
 * §2, живая проверка 2026-09-11) остались бы несвязаны. Индекс на базе
 * `buildSegmentGridIndex`/`nearestOnIndexedSegments` — без полного
 * перебора пар.
 */
export function clusterSpatialParts(segments, xyGapMm = 800) {
  if (!segments.length) return [];
  const uf = new UnionFind(segments.length);
  const index = buildSegmentGridIndex(segments, Math.max(xyGapMm, 200));
  segments.forEach((s, i) => {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const j = nearestSegmentIndexExcluding(x, y, segments, index, xyGapMm, i);
      if (j >= 0) uf.union(i, j);
    }
  });

  const groups = new Map();
  segments.forEach((s, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  });
  const parts = [...groups.values()].map((segs) => {
    let zMin = Infinity, zMax = -Infinity, totalLength = 0;
    for (const s of segs) {
      zMin = Math.min(zMin, s.z0, s.z1);
      zMax = Math.max(zMax, s.z0, s.z1);
      totalLength += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    }
    return { segments: segs, totalLength, zMin, zMax };
  });
  parts.sort((a, b) => b.totalLength - a.totalLength);
  return parts;
}

/**
 * Часть отрезков реальной геометрии (T-стыки, проёмы, авторские мелкие
 * дробления) неизбежно распадается на МНОЖЕСТВО крошечных фрагментов
 * даже после исправления связности выше — использовать их ВСЕ как
 * отдельные части для перебора стартов/оценки (`perPartScores`,
 * `initialTranslationSeeds`) дорого (O(число частей)) и малополезно: не
 * несут собственного веса в решении. Оставляет крупные, действительно
 * значимые части — по абсолютной длине стен и по доле от общей длины,
 * с жёстким потолком числа частей (защита от медленного расчёта на
 * плотной реальной геометрии). Используется ТОЛЬКО для сидинга/оценки —
 * `samplePartsToPoints`, вызываемый на ПОЛНОМ списке частей отдельно,
 * по-прежнему пользуется всей геометрией (мелкие фрагменты продолжают
 * участвовать в общем ICP-соответствии, просто не как отдельная «часть»).
 */
export function significantParts(parts, opts = {}) {
  const maxParts = opts.maxParts ?? 8;
  const minAbsoluteMm = opts.minAbsoluteMm ?? 3000;
  const minRelative = opts.minRelative ?? 0.02;
  const totalLength = parts.reduce((s, p) => s + p.totalLength, 0) || 1;
  return parts
    .filter((p) => p.totalLength >= minAbsoluteMm && p.totalLength / totalLength >= minRelative)
    .slice(0, maxParts);
}

function nearestSegmentIndexExcluding(px, py, segments, index, maxDist, excludeIdx) {
  const { grid, cellSize, key } = index;
  const cx = Math.floor(px / cellSize), cy = Math.floor(py / cellSize);
  let bestIdx = -1;
  let bestDist = maxDist;
  const ringMax = Math.ceil(maxDist / cellSize) + 1;
  const seen = new Set();
  let foundAtRing = -1;
  for (let ring = 0; ring <= ringMax; ring++) {
    if (foundAtRing >= 0 && ring > foundAtRing + 1) break;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const idxs = grid.get(key(cx + dx, cy + dy));
        if (!idxs) continue;
        for (const i of idxs) {
          if (i === excludeIdx || seen.has(i)) continue;
          seen.add(i);
          const seg = segments[i];
          const r = pointToSegmentDistance(px, py, seg.x1, seg.y1, seg.x2, seg.y2);
          if (r.distance < bestDist) { bestDist = r.distance; bestIdx = i; }
        }
      }
    }
    if (bestIdx >= 0 && foundAtRing < 0) foundAtRing = ring;
  }
  return bestIdx;
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

/** Начальные переносы-кандидаты для поворота theta — ОДИН по самой
 * крупной пространственной части каждой стороны (обычно самая надёжная,
 * не значит «верхняя» — Z у сторон в разных системах координат и для
 * выбора «главной части» не используется), и ОДИН по общему центру масс
 * всех отрезков (запасной вариант, если разбиение на части не совпадает
 * по значимости между сторонами). ICP ниже уточнит любой достаточно
 * близкий старт — задание §2: «локальная оптимизация из единственного
 * положения не заменяет поиск исходного разворота», поэтому пробуем
 * несколько независимых стартов, а не один. */
export function initialTranslationSeeds(theta, fbxParts, fbxSegments, objectParts, objectSegments) {
  const seeds = [];
  if (fbxParts.length && objectParts.length) {
    const [fx, fy] = weightedCentroidXY(fbxParts[0].segments);
    const [rx, ry] = rotateXY(theta, fx, fy);
    const [ox, oy] = weightedCentroidXY(objectParts[0].segments);
    seeds.push([ox - rx, oy - ry]);
  }
  const [fx, fy] = weightedCentroidXY(fbxSegments);
  const [rx, ry] = rotateXY(theta, fx, fy);
  const [ox, oy] = weightedCentroidXY(objectSegments);
  const globalSeed = [ox - rx, oy - ry];
  if (!seeds.length || Math.hypot(seeds[0][0] - globalSeed[0], seeds[0][1] - globalSeed[1]) > 1) {
    seeds.push(globalSeed);
  }
  return seeds;
}

// ==================== выборка точек и ближайший поиск ====================

/** Равномерная выборка точек ВДОЛЬ отрезков — не все вершины (задание:
 * разная плотность триангуляции/внутренние стены исказили бы результат).
 * Точки распределяются МЕЖДУ частями ПОРОВНУ (до maxPerPart на часть), а
 * не пропорционально их длине — иначе крупная часть забьёт выборку и
 * мелкая перестанет на что-либо влиять (задание: «хорошее совпадение...
 * не должно скрывать промах по низкой части»). */
export function samplePartsToPoints(parts, maxPerPart = 300, stepMm = 300) {
  const points = [];
  for (const part of parts) {
    const partPoints = [];
    for (const s of part.segments) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 1e-6) continue;
      const steps = Math.max(1, Math.round(len / stepMm));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        partPoints.push({ x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t, part });
      }
    }
    if (partPoints.length <= maxPerPart) {
      points.push(...partPoints);
    } else {
      const stride = partPoints.length / maxPerPart;
      for (let i = 0; i < maxPerPart; i++) points.push(partPoints[Math.floor(i * stride)]);
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
 * перекрытию). Каждая итерация решает ГЛОБАЛЬНО оптимальный поворот+
 * перенос для ТЕКУЩИХ соответствий (weightedProcrustes2D). После цикла —
 * ОТДЕЛЬНАЯ финальная оценка coverage/rms по ПОЛНОМУ набору точек и
 * ПОСЛЕДНЕМУ обновлённому transform (исправление: раньше coverage/rms
 * относились к соответствиям, найденным ДО последнего обновления
 * theta/t — по сути к предыдущему, а не итоговому положению; и считались
 * только по `kept` — обрезанному набору, что завышало coverage. Docs/
 * fbx-placement-repair-claude-prompt.md §2).
 */
export function icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit, tInit, opts = {} }) {
  const maxIters = opts.maxIters ?? 12;
  const maxDist = opts.maxDist ?? 3000;
  const trimFrac = opts.trimFrac ?? 0.2;
  const convergeTol = opts.convergeTol ?? 1e-4;
  let theta = thetaInit;
  let t = [tInit[0], tInit[1]];
  let prevKeptRms = Infinity;

  function evaluate(th, tt) {
    let sqSum = 0, count = 0;
    const matches = [];
    for (const p of fbxPoints) {
      const [rx, ry] = rotateXY(th, p.x, p.y);
      const nn = nearestOnIndexedSegments(rx + tt[0], ry + tt[1], objectSegments, objectIndex, maxDist);
      if (nn) {
        matches.push({ ax: p.x, ay: p.y, bx: nn.x, by: nn.y, dist: nn.distance, part: p.part });
        sqSum += nn.distance * nn.distance;
        count++;
      }
    }
    return {
      matches,
      coverage: fbxPoints.length > 0 ? count / fbxPoints.length : 0,
      rmsResidualMm: count > 0 ? Math.sqrt(sqSum / count) : Infinity,
      inlierCount: count,
    };
  }

  let converged = false;
  for (let iter = 0; iter < maxIters; iter++) {
    const { matches } = evaluate(theta, t);
    if (matches.length < 3) break;
    matches.sort((a, b) => a.dist - b.dist);
    const keepCount = Math.max(3, Math.ceil(matches.length * (1 - trimFrac)));
    const kept = matches.slice(0, keepCount);
    const solved = weightedProcrustes2D(kept.map((m) => ({ ax: m.ax, ay: m.ay, bx: m.bx, by: m.by, w: 1 })));
    if (!solved) break;
    theta = solved.theta; t = [solved.tx, solved.ty];
    const keptRms = Math.sqrt(kept.reduce((s, m) => s + m.dist * m.dist, 0) / kept.length);
    if (Math.abs(keptRms - prevKeptRms) < convergeTol) { converged = true; prevKeptRms = keptRms; break; }
    prevKeptRms = keptRms;
  }

  const final = evaluate(theta, t);
  return { theta, t, converged, coverage: final.coverage, rmsResidualMm: final.rmsResidualMm, inlierCount: final.inlierCount };
}

// ==================== оценка кандидата и решение ====================

/** Оценка ОТДЕЛЬНО по каждой пространственной части — задание прямо
 * требует не давать хорошему совпадению крупной части маскировать промах
 * по мелкой. Использует ПОЛНУЮ (не обрезанную) выборку части. */
function perPartScores(theta, t, fbxParts, objectSegments, objectIndex, maxDist) {
  return fbxParts.map((part) => {
    const points = samplePartsToPoints([part], 200, 300);
    let matched = 0, sqSum = 0;
    for (const p of points) {
      const [rx, ry] = rotateXY(theta, p.x, p.y);
      const nn = nearestOnIndexedSegments(rx + t[0], ry + t[1], objectSegments, objectIndex, maxDist);
      if (nn) { matched++; sqSum += nn.distance * nn.distance; }
    }
    return {
      zMin: part.zMin, zMax: part.zMax,
      coverage: points.length ? matched / points.length : 0,
      rmsResidualMm: matched ? Math.sqrt(sqSum / matched) : null,
      pointCount: points.length,
    };
  });
}

/** Два результата считаются ОДНИМ И ТЕМ ЖЕ финальным положением, если
 * угол и перенос оба близки — раньше кандидаты схлопывались только по
 * углу, без проверки сдвига (задание §2), из-за чего два независимых
 * старта, случайно сошедшихся к одному и тому же правильному ответу,
 * ложно засчитывались как «два разных хороших варианта» → ambiguous. */
function sameTransform(a, b, angleTolDeg = 3, transTolMm = 500) {
  const angleDeg = (theta) => (theta * 180) / Math.PI;
  return angularDist360(angleDeg(a.theta), angleDeg(b.theta)) < angleTolDeg
    && Math.hypot(a.t[0] - b.t[0], a.t[1] - b.t[1]) < transTolMm;
}

/**
 * Полный поиск: направления → кандидаты поворота → НЕСКОЛЬКО начальных
 * переносов на кандидат (по крупнейшей части + по общему центру масс) →
 * ICP-уточнение каждого → дедупликация результатов по ПОЛНОМУ положению
 * (угол И перенос) → оценка по каждой части отдельно → решение.
 *
 * Возвращает { status, candidates, diagnostics }, НИКОГДА не бросает —
 * при недостатке данных status='insufficient_geometry' с объяснением.
 * Масштаб не меняется (Rz — чистый поворот), отражение невозможно
 * (Procrustes без отражения). Z не участвует и не возвращается.
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
  const fbxPartsAll = clusterSpatialParts(fbxSegments, limits.xyGapMm ?? 800);
  const objectPartsAll = clusterSpatialParts(objectSegments, limits.xyGapMm ?? 800);
  // Значимые части — для сидинга/поэлементной оценки (дорого, O(число
  // частей)); реальная геометрия (T-стыки, проёмы) даёт МНОГО мелких
  // фрагментов даже после исправления связности — использовать их все как
  // отдельные части неоправданно дорого и не несёт веса в решении. Полный
  // список (fbxPartsAll/objectPartsAll) используется только для подсчёта
  // диагностики и как источник ОБЩЕЙ выборки точек ниже — сама геометрия
  // мелких частей продолжает участвовать в ICP-соответствии.
  const fbxParts = significantParts(fbxPartsAll, { maxParts: limits.maxParts ?? 8 });
  const objectParts = significantParts(objectPartsAll, { maxParts: limits.maxParts ?? 8 });
  // Точки для ICP — тоже только из ЗНАЧИМЫХ частей, не из полного списка:
  // реальная геометрия (T-стыки, проёмы) даёт сотни мелких фрагментов
  // (живая проверка на объекте анонимной копии — 179 частей), и если
  // сэмплировать каждую до maxPerPart, общий пул точек взрывается на
  // порядки (17775 вместо ожидаемых ~1000-2000) — ICP на каждой из
  // 8×2=16 стартовых точек проходит по нему до 12 раз, оценка кандидата
  // растягивается на десятки секунд. Значимые части уже содержат
  // подавляющую часть суммарной длины стен — мелкие фрагменты не меняют
  // качество соответствия ощутимо.
  const fbxPoints = samplePartsToPoints(fbxParts, limits.maxPointsPerPart ?? 250, limits.sampleStepMm ?? 300);
  const objectIndex = buildSegmentGridIndex(objectSegments, limits.gridCellMm ?? 2000);
  const maxDist = limits.icpMaxDistMm ?? 3000;

  const rawResults = [];
  for (const rc of rotationCandidates) {
    const seeds = initialTranslationSeeds(rc.theta, fbxParts, fbxSegments, objectParts, objectSegments);
    for (const tInit of seeds) {
      const icp = icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit: rc.theta, tInit, opts: {
        maxIters: limits.icpMaxIters ?? 12, maxDist, trimFrac: limits.icpTrimFrac ?? 0.2,
      } });
      const perPart = perPartScores(icp.theta, icp.t, fbxParts, objectSegments, objectIndex, maxDist);
      const worstPartCoverage = perPart.length ? Math.min(...perPart.map((b) => b.coverage)) : 0;
      rawResults.push({ theta: icp.theta, t: icp.t, coverage: icp.coverage, rmsResidualMm: icp.rmsResidualMm, worstPartCoverage, perPart });
    }
  }

  // Дедупликация по ПОЛНОМУ положению (угол и перенос) — независимые
  // старты, сошедшиеся к одному и тому же ответу, не должны считаться
  // «двумя разными кандидатами» при оценке неоднозначности.
  const results = [];
  for (const r of rawResults) {
    const existing = results.find((e) => sameTransform(e, r));
    if (!existing) { results.push(r); continue; }
    if (r.coverage > existing.coverage || (r.coverage === existing.coverage && r.rmsResidualMm < existing.rmsResidualMm)) {
      Object.assign(existing, r);
    }
  }
  results.sort((a, b) => (b.coverage - a.coverage) || (a.rmsResidualMm - b.rmsResidualMm));

  const timingMs = Math.round(((typeof performance !== "undefined" ? performance : Date).now()) - t0);
  const diagnostics = {
    timingMs, fbxSegmentCount: fbxSegments.length, objectSegmentCount: objectSegments.length,
    fbxPeaks, objPeaks, rotationCandidateCount: rotationCandidates.length,
    fbxPartCount: fbxParts.length, objectPartCount: objectParts.length,
    fbxPartCountTotal: fbxPartsAll.length, objectPartCountTotal: objectPartsAll.length,
    fbxSampleCount: fbxPoints.length,
    distinctResultCount: results.length,
  };

  if (!results.length) {
    return { status: "insufficient_geometry", candidates: [], reason: "Не нашлось ни одного пригодного кандидата переноса.", diagnostics };
  }

  const toCandidateOut = (r) => ({
    theta: r.theta, tXY: r.t,
    coverage: r.coverage, rmsResidualMm: r.rmsResidualMm, worstPartCoverage: r.worstPartCoverage, perPart: r.perPart,
  });

  // Пороги — явные, проверены на синтетике (scripts/verify_auto_align.mjs)
  // и живым запросом против реальной геометрии стен объектов анонимной
  // копии (Docs/fbx-placement-repair-claude-prompt.md §2).
  const COVERAGE_CONFIDENT = limits.coverageConfident ?? 0.55;
  const COVERAGE_PER_PART_MIN = limits.coveragePerPartMin ?? 0.35;
  const RMS_CONFIDENT_MM = limits.rmsConfidentMm ?? 800;
  const AMBIGUITY_GAP = limits.ambiguityGap ?? 0.15;

  const passesQuality = (r) => r.coverage >= COVERAGE_CONFIDENT
    && r.worstPartCoverage >= COVERAGE_PER_PART_MIN
    && r.rmsResidualMm <= RMS_CONFIDENT_MM;

  const best = results[0];
  const others = results.slice(1);
  const bestGood = passesQuality(best);
  // Неоднозначность — сравнение ЛУЧШЕГО со ВСЕМИ остальными различными
  // (уже дедуплицированными) решениями, не только со вторым по списку
  // (задание §2: «сравниваются только первые два, хотя третье и дальнейшие
  // решения могут быть существенно другими»).
  const rival = others.find((r) => passesQuality(r) || (best.coverage - r.coverage) < AMBIGUITY_GAP);
  const unambiguous = !rival;

  if (bestGood && unambiguous) {
    return { status: "confident", candidates: [toCandidateOut(best)], reason: null, diagnostics };
  }
  if (bestGood && !unambiguous) {
    const candidateList = [best, rival, ...others.filter((r) => r !== rival)].slice(0, limits.maxAmbiguousCandidates ?? 3);
    return {
      status: "ambiguous",
      candidates: candidateList.map(toCandidateOut),
      reason: `Найдено несколько существенно разных положений с похожим качеством (лучшее покрытие ${(best.coverage * 100).toFixed(0)}%, `
        + `альтернатива ${(rival.coverage * 100).toFixed(0)}%) — нужно подтверждение человеком.`,
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
      + `невязка ${best.rmsResidualMm.toFixed(0)} мм, худшая часть ${(best.worstPartCoverage * 100).toFixed(0)}%) — `
      + `сохранено как приблизительное, нужна проверка/ручная калибровка.`,
    diagnostics,
  };
}

/** Готовое {rotationDeg, offsetXMm, offsetYMm} для СОХРАНЕНИЯ по одному
 * кандидату результата и anchors модели/объекта. */
export function candidateToPlacement(candidate, sourceAnchorXY, projectAnchorXY) {
  return placementFromGlobalTransform(candidate.theta, candidate.tXY, sourceAnchorXY, projectAnchorXY);
}

// ==================== извлечение стеновых поверхностей из FBX (THREE.js) ====================

/**
 * Извлекает «стеновые» (преимущественно вертикальные) треугольники из уже
 * РАЗОБРАННОЙ группы `loadExternalModelFbx` (fbx.js) — геометрия там
 * запечена как C - sourceAnchor, поэтому sourceAnchorMm прибавляется
 * обратно, чтобы получить именно C. Наклон отбирается по НОРМАЛИ грани
 * (|normal.z| мал ⇒ грань смотрит вбок, не вверх/вниз).
 *
 * Бюджет треугольников распределяется ПРОПОРЦИОНАЛЬНО между ВСЕМИ
 * подходящими мешами ЗАРАНЕЕ, а не тратится общим счётчиком на первый
 * подвернувшийся меш (исправление: раньше `triangleBudget` был общим на
 * весь `group.traverse`, и как только он обнулялся внутри первого меша,
 * КАЖДЫЙ следующий меш пропускался целиком — `if (triangleBudget<=0)
 * return`. Подтверждено: 2 меша по 2 вертикальных треугольника при
 * бюджете 2 → второй меш не представлен вовсе. Docs/fbx-placement-repair-
 * claude-prompt.md §2). Каждый меш получает минимум 1 треугольник бюджета
 * — иначе маленькая, но значимая часть (например, пристройка отдельным
 * мешем) пропадает целиком при большом числе мешей.
 */
export function extractWallSegmentsFromGroup(THREE, group, sourceAnchorMm, opts = {}) {
  const maxTriangles = opts.maxTriangles ?? 20000;
  const normalZMax = opts.normalZMax ?? 0.35;
  const segments = [];

  const meshInfos = [];
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    const pos = obj.geometry?.attributes?.position;
    if (!pos) return;
    const index = obj.geometry.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    if (triCount > 0) meshInfos.push({ mesh: obj, triCount });
  });
  const totalTriCount = meshInfos.reduce((s, m) => s + m.triCount, 0);
  if (totalTriCount === 0) return segments;

  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

  for (const { mesh, triCount } of meshInfos) {
    const meshBudget = Math.max(1, Math.round((maxTriangles * triCount) / totalTriCount));
    const stride = Math.max(1, Math.floor(triCount / meshBudget));
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;
    for (let tri = 0; tri < triCount; tri += stride) {
      const i0 = index ? index.getX(tri * 3) : tri * 3;
      const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
      const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
      va.fromBufferAttribute(pos, i0); vb.fromBufferAttribute(pos, i1); vc.fromBufferAttribute(pos, i2);
      ab.subVectors(vb, va); ac.subVectors(vc, va);
      normal.crossVectors(ab, ac).normalize();
      if (Math.abs(normal.z) > normalZMax) continue; // не вертикальная грань (пол/потолок/скат) — не стена
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
  }
  return segments;
}
