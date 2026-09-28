// Счётчики редактора при перекрывающихся полосах разных стоянок совпадают с серверной привязкой
// (те же случаи, что scripts/test_stance_union_overlapping_bands.py; счётчики — по точке вставки).
import assert from "node:assert/strict";
import { countElementsByZones, countElementsInZone } from "../app/static/v2/zone-live-count.js";

const square = (x0, size = 10000) => [[x0, 0], [x0 + size, 0], [x0 + size, size], [x0, size]];
const zones = [
  { id: 1, category: "Кран", levels: [] }, { id: 2, category: "Кран", levels: [] },
  { id: 10, category: "Стоянка", parent_zone_id: 1, levels: [{ elevation_mm: -400, upper_elevation_mm: 15000, outline: square(0) }] },
  { id: 20, category: "Стоянка", parent_zone_id: 2, levels: [{ elevation_mm: 0, upper_elevation_mm: 15000, outline: square(20000) }] },
  { id: 11, category: "Стоянка", parent_zone_id: 1, levels: [{ elevation_mm: 15000, upper_elevation_mm: 25800, outline: square(0) }] },
];
const stanceOf = (element_type, x, elevation_mm) => {
  const element = { id: 1, x, y: 5000, element_type, elevation_mm };
  const fast = countElementsByZones(zones, [element]);
  const slow = new Map(zones.map((zone) => [zone.id, countElementsInZone(zone, [element], zones)]));
  const pick = (counts) => [10, 20, 11].find((id) => counts.get(id) === 1) ?? null;
  return { fast: pick(fast), slow: pick(slow) };
};
for (const [type, x, elevation, expected] of [
  ["Плита перекрытия", 2500, 15000, 10], ["Колонна", 5000, 0, 10], ["Колонна", 5000, 8050, 10],
  ["Колонна", 25000, 8050, 20], ["Плита перекрытия", 22500, 15000, 20], ["Колонна", 5000, 15000, 11], ["Колонна", 15000, 8050, null],
]) assert.deepEqual(stanceOf(type, x, elevation), { fast: expected, slow: expected }, `${type} x=${x} на ${elevation}`);
console.log("zone live count overlapping bands: 7 cases match server binding");
