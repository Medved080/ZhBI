// «Статус комплектации», перечень: колонки V2 — ровно колонки ответа сервера, как рисует V1 (renderCompletionReport берёт
// data.columns целиком, включая GUID); GUID — моноширинный и приглушённый (V1 .cmp-guid); страница целиком не прокручивается
// ни на 1920×1080, ни на 1366×768 (таблица — в своей области). Настоящий backend, настоящий вход формой V2.
// Запуск: node scripts/reports2_verify/chk_completion_guid.mjs
import { startServer, stopServer, check, summary, sleep, SP, responseJson, waitReq } from "./lib.mjs";
import { session, openScreen } from "../verify_mfr_lib.mjs";

const S = await startServer(8346, `${SP}/r2_guid`);
let b;
try {
  b = await session({ base: S.base, user: "admin", objectId: 1 });
  const from = b.requests.length;
  await openScreen(b, "report-completion", `/Позиций/.test(document.querySelector('#rd-report')?.textContent||'')`);
  const req = await waitReq(b, /\/reports\/completion$/, from);
  const data = await responseJson(b, req);
  const serverCols = data.columns.map((c) => c.label);
  const ths = await b.eval(`[...document.querySelectorAll('#rd-report table.v2-read-tbl thead th')].map((t) => t.textContent.trim())`);
  check("перечень: заголовки V2 = колонки ответа сервера (как V1)", JSON.stringify(ths) === JSON.stringify(serverCols), `V2 ${ths.length} / сервер ${serverCols.length}: ${ths.join(" | ")}`);
  const guidCol = data.columns.findIndex((c) => c.key === "guid");
  check("колонка GUID в ответе сервера есть и показана", guidCol >= 0 && ths[guidCol] === data.columns[guidCol].label);
  const cell = await b.eval(`(()=>{const td=document.querySelector('#rd-report table.v2-read-tbl tbody tr td:nth-child(${guidCol + 1})'); if(!td) return null; const s=getComputedStyle(td); return {type: td.dataset.colType, font: s.fontFamily, text: td.textContent.trim()};})()`);
  const firstGuid = data.rows.find((r) => r.guid)?.guid || "";
  check("GUID — моноширинный (тип «code»), значение из ответа", !!cell && cell.type === "code" && /mono|Menlo|Consolas/i.test(cell.font) && (!firstGuid || cell.text === String(data.rows[0].guid ?? "")), JSON.stringify(cell));
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await b.viewport(w, h); await sleep(400);
    const m = await b.eval(`(()=>{const d=document.scrollingElement; return {sw:d.scrollWidth, iw:innerWidth};})()`);
    check(`${w}×${h}: страница не прокручивается по горизонтали (таблица — в своей области)`, m.sw <= m.iw + 2, JSON.stringify(m));
  }
  check("нет ошибок JavaScript", b.exceptions.length === 0, JSON.stringify(b.exceptions.slice(0, 2)));
} catch (e) { console.log("СБОЙ:", e.stack || e); check("сценарий выполнен без сбоя", false, e.message); }
finally { if (b) await b.close(); await stopServer(); }
process.exit(summary() ? 1 : 0);
