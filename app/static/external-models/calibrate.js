// «Совместить по точкам» (Docs/fbx-placement-claude-prompt.md §2-3) —
// точная привязка внешней FBX-модели к геометрии объекта по паре
// соответствующих точек (A↔A, B↔B) плюс необязательная контрольная точка
// C. Работает в ЛЮБОЙ уже открытой 3D-сцене объекта (МФР или ЖБИ) —
// диспетчер и адаптеры передаёт вызывающий код (app.js), сам модуль знает
// только про THREE и чистую математику coordinates.js. Собственная
// плавающая панель поверх 3D — тем же приёмом, что «Настроить положение»
// в app.js (диалог настроек на время режима скрыт).
//
// Точка на модели — раскаст ТОЛЬКО по её собственной группе (`group`),
// затем `group.worldToLocal(hit.point)` + source_anchor даёт C (§3
// задания: убрать уже применённое размещение, не поворачивать дважды).
// Точка на объекте — раскаст по ЦЕЛОЙ сцене ЗА ВЫЧЕТОМ известных групп
// внешних моделей (`excludeObjects`): что бы это ни было внутри сцены
// (мерж элементов, блоки, оси) — с точки зрения этого модуля это и есть
// «геометрия объекта», без предположений о конкретной внутренней
// структуре сцены МФР/ЖБИ (излишнее знание — источник ошибок, см. живой
// инцидент 2026-09-11 про непроверенное совпадение координат).
//
// Привязка к вершине — ТОЛЬКО у треугольника, в который попал луч (три
// вершины хита), не обход всей геометрии на каждый pointermove: дёшево,
// достаточно для клика рядом с настоящим углом/ребром. Клик по
// произвольной точке поверхности треугольника снапом не считаем — снап
// либо попадает в допуск по экранным пикселям, либо честно остаётся
// «точка на поверхности», без обмана точности.

import {
  calibrateByPointPair, residualForPoint,
  transferPlacementXY, transferPlacementZ,
} from "./coordinates.js";

const SNAP_PIXEL_TOLERANCE = 14;

function worldToScreen(camera, canvas, worldPoint) {
  const v = worldPoint.clone().project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}

/** Раскаст с попыткой снапа к вершине треугольника хита (см. шапку файла).
 * Возвращает {point: THREE.Vector3 (мир)} или null. */
function raycastWithSnap({ THREE, e, canvas, camera, targets }) {
  const r = canvas.getBoundingClientRect();
  const ndc = {
    x: ((e.clientX - r.left) / r.width) * 2 - 1,
    y: -((e.clientY - r.top) / r.height) * 2 + 1,
  };
  const raycaster = new THREE.Raycaster();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(targets, true).find((h) => h.object.isMesh && h.face);
  if (!hit) return null;

  const pos = hit.object.geometry.attributes.position;
  let best = null;
  let bestDist = SNAP_PIXEL_TOLERANCE;
  const local = new THREE.Vector3();
  const world = new THREE.Vector3();
  for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
    local.fromBufferAttribute(pos, i);
    world.copy(local).applyMatrix4(hit.object.matrixWorld);
    const screen = worldToScreen(camera, canvas, world);
    const d = Math.hypot(screen.x - e.clientX, screen.y - e.clientY);
    if (d < bestDist) { bestDist = d; best = world.clone(); }
  }
  return { point: best || hit.point.clone() };
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}
function fmtPoint(p) {
  return p ? `${fmt(p[0])}, ${fmt(p[1])} мм` : "не указана";
}

// Явные подписи — "модель"/"объект" в задании путали пользователя (живой
// вопрос 2026-09-11: "непонятна терминология"). Здесь "модель" — ЭТОТ,
// только что загруженный FBX-файл (например, фасад); "объект" — ЛЮБАЯ
// геометрия объекта, УЖЕ отрисованная в этой же 3D-сцене независимо от
// FBX (у пользователя — конструктив, импортированный из PDF/Revit).
const PICK_LABELS = {
  c1: "A на FBX-файле", p1: "A на конструктиве объекта",
  c2: "B на FBX-файле", p2: "B на конструктиве объекта",
  c3: "C на FBX-файле (проверка)", p3: "C на конструктиве (проверка)",
};

/**
 * @param {object} opts
 * @param {typeof import('three')} opts.THREE
 * @param {HTMLCanvasElement} opts.canvas
 * @param {*} opts.camera
 * @param {*} opts.controls
 * @param {HTMLElement} opts.backdrop — диалог настроек, скрывается на время режима
 * @param {*} opts.scene
 * @param {*} opts.group — группа внешней модели (для раскаста ПО НЕЙ и worldToLocal)
 * @param {Array} opts.excludeObjects — группы внешних моделей ЭТОГО объекта
 *   (свою и чужие) — раскаст «по объекту» не должен попадать ни в одну.
 * @param {[number,number]} opts.sourceAnchorXY — model.source_anchor_mm.x/y
 * @param {[number,number]} opts.objectAnchorXY — model.object_anchor_mm.x/y
 * @param {(v:[number,number,number]) => [number,number]} opts.viewToProjectXY — обратный адаптер просмотрщика (мир → P.xy)
 * @param {(p:[number,number,number]) => [number,number,number]} opts.projectToView — прямой адаптер (P → мир), для превью позиции
 * @param {(group:*, rotationDeg:number) => void} opts.applyRotationPreview — ставит group.quaternion для предпросмотра (МФР/ЖБИ считают его по-разному)
 * @param {(result:{offsetXMm:number, offsetYMm:number, rotationDeg:number}) => void} opts.onApply
 * @param {() => void} opts.onCancel
 */
export function beginPointPairCalibration(opts) {
  const {
    THREE, canvas, camera, controls, backdrop, scene, group, excludeObjects,
    sourceAnchorXY, objectAnchorXY, viewToProjectXY, projectToView,
    applyRotationPreview, onApply, onCancel,
  } = opts;

  const armStartPos = group.position.clone();
  const armStartQuat = group.quaternion.clone();
  const targetObjects = scene.children.filter((o) => !excludeObjects.includes(o));

  const picks = { c1: null, p1: null, c2: null, p2: null, c3: null, p3: null };
  let activePick = null; // 'c1' | 'p1' | 'c2' | 'p2' | 'c3' | 'p3' | null
  let finished = false;
  let lastCalib = null; // {theta, rotationDeg, offsetXMm, offsetYMm, uLen, vLen, lengthDiffMm, lengthRatio}

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed; top:16px; left:50%; transform:translateX(-50%); "
    + "z-index:1000; background:rgba(20,24,32,.95); color:#fff; padding:14px 16px; "
    + "border-radius:8px; font:13px sans-serif; max-width:420px; "
    + "box-shadow:0 4px 16px rgba(0,0,0,.4)";
  document.body.appendChild(overlay);

  function pickRow(kind) {
    const active = activePick === kind;
    return `
      <div style="display:flex; align-items:center; gap:6px; margin:3px 0">
        <span style="width:170px; flex-shrink:0">${PICK_LABELS[kind]}:</span>
        <span style="flex:1; opacity:.85">${fmtPoint(picks[kind])}</span>
        <button type="button" data-pick="${kind}" style="padding:2px 8px; cursor:pointer; ${active ? "background:#f39c12" : ""}">
          ${active ? "Кликните в 3D…" : "Указать"}</button>
        ${picks[kind] ? `<button type="button" data-clear="${kind}" style="padding:2px 6px; cursor:pointer">✕</button>` : ""}
      </div>`;
  }

  function render(state) {
    const calibBlock = state.calib ? `
      <div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.2)">
        |A−B| на FBX-файле: ${fmt(state.calib.uLen)} мм · на конструктиве объекта: ${fmt(state.calib.vLen)} мм
        (разница ${fmt(state.calib.lengthDiffMm)} мм, отношение ${fmt(state.calib.lengthRatio, 3)})<br/>
        Поворот: ${fmt(state.calib.rotationDeg, 2)}° · Сдвиг: X=${fmt(state.calib.offsetXMm)} Y=${fmt(state.calib.offsetYMm)} мм
      </div>` : "";
    const warnBlock = state.warn ? `<div style="margin-top:6px; color:#ffb74d">⚠ ${state.warn}</div>` : "";
    const residualBlock = state.residual
      ? `<div style="margin-top:6px">Невязка контрольной точки: <b>${fmt(state.residual.distanceMm)} мм</b>
         ${state.residual.distanceMm > 200 ? " — заметно, проверьте точки/повторите калибровку." : ""}</div>`
      : "";
    overlay.innerHTML = `
      <div style="font-weight:600; margin-bottom:6px">Совместить по точкам</div>
      <div style="opacity:.75; margin-bottom:8px">Укажите одну и ту же физическую точку A СНАЧАЛА на только что
        загруженном FBX-файле, ПОТОМ на уже имеющейся геометрии объекта (конструктив из PDF/Revit — что угодно в
        этой 3D-сцене, кроме самих FBX-слоёв), затем так же вторую точку B — по ним считаются поворот и сдвиг.</div>
      ${pickRow("c1")}${pickRow("p1")}${pickRow("c2")}${pickRow("p2")}
      ${calibBlock}${warnBlock}
      <div style="margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,.2); opacity:${state.calib ? 1 : .4}">
        Контрольная точка (необязательно, не участвует в расчёте):
        ${pickRow("c3")}${pickRow("p3")}
        ${residualBlock}
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; justify-content:flex-end">
        <button type="button" data-act="cancel" style="padding:4px 10px; cursor:pointer">Отмена</button>
        <button type="button" data-act="apply" style="padding:4px 10px; cursor:pointer" ${state.calib ? "" : "disabled"}>Применить</button>
      </div>`;
    overlay.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", () => {
      activePick = activePick === btn.dataset.pick ? null : btn.dataset.pick;
      emit();
    }));
    overlay.querySelectorAll("[data-clear]").forEach((btn) => btn.addEventListener("click", () => {
      picks[btn.dataset.clear] = null;
      emit();
    }));
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => finish(false));
    overlay.querySelector('[data-act="apply"]').addEventListener("click", () => finish(true));
  }

  function computeState() {
    const ready = !!(picks.c1 && picks.p1 && picks.c2 && picks.p2);
    let calib = null;
    let warn = null;
    if (ready) {
      const uLen0 = Math.hypot(picks.c2[0] - picks.c1[0], picks.c2[1] - picks.c1[1]);
      const vLen0 = Math.hypot(picks.p2[0] - picks.p1[0], picks.p2[1] - picks.p1[1]);
      if (uLen0 < 1e-6 || vLen0 < 1e-6) {
        warn = "Точки A и B совпадают (или почти совпадают) — нужны РАЗНЫЕ, различимые ориентиры.";
      } else {
        calib = calibrateByPointPair(picks.c1, picks.c2, picks.p1, picks.p2, sourceAnchorXY, objectAnchorXY);
        if (Math.abs(calib.lengthDiffMm) > Math.max(50, 0.02 * calib.uLen)) {
          warn = `Расстояния не совпадают — модель и объект могут быть из разных источников, ` +
            `либо точки выбраны неверно. Масштаб не меняется, только поворот/сдвиг.`;
        }
      }
    }
    lastCalib = calib;
    let residual = null;
    if (calib && picks.c3 && picks.p3) {
      residual = residualForPoint(picks.c3, calib.theta, sourceAnchorXY, objectAnchorXY, [calib.offsetXMm, calib.offsetYMm], picks.p3);
    }
    return { calib, warn, residual };
  }

  function previewGroup(calib) {
    if (!calib) return;
    const p = [objectAnchorXY[0] + calib.offsetXMm, objectAnchorXY[1] + calib.offsetYMm, 0];
    const v = projectToView(p);
    group.position.set(v[0], v[1], v[2]);
    applyRotationPreview(group, calib.rotationDeg);
  }

  function emit() {
    const s = computeState();
    if (s.calib) previewGroup(s.calib);
    render(s);
  }

  function pointFromRaycast(kind, hit) {
    if (kind[0] === "c") {
      const local = group.worldToLocal(hit.point.clone());
      return [local.x + sourceAnchorXY[0], local.y + sourceAnchorXY[1]];
    }
    return viewToProjectXY([hit.point.x, hit.point.y, hit.point.z]);
  }

  function onPointerDown(e) {
    if (!activePick) return;
    const targets = activePick[0] === "c" ? [group] : targetObjects;
    const hit = raycastWithSnap({ THREE, e, canvas, camera, targets });
    if (!hit) return;
    picks[activePick] = pointFromRaycast(activePick, hit);
    activePick = null;
    e.preventDefault();
    e.stopImmediatePropagation();
    emit();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") finish(false);
  }

  function cleanup() {
    canvas.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (controls) controls.enabled = true;
    backdrop.classList.add("open");
  }

  function finish(commit) {
    if (finished) return;
    finished = true;
    cleanup();
    if (commit && lastCalib) {
      onApply({ offsetXMm: lastCalib.offsetXMm, offsetYMm: lastCalib.offsetYMm, rotationDeg: lastCalib.rotationDeg });
    } else {
      group.position.copy(armStartPos);
      group.quaternion.copy(armStartQuat);
      onCancel();
    }
  }

  if (controls) controls.enabled = false;
  backdrop.classList.remove("open");
  canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("keydown", onKeyDown);
  emit();

  return { ok: true, stop: () => finish(false) };
}

/**
 * «Применить привязку к другой модели» (Docs/fbx-placement-claude-prompt.md
 * §4) — переносит уже посчитанную/сохранённую привязку модели i (её
 * theta = -rotation_deg_i*PI/180, offset, anchors) на модель j так, чтобы
 * обе подчинялись одному P=R*C+t. НЕ проверяет совместимость исходников —
 * это явное решение пользователя, функция только считает числа.
 */
export function computeTransferToModel(modelI, modelJ) {
  const theta = (-Number(modelI.rotation_deg) * Math.PI) / 180;
  const sourceAnchorXY_i = [modelI.source_anchor_mm.x, modelI.source_anchor_mm.y];
  const objectAnchorXY_i = [modelI.object_anchor_mm.x, modelI.object_anchor_mm.y];
  const offsetXY_i = [modelI.offset_mm.x, modelI.offset_mm.y];
  const sourceAnchorXY_j = [modelJ.source_anchor_mm.x, modelJ.source_anchor_mm.y];
  const objectAnchorXY_j = [modelJ.object_anchor_mm.x, modelJ.object_anchor_mm.y];
  const [offsetXMm, offsetYMm] = transferPlacementXY(theta, sourceAnchorXY_i, objectAnchorXY_i, offsetXY_i, sourceAnchorXY_j, objectAnchorXY_j);
  const offsetZMm = transferPlacementZ(modelI.offset_mm.z, modelI.source_anchor_mm.z, modelJ.source_anchor_mm.z);
  return { offsetXMm, offsetYMm, offsetZMm, rotationDeg: modelI.rotation_deg };
}
