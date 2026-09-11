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

/** Геометрический центр габарита (все три оси) — anchor источника (мм).
 * Роль ТОЛЬКО техническая: рядом с ним запекается Float32-геометрия, чтобы
 * не терять точность на абсолютных координатах в единицы-десятки миллионов
 * мм (см. translationMatrixElements ниже). На итоговое положение модели не
 * влияет — см. canonicalToProject. */
export function sourceAnchorFromBBox(bbox) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = bbox;
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/**
 * P = C + (offset_x, offset_y, offset_z). БЕЗ центрирования по объекту
 * (отменено 2026-09-11, живой запрос пользователя — было: центрировать
 * source_anchor модели на anchor объекта; убрано, потому что реальные FBX
 * этого проекта уже несут настоящие абсолютные координаты площадки —
 * собственное центрирование по bbox их только портило, и по X/Y, и рождая
 * потребность в ручном повороте). offset по умолчанию (0,0,0) — модель
 * встаёт ровно там, где её поставил экспорт.
 */
export function canonicalToProject(c, offsetXMm, offsetYMm, offsetZMm = 0) {
  return [c[0] + offsetXMm, c[1] + offsetYMm, c[2] + offsetZMm];
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
