// Визуальная приёмка по измеримым критериям (X-VIS): каждая сцена × три размера
// экрана, масштаб 100% (реальный размер iframe, без zoom/transform).
import { openApp, waitFor } from "/tests/helpers.js";
import { SCENES } from "/tests/scenes.js";

const SIZES = [[1920, 1080], [1920, 900], [1366, 768]];
const short = (el) => {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 60);
};

// Измерения одного состояния экрана → объект со списками нарушений.
export function measure(a) {
  const { win, doc } = a;
  const W = win.innerWidth, H = win.innerHeight;
  const de = doc.documentElement;
  const out = { hscroll: [], vscroll: [], footer: [], offscreen: [], spill: [], smallText: [], dialog: [], scrollArea: [] };
  if (de.scrollWidth > W + 1) out.hscroll.push(`страница шире окна: ${de.scrollWidth} > ${W}`);
  if (de.scrollHeight > H + 1) out.vscroll.push(`страница прокручивается целиком: ${de.scrollHeight} > ${H}`);

  const foot = doc.querySelector(".v2-foot");
  if (foot) {
    const r = foot.getBoundingClientRect();
    if (r.bottom > H + 1 || r.top < 0) out.footer.push(`подвал вне экрана: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} при высоте ${H}`);
    foot.querySelectorAll("button").forEach((b) => {
      const br = b.getBoundingClientRect();
      if (br.width && (br.bottom > H + 1 || br.right > W + 1 || br.left < -1)) out.footer.push(`кнопка подвала вне экрана: ${b.textContent.trim()}`);
    });
    const scroll = doc.querySelector(".v2-scroll");
    if (scroll) {
      const sr = scroll.getBoundingClientRect();
      if (sr.bottom > r.top + 1) out.scrollArea.push(`область прокрутки заходит под подвал: ${Math.round(sr.bottom)} > ${Math.round(r.top)}`);
    }
  }

  const scrollable = (el) => {
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
      const cs = win.getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return true;
    }
    return false;
  };
  doc.querySelectorAll("button, a[href], input, select, textarea").forEach((el) => {
    if (el.hidden || el.closest("[hidden]")) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if ((r.right > W + 1 || r.left < -1) && !scrollable(el)) out.offscreen.push(`${short(el)} за краем экрана по горизонтали (${Math.round(r.left)}…${Math.round(r.right)} при ${W})`);
  });

  doc.querySelectorAll("body *").forEach((el) => {
    if (!(el instanceof win.HTMLElement)) return;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const ox = cs.overflowX;
      const clipsByDesign = cs.textOverflow === "ellipsis" || /(auto|scroll)/.test(ox);
      if (!clipsByDesign && ox === "visible" && !["HTML", "BODY"].includes(el.tagName)) out.spill.push(`${short(el)} содержимое шире рамки (${el.scrollWidth} > ${el.clientWidth})`);
      if (ox === "hidden" && cs.textOverflow !== "ellipsis" && !el.closest(".v2-tree-name")) out.spill.push(`${short(el)} содержимое обрезается без многоточия (${el.scrollWidth} > ${el.clientWidth})`);
    }
    // текст мельче 12px в обычных формах не допускается
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && parseFloat(cs.fontSize) < 12 - 0.01 && !el.closest("svg, .maplibregl-map, .maplibregl-ctrl")) out.smallText.push(`${short(el)} ${cs.fontSize}`);
  });

  const dlg = doc.querySelector(".v2-dialog");
  if (dlg) {
    const r = dlg.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > W + 1 || r.bottom > H + 1) out.dialog.push(`диалог выходит за экран (${Math.round(r.left)},${Math.round(r.top)} — ${Math.round(r.right)},${Math.round(r.bottom)} при ${W}×${H})`);
  }
  return out;
}

const uniq = (arr) => [...new Set(arr)];
export const tests = [];
for (const [id, scene] of Object.entries(SCENES)) {
  for (const [w, h] of SIZES) {
    tests.push({
      id: `VIS-${id}-${w}x${h}`,
      title: `${scene.title} — ${w}×${h}`,
      async run(t) {
        const a = await openApp({ w, h, perm: id === "no-sections" ? "none" : undefined, session: id === "login" ? false : undefined });
        await waitFor(() => a.doc.documentElement.dataset.harness === "ready", { what: "стенд" });
        await scene.open(a);
        await a.settle(150);
        t.eq([a.win.innerWidth, a.win.innerHeight], [w, h], `viewport ${w}×${h} (масштаб 100%)`);
        const m = measure(a);
        t.eq(m.hscroll, [], "нет горизонтальной прокрутки страницы");
        t.eq(m.vscroll, [], "страница не прокручивается целиком (прокрутка — во внутренних областях)");
        t.eq(m.footer, [], "подвал и его кнопки в пределах экрана");
        t.eq(m.scrollArea, [], "область прокрутки не заходит под подвал");
        t.eq(uniq(m.offscreen).slice(0, 5), [], "интерактивные элементы не выходят за край экрана");
        t.eq(uniq(m.spill).slice(0, 5), [], "содержимое не вылезает за рамки и не обрезается молча");
        t.eq(uniq(m.smallText).slice(0, 8), [], "нет текста мельче 12px");
        t.eq(m.dialog, [], "диалог в пределах экрана");
        a.close();
      },
    });
  }
}

// Закрепление шапки таблицы при внутренней прокрутке (много пользователей)
tests.push({
  id: "VIS-sticky-users-1366x768", title: "Шапка таблицы пользователей закреплена при прокрутке списка — 1366×768",
  async run(t) {
    const a = await openApp({ w: 1366, h: 768 });
    await waitFor(() => a.$("#ua-rows"), { what: "список" });
    const base = a.ctl.data.users[0];
    for (let i = 0; i < 40; i++) a.ctl.data.users.push({ ...base, id: 9000 + i, domain_login: `qa.bulk${i}`, last_name: `QA-Массовый${i}`, first_name: "Тест", role: "user" });
    // раздел монтируется заново — список читается с «сервера» уже с добавленными
    a.click(a.$('.v2-nav [data-section="projects-objects"]')); await waitFor(() => a.$("#po-tree"), { what: "PO" });
    a.click(a.$('.v2-nav [data-section="users-access"]')); await waitFor(() => a.$$("#ua-rows tr").length > 40, { what: "список из 48" });
    const box = a.$(".v2-scroll");
    t.ok(box.scrollHeight > box.clientHeight, "длинный список прокручивается внутри своей области");
    box.scrollTop = 400; await a.settle(80);
    const th = a.$(".v2-table thead th").getBoundingClientRect(), br = box.getBoundingClientRect();
    t.ok(Math.abs(th.top - br.top) <= 2, `шапка таблицы осталась вверху области (Δ=${Math.round(th.top - br.top)}px)`);
    const de = a.doc.documentElement;
    t.ok(de.scrollHeight <= a.win.innerHeight + 1, "страница целиком не прокручивается");
  },
});
