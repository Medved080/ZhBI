// Предпросмотр FBX-файла перед загрузкой — чтобы не отправить на сервер не тот файл (запрос пользователя 2026-10-09).
// Общий для V1 и V2: вызывается из панели (settings.js) сразу после разбора выбранного файла и ДО отправки; «Загрузить» — единственный
// путь дальше. Показывает то, что реально разобрано из файла: картинку модели (3D, можно вращать мышью; вид «Изометрия»/«Сверху»),
// состав (какие части и сколько в них треугольников), габарит, оси и единицы, замечания разбора и — если в объекте уже есть похожая
// модель — предупреждение о возможном дубле.
//
// Зависимости — аргументы (THREE уже загружен панелью), глобалей нет. Разобранная группа `parsed.group` НЕ трогается: в окне
// рисуется её клон (геометрия и материалы общие, их не освобождаем — группа ещё нужна автосовмещению фасада и отправке).
// Стили подключаются самим модулем (один <style>) и берут цвета из переменных страницы обеих версий (V2: --bg/--ink/…, V1: --color-*),
// поэтому окно выглядит родным и там и там.

const STYLE_ID = "emfp-style";
const AXIS_LABEL = { y_up: "Y вверх", z_up: "Z вверх (экспорт Blender)" };
const KIND_LABEL = { ground: "Благоустройство", facade: "Фасад" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtM = (mm, d = 1) => (Number(mm) / 1000).toFixed(d).replace(/\.0+$/, "");

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
.emfp-backdrop { position: fixed; inset: 0; z-index: 2000; background: rgba(15,20,30,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.emfp {
  --p-bg: var(--bg, var(--color-surface, #fff)); --p-ink: var(--ink, var(--color-text, #222)); --p-line: var(--line, var(--color-border, #d8d8d8));
  --p-muted: var(--muted, var(--color-text-muted, #6b7280)); --p-accent: var(--accent, var(--color-primary, #2563eb)); --p-accent-ink: var(--accent-ink, #fff);
  --p-sel: var(--sel, var(--color-accent-soft, #eef2ff)); --p-bad: var(--bad, var(--color-danger, #c0392b)); --p-surface: var(--surface, var(--color-surface-2, #f3f4f6));
  width: min(1040px, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--p-bg); color: var(--p-ink);
  border: 1px solid var(--p-line); border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.28); padding: 16px 18px 14px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.emfp h3 { margin: 0 0 2px; font-size: 16px; }
.emfp-note { margin: 0 0 10px; color: var(--p-muted); font-size: 12px; }
.emfp-body { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; min-height: 0; overflow: auto; }
@media (max-width: 760px) { .emfp-body { grid-template-columns: minmax(0, 1fr); } }
.emfp-view { position: relative; min-width: 0; }
.emfp-canvas { display: block; width: 100%; height: 380px; border: 1px solid var(--p-line); border-radius: 8px; background: var(--p-surface); touch-action: none; cursor: grab; }
.emfp-canvas:active { cursor: grabbing; }
.emfp-viewbtns { position: absolute; left: 8px; top: 8px; display: flex; gap: 4px; }
.emfp-viewhint { margin-top: 4px; color: var(--p-muted); font-size: 11px; }
.emfp-nogl { display: none; height: 380px; align-items: center; justify-content: center; text-align: center; padding: 16px; border: 1px dashed var(--p-line); border-radius: 8px; color: var(--p-muted); }
.emfp-info { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.emfp dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; }
.emfp dt { color: var(--p-muted); }
.emfp dd { margin: 0; overflow-wrap: anywhere; }
.emfp h4 { margin: 0 0 4px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--p-muted); }
.emfp-parts { margin: 0; padding: 0; list-style: none; max-height: 150px; overflow: auto; border: 1px solid var(--p-line); border-radius: 8px; }
.emfp-parts li { display: flex; justify-content: space-between; gap: 10px; padding: 4px 8px; border-bottom: 1px solid var(--p-line); }
.emfp-parts li:last-child { border-bottom: 0; }
.emfp-parts span:last-child { color: var(--p-muted); white-space: nowrap; }
.emfp-warn { border-left: 4px solid var(--p-bad); background: var(--p-surface); border-radius: 6px; padding: 6px 10px; font-size: 12px; }
.emfp-warn ul { margin: 2px 0 0; padding-left: 16px; }
.emfp-dup { border-left-color: #d98e04; }
.emfp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.emfp-btn { padding: 8px 14px; border: 1px solid var(--p-line); border-radius: 7px; background: var(--p-surface); color: var(--p-ink); font: inherit; cursor: pointer; white-space: nowrap; }
.emfp-btn:hover { border-color: var(--p-accent); }
.emfp-btn.sm { padding: 3px 9px; font-size: 12px; background: var(--p-bg); }
.emfp-btn.primary { background: var(--p-accent); border-color: var(--p-accent); color: var(--p-accent-ink); font-weight: 600; }
.emfp-btn:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
`;
  document.head.appendChild(st);
}

// ---- картинка модели -------------------------------------------------------------------------------------------------------
// Группа — в канонических координатах плана (мм, Z вверх, начало — центр габарита на его низу), поэтому камера «up» = Z.
// Возвращает null, если WebGL недоступен (тогда окно остаётся текстовым).
async function renderModelPreview({ THREE, canvas, group }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) { return null; }
  const { OrbitControls } = await import("/static/vendor/three/OrbitControls.js");
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a3, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-1, -1.5, 2.2);
  scene.add(sun);
  const root = group.clone(true);   // клон делит геометрию и материалы с исходной группой — их не освобождаем
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const diag = Math.max(size.length(), 1);
  // Контуры рёбер — без них сверху плоско залитые части сливаются (стены дома и крыша одного цвета). Для тяжёлых файлов (>100 тыс.
  // треугольников) пропускаем: расчёт рёбер синхронный (≈3 с на 137 тыс.) и подвесил бы окно, а такая модель и так читается по форме.
  let totalTris = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry) totalTris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  if (totalTris <= 100000) {
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b323d, transparent: true, opacity: 0.55 });
    const edges = [];
    root.traverse((o) => { if (o.isMesh && o.geometry) edges.push(o); });
    for (const m of edges) {
      try {
        const eg = new THREE.EdgesGeometry(m.geometry, 35);
        const line = new THREE.LineSegments(eg, edgeMat);
        line.matrix.copy(m.matrix); line.matrixAutoUpdate = false;
        m.parent.add(line);
      } catch (e) { /* рёбра — украшение, не причина отказать в предпросмотре */ }
    }
  }
  // оси X/Y/Z от угла габарита — чтобы по картинке было видно ориентацию (красная X, зелёная Y, синяя Z — вверх)
  const axes = new THREE.AxesHelper(diag * 0.18);
  axes.position.copy(box.min);
  scene.add(axes);

  const camera = new THREE.PerspectiveCamera(35, 1, diag / 2000, diag * 30);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.enableDamping = false;

  let raf = 0;
  const draw = () => { raf = 0; renderer.render(scene, camera); };
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  controls.addEventListener("change", redraw);
  const resize = () => {
    const w = Math.max(canvas.clientWidth, 200), h = Math.max(canvas.clientHeight, 160);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    redraw();
  };
  const dist = (diag / 2) / Math.tan((camera.fov * Math.PI) / 360) * 0.85;
  function setView(name) {
    // «Сверху» чуть наклонена к югу (север — вверх экрана, как на плане) и не упирается в полюс OrbitControls; «Изометрия» — угол вдоль диагонали
    const dir = name === "top" ? new THREE.Vector3(0, -0.001, 1) : new THREE.Vector3(-0.8, -1.0, 0.75);
    camera.position.copy(center).add(dir.normalize().multiplyScalar(dist));
    camera.lookAt(center);
    controls.update();
    redraw();
  }
  window.addEventListener("resize", resize);
  resize();
  setView("iso");
  return {
    setView,
    // Контекст WebGL освобождается явно: браузер даёт их считанные десятки, забытые копятся и новые перестают строиться
    dispose() {
      window.removeEventListener("resize", resize);
      root.traverse((o) => { if (o.isLineSegments) { o.geometry.dispose(); o.material?.dispose?.(); } });   // рёбра — наши, геометрия мешей общая и остаётся
      if (raf) cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch (e) { /* уже потерян */ }
    },
    // для самопроверок: отрисовать сразу и вернуть PNG (без preserveDrawingBuffer снимок возможен только сразу после render)
    snapshot() { renderer.render(scene, camera); return canvas.toDataURL("image/png"); },
  };
}

function partsOf(group) {
  const rows = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const tris = Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
    rows.push({ name: o.name || "(без имени)", tris });
  });
  return rows.sort((a, b) => b.tris - a.tris);
}

/**
 * @param {object} o
 * @param {typeof import('three')} o.THREE
 * @param {File} o.file
 * @param {'ground'|'facade'} o.kind
 * @param {object} o.parsed — результат loadExternalModelFbx (group, bboxSizeMm, meshCount, triangleCount, textureCount, warnings, …)
 * @param {object[]} [o.existing] — уже загруженные модели объекта (строки API) — для предупреждения о дубле
 * @returns {Promise<boolean>} true — загружать
 */
export function showFbxFilePreview({ THREE, file, kind, parsed, existing = [] }) {
  ensureStyle();
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const b = parsed.bboxSizeMm;
    const parts = partsOf(parsed.group);
    const dupByName = existing.filter((m) => m.original_name && m.original_name === file.name);
    const dupByShape = existing.filter((m) => !dupByName.includes(m) && m.metadata && m.metadata.triangle_count === parsed.triangleCount
      && m.metadata.bbox_size_mm && ["x", "y", "z"].every((k) => Math.abs(m.metadata.bbox_size_mm[k] - b[k]) < 5));
    const warns = parsed.warnings || [];
    const [cx, cy] = parsed.sourceAnchorMm;

    const root = document.createElement("div");
    root.className = "emfp-backdrop";
    root.innerHTML = `<div class="emfp" role="dialog" aria-modal="true" aria-label="Предпросмотр файла перед загрузкой">
      <h3>Что в этом файле?</h3>
      <p class="emfp-note">Проверьте, что выбран нужный файл: на сервер он уйдёт только после «Загрузить».</p>
      <div class="emfp-body">
        <div class="emfp-view">
          <canvas class="emfp-canvas" tabindex="0" aria-label="Модель из файла: мышью можно вращать"></canvas>
          <div class="emfp-nogl">Не удалось показать модель (нет WebGL) — ориентируйтесь на сведения справа.</div>
          <div class="emfp-viewbtns"><button type="button" class="emfp-btn sm" data-view="iso">Изометрия</button><button type="button" class="emfp-btn sm" data-view="top">Сверху</button></div>
          <div class="emfp-viewhint">Левая кнопка — вращать, правая — сдвинуть, колесо — приблизить. Оси: красная X, зелёная Y, синяя Z (вверх).</div>
        </div>
        <div class="emfp-info">
          <dl>
            <dt>Файл</dt><dd>${esc(file.name)}</dd>
            <dt>Размер</dt><dd>${(file.size / 1024 / 1024).toFixed(1)} МБ</dd>
            <dt>Загружается как</dt><dd><b>${esc(KIND_LABEL[kind] || kind)}</b></dd>
            <dt>Габарит</dt><dd>${fmtM(b.x)} × ${fmtM(b.y)} × ${fmtM(b.z)} м (длина × ширина × высота)</dd>
            <dt>Частей / треугольников</dt><dd>${parsed.meshCount} / ${parsed.triangleCount.toLocaleString("ru-RU")}</dd>
            <dt>Текстур</dt><dd>${parsed.textureCount}</dd>
            <dt>Центр в файле</dt><dd>X ${fmtM(cx, 1)} м, Y ${fmtM(cy, 1)} м</dd>
            <dt>Формат / оси</dt><dd>FBX ${parsed.formatVersion}, ${esc(AXIS_LABEL[parsed.axisProfile] || "оси подтверждены")}</dd>
          </dl>
          <div><h4>Состав (части файла)</h4>
            <ul class="emfp-parts">${parts.slice(0, 12).map((p) => `<li><span>${esc(p.name)}</span><span>${p.tris.toLocaleString("ru-RU")} треуг.</span></li>`).join("")}${parts.length > 12 ? `<li><span>…и ещё ${parts.length - 12}</span><span></span></li>` : ""}</ul></div>
          ${dupByName.length ? `<div class="emfp-warn emfp-dup"><b>Файл с таким именем уже загружен:</b> «${esc(dupByName.map((m) => m.name).join("», «"))}». Если это та же модель — загрузка создаст дубль.</div>` : ""}
          ${dupByShape.length ? `<div class="emfp-warn emfp-dup"><b>Похоже на уже загруженную модель:</b> «${esc(dupByShape.map((m) => m.name).join("», «"))}» — те же габарит и число треугольников.</div>` : ""}
          ${warns.length ? `<div class="emfp-warn"><b>Замечания разбора:</b><ul>${warns.slice(0, 6).map((w) => `<li>${esc(w)}</li>`).join("")}${warns.length > 6 ? `<li>…и ещё ${warns.length - 6}</li>` : ""}</ul></div>` : ""}
        </div>
      </div>
      <div class="emfp-actions"><button type="button" class="emfp-btn" data-act="cancel">Отмена — выбрать другой файл</button><button type="button" class="emfp-btn primary" data-act="ok">Загрузить</button></div>
    </div>`;
    document.body.appendChild(root);
    const canvas = root.querySelector(".emfp-canvas");
    let view = null;
    let done = false;

    function finish(ok) {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      view?.dispose();
      root.remove();
      if (prevFocus && document.contains(prevFocus) && prevFocus.focus) prevFocus.focus();
      resolve(ok);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key === "Tab") {
        const items = [...root.querySelectorAll("button, canvas[tabindex]")];
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "ok") finish(true);
      else if (act === "cancel") finish(false);
      else if (e.target.closest("[data-view]") && view) view.setView(e.target.closest("[data-view]").dataset.view);
    });
    root.querySelector('[data-act="ok"]').focus();

    renderModelPreview({ THREE, canvas, group: parsed.group }).then((v) => {
      if (done) { v?.dispose(); return; }
      if (!v) { canvas.style.display = "none"; root.querySelector(".emfp-viewbtns").style.display = "none"; root.querySelector(".emfp-nogl").style.display = "flex"; return; }
      view = v;
      // для самопроверок (scripts/…): окно отдаёт снимок картинки, если страница просит
      root.__emfpSnapshot = () => v.snapshot();
    }).catch(() => {
      canvas.style.display = "none"; root.querySelector(".emfp-viewbtns").style.display = "none"; root.querySelector(".emfp-nogl").style.display = "flex";
    });
  });
}
