"""Арматура изделия по листу: разбор «Ведомости расхода стали на элемент» и сборка по каркасам (рекурсивно по листам-составляющим).

Результат — масса арматуры по классу и диаметру в кг: {(класс, диаметр): кг}; код ресурса каталога — resource_id(). Самопроверки: сумма
по диаметрам класса равна «Итого» класса, сумма классов — «Всего» арматурных изделий; у каркаса сумма «кол. × масса ед.» равна итогу «Масса, кг»."""
import re, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

_LAT = str.maketrans('ABCEHKMOPTXYabcehkmoptxy', 'АВСЕНКМОРТХУАВСЕНКМОРТХУ')
DIAM_RE = re.compile(r'^[ØøОо]\s*(\d[\dОо]*)$')           # в цифрах диаметра буква «О» — неразличимый с нулём знак шрифта («Ø2О» = Ø20)


_DIGITS = str.maketrans('ОоЗзйбг', '0033062')      # знаки шрифта, неотличимые от цифр: О, о — нуль, З, з — тройка, й — нуль, б — шестёрка, г — двойка («5,1З» = 5,13, «г8,9О» = 28,90)


def num(s):
    s = re.sub(r'\s', '', s or '').replace(',', '.')
    try: return float(s)
    except ValueError: pass
    try: return float(s.translate(_DIGITS))          # только если иначе число не читается: подмена касается лишь прежде нечитаемых значений
    except ValueError: return None


def class_of(text):
    """Класс стали из заголовка столбца: «А500с», «A500C» → «А500С»; «А-I (А240)» → «А240»; «Вр-I», «Вр-|» → «ВрI». Не класс — None."""
    t = text.translate(_LAT).upper().replace(' ', '').replace('|', 'I')
    t = re.sub(r'(?<=А)([\dО]{3})', lambda x: x.group(1).replace('О', '0'), t)       # «А30О» = А300: буква «О» вместо нуля
    m = re.search(r'А(\d{3})([А-ЯA-Z]?)', t)
    if m and len(t) <= 14: return 'А' + m.group(1) + m.group(2)
    if re.match(r'^ВР-?[I1]?$', t): return 'ВрI'
    if re.match(r'^К-?7$', t): return 'К7'                      # напрягаемая арматура: канат К7 (ГОСТ Р 53772)
    return None


def resource_id(cls, diameter):
    """Код ресурса каталога: steel16A500C, steel3Vr1, steel12K7 (латиница, как в каталоге моделей)."""
    c = cls.translate(str.maketrans('АСК', 'ACK'))
    if cls.upper().startswith('ВР'): c = 'Vr1'
    return 'steel%d%s' % (diameter, c)


def resource_name(cls, diameter):
    if cls.upper().startswith('ВР'): return 'Проволока Ø%d Вр1' % diameter
    if cls == 'К7': return 'Канат К7 Ø%d' % diameter
    return 'Арматура Ø%d %s' % (diameter, cls)


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
        path = [' '.join(t2) for b2, t2 in sorted(((b2, t2) for b2, t2 in boxes.items()
                if b2[0] <= cx <= b2[1] and b2[0] >= mb[1] - 1 and b2[2] >= bb[3] - 0.5
                and b2[3] <= mb[3] + 1 and b2 != bb), key=lambda x: x[0][2])
                if len(' '.join(t2)) < 40][:6]
        text = ' '.join(path)
        section = 'rebar' if ('арматурные' in text.lower() or 'напрягаемая' in text.lower()) else 'embedded' if 'закладные' in text.lower() else None
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
    # Ведомость только арматуры может завершаться «Общий расход» без «Всего».
    # У таблицы с закладными этот общий итог использовать для арматуры нельзя.
    if rebar_total is None and grand is not None and embedded_total is None and not any('закладные' in ' '.join(t).lower() for b, t in boxes.items()
            if b[0] >= mb[1] - 1 and b[3] <= mb[3] + 1 and b[2] >= mb[2]):
        rebar_total = grand
    element_mark = next((' '.join(t) for b, t in boxes.items() if abs(b[0] - mb[0]) < 1
                         and abs(b[3] - mb[2]) < 1.5), None)
    return {'rods': dict(rods), 'class_totals': class_totals, 'rebar_total': rebar_total, 'embedded_total': embedded_total, 'grand_total': grand,
            'element_mark': element_mark,
            'checks': compute_checks(rods, class_totals, rebar_total)}


def compute_checks(rods, class_totals, rebar_total):
    """Самопроверки ведомости: сумма по диаметрам класса равна «Итого» класса, сумма классов равна «Всего»."""
    checks = {}
    for cls, total in class_totals.items():
        s = sum(v for (c, d), v in rods.items() if c == cls); checks[cls] = abs(s - total) <= max(0.02, 0.005 * total)
    if rebar_total is not None:
        s = sum(rods.values()); checks['total'] = abs(s - rebar_total) <= max(0.05, 0.005 * rebar_total)
    return checks


def fill_strand(sheet, rows):
    """Масса каната К7 по «Итого» класса есть, а по диаметру не прочиталась: диаметр берётся из строки каната в спецификации того же листа
    (только если он там один — Ø12 и Ø15 в альбомах встречаются оба), самопроверки пересчитываются."""
    total = (sheet.get('class_totals') or {}).get('К7')
    if not total: return sheet
    rods = sheet['rods']; have = sum(v for (c, d), v in rods.items() if c == 'К7'); missing = total - have
    diameters = {x[1] for x in (parse_rod(r.get('name')) for r in rows or []) if x and x[0] == 'К7'}
    if missing > 0.02 and len(diameters) == 1:
        rods[('К7', next(iter(diameters)))] = rods.get(('К7', next(iter(diameters))), 0) + missing
        sheet['checks'] = compute_checks(rods, sheet['class_totals'], sheet.get('rebar_total'))
    return sheet


# ------------------------------------------------------------------ сборка по спецификациям (рекурсивно по листам-составляющим)
ROD_RE = re.compile(r'(?:^|[ØøОо\s])(\d(?:\s?\d)?)\s*([АA]\s?\d{3}\s?[СC]?|Вр\S*)', re.I)   # «Ø» из ячейки может не прочитаться — берём «диаметр класс»
SKIP_RE = re.compile(r'^(Закладн|Труба|Петл|Бетон|Масса|Документация|Сборочные|Материалы|Технические)', re.I)
REF_RE = re.compile(r'л\.\s*([\dйОо]+)')           # в номере листа OCR путает нуль с «й» и «О» («л.8й» = л.80)


def ref_numbers(text):
    """Номера листов из ссылок «л.NNN» в графе «Обозначение» (нуль, прочитанный как «й» или «О», исправляется)."""
    return [int(x.translate(str.maketrans('йОо', '000'))) for x in REF_RE.findall(text or '')]
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


STRAND_RE = re.compile(r'^\s*К\s?-?\s?7\s?-\s?(\d+(?:[.,]\d+)?)\s?-')
STANDARD_DIAMETERS = (6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40)
INFER_RE = re.compile(r'([АA]\s?\d{3}\s?[СC]?|Вр\S*)\s*ГОСТ[^L]*L\s*=\s*(\d[\d\s]*\d|\d)')      # цифры диаметра не прочитаны


def infer_diameter(mass_kg, length_mm, diameters=STANDARD_DIAMETERS):
    """Диаметр стержня по массе единицы и длине: масса погонного метра = 0,00617 · d² (d, мм). Ближайший стандартный диаметр, если сходится в пределах 3%; иначе None."""
    if not mass_kg or not length_mm or length_mm < 100: return None
    d = (mass_kg / (length_mm / 1000.0) / 0.00617) ** 0.5
    nearest = min(diameters, key=lambda s: abs(s - d))
    return nearest if abs(d / nearest - 1) <= 0.03 else None


def parse_rod(name, mass=None):
    """«Ø 32 А500С ГОСТ 34028-2016, L=11375» → ((класс, диаметр)) или None. Цифры диаметра не прочитаны («Ø ·· А600С … L= 10030») — диаметр выводится по массе единицы
    (mass, кг) и длине из названия."""
    strand = STRAND_RE.match(name or '')
    if strand: return ('К7', int(float(strand.group(1).replace(',', '.'))))      # «К7-12,5-1770 ГОСТ Р 53772-2010 L=5950» → канат К7 Ø12
    m = ROD_RE.search(name or '')
    if m:
        cls = class_of(m.group(2).replace(' ', ''))
        if cls: return (cls, int(m.group(1).replace(' ', '')))
    m = INFER_RE.search(name or '')
    if m and mass:
        cls = class_of(m.group(1).replace(' ', ''))
        d = infer_diameter(mass, int(re.sub(r'\s', '', m.group(2))), (3, 4, 5) if cls == 'ВрI' else STANDARD_DIAMETERS)
        if cls and d: return (cls, d)
    return None


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


_FUZZY = str.maketrans('СО', '00')      # «с» и «О» в марке серии читаются как нуль и обратно («4с1» ↔ «401», «4сР8» ↔ «40Р8»)


def fuzzy_key(text):
    """Марка для сопоставления с учётом путаницы «с/О/нуль» шрифта: mark_key, у которого «С» и «О» заменены нулём."""
    return mark_key(text).translate(_FUZZY)


QTY_TAIL_RE = re.compile(r'L\s*[=·]\s*\S+\s+(\d{1,3})$')      # «Ø10 А500С ГОСТ 34028-2016, L=2810 2»: количество склеилось с длиной
LENGTH_RE = re.compile(r'L\s*[=·]\s*(\d[\d\s]*\d|\d)')


_LETTER_DIGITS = str.maketrans('АУ', '56')      # знаки шрифта в числах таблиц серий: «А» — пятёрка, «У» — шестёрка («L=1А40» = 1540, «Ø 2А» = Ø25; проверено суммой по массе марки)
DIAM_LETTER_RE = re.compile(r'(?<=[ØИ])(\s*)(\d[АУ]|[АУ]\d)(?!\d)')
LENGTH_LETTER_RE = re.compile(r'(L\s*[=·]\s*)([\dАУ\s]*\d[\dАУ\s]*)')


def fix_digits(name):
    """Название стержня с исправленными буквами-цифрами в диаметре и длине (только внутри «Ø…» и «L=…», класс «А500С» не трогается)."""
    name = DIAM_LETTER_RE.sub(lambda m: m.group(1) + m.group(2).translate(_LETTER_DIGITS), name or '')
    return LENGTH_LETTER_RE.sub(lambda m: m.group(1) + m.group(2).translate(_LETTER_DIGITS), name)


def rod_mass_by_geometry(name):
    """Масса одного стержня по названию «Ø d класс … L=мм», кг: 0,00617 · d² · L; нет диаметра или длина не прочитана — None."""
    m = ROD_RE.search(name or '')
    length = LENGTH_RE.search(name or '')
    if not m or not length: return None
    mm = int(re.sub(r'\s', '', length.group(1)))
    d = int(m.group(1).replace(' ', ''))
    return 0.00617 * d * d * mm / 1000.0 if mm >= 100 else None


def row_qty_mass(row):
    """(количество, масса единицы) строки спецификации с поправками чтения: количество, склеенное с длиной в ячейке наименования, и масса стержня строки серии без
    столбца массы единицы (считается по диаметру и длине)."""
    name = fix_digits(row.get('name', '') or '')
    qty, mass = num(row.get('qty')), num(row.get('mass'))
    if not qty:
        m = QTY_TAIL_RE.search(name)
        if m: qty = float(m.group(1))
    if not mass and row.get('mark'): mass = rod_mass_by_geometry(name)
    return qty, mass


def node_mark(name):
    """Марка узла из его названия в спецификации: последний токен («Каркас К14» → «К14», «Сетка СВ6.6-1» → «СВ6.6-1»)."""
    tokens = (name or '').split()
    mark = mark_key(tokens[-1]) if tokens else ''
    if re.match(r'^консол', name or '', re.I) and re.match(r'^\d', mark): mark = 'К' + mark
    return mark


def sheet_node_marks(boxes):
    """Марки одиночных узлов из названия в нижнем штампе, отдельно от ссылок спецификации."""
    top = max((b[3] for b in boxes), default=0)
    return sorted({node_mark(' '.join(text)) for box, text in boxes.items()
                   if box[3] <= 0.2 * top and re.match(r'^(консол|Каркас|Сетка|Арматурный блок)', ' '.join(text), re.I)})


def row_total(row):
    """Итог спецификации: «Масса» или последняя строка с одной числовой ячейкой массы."""
    if re.match(r'^Масса', row.get('name', '') or ''): return num(row.get('qty')) or num(row.get('mass'))
    if set(row) == {'mass'}: return num(row['mass'])
    return None


def number_rounding(text):
    """Полшага округления явно записанной дробной массы (0,08 → 0,005 кг)."""
    m = re.fullmatch(r'\d+[.,](\d+)', re.sub(r'\s', '', text or ''))
    return 0.5 * 10 ** -len(m.group(1)) if m else 0.0


class RebarAssembler:
    """Арматура изделия по листам: rows(doc, page) → строки спецификации (кэш снаружи), offset(doc) → смещение листов.
    assemble(doc, page, mark, mass) → {'rods': {(класс, диаметр): кг на 1 шт.}, 'unresolved': кг, 'issues': [...]}.
    Лист может быть спецификацией одного узла или серии марок (строки с полем 'mark', итог по марке — в 'note'): тогда берутся строки марки узла,
    а если марка прочитана с ошибкой — марка, чья масса изделия равна массе узла."""
    def __init__(self, rows, offset, window=12, pages=None, marks=None):
        self.rows, self.offset, self.cache, self.window = rows, offset, {}, window
        self.pages = pages      # pages(doc) → номера уже прочитанных листов альбома (для поиска листа узла по марке и массе, когда ссылка «л.NNN» прочитана неверно)
        self.marks = marks      # marks(doc, page) → марки одиночных узлов из штампа
        self.problems = set()      # (альбом, страница) вокруг которых не удалось найти лист узла: сборщик слоя дочитывает окно и повторяет

    @staticmethod
    def node_mass(sub, expected=None):
        """Масса узла по его листу. В итог узла могут входить петли, закладные и трубы, а могут не входить: из двух сумм (арматура; арматура + позиции закладных,
        петель, труб) берётся ближайшая к массе, которую заявляет спецификация родителя (expected), а без неё — к итогу «Масса» листа узла."""
        if not sub: return 0
        rods = sum(sub['rods'].values()) + sub['unresolved']
        withemb = rods + sum(k[2] * v for k, v in sub['emb'].items())
        target = expected or sub.get('sheet_total')
        # 0,077 кг детали = 0,08 кг изделия при округлении до сотых.
        # Проверяется прочитанный итог той же марки; массу стержней не округляем.
        total = sub.get('sheet_total')
        if not sub['unresolved'] and not sub['emb'] and total and target == total and abs(rods - total) <= sub.get('sheet_rounding', 0) + 1e-9:
            return total
        if target and withemb and abs(withemb / target - 1) < abs(rods / target - 1 if rods else 9): return withemb
        return rods

    def sheet_masses(self, doc, page):
        """Массы, которыми лист может быть узлом: итог «Масса, кг» листа или массы изделий серии (колонка «Примечание» строк с маркой)."""
        rows = self.rows(doc, page) or []
        out = {row_total(r) for r in rows}
        out |= {num(r.get('mass_item') or r.get('note')) for r in rows if r.get('mark') and num(r.get('mass_item') or r.get('note'))}
        return {m for m in out if m}

    def find_by_mass(self, doc, center, mass):
        """Лист узла по массе в окне вокруг ожидаемой страницы (когда ссылка «л.NNN» прочитана с ошибкой): ровно один подходящий лист или None."""
        hits = [p for p in range(max(1, center - self.window), center + self.window + 1)
                if self.rows(doc, p) is not None and any(abs(m / mass - 1) <= 0.005 for m in self.sheet_masses(doc, p))]
        return hits[0] if len(hits) == 1 else None

    def find_by_mark(self, doc, mark, mass):
        """Лист узла среди ВСЕХ прочитанных листов альбома: на листе есть строки марки узла с массой изделия, равной массе узла (±0,5%). Ровно один лист или None."""
        if not self.pages or not mark: return None
        hits = []
        for q in self.pages(doc):
            rows = self.rows(doc, q) or []
            title_match = self.marks and any(fuzzy_key(m) == fuzzy_key(mark) for m in self.marks(doc, q) or []) and any(abs(m / mass - 1) <= 0.005 for m in self.sheet_masses(doc, q))
            if title_match or any(r.get('mark') and fuzzy_key(r['mark']) == fuzzy_key(mark) and num(r.get('mass_item') or r.get('note')) and abs(num(r.get('mass_item') or r['note']) / mass - 1) <= 0.005 for r in rows):
                hits.append(q)
        return hits[0] if len(hits) == 1 else None

    def pick_rows(self, rows, mark, mass):
        marks = {fuzzy_key(r.get('mark')) for r in rows if r.get('mark')}
        if not marks: return rows, None
        mark = fuzzy_key(mark)
        chosen = mark if mark in marks else None
        if chosen is None and mass:
            hits = {fuzzy_key(r['mark']) for r in rows if r.get('mark') and num(r.get('mass_item') or r.get('note')) and abs(num(r.get('mass_item') or r['note']) / mass - 1) <= 0.005}
            if len(hits) == 1: chosen = next(iter(hits))
        if chosen is None: return [], None
        picked = [r for r in rows if fuzzy_key(r.get('mark')) == chosen]
        total = next((num(r.get('mass_item') or r['note']) for r in picked if num(r.get('mass_item') or r.get('note'))), None)
        return picked, total

    def assemble(self, doc, page, mark=None, mass=None, depth=0, stack=()):
        key = (doc, page, mark if mass is None else (mark, round(mass, 2)))
        if key in self.cache: return self.cache[key]
        out = {'rods': collections.Counter(), 'loop_rods': collections.Counter(), 'unresolved': 0.0, 'sheet_total': None, 'sheet_rounding': 0.0, 'issues': [], 'sum': 0.0, 'emb': collections.Counter()}
        rows = self.rows(doc, page)
        # Лист бетонного изделия не может быть листом его арматурного узла.
        # Иначе трубы этого изделия попадут в сборку повторно (ошибка ссылки на предыдущую страницу).
        if depth and any(re.match(r'^[БВ]етон', r.get('name', '') or '') for r in rows or []): rows = []
        if not rows or depth > 5 or key in stack:
            if rows is None: out['issues'].append('лист %d не разобран' % page)
            self.cache[key] = out; return out
        rows, out['sheet_total'] = self.pick_rows(rows, mark, mass)
        if out['sheet_total']:
            out['sheet_rounding'] = next((number_rounding(r.get('mass_item') or r.get('note')) for r in rows
                                           if num(r.get('mass_item') or r.get('note')) == out['sheet_total']), 0.0)
        parsed = [row_qty_mass(r) for r in rows]
        # строка серии, у которой масса единицы не считается (длина стержня не прочитана): остаток итога марки за вычетом остальных строк
        lacking = [i for i, r in enumerate(rows) if r.get('mark') and parsed[i][0] and not parsed[i][1] and parse_rod(fix_digits(r.get('name')), None)]
        if len(lacking) == 1 and out['sheet_total']:
            rest = out['sheet_total'] - sum(q * m for (q, m) in parsed if q and m)
            if rest > 0: parsed[lacking[0]] = (parsed[lacking[0]][0], rest / parsed[lacking[0]][0])
        for r, (qty, mass_e) in zip(rows, parsed):
            name = fix_digits(r.get('name', '') or '') if r.get('mark') else (r.get('name', '') or '')      # буквы-цифры правятся только в таблицах серий (там проверка суммой по массе марки)
            total = row_total(r)
            if total:
                out['sheet_total'] = total
                out['sheet_rounding'] = number_rounding(r.get('qty') if num(r.get('qty')) else r.get('mass'))
                continue
            kind = emb_kind(name)
            if kind:                                                  # прочие материалы — отдельно; состав петли читается только для её классификации
                if qty and mass_e:
                    out['emb'][(kind, emb_name(name), mass_e)] += qty
                    # Состав петли нужен отдельно, если при сохранении прежнего
                    # раздела закладных она войдёт в новую арматуру.
                    refs = ref_numbers(r.get('oboz', '') or '') if kind == 'loop' else []
                    if refs:
                        sub = self.assemble(doc, refs[-1] + self.offset.get(doc, 0), node_mark(name), mass_e, depth + 1, stack + (key,))
                        got = sum(sub['rods'].values())
                        if not sub['unresolved'] and got and abs(got / mass_e - 1) <= 0.03:
                            for k, v in sub['rods'].items(): out['loop_rods'][k] += v * qty
                else: out['issues'].append('«%s»: нет количества или массы' % emb_name(name)[:40])
                continue
            if not name or SKIP_RE.match(name) or not qty or not mass_e: continue
            kg = qty * mass_e; out['sum'] += kg
            rod = parse_rod(name, mass_e)
            if rod: out['rods'][rod] += kg; continue
            refs = ref_numbers(r.get('oboz', '') or '')
            center = (refs[-1] + self.offset.get(doc, 0)) if refs else page          # ожидаемая страница узла; без ссылки — окрестность листа-родителя
            sub = self.assemble(doc, center, node_mark(name), mass_e, depth + 1, stack + (key,)) if refs else None
            got = self.node_mass(sub, mass_e)
            if not got or abs(got / mass_e - 1) > 0.03:                  # ссылки нет или масса узла по его листу не сходится — ищем лист по массе
                found = self.find_by_mass(doc, center, mass_e) or self.find_by_mark(doc, node_mark(name), mass_e)
                if found and found != page:
                    sub = self.assemble(doc, found, node_mark(name), mass_e, depth + 1, stack + (key,))
                    got = self.node_mass(sub, mass_e)
                else:
                    self.problems.add((doc, center))
            if not got or abs(got / mass_e - 1) > 0.03:
                out['issues'].append('узел «%s»%s: по листу %.2f кг, в спецификации %.2f кг' % (name[:30], (' л.%d' % refs[-1]) if refs else ' без листа', got, mass_e))
                out['unresolved'] += kg; continue
            out['issues'] += sub['issues']
            for k, v in sub['rods'].items(): out['rods'][k] += v * qty
            for k, v in sub['emb'].items(): out['emb'][k] += v * qty
            for k, v in sub['loop_rods'].items(): out['loop_rods'][k] += v * qty
            out['unresolved'] += sub['unresolved'] * qty
        self.cache[key] = out
        return out
