// Самопроверка строк шлюза записи области «exchange»: форма multipart-запроса и JSON-тел (node scripts/v2_tests/exchange-gate.selftest.mjs).
// Каждая изменяющая операция обмена данными разрешена ТОЛЬКО с проверенной формой запроса; всё прочее (одношаговый DXF, PDF, перенос базы, настройки) остаётся отключённым.
import { checkWrite } from "../../app/static/v2/write-gate.js";
let ok = 0, bad = [];
const t = (cond, msg) => { if (cond) ok++; else bad.push(msg); };
const fd = (o = {}, name = "a.xlsx", size = 10) => { const f = new FormData(); f.append("file", new File([new Uint8Array(size)], name)); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const A = (m, p, b) => checkWrite(m, p, b).allowed;
// контрактация
t(A("POST", "/import-contracting-xlsx?object_id=2", fd()), "контрактация: верный запрос");
t(!A("POST", "/import-contracting-xlsx", fd()), "контрактация: без object_id");
t(!A("POST", "/import-contracting-xlsx?object_id=2&x=1", fd()), "контрактация: лишний параметр адреса");
t(!A("POST", "/import-contracting-xlsx?object_id=abc", fd()), "контрактация: object_id не число");
t(!A("POST", "/import-contracting-xlsx?object_id=2", fd({}, "a.txt")), "контрактация: расширение");
t(!A("POST", "/import-contracting-xlsx?object_id=2", fd({}, "a.xlsx", 0)), "контрактация: пустой файл");
t(!A("POST", "/import-contracting-xlsx?object_id=2", fd({ extra: "1" })), "контрактация: лишнее поле формы");
t(!A("POST", "/import-contracting-xlsx?object_id=2", { file: 1 }), "контрактация: не FormData");
t(!A("POST", "/import-contracting-xlsx?object_id=2", undefined), "контрактация: тела нет");
const two = fd(); two.append("file", new File([new Uint8Array(3)], "b.xlsx")); t(!A("POST", "/import-contracting-xlsx?object_id=2", two), "контрактация: два файла");
// график
t(A("POST", "/import-schedule-xlsx", fd({ object_id: "2", kind: "baseline" })), "график: baseline");
t(A("POST", "/import-schedule-xlsx", fd({ object_id: "2", kind: "current" })), "график: current");
t(!A("POST", "/import-schedule-xlsx", fd({ object_id: "2", kind: "x" })), "график: неверный вид");
t(!A("POST", "/import-schedule-xlsx", fd({ kind: "baseline" })), "график: без объекта");
// история / восстановление
t(A("POST", "/import-history-xlsx", fd({ source_file: "A.dxf", mode: "sync" })), "история: sync");
t(A("POST", "/import-history-xlsx", fd({ source_file: "A.dxf", mode: "replace" })), "история: replace");
t(!A("POST", "/import-history-xlsx", fd({ source_file: "A.dxf", mode: "xx" })), "история: неизвестный режим");
t(!A("POST", "/import-history-xlsx", fd({ source_file: "", mode: "sync" })), "история: пустой чертёж");
// сверка
t(A("POST", "/objects-import/analyze", fd()), "объекты: сверка");
t(A("POST", "/objects-import/apply", { changes: [{ kind: "create", key: "X" }] }), "объекты: применение");
t(!A("POST", "/objects-import/apply", { changes: [] }), "объекты: пустой список");
t(!A("POST", "/objects-import/apply", { changes: [{ kind: "drop", key: "X" }] }), "объекты: неизвестный вид правки");
t(!A("POST", "/objects-import/apply", { changes: [{ kind: "create", key: "X" }], evil: 1 }), "объекты: лишнее поле");
t(A("POST", "/elements/bulk-edit/analyze", fd({ mode: "fields" })), "bulk: сверка");
t(!A("POST", "/elements/bulk-edit/analyze", fd({ mode: "transfer" })), "bulk: режим переноса базы не разрешён");
t(A("POST", "/elements/bulk-edit/apply", { changes: [{ element_id: 1 }], mode: "fields", contracting_date: "2026-10-01" }), "bulk: применение с датой");
t(!A("POST", "/elements/bulk-edit/apply", { changes: [{ element_id: 1 }], mode: "statuses", contracting_date: "2026-10-01" }), "bulk: дата только для реквизитов");
t(!A("POST", "/elements/bulk-edit/apply", { changes: [{ element_id: 1 }], mode: "fields", contracting_date: "01.10.2026" }), "bulk: формат даты");
// чертёж
t(A("POST", "/import-dxf/analyze", fd({ object_id: "2" }, "p.dxf")), "dxf: разбор");
t(!A("POST", "/import-dxf/analyze", fd({ object_id: "2" }, "p.xlsx")), "dxf: расширение");
const tok = "a".repeat(32);
t(A("POST", "/import-dxf/apply", { token: tok, accept_mark_changes: true, keep_mark_element_ids: [], refill_manual_fields: { "5": ["mark"] }, create_new_zone_ids: [3] }), "dxf: применение");
t(!A("POST", "/import-dxf/apply", { token: "zz", accept_mark_changes: true, keep_mark_element_ids: [], refill_manual_fields: {}, create_new_zone_ids: [] }), "dxf: плохой токен");
t(!A("POST", "/import-dxf/apply", { token: tok, accept_mark_changes: "yes", keep_mark_element_ids: [], refill_manual_fields: {}, create_new_zone_ids: [] }), "dxf: решение не boolean");
t(!A("POST", "/import-dxf", fd({}, "p.dxf")), "dxf: одношаговая загрузка не разрешена");
// Revit
const rv = new FormData(); rv.append("object_id", "3"); rv.append("files", new File([new Uint8Array(5)], "a.zhbi.json.gz")); rv.append("files", new File([new Uint8Array(5)], "b.json"));
t(A("POST", "/import-revit/analyze", rv), "revit: два пакета");
const rv2 = new FormData(); rv2.append("object_id", "3"); t(!A("POST", "/import-revit/analyze", rv2), "revit: без файлов");
t(A("POST", "/import-revit/apply", { token: tok }), "revit: применение");
t(!A("POST", "/import-revit/apply", { token: tok, x: 1 }), "revit: лишнее поле");
// папка Input
t(A("POST", "/admin/import-input", { object_id: 3 }), "input: запуск");
t(!A("POST", "/admin/import-input", { object_id: null }), "input: без объекта");
t(!A("POST", "/admin/import-input", {}), "input: пустое тело");
// прочее по-прежнему отключено
t(!A("POST", "/settings/import", fd({}, "s.json")), "settings/import отключён");
t(!A("POST", "/import-pdf/apply", { token: tok }), "pdf apply отключён");
t(!A("POST", "/admin/db-transfer/apply", {}), "перенос базы отключён");
console.log(`проверок пройдено: ${ok}, не пройдено: ${bad.length}`); bad.forEach((b) => console.log("НЕ ПРОЙДЕНО:", b));
process.exit(bad.length ? 1 : 0);
