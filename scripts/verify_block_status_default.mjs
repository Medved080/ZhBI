// Сверка дерева «Учёт по блокам: статусы» V2/V1 на локальной копии БД.
// BLOCK_TREE_BASE=http://127.0.0.1:8371 node scripts/verify_block_status_default.mjs
import { session, openScreen, openV1, tap, sleep } from "./audit_work/lib.mjs";

const BASE = process.env.BLOCK_TREE_BASE;
if (!BASE || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error("Укажите BLOCK_TREE_BASE на локальный обезличенный стенд");
let b, pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  ok ? ++pass : ++fail;
};
try {
  b = await session(BASE, "admin", { objectId: 4 });
  await openScreen(b, "report-block-status", `!!document.querySelector('.v2-matrix tbody tr')`);
  const full = await b.eval(`({all:document.querySelector('#bs-all').checked, rows:document.querySelectorAll('.v2-matrix tbody tr').length, nodes:document.querySelectorAll('.v2-matrix tr.rw-node').length})`);
  check("V2 по умолчанию показывает всё дерево WBS", full.all && full.nodes > 0, `${full.rows} строк, ${full.nodes} разделов`);
  await tap(b, "#bs-all");
  await sleep(350);
  const short = await b.eval(`({all:document.querySelector('#bs-all').checked, rows:document.querySelectorAll('.v2-matrix tbody tr').length})`);
  check("снятие галочки оставляет операции с данными", !short.all && short.rows > 0 && short.rows < full.rows, `${short.rows} < ${full.rows}`);
  await b.eval(`(()=>{const x=document.querySelector('input[data-param="report_date"]'); x.value='2026-09-01'; x.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await b.waitFor(`document.querySelector('.v2-matrix tbody tr') && document.querySelector('#bs-all')`, 30000);
  await sleep(400);
  check("смена даты сохраняет выбранный компактный режим", await b.eval(`!document.querySelector('#bs-all').checked`));

  await openV1(b, BASE, 4);
  await b.eval(`(()=>{document.getElementById('reports-backdrop').classList.add('open'); switchReport('block_status');})()`);
  await b.waitFor(`!!document.querySelector('#wp-matrix-table tbody tr')`, 30000);
  const v1 = await b.eval(`document.querySelectorAll('#wp-matrix-table tbody tr').length`);
  check("полное дерево V2 совпадает с V1 по числу строк", full.rows === v1, `V2 ${full.rows}, V1 ${v1}`);
  check("ошибок JavaScript нет", b.exceptions.length === 0, b.exceptions.slice(0, 2).join("; "));
} finally { await b?.close(); }
console.log(`Итого: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
