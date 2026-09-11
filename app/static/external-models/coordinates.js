// Чистая математика координатного контракта внешних 3D-моделей проекта.
// Без зависимостей от THREE/DOM — тестируется напрямую (см.
// scripts/verify_external_model_coordinates.mjs). Единицы всюду мм, кроме
// специально помеченных случаев в комментариях.
//
// Пространства:
//   C — канонические координаты модели (X/Y план, Z вверх), уже без
//       исходной геометрии FBX, посчитаны один раз при загрузке.
//   P — абсолютные координаты проекта/объекта (мм).
//   V(ЖБИ) / V(МФР) — координаты конкретного просмотрщика.
//
// Контракт размещения (проверено против app/static/external-models/
// layer.js — там же группа THREE.js реально ставится и поворачивается,
// а не только в этой отдельной формуле, см. Docs/fbx-placement-claude-
// prompt.md §1 «не только переписанные формулы»):
//
//   P = Rz(theta) * (C - A) + B + O
//
// где A = source_anchor (центр габарита модели в C, вычислен один раз при
// разборе FBX, см. fbx.js), B = object_anchor (центр габарита ОБЪЕКТА,
// Z всегда 0), O = offset_mm (ручной сдвиг), theta = -rotation_deg*PI/180
// (минус — тот же знак, что и в layer.js:
// `quaternion.setFromAxisAngle(Z, -rotationRad(model))`, и в мышином
// повороте app.js: `newDeg = startDeg - totalAngle*180/PI`). Поворот —
// ВОКРУГ A (модель уже центрирована в 0 при запекании геометрии, см.
// fbx.js), поэтому в формуле сначала вычитается A, потом крутится, потом
// прибавляется B+O — ровно в этом порядке.

/** F (результат FBXLoader, matrixWorld применена, единицы файла) → C (мм). */
export function fbxPointToCanonical(fx, fy, fz) {
  return [1000 * fx, 1000 * -fz, 1000 * fy];
}

/** Центр горизонтальных габаритов и ВЕРХНЯЯ точка — anchor источника (мм).
 * По умолчанию модель ставится верхней границей на отметку 0 объекта. */
export function sourceAnchorFromBBox(bbox) {
  const { minX, maxX, minY, maxY, maxZ } = bbox;
  return [(minX + maxX) / 2, (minY + maxY) / 2, maxZ];
}

/** Центр горизонтальных габаритов проекта, Z всегда 0 (мм). */
export function projectAnchorFromBounds(bounds) {
  const { minX, maxX, minY, maxY } = bounds;
  return [(minX + maxX) / 2, (minY + maxY) / 2, 0];
}

/** Поворот вектора (x,y) на угол thetaRad, математическое направление
 * (против часовой при положительном theta) — общий примитив, в том числе
 * для автоматического совмещения (`auto-align.js`), поэтому экспортирован. */
export function rotateXY(thetaRad, x, y) {
  const c = Math.cos(thetaRad);
  const s = Math.sin(thetaRad);
  return [c * x - s * y, s * x + c * y];
}

/** Нормализация угла в градусах к (-180, 180] — тот же диапазон, что и
 * серверная нормализация PATCH (`app/external_models.py`:
 * `((deg + 180) % 360) - 180`, Python `%` всегда неотрицателен при
 * положительном делителе; JS-версия ниже явно приводит к тому же). */
export function normalizeRotationDeg(deg) {
  return (((deg + 180) % 360) + 360) % 360 - 180;
}

/**
 * P = Rz(theta)*(C - sourceAnchor) + projectAnchor + offset, theta по
 * умолчанию 0 (обратная совместимость мест, где поворот не нужен).
 * `rotationDeg` — то же поле, что хранится в БД (`rotation_deg`,
 * градусы по часовой стрелке на плане).
 */
export function canonicalToProject(c, sourceAnchor, projectAnchor, offsetXMm, offsetYMm, offsetZMm = 0, rotationDeg = 0) {
  const theta = (-rotationDeg * Math.PI) / 180;
  const [lx, ly] = rotateXY(theta, c[0] - sourceAnchor[0], c[1] - sourceAnchor[1]);
  const lz = c[2] - sourceAnchor[2];
  return [
    lx + projectAnchor[0] + offsetXMm,
    ly + projectAnchor[1] + offsetYMm,
    lz + projectAnchor[2] + offsetZMm,
  ];
}

/**
 * Калибровка по паре соответствующих точек «A↔A, B↔B» (Docs/
 * fbx-placement-claude-prompt.md §2): по двум точкам в C (источник, FBX)
 * и двум соответствующим точкам в P (объект) вычисляет ЕДИНЫЙ поворот
 * и перенос — устанавливаются АБСОЛЮТНО (не прибавляются к старым
 * offset/rotation_deg). Работает только в плане (X/Y); высота — отдельно,
 * см. offsetZFromPoint. `c1`/`c2`/`p1`/`p2` — [x, y] в мм.
 *
 * Контракт (см. шапку файла): P = Rz(theta)*(C - sourceAnchor) +
 * projectAnchor + offset. Точка c1 после применения offset/rotationDeg
 * обязана лечь РОВНО на p1 — это и есть смысл калибровки, а не
 * приближение.
 */
export function calibrateByPointPair(c1, c2, p1, p2, sourceAnchorXY, projectAnchorXY) {
  const u = [c2[0] - c1[0], c2[1] - c1[1]];
  const v = [p2[0] - p1[0], p2[1] - p1[1]];
  const uLen = Math.hypot(u[0], u[1]);
  const vLen = Math.hypot(v[0], v[1]);
  const cross = u[0] * v[1] - u[1] * v[0];
  const dot = u[0] * v[0] + u[1] * v[1];
  const theta = Math.atan2(cross, dot);
  const rotationDeg = normalizeRotationDeg((-theta * 180) / Math.PI);
  const [rx, ry] = rotateXY(theta, c1[0] - sourceAnchorXY[0], c1[1] - sourceAnchorXY[1]);
  const offsetXMm = p1[0] - projectAnchorXY[0] - rx;
  const offsetYMm = p1[1] - projectAnchorXY[1] - ry;
  return { theta, rotationDeg, offsetXMm, offsetYMm, uLen, vLen, lengthDiffMm: vLen - uLen, lengthRatio: uLen > 0 ? vLen / uLen : null };
}

/** Проверка калибровки третьей (контрольной) точкой, НЕ участвовавшей в
 * расчёте — c3/p3 в тех же пространствах, что у calibrateByPointPair.
 * Возвращает расчётное положение c3 после применения theta/offset и
 * невязку (мм) относительно заявленной p3. */
export function residualForPoint(c3, theta, sourceAnchorXY, projectAnchorXY, offsetXY, p3) {
  const [rx, ry] = rotateXY(theta, c3[0] - sourceAnchorXY[0], c3[1] - sourceAnchorXY[1]);
  const px = rx + projectAnchorXY[0] + offsetXY[0];
  const py = ry + projectAnchorXY[1] + offsetXY[1];
  const dx = px - p3[0];
  const dy = py - p3[1];
  return { px, py, dx, dy, distanceMm: Math.hypot(dx, dy) };
}

/** Сдвиг по высоте по одной известной точке/отметке (Docs/
 * fbx-placement-claude-prompt.md §4): для точки FBX с координатой cZ (в
 * C) и требуемой отметки объекта pZ (в P; при текущем projectAnchor.z=0
 * это просто целевая абсолютная высота) возвращает offset_z_mm. */
export function offsetZFromPoint(cZ, pZ, sourceAnchorZ) {
  return pZ - (cZ - sourceAnchorZ);
}

/**
 * Переносит УЖЕ посчитанную привязку модели i (тот же theta, откуда бы он
 * ни взялся) на модель j — для случая общего/согласованного источника
 * координат между двумя FBX одного объекта (Docs/fbx-placement-claude-
 * prompt.md §4). Смысл: обе модели после переноса подчиняются одному и
 * тому же P = R*C + t — то есть остаются взаимно согласованными, даже
 * если у них РАЗНЫЕ sourceAnchor/projectAnchor (разные bbox-центры,
 * разные Z-anchor у ground/facade).
 */
export function transferPlacementXY(theta, sourceAnchorXY_i, projectAnchorXY_i, offsetXY_i, sourceAnchorXY_j, projectAnchorXY_j) {
  const [raix, raiy] = rotateXY(theta, sourceAnchorXY_i[0], sourceAnchorXY_i[1]);
  const tx = projectAnchorXY_i[0] + offsetXY_i[0] - raix;
  const ty = projectAnchorXY_i[1] + offsetXY_i[1] - raiy;
  const [rajx, rajy] = rotateXY(theta, sourceAnchorXY_j[0], sourceAnchorXY_j[1]);
  return [tx + rajx - projectAnchorXY_j[0], ty + rajy - projectAnchorXY_j[1]];
}

/** То же для Z (перенос высоты — независимая операция, только при общей
 * вертикальной системе исходников, см. задание §4). */
export function transferPlacementZ(offsetZ_i, sourceAnchorZ_i, sourceAnchorZ_j) {
  return offsetZ_i - sourceAnchorZ_i + sourceAnchorZ_j;
}

/**
 * Переводит НАЙДЕННОЕ глобальное преобразование плана P.xy = Rz(theta)*C.xy
 * + t.xy (например, результат автоматического совмещения, Docs/
 * fbx-auto-placement-claude-prompt.md §«Применение...») в поля offset/
 * rotation_deg контракта P = Rz(theta)*(C-A) + B + O:
 *
 *   rotation_deg = normalize(-theta * 180/PI)
 *   O.xy = t.xy + Rz(theta)*A.xy - B.xy
 *
 * Ровно формула из задания — НЕ пересчитывай/не выводи её заново в другом
 * месте, здесь единственная реализация.
 */
export function placementFromGlobalTransform(theta, tXY, sourceAnchorXY, projectAnchorXY) {
  const [rax, ray] = rotateXY(theta, sourceAnchorXY[0], sourceAnchorXY[1]);
  return {
    rotationDeg: normalizeRotationDeg((-theta * 180) / Math.PI),
    offsetXMm: tXY[0] + rax - projectAnchorXY[0],
    offsetYMm: tXY[1] + ray - projectAnchorXY[1],
  };
}

/** Адаптер ЖБИ: V = (P.x, P.z, -P.y). */
export function projectToZhbiView(p) {
  return [p[0], p[2], -p[1]];
}

/** Обратный адаптер ЖБИ: P = (V.x, -V.z, V.y) — восстановление P по точке,
 * взятой raycast'ом в сцене ЖБИ (Docs/fbx-placement-claude-prompt.md §3). */
export function zhbiViewToProject(v) {
  return [v[0], -v[2], v[1]];
}

/** Адаптер МФР: V = (P.x - origin[0], P.y - origin[1], P.z - низ). */
export function projectToMfrView(p, origin, низ) {
  return [p[0] - origin[0], p[1] - origin[1], p[2] - низ];
}

/** Обратный адаптер МФР: P = (V.x + origin.x, V.y + origin.y, V.z + низ). */
export function mfrViewToProject(v, origin, низ) {
  return [v[0] + origin[0], v[1] + origin[1], v[2] + низ];
}

/**
 * Собирает 4x4 матрицу переноса (row-major массив длины 16, THREE.Matrix4
 * ожидает set(...) в этом порядке) из готовой трансляции — используется,
 * чтобы вычесть anchor в double ДО записи Float32-буферов геометрии (см.
 * §5: "не запекать в Float32 огромную абсолютную трансляцию").
 */
export function translationMatrixElements(tx, ty, tz) {
  return [
    1, 0, 0, tx,
    0, 1, 0, ty,
    0, 0, 1, tz,
    0, 0, 0, 1,
  ];
}
