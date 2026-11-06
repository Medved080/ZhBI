// Regression: V2 must use the report permission, including read-only roles.
// Run: node scripts/test_delivery_recon_access.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { screenAllowed, screenNotApplicable } from "../app/static/v2/registry.js";

const registry = JSON.parse(await readFile(new URL("../app/static/v2/screens.json", import.meta.url)));
const structure = JSON.parse(await readFile(new URL("../app/static/v2/screen-structure.json", import.meta.url)));
const screen = registry.screens.find((s) => s.id === "report-delivery-recon");
assert.ok(screen);

for (const level of ["read", "write", "none"]) {
  const rights = { system_admin: false, features: { report_delivery_recon: level }, not_applicable: [] };
  assert.equal(screenAllowed(screen, structure[screen.id], rights), level !== "none", `report access: ${level}`);
  assert.equal(screenNotApplicable(screen, structure[screen.id], rights), false);
}
const mfr = { system_admin: false, features: { report_delivery_recon: "write" }, not_applicable: ["report_delivery_recon"] };
for (const system_admin of [false, true]) {
  const rights = { ...mfr, system_admin };
  assert.equal(screenAllowed(screen, structure[screen.id], rights), false, "unavailable on MFR objects");
  assert.equal(screenNotApplicable(screen, structure[screen.id], rights), true);
}
assert.equal(screenAllowed(screen, structure[screen.id], { system_admin: true }), true);
assert.equal(screenAllowed(screen, structure[screen.id], { features: { report_completion: "write" } }), false);

// Catch malformed entries before they silently hide another screen for regular users.
for (const s of registry.screens) {
  for (const field of ["feature", "menuFeatures"]) {
    if (s[field] === undefined) continue;
    assert.ok(Array.isArray(s[field]), `${s.id}.${field}: expected list`);
    for (const item of s[field]) {
      assert.ok(Array.isArray(item) && item.length === 2, `${s.id}.${field}: expected [keys, access]`);
      const [keys, access] = item;
      assert.ok(["read", "write"].includes(access), `${s.id}.${field}: invalid access`);
      const names = Array.isArray(keys) ? keys : [keys];
      assert.ok(names.length > 0 && names.every((key) => typeof key === "string" && key.length > 0), `${s.id}.${field}: invalid keys`);
    }
  }
}
console.log("PASS: delivery reconciliation read/write/none, admin, object kind and V2 permission schema");
