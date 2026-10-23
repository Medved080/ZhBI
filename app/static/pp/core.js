// Производственная программа в деньгах: расчётное ядро (перенос логики прототипа «ПП 2026–2027» от 2026-10-21).
//
// Здесь только вычисления: ни DOM, ни сети, ни localStorage — модуль работает и в браузере, и в Node (проверка
// `scripts/verify_pp_core.mjs`). Правила прежние, дословно из прототипа (Docs/pp-money.md):
//   * сроки считаются СНИЗУ ВВЕРХ: у работы с детьми начало — минимум начал детей, окончание — максимум окончаний;
//   * деньги стекают к ЛИСТОВЫМ работам: собственный остаток родителя (и полученная им доля) делится по прямым детям
//     пропорционально их остатку, последний ребёнок получает остаток — сумма долей сходится копейка в копейку;
//   * распределение по месяцам — равномерно по календарным дням листовой работы, отрицательные остатки не участвуют;
//   * правка работы с детьми сдвигает все листья её поддерева на ту же величину начала и окончания.
//
// Что изменено относительно прототипа (логика — нет):
//   * состояние (объекты, правки, предпросмотр перетаскивания) живёт внутри модели, а не в глобальных переменных;
//   * дата начала расчёта (в прототипе зашитая «01.10.2026») и число помесячных колонок шкалы — параметры;
//   * поиск денег для строки срока идёт по индексу, а не повторным перебором всех денежных строк (результат тот же);
//   * миграция правок v5→v6 (`normalizeEdits`) не переносится: она нужна только данным старого localStorage прототипа.

export const DAY = 86400000;

/* ===== даты и числа ===== */
export const num = (v) => (v == null ? 0 : Number(v) || 0);
export const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
export const serialToDays = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? NaN : Math.round(n - 25569);
};
export const daysToSerial = (n) => n + 25569;
export const dFromDays = (n) => new Date(n * DAY);
export const daysOf = (d) => Math.round(d.getTime() / DAY);
const pad2 = (n) => String(n).padStart(2, "0");
export const fmtD = (d) => pad2(d.getUTCDate()) + "." + pad2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
export const isoD = (d) => d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
export const dayOfYmd = (y, m1, d = 1) => daysOf(new Date(Date.UTC(y, m1 - 1, d)));

/** Номер работы в начале названия («3.2.1. …» → 3); 0, если номера нет. */
export const workNum = (w) => {
  const m = String(w || "").match(/^\s*(\d+)/);
  return m ? +m[1] : 0;
};

/** Семейство работ (цвет полосы) по номеру в начале названия. */
export function familyOf(w) {
  const n = workNum(w);
  if (n === 1 || n === 2) return 1;
  if (n >= 3 && n <= 6) return 2;
  if (n >= 7 && n <= 9) return 3;
  if (n >= 10 && n <= 14) return 4;
  if (n === 15 || n === 16 || n === 19) return 5;
  if (n === 17) return 6;
  if (n === 20) return 7;
  if (n === 25) return 8;
  return 0;
}
export const FAMILY_NAMES = {
  1: "ПИР, техзаказчик", 2: "Подготовка, земляные работы", 3: "Конструктив (Ж/Б, кладка)", 4: "Фасады, проёмы, кровля",
  5: "Инженерные системы", 6: "Отделочные работы", 7: "Благоустройство", 8: "Накладные расходы",
};

/** Нормализация названия СМУ/дивизиона из источника. */
export function normDiv(d) {
  if (d == null || String(d).trim() === "") return "—";
  let s = String(d).trim();
  s = s.replace(/^Строительно-монтажное управление-(\d+)$/i, "СМУ-$1");
  s = s.replace(/^Дивизион\s*№\s*(\d+)\s*$/i, (m, p) => "Дивизион " + String(+p));
  s = s.replace(/^Дивизион\s+0*(\d+)$/i, (m, p) => "Дивизион " + String(+p));
  s = s.replace(/^Дирекция гарантии и мониторинга$/i, "Дирекция гарантии");
  return s;
}

/* ===== деньги: подписи ===== */
export const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const MONTHS_ABBR = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "нояб", "дек"];

export function fmtMParts(v) {
  if (v == null || isNaN(v)) return { num: "—", unit: "" };
  const a = Math.abs(v);
  if (a >= 1e9) return { num: (v / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 2 }), unit: "млрд ₽" };
  if (a >= 1e6) return { num: (v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }), unit: "млн ₽" };
  if (a >= 1e3) return { num: Math.round(v / 1e3).toLocaleString("ru-RU"), unit: "тыс ₽" };
  return { num: Math.round(v).toLocaleString("ru-RU"), unit: "₽" };
}
export function fmtM(v) {
  if (v == null || isNaN(v)) return "—";
  const p = fmtMParts(v);
  return p.num + " " + p.unit;
}

/* ===== прилипание при перетаскивании ===== */
/** Округляет день до шага: «day» — как есть, «week» — к ближайшему понедельнику (≤3 дней назад, иначе вперёд), «month» — к 1-му числу. */
export function snapDays(n, mode) {
  const r = Math.round(n);
  if (mode === "day") return r;
  if (mode === "week") {
    const d = dFromDays(r);
    const dow = (d.getUTCDay() + 6) % 7;
    return dow <= 3 ? r - dow : r + (7 - dow);
  }
  const d = dFromDays(r);
  const dd = d.getUTCDate();
  if (dd <= 15) return daysOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  return daysOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}
/** Сдвиг на месяцы; число ограничивается 28-м, чтобы не перескочить через месяц. */
export function shiftMonth(d, delta) {
  const dt = dFromDays(d);
  return daysOf(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + delta, Math.min(dt.getUTCDate(), 28))));
}

/** Ключ работы в прототипе: код + название + исходные даты (две строки с одним названием и разными сроками — не дубль). */
export const workKey = (s) => s.c + "|" + String(s.w).trim() + "|" + s.s + "|" + s.e;

/**
 * Модель производственной программы.
 * @param {{startDay?: number, monthCount?: number}} [opts] startDay — первый день расчёта (дней от 1970-01-01; по умолчанию
 *   01.10.2026): раньше него работа не начинается ни на экране, ни в распределении денег; monthCount — число помесячных
 *   колонок шкалы от месяца startDay (дальше идут целые годы).
 */
export function createModel(opts = {}) {
  const T0 = opts.startDay ?? dayOfYmd(2026, 10, 1);
  const monthCount = opts.monthCount ?? 15;

  let raw = null;
  let objects = [];
  let wByKey = new Map();
  let noDates = [];
  let noDateRows = [];
  const edits = new Map(); // key листовой работы → {s, e}
  let preview = null; // перетаскивание: {key, s, e, s0, e0, hasCh} — НЕ правка, только показ
  const effCache = new Map();
  const baseCache = new Map();

  function refreshDerived() {
    effCache.clear();
    baseCache.clear();
  }

  /* ===== данные ===== */
  /** raw = {money: [{c,d,o,w,p,dn,r}], schedule: [{d,c,o,w,s,e,p}]} — формат `data.js` прототипа и ответа сервера. */
  function load(data) {
    raw = data;
    edits.clear();
    preview = null;
    refreshDerived();
    /* деньги: суммируются по паре «код + название» (в источнике бывают несколько строк с такой парой) */
    const used = new Array(raw.money.length).fill(false);
    const mExact = new Map();
    raw.money.forEach((r, i) => {
      const k = r.c + "|" + String(r.w).trim();
      let e = mExact.get(k);
      if (!e) {
        e = { p: 0, dn: 0, r: 0, idx: [] };
        mExact.set(k, e);
      }
      e.p += num(r.p);
      e.dn += num(r.dn);
      e.r += num(r.r);
      e.idx.push(i);
    });
    const lookup = (s) => {
      const e = mExact.get(s.c + "|" + String(s.w).trim());
      if (!e) return null;
      for (const i of e.idx) used[i] = true;
      return { p: e.p, dn: e.dn, r: e.r, approx: false };
    };
    objects = [];
    wByKey = new Map();
    noDateRows = [];
    const objMap = new Map();
    for (const s of raw.schedule) {
      const sd = serialToDays(s.s);
      const ed = serialToDays(s.e);
      const code = s.c;
      let o = objMap.get(code);
      if (!o) {
        o = { code, name: s.o, division: normDiv(s.d), rows: [] };
        objMap.set(code, o);
        objects.push(o);
      }
      if (o.division === "—" && s.d) o.division = normDiv(s.d);
      if (isNaN(sd) || isNaN(ed)) {
        noDateRows.push({ code, obj: s.o, work: s.w, div: normDiv(s.d) });
        continue;
      }
      const key = workKey(s);
      if (wByKey.has(key)) continue; // полный дубль строки
      const w = { key, work: s.w, s0: sd, e0: ed, money: lookup(s), parName: s.p || null, children: [], parentKey: null, depth: 0 };
      o.rows.push(w);
      wByKey.set(w.key, { o, w });
    }
    /* дерево: родитель ищется внутри того же объекта по нормализованному названию */
    for (const o of objects) {
      for (const w of o.rows) {
        if (!w.parName) continue;
        const pk = o.rows.find((x) => x !== w && norm(x.work) === norm(w.parName));
        if (pk) {
          w.parentKey = pk.key;
          pk.children.push(w);
        }
      }
      for (const w of o.rows) {
        let d = 0;
        let c = w;
        while (c.parentKey) {
          d++;
          c = wByKey.get(c.parentKey).w;
        }
        w.depth = d;
        w.children.sort((a, b) => workNum(a.work) - workNum(b.work) || a.work.localeCompare(b.work, "ru"));
      }
      o.top = o.rows.filter((w) => !w.parentKey);
      o.top.sort((a, b) => workNum(a.work) - workNum(b.work) || a.work.localeCompare(b.work, "ru"));
    }
    for (const o of objects) for (const w of o.top || []) computeAlloc(w, 0);
    noDates = raw.money.filter((r, i) => !used[i]);
  }

  /* ===== деньги ===== */
  const ownMoney = (w) => Math.max(0, num(w.money && w.money.r)); // отрицательный остаток (перевыполнение) не распределяется
  function rowTotal(w) {
    let t = ownMoney(w);
    for (const c of w.children) t += rowTotal(c);
    return t;
  }
  /** Собственный остаток родителя (плюс уже полученная доля) делится по прямым детям пропорционально их остатку. */
  function computeAlloc(w, extra) {
    w.extra = extra || 0;
    if (!w.children.length) return;
    const own = ownMoney(w) + w.extra;
    if (!(own > 0)) {
      for (const c of w.children) computeAlloc(c, 0);
      return;
    }
    const weights = w.children.map(rowTotal);
    const sw = weights.reduce((a, b) => a + b, 0);
    if (!(sw > 0)) {
      for (const c of w.children) computeAlloc(c, own / w.children.length);
      return;
    }
    let left = own;
    w.children.forEach((c, i) => {
      const share = i === w.children.length - 1 ? left : (own * weights[i]) / sw;
      left -= share;
      computeAlloc(c, share);
    });
  }
  function effTotal(w) {
    if (w.children.length) {
      let t = 0;
      for (const c of w.children) t += effTotal(c);
      return t;
    }
    return ownMoney(w) + (w.extra || 0);
  }
  function objTotal(o) {
    let t = 0;
    for (const w of o.top || o.rows) t += rowTotal(w);
    return t;
  }

  /* ===== сроки: снизу вверх ===== */
  function clampDates(s, e) {
    if (s < T0) s = T0;
    if (e < s) e = s;
    return { s, e };
  }
  /** Срок без учёта перетаскивания: у листа — правка или исходные данные, у родителя — min/max по детям. */
  function baseDates(w) {
    const hit = baseCache.get(w.key);
    if (hit) return hit;
    let res;
    if (w.children.length) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const c of w.children) {
        const d = baseDates(c);
        if (d.s < mn) mn = d.s;
        if (d.e > mx) mx = d.e;
      }
      res = isFinite(mn) ? { s: mn, e: mx } : { s: w.s0, e: w.e0 };
    } else {
      const e = edits.get(w.key);
      res = e ? { s: e.s, e: e.e } : { s: w.s0, e: w.e0 };
    }
    res = clampDates(res.s, res.e);
    baseCache.set(w.key, res);
    return res;
  }
  function isDescendantOf(w, ancKey) {
    let p = w.parentKey;
    while (p) {
      if (p === ancKey) return true;
      const pr = wByKey.get(p);
      if (!pr) break;
      p = pr.w.parentKey;
    }
    return false;
  }
  /** Показываемый срок. При перетаскивании работы с детьми её поддерево показывается со сдвигом; ignoreDrag — без него. */
  function effDates(w, ignoreDrag) {
    const ck = (ignoreDrag ? "b|" : "e|") + w.key;
    const hit = effCache.get(ck);
    if (hit) return hit;
    let res = null;
    if (!ignoreDrag && preview && preview.hasCh) {
      const ds = preview.s - preview.s0;
      const de = preview.e - preview.e0;
      if (w.key === preview.key) {
        res = { s: preview.s, e: preview.e };
      } else if (isDescendantOf(w, preview.key)) {
        const b = baseDates(w);
        res = clampDates(b.s + ds, b.e + de);
      }
    }
    if (!res) {
      if (w.children.length) {
        let mn = Infinity;
        let mx = -Infinity;
        for (const c of w.children) {
          const d = effDates(c, ignoreDrag);
          if (d.s < mn) mn = d.s;
          if (d.e > mx) mx = d.e;
        }
        res = isFinite(mn) ? { s: mn, e: mx } : clampDates(w.s0, w.e0);
      } else {
        res = baseDates(w);
      }
    }
    effCache.set(ck, res);
    return res;
  }
  function dateSource(w) {
    if (w.children.length) return "по нижним работам";
    if (edits.has(w.key)) return "ручная правка";
    return "исходные данные";
  }
  /** Срок объекта — min/max по работам 1-го уровня. */
  function objDates(o) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const w of o.top || o.rows) {
      const d = effDates(w);
      if (d.s < mn) mn = d.s;
      if (d.e > mx) mx = d.e;
    }
    return isFinite(mn) ? { s: mn, e: mx } : null;
  }
  /**
   * Правка срока. Лист — записывается правка. Работа с детьми — все листья её поддерева сдвигаются на разницу начала и
   * окончания (сама она в правки не попадает: её срок всё равно считается по нижним). `base` — срок до правки (при перетаскивании).
   */
  function applyEdit(key, s, e, base) {
    const rec = wByKey.get(key);
    if (!rec) {
      edits.set(key, { s, e });
      refreshDerived();
      return;
    }
    const w = rec.w;
    if (!w.children.length) {
      edits.set(key, { s, e });
      refreshDerived();
      return;
    }
    const cur = base || baseDates(w);
    const ds = s - cur.s;
    const de = e - cur.e;
    if (ds === 0 && de === 0) return;
    const leaves = [];
    (function collect(x) {
      if (x.children.length) for (const c of x.children) collect(c);
      else leaves.push(x);
    })(w);
    for (const l of leaves) {
      const d = baseDates(l);
      edits.set(l.key, clampDates(d.s + ds, d.e + de));
    }
    refreshDerived();
  }
  /** Правка листа без пересчёта дат родителя «на лету» (как при перетаскивании листа). */
  function setLeafEdit(key, s, e) {
    edits.set(key, { s, e });
    refreshDerived();
  }
  function setPreview(p) {
    preview = p || null;
    refreshDerived();
  }
  function setEdits(entries) {
    edits.clear();
    for (const [k, v] of entries) edits.set(k, { s: v.s ?? v[0], e: v.e ?? v[1] });
    refreshDerived();
  }
  function clearEdits() {
    edits.clear();
    refreshDerived();
  }

  /* ===== деньги по месяцам ===== */
  /**
   * Сегменты шкалы: monthCount месяцев от месяца startDay, затем целые годы до года последней даты окончания.
   * Месяцы после максимальной даты выборки отбрасываются (но хотя бы один остаётся).
   */
  function buildSegments(maxEnd) {
    const t0 = dFromDays(T0);
    const y0 = t0.getUTCFullYear();
    const m0 = t0.getUTCMonth();
    const months = [];
    for (let i = 0; i < monthCount; i++) {
      const t = Date.UTC(y0, m0 + i, 1);
      const d = new Date(t);
      months.push({ t, y: d.getUTCFullYear(), m: d.getUTCMonth(), next: Date.UTC(y0, m0 + i + 1, 1), type: "m" });
    }
    let monthSegs = months.filter((sg) => sg.t / DAY <= maxEnd);
    if (!monthSegs.length) monthSegs = months.slice(0, 1);
    const lastMonth = months[months.length - 1];
    const firstYear = new Date(lastMonth.next).getUTCFullYear();
    const lastYear = Math.max(firstYear - 1, dFromDays(maxEnd).getUTCFullYear());
    const yearSegs = [];
    for (let y = firstYear; y <= lastYear; y++) yearSegs.push({ t: Date.UTC(y, 0, 1), y, m: -1, next: Date.UTC(y + 1, 0, 1), type: "y" });
    return monthSegs.concat(yearSegs);
  }
  /** Деньги каждой ЛИСТОВОЙ работы равномерно по календарным дням её срока; родители своих сумм в сетку не добавляют. */
  function addLeafDistribution(w, segs, sums) {
    if (w.children.length) {
      for (const c of w.children) addLeafDistribution(c, segs, sums);
      return;
    }
    const val = ownMoney(w) + (w.extra || 0);
    if (!(val > 0)) return;
    const d = effDates(w);
    const tot = Math.max(1, d.e - d.s + 1);
    for (let i = 0; i < segs.length; i++) {
      const a = Math.max(d.s, segs[i].t / DAY);
      const b = Math.min(d.e, segs[i].next / DAY - 1);
      if (b >= a) sums[i] += (val * (b - a + 1)) / tot;
    }
  }
  /** Суммы по сегментам шкалы для списка объектов. */
  function footSums(list, segs) {
    const sums = new Array(segs.length).fill(0);
    for (const o of list) for (const w of o.top || o.rows) addLeafDistribution(w, segs, sums);
    return sums;
  }
  /** Последний день окончания среди работ 1-го уровня выборки (конец шкалы). */
  function maxEnd(list) {
    let m = T0;
    for (const o of list) for (const w of o.top || o.rows) {
      const d = effDates(w);
      if (d.e > m) m = d.e;
    }
    return m;
  }

  /* ===== представление ===== */
  /**
   * Объекты выборки: по СМУ/дивизиону и/или по набору кодов (объект — один код, произвольная группа — их список).
   * Порядок — по СМУ, затем по названию.
   */
  function selectObjects({ division = "all", codes = null } = {}) {
    const set = codes ? new Set(codes) : null;
    const list = objects.filter((o) => (division === "all" || o.division === division) && (!set || set.has(o.code)));
    list.sort((a, b) => (a.division === b.division ? a.name.localeCompare(b.name, "ru") : a.division.localeCompare(b.division, "ru")));
    return list;
  }
  /**
   * Строки дерева. depth — базовая глубина (0 — только объекты … 3 — все уровни); collapsed — свёрнутые вручную ключи,
   * expanded — раскрытые вручную глубже базового уровня (ключ объекта — 'obj|код').
   */
  function computeView(list, { depth = 1, collapsed = new Set(), expanded = new Set() } = {}) {
    const rows = [];
    const walk = (o, arr, d) => {
      for (const w of arr) {
        if (w.money == null && !w.children.length && !(w.extra > 0)) continue; // ни денег, ни детей, ни доли родителя — не показываем
        rows.push({ type: "w", o, w, depth: d });
        if (w.children.length && !collapsed.has(w.key) && (d + 1 < depth || expanded.has(w.key))) walk(o, w.children, d + 1);
      }
    };
    for (const o of list) {
      const okey = objKeyOf(o);
      rows.push({ type: "o", o, depth: -1, key: okey });
      const open = !collapsed.has(okey) && (depth > 0 || expanded.has(okey));
      if (open) walk(o, o.top || o.rows, 0);
    }
    return { list, rows };
  }
  const objKeyOf = (o) => "obj|" + o.code;

  /* ===== выгрузка (строки двух листов Excel: «Деньги» и «Сроки» с пометкой «Правка») ===== */
  function exportTables(codes) {
    refreshDerived();
    const sel = new Set(codes);
    const money = raw.money.filter((m) => sel.has(m.c));
    const schedule = [];
    for (const s of raw.schedule) {
      if (!sel.has(s.c)) continue;
      let sv = s.s;
      let ev = s.e;
      let mark = "";
      const rec = wByKey.get(workKey(s));
      if (rec) {
        const w = rec.w;
        if (w.children.length) {
          const d = effDates(w);
          sv = daysToSerial(d.s);
          ev = daysToSerial(d.e);
          mark = "по нижним работам";
        } else if (edits.has(w.key)) {
          const d = effDates(w);
          sv = daysToSerial(d.s);
          ev = daysToSerial(d.e);
          mark = "изменено";
        }
      }
      schedule.push({ ...s, s: sv, e: ev, mark });
    }
    return { money, schedule };
  }

  return {
    startDay: T0,
    load,
    get raw() { return raw; },
    get objects() { return objects; },
    get wByKey() { return wByKey; },
    get noDates() { return noDates; },
    get noDateRows() { return noDateRows; },
    get edits() { return edits; },
    ownMoney, rowTotal, effTotal, objTotal, computeAlloc,
    clampDates, baseDates, effDates, dateSource, objDates, isDescendantOf,
    applyEdit, setLeafEdit, setPreview, setEdits, clearEdits, refreshDerived,
    buildSegments, footSums, addLeafDistribution, maxEnd,
    selectObjects, computeView, objKeyOf, exportTables,
  };
}
