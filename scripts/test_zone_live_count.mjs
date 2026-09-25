import assert from "node:assert/strict";
import { countElementsInZone } from "../app/static/v2/zone-live-count.js";

const square = (x, y, side) => [[x, y], [x + side, y], [x + side, y + side], [x, y + side]];
const elements = [
  { x: 5, y: 5, elevation_mm: 0, element_type: "Колонна" },
  { x: 15, y: 5, elevation_mm: 0, element_type: "Колонна" },
  { x: 5, y: 5, elevation_mm: 3000, element_type: "Ригель" },
  { x: 5, y: 5, elevation_mm: 3000, element_type: "Колонна" },
];
const crane = { category: "Кран", levels: [{ elevation_mm: null, outline: square(0, 0, 10) }] };
assert.equal(countElementsInZone(crane, elements), 3);
crane.levels[0].outline = square(10, 0, 10);
assert.equal(countElementsInZone(crane, elements), 1, "счёт меняется сразу после правки контура");
const stance = { category: "Стоянка", levels: [
  { elevation_mm: 0, outline: square(0, 0, 10) },
  { elevation_mm: 3000, outline: square(10, 0, 10) },
] };
assert.equal(countElementsInZone(stance, elements), 2,
  "ригель на границе относится к нижнему ярусу, колонна — к верхнему");
console.log("zone live count: 3 checks passed");
