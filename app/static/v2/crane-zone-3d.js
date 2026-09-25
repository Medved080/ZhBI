// Интерактивная 3D-схема черновика кранов и стоянок. Зоны показаны объёмными
// призмами; правка вершины/ребра идёт в плоскости верхней грани. Высоту меняет
// отдельное поле «Отметка». Сохранение и публикация остаются в редакторе.
import { displacedEdgeEndpoints, nearestEdgeIndex } from "./zone-edge-geometry.js";

let libraries;
function loadLibraries() {
  if (!libraries) libraries = Promise.all([import("three"), import("/static/vendor/three/OrbitControls.js"),
    import("/static/vendor/three/examples/jsm/lines/LineSegments2.js"),
    import("/static/vendor/three/examples/jsm/lines/LineSegmentsGeometry.js"),
    import("/static/vendor/three/examples/jsm/lines/LineMaterial.js")])
    .then(([THREE, orbit, lines, geometry, material]) => ({ THREE, OrbitControls: orbit.OrbitControls,
      LineSegments2: lines.LineSegments2, LineSegmentsGeometry: geometry.LineSegmentsGeometry,
      LineMaterial: material.LineMaterial }))
    .catch((error) => { libraries = null; throw error; });
  return libraries;
}

export function createCraneZone3d(callbacks) {
  let r = null, host = null, data = null, disposed = false, framed = false;
  let homeDistance = 0, frame = null, observer = null, drag = null, box = null;
  let meshes = [], sceneBounds = null, modelSignature = null;

  function requestFrame() {
    if (!r || frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!r) return;
      // В компактном редакторе тысячи контуров сливаются в тёмное пятно.
      // Объём изделий виден всегда, тонкие рёбра проявляются при приближении.
      if (r.modelEdges) {
        r.modelEdges.visible = zoomPercent() > 160;
        r.edgeMaterial.opacity = Math.min(0.35, Math.max(0, (zoomPercent() - 160) / 200));
      }
      r.renderer.render(r.scene, r.camera); updateHandlePositions();
    });
  }
  function resize() {
    if (!r || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    r.renderer.setSize(w, h, false);
    if (r.edgeMaterial) r.edgeMaterial.resolution.set(w, h);
    r.camera.aspect = w / h; r.camera.updateProjectionMatrix();
    requestFrame();
  }
  function disposeGroup() {
    if (!r?.group) return;
    r.scene.remove(r.group);
    r.group.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    r.group = null; meshes = [];
  }
  function disposeModel() {
    if (!r?.modelGroup) return;
    r.scene.remove(r.modelGroup);
    r.modelGroup.traverse((object) => { object.geometry?.dispose(); object.material?.dispose(); });
    r.modelGroup = null; r.modelFace = null; r.modelColorRanges = null;
    r.modelHighlightIds = null; r.modelHighlightColor = null;
    r.modelEdges = null; r.edgeMaterial = null; modelSignature = null;
    if (host) { host.dataset.modelKind = "hidden"; host.dataset.modelCount = "0"; }
  }
  function activeLevel() {
    const zone = data?.zones.find((item) => item.id === data.selectedZone);
    return zone?.levels[data.activeLevel] || null;
  }
  function zoneTop(zone, levelIndex, bounds) {
    const base = levelY(zone.levels[levelIndex]);
    const higher = zone.levels.map(levelY).filter((value) => value > base).sort((a, b) => a - b);
    if (higher.length) return higher[0];
    if (zone.category === "Кран") return Math.max(base + 3000, bounds.maxZ);
    const sorted = zone.levels.map(levelY).sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((value, index) => value - sorted[index]).filter((value) => value > 0);
    return data?.showElements && data.modelElements?.length
      ? Math.max(base + 1, bounds.maxZ)
      : Math.max(base + 1, bounds.maxZ, base + (gaps.length ? Math.min(...gaps) : 3000));
  }
  function activeTop() {
    const zone = data?.zones.find((item) => item.id === data.selectedZone);
    return zone ? zoneTop(zone, data.activeLevel, sceneBounds || extent()) : 0;
  }
  function extent() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    const add = (x, y, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (Number.isFinite(z)) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    };
    for (const zone of data?.zones || []) for (const level of zone.levels) {
      for (const point of level.outline || []) add(point[0], point[1], levelY(level));
    }
    for (const element of data?.elements || []) add(element.x, element.y, Number(element.elevation_mm) || 0);
    for (const element of data?.modelElements || []) add(element.x, element.y, (Number(element.elevation_mm) || 0) + element.renderHeight);
    if (!Number.isFinite(minX)) return { minX: -500, maxX: 500, minY: -500, maxY: 500, minZ: 0, maxZ: 1000 };
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }
  function levelY(level) { return Number.isFinite(level?.elevation_mm) ? level.elevation_mm : 0; }
  function project(point) {
    const rect = r.renderer.domElement.getBoundingClientRect();
    const p = point.clone().project(r.camera);
    return [(p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2];
  }
  function toScreen(point) {
    return project(new r.THREE.Vector3(point[0], activeTop(), -point[1]));
  }
  function updateHandlePositions() {
    if (!host) return;
    const outline = activeLevel()?.outline || [];
    host.dataset.edgeMidpoints = JSON.stringify(outline.map((point, index) => {
      const a = toScreen(point), b = toScreen(outline[(index + 1) % outline.length]);
      return { index, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }));
  }
  function pointer(event) {
    const rect = r.renderer.domElement.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  function worldOnLevel(x, y) {
    const rect = r.renderer.domElement.getBoundingClientRect();
    r.ray.setFromCamera(new r.THREE.Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), r.camera);
    const plane = new r.THREE.Plane(new r.THREE.Vector3(0, 1, 0), -activeTop());
    const hit = new r.THREE.Vector3();
    return r.ray.ray.intersectPlane(plane, hit) ? [hit.x, -hit.z] : null;
  }
  function nearestHandle(x, y) {
    const level = activeLevel();
    if (!data?.editable || !level?.outline?.length) return null;
    for (let i = 0; i < level.outline.length; i++) {
      const p = toScreen(level.outline[i]);
      if (Math.hypot(p[0] - x, p[1] - y) <= 11) return { kind: "vertex", index: i };
    }
    const edge = nearestEdgeIndex(level.outline, x, y, toScreen, 10);
    return edge == null ? null : { kind: "edge", index: edge };
  }
  function nearestElement(x, y) {
    if (!data?.showElements) return null;
    let nearest = null, distance = 11;
    for (const element of data?.elements || []) {
      if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
      const p = project(new r.THREE.Vector3(element.x, Number(element.elevation_mm) || 0, -element.y));
      const gap = Math.hypot(p[0] - x, p[1] - y);
      if (gap < distance) { nearest = element; distance = gap; }
    }
    return nearest;
  }
  function pickZone(x, y) {
    const rect = r.renderer.domElement.getBoundingClientRect();
    r.ray.setFromCamera(new r.THREE.Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), r.camera);
    const hit = r.ray.intersectObjects(meshes, false)[0];
    return hit?.object.userData || null;
  }
  function removeBox() { box?.remove(); box = null; }
  function onDown(event) {
    if (event.button !== 0) return;
    const [x, y] = pointer(event);
    const selecting = (event.shiftKey || data?.selectMode) && data?.showElements;
    const handle = selecting ? null : nearestHandle(x, y);
    if (selecting || handle) {
      event.preventDefault();
      r.controls.enabled = false;
      if (selecting) {
        drag = { kind: "box", x, y, lastX: x, lastY: y };
        box = document.createElement("div"); box.className = "cz-3d-selection"; host.appendChild(box);
      } else {
        const start = worldOnLevel(x, y);
        if (!start) { r.controls.enabled = true; return; }
        drag = { ...handle, x, y, start, outline: activeLevel().outline.map((point) => [...point]), moved: false };
      }
      r.renderer.domElement.setPointerCapture(event.pointerId);
    } else drag = { kind: "orbit", x, y, moved: false };
  }
  function onMove(event) {
    const [x, y] = pointer(event);
    if (!drag) {
      r.renderer.domElement.style.cursor = data?.selectMode && data?.showElements ? "crosshair" : nearestHandle(x, y) ? "move" : "grab";
      return;
    }
    if (drag.kind === "box") {
      drag.lastX = x; drag.lastY = y;
      Object.assign(box.style, { left: `${Math.min(drag.x, x)}px`, top: `${Math.min(drag.y, y)}px`,
        width: `${Math.abs(drag.x - x)}px`, height: `${Math.abs(drag.y - y)}px` });
      return;
    }
    if (drag.kind === "orbit") { if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true; return; }
    const world = worldOnLevel(x, y); if (!world) return;
    const outline = drag.outline.map((point) => [...point]);
    if (drag.kind === "vertex") outline[drag.index] = world.map(Math.round);
    else {
      const endpoints = displacedEdgeEndpoints(outline, drag.index, world[0] - drag.start[0], world[1] - drag.start[1]);
      if (!endpoints) return;
      outline[drag.index] = endpoints[0]; outline[(drag.index + 1) % outline.length] = endpoints[1];
    }
    if (Math.hypot(x - drag.x, y - drag.y) > 2) drag.moved = true;
    if (drag.moved) callbacks.onOutline(outline);
  }
  function onUp(event) {
    if (!drag) return;
    const [x, y] = pointer(event), last = drag;
    drag = null; r.controls.enabled = true;
    if (r.renderer.domElement.hasPointerCapture(event.pointerId)) r.renderer.domElement.releasePointerCapture(event.pointerId);
    if (last.kind === "box") {
      removeBox();
      const x0 = Math.min(last.x, x), x1 = Math.max(last.x, x), y0 = Math.min(last.y, y), y1 = Math.max(last.y, y);
      callbacks.onSelectElements((data?.elements || []).filter((element) => {
        const p = project(new r.THREE.Vector3(element.x, Number(element.elevation_mm) || 0, -element.y));
        return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
      }).map((element) => element.id));
    } else if (last.kind === "orbit" && !last.moved) {
      const element = nearestElement(x, y), zone = element ? null : pickZone(x, y);
      if (element) callbacks.onSelectElements([element.id]);
      else if (zone) callbacks.onSelectZone(zone.zoneId, zone.levelIndex);
    } else if (last.moved) callbacks.onCommit();
  }
  function onDoubleClick(event) {
    const [x, y] = pointer(event), handle = nearestHandle(x, y);
    if (handle?.kind !== "edge") return;
    const world = worldOnLevel(x, y); if (!world) return;
    const outline = activeLevel().outline.map((point) => [...point]);
    outline.splice(handle.index + 1, 0, world.map(Math.round));
    callbacks.onOutline(outline); callbacks.onCommit();
  }
  async function ensure() {
    if (r) return r;
    const { THREE, OrbitControls, LineSegments2, LineSegmentsGeometry, LineMaterial } = await loadLibraries();
    if (disposed) return null;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0xeceff3);
    renderer.domElement.setAttribute("aria-label", "3D-схема зон: перетаскивание — поворот, колесо — масштаб, ручки — редактирование контура");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.zoomSpeed = 0.45;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.addEventListener("change", () => { requestFrame(); callbacks.onViewChange?.(); });
    scene.add(new THREE.HemisphereLight(0xffffff, 0x505050, 1.3));
    const light = new THREE.DirectionalLight(0xffffff, 0.9); light.position.set(1, 2, 1); scene.add(light);
    const ray = new THREE.Raycaster();
    r = { THREE, LineSegments2, LineSegmentsGeometry, LineMaterial,
      renderer, scene, camera, controls, group: null, modelGroup: null, edgeMaterial: null, ray };
    renderer.domElement.addEventListener("pointerdown", onDown, true);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointercancel", onUp);
    renderer.domElement.addEventListener("dblclick", onDoubleClick);
    return r;
  }
  function updateModel() {
    if (!r || !data?.showElements || !data.modelElements?.length) { disposeModel(); return; }
    if (r.modelGroup && modelSignature === data.modelKey) {
      updateModelColors();
      if (host) { host.dataset.modelKind = "extrusions"; host.dataset.modelCount = String(data.modelElements.length); }
      return;
    }
    disposeModel();
    const { THREE } = r, positions = [], normals = [], edgeChunks = [], colorRanges = [];
    let faceLength = 0, edgeLength = 0;
    for (const element of data.modelElements) {
      if (!Array.isArray(element.outline) || element.outline.length < 3 || !(element.renderHeight > 0)) continue;
      // Та же схема построения, что build3DElementGeometry основной модели:
      // контур DXF без отступов, rotateX(-90°), затем исходная отметка.
      const shape = new THREE.Shape(element.outline.map((point) => new THREE.Vector2(point[0], point[1])));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: element.renderHeight, bevelEnabled: false, steps: 1 });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, element.elevation_mm || 0, 0);
      const p = geometry.attributes.position.array, n = geometry.attributes.normal.array;
      positions.push(p); normals.push(n);
      colorRanges.push({ id: element.id, start: faceLength, length: p.length }); faceLength += p.length;
      const edgeGeometry = new THREE.EdgesGeometry(geometry);
      const edgePositions = edgeGeometry.attributes.position.array;
      edgeChunks.push(edgePositions); edgeLength += edgePositions.length;
      edgeGeometry.dispose(); geometry.dispose();
    }
    const group = new THREE.Group();
    if (faceLength) {
      const faceGeometry = new THREE.BufferGeometry();
      const p = new Float32Array(faceLength), n = new Float32Array(faceLength), c = new Float32Array(faceLength);
      let offset = 0;
      for (let i = 0; i < positions.length; i++) {
        p.set(positions[i], offset); n.set(normals[i], offset); offset += positions[i].length;
      }
      faceGeometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
      faceGeometry.setAttribute("normal", new THREE.BufferAttribute(n, 3));
      faceGeometry.setAttribute("color", new THREE.BufferAttribute(c, 3));
      r.modelFace = new THREE.Mesh(faceGeometry, new THREE.MeshStandardMaterial({ vertexColors: true,
        transparent: true, opacity: 0.52, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }));
      r.modelColorRanges = colorRanges;
      group.add(r.modelFace);
    }
    if (edgeLength) {
      const edges = new Float32Array(edgeLength);
      let offset = 0;
      for (const chunk of edgeChunks) { edges.set(chunk, offset); offset += chunk.length; }
      const geometry = new r.LineSegmentsGeometry(); geometry.setPositions(edges);
      const resolution = new THREE.Vector2(host?.clientWidth || 1, host?.clientHeight || 1);
      r.edgeMaterial = new r.LineMaterial({ color: 0x53636d, linewidth: 1, resolution, transparent: true });
      r.modelEdges = new r.LineSegments2(geometry, r.edgeMaterial);
      group.add(r.modelEdges);
    }
    r.modelGroup = group; modelSignature = data.modelKey;
    updateModelColors();
    if (host) { host.dataset.modelKind = "extrusions"; host.dataset.modelCount = String(data.modelElements.length); }
    r.scene.add(group); requestFrame();
  }
  function updateModelColors() {
    if (!r?.modelFace || !r.modelColorRanges) return;
    const highlighted = data.highlightIds || new Set();
    if (r.modelHighlightColor === data.highlightColor && r.modelHighlightIds?.size === highlighted.size
      && [...highlighted].every((id) => r.modelHighlightIds.has(id))) return;
    const neutral = new r.THREE.Color("#aebac2");
    const accent = new r.THREE.Color(data.highlightColor || "#2c8953");
    const attribute = r.modelFace.geometry.getAttribute("color"), values = attribute.array;
    for (const { id, start, length } of r.modelColorRanges) {
      const color = highlighted.has(id) ? accent : neutral;
      for (let i = start; i < start + length; i += 3) {
        values[i] = color.r; values[i + 1] = color.g; values[i + 2] = color.b;
      }
    }
    attribute.needsUpdate = true;
    r.modelHighlightIds = new Set(highlighted);
    r.modelHighlightColor = data.highlightColor;
    if (host) host.dataset.highlightedElements = String(highlighted.size);
    requestFrame();
  }
  function rebuild() {
    if (!r || !data) return;
    if (host) { host.dataset.visibleElements = String(data.elements.length); host.dataset.editable = String(!!data.editable);
      if (!data.showElements) { host.dataset.modelKind = "hidden"; host.dataset.modelCount = "0"; } }
    disposeGroup();
    updateModel();
    const { THREE } = r, group = new THREE.Group();
    sceneBounds = extent();
    const bounds = sceneBounds;
    const span = Math.max(1000, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const grid = new THREE.GridHelper(span * 1.2, 10, 0xc8d8df, 0xe4ecf0);
    grid.position.set((bounds.minX + bounds.maxX) / 2, bounds.minZ - Math.max(20, span * 0.005), -(bounds.minY + bounds.maxY) / 2);
    group.add(grid);
    for (const zone of data.zones) for (const [levelIndex, level] of zone.levels.entries()) {
      const outline = level.outline;
      if (!outline || outline.length < 3) continue;
      const y = levelY(level), top = zoneTop(zone, levelIndex, bounds);
      const active = zone.id === data.selectedZone && levelIndex === data.activeLevel;
      const color = zone.category === "Кран" ? 0x2c8953 : 0x4682b4;
      const quietStand = data.selectedCategory === "Стоянка" && zone.category === "Стоянка" && !active;
      const shape = new THREE.Shape(outline.map((point) => new THREE.Vector2(point[0], point[1])));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(100, top - y), bevelEnabled: false, steps: 1 });
      const volume = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true,
        opacity: active ? 0.38 : quietStand ? 0 : data.showElements ? 0.015 : 0.05,
        side: THREE.DoubleSide, depthWrite: false, depthTest: !active }));
      volume.rotation.x = -Math.PI / 2; volume.position.y = y;
      volume.renderOrder = active ? 4 : 1;
      volume.userData = { zoneId: zone.id, levelIndex };
      meshes.push(volume); group.add(volume);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color,
        transparent: true, opacity: active ? 0.95 : quietStand ? 0 : 0.13, depthTest: false }));
      edges.rotation.x = -Math.PI / 2; edges.position.y = y; edges.renderOrder = active ? 5 : 2;
      group.add(edges);
      if (active && data.editable) {
        const vertices = [], edgeCenters = [];
        for (let i = 0; i < outline.length; i++) {
          const point = outline[i], next = outline[(i + 1) % outline.length];
          vertices.push(point[0], top + 5, -point[1]);
          edgeCenters.push((point[0] + next[0]) / 2, top + 5, -(point[1] + next[1]) / 2);
        }
        const vertexGeometry = new THREE.BufferGeometry(); vertexGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
        const edgeGeometry = new THREE.BufferGeometry(); edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgeCenters, 3));
        const vertexMarkers = new THREE.Points(vertexGeometry, new THREE.PointsMaterial({ color: 0xee7131, size: 13, sizeAttenuation: false, depthTest: false }));
        const edgeMarkers = new THREE.Points(edgeGeometry, new THREE.PointsMaterial({ color: 0xffffff, size: 10, sizeAttenuation: false, depthTest: false }));
        vertexMarkers.renderOrder = 6; edgeMarkers.renderOrder = 6;
        group.add(vertexMarkers, edgeMarkers);
      }
    }
    r.group = group; r.scene.add(group); requestFrame();
  }
  function fit() {
    if (!r || !data) return;
    const bounds = sceneBounds || extent();
    const { minX, maxX, minY, maxY, minZ } = bounds;
    const maxZ = Math.max(bounds.maxZ, ...data.zones.flatMap((zone) => zone.levels.map((_, index) => zoneTop(zone, index, bounds))));
    const span = Math.max(maxX - minX, maxY - minY, (maxZ - minZ) * 1.5, 1000);
    homeDistance = span * 1.75;
    const cx = (minX + maxX) / 2, cy = (minZ + maxZ) / 2, cz = -(minY + maxY) / 2;
    r.controls.target.set(cx, cy, cz);
    r.camera.position.set(cx + homeDistance * 0.58, cy + homeDistance * 0.66, cz + homeDistance * 0.47);
    homeDistance = r.camera.position.distanceTo(r.controls.target);
    r.controls.maxDistance = homeDistance;
    r.controls.minDistance = homeDistance / 100;
    r.controls.update(); framed = true; requestFrame();
  }
  function zoom(factor) {
    if (!r || !homeDistance) return;
    const offset = r.camera.position.clone().sub(r.controls.target);
    const next = Math.max(homeDistance / 100, Math.min(homeDistance, offset.length() / factor));
    offset.setLength(next); r.camera.position.copy(r.controls.target).add(offset);
    r.controls.update(); requestFrame();
  }
  function zoomPercent() {
    if (!r || !homeDistance) return 100;
    return Math.max(100, Math.round(homeDistance / r.camera.position.distanceTo(r.controls.target) * 100));
  }
  return {
    async show(nextHost, nextData) {
      if (disposed || !nextHost) return;
      data = nextData;
      await ensure();
      if (disposed) return;
      host = nextHost;
      if (r.renderer.domElement.parentNode !== host) host.appendChild(r.renderer.domElement);
      observer?.disconnect();
      observer = new ResizeObserver(resize); observer.observe(host);
      resize(); rebuild();
      if (!framed) fit();
    },
    update(nextData) { data = nextData; rebuild(); },
    fit, zoom, zoomPercent,
    info() { return { elements: data?.elements.length || 0, zones: data?.zones.length || 0, percent: zoomPercent(), editable: !!data?.editable }; },
    dispose() {
      disposed = true; observer?.disconnect(); removeBox();
      if (frame != null) cancelAnimationFrame(frame);
      if (!r) return;
      disposeGroup(); disposeModel(); r.controls.dispose(); r.renderer.dispose();
      try { r.renderer.forceContextLoss(); } catch { /* контекст уже потерян */ }
      r.renderer.domElement.remove(); r = null;
    },
  };
}
