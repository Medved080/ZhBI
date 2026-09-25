import assert from "node:assert/strict";
import { displacedRectFace, nearestEdgeIndex } from "../app/static/v2/zone-edge-geometry.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const vector = (a, b) => [b[0] - a[0], b[1] - a[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
function checkRectangle(points) {
  assert.equal(points.length, 4);
  const sides = points.map((point, i) => vector(point, points[(i + 1) % 4]));
  assert.ok(Math.abs(dot(sides[0], sides[1])) < 1e-5);
  assert.ok(Math.abs(cross(sides[0], sides[2])) < 1e-5);
  assert.ok(Math.abs(cross(sides[1], sides[3])) < 1e-5);
  assert.ok(sides.every((side) => Math.hypot(...side) > 99));
}

const rectangle = [[0, 0], [1000, 0], [1000, 600], [0, 600]];
for (const index of [0, 1, 2, 3]) {
  const moved = displacedRectFace(rectangle, index, 170, -130);
  checkRectangle(moved);
  assert.notDeepEqual(moved, rectangle);
}
const rotated = [[100, 100], [807.106781, 807.106781], [382.842712, 1231.37085], [-324.264069, 524.264069]];
checkRectangle(displacedRectFace(rotated, 1, -200, 150));
const nearRectangle = [[0, 0.05], [1000, -0.03], [1000.02, 600], [-0.02, 600.04]];
checkRectangle(displacedRectFace(nearRectangle, 0, 0, 120));
assert.equal(displacedRectFace(rectangle, 0, 0, 100000)[0][1], 500);
assert.equal(displacedRectFace([[0, 0], [1, 0], [1, 1]], 0, 10, 0), null);
assert.equal(nearestEdgeIndex(rectangle, 0, 0, (point) => point, 9, 12), null);
assert.equal(nearestEdgeIndex(rectangle, 500, 0, (point) => point, 9, 12), 0);
console.log("PASS: сдвиг любой боковой грани сохраняет прямоугольный параллелепипед и не даёт схлопнуть его");
