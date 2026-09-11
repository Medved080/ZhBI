// Проверка координатного контракта внешних 3D-моделей: перенос+поворот,
// калибровка по паре точек, адаптеры, и — отдельно — эквивалентность этих
// формул РЕАЛЬНОМУ применению group.position/quaternion в THREE.js (не
// только переписанные формулы, см. Docs/fbx-placement-claude-prompt.md §6).
// Запуск: node scripts/verify_external_model_coordinates.mjs
import * as THREE from "../app/static/vendor/three/three.module.min.js";
import {
  fbxPointToCanonical,
  sourceAnchorFromBBox,
  projectAnchorFromBounds,
  canonicalToProject,
  calibrateByPointPair,
  residualForPoint,
  offsetZFromPoint,
  transferPlacementXY,
  transferPlacementZ,
  normalizeRotationDeg,
  projectToZhbiView,
  zhbiViewToProject,
  projectToMfrView,
  mfrViewToProject,
} from "../app/static/external-models/coordinates.js";

let failures = 0;
function assertClose(actual, expected, label, eps = 1e-6) {
  const a = Array.isArray(actual) ? actual : [actual];
  const e = Array.isArray(expected) ? expected : [expected];
  for (let i = 0; i < e.length; i++) {
    if (Math.abs(a[i] - e[i]) > eps) {
      failures++;
      console.error(`FAIL ${label}: получено ${a}, ожидалось ${e}`);
      return;
    }
  }
  console.log(`ok   ${label}`);
}
function assertTrue(cond, label) {
  if (!cond) { failures++; console.error(`FAIL ${label}`); return; }
  console.log(`ok   ${label}`);
}

// ==================== 1. Базовый перенос (без поворота, обратная совместимость) ====================

const sourceBBox = { minX: 1000, maxX: 5000, minY: 2000, maxY: 8000, minZ: -500, maxZ: 2500 };
const sourceAnchor = sourceAnchorFromBBox(sourceBBox);
assertClose(sourceAnchor, [3000, 5000, 2500], "source_anchor (верх габарита)");

const projectBounds = { minX: 100000, maxX: 140000, minY: 200000, maxY: 260000 };
const projectAnchor = projectAnchorFromBounds(projectBounds);
assertClose(projectAnchor, [120000, 230000, 0], "project_anchor");

const p1basic = canonicalToProject([1000, 2000, -500], sourceAnchor, projectAnchor, 0, 0);
assertClose(p1basic, [118000, 227000, -3000], "P без offset/поворота");

const p2basic = canonicalToProject([1000, 2000, -500], sourceAnchor, projectAnchor, 1500, -2000, 500);
assertClose(p2basic, [119500, 225000, -2500], "P с offset X/Y/Z, поворот 0");

// ==================== 2. Контрольный численный пример калибровки (Docs/fbx-placement-claude-prompt.md §6) ====================

const A = [13280000, 10660000];
const Az = 150000;
const B = [120000, 230000];
const c1 = [13281000, 10662000];
const c2 = [13291000, 10662000];
const p1 = [100000, 200000];
const p2 = [108660.25403784439, 205000];

const calib = calibrateByPointPair(c1, c2, p1, p2, A, B);
assertClose(calib.rotationDeg, -30, "калибровка: rotation_deg = -30°", 1e-9);
assertClose(calib.theta, Math.PI / 6, "калибровка: theta = +30° (рад)", 1e-12);
assertClose([calib.offsetXMm, calib.offsetYMm], [-19866.02540378444, -32232.050807568878], "калибровка: offset X/Y", 1e-6);
assertClose(calib.uLen, 10000, "калибровка: |u|");
assertClose(calib.vLen, 10000, "калибровка: |v| (совпадает — контрольный пример без растяжения)");

// Точка c1 после применения посчитанного offset/rotation обязана лечь РОВНО на p1 (не приблизительно).
const c1Applied = canonicalToProject([c1[0], c1[1], 0], [A[0], A[1], 0], [B[0], B[1], 0], calib.offsetXMm, calib.offsetYMm, 0, calib.rotationDeg);
assertClose([c1Applied[0], c1Applied[1]], p1, "калибровка: c1 → p1 точно");
const c2Applied = canonicalToProject([c2[0], c2[1], 0], [A[0], A[1], 0], [B[0], B[1], 0], calib.offsetXMm, calib.offsetYMm, 0, calib.rotationDeg);
assertClose([c2Applied[0], c2Applied[1]], p2, "калибровка: c2 → p2 точно");

// Третья (контрольная) точка — из задания.
const c3 = [13284000, 10669000];
const expectedP3 = [99098.07621135331, 207562.17782649107];
const residual = residualForPoint(c3, calib.theta, A, B, [calib.offsetXMm, calib.offsetYMm], expectedP3);
assertClose([residual.px, residual.py], expectedP3, "контрольная точка c3 → P(c3)");
assertClose(residual.distanceMm, 0, "невязка контрольной точки ≈ 0 (синтетика без ошибок)", 1e-6);

// ==================== 3. Оба знака поворота, переход через ±180° ====================

// Отрицательный theta (поворот по часовой в математическом смысле) — u повёрнут в v на -30°.
{
  const u = [10000, 0];
  const thetaNeg = -Math.PI / 6;
  const v = [Math.cos(thetaNeg) * u[0] - Math.sin(thetaNeg) * u[1], Math.sin(thetaNeg) * u[0] + Math.cos(thetaNeg) * u[1]];
  const c1n = [0, 0], c2n = [u[0], u[1]], p1n = [0, 0], p2n = [v[0], v[1]];
  const calibNeg = calibrateByPointPair(c1n, c2n, p1n, p2n, [0, 0], [0, 0]);
  assertClose(calibNeg.theta, thetaNeg, "калибровка: отрицательный theta");
  assertClose(calibNeg.rotationDeg, 30, "калибровка: соответствующий rotation_deg = +30°", 1e-9);
}

assertClose(normalizeRotationDeg(180), -180, "normalizeRotationDeg(180) = -180 (полуоткрытый диапазон)");
assertClose(normalizeRotationDeg(-180), -180, "normalizeRotationDeg(-180) = -180");
assertClose(normalizeRotationDeg(190), -170, "normalizeRotationDeg(190) = -170 (переход через 180°)");
assertClose(normalizeRotationDeg(-190), 170, "normalizeRotationDeg(-190) = 170 (переход через -180°)");
assertClose(normalizeRotationDeg(0), 0, "normalizeRotationDeg(0) = 0");
assertClose(normalizeRotationDeg(360), 0, "normalizeRotationDeg(360) = 0 (полный оборот)");

// ==================== 4. Вырожденные/некорректные случаи — калибровка не падает, но флагом сообщает вызывающему ====================

{
  const calibSame = calibrateByPointPair([100, 100], [100, 100], [0, 0], [50, 50], [0, 0], [0, 0]);
  assertTrue(calibSame.uLen === 0, "совпавшие точки источника: uLen=0 (вызывающий обязан отклонить ДО применения)");
}
{
  const calibSameP = calibrateByPointPair([0, 0], [100, 0], [10, 10], [10, 10], [0, 0], [0, 0]);
  assertTrue(calibSameP.vLen === 0, "совпавшие точки объекта: vLen=0 (вызывающий обязан отклонить)");
}

// ==================== 5. Несовпадение расстояний (|u| ≠ |v|) — калибровка считает, но сообщает разницу ====================

{
  const calibStretch = calibrateByPointPair([0, 0], [10000, 0], [0, 0], [10500, 0], [0, 0], [0, 0]);
  assertClose(calibStretch.uLen, 10000, "несовпадение расстояний: |u|");
  assertClose(calibStretch.vLen, 10500, "несовпадение расстояний: |v|");
  assertClose(calibStretch.lengthDiffMm, 500, "несовпадение расстояний: разница, мм");
  assertClose(calibStretch.lengthRatio, 1.05, "несовпадение расстояний: отношение", 1e-9);
}

// ==================== 6. Третья точка у ОТРАЖЁННОГО треугольника — невязка должна быть большой (обнаружение зеркалирования) ====================

{
  // A'=(0,0), B'=(10000,0) без поворота; третья точка C' в источнике на
  // (5000,5000), а в объекте — ОТРАЖЁННАЯ, на (5000,-5000): чистый поворот
  // такое совместить не может, невязка должна быть заметной (не ≈0).
  const calibMirror = calibrateByPointPair([0, 0], [10000, 0], [0, 0], [10000, 0], [0, 0], [0, 0]);
  const res = residualForPoint([5000, 5000], calibMirror.theta, [0, 0], [0, 0], [calibMirror.offsetXMm, calibMirror.offsetYMm], [5000, -5000]);
  assertTrue(res.distanceMm > 1000, `отражённая контрольная точка: невязка большая (${res.distanceMm.toFixed(1)} мм) — зеркалирование обнаружено`);
}

// ==================== 7. Перенос привязки на второй файл (общий источник координат) ====================

{
  // Модель i: своя sourceAnchor/projectAnchor, уже откалибрована (theta, offset).
  const sourceAnchorXY_i = [13280000, 10660000];
  const projectAnchorXY_i = [120000, 230000];
  const offsetXY_i = [calib.offsetXMm, calib.offsetYMm];
  const theta = calib.theta;
  // Модель j: ДРУГОЙ bbox-центр (другой файл того же здания — например,
  // facade вместо ground), другой object_anchor (другая привязка к
  // объекту на момент загрузки).
  const sourceAnchorXY_j = [13265000, 10650000];
  const projectAnchorXY_j = [121000, 229000];
  const [offsetXMm_j, offsetYMm_j] = transferPlacementXY(theta, sourceAnchorXY_i, projectAnchorXY_i, offsetXY_i, sourceAnchorXY_j, projectAnchorXY_j);
  // Если обе модели изначально построены в ОДНОЙ системе C (то есть точка
  // c1 в системе i и её "аналог" в системе j физически совпадают),
  // результат применения P_i(c1) и P_j(тот же самый мировой C-эквивалент)
  // обязан совпасть. Проверяем через общий мировой сдвиг t:
  // P = Rz(theta)*C + t для обеих моделей с посчитанными offset.
  const c1_j = [c1[0] + (sourceAnchorXY_j[0] - sourceAnchorXY_i[0]) * 0, c1[1]]; // тот же мировой C, что и c1 у модели i
  const cRaw = [c1[0], c1[1]];
  const Pi = canonicalToProject([cRaw[0], cRaw[1], 0], [sourceAnchorXY_i[0], sourceAnchorXY_i[1], 0], [projectAnchorXY_i[0], projectAnchorXY_i[1], 0], offsetXY_i[0], offsetXY_i[1], 0, calib.rotationDeg);
  const Pj = canonicalToProject([cRaw[0], cRaw[1], 0], [sourceAnchorXY_j[0], sourceAnchorXY_j[1], 0], [projectAnchorXY_j[0], projectAnchorXY_j[1], 0], offsetXMm_j, offsetYMm_j, 0, calib.rotationDeg);
  assertClose([Pi[0], Pi[1]], [Pj[0], Pj[1]], "перенос привязки: тот же мировой C даёт тот же P у обеих моделей", 1e-6);

  const offsetZMm_j = transferPlacementZ(500, Az, 140000);
  assertClose(offsetZMm_j, 500 - Az + 140000, "перенос привязки по Z");
}

// ==================== 8. Повторная калибровка уже повёрнутой модели ====================

{
  // Калибровка — АБСОЛЮТНАЯ (не зависит от предыдущего theta/offset):
  // два независимых запроса с разными парами точек дают каждый раз
  // самостоятельно верный результат, без накопления от "предыдущего" угла.
  const first = calibrateByPointPair([0, 0], [1000, 0], [0, 0], [0, 1000], [0, 0], [0, 0]); // 90°
  assertClose(first.rotationDeg, -90, "повторная калибровка: первый заход 90°→rotation_deg=-90", 1e-9);
  const second = calibrateByPointPair([0, 0], [1000, 0], [0, 0], [1000, 0], [0, 0], [0, 0]); // 0°, НЕ 90+0
  assertClose(second.rotationDeg, 0, "повторная калибровка: второй заход независим от первого (0°)", 1e-9);
}

// ==================== 9. Смещение по Z по известной точке ====================

assertClose(offsetZFromPoint(2500, 0, 2500), 0, "offsetZFromPoint: точка на anchor, целевая отметка 0");
assertClose(offsetZFromPoint(2500, 1000, 2500), 1000, "offsetZFromPoint: целевая отметка 1000");
assertClose(offsetZFromPoint(0, 1000, 2500), 3500, "offsetZFromPoint: точка ниже anchor на 2500");

// ==================== 10. Адаптеры ЖБИ/МФР — прямой и обратный, разные origin/low ====================

{
  const pFull = [119500, 225000, -2500]; // P с offset (см. п.1)
  const vZhbi = projectToZhbiView(pFull);
  assertClose(vZhbi, [119500, -2500, -225000], "адаптер ЖБИ (прямой)");
  assertClose(zhbiViewToProject(vZhbi), pFull, "адаптер ЖБИ (обратный) — round-trip");

  const origin = [110000, 220000];
  const низ = 12000;
  const vMfr = projectToMfrView(pFull, origin, низ);
  assertClose(vMfr, [9500, 5000, -14500], "адаптер МФР (прямой)");
  assertClose(mfrViewToProject(vMfr, origin, низ), pFull, "адаптер МФР (обратный) — round-trip");

  // Другой origin/low — тот же P, другая V.
  const vMfr2 = projectToMfrView(pFull, [0, 0], 0);
  assertClose(vMfr2, pFull, "адаптер МФР с origin=0,low=0 — V=P");
}

// ==================== 11. Большие C-координаты (единицы-десятки миллионов мм) ====================

{
  const bigA = [13280000, 10660000, 150000];
  const bigB = [120000, 230000, 0];
  const bigC = [13280500, 10660300, 150200];
  const P = canonicalToProject(bigC, bigA, bigB, 0, 0, 0, 15);
  // Проверка точности: обратное применение (поворот на -rotation_deg, тот
  // же A/B) обязано вернуть исходную C с точностью до плавающей точки.
  const back = canonicalToProject(P, bigB, bigA, 0, 0, 0, -15);
  // canonicalToProject(P, B, A, 0,0,0, -rot) считает Rz(rot)*(P-B)+A — это
  // ТОЧНО обратное преобразование при том же |rotation_deg|, что и прямое.
  assertClose(back, bigC, "большие координаты: точность round-trip", 1e-6);
}

// ==================== 12. Эквивалентность РЕАЛЬНОМУ THREE.js (group.position/quaternion) ====================
// Не только пересчитанные формулы — тот же путь, что и в layer.js:
// attachToMfr/attachToZhbi ставят group.position и group.quaternion,
// геометрия при этом хранит C - sourceAnchor (запечено в fbx.js). Здесь
// эмулируем вершину как THREE.Vector3(C - sourceAnchor) и применяем её
// через group.matrixWorld — как это делает сам рендер.

function threeApply(localVec3, position, quaternion) {
  const group = new THREE.Group();
  group.position.set(position[0], position[1], position[2]);
  group.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  group.updateMatrixWorld(true);
  const world = localVec3.clone().applyMatrix4(group.matrixWorld);
  return [world.x, world.y, world.z];
}

{
  // --- МФР: position = projectToMfrView(B+O, origin, low), quaternion = AxisAngle(Z, -rotationRad) ---
  const A3 = [13280000, 10660000, 150000];
  const B3 = [120000, 230000, 0];
  const offset = [1500, -2000, 300];
  const rotationDeg = 37.25;
  const origin = [110000, 220000];
  const низ = 12000;
  const C = [13282000, 10661500, 150800]; // произвольная точка модели

  const expectedP = canonicalToProject(C, A3, B3, offset[0], offset[1], offset[2], rotationDeg);
  const expectedVMfr = projectToMfrView(expectedP, origin, низ);

  const positionMfr = projectToMfrView([B3[0] + offset[0], B3[1] + offset[1], B3[2] + offset[2]], origin, низ);
  const quatMfr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-rotationDeg * Math.PI) / 180);
  const localVec = new THREE.Vector3(C[0] - A3[0], C[1] - A3[1], C[2] - A3[2]);
  const gotVMfr = threeApply(localVec, positionMfr, quatMfr);
  assertClose(gotVMfr, expectedVMfr, "эквивалентность THREE.js (МФР): group.matrixWorld = формула", 1e-6);

  // --- ЖБИ: position = projectToZhbiView(B+O), quaternion = axisRemap(-90° X) * AxisAngle(Z, -rotationRad) ---
  const expectedVZhbi = projectToZhbiView(expectedP);
  const positionZhbi = projectToZhbiView([B3[0] + offset[0], B3[1] + offset[1], B3[2] + offset[2]]);
  const axisRemap = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const qRotate = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-rotationDeg * Math.PI) / 180);
  const quatZhbi = axisRemap.clone().multiply(qRotate);
  const gotVZhbi = threeApply(localVec, positionZhbi, quatZhbi);
  assertClose(gotVZhbi, expectedVZhbi, "эквивалентность THREE.js (ЖБИ): group.matrixWorld = формула", 1e-6);
}

// ==================== 13. F → C: реальные числа Ground.fbx ====================

const c = fbxPointToCanonical(13324.807022094727, 152.8235088862422, -10707.196655084597);
assertClose(c, [13324807.022094727, 10707196.655084597, 152823.5088862422], "F→C реальная точка");

if (failures) {
  console.error(`\n${failures} проверок не прошли`);
  process.exit(1);
}
console.log("\nВсе проверки координатного контракта пройдены.");
