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

export function overlapArea(subject, clip) {
  if (!subject?.length || !clip?.length) return 0;
  const sign = Math.sign(polygonArea(clip));
  if (!sign) return 0;
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
  return result.length < 3 ? 0 : Math.abs(polygonArea(result));
}

export function peerOverlap(zones, zone, elevation, outline) {
  const top = Math.max(0, ...zones.flatMap((item) => item.levels.map((level) => Number(level.elevation_mm) || 0))) + 3000;
  const interval = (levels, value) => {
    const base = Number(value) || 0;
    const later = levels.map((level) => Number(level.elevation_mm) || 0).filter((n) => n > base);
    return [base, later.length ? Math.min(...later) : top];
  };
  const [start, end] = interval(zone.levels || [{ elevation_mm: elevation }], elevation);
  return zones.filter((other) => other.id !== zone.id && other.category === zone.category &&
    (zone.category === "Кран" || other.parent_zone_id === zone.parent_zone_id))
    .flatMap((other) => other.levels.filter((level) => {
      const [otherStart, otherEnd] = interval(other.levels, level.elevation_mm);
      return Math.max(start, otherStart) < Math.min(end, otherEnd);
    }).map((level) => ({ other, elevation_mm: level.elevation_mm, area: overlapArea(level.outline, outline) })))
    .filter(({ area }) => area > 1);
}
