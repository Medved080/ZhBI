// Проверка координатного контракта внешних 3D-моделей на обязательных
// численных примерах из Docs/fbx-ground-implementation-task.md §5.
// Запуск: node scripts/verify_external_model_coordinates.mjs
import {
  fbxPointToCanonical,
  sourceAnchorFromBBox,
  canonicalToProject,
  projectToZhbiView,
  projectToMfrView,
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

// bbox источника C: X=1000…5000, Y=2000…8000, Z=−500…2500 → anchor=(3000,5000,1000)
// (центр габарита по всем трём осям — только для точности запекания
// Float32, на итоговое положение не влияет, см. canonicalToProject)
const sourceBBox = { minX: 1000, maxX: 5000, minY: 2000, maxY: 8000, minZ: -500, maxZ: 2500 };
const sourceAnchor = sourceAnchorFromBBox(sourceBBox);
assertClose(sourceAnchor, [3000, 5000, 1000], "source_anchor");

// P = C + offset, БЕЗ центрирования по объекту (отменено 2026-09-11 —
// реальные FBX уже несут настоящие абсолютные координаты площадки).
// C=(1000,2000,-500), offset=0 → P=C
const p1 = canonicalToProject([1000, 2000, -500], 0, 0);
assertClose(p1, [1000, 2000, -500], "P без offset — равен C");

// offset X/Y/Z=(1500,-2000,500) → P=(2500,0,0)
const p2 = canonicalToProject([1000, 2000, -500], 1500, -2000, 500);
assertClose(p2, [2500, 0, 0], "P с offset X/Y/Z");

// ЖБИ → (2500,0,0)
assertClose(projectToZhbiView(p2), [2500, 0, -0], "адаптер ЖБИ");

// МФР origin=(1000,1500), низ=200 → (1500,-1500,-200)
assertClose(projectToMfrView(p2, [1000, 1500], 200), [1500, -1500, -200], "адаптер МФР");

// F → C: проверка на реальных числах Ground.fbx (см. Docs/backlog.md/задание §2):
// один контрольный вертекс после rotation X -90° и translation модели, взятый
// из независимой Python-проверки в этой же сессии (см. отчёт).
const c = fbxPointToCanonical(13324.807022094727, 152.8235088862422, -10707.196655084597);
assertClose(c, [13324807.022094727, 10707196.655084597, 152823.5088862422], "F→C реальная точка");

if (failures) {
  console.error(`\n${failures} проверок не прошли`);
  process.exit(1);
}
console.log("\nВсе проверки координатного контракта пройдены.");
