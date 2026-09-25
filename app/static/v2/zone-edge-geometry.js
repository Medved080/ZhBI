// Геометрия перетаскивания ребра контура. Работает с исходными точками
// жеста, чтобы повторные pointermove не накапливали ошибку округления.
export function nearestEdgeIndex(outline, x, y, toScreen, maxDistance = 9) {
  if (!Array.isArray(outline) || outline.length < 2) return null;
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
