import assert from "node:assert/strict";
import { overlapArea, peerOverlap } from "../app/static/v2/zone-overlap.js";

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const elbow = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
assert.equal(overlapArea(elbow, rect(50, 50, 90, 90)), 0, "вырез стоянки свободен");
assert.equal(overlapArea(elbow, rect(30, 30, 60, 60)), 500, "пересечение выступа посчитано целиком");
assert.equal(overlapArea(rect(30, 30, 60, 60), elbow), 500, "порядок контуров не влияет на площадь");
assert.equal(overlapArea(elbow, elbow), 6400);
const horseshoe = [[0, 0], [100, 0], [100, 100], [70, 100], [70, 30], [30, 30], [30, 100], [0, 100]];
assert.ok(Math.abs(overlapArea(horseshoe, rect(20, 60, 80, 90)) - 600) < 1e-6,
  "два раздельных участка пересечения учтены оба");
const own = { id: 1, category: "Стоянка", levels: [{ elevation_mm: 0, upper_elevation_mm: 5000, outline: elbow }] };
const peer = { id: 2, category: "Стоянка", levels: [{ elevation_mm: 3000, upper_elevation_mm: 7000, outline: rect(30, 30, 60, 60) }] };
assert.equal(peerOverlap([own, peer], own, 0, elbow)[0].area, 500,
  "пересечение разных нижних отметок обнаружено в общей полосе высоты");
peer.levels[0].elevation_mm = 5000;
assert.equal(peerOverlap([own, peer], own, 0, elbow).length, 0,
  "касающиеся по высоте полосы не пересекаются");
console.log("zone overlap: concave outlines and height bands passed");
