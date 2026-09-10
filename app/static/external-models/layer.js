// Слой внешних 3D-моделей проекта — экземпляр на сцену (МФР и ЖБИ создают
// каждый свой). Загружает/кэширует геометрию ОДИН раз на модель и просто
// переставляет готовую группу между пересборками сцены (фильтр этажа,
// смена вкладки) — повторный разбор FBX при этом не происходит (§9
// задания). Полное освобождение ресурсов — только dispose().
//
// Зависимости — явные аргументы фабрики, глобалей не читает (§9).
import { loadExternalModelFbx } from "./fbx.js";
import { projectToMfrView, projectToZhbiView } from "./coordinates.js";

/**
 * @param {object} deps
 * @param {typeof import('three')} deps.THREE
 * @param {new (manager:any) => any} deps.FBXLoader
 * @param {(model:object) => Promise<ArrayBuffer>} deps.fetchContent
 */
export function createExternalModelLayer({ THREE, FBXLoader, fetchContent }) {
  let generation = 0;
  // modelId -> {loadPromise, result, revisionLoaded}
  const cache = new Map();

  function bump() {
    generation++;
  }

  async function ensureLoaded(model) {
    const myGeneration = generation;
    let entry = cache.get(model.id);
    if (!entry) {
      entry = {
        loadPromise: (async () => {
          const buf = await fetchContent(model);
          if (myGeneration !== generation) return null;
          return loadExternalModelFbx({ arrayBuffer: buf, THREE, FBXLoader });
        })(),
        result: null,
      };
      cache.set(model.id, entry);
      const result = await entry.loadPromise;
      // dispose() мог отмениться быстрой сменой объекта/проекта ПОКА этот
      // await висел: тогда entry уже не в cache (dispose делает bump+
      // clear), а результат — ничей. Не освободить его значит утечка
      // геометрии/текстур/blob-URL на каждое быстрое переключение.
      if (myGeneration !== generation) {
        if (result) result.dispose();
        return null;
      }
      entry.result = result;
    } else if (!entry.result) {
      entry.result = await entry.loadPromise;
    }
    return entry.result;
  }

  /** Убирает из кэша модели, которых больше нет в списке (удалены на
   * сервере) — освобождает их ресурсы. */
  function pruneMissing(currentIds) {
    const keep = new Set(currentIds);
    for (const [id, entry] of cache) {
      if (!keep.has(id)) {
        if (entry.result) entry.result.dispose();
        cache.delete(id);
      }
    }
  }

  /**
   * Добавляет актуальные модели в сцену МФР с текущим адаптером координат.
   * Не бросает исключений на отдельной модели — ошибка одной не должна
   * скрывать остальные; собирает предупреждения в возвращаемом массиве.
   */
  async function attachToMfr(scene, models, { origin, low, visible }) {
    const myGeneration = generation;
    const warnings = [];
    pruneMissing(models.map((m) => m.id));
    for (const model of models) {
      let result;
      try {
        result = await ensureLoaded(model);
      } catch (e) {
        warnings.push(`«${model.name}»: ${e.message}`);
        continue;
      }
      if (myGeneration !== generation || !result) continue; // устарело или отменено
      const px = model.object_anchor_mm.x + model.offset_mm.x;
      const py = model.object_anchor_mm.y + model.offset_mm.y;
      const v = projectToMfrView([px, py, 0], origin, low);
      result.group.position.set(v[0], v[1], v[2]);
      // Поворот — ВОКРУГ ЦЕНТРА модели (source_anchor уже центрировал
      // геометрию в 0,0 по горизонтали при разборе, см. fbx.js), поэтому
      // здесь просто поворот group на месте, без пересчёта позиции.
      // Отрицательный угол — знак ТРИ.js (против часовой при взгляде с
      // +Z) даёт видимый пользователю поворот ПО часовой при виде сверху.
      result.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -rotationRad(model));
      result.group.visible = visible;
      scene.add(result.group);
    }
    return warnings;
  }

  /** То же для сцены ЖБИ: поворот -90° вокруг X переводит канонические
   * (план-XY/Z-вверх) локальные координаты группы в мировые three.js
   * (Y-вверх) — см. Docs/fbx-ground-implementation-task.md §5, адаптер
   * ЖБИ V=(P.x,P.z,-P.y). Ручной поворот применяется ДО этого перевода —
   * вокруг локальной (канонической) вертикали модели, а не мировой Y. */
  async function attachToZhbi(scene, models, { visible }) {
    const myGeneration = generation;
    const warnings = [];
    pruneMissing(models.map((m) => m.id));
    const axisRemap = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (const model of models) {
      let result;
      try {
        result = await ensureLoaded(model);
      } catch (e) {
        warnings.push(`«${model.name}»: ${e.message}`);
        continue;
      }
      if (myGeneration !== generation || !result) continue;
      const px = model.object_anchor_mm.x + model.offset_mm.x;
      const py = model.object_anchor_mm.y + model.offset_mm.y;
      const v = projectToZhbiView([px, py, 0]);
      result.group.position.set(v[0], v[1], v[2]);
      const qRotate = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -rotationRad(model));
      result.group.quaternion.copy(axisRemap).multiply(qRotate);
      result.group.visible = visible;
      scene.add(result.group);
    }
    return warnings;
  }

  function rotationRad(model) {
    const deg = Number(model.rotation_deg) || 0;
    return (deg * Math.PI) / 180;
  }

  /** Живая группа модели, если уже разобрана — для перетаскивания мышью:
   * вызывающий код двигает её напрямую (group.position), без похода через
   * attachToMfr/attachToZhbi и сверку generation на каждый кадр указателя. */
  function getGroup(modelId) {
    return cache.get(modelId)?.result?.group || null;
  }

  /** Переключает видимость всех уже загруженных моделей БЕЗ пересборки
   * сцены и без повторного разбора FBX — используется чекбоксом слоя. */
  function setVisible(visible) {
    for (const entry of cache.values()) {
      if (entry.result) entry.result.group.visible = visible;
    }
  }

  function dispose() {
    bump(); // отменяет незавершённые загрузки — сверка myGeneration !== generation
    for (const entry of cache.values()) {
      if (entry.result) entry.result.dispose();
    }
    cache.clear();
  }

  return { attachToMfr, attachToZhbi, setVisible, getGroup, dispose, bump };
}
