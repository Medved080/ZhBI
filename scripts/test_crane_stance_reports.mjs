// Screen data and exports must remain readable after a technical conversion.
// AUDIT_BASE_DB=data/zhbi.baseline.db node scripts/test_crane_stance_reports.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, sql1 } from "./audit_work/lib.mjs";
import { httpLogin } from "./reports2_verify/lib.mjs";

const work = mkdtempSync(join(tmpdir(), "crane-stance-reports-"));
try {
  const { base, db } = await startServer(8377, work);
  assert.equal(sql1(db, "SELECT count(*) FROM crane_zone_transition WHERE state='ready'"), 193);
  const client = await httpLogin(base, "admin");
  for (const [name, route, body] of [
    ["Статус комплектации", "completion", { object_id: 1, view: "pivot", group_by: ["crane"] }],
    ["График поставки", "delivery-schedule", { object_id: 1 }],
    ["Аналитическая справка", "analytics", { object_id: 1 }],
  ]) {
    const page = await client.post(`/reports/${route}`, body);
    assert.equal(page.status, 200, `${name}: экран ${page.text.slice(0, 300)}`);
    assert.ok(page.json && typeof page.json === "object", `${name}: нет данных отчёта`);
    for (const [extension, contentType] of [
      ["xlsx", "spreadsheetml.sheet"], ["pdf", "application/pdf"],
    ]) {
      const file = await client.post(`/reports/${route}.${extension}`, body);
      assert.equal(file.status, 200, `${name}: ${extension} ${file.text.slice(0, 300)}`);
      assert.ok(file.type?.includes(contentType), `${name}: тип ${extension}: ${file.type}`);
    }
    console.log(`PASS ${name}: экран, XLSX и PDF после конверсии`);
  }
} finally {
  await stopServer();
}
