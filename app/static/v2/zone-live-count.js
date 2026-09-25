// Быстрый предварительный счёт изделий по текущим контурам черновика.
// Назначения по правилам DXF рассчитываются отдельно в предпросмотре.
const CAPPING_TYPES = new Set(["Плита перекрытия", "Ригель"]);

function inside(outline, x, y) {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j];
    if (((a[1] > y) !== (b[1] > y)) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function stanceLevel(zone, element) {
  const elevation = element.elevation_mm;
  if (!Number.isFinite(elevation)) return null;
  const strict = CAPPING_TYPES.has(element.element_type);
  let chosen = null;
  for (const level of zone.levels) {
    if (!Number.isFinite(level.elevation_mm) ||
        !(strict ? level.elevation_mm < elevation : level.elevation_mm <= elevation)) continue;
    if (!chosen || level.elevation_mm > chosen.elevation_mm) chosen = level;
  }
  return chosen;
}

export function countElementsInZone(zone, elements) {
  let count = 0;
  for (const element of elements) {
    if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
    if (zone.category === "Стоянка") {
      const outline = stanceLevel(zone, element)?.outline;
      if (outline?.length && inside(outline, element.x, element.y)) count++;
    } else if (zone.levels.some((level) => level.outline?.length &&
      inside(level.outline, element.x, element.y))) count++;
  }
  return count;
}
