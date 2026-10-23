// Проверка расчётного ядра производственной программы (2026-10-23, Docs/pp-money.md).
//
//   node scripts/verify_pp_core.mjs <данные.json | data.js> [--prototype ПП-автономный.html] [--steps 300] [--seed 1]
//
// <данные> — {money, schedule}: результат `scripts/verify_pp_import.py --dump` или `data.js` прототипа.
//
// Часть A (всегда): инварианты и контрольные числа из шести тестов прототипа — стоимость родителя = сумме детей, итог объекта =
// сумме верхних уровней, сохранение денег при правке сроков, правка верхнего уровня сдвигает поддерево, правка нижнего
// расширяет родителей, предпросмотр перетаскивания. Контрольные числа (213 объектов, 443,82 млрд, БП-000193 — 55 работ и
// 10,79 млрд, 19/41/45 строк у первого объекта) проверяются, когда в данных есть соответствующие объекты.
//
// Часть B (с --prototype): ДИФФЕРЕНЦИАЛЬНАЯ сверка. Скрипт прототипа исполняется как есть (в `vm`, DOM — заглушка), и на одних и
// тех же данных и одной последовательности случайных правок сравниваются его функции с ядром: срок и стоимость каждой работы,
// доли родителей, деньги по месяцам, строки дерева, строки выгрузки. Это и есть доказательство «логика сохранена».
//
// Значения (названия объектов, суммы по строкам) в отчёт не выводятся: данные заказчика.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createModel, dayOfYmd, fmtM, dFromDays, isoD, snapDays, shiftMonth } from "../app/static/pp/core.js";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const dataPath = argv.find((a) => !a.startsWith("--") && a !== opt("--prototype") && a !== opt("--steps") && a !== opt("--seed"));
if (!dataPath) {
  console.error("Использование: node scripts/verify_pp_core.mjs <данные.json|data.js> [--prototype файл.html] [--steps N] [--seed N]");
  process.exit(2);
}

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? "OK   " : "FAIL ") + name + (extra ? " — " + extra : ""));
  if (!ok) fails++;
};

function readData(path) {
  let text = readFileSync(path, "utf8");
  const mark = "window.PP_DATA = ";
  if (text.includes(mark)) text = text.slice(text.indexOf(mark) + mark.length).replace(/;\s*$/, "");
  return JSON.parse(text);
}
const data = readData(dataPath);
const m = createModel();
m.load(data);
const allWorks = [];
for (const o of m.objects) for (const w of o.rows) allWorks.push(w);
console.log(`Данные: объектов ${m.objects.length}, работ ${allWorks.length}, строк денег ${data.money.length}`);

/* ================= Часть A ================= */
console.log("\n--- Часть A: инварианты и контрольные числа ---");
{
  /* 1) стоимость каждого уровня складывается из нижних (test_distribution 1a–1c) */
  let badParent = 0, badTop = 0, badObj = 0, parents = 0;
  for (const o of m.objects) {
    for (const t of o.top) {
      if (Math.abs(m.effTotal(t) - m.rowTotal(t)) > 0.01) badTop++;
      (function walk(x) {
        if (!x.children.length) return;
        parents++;
        if (Math.abs(m.effTotal(x) - x.children.reduce((a, c) => a + m.effTotal(c), 0)) > 0.01) badParent++;
        for (const c of x.children) walk(c);
      })(t);
    }
    if (Math.abs(o.top.reduce((a, t) => a + m.effTotal(t), 0) - m.objTotal(o)) > 0.01) badObj++;
  }
  check("1a) стоимость родителя = сумме детей", badParent === 0, `родителей ${parents}, расхождений ${badParent}`);
  check("1b) стоимость верхнего уровня = исходному остатку", badTop === 0, `расхождений ${badTop}`);
  check("1c) итог объекта = сумме верхних уровней", badObj === 0, `расхождений ${badObj}`);

  /* 2) сохранение денег: сумма листьев (собственные + доли родителей) = итогу объектов */
  const leafSum = allWorks.filter((w) => !w.children.length).reduce((a, w) => a + m.ownMoney(w) + (w.extra || 0), 0);
  const objSum = m.objects.reduce((a, o) => a + m.objTotal(o), 0);
  check("2a) деньги стекают к листьям без потерь", Math.abs(leafSum - objSum) < 1, `${Math.round(leafSum)} / ${Math.round(objSum)}`);
  const segsAll = m.buildSegments(m.maxEnd(m.objects));
  const spread = m.footSums(m.objects, segsAll).reduce((a, b) => a + b, 0);
  check("2b) распределение по шкале = итогу объектов", Math.abs(spread - objSum) < 1, `${Math.round(spread)} / ${Math.round(objSum)}`);

  /* 3) срок родителя = min/max по детям */
  let badDates = 0;
  for (const w of allWorks) {
    if (!w.children.length) continue;
    const d = m.effDates(w);
    const mn = Math.min(...w.children.map((c) => m.effDates(c).s));
    const mx = Math.max(...w.children.map((c) => m.effDates(c).e));
    if (d.s !== mn || d.e !== mx) badDates++;
  }
  check("3) срок работы с детьми = min/max по детям", badDates === 0, `расхождений ${badDates}`);

  /* 4) контрольные числа описания */
  if (m.objects.length === 213) {
    check("4a) всего 213 объектов", true);
    check("4b) итог «все объекты» = 443,82 млрд", Math.round(objSum / 1e7) / 100 === 443.82, fmtM(objSum));
  }
  const first = m.objects[0];
  const rowsAt = (list, depth) => m.computeView(list, { depth }).rows.filter((r) => r.type === "w");
  if (first && m.objects.length === 213) {
    const L = [first];
    const n = (d) => rowsAt(L, d).length;
    const kids = (d) => rowsAt(L, d).filter((r) => r.depth > 0).length;
    check("4c) первый объект: 2 ур. — 19 работ, детей 0", n(1) === 19 && kids(1) === 0, `${n(1)}/${kids(1)}`);
    check("4d) 3 ур. — 41 работа, детей 22", n(2) === 41 && kids(2) === 22, `${n(2)}/${kids(2)}`);
    check("4e) 4 ур. — 45 работ, детей 26", n(3) === 45 && kids(3) === 26, `${n(3)}/${kids(3)}`);
  }
  const o193 = m.objects.find((o) => o.code === "БП-000193");
  if (o193) {
    const rows = rowsAt([o193], 3);
    check("4f) БП-000193: 55 работ и 10,79 млрд", rows.length === 55 && Math.round(m.objTotal(o193) / 1e7) / 100 === 10.79, `${rows.length}, ${fmtM(m.objTotal(o193))}`);
  }
  const lvl1 = m.computeView(m.objects, { depth: 0 });
  check("4g) 1 ур. — только объекты", lvl1.rows.every((r) => r.type === "o") && lvl1.rows.length === m.objects.length);
}

/* правка нижней работы перераспределяет месяцы, сумма сохраняется (test_distribution 3) */
{
  const o = m.objects.find((x) => x.code === "01-000325");
  const p15 = o && o.top.find((t) => /^15\. Системы ОВиК/.test(t.work));
  const c152 = p15 && p15.children.find((c) => /^15\.2\./.test(c.work));
  if (c152) {
    const segs = m.buildSegments(m.maxEnd([o]));
    const idx = (y, mo) => segs.findIndex((sg) => sg.type === "m" && sg.y === y && sg.m === mo);
    const before = m.footSums([o], segs);
    const pBefore = { ...m.effDates(p15) };
    m.applyEdit(c152.key, dayOfYmd(2027, 6, 1), dayOfYmd(2027, 7, 1));
    const after = m.footSums([o], segs);
    check("5a) срок родителя не изменился (ребёнок внутри диапазона)", JSON.stringify(m.effDates(p15)) === JSON.stringify(pBefore));
    check("5b) февральская сумма уменьшилась", after[idx(2027, 1)] < before[idx(2027, 1)] - 1e6);
    check("5c) июньская сумма увеличилась", after[idx(2027, 5)] > before[idx(2027, 5)] + 1e6);
    check("5d) общая сумма не изменилась", Math.abs(before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0)) < 1);
    m.clearEdits();
  } else console.log("пропуск 5: нет объекта 01-000325 / работы 15.2");
}

/* глубокая правка (test_deep_edit): 3 → 3.3 → 3.3.3/4/5 */
{
  const o = m.objects.find((x) => x.code === "01-000325");
  const top = o && o.top.find((t) => /^3\. Подготовка территории строительства/.test(t.work));
  const c33 = top && top.children.find((c) => /^3\.3\./.test(c.work));
  const c32 = top && top.children.find((c) => /^3\.2\./.test(c.work));
  const g = (re) => c33 && c33.children.find((c) => re.test(c.work));
  const g333 = g(/^3\.3\.3\./), g334 = g(/^3\.3\.4\./), g335 = g(/^3\.3\.5\./);
  if (top && c33 && c32 && g333 && g334 && g335) {
    m.clearEdits();
    const D = (w) => { const d = m.effDates(w); return d.s + ".." + d.e; };
    const env = (w) => Math.min(...w.children.map((c) => m.effDates(c).s)) + ".." + Math.max(...w.children.map((c) => m.effDates(c).e));
    const t0 = m.effDates(top);
    m.applyEdit(top.key, t0.s + 30, t0.e + 30);
    check("6a) верхний уровень сдвинут на +30", m.effDates(top).s === t0.s + 30 && m.effDates(top).e === t0.e + 30);
    check("6b) все потомки сдвинулись вместе с верхним", [c33, c32, g333, g334, g335].every((w) => D(w) === D(top)));
    const c0 = m.effDates(c33);
    m.applyEdit(c33.key, c0.s + 5, c0.e + 5);
    check("6c) 3.3 сдвинут на +5, верхний расширился по окончанию", m.effDates(c33).s === c0.s + 5 && m.effDates(top).s === t0.s + 30 && m.effDates(top).e === t0.e + 35);
    check("6d) внуки унаследовали сдвиг 3.3, соседняя ветка 3.2 не изменилась", [g333, g334, g335].every((w) => D(w) === D(c33)) && m.effDates(c32).e === t0.e + 30);
    const sib = [D(g334), D(g335), D(c32)];
    const e0 = m.effDates(g333);
    m.applyEdit(g333.key, e0.s, e0.e + 10);
    check("6e) внук 3.3.3 +10 к окончанию, соседи 3.3.4/3.3.5 и ветка 3.2 не откатились", m.effDates(g333).e === e0.e + 10 && [D(g334), D(g335), D(c32)].every((v, i) => v === sib[i]));
    check("6f) 3.3 и 3 расширены по нижним: срок = min/max по детям", D(c33) === env(c33) && D(top) === env(top));
    /* перетаскивание родителя: предпросмотр не пишется в правки, при отпускании правка фиксируется на листьях */
    m.clearEdits();
    const base = { ...m.effDates(c33) };
    const orig = [g333, g334, g335].map((w) => ({ ...m.effDates(w) }));
    m.setPreview({ key: c33.key, s: base.s + 20, e: base.e + 20, s0: base.s, e0: base.e, hasCh: true });
    check("7a) предпросмотр: поддерево показано со сдвигом", [g333, g334, g335].every((w, i) => m.effDates(w).s === orig[i].s + 20 && m.effDates(w).e === orig[i].e + 20));
    check("7b) предпросмотр не пишет правок", m.edits.size === 0);
    m.setPreview(null);
    check("7b2) без предпросмотра сроки прежние", [g333, g334, g335].every((w, i) => m.effDates(w).s === orig[i].s));
    m.applyEdit(c33.key, base.s + 20, base.e + 20, { s: base.s, e: base.e });
    check("7c) по отпускании правки зафиксированы на листьях, а не на родителе", m.edits.has(g333.key) && !m.edits.has(c33.key));
    check("7d) сдвиг +20 у всех потомков, срок родителя = заданному", [g333, g334, g335].every((w, i) => m.effDates(w).s === orig[i].s + 20) && m.effDates(c33).s === base.s + 20 && m.effDates(c33).e === base.e + 20);
    m.clearEdits();
  } else console.log("пропуск 6–7: нет объекта 01-000325 / ветки 3.3");
}

/* границы: начало не раньше стартовой даты, окончание не раньше начала */
{
  const w = allWorks.find((x) => !x.children.length);
  m.applyEdit(w.key, m.startDay - 100, m.startDay - 200);
  const d = m.effDates(w);
  check("8) правка клемпится: начало ≥ старта, окончание ≥ начала", d.s === m.startDay && d.e === d.s, `${isoD(dFromDays(d.s))}`);
  m.clearEdits();
  check("9) прилипание: неделя — понедельник, месяц — 1-е", new Date(snapDays(dayOfYmd(2026, 10, 14), "week") * 86400000).getUTCDay() === 1 &&
    new Date(snapDays(dayOfYmd(2026, 10, 20), "month") * 86400000).getUTCDate() === 1 && shiftMonth(dayOfYmd(2026, 1, 31), 1) === dayOfYmd(2026, 2, 28));
}

/* ================= Часть B: дифференциальная сверка с прототипом ================= */
const protoPath = opt("--prototype");
if (protoPath) {
  console.log("\n--- Часть B: сверка с исходным скриптом прототипа ---");
  const html = readFileSync(protoPath, "utf8");
  const start = html.lastIndexOf("<script>");
  const code = html.slice(start + 8, html.lastIndexOf("</script>"));
  if (!code.includes("function applyEdit")) throw new Error("В файле не найден скрипт приложения прототипа");

  const fake = () => {
    const store = { style: {}, dataset: {}, children: [], value: "" };
    const p = new Proxy(function () {}, {
      get(_t, k) {
        if (k in store) return store[k];
        if (k === "clientWidth") return 1400;
        if (k === "querySelectorAll" || k === "getAttribute") return () => [];
        if (k === "classList") return { toggle() {}, add() {}, remove() {}, contains: () => false };
        if (k === Symbol.toPrimitive) return () => 0;
        return (..._a) => p;
      },
      set(_t, k, v) { store[k] = v; return true; },
      apply: () => p,
    });
    return p;
  };
  const win = {};
  const ctx = vm.createContext({
    console, window: win, PP_DATA: data, Math, Date, JSON, Map, Set, Array, Object, Number, String, parseFloat, isNaN, isFinite, setTimeout, clearTimeout,
    document: { getElementById: () => fake(), documentElement: { dataset: {} }, body: { classList: { add() {}, remove() {} }, dataset: {} }, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false }), innerWidth: 1600, innerHeight: 900, confirm: () => true,
    requestAnimationFrame: () => 0, addEventListener() {}, XLSX: undefined,
  });
  ctx.window = ctx;
  vm.runInContext(code, ctx, { filename: "prototype.js" });
  const P = (expr) => vm.runInContext(expr, ctx);
  const protoObjects = P("objects");
  check("B0) прототип загрузил те же объекты", protoObjects.length === m.objects.length && protoObjects.every((o, i) => o.code === m.objects[i].code));

  const pw = (key) => P("wByKey").get(key).w;
  const compareAll = (label) => {
    let bad = 0, firstBad = "";
    const note = (what, key) => { if (!bad) firstBad = what + " @" + key.slice(0, 18); bad++; };
    for (const o of m.objects) {
      const po = protoObjects.find((x) => x.code === o.code);
      for (const w of o.rows) {
        const q = po.rows.find((x) => x.key === w.key);
        if (!q) { note("нет работы", w.key); continue; }
        const d1 = m.effDates(w), d2 = vm.runInContext("effDates", ctx)(q);
        if (d1.s !== d2.s || d1.e !== d2.e) note("срок", w.key);
        const b1 = m.baseDates(w), b2 = vm.runInContext("baseDates", ctx)(q);
        if (b1.s !== b2.s || b1.e !== b2.e) note("база", w.key);
        if (m.effTotal(w) !== vm.runInContext("effTotal", ctx)(q)) note("стоимость", w.key);
        if (m.rowTotal(w) !== vm.runInContext("rowTotal", ctx)(q)) note("rowTotal", w.key);
        if ((w.extra || 0) !== (q.extra || 0)) note("доля родителя", w.key);
        if (w.depth !== q.depth || w.children.length !== q.children.length) note("дерево", w.key);
        if (m.dateSource(w) !== vm.runInContext("dateSource", ctx)(q)) note("источник срока", w.key);
      }
      if (m.objTotal(o) !== vm.runInContext("objTotal", ctx)(po)) note("итог объекта", o.code);
      const a = m.objDates(o), b = vm.runInContext("objDates", ctx)(po);
      if (JSON.stringify(a) !== JSON.stringify(b)) note("срок объекта", o.code);
    }
    check(`B1) ${label}: срок/стоимость/доли/дерево каждой работы совпадают с прототипом`, bad === 0, bad ? `расхождений ${bad}, первое: ${firstBad}` : `${allWorks.length} работ`);
  };

  const sumsOf = (label) => {
    P("state.div='all'; state.obj='all'; state.depth=3; renderAll();");
    const segsP = P("lastAx.segs"), sumsP = P("footSums(lastV,lastAx)");
    const list = m.selectObjects();
    const segs = m.buildSegments(m.maxEnd(list));
    const sameSegs = segs.length === segsP.length && segs.every((s, i) => s.t === segsP[i].t && s.next === segsP[i].next && s.type === segsP[i].type && s.y === segsP[i].y && s.m === segsP[i].m);
    const sums = m.footSums(list, segs);
    const badSum = sums.map((v, i) => Math.abs(v - sumsP[i])).filter((d) => d > 1e-6).length;
    const exact = sums.every((v, i) => v === sumsP[i]);
    check(`B2) ${label}: шкала совпадает с прототипом`, sameSegs, `сегментов ${segs.length}/${segsP.length}`);
    check(`B2) ${label}: деньги по месяцам совпадают с прототипом (до 1e-6 ₽; побитово: ${exact ? "да" : "нет"})`, sameSegs && badSum === 0, `расхождений ${badSum}`);
  };

  const viewSig = (rows) => rows.map((r) => (r.type === "o" ? "o|" + r.o.code : "w|" + r.w.key + "|" + r.depth)).join("\n");
  const compareView = (label) => {
    let ok = true;
    for (const depth of [0, 1, 2, 3]) {
      for (const [div, obj] of [["all", "all"], ["all", m.objects[0].code], ["all", m.objects[m.objects.length - 1].code]]) {
        P(`state.div=${JSON.stringify(div)}; state.obj=${JSON.stringify(obj)}; state.depth=${depth};`);
        const pv = P("computeView()");
        const mv = m.computeView(m.selectObjects({ division: div, codes: obj === "all" ? null : [obj] }), { depth, collapsed: P("collapsed"), expanded: P("expanded") });
        if (viewSig(pv.rows) !== viewSig(mv.rows)) ok = false;
      }
    }
    check(`B3) ${label}: строки дерева (уровни 1–4, один объект и все) совпадают`, ok);
  };

  /* выгрузка: подставляем XLSX-заглушку, которая запоминает листы */
  ctx.XLSX = {
    utils: { book_new: () => ({}), aoa_to_sheet: (a) => a, book_append_sheet: (wb, ws, name) => { wb[name] = ws; } },
    writeFile: (wb) => { ctx.__wb = wb; },
  };
  const exportCheck = (label) => {
    P("state.div='all'; state.obj='all'; exportXlsx();");
    const wb = ctx.__wb;
    const mine = m.exportTables(m.objects.map((o) => o.code));
    const pm = wb["Деньги"].slice(1), ps = wb["Сроки"].slice(1);
    const okMoney = pm.length === mine.money.length && pm.every((r, i) => r[0] === mine.money[i].c && r[3] === mine.money[i].w && (r[6] === "" ? mine.money[i].r == null : r[6] === mine.money[i].r));
    const okSched = ps.length === mine.schedule.length && ps.every((r, i) => {
      const s = mine.schedule[i];
      const rs = r[6].v, re = r[7].v;
      return r[1] === s.c && r[3] === s.w && rs === s.s && re === s.e && r[9] === s.mark;
    });
    check(`B4) ${label}: строки выгрузки «Деньги» и «Сроки» (с пометками правок) совпадают`, okMoney && okSched, `${pm.length}/${ps.length} строк`);
  };

  /* случайные правки: одна и та же последовательность в прототипе и в ядре */
  let seed = +opt("--seed", 1) >>> 0;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const steps = +opt("--steps", 300);

  compareAll("без правок");
  sumsOf("без правок");
  compareView("без правок");
  exportCheck("без правок");

  const parents = allWorks.filter((w) => w.children.length);
  const leaves = allWorks.filter((w) => !w.children.length);
  for (let i = 1; i <= steps; i++) {
    const w = rnd() < 0.35 ? parents[Math.floor(rnd() * parents.length)] : leaves[Math.floor(rnd() * leaves.length)];
    const cur = m.effDates(w);
    const s = cur.s + Math.round((rnd() - 0.5) * 240);
    const e = Math.max(s, cur.e + Math.round((rnd() - 0.5) * 240));
    m.applyEdit(w.key, s, e);
    vm.runInContext("applyEdit", ctx)(w.key, s, e);
    if (i % 100 === 0 && i < steps) compareAll(`после ${i} правок`);
  }
  compareAll(`после ${steps} правок (верхние уровни и листья вперемешку)`);
  sumsOf(`после ${steps} правок`);
  exportCheck(`после ${steps} правок`);
  const editsSame = m.edits.size === P("edits").size && [...m.edits].every(([k, v]) => { const q = P("edits").get(k); return q && q.s === v.s && q.e === v.e; });
  check("B5) набор правок листьев совпадает с прототипом", editsSame, `${m.edits.size} правок`);

  /* предпросмотр перетаскивания работы с детьми */
  let dragOk = true;
  for (let i = 0; i < 25; i++) {
    const w = parents[Math.floor(rnd() * parents.length)];
    const cur = m.effDates(w);
    const shift = Math.round((rnd() - 0.5) * 120);
    const d = { key: w.key, mode: "move", startX: 0, x0: 0, day0: 0, s: cur.s + shift, e: cur.e + shift, s0: cur.s, e0: cur.e, hasCh: true };
    m.setPreview(d);
    ctx.__drag = d;
    P("drag = __drag; refreshDerived();");
    const sub = [];
    (function collect(x) { sub.push(x); for (const c of x.children) collect(c); })(w);
    for (const x of sub) {
      const a = m.effDates(x), b = vm.runInContext("effDates", ctx)(pw(x.key));
      if (a.s !== b.s || a.e !== b.e) dragOk = false;
    }
    m.setPreview(null);
    P("drag = null; refreshDerived();");
  }
  check("B6) предпросмотр перетаскивания поддерева совпадает с прототипом", dragOk, "25 перетаскиваний");

  /* сворачивание вручную */
  const someKeys = allWorks.filter((w) => w.children.length).slice(0, 40).map((w) => w.key);
  for (const k of someKeys.slice(0, 20)) P(`collapsed.add(${JSON.stringify(k)})`);
  for (const k of someKeys.slice(20)) P(`expanded.add(${JSON.stringify(k)})`);
  compareView("с ручным сворачиванием/раскрытием");
}

console.log(fails ? `\nИТОГ: не прошло проверок: ${fails}` : "\nИТОГ: все проверки прошли");
process.exit(fails ? 1 : 0);
