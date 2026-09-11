// Проверка координатного контракта внешних 3D-моделей на обязательных
// численных примерах из Docs/fbx-ground-implementation-task.md §5.
// Запуск: node scripts/verify_external_model_coordinates.mjs
import {
  fbxPointToCanonical,
  sourceAnchorFromBBox,
  projectAnchorFromBounds,
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

// bbox источника C: X=1000…5000, Y=2000…8000, Z=−500…2500 → anchor=(3000,5000,2500)
// (anchor по Z — ВЕРХНЯЯ точка габарита, не нижняя: по умолчанию модель
// ставится верхней границей на 0 объекта, живой запрос 2026-09-11)
const sourceBBox = { minX: 1000, maxX: 5000, minY: 2000, maxY: 8000, minZ: -500, maxZ: 2500 };
const sourceAnchor = sourceAnchorFromBBox(sourceBBox);
assertClose(sourceAnchor, [3000, 5000, 2500], "source_anchor");

// bbox проекта: X=100000…140000, Y=200000…260000 → anchor=(120000,230000,0)
const projectBounds = { minX: 100000, maxX: 140000, minY: 200000, maxY: 260000 };
const projectAnchor = projectAnchorFromBounds(projectBounds);
assertClose(projectAnchor, [120000, 230000, 0], "project_anchor");

// Нижний угол C=(1000,2000,−500) → лежит на −3000 от верхней точки anchor →
// P=(118000,227000,−3000), offset=0
const p1 = canonicalToProject([1000, 2000, -500], sourceAnchor, projectAnchor, 0, 0);
assertClose(p1, [118000, 227000, -3000], "P без offset");

// offset X/Y=(1500,−2000) → P=(119500,225000,−3000)
const p2 = canonicalToProject([1000, 2000, -500], sourceAnchor, projectAnchor, 1500, -2000);
assertClose(p2, [119500, 225000, -3000], "P с offset X/Y");

// offset Z=500 (сдвиг вверх) → P.z=−2500
const p2z = canonicalToProject([1000, 2000, -500], sourceAnchor, projectAnchor, 1500, -2000, 500);
assertClose(p2z, [119500, 225000, -2500], "P с offset Z");

// Верхний угол C=(1000,2000,2500) без offset → P.z=0 (верхняя точка на 0 объекта)
const pTop = canonicalToProject([1000, 2000, 2500], sourceAnchor, projectAnchor, 0, 0);
assertClose(pTop, [118000, 227000, 0], "P верхней точки без offset — на отметке 0");

// ЖБИ → (119500,−3000,−225000)
assertClose(projectToZhbiView(p2), [119500, -3000, -225000], "адаптер ЖБИ");

// МФР origin=(110000,220000), низ=12000 → (9500,5000,−15000)
assertClose(projectToMfrView(p2, [110000, 220000], 12000), [9500, 5000, -15000], "адаптер МФР");

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
