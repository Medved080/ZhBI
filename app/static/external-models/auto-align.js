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

/** Уступка циклу событий между дорогими шагами поиска (не даёт разбору
 * подряд нескольких секунд занимать основной поток целиком — задание
 * §«обеспечить... отсутствие блокировки UI при длительном расчёте»).
 * Работает и в браузере, и в Node (тесты) — setTimeout(0) достаточно,
 * отдельного планировщика/воркера не заводим. НЕ отменяет уже начатый
 * расчёт (полноценная отмена не реализована — см. Docs/OPEN.md). */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  // ВСЕГДА обходим полный радиус ringMax, без «нашли — остановимся через
  // кольцо» — та эвристика зависела от того, в какую именно ЯЧЕЙКУ сетки
  // попадает точка, а это зависит от АБСОЛЮТНЫХ координат: у одной и той
  // же геометрии в системе координат объекта (P, абсолютные, часто
  // многомиллионные мм) и в системе координат FBX (C, у начала координат)
  // сетка выравнена по-разному относительно геометрии, и связность
  // (используется в clusterSpatialParts) реально получалась РАЗНОЙ для
  // буквально идентичной, только повёрнутой/перенесённой геометрии —
  // подтверждено живой проверкой на реальном объекте анонимной копии
  // (Docs/fbx-envelope-matching-claude-prompt.md, крупнейшая часть FBX
  // 12.88М мм против 15.25М мм у той же самой части со стороны объекта).
  // Полный обход ringMax — детерминированный, не зависит от выравнивания
  // сетки; для maxDist=800/cellSize=800 это всего 5×5 ячеек, дёшево.
  const ringMax = Math.ceil(maxDist / cellSize) + 1;
  const seen = new Set();
  for (let ring = 0; ring <= ringMax; ring++) {
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

/**
 * Габарит набора отрезков вдоль направления theta и перпендикуляра —
 * НЕ axis-aligned bbox (тот врёт для повёрнутого здания), а протяжённость
 * в СОБСТВЕННЫХ осях (задание §3: «измерь размеры наружных частей в их
 * собственных направлениях... общий axis-aligned bbox для такой проверки
 * непригоден»). Возвращает [ширина_вдоль_theta, ширина_поперёк].
 */
export function orientedExtent(segments, theta) {
  // Габарит МНОЖЕСТВА Rz(theta)*p — та же функция rotateXY, что и везде
  // в проекте (P = Rz(theta)*C + t), а не собственная формула проекции:
  // ручной вариант с той же матрицей поворота, что и до правки, давал
  // ПРОТИВОПОЛОЖНЫЙ знак (фактически считал экстент для Rz(-theta), не
  // Rz(theta)) — на реальном здании это ложно показывало огромное
  // несовпадение габаритов у буквально идентичной, только повёрнутой
  // геометрии (Docs/fbx-envelope-matching-claude-prompt.md, живая
  // проверка: fbxExtent=[53302,72101] против objExtent=[75150,35530] для
  // одной и той же геометрии под истинным углом).
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const s of segments) {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const [u, v] = rotateXY(theta, x, y);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  return [maxU - minU, maxV - minV];
}

/**
 * Сравнивает габариты САМОЙ КРУПНОЙ значимой части каждой стороны в
 * системе координат, куда её ставит кандидат поворота theta — если
 * несущий контур и фасад отличаются по размеру больше объяснимого
 * (толщина облицовки + погрешность обмера), это НЕ вопрос точности
 * переноса, а несовместимая геометрия: подгонка перевода/угла не может
 * это исправить (задание §3, живой пример: фасад уже объекта на 4м с
 * одной стороны — coverage/rms этого НЕ ловят, три стороны из четырёх
 * всё равно совпадают идеально). Возвращает {mismatchMm, hardFail}:
 * `hardFail` — несовпадение настолько велико, что положение вообще не
 * должно предлагаться (даже как «неоднозначное» — задание §4: «не
 * навязывай выбор одного из трёх [заведомо плохих]»).
 */
/**
 * Соразмерность наружных габаритов — ПОПАРНО между значимыми частями
 * (не агрегат-vs-агрегат, задание §4.1 — Docs/fbx-partial-envelope-
 * claude-prompt.md): каждая значимая часть ОБЪЕКТА должна найти хотя бы
 * одну часть FBX совместимого размера. Части FBX БЕЗ соответствия в
 * объекте (соседнее здание в кадре экспорта, благоустройство, элементы
 * кровли) — НЕ ошибка, а «вне применимости»: они просто не засчитываются
 * ни за, ни против. `hardFail` — только когда НИ ОДНА часть объекта не
 * нашла совместимую часть FBX (раньше — агрегат ВСЕХ отрезков против
 * агрегата ВСЕХ отрезков: одна лишняя деталь в FBX — соседнее здание,
 * дерево на кровле — проваливала проверку целиком, отклоняя ЛЮБОЙ
 * поворот, включая верный).
 *
 * Принимает как одиночную часть ({segments}), так и массив частей —
 * для обратной совместимости с прежним вызовом на одной паре.
 */
export function checkSizeCompatibility(fbxPartsInput, objectPartsInput, theta, opts = {}) {
  const fbxParts = Array.isArray(fbxPartsInput) ? fbxPartsInput : (fbxPartsInput ? [fbxPartsInput] : []);
  const objectParts = Array.isArray(objectPartsInput) ? objectPartsInput : (objectPartsInput ? [objectPartsInput] : []);
  if (!fbxParts.length || !objectParts.length) return { mismatchMm: 0, hardFail: false, matchedObjectPartCount: 0, totalObjectPartCount: objectParts.length };

  const toleranceAbsMm = opts.toleranceAbsMm ?? 600;
  const toleranceRel = opts.toleranceRel ?? 0.04;
  const fbxExtents = fbxParts.map((p) => orientedExtent(p.segments, theta));

  let matchedCount = 0;
  let bestMismatchMm = Infinity;
  const perObjectPart = [];
  for (const objPart of objectParts) {
    const [objAlong, objAcross] = orientedExtent(objPart.segments, 0);
    const tolAlong = Math.max(toleranceAbsMm, toleranceRel * objAlong);
    const tolAcross = Math.max(toleranceAbsMm, toleranceRel * objAcross);
    let matched = false;
    let localBestMismatch = Infinity;
    for (const [fbxAlong, fbxAcross] of fbxExtents) {
      const mismatch = Math.max(Math.abs(fbxAlong - objAlong), Math.abs(fbxAcross - objAcross));
      if (mismatch < localBestMismatch) localBestMismatch = mismatch;
      if (Math.abs(fbxAlong - objAlong) <= tolAlong && Math.abs(fbxAcross - objAcross) <= tolAcross) matched = true;
    }
    if (matched) {
      matchedCount++;
      if (localBestMismatch < bestMismatchMm) bestMismatchMm = localBestMismatch;
    }
    perObjectPart.push({ matched, mismatchMm: localBestMismatch, objectExtent: [objAlong, objAcross] });
  }
  const hardFail = matchedCount === 0;
  return {
    hardFail,
    mismatchMm: Number.isFinite(bestMismatchMm) ? bestMismatchMm : Math.min(...perObjectPart.map((p) => p.mismatchMm)),
    matchedObjectPartCount: matchedCount, totalObjectPartCount: objectParts.length, perObjectPart,
  };
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
  const add = (cx, cy, i) => {
    const k = key(cx, cy);
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    if (arr[arr.length - 1] !== i) arr.push(i); // соседние шаги вдоль отрезка часто попадают в ту же ячейку
  };
  segments.forEach((s, i) => {
    const minX = Math.min(s.x1, s.x2), maxX = Math.max(s.x1, s.x2);
    const minY = Math.min(s.y1, s.y2), maxY = Math.max(s.y1, s.y2);
    const cx0 = Math.floor(minX / cellSize), cx1 = Math.floor(maxX / cellSize);
    const cy0 = Math.floor(minY / cellSize), cy1 = Math.floor(maxY / cellSize);
    const cellCount = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    // Заливка ВСЕГО bbox — дёшево для типичной (почти горизонтальной или
    // почти вертикальной) стены, но КВАДРАТИЧНА по длине для диагонального
    // отрезка при мелкой ячейке (bbox почти квадратный) — на реальных
    // стенах с непрямоугольными участками это оказалось узким местом на
    // мелких ступенях точного уточнения (живая проверка на объектах 3/4
    // анонимной копии, 2026-09-12: построение индекса заняло секунды).
    // При большом bbox — вставляем ТОЛЬКО ячейки, которые отрезок реально
    // пересекает (шаг вдоль отрезка), а не весь его прямоугольник.
    if (cellCount <= 400) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) add(cx, cy, i);
      }
    } else {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy) || 1;
      const steps = Math.max(1, Math.ceil(len / (cellSize * 0.5)));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const x = s.x1 + dx * t, y = s.y1 + dy * t;
        add(Math.floor(x / cellSize), Math.floor(y / cellSize), i);
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
  // ЗДЕСЬ (в отличие от nearestSegmentIndexExcluding, где полный обход
  // критичен для устойчивости clusterSpatialParts к перестановке
  // координат — см. её комментарий) допустимо приближённое «нашли — ещё
  // кольцо про запас и стоп»: это горячий цикл ICP (вызывается на каждую
  // точку каждой итерации), где чуть неоптимальное соответствие не влияет
  // на сходимость, а полный обход всех колец на плотных реальных данных
  // (тысячи стен) давал ×5-7 замедление — 14с вместо ~2с на реальном
  // объекте (Docs/fbx-partial-envelope-claude-prompt.md, живая проверка).
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

function nowMs() {
  return (typeof performance !== "undefined" ? performance : Date).now();
}

/**
 * Уточняет (theta,t) итерационным ближайшим соответствием точка→отрезок,
 * с отсечением худших по невязке пар (устойчивость к выбросам/неполному
 * перекрытию). Каждая итерация решает ГЛОБАЛЬНО оптимальный поворот+
 * перенос для ТЕКУЩИХ соответствий (weightedProcrustes2D). После цикла —
 * ОТДЕЛЬНАЯ финальная оценка coverage/rms по ПОЛНОМУ набору точек и
 * ПОСЛЕДНЕМУ обновлённому transform (не по `kept` — обрезанному набору
 * ДО обновления, что раньше занижало точность и завышало coverage).
 *
 * Сходимость проверяется ПО СМЕЩЕНИЮ САМИХ ТОЧЕК ЗДАНИЯ (полная
 * трансформация применена к fbxPoints до/после шага), а не по «сырому»
 * изменению theta/t — при больших абсолютных C-координатах даже
 * небольшое изменение угла даёт большой компенсирующий сдвиг t почти
 * при неподвижном самом здании; сравнение t напрямую ложно считало бы
 * это «не сошлось». Возвращает `iterations`/`stopReason` — исчерпание
 * лимита итераций НЕ считается сходимостью (`stopReason:'maxIters'` ≠
 * `converged:true`). Docs/fbx-fine-placement-claude-prompt.md §1-2.
 */
/**
 * Оценка coverage/rms/matches для ДАННОГО transform на ДАННОМ радиусе
 * поиска соответствий — общая функция для icpRefine (внутренний цикл) и
 * для ПОВТОРНОЙ, СРАВНИМОЙ оценки уже уточнённых кандидатов на исходном
 * (грубом) радиусе, которым оценивались остальные (Docs/fbx-fine-
 * placement-claude-prompt.md): coverage/rms на УЗКОМ финальном радиусе
 * точного уточнения (сотни мм) НЕЛЬЗЯ напрямую сравнивать с coverage/rms
 * на широком радиусе грубого поиска (3000мм) — при прочих равных узкий
 * радиус всегда даёт МЕНЬШИЙ coverage просто по своей природе, даже если
 * итоговое положение куда точнее. Раньше это приводило к тому, что более
 * точный (после уточнения) кандидат проигрывал менее точному просто
 * из-за разных по смыслу чисел — подтверждено живой проверкой на
 * реальном объекте анонимной копии.
 */
export function evaluateTransform(fbxPoints, objectSegments, objectIndex, theta, t, maxDist) {
  let sqSum = 0, count = 0;
  const matches = [];
  for (const p of fbxPoints) {
    const [rx, ry] = rotateXY(theta, p.x, p.y);
    const nn = nearestOnIndexedSegments(rx + t[0], ry + t[1], objectSegments, objectIndex, maxDist);
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

export function icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit, tInit, opts = {} }) {
  const maxIters = opts.maxIters ?? 12;
  const maxDist = opts.maxDist ?? 3000;
  const trimFrac = opts.trimFrac ?? 0.2;
  const convergeTolMm = opts.convergeTolMm ?? 0.05;
  const maxTimeMs = opts.maxTimeMs ?? Infinity;
  const t0 = nowMs();
  let theta = thetaInit;
  let t = [tInit[0], tInit[1]];

  function evaluate(th, tt) {
    return evaluateTransform(fbxPoints, objectSegments, objectIndex, th, tt, maxDist);
  }

  function pointPositions(th, tt) {
    return fbxPoints.map((p) => {
      const [rx, ry] = rotateXY(th, p.x, p.y);
      return [rx + tt[0], ry + tt[1]];
    });
  }

  let prevPositions = null;
  let iterations = 0;
  let stopReason = "maxIters";
  for (; iterations < maxIters; iterations++) {
    if (nowMs() - t0 > maxTimeMs) { stopReason = "timeBudget"; break; }
    const { matches } = evaluate(theta, t);
    if (matches.length < 3) { stopReason = "tooFewMatches"; break; }
    matches.sort((a, b) => a.dist - b.dist);
    const keepCount = Math.max(3, Math.ceil(matches.length * (1 - trimFrac)));
    const kept = matches.slice(0, keepCount);
    const solved = weightedProcrustes2D(kept.map((m) => ({ ax: m.ax, ay: m.ay, bx: m.bx, by: m.by, w: 1 })));
    if (!solved) { stopReason = "degenerate"; break; }
    theta = solved.theta; t = [solved.tx, solved.ty];
    const curPositions = pointPositions(theta, t);
    if (prevPositions) {
      let maxShift = 0;
      for (let i = 0; i < curPositions.length; i++) {
        const d = Math.hypot(curPositions[i][0] - prevPositions[i][0], curPositions[i][1] - prevPositions[i][1]);
        if (d > maxShift) maxShift = d;
      }
      if (maxShift < convergeTolMm) { stopReason = "converged"; iterations++; prevPositions = curPositions; break; }
    }
    prevPositions = curPositions;
  }

  const final = evaluate(theta, t);
  return {
    theta, t, converged: stopReason === "converged", iterations, stopReason,
    coverage: final.coverage, rmsResidualMm: final.rmsResidualMm, inlierCount: final.inlierCount,
  };
}

/**
 * Точное уточнение УЖЕ найденного кандидата — сужающийся радиус поиска
 * соответствий (по умолчанию 3000→1000→400→120мм), на каждом шаге
 * бОльший лимит итераций и более строгая сходимость, чем у грубого
 * поиска. Идея — после того, как поворот/перенос уже близки к верным,
 * широкий радиус (нужный ТОЛЬКО чтобы вообще НАЙТИ здание) начинает
 * мешать: он одинаково охотно цепляется за случайную соседнюю стену
 * (внутреннюю переборку, параллельный пролёт) — сужение радиуса
 * заставляет соответствия идти именно к БЛИЖАЙШЕЙ, скорее всего верной,
 * поверхности. Если на каком-то шаге соответствий стало < 3 (радиус
 * слишком узкий для факта — например, реальный отступ облицовки от
 * несущей стены превышает эту ступень), результат этого шага
 * ОТБРАСЫВАЕТСЯ и возвращается положение с ПРЕДЫДУЩЕГО шага — не жёсткий
 * миллиметровый допуск, а адаптивная остановка на том радиусе, на
 * котором соответствия ещё есть (Docs/fbx-fine-placement-claude-
 * prompt.md §3, §6).
 */
export async function fineRefine({ fbxPoints, objectSegments, thetaInit, tInit, opts = {} }) {
  const schedule = opts.radiusScheduleMm ?? [3000, 1000, 400, 120];
  const maxTimeMsTotal = opts.maxTimeMsTotal ?? 1500;
  const t0 = nowMs();
  let theta = thetaInit, t = [tInit[0], tInit[1]];
  let iterations = 0;
  let stopReason = "notRun";
  let ran = false;
  for (const maxDist of schedule) {
    await yieldToEventLoop();
    if (nowMs() - t0 > maxTimeMsTotal) { stopReason = "timeBudget"; break; }
    // Пол размера ячейки — НЕ maxDist/2 без ограничения снизу: индекс
    // строится вставкой сегмента во ВСЕ ячейки его bbox (buildSegmentGrid-
    // Index), и для длинного диагонального отрезка при мелкой ячейке это
    // квадратично по длине (bbox почти квадратный) — на реальных стенах
    // (десятки метров, есть непрямоугольные участки) при ячейке 100мм это
    // и оказалось узким местом: построение индекса на финальных, самых
    // мелких ступенях расписания заняло секунды вместо миллисекунд
    // (живая проверка на объектах 3/4 анонимной копии, 2026-09-12).
    const index = buildSegmentGridIndex(objectSegments, Math.max(maxDist / 2, 400));
    const remainingMs = Math.max(50, maxTimeMsTotal - (nowMs() - t0));
    const icp = icpRefine({
      fbxPoints, objectSegments, objectIndex: index, thetaInit: theta, tInit: t,
      opts: { maxIters: opts.maxItersPerStage ?? 80, maxDist, trimFrac: opts.trimFrac ?? 0.2, convergeTolMm: opts.convergeTolMm ?? 0.01, maxTimeMs: remainingMs },
    });
    if (icp.inlierCount < 3) {
      // Радиус этой ступени слишком узок для фактической геометрии
      // (например, реальный зазор облицовка/несущая стена) — остаёмся на
      // положении с предыдущей, более широкой ступени, не откатываемся к
      // худшему и не считаем это провалом всего уточнения.
      stopReason = ran ? "radiusTooTight" : "tooFewMatches";
      break;
    }
    theta = icp.theta; t = icp.t;
    iterations += icp.iterations;
    stopReason = icp.stopReason;
    ran = true;
  }
  // ЧИСТАЯ оценка на итоговых theta/t — БЕЗ мутации (раньше здесь стоял
  // `icpRefine({maxIters:1})`, который всё равно выполняет один полный
  // шаг Прокруста внутри цикла и СДВИГАЕТ theta/t перед оценкой; функция
  // возвращала СТАРЫЕ theta/t, но coverage/rms — уже от НОВОГО, сдвинутого
  // положения — рассинхронизация между возвращённым transform и его же
  // метриками. `evaluateTransform` ничего не оптимизирует и не сдвигает.
  const finalIndex = buildSegmentGridIndex(objectSegments, Math.max(schedule[schedule.length - 1] / 2, 400));
  const final = evaluateTransform(fbxPoints, objectSegments, finalIndex, theta, t, schedule[schedule.length - 1]);
  return {
    theta, t, iterations, stopReason, ran,
    coverage: final.coverage, rmsResidualMm: final.rmsResidualMm, inlierCount: final.inlierCount,
    timingMs: Math.round(nowMs() - t0),
  };
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
export async function autoAlignFacade({ fbxSegments, objectSegments, limits = {} }) {
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

  // Грубый поиск — быстрый и НАМЕРЕННО не точный (маленький maxIters,
  // широкий maxDist): нужен только чтобы отсеять заведомо плохие старты
  // и найти несколько существенно разных ПРИБЛИЗИТЕЛЬНО верных положений;
  // тратить время точного уточнения на все комбинации поворотов×стартов
  // не нужно (Docs/fbx-fine-placement-claude-prompt.md §1).
  const rawResults = [];
  for (const rc of rotationCandidates) {
    const seeds = initialTranslationSeeds(rc.theta, fbxParts, fbxSegments, objectParts, objectSegments);
    for (const tInit of seeds) {
      await yieldToEventLoop();
      const icp = icpRefine({ fbxPoints, objectSegments, objectIndex, thetaInit: rc.theta, tInit, opts: {
        maxIters: limits.icpMaxItersCoarse ?? 12, maxDist, trimFrac: limits.icpTrimFrac ?? 0.2, convergeTolMm: 1,
      } });
      // Соразмерность наружных габаритов — ПОПАРНО по значимым частям
      // (fbxParts/objectParts, не агрегат всех отрезков — задание §4.1,
      // Docs/fbx-partial-envelope-claude-prompt.md: одна лишняя деталь в
      // FBX сверх самого здания — соседний корпус в кадре экспорта,
      // элемент благоустройства, кровельное ограждение — раньше
      // проваливала агрегатную проверку целиком, отклоняя ЛЮБОЙ поворот,
      // включая верный). На УЖЕ УТОЧНЁННОМ ICP угле (icp.theta), НЕ на
      // исходном кандидате направления (rc.theta): пики гистограммы
      // направлений могут отличаться от истинного угла на несколько
      // градусов, а проверка габарита чувствительна к точности угла
      // (подтверждено: тест с ответом 22°, пик дал только 18°). Не
      // зависит от переноса — проверяется на каждый старт (дёшево).
      const sizeCheck = checkSizeCompatibility(fbxParts, objectParts, icp.theta, {
        toleranceAbsMm: limits.sizeToleranceAbsMm, toleranceRel: limits.sizeToleranceRel,
      });
      const perPart = perPartScores(icp.theta, icp.t, fbxParts, objectSegments, objectIndex, maxDist);
      const worstPartCoverage = perPart.length ? Math.min(...perPart.map((b) => b.coverage)) : 0;
      rawResults.push({
        theta: icp.theta, t: icp.t, coverage: icp.coverage, rmsResidualMm: icp.rmsResidualMm, worstPartCoverage, perPart,
        sizeMismatchMm: sizeCheck.mismatchMm, sizeHardFail: sizeCheck.hardFail,
      });
    }
  }
  // Кандидаты с явно несовместимым габаритом крупнейшей части НЕ
  // предлагаются вовсе — ни как confident, ни в списке ambiguous
  // (задание §4: «не навязывай выбор одного из [заведомо плохих]»). Не
  // отбрасываем ДО ICP — перенос иногда сам подсказывает, что размер не
  // сходится, дешевле проверить постфактум на уже посчитанном theta.
  const viableRawResults = rawResults.filter((r) => !r.sizeHardFail);

  // Сравнение кандидатов: небольшое (< coverageTieEps) преимущество по
  // coverage НЕ должно перевешивать явно лучшую невязку — широкий радиус
  // грубого поиска одинаково охотно засчитывает случайное совпадение с
  // соседней стеной, поэтому «больше точек внутри 3м» само по себе не
  // значит «более верное положение» (Docs/fbx-fine-placement-claude-
  // prompt.md §4). Существенная разница coverage по-прежнему решает —
  // кандидат, покрывающий вдвое меньше здания, объективно хуже.
  const coverageTieEps = limits.coverageTieEps ?? 0.03;
  function compareResults(a, b) {
    const covDiff = b.coverage - a.coverage;
    if (Math.abs(covDiff) > coverageTieEps) return covDiff;
    return a.rmsResidualMm - b.rmsResidualMm;
  }

  // Дедупликация по ПОЛНОМУ положению (угол и перенос) — независимые
  // старты, сошедшиеся к одному и тому же ответу, не должны считаться
  // «двумя разными кандидатами» при оценке неоднозначности.
  function dedupResults(list) {
    const out = [];
    for (const r of list) {
      const existing = out.find((e) => sameTransform(e, r));
      if (!existing) { out.push({ ...r }); continue; }
      if (compareResults(r, existing) < 0) Object.assign(existing, r);
    }
    out.sort(compareResults);
    return out;
  }

  const coarseResults = dedupResults(viableRawResults);

  // Точное уточнение — ТОЛЬКО для нескольких лучших существенно разных
  // грубых кандидатов (не для всех стартов, включая заведомо плохие):
  // сужающийся радиус соответствий и адаптивная сходимость по смещению
  // точек, не по числу итераций (см. fineRefine выше).
  const maxFineCandidates = limits.maxFineCandidates ?? 3;
  const fineViabilityCoverage = limits.fineViabilityCoverage ?? 0.15;
  const fineRefinements = [];
  const refinedResults = [];
  for (let idx = 0; idx < coarseResults.length; idx++) {
    const r = coarseResults[idx];
    if (idx >= maxFineCandidates || r.coverage < fineViabilityCoverage) { refinedResults.push(r); continue; }
    await yieldToEventLoop();
    const fine = await fineRefine({
      fbxPoints, objectSegments, thetaInit: r.theta, tInit: r.t,
      opts: {
        radiusScheduleMm: limits.fineRadiusScheduleMm, maxTimeMsTotal: limits.fineMaxTimeMsTotal ?? 1500,
        maxItersPerStage: limits.fineMaxItersPerStage, convergeTolMm: limits.fineConvergeTolMm,
      },
    });
    fineRefinements.push({
      coverageBefore: r.coverage, coverageAfter: fine.coverage,
      rmsBefore: r.rmsResidualMm, rmsAfter: fine.rmsResidualMm,
      iterations: fine.iterations, stopReason: fine.stopReason, timingMs: fine.timingMs,
    });
    // Точный радиус мог законно НЕ найти соответствий (например, реальный
    // отступ облицовки от несущей стены) — fineRefine в этом случае сам
    // остаётся на положении с более широкой ступени (ran=true) либо,
    // если ни одна ступень не дала совпадений вовсе (ran=false),
    // сохраняем грубый результат как есть, не подставляя худшее.
    if (!fine.ran) { refinedResults.push(r); continue; }
    // ВАЖНО: coverage/rms для отбора/сортировки — на ТОМ ЖЕ грубом
    // радиусе (maxDist), которым оценивались ВСЕ остальные кандидаты, а
    // не на узком финальном радиусе точного уточнения (fine.coverage) —
    // иначе более точный кандидат нечестно проигрывает менее точному
    // просто из-за более строгого мерила (см. evaluateTransform выше).
    // Точная (узкая) невязка сохраняется отдельно, для показа человеку.
    const atCoarseRadius = evaluateTransform(fbxPoints, objectSegments, objectIndex, fine.theta, fine.t, maxDist);
    const perPart = perPartScores(fine.theta, fine.t, fbxParts, objectSegments, objectIndex, maxDist);
    const worstPartCoverage = perPart.length ? Math.min(...perPart.map((b) => b.coverage)) : 0;
    refinedResults.push({
      theta: fine.theta, t: fine.t, coverage: atCoarseRadius.coverage, rmsResidualMm: atCoarseRadius.rmsResidualMm, worstPartCoverage, perPart,
      refined: true, refineIterations: fine.iterations, refineStopReason: fine.stopReason,
      fineRmsResidualMm: fine.rmsResidualMm, fineCoverage: fine.coverage,
    });
  }

  // После точного уточнения независимые грубые старты могли сойтись к
  // ОДНОМУ И ТОМУ ЖЕ истинному положению — передедуплицировать.
  const results = dedupResults(refinedResults);

  const timingMs = Math.round(((typeof performance !== "undefined" ? performance : Date).now()) - t0);
  const diagnostics = {
    timingMs, fbxSegmentCount: fbxSegments.length, objectSegmentCount: objectSegments.length,
    fbxPeaks, objPeaks, rotationCandidateCount: rotationCandidates.length,
    fbxPartCount: fbxParts.length, objectPartCount: objectParts.length,
    fbxPartCountTotal: fbxPartsAll.length, objectPartCountTotal: objectPartsAll.length,
    fbxSampleCount: fbxPoints.length,
    coarseResultCount: coarseResults.length, distinctResultCount: results.length,
    fineRefinements,
    rejectedForSizeMismatch: rawResults.length - viableRawResults.length,
  };

  if (!results.length) {
    const allRejectedForSize = rawResults.length > 0 && viableRawResults.length === 0;
    return {
      status: "insufficient_geometry", candidates: [],
      reason: allRejectedForSize
        ? "Наружные габариты фасада и конструктива несовместимы (расхождение больше объяснимого толщиной облицовки) — совмещение не может быть корректным ни при каком повороте/переносе, проверьте исходные файлы."
        : "Не нашлось ни одного пригодного кандидата переноса.",
      diagnostics,
    };
  }

  const toCandidateOut = (r) => ({
    theta: r.theta, tXY: r.t,
    coverage: r.coverage, rmsResidualMm: r.rmsResidualMm, worstPartCoverage: r.worstPartCoverage, perPart: r.perPart,
    refined: !!r.refined, refineIterations: r.refineIterations, refineStopReason: r.refineStopReason,
    // Невязка НА УЗКОМ радиусе точного уточнения — точнее отражает
    // фактическое совпадение геометрии там, где точное уточнение
    // сработало; отсутствует, если кандидат не уточнялся.
    fineRmsResidualMm: r.fineRmsResidualMm, fineCoverage: r.fineCoverage,
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
