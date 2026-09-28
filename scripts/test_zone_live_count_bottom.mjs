// Счётчики редактора на нижней отметке объекта должны совпадать с серверной привязкой (scripts/zone_binding.py,
// bind_stance_union; тот же набор случаев — scripts/test_stance_union_bottom_level.py).
import assert from "node:assert/strict";
import { countElementsByZones, countElementsInZone } from "../app/static/v2/zone-live-count.js";

const square = [[0, 0], [10000, 0], [10000, 10000], [0, 10000]];
const zones = (upper = null) => [
  { id: 1, category: "Кран", levels: [] },
  { id: 10, category: "Стоянка", parent_zone_id: 1, levels: [{ elevation_mm: 0, upper_elevation_mm: upper, outline: square }] },
  { id: 30, category: "Стоянка", parent_zone_id: 1, levels: [{ elevation_mm: 3000, outline: square }] },
];
const stanceOf = (set, element_type, elevation_mm) => {
  const element = { id: 1, x: 5000, y: 5000, element_type, elevation_mm };
  const fast = countElementsByZones(set, [element]);
  const slow = new Map(set.map((zone) => [zone.id, countElementsInZone(zone, [element], set)]));
  const pick = (counts) => [10, 30].find((id) => counts.get(id) === 1) ?? null;
  return { fast: pick(fast), slow: pick(slow) };
};
const cases = [
  ["Ригель", 0, 10], ["Плита перекрытия", 0, 10], ["Ригель", -500, 10], ["Ригель", 3000, 10], ["Ригель", 4500, 30],
  ["Колонна", 0, 10], ["Колонна", -500, 10], ["Колонна", 3000, 30],
];
for (const [type, elevation, expected] of cases)
  assert.deepEqual(stanceOf(zones(), type, elevation), { fast: expected, slow: expected }, `${type} на ${elevation}`);
for (const [type, elevation, expected] of [["Ригель", 0, null], ["Ригель", -500, null], ["Колонна", 0, 10]])
  assert.deepEqual(stanceOf(zones(3000), type, elevation), { fast: expected, slow: expected }, `явный верх: ${type} на ${elevation}`);
console.log("zone live count bottom level: 11 cases match server binding");
