// 3D-предпросмотр зоны в форме правки зоны (перенос V1: app.js, zonePreview3d / rebuildZonePreview3d, решение З13).
// Те же данные, что у 2D-предпросмотра (`GET /zones/{id}/geometry` + правимые ярусы формы), то же построение:
// подложка габаритов объекта, соседние зоны той же категории — контурами, кран-владелец — красным контуром,
// правимые ярусы — объёмом от отметки до следующего яруса, номера точек — только у активного яруса.
// Координаты: world.X = dxf.x, world.Z = −dxf.y (как в основной сцене V1). Кадр рисуется только по требованию.
// Three.js — вендоренный (importmap "three" в v2/index.html), грузится лениво при первом включении 3D.
// Ничего не пишет на сервер.

const PREVIEW_PLANE_GAP_MM = 60;   // зазор между соприкасающимися плоскостями (иначе мерцание в буфере глубины)
const W = 400, H = 300;

let libs = null;
async function loadLibs() {
  if (!libs) {
    libs = Promise.all([import("three"), import("/static/vendor/three/OrbitControls.js")])
      .then(([THREE, oc]) => ({ THREE, OrbitControls: oc.OrbitControls }))
      .catch((e) => { libs = null; throw e; });
  }
  return libs;
}

// Цвет фона — из вычисленного фона контейнера (токен --surface текущей гаммы V2), запасной — светлый, как в V1.
function hostColor(host) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(host).backgroundColor || "");
  return m ? (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]) : 0xf4f6f8;
}

export function createZonePreview3d() {
  let r = null;          // { THREE, renderer, scene, camera, controls, group }
  let framed = false;    // камера ставится один раз на открытие формы
  let frame = null;
  let disposed = false;
  let lastData = null;

  function requestFrame() {
    if (!r || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; if (r) r.renderer.render(r.scene, r.camera); });
  }

  async function ensure(host) {
    if (r) { if (r.renderer.domElement.parentNode !== host) host.appendChild(r.renderer.domElement); return r; }
    const { THREE, OrbitControls } = await loadLibs();
    if (disposed) return null;
    if (r) { if (r.renderer.domElement.parentNode !== host) host.appendChild(r.renderer.domElement); return r; }
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(W, H);
    renderer.setClearColor(hostColor(host), 1);
    renderer.domElement.setAttribute("aria-label", "3D-предпросмотр зоны: вращение — перетаскивание мышью, масштаб — колесо");
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 100, 5_000_000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;   // кадр по требованию: без инерции камера не едет после отпускания мыши
    controls.addEventListener("change", requestFrame);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(1, 2, 1);
    scene.add(dir);
    r = { THREE, renderer, scene, camera, controls, group: null };
    return r;
  }

  function numberSprite(THREE, text, active, screenSize) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = active ? "#d68910" : "#2471a3";
    ctx.beginPath(); ctx.arc(32, 32, active ? 30 : 24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${active ? 34 : 28}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false, sizeAttenuation: false }));
    sprite.scale.set(screenSize, screenSize, 1);
    return sprite;
  }

  function disposeGroup() {
    if (!r?.group) return;
    r.scene.remove(r.group);
    r.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    r.group = null;
  }

  // data: { bbox, siblings, parent, levels, activeLevel, activePoint }
  function rebuild(data) {
    lastData = data;
    if (!r) return;
    const { THREE } = r;
    disposeGroup();
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;   // локальный +Z → мировой «вверх», локальный +Y → мировой −Z
    const bbox = data.bbox;
    if (bbox) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(bbox[2] - bbox[0], bbox[3] - bbox[1]),
        new THREE.MeshBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.12, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }));
      plate.position.set((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, -PREVIEW_PLANE_GAP_MM);
      group.add(plate);
    }
    for (const sib of data.siblings || []) {
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sib.outline.map((p) => new THREE.Vector3(p[0], p[1], (sib.elevation_mm || 0) + PREVIEW_PLANE_GAP_MM))),
        new THREE.LineBasicMaterial({ color: 0x99a3ad, transparent: true, opacity: 0.5 })));
    }
    for (const level of data.parent || []) {
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(level.outline.map((p) => new THREE.Vector3(p[0], p[1], (level.elevation_mm || 0) + 10))),
        new THREE.LineBasicMaterial({ color: 0xc0392b })));
    }
    const elevations = data.levels.map((l) => (l.elevation_mm == null ? 0 : l.elevation_mm)).sort((a, b) => a - b);
    const fallbackHeight = Math.max(3000, elevations.length > 1 ? (elevations[elevations.length - 1] - elevations[0]) / elevations.length : 3000);
    data.levels.forEach((level, li) => {
      if (!level.outline || level.outline.length < 3) return;   // ярус без контура (идёт правка) не строится
      const base = level.elevation_mm == null ? 0 : level.elevation_mm;
      const above = elevations.find((e) => e > base);
      const height = Math.max((above === undefined ? base + fallbackHeight : above) - base, 200);
      const active = li === data.activeLevel;
      const shape = new THREE.Shape(level.outline.map((p) => new THREE.Vector2(p[0], p[1])));
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: Math.max(height - PREVIEW_PLANE_GAP_MM, 100), bevelEnabled: false, steps: 1 }),
        new THREE.MeshStandardMaterial({ color: active ? 0x2471a3 : 0x7fa8c9, transparent: true, opacity: active ? 0.45 : 0.18, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.z = base;
      group.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: active ? 0x1b4f72 : 0x9fb8cd }));
      edges.position.z = base;
      group.add(edges);
      if (active) {
        const screenSize = 0.062;
        level.outline.forEach((p, pi) => {
          const cur = pi === data.activePoint;
          const s = numberSprite(THREE, String(pi + 1), cur, cur ? screenSize * 1.45 : screenSize);
          s.position.set(p[0], p[1], base + Math.max(height - PREVIEW_PLANE_GAP_MM, 100));
          group.add(s);
        });
      }
    });
    r.scene.add(group);
    r.group = group;
    if (!framed) {
      const cx = bbox ? (bbox[0] + bbox[2]) / 2 : 0, cy = bbox ? (bbox[1] + bbox[3]) / 2 : 0;
      const span = bbox ? Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) : 100000;
      r.controls.target.set(cx, 0, -cy);
      r.camera.position.set(cx - span * 0.55, span * 0.55, -cy + span * 0.75);
      r.controls.update();
      framed = true;
    }
    requestFrame();
  }

  return {
    // Показать в контейнере host (контейнер пересоздаётся при перерисовке формы — холст переносится, камера сохраняется).
    async show(host, data) {
      const x = await ensure(host);
      if (!x || disposed) return false;
      rebuild(data);
      return true;
    },
    update(data) { if (r) rebuild(data); else lastData = data; },
    // Снимок для проверок: сколько объёмов/контуров построено, где камера (без доступа к самой сцене снаружи).
    info() {
      if (!r?.group) return null;
      let meshes = 0, loops = 0, sprites = 0;
      r.group.traverse((o) => { if (o.isMesh && o.geometry?.type === "ExtrudeGeometry") meshes++; else if (o.isLineLoop) loops++; else if (o.isSprite) sprites++; });
      const p = r.camera.position;
      return { meshes, loops, sprites, camera: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], levels: lastData?.levels?.length ?? 0 };
    },
    dispose() {
      disposed = true;
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (!r) return;
      disposeGroup();
      r.controls.dispose();
      r.renderer.dispose();
      try { r.renderer.forceContextLoss(); } catch (e) { /* контекст уже потерян */ }
      r.renderer.domElement.remove();
      r = null;
    },
  };
}
