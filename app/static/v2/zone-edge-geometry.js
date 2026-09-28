// Геометрия перетаскивания ребра контура. Работает с исходными точками
// жеста, чтобы повторные pointermove не накапливали ошибку округления.
export function nearestEdgeIndex(outline, x, y, toScreen, maxDistance = 9, vertexExclusion = 0) {
  if (!Array.isArray(outline) || outline.length < 2) return null;
  if (vertexExclusion > 0 && outline.some((point) => {
    const [px, py] = toScreen(point);
    return Math.hypot(x - px, y - py) < vertexExclusion;
  })) return null;
  let nearest = null;
  let distance = maxDistance;
  for (let i = 0; i < outline.length; i++) {
    const a = toScreen(outline[i]);
    const b = toScreen(outline[(i + 1) % outline.length]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
    const gap = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
    if (gap < distance) { nearest = i; distance = gap; }
  }
  return nearest;
}

export function displacedEdgeEndpoints(outline, index, dx, dy) {
  if (!Array.isArray(outline) || !outline.length || index < 0 || index >= outline.length) return null;
  const a = outline[index], b = outline[(index + 1) % outline.length];
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const length = Math.hypot(ex, ey);
  if (!length) return null;
  const nx = -ey / length, ny = ex / length;
  // Шаг в 1 мм по нормали, но без независимого округления X/Y концов:
  // при любом угле оба конца получают один вектор, сохраняя параллельность.
  const offset = Math.round(dx * nx + dy * ny);
  return [
    [a[0] + offset * nx, a[1] + offset * ny],
    [b[0] + offset * nx, b[1] + offset * ny],
  ];
}

// Перемещение боковой грани прямоугольного параллелепипеда. Четыре вершины
// пересчитываются вместе: выбранная и противоположная стороны остаются
// параллельными, соседние — перпендикулярными. Исходные DXF-контуры бывают
// слегка неточными, поэтому при первом движении грань выпрямляется.
export function displacedRectFace(outline, index, dx, dy) {
  if (!Array.isArray(outline) || outline.length !== 4 || index < 0 || index > 3) return null;
  const a = outline[index], b = outline[(index + 1) % 4];
  const c = outline[(index + 2) % 4], d = outline[(index + 3) % 4];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 1) return null;
  const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
  const nx = -uy, ny = ux;
  const along = (p) => p[0] * ux + p[1] * uy;
  const normal = (p) => p[0] * nx + p[1] * ny;
  const left = (along(a) + along(d)) / 2;
  const right = (along(b) + along(c)) / 2;
  const selected = (normal(a) + normal(b)) / 2;
  const opposite = (normal(c) + normal(d)) / 2;
  const depth = opposite - selected;
  if (Math.abs(depth) < 1 || right - left < 1) return null;
  const minimum = Math.min(100, Math.abs(depth) / 2);
  const desired = selected + Math.round(dx * nx + dy * ny);
  const moved = depth > 0 ? Math.min(desired, opposite - minimum) : Math.max(desired, opposite + minimum);
  const point = (u, n) => [u * ux + n * nx, u * uy + n * ny];
  const result = outline.map((p) => [...p]);
  result[index] = point(left, moved);
  result[(index + 1) % 4] = point(right, moved);
  result[(index + 2) % 4] = point(right, opposite);
  result[(index + 3) % 4] = point(left, opposite);
  return result;
}

// У многоугольной стоянки сдвигается выбранное ребро параллельно себе.
// Остальные вершины остаются на месте; соседние рёбра удлиняются или
// укорачиваются без поворота. При достижении самопересечения
// перемещение останавливается на последнем допустимом положении.
export function displacedZoneEdge(outline, index, dx, dy) {
  if (!Array.isArray(outline) || outline.length < 3 || index < 0 || index >= outline.length) return null;
  const n = outline.length, next = (index + 1) % n;
  const a = outline[index], b = outline[next];
  const ex = b[0] - a[0], ey = b[1] - a[1], length = Math.hypot(ex, ey);
  if (length < 1) return null;
  const nx = -ey / length, ny = ex / length;
  const desired = Math.round(dx * nx + dy * ny);
  const sourceArea = signedArea2(outline);
  if (Math.abs(sourceArea) < 1) return null;
  // Концы сдвинутого ребра скользят по прямым соседних рёбер. Поэтому
  // направление всех трёх сторон сохраняется даже у непрямоугольной стоянки.
  const intersection = (p, direction, q, otherDirection) => {
    const cross = direction[0] * otherDirection[1] - direction[1] * otherDirection[0];
    if (Math.abs(cross) < 1e-9 * Math.hypot(...direction) * Math.hypot(...otherDirection)) return null;
    const t = ((q[0] - p[0]) * otherDirection[1] - (q[1] - p[1]) * otherDirection[0]) / cross;
    return [p[0] + t * direction[0], p[1] + t * direction[1]];
  };
  const before = outline[(index + n - 1) % n], after = outline[(index + 2) % n];
  const previousDirection = [a[0] - before[0], a[1] - before[1]];
  const nextDirection = [after[0] - b[0], after[1] - b[1]];
  const candidate = (offset) => {
    const result = outline.map((point) => [...point]);
    const shifted = [a[0] + offset * nx, a[1] + offset * ny];
    result[index] = intersection(before, previousDirection, shifted, [ex, ey]);
    result[next] = intersection(b, nextDirection, shifted, [ex, ey]);
    if (!result[index] || !result[next]) return null;
    return result;
  };
  const valid = (result) => {
    if (!result) return false;
    const area = signedArea2(result);
    if (Math.abs(area) < 1 || Math.sign(area) !== Math.sign(sourceArea)) return false;
    for (const edge of [(index + n - 1) % n, index, next]) {
      const p = result[edge], q = result[(edge + 1) % n];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.001) return false;
      for (let other = 0; other < n; other++) {
        if (other === edge || (edge + 1) % n === other || (other + 1) % n === edge) continue;
        if (segmentsIntersect(p, q, result[other], result[(other + 1) % n])) return false;
      }
    }
    return true;
  };
  const result = candidate(desired);
  if (valid(result)) return result;
  let low = 0, high = Math.abs(desired), best = candidate(0);
  for (let step = 0; step < 15 && high - low > 1; step++) {
    const middle = Math.floor((low + high) / 2);
    const attempt = candidate(Math.sign(desired) * middle);
    if (valid(attempt)) { low = middle; best = attempt; }
    else high = middle;
  }
  return best;
}

export function axisSnapPoint(from, point) {
  const x = Math.round(point[0]), y = Math.round(point[1]);
  if (!from) return [x, y];
  return Math.abs(x - from[0]) >= Math.abs(y - from[1]) ? [x, from[1]] : [from[0], y];
}

export function orthogonalOutlineValid(points, closed = false) {
  if (!Array.isArray(points) || points.length < (closed ? 4 : 1)) return false;
  if (closed && Math.abs(signedArea2(points)) < 1) return false;
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (!(a[0] === b[0] && a[1] !== b[1] || a[1] === b[1] && a[0] !== b[0])) return false;
    for (let j = i + 1; j < edges; j++) {
      if (j === i + 1 || closed && i === 0 && j === edges - 1) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return false;
    }
  }
  return true;
}

export function completeOrthogonalOutline(points) {
  if (orthogonalOutlineValid(points, true)) return points.map((point) => [...point]);
  if (!Array.isArray(points) || points.length < 3) return null;
  const first = points[0], last = points.at(-1);
  const corners = [[first[0], last[1]], [last[0], first[1]]];
  for (const corner of corners) {
    const outline = [...points, corner];
    if (orthogonalOutlineValid(outline, true)) return outline;
  }
  return null;
}

function signedArea2(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  if ((abC > 0 && abD < 0 || abC < 0 && abD > 0) &&
      (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0)) return true;
  const on = (p, q, r) => r[0] >= Math.min(p[0], q[0]) - 1e-7 &&
    r[0] <= Math.max(p[0], q[0]) + 1e-7 && r[1] >= Math.min(p[1], q[1]) - 1e-7 &&
    r[1] <= Math.max(p[1], q[1]) + 1e-7;
  return Math.abs(abC) < 1e-7 && on(a, b, c) || Math.abs(abD) < 1e-7 && on(a, b, d) ||
    Math.abs(cdA) < 1e-7 && on(c, d, a) || Math.abs(cdB) < 1e-7 && on(c, d, b);
}
