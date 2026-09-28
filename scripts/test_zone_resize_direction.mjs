import assert from "node:assert/strict";
import { edgeResizeAngle, edgeResizeCursor, edgeResizeHandles } from "../app/static/v2/zone-resize-direction.js";

const outline = [[0, 0], [100, 0], [100, 50], [0, 50]];
const degrees = (radians) => radians * 180 / Math.PI;
const identity = (point) => point;
assert.ok(Math.abs(degrees(edgeResizeAngle(outline, 0, identity)) - 90) < .01);
assert.ok(Math.abs(Math.abs(degrees(edgeResizeAngle(outline, 1, identity))) - 180) < .01);
const foreshortened = ([x, y]) => [x + y * .3, y * .4];
assert.ok(Math.abs(degrees(edgeResizeAngle(outline, 0, foreshortened)) - 53.13) < .1);
assert.notEqual(edgeResizeCursor(edgeResizeAngle(outline, 0, identity)),
  edgeResizeCursor(edgeResizeAngle(outline, 1, identity)));
const stepped = [[20, 20], [160, 20], [160, 80], [110, 80], [110, 85], [105, 85], [105, 130], [20, 130]];
const handles = edgeResizeHandles(stepped, identity, 200, 170);
assert.equal(handles.length, stepped.length, "у короткого ребра пропала ручка");
assert.ok(handles.every((handle) => handle.x >= 14 && handle.x <= 186 && handle.y >= 14 && handle.y <= 156));
assert.ok(handles.some((handle) => handle.length < 28 && Math.hypot(handle.x - handle.anchorX, handle.y - handle.anchorY) > 4),
  "ручка короткого ребра не вынесена от контура");
assert.ok(handles.every((handle, index) => handles.every((other, otherIndex) => index === otherIndex ||
  Math.hypot(handle.x - other.x, handle.y - other.y) >= 24)), "ручки закрывают друг друга");
console.log("PASS: направление стрелок следует проекции нормали грани");
