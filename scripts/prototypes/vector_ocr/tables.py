"""Таблицы листа по линиям рамки: каждый символ текста относится к охватывающей его рамке (ближайшие линии слева/справа/сверху/снизу,
перекрывающие его центр), из символов рамки собирается текст; затем спецификация разбирается по заголовкам столбцов."""
import os, sys, collections, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import vector_ocr as vo, textcells as tc, lexicon as lx

def frame_lines(segs, minlen=12):
    """Горизонтали [(x0,x1,y)] и вертикали [(y0,y1,x)] листа, слитые по совпадению координат."""
    H = []; V = []
    for x0, y0, x1, y1, pi in segs:
        L = math.hypot(x1 - x0, y1 - y0)
        if L < minlen: continue
        if abs(y1 - y0) < 0.05: H.append((min(x0, x1), max(x0, x1), y0))
        elif abs(x1 - x0) < 0.05: V.append((min(y0, y1), max(y0, y1), x0))
    def merge(items):
        items.sort(key=lambda t: (round(t[2], 1), t[0])); out = []
        for a in items:
            if out and abs(out[-1][2] - a[2]) < 0.35 and a[0] <= out[-1][1] + 0.5: out[-1] = (out[-1][0], max(out[-1][1], a[1]), out[-1][2])
            else: out.append(a)
        return out
    return merge(H), merge(V)

def enclosing_box(H, V, cx, cy, tol=0.6):
    """Рамка вокруг точки: ближайшие линии слева/справа (вертикали, накрывающие cy) и снизу/сверху (горизонтали, накрывающие cx)."""
    xs = [x for a, b, x in V if a - tol <= cy <= b + tol]; ys = [y for a, b, y in H if a - tol <= cx <= b + tol]
    l = max([x for x in xs if x <= cx], default=None); r = min([x for x in xs if x >= cx], default=None)
    lo = max([y for y in ys if y <= cy], default=None); hi = min([y for y in ys if y >= cy], default=None)
    return l, r, lo, hi

def char_pos(gl, c):
    """Исходные (не расшатанные) координаты символа: рамка по компонентам."""
    bbs = [gl[i]['bb'] for i in c['ids']]
    return min(b[0] for b in bbs), min(b[1] for b in bbs), max(b[2] for b in bbs), max(b[3] for b in bbs)

DIGLIKE = set('0123456789оОвбзЗчЧØ|·')   # символы, за которыми может скрываться цифра
DIGIT_THR = 17.0

def cell_digit(gl, c, thr=None):
    """Цифра по эталонам цифр vector_ocr (поворот 0): (цифра, расстояние) или None, если не похоже ни на одну (порог thr, по умолчанию DIGIT_THR)."""
    lines = [tuple(l) for i in c['ids'] for l in gl[i]['lines']]
    d, ch = vo.classify_all(lines)[0]
    return (ch, d) if ch is not None and d < (thr or DIGIT_THR) else None

def resolve(tok):
    """tok: [(символ текстового классификатора, цифра-кандидат или None)] одного слова. Цифры берутся из классификатора цифр; двусмысленные
    символы (в/6, о/0, З/3) разрешаются по соседям: рядом цифры → цифра; рядом буквы → буква."""
    n = len(tok); kind = []
    tok = [(x[0], x[1]) for x in tok]
    for ch, dg in tok:
        if dg is not None and (ch.isdigit() or ch in tc.DIG_OF or ch in ('|', '·')): kind.append('a' if (ch in tc.DIG_OF or ch in ('|', '·')) else 'd')
        elif ch.isdigit(): kind.append('d')
        elif ch in tc.LETTERS: kind.append('l')
        else: kind.append('p')
    out = []
    for i, (ch, dg) in enumerate(tok):
        k = kind[i]
        if k == 'd': out.append(dg[0] if dg is not None else ch); continue
        if k == 'a':
            nb = [kind[j] for j in (i - 1, i + 1) if 0 <= j < n and kind[j] in 'dl']
            ds, ls = nb.count('d'), nb.count('l')
            right_d = i + 1 < n and kind[i + 1] == 'd'
            digit = ds > ls or (ds == ls and (kind.count('d') > kind.count('l') or (right_d and kind[-1] == 'd')))
            out.append(dg[0] if digit else ch); continue
        out.append(ch)
    return ''.join(out)

def numeric_fix(gl, tok, force=False):
    """Числовой токен (в основном цифры, запятая, точка — масса, количество, ведомость стали): символы, не распознанные как цифры буквенным
    классификатором («1й5,·6» вместо «105,36»), перечитываются классификатором цифр; если он тоже не узнал символ — остаётся как есть."""
    if len(tok) > 3 and tok[0][0] == 'л' and tok[1][0] == '.':      # ссылка на лист «л.206»: цифры после «л.» читаются как число
        return tok[:2] + numeric_fix(gl, [x for x in tok[2:]], force=True)
    digits = sum(1 for x in tok if x[0].isdigit()); other = [x for x in tok if not x[0].isdigit() and x[0] not in ',.-']
    if len(tok) < 3 or digits < max(2, 0.4 * len(tok)) or not other or not (force or (tok[0][0].isdigit() and tok[-1][0].isdigit())): return tok   # «А500С», «8КП84» — не числа
    out = []
    for ch, dg, c in tok:
        if not ch.isdigit() and ch not in ',.-' and (dg is None or force): dg = cell_digit(gl, c, 45 if force else None) or dg   # в ссылке на лист («л.108») возможны только цифры: порог мягче
        out.append((dg[0] if (dg is not None and not ch.isdigit() and ch not in ',.-') else ch, dg, c))
    return out


def text_in_boxes(gl, lines, font, H, V):
    """Распознаёт строки и раскладывает символы по рамкам. → {рамка: [строки текста сверху вниз]}; символы вне рамки (подписи на чертеже) пропускаются."""
    groups = collections.defaultdict(lambda: collections.defaultdict(list))
    for li, L in enumerate(lines):
        r = tc.decode_line(gl, L, font)
        for ch, d, c in r['chars']:
            x0, y0, x1, y1 = char_pos(gl, c); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            l, rr, lo, hi = enclosing_box(H, V, cx, cy)
            if None in (l, rr, lo, hi): continue
            if ch == '·' and c['botrel'] < -0.12: ch = '/'      # слэш (шифр «77/113/114»): уходит под базовую линию, цифра — нет
            dg = cell_digit(gl, c) if ch in DIGLIKE else None
            groups[(round(l, 1), round(rr, 1), round(lo, 1), round(hi, 1))][(li, round(L['base']))].append((ch, c, r['cap'], dg))
    out = {}
    for box, byline in groups.items():
        rows = []
        # символы одной ячейки на близких базовых линиях («Ø» выступает над строкой цифр) — одна строка текста
        merged = []
        for (li, base), items in sorted(byline.items(), key=lambda kv: -kv[0][1]):
            if merged and abs(merged[-1][0] - base) < 0.55 * items[0][2]: merged[-1][1].extend(items)
            else: merged.append([base, list(items)])
        for base, items in merged:
            items.sort(key=lambda t: t[1]['x0']); gaps = sorted(b[1]['x0'] - a[1]['x1'] for a, b in zip(items, items[1:])); med = gaps[len(gaps) // 2] if gaps else 0
            cap = items[0][2]; spc = max(0.33 * cap, 2.2 * med); toks = [[]]; prev = None
            for ch, c, _, dg in items:
                if prev is not None and c['x0'] - prev['x1'] > spc: toks.append([])
                toks[-1].append((ch, dg, c)); prev = c
            txt = ' '.join(resolve(numeric_fix(gl, t)) for t in toks)
            rows.append((base, lx.fix_code(lx.snap_text(txt.replace('ь|', 'ы')))))
        rows.sort(key=lambda t: -t[0]); out[box] = [t for _, t in rows]
    return out

ROLES = [('mark', 'Марка'), ('pos', 'Поз'), ('oboz', 'Обозн'), ('name', 'Наимен'), ('qty', 'Кол'), ('mass', 'Масса ед'), ('mass', 'Масса 1 дет'), ('mass_item', 'Масса изд'), ('note', 'Прим')]

def role_of(text):
    t = ' '.join(text) if isinstance(text, list) else text
    for role, key in ROLES:
        if t.lower().startswith(key.lower()): return role
    return None

def parse_spec(boxes):
    """Спецификация: столбцы — по рамкам в строке шапки с «Поз.» (одиночная спецификация) или «Марка, поз.» (спецификация серии изделий: столбец марки
    и «Масса изделия» объединены на несколько строк). Роль столбца — по тексту шапки, лишние столбцы пропускаются; строки — рамки столбца «Наименование»,
    значения объединённых ячеек (марка, масса изделия) присваиваются каждой строке, которую они накрывают.
    → {'columns': [роли], 'rows': [{роль: текст}]}; пустые строки отбрасываются."""
    # шапка — короткая подпись (до 10 символов «Поз…», до 14 «Марка…»): подпись детали вроде «Поз.1, Поз.2» над эскизом шапкой не считается;
    # из кандидатов берётся тот, в чьей строке есть столбец «Наименование»
    def short(t):
        text = ' '.join(t)
        return 0 < len(text) <= 14 and (text.startswith('Поз') and len(text) <= 10 or text.startswith('Марка'))
    hdr = [(b, t) for b, t in boxes.items() if short(t)]
    # в таблицах серий сеток и каркасов («Марка изделия | Поз. дет. | Обозначение | Кол. | Масса 1 дет. | Масса изделия») столбца «Наименование» нет:
    # описание стержня («ø 12 А500С ГОСТ …, L=2130») стоит в «Обозначении» — для шапки с «Марка» достаточно столбца «Обозначение»
    def has_name(b, t):
        roles = {role_of(t2) for b2, t2 in boxes.items() if abs(b2[2] - b[2]) < 1 and abs(b2[3] - b[3]) < 1}
        return 'name' in roles or ('oboz' in roles and ' '.join(t).startswith('Марка'))
    hdr = [(b, t) for b, t in hdr if has_name(b, t)]
    if not hdr: return None
    hb = max(hdr, key=lambda bt: bt[0][3])[0]
    ylo, top = hb[2], hb[3]
    cols = {}
    for b, t in boxes.items():
        if abs(b[2] - ylo) < 1 and abs(b[3] - top) < 1:
            r = role_of(t)
            if r and r not in cols.values(): cols[(b[0], b[1])] = r
    if 'name' not in cols.values():
        oboz = [k for k, r in cols.items() if r == 'oboz']
        if not oboz: return None
        cols[oboz[0]] = 'name'
    body = [(b, t, cols[(b[0], b[1])]) for b, t in boxes.items() if b[3] <= ylo + 0.5 and (b[0], b[1]) in cols]
    lines = sorted({(round(b[2], 1), round(b[3], 1)) for b, t, r in body if r == 'name'}, key=lambda k: -k[1])
    rows = collections.defaultdict(dict)
    for b, t, r in body:
        covered = [k for k in lines if b[2] - 0.5 <= (k[0] + k[1]) / 2 <= b[3] + 0.5]    # строки, которые накрывает рамка (объединённая ячейка — несколько)
        for k in (covered or [(round(b[2], 1), round(b[3], 1))]):
            rows[k][r] = ' '.join(t)
    table = [rows[k] for k in sorted(rows, key=lambda k: -k[1]) if any(v.strip() for v in rows[k].values())]
    return {'columns': [cols[k] for k in sorted(cols)], 'rows': table}
