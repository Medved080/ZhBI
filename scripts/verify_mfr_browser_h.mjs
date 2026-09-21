// Сетевые отказы у оставшихся опасных операций (V2, настоящий backend, копия БД): Excel-правка ЗР (двойная отправка, обрыв сети, потерянный ответ после записи),
// состав работ (обрыв, потерянный ответ), удаление документа факта из журнала (обрыв, потерянный ответ). Во всех случаях: автоповтора нет, исход сверяется чтением,
// БД до/после совпадает с тем, что говорит интерфейс, повторной записи нет.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { session, openScreen, shot, sleep, checker, txt, exists, tap, closeModal } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const TMP = process.env.MFR_TMP || "/tmp";
const PY = process.env.MFR_PY || new URL("../.venv/bin/python", import.meta.url).pathname;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("network-faults");
const reqs = (b, method, re) => b.requests.filter((r) => r.method === method && re.test(r.url)).length;
async function dialogBtn(b, label) { await b.waitFor(`document.querySelector('.v2-dialog')`); await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`); }
async function loginNode(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: process.env.MFR_PASSWORD || "Test-Pass-1234!" }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
  return (method, path, body) => fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
}
const dropNext = (b, methods) => b.eval(`(()=>{ if(!window.__of){ window.__of=window.fetch.bind(window); window.fetch=async (...a)=>{ const r=await window.__of(...a); if(window.__dropNext && a[1] && (window.__dropMethods||[]).includes(a[1].method)){ window.__dropNext=false; throw new TypeError('Failed to fetch'); } return r; }; } window.__dropMethods=${JSON.stringify(methods)}; window.__dropNext=true; })()`);   // ответ приходит от сервера, но страница его «теряет»
const state = () => JSON.stringify(sql("SELECT id, plan_start, plan_end, forecast_start, forecast_end, retired_at FROM block_works ORDER BY id")) + JSON.stringify(sql("SELECT id FROM work_fact_reports ORDER BY id"));

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
try {
  const adm = await loginNode("admin");
  console.log("Excel-правка ЗР: двойная отправка, обрыв, потерянный ответ");
  await openScreen(b, "blk-bulk", `document.querySelector('#bb-analyze')`);
  const exp = await adm("POST", `/objects/4/block-works/bulk-edit/export`);
  writeFileSync(`${TMP}/h_export.xlsx`, Buffer.from(await exp.arrayBuffer()));
  const zrs = sql("SELECT id FROM block_works WHERE object_id=4 AND retired_at IS NULL AND plan_start IS NULL ORDER BY id LIMIT 3").map((r) => r.id);
  const edit = (out, d1, d2, pct) => execFileSync(PY, ["-c", `
import sys, openpyxl, datetime
src, dst = sys.argv[1], sys.argv[2]; ids = [int(x) for x in sys.argv[3].split(',')]
wb = openpyxl.load_workbook(src); ws = wb['Работы']
head = {str(c.value): c.column for c in ws[1] if c.value}
col = lambda t: head[next(k for k in head if k.startswith(t))]
uid = col('UID'); rows = {ws.cell(r, uid).value: r for r in range(2, ws.max_row + 1) if ws.cell(r, uid).value}
ws.cell(rows[ids[0]], col('Дата начала СМР, базовый')).value = datetime.date.fromisoformat(sys.argv[4])
ws.cell(rows[ids[1]], col('Дата завершения СМР, актуализированный')).value = datetime.date.fromisoformat(sys.argv[5])
ws.cell(rows[ids[2]], col('Прогресс выполнения')).value = int(sys.argv[6]); ws.cell(rows[ids[2]], col('Дата фиксации прогресса')).value = datetime.date(2026, 9, 18)
wb.save(dst)`, `${TMP}/h_export.xlsx`, out, zrs.join(","), d1, d2, String(pct)]);
  async function upload(path) {
    const doc = await b.send("DOM.getDocument", {});
    const inp = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#bb-file" });
    await b.send("DOM.setFileInputFiles", { nodeId: inp.nodeId, files: [path] });
    await tap(b, "#bb-analyze");
    await b.waitFor(`/Расхождений: 3/.test(document.querySelector('#bb-status').textContent)`, 30000);
  }
  // 1) обрыв сети при применении
  edit(`${TMP}/h_e1.xlsx`, "2026-11-02", "2026-12-07", 20);
  await upload(`${TMP}/h_e1.xlsx`);
  const s0 = state(); const pa0 = reqs(b, "POST", /apply-strict$/);
  await tap(b, "#bb-apply"); await b.offline(true); await dialogBtn(b, "Применить");
  await b.waitFor(`/на сервере не найдено|исход неизвестен|повторной сверки/.test(document.querySelector('#bb-status').textContent)`, 25000);
  await b.offline(false); await sleep(600);
  c.ok(reqs(b, "POST", /apply-strict$/) === pa0 + 1 && state() === s0, "Excel: обрыв сети — один запрос, автоповтора нет, БД не менялась (SQL)");
  c.ok(await b.eval(`document.querySelector('#bb-apply') !== null`), "Excel: после обрыва отмеченные изменения остались на экране (повтор — только вручную)");
  // 2) потерянный ответ ПОСЛЕ записи
  await dropNext(b, ["POST"]);
  await tap(b, "#bb-apply"); await dialogBtn(b, "Применить");
  await b.waitFor(`/повторная сверка файла подтвердила|Применено/.test(document.querySelector('#bb-body').textContent)`, 30000);
  c.ok(state() !== s0 && reqs(b, "POST", /apply-strict$/) === pa0 + 2, "Excel: потерян ответ ПОСЛЕ записи — запись состоялась ровно один раз (SQL), интерфейс подтвердил повторной сверкой файла");
  c.ok(one(`SELECT plan_start p FROM block_works WHERE id=${zrs[0]}`).p === "2026-11-02" && one(`SELECT COUNT(*) n FROM work_fact_reports r JOIN work_fact_items i ON i.report_id=r.id WHERE r.report_date='2026-09-18' AND i.percent=20`).n >= 1, "Excel: значения из файла в БД (срок и документ факта)");
  // 3) двойной клик по подтверждению
  edit(`${TMP}/h_e2.xlsx`, "2026-11-09", "2026-12-14", 25);
  await upload(`${TMP}/h_e2.xlsx`);
  const pa1 = reqs(b, "POST", /apply-strict$/);
  await tap(b, "#bb-apply"); await b.waitFor(`document.querySelector('.v2-dialog')`);
  const bt = await b.eval(`(()=>{const x=[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes('Применить')).getBoundingClientRect(); return {x:x.x+x.width/2,y:x.y+x.height/2}})()`);
  await b.click(bt.x, bt.y, { count: 2 });
  await b.waitFor(`/Готово/.test(document.querySelector('#bb-status').textContent)`, 30000);
  await sleep(500);
  c.ok(reqs(b, "POST", /apply-strict$/) === pa1 + 1, "Excel: двойной клик по подтверждению — ровно один запрос применения");

  console.log("Состав работ: обрыв и потерянный ответ");
  await openScreen(b, "blocks", `document.querySelectorAll('.mfr-blk').length>5`);
  const blk = one("SELECT b.id FROM blocks b WHERE b.object_id=4 AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=4 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) ORDER BY b.id DESC LIMIT 1");
  const wt = one(`SELECT work_type_id w FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL ORDER BY id DESC LIMIT 1`).w;
  await tap(b, `.mfr-blk[data-b="${blk.id}"]`);
  await b.waitFor(`document.querySelectorAll('tr[data-bw]').length>0`);
  await tap(b, "#bs-settings"); await b.waitFor(`document.querySelector('input[data-op]')`);
  await tap(b, `input[data-op="${wt}"]`); await tap(b, "#ss-preview-btn"); await b.waitFor(`document.querySelector('#ss-apply')`);
  const sA = state(); const pp0 = reqs(b, "PUT", /work-types-settings$/);
  await b.offline(true);
  await tap(b, "#ss-apply");
  if (await exists(b, ".v2-dialog")) await dialogBtn(b, "Применить");
  await b.waitFor(`/на сервере не найдено|исход неизвестен/.test(document.querySelector('#ss-status').textContent)`, 25000);
  await b.offline(false); await sleep(600);
  c.ok(reqs(b, "PUT", /work-types-settings$/) === pp0 + 1 && state() === sA, "Состав работ: обрыв сети — один PUT, автоповтора нет, БД не менялась (SQL)");
  await dropNext(b, ["PUT"]);
  await tap(b, "#ss-apply");
  if (await exists(b, ".v2-dialog")) await dialogBtn(b, "Применить");
  await b.waitFor(`/сервер подтвердил/.test(document.querySelector('#ss-status').textContent)`, 25000);
  c.ok(state() !== sA && reqs(b, "PUT", /work-types-settings$/) === pp0 + 2, "Состав работ: потерян ответ ПОСЛЕ записи — запись состоялась (SQL), интерфейс подтвердил чтением, повтора нет");
  await closeModal(b);

  console.log("Журнал факта: удаление документа — обрыв и потерянный ответ");
  const kw = sql(`SELECT work_type_id w FROM block_works WHERE block_id=${blk.id} AND retired_at IS NULL ORDER BY id`).map((r) => r.w);
  const mk = async (d) => (await (await adm("POST", `/objects/4/blocks/${blk.id}/fact-reports`, { report_date: d, items: { [kw[0]]: 11 } })).json()).id;
  const r1 = await mk("2026-09-01"), r2 = await mk("2026-09-02");
  await openScreen(b, "fact-journal", `document.querySelectorAll('#fj-tbl tr[data-rep]').length>0`);
  await tap(b, `#fj-tbl tr[data-rep="${r1}"] [data-del]`); await b.waitFor(`document.querySelector('.v2-dialog')`);
  const pd0 = reqs(b, "DELETE", /fact-reports\/\d+/);
  await b.offline(true); await dialogBtn(b, "Удалить документ");
  await b.waitFor(`/на сервере не найдено|исход неизвестен|Ответ не получен/.test(document.querySelector('#fj-msg').textContent)`, 25000);
  await b.offline(false); await sleep(600);
  c.ok(reqs(b, "DELETE", /fact-reports\/\d+/) === pd0 + 1 && one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${r1}`).n === 1, "Журнал: обрыв при удалении — один DELETE, документ цел (SQL)");
  await dropNext(b, ["DELETE"]);
  await tap(b, `#fj-tbl tr[data-rep="${r1}"] [data-del]`); await dialogBtn(b, "Удалить документ");
  await b.waitFor(`/сервер подтвердил/.test(document.querySelector('#fj-msg').textContent)`, 25000);
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${r1}`).n === 0 && reqs(b, "DELETE", /fact-reports\/\d+/) === pd0 + 2, "Журнал: потерян ответ ПОСЛЕ удаления — документ удалён (SQL), интерфейс подтвердил чтением, повтора нет");
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${r2}`).n === 1, "соседний документ не тронут");
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет", JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "h-fail").catch(() => {}); }
finally { await b.close(); }
process.exit(c.done() ? 1 : 0);
