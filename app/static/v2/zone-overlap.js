// Площадь пересечения контуров в плоскости яруса. Стоянки могут быть
// невыпуклыми; пересечение считаем по треугольникам обоих контуров.
// Касание границ не считается пересечением.
export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

export function overlapPolygon(subject, clip) {
  if (!subject?.length || !clip?.length) return [];
  const sign = Math.sign(polygonArea(clip));
  if (!sign) return [];
  let result = subject.map((p) => [...p]);
  for (let i = 0; i < clip.length && result.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const cross = (p) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = result; result = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const cp = cross(p), cq = cross(q);
      if (cp >= -1e-7) result.push(p);
      if ((cp < -1e-7 && cq > 1e-7) || (cp > 1e-7 && cq < -1e-7)) {
        const t = cp / (cp - cq);
        result.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return result.length < 3 ? [] : result;
}

function boundingBox(points) {
  return { x0: Math.min(...points.map((p) => p[0])), x1: Math.max(...points.map((p) => p[0])),
    y0: Math.min(...points.map((p) => p[1])), y1: Math.max(...points.map((p) => p[1])) };
}

function convex(points) {
  const sign = Math.sign(polygonArea(points));
  if (!sign) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    if (sign * ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < -1e-7) return false;
  }
  return true;
}

function triangles(outline) {
  const sign = Math.sign(polygonArea(outline));
  if (!sign) return [];
  const points = outline.filter((point, i) => i === 0 || point[0] !== outline[i - 1][0] || point[1] !== outline[i - 1][1]);
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  const indices = points.map((_, i) => i), pieces = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  while (indices.length > 3) {
    let ear = false;
    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i + indices.length - 1) % indices.length];
      const curr = indices[i], next = indices[(i + 1) % indices.length];
      const a = points[prev], b = points[curr], c = points[next];
      if (sign * cross(a, b, c) <= 1e-7) continue;
      if (indices.some((other) => other !== prev && other !== curr && other !== next &&
        sign * cross(a, b, points[other]) > 1e-7 &&
        sign * cross(b, c, points[other]) > 1e-7 &&
        sign * cross(c, a, points[other]) > 1e-7)) continue;
      pieces.push([a, b, c]); indices.splice(i, 1); ear = true; break;
    }
    if (!ear) return [];
  }
  if (indices.length === 3) pieces.push(indices.map((i) => points[i]));
  return pieces;
}

function overlapPieces(subject, clip) {
  if (!subject?.length || !clip?.length) return [];
  const a = boundingBox(subject), b = boundingBox(clip);
  if (a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0) return [];
  if (convex(subject) && convex(clip)) {
    const piece = overlapPolygon(subject, clip);
    return piece.length ? [piece] : [];
  }
  const pieces = [];
  for (const left of triangles(subject)) for (const right of triangles(clip)) {
    const piece = overlapPolygon(left, right);
    if (piece.length && Math.abs(polygonArea(piece)) > 1e-7) pieces.push(piece);
  }
  return pieces;
}

export function overlapArea(subject, clip) {
  return overlapPieces(subject, clip).reduce((sum, piece) => sum + Math.abs(polygonArea(piece)), 0);
}

function closestPointOnBoundary(outline, point) {
  let closest = point, best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
    const candidate = [a[0] + t * dx, a[1] + t * dy];
    const gap = (candidate[0] - point[0]) ** 2 + (candidate[1] - point[1]) ** 2;
    if (gap < best) { closest = candidate; best = gap; }
  }
  return closest;
}

function overlappingPeerLevels(zones, zone, elevation) {
  if (zone.category !== "Стоянка") return [];
  const lowerLevels = [...new Set(zones.filter((item) => item.category === "Стоянка")
    .flatMap((item) => (item.levels || []).map((level) => level.elevation_mm)).concat(elevation))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const upperFor = (level) => Number.isFinite(level.upper_elevation_mm) ? level.upper_elevation_mm :
    lowerLevels.find((value) => value > level.elevation_mm) ?? Infinity;
  const source = zone.levels?.find((level) => level.elevation_mm === elevation);
  const upper = source ? upperFor(source) : lowerLevels.find((value) => value > elevation) ?? Infinity;
  return zones.filter((other) => other.id !== zone.id && other.category === "Стоянка")
    .flatMap((other) => other.levels.filter((level) => elevation < upperFor(level) && level.elevation_mm < upper)
      .map((level) => ({ other, level })));
}

function pointOnSegment(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const cross = (point[0] - a[0]) * dy - (point[1] - a[1]) * dx;
  return Math.abs(cross) <= 1e-7 * Math.max(1, Math.hypot(dx, dy)) &&
    point[0] >= Math.min(a[0], b[0]) - 1e-7 && point[0] <= Math.max(a[0], b[0]) + 1e-7 &&
    point[1] >= Math.min(a[1], b[1]) - 1e-7 && point[1] <= Math.max(a[1], b[1]) + 1e-7;
}

function strictlyInside(outline, point) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j], b = outline[i];
    if (pointOnSegment(point, a, b)) return false;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segmentIntrusion(outline, from, to) {
  if (strictlyInside(outline, from)) return closestPointOnBoundary(outline, from);
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (!dx && !dy) return null;
  const crossing = [0, 1];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const ax = a[0] - from[0], ay = a[1] - from[1];
    const t = (ax * ey - ay * ex) / denominator;
    const u = (ax * dy - ay * dx) / denominator;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9)
      crossing.push(Math.max(0, Math.min(1, t)));
  }
  crossing.sort((a, b) => a - b);
  for (let i = 0; i < crossing.length - 1; i++) {
    if (crossing[i + 1] - crossing[i] < 1e-9) continue;
    const middle = (crossing[i] + crossing[i + 1]) / 2;
    if (strictlyInside(outline, [from[0] + dx * middle, from[1] + dy * middle]))
      return [from[0] + dx * crossing[i], from[1] + dy * crossing[i]];
  }
  return strictlyInside(outline, to) ? closestPointOnBoundary(outline, to) : null;
}

export function peerSegmentIntrusion(zones, zone, elevation, from, to = from) {
  for (const { other, level } of overlappingPeerLevels(zones, zone, elevation)) {
    const contact = segmentIntrusion(level.outline, from, to);
    if (contact) return { other, elevation_mm: level.elevation_mm, contact };
  }
  return null;
}

export function peerOverlap(zones, zone, elevation, outline, minimumArea = 1) {
  return overlappingPeerLevels(zones, zone, elevation)
    .map(({ other, level }) => {
        const pieces = overlapPieces(level.outline, outline);
        const area = pieces.reduce((sum, piece) => sum + Math.abs(polygonArea(piece)), 0);
        const center = area > 0 ? [0, 0] : null;
        if (center) for (const piece of pieces) {
          const weight = Math.abs(polygonArea(piece)) / area;
          center[0] += piece.reduce((sum, p) => sum + p[0], 0) / piece.length * weight;
          center[1] += piece.reduce((sum, p) => sum + p[1], 0) / piece.length * weight;
        }
        return { other, elevation_mm: level.elevation_mm, area,
          contact: center ? closestPointOnBoundary(level.outline, center) : null };
      })
    .filter(({ area }) => area > minimumArea);
}

// Все конфликты стоянок объекта (красная штриховка на схеме 2D, 2026-09-28): пары ярусов ЛЮБЫХ стоянок — разных
// кранов, одного крана и одной стоянки, — у которых высотные полосы пересекаются, а контуры накладываются по
// площади. Полоса яруса — от его отметки до верхней отметки, а без неё — до следующей отметки объекта (как в
// overlappingPeerLevels выше). Касание границ конфликтом не считается. Возвращает пары с кусками наложения
// (непересекающиеся многоугольники) и общей высотной полосой пары [lower, upper).
export function zoneConflicts(zones, minimumArea = 1) {
  const stances = (zones || []).filter((zone) => zone.category === "Стоянка");
  const lowers = [...new Set(stances.flatMap((zone) => (zone.levels || []).map((level) => level.elevation_mm)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const upperFor = (level) => Number.isFinite(level.upper_elevation_mm) ? level.upper_elevation_mm :
    lowers.find((value) => value > level.elevation_mm) ?? Infinity;
  const items = stances.flatMap((zone) => (zone.levels || []).map((level, index) => ({ zone, level, index }))
    .filter(({ level }) => level.outline?.length >= 3 && Number.isFinite(level.elevation_mm))
    .map((item) => ({ ...item, lower: item.level.elevation_mm, upper: upperFor(item.level), box: boundingBox(item.level.outline) })));
  const conflicts = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (!(a.lower < b.upper && b.lower < a.upper)) continue;
    if (a.box.x1 <= b.box.x0 || b.box.x1 <= a.box.x0 || a.box.y1 <= b.box.y0 || b.box.y1 <= a.box.y0) continue;
    const pieces = overlapPieces(a.level.outline, b.level.outline);
    const area = pieces.reduce((sum, piece) => sum + Math.abs(polygonArea(piece)), 0);
    if (area <= minimumArea) continue;
    conflicts.push({ a: { zone_id: a.zone.id, level_index: a.index, elevation_mm: a.lower },
      b: { zone_id: b.zone.id, level_index: b.index, elevation_mm: b.lower },
      lower: Math.max(a.lower, b.lower), upper: Math.min(a.upper, b.upper), area, pieces });
  }
  return conflicts;
}

// Соседние ярусы, в которые нельзя заходить контуром стоянки на отметке elevation: те же, что проверяют
// peerSegmentIntrusion/peerOverlap. Редактор обводит их при ручной отрисовке контура (2026-09-28).
export function peerLevels(zones, zone, elevation) {
  return overlappingPeerLevels(zones, zone, elevation).filter(({ level }) => level.outline?.length >= 3);
}
