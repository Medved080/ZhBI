"""Обучение эталонов букв шрифта КЖИ по словарю известных строк (самообучение): строка листа принимается, если число ячеек равно числу
символов известной строки и текущее распознавание достаточно на неё похоже; принятые экземпляры пополняют эталоны. Данные заказчика в git
не попадают: в репозитории только растры символов (font_protos.json), без чертежей и текстов листов."""
import sys, os, json, difflib, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import glyphs, textcells as tc

D = '/Users/max/zhbi-tool/data/calc/assets/sources/'
SHEETS = [(14, 5), (1, 270), (4, 100)]
KNOWN = """Технические требования к изготовлению|сборных железобетонных колонн|сборных железобетонных балок|Документация|Сборочные единицы|Материалы
Каркас пространственный|Труба 68х1 ГОСТ 32678-2014 L=600|Труба 50х5 ГОСТ 32678-2014 L=900|Труба 50х5 ГОСТ 32678-2014 L=600
Закладная деталь|Закладная деталь ЗД17|Закладная деталь ЗД37|Закладная деталь ЗД20|Закладная деталь ЗД38|Закладная деталь ЗД31|Закладная деталь ЗД32|Закладная деталь ЗД1
Закладная деталь ЗД5|Закладная деталь ЗД8|Закладная деталь ЗД9|ГОСТ 26633-2015|Бетон кл. В50|Бетон кл. В40|Масса|Ведомость расхода стали на элемент, кг
Изделия арматурные|Изделия закладные|Арматура класса|Прокат марки|Марка|элемента|Всего|Общий расход|Итого|ГОСТ 34028-2016|ГОСТ 82-70|ГОСТ 6727-80|ГОСТ 32678-2014
Поз.|Обозначение|Наименование|Кол.|ед., кг.|Приме-|чание|Вид А|Колонна|Стадия|Масштаб|Лист|Листов|Разраб.|Рук. групп.|Нач. отд.|Н. контр.|Изм.|Кол.уч.|№ док.|Подп.|Дата
Содержание выпуска|Балка лестничная БЛ1|Балка лестничная БЛ2|Балка лестничная БЛ3|Каркас арматурный КР1, каркасы гнутые Кг1, Кг2|Каркас арматурный КР2, каркас гнутый Кг3
Петля строповочная СП1|Ведомость рабочих чертежей основного комплекта|Армирование консолей|(показано условно)|Примечания|ГИП|Формат А3
Сетки и каркасы в местах установки закладных деталей обрезать по месту.|Подпись и дата|Взам. инв. N|Инв. N подл.""".replace('\n', '|').split('|')

def expand(t):
    """Строка → последовательность меток ячеек: 'ы' в шрифте состоит из двух ячеек («ь» и «|»), пробелы не считаются."""
    return list(t.replace(' ', '').replace('ы', 'ь|'))

def harvest(gl, lines, font, minsim=0.6):
    """Принятые выравнивания: [(ячейка, метка)]. Для строки берётся известная строка с лучшим сходством при равенстве числа ячеек."""
    items = []; acc = []
    for L in lines:
        r = tc.decode_line(gl, L, font)
        if r['n'] < 3: continue
        got = r['text'].replace(' ', '').replace('·', '')
        best = None
        for t in KNOWN:
            e = expand(t)
            if len(e) != r['n']: continue
            sim = difflib.SequenceMatcher(None, got, t.replace(' ', '').replace('ы', 'ь|')).ratio()
            if sim >= minsim and (best is None or sim > best[0]): best = (sim, t, e)
        if best:
            for c, ch in zip(r['cells'], best[2]): items.append({'ch': ch, 'raster': c['raster'], 'wrel': c['wrel'], 'toprel': c['toprel'], 'botrel': c['botrel']})
            acc.append((best[1], tc.postprocess(r['text']), 1.0 if tc.postprocess(r['text']) == best[1] else round(best[0], 2)))
    return items, acc

def load_sheet(n, p, minlen=2):
    segs, gl = glyphs.collect(D + 'doc%02d.pdf' % n, p); gl = [g for g in gl if len(g['lines']) <= 40]
    return gl, tc.sheet_lines(gl, minlen=minlen)

def train(seed_path, out_path, sheets=SHEETS, rounds=3):
    data = [load_sheet(n, p) for n, p in sheets]; font = tc.Font(seed_path); seed = json.load(open(seed_path))
    items = [{'ch': p['ch'], 'raster': tc.unpack(p['r']), 'wrel': p['wrel'], 'toprel': p['toprel'], 'botrel': p['botrel']} for p in seed]
    for rd in range(rounds):
        new = []; naccepted = 0; acc_all = []
        for gl, lines in data:
            it, acc = harvest(gl, lines, font); new += it; naccepted += len(acc); acc_all += acc
        kept = tc.thin(new + items); tc.save_font(kept, out_path); font = tc.Font(out_path)
        ok = sum(1 for _, got, sim in acc_all if sim == 1.0)
        print('раунд %d: принято строк %d (из них дословно %d), экземпляров %d → после прореживания %d, меток %d' % (rd, naccepted, ok, len(new), len(kept), len({k['ch'] for k in kept})))
    return font

if __name__ == '__main__':
    train(sys.argv[1], sys.argv[2])
