"""Арматура изделия по листу: разбор «Ведомости расхода стали на элемент» и сборка по каркасам (рекурсивно по листам-составляющим).

Результат — масса арматуры по классу и диаметру в кг: {(класс, диаметр): кг}; код ресурса каталога — resource_id(). Самопроверки: сумма
по диаметрам класса равна «Итого» класса, сумма классов — «Всего» арматурных изделий; у каркаса сумма «кол. × масса ед.» равна итогу «Масса, кг»."""
import re, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

_LAT = str.maketrans('ABCEHKMOPTXYabcehkmoptxy', 'АВСЕНКМОРТХУАВСЕНКМОРТХУ')
DIAM_RE = re.compile(r'^[ØøОо]\s*(\d[\dОо]*)$')           # в цифрах диаметра буква «О» — неразличимый с нулём знак шрифта («Ø2О» = Ø20)


def num(s):
    s = re.sub(r'\s', '', s or '').replace(',', '.')
    try: return float(s)
    except ValueError: return None


def class_of(text):
    """Класс стали из заголовка столбца: «А500с», «A500C» → «А500С»; «А-I (А240)» → «А240»; «Вр-I», «Вр-|» → «ВрI». Не класс — None."""
    t = text.translate(_LAT).upper().replace(' ', '').replace('|', 'I')
    t = re.sub(r'(?<=А)([\dО]{3})', lambda x: x.group(1).replace('О', '0'), t)       # «А30О» = А300: буква «О» вместо нуля
    m = re.search(r'А(\d{3})([А-ЯA-Z]?)', t)
    if m and len(t) <= 14: return 'А' + m.group(1) + m.group(2)
    if re.match(r'^ВР-?[I1]?$', t): return 'ВрI'
    return None


def resource_id(cls, diameter):
    """Код ресурса каталога: steel16A500C, steel3Vr1 (латиница, как в каталоге моделей)."""
    c = cls.translate(str.maketrans('АС', 'AC'))
    if cls.upper().startswith('ВР'): c = 'Vr1'
    return 'steel%d%s' % (diameter, c)


def resource_name(cls, diameter):
    return ('Проволока Ø%d Вр1' % diameter) if cls.upper().startswith('ВР') else 'Арматура Ø%d %s' % (diameter, cls)


def parse_steel(boxes):
    """«Ведомость расхода стали на элемент» из рамок текста листа (tables.text_in_boxes). Возвращает
    {'rods': {(класс, диаметр): кг}, 'class_totals': {класс: кг}, 'rebar_total': кг, 'embedded_total': кг, 'checks': {...}} или None."""
    marks = [(b, t) for b, t in boxes.items() if any('Марка' in x for x in t) and any('элемент' in x.lower() for x in t)]
    if not marks: return None
    mb = max(marks, key=lambda bt: bt[0][3])[0]          # самая нижняя «Марка элемента» (ведомость стоит под чертежом)
    row = [(bb, t) for bb, t in boxes.items() if abs(bb[3] - mb[2]) < 1.5 and bb[0] >= mb[1] - 1 and num(' '.join(t)) is not None]
    if not row: return None
    rods = collections.Counter(); class_totals = {}; rebar_total = embedded_total = None; grand = None; ok = False
    for bb, t in row:
        value = num(' '.join(t)); cx = (bb[0] + bb[1]) / 2
        path = [' '.join(t2) for b2, t2 in sorted(((b2, t2) for b2, t2 in boxes.items() if b2[0] <= cx <= b2[1] and b2[2] >= bb[3] - 0.5 and b2 != bb), key=lambda x: x[0][2])
                if len(' '.join(t2)) < 40][:6]
        text = ' '.join(path)
        section = 'rebar' if 'арматурные' in text.lower() else 'embedded' if 'закладные' in text.lower() else None
        head = path[0] if path else ''
        cls = next((class_of(x) for x in path if class_of(x)), None)
        if head.startswith('Всего'):
            if section == 'rebar': rebar_total = value
            elif section == 'embedded': embedded_total = value
        elif head.startswith('Общий'): grand = value
        elif section == 'rebar' and cls:
            m = DIAM_RE.match(head.strip())
            if m: rods[(cls, int(m.group(1).replace('О', '0').replace('о', '0')))] += value; ok = True
            elif head.startswith('Итого'): class_totals[cls] = value
    if not ok: return None
    checks = {}
    for cls, total in class_totals.items():
        s = sum(v for (c, d), v in rods.items() if c == cls); checks[cls] = abs(s - total) <= max(0.02, 0.005 * total)
    if rebar_total is not None:
        s = sum(rods.values()); checks['total'] = abs(s - rebar_total) <= max(0.05, 0.005 * rebar_total)
    return {'rods': dict(rods), 'class_totals': class_totals, 'rebar_total': rebar_total, 'embedded_total': embedded_total, 'grand_total': grand, 'checks': checks}


# ------------------------------------------------------------------ сборка по спецификациям (рекурсивно по листам-составляющим)
ROD_RE = re.compile(r'(?:^|[ØøОо\s])(\d(?:\s?\d)?)\s*([АA]\s?\d{3}\s?[СC]?|Вр\S*)', re.I)   # «Ø» из ячейки может не прочитаться — берём «диаметр класс»
SKIP_RE = re.compile(r'^(Закладн|Труба|Петл|Бетон|Масса|Документация|Сборочные|Материалы|Технические)', re.I)
REF_RE = re.compile(r'л\.\s*(\d+)')
EMB_RE = re.compile(r'^(Закладн|Труба|Петл)', re.I)   # закладные детали, трубы, петли и петлевые выпуски: считаются отдельно от арматуры
PIPE_RE = re.compile(r'Труба\s*(\d+)\s*[хx×]\s*(\d+(?:[.,]\d+)?)', re.I)
LEN_RE = re.compile(r'L\s*=\s*(\d+)')


def emb_kind(name):
    """Вид позиции: 'embedded' (закладная деталь), 'pipe' (труба), 'loop' (петля, петлевой выпуск) или None."""
    m = EMB_RE.match(name or '')
    if not m: return None
    return {'закладн': 'embedded', 'труба': 'pipe', 'петл': 'loop'}[m.group(1).lower()]


def emb_name(name):
    """Название позиции без лишних пробелов и хвостовой пунктуации («Труба 50х5 ГОСТ 32678-2014, п.м.,» → «Труба 50х5 ГОСТ 32678-2014, п.м.»)."""
    return re.sub(r'\s+', ' ', (name or '').strip()).rstrip(' ,;')


def pipe_size(name):
    """Типоразмер трубы из названия: «Труба 68х1 …» → '68x1' (латинская x, точка в толщине); не труба — None."""
    m = PIPE_RE.search(name or '')
    return '%sx%s' % (m.group(1), m.group(2).replace(',', '.')) if m else None


def pipe_length_m(name, qty):
    """Длина трубы позиции в метрах: штучная («L=700», qty шт) → qty × L / 1000; «п.м.» → qty; иначе None."""
    m = LEN_RE.search(name or '')
    if m: return qty * int(m.group(1)) / 1000
    return qty if re.search(r'п\.\s?м', name or '') else None


def parse_rod(name):
    """«Ø 32 А500С ГОСТ 34028-2016, L=11375» → ((класс, диаметр)) или None."""
    m = ROD_RE.search(name or '')
    if not m: return None
    cls = class_of(m.group(2).replace(' ', ''))
    return (cls, int(m.group(1).replace(' ', ''))) if cls else None


def sheet_offsets(catalog_docs):
    """Смещение «номер листа в штампе → страница PDF» по альбомам (по парам, которые знает каталог): {docNN: смещение}."""
    votes = collections.defaultdict(collections.Counter)
    for doc in catalog_docs:
        src = int(doc['source']['id'][3:]) if doc.get('source') and doc['source'].get('id') else None
        for c in doc.get('components') or []:
            if src and c.get('sheet') and c.get('pdfPage'): votes[src][c['pdfPage'] - c['sheet']] += 1
    return {a: v.most_common(1)[0][0] for a, v in votes.items()}


def mark_key(text):
    """Марка в единой записи для сопоставления: латиница → кириллица, верхний регистр, без пробелов и точек («к14.» → «К14»)."""
    return re.sub(r'[\s.]', '', (text or '').translate(_LAT).upper())


def node_mark(name):
    """Марка узла из его названия в спецификации: последний токен («Каркас К14» → «К14», «Сетка СВ6.6-1» → «СВ6.6-1»)."""
    tokens = (name or '').split()
    return mark_key(tokens[-1]) if tokens else ''


class RebarAssembler:
    """Арматура изделия по листам: rows(doc, page) → строки спецификации (кэш снаружи), offset(doc) → смещение листов.
    assemble(doc, page, mark, mass) → {'rods': {(класс, диаметр): кг на 1 шт.}, 'unresolved': кг, 'issues': [...]}.
    Лист может быть спецификацией одного узла или серии марок (строки с полем 'mark', итог по марке — в 'note'): тогда берутся строки марки узла,
    а если марка прочитана с ошибкой — марка, чья масса изделия равна массе узла."""
    def __init__(self, rows, offset, window=12):
        self.rows, self.offset, self.cache, self.window = rows, offset, {}, window
        self.problems = set()      # (альбом, страница) вокруг которых не удалось найти лист узла: сборщик слоя дочитывает окно и повторяет

    @staticmethod
    def node_mass(sub):
        """Масса узла по его листу. Лист узла может включать петли и закладные в итог «Масса», а может не включать — подходит любая из двух сумм
        (арматура; арматура + позиции закладных/петель), берётся ближе к итогу листа."""
        if not sub: return 0
        rods = sum(sub['rods'].values()) + sub['unresolved']
        withemb = rods + sum(k[2] * v for k, v in sub['emb'].items())
        total = sub.get('sheet_total')
        if total and withemb and abs(withemb / total - 1) < abs(rods / total - 1 if rods else 9): return withemb
        return rods

    def sheet_masses(self, doc, page):
        """Массы, которыми лист может быть узлом: итог «Масса, кг» листа или массы изделий серии (колонка «Примечание» строк с маркой)."""
        rows = self.rows(doc, page) or []
        out = {num(r.get('qty')) or num(r.get('mass')) for r in rows if re.match(r'^Масса', r.get('name', '') or '')}
        out |= {num(r.get('note')) for r in rows if r.get('mark') and num(r.get('note'))}
        return {m for m in out if m}

    def find_by_mass(self, doc, center, mass):
        """Лист узла по массе в окне вокруг ожидаемой страницы (когда ссылка «л.NNN» прочитана с ошибкой): ровно один подходящий лист или None."""
        hits = [p for p in range(max(1, center - self.window), center + self.window + 1)
                if self.rows(doc, p) is not None and any(abs(m / mass - 1) <= 0.005 for m in self.sheet_masses(doc, p))]
        return hits[0] if len(hits) == 1 else None

    def pick_rows(self, rows, mark, mass):
        marks = {mark_key(r.get('mark')) for r in rows if r.get('mark')}
        if not marks: return rows, None
        chosen = mark if mark in marks else None
        if chosen is None and mass:
            hits = {mark_key(r['mark']) for r in rows if r.get('mark') and num(r.get('note')) and abs(num(r['note']) / mass - 1) <= 0.005}
            if len(hits) == 1: chosen = next(iter(hits))
        if chosen is None: return [], None
        picked = [r for r in rows if mark_key(r.get('mark')) == chosen]
        total = next((num(r['note']) for r in picked if num(r.get('note'))), None)
        return picked, total

    def assemble(self, doc, page, mark=None, mass=None, depth=0, stack=()):
        key = (doc, page, mark if mass is None else (mark, round(mass, 2)))
        if key in self.cache: return self.cache[key]
        out = {'rods': collections.Counter(), 'unresolved': 0.0, 'sheet_total': None, 'issues': [], 'sum': 0.0, 'emb': collections.Counter()}
        rows = self.rows(doc, page)
        if not rows or depth > 5 or key in stack:
            if rows is None: out['issues'].append('лист %d не разобран' % page)
            self.cache[key] = out; return out
        rows, out['sheet_total'] = self.pick_rows(rows, mark, mass)
        for r in rows:
            name = r.get('name', '') or ''; qty = num(r.get('qty')); mass_e = num(r.get('mass'))
            if re.match(r'^Масса', name) and mass_e: out['sheet_total'] = mass_e; continue
            kind = emb_kind(name)
            if kind:                                                  # закладная, труба, петля: количество и масса единицы с листа, без рекурсии
                if qty and mass_e: out['emb'][(kind, emb_name(name), mass_e)] += qty
                else: out['issues'].append('«%s»: нет количества или массы' % emb_name(name)[:40])
                continue
            if not name or SKIP_RE.match(name) or not qty or not mass_e: continue
            kg = qty * mass_e; out['sum'] += kg
            rod = parse_rod(name)
            if rod: out['rods'][rod] += kg; continue
            refs = REF_RE.findall(r.get('oboz', '') or '')
            center = (int(refs[-1]) + self.offset.get(doc, 0)) if refs else page          # ожидаемая страница узла; без ссылки — окрестность листа-родителя
            sub = self.assemble(doc, center, node_mark(name), mass_e, depth + 1, stack + (key,)) if refs else None
            got = self.node_mass(sub)
            if not got or abs(got / mass_e - 1) > 0.03:                  # ссылки нет или масса узла по его листу не сходится — ищем лист по массе
                found = self.find_by_mass(doc, center, mass_e)
                if found and found != page:
                    sub = self.assemble(doc, found, node_mark(name), mass_e, depth + 1, stack + (key,))
                    got = self.node_mass(sub)
                else:
                    self.problems.add((doc, center))
            if not got or abs(got / mass_e - 1) > 0.03:
                out['issues'].append('узел «%s»%s: по листу %.2f кг, в спецификации %.2f кг' % (name[:30], (' л.' + refs[-1]) if refs else ' без листа', got, mass_e))
                out['unresolved'] += kg; continue
            out['issues'] += sub['issues']
            for k, v in sub['rods'].items(): out['rods'][k] += v * qty
            for k, v in sub['emb'].items(): out['emb'][k] += v * qty
            out['unresolved'] += sub['unresolved'] * qty
        self.cache[key] = out
        return out
