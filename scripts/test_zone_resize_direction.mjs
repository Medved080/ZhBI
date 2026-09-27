import assert from "node:assert/strict";
import { edgeResizeAngle, edgeResizeCursor } from "../app/static/v2/zone-resize-direction.js";

const outline = [[0, 0], [100, 0], [100, 50], [0, 50]];
const degrees = (radians) => radians * 180 / Math.PI;
const identity = (point) => point;
assert.ok(Math.abs(degrees(edgeResizeAngle(outline, 0, identity)) - 90) < .01);
assert.ok(Math.abs(Math.abs(degrees(edgeResizeAngle(outline, 1, identity))) - 180) < .01);
const foreshortened = ([x, y]) => [x + y * .3, y * .4];
assert.ok(Math.abs(degrees(edgeResizeAngle(outline, 0, foreshortened)) - 53.13) < .1);
assert.notEqual(edgeResizeCursor(edgeResizeAngle(outline, 0, identity)),
  edgeResizeCursor(edgeResizeAngle(outline, 1, identity)));
console.log("PASS: направление стрелок следует проекции нормали грани");
