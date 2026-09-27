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

function stanceLevel(zone, element, objectLevels) {
  const elevation = element.elevation_mm;
  if (!Number.isFinite(elevation)) return null;
  const strict = CAPPING_TYPES.has(element.element_type);
  const eligible = objectLevels.filter((v) => strict ? v < elevation : v <= elevation);
  const selected = eligible.length ? eligible[eligible.length - 1] : objectLevels[0];
  return zone.levels.find((level) => level.elevation_mm === selected) || null;
}

export function countElementsInZone(zone, elements, zones = [zone], overrides = {}) {
  const stances = zones.filter((item) => item.category === "Стоянка");
  const objectLevels = [...new Set(stances.flatMap((item) => item.levels.map((level) => level.elevation_mm)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  let count = 0;
  for (const element of elements) {
    if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
    const override = overrides[String(element.id)];
    if (override) {
      if (zone.category === "Кран" && override.crane_zone_id === zone.id) count++;
      if (zone.category === "Стоянка" && override.stance_zone_id === zone.id) count++;
      continue;
    }
    if (!objectLevels.length || !Number.isFinite(element.elevation_mm)) continue;
    const matched = stances.filter((stance) => {
      const outline = stanceLevel(stance, element, objectLevels)?.outline;
      return outline?.length && inside(outline, element.x, element.y);
    });
    if (matched.length !== 1) continue;
    if (zone.category === "Стоянка" && matched[0].id === zone.id) count++;
    if (zone.category === "Кран" && matched[0].parent_zone_id === zone.id) count++;
  }
  return count;
}
