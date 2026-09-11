// Чистая математика координатного контракта внешних 3D-моделей проекта.
// Без зависимостей от THREE/DOM — тестируется напрямую (см.
// scripts/verify_external_model_coordinates.mjs). Единицы всюду мм, кроме
// специально помеченных случаев в комментариях. Формулы и обязательные
// численные примеры — Docs/fbx-ground-implementation-task.md §5.
//
// Пространства:
//   C — канонические координаты модели (X/Y план, Z вверх), уже без
//       исходной геометрии FBX, посчитаны один раз при загрузке.
//   P — абсолютные координаты проекта (мм).
//   V(ЖБИ) / V(МФР) — координаты конкретного просмотрщика.

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

/**
 * P = (C - source_anchor) + project_anchor + (offset_x, offset_y, offset_z).
 * anchors и offset — обычные числовые тройки/пары в мм. offset_z по
 * умолчанию 0 — тогда верхняя точка габарита (source_anchor.z) стоит
 * ровно на project_anchor.z (всегда 0, см. projectAnchorFromBounds).
 */
export function canonicalToProject(c, sourceAnchor, projectAnchor, offsetXMm, offsetYMm, offsetZMm = 0) {
  const lx = c[0] - sourceAnchor[0];
  const ly = c[1] - sourceAnchor[1];
  const lz = c[2] - sourceAnchor[2];
  return [
    lx + projectAnchor[0] + offsetXMm,
    ly + projectAnchor[1] + offsetYMm,
    lz + projectAnchor[2] + offsetZMm,
  ];
}

/** Адаптер ЖБИ: V = (P.x, P.z, -P.y). */
export function projectToZhbiView(p) {
  return [p[0], p[2], -p[1]];
}

/** Адаптер МФР: V = (P.x - origin[0], P.y - origin[1], P.z - низ). */
export function projectToMfrView(p, origin, низ) {
  return [p[0] - origin[0], p[1] - origin[1], p[2] - низ];
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
