// Самопроверка строк шлюза записи области «exchange»: форма multipart-запроса и JSON-тел (node scripts/v2_tests/exchange-gate.selftest.mjs).
// Каждая изменяющая операция обмена данными разрешена ТОЛЬКО с проверенной формой запроса; всё прочее (одношаговый DXF, PDF, перенос базы, одношаговый settings/import V1) остаётся отключённым.
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
// настройки (экспорт/импорт): сверка и применение по digest — обе через multipart .json
const dg = "a".repeat(64);
t(A("POST", "/settings/import/analyze", fd({}, "s.json")), "settings: сверка");
t(!A("POST", "/settings/import/analyze", fd({}, "s.xlsx")), "settings: расширение");
t(!A("POST", "/settings/import/analyze", fd({ extra: "1" }, "s.json")), "settings: лишнее поле формы");
t(A("POST", "/settings/import/apply", fd({ digest: dg }, "s.json")), "settings: применение по digest");
t(!A("POST", "/settings/import/apply", fd({}, "s.json")), "settings: без digest");
t(!A("POST", "/settings/import/apply", fd({ digest: "abc" }, "s.json")), "settings: digest не похож на sha256");
t(!A("POST", "/settings/import/apply", fd({ digest: dg }, "s.xlsx")), "settings: применение — расширение");
// прочее по-прежнему отключено
t(!A("POST", "/settings/import", fd({}, "s.json")), "settings/import (одношаговый V1-эндпоинт) в V2 отключён — только analyze/apply");
// панели облицовки шахты: разбор (толщина — необязательное поле формы) и применение по токену
t(A("POST", "/shaft-panels/analyze", fd({ object_id: "1" }, "p.dxf")), "shaft: разбор без толщины");
t(A("POST", "/shaft-panels/analyze", fd({ object_id: "1", thickness_mm: "300" }, "p.dxf")), "shaft: разбор с толщиной");
t(!A("POST", "/shaft-panels/analyze", fd({ thickness_mm: "300" }, "p.dxf")), "shaft: без объекта");
t(!A("POST", "/shaft-panels/analyze", fd({ object_id: "1", thickness_mm: "0" }, "p.dxf")), "shaft: нулевая толщина");
t(!A("POST", "/shaft-panels/analyze", fd({ object_id: "1" }, "p.xlsx")), "shaft: расширение");
t(A("POST", "/shaft-panels/apply", { token: tok, acknowledged_warnings: ["plan_joint"], retire_missing: false }), "shaft: применение");
t(!A("POST", "/shaft-panels/apply", { token: tok, acknowledged_warnings: ["plan_joint"] }), "shaft: без retire_missing");
t(!A("POST", "/shaft-panels/apply", { token: "zz", acknowledged_warnings: [], retire_missing: false }), "shaft: короткий токен");
t(A("DELETE", "/shaft-panels/pending/" + tok, undefined), "shaft: отмена анализа своим токеном");
t(!A("DELETE", "/shaft-panels/pending/zz", undefined), "shaft: отмена — короткий токен в адресе");
// загрузка из PDF: фоновый разбор (полный) и синхронный разбор (только фасады), применение по токену, отладочная очистка
t(A("POST", "/import-pdf/analyze/start", fd({ object_id: "3" }, "p.pdf")), "pdf: запуск фонового разбора");
t(!A("POST", "/import-pdf/analyze/start", fd({}, "p.pdf")), "pdf: без объекта");
t(!A("POST", "/import-pdf/analyze/start", fd({ object_id: "3" }, "p.xlsx")), "pdf: расширение");
t(A("POST", "/import-pdf/apply", { token: tok }), "pdf: применение по токену");
t(!A("POST", "/import-pdf/apply", { token: tok, x: 1 }), "pdf: лишнее поле");
t(A("POST", "/import-pdf-facade/analyze", fd({ object_id: "3" }, "p.pdf")), "pdf facade: разбор");
t(A("POST", "/import-pdf-facade/apply", { token: tok }), "pdf facade: применение по токену");
t(A("POST", "/objects/3/clear-import-data", { source: "pdf", elements: true, structure: false, work: false }), "pdf: отладочная очистка (помещения)");
t(!A("POST", "/objects/3/clear-import-data", { source: "pdf", elements: false, structure: false, work: false }), "pdf: очистка без отмеченной группы");
t(!A("POST", "/objects/3/clear-import-data", { source: "xlsx", elements: true, structure: false, work: false }), "pdf: очистка — неизвестный источник");
t(!A("POST", "/admin/db-transfer/apply", {}), "перенос базы отключён");
// внешние 3D-модели (FBX): загрузка (метаданные — JSON-строка формы), правка размещения (со сверкой версии), перецентровка, удаление
const emMeta = (o = {}) => JSON.stringify({ kind: "ground", source_anchor_mm: { x: 0, y: 0, z: 0 }, ...o });
t(A("POST", "/objects/1/external-models", fd({ meta: emMeta() }, "m.fbx")), "external-models: загрузка");
t(!A("POST", "/objects/1/external-models", fd({ meta: emMeta() }, "m.obj")), "external-models: расширение");
t(!A("POST", "/objects/1/external-models", fd({ meta: emMeta({ kind: "roof" }) }, "m.fbx")), "external-models: неизвестный вид");
t(!A("POST", "/objects/1/external-models", fd({ meta: "not json" }, "m.fbx")), "external-models: метаданные не JSON");
t(A("PATCH", "/objects/1/external-models/5", { expected_revision: 3, offset_x_mm: 100, rotation_deg: 10 }), "external-models: правка размещения");
t(!A("PATCH", "/objects/1/external-models/5", { offset_x_mm: 100 }), "external-models: правка без версии для сверки");
t(A("PATCH", "/objects/1/external-models/5", { expected_revision: 3, auto_placement_status: "confident" }), "external-models: авто-совмещение V2 разрешено со сверкой версии");
t(!A("PATCH", "/objects/1/external-models/5", { expected_revision: 3, auto_placement_status: "unknown" }), "external-models: неизвестный статус автосовмещения запрещён");
t(A("POST", "/objects/1/external-models/5/recenter", { expected_revision: 3 }), "external-models: перецентровка");
t(!A("POST", "/objects/1/external-models/5/recenter", {}), "external-models: перецентровка без версии");
t(A("DELETE", "/objects/1/external-models/5", undefined), "external-models: удаление");
console.log(`проверок пройдено: ${ok}, не пройдено: ${bad.length}`); bad.forEach((b) => console.log("НЕ ПРОЙДЕНО:", b));
process.exit(bad.length ? 1 : 0);
