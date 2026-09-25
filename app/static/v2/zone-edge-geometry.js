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
