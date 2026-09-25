import assert from "node:assert/strict";
import { fitChildToResizedParent, fitChildrenToResizedParent } from "../app/static/v2/zone-parent-transform.js";

const parent = [[0, 0], [100, 0], [100, 100], [0, 100]];
const narrower = [[0, 0], [60, 0], [60, 100], [0, 100]];
const child = [[20, 20], [40, 20], [40, 40], [20, 40]];
assert.deepEqual(fitChildToResizedParent(parent, narrower, child),
  [[12, 20], [24, 20], [24, 40], [12, 40]]);
const moved = parent.map(([x, y]) => [x + 50, y - 10]);
assert.deepEqual(fitChildToResizedParent(parent, moved, child),
  child.map(([x, y]) => [x + 50, y - 10]));
// Старый импорт мог оставить стоянку снаружи. При следующей правке она
// втягивается внутрь родительского контура, не увеличивая новую зону.
const outside = [[90, 20], [110, 20], [110, 40], [90, 40]];
const fittedOutside = fitChildToResizedParent(parent, narrower, outside);
for (const [index, point] of fittedOutside.entries()) {
  const expected = [[48, 20], [60, 20], [60, 40], [48, 40]][index];
  assert.ok(Math.hypot(point[0] - expected[0], point[1] - expected[1]) < 1e-8);
}
assert.equal(fitChildToResizedParent([[0, 0], [0, 0], [0, 0], [0, 0]], narrower, child), null);
const adjacent = [[40, 20], [60, 20], [60, 40], [40, 40]];
const group = fitChildrenToResizedParent(parent, narrower, [child, adjacent]);
assert.equal(group[0][1][0], group[1][0][0], "смежная граница должна остаться общей");
const legacyOutside = fitChildrenToResizedParent(parent, narrower, [child, outside]);
assert.ok(Math.abs(legacyOutside[1][0][0] - legacyOutside[0][1][0] - 30) < 1e-8,
  "общий сдвиг сохраняет расстояние между стоянками");
assert.ok(legacyOutside.flat().every(([x]) => x >= 0 && x <= 60), "вся группа должна быть внутри крана");
console.log("zone parent transform: 7 checks passed");
