// Загрузка внешней FBX-модели: единицы/оси (через ограниченный ридер
// fbx-global-settings.js), парсинг вендоренным FBXLoader r160, приведение
// к каноническим координатам C (мм) с двойной точностью ДО записи в
// Float32-буферы, лимиты геометрии/текстур. THREE и FBXLoader — явные
// зависимости аргументов, глобалей не читает (см. §9 задания).
import { readFbxGlobalSettings, assertSupportedAxisProfile } from "./fbx-global-settings.js";

const DEFAULT_LIMITS = {
  maxTriangles: 2_000_000,
  maxTextureSide: 8192,
  maxTexturePixelsTotal: 128_000_000,
  textureTimeoutMs: 20_000,
};

// Синхронный parse() создаёт blob-URL для встроенных текстур внутри
// FBXLoader. Патчим URL.createObjectURL ТОЛЬКО на время этого синхронного
// вызова и сериализуем загрузки одним хвостом промисов — см. §9: не
// перекрывать с параллельной загрузкой где-то ещё в приложении.
let loadQueueTail = Promise.resolve();
function runSerialized(fn) {
  const run = loadQueueTail.then(fn, fn);
  loadQueueTail = run.catch(() => {});
  return run;
}

function parseWithTrackedBlobUrls(loader, arrayBuffer) {
  const blobUrls = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    const url = original.call(URL, blob);
    blobUrls.push(url);
    return url;
  };
  try {
    const group = loader.parse(arrayBuffer, "");
    return { group, blobUrls };
  } finally {
    URL.createObjectURL = original;
  }
}

function waitForTextures(manager, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const errors = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ errors });
    };
    manager.onLoad = finish;
    manager.onError = (url) => { errors.push(url); };
    const timer = setTimeout(finish, timeoutMs);
    manager.onLoad = () => { clearTimeout(timer); finish(); };
  });
}

const AXIS_REMAP_ELEMENTS = [
  1000, 0, 0, 0,
  0, 0, -1000, 0,
  0, 1000, 0, 0,
  0, 0, 0, 1,
];

function collectMeshes(root, THREE) {
  const meshes = [];
  root.traverse((obj) => {
    if (obj.isLight || obj.isCamera) return;
    if (obj.isMesh) meshes.push(obj);
  });
  return meshes;
}

function removeLightsAndCameras(root) {
  const toRemove = [];
  root.traverse((obj) => { if (obj !== root && (obj.isLight || obj.isCamera)) toRemove.push(obj); });
  for (const obj of toRemove) obj.parent && obj.parent.remove(obj);
}

/**
 * @param {object} opts
 * @param {ArrayBuffer} opts.arrayBuffer
 * @param {typeof import('three')} opts.THREE
 * @param {new (manager:any) => any} opts.FBXLoader
 * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]
 */
export async function loadExternalModelFbx({ arrayBuffer, THREE, FBXLoader, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const warnings = [];

  const settings = readFbxGlobalSettings(arrayBuffer.slice(0));
  assertSupportedAxisProfile(settings);

  const manager = new THREE.LoadingManager();
  const blockedExternal = [];
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    blockedExternal.push(url);
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="; // 1x1 прозрачный PNG вместо сети
  });
  const texturesDone = waitForTextures(manager, lim.textureTimeoutMs);

  const loader = new FBXLoader(manager);
  const { group: rawGroup, blobUrls } = await runSerialized(() => parseWithTrackedBlobUrls(loader, arrayBuffer));

  removeLightsAndCameras(rawGroup);
  rawGroup.updateMatrixWorld(true);

  const meshes = collectMeshes(rawGroup, THREE);
  if (!meshes.length) throw new Error("В FBX не найдено ни одного меша.");

  let triangleCount = 0;
  for (const m of meshes) {
    const geom = m.geometry;
    triangleCount += geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
  }
  if (triangleCount > lim.maxTriangles) {
    disposeThreeGroup(rawGroup);
    for (const u of blobUrls) URL.revokeObjectURL(u);
    throw new Error(`Слишком много треугольников (${Math.round(triangleCount)} > ${lim.maxTriangles}).`);
  }

  const axisRemap = new THREE.Matrix4().set(...AXIS_REMAP_ELEMENTS);
  const combinedByMesh = new Map();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const combined = new THREE.Matrix4().multiplyMatrices(axisRemap, mesh.matrixWorld);
    combinedByMesh.set(mesh, combined);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(combined);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
    disposeThreeGroup(rawGroup);
    for (const u of blobUrls) URL.revokeObjectURL(u);
    throw new Error("Не удалось вычислить конечный габарит модели (NaN/Infinity в вершинах).");
  }

  // Anchor по высоте — ВЕРХНЯЯ точка габарита (не нижняя): по умолчанию
  // благоустройство ставится верхней границей на отметку 0 объекта (живой
  // запрос пользователя 2026-09-11), а не нижней — модель уходит вниз, в
  // отрицательные локальные Z. Ручной сдвиг по высоте (offset_z_mm,
  // app/external_models.py) добавляется поверх уже на сервере/в слое, не
  // здесь.
  const sourceAnchorMm = [(minX + maxX) / 2, (minY + maxY) / 2, maxZ];
  const translateAnchor = new THREE.Matrix4().makeTranslation(-sourceAnchorMm[0], -sourceAnchorMm[1], -sourceAnchorMm[2]);

  const outGroup = new THREE.Group();
  outGroup.name = "external-model-fbx";
  const normalHelper = new THREE.Matrix3();
  for (const mesh of meshes) {
    const combinedNoAnchor = combinedByMesh.get(mesh);
    const finalMatrix = new THREE.Matrix4().multiplyMatrices(translateAnchor, combinedNoAnchor);
    normalHelper.getNormalMatrix(combinedNoAnchor);

    const srcGeom = mesh.geometry;
    const srcPos = srcGeom.attributes.position;
    const srcNormal = srcGeom.attributes.normal;
    const srcUv = srcGeom.attributes.uv;
    const count = srcPos.count;
    const outPos = new Float32Array(count * 3);
    const outNormal = srcNormal ? new Float32Array(count * 3) : null;
    const tmp = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      tmp.fromBufferAttribute(srcPos, i).applyMatrix4(finalMatrix);
      outPos[i * 3] = tmp.x; outPos[i * 3 + 1] = tmp.y; outPos[i * 3 + 2] = tmp.z;
      if (srcNormal) {
        tmpN.fromBufferAttribute(srcNormal, i).applyMatrix3(normalHelper).normalize();
        outNormal[i * 3] = tmpN.x; outNormal[i * 3 + 1] = tmpN.y; outNormal[i * 3 + 2] = tmpN.z;
      }
    }
    const outGeom = new THREE.BufferGeometry();
    outGeom.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
    if (outNormal) outGeom.setAttribute("normal", new THREE.BufferAttribute(outNormal, 3));
    if (srcUv) outGeom.setAttribute("uv", new THREE.BufferAttribute(Float32Array.from(srcUv.array), 2));
    if (srcGeom.index) outGeom.setIndex(srcGeom.index.clone());
    if (srcGeom.groups && srcGeom.groups.length) {
      for (const g of srcGeom.groups) outGeom.addGroup(g.start, g.count, g.materialIndex);
    }
    if (!outNormal) outGeom.computeVertexNormals();

    const outMesh = new THREE.Mesh(outGeom, mesh.material);
    outMesh.name = mesh.name;
    outGroup.add(outMesh);
  }

  disposeThreeGroup(rawGroup, { keepMaterials: true }); // геометрии старой иерархии больше не нужны, материалы переехали в outGroup

  const { errors: textureErrors } = await texturesDone;
  for (const url of textureErrors) warnings.push(`Не удалось загрузить текстуру: ${url}`);
  for (const url of blockedExternal) warnings.push(`Внешний путь к текстуре проигнорирован (нет доступа к сети из FBX): ${url}`);

  let textureCount = 0;
  let texturePixels = 0;
  const seenImages = new Set();
  outGroup.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of ["map", "alphaMap", "normalMap", "roughnessMap", "metalnessMap"]) {
        const tex = mat[key];
        const img = tex && tex.image;
        if (!img || seenImages.has(img)) continue;
        seenImages.add(img);
        textureCount++;
        const w = img.width || 0, h = img.height || 0;
        if (w > lim.maxTextureSide || h > lim.maxTextureSide) {
          warnings.push(`Текстура ${w}x${h} превышает предел ${lim.maxTextureSide}px по стороне.`);
        }
        texturePixels += w * h;
      }
    }
  });
  if (texturePixels > lim.maxTexturePixelsTotal) {
    warnings.push(`Суммарный объём текстур ${texturePixels}px превышает предел ${lim.maxTexturePixelsTotal}px.`);
  }

  return {
    group: outGroup,
    sourceAnchorMm,
    bboxSizeMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    meshCount: meshes.length,
    triangleCount: Math.round(triangleCount),
    textureCount,
    texturePixels,
    formatVersion: settings.formatVersion,
    mmPerUnit: settings.mmPerUnit,
    warnings,
    blobUrls,
    dispose() {
      disposeThreeGroup(outGroup);
      for (const u of blobUrls) URL.revokeObjectURL(u);
    },
  };
}

/**
 * Полная очистка группы: геометрии, материалы, все известные карты текстур.
 * keepMaterials=true — не трогать материалы (они переиспользуются в другой
 * группе), только геометрии старой иерархии.
 */
export function disposeThreeGroup(root, { keepMaterials = false } = {}) {
  const disposedMaterials = new Set();
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (!keepMaterials && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat || disposedMaterials.has(mat)) continue;
        disposedMaterials.add(mat);
        for (const key of ["map", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"]) {
          if (mat[key]) mat[key].dispose();
        }
        mat.dispose();
      }
    }
  });
  if (root.parent) root.parent.remove(root);
}
