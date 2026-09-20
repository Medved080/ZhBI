import { runTests } from "/tests/helpers.js";

const params = new URLSearchParams(location.search);
const SUITES = ["shell", "ua", "po", "cp", "rd", "vis", "a11y"];
const wanted = (params.get("suite") || SUITES.join(",")).split(",").filter(Boolean);
const only = (params.get("only") || "").split(",").filter(Boolean); // список id или префиксов

let tests = [];
for (const name of wanted) {
  try {
    const m = await import(`/tests/scenarios/${name}.js`);
    tests = tests.concat(m.tests.map((t) => ({ ...t, suite: name })));
  } catch (e) {
    console.warn(`набор «${name}» не загружен:`, e.message);
  }
}
if (only.length) tests = tests.filter((t) => only.some((o) => t.id === o || t.id.startsWith(o)));

const tbody = document.querySelector("#tbl tbody");
const results = await runTests(tests, {
  onResult(r) {
    const tr = document.createElement("tr");
    const failed = r.checks.filter((c) => !c.ok);
    tr.innerHTML = `<td>${r.id}</td><td>${r.title}</td><td class="${r.status}">${r.status === "pass" ? "PASS" : "FAIL"}</td>
      <td>${r.checks.length - failed.length}/${r.checks.length}${failed.length ? `<pre>${failed.map((c) => "✗ " + c.msg).join("\n")}</pre>` : ""}${r.error ? `<pre>${r.error}</pre>` : ""}</td>`;
    tbody.append(tr);
  },
});
const failed = results.filter((r) => r.status !== "pass");
document.getElementById("summary").textContent =
  `Сценарии V2: ${results.length - failed.length} PASS / ${failed.length} FAIL из ${results.length}`;
document.title = `${failed.length ? "FAIL" : "PASS"} ${results.length - failed.length}/${results.length}`;
window.__results = results.map((r) => ({ id: r.id, title: r.title, status: r.status, failed: r.checks.filter((c) => !c.ok).map((c) => c.msg), error: r.error, checks: r.checks.length }));
// Сохранить результаты вместе с версией кода (стенд запишет Docs/v2-acceptance-results/<имя>.json).
try {
  const name = (params.get("save") || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (name) {
    const r = await fetch(`/save-results?name=${name}`, { method: "POST", body: JSON.stringify({ suites: wanted, only, results: window.__results }) });
    window.__saved = await r.json();
  }
} catch (e) { window.__saved = { error: String(e) }; }
window.__done = true;
