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

export function peerOverlap(zones, zone, elevation, outline) {
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
      .map((level) => {
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
      }))
    .filter(({ area }) => area > 1);
}
