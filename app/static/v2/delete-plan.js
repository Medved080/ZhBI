// Удаление записи контрактации (контрагент, договор, спецификация) ПО ПЛАНУ ПОСЛЕДСТВИЙ — тот же серверный порядок, что у V1
// (app/dict_delete.py): проверка → замена ссылок → удаление, всё в одной транзакции под блокировкой записи, с откатом при отказе стража покрытия.
//
// Что показывает человеку: что именно уйдёт (подчинённые записи и позиции), что держит запись (изделия, история, контракт по умолчанию) и —
// если на запись или подчинённых кто-то ссылается — выбор замены для КАЖДОЙ записи поддерева (иерархия владельцев соблюдается: список замен
// подчинённой записи зависит от выбранной замены её владельца, `GET /dictionaries/{kind}/candidates?key=&parent=`). Режим «свёртка дублей»
// (перенос подчинённых к другой записи) здесь не предлагается — он остаётся отключённым шлюзом.
//
// Защита от устаревшего плана: непосредственно перед удалением план читается заново; если он изменился (кто-то добавил договор,
// привязал изделие) — удаление НЕ выполняется, человеку показывается новый план. Неизвестный исход (обрыв связи) не повторяется:
// существование записи проверяется чтением. Контракт удаляется отдельным потоком в counterparties.js (свой пикер замены).
import { showConfirmDialog, showInfoDialog } from "./dialogs.js";
import { ApiError } from "./api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nodeId = (n) => `${n.kind}:${n.key}`;

// Сигнатура плана: всё, от чего зависит, что будет удалено и что потребуется заменить
function planSignature(node) {
  return JSON.stringify([node.kind, node.key, !!node.needs_replacement, (node.refs || []).map((r) => [r.label, r.count]),
    (node.cascade || []).map((c) => [c.label, c.count]), (node.blockers || []).length, (node.children || []).map(planSignature)]);
}

function flatten(node, parent = null, depth = 0, out = []) {
  out.push({ node, parent, depth });
  for (const ch of node.children || []) flatten(ch, node, depth + 1, out);
  return out;
}

// Сводка «что уйдёт вместе с записью»: подчинённые узлы и позиции (cascade)
export function consequencesText(node, withLabel) {
  const counts = new Map();
  const add = (name, n) => { if (n > 0) counts.set(name, (counts.get(name) || 0) + n); };
  const walk = (n) => {
    for (const c of n.cascade || []) add(c.label, c.count || 0);
    for (const ch of n.children || []) { add(ch.kind_title, 1); walk(ch); }
  };
  if (node) walk(node);
  return counts.size ? ` Вместе с ${withLabel} удалятся: ${[...counts].map(([name, n]) => `${name}: ${n}`).join(", ")}.` : "";
}

const refsText = (n) => (n.refs || []).map((r) => `${r.label}: ${r.count}`).join(", ");

// Окно выбора замен — и, если запись «сворачиваема» (mergeable), выбора режима «перенести подчинённые» (свёртка дублей) вместо «заменить каждую
// по отдельности» (тот же выбор, что в V1: по умолчанию — перенос, когда он возможен, замена ничего не теряет только у ошибочной записи).
// В режиме переноса показывается ТОЛЬКО корень — подчинённые переезжают целиком, выбирать им нечего.
// Отправку выполняет `submit(replacements, mode)` внутри окна: при отказе сервера окно остаётся открытым, выбор сохраняется, человек
// может поправить выбор или отменить (повторной отправки без него нет). submit → {done:true, result, info?} | {error:"текст"}. Возвращает итог потока.
function openReplacementDialog({ api, plan, title, lead, submit, mergeable = false, adoptTitle = "" }) {
  return new Promise((resolve) => {
    const rows = flatten(plan);
    let mode = mergeable ? "merge" : "replace";
    const choice = new Map();                 // nodeId -> выбранный ключ замены
    const cands = new Map();                  // nodeId -> {parentKey, list|null, error}
    let busy = false;
    const previouslyFocused = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "v2-dialog-backdrop";
    document.body.appendChild(backdrop);

    // Режим «merge» — только корень (переезжают подчинённые целиком); «replace» — вся ветка, только узлы со ссылками.
    const needRows = () => (mode === "merge" ? [rows[0]] : rows.filter((r) => r.node.needs_replacement));
    const displayRows = () => (mode === "merge" ? [rows[0]] : rows);
    const parentChoice = (r) => (r.parent ? choice.get(nodeId(r.parent)) ?? null : null);
    async function loadCands(r) {
      const id = nodeId(r.node), pk = parentChoice(r);
      if (r.parent && needRows().some((x) => x.node === r.parent) && !pk) { cands.set(id, { parentKey: null, list: null, error: "" }); return; }
      const cur = cands.get(id);
      if (cur && cur.parentKey === pk && (cur.list || cur.error)) return;
      cands.set(id, { parentKey: pk, list: null, error: "", loading: true });
      paint();
      try {
        const q = new URLSearchParams({ key: r.node.key });
        if (pk) q.set("parent", pk);
        const list = await api.get(`/dictionaries/${r.node.kind}/candidates?${q}`);
        if (cands.get(id)?.parentKey === pk) cands.set(id, { parentKey: pk, list, error: "" });
      } catch (err) {
        if (cands.get(id)?.parentKey === pk) cands.set(id, { parentKey: pk, list: null, error: err?.detail || "Не удалось получить список замен" });
      }
      paint();
    }
    async function refreshAll() { for (const r of needRows()) await loadCands(r); }
    async function switchMode(next) {
      if (mode === next) return;
      mode = next; choice.clear(); cands.clear();
      paint();
      await refreshAll();
    }

    const complete = () => needRows().every((r) => choice.get(nodeId(r.node)));
    function paint(errorText = "") {
      const focusedId = backdrop.contains(document.activeElement) ? document.activeElement.dataset?.dpSel : null;
      const need = needRows();
      const modeChoice = !mergeable ? "" : `<div class="v2-callout" role="radiogroup" aria-label="Что сделать с подчинёнными записями" style="margin:8px 0">
        <label style="display:block"><input type="radio" name="dp-mode" value="merge" ${mode === "merge" ? "checked" : ""} ${busy ? "disabled" : ""}/>
          Перенести ${esc(adoptTitle || "подчинённые записи")} к другой записи <span class="v2-muted">— свернуть задвоенное: содержимое переедет целиком, совпавшие по номеру сольются</span></label>
        <label style="display:block"><input type="radio" name="dp-mode" value="replace" ${mode === "replace" ? "checked" : ""} ${busy ? "disabled" : ""}/>
          Заменить каждую запись по отдельности <span class="v2-muted">— годится, когда запись ошибочна и её содержимое не нужно</span></label></div>`;
      backdrop.innerHTML = `<div class="v2-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:720px;max-height:calc(100vh - 48px);overflow:auto">
        <h3 style="margin:0 0 8px;font-size:16px">${esc(title)}</h3>
        <p style="white-space:pre-line">${esc(lead)}</p>
        ${modeChoice}
        <div id="dp-tree">${displayRows().map((r) => {
          const n = r.node, id = nodeId(n), needs = need.some((x) => x.node === n), c = cands.get(id);
          const sel = !needs ? `<span class="v2-muted">уходит без замены</span>` : !c || c.loading ? `<span class="v2-muted">${r.parent && need.some((x) => x.node === r.parent) && !parentChoice(r) ? "сначала выберите замену выше" : "загрузка вариантов…"}</span>`
            : c.error ? `<span class="v2-auth-error">${esc(c.error)}</span>`
            : !c.list.length ? `<span class="v2-auth-error">заменить нечем — заведите другую запись «${esc(n.kind_title)}» у выбранного владельца</span>`
            : `<select data-dp-sel="${esc(id)}" aria-label="Замена: ${esc(n.kind_title)} «${esc(n.label)}»" ${busy ? "disabled" : ""}><option value="">— выберите замену —</option>${c.list.map((o) => `<option value="${esc(o.key)}" ${String(choice.get(id)) === String(o.key) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
          return `<div style="margin:6px 0 6px ${r.depth * 20}px"><div><strong>${esc(n.kind_title)}</strong> «${esc(n.label)}»${refsText(n) ? ` <small class="v2-muted">— ссылки: ${esc(refsText(n))}</small>` : ""}${(n.cascade || []).length ? ` <small class="v2-muted">— уйдёт: ${esc((n.cascade || []).map((x) => `${x.label}: ${x.count}`).join(", "))}</small>` : ""}</div><div>${sel}</div></div>`;
        }).join("")}</div>
        <p class="v2-muted" style="margin:12px 0 4px">${mode === "merge" ? "Подчинённые записи переедут к выбранной, совпавшие по номеру сольются; затем опустевшая запись удаляется." : "Ссылки (изделия, записи истории, контракт по умолчанию) переносятся на выбранные замены, затем запись и её подчинённые удаляются."} Всё выполняется одной операцией: при отказе (например, в замене нет позиции под марку изделий) ничего не изменится.</p>
        <div class="v2-auth-error" id="dp-error" role="alert">${esc(errorText)}</div>
        <div class="v2-dialog-actions"><button type="button" class="v2-btn" data-dp="cancel" ${busy ? "disabled" : ""}>Отмена</button><button type="button" class="v2-btn v2-danger" data-dp="ok" ${!complete() || busy ? "disabled" : ""}>${busy ? (mode === "merge" ? "Перенос…" : "Удаление…") : (mode === "merge" ? "Подтвердить перенос и удалить" : "Подтвердить замену и удалить")}</button></div>
      </div>`;
      backdrop.querySelectorAll('input[name="dp-mode"]').forEach((r) => r.addEventListener("change", () => switchMode(r.value)));
      backdrop.querySelectorAll("[data-dp-sel]").forEach((s) => s.addEventListener("change", async () => {
        const id = s.dataset.dpSel;
        choice.set(id, s.value || undefined);
        // смена замены владельца обнуляет выбор у всех его подчинённых и перечитывает их варианты
        const idx = rows.findIndex((r) => nodeId(r.node) === id);
        const owner = rows[idx];
        const below = rows.filter((r) => { let p = r.parent; while (p) { if (p === owner.node) return true; p = rows.find((x) => x.node === p)?.parent || null; } return false; });
        for (const b of below) { choice.delete(nodeId(b.node)); cands.delete(nodeId(b.node)); }
        paint();
        await refreshAll();
      }));
      backdrop.querySelector('[data-dp="cancel"]').addEventListener("click", () => finish("cancelled"));
      backdrop.querySelector('[data-dp="ok"]').addEventListener("click", async () => {
        if (busy || !complete()) return;
        const replacements = {};
        for (const r of needRows()) replacements[nodeId(r.node)] = String(choice.get(nodeId(r.node)));
        busy = true; paint();                         // блокировка ДО первого await: двойной щелчок — один запрос
        let res;
        try { res = await submit(replacements, mode); } catch (err) { res = { error: err?.detail || err?.message || "Не удалось удалить" }; }
        if (res.done) { finish(res.result, res.info); return; }
        busy = false; paint(res.error || "");
      });
      const target = (focusedId && backdrop.querySelector(`[data-dp-sel="${CSS.escape(focusedId)}"]`)) || backdrop.querySelector("select:not([disabled])") || backdrop.querySelector('[data-dp="cancel"]');
      target?.focus();
    }
    function finish(result, info) {
      document.removeEventListener("keydown", onKey, true); backdrop.remove(); previouslyFocused?.focus?.();
      resolve({ result, info });
    }
    function onKey(e) {
      if (busy) { if (e.key === "Escape") e.preventDefault(); return; }
      if (e.key === "Escape") { e.preventDefault(); finish("cancelled"); }
      else if (e.key === "Tab") {
        const items = [...backdrop.querySelectorAll("button:not([disabled]), select:not([disabled])")];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    paint();
    refreshAll();
  });
}

// Отправка удаления. «deleted» — сервер подтвердил (или проверка после обрыва показала, что записи уже нет); «exists» — обрыв, запись на месте;
// «unknown» — обрыв и проверить не удалось. Определённый отказ сервера — исключение ApiError (ничего не изменено: операция атомарна).
async function postDelete(api, kind, id, body) {
  try { await api.post(`/dictionaries/${kind}/${id}/delete`, body); return "deleted"; }
  catch (err) {
    if (!(err instanceof ApiError) || err.status !== 0) throw err;
    try { await api.get(`/dictionaries/${kind}/${id}/delete-plan`); return "exists"; }
    catch (e2) { return e2 instanceof ApiError && e2.status === 404 ? "deleted" : "unknown"; }
  }
}

const KIND_TEXT = { counterparty: ["контрагента", "контрагентом"], agreement: ["договор", "договором"], specification: ["спецификацию", "спецификацией"] };

/** Полный поток удаления. Возвращает "deleted" | "cancelled" | "failed" | "exists" | "unknown"; сообщения об ошибках показывает сам. */
export async function runDeleteFlow({ api, kind, id }) {
  const [what, withWhat] = KIND_TEXT[kind];
  let plan;
  try { plan = await api.get(`/dictionaries/${kind}/${id}/delete-plan`); }
  catch (err) { await showInfoDialog(err?.detail || err?.message || "Не удалось получить сведения об удалении"); return "failed"; }
  if (plan.blockers?.length) {
    await showInfoDialog(`Удалить нельзя. Мешает:\n${plan.blockers.map((b) => `${b.owner}: ${b.label}${b.count != null ? ` (${b.count})` : ""}`).join("\n")}`);
    return "failed";
  }
  const consequences = consequencesText(plan.plan, withWhat);
  const mergeable = !!plan.plan.mergeable;

  // Сама отправка. План перечитывается НЕПОСРЕДСТВЕННО перед удалением: за время выбора его мог изменить другой пользователь
  const submit = async (replacements, mode = "replace") => {
    try {
      const fresh = await api.get(`/dictionaries/${kind}/${id}/delete-plan`);
      if (planSignature(fresh.plan) !== planSignature(plan.plan) || fresh.blockers?.length) {
        return { done: true, result: "failed", info: "Пока вы выбирали, состав удаляемого изменился (другой пользователь добавил или изменил записи). Ничего не удалено — откройте удаление заново и проверьте новый план." };
      }
    } catch (err) {
      return { error: `Не удалось перечитать план удаления — ничего не удалено: ${err?.detail || err?.message || ""}` };
    }
    let outcome;
    try { outcome = await postDelete(api, kind, id, { replacements, mode }); }
    catch (err) { return { error: err?.detail || err?.message || "Не удалось удалить" }; }   // отказ определённый: ничего не изменено
    if (outcome === "exists") return { done: true, result: "exists", info: "Ответ сервера не получен, запись осталась на месте (проверено чтением). Ничего не отправлено повторно — повторите удаление вручную." };
    if (outcome === "unknown") return { done: true, result: "unknown", info: "Ответ сервера не получен, и проверить результат не удалось: исход неизвестен. Ничего не отправлено повторно — обновите страницу и проверьте список." };
    return { done: true, result: "deleted" };
  };

  if (plan.plan.needs_replacement || mergeable) {
    const r = await openReplacementDialog({
      api, plan: plan.plan, title: `Удалить ${what} «${plan.plan.label}»`, submit, mergeable, adoptTitle: plan.plan.adopt_title,
      lead: `${plan.plan.needs_replacement ? "На запись или на её подчинённые записи ссылаются данные системы." : "У записи есть подчинённые."}${consequences}\n${mergeable ? "Выберите, что сделать с подчинёнными записями." : "Выберите, на что заменить каждую запись — ссылки будут перенесены на замену."}`,
    });
    if (r.info) await showInfoDialog(r.info);
    return r.result;
  }
  if (!(await showConfirmDialog(`Удалить ${what}?${consequences}`, { confirmLabel: "Удалить", danger: true }))) return "cancelled";
  const res = await submit({});
  if (res.error) { await showInfoDialog(res.error); return "failed"; }
  if (res.info) await showInfoDialog(res.info);
  return res.result;
}
