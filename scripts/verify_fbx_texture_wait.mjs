// Ожидание текстур при загрузке внешней FBX-модели (app/static/external-models/fbx.js): модель БЕЗ текстур не должна ждать
// тайм-аут (раньше — всегда 20 с: onLoad менеджера не зовётся, когда загрузок не было вовсе), модель С текстурой — дожидаться её,
// зависшая текстура — тайм-аута, текстура с ошибкой — попасть в предупреждения. Загрузчик подставной (FBXLoader — явная
// зависимость loadExternalModelFbx), заголовок FBX — настоящий, от scripts/gen_synthetic_fbx.py.
// Запуск: node scripts/verify_fbx_texture_wait.mjs
import * as THREE from "../app/static/vendor/three/three.module.min.js";
import { loadExternalModelFbx } from "../app/static/external-models/fbx.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fbx-wait-"));
const fbxPath = join(dir, "m.fbx");
execFileSync(".venv/bin/python", ["scripts/gen_synthetic_fbx.py", fbxPath], { stdio: "ignore" });
const bytes = readFileSync(fbxPath);
rmSync(dir, { recursive: true, force: true });
const buf = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// Подставной загрузчик: parse() отдаёт группу с одним мешем и (по сценарию) «загружает текстуру» через менеджер, как FBXLoader.
function fakeLoader(scenario) {
  return class {
    constructor(manager) { this.manager = manager; }
    parse() {
      const m = this.manager;
      if (scenario === "ok") { m.itemStart("tex.png"); setTimeout(() => m.itemEnd("tex.png"), 300); }
      if (scenario === "hang") m.itemStart("tex.png");
      if (scenario === "error") { m.itemStart("bad.png"); setTimeout(() => { m.itemError("bad.png"); m.itemEnd("bad.png"); }, 100); }
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
      return g;
    }
  };
}

let fails = 0;
const check = (ok, name, detail = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
async function run(scenario, limits = {}) {
  const t0 = Date.now();
  const r = await loadExternalModelFbx({ arrayBuffer: buf(), THREE, FBXLoader: fakeLoader(scenario), limits });
  return { ms: Date.now() - t0, r };
}

let x = await run("none");
check(x.ms < 1500, "без текстур — без ожидания тайм-аута (тайм-аут 20 с)", `${x.ms} мс`);
x = await run("ok");
check(x.ms >= 280 && x.ms < 3000, "текстура грузится 300 мс — модель её дожидается", `${x.ms} мс`);
x = await run("hang", { textureTimeoutMs: 600 });
check(x.ms >= 580 && x.ms < 3000, "зависшая текстура — ожидание до тайм-аута (600 мс)", `${x.ms} мс`);
x = await run("error");
const warns = JSON.stringify(x.r.warnings || x.r.meta?.warnings || x.r);
check(/Не удалось загрузить текстуру: bad\.png/.test(warns), "текстура с ошибкой — в предупреждениях", `${x.ms} мс`);
console.log(`\nИтого: ${4 - fails} ok / ${fails} FAIL из 4`);
process.exit(fails ? 1 : 0);
