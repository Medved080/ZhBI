// Площадь пересечения контуров в плоскости яруса. Редактор двигает грань
// прямоугольника; для проверки клипуем произвольный соседний DXF-контур
// его выпуклым четырёхугольником. Касание границ не считается пересечением.
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

export function overlapArea(subject, clip) {
  return Math.abs(polygonArea(overlapPolygon(subject, clip)));
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
  return zones.filter((other) => other.id !== zone.id && other.category === "Стоянка")
    .flatMap((other) => other.levels.filter((level) => level.elevation_mm === elevation)
      .map((level) => {
        const polygon = overlapPolygon(level.outline, outline);
        const area = Math.abs(polygonArea(polygon));
        const center = polygon.length ? [polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length,
          polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length] : null;
        return { other, elevation_mm: level.elevation_mm, area,
          contact: center ? closestPointOnBoundary(level.outline, center) : null };
      }))
    .filter(({ area }) => area > 1);
}
