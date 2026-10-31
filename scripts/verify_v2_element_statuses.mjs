// Серверный перечень статусов, локальный шлюз V2 и проверки операций не должны расходиться.
// node scripts/verify_v2_element_statuses.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ELEMENT_STATUSES, ELEMENT_STATUS_LABELS } from "../app/static/v2/element-statuses.js";
import { checkWrite } from "../app/static/v2/write-gate.js";

const model = fileURLToPath(new URL("../app/models.py", import.meta.url));
// AST, без импорта приложения, БД и сторонних зависимостей Python.
const server = JSON.parse(execFileSync(process.env.ZHBI_TEST_PYTHON || "python3", ["-c", `
import ast,json,sys
from pathlib import Path
t=ast.parse(Path(sys.argv[1]).read_text())
c=next(n for n in t.body if isinstance(n,ast.ClassDef) and n.name=='Status')
members={n.targets[0].id:ast.literal_eval(n.value) for n in c.body if isinstance(n,ast.Assign)}
d=next(n.value for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='STATUS_LABELS_RU' for x in n.targets))
print(json.dumps({'statuses':list(members.values()),'labels':{members[k.attr]:ast.literal_eval(v) for k,v in zip(d.keys,d.values)}},ensure_ascii=False))
`, model], { encoding: "utf8" }));
assert.deepEqual(ELEMENT_STATUSES, server.statuses, "набор и порядок должны совпадать с сервером");
assert.deepEqual(ELEMENT_STATUS_LABELS, server.labels, "подписи должны совпадать с сервером");

const ready = "ready_for_installation";
const batch = { mode: "preview", object_id: 1, status: ready,
  items: [{ element_id: 1, expected_status: "delivered", expected_contract_id: null }] };
const allowed = (method, path, body) => {
  const verdict = checkWrite(method, path, body);
  assert.equal(verdict.allowed, true, `${path}: ${verdict.message}`);
};
allowed("POST", "/element-ops/status-batch", batch);
allowed("POST", "/element-ops/status-batch", { ...batch, mode: "apply", expect: { release_contracts: 0, without_contract: 1 } });
allowed("POST", "/element-ops/status-batch", { ...batch, items: [...batch.items, { ...batch.items[0], element_id: 2 }] });
allowed("POST", "/element-ops/status-batch", { ...batch, status: "installed", items: [{ ...batch.items[0], expected_status: ready }] });
allowed("POST", "/element-ops/status-rows", { ...batch, items: [{ ...batch.items[0], contract_id: null }] });
allowed("POST", "/element-ops/status-rows", { ...batch, status: "installed", items: [{ ...batch.items[0], expected_status: ready, contract_id: null }] });
allowed("POST", "/element-ops/contract", { element_id: 1, expected_status: ready, expected_contract_id: null, contract_id: 1 });
allowed("PATCH", "/elements/1/history/1", { status: ready });
assert.equal(checkWrite("POST", "/element-ops/status-batch", { ...batch, status: "not_a_status" }).allowed, false);
assert.equal(checkWrite("POST", "/element-ops/status-batch", { ...batch, items: [{ ...batch.items[0], expected_status: "not_a_status" }] }).allowed, false);
assert.equal(checkWrite("POST", "/element-ops/status-batch", { ...batch, unexpected: true }).allowed, false);
assert.equal(checkWrite("POST", "/element-ops/status-batch", { ...batch, mode: "apply" }).allowed, false);
assert.equal(checkWrite("POST", "/element-ops/status-batch", { ...batch, items: [batch.items[0], batch.items[0]] }).allowed, false);
console.log("OK: соответствие серверу; одиночная и групповая смена статуса, выход из готовности, построчная смена, контракт и история; отказы неизвестному статусу и некорректной пачке");
