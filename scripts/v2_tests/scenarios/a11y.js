// Доступность (X-KBD): доступные имена управляющих элементов, порядок Tab,
// aria-live у статусов, видимый focus-visible — по всем сценам стенда.
import { openApp, waitFor } from "/tests/helpers.js";
import { SCENES } from "/tests/scenes.js";

// Упрощённое вычисление доступного имени (aria-label → aria-labelledby → <label> → содержимое → title).
// Имя ТОЛЬКО из placeholder недостаточно и считается нарушением.
function accessibleName(doc, el) {
  const al = el.getAttribute("aria-label");
  if (al && al.trim()) return al.trim();
  const lb = el.getAttribute("aria-labelledby");
  if (lb) { const t = lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ").trim(); if (t) return t; }
  if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
    if (el.type === "hidden") return "hidden";
    const labels = el.labels ? [...el.labels] : [];
    for (const l of labels) {
      const clone = l.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button").forEach((n) => n.remove());
      const t = clone.textContent.replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    return el.title?.trim() || "";
  }
  const own = el.textContent.replace(/\s+/g, " ").trim();
  return own || el.title?.trim() || "";
}

const desc = (el) => {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/)[0] : "";
  const data = [...el.attributes].filter((a) => a.name.startsWith("data-")).slice(0, 1).map((a) => `[${a.name}]`).join("");
  return `${el.tagName.toLowerCase()}${id}${cls}${data}`;
};

export const tests = [];
for (const [id, scene] of Object.entries(SCENES)) {
  if (["login", "no-sections"].includes(id)) continue; // форма входа/заглушка проверяются отдельно
  tests.push({
    id: `A11Y-${id}`, title: `${scene.title}: доступные имена, tabindex, aria-live`,
    async run(t) {
      const a = await openApp({ w: 1366, h: 768 });
      await waitFor(() => a.doc.documentElement.dataset.harness === "ready", { what: "стенд" });
      await scene.open(a);
      await a.settle(120);
      const doc = a.doc;
      const controls = [...doc.querySelectorAll("button, a[href], input, select, textarea")].filter((el) => !el.closest("[hidden]") && !el.hidden && el.getClientRects().length);
      const unnamed = controls.filter((el) => !accessibleName(doc, el)).map(desc);
      t.eq([...new Set(unnamed)].slice(0, 8), [], "у всех управляющих элементов есть доступное имя (не только placeholder)");
      const positive = [...doc.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0).map(desc);
      t.eq(positive, [], "положительных tabindex нет (порядок Tab = порядок разметки)");
      // статусы озвучиваются
      const statuses = ["#ua-status", "#po-status", "#cp-status", "#ctr-status", "#v2-nav-note"].map((s) => doc.querySelector(s)).filter(Boolean);
      t.ok(statuses.length > 0, "строка статуса присутствует");
      t.ok(statuses.every((s) => s.getAttribute("aria-live") === "polite" && s.getAttribute("role") === "status"), "статусы имеют role=status и aria-live=polite");
      // заголовки не пропускают уровни (h2 → h3 → h4)
      const levels = [...doc.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
      const jumps = levels.filter((lv, i) => i && lv - levels[i - 1] > 1);
      t.eq(jumps, [], "уровни заголовков не перескакивают");
    },
  });
}

// Видимый focus-visible проверяется НАСТОЯЩИМ Tab в браузере (скриптовое событие клавиши
// :focus-visible не включает) — результат записан в Docs/v2-release-acceptance.md.
