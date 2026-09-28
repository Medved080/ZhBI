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

// Правило прижатия — как в серверной привязке (scripts/zone_binding.py, bind_stance_union): изделие ниже нижней
// отметки объекта, а ригель и плита — и на самой нижней отметке, относятся к нижнему ярусу, но только если ни у
// одной стоянки нет явной верхней отметки (2026-09-28).
function clampsToBottom(stances) {
  return stances.every((stance) => stance.levels.every((level) => !Number.isFinite(level.upper_elevation_mm)));
}

function stanceLevel(zone, element, objectLevels, clamp = true) {
  const elevation = element.elevation_mm;
  if (!Number.isFinite(elevation)) return null;
  const strict = CAPPING_TYPES.has(element.element_type);
  const eligible = objectLevels.filter((v) => strict ? v < elevation : v <= elevation);
  if (!eligible.length && !clamp) return null;
  const selected = eligible.length ? eligible[eligible.length - 1] : objectLevels[0];
  const level = zone.levels.find((item) => item.elevation_mm === selected) || null;
  if (!level) return null;
  const next = objectLevels.find((value) => value > selected) ?? Infinity;
  const upper = Number.isFinite(level.upper_elevation_mm) ? level.upper_elevation_mm : next;
  return (strict ? elevation <= upper : elevation < upper) ? level : null;
}

export function countElementsInZone(zone, elements, zones = [zone], overrides = {}) {
  const stances = zones.filter((item) => item.category === "Стоянка");
  const objectLevels = [...new Set(stances.flatMap((item) => item.levels.map((level) => level.elevation_mm)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const clamp = clampsToBottom(stances);
  let count = 0;
  for (const element of elements) {
    if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
    const override = overrides[String(element.id)];
    if (override) {
      if (zone.category === "Кран" && override.crane_zone_id === zone.id) count++;
      if (zone.category === "Стоянка" && override.stance_zone_id === zone.id) count++;
      continue;
    }
    if (zone.category === "Кран" && zone.levels?.length && !stances.length) {
      if (zone.levels.some((level) => level.outline?.length &&
          inside(level.outline, element.x, element.y))) count++;
      continue;
    }
    if (!objectLevels.length || !Number.isFinite(element.elevation_mm)) continue;
    const matched = stances.filter((stance) => {
      const outline = stanceLevel(stance, element, objectLevels, clamp)?.outline;
      return outline?.length && inside(outline, element.x, element.y);
    });
    if (matched.length !== 1) continue;
    if (zone.category === "Стоянка" && matched[0].id === zone.id) count++;
    if (zone.category === "Кран" && matched[0].parent_zone_id === zone.id) count++;
  }
  return count;
}

// Один проход по изделиям для всего дерева редакции. Предыдущая схема вызывала
// countElementsInZone для каждой зоны и повторяла поиск среди всех стоянок
// десятки раз при каждом выборе строки дерева.
export function countElementsByZones(zones, elements, overrides = {}) {
  const counts = new Map(zones.map((zone) => [zone.id, 0]));
  const stances = zones.filter((zone) => zone.category === "Стоянка");
  const objectLevels = [...new Set(stances.flatMap((zone) => zone.levels.map((level) => level.elevation_mm)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
  const byLevel = new Map(objectLevels.map((elevation) => [elevation, []]));
  const seenLevels = new Set();
  for (const stance of stances) for (const level of stance.levels) {
    const key = `${stance.id}:${level.elevation_mm}`;
    if (seenLevels.has(key)) continue;
    seenLevels.add(key);
    if (!byLevel.has(level.elevation_mm) || !level.outline?.length) continue;
    const xs = level.outline.map((point) => point[0]);
    const ys = level.outline.map((point) => point[1]);
    byLevel.get(level.elevation_mm).push({ stance, outline: level.outline,
      upper: Number.isFinite(level.upper_elevation_mm) ? level.upper_elevation_mm :
        (objectLevels.find((value) => value > level.elevation_mm) ?? Infinity),
      minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
  }
  const increment = (id) => { if (counts.has(id)) counts.set(id, counts.get(id) + 1); };
  const clamp = clampsToBottom(stances);
  for (const element of elements) {
    if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
    const override = overrides[String(element.id)];
    if (override) { increment(override.crane_zone_id); increment(override.stance_zone_id); continue; }
    if (!objectLevels.length || !Number.isFinite(element.elevation_mm)) continue;
    const strict = CAPPING_TYPES.has(element.element_type);
    let candidates = [];
    for (let i = objectLevels.length - 1; i >= 0; i--) {
      const value = objectLevels[i];
      if (strict ? value >= element.elevation_mm : value > element.elevation_mm) continue;
      candidates = (byLevel.get(value) || []).filter((item) =>
        strict ? element.elevation_mm <= item.upper : element.elevation_mm < item.upper);
      if (candidates.length) break;
    }
    if (!candidates.length && clamp && (strict ? element.elevation_mm <= objectLevels[0] : element.elevation_mm < objectLevels[0]))
      candidates = byLevel.get(objectLevels[0]) || [];
    let match = null, ambiguous = false;
    for (const item of candidates) {
      if (element.x < item.minX || element.x > item.maxX ||
          element.y < item.minY || element.y > item.maxY ||
          !inside(item.outline, element.x, element.y)) continue;
      if (match) { ambiguous = true; break; }
      match = item.stance;
    }
    if (match && !ambiguous) { increment(match.id); increment(match.parent_zone_id); }
  }
  return counts;
}
