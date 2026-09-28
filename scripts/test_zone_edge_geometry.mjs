import assert from "node:assert/strict";
import { axisSnapPoint, completeOrthogonalOutline, displacedEdgeEndpoints, displacedZoneEdge, nearestEdgeIndex, orthogonalOutlineValid } from "../app/static/v2/zone-edge-geometry.js";

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
const project = (point) => point;
assert.equal(nearestEdgeIndex(square, 50, 5, project), 0);
assert.equal(nearestEdgeIndex(square, 3, 50, project), 3); // замыкающее ребро
assert.equal(nearestEdgeIndex(square, 50, 20, project), null);
assert.equal(nearestEdgeIndex([[0, 0], [0, 0], [100, 0]], 50, 2, project), 1);

assert.deepEqual(displacedEdgeEndpoints(square, 0, 20, 15), [[0, 15], [100, 15]]);
assert.deepEqual(displacedEdgeEndpoints(square, 3, 18, 20), [[18, 100], [18, 0]]);

const diagonal = [[10, 10], [40, 50], [0, 80]];
const [a, b] = displacedEdgeEndpoints(diagonal, 0, -10, 22);
const old = diagonal[0], oldEnd = diagonal[1];
assert.ok(Math.abs((b[0] - a[0]) - (oldEnd[0] - old[0])) < 1e-9);
assert.ok(Math.abs((b[1] - a[1]) - (oldEnd[1] - old[1])) < 1e-9);
assert.ok(Math.abs((a[0] - old[0]) * (oldEnd[0] - old[0]) + (a[1] - old[1]) * (oldEnd[1] - old[1])) < 1e-9);
assert.deepEqual(displacedEdgeEndpoints(diagonal, 0, 0, 0), [old, oldEnd]);
assert.equal(displacedEdgeEndpoints([[0, 0], [0, 0], [10, 10]], 0, 1, 1), null);

const stepped = [[0, 0], [100, 0], [100, 60], [70, 60], [70, 100], [0, 100]];
const moved = displacedZoneEdge(stepped, 0, 0, 20);
assert.deepEqual(moved.slice(0, 2), [[0, 20], [100, 20]]);
assert.deepEqual(moved.slice(2), stepped.slice(2), "остальные вершины сложной стоянки сдвинулись");
const limited = displacedZoneEdge(stepped, 0, 0, 1000);
assert.ok(limited[0][1] < 60 && limited[0][1] >= 20,
  "ребро не остановилось перед самопересечением");
assert.deepEqual(displacedZoneEdge(square, 0, 0, 20), [[0, 20], [100, 20], [100, 100], [0, 100]]);

const sloped = [[0, 0], [100, 0], [120, 70], [50, 100], [-20, 70]];
const resized = displacedZoneEdge(sloped, 0, 0, 15);
for (let i = 0; i < sloped.length; i++) {
  const before = [sloped[(i + 1) % sloped.length][0] - sloped[i][0], sloped[(i + 1) % sloped.length][1] - sloped[i][1]];
  const after = [resized[(i + 1) % resized.length][0] - resized[i][0], resized[(i + 1) % resized.length][1] - resized[i][1]];
  assert.ok(Math.abs(before[0] * after[1] - before[1] * after[0]) < 1e-7,
    `ребро ${i} изменило направление`);
}
assert.deepEqual(axisSnapPoint([0, 0], [98.5, 31]), [99, 0]);
assert.deepEqual(axisSnapPoint([100, 0], [109, 83]), [100, 83]);
assert.deepEqual(completeOrthogonalOutline([[0, 0], [100, 0], [100, 80]]), square.map((p) => [p[0], p[1] === 100 ? 80 : p[1]]));
assert.equal(orthogonalOutlineValid([[0, 0], [100, 0], [100, 80], [0, 80]], true), true);
assert.equal(orthogonalOutlineValid([[0, 0], [100, 0], [100, 80], [0, 40]], true), false);
assert.equal(orthogonalOutlineValid([[0, 0], [100, 0], [100, 80], [40, 80], [40, -20]], false), false);

console.log("zone edge geometry: polygon and rectangle checks passed");
