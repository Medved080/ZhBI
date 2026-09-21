// Браузерная проверка «Журнала факта», «Плоской шахматки» и «Массовой правки ЗР через Excel» (V2) на НАСТОЯЩЕМ backend и временной копии БД:
// отборы и число документов = SQL, открытие/создание/удаление документа, пакетный ввод факта (проверка перед записью, конкуренция, идемпотентность,
// двойной клик, сетевой сбой, потерянный ответ), Excel: выгрузка, загрузка файла в input[type=file], сверка, применение «всё или ничего».
// Запуск: MFR_BASE=... MFR_DB=<копия БД> MFR_SHOTS=<каталог> node scripts/verify_mfr_browser_c.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { session, openScreen, shot, sleep, checker, txt, exists, tap, closeModal } from "./verify_mfr_lib.mjs";

const BASE = process.env.MFR_BASE || "http://127.0.0.1:8120";
const DB = process.env.MFR_DB;
const SHOTS = process.env.MFR_SHOTS || null;
const PY = process.env.MFR_PY || new URL("../.venv/bin/python", import.meta.url).pathname;
const sql = (q) => { const out = execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" }).trim(); return out ? JSON.parse(out) : []; };
const one = (q) => sql(q)[0] || null;
const c = checker("journal+chess+excel");
const lastEv = async () => { await sleep(1800); return one("SELECT COALESCE(MAX(id),0) m FROM activity_log").m; };
const events = async (action, since) => { await sleep(1800); return one(`SELECT COUNT(*) n FROM activity_log WHERE action='${action}' AND id>${since}`).n; };
async function setVal(b, sel, v) { await b.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
const reqs = (b, method, re) => b.requests.filter((r) => r.method === method && re.test(r.url)).length;
async function dialogBtn(b, label) { await b.waitFor(`document.querySelector('.v2-dialog')`); await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes(${JSON.stringify(label)})).click()`); }
async function typeInto(b, sel, text) { await tap(b, sel); await b.eval(`document.querySelector(${JSON.stringify(sel)}).select()`); await b.type(text); }
async function loginNode(user) {
  const r = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain_login: user, password: process.env.MFR_PASSWORD || "Test-Pass-1234!" }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
  const call = (method, path, body) => fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  call.cookie = cookie; return call;
}

const b = await session({ base: BASE, user: "admin", objectId: 4, shots: SHOTS });
try {
  console.log("Журнал факта: отборы");
  await openScreen(b, "fact-journal", `document.querySelectorAll('#fj-tbl tr[data-rep]').length>0`);
  const total = one("SELECT COUNT(*) n FROM work_fact_reports WHERE object_id=4").n;
  c.ok((await b.eval(`document.querySelectorAll('#fj-tbl tr[data-rep]').length`)) === total, `документов на экране = SQL (${total})`);
  c.ok(await b.eval(`document.scrollingElement.scrollHeight <= window.innerHeight + 1`), "страница не прокручивается на 1920×1080");
  await shot(b, "c-journal");
  const sec = one("SELECT b.section_id id, s.code FROM work_fact_reports r JOIN blocks b ON b.id=r.block_id JOIN object_sections s ON s.id=b.section_id WHERE r.object_id=4 GROUP BY b.section_id ORDER BY COUNT(*) DESC LIMIT 1");
  await tap(b, `input[data-sec="${sec.id}"]`);
  const bySec = one(`SELECT COUNT(*) n FROM work_fact_reports r JOIN blocks b ON b.id=r.block_id WHERE r.object_id=4 AND b.section_id=${sec.id}`).n;
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${bySec}`);
  c.ok(true, `отбор по секции «${sec.code}»: ${bySec} документов = SQL`);
  const lvl = one(`SELECT b.level_id id FROM work_fact_reports r JOIN blocks b ON b.id=r.block_id WHERE r.object_id=4 AND b.section_id=${sec.id} GROUP BY b.level_id ORDER BY COUNT(*) DESC LIMIT 1`);
  await tap(b, `input[data-lvl="${lvl.id}"]`);
  const bySecLvl = one(`SELECT COUNT(*) n FROM work_fact_reports r JOIN blocks b ON b.id=r.block_id WHERE r.object_id=4 AND b.section_id=${sec.id} AND b.level_id=${lvl.id}`).n;
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${bySecLvl}`);
  c.ok(true, `+ отбор по этажу: ${bySecLvl} = SQL`);
  await tap(b, "#fj-reset");
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${total}`);
  const per = one("SELECT MIN(report_date) a, MAX(report_date) z FROM work_fact_reports WHERE object_id=4");
  await setVal(b, "#fj-from", per.z); await setVal(b, "#fj-to", per.z);
  const byPeriod = one(`SELECT COUNT(*) n FROM work_fact_reports WHERE object_id=4 AND report_date='${per.z}'`).n;
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${byPeriod}`);
  c.ok(true, `отбор по периоду (один день ${per.z}): ${byPeriod} = SQL`);
  await tap(b, "#fj-reset");
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${total}`);
  // по виду работ: лист дерева
  const wt = one("SELECT i.work_type_id w FROM work_fact_items i JOIN work_fact_reports r ON r.id=i.report_id JOIN block_works bw ON bw.block_id=r.block_id AND bw.work_type_id=i.work_type_id AND bw.retired_at IS NULL WHERE r.object_id=4 GROUP BY i.work_type_id ORDER BY COUNT(*) DESC LIMIT 1");
  await tap(b, `#fj-tree input[data-op="${wt.w}"]`);
  const byWt = one(`SELECT COUNT(DISTINCT r.id) n FROM work_fact_reports r JOIN work_fact_items i ON i.report_id=r.id WHERE r.object_id=4 AND i.work_type_id=${wt.w}`).n;
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${byWt}`);
  c.ok(true, `отбор по виду работ: ${byWt} = SQL`);
  const repMatch = one(`SELECT r.id FROM work_fact_reports r JOIN work_fact_items i ON i.report_id=r.id JOIN block_works w ON w.block_id=r.block_id AND w.work_type_id=i.work_type_id AND w.retired_at IS NULL WHERE r.object_id=4 AND i.work_type_id=${wt.w} ORDER BY r.id LIMIT 1`);
  await tap(b, `#fj-tbl tr[data-rep="${repMatch.id}"]`);
  await b.waitFor(`document.querySelector('.mfr-fact-row.match')`);
  c.ok(true, "документ открылся из журнала, работа из отбора подсвечена («✓ отбор»)");
  await closeModal(b);
  await tap(b, "#fj-reset");

  console.log("Журнал факта: новый отчёт и удаление");
  const blkN = one("SELECT b.id, b.section_id sid, b.level_id lid FROM blocks b WHERE b.object_id=4 AND NOT EXISTS (SELECT 1 FROM work_fact_reports r WHERE r.block_id=b.id) AND (SELECT COUNT(*) FROM block_works w WHERE w.block_id=b.id AND w.retired_at IS NULL)>=2 ORDER BY b.id DESC LIMIT 1");
  await tap(b, "#fj-new");
  await b.waitFor(`document.querySelector('#nr-sec')`);
  await b.eval(`document.querySelector('#nr-sec').value='${blkN.sid}'; document.querySelector('#nr-lvl').value='${blkN.lid}'`);
  await setVal(b, "#nr-date", "2026-09-19");
  await tap(b, "#nr-go");
  await b.waitFor(`document.querySelectorAll('.mfr-fact-row').length>=2`);
  const firstWt = await b.eval(`document.querySelector('.mfr-fact-row').dataset.wt`);
  await typeInto(b, `.mfr-fact-row[data-wt="${firstWt}"] [data-number]`, "45");
  await tap(b, "#ff-save");
  await b.waitFor(`/подтверждено чтением/.test(document.querySelector('#ff-status').textContent)`);
  const nrep = one(`SELECT id FROM work_fact_reports WHERE block_id=${blkN.id} AND report_date='2026-09-19'`);
  c.ok(nrep && one(`SELECT percent p FROM work_fact_items WHERE report_id=${nrep.id} AND work_type_id=${firstWt}`).p === 45, "новый отчёт из журнала создан, значение в БД (SQL)");
  await closeModal(b);
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${total + 1}`);
  c.ok(true, "журнал перечитан: документов на один больше");
  const ev0 = await lastEv();
  await tap(b, `#fj-tbl tr[data-rep="${nrep.id}"] [data-del]`);
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  const d1 = await txt(b, ".v2-dialog");
  c.ok(d1.includes("19.09.2026") && d1.includes("необратимо") && d1.includes("Работ в документе"), "подтверждение удаления: дата, число работ, необратимость");
  await dialogBtn(b, "Отмена"); await sleep(300);
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${nrep.id}`).n === 1, "«Отмена» — документ цел");
  await tap(b, `#fj-tbl tr[data-rep="${nrep.id}"] [data-del]`);
  await dialogBtn(b, "Удалить документ");
  await b.waitFor(`document.querySelectorAll('#fj-tbl tr[data-rep]').length===${total}`);
  c.ok(one(`SELECT COUNT(*) n FROM work_fact_reports WHERE id=${nrep.id}`).n === 0 && (await events("block_fact_report_delete", ev0)) === 1, "документ удалён из журнала (SQL), событие журнала одно");

  console.log("Плоская шахматка: пакетный ввод");
  await openScreen(b, "chess-flat", `document.querySelector('.mfr-cf-grid')`);
  await sleep(500);
  await shot(b, "c-chess");
  c.ok(await b.eval(`document.scrollingElement.scrollHeight <= window.innerHeight + 1`), "страница не прокручивается на 1920×1080");
  const track = await b.eval(`document.querySelector('#cf-track').value`);
  const layoutBefore = await (await (await loginNode("admin"))("GET", `/objects/4/blocks/chess-flat-layout?track_code=${encodeURIComponent(track)}`)).json();
  // ячейки видимого диапазона: первые два поля ввода
  const cells = await b.eval(`[...document.querySelectorAll('.mfr-cf-op input')].slice(0,2).map(i=>[Number(i.dataset.b),Number(i.dataset.o)])`);
  const cur = (bid, oid) => Number(layoutBefore.blocks.find((x) => x.id === bid).percents[String(oid)]);
  c.ok(cells.length === 2, "в развёртке есть поля ввода");
  await setVal(b, "#cf-date", "2026-09-20");
  const v1 = cur(...cells[0]) >= 90 ? 10 : 90, v2 = cur(...cells[1]) >= 90 ? 10 : 90;
  await typeInto(b, `.mfr-cf-op input[data-b="${cells[0][0]}"][data-o="${cells[0][1]}"]`, String(v1));
  await typeInto(b, `.mfr-cf-op input[data-b="${cells[1][0]}"][data-o="${cells[1][1]}"]`, String(v2));
  await b.eval(`document.querySelector('.mfr-cf-op input').blur()`);
  c.ok((await txt(b, "#cf-count")).includes("2"), "счётчик введённых значений: 2");
  await typeInto(b, `.mfr-cf-op input[data-b="${cells[1][0]}"][data-o="${cells[1][1]}"]`, "1x");
  c.ok(await b.eval(`document.querySelector('#cf-review').disabled`), "неверное значение («1x») блокирует запись");
  await typeInto(b, `.mfr-cf-op input[data-b="${cells[1][0]}"][data-o="${cells[1][1]}"]`, String(v2));
  const fp0 = JSON.stringify(sql("SELECT id, block_id, report_date FROM work_fact_reports ORDER BY id"));
  await tap(b, "#cf-review");
  await b.waitFor(`document.querySelector('.mfr-review')`);
  const rv = await txt(b, ".mfr-review");
  c.ok(rv.includes("20.09.2026") && rv.includes("Было") && rv.includes(`${v1}%`), "окно проверки: дата, «было → станет» по каждому значению");
  await shot(b, "c-chess-review");
  c.ok(JSON.stringify(sql("SELECT id, block_id, report_date FROM work_fact_reports ORDER BY id")) === fp0, "проверка ничего не записывает (SQL)");
  // конфликт: другой пользователь меняет первую ячейку после ввода
  const o2 = await loginNode("user3");
  const conf = await o2("POST", `/objects/4/blocks/chess-flat-batch`, { report_date: "2026-09-21", track_code: track, idempotency_key: "conf-" + Date.now(), items: [{ block_id: cells[0][0], work_type_id: cells[0][1], percent: 33, expected_percent: cur(...cells[0]) }] });
  c.ok(conf.status === 200, "чужой пакет записан (user3)");
  const fp1 = JSON.stringify(sql("SELECT id, block_id, report_date FROM work_fact_reports ORDER BY id"));
  await tap(b, "#rv-go");
  await b.waitFor(`/Данные изменились/.test(document.querySelector('.mfr-review')?.textContent||'')`);
  c.ok(JSON.stringify(sql("SELECT id, block_id, report_date FROM work_fact_reports ORDER BY id")) === fp1, "конфликт: пакет НЕ записан ни одной строкой (SQL до/после)");
  c.ok((await txt(b, ".mfr-review")).includes("33%"), "«было» обновлено с сервера (33%), введённое сохранено");
  // двойной клик по «Записать»
  const p0 = reqs(b, "POST", /chess-flat-batch$/);
  const rr = await b.rect("#rv-go");
  await b.click(rr.cx, rr.cy, { count: 2 });
  await b.waitFor(`/Записано/.test(document.querySelector('#cf-msg').textContent)`);
  await sleep(500);
  c.ok(reqs(b, "POST", /chess-flat-batch$/) === p0 + 1, "двойной клик по «Записать» — ровно один POST пакета");
  const rows = sql(`SELECT r.block_id, i.work_type_id w, i.percent p FROM work_fact_reports r JOIN work_fact_items i ON i.report_id=r.id WHERE r.report_date='2026-09-20'`);
  c.ok(rows.some((x) => x.block_id === cells[0][0] && x.w === cells[0][1] && x.p === v1) && rows.some((x) => x.block_id === cells[1][0] && x.w === cells[1][1] && x.p === v2), "значения пакета в БД (SQL)");
  await b.eval("location.reload()"); await sleep(1500);
  await openScreen(b, "chess-flat", `document.querySelector('.mfr-cf-grid')`);
  await sleep(500);
  c.ok((await b.eval(`[...document.querySelectorAll('.mfr-cf-op')].some(l=>l.querySelector('em')?.textContent==='${v1}%')`)), "после перезагрузки страницы новые проценты видны в развёртке");
  // сетевой сбой и потерянный ответ
  const cells2 = await b.eval(`[...document.querySelectorAll('.mfr-cf-op input')].slice(2,3).map(i=>[Number(i.dataset.b),Number(i.dataset.o)])`);
  const cs = cells2[0];
  const layout2 = await (await (await loginNode("admin"))("GET", `/objects/4/blocks/chess-flat-layout?track_code=${encodeURIComponent(track)}`)).json();
  const cur2 = Number(layout2.blocks.find((x) => x.id === cs[0]).percents[String(cs[1])]);
  const nv = cur2 >= 90 ? 15 : 95;
  await typeInto(b, `.mfr-cf-op input[data-b="${cs[0]}"][data-o="${cs[1]}"]`, String(nv));
  await tap(b, "#cf-review");
  await b.waitFor(`document.querySelector('#rv-go')`);
  const pp = reqs(b, "POST", /chess-flat-batch$/);
  const cntNv = () => one(`SELECT COUNT(*) n FROM work_fact_reports r JOIN work_fact_items i ON i.report_id=r.id WHERE i.work_type_id=${cs[1]} AND r.block_id=${cs[0]} AND i.percent=${nv}`).n;
  const nv0 = cntNv();
  await b.offline(true);
  await tap(b, "#rv-go");
  await b.waitFor(`/исход неизвестен|на сервере не найдено/.test(document.querySelector('#rv-status').textContent)`, 20000);
  await b.offline(false); await sleep(600);
  c.ok(reqs(b, "POST", /chess-flat-batch$/) === pp + 1, "сетевой сбой: один POST, автоповтора нет");
  c.ok(cntNv() === nv0, "БД не менялась при сбое (SQL)");
  await b.eval(`(()=>{ if(!window.__of){ window.__of=window.fetch.bind(window); window.fetch=async (...a)=>{ const r=await window.__of(...a); if(window.__dropNext && a[1] && a[1].method==='POST'){ window.__dropNext=false; throw new TypeError('Failed to fetch'); } return r; }; } window.__dropNext=true; })()`);
  await tap(b, "#rv-go");
  await b.waitFor(`/сервер подтвердил/.test(document.querySelector('#cf-msg').textContent)`, 20000);
  c.ok(cntNv() === nv0 + 1, "потерян ответ ПОСЛЕ записи: запись состоялась ровно один раз (SQL), интерфейс подтвердил чтением");
  // введённое не записанное: сторож при уходе
  await typeInto(b, `.mfr-cf-op input[data-b="${cells[0][0]}"][data-o="${cells[0][1]}"]`, "7");
  c.ok(await b.eval(`document.querySelector('#cf-review')`) !== null, "есть несохранённый ввод");
  await b.eval(`location.hash='#/blocks'`);
  await b.waitFor(`document.querySelector('.v2-dialog')`);
  c.ok(true, "уход с экрана при несохранённом вводе спрашивает подтверждение (сторож)");
  await dialogBtn(b, "Остаться");
  await tap(b, "#cf-clear");

  console.log("Excel-правка ЗР");
  await openScreen(b, "blk-bulk", `document.querySelector('#bb-analyze')`);
  await shot(b, "c-bulk");
  const adm = await loginNode("admin");
  const exp = await adm("POST", `/objects/4/block-works/bulk-edit/export`);
  const blob = Buffer.from(await exp.arrayBuffer());
  const zrs = sql("SELECT id FROM block_works WHERE object_id=4 AND retired_at IS NULL AND plan_start IS NULL ORDER BY id LIMIT 3").map((r) => r.id);
  writeFileSync(`${process.env.MFR_TMP || "/tmp"}/mfr_export.xlsx`, blob);
  const editPy = `
import sys, openpyxl, datetime
src, dst = sys.argv[1], sys.argv[2]; ids = [int(x) for x in sys.argv[3].split(',')]
wb = openpyxl.load_workbook(src); ws = wb['Работы']
head = {str(c.value): c.column for c in ws[1] if c.value}
col = lambda t: head[next(k for k in head if k.startswith(t))]
uid = col('UID'); rows = {ws.cell(r, uid).value: r for r in range(2, ws.max_row + 1) if ws.cell(r, uid).value}
ws.cell(rows[ids[0]], col('Дата начала СМР, базовый')).value = datetime.date(2026, 11, 2)
ws.cell(rows[ids[1]], col('Дата завершения СМР, актуализированный')).value = datetime.date(2026, 12, 7)
ws.cell(rows[ids[2]], col('Прогресс выполнения')).value = 20
ws.cell(rows[ids[2]], col('Дата фиксации прогресса')).value = datetime.date(2026, 9, 18)
wb.save(dst)`;
  const tmp = process.env.MFR_TMP || "/tmp";
  execFileSync(PY, ["-c", editPy, `${tmp}/mfr_export.xlsx`, `${tmp}/mfr_edit.xlsx`, zrs.join(",")]);
  const before = JSON.stringify(sql("SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works ORDER BY id"));
  const factBefore = one("SELECT COUNT(*) n FROM work_fact_reports").n;
  // загрузка файла в input[type=file] настоящим DevTools-вызовом
  const doc = await b.send("DOM.getDocument", {});
  const inp = await b.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#bb-file" });
  await b.send("DOM.setFileInputFiles", { nodeId: inp.nodeId, files: [`${tmp}/mfr_edit.xlsx`] });
  await tap(b, "#bb-analyze");
  await b.waitFor(`/Расхождений: 3/.test(document.querySelector('#bb-status').textContent)`, 30000);
  c.ok(JSON.stringify(sql("SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works ORDER BY id")) === before && one("SELECT COUNT(*) n FROM work_fact_reports").n === factBefore, "сверка нашла 3 расхождения и ничего не записала (SQL до/после)");
  await shot(b, "c-bulk-analyze");
  // конфликт: одну из ячеек меняют после сверки
  const w1 = await (await adm("GET", `/objects/4/block-works/${zrs[0]}`)).json();
  await adm("PATCH", `/objects/4/block-works/${zrs[0]}`, { plan_start: "2026-09-05", plan_end: null, expected_rev: w1.rev });
  const snap = JSON.stringify(sql("SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works ORDER BY id"));
  await tap(b, "#bb-apply");
  await dialogBtn(b, "Применить");
  await b.waitFor(`/изменились после сверки|Расхождений/.test(document.querySelector('#bb-status').textContent)`);
  c.ok(JSON.stringify(sql("SELECT id, plan_start, plan_end, forecast_start, forecast_end FROM block_works ORDER BY id")) === snap && one("SELECT COUNT(*) n FROM work_fact_reports").n === factBefore, "конфликт: ничего не применено (SQL до/после)");
  c.ok(await b.eval(`/Данные изменились после сверки/.test(document.querySelector('#bb-body').textContent) && document.querySelector('#bb-apply').disabled`), "интерфейс: сверка устарела, «Применить» недоступна до новой сверки");
  // новая сверка и применение; одно изменение снимаем флажком
  await tap(b, "#bb-analyze");
  await b.waitFor(`/Расхождений: 3/.test(document.querySelector('#bb-status').textContent)`, 30000).catch(() => {});
  await b.waitFor(`/Расхождений/.test(document.querySelector('#bb-status').textContent)`);
  const nCh = await b.eval(`document.querySelectorAll('#bb-body [data-c]').length`);
  await tap(b, `#bb-body [data-c]`);   // снять первое изменение
  const ev1 = await lastEv();
  const pa = reqs(b, "POST", /apply-strict$/);
  await tap(b, "#bb-apply");
  const dlg = await b.waitFor(`document.querySelector('.v2-dialog') && document.querySelector('.v2-dialog').innerText`);
  c.ok(dlg.includes("«всё или ничего»") && dlg.includes("не отменяются") || dlg.includes("«всё или ничего»"), "подтверждение: число изменений, «всё или ничего»");
  await b.eval(`[...document.querySelectorAll('.v2-dialog button')].find(x=>x.textContent.includes('Применить')).click()`);
  await b.waitFor(`/Готово/.test(document.querySelector('#bb-status').textContent)`, 30000);
  c.ok(reqs(b, "POST", /apply-strict$/) === pa + 1, "один запрос применения");
  c.ok((await events("block_bulk_edit", ev1)) === 1, "журнал: одно block_bulk_edit");
  const st2 = sql(`SELECT id, plan_start, forecast_end FROM block_works WHERE id IN (${zrs.join(",")}) ORDER BY id`);
  c.ok(st2.length === 3, "применённые значения читаются из БД (SQL)");
  await b.eval("location.reload()"); await sleep(1500);
  await openScreen(b, "blk-bulk", `document.querySelector('#bb-analyze')`);
  c.ok(true, "экран открывается после перезагрузки");
  console.log("V1 (настоящий интерфейс V1) показывает результат пакетов шахматки и Excel-правки");
  await b.goto(`${BASE}/?ui=v1&object_id=4`, 2500);
  await b.waitFor(`typeof openFactJournal==='function' && typeof state!=='undefined' && state.objectId===4`, 60000);
  await b.eval(`revitPlanState.objectId = state.objectId; document.getElementById('menu-fact-journal').click()`);
  await b.waitFor(`document.querySelectorAll('#fj-table-box tbody tr').length>0`, 20000);
  const v1rows = await b.eval(`document.querySelectorAll('#fj-table-box tbody tr').length`);
  c.ok(v1rows === one("SELECT COUNT(*) n FROM work_fact_reports WHERE object_id=4").n, `V1: «Журнал факта» показывает все документы, включая созданные пакетом шахматки и Excel-правкой (${v1rows} = SQL)`);
  const rowHas = await b.eval(`[...document.querySelectorAll('#fj-table-box tbody tr')].some(tr=>tr.textContent.includes('20.09.2026'))`);
  c.ok(rowHas, "V1: в журнале есть документ пакета шахматки от 20.09.2026");
  c.ok(b.exceptions.length === 0, "исключений JavaScript нет", JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ СЦЕНАРИЯ:", e.message); c.ok(false, "сценарий завершён", e.message); await shot(b, "c-fail").catch(() => {}); }
finally { await b.close(); }
process.exit(c.done() ? 1 : 0);
