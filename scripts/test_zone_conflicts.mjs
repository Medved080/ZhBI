// Поиск конфликтов стоянок для красной штриховки редактора: любые стоянки и ярусы, общая высотная полоса,
// наложение по площади; касание и разнесённые по высоте ярусы конфликтом не считаются.
import assert from "node:assert/strict";
import { zoneConflicts } from "../app/static/v2/zone-overlap.js";

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const stance = (id, crane, levels) => ({ id, category: "Стоянка", parent_zone_id: crane, levels });
const level = (elevation_mm, outline, upper_elevation_mm = null) => ({ elevation_mm, upper_elevation_mm, outline });
const area = (list) => list.reduce((sum, item) => sum + item.area, 0);

// Разные краны, один ярус, наложение 10×100.
let result = zoneConflicts([
  { id: 10, category: "Кран", levels: [] },
  stance(1, 10, [level(0, rect(0, 0, 100, 100))]),
  stance(2, 20, [level(0, rect(90, 0, 200, 100))]),
]);
assert.equal(result.length, 1);
assert.equal(result[0].area, 1000);
assert.deepEqual([result[0].a.zone_id, result[0].b.zone_id], [1, 2]);
assert.deepEqual([result[0].lower, result[0].upper], [0, Infinity]);

// Касание границ — не конфликт.
assert.equal(zoneConflicts([stance(1, 10, [level(0, rect(0, 0, 100, 100))]),
  stance(2, 20, [level(0, rect(100, 0, 200, 100))])]).length, 0);

// Один кран: две его стоянки на одном ярусе тоже конфликтуют.
assert.equal(zoneConflicts([stance(1, 10, [level(0, rect(0, 0, 100, 100))]),
  stance(2, 10, [level(0, rect(50, 0, 150, 100))])]).length, 1);

// Разнесённые по высоте ярусы не конфликтуют: 0–3000 и 3000–∞ (следующая отметка объекта).
assert.equal(zoneConflicts([stance(1, 10, [level(0, rect(0, 0, 100, 100))]),
  stance(2, 20, [level(3000, rect(0, 0, 100, 100))])]).length, 0);

// Явная верхняя отметка 5000 выше чужой нижней 3000 — полосы пересекаются, конфликт в полосе 3000–5000.
result = zoneConflicts([stance(1, 10, [level(0, rect(0, 0, 100, 100), 5000)]),
  stance(2, 20, [level(3000, rect(0, 0, 100, 100))])]);
assert.equal(result.length, 1);
assert.deepEqual([result[0].lower, result[0].upper], [3000, 5000]);

// Ярусы одной стоянки с перекрытием по высоте — тоже конфликт.
result = zoneConflicts([stance(1, 10, [level(0, rect(0, 0, 100, 100), 6000), level(3000, rect(0, 0, 100, 100))])]);
assert.equal(result.length, 1);
assert.deepEqual([result[0].a.level_index, result[0].b.level_index], [0, 1]);

// Невыпуклый контур: вырез свободен, выступ считается целиком.
const elbow = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
assert.equal(zoneConflicts([stance(1, 10, [level(0, elbow)]), stance(2, 20, [level(0, rect(50, 50, 90, 90))])]).length, 0);
result = zoneConflicts([stance(1, 10, [level(0, elbow)]), stance(2, 20, [level(0, rect(30, 30, 60, 60))])]);
assert.equal(Math.round(area(result)), 500);

// Ярусы без отметки или без контура пропускаются.
assert.equal(zoneConflicts([stance(1, 10, [level(null, rect(0, 0, 100, 100))]),
  stance(2, 20, [level(0, rect(0, 0, 100, 100))]), stance(3, 20, [level(0, [])])]).length, 0);
console.log("zone conflicts: cranes, touching, height bands, concave outlines passed");
