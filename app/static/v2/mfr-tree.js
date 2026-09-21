// Дерево видов работ («эт/сек», «кв.эт/сек») для форм «Состав работ блока» и отбора «Журнала факта».
// Дерево строится из путей («Раздел / Подраздел / Работа»); у узла — флажок на всю ветку с промежуточным состоянием.
// `partial` — виды работ, отмеченные только у ЧАСТИ выбранных блоков (групповая правка состава): в HTML не задаётся, ставится свойством.
import { esc } from "./screen-view.js";

export function workTypePathParts(path) {
  const parts = String(path || "").split(" / ");
  const name = parts.pop();
  return { name, crumb: parts.join(" / ") };
}

export function mountWorkTypeTree(host, options, selected, { partial = new Set(), disabled = false, onChange, search = true } = {}) {
  const sel = new Set(selected);
  const part = new Set(partial);
  let q = "";
  const root = { kids: new Map(), ops: [] };
  for (const o of options) {
    const path = String(o.path ?? o["путь"] ?? "").split(" / ");
    const name = path.pop();
    let node = root;
    for (const p of path) { if (!node.kids.has(p)) node.kids.set(p, { kids: new Map(), ops: [] }); node = node.kids.get(p); }
    node.ops.push({ id: o.id, name });
  }
  const collect = (node, out = []) => { for (const op of node.ops) out.push(op.id); for (const k of node.kids.values()) collect(k, out); return out; };
  let seq = 0;
  const branches = new Map();     // id ветки -> ids операций
  function html(node, depth) {
    let out = "";
    for (const [name, kid] of node.kids) {
      const ids = collect(kid);
      const shown = !q || ids.some((id) => (opName.get(id) || "").toLowerCase().includes(q)) || name.toLowerCase().includes(q);
      if (!shown) continue;
      const bid = `b${++seq}`;
      branches.set(bid, ids);
      out += `<div class="mfr-tree-branch"><label class="mfr-tree-group" style="padding-left:${depth * 16}px"><input type="checkbox" data-branch="${bid}" ${disabled ? "disabled" : ""}> <span>${esc(name)}</span></label>${html(kid, depth + 1)}</div>`;
    }
    for (const op of node.ops) {
      if (q && !op.name.toLowerCase().includes(q) && !nodeMatch(node, q)) continue;
      out += `<label class="mfr-tree-op" style="padding-left:${depth * 16}px"><input type="checkbox" data-op="${op.id}" ${sel.has(op.id) ? "checked" : ""} ${disabled ? "disabled" : ""}> <span>${esc(op.name || "(без названия)")}</span></label>`;
    }
    return out;
  }
  const opName = new Map(options.map((o) => [o.id, String(o.path ?? o["путь"] ?? "").split(" / ").pop()]));
  const nodeMatch = () => false;
  function paint() {
    branches.clear(); seq = 0;
    host.innerHTML = `${search ? `<input type="search" class="mfr-tree-search" placeholder="Найти вид работ" aria-label="Найти вид работ" value="${esc(q)}">` : ""}<div class="mfr-tree">${html(root, 0) || `<p class="v2-muted">Ничего не найдено.</p>`}</div>`;
    host.querySelectorAll("input[data-op]").forEach((cb) => { cb.indeterminate = part.has(Number(cb.dataset.op)) && !sel.has(Number(cb.dataset.op)); });
    refreshBranches();
    host.querySelector(".mfr-tree-search")?.addEventListener("input", (e) => {
      q = e.target.value.trim().toLowerCase(); paint();
      const s = host.querySelector(".mfr-tree-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length);
    });
    host.querySelectorAll("input[data-op]").forEach((cb) => cb.addEventListener("change", () => { const id = Number(cb.dataset.op); cb.checked ? sel.add(id) : sel.delete(id); part.delete(id); cb.indeterminate = false; refreshBranches(); onChange?.(); }));
    host.querySelectorAll("input[data-branch]").forEach((cb) => cb.addEventListener("change", () => {
      for (const id of branches.get(cb.dataset.branch) || []) { cb.checked ? sel.add(id) : sel.delete(id); part.delete(id); }
      paint(); onChange?.();
    }));
  }
  function refreshBranches() {
    host.querySelectorAll("input[data-branch]").forEach((cb) => {
      const ids = branches.get(cb.dataset.branch) || [];
      const on = ids.filter((id) => sel.has(id)).length, mixed = ids.filter((id) => part.has(id) && !sel.has(id)).length;
      cb.checked = ids.length > 0 && on === ids.length;
      cb.indeterminate = !cb.checked && (on > 0 || mixed > 0);
    });
  }
  paint();
  return {
    selected: () => [...sel],
    setDisabled(v) { disabled = v; paint(); },
    selectAll(on) { for (const o of options) { on ? sel.add(o.id) : sel.delete(o.id); part.delete(o.id); } paint(); onChange?.(); },
    reset(next) { sel.clear(); for (const id of next) sel.add(id); part.clear(); paint(); },
  };
}
