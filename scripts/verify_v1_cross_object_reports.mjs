// Регрессия V1: после ЖБИ → МФР отчёты по блокам не должны отправлять
// source_file прежнего объекта. Только локальный сервер на копии БД.
// V1_CROSS_BASE=http://127.0.0.1:8371 node scripts/verify_v1_cross_object_reports.mjs
import { session, openV1, sleep } from "./audit_work/lib.mjs";

const BASE = process.env.V1_CROSS_BASE;
if (!BASE || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error("Укажите V1_CROSS_BASE на локальный обезличенный стенд");
let b, pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? ++pass : ++fail;
};
try {
  b = await session(BASE, "admin", { objectId: 1 });
  await openV1(b, BASE, 1);
  await b.waitFor(`state.elements.length > 0 && !!state.sourceFile`, 60000);
  const oldSource = await b.eval(`state.sourceFile`);
  await b.eval(`switchObject(4)`);
  await b.waitFor(`state.objectId === 4 && !state.sourceFile`, 60000);
  check("после смены ЖБИ → МФР источник прежнего чертежа сброшен", !!oldSource && await b.eval(`state.sourceFile === null`));

  for (const [key, endpoint] of [
    ["block_status", "/reports/block-status"],
    ["block_schedule", "/reports/block-schedule"],
    ["linear_track", "/reports/linear-track"],
  ]) {
    const start = b.requests.length;
    await b.eval(`switchReport(${JSON.stringify(key)})`);
    await b.waitFor(`!document.getElementById('report-status-line').textContent.includes('Построение')`, 60000);
    await sleep(350);
    const req = b.requests.slice(start).find((r) => r.url.endsWith(endpoint));
    const body = req?.body ? JSON.parse(req.body) : null;
    const status = await b.eval(`document.getElementById('report-status-line').textContent`);
    check(`${key}: отчёт построен по объекту 4 без старого source_file`,
      req?.status === 200 && body?.object_id === 4 && !body?.source_file && !status.includes("Не удалось"),
      `${req?.status ?? "нет запроса"}; ${status.slice(0, 90)}`);
  }
  await b.eval(`switchObject(1)`);
  await b.waitFor(`state.objectId === 1 && state.elements.length > 0 && !!state.sourceFile`, 60000);
  check("возврат МФР → ЖБИ загрузил источник текущего чертежа", await b.eval(`state.sourceFile === ${JSON.stringify(oldSource)}`));
  check("ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
} finally { await b?.close(); }
console.log(`Итого: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
